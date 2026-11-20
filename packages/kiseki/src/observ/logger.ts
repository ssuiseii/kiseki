/**
 * JSON logger (design.md §18.2).
 *
 * One JSON object per line on stdout, so `journalctl -o cat | jq` works. The
 * contract has three hard rules and this file enforces all three:
 *
 *  1. **Never a secret.** Callers pass `label`, never a token (§18.2). On top of
 *     that discipline there is a mechanical net: every string value is scrubbed
 *     of any registered secret before it is serialised, so a future caller that
 *     interpolates a token into a message is defused rather than leaked.
 *  2. **Never request params.** Nothing here serialises a request body; params
 *     are only ever reachable through `KISEKI_DEBUG_BODIES=1`, which is an
 *     explicit, documented opt-in (§18.2) and still passes through the scrubber.
 *  3. **Cheap when off.** `debug` is dropped unless the level allows it, so the
 *     hot path pays one comparison.
 *
 * `Logger` is the interface the rest of the codebase depends on
 * (`upstream-core/types/logger.ts`), so the server can be tested with a fake sink
 * and the real one only appears at the process edge.
 */

import type { LogFields, Logger } from "upstream-core"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/** Fields whose value is a known secret placeholder from config. */
const REDACTED = "[redacted]"

export type JsonLoggerOptions = {
  /** Minimum level to emit. Default `info`. */
  level?: LogLevel
  /** Sink; defaults to stdout. Injected by tests. */
  write?(line: string): void
  /**
   * Secret values to scrub from every string in every field. The composition root
   * registers client tokens and upstream apikey tokens here, which makes the
   * "never log a token" rule structural instead of a code-review promise.
   */
  secrets?: readonly string[]
  /** Clock, injected for deterministic tests. */
  now?(): number
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Deep-scrub a value. Strings are replaced when they *contain* a secret (not only
 * when they equal one) because the realistic leak is a token embedded in a URL or
 * a message, not a bare field.
 */
const scrub = (value: unknown, secrets: readonly string[], depth = 0): unknown => {
  if (typeof value === "string") {
    let out = value
    for (const secret of secrets) {
      if (secret !== "" && out.includes(secret)) out = out.replaceAll(secret, REDACTED)
    }
    return out
  }
  if (depth >= 6) return value
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, secrets, depth + 1))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = scrub(entry, secrets, depth + 1)
    }
    return out
  }
  return value
}

export const createJsonLogger = (options: JsonLoggerOptions = {}): Logger => {
  const level = options.level ?? "info"
  const minimum = LEVEL_ORDER[level]
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const secrets = options.secrets ?? []
  const now = options.now ?? (() => Date.now())

  const emit = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[entryLevel] < minimum) return
    const record: Record<string, unknown> = {
      ts: new Date(now()).toISOString(),
      level: entryLevel,
      // The message is caller-written, so it gets the same scrub as a field: a
      // caller that interpolates a token into the message must not leak it.
      msg: scrub(message, secrets),
    }
    if (fields !== undefined) {
      for (const [key, value] of Object.entries(fields)) {
        // `msg` and the reserved keys win over caller fields: a field named `ts`
        // must not be able to forge a timestamp.
        if (key === "ts" || key === "level" || key === "msg") continue
        record[key] = scrub(value, secrets)
      }
    }
    write(JSON.stringify(record))
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  }
}

/** `KISEKI_DEBUG_BODIES=1` opts into full-body debug logging (§18.2). */
export const debugBodiesEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.KISEKI_DEBUG_BODIES === "1"

/**
 * Every secret a process knows about: client keys (§16.2) and upstream apikey
 * tokens (§5.2). Used to build the logger's scrubber, so the list is derived from
 * config rather than maintained by hand.
 */
export const collectSecrets = (config: {
  server: { auth: { keys: { token: string }[] } }
  chains: Record<string, { upstreams: { apikeys: { token: string }[] }[] }>
}): string[] => {
  const secrets = new Set<string>()
  for (const key of config.server.auth.keys) {
    if (key.token !== "") secrets.add(key.token)
  }
  for (const chain of Object.values(config.chains)) {
    for (const upstream of chain.upstreams) {
      for (const key of upstream.apikeys) {
        if (key.token !== "") secrets.add(key.token)
      }
    }
  }
  return [...secrets]
}

/**
 * `kiseki` entry point (design.md §21, implementation.md §7).
 *
 * Responsibilities, in order:
 *
 *   1. read `--config` / `KISEKI_CONFIG` (default `./kiseki.yaml`)
 *   2. load + validate the config (fail fast, all problems at once)
 *   3. build the runtime through the composition root (#37)
 *   4. build the logger (secrets registered for scrubbing) and metrics
 *   5. serve, and on SIGHUP reload config behind the same listener (§19)
 *
 * The process boundary is the ONLY place that reads `process.env`, owns a signal
 * handler, or writes to stdout — everything below takes its inputs injected
 * (implementation.md §1), which is what makes the rest testable without a process.
 */

import { resolve } from "node:path"
import { ConfigError, loadConfigFile, formatSharedIdentity } from "./config/index"
import { createJsonLogger, collectSecrets, type JsonLoggerOptions } from "./observ/logger"
import { createMetrics, metricKeyId, type Metrics } from "./observ/metrics"
import { buildRegistry } from "./registry"
import { reloadRuntime } from "./reload"
import { createServer, type ServerDeps } from "./server/index"
import { createRuntime, type Runtime } from "./runtime"

export const DEFAULT_CONFIG_PATH = "kiseki.yaml"

export type CliOptions = {
  configPath: string
  /** `--check` validates and exits; useful in CI and before a systemd restart. */
  checkOnly: boolean
  /** `--help`. */
  help: boolean
}

/** Parse `--config <path>` / `KISEKI_CONFIG` / `--check` / `--help`. */
export const parseArgs = (
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CliOptions => {
  let configPath = env.KISEKI_CONFIG ?? DEFAULT_CONFIG_PATH
  let checkOnly = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--config" || arg === "-c") {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith("-")) {
        configPath = next
        index += 1
      }
      continue
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length)
      continue
    }
    if (arg === "--check") {
      checkOnly = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      help = true
    }
  }

  return { configPath, checkOnly, help }
}

export const USAGE = `kiseki — blockchain RPC proxy

Usage: kiseki [--config <path>] [--check]

  --config, -c <path>   config file (default: $KISEKI_CONFIG or ./kiseki.yaml)
  --check               validate the config and exit
  --help, -h            show this message

Environment:
  KISEKI_CONFIG          config path, overridden by --config
  KISEKI_LOG_LEVEL       debug | info | warn | error   (default: info)
  KISEKI_DEBUG_BODIES=1  log full request/response bodies (design.md §18.2)
`

const logLevel = (env: Record<string, string | undefined>): JsonLoggerOptions["level"] => {
  const level = env.KISEKI_LOG_LEVEL
  return level === "debug" || level === "info" || level === "warn" || level === "error"
    ? level
    : "info"
}

/**
 * Map `(provider, token)` → apikey label for the credits gauge (§18.1). The bucket
 * registry is keyed by identity and carries no label; this map is how the gauge
 * gets one without widening the frozen bucket contract.
 */
const keyLabelIndex = (config: {
  chains: Record<string, { upstreams: { provider: string; apikeys: { token: string; label: string }[] }[] }>
}): Map<string, string> => {
  const map = new Map<string, string>()
  for (const chain of Object.values(config.chains)) {
    for (const upstream of chain.upstreams) {
      for (const key of upstream.apikeys) {
        map.set(metricKeyId(upstream.provider, key.token), key.label)
      }
    }
  }
  return map
}

export type Started = {
  runtime: Runtime
  metrics: Metrics
  server: ReturnType<typeof createServer>
  /** Reload from disk; swaps the runtime behind the same server. */
  reload(): ReturnType<typeof reloadRuntime>
  stop(): Promise<void>
}

/**
 * Start everything except the process itself: config, runtime, observability,
 * listener. Exported so the e2e test (M5) and this file's own tests can drive a
 * real server without a child process.
 */
export const start = async (options: {
  configPath: string
  env?: Record<string, string | undefined>
  logger?: JsonLoggerOptions
  fetchImpl?: typeof fetch
  random?(): number
  /** Port override for tests (`0` = ephemeral). */
  port?: number
  host?: string
}): Promise<Started> => {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  const registry = buildRegistry()

  // Load once to learn the secrets, then build the real logger and metrics, then
  // build the runtime — the adapters must be created AFTER the pool observer exists
  // (§18.1), and the logger must exist BEFORE any adapter logs.
  let loaded
  try {
    loaded = loadConfigFile(options.configPath, { env, registry })
  } catch (error) {
    if (error instanceof ConfigError) {
      // The message already lists every problem by path and never a value.
      process.stderr.write(`${error.message}\n`)
    }
    throw error
  }

  const logger = createJsonLogger({
    level: logLevel(env),
    secrets: collectSecrets(loaded.config),
    ...(options.logger?.write === undefined ? {} : { write: options.logger.write }),
  })

  // The bucket registry is created by the runtime, while the metrics object must
  // exist first (the runtime needs its observer). A holder breaks the cycle: the
  // gauge collector reads whichever runtime is current, which is also what makes a
  // reload transparent to `/metrics`.
  const current: { runtime?: Runtime } = {}
  const metrics = createMetrics({
    bucketRegistry: () => current.runtime?.bucketRegistry,
    keyLabels: keyLabelIndex(loaded.config),
    now: Date.now,
  })

  const runtime = createRuntime({
    loaded,
    registry,
    logger,
    now: Date.now,
    // BOTH levels: `observer` for level-1 routing events, `poolObserver` for the
    // key-level events inside the pool (§18.1). Missing either leaves half the
    // metric table permanently at zero.
    observer: metrics.observer,
    poolObserver: metrics.observer,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.random === undefined ? {} : { random: options.random }),
  })
  current.runtime = runtime

  for (const warning of runtime.warnings) logger.warn(warning)
  for (const shared of sharedIdentitiesOf(runtime)) logger.info(formatSharedIdentity(shared))

  const serverDeps: ServerDeps = {
    pipelineFor: (chain) => current.runtime?.pipelineFor(chain),
    chains: () => current.runtime?.chains ?? [],
    auth: {
      methods: runtime.config.server.auth.methods,
      keys: runtime.config.server.auth.keys,
    },
    logger,
    metrics,
  }

  const server = createServer(serverDeps)

  const host = options.host ?? runtime.config.server.host
  const port = options.port ?? runtime.config.server.port

  const bunServer = Bun.serve({ hostname: host, port, fetch: server.app.fetch })

  logger.info("kiseki listening", {
    host,
    port: bunServer.port,
    chains: runtime.chains,
    auth_methods: runtime.config.server.auth.methods,
  })

  const reload = () => {
    const result = reloadRuntime({
      configPath: options.configPath,
      env,
      registry,
      logger,
      now: Date.now,
      current: current.runtime!,
      observer: metrics.observer,
      poolObserver: metrics.observer,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.random === undefined ? {} : { random: options.random }),
    })
    if (result.ok) {
      current.runtime = result.runtime
    }
    return result
  }

  return {
    get runtime() {
      return current.runtime!
    },
    metrics,
    server,
    reload,
    stop: async () => {
      await bunServer.stop()
    },
  }
}

/** Shared identities of a built runtime, recomputed from its config (rule 8). */
const sharedIdentitiesOf = (runtime: Runtime) => {
  const seen = new Map<string, { provider: string; label: string; chains: string[] }>()
  for (const [chain, chainConfig] of Object.entries(runtime.config.chains)) {
    for (const upstream of chainConfig.upstreams) {
      for (const key of upstream.apikeys) {
        const id = metricKeyId(upstream.provider, key.token)
        const existing = seen.get(id)
        if (existing === undefined) {
          seen.set(id, { provider: upstream.provider, label: key.label, chains: [chain] })
        } else if (!existing.chains.includes(chain)) {
          existing.chains.push(chain)
        }
      }
    }
  }
  return [...seen.values()].filter((identity) => identity.chains.length > 1)
}

/**
 * `bun run src/index.ts` entry. Kept thin: argument parsing, one `start()`, and
 * the signal handling systemd needs (§21).
 */
export const main = async (
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> => {
  const options = parseArgs(argv, env)

  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const configPath = resolve(options.configPath)

  if (options.checkOnly) {
    try {
      loadConfigFile(configPath, { env, registry: buildRegistry() })
      process.stdout.write(`config ok: ${configPath}\n`)
      return 0
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const started = await start({ configPath, env })

  const onHangup = (): void => {
    started.reload()
  }
  process.on("SIGHUP", onHangup)

  const shutdown = async (signal: string): Promise<void> => {
    process.off("SIGHUP", onHangup)
    await started.stop()
    process.exit(signal === "SIGINT" ? 130 : 0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  // Keep the process alive; the server holds the socket, this is belt-and-braces
  // for the case where a runtime error would otherwise let the event loop drain.
  await new Promise<void>(() => {})
  return 0
}

// Only run when executed directly, never when imported by a test.
if (import.meta.main) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code)
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}


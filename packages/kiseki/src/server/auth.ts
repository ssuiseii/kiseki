/**
 * Authentication (design.md §16, decisions #29–33).
 *
 * The whole surface is two channels that validate against ONE allowlist (#31):
 *
 *   path-key (primary)   POST /{chain}/{key}     — forge/cast/ethers style
 *   Bearer  (fallback)   POST /{chain}  + header — server apps that can set headers
 *
 * Deliberately absent: query parameters (#32). `?apikey=` is refused rather than
 * ignored, because silently ignoring it would leave the client believing it had
 * authenticated when it had not.
 *
 * Two properties this module is responsible for:
 *
 *  1. **Ordering.** Auth is decided BEFORE the chain is resolved, so an unknown
 *     chain with bad credentials answers 401, not 404 (§16.3 step 2). That order
 *     is what stops the proxy from being an oracle for which chains exist.
 *  2. **No secret leaves here.** The result carries the key's *label* only; the
 *     token is compared and dropped (§16.4, §18.2).
 */

import { createHash } from "node:crypto"

export type AuthKeyConfig = { token: string; label: string }

export type AuthConfig = {
  /** Which channels are enabled (`server.auth.methods`). */
  methods: readonly ("path" | "bearer")[]
  keys: readonly AuthKeyConfig[]
}

export type AuthFailureReason = "missing" | "unknown" | "query-param" | "channel-disabled"

export type AuthResult =
  | { ok: true; label: string; channel: "path" | "bearer" }
  | { ok: false; reason: AuthFailureReason }

/**
 * Credentials as extracted from the request, before any validation.
 *
 * `pathKey` is `undefined` when the path had no key segment (or an empty one,
 * §16.3: `/ethereum/` is a request without a path key), which is what makes the
 * Bearer fallback apply.
 */
export type Credentials = {
  pathKey?: string
  bearer?: string
  /** True when the URL carried an `apikey` query parameter (#32: not supported). */
  queryKey?: string
}

/**
 * Hash a token before comparing.
 *
 * Comparing digests rather than raw strings means the comparison cannot leak the
 * secret's length or its matching prefix through timing, and it keeps the
 * comparison O(1) in the number of configured keys. SHA-256 here is a
 * constant-time-comparison enabler, not a password hash: the tokens are long
 * random secrets, and they are never stored hashed anywhere else.
 */
const digest = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex")

/** A lookup table built once per config, mapping digest → label. */
export type KeyIndex = ReadonlyMap<string, string>

export const buildKeyIndex = (keys: readonly AuthKeyConfig[]): KeyIndex => {
  const index = new Map<string, string>()
  for (const key of keys) {
    if (key.token === "") continue
    // Duplicate tokens are a config error caught by validation (§15.1 rule 9);
    // if one slips through, first-wins keeps the label stable.
    if (!index.has(digest(key.token))) index.set(digest(key.token), key.label)
  }
  return index
}

/** Extract credentials from a request path + headers, without validating them. */
export const extractCredentials = (options: {
  /** Path segments after the chain: `[]`, `[key]`, … (already URL-decoded). */
  keySegments: readonly string[]
  authorization: string | null
  /** Raw query string, for the `?apikey=` refusal (#32). */
  query?: URLSearchParams
}): Credentials => {
  const credentials: Credentials = {}

  // §16.3: a trailing slash is ignored and an empty key segment means "no key".
  const pathKey = options.keySegments.find((segment) => segment !== "")
  if (pathKey !== undefined) credentials.pathKey = pathKey

  const header = options.authorization?.trim()
  if (header !== undefined && header !== "") {
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match !== null) credentials.bearer = match[1]!.trim()
  }

  const queryKey = options.query?.get("apikey")
  if (queryKey !== undefined && queryKey !== null) credentials.queryKey = queryKey

  return credentials
}

/**
 * Validate credentials against the allowlist.
 *
 * Precedence and tolerance, straight from §16.1:
 *  - a path key and a Bearer header may both be present; either one matching is
 *    enough to pass;
 *  - `server.auth.methods` can disable a channel entirely — a key presented on a
 *    disabled channel is not accepted (it would otherwise be a silent bypass of
 *    the operator's intent);
 *  - a query parameter is refused even when another channel is valid, because the
 *    config says the surface is exactly two channels (#32).
 */
export const authenticate = (
  credentials: Credentials,
  config: AuthConfig,
  index: KeyIndex = buildKeyIndex(config.keys),
): AuthResult => {
  if (credentials.queryKey !== undefined) return { ok: false, reason: "query-param" }

  const pathEnabled = config.methods.includes("path")
  const bearerEnabled = config.methods.includes("bearer")

  const pathLabel =
    pathEnabled && credentials.pathKey !== undefined
      ? index.get(digest(credentials.pathKey))
      : undefined
  if (pathLabel !== undefined) return { ok: true, label: pathLabel, channel: "path" }

  const bearerLabel =
    bearerEnabled && credentials.bearer !== undefined
      ? index.get(digest(credentials.bearer))
      : undefined
  if (bearerLabel !== undefined) return { ok: true, label: bearerLabel, channel: "bearer" }

  // Distinguish "presented something, on a channel that is off" from "presented
  // nothing": the first is a configuration mismatch worth naming in the log.
  const presented = credentials.pathKey !== undefined || credentials.bearer !== undefined
  const anyChannelEnabled = pathEnabled || bearerEnabled
  if (presented && (!pathEnabled && !bearerEnabled)) {
    return { ok: false, reason: "channel-disabled" }
  }
  if (presented && anyChannelEnabled) return { ok: false, reason: "unknown" }
  return { ok: false, reason: "missing" }
}

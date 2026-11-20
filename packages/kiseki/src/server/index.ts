/**
 * HTTP surface (design.md §16–17, implementation.md §7).
 *
 * The route table is small on purpose, and its ORDER is part of the contract:
 *
 *   GET  /healthz   → 200, no auth   (§16.3 step 1)
 *   GET  /metrics   → Prometheus, no auth, protected by the bind (#33)
 *   POST /*         → auth → chain → JSON-RPC (§16.3 step 2)
 *
 * Auth before chain resolution is deliberate: an unknown chain with bad
 * credentials answers 401, not 404, so the proxy never confirms which chains
 * exist to an unauthenticated caller.
 *
 * The JSON-RPC path is a wildcard route rather than two parameterised routes
 * because §16.3 requires tolerance the router's own matcher does not offer:
 * `/ethereum/KEY/` must equal `/ethereum/KEY`, and `/ethereum/` must mean "no
 * path key". Splitting the path by hand is three lines and makes every one of
 * those cases explicit and testable.
 *
 * This module owns HTTP only. Parsing, classification, routing and shaping live
 * in `pipeline/`; the server's job is to turn a `Request` into a `handle()` call
 * and its result back into a `Response`.
 */

import { Hono } from "hono"
import type { Logger } from "upstream-core"
import { parseRequest } from "../batch"
import { unknownChain } from "../errors"
import { handle, type PipelineDeps } from "../pipeline"
import type { Metrics } from "../observ/metrics"
import {
  authenticate,
  buildKeyIndex,
  extractCredentials,
  type AuthConfig,
  type KeyIndex,
} from "./auth"

/** §17.1: unauthorized, and the proxy's general error code. */
const ERROR_UNAUTHORIZED = -32000
/** §17.1: body is not a valid JSON-RPC request; also used for an unroutable path. */
const ERROR_INVALID_REQUEST = -32600

export type ServerDeps = {
  /**
   * Resolve a chain to its pipeline. Returning `undefined` means the chain is not
   * configured (§16.3 step 3). A function rather than a map so a reload can swap
   * the whole runtime behind the server without rebuilding it.
   */
  pipelineFor(chain: string): PipelineDeps | undefined
  /** Chains that exist, for diagnostics only — never used to answer a request. */
  chains(): readonly string[]
  auth: AuthConfig
  logger: Logger
  metrics?: Metrics
  /** Injected for tests; defaults to `performance.now`-based `Date.now`. */
  now?(): number
}

export type ServerHandle = {
  app: Hono
  /** The auth index, exposed so a reload can verify it rebuilt. */
  keyIndex: KeyIndex
}

const jsonRpcError = (error: { code: number; message: string; data?: unknown }): unknown => ({
  jsonrpc: "2.0",
  id: null,
  error,
})

const unauthorized = (reason: string): unknown =>
  jsonRpcError({
    code: ERROR_UNAUTHORIZED,
    message: "unauthorized",
    // The reason names the *channel*, never the credential (§16.4).
    data: { reason },
  })

/**
 * Split a request path into (chain, key segments), tolerating the shapes §16.3
 * lists: trailing slashes, an empty key segment, and extra segments after the key
 * (which are ignored, not treated as a different route).
 */
export const splitPath = (path: string): { chain: string; keySegments: string[] } => {
  const segments = path.split("/").filter((segment) => segment !== "")
  const chain = segments[0] ?? ""
  const rest = segments.slice(1)
  let decoded: string[]
  try {
    decoded = rest.map((segment) => decodeURIComponent(segment))
  } catch {
    // A malformed escape is not a credential; keep the raw text so it fails auth
    // rather than crashing the request.
    decoded = rest
  }
  return { chain: decodeChain(chain), keySegments: decoded }
}

const decodeChain = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** §12.2: `Retry-After` is in whole seconds, rounded up, floor 1. */
const retryAfterHeader = (retryAfterMs: number): string =>
  String(Math.max(1, Math.ceil(retryAfterMs / 1000)))

/**
 * Read the body as JSON. A body that is not JSON is NOT a transport failure: it
 * becomes a `-32600` through `parseRequest`, which is where §10.3 puts that rule.
 */
const readJson = async (request: Request): Promise<unknown> => {
  const text = await request.text()
  if (text.trim() === "") return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const createServer = (deps: ServerDeps): ServerHandle => {
  const { logger } = deps
  const app = new Hono()
  const keyIndex = buildKeyIndex(deps.auth.keys)

  // §16.3 step 1 — fixed routes first, no auth. A liveness probe must never fail
  // because of a credentials problem.
  app.get("/healthz", (context) => context.text("ok"))

  app.get("/metrics", async (context) => {
    if (deps.metrics === undefined) {
      // Metrics are disabled in config (`metrics.enabled: false`): say so plainly
      // instead of serving an empty document that looks like a scrape of zeroes.
      return context.text("metrics disabled\n", 404)
    }
    const body = await deps.metrics.render()
    return context.body(body, 200, { "content-type": deps.metrics.contentType })
  })

  app.post("/*", async (context) => {
    const url = new URL(context.req.url)
    const { chain, keySegments } = splitPath(url.pathname)

    // §16.3 step 2 — auth BEFORE chain, so 401 wins over 404.
    const credentials = extractCredentials({
      keySegments,
      authorization: context.req.header("authorization") ?? null,
      query: url.searchParams,
    })
    const auth = authenticate(credentials, deps.auth, keyIndex)
    if (!auth.ok) {
      logger.warn("unauthorized request", {
        // Path only, and never the key segment: the chain is enough to debug.
        chain,
        reason: auth.reason,
        // Distinguish "no credentials" from "wrong credentials" without logging
        // either of them.
        presented: credentials.pathKey !== undefined || credentials.bearer !== undefined,
      })
      return context.json(unauthorized(auth.reason), 401)
    }

    const clientLabel = auth.label
    const pipeline = deps.pipelineFor(chain)
    if (pipeline === undefined) {
      logger.warn("unknown chain", { chain, client_label: clientLabel })
      return context.json(jsonRpcError(unknownChain(chain)), 404)
    }

    const parsed = parseRequest(await readJson(context.req.raw))

    // §18.1 row 1: one count per (chain, method class, client label). A batch that
    // mixes classes counts once per class it contained — see PipelineResult.classes.
    const result = await handle(pipeline, parsed)
    if (deps.metrics !== undefined) {
      for (const methodClass of result.classes) {
        deps.metrics.countRequest(chain, methodClass, clientLabel)
      }
      if (parsed.shape === "array") {
        deps.metrics.countBatchItems(chain, clientLabel, parsed.items.length + parsed.rejected.length)
      }
    }

    // One line per request, at debug. It carries the *label* (never the token) and
    // no params (§18.2); `method_class` is enough to attribute traffic in a log
    // search, and the per-item detail is already in the router's own logs.
    logger.debug("request handled", {
      chain,
      client_label: clientLabel,
      auth: auth.channel,
      shape: parsed.shape,
      items: parsed.items.length + parsed.rejected.length,
      classes: result.classes,
      status: result.status,
    })

    if (result.status === 429) {
      // §12.3: fail fast on capacity, with a realistic hint (§12.2).
      const retryAfterMs = result.retryAfterMs ?? 0
      return context.json(result.body as Record<string, unknown>, 429, {
        "retry-after": retryAfterHeader(retryAfterMs),
      })
    }

    return context.json(result.body as Record<string, unknown>, 200)
  })

  // A path that matches no route, or a method that is not POST on the JSON-RPC
  // path. Both are client mistakes; both get a JSON-RPC envelope, because a client
  // parsing `text/plain: 404 Not Found` learns nothing actionable.
  //
  // The path is REDACTED in the body (§16.4: a raw key must never appear in a
  // response). Only the first segment — the chain, which is not a secret — survives.
  app.notFound((context) =>
    context.json(
      jsonRpcError({
        code: ERROR_INVALID_REQUEST,
        message: `no route for ${context.req.method} ${redactPath(context.req.path)}`,
        data: { method: context.req.method, path: redactPath(context.req.path) },
      }),
      404,
    ),
  )

  // Last line of defence. `handle` is total over its inputs, so reaching this means
  // a genuine bug — but a client must never receive a stack trace, and the log must
  // never contain request params (§18.2).
  app.onError((error, context) => {
    logger.error("unhandled error while serving request", {
      path: redactPath(context.req.path),
      method: context.req.method,
      error: error instanceof Error ? error.message : String(error),
    })
    return context.json(
      jsonRpcError({
        code: ERROR_UNAUTHORIZED,
        message: "internal proxy error",
      }),
      500,
    )
  })

  return { app, keyIndex }
}

/**
 * Keep the first path segment (the chain) and mask the rest. A path can carry a
 * client key (§16.1 path-key), and §16.4 forbids echoing one in a response, an
 * error or a log line — so anything after the chain becomes `*`.
 */
export const redactPath = (path: string): string => {
  const segments = path.split("/").filter((segment) => segment !== "")
  if (segments.length <= 1) return path
  return `/${segments[0]}/${segments.slice(1).map(() => "*").join("/")}`
}

/**
 * Error envelopes the proxy authors itself (design.md §17.1).
 *
 * Two rules shape this file:
 *
 *  - **Passthrough beats invention.** A provider error that ended an item is
 *    forwarded verbatim (decision #36); the builders here are only for answers
 *    where the proxy is the author — pre-flight, capacity fail-fast, ambiguous
 *    broadcast, malformed request.
 *  - **Nothing secret ever lands in `message`/`data`.** These strings travel to
 *    the client and into logs, so they may name a chain, a method or a label but
 *    never a token (design.md §18.2).
 */

import type { JsonRpcError } from "upstream-core"

/** design.md §17.1 — the proxy's own error code table. */
export const ERROR_UNAUTHORIZED = -32000
export const ERROR_CAPACITY_EXHAUSTED = -32005
export const ERROR_NO_HEALTHY_UPSTREAM = -32006
export const ERROR_BROADCAST_UNKNOWN = -32007
/** The upstream rejected the call as a configuration problem, not capacity. */
export const ERROR_UPSTREAM_MISCONFIGURED = -32008
export const ERROR_METHOD_UNSUPPORTED = -32601
export const ERROR_INVALID_REQUEST = -32600
export const ERROR_UNKNOWN_CHAIN = -32602

/**
 * Body is not a JSON-RPC 2.0 request (design.md §10.3: one item, one error).
 *
 * The detail is appended to the message as well as carried in `data`: a client
 * that only prints `message` should still learn what was wrong with its request,
 * and "Invalid Request" alone would send it looking at the wrong layer.
 */
export const invalidRequest = (detail?: string): JsonRpcError => ({
  code: ERROR_INVALID_REQUEST,
  message: detail === undefined ? "Invalid Request" : `Invalid Request: ${detail}`,
  ...(detail === undefined ? {} : { data: { detail } }),
})

/**
 * Pre-flight miss (design.md §8.2): no upstream in this chain covers the method
 * — wording taken from the design. No quota is charged and no attempt is made.
 */
export const methodUnsupported = (
  chain: string,
  method: string,
  cap: "method" | "archive" = "method",
): JsonRpcError => ({
  code: ERROR_METHOD_UNSUPPORTED,
  message: "method not supported by any configured upstream",
  data: { chain, method, cap },
})

/**
 * `defaults.blocked_methods` (design.md §9.2). Uses `-32601` because the
 * client-visible meaning is the same as a pre-flight miss — "this proxy will not
 * route this method" — and §17.1 defines no dedicated code for policy blocks.
 * The message says *why*, which is the part a human needs.
 */
export const methodBlocked = (method: string): JsonRpcError => ({
  code: ERROR_METHOD_UNSUPPORTED,
  message: `method "${method}" is blocked by proxy policy`,
  data: { method },
})

/** Fail fast on capacity (design.md §12.1–12.3): 429 + Retry-After. */
export const capacityExhausted = (retryAfterMs: number): JsonRpcError => ({
  code: ERROR_CAPACITY_EXHAUSTED,
  message: "all upstreams are rate-limited",
  data: { retryAfterMs },
})

/** Fail fast because every candidate is parked after transport failures (§13). */
export const noHealthyUpstream = (): JsonRpcError => ({
  code: ERROR_NO_HEALTHY_UPSTREAM,
  message: "no healthy upstream available",
})

/**
 * The upstream rejected the call before any node answered it (wrong apikey, wrong
 * `url_template`). This is a configuration problem, not capacity and not health,
 * so it is never answered with `429`: there is no honest `Retry-After` for a
 * config that will not fix itself. `status` is the HTTP status of the rejection,
 * when the provider reported one.
 */
export const upstreamMisconfigured = (status?: number): JsonRpcError => ({
  code: ERROR_UPSTREAM_MISCONFIGURED,
  message: "upstream is misconfigured",
  ...(status === undefined ? {} : { data: { status } }),
})

/** `eth_sendRawTransaction` state unknown (design.md §11.3): never retried. */
export const broadcastUnknown = (): JsonRpcError => ({
  code: ERROR_BROADCAST_UNKNOWN,
  message: "broadcast state unknown",
})

/** Route-level: the chain is not in the config (design.md §16.3 step 3). */
export const unknownChain = (chain: string): JsonRpcError => ({
  code: ERROR_UNKNOWN_CHAIN,
  message: `unknown chain "${chain}"`,
})

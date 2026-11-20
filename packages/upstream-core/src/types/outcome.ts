/**
 * Outcome taxonomy — the ONLY thing the router sees from an upstream package
 * (design.md §7.1, decisions #23/#34–36, implementation.md §2).
 *
 * The router reacts to `kind`, never to raw provider errors.
 */

import type { JsonRpcError } from "./jsonrpc"

export type Entry =
  | { originalIndex: number; ok: true; result: unknown }
  | { originalIndex: number; ok: false; error: JsonRpcError; final: boolean }

/**
 * An item that the upstream turned out not to be able to serve, despite the
 * static capability matrix claiming otherwise (design.md §8.3).
 *
 * `providerError` is the original provider error and becomes the final answer if
 * no further upstream is left to try (decision #36: passthrough).
 */
export type UnsupportedItem = {
  originalIndex: number
  method: string
  cap: "method" | "archive"
  providerError: JsonRpcError
}

export type UpstreamOutcome =
  | { kind: "success"; entries: Entry[]; unsupportedItems?: UnsupportedItem[] }
  /** Every item is a genuine node answer (revert, nonce too low, …). Final. */
  | { kind: "domain_error"; entries: Entry[] }
  /** Every item mismatched this upstream's real capability. Regroup them. */
  | { kind: "unsupported"; items: UnsupportedItem[] }
  | { kind: "rate_limited"; retryAtMs: number }
  | { kind: "sick"; retryAtMs: number }
  /** Broadcast state unknown (sendRaw). Stops BOTH levels (design.md §11.3). */
  | { kind: "ambiguous" }

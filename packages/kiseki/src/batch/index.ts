/**
 * Batch split & merge (design.md §10, implementation.md §4 tahap A/D).
 *
 * This file owns the *shapes*: turning a request body into routable items,
 * rejecting the ones that can never be routed, and putting the answers back in
 * the client's order. The routing itself lives in `../router`.
 *
 * Two invariants from design.md §4.2 are enforced here:
 *
 *   #4 — item order is preserved on the response: every result carries its
 *        `originalIndex` and merging sorts by it.
 *   #5 — a batch may succeed partially: one item's failure never discards
 *        another item's result.
 */

import type { JsonRpcError, JsonRpcId } from "upstream-core"
import { invalidRequest } from "../errors"

/** One routable JSON-RPC item, carrying its position in the client's request. */
export type RequestItem = {
  originalIndex: number
  id: JsonRpcId
  method: string
  /** Positional params (implementation.md §2: `GroupItem.params: unknown[]`). */
  params: unknown[]
}

/** An item rejected before routing (invalid shape, blocked method, …). */
export type RejectedItem = {
  originalIndex: number
  id: JsonRpcId
  error: JsonRpcError
}

export type ParsedRequest = {
  /**
   * `object` → the response is a single envelope; `array` → an array of them.
   * An unparseable body is reported as `object` with id `null`, which is the
   * JSON-RPC answer for a request that could not be understood at all.
   */
  shape: "object" | "array"
  items: RequestItem[]
  rejected: RejectedItem[]
}

export type ItemResult = {
  originalIndex: number
  id: JsonRpcId
  /** `true` → `result` is present; `false` → `error` is. */
  ok: boolean
  result?: unknown
  error?: JsonRpcError
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asId = (value: unknown): JsonRpcId => {
  if (typeof value === "string" || typeof value === "number") return value
  return null
}

/**
 * Validate one JSON-RPC request object.
 *
 * Strict on purpose, and strict in the same direction the frozen contract is
 * strict: `params` must be positional (`unknown[]`). No Ethereum method uses
 * named params, and silently accepting an object would mean the classifier
 * cannot see block arguments at all — a capability miss we would then only
 * discover from the provider.
 */
const parseItem = (
  value: unknown,
  originalIndex: number,
): { ok: true; item: RequestItem } | { ok: false; rejected: RejectedItem } => {
  const reject = (detail: string, id: JsonRpcId = null): { ok: false; rejected: RejectedItem } => ({
    ok: false,
    rejected: { originalIndex, id, error: invalidRequest(detail) },
  })

  if (!isObject(value)) return reject("request must be a JSON object")

  const id = asId(value.id)

  if (value.jsonrpc !== undefined && value.jsonrpc !== "2.0") {
    return reject('"jsonrpc" must be "2.0"', id)
  }
  if (typeof value.method !== "string" || value.method === "") {
    return reject('"method" must be a non-empty string', id)
  }

  let params: unknown[] = []
  if (value.params !== undefined && value.params !== null) {
    if (!Array.isArray(value.params)) {
      return reject('"params" must be an array (named params are not supported)', id)
    }
    params = value.params
  }

  return { ok: true, item: { originalIndex, id, method: value.method, params } }
}

/**
 * Body → routable items.
 *
 * design.md §10.3: an invalid item inside a batch gets `-32600` at its own index
 * and the rest of the batch still runs.
 */
export const parseRequest = (body: unknown): ParsedRequest => {
  if (Array.isArray(body)) {
    // JSON-RPC 2.0: an empty batch is answered with a single error object.
    if (body.length === 0) {
      return {
        shape: "object",
        items: [],
        rejected: [{ originalIndex: 0, id: null, error: invalidRequest("empty batch") }],
      }
    }

    const items: RequestItem[] = []
    const rejected: RejectedItem[] = []
    body.forEach((entry, index) => {
      const parsed = parseItem(entry, index)
      if (parsed.ok) items.push(parsed.item)
      else rejected.push(parsed.rejected)
    })
    return { shape: "array", items, rejected }
  }

  if (!isObject(body)) {
    return {
      shape: "object",
      items: [],
      rejected: [
        {
          originalIndex: 0,
          id: null,
          error: invalidRequest("body must be a JSON-RPC request object or a batch array"),
        },
      ],
    }
  }

  const parsed = parseItem(body, 0)
  return parsed.ok
    ? { shape: "object", items: [parsed.item], rejected: [] }
    : { shape: "object", items: [], rejected: [parsed.rejected] }
}

/** Merge by original index (invariant #4). */
export const mergeResults = (results: readonly ItemResult[]): ItemResult[] =>
  [...results].sort((left, right) => left.originalIndex - right.originalIndex)

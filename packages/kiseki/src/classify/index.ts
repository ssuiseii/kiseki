/**
 * Per-item classification (design.md §9, implementation.md §4 tahap A).
 *
 * Four questions per JSON-RPC item:
 *
 *   1. **method class** — is it a heavy class (`trace_*`, `debug_*`, `replay_*`)
 *      and therefore subject to the heavy timeout (§14)?
 *   2. **needs archive** — does it touch state that only an archive node keeps
 *      (§9.1)? This drives pre-flight and routing.
 *   3. **idempotency** — is it `eth_sendRawTransaction`, the one method whose
 *      failure may not be retried ambiguously (§9.2)?
 *   4. **blocked** — does `defaults.blocked_methods` refuse it outright (§9.2)?
 *
 * Deliberately absent: `cost`. implementation.md §2 is explicit that `GroupItem`
 * carries no cost and that the pool resolves it at key-selection time, because
 * the cost table is layered per provider (§5.3). The classifier only decides
 * routing-relevant facts.
 *
 * No guessing: a method whose block position is unknown is classified as
 * non-archive. A false "archive" would remove every non-archive upstream from a
 * request that never needed one; a false "non-archive" is caught at runtime by
 * the capsig table and corrected by a regroup (#34). The runtime signal is the
 * designed safety net; the classifier must stay deterministic (§8.1).
 */

import { matchesMethodPattern, type JsonRpcError } from "upstream-core"
import { methodBlocked } from "../errors"

export type MethodClass = "default" | "heavy"
export type Idempotency = "READ" | "NON_IDEMPOTENT"

export type Classified = {
  method: string
  methodClass: MethodClass
  /** Requires archive state (design.md §9.1). */
  needsArchive: boolean
  /**
   * The item touches historical state. Carried to the pool via `GroupItem`
   * (implementation.md §5) where it widens the "block not found" signature to a
   * capability mismatch (#35). Same computation as `needsArchive`, kept as a
   * separate field because the contract names it separately.
   */
  historical: boolean
  idempotency: Idempotency
  /** Effective per-attempt timeout (§14). */
  timeoutMs: number
}

export type TimeoutPolicy = {
  defaultMs: number
  heavyMs: number
  heavyMethods: readonly string[]
}

/** `defaults.timeouts` (seconds in YAML) → the millisecond policy the router uses. */
export const buildTimeoutPolicy = (timeouts: {
  default_seconds: number
  heavy_seconds: number
  heavy_methods: string[]
}): TimeoutPolicy => ({
  defaultMs: Math.round(timeouts.default_seconds * 1000),
  heavyMs: Math.round(timeouts.heavy_seconds * 1000),
  heavyMethods: timeouts.heavy_methods,
})

export type ClassifyOptions = {
  timeouts: TimeoutPolicy
  blockedMethods: readonly string[]
  /**
   * Current chain tip, when the caller knows one. With no tip, any explicit
   * block number is treated as historical — the conservative direction (§9.1:
   * over-classifying as archive only narrows candidates, never sends a query to
   * a node that cannot serve it).
   */
  tip?: number
}

/** Blocks older than this (relative to tip) need archive state (§9.1). */
export const ARCHIVE_DEPTH = 128

/** The one non-idempotent method (design.md §9.2). */
export const SEND_RAW_TRANSACTION = "eth_sendRawTransaction"

const LATEST_TAGS = new Set(["latest", "pending", "safe", "finalized"])
const BLOCK_HASH_PATTERN = /^0x[0-9a-f]{64}$/
const QUANTITY_PATTERN = /^0x[0-9a-f]+$/

/**
 * Block references by method and parameter position.
 *
 * Only methods whose block argument is known are listed. Everything else is
 * classified as non-archive and, if it turns out to need historical state, the
 * runtime capsig note corrects it (#34–35).
 */
const BLOCK_POSITIONS: Readonly<Record<string, readonly number[]>> = {
  // [tx|address, block]
  eth_call: [1],
  eth_estimateGas: [1],
  eth_createAccessList: [1],
  eth_getBalance: [1],
  eth_getCode: [1],
  eth_getTransactionCount: [1],
  eth_feeHistory: [1],
  eth_simulateV1: [1],
  debug_traceCall: [1],
  trace_call: [2],
  // [address, slot, block]
  eth_getStorageAt: [2],
  eth_getProof: [2],
  // [block, …]
  eth_getBlockByNumber: [0],
  eth_getBlockTransactionCountByNumber: [0],
  eth_getUncleCountByBlockNumber: [0],
  eth_getUncleByBlockNumberAndIndex: [0],
  eth_getTransactionByBlockNumberAndIndex: [0],
  eth_getBlockReceipts: [0],
  debug_traceBlockByNumber: [0],
  debug_getRawBlock: [0],
  debug_getRawHeader: [0],
  debug_getRawReceipts: [0],
  trace_block: [0],
  trace_replayBlockTransactions: [0],
}

/** Methods whose first argument IS a block hash: archive by assumption (§9.1). */
const BLOCK_HASH_METHODS = new Set([
  "eth_getBlockByHash",
  "eth_getBlockTransactionCountByHash",
  "eth_getUncleCountByBlockHash",
  "eth_getUncleByBlockHashAndIndex",
  "eth_getTransactionByBlockHashAndIndex",
  "debug_traceBlockByHash",
  "debug_storageRangeAt",
])

/** Methods taking a filter object with `fromBlock`/`toBlock`/`blockHash`. */
const LOG_FILTER_METHODS = new Set(["eth_getLogs", "trace_filter"])

type BlockRef =
  | { kind: "latest" }
  | { kind: "earliest" }
  | { kind: "number"; value: number }
  | { kind: "hash" }

const parseQuantity = (text: string): number | undefined => {
  try {
    const value = Number(BigInt(text))
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Interpret one value as a block reference. Returns undefined for anything that
 * is not one, so callers never see a guessed reference.
 */
export const parseBlockRef = (value: unknown): BlockRef | undefined => {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (text === "") return undefined
    if (LATEST_TAGS.has(text)) return { kind: "latest" }
    if (text === "earliest") return { kind: "earliest" }
    if (BLOCK_HASH_PATTERN.test(text)) return { kind: "hash" }
    if (!QUANTITY_PATTERN.test(text)) return undefined
    const number = parseQuantity(text)
    // A 32-byte quantity is far more likely to be a hash we failed to spot.
    return number === undefined ? { kind: "hash" } : { kind: "number", value: number }
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { kind: "number", value }
  }
  if (typeof value === "object" && value !== null) {
    const filter = value as { blockHash?: unknown; blockNumber?: unknown; blockTag?: unknown }
    if (filter.blockHash !== undefined) return { kind: "hash" }
    if (filter.blockNumber !== undefined) return parseBlockRef(filter.blockNumber)
    if (filter.blockTag !== undefined) return parseBlockRef(filter.blockTag)
  }
  return undefined
}

/** The block references a call carries, per the tables above. */
export const blockRefs = (method: string, params: readonly unknown[]): BlockRef[] => {
  const refs: BlockRef[] = []

  if (BLOCK_HASH_METHODS.has(method)) {
    if (params.length > 0) refs.push({ kind: "hash" })
    return refs
  }

  if (LOG_FILTER_METHODS.has(method)) {
    const filter = params[0]
    if (typeof filter !== "object" || filter === null) return refs
    const candidate = filter as { blockHash?: unknown; fromBlock?: unknown; toBlock?: unknown }
    if (candidate.blockHash !== undefined) {
      refs.push({ kind: "hash" })
      return refs
    }
    // `fromBlock` decides archive-ness: an old range starts in pruned state even
    // if `toBlock` is latest.
    const from = parseBlockRef(candidate.fromBlock)
    if (from !== undefined) refs.push(from)
    return refs
  }

  const positions = BLOCK_POSITIONS[method]
  if (positions === undefined) return refs
  for (const position of positions) {
    const ref = parseBlockRef(params[position])
    if (ref !== undefined) refs.push(ref)
  }
  return refs
}

/** Is this reference only answerable by an archive node? (§9.1) */
export const isHistoricalRef = (ref: BlockRef, tip?: number): boolean => {
  switch (ref.kind) {
    case "latest":
      return false
    case "earliest":
    case "hash":
      return true
    case "number":
      // Unknown tip: treat an explicit height as historical (conservative).
      return tip === undefined ? true : ref.value < tip - ARCHIVE_DEPTH
  }
}

export type ClassifyResult =
  | { ok: true; classified: Classified }
  | { ok: false; error: JsonRpcError }

/**
 * Classify one item. A blocked method is a rejection, not a classification: it
 * must never reach an upstream (§9.2).
 */
export const classify = (
  method: string,
  params: readonly unknown[],
  options: ClassifyOptions,
): ClassifyResult => {
  for (const blocked of options.blockedMethods) {
    if (matchesMethodPattern(blocked, method)) {
      return { ok: false, error: methodBlocked(method) }
    }
  }

  const heavy = options.timeouts.heavyMethods.some((pattern) =>
    matchesMethodPattern(pattern, method),
  )
  const historical = blockRefs(method, params).some((ref) =>
    isHistoricalRef(ref, options.tip),
  )

  return {
    ok: true,
    classified: {
      method,
      methodClass: heavy ? "heavy" : "default",
      needsArchive: historical,
      historical,
      idempotency: method === SEND_RAW_TRANSACTION ? "NON_IDEMPOTENT" : "READ",
      timeoutMs: heavy ? options.timeouts.heavyMs : options.timeouts.defaultMs,
    },
  }
}

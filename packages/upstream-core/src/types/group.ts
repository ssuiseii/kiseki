/**
 * Group shapes handed from the router (level 1) to an upstream adapter
 * (level 2). See design.md §7.1 and implementation.md §2.
 */

import type { JsonRpcId } from "./jsonrpc"
import type { Logger } from "./logger"

export type GroupItem = {
  /** Index in the client's original request array — the merge key (invariant #4). */
  originalIndex: number
  id: JsonRpcId
  method: string
  params: unknown[]
  /**
   * Whether the classifier judged this item to touch historical state
   * (design.md §9.1). Carried internally: it only widens the capability-mismatch
   * signature ("block not found" is a mismatch for historical queries only,
   * design.md §8.3 / decision #35). Not part of the public taxonomy.
   */
  historical: boolean
}

export type Group = {
  chain: string
  items: GroupItem[]
  needsArchive: boolean
  idempotency: "READ" | "NON_IDEMPOTENT"
  /** Timeout for one attempt, from the classifier (design.md §14). */
  timeoutMs: number
  /**
   * Provider flag `counts_batch_as_one_request`. A group spans several candidate
   * upstreams, so this is only a hint: the adapter's own instance config wins
   * (design.md §5.5 rule 2).
   */
  countsBatchAsOne?: boolean
}

export type AttemptCtx = {
  /** 0-based attempt counter for this (upstream, group) pair. */
  attempt: number
  logger: Logger
  now(): number
}

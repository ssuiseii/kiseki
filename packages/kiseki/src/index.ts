/**
 * `kiseki` — public surface of the routing core (Milestone 3).
 *
 * The server (Milestone 4) consumes exactly this: parse a body, hand the items to
 * `handle`, shape the answer. Everything below the pipeline is reachable for
 * tests and for future callers, but the pipeline is the contract.
 *
 * Deliberately absent: any provider import. Only `registry.ts` may import a
 * provider package (design.md §20).
 */

export {
  ERROR_BROADCAST_UNKNOWN,
  ERROR_CAPACITY_EXHAUSTED,
  ERROR_INVALID_REQUEST,
  ERROR_METHOD_UNSUPPORTED,
  ERROR_NO_HEALTHY_UPSTREAM,
  ERROR_UNAUTHORIZED,
  ERROR_UNKNOWN_CHAIN,
  broadcastUnknown,
  capacityExhausted,
  invalidRequest,
  methodBlocked,
  methodUnsupported,
  noHealthyUpstream,
  unknownChain,
} from "./errors"

export { mergeResults, parseRequest } from "./batch"
export type { ItemResult, ParsedRequest, RejectedItem, RequestItem } from "./batch"

export {
  ARCHIVE_DEPTH,
  SEND_RAW_TRANSACTION,
  blockRefs,
  buildTimeoutPolicy,
  classify,
  isHistoricalRef,
  parseBlockRef,
} from "./classify"
export type {
  Classified,
  ClassifyOptions,
  ClassifyResult,
  Idempotency,
  MethodClass,
  TimeoutPolicy,
} from "./classify"

export { candidatesFor, notesExclude, toView } from "./capability"
export type { UpstreamView } from "./capability"

export {
  RETRY_AFTER_CEILING_MS,
  RETRY_AFTER_FLOOR_MS,
  clampRetryAfter,
  planGroups,
  route,
  toGroup,
} from "./router"
export type {
  EndReason,
  GroupRun,
  ItemOutcome,
  ItemState,
  RouterDeps,
  RouterObserver,
} from "./router"

export { handle } from "./pipeline"
export type { PipelineDeps, PipelineObserver, PipelineResult } from "./pipeline"

export { createRuntime, retainIdentities } from "./runtime"
export type { ChainRuntime, Runtime, RuntimeOptions } from "./runtime"

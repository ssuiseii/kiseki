/**
 * Public surface of `upstream-core` (design.md §20, implementation.md §2).
 *
 * Everything a provider package or the main package may rely on. Internal
 * helpers that are not exported here are free to change.
 */

export type {
  JsonRpcError,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResult,
  JsonRpcSuccess,
} from "./types/jsonrpc"
export { isJsonRpcError } from "./types/jsonrpc"

export type { Logger, LogFields } from "./types/logger"
export { silentLogger } from "./types/logger"

export type { AttemptCtx, Group, GroupItem } from "./types/group"

export type { Entry, UnsupportedItem, UpstreamOutcome } from "./types/outcome"

export type {
  ApiKeyConfig,
  AdapterFactory,
  Capability,
  CoreDeps,
  ProviderHooks,
  UpstreamAdapter,
  UpstreamInstanceConfig,
} from "./adapter"

export { AdapterRegistry } from "./registry"

export type { Bucket, BucketSpec, KeyHealth } from "./bucket"
export { ApiKeyState, BucketRegistry, identityKey } from "./bucket"

export type { CapabilityCap, CapabilityErrorMatcher } from "./capsig"
export {
  RuntimeNotes,
  composeMatchers,
  isMethodNotFound,
  matchCapabilityError,
} from "./capsig"

export type { CostResolver, CostTable } from "./cost"
export { buildCostResolver, buildLayeredCostResolver, lookupCost } from "./cost"

export type { PostJsonFailure, PostJsonOk, PostJsonOptions, PostJsonResult } from "./http"
export { postJson } from "./http"

export type {
  ClassifiedBody,
  ClassifyBodyOptions,
  ItemVerdict,
  ResponseClass,
} from "./result"
export {
  classifyBody,
  classifyResponse,
  parseRetryAfter,
  verdictToEntry,
} from "./result"

export type { AdapterHooks, ApikeyPoolOptions, PoolKey, PoolObserver } from "./pool"
export { ApikeyPool, buildBody, createPoolAdapter } from "./pool"

export {
  capabilityCovers,
  isValidMethodPattern,
  matchesMethodPattern,
  patternsOverlap,
  supportsMethod,
} from "./methods"

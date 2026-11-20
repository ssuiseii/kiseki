/**
 * `kiseki` — public surface of the proxy (Milestones 3–4).
 *
 * Two layers, both exported:
 *
 *  - the **routing core**: parse a body, hand the items to `handle`, shape the
 *    answer. `handle` is pure with respect to I/O, which is why the pipeline is
 *    the contract and why the server is a thin adapter over it.
 *  - the **process layer**: config → runtime, logger, metrics, Hono routes, SIGHUP
 *    reload. Exported so the e2e test can drive a real server in-process.
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

export {
  configFingerprints,
  instanceFingerprint,
  reloadRuntime,
} from "./reload"
export type { ReloadOptions, ReloadResult } from "./reload"

export { createJsonLogger, collectSecrets, debugBodiesEnabled } from "./observ/logger"
export type { JsonLoggerOptions, LogLevel } from "./observ/logger"

export { createMetrics, metricKeyId } from "./observ/metrics"
export type { Metrics, MetricsOptions } from "./observ/metrics"

export {
  authenticate,
  buildKeyIndex,
  extractCredentials,
} from "./server/auth"
export type {
  AuthConfig,
  AuthFailureReason,
  AuthKeyConfig,
  AuthResult,
  Credentials,
  KeyIndex,
} from "./server/auth"

export { createServer, redactPath, splitPath } from "./server/index"
export type { ServerDeps, ServerHandle } from "./server/index"

export { DEFAULT_CONFIG_PATH, USAGE, parseArgs, runCli, start } from "./main"
export type { CliOptions, Started } from "./main"

/**
 * This module is the LIBRARY surface and has no process side effect: importing it
 * from a test never starts a proxy.
 *
 * The compiled binary is built from `src/cli.ts`, and that is a deliberate,
 * documented deviation from the one-line sketch in design.md §21:
 * `bun build --compile src/index.ts` produces a binary that exits 0 WITHOUT
 * listening. Bun sets `import.meta.main` only in the module the bundler was
 * pointed at, so the guard that would start the process is unreachable from here.
 * `src/cli.ts` is a one-line process boundary that always runs. See its header,
 * and `test/binary.test.ts`, which fails if the artefact stops serving.
 */

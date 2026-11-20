/**
 * The request pipeline (design.md §4, implementation.md §4).
 *
 * This is where the frozen flow becomes code, in the design's own order:
 *
 *   A. classify every item + pre-flight the capability matrix (§8.2, §9)
 *   B. group the routable items by (candidate set, archive need, idempotency)
 *   C. route: level-1 attempt loop + regroup loop (#34)
 *   D. merge per original index and shape the response (§12.3)
 *
 * The only thing this module does NOT own is HTTP: it takes a parsed body and
 * returns a status + body, so the whole flow is testable without a server.
 */

import type { JsonRpcError, Logger, RuntimeNotes } from "upstream-core"
import {
  mergeResults,
  type ItemResult,
  type ParsedRequest,
  type RequestItem,
} from "../batch"
import { candidatesFor, type UpstreamView } from "../capability"
import {
  classify,
  type Classified,
  type ClassifyOptions,
  type MethodClass,
  type TimeoutPolicy,
} from "../classify"
import { methodUnsupported } from "../errors"
import {
  route,
  type ItemOutcome,
  type ItemState,
  type RouterObserver,
} from "../router"

export type PipelineObserver = RouterObserver & {
  /** Pre-flight rejected an item because no upstream claims the capability. */
  onPreflightReject?(chain: string, reason: "method" | "archive" | "blocked"): void
}

export type PipelineDeps = {
  chain: string
  /** Every upstream of the chain, in config order. */
  upstreams: readonly UpstreamView[]
  /** Runtime capability notes (per instance, reset on reload — design.md §19). */
  notes: RuntimeNotes
  logger: Logger
  now(): number
  timeouts: TimeoutPolicy
  blockedMethods: readonly string[]
  maxTotalAttempts: number
  /** Chain tip when known, for the archive heuristic (design.md §9.1). */
  tip?: number
  random?(): number
  observer?: PipelineObserver
}

export type PipelineResult = {
  /** `object` → single envelope; `array` → JSON array (matches the request). */
  shape: "object" | "array"
  /** HTTP status per design.md §12.3. */
  status: 200 | 429
  body: unknown
  /** Only when `status` is 429 (§12.2). */
  retryAfterMs?: number
  /** Unordered; tests assert on it, shaping sorts it. */
  results: ItemResult[]
  /**
   * Distinct method classes among the items of this request, for
   * `kiseki_requests_total{method_class}` (§18.1). A batch can mix classes, so
   * the server counts the request once per class it actually contained instead
   * of inventing a single "batch class".
   */
  classes: MethodClass[]
}

const toResult = (outcome: ItemOutcome): ItemResult =>
  outcome.ok
    ? { originalIndex: outcome.item.originalIndex, id: outcome.item.id, ok: true, result: outcome.result }
    : {
        originalIndex: outcome.item.originalIndex,
        id: outcome.item.id,
        ok: false,
        error: outcome.error!,
      }

const envelope = (result: ItemResult): Record<string, unknown> =>
  result.ok
    ? { jsonrpc: "2.0", id: result.id, result: result.result }
    : { jsonrpc: "2.0", id: result.id, error: result.error }

/**
 * Stage A: classify and pre-flight one item.
 *
 * Returns either a ready-to-send state or the error that ends the item without
 * any attempt (blocked method, or no upstream claims the capability). Both are
 * quota-free by construction: nothing has been sent yet (§8.2).
 */
const prepare = (
  deps: PipelineDeps,
  request: RequestItem,
):
  | { ok: true; state: ItemState }
  | { ok: false; error: JsonRpcError; methodClass: MethodClass } => {
  const options: ClassifyOptions = {
    timeouts: deps.timeouts,
    blockedMethods: deps.blockedMethods,
    ...(deps.tip === undefined ? {} : { tip: deps.tip }),
  }

  const classified = classify(request.method, request.params, options)
  if (!classified.ok) {
    deps.observer?.onPreflightReject?.(deps.chain, "blocked")
    // A blocked method never got a class: it was rejected on policy, before the
    // method-class question mattered. Report it as `default` so the counter still
    // accounts for the request instead of dropping it.
    return { ok: false, error: classified.error, methodClass: "default" }
  }

  const { needsArchive } = classified.classified
  const candidates = candidatesFor(
    deps.upstreams,
    [request.method],
    needsArchive,
    deps.notes,
  )

  if (candidates.length === 0) {
    const cap: "method" | "archive" = needsArchive ? "archive" : "method"
    deps.observer?.onPreflightReject?.(deps.chain, cap)
    deps.logger.warn("pre-flight rejected", {
      chain: deps.chain,
      method: request.method,
      cap,
    })
    return {
      ok: false,
      error: methodUnsupported(deps.chain, request.method, cap),
      methodClass: classified.classified.methodClass,
    }
  }

  return {
    ok: true,
    state: {
      request,
      classified: classified.classified,
      tried: new Set(),
      mismatched: new Set(),
    },
  }
}

/**
 * Shape the response (design.md §12.3).
 *
 * The 429 rule is exact, not heuristic: **every** item in the response must have
 * failed for capacity. One real answer — even one provider error, even one
 * pre-flight rejection — makes this a 200, because the client has something to
 * act on and a blanket Retry-After would be a lie about that item.
 */
const shapeResponse = (
  results: readonly ItemResult[],
  outcomes: readonly ItemOutcome[],
  classes: readonly MethodClass[],
): Omit<PipelineResult, "shape" | "body"> => {
  const capacityOutcomes = outcomes.filter((outcome) => outcome.capacity !== undefined)
  const allCapacity = capacityOutcomes.length > 0 && capacityOutcomes.length === results.length

  // Conservative across a batch: the latest estimate, so a retry cannot arrive
  // before every starved item is ready.
  const retryAfterMs = allCapacity
    ? Math.max(...capacityOutcomes.map((outcome) => outcome.retryAfterMs ?? 0))
    : undefined

  return {
    status: allCapacity ? 429 : 200,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    results: mergeResults(results),
    classes: [...classes],
  }
}

/** Attach the response body once the request shape is known. */
const withBody = (
  result: Omit<PipelineResult, "shape" | "body">,
  parsed: ParsedRequest,
): PipelineResult => {
  const envelopes = result.results.map(envelope)
  if (parsed.shape === "array") {
    return { ...result, shape: "array", body: envelopes }
  }
  // A single request answers with a single object. `parseRequest` guarantees at
  // most one result in this case.
  return { ...result, shape: "object", body: envelopes[0] ?? null }
}

/**
 * Handle one already-parsed request. Pure with respect to I/O: the only side
 * effects are the ones the injected adapters perform, plus logging.
 */
export const handle = async (
  deps: PipelineDeps,
  parsed: ParsedRequest,
): Promise<PipelineResult> => {
  const results: ItemResult[] = parsed.rejected.map((rejected) => ({
    originalIndex: rejected.originalIndex,
    id: rejected.id,
    ok: false,
    error: rejected.error,
  }))

  const states: ItemState[] = []
  const classes = new Set<MethodClass>()
  for (const request of parsed.items) {
    const prepared = prepare(deps, request)
    if (prepared.ok) {
      states.push(prepared.state)
      classes.add(prepared.state.classified.methodClass)
    } else {
      classes.add(prepared.methodClass)
      results.push({
        originalIndex: request.originalIndex,
        id: request.id,
        ok: false,
        error: prepared.error,
      })
    }
  }

  if (states.length === 0) {
    // Everything was rejected before routing: no attempt, no quota, HTTP 200
    // (design.md §12.3 row 4).
    return withBody(shapeResponse(results, [], [...classes]), parsed)
  }

  const outcomes = await route(
    {
      chain: deps.chain,
      upstreams: deps.upstreams,
      candidatesFor: (request: RequestItem, classified: Classified) =>
        candidatesFor(deps.upstreams, [request.method], classified.needsArchive, deps.notes),
      logger: deps.logger,
      now: deps.now,
      maxTotalAttempts: deps.maxTotalAttempts,
      ...(deps.random === undefined ? {} : { random: deps.random }),
      observer: {
        // Record the runtime note here rather than inside the router: the note is
        // process-wide state (design.md §8.3, §19) and the pipeline owns it.
        onRegroup: (event) => {
          deps.notes.note(event.upstream, event.cap, event.method)
          deps.observer?.onRegroup?.(event)
        },
        ...(deps.observer?.onAttempt === undefined
          ? {}
          : { onAttempt: deps.observer.onAttempt }),
        ...(deps.observer?.onFailFast === undefined
          ? {}
          : { onFailFast: deps.observer.onFailFast }),
        ...(deps.observer?.onAmbiguous === undefined
          ? {}
          : { onAmbiguous: deps.observer.onAmbiguous }),
      },
    },
    states,
  )

  results.push(...outcomes.map(toResult))
  return withBody(shapeResponse(results, outcomes, [...classes]), parsed)
}

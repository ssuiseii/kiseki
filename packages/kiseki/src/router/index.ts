/**
 * Router level 1 (design.md §6, implementation.md §4).
 *
 * Responsibilities, in the order the loop applies them:
 *
 *   1. **Eligibility** (§6.1): candidate ∧ ¬tried ∧ weight > 0. Sickness needs no
 *      separate check — `attempt()` on a sick adapter returns `sick` without a
 *      fetch, which is behaviourally the same as filtering it out and keeps the
 *      frozen contract free of a health accessor.
 *   2. **Weighted-random selection** over Σ headroom (§6.2). The router never
 *      touches a bucket; it only reads the scalar the adapter reports.
 *   3. **Outcome reaction** (§11.1) and, crucially, the **regroup loop** (#34):
 *      items proven mismatched are handed back for another round instead of
 *      becoming a client error.
 *   4. **Finalisation** (#36): an item with no candidate left receives the last
 *      provider error verbatim, or fails fast when it ended on capacity (§12).
 *
 * Termination (invariant #8): a regroup happens only for items an upstream just
 * attempted, and that upstream is added to their `tried` set, which never
 * shrinks. With a finite upstream list the loop cannot run forever; the round cap
 * below is defence in depth, not the mechanism.
 */

import {
  type Entry,
  type Group,
  type GroupItem,
  type JsonRpcError,
  type Logger,
  type UnsupportedItem,
  type UpstreamOutcome,
} from "upstream-core"
import type { Classified } from "../classify"
import type { RequestItem } from "../batch"
import type { UpstreamView } from "../capability"
import { broadcastUnknown, capacityExhausted, methodUnsupported, noHealthyUpstream } from "../errors"

/** Retry-After bounds from design.md §12.2. */
export const RETRY_AFTER_FLOOR_MS = 500
export const RETRY_AFTER_CEILING_MS = 30_000

export type RouterObserver = {
  /** One level-1 attempt finished; `outcome` is the taxonomy kind. */
  onAttempt?(upstream: string, outcome: UpstreamOutcome["kind"]): void
  /**
   * An upstream proved it cannot serve an item (design.md §8.3). The listener is
   * expected to record a runtime note — that note is what makes the NEXT request
   * skip the upstream instead of re-learning the mismatch.
   */
  onRegroup?(event: {
    chain: string
    upstream: string
    method: string
    cap: "method" | "archive"
  }): void
  /** A group ended on capacity/health, not on a provider answer (§12.1). */
  onFailFast?(chain: string, reason: "rate_limited" | "sick"): void
  /** `eth_sendRawTransaction` returned `ambiguous` (design.md §11.3). */
  onAmbiguous?(upstream: string): void
}

/** How an item's most recent upstream ended, for finalisation (#36 / §12). */
export type EndReason =
  | { kind: "unsupported"; error: JsonRpcError }
  | { kind: "rate_limited"; retryAtMs: number }
  | { kind: "sick"; retryAtMs: number }

/** One routable item plus its routing state across regroup rounds. */
export type ItemState = {
  request: RequestItem
  classified: Classified
  /** Upstreams that already attempted this item (invariant #8). */
  tried: Set<string>
  /**
   * Upstreams that proved they cannot serve this item (design.md §8.3). They are
   * excluded from the Retry-After estimate: they will never answer this item, so
   * counting their recovery time would only understate the real wait.
   */
  mismatched: Set<string>
  /** How the item's last upstream ended. */
  lastEnd?: EndReason
}

export type ItemOutcome = {
  item: RequestItem
  ok: boolean
  result?: unknown
  error?: JsonRpcError
  /** Set when the item failed for capacity/health, so shaping can pick HTTP 429. */
  capacity?: "rate_limited" | "sick"
  retryAfterMs?: number
}

export type RouterDeps = {
  chain: string
  /** Every upstream of the chain, in config order. */
  upstreams: readonly UpstreamView[]
  /** Static capability minus runtime notes; recomputed per round (§10.1 step 4). */
  candidatesFor(item: RequestItem, classified: Classified): readonly UpstreamView[]
  logger: Logger
  now(): number
  /** `limits.max_total_attempts`; 0 = unlimited (design.md Lampiran A). */
  maxTotalAttempts: number
  /** Test seam for weighted-random. */
  random?(): number
  observer?: RouterObserver
}

/** Clamp an estimated wait into the documented Retry-After window (§12.2). */
export const clampRetryAfter = (waitMs: number): number => {
  if (!Number.isFinite(waitMs)) return RETRY_AFTER_CEILING_MS
  return Math.min(RETRY_AFTER_CEILING_MS, Math.max(RETRY_AFTER_FLOOR_MS, Math.round(waitMs)))
}

/** One weighted-random pick; weights are positive (§6.2). */
const weightedPick = <T>(
  entries: readonly { value: T; weight: number }[],
  random: () => number,
): T => {
  if (entries.length === 1) return entries[0]!.value
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  if (total <= 0) return entries[0]!.value
  let threshold = random() * total
  for (const entry of entries) {
    threshold -= entry.weight
    if (threshold <= 0) return entry.value
  }
  return entries[entries.length - 1]!.value
}

type GroupPlan = {
  key: string
  items: ItemState[]
  /** Static candidates, used for the Retry-After estimate (§12.2). */
  candidates: readonly UpstreamView[]
  /** Candidates minus the ones these items already tried — identical for all. */
  eligible: readonly UpstreamView[]
  needsArchive: boolean
  idempotency: "READ" | "NON_IDEMPOTENT"
  /** One attempt timeout per group: the slowest item sets the deadline (§14). */
  timeoutMs: number
}

/**
 * Group key (design.md §10.1 step 1): the set of upstreams that can still serve
 * the item, plus archive need and idempotency class.
 *
 * Keying on the *eligible* set rather than the static candidate set is what makes
 * `tried` uniform inside a group: two items with the same eligible set necessarily
 * have the same tried set, so one group can share one loop without ever sending an
 * item to an upstream that already answered it.
 */
const groupKey = (eligible: readonly UpstreamView[], classified: Classified): string =>
  `${eligible
    .map((upstream) => upstream.name)
    .sort()
    .join(",")}|${classified.needsArchive ? "archive" : "plain"}|${classified.idempotency}`

export const planGroups = (
  pending: readonly ItemState[],
  candidatesFor: RouterDeps["candidatesFor"],
): GroupPlan[] => {
  const groups = new Map<string, GroupPlan>()
  for (const state of pending) {
    const candidates = candidatesFor(state.request, state.classified)
    const eligible = candidates.filter((upstream) => !state.tried.has(upstream.name))
    const key = groupKey(eligible, state.classified)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        key,
        items: [state],
        candidates,
        eligible,
        needsArchive: state.classified.needsArchive,
        idempotency: state.classified.idempotency,
        timeoutMs: state.classified.timeoutMs,
      })
    } else {
      existing.items.push(state)
      if (state.classified.timeoutMs > existing.timeoutMs) {
        existing.timeoutMs = state.classified.timeoutMs
      }
    }
  }
  return [...groups.values()]
}

/** The exact payload an adapter receives. Exported for tests. */
export const toGroup = (
  chain: string,
  plan: GroupPlan,
  items: readonly ItemState[] = plan.items,
): Group => ({
  chain,
  items: items.map(
    (state): GroupItem => ({
      originalIndex: state.request.originalIndex,
      id: state.request.id,
      method: state.request.method,
      params: state.request.params,
      historical: state.classified.historical,
    }),
  ),
  needsArchive: plan.needsArchive,
  idempotency: plan.idempotency,
  timeoutMs: plan.timeoutMs,
})

export type GroupRun = {
  finished: ItemOutcome[]
  /** Items an upstream proved it cannot serve; they get another round (#34). */
  regroup: ItemState[]
  /** Set when the group ended on capacity/health; shaping uses it for HTTP 429. */
  failFast?: { reason: "rate_limited" | "sick"; retryAfterMs: number }
}

const findState = (plan: GroupPlan, originalIndex: number): ItemState | undefined =>
  plan.items.find((state) => state.request.originalIndex === originalIndex)

const recordEntry = (plan: GroupPlan, entry: Entry, out: ItemOutcome[]): void => {
  const state = findState(plan, entry.originalIndex)
  if (state === undefined) return
  if (out.some((existing) => existing.item.originalIndex === entry.originalIndex)) return
  out.push(
    entry.ok
      ? { item: state.request, ok: true, result: entry.result }
      : { item: state.request, ok: false, error: entry.error },
  )
}

/**
 * Items the upstream did not answer at all. The contract says entries are
 * complete (implementation.md §2), so this is a safety net: an unanswered item
 * must never silently vanish from the response (invariant #4).
 */
const unanswered = (
  deps: RouterDeps,
  plan: GroupPlan,
  finished: readonly ItemOutcome[],
  exclude: ReadonlySet<number>,
): ItemOutcome[] => {
  const answered = new Set(finished.map((outcome) => outcome.item.originalIndex))
  const missing = plan.items.filter(
    (state) =>
      !answered.has(state.request.originalIndex) && !exclude.has(state.request.originalIndex),
  )
  if (missing.length === 0) return []
  deps.logger.error("upstream returned an incomplete entry set", {
    chain: deps.chain,
    missing: missing.map((state) => state.request.originalIndex),
  })
  return missing.map((state) => ({
    item: state.request,
    ok: false,
    error: noHealthyUpstream(),
  }))
}

/**
 * Finalise one item that has no candidate left (implementation.md §4).
 *
 * Precedence is the design's, read literally:
 *  - the item's last ending was a proven capability mismatch → that provider
 *    error, verbatim (#36);
 *  - the item's last ending was capacity/sickness (or it never got an attempt
 *    because every candidate had weight 0) → §12 fail fast with an estimate.
 *
 * "Last" matters: a mismatch followed by a rate-limited upstream means the item
 * is not proven impossible, only unavailable right now, and a Retry-After is the
 * truthful answer — the next request will skip the mismatching upstream because
 * of its runtime note.
 */
const finalizeItem = (
  deps: RouterDeps,
  candidates: readonly UpstreamView[],
  state: ItemState,
  retryAtByName: ReadonlyMap<string, number>,
): ItemOutcome => {
  const end = state.lastEnd

  if (end?.kind === "unsupported") {
    return { item: state.request, ok: false, error: end.error }
  }

  // Defensive: the pipeline pre-flights zero-candidate items, so this is only
  // reachable by a direct caller. Saying "rate limited" here would be a lie —
  // there is no upstream that could ever serve the item.
  if (candidates.length === 0) {
    return {
      item: state.request,
      ok: false,
      error: methodUnsupported(deps.chain, state.request.method),
    }
  }

  const retryAfterMs = clampRetryAfter(
    estimateRetryAfter(deps, candidates, retryAtByName, state.mismatched),
  )

  if (end?.kind === "sick") {
    deps.observer?.onFailFast?.(deps.chain, "sick")
    return {
      item: state.request,
      ok: false,
      error: noHealthyUpstream(),
      capacity: "sick",
      retryAfterMs,
    }
  }

  deps.observer?.onFailFast?.(deps.chain, "rate_limited")
  return {
    item: state.request,
    ok: false,
    error: capacityExhausted(retryAfterMs),
    capacity: "rate_limited",
    retryAfterMs,
  }
}

/**
 * design.md §12.2: `min over capable upstreams(max(earliestReadyAt(u), sisa_sick(u)))`.
 *
 * Only upstreams that could still serve this group count. Two kinds are excluded:
 * one the static matrix does not cover (already absent from `candidates`), and one
 * that just proved a runtime mismatch — it will never help this item, so its
 * recovery time would only understate the real wait.
 *
 * `retryAtByName` adds the outcome-provided estimate where the adapter gave one,
 * which is more accurate than the generic "cost 1" estimate that
 * `earliestReadyAt()` must use because it takes no group.
 */
const estimateRetryAfter = (
  deps: RouterDeps,
  candidates: readonly UpstreamView[],
  retryAtByName: ReadonlyMap<string, number>,
  mismatched: ReadonlySet<string>,
): number => {
  const nowMs = deps.now()
  let earliest = Number.POSITIVE_INFINITY
  for (const upstream of candidates) {
    if (mismatched.has(upstream.name)) continue
    const readyAt = Math.max(
      upstream.adapter.earliestReadyAt(),
      retryAtByName.get(upstream.name) ?? 0,
    )
    const waitMs = Math.max(0, readyAt - nowMs)
    if (waitMs < earliest) earliest = waitMs
  }
  return earliest
}

/**
 * Run one group until every item is answered or proven unservable by the
 * upstreams that tried it.
 */
const runGroup = async (deps: RouterDeps, plan: GroupPlan): Promise<GroupRun> => {
  const { logger, now, observer } = deps
  const random = deps.random ?? Math.random

  const finished: ItemOutcome[] = []
  const retryAtByName = new Map<string, number>()
  const attemptsByName = new Map<string, number>()
  let attempts = 0

  // Every item of a group shares one eligible set (see `groupKey`), so one
  // `tried` set serves the loop and is mirrored back onto each item.
  const tried = new Set(plan.items[0]!.tried)
  const group = toGroup(deps.chain, plan)

  const markTried = (name: string): void => {
    tried.add(name)
    for (const state of plan.items) state.tried.add(name)
  }

  /** Close out the group: answer what is answered, finalise the rest. */
  const finalize = (): GroupRun => {
    const ended = plan.items
      .filter(
        (state) => !finished.some((out) => out.item.originalIndex === state.request.originalIndex),
      )
      .map((state) => finalizeItem(deps, plan.candidates, state, retryAtByName))

    const capacityOutcome = ended.find((outcome) => outcome.capacity !== undefined)
    return {
      finished: [...finished, ...ended],
      regroup: [],
      ...(capacityOutcome === undefined
        ? {}
        : {
            failFast: {
              reason: capacityOutcome.capacity!,
              retryAfterMs: capacityOutcome.retryAfterMs ?? RETRY_AFTER_FLOOR_MS,
            },
          }),
    }
  }

  /** Hand mismatched items back for another round (#34). */
  const regroupFrom = (upstream: string, items: readonly UnsupportedItem[]): GroupRun => {
    const regroup: ItemState[] = []
    for (const item of items) {
      const state = findState(plan, item.originalIndex)
      if (state === undefined) continue
      state.lastEnd = { kind: "unsupported", error: item.providerError }
      state.mismatched.add(upstream)
      observer?.onRegroup?.({
        chain: deps.chain,
        upstream,
        method: item.method,
        cap: item.cap,
      })
      logger.warn("capability mismatch regroup", {
        chain: deps.chain,
        upstream,
        method: item.method,
        cap: item.cap,
      })
      if (!regroup.includes(state)) regroup.push(state)
    }
    // Mismatched items are pending, not missing: exclude them from the safety net.
    const excluded = new Set(items.map((item) => item.originalIndex))
    return {
      finished: [...finished, ...unanswered(deps, plan, finished, excluded)],
      regroup,
    }
  }

  for (;;) {
    const eligible = plan.eligible
      .filter((upstream) => !tried.has(upstream.name))
      .map((upstream) => ({ value: upstream, weight: upstream.adapter.weight() }))
      .filter((entry) => entry.weight > 0)

    if (eligible.length === 0) return finalize()

    // Safety valve (§6.3). Default 0 keeps the design's "try every candidate".
    if (deps.maxTotalAttempts > 0 && attempts >= deps.maxTotalAttempts) {
      logger.warn("attempt budget exhausted", {
        chain: deps.chain,
        maxTotalAttempts: deps.maxTotalAttempts,
      })
      return finalize()
    }

    const chosen = weightedPick(eligible, random)
    const perUpstream = attemptsByName.get(chosen.name) ?? 0
    attemptsByName.set(chosen.name, perUpstream + 1)
    attempts += 1
    markTried(chosen.name)

    const outcome = await chosen.adapter.attempt(group, { attempt: perUpstream, logger, now })
    observer?.onAttempt?.(chosen.name, outcome.kind)

    switch (outcome.kind) {
      case "success": {
        for (const entry of outcome.entries) recordEntry(plan, entry, finished)
        const unsupported = outcome.unsupportedItems ?? []
        if (unsupported.length > 0) return regroupFrom(chosen.name, unsupported)
        return {
          finished: [...finished, ...unanswered(deps, plan, finished, EMPTY_SET)],
          regroup: [],
        }
      }

      case "domain_error": {
        // A genuine node answer (revert, nonce too low, …): final, no failover.
        for (const entry of outcome.entries) recordEntry(plan, entry, finished)
        return {
          finished: [...finished, ...unanswered(deps, plan, finished, EMPTY_SET)],
          regroup: [],
        }
      }

      case "unsupported":
        return regroupFrom(chosen.name, outcome.items)

      case "rate_limited": {
        retryAtByName.set(chosen.name, outcome.retryAtMs)
        for (const state of plan.items) {
          if (finished.some((out) => out.item.originalIndex === state.request.originalIndex)) continue
          state.lastEnd = { kind: "rate_limited", retryAtMs: outcome.retryAtMs }
        }
        logger.warn("upstream rate limited", { chain: deps.chain, upstream: chosen.name })
        continue
      }

      case "sick": {
        retryAtByName.set(chosen.name, outcome.retryAtMs)
        for (const state of plan.items) {
          if (finished.some((out) => out.item.originalIndex === state.request.originalIndex)) continue
          state.lastEnd = { kind: "sick", retryAtMs: outcome.retryAtMs }
        }
        logger.warn("upstream sick", { chain: deps.chain, upstream: chosen.name })
        continue
      }

      case "ambiguous": {
        // design.md §11.3: stop BOTH levels. No other upstream may be tried, and
        // every unanswered item of the group gets the same -32007.
        observer?.onAmbiguous?.(chosen.name)
        logger.warn("sendRaw ambiguous, stopping", {
          chain: deps.chain,
          upstream: chosen.name,
        })
        const error = broadcastUnknown()
        const answered = new Set(finished.map((out) => out.item.originalIndex))
        const ended: ItemOutcome[] = plan.items
          .filter((state) => !answered.has(state.request.originalIndex))
          .map((state) => ({ item: state.request, ok: false, error }))
        return { finished: [...finished, ...ended], regroup: [] }
      }
    }
  }
}

const EMPTY_SET: ReadonlySet<number> = new Set()

/**
 * Level-1 driver: run every group in parallel, then repeat for items an upstream
 * proved it cannot serve (the regroup loop, #34).
 *
 * Groups run concurrently because they are independent by construction — they
 * differ in eligible set, archive need or idempotency (design.md §10.1 step 3).
 */
export const route = async (
  deps: RouterDeps,
  initial: readonly ItemState[],
): Promise<ItemOutcome[]> => {
  const done: ItemOutcome[] = []
  let pending: ItemState[] = [...initial]

  for (let round = 0; pending.length > 0; round += 1) {
    // Invariant #8 makes the real bound `upstreams.length`; this is defence.
    if (round > deps.upstreams.length) {
      deps.logger.error("regroup loop exceeded its bound", {
        chain: deps.chain,
        items: pending.length,
      })
      for (const state of pending) {
        done.push(
          finalizeItem(deps, deps.candidatesFor(state.request, state.classified), state, new Map()),
        )
      }
      break
    }

    const plans = planGroups(pending, deps.candidatesFor)
    const runs = await Promise.all(plans.map((plan) => runGroup(deps, plan)))

    const next: ItemState[] = []
    for (const run of runs) {
      done.push(...run.finished)
      for (const state of run.regroup) {
        const candidates = deps.candidatesFor(state.request, state.classified)
        // No untried candidate left: finalise now instead of spending a round on
        // a group whose eligible set is empty.
        if (candidates.every((upstream) => state.tried.has(upstream.name))) {
          done.push(finalizeItem(deps, candidates, state, new Map()))
          continue
        }
        next.push(state)
      }
    }

    pending = next
  }

  return done
}

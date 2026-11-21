/**
 * ApikeyPool — level 2 of the routing hierarchy (design.md §7.2,
 * implementation.md §3).
 *
 * One pool per upstream instance (provider + chain). It owns:
 *   - the list of apikeys (their buckets live in the shared BucketRegistry),
 *   - weighted-random key selection proportional to remaining credit (#26),
 *   - the internal attempt loop with a `tried` set (termination),
 *   - quota deduction per item, before the fetch, with no refund (§5.5),
 *   - key/provider health (§13),
 *   - classification of the provider response into the outcome taxonomy.
 *
 * The router never sees any of this: it gets one `UpstreamOutcome`.
 */

import type { CoreDeps, UpstreamAdapter, UpstreamInstanceConfig } from "./adapter"
import { ApiKeyState, type BucketSpec } from "./bucket"
import { buildLayeredCostResolver, type CostResolver, type CostTable } from "./cost"
import type { CapabilityErrorMatcher } from "./capsig"
import { postJson, type PostJsonOptions } from "./http"
import {
  canonicalMappingFailed,
  canonicalTransportUnsupported,
  coveredCanonicalMethods,
  invalidCanonicalParams,
  type MethodTranslation,
} from "./namespace"
import { classifyBody, classifyResponse, verdictToEntry, type ItemVerdict } from "./result"
import type { AttemptCtx, Group, GroupItem } from "./types/group"
import type { Entry, UnsupportedItem, UpstreamOutcome } from "./types/outcome"

/** Weight floor so a ready-but-drained key still has a non-zero chance (§7.2). */
const WEIGHT_EPSILON = 1e-9
/** Distinct keys failing in a row before the whole provider is parked (§13). */
const DEFAULT_SICK_THRESHOLD = 3
/** Exponential provider cooldown bounds (§13). */
const SICK_BASE_MS = 1000
const SICK_CAP_MS = 60_000

export type PoolKey = {
  token: string
  label: string
  buckets: BucketSpec[]
}

/** Observability hooks. The concrete metrics live in `kiseki` (design.md §18). */
export type PoolObserver = {
  onKeyAttempt?(upstream: string, label: string, outcome: string): void
  onKeyFailover?(upstream: string): void
  onLatency?(upstream: string, latencyMs: number): void
  onCapabilityMismatch?(upstream: string, method: string, cap: "method" | "archive"): void
}

export type ApikeyPoolOptions = {
  instance: string
  provider: string
  keys: readonly PoolKey[]
  /** Build the request URL for one token. */
  url(token: string): string
  /** Effective cost per method for THIS provider (override ?? global ?? 1). */
  costFor: CostResolver
  /** Provider signature hook layered over the generic table (§8.3). */
  matchCapability?: CapabilityErrorMatcher
  /** Providers billing per HTTP call instead of per item (§5.5 rule 2). */
  countsBatchAsOne?: boolean
  /** Provider quirks: extra headers per token. */
  headers?(token: string): Record<string, string>
  /** Per-instance timeout override; wins over the classifier value (§14). */
  timeoutMs?: number
  /**
   * Canonical-namespace table (`kiseki_*` → provider method). Absent = this
   * instance serves no canonical methods; the engine then behaves exactly as
   * before (namespace.ts).
   */
  translations?: readonly MethodTranslation[]
  deps: CoreDeps
  observer?: PoolObserver
  /** Test seam for weighted-random. Defaults to Math.random. */
  random?(): number
  /** Distinct-key failure threshold for provider-level sick. */
  sickThreshold?: number
}

/** Why one key did not serve the group; drives the next iteration. */
type RetryReason = "rate_limited" | "server_error"

/**
 * One item as it will actually go upstream: `method`/`params` are already the
 * provider's when a translation applies, while `item` stays the client-visible
 * one so classification, regrouping and the final `Entry` keep naming what the
 * client asked for.
 */
export type OutboundItem = {
  item: GroupItem
  /** Method actually sent (the upstream name when translated). */
  method: string
  /**
   * The JSON-RPC `params` as the provider wants them: whatever `mapRequest`
   * returned (object or array) for a translated item, the client's array
   * otherwise. JSON-RPC 2.0 allows both shapes.
   */
  params: unknown
}

/** A group split into "what to send" and "what was answered locally". */
type PreparedGroup = {
  send: OutboundItem[]
  /** Canonical params that could not be mapped: domain errors, no fetch. */
  preAnswered: Entry[]
}

type KeyAttempt =
  | { stop: true; outcome: UpstreamOutcome }
  | { stop: false; reason: RetryReason }

type KeyRef = { state: ApiKeyState; label: string }

export class ApikeyPool {
  readonly instance: string
  readonly provider: string
  private readonly options: ApikeyPoolOptions
  private readonly keys: KeyRef[]
  private readonly random: () => number
  private readonly sickThreshold: number
  /** Canonical name → translation. Empty when the package serves none. */
  private readonly translations: ReadonlyMap<string, MethodTranslation>
  /** Consecutive key failures across distinct keys (design.md §13). */
  private crossKeyFailures = 0
  private sickUntilMs = 0
  private sickLevel = 0

  constructor(options: ApikeyPoolOptions) {
    this.options = options
    this.instance = options.instance
    this.provider = options.provider
    this.random = options.random ?? Math.random
    this.sickThreshold = options.sickThreshold ?? DEFAULT_SICK_THRESHOLD
    this.translations = new Map(
      (options.translations ?? []).map((translation) => [translation.canonical, translation]),
    )
    this.keys = options.keys.map((key) => ({
      label: key.label,
      state: options.deps.bucketRegistry.get(options.provider, key.token, key.buckets),
    }))
  }

  get keyCount(): number {
    return this.keys.length
  }

  /** Snapshot for metrics: label + live credits, never the token. */
  keySnapshots(): { label: string; credits: number[]; cooldownMs: number }[] {
    const nowMs = this.options.deps.now()
    return this.keys.map((key) => ({
      label: key.label,
      credits: key.state.credits(nowMs),
      cooldownMs: key.state.cooldownRemainingMs(nowMs),
    }))
  }

  /**
   * Σ headroom over usable apikeys (§6.2). A key in cooldown contributes 0: it
   * cannot serve, so it is not a "key-equivalent of free capacity".
   */
  weight(): number {
    const nowMs = this.options.deps.now()
    let total = 0
    for (const key of this.keys) {
      if (key.state.cooldownRemainingMs(nowMs) > 0) continue
      total += key.state.headroom(nowMs)
    }
    return total
  }

  /** Earliest moment any apikey could serve (cost floor 1), for Retry-After. */
  earliestReadyAt(): number {
    const nowMs = this.options.deps.now()
    let earliest = Number.POSITIVE_INFINITY
    for (const key of this.keys) {
      const readyAt = key.state.readyAtMs(1, nowMs)
      if (readyAt < earliest) earliest = readyAt
    }
    return earliest
  }

  isSick(): boolean {
    return this.options.deps.now() < this.sickUntilMs
  }

  sickUntil(): number {
    return this.sickUntilMs
  }

  /**
   * Cost of one item. A cost of 0 is legitimate — Alchemy bills 0 CU for
   * `eth_chainId`/`net_version`/… — so only a missing or unusable number falls
   * back to 1. `buildLayeredCostResolver` already guarantees a number, this is
   * just belt-and-braces against a custom `costFor`.
   *
   * The name passed here is the EFFECTIVE one (the upstream method for a
   * translated item): a provider's cost table prices its own method names, so
   * `kiseki_getTokenTransfers` must be charged whatever `ankr_getTokenTransfers`
   * costs, not the implicit 1 (namespace.ts, plan A §4.4).
   */
  private itemCost(method: string): number {
    const cost = this.options.costFor(method)
    return Number.isFinite(cost) && cost >= 0 ? cost : 1
  }

  /**
   * Translate the canonical items of a group and split off the ones whose
   * canonical params are invalid.
   *
   * `mapRequest → undefined` means the CLIENT sent something the canonical
   * schema rejects. That is a domain error for that item — final, no regroup,
   * no fetch — and it must never be mistaken for a capability mismatch: the
   * upstream is fine, the request is not (namespace.ts).
   */
  private prepare(group: Group): PreparedGroup {
    const send: OutboundItem[] = []
    const preAnswered: Entry[] = []

    for (const item of group.items) {
      const translation = this.translations.get(item.method)
      if (translation === undefined) {
        send.push({ item, method: item.method, params: item.params })
        continue
      }

      // `capability()` never advertises a transport the engine cannot send, so
      // this only triggers for a hand-built adapter. Answer locally and final:
      // posting a JSON-RPC envelope to a REST endpoint would be worse.
      if ((translation.transport ?? "jsonrpc") !== "jsonrpc") {
        this.options.deps.logger.error("canonical transport not implemented", {
          upstream: this.instance,
          method: item.method,
          transport: translation.transport,
        })
        preAnswered.push({
          originalIndex: item.originalIndex,
          ok: false,
          error: canonicalTransportUnsupported(item.method),
          final: true,
        })
        continue
      }

      let mapped: unknown
      try {
        mapped = translation.mapRequest(item.params, group.chain)
      } catch (error) {
        // A throwing mapRequest is a package bug. Treat it as invalid params
        // rather than letting one item take down the whole batch.
        mapped = undefined
        this.logMappingFailure(item.method, "mapRequest", error)
      }

      if (mapped === undefined) {
        preAnswered.push({
          originalIndex: item.originalIndex,
          ok: false,
          error: invalidCanonicalParams(item.method),
          final: true,
        })
        continue
      }

      send.push({ item, method: translation.upstream, params: mapped })
    }

    return { send, preAnswered }
  }

  /**
   * Apply `mapResponse` to the successful entries of one attempt.
   *
   * Provider ERRORS are never translated (decision #36: passthrough verbatim).
   * A throw is a package bug, so it becomes a final domain error for that item —
   * retrying another upstream cannot fix a mapping function, and it would burn
   * quota for nothing.
   */
  private mapEntries(
    entries: readonly Entry[],
    sent: readonly OutboundItem[],
    chain: string,
  ): Entry[] {
    const byIndex = new Map(sent.map((outbound) => [outbound.item.originalIndex, outbound]))

    return entries.map((entry) => {
      if (!entry.ok) return entry
      const outbound = byIndex.get(entry.originalIndex)
      if (outbound === undefined) return entry
      const translation = this.translations.get(outbound.item.method)
      if (translation === undefined) return entry

      try {
        return {
          originalIndex: entry.originalIndex,
          ok: true,
          result: translation.mapResponse(entry.result, outbound.item.params, chain),
        }
      } catch (error) {
        this.logMappingFailure(outbound.item.method, "mapResponse", error)
        return {
          originalIndex: entry.originalIndex,
          ok: false,
          error: canonicalMappingFailed(outbound.item.method),
          final: true,
        }
      }
    })
  }

  /** Log a package mapping bug: the method and the message, never a payload. */
  private logMappingFailure(method: string, stage: string, error: unknown): void {
    this.options.deps.logger.error("canonical namespace mapping failed", {
      upstream: this.instance,
      method,
      stage,
      reason: error instanceof Error ? error.message : "unknown",
    })
  }

  /**
   * Quota charged for one HTTP call: the sum over items (design.md §5.5 rule 2),
   * or the single most expensive item when the provider bills per HTTP call.
   *
   * Charging the full sum up front is the conservative reading of "no refund":
   * a partially-failed batch still consumed its items' quota.
   *
   * `costNames` are the EFFECTIVE method names (upstream names for translated
   * items), so a provider's own cost table prices its own methods (plan A §4.4).
   */
  private chargeFor(costNames: readonly string[]): number {
    const perItem = costNames.map((method) => this.itemCost(method))
    if (perItem.length === 0) return 1
    if (this.options.countsBatchAsOne === true) return Math.max(...perItem)
    return perItem.reduce((sum, cost) => sum + cost, 0)
  }

  /**
   * Key eligibility cost. We require only the most expensive single item, so a
   * large batch can still be served by a small bucket (it then goes into debt and
   * refills — conservative, never over-optimistic).
   */
  private eligibilityCost(costNames: readonly string[]): number {
    if (costNames.length === 0) return 1
    return Math.max(...costNames.map((method) => this.itemCost(method)))
  }

  /**
   * Level-2 attempt loop (implementation.md §3). Terminates because every
   * iteration either returns or adds exactly one key to `tried`.
   */
  async attempt(group: Group, ctx: AttemptCtx): Promise<UpstreamOutcome> {
    const { deps, observer } = this.options
    const { logger, now } = deps

    if (this.isSick()) {
      return { kind: "sick", retryAtMs: this.sickUntilMs }
    }

    // Canonical items are rewritten once, before any key is chosen: the cost of
    // the call and the body both depend on the upstream name, not the alias.
    const prepared = this.prepare(group)
    // Nothing left to send (every item was rejected by the canonical schema, or
    // the group was empty): no key is charged and no request leaves the process.
    // Those answers are final domain errors, never mismatches (§4.2).
    if (prepared.send.length === 0) return this.poolOutcome([], prepared, group.chain)
    const costNames = prepared.send.map((outbound) => outbound.method)
    const tried = new Set<string>()
    const charge = this.chargeFor(costNames)
    const eligibility = this.eligibilityCost(costNames)
    let sawServerFailure = false
    let retryAtMs = Number.POSITIVE_INFINITY

    for (;;) {
      const nowMs = now()
      const ready = this.keys.filter(
        (key) => !tried.has(key.label) && key.state.canAfford(eligibility, nowMs),
      )

      if (ready.length === 0) {
        if (sawServerFailure) return { kind: "sick", retryAtMs: this.earliestReadyAt() }
        return {
          kind: "rate_limited",
          retryAtMs: Number.isFinite(retryAtMs) ? retryAtMs : this.earliestReadyAt(),
        }
      }

      const key = this.pickWeighted(ready, nowMs)
      tried.add(key.label)
      // Deduct synchronously BEFORE the fetch, no refund on failure (§5.5).
      key.state.deduct(charge, nowMs)

      const result = await this.tryKey(key, group, prepared, ctx, charge)

      if (result.stop) return result.outcome

      if (result.reason === "rate_limited") {
        retryAtMs = Math.min(retryAtMs, key.state.readyAtMs(eligibility, now()))
        observer?.onKeyFailover?.(this.instance)
        continue
      }

      sawServerFailure = true
      this.crossKeyFailures += 1
      if (this.crossKeyFailures >= this.sickThreshold) {
        this.tripProviderSick()
        return { kind: "sick", retryAtMs: this.sickUntilMs }
      }
      observer?.onKeyFailover?.(this.instance)
      logger.debug("key failover after failure", {
        upstream: this.instance,
        apikey: key.label,
        consecutiveFailures: this.crossKeyFailures,
      })
    }
  }

  /** Weighted-random over ready keys, proportional to remaining credit (#26). */
  private pickWeighted(ready: readonly KeyRef[], nowMs: number): KeyRef {
    if (ready.length === 1) return ready[0]!
    const weights = ready.map((key) => key.state.headroom(nowMs) + WEIGHT_EPSILON)
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let threshold = this.random() * total
    for (let i = 0; i < ready.length; i += 1) {
      threshold -= weights[i]!
      if (threshold <= 0) return ready[i]!
    }
    return ready[ready.length - 1]!
  }

  /**
   * One HTTP attempt with one key, mapped through the full provider-result matrix
   * (design.md §11.2). Returns either a terminal outcome for the whole pool or a
   * retry signal for the next key.
   */
  private async tryKey(
    key: KeyRef,
    group: Group,
    prepared: PreparedGroup,
    ctx: AttemptCtx,
    charge: number,
  ): Promise<KeyAttempt> {
    const { deps, observer } = this.options
    const { logger, now } = deps
    const nonIdempotent = group.idempotency === "NON_IDEMPOTENT"

    const postOptions: PostJsonOptions = {
      url: this.options.url(key.state.token),
      body: buildRequests(prepared.send),
      timeoutMs: this.options.timeoutMs ?? group.timeoutMs,
      now,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(this.options.headers === undefined
        ? {}
        : { headers: this.options.headers(key.state.token) }),
    }

    const response = await postJson(postOptions)
    observer?.onLatency?.(this.instance, response.latencyMs)

    // Transport failures first: for sendRaw the distinction between "never
    // reached the node" and "unknown" is the whole ballgame (design.md §11.3).
    if (response.kind === "transport_error") {
      if (nonIdempotent && response.reachedNode) {
        key.state.markFailure(now())
        observer?.onKeyAttempt?.(this.instance, key.label, "ambiguous")
        logger.warn("sendRaw ambiguous", {
          upstream: this.instance,
          apikey: key.label,
          reason: response.reason,
        })
        return { stop: true, outcome: { kind: "ambiguous" } }
      }
      key.state.markFailure(now())
      observer?.onKeyAttempt?.(this.instance, key.label, `transport:${response.reason}`)
      logger.warn("upstream transport failure", {
        upstream: this.instance,
        apikey: key.label,
        reason: response.reason,
        reachedNode: response.reachedNode,
      })
      return { stop: false, reason: "server_error" }
    }

    const responseClass = classifyResponse(response, now())

    switch (responseClass.kind) {
      case "rate_limited": {
        key.state.markRateLimited(now(), responseClass.retryAfterMs)
        observer?.onKeyAttempt?.(this.instance, key.label, "rate_limited")
        logger.warn("apikey rate limited", {
          upstream: this.instance,
          apikey: key.label,
          ...(responseClass.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: responseClass.retryAfterMs }),
        })
        return { stop: false, reason: "rate_limited" }
      }

      case "unauthorized": {
        key.state.markFailure(now())
        observer?.onKeyAttempt?.(this.instance, key.label, "unauthorized")
        logger.warn("apikey rejected by provider", {
          upstream: this.instance,
          apikey: key.label,
          reason: responseClass.reason,
        })
        return { stop: false, reason: "server_error" }
      }

      case "server_error": {
        key.state.markFailure(now())
        if (nonIdempotent) {
          // Timeout / reset / 5xx: we cannot know whether the tx reached the
          // node. Stop BOTH levels (design.md §11.3).
          observer?.onKeyAttempt?.(this.instance, key.label, "ambiguous")
          logger.warn("sendRaw ambiguous", {
            upstream: this.instance,
            apikey: key.label,
            reason: responseClass.reason,
          })
          return { stop: true, outcome: { kind: "ambiguous" } }
        }
        observer?.onKeyAttempt?.(this.instance, key.label, "server_error")
        logger.warn("upstream failure", {
          upstream: this.instance,
          apikey: key.label,
          reason: responseClass.reason,
        })
        return { stop: false, reason: "server_error" }
      }

      case "client_error":
      case "ok":
        break
    }

    // Classification runs over the items actually SENT (client-side view), so a
    // pre-answered canonical item is not mistaken for a missing envelope, and a
    // mismatch is reported (and regrouped) under the canonical name while the
    // capsig table still sees the provider error verbatim.
    const classified = classifyBody(
      response.text,
      prepared.send.map((outbound) => outbound.item),
      {
        ...(this.options.matchCapability === undefined
          ? {}
          : { matchCapability: this.options.matchCapability }),
        onCapabilityMismatch: (item, cap) => {
          observer?.onCapabilityMismatch?.(this.instance, item.method, cap)
          logger.warn("capability mismatch", {
            upstream: this.instance,
            method: item.method,
            cap,
          })
        },
      },
    )

    if (classified.verdicts.length === 0 || classified.missing.length > 0) {
      // Broken or partial body: not authoritative. READ → next key; sendRaw →
      // ambiguous, because we cannot tell whether the tx was accepted.
      key.state.markFailure(now())
      if (nonIdempotent) {
        observer?.onKeyAttempt?.(this.instance, key.label, "ambiguous")
        logger.warn("sendRaw ambiguous", {
          upstream: this.instance,
          apikey: key.label,
          reason: "unparseable response",
        })
        return { stop: true, outcome: { kind: "ambiguous" } }
      }
      observer?.onKeyAttempt?.(this.instance, key.label, "bad_body")
      return { stop: false, reason: "server_error" }
    }

    key.state.markSuccess()
    this.crossKeyFailures = 0

    const outcome = this.poolOutcome(classified.verdicts, prepared, group.chain)
    observer?.onKeyAttempt?.(this.instance, key.label, outcome.kind)
    logger.debug("upstream attempt", {
      upstream: this.instance,
      apikey: key.label,
      attempt: ctx.attempt,
      items: group.items.length,
      charged: charge,
      outcome: outcome.kind,
    })
    return { stop: true, outcome }
  }

  /**
   * implementation.md §3 `poolOutcome`:
   *   - every item mismatched  → `unsupported` (regroup all, #34)
   *   - some mismatched        → `success` + `unsupportedItems`
   *   - only node answers      → `domain_error` (final, no failover)
   *   - otherwise              → `success`
   *
   * Entries whose canonical params were invalid were answered before the fetch;
   * they are merged back here so the router sees one complete entry set for the
   * items it handed over (implementation.md §2). They are real node-style
   * answers — final domain errors — so they are never regrouped.
   */
  private poolOutcome(
    verdicts: readonly ItemVerdict[],
    prepared: PreparedGroup,
    chain: string,
  ): UpstreamOutcome {
    const unsupported: UnsupportedItem[] = []
    const answered: Entry[] = [...prepared.preAnswered]

    for (const verdict of verdicts) {
      if (verdict.kind === "capability_mismatch") {
        unsupported.push(verdict.item)
        continue
      }
      const entry = verdictToEntry(verdict)
      if (entry === undefined) continue
      answered.push(entry)
    }

    // Success results are translated into the canonical shape here: the raw
    // provider result never leaves the pool for a canonical item. Provider
    // errors inside `entries` are already verbatim and stay untouched (#36).
    const entries = this.mapEntries(answered, prepared.send, chain)

    // Counted AFTER mapping, so a package that cannot map a real answer is
    // classified by what the client actually receives.
    const resultCount = entries.filter((entry) => entry.ok).length
    const errorCount = entries.length - resultCount

    if (unsupported.length > 0 && entries.length === 0) {
      return { kind: "unsupported", items: unsupported }
    }
    if (unsupported.length > 0) {
      return { kind: "success", entries, unsupportedItems: unsupported }
    }
    if (entries.length > 0 && resultCount === 0 && errorCount > 0) {
      return { kind: "domain_error", entries }
    }
    return { kind: "success", entries }
  }

  /** Provider-level sick cooldown, exponential 1s → 60s (design.md §13). */
  private tripProviderSick(): void {
    this.sickLevel += 1
    const backoffMs = Math.min(SICK_CAP_MS, SICK_BASE_MS * 2 ** (this.sickLevel - 1))
    this.sickUntilMs = this.options.deps.now() + backoffMs
    this.crossKeyFailures = 0
    this.options.deps.logger.warn("provider sick", {
      upstream: this.instance,
      cooldownMs: backoffMs,
    })
  }
}

/**
 * Single item → object; batch → array. Ids are passed through untouched.
 *
 * Works from the OUTBOUND view of a group, which is the client's items unless a
 * canonical translation rewrote method/params (`prepare`).
 */
const buildRequests = (items: readonly OutboundItem[]): unknown => {
  const requests = items.map((outbound) => ({
    jsonrpc: "2.0",
    id: outbound.item.id,
    method: outbound.method,
    params: outbound.params,
  }))
  return requests.length === 1 ? requests[0] : requests
}

/** Same body, built straight from a group whose items are all sent as-is. */
export const buildBody = (group: Group): unknown =>
  buildRequests(group.items.map((item) => ({ item, method: item.method, params: item.params })))

export type AdapterHooks = {
  matchCapability?: CapabilityErrorMatcher
  /**
   * Provider default cost table. It is the OUTERMOST layer: an instance's config
   * `costs:` overrides it (design.md §15 "CU asli (override)"), and only then do
   * the global `defaults.costs` apply (design.md §5.3).
   */
  costs?: CostTable
  headers?(token: string): Record<string, string>
  countsBatchAsOne?: boolean
  observer?: PoolObserver
  random?(): number
  /**
   * Canonical-namespace table: the `kiseki_*` methods this provider can serve and
   * how to map them. Absent/empty = no canonical coverage (namespace.ts).
   */
  translations?: readonly MethodTranslation[]
}

/**
 * Build an `UpstreamAdapter` from a pool plus the provider's thin hooks.
 * Provider packages call this; the pool engine itself stays provider-agnostic
 * (design.md §7.3).
 */
export const createPoolAdapter = (
  cfg: UpstreamInstanceConfig,
  deps: CoreDeps,
  hooks: AdapterHooks = {},
): UpstreamAdapter => {
  // design.md §5.3: instance override ?? provider default ?? global default ?? 1.
  const costFor = buildLayeredCostResolver([cfg.costs, hooks.costs, deps.globalCosts])
  const countsBatchAsOne =
    cfg.counts_batch_as_one_request ?? hooks.countsBatchAsOne ?? false
  // A provider hook wins for its own instance; the process-wide seam is the
  // fallback (design.md §18.1: level-2 attempts must be observable).
  const observer = hooks.observer ?? deps.poolObserver

  const pool = new ApikeyPool({
    instance: cfg.name,
    provider: cfg.provider,
    keys: cfg.apikeys.map((key) => ({
      token: key.token,
      label: key.label,
      buckets: key.buckets,
    })),
    url: (token) => cfg.url_template.replaceAll("{apikey}", token),
    costFor,
    ...(hooks.matchCapability === undefined
      ? {}
      : { matchCapability: hooks.matchCapability }),
    countsBatchAsOne,
    ...(hooks.headers === undefined ? {} : { headers: hooks.headers }),
    ...(cfg.timeout_ms === undefined ? {} : { timeoutMs: cfg.timeout_ms }),
    ...(hooks.translations === undefined ? {} : { translations: hooks.translations }),
    deps,
    ...(observer === undefined ? {} : { observer }),
    ...(hooks.random === undefined ? {} : { random: hooks.random }),
  })

  // Canonical coverage is DERIVED, never written in config: a `kiseki_*` method
  // is advertised only when the upstream method behind it is covered by
  // `cfg.methods` (namespace.ts). An instance without translations therefore
  // looks exactly as it did before: `kiseki_*` is uncovered, and pre-flight
  // rejects it with -32601 instead of routing it somewhere it cannot be served.
  const methods = [
    ...cfg.methods,
    ...coveredCanonicalMethods(cfg.methods, hooks.translations ?? []),
  ]

  return {
    name: cfg.name,
    provider: cfg.provider,
    capability: () => ({ methods, archive: cfg.archive }),
    weight: () => pool.weight(),
    earliestReadyAt: () => pool.earliestReadyAt(),
    attempt: (group, ctx) => pool.attempt(group, ctx),
  }
}

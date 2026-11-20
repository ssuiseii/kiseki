/**
 * Prometheus metrics (design.md §18.1) and the observers that feed them.
 *
 * Two design choices worth stating:
 *
 *  1. **The metrics object IS the observer.** Instead of a metrics sink plus an
 *     adapter layer, `Metrics` implements `PipelineObserver` and `PoolObserver`
 *     directly. That keeps the wiring to one line per level (`observer: metrics`)
 *     and means a metric cannot exist without the event that drives it.
 *  2. **Gauges are pulled, counters are pushed.** Counters increment from events;
 *     `kiseki_apikey_credits` and `..._cooldown_seconds_remaining` are read from
 *     the live bucket registry through prom-client's `collect` callback. A gauge
 *     pushed from events would freeze at the last request — exactly wrong for a
 *     refill-over-time quantity (§5.2).
 *
 * Labels are `label`/`client_label`, never a token (§18.2).
 */

import { Counter, Gauge, Histogram, Registry } from "prom-client"
import type { BucketRegistry, PoolObserver } from "upstream-core"
import type { PipelineObserver } from "../pipeline"

export type MetricsOptions = {
  /** Per-process registry; omit for a fresh one (tests always pass their own). */
  registry?: Registry
  /**
   * Live bucket state for the two gauges. A thunk because the registry is created
   * *by* the runtime, while the metrics object has to exist before the runtime is
   * built (the runtime needs the observer). Without it the gauges stay empty.
   */
  bucketRegistry?: BucketRegistry | (() => BucketRegistry | undefined)
  /**
   * `provider + token` → apikey label. Supplied by the composition root, which is
   * the only place that knows both (§18.1 labels the gauge by `apikey(label)`).
   * Unknown identities fall back to a non-reversible hash, never the token.
   */
  keyLabels?: ReadonlyMap<string, string>
  now?(): number
}

export type Metrics = {
  registry: Registry
  /** Serialise for `GET /metrics`. */
  render(): Promise<string>
  contentType: string
  /** `PipelineObserver` + `PoolObserver` in one object. */
  observer: PipelineObserver & PoolObserver
  /** Record one client request before its body is parsed (§18.1 row 1). */
  countRequest(chain: string, methodClass: string, clientLabel: string): void
  countBatchItems(chain: string, clientLabel: string, count: number): void
}

/** Identity key, mirroring `upstream-core`'s `identityKey` (never a token). */
export const metricKeyId = (provider: string, token: string): string =>
  `${provider.length}:${provider}:${token.length}:${token}`

/**
 * Stable, non-reversible discriminator for an identity with no known label.
 * FNV-1a over `provider\0token`: enough for a handful of keys, impossible to
 * invert, and stable across restarts (unlike insertion order).
 */
const hashLabel = (provider: string, token: string): string => {
  let hash = 0x811c9dc5
  const input = `${provider}\u0000${token}`
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `k${hash.toString(16).padStart(8, "0")}`
}

const defineMetrics = (registry: Registry) => ({
  requestsTotal: new Counter({
    name: "kiseki_requests_total",
    help: "JSON-RPC requests handled, by chain, method class and client label",
    labelNames: ["chain", "method_class", "client_label"] as const,
    registers: [registry],
  }),
  batchItemsTotal: new Counter({
    name: "kiseki_batch_items_total",
    help: "JSON-RPC items processed inside batch requests",
    labelNames: ["chain", "client_label"] as const,
    registers: [registry],
  }),
  upstreamAttemptsTotal: new Counter({
    name: "kiseki_upstream_attempts_total",
    help: "Level-1 attempts per upstream instance, by outcome kind",
    labelNames: ["upstream", "outcome"] as const,
    registers: [registry],
  }),
  poolKeyAttemptsTotal: new Counter({
    name: "kiseki_pool_key_attempts_total",
    help: "Level-2 attempts per upstream apikey label, by outcome",
    labelNames: ["upstream", "apikey", "outcome"] as const,
    registers: [registry],
  }),
  poolKeyFailoverTotal: new Counter({
    name: "kiseki_pool_key_failover_total",
    help: "Key failovers inside a pool (invisible to the router, §10.2)",
    labelNames: ["upstream"] as const,
    registers: [registry],
  }),
  upstreamLatencySeconds: new Histogram({
    name: "kiseki_upstream_latency_seconds",
    help: "Latency of one upstream HTTP attempt",
    labelNames: ["upstream"] as const,
    // 10ms … 120s, matching the timeout classes of design.md §14.
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers: [registry],
  }),
  preflightRejectsTotal: new Counter({
    name: "kiseki_preflight_rejects_total",
    help: "Items rejected before any attempt (capability miss or policy block)",
    labelNames: ["chain", "reason"] as const,
    registers: [registry],
  }),
  capabilityRegroupsTotal: new Counter({
    name: "kiseki_capability_regroups_total",
    help: "Runtime capability mismatches that triggered a regroup",
    labelNames: ["chain", "cap"] as const,
    registers: [registry],
  }),
  failfastTotal: new Counter({
    name: "kiseki_failfast_total",
    help: "Fail-fast endings (capacity or health), by method class",
    labelNames: ["chain", "method_class"] as const,
    registers: [registry],
  }),
  sendrawAmbiguousTotal: new Counter({
    name: "kiseki_sendraw_ambiguous_total",
    help: "eth_sendRawTransaction broadcasts with unknown state",
    labelNames: ["upstream"] as const,
    registers: [registry],
  }),
})

export const createMetrics = (options: MetricsOptions = {}): Metrics => {
  const registry = options.registry ?? new Registry()
  const bucketSource = options.bucketRegistry
  const bucketRegistry = (): BucketRegistry | undefined =>
    typeof bucketSource === "function" ? bucketSource() : bucketSource
  const keyLabels = options.keyLabels ?? new Map<string, string>()
  const now = options.now ?? (() => Date.now())
  const counters = defineMetrics(registry)

  const apikeyLabel = (provider: string, token: string): string =>
    keyLabels.get(metricKeyId(provider, token)) ?? hashLabel(provider, token)

  // Pulled gauges: one sample per (provider, apikey label, bucket index), so a
  // scrape always shows live credits rather than the last request's snapshot.
  {
    new Gauge({
      name: "kiseki_apikey_credits",
      help: "Remaining credits per apikey bucket (live, lazily refilled)",
      labelNames: ["provider", "apikey", "bucket_index"] as const,
      registers: [registry],
      collect() {
        this.reset()
        const nowMs = now()
        for (const state of bucketRegistry()?.all() ?? []) {
          const apikey = apikeyLabel(state.provider, state.token)
          state.credits(nowMs).forEach((credits, index) => {
            this.set({ provider: state.provider, apikey, bucket_index: String(index) }, credits)
          })
        }
      },
    })

    new Gauge({
      name: "kiseki_apikey_cooldown_seconds_remaining",
      help: "Seconds until an apikey may be used again (0 when ready)",
      labelNames: ["provider", "apikey"] as const,
      registers: [registry],
      collect() {
        this.reset()
        const nowMs = now()
        for (const state of bucketRegistry()?.all() ?? []) {
          this.set(
            {
              provider: state.provider,
              apikey: apikeyLabel(state.provider, state.token),
            },
            state.cooldownRemainingMs(nowMs) / 1000,
          )
        }
      },
    })
  }

  const observer: PipelineObserver & PoolObserver = {
    // Level 1 (§18.1 rows 3, 9, 10, 12).
    onAttempt: (upstream, outcome) => {
      counters.upstreamAttemptsTotal.inc({ upstream, outcome })
    },
    onRegroup: (event) => {
      counters.capabilityRegroupsTotal.inc({ chain: event.chain, cap: event.cap })
    },
    onFailFast: (chain, _reason, methodClass) => {
      // §18.1 labels this by method_class, which the router carries through; the
      // fail-fast *reason* is already visible on upstream_attempts_total.
      counters.failfastTotal.inc({ chain, method_class: methodClass })
    },
    onAmbiguous: (upstream) => {
      counters.sendrawAmbiguousTotal.inc({ upstream })
    },
    onPreflightReject: (chain, reason) => {
      counters.preflightRejectsTotal.inc({ chain, reason })
    },

    // Level 2 (§18.1 rows 4, 5, 8).
    onKeyAttempt: (upstream, label, outcome) => {
      counters.poolKeyAttemptsTotal.inc({ upstream, apikey: label, outcome })
    },
    onKeyFailover: (upstream) => {
      counters.poolKeyFailoverTotal.inc({ upstream })
    },
    onLatency: (upstream, latencyMs) => {
      counters.upstreamLatencySeconds.observe({ upstream }, latencyMs / 1000)
    },
  }

  return {
    registry,
    contentType: registry.contentType,
    render: () => registry.metrics(),
    observer,
    countRequest: (chain, methodClass, clientLabel) => {
      counters.requestsTotal.inc({ chain, method_class: methodClass, client_label: clientLabel })
    },
    countBatchItems: (chain, clientLabel, count) => {
      if (count > 0) counters.batchItemsTotal.inc({ chain, client_label: clientLabel }, count)
    },
  }
}

/**
 * Config reload (SIGHUP) — design.md §19, implementation.md §7.
 *
 * The §19 table is the specification, and every row is an explicit decision here:
 *
 * | State                      | Across a reload                         |
 * |----------------------------|-----------------------------------------|
 * | Parsed config              | replaced (that is the point)            |
 * | Bucket registry (identity) | KEPT — same identity, same credits      |
 * | Cooldowns (identity-keyed) | KEPT — they live on the same object     |
 * | Runtime capability notes   | RESET (§19, explicit)                   |
 * | Metrics                    | KEPT — same registry, same counters     |
 * | Removed apikeys            | buckets dropped (`retain`)              |
 *
 * Reusing unchanged adapters follows from the same reasoning: a pool caches its
 * key list and its provider-level sick cooldown, so rebuilding every adapter on
 * every reload would silently reset §13 health. An instance whose config is
 * unchanged is carried over instead.
 *
 * Failure policy: a reload that fails validation leaves the RUNNING config in
 * place. A typo must never take a working proxy down — that is the whole point of
 * reload over restart.
 */

import type { AdapterRegistry, Logger, PoolObserver, UpstreamAdapter } from "upstream-core"
import {
  buildModel,
  formatSharedIdentity,
  loadConfigFile,
  type LoadedConfig,
} from "./config/index"
import type { PipelineObserver } from "./pipeline"
import { createRuntime, retainIdentities, type Runtime } from "./runtime"

export type ReloadOptions = {
  configPath: string
  env?: Record<string, string | undefined>
  registry: AdapterRegistry
  logger: Logger
  now(): number
  /** The runtime currently serving traffic. */
  current: Runtime
  fetchImpl?: typeof fetch
  random?(): number
  /**
   * Carried across reloads so counters and gauges survive (§19 "Metrics: ya").
   * Both levels: `observer` sees level-1 events, `poolObserver` level-2.
   */
  observer?: PipelineObserver
  poolObserver?: PoolObserver
}

export type ReloadResult =
  | {
      ok: true
      runtime: Runtime
      /** Chains added/removed by this reload, for the log line. */
      added: string[]
      removed: string[]
      /** Instances whose adapter was rebuilt because their config changed. */
      rebuilt: string[]
      /** Instances whose adapter object was carried over untouched. */
      kept: string[]
    }
  | { ok: false; error: Error }

/** One instance's config, as the fingerprint needs it. */
type InstanceConfig = Parameters<typeof instanceFingerprint>[0]

/**
 * Stable identity of one instance's configuration. Two configs with the same
 * fingerprint describe the same upstream, so its adapter can be carried over.
 *
 * Includes everything that shapes the pool: URL, keys (token AND buckets, because
 * a bucket-spec change must be re-read), capability, costs, batch accounting and
 * the timeout override. Deliberately NOT included: anything that does not reach
 * the adapter (e.g. `defaults.*`, which is applied through `CoreDeps`).
 */
export const instanceFingerprint = (upstream: {
  name: string
  provider: string
  package: string
  url_template: string
  methods: readonly string[]
  archive: boolean
  costs?: Record<string, number>
  counts_batch_as_one_request?: boolean
  timeout_ms?: number
  apikeys: readonly {
    token: string
    label: string
    buckets: readonly { capacity: number; refill_per_second: number }[]
  }[]
}): string =>
  JSON.stringify([
    upstream.name,
    upstream.provider,
    upstream.package,
    upstream.url_template,
    upstream.methods,
    upstream.archive,
    upstream.costs ?? null,
    upstream.counts_batch_as_one_request ?? null,
    upstream.timeout_ms ?? null,
    upstream.apikeys.map((key) => [
      key.token,
      key.label,
      key.buckets.map((bucket) => [bucket.capacity, bucket.refill_per_second]),
    ]),
  ])

/** Fingerprints of every instance in a config, keyed by instance name. */
export const configFingerprints = (config: {
  chains: Record<string, { upstreams: readonly InstanceConfig[] }>
}): Map<string, string> => {
  const map = new Map<string, string>()
  for (const chain of Object.values(config.chains)) {
    for (const upstream of chain.upstreams) {
      map.set(upstream.name, instanceFingerprint(upstream))
    }
  }
  return map
}

/** Adapters of the current runtime, by instance name. */
const adaptersByName = (runtime: Runtime): Map<string, UpstreamAdapter> => {
  const map = new Map<string, UpstreamAdapter>()
  for (const chain of runtime.chains) {
    for (const view of runtime.chainRuntime(chain)?.upstreams ?? []) {
      map.set(view.name, view.adapter)
    }
  }
  return map
}

/**
 * Reload the config behind an already-running runtime.
 *
 * Returns a NEW runtime; the caller swaps it in. Every failure is returned rather
 * than thrown so the old runtime keeps serving (§19 failure policy).
 */
export const reloadRuntime = (options: ReloadOptions): ReloadResult => {
  const { current, logger } = options

  let loaded: LoadedConfig
  try {
    loaded = loadConfigFile(options.configPath, {
      registry: options.registry,
      ...(options.env === undefined ? {} : { env: options.env }),
    })
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    logger.error("config reload failed, keeping the running config", {
      path: options.configPath,
      error: failure.message,
    })
    return { ok: false, error: failure }
  }

  const before = configFingerprints(current.config)
  const after = configFingerprints(loaded.config)

  const added = [...after.keys()].filter((name) => !before.has(name))
  const removed = [...before.keys()].filter((name) => !after.has(name))

  // Carry over every adapter whose instance config is unchanged. Anything else is
  // rebuilt from the new config by `buildModel`.
  const previous = adaptersByName(current)
  const reusable = new Map<string, UpstreamAdapter>()
  for (const [name, fingerprint] of after) {
    if (before.get(name) !== fingerprint) continue
    const adapter = previous.get(name)
    if (adapter !== undefined) reusable.set(name, adapter)
  }

  // A shared registry is what preserves credits and cooldowns (§19 rows 2–3).
  const runtime = createRuntime({
    loaded,
    registry: options.registry,
    logger,
    now: options.now,
    bucketRegistry: current.bucketRegistry,
    reuseAdapters: reusable,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.poolObserver === undefined ? {} : { poolObserver: options.poolObserver }),
  })

  // Removed apikeys lose their buckets; surviving identities keep theirs.
  retainIdentities(runtime, loaded.config)

  const rebuilt = [...after.keys()].filter((name) => !reusable.has(name))
  const kept = [...reusable.keys()]

  logger.info("config reloaded", {
    chains: runtime.chains,
    added,
    removed,
    rebuilt,
    kept,
    warnings: loaded.warnings.length,
  })

  // A reload is a fresh start for everything the operator reads: re-emit the
  // warnings (rule 6) and the shared-identity lines (rule 8), because the set of
  // chains may have changed since the last time they were printed.
  for (const warning of loaded.warnings) logger.warn(warning)
  for (const identity of loaded.shared) logger.info(formatSharedIdentity(identity))

  return { ok: true, runtime, added, removed, rebuilt, kept }
}

export type { buildModel }

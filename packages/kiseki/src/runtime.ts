/**
 * Config → runtime wiring (the gap the Milestone 2 hand-off flagged).
 *
 * Milestone 2 built adapters but nothing connected `defaults.*` to the routing
 * layer, so `Group.timeoutMs` had no source and `defaults.costs` had no path to
 * the pool. Both belong here, in one place, because they are the same kind of
 * decision: *which config value becomes which runtime value*.
 *
 *   defaults.timeouts   → TimeoutPolicy → classifier → Group.timeoutMs (§14)
 *   defaults.costs      → CoreDeps.globalCosts → pool cost resolver (§5.3)
 *   defaults.blocked    → PipelineDeps.blockedMethods → classifier (§9.2)
 *   limits.max_total    → RouterDeps.maxTotalAttempts (§6.3)
 *
 * An instance's own `timeout_ms` still wins over the group value, inside the pool
 * (design.md §14 "override per instance menang") — this module deliberately does
 * not pre-resolve that, so the precedence stays in one place.
 *
 * Kept out of `config/`: the config package knows nothing about routing, and the
 * router knows nothing about YAML. This module is the only one that knows both.
 */

import {
  BucketRegistry,
  RuntimeNotes,
  type CoreDeps,
  type Logger,
  type UpstreamAdapter,
} from "upstream-core"
import type { AdapterRegistry } from "upstream-core"
import { toView, type UpstreamView } from "./capability"
import { buildTimeoutPolicy, type TimeoutPolicy } from "./classify"
import { buildModel, type KisekiConfig, type LoadedConfig } from "./config/index"
import type { PipelineDeps, PipelineObserver } from "./pipeline"

export type RuntimeOptions = {
  loaded: LoadedConfig
  /** Composition root (#37). */
  registry: AdapterRegistry
  logger: Logger
  now(): number
  fetchImpl?: typeof fetch
  random?(): number
  observer?: PipelineObserver
  /**
   * Shared with a previous runtime so a reload keeps live credits and cooldowns
   * (design.md §19). Omit on first start.
   */
  bucketRegistry?: BucketRegistry
  /**
   * Pass the previous instance to keep notes? No: design.md §19 says runtime
   * capability notes are RESET on reload. This parameter exists so a test can
   * inspect the fresh set, not so production can preserve it.
   */
  notes?: RuntimeNotes
}

export type ChainRuntime = {
  chain: string
  /** Upstream views in config order, for observability and diagnostics. */
  upstreams: readonly UpstreamView[]
  adapters: readonly UpstreamAdapter[]
}

export type Runtime = {
  config: KisekiConfig
  bucketRegistry: BucketRegistry
  notes: RuntimeNotes
  chains: string[]
  /** Everything `handle()` needs for one chain, or undefined if unknown. */
  pipelineFor(chain: string): PipelineDeps | undefined
  chainRuntime(chain: string): ChainRuntime | undefined
  /** Warnings that must not block startup (§15.1 rule 6). */
  warnings: string[]
}

/**
 * Build the whole runtime: adapters (with global costs), the per-chain views, and
 * the per-chain pipeline dependencies.
 */
export const createRuntime = (options: RuntimeOptions): Runtime => {
  const { loaded, registry, logger, now } = options
  const config = loaded.config

  const bucketRegistry = options.bucketRegistry ?? new BucketRegistry(now)
  // Notes are per instance and reset on reload (§19), so a fresh runtime gets a
  // fresh set unless a caller explicitly passes one.
  const notes = options.notes ?? new RuntimeNotes()

  const deps: CoreDeps = {
    bucketRegistry,
    logger,
    now,
    // The middle layer of design.md §5.3. Without this, `defaults.costs` would be
    // accepted by the schema and silently ignored — exactly the dead-config class
    // of bug the strict schema is meant to prevent.
    globalCosts: config.defaults.costs,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }

  const model = buildModel(loaded, deps, registry)
  const timeouts: TimeoutPolicy = buildTimeoutPolicy(config.defaults.timeouts)

  const views = new Map<string, ChainRuntime>()
  for (const [chain, upstreams] of model.upstreams) {
    views.set(chain, {
      chain,
      upstreams: upstreams.map((upstream) => toView(upstream)),
      adapters: upstreams.map((upstream) => upstream.adapter),
    })
  }

  const pipelineFor = (chain: string): PipelineDeps | undefined => {
    const chainRuntime = views.get(chain)
    if (chainRuntime === undefined) return undefined
    return {
      chain,
      upstreams: chainRuntime.upstreams,
      notes,
      logger,
      now,
      timeouts,
      blockedMethods: config.defaults.blocked_methods,
      maxTotalAttempts: config.limits.max_total_attempts,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    }
  }

  return {
    config,
    bucketRegistry,
    notes,
    chains: [...views.keys()],
    pipelineFor,
    chainRuntime: (chain) => views.get(chain),
    warnings: loaded.warnings,
  }
}

/**
 * Drop bucket identities the new config no longer references (design.md §19:
 * "apikey yang dihapus dari config → bucket-nya dibuang"). Called after a reload
 * has built the new model.
 */
export const retainIdentities = (runtime: Runtime, config: KisekiConfig): void => {
  const identities: { provider: string; token: string }[] = []
  for (const chainConfig of Object.values(config.chains)) {
    for (const upstream of chainConfig.upstreams) {
      for (const key of upstream.apikeys) {
        identities.push({ provider: upstream.provider, token: key.token })
      }
    }
  }
  runtime.bucketRegistry.retain(identities)
}

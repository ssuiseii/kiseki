/**
 * The router↔upstream contract (design.md §7.1, implementation.md §2).
 *
 * The router only ever sees: capability, a scalar weight, an earliest-ready
 * estimate, and a structured outcome. URL, apikey selection, headers and error
 * parsing are internal to the package.
 */

import type { BucketRegistry } from "./bucket"
import type { CostTable } from "./cost"
// Type-only, so the adapter↔pool cycle is erased at build time.
import type { PoolObserver } from "./pool"
import type { AttemptCtx, Group } from "./types/group"
import type { Logger } from "./types/logger"
import type { UpstreamOutcome } from "./types/outcome"

export type Capability = {
  /** Method patterns. `*` is allowed as a trailing wildcard only (§8.1). */
  methods: string[]
  archive: boolean
}

export type CoreDeps = {
  bucketRegistry: BucketRegistry
  logger: Logger
  now(): number
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * `defaults.costs` — the middle layer of design.md §5.3. The composition root
   * fills this once per process; a provider package may pass its own table as
   * the outer layer, and an instance's config `costs:` always wins over both.
   */
  globalCosts?: CostTable
  /**
   * Level-2 observability seam (design.md §18.1). The pool lives inside a
   * provider package, so the router cannot wire `PoolObserver` per instance; the
   * composition root supplies it once here and every adapter built from config
   * reports key-level attempts through it. Additive and optional: a provider that
   * passes its own `hooks.observer` still wins for that instance.
   */
  poolObserver?: PoolObserver
}

export interface UpstreamAdapter {
  /** Instance name from config (unique globally, design.md §15.1 rule 3). */
  readonly name: string
  /** Provider identity — part of the bucket keying (§5.4). */
  readonly provider: string

  capability(): Capability
  /** Σ headroom over all apikeys (§6.2). 0 means "no capacity right now". */
  weight(): number
  /** Epoch ms when the first apikey could serve again; for Retry-After (§12.2). */
  earliestReadyAt(): number
  attempt(group: Group, ctx: AttemptCtx): Promise<UpstreamOutcome>
}

/** One apikey entry as it appears in config (§15). */
export type ApiKeyConfig = {
  token: string
  label: string
  buckets: { capacity: number; refill_per_second: number }[]
}

/** One upstream instance as it appears in config (§15). */
export type UpstreamInstanceConfig = {
  name: string
  provider: string
  package: string
  url_template: string
  apikeys: ApiKeyConfig[]
  methods: string[]
  archive: boolean
  costs?: Record<string, number>
  counts_batch_as_one_request?: boolean
  /** Per-instance timeout override (design.md §14: "override per instance menang"). */
  timeout_ms?: number
}

/**
 * What a provider package exports. The composition root (decision #37) maps the
 * config's `package:` value to one of these; nothing else imports providers.
 */
export type AdapterFactory = (
  cfg: UpstreamInstanceConfig,
  deps: CoreDeps,
) => UpstreamAdapter

/**
 * Everything a provider package may customize lives in `AdapterHooks` (`pool.ts`),
 * next to the engine that consumes it — this file used to carry a parallel
 * `ProviderHooks` type with drifting field names, which nothing read. One hook
 * type, one definition, no drift.
 */

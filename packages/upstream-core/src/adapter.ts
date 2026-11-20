/**
 * The router↔upstream contract (design.md §7.1, implementation.md §2).
 *
 * The router only ever sees: capability, a scalar weight, an earliest-ready
 * estimate, and a structured outcome. URL, apikey selection, headers and error
 * parsing are internal to the package.
 */

import type { BucketRegistry } from "./bucket"
import type { CapabilityErrorMatcher } from "./capsig"
import type { CostTable } from "./cost"
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

/** Everything a provider package may need to customize. */
export type ProviderHooks = {
  /** Provider error signature, on top of the generic fallback (§8.3). */
  matchCapabilityError?: CapabilityErrorMatcher
  /** Cost override table: provider-specific units (§5.3). */
  costs?: Record<string, number>
  /** Headers added to every request (provider quirks). */
  headers?: (token: string) => Record<string, string>
  /** Providers that bill per HTTP call rather than per item (§5.5 rule 2). */
  countsBatchAsOne?: boolean
  /** Default per-instance timeout, overridable by config. */
  defaultTimeoutMs?: number
}

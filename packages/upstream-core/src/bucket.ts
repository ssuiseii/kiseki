/**
 * Token buckets and the identity-keyed registry that owns them.
 *
 * design.md §5: one apikey = one set of buckets, keyed by `(provider, token)`
 * and SHARED across every chain instance that references the same token
 * (decision #24). Refill is continuous and lazy — computed on read, no timers
 * (design.md §5.2).
 *
 * The registry also owns per-identity health (cooldown), because a 429 on a key
 * is a property of the key, not of the chain instance that happened to see it
 * (design.md §19: cooldown per apikey is identity-keyed).
 */

export type BucketSpec = {
  capacity: number
  /** Credits regained per second. Must be > 0 (design.md §15.1 rule 2). */
  refill_per_second: number
}

export type Bucket = {
  capacity: number
  refillPerSecond: number
  /** Credits as of `lastRefillMs`; may go negative after an over-deduction. */
  credits: number
  lastRefillMs: number
}

/**
 * Why a key is cooling down. The last writer explains the running cooldown: a
 * `cooldownUntilMs` only ever grows, so the label always describes the longest
 * cooldown in effect (see `markFailure` / `markRateLimited`).
 */
export type CooldownReason = "misconfigured" | "unhealthy" | "rate_limited"

export type KeyHealth = {
  /** Epoch ms until which this key must not be used. */
  cooldownUntilMs: number
  /** Consecutive 5xx/timeout failures, drives exponential cooldown (§13). */
  consecutiveFailures: number
  /** Reason for the cooldown in effect; undefined when the key is not cooling down. */
  cooldownReason?: CooldownReason
  /** HTTP status of the last rejection when `cooldownReason` is `misconfigured`. */
  misconfiguredStatus?: number
}

/**
 * Identity key for `(provider, token)`.
 *
 * Length-prefixed rather than separator-joined: a token containing the separator
 * could otherwise collide with a different `(provider, token)` split (e.g.
 * provider `a`, token `b\0c` vs provider `a\0b`, token `c`).
 */
export const identityKey = (provider: string, token: string): string =>
  `${provider.length}:${provider}:${token.length}:${token}`

const refillInto = (bucket: Bucket, nowMs: number): void => {
  if (nowMs <= bucket.lastRefillMs) return
  const elapsedSeconds = (nowMs - bucket.lastRefillMs) / 1000
  bucket.credits = Math.min(
    bucket.capacity,
    bucket.credits + elapsedSeconds * bucket.refillPerSecond,
  )
  bucket.lastRefillMs = nowMs
}

/**
 * One apikey's live quota + health state. Shared by every chain instance that
 * references the identity, so `deduct` is visible everywhere at once.
 */
export class ApiKeyState {
  readonly provider: string
  readonly token: string
  readonly buckets: Bucket[]
  readonly health: KeyHealth

  constructor(
    provider: string,
    token: string,
    specs: readonly BucketSpec[],
    nowMs: number,
    health?: KeyHealth,
  ) {
    this.provider = provider
    this.token = token
    this.buckets = specs.map((spec) => ({
      capacity: spec.capacity,
      refillPerSecond: spec.refill_per_second,
      credits: spec.capacity, // restart = full bucket (design.md §5.6)
      lastRefillMs: nowMs,
    }))
    this.health = health ?? { cooldownUntilMs: 0, consecutiveFailures: 0 }
  }

  /** Current credits of every bucket, refilled lazily up to `nowMs`. */
  credits(nowMs: number): number[] {
    for (const bucket of this.buckets) refillInto(bucket, nowMs)
    return this.buckets.map((bucket) => bucket.credits)
  }

  /**
   * design.md §6.2: `headroom = min over buckets(credits / capacity)`, in [0,1].
   * A key with no buckets configured is treated as unconstrained (headroom 1).
   */
  headroom(nowMs: number): number {
    if (this.buckets.length === 0) return 1
    let min = 1
    for (const bucket of this.buckets) {
      refillInto(bucket, nowMs)
      const fraction = bucket.capacity > 0 ? bucket.credits / bucket.capacity : 0
      if (fraction < min) min = fraction
    }
    return min < 0 ? 0 : min
  }

  cooldownRemainingMs(nowMs: number): number {
    return Math.max(0, this.health.cooldownUntilMs - nowMs)
  }

  /**
   * The reason the key is cooling down right now, or undefined when it is ready.
   *
   * A stale label without a cooldown is ignored on purpose: the cooldown is the
   * condition, the label only names it.
   */
  activeCooldownReason(nowMs: number): CooldownReason | undefined {
    if (this.cooldownRemainingMs(nowMs) <= 0) return undefined
    return this.health.cooldownReason
  }

  /** HTTP status of the last config-style rejection, while that reason is active. */
  misconfiguredHttpStatus(nowMs: number): number | undefined {
    if (this.activeCooldownReason(nowMs) !== "misconfigured") return undefined
    return this.health.misconfiguredStatus
  }

  /** Can this key serve `cost` right now? All buckets must afford it (§5.5 rule 5). */
  canAfford(cost: number, nowMs: number): boolean {
    if (this.cooldownRemainingMs(nowMs) > 0) return false
    for (const bucket of this.buckets) {
      refillInto(bucket, nowMs)
      if (bucket.credits < cost) return false
    }
    return true
  }

  /**
   * Deduct `cost` from EVERY bucket, synchronously, before the fetch
   * (design.md §5.5 rules 1 & 3). No refund, ever (rule 4).
   */
  deduct(cost: number, nowMs: number): void {
    for (const bucket of this.buckets) {
      refillInto(bucket, nowMs)
      bucket.credits -= cost
    }
  }

  /**
   * Epoch ms at which this key could serve `cost` again (design.md §12.2):
   * `now + max( max_b((cost - credits_b) / refill_b), cooldownRemaining )`.
   * Infinity when a bucket can never afford the cost (cost > capacity).
   */
  readyAtMs(cost: number, nowMs: number): number {
    let waitMs = this.cooldownRemainingMs(nowMs)
    for (const bucket of this.buckets) {
      refillInto(bucket, nowMs)
      const deficit = cost - bucket.credits
      if (deficit <= 0) continue
      // A bucket can never exceed its capacity, so a cost above capacity is
      // unreachable no matter how long we wait.
      if (bucket.refillPerSecond <= 0 || cost > bucket.capacity) {
        return Number.POSITIVE_INFINITY
      }
      const bucketWaitMs = (deficit / bucket.refillPerSecond) * 1000
      if (bucketWaitMs > waitMs) waitMs = bucketWaitMs
    }
    return nowMs + waitMs
  }

  /** Success resets the failure streak (design.md §13). */
  markSuccess(): void {
    this.health.consecutiveFailures = 0
    // A key that just served is no longer a problem key, so its cooldown label
    // and status must not outlive the streak that produced them.
    delete this.health.cooldownReason
    delete this.health.misconfiguredStatus
  }

  /**
   * 429: the key hit its limit. Drain every bucket to zero and park the key
   * until refill (design.md §11.2) — this is a limit, not sickness, so the
   * cooldown is not exponential.
   */
  markRateLimited(nowMs: number, retryAtMs?: number): void {
    for (const bucket of this.buckets) {
      refillInto(bucket, nowMs)
      bucket.credits = 0
    }
    const estimate = this.readyAtMs(1, nowMs)
    const until = retryAtMs !== undefined && retryAtMs > nowMs ? retryAtMs : estimate
    this.health.cooldownUntilMs = Math.max(this.health.cooldownUntilMs, until)
    // A 429 is a statement about the limit, not about the configuration, so it
    // relabels the cooldown it extends.
    this.health.cooldownReason = "rate_limited"
    delete this.health.misconfiguredStatus
  }

  /**
   * 5xx / timeout / connection failure: exponential key cooldown
   * `1s → 2s → … cap 60s` (design.md §13).
   *
   * `misconfigured` uses the same ladder but names a different cause: the key
   * (or the URL it was called with) was rejected, which is a configuration
   * problem rather than a health problem. `status` is the HTTP status of that
   * rejection, kept so the router can report it to the client.
   */
  markFailure(
    nowMs: number,
    reason: "unhealthy" | "misconfigured" = "unhealthy",
    status?: number,
  ): void {
    this.health.consecutiveFailures += 1
    const backoffMs = Math.min(
      60_000,
      1000 * 2 ** (this.health.consecutiveFailures - 1),
    )
    this.health.cooldownUntilMs = Math.max(
      this.health.cooldownUntilMs,
      nowMs + backoffMs,
    )
    this.health.cooldownReason = reason
    if (reason === "misconfigured" && status !== undefined) {
      this.health.misconfiguredStatus = status
    } else {
      delete this.health.misconfiguredStatus
    }
  }

  /**
   * Drop a `misconfigured` diagnosis and its cooldown, leaving every other
   * reason untouched.
   *
   * Called from the reload path: a rejection for configuration reasons is most
   * likely fixed by the config change itself, so keeping the old cooldown would
   * hold a now-correct instance back for up to a minute. Health and capacity
   * cooldowns are still true after a config edit, so they stay.
   */
  clearMisconfigured(): boolean {
    if (this.health.cooldownReason !== "misconfigured") return false
    this.health.cooldownUntilMs = 0
    this.health.consecutiveFailures = 0
    delete this.health.cooldownReason
    delete this.health.misconfiguredStatus
    return true
  }
}

/**
 * Identity-keyed store of `ApiKeyState`. One object per `(provider, token)` for
 * the whole process (design.md §5.4).
 */
export class BucketRegistry {
  private readonly states = new Map<string, ApiKeyState>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  /**
   * Fetch-or-create the shared state for `(provider, token)`.
   *
   * On config reload the same identity keeps its credits and health. If the
   * bucket spec changed, capacity/refill are updated in place and credits are
   * clamped to the new capacity; if the NUMBER of buckets changed, buckets are
   * rebuilt (credits reset to capacity) because the dimensions no longer line up.
   */
  get(
    provider: string,
    token: string,
    specs: readonly BucketSpec[],
  ): ApiKeyState {
    const key = identityKey(provider, token)
    const existing = this.states.get(key)
    if (existing === undefined) {
      const created = new ApiKeyState(provider, token, specs, this.now())
      this.states.set(key, created)
      return created
    }

    if (existing.buckets.length !== specs.length) {
      const rebuilt = new ApiKeyState(
        provider,
        token,
        specs,
        this.now(),
        existing.health,
      )
      this.states.set(key, rebuilt)
      return rebuilt
    }

    const nowMs = this.now()
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i]!
      const bucket = existing.buckets[i]!
      refillInto(bucket, nowMs)
      bucket.capacity = spec.capacity
      bucket.refillPerSecond = spec.refill_per_second
      if (bucket.credits > bucket.capacity) bucket.credits = bucket.capacity
    }
    return existing
  }

  /**
   * Read-only lookup. Unlike `get`, this never creates or rebuilds anything, so
   * a caller that only wants to inspect state cannot accidentally reset buckets
   * by passing a different spec.
   */
  peek(provider: string, token: string): ApiKeyState | undefined {
    return this.states.get(identityKey(provider, token))
  }

  /**
   * Drop identities no longer referenced by the config (design.md §19:
   * "apikey yang dihapus dari config → bucket-nya dibuang").
   */
  retain(identities: Iterable<{ provider: string; token: string }>): void {
    const keep = new Set<string>()
    for (const identity of identities) {
      keep.add(identityKey(identity.provider, identity.token))
    }
    for (const key of [...this.states.keys()]) {
      if (!keep.has(key)) this.states.delete(key)
    }
  }

  /**
   * Drop the `misconfigured` diagnosis of every identity in `identities`.
   *
   * The reload path calls this for the identities used by instances whose config
   * changed: a rejection for configuration reasons is most likely fixed by that
   * very change, so the stale cooldown must not keep holding the instance back.
   * Identities with a health or capacity cooldown are left alone.
   *
   * Returns the identities that were actually cleared, for the reload log line.
   */
  clearMisconfigured(identities: Iterable<{ provider: string; token: string }>): number {
    let cleared = 0
    for (const identity of identities) {
      const state = this.states.get(identityKey(identity.provider, identity.token))
      if (state === undefined) continue
      if (state.clearMisconfigured()) cleared += 1
    }
    return cleared
  }

  /** Snapshot for metrics / debugging. Never exposes tokens beyond their identity. */
  all(): ApiKeyState[] {
    return [...this.states.values()]
  }

  get size(): number {
    return this.states.size
  }
}

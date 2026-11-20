import { describe, expect, test } from "bun:test"
import { ApiKeyState, BucketRegistry, identityKey } from "../src/bucket"

const specs = [{ capacity: 100, refill_per_second: 10 }]

describe("bucket lazy refill", () => {
  test("starts full at capacity (design.md §5.6)", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    expect(state.credits(0)).toEqual([100])
  })

  test("credits = min(capacity, credits + elapsed × refill)", () => {
    let now = 0
    const state = new ApiKeyState("alchemy", "tok", specs, now)
    state.deduct(100, now)
    expect(state.credits(0)).toEqual([0])

    now = 5_000 // 5s × 10/s = 50 credits
    expect(state.credits(now)).toEqual([50])

    now = 20_000 // would be 200, clamped to capacity
    expect(state.credits(now)).toEqual([100])
  })

  test("refill is lazy and idempotent across reads", () => {
    let now = 0
    const state = new ApiKeyState("alchemy", "tok", specs, now)
    state.deduct(100, now)
    now = 2_000
    expect(state.credits(now)).toEqual([20])
    expect(state.credits(now)).toEqual([20])
    expect(state.credits(now)).toEqual([20])
  })

  test("deduct applies to every bucket simultaneously (§5.5 rule 3)", () => {
    const state = new ApiKeyState(
      "ankr",
      "tok",
      [
        { capacity: 15, refill_per_second: 15 },
        { capacity: 600, refill_per_second: 10 },
      ],
      0,
    )
    state.deduct(5, 0)
    expect(state.credits(0)).toEqual([10, 595])
  })

  test("no refund: a second deduct at the same instant compounds", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    state.deduct(30, 0)
    state.deduct(30, 0)
    expect(state.credits(0)).toEqual([40])
  })

  test("canAfford requires every bucket to cover the cost", () => {
    const state = new ApiKeyState(
      "ankr",
      "tok",
      [
        { capacity: 10, refill_per_second: 10 },
        { capacity: 100, refill_per_second: 10 },
      ],
      0,
    )
    state.deduct(10, 0) // rps bucket is now empty, rpm still has 90
    expect(state.canAfford(1, 0)).toBe(false)
    expect(state.canAfford(1, 1_000)).toBe(true)
  })

  test("headroom = min over buckets(credits / capacity)", () => {
    const state = new ApiKeyState(
      "ankr",
      "tok",
      [
        { capacity: 10, refill_per_second: 10 },
        { capacity: 100, refill_per_second: 10 },
      ],
      0,
    )
    expect(state.headroom(0)).toBe(1)
    state.deduct(5, 0)
    // rps: 5/10 = 0.5 ; rpm: 95/100 = 0.95 → min 0.5
    expect(state.headroom(0)).toBeCloseTo(0.5, 10)
  })

  test("readyAtMs accounts for the slowest bucket deficit (§12.2)", () => {
    const state = new ApiKeyState(
      "ankr",
      "tok",
      [
        { capacity: 10, refill_per_second: 10 },
        { capacity: 100, refill_per_second: 1 },
      ],
      0,
    )
    state.deduct(10, 0) // rps: 0/10, rpm: 90/100
    // rps needs 1s for 10 credits; rpm already affords it → 1s
    expect(state.readyAtMs(10, 0)).toBe(1_000)

    // Drain the slow bucket too: it now needs 10s, which dominates.
    state.deduct(90, 0) // rps: -90, rpm: 0
    expect(state.readyAtMs(10, 0)).toBe(10_000)
  })

  test("readyAtMs includes cooldown remaining", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    state.markRateLimited(0, 7_000)
    expect(state.readyAtMs(1, 0)).toBe(7_000)
  })

  test("readyAtMs is Infinity when cost exceeds capacity forever", () => {
    const state = new ApiKeyState("alchemy", "tok", [{ capacity: 10, refill_per_second: 1 }], 0)
    state.deduct(10, 0)
    expect(state.readyAtMs(50, 0)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("key health (§13)", () => {
  test("429 drains buckets and parks the key until refill", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    state.deduct(20, 0)
    state.markRateLimited(0)
    expect(state.credits(0)).toEqual([0])
    expect(state.cooldownRemainingMs(0)).toBeGreaterThan(0)
  })

  test("429 honours a provider Retry-After hint", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    state.markRateLimited(1_000, 5_000)
    expect(state.cooldownRemainingMs(1_000)).toBe(4_000)
  })

  test("5xx cooldown is exponential 1s → 2s → 4s, capped at 60s", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    state.markFailure(0)
    expect(state.cooldownRemainingMs(0)).toBe(1_000)
    state.markFailure(1_000)
    expect(state.cooldownRemainingMs(1_000)).toBe(2_000)
    state.markFailure(3_000)
    expect(state.cooldownRemainingMs(3_000)).toBe(4_000)
    for (let i = 0; i < 10; i += 1) state.markFailure(3_000)
    expect(state.cooldownRemainingMs(3_000)).toBe(60_000)
  })

  test("success resets the failure streak", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    state.markFailure(0)
    state.markSuccess()
    state.markFailure(10_000)
    expect(state.cooldownRemainingMs(10_000)).toBe(1_000)
  })

  test("a cooling-down key cannot afford anything", () => {
    const state = new ApiKeyState("alchemy", "tok", specs, 0)
    state.markFailure(0)
    expect(state.canAfford(1, 0)).toBe(false)
    expect(state.canAfford(1, 1_000)).toBe(true)
  })
})

describe("BucketRegistry identity sharing (decision #24)", () => {
  test("same (provider, token) in two chains is the SAME object", () => {
    const registry = new BucketRegistry(() => 0)
    const ethereum = registry.get("alchemy", "KEY_A", specs)
    const base = registry.get("alchemy", "KEY_A", specs)
    expect(base).toBe(ethereum)

    ethereum.deduct(40, 0)
    expect(base.credits(0)).toEqual([60])
    expect(registry.size).toBe(1)
  })

  test("different provider or token are distinct identities", () => {
    const registry = new BucketRegistry(() => 0)
    const a = registry.get("alchemy", "KEY_A", specs)
    const b = registry.get("alchemy", "KEY_B", specs)
    const c = registry.get("ankr", "KEY_A", specs)
    expect(new Set([a, b, c]).size).toBe(3)
    expect(registry.size).toBe(3)
  })

  test("identityKey is injective over (provider, token) with a separator", () => {
    expect(identityKey("a", "b\u0000c")).not.toBe(identityKey("a\u0000b", "c"))
  })

  test("retain drops identities no longer referenced (design.md §19)", () => {
    const registry = new BucketRegistry(() => 0)
    registry.get("alchemy", "KEY_A", specs)
    registry.get("alchemy", "KEY_B", specs)
    registry.retain([{ provider: "alchemy", token: "KEY_A" }])
    expect(registry.size).toBe(1)
    expect(registry.all()[0]!.token).toBe("KEY_A")
  })

  test("reload keeps credits for the same identity", () => {
    let now = 0
    const registry = new BucketRegistry(() => now)
    const state = registry.get("alchemy", "KEY_A", specs)
    state.deduct(30, 0)

    // SIGHUP: same identity, same spec
    const reloaded = registry.get("alchemy", "KEY_A", specs)
    expect(reloaded).toBe(state)
    expect(reloaded.credits(0)).toEqual([70])
  })

  test("reload with a changed capacity clamps credits in place", () => {
    const registry = new BucketRegistry(() => 0)
    const state = registry.get("alchemy", "KEY_A", [{ capacity: 100, refill_per_second: 10 }])
    state.deduct(10, 0)

    const reloaded = registry.get("alchemy", "KEY_A", [{ capacity: 50, refill_per_second: 5 }])
    expect(reloaded).toBe(state)
    expect(reloaded.credits(0)).toEqual([50])
    expect(reloaded.buckets[0]!.refillPerSecond).toBe(5)
  })

  test("reload with a different bucket count rebuilds dimensions", () => {
    const registry = new BucketRegistry(() => 0)
    registry.get("ankr", "KEY", [{ capacity: 10, refill_per_second: 10 }])
    const rebuilt = registry.get("ankr", "KEY", [
      { capacity: 10, refill_per_second: 10 },
      { capacity: 100, refill_per_second: 10 },
    ])
    expect(rebuilt.buckets.length).toBe(2)
    expect(rebuilt.credits(0)).toEqual([10, 100])
  })
})

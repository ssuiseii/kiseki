import { describe, expect, test } from "bun:test"
import { AdapterRegistry } from "../src/registry"
import type { AdapterFactory, UpstreamAdapter } from "../src/adapter"
import { createPoolAdapter } from "../src/pool"
import { BucketRegistry } from "../src/bucket"
import { silentLogger } from "../src/types/logger"

const stubFactory: AdapterFactory = () => ({}) as UpstreamAdapter

describe("AdapterRegistry (decision #37)", () => {
  test("registers and resolves a factory", () => {
    const registry = new AdapterRegistry()
    registry.register("alchemy", stubFactory)
    expect(registry.factory("alchemy")).toBe(stubFactory)
    expect(registry.has("alchemy")).toBe(true)
    expect(registry.names()).toEqual(["alchemy"])
  })

  test("unknown package resolves to undefined (caller must fail startup)", () => {
    const registry = new AdapterRegistry()
    expect(registry.factory("nope")).toBeUndefined()
    expect(registry.has("nope")).toBe(false)
  })

  test("duplicate registration is an error, not a silent override", () => {
    const registry = new AdapterRegistry()
    registry.register("alchemy", stubFactory)
    expect(() => registry.register("alchemy", stubFactory)).toThrow(/already registered/)
  })

  test("multiple packages coexist", () => {
    const registry = new AdapterRegistry()
    registry.register("alchemy", stubFactory)
    registry.register("generic", stubFactory)
    expect(registry.names().sort()).toEqual(["alchemy", "generic"])
  })
})

describe("adapter contract (design.md §7.1)", () => {
  const cfg = {
    name: "generic-ethereum",
    provider: "generic",
    package: "generic",
    url_template: "https://rpc.test/{apikey}",
    apikeys: [
      { token: "K1", label: "one", buckets: [{ capacity: 10, refill_per_second: 1 }] },
      { token: "K2", label: "two", buckets: [{ capacity: 10, refill_per_second: 1 }] },
    ],
    methods: ["eth_*"],
    archive: false,
  }

  test("weight sums per-key headroom and excludes cooling keys", () => {
    const registry = new BucketRegistry(() => 0)
    const adapter = createPoolAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: () => 0,
    })
    expect(adapter.weight()).toBeCloseTo(2, 10)
    registry.peek("generic", "K1")!.deduct(10, 0)
    expect(adapter.weight()).toBeCloseTo(1, 10)
    registry.peek("generic", "K2")!.markFailure(0)
    expect(adapter.weight()).toBeCloseTo(0, 10)
  })

  test("earliestReadyAt is a finite ms-epoch timestamp", () => {
    const registry = new BucketRegistry(() => 5_000)
    const adapter = createPoolAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: () => 5_000,
    })
    expect(adapter.earliestReadyAt()).toBe(5_000) // nothing drained yet
  })

  test("the adapter exposes no internals beyond the contract", () => {
    const registry = new BucketRegistry(() => 0)
    const adapter = createPoolAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: () => 0,
    })
    expect(Object.keys(adapter).sort()).toEqual(
      ["attempt", "capability", "earliestReadyAt", "misconfigured", "name", "provider", "weight"].sort(),
    )
  })
})

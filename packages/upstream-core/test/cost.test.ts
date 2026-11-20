import { describe, expect, test } from "bun:test"
import { buildCostResolver, lookupCost } from "../src/cost"

describe("lookupCost — two-layer table (§5.3)", () => {
  const table = {
    eth_call: 2,
    "trace_*": 5,
    "debug_*": 5,
    "replay_*": 10,
  }

  test("exact match", () => {
    expect(lookupCost(table, "eth_call")).toBe(2)
  })

  test("prefix wildcard", () => {
    expect(lookupCost(table, "trace_block")).toBe(5)
    expect(lookupCost(table, "debug_traceTransaction")).toBe(5)
    expect(lookupCost(table, "replay_transaction")).toBe(10)
  })

  test("exact beats prefix", () => {
    expect(lookupCost({ "trace_*": 5, trace_block: 50 }, "trace_block")).toBe(50)
    expect(lookupCost({ "trace_*": 5, trace_block: 50 }, "trace_transaction")).toBe(5)
  })

  test("longest prefix wins", () => {
    expect(lookupCost({ "debug_*": 5, "debug_trace*": 20 }, "debug_traceCall")).toBe(20)
    expect(lookupCost({ "debug_*": 5, "debug_trace*": 20 }, "debug_getRawBlock")).toBe(5)
  })

  test("unknown method and missing table are undefined (caller defaults to 1)", () => {
    expect(lookupCost(table, "eth_blockNumber")).toBeUndefined()
    expect(lookupCost(undefined, "eth_call")).toBeUndefined()
    expect(lookupCost({}, "eth_call")).toBeUndefined()
  })

  test("a non-numeric value is ignored rather than trusted", () => {
    const bad = { eth_call: "2" } as unknown as Record<string, number>
    expect(lookupCost(bad, "eth_call")).toBeUndefined()
  })
})

describe("buildCostResolver — override ?? global ?? 1", () => {
  test("provider override wins", () => {
    const resolve = buildCostResolver({ eth_call: 7 }, { eth_call: 1 })
    expect(resolve("eth_call")).toBe(7)
  })

  test("falls back to the global default", () => {
    const resolve = buildCostResolver({ trace_block: 5 }, { eth_getLogs: 2 })
    expect(resolve("eth_getLogs")).toBe(2)
    expect(resolve("trace_block")).toBe(5)
  })

  test("implicit cost of 1 for anything unlisted", () => {
    const resolve = buildCostResolver(undefined, undefined)
    expect(resolve("eth_blockNumber")).toBe(1)
    expect(resolve("anything_at_all")).toBe(1)
  })

  test("provider override may be partial: unlisted methods still hit global", () => {
    const resolve = buildCostResolver({ "trace_*": 20 }, { "eth_*": 3, "trace_*": 5 })
    expect(resolve("trace_block")).toBe(20)
    expect(resolve("eth_call")).toBe(3)
  })

  test("the resolver is stable across calls", () => {
    const resolve = buildCostResolver({ eth_call: 2 }, { eth_call: 9 })
    expect([resolve("eth_call"), resolve("eth_call")]).toEqual([2, 2])
  })
})

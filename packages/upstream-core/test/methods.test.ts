import { describe, expect, test } from "bun:test"
import {
  capabilityCovers,
  isValidMethodPattern,
  matchesMethodPattern,
  patternsOverlap,
  supportsMethod,
} from "../src/methods"

describe("method patterns (§8.1)", () => {
  test("exact patterns match only themselves", () => {
    expect(matchesMethodPattern("eth_call", "eth_call")).toBe(true)
    expect(matchesMethodPattern("eth_call", "eth_callMany")).toBe(false)
  })

  test("trailing wildcard matches by prefix", () => {
    expect(matchesMethodPattern("eth_*", "eth_call")).toBe(true)
    expect(matchesMethodPattern("eth_*", "eth_blockNumber")).toBe(true)
    expect(matchesMethodPattern("eth_*", "trace_block")).toBe(false)
    expect(matchesMethodPattern("*", "anything")).toBe(true)
  })

  test("a wildcard in the middle is refused (fails closed)", () => {
    expect(matchesMethodPattern("eth_*_call", "eth_foo_call")).toBe(false)
    expect(isValidMethodPattern("eth_*_call")).toBe(false)
  })

  test("pattern validation", () => {
    expect(isValidMethodPattern("eth_call")).toBe(true)
    expect(isValidMethodPattern("eth_*")).toBe(true)
    expect(isValidMethodPattern("*")).toBe(true)
    expect(isValidMethodPattern("")).toBe(false)
    expect(isValidMethodPattern("*eth")).toBe(false)
  })

  test("supportsMethod over a pattern list", () => {
    const patterns = ["eth_*", "trace_block"]
    expect(supportsMethod(patterns, "eth_call")).toBe(true)
    expect(supportsMethod(patterns, "trace_block")).toBe(true)
    expect(supportsMethod(patterns, "trace_transaction")).toBe(false)
    expect(supportsMethod([], "eth_call")).toBe(false)
  })
})

describe("capabilityCovers — pre-flight (§6.1, §8.2)", () => {
  const alchemy = { methods: ["eth_*", "trace_*"], archive: true }
  const ankr = { methods: ["eth_*"], archive: false }

  test("requires every method to be covered", () => {
    expect(capabilityCovers(alchemy, ["eth_call", "trace_block"], false)).toBe(true)
    expect(capabilityCovers(ankr, ["eth_call", "trace_block"], false)).toBe(false)
  })

  test("requires archive when any item needs it", () => {
    expect(capabilityCovers(alchemy, ["eth_getBalance"], true)).toBe(true)
    expect(capabilityCovers(ankr, ["eth_getBalance"], true)).toBe(false)
  })

  test("an empty method set is trivially covered", () => {
    expect(capabilityCovers(ankr, [], false)).toBe(true)
    expect(capabilityCovers({ methods: [], archive: false }, [], true)).toBe(false)
  })
})

describe("patternsOverlap — startup validation (§15.1 rule 5)", () => {
  test("identical exact patterns overlap", () => {
    expect(patternsOverlap("eth_sendTransaction", "eth_sendTransaction")).toBe(true)
    expect(patternsOverlap("eth_call", "eth_getLogs")).toBe(false)
  })

  test("a wildcard overlaps every matching exact pattern", () => {
    expect(patternsOverlap("eth_*", "eth_call")).toBe(true)
    expect(patternsOverlap("trace_*", "eth_call")).toBe(false)
  })

  test("nested wildcards overlap", () => {
    expect(patternsOverlap("eth_*", "eth_get*")).toBe(true)
    expect(patternsOverlap("eth_get*", "eth_*")).toBe(true)
    expect(patternsOverlap("trace_*", "eth_*")).toBe(false)
  })

  test("a bare wildcard overlaps everything", () => {
    expect(patternsOverlap("*", "eth_call")).toBe(true)
    expect(patternsOverlap("*", "debug_*")).toBe(true)
  })
})

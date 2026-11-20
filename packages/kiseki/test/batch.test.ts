import { describe, expect, test } from "bun:test"
import { mergeResults, parseRequest } from "../src/batch"

/**
 * Body parsing (design.md §10.3) and merge ordering (invariant #4).
 *
 * The parsing rules exist to keep routing honest: an item whose `params` we
 * cannot read cannot be classified for archive need, so it is rejected instead of
 * being routed blind.
 */

describe("parseRequest: single request", () => {
  test("a well-formed request becomes one item at index 0", () => {
    const parsed = parseRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(parsed.shape).toBe("object")
    expect(parsed.rejected).toEqual([])
    expect(parsed.items).toEqual([
      { originalIndex: 0, id: 1, method: "eth_blockNumber", params: [] },
    ])
  })

  test("params default to an empty array and the id may be absent", () => {
    const parsed = parseRequest({ method: "eth_chainId" })
    expect(parsed.items[0]).toEqual({
      originalIndex: 0,
      id: null,
      method: "eth_chainId",
      params: [],
    })
  })

  test("params are forwarded untouched", () => {
    const params = ["0xabc", "latest", { nested: [1, 2] }]
    expect(parseRequest({ id: "x", method: "eth_call", params }).items[0]!.params).toEqual(params)
  })

  test("named params are rejected rather than silently unclassifiable", () => {
    const parsed = parseRequest({
      id: 1,
      method: "eth_call",
      params: { to: "0xabc", block: "latest" },
    })
    expect(parsed.items).toEqual([])
    expect(parsed.rejected).toHaveLength(1)
    expect(parsed.rejected[0]!.error.code).toBe(-32600)
    expect(parsed.rejected[0]!.error.message).toMatch(/params/)
  })

  test.each([
    ["not an object", 42],
    ["a bare string", "hello"],
    ["null", null],
  ])("%s is an invalid request", (_label, body) => {
    const parsed = parseRequest(body)
    expect(parsed.items).toEqual([])
    expect(parsed.rejected[0]!.error.code).toBe(-32600)
    expect(parsed.rejected[0]!.id).toBeNull()
  })

  test("a missing or empty method is rejected", () => {
    expect(parseRequest({ id: 1 }).rejected[0]!.error.message).toMatch(/method/)
    expect(parseRequest({ id: 1, method: "" }).rejected[0]!.error.message).toMatch(/method/)
  })

  test("a wrong jsonrpc version is rejected but the id is preserved", () => {
    const parsed = parseRequest({ jsonrpc: "1.0", id: 7, method: "eth_blockNumber" })
    expect(parsed.rejected[0]!.id).toBe(7)
    expect(parsed.rejected[0]!.error.message).toMatch(/jsonrpc/)
  })
})

describe("parseRequest: batch", () => {
  test("items keep their original indexes", () => {
    const parsed = parseRequest([
      { id: 10, method: "eth_blockNumber", params: [] },
      { id: 11, method: "eth_chainId", params: [] },
    ])
    expect(parsed.shape).toBe("array")
    expect(parsed.items.map((item) => item.originalIndex)).toEqual([0, 1])
    expect(parsed.items.map((item) => item.id)).toEqual([10, 11])
  })

  test("one invalid item does not discard the rest (design.md §10.3)", () => {
    const parsed = parseRequest([
      { id: 1, method: "eth_blockNumber", params: [] },
      { id: 2 },
      { id: 3, method: "eth_chainId", params: [] },
    ])
    expect(parsed.items.map((item) => item.originalIndex)).toEqual([0, 2])
    expect(parsed.rejected.map((item) => item.originalIndex)).toEqual([1])
    expect(parsed.rejected[0]!.id).toBe(2)
  })

  test("an empty batch is a single -32600 object response", () => {
    const parsed = parseRequest([])
    expect(parsed.shape).toBe("object")
    expect(parsed.items).toEqual([])
    expect(parsed.rejected[0]!.error.code).toBe(-32600)
    expect(parsed.rejected[0]!.error.message).toMatch(/empty batch/)
  })
})

describe("mergeResults (invariant #4)", () => {
  test("results are ordered by original index regardless of arrival order", () => {
    const merged = mergeResults([
      { originalIndex: 2, id: 3, ok: true, result: "c" },
      { originalIndex: 0, id: 1, ok: true, result: "a" },
      { originalIndex: 1, id: 2, ok: false, error: { code: 3, message: "revert" } },
    ])
    expect(merged.map((entry) => entry.originalIndex)).toEqual([0, 1, 2])
    expect(merged.map((entry) => entry.id)).toEqual([1, 2, 3])
  })

  test("merge does not mutate its input", () => {
    const input = [
      { originalIndex: 1, id: 1, ok: true as const, result: 1 },
      { originalIndex: 0, id: 0, ok: true as const, result: 0 },
    ]
    const merged = mergeResults(input)
    expect(input.map((entry) => entry.originalIndex)).toEqual([1, 0])
    expect(merged.map((entry) => entry.originalIndex)).toEqual([0, 1])
  })
})

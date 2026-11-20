import { describe, expect, test } from "bun:test"
import {
  RuntimeNotes,
  composeMatchers,
  matchCapabilityError,
  type CapabilityCap,
} from "../src/capsig"

const err = (code: number, message: string, data?: unknown) => ({
  code,
  message,
  ...(data === undefined ? {} : { data }),
})

const match = (code: number, message: string, historical = false): CapabilityCap | null =>
  matchCapabilityError(err(code, message), historical)

describe("capsig matrix (design.md §8.3, implementation.md §5)", () => {
  test("-32601 is a method mismatch regardless of message", () => {
    expect(match(-32601, "the method eth_foo does not exist")).toBe("method")
    expect(match(-32601, "")).toBe("method")
    expect(match(-32601, "state pruned")).toBe("method") // code wins
  })

  test("missing trie node is an archive mismatch", () => {
    expect(match(-32000, "missing trie node 0xabc")).toBe("archive")
  })

  test.each([
    "state pruned",
    "state not available",
    "no state available",
    "state for block 0x1234 is not available",
    "state for block 0x1234 pruned",
    "historical state is not available",
  ])("archive state pattern: %s", (message) => {
    expect(match(-32000, message)).toBe("archive")
  })

  test("matching is case-insensitive", () => {
    expect(match(-32000, "Missing Trie Node")).toBe("archive")
    expect(match(-32000, "STATE PRUNED")).toBe("archive")
  })

  test("data payload is searched too", () => {
    expect(matchCapabilityError(err(-32000, "boom", "missing trie node"), false)).toBe("archive")
    expect(matchCapabilityError(err(-32000, "boom", { reason: "state pruned" }), false)).toBe(
      "archive",
    )
  })

  test("block not found only counts as a mismatch for historical queries (#35)", () => {
    expect(match(-32000, "block not found", true)).toBe("archive")
    expect(match(-32000, "block not found", false)).toBeNull()
    expect(match(-32000, "header not found", true)).toBe("archive")
    expect(match(-32000, "header not found", false)).toBeNull()
    expect(match(-32000, "unknown block", true)).toBe("archive")
  })

  test("domain errors are not mismatches", () => {
    expect(match(3, "execution reverted")).toBeNull()
    expect(match(-32000, "nonce too low")).toBeNull()
    expect(match(-32000, "insufficient funds for gas * price + value")).toBeNull()
    expect(match(-32000, "already known")).toBeNull()
    expect(match(-32602, "invalid argument 0: hex string has odd length")).toBeNull()
    expect(match(-32000, "replacement transaction underpriced")).toBeNull()
  })

  test("a domain error mentioning 'not found' is not an archive mismatch when current", () => {
    // e.g. eth_getTransactionByHash returning null is a result, but an explicit
    // error about a missing tx must not be mistaken for an archive problem.
    expect(match(-32000, "transaction not found", false)).toBeNull()
  })
})

describe("composeMatchers (provider hook over the fallback)", () => {
  test("provider verdict wins", () => {
    const provider = () => "method" as const
    expect(composeMatchers(provider)(err(-32000, "missing trie node"), false)).toBe("method")
  })

  test("null from the provider falls through to the generic table", () => {
    const provider = () => null
    expect(composeMatchers(provider)(err(-32601, "nope"), false)).toBe("method")
    expect(composeMatchers(provider)(err(-32000, "missing trie node"), false)).toBe("archive")
  })

  test("no provider hook behaves like the fallback", () => {
    expect(composeMatchers()(err(-32601, "nope"), false)).toBe("method")
    expect(composeMatchers()(err(3, "execution reverted"), false)).toBeNull()
  })

  test("a provider can veto a false positive it knows better than the table", () => {
    // Provider knows its "block not found" for this method means a domain answer.
    const provider = (error: { message: string }) =>
      error.message.includes("block not found") ? null : null
    // With no veto mechanism the fallback would claim archive; a provider that
    // wants to suppress it must instead map the error itself. Documented here so
    // the behaviour is explicit: null means "not mine", not "suppress".
    expect(composeMatchers(provider)(err(-32000, "block not found"), true)).toBe("archive")
  })
})

describe("RuntimeNotes (per instance, key-independent, design.md §8.3)", () => {
  test("records and answers method notes", () => {
    const notes = new RuntimeNotes()
    expect(notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(false)
    notes.note("alchemy-ethereum", "method", "trace_block")
    expect(notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(true)
    expect(notes.hasMethodNote("alchemy-ethereum", "trace_transaction")).toBe(false)
    expect(notes.methodsFor("alchemy-ethereum")).toEqual(["trace_block"])
  })

  test("method notes are scoped per instance", () => {
    const notes = new RuntimeNotes()
    notes.note("alchemy-ethereum", "method", "trace_block")
    expect(notes.hasMethodNote("alchemy-base", "trace_block")).toBe(false)
  })

  test("archive notes are instance-wide", () => {
    const notes = new RuntimeNotes()
    expect(notes.isArchiveDisabled("ankr-ethereum")).toBe(false)
    notes.note("ankr-ethereum", "archive")
    expect(notes.isArchiveDisabled("ankr-ethereum")).toBe(true)
    expect(notes.isArchiveDisabled("alchemy-ethereum")).toBe(false)
  })

  test("duplicate notes are idempotent", () => {
    const notes = new RuntimeNotes()
    notes.note("u", "method", "trace_block")
    notes.note("u", "method", "trace_block")
    expect(notes.methodsFor("u")).toEqual(["trace_block"])
  })

  test("clear() resets everything on reload (design.md §19)", () => {
    const notes = new RuntimeNotes()
    notes.note("u", "method", "trace_block")
    notes.note("u", "archive")
    notes.clear()
    expect(notes.hasMethodNote("u", "trace_block")).toBe(false)
    expect(notes.isArchiveDisabled("u")).toBe(false)
  })
})

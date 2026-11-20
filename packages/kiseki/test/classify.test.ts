import { describe, expect, test } from "bun:test"
import {
  ARCHIVE_DEPTH,
  blockRefs,
  buildTimeoutPolicy,
  classify,
  isHistoricalRef,
  parseBlockRef,
  type ClassifyOptions,
} from "../src/classify"

/**
 * Classifier tests (design.md §9, §14).
 *
 * The classifier's job is to be *deterministic*, not clever: it decides the
 * timeout class, the idempotency class, whether the item is blocked, and whether
 * it touches historical state. A wrong "not archive" is corrected at runtime
 * (#34–35); a wrong "archive" silently removes upstreams, so the tests below pin
 * the conservative-but-not-paranoid boundary.
 */

const timeouts = buildTimeoutPolicy({
  default_seconds: 30,
  heavy_seconds: 120,
  heavy_methods: ["trace_*", "debug_*", "replay_*"],
})

const options: ClassifyOptions = {
  timeouts,
  blockedMethods: ["eth_sendTransaction"],
}

const cls = (method: string, params: unknown[] = [], overrides: Partial<ClassifyOptions> = {}) => {
  const result = classify(method, params, { ...options, ...overrides })
  if (!result.ok) throw new Error(`expected ${method} to classify, got ${result.error.message}`)
  return result.classified
}

describe("timeout class (design.md §14)", () => {
  test("default methods use the default timeout", () => {
    expect(cls("eth_blockNumber").methodClass).toBe("default")
    expect(cls("eth_blockNumber").timeoutMs).toBe(30_000)
  })

  test.each(["trace_block", "debug_traceTransaction", "replay_transaction"])(
    "%s is a heavy class and gets the heavy timeout",
    (method) => {
      expect(cls(method).methodClass).toBe("heavy")
      expect(cls(method).timeoutMs).toBe(120_000)
    },
  )

  test("the heavy list comes from config, not from a hardcoded prefix", () => {
    const custom = buildTimeoutPolicy({
      default_seconds: 5,
      heavy_seconds: 60,
      heavy_methods: ["eth_getLogs"],
    })
    const result = classify("eth_getLogs", [], { ...options, timeouts: custom })
    expect(result.ok && result.classified.timeoutMs).toBe(60_000)
    // A `trace_*` method is no longer heavy once config says so.
    const trace = classify("trace_block", [], { ...options, timeouts: custom })
    expect(trace.ok && trace.classified.timeoutMs).toBe(5_000)
  })
})

describe("idempotency class (design.md §9.2)", () => {
  test("eth_sendRawTransaction is the only non-idempotent method", () => {
    expect(cls("eth_sendRawTransaction", ["0xdead"]).idempotency).toBe("NON_IDEMPOTENT")
    expect(cls("eth_sendRawTransactionSync", ["0xdead"]).idempotency).toBe("READ")
    expect(cls("eth_call", []).idempotency).toBe("READ")
  })
})

describe("blocked methods (design.md §9.2)", () => {
  test("a blocked method is rejected, not classified", () => {
    const result = classify("eth_sendTransaction", [], options)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(-32601)
      expect(result.error.message).toMatch(/blocked by proxy policy/)
      // The message names the method so a human can act on it.
      expect(result.error.message).toContain("eth_sendTransaction")
    }
  })

  test("a wildcard block covers the whole family", () => {
    const result = classify("admin_addPeer", [], {
      ...options,
      blockedMethods: ["admin_*"],
    })
    expect(result.ok).toBe(false)
  })
})

describe("archive detection (design.md §9.1)", () => {
  test("latest / pending / safe / finalized do not need archive", () => {
    for (const tag of ["latest", "pending", "safe", "finalized"]) {
      expect(cls("eth_getBalance", ["0xabc", tag]).needsArchive).toBe(false)
    }
  })

  test("earliest needs archive", () => {
    expect(cls("eth_getBalance", ["0xabc", "earliest"]).needsArchive).toBe(true)
  })

  test("a block hash is treated as archive (conservative)", () => {
    const hash = `0x${"ab".repeat(32)}`
    expect(cls("eth_getBlockByHash", [hash, false]).needsArchive).toBe(true)
  })

  test(`a numeric block older than tip - ${ARCHIVE_DEPTH} needs archive`, () => {
    const tip = 1_000_000
    const old = `0x${(tip - ARCHIVE_DEPTH - 1).toString(16)}`
    const recent = `0x${(tip - 10).toString(16)}`
    expect(cls("eth_getBalance", ["0xabc", old], { tip }).needsArchive).toBe(true)
    expect(cls("eth_getBalance", ["0xabc", recent], { tip }).needsArchive).toBe(false)
  })

  test("the boundary is exactly tip - 128 (inclusive is still recent)", () => {
    const tip = 100_000
    const boundary = `0x${(tip - ARCHIVE_DEPTH).toString(16)}`
    const justBelow = `0x${(tip - ARCHIVE_DEPTH - 1).toString(16)}`
    expect(cls("eth_getBalance", ["0xabc", boundary], { tip }).needsArchive).toBe(false)
    expect(cls("eth_getBalance", ["0xabc", justBelow], { tip }).needsArchive).toBe(true)
  })

  test("with no known tip, an explicit height is treated as historical", () => {
    // Conservative direction: a narrower candidate set can never send a query to
    // a node that cannot serve it; the runtime signal covers the other error.
    expect(cls("eth_getBalance", ["0xabc", "0x10"]).needsArchive).toBe(true)
  })

  test("eth_getLogs looks at fromBlock, not toBlock", () => {
    const filter = { fromBlock: "0x1", toBlock: "latest" }
    expect(cls("eth_getLogs", [filter], { tip: 1_000 }).needsArchive).toBe(true)
    const recent = { fromBlock: "latest", toBlock: "latest" }
    expect(cls("eth_getLogs", [recent], { tip: 1_000 }).needsArchive).toBe(false)
  })

  test("eth_getLogs with a blockHash is archive", () => {
    const filter = { blockHash: `0x${"cd".repeat(32)}` }
    expect(cls("eth_getLogs", [filter]).needsArchive).toBe(true)
  })

  test("an unknown method is classified as non-archive rather than guessed", () => {
    expect(cls("custom_method", ["0x1", "0x2"]).needsArchive).toBe(false)
  })

  test("historical mirrors needsArchive and is carried to the pool (#35)", () => {
    const state = cls("eth_getBalance", ["0xabc", "earliest"])
    expect(state.historical).toBe(state.needsArchive)
  })

  test("a missing block argument is not historical", () => {
    expect(cls("eth_blockNumber").needsArchive).toBe(false)
    expect(cls("eth_getBalance", ["0xabc"]).needsArchive).toBe(false)
  })

  test("a malformed block tag is not silently treated as historical", () => {
    expect(cls("eth_getBalance", ["0xabc", "not-a-tag"]).needsArchive).toBe(false)
  })
})

describe("parseBlockRef / isHistoricalRef", () => {
  test("tags and quantities parse to their kinds", () => {
    expect(parseBlockRef("latest")).toEqual({ kind: "latest" })
    expect(parseBlockRef("EARLIEST")).toEqual({ kind: "earliest" })
    expect(parseBlockRef("0x10")).toEqual({ kind: "number", value: 16 })
    expect(parseBlockRef(`0x${"a".repeat(64)}`)).toEqual({ kind: "hash" })
    expect(parseBlockRef(42)).toEqual({ kind: "number", value: 42 })
    expect(parseBlockRef(undefined)).toBeUndefined()
    expect(parseBlockRef("")).toBeUndefined()
  })

  test("a filter object exposes its block reference", () => {
    expect(parseBlockRef({ blockNumber: "0x5" })).toEqual({ kind: "number", value: 5 })
    expect(parseBlockRef({ blockHash: `0x${"b".repeat(64)}` })).toEqual({ kind: "hash" })
    expect(parseBlockRef({ blockTag: "latest" })).toEqual({ kind: "latest" })
  })

  test("isHistoricalRef is total over the ref kinds", () => {
    expect(isHistoricalRef({ kind: "latest" })).toBe(false)
    expect(isHistoricalRef({ kind: "earliest" })).toBe(true)
    expect(isHistoricalRef({ kind: "hash" })).toBe(true)
    expect(isHistoricalRef({ kind: "number", value: 5 }, 1_000)).toBe(true)
    expect(isHistoricalRef({ kind: "number", value: 999 }, 1_000)).toBe(false)
  })
})

describe("blockRefs", () => {
  test("reads the documented positions", () => {
    expect(blockRefs("eth_call", [{}, "latest"])).toEqual([{ kind: "latest" }])
    expect(blockRefs("eth_getStorageAt", ["0xabc", "0x0", "earliest"])).toEqual([
      { kind: "earliest" },
    ])
    expect(blockRefs("trace_call", [{}, {}, "0x1"])).toEqual([{ kind: "number", value: 1 }])
  })

  test("a method with no known block position yields nothing", () => {
    expect(blockRefs("eth_blockNumber", [])).toEqual([])
    expect(blockRefs("eth_getTransactionByHash", ["0xhash"])).toEqual([])
  })
})

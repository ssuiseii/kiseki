import { describe, expect, test } from "bun:test"
import { RuntimeNotes, silentLogger } from "upstream-core"
import { parseRequest } from "../src/batch"
import { buildTimeoutPolicy } from "../src/classify"
import { handle, type PipelineDeps, type PipelineObserver } from "../src/pipeline"
import { fakeAdapter, recordingLogger, successAll, success } from "./helpers"

/**
 * Pipeline tests (design.md §4, §8.2, §12.3).
 *
 * These exercise the whole flow the server will call: parse → classify →
 * pre-flight → route → merge → shape. No HTTP, no server: the adapters are fakes,
 * so every assertion is about routing behaviour and the response contract.
 */

const timeouts = buildTimeoutPolicy({
  default_seconds: 30,
  heavy_seconds: 120,
  heavy_methods: ["trace_*", "debug_*", "replay_*"],
})

type DepsOptions = {
  notes?: RuntimeNotes
  random?: () => number
  maxTotalAttempts?: number
  tip?: number
  blockedMethods?: string[]
  observer?: PipelineObserver
  logger?: PipelineDeps["logger"]
}

const makeDeps = (
  adapters: ReturnType<typeof fakeAdapter>[],
  options: DepsOptions = {},
): PipelineDeps => ({
  chain: "ethereum",
  upstreams: adapters.map((entry) => entry.view),
  notes: options.notes ?? new RuntimeNotes(),
  logger: options.logger ?? silentLogger,
  now: () => 0,
  timeouts,
  blockedMethods: options.blockedMethods ?? ["eth_sendTransaction"],
  maxTotalAttempts: options.maxTotalAttempts ?? 0,
  ...(options.tip === undefined ? {} : { tip: options.tip }),
  ...(options.random === undefined ? {} : { random: options.random }),
  ...(options.observer === undefined ? {} : { observer: options.observer }),
})

const run = (adapters: ReturnType<typeof fakeAdapter>[], body: unknown, options: DepsOptions = {}) =>
  handle(makeDeps(adapters, options), parseRequest(body))

describe("pre-flight (design.md §8.2)", () => {
  test("a method no upstream claims is rejected instantly, with no attempt", async () => {
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], outcomes: [success(0, "x")] })
    const result = await run([a], { id: 1, method: "trace_block", params: [] })

    expect(a.calls).toHaveLength(0)
    expect(result.status).toBe(200)
    const body = result.body as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32601)
    expect(body.error.message).toBe("method not supported by any configured upstream")
  })

  test("a historical query with no archive upstream is rejected as an archive miss", async () => {
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], archive: false, outcomes: [success(0, "x")] })
    const result = await run([a], {
      id: 1,
      method: "eth_getBalance",
      params: ["0xabc", "earliest"],
    })

    expect(a.calls).toHaveLength(0)
    const body = result.body as { error: { code: number; data: { cap: string } } }
    expect(body.error.code).toBe(-32601)
    expect(body.error.data.cap).toBe("archive")
  })

  test("a blocked method never reaches an upstream", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [success(0, "x")] })
    const result = await run([a], { id: 1, method: "eth_sendTransaction", params: [{}] })

    expect(a.calls).toHaveLength(0)
    const body = result.body as { error: { message: string } }
    expect(body.error.message).toMatch(/blocked by proxy policy/)
  })

  test("pre-flight rejection is reported to the observer", async () => {
    const reasons: string[] = []
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], outcomes: [] })
    await run([a], { id: 1, method: "trace_block", params: [] }, {
      observer: { onPreflightReject: (_chain, reason) => reasons.push(reason) },
    })
    expect(reasons).toEqual(["method"])
  })

  test("a valid item still runs when a sibling item is pre-flight rejected", async () => {
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], outcomes: [success(0, "0x1")] })
    const result = await run([a], [
      { id: 1, method: "eth_blockNumber", params: [] },
      { id: 2, method: "trace_block", params: [] },
    ])

    expect(result.status).toBe(200)
    const body = result.body as { id: number; result?: unknown; error?: { code: number } }[]
    expect(body).toHaveLength(2)
    expect(body[0]!.result).toBe("0x1")
    expect(body[1]!.error?.code).toBe(-32601)
  })
})

describe("response shaping (design.md §12.3)", () => {
  test("a single success is one envelope, not an array", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [success(0, "0x2a")] })
    const result = await run([a], { id: 7, method: "eth_blockNumber", params: [] })

    expect(result.shape).toBe("object")
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ jsonrpc: "2.0", id: 7, result: "0x2a" })
  })

  test("a batch answers with an array in the original order (invariant #4)", async () => {
    // The adapter answers both items in reverse index order; merge must restore it.
    const a = fakeAdapter({
      name: "a",
      outcomes: [
        {
          kind: "success",
          entries: [
            { originalIndex: 1, ok: true, result: "second" },
            { originalIndex: 0, ok: true, result: "first" },
          ],
        },
      ],
    })
    const result = await run([a], [
      { id: 10, method: "eth_blockNumber", params: [] },
      { id: 11, method: "eth_chainId", params: [] },
    ])

    const body = result.body as { id: number; result: unknown }[]
    expect(body.map((entry) => entry.id)).toEqual([10, 11])
    expect(body.map((entry) => entry.result)).toEqual(["first", "second"])
  })

  test("a partial batch is 200 with mixed result and error (invariant #5)", async () => {
    const a = fakeAdapter({
      name: "a",
      outcomes: [
        {
          kind: "success",
          entries: [
            { originalIndex: 0, ok: true, result: "0x1" },
            {
              originalIndex: 1,
              ok: false,
              error: { code: 3, message: "execution reverted" },
              final: true,
            },
          ],
        },
      ],
    })
    const result = await run([a], [
      { id: 1, method: "eth_call", params: [{}] },
      { id: 2, method: "eth_call", params: [{}] },
    ])

    expect(result.status).toBe(200)
    const body = result.body as { result?: unknown; error?: { code: number } }[]
    expect(body[0]!.result).toBe("0x1")
    expect(body[1]!.error?.code).toBe(3)
  })

  test("all items out of capacity → 429 with a Retry-After (§12.3 row 2)", async () => {
    const a = fakeAdapter({
      name: "a",
      earliestReadyAt: 4_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 4_000 }],
    })
    const result = await run([a], [
      { id: 1, method: "eth_blockNumber", params: [] },
      { id: 2, method: "eth_chainId", params: [] },
    ])

    expect(result.status).toBe(429)
    expect(result.retryAfterMs).toBe(4_000)
    const body = result.body as { error: { code: number } }[]
    expect(body.map((entry) => entry.error.code)).toEqual([-32005, -32005])
  })

  test("one answered item keeps the response at 200 even when the rest are starved", async () => {
    // Two items, different capability sets → two groups. One succeeds, one starves.
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], outcomes: [success(0, "0x1")] })
    const b = fakeAdapter({
      name: "b",
      methods: ["eth_*", "trace_*"],
      earliestReadyAt: 4_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 4_000 }],
    })

    const result = await run([a, b], [
      { id: 1, method: "eth_blockNumber", params: [] },
      { id: 2, method: "trace_block", params: [] },
    ], { random: () => 0 })

    // `trace_block` can only go to b (which is starved); eth_* goes to a.
    expect(result.status).toBe(200)
    const body = result.body as { result?: unknown; error?: { code: number } }[]
    expect(body[0]!.result).toBe("0x1")
    expect(body[1]!.error?.code).toBe(-32005)
  })

  test("invalid items answer -32600 without stopping their siblings (§10.3)", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [successAll([{ originalIndex: 0, result: "ok" }])] })
    const result = await run([a], [
      { id: 1, method: "eth_blockNumber", params: [] },
      { id: 2 },
    ])

    const body = result.body as { id: number; result?: unknown; error?: { code: number } }[]
    expect(body[0]!.result).toBe("ok")
    expect(body[1]!.error?.code).toBe(-32600)
  })
})

describe("regroup end-to-end (decision #34)", () => {
  test("the runtime note makes the NEXT request skip the mismatching upstream", async () => {
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*", "trace_*"],
      outcomes: [
        {
          kind: "unsupported",
          items: [
            {
              originalIndex: 0,
              method: "trace_block",
              cap: "method",
              providerError: { code: -32601, message: "not available" },
            },
          ],
        },
      ],
    })
    const b = fakeAdapter({
      name: "b",
      methods: ["eth_*", "trace_*"],
      outcomes: [success(0, "0xfromB"), success(0, "0xfromB2")],
    })

    const notes = new RuntimeNotes()
    const first = await run([a, b], { id: 1, method: "trace_block", params: [] }, {
      notes,
      random: () => 0,
    })
    expect((first.body as { result: unknown }).result).toBe("0xfromB")

    // The note was recorded by the pipeline, per instance and method.
    expect(notes.hasMethodNote("a", "trace_block")).toBe(true)

    const callsBefore = a.calls.length
    const second = await run([a, b], { id: 2, method: "trace_block", params: [] }, {
      notes,
      random: () => 0,
    })
    expect((second.body as { result: unknown }).result).toBe("0xfromB2")
    // A was never asked again.
    expect(a.calls.length).toBe(callsBefore)
  })

  test("the same request still succeeds even though the quota of A was spent", async () => {
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*", "trace_*"],
      outcomes: [
        {
          kind: "unsupported",
          items: [
            {
              originalIndex: 0,
              method: "trace_block",
              cap: "method",
              providerError: { code: -32601, message: "nope" },
            },
          ],
        },
      ],
    })
    const b = fakeAdapter({ name: "b", methods: ["eth_*", "trace_*"], outcomes: [success(0, "0xb")] })

    const result = await run([a, b], { id: 1, method: "trace_block", params: [] }, {
      random: () => 0,
    })
    // design.md §23 risk #11: the failed attempt at A is spent, no refund.
    expect(a.calls).toHaveLength(1)
    expect((result.body as { result: unknown }).result).toBe("0xb")
  })

  test("the batch example from design.md §10.2 routes each group to the right upstream", async () => {
    // A = alchemy-ethereum: eth_*, trace_*, archive. B = ankr: eth_*, non-archive.
    // Both answer whatever group they are handed, like a real node.
    const echo = (name: string, methods: string[], archive: boolean) =>
      fakeAdapter({
        name,
        methods,
        archive,
        outcomes: [],
        onAttempt: (group) => ({
          kind: "success" as const,
          entries: group.items.map((item) => ({
            originalIndex: item.originalIndex,
            ok: true as const,
            result: `${name}:${item.method}`,
          })),
        }),
      })

    const alchemy = echo("alchemy", ["eth_*", "trace_*"], true)
    const ankr = echo("ankr", ["eth_*"], false)

    const result = await run([alchemy, ankr], [
      { id: 0, method: "eth_blockNumber", params: [] },
      { id: 1, method: "trace_block", params: ["0x1"] },
      { id: 2, method: "eth_call", params: [{}, "0x1"] },
      { id: 3, method: "trace_transaction", params: ["0xabc"] },
      { id: 4, method: "eth_getBalance", params: ["0xabc", "latest"] },
    ], { tip: 10_000, random: () => 0.9 })

    const body = result.body as { id: number; result: string }[]
    // Every index is answered, in order (invariant #4).
    expect(body.map((entry) => entry.id)).toEqual([0, 1, 2, 3, 4])
    // Only A can serve the trace/archive items.
    expect(body[1]!.result).toBe("alchemy:trace_block")
    expect(body[2]!.result).toBe("alchemy:eth_call")
    expect(body[3]!.result).toBe("alchemy:trace_transaction")
    // The `eth_*`-only group is eligible at both upstreams; random 0.9 draws B.
    expect(body[0]!.result).toBe("ankr:eth_blockNumber")
    expect(body[4]!.result).toBe("ankr:eth_getBalance")

    const groupsOf = (calls: { group: { items: { originalIndex: number }[] } }[]) =>
      calls
        .map((call) => call.group.items.map((item) => item.originalIndex).sort())
        .sort((left, right) => left[0]! - right[0]!)

    // §10.1 step 1 keys by (candidate set, needsArchive, idempotency). §10.2 draws
    // {1,2,3} as one G2; the normative key splits it, because the historical
    // `eth_call` needs archive and `trace_transaction` does not. The cost is one
    // extra HTTP call, and it is the conservative direction: an item never shares
    // a request with one that needs a capability its upstreams might lack.
    expect(groupsOf(alchemy.calls)).toEqual([[1, 2], [3]])
    expect(groupsOf(ankr.calls)).toEqual([[0, 4]])
  })
})

describe("sendRaw through the pipeline (§11.3)", () => {
  test("ambiguous answers -32007 and is not retried at another upstream", async () => {
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*"],
      outcomes: [{ kind: "ambiguous" }],
    })
    const b = fakeAdapter({ name: "b", methods: ["eth_*"], outcomes: [success(0, "0xhash")] })

    const result = await run([a, b], {
      id: 1,
      method: "eth_sendRawTransaction",
      params: ["0xdeadbeef"],
    }, { random: () => 0 })

    expect(result.status).toBe(200)
    expect(b.calls).toHaveLength(0)
    const body = result.body as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32007)
    expect(body.error.message).toBe("broadcast state unknown")
  })
})

describe("logging (§18.2)", () => {
  test("pre-flight and regroup logs never contain a token", async () => {
    const { logger, records } = recordingLogger()
    const a = fakeAdapter({
      name: "alchemy-ethereum",
      methods: ["eth_*"],
      outcomes: [],
    })
    await run([a], { id: 1, method: "trace_block", params: [] }, { logger })

    const text = JSON.stringify(records)
    expect(text).not.toContain("SUPER_SECRET")
    expect(records.some((record) => record.message === "pre-flight rejected")).toBe(true)
    // And the warn names the method, not the params.
    const warn = records.find((record) => record.message === "pre-flight rejected")
    expect(warn?.fields).toEqual({ chain: "ethereum", method: "trace_block", cap: "method" })
  })
})

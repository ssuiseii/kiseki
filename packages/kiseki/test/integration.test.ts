import { describe, expect, test } from "bun:test"
import {
  BucketRegistry,
  RuntimeNotes,
  createPoolAdapter,
  silentLogger,
  type UpstreamInstanceConfig,
} from "upstream-core"
import { parseRequest } from "../src/batch"
import { buildTimeoutPolicy } from "../src/classify"
import { toView } from "../src/capability"
import { handle, type PipelineDeps } from "../src/pipeline"

/**
 * Integration: the REAL level-2 pool (M1) behind the REAL pipeline (M3).
 *
 * The router unit tests use fake adapters, which proves the loop but not that the
 * loop and the pool agree on the taxonomy. Here the adapters are
 * `createPoolAdapter` — buckets, cost resolver, capsig, HTTP classification and
 * all — with `fetch` replaced by a scripted responder. If `-32601` did not survive
 * `classifyBody` → `poolOutcome` → `UpstreamOutcome`, the regroup below could not
 * happen.
 */

const timeouts = buildTimeoutPolicy({
  default_seconds: 30,
  heavy_seconds: 120,
  heavy_methods: ["trace_*", "debug_*", "replay_*"],
})

type Responder = (url: string, body: unknown) => Response

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

/** Records every URL the pool called, so key/upstream failover is observable. */
const makeFetch = (responder: Responder) => {
  const urls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    const body: unknown = JSON.parse(String(init?.body ?? "null"))
    return responder(url, body)
  }) as unknown as typeof fetch
  return { fetchImpl, urls }
}

/** Answer every request in the body with `result` (single or batch). */
const answerAll = (body: unknown, result: unknown): Response => {
  if (Array.isArray(body)) {
    return json(
      body.map((request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, result })),
    )
  }
  const request = body as { id: unknown }
  return json({ jsonrpc: "2.0", id: request.id, result })
}

/** Answer every request in the body with the given JSON-RPC error. */
const errorAll = (body: unknown, code: number, message: string): Response => {
  const error = { code, message }
  if (Array.isArray(body)) {
    return json(
      body.map((request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, error })),
    )
  }
  const request = body as { id: unknown }
  return json({ jsonrpc: "2.0", id: request.id, error })
}

const instance = (
  name: string,
  provider: string,
  methods: string[],
  archive: boolean,
  keyLabel = "a",
): UpstreamInstanceConfig => ({
  name,
  provider,
  package: "generic",
  url_template: `https://${name}.test/v1/{apikey}`,
  apikeys: [
    { token: `${name}-${keyLabel}`, label: keyLabel, buckets: [{ capacity: 1_000, refill_per_second: 100 }] },
  ],
  methods,
  archive,
})

type StackOptions = {
  upstreams: UpstreamInstanceConfig[]
  responder: Responder
  notes?: RuntimeNotes
  random?: () => number
}

const stack = (options: StackOptions) => {
  const { fetchImpl, urls } = makeFetch(options.responder)
  const bucketRegistry = new BucketRegistry(() => 0)
  const notes = options.notes ?? new RuntimeNotes()
  const deps = { bucketRegistry, logger: silentLogger, now: () => 0, fetchImpl }

  // The SAME random drives both levels, so a test that pins it makes key choice
  // (level 2) and upstream choice (level 1) deterministic together.
  const random = options.random ?? Math.random
  const adapters = options.upstreams.map((config) => ({
    config,
    adapter: createPoolAdapter(config, deps, { random }),
  }))

  const pipeline: PipelineDeps = {
    chain: "ethereum",
    upstreams: adapters.map((entry) => toView(entry)),
    notes,
    logger: silentLogger,
    now: () => 0,
    timeouts,
    blockedMethods: ["eth_sendTransaction"],
    maxTotalAttempts: 0,
    random,
  }

  return { pipeline, urls, bucketRegistry, notes }
}

describe("integration: pool + pipeline", () => {
  test("-32601 from a real provider response regroups the item to the second upstream", async () => {
    const alchemy = instance("alchemy-ethereum", "alchemy", ["eth_*", "trace_*"], true)
    const ankr = instance("ankr-ethereum", "ankr", ["eth_*", "trace_*"], true)

    const { pipeline, urls, notes } = stack({
      upstreams: [alchemy, ankr],
      // A says "not available", B serves it.
      responder: (url, body) =>
        url.includes("alchemy-ethereum")
          ? errorAll(body, -32601, "method not found")
          : answerAll(body, "0xtraced"),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "trace_block", params: ["0x1"] }),
    )

    expect((result.body as { result: unknown }).result).toBe("0xtraced")
    // Both upstreams were really called, in order.
    expect(urls).toEqual([
      "https://alchemy-ethereum.test/v1/alchemy-ethereum-a",
      "https://ankr-ethereum.test/v1/ankr-ethereum-a",
    ])
    // And the mismatch was recorded for the next request.
    expect(notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(true)
  })

  test("the recorded note keeps the next request away from the mismatching upstream", async () => {
    const alchemy = instance("alchemy-ethereum", "alchemy", ["eth_*", "trace_*"], true)
    const ankr = instance("ankr-ethereum", "ankr", ["eth_*", "trace_*"], true)

    const { pipeline, urls } = stack({
      upstreams: [alchemy, ankr],
      responder: (url, body) =>
        url.includes("alchemy-ethereum")
          ? errorAll(body, -32601, "method not found")
          : answerAll(body, "0xok"),
      random: () => 0,
    })

    await handle(pipeline, parseRequest({ id: 1, method: "trace_block", params: ["0x1"] }))
    const afterFirst = urls.length

    const second = await handle(
      pipeline,
      parseRequest({ id: 2, method: "trace_block", params: ["0x2"] }),
    )

    expect((second.body as { result: unknown }).result).toBe("0xok")
    // One call only, and it went straight to the capable upstream.
    expect(urls.length - afterFirst).toBe(1)
    expect(urls.at(-1)).toContain("ankr-ethereum")
  })

  test("a 429 inside the pool fails over to the next key before the router is involved", async () => {
    // One upstream instance, two apikeys: the level-2 failover must be invisible
    // to the router (design.md §7.2, §10.2).
    const config: UpstreamInstanceConfig = {
      ...instance("alchemy-ethereum", "alchemy", ["eth_*"], true),
      apikeys: [
        { token: "key-a", label: "a", buckets: [{ capacity: 10, refill_per_second: 1 }] },
        { token: "key-b", label: "b", buckets: [{ capacity: 10, refill_per_second: 1 }] },
      ],
    }

    const { pipeline, urls } = stack({
      upstreams: [config],
      responder: (url, body) =>
        url.endsWith("key-a")
          ? new Response("", { status: 429, headers: { "retry-after": "2" } })
          : answerAll(body, "0x2a"),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_blockNumber", params: [] }),
    )

    expect((result.body as { result: unknown }).result).toBe("0x2a")
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain("key-a")
    expect(urls[1]).toContain("key-b")
  })

  test("a non-archive upstream answers a pruned-state error, and the archive one serves it", async () => {
    // The classifier says `earliest` needs archive, so the non-archive upstream is
    // not even a candidate. This test pins the OTHER path: both claim archive, one
    // lies, and the runtime signal corrects it (#35).
    const liar = instance("liar-ethereum", "liar", ["eth_*"], true)
    const archive = instance("archive-ethereum", "archive", ["eth_*"], true)

    const { pipeline, urls, notes } = stack({
      upstreams: [liar, archive],
      responder: (url, body) =>
        url.includes("liar-ethereum")
          ? errorAll(body, -32000, "missing trie node")
          : answerAll(body, "0xbalance"),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_getBalance", params: ["0xabc", "earliest"] }),
    )

    expect((result.body as { result: unknown }).result).toBe("0xbalance")
    expect(urls).toHaveLength(2)
    // The note is on the archive dimension, not the method one.
    expect(notes.isArchiveDisabled("liar-ethereum")).toBe(true)
    expect(notes.hasMethodNote("liar-ethereum", "eth_getBalance")).toBe(false)
  })

  test("a domain error is passed through untouched and never retried", async () => {
    const a = instance("a-ethereum", "a", ["eth_*"], true)
    const b = instance("b-ethereum", "b", ["eth_*"], true)

    const { pipeline, urls } = stack({
      upstreams: [a, b],
      responder: (url, body) =>
        url.includes("a-ethereum")
          ? errorAll(body, 3, "execution reverted")
          : answerAll(body, "should-not-happen"),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_call", params: [{ to: "0xabc" }] }),
    )

    const body = result.body as { error: { code: number; message: string } }
    expect(body.error).toEqual({ code: 3, message: "execution reverted" })
    expect(urls).toHaveLength(1)
  })

  test("sendRaw ambiguity from a real 5xx stops the router (§11.3)", async () => {
    const a = instance("a-ethereum", "a", ["eth_*"], true)
    const b = instance("b-ethereum", "b", ["eth_*"], true)

    const { pipeline, urls } = stack({
      upstreams: [a, b],
      responder: (url, body) =>
        url.includes("a-ethereum")
          ? new Response("bad gateway", { status: 502 })
          : answerAll(body, "0xhash"),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_sendRawTransaction", params: ["0xdeadbeef"] }),
    )

    const body = result.body as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32007)
    // The second upstream was never contacted.
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain("a-ethereum")
  })

  test("a batch of mixed capabilities is split across upstreams and merged in order", async () => {
    const alchemy = instance("alchemy-ethereum", "alchemy", ["eth_*", "trace_*"], true)
    const ankr = instance("ankr-ethereum", "ankr", ["eth_*"], false)

    const { pipeline } = stack({
      upstreams: [alchemy, ankr],
      responder: (url, body) => {
        const label = url.includes("alchemy") ? "alchemy" : "ankr"
        if (Array.isArray(body)) {
          return json(
            body.map((request: { id: number; method: string }) => ({
              jsonrpc: "2.0",
              id: request.id,
              result: `${label}:${request.method}`,
            })),
          )
        }
        const request = body as { id: number; method: string }
        return json({ jsonrpc: "2.0", id: request.id, result: `${label}:${request.method}` })
      },
      random: () => 0.99,
    })

    const result = await handle(
      pipeline,
      parseRequest([
        { id: 0, method: "eth_blockNumber", params: [] },
        { id: 1, method: "trace_block", params: ["0x1"] },
        { id: 2, method: "eth_getBalance", params: ["0xabc", "latest"] },
        { id: 3, method: "trace_transaction", params: ["0xabc"] },
      ]),
    )

    const body = result.body as { id: number; result: string }[]
    expect(body.map((entry) => entry.id)).toEqual([0, 1, 2, 3])
    expect(body[0]!.result).toMatch(/eth_blockNumber$/)
    expect(body[1]!.result).toBe("alchemy:trace_block")
    expect(body[2]!.result).toMatch(/eth_getBalance$/)
    expect(body[3]!.result).toBe("alchemy:trace_transaction")
  })

  test("a batch where every key is out of quota answers 429 with a Retry-After", async () => {
    const config: UpstreamInstanceConfig = {
      ...instance("alchemy-ethereum", "alchemy", ["eth_*"], true),
      apikeys: [
        { token: "key-a", label: "a", buckets: [{ capacity: 5, refill_per_second: 1 }] },
      ],
    }

    const { pipeline } = stack({
      upstreams: [config],
      responder: () => new Response("", { status: 429, headers: { "retry-after": "3" } }),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_blockNumber", params: [] }),
    )

    expect(result.status).toBe(429)
    // 3s from the provider's Retry-After header, inside the 0.5–30s clamp.
    expect(result.retryAfterMs).toBe(3_000)
    expect((result.body as { error: { code: number } }).error.code).toBe(-32005)
  })

  test("quota is deducted per item, once, before the fetch (§5.5)", async () => {
    const config: UpstreamInstanceConfig = {
      ...instance("alchemy-ethereum", "alchemy", ["eth_*"], true),
      apikeys: [{ token: "key-a", label: "a", buckets: [{ capacity: 100, refill_per_second: 1 }] }],
    }

    const { pipeline, bucketRegistry } = stack({
      upstreams: [config],
      responder: (url, body) => answerAll(body, "0x1"),
      random: () => 0,
    })

    await handle(
      pipeline,
      parseRequest([
        { id: 0, method: "eth_blockNumber", params: [] },
        { id: 1, method: "eth_chainId", params: [] },
      ]),
    )

    // Two items, cost 1 each (generic package, no cost overrides).
    expect(bucketRegistry.peek("alchemy", "key-a")!.credits(0)).toEqual([98])
  })
})

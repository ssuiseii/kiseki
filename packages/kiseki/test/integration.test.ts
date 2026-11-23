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
import { recordingLogger } from "./helpers"

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

/**
 * Ankr research note, section "apikey salah", quoted verbatim: HTTP 404 and this
 * HTML page, `content-type: text/html`, not JSON at all.
 */
const ANKR_HTML_404 =
  "<html><head><title>404 Not Found</title></head>\n<body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>"

const html404 = (): Response =>
  new Response(ANKR_HTML_404, { status: 404, headers: { "content-type": "text/html" } })

describe("integration: 4xx non-JSON-RPC through the real pool and pipeline", () => {
  const read = (id: number) => parseRequest({ id, method: "eth_blockNumber", params: [] })

  test("request one answers 200 / -32008 with data.status, never 429 / -32006", async () => {
    const { pipeline } = stack({
      upstreams: [instance("ankr-ethereum", "ankr", ["eth_*"], true)],
      responder: () => html404(),
      random: () => 0,
    })

    const result = await handle(pipeline, read(1))

    expect(result.status).toBe(200)
    expect(result.retryAfterMs).toBeUndefined()
    expect((result.body as { error: { code: number; message: string; data?: unknown } }).error).toEqual({
      code: -32008,
      message: "upstream is misconfigured",
      data: { status: 404 },
    })
  })

  test("request two during the cooldown sends nothing and answers the same way (Validasi #3)", async () => {
    const { pipeline, urls } = stack({
      upstreams: [instance("ankr-ethereum", "ankr", ["eth_*"], true)],
      responder: () => html404(),
      random: () => 0,
    })

    await handle(pipeline, read(1))
    expect(urls).toHaveLength(1)

    const second = await handle(pipeline, read(2))

    // No fetch at all: the diagnosis is passive, and no quota was spent.
    expect(urls).toHaveLength(1)
    expect(second.status).toBe(200)
    expect(second.retryAfterMs).toBeUndefined()
    expect((second.body as { error: { code: number } }).error.code).toBe(-32008)
  })

  test("a 401 from one upstream still lets a healthy one serve the item (Validasi #7)", async () => {
    const broken = instance("broken-ethereum", "broken", ["eth_*"], true)
    const healthy = instance("healthy-ethereum", "healthy", ["eth_*"], true)

    const { pipeline, urls } = stack({
      upstreams: [broken, healthy],
      responder: (url, body) =>
        url.includes("broken-ethereum")
          ? new Response("", { status: 401 })
          : answerAll(body, "0x2a"),
      random: () => 0,
    })

    const result = await handle(pipeline, read(1))

    expect(result.status).toBe(200)
    expect((result.body as { result: unknown }).result).toBe("0x2a")
    expect(urls).toHaveLength(2)
  })

  test("a misconfigured upstream plus a starved one answers 429 / -32005 (Validasi #6)", async () => {
    const broken = instance("broken-ethereum", "broken", ["eth_*"], true)
    const starved = instance("starved-ethereum", "starved", ["eth_*"], true)

    const { pipeline } = stack({
      upstreams: [broken, starved],
      responder: (url, body) => {
        if (url.includes("broken-ethereum")) return html404()
        // Starved: a 429 with a hint the pipeline may quote back.
        return new Response("", { status: 429, headers: { "retry-after": "2" } })
      },
      random: () => 0,
    })

    const result = await handle(pipeline, read(1))

    // The last ending was capacity, and a candidate could still recover, so the
    // honest answer is a Retry-After rather than a claim that everything is broken.
    expect(result.status).toBe(429)
    expect((result.body as { error: { code: number } }).error.code).toBe(-32005)
  })

  test("sendRaw with a 4xx non-JSON-RPC body stays -32007 and stops routing (Validasi #8)", async () => {
    const a = instance("a-ethereum", "a", ["eth_*"], true)
    const b = instance("b-ethereum", "b", ["eth_*"], true)

    const { pipeline, urls } = stack({
      upstreams: [a, b],
      responder: () => html404(),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_sendRawTransaction", params: ["0xdeadbeef"] }),
    )

    expect((result.body as { error: { code: number } }).error.code).toBe(-32007)
    expect(urls).toHaveLength(1)
  })

  test("the next sendRaw during the cooldown is -32008 without a fetch (Validasi #8)", async () => {
    const { pipeline, urls } = stack({
      upstreams: [instance("a-ethereum", "a", ["eth_*"], true)],
      responder: () => html404(),
      random: () => 0,
    })

    await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_sendRawTransaction", params: ["0xdeadbeef"] }),
    )
    expect(urls).toHaveLength(1)

    const second = await handle(
      pipeline,
      parseRequest({ id: 2, method: "eth_sendRawTransaction", params: ["0xdeadbeef"] }),
    )

    expect(urls).toHaveLength(1)
    expect((second.body as { error: { code: number } }).error.code).toBe(-32008)
  })

  test("sendRaw with 401 on every key ends 200 / -32008, not 429 / -32006 (Validasi #8)", async () => {
    const config: UpstreamInstanceConfig = {
      ...instance("alchemy-ethereum", "alchemy", ["eth_*"], true),
      apikeys: [
        { token: "key-a", label: "a", buckets: [{ capacity: 10, refill_per_second: 1 }] },
        { token: "key-b", label: "b", buckets: [{ capacity: 10, refill_per_second: 1 }] },
      ],
    }

    const { pipeline, urls } = stack({
      upstreams: [config],
      responder: () => new Response("", { status: 401 }),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_sendRawTransaction", params: ["0xdeadbeef"] }),
    )

    // Failover between keys is unchanged (both were tried)…
    expect(urls).toHaveLength(2)
    // …but the final answer is now a configuration diagnosis, not a capacity one.
    expect(result.status).toBe(200)
    expect((result.body as { error: { code: number } }).error.code).toBe(-32008)
  })

  test("4xx with a valid JSON-RPC body still passes the node answer through (Validasi #9)", async () => {
    const { pipeline, urls } = stack({
      upstreams: [instance("a-ethereum", "a", ["eth_*"], true)],
      responder: (url, body) =>
        json(
          {
            jsonrpc: "2.0",
            id: (body as { id: unknown }).id,
            error: { code: 3, message: "execution reverted" },
          },
          400,
        ),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_call", params: [{ to: "0xabc" }] }),
    )

    expect(result.status).toBe(200)
    expect((result.body as { error: { code: number; message: string } }).error).toEqual({
      code: 3,
      message: "execution reverted",
    })
    expect(urls).toHaveLength(1)
  })

  test("an envelope with id null on a 4xx is still matched positionally (Validasi #9)", async () => {
    const { pipeline } = stack({
      upstreams: [instance("a-ethereum", "a", ["eth_*"], true)],
      responder: () =>
        json(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: "nonce too low" } },
          400,
        ),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_call", params: [{ to: "0xabc" }] }),
    )

    expect((result.body as { error: { code: number; message: string } }).error).toEqual({
      code: -32000,
      message: "nonce too low",
    })
  })
})

describe("integration: a 4xx JSON-RPC envelope keeps its full behaviour (Validasi #9)", () => {
  test("a capability mismatch on a 4xx body still regroups to the next upstream", async () => {
    const a = instance("a-ethereum", "a", ["eth_*", "trace_*"], true)
    const b = instance("b-ethereum", "b", ["eth_*", "trace_*"], true)

    const { pipeline, urls, notes } = stack({
      upstreams: [a, b],
      responder: (url, body) =>
        url.includes("a-ethereum")
          ? json(
              {
                jsonrpc: "2.0",
                id: (body as { id: unknown }).id,
                error: { code: -32601, message: "method not found" },
              },
              400,
            )
          : answerAll(body, "0xtraced"),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "trace_block", params: ["0x1"] }),
    )

    expect((result.body as { result: unknown }).result).toBe("0xtraced")
    expect(urls).toHaveLength(2)
    expect(notes.hasMethodNote("a-ethereum", "trace_block")).toBe(true)
  })

  test("an envelope without id on a 4xx is matched positionally for a single item", async () => {
    const { pipeline } = stack({
      upstreams: [instance("a-ethereum", "a", ["eth_*"], true)],
      responder: () =>
        json({ jsonrpc: "2.0", error: { code: -32000, message: "nonce too low" } }, 409),
      random: () => 0,
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_call", params: [{ to: "0xabc" }] }),
    )

    expect((result.body as { error: { code: number; message: string } }).error).toEqual({
      code: -32000,
      message: "nonce too low",
    })
  })
})

describe("integration: one key, two chains, only one URL wrong (Validasi #4)", () => {
  // Deliberately identical `provider:` so the two instances share ONE identity
  // `(provider, token)` — the documented behaviour, not an accident.
  const sharedKey = (name: string, url: string): UpstreamInstanceConfig => ({
    name,
    provider: "shared",
    package: "generic",
    url_template: url,
    apikeys: [{ token: "one-token", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] }],
    methods: ["eth_*"],
    archive: true,
  })

  test("the correct instance derives the same diagnosis and answers -32008 without a fetch", async () => {
    const clock = () => 0
    const { fetchImpl, urls } = makeFetch((url, body) =>
      url.includes("wrong") ? html404() : answerAll(body, "0x2a"),
    )
    const bucketRegistry = new BucketRegistry(clock)
    const { logger, records } = recordingLogger()
    const deps = { bucketRegistry, logger, now: clock, fetchImpl }
    const random = () => 0

    const wrong = createPoolAdapter(sharedKey("wrong-chain", "https://wrong.test/{apikey}"), deps, { random })
    const right = createPoolAdapter(sharedKey("right-chain", "https://right.test/{apikey}"), deps, { random })

    const pipelineFor = (chain: string, adapter: typeof wrong): PipelineDeps => ({
      chain,
      upstreams: [toView({ config: { name: adapter.name, provider: adapter.provider }, adapter })],
      notes: new RuntimeNotes(),
      logger,
      now: clock,
      timeouts,
      blockedMethods: [],
      maxTotalAttempts: 0,
      random,
    })

    const first = await handle(
      pipelineFor("wrongchain", wrong),
      parseRequest({ id: 1, method: "eth_blockNumber", params: [] }),
    )
    expect((first.body as { error: { code: number } }).error.code).toBe(-32008)
    expect(urls).toHaveLength(1)

    // The other chain never called out: the shared identity already carries the
    // diagnosis, and the router skips the instance instead of spending quota.
    const second = await handle(
      pipelineFor("rightchain", right),
      parseRequest({ id: 2, method: "eth_blockNumber", params: [] }),
    )
    expect(urls).toHaveLength(1)
    expect((second.body as { error: { code: number } }).error.code).toBe(-32008)

    // Traceability: only the instance that was actually rejected logged a warn.
    const rejections = records.filter(
      (record) => record.message === "upstream rejected the call as misconfigured",
    )
    expect(rejections).toHaveLength(1)
    expect(rejections[0]!.fields?.upstream).toBe("wrong-chain")
    // And the client never learns the instance name.
    expect(JSON.stringify(second.body)).not.toContain("wrong-chain")
    expect(JSON.stringify(second.body)).not.toContain("one-token")
  })
})

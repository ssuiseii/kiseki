import { describe, expect, test } from "bun:test"
import {
  BucketRegistry,
  RuntimeNotes,
  silentLogger,
  type UpstreamAdapter,
  type UpstreamInstanceConfig,
} from "upstream-core"
import { createAdapter as createAnkrAdapter } from "upstream-ankr"
import { parseRequest } from "../src/batch"
import { buildTimeoutPolicy } from "../src/classify"
import { toView } from "../src/capability"
import { handle, type PipelineDeps } from "../src/pipeline"

/**
 * M5 — end-to-end: a real `kiseki_*` client request through the REAL pipeline
 * and the REAL Ankr adapter, with `fetch` replaced by a scripted responder.
 *
 * The Ankr split is modelled exactly as `kiseki.yaml` declares it (two instances,
 * because one endpoint cannot serve both APIs — plan/notes-m0.md §1):
 *
 *   ankr-ethereum-aapi  → https://rpc.ankr.com/multichain/{key}  methods: ankr_*
 *   ankr-ethereum-node  → https://rpc.ankr.com/eth/{key}         methods: eth_*
 */

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"

const timeouts = buildTimeoutPolicy({
  default_seconds: 30,
  heavy_seconds: 120,
  heavy_methods: ["trace_*", "debug_*", "replay_*"],
})

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

/** Answer every request in the body with the same result (single or batch). */
const answerAll = (body: unknown, result: unknown): Response => {
  if (Array.isArray(body)) {
    return json(body.map((request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, result })))
  }
  return json({ jsonrpc: "2.0", id: (body as { id: unknown }).id, result })
}

const errorAll = (body: unknown, code: number, message: string): Response => {
  const error = { code, message }
  if (Array.isArray(body)) {
    return json(body.map((request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, error })))
  }
  return json({ jsonrpc: "2.0", id: (body as { id: unknown }).id, error })
}

const aapiConfig: UpstreamInstanceConfig = {
  name: "ankr-ethereum-aapi",
  // Separate identity from the node half: API credits and RPS are different
  // units, and sharing one identity with two bucket specs rebuilds the bucket.
  provider: "ankr-aapi",
  package: "ankr",
  url_template: "https://rpc.ankr.com/multichain/{apikey}",
  apikeys: [
    { token: "key-a", label: "a", buckets: [{ capacity: 100_000, refill_per_second: 1 }] },
  ],
  methods: ["ankr_*"],
  archive: false,
}

const nodeConfig: UpstreamInstanceConfig = {
  name: "ankr-ethereum-node",
  provider: "ankr-node",
  package: "generic",
  url_template: "https://rpc.ankr.com/eth/{apikey}",
  apikeys: [
    { token: "key-a", label: "a", buckets: [{ capacity: 1_000, refill_per_second: 1 }] },
  ],
  methods: ["eth_*"],
  archive: false,
}

const transfersResult = {
  transfers: [
    {
      fromAddress: VITALIK,
      toAddress: "0xF51BC4633F5924465c8c6317169Faf3E4312E82F",
      contractAddress: USDT,
      valueRawInteger: "340000000000000000000",
      tokenDecimals: 18,
      transactionHash: "0x932cdcd0c76e08cf8730af625a5bb5932b8412b09f9806285271fd9ff2ce28f7",
      blockHeight: 21_000_000,
      logIndex: 3,
      timestamp: 1_700_000_000,
    },
  ],
  nextPageToken: "cursor-1",
}

type StackOptions = {
  aapi?: UpstreamInstanceConfig
  node?: UpstreamInstanceConfig
  responder: (url: string, body: unknown) => Response
  random?: () => number
}

const stack = (options: StackOptions) => {
  const urls: string[] = []
  const bodies: unknown[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    const body: unknown = JSON.parse(String(init?.body ?? "null"))
    bodies.push(body)
    return options.responder(url, body)
  }) as unknown as typeof fetch

  const bucketRegistry = new BucketRegistry(() => 0)
  const deps = { bucketRegistry, logger: silentLogger, now: () => 0, fetchImpl }

  const aapi = createAnkrAdapter(options.aapi ?? aapiConfig, deps)
  const node = createAnkrAdapter(options.node ?? nodeConfig, deps)
  const adapters: { config: UpstreamInstanceConfig; adapter: UpstreamAdapter }[] = [
    { config: aapiConfig, adapter: aapi },
    { config: nodeConfig, adapter: node },
  ]

  const pipeline: PipelineDeps = {
    chain: "ethereum",
    upstreams: adapters.map((entry) => toView(entry)),
    notes: new RuntimeNotes(),
    logger: silentLogger,
    now: () => 0,
    timeouts,
    blockedMethods: ["eth_sendTransaction"],
    maxTotalAttempts: 0,
    random: options.random ?? (() => 0),
  }

  return { pipeline, urls, bodies, bucketRegistry }
}

describe("M5: kiseki_* end-to-end through the Ankr adapter", () => {
  test("kiseki_getTokenTransfers is served by the AAPI instance and answered canonically", async () => {
    const { pipeline, urls, bodies } = stack({
      responder: (_, body) => answerAll(body, transfersResult),
    })

    const result = await handle(
      pipeline,
      parseRequest({
        id: 1,
        method: "kiseki_getTokenTransfers",
        params: [{ address: VITALIK }],
      }),
    )

    // Only the AAPI endpoint was called — the node instance is not a candidate.
    expect(urls).toEqual(["https://rpc.ankr.com/multichain/key-a"])
    // The wire method is the provider's; the params carry the Ankr alias and
    // are an OBJECT with named fields, exactly as the AAPI documents them.
    expect(bodies[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "ankr_getTokenTransfers",
      params: { blockchain: "eth", address: VITALIK },
    })

    // The client sees the canonical shape, never the provider's.
    expect((result.body as { result: unknown }).result).toEqual({
      chain: "ethereum",
      transfers: [
        {
          transactionHash: "0x932cdcd0c76e08cf8730af625a5bb5932b8412b09f9806285271fd9ff2ce28f7",
          blockNumber: "0x1406f40",
          logIndex: 3,
          from: VITALIK,
          to: "0xF51BC4633F5924465c8c6317169Faf3E4312E82F",
          contract: USDT,
          value: { value: "340", valueRaw: "0x126e72a69a50d00000" },
          timestamp: "2023-11-14T22:13:20.000Z",
        },
      ],
      nextPage: "cursor-1",
    })
  })

  test("a plan/entitlement gate regroups at runtime and the node instance answers eth_*", async () => {
    const { pipeline, urls } = stack({
      responder: (url, body) =>
        url.includes("multichain")
          ? errorAll(body, -32075, "Method disabled, reason: restricted by blockchain schema")
          : answerAll(body, "0xblock"),
    })

    // `kiseki_*` is only on the AAPI instance; when it is gated, the item must
    // end as an error — but the regroup must not send ankr_* to the node endpoint.
    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "kiseki_getTokenTransfers", params: [{ address: VITALIK }] }),
    )

    // One attempt only: the node instance does not claim kiseki_*.
    expect(urls).toEqual(["https://rpc.ankr.com/multichain/key-a"])
    // The client gets an error naming the method it asked for.
    const body = result.body as { error?: { message: string } }
    expect(body.error).toBeDefined()
  })

  test("a raw ankr_* method passes through untouched", async () => {
    const { pipeline, bodies } = stack({
      responder: (_, body) => answerAll(body, { holders: ["0xabc"] }),
    })

    const result = await handle(
      pipeline,
      parseRequest({
        id: 1,
        method: "ankr_getNFTHolders",
        params: [{ blockchain: "eth", contractAddress: USDT }],
      }),
    )

    // Raw result, no canonical translation applied.
    expect((result.body as { result: unknown }).result).toEqual({ holders: ["0xabc"] })
    expect((bodies[0] as { method: string }).method).toBe("ankr_getNFTHolders")
  })

  test("an eth_* method goes to the node instance, not the AAPI one", async () => {
    const { pipeline, urls, bodies } = stack({
      responder: (_, body) => answerAll(body, "0x1234"),
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "eth_blockNumber", params: [] }),
    )

    expect(urls).toEqual(["https://rpc.ankr.com/eth/key-a"])
    expect((bodies[0] as { method: string }).method).toBe("eth_blockNumber")
    expect((result.body as { result: unknown }).result).toBe("0x1234")
  })

  test("700 credits are deducted for a canonical call, and only 1 for eth_*", async () => {
    const { pipeline, bucketRegistry } = stack({
      responder: (_, body) => answerAll(body, "0x1"),
    })

    await handle(
      pipeline,
      parseRequest({ id: 1, method: "kiseki_getTokenTransfers", params: [{ address: VITALIK }] }),
    )
    // The AAPI identity is metered in credits: 100000 − 700.
    expect(bucketRegistry.peek("ankr-aapi", "key-a")!.credits(0)).toEqual([100_000 - 700])
    // The node identity is untouched by an Advanced API call.
    expect(bucketRegistry.peek("ankr-node", "key-a")!.credits(0)).toEqual([1_000])

    await handle(pipeline, parseRequest({ id: 2, method: "eth_blockNumber", params: [] }))
    // Node methods cost 1 and never touch the AAPI credit pool.
    expect(bucketRegistry.peek("ankr-node", "key-a")!.credits(0)).toEqual([1_000 - 1])
    expect(bucketRegistry.peek("ankr-aapi", "key-a")!.credits(0)).toEqual([100_000 - 700])
  })

  test("a mixed batch is split per capability and merged by originalIndex", async () => {
    const { pipeline, urls, bodies } = stack({
      responder: (url, body) =>
        url.includes("multichain")
          ? answerAll(body, transfersResult)
          : answerAll(body, "0xnode"),
    })

    const result = await handle(
      pipeline,
      parseRequest([
        { id: 0, method: "eth_blockNumber", params: [] },
        { id: 1, method: "kiseki_getTokenTransfers", params: [{ address: VITALIK }] },
        { id: 2, method: "ankr_getTokenPrice", params: [{ blockchain: "eth", contractAddress: USDT }] },
      ]),
    )

    // Two HTTP calls: the node endpoint for eth_*, the AAPI one for the rest.
    expect(urls).toHaveLength(2)
    expect(urls.filter((url) => url.includes("/eth/"))).toHaveLength(1)
    expect(urls.filter((url) => url.includes("/multichain/"))).toHaveLength(1)

    // Per-item params shape: the canonical item is translated to an OBJECT,
    // while the raw ankr_* item forwards the client's params untouched.
    const aapiBody = bodies.find((body) =>
      Array.isArray(body) && body.some((r: { method: string }) => r.method === "ankr_getTokenTransfers"),
    ) as { method: string; params: unknown }[]
    const canonical = aapiBody.find((r) => r.method === "ankr_getTokenTransfers")!
    expect(Array.isArray(canonical.params)).toBe(false)
    expect((canonical.params as { blockchain: string }).blockchain).toBe("eth")
    const raw = aapiBody.find((r) => r.method === "ankr_getTokenPrice")!
    // The raw method is NOT translated: the client's array survives verbatim.
    expect(raw.params).toEqual([{ blockchain: "eth", contractAddress: USDT }])

    const body = result.body as unknown[]
    expect(body).toHaveLength(3)
    expect((body[0] as { result: unknown }).result).toBe("0xnode")
    // Canonical item → canonical shape.
    expect((body[1] as { result: { chain: string } }).result.chain).toBe("ethereum")
    // Raw item → untouched upstream result.
    expect((body[2] as { result: unknown }).result).toEqual(transfersResult)
  })

  test("invalid canonical params are rejected before any fetch", async () => {
    const { pipeline, urls } = stack({
      responder: (_, body) => answerAll(body, transfersResult),
    })

    const result = await handle(
      pipeline,
      parseRequest({
        id: 1,
        method: "kiseki_getTokenTransfers",
        params: [{ address: "not-an-address" }],
      }),
    )

    expect(urls).toEqual([])
    const body = result.body as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
  })

  test("a provider -32602 is forwarded as a final domain error, never regrouped", async () => {
    const { pipeline, urls } = stack({
      responder: (_, body) =>
        errorAll(body, -32602, "invalid argument 0: invalid params: invalid blockchain name"),
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "kiseki_getTokenTransfers", params: [{ address: VITALIK }] }),
    )

    // One attempt: a client-side error must not burn another 700 credits.
    expect(urls).toHaveLength(1)
    expect((result.body as { error: { code: number } }).error.code).toBe(-32602)
  })

  test("a 429 from the AAPI endpoint is surfaced as a rate-limit answer", async () => {
    const { pipeline } = stack({
      responder: () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32090, message: "Too many requests, reason: call rate limit exhausted, retry in 10s" },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } },
        ),
    })

    const result = await handle(
      pipeline,
      parseRequest({ id: 1, method: "kiseki_getTokenPrice", params: [{ contract: USDT }] }),
    )

    expect(result.status).toBe(429)
    // The drained credit bucket needs minutes to refill (1200 credits at 1/s),
    // so the honest answer is the ceiling, not the provider's 10s hint.
    expect(result.retryAfterMs).toBe(30_000)
  })
})

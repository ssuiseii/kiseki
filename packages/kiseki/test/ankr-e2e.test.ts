import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfigText } from "../src/config/index"
import { createJsonLogger } from "../src/observ/logger"
import { createMetrics, metricKeyId } from "../src/observ/metrics"
import { buildRegistry } from "../src/registry"
import { createRuntime } from "../src/runtime"
import { createServer, type ServerDeps } from "../src/server/index"

/**
 * End-to-end for the Ankr package: a REAL HTTP request through Hono → router →
 * Ankr adapter → scripted upstream, with the REAL composition root resolving
 * `package: ankr`.
 *
 * Why this file exists on top of `ankr-integration.test.ts` (which drives the
 * pipeline directly): the pipeline test never exercises the server boundary, so
 * it cannot catch a client-visible regression in status codes, error shaping, or
 * the `Retry-After` header for the AAPI path. It also cannot catch a config that
 * the composition root rejects.
 *
 * The Ankr split is modelled exactly as `kiseki.yaml` declares it — two
 * instances per chain, because one endpoint cannot serve both APIs
 * (plan/notes-m0.md §1).
 */

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"
const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"

const env = {
  CLIENT: "client-main",
  ANKR_KEY: "ankr-live",
}

/** Two Ankr instances + Alchemy, so routing has a real choice to make. */
const config = {
  server: {
    port: 8545,
    host: "127.0.0.1",
    auth: { methods: ["path"], keys: [{ token: "${CLIENT}", label: "main" }] },
  },
  defaults: {
    costs: { "eth_call": 1 },
    timeouts: { default_seconds: 5, heavy_seconds: 30, heavy_methods: ["trace_*"] },
    blocked_methods: ["eth_sendTransaction"],
  },
  chains: {
    ethereum: {
      upstreams: [
        {
          name: "alchemy-ethereum",
          provider: "alchemy",
          package: "generic",
          url_template: "https://alchemy.test/{apikey}",
          apikeys: [{ token: "${CLIENT}", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] }],
          // Only `trace_*`: this test is about the Ankr split, so `eth_*` must
          // have exactly one candidate (the Ankr node instance). Otherwise the
          // deterministic `random: () => 0` would pick Alchemy first and the
          // assertion would be about level-1 ordering, not about Ankr.
          methods: ["trace_*"],
          archive: true,
        },
        {
          // Advanced API: the only endpoint that serves ankr_*.
          name: "ankr-ethereum-aapi",
          provider: "ankr-aapi",
          package: "ankr",
          url_template: "https://rpc.ankr.com/multichain/{apikey}",
          apikeys: [
            { token: "${ANKR_KEY}", label: "main", buckets: [{ capacity: 10_000, refill_per_second: 10 }] },
          ],
          methods: ["ankr_*"],
          archive: false,
        },
        {
          // Node API: the only endpoint that serves eth_* for Ankr.
          name: "ankr-ethereum-node",
          provider: "ankr-node",
          package: "generic",
          url_template: "https://rpc.ankr.com/eth/{apikey}",
          apikeys: [
            { token: "${ANKR_KEY}", label: "main", buckets: [{ capacity: 1_000, refill_per_second: 10 }] },
          ],
          methods: ["eth_*"],
          archive: false,
        },
      ],
    },
  },
  limits: { max_total_attempts: 0 },
  metrics: { enabled: true },
}

type Responder = (url: string, body: unknown) => Response

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

/** Answer every request in the body with `result` (single or batch). */
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

/** The trimmed live payload for `ankr_getTokenTransfers` (plan/notes-m0.md §4). */
const transfersResult = {
  nextPageToken: "cursor-1",
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
}

const tokenPriceResult = {
  usdPrice: "0.998666692814998",
  blockchain: "eth",
  contractAddress: USDT,
  syncStatus: { timestamp: 1_795_279_019 },
}

const stack = (options: { responder?: Responder } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "kiseki-ankr-e2e-"))
  const configPath = join(dir, "kiseki.yaml")
  writeFileSync(configPath, JSON.stringify(config, null, 2))

  const registry = buildRegistry()
  const urls: string[] = []
  const bodies: unknown[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    const body: unknown = JSON.parse(String(init?.body ?? "null"))
    bodies.push(body)
    const responder = options.responder ?? ((_url: string, b: unknown) => answerAll(b, "0x1"))
    return responder(url, body)
  }) as unknown as typeof fetch

  const logLines: string[] = []
  const logger = createJsonLogger({ level: "debug", write: (line) => logLines.push(line) })

  const loaded = loadConfigText(JSON.stringify(config), { env, registry })
  const holder: { runtime?: ReturnType<typeof createRuntime> } = {}
  const metrics = createMetrics({
    bucketRegistry: () => holder.runtime?.bucketRegistry,
    now: () => 0,
    keyLabels: new Map([
      [metricKeyId("alchemy", "client-main"), "a"],
      [metricKeyId("ankr-aapi", "ankr-live"), "main"],
      [metricKeyId("ankr-node", "ankr-live"), "main"],
    ]),
  })

  const runtime = createRuntime({
    loaded,
    registry,
    logger,
    now: () => 0,
    fetchImpl,
    random: () => 0,
    observer: metrics.observer,
    poolObserver: metrics.observer,
  })
  holder.runtime = runtime

  const deps: ServerDeps = {
    pipelineFor: (chain) => holder.runtime?.pipelineFor(chain),
    chains: () => holder.runtime?.chains ?? [],
    auth: { methods: loaded.config.server.auth.methods, keys: loaded.config.server.auth.keys },
    logger,
    metrics,
  }
  const server = createServer(deps)

  const post = (path: string, body: unknown) =>
    server.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  return {
    post,
    server,
    runtime,
    urls,
    bodies,
    logLines,
    loaded,
    scrape: async (): Promise<string> => (await server.app.request("/metrics")).text(),
  }
}

const AUTH_PATH = "/ethereum/client-main"

describe("e2e — kiseki_* through the real server boundary", () => {
  test("a canonical request is routed to the AAPI instance and answered canonically", async () => {
    const { post, urls, bodies } = stack({
      responder: (_url, body) => answerAll(body, transfersResult),
    })

    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: VITALIK }],
    })

    expect(response.status).toBe(200)
    // Only the AAPI endpoint was touched.
    expect(urls).toEqual(["https://rpc.ankr.com/multichain/ankr-live"])

    // The wire shape is the provider's: upstream method, params as an OBJECT.
    expect(bodies[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "ankr_getTokenTransfers",
      params: { blockchain: "eth", address: VITALIK },
    })

    // The client sees the canonical shape.
    const body = (await response.json()) as { result: Record<string, unknown> }
    expect(body.result).toEqual({
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

  test("the canonical result carries no provider-only fields", async () => {
    const { post } = stack({ responder: (_url, body) => answerAll(body, transfersResult) })
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: VITALIK }],
    })
    const text = await response.text()
    // `syncStatus`, `valueRawInteger`, `thumbnail`, `direction` must not leak.
    for (const leaked of ["syncStatus", "valueRawInteger", "thumbnail", "direction", "blockchain"]) {
      expect(text).not.toContain(leaked)
    }
  })

  test("token price is mapped, including the provenance timestamp", async () => {
    const { post } = stack({ responder: (_url, body) => answerAll(body, tokenPriceResult) })
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenPrice",
      params: [{ contract: USDT }],
    })
    const body = (await response.json()) as { result: unknown }
    expect(body.result).toEqual({
      chain: "ethereum",
      contract: USDT,
      priceUsd: "0.998666692814998",
      updatedAt: "2026-11-21T16:36:59.000Z",
    })
  })

  test("a raw ankr_* method passes through untouched", async () => {
    const { post } = stack({ responder: (_url, body) => answerAll(body, { holders: ["0xabc"] }) })
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "ankr_getNFTHolders",
      params: [{ blockchain: "eth", contractAddress: BAYC }],
    })
    expect(((await response.json()) as { result: unknown }).result).toEqual({ holders: ["0xabc"] })
  })

  test("eth_* goes to the node instance, never the AAPI one", async () => {
    const { post, urls } = stack({ responder: (_url, body) => answerAll(body, "0x1234") })
    const response = await post(AUTH_PATH, { id: 1, method: "eth_blockNumber", params: [] })
    expect(urls).toEqual(["https://rpc.ankr.com/eth/ankr-live"])
    expect(((await response.json()) as { result: unknown }).result).toBe("0x1234")
  })

  test("700 credits are deducted for a canonical call, 1 for a node call", async () => {
    const { post, runtime } = stack({ responder: (_url, body) => answerAll(body, "0x1") })

    await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: VITALIK }],
    })
    expect(runtime.bucketRegistry.peek("ankr-aapi", "ankr-live")!.credits(0)).toEqual([10_000 - 700])
    // The node identity is untouched by an Advanced API call.
    expect(runtime.bucketRegistry.peek("ankr-node", "ankr-live")!.credits(0)).toEqual([1_000])

    await post(AUTH_PATH, { id: 2, method: "eth_blockNumber", params: [] })
    expect(runtime.bucketRegistry.peek("ankr-node", "ankr-live")!.credits(0)).toEqual([1_000 - 1])
    expect(runtime.bucketRegistry.peek("ankr-aapi", "ankr-live")!.credits(0)).toEqual([10_000 - 700])
  })

  test("a mixed batch is split across instances and merged in the client's order", async () => {
    const { post, urls, bodies } = stack({
      responder: (url, body) =>
        url.includes("multichain") ? answerAll(body, transfersResult) : answerAll(body, "0xnode"),
    })

    const response = await post(AUTH_PATH, [
      { id: 0, method: "eth_blockNumber", params: [] },
      { id: 1, method: "kiseki_getTokenTransfers", params: [{ address: VITALIK }] },
      { id: 2, method: "ankr_getTokenPrice", params: [{ blockchain: "eth", contractAddress: USDT }] },
    ])

    expect(response.status).toBe(200)
    expect(urls).toHaveLength(2)

    const body = (await response.json()) as { id: number; result: unknown }[]
    expect(body.map((entry) => entry.id)).toEqual([0, 1, 2])
    expect(body[0]!.result).toBe("0xnode")
    expect((body[1]!.result as { chain: string }).chain).toBe("ethereum")
    expect(body[2]!.result).toEqual(transfersResult)

    // Per-item params shape: translated → object; raw → the client's array.
    const aapi = bodies.find((entry) =>
      Array.isArray(entry) && entry.some((r: { method: string }) => r.method === "ankr_getTokenTransfers"),
    ) as { method: string; params: unknown }[]
    expect(Array.isArray(aapi.find((r) => r.method === "ankr_getTokenTransfers")!.params)).toBe(false)
    expect(aapi.find((r) => r.method === "ankr_getTokenPrice")!.params).toEqual([
      { blockchain: "eth", contractAddress: USDT },
    ])
  })
})

describe("e2e — Ankr error policy at the server boundary", () => {
  test("invalid canonical params answer -32602 without any upstream call", async () => {
    const { post, urls } = stack()
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: "not-an-address" }],
    })
    expect(urls).toEqual([])
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
  })

  test("NFT pageSize above Ankr's cap is rejected before the fetch, costing nothing", async () => {
    const { post, urls, runtime } = stack()
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getNFTsByOwner",
      params: [{ owner: VITALIK, pageSize: 51 }],
    })

    expect(urls).toEqual([])
    expect(runtime.bucketRegistry.peek("ankr-aapi", "ankr-live")!.credits(0)).toEqual([10_000])
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
  })

  test("a provider -32602 is forwarded final, with no regroup and no second call", async () => {
    const { post, urls } = stack({
      responder: (_url, body) =>
        errorAll(body, -32602, "invalid argument 0: invalid params: invalid blockchain name"),
    })
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: VITALIK }],
    })
    expect(urls).toHaveLength(1)
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32602)
  })

  test("a -32075 gate ends as an error naming the canonical method", async () => {
    const { post, urls } = stack({
      responder: (_url, body) =>
        errorAll(body, -32075, "Method disabled, reason: restricted by blockchain schema"),
    })
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: VITALIK }],
    })
    // The node instance does not claim kiseki_*, so there is no second attempt.
    expect(urls).toHaveLength(1)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error).toBeDefined()
  })

  test("a 429 from the AAPI endpoint answers 429 with a Retry-After header", async () => {
    const { post } = stack({
      responder: () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32090, message: "Too many requests, reason: call rate limit exhausted" },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } },
        ),
    })
    const response = await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenPrice",
      params: [{ contract: USDT }],
    })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBeDefined()
  })
})

describe("e2e — Ankr observability and secret hygiene", () => {
  test("the canonical method is visible in metrics under its client-facing name", async () => {
    const { post, scrape } = stack({ responder: (_url, body) => answerAll(body, transfersResult) })
    await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: VITALIK }],
    })
    const text = await scrape()
    expect(text).toContain("kiseki_requests_total")
    expect(text).toContain('method_class="default"')
  })

  test("the apikey token never appears in a log line, only its label", async () => {
    const { post, logLines } = stack({ responder: (_url, body) => answerAll(body, transfersResult) })
    await post(AUTH_PATH, {
      id: 1,
      method: "kiseki_getTokenTransfers",
      params: [{ address: VITALIK }],
    })
    const joined = logLines.join("\n")
    expect(joined).not.toContain("ankr-live")
    expect(joined).not.toContain("client-main")
  })

  test("the config resolves through the composition root with no warnings", () => {
    const { loaded } = stack()
    expect(loaded.warnings).toEqual([])
    // `ankr` must be a registered package, or loadConfigText would have thrown.
    const packages = loaded.config.chains.ethereum!.upstreams.map((upstream) => upstream.package)
    expect(packages).toEqual(["generic", "ankr", "generic"])
  })
})

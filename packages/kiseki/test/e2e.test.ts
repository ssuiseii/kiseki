import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfigText } from "../src/config/index"
import { createJsonLogger } from "../src/observ/logger"
import { createMetrics, metricKeyId } from "../src/observ/metrics"
import { buildRegistry } from "../src/registry"
import { reloadRuntime } from "../src/reload"
import { createRuntime } from "../src/runtime"
import { createServer, type ServerDeps } from "../src/server/index"

/**
 * End-to-end at the server boundary: REAL runtime, REAL adapters, REAL pool,
 * REAL metrics — only `fetch` is replaced by a scripted responder.
 *
 * This is the M4 DoD in one file: a request goes in through Hono, is routed by the
 * real two-level machinery, and comes back out shaped, counted and logged. The
 * metrics assertions read the actual `/metrics` document, so a label that drifts
 * from §18.1 fails here rather than in production.
 */

const env = {
  CLIENT: "client-main",
  KEY_A: "alchemy-a",
  KEY_B: "alchemy-b",
}

const config = (overrides: { methods?: string[]; metricsEnabled?: boolean } = {}) => ({
  server: {
    port: 8545,
    host: "127.0.0.1",
    auth: {
      methods: ["path", "bearer"],
      keys: [{ token: "${CLIENT}", label: "main" }],
    },
  },
  defaults: {
    costs: { "trace_*": 5 },
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
          apikeys: [
            { token: "${KEY_A}", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
            { token: "${KEY_B}", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
          ],
          methods: overrides.methods ?? ["eth_*", "trace_*"],
          archive: true,
        },
      ],
    },
  },
  limits: { max_total_attempts: 0 },
  metrics: { enabled: overrides.metricsEnabled ?? true },
})

type Responder = (url: string, body: unknown) => Response

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

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

/** A full stack: config file → runtime → metrics → server, with a scripted upstream. */
const stack = (options: { responder?: Responder; configPath?: string } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "kiseki-e2e-"))
  const configPath = options.configPath ?? join(dir, "kiseki.yaml")
  writeFileSync(configPath, JSON.stringify(config(), null, 2))

  const registry = buildRegistry()
  const urls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    const body: unknown = JSON.parse(String(init?.body ?? "null"))
    const responder = options.responder ?? ((_url: string, requestBody: unknown) => answerAll(requestBody, "0x1"))
    return responder(url, body)
  }) as unknown as typeof fetch

  const logLines: string[] = []
  const logger = createJsonLogger({ level: "debug", write: (line) => logLines.push(line) })

  const loaded = loadConfigText(JSON.stringify(config()), { env, registry })
  const holder: { runtime?: ReturnType<typeof createRuntime> } = {}
  const metrics = createMetrics({
    bucketRegistry: () => holder.runtime?.bucketRegistry,
    // Must share the runtime's clock, or a lazy refill computes an absurd elapsed
    // time and reports every bucket as full.
    now: () => 0,
    keyLabels: new Map([
      [metricKeyId("alchemy", "alchemy-a"), "a"],
      [metricKeyId("alchemy", "alchemy-b"), "b"],
    ]),
  })

  const runtime = createRuntime({
    loaded,
    registry,
    logger,
    now: () => 0,
    fetchImpl,
    // Deterministic draws: 0 always selects the first eligible entry, so key-level
    // assertions below name a specific key instead of accepting either.
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

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    server.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })

  return {
    post,
    server,
    metrics,
    runtime,
    holder,
    urls,
    logLines,
    configPath,
    registry,
    reload: () =>
      reloadRuntime({
        configPath,
        env,
        registry,
        logger,
        now: () => 0,
        current: holder.runtime!,
        fetchImpl,
        random: () => 0,
        observer: metrics.observer,
        poolObserver: metrics.observer,
      }),
    /** Metrics text, fetched through the real route. */
    scrape: async (): Promise<string> => {
      const response = await server.app.request("/metrics")
      return response.text()
    },
  }
}

describe("e2e — a real request through the real stack", () => {
  test("a single eth_blockNumber is routed, charged and answered", async () => {
    const { post, urls, runtime } = stack()
    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { result: unknown }).result).toBe("0x1")
    expect(urls).toHaveLength(1)
    // Exactly one key was charged, and the URL carries a real token from config.
    const charged = runtime.bucketRegistry
      .all()
      .map((state) => state.credits(0)[0]!)
      .sort((left, right) => left - right)
    expect(charged).toEqual([99, 100])
  })

  test("a batch is split, routed and merged in the client's order", async () => {
    const { post } = stack({
      responder: (_url, body) => answerAll(body, "ok"),
    })
    const response = await post("/ethereum/client-main", [
      { id: 0, method: "eth_blockNumber", params: [] },
      { id: 1, method: "trace_block", params: ["0x1"] },
      { id: 2, method: "eth_chainId", params: [] },
    ])
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: number; result: string }[]
    expect(body.map((entry) => entry.id)).toEqual([0, 1, 2])
    expect(body.every((entry) => entry.result === "ok")).toBe(true)
  })

  test("a level-2 key failover is invisible to the client (§10.2)", async () => {
    let calls = 0
    const { post, urls } = stack({
      responder: (_url, body) => {
        calls += 1
        if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "1" } })
        return answerAll(body, "0xok")
      },
    })

    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { result: unknown }).result).toBe("0xok")
    // Two HTTP calls, two different keys, one client-visible answer.
    expect(urls).toHaveLength(2)
    expect(urls[0]).not.toBe(urls[1])
  })
})

describe("e2e — /metrics reflects real traffic (§18.1)", () => {
  test("a request increments requests_total with chain, class and client label", async () => {
    const { post, scrape } = stack()
    await post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })

    const text = await scrape()
    expect(text).toContain('kiseki_requests_total{chain="ethereum",method_class="default",client_label="main"} 1')
  })

  test("a heavy method is labelled heavy, not default", async () => {
    const { post, scrape } = stack()
    await post("/ethereum/client-main", { id: 1, method: "trace_block", params: ["0x1"] })

    const text = await scrape()
    expect(text).toContain('method_class="heavy"')
    expect(text).not.toContain('kiseki_requests_total{chain="ethereum",method_class="default",client_label="main"}')
  })

  test("a batch counts its items", async () => {
    const { post, scrape } = stack()
    await post("/ethereum/client-main", [
      { id: 0, method: "eth_blockNumber", params: [] },
      { id: 1, method: "eth_chainId", params: [] },
    ])
    const text = await scrape()
    expect(text).toContain('kiseki_batch_items_total{chain="ethereum",client_label="main"} 2')
  })

  test("a pre-flight rejection is counted with its reason", async () => {
    const { post, scrape } = stack({ responder: (_u, b) => answerAll(b, "x") })
    await post("/ethereum/client-main", { id: 1, method: "debug_traceTransaction", params: ["0x1"] })
    const text = await scrape()
    expect(text).toContain('kiseki_preflight_rejects_total{chain="ethereum",reason="method"} 1')
  })

  test("level-1 and level-2 attempts are both visible, with the apikey LABEL not its token", async () => {
    const { post, scrape } = stack()
    await post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })

    const text = await scrape()
    expect(text).toContain('kiseki_upstream_attempts_total{upstream="alchemy-ethereum",outcome="success"} 1')
    expect(text).toContain('kiseki_pool_key_attempts_total{upstream="alchemy-ethereum",apikey="')
    expect(text).toContain('kiseki_upstream_latency_seconds_count{upstream="alchemy-ethereum"} 1')
    // §18.2: no upstream token may appear in the scrape.
    expect(text).not.toContain("alchemy-a")
    expect(text).not.toContain("alchemy-b")
  })

  test("the credits gauge is live and labelled by apikey label", async () => {
    const { post, scrape } = stack()
    await post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })

    const text = await scrape()
    // Exactly one key was charged (the draw is weighted-random, §6.2), so the two
    // series must be labelled "a" and "b" and sum to 199 — never a reset to 200.
    const credits = [...text.matchAll(/kiseki_apikey_credits\{[^}]*apikey="([ab])"[^}]*\} (\S+)/g)].map(
      (match) => [match[1], Number(match[2])] as const,
    )
    expect(credits.map(([label]) => label).sort()).toEqual(["a", "b"])
    expect(credits.reduce((sum, [, value]) => sum + value, 0)).toBe(199)
  })

  test("a 429 from the only upstream becomes a client 429 and a failfast count", async () => {
    const { post, scrape } = stack({
      responder: () => new Response("", { status: 429, headers: { "retry-after": "2" } }),
    })

    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBeDefined()

    const text = await scrape()
    expect(text).toContain('kiseki_failfast_total{chain="ethereum",method_class="default"} 1')
  })

  test("/metrics needs no auth (#33)", async () => {
    const { server } = stack()
    const response = await server.app.request("/metrics")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
  })

  test("the scrape content-type is prom-client's, not text/html", async () => {
    const { server } = stack()
    const response = await server.app.request("/metrics")
    const body = await response.text()
    expect(body).toContain("# HELP kiseki_requests_total")
  })
})

describe("e2e — logs carry no secrets (§18.2)", () => {
  test("a full request cycle logs the client label and apikey label only", async () => {
    const { post, logLines } = stack()
    await post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })

    const text = logLines.join("\n")
    expect(text).toContain("main")
    // The client token and both upstream tokens must never appear.
    expect(text).not.toContain("client-main")
    expect(text).not.toContain("alchemy-a")
    expect(text).not.toContain("alchemy-b")
  })

  test("a request body's params never appear in a log line", async () => {
    const { post, logLines } = stack()
    await post("/ethereum/client-main", {
      id: 1,
      method: "eth_call",
      params: [{ to: "0xdeadbeefdeadbeef", data: "0xcafe" }, "latest"],
    })
    const text = logLines.join("\n")
    expect(text).not.toContain("0xdeadbeefdeadbeef")
    expect(text).not.toContain("0xcafe")
  })
})

describe("e2e — a reload behind a live server (§19)", () => {
  test("after a reload the new config serves, and old credits are still there", async () => {
    const e2e = stack()
    await e2e.post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })

    // One key has been charged 1 credit out of 100.
    const before = e2e.runtime.bucketRegistry.all().map((state) => state.credits(0)[0]!)
    expect(before.reduce((sum, value) => sum + value, 0)).toBe(199)

    const result = e2e.reload()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    e2e.holder.runtime = result.runtime

    // The same server object keeps serving, now from the new runtime.
    const response = await e2e.post("/ethereum/client-main", {
      id: 2,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(200)

    // Credits survived: two requests, one credit each, so the pool holds 198 of
    // its original 200 — never a reset to 200. Which key paid is a weighted-random
    // draw (§6.2), so only the total is asserted.
    const after = e2e.runtime.bucketRegistry.all().map((state) => state.credits(0)[0]!)
    expect(after).toHaveLength(2)
    expect(after.reduce((sum, value) => sum + value, 0)).toBe(198)
  })

  test("a failed reload leaves the server answering with the old config", async () => {
    const e2e = stack()
    // Corrupt the file on disk.
    writeFileSync(e2e.configPath, "server: {auth: {keys: []}}")

    const result = e2e.reload()
    expect(result.ok).toBe(false)

    // Still serving: the runtime was never replaced.
    const response = await e2e.post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(200)
  })

  test("a reload does not reset the metrics counters (§19 row 5)", async () => {
    const e2e = stack()
    await e2e.post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })
    const before = await e2e.scrape()
    expect(before).toContain('client_label="main"} 1')

    const result = e2e.reload()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    e2e.holder.runtime = result.runtime

    const after = await e2e.scrape()
    expect(after).toContain('kiseki_requests_total{chain="ethereum",method_class="default",client_label="main"} 1')
  })

  test("a reload resets runtime notes, so a previously-skipped upstream is eligible again", async () => {
    // Upstream A claims trace_* but answers -32601; the note excludes it next time.
    const e2e = stack({
      responder: (_url, body) => errorAll(body, -32601, "not available"),
    })
    await e2e.post("/ethereum/client-main", { id: 1, method: "trace_block", params: ["0x1"] })
    expect(e2e.runtime.notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(true)

    const result = e2e.reload()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    e2e.holder.runtime = result.runtime
    expect(result.runtime.notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(false)
  })
})

describe("e2e — a rejected apikey is a configuration problem, not capacity", () => {
  /** Ankr research note, section "apikey salah", quoted verbatim. */
  const ANKR_HTML_404 =
    "<html><head><title>404 Not Found</title></head>\n<body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>"

  const html404 = (): Response =>
    new Response(ANKR_HTML_404, { status: 404, headers: { "content-type": "text/html" } })

  test("the client gets 200 / -32008, and the metrics show the new label", async () => {
    const { post, scrape } = stack({ responder: () => html404() })

    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("retry-after")).toBeNull()
    const body = (await response.json()) as { error: { code: number; message: string; data?: unknown } }
    expect(body.error).toEqual({
      code: -32008,
      message: "upstream is misconfigured",
      data: { status: 404 },
    })

    const text = await scrape()
    // Level 2 sees the rejection on the key; level 1 sees the instance diagnosis.
    expect(text).toContain('kiseki_pool_key_attempts_total{upstream="alchemy-ethereum",apikey="a",outcome="misconfigured"} 1')
    expect(text).toContain('kiseki_upstream_attempts_total{upstream="alchemy-ethereum",outcome="misconfigured"} 1')
    // Not a fail-fast: nothing was starved.
    expect(text).not.toContain("kiseki_failfast_total{chain=\"ethereum\"")
    // The key is visibly rested, which is the operator's other signal.
    expect(text).toContain("kiseki_apikey_cooldown_seconds_remaining{provider=\"alchemy\",apikey=\"")
  })

  test("a second request during the cooldown never reaches the upstream", async () => {
    let calls = 0
    const { post } = stack({
      responder: () => {
        calls += 1
        return html404()
      },
    })

    await post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })
    const first = calls
    const second = await post("/ethereum/client-main", { id: 2, method: "eth_blockNumber", params: [] })

    expect(calls).toBe(first)
    expect(second.status).toBe(200)
    const body = (await second.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32008)
  })

  test("the scrape never leaks the token, only labels", async () => {
    const { post, scrape } = stack({ responder: () => html404() })
    await post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })
    const text = await scrape()
    expect(text).not.toContain("alchemy-a")
    expect(text).not.toContain("alchemy-b")
  })
})

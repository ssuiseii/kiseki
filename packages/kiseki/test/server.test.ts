import { describe, expect, test } from "bun:test"
import { RuntimeNotes, silentLogger, type Logger } from "upstream-core"
import { parseRequest } from "../src/batch"
import { buildTimeoutPolicy } from "../src/classify"
import { handle, type PipelineDeps } from "../src/pipeline"
import { createServer, redactPath, splitPath, type ServerDeps } from "../src/server/index"
import type { AuthConfig } from "../src/server/auth"
import { fakeAdapter, recordingLogger, success } from "./helpers"

/**
 * Server surface (design.md §16–17, implementation.md §7).
 *
 * The DoD for M4 is exactly these behaviours: auth ordering (401 before 404),
 * response shaping (200 partial vs 429 all-capacity), and the route tolerance
 * rules of §16.3. Requests go through Hono's `app.request`, so the real matcher,
 * the real middleware order and the real status codes are exercised — no
 * hand-rolled shortcut.
 */

const auth: AuthConfig = {
  methods: ["path", "bearer"],
  keys: [
    { token: "client-main", label: "main" },
    { token: "client-indexer", label: "indexer" },
  ],
}

const timeouts = buildTimeoutPolicy({
  default_seconds: 30,
  heavy_seconds: 120,
  heavy_methods: ["trace_*", "debug_*", "replay_*"],
})

type StackOptions = {
  adapters?: ReturnType<typeof fakeAdapter>[]
  auth?: AuthConfig
  logger?: Logger
  chains?: string[]
}

/**
 * A server over the REAL pipeline with fake adapters. `pipelineFor` builds a fresh
 * pipeline per call, which is what a reload does too, so the server's use of a
 * resolver function (rather than a captured map) is exercised.
 */
const stack = (options: StackOptions = {}) => {
  const adapters = options.adapters ?? [
    fakeAdapter({ name: "a", methods: ["eth_*", "trace_*"], outcomes: [success(0, "0x1")] }),
  ]
  const notes = new RuntimeNotes()
  const chains = options.chains ?? ["ethereum"]
  const calls: string[] = []

  const pipelineFor = (chain: string): PipelineDeps | undefined => {
    calls.push(chain)
    if (!chains.includes(chain)) return undefined
    return {
      chain,
      upstreams: adapters.map((entry) => entry.view),
      notes,
      logger: options.logger ?? silentLogger,
      now: () => 0,
      timeouts,
      blockedMethods: ["eth_sendTransaction"],
      maxTotalAttempts: 0,
      random: () => 0,
    }
  }

  const deps: ServerDeps = {
    pipelineFor,
    chains: () => chains,
    auth: options.auth ?? auth,
    logger: options.logger ?? silentLogger,
  }
  const server = createServer(deps)
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    server.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })

  return { server, post, calls, notes, adapters }
}

describe("route table (design.md §17)", () => {
  test("GET /healthz is open and answers 200", async () => {
    const { server } = stack()
    const response = await server.app.request("/healthz")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  test("GET /metrics is open — it is protected by the bind, not by auth (#33)", async () => {
    const { server } = stack()
    const response = await server.app.request("/metrics")
    // No metrics object was supplied, so the route reports that plainly instead of
    // serving an empty document that looks like a scrape of zeroes.
    expect(response.status).toBe(404)
  })
})

describe("auth ordering (§16.3)", () => {
  test("no credentials → 401 -32000", async () => {
    const { post } = stack()
    const response = await post("/ethereum", { id: 1, method: "eth_blockNumber", params: [] })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32000)
    expect(body.error.message).toBe("unauthorized")
  })

  test("a valid path key works (primary channel)", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { result: unknown }).result).toBe("0x1")
  })

  test("a valid Bearer works (fallback channel)", async () => {
    const { post } = stack()
    const response = await post(
      "/ethereum",
      { id: 1, method: "eth_blockNumber", params: [] },
      { authorization: "Bearer client-main" },
    )
    expect(response.status).toBe(200)
  })

  test("401 wins over 404: an unknown chain with bad credentials is 401", async () => {
    const { post, calls } = stack()
    const response = await post("/nosuchchain", { id: 1, method: "eth_blockNumber", params: [] })
    expect(response.status).toBe(401)
    // And the chain was never even looked up — that is the point of the ordering.
    expect(calls).toHaveLength(0)
  })

  test("an unknown chain with GOOD credentials is 404 -32602", async () => {
    const { post } = stack()
    const response = await post("/nosuchchain/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toContain("nosuchchain")
  })

  test("?apikey= is refused even with a valid path key (#32)", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main?apikey=client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { data: { reason: string } } }
    expect(body.error.data.reason).toBe("query-param")
  })
})

describe("path tolerance (§16.3)", () => {
  test("a trailing slash is ignored: /ethereum/KEY/ equals /ethereum/KEY", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main/", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(200)
  })

  test("/ethereum/ is a request WITHOUT a path key, so Bearer decides", async () => {
    const { post } = stack()
    const noBearer = await post("/ethereum/", { id: 1, method: "eth_blockNumber", params: [] })
    expect(noBearer.status).toBe(401)

    const withBearer = await post(
      "/ethereum/",
      { id: 1, method: "eth_blockNumber", params: [] },
      { authorization: "Bearer client-main" },
    )
    expect(withBearer.status).toBe(200)
  })

  test("splitPath keeps the chain and the segments after it", () => {
    expect(splitPath("/ethereum/KEY")).toEqual({ chain: "ethereum", keySegments: ["KEY"] })
    expect(splitPath("/ethereum")).toEqual({ chain: "ethereum", keySegments: [] })
    expect(splitPath("/ethereum/")).toEqual({ chain: "ethereum", keySegments: [] })
    expect(splitPath("/ethereum/KEY/")).toEqual({ chain: "ethereum", keySegments: ["KEY"] })
    expect(splitPath("/ethereum//")).toEqual({ chain: "ethereum", keySegments: [] })
  })

  test("percent-encoded segments are decoded before comparison", async () => {
    // A key with a character that needs encoding must still authenticate.
    const { post } = stack({
      auth: { methods: ["path", "bearer"], keys: [{ token: "key/with slash", label: "enc" }] },
    })
    const response = await post("/ethereum/key%2Fwith%20slash", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(200)
  })
})

describe("unroutable requests answer JSON, not text", () => {
  test("a GET on a JSON-RPC path is a JSON 404, not Hono's plain-text default", async () => {
    const { server } = stack()
    const response = await server.app.request("/ethereum/client-main", { method: "GET" })
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toContain("application/json")
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32600)
    // The path is redacted past the chain: a key must never be echoed (§16.4).
    expect(body.error.message).toBe("no route for GET /ethereum/*")
  })

  test("the notFound body names the method and path, never the key", async () => {
    const { server } = stack()
    const response = await server.app.request("/ethereum/super-secret-key", { method: "PUT" })
    const text = await response.text()
    expect(text).not.toContain("super-secret-key")
  })

  test("an unexpected throw becomes a JSON 500, never a stack trace", async () => {
    // Force a pipeline that throws: the error handler must contain it.
    const server = createServer({
      pipelineFor: () => {
        throw new Error("boom: secret-internal-detail")
      },
      chains: () => ["ethereum"],
      auth,
      logger: silentLogger,
    })
    const response = await server.app.request("/ethereum/client-main", {
      method: "POST",
      body: JSON.stringify({ id: 1, method: "eth_blockNumber", params: [] }),
    })
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain("secret-internal-detail")
    expect(text).toContain("internal proxy error")
    expect((JSON.parse(text) as { error: { code: number } }).error.code).toBe(-32000)
  })
})

describe("redactPath (§16.4 — a key must never be echoed)", () => {
  test("only the chain survives", () => {
    expect(redactPath("/ethereum/KEY")).toBe("/ethereum/*")
    expect(redactPath("/ethereum/KEY/extra")).toBe("/ethereum/*/*")
  })

  test("a chain-only path is unchanged", () => {
    expect(redactPath("/ethereum")).toBe("/ethereum")
    expect(redactPath("/healthz")).toBe("/healthz")
  })

  test("an empty path is unchanged", () => {
    expect(redactPath("/")).toBe("/")
  })

  /**
   * The M4 hand-off flagged this as a future hazard: `redactPath` assumes exactly
   * ONE non-secret segment (the chain), so a route with a second non-secret
   * segment would have that segment masked in every error and log line.
   *
   * Rather than rely on someone remembering, the assumption is now asserted
   * against the REAL route table. The day a route like `/chains/{chain}/status`
   * is added, this test fails and points at `redactPath` — which is the moment to
   * teach it which segments are not secrets.
   */
  test("the route table really has only one non-secret path segment (assumption behind redactPath)", () => {
    const { server } = stack()
    const patterns = server.app.routes.map((route) => route.path)

    expect(patterns).toContain("/healthz")
    expect(patterns).toContain("/metrics")

    // `redactPath` keeps segment 0 and masks the rest, so it is only correct while
    // no route has a SECOND fixed segment. Parameter (`:x`) and wildcard (`*`)
    // segments are not fixed: the only one is the path-key, which IS the secret.
    const violations = patterns
      .map((pattern) => ({
        pattern,
        fixed: pattern
          .split("/")
          .filter((segment) => segment !== "" && !segment.startsWith(":") && segment !== "*"),
      }))
      .filter((entry) => entry.fixed.length > 1)

    // On failure, teach `redactPath` which segments are not secrets before
    // adding the route — that is the whole point of this test.
    expect(violations).toEqual([])
  })
})

describe("body handling (design.md §10.3, §17.1)", () => {
  test("an unparseable body is -32600, not a transport error", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main", "{not json")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32600)
  })

  test("an empty body is -32600", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main", "")
    expect(response.status).toBe(200)
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32600)
  })

  test("a single request answers a single object, not an array", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main", {
      id: 7,
      method: "eth_blockNumber",
      params: [],
    })
    const body = (await response.json()) as unknown
    expect(Array.isArray(body)).toBe(false)
    expect((body as { id: number }).id).toBe(7)
  })

  test("a batch answers an array in the original order (invariant #4)", async () => {
    const echo = fakeAdapter({
      name: "a",
      outcomes: [],
      onAttempt: (group) => ({
        kind: "success" as const,
        entries: group.items.map((item) => ({
          originalIndex: item.originalIndex,
          ok: true as const,
          result: `r${item.id}`,
        })),
      }),
    })
    const { post } = stack({ adapters: [echo] })
    const response = await post("/ethereum/client-main", [
      { id: 0, method: "eth_blockNumber", params: [] },
      { id: 1, method: "eth_chainId", params: [] },
      { id: 2, method: "eth_gasPrice", params: [] },
    ])
    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: number; result: string }[]
    expect(body.map((entry) => entry.id)).toEqual([0, 1, 2])
    expect(body.map((entry) => entry.result)).toEqual(["r0", "r1", "r2"])
  })
})

describe("response shaping (design.md §12.3)", () => {
  test("a partial batch success is 200, with errors only at their own index", async () => {
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*"],
      outcomes: [],
      onAttempt: (group) => ({
        kind: "success" as const,
        entries: group.items.map((item) => ({
          originalIndex: item.originalIndex,
          ok: true as const,
          result: "ok",
        })),
      }),
    })
    const { post } = stack({ adapters: [a] })

    const response = await post("/ethereum/client-main", [
      { id: 0, method: "eth_blockNumber", params: [] },
      { id: 1, method: "trace_block", params: [] },
    ])

    expect(response.status).toBe(200)
    const body = (await response.json()) as { id: number; result?: unknown; error?: { code: number } }[]
    expect(body[0]!.result).toBe("ok")
    // Pre-flight rejection: no attempt, instant -32601 (§8.2).
    expect(body[1]!.error?.code).toBe(-32601)
  })

  test("all items failing on capacity is 429 with a Retry-After header", async () => {
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*"],
      weight: 1,
      outcomes: [{ kind: "rate_limited", retryAtMs: 4_000 }],
    })
    const { post } = stack({ adapters: [a] })

    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })

    expect(response.status).toBe(429)
    // 4000ms → 4 seconds, per §12.2 (seconds, rounded up).
    expect(response.headers.get("retry-after")).toBe("4")
    const body = (await response.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32005)
  })

  test("Retry-After is at least 1 second, even for a sub-second estimate", async () => {
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*"],
      weight: 1,
      outcomes: [{ kind: "rate_limited", retryAtMs: 0 }],
    })
    const { post } = stack({ adapters: [a] })
    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_blockNumber",
      params: [],
    })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("1")
  })

  test("a batch where only SOME items fail capacity is 200, not 429", async () => {
    // One upstream that rate-limits the first call, one item that never needs it.
    let call = 0
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*"],
      outcomes: [],
      onAttempt: (group) => {
        call += 1
        if (call === 1) return { kind: "rate_limited", retryAtMs: 5_000 }
        return {
          kind: "success" as const,
          entries: group.items.map((item) => ({
            originalIndex: item.originalIndex,
            ok: true as const,
            result: "ok",
          })),
        }
      },
    })
    const b = fakeAdapter({
      name: "b",
      methods: ["eth_*"],
      outcomes: [],
      onAttempt: (group) => ({
        kind: "success" as const,
        entries: group.items.map((item) => ({
          originalIndex: item.originalIndex,
          ok: true as const,
          result: "ok",
        })),
      }),
    })
    const { post } = stack({ adapters: [a, b] })

    const response = await post("/ethereum/client-main", [
      { id: 0, method: "eth_blockNumber", params: [] },
      { id: 1, method: "eth_chainId", params: [] },
    ])
    // Both items are answerable; whichever upstream ends up serving them, the
    // client gets answers and therefore a 200. The 429 rule is "every item failed
    // on capacity", never "some upstream said 429".
    expect(response.status).toBe(200)
    expect(response.headers.get("retry-after")).toBeNull()
  })

  test("a pre-flight-only response is 200, never 429 (§12.3 row 4)", async () => {
    const a = fakeAdapter({ name: "a", methods: ["eth_*"] })
    const { post } = stack({ adapters: [a] })
    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "trace_block",
      params: [],
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("retry-after")).toBeNull()
  })
})

describe("logging (§18.2)", () => {
  test("an unauthorized request logs the chain and reason, never the key", async () => {
    const { logger, records } = recordingLogger()
    const { post } = stack({ logger })
    await post("/ethereum/wrong-secret", { id: 1, method: "eth_blockNumber", params: [] })

    const warn = records.find((record) => record.message === "unauthorized request")
    expect(warn).toBeDefined()
    expect(warn!.fields).toEqual({
      chain: "ethereum",
      reason: "unknown",
      presented: true,
    })
    expect(JSON.stringify(records)).not.toContain("wrong-secret")
  })
})

describe("pipeline resolution", () => {
  test("the server resolves the chain through a function, so a reload is transparent", async () => {
    const { post, calls } = stack()
    await post("/ethereum/client-main", { id: 1, method: "eth_blockNumber", params: [] })
    await post("/ethereum/client-main", { id: 2, method: "eth_blockNumber", params: [] })
    // Two requests, two lookups: the server never caches a pipeline object.
    expect(calls).toEqual(["ethereum", "ethereum"])
  })

  test("an adapter failure does not escape as an HTTP 500", async () => {
    // `handle` is total over its inputs; the server should never need a try/catch
    // to keep a client from seeing a stack trace.
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*"],
      outcomes: [{ kind: "domain_error", entries: [{ originalIndex: 0, ok: false, error: { code: 3, message: "execution reverted" }, final: true }] }],
    })
    const { post } = stack({ adapters: [a] })
    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_call",
      params: [{}, "latest"],
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(3)
    expect(body.error.message).toBe("execution reverted")
  })
})

describe("parseRequest is the only body contract", () => {
  test("an empty batch is a single -32600 object, matching JSON-RPC 2.0", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main", [])
    expect(response.status).toBe(200)
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toContain("empty batch")
  })

  test("named params are refused rather than silently dropped", async () => {
    const { post } = stack()
    const response = await post("/ethereum/client-main", {
      id: 1,
      method: "eth_getBalance",
      params: { address: "0xabc" },
    })
    const body = (await response.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toContain("named params")
  })

  test("the pipeline's own handle() agrees with what the server returns", async () => {
    // Guards against the server and the pipeline drifting apart in shaping.
    const a = fakeAdapter({ name: "a", outcomes: [success(0, "0xabc")] })
    const { post } = stack({ adapters: [a] })
    const body = { id: 5, method: "eth_blockNumber", params: [] }
    const response = await post("/ethereum/client-main", body)
    const fromServer = await response.json()

    const direct = await handle(
      {
        chain: "ethereum",
        upstreams: [a.view],
        notes: new RuntimeNotes(),
        logger: silentLogger,
        now: () => 0,
        timeouts,
        blockedMethods: ["eth_sendTransaction"],
        maxTotalAttempts: 0,
      },
      parseRequest(body),
    )
    expect(fromServer).toEqual(direct.body)
  })
})

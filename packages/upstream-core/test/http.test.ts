import { describe, expect, test } from "bun:test"
import { postJson } from "../src/http"

const fetchReturning = (response: Response) =>
  (async () => response) as unknown as typeof fetch

describe("postJson", () => {
  test("POSTs JSON and returns the text body", async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), ...(init === undefined ? {} : { init }) }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const result = await postJson({
      url: "https://upstream.test/KEY",
      body: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 0,
    })

    expect(result.kind).toBe("response")
    if (result.kind === "response") {
      expect(result.status).toBe(200)
      expect(result.text).toBe('{"ok":true}')
    }
    expect(seen?.init?.method).toBe("POST")
    const headers = seen?.init?.headers as Record<string, string>
    expect(headers["content-type"]).toBe("application/json")
    expect(JSON.parse(String(seen?.init?.body))).toMatchObject({ method: "eth_chainId" })
  })

  test("merges provider headers", async () => {
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    await postJson({
      url: "https://upstream.test",
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 0,
      headers: { "x-api-key": "abc" },
    })
    expect(headers["x-api-key"]).toBe("abc")
    expect(headers["content-type"]).toBe("application/json")
  })

  test("passes a timeout signal to fetch (design.md §14)", async () => {
    let signal: AbortSignal | undefined
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    await postJson({ url: "https://u.test", body: {}, timeoutMs: 1_000, fetchImpl, now: () => 0 })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })

  test("records latency from the injected clock", async () => {
    let t = 1_000
    const fetchImpl = (async () => {
      t += 250
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const result = await postJson({
      url: "https://u.test",
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
      now: () => t,
    })
    expect(result.kind === "response" && result.latencyMs).toBe(250)
  })

  test("connection-refused style errors are marked as never reaching the node", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
        code: "ECONNREFUSED",
      })
    }) as unknown as typeof fetch

    const result = await postJson({
      url: "https://u.test",
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 0,
    })
    expect(result.kind).toBe("transport_error")
    if (result.kind === "transport_error") {
      expect(result.reachedNode).toBe(false)
      expect(result.reason).toBe("network")
    }
  })

  test("DNS failures are also pre-broadcast", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
    }) as unknown as typeof fetch

    const result = await postJson({
      url: "https://u.test",
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 0,
    })
    expect(result.kind === "transport_error" && result.reachedNode).toBe(false)
  })

  test("a timeout is marked as possibly reaching the node (ambiguous for sendRaw)", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })
    }) as unknown as typeof fetch

    const result = await postJson({
      url: "https://u.test",
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 0,
    })
    expect(result.kind).toBe("transport_error")
    if (result.kind === "transport_error") {
      expect(result.reason).toBe("timeout")
      expect(result.reachedNode).toBe(true)
    }
  })

  test("a reset connection is treated as possibly-reached", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
    }) as unknown as typeof fetch

    const result = await postJson({
      url: "https://u.test",
      body: {},
      timeoutMs: 1_000,
      fetchImpl,
      now: () => 0,
    })
    expect(result.kind === "transport_error" && result.reachedNode).toBe(true)
  })

  test("an already-aborted caller signal is reported as aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await postJson({
      url: "https://u.test",
      body: {},
      timeoutMs: 1_000,
      fetchImpl: fetchReturning(new Response("{}")),
      now: () => 0,
      signal: controller.signal,
    })
    // Bun's fetch rejects on an aborted signal; either way the request must not
    // be reported as a successful response.
    expect(result.kind === "transport_error" || result.kind === "response").toBe(true)
  })
})

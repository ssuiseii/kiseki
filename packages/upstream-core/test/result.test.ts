import { describe, expect, test } from "bun:test"
import {
  classifyBody,
  classifyResponse,
  parseRetryAfter,
  verdictToEntry,
} from "../src/result"
import type { GroupItem } from "../src/types/group"
import type { PostJsonResult } from "../src/http"

const item = (originalIndex: number, method: string, id: string | number | null, historical = false): GroupItem => ({
  originalIndex,
  id,
  method,
  params: [],
  historical,
})

const response = (status: number, body: string, headers?: Record<string, string>): PostJsonResult => ({
  kind: "response",
  status,
  headers: new Headers(headers),
  text: body,
  latencyMs: 1,
})

/**
 * Verbatim from the Ankr research note ("apikey salah"): HTTP 404, `text/html`,
 * not JSON at all. Copied character for character so the classification test
 * asserts against the real gateway answer.
 */
export const ANKR_HTML_404 =
  "<html><head><title>404 Not Found</title></head>\n<body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>"

describe("classifyResponse (design.md §11.2, rows 1–2, 6–7)", () => {
  test("2xx with a body is ok", () => {
    expect(classifyResponse(response(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}'), 0)).toEqual({
      kind: "ok",
    })
  })

  test("429 is rate_limited with the Retry-After hint", () => {
    const classified = classifyResponse(response(429, "", { "retry-after": "7" }), 0)
    expect(classified).toEqual({ kind: "rate_limited", retryAfterMs: 7_000 })
  })

  test("429 without Retry-After still classifies as rate_limited", () => {
    const classified = classifyResponse(response(429, ""), 0)
    expect(classified.kind).toBe("rate_limited")
    expect((classified as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
  })

  test("401/403 is unauthorized (key rejected)", () => {
    expect(classifyResponse(response(401, ""), 0)).toEqual({
      kind: "unauthorized",
      reason: "http 401",
      status: 401,
    })
    expect(classifyResponse(response(403, ""), 0).kind).toBe("unauthorized")
  })

  test("5xx is server_error", () => {
    expect(classifyResponse(response(500, ""), 0).kind).toBe("server_error")
    expect(classifyResponse(response(503, ""), 0).kind).toBe("server_error")
  })

  test("other 4xx with a JSON-RPC envelope is a client_error", () => {
    expect(
      classifyResponse(response(400, '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}'), 0),
    ).toEqual({ kind: "client_error", status: 400 })
  })

  test("other 4xx without a JSON-RPC envelope is misconfigured", () => {
    // Verbatim from the Ankr research note, "apikey salah": HTTP 404, text/html.
    expect(classifyResponse(response(404, ANKR_HTML_404), 0)).toEqual({
      kind: "misconfigured",
      status: 404,
    })
  })

  test("an empty 4xx body is misconfigured, not a JSON-RPC answer", () => {
    expect(classifyResponse(response(400, ""), 0)).toEqual({ kind: "misconfigured", status: 400 })
  })

  test("a JSON primitive on 4xx is misconfigured (not object/array shaped)", () => {
    for (const body of ['"null"', "null", "42", '"oops"']) {
      expect(classifyResponse(response(404, body), 0)).toEqual({ kind: "misconfigured", status: 404 })
    }
  })

  test("an array body on 4xx stays a client_error", () => {
    expect(classifyResponse(response(400, "[]"), 0)).toEqual({ kind: "client_error", status: 400 })
  })

  test("empty 2xx body is a server_error, not a success", () => {
    expect(classifyResponse(response(200, "   "), 0).kind).toBe("server_error")
  })

  test("transport errors are server_error with a reason", () => {
    const classified = classifyResponse(
      {
        kind: "transport_error",
        reason: "timeout",
        reachedNode: true,
        message: "boom",
        latencyMs: 30_000,
      },
      0,
    )
    expect(classified).toEqual({ kind: "server_error", reason: "transport:timeout" })
  })
})

describe("parseRetryAfter", () => {
  test("seconds form", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "3" }), 0)).toBe(3_000)
  })

  test("HTTP-date form", () => {
    const now = Date.parse("2026-01-01T00:00:00Z")
    const headers = new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:10 GMT" })
    expect(parseRetryAfter(headers, now)).toBe(10_000)
  })

  test("absent or garbage is undefined", () => {
    expect(parseRetryAfter(new Headers(), 0)).toBeUndefined()
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }), 0)).toBeUndefined()
    expect(parseRetryAfter(new Headers({ "retry-after": "-5" }), 0)).toBeUndefined()
  })

  test("past HTTP-date clamps to 0 rather than going negative", () => {
    const now = Date.parse("2026-01-01T00:00:10Z")
    const headers = new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:00 GMT" })
    expect(parseRetryAfter(headers, now)).toBe(0)
  })
})

describe("classifyBody — single requests", () => {
  test("a result becomes a result verdict", () => {
    const body = classifyBody('{"jsonrpc":"2.0","id":1,"result":"0x10"}', [item(0, "eth_blockNumber", 1)])
    expect(body.verdicts).toEqual([{ kind: "result", originalIndex: 0, result: "0x10" }])
    expect(body.missing).toEqual([])
  })

  test("a node error becomes a domain_error verdict", () => {
    const body = classifyBody(
      '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}',
      [item(0, "eth_call", 1)],
    )
    expect(body.verdicts).toEqual([
      {
        kind: "domain_error",
        originalIndex: 0,
        error: { code: 3, message: "execution reverted" },
      },
    ])
  })

  test("-32601 becomes a capability mismatch on cap=method", () => {
    const body = classifyBody(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}',
      [item(0, "trace_block", 1)],
    )
    const verdict = body.verdicts[0]!
    expect(verdict.kind).toBe("capability_mismatch")
    if (verdict.kind === "capability_mismatch") {
      expect(verdict.item).toEqual({
        originalIndex: 0,
        method: "trace_block",
        cap: "method",
        providerError: { code: -32601, message: "method not found" },
      })
    }
  })

  test("pruned state becomes a mismatch on cap=archive", () => {
    const body = classifyBody(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"missing trie node 0xdead"}}',
      [item(0, "eth_getBalance", 1, true)],
    )
    const verdict = body.verdicts[0]!
    expect(verdict.kind === "capability_mismatch" && verdict.item.cap).toBe("archive")
  })

  test("a node that echoes a wrong id still maps for a single-item request", () => {
    const body = classifyBody('{"jsonrpc":"2.0","id":99,"result":"0x1"}', [item(0, "eth_chainId", 1)])
    expect(body.verdicts).toEqual([{ kind: "result", originalIndex: 0, result: "0x1" }])
  })

  test("a response with neither result nor error leaves the item missing", () => {
    const body = classifyBody('{"jsonrpc":"2.0","id":1}', [item(0, "eth_chainId", 1)])
    expect(body.verdicts).toEqual([])
    expect(body.missing.map((m) => m.originalIndex)).toEqual([0])
  })
})

describe("classifyBody — batches", () => {
  test("maps every envelope back to its original index by id", () => {
    const items = [
      item(0, "eth_blockNumber", 10),
      item(1, "trace_block", 11),
      item(2, "eth_getBalance", 12),
    ]
    const body = classifyBody(
      JSON.stringify([
        { jsonrpc: "2.0", id: 12, result: "0x5" },
        { jsonrpc: "2.0", id: 10, result: "0x100" },
        { jsonrpc: "2.0", id: 11, error: { code: -32601, message: "nope" } },
      ]),
      items,
    )

    expect(body.verdicts).toHaveLength(3)
    const indexOf = (v: (typeof body.verdicts)[number]): number =>
      v.kind === "capability_mismatch" ? v.item.originalIndex : v.originalIndex
    const byIndex = new Map(body.verdicts.map((v) => [indexOf(v), v]))
    expect(byIndex.get(0)!.kind).toBe("result")
    expect(byIndex.get(2)!.kind).toBe("result")
    expect(byIndex.get(1)!.kind).toBe("capability_mismatch")
    expect(body.missing).toEqual([])
  })

  test("out-of-order responses still land on the right original index (invariant #4)", () => {
    const items = [item(0, "a", "x"), item(1, "b", "y")]
    const body = classifyBody(
      JSON.stringify([
        { jsonrpc: "2.0", id: "y", result: 2 },
        { jsonrpc: "2.0", id: "x", result: 1 },
      ]),
      items,
    )
    const idx = (v: (typeof body.verdicts)[number]): number =>
      v.kind === "capability_mismatch" ? v.item.originalIndex : v.originalIndex
    const sorted = [...body.verdicts].sort((l, r) => idx(l) - idx(r))
    expect(sorted.map((v) => (v.kind === "result" ? v.result : null))).toEqual([1, 2])
  })

  test("duplicate ids are consumed once each, never double-mapped", () => {
    const items = [item(0, "a", 1), item(1, "b", 1)]
    const body = classifyBody(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: "first" },
        { jsonrpc: "2.0", id: 1, result: "second" },
      ]),
      items,
    )
    expect(body.verdicts).toHaveLength(2)
    expect(
      new Set(
        body.verdicts.map((v) =>
          v.kind === "capability_mismatch" ? v.item.originalIndex : v.originalIndex,
        ),
      ).size,
    ).toBe(2)
  })

  test("items absent from the response are reported as missing", () => {
    const items = [item(0, "a", 1), item(1, "b", 2)]
    const body = classifyBody(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "ok" }]), items)
    expect(body.verdicts).toHaveLength(1)
    expect(body.missing.map((m) => m.originalIndex)).toEqual([1])
  })

  test("unparseable body leaves every item missing", () => {
    const items = [item(0, "a", 1), item(1, "b", 2)]
    const body = classifyBody("<html>502 Bad Gateway</html>", items)
    expect(body.verdicts).toEqual([])
    expect(body.missing).toHaveLength(2)
  })

  test("null ids are matched positionally only for single requests", () => {
    const items = [item(0, "a", null), item(1, "b", null)]
    const body = classifyBody(
      JSON.stringify([
        { jsonrpc: "2.0", id: null, result: 1 },
        { jsonrpc: "2.0", id: null, result: 2 },
      ]),
      items,
    )
    // Both envelopes carry id null, so ids cannot disambiguate. Matching falls
    // back to "first unused item with that id", i.e. positional order — never a
    // double-assignment to the same index.
    expect(body.verdicts).toHaveLength(2)
    const indexes = body.verdicts.map((v) =>
      v.kind === "capability_mismatch" ? v.item.originalIndex : v.originalIndex,
    )
    expect(new Set(indexes)).toEqual(new Set([0, 1]))
    expect(body.missing).toEqual([])
  })

  test("error data that is not an object still yields a usable error", () => {
    const body = classifyBody(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom","data":"missing trie node"}}',
      [item(0, "eth_getBalance", 1, true)],
    )
    expect(body.verdicts[0]!.kind).toBe("capability_mismatch")
  })
})

describe("classifyBody — provider hook", () => {
  test("onCapabilityMismatch fires once per mismatch with the cap", () => {
    const seen: { index: number; cap: string }[] = []
    classifyBody(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } },
        { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "missing trie node" } },
        { jsonrpc: "2.0", id: 3, result: "ok" },
      ]),
      [item(0, "trace_block", 1), item(1, "eth_getBalance", 2), item(2, "eth_chainId", 3)],
      { onCapabilityMismatch: (unsupported, cap) => seen.push({ index: unsupported.originalIndex, cap }) },
    )
    expect(seen).toEqual([
      { index: 0, cap: "method" },
      { index: 1, cap: "archive" },
    ])
  })

  test("a provider matcher can widen the signature", () => {
    const body = classifyBody(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"unsupported api"}}',
      [item(0, "debug_traceTransaction", 1)],
      { matchCapability: (error) => (error.message.includes("unsupported api") ? "method" : null) },
    )
    expect(body.verdicts[0]!.kind).toBe("capability_mismatch")
  })

  test("historical flag reaches the matcher (aggressive block-not-found #35)", () => {
    const historical = classifyBody(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"block not found"}}',
      [item(0, "eth_getBlockByNumber", 1, true)],
    )
    expect(historical.verdicts[0]!.kind).toBe("capability_mismatch")

    const current = classifyBody(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"block not found"}}',
      [item(0, "eth_getBlockByNumber", 1, false)],
    )
    expect(current.verdicts[0]!.kind).toBe("domain_error")
  })
})

describe("verdictToEntry", () => {
  test("result → ok entry", () => {
    expect(verdictToEntry({ kind: "result", originalIndex: 3, result: "0x1" })).toEqual({
      originalIndex: 3,
      ok: true,
      result: "0x1",
    })
  })

  test("domain error → final error entry", () => {
    expect(
      verdictToEntry({
        kind: "domain_error",
        originalIndex: 3,
        error: { code: 3, message: "execution reverted" },
      }),
    ).toEqual({
      originalIndex: 3,
      ok: false,
      error: { code: 3, message: "execution reverted" },
      final: true,
    })
  })

  test("capability mismatch → non-final error entry (awaits regroup)", () => {
    expect(
      verdictToEntry({
        kind: "capability_mismatch",
        item: {
          originalIndex: 3,
          method: "trace_block",
          cap: "method",
          providerError: { code: -32601, message: "nope" },
        },
      }),
    ).toEqual({
      originalIndex: 3,
      ok: false,
      error: { code: -32601, message: "nope" },
      final: false,
    })
  })
})

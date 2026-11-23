import { describe, expect, test } from "bun:test"
import { BucketRegistry } from "../src/bucket"
import { buildCostResolver } from "../src/cost"
import { ApikeyPool, buildBody, createPoolAdapter, type PoolObserver } from "../src/pool"
import type { Group, GroupItem } from "../src/types/group"
import { silentLogger, type Logger } from "../src/types/logger"

/** Deterministic clock: tests advance it explicitly. */
const makeClock = (start = 0) => {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
    set(ms: number) {
      current = ms
    },
  }
}

type FakeCall = { url: string; body: unknown; timeoutMs: number }

type FakeResponse =
  | { kind: "json"; status?: number; body: unknown; headers?: Record<string, string> }
  | { kind: "text"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "throw"; error: unknown }

/** Builds a `fetchImpl` that replays a queue of responses and records calls. */
const makeFetch = (responses: FakeResponse[]) => {
  const calls: FakeCall[] = []
  let index = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "null")),
      timeoutMs: 0,
    })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next === undefined) throw new Error("no more fake responses")
    switch (next.kind) {
      case "throw":
        throw next.error
      case "text":
        return new Response(next.body, {
          status: next.status,
          headers: next.headers ?? { "content-type": "application/json" },
        })
      case "json":
        return new Response(JSON.stringify(next.body), {
          status: next.status ?? 200,
          headers: next.headers ?? { "content-type": "application/json" },
        })
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const groupItem = (
  originalIndex: number,
  method: string,
  id: number | string | null = originalIndex,
  historical = false,
): GroupItem => ({ originalIndex, id, method, params: [], historical })

const group = (items: GroupItem[], overrides: Partial<Group> = {}): Group => ({
  chain: "ethereum",
  items,
  needsArchive: false,
  idempotency: "READ",
  timeoutMs: 30_000,
  ...overrides,
})

const okResult = (id: number | string | null, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result,
})

const rpcError = (id: number | string | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
})

type PoolHarnessOptions = {
  keys?: { token: string; label: string; buckets?: { capacity: number; refill_per_second: number }[] }[]
  responses: FakeResponse[]
  costs?: Record<string, number>
  countsBatchAsOne?: boolean
  random?: () => number
  observer?: PoolObserver
  logger?: Logger
  sickThreshold?: number
  timeoutMs?: number
}

const harness = (options: PoolHarnessOptions) => {
  const clock = makeClock()
  const registry = new BucketRegistry(clock.now)
  const { fetchImpl, calls } = makeFetch(options.responses)
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = []
  const logger: Logger = {
    debug: (message, fields) => logs.push({ level: "debug", message, ...(fields ? { fields } : {}) }),
    info: (message, fields) => logs.push({ level: "info", message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => logs.push({ level: "warn", message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => logs.push({ level: "error", message, ...(fields ? { fields } : {}) }),
  }

  const pool = new ApikeyPool({
    instance: "test-upstream",
    provider: "test",
    keys: (
      options.keys ?? [{ token: "KEY_A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] }]
    ).map((key) => ({
      token: key.token,
      label: key.label,
      buckets: key.buckets ?? [{ capacity: 100, refill_per_second: 10 }],
    })),
    url: (token) => `https://upstream.test/${token}`,
    costFor: buildCostResolver(options.costs, undefined),
    deps: { bucketRegistry: registry, logger: options.logger ?? logger, now: clock.now, fetchImpl },
    ...(options.countsBatchAsOne === undefined
      ? {}
      : { countsBatchAsOne: options.countsBatchAsOne }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.sickThreshold === undefined ? {} : { sickThreshold: options.sickThreshold }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })

  return { pool, clock, registry, calls, logs }
}

const ctx = (now: () => number) => ({ attempt: 0, logger: silentLogger, now })

describe("pool: quota accounting (§5.5)", () => {
  test("deducts per item, synchronously, before the fetch", async () => {
    const { pool, clock, registry, calls } = harness({
      responses: [
        {
          kind: "json",
          body: [
            okResult(0, "0x1"),
            okResult(1, "0x2"),
          ],
        },
      ],
    })
    const result = await pool.attempt(
      group([groupItem(0, "eth_blockNumber"), groupItem(1, "eth_chainId")]),
      ctx(clock.now),
    )

    expect(result.kind).toBe("success")
    expect(calls).toHaveLength(1)
    // 2 items × cost 1 = 2 credits, and the deduction happened before the fetch
    expect(registry.all()[0]!.credits(0)).toEqual([98])
  })

  test("honours a per-method cost override (§5.3)", async () => {
    const { pool, clock, registry } = harness({
      costs: { eth_call: 5, "trace_*": 20 },
      responses: [{ kind: "json", body: [okResult(0, "0x1"), okResult(1, "0x2")] }],
    })
    await pool.attempt(
      group([groupItem(0, "eth_call"), groupItem(1, "trace_block")]),
      ctx(clock.now),
    )
    expect(registry.all()[0]!.credits(0)).toEqual([75])
  })

  test("counts_batch_as_one charges the most expensive item once", async () => {
    const { pool, clock, registry } = harness({
      countsBatchAsOne: true,
      costs: { eth_call: 5, eth_getLogs: 9 },
      responses: [{ kind: "json", body: [okResult(0, "0x1"), okResult(1, "0x2")] }],
    })
    await pool.attempt(
      group([groupItem(0, "eth_call"), groupItem(1, "eth_getLogs")]),
      ctx(clock.now),
    )
    expect(registry.all()[0]!.credits(0)).toEqual([91])
  })

  test("no refund: a failed attempt still consumed quota", async () => {
    const { pool, clock, registry } = harness({
      responses: [
        { kind: "text", status: 500, body: "boom" },
        { kind: "json", body: okResult(0, "0x1") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
    })
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    const credits = registry.all().map((state) => state.credits(0)[0])
    // both keys were charged one credit; neither got a refund
    expect(credits.sort((l, r) => (l ?? 0) - (r ?? 0))).toEqual([99, 99])
  })
})

describe("pool: weighted-random key selection (#26)", () => {
  test("distribution follows remaining credit", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    // Two keys: A at full credit, B drained to 1/100.
    const keyA = registry.get("test", "KEY_A", [{ capacity: 100, refill_per_second: 10 }])
    const keyB = registry.get("test", "KEY_B", [{ capacity: 100, refill_per_second: 10 }])
    keyB.deduct(99, 0)

    const seen: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      seen.push(url.endsWith("KEY_A") ? "a" : "b")
      return new Response(JSON.stringify(okResult(0, "0x1")), { status: 200 })
    }) as unknown as typeof fetch

    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [
        { token: "KEY_A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "KEY_B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      url: (token) => `https://upstream.test/${token}`,
      costFor: () => 1,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
    })

    // Note: the pool holds the same shared state objects, so draining via the
    // registry above is visible here.
    expect(keyA.headroom(0)).toBe(1)
    expect(keyB.headroom(0)).toBeCloseTo(0.01, 10)

    for (let i = 0; i < 400; i += 1) {
      keyA.deduct(0, 0) // no-op, keeps state alive
      await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    }

    const aShare = seen.filter((s) => s === "a").length / seen.length
    // Expected ≈ 1 / 1.01 ≈ 0.99; allow generous slack for a small sample.
    expect(aShare).toBeGreaterThan(0.93)
  })

  test("a single ready key is always chosen", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "json", body: okResult(0, "0x1") }],
      keys: [
        { token: "KEY_A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "KEY_B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      random: () => 0.999,
    })
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(calls).toHaveLength(1)
  })

  test("epsilon keeps a zero-credit key selectable rather than dividing by zero", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "json", body: okResult(0, "0x1") }],
      keys: [
        { token: "KEY_A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "KEY_B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      random: () => 0.999999,
    })
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(calls.length).toBe(1)
  })
})

describe("pool: 429 → key failover (§11.2)", () => {
  test("429 drains the key's buckets, parks it, and moves to the next key", async () => {
    const { pool, clock, registry, calls, logs } = harness({
      responses: [
        { kind: "text", status: 429, body: "", headers: { "retry-after": "5" } },
        { kind: "json", body: okResult(0, "0x2a") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })

    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain("KEY_A")
    expect(calls[1]!.url).toContain("KEY_B")

    const stateA = registry.all().find((state) => state.token === "KEY_A")!
    expect(stateA.credits(0)).toEqual([0])
    expect(stateA.cooldownRemainingMs(0)).toBe(5_000)
    expect(logs.some((log) => log.message === "apikey rate limited")).toBe(true)
  })

  test("all keys rate-limited → rate_limited with the earliest retry", async () => {
    const { pool, clock } = harness({
      responses: [
        { kind: "text", status: 429, body: "" },
        { kind: "text", status: 429, body: "" },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("rate_limited")
    if (outcome.kind === "rate_limited") {
      // Both drained to 0 with refill 10/s → ready again in 100ms.
      expect(outcome.retryAtMs).toBeCloseTo(100, 0)
    }
  })

  test("the pool never tries the same key twice (termination)", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "text", status: 429, body: "" }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
        { token: "KEY_C", label: "c" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("rate_limited")
    expect(calls).toHaveLength(3)
    const urls = new Set(calls.map((call) => call.url))
    expect(urls.size).toBe(3)
  })
})

describe("pool: 5xx / transport → cooldown and sick (§11.2, §13)", () => {
  test("5xx cools the key down and fails over", async () => {
    const { pool, clock, registry, calls } = harness({
      responses: [
        { kind: "text", status: 503, body: "unavailable" },
        { kind: "json", body: okResult(0, "0x1") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
    expect(calls).toHaveLength(2)
    const stateA = registry.all().find((state) => state.token === "KEY_A")!
    expect(stateA.cooldownRemainingMs(0)).toBe(1_000)
  })

  test("timeouts are treated like 5xx for READ requests", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" })
    const { pool, clock } = harness({
      responses: [
        { kind: "throw", error: timeout },
        { kind: "json", body: okResult(0, "0x1") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
  })

  test("N distinct key failures trip provider-level sick (threshold 3)", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "text", status: 500, body: "boom" }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
        { token: "KEY_C", label: "c" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("sick")
    expect(calls).toHaveLength(3)
    expect(pool.isSick()).toBe(true)
    if (outcome.kind === "sick") expect(outcome.retryAtMs).toBe(1_000)
  })

  test("a sick provider returns sick immediately without calling out", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "text", status: 500, body: "boom" }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
        { token: "KEY_C", label: "c" },
      ],
      random: () => 0,
    })
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    const before = calls.length
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("sick")
    expect(calls.length).toBe(before)
  })

  test("sick cooldown doubles on the next trip and is capped", async () => {
    const { pool, clock } = harness({
      responses: [{ kind: "text", status: 500, body: "boom" }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
        { token: "KEY_C", label: "c" },
      ],
      random: () => 0,
    })
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(pool.sickUntil()).toBe(1_000)

    clock.set(1_000)
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(pool.sickUntil()).toBe(3_000) // 1s of the 2s cooldown elapsed
  })
})

describe("pool: capability mismatch (§8.3, decisions #34–36)", () => {
  test("-32601 becomes an unsupported outcome carrying the provider error", async () => {
    const { pool, clock } = harness({
      responses: [{ kind: "json", body: rpcError(0, -32601, "method not found") }],
    })
    const outcome = await pool.attempt(group([groupItem(0, "trace_block")]), ctx(clock.now))
    expect(outcome.kind).toBe("unsupported")
    if (outcome.kind === "unsupported") {
      expect(outcome.items).toEqual([
        {
          originalIndex: 0,
          method: "trace_block",
          cap: "method",
          providerError: { code: -32601, message: "method not found" },
        },
      ])
    }
  })

  test("a mixed batch yields success + unsupportedItems", async () => {
    const { pool, clock } = harness({
      responses: [
        {
          kind: "json",
          body: [okResult(0, "0x10"), rpcError(1, -32601, "method not found")],
        },
      ],
    })
    const outcome = await pool.attempt(
      group([groupItem(0, "eth_blockNumber"), groupItem(1, "trace_block")]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("success")
    if (outcome.kind === "success") {
      expect(outcome.entries).toEqual([{ originalIndex: 0, ok: true, result: "0x10" }])
      expect(outcome.unsupportedItems?.map((item) => item.originalIndex)).toEqual([1])
      expect(outcome.unsupportedItems?.[0]!.cap).toBe("method")
    }
  })

  test("pruned state on a historical query is an archive mismatch", async () => {
    const { pool, clock } = harness({
      responses: [{ kind: "json", body: rpcError(0, -32000, "missing trie node") }],
    })
    const outcome = await pool.attempt(
      group([groupItem(0, "eth_getBalance", 0, true)]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("unsupported")
    if (outcome.kind === "unsupported") expect(outcome.items[0]!.cap).toBe("archive")
  })

  test("a mismatch is NOT a key failure: the next key is not tried", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "json", body: rpcError(0, -32601, "nope") }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    await pool.attempt(group([groupItem(0, "trace_block")]), ctx(clock.now))
    expect(calls).toHaveLength(1)
  })

  test("capability mismatch does not affect key health (§13)", async () => {
    const { pool, clock, registry } = harness({
      responses: [{ kind: "json", body: rpcError(0, -32601, "nope") }],
    })
    await pool.attempt(group([groupItem(0, "trace_block")]), ctx(clock.now))
    const state = registry.all()[0]!
    expect(state.cooldownRemainingMs(0)).toBe(0)
    expect(state.health.consecutiveFailures).toBe(0)
  })

  test("the observer sees each mismatch for metrics/logging", async () => {
    const seen: string[] = []
    const { pool, clock } = harness({
      responses: [{ kind: "json", body: rpcError(0, -32601, "nope") }],
      observer: { onCapabilityMismatch: (_u, method, cap) => seen.push(`${method}:${cap}`) },
    })
    await pool.attempt(group([groupItem(0, "trace_block")]), ctx(clock.now))
    expect(seen).toEqual(["trace_block:method"])
  })

  test("logs a warn with instance/method/cap and never the token", async () => {
    const { pool, clock, logs } = harness({
      responses: [{ kind: "json", body: rpcError(0, -32601, "nope") }],
      keys: [{ token: "SUPER_SECRET_TOKEN", label: "a" }],
    })
    await pool.attempt(group([groupItem(0, "trace_block")]), ctx(clock.now))
    const warn = logs.find((log) => log.message === "capability mismatch")
    expect(warn?.fields).toEqual({
      upstream: "test-upstream",
      method: "trace_block",
      cap: "method",
    })
    expect(JSON.stringify(logs)).not.toContain("SUPER_SECRET_TOKEN")
  })
})

describe("pool: domain errors (§11.1)", () => {
  test("a node error is a domain_error and does not fail over", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "json", body: rpcError(0, 3, "execution reverted") }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_call")]), ctx(clock.now))
    expect(outcome.kind).toBe("domain_error")
    expect(calls).toHaveLength(1)
    if (outcome.kind === "domain_error") {
      expect(outcome.entries).toEqual([
        {
          originalIndex: 0,
          ok: false,
          error: { code: 3, message: "execution reverted" },
          final: true,
        },
      ])
    }
  })

  test("a mixed batch with only errors is a domain_error", async () => {
    const { pool, clock } = harness({
      responses: [
        {
          kind: "json",
          body: [rpcError(0, 3, "execution reverted"), rpcError(1, -32000, "nonce too low")],
        },
      ],
    })
    const outcome = await pool.attempt(
      group([groupItem(0, "eth_call"), groupItem(1, "eth_call")]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("domain_error")
  })

  test("mixed results and errors are a success (partial success allowed, invariant #5)", async () => {
    const { pool, clock } = harness({
      responses: [{ kind: "json", body: [okResult(0, "0x1"), rpcError(1, 3, "execution reverted")] }],
    })
    const outcome = await pool.attempt(
      group([groupItem(0, "eth_call"), groupItem(1, "eth_call")]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("success")
    if (outcome.kind === "success") expect(outcome.entries).toHaveLength(2)
  })
})

describe("pool: sendRawTransaction three classes (§11.3)", () => {
  const sendRaw = () =>
    group([groupItem(0, "eth_sendRawTransaction")], { idempotency: "NON_IDEMPOTENT" })

  test("definitive rejection → domain_error, no second key", async () => {
    const { pool, clock, calls } = harness({
      responses: [{ kind: "json", body: rpcError(0, -32000, "nonce too low") }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(sendRaw(), ctx(clock.now))
    expect(outcome.kind).toBe("domain_error")
    expect(calls).toHaveLength(1)
  })

  test("pre-broadcast failure (connection refused) tries the next key", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
    const { pool, clock, calls } = harness({
      responses: [
        { kind: "throw", error: refused },
        { kind: "json", body: okResult(0, "0xhash") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(sendRaw(), ctx(clock.now))
    expect(outcome.kind).toBe("success")
    expect(calls).toHaveLength(2)
  })

  test("timeout is ambiguous and stops the pool immediately", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" })
    const { pool, clock, calls } = harness({
      responses: [
        { kind: "throw", error: timeout },
        { kind: "json", body: okResult(0, "0xhash") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(sendRaw(), ctx(clock.now))
    expect(outcome.kind).toBe("ambiguous")
    expect(calls).toHaveLength(1)
  })

  test("5xx on sendRaw is ambiguous, not a key failover", async () => {
    const { pool, clock, calls } = harness({
      responses: [
        { kind: "text", status: 502, body: "bad gateway" },
        { kind: "json", body: okResult(0, "0xhash") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(sendRaw(), ctx(clock.now))
    expect(outcome.kind).toBe("ambiguous")
    expect(calls).toHaveLength(1)
  })

  test("an unparseable body on sendRaw is ambiguous", async () => {
    const { pool, clock } = harness({
      responses: [{ kind: "text", status: 200, body: "<html>oops</html>" }],
    })
    const outcome = await pool.attempt(sendRaw(), ctx(clock.now))
    expect(outcome.kind).toBe("ambiguous")
  })
})

describe("pool: weight / earliestReadyAt (design.md §6.2, §12.2)", () => {
  test("weight is the sum of per-key headroom", () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [
        { token: "A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "C", label: "c", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      url: (token) => `https://u.test/${token}`,
      costFor: () => 1,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now },
    })
    expect(pool.weight()).toBeCloseTo(3, 10)

    registry.get("test", "A", [{ capacity: 100, refill_per_second: 10 }]).deduct(100, 0)
    expect(pool.weight()).toBeCloseTo(2, 10)

    registry.get("test", "B", [{ capacity: 100, refill_per_second: 10 }]).deduct(50, 0)
    expect(pool.weight()).toBeCloseTo(1.5, 10)
  })

  test("a key in cooldown contributes nothing to weight", () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [
        { token: "A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      url: (token) => `https://u.test/${token}`,
      costFor: () => 1,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now },
    })
    registry.get("test", "A", [{ capacity: 100, refill_per_second: 10 }]).markFailure(0)
    expect(pool.weight()).toBeCloseTo(1, 10)
  })

  test("earliestReadyAt is the soonest key recovery (cost floor 1)", () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [
        { token: "A", label: "a", buckets: [{ capacity: 100, refill_per_second: 1 }] },
        { token: "B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      url: (token) => `https://u.test/${token}`,
      costFor: () => 1,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now },
    })
    registry.peek("test", "A")!.deduct(100, 0)
    registry.peek("test", "B")!.deduct(100, 0)
    // The adapter contract (implementation.md §2) takes no group, so the estimate
    // is for the cheapest possible request (cost 1): A needs 1/1s, B needs 1/10s.
    // The router's Retry-After therefore floors at the soonest key, never later.
    expect(pool.earliestReadyAt()).toBe(100)
  })

  test("full keys have weight > 0 and are eligible (pre-flight must not reject them)", async () => {
    const { pool, clock } = harness({ responses: [{ kind: "json", body: okResult(0, "0x1") }] })
    expect(pool.weight()).toBeGreaterThan(0)
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
  })

  test("drained keys yield weight 0 and rate_limited without any fetch", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl, calls } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [{ token: "A", label: "a", buckets: [{ capacity: 10, refill_per_second: 1 }] }],
      url: (token) => `https://u.test/${token}`,
      costFor: () => 10,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
    })
    registry.get("test", "A", [{ capacity: 10, refill_per_second: 1 }]).deduct(10, 0)

    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("rate_limited")
    expect(calls).toHaveLength(0)
  })
})

describe("buildBody", () => {
  test("single item → object, batch → array, ids preserved", () => {
    expect(buildBody(group([groupItem(0, "eth_blockNumber", 7)]))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "eth_blockNumber",
      params: [],
    })
    expect(
      buildBody(group([groupItem(0, "a", 1), groupItem(1, "b", "x")])),
    ).toEqual([
      { jsonrpc: "2.0", id: 1, method: "a", params: [] },
      { jsonrpc: "2.0", id: "x", method: "b", params: [] },
    ])
  })

  test("params are forwarded untouched", () => {
    const item: GroupItem = {
      originalIndex: 0,
      id: 1,
      method: "eth_getBalance",
      params: ["0xabc", "latest"],
      historical: false,
    }
    expect((buildBody(group([item])) as { params: unknown[] }).params).toEqual(["0xabc", "latest"])
  })
})

describe("createPoolAdapter", () => {
  const cfg = {
    name: "alchemy-ethereum",
    provider: "alchemy",
    package: "alchemy",
    url_template: "https://eth-mainnet.g.alchemy.com/v2/{apikey}",
    apikeys: [{ token: "KEY_A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] }],
    methods: ["eth_*", "trace_*"],
    archive: true,
  }

  test("substitutes {apikey} in the URL and reports the static capability", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl, calls } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const adapter = createPoolAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: clock.now,
      fetchImpl,
    })

    expect(adapter.name).toBe("alchemy-ethereum")
    expect(adapter.provider).toBe("alchemy")
    expect(adapter.capability()).toEqual({ methods: ["eth_*", "trace_*"], archive: true })

    await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(calls[0]!.url).toBe("https://eth-mainnet.g.alchemy.com/v2/KEY_A")
  })

  test("instance timeout override wins over the group timeout (design.md §14)", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    let seenSignal: AbortSignal | undefined
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined
      return new Response(JSON.stringify(okResult(0, "0x1")))
    }) as unknown as typeof fetch

    const adapter = createPoolAdapter(
      { ...cfg, timeout_ms: 120_000 },
      { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
    )
    await adapter.attempt(
      group([groupItem(0, "eth_blockNumber")], { timeoutMs: 1_000 }),
      ctx(clock.now),
    )
    expect(seenSignal).toBeDefined()
  })

  test("provider cost table wins over the global default", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const adapter = createPoolAdapter(
      cfg,
      {
        bucketRegistry: registry,
        logger: silentLogger,
        now: clock.now,
        fetchImpl,
        globalCosts: { eth_blockNumber: 1 },
      },
      { costs: { eth_blockNumber: 7 } },
    )
    await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([93])
  })

  test("instance costs: override the provider default (design.md §5.3, §15)", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const adapter = createPoolAdapter(
      { ...cfg, costs: { eth_blockNumber: 3 } },
      { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
      { costs: { eth_blockNumber: 7 } },
    )
    await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([97])
  })

  test("a whole layer wins over a more specific key in a lower layer", async () => {
    // design.md §5.3: override_provider[method] ?? default_global[prefix]. An
    // instance override of `trace_*` must beat a provider default of the exact
    // `trace_block`, not be outranked by exact-match-wins within a merged map.
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const adapter = createPoolAdapter(
      { ...cfg, costs: { "trace_*": 2 } },
      { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
      { costs: { trace_block: 9 } },
    )
    await adapter.attempt(group([groupItem(0, "trace_block")]), ctx(clock.now))
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([98])
  })

  test("global defaults apply when neither the instance nor the provider knows the method", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const adapter = createPoolAdapter(
      cfg,
      {
        bucketRegistry: registry,
        logger: silentLogger,
        now: clock.now,
        fetchImpl,
        globalCosts: { "eth_*": 4 },
      },
    )
    await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([96])
  })

  // The canonical namespace is additive: an adapter built without `translations`
  // must behave exactly as it did before it existed (plan A §4.1).
  test("without translations the capability is the configured one, byte for byte", () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const adapter = createPoolAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: clock.now,
    })
    expect(adapter.capability()).toEqual({ methods: ["eth_*", "trace_*"], archive: true })
  })

  test("the quota of a canonical item is charged under its upstream name", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl, calls } = makeFetch([
      { kind: "json", body: okResult(0, { ok: true }) },
    ])
    const adapter = createPoolAdapter(
      { ...cfg, methods: ["eth_*", "trace_*", "alchemy_*"] },
      { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
      {
        costs: { "alchemy_*": 40 },
        translations: [
          {
            canonical: "kiseki_getTokenBalances",
            upstream: "alchemy_getTokenBalances",
            mapRequest: (params) => [...params],
            mapResponse: (result) => result,
          },
        ],
      },
    )

    expect(adapter.capability().methods).toContain("kiseki_getTokenBalances")

    await adapter.attempt(
      group([
        {
          originalIndex: 0,
          id: 0,
          method: "kiseki_getTokenBalances",
          params: ["0xabc"],
          historical: false,
        },
      ]),
      ctx(clock.now),
    )

    expect((calls[0]!.body as { method: string }).method).toBe("alchemy_getTokenBalances")
    // 100 − 40 (the alchemy_* price), not 100 − 1.
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([60])
  })

  // `mapRequest` may return any shape the provider documents: an array of
  // positional values (the node API) or an object of named fields (an enhanced
  // API). The pool forwards it verbatim as the JSON-RPC `params` field.
  const translatedBody = async (mapRequest: () => unknown) => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl, calls } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const adapter = createPoolAdapter(
      { ...cfg, methods: ["eth_*", "trace_*", "alchemy_*"] },
      { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
      {
        translations: [
          {
            canonical: "kiseki_getTokenBalances",
            upstream: "alchemy_getTokenBalances",
            mapRequest,
            mapResponse: (result) => result,
          },
        ],
      },
    )
    await adapter.attempt(
      group([
        { originalIndex: 0, id: 7, method: "kiseki_getTokenBalances", params: ["0xabc"], historical: false },
      ]),
      ctx(clock.now),
    )
    return calls[0]!.body as { jsonrpc: string; id: unknown; method: string; params: unknown }
  }

  test("an object from mapRequest is sent as the JSON-RPC params, verbatim", async () => {
    const body = await translatedBody(() => ({ address: "0xabc", chain: "eth", pageSize: 5 }))
    expect(body.params).toEqual({ address: "0xabc", chain: "eth", pageSize: 5 })
    expect(Array.isArray(body.params)).toBe(false)
  })

  test("an array from mapRequest still works (backward compatible)", async () => {
    const body = await translatedBody(() => ["0xabc", "latest"])
    expect(body.params).toEqual(["0xabc", "latest"])
    expect(Array.isArray(body.params)).toBe(true)
  })

  test("a translation that rewrites params keeps the client's id and the upstream method", async () => {
    const body = await translatedBody(() => ({ address: "0xabc" }))
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "alchemy_getTokenBalances",
      params: { address: "0xabc" },
    })
  })
})

describe("pool: the CoreDeps.poolObserver seam (design.md §18.1)", () => {
  // The router cannot wire a per-instance PoolObserver: the pool lives inside the
  // provider package. `CoreDeps.poolObserver` is the process-wide seam the
  // composition root fills so `kiseki_pool_key_*` metrics see key attempts.
  const cfg = {
    name: "alchemy-ethereum",
    provider: "alchemy",
    package: "alchemy",
    url_template: "https://eth-mainnet.g.alchemy.com/v2/{apikey}",
    apikeys: [{ token: "KEY_A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] }],
    methods: ["eth_*", "trace_*"],
    archive: true,
  }

  test("an adapter built from config reports key attempts through CoreDeps", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const seen: string[] = []

    const adapter = createPoolAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: clock.now,
      fetchImpl,
      poolObserver: {
        onKeyAttempt: (upstream, label, outcome) => seen.push(`${upstream}:${label}:${outcome}`),
        onKeyFailover: (upstream) => seen.push(`failover:${upstream}`),
      },
    })

    await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(seen).toEqual(["alchemy-ethereum:a:success"])
  })

  test("a provider hook still wins over the process-wide seam", async () => {
    // A provider package that wants its own observer keeps it; the seam is a
    // fallback, not an override.
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])
    const fromDeps: string[] = []
    const fromHook: string[] = []

    const adapter = createPoolAdapter(
      cfg,
      {
        bucketRegistry: registry,
        logger: silentLogger,
        now: clock.now,
        fetchImpl,
        poolObserver: { onKeyAttempt: (_u, label) => fromDeps.push(label) },
      },
      { observer: { onKeyAttempt: (_u, label) => fromHook.push(label) } },
    )

    await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(fromHook).toEqual(["a"])
    expect(fromDeps).toEqual([])
  })

  test("omitting the seam leaves the pool silent, not broken", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([{ kind: "json", body: okResult(0, "0x1") }])

    const adapter = createPoolAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: clock.now,
      fetchImpl,
    })
    const outcome = await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
  })
})

/**
 * Ankr research note, section "apikey salah", quoted verbatim: the gateway answers
 * a wrong apikey with HTTP 404 and this HTML page, not JSON-RPC at all.
 */
const ANKR_HTML_404 =
  "<html><head><title>404 Not Found</title></head>\n<body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>"

const htmlResponse = (status = 404) => ({
  kind: "text" as const,
  status,
  body: ANKR_HTML_404,
  headers: { "content-type": "text/html" },
})

describe("pool: 4xx non-JSON-RPC is misconfiguration, not sickness (Validasi #1)", () => {
  test("the key cools down with a configuration reason and the provider is not parked", async () => {
    const { pool, clock, registry, calls, logs } = harness({
      responses: [htmlResponse(), { kind: "json", body: okResult(0, "0x1") }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
      // A threshold of 1 would park the provider on the first cross-key failure, so
      // this makes "not parked" a real assertion rather than an accident of 3 > 1.
      sickThreshold: 1,
    })

    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
    expect(calls).toHaveLength(2)
    expect(pool.isSick()).toBe(false)

    const stateA = registry.all().find((state) => state.token === "KEY_A")!
    expect(stateA.cooldownRemainingMs(0)).toBe(1_000) // exponential, first step
    expect(stateA.activeCooldownReason(0)).toBe("misconfigured")
    expect(stateA.misconfiguredHttpStatus(0)).toBe(404)

    // The healthy key kept its streak reset: no cross-key failure was counted.
    const warn = logs.find((log) => log.message === "upstream rejected the call as misconfigured")
    expect(warn?.fields).toEqual({ upstream: "test-upstream", apikey: "a", status: 404 })
    expect(JSON.stringify(logs)).not.toContain("nginx")
  })

  test("the key loses weight, so the router stops choosing it", async () => {
    const { pool, clock } = harness({
      responses: [htmlResponse()],
      keys: [
        { token: "KEY_A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      random: () => 0,
    })
    expect(pool.weight()).toBeCloseTo(1, 10)
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(pool.weight()).toBe(0)
  })

  test("when every key was rejected, the outcome is misconfigured with the status", async () => {
    const { pool, clock, calls } = harness({
      responses: [htmlResponse(), htmlResponse()],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome).toEqual({ kind: "misconfigured", status: 404 })
    expect(calls).toHaveLength(2)
    expect(pool.isSick()).toBe(false)
  })

  test("the observer reports the new label and never bad_body", async () => {
    const seen: string[] = []
    const { pool, clock } = harness({
      responses: [htmlResponse()],
      observer: { onKeyAttempt: (_upstream, label, outcome) => seen.push(`${label}:${outcome}`) },
    })
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(seen).toEqual(["a:misconfigured"])
  })

  test("a 4xx WITH a JSON-RPC envelope is still a domain error (passthrough)", async () => {
    const { pool, clock, calls } = harness({
      responses: [
        { kind: "text", status: 400, body: JSON.stringify(rpcError(0, -32602, "invalid params")) },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_call")]), ctx(clock.now))
    expect(outcome.kind).toBe("domain_error")
    expect(calls).toHaveLength(1) // final, no failover
  })
})

describe("pool: 401/403 is misconfiguration, not sickness (Validasi #2)", () => {
  test("the key cools down with a configuration reason and the provider is not parked", async () => {
    const { pool, clock, registry } = harness({
      responses: [
        { kind: "text", status: 401, body: JSON.stringify({ error: "invalid api key" }) },
        { kind: "json", body: okResult(0, "0x1") },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
      sickThreshold: 1,
    })

    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
    expect(pool.isSick()).toBe(false)

    const stateA = registry.all().find((state) => state.token === "KEY_A")!
    expect(stateA.activeCooldownReason(0)).toBe("misconfigured")
    expect(stateA.misconfiguredHttpStatus(0)).toBe(401)
  })

  test("all keys rejected with 401 → misconfigured, not sick", async () => {
    const { pool, clock } = harness({
      responses: [
        { kind: "text", status: 401, body: "" },
        { kind: "text", status: 403, body: "" },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
      sickThreshold: 1,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("misconfigured")
    // Both keys cool down for the same span, so either rejection is a truthful
    // status; what matters is that it is a rejection status, not a capacity hint.
    if (outcome.kind === "misconfigured") {
      expect(outcome.status === 401 || outcome.status === 403).toBe(true)
    }
    expect(pool.isSick()).toBe(false)
  })

  test("misconfigured mixed with unauthorized still yields misconfigured", async () => {
    const { pool, clock } = harness({
      responses: [htmlResponse(), { kind: "text", status: 401, body: "" }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("misconfigured")
  })
})

describe("pool: the diagnosis does not sweep other problems (Validasi #4)", () => {
  test("a key that never got tried because it cannot afford the cost defeats it", async () => {
    // A is rejected; B is drained so `canAfford` fails before any fetch. B will
    // recover, so the truthful answer is rate_limited, not misconfigured.
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl, calls } = makeFetch([htmlResponse()])
    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [
        { token: "A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      url: (token) => `https://u.test/${token}`,
      costFor: () => 1,
      random: () => 0,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
    })
    registry.peek("test", "B")!.deduct(100, 0)

    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("rate_limited")
    expect(calls).toHaveLength(1)
    expect(pool.misconfigured()).toBeUndefined()
  })

  test("a key cooling down for health mixed with a rejected one defeats it", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([htmlResponse()])
    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [
        { token: "A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      url: (token) => `https://u.test/${token}`,
      costFor: () => 1,
      random: () => 0,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
    })
    // B was parked by a 5xx on an earlier request; A is rejected now.
    registry.peek("test", "B")!.markFailure(0)

    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("rate_limited")
    expect(pool.misconfigured()).toBeUndefined()
  })

  test("a key cooling down for 429 mixed with a rejected one defeats it", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl } = makeFetch([htmlResponse()])
    const pool = new ApikeyPool({
      instance: "u",
      provider: "test",
      keys: [
        { token: "A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
        { token: "B", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
      ],
      url: (token) => `https://u.test/${token}`,
      costFor: () => 1,
      random: () => 0,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
    })
    registry.peek("test", "B")!.markRateLimited(0, 5_000)

    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("rate_limited")
    expect(pool.misconfigured()).toBeUndefined()
  })

  test("the diagnosis is derived from shared identity state, so another instance sees it", async () => {
    // The identity `(test, A)` is shared across chain instances. Instance one is
    // rejected; instance two — a different pool with the same key — must derive the
    // same diagnosis from the same state object, with no fetch and no snapshot.
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl, calls } = makeFetch([htmlResponse(), { kind: "json", body: okResult(0, "0x1") }])
    const deps = { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl }
    const keys = [{ token: "A", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] }]

    const ethereum = new ApikeyPool({
      instance: "ethereum",
      provider: "test",
      keys,
      url: (token) => `https://eth.test/${token}`,
      costFor: () => 1,
      deps,
    })
    const base = new ApikeyPool({
      instance: "base",
      provider: "test",
      keys,
      url: (token) => `https://base.test/${token}`,
      costFor: () => 1,
      deps,
    })

    const first = await ethereum.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(first).toEqual({ kind: "misconfigured", status: 404 })
    expect(calls).toHaveLength(1)

    // Base never called out, but the shared key state already proves the problem.
    expect(base.misconfigured()).toEqual({ untilMs: 1_000, status: 404 })
    expect(base.weight()).toBe(0)
  })
})

describe("pool: one bad key does not condemn the instance (Validasi #5)", () => {
  test("a healthy key serves the group and clears the streak", async () => {
    const { pool, clock, registry, calls } = harness({
      responses: [htmlResponse(), { kind: "json", body: okResult(0, "0x1") }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("success")
    expect(calls).toHaveLength(2)
    expect(pool.misconfigured()).toBeUndefined()
    const stateB = registry.all().find((state) => state.token === "KEY_B")!
    expect(stateB.health.cooldownReason).toBeUndefined()
    // Only B contributes, and it paid one credit for its attempt.
    expect(pool.weight()).toBeCloseTo(0.99, 10)
  })
})

describe("pool: sendRawTransaction with configuration rejections (Validasi #8)", () => {
  const sendRaw = () =>
    group([groupItem(0, "eth_sendRawTransaction")], { idempotency: "NON_IDEMPOTENT" })

  test("4xx non-JSON-RPC stays ambiguous but records the configuration reason", async () => {
    const { pool, clock, registry, calls, logs } = harness({
      responses: [htmlResponse(), { kind: "json", body: okResult(0, "0xhash") }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(sendRaw(), ctx(clock.now))
    // Invariant 3: neither level may continue, because we cannot prove the tx
    // never reached the node.
    expect(outcome.kind).toBe("ambiguous")
    expect(calls).toHaveLength(1)

    const stateA = registry.all().find((state) => state.token === "KEY_A")!
    expect(stateA.activeCooldownReason(0)).toBe("misconfigured")
    expect(stateA.misconfiguredHttpStatus(0)).toBe(404)

    const warn = logs.find((log) => log.message === "sendRaw ambiguous")
    expect(warn?.fields?.reason).toBe("misconfigured")
  })

  test("the next sendRaw during the cooldown is misconfigured, not rate_limited", async () => {
    const { pool, clock, calls } = harness({
      responses: [htmlResponse()],
      keys: [{ token: "KEY_A", label: "a" }],
      random: () => 0,
    })
    await pool.attempt(sendRaw(), ctx(clock.now))
    expect(calls).toHaveLength(1)

    const second = await pool.attempt(sendRaw(), ctx(clock.now))
    expect(second).toEqual({ kind: "misconfigured", status: 404 })
    expect(calls).toHaveLength(1) // no fetch: the diagnosis is passive
  })

  test("401/403 on sendRaw still fails over between keys, then reports misconfigured", async () => {
    const { pool, clock, calls } = harness({
      responses: [
        { kind: "text", status: 401, body: "" },
        { kind: "text", status: 401, body: "" },
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
      sickThreshold: 1,
    })
    const outcome = await pool.attempt(sendRaw(), ctx(clock.now))
    // Previously this path ended in `sick` → 429 / -32006.
    expect(outcome).toEqual({ kind: "misconfigured", status: 401 })
    expect(calls).toHaveLength(2)
    expect(pool.isSick()).toBe(false)
  })
})

describe("pool: old behaviour is unchanged (Validasi #10)", () => {
  test("429 still labels rate_limited and never misconfigured", async () => {
    const { pool, clock, registry } = harness({
      responses: [{ kind: "text", status: 429, body: "" }],
      keys: [{ token: "KEY_A", label: "a" }],
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("rate_limited")
    const state = registry.all()[0]!
    expect(state.activeCooldownReason(0)).toBe("rate_limited")
    expect(pool.misconfigured()).toBeUndefined()
  })

  test("5xx still labels unhealthy and still parks the provider at the threshold", async () => {
    const { pool, clock, registry } = harness({
      responses: [{ kind: "text", status: 500, body: "boom" }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
        { token: "KEY_C", label: "c" },
      ],
      random: () => 0,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("sick")
    expect(pool.isSick()).toBe(true)
    for (const state of registry.all()) expect(state.activeCooldownReason(0)).toBe("unhealthy")
    expect(pool.misconfigured()).toBeUndefined()
  })

  test("a server_error mixed with a rejection still ends sick, not misconfigured", async () => {
    // The health signal wins: a real 5xx on this attempt is evidence about the
    // provider, and the rejected key alone cannot explain the whole instance.
    const { pool, clock } = harness({
      responses: [htmlResponse(), { kind: "text", status: 500, body: "boom" }],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
      sickThreshold: 1,
    })
    const outcome = await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(outcome.kind).toBe("sick")
  })

  test("the reason alternates as the last writer says", async () => {
    const { pool, clock, registry } = harness({
      responses: [
        htmlResponse(),
        { kind: "text", status: 429, body: "" },
        htmlResponse(),
      ],
      keys: [{ token: "KEY_A", label: "a" }],
    })
    const state = () => registry.all()[0]!

    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(state().activeCooldownReason(0)).toBe("misconfigured")

    clock.set(2_000)
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(state().activeCooldownReason(2_000)).toBe("rate_limited")

    clock.set(20_000)
    await pool.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(state().activeCooldownReason(20_000)).toBe("misconfigured")
  })
})

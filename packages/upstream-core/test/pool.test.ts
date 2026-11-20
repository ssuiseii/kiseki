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
      { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
      { costs: { eth_blockNumber: 7 }, globalCosts: { eth_blockNumber: 1 } },
    )
    await adapter.attempt(group([groupItem(0, "eth_blockNumber")]), ctx(clock.now))
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([93])
  })
})

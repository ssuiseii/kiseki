import { describe, expect, test } from "bun:test"
import { BucketRegistry } from "../src/bucket"
import { buildLayeredCostResolver } from "../src/cost"
import {
  CANONICAL_METHODS,
  canonicalSchemas,
  coveredCanonicalMethods,
  invalidCanonicalParams,
  isCanonicalMethod,
  parseCanonicalParams,
  parseCanonicalResult,
  tokenAmountFromRaw,
  type MethodTranslation,
} from "../src/namespace"
import { ApikeyPool, createPoolAdapter, type PoolObserver } from "../src/pool"
import type { Group, GroupItem } from "../src/types/group"
import { silentLogger, type Logger } from "../src/types/logger"
import type { Entry, UpstreamOutcome } from "../src/types/outcome"

/* -------------------------------------------------------------------------- */
/* Harness (same injection style as pool.test.ts / alchemy.test.ts)            */
/* -------------------------------------------------------------------------- */

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

type FakeCall = { url: string; body: unknown }

type FakeResponse =
  | { kind: "json"; status?: number; body: unknown; headers?: Record<string, string> }
  | { kind: "text"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "throw"; error: unknown }

const makeFetch = (responses: FakeResponse[]) => {
  const calls: FakeCall[] = []
  let index = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) })
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
  params: unknown[] = [],
  id: number | string | null = originalIndex,
): GroupItem => ({ originalIndex, id, method, params, historical: false })

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

const ctx = (now: () => number) => ({ attempt: 0, logger: silentLogger, now })

const ADDRESS = "0x00000000000000000000000000000000000000aa"
const TOKEN = "0x00000000000000000000000000000000000000bb"
const HASH = `0x${"11".repeat(32)}`

/**
 * A fake provider package: the smallest thing that satisfies the contract. Its
 * "upstream" shapes are deliberately different from the canonical ones so a
 * missing mapping shows up as a failed assertion, not as a lucky pass.
 */
const makeTranslation = (
  overrides: Partial<MethodTranslation> = {},
): MethodTranslation => ({
  canonical: "kiseki_getTokenTransfers",
  upstream: "ankr_getTokenTransfers",
  mapRequest: (params, chain) => {
    const parsed = parseCanonicalParams("kiseki_getTokenTransfers", params)
    if (parsed === undefined) return undefined
    // The provider names chains differently: `ethereum` → `eth`.
    const alias = chain === "ethereum" ? "eth" : undefined
    if (alias === undefined) return undefined
    return [
      {
        blockchain: alias,
        address: parsed.address,
        ...(parsed.contract === undefined ? {} : { contractAddress: parsed.contract }),
        ...(parsed.pageSize === undefined ? {} : { pageSize: parsed.pageSize }),
        ...(parsed.nextPage === undefined || parsed.nextPage === null
          ? {}
          : { pageToken: parsed.nextPage }),
      },
    ]
  },
  mapResponse: (result, params) => {
    const parsed = parseCanonicalParams("kiseki_getTokenTransfers", params)
    if (parsed === undefined) throw new Error("unreachable: params were validated")
    const upstream = result as { transfers?: unknown[]; nextPageToken?: string }
    return {
      chain: "ethereum",
      transfers: (upstream.transfers ?? []).map((entry) => {
        const transfer = entry as {
          transactionHash: string
          blockNumber: string
          from: string
          to: string
          contractAddress: string
          value: string
        }
        return {
          transactionHash: transfer.transactionHash,
          blockNumber: transfer.blockNumber,
          from: transfer.from,
          to: transfer.to,
          contract: transfer.contractAddress,
          value: tokenAmountFromRaw(transfer.value),
        }
      }),
      nextPage: upstream.nextPageToken ?? null,
    }
  },
  ...overrides,
})

const TRANSLATIONS = [makeTranslation()]

type HarnessOptions = {
  responses: FakeResponse[]
  translations?: readonly MethodTranslation[]
  methods?: string[]
  costs?: Record<string, number>
  globalCosts?: Record<string, number>
  instanceCosts?: Record<string, number>
  keys?: { token: string; label: string }[]
  random?: () => number
  observer?: PoolObserver
  logger?: Logger
  name?: string
  provider?: string
  archive?: boolean
}

/** Build an adapter through the real `createPoolAdapter` seam. */
const adapterHarness = (options: HarnessOptions) => {
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

  const adapter = createPoolAdapter(
    {
      name: options.name ?? "ankr-ethereum",
      provider: options.provider ?? "ankr",
      package: "ankr",
      url_template: "https://rpc.ankr.test/eth/{apikey}",
      apikeys: (options.keys ?? [{ token: "KEY_A", label: "a" }]).map((key) => ({
        ...key,
        buckets: [{ capacity: 10_000, refill_per_second: 10 }],
      })),
      methods: options.methods ?? ["eth_*", "ankr_*"],
      archive: options.archive ?? false,
      ...(options.instanceCosts === undefined ? {} : { costs: options.instanceCosts }),
    },
    {
      bucketRegistry: registry,
      logger: options.logger ?? logger,
      now: clock.now,
      fetchImpl,
      ...(options.globalCosts === undefined ? {} : { globalCosts: options.globalCosts }),
    },
    {
      costs: options.costs ?? { "ankr_get*": 700 },
      ...(options.translations === undefined ? {} : { translations: options.translations }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    },
  )

  return { adapter, clock, registry, calls, logs }
}

const credits = (registry: BucketRegistry, provider = "ankr"): number[] =>
  registry.peek(provider, "KEY_A")!.credits(0)

/* -------------------------------------------------------------------------- */
/* 1. Capability enrichment                                                   */
/* -------------------------------------------------------------------------- */

describe("namespace: capability enrichment (plan A §4.1)", () => {
  test("a translation whose upstream method is covered makes the canonical name covered", () => {
    const { adapter } = adapterHarness({ responses: [], translations: TRANSLATIONS })
    const capability = adapter.capability()
    expect(capability.methods).toContain("kiseki_getTokenTransfers")
    // The configured patterns are still there, untouched.
    expect(capability.methods).toContain("eth_*")
    expect(capability.methods).toContain("ankr_*")
  })

  test("no translations → the canonical namespace stays uncovered (pre-flight -32601)", () => {
    const { adapter } = adapterHarness({ responses: [] })
    expect(adapter.capability().methods).toEqual(["eth_*", "ankr_*"])
    expect(adapter.capability().methods).not.toContain("kiseki_getTokenTransfers")
  })

  test("coverage follows the configured plan: an upstream method outside `methods` is not covered", () => {
    // The plan does not include the Advanced API, so its canonical aliases vanish
    // with it — the coverage is per (provider × plan), never global.
    const { adapter } = adapterHarness({
      responses: [],
      translations: TRANSLATIONS,
      methods: ["eth_*"],
    })
    expect(adapter.capability().methods).toEqual(["eth_*"])
  })

  test("a canonical name already listed in config is not duplicated", () => {
    const { adapter } = adapterHarness({
      responses: [],
      translations: TRANSLATIONS,
      methods: ["eth_*", "ankr_*", "kiseki_getTokenTransfers"],
    })
    const occurrences = adapter
      .capability()
      .methods.filter((method) => method === "kiseki_getTokenTransfers")
    expect(occurrences).toHaveLength(1)
  })

  test("a declared but unimplemented `http` transport is not advertised", () => {
    const { adapter } = adapterHarness({
      responses: [],
      translations: [makeTranslation({ transport: "http" })],
    })
    expect(adapter.capability().methods).not.toContain("kiseki_getTokenTransfers")
  })

  test("coveredCanonicalMethods dedupes and preserves table order", () => {
    expect(
      coveredCanonicalMethods(
        ["ankr_*"],
        [TRANSLATIONS[0]!, makeTranslation(), makeTranslation({ canonical: "kiseki_other" })],
      ),
    ).toEqual(["kiseki_getTokenTransfers", "kiseki_other"])
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Request translation                                                     */
/* -------------------------------------------------------------------------- */

describe("namespace: request translation (plan A §4.2)", () => {
  test("the upstream body carries the provider method and the mapped params", async () => {
    const { adapter, clock, calls } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, { transfers: [] }) }],
      translations: TRANSLATIONS,
    })

    await adapter.attempt(
      group([
        groupItem(0, "kiseki_getTokenTransfers", [
          { address: ADDRESS, contract: TOKEN, pageSize: 25 },
        ]),
      ]),
      ctx(clock.now),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({
      jsonrpc: "2.0",
      id: 0,
      method: "ankr_getTokenTransfers",
      params: [{ blockchain: "eth", address: ADDRESS, contractAddress: TOKEN, pageSize: 25 }],
    })
  })

  test("the chain alias comes from the group's kiseki chain, not the request", async () => {
    const { adapter, clock, calls } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, { transfers: [] }) }],
      translations: TRANSLATIONS,
    })

    await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])], {
        chain: "ethereum",
      }),
      ctx(clock.now),
    )
    expect((calls[0]!.body as { params: { blockchain: string }[] }).params[0]!.blockchain).toBe(
      "eth",
    )
  })

  test("an unsupported chain is invalid params, never a guessed alias", async () => {
    const { adapter, clock, calls } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, { transfers: [] }) }],
      translations: TRANSLATIONS,
    })

    const outcome = await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])], {
        chain: "some_chain_ankr_does_not_know",
      }),
      ctx(clock.now),
    )

    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
  })

  test("non-canonical items are forwarded byte-for-byte", async () => {
    const { adapter, clock, calls } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, "0x1") }],
      translations: TRANSLATIONS,
    })

    await adapter.attempt(
      group([groupItem(0, "eth_getBalance", [ADDRESS, "latest"])]),
      ctx(clock.now),
    )
    expect(calls[0]!.body).toEqual({
      jsonrpc: "2.0",
      id: 0,
      method: "eth_getBalance",
      params: [ADDRESS, "latest"],
    })
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Invalid canonical params                                                */
/* -------------------------------------------------------------------------- */

describe("namespace: invalid canonical params (plan A §4.2)", () => {
  test("mapRequest → undefined becomes a final domain error for that item only", async () => {
    const { adapter, clock, calls, registry } = adapterHarness({
      responses: [{ kind: "json", body: okResult(1, "0x2a") }],
      translations: TRANSLATIONS,
    })

    const outcome = await adapter.attempt(
      group([
        // Unknown field: the canonical schema is strict, so this is invalid.
        groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS, bogus: true }]),
        groupItem(1, "eth_blockNumber"),
      ]),
      ctx(clock.now),
    )

    // Only the valid item was sent.
    expect(calls).toHaveLength(1)
    expect((calls[0]!.body as { method: string }).method).toBe("eth_blockNumber")

    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    const byIndex = new Map(outcome.entries.map((entry) => [entry.originalIndex, entry]))
    expect(byIndex.get(0)).toEqual({
      originalIndex: 0,
      ok: false,
      error: invalidCanonicalParams("kiseki_getTokenTransfers"),
      final: true,
    })
    expect(byIndex.get(1)).toEqual({ originalIndex: 1, ok: true, result: "0x2a" })

    // The invalid item never consumed quota: one item was sent, cost 1.
    expect(credits(registry)).toEqual([9_999])
  })

  test("invalid params are NOT a capability mismatch, so nothing is regrouped", async () => {
    const { adapter, clock } = adapterHarness({
      responses: [],
      translations: TRANSLATIONS,
    })
    const outcome = await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [])]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind === "domain_error") {
      expect(outcome.entries).toEqual([
        {
          originalIndex: 0,
          ok: false,
          error: invalidCanonicalParams("kiseki_getTokenTransfers"),
          final: true,
        },
      ])
    }
  })

  test("a batch where every item is invalid makes no request at all", async () => {
    const { adapter, clock, calls, registry } = adapterHarness({
      responses: [],
      translations: TRANSLATIONS,
    })
    const outcome = await adapter.attempt(
      group([
        groupItem(0, "kiseki_getTokenTransfers", [{ address: "0xnothex" }]),
        groupItem(1, "kiseki_getTokenTransfers", [{ address: ADDRESS }, { extra: 1 }]),
      ]),
      ctx(clock.now),
    )
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
    expect(credits(registry)).toEqual([10_000])
  })

  test("a throwing mapRequest is contained: that item fails, the batch survives", async () => {
    const throwing = makeTranslation({
      mapRequest: () => {
        throw new Error("bug in the package")
      },
    })
    const { adapter, clock, calls, logs } = adapterHarness({
      responses: [{ kind: "json", body: okResult(1, "0x2a") }],
      translations: [throwing],
    })

    const outcome = await adapter.attempt(
      group([
        groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }]),
        groupItem(1, "eth_blockNumber"),
      ]),
      ctx(clock.now),
    )
    expect(calls).toHaveLength(1)
    expect(outcome.kind).toBe("success")
    expect(logs.some((log) => log.message === "canonical namespace mapping failed")).toBe(true)
  })

  test("a transport the engine cannot send is answered locally, never posted", async () => {
    const { adapter, clock, calls } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, { transfers: [] }) }],
      translations: [makeTranslation({ transport: "http" })],
    })

    const outcome = await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries[0]).toMatchObject({ originalIndex: 0, ok: false, final: true })
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Response mapping                                                        */
/* -------------------------------------------------------------------------- */

describe("namespace: response mapping (plan A §4.3)", () => {
  test("the upstream result is normalized into the canonical shape", async () => {
    const { adapter, clock } = adapterHarness({
      responses: [
        {
          kind: "json",
          body: okResult(0, {
            transfers: [
              {
                transactionHash: HASH,
                blockNumber: "0x10",
                from: ADDRESS,
                to: TOKEN,
                contractAddress: TOKEN,
                value: "0x00000000000000000000000000000000000000000000000000000000000003e8",
              },
            ],
            nextPageToken: "cursor-2",
          }),
        },
      ],
      translations: TRANSLATIONS,
    })

    const outcome = await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )

    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    const entry = outcome.entries[0]!
    expect(entry.ok).toBe(true)
    if (!entry.ok) return
    expect(entry.result).toEqual({
      chain: "ethereum",
      transfers: [
        {
          transactionHash: HASH,
          blockNumber: "0x10",
          from: ADDRESS,
          to: TOKEN,
          contract: TOKEN,
          // Full decimal value plus the upstream hex, verbatim.
          value: { value: "1000", valueRaw: "0x00000000000000000000000000000000000000000000000000000000000003e8" },
        },
      ],
      nextPage: "cursor-2",
    })
    // The canonical shape is exactly what the published schema promises.
    expect(
      parseCanonicalResult("kiseki_getTokenTransfers", entry.result),
    ).toBeDefined()
  })

  test("a provider error is passed through verbatim, never translated (#36)", async () => {
    const { adapter, clock } = adapterHarness({
      responses: [{ kind: "json", body: rpcError(0, 3, "execution reverted") }],
      translations: TRANSLATIONS,
    })

    const outcome = await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries).toEqual([
      {
        originalIndex: 0,
        ok: false,
        error: { code: 3, message: "execution reverted" },
        final: true,
      },
    ])
  })

  test("a throwing mapResponse is a final domain error, not a failover", async () => {
    const { adapter, clock, calls, logs } = adapterHarness({
      responses: [
        { kind: "json", body: okResult(0, { unexpected: true }) },
        { kind: "json", body: okResult(0, { transfers: [] }) },
      ],
      translations: [
        makeTranslation({
          mapResponse: () => {
            throw new Error("cannot map")
          },
        }),
      ],
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })

    const outcome = await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )

    // Exactly one call: a mapping bug is not an upstream failure, so the second
    // key must not be charged for it.
    expect(calls).toHaveLength(1)
    // The only item ended in a proxy-authored error, so the whole group is a
    // domain error — final, never regrouped, never retried elsewhere.
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries[0]).toMatchObject({ originalIndex: 0, ok: false, final: true })
    if (outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.error.code).toBe(-32603)
    expect(logs.some((log) => log.message === "canonical namespace mapping failed")).toBe(true)
  })

  test("mapping only touches successes: a mixed batch keeps its provider error intact", async () => {
    const { adapter, clock } = adapterHarness({
      responses: [
        {
          kind: "json",
          body: [okResult(0, { transfers: [], nextPageToken: undefined }), rpcError(1, -32000, "boom")],
        },
      ],
      translations: TRANSLATIONS,
    })

    const outcome = await adapter.attempt(
      group([
        groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }]),
        groupItem(1, "kiseki_getTokenTransfers", [{ address: TOKEN }]),
      ]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    const byIndex = new Map(outcome.entries.map((entry) => [entry.originalIndex, entry]))
    expect(byIndex.get(0)!.ok).toBe(true)
    expect(byIndex.get(1)).toEqual({
      originalIndex: 1,
      ok: false,
      error: { code: -32000, message: "boom" },
      final: true,
    })
  })
})

/* -------------------------------------------------------------------------- */
/* 5. Cost is resolved by the upstream name                                    */
/* -------------------------------------------------------------------------- */

describe("namespace: cost uses the upstream name (plan A §4.4)", () => {
  test("a canonical item is charged the provider's price for its upstream method", async () => {
    const { adapter, clock, registry } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, { transfers: [] }) }],
      translations: TRANSLATIONS,
    })

    await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )
    // 10_000 − 700: `ankr_get*` priced it, not the implicit 1.
    expect(credits(registry)).toEqual([9_300])
  })

  test("raw `eth_call` keeps its own price", async () => {
    const { adapter, clock, registry } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, "0x1") }],
      translations: TRANSLATIONS,
    })
    await adapter.attempt(group([groupItem(0, "eth_call", [ADDRESS, "latest"])]), ctx(clock.now))
    expect(credits(registry)).toEqual([9_999])
  })

  test("an instance `costs:` override still wins for the canonical call", async () => {
    const { adapter, clock, registry } = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, { transfers: [] }) }],
      translations: TRANSLATIONS,
      instanceCosts: { ankr_getTokenTransfers: 2 },
    })
    await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )
    expect(credits(registry)).toEqual([9_998])
  })

  test("a batch sums the effective per-item costs", async () => {
    const { adapter, clock, registry } = adapterHarness({
      responses: [{ kind: "json", body: [okResult(0, { transfers: [] }), okResult(1, "0x1")] }],
      translations: TRANSLATIONS,
    })
    await adapter.attempt(
      group([
        groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }]),
        groupItem(1, "eth_call", [ADDRESS, "latest"]),
      ]),
      ctx(clock.now),
    )
    expect(credits(registry)).toEqual([10_000 - 701])
  })
})

/* -------------------------------------------------------------------------- */
/* 6. Mixed batch                                                             */
/* -------------------------------------------------------------------------- */

describe("namespace: mixed batch (plan A §7.6)", () => {
  test("eth_* + canonical + raw provider method in one request keep their order", async () => {
    const { adapter, clock, calls } = adapterHarness({
      responses: [
        {
          kind: "json",
          body: [
            okResult(10, "0x2a"),
            okResult(11, { transfers: [], nextPageToken: null }),
            okResult(12, { whatever: true }),
          ],
        },
      ],
      translations: TRANSLATIONS,
    })

    const outcome = await adapter.attempt(
      group([
        groupItem(0, "eth_blockNumber", [], 10),
        groupItem(1, "kiseki_getTokenTransfers", [{ address: ADDRESS }], 11),
        groupItem(2, "ankr_getBlockchainStats", [{ blockchain: "eth" }], 12),
      ]),
      ctx(clock.now),
    )

    const sent = calls[0]!.body as { id: number; method: string; params: unknown[] }[]
    expect(sent.map((item) => item.method)).toEqual([
      "eth_blockNumber",
      "ankr_getTokenTransfers",
      "ankr_getBlockchainStats",
    ])
    expect(sent.map((item) => item.id)).toEqual([10, 11, 12])

    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    expect(outcome.entries.map((entry) => entry.originalIndex)).toEqual([0, 1, 2])
    // The raw provider method is not a canonical one: its result is untouched.
    expect(outcome.entries[2]).toEqual({
      originalIndex: 2,
      ok: true,
      result: { whatever: true },
    })
  })
})

/* -------------------------------------------------------------------------- */
/* 7. Regroup path stays intact (#34)                                          */
/* -------------------------------------------------------------------------- */

describe("namespace: capability mismatch still regroups (plan A §7.7)", () => {
  test("a plan-gated canonical method is reported under the canonical name", async () => {
    const seen: string[] = []
    const { adapter, clock } = adapterHarness({
      responses: [{ kind: "json", body: rpcError(0, -32601, "method not found") }],
      translations: TRANSLATIONS,
      observer: { onCapabilityMismatch: (_u, method, cap) => seen.push(`${method}:${cap}`) },
    })

    const outcome = await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )

    // Reported under the CLIENT's name so the runtime note and the regroup both
    // key on what the client asked for, not on the provider's alias.
    expect(seen).toEqual(["kiseki_getTokenTransfers:method"])
    expect(outcome.kind).toBe("unsupported")
    if (outcome.kind !== "unsupported") return
    expect(outcome.items[0]!.method).toBe("kiseki_getTokenTransfers")
  })

  test("the second provider can then serve the same canonical method", async () => {
    const first = adapterHarness({
      responses: [{ kind: "json", body: rpcError(0, -32601, "method not found") }],
      translations: TRANSLATIONS,
      name: "ankr-ethereum",
    })
    const second = adapterHarness({
      responses: [{ kind: "json", body: okResult(0, { transfers: [], nextPageToken: null }) }],
      translations: TRANSLATIONS,
      name: "other-ethereum",
      provider: "other",
    })

    const canonicalGroup = group([
      groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }]),
    ])

    const failed = await first.adapter.attempt(canonicalGroup, ctx(first.clock.now))
    expect(failed.kind).toBe("unsupported")

    // The router would hand the item to the next capable upstream: the enriched
    // capability is what makes it a candidate there.
    expect(second.adapter.capability().methods).toContain("kiseki_getTokenTransfers")
    const served = await second.adapter.attempt(canonicalGroup, ctx(second.clock.now))
    expect(served.kind).toBe("success")
    if (served.kind !== "success") return
    expect(served.entries[0]!.ok).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* 8. Pool semantics unchanged                                                */
/* -------------------------------------------------------------------------- */

describe("namespace: pool semantics unchanged (plan A §7.8)", () => {
  test("quota is still deducted before the fetch, with no refund on failure", async () => {
    const { adapter, clock, registry } = adapterHarness({
      responses: [
        { kind: "text", status: 500, body: "boom" },
        { kind: "json", body: okResult(0, { transfers: [] }) },
      ],
      translations: TRANSLATIONS,
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })

    await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )
    const stateA = registry.peek("ankr", "KEY_A")!
    const stateB = registry.peek("ankr", "KEY_B")!
    // Both keys paid 700: the failed attempt was not refunded.
    expect(stateA.credits(0)).toEqual([9_300])
    expect(stateB.credits(0)).toEqual([9_300])
  })

  test("`ambiguous` on sendRaw still stops the pool immediately", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" })
    const { adapter, clock, calls } = adapterHarness({
      responses: [
        { kind: "throw", error: timeout },
        { kind: "json", body: okResult(0, "0xhash") },
      ],
      translations: TRANSLATIONS,
      keys: [
        { token: "KEY_A", label: "a" },
        { token: "KEY_B", label: "b" },
      ],
      random: () => 0,
    })

    const outcome = await adapter.attempt(
      group([groupItem(0, "eth_sendRawTransaction", ["0xdead"])], {
        idempotency: "NON_IDEMPOTENT",
      }),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("ambiguous")
    expect(calls).toHaveLength(1)
  })

  test("no apikey token ever reaches a log line", async () => {
    const { adapter, clock, logs } = adapterHarness({
      responses: [{ kind: "json", body: rpcError(0, 3, "execution reverted") }],
      translations: [
        makeTranslation({
          mapResponse: () => {
            throw new Error("cannot map")
          },
        }),
      ],
      keys: [{ token: "SUPER_SECRET_TOKEN", label: "a" }],
    })

    await adapter.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )
    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain("SUPER_SECRET_TOKEN")
  })
})

/* -------------------------------------------------------------------------- */
/* Direct pool construction (no adapter) still honours translations            */
/* -------------------------------------------------------------------------- */

describe("namespace: ApikeyPool takes translations directly", () => {
  test("the pool translates without going through createPoolAdapter", async () => {
    const clock = makeClock()
    const registry = new BucketRegistry(clock.now)
    const { fetchImpl, calls } = makeFetch([
      { kind: "json", body: okResult(0, { transfers: [], nextPageToken: null }) },
    ])

    const pool = new ApikeyPool({
      instance: "u",
      provider: "ankr",
      keys: [{ token: "K", label: "a", buckets: [{ capacity: 10_000, refill_per_second: 1 }] }],
      url: (token) => `https://u.test/${token}`,
      costFor: buildLayeredCostResolver([{ "ankr_get*": 700 }]),
      translations: TRANSLATIONS,
      deps: { bucketRegistry: registry, logger: silentLogger, now: clock.now, fetchImpl },
    })

    const outcome: UpstreamOutcome = await pool.attempt(
      group([groupItem(0, "kiseki_getTokenTransfers", [{ address: ADDRESS }])]),
      ctx(clock.now),
    )
    expect(outcome.kind).toBe("success")
    expect((calls[0]!.body as { method: string }).method).toBe("ankr_getTokenTransfers")
  })
})

/* -------------------------------------------------------------------------- */
/* Canonical schemas                                                          */
/* -------------------------------------------------------------------------- */

describe("namespace: canonical schemas are the single source of truth", () => {
  test("every canonical method is a kiseki_* name with params and result schemas", () => {
    expect(CANONICAL_METHODS.length).toBeGreaterThan(0)
    for (const method of CANONICAL_METHODS) {
      expect(method.startsWith("kiseki_")).toBe(true)
      expect(isCanonicalMethod(method)).toBe(true)
      expect(canonicalSchemas[method].params).toBeDefined()
      expect(canonicalSchemas[method].result).toBeDefined()
    }
    expect(isCanonicalMethod("eth_call")).toBe(false)
    // No prototype tricks: a name inherited from Object is not canonical.
    expect(isCanonicalMethod("toString")).toBe(false)
  })

  test("unknown fields are rejected, never silently dropped (strict)", () => {
    expect(parseCanonicalParams("kiseki_getTokenPrice", [{ contract: TOKEN }])).toEqual({
      contract: TOKEN,
    })
    expect(
      parseCanonicalParams("kiseki_getTokenPrice", [{ contract: TOKEN, chain: "ethereum" }]),
    ).toBeUndefined()
  })

  test("params must be a single-element array", () => {
    expect(parseCanonicalParams("kiseki_getTokenPrice", [{ contract: TOKEN }, {}])).toBeUndefined()
    expect(parseCanonicalParams("kiseki_getTokenPrice", [])).toBeUndefined()
    expect(parseCanonicalParams("kiseki_getTokenPrice", [{ contract: TOKEN }])).toBeDefined()
  })

  test("addresses, hashes and quantities use explicit regexes", () => {
    expect(parseCanonicalParams("kiseki_getAccountBalance", [{ address: "0x1234" }])).toBeUndefined()
    expect(
      parseCanonicalParams("kiseki_getAccountBalance", [{ address: `0x${"g".repeat(40)}` }]),
    ).toBeUndefined()
    expect(parseCanonicalParams("kiseki_getAccountBalance", [{ address: ADDRESS }])).toEqual({
      address: ADDRESS,
    })
    expect(
      parseCanonicalResult("kiseki_getTokenPrice", {
        chain: "ethereum",
        contract: TOKEN,
        priceUsd: "12.5",
        updatedAt: "2026-11-21T10:00:00Z",
      }),
    ).toBeDefined()
    expect(
      parseCanonicalResult("kiseki_getTokenPrice", {
        chain: "eth", // the provider alias must never leak
        contract: TOKEN,
        priceUsd: "12.5",
        updatedAt: "2026-11-21T10:00:00Z",
      }),
    ).toBeUndefined()
  })

  test("token amounts are decimal strings plus the raw hex, never JS numbers", () => {
    const amount = tokenAmountFromRaw("0xde0b6b3a7640000")
    expect(amount).toEqual({ value: "1000000000000000000", valueRaw: "0xde0b6b3a7640000" })
    expect(typeof amount.value).toBe("string")

    // A number would lose precision; the schema refuses it outright.
    expect(
      parseCanonicalResult("kiseki_getAccountBalance", {
        chain: "ethereum",
        address: ADDRESS,
        balance: { value: 1e18, valueRaw: "0xde0b6b3a7640000" },
        tokens: [],
      }),
    ).toBeUndefined()
  })

  test("paging is an opaque string or null", () => {
    expect(parseCanonicalParams("kiseki_getNFTsByOwner", [{ owner: ADDRESS, nextPage: null }])).toEqual(
      { owner: ADDRESS, nextPage: null },
    )
    expect(parseCanonicalParams("kiseki_getNFTsByOwner", [{ owner: ADDRESS, nextPage: "abc" }])).toEqual(
      { owner: ADDRESS, nextPage: "abc" },
    )
    expect(parseCanonicalParams("kiseki_getNFTsByOwner", [{ owner: ADDRESS, nextPage: 5 }])).toBeUndefined()
  })

  test("pageSize is bounded so a client cannot ask for an unbounded page", () => {
    expect(parseCanonicalParams("kiseki_getNFTsByOwner", [{ owner: ADDRESS, pageSize: 0 }])).toBeUndefined()
    expect(
      parseCanonicalParams("kiseki_getNFTsByOwner", [{ owner: ADDRESS, pageSize: 1001 }]),
    ).toBeUndefined()
    expect(parseCanonicalParams("kiseki_getNFTsByOwner", [{ owner: ADDRESS, pageSize: 50 }])).toEqual({
      owner: ADDRESS,
      pageSize: 50,
    })
  })

  test("invalidCanonicalParams carries the method, never a value", () => {
    expect(invalidCanonicalParams("kiseki_getTokenPrice")).toEqual({
      code: -32602,
      message: "invalid params",
      data: { method: "kiseki_getTokenPrice" },
    })
    expect(invalidCanonicalParams("kiseki_getTokenPrice", "contract").data).toEqual({
      method: "kiseki_getTokenPrice",
      detail: "contract",
    })
  })

  test("every canonical result schema accepts a minimal valid payload", () => {
    const samples: Record<(typeof CANONICAL_METHODS)[number], unknown> = {
      kiseki_getTokenTransfers: { chain: "ethereum", transfers: [], nextPage: null },
      kiseki_getTransactionsByAddress: { chain: "ethereum", transactions: [], nextPage: null },
      kiseki_getAccountBalance: {
        chain: "ethereum",
        address: ADDRESS,
        balance: tokenAmountFromRaw("0x0"),
        tokens: [],
      },
      kiseki_getNFTsByOwner: { chain: "ethereum", nfts: [], nextPage: null },
      kiseki_getNFTMetadata: { chain: "ethereum", contract: TOKEN, tokenId: "1" },
      kiseki_getTokenPrice: {
        chain: "ethereum",
        contract: TOKEN,
        priceUsd: "0.5",
        updatedAt: "2026-11-21T10:00:00+07:00",
      },
    }
    for (const method of CANONICAL_METHODS) {
      expect(parseCanonicalResult(method, samples[method])).toBeDefined()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Entry-shape guard                                                          */
/* -------------------------------------------------------------------------- */

describe("namespace: entry completeness", () => {
  test("every item of a canonical batch receives exactly one entry", async () => {
    const { adapter, clock } = adapterHarness({
      responses: [
        {
          kind: "json",
          body: [okResult(1, { transfers: [], nextPageToken: null }), okResult(2, "0x1")],
        },
      ],
      translations: TRANSLATIONS,
    })

    const outcome = await adapter.attempt(
      group([
        groupItem(0, "kiseki_getTokenTransfers", [{ address: "bad" }]),
        groupItem(1, "kiseki_getTokenTransfers", [{ address: ADDRESS }]),
        groupItem(2, "eth_chainId"),
      ]),
      ctx(clock.now),
    )

    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    const indexes = outcome.entries.map((entry: Entry) => entry.originalIndex).sort((a, b) => a - b)
    expect(indexes).toEqual([0, 1, 2])
  })
})

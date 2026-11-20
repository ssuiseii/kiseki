import { describe, expect, test } from "bun:test"
import {
  BucketRegistry,
  composeMatchers,
  silentLogger,
  type Group,
  type UpstreamInstanceConfig,
} from "upstream-core"
import { ALCHEMY_CU, createAdapter, matchAlchemyCapability } from "../src/index"

const cfg: UpstreamInstanceConfig = {
  name: "alchemy-ethereum",
  provider: "alchemy",
  package: "alchemy",
  url_template: "https://eth-mainnet.g.alchemy.com/v2/{apikey}",
  apikeys: [{ token: "KEY_A", label: "a", buckets: [{ capacity: 1000, refill_per_second: 10 }] }],
  methods: ["eth_*", "trace_*", "debug_*"],
  archive: true,
}

const group = (method: string): Group => ({
  chain: "ethereum",
  items: [{ originalIndex: 0, id: 0, method, params: [], historical: false }],
  needsArchive: false,
  idempotency: "READ",
  timeoutMs: 1_000,
})

const ctx = { attempt: 0, logger: silentLogger, now: () => 0 }

const harness = (options: {
  costs?: Record<string, number>
  globalCosts?: Record<string, number>
  response?: () => Response
}) => {
  const registry = new BucketRegistry(() => 0)
  const adapter = createAdapter(
    options.costs === undefined ? cfg : { ...cfg, costs: options.costs },
    {
      bucketRegistry: registry,
      logger: silentLogger,
      now: () => 0,
      ...(options.globalCosts === undefined ? {} : { globalCosts: options.globalCosts }),
      fetchImpl: (async () => (options.response ?? (() => okBody(0)))()) as unknown as typeof fetch,
    },
  )
  return { adapter, registry }
}

const okBody = (id: number) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }))

describe("Alchemy CU table (design.md §5.3, §15)", () => {
  test("uses published CU values instead of 1 credit per request", async () => {
    const { adapter, registry } = harness({})
    await adapter.attempt(group("eth_call"), ctx)
    // eth_call = 26 CU
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([974])
  })

  test("zero-CU methods cost nothing (eth_chainId)", async () => {
    const { adapter, registry } = harness({})
    await adapter.attempt(group("eth_chainId"), ctx)
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([1000])
  })

  test("a config override on the instance beats the provider default", async () => {
    const { adapter, registry } = harness({ costs: { eth_call: 2 } })
    await adapter.attempt(group("eth_call"), ctx)
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([998])
  })

  test("global defaults only apply to methods the CU table does not know", async () => {
    const { adapter, registry } = harness({ globalCosts: { "eth_*": 99 } })
    await adapter.attempt(group("eth_call"), ctx)
    // The provider layer knows eth_call (26), so the global 99 must not apply.
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([974])
  })

  test("trace and debug methods are priced from the provider table", () => {
    expect(ALCHEMY_CU["trace_block"]).toBe(20)
    expect(ALCHEMY_CU["trace_transaction"]).toBe(40)
    expect(ALCHEMY_CU["debug_traceTransaction"]).toBe(40)
    expect(ALCHEMY_CU["eth_getLogs"]).toBe(60)
    expect(ALCHEMY_CU["eth_sendRawTransaction"]).toBe(40)
  })

  test("batching is billed per item, so counts_batch_as_one stays off", async () => {
    const registry = new BucketRegistry(() => 0)
    const adapter = createAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: () => 0,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 0, result: "0x1" },
            { jsonrpc: "2.0", id: 1, result: "0x2" },
          ]),
        )) as unknown as typeof fetch,
    })
    await adapter.attempt(
      {
        ...group("eth_call"),
        items: [
          { originalIndex: 0, id: 0, method: "eth_call", params: [], historical: false },
          { originalIndex: 1, id: 1, method: "eth_call", params: [], historical: false },
        ],
      },
      ctx,
    )
    // 2 × 26 CU
    expect(registry.peek("alchemy", "KEY_A")!.credits(0)).toEqual([948])
  })
})

describe("Alchemy capability signatures (design.md §8.3)", () => {
  const match = (code: number, message: string, historical = false) =>
    composeMatchers(matchAlchemyCapability)(
      { code, message },
      historical,
    )

  test("-32601 is a method mismatch", () => {
    expect(match(-32601, "the method trace_block does not exist/is not available")).toBe("method")
  })

  test("a plan-gated method is a method mismatch even without -32601", () => {
    expect(match(-32000, "method is not available on free plan, please upgrade to paid plan")).toBe(
      "method",
    )
  })

  test("Alchemy's pruned-state wording stays an archive mismatch", () => {
    expect(match(-32000, "state at block #100 is pruned", true)).toBe("archive")
  })

  test("domain errors are not mismatches (#36 passthrough)", () => {
    expect(match(-32000, "nonce too low")).toBeNull()
    expect(match(3, "execution reverted: NotOwner")).toBeNull()
    expect(match(-32000, "insufficient funds for gas * price + value")).toBeNull()
  })

  test("an unknown method on a live node is still reported as unsupported, not final", async () => {
    const { adapter } = harness({
      response: () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            error: { code: -32601, message: "the method alchemy_foo does not exist/is not available" },
          }),
        ),
    })
    const outcome = await adapter.attempt(group("alchemy_foo"), ctx)
    expect(outcome.kind).toBe("unsupported")
  })
})

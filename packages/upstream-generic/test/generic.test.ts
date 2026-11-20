import { describe, expect, test } from "bun:test"
import { BucketRegistry, silentLogger, type Group, type UpstreamInstanceConfig } from "upstream-core"
import { createAdapter } from "../src/index"

const cfg: UpstreamInstanceConfig = {
  name: "generic-ethereum",
  provider: "generic",
  package: "generic",
  url_template: "https://rpc.example/{apikey}",
  apikeys: [{ token: "K1", label: "one", buckets: [{ capacity: 100, refill_per_second: 10 }] }],
  methods: ["eth_*"],
  archive: false,
}

const deps = (fetchImpl?: typeof fetch, globalCosts?: Record<string, number>) => ({
  bucketRegistry: new BucketRegistry(() => 0),
  logger: silentLogger,
  now: () => 0,
  ...(fetchImpl === undefined ? {} : { fetchImpl }),
  ...(globalCosts === undefined ? {} : { globalCosts }),
})

const okBody = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" })

const group = (method = "eth_blockNumber"): Group => ({
  chain: "ethereum",
  items: [{ originalIndex: 0, id: 0, method, params: [], historical: false }],
  needsArchive: false,
  idempotency: "READ",
  timeoutMs: 1_000,
})

const ctx = { attempt: 0, logger: silentLogger, now: () => 0 }

describe("upstream-generic (design.md §7.3)", () => {
  test("builds an adapter straight from config, with no provider hooks", () => {
    const adapter = createAdapter(cfg, deps())
    expect(adapter.name).toBe("generic-ethereum")
    expect(adapter.provider).toBe("generic")
    expect(adapter.capability()).toEqual({ methods: ["eth_*"], archive: false })
  })

  test("substitutes {apikey} from the config template", async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: unknown) => {
      seen.push(String(input))
      return new Response(okBody(0))
    }) as unknown as typeof fetch

    await createAdapter(cfg, deps(fetchImpl)).attempt(group(), ctx)
    expect(seen).toEqual(["https://rpc.example/K1"])
  })

  test("cost falls back to the global default table (design.md §5.3)", async () => {
    const adapter = createAdapter(cfg, deps(undefined, { eth_blockNumber: 4 }))
    const registry = new BucketRegistry(() => 0)
    const withRegistry = createAdapter(cfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: () => 0,
      globalCosts: { eth_blockNumber: 4 },
      fetchImpl: (async () => new Response(okBody(0))) as unknown as typeof fetch,
    })
    await withRegistry.attempt(group(), ctx)
    expect(registry.peek("generic", "K1")!.credits(0)).toEqual([96])
    expect(adapter.weight()).toBeCloseTo(1, 10)
  })

  test("a capability mismatch is proven at runtime by the generic table (-32601)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          error: { code: -32601, message: "the method eth_foo does not exist/is not available" },
        }),
      )) as unknown as typeof fetch

    const outcome = await createAdapter(cfg, deps(fetchImpl)).attempt(group("eth_foo"), ctx)
    expect(outcome.kind).toBe("unsupported")
    if (outcome.kind !== "unsupported") throw new Error("unreachable")
    expect(outcome.items[0]!.cap).toBe("method")
  })
})

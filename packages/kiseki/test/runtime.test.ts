import { describe, expect, test } from "bun:test"
import { BucketRegistry, silentLogger } from "upstream-core"
import { buildRegistry } from "../src/registry"
import { loadConfigText } from "../src/config/index"
import { createRuntime, retainIdentities } from "../src/runtime"
import { handle } from "../src/pipeline"
import { parseRequest } from "../src/batch"

/**
 * Config → runtime wiring.
 *
 * This closes the Milestone 2 hand-off note: `defaults.timeouts` had no path to
 * `Group.timeoutMs`, and `defaults.costs` had no path to the pool. Both are
 * asserted here through the real config pipeline, so a future refactor that
 * drops the wiring fails a test instead of silently ignoring config.
 */

const env = {
  CLIENT: "client-main",
  KEY_A: "alchemy-a",
  KEY_B: "alchemy-b",
}

const configText = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify(
    {
      server: {
        port: 8545,
        host: "127.0.0.1",
        auth: { keys: [{ token: "${CLIENT}", label: "main" }] },
      },
      defaults: {
        costs: { "trace_*": 5 },
        timeouts: {
          default_seconds: 7,
          heavy_seconds: 90,
          heavy_methods: ["trace_*"],
        },
        blocked_methods: ["eth_sendTransaction"],
      },
      limits: { max_total_attempts: 2 },
      chains: {
        ethereum: {
          upstreams: [
            {
              name: "alchemy-ethereum",
              provider: "alchemy",
              package: "generic",
              url_template: "https://example.test/{apikey}",
              apikeys: [
                { token: "${KEY_A}", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
                { token: "${KEY_B}", label: "b", buckets: [{ capacity: 100, refill_per_second: 10 }] },
              ],
              methods: ["eth_*", "trace_*"],
              archive: true,
            },
          ],
        },
      },
      ...overrides,
    },
    null,
    2,
  )

const buildRuntime = (text = configText(), bucketRegistry?: BucketRegistry) => {
  const loaded = loadConfigText(text, { env, registry: buildRegistry() })
  const runtime = createRuntime({
    loaded,
    registry: buildRegistry(),
    logger: silentLogger,
    now: () => 0,
    ...(bucketRegistry === undefined ? {} : { bucketRegistry }),
  })
  return { runtime, loaded }
}

describe("createRuntime: defaults reach the routing layer", () => {
  test("defaults.timeouts become the classifier's timeout policy (§14)", () => {
    const { runtime } = buildRuntime()
    const deps = runtime.pipelineFor("ethereum")!
    expect(deps.timeouts.defaultMs).toBe(7_000)
    expect(deps.timeouts.heavyMs).toBe(90_000)
    expect(deps.timeouts.heavyMethods).toEqual(["trace_*"])
  })

  test("Group.timeoutMs follows the method class, not a hardcoded 30s", async () => {
    const captured: number[] = []
    const loaded = loadConfigText(configText(), { env, registry: buildRegistry() })
    const runtime = createRuntime({
      loaded,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    })

    // Wrap the real adapter to observe the group the router builds.
    const adapter = runtime.chainRuntime("ethereum")!.adapters[0]!
    const original = adapter.attempt.bind(adapter)
    adapter.attempt = async (group, ctx) => {
      captured.push(group.timeoutMs)
      return original(group, ctx)
    }

    const pipeline = runtime.pipelineFor("ethereum")!
    await handle(pipeline, parseRequest({ id: 1, method: "eth_blockNumber", params: [] }))
    await handle(pipeline, parseRequest({ id: 2, method: "trace_block", params: ["0x1"] }))

    // 7s default and 90s heavy, straight from defaults.timeouts.
    expect(captured).toEqual([7_000, 90_000])
  })

  test("defaults.costs reach the pool as the global layer (§5.3)", async () => {
    // trace_* costs 5 globally; capacity 100, one attempt → 95 left.
    const bucketRegistry = new BucketRegistry(() => 0)
    const loaded = loadConfigText(configText(), { env, registry: buildRegistry() })
    const runtime = createRuntime({
      loaded,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      bucketRegistry,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
        })) as unknown as typeof fetch,
    })

    await handle(
      runtime.pipelineFor("ethereum")!,
      parseRequest({ id: 1, method: "trace_block", params: ["0x1"] }),
    )

    // Only one key is charged per attempt, whichever the weighted draw picked.
    const charged = bucketRegistry
      .all()
      .map((state) => state.credits(0)[0]!)
      .sort((left, right) => left - right)
    expect(charged).toEqual([95, 100])
  })

  test("limits.max_total_attempts reaches the router (§6.3)", () => {
    const { runtime } = buildRuntime()
    expect(runtime.pipelineFor("ethereum")!.maxTotalAttempts).toBe(2)
  })

  test("defaults.blocked_methods reach the classifier (§9.2)", () => {
    const { runtime } = buildRuntime()
    expect(runtime.pipelineFor("ethereum")!.blockedMethods).toEqual(["eth_sendTransaction"])
  })

  test("an unknown chain has no pipeline", () => {
    const { runtime } = buildRuntime()
    expect(runtime.chains).toEqual(["ethereum"])
    expect(runtime.pipelineFor("base")).toBeUndefined()
    expect(runtime.chainRuntime("base")).toBeUndefined()
  })

  test("adapters are built through the composition root, in config order", () => {
    const { runtime } = buildRuntime()
    const chain = runtime.chainRuntime("ethereum")!
    expect(chain.adapters.map((adapter) => adapter.name)).toEqual(["alchemy-ethereum"])
    expect(chain.upstreams[0]!.capability).toEqual({
      methods: ["eth_*", "trace_*"],
      archive: true,
    })
  })
})

describe("createRuntime: state across a reload (design.md §19)", () => {
  test("a shared BucketRegistry keeps credits and cooldowns", () => {
    const bucketRegistry = new BucketRegistry(() => 0)
    const first = buildRuntime(configText(), bucketRegistry).runtime
    bucketRegistry.peek("alchemy", "alchemy-a")!.deduct(40, 0)
    bucketRegistry.peek("alchemy", "alchemy-b")!.markRateLimited(0)

    // Same registry, new config object → same live state.
    const second = buildRuntime(configText(), bucketRegistry).runtime
    expect(second.bucketRegistry).toBe(first.bucketRegistry)
    expect(bucketRegistry.peek("alchemy", "alchemy-a")!.credits(0)).toEqual([60])
    expect(bucketRegistry.peek("alchemy", "alchemy-b")!.cooldownRemainingMs(0)).toBeGreaterThan(0)
  })

  test("runtime notes are NOT preserved across a reload (§19)", () => {
    const bucketRegistry = new BucketRegistry(() => 0)
    const first = buildRuntime(configText(), bucketRegistry).runtime
    first.notes.note("alchemy-ethereum", "method", "trace_block")
    expect(first.notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(true)

    const second = buildRuntime(configText(), bucketRegistry).runtime
    expect(second.notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(false)
  })

  test("retainIdentities drops a bucket the new config no longer references", () => {
    const bucketRegistry = new BucketRegistry(() => 0)
    const { runtime, loaded } = buildRuntime(configText(), bucketRegistry)
    expect(bucketRegistry.size).toBe(2)

    // Rebuild the config without KEY_B.
    const trimmed = JSON.parse(configText())
    trimmed.chains.ethereum.upstreams[0].apikeys = [
      { token: "${KEY_A}", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
    ]
    const reloaded = loadConfigText(JSON.stringify(trimmed), { env, registry: buildRegistry() })

    retainIdentities(runtime, reloaded.config)
    expect(bucketRegistry.size).toBe(1)
    expect(bucketRegistry.peek("alchemy", "alchemy-a")).toBeDefined()
    expect(bucketRegistry.peek("alchemy", "alchemy-b")).toBeUndefined()
    void loaded
  })
})

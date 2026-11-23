import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { silentLogger } from "upstream-core"
import { buildRegistry } from "../src/registry"
import { loadConfigText } from "../src/config/index"
import { createRuntime, type Runtime } from "../src/runtime"
import { configFingerprints, instanceFingerprint, reloadRuntime } from "../src/reload"
import { recordingLogger } from "./helpers"

/**
 * SIGHUP reload (design.md §19, implementation.md §7).
 *
 * The §19 table is the spec, so each row is a test: buckets survive, cooldowns
 * survive, notes are reset, metrics are untouched, removed apikeys are dropped.
 * Plus the two behaviours that make reload safe in production: an unchanged
 * adapter keeps its pool state, and a bad config does not disturb a running proxy.
 */

const env = {
  CLIENT: "client-main",
  KEY_A: "alchemy-a",
  KEY_B: "alchemy-b",
}

const configObject = (overrides: {
  keys?: string[]
  methods?: string[]
  capacity?: number
  addChain?: boolean
} = {}) => {
  const keys = overrides.keys ?? ["${KEY_A}", "${KEY_B}"]
  const config = {
    server: {
      port: 8545,
      host: "127.0.0.1",
      auth: { keys: [{ token: "${CLIENT}", label: "main" }] },
    },
    chains: {
      ethereum: {
        upstreams: [
          {
            name: "alchemy-ethereum",
            provider: "alchemy",
            package: "generic",
            url_template: "https://example.test/{apikey}",
            apikeys: keys.map((token, index) => ({
              token,
              label: String.fromCharCode(97 + index),
              buckets: [{ capacity: overrides.capacity ?? 100, refill_per_second: 10 }],
            })),
            methods: overrides.methods ?? ["eth_*", "trace_*"],
            archive: true,
          },
        ],
      },
    },
    limits: { max_total_attempts: 0 },
  }
  if (overrides.addChain === true) {
    return {
      ...config,
      chains: {
        ...config.chains,
        base: {
          upstreams: [
            {
              name: "alchemy-base",
              provider: "alchemy",
              package: "generic",
              url_template: "https://base.test/{apikey}",
              apikeys: [
                { token: "${KEY_A}", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
              ],
              methods: ["eth_*"],
              archive: true,
            },
          ],
        },
      },
    }
  }
  return config
}

/** Write a config to a temp file so the reload path reads from disk like production. */
const configFile = (value: unknown): { path: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "kiseki-reload-"))
  const path = join(dir, "kiseki.yaml")
  writeFileSync(path, JSON.stringify(value, null, 2))
  return { path, dir }
}

const build = (value: unknown, now = () => 0): Runtime => {
  const loaded = loadConfigText(JSON.stringify(value), { env, registry: buildRegistry() })
  return createRuntime({ loaded, registry: buildRegistry(), logger: silentLogger, now })
}

describe("§19 — state that survives a reload", () => {
  test("bucket credits are kept because the registry is identity-keyed", () => {
    const current = build(configObject())
    current.bucketRegistry.peek("alchemy", "alchemy-a")!.deduct(40, 0)
    expect(current.bucketRegistry.peek("alchemy", "alchemy-a")!.credits(0)).toEqual([60])

    const { path } = configFile(configObject())
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runtime.bucketRegistry).toBe(current.bucketRegistry)
    expect(result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")!.credits(0)).toEqual([60])
  })

  test("a cooldown survives, because it lives on the same identity object", () => {
    const current = build(configObject())
    const state = current.bucketRegistry.peek("alchemy", "alchemy-a")!
    state.markFailure(0) // 1s exponential cooldown (§13)
    expect(state.cooldownRemainingMs(0)).toBeGreaterThan(0)

    const { path } = configFile(configObject())
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")!.cooldownRemainingMs(0),
    ).toBeGreaterThan(0)
  })

  test("runtime capability notes are RESET (§19, explicit)", () => {
    const current = build(configObject())
    current.notes.note("alchemy-ethereum", "method", "trace_block")
    expect(current.notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(true)

    const { path } = configFile(configObject())
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runtime.notes.hasMethodNote("alchemy-ethereum", "trace_block")).toBe(false)
  })

  test("an apikey removed from config loses its bucket (§19)", () => {
    const current = build(configObject())
    expect(current.bucketRegistry.size).toBe(2)

    const { path } = configFile(configObject({ keys: ["${KEY_A}"] }))
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runtime.bucketRegistry.size).toBe(1)
    expect(result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")).toBeDefined()
    expect(result.runtime.bucketRegistry.peek("alchemy", "alchemy-b")).toBeUndefined()
  })

  test("an unchanged instance keeps its adapter OBJECT, so pool state survives", () => {
    const current = build(configObject())
    const before = current.chainRuntime("ethereum")!.adapters[0]!

    const { path } = configFile(configObject())
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kept).toEqual(["alchemy-ethereum"])
    expect(result.rebuilt).toEqual([])
    // Same object identity is the point: a rebuilt pool would reset §13 health.
    expect(result.runtime.chainRuntime("ethereum")!.adapters[0]!).toBe(before)
  })

  test("a changed instance is rebuilt", () => {
    const current = build(configObject())
    const before = current.chainRuntime("ethereum")!.adapters[0]!

    const { path } = configFile(configObject({ methods: ["eth_*"] }))
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rebuilt).toEqual(["alchemy-ethereum"])
    expect(result.runtime.chainRuntime("ethereum")!.adapters[0]!).not.toBe(before)
    expect(result.runtime.chainRuntime("ethereum")!.upstreams[0]!.capability).toEqual({
      methods: ["eth_*"],
      archive: true,
    })
  })

  test("a capacity change rebuilds the adapter AND re-reads the bucket spec", () => {
    const current = build(configObject({ capacity: 100 }))
    const { path } = configFile(configObject({ capacity: 500 }))
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rebuilt).toEqual(["alchemy-ethereum"])
    // BucketRegistry.get updates capacity in place for an existing identity. The
    // credits are NOT topped up: a bigger bucket is not free quota (§19 keeps the
    // bucket, and §5.5 never mints credit).
    const state = result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")!
    expect(state.buckets[0]!.capacity).toBe(500)
    expect(state.credits(0)).toEqual([100])
  })
})

describe("§19 — config changes are reported", () => {
  test("an added chain is reported, not silently accepted", () => {
    const current = build(configObject())
    const { path } = configFile(configObject({ addChain: true }))
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.added).toEqual(["alchemy-base"])
    expect(result.runtime.chains.sort()).toEqual(["base", "ethereum"])
  })

  test("a removed chain is reported and stops resolving", () => {
    const current = build(configObject({ addChain: true }))
    const { path } = configFile(configObject())
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removed).toEqual(["alchemy-base"])
    expect(result.runtime.pipelineFor("base")).toBeUndefined()
  })
})

describe("§19 — a bad reload must not disturb a running proxy", () => {
  test("an invalid config returns an error and leaves the caller's runtime usable", () => {
    const current = build(configObject())
    const { path } = configFile({ server: { auth: { keys: [] } } })
    const { logger, records } = recordingLogger()

    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger,
      now: () => 0,
      current,
    })

    expect(result.ok).toBe(false)
    // The running runtime is untouched — the caller keeps the old object.
    expect(current.pipelineFor("ethereum")).toBeDefined()
    const error = records.find((record) => record.message === "config reload failed, keeping the running config")
    expect(error).toBeDefined()
    expect(error!.fields?.path).toBe(path)
  })

  test("a missing file is an error, not a crash", () => {
    const current = build(configObject())
    const result = reloadRuntime({
      configPath: "/nonexistent/kiseki.yaml",
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(false)
  })

  test("a missing environment variable is an error, not an empty token", () => {
    const current = build(configObject())
    const { path } = configFile(configObject())
    const result = reloadRuntime({
      configPath: path,
      // KEY_A unset: startup must refuse rather than send anonymous requests.
      env: { CLIENT: "client-main", KEY_B: "alchemy-b" },
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("KEY_A")
  })
})

describe("fingerprints", () => {
  const instance = {
    name: "a",
    provider: "alchemy",
    package: "generic",
    url_template: "https://x/{apikey}",
    methods: ["eth_*"],
    archive: true,
    apikeys: [{ token: "t", label: "a", buckets: [{ capacity: 1, refill_per_second: 1 }] }],
  }

  test("identical configs have identical fingerprints", () => {
    expect(instanceFingerprint(instance)).toBe(instanceFingerprint({ ...instance }))
  })

  test("every pool-shaping field changes the fingerprint", () => {
    const base = instanceFingerprint(instance)
    const variants = [
      { ...instance, url_template: "https://y/{apikey}" },
      { ...instance, methods: ["eth_*", "trace_*"] },
      { ...instance, archive: false },
      { ...instance, costs: { eth_call: 2 } },
      { ...instance, timeout_ms: 5000 },
      { ...instance, counts_batch_as_one_request: true },
      { ...instance, apikeys: [{ token: "t", label: "a", buckets: [{ capacity: 2, refill_per_second: 1 }] }] },
      { ...instance, apikeys: [{ token: "other", label: "a", buckets: [{ capacity: 1, refill_per_second: 1 }] }] },
      { ...instance, apikeys: [{ token: "t", label: "b", buckets: [{ capacity: 1, refill_per_second: 1 }] }] },
    ]
    for (const variant of variants) {
      expect(instanceFingerprint(variant)).not.toBe(base)
    }
  })

  test("configFingerprints covers every chain", () => {
    const loaded = loadConfigText(JSON.stringify(configObject({ addChain: true })), {
      env,
      registry: buildRegistry(),
    })
    const map = configFingerprints(loaded.config)
    expect([...map.keys()].sort()).toEqual(["alchemy-base", "alchemy-ethereum"])
  })
})

describe("§19 — a configuration diagnosis does not survive a config fix", () => {
  /** Park the key because the gateway rejected it, the way the pool would. */
  const reject = (runtime: Runtime, provider: string, token: string, status = 404): void => {
    runtime.bucketRegistry.peek(provider, token)!.markFailure(0, "misconfigured", status)
  }

  test("a changed instance's misconfigured cooldown is cleared", () => {
    const current = build(configObject())
    reject(current, "alchemy", "alchemy-a")

    // A config fix: the URL was wrong, now it is right.
    const { path } = configFile({
      ...configObject(),
      chains: {
        ethereum: {
          upstreams: [
            {
              ...configObject().chains.ethereum.upstreams[0]!,
              url_template: "https://fixed.test/{apikey}",
            },
          ],
        },
      },
    })
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const state = result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")!
    expect(state.cooldownRemainingMs(0)).toBe(0)
    expect(state.activeCooldownReason(0)).toBeUndefined()
    expect(state.health.misconfiguredStatus).toBeUndefined()
    expect(state.health.consecutiveFailures).toBe(0)
  })

  test("the next request sends again instead of waiting out the cooldown", () => {
    const current = build(configObject())
    reject(current, "alchemy", "alchemy-a")

    const { path } = configFile({
      ...configObject(),
      chains: {
        ethereum: {
          upstreams: [
            {
              ...configObject().chains.ethereum.upstreams[0]!,
              url_template: "https://fixed.test/{apikey}",
            },
          ],
        },
      },
    })
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const adapter = result.runtime.chainRuntime("ethereum")!.adapters[0]!
    expect(adapter.misconfigured()).toBeUndefined()
    expect(adapter.weight()).toBeGreaterThan(0)
  })

  test("a health cooldown on the same identity is left alone", () => {
    const current = build(configObject())
    const state = current.bucketRegistry.peek("alchemy", "alchemy-a")!
    state.markFailure(0) // unhealthy, 1s

    const { path } = configFile({
      ...configObject(),
      chains: {
        ethereum: {
          upstreams: [
            {
              ...configObject().chains.ethereum.upstreams[0]!,
              url_template: "https://fixed.test/{apikey}",
            },
          ],
        },
      },
    })
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")!
    expect(after.cooldownRemainingMs(0)).toBe(1_000)
    expect(after.activeCooldownReason(0)).toBe("unhealthy")
  })

  test("a 429 cooldown on the same identity is left alone", () => {
    const current = build(configObject())
    current.bucketRegistry.peek("alchemy", "alchemy-a")!.markRateLimited(0, 5_000)

    const { path } = configFile({
      ...configObject(),
      chains: {
        ethereum: {
          upstreams: [
            {
              ...configObject().chains.ethereum.upstreams[0]!,
              url_template: "https://fixed.test/{apikey}",
            },
          ],
        },
      },
    })
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")!
    expect(after.cooldownRemainingMs(0)).toBe(5_000)
    expect(after.activeCooldownReason(0)).toBe("rate_limited")
  })

  test("an identity used only by an UNCHANGED instance keeps its diagnosis", () => {
    const current = build(configObject())
    reject(current, "alchemy", "alchemy-a")
    reject(current, "alchemy", "alchemy-b")

    // Nothing about this instance changed, so the reload carries the adapter and
    // the diagnosis with it.
    const { path } = configFile(configObject())
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
      current,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kept).toEqual(["alchemy-ethereum"])
    const after = result.runtime.bucketRegistry.peek("alchemy", "alchemy-a")!
    expect(after.cooldownRemainingMs(0)).toBe(1_000)
    expect(after.activeCooldownReason(0)).toBe("misconfigured")
  })
})

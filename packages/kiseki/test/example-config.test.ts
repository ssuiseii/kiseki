import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BucketRegistry, silentLogger } from "upstream-core"
import { buildRegistry } from "../src/registry"
import { buildModel, loadConfigText } from "../src/config/index"

/** The env the shipped `kiseki.yaml` expects. Values are fake on purpose. */
const env = {
  KISEKI_KEY_MAIN: "client-main",
  KISEKI_KEY_INDEXER: "client-indexer",
  ALCHEMY_KEY_A: "alchemy-a",
  ALCHEMY_KEY_B: "alchemy-b",
  ANKR_KEY: "ankr-main",
}

const examplePath = join(import.meta.dir, "..", "..", "..", "kiseki.yaml")
const exampleText = readFileSync(examplePath, "utf8")

const deps = () => ({
  bucketRegistry: new BucketRegistry(() => 0),
  logger: silentLogger,
  now: () => 0,
})

describe("kiseki.yaml (the design.md §15 example) — Milestone 2 DoD", () => {
  test("validates cleanly and reports no warnings", () => {
    const loaded = loadConfigText(exampleText, { env, registry: buildRegistry() })
    expect(loaded.warnings).toEqual([])
    expect(loaded.config.server.port).toBe(8545)
    expect(loaded.config.server.host).toBe("127.0.0.1")
    expect(Object.keys(loaded.config.chains).sort()).toEqual(["base", "ethereum"])
  })

  test("applies documented defaults that the file omits", () => {
    const loaded = loadConfigText(exampleText, { env, registry: buildRegistry() })
    expect(loaded.config.limits.max_total_attempts).toBe(0)
    expect(loaded.config.metrics.enabled).toBe(true)
    expect(loaded.config.server.auth.methods).toEqual(["path", "bearer"])
  })

  test("builds one adapter per upstream, resolved through the composition root", () => {
    const loaded = loadConfigText(exampleText, { env, registry: buildRegistry() })
    const model = buildModel(loaded, deps(), buildRegistry())

    expect([...model.upstreams.keys()].sort()).toEqual(["base", "ethereum"])
    const ethereum = model.upstreams.get("ethereum")!
    expect(ethereum.map((entry) => entry.adapter.name)).toEqual([
      "alchemy-ethereum",
      "ankr-ethereum-aapi",
      "ankr-ethereum-node",
    ])
    expect(ethereum[0]!.adapter.capability()).toEqual({
      methods: ["eth_*", "trace_*", "debug_*", "replay_*"],
      archive: true,
    })
    expect(ethereum[1]!.adapter.capability().archive).toBe(false)
  })

  test("Ankr is split into an AAPI and a node instance (plan/notes-m0.md §1)", () => {
    const loaded = loadConfigText(exampleText, { env, registry: buildRegistry() })
    const model = buildModel(loaded, deps(), buildRegistry())
    const ankr = model.upstreams
      .get("ethereum")!
      .filter((entry) => entry.adapter.name.startsWith("ankr-ethereum-"))

    const aapi = ankr.find((entry) => entry.adapter.name === "ankr-ethereum-aapi")!
    const node = ankr.find((entry) => entry.adapter.name === "ankr-ethereum-node")!

    // The two APIs live on different endpoints; mixing them in one instance
    // would regroup forever (each endpoint -32601s the other's methods).
    expect(aapi.config.url_template).toContain("/multichain/")
    expect(node.config.url_template).toContain("/eth/")

    // AAPI covers the raw methods AND the derived canonical namespace.
    const aapiMethods = aapi.adapter.capability().methods
    expect(aapiMethods).toContain("ankr_*")
    expect(aapiMethods).toContain("kiseki_getTokenTransfers")
    expect(aapiMethods).toContain("kiseki_getTokenPrice")
    expect(aapiMethods).not.toContain("eth_*")

    // The node instance covers only node methods and advertises no kiseki_*.
    expect(node.adapter.capability().methods).toEqual(["eth_*"])

    // kiseki_* must never be written by hand in config: it is derived.
    for (const entry of ankr) {
      expect(entry.config.methods.some((method) => method.startsWith("kiseki_"))).toBe(false)
    }
  })

  test("reports the shared apikey identity across chains (§5.4 rule 8)", () => {
    const loaded = loadConfigText(exampleText, { env, registry: buildRegistry() })
    expect(loaded.shared).toHaveLength(1)
    expect(loaded.shared[0]!.provider).toBe("alchemy")
    expect(loaded.shared[0]!.label).toBe("a")
    expect(loaded.shared[0]!.chains.sort()).toEqual(["base", "ethereum"])
  })

  test("the shared identity really is ONE bucket shared by two chains (§5.4)", () => {
    const loaded = loadConfigText(exampleText, { env, registry: buildRegistry() })
    const bucketRegistry = new BucketRegistry(() => 0)
    const model = buildModel(
      loaded,
      { bucketRegistry, logger: silentLogger, now: () => 0 },
      buildRegistry(),
    )

    const base = model.upstreams.get("base")![0]!
    const ethereum = model.upstreams.get("ethereum")![0]!

    // Both instances must see the same live state object.
    const state = bucketRegistry.peek("alchemy", "alchemy-a")!
    state.deduct(100, 0)
    // alchemy-base has exactly one key → weight is that key's headroom.
    expect(base.adapter.weight()).toBeCloseTo(230 / 330, 10)
    // alchemy-ethereum has KEY_A (shared, drained) + KEY_B (full) → 1 + 230/330.
    expect(ethereum.adapter.weight()).toBeCloseTo(1 + 230 / 330, 10)
  })

  test("config-level costs beat the Alchemy CU table, and the table beats nothing", () => {
    const loaded = loadConfigText(exampleText, { env, registry: buildRegistry() })
    const bucketRegistry = new BucketRegistry(() => 0)
    const model = buildModel(
      loaded,
      { bucketRegistry, logger: silentLogger, now: () => 0 },
      buildRegistry(),
    )
    void model
    // Spot-check the layering through the pool: eth_call is overridden to 2 in
    // config while the Alchemy table says 26 (design.md §15 "CU asli (override)").
    // Exercised end-to-end in the alchemy package tests; here we only assert the
    // override survived the pipeline into the adapter's config.
    const ethereum = loaded.config.chains.ethereum!.upstreams[0]!
    expect(ethereum.costs).toEqual({ eth_call: 2, trace_block: 5 })
    expect(loaded.config.chains.ethereum!.upstreams[1]!.costs).toBeUndefined()
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BucketRegistry, silentLogger } from "upstream-core"
import { buildRegistry } from "../src/registry"
import { buildModel, loadConfigFile, loadConfigText } from "../src/config/index"

const env = { KEY_A: "a", KEY_B: "b", CLIENT_MAIN: "c" }

const text = (token = "${KEY_A}") =>
  JSON.stringify({
    server: { auth: { keys: [{ token: "${CLIENT_MAIN}", label: "main" }] } },
    chains: {
      ethereum: {
        upstreams: [
          {
            name: "u1",
            provider: "alchemy",
            package: "alchemy",
            url_template: "https://x/{apikey}",
            apikeys: [{ token, label: "a", buckets: [{ capacity: 10, refill_per_second: 1 }] }],
            methods: ["eth_*"],
            archive: true,
          },
        ],
      },
    },
  })

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("loadConfigFile", () => {
  test("reads and validates a file from disk", () => {
    dir = mkdtempSync(join(tmpdir(), "kiseki-"))
    const path = join(dir, "kiseki.yaml")
    writeFileSync(path, text())

    const loaded = loadConfigFile(path, { env, registry: buildRegistry() })
    expect(loaded.config.chains.ethereum!.upstreams[0]!.name).toBe("u1")
  })

  test("a missing file surfaces the filesystem error (not a silent default)", () => {
    expect(() =>
      loadConfigFile("/nonexistent/kiseki.yaml", { env, registry: buildRegistry() }),
    ).toThrow()
  })
})

describe("reload semantics (design.md §19)", () => {
  test("a reload keeps credits for identities that survive the config change", () => {
    // This is the property the bucket registry exists for: reload must not hand
    // every key a full bucket, or a SIGHUP would let us over-send.
    const registry = new BucketRegistry(() => 0)
    const deps = { bucketRegistry: registry, logger: silentLogger, now: () => 0 }

    const first = buildModel(
      loadConfigText(text(), { env, registry: buildRegistry() }),
      deps,
      buildRegistry(),
    )
    void first

    // Spend half of the key's credit.
    registry.peek("alchemy", "a")!.deduct(5, 0)

    // Reload the same config: the same identity must keep its state.
    buildModel(loadConfigText(text(), { env, registry: buildRegistry() }), deps, buildRegistry())
    expect(registry.peek("alchemy", "a")!.credits(0)).toEqual([5])
  })

  test("an identity removed from the config is dropped via retain()", () => {
    const registry = new BucketRegistry(() => 0)
    const deps = { bucketRegistry: registry, logger: silentLogger, now: () => 0 }
    buildModel(loadConfigText(text(), { env, registry: buildRegistry() }), deps, buildRegistry())
    expect(registry.size).toBe(1)

    buildModel(
      loadConfigText(text("${KEY_B}"), { env, registry: buildRegistry() }),
      deps,
      buildRegistry(),
    )
    registry.retain([{ provider: "alchemy", token: "b" }])
    expect(registry.peek("alchemy", "a")).toBeUndefined()
    expect(registry.peek("alchemy", "b")).toBeDefined()
  })
})

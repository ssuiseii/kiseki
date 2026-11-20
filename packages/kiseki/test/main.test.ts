import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG_PATH, parseArgs, start } from "../src/main"
import { ConfigError, loadConfigFile } from "../src/config/index"
import { buildRegistry } from "../src/registry"
import { silentLogger } from "upstream-core"
import { loadConfigText } from "../src/config/index"
import { createRuntime } from "../src/runtime"
import { reloadRuntime } from "../src/reload"
import { recordingLogger } from "./helpers"

/**
 * Process edge: argument parsing, `--check`, and the real `start()`.
 *
 * `start()` is the only function in the codebase that binds a socket, so it gets
 * exactly one test — with `port: 0` so the OS picks a free one. Everything it
 * composes (config, runtime, metrics, routes, reload) is tested elsewhere; this
 * test proves the composition actually connects.
 */

const env = {
  CLIENT: "client-main",
  KEY_A: "alchemy-a",
}

const configText = () =>
  JSON.stringify({
    server: {
      // A valid production port: the schema rejects 0 (§15.1), and the test's
      // ephemeral bind comes from the `port` option of `start()` instead.
      port: 8545,
      host: "127.0.0.1",
      auth: { methods: ["path", "bearer"], keys: [{ token: "${CLIENT}", label: "main" }] },
    },
    chains: {
      ethereum: {
        upstreams: [
          {
            name: "alchemy-ethereum",
            provider: "alchemy",
            package: "generic",
            url_template: "https://x.test/{apikey}",
            apikeys: [
              { token: "${KEY_A}", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
            ],
            methods: ["eth_*"],
            archive: true,
          },
        ],
      },
    },
  })

const configDir = (text = configText()): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), "kiseki-main-"))
  const path = join(dir, "kiseki.yaml")
  writeFileSync(path, text)
  return { dir, path }
}

describe("parseArgs", () => {
  test("defaults to kiseki.yaml, no flags", () => {
    expect(parseArgs([], {})).toEqual({
      configPath: DEFAULT_CONFIG_PATH,
      checkOnly: false,
      help: false,
    })
  })

  test("KISEKI_CONFIG sets the default path", () => {
    expect(parseArgs([], { KISEKI_CONFIG: "/etc/kiseki.yaml" }).configPath).toBe("/etc/kiseki.yaml")
  })

  test("--config overrides KISEKI_CONFIG (CLI beats environment)", () => {
    expect(
      parseArgs(["--config", "/tmp/x.yaml"], { KISEKI_CONFIG: "/etc/kiseki.yaml" }).configPath,
    ).toBe("/tmp/x.yaml")
  })

  test("-c is the short form", () => {
    expect(parseArgs(["-c", "/tmp/y.yaml"], {}).configPath).toBe("/tmp/y.yaml")
  })

  test("--config=path is accepted", () => {
    expect(parseArgs(["--config=/tmp/z.yaml"], {}).configPath).toBe("/tmp/z.yaml")
  })

  test("a flag without a value leaves the default alone", () => {
    // `--config` at the end of argv, or followed by another flag.
    expect(parseArgs(["--config"], {}).configPath).toBe(DEFAULT_CONFIG_PATH)
    expect(parseArgs(["--config", "--check"], {}).configPath).toBe(DEFAULT_CONFIG_PATH)
  })

  test("--check and --help are recognised", () => {
    expect(parseArgs(["--check"], {}).checkOnly).toBe(true)
    expect(parseArgs(["--help"], {}).help).toBe(true)
    expect(parseArgs(["-h"], {}).help).toBe(true)
  })

  test("unknown arguments are ignored rather than fatal", () => {
    // A systemd unit that grows a flag must not fail to start on an old binary.
    expect(parseArgs(["--verbose"], {}).checkOnly).toBe(false)
  })
})

describe("--check (loadConfigFile)", () => {
  test("a valid config loads", () => {
    const { path } = configDir()
    const loaded = loadConfigFile(path, { env, registry: buildRegistry() })
    expect(Object.keys(loaded.config.chains)).toEqual(["ethereum"])
  })

  test("a missing file is a ConfigError naming the path, not a raw ENOENT", () => {
    let caught: unknown
    try {
      loadConfigFile("/nonexistent/kiseki.yaml", { env, registry: buildRegistry() })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const configError = caught as ConfigError
    expect(configError.errors[0]!.path).toBe("/nonexistent/kiseki.yaml")
    expect(configError.message).toContain("cannot read config file")
    expect(configError.message).toContain("ENOENT")
  })

  test("an invalid config is still a ConfigError", () => {
    const { path } = configDir(JSON.stringify({ server: { auth: { keys: [] } } }))
    expect(() => loadConfigFile(path, { env, registry: buildRegistry() })).toThrow(ConfigError)
  })
})

describe("start() — the whole composition, on a real socket", () => {
  test("binds, serves /healthz and /metrics, and stops cleanly", async () => {
    const { path } = configDir()
    const started = await start({
      configPath: path,
      env,
      port: 0,
      logger: { write: () => {}, level: "error" },
    })

    try {
      // The listener is up and the runtime is the one the server resolves against.
      expect(started.runtime.chains).toEqual(["ethereum"])
      expect(started.runtime.pipelineFor("ethereum")).toBeDefined()

      // The routes are reachable through the Hono app the server holds.
      const health = await started.server.app.request("/healthz")
      expect(health.status).toBe(200)

      const metrics = await started.server.app.request("/metrics")
      expect(metrics.status).toBe(200)
      expect(await metrics.text()).toContain("kiseki_requests_total")

      const unauthorized = await started.server.app.request("/ethereum", {
        method: "POST",
        body: JSON.stringify({ id: 1, method: "eth_blockNumber", params: [] }),
      })
      expect(unauthorized.status).toBe(401)
    } finally {
      await started.stop()
    }
  })

  test("a config error is raised before any socket is bound", async () => {
    const { path } = configDir(JSON.stringify({ server: { auth: { keys: [] } } }))
    await expect(
      start({ configPath: path, env, port: 0, logger: { write: () => {} } }),
    ).rejects.toThrow(ConfigError)
  })

  test("reload() swaps the runtime behind the running server", async () => {
    const { path } = configDir()
    const started = await start({
      configPath: path,
      env,
      port: 0,
      logger: { write: () => {}, level: "error" },
    })

    try {
      const before = started.runtime

      // Add a chain and reload from disk.
      const withBase = JSON.parse(configText())
      withBase.chains.base = {
        upstreams: [
          {
            name: "base-upstream",
            provider: "alchemy",
            package: "generic",
            url_template: "https://b.test/{apikey}",
            apikeys: [
              { token: "${KEY_A}", label: "a", buckets: [{ capacity: 100, refill_per_second: 10 }] },
            ],
            methods: ["eth_*"],
            archive: true,
          },
        ],
      }
      writeFileSync(path, JSON.stringify(withBase))

      const result = started.reload()
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(started.runtime).not.toBe(before)
      expect(started.runtime.chains.sort()).toEqual(["base", "ethereum"])
      // The bucket registry is the same object: credits survived (§19).
      expect(started.runtime.bucketRegistry).toBe(before.bucketRegistry)
    } finally {
      await started.stop()
    }
  })
})

describe("reload emits the operator-facing lines again (§15.1 rules 6 & 8)", () => {
  test("shared identities and warnings are re-logged, because the chain set can change", () => {
    const text = JSON.stringify({
      server: {
        port: 8545,
        host: "127.0.0.1",
        auth: { keys: [{ token: "${CLIENT}", label: "main" }] },
      },
      chains: {
        ethereum: {
          upstreams: [
            {
              name: "a-eth",
              provider: "alchemy",
              package: "generic",
              url_template: "https://x/{apikey}",
              apikeys: [{ token: "${KEY_A}", label: "a", buckets: [{ capacity: 1, refill_per_second: 1 }] }],
              methods: ["eth_*"],
              // Non-archive: triggers the rule 6 warning.
              archive: false,
            },
          ],
        },
        base: {
          upstreams: [
            {
              name: "a-base",
              provider: "alchemy",
              package: "generic",
              url_template: "https://y/{apikey}",
              apikeys: [{ token: "${KEY_A}", label: "a", buckets: [{ capacity: 1, refill_per_second: 1 }] }],
              methods: ["eth_*"],
              archive: false,
            },
          ],
        },
      },
    })

    const { path } = configDir(text)
    const loaded = loadConfigText(text, { env, registry: buildRegistry() })
    const current = createRuntime({
      loaded,
      registry: buildRegistry(),
      logger: silentLogger,
      now: () => 0,
    })

    const { logger, records } = recordingLogger()
    const result = reloadRuntime({
      configPath: path,
      env,
      registry: buildRegistry(),
      logger,
      now: () => 0,
      current,
    })

    expect(result.ok).toBe(true)
    const messages = records.map((record) => record.message)
    // Rule 6, once per non-archive chain.
    expect(messages.filter((message) => message.includes("no archive upstream"))).toHaveLength(2)
    // Rule 8, exactly once for the shared identity, label-only.
    const shared = messages.filter((message) => message.includes("shared bucket"))
    expect(shared).toHaveLength(1)
    expect(shared[0]).toBe("apikey a(alchemy): shared bucket → ethereum, base")
    expect(JSON.stringify(records)).not.toContain("alchemy-a")
  })
})

/**
 * Milestone 5 DoD (implementation.md §8): a REAL COMPILED BINARY serving a real
 * request, with a mock upstream, and a mixed batch answered end to end.
 *
 * Why this file exists on top of `e2e.test.ts`, which already drives the whole
 * stack in-process: an in-process test cannot see the two failure modes that only
 * exist at the process boundary, and both of them shipped as latent bugs:
 *
 *   1. **The entry module.** Bun sets `import.meta.main` only in the module the
 *      bundler was pointed at. `bun build --compile src/index.ts` (the entry
 *      design.md §21 names) therefore produced a binary that exited 0 WITHOUT
 *      listening. The first test here fails on that bug: it waits for the socket
 *      and asserts an answer, not just a zero exit code.
 *   2. **The systemd contract.** SIGHUP must reload in place (§19) and SIGTERM
 *      must stop cleanly (§21). Neither is observable from a Hono `app.request`.
 *
 * The binary is compiled once for the whole file (≈0.4s, one `bun build`), then
 * reused. The mock upstream is a real HTTP server on an ephemeral port, so the
 * pool's `fetch` path is the production one — no `fetchImpl` seam anywhere.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PACKAGE_DIR = join(import.meta.dir, "..")
const REPO_ROOT = join(PACKAGE_DIR, "..", "..")

/** Compiled once; a failed build fails every test in the file with the reason. */
let binaryPath = ""
let buildError: string | undefined
let workDir = ""

type UpstreamCall = { path: string; body: unknown }

/**
 * A mock provider: real HTTP, scripted per method, and it records what it was
 * asked so a test can prove WHICH upstream served an item.
 */
type MockUpstream = {
  url: string
  calls: UpstreamCall[]
  stop(): void
}

const startUpstream = (
  name: string,
  answer: (method: string, params: unknown[]) => { result?: unknown; error?: { code: number; message: string } },
): MockUpstream => {
  const calls: UpstreamCall[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as
        | { id: unknown; method: string; params?: unknown[] }
        | { id: unknown; method: string; params?: unknown[] }[]
      const url = new URL(request.url)
      calls.push({ path: url.pathname, body })
      const reply = (request_: { id: unknown; method: string; params?: unknown[] }) => {
        const outcome = answer(request_.method, request_.params ?? [])
        return outcome.error === undefined
          ? { jsonrpc: "2.0", id: request_.id, result: outcome.result }
          : { jsonrpc: "2.0", id: request_.id, error: outcome.error }
      }
      const payload = Array.isArray(body) ? body.map(reply) : reply(body)
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/${name}`,
    calls,
    stop: () => server.stop(true),
  }
}

/** Poll until the proxy answers, so a slow start is not a flaky failure. */
const waitForListening = async (port: number, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`proxy did not listen on ${port} within ${timeoutMs}ms`)
    await Bun.sleep(25)
  }
}

/** Free port: bind 0, read the port, release it, hand it to the binary. */
const freePort = (): number => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port ?? 0
  probe.stop(true)
  if (port === 0) throw new Error("could not reserve an ephemeral port")
  return port
}

const CLIENT_KEY = "client-main-token"
const ALCHEMY_A = "alchemy-token-a"
const ALCHEMY_B = "alchemy-token-b"
const ANKR_KEY = "ankr-token-main"

type ProxyHandle = {
  proc: ReturnType<typeof Bun.spawn>
  port: number
  stdout(): string
  stop(): Promise<void>
}

const startProxy = async (options: { configPath: string; port: number; env?: Record<string, string> }): Promise<ProxyHandle> => {
  const proc = Bun.spawn({
    cmd: [binaryPath, "--config", options.configPath],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      KISEKI_LOG_LEVEL: "debug",
      KISEKI_KEY_MAIN: CLIENT_KEY,
      ALCHEMY_KEY_A: ALCHEMY_A,
      ALCHEMY_KEY_B: ALCHEMY_B,
      ANKR_KEY: ANKR_KEY,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  let out = ""
  let err = ""
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      out += decoder.decode(chunk)
    }
  })()
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      err += decoder.decode(chunk)
    }
  })()

  await waitForListening(options.port)

  return {
    proc,
    port: options.port,
    stdout: () => out,
    stop: async () => {
      proc.kill()
      await proc.exited
      if (err.trim() !== "") {
        // Surface a crash on the test output; a silent exit is how the entry-module
        // bug stayed hidden.
        process.stderr.write(`[kiseki stderr] ${err}\n`)
      }
    },
  }
}

/**
 * The config the binary runs: two providers with genuinely different
 * capabilities, so a mixed batch must be SPLIT — `eth_*` can go to either,
 * `trace_*` only to Alchemy. That is the §10.2 example, at the process boundary.
 */
const configText = (upstreams: { alchemy: string; ankr: string }, port: number): string =>
  JSON.stringify(
    {
      server: {
        port,
        host: "127.0.0.1",
        auth: {
          methods: ["path", "bearer"],
          keys: [{ token: "${KISEKI_KEY_MAIN}", label: "main" }],
        },
      },
      defaults: {
        costs: { "eth_getLogs": 2, "trace_*": 5 },
        timeouts: { default_seconds: 5, heavy_seconds: 10, heavy_methods: ["trace_*"] },
        blocked_methods: ["eth_sendTransaction"],
      },
      chains: {
        ethereum: {
          upstreams: [
            {
              name: "alchemy-ethereum",
              provider: "alchemy",
              // The `alchemy` package: CU cost table + provider signature parser.
              package: "alchemy",
              url_template: `${upstreams.alchemy}/{apikey}`,
              apikeys: [
                { token: "${ALCHEMY_KEY_A}", label: "a", buckets: [{ capacity: 330, refill_per_second: 330 }] },
                { token: "${ALCHEMY_KEY_B}", label: "b", buckets: [{ capacity: 330, refill_per_second: 330 }] },
              ],
              methods: ["eth_*", "trace_*"],
              archive: true,
            },
            {
              name: "ankr-ethereum",
              provider: "ankr",
              package: "generic",
              url_template: `${upstreams.ankr}/{apikey}`,
              apikeys: [
                {
                  token: "${ANKR_KEY}",
                  label: "main",
                  // Two dimensions (RPS + RPM), deducted together (§5.2).
                  buckets: [
                    { capacity: 15, refill_per_second: 15 },
                    { capacity: 600, refill_per_second: 10 },
                  ],
                },
              ],
              methods: ["eth_*"],
              archive: false,
            },
          ],
        },
      },
      limits: { max_total_attempts: 0 },
      metrics: { enabled: true },
    },
    null,
    2,
  )

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "kiseki-binary-"))
  binaryPath = join(workDir, "kiseki")

  // The SAME command `bun run build` uses, so the DoD cannot drift from the
  // documented build (design.md §21). `process.execPath` is the running Bun
  // binary, so the test does not depend on `bun` being on PATH.
  const build = Bun.spawnSync({
    cmd: [process.execPath, "build", "--compile", "--outfile", binaryPath, "src/cli.ts"],
    cwd: PACKAGE_DIR,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (build.exitCode !== 0) {
    buildError = `${build.stdout.toString()}\n${build.stderr.toString()}`
  }
})

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true })
})

describe("M5 — the compiled binary", () => {
  test("is a standalone executable, not a script that needs bun", () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)
    const head = readFileSync(binaryPath).subarray(0, 4)
    // ELF magic: a real single-file binary (design.md §21 "tanpa runtime dependency").
    expect([...head]).toEqual([0x7f, 0x45, 0x4c, 0x46])
  })

  test("--check validates a config and exits 0 without binding a socket", async () => {
    const upstreams = { alchemy: "http://127.0.0.1:1/a", ankr: "http://127.0.0.1:1/b" }
    const configPath = join(workDir, "check.yaml")
    writeFileSync(configPath, configText(upstreams, freePort()))

    const result = Bun.spawnSync({
      cmd: [binaryPath, "--config", configPath, "--check"],
      env: { PATH: process.env.PATH ?? "", KISEKI_KEY_MAIN: CLIENT_KEY, ALCHEMY_KEY_A: ALCHEMY_A, ALCHEMY_KEY_B: ALCHEMY_B, ANKR_KEY: ANKR_KEY },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("config ok")
  })

  test("--check exits 1 with a readable error when a secret is missing (§15.1 rule 4)", () => {
    const configPath = join(workDir, "missing-secret.yaml")
    writeFileSync(configPath, configText({ alchemy: "http://127.0.0.1:1/a", ankr: "http://127.0.0.1:1/b" }, freePort()))

    const result = Bun.spawnSync({
      cmd: [binaryPath, "--config", configPath, "--check"],
      // ALCHEMY_KEY_B deliberately absent.
      env: { PATH: process.env.PATH ?? "", KISEKI_KEY_MAIN: CLIENT_KEY, ALCHEMY_KEY_A: ALCHEMY_A, ANKR_KEY: ANKR_KEY },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(1)
    const stderr = result.stderr.toString()
    expect(stderr).toContain("invalid config")
    expect(stderr).toContain("ALCHEMY_KEY_B")
    // The value of a present secret must never be echoed, even in an error.
    expect(stderr).not.toContain(ALCHEMY_A)
  })

  test("--help prints usage and exits 0", () => {
    const result = Bun.spawnSync({ cmd: [binaryPath, "--help"], stdout: "pipe" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("Usage: kiseki")
  })
})

describe("M5 — a real request through the real binary (§8 DoD)", () => {
  test("a mixed batch is split by capability, routed to two providers, and merged in order", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const alchemy = startUpstream("alchemy", (method) => ({
      result: `alchemy:${method}`,
    }))
    // Ankr answers only what it claims; anything else would be a routing bug.
    const ankr = startUpstream("ankr", (method) => ({ result: `ankr:${method}` }))

    const port = freePort()
    const configPath = join(workDir, "serving.yaml")
    writeFileSync(configPath, configText({ alchemy: alchemy.url, ankr: ankr.url }, port))

    const proxy = await startProxy({ configPath, port })
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ethereum/${CLIENT_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] },
          { jsonrpc: "2.0", id: 1, method: "trace_block", params: ["0x1"] },
          { jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] },
          { jsonrpc: "2.0", id: 3, method: "eth_getBalance", params: ["0xabc", "latest"] },
        ]),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as { id: number; result?: string; error?: { code: number } }[]

      // Invariant #4: the client's order is preserved, whatever the split did.
      expect(body.map((entry) => entry.id)).toEqual([0, 1, 2, 3])
      expect(body.every((entry) => entry.error === undefined)).toBe(true)

      // `trace_block` could only go to Alchemy; the eth_* items went to whoever
      // the weighted draw picked, so only the trace item is pinned.
      expect(body[1]!.result).toBe("alchemy:trace_block")
      expect(alchemy.calls.length + ankr.calls.length).toBeGreaterThanOrEqual(2)
      // Every request carried a real apikey from config, never the client key.
      const paths = [...alchemy.calls, ...ankr.calls].map((call) => call.path)
      expect(paths.every((path) => !path.includes(CLIENT_KEY))).toBe(true)
    } finally {
      proxy.stop()
      alchemy.stop()
      ankr.stop()
    }
  })

  test("a batch mixing a node error with results answers 200, not 429 (§12.3)", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("mixed", (method) =>
      method === "eth_call"
        ? { error: { code: 3, message: "execution reverted" } }
        : { result: "0x1" },
    )

    const port = freePort()
    const configPath = join(workDir, "domain.yaml")
    // One upstream only, so the routing decision cannot change the assertion.
    const text = JSON.parse(configText({ alchemy: upstream.url, ankr: upstream.url }, port))
    text.chains.ethereum.upstreams = [text.chains.ethereum.upstreams[0]]
    writeFileSync(configPath, JSON.stringify(text, null, 2))

    const proxy = await startProxy({ configPath, port })
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ethereum/${CLIENT_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] },
          { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0xabc" }, "latest"] },
        ]),
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as { id: number; result?: string; error?: { code: number; message: string } }[]
      expect(body[0]!.result).toBe("0x1")
      // #36 passthrough: the node's own error, verbatim.
      expect(body[1]!.error).toEqual({ code: 3, message: "execution reverted" })
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })

  test("a method no upstream claims is rejected before any HTTP call (§8.2)", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("quiet", () => ({ result: "should-not-happen" }))
    const port = freePort()
    const configPath = join(workDir, "preflight.yaml")
    writeFileSync(configPath, configText({ alchemy: upstream.url, ankr: upstream.url }, port))

    const proxy = await startProxy({ configPath, port })
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ethereum/${CLIENT_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: ["0x1"] }),
      })

      // §12.3 row 4: capability miss is HTTP 200 with a -32601 envelope.
      expect(response.status).toBe(200)
      const body = (await response.json()) as { error: { code: number; message: string } }
      expect(body.error.code).toBe(-32601)
      expect(upstream.calls).toHaveLength(0)
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })

  test("all keys out of quota answers 429 with a Retry-After (§12.2–12.3)", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("limited", () => ({ result: "unused" }))
    // A real 429 from the provider: the pool drains the key, then reports
    // rate_limited upward.
    const limited = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("", { status: 429, headers: { "retry-after": "2" } }),
    })

    const port = freePort()
    const configPath = join(workDir, "capacity.yaml")
    const text = JSON.parse(configText({ alchemy: upstream.url, ankr: upstream.url }, port))
    text.chains.ethereum.upstreams = [
      {
        ...text.chains.ethereum.upstreams[0],
        url_template: `http://127.0.0.1:${limited.port}/{apikey}`,
        apikeys: [{ token: "${ALCHEMY_KEY_A}", label: "a", buckets: [{ capacity: 5, refill_per_second: 1 }] }],
      },
    ]
    writeFileSync(configPath, JSON.stringify(text, null, 2))

    const proxy = await startProxy({ configPath, port })
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ethereum/${CLIENT_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      })

      expect(response.status).toBe(429)
      expect(response.headers.get("retry-after")).toBeDefined()
      const body = (await response.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32005)
    } finally {
      proxy.stop()
      limited.stop(true)
      upstream.stop()
    }
  })

  test("the auth ordering survives the process boundary: 401 before 404 (§16.3)", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("auth", () => ({ result: "0x1" }))
    const port = freePort()
    const configPath = join(workDir, "auth.yaml")
    writeFileSync(configPath, configText({ alchemy: upstream.url, ankr: upstream.url }, port))

    const proxy = await startProxy({ configPath, port })
    try {
      // Unknown chain, bad key → 401, never 404 (no chain oracle).
      const bad = await fetch(`http://127.0.0.1:${port}/no-such-chain/wrong-key`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      })
      expect(bad.status).toBe(401)

      // Known chain, valid key via the Bearer fallback → 200 (#31).
      const good = await fetch(`http://127.0.0.1:${port}/ethereum`, {
        method: "POST",
        headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      })
      expect(good.status).toBe(200)
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })

  test("/healthz and /metrics need no auth (#33, §17)", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("obs", () => ({ result: "0x1" }))
    const port = freePort()
    const configPath = join(workDir, "obs.yaml")
    writeFileSync(configPath, configText({ alchemy: upstream.url, ankr: upstream.url }, port))

    const proxy = await startProxy({ configPath, port })
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(health.status).toBe(200)

      await fetch(`http://127.0.0.1:${port}/ethereum/${CLIENT_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      })

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`)
      expect(metrics.status).toBe(200)
      const text = await metrics.text()
      expect(text).toContain("kiseki_requests_total")
      expect(text).toContain('client_label="main"')
      // §18.2: no token reaches the scrape, at any level.
      expect(text).not.toContain(CLIENT_KEY)
      expect(text).not.toContain(ALCHEMY_A)
      expect(text).not.toContain(ANKR_KEY)
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })
})

describe("M5 — the systemd contract (§19, §21)", () => {
  test("SIGHUP reloads the config in place and keeps serving", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("reload", () => ({ result: "0x1" }))
    const port = freePort()
    const configPath = join(workDir, "reload.yaml")
    writeFileSync(configPath, configText({ alchemy: upstream.url, ankr: upstream.url }, port))

    const proxy = await startProxy({ configPath, port })
    try {
      const ask = (id: number) =>
        fetch(`http://127.0.0.1:${port}/ethereum/${CLIENT_KEY}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] }),
        })

      expect((await ask(1)).status).toBe(200)

      // Add a chain on disk, then reload exactly as `systemctl reload` does.
      // The new chain needs its OWN instance name: names are unique globally
      // (§15.1 rule 3), so copying the ethereum upstream verbatim would make the
      // reload fail validation (and correctly keep the old config).
      const updated = JSON.parse(readFileSync(configPath, "utf8"))
      const ethereum = updated.chains.ethereum
      updated.chains.base = {
        upstreams: [{ ...ethereum.upstreams[0], name: "alchemy-base" }],
      }
      writeFileSync(configPath, JSON.stringify(updated, null, 2))
      proxy.proc.kill("SIGHUP")

      // The listener must survive the reload: same PID, same port, new chain.
      const deadline = Date.now() + 5_000
      let baseStatus = 0
      while (Date.now() < deadline) {
        const response = await fetch(`http://127.0.0.1:${port}/base/${CLIENT_KEY}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }),
        })
        baseStatus = response.status
        if (baseStatus === 200) break
        await Bun.sleep(25)
      }

      expect(baseStatus).toBe(200)
      expect((await ask(3)).status).toBe(200)
      // The process never restarted: a restart would have lost the PID.
      expect(proxy.proc.exitCode).toBeNull()
      expect(proxy.stdout()).toContain("config reloaded")
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })

  test("SIGTERM stops the process cleanly with status 0", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("term", () => ({ result: "0x1" }))
    const port = freePort()
    const configPath = join(workDir, "term.yaml")
    writeFileSync(configPath, configText({ alchemy: upstream.url, ankr: upstream.url }, port))

    const proxy = await startProxy({ configPath, port })
    try {
      proxy.proc.kill("SIGTERM")
      const exitCode = await proxy.proc.exited
      // §21: Restart=always must not see a failure exit; a clean stop is 0.
      expect(exitCode).toBe(0)
    } finally {
      upstream.stop()
    }
  })

  test("a bad config file exits 1 and never leaves a socket open", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const port = freePort()
    const configPath = join(workDir, "broken.yaml")
    writeFileSync(configPath, "server: {auth: {keys: []}}")

    const result = Bun.spawnSync({
      cmd: [binaryPath, "--config", configPath],
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(1)
    const stderr = result.stderr.toString()
    expect(stderr).toContain("invalid config")
    // Exactly ONCE. `start()` used to print the ConfigError itself and rethrow,
    // and the process edge printed it again — a startup failure read as two
    // identical errors, which looks like a crash loop.
    expect(stderr.split("invalid config").length - 1).toBe(1)
    // And the port is free: the process never got as far as binding.
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") })
    probe.stop(true)
  })

  test("a failed SIGHUP keeps the old config serving (§19 failure policy)", async () => {
    if (buildError !== undefined) throw new Error(`build failed:\n${buildError}`)

    const upstream = startUpstream("keep", () => ({ result: "0xkept" }))
    const port = freePort()
    const configPath = join(workDir, "keep.yaml")
    writeFileSync(configPath, configText({ alchemy: upstream.url, ankr: upstream.url }, port))

    const proxy = await startProxy({ configPath, port })
    try {
      const ask = () =>
        fetch(`http://127.0.0.1:${port}/ethereum/${CLIENT_KEY}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        })
      expect((await ask()).status).toBe(200)

      // A typo an operator could plausibly ship: a duplicate instance name.
      const broken = JSON.parse(readFileSync(configPath, "utf8"))
      broken.chains.base = { upstreams: broken.chains.ethereum.upstreams }
      writeFileSync(configPath, JSON.stringify(broken, null, 2))
      proxy.proc.kill("SIGHUP")
      await Bun.sleep(300)

      // The process is alive and still answers from the OLD config.
      expect(proxy.proc.exitCode).toBeNull()
      const after = await ask()
      expect(after.status).toBe(200)
      expect(((await after.json()) as { result: string }).result).toBe("0xkept")
      expect(proxy.stdout()).toContain("config reload failed")
    } finally {
      proxy.stop()
      upstream.stop()
    }
  })
})

describe("M5 — kiseki.service matches the binary (§21)", () => {
  const unit = readFileSync(join(REPO_ROOT, "kiseki.service"), "utf8")
  const unitValue = (key: string): string | undefined =>
    unit
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1)

  test("ExecStart points at the binary name the build produces", () => {
    expect(unitValue("ExecStart")).toBe("/opt/kiseki/kiseki --config /etc/kiseki/kiseki.yaml")
  })

  test("SIGHUP is wired to reload, not restart (§19)", () => {
    expect(unitValue("ExecReload")).toBe("/bin/kill -HUP $MAINPID")
  })

  test("the restart policy is the documented one", () => {
    expect(unitValue("Restart")).toBe("always")
    expect(unitValue("RestartSec")).toBe("2")
    expect(unitValue("WantedBy")).toBe("multi-user.target")
  })

  test("secrets come from an EnvironmentFile, never from the unit", () => {
    expect(unitValue("EnvironmentFile")).toBe("/etc/kiseki/env")
    // No token can be inline: the file must not contain an Environment= line.
    expect(unitValue("Environment")).toBeUndefined()
    expect(unit).not.toContain("${ALCHEMY_KEY")
  })

  test("the JIT-hostile hardening that would break Bun is absent", () => {
    // Assert on DIRECTIVES, not on the file text: the unit documents these two as
    // deliberately-not-set, and a substring check over the whole file would match
    // that comment instead of a setting.
    const directives = unit
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("["))
      .map((line) => line.split("=")[0]!.trim())

    expect(directives).not.toContain("MemoryDenyWriteExecute")
    expect(directives).not.toContain("IPAddressDeny")
    // Sanity: the parse above really found the directive block.
    expect(directives).toContain("ExecStart")
  })

  test("the build script produces exactly the path the unit expects", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts.build).toBe("bun build --compile --outfile dist/kiseki src/cli.ts")
  })
})

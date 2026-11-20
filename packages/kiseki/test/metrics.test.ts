import { describe, expect, test } from "bun:test"
import { Registry } from "prom-client"
import { BucketRegistry, RuntimeNotes, silentLogger } from "upstream-core"
import { createMetrics, metricKeyId } from "../src/observ/metrics"
import { buildTimeoutPolicy } from "../src/classify"
import { handle, type PipelineDeps } from "../src/pipeline"
import { parseRequest } from "../src/batch"
import { fakeAdapter, success } from "./helpers"

/**
 * Metrics (design.md §18.1).
 *
 * The contract is the metric NAME and its LABELS, because that is what a dashboard
 * or alert is written against. Every test therefore asserts on the rendered
 * Prometheus text (the real output), not on internal counters — a renamed label
 * must break a test here rather than silently break a graph.
 */

const timeouts = buildTimeoutPolicy({
  default_seconds: 30,
  heavy_seconds: 120,
  heavy_methods: ["trace_*", "debug_*", "replay_*"],
})

/** Render and pull out the sample lines for one metric. */
const samples = async (
  metrics: ReturnType<typeof createMetrics>,
  name: string,
): Promise<{ labels: string; value: number }[]> => {
  const text = await metrics.render()
  const out: { labels: string; value: number }[] = []
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue
    const match = /^(?:\w+\{(.*)\}|(\w+))\s+([0-9.e+-]+)$/.exec(line)
    if (match === null) continue
    out.push({ labels: match[1] ?? "", value: Number(match[3]) })
  }
  return out
}

const valueOf = async (
  metrics: ReturnType<typeof createMetrics>,
  name: string,
  labelSubstring: string,
): Promise<number | undefined> =>
  (await samples(metrics, name)).find((sample) => sample.labels.includes(labelSubstring))?.value

describe("§18.1 — every documented metric exists with its documented labels", () => {
  test("all twelve metric names are registered", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const text = await metrics.render()
    for (const name of [
      "kiseki_requests_total",
      "kiseki_batch_items_total",
      "kiseki_upstream_attempts_total",
      "kiseki_pool_key_attempts_total",
      "kiseki_pool_key_failover_total",
      "kiseki_apikey_credits",
      "kiseki_apikey_cooldown_seconds_remaining",
      "kiseki_upstream_latency_seconds",
      "kiseki_preflight_rejects_total",
      "kiseki_capability_regroups_total",
      "kiseki_failfast_total",
      "kiseki_sendraw_ambiguous_total",
    ]) {
      expect(text).toContain(`# TYPE ${name}`)
    }
  })

  test("the label sets are the documented ones", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const text = await metrics.render()

    const help = (name: string) => text.split("\n").find((line) => line.startsWith(`# TYPE ${name}`))
    expect(help("kiseki_requests_total")).toBeDefined()

    // Counters declare their labels in the TYPE/HELP block only via samples, so
    // drive one sample of each and check the label names it carries.
    metrics.countRequest("ethereum", "default", "main")
    metrics.countBatchItems("ethereum", "main", 2)
    metrics.observer.onAttempt?.("alchemy-ethereum", "success")
    metrics.observer.onKeyAttempt?.("alchemy-ethereum", "a", "success")
    metrics.observer.onKeyFailover?.("alchemy-ethereum")
    metrics.observer.onLatency?.("alchemy-ethereum", 12)
    metrics.observer.onPreflightReject?.("ethereum", "method")
    metrics.observer.onRegroup?.({ chain: "ethereum", upstream: "x", method: "m", cap: "archive" })
    metrics.observer.onFailFast?.("ethereum", "rate_limited", "heavy")
    metrics.observer.onAmbiguous?.("alchemy-ethereum")

    const rendered = await metrics.render()
    expect(rendered).toContain('chain="ethereum",method_class="default",client_label="main"')
    expect(rendered).toContain('chain="ethereum",client_label="main"')
    expect(rendered).toContain('upstream="alchemy-ethereum",outcome="success"')
    expect(rendered).toContain('upstream="alchemy-ethereum",apikey="a",outcome="success"')
    expect(rendered).toContain('chain="ethereum",reason="method"')
    expect(rendered).toContain('chain="ethereum",cap="archive"')
    expect(rendered).toContain('chain="ethereum",method_class="heavy"')
  })
})

describe("§18.1 — counters driven by real pipeline events", () => {
  const makeDeps = (
    adapters: ReturnType<typeof fakeAdapter>[],
    metrics: ReturnType<typeof createMetrics>,
    random = () => 0,
  ): PipelineDeps => ({
    chain: "ethereum",
    upstreams: adapters.map((entry) => entry.view),
    notes: new RuntimeNotes(),
    logger: silentLogger,
    now: () => 0,
    timeouts,
    blockedMethods: ["eth_sendTransaction"],
    maxTotalAttempts: 0,
    random,
    observer: metrics.observer,
  })

  test("a request increments requests_total with the method class", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({ name: "a", outcomes: [success(0, "0x1")] })
    const result = await handle(
      makeDeps([a], metrics),
      parseRequest({ id: 1, method: "eth_blockNumber", params: [] }),
    )
    for (const methodClass of result.classes) {
      metrics.countRequest("ethereum", methodClass, "main")
    }
    expect(await valueOf(metrics, "kiseki_requests_total", 'method_class="default"')).toBe(1)
  })

  test("a heavy method is counted as heavy, not default", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({ name: "a", methods: ["trace_*"], outcomes: [success(0, "0x1")] })
    const result = await handle(
      makeDeps([a], metrics),
      parseRequest({ id: 1, method: "trace_block", params: ["0x1"] }),
    )
    expect(result.classes).toEqual(["heavy"])
    for (const methodClass of result.classes) {
      metrics.countRequest("ethereum", methodClass, "main")
    }
    expect(await valueOf(metrics, "kiseki_requests_total", 'method_class="heavy"')).toBe(1)
    expect(await valueOf(metrics, "kiseki_requests_total", 'method_class="default"')).toBeUndefined()
  })

  test("a pre-flight miss increments preflight_rejects_total{reason}", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({ name: "a", methods: ["eth_*"] })
    await handle(
      makeDeps([a], metrics),
      parseRequest({ id: 1, method: "trace_block", params: [] }),
    )
    expect(await valueOf(metrics, "kiseki_preflight_rejects_total", 'reason="method"')).toBe(1)
  })

  test("a runtime mismatch increments capability_regroups_total{cap}", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*", "trace_*"],
      outcomes: [
        {
          kind: "unsupported",
          items: [
            {
              originalIndex: 0,
              method: "trace_block",
              cap: "method",
              providerError: { code: -32601, message: "nope" },
            },
          ],
        },
      ],
    })
    const b = fakeAdapter({ name: "b", methods: ["eth_*", "trace_*"], outcomes: [success(0, "0xb")] })

    await handle(
      makeDeps([a, b], metrics),
      parseRequest({ id: 1, method: "trace_block", params: ["0x1"] }),
    )
    expect(await valueOf(metrics, "kiseki_capability_regroups_total", 'cap="method"')).toBe(1)
  })

  test("an archive mismatch is labelled cap=archive, not method", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({
      name: "a",
      methods: ["eth_*", "trace_*"],
      outcomes: [
        {
          kind: "unsupported",
          items: [
            {
              originalIndex: 0,
              method: "eth_getBalance",
              cap: "archive",
              providerError: { code: -32000, message: "missing trie node" },
            },
          ],
        },
      ],
    })
    const b = fakeAdapter({ name: "b", methods: ["eth_*", "trace_*"], outcomes: [success(0, "0x1")] })
    await handle(
      makeDeps([a, b], metrics),
      parseRequest({ id: 1, method: "eth_getBalance", params: ["0xabc", "earliest"] }),
    )
    expect(await valueOf(metrics, "kiseki_capability_regroups_total", 'cap="archive"')).toBe(1)
  })

  test("level-1 attempts increment upstream_attempts_total per upstream", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({ name: "a", outcomes: [success(0, "0x1")] })
    await handle(
      makeDeps([a], metrics),
      parseRequest({ id: 1, method: "eth_blockNumber", params: [] }),
    )
    expect(
      await valueOf(metrics, "kiseki_upstream_attempts_total", 'upstream="a",outcome="success"'),
    ).toBe(1)
  })

  test("sendRaw ambiguous increments sendraw_ambiguous_total", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], outcomes: [{ kind: "ambiguous" }] })
    await handle(
      makeDeps([a], metrics),
      parseRequest({ id: 1, method: "eth_sendRawTransaction", params: ["0xdead"] }),
    )
    expect(await valueOf(metrics, "kiseki_sendraw_ambiguous_total", 'upstream="a"')).toBe(1)
  })

  test("fail-fast is counted per method class, not per reason", async () => {
    const metrics = createMetrics({ registry: new Registry() })
    const a = fakeAdapter({
      name: "a",
      methods: ["trace_*"],
      outcomes: [{ kind: "rate_limited", retryAtMs: 1_000 }],
    })
    await handle(
      makeDeps([a], metrics),
      parseRequest({ id: 1, method: "trace_block", params: ["0x1"] }),
    )
    // §18.1 labels this metric by method_class; the router passes it through.
    expect(await valueOf(metrics, "kiseki_failfast_total", 'method_class="heavy"')).toBe(1)
    // And NOT by the internal reason, which §18.1 does not document as a label.
    expect(await valueOf(metrics, "kiseki_failfast_total", 'method_class="rate_limited"')).toBeUndefined()
  })
})

describe("§18.1 — gauges read live bucket state", () => {
  test("credits are reported per bucket index and follow deductions", async () => {
    const now = 0
    const bucketRegistry = new BucketRegistry(() => now)
    bucketRegistry.get("alchemy", "secret-a", [{ capacity: 100, refill_per_second: 10 }])
    const metrics = createMetrics({
      registry: new Registry(),
      bucketRegistry,
      keyLabels: new Map([[metricKeyId("alchemy", "secret-a"), "a"]]),
      now: () => now,
    })

    expect(await valueOf(metrics, "kiseki_apikey_credits", 'apikey="a",bucket_index="0"')).toBe(100)

    bucketRegistry.peek("alchemy", "secret-a")!.deduct(40, now)
    expect(await valueOf(metrics, "kiseki_apikey_credits", 'apikey="a",bucket_index="0"')).toBe(60)
  })

  test("two limit dimensions produce two bucket_index series", async () => {
    const bucketRegistry = new BucketRegistry(() => 0)
    bucketRegistry.get("ankr", "secret-b", [
      { capacity: 15, refill_per_second: 15 },
      { capacity: 600, refill_per_second: 10 },
    ])
    const metrics = createMetrics({
      registry: new Registry(),
      bucketRegistry,
      keyLabels: new Map([[metricKeyId("ankr", "secret-b"), "main"]]),
    })
    const series = await samples(metrics, "kiseki_apikey_credits")
    expect(series.map((sample) => sample.labels).sort()).toEqual([
      'provider="ankr",apikey="main",bucket_index="0"',
      'provider="ankr",apikey="main",bucket_index="1"',
    ])
  })

  test("a cooldown key reports seconds remaining, and 0 once ready", async () => {
    let now = 0
    const bucketRegistry = new BucketRegistry(() => now)
    const state = bucketRegistry.get("alchemy", "secret-a", [{ capacity: 100, refill_per_second: 10 }])
    const metrics = createMetrics({
      registry: new Registry(),
      bucketRegistry,
      keyLabels: new Map([[metricKeyId("alchemy", "secret-a"), "a"]]),
      now: () => now,
    })

    expect(await valueOf(metrics, "kiseki_apikey_cooldown_seconds_remaining", 'apikey="a"')).toBe(0)

    state.markFailure(now) // 1s exponential cooldown (§13)
    expect(
      await valueOf(metrics, "kiseki_apikey_cooldown_seconds_remaining", 'apikey="a"'),
    ).toBeCloseTo(1, 5)

    now = 1_000
    expect(await valueOf(metrics, "kiseki_apikey_cooldown_seconds_remaining", 'apikey="a"')).toBe(0)
  })

  test("an identity with no known label gets a stable hash, never the token", async () => {
    const bucketRegistry = new BucketRegistry(() => 0)
    bucketRegistry.get("alchemy", "super-secret-token", [{ capacity: 1, refill_per_second: 1 }])
    const metrics = createMetrics({ registry: new Registry(), bucketRegistry })

    const text = await metrics.render()
    expect(text).not.toContain("super-secret-token")
    const series = await samples(metrics, "kiseki_apikey_credits")
    expect(series).toHaveLength(1)
    expect(series[0]!.labels).toMatch(/apikey="k[0-9a-f]{8}"/)
  })
})

describe("§18.2 — no secret can reach the metrics endpoint", () => {
  test("client labels and apikey labels appear; tokens never do", async () => {
    const bucketRegistry = new BucketRegistry(() => 0)
    bucketRegistry.get("alchemy", "upstream-secret", [{ capacity: 10, refill_per_second: 1 }])
    const metrics = createMetrics({
      registry: new Registry(),
      bucketRegistry,
      keyLabels: new Map([[metricKeyId("alchemy", "upstream-secret"), "a"]]),
    })
    metrics.countRequest("ethereum", "default", "main")
    metrics.observer.onKeyAttempt?.("alchemy-ethereum", "a", "success")

    const text = await metrics.render()
    expect(text).toContain('client_label="main"')
    expect(text).toContain('apikey="a"')
    expect(text).not.toContain("upstream-secret")
  })
})

describe("per-process registry isolation", () => {
  test("two metrics instances do not share counters", async () => {
    const first = createMetrics({ registry: new Registry() })
    const second = createMetrics({ registry: new Registry() })
    first.countRequest("ethereum", "default", "main")
    expect(await valueOf(first, "kiseki_requests_total", 'client_label="main"')).toBe(1)
    expect(await valueOf(second, "kiseki_requests_total", 'client_label="main"')).toBeUndefined()
  })
})

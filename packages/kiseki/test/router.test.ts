import { describe, expect, test } from "bun:test"
import { RuntimeNotes, silentLogger } from "upstream-core"
import type { Classified } from "../src/classify"
import { candidatesFor, type UpstreamView } from "../src/capability"
import { planGroups, route, toGroup, type ItemState, type RouterObserver } from "../src/router"
import { recordingLogger, fakeAdapter } from "./helpers"

/**
 * Router level-1 tests (design.md §6, §11, implementation.md §4).
 *
 * The scenarios are the ones the design promises by name: Σ headroom weighting,
 * regroup on a runtime mismatch (#34), passthrough finalisation (#36), the
 * sendRaw three-class contract (§11.3), and the fail-fast estimate (§12.2).
 */

const classification = (overrides: Partial<Classified> = {}): Classified => ({
  method: "eth_blockNumber",
  methodClass: "default",
  needsArchive: false,
  historical: false,
  idempotency: "READ",
  timeoutMs: 30_000,
  ...overrides,
})

const item = (originalIndex: number, method = "eth_blockNumber", params: unknown[] = []) => ({
  originalIndex,
  id: originalIndex,
  method,
  params,
})

const state = (originalIndex: number, overrides: Partial<Classified> = {}): ItemState => ({
  request: item(originalIndex),
  classified: classification(overrides),
  tried: new Set(),
  mismatched: new Set(),
})

const deps = (
  upstreams: readonly UpstreamView[],
  options: {
    notes?: RuntimeNotes
    random?: () => number
    maxTotalAttempts?: number
    now?: () => number
    observer?: RouterObserver
    logger?: typeof silentLogger
    chain?: string
  } = {},
) => {
  const notes = options.notes ?? new RuntimeNotes()
  return {
    chain: options.chain ?? "ethereum",
    upstreams,
    candidatesFor: (
      request: { method: string },
      classified: Classified,
    ): readonly UpstreamView[] =>
      candidatesFor(upstreams, [request.method], classified.needsArchive, notes),
    logger: options.logger ?? silentLogger,
    now: options.now ?? (() => 0),
    maxTotalAttempts: options.maxTotalAttempts ?? 0,
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.observer === undefined ? {} : { observer: options.observer }),
  }
}

describe("eligibility & grouping (design.md §6.1, §10.1)", () => {
  test("an item only reaches upstreams whose capability covers it", async () => {
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], outcomes: [] })
    const b = fakeAdapter({ name: "b", methods: ["trace_*"], outcomes: [] })

    const plans = planGroups([state(0)], deps([a.view, b.view]).candidatesFor)
    expect(plans).toHaveLength(1)
    expect(plans[0]!.candidates.map((upstream) => upstream.name)).toEqual(["a"])
  })

  test("items with different candidate sets land in different groups", () => {
    const a = fakeAdapter({ name: "a", methods: ["eth_*", "trace_*"], outcomes: [] })
    const b = fakeAdapter({ name: "b", methods: ["eth_*"], outcomes: [] })

    const eth = state(0)
    const trace = { ...state(1), request: item(1, "trace_block") }

    const plans = planGroups([eth, trace], deps([a.view, b.view]).candidatesFor)
    expect(plans).toHaveLength(2)
    expect(plans.map((plan) => plan.candidates.length).sort()).toEqual([1, 2])
  })

  test("archive need splits groups even when the method set matches", () => {
    const archive = fakeAdapter({ name: "archive", archive: true, outcomes: [] })
    const plain = fakeAdapter({ name: "plain", archive: false, outcomes: [] })

    const recent = state(0)
    const historical = state(1, { needsArchive: true, historical: true })

    const plans = planGroups([recent, historical], deps([archive.view, plain.view]).candidatesFor)
    expect(plans).toHaveLength(2)
    const archivePlan = plans.find((plan) => plan.needsArchive)!
    expect(archivePlan.candidates.map((upstream) => upstream.name)).toEqual(["archive"])
  })

  test("idempotency class splits groups", () => {
    const a = fakeAdapter({ name: "a", outcomes: [] })
    const read = state(0)
    const write = {
      ...state(1),
      request: item(1, "eth_sendRawTransaction"),
      classified: classification({ idempotency: "NON_IDEMPOTENT" }),
    }
    const plans = planGroups([read, write], deps([a.view]).candidatesFor)
    expect(plans).toHaveLength(2)
  })

  test("a group's attempt timeout is the slowest item's (§14)", () => {
    const a = fakeAdapter({ name: "a", outcomes: [] })
    const fast = state(0)
    const slow = { ...state(1), classified: classification({ timeoutMs: 120_000 }) }
    const plans = planGroups([fast, slow], deps([a.view]).candidatesFor)
    expect(plans[0]!.timeoutMs).toBe(120_000)
    expect(toGroup("ethereum", plans[0]!).timeoutMs).toBe(120_000)
  })

  test("the payload carries historical per item and the group's archive need", () => {
    const a = fakeAdapter({ name: "a", outcomes: [] })
    const historical = {
      ...state(0),
      request: item(0, "eth_getBalance", ["0xabc", "earliest"]),
      classified: classification({ needsArchive: true, historical: true }),
    }
    const plans = planGroups([historical], deps([a.view]).candidatesFor)
    const group = toGroup("ethereum", plans[0]!)
    expect(group.needsArchive).toBe(true)
    expect(group.items[0]!.historical).toBe(true)
  })
})

describe("weighted-random over Σ headroom (design.md §6.2)", () => {
  test("weight comes from the adapter scalar, never from the router", async () => {
    // Two upstreams, weights 3 and 1 → ~75% / 25%. Both answer successfully, so
    // every route makes exactly one pick and the sample is unambiguous.
    const heavy = fakeAdapter({ name: "heavy", weight: 3, outcomes: [successOutcome(0)] })
    const light = fakeAdapter({ name: "light", weight: 1, outcomes: [successOutcome(0)] })

    const picks: string[] = []
    const observer: RouterObserver = { onAttempt: (name) => picks.push(name) }

    // A deterministic low-discrepancy stream: it sweeps the unit interval evenly
    // instead of clustering, so the assertion tests the ratio, not the RNG.
    let seed = 0
    const random = (): number => {
      seed = (seed + 0.6180339887498949) % 1
      return seed
    }

    for (let i = 0; i < 400; i += 1) {
      await route(deps([heavy.view, light.view], { random, observer }), [state(i)])
    }

    expect(picks).toHaveLength(400)
    const heavyShare = picks.filter((name) => name === "heavy").length / picks.length
    // Expected 0.75; the tolerance covers the small sample, not a wrong ratio.
    expect(heavyShare).toBeGreaterThan(0.68)
    expect(heavyShare).toBeLessThan(0.82)
  })

  test("weight 0 removes an upstream from the candidates entirely (§6.1)", async () => {
    const drained = fakeAdapter({
      name: "drained",
      weight: 0,
      outcomes: [{ kind: "success", entries: [{ originalIndex: 0, ok: true, result: "wrong" }] }],
    })
    const healthy = fakeAdapter({ name: "healthy", weight: 1, outcomes: [successOutcome(0)] })

    const outcomes = await route(deps([drained.view, healthy.view]), [state(0)])
    expect(drained.calls).toHaveLength(0)
    expect(healthy.calls).toHaveLength(1)
    expect(outcomes[0]!.result).toBe("ok")
  })

  test("a single eligible upstream is chosen without consulting random", async () => {
    const only = fakeAdapter({ name: "only", outcomes: [successOutcome(0)] })
    let asked = 0
    const outcomes = await route(
      deps([only.view], {
        random: () => {
          asked += 1
          return 0.5
        },
      }),
      [state(0)],
    )
    expect(outcomes[0]!.ok).toBe(true)
    expect(asked).toBe(0)
  })
})

const successOutcome = (originalIndex: number, result: unknown = "ok") => ({
  kind: "success" as const,
  entries: [{ originalIndex, ok: true as const, result }],
})

describe("outcome reactions (design.md §11.1)", () => {
  test("success merges entries and stops", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [successOutcome(0, "0x1")] })
    const b = fakeAdapter({ name: "b", outcomes: [successOutcome(0, "0x2")] })
    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [state(0)])
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.result).toBe("0x1")
    expect(b.calls).toHaveLength(0)
  })

  test("domain_error is final and never fails over (§11.1)", async () => {
    const a = fakeAdapter({
      name: "a",
      outcomes: [{ kind: "domain_error", entries: [
        { originalIndex: 0, ok: false, error: { code: 3, message: "execution reverted" }, final: true },
      ] }],
    })
    const b = fakeAdapter({ name: "b", outcomes: [successOutcome(0)] })
    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [state(0)])
    expect(outcomes[0]!.error).toEqual({ code: 3, message: "execution reverted" })
    expect(b.calls).toHaveLength(0)
  })

  test("rate_limited marks the upstream and tries the next one", async () => {
    const a = fakeAdapter({
      name: "a",
      outcomes: [{ kind: "rate_limited", retryAtMs: 5_000 }],
    })
    const b = fakeAdapter({ name: "b", outcomes: [successOutcome(0)] })
    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [state(0)])
    expect(outcomes[0]!.ok).toBe(true)
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  test("sick marks the upstream and tries the next one", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [{ kind: "sick", retryAtMs: 5_000 }] })
    const b = fakeAdapter({ name: "b", outcomes: [successOutcome(0)] })
    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [state(0)])
    expect(outcomes[0]!.ok).toBe(true)
    expect(b.calls).toHaveLength(1)
  })

  test("each upstream is tried at most once per item (invariant #8)", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [{ kind: "rate_limited", retryAtMs: 1_000 }] })
    const b = fakeAdapter({ name: "b", outcomes: [{ kind: "rate_limited", retryAtMs: 1_000 }] })
    const c = fakeAdapter({ name: "c", outcomes: [{ kind: "rate_limited", retryAtMs: 1_000 }] })
    await route(deps([a.view, b.view, c.view], { random: () => 0 }), [state(0)])
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(c.calls).toHaveLength(1)
  })

  test("limits.max_total_attempts caps the level-1 attempts (§6.3)", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [{ kind: "rate_limited", retryAtMs: 1_000 }] })
    const b = fakeAdapter({ name: "b", outcomes: [{ kind: "rate_limited", retryAtMs: 1_000 }] })
    const c = fakeAdapter({ name: "c", outcomes: [successOutcome(0)] })
    const outcomes = await route(
      deps([a.view, b.view, c.view], { random: () => 0, maxTotalAttempts: 2 }),
      [state(0)],
    )
    expect(a.calls.length + b.calls.length + c.calls.length).toBe(2)
    // The budget ran out on a capacity failure → fail fast, not a fake success.
    expect(outcomes[0]!.ok).toBe(false)
    expect(outcomes[0]!.error?.code).toBe(-32005)
  })
})

describe("regroup loop (decision #34)", () => {
  test("-32601 at upstream A → the item continues to B and the client gets B's answer", async () => {
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
              providerError: { code: -32601, message: "method not found" },
            },
          ],
        },
      ],
    })
    const b = fakeAdapter({
      name: "b",
      methods: ["eth_*", "trace_*"],
      outcomes: [successOutcome(0, "0xfromB")],
    })

    const notes = new RuntimeNotes()
    const trace = { ...state(0), request: item(0, "trace_block") }
    const outcomes = await route(deps([a.view, b.view], { notes, random: () => 0 }), [trace])

    expect(outcomes[0]!.ok).toBe(true)
    expect(outcomes[0]!.result).toBe("0xfromB")
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  test("the runtime note is recorded so the NEXT request skips the upstream (§8.3)", async () => {
    const notes = new RuntimeNotes()
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
    const b = fakeAdapter({
      name: "b",
      methods: ["eth_*", "trace_*"],
      outcomes: [successOutcome(0, "0xfromB"), successOutcome(0, "0xfromB2")],
    })

    // The pipeline is what records notes; here we record it the way the pipeline
    // does and assert the router then excludes A from the candidate set.
    notes.note("a", "method", "trace_block")

    const trace = { ...state(1), request: item(1, "trace_block") }
    const routerDeps = deps([a.view, b.view], { notes, random: () => 0 })
    expect(routerDeps.candidatesFor(trace.request, trace.classified).map((u) => u.name)).toEqual([
      "b",
    ])

    await route(routerDeps, [trace])
    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(1)
  })

  test("a mixed batch regroups only the mismatched item", async () => {
    const a = fakeAdapter({
      name: "a",
      outcomes: [
        {
          kind: "success",
          entries: [{ originalIndex: 0, ok: true, result: "0x1" }],
          unsupportedItems: [
            {
              originalIndex: 1,
              method: "trace_block",
              cap: "method",
              providerError: { code: -32601, message: "nope" },
            },
          ],
        },
      ],
    })
    const b = fakeAdapter({ name: "b", outcomes: [successOutcome(1, "0x2")] })

    const first = state(0)
    const second = { ...state(1), request: item(1, "trace_block") }
    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [first, second])

    const byIndex = new Map(outcomes.map((outcome) => [outcome.item.originalIndex, outcome]))
    expect(byIndex.get(0)!.result).toBe("0x1")
    expect(byIndex.get(1)!.result).toBe("0x2")
    // B saw only the regrouped item, not the one A already answered.
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]!.group.items.map((entry) => entry.originalIndex)).toEqual([1])
  })

  test("a pruned-state mismatch is an archive regroup (cap: archive)", async () => {
    const events: string[] = []
    const a = fakeAdapter({
      name: "a",
      archive: true,
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
    const b = fakeAdapter({ name: "b", archive: true, outcomes: [successOutcome(0, "0x99")] })

    const historical = {
      ...state(0),
      request: item(0, "eth_getBalance", ["0xabc", "earliest"]),
      classified: classification({ needsArchive: true, historical: true }),
    }
    const outcomes = await route(
      deps([a.view, b.view], {
        random: () => 0,
        observer: { onRegroup: (event) => events.push(event.cap) },
      }),
      [historical],
    )

    expect(events).toEqual(["archive"])
    expect(outcomes[0]!.result).toBe("0x99")
  })

  test("a regroup never revisits the upstream that proved the mismatch", async () => {
    const a = fakeAdapter({
      name: "a",
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
    // B is also unable; the loop must terminate, not ping-pong.
    const b = fakeAdapter({
      name: "b",
      outcomes: [
        {
          kind: "unsupported",
          items: [
            {
              originalIndex: 0,
              method: "trace_block",
              cap: "method",
              providerError: { code: -32601, message: "also nope" },
            },
          ],
        },
      ],
    })

    const trace = { ...state(0), request: item(0, "trace_block") }
    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [trace])

    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(outcomes[0]!.ok).toBe(false)
  })

  test("the regroup loop terminates for a long chain of mismatching upstreams", async () => {
    const adapters = Array.from({ length: 6 }, (_, index) =>
      fakeAdapter({
        name: `u${index}`,
        outcomes: [
          {
            kind: "unsupported" as const,
            items: [
              {
                originalIndex: 0,
                method: "trace_block",
                cap: "method" as const,
                providerError: { code: -32601, message: `no ${index}` },
              },
            ],
          },
        ],
      }),
    )

    const trace = { ...state(0), request: item(0, "trace_block") }
    const outcomes = await route(
      deps(adapters.map((entry) => entry.view), { random: () => 0 }),
      [trace],
    )

    for (const adapter of adapters) expect(adapter.calls).toHaveLength(1)
    expect(outcomes[0]!.ok).toBe(false)
  })
})

describe("finalisation (decision #36, §12)", () => {
  test("no candidate left after a mismatch → the last provider error, verbatim", async () => {
    const providerError = { code: -32601, message: "the method does not exist" }
    const a = fakeAdapter({
      name: "a",
      outcomes: [
        {
          kind: "unsupported",
          items: [
            { originalIndex: 0, method: "trace_block", cap: "method", providerError },
          ],
        },
      ],
    })

    const trace = { ...state(0), request: item(0, "trace_block") }
    const outcomes = await route(deps([a.view], { random: () => 0 }), [trace])

    // Passthrough: not wrapped, not re-coded — the client sees exactly what the
    // provider said (design.md §11.1 last row).
    expect(outcomes[0]!.error).toEqual(providerError)
    expect(outcomes[0]!.capacity).toBeUndefined()
  })

  test("no capacity anywhere → -32005 with a clamped Retry-After (§12.2)", async () => {
    const a = fakeAdapter({
      name: "a",
      earliestReadyAt: 100,
      outcomes: [{ kind: "rate_limited", retryAtMs: 100 }],
    })
    const outcomes = await route(deps([a.view], { now: () => 0 }), [state(0)])

    expect(outcomes[0]!.error?.code).toBe(-32005)
    expect(outcomes[0]!.capacity).toBe("rate_limited")
    // Floor is 0.5s: a 100ms estimate is not a useful client hint.
    expect(outcomes[0]!.retryAfterMs).toBe(500)
  })

  test("Retry-After is clamped to the 30s ceiling", async () => {
    const a = fakeAdapter({
      name: "a",
      earliestReadyAt: 600_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 600_000 }],
    })
    const outcomes = await route(deps([a.view], { now: () => 0 }), [state(0)])
    expect(outcomes[0]!.retryAfterMs).toBe(30_000)
  })

  test("the estimate uses the soonest capable upstream, not the slowest", async () => {
    const slow = fakeAdapter({
      name: "slow",
      earliestReadyAt: 20_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 20_000 }],
    })
    const fast = fakeAdapter({
      name: "fast",
      earliestReadyAt: 2_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 2_000 }],
    })
    const outcomes = await route(
      deps([slow.view, fast.view], { random: () => 0, now: () => 0 }),
      [state(0)],
    )
    expect(outcomes[0]!.retryAfterMs).toBe(2_000)
  })

  test("all-sick finalises as -32006, still with a Retry-After", async () => {
    const a = fakeAdapter({
      name: "a",
      earliestReadyAt: 3_000,
      outcomes: [{ kind: "sick", retryAtMs: 3_000 }],
    })
    const outcomes = await route(deps([a.view], { now: () => 0 }), [state(0)])
    expect(outcomes[0]!.error?.code).toBe(-32006)
    expect(outcomes[0]!.capacity).toBe("sick")
    expect(outcomes[0]!.retryAfterMs).toBe(3_000)
  })

  test("a mismatch followed by a rate limit fails fast, not passthrough", async () => {
    // The item is not proven impossible — it was starved after A proved it could
    // not serve it. A Retry-After is the truthful answer, and the runtime note
    // means the retry will not hit A again.
    const a = fakeAdapter({
      name: "a",
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
    const b = fakeAdapter({
      name: "b",
      earliestReadyAt: 4_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 4_000 }],
    })

    const trace = { ...state(0), request: item(0, "trace_block") }
    const outcomes = await route(deps([a.view, b.view], { random: () => 0, now: () => 0 }), [trace])

    expect(outcomes[0]!.error?.code).toBe(-32005)
    expect(outcomes[0]!.retryAfterMs).toBe(4_000)
  })

  test("an item with no candidate at all never reaches an adapter", async () => {
    const a = fakeAdapter({ name: "a", methods: ["eth_*"], outcomes: [successOutcome(0)] })
    const trace = { ...state(0), request: item(0, "trace_block") }
    const outcomes = await route(deps([a.view], { random: () => 0 }), [trace])

    expect(a.calls).toHaveLength(0)
    // No upstream could ever serve it: a pre-flight-shaped error, not capacity.
    expect(outcomes[0]!.error?.code).toBe(-32601)
    expect(outcomes[0]!.capacity).toBeUndefined()
  })
})

describe("sendRawTransaction three classes (design.md §11.3)", () => {
  const sendRawState = (): ItemState => ({
    request: item(0, "eth_sendRawTransaction", ["0xdeadbeef"]),
    classified: classification({
      method: "eth_sendRawTransaction",
      idempotency: "NON_IDEMPOTENT",
    }),
    tried: new Set(),
    mismatched: new Set(),
  })

  test("ambiguous stops the router: no second upstream is attempted", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [{ kind: "ambiguous" }] })
    const b = fakeAdapter({ name: "b", outcomes: [successOutcome(0, "0xhash")] })

    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [sendRawState()])

    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(0)
    expect(outcomes[0]!.error?.code).toBe(-32007)
    expect(outcomes[0]!.error?.message).toBe("broadcast state unknown")
  })

  test("definitive rejection is passthrough and does not fail over", async () => {
    const providerError = { code: -32000, message: "nonce too low" }
    const a = fakeAdapter({
      name: "a",
      outcomes: [
        {
          kind: "domain_error",
          entries: [{ originalIndex: 0, ok: false, error: providerError, final: true }],
        },
      ],
    })
    const b = fakeAdapter({ name: "b", outcomes: [successOutcome(0, "0xhash")] })

    const outcomes = await route(deps([a.view, b.view], { random: () => 0 }), [sendRawState()])
    expect(outcomes[0]!.error).toEqual(providerError)
    expect(b.calls).toHaveLength(0)
  })

  test("a pre-broadcast failure inside the pool surfaces as a normal success", async () => {
    // The pool already failed over between keys; the router just sees success.
    const a = fakeAdapter({ name: "a", outcomes: [successOutcome(0, "0xhash")] })
    const outcomes = await route(deps([a.view], { random: () => 0 }), [sendRawState()])
    expect(outcomes[0]!.result).toBe("0xhash")
  })

  test("ambiguous also ends sibling items of the same group", async () => {
    const a = fakeAdapter({ name: "a", outcomes: [{ kind: "ambiguous" }] })
    const outcomes = await route(deps([a.view], { random: () => 0 }), [sendRawState()])
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.error?.code).toBe(-32007)
  })
})

describe("logging (§18.2)", () => {
  test("a regroup logs the instance, method and cap — never a token", async () => {
    const { logger, records } = recordingLogger()
    const a = fakeAdapter({
      name: "alchemy-ethereum",
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
    const trace = { ...state(0), request: item(0, "trace_block") }
    await route(deps([a.view], { logger, random: () => 0 }), [trace])

    const warn = records.find((record) => record.message === "capability mismatch regroup")
    expect(warn?.fields).toEqual({
      chain: "ethereum",
      upstream: "alchemy-ethereum",
      method: "trace_block",
      cap: "method",
    })
  })

  test("an incomplete entry set is logged as an error rather than dropped", async () => {
    const { logger, records } = recordingLogger()
    // A broken adapter answers only one of two items.
    const broken = fakeAdapter({
      name: "broken",
      outcomes: [{ kind: "success", entries: [{ originalIndex: 0, ok: true, result: "x" }] }],
    })
    const first = state(0)
    const second = state(1)
    const outcomes = await route(deps([broken.view], { logger, random: () => 0 }), [first, second])

    expect(records.some((record) => record.level === "error")).toBe(true)
    // The unanswered item still gets an answer, so it cannot vanish (invariant #4).
    expect(outcomes).toHaveLength(2)
  })
})

describe("misconfiguration is a diagnosis, not a health signal (Validasi #6, #7)", () => {
  const diagnosis = (status?: number) =>
    status === undefined ? { untilMs: 1_000 } : { untilMs: 1_000, status }

  test("a misconfigured upstream is skipped: no attempt, no quota, not marked tried", async () => {
    const broken = fakeAdapter({
      name: "broken",
      weight: 0,
      misconfigured: diagnosis(404),
      outcomes: [successOutcome(0, "0xwrong")],
    })
    const healthy = fakeAdapter({ name: "healthy", weight: 1, outcomes: [successOutcome(0, "0x1")] })

    const outcomes = await route(deps([broken.view, healthy.view], { random: () => 0 }), [state(0)])

    expect(broken.calls).toHaveLength(0)
    expect(healthy.calls).toHaveLength(1)
    expect(outcomes[0]!.ok).toBe(true)
  })

  test("every candidate misconfigured and no attempt → -32008 with the status, no estimate", async () => {
    const broken = fakeAdapter({ name: "broken", weight: 0, misconfigured: diagnosis(404) })
    const alsoBroken = fakeAdapter({ name: "also", weight: 0, misconfigured: diagnosis(401) })

    const outcomes = await route(
      deps([broken.view, alsoBroken.view], { random: () => 0 }),
      [state(0)],
    )

    expect(broken.calls).toHaveLength(0)
    expect(alsoBroken.calls).toHaveLength(0)
    expect(outcomes[0]!.error?.code).toBe(-32008)
    expect(outcomes[0]!.error?.message).toBe("upstream is misconfigured")
    expect(outcomes[0]!.error?.data).toEqual({ status: 404 })
    // Never a capacity answer: no 429, no Retry-After.
    expect(outcomes[0]!.capacity).toBeUndefined()
    expect(outcomes[0]!.retryAfterMs).toBeUndefined()
  })

  test("the passive finalisation adds no attempt counter", async () => {
    const attempts: string[] = []
    const broken = fakeAdapter({ name: "broken", weight: 0, misconfigured: diagnosis(404) })
    const outcomes = await route(
      deps([broken.view], {
        random: () => 0,
        observer: { onAttempt: (upstream) => attempts.push(upstream) },
      }),
      [state(0)],
    )
    expect(attempts).toEqual([])
    expect(outcomes[0]!.error?.code).toBe(-32008)
  })

  test("a misconfigured outcome moves to the next candidate and does not park anything", async () => {
    const broken = fakeAdapter({
      name: "broken",
      outcomes: [{ kind: "misconfigured", status: 404 }],
    })
    const healthy = fakeAdapter({ name: "healthy", outcomes: [successOutcome(0, "0x1")] })

    const outcomes = await route(deps([broken.view, healthy.view], { random: () => 0 }), [state(0)])

    expect(broken.calls).toHaveLength(1)
    expect(healthy.calls).toHaveLength(1)
    expect(outcomes[0]!.ok).toBe(true)
  })

  test("misconfigured followed by rate_limited is -32005, the honest answer", async () => {
    // The item is not proven impossible: only one upstream is misconfigured, and
    // the other is merely starved.
    // A real pool reports `misconfigured()` once the rejected key has cooled down,
    // so the fake does too — otherwise the estimate below would count its recovery.
    const broken = fakeAdapter({
      name: "broken",
      misconfigured: diagnosis(404),
      outcomes: [{ kind: "misconfigured", status: 404 }],
    })
    const starved = fakeAdapter({
      name: "starved",
      earliestReadyAt: 4_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 4_000 }],
    })

    const outcomes = await route(
      deps([broken.view, starved.view], { random: () => 0, now: () => 0 }),
      [state(0)],
    )

    expect(outcomes[0]!.error?.code).toBe(-32005)
    expect(outcomes[0]!.capacity).toBe("rate_limited")
    expect(outcomes[0]!.retryAfterMs).toBe(4_000)
  })

  test("the estimate never uses a misconfigured upstream's cooldown", async () => {
    // A is misconfigured and cooling down for 30s; B is starved but recovering in
    // 2s. Waiting does not cure A, so the estimate must come from B alone.
    const broken = fakeAdapter({
      name: "broken",
      weight: 0,
      earliestReadyAt: 30_000,
      misconfigured: { untilMs: 30_000, status: 404 },
    })
    const starved = fakeAdapter({
      name: "starved",
      earliestReadyAt: 2_000,
      outcomes: [{ kind: "rate_limited", retryAtMs: 2_000 }],
    })

    const outcomes = await route(
      deps([broken.view, starved.view], { random: () => 0, now: () => 0 }),
      [state(0)],
    )

    expect(outcomes[0]!.error?.code).toBe(-32005)
    expect(outcomes[0]!.retryAfterMs).toBe(2_000)
  })

  test("a misconfigured upstream and a starved one: not all-misconfigured → -32005", async () => {
    const broken = fakeAdapter({ name: "broken", weight: 0, misconfigured: diagnosis(404) })
    const starved = fakeAdapter({
      name: "starved",
      weight: 0,
      earliestReadyAt: 3_000,
      misconfigured: undefined,
    })

    const outcomes = await route(
      deps([broken.view, starved.view], { random: () => 0, now: () => 0 }),
      [state(0)],
    )

    expect(outcomes[0]!.error?.code).toBe(-32005)
    expect(outcomes[0]!.capacity).toBe("rate_limited")
  })

  test("a misconfigured adapter does not hijack a healthy upstream's answer", async () => {
    // Both have weight; the pick must not change just because one is diagnosed.
    const broken = fakeAdapter({ name: "broken", weight: 1, misconfigured: diagnosis(404) })
    const healthy = fakeAdapter({ name: "healthy", weight: 1, outcomes: [successOutcome(0, "0x2")] })

    const outcomes = await route(deps([broken.view, healthy.view], { random: () => 0 }), [state(0)])

    expect(broken.calls).toHaveLength(0)
    expect(outcomes[0]!.ok).toBe(true)
    if (outcomes[0]!.ok) expect(outcomes[0]!.result).toBe("0x2")
  })

  test("a sick outcome still wins over a passive misconfiguration", async () => {
    const sick = fakeAdapter({
      name: "sick",
      earliestReadyAt: 1_000,
      outcomes: [{ kind: "sick", retryAtMs: 1_000 }],
    })
    const broken = fakeAdapter({ name: "broken", weight: 0, misconfigured: diagnosis(404) })

    const outcomes = await route(
      deps([sick.view, broken.view], { random: () => 0, now: () => 0 }),
      [state(0)],
    )

    expect(outcomes[0]!.error?.code).toBe(-32006)
    expect(outcomes[0]!.capacity).toBe("sick")
  })

  test("sendRaw during a passive diagnosis is -32008 without any fetch", async () => {
    const broken = fakeAdapter({ name: "broken", weight: 0, misconfigured: diagnosis(404) })
    const sendRawState: ItemState = {
      request: item(0, "eth_sendRawTransaction", ["0xdeadbeef"]),
      classified: classification({
        method: "eth_sendRawTransaction",
        idempotency: "NON_IDEMPOTENT",
      }),
      tried: new Set(),
      mismatched: new Set(),
    }

    const outcomes = await route(deps([broken.view], { random: () => 0 }), [sendRawState])

    expect(broken.calls).toHaveLength(0)
    expect(outcomes[0]!.error?.code).toBe(-32008)
  })
})

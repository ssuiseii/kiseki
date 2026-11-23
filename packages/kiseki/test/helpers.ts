/**
 * Test doubles for the routing layer.
 *
 * A fake adapter is deliberately dumb: it replays a scripted list of outcomes and
 * records the group it was handed. Everything the router is supposed to guarantee
 * — eligibility, weighting, regroup, finalisation — is therefore observable from
 * the outside, without any HTTP or bucket machinery.
 */

import type {
  AttemptCtx,
  Capability,
  Group,
  Logger,
  UpstreamAdapter,
  UpstreamOutcome,
} from "upstream-core"
import type { UpstreamView } from "../src/capability"

export type AdapterCall = { group: Group; attempt: number }

export type FakeAdapterOptions = {
  name: string
  provider?: string
  methods?: string[]
  archive?: boolean
  weight?: number
  earliestReadyAt?: number
  /**
   * Configuration diagnosis the adapter reports. Absent = not misconfigured, which
   * is what every other test wants. A test that needs the signal injects it here.
   */
  misconfigured?: { untilMs: number; status?: number }
  /**
   * Outcomes replayed in order; the last one repeats. Optional: an adapter that
   * only needs to report capability (pre-flight tests) never gets called, and one
   * driven by `onAttempt` ignores the list.
   */
  outcomes?: UpstreamOutcome[]
  /** When set, overrides the outcome list with a function of the call. */
  onAttempt?(group: Group, ctx: AttemptCtx): UpstreamOutcome | Promise<UpstreamOutcome>
}

export type FakeAdapter = {
  adapter: UpstreamAdapter
  view: UpstreamView
  calls: AdapterCall[]
}

export const fakeAdapter = (options: FakeAdapterOptions): FakeAdapter => {
  const calls: AdapterCall[] = []
  let index = 0

  const adapter: UpstreamAdapter = {
    name: options.name,
    provider: options.provider ?? "test",
    capability: (): Capability => ({
      methods: options.methods ?? ["eth_*", "trace_*", "debug_*"],
      archive: options.archive ?? true,
    }),
    weight: () => options.weight ?? 1,
    earliestReadyAt: () => options.earliestReadyAt ?? 0,
    misconfigured: () => options.misconfigured,
    attempt: async (group: Group, ctx: AttemptCtx): Promise<UpstreamOutcome> => {
      calls.push({ group, attempt: ctx.attempt })
      if (options.onAttempt !== undefined) return options.onAttempt(group, ctx)
      const scripted = options.outcomes ?? []
      const next = scripted[Math.min(index, scripted.length - 1)]
      index += 1
      if (next === undefined) throw new Error(`fake adapter ${options.name} has no outcome`)
      return next
    },
  }

  return {
    adapter,
    view: {
      name: options.name,
      provider: adapter.provider,
      adapter,
      capability: adapter.capability(),
    },
    calls,
  }
}

/** Collects log records so a test can assert on warn/error content. */
export const recordingLogger = () => {
  const records: { level: string; message: string; fields?: Record<string, unknown> }[] = []
  const push =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) })
    }
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  }
  return { logger, records }
}

/** Success outcome for one item. */
export const success = (originalIndex: number, result: unknown): UpstreamOutcome => ({
  kind: "success",
  entries: [{ originalIndex, ok: true, result }],
})

/** Success outcome covering several items at once. */
export const successAll = (
  entries: { originalIndex: number; result: unknown }[],
): UpstreamOutcome => ({
  kind: "success",
  entries: entries.map((entry) => ({
    originalIndex: entry.originalIndex,
    ok: true,
    result: entry.result,
  })),
})

export const domainError = (
  originalIndex: number,
  code: number,
  message: string,
): UpstreamOutcome => ({
  kind: "domain_error",
  entries: [{ originalIndex, ok: false, error: { code, message }, final: true }],
})

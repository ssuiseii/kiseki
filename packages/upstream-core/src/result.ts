/**
 * Classification: HTTP response → per-item verdicts (design.md §11.2,
 * implementation.md §3). Pure functions over the raw response, no I/O, so the
 * whole matrix is unit-testable.
 *
 * The caller (ApikeyPool) then decides which verdicts accumulate, which trigger
 * a key failover, and which stop everything (`ambiguous`).
 */

import { composeMatchers, type CapabilityCap, type CapabilityErrorMatcher } from "./capsig"
import type { GroupItem } from "./types/group"
import type { JsonRpcError } from "./types/jsonrpc"
import type { Entry, UnsupportedItem } from "./types/outcome"
import type { PostJsonResult } from "./http"

/** HTTP-level verdict for the whole response, before per-item analysis. */
export type ResponseClass =
  | { kind: "ok" }
  /** 429 — key hit its limit (not sickness). */
  | { kind: "rate_limited"; retryAfterMs?: number }
  /** 5xx / unparseable body — provider looks unhealthy. */
  | { kind: "server_error"; reason: string }
  /** 401/403 — the key itself is rejected; do not hammer it. */
  | { kind: "unauthorized"; reason: string; status: number }
  /** Other 4xx whose body IS a JSON-RPC envelope: the items themselves decide. */
  | { kind: "client_error"; status: number }
  /**
   * Other 4xx whose body is not a JSON-RPC envelope at all (HTML gateway page,
   * empty body, JSON primitive). The call was rejected before any node answered
   * it — a configuration problem (wrong apikey, wrong `url_template`), not the
   * client's request and not the provider's health.
   */
  | { kind: "misconfigured"; status: number }

/** Per-item verdict produced from a JSON-RPC body. */
export type ItemVerdict =
  | { kind: "result"; originalIndex: number; result: unknown }
  | { kind: "domain_error"; originalIndex: number; error: JsonRpcError }
  | { kind: "capability_mismatch"; item: UnsupportedItem }

export type ClassifiedBody = {
  verdicts: ItemVerdict[]
  /** Items with no verdict at all (missing from the response). */
  missing: GroupItem[]
}

/** Clamp absurd/absent Retry-After headers; seconds per RFC 9110. */
export const parseRetryAfter = (headers: Headers, nowMs: number): number | undefined => {
  const raw = headers.get("retry-after")
  if (raw === null || raw.trim() === "") return undefined
  const trimmed = raw.trim()

  // delta-seconds form: a non-negative integer. Anything numeric but negative is
  // malformed, and must not fall through to the date parser.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, 300_000)
  }
  if (/^[+-]?\d/.test(trimmed)) return undefined

  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.min(Math.max(0, date - nowMs), 300_000)
}

/**
 * Does this body look like something `classifyBody` could read envelopes from?
 *
 * The test is deliberately a pure shape test, mirroring `classifyBody`'s own input
 * domain: a single object or an array. It never looks at content (no
 * `content-type`, no provider string), so it applies to every gateway alike.
 * `id: null` and envelopes without `id` still pass — an error JSON-RPC answer is
 * often exactly that — while HTML, an empty body and JSON primitives do not.
 */
const isEnvelopeShaped = (text: string): boolean => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  return typeof parsed === "object" && parsed !== null
}

/** HTTP status → response class. */
export const classifyResponse = (
  response: PostJsonResult,
  nowMs: number,
): ResponseClass => {
  if (response.kind === "transport_error") {
    return { kind: "server_error", reason: `transport:${response.reason}` }
  }
  const { status, headers, text } = response
  if (status === 429) {
    return { kind: "rate_limited", retryAfterMs: parseRetryAfter(headers, nowMs) }
  }
  if (status === 401 || status === 403) {
    return { kind: "unauthorized", reason: `http ${status}`, status }
  }
  if (status >= 500) {
    return { kind: "server_error", reason: `http ${status}` }
  }
  if (status >= 400) {
    // A 4xx with a JSON envelope body is the node answering (a domain error per
    // item, final). A 4xx without one was rejected by the gateway: the call never
    // became a JSON-RPC answer, which points at the configuration behind it.
    return isEnvelopeShaped(text)
      ? { kind: "client_error", status }
      : { kind: "misconfigured", status }
  }
  if (text.trim() === "") {
    return { kind: "server_error", reason: "empty body" }
  }
  return { kind: "ok" }
}

type RawEnvelope = {
  id?: unknown
  result?: unknown
  error?: unknown
}

const asError = (value: unknown): JsonRpcError | null => {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof candidate.code !== "number") return null
  return {
    code: candidate.code,
    message: typeof candidate.message === "string" ? candidate.message : "",
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
  }
}

/**
 * Map a JSON-RPC response envelope back to its group item.
 *
 * By `id` first (the only reliable key), then by position for single-item
 * requests where a node echoes a wrong/absent id. A batch response that cannot be
 * matched is left for the caller to treat as `missing`.
 */
const matchItem = (
  envelope: RawEnvelope,
  items: readonly GroupItem[],
  usedIndexes: Set<number>,
  single: boolean,
): GroupItem | undefined => {
  const rawId = envelope.id
  if (rawId !== undefined) {
    const byId = items.find(
      (item) => !usedIndexes.has(item.originalIndex) && item.id === rawId,
    )
    if (byId !== undefined) return byId
  }
  if (single && items.length === 1 && !usedIndexes.has(items[0]!.originalIndex)) {
    return items[0]
  }
  return undefined
}

export type ClassifyBodyOptions = {
  /** Provider-specific signature hook (design.md §8.3). */
  matchCapability?: CapabilityErrorMatcher
  /** Called for each proven mismatch, so the pool can raise a runtime note. */
  onCapabilityMismatch?: (item: UnsupportedItem, cap: CapabilityCap) => void
}

/**
 * Split a 2xx JSON-RPC body into per-item verdicts, applying the capability
 * signature table to every error (design.md §11.2 rows 3–5).
 */
export const classifyBody = (
  text: string,
  items: readonly GroupItem[],
  options: ClassifyBodyOptions = {},
): ClassifiedBody => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { verdicts: [], missing: [...items] }
  }

  const envelopes: RawEnvelope[] = Array.isArray(parsed)
    ? (parsed as unknown[]).filter(
        (entry): entry is RawEnvelope => typeof entry === "object" && entry !== null,
      )
    : typeof parsed === "object" && parsed !== null
      ? [parsed as RawEnvelope]
      : []

  if (envelopes.length === 0) return { verdicts: [], missing: [...items] }

  const matcher = composeMatchers(options.matchCapability)
  const single = !Array.isArray(parsed)
  const used = new Set<number>()
  const verdicts: ItemVerdict[] = []

  for (const envelope of envelopes) {
    const item = matchItem(envelope, items, used, single)
    if (item === undefined) continue

    const error = asError(envelope.error)
    if (error !== null) {
      used.add(item.originalIndex)
      const cap = matcher(error, item.historical)
      if (cap !== null) {
        const unsupported: UnsupportedItem = {
          originalIndex: item.originalIndex,
          method: item.method,
          cap,
          providerError: error,
        }
        verdicts.push({ kind: "capability_mismatch", item: unsupported })
        options.onCapabilityMismatch?.(unsupported, cap)
      } else {
        verdicts.push({ kind: "domain_error", originalIndex: item.originalIndex, error })
      }
      continue
    }

    // A node that answers with neither `result` nor `error` is broken, not
    // authoritative: leave the item unmatched so the caller can treat the whole
    // response as unhealthy (and never as an empty success).
    if (!("result" in envelope)) continue

    used.add(item.originalIndex)
    verdicts.push({
      kind: "result",
      originalIndex: item.originalIndex,
      result: envelope.result,
    })
  }

  const missing = items.filter((item) => !used.has(item.originalIndex))
  return { verdicts, missing }
}

/** Turn a verdict into the `Entry` shape that crosses to the router. */
export const verdictToEntry = (verdict: ItemVerdict): Entry | undefined => {
  switch (verdict.kind) {
    case "result":
      return { originalIndex: verdict.originalIndex, ok: true, result: verdict.result }
    case "domain_error":
      return {
        originalIndex: verdict.originalIndex,
        ok: false,
        error: verdict.error,
        final: true,
      }
    case "capability_mismatch":
      // `final` stays false until the router gives up (implementation.md §2).
      return {
        originalIndex: verdict.item.originalIndex,
        ok: false,
        error: verdict.item.providerError,
        final: false,
      }
  }
}

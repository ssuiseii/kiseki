/**
 * Capability-mismatch signatures and runtime capability notes.
 *
 * design.md §8.3 / decision #35: a mismatch is proven at runtime by three
 * families of signals, mapped to a capability dimension:
 *
 *  - `-32601`                                    → `method`
 *  - missing/pruned state (historical query)     → `archive`
 *  - block/header not found (historical query)   → `archive` (aggressive)
 *
 * Provider packages may tighten or extend the fallback table via
 * `matchCapabilityError`. The result is never a final client error: it feeds a
 * runtime note plus a regroup (decision #34), and only becomes the client's
 * answer when no upstream is left (decision #36).
 */

import type { JsonRpcError } from "./types/jsonrpc"

export type CapabilityCap = "method" | "archive"

/**
 * Provider hook. Returns the capability dimension the error proves missing, or
 * `null` when the provider knows the error is something else (e.g. a real domain
 * error that happens to mention "not found").
 */
export type CapabilityErrorMatcher = (
  error: JsonRpcError,
  isHistorical: boolean,
) => CapabilityCap | null

const METHOD_NOT_FOUND_CODE = -32601

/** Lower-cased so patterns are case-insensitive without flags. */
const ARCHIVE_STATE_PATTERNS: readonly RegExp[] = [
  /missing trie node/,
  /state pruned/,
  /state (?:is )?not available/,
  /no state available/,
  /state for block .* (?:not available|pruned)/,
  /historical state .* not available/,
  /archive (?:node|required|mode)/,
  /pruning|pruned/,
]

/**
 * Only meaningful for historical queries: a block that a non-archive node has
 * already discarded looks identical to a block that never existed. Decision #35
 * accepts the false positive (bounded to one extra route) so that a genuine
 * classifier miss is still corrected.
 */
const HISTORICAL_BLOCK_PATTERNS: readonly RegExp[] = [
  /block not found/,
  /header not found/,
  /block .* not found/,
  /unknown block/,
]

const errorText = (error: JsonRpcError): string => {
  const data =
    error.data === undefined
      ? ""
      : typeof error.data === "string"
        ? error.data
        : JSON.stringify(error.data)
  return `${error.message} ${data}`.toLowerCase()
}

/**
 * Default signature table (implementation.md §5). Used when the provider package
 * supplies no matcher, or as the fallback after a provider matcher returns null.
 */
export const matchCapabilityError: CapabilityErrorMatcher = (error, isHistorical) => {
  if (error.code === METHOD_NOT_FOUND_CODE) return "method"

  const text = errorText(error)
  if (ARCHIVE_STATE_PATTERNS.some((pattern) => pattern.test(text))) return "archive"
  if (isHistorical && HISTORICAL_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) {
    return "archive"
  }
  return null
}

/**
 * Compose the provider matcher with the fallback table: the provider gets first
 * say (it may veto by returning null? no — null means "not mine", so fallback
 * still runs), then the general patterns apply.
 */
export const composeMatchers =
  (providerMatcher?: CapabilityErrorMatcher): CapabilityErrorMatcher =>
  (error, isHistorical) => {
    if (providerMatcher !== undefined) {
      const verdict = providerMatcher(error, isHistorical)
      if (verdict !== null) return verdict
    }
    return matchCapabilityError(error, isHistorical)
  }

/** True when the error is `-32601` (used by provider packages that special-case it). */
export const isMethodNotFound = (error: JsonRpcError): boolean =>
  error.code === METHOD_NOT_FOUND_CODE

/**
 * In-memory runtime capability notes, per upstream instance and independent of
 * apikey (design.md §8.3). They make the NEXT request skip an upstream that was
 * proven unable to serve a method/archive, instead of re-learning the mismatch.
 *
 * Reset on config reload (design.md §19) and never persisted.
 */
export class RuntimeNotes {
  /** instance → set of concrete methods proven unsupported. */
  private readonly methods = new Map<string, Set<string>>()
  /** instance → proven non-archive. */
  private readonly nonArchive = new Set<string>()

  note(instance: string, cap: CapabilityCap, method?: string): void {
    if (cap === "archive") {
      this.nonArchive.add(instance)
      return
    }
    if (method === undefined) return
    let set = this.methods.get(instance)
    if (set === undefined) {
      set = new Set()
      this.methods.set(instance, set)
    }
    set.add(method)
  }

  /** Does this instance have a proven method mismatch for `method`? */
  hasMethodNote(instance: string, method: string): boolean {
    return this.methods.get(instance)?.has(method) ?? false
  }

  /** Has this instance been proven unable to serve historical state? */
  isArchiveDisabled(instance: string): boolean {
    return this.nonArchive.has(instance)
  }

  /** Every noted method for an instance (metrics / diagnostics). */
  methodsFor(instance: string): string[] {
    return [...(this.methods.get(instance) ?? [])]
  }

  clear(): void {
    this.methods.clear()
    this.nonArchive.clear()
  }
}

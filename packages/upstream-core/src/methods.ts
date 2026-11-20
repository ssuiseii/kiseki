/**
 * Method-pattern matching for the static capability matrix (design.md §8.1).
 *
 * Patterns are exact method names or a trailing `*` wildcard (`eth_*`). A `*`
 * anywhere else is a config error caught at load time; here we simply refuse to
 * match it, so a malformed pattern fails closed (pre-flight rejects) rather than
 * claiming support for everything.
 */

export const isValidMethodPattern = (pattern: string): boolean => {
  if (pattern === "") return false
  const star = pattern.indexOf("*")
  if (star === -1) return true
  return star === pattern.length - 1
}

/** Does `method` match `pattern`? Exact, or prefix when pattern ends with `*`. */
export const matchesMethodPattern = (pattern: string, method: string): boolean => {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1)
    // Guard against a stray `*` in the middle: only the trailing one counts.
    if (prefix.includes("*")) return false
    return method.startsWith(prefix)
  }
  return pattern === method
}

/** Does any pattern in `patterns` cover `method`? */
export const supportsMethod = (
  patterns: readonly string[],
  method: string,
): boolean => patterns.some((pattern) => matchesMethodPattern(pattern, method))

/** Would `blocked` and `supported` patterns overlap? Startup validation (§15.1 r5). */
export const patternsOverlap = (a: string, b: string): boolean => {
  const prefixOf = (pattern: string): string =>
    pattern.endsWith("*") ? pattern.slice(0, -1) : `${pattern}`
  const aPrefix = prefixOf(a)
  const bPrefix = prefixOf(b)
  const aWildcard = a.endsWith("*")
  const bWildcard = b.endsWith("*")

  if (!aWildcard && !bWildcard) return a === b
  if (aWildcard && bWildcard) {
    return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix)
  }
  if (aWildcard) return bPrefix.startsWith(aPrefix)
  return aPrefix.startsWith(bPrefix)
}

/**
 * Capability check for one upstream against a group's needs (design.md §6.1).
 * Every item's method must be covered, and archive must be available when any
 * item needs it.
 */
export const capabilityCovers = (
  capability: { methods: readonly string[]; archive: boolean },
  methods: readonly string[],
  needsArchive: boolean,
): boolean => {
  if (needsArchive && !capability.archive) return false
  return methods.every((method) => supportsMethod(capability.methods, method))
}

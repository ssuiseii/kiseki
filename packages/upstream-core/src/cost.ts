/**
 * Two-layer cost table (design.md §5.3):
 *
 *   cost(method, upstream) = override_provider[method]
 *                          ?? default_global[method | prefix]
 *                          ?? 1
 *
 * Keys are either exact method names or a trailing-wildcard prefix (`trace_*`).
 * Exact matches always beat prefix matches; among prefixes, the longest wins.
 */

export type CostTable = Readonly<Record<string, number>>

const normalize = (table: CostTable | undefined): [string, number][] => {
  if (table === undefined) return []
  const entries: [string, number][] = []
  for (const [pattern, cost] of Object.entries(table)) {
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      entries.push([pattern, cost])
    }
  }
  return entries
}

/** Resolve one table: exact key, else longest matching `prefix*`, else undefined. */
export const lookupCost = (table: CostTable | undefined, method: string): number | undefined => {
  if (table === undefined) return undefined
  const exact = table[method]
  if (typeof exact === "number") return exact

  let best: { prefixLength: number; cost: number } | undefined
  for (const [pattern, cost] of Object.entries(table)) {
    if (!pattern.endsWith("*")) continue
    if (typeof cost !== "number") continue
    const prefix = pattern.slice(0, -1)
    if (!method.startsWith(prefix)) continue
    if (best === undefined || prefix.length > best.prefixLength) {
      best = { prefixLength: prefix.length, cost }
    }
  }
  return best?.cost
}

export type CostResolver = (method: string) => number

/**
 * Build the effective resolver for one upstream instance. Provider overrides are
 * checked first, then the global defaults, then the implicit cost of 1.
 */
export const buildCostResolver = (
  providerCosts: CostTable | undefined,
  globalCosts: CostTable | undefined,
): CostResolver => {
  const provider = normalize(providerCosts)
  const global = normalize(globalCosts)
  const providerTable = provider.length === 0 ? undefined : Object.fromEntries(provider)
  const globalTable = global.length === 0 ? undefined : Object.fromEntries(global)

  return (method: string): number =>
    lookupCost(providerTable, method) ?? lookupCost(globalTable, method) ?? 1
}

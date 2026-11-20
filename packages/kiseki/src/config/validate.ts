/**
 * Cross-field config validation (design.md §15.1, implementation.md §6).
 *
 * Hand-rolled on top of the zod shape (decision #38) because these rules are
 * about *relationships* between fields and between chains, and because the
 * operator deserves all of them at once: a config with three typos should not
 * need three restarts to reveal them.
 *
 * Rule numbers below refer to design.md §15.1.
 */

import { isValidMethodPattern, type AdapterRegistry } from "upstream-core"
import type { KisekiConfig } from "./schema"

/** Routes owned by the server, so they can never be chain names (rule 10). */
export const RESERVED_CHAIN_NAMES: readonly string[] = ["metrics", "healthz"]

export type ConfigIssue = {
  /** Dotted path into the config, for the operator. */
  path: string
  message: string
}

export type ValidateOptions = {
  /** Registered `package:` names; anything else is a startup error (#37). */
  registry: AdapterRegistry
}

const isPlaceholder = (url: string): boolean => url.includes("{apikey}")

export const validateCrossField = (
  config: KisekiConfig,
  options: ValidateOptions,
): ConfigIssue[] => {
  const errors: ConfigIssue[] = []
  const add = (path: string, message: string): void => {
    errors.push({ path, message })
  }

  // Rule 1 — chains non-empty, each chain has at least one upstream.
  // (zod enforces `min(1)` on both arrays; this catches the empty record case
  // with a message that names the real problem.)
  if (Object.keys(config.chains).length === 0) {
    add("chains", "at least one chain must be configured")
  }

  // Rule 3 — instance names unique globally.
  const instanceNames = new Map<string, string>()

  // Rule 4 (identity) — track where each (provider, token) appears, for the
  // informational sharing log (rule 8) and to catch a duplicate label there.
  const identities = new Map<string, { provider: string; label: string; chains: string[] }>()

  // Rule 5 (first half) — every blocked pattern must itself be a valid pattern.
  // Checked once, up front, so an invalid entry is reported once rather than once
  // per upstream method it is compared against.
  for (const blocked of config.defaults.blocked_methods) {
    if (!isValidMethodPattern(blocked)) {
      add(
        "defaults.blocked_methods",
        `invalid method pattern "${blocked}": "*" is only allowed as a trailing wildcard`,
      )
    }
  }

  // Cost-table keys are method patterns too. A key that can never match (a `*`
  // in the middle) would silently price every call at 1 credit.
  const costTables: [string, Record<string, number>][] = [["defaults.costs", config.defaults.costs]]
  for (const [chain, chainConfig] of Object.entries(config.chains)) {
    for (const [index, upstream] of chainConfig.upstreams.entries()) {
      if (upstream.costs !== undefined) {
        costTables.push([`chains.${chain}.upstreams[${index}].costs`, upstream.costs])
      }
    }
  }
  for (const [path, table] of costTables) {
    for (const key of Object.keys(table)) {
      if (!isValidMethodPattern(key)) {
        add(
          path,
          `invalid cost key "${key}": "*" is only allowed as a trailing wildcard`,
        )
      }
    }
  }

  // Rule 10 — reserved chain names.
  for (const chain of Object.keys(config.chains)) {
    if (RESERVED_CHAIN_NAMES.includes(chain)) {
      add(
        `chains.${chain}`,
        `chain name "${chain}" is reserved for a fixed route (${RESERVED_CHAIN_NAMES.join(", ")})`,
      )
    }
  }

  for (const [chain, chainConfig] of Object.entries(config.chains)) {
    for (const [index, upstream] of chainConfig.upstreams.entries()) {
      const base = `chains.${chain}.upstreams[${index}]`

      if (instanceNames.has(upstream.name)) {
        add(
          `${base}.name`,
          `instance name "${upstream.name}" is already used by chains.${instanceNames.get(upstream.name)} (names must be unique globally)`,
        )
      } else {
        instanceNames.set(upstream.name, chain)
      }

      // Rule 7 — the URL template must actually be usable.
      if (!isPlaceholder(upstream.url_template)) {
        add(
          `${base}.url_template`,
          "must contain the {apikey} placeholder, otherwise every apikey in the pool resolves to the same URL",
        )
      }

      // Rule 5 — a blocked method must not be CLAIMED explicitly by an upstream.
      //
      // Only exact names are compared, not wildcard coverage. The design's own
      // §15 example pairs `methods: ["eth_*"]` with
      // `blocked_methods: ["eth_sendTransaction"]`, so a broad wildcard over a
      // blocked name is the normal shape: the capability matrix says "this
      // upstream serves the eth_* family" while the blocked list keeps the
      // non-idempotent method off the wire (design.md §9.2). Listing a blocked
      // method by name is the actual contradiction — it asserts the proxy should
      // route a method it will refuse to route.
      for (const pattern of upstream.methods) {
        if (!isValidMethodPattern(pattern)) {
          add(
            `${base}.methods`,
            `invalid method pattern "${pattern}": "*" is only allowed as a trailing wildcard`,
          )
          continue
        }
        if (pattern.endsWith("*")) continue
        for (const blocked of config.defaults.blocked_methods) {
          if (pattern === blocked) {
            add(
              `${base}.methods`,
              `"${pattern}" is listed in defaults.blocked_methods, so it can never be routed`,
            )
          }
        }
      }

      // Rule 3 — apikey labels unique within the instance.
      const labels = new Set<string>()
      for (const [keyIndex, key] of upstream.apikeys.entries()) {
        const keyPath = `${base}.apikeys[${keyIndex}]`
        if (labels.has(key.label)) {
          add(`${keyPath}.label`, `apikey label "${key.label}" is duplicated in this instance`)
        }
        labels.add(key.label)

        // Rules 2 — capacity/refill > 0 are enforced by the zod shape; keep the
        // identity bookkeeping here for rule 8.
        const identity = `${upstream.provider}\u0000${key.token}`
        const known = identities.get(identity)
        if (known === undefined) {
          identities.set(identity, {
            provider: upstream.provider,
            label: key.label,
            chains: [chain],
          })
        } else if (!known.chains.includes(chain)) {
          known.chains.push(chain)
          // The same identity must mean the same thing everywhere: the label is
          // what metrics/logs show, so two labels for one bucket would make the
          // quota metrics unreadable (design.md §5.4).
          if (known.label !== key.label) {
            add(
              `${keyPath}.label`,
              `apikey token is shared across chains but labelled "${key.label}" here and "${known.label}" in another chain (one identity must have one label)`,
            )
          }
        }
      }
    }
  }

  // Rule 9 — client keys: non-empty, unique tokens, unique labels.
  if (config.server.auth.keys.length === 0) {
    add("server.auth.keys", "at least one client key is required")
  }
  const tokens = new Set<string>()
  const labels = new Set<string>()
  for (const [index, key] of config.server.auth.keys.entries()) {
    if (tokens.has(key.token)) {
      add(`server.auth.keys[${index}].token`, "duplicate client token")
    }
    tokens.add(key.token)
    if (labels.has(key.label)) {
      add(`server.auth.keys[${index}].label`, `duplicate client label "${key.label}"`)
    }
    labels.add(key.label)
  }

  // Composition root (#37): `package:` must resolve, never silently fall back.
  for (const [chain, chainConfig] of Object.entries(config.chains)) {
    for (const [index, upstream] of chainConfig.upstreams.entries()) {
      if (!options.registry.has(upstream.package)) {
        add(
          `chains.${chain}.upstreams[${index}].package`,
          `unknown adapter package "${upstream.package}" (registered: ${options.registry.names().join(", ")})`,
        )
      }
    }
  }

  return errors
}

/**
 * Rule 8 — identities shared across chains are the intended behaviour
 * (design.md §5.4), so they are logged at info, never treated as errors.
 */
export type SharedIdentity = { provider: string; label: string; chains: string[] }

export const sharedIdentities = (config: KisekiConfig): SharedIdentity[] => {
  const seen = new Map<string, SharedIdentity>()
  for (const [chain, chainConfig] of Object.entries(config.chains)) {
    for (const upstream of chainConfig.upstreams) {
      for (const key of upstream.apikeys) {
        const identity = `${upstream.provider}\u0000${key.token}`
        const existing = seen.get(identity)
        if (existing === undefined) {
          seen.set(identity, {
            provider: upstream.provider,
            label: key.label,
            chains: [chain],
          })
        } else if (!existing.chains.includes(chain)) {
          existing.chains.push(chain)
        }
      }
    }
  }
  return [...seen.values()].filter((identity) => identity.chains.length > 1)
}

/**
 * Rule 6 — a chain with no archive-capable upstream is a warning, not an error:
 * it simply cannot serve historical queries (design.md §15.1 rule 6).
 */
export const chainWarnings = (config: KisekiConfig): string[] => {
  const warnings: string[] = []
  for (const [chain, chainConfig] of Object.entries(config.chains)) {
    if (!chainConfig.upstreams.some((upstream) => upstream.archive)) {
      warnings.push(`chain "${chain}" has no archive upstream: historical queries will fail`)
    }
  }
  return warnings
}

/**
 * The startup info line for rule 8, worded exactly as design.md §15.1 rule 8:
 * `apikey a(alchemy): shared bucket → ethereum, base`. Label only — the token is
 * never part of the message (design.md §18.2).
 */
export const formatSharedIdentity = (identity: SharedIdentity): string =>
  `apikey ${identity.label}(${identity.provider}): shared bucket → ${identity.chains.join(", ")}`

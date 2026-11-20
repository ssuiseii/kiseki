/**
 * COMPOSITION ROOT (decision #37, implementation.md §6).
 *
 * This is the ONLY file in `kiseki` allowed to import provider packages
 * (design.md §20 dependency rules). It contains no logic: it maps a config's
 * `package:` value to the factory that builds its adapter.
 *
 * Adding a provider means adding one import and one `register` line here — never
 * a branch in the router, server or classifier.
 */

import { AdapterRegistry } from "upstream-core"
import { createAdapter as createAlchemyAdapter } from "upstream-alchemy"
import { createAdapter as createGenericAdapter } from "upstream-generic"

/** Package name used by the `package:` config key, per provider (design.md §15). */
export const PACKAGE_GENERIC = "generic"
export const PACKAGE_ALCHEMY = "alchemy"

export function buildRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry()
  registry.register(PACKAGE_GENERIC, createGenericAdapter)
  registry.register(PACKAGE_ALCHEMY, createAlchemyAdapter)
  return registry
}

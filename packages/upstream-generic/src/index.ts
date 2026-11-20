/**
 * `upstream-generic` — the fallback provider package (design.md §7.3, §20).
 *
 * A provider with no quirks needs no package of its own: the URL template, cost
 * overrides, bucket specs and capability matrix all come from config, and the
 * capability-mismatch fallback table lives in `upstream-core` (§8.3). This
 * package is therefore just the pool adapter with no provider hooks at all.
 *
 * Deliberately NOT added here: a config-driven `error_patterns` field. The frozen
 * config schema (§15) has no such key, and adding one would be a design change
 * (design.md preamble) rather than an implementation detail. A provider that
 * genuinely needs a custom signature gets a thin package that passes
 * `matchCapability`.
 */

import { createPoolAdapter, type AdapterFactory } from "upstream-core"

/** Composition-root entry point (decision #37). */
export const createAdapter: AdapterFactory = (cfg, deps) => createPoolAdapter(cfg, deps)

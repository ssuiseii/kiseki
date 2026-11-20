/**
 * Config pipeline (design.md §15, implementation.md §6):
 *
 *   raw YAML ──▶ ${VAR} interpolation (missing → error, §15.1 rule 4)
 *            ──▶ zod shape (#38)
 *            ──▶ cross-field validation (§15.1 rules 1–10)
 *            ──▶ build model: adapters resolved via the composition root (#37),
 *                all sharing one BucketRegistry (identity-keyed, #24)
 *
 * Every stage fails fast and reports *all* problems it can see, so one restart
 * surfaces the whole list instead of the first typo.
 *
 * Nothing here logs a token: errors name the variable or the config path, never a
 * value (design.md §18.2).
 */

import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import type { AdapterRegistry, CoreDeps, UpstreamAdapter } from "upstream-core"
import { interpolateTree, type EnvSource } from "./interpolate"
import { configSchema, type KisekiConfig, type UpstreamConfig } from "./schema"
import {
  chainWarnings,
  sharedIdentities,
  validateCrossField,
  type ConfigIssue,
  type SharedIdentity,
} from "./validate"

/** One or more config problems; the message lists every one of them. */
export class ConfigError extends Error {
  readonly errors: ConfigIssue[]

  constructor(errors: ConfigIssue[]) {
    super(
      `invalid config (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n` +
        errors.map((error) => `  - ${error.path}: ${error.message}`).join("\n"),
    )
    this.name = "ConfigError"
    this.errors = errors
  }
}

export type LoadOptions = {
  env?: EnvSource
  registry: AdapterRegistry
}

export type LoadedConfig = {
  config: KisekiConfig
  /** Warnings that must not block startup (§15.1 rule 6). */
  warnings: string[]
  /** Identities shared across chains, for the startup info log (rule 8). */
  shared: SharedIdentity[]
}

const zodErrors = (error: { issues: { path: PropertyKey[]; message: string }[] }): ConfigIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.map(String).join("."),
    message: issue.message,
  }))

/** Text → validated config. No I/O, so tests can drive it directly. */
export const loadConfigText = (text: string, options: LoadOptions): LoadedConfig => {
  const env = options.env ?? (process.env as EnvSource)

  // Stage 1 — YAML syntax. Parsing comes FIRST so that `${VAR}` appearing in a
  // comment (as `kiseki.yaml` documents its own syntax) is not interpolated.
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    throw new ConfigError([
      {
        path: "(yaml)",
        message: error instanceof Error ? error.message : String(error),
      },
    ])
  }

  if (raw === null || raw === undefined) {
    throw new ConfigError([{ path: "(root)", message: "config file is empty" }])
  }

  // Stage 2 — interpolation of every scalar value. A missing variable is fatal
  // before shape validation: reporting "expected string, received undefined"
  // would hide the real cause.
  const interpolated = interpolateTree(raw, env)
  if (!interpolated.ok) {
    throw new ConfigError(interpolated.errors)
  }

  // Stage 3 — shape.
  const parsed = configSchema.safeParse(interpolated.value)
  if (!parsed.success) throw new ConfigError(zodErrors(parsed.error))
  const config = parsed.data

  // Stage 4 — cross-field rules.
  const errors = validateCrossField(config, { registry: options.registry })
  if (errors.length > 0) throw new ConfigError(errors)

  return {
    config,
    warnings: chainWarnings(config),
    shared: sharedIdentities(config),
  }
}

/** Same pipeline, from a file. Used by the binary and by SIGHUP reload. */
export const loadConfigFile = (path: string, options: LoadOptions): LoadedConfig =>
  loadConfigText(readFileSync(path, "utf8"), options)

export type BuiltUpstream = {
  chain: string
  config: UpstreamConfig
  adapter: UpstreamAdapter
}

export type BuiltModel = {
  config: KisekiConfig
  warnings: string[]
  shared: SharedIdentity[]
  /** Per chain, in config order. */
  upstreams: Map<string, BuiltUpstream[]>
}

/**
 * One instance → adapter. The registry lookup is the ONLY place a config value
 * turns into a provider package (decision #37); validation already proved the
 * name exists, so a miss here is a programming error rather than a config error.
 */
const buildAdapter = (
  config: UpstreamConfig,
  deps: CoreDeps,
  registry: AdapterRegistry,
): UpstreamAdapter => {
  const factory = registry.factory(config.package)
  if (factory === undefined) {
    throw new Error(`adapter package "${config.package}" was not registered`)
  }
  return factory(
    {
      name: config.name,
      provider: config.provider,
      package: config.package,
      url_template: config.url_template,
      apikeys: config.apikeys.map((key) => ({
        token: key.token,
        label: key.label,
        buckets: key.buckets.map((bucket) => ({
          capacity: bucket.capacity,
          refill_per_second: bucket.refill_per_second,
        })),
      })),
      methods: config.methods,
      archive: config.archive,
      ...(config.costs === undefined ? {} : { costs: config.costs }),
      ...(config.counts_batch_as_one_request === undefined
        ? {}
        : { counts_batch_as_one_request: config.counts_batch_as_one_request }),
      ...(config.timeout_ms === undefined ? {} : { timeout_ms: config.timeout_ms }),
    },
    deps,
  )
}

/**
 * Build the runtime model: one adapter per upstream instance. Adapters share the
 * single `BucketRegistry` in `deps`, which is what makes `(provider, token)`
 * identities share one bucket across chains (#24).
 */
export const buildModel = (
  loaded: LoadedConfig,
  deps: CoreDeps,
  registry: AdapterRegistry,
): BuiltModel => {
  const upstreams = new Map<string, BuiltUpstream[]>()

  for (const [chain, chainConfig] of Object.entries(loaded.config.chains)) {
    upstreams.set(
      chain,
      chainConfig.upstreams.map((config) => ({
        chain,
        config,
        adapter: buildAdapter(config, deps, registry),
      })),
    )
  }

  return {
    config: loaded.config,
    warnings: loaded.warnings,
    shared: loaded.shared,
    upstreams,
  }
}

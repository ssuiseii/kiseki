/**
 * Public surface of the config pipeline (implementation.md §6).
 *
 * `schema.ts` holds the zod shape, `validate.ts` the cross-field rules,
 * `interpolate.ts` the `${VAR}` stage, and `load.ts` wires them together and
 * builds the adapter model.
 */

export { ConfigError, buildModel, loadConfigFile, loadConfigText } from "./load"
export type { BuiltModel, BuiltUpstream, LoadOptions, LoadedConfig } from "./load"

export { configSchema } from "./schema"
export type {
  ApiKeyConfig,
  AuthConfig,
  ChainConfig,
  DefaultsConfig,
  KisekiConfig,
  LimitsConfig,
  MetricsConfig,
  RawConfig,
  ServerConfig,
  UpstreamConfig,
} from "./schema"

export { interpolate, interpolateTree, referencedVariables } from "./interpolate"
export type { EnvSource, InterpolateResult } from "./interpolate"

export {
  RESERVED_CHAIN_NAMES,
  chainWarnings,
  formatSharedIdentity,
  sharedIdentities,
  validateCrossField,
} from "./validate"
export type { ConfigIssue, SharedIdentity, ValidateOptions } from "./validate"

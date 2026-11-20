/**
 * Config SHAPE, as zod schemas (decision #38, implementation.md §6).
 *
 * Shape only: types, presence, ranges, unknown-key rejection. Cross-field rules
 * (uniqueness, reserved names, blocked∩methods, …) live in `validate.ts` so that
 * every rule reports the same way and all of them are reported at once.
 *
 * Schemas are strict on purpose. A typo like `arcive: true` would otherwise
 * silently leave an upstream non-archive, and the failure would only surface as
 * a capability mismatch at runtime — exactly the class of bug the static
 * capability matrix exists to prevent (design.md §8.1).
 */

import { z } from "zod"

const positiveNumber = z.number().finite().positive()

export const bucketSchema = z.strictObject({
  capacity: positiveNumber,
  refill_per_second: positiveNumber,
})

export const apikeySchema = z.strictObject({
  token: z.string().min(1),
  label: z.string().min(1),
  /** One bucket per limit dimension (design.md §5.2). At least one is required. */
  buckets: z.array(bucketSchema).min(1),
})

export const upstreamSchema = z.strictObject({
  name: z.string().min(1),
  provider: z.string().min(1),
  /** Adapter package key; must be registered in the composition root (#37). */
  package: z.string().min(1),
  url_template: z.string().min(1),
  apikeys: z.array(apikeySchema).min(1),
  methods: z.array(z.string().min(1)).min(1),
  archive: z.boolean(),
  /** Provider cost overrides; the OUTERMOST layer of design.md §5.3. */
  costs: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  counts_batch_as_one_request: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
})

export const chainSchema = z.strictObject({
  upstreams: z.array(upstreamSchema).min(1),
})

export const authSchema = z.strictObject({
  methods: z.array(z.enum(["path", "bearer"])).min(1).default(["path", "bearer"]),
  keys: z.array(
    z.strictObject({
      token: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
})

export const serverSchema = z.strictObject({
  port: z.number().int().min(1).max(65535).default(8545),
  host: z.string().min(1).default("127.0.0.1"),
  auth: authSchema,
})

export const costsSchema = z.record(z.string(), z.number().finite().nonnegative())

export const timeoutsSchema = z.strictObject({
  default_seconds: positiveNumber.default(30),
  heavy_seconds: positiveNumber.default(120),
  heavy_methods: z.array(z.string().min(1)).default(["trace_*", "debug_*", "replay_*"]),
})

export const defaultsSchema = z.strictObject({
  costs: costsSchema.default({}),
  timeouts: timeoutsSchema.prefault({}),
  blocked_methods: z.array(z.string().min(1)).default(["eth_sendTransaction"]),
})

export const limitsSchema = z.strictObject({
  /** 0 = unlimited, the documented default (design.md Lampiran A). */
  max_total_attempts: z.number().int().nonnegative().default(0),
})

export const metricsSchema = z.strictObject({
  enabled: z.boolean().default(true),
})

export const configSchema = z.strictObject({
  server: serverSchema,
  defaults: defaultsSchema.prefault({}),
  chains: z.record(z.string().min(1), chainSchema),
  limits: limitsSchema.prefault({}),
  metrics: metricsSchema.prefault({}),
})

export type RawConfig = z.input<typeof configSchema>
export type KisekiConfig = z.output<typeof configSchema>
export type UpstreamConfig = z.output<typeof upstreamSchema>
export type ApiKeyConfig = z.output<typeof apikeySchema>
export type ChainConfig = z.output<typeof chainSchema>
export type ServerConfig = z.output<typeof serverSchema>
export type DefaultsConfig = z.output<typeof defaultsSchema>
export type LimitsConfig = z.output<typeof limitsSchema>
export type MetricsConfig = z.output<typeof metricsSchema>
export type AuthConfig = z.output<typeof authSchema>

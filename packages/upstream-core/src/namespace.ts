/**
 * Canonical-namespace contract (`kiseki_*`).
 *
 * A provider package declares HOW it serves a canonical method; the pool engine
 * applies the mapping transparently. The router never sees any of this:
 * capability enrichment makes the canonical name look like any other covered
 * method (design.md §7.3, decision #37).
 *
 * Two things live here, and nowhere else:
 *
 *  1. **`MethodTranslation`** — the per-method contract a provider package
 *     implements (canonical name, upstream name, param/result mapping).
 *  2. **The canonical Zod schemas** — one source of truth for the wire shape of
 *     every `kiseki_*` method. Providers validate their input with
 *     `parseCanonicalParams` and their output with `parseCanonicalResult`, so
 *     two providers can never drift into two slightly different "canonical"
 *     shapes.
 *
 * Schema rules (canonical, provider-independent):
 *
 *  - **Strict**: an unknown field is invalid params, never silently dropped.
 *  - Addresses, hashes and hex quantities use explicit regexes.
 *  - Token/Wei values are a full decimal string plus `valueRaw` (the upstream
 *    hex, verbatim). A JS `number` can never hold a uint256; it is not allowed
 *    anywhere in a canonical payload.
 *  - Paging is `nextPage`: an opaque string or `null`. The client returns it
 *    unchanged; its meaning is the provider's business.
 *  - `chain` in a response is the kiseki chain name (`ethereum`, not `eth`).
 */

import { z } from "zod"

import { matchesMethodPattern } from "./methods"
import type { JsonRpcError } from "./types/jsonrpc"

/** JSON-RPC 2.0 "Invalid params": the canonical request itself is malformed. */
export const ERROR_INVALID_PARAMS = -32602
/** JSON-RPC 2.0 "Internal error": the package could not map a real answer. */
export const ERROR_INTERNAL = -32603

/**
 * Canonical params → upstream params. `undefined` means "these canonical params
 * are invalid" (a client error): the item becomes a domain error and is NOT a
 * capability mismatch, so it is never regrouped.
 */
export type MethodTranslation = {
  /** Canonical method served, e.g. "kiseki_getTokenTransfers". */
  canonical: string
  /** Real upstream method, e.g. "ankr_getTokenTransfers". */
  upstream: string
  /**
   * Canonical params → upstream params. `undefined` = invalid canonical
   * params (client error) → domain error entry, NOT a capability mismatch.
   *
   * The return value becomes the JSON-RPC `params` field VERBATIM (pool.ts
   * `buildRequests`), so it takes whatever shape the provider documents: an
   * array of positional values (the usual node API) or an object with named
   * fields (e.g. a provider's enhanced API). JSON-RPC 2.0 allows both.
   *
   * Only the UPSTREAM side is free-form. The canonical side stays the array the
   * client sent, which is what `mapResponse` receives back.
   */
  mapRequest(params: readonly unknown[], chain: string): unknown | undefined
  /**
   * Upstream result → canonical result. Success responses only.
   *
   * `chain` is the kiseki chain the request was routed for. It is a separate
   * argument because every canonical result schema requires a `chain` field,
   * while the upstream payload often omits it — and when the upstream answer is
   * an empty page there is no payload field to infer it from.
   */
  mapResponse(result: unknown, params: readonly unknown[], chain: string): unknown
  /**
   * Upstream transport. Default "jsonrpc" (rewrite method/params, send via
   * the normal JSON-RPC body). "http" is reserved for providers whose
   * enhanced APIs are REST (e.g. Alchemy NFT v3, Prices API) — contract only
   * in this plan; implementation deferred, so a "http" translation is not
   * advertised by `capability()` yet.
   */
  transport?: "jsonrpc" | "http"
}

export type NamespaceHooks = {
  /** Empty/absent = package serves no canonical methods. */
  translations?: readonly MethodTranslation[]
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** 20-byte address. Mixed case is allowed: checksum casing is a display detail. */
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** 32-byte hash. */
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/
/** JSON-RPC quantity: `0x` + no leading zeros. */
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/
/** Any hex payload, verbatim (upstream `valueRaw` — leading zeros preserved). */
const HEX_PAYLOAD = /^0x[0-9a-fA-F]+$/
/** Unsigned integer as a decimal string (uint256-safe). */
const DECIMAL_UINT = /^(?:0|[1-9][0-9]*)$/
/** Decimal string with an optional fraction (prices). */
const DECIMAL_AMOUNT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
/** Block reference: a tag or a hex quantity. */
const BLOCK_REF = /^(?:latest|earliest|pending|safe|finalized|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/
/**
 * kiseki chain name (`ethereum`, `arbitrum_one`, …).
 *
 * Provider spellings (`eth`, `bsc`, `avax`, …) are rejected explicitly: a
 * provider alias leaking into a canonical payload is exactly the drift this
 * schema exists to prevent, and the aliases are a small closed set.
 */
const CHAIN_NAME = /^[a-z][a-z0-9._-]*$/
/** Single-word upstream aliases that must never appear as a kiseki chain name. */
const PROVIDER_CHAIN_ALIASES: ReadonlySet<string> = new Set([
  "eth",
  "bnb",
  "avax",
  "matic",
  "arb",
  "op",
  "ftm",
  "sol",
  "somnia",
])
/** ISO-8601 instant with an explicit zone. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

const addressSchema = z.string().regex(HEX_ADDRESS, "expected a 0x-prefixed 20-byte address")
const hashSchema = z.string().regex(HEX_HASH, "expected a 0x-prefixed 32-byte hash")
const quantitySchema = z.string().regex(HEX_QUANTITY, "expected a 0x-prefixed quantity")
const uintSchema = z.string().regex(DECIMAL_UINT, "expected an unsigned decimal string")
const blockRefSchema = z.string().regex(BLOCK_REF, "expected a block tag or a 0x-prefixed quantity")
const chainSchema = z
  .string()
  .regex(CHAIN_NAME, "expected a kiseki chain name")
  .refine(
    (value) => !PROVIDER_CHAIN_ALIASES.has(value),
    "expected a kiseki chain name, not a provider alias",
  )
const instantSchema = z.string().regex(ISO_INSTANT, "expected an ISO-8601 instant with a zone")
const pageSizeSchema = z.number().int().min(1).max(1000)
const nextPageSchema = z.string().min(1).nullable()

/**
 * A token amount: the exact decimal value plus the upstream hex, untouched.
 * Both fields are strings because a uint256 does not fit in a JS number.
 */
export const tokenAmountSchema = z.strictObject({
  value: uintSchema,
  valueRaw: z.string().regex(HEX_PAYLOAD, "expected a 0x-prefixed hex payload"),
})

export type TokenAmount = z.infer<typeof tokenAmountSchema>

/**
 * Build a canonical token amount from an upstream hex value.
 *
 * Throws on a non-hex input on purpose: providers must validate the upstream
 * payload with their own schema first, and a malformed value is a mapping bug,
 * not a client error (the pool turns a throw into a final domain error).
 */
export const tokenAmountFromRaw = (valueRaw: string): TokenAmount => ({
  value: BigInt(valueRaw).toString(),
  valueRaw,
})

/* -------------------------------------------------------------------------- */
/* Canonical methods                                                           */
/* -------------------------------------------------------------------------- */

/** `params` is a JSON-RPC array with exactly one object; `result` is the value. */
const singleObjectParams = <T extends z.ZodType>(shape: T) => z.tuple([shape])

const tokenTransferSchema = z.strictObject({
  transactionHash: hashSchema,
  blockNumber: quantitySchema,
  logIndex: z.number().int().min(0).optional(),
  from: addressSchema,
  to: addressSchema,
  /** Token contract; absent for a native-coin transfer. */
  contract: addressSchema.optional(),
  value: tokenAmountSchema,
  timestamp: instantSchema.optional(),
})

const transactionSchema = z.strictObject({
  hash: hashSchema,
  blockNumber: quantitySchema,
  from: addressSchema,
  /** `null` for a contract-creation transaction. */
  to: addressSchema.nullable(),
  value: tokenAmountSchema,
  nonce: quantitySchema.optional(),
  timestamp: instantSchema.optional(),
})

const tokenBalanceSchema = z.strictObject({
  contract: addressSchema,
  symbol: z.string().min(1).optional(),
  decimals: z.number().int().min(0).max(255).optional(),
  balance: tokenAmountSchema,
})

const nftSchema = z.strictObject({
  contract: addressSchema,
  /** uint256 token id as a decimal string. */
  tokenId: uintSchema,
  tokenType: z.enum(["ERC721", "ERC1155"]).optional(),
  /** ERC-1155 quantity; absent for ERC-721. */
  balance: uintSchema.optional(),
  name: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  collection: z.string().min(1).optional(),
})

/**
 * The canonical method table. Adding a method here is what makes it part of the
 * public namespace; provider packages then supply a `MethodTranslation` for it.
 */
export const canonicalSchemas = {
  kiseki_getTokenTransfers: {
    params: singleObjectParams(
      z.strictObject({
        address: addressSchema,
        /** Restrict to one token contract. */
        contract: addressSchema.optional(),
        fromBlock: blockRefSchema.optional(),
        toBlock: blockRefSchema.optional(),
        pageSize: pageSizeSchema.optional(),
        nextPage: nextPageSchema.optional(),
      }),
    ),
    result: z.strictObject({
      chain: chainSchema,
      transfers: z.array(tokenTransferSchema),
      nextPage: nextPageSchema,
    }),
  },

  kiseki_getTransactionsByAddress: {
    params: singleObjectParams(
      z.strictObject({
        address: addressSchema,
        fromBlock: blockRefSchema.optional(),
        toBlock: blockRefSchema.optional(),
        pageSize: pageSizeSchema.optional(),
        nextPage: nextPageSchema.optional(),
      }),
    ),
    result: z.strictObject({
      chain: chainSchema,
      transactions: z.array(transactionSchema),
      nextPage: nextPageSchema,
    }),
  },

  kiseki_getAccountBalance: {
    params: singleObjectParams(z.strictObject({ address: addressSchema })),
    result: z.strictObject({
      chain: chainSchema,
      address: addressSchema,
      /** Native coin balance. */
      balance: tokenAmountSchema,
      tokens: z.array(tokenBalanceSchema),
    }),
  },

  kiseki_getNFTsByOwner: {
    params: singleObjectParams(
      z.strictObject({
        owner: addressSchema,
        contract: addressSchema.optional(),
        pageSize: pageSizeSchema.optional(),
        nextPage: nextPageSchema.optional(),
      }),
    ),
    result: z.strictObject({
      chain: chainSchema,
      nfts: z.array(nftSchema),
      nextPage: nextPageSchema,
    }),
  },

  kiseki_getNFTMetadata: {
    params: singleObjectParams(
      z.strictObject({
        contract: addressSchema,
        tokenId: uintSchema,
      }),
    ),
    result: z.strictObject({
      chain: chainSchema,
      contract: addressSchema,
      tokenId: uintSchema,
      name: z.string().min(1).optional(),
      image: z.string().min(1).optional(),
      collection: z.string().min(1).optional(),
    }),
  },

  kiseki_getTokenPrice: {
    params: singleObjectParams(z.strictObject({ contract: addressSchema })),
    result: z.strictObject({
      chain: chainSchema,
      contract: addressSchema,
      /** USD price as a decimal string (never a float). */
      priceUsd: z.string().regex(DECIMAL_AMOUNT, "expected a decimal string"),
      updatedAt: instantSchema,
    }),
  },
} as const

export type CanonicalMethod = keyof typeof canonicalSchemas

/** Every canonical method name, in declaration order. */
export const CANONICAL_METHODS = Object.keys(canonicalSchemas) as CanonicalMethod[]

export type CanonicalParamsOf<M extends CanonicalMethod> =
  z.infer<(typeof canonicalSchemas)[M]["params"]>[0]
export type CanonicalResultOf<M extends CanonicalMethod> = z.infer<
  (typeof canonicalSchemas)[M]["result"]
>

/** Is `method` a canonical `kiseki_*` method this contract defines? */
export const isCanonicalMethod = (method: string): method is CanonicalMethod =>
  Object.hasOwn(canonicalSchemas, method)

/**
 * Validate a canonical params ARRAY (the JSON-RPC `params`). Returns `undefined`
 * when the params are invalid — exactly what `mapRequest` must return then.
 */
export const parseCanonicalParams = <M extends CanonicalMethod>(
  method: M,
  params: readonly unknown[],
): CanonicalParamsOf<M> | undefined => {
  const parsed = canonicalSchemas[method].params.safeParse(params)
  if (!parsed.success) return undefined
  return parsed.data[0] as CanonicalParamsOf<M>
}

/** Validate a canonical result. Returns `undefined` when the shape is wrong. */
export const parseCanonicalResult = <M extends CanonicalMethod>(
  method: M,
  result: unknown,
): CanonicalResultOf<M> | undefined => {
  const parsed = canonicalSchemas[method].result.safeParse(result)
  return parsed.success ? (parsed.data as CanonicalResultOf<M>) : undefined
}

/* -------------------------------------------------------------------------- */
/* Proxy-authored errors                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Canonical params could not be mapped (client error). `detail` may name the
 * offending FIELD — never a value, and never a token.
 */
export const invalidCanonicalParams = (method: string, detail?: string): JsonRpcError => ({
  code: ERROR_INVALID_PARAMS,
  message: "invalid params",
  data: detail === undefined ? { method } : { method, detail },
})

/**
 * The package mapped a real answer into something that is not the canonical
 * shape (or threw). That is a package bug, not the client's fault, but it is
 * final: retrying another upstream cannot fix a mapping function.
 */
export const canonicalMappingFailed = (method: string): JsonRpcError => ({
  code: ERROR_INTERNAL,
  message: "canonical response mapping failed",
  data: { method },
})

/**
 * A translation declared a transport this engine cannot send (`"http"`).
 *
 * `capability()` already refuses to advertise such a method, so the router never
 * routes it here; this is the belt-and-braces answer that keeps a mis-built
 * adapter from posting a JSON-RPC envelope to a REST endpoint.
 */
export const canonicalTransportUnsupported = (method: string): JsonRpcError => ({
  code: ERROR_INTERNAL,
  message: "canonical transport not implemented",
  data: { method },
})

/* -------------------------------------------------------------------------- */
/* Capability coverage                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Which canonical names a provider instance covers, derived from its config
 * method patterns and its translation table (never hardcoded globally).
 *
 * A canonical method is covered only when the upstream method it translates to
 * is itself covered by the configured patterns — that is what makes coverage
 * per (provider × plan): a lower plan simply lists fewer translations, or the
 * operator narrows `methods:`.
 *
 * Only JSON-RPC translations count: a "http" transport is a declared but
 * unimplemented contract, so advertising it would promise something the engine
 * cannot send.
 */
export const coveredCanonicalMethods = (
  methods: readonly string[],
  translations: readonly MethodTranslation[],
): string[] => {
  const covered: string[] = []
  for (const translation of translations) {
    if ((translation.transport ?? "jsonrpc") !== "jsonrpc") continue
    if (!methods.some((pattern) => matchesMethodPattern(pattern, translation.upstream))) continue
    if (methods.some((pattern) => matchesMethodPattern(pattern, translation.canonical))) continue
    if (covered.includes(translation.canonical)) continue
    covered.push(translation.canonical)
  }
  return covered
}

/**
 * `upstream-ankr` — the thin provider package for Ankr (design.md §7.3).
 *
 * Three things are genuinely Ankr-specific and live here, nowhere else:
 *
 *  1. **API Credits cost table** — the whole Advanced API bills a flat 700
 *     credits per request (plan §4).
 *  2. **Error signatures** — the Ankr-specific capability gates that the generic
 *     table misses, recorded from real responses (plan/notes-m0.md §3).
 *  3. **Canonical namespace** — the `kiseki_*` → `ankr_*` translation table and
 *     the kiseki-chain → Ankr-`blockchain`-alias map (§3, §5).
 *
 * The URL template stays in config (`url_template`): which endpoint serves which
 * network is a deployment fact, not a package fact.
 *
 * ⚠️ **Deployment note — one instance cannot serve both APIs.** Verified against
 * the live service (plan/notes-m0.md §1): the Advanced API is served ONLY on
 * `https://rpc.ankr.com/multichain/{apikey}`, and that endpoint rejects every
 * node method (`eth_blockNumber` → `-32601`). The per-chain endpoint
 * (`https://rpc.ankr.com/eth/{apikey}`) rejects every `ankr_*` method. An
 * instance whose `methods:` list mixes `eth_*` with `ankr_*` is therefore a
 * config error: the unmatched half will regroup forever and return `-32601`.
 * Declare two instances per chain instead — see kiseki.yaml.
 *
 * ⚠️ **Deployment note — 700 credits is a big multiplier.** A batch of two
 * Advanced API calls costs 1400 credits. With a bucket sized for RPS (e.g.
 * capacity 15), one AAPI request drains ~47 `eth_call`-equivalents, so the bucket
 * refills almost instantly and requests start failing on the provider side. Give
 * AAPI instances their own bucket dimension sized in credits, or keep
 * `capacity`/`refill_per_second` generous relative to the call rate.
 *
 * Sources, read 2026-11-21/22:
 *  - cost table: https://www.ankr.com/docs/advanced-api/pricing
 *  - methods/params/results: https://www.ankr.com/docs/advanced-api/{token,query,nft}-methods
 *  - error signatures + response shapes: live probes, plan/notes-m0.md
 */

import {
  createPoolAdapter,
  isMethodNotFound,
  parseCanonicalParams,
  type AdapterFactory,
  type CapabilityErrorMatcher,
  type CostTable,
  type MethodTranslation,
} from "upstream-core"
import { z } from "zod"

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ankr Advanced API — 700 API Credits per request, uniformly across all 17
 * methods (PAYG table, 0.10 USD = 1M credits). Read 2026-11-21.
 *
 * The pattern is `ankr_get*`, not `ankr_*`, on purpose: a non-`get` Ankr method
 * should fall through to the global/default layer instead of being pinned at
 * 700. Node methods (`eth_*`) are not priced by Ankr at all, so they are absent
 * here and resolve to the global layer / implicit 1 (design.md §5.3).
 *
 * The engine prices a canonical item by its UPSTREAM name (pool.ts `itemCost`),
 * so `kiseki_getTokenTransfers` is charged 700 through `ankr_getTokenTransfers`
 * with no extra entry needed.
 */
export const ANKR_COSTS: CostTable = {
  "ankr_get*": 700,
}

/* -------------------------------------------------------------------------- */
/* Capability signatures                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ankr codes and messages that PROVE the instance cannot serve the method
 * (recorded from live responses, plan/notes-m0.md §3):
 *
 *  - `-32601` — `"the method X does not exist/is not available"` (multichain) or
 *    `"Method not found"` (per-chain). Already covered by the generic table;
 *    handled here to make the Ankr contract explicit.
 *  - `-32075` — `"Method disabled, reason: restricted by blockchain schema"`.
 *    Ankr-specific: the method exists but is disabled for this deployment/plan.
 *    This is the only real plan/entitlement gate observed.
 *
 * Everything else MUST stay `null` so the generic table (or the final
 * passthrough, decision #36) handles it. In particular:
 *
 *  - `-32602` invalid params (`invalid blockchain name`, wrong `filter` type) is
 *    a CLIENT error. Matching it as `method` would regroup the item and burn
 *    another 700 credits for a request that can never succeed.
 *  - `-32603` "internal error" with a trace id is not a capability statement.
 *  - `-32090` rate limit arrives with HTTP 429 and is already classified by the
 *    engine before any matcher runs.
 *  - `execution reverted`, `nonce too low`, … are domain answers.
 *
 * The guide's illustrative `/method not allowed for your (plan|tier)|upgrade your
 * plan/` is deliberately NOT used: no such message was observed, and an
 * unverified pattern here would be actively harmful.
 */
const METHOD_DISABLED_CODE = -32075

export const matchAnkrCapability: CapabilityErrorMatcher = (error) => {
  if (isMethodNotFound(error)) return "method"
  if (error.code === METHOD_DISABLED_CODE) return "method"
  // No Ankr-specific archive signature beyond the generic ones; null means "not
  // mine", and composeMatchers then runs the generic table.
  return null
}

/* -------------------------------------------------------------------------- */
/* Chain aliases                                                               */
/* -------------------------------------------------------------------------- */

/**
 * kiseki chain name → Ankr `blockchain` value (plan §2, verified against the
 * docs and the live endpoint).
 *
 * Note `ethereum → "eth"`: Ankr's `eth` means Ethereum mainnet, and a canonical
 * payload never carries a provider alias (namespace.ts rejects `eth` as a chain
 * name), so this is the single place the two vocabularies meet.
 *
 * A chain with no entry makes `mapRequest` return `undefined` — invalid params,
 * never a guess.
 */
export const ANKR_CHAIN_ALIASES: Readonly<Record<string, string>> = {
  // Mainnets
  ethereum: "eth",
  arbitrum: "arbitrum",
  "arbitrum-one": "arbitrum",
  avalanche: "avalanche",
  base: "base",
  bsc: "bsc",
  "bnb-smart-chain": "bsc",
  fantom: "fantom",
  flare: "flare",
  gnosis: "gnosis",
  linea: "linea",
  optimism: "optimism",
  polygon: "polygon",
  scroll: "scroll",
  "somnia-mainnet": "somnia_mainnet",
  taiko: "taiko",
  telos: "telos",
  xlayer: "xlayer",
  // Testnets
  "avalanche-fuji": "avalanche_fuji",
  "base-sepolia": "base_sepolia",
  sepolia: "eth_sepolia",
  "optimism-sepolia": "optimism_sepolia",
  "polygon-amoy": "polygon_amoy",
}

/* -------------------------------------------------------------------------- */
/* Upstream payload validation                                                 */
/* -------------------------------------------------------------------------- */

/*
 * Response schemas for the Ankr payloads this package maps. They are deliberately
 * permissive about fields the canonical shape drops (Ankr adds `thumbnail`,
 * `syncStatus`, `direction`, …) and strict about the ones it keeps, so a shape
 * change surfaces as a mapping failure instead of a silently wrong number.
 *
 * `valueRawInteger` is a DECIMAL string (not hex) — see `amountFromUpstream`.
 */

/**
 * Ankr lower-cases addresses. Validated here (rather than trusted) so a payload
 * change becomes a mapping failure instead of an address the canonical schema
 * silently rejects later.
 */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte address")
const decimalString = z.string().regex(/^(?:0|[1-9][0-9]*)$/)
const hexQuantity = z.string().regex(/^0x[0-9a-fA-F]+$/)

/**
 * Build a canonical token amount from Ankr's `valueRawInteger` + `tokenDecimals`.
 *
 * Two normalisations, both verified against live data (plan/notes-m0.md §5):
 *
 *  1. `valueRawInteger` is decimal, while the canonical `valueRaw` is hex.
 *  2. Ankr's own `value`/`balance` field is NOT always consistent with
 *     `valueRawInteger` (a live ERC-20 transfer reported `value` 10× smaller
 *     than its raw integer). The canonical value is therefore derived from the
 *     raw integer and decimals, which is self-consistent by construction.
 */
const amountFromUpstream = (rawDecimal: string, decimals: number) => {
  const raw = BigInt(rawDecimal)
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const fraction = raw % divisor
  const value =
    fraction === 0n
      ? whole.toString()
      : `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`
  return { value, valueRaw: `0x${raw.toString(16)}` }
}

/** Unix seconds → ISO-8601 instant with a zone (canonical `timestamp`). */
const instantFromUnixSeconds = (seconds: number): string =>
  new Date(seconds * 1000).toISOString()

const transferSchema = z.object({
  fromAddress: address,
  toAddress: address,
  contractAddress: address.optional(),
  valueRawInteger: decimalString,
  tokenDecimals: z.number().int().min(0).max(255),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockHeight: z.number().int().min(0),
  logIndex: z.number().int().min(0).optional(),
  timestamp: z.number().int().min(0).optional(),
})

const transfersResultSchema = z.object({
  transfers: z.array(transferSchema),
  nextPageToken: z.string().optional(),
})

const transactionSchema = z.object({
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: hexQuantity,
  from: address,
  to: address.nullable().optional(),
  value: hexQuantity,
  nonce: hexQuantity.optional(),
  timestamp: hexQuantity.optional(),
})

const transactionsResultSchema = z.object({
  transactions: z.array(transactionSchema),
  nextPageToken: z.string().optional(),
})

const assetSchema = z.object({
  contractAddress: address,
  tokenSymbol: z.string().optional(),
  tokenDecimals: z.number().int().min(0).max(255),
  tokenType: z.string(),
  balanceRawInteger: decimalString,
})

const balanceResultSchema = z.object({
  assets: z.array(assetSchema),
})

/** The zero address Ankr uses for a chain's native coin. */
const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000"

const nftAssetSchema = z.object({
  contractAddress: address,
  tokenId: decimalString,
  contractType: z.string().optional(),
  name: z.string().optional(),
  imageUrl: z.string().optional(),
  collectionName: z.string().optional(),
})

const nftsResultSchema = z.object({
  assets: z.array(nftAssetSchema),
  nextPageToken: z.string().optional(),
})

const nftMetadataResultSchema = z.object({
  metadata: z.object({
    blockchain: z.string(),
    contractAddress: address,
    tokenId: decimalString,
    contractType: z.string().optional(),
    collectionName: z.string().optional(),
  }),
  attributes: z
    .object({
      name: z.string().optional(),
      imageUrl: z.string().optional(),
    })
    .optional(),
})

const tokenPriceResultSchema = z.object({
  usdPrice: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, "expected a decimal price"),
  blockchain: z.string(),
  contractAddress: address.optional(),
  syncStatus: z.object({ timestamp: z.number().int().min(0) }).optional(),
})

/** Ankr pads an empty `name`/`imageUrl` with `""`; the canonical schema rejects it. */
const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value

/* -------------------------------------------------------------------------- */
/* Canonical namespace                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the Ankr `blockchain` for a kiseki chain, or `undefined` when the chain
 * is not served. Every `mapRequest` starts here: an unknown chain is invalid
 * params, never a guess (plan §5.3).
 */
const blockchainFor = (chain: string): string | undefined => ANKR_CHAIN_ALIASES[chain]

/**
 * `ankr_getNFTsByOwner` caps `pageSize` at 50 (docs nft-methods: "default=10,
 * max=50"), which is BELOW the canonical maximum of 1000. Verified live
 * 2026-11-22: `pageSize: 50` succeeds, `51` is rejected with
 * `-32602 "pageSize 51 can't be greater than 50"`.
 *
 * The other four paged methods have no such ceiling under the canonical max —
 * `ankr_getTokenTransfers` and `ankr_getTransactionsByAddress` were probed with
 * `pageSize: 1001` and accepted it — so only this method needs the guard.
 */
const ANKR_NFT_MAX_PAGE_SIZE = 50

/**
 * Translate a canonical block reference (`latest`, `0x…`, `safe`, …) into what
 * Ankr accepts for `fromBlock`/`toBlock`: hex, decimal, `"earliest"`, `"latest"`.
 *
 * `pending`/`safe`/`finalized` have no Ankr equivalent. Dropping them would
 * silently widen the query, so they are rejected (invalid params) instead.
 */
const blockBound = (value: string | undefined): string | undefined | null => {
  if (value === undefined) return undefined
  if (value === "latest" || value === "earliest") return value
  if (/^0x[0-9a-fA-F]+$/.test(value)) return value
  return null // pending | safe | finalized → not representable upstream
}

/**
 * Ankr Advanced API takes `params` as a single OBJECT with named fields
 * (`{ blockchain, address, … }`), not the positional array of the node API —
 * verified against the docs (advanced-api/{token,query,nft}-methods) and the
 * live endpoint. `mapRequest` therefore returns the object itself; the pool
 * sends it as the JSON-RPC `params` verbatim (namespace.ts: the upstream side
 * is free-form, the canonical side stays the client's array).
 *
 * Note the endpoint ALSO tolerates an array today (the Go server unmarshals the
 * first element). That is server behaviour, not the documented contract — do
 * not rely on it.
 */
export const ANKR_TRANSLATIONS: readonly MethodTranslation[] = [
  {
    canonical: "kiseki_getTokenTransfers",
    upstream: "ankr_getTokenTransfers",
    mapRequest: (params, chain) => {
      const parsed = parseCanonicalParams("kiseki_getTokenTransfers", params)
      if (parsed === undefined) return undefined
      const blockchain = blockchainFor(chain)
      if (blockchain === undefined) return undefined

      const fromBlock = blockBound(parsed.fromBlock)
      const toBlock = blockBound(parsed.toBlock)
      if (fromBlock === null || toBlock === null) return undefined

      return {
        blockchain,
        // Ankr accepts a string or an array; a single address is the common case.
        address: parsed.address,
        ...(parsed.contract === undefined ? {} : { contractAddress: parsed.contract }),
        ...(fromBlock === undefined ? {} : { fromBlock }),
        ...(toBlock === undefined ? {} : { toBlock }),
        // Ankr's ceiling (10000) is above the canonical max (1000): no guard.
        ...(parsed.pageSize === undefined ? {} : { pageSize: parsed.pageSize }),
        // The canonical cursor is opaque and IS Ankr's pageToken verbatim.
        ...(parsed.nextPage === undefined || parsed.nextPage === null
          ? {}
          : { pageToken: parsed.nextPage }),
      }
    },
    mapResponse: (result, _params, chain) => {
      const parsed = transfersResultSchema.parse(result)

      return {
        chain,
        transfers: parsed.transfers.map((transfer) => ({
          transactionHash: transfer.transactionHash,
          blockNumber: `0x${transfer.blockHeight.toString(16)}`,
          ...(transfer.logIndex === undefined ? {} : { logIndex: transfer.logIndex }),
          from: transfer.fromAddress,
          to: transfer.toAddress,
          ...(transfer.contractAddress === undefined
            ? {}
            : { contract: transfer.contractAddress }),
          value: amountFromUpstream(transfer.valueRawInteger, transfer.tokenDecimals),
          ...(transfer.timestamp === undefined
            ? {}
            : { timestamp: instantFromUnixSeconds(transfer.timestamp) }),
        })),
        nextPage: parsed.nextPageToken ?? null,
      }
    },
  },

  {
    canonical: "kiseki_getTransactionsByAddress",
    upstream: "ankr_getTransactionsByAddress",
    mapRequest: (params, chain) => {
      const parsed = parseCanonicalParams("kiseki_getTransactionsByAddress", params)
      if (parsed === undefined) return undefined
      const blockchain = blockchainFor(chain)
      if (blockchain === undefined) return undefined

      const fromBlock = blockBound(parsed.fromBlock)
      const toBlock = blockBound(parsed.toBlock)
      if (fromBlock === null || toBlock === null) return undefined

      return {
        blockchain,
        address: parsed.address,
        // Canonical results are newest-first, so the upstream order is pinned.
        descOrder: true,
        ...(fromBlock === undefined ? {} : { fromBlock }),
        ...(toBlock === undefined ? {} : { toBlock }),
        // Ankr's ceiling is above the canonical max (1000): no guard needed.
        ...(parsed.pageSize === undefined ? {} : { pageSize: parsed.pageSize }),
        ...(parsed.nextPage === undefined || parsed.nextPage === null
          ? {}
          : { pageToken: parsed.nextPage }),
      }
    },
    mapResponse: (result, _params, chain) => {
      const parsed = transactionsResultSchema.parse(result)

      return {
        chain,
        transactions: parsed.transactions.map((transaction) => ({
          hash: transaction.hash,
          blockNumber: transaction.blockNumber,
          from: transaction.from,
          to: transaction.to ?? null,
          value: amountFromUpstream(BigInt(transaction.value).toString(), 0),
          ...(transaction.nonce === undefined ? {} : { nonce: transaction.nonce }),
          ...(transaction.timestamp === undefined
            ? {}
            : {
                timestamp: instantFromUnixSeconds(Number.parseInt(transaction.timestamp, 16)),
              }),
        })),
        nextPage: parsed.nextPageToken ?? null,
      }
    },
  },

  {
    canonical: "kiseki_getAccountBalance",
    upstream: "ankr_getAccountBalance",
    mapRequest: (params, chain) => {
      const parsed = parseCanonicalParams("kiseki_getAccountBalance", params)
      if (parsed === undefined) return undefined
      const blockchain = blockchainFor(chain)
      if (blockchain === undefined) return undefined

      return {
        // Ankr supports a multichain array; kiseki routes per chain, so one value.
        blockchain,
        walletAddress: parsed.address,
      }
    },
    mapResponse: (result, params, chain) => {
      const parsed = balanceResultSchema.parse(result)
      const canonicalParams = parseCanonicalParams("kiseki_getAccountBalance", params)
      if (canonicalParams === undefined) throw new Error("missing canonical params")

      const native = parsed.assets.find(
        (asset) => asset.tokenType === "NATIVE" || asset.contractAddress === NATIVE_PLACEHOLDER,
      )
      const tokens = parsed.assets
        .filter((asset) => asset !== native)
        .map((asset) => ({
          contract: asset.contractAddress,
          ...(nonEmpty(asset.tokenSymbol) === undefined
            ? {}
            : { symbol: asset.tokenSymbol }),
          decimals: asset.tokenDecimals,
          balance: amountFromUpstream(asset.balanceRawInteger, asset.tokenDecimals),
        }))

      return {
        chain,
        address: canonicalParams.address,
        // A chain where Ankr reports no native row is a zero balance, not an error.
        balance:
          native === undefined
            ? { value: "0", valueRaw: "0x0" }
            : amountFromUpstream(native.balanceRawInteger, native.tokenDecimals),
        tokens,
      }
    },
  },

  {
    canonical: "kiseki_getNFTsByOwner",
    upstream: "ankr_getNFTsByOwner",
    mapRequest: (params, chain) => {
      const parsed = parseCanonicalParams("kiseki_getNFTsByOwner", params)
      if (parsed === undefined) return undefined
      const blockchain = blockchainFor(chain)
      if (blockchain === undefined) return undefined

      // Reject rather than clamp: silently trimming the request would
      // misrepresent what the client asked for, and the doomed upstream call
      // would still burn 700 credits (invalid params is final, with no fetch).
      if (parsed.pageSize !== undefined && parsed.pageSize > ANKR_NFT_MAX_PAGE_SIZE) {
        return undefined
      }

      return {
        blockchain,
        walletAddress: parsed.owner,
        // `filter` must be an ARRAY of { contract: tokenIds } maps — a bare
        // object is rejected with -32602 (verified live, plan/notes-m0.md §4).
        ...(parsed.contract === undefined ? {} : { filter: [{ [parsed.contract]: [] }] }),
        ...(parsed.pageSize === undefined ? {} : { pageSize: parsed.pageSize }),
        ...(parsed.nextPage === undefined || parsed.nextPage === null
          ? {}
          : { pageToken: parsed.nextPage }),
      }
    },
    mapResponse: (result, _params, chain) => {
      const parsed = nftsResultSchema.parse(result)

      return {
        chain,
        nfts: parsed.assets.map((asset) => ({
          contract: asset.contractAddress,
          tokenId: asset.tokenId,
          ...(asset.contractType === "ERC721" || asset.contractType === "ERC1155"
            ? { tokenType: asset.contractType }
            : {}),
          ...(nonEmpty(asset.name) === undefined ? {} : { name: asset.name }),
          ...(nonEmpty(asset.imageUrl) === undefined ? {} : { image: asset.imageUrl }),
          ...(nonEmpty(asset.collectionName) === undefined
            ? {}
            : { collection: asset.collectionName }),
        })),
        nextPage: parsed.nextPageToken ?? null,
      }
    },
  },

  {
    canonical: "kiseki_getNFTMetadata",
    upstream: "ankr_getNFTMetadata",
    mapRequest: (params, chain) => {
      const parsed = parseCanonicalParams("kiseki_getNFTMetadata", params)
      if (parsed === undefined) return undefined
      const blockchain = blockchainFor(chain)
      if (blockchain === undefined) return undefined

      return {
        blockchain,
        contractAddress: parsed.contract,
        tokenId: parsed.tokenId,
      }
    },
    mapResponse: (result, _params, chain) => {
      const parsed = nftMetadataResultSchema.parse(result)
      const { metadata, attributes } = parsed

      return {
        chain,
        contract: metadata.contractAddress,
        tokenId: metadata.tokenId,
        ...(nonEmpty(attributes?.name) === undefined ? {} : { name: attributes?.name }),
        ...(nonEmpty(attributes?.imageUrl) === undefined
          ? {}
          : { image: attributes?.imageUrl }),
        ...(nonEmpty(metadata.collectionName) === undefined
          ? {}
          : { collection: metadata.collectionName }),
      }
    },
  },

  {
    canonical: "kiseki_getTokenPrice",
    upstream: "ankr_getTokenPrice",
    mapRequest: (params, chain) => {
      const parsed = parseCanonicalParams("kiseki_getTokenPrice", params)
      if (parsed === undefined) return undefined
      const blockchain = blockchainFor(chain)
      if (blockchain === undefined) return undefined

      return { blockchain, contractAddress: parsed.contract }
    },
    mapResponse: (result, params, chain) => {
      const parsed = tokenPriceResultSchema.parse(result)
      const canonicalParams = parseCanonicalParams("kiseki_getTokenPrice", params)
      if (canonicalParams === undefined) throw new Error("missing canonical params")
      // `updatedAt` is required by the canonical schema; without a sync timestamp
      // the price has no provenance and must not be reported as if it had.
      const timestamp = parsed.syncStatus?.timestamp
      if (timestamp === undefined) throw new Error("missing syncStatus.timestamp")

      return {
        chain,
        contract: canonicalParams.contract,
        priceUsd: parsed.usdPrice,
        updatedAt: instantFromUnixSeconds(timestamp),
      }
    },
  },
]

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export const createAdapter: AdapterFactory = (cfg, deps) =>
  createPoolAdapter(cfg, deps, {
    costs: ANKR_COSTS,
    matchCapability: matchAnkrCapability,
    translations: ANKR_TRANSLATIONS,
  })

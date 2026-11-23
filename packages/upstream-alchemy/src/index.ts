/**
 * `upstream-alchemy` — the thin provider package for Alchemy.
 *
 * Everything genuinely provider-specific about Alchemy lives here and nowhere
 * else:
 *
 *   - the default Compute Unit table (so config does not have to repeat it),
 *   - Alchemy's error signatures that the generic fallback table misses.
 *
 * The URL template still comes from config (`url_template`), because a template
 * is per network (eth-mainnet, base-mainnet, …) and belongs in deployment config.
 *
 * Source for the CU numbers: Alchemy's published compute unit cost table
 * (https://www.alchemy.com/docs/reference/compute-unit-costs), read 2026-11-21.
 * They are defaults, not truth: an instance's config `costs:` always overrides
 * them (ARCHITECTURE.md, "5. Model kuota dan cost"), which is the documented
 * escape hatch when the table changes.
 *
 * Error-signature facts below are verbatim from live Alchemy responses, recorded
 * in `notes/research-notes/alchemy-provider.md` (§3, §5, §6). Never invent a
 * provider message: copy it from that note and write the pattern against it.
 */

import {
  createPoolAdapter,
  isMethodNotFound,
  type AdapterFactory,
  type CapabilityErrorMatcher,
  type CostTable,
} from "upstream-core"

/**
 * Alchemy bills per method × times called inside a batch ("batch | CU of method
 * # times called"), which is exactly the per-item deduction the pool already
 * does (design.md §5.5 rule 2). So `countsBatchAsOne` is deliberately not set.
 */
export const ALCHEMY_CU: CostTable = {
  // 0 CU
  eth_chainId: 0,
  eth_protocolVersion: 0,
  eth_syncing: 0,
  net_listening: 0,
  net_peerCount: 0,
  net_version: 0,
  // 10 CU
  eth_accounts: 10,
  eth_baseFee: 10,
  eth_blobBaseFee: 10,
  eth_blockNumber: 10,
  eth_createAccessList: 10,
  eth_feeHistory: 10,
  eth_maxPriorityFeePerGas: 10,
  eth_uninstallFilter: 10,
  eth_unsubscribe: 10,
  // 20 CU
  eth_callMany: 20,
  eth_estimateGas: 20,
  eth_fillTransaction: 20,
  eth_gasPrice: 20,
  eth_getBalance: 20,
  eth_getBlockByHash: 20,
  eth_getBlockByNumber: 20,
  eth_getBlockReceipts: 20,
  eth_getBlockTransactionCountByHash: 20,
  eth_getBlockTransactionCountByNumber: 20,
  eth_getCode: 20,
  eth_getFilterChanges: 20,
  eth_getProof: 20,
  eth_getRawTransactionByHash: 20,
  eth_getStorageAt: 20,
  eth_getTransactionByBlockHashAndIndex: 20,
  eth_getTransactionByBlockNumberAndIndex: 20,
  eth_getTransactionByHash: 20,
  eth_getTransactionCount: 20,
  eth_getTransactionReceipt: 20,
  eth_getUncleByBlockHashAndIndex: 20,
  eth_getUncleByBlockNumberAndIndex: 20,
  eth_getUncleCountByBlockHash: 20,
  eth_getUncleCountByBlockNumber: 20,
  eth_newBlockFilter: 20,
  eth_newFilter: 20,
  eth_newPendingTransactionFilter: 20,
  eth_submitWork: 20,
  web3_clientVersion: 20,
  web3_sha3: 20,
  // 26 CU
  eth_call: 26,
  // 40 CU
  eth_callBundle: 40,
  eth_sendRawTransaction: 40,
  eth_sendRawTransactionSync: 40,
  eth_simulateV1: 40,
  // 60 CU
  eth_getAccountInfo: 60,
  eth_getFilterLogs: 60,
  eth_getLogs: 60,
  // 500 CU
  txpool_content: 500,
  // Debug API — 40 CU billed (throughput CU is 1000, which we do not model:
  // the bucket models the billed limit, see design.md §5.2).
  debug_dbAncient: 40,
  debug_dbAncients: 40,
  debug_dbGet: 40,
  debug_executionWitness: 40,
  debug_getBadBlocks: 40,
  debug_getRawBlock: 40,
  debug_getRawHeader: 40,
  debug_getRawReceipts: 40,
  debug_storageRangeAt: 40,
  debug_traceBlockByHash: 40,
  debug_traceBlockByNumber: 40,
  debug_traceCall: 40,
  debug_traceCallMany: 40,
  debug_traceTransaction: 40,
  // Trace API
  trace_block: 20,
  trace_get: 20,
  trace_call: 40,
  trace_filter: 40,
  trace_rawTransaction: 40,
  trace_transaction: 40,
  trace_callMany: 80,
  trace_replayBlockTransactions: 80,
  trace_replayTransaction: 80,
  // Alchemy-specific namespaces
  alchemy_getTokenBalances: 20,
  alchemy_getTokenMetadata: 10,
  alchemy_getAssetTransfers: 120,
}

/**
 * Alchemy error signatures on top of the generic table (ARCHITECTURE.md,
 * "6.2 Sinyal mismatch kapabilitas").
 *
 * Facts from `notes/research-notes/alchemy-provider.md` (§3, §5, §6):
 *
 *  - Alchemy rejects methods it cannot serve with code `-32600` — NOT `-32601`,
 *    so `isMethodNotFound` alone never catches them. `-32600` does not prove the
 *    method is unavailable: Alchemy uses it for several different failures, so
 *    the matcher has to read the message content and cannot decide on the code
 *    alone. A wrong apikey is one of those cases — it answers HTTP 401 with
 *    `-32600` and "Must be authenticated!", but a 401 is classified as
 *    `unauthorized` in upstream-core before any matcher runs, so that message
 *    never reaches this function.
 *  - A rejection that proves the method does not exist on this instance
 *    ("Unsupported method: …", "… is not available on the <NETWORK>", the
 *    Free-tier "… is not available on the Free tier …") is a `method` mismatch
 *    → runtime note + regroup, so the instance is not retried forever.
 *  - The `eth_getLogs` 10-block-range message also says "Free tier" and "PAYG",
 *    but it is a request-shape limit, not a method refusal: a runtime note is
 *    per method per instance, so matching it as `method` would wrongly route
 *    every future eth_getLogs — including small ranges — away from Alchemy.
 *    It must yield null (final passthrough / generic fallback decides).
 *  - Domain answers (nonce too low, execution reverted, insufficient funds, …)
 *    are never mismatches: null → untouched passthrough (ARCHITECTURE.md,
 *    "6. Penanganan error").
 */

/**
 * Free-tier method refusal, e.g. trace_* and debug_* on a Free tier account
 * ("trace_block is not available on the Free tier - upgrade to Pay As You Go,
 * or Enterprise for access."). Anchored on the message content, not the code.
 */
const FREE_TIER_METHOD_PATTERN = / is not available on the free tier/

/**
 * Method refusal naming the network, e.g. "Unsupported method: eth_coinbase on
 * ETH_MAINNET" and "net_peerCount is not available on the ETH_MAINNET..." (the
 * note records that message truncated, so the match is not end-anchored).
 * Requiring the underscore-shaped network token keeps it conservative; a bare
 * "not available" without it stays null.
 */
const UNSUPPORTED_METHOD_PATTERN =
  /(?:unsupported method: .+|is not available) on (?:the )?[a-z]+_[a-z]+/

export const matchAlchemyCapability: CapabilityErrorMatcher = (error) => {
  if (isMethodNotFound(error)) return "method"
  const message = error.message.toLowerCase()
  // Match on message content: -32600 alone proves nothing about the method, so
  // the code by itself is not enough (see the block comment above).
  if (error.code === -32600) {
    if (FREE_TIER_METHOD_PATTERN.test(message)) return "method"
    if (UNSUPPORTED_METHOD_PATTERN.test(message)) return "method"
    // Not a method refusal → not mine.
    return null
  }
  // No Alchemy-specific archive signature beyond the generic ones; returning null
  // means "not mine", and composeMatchers then runs the generic table.
  return null
}

export const createAdapter: AdapterFactory = (cfg, deps) =>
  createPoolAdapter(cfg, deps, {
    costs: ALCHEMY_CU,
    matchCapability: matchAlchemyCapability,
  })

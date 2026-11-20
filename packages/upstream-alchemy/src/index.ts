/**
 * `upstream-alchemy` — the thin provider package for Alchemy (design.md §7.3).
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
 * them (design.md §5.3), which is the documented escape hatch when the table
 * changes (design.md §23 risk #8).
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
 * Alchemy error signatures on top of the generic table (design.md §8.3).
 *
 *  - A method gated by plan arrives as `-32601` or as a "paid plan" message; both
 *    prove the instance cannot serve it, so both are `method` mismatches.
 *  - Alchemy's "state at block #N is pruned" / "lowest height is" wording is
 *    already covered by the generic archive patterns.
 *  - Everything else (nonce too low, execution reverted, …) is a domain answer
 *    and must be forwarded untouched (#36), so we return null and let the
 *    fallback table have the final say.
 */
const PLAN_GATED_PATTERN = /(?:not available on (?:the )?free plan|paid plan|upgrade to (?:a )?paid)/

export const matchAlchemyCapability: CapabilityErrorMatcher = (error) => {
  if (isMethodNotFound(error)) return "method"
  if (PLAN_GATED_PATTERN.test(error.message.toLowerCase())) return "method"
  // No Alchemy-specific archive signature beyond the generic ones; returning null
  // means "not mine", and composeMatchers then runs the generic table.
  return null
}

export const createAdapter: AdapterFactory = (cfg, deps) =>
  createPoolAdapter(cfg, deps, {
    costs: ALCHEMY_CU,
    matchCapability: matchAlchemyCapability,
  })

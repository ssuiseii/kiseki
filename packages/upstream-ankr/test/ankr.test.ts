import { describe, expect, test } from "bun:test"
import {
  BucketRegistry,
  composeMatchers,
  silentLogger,
  type Group,
  type GroupItem,
  type UpstreamInstanceConfig,
} from "upstream-core"
import {
  ANKR_CHAIN_ALIASES,
  ANKR_COSTS,
  ANKR_TRANSLATIONS,
  createAdapter,
  matchAnkrCapability,
} from "../src/index"

/**
 * Harness: the real pool, a fake fetch, a frozen clock — no network.
 * The same shape as `upstream-alchemy/test/alchemy.test.ts` (guide §8).
 */

const cfg: UpstreamInstanceConfig = {
  name: "ankr-ethereum-aapi",
  provider: "ankr",
  package: "ankr",
  url_template: "https://rpc.ankr.com/multichain/{apikey}",
  apikeys: [{ token: "KEY_A", label: "a", buckets: [{ capacity: 10_000, refill_per_second: 10 }] }],
  methods: ["ankr_*"],
  archive: false,
}

/** A second instance that serves the node API — the other half of the split. */
const nodeCfg: UpstreamInstanceConfig = {
  ...cfg,
  name: "ankr-ethereum-node",
  package: "generic",
  url_template: "https://rpc.ankr.com/eth/{apikey}",
  methods: ["eth_*"],
}

const item = (method: string, params: unknown[] = [], originalIndex = 0): GroupItem => ({
  originalIndex,
  id: originalIndex,
  method,
  params,
  historical: false,
})

const group = (method: string, params: unknown[] = []): Group => ({
  chain: "ethereum",
  items: [item(method, params)],
  needsArchive: false,
  idempotency: "READ",
  timeoutMs: 1_000,
})

const batch = (items: GroupItem[], chain = "ethereum"): Group => ({
  chain,
  items,
  needsArchive: false,
  idempotency: "READ",
  timeoutMs: 1_000,
})

const ctx = { attempt: 0, logger: silentLogger, now: () => 0 }

const json = (value: unknown): Response => new Response(JSON.stringify(value))

/** Echo the request id back, so batch matching is exercised for real. */
const reply = (body: unknown, result: unknown): Response => {
  if (Array.isArray(body)) {
    return json(body.map((request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, result })))
  }
  return json({ jsonrpc: "2.0", id: (body as { id: unknown }).id, result })
}

const replyError = (body: unknown, error: { code: number; message: string }): Response => {
  if (Array.isArray(body)) {
    return json(body.map((request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, error })))
  }
  return json({ jsonrpc: "2.0", id: (body as { id: unknown }).id, error })
}

type HarnessOptions = {
  costs?: Record<string, number>
  globalCosts?: Record<string, number>
  config?: UpstreamInstanceConfig
  response?: (url: string, body: unknown) => Response
  random?: () => number
}

const harness = (options: HarnessOptions = {}) => {
  const registry = new BucketRegistry(() => 0)
  const calls: { url: string; body: unknown }[] = []
  const base = options.config ?? cfg
  const config: UpstreamInstanceConfig =
    options.costs === undefined ? base : { ...base, costs: options.costs }
  const adapter = createAdapter(config, {
    bucketRegistry: registry,
    logger: silentLogger,
    now: () => 0,
    ...(options.globalCosts === undefined ? {} : { globalCosts: options.globalCosts }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const body: unknown = JSON.parse(String(init?.body ?? "null"))
      calls.push({ url, body })
      return options.response === undefined
        ? reply(body, { transfers: [], nextPageToken: undefined })
        : options.response(url, body)
    }) as unknown as typeof fetch,
  })
  const credits = () => registry.peek("ankr", "KEY_A")!.credits(0)
  return { adapter, registry, calls, credits }
}

/* -------------------------------------------------------------------------- */
/* Fixtures — trimmed from live responses (plan/notes-m0.md §4)                */
/* -------------------------------------------------------------------------- */

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"
const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D"

const transferFixture = {
  fromAddress: VITALIK,
  toAddress: "0xF51BC4633F5924465c8c6317169Faf3E4312E82F",
  contractAddress: "0xd654bDD32FC99471455e86C2E7f7D7b6437e9179",
  // Live value: 340e18 raw, but Ankr's `value` field said 34e18 — deliberately
  // included so the test pins "derive from raw", not "copy `value`".
  value: "34000000000000000000",
  valueRawInteger: "340000000000000000000",
  blockchain: "eth",
  tokenName: "USDT",
  tokenSymbol: "USDT",
  tokenDecimals: 18,
  thumbnail: "",
  transactionHash: "0x932cdcd0c76e08cf8730af625a5bb5932b8412b09f9806285271fd9ff2ce28f7",
  blockHeight: 21_000_000,
  logIndex: 3,
  timestamp: 1_700_000_000,
  direction: "out",
}

const transfersResult = {
  nextPageToken: "eyJldGgiOnsidG9rZW4iOiJ4In19",
  transfers: [transferFixture],
  syncStatus: { timestamp: 1_795_279_019, lag: "-7s", status: "synced" },
}

const txFixture = {
  hash: "0x4a3012bda052db9840a2f7bb2465f17ba817ea597be976ccda254d9169575e58",
  blockNumber: "0x193c80a",
  from: "0xdaf6cf89a02ee0d13549a6f9ab6be306d30c46bb",
  to: VITALIK,
  value: "0x0",
  nonce: "0x48",
  timestamp: "0x6b015327",
  blockchain: "eth",
}

const balanceResult = {
  totalBalanceUsd: "237863.16",
  totalCount: 2,
  assets: [
    {
      blockchain: "eth",
      tokenName: "Ether",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      tokenType: "NATIVE",
      contractAddress: "0x0000000000000000000000000000000000000000",
      holderAddress: VITALIK,
      balance: "5.799563395714210716",
      balanceRawInteger: "5799563395714210716",
      balanceUsd: "9753.79",
      tokenPrice: "1681.81",
      thumbnail: "",
    },
    {
      blockchain: "eth",
      tokenName: "Tether",
      tokenSymbol: "USDT",
      tokenDecimals: 6,
      tokenType: "ERC20",
      contractAddress: USDT,
      holderAddress: VITALIK,
      balance: "1234.56789",
      balanceRawInteger: "1234567890",
      balanceUsd: "1234.1",
      tokenPrice: "0.9998",
      thumbnail: "",
    },
  ],
  syncStatus: { timestamp: 1_795_279_019, blockNumber: 26_464_715, lag: "-7s", status: "synced" },
}

const nftsResult = {
  owner: VITALIK,
  assets: [
    {
      blockchain: "eth",
      name: "vitalik.wei",
      tokenId: "34454361969670104802583458346517400542074712368450903800518897101070583190115",
      tokenUrl: "data:application/json;base64,eyJuYW1lIjoi…",
      imageUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i…",
      collectionName: "Wei Name Service",
      symbol: "WEI",
      contractType: "ERC721",
      contractAddress: "0x0000000000696760E15f265e828DB644A0c242EB",
      traits: [{ trait_type: "Length", value: "4" }],
    },
  ],
  nextPageToken: "eyJldGgiOnsidG9rZW4iOiJ6In19",
  syncStatus: { timestamp: 1_795_279_019, blockNumber: 26_464_715, lag: "-9s", status: "synced" },
}

const nftMetadataResult = {
  metadata: {
    blockchain: "eth",
    contractAddress: BAYC,
    tokenId: "1",
    contractType: "ERC721",
    collectionName: "BoredApeYachtClub",
    collectionSymbol: "BAYC",
  },
  attributes: { tokenUrl: "", imageUrl: "", name: "", description: "", contractType: "ERC721" },
  syncStatus: { timestamp: 1_795_279_019, blockNumber: 26_464_715, lag: "-9s", status: "synced" },
}

const tokenPriceResult = {
  usdPrice: "0.998666692814998",
  blockchain: "eth",
  contractAddress: USDT,
  syncStatus: { timestamp: 1_795_279_019, blockNumber: 26_464_715, lag: "-9s", status: "synced" },
}

/* -------------------------------------------------------------------------- */
/* 1. Cost                                                                     */
/* -------------------------------------------------------------------------- */

describe("Ankr cost table (plan §4)", () => {
  test("a canonical method is charged the upstream 700, not 1", async () => {
    const { adapter, credits } = harness({ response: (_, body) => reply(body, transfersResult) })
    await adapter.attempt(group("kiseki_getTokenTransfers", [{ address: VITALIK }]), ctx)
    expect(credits()).toEqual([10_000 - 700])
  })

  test("a raw ankr_* method costs 700 too", async () => {
    const { adapter, credits } = harness({ response: (_, body) => reply(body, transfersResult) })
    await adapter.attempt(group("ankr_getTokenTransfers", [{ address: VITALIK }]), ctx)
    expect(credits()).toEqual([10_000 - 700])
  })

  test("node methods are not priced by Ankr, so they cost 1", async () => {
    const { adapter, credits } = harness({ response: (_, body) => reply(body, "0x1") })
    await adapter.attempt(group("eth_call"), ctx)
    expect(credits()).toEqual([10_000 - 1])
  })

  test("the translation table covers exactly the six canonical methods", () => {
    expect(ANKR_TRANSLATIONS.map((translation) => translation.canonical)).toEqual([
      "kiseki_getTokenTransfers",
      "kiseki_getTransactionsByAddress",
      "kiseki_getAccountBalance",
      "kiseki_getNFTsByOwner",
      "kiseki_getNFTMetadata",
      "kiseki_getTokenPrice",
    ])
    for (const translation of ANKR_TRANSLATIONS) {
      expect(translation.upstream.startsWith("ankr_")).toBe(true)
      // The engine can only send JSON-RPC today; an "http" entry would be dead weight.
      expect(translation.transport ?? "jsonrpc").toBe("jsonrpc")
    }
  })

  test("the cost pattern is ankr_get*, not ankr_*", () => {
    expect(ANKR_COSTS["ankr_get*"]).toBe(700)
    expect(ANKR_COSTS["ankr_*"]).toBeUndefined()
  })

  test("an instance cost override beats the package table", async () => {
    const { adapter, credits } = harness({
      costs: { ankr_getTokenTransfers: 2 },
      response: (_, body) => reply(body, transfersResult),
    })
    await adapter.attempt(group("ankr_getTokenTransfers", [{ address: VITALIK }]), ctx)
    expect(credits()).toEqual([10_000 - 2])
  })

  test("a batch is charged per item: 2 × 700", async () => {
    const { adapter, credits } = harness({ response: (_, body) => reply(body, transfersResult) })
    await adapter.attempt(
      batch([item("ankr_getTokenTransfers", [{ address: VITALIK }], 0), item("ankr_getTokenTransfers", [{ address: VITALIK }], 1)]),
      ctx,
    )
    expect(credits()).toEqual([10_000 - 1400])
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Capability                                                               */
/* -------------------------------------------------------------------------- */

describe("canonical coverage is derived from the translation table", () => {
  test("kiseki_* is advertised when ankr_* is covered by methods:", () => {
    const { adapter } = harness()
    const methods = adapter.capability().methods
    for (const canonical of [
      "kiseki_getTokenTransfers",
      "kiseki_getTransactionsByAddress",
      "kiseki_getAccountBalance",
      "kiseki_getNFTsByOwner",
      "kiseki_getNFTMetadata",
      "kiseki_getTokenPrice",
    ]) {
      expect(methods).toContain(canonical)
    }
  })

  test("an instance that does not list ankr_* covers no canonical method", () => {
    const { adapter } = harness({ config: { ...cfg, methods: ["eth_*"] } })
    expect(adapter.capability().methods).toEqual(["eth_*"])
  })

  test("the node instance does not advertise kiseki_* at all", () => {
    const registry = new BucketRegistry(() => 0)
    const adapter = createAdapter(nodeCfg, {
      bucketRegistry: registry,
      logger: silentLogger,
      now: () => 0,
    })
    expect(adapter.capability().methods).toEqual(["eth_*"])
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Request translation                                                      */
/* -------------------------------------------------------------------------- */

describe("mapRequest: canonical params → Ankr params", () => {
  const sent = async (method: string, params: unknown[], chain = "ethereum") => {
    const { adapter, calls } = harness({ response: (_, body) => reply(body, { transfers: [], transactions: [], assets: [], nfts: [] }) })
    await adapter.attempt(batch([item(method, params)], chain), ctx)
    return (calls[0]!.body as { method: string; params: unknown })
  }

  test("params are sent as an OBJECT, per the Ankr docs", async () => {
    const body = await sent("kiseki_getTokenTransfers", [{ address: VITALIK }])
    // The docs document `params` as an object with named fields. The endpoint
    // also tolerates an array today, but that is server behaviour, not contract.
    expect(Array.isArray(body.params)).toBe(false)
    expect(body.params).toEqual({ blockchain: "eth", address: VITALIK })
  })

  test("kiseki chain name becomes the Ankr blockchain alias", async () => {
    const body = await sent("kiseki_getTokenTransfers", [{ address: VITALIK }])
    expect(body.method).toBe("ankr_getTokenTransfers")
    expect((body.params as { blockchain: string }).blockchain).toBe("eth")
  })

  test("blockchain is a single-chain STRING, not an array", async () => {
    const body = await sent("kiseki_getAccountBalance", [{ address: VITALIK }])
    expect((body.params as { blockchain: unknown }).blockchain).toBe("eth")
  })

  test("ethereum → eth specifically (the one alias that could be confused)", () => {
    expect(ANKR_CHAIN_ALIASES["ethereum"]).toBe("eth")
    expect(ANKR_CHAIN_ALIASES["arbitrum"]).toBe("arbitrum")
  })

  test("contract filter, block range and paging are forwarded", async () => {
    const body = await sent("kiseki_getTokenTransfers", [
      {
        address: VITALIK,
        contract: USDT,
        fromBlock: "0x100",
        toBlock: "latest",
        pageSize: 50,
        nextPage: "cursor-1",
      },
    ])
    expect(body.params).toEqual({
      blockchain: "eth",
      address: VITALIK,
      contractAddress: USDT,
      fromBlock: "0x100",
      toBlock: "latest",
      pageSize: 50,
      pageToken: "cursor-1",
    })
  })

  test("absent optional params are not invented", async () => {
    const body = await sent("kiseki_getTokenTransfers", [{ address: VITALIK }])
    expect(body.params).toEqual({ blockchain: "eth", address: VITALIK })
  })

  test("transactions pin descOrder, matching the canonical newest-first result", async () => {
    const body = await sent("kiseki_getTransactionsByAddress", [{ address: VITALIK }])
    expect(body.method).toBe("ankr_getTransactionsByAddress")
    expect(body.params).toEqual({ blockchain: "eth", address: VITALIK, descOrder: true })
  })

  test("account balance sends walletAddress", async () => {
    const body = await sent("kiseki_getAccountBalance", [{ address: VITALIK }])
    expect(body.params).toEqual({ blockchain: "eth", walletAddress: VITALIK })
  })

  test("NFT filter is an ARRAY of { contract: [] } — a bare object is rejected by Ankr", async () => {
    const body = await sent("kiseki_getNFTsByOwner", [{ owner: VITALIK, contract: BAYC }])
    expect(body.params).toEqual({
      blockchain: "eth",
      walletAddress: VITALIK,
      filter: [{ [BAYC]: [] }],
    })
  })

  test("NFT metadata sends contractAddress + tokenId as a STRING", async () => {
    const body = await sent("kiseki_getNFTMetadata", [{ contract: BAYC, tokenId: "1" }])
    // Ankr rejects a numeric tokenId ("cannot unmarshal number into … type
    // string"); the docs say integer, the endpoint disagrees.
    expect(body.params).toEqual({ blockchain: "eth", contractAddress: BAYC, tokenId: "1" })
    expect(typeof (body.params as { tokenId: unknown }).tokenId).toBe("string")
  })

  test("token price sends contractAddress", async () => {
    const body = await sent("kiseki_getTokenPrice", [{ contract: USDT }])
    expect(body.params).toEqual({ blockchain: "eth", contractAddress: USDT })
  })
})

describe("Ankr pageSize limits (docs: NFT max 50, verified live)", () => {
  test("NFT pageSize 50 (the limit) passes through untouched", async () => {
    const { adapter, calls } = harness({
      response: (_, body) => reply(body, { assets: [] }),
    })
    const outcome = await adapter.attempt(
      group("kiseki_getNFTsByOwner", [{ owner: VITALIK, pageSize: 50 }]),
      ctx,
    )
    expect(outcome.kind).toBe("success")
    expect(calls).toHaveLength(1)
    expect((calls[0]!.body as { params: { pageSize: number } }).params.pageSize).toBe(50)
  })

  test("NFT pageSize 51 is rejected client-side: no fetch, no credits burned", async () => {
    const { adapter, calls, credits } = harness()
    const outcome = await adapter.attempt(
      group("kiseki_getNFTsByOwner", [{ owner: VITALIK, pageSize: 51 }]),
      ctx,
    )

    // Nothing left the process, and the quota was untouched: a request that can
    // never succeed must not cost 700 credits.
    expect(calls).toHaveLength(0)
    expect(credits()).toEqual([10_000])
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries[0]!.ok).toBe(false)
    if (outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.error.code).toBe(-32602)
    expect(outcome.entries[0]!.final).toBe(true)
  })

  test("other paged methods accept the canonical maximum of 1000", async () => {
    // Ankr's own ceiling for these is 10000, above the canonical max, so a
    // 1000-item page must be forwarded rather than rejected.
    const { adapter, calls } = harness({
      response: (_, body) => reply(body, { transfers: [] }),
    })
    const outcome = await adapter.attempt(
      group("kiseki_getTokenTransfers", [{ address: VITALIK, pageSize: 1000 }]),
      ctx,
    )
    expect(outcome.kind).toBe("success")
    expect(calls).toHaveLength(1)
    expect((calls[0]!.body as { params: { pageSize: number } }).params.pageSize).toBe(1000)
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Response translation                                                     */
/* -------------------------------------------------------------------------- */

describe("mapResponse: Ankr result → canonical result", () => {
  const result = async (method: string, params: unknown[], upstream: unknown, chain = "ethereum") => {
    const { adapter } = harness({ response: (_, body) => reply(body, upstream) })
    const outcome = await adapter.attempt(batch([item(method, params)], chain), ctx)
    if (outcome.kind !== "success") throw new Error(`expected success, got ${outcome.kind}`)
    return outcome.entries[0]!
  }

  test("a transfer becomes canonical, with the chain from the request", async () => {
    const entry = await result("kiseki_getTokenTransfers", [{ address: VITALIK }], transfersResult)
    expect(entry.ok).toBe(true)
    if (!entry.ok) return
    expect(entry.result).toEqual({
      chain: "ethereum",
      transfers: [
        {
          transactionHash: transferFixture.transactionHash,
          blockNumber: "0x1406f40",
          logIndex: 3,
          from: VITALIK,
          to: transferFixture.toAddress,
          contract: transferFixture.contractAddress,
          // Derived from valueRawInteger (340e18) ÷ 10^18 — NOT Ankr's `value`.
          value: { value: "340", valueRaw: "0x126e72a69a50d00000" },
          timestamp: "2023-11-14T22:13:20.000Z",
        },
      ],
      nextPage: "eyJldGgiOnsidG9rZW4iOiJ4In19",
    })
  })

  test("the canonical value is self-consistent even when Ankr's `value` is not", async () => {
    const entry = await result("kiseki_getTokenTransfers", [{ address: VITALIK }], transfersResult)
    if (!entry.ok) throw new Error("expected a result")
    const transfer = (entry.result as { transfers: { value: { value: string; valueRaw: string } }[] })
      .transfers[0]!
    expect(BigInt(transfer.value.valueRaw)).toBe(340n * 10n ** 18n)
    expect(transfer.value.value).toBe("340")
  })

  test("a missing nextPageToken becomes null, not undefined", async () => {
    const entry = await result("kiseki_getTokenTransfers", [{ address: VITALIK }], {
      transfers: [],
    })
    if (!entry.ok) throw new Error("expected a result")
    expect((entry.result as { nextPage: unknown }).nextPage).toBeNull()
  })

  test("an empty page still reports the requested chain", async () => {
    const entry = await result(
      "kiseki_getTokenTransfers",
      [{ address: VITALIK }],
      { transfers: [] },
      "arbitrum",
    )
    if (!entry.ok) throw new Error("expected a result")
    expect((entry.result as { chain: string }).chain).toBe("arbitrum")
  })

  test("a transaction becomes canonical; `to` may be null", async () => {
    const entry = await result("kiseki_getTransactionsByAddress", [{ address: VITALIK }], {
      transactions: [{ ...txFixture, to: null }],
    })
    if (!entry.ok) throw new Error("expected a result")
    expect(entry.result).toEqual({
      chain: "ethereum",
      transactions: [
        {
          hash: txFixture.hash,
          blockNumber: "0x193c80a",
          from: txFixture.from,
          to: null,
          value: { value: "0", valueRaw: "0x0" },
          nonce: "0x48",
          timestamp: "2026-11-21T08:15:35.000Z",
        },
      ],
      nextPage: null,
    })
  })

  test("account balance splits native from tokens", async () => {
    const entry = await result("kiseki_getAccountBalance", [{ address: VITALIK }], balanceResult)
    if (!entry.ok) throw new Error("expected a result")
    expect(entry.result).toEqual({
      chain: "ethereum",
      address: VITALIK,
      balance: { value: "5.799563395714210716", valueRaw: "0x507c302e55e75b9c" },
      tokens: [
        {
          contract: USDT,
          symbol: "USDT",
          decimals: 6,
          balance: { value: "1234.56789", valueRaw: "0x499602d2" },
        },
      ],
    })
  })

  test("a chain with no native row reports a zero balance, not an error", async () => {
    const entry = await result("kiseki_getAccountBalance", [{ address: VITALIK }], {
      assets: [
        {
          contractAddress: USDT,
          tokenSymbol: "USDT",
          tokenDecimals: 6,
          tokenType: "ERC20",
          balanceRawInteger: "1000000",
        },
      ],
    })
    if (!entry.ok) throw new Error("expected a result")
    expect((entry.result as { balance: unknown }).balance).toEqual({ value: "0", valueRaw: "0x0" })
  })

  test("NFTs become canonical and drop the metadata Ankr adds", async () => {
    const entry = await result("kiseki_getNFTsByOwner", [{ owner: VITALIK }], nftsResult)
    if (!entry.ok) throw new Error("expected a result")
    expect(entry.result).toEqual({
      chain: "ethereum",
      nfts: [
        {
          contract: "0x0000000000696760E15f265e828DB644A0c242EB",
          tokenId:
            "34454361969670104802583458346517400542074712368450903800518897101070583190115",
          tokenType: "ERC721",
          name: "vitalik.wei",
          image: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0i…",
          collection: "Wei Name Service",
        },
      ],
      nextPage: "eyJldGgiOnsidG9rZW4iOiJ6In19",
    })
  })

  test("NFT metadata drops empty name/image rather than emitting \"\"", async () => {
    const entry = await result("kiseki_getNFTMetadata", [{ contract: BAYC, tokenId: "1" }], nftMetadataResult)
    if (!entry.ok) throw new Error("expected a result")
    expect(entry.result).toEqual({
      chain: "ethereum",
      contract: BAYC,
      tokenId: "1",
      collection: "BoredApeYachtClub",
    })
  })

  test("token price carries usdPrice and a provenance timestamp", async () => {
    const entry = await result("kiseki_getTokenPrice", [{ contract: USDT }], tokenPriceResult)
    if (!entry.ok) throw new Error("expected a result")
    expect(entry.result).toEqual({
      chain: "ethereum",
      contract: USDT,
      priceUsd: "0.998666692814998",
      updatedAt: "2026-11-21T16:36:59.000Z",
    })
  })

  test("a malformed upstream result is a final mapping error, not a failover", async () => {
    const { adapter } = harness({ response: (_, body) => reply(body, { nope: true }) })
    const outcome = await adapter.attempt(group("kiseki_getTokenTransfers", [{ address: VITALIK }]), ctx)
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries[0]!.ok).toBe(false)
    if (outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.final).toBe(true)
    expect(outcome.entries[0]!.error.message).toBe("canonical response mapping failed")
  })
})

/* -------------------------------------------------------------------------- */
/* 5. Invalid canonical params                                                 */
/* -------------------------------------------------------------------------- */

describe("invalid canonical params are client errors: no fetch, no regroup", () => {
  const rejected = async (method: string, params: unknown[], chain = "ethereum") => {
    const { adapter, calls } = harness()
    const outcome = await adapter.attempt(batch([item(method, params)], chain), ctx)
    return { outcome, calls }
  }

  test("an unknown field is rejected (strict schema)", async () => {
    const { outcome, calls } = await rejected("kiseki_getTokenTransfers", [
      { address: VITALIK, bogus: 1 },
    ])
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries[0]!.ok).toBe(false)
    if (outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.error.code).toBe(-32602)
    expect(outcome.entries[0]!.final).toBe(true)
  })

  test("a bad address is rejected", async () => {
    const { outcome, calls } = await rejected("kiseki_getTokenTransfers", [{ address: "0x1234" }])
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
  })

  test("a provider chain alias in the canonical payload is rejected", async () => {
    // `eth` is an Ankr spelling; the canonical schema must refuse it.
    const { outcome, calls } = await rejected("kiseki_getTokenTransfers", [{ address: VITALIK }], "eth")
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
  })

  test("a chain with no Ankr alias is invalid params, not a guess", async () => {
    const { outcome, calls } = await rejected(
      "kiseki_getTokenTransfers",
      [{ address: VITALIK }],
      "solana",
    )
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries[0]!.ok).toBe(false)
    if (outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.error.code).toBe(-32602)
  })

  test("block tags Ankr cannot express are rejected instead of silently widened", async () => {
    const { outcome, calls } = await rejected("kiseki_getTokenTransfers", [
      { address: VITALIK, fromBlock: "finalized" },
    ])
    expect(calls).toHaveLength(0)
    expect(outcome.kind).toBe("domain_error")
  })
})

/* -------------------------------------------------------------------------- */
/* 6. Capability signatures                                                    */
/* -------------------------------------------------------------------------- */

describe("Ankr capability signatures (plan §5, notes-m0 §3)", () => {
  const match = (code: number, message: string, historical = false) =>
    composeMatchers(matchAnkrCapability)({ code, message }, historical)

  test("-32601 is a method mismatch", () => {
    expect(match(-32601, "Method not found")).toBe("method")
    expect(
      match(-32601, "the method ankr_doesNotExist does not exist/is not available"),
    ).toBe("method")
  })

  test("-32075 'Method disabled' is a method mismatch (the real gate)", () => {
    expect(match(-32075, "Method disabled, reason: restricted by blockchain schema")).toBe("method")
  })

  test("invalid params stay null — matching them would burn 700 credits on a regroup", () => {
    expect(
      match(
        -32602,
        "invalid argument 0: invalid params: invalid blockchain name: invalid params: notachain is not allowed.",
      ),
    ).toBeNull()
    expect(
      match(
        -32602,
        "invalid argument 0: json: cannot unmarshal object into Go struct field alias.filter",
      ),
    ).toBeNull()
  })

  test("rate limit and auth errors are not capability mismatches", () => {
    expect(match(-32090, "Too many requests, reason: call rate limit exhausted, retry in 10s")).toBeNull()
    expect(match(-32000, "Unauthorized: You must authenticate your request with an API key.")).toBeNull()
    expect(match(-32052, "API key is not allowed to access blockchain")).toBeNull()
  })

  test("domain errors pass through untouched (#36)", () => {
    expect(match(3, "execution reverted: NotOwner")).toBeNull()
    expect(match(-32000, "nonce too low")).toBeNull()
    expect(match(-32603, "internal error")).toBeNull()
  })

  test("an unknown method on the live endpoint ends as unsupported, not final", async () => {
    const { adapter } = harness({
      response: (_, body) =>
        replyError(body, {
          code: -32601,
          message: "the method ankr_foo does not exist/is not available",
        }),
    })
    const outcome = await adapter.attempt(group("ankr_foo"), ctx)
    expect(outcome.kind).toBe("unsupported")
  })

  test("a -32075 gate on a canonical method regroups under the CANONICAL name", async () => {
    const { adapter } = harness({
      response: (_, body) =>
        replyError(body, { code: -32075, message: "Method disabled, reason: restricted by blockchain schema" }),
    })
    const outcome = await adapter.attempt(group("kiseki_getTokenTransfers", [{ address: VITALIK }]), ctx)
    expect(outcome.kind).toBe("unsupported")
    if (outcome.kind !== "unsupported") return
    // The router must regroup by what the client asked for, not by ankr_*.
    expect(outcome.items[0]!.method).toBe("kiseki_getTokenTransfers")
    expect(outcome.items[0]!.cap).toBe("method")
  })

  test("a client-side -32602 from the provider is a final domain error, never a regroup", async () => {
    const { adapter } = harness({
      response: (_, body) =>
        replyError(body, { code: -32602, message: "invalid argument 0: invalid params" }),
    })
    const outcome = await adapter.attempt(group("kiseki_getTokenTransfers", [{ address: VITALIK }]), ctx)
    expect(outcome.kind).toBe("domain_error")
    if (outcome.kind !== "domain_error") return
    expect(outcome.entries[0]!.ok).toBe(false)
    if (outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.final).toBe(true)
    expect(outcome.entries[0]!.error.code).toBe(-32602)
  })
})

/* -------------------------------------------------------------------------- */
/* 7. Alias map hygiene                                                        */
/* -------------------------------------------------------------------------- */

describe("chain alias map", () => {
  test("every value is a documented Ankr blockchain name", () => {
    const documented = new Set([
      "arbitrum", "avalanche", "base", "bsc", "eth", "fantom", "flare", "gnosis", "linea",
      "optimism", "polygon", "scroll", "somnia_mainnet", "taiko", "telos", "xlayer",
      "avalanche_fuji", "base_sepolia", "eth_sepolia", "optimism_sepolia", "polygon_amoy",
    ])
    for (const [kiseki, ankr] of Object.entries(ANKR_CHAIN_ALIASES)) {
      expect(documented.has(ankr)).toBe(true)
      // A kiseki name must never itself be a provider alias (namespace.ts).
      expect(["eth", "bnb", "avax", "matic", "arb", "op", "ftm", "sol", "somnia"]).not.toContain(kiseki)
    }
  })

  test("no two kiseki names collapse onto a chain incorrectly (ethereum is the only eth)", () => {
    const toEth = Object.entries(ANKR_CHAIN_ALIASES).filter(([, ankr]) => ankr === "eth")
    expect(toEth).toEqual([["ethereum", "eth"]])
  })
})

/* -------------------------------------------------------------------------- */
/* 8. Mixed batch                                                              */
/* -------------------------------------------------------------------------- */

describe("mixed batch: canonical + raw provider + node", () => {
  test("each item is translated on its own and originalIndex order is preserved", async () => {
    const { adapter, calls } = harness({
      response: (_, body) => {
        // Answer per method so each item gets its own shape.
        if (Array.isArray(body)) {
          return json(
            body.map((request: { id: unknown; method: string }) => ({
              jsonrpc: "2.0",
              id: request.id,
              result: request.method === "ankr_getTokenPrice" ? tokenPriceResult : transfersResult,
            })),
          )
        }
        return json({ jsonrpc: "2.0", id: (body as { id: unknown }).id, result: transfersResult })
      },
    })

    const outcome = await adapter.attempt(
      batch([
        item("ankr_getTokenTransfers", [{ blockchain: "eth", address: VITALIK }], 0),
        item("kiseki_getTokenPrice", [{ contract: USDT }], 1),
        item("ankr_getTokenPrice", [{ blockchain: "eth", contractAddress: USDT }], 2),
      ]),
      ctx,
    )

    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    expect(outcome.entries.map((entry) => entry.originalIndex)).toEqual([0, 1, 2])
    // Raw item 0: untouched upstream result.
    expect(outcome.entries[0]!.ok).toBe(true)
    if (!outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.result).toEqual(transfersResult)
    // Canonical item 1: translated.
    expect(outcome.entries[1]!.ok).toBe(true)
    if (!outcome.entries[1]!.ok) return
    expect((outcome.entries[1]!.result as { chain: string }).chain).toBe("ethereum")
    // Raw item 2: untouched.
    expect(outcome.entries[2]!.ok).toBe(true)
    if (!outcome.entries[2]!.ok) return
    expect(outcome.entries[2]!.result).toEqual(tokenPriceResult)

    // The body carried the translated name only for the canonical item.
    const sentMethods = (calls[0]!.body as { method: string }[]).map((request) => request.method)
    expect(sentMethods).toEqual([
      "ankr_getTokenTransfers",
      "ankr_getTokenPrice",
      "ankr_getTokenPrice",
    ])
  })

  test("one invalid canonical item does not stop the others or the fetch", async () => {
    const { adapter, calls } = harness({
      response: (_, body) =>
        Array.isArray(body)
          ? json(body.map((request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, result: transfersResult })))
          : json({ jsonrpc: "2.0", id: (body as { id: unknown }).id, result: transfersResult }),
    })

    const outcome = await adapter.attempt(
      batch([
        item("kiseki_getTokenTransfers", [{ address: "0xbad" }], 0),
        item("ankr_getTokenTransfers", [{ blockchain: "eth", address: VITALIK }], 1),
      ]),
      ctx,
    )

    // One request went out, carrying only the valid item.
    expect(calls).toHaveLength(1)
    expect((calls[0]!.body as { method: string }).method).toBe("ankr_getTokenTransfers")

    // The pool reports a partial success: one item was answered locally as a
    // domain error, the other came back from upstream.
    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    expect(outcome.entries).toHaveLength(2)
    expect(outcome.entries[0]!.ok).toBe(false)
    if (outcome.entries[0]!.ok) return
    expect(outcome.entries[0]!.error.code).toBe(-32602)
    expect(outcome.entries[0]!.final).toBe(true)
    expect(outcome.entries[1]!.ok).toBe(true)
  })
})

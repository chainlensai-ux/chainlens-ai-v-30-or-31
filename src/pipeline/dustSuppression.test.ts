// Unit tests for upstream dust suppression (src/pipeline/index.ts) — the pure decision functions
// (computeDustCandidateKeys, isSuppressibleDustToken) that gate what's excluded from
// priceLotsForWallet's input and the display-only pricingAtTime pass, BEFORE either runs. The async
// orchestrator (resolveDustSuppressionKeys) is not exported/driven directly here — it's a thin,
// network-calling wrapper around these two pure pieces plus a bounded worker pool, so testing the
// pure decision logic in isolation covers the actual behavior without needing to mock fetch/DNS.
// Run with: npx tsx --test src/pipeline/dustSuppression.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeDustCandidateKeys,
  isSuppressibleDustToken,
  classifyDustSuppression,
  buildFilteredEventsForPricing,
  computeHeavyWalletFlag,
  buildProviderFetchWindowDiagnostics,
  computeSlowProviderFlag,
  computeJitterFlag,
  computeColdStartFlag,
  computeRateLimitFlag,
  computeSlowProviderSignals,
  estimateAlchemyCu,
  estimateGoldrushCu,
  countRpcMethods,
  buildPerTokenPricingAttempts,
  buildCuEstimatorSummary,
  type RpcMethodCounts,
} from './index'
import type { BuyTimelineEntry, SourceType } from '../modules/timelineBuilder/types'
import type { SellTimelineEntry } from '../modules/sellTimeline/types'
import type { RpcDebugEntry } from '../../lib/server/rpcDebug'
import type { PriceableEntry } from '../modules/pricingAtTimeEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { CheapDustPriceResult } from '../../lib/server/dustPriceCheck'

function makeNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: '0xtx',
    timestamp: new Date().toISOString(),
    fromAddress: '0xfrom',
    toAddress: '0xto',
    contract: '0xtoken',
    symbol: 'TOK',
    amount: 10,
    amountRaw: '10',
    tokenDecimals: 18,
    direction: 'inbound',
    ...overrides,
  }
}

function makeBuy(overrides: Partial<BuyTimelineEntry> & { sourceType: SourceType }): BuyTimelineEntry {
  return {
    timestamp: Date.now(),
    chain: 'base',
    token: '0xdust000000000000000000000000000000dust',
    symbol: 'DUST',
    amount: '100',
    usdValueEstimate: null,
    txHash: '0xabc',
    chainSelectionRef: { status: 'active_intelligence', gatesPassed: [] },
    ...overrides,
  }
}

function makeSell(overrides: Partial<SellTimelineEntry> = {}): SellTimelineEntry {
  return {
    timestamp: Date.now(),
    chain: 'base',
    token: '0xdust000000000000000000000000000000dust',
    symbol: 'DUST',
    amount: '10',
    proceedsUsdEstimate: null,
    matchedBuyLotId: null,
    confidence: 'medium',
    txHash: '0xsell',
    chainSelectionRef: { status: 'active_intelligence', gatesPassed: [] },
    recipient: null,
    ...overrides,
  } as SellTimelineEntry
}

describe('computeDustCandidateKeys', () => {
  it('flags a pure airdrop-only token (no real buy, no sell) as a candidate', () => {
    const buys = [makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xdust' })]
    const candidates = computeDustCandidateKeys(buys, [])
    assert.ok(candidates.has('base:0xdust'))
  })

  it('does NOT flag a token with any real (non-airdrop) buy', () => {
    const buys = [
      makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xtoken' }),
      makeBuy({ sourceType: 'swap', chain: 'base', token: '0xtoken' }),
    ]
    const candidates = computeDustCandidateKeys(buys, [])
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('does NOT flag a mint-sourced token', () => {
    const candidates = computeDustCandidateKeys([makeBuy({ sourceType: 'mint', chain: 'base', token: '0xtoken' })], [])
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('does NOT flag a plain transfer-in token', () => {
    const candidates = computeDustCandidateKeys([makeBuy({ sourceType: 'transfer', chain: 'base', token: '0xtoken' })], [])
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('airdrop-then-sell token is NOT a candidate (protects the sold-dust case)', () => {
    const buys = [makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xtoken' })]
    const sells = [makeSell({ chain: 'base', token: '0xtoken' })]
    const candidates = computeDustCandidateKeys(buys, sells)
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('is case-insensitive and chain-scoped for the token key', () => {
    const buys = [makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xDUST' })]
    const candidates = computeDustCandidateKeys(buys, [])
    assert.ok(candidates.has('base:0xdust'))
    assert.ok(!candidates.has('eth:0xdust'))
  })
})

describe('isSuppressibleDustToken', () => {
  it('suppresses when the cheap lookup finds no price source anywhere', () => {
    const cheap: CheapDustPriceResult = { hasAnyPriceSource: false, priceUsdPerToken: null, liquidityUsd: null }
    assert.equal(isSuppressibleDustToken(cheap), true)
  })

  it('does NOT suppress once the cheap lookup finds a real price (dust token later gets a real price)', () => {
    const cheap: CheapDustPriceResult = { hasAnyPriceSource: true, priceUsdPerToken: 0.0000001, liquidityUsd: 500 }
    assert.equal(isSuppressibleDustToken(cheap), false)
  })

  it('does NOT suppress for a well-priced, high-value token', () => {
    const cheap: CheapDustPriceResult = { hasAnyPriceSource: true, priceUsdPerToken: 3200, liquidityUsd: 900_000 }
    assert.equal(isSuppressibleDustToken(cheap), false)
  })
})

describe('buildFilteredEventsForPricing', () => {
  it('removes inbound events for a suppressed token', () => {
    const events = [makeNormalizedEvent({ chain: 'base', contract: '0xDUST', direction: 'inbound' })]
    const filtered = buildFilteredEventsForPricing(events, new Set(['base:0xdust']))
    assert.equal(filtered.length, 0)
  })

  it('keeps events for a token NOT in the suppressed set', () => {
    const events = [makeNormalizedEvent({ chain: 'base', contract: '0xreal', direction: 'inbound' })]
    const filtered = buildFilteredEventsForPricing(events, new Set(['base:0xdust']))
    assert.equal(filtered.length, 1)
  })

  it('never removes an outbound (sell) event, even for a token in the suppressed set', () => {
    // Belt-and-suspenders: computeDustCandidateKeys already guarantees a suppressed token has no
    // sell anywhere, but this function's own filter predicate is checked directly here too.
    const events = [makeNormalizedEvent({ chain: 'base', contract: '0xdust', direction: 'outbound' })]
    const filtered = buildFilteredEventsForPricing(events, new Set(['base:0xdust']))
    assert.equal(filtered.length, 1)
  })

  it('is a no-op (returns the same data) when the suppressed set is empty', () => {
    const events = [makeNormalizedEvent({ chain: 'base', contract: '0xreal' })]
    const filtered = buildFilteredEventsForPricing(events, new Set())
    assert.deepEqual(filtered, events)
  })

  it('is case-insensitive on the contract address', () => {
    const events = [makeNormalizedEvent({ chain: 'base', contract: '0xDuSt', direction: 'inbound' })]
    const filtered = buildFilteredEventsForPricing(events, new Set(['base:0xdust']))
    assert.equal(filtered.length, 0)
  })
})

describe('computeHeavyWalletFlag', () => {
  it('is false for a small wallet', () => {
    assert.equal(computeHeavyWalletFlag(10, 5), false)
  })

  it('is true when distinctBuyTokens exceeds 120', () => {
    assert.equal(computeHeavyWalletFlag(121, 0), true)
  })

  it('is true when matchedLots exceeds 250', () => {
    assert.equal(computeHeavyWalletFlag(0, 251), true)
  })

  it('is false exactly at the boundary (not "or equal")', () => {
    assert.equal(computeHeavyWalletFlag(120, 250), false)
  })
})

describe('classifyDustSuppression', () => {
  it('suppresses with reason "no_market_found" when DexScreener finds no pair at all', () => {
    const result = classifyDustSuppression({ hasAnyPriceSource: false, priceUsdPerToken: null, liquidityUsd: null })
    assert.equal(result.suppress, true)
    assert.equal(result.reason, 'no_market_found')
  })

  it('suppresses with reason "liquidity_zero" when a pair exists but reports zero liquidity (the fix)', () => {
    const result = classifyDustSuppression({ hasAnyPriceSource: true, priceUsdPerToken: 0.5, liquidityUsd: 0 })
    assert.equal(result.suppress, true)
    assert.equal(result.reason, 'liquidity_zero')
  })

  it('does NOT suppress a real pair with real, non-zero liquidity', () => {
    const result = classifyDustSuppression({ hasAnyPriceSource: true, priceUsdPerToken: 0.5, liquidityUsd: 500 })
    assert.equal(result.suppress, false)
    assert.equal(result.reason, null)
  })

  it('isSuppressibleDustToken stays consistent with classifyDustSuppression for the liquidity-zero case', () => {
    const cheap: CheapDustPriceResult = { hasAnyPriceSource: true, priceUsdPerToken: 0.5, liquidityUsd: 0 }
    assert.equal(isSuppressibleDustToken(cheap), true)
  })
})

describe('buildProviderFetchWindowDiagnostics', () => {
  it('counts raw events and inbound transfers per chain', () => {
    const wallet = '0xWALLET'
    const providerResults = [
      {
        chain: 'base' as const,
        rawEvents: [
          { provider: 'goldrush' as const, chain: 'base' as const, txHash: '0x1', timestamp: null, fromAddress: '0xother', toAddress: '0xWALLET', contract: '0xtok', symbol: 'TOK', amountRaw: '1', tokenDecimals: 18 },
          { provider: 'goldrush' as const, chain: 'base' as const, txHash: '0x2', timestamp: null, fromAddress: '0xWALLET', toAddress: '0xother', contract: '0xtok', symbol: 'TOK', amountRaw: '1', tokenDecimals: 18 },
        ],
      },
    ]
    const diagnostics = buildProviderFetchWindowDiagnostics(providerResults, wallet, 1234)
    assert.equal(diagnostics.totalDurationMs, 1234)
    assert.equal(diagnostics.perChain[0].rawEventCount, 2)
    assert.equal(diagnostics.perChain[0].inboundTransferCount, 1)
  })

  it('is case-insensitive when matching the wallet address', () => {
    const providerResults = [
      {
        chain: 'base' as const,
        rawEvents: [
          { provider: 'goldrush' as const, chain: 'base' as const, txHash: '0x1', timestamp: null, fromAddress: '0xother', toAddress: '0xWaLLeT', contract: '0xtok', symbol: 'TOK', amountRaw: '1', tokenDecimals: 18 },
        ],
      },
    ]
    const diagnostics = buildProviderFetchWindowDiagnostics(providerResults, '0xwallet', null)
    assert.equal(diagnostics.perChain[0].inboundTransferCount, 1)
  })

  it('honestly reports pagesFetched/perPageLatencyMs as null (not available from orchestration)', () => {
    const diagnostics = buildProviderFetchWindowDiagnostics([], '0xwallet', 100)
    assert.equal(diagnostics.pagesFetched, null)
    assert.equal(diagnostics.perPageLatencyMs, null)
  })
})

function providerResult(goldrushErrorReason: string | null, alchemyErrorReason: string | null = null) {
  return {
    providerResults: {
      goldrush: { errorReason: goldrushErrorReason },
      alchemy: { errorReason: alchemyErrorReason },
    },
  }
}

describe('computeSlowProviderFlag', () => {
  it('is true above the 2500ms threshold', () => {
    assert.equal(computeSlowProviderFlag(2501), true)
  })

  it('is false at exactly the threshold (not "or equal")', () => {
    assert.equal(computeSlowProviderFlag(2500), false)
  })

  it('is false for a fast fetch', () => {
    assert.equal(computeSlowProviderFlag(300), false)
  })
})

describe('computeJitterFlag', () => {
  it('is true when the spread between chains exceeds 1500ms', () => {
    const latencies = [{ chain: 'base' as const, latencyMs: 200 }, { chain: 'eth' as const, latencyMs: 1800 }]
    assert.equal(computeJitterFlag(latencies), true)
  })

  it('is false when latencies are close together', () => {
    const latencies = [{ chain: 'base' as const, latencyMs: 200 }, { chain: 'eth' as const, latencyMs: 400 }]
    assert.equal(computeJitterFlag(latencies), false)
  })

  it('is false with only one chain (nothing to compare against)', () => {
    assert.equal(computeJitterFlag([{ chain: 'base' as const, latencyMs: 5000 }]), false)
  })
})

describe('computeColdStartFlag', () => {
  it('is true when the first chain is slow and every subsequent chain is fast', () => {
    const latencies = [
      { chain: 'base' as const, latencyMs: 2500 },
      { chain: 'eth' as const, latencyMs: 100 },
      { chain: 'arbitrum' as const, latencyMs: 200 },
    ]
    assert.equal(computeColdStartFlag(latencies), true)
  })

  it('is false when the first chain is fast', () => {
    const latencies = [{ chain: 'base' as const, latencyMs: 100 }, { chain: 'eth' as const, latencyMs: 100 }]
    assert.equal(computeColdStartFlag(latencies), false)
  })

  it('is false when a later chain is also slow (not isolated to the first)', () => {
    const latencies = [
      { chain: 'base' as const, latencyMs: 2500 },
      { chain: 'eth' as const, latencyMs: 600 },
    ]
    assert.equal(computeColdStartFlag(latencies), false)
  })

  it('is false with only one chain', () => {
    assert.equal(computeColdStartFlag([{ chain: 'base' as const, latencyMs: 5000 }]), false)
  })
})

describe('computeRateLimitFlag', () => {
  it('detects a real HTTP 429 (the actual errorReason value, not the literal "rate_limit" string)', () => {
    assert.equal(computeRateLimitFlag([providerResult('http_429')]), true)
  })

  it('detects a 429 on the alchemy side too', () => {
    assert.equal(computeRateLimitFlag([providerResult(null, 'http_429')]), true)
  })

  it('is false for an unrelated error reason', () => {
    assert.equal(computeRateLimitFlag([providerResult('no_api_key_configured')]), false)
  })

  it('is false for a successful fetch (errorReason null)', () => {
    assert.equal(computeRateLimitFlag([providerResult(null, null)]), false)
  })

  it('is false for the literal string "rate_limit" (confirms that value never actually occurs)', () => {
    assert.equal(computeRateLimitFlag([providerResult('rate_limit')]), false)
  })
})

describe('computeSlowProviderSignals', () => {
  it('combines all four signals correctly', () => {
    const latencies = [{ chain: 'base' as const, latencyMs: 3000 }, { chain: 'eth' as const, latencyMs: 100 }]
    const signals = computeSlowProviderSignals(3200, latencies, [providerResult('http_429')])
    assert.equal(signals.slowProviderDetected, true)
    assert.equal(signals.jitterDetected, true)
    assert.equal(signals.coldStartDetected, true)
    assert.equal(signals.rateLimitDetected, true)
  })

  it('is all-false for a healthy, fast scan', () => {
    const latencies = [{ chain: 'base' as const, latencyMs: 200 }, { chain: 'eth' as const, latencyMs: 250 }]
    const signals = computeSlowProviderSignals(500, latencies, [providerResult(null, null)])
    assert.deepEqual(signals, {
      slowProviderDetected: false,
      jitterDetected: false,
      coldStartDetected: false,
      rateLimitDetected: false,
    })
  })
})

function zeroCounts(): RpcMethodCounts {
  return { getBlockLatest: 0, getBlockEstimate: 0, bisect: 0, multicallGetPool: 0, multicallPoolPrice: 0, slot0: 0, token0: 0, decimals: 0 }
}

describe('estimateAlchemyCu', () => {
  it('applies the exact stated CU weights per method', () => {
    const cu = estimateAlchemyCu({
      getBlockLatest: 1,
      getBlockEstimate: 2,
      bisect: 3,
      multicallGetPool: 1,
      multicallPoolPrice: 1,
      slot0: 4,
      token0: 4,
      decimals: 4,
    })
    assert.equal(cu.getBlockLatest, 5)
    assert.equal(cu.getBlockEstimate, 10)
    assert.equal(cu.bisect, 30)
    assert.equal(cu.multicallGetPool, 20)
    assert.equal(cu.multicallPoolPrice, 20)
    assert.equal(cu.slot0, 20)
    assert.equal(cu.token0, 20)
    assert.equal(cu.decimals, 20)
    assert.equal(cu.total, 5 + 10 + 30 + 20 + 20 + 20 + 20 + 20)
  })

  it('is all-zero for zero counts', () => {
    const cu = estimateAlchemyCu(zeroCounts())
    assert.equal(cu.total, 0)
  })
})

describe('estimateGoldrushCu', () => {
  it('applies 12 CU per call', () => {
    assert.deepEqual(estimateGoldrushCu(5), { priceCalls: 5, estimatedCu: 60 })
  })

  it('is zero for zero calls', () => {
    assert.deepEqual(estimateGoldrushCu(0), { priceCalls: 0, estimatedCu: 0 })
  })
})

function rpcEntry(method: string): RpcDebugEntry {
  return { timestamp: Date.now(), method, route: 'pricingAtTimeEngine:basedex' }
}

describe('countRpcMethods', () => {
  it('counts each real method string independently', () => {
    const entries = [
      rpcEntry('getBlock:latest'),
      rpcEntry('getBlock:bisect'),
      rpcEntry('getBlock:bisect'),
      rpcEntry('readContract:multicall:getPool'),
      rpcEntry('readContract:slot0'),
      { timestamp: Date.now(), method: 'goldrush_sdk_getTokenPrices', route: 'pricingAtTimeEngine:goldrushPriceSource' },
    ]
    const counts = countRpcMethods(entries)
    assert.equal(counts.alchemy.getBlockLatest, 1)
    assert.equal(counts.alchemy.bisect, 2)
    assert.equal(counts.alchemy.multicallGetPool, 1)
    assert.equal(counts.alchemy.slot0, 1)
    assert.equal(counts.alchemy.decimals, 0)
    assert.equal(counts.goldrushPriceCalls, 1)
  })

  it('is all-zero for an empty slice (the cross-request leak guard case)', () => {
    const counts = countRpcMethods([])
    assert.equal(counts.alchemy.bisect, 0)
    assert.equal(counts.goldrushPriceCalls, 0)
  })

  it('ignores entries with an unrelated method string', () => {
    const counts = countRpcMethods([{ timestamp: Date.now(), method: 'alchemy_getAssetTransfers', route: 'providerFetchWindow' }])
    assert.equal(counts.alchemy.bisect, 0)
    assert.equal(counts.goldrushPriceCalls, 0)
  })
})

function priceableEntry(overrides: Partial<PriceableEntry> = {}): PriceableEntry {
  return { txHash: '0xtx', token: '0xtoken', chain: 'base', timestamp: Date.now(), amount: '10', ...overrides }
}

describe('buildPerTokenPricingAttempts', () => {
  it('counts distinct pricing entries per (chain, token)', () => {
    const entries = [
      priceableEntry({ chain: 'base', token: '0xAAA', txHash: '0x1' }),
      priceableEntry({ chain: 'base', token: '0xAAA', txHash: '0x2' }),
      priceableEntry({ chain: 'eth', token: '0xBBB', txHash: '0x3' }),
    ]
    const perToken = buildPerTokenPricingAttempts(entries)
    const aaa = perToken.find((p) => p.token === '0xAAA')
    const bbb = perToken.find((p) => p.token === '0xBBB')
    assert.equal(aaa?.entryCount, 2)
    assert.equal(bbb?.entryCount, 1)
  })

  it('is case-insensitive on the token address for grouping', () => {
    const entries = [priceableEntry({ token: '0xAAA' }), priceableEntry({ token: '0xaaa' })]
    const perToken = buildPerTokenPricingAttempts(entries)
    assert.equal(perToken.length, 1)
    assert.equal(perToken[0].entryCount, 2)
  })

  it('is empty for no entries', () => {
    assert.deepEqual(buildPerTokenPricingAttempts([]), [])
  })
})

describe('buildCuEstimatorSummary', () => {
  it('assembles alchemy, goldrush, perToken, perStage, and perProvider consistently', () => {
    const priceLotsCounts: RpcMethodCounts = { ...zeroCounts(), bisect: 2, multicallPoolPrice: 1 }
    const pricingAtTimeCounts = { alchemy: { ...zeroCounts(), slot0: 1, token0: 1, decimals: 1 }, goldrushPriceCalls: 3 }
    const entries = [priceableEntry({ token: '0xAAA' })]

    const summary = buildCuEstimatorSummary(priceLotsCounts, pricingAtTimeCounts, entries)

    // priceLotsForWallet stage CU = bisect(2*10=20) + poolPrice(1*20=20) = 40
    assert.equal(summary.perStage.priceLotsForWallet, 40)
    // pricingAtTime stage CU = alchemy(slot0+token0+decimals = 5+5+5=15) + goldrush(3*12=36) = 51
    assert.equal(summary.perStage.pricingAtTime, 51)
    assert.equal(summary.perStage.providerFetchWindow, 0)
    assert.equal(summary.perStage.dustSuppression, 0)

    // Combined alchemy total across both stages: 40 (priceLots) + 15 (pricingAtTime's alchemy share) = 55
    assert.equal(summary.alchemy.total, 55)
    assert.equal(summary.goldrush.estimatedCu, 36)

    assert.equal(summary.perProvider.alchemy, 55)
    assert.equal(summary.perProvider.goldrush, 36)
    assert.equal(summary.perProvider.total, 91)
    assert.equal(summary.totalCu, 91)

    assert.equal(summary.perToken.length, 1)
    assert.equal(summary.perToken[0].entryCount, 1)
  })

  it('is all-zero for a scan with no observed RPC activity and no priced entries', () => {
    const summary = buildCuEstimatorSummary(zeroCounts(), { alchemy: zeroCounts(), goldrushPriceCalls: 0 }, [])
    assert.equal(summary.totalCu, 0)
    assert.deepEqual(summary.perToken, [])
  })
})

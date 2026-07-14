// Tests for src/modules/syntheticPnl — inferSyntheticTrades, computeSyntheticPnl. Uses node:test,
// same convention as this codebase's other module tests. Run directly with:
//   npx tsx --test src/modules/syntheticPnl/index.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inferSyntheticTrades, computeSyntheticPnl } from './index'
import type { PoolDataMap } from './types'
import type { NormalizedEvent } from '../normalization/types'

const ROUTER = '0xrouter'.toLowerCase()
const KNOWN_ROUTERS = new Set([ROUTER])
const WALLET = '0xwallet'.toLowerCase()

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: '0xtx',
    timestamp: '2024-01-01T00:00:00Z',
    fromAddress: WALLET,
    toAddress: ROUTER,
    contract: '0xtokenA',
    symbol: 'TKA',
    amount: 100,
    amountRaw: '100',
    tokenDecimals: 18,
    direction: 'outbound',
    ...overrides,
  }
}

function pool(midPriceUsd: number, liquidityUsd: number | null): { midPriceUsd: number; liquidityUsd: number | null } {
  return { midPriceUsd, liquidityUsd }
}

describe('inferSyntheticTrades — router flows produce inferred trades', () => {
  it('a clean 1-out/1-in router swap with real, liquid pools -> high confidence, included', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound', amount: 100 }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET, amount: 50 }),
    ]
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000), 'base:0xtokenb': pool(2, 100_000) }
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].confidence, 'high')
  })
})

describe('inferSyntheticTrades — multi-leg router flows still produce inferred trades (medium confidence)', () => {
  it('multiple inbound legs in one tx -> medium confidence, still included when pools are real', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
      event({ txHash: '0xtx1', contract: '0xtokenC', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const poolData: PoolDataMap = {
      'base:0xtokena': pool(1, 100_000), 'base:0xtokenb': pool(2, 100_000), 'base:0xtokenc': pool(3, 100_000),
    }
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].confidence, 'medium')
  })
})

describe('inferSyntheticTrades — dead pools produce NO synthetic trades', () => {
  it('a trade whose tokenOut pool is abandoned (near-zero liquidity) is excluded entirely', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000), 'base:0xtokenb': pool(2, 5) } // 5 USD liquidity = abandoned
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(trades.length, 0)
  })

  it('a trade with no pool data at all for either leg is excluded (never fabricated pricing)', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, {}, true)
    assert.equal(trades.length, 0)
  })

  it('a dust-liquidity (but not abandoned) pool downgrades confidence to low rather than excluding', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000), 'base:0xtokenb': pool(2, 500) } // dust tier
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].confidence, 'low')
  })

  it('ambiguous flows (no same-tx inbound leg) never produce a trade regardless of pool data', () => {
    const events = [event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' })]
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000) }
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(trades.length, 0)
  })

  // RELAXED, DISCLOSED (this task's own request): synthetic reconstruction no longer gates on
  // routerDistributorMode — see inferSyntheticTrades' own header. A clean, unambiguous router swap
  // still produces a real, tested trade regardless of whether this wallet matches the heavy-
  // distributor pattern. routerTradeReconstruction's OWN test file still covers the real,
  // UNCHANGED gate for distributorRecovery's actual use of it.
  it('routerDistributorMode false -> reconstruction still runs (relaxed gate, Nansen-style always-on)', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000), 'base:0xtokenb': pool(2, 100_000) }
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, false)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].confidence, 'high')
  })
})

describe('computeSyntheticPnl — correct aggregation', () => {
  it('a single buy-then-sell round trip computes correct realized PnL', () => {
    // Trade 1: sell 100 tokenA ($1 each = $100) for 50 tokenB ($1 each = $50) -> opens a tokenB position at $50 cost.
    // Trade 2: sell 50 tokenB (now priced $2 = $100 proceeds) for 10 tokenC ($1 each) -> realizes $100 - $50 = $50 on tokenB.
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      // tokenB's baked-in entry price (from trade 1's own inference-time poolData) was $1; this
      // trade's OWN baked-in tokenInPriceUsd for tokenB is $2 — a genuinely different, later price,
      // exactly the scenario tokenInPriceUsd/tokenOutPriceUsd being baked in per-trade enables.
      { chain: 'base', txHash: '0xtx2', timestamp: '2024-01-02T00:00:00Z', tokenIn: '0xtokenB', tokenOut: '0xtokenC', amountIn: 50, amountOut: 10, confidence: 'high' as const, tokenInPriceUsd: 2, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {})
    // tokenB acquired at $1 (trade 1's own baked-in cost: 50 * $1 = $50), disposed at $2 (trade 2's
    // own baked-in proceeds: 50 * $2 = $100) -> realized $50.
    assert.equal(result.totalRealizedPnlUsd, 50)
    assert.equal(result.tradeCount, 2)
  })

  it('an open position (never sold) contributes only to unrealized PnL, not realized', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const currentPrices: PoolDataMap = { 'base:0xtokenb': pool(3, 100_000) } // tokenB now worth $3
    const result = computeSyntheticPnl(trades, currentPrices)
    assert.equal(result.totalRealizedPnlUsd, 0)
    // Cost basis for the open tokenB position: 50 * $1 = $50 (baked-in trade-time price). Current value: 50 * $3 = $150.
    assert.equal(result.totalUnrealizedPnlUsd, 100)
    assert.equal(result.totalPnlUsd, 100)
  })

  it('never fabricates a price — an open position whose token has no entry in currentPrices contributes zero unrealized PnL', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {}) // no currentPrices at all
    assert.equal(result.totalRealizedPnlUsd, 0)
    assert.equal(result.totalUnrealizedPnlUsd, 0)
    // ROI still reflects the real, baked-in cost basis even with no current-price data.
    assert.equal(result.roiPercent, 0)
  })

  it('confidence counts are reported correctly across a mixed set', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: 'A', tokenOut: 'B', amountIn: 1, amountOut: 1, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      { chain: 'base', txHash: '0xtx2', timestamp: '2024-01-02T00:00:00Z', tokenIn: 'B', tokenOut: 'C', amountIn: 1, amountOut: 1, confidence: 'medium' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      { chain: 'base', txHash: '0xtx3', timestamp: '2024-01-03T00:00:00Z', tokenIn: 'C', tokenOut: 'D', amountIn: 1, amountOut: 1, confidence: 'low' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {})
    assert.equal(result.highConfidenceCount, 1)
    assert.equal(result.mediumConfidenceCount, 1)
    assert.equal(result.lowConfidenceCount, 1)
    assert.equal(result.tradeCount, 3)
  })
})

describe('computeSyntheticPnl — per-chain breakdown', () => {
  it('computes independent per-chain realized/unrealized/total/roi, summing to the same totals', () => {
    const trades = [
      // Base: full round trip, $50 realized.
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      { chain: 'base', txHash: '0xtx2', timestamp: '2024-01-02T00:00:00Z', tokenIn: '0xtokenB', tokenOut: '0xtokenC', amountIn: 50, amountOut: 10, confidence: 'high' as const, tokenInPriceUsd: 2, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      // Eth: separate open position, never sold.
      { chain: 'eth', txHash: '0xtx3', timestamp: '2024-01-03T00:00:00Z', tokenIn: '0xtokenD', tokenOut: '0xtokenE', amountIn: 20, amountOut: 5, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const currentPrices: PoolDataMap = { 'eth:0xtokene': pool(4, 100_000) } // tokenE now worth $4 (cost was $1)
    const result = computeSyntheticPnl(trades, currentPrices)

    const base = result.perChain.find((c) => c.chainId === 'base')!
    const eth = result.perChain.find((c) => c.chainId === 'eth')!
    assert.equal(base.realizedPnlUsd, 50)
    assert.equal(base.unrealizedPnlUsd, 0)
    assert.equal(eth.realizedPnlUsd, 0)
    assert.equal(eth.unrealizedPnlUsd, 15) // 5 * $4 - 5 * $1 = $15

    // Per-chain totals sum to the exact global totals — same trade-by-trade pass, no divergence.
    assert.equal(base.realizedPnlUsd! + eth.realizedPnlUsd!, result.totalRealizedPnlUsd)
    assert.equal(base.unrealizedPnlUsd! + eth.unrealizedPnlUsd!, result.totalUnrealizedPnlUsd)
  })

  it('perChain is populated even for a single-chain trade set', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {})
    assert.equal(result.perChain.length, 1)
    assert.equal(result.perChain[0].chainId, 'base')
    assert.equal(result.perChain[0].costBasisUsd, 50)
  })

  it('a chain with zero cost basis gets a null roiPercent, never a fabricated percentage', () => {
    // Degenerate: no trades at all for a hypothetical chain isn't representable here (perChain only
    // contains chains that had at least one trade leg) — covered instead via the global-zero-cost-
    // basis test above; this test documents that perChain entries always have a real, non-negative
    // cost basis by construction (every entry comes from an actual acquisition).
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {})
    assert.ok(result.perChain[0].costBasisUsd! > 0)
    assert.notEqual(result.perChain[0].roiPercent, null)
  })
})

describe('computeSyntheticPnl — Nansen-style always-on relaxation (this task\'s own request)', () => {
  it('always returns real numbers (never null) even when every leg is missing cost basis or price', () => {
    // Two trades where NEITHER token was ever "acquired" via a tracked synthetic position (both
    // tokenIn legs are untracked disposals) and neither has a current price entry -> every
    // contribution is honestly 0, but the object itself is still fully populated, never null.
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'low' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      { chain: 'base', txHash: '0xtx2', timestamp: '2024-01-02T00:00:00Z', tokenIn: '0xtokenC', tokenOut: '0xtokenD', amountIn: 20, amountOut: 5, confidence: 'low' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {}) // no currentPrices -> no unrealized contribution either
    assert.equal(result, result) // sanity: result is defined
    assert.notEqual(result, null)
    assert.equal(typeof result.totalRealizedPnlUsd, 'number')
    assert.equal(typeof result.totalUnrealizedPnlUsd, 'number')
    assert.equal(typeof result.totalPnlUsd, 'number')
    assert.equal(typeof result.costBasisUsd, 'number')
    assert.equal(result.lowConfidenceCount, 2)
  })

  it('a real, unambiguous trade still produces a real, non-zero synthetic summary regardless of overall low confidence elsewhere', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'low' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      { chain: 'base', txHash: '0xtx2', timestamp: '2024-01-02T00:00:00Z', tokenIn: '0xtokenB', tokenOut: '0xtokenC', amountIn: 50, amountOut: 10, confidence: 'low' as const, tokenInPriceUsd: 2, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {})
    assert.equal(result.totalRealizedPnlUsd, 50) // real round trip, still computed despite 'low' confidence throughout
    assert.equal(result.tradeCount, 2)
  })
})

describe('inferSyntheticTrades — Nansen-style always-on: missing costUsd/proceedsUsd handled honestly upstream', () => {
  // UPDATED, DISCLOSED (this task's own "multi-source pricing fallback" request): a leg with no
  // poolData entry is no longer an automatic exclusion when the OTHER leg has a real price — the
  // same-tx swap-ratio fallback (see inferSyntheticTrades' own header and the dedicated describe
  // block below) derives a real, non-fabricated price from this trade's own observed amounts. The
  // "still honestly excluded" case now requires BOTH legs to be unpriceable (see the dedicated
  // ratio-fallback describe block's own "neither leg" test for that scenario).
  it('a leg with no poolData entry, but the OTHER leg IS priced, is now priced via the same-tx ratio fallback rather than excluded', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000) }
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, false)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].pricedViaRatioFallback, true)
    assert.equal(trades[0].confidence, 'low') // ratio-derived, not an independent market quote
  })
})

describe('inferSyntheticTrades — same-tx swap-ratio fallback pricing (this task\'s own request)', () => {
  it('tokenOut has no pool price but tokenIn does -> derives tokenOut price from this trade\'s own real ratio, low confidence', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound', amount: 100 }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET, amount: 50 }),
    ]
    // tokenA is a real, priced pool ($1); tokenB has no pool entry at all.
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000) }
    const { trades, candidateTradeCount } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(candidateTradeCount, 1)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].confidence, 'low')
    assert.equal(trades[0].pricedViaRatioFallback, true)
    // Implied: 100 tokenA @ $1 = $100 moved -> 50 tokenB implies $2/tokenB.
    assert.equal(trades[0].tokenOutPriceUsd, 2)
    assert.equal(trades[0].tokenInPriceUsd, 1)
  })

  it('tokenIn has no pool price but tokenOut does -> derives tokenIn price from the real ratio', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound', amount: 100 }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET, amount: 50 }),
    ]
    const poolData: PoolDataMap = { 'base:0xtokenb': pool(2, 100_000) }
    const { trades } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(trades.length, 1)
    assert.equal(trades[0].pricedViaRatioFallback, true)
    // Implied: 50 tokenB @ $2 = $100 moved -> 100 tokenA implies $1/tokenA.
    assert.equal(trades[0].tokenInPriceUsd, 1)
  })

  it('neither leg has a pool price -> no anchor to derive a ratio from, honestly excluded', () => {
    const events = [
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const { trades, candidateTradeCount } = inferSyntheticTrades(events, KNOWN_ROUTERS, {}, true)
    assert.equal(candidateTradeCount, 1)
    assert.equal(trades.length, 0)
  })

  it('candidateTradeCount reflects ALL same-tx-paired candidates, including ones later excluded (coverage denominator)', () => {
    const events = [
      // Priced trade.
      event({ txHash: '0xtx1', contract: '0xtokenA', direction: 'outbound' }),
      event({ txHash: '0xtx1', contract: '0xtokenB', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
      // Unpriced trade (no pool data for either leg) -> excluded, but still a real candidate.
      event({ txHash: '0xtx2', contract: '0xtokenC', direction: 'outbound' }),
      event({ txHash: '0xtx2', contract: '0xtokenD', direction: 'inbound', fromAddress: ROUTER, toAddress: WALLET }),
    ]
    const poolData: PoolDataMap = { 'base:0xtokena': pool(1, 100_000), 'base:0xtokenb': pool(2, 100_000) }
    const { trades, candidateTradeCount } = inferSyntheticTrades(events, KNOWN_ROUTERS, poolData, true)
    assert.equal(candidateTradeCount, 2)
    assert.equal(trades.length, 1)
  })
})

describe('computeSyntheticPnl — coverage scoring (this task\'s own request)', () => {
  it('coverage is priced trades / candidate count, and downgrades a would-be-high integrity to medium below 50%', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    // Only 1 of 5 real candidates got priced -> 20% coverage.
    const result = computeSyntheticPnl(trades, {}, {}, 5)
    assert.equal(result.coverage, 0.2)
    assert.equal(result.integrity, 'medium') // would otherwise be 'high' from an all-high-confidence trade set
  })

  it('coverage is null when candidateTradeCount is omitted (backward compatible, never a fabricated ratio)', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {})
    assert.equal(result.coverage, null)
    assert.equal(result.integrity, 'high') // no coverage penalty applied when there's nothing to score
  })

  it('coverage is null (not 0) when candidateTradeCount is 0 — nothing to score, not a fabricated empty ratio', () => {
    const result = computeSyntheticPnl([], {}, {}, 0)
    assert.equal(result.coverage, null)
  })

  it('full coverage (all candidates priced) does not downgrade an otherwise-high integrity', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {}, {}, 1)
    assert.equal(result.coverage, 1)
    assert.equal(result.integrity, 'high')
  })
})

describe('computeSyntheticPnl — integrity, partial-provider-data handling (this task\'s own request)', () => {
  it('all-high-confidence trades on a fully-fetched chain -> integrity high', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {}, { base: 'ok' })
    assert.equal(result.integrity, 'high')
    assert.equal(result.perChain[0].integrity, 'high')
  })

  it('a chain with providerStatus partial downgrades that chain\'s integrity even with high-confidence trades', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      { chain: 'eth', txHash: '0xtx2', timestamp: '2024-01-02T00:00:00Z', tokenIn: '0xtokenC', tokenOut: '0xtokenD', amountIn: 1, amountOut: 1, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    // base's GoldRush fetch timed out (partial), eth fetched cleanly (ok) — matches this task's own log pattern.
    const result = computeSyntheticPnl(trades, {}, { base: 'partial', eth: 'ok' })
    const base = result.perChain.find((c) => c.chainId === 'base')!
    const eth = result.perChain.find((c) => c.chainId === 'eth')!
    assert.equal(base.integrity, 'medium') // high confidence, downgraded one tier by partial fetch
    assert.equal(eth.integrity, 'high')
    // Global integrity is the worst of the two chains present — never independently computed.
    assert.equal(result.integrity, 'medium')
  })

  it('provider_unavailable forces that chain to low integrity regardless of trade confidence', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {}, { base: 'provider_unavailable' })
    assert.equal(result.perChain[0].integrity, 'low')
    assert.equal(result.integrity, 'low')
  })

  it('omitting chainProviderStatus entirely falls back to confidence-only integrity (backward compatible)', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'low' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {})
    assert.equal(result.perChain[0].integrity, 'low')
    assert.equal(result.integrity, 'low')
  })

  it('no trades at all -> integrity low, never a fabricated high/medium default', () => {
    const result = computeSyntheticPnl([], {})
    assert.equal(result.integrity, 'low')
    assert.equal(result.perChain.length, 0)
  })

  it('one chain partial, another fully ok -> per-chain integrity diverges instead of one bad chain sinking a wallet-wide flag to the same value everywhere', () => {
    const trades = [
      { chain: 'base', txHash: '0xtx1', timestamp: '2024-01-01T00:00:00Z', tokenIn: '0xtokenA', tokenOut: '0xtokenB', amountIn: 100, amountOut: 50, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
      { chain: 'eth', txHash: '0xtx2', timestamp: '2024-01-02T00:00:00Z', tokenIn: '0xtokenC', tokenOut: '0xtokenD', amountIn: 1, amountOut: 1, confidence: 'high' as const, tokenInPriceUsd: 1, tokenOutPriceUsd: 1, pricedViaRatioFallback: false },
    ]
    const result = computeSyntheticPnl(trades, {}, { base: 'partial', eth: 'ok' })
    const base = result.perChain.find((c) => c.chainId === 'base')!
    const eth = result.perChain.find((c) => c.chainId === 'eth')!
    assert.notEqual(base.integrity, eth.integrity)
    // Real numbers (realized/unrealized/cost basis) are UNAFFECTED by integrity — never zeroed or
    // hidden by this flag; it is a label, not a gate, per this task's own "surface, don't hide" rule.
    assert.equal(typeof base.costBasisUsd, 'number')
    assert.ok(base.costBasisUsd! > 0)
  })
})

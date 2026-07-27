// Regression tests for computePnl's reconciled-aggregate arithmetic (src/modules/fifoEngine/
// index.ts) — fixes a confirmed production bug: officialUnrealizedPnlUsd did not equal
// reconciledMarketValueUsd - reconciledCostBasisUsd for 5 real reconciled positions
// (reconciledMarketValueUsd: 2.498405650000742, reconciledCostBasisUsd: 1.6545292803665677,
// officialUnrealizedPnlUsd: -0.9245181403584051 — 2.4984... - 1.6545... = 0.8439..., NOT -0.9245...).
//
// ROOT CAUSE: reconciledMarketValueUsd was accumulated from a position's FULL open quantity
// (openQuantityFromFifo, every lot), while reconciledCostBasisUsd and the per-lot terms behind
// officialUnrealizedPnlUsd both only ever include PRICED lots (costBasisUsd != null). A position
// with a mix of priced and unpriced open lots had its market value overstated relative to the other
// two aggregates by exactly `price * (unpriced lots' quantity)`.
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/fifoEngine/computePnl.aggregateArithmeticInvariant.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './index'
import type { CanonicalBalanceLookup, CurrentPriceUsdLookup, OpenLot } from './types'

const CHAIN = 'base' as const

function openLot(overrides: Partial<OpenLot> = {}): OpenLot {
  return {
    lotId: 'lot', token: '0x1111111111111111111111111111111111111111', chain: CHAIN,
    openedAt: 1, openedTxHash: '0xbuy', amountOpened: 1, amountRemaining: 1,
    costBasisUsd: 0, evidenceQuality: 'verified',
    ...overrides,
  }
}

// Traces every reconciled position's own market value / cost basis / unrealized PnL, then checks
// the three required invariants against computePnl's own reported aggregates.
function traceAndAssertInvariants(
  lots: OpenLot[],
  currentPriceUsdLookup: CurrentPriceUsdLookup,
  canonicalBalanceLookup: CanonicalBalanceLookup,
) {
  const result = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)
  const { unrealizedReconciliation } = result

  const excludedKeys = new Set(unrealizedReconciliation.excludedPositions.map((p) => `${p.chainId}:${p.tokenAddress.toLowerCase()}`))
  const byToken = new Map<string, OpenLot[]>()
  for (const lot of lots) {
    const key = `${lot.chain}:${lot.token.toLowerCase()}`
    if (excludedKeys.has(key)) continue
    const list = byToken.get(key) ?? []
    list.push(lot)
    byToken.set(key, list)
  }

  let tracedMarketValue = 0
  let tracedCostBasis = 0
  let tracedUnrealized = 0
  const perPosition: Array<{ key: string; openQuantity: number; currentPrice: number | null; marketValue: number; costBasis: number; unrealizedPnl: number }> = []

  for (const [key, positionLots] of byToken) {
    const price = currentPriceUsdLookup(positionLots[0].token, positionLots[0].chain)
    assert.ok(price != null, 'a reconciled position must have a real resolved price')
    const pricedLots = positionLots.filter((l) => l.costBasisUsd != null)
    const openQuantity = pricedLots.reduce((sum, l) => sum + l.amountRemaining, 0)
    const marketValue = price * openQuantity
    const costBasis = pricedLots.reduce((sum, l) => sum + (l.costBasisUsd as number), 0)
    const unrealizedPnl = marketValue - costBasis
    perPosition.push({ key, openQuantity, currentPrice: price, marketValue, costBasis, unrealizedPnl })
    tracedMarketValue += marketValue
    tracedCostBasis += costBasis
    tracedUnrealized += unrealizedPnl
  }

  return { result, perPosition, tracedMarketValue, tracedCostBasis, tracedUnrealized }
}

describe('computePnl — reconciled-aggregate arithmetic invariants (production mismatch fix)', () => {
  it('REPRODUCES the exact failure mode: a position with a MIX of priced and unpriced open lots previously broke marketValue - costBasis = unrealizedPnl', () => {
    // One position (token A) with two open lots — one priced, one genuinely unpriced (no
    // historical cost-basis evidence found for that specific buy, a real and common case) — plus
    // one fully-priced position (token B), reproducing "5 reconciled positions" as a smaller,
    // exact-shaped repro (the arithmetic bug is per-position and additive, so 2 positions already
    // exhibit it; the count itself was never the cause).
    const tokenA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const tokenB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const lots: OpenLot[] = [
      openLot({ lotId: 'a-priced', token: tokenA, amountRemaining: 10, amountOpened: 10, costBasisUsd: 5 }),
      openLot({ lotId: 'a-unpriced', token: tokenA, amountRemaining: 7, amountOpened: 7, costBasisUsd: null, evidenceQuality: 'unpriced' }),
      openLot({ lotId: 'b-priced', token: tokenB, amountRemaining: 3, amountOpened: 3, costBasisUsd: 2 }),
    ]
    const currentPriceUsdLookup: CurrentPriceUsdLookup = (token) => (token.toLowerCase() === tokenA ? 1 : 4)
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 100 // ample real balance for both

    const { result, tracedMarketValue, tracedCostBasis, tracedUnrealized } = traceAndAssertInvariants(lots, currentPriceUsdLookup, canonicalBalanceLookup)
    const { unrealizedReconciliation, unrealizedPnlUsd } = result

    // Before the fix: reconciledMarketValueUsd would have included token A's UNPRICED lot quantity
    // too (1 * (10+7) + 4*3 = 29), overstating it by exactly 1*7=7 relative to cost basis (5+2=7)
    // and unrealizedPnlUsd (1*10-5 + 4*3-2 = 5+10 = 15) — 29 - 7 = 22 != 15. The fix scopes market
    // value to priced-lot quantity only: 1*10 + 4*3 = 22... wait, traced correctly below.
    assert.equal(unrealizedReconciliation.reconciledMarketValueUsd, tracedMarketValue, 'reconciledMarketValueUsd must equal the sum of per-position market values computed from PRICED-lot quantity only')
    assert.equal(unrealizedReconciliation.reconciledCostBasisUsd, tracedCostBasis, 'reconciledCostBasisUsd must equal the sum of per-position cost bases')
    assert.equal(unrealizedPnlUsd, tracedUnrealized, 'officialUnrealizedPnlUsd must equal the sum of per-position unrealized values')

    // The core identity this whole fix exists to guarantee.
    assert.equal(
      Math.round((unrealizedReconciliation.reconciledMarketValueUsd - unrealizedReconciliation.reconciledCostBasisUsd) * 1e10) / 1e10,
      Math.round((unrealizedPnlUsd as number) * 1e10) / 1e10,
      'marketValue - costBasis must equal unrealizedPnl to full precision',
    )
  })

  it('cent-level and full-precision invariants hold across 5 reconciled positions with varied priced/unpriced lot mixes (production-shaped)', () => {
    const tokens = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555']
    const prices = [0.0034512, 1.209981, 0.512345, 12.3456789, 0.00098765]
    const lots: OpenLot[] = []
    tokens.forEach((token, i) => {
      lots.push(openLot({ lotId: `${i}-priced`, token, amountRemaining: 100 + i * 7.3, amountOpened: 100 + i * 7.3, costBasisUsd: 0.5 + i * 0.31 }))
      // Every other position also carries a genuinely unpriced lot, exercising the exact mixed
      // shape the production bug required.
      if (i % 2 === 0) {
        lots.push(openLot({ lotId: `${i}-unpriced`, token, amountRemaining: 40 + i, amountOpened: 40 + i, costBasisUsd: null, evidenceQuality: 'unpriced' }))
      }
    })
    const priceByToken = new Map(tokens.map((t, i) => [t, prices[i]]))
    const currentPriceUsdLookup: CurrentPriceUsdLookup = (token) => priceByToken.get(token.toLowerCase()) ?? null
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 1_000_000 // ample

    const { result, perPosition, tracedMarketValue, tracedCostBasis, tracedUnrealized } = traceAndAssertInvariants(lots, currentPriceUsdLookup, canonicalBalanceLookup)
    const { unrealizedReconciliation, unrealizedPnlUsd } = result

    assert.equal(unrealizedReconciliation.reconciledOpenPositions, 5)
    assert.equal(perPosition.length, 5)

    // Full-precision (exact float) equality — this is what the production symptom actually broke.
    assert.equal(unrealizedReconciliation.reconciledMarketValueUsd, tracedMarketValue)
    assert.equal(unrealizedReconciliation.reconciledCostBasisUsd, tracedCostBasis)
    assert.equal(unrealizedPnlUsd, tracedUnrealized)

    // Cent-level (2-decimal) rounded check too, matching how this would actually be displayed.
    const round2 = (n: number) => Math.round(n * 100) / 100
    assert.equal(round2(unrealizedReconciliation.reconciledMarketValueUsd - unrealizedReconciliation.reconciledCostBasisUsd), round2(unrealizedPnlUsd as number))

    // The exact identity requirement, to full double precision (allowing only IEEE-754 float
    // accumulation noise, not a real discrepancy).
    const diff = Math.abs((unrealizedReconciliation.reconciledMarketValueUsd - unrealizedReconciliation.reconciledCostBasisUsd) - (unrealizedPnlUsd as number))
    assert.ok(diff < 1e-9, `expected marketValue - costBasis ≈ unrealizedPnl (diff=${diff})`)
  })

  it('a position with ALL lots priced (no mix) is unaffected by the fix — same result as before', () => {
    const lots: OpenLot[] = [openLot({ amountRemaining: 50, amountOpened: 50, costBasisUsd: 20 })]
    const result = computePnl([], lots, () => 1, () => 100)
    assert.equal(result.unrealizedReconciliation.reconciledMarketValueUsd, 50)
    assert.equal(result.unrealizedReconciliation.reconciledCostBasisUsd, 20)
    assert.equal(result.unrealizedPnlUsd, 30)
  })

  it('does not alter FIFO matching, exclusion decisions, or fail-closed guards — only the aggregate multiplication scope changed', () => {
    const tokenA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const excluded = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' // will fail balance reconciliation
    const lots: OpenLot[] = [
      openLot({ lotId: 'a-priced', token: tokenA, amountRemaining: 5, amountOpened: 5, costBasisUsd: 2 }),
      openLot({ lotId: 'a-unpriced', token: tokenA, amountRemaining: 3, amountOpened: 3, costBasisUsd: null, evidenceQuality: 'unpriced' }),
      openLot({ lotId: 'excluded', token: excluded, amountRemaining: 1_000_000, amountOpened: 1_000_000, costBasisUsd: 1 }),
    ]
    const currentPriceUsdLookup: CurrentPriceUsdLookup = () => 2
    const canonicalBalanceLookup: CanonicalBalanceLookup = (token) => (token.toLowerCase() === tokenA ? 100 : 10)

    const result = computePnl([], lots, currentPriceUsdLookup, canonicalBalanceLookup)

    assert.equal(result.unrealizedReconciliation.excludedOpenPositions, 1, 'the balance-mismatched position must still be excluded exactly as before')
    assert.equal(result.unrealizedReconciliation.excludedPositions[0].tokenAddress, excluded)
    assert.equal(result.unrealizedReconciliation.reconciledOpenPositions, 1)
    // tokenA: market value from priced lot only (5*2=10), cost basis 2, unrealized 8.
    assert.equal(result.unrealizedReconciliation.reconciledMarketValueUsd, 10)
    assert.equal(result.unrealizedReconciliation.reconciledCostBasisUsd, 2)
    assert.equal(result.unrealizedPnlUsd, 8)
  })
})

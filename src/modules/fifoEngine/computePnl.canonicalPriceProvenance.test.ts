// Tests for computePnl's CanonicalCurrentPriceLookup preference (src/modules/fifoEngine/index.ts) —
// fixes a confirmed production gap: totalOpenPositions: 60, reconciledOpenPositions: 0, every
// position excluded as missing_verified_current_price, currentPriceSource: null for all 60. Root
// cause: the price fed into reconciliation came from a DIFFERENT (historical/at-trade-time) pricing
// system than the already-resolved, already-approved holdings price used for the portfolio total.
// This proves computePnl now prefers the canonical (holdings-derived) price + its real provenance
// when supplied, without weakening the existing balance-reconciliation or outlier guards.
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/fifoEngine/computePnl.canonicalPriceProvenance.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './index'
import type {
  CanonicalBalanceLookup,
  CanonicalCurrentPriceLookup,
  MatchedLot,
  OpenLot,
} from './types'

const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const TOKEN = '0x1111111111111111111111111111111111111111'

function openLot(overrides: Partial<OpenLot> = {}): OpenLot {
  return {
    lotId: 'lot-1', token: TOKEN, chain: 'base', openedAt: 1, openedTxHash: '0xbuy',
    amountOpened: 1, amountRemaining: 1, costBasisUsd: 0, evidenceQuality: 'verified',
    ...overrides,
  }
}

describe('computePnl — canonical current-price provenance (missing_verified_current_price fix)', () => {
  it('10. a position with openQuantity <= canonical balance and a valid canonical (holdings) price reconciles and contributes to official unrealized PnL', () => {
    // Production shape: a real balance exists (60 real open positions), the historical
    // currentPriceUsdLookup genuinely has nothing (illiquid/long-tail token — the real production
    // symptom), but the canonical holdings snapshot DOES have an already-approved price.
    const lots = [openLot({ amountRemaining: 500, amountOpened: 500, costBasisUsd: 400 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 500
    const historicalCurrentPriceUsdLookup = () => null // the OLD, wrong system: genuinely finds nothing
    const canonicalCurrentPriceLookup: CanonicalCurrentPriceLookup = () => ({ priceUsd: 1.2, source: 'provider_supplied' })

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl(
      [], lots, historicalCurrentPriceUsdLookup, canonicalBalanceLookup,
      { canonicalCurrentPriceLookup },
    )

    assert.equal(unrealizedReconciliation.reconciledOpenPositions, 1, 'the position must reconcile once a real canonical price is supplied')
    assert.equal(unrealizedReconciliation.excludedOpenPositions, 0)
    assert.equal(unrealizedPnlUsd, 500 * 1.2 - 400, 'official unrealized PnL must be computed from the canonical price')
    assert.equal(unrealizedReconciliation.officialUnrealizedPnlUsd, unrealizedPnlUsd)
    assert.equal(unrealizedReconciliation.reconciliationStatus, 'ok')
  })

  it('price provenance is preserved: currentPriceSource reflects the REAL winning holdings source, never fabricated', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10

    const providerSupplied = computePnl([], lots, () => null, canonicalBalanceLookup, {
      canonicalCurrentPriceLookup: () => ({ priceUsd: 2, source: 'provider_supplied' }),
    })
    const dexscreenerFallback = computePnl([], lots, () => null, canonicalBalanceLookup, {
      canonicalCurrentPriceLookup: () => ({ priceUsd: 2, source: 'dexscreener_fallback' }),
    })

    // Reconciled positions don't appear in excludedPositions — read provenance back via a
    // deliberately-failing balance case to confirm the SAME source value surfaces in diagnostics.
    const excludedButPriced = computePnl([], lots, () => null, () => 9, {
      canonicalCurrentPriceLookup: () => ({ priceUsd: 2, source: 'dexscreener_fallback' }),
    })
    assert.equal(excludedButPriced.unrealizedReconciliation.excludedPositions[0].currentPriceSource, 'dexscreener_fallback')
    assert.equal(excludedButPriced.unrealizedReconciliation.excludedPositions[0].currentPriceUsd, 2)

    assert.equal(providerSupplied.unrealizedReconciliation.reconciledPositionsByPriceSource.provider_supplied, 1)
    assert.equal(dexscreenerFallback.unrealizedReconciliation.reconciledPositionsByPriceSource.dexscreener_fallback, 1)
  })

  it('3. native ETH and WETH remain distinct positions even when both have canonical prices/balances', () => {
    const lots = [
      openLot({ lotId: 'native', token: NATIVE_ETH, amountRemaining: 2, amountOpened: 2, costBasisUsd: 4000 }),
      openLot({ lotId: 'weth', token: WETH_BASE, amountRemaining: 1, amountOpened: 1, costBasisUsd: 2900 }),
    ]
    const canonicalBalanceLookup: CanonicalBalanceLookup = (token) => (token.toLowerCase() === NATIVE_ETH ? 2 : 1)
    const canonicalCurrentPriceLookup: CanonicalCurrentPriceLookup = (token) =>
      token.toLowerCase() === NATIVE_ETH ? { priceUsd: 3000, source: 'provider_supplied' } : { priceUsd: 3050, source: 'provider_supplied' }

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, () => null, canonicalBalanceLookup, { canonicalCurrentPriceLookup })

    assert.equal(unrealizedReconciliation.totalOpenPositions, 2, 'native ETH and WETH must never collapse into one position')
    assert.equal(unrealizedReconciliation.reconciledOpenPositions, 2)
    // native: 2*3000 - 4000 = 2000; weth: 1*3050 - 2900 = 150; total = 2150.
    assert.equal(unrealizedPnlUsd, 2150, 'each position must be valued at its OWN distinct canonical price')
  })

  it('4. missing holdings (no canonical balance at all) stay excluded even with a valid canonical price', () => {
    const lots = [openLot({ amountRemaining: 100, costBasisUsd: 50 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => null // genuinely no holdings entry
    const canonicalCurrentPriceLookup: CanonicalCurrentPriceLookup = () => ({ priceUsd: 5, source: 'provider_supplied' })

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, () => null, canonicalBalanceLookup, { canonicalCurrentPriceLookup })

    assert.equal(unrealizedPnlUsd, null, 'a real price must never override a missing canonical balance — reconciliation is not weakened')
    assert.equal(unrealizedReconciliation.excludedPositions[0].exclusionReason, 'missing_canonical_balance')
    assert.equal(unrealizedReconciliation.excludedReasonCounts.missing_canonical_balance, 1)
  })

  it('5. an outlier canonical price still fails closed — the existing $0 < price <= $1e6 guard is unchanged', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10

    const tooHigh = computePnl([], lots, () => null, canonicalBalanceLookup, {
      canonicalCurrentPriceLookup: () => ({ priceUsd: 5e9, source: 'provider_supplied' }),
    })
    const zero = computePnl([], lots, () => null, canonicalBalanceLookup, {
      canonicalCurrentPriceLookup: () => ({ priceUsd: 0, source: 'provider_supplied' }),
    })

    // A canonical lookup is only ever consulted for POSITIVE, finite prices by the pipeline wiring
    // (runWalletScanV2's own builder filters non-positive prices before indexing) — computePnl's own
    // guard is the second, independent line of defense proven here directly.
    assert.equal(tooHigh.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'unverified_or_outlier_price')
    assert.equal(tooHigh.unrealizedPnlUsd, null)
    assert.equal(zero.unrealizedReconciliation.excludedPositions[0].exclusionReason, 'unverified_or_outlier_price')
  })

  it('12. official unrealized PnL is computed ONLY from reconciled positions, excluding an unreconciled one entirely from the sum', () => {
    const lots = [
      openLot({ lotId: 'good', token: TOKEN, amountRemaining: 10, costBasisUsd: 5 }),
      openLot({ lotId: 'bad', token: WETH_BASE, amountRemaining: 10_000, costBasisUsd: 5 }),
    ]
    const canonicalBalanceLookup: CanonicalBalanceLookup = (token) => (token.toLowerCase() === TOKEN ? 10 : 1)
    const canonicalCurrentPriceLookup: CanonicalCurrentPriceLookup = () => ({ priceUsd: 1, source: 'provider_supplied' })

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, () => null, canonicalBalanceLookup, { canonicalCurrentPriceLookup })

    assert.equal(unrealizedPnlUsd, 5, 'only the reconciled position (1*10-5=5) contributes — the unreconciled one is fully excluded')
    assert.equal(unrealizedReconciliation.reconciledMarketValueUsd, 10, 'reconciledMarketValueUsd sums only reconciled positions')
    assert.equal(unrealizedReconciliation.reconciledCostBasisUsd, 5)
    assert.equal(unrealizedReconciliation.unrealizedCoveragePercent, 50)
  })

  it('7. realized PnL and FIFO lot identities remain unchanged by the canonical price wiring', () => {
    const matchedLots: MatchedLot[] = [
      { lotId: 'closed-1', token: TOKEN, chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 10, costBasisUsd: 10, proceedsUsd: 25, realizedPnlUsd: 15, evidenceQuality: 'verified' },
    ]
    const openLots = [openLot({ amountRemaining: 500, costBasisUsd: 400 })]
    const snapshot = JSON.parse(JSON.stringify(openLots))
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 500

    const withCanonicalPrice = computePnl(matchedLots, openLots, () => null, canonicalBalanceLookup, {
      canonicalCurrentPriceLookup: () => ({ priceUsd: 1.2, source: 'provider_supplied' }),
    })

    assert.equal(withCanonicalPrice.realizedPnlUsd, 15, 'realizedPnlUsd must be unaffected by canonical-price wiring')
    assert.deepEqual(openLots, snapshot, 'open lot identities/quantities must never be mutated')
  })

  it('backward compatible: omitting canonicalCurrentPriceLookup falls back to currentPriceUsdLookup + currentPriceSourceLookup exactly as before', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10

    const { unrealizedPnlUsd, unrealizedReconciliation } = computePnl([], lots, () => 3, canonicalBalanceLookup, {
      currentPriceSourceLookup: () => 'legacy_source',
    })

    assert.equal(unrealizedPnlUsd, 3 * 10 - 5)
    assert.equal(unrealizedReconciliation.reconciledPositionsByPriceSource.legacy_source, 1)
  })
})

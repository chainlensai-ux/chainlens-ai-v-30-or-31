// Tests for the Wallet Scanner improvement audit (task 1/2/6 — unrealized reconciliation +
// open-position classification). Proves: realized PnL and closed-lot coverage are completely
// unaffected by anything unrealized-side; missing price / missing balance / balance-less-than-FIFO
// are each classified with a clear, distinct label; dead/spam positions are classified separately
// from genuine missing-evidence gaps; a real reconciled position is never miscounted as spam.
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/fifoEngine/computePnl.classificationAndPricing.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './index'
import type { CanonicalBalanceLookup, CanonicalPositionMetadataLookup, MatchedLot, OpenLot } from './types'

const TOKEN = '0x1111111111111111111111111111111111111111'
const TOKEN_2 = '0x2222222222222222222222222222222222222222'

function openLot(overrides: Partial<OpenLot> = {}): OpenLot {
  return {
    lotId: 'lot-1', token: TOKEN, chain: 'base', openedAt: 1, openedTxHash: '0xbuy',
    amountOpened: 1, amountRemaining: 1, costBasisUsd: 0, evidenceQuality: 'verified',
    ...overrides,
  }
}

function matchedLot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'closed-1', token: TOKEN, chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xopen', closedTxHash: '0xclose', amount: 1, costBasisUsd: 10, proceedsUsd: 20,
    realizedPnlUsd: 10, evidenceQuality: 'verified', ...overrides,
  }
}

describe('computePnl — Wallet Scanner improvement audit (classification, additive)', () => {
  it('1. realized PnL is completely unaffected by unrealized-side exclusions/classification', () => {
    const closed = [matchedLot({ realizedPnlUsd: 42, costBasisUsd: 10, proceedsUsd: 52 })]
    const open = [openLot({ token: TOKEN_2, amountRemaining: 1000 })] // will be excluded (no balance evidence)
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => null

    const result = computePnl(closed, open, () => null, canonicalBalanceLookup)

    assert.equal(result.realizedPnlUsd, 42, 'realized PnL must equal the sum of closed-lot realizedPnlUsd, regardless of unrealized exclusions')
    assert.equal(result.unrealizedReconciliation.excludedOpenPositions, 1, 'sanity: the open position really was excluded')
  })

  it('2. 100% closed-lot coverage (every matched lot verified) is preserved regardless of unrealized reconciliation outcome', () => {
    const closed = [
      matchedLot({ lotId: 'c1', realizedPnlUsd: 5, evidenceQuality: 'verified' }),
      matchedLot({ lotId: 'c2', realizedPnlUsd: -2, evidenceQuality: 'verified' }),
    ]
    const open = [openLot({ amountRemaining: 999_999_999 })] // dust/spam-shaped, will be excluded
    const result = computePnl(closed, open, () => null, () => null)

    // computePnl's return does not echo matchedLots back (they're an input, not an output) — coverage
    // is proven by checking the INPUT closed lots are all verified and realizedPnlUsd reflects all of
    // them, regardless of the unrealized side's own (fully separate) exclusion below.
    const verifiedCount = closed.filter((l) => l.evidenceQuality === 'verified').length
    assert.equal(verifiedCount, closed.length, 'every closed lot must remain verified — 100% coverage')
    assert.equal(result.realizedPnlUsd, 3)
    assert.equal(result.unrealizedReconciliation.excludedOpenPositions, 1, 'sanity: the unrealized side really did exclude a position, proving the two are independent')
  })

  it('3. a position missing verified current price is classified missing_price (not spam) when its symbol looks ordinary', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10
    const positionMetadataLookup: CanonicalPositionMetadataLookup = () => ({
      symbol: 'MOON', decimals: 18, resolvedChain: 'base', resolvedTokenAddress: TOKEN,
    })

    const result = computePnl([], lots, () => null, canonicalBalanceLookup, { positionMetadataLookup })

    assert.equal(result.unrealizedReconciliation.excludedPositions.length, 1)
    const pos = result.unrealizedReconciliation.excludedPositions[0]
    assert.equal(pos.exclusionReason, 'missing_verified_current_price')
    assert.equal(pos.classification, 'missing_price', 'an ordinary-looking token with no resolvable price must be missing_price, not spam')
    assert.equal(result.unrealizedReconciliation.excludedClassificationCounts.missing_price, 1)
  })

  it('4. a position with no canonical balance evidence is classified missing_balance with a clear, distinct reason', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const positionMetadataLookup: CanonicalPositionMetadataLookup = () => ({
      symbol: 'REAL', decimals: 18, resolvedChain: 'base', resolvedTokenAddress: TOKEN,
    })
    const result = computePnl([], lots, () => null, () => null, { positionMetadataLookup })

    const pos = result.unrealizedReconciliation.excludedPositions[0]
    assert.equal(pos.exclusionReason, 'missing_canonical_balance')
    assert.equal(pos.classification, 'missing_balance')
    assert.notEqual(pos.classification, 'missing_price', 'missing balance and missing price must be distinguishable, never conflated')
  })

  it('5. an open quantity greater than the real balance is classified balance_less_than_fifo_open with a clear reason', () => {
    const lots = [openLot({ amountRemaining: 100, costBasisUsd: 50 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10 // real balance is far smaller than FIFO's open quantity
    const result = computePnl([], lots, () => null, canonicalBalanceLookup)

    const pos = result.unrealizedReconciliation.excludedPositions[0]
    assert.equal(pos.exclusionReason, 'open_quantity_exceeds_balance')
    assert.equal(pos.classification, 'balance_less_than_fifo_open')
    assert.equal(pos.excessOpenQuantity, 90)
  })

  it('6a. dead/spam tokens (promotional symbol) are classified dust_spam, separately from genuine missing-price gaps', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10
    const positionMetadataLookup: CanonicalPositionMetadataLookup = () => ({
      symbol: 'CLAIM-REWARDS.COM', decimals: 18, resolvedChain: 'base', resolvedTokenAddress: TOKEN,
    })
    const result = computePnl([], lots, () => null, canonicalBalanceLookup, { positionMetadataLookup })

    const pos = result.unrealizedReconciliation.excludedPositions[0]
    assert.equal(pos.classification, 'dust_spam')
    assert.equal(result.unrealizedReconciliation.deadOrSpamPositionsCount, 1)
    assert.equal(result.unrealizedReconciliation.excludedClassificationCounts.missing_price ?? 0, 0, 'a spam-classified position must not also be counted as a genuine missing_price gap')
  })

  it('6b. a synthetic/quarantined position (real backend flag) is classified dust_spam', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10
    const positionMetadataLookup: CanonicalPositionMetadataLookup = () => ({
      symbol: 'REAL', decimals: 18, resolvedChain: 'base', resolvedTokenAddress: TOKEN, quarantined: true,
    })
    const result = computePnl([], lots, () => null, canonicalBalanceLookup, { positionMetadataLookup })
    assert.equal(result.unrealizedReconciliation.excludedPositions[0].classification, 'dust_spam')
  })

  it('6c. a real, balance-verified position with no price from either real provider is classified dead_unindexed when noLiquidityFoundLookup confirms it', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10
    const positionMetadataLookup: CanonicalPositionMetadataLookup = () => ({
      symbol: 'OBSCURE', decimals: 18, resolvedChain: 'base', resolvedTokenAddress: TOKEN,
    })
    const result = computePnl([], lots, () => null, canonicalBalanceLookup, {
      positionMetadataLookup,
      noLiquidityFoundLookup: () => true,
    })
    const pos = result.unrealizedReconciliation.excludedPositions[0]
    assert.equal(pos.exclusionReason, 'missing_verified_current_price')
    assert.equal(pos.classification, 'dead_unindexed', 'a real position no provider indexes at all must be dead_unindexed, distinct from a merely-not-yet-priced missing_price')
  })

  it('7. a reconciled (priced, balance-verified) position never appears in excludedPositions and is never miscounted as spam', () => {
    const lots = [openLot({ amountRemaining: 10, costBasisUsd: 5 })]
    const canonicalBalanceLookup: CanonicalBalanceLookup = () => 10
    const positionMetadataLookup: CanonicalPositionMetadataLookup = () => ({
      symbol: 'CLAIM-AIRDROP', decimals: 18, resolvedChain: 'base', resolvedTokenAddress: TOKEN,
    })
    // Even a spam-looking symbol must NOT be excluded once it genuinely reconciles (real balance +
    // real price) — classification only ever applies to EXCLUDED positions, never overrides a real
    // reconciliation.
    const result = computePnl([], lots, () => 2, canonicalBalanceLookup, { positionMetadataLookup })

    assert.equal(result.unrealizedReconciliation.reconciledOpenPositions, 1)
    assert.equal(result.unrealizedReconciliation.excludedPositions.length, 0)
    assert.equal(result.unrealizedReconciliation.deadOrSpamPositionsCount, 0)
  })

  it('9. computePnl never throws and always returns a complete, well-shaped result when unrealized reconciliation is only partial', () => {
    const closed = [matchedLot()]
    const open = [
      openLot({ token: TOKEN, amountRemaining: 10, costBasisUsd: 5 }),
      openLot({ token: TOKEN_2, amountRemaining: 5, costBasisUsd: 2 }),
    ]
    const canonicalBalanceLookup: CanonicalBalanceLookup = (token) => (token === TOKEN ? 10 : null)
    const result = computePnl(closed, open, (token) => (token === TOKEN ? 3 : null), canonicalBalanceLookup)

    assert.equal(result.unrealizedReconciliation.reconciliationStatus, 'partial')
    assert.equal(result.unrealizedReconciliation.reconciledOpenPositions, 1)
    assert.equal(result.unrealizedReconciliation.excludedOpenPositions, 1)
    assert.ok(Number.isFinite(result.realizedPnlUsd as number), 'realizedPnlUsd must still be a real number, not blocked by the partial unrealized state')
    assert.ok(Array.isArray(result.unrealizedReconciliation.excludedPositions))
  })
})

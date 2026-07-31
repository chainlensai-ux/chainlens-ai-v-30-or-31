import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectCanonicalPricedFifo, selectCanonicalMatchedLots } from './selectCanonicalPricedFifo'
import { adaptFifoMatchedLots } from '../../lib/engine/modules/smartMoney/adaptFifoMatchedLots'
import { computeVerifiedWinLoss } from '../../app/frontend/lib/walletPersonality'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'

const DAY = 86_400_000
const NOW = Date.now()

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: `lot-${Math.random()}`, token: '0xtoken', chain: 'base',
    openedAt: NOW - 10 * DAY, closedAt: NOW - 5 * DAY,
    openedTxHash: '0xopen', closedTxHash: `0xclose-${Math.random()}`,
    amount: 1, costBasisUsd: 100, proceedsUsd: 120, realizedPnlUsd: 20,
    evidenceQuality: 'verified',
    ...overrides,
  }
}

function fifoOutput(matchedLots: MatchedLot[]): FifoOutput {
  return {
    matchedLots, unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: null, unrealizedPnlUsd: null,
    costBasisUsd: null, publicPnlStatus: 'unavailable',
    integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
    unrealizedPnlExcludedTokens: [],
    unrealizedReconciliation: {
      totalOpenPositions: 0, reconciledOpenPositions: 0, excludedOpenPositions: 0,
      excludedCandidateMarketValueUsd: 0, excludedCandidateUnrealizedPnlUsd: 0, officialUnrealizedPnlUsd: null,
      reconciliationStatus: 'not_reconciled', excludedPositions: [], reconciledPositionsByPriceSource: {},
      excludedReasonCounts: {}, reconciledMarketValueUsd: 0, reconciledCostBasisUsd: 0, unrealizedCoveragePercent: 0,
    },
  }
}

test('unavailable finalized data returns null, not a fabricated zero', () => {
  assert.equal(selectCanonicalPricedFifo(undefined), null)
  assert.equal(selectCanonicalPricedFifo(null), null)
  assert.equal(selectCanonicalPricedFifo({}), null)
  assert.equal(selectCanonicalMatchedLots(undefined), null)
  assert.equal(selectCanonicalMatchedLots({ canonicalPricedFifo: null }), null)
})

test('a genuinely empty (zero-lot) finalized snapshot is returned as a real empty array, distinct from unavailable', () => {
  const report = { canonicalPricedFifo: fifoOutput([]) }
  assert.deepEqual(selectCanonicalMatchedLots(report), [])
  assert.notEqual(selectCanonicalMatchedLots(report), null)
})

test('stale 207-lot fifoAndPnl-shaped field cannot override the finalized 219-lot canonicalPricedFifo snapshot', () => {
  const staleLots = Array.from({ length: 207 }, () => lot({ evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }))
  const finalizedLots = [
    ...Array.from({ length: 10 }, () => lot({ evidenceQuality: 'verified' })),
    ...Array.from({ length: 209 }, () => lot({ evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null })),
  ]
  // A report shaped like the real serialized response: an OLD/stale `fifoAndPnl`-alike field
  // alongside the real, explicit `canonicalPricedFifo` field. The selector must only ever consult
  // the latter, regardless of what any other field on the object claims.
  const report = {
    fifoAndPnl: fifoOutput(staleLots),
    canonicalPricedFifo: fifoOutput(finalizedLots),
  }
  const selected = selectCanonicalMatchedLots(report)
  assert.equal(selected!.length, 219)
  assert.notEqual(selected!.length, 207)
})

test('pre-pricing/structural lots have 0 verified, but the finalized snapshot has 10 verified — proving the selector picks the priced result', () => {
  const prePricingLots = Array.from({ length: 219 }, () => lot({ evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }))
  const finalizedLots = [
    ...Array.from({ length: 10 }, () => lot({ evidenceQuality: 'verified' })),
    ...Array.from({ length: 209 }, () => lot({ evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null })),
  ]
  const prePricingVerified = prePricingLots.filter((l) => l.evidenceQuality === 'verified').length
  assert.equal(prePricingVerified, 0)

  const report = { canonicalPricedFifo: fifoOutput(finalizedLots) }
  const selected = selectCanonicalMatchedLots(report)!
  const finalizedVerified = selected.filter((l) => l.evidenceQuality === 'verified').length
  assert.equal(finalizedVerified, 10)
})

test('Smart Money selects the finalized lots via the shared selector, and its denominator matches the shared structural count', () => {
  const finalizedLots = [
    ...Array.from({ length: 10 }, () => lot({ evidenceQuality: 'verified' })),
    ...Array.from({ length: 209 }, () => lot({ evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null })),
  ]
  const report = { canonicalPricedFifo: fifoOutput(finalizedLots) }
  const selected = selectCanonicalMatchedLots(report)
  const adapted = adaptFifoMatchedLots(selected)
  assert.equal(adapted!.verifiedTrades.length, 10)
  assert.equal(adapted!.structuralClosedLotCount, 219)
})

test('PnL evidence panel (Wallet Personality) and Smart Money verified counts/coverage remain identical for the same scan', () => {
  const finalizedLots = [
    ...Array.from({ length: 10 }, () => lot({ evidenceQuality: 'verified' })),
    ...Array.from({ length: 209 }, () => lot({ evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null })),
  ]
  const report = { canonicalPricedFifo: fifoOutput(finalizedLots) }
  const selected = selectCanonicalMatchedLots(report)!

  // Wallet Personality's own verified-trade computation.
  const { evaluated: pnlUiEvaluated } = computeVerifiedWinLoss(selected)
  // Smart Money's own verified-trade computation, via the adapter.
  const adapted = adaptFifoMatchedLots(selected)!

  assert.equal(pnlUiEvaluated, adapted.verifiedTrades.length)
  const pnlUiCoverage = (pnlUiEvaluated / selected.length) * 100
  const smartMoneyCoverage = (adapted.verifiedTrades.length / adapted.structuralClosedLotCount) * 100
  assert.equal(pnlUiCoverage, smartMoneyCoverage)
})

test('denominator matches the public PnL selector: both read matchedLots.length off the identical canonicalPricedFifo object', () => {
  const finalizedLots = Array.from({ length: 219 }, () => lot())
  const report = { canonicalPricedFifo: fifoOutput(finalizedLots) }
  const fifo = selectCanonicalPricedFifo(report)!
  const adapted = adaptFifoMatchedLots(selectCanonicalMatchedLots(report))!
  assert.equal(fifo.matchedLots.length, adapted.structuralClosedLotCount)
})

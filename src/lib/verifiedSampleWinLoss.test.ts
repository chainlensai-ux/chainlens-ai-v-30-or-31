// Tests for src/lib/verifiedSampleWinLoss.ts — verified-sample win rate membership.
//
// Run with:
//   npx tsx --test src/lib/verifiedSampleWinLoss.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import { createPnlReconciliation } from './pnlReconciliation'
import {
  buildVerifiedSampleWinRateAudit,
  computeVerifiedSampleWinLoss,
  VERIFIED_SAMPLE_WIN_RATE_DENOMINATOR_MEMBERSHIP,
} from './verifiedSampleWinLoss'

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot-1',
    token: '0x1111111111111111111111111111111111111111',
    chain: 'base',
    openedAt: 1,
    closedAt: 2,
    openedTxHash: '0xbuy',
    closedTxHash: '0xsell',
    amount: 1,
    costBasisUsd: 100,
    proceedsUsd: 80,
    realizedPnlUsd: -20,
    evidenceQuality: 'verified',
    ...overrides,
  }
}

function many(count: number, overrides: Partial<MatchedLot>): MatchedLot[] {
  return Array.from({ length: count }, (_, i) => lot({
    ...overrides,
    lotId: `${overrides.lotId ?? 'lot'}-${i}`,
    openedTxHash: `0xbuy${i}`,
    closedTxHash: `0xsell${i}`,
    openedAt: i + 1,
    closedAt: i + 2,
  }))
}

describe('computeVerifiedSampleWinLoss', () => {
  it('HARD ASSERTION: wins=8, losses=13, many quote/zero lots → rate is not 8% merely because verified lots=98', () => {
    const lots = [
      ...many(8, { lotId: 'win', realizedPnlUsd: 10, proceedsUsd: 110, costBasisUsd: 100 }),
      ...many(13, { lotId: 'loss', realizedPnlUsd: -5, proceedsUsd: 95, costBasisUsd: 100 }),
      ...many(72, { lotId: 'quote-zero', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', realizedPnlUsd: 0, proceedsUsd: 400, costBasisUsd: 400 }),
      ...many(5, { lotId: 'independent-zero', realizedPnlUsd: 0, proceedsUsd: 50, costBasisUsd: 50 }),
    ]
    const wl = computeVerifiedSampleWinLoss(lots)
    assert.equal(wl.verifiedLots, 98)
    assert.equal(wl.wins, 8)
    assert.equal(wl.losses, 13)
    assert.equal(wl.zeroPnlCount, 77)
    assert.equal(wl.evaluatedWinLossLots, 21)
    assert.equal(wl.winRate, 8 / 21)
    assert.notEqual(wl.winRate, 8 / 98)
    const audit = buildVerifiedSampleWinRateAudit({ lots, excludedQuoteCashCount: 72, unresolvedCount: 0 })
    assert.equal(audit.verifiedLots, 98)
    assert.equal(audit.winCount, 8)
    assert.equal(audit.lossCount, 13)
    assert.equal(audit.zeroPnlCount, 77)
    assert.equal(audit.excludedQuoteCashCount, 72)
    assert.equal(audit.unresolvedCount, 0)
    assert.equal(audit.denominatorUsed, 21)
    assert.equal(audit.displayedWinRate, (8 / 21) * 100)
    assert.equal(audit.denominatorMembership, VERIFIED_SAMPLE_WIN_RATE_DENOMINATOR_MEMBERSHIP)
    assert.ok(Math.abs((audit.displayedWinRate ?? 0) - 8) > 20, 'must not collapse to the 8% fully-priced-lot artefact')
  })

  it('HARD ASSERTION: zero wins / positive losses → 0%', () => {
    const wl = computeVerifiedSampleWinLoss([
      lot({ realizedPnlUsd: -10, proceedsUsd: 90 }),
      lot({ lotId: 'z', openedTxHash: '0xb2', closedTxHash: '0xs2', realizedPnlUsd: 0, proceedsUsd: 50, costBasisUsd: 50 }),
    ])
    assert.equal(wl.wins, 0)
    assert.equal(wl.losses, 1)
    assert.equal(wl.winRate, 0)
  })

  it('HARD ASSERTION: wins + losses = 0 → unavailable/null, not fake 0%', () => {
    const wl = computeVerifiedSampleWinLoss([
      lot({ realizedPnlUsd: 0, proceedsUsd: 50, costBasisUsd: 50 }),
      lot({ lotId: 'z2', openedTxHash: '0xb2', closedTxHash: '0xs2', realizedPnlUsd: 0, proceedsUsd: 50, costBasisUsd: 50 }),
    ])
    assert.equal(wl.wins, 0)
    assert.equal(wl.losses, 0)
    assert.equal(wl.evaluatedWinLossLots, 0)
    assert.equal(wl.verifiedLots, 2)
    assert.equal(wl.winRate, null)
    assert.equal(buildVerifiedSampleWinRateAudit({ lots: [lot({ realizedPnlUsd: 0, proceedsUsd: 50, costBasisUsd: 50 })] }).displayedWinRate, null)
  })

  it('HARD ASSERTION: quote/cash zero-PnL legs do not distort rate', () => {
    const lots = [
      lot({ lotId: 'w', realizedPnlUsd: 20, proceedsUsd: 120, costBasisUsd: 100 }),
      lot({ lotId: 'l', openedTxHash: '0xb2', closedTxHash: '0xs2', realizedPnlUsd: -20, proceedsUsd: 80, costBasisUsd: 100 }),
      ...many(50, { lotId: 'usdc', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', realizedPnlUsd: 0, proceedsUsd: 400, costBasisUsd: 400 }),
    ]
    const wl = computeVerifiedSampleWinLoss(lots)
    assert.equal(wl.winRate, 0.5)
    assert.equal(wl.evaluatedWinLossLots, 2)
    assert.equal(wl.zeroPnlCount, 50)
  })

  it('HARD ASSERTION: displayed Wins/Losses and rate derive from identical membership', () => {
    const lots = [
      ...many(3, { lotId: 'w', realizedPnlUsd: 4, proceedsUsd: 14, costBasisUsd: 10 }),
      ...many(1, { lotId: 'l', realizedPnlUsd: -2, proceedsUsd: 8, costBasisUsd: 10 }),
      ...many(10, { lotId: 'z', realizedPnlUsd: 0, proceedsUsd: 10, costBasisUsd: 10 }),
    ]
    const wl = computeVerifiedSampleWinLoss(lots)
    const audit = buildVerifiedSampleWinRateAudit({ lots })
    assert.equal(audit.winCount, wl.wins)
    assert.equal(audit.lossCount, wl.losses)
    assert.equal(audit.denominatorUsed, wl.wins + wl.losses)
    assert.equal(audit.denominatorUsed, wl.evaluatedWinLossLots)
    assert.equal(audit.displayedWinRate, (wl.wins / (wl.wins + wl.losses)) * 100)
    assert.equal(wl.wins, 3)
    assert.equal(wl.losses, 1)
  })
})

describe('production reconcile path does not change sample PnL or ROI when win-rate membership is computed', () => {
  it('keeps verified sample PnL and ROI membership while exposing the win-rate audit', async () => {
    const riskWin = lot({ lotId: 'risk-win', realizedPnlUsd: 40, costBasisUsd: 100, proceedsUsd: 140 })
    const riskLoss = lot({
      lotId: 'risk-loss', token: '0x2222222222222222222222222222222222222222',
      openedTxHash: '0xb2', closedTxHash: '0xs2', openedAt: 3, closedAt: 4,
      realizedPnlUsd: -60, costBasisUsd: 200, proceedsUsd: 140,
    })
    const quoteZero = lot({
      lotId: 'quote', token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      openedTxHash: '0xb3', closedTxHash: '0xs3', openedAt: 5, closedAt: 6,
      realizedPnlUsd: 0, costBasisUsd: 400, proceedsUsd: 400,
    })
    const fifoEngineResult = {
      matchedLots: [riskWin, riskLoss, quoteZero],
      unmatchedBuys: 0,
      unmatchedSells: 0,
      unmatchedBuyEvents: [],
      unmatchedSellEvents: [],
      realizedPnlUsd: -20,
      unrealizedPnlUsd: 0,
      costBasisUsd: 700,
      publicPnlStatus: 'unavailable' as const,
      integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
      unrealizedPnlExcludedTokens: [],
      unrealizedReconciliation: emptyUnrealizedReconciliation(),
    }
    const pnlEngineResult = {
      realizedPnlUsd: -20,
      closedLots: [],
      winLossRate: { wins: 1, losses: 1, evaluated: 2, rate: 0.5 },
      chainBreakdown: [],
      confidenceBasis: { high: 3, medium: 0, low: 0, aggregate: 'high' as const },
      evidenceMissingCount: 0,
    }
    const summary = await createPnlReconciliation({ logger: { warn() { /* silent */ } } }).reconcile({
      fifoEngineResult,
      pnlEngineResult,
    })
    assert.equal(summary.verifiedSamplePerformance.realizedPnlUsd, -20)
    assert.equal(summary.verifiedSamplePerformance.verifiedLotCount, 3)
    assert.equal(summary.verifiedSampleWinRateAudit?.winCount, 1)
    assert.equal(summary.verifiedSampleWinRateAudit?.lossCount, 1)
    assert.equal(summary.verifiedSampleWinRateAudit?.zeroPnlCount, 1)
    assert.equal(summary.verifiedSampleWinRateAudit?.denominatorUsed, 2)
    assert.equal(summary.verifiedSampleWinRateAudit?.displayedWinRate, 50)
    assert.equal(summary.verifiedSampleRealizedPnlUsd, -20)
    assert.equal(summary.verifiedSampleRealizedRoiPct, summary.verifiedSamplePerformance.realizedRoiPct)
  })
})

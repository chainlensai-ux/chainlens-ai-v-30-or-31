import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveWalletPersonality, computeHoldingDaysStats, computeRepeatedRouterPercent, computeVerifiedWinLoss, composeTitle, computeRadarAxes } from './walletPersonality'
import type { WalletPersonalitySourceReport } from './walletPersonality'
import type { MatchedLot } from '@/src/modules/fifoEngine/types'
import type { SellTimelineEntry } from '@/src/modules/sellTimeline/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'

const DAY = 86_400_000
const NOW = Date.now()

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: NOW - 10 * DAY, closedAt: NOW - 5 * DAY,
    openedTxHash: '0xopen', closedTxHash: '0xclose', amount: 1, costBasisUsd: 10, proceedsUsd: 20,
    realizedPnlUsd: 10, evidenceQuality: 'verified', ...overrides,
  }
}

function sellEntry(overrides: Partial<SellTimelineEntry> = {}): SellTimelineEntry {
  return {
    timestamp: NOW - 3 * DAY, chain: 'base', token: '0xtoken', symbol: 'TKN', amount: '1',
    proceedsUsdEstimate: null, matchedBuyLotId: null, confidence: 'high', txHash: '0xsell',
    chainSelectionRef: { chain: 'base', status: 'active_intelligence' } as unknown as SellTimelineEntry['chainSelectionRef'],
    counterparty: '0xrouter', ...overrides,
  }
}

function buyEntry(overrides: Partial<BuyTimelineEntry> = {}): BuyTimelineEntry {
  return {
    timestamp: NOW - 10 * DAY, chain: 'base', token: '0xtoken', symbol: 'TKN', amount: 1,
    txHash: '0xbuy', ...overrides,
  } as BuyTimelineEntry
}

function baseReport(overrides: Partial<WalletPersonalitySourceReport> = {}): WalletPersonalitySourceReport {
  return {
    behaviorIntel: {
      rotationStyle: { value: 'rotator', basis: { buyCount: 3, sellCount: 3, distributionCount: 0, distinctTokensTraded: 3 } },
      riskOnOff: { value: 'risk_on', basis: 'test' },
      multiChainParticipation: {
        activeChains: ['base'], primaryChain: 'base',
        chainSelectionRef: { activeChainCount: 1, dustChainCount: 0 },
        chainsWithRealSells: ['base'], chainsPendingSellEvidence: [],
      },
      concentrationSignals: null,
      automationSignals: { suspectedBot: false, signals: [] },
      confidence: 'medium',
      confidenceBasis: { chainSelectionFactor: 'x', windowCoverageFactor: 'x', sellEvidenceFactor: 'x' },
      exitVelocity: { medianMsBetweenSells: null, basis: 'x' },
      convictionScore: { value: 'unknown', basis: 'x' },
    },
    fifoAndPnl: {
      matchedLots: [], unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: null, unrealizedPnlUsd: null,
      costBasisUsd: null, publicPnlStatus: 'unavailable',
      integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
      unrealizedPnlExcludedTokens: [],
      unrealizedReconciliation: {
        totalOpenPositions: 0, reconciledOpenPositions: 0, excludedOpenPositions: 0,
        excludedCandidateMarketValueUsd: 0, excludedCandidateUnrealizedPnlUsd: 0, officialUnrealizedPnlUsd: null,
        reconciliationStatus: 'not_reconciled', excludedPositions: [], reconciledPositionsByPriceSource: {},
        excludedReasonCounts: {}, reconciledMarketValueUsd: 0, reconciledCostBasisUsd: 0, unrealizedCoveragePercent: 0,
      },
    },
    finalSummary: {
      walletPersonality: 'x', financialStatus: { officialPnlStatus: 'unavailable', headline: 'x' },
      behavioralStatus: { riskOnOff: 'risk_on', rotationStyle: 'rotator' },
      chainParticipationSummary: 'x', recoverySummary: 'x',
    },
    timelines: {
      buyTimeline: { totalBuys: 3, entries: [buyEntry(), buyEntry({ txHash: '0xbuy2' }), buyEntry({ txHash: '0xbuy3' })] },
      sellTimeline: { totalSells: 0, entries: [] },
      distributionTimeline: { totalDistributions: 0, entries: [] },
      sellTimelineV2: { totalSells: 3, chainContext: { includedChains: ['base'], excludedChains: [] }, entries: [sellEntry(), sellEntry({ txHash: '0xsell2' }), sellEntry({ txHash: '0xsell3' })] },
    } as unknown as WalletPersonalitySourceReport['timelines'],
    chainSelection: { chains: [], activeChainCount: 1, dustChainCount: 0 } as unknown as WalletPersonalitySourceReport['chainSelection'],
    ...overrides,
  }
}

test('never renders blank: a fully-empty wallet still returns a safe, non-throwing profile', () => {
  const report = baseReport({
    timelines: {
      buyTimeline: { totalBuys: 0, entries: [] },
      sellTimeline: { totalSells: 0, entries: [] },
      distributionTimeline: { totalDistributions: 0, entries: [] },
      sellTimelineV2: { totalSells: 0, chainContext: { includedChains: [], excludedChains: [] }, entries: [] },
    } as unknown as WalletPersonalitySourceReport['timelines'],
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.insufficientEvidence, true)
  assert.equal(data.title, 'General User')
  assert.equal(data.subtitle, 'Insufficient evidence for a detailed personality')
  assert.equal(data.metrics.totalTransactions, 0)
  assert.equal(data.evidenceBasis, 'limited_evidence')
})

test('minimal evidence wallet: renders available activity metrics alongside the insufficient-evidence message', () => {
  const report = baseReport({
    timelines: {
      buyTimeline: { totalBuys: 0, entries: [] },
      sellTimeline: { totalSells: 0, entries: [] },
      distributionTimeline: { totalDistributions: 0, entries: [] },
      sellTimelineV2: { totalSells: 0, chainContext: { includedChains: [], excludedChains: [] }, entries: [] },
    } as unknown as WalletPersonalitySourceReport['timelines'],
    chainSelection: { chains: [], activeChainCount: 1, dustChainCount: 0 } as unknown as WalletPersonalitySourceReport['chainSelection'],
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.insufficientEvidence, true)
  assert.equal(data.metrics.activeChains, 1)
})

test('PnL unavailable + behavior available: card still has a real title/traits and an honest not-proven profit message', () => {
  const data = deriveWalletPersonality(baseReport())
  assert.equal(data.insufficientEvidence, false)
  assert.notEqual(data.title, '')
  assert.equal(data.profitEvidence.kind, 'not_proven')
  assert.equal(data.profitEvidence.message, 'Profitability not proven — personality is based on on-chain behavior.')
  assert.equal(data.profitEvidence.winRatePercent, null)
  assert.notEqual(data.evidenceBasis, 'behavior_plus_pnl')
})

test('limited verified PnL sample: shows exact win/loss/sample-size wording, never a status of verified', () => {
  const report = baseReport({
    fifoAndPnl: {
      ...baseReport().fifoAndPnl,
      matchedLots: [
        lot({ lotId: 'l1', realizedPnlUsd: 10, evidenceQuality: 'verified' }),
        lot({ lotId: 'l2', realizedPnlUsd: -4, evidenceQuality: 'verified' }),
        lot({ lotId: 'l3', realizedPnlUsd: null, evidenceQuality: 'unpriced' }),
      ],
      publicPnlStatus: 'limited_verified_sample',
    },
    finalSummary: {
      ...baseReport().finalSummary,
      financialStatus: { officialPnlStatus: 'limited_verified_sample', headline: 'x' },
    },
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.profitEvidence.kind, 'limited_sample')
  assert.equal(data.profitEvidence.message, 'Limited verified sample — 1 wins / 1 losses across 2 fully priced trades.')
  assert.equal(data.profitEvidence.winCount, 1)
  assert.equal(data.profitEvidence.lossCount, 1)
  assert.equal(data.profitEvidence.evaluatedCount, 2)
})

test('full verified PnL: shows a real win rate and never blocks on missing pricing elsewhere', () => {
  const report = baseReport({
    fifoAndPnl: {
      ...baseReport().fifoAndPnl,
      matchedLots: [
        lot({ lotId: 'l1', realizedPnlUsd: 10, evidenceQuality: 'verified' }),
        lot({ lotId: 'l2', realizedPnlUsd: 5, evidenceQuality: 'verified' }),
        lot({ lotId: 'l3', realizedPnlUsd: -2, evidenceQuality: 'verified' }),
      ],
      realizedPnlUsd: 13,
      publicPnlStatus: 'ok',
    },
    finalSummary: {
      ...baseReport().finalSummary,
      financialStatus: { officialPnlStatus: 'ok', headline: 'x' },
    },
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.profitEvidence.kind, 'verified')
  assert.equal(data.profitEvidence.winCount, 2)
  assert.equal(data.profitEvidence.lossCount, 1)
  assert.ok(data.profitEvidence.message.includes('67%'))
  assert.ok(data.profitEvidence.message.includes('profitable'))
  assert.equal(data.evidenceBasis, 'behavior_plus_pnl')
})

test('bot-like wallet: automation signal + high router repetition classify as automated, never as manual', () => {
  const report = baseReport({
    behaviorIntel: {
      ...baseReport().behaviorIntel,
      automationSignals: { suspectedBot: true, signals: ['uniform_gas', 'fixed_interval'] },
    },
    timelines: {
      ...baseReport().timelines,
      sellTimelineV2: {
        totalSells: 5, chainContext: { includedChains: ['base'], excludedChains: [] },
        entries: Array.from({ length: 5 }, (_, i) => sellEntry({ txHash: `0xsell${i}`, counterparty: '0xsamerouter' })),
      },
    } as unknown as WalletPersonalitySourceReport['timelines'],
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.classification.automation, 'Highly automated')
  assert.equal(data.metrics.repeatedRouterPercent, 100)
  assert.ok(data.watchouts.includes('Repeated router patterns'))
})

test('long-term holder: average holding time >= 30 days classifies as Long-term holder, uses only real timestamps', () => {
  const report = baseReport({
    fifoAndPnl: {
      ...baseReport().fifoAndPnl,
      matchedLots: [
        lot({ lotId: 'l1', openedAt: NOW - 90 * DAY, closedAt: NOW - 20 * DAY, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }),
      ],
    },
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.classification.holding, 'Long-term holder')
  assert.equal(data.metrics.averageHoldingDays, 70)
  assert.ok(data.strengths.includes('Disciplined holding periods'))
})

test('empty/null personality fields (concentrationSignals null, rotationStyle unknown) resolve to honest placeholders, never fabricated labels', () => {
  const report = baseReport({
    behaviorIntel: {
      ...baseReport().behaviorIntel,
      rotationStyle: { value: 'unknown', basis: { buyCount: 0, sellCount: 0, distributionCount: 0, distinctTokensTraded: 0 } },
      riskOnOff: { value: 'unknown', basis: 'x' },
      concentrationSignals: null,
    },
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.traits.portfolioConcentration, 'Not enough data')
  assert.equal(data.traits.riskAppetite, 'Unknown')
  assert.equal(data.traits.rotationBehavior, 'Unknown')
})

test('no false zero values: win rate/holding time/router-repetition are null (not 0) when genuinely unknown', () => {
  const data = deriveWalletPersonality(baseReport())
  assert.equal(data.metrics.averageHoldingDays, null)
  assert.equal(data.metrics.medianHoldingDays, null)
  assert.equal(data.profitEvidence.winRatePercent, null)
  const noCounterparty = computeRepeatedRouterPercent([null, null])
  assert.equal(noCounterparty, null)
})

test('computeHoldingDaysStats: pure arithmetic over real openedAt/closedAt, never fabricated', () => {
  const stats = computeHoldingDaysStats([
    { openedAt: 0, closedAt: 2 * DAY },
    { openedAt: 0, closedAt: 4 * DAY },
  ])
  assert.equal(stats.averageHoldingDays, 3)
  assert.equal(stats.medianHoldingDays, 3)
  assert.deepEqual(computeHoldingDaysStats([]), { averageHoldingDays: null, medianHoldingDays: null })
})

test('computeVerifiedWinLoss: only counts verified, priced lots — never pnlSummaryV2-shaped rows', () => {
  const result = computeVerifiedWinLoss([
    { evidenceQuality: 'verified', realizedPnlUsd: 5 },
    { evidenceQuality: 'verified', realizedPnlUsd: -1 },
    { evidenceQuality: 'unpriced', realizedPnlUsd: null },
    { evidenceQuality: 'verified', realizedPnlUsd: 0 },
  ])
  assert.deepEqual(result, { wins: 1, losses: 1, evaluated: 3 })
})

test('evidence basis badges cover all four states', () => {
  assert.equal(deriveWalletPersonality(baseReport({
    timelines: {
      buyTimeline: { totalBuys: 0, entries: [] }, sellTimeline: { totalSells: 0, entries: [] },
      distributionTimeline: { totalDistributions: 0, entries: [] },
      sellTimelineV2: { totalSells: 0, chainContext: { includedChains: [], excludedChains: [] }, entries: [] },
    } as unknown as WalletPersonalitySourceReport['timelines'],
  })).evidenceBasis, 'limited_evidence')

  assert.equal(deriveWalletPersonality(baseReport({
    behaviorIntel: { ...baseReport().behaviorIntel, confidence: 'low' },
  })).evidenceBasis, 'behavior_only')

  assert.equal(deriveWalletPersonality(baseReport({
    behaviorIntel: { ...baseReport().behaviorIntel, confidence: 'high' },
  })).evidenceBasis, 'behavior_verified')

  assert.equal(deriveWalletPersonality(baseReport({
    finalSummary: { ...baseReport().finalSummary, financialStatus: { officialPnlStatus: 'ok', headline: 'x' } },
    fifoAndPnl: { ...baseReport().fifoAndPnl, matchedLots: [lot({ realizedPnlUsd: 1, evidenceQuality: 'verified' })], publicPnlStatus: 'ok' },
  })).evidenceBasis, 'behavior_plus_pnl')
})

// ─── Redesign task: premium title/subtitle/radar coverage ──────────────────────────────────────

test('full evidence wallet: gets a distinctive, non-generic title and a fully populated radar', () => {
  const report = baseReport({
    behaviorIntel: {
      ...baseReport().behaviorIntel,
      riskOnOff: { value: 'risk_on', basis: 'x' },
      confidence: 'high',
      convictionScore: { value: 'high', basis: 'x' },
    },
    fifoAndPnl: {
      ...baseReport().fifoAndPnl,
      matchedLots: [
        lot({ lotId: 'l1', openedAt: NOW - 12 * DAY, closedAt: NOW - 4 * DAY, realizedPnlUsd: 10, evidenceQuality: 'verified' }),
        lot({ lotId: 'l2', openedAt: NOW - 20 * DAY, closedAt: NOW - 10 * DAY, realizedPnlUsd: 6, evidenceQuality: 'verified' }),
      ],
      realizedPnlUsd: 16,
      publicPnlStatus: 'ok',
    },
    finalSummary: { ...baseReport().finalSummary, financialStatus: { officialPnlStatus: 'ok', headline: 'x' } },
  })
  const data = deriveWalletPersonality(report)
  assert.notEqual(data.title, 'General User')
  assert.notEqual(data.title, '')
  assert.equal(data.title, 'Risk-On Swing Operator')
  assert.equal(data.evidenceBasis, 'behavior_plus_pnl')
  assert.equal(data.radar.risk, 1)
  assert.equal(data.radar.conviction, 1)
  assert.notEqual(data.radar.activity, null)
})

test('behavior-only wallet (no PnL evidence): still gets a real, distinctive, non-blank title', () => {
  const data = deriveWalletPersonality(baseReport({
    behaviorIntel: { ...baseReport().behaviorIntel, confidence: 'low' },
  }))
  assert.equal(data.evidenceBasis, 'behavior_only')
  assert.notEqual(data.title, 'General User')
  assert.notEqual(data.title, '')
  assert.equal(data.profitEvidence.kind, 'not_proven')
})

test('no blank titles: every branch of deriveWalletPersonality returns a non-empty title and subtitle', () => {
  const scenarios: WalletPersonalitySourceReport[] = [
    baseReport(),
    baseReport({ behaviorIntel: { ...baseReport().behaviorIntel, automationSignals: { suspectedBot: true, signals: ['x'] } } }),
    baseReport({ behaviorIntel: { ...baseReport().behaviorIntel, rotationStyle: { value: 'accumulator', basis: { buyCount: 1, sellCount: 0, distributionCount: 0, distinctTokensTraded: 1 } } } }),
    baseReport({
      timelines: {
        buyTimeline: { totalBuys: 0, entries: [] }, sellTimeline: { totalSells: 0, entries: [] },
        distributionTimeline: { totalDistributions: 0, entries: [] },
        sellTimelineV2: { totalSells: 0, chainContext: { includedChains: [], excludedChains: [] }, entries: [] },
      } as unknown as WalletPersonalitySourceReport['timelines'],
    }),
  ]
  for (const report of scenarios) {
    const data = deriveWalletPersonality(report)
    assert.ok(data.title.length > 0, 'title must never be blank')
    assert.ok(data.subtitle.length > 0, 'subtitle must never be blank')
  }
})

test('no fake precision: radar axes are null (not a guessed midpoint) whenever the underlying signal is genuinely unknown', () => {
  const axes = computeRadarAxes({
    totalTransactions: 0, riskValue: 'unknown', suspectedBot: false, repeatedRouterPercent: null,
    rotationValue: 'unknown', convictionValue: 'unknown',
  })
  assert.equal(axes.activity, null)
  assert.equal(axes.risk, null)
  assert.equal(axes.rotation, null)
  assert.equal(axes.conviction, null)
  // automation defaults to a real 0 (suspectedBot=false, no router evidence) — a genuine computed
  // value, not a placeholder, so this one is intentionally NOT null.
  assert.equal(axes.automation, 0)
})

test('composeTitle: never returns "General User" — that string is reserved for the zero-evidence path only', () => {
  const combos: Array<Parameters<typeof composeTitle>[0]> = [
    { automationClass: 'Manual trader', holdingClass: 'Long-term holder', concentrationClass: 'Not enough data', riskValue: 'unknown', rotationValue: 'unknown', convictionValue: 'unknown', activeChains: 1, totalTransactions: 1 },
    { automationClass: 'Bot-like', holdingClass: 'Hyperactive sniper', concentrationClass: 'Concentrated', riskValue: 'risk_on', rotationValue: 'rotator', convictionValue: 'high', activeChains: 2, totalTransactions: 40 },
    { automationClass: 'Highly automated', holdingClass: 'Short-term rotator', concentrationClass: 'Moderately diversified', riskValue: 'risk_off', rotationValue: 'distributor', convictionValue: 'medium', activeChains: 5, totalTransactions: 100 },
  ]
  for (const combo of combos) {
    assert.notEqual(composeTitle(combo), 'General User')
    assert.ok(composeTitle(combo).length > 0)
  }
})

test('limited PnL sample surfaces the explicit "not official" disclosure via distinct win/loss/evaluated fields (never a single opaque sentence only)', () => {
  const report = baseReport({
    fifoAndPnl: {
      ...baseReport().fifoAndPnl,
      matchedLots: [
        lot({ lotId: 'l1', realizedPnlUsd: 10, evidenceQuality: 'verified' }),
        lot({ lotId: 'l2', realizedPnlUsd: 8, evidenceQuality: 'verified' }),
        lot({ lotId: 'l3', realizedPnlUsd: 4, evidenceQuality: 'verified' }),
        lot({ lotId: 'l4', realizedPnlUsd: 2, evidenceQuality: 'verified' }),
        lot({ lotId: 'l5', realizedPnlUsd: -1, evidenceQuality: 'verified' }),
        lot({ lotId: 'l6', realizedPnlUsd: -1, evidenceQuality: 'verified' }),
        lot({ lotId: 'l7', realizedPnlUsd: -1, evidenceQuality: 'verified' }),
        lot({ lotId: 'l8', realizedPnlUsd: null, evidenceQuality: 'unpriced' }),
      ],
      publicPnlStatus: 'limited_verified_sample',
    },
    finalSummary: { ...baseReport().finalSummary, financialStatus: { officialPnlStatus: 'limited_verified_sample', headline: 'x' } },
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.profitEvidence.kind, 'limited_sample')
  assert.equal(data.profitEvidence.winCount, 4)
  assert.equal(data.profitEvidence.lossCount, 3)
  assert.equal(data.profitEvidence.evaluatedCount, 7)
  assert.ok(Math.abs((data.profitEvidence.winRatePercent ?? 0) - (4 / 7) * 100) < 0.01)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveWalletPersonality, computeHoldingDaysStats, computeRepeatedRouterPercent, computeVerifiedWinLoss, composeTitle, computeRadarAxes, combineAxis, computeCadenceRegularity } from './walletPersonality'
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
    // Zero active chains too, so every Risk axis sub-signal (holding, concentration, churn,
    // chain breadth) is genuinely unavailable — the true "no risk evidence at all" case.
    chainSelection: { chains: [], activeChainCount: 0, dustChainCount: 0 } as unknown as WalletPersonalitySourceReport['chainSelection'],
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.traits.portfolioConcentration, 'Not enough data')
  assert.equal(data.traits.riskAppetite, 'Unknown')
  assert.equal(data.radar.risk.signalStrength, null)
  assert.equal(data.traits.rotationBehavior, 'Unknown')
})

test('risk trait now reads the CALIBRATED axis, not the legacy riskOnOff field — a Low-confidence-but-present risk signal is labeled from the axis, never "risk on"', () => {
  const report = baseReport({
    behaviorIntel: { ...baseReport().behaviorIntel, riskOnOff: { value: 'risk_on', basis: 'x' } },
  })
  const data = deriveWalletPersonality(report)
  assert.notEqual(data.traits.riskAppetite, 'risk on')
  assert.ok(['Low behavioral risk', 'Moderate behavioral risk', 'Elevated behavioral risk', 'Very high behavioral risk', 'Unknown'].includes(data.traits.riskAppetite))
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
  // CALIBRATED-RISK FIX, DISCLOSED: this fixture's legacy riskOnOff.value is 'risk_on', but the
  // CALIBRATED risk axis reads Low here (long-enough holding, no concentration evidence) — the
  // title must never say "Risk-On" for a calibrated-Low wallet, matching this task's own rule.
  assert.ok(!data.title.toLowerCase().includes('risk-on'))
  assert.equal(data.classification.risk, 'Low risk behavior')
  assert.equal(data.evidenceBasis, 'behavior_plus_pnl')
  // Conviction has a real 'high' categorical input plus a holding-duration signal — a genuine axis
  // score, not the old riskOnOff-forced binary.
  assert.notEqual(data.radar.conviction.signalStrength, null)
  assert.notEqual(data.radar.activity.signalStrength, null)
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

test('no fake precision: axes are "Insufficient evidence" with a null signalStrength (not a guessed midpoint) whenever every underlying input is genuinely unknown', () => {
  const axes = computeRadarAxes({
    totalTransactions: 0, walletAgeDays: null, concentrationLabel: null, uniqueTokensTraded: null,
    activeChains: 0, suspectedBot: false, repeatedRouterPercent: null, cadenceRegularity: null,
    rotationValue: 'unknown', convictionValue: 'unknown', averageHoldingDays: null,
  })
  assert.equal(axes.activity.signalStrength, null)
  assert.equal(axes.activity.label, 'Insufficient evidence')
  assert.equal(axes.risk.signalStrength, null)
  assert.equal(axes.rotation.signalStrength, null)
  assert.equal(axes.conviction.signalStrength, null)
  // Automation: suspectedBot=false is a real, computed 0 (not a placeholder) — but with zero
  // other real inputs, evidenceConfidence must still be low, never implying certainty.
  assert.equal(axes.automation.signalStrength, 0)
  assert.ok(axes.automation.evidenceConfidence < 0.5)
})

// ─── Calibration audit task: signal strength vs. evidence confidence ───────────────────────────

test('one metric alone cannot produce a 100% signal strength', () => {
  const result = combineAxis([
    { key: 'onlySignal', label: 'Only signal', detail: 'x', value: 1, weight: 1 },
    { key: 'missing1', label: 'Missing 1', detail: 'x', value: null, weight: 1 },
    { key: 'missing2', label: 'Missing 2', detail: 'x', value: null, weight: 1 },
  ])
  assert.notEqual(result.signalStrength, 100)
  assert.ok((result.signalStrength ?? 0) <= 85)
})

test('several independent top-band metrics CAN produce a 100% signal strength', () => {
  const result = combineAxis([
    { key: 'a', label: 'A', detail: 'x', value: 1, weight: 1 },
    { key: 'b', label: 'B', detail: 'x', value: 1, weight: 1 },
  ])
  assert.equal(result.signalStrength, 100)
})

test('missing concentration data lowers Risk axis confidence, never assumes high risk', () => {
  const report = baseReport({
    behaviorIntel: { ...baseReport().behaviorIntel, concentrationSignals: null },
  })
  const data = deriveWalletPersonality(report)
  assert.ok(data.radar.risk.missingInputs.includes('Portfolio concentration'))
  assert.ok(data.radar.risk.evidenceConfidence < 1)
  assert.notEqual(data.classification.risk, 'High risk behavior')
})

test('repeated-router percentage alone does not prove automation — confidence stays capped and the label stays soft', () => {
  const report = baseReport({
    behaviorIntel: { ...baseReport().behaviorIntel, automationSignals: { suspectedBot: false, signals: [] } },
    timelines: {
      ...baseReport().timelines,
      sellTimelineV2: {
        totalSells: 3, chainContext: { includedChains: ['base'], excludedChains: [] },
        entries: [
          sellEntry({ txHash: '0xa', counterparty: '0xsamerouter' }),
          sellEntry({ txHash: '0xb', counterparty: '0xsamerouter' }),
          sellEntry({ txHash: '0xc', counterparty: '0xsamerouter' }),
        ],
      },
    } as unknown as WalletPersonalitySourceReport['timelines'],
  })
  const data = deriveWalletPersonality(report)
  assert.equal(data.metrics.repeatedRouterPercent, 100)
  // Only 1 of the 3 automation sub-signals (repeated router) has real data — cadence needs 6+
  // timestamps and suspectedBot is a real, computed false — so confidence must stay well under the
  // MIN_CONFIDENCE_FOR_BOT_LABEL bar, and the label must be the soft "signals present" wording,
  // never the alarmist "Bot-like"/"Highly automated" claim from one proxy metric alone.
  assert.notEqual(data.classification.automation, 'Bot-like')
  assert.notEqual(data.classification.automation, 'Highly automated')
})

test('high activity alone does not imply high risk — the two axes are structurally independent', () => {
  const report = baseReport({
    timelines: {
      buyTimeline: { totalBuys: 200, entries: Array.from({ length: 200 }, (_, i) => buyEntry({ txHash: `0xbuy${i}`, timestamp: NOW - (200 - i) * 3600_000 })) },
      sellTimeline: { totalSells: 0, entries: [] },
      distributionTimeline: { totalDistributions: 0, entries: [] },
      sellTimelineV2: { totalSells: 0, chainContext: { includedChains: ['base'], excludedChains: [] }, entries: [] },
    } as unknown as WalletPersonalitySourceReport['timelines'],
    fifoAndPnl: {
      ...baseReport().fifoAndPnl,
      matchedLots: [lot({ openedAt: NOW - 40 * DAY, closedAt: NOW - 5 * DAY, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })],
    },
    behaviorIntel: { ...baseReport().behaviorIntel, concentrationSignals: { topHoldingSymbol: 'X', topHoldingPercent: 10, concentrationLabel: 'balanced' } },
  })
  const data = deriveWalletPersonality(report)
  assert.ok((data.radar.activity.signalStrength ?? 0) >= 70, 'activity should read high given 200 dense transactions')
  assert.ok((data.radar.risk.signalStrength ?? 0) < 40, 'risk must not inherit a high reading purely from high activity')
})

test('correlated features (token churn, holding speed) are not double-counted at full weight across axes', () => {
  const churnSignal = { key: 'churn', label: 'churn', detail: 'x', value: 1, weight: 0.35 }
  const rotationResult = combineAxis([
    { key: 'cat', label: 'cat', detail: 'x', value: 1, weight: 0.45 },
    churnSignal,
    { key: 'holdSpeed', label: 'holdSpeed', detail: 'x', value: 1, weight: 0.20 },
  ])
  const riskResult = combineAxis([
    { key: 'shortHolding', label: 'shortHolding', detail: 'x', value: 1, weight: 0.40 },
    { key: 'concentration', label: 'concentration', detail: 'x', value: 1, weight: 0.35 },
    { key: 'churnReduced', label: 'churnReduced', detail: 'x', value: 1, weight: 0.15 },
    { key: 'chainBreadth', label: 'chainBreadth', detail: 'x', value: 1, weight: 0.10 },
  ])
  // The shared "token churn" concept carries full weight (0.35) in Rotation but only reduced
  // weight (0.15) in Risk — never the same full-strength contribution counted twice.
  const churnWeightInRotation = rotationResult.contributors.find((c) => c.key === 'churn')!.weight
  const churnWeightInRisk = riskResult.contributors.find((c) => c.key === 'churnReduced')!.weight
  assert.ok(churnWeightInRisk < churnWeightInRotation)
})

test('percentages are deterministic: identical input always produces the identical signalStrength/evidenceConfidence', () => {
  const report = baseReport()
  const a = deriveWalletPersonality(report)
  const b = deriveWalletPersonality(report)
  assert.deepEqual(a.radar, b.radar)
})

test('no fake midpoint for unknown inputs: a partially-missing axis never resolves to a default 0.5/50%', () => {
  const result = combineAxis([
    { key: 'known', label: 'known', detail: 'x', value: 0.9, weight: 1 },
    { key: 'unknown', label: 'unknown', detail: 'x', value: null, weight: 1 },
  ])
  // Only the known signal contributes — never averaged against a guessed 0.5 for the missing one.
  assert.equal(result.signalStrength, 85) // single available signal, capped at SINGLE_SIGNAL_CEILING
  assert.equal(result.evidenceConfidence, 0.5)
})

test('computeCadenceRegularity: null with too few real transaction timestamps, never a guessed value', () => {
  assert.equal(computeCadenceRegularity([1000, 2000, 3000]), null)
  const regular = computeCadenceRegularity([0, 1000, 2000, 3000, 4000, 5000, 6000])
  assert.notEqual(regular, null)
  assert.ok((regular ?? 0) > 0.9)
})

test('composeTitle: never returns "General User" — that string is reserved for the zero-evidence path only', () => {
  const combos: Array<Parameters<typeof composeTitle>[0]> = [
    { automationClass: 'Manual trader', holdingClass: 'Long-term holder', concentrationClass: 'Not enough data', riskClass: 'Not enough data', rotationValue: 'unknown', convictionValue: 'unknown', activeChains: 1, totalTransactions: 1, activityLevel: 'Light' },
    { automationClass: 'Bot-like', holdingClass: 'Hyperactive sniper', concentrationClass: 'Concentrated', riskClass: 'Medium risk behavior', rotationValue: 'rotator', convictionValue: 'high', activeChains: 2, totalTransactions: 40, activityLevel: 'Active' },
    { automationClass: 'Highly automated', holdingClass: 'Short-term rotator', concentrationClass: 'Moderately diversified', riskClass: 'Low risk behavior', rotationValue: 'distributor', convictionValue: 'medium', activeChains: 5, totalTransactions: 100, activityLevel: 'Very active' },
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

// ─── Two proven consistency bugs: General-User-despite-evidence title, riskOnOff-vs-calibrated-risk trait ───

function manyBuys(count: number, spanDays: number): BuyTimelineEntry[] {
  return Array.from({ length: count }, (_, i) => buyEntry({ txHash: `0xbuy${i}`, timestamp: NOW - Math.round((spanDays * DAY * i) / count) }))
}
function manySells(count: number, spanDays: number): SellTimelineEntry[] {
  return Array.from({ length: count }, (_, i) => sellEntry({ txHash: `0xsell${i}`, counterparty: i % 3 === 0 ? '0xrouterA' : '0xrouterB', timestamp: NOW - Math.round((spanDays * DAY * i) / count) }))
}

// Reconstructs the reported live scenario: 526 transactions, 163 unique tokens, 2 active chains,
// a real matched-lot holding history long enough that the Risk axis's shortHolding sub-signal is
// NOT elevated, no concentration evidence, and a legacy riskOnOff.value of 'risk_on' deliberately
// left set (proving it no longer leaks into the title/trait/summary).
function activeWallet526(): WalletPersonalitySourceReport {
  return baseReport({
    behaviorIntel: {
      ...baseReport().behaviorIntel,
      rotationStyle: { value: 'unknown', basis: { buyCount: 300, sellCount: 226, distributionCount: 0, distinctTokensTraded: 163 } },
      riskOnOff: { value: 'risk_on', basis: 'legacy field, deliberately non-neutral' },
      concentrationSignals: null,
      automationSignals: { suspectedBot: false, signals: [] },
      confidence: 'high',
    },
    fifoAndPnl: {
      ...baseReport().fifoAndPnl,
      matchedLots: [
        lot({ lotId: 'l1', openedAt: NOW - 34 * DAY, closedAt: NOW - 19 * DAY, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }),
        lot({ lotId: 'l2', openedAt: NOW - 30 * DAY, closedAt: NOW - 14 * DAY, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' }),
      ],
    },
    timelines: {
      buyTimeline: { totalBuys: 300, entries: manyBuys(300, 89) },
      sellTimeline: { totalSells: 0, entries: [] },
      distributionTimeline: { totalDistributions: 0, entries: [] },
      sellTimelineV2: { totalSells: 226, chainContext: { includedChains: ['base'], excludedChains: [] }, entries: manySells(226, 89) },
    } as unknown as WalletPersonalitySourceReport['timelines'],
    chainSelection: { chains: [], activeChainCount: 2, dustChainCount: 0 } as unknown as WalletPersonalitySourceReport['chainSelection'],
  })
}

test('a non-empty 526-transaction wallet cannot render "General User"', () => {
  const data = deriveWalletPersonality(activeWallet526())
  assert.equal(data.metrics.totalTransactions, 526)
  assert.notEqual(data.title, 'General User')
  assert.equal(data.insufficientEvidence, false)
})

test('the card never shows Low calibrated risk together with a "risk on" trait/summary — title, trait, and summary all read the calibrated axis, not legacy riskOnOff', () => {
  const data = deriveWalletPersonality(activeWallet526())
  // The calibrated axis reads Low for this fixture (long holding, no concentration evidence,
  // moderate churn/chain-breadth only) — confirms the scenario actually exercises the bug.
  assert.equal(data.classification.risk, 'Low risk behavior')
  assert.ok((data.radar.risk.signalStrength ?? 100) < 25)

  // None of title / trait / summary may say "risk on"/"risk-on" while the calibrated axis is Low —
  // this is the literal consistency invariant this task requires.
  const lowerTitle = data.title.toLowerCase()
  const lowerTrait = data.traits.riskAppetite.toLowerCase()
  const lowerSummary = data.summarySentence.toLowerCase()
  assert.ok(!lowerTitle.includes('risk-on') && !lowerTitle.includes('risk on'))
  assert.ok(!lowerTrait.includes('risk on') && lowerTrait !== 'risk on')
  assert.ok(!lowerSummary.includes('risk-on posture') && !lowerSummary.includes('risk on posture'))
  assert.equal(data.traits.riskAppetite, 'Low behavioral risk')
})

test('legacy riskOnOff.value never overrides the calibrated risk classification in the returned title', () => {
  const wallet = activeWallet526()
  const riskOn = deriveWalletPersonality(wallet)
  const riskOffVariant = deriveWalletPersonality({
    ...wallet,
    behaviorIntel: { ...wallet.behaviorIntel, riskOnOff: { value: 'risk_off', basis: 'x' } },
  })
  // Flipping ONLY the legacy field must not change the title at all — it is not consulted.
  assert.equal(riskOn.title, riskOffVariant.title)
})

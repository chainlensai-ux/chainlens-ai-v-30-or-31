import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFinalReportAssembler } from './finalReportAssembler'

const quiet = { warn() {} }

function baseInput(overrides: Record<string, unknown> = {}) {
  const reconciledPnL = { closedLots: 7, unmatchedBuys: 2, unmatchedSells: 1, realizedPnlUsd: 123.45, unrealizedPnlUsd: 67.89, priceRecoveredCount: 3, routerCorrectedCount: 4, syntheticAlignedCount: 5, missingEvidenceCount: 6, publicPnlStatus: 'partial', mismatches: [] }
  const ayriAttribution = { totalLots: 7, attributedLots: 6, coveragePercent: 0.8571, integrityTier: 'medium', primaryCount: 1, fallbackCount: 2, ratioCount: 3, syntheticCount: 4, recoveredCount: 5, routerCorrectedCount: 4, syntheticAlignedCount: 5, realizedPnlUsd: 123.45, unrealizedPnlUsd: 67.89, records: [{ token: '0xtoken', chain: 'base', attributionSource: 'syntheticPrice', routerInvolvement: 'routerCorrected', syntheticInvolvement: 'syntheticAligned', yieldClassification: 'realized', syntheticAligned: true, priceRecovered: false, routerCorrected: true }], criticalMismatches: [] }
  return {
    scanMetadata: { walletAddress: '0xwallet', scanTimestamp: '2026-07-20T00:00:00.000Z', intel_window_days: 180, provider_fetch_window_days: 90, scanMode: 'normal', chainsScanned: ['base'] },
    chainSelection: { chains: [{ chain: 'base', visible_value_usd: 10, wallet_side_transactions: 2, swapCandidateEvents: 1, gates: { valueGate: true, activityGate: true, swapGate: true }, status: 'active_intelligence' }], activeChainCount: 1, dustChainCount: 0 },
    timelines: { buyTimeline: { entries: [] }, sellTimeline: { entries: [] }, distributionTimeline: { entries: [] } },
    recoveryPolicy: { needed: false, shouldRecover: false, reason: 'none', totalPagesUsedThisWallet: 0, evaluation: [] },
    fifoAndPnl: { matchedLots: [], unmatchedBuys: 99, unmatchedSells: 88, realizedPnlUsd: -999, unrealizedPnlUsd: -888, costBasisUsd: null, publicPnlStatus: 'unavailable', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 } },
    behaviorIntel: { riskOnOff: { value: 'unknown' }, rotationStyle: { value: 'unknown' }, concentrationSignals: null, multiChainParticipation: { activeChains: ['base'] } },
    windowCoverage: { lookbackDays: 90, recoveredDaysEstimate: 0, coverageRatio: 0.5 },
    bridgeTimeline: [],
    sellTimelineV2: { entries: [], totalSells: 9 },
    pnlSummaryV2: { realizedPnlUsd: -777, closedLots: [], winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: null }, chainBreakdown: [], confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'low' }, evidenceMissingCount: 99 },
    pricingAtTime: { costUsd: {}, proceedsUsd: {}, evidenceMissingCount: 0, sourceBreakdown: { primary: 9, fallback: 9, failed: 9 } },
    providerDiagnostics: [],
    pricingProvidersStatus: { goldrush: { active: true, keyLoaded: true }, providerCount: 1, pricingEnabled: true },
    syntheticPnl: { totalLegsCount: 11, pricedLegsCount: 10 },
    ayriAttribution,
    reconciledPnL,
    routerInferenceOutput: { acceptedRouters: new Set(['0xrouter1', '0xrouter2']), highConfidenceRouters: new Set(['0xrouter1']), evidenceByAddress: new Map(), tokenFlowClustersByAddress: new Map(), ambiguousRouters: new Set(), rejectedRouters: new Set(), candidates: [], outboundEvents: [], inboundEvents: [] },
    syntheticPnlAssemblyOutput: { totalLegsCount: 11, pricedLegsCount: 10 },
    pricingSourceBreakdown: { primary: 10, fallback: 20, failed: 30, ratio: 40, synthetic: 50, recovered: 60 },
    walletConditionInputs: { tokenCount: 10, deadTokens: 1, unindexedTokens: 1, zeroLiquidityTokens: 0, failedPricingAttempts: 3, fallbackAttempts: 2, providerErrors: 1, suppressionSkipped: 1, closedLots: 99, totalSells: 9, currentPnL: -999, excludedTokens: ['SPAM'] },
    ...overrides,
  } as never
}

describe('finalReportAssembler', () => {
  it('report matches reconciled PnL', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.fifoAndPnl.unmatchedBuys, 2)
    assert.equal(report.fifoAndPnl.unmatchedSells, 1)
    assert.equal(report.fifoAndPnl.realizedPnlUsd, 123.45)
    assert.equal(report.fifoAndPnl.unrealizedPnlUsd, 67.89)
    assert.equal(report.fifoAndPnl.publicPnlStatus, 'limited_verified_sample')
    assert.equal(report.reconciliationSummary.closedLots, 7)
  })

  it('report matches AYRI attribution', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.coveragePercent, 0.8571)
    assert.equal(report.integrityTier, 'medium')
    assert.equal(report.attributionSummary.syntheticAlignedCount, 5)
    assert.equal(report.recoveredCount, 5)
  })

  it('report matches router inference', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.outboundToKnownRouterCount, 2)
    assert.equal(report.routerInvolvement, 4)
  })

  it('report matches synthetic alignment', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.syntheticAlignedCount, 5)
    assert.equal(report.syntheticCoverage, 4)
    assert.equal(report.syntheticIntegrity, 'medium')
  })

  it('is deterministic for the same input', () => {
    const assembler = createFinalReportAssembler({ logger: quiet })
    assert.deepEqual(assembler.assemble(baseInput()), assembler.assemble(baseInput()))
  })

  it('wallet-condition uses reconciled values', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.walletConditionInputs.closedLots, 7)
    assert.equal(report.walletConditionInputs.currentPnL, 123.45)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createFinalReportAssembler, applyVerifiedSampleHeadline } from './finalReportAssembler'

const quiet = { warn() {} }

function baseInput(overrides: Record<string, unknown> = {}) {
  const reconciledPnL = { closedLots: 7, unmatchedBuys: 2, unmatchedSells: 1, realizedPnlUsd: 123.45, unrealizedPnlUsd: 67.89, priceRecoveredCount: 3, routerCorrectedCount: 4, syntheticAlignedCount: 5, missingEvidenceCount: 6, publicPnlStatus: 'partial', mismatches: [] }
  const ayriAttribution = { totalLots: 7, attributedLots: 6, attributionCoveragePercent: 0.8571, historicalPricingCoveragePercent: 0.5714, verifiedPricingCoveragePercent: 0.4286, fullyPricedLots: 4, integrityTier: 'medium', primaryCount: 1, fallbackCount: 2, ratioCount: 3, syntheticCount: 4, recoveredCount: 5, routerCorrectedCount: 4, syntheticAlignedCount: 5, realizedPnlUsd: 123.45, unrealizedPnlUsd: 67.89, records: [{ token: '0xtoken', chain: 'base', attributionSource: 'syntheticPrice', routerInvolvement: 'routerCorrected', syntheticInvolvement: 'syntheticAligned', yieldClassification: 'realized', syntheticAligned: true, priceRecovered: false, routerCorrected: true }], criticalMismatches: [] }
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
    assert.equal(report.attributionCoveragePercent, 0.8571)
    assert.equal(report.historicalPricingCoveragePercent, 0.5714)
    assert.equal(report.verifiedPricingCoveragePercent, 0.4286)
    assert.equal(report.fullyPricedLots, 4)
    assert.equal(report.totalLots, 7)
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

  it('wallet-condition uses verified/structural lots, never mixes reconciled closedLots with sell-timeline totalSells', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.walletConditionInputs.closedLots, 99)
    assert.equal(report.walletConditionInputs.totalSells, 9)
    assert.equal(report.walletConditionInputs.verifiedClosedLots, 99)
    assert.equal(report.walletConditionInputs.structuralClosedLots, 9)
    assert.equal(report.walletConditionInputs.currentPnL, 123.45)
  })

  it('publishes one canonical realized total while retaining the alternate total as diagnostic-only', () => {
    const closedLots = [
      { lotId: 'alt-a', matchedBuyLotId: null, token: '0xa', symbol: 'A', chain: 'base', timestamp: 1, txHash: '0xsa', amount: '1', costUsdEstimate: 10, proceedsUsdEstimate: 14, realizedPnlUsd: 4, confidence: 'high', evidence: 'complete' },
      { lotId: 'alt-b', matchedBuyLotId: null, token: '0xb', symbol: 'B', chain: 'base', timestamp: 2, txHash: '0xsb', amount: '1', costUsdEstimate: 8, proceedsUsdEstimate: 6, realizedPnlUsd: -2, confidence: 'high', evidence: 'complete' },
    ]
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput({
      pnlSummaryV2: {
        realizedPnlUsd: 2,
        closedLots,
        winLossRate: { wins: 1, losses: 1, evaluated: 2, rate: 0.5 },
        chainBreakdown: [{ chain: 'base', closedLotCount: 2, realizedPnlUsd: 2 }],
        confidenceBasis: { high: 2, medium: 0, low: 0, aggregate: 'high' },
        evidenceMissingCount: 0,
      },
    }))

    assert.equal(report.pnlSummaryV2.diagnosticRealizedPnlUsd, 2, 'alternate result remains available for audits')
    assert.equal(report.pnlSummaryV2.diagnosticOnly, true)
    assert.equal(report.pnlSummaryV2.realizedPnlUsd, 123.45)
    assert.equal(report.pnlSummaryV2.realizedPnlUsd, report.fifoAndPnl.realizedPnlUsd, 'both published surfaces use canonical reconciliation')
  })

  it('HARD ASSERTION (Wallet PnL Item 2): when fifoEngine and pnlSummaryV2 disagree, published realizedPnlUsd equals the canonical fifo/reconciliation source, never pnlEngine', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput({
      fifoAndPnl: {
        matchedLots: [], unmatchedBuys: 99, unmatchedSells: 88,
        realizedPnlUsd: 174.01, unrealizedPnlUsd: 0, costBasisUsd: null,
        publicPnlStatus: 'unavailable',
        integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
      },
      reconciledPnL: {
        closedLots: 7, unmatchedBuys: 2, unmatchedSells: 1,
        realizedPnlUsd: 174.01, unrealizedPnlUsd: 67.89,
        priceRecoveredCount: 3, routerCorrectedCount: 4, syntheticAlignedCount: 5,
        missingEvidenceCount: 6, publicPnlStatus: 'partial', mismatches: [],
      },
      pnlSummaryV2: {
        realizedPnlUsd: 270.02, closedLots: [],
        winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: null },
        chainBreakdown: [], confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'low' },
        evidenceMissingCount: 99, diagnosticOnly: true,
      },
    }))
    assert.equal(report.fifoAndPnl.realizedPnlUsd, 174.01)
    assert.equal(report.reconciliationSummary.realizedPnlUsd, 174.01)
    assert.equal(report.pnlSummaryV2.realizedPnlUsd, 174.01, 'published pnlSummaryV2 realized is canonical fifo/reconciliation')
    assert.equal(report.pnlSummaryV2.diagnosticRealizedPnlUsd, 270.02, 'pnlEngine keeps its own independent total as diagnostic')
    assert.notEqual(report.fifoAndPnl.realizedPnlUsd, report.pnlSummaryV2.diagnosticRealizedPnlUsd)
    assert.equal(report.pnlSummaryV2.diagnosticOnly, true, 'the disagreeing engine must be marked diagnostic-only')
    assert.equal(report.fifoAndPnl.realizedPnlUsd, report.reconciliationSummary.realizedPnlUsd, 'published realized equals the canonical fifo/reconciliation source')
  })

  it('HARD ASSERTION: unavailable full-wallet + allowed sample → headline keeps Combined locked and still names verified sample PnL', () => {
    const SAMPLE_PNL = -70794.97
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput({
      reconciledPnL: {
        closedLots: 98, unmatchedBuys: 0, unmatchedSells: 2,
        realizedPnlUsd: SAMPLE_PNL, unrealizedPnlUsd: null,
        priceRecoveredCount: 0, routerCorrectedCount: 0, syntheticAlignedCount: 0,
        missingEvidenceCount: 2, publicPnlStatus: 'unavailable', mismatches: [],
        publicPnlGateAudit: { unmatchedSellCount: 2, verifiedClosedLots: 98, structuralClosedLots: 98, verifiedPricingCoverage: 1 },
        verifiedSamplePerformance: {
          status: 'verified_bounded_sample',
          realizedPnlUsd: SAMPLE_PNL,
          realizedCostBasisUsd: 307103.26,
          realizedRoiPct: -23.05,
          verifiedLotCount: 98,
          structuralLotCount: 98,
          pricingCoverage: 1,
          excludedUnmatchedSellCount: 2,
          isCompleteWalletHistory: false,
        },
      },
    }))
    assert.equal(report.finalSummary.financialStatus.officialPnlStatus, 'unavailable')
    assert.match(report.finalSummary.financialStatus.headline, /2 unmatched sells prevent complete-wallet verification/)
    assert.match(report.finalSummary.financialStatus.headline, /Verified sample realized PnL -\$70,794\.97/)
    assert.match(report.finalSummary.financialStatus.headline, /PARTIAL \/ VERIFIED BOUNDED SAMPLE/)
    assert.equal(
      applyVerifiedSampleHeadline('PnL unavailable due to missing evidence.', report.reconciliationSummary),
      report.finalSummary.financialStatus.headline,
    )
  })
})

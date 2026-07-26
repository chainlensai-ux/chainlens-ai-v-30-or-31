// Structural (source-scan) test for src/lib/finalReportAssembler.ts — proves the internal PnL
// figures ayriAttribution.ts computes for its own coverage bookkeeping can never reach the public
// fifoAndPnl.realizedPnlUsd/unrealizedPnlUsd surface (this task's explicit "the internal [...]
// figure must remain diagnostic-only" requirement).
//
// Same pure-source-scan convention already used elsewhere in this codebase for guards a runtime
// test can't express cleanly (e.g. lib/engine/modules/pricing/fetchPricing.test.ts's "never imports
// pricingAtTimeEngine" guard).
//
// Uses node:test. Run with:
//   npx tsx --test src/lib/finalReportAssembler.diagnosticOnly.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFinalReportAssembler } from './finalReportAssembler'

const source = readFileSync(fileURLToPath(new URL('./finalReportAssembler.ts', import.meta.url)), 'utf8')

describe('finalReportAssembler — ayriAttribution\'s own internal PnL figures stay diagnostic-only', () => {
  it('buildReconciledFifo sources realizedPnlUsd/unrealizedPnlUsd from reconciledPnL only, never from ayriAttribution', () => {
    const start = source.indexOf('function buildReconciledFifo')
    const end = source.indexOf('function buildReconciledPnlSummary')
    const fnBody = source.slice(start, end)
    assert.match(fnBody, /realizedPnlUsd: input\.reconciledPnL\.realizedPnlUsd/)
    assert.match(fnBody, /unrealizedPnlUsd: input\.reconciledPnL\.unrealizedPnlUsd/)
    assert.ok(!fnBody.includes('ayriAttribution'), 'the public fifoAndPnl figures must never be sourced from ayriAttribution\'s own internal recomputation')
  })

  it('the top-level assembled report never assigns ayriAttribution.realizedPnlUsd/unrealizedPnlUsd to fifoAndPnl', () => {
    const assembleStart = source.indexOf('assemble(input: BuildInput)')
    const assembleBody = source.slice(assembleStart)
    assert.ok(!/fifoAndPnl:\s*\{[^}]*ayriAttribution/.test(assembleBody))
  })
})

describe('finalReportAssembler — real end-to-end proof: a divergent internal ayri PnL figure never leaks into fifoAndPnl', () => {
  const quiet = { warn() {} }

  function baseInput(overrides: Record<string, unknown> = {}) {
    // A deliberately DIVERGENT internal ayri realizedPnlUsd (the "internal $163.99"-shaped figure
    // this task refers to) alongside a different, real reconciledPnL.realizedPnlUsd — proving the
    // internal figure never overwrites the public one.
    const ayriAttribution = {
      totalLots: 3, attributedLots: 3, attributionCoveragePercent: 1, historicalPricingCoveragePercent: 0.33,
      verifiedPricingCoveragePercent: 0.33, integrityTier: 'low', primaryCount: 1, fallbackCount: 0, ratioCount: 0,
      syntheticCount: 0, recoveredCount: 0, routerCorrectedCount: 0, syntheticAlignedCount: 0, fullyPricedLots: 1,
      realizedPnlUsd: 163.99, unrealizedPnlUsd: 0, records: [], criticalMismatches: [],
    }
    const reconciledPnL = { closedLots: 3, unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: 42, unrealizedPnlUsd: 7, priceRecoveredCount: 0, routerCorrectedCount: 0, syntheticAlignedCount: 0, missingEvidenceCount: 0, publicPnlStatus: 'available', mismatches: [] }
    return {
      scanMetadata: { walletAddress: '0xwallet', scanTimestamp: '2026-07-20T00:00:00.000Z', intel_window_days: 180, provider_fetch_window_days: 90, scanMode: 'normal', chainsScanned: ['base'] },
      chainSelection: { chains: [], activeChainCount: 0, dustChainCount: 0 },
      timelines: { buyTimeline: { entries: [] }, sellTimeline: { entries: [] }, distributionTimeline: { entries: [] } },
      recoveryPolicy: { needed: false, shouldRecover: false, reason: 'none', totalPagesUsedThisWallet: 0, evaluation: [] },
      fifoAndPnl: { matchedLots: [], unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: -1, unrealizedPnlUsd: -1, costBasisUsd: null, publicPnlStatus: 'unavailable', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 } },
      behaviorIntel: { riskOnOff: { value: 'unknown' }, rotationStyle: { value: 'unknown' }, concentrationSignals: null, multiChainParticipation: { activeChains: [] } },
      windowCoverage: { lookbackDays: 90, recoveredDaysEstimate: 0, coverageRatio: 0.5 },
      bridgeTimeline: [],
      sellTimelineV2: { entries: [], totalSells: 0 },
      pnlSummaryV2: { realizedPnlUsd: -1, closedLots: [], winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: null }, chainBreakdown: [], confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'low' }, evidenceMissingCount: 0 },
      pricingAtTime: { costUsd: {}, proceedsUsd: {}, evidenceMissingCount: 0, sourceBreakdown: { primary: 1, fallback: 0, failed: 0 } },
      providerDiagnostics: [],
      pricingProvidersStatus: { goldrush: { active: true, keyLoaded: true }, providerCount: 1, pricingEnabled: true },
      syntheticPnl: { totalLegsCount: 0, pricedLegsCount: 0 },
      ayriAttribution,
      reconciledPnL,
      routerInferenceOutput: { acceptedRouters: new Set(), highConfidenceRouters: new Set(), evidenceByAddress: new Map(), tokenFlowClustersByAddress: new Map(), ambiguousRouters: new Set(), rejectedRouters: new Set(), candidates: [], outboundEvents: [], inboundEvents: [] },
      pricingSourceBreakdown: { primary: 1, fallback: 0, failed: 0, ratio: 0, synthetic: 0, recovered: 0 },
      walletConditionInputs: { tokenCount: 0, deadTokens: 0, unindexedTokens: 0, zeroLiquidityTokens: 0, failedPricingAttempts: 0, fallbackAttempts: 0, providerErrors: 0, suppressionSkipped: 0, closedLots: 3, totalSells: 0, currentPnL: 42 },
      ...overrides,
    } as never
  }

  it('the public fifoAndPnl.realizedPnlUsd equals reconciledPnL\'s figure (42), never ayriAttribution\'s internal 163.99', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.fifoAndPnl.realizedPnlUsd, 42)
    assert.notEqual(report.fifoAndPnl.realizedPnlUsd, 163.99)
  })

  it('the internal 163.99 figure is still visible, but only inside attributionSummary — a diagnostic surface, never the public one', () => {
    const report = createFinalReportAssembler({ logger: quiet }).assemble(baseInput())
    assert.equal(report.attributionSummary.realizedPnlUsd, 163.99, 'the internal figure must still be inspectable for diagnosis')
    assert.notEqual(report.attributionSummary, report.fifoAndPnl, 'the two must remain structurally separate surfaces')
  })
})

// Runtime test harness — pipeline runner + assertion helpers.
//
// This file is the ONLY place in the harness that reaches past runWalletScan() to call individual
// module functions directly (runSyntheticPipeline) — and it does so purely to substitute stage 1
// (the network-fetch stage) with deterministic synthetic data for the wallets that need it. Every
// stage from normalization onward calls the exact same module functions runWalletScan uses, in
// the exact same order, so a synthetic-path run still exercises real production logic end-to-end.

import { normalizeEvents } from '../modules/normalization/index'
import { buildChainSelectionObject } from '../modules/chainSelection/index'
import { buildTimelines } from '../modules/timelineBuilder/index'
import { buildRecoveryPolicyObject } from '../modules/recoveryPolicy/index'
import type { RecoveryPolicyResult } from '../modules/recoveryPolicy/types'
import { buildFifoOutput } from '../modules/fifoEngine/index'
import type { FifoOutput } from '../modules/fifoEngine/types'
import { buildBehaviorIntelObject } from '../modules/behaviorIntel/index'
import type { BehaviorIntelResult } from '../modules/behaviorIntel/types'
import { buildBridgeDetectionObject } from '../modules/bridgeDetection/index'
import { buildSellTimeline } from '../modules/sellTimeline/index'
import { buildPnlSummary } from '../modules/pnlEngine/index'
import { resolvePricingAtTime } from '../modules/pricingAtTimeEngine/index'
import { goldrushPriceSource } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import type { GoldRushClient } from '@covalenthq/client-sdk'
import { priceLotsForWallet } from '../pipeline/priceLotsForWallet'
import type { MatchedLot } from '../modules/fifoEngine/types'
import type { BuildPnlSummaryParams } from '../modules/pnlEngine/types'
import { assembleReport } from '../modules/finalReportAssembler/index'
import type { ScanMetadata } from '../modules/finalReportAssembler/types'
import type { ProviderStatus, SupportedChain } from '../modules/providerFetchWindow/types'

import { buildFifoBackedPnlResolvers, PRICING_PROVIDERS_STATUS, runWalletScan } from '../pipeline/index'
import type { RunWalletScanResult } from '../pipeline/types'
import { INTEL_WINDOW_DAYS, SUPPORTED_CHAINS } from '../pipeline/types'
import {
  behaviorIntelFallback,
  computeWindowCoverage,
  fifoEngineFallback,
  recoveryPolicyFallback,
  validatePreScan,
} from '../pipeline/utils'

import type { WalletTestConfig } from './wallets'

const PROVIDER_FETCH_WINDOW_DAYS_USED = 90

// Fake GoldRush client for the runtime test harness — exercises the REAL goldrushPriceSource
// wrapper logic (chain-slug lookup, date conversion, response-shape handling, error catching)
// without making any real network call. Always resolves to an error response, so every test
// wallet run through this path proves evidenceMissingCount/sourceBreakdown.failed increment
// correctly through the real wrapper, not just a hand-rolled `() => null` stub.
const FAKE_GOLDRUSH_CLIENT = {
  PricingService: {
    getTokenPrices: async () => ({ data: null, error: true as const, error_code: 404, error_message: 'fake GoldRush client: no price data in runtime tests' }),
  },
} as unknown as GoldRushClient

function usesSyntheticPath(wallet: WalletTestConfig): boolean {
  return wallet.syntheticRawEvents !== undefined || Boolean(wallet.forcedProviderStatusByChain)
}

// Synthetic-path runner — replicates pipeline/index.ts's stages 2-9 exactly, substituting stage 1
// (providerFetchWindow) with the wallet's synthetic raw events / forced provider statuses. Never
// calls fetchProviderWindow's real fetch functions, so this path makes zero network calls of its
// own; a deep-mode wallet run through this path can still legitimately reach recoveryPolicy's
// real (capped) historical fetch, exactly as production would.
async function runSyntheticPipeline(wallet: WalletTestConfig): Promise<RunWalletScanResult> {
  const scanTimestamp = new Date().toISOString()
  const params = { walletAddress: wallet.walletAddress, chains: wallet.chains, scanMode: wallet.scanMode }
  const preScan = validatePreScan(params)

  const sanitizedChains: SupportedChain[] = preScan.valid
    ? preScan.sanitizedChains
    : wallet.chains.filter((c): c is SupportedChain => SUPPORTED_CHAINS.includes(c as SupportedChain))

  const rawEvents = wallet.syntheticRawEvents ?? []
  const { normalizedEvents, normalizationErrors } = normalizeEvents(rawEvents, wallet.walletAddress)

  const chainSelection = buildChainSelectionObject(
    normalizedEvents,
    sanitizedChains.map((chain) => ({
      chain,
      providerStatus: (wallet.forcedProviderStatusByChain?.[chain] ?? 'ok') as ProviderStatus,
    })),
  )

  const timelines = buildTimelines(normalizedEvents, chainSelection)

  let bridgeTimeline: ReturnType<typeof buildBridgeDetectionObject>['bridgeTimeline']
  try {
    bridgeTimeline = buildBridgeDetectionObject(normalizedEvents).bridgeTimeline
  } catch {
    bridgeTimeline = []
  }

  let recoveryPolicy: RecoveryPolicyResult
  if (wallet.scanMode !== 'deep') {
    recoveryPolicy = recoveryPolicyFallback()
  } else {
    try {
      recoveryPolicy = await buildRecoveryPolicyObject({
        buyTimeline: timelines.buyTimeline,
        sellTimeline: timelines.sellTimeline,
        holdings: [],
        walletAddress: wallet.walletAddress,
      })
    } catch {
      recoveryPolicy = recoveryPolicyFallback()
    }
  }

  let sellTimelineV2: ReturnType<typeof buildSellTimeline>
  try {
    sellTimelineV2 = buildSellTimeline({
      normalizedEvents,
      chainSelection,
      bridgeTimeline,
      recoveryPolicy,
      walletAddress: wallet.walletAddress,
      knownDexRouterAddresses: new Set<string>(),
    })
  } catch {
    sellTimelineV2 = { totalSells: 0, chainContext: { includedChains: [], excludedChains: [] }, entries: [] }
  }

  const testPriceSources = { primary: goldrushPriceSource(FAKE_GOLDRUSH_CLIENT), fallback: () => null }

  // Mirrors pipeline/index.ts's stage 5c: pre-resolve real (here, fake-client-backed) pricing for
  // every normalized event before fifoEngine runs, so the synthetic path exercises the exact same
  // priceUsdLookup/currentPriceUsdLookup wiring production does.
  const { normalizedEvents: recoveredNormalizedForPricing } = normalizeEvents(
    recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents),
    wallet.walletAddress,
  )
  const walletPriceLookups = await priceLotsForWallet({
    normalizedEvents,
    recoveredEvents: recoveredNormalizedForPricing,
    priceSources: testPriceSources,
  })

  let fifoAndPnl: FifoOutput
  try {
    fifoAndPnl = buildFifoOutput({
      normalizedEvents,
      recoveredRawEvents: recoveryPolicy.evaluation.flatMap((e) => e.recoveredEvents),
      walletAddress: wallet.walletAddress,
      priceUsdLookup: walletPriceLookups.priceUsdLookup,
      currentPriceUsdLookup: walletPriceLookups.currentPriceUsdLookup,
    })
  } catch {
    fifoAndPnl = fifoEngineFallback(timelines.buyTimeline, timelines.sellTimeline)
  }

  // Mirrors pipeline/index.ts's stage 6b: pnlSummaryV2 now runs after fifoAndPnl so it can borrow
  // fifoEngine's real matched-lot cost basis/proceeds.
  const pnlResolvers = buildFifoBackedPnlResolvers(fifoAndPnl.matchedLots as MatchedLot[])
  let pnlSummaryV2: ReturnType<typeof buildPnlSummary>
  try {
    pnlSummaryV2 = buildPnlSummary({
      sellEntries: sellTimelineV2.entries,
      buyEntries: timelines.buyTimeline.entries,
      resolveCostUsdEstimate: pnlResolvers.resolveCostUsdEstimate as BuildPnlSummaryParams['resolveCostUsdEstimate'],
      resolveProceedsUsdEstimate: pnlResolvers.resolveProceedsUsdEstimate as BuildPnlSummaryParams['resolveProceedsUsdEstimate'],
    })
  } catch {
    pnlSummaryV2 = {
      realizedPnlUsd: null,
      closedLots: [],
      winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: null },
      chainBreakdown: [],
      confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'unavailable' },
      evidenceMissingCount: 0,
    }
  }

  let pricingAtTime: Awaited<ReturnType<typeof resolvePricingAtTime>>
  try {
    pricingAtTime = await resolvePricingAtTime({
      buyEntries: timelines.buyTimeline.entries,
      sellEntries: sellTimelineV2.entries,
      priceSources: testPriceSources,
    })
  } catch {
    pricingAtTime = { costUsd: {}, proceedsUsd: {}, evidenceMissingCount: 0, sourceBreakdown: { primary: 0, fallback: 0, failed: 0 } }
  }

  const windowCoverage = computeWindowCoverage(PROVIDER_FETCH_WINDOW_DAYS_USED, recoveryPolicy.totalPagesUsedThisWallet)

  let behaviorIntel: BehaviorIntelResult
  try {
    behaviorIntel = buildBehaviorIntelObject({
      buyTimeline: timelines.buyTimeline,
      sellEntries: sellTimelineV2.entries,
      distributionTimeline: timelines.distributionTimeline,
      chainSelection,
      windowCoverage,
      holdings: [],
    })
  } catch {
    behaviorIntel = behaviorIntelFallback(chainSelection)
  }

  const scanMetadata: ScanMetadata = {
    walletAddress: wallet.walletAddress,
    scanTimestamp,
    intel_window_days: INTEL_WINDOW_DAYS,
    provider_fetch_window_days: PROVIDER_FETCH_WINDOW_DAYS_USED,
    scanMode: wallet.scanMode,
    chainsScanned: sanitizedChains,
  }

  const finalReport = assembleReport({
    scanMetadata,
    chainSelection,
    timelines,
    recoveryPolicy,
    fifoAndPnl,
    behaviorIntel,
    windowCoverage,
    bridgeTimeline,
    sellTimelineV2,
    pnlSummaryV2,
    pricingAtTime,
    // Honestly empty — the synthetic path bypasses providerFetchWindow entirely by design (see
    // this file's own header comment), so there is no real per-provider fetch outcome to report.
    providerDiagnostics: [],
    // Real, not synthetic — pricing-provider status reflects this process's actual env, same as
    // the live pipeline's PRICING_PROVIDERS_STATUS.
    pricingProvidersStatus: PRICING_PROVIDERS_STATUS,
  })

  // walletConditionMessages: [], DISCLOSED — this synthetic path deliberately bypasses
  // runWalletScan() entirely (see this file's own header), so none of the real metrics
  // buildWalletConditionMessages() needs (dust-suppression counts, pnlSummaryV2.closedLots, etc.)
  // are computed here. Empty, not fabricated.
  return { ...finalReport, normalizationErrors, walletConditionMessages: [] }
}

export type PipelineRunOutcome = {
  report: RunWalletScanResult
  durationMs: number
  usedSyntheticPath: boolean
}

export async function runPipelineForWallet(wallet: WalletTestConfig): Promise<PipelineRunOutcome> {
  const startedAt = performance.now()
  const synthetic = usesSyntheticPath(wallet)
  const report = synthetic
    ? await runSyntheticPipeline(wallet)
    : await runWalletScan({ walletAddress: wallet.walletAddress, chains: wallet.chains, scanMode: wallet.scanMode })
  const durationMs = performance.now() - startedAt
  return { report, durationMs, usedSyntheticPath: synthetic }
}

// ── Assertion helpers ────────────────────────────────────────────────────────────────────────

export type AssertionResult = { pass: boolean; failures: string[] }

function pass(): AssertionResult {
  return { pass: true, failures: [] }
}

function combine(...results: AssertionResult[]): AssertionResult {
  const failures = results.flatMap((r) => r.failures)
  return { pass: failures.length === 0, failures }
}

function check(condition: boolean, message: string): AssertionResult {
  return condition ? pass() : { pass: false, failures: [message] }
}

// Verifies the report matches the Step 5 unified shape exactly, plus normalizationErrors.
export function assertShape(report: RunWalletScanResult): AssertionResult {
  return combine(
    check(typeof report.scanMetadata?.walletAddress === 'string', 'scanMetadata.walletAddress missing/invalid'),
    check(typeof report.scanMetadata?.intel_window_days === 'number', 'scanMetadata.intel_window_days missing/invalid'),
    check(Array.isArray(report.chainSelection?.chains), 'chainSelection.chains must be an array'),
    check(typeof report.chainSelection?.activeChainCount === 'number', 'chainSelection.activeChainCount missing'),
    check(typeof report.chainSelection?.dustChainCount === 'number', 'chainSelection.dustChainCount missing'),
    check(typeof report.timelines?.buyTimeline?.totalBuys === 'number', 'timelines.buyTimeline.totalBuys missing'),
    check(Array.isArray(report.timelines?.buyTimeline?.entries), 'timelines.buyTimeline.entries must be an array'),
    check(typeof report.timelines?.sellTimeline?.totalSells === 'number', 'timelines.sellTimeline.totalSells missing'),
    check(Array.isArray(report.timelines?.sellTimeline?.entries), 'timelines.sellTimeline.entries must be an array'),
    check(typeof report.timelines?.distributionTimeline?.totalDistributions === 'number', 'timelines.distributionTimeline.totalDistributions missing'),
    check(Array.isArray(report.timelines?.distributionTimeline?.entries), 'timelines.distributionTimeline.entries must be an array'),
    check(Array.isArray(report.recoveryPolicy?.evaluation), 'recoveryPolicy.evaluation must be an array'),
    check(typeof report.recoveryPolicy?.totalPagesUsedThisWallet === 'number', 'recoveryPolicy.totalPagesUsedThisWallet missing'),
    check(Array.isArray(report.fifoAndPnl?.matchedLots), 'fifoAndPnl.matchedLots must be an array'),
    check(typeof report.fifoAndPnl?.publicPnlStatus === 'string', 'fifoAndPnl.publicPnlStatus missing'),
    check(typeof report.fifoAndPnl?.integrityFlags?.hardInvalid === 'boolean', 'fifoAndPnl.integrityFlags.hardInvalid missing'),
    check(typeof report.behaviorIntel?.rotationStyle?.value === 'string', 'behaviorIntel.rotationStyle.value missing'),
    check(typeof report.behaviorIntel?.riskOnOff?.value === 'string', 'behaviorIntel.riskOnOff.value missing'),
    check(typeof report.behaviorIntel?.confidence === 'string', 'behaviorIntel.confidence missing'),
    check(typeof report.windowCoverage?.realDataDays === 'number', 'windowCoverage.realDataDays missing'),
    check(typeof report.windowCoverage?.coverageBasis === 'string', 'windowCoverage.coverageBasis missing'),
    check(typeof report.finalSummary?.walletPersonality === 'string', 'finalSummary.walletPersonality missing'),
    check(typeof report.finalSummary?.financialStatus?.headline === 'string', 'finalSummary.financialStatus.headline missing'),
    check(typeof report.finalSummary?.recoverySummary === 'string', 'finalSummary.recoverySummary missing'),
    check(Array.isArray(report.normalizationErrors), 'normalizationErrors must be an array'),
  )
}

// Verifies Architecture Step 7 fallback rules hold wherever they apply.
export function assertFallbacks(report: RunWalletScanResult): AssertionResult {
  const wc = report.windowCoverage
  const windowSum = wc.realDataDays + wc.inferredDays + wc.recoveredExtraDays

  const results: AssertionResult[] = [
    check(windowSum === report.scanMetadata.intel_window_days, `windowCoverage components sum to ${windowSum}, expected ${report.scanMetadata.intel_window_days}`),
    check(
      ['partial_window', 'partial_window_plus_targeted_recovery', 'full_window'].includes(wc.coverageBasis),
      `windowCoverage.coverageBasis has an invalid value: ${wc.coverageBasis}`,
    ),
  ]

  if (report.chainSelection.activeChainCount === 0) {
    results.push(
      check(report.timelines.buyTimeline.totalBuys === 0, 'no active chains but buyTimeline is non-empty'),
      check(report.timelines.sellTimeline.totalSells === 0, 'no active chains but sellTimeline is non-empty'),
      check(report.timelines.distributionTimeline.totalDistributions === 0, 'no active chains but distributionTimeline is non-empty'),
    )
  }

  if (report.scanMetadata.scanMode === 'normal') {
    results.push(check(report.recoveryPolicy.totalPagesUsedThisWallet === 0, "scanMode 'normal' must never spend recovery pages"))
  }

  if (report.fifoAndPnl.integrityFlags.hardInvalid) {
    results.push(check(report.fifoAndPnl.publicPnlStatus === 'unavailable', 'hardInvalid=true but publicPnlStatus is not unavailable'))
  }
  if (report.fifoAndPnl.publicPnlStatus === 'unavailable') {
    results.push(check(report.fifoAndPnl.realizedPnlUsd === null, "publicPnlStatus is 'unavailable' but realizedPnlUsd is not null"))
  }

  return combine(...results)
}

// Verifies Architecture Step 8 cost guarantees hold, from the report shape alone.
export function assertCost(report: RunWalletScanResult): AssertionResult {
  const { recoveryPolicy } = report
  const results: AssertionResult[] = [
    check(
      recoveryPolicy.totalPagesUsedThisWallet <= recoveryPolicy.caps.maxHistoricalPagesPerWallet,
      `totalPagesUsedThisWallet (${recoveryPolicy.totalPagesUsedThisWallet}) exceeds maxHistoricalPagesPerWallet (${recoveryPolicy.caps.maxHistoricalPagesPerWallet})`,
    ),
  ]
  for (const entry of recoveryPolicy.evaluation) {
    results.push(
      check(
        entry.pagesUsed <= recoveryPolicy.caps.maxHistoricalPagesPerToken,
        `token ${entry.token} used ${entry.pagesUsed} pages, exceeding maxHistoricalPagesPerToken (${recoveryPolicy.caps.maxHistoricalPagesPerToken})`,
      ),
    )
  }
  if (report.scanMetadata.scanMode === 'normal') {
    results.push(check(recoveryPolicy.totalPagesUsedThisWallet === 0, "scanMode 'normal' must incur zero recovery cost"))
  }
  return combine(...results)
}

const FORBIDDEN_BEHAVIOR_INTEL_KEYS = ['realizedPnlUsd', 'proceedsUsd', 'costBasisUsd', 'matchedLots', 'recoveryTriggered', 'pagesUsed']

// Verifies Architecture Step 9 integrity guarantees hold, from the report shape alone.
export function assertIntegrity(report: RunWalletScanResult): AssertionResult {
  const results: AssertionResult[] = []

  if (report.fifoAndPnl.integrityFlags.hardInvalid) {
    results.push(check(report.fifoAndPnl.publicPnlStatus === 'unavailable', 'integrityFlags.hardInvalid must force publicPnlStatus to unavailable'))
  }

  for (const lot of report.fifoAndPnl.matchedLots) {
    if (lot.evidenceQuality === 'unpriced') {
      results.push(check(lot.realizedPnlUsd === null, `unpriced lot ${lot.lotId} must not carry a realizedPnlUsd figure`))
    }
  }
  results.push(check(report.fifoAndPnl.integrityFlags.syntheticLotsExcluded === 0, 'fifoEngine must never fabricate a synthetic lot'))

  // Defensive runtime check that no financial field leaked into the behavioral section, even
  // though the type system already makes this structurally impossible.
  const behaviorIntelJson = JSON.stringify(report.behaviorIntel)
  for (const key of FORBIDDEN_BEHAVIOR_INTEL_KEYS) {
    results.push(check(!behaviorIntelJson.includes(`"${key}"`), `behaviorIntel unexpectedly contains a financial field: ${key}`))
  }

  return combine(...results)
}

// Verifies a run completed within a reasonable time budget. Synthetic-path runs (no real network
// I/O) get a much tighter default threshold than live-provider runs.
export function assertPerformance(startTime: number, endTime: number, thresholdMs = 60_000): AssertionResult {
  const durationMs = endTime - startTime
  return check(durationMs <= thresholdMs, `run took ${durationMs.toFixed(1)}ms, exceeding the ${thresholdMs}ms budget`)
}

export function logStructuredResult(wallet: WalletTestConfig, outcome: PipelineRunOutcome): void {
  const { report, durationMs, usedSyntheticPath } = outcome
  // eslint-disable-next-line no-console
  console.log(`\n── ${wallet.name} (${usedSyntheticPath ? 'synthetic' : 'live'} path, ${durationMs.toFixed(1)}ms) ──`)
  console.log('scanMetadata:', report.scanMetadata)
  console.log('chainSelection:', {
    activeChainCount: report.chainSelection.activeChainCount,
    dustChainCount: report.chainSelection.dustChainCount,
    chains: report.chainSelection.chains.map((c) => ({ chain: c.chain, status: c.status })),
  })
  console.log('timelines:', {
    totalBuys: report.timelines.buyTimeline.totalBuys,
    totalSells: report.timelines.sellTimeline.totalSells,
    totalDistributions: report.timelines.distributionTimeline.totalDistributions,
  })
  console.log('recoveryPolicy:', {
    totalPagesUsedThisWallet: report.recoveryPolicy.totalPagesUsedThisWallet,
    triggeredTokens: report.recoveryPolicy.evaluation.filter((e) => e.recoveryTriggered).length,
  })
  console.log('fifoAndPnl:', {
    matchedLots: report.fifoAndPnl.matchedLots.length,
    unmatchedBuys: report.fifoAndPnl.unmatchedBuys,
    unmatchedSells: report.fifoAndPnl.unmatchedSells,
    publicPnlStatus: report.fifoAndPnl.publicPnlStatus,
  })
  console.log('behaviorIntel:', {
    rotationStyle: report.behaviorIntel.rotationStyle.value,
    riskOnOff: report.behaviorIntel.riskOnOff.value,
    confidence: report.behaviorIntel.confidence,
  })
  console.log('windowCoverage:', report.windowCoverage)
  console.log('finalSummary:', report.finalSummary)
  console.log('normalizationErrors:', report.normalizationErrors.length)
}

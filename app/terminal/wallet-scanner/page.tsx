'use client'

// Wallet Scanner — restored Cortex-style UI (from commit 348d917) running on the ChainLens
// 180-Day Intelligence Engine (V2). Layout, styling, header, Deep Scan controls, CORTEX Wallet
// Read panel, and the Wallet Watchlist sidebar are all restored. The scan handler and every
// results-rendering section were rebuilt against the V2 report shape — none of the old profiler
// fields (walletPnlRead, publicRealizedPnlUsd, walletTradeStatsSummary, etc.) exist anymore, so
// the old PnL/trade-stats JSX could not be restored verbatim; it is replaced here by the
// equivalent V2 sections (portfolio, holdings, timelines, behaviorIntel, recoveryPolicy,
// windowCoverage, finalSummary).
//
// Admin Full Recovery / Smart Recovery buttons removed (UI cleanup) — both only ever triggered
// the same V2 deep scan as the Deep Scan button, since V2's runWalletScanV2() has no separate
// full_recovery/smart_recovery scan mode. Deep Scan remains the one real capability.
//
// QSTASH/WORKER REMOVAL, DISCLOSED (explicit instruction: remove all QStash/worker/job-poll
// infrastructure without touching scanner logic): this file previously started + polled a
// background job for BOTH modes (startDeepScanJob/startFullScanJob + pollScanJobUntilDone). That
// job/poll system (and QStash entirely) has been removed — both modes now call scanWalletV2()
// directly, a single synchronous request/response round trip, same as before the job/poll system
// existed. The incremental jobStatusMessage/scanProgress UI below has nothing left to populate it
// (no poll loop produces status updates anymore) — it now just shows a single loading state for
// the whole scan duration; the state variables are left in place, harmlessly always null, rather
// than touching the surrounding render/JSX structure. runWalletScanV2, runWalletScanV2Worker,
// holdingsEngine/pricingEngine/portfolioAssembler, /api/scan, /api/scan-v2, Clark AI, and
// /api/portfolio are untouched.

import { useEffect, useRef, useState } from 'react'
import { usePlanWithLoading, LockedPanel, canAccessFeature, PlanGateSkeleton } from '@/lib/usePlan'
import { deepScanRemainingLabel, deepScanQuotaPeriod, scanDailyLimitReachedMessage } from '@/lib/pricingPlans'
import { checkWalletScanInput, robinhoodScanErrorBanner, walletScanErrorBanner } from '@/lib/walletAddressInput'
import { supabase } from '@/lib/supabaseClient'
import { scanWalletV2, pollWalletScanJob, type WalletScanStageProgress, type WalletChainSelectionAudit, type ScanWalletStatusUpdate } from '@/app/frontend/api/scanWallet'
import { logEngineConsistencyIfDev } from '@/app/frontend/lib/engineConsistencyCheck'
import { logScanIdentityIfDev } from '@/app/frontend/lib/walletScanIdentity'
import { resolvePreservedResultOnScanStart } from '@/app/frontend/lib/walletScanPreservation'
import { savePortfolioScanResult } from '@/app/frontend/lib/portfolioSharedCache'
import { computeMergedTotalValueUsd, deriveCanonicalMergeOverride, deriveEvmPortfolioEvidence, computeRobinhoodDisplayState, mergedCoverageText, mergedTotalText, canonicalPricedTokenCount, resolveRobinhoodResultOnJobComplete, resolveRobinhoodResultOnScanStart, buildWalletFinalPricingSummaryAudit } from '@/app/frontend/lib/mergedWalletView'
import type { PortfolioEvidence } from '@/lib/walletScan/portfolioEvidence'
import { fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { buildWalletReadV2, type WalletReadV2 } from '@/app/frontend/lib/walletReadBuilder'
import { selectScanWindow } from '@/app/frontend/lib/scanWindow'
import { buildWalletPnlViewModel } from '@/app/frontend/lib/buildWalletPnlViewModel'
import {
  BehaviorIntelView,
  ChainSelectionView,
  CoverageTimelineCard,
  FinalSummaryView,
  SellActivitySummary,
  ScanDiagnosticsCard,
  HoldingsViewV2,
  PnlStatusCard,
  selectEvmPnlLaneStatus,
  selectRobinhoodPnlLaneStatus,
  selectPnlConfidenceStatus,
  selectPortfolioStats,
  selectChainBreakdown,
  deriveActivityWindow,
  RecoveryHealthCard,
  RobinhoodChainSection,
  SectionDivider,
  WalletProfileHeader,
  WalletReadPanel,
  WalletScannerResultsV3,
} from '@/app/frontend/components'
import type { RobinhoodWalletScanResponse } from '@/app/frontend/components/RobinhoodChainSection'
import { toRobinhoodWalletScanResponse } from '@/lib/walletScan/canonicalWalletSelectors'
import type { FinalReport } from '@/src/modules/finalReportAssembler/types'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import type { Portfolio as EnginePortfolioV2 } from '@/lib/engine/modules/portfolio/types'
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'
import type { PnlV2, WalletPnlEvidenceAudit } from '@/lib/engine/modules/pnl/types'
import type { ChainActivityRecord } from '@/lib/engine/modules/activity/types'
import type { SmartMoneyScore } from '@/lib/engine/modules/smartMoney/types'
import type { PersonalityV2 } from '@/lib/engine/modules/personality/types'
import type { BehaviorV2 } from '@/lib/engine/modules/behavior/types'
import type { RiskV2 } from '@/lib/engine/modules/risk/types'
import type { SignalV2 } from '@/lib/engine/modules/signals/types'
import type { WalletConditionSection } from '@/src/pipeline/walletConditionMessages'
import type { LiquidityActivitySummary } from '@/src/lib/liquidityLegGuard'
import type { WalletLpPositionsSummary } from '@/src/lib/walletLpPositions'
import type { PnlReconciliationSummary } from '@/src/lib/pnlReconciliation'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'

// PORTFOLIO V2 MIGRATION, UPDATED DISCLOSURE: `portfolioV2` (the new engine's Portfolio shape —
// categories/chains/topHoldings/stablecoinRatio/concentrationIndex — structurally different from
// the old `portfolio: PortfolioSummary` above) is a genuinely optional, additive field. Previously
// this comment disclosed that it would always be undefined because scanWalletV2() called the V1
// job route instead of /api/scan-v2/full-scan. That gap was closed, and both scan modes now go
// through the job/poll system (see this file's own header) whose worker still ultimately dispatches
// to workers/walletScanV2.ts, which always computes portfolioV2. The fallback to the old
// `portfolio` field below is kept as a genuine safety net (still real, still used if this field is
// ever absent for any reason), not because this path is unreachable.
//
// PNL V2 / CHAIN ACTIVITY V2, UPDATED DISCLOSURE: same fix applies to `pnlV2`/`chainActivityV2` —
// both are now genuinely populated by the same always-called route.
export type WalletV2Report = FinalReport & {
  holdings: TokenHolding[]
  portfolio: PortfolioSummary
  portfolioV2?: EnginePortfolioV2
  // CANONICAL PRICED HOLDINGS, DISCLOSED (Holdings V2 display consistency fix): workers/
  // walletScanV2.ts already attaches these to the API response (`pricing.pricedHoldings`/
  // `pricing.chainValueUsd` — the exact same values `portfolioV2.totalValueUsd` is built from) —
  // previously never read by this page, which instead passed the OLD, separately-fetched
  // `holdings: TokenHolding[]` into HoldingsViewV2, the confirmed root cause of Holdings V2
  // disagreeing with the Portfolio Intelligence/hero totals for the same scan. See
  // app/frontend/lib/holdingsV2Selector.ts's own header for the full trace.
  pricedHoldings?: PricedHolding[]
  chainValueUsd?: Record<number, number>
  pnlV2?: PnlV2
  // WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED — workers/walletScanV2.ts attaches this alongside
  // pnlV2 (lib/engine/modules/pnl/computePnl.ts's own evidence audit: closed-lot/quote-leg-recovery
  // counters + finalPnlStatus + a human failureReason). Optional/omittable — a scan that hasn't run
  // through the updated worker simply has no specific reason text (PnlStatusCard falls back to its
  // existing generic message).
  walletPnlEvidenceAudit?: WalletPnlEvidenceAudit
  chainActivityV2?: ChainActivityRecord[]
  // SMART-MONEY-SCORE WIRING, DISCLOSED (added per a later task): same real gap as portfolioV2/
  // chainActivityV2 above — only ever populated by app/api/scan-v2/full-scan/route.ts.
  smartMoneyScore?: SmartMoneyScore
  // WALLET PERSONALITY CARD WIRING, DISCLOSED (Wallet Personality task): these four V2 engine
  // outputs (lib/engine/modules/personality|behavior|risk|signals) exist as real, already-built
  // modules but — same real gap as portfolioV2/smartMoneyScore above — are not currently populated
  // by the live /api/wallet-scan route this page actually calls (confirmed by search before adding
  // these fields: no reference to them anywhere in src/modules/walletScanWorker.ts or its callers).
  // Declared optional here so WalletPersonalityCard can consume them WHEN present (a future wiring
  // task, or an older/different response shape) without ever assuming they exist — its own
  // behaviorIntel/fifoAndPnl/finalSummary-derived fallback is what the live route actually exercises
  // today. See app/frontend/lib/walletPersonality.ts's own header for the full trace.
  personalityV2?: PersonalityV2
  behaviorV2?: BehaviorV2
  riskV2?: RiskV2
  signalsV2?: SignalV2[]
  // WALLET CONDITION MESSAGES, DISCLOSED: additive top-level field on RunWalletScanResult (src/
  // pipeline/types.ts), populated by runWalletScan() itself — not part of FinalReport's own
  // protected type, same pattern as normalizationErrors. Optional because the synthetic runtime-
  // test harness path (unrelated to this real route) returns an empty array, and any older cached
  // response predating this field simply won't have it.
  walletConditionMessages?: WalletConditionSection[]
  // Liquidity activity kept out of PnL, and open LP positions (src/lib/liquidityLegGuard.ts,
  // src/lib/walletLpPositions.ts) — absent on reports from before they existed.
  liquidityActivity?: LiquidityActivitySummary
  lpPositions?: WalletLpPositionsSummary
  // BOUNDED-SAMPLE UI WIRING, DISCLOSED (bounded-PnL-UI follow-up task): additive top-level field on
  // RunWalletScanResult (src/pipeline/types.ts) — real at runtime for every scan (finalReportAssembler
  // always attaches it), only newly declared here so PnlStatusCard can read the real verified-lot-
  // count/pricing-coverage/warning disclosure for a 'limited_verified_sample' result.
  reconciliationSummary?: PnlReconciliationSummary
  // FAIL-CLOSED SHARED STATE, DISCLOSED (canonical-manifest-fast-path follow-up task, issue #3):
  // real additive field on RunWalletScanResult (src/pipeline/types.ts) never declared here before,
  // so PnlStatusCard/SmartMoneyScoreCard had no way to read it from this page at all. Optional — an
  // older cached response predating this field degrades to today's existing behavior unchanged.
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit
  // CANONICAL MULTI-CHAIN MERGE, DISCLOSED (final-canonical-merge-proof follow-up): additive fields
  // workers/walletScanV2.ts attaches to the deep-scan job's own `body.data` once the core scan
  // completes — present only for a scan that went through the async job worker (the fast preview
  // path never sets these). When present, `canonicalTotalValueUsd`/`canonicalChainsScanned` are the
  // AFTER-Robinhood-merge total/chain list (real EVM total plus a real, non-null Robinhood result —
  // never fabricated, never double-counted with the separate Robinhood fetch this page also makes).
  // `finalCanonicalMergeAudit` is the full, honest proof object: whether Robinhood was selected, the
  // adapter (scanRobinhoodWallet()) actually attempted, what it returned, and whether it was really
  // merged — never claiming inclusion beyond what the adapter actually produced.
  robinhood?: { holdings: unknown; activity: unknown; pnl: unknown; audit: unknown } | null
  canonicalChainsScanned?: string[]
  canonicalTotalValueUsd?: number | null
  /** lib/walletScan/portfolioEvidence.ts — the worker's EVM lane and merged evidence (absent on older reports). */
  evmPortfolioEvidence?: PortfolioEvidence | null
  canonicalPortfolioEvidence?: PortfolioEvidence | null
  portfolioTotalByChain?: Record<string, number>
  finalCanonicalMergeAudit?: {
    evmWorkerChains: number[]
    robinhoodSelected: boolean
    robinhoodAdapterAttempted: boolean
    robinhoodAdapterStatus: string
    robinhoodValueUsd: number | null
    robinhoodHoldingsCount: number
    robinhoodPricedHoldingsCount: number
    robinhoodUnpricedHoldingsCount: number
    robinhoodMerged: boolean
    portfolioTotalByChainBeforeMerge: Record<string, number>
    portfolioTotalByChainAfterMerge: Record<string, number>
    finalTotalValueUsd: number | null
    finalChainsScanned: string[]
    uiChainsDisplayed: string[]
    cortexChainsDisplayed: string[]
    droppedReason: string | null
  }
}

type WatchlistWallet = {
  id?: string
  address: string
  label?: string | null
  portfolio_value?: number | null
  chain_mode?: string | null
}

// Example wallets for the pre-scan "Try an example" chips — public, well-known addresses; a chip
// only fills the input, it never starts a scan on its own.
const EXAMPLE_WALLETS: ReadonlyArray<{ label: string; address: string }> = [
  { label: 'vitalik.eth', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  { label: 'Vitalik (legacy)', address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B' },
]

// Watchlist size tag from the saved portfolio value — same thresholds as the scan's own
// walletCategory (lib/server/v2Adapters.ts): < $10k Small, < $250k Mid, otherwise Whale.
function watchlistSizeTag(valueUsd: number): 'Small' | 'Mid' | 'Whale' {
  return valueUsd >= 250_000 ? 'Whale' : valueUsd >= 10_000 ? 'Mid' : 'Small'
}

// FEATURE ROLLOUT, DISCLOSED (Wallet Scanner V3 layout task): a plain module-level constant, not a
// new environment variable or feature-flag service — this codebase has no existing feature-flag
// pattern (confirmed by search before adding this). Flip to `false` for an instant rollback to the
// old, unmodified layout below; the old JSX is left fully intact, not deleted, specifically so this
// rollback stays available. WalletScannerResultsV3 reuses the exact same `result` data and the exact
// same handlers already defined below — no new network calls, no new calculations.
const WALLET_SCANNER_UI_V3 = true

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

// WATCHLIST USD, DISCLOSED (reported live: saving a ~$150k wallet stored ~$20k). Root cause: the
// Save button persisted `portfolioV2.totalValueUsd` (EVM-only) while the hero total the user sees
// is computeMergedTotalValueUsd (EVM + Robinhood, plus the worker canonical override). Watchlist
// value must be that same merged USD figure — never a token count, never a single-chain subset.
function watchlistPortfolioValueUsd(
  report: WalletV2Report | null | undefined,
  robinhood: RobinhoodWalletScanResponse | null | undefined,
): number | null {
  if (!report) return null
  const { stats } = selectPortfolioStats(report.portfolio, report.portfolioV2)
  const merged = computeMergedTotalValueUsd(stats.totalValueUsd, robinhood, deriveCanonicalMergeOverride(report), deriveEvmPortfolioEvidence(report))
  const v = merged.totalValueUsd
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// WALLET READ BUILDER CALL SITE, DISCLOSED (Wallet Read / CORTEX sidebar redesign task): replaces
// the old flat {verdict, read, keySignals, risks, nextAction} shape with the structured WalletReadV2
// object walletReadBuilder.ts's buildWalletReadV2 produces — see that file's own header for the
// full "every field is a real, already-computed value, same selectors as the main UI" disclosure.
// This function's OWN job is now just: call the same selectors the main Wallet Scanner components
// already call (selectPortfolioStats, selectChainBreakdown, selectEvmPnlLaneStatus/
// selectRobinhoodPnlLaneStatus/selectPnlConfidenceStatus, computeMergedTotalValueUsd/
// deriveCanonicalMergeOverride/computeRobinhoodDisplayState), then hand their real outputs to the
// pure builder — never a second, independently-derived number.
//
// V2-SAFE GUARD: `report` is typed as non-optional, but that is a compile-time contract only —
// a real API response can still be malformed/partial at runtime, so every nested access here is
// defensively guarded rather than assumed present.
function buildCortexReadV2(
  report: WalletV2Report | null | undefined,
  robinhoodResult?: RobinhoodWalletScanResponse | null,
): WalletReadV2 | null {
  if (!report) return null
  const b = report.behaviorIntel

  // CONFIRMED REGRESSION, FIXED (same root cause as WalletProfileHeader.tsx's PortfolioSnapshot —
  // see that file's own header comment for the full trace): prefer the canonical, real
  // portfolioV2.totalValueUsd over the stale V1 `portfolio.totalValueUsd` field, so this sidebar
  // readout can never disagree with the main hero total for the same scan.
  const { stats } = selectPortfolioStats(report.portfolio, report.portfolioV2)
  // ONE CANONICAL RESULT, DISCLOSED (split-Wallet-Scanner-results fix task): the CORTEX Wallet Read
  // panel used to read only the V2 (Base/ETH) total, never Robinhood's — a real wallet with a
  // scanned, nonzero Robinhood balance would show a DIFFERENT, lower "Portfolio value" here than the
  // main result card two feet to its left. Now reads through the SAME merge helper every other
  // canonical-total display uses (see app/frontend/lib/mergedWalletView.ts).
  const merged = computeMergedTotalValueUsd(stats.totalValueUsd, robinhoodResult, deriveCanonicalMergeOverride(report), deriveEvmPortfolioEvidence(report))
  // SAME CHAIN BARS THE MAIN UI RENDERS, DISCLOSED: selectChainBreakdown is the exact function
  // WalletProfileHeader.tsx's PortfolioSnapshot uses for the hero chain bars — reused verbatim here
  // (same priority: canonical portfolioTotalByChain first) so "Largest chain exposure" can never
  // show a different top chain than the main UI's own bars.
  const chainBreakdown = selectChainBreakdown(report.chainValueUsd, merged.totalValueUsd, report.portfolio?.chainValueBreakdown, report.portfolioTotalByChain)
  const robinhoodDisplayState = computeRobinhoodDisplayState(robinhoodResult)

  // PNL LANE STATUS, DISCLOSED (Wallet-Scanner-Robinhood-final-integration follow-up, this task's own
  // explicit requirement 6 — "CORTEX must use same PnL lane statuses"): calls the EXACT SAME two
  // exported selectors PnlStatusCard.tsx itself uses for its own per-chain lane badges
  // (WalletScannerSummaryRowV3's real, live PnlStatusCard call site — same report fields, same
  // robinhoodResult), so this sidebar can never disagree with the main PnL card on lane status. Never
  // shown as "verified" for Robinhood unless selectRobinhoodPnlLaneStatus itself says so (the same
  // Phase-3-gated, verifiedSwapCount>0 check the main card's RobinhoodPnlRow uses).
  const evmPnlLane = selectEvmPnlLaneStatus({
    pnlV2: report.pnlV2,
    publicPnlStatus: report.finalSummary?.financialStatus?.officialPnlStatus,
    unrealizedReconciliation: report.fifoAndPnl?.unrealizedReconciliation,
    reconciliationSummary: report.reconciliationSummary,
    canonicalSampleManifestAudit: report.canonicalSampleManifestAudit,
  })
  const robinhoodPnlLane = selectRobinhoodPnlLaneStatus(robinhoodResult)
  const pnlConfidence = selectPnlConfidenceStatus(
    report.finalSummary?.financialStatus?.officialPnlStatus,
    report.fifoAndPnl?.unrealizedReconciliation,
    report.reconciliationSummary,
  )
  const { lastActiveMs } = deriveActivityWindow(report)

  // SHARED PNL VIEW MODEL, DISCLOSED (Smart Money Score + PnL Evidence UI simplification task):
  // the SAME selector WalletScannerSummaryRowV3's own PnlStatusCard calls, with the SAME real report
  // fields — see buildWalletPnlViewModel.ts's own header for the "one selector, no new PnL math"
  // disclosure. This is what lets CORTEX's sidebar state the exact same combined status/reason as
  // the main PnL Evidence card for this scan.
  const pnlViewModel = buildWalletPnlViewModel({
    pnlV2: report.pnlV2,
    publicPnlStatus: report.finalSummary?.financialStatus?.officialPnlStatus,
    unrealizedReconciliation: report.fifoAndPnl?.unrealizedReconciliation,
    reconciliationSummary: report.reconciliationSummary,
    canonicalSampleManifestAudit: report.canonicalSampleManifestAudit,
    robinhoodResult,
    chainsScanned: Array.isArray(report.scanMetadata?.chainsScanned) ? report.scanMetadata.chainsScanned : [],
    walletPnlEvidenceAudit: report.walletPnlEvidenceAudit,
  })

  return buildWalletReadV2({
    walletAddress: report.scanMetadata?.walletAddress,
    scanTimestamp: report.scanMetadata?.scanTimestamp,
    chainsScanned: Array.isArray(report.scanMetadata?.chainsScanned) ? report.scanMetadata.chainsScanned : [],
    behaviorIntel: b,
    finalSummary: report.finalSummary,
    totalValueUsd: merged.totalValueUsd,
    portfolioEvidence: merged.evidence,
    robinhoodIncluded: merged.robinhoodIncluded,
    chainBreakdown,
    pricedTokenCount: canonicalPricedTokenCount(merged, stats.pricedTokenCount + (merged.robinhoodIncluded && robinhoodResult?.ok ? robinhoodResult.holdings.holdings.filter((h) => h.valueUsd != null).length + (robinhoodResult.holdings.native?.valueUsd != null ? 1 : 0) : 0)),
    concentrationDetail: stats.concentration?.detail ?? null,
    concentrationLabel: b?.concentrationSignals?.concentrationLabel ?? null,
    matchedLotsCount: report.fifoAndPnl?.matchedLots?.length ?? 0,
    lastActiveMs,
    evmPnlLane,
    robinhoodPnlLane,
    robinhoodDisplayState,
    robinhoodResult,
    pnlConfidence,
    pnlViewModel,
    smartMoneyStatus: report.smartMoneyScore?.status ?? null,
    lpStrategyWallet: report.liquidityActivity?.lpStrategyWallet ?? false,
    scanWindow: selectScanWindow(report),
  })
}

// STAGED-REFRESH FIX, DISCLOSED (provider-call-audit follow-up task, explicit "refresh keeps
// previous total until canonical portfolio stage resolves" requirement, and "staged refresh does
// not replace prior total with partial subtotal" test requirement): pure so it can be unit-tested
// directly. A scan of the SAME wallet already on screen keeps its last-known-good, fully-resolved
// report visible (never a partial/staged intermediate — this only decides whether to keep the PRIOR
// complete result, it never constructs a new partial one); a scan of a genuinely different wallet
// (or no prior result at all) starts from null, so a wallet's total can never be shown while a
// DIFFERENT wallet is being scanned.

// STUCK-SCANNING-LIFECYCLE FIX, DISCLOSED (bug report: "Wallet Scanner starts scan and finds
// portfolio value/holdings, but UI stays stuck on SCANNING.../Checking activity.../Deep scan still
// running/CORTEX reading wallet activity... — never cleanly transitions to completed result").
//
// ROOT CAUSE: the backend job/poll pipeline (app/frontend/api/scanWallet.ts's scanWalletV2, and
// workers/walletScanV2.ts's per-module runWithTimeoutAndRpcAudit/WORKER_GLOBAL_TIMEOUT_MS) already
// bounds every stage and always eventually reaches a terminal 'done'/'failed' job status or a
// client-side poll timeout — it does not hang forever at the storage/queue layer. The actual stuck
// UI came from this PAGE: every "still scanning" surface (the scan button's disabled state, the
// CORTEX Wallet Read sidebar's "reading…" text, the input's disabled state) was gated on the single
// monolithic `loading` flag, which only flips false once the ENTIRE scanWalletV2() promise settles —
// i.e. once ALL 11 backend modules (holdings/pricing/portfolio/trades/pnl/activity/risk/personality/
// behavior/signals/smartMoney) have run, even though holdings/pricing/portfolio (the real "does this
// wallet have a result" signal) are already known via the worker's own early `partial` snapshot
// (publishWalletScanPartialSnapshot) long before PnL/activity/CORTEX finish. A slow or degraded
// PnL/activity/CORTEX stage therefore kept the WHOLE page pinned on generic "scanning" copy for up
// to the full ~270s worker budget, which reads to a user as "stuck forever" even though the request
// was technically still in flight and would eventually resolve.
//
// FIX: `limitedEvidenceMode` (state below) is a UI-only flag, independent of `loading` — once the
// worker's own partial snapshot proves holdings/pricing/portfolio are ready (see the onUpdate
// callback in handleScan) and PORTFOLIO_READY_GRACE_MS elapses without the full result landing, the
// scan/rescan button and the CORTEX panel stop presenting a blocking "scanning" state and instead
// show a real "Scan completed with limited evidence" state built from the verified partial
// snapshot, with an explicit "Retry deep scan" action — never a fabricated $0 or a fabricated PnL
// value. The underlying poll keeps running in the background so a genuinely fast PnL/activity finish
// can still upgrade the view to the full result; `scanGenerationRef` ensures a stale background
// resolution (or one superseded by the user starting a fresh scan) can never clobber newer state.
const PORTFOLIO_READY_GRACE_MS = 45_000
// Job-backed Robinhood request: polls 202s every ~2.5s for at most ~2 minutes (the job's final report also settles it).
const ROBINHOOD_JOB_POLL_MAX_ATTEMPTS = 48

// walletScanStageState / walletScanLifecycleAudit, DISCLOSED: the task-specified shapes, derived
// (never independently computed/guessed) from the same real signals this page already tracks —
// partialSnapshot (holdings/pricing/portfolio), result (the full report, which also carries the
// real pnlV2/chainActivityV2/pnlStatus fields), loading/limitedEvidenceMode, and error. Exported so
// this derivation can be unit-tested directly instead of only exercised through the full page.
export type WalletScanStageStatus = 'pending' | 'ready' | 'failed'
export type WalletScanPnlStageStatus = 'pending' | 'verified' | 'partial' | 'unavailable'
export type WalletScanActivityStageStatus = 'pending' | 'ready' | 'failed' | 'unavailable'
export type WalletScanCortexStageStatus = 'pending' | 'ready' | 'skipped' | 'failed'
export type WalletScanFinalStatus = 'scanning' | 'portfolio_ready_processing' | 'completed' | 'completed_with_limited_evidence' | 'failed' | 'stalled'

export type WalletScanStageState = {
  holdings: WalletScanStageStatus
  pricing: WalletScanStageStatus
  portfolio: WalletScanStageStatus
  activity: WalletScanActivityStageStatus
  pnl: WalletScanPnlStageStatus
  cortex: WalletScanCortexStageStatus
  finalStatus: WalletScanFinalStatus
}

export function deriveWalletScanStageState(params: {
  loading: boolean
  limitedEvidenceMode: boolean
  hasPartialSnapshot: boolean
  hasResult: boolean
  pnlStatus: string | null | undefined
  chainActivityV2Present: boolean
  hasError: boolean
  timeoutHit: boolean
}): WalletScanStageState {
  const { loading, limitedEvidenceMode, hasPartialSnapshot, hasResult, pnlStatus, chainActivityV2Present, hasError, timeoutHit } = params

  // Holdings/pricing/portfolio are ready the moment either the worker's own partial snapshot
  // (published before PnL/activity even start) or the full result exists — never gated on PnL.
  const portfolioSignalReady = hasPartialSnapshot || hasResult
  const holdings: WalletScanStageStatus = portfolioSignalReady ? 'ready' : hasError && !loading ? 'failed' : 'pending'
  const pricing: WalletScanStageStatus = holdings
  const portfolio: WalletScanStageStatus = holdings

  // While the job is still live (`loading`: the poll is still running), a section without a result is
  // still processing — never "unavailable" just because the portfolio grace period passed.
  const pnl: WalletScanPnlStageStatus = !hasResult
    ? (loading ? 'pending' : 'unavailable')
    : pnlStatus === 'verified' ? 'verified'
    : pnlStatus === 'partial' ? 'partial'
    : pnlStatus === 'unavailable' ? 'unavailable'
    // Heavy wallet: PnL runs in a follow-up job (workers/walletScanV2.ts) — still processing.
    : pnlStatus === 'deferred_heavy_wallet' ? 'pending'
    // A completed result with no explicit pnlStatus field still carries real pnlV2 numbers —
    // treat as verified rather than a fabricated "pending" on an already-finished scan.
    : 'verified'

  const activity: WalletScanActivityStageStatus = !hasResult
    ? (loading ? 'pending' : 'unavailable')
    : chainActivityV2Present ? 'ready' : 'unavailable'

  const cortex: WalletScanCortexStageStatus = hasResult ? 'ready' : (loading ? 'pending' : 'skipped')

  const finalStatus: WalletScanFinalStatus =
    hasResult ? 'completed'
      : hasError && !loading ? (timeoutHit ? 'stalled' : 'failed')
      : limitedEvidenceMode && loading ? 'portfolio_ready_processing'
      : limitedEvidenceMode ? 'completed_with_limited_evidence'
      : 'scanning'

  return { holdings, pricing, portfolio, activity, pnl, cortex, finalStatus }
}

export type WalletScanLifecycleAudit = {
  walletAddress: string
  jobId: string | null
  requestedMode: 'normal' | 'deep'
  stage: string
  holdingsReady: boolean
  pricingReady: boolean
  portfolioReady: boolean
  activityReady: boolean
  pnlReady: boolean
  cortexReady: boolean
  workerStatus: string | null
  pollingStatus: 'polling' | 'stopped'
  lastProgressAt: number | null
  elapsedMs: number
  timeoutHit: boolean
  finalStatus: WalletScanFinalStatus
  failureReason: string | null
}

export function buildWalletScanLifecycleAudit(params: {
  walletAddress: string
  jobId: string | null
  requestedMode: 'normal' | 'deep'
  stageState: WalletScanStageState
  workerStatus: string | null
  polling: boolean
  lastProgressAt: number | null
  scanStartedAt: number
  timeoutHit: boolean
  failureReason: string | null
}): WalletScanLifecycleAudit {
  const { walletAddress, jobId, requestedMode, stageState, workerStatus, polling, lastProgressAt, scanStartedAt, timeoutHit, failureReason } = params
  return {
    walletAddress,
    jobId,
    requestedMode,
    stage: stageState.finalStatus,
    holdingsReady: stageState.holdings === 'ready',
    pricingReady: stageState.pricing === 'ready',
    portfolioReady: stageState.portfolio === 'ready',
    activityReady: stageState.activity === 'ready' || stageState.activity === 'unavailable',
    pnlReady: stageState.pnl === 'verified' || stageState.pnl === 'partial' || stageState.pnl === 'unavailable',
    cortexReady: stageState.cortex === 'ready' || stageState.cortex === 'skipped',
    workerStatus,
    pollingStatus: polling ? 'polling' : 'stopped',
    lastProgressAt,
    elapsedMs: Date.now() - scanStartedAt,
    timeoutHit,
    finalStatus: stageState.finalStatus,
    failureReason,
  }
}

// ATOMIC SCAN ENVELOPE, DISCLOSED (live-value staleness task): the report and the identity of the
// scan that produced it are held in ONE state value, always replaced wholesale — see
// app/frontend/lib/walletScanIdentity.ts's own header for the confirmed root cause this closes.
// Because no code path can update `report` without also updating `jobId`/`completedAt`, every
// component reading from one envelope is reading exactly one completed scan, and a nested field
// from a previous scan can never survive into a new result.
export type WalletScanEnvelope = {
  report: WalletV2Report
  jobId: string | null
  completedAt: number
}

// ROBINHOOD CHAIN WALLET SCANNER, RELOCATED DISCLOSURE (split-Wallet-Scanner-results fix task):
// RobinhoodWalletScanResponse / ROBINHOOD_CHAIN_META / RobinhoodChainSection used to be defined
// inline here and rendered as a separate, competing top-level card producing a second portfolio
// total for the same wallet. They now live in
// app/frontend/components/RobinhoodChainSection.tsx (imported above) and render as ONE MORE CHAIN
// TAB inside the same Wallet Scanner result (WalletScannerTabsV3.tsx), merged via
// app/frontend/lib/mergedWalletView.ts. See those files' own headers for the full trace.

export default function WalletScannerPage() {
  const { plan, loading: planLoading, betaEliteActive } = usePlanWithLoading()

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  // DUPLICATE-CLICK GUARD, DISCLOSED (button-responsiveness task): a ref, not just the `loading`
  // state var — `disabled={loading || ...}` on the button only takes effect after React re-renders,
  // leaving a real window (e.g. a fast double-click, or Enter+click racing) where handleScan could
  // be invoked twice before the first call's setLoading(true) has painted. The ref updates
  // synchronously, closing that window without touching any scan/decoder logic — same pattern
  // already proven in Token Scanner's scanInFlightRef.
  const scanInFlightRef = useRef(false)
  // SELF-HEALING RELEASE, DISCLOSED: mirrors Token Scanner's own scanInFlightRef pattern — handleScan
  // has early-return paths (empty address, deep-scan session not loaded yet) that never reach
  // setLoading(true)/finally's setLoading(false). Rather than resetting the ref on every individual
  // early return, this effect releases it whenever `loading` goes false for any reason, so the guard
  // can never get stuck permanently blocking future scans.
  useEffect(() => { if (!loading) scanInFlightRef.current = false }, [loading])
  // LIMITED-EVIDENCE MODE, DISCLOSED (stuck-scanning-lifecycle fix — see this file's own header
  // comment above WalletScanEnvelope for the full trace): a UI-only flag, deliberately independent
  // of `loading`. Set once the worker's own partial snapshot has proven holdings/pricing/portfolio
  // are ready and PORTFOLIO_READY_GRACE_MS has elapsed with no full result yet — never touches the
  // in-flight request itself (the background poll keeps running and can still upgrade the view to a
  // full completed result). `scanGenerationRef` lets a stale background resolution from a scan the
  // user has since superseded (by starting a fresh one while this flag was true) be silently
  // ignored instead of clobbering the newer scan's state.
  const [limitedEvidenceMode, setLimitedEvidenceMode] = useState(false)
  const scanGenerationRef = useRef(0)
  const [jobStatusMessage, setJobStatusMessage] = useState<string | null>(null)
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  // STAGE PROGRESS, DISCLOSED (perceived-speed follow-up task — replaces the previously-dead
  // {currentModule,totalModules,moduleName} shape this state used to hold: that shape was reported
  // by workers/walletScanV2.ts to a DIFFERENT job-record namespace [src/modules/scanJobs.ts] the
  // live poll route this page actually calls never reads — see this file's own now-stale header
  // comment above and app/frontend/api/scanWallet.ts's WalletScanStageProgress for the real,
  // currently-wired source: app/api/wallet-scan/[jobId]/route.ts's own job-record `progress` field,
  // written by the SAME worker via src/modules/walletScanQueue.ts's updateWalletScanJobProgress).
  // Real, six-literal-label stage text and a real elapsed-ms figure, never fabricated.
  const [scanProgress, setScanProgress] = useState<WalletScanStageProgress | null>(null)
  // LIVE SCAN CLOCK: client-side elapsed time plus the last real stage and the last time the worker
  // reported in (server heartbeat), so a slow or stuck scan is visible instead of a silent spinner.
  const [scanClock, setScanClock] = useState<{ startedAt: number; lastWorkerUpdateAt: number | null; stageLabel: string | null } | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const lastScanModeRef = useRef<'normal' | 'deep'>('normal')
  useEffect(() => {
    if (!loading) return
    const id = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [loading])
  const [partialSnapshot, setPartialSnapshot] = useState<NonNullable<ScanWalletStatusUpdate['partial']> | null>(null)
  const uiFirstResultMsRef = useRef<number | null>(null)
  const robinhoodSidecarDurationMsRef = useRef<number | null>(null)
  // The jobId whose Robinhood result is still being awaited (null once delivered or superseded).
  const robinhoodJobRef = useRef<string | null>(null)
  // The job whose job-backed Robinhood request produced the current robinhoodResult (null: standalone / none).
  const robinhoodResultJobRef = useRef<string | null>(null)
  // The most recent scan job; a job-backed Robinhood response for any other job is superseded.
  const latestScanJobRef = useRef<string | null>(null)
  // CHAIN SELECTION AUDIT, DISCLOSED (Wallet Scanner deep scan chain coverage fix): the real,
  // canonical requested/allowed/omitted chain decision (including Robinhood's numeric chain id,
  // 4663, when relevant) echoed back from the /api/wallet-scan POST response — captured here so
  // it's real, observable evidence for this specific scan, not just a server log line the UI
  // never shows.
  const [chainSelectionAudit, setChainSelectionAudit] = useState<WalletChainSelectionAudit | null>(null)
  // MODULE ERRORS, ADDED DISCLOSED (stuck-at-module-11 task): mirrors the optional `moduleErrors`
  // field the completed job's status carries (see app/frontend/api/scanWallet.ts) — captured off
  // the same onUpdate callback that already fires on the final 'completed' status before
  // pollScanJobUntilDone returns. Purely additive: rendered in its own small section, does not
  // touch the existing result/error/loading blocks below.
  const [moduleErrors, setModuleErrors] = useState<Record<string, string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Heavy wallet: the first result carries holdings/portfolio; PnL and the full analysis arrive from a
  // follow-up job (pnlFollowUpJobId) that replaces the result when it finishes.
  const [pnlFollowUp, setPnlFollowUp] = useState<{ jobId: string | null; status: 'processing' | 'failed' | 'not_queued' } | null>(null)
  // ATOMIC ENVELOPE STATE, DISCLOSED: `result` below is derived read-only from this single envelope
  // — there is deliberately no separate setResult(), so a report can never be swapped without its
  // scan identity going with it. See WalletScanEnvelope's own header for the root cause this closes.
  const [resultEnvelope, setResultEnvelope] = useState<WalletScanEnvelope | null>(null)
  const result = resultEnvelope?.report ?? null
  // SCAN DIAGNOSTICS, ADDITIVE/DISCLOSED: WalletV2Report carries no timing fields at all (no
  // totalMs/stagesMs/slowProviderDetected/jitterDetected — verified by search of
  // src/modules/finalReportAssembler/types.ts; a task once assumed these existed, they don't). The
  // only REAL timing signal available at this layer is this page's own measured wall-clock duration
  // around the scanWalletV2() call below — a real Date.now() delta, never a fabricated number.
  const [scanDurationMs, setScanDurationMs] = useState<number | null>(null)
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [watchlistStatus, setWatchlistStatus] = useState<'idle' | 'saving' | 'success' | 'exists' | 'error'>('idle')
  const [watchlistMessage, setWatchlistMessage] = useState<string | null>(null)
  const [watchlistWallets, setWatchlistWallets] = useState<WatchlistWallet[]>([])
  // ONE-CLICK WATCHLIST SCAN: the row's Scan button records the address and sets the input; once the
  // input state actually holds it, the effect below runs the unchanged handleScan() (which reads `input`).
  const pendingScanAddressRef = useRef<string | null>(null)
  useEffect(() => {
    if (pendingScanAddressRef.current == null || input !== pendingScanAddressRef.current) return
    pendingScanAddressRef.current = null
    void handleScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input])
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  // ROBINHOOD CHAIN WALLET SCANNER, DISCLOSED (phased Robinhood Chain Wallet Scanner rollout,
  // Phase 1+2 UI): deliberately its OWN state, own handler, own results card — never mixed into
  // `result`/`resultEnvelope`/`loading` above, which belong entirely to the existing Base/Ethereum
  // V2 pipeline (scanWalletV2). This block never touches those, so a Robinhood scan can never
  // clobber or be clobbered by a Base/ETH scan's state.
  const [robinhoodLoading, setRobinhoodLoading] = useState(false)
  const [robinhoodError, setRobinhoodError] = useState<string | null>(null)
  const [robinhoodResult, setRobinhoodResult] = useState<RobinhoodWalletScanResponse | null>(null)
  // Latest robinhoodResult for async handlers (their closures hold the value from when the scan started).
  const robinhoodResultRef = useRef<RobinhoodWalletScanResponse | null>(null)
  useEffect(() => { robinhoodResultRef.current = robinhoodResult }, [robinhoodResult])
  // DEBUG-ONLY RAW VIEW, DISCLOSED (multi-chain integration task's own "no separate custom page
  // unless debug=true" requirement): the normal Robinhood card UI below never depends on this — it
  // only gates an OPTIONAL raw-JSON troubleshooting block appended after the real cards, for anyone
  // who lands on this page with ?debug=true.
  const [debugMode, setDebugMode] = useState(false)
  const [watchlistDeleting, setWatchlistDeleting] = useState<string | null>(null)
  const [deepScanQuota, setDeepScanQuota] = useState<{ plan: string; limit: number | null; remaining: number | null } | null>(null)

  const isFullRecoveryAdmin = (signedInEmail ?? '').toLowerCase() === 'chainlensai@gmail.com'

  // QUERY-PARAM-PREFILL, DISCLOSED (Cluster Map "Run Deployer Wallet Scan" / "Open Wallet Scanner"
  // CTA fix): this page previously ignored any URL query string entirely — a navigation from Token
  // Scanner's Cluster Map with ?address=&chain= landed on an empty, unprefilled scanner. Mirrors
  // Token Scanner's own existing ?contract=/?chain= auto-fill effect. Deliberately prefills ONLY —
  // it never calls handleScan()/triggers a scan on its own, per the hard rule that a Cluster Map
  // click must never auto-run the (comparatively expensive) full Wallet Scanner.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const address = params.get('address')?.trim()
    // One-time prefill of the input field from the URL's ?address= param on mount; never re-fires,
    // never triggers a scan on its own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (address) setInput(address)
    if (params.get('debug') === 'true') setDebugMode(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSignedInEmail(data.session?.user?.email ?? null)
      setSessionLoaded(true)
    }).catch(() => {
      if (cancelled) return
      setSignedInEmail(null)
      setSessionLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  async function refreshDeepScanQuota(signal?: { cancelled: boolean }) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch('/api/wallet-scan/quota', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const json = await res.json().catch(() => null) as { plan?: string; limit?: number | null; remaining?: number | null } | null
      if (signal?.cancelled) return
      if (!json || typeof json !== 'object' || !('limit' in json) || !('remaining' in json)) return
      setDeepScanQuota({
        plan: typeof json.plan === 'string' ? json.plan : plan,
        limit: json.limit ?? null,
        remaining: json.remaining ?? null,
      })
    } catch {
      // Quota display is additive — a failed peek must never block Scan / Deep Scan.
    }
  }

  useEffect(() => {
    const signal = { cancelled: false }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- remaining deep-scan count for the Deep Scan button; never blocks Scan.
    void refreshDeepScanQuota(signal)
    return () => { signal.cancelled = true }
    // Re-peek when the resolved plan changes (sign-in / beta elite).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan])

  async function loadWalletWatchlist() {
    setWatchlistLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistWallets([])
        return
      }
      const res = await fetch('/api/watchlist/wallets', { headers: { Authorization: `Bearer ${token}` } })
      const json = await res.json().catch(() => null)
      if (res.ok) setWatchlistWallets(Array.isArray(json?.wallets) ? json.wallets : [])
    } finally {
      setWatchlistLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadWalletWatchlist()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  async function handleAddWalletToWatchlist() {
    if (!result?.scanMetadata?.walletAddress) return
    setWatchlistStatus('saving')
    setWatchlistMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistStatus('error')
        setWatchlistMessage('Sign in to add wallets to your watchlist.')
        return
      }
      const res = await fetch('/api/watchlist/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          address: result.scanMetadata.walletAddress,
          // Same merged USD the hero / CORTEX read show — never the EVM-only V2 field, never a
          // token quantity. Re-saving an already-watchlisted wallet updates this number.
          portfolio_value: watchlistPortfolioValueUsd(result, robinhoodResult),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setWatchlistStatus('error')
        setWatchlistMessage(json?.error ?? 'Could not add wallet to watchlist.')
        return
      }
      // RESPONSE-KEY FIX, DISCLOSED (wallet watchlist audit): the API (app/api/watchlist/wallets/
      // route.ts POST) has only ever returned `alreadyExists` — this checked a different,
      // never-returned `exists` key, so a re-save of an already-watchlisted wallet always fell
      // through to the "Added to watchlist" branch instead of "Already in watchlist".
      if (json?.alreadyExists) {
        setWatchlistStatus('exists')
        setWatchlistMessage('Already in watchlist')
      } else {
        setWatchlistStatus('success')
        setWatchlistMessage('Added to watchlist')
      }
      await loadWalletWatchlist()
    } catch {
      setWatchlistStatus('error')
      setWatchlistMessage('Could not add wallet to watchlist.')
    }
  }

  async function handleRemoveWalletFromWatchlist(address: string) {
    setWatchlistDeleting(address)
    setWatchlistMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setWatchlistStatus('error')
        setWatchlistMessage('Sign in to manage your watchlist.')
        return
      }
      const res = await fetch(`/api/watchlist/wallets?address=${encodeURIComponent(address)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setWatchlistStatus('error')
        setWatchlistMessage(json?.error ?? 'Could not remove wallet.')
        return
      }
      setWatchlistWallets((wallets) => wallets.filter((wallet) => wallet.address.toLowerCase() !== address.toLowerCase()))
      setWatchlistStatus('idle')
      setWatchlistMessage('Removed from watchlist')
    } catch {
      setWatchlistStatus('error')
      setWatchlistMessage('Could not remove wallet.')
    } finally {
      setWatchlistDeleting(null)
    }
  }

  // The only pipeline entry point this page calls. mode 'deep' also covers the two admin-only
  // buttons below, since V2 has no equivalent of the old full_recovery/smart_recovery scan modes.
  async function handleScan(mode: 'normal' | 'deep' = 'normal') {
    // ADDRESS GUARD (lib/walletAddressInput.ts): a malformed address is answered here — no scan request,
    // no Robinhood request, no loading state, one validation message (Scan and Deep Scan alike).
    const check = checkWalletScanInput(input)
    if (check.action === 'ignore') return
    if (check.action === 'reject') { setRobinhoodError(null); setError(check.message); return }
    const address = check.address
    // STUCK-SCANNING-LIFECYCLE FIX, DISCLOSED: a scan already in flight only blocks a new one while
    // it still LOOKS like it's scanning to the user (limitedEvidenceMode is false). Once portfolio
    // evidence is ready and the grace period has elapsed, the button is meant to work again — this
    // lets a rescan supersede the still-polling background request rather than being silently
    // dropped. scanGenerationRef below ensures the old request's eventual resolution can never
    // clobber the new scan's state once superseded this way.
    if (scanInFlightRef.current && !limitedEvidenceMode) return
    scanInFlightRef.current = true
    const myGeneration = ++scanGenerationRef.current
    setLimitedEvidenceMode(false)

    if (mode === 'deep') {
      // eslint-disable-next-line no-console
      console.log('[SCAN] Deep Scan triggered for', address)
      // eslint-disable-next-line no-console
      console.log('[SCAN] Deep Scan args:', address, ['base', 'eth'], mode)
    }

    if (mode === 'deep' && !sessionLoaded) {
      // SESSION-RACE-GUARD: never resolve "not admin" from an unloaded session.
      // Explicit release, DISCLOSED: this path never calls setLoading(true), so `loading` never
      // toggles — the [loading] self-healing effect above would never re-fire to release the ref,
      // permanently blocking every future scan click. Release it here directly instead.
      scanInFlightRef.current = false
      setError('Verifying your session — try again in a moment.')
      return
    }

    if (mode === 'deep' && deepScanQuota && deepScanQuota.limit != null && (deepScanQuota.remaining ?? 0) <= 0) {
      scanInFlightRef.current = false
      setError(scanDailyLimitReachedMessage(plan, deepScanQuota.limit))
      return
    }

    setLoading(true)
    lastScanModeRef.current = mode
    setScanClock({ startedAt: Date.now(), lastWorkerUpdateAt: null, stageLabel: null })
    setError(null)
    setPartialSnapshot(null)
    setPnlFollowUp(null)
    uiFirstResultMsRef.current = null
    robinhoodSidecarDurationMsRef.current = null
    const scanStartedAt = Date.now()
    // MULTI-CHAIN INTEGRATION, DISCLOSED (Robinhood UI integration task): a normal Scan now also
    // attempts Robinhood Chain automatically — the same "chain=auto includes every supported chain"
    // behavior Base/ETH already get, not a separate opt-in feature. Fire-and-forget: it runs on its
    // own independent state (robinhoodLoading/robinhoodError/robinhoodResult, untouched by this
    // function) and never blocks or gates the Base/ETH scan above — if Robinhood Chain isn't
    // configured on this deployment, resolveRobinhoodWalletHoldings/Activity already degrade to a
    // clean "not_configured" status (see lib/server/robinhoodWalletScanner.ts), so this is always
    // safe to fire unconditionally, never a guessed/loosened gate.
    // ONE ROBINHOOD PROVIDER SCAN PER USER SCAN: the Robinhood request now waits for this scan's jobId (below)
    // and reads the queued worker's own Robinhood result — it no longer starts a second, synchronous
    // provider scan of its own (which hit the route's 30s limit while the worker did the same work).
    let robinhoodRequestedForJob = false
    // STAGED-REFRESH FIX, DISCLOSED (provider-call-audit follow-up task, explicit "refresh keeps
    // previous total until canonical portfolio stage resolves" requirement): this previously
    // unconditionally cleared `result` to null the instant ANY scan (including a plain refresh of
    // the SAME wallet already on screen) started, blanking the whole results view — including the
    // correct, already-displayed total — for the full duration of the new scan, only to show the
    // exact same wallet's numbers again once it finished. Now only clears when the scan target is a
    // DIFFERENT wallet than the one currently displayed — a genuinely new lookup still starts from a
    // clean slate (never shows wallet A's total while scanning wallet B), but a refresh of the same
    // wallet keeps its last-known-good, fully-resolved total on screen until the new scan's own
    // canonical result replaces it wholesale (never a partial/staged intermediate value — the poll
    // loop below still only ever calls setResult once, with the final complete report).
    // PRESERVE-WHILE-REFRESHING, UNCHANGED: the previous envelope is kept only for a refresh of the
    // SAME wallet (resolvePreservedResultOnScanStart's own, separately-tested rule, applied here to
    // the envelope's report). The envelope is kept INTACT — never partially updated — so what stays
    // on screen is the complete previous scan with its own identity, not a hybrid.
    setResultEnvelope((prev) => (prev && resolvePreservedResultOnScanStart(prev.report, address) ? prev : null))
    setJobStatusMessage(null)
    setCurrentJobId(null)
    setScanProgress(null)
    setModuleErrors(null)
    setScanDurationMs(null)
    setChainSelectionAudit(null)
    // A previous scan's Robinhood lane may stay on screen only for the same wallet, and only until this job's
    // own Robinhood result settles it (resolveRobinhoodResultOnJobComplete below) — never another wallet's.
    setRobinhoodResult((prev) => resolveRobinhoodResultOnScanStart(prev, address))
    latestScanJobRef.current = null

    // SCAN IDENTITY CAPTURE, DISCLOSED: held in a local (not read back from `currentJobId` state,
    // which the finally-block below deliberately clears) so the completed report is bound to the
    // exact job that produced it, with no dependency on React state timing.
    let scanJobId: string | null = null
    try {
      // ACCESS TOKEN, FIXED (audit: wallet-scanner plan gate): the enqueue route now checks the
      // caller's plan server-side — forward the same access token every other authenticated call
      // in this file already reads via supabase.auth.getSession() (see lines above).
      const { data: { session: scanSession } } = await supabase.auth.getSession()
      // Polls run for minutes; always hand them the session's current (auto-refreshed) token.
      const currentAccessToken = async () => (await supabase.auth.getSession()).data.session?.access_token ?? null
      // JOB/POLL CALL: scanWalletV2() enqueues immediately, then polls status while the
      // background queue runs the unchanged full scan worker outside this HTTP request.
      // ROOT-CAUSE FIX, DISCLOSED (Robinhood-not-in-normal-pipeline bug): this call previously
      // hardcoded ['base', 'eth'] for EVERY scan, so app/api/wallet-scan/route.ts's own
      // `includeRobinhoodRequested = rawChains === null || rawChains.includes('robinhood')` always
      // evaluated false here — even with ENABLE_ROBINHOOD_CHAIN=true, ALCHEMY_ROBINHOOD_RPC_URL,
      // GOLDRUSH_API_KEY, and BLOCKSCOUT_API_KEY all configured — because this client never told the
      // route Robinhood was wanted. That is the exact live-log symptom reported: requestedChains/
      // allowedChains/finalChainsScanned excluding Robinhood despite every env flag being true.
      // Adding 'robinhood' here is safe: the route already strips it back out of the EVM `chains`
      // array before it ever reaches enqueueWalletScanJob()/runWalletScanV2() (see
      // app/api/wallet-scan/route.ts's own `chains = rawChains.filter(c => c !== 'robinhood')`) — its
      // only effect is flipping `includeRobinhoodRequested` to true so the worker's real
      // scanRobinhoodWallet() call and the walletChainSelectionAudit both honestly reflect the
      // request. Robinhood availability is still gated server-side by isRobinhoodChainAvailable() —
      // sending this string never fakes Robinhood being scanned when it isn't configured.
      const response = await scanWalletV2(address, ['base', 'eth', 'robinhood'], mode, ({ jobId, status, progress, partial, walletChainSelectionAudit, lastWorkerUpdateAgoMs }) => {
        // STALE-UPDATE GUARD, DISCLOSED (stuck-scanning-lifecycle fix): if the user started a fresh
        // scan while this one was still polling in the background (allowed once limitedEvidenceMode
        // let the button re-enable), this callback belongs to a superseded generation — drop it so
        // it can never clobber the newer scan's state.
        if (scanGenerationRef.current !== myGeneration) return
        setScanClock((prev) => prev && {
          ...prev,
          lastWorkerUpdateAt: lastWorkerUpdateAgoMs != null ? Date.now() - lastWorkerUpdateAgoMs : prev.lastWorkerUpdateAt,
          stageLabel: progress?.label ?? prev.stageLabel,
        })
        scanJobId = jobId
        if (jobId) latestScanJobRef.current = jobId
        setCurrentJobId(jobId)
        if (!robinhoodRequestedForJob && jobId) {
          robinhoodRequestedForJob = true
          robinhoodJobRef.current = jobId
          void handleRobinhoodScan({ jobId }).finally(() => {
            robinhoodSidecarDurationMsRef.current = Date.now() - scanStartedAt
          })
        }
        setJobStatusMessage(status === 'queued' ? 'queued — still scanning…' : status === 'running' ? 'running — still scanning…' : status)
        // REAL STAGE LABEL, DISCLOSED: only ever set from a real backend checkpoint (see
        // WalletScanStageProgress's own header) — never advanced by a client-side timer/guess, and
        // never cleared back to null mid-scan (a later poll simply hasn't reached a new checkpoint
        // yet — the last real stage stays visible rather than the UI reverting to a generic spinner).
        if (progress) setScanProgress(progress)
        if (partial) {
          if (uiFirstResultMsRef.current == null) {
            uiFirstResultMsRef.current = Date.now() - scanStartedAt
            // GRACE TIMER, DISCLOSED (stuck-scanning-lifecycle fix): holdings/pricing/portfolio are
            // now known-ready (this is the worker's own verified early snapshot, never a guess) —
            // schedule the UI to stop presenting a blocking "scanning" state after
            // PORTFOLIO_READY_GRACE_MS if the full result (PnL/activity/CORTEX) still hasn't
            // landed. Scheduled exactly once per scan (guarded by uiFirstResultMsRef being null),
            // and generation-guarded so it can never fire for a superseded scan.
            globalThis.setTimeout(() => {
              if (scanGenerationRef.current !== myGeneration) return
              setLimitedEvidenceMode(true)
              // eslint-disable-next-line no-console
              console.warn('[walletScanLifecycleAudit]', buildWalletScanLifecycleAudit({
                walletAddress: address,
                jobId: scanJobId,
                requestedMode: mode,
                stageState: deriveWalletScanStageState({
                  loading: true, limitedEvidenceMode: true, hasPartialSnapshot: true, hasResult: false,
                  pnlStatus: null, chainActivityV2Present: false, hasError: false, timeoutHit: false,
                }),
                workerStatus: 'running',
                polling: true,
                lastProgressAt: Date.now(),
                scanStartedAt,
                timeoutHit: false,
                failureReason: null,
              }))
            }, PORTFOLIO_READY_GRACE_MS)
          }
          setPartialSnapshot(partial)
        }
        // Only present on the enqueue update — kept on later polls that don't carry it (see
        // ScanWalletStatusUpdate's own header in scanWallet.ts).
        if (walletChainSelectionAudit) {
          setChainSelectionAudit(walletChainSelectionAudit)
          // eslint-disable-next-line no-console
          console.log('[SCAN] walletChainSelectionAudit', walletChainSelectionAudit)
        }
      }, scanSession?.access_token ? currentAccessToken : null)
      if (scanGenerationRef.current !== myGeneration) return
      setScanDurationMs(Date.now() - scanStartedAt)
      // CONFIRMED ROOT-CAUSE FIX, DISCLOSED (live-value staleness task): both failure paths below
      // previously left the PRESERVED previous result on screen — the `degraded` branch did a bare
      // `return`, and a thrown scan only called setError() — while the results block renders on
      // `result` alone, independent of `error`. A wallet whose real value had since changed
      // therefore kept displaying its OLD total, indistinguishable from a current one, after every
      // failed rescan. Dropping the envelope here is the honest outcome: a scan that did not
      // produce a new complete result must never leave stale totals presented as current.
      // PnL FOLLOW-UP: polls the follow-up job (heavy wallet, or a scan that timed out after its snapshot)
      // and swaps in its full report when it lands; never touches a newer scan's state.
      const startPnlFollowUp = (followUpJobId: string) => {
        setPnlFollowUp({ jobId: followUpJobId, status: 'processing' })
        void pollWalletScanJob(followUpJobId, currentAccessToken).then((followUp) => {
          if (scanGenerationRef.current !== myGeneration) return
          const fullReport = followUp.success ? (followUp.data as WalletV2Report | undefined) : undefined
          if (fullReport && (fullReport as unknown as { pnlStatus?: string | null }).pnlStatus !== 'deferred_heavy_wallet') {
            setResultEnvelope({ report: fullReport, jobId: followUpJobId, completedAt: Date.now() })
            savePortfolioScanResult(address, fullReport, robinhoodResultRef.current)
            setPnlFollowUp(null)
          } else {
            setPnlFollowUp({ jobId: followUpJobId, status: 'failed' })
          }
        })
      }
      if (response.degraded) {
        setResultEnvelope(null)
        setError('Final scan result is temporarily unavailable. The scan reached a terminal degraded state; please rescan in a moment. Previous results were cleared — they may no longer reflect this wallet\'s current value.')
        return
      }
      // TIMED OUT AFTER THE SNAPSHOT: the holdings/portfolio snapshot already on screen stays, labelled
      // "PnL still processing", while the follow-up job finishes PnL — no error banner.
      if (!response.success && response.pnlStillProcessing && response.pnlFollowUpJobId && scanSession?.access_token) {
        startPnlFollowUp(response.pnlFollowUpJobId)
        return
      }
      if (!response.success || !response.data) {
        const message = response.error?.message ?? 'Scan failed'
        if (mode === 'deep' && /deep scan limit/i.test(message)) {
          setDeepScanQuota((prev) => prev && prev.limit != null ? { ...prev, remaining: 0 } : prev)
        }
        throw new Error(message)
      }
      const report = response.data as WalletV2Report
      // WORKER-LEVEL CHAIN SELECTION AUDIT, DISCLOSED (Wallet Scanner chain selection fix, worker
      // level): the job's own final result (workers/walletScanV2.ts's runWalletScanV2Worker) now
      // carries its own walletChainSelectionAudit, reconciled with the REAL scan outcome —
      // `finalChainsScanned` only includes 'robinhood' when a real, non-null scanRobinhoodWallet()
      // result came back. This is strictly more honest than the pre-scan one set from the enqueue
      // response's onUpdate above (whose finalChainsScanned was only ever a stated INTENT), so it
      // always wins when present. No reconciliation logic beyond "prefer the later, real one" is
      // needed here.
      const workerReportAudit = (report as unknown as { walletChainSelectionAudit?: typeof chainSelectionAudit })?.walletChainSelectionAudit
      if (workerReportAudit) {
        setChainSelectionAudit(workerReportAudit)
        // eslint-disable-next-line no-console
        console.log('[SCAN] walletChainSelectionAudit (worker, final)', workerReportAudit)
      }
      // ATOMIC REPLACEMENT: the entire previous envelope (report + identity) is replaced in one
      // update — never merged field-by-field with the prior scan.
      const envelope: WalletScanEnvelope = { report, jobId: scanJobId, completedAt: Date.now() }
      setResultEnvelope(envelope)
      // The job's own Robinhood result (same single provider scan); a still-polling job-backed request then stops.
      const jobRobinhood = (report as unknown as { robinhood?: Parameters<typeof toRobinhoodWalletScanResponse>[1] | null }).robinhood
      // FINAL ROBINHOOD LANE: this job's own Robinhood result always settles the lane (was `prev ?? job`, which kept
      // a previous scan's Robinhood lane next to this job's EVM lane). Without one, only the same wallet's survives.
      const nextRobinhood = resolveRobinhoodResultOnJobComplete({
        prev: robinhoodResultRef.current, wallet: address,
        jobRobinhood: jobRobinhood ? toRobinhoodWalletScanResponse(address, jobRobinhood) : null,
      })
      if (jobRobinhood) robinhoodResultJobRef.current = scanJobId
      else if (nextRobinhood == null) robinhoodResultJobRef.current = null
      robinhoodResultRef.current = nextRobinhood
      setRobinhoodResult(nextRobinhood)
      if (robinhoodJobRef.current === scanJobId) robinhoodJobRef.current = null
      console.warn('[wallet-final-pricing-summary-audit]', buildWalletFinalPricingSummaryAudit({
        evmEvidence: deriveEvmPortfolioEvidence(report), robinhoodResult: nextRobinhood, canonicalOverride: deriveCanonicalMergeOverride(report),
        jobId: scanJobId, robinhoodResultJobId: robinhoodResultJobRef.current,
      }))
      setPartialSnapshot(null)
      // HEAVY WALLET: PnL deferred to a follow-up job — poll it and swap in its full report when done.
      const reportPnlStatus = (report as unknown as { pnlStatus?: string | null }).pnlStatus
      const followUpJobId = (report as unknown as { pnlFollowUpJobId?: string | null }).pnlFollowUpJobId ?? null
      if (reportPnlStatus === 'deferred_heavy_wallet') {
        if (followUpJobId && scanSession?.access_token) {
          startPnlFollowUp(followUpJobId)
        } else {
          setPnlFollowUp({ jobId: null, status: 'not_queued' })
        }
      }
      // PORTFOLIO-SHARED-CACHE, DISCLOSED (Portfolio-page-empty-data audit): hands this completed,
      // real scan result to the shared sessionStorage cache so /terminal/portfolio can use it
      // immediately for the same wallet instead of re-scanning or showing empty — see
      // app/frontend/lib/portfolioSharedCache.ts's own header.
      savePortfolioScanResult(address, report, nextRobinhood)
      const workerPerf = (report as { walletScanPerformanceAudit?: { providerCalls?: number; cacheHits?: number; slowestStage?: { name: string; ms: number } | null; stageDurations?: Record<string, number>; totalDurationMs?: number; evmWorkerDurationMs?: number } }).walletScanPerformanceAudit
      // eslint-disable-next-line no-console
      console.warn('[walletScanPerformanceAudit]', {
        totalDurationMs: Date.now() - scanStartedAt,
        slowestStage: workerPerf?.slowestStage?.name ?? scanProgress?.stage ?? null,
        stageDurations: workerPerf?.stageDurations ?? {},
        providerCalls: workerPerf?.providerCalls ?? 0,
        cacheHits: workerPerf?.cacheHits ?? 0,
        robinhoodSidecarDurationMs: robinhoodSidecarDurationMsRef.current,
        evmWorkerDurationMs: workerPerf?.evmWorkerDurationMs ?? workerPerf?.totalDurationMs ?? (Date.now() - scanStartedAt),
        uiFirstResultMs: uiFirstResultMsRef.current,
      })
      logEngineConsistencyIfDev(report)
      logScanIdentityIfDev(envelope)
      // eslint-disable-next-line no-console
      console.warn('[walletScanLifecycleAudit]', buildWalletScanLifecycleAudit({
        walletAddress: address,
        jobId: scanJobId,
        requestedMode: mode,
        stageState: deriveWalletScanStageState({
          loading: false, limitedEvidenceMode: false, hasPartialSnapshot: false, hasResult: true,
          pnlStatus: (report as unknown as { pnlStatus?: string | null }).pnlStatus ?? null,
          chainActivityV2Present: Array.isArray(report.chainActivityV2) && report.chainActivityV2.length > 0,
          hasError: false, timeoutHit: false,
        }),
        workerStatus: 'done',
        polling: false,
        lastProgressAt: Date.now(),
        scanStartedAt,
        timeoutHit: false,
        failureReason: null,
      }))
    } catch (err: unknown) {
      if (scanGenerationRef.current !== myGeneration) return
      // eslint-disable-next-line no-console
      console.error('Scan failed', err)
      const failureMessage = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn('[walletScanLifecycleAudit]', buildWalletScanLifecycleAudit({
        walletAddress: address,
        jobId: scanJobId,
        requestedMode: mode,
        stageState: deriveWalletScanStageState({
          loading: false, limitedEvidenceMode, hasPartialSnapshot: partialSnapshot != null, hasResult: false,
          pnlStatus: null, chainActivityV2Present: false, hasError: true,
          timeoutHit: /timed out|timeout/i.test(failureMessage),
        }),
        workerStatus: 'failed',
        polling: false,
        lastProgressAt: Date.now(),
        scanStartedAt,
        timeoutHit: /timed out|timeout/i.test(failureMessage),
        failureReason: failureMessage,
      }))
      setResultEnvelope(null)
      // The live snapshot's holdings/portfolio are real and already on screen: keep them (labelled as
      // an unfinished scan) instead of clearing them and leaving only the error.
      setError(err instanceof Error ? err.message : 'Scan failed — try again later')
    } finally {
      // STALE-UPDATE GUARD, DISCLOSED (stuck-scanning-lifecycle fix): a superseded generation must
      // never reset `loading`/`jobStatusMessage`/etc for the NEWER scan currently in flight — those
      // belong entirely to whichever scan is the CURRENT generation. refreshDeepScanQuota is a
      // harmless read regardless of generation, so it still runs unconditionally.
      if (scanGenerationRef.current === myGeneration) {
        setLoading(false)
        setLimitedEvidenceMode(false)
        setJobStatusMessage(null)
        setCurrentJobId(null)
        setScanProgress(null)
      }
      if (mode === 'deep') void refreshDeepScanQuota()
    }
  }

  // ROBINHOOD CHAIN SCAN, DISCLOSED (phased rollout, Phase 1+2): a genuinely separate request to a
  // genuinely separate route (GET /api/wallet-scan/robinhood) — never touches scanWalletV2, never
  // touches resultEnvelope/loading/error above. Runs entirely independently of a Base/ETH scan; a
  // user can have both a Base/ETH result and a Robinhood result on screen at once.
  async function handleRobinhoodScan(opts: { jobId?: string; refresh?: boolean } = {}) {
    // Same guard for the Robinhood sidecar / rescan (it reads the input field too).
    const check = checkWalletScanInput(input)
    if (check.action === 'ignore') return
    if (check.action === 'reject') { setRobinhoodError(null); setError(check.message); return }
    const address = check.address
    setRobinhoodLoading(true)
    setRobinhoodError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      // JOB-BACKED, BOUNDED: with a jobId the route only serves/waits for that job's Robinhood result
      // (HTTP 202 = still running); this polls it while the same job is current, never re-scanning.
      const qs = new URLSearchParams({ address })
      if (opts.jobId) qs.set('jobId', opts.jobId)
      if (opts.refresh) qs.set('refresh', '1')
      let res: Response | null = null
      let json: (RobinhoodWalletScanResponse & { error?: { message?: string }; pending?: boolean; retryAfterMs?: number; refreshSince?: number }) | null = null
      for (let attempt = 0; attempt < ROBINHOOD_JOB_POLL_MAX_ATTEMPTS; attempt++) {
        res = await fetch(`/api/wallet-scan/robinhood?${qs.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        json = await res.json().catch(() => null)
        if (res.status !== 202) break
        // A Rescan keeps the server's freshness floor across polls, so the scan its first poll started is the
        // one that answers it (never an older result, never a new scan per poll).
        if (opts.refresh && typeof json?.refreshSince === 'number') qs.set('refreshSince', String(json.refreshSince))
        // Superseded scan, or the job's final report already supplied the Robinhood result.
        if (opts.jobId && robinhoodJobRef.current !== opts.jobId) return
        await new Promise((r) => globalThis.setTimeout(r, Math.min(Math.max(json?.retryAfterMs ?? 2_500, 1_000), 5_000)))
      }
      if (!res || res.status === 202) {
        if (opts.jobId && robinhoodJobRef.current !== opts.jobId) return
        setRobinhoodError('Robinhood Chain scan is still running — results will appear when the scan completes.')
        return
      }
      // Superseded: a job-backed response for an older job never replaces a newer scan's Robinhood lane.
      if (opts.jobId && latestScanJobRef.current !== opts.jobId) return
      // 409 resultNotShared: the scan finished but its body never reached the shared store. A job-backed lane gets it
      // from the job's final report (never an error, never a re-scan); a Rescan keeps what is on screen and says why.
      const notShared = json as { resultNotShared?: boolean; message?: string } | null
      if (res.status === 409 && notShared?.resultNotShared) {
        if (!opts.jobId) setRobinhoodError(notShared.message ?? 'Robinhood scan finished, but its result could not be shared. Run a Wallet Scanner scan to see it.')
        return
      }
      if (!res.ok || !json?.ok) {
        setRobinhoodResult(null)
        robinhoodResultJobRef.current = null
        setRobinhoodError(json?.error?.message ?? 'Robinhood scan failed — try again later')
        return
      }
      setRobinhoodResult(json)
      robinhoodResultJobRef.current = opts.jobId ?? null
      // PORTFOLIO-SHARED-CACHE, DISCLOSED: same hand-off as the main EVM scan above — a Robinhood
      // result scanned after the EVM report is already cached should not be lost; re-saves with
      // whatever EVM report is currently on screen (null if none yet, unchanged either way).
      if (result) savePortfolioScanResult(address, result, json)
    } catch (err: unknown) {
      setRobinhoodResult(null)
      setRobinhoodError(err instanceof Error ? err.message : 'Robinhood scan failed — try again later')
    } finally {
      setRobinhoodLoading(false)
    }
  }

  // SKELETON, NOT A TEXT WALL, DISCLOSED (performance + UX optimization task): this was a
  // full-screen "Loading plan access…" wall that ALSO rendered into the SSR HTML — confirmed by
  // fetching this exact route and finding the string in the server response — so it flashed on every
  // single load even for a user whose plan was already cached locally. PlanGateSkeleton mirrors the
  // page's real rhythm so nothing jumps when content replaces it, and the shared account store now
  // only reports loading:true when there is genuinely no cached plan to trust.
  if (planLoading) return <PlanGateSkeleton />

  if (!betaEliteActive && !canAccessFeature(plan, 'wallet-scanner')) {
    return <LockedPanel feature="wallet-scanner" />
  }

  // The right CORTEX Wallet Read panel now reads the SAME merged result (V2 + Robinhood when
  // scanned) as the main results card below — never a Base/ETH-only readout for a wallet that also
  // has a real Robinhood result on screen.
  const cortexRead = result ? buildCortexReadV2(result, robinhoodResult) : null
  const deepScanAtLimit = deepScanQuota != null && deepScanQuota.limit != null && (deepScanQuota.remaining ?? 0) <= 0
  const deepScanQuotaLabel = deepScanQuota
    ? deepScanRemainingLabel(deepScanQuota.remaining, deepScanQuota.limit, deepScanQuotaPeriod(plan))
    : null

  return (
    <>
      <style>{`
        .ws-row:hover { background: rgba(255,255,255,0.030) !important; }
        .ws-scan-btn:hover:not(:disabled) {
          filter: brightness(1.06);
          box-shadow: 0 10px 30px rgba(45,212,191,0.32) !important;
          transform: translateY(-1px);
        }
        .ws-scan-btn { transition: background 0.15s, box-shadow 0.18s, color 0.15s, transform 0.12s !important; }
        .ws-card-hover:hover { border-color: rgba(45,212,191,0.25) !important; box-shadow: 0 0 20px rgba(45,212,191,0.06) !important; transition: border-color 0.2s, box-shadow 0.2s; }
        .ws-result-fade { animation: fadeUp 0.3s ease both; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .ws-section-header { font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); }
        .ws-card {
          background: rgba(6,10,18,0.95); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px;
          padding: 18px 20px; margin-bottom: 16px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 20px rgba(0,0,0,0.18);
        }
        .ws-content-col { max-width: 1000px; margin: 0 auto; }
        .wallet-shell { background-color: #06060a; background-image: radial-gradient(circle at 0% 0%, rgba(45,212,191,0.07), transparent 42%), radial-gradient(circle at 100% 100%, rgba(139,92,246,0.06), transparent 44%); }
        .ws-scanbox { position: relative; z-index: 1; padding: 20px; border-radius: 16px; background: rgba(255,255,255,0.03); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-shadow: 0 18px 48px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04); }
        .ws-scanbox::before { content: ''; position: absolute; inset: 0; border-radius: inherit; padding: 1px; background: linear-gradient(135deg, rgba(45,212,191,0.42), rgba(139,92,246,0.34)); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; pointer-events: none; }
        .ws-scanbox-glow { position: absolute; inset: -28px -12px; border-radius: 32px; background: radial-gradient(ellipse at 50% 45%, rgba(45,212,191,0.13), transparent 68%); filter: blur(22px); pointer-events: none; z-index: 0; }
        .ws-wallet-input { width: 100%; height: 56px; padding: 0 84px 0 46px; box-sizing: border-box; background: rgba(6,6,10,0.72); border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; color: #f8fafc; font-size: 16px; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
        .ws-wallet-input::placeholder { color: #64748b; }
        .ws-wallet-input:focus { border-color: rgba(45,212,191,0.85); box-shadow: 0 0 0 3px rgba(45,212,191,0.20); }
        .ws-wallet-input:disabled { opacity: 0.6; }
        .ws-paste-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04); color: #94a3b8; font-size: 11px; font-weight: 600; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); cursor: pointer; transition: color 0.14s, border-color 0.14s; }
        .ws-paste-btn:hover:not(:disabled) { color: #2DD4BF; border-color: rgba(45,212,191,0.40); }
        .ws-paste-btn:disabled { cursor: not-allowed; opacity: 0.5; }
        .ws-get-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
        .ws-get-card { background: #080c14; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 16px; transition: transform 0.18s ease, border-color 0.18s ease; }
        .ws-get-card:hover { transform: translateY(-2px); border-color: rgba(255,255,255,0.18); }
        .ws-get-icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; margin-bottom: 12px; }
        .ws-example-chip { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; background: #080c14; border: 1px solid rgba(255,255,255,0.08); font-size: 12px; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); cursor: pointer; transition: border-color 0.14s, background 0.14s; }
        .ws-example-chip:hover { border-color: rgba(45,212,191,0.40); background: rgba(45,212,191,0.06); }
        .ws-skeleton { height: 10px; border-radius: 5px; background: rgba(148,163,184,0.12); }
        .ws-wl-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 12px; background: rgba(6,6,10,0.6); border: 1px solid rgba(255,255,255,0.06); min-width: 0; }
        .ws-wl-save, .ws-wl-scan { border: 1px solid rgba(45,212,191,0.32); background: rgba(45,212,191,0.10); color: #2DD4BF; border-radius: 8px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); cursor: pointer; transition: background 0.14s, border-color 0.14s; flex-shrink: 0; }
        .ws-wl-save { padding: 6px 12px; font-size: 10px; }
        .ws-wl-scan { padding: 6px 10px; font-size: 10px; }
        .ws-wl-save:hover:not(:disabled), .ws-wl-scan:hover:not(:disabled) { background: rgba(45,212,191,0.20); border-color: rgba(45,212,191,0.55); }
        .ws-wl-save:disabled, .ws-wl-scan:disabled { opacity: 0.5; cursor: not-allowed; }
        .ws-wl-del { width: 30px; height: 30px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #64748b; cursor: pointer; transition: color 0.14s, background 0.14s, border-color 0.14s; }
        .ws-wl-del:hover:not(:disabled) { color: #f87171; background: rgba(248,113,113,0.08); border-color: rgba(248,113,113,0.25); }
        .ws-wl-del:disabled { cursor: wait; opacity: 0.5; }
        @media (max-width: 1023px) { .ws-get-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 768px) {
          .wallet-main { padding: 64px 16px 100px !important; }
          .wallet-input-row { flex-direction: column; max-width: 100% !important; }
          .wallet-input-row > button { width: 100%; justify-content: center; min-height: 44px; }
          .wallet-title-row { flex-wrap: wrap; }
          .ws-get-grid { grid-template-columns: 1fr; }
          .ws-hero-sub { white-space: normal !important; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden wallet-shell" style={{ color: '#e2e8f0' }}>
        {/* ── Left: scrollable main area ─────────────────────────────────── */}
        <div className="mob-scan-main wallet-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '32px 32px 120px' }}>
          <div className="ws-content-col">

          {/* ── Hero ─────────────────────────────────────────────────────────── */}
          {/* PRE-SCAN REDESIGN: 40px heading with the ELITE pill and the 180-Day engine as a muted
              pill beside it; one-line subtitle. Layout only. */}
          <div style={{ marginBottom: '24px' }}>
            <div className="wallet-title-row" style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: '40px', fontWeight: 800, lineHeight: 1.1, margin: 0, color: '#f1f5f9', fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.02em' }}>
                Wallet Scanner
              </h1>
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                padding: '4px 11px', borderRadius: '99px',
                background: 'rgba(139,92,246,0.14)', border: '1px solid rgba(139,92,246,0.40)',
                color: '#c4b5fd', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase', flexShrink: 0,
              }}>
                Elite
              </span>
              <span style={{
                fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em',
                padding: '4px 10px', borderRadius: '99px',
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
                color: '#64748b', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                180-Day Intelligence Engine
              </span>
            </div>
            <p className="ws-hero-sub" style={{ fontSize: '14px', color: '#94a3b8', margin: 0, lineHeight: 1.5, fontFamily: 'var(--font-inter, Inter, sans-serif)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              On-chain wallet intelligence with AI-powered analysis
            </p>
          </div>

          {/* ── Scan box ─────────────────────────────────────────────────────── */}
          {/* Same input value/onChange/onKeyDown/disabled wiring, same handleScan('normal' | 'deep')
              calls and the same Deep Scan quota/limit guards as before — restyled into one card. */}
          <div style={{ position: 'relative', marginBottom: '24px' }}>
            {!result && <span aria-hidden="true" className="ws-scanbox-glow" />}
            <div className="ws-scanbox">
              <div className="wallet-input-row" style={{ display: 'flex', gap: '10px' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                    <path d="M4 7.5A2.5 2.5 0 016.5 5H18a2 2 0 012 2v1.5" stroke="#64748b" strokeWidth="1.8" strokeLinecap="round" />
                    <rect x="4" y="7.5" width="16" height="11.5" rx="2.5" stroke="#64748b" strokeWidth="1.8" />
                    <circle cx="16" cy="13.25" r="1.25" fill="#64748b" />
                  </svg>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleScan() }}
                    disabled={loading && !limitedEvidenceMode}
                    placeholder="0x… wallet address"
                    spellCheck={false}
                    className="ws-wallet-input"
                  />
                  <button
                    type="button"
                    className="ws-paste-btn"
                    disabled={loading && !limitedEvidenceMode}
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText()
                        if (text) setInput(text.trim())
                      } catch { /* clipboard permission denied — the field stays editable */ }
                    }}
                  >
                    Paste
                  </button>
                </div>
                <button
                  className="ws-scan-btn"
                  onClick={() => void handleScan()}
                  disabled={(loading && !limitedEvidenceMode) || !input.trim()}
                  style={{
                    height: '56px', padding: '0 26px', borderRadius: '12px',
                    border: '1px solid rgba(45,212,191,0.9)',
                    background: 'linear-gradient(135deg, #5eead4 0%, #2DD4BF 55%, #14b8a6 100%)',
                    color: '#04201c', opacity: ((loading && !limitedEvidenceMode) || !input.trim()) ? 0.5 : 1,
                    fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
                    cursor: ((loading && !limitedEvidenceMode) || !input.trim()) ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexShrink: 0,
                  }}
                >
                  {/* SCAN-BUTTON-NEVER-STUCK FIX, DISCLOSED (stuck-scanning-lifecycle fix): once
                      limitedEvidenceMode is true the button is live again even while the background poll
                      for the previous scan is still running — it reads "Rescan" since a completed (if
                      limited) result already exists to refresh. */}
                  {loading && !limitedEvidenceMode ? 'Scanning…' : loading && limitedEvidenceMode ? 'Rescan' : result ? 'Rescan' : 'Scan'}
                  {!(loading && !limitedEvidenceMode) && (
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  )}
                </button>
              </div>

              {/* Deep Scan and admin-only recovery controls — same row, inside the card. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => void handleScan('deep')}
                  disabled={(loading && !limitedEvidenceMode) || !input.trim() || deepScanAtLimit}
                  title={deepScanAtLimit ? scanDailyLimitReachedMessage(plan, deepScanQuota?.limit ?? null) : 'Deep scan — holdings and portfolio first, then recovery and PnL.'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    padding: '5px 11px', borderRadius: '999px', border: '1px solid rgba(45,212,191,0.40)',
                    background: 'rgba(45,212,191,0.08)', color: '#2DD4BF',
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
                    cursor: ((loading && !limitedEvidenceMode) || !input.trim() || deepScanAtLimit) ? 'not-allowed' : 'pointer',
                    opacity: deepScanAtLimit ? 0.45 : 1,
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  }}
                >
                  {limitedEvidenceMode ? 'Retry Deep Scan' : 'Deep Scan'}
                </button>
                <span style={{ fontSize: '12px', color: '#64748b', fontFamily: 'var(--font-inter, Inter, sans-serif)', lineHeight: 1.5 }}>
                  Holdings + portfolio first · PnL and recovery follow
                  {deepScanQuotaLabel ? ` · ${deepScanQuotaLabel}` : ''}
                </span>
                {/* ROBINHOOD SEPARATE BUTTON REMOVED, DISCLOSED (multi-chain integration task): Robinhood
                    Chain is scanned automatically by handleScan() as part of a normal multi-chain scan;
                    explicit re-scanning stays inside the Robinhood card once results exist. */}
              </div>
            </div>
          </div>

          {/* Loading state — hidden once limitedEvidenceMode kicks in (stuck-scanning-lifecycle
              fix): the generic "Scanning…/queued/still scanning" copy is replaced below by the real
              "Scan completed with limited evidence" card once holdings/pricing/portfolio are proven
              ready and the grace period has elapsed with no full result yet. */}
          {loading && !limitedEvidenceMode && (
            <div className="ws-card" style={{ color: 'rgba(148,163,184,0.75)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontSize: '13px' }}>
              {/* REFRESHING INDICATOR, DISCLOSED (this task's "clearly show Refreshing…"
                  requirement): when a previous result is still on screen, the numbers below this
                  banner belong to the PREVIOUS completed scan until the new one lands — say so
                  explicitly rather than letting them look current. */}
              {result && (
                <div style={{ marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '4px 11px', borderRadius: '999px', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.32)', color: '#fbbf24', fontSize: '10px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase' }}>
                  Refreshing… showing previous scan results until the new scan completes
                </div>
              )}
              <div>
              {/* STAGED LABEL, DISCLOSED (perceived-speed follow-up task, "Split UI stages clearly"
                  requirement): prefers the real backend stage label the whole time one is known —
                  the last real checkpoint stays visible across polls that haven't reached a new one
                  yet (never reverts to the generic "still scanning…" once real stage data exists).
                  Falls back to the generic queued/running text only before the FIRST real stage
                  checkpoint has been reported. */}
              Scanning {input.trim()}…{' '}
              {scanProgress ? `(${scanProgress.label})` : jobStatusMessage ? `(${jobStatusMessage})` : '(queued — still scanning…)'}
              {currentJobId && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>
                  Job {currentJobId}
                </div>
              )}
              {scanClock && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'rgba(148,163,184,0.7)' }}>
                  Elapsed {Math.max(0, Math.round((clockNow - scanClock.startedAt) / 1000))}s
                  {' · '}Last stage: {scanClock.stageLabel ?? (currentJobId ? 'waiting for the worker to start' : 'starting')}
                  {scanClock.lastWorkerUpdateAt != null && ` · worker last reported ${Math.max(0, Math.round((clockNow - scanClock.lastWorkerUpdateAt) / 1000))}s ago`}
                </div>
              )}
              {partialSnapshot && !result && (
                <div style={{ marginTop: '8px', color: '#fbbf24', fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em' }}>
                  Deep scan still running — PnL and recovery update when verified evidence is ready.
                </div>
              )}
              </div>
            </div>
          )}

          {/* PORTFOLIO-READY-RENDERS FIX, DISCLOSED (stuck-scanning-lifecycle fix, explicit rule
              "Portfolio/holdings ready = render wallet result"): this card is now keyed on
              `partialSnapshot && !result` alone — no longer also requires `loading` — so it stays
              visible through the limitedEvidenceMode transition rather than disappearing the moment
              the blocking "scanning" UI is dismissed. Never overwrites/is overwritten by a real
              `result`: the instant the full report lands this card unmounts (its guard is
              `!result`) and the full result view below takes over. */}
          {partialSnapshot && !result && (() => {
            const pnlStillProcessing = pnlFollowUp?.status === 'processing'
            const scanFailedAfterSnapshot = !loading && !pnlStillProcessing && (error != null || pnlFollowUp?.status === 'failed')
            const merged = computeMergedTotalValueUsd(partialSnapshot.portfolioTotalValueUsd, robinhoodResult, undefined, partialSnapshot.portfolioEvidence ?? null)
            const chainLabels = partialSnapshot.activeChainIds.map((id) => (
              id === 8453 ? 'Base' : id === 1 ? 'ETH' : id === 4663 ? 'Robinhood' : `chain ${id}`
            ))
            if (merged.robinhoodIncluded && !chainLabels.includes('Robinhood')) chainLabels.push('Robinhood')
            const top = partialSnapshot.topHoldings.slice(0, 5)
            // Portfolio is ready but the job is still live: PnL/activity/CORTEX are processing, not missing.
            const stillProcessing = limitedEvidenceMode && loading
            const elapsedSec = scanClock ? Math.max(0, Math.round((clockNow - scanClock.startedAt) / 1000)) : null
            return (
              <div className="ws-card" style={{ marginBottom: '16px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                <div style={{ fontSize: '9px', letterSpacing: '0.12em', textTransform: 'uppercase', color: limitedEvidenceMode || scanFailedAfterSnapshot || pnlStillProcessing ? '#fbbf24' : '#2DD4BF', marginBottom: '10px' }}>
                  {pnlStillProcessing ? 'Portfolio snapshot · PnL still processing' : scanFailedAfterSnapshot ? 'Portfolio snapshot · scan did not finish' : stillProcessing ? 'Holdings ready · PnL, activity and CORTEX processing' : limitedEvidenceMode ? 'Scan finished with limited evidence' : 'Portfolio snapshot · live'}
                </div>
                <div style={{ fontSize: '22px', fontWeight: 800, color: '#e2e8f0', marginBottom: '8px' }}>
                  {mergedTotalText(merged, (v) => fmtUsd(v))}
                </div>
                {mergedCoverageText(merged) && (
                  <div style={{ fontSize: '11px', color: '#fbbf24', marginBottom: '6px' }}>{mergedCoverageText(merged)}</div>
                )}
                <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.8)', marginBottom: '10px' }}>
                  Chains: {chainLabels.join(', ') || 'pending'} · {partialSnapshot.holdingsCount} holdings
                  {merged.robinhoodIncluded ? ' · includes Robinhood' : ''}
                </div>
                {top.length > 0 && (
                  <div style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>
                    {top.map((h) => `${h.symbol} ${fmtUsd(h.valueUsd)}`).join(' · ')}
                  </div>
                )}
                {pnlStillProcessing ? (
                  <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24' }}>
                    PnL still processing — this wallet&apos;s full scan ran out of time, so PnL and the wallet read are finishing in a second pass and will appear here automatically. Holdings and portfolio value above are from this scan.
                  </div>
                ) : scanFailedAfterSnapshot ? (
                  <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24' }}>
                    Holdings and portfolio value above come from this scan&apos;s live snapshot. PnL and the full analysis did not finish — they are not being reported as $0.
                  </div>
                ) : stillProcessing ? (
                  <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24' }}>
                    Holdings and portfolio value above are verified. PnL, activity and the CORTEX wallet read are still running in the background
                    {elapsedSec != null ? ` (${elapsedSec}s elapsed${scanClock?.stageLabel ? ` · ${scanClock.stageLabel}` : ''})` : ''} and will appear here automatically — no need to rescan. Nothing is shown as $0 while they run.
                  </div>
                ) : limitedEvidenceMode ? (
                  <>
                    <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24' }}>
                      Holdings and portfolio value above are verified. PnL, activity and the CORTEX wallet read did not finish for this scan and are not being reported as $0 or as confirmed.
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleScan('deep')}
                      style={{
                        marginTop: '10px', padding: '8px 14px', borderRadius: '9px',
                        border: '1px solid rgba(45,212,191,0.45)', background: 'rgba(45,212,191,0.08)',
                        color: '#2DD4BF', fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em',
                        textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                      }}
                    >
                      Retry deep scan
                    </button>
                  </>
                ) : (
                  <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24' }}>
                    PnL: pending — Base/ETH and Robinhood lanes stay separate. Deep scan still running.
                  </div>
                )}
              </div>
            )
          })()}

          {result && pnlFollowUp && (
            <div className="ws-card" style={{ marginBottom: '16px', borderColor: 'rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.05)', color: '#fbbf24', fontSize: '12px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
              {pnlFollowUp.status === 'processing'
                ? 'PnL still processing — this wallet has a large trade history, so PnL, activity and the wallet read are finishing in a second pass. Holdings and portfolio value are final and the rest fills in automatically.'
                : 'PnL is not available for this scan — this wallet has a large trade history and the second pass did not finish. Holdings and portfolio value are final; rescan to retry PnL.'}
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div className="ws-card" style={{ borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.06)', color: '#fca5a5', fontSize: '13px' }}>
              {walletScanErrorBanner(error)}
              <div style={{ marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => void handleScan(lastScanModeRef.current)}
                  style={{ padding: '7px 14px', borderRadius: '9px', border: '1px solid rgba(248,113,113,0.45)', background: 'rgba(248,113,113,0.10)', color: '#fca5a5', fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer' }}
                >
                  Retry scan
                </button>
              </div>
            </div>
          )}

          {/* ONE CANONICAL WALLET RESULT, DISCLOSED (split-Wallet-Scanner-results fix task): Robinhood
              still runs as its own independent fetch (robinhoodLoading/robinhoodError/robinhoodResult,
              untouched by this section — never blocks or gates the Base/ETH scan), but its RESULT is
              no longer rendered as a second, separate top-level card here. Confirmed live bug this
              closes: a Robinhood card with a real total shown directly above/alongside the multi-chain
              Wallet Scanner card's OWN, different total for the SAME wallet — two conflicting totals
              on screen at once. Robinhood now renders as a chain tab INSIDE the one
              WalletScannerResultsV3 result below (see WalletScannerTabsV3.tsx) whenever a main `result`
              exists. This standalone card is kept only as a fallback for the case where Robinhood
              scanned successfully but there is genuinely no main result yet to attach it to (so real
              data is never hidden), or with ?debug=true for raw troubleshooting — never rendered
              alongside a real `result` in the normal case, so there is never more than one total
              on screen for the same wallet. */}
          {robinhoodLoading && !robinhoodResult && !result && (
            <div className="ws-card" style={{ color: 'rgba(148,163,184,0.75)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontSize: '13px', marginBottom: '16px' }}>
              Scanning Robinhood Chain for {input.trim()}…
            </div>
          )}
          {!robinhoodLoading && robinhoodScanErrorBanner(robinhoodError) != null && !result && (
            <div className="ws-card" style={{ borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.06)', color: '#fca5a5', fontSize: '13px', marginBottom: '16px' }}>
              {robinhoodScanErrorBanner(robinhoodError)}
            </div>
          )}
          {/* CHAIN SELECTION AUDIT, DISCLOSED (Wallet Scanner deep scan chain coverage fix): the
              real requested/allowed/omitted chain decision for this scan, including Robinhood's
              numeric chain id (4663) when relevant — visible under ?debug=true, same convention as
              the Robinhood section's own debugMode prop below, so "logs prove it" is also true of
              the UI, not just server logs. */}
          {debugMode && chainSelectionAudit && (
            <div className="ws-card" style={{ marginBottom: '16px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontSize: '11px', color: 'rgba(148,163,184,0.85)' }}>
              <div style={{ marginBottom: '6px', fontSize: '9px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#475569' }}>
                Wallet Chain Selection Audit
              </div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(chainSelectionAudit, null, 2)}
              </pre>
            </div>
          )}

          {/* CURRENT-PRICE RESOLVER AUDIT (debug only): per-scan source summary + per-holding evidence. */}
          {debugMode && (result as { evmHoldingsPricingAudit?: unknown } | null)?.evmHoldingsPricingAudit != null && (
            <div className="ws-card" style={{ marginBottom: '16px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', fontSize: '11px', color: 'rgba(148,163,184,0.85)' }}>
              <div style={{ marginBottom: '6px', fontSize: '9px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#475569' }}>
                Current-Price Resolver Audit
              </div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '480px', overflow: 'auto' }}>
                {JSON.stringify((result as { evmHoldingsPricingAudit?: unknown }).evmHoldingsPricingAudit, null, 2)}
              </pre>
            </div>
          )}

          {robinhoodResult && (!result || debugMode) && !partialSnapshot && (
            <div className="ws-card" style={{ marginBottom: '16px' }}>
              <RobinhoodChainSection
                result={robinhoodResult}
                onRescan={() => void handleRobinhoodScan({ refresh: true })}
                rescanLoading={robinhoodLoading}
                debugMode={debugMode}
              />
            </div>
          )}

          {/* Idle — "What you get" + example wallets (static explanation; no numbers or sample data). */}
          {!loading && !error && !result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div>
                <p className="ws-section-header" style={{ color: '#64748b', margin: '0 0 12px', fontSize: '11px' }}>What you get</p>
                <div className="ws-get-grid">
                  {[
                    { label: 'Portfolio Value', color: '#2DD4BF', desc: 'Live USD value across supported chains.', icon: <path d="M4 19h16M7 15l3-4 3 2 4-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> },
                    { label: 'Holdings', color: '#8b5cf6', desc: 'Every token held, priced and ranked.', icon: <><ellipse cx="12" cy="6.5" rx="7" ry="2.5" stroke="currentColor" strokeWidth="2" /><path d="M5 6.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5M5 11.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5" stroke="currentColor" strokeWidth="2" /></> },
                    { label: 'PnL + Win Rate', color: '#ec4899', desc: 'Realized PnL and win rate from verified trades.', icon: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> },
                    { label: 'CORTEX Personality', color: '#f59e0b', desc: 'Trading style, risk score and biggest flags.', icon: <><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" /><path d="M9 10h.01M15 10h.01M9 15c1.7 1.3 4.3 1.3 6 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></> },
                  ].map((item) => (
                    <div key={item.label} className="ws-get-card">
                      <span aria-hidden="true" className="ws-get-icon" style={{ color: item.color, background: `${item.color}1a`, border: `1px solid ${item.color}33` }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">{item.icon}</svg>
                      </span>
                      <p style={{ margin: '0 0 6px', fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: item.color, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{item.label}</p>
                      <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8', lineHeight: 1.5, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>{item.desc}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="ws-section-header" style={{ color: '#64748b', margin: '0 0 12px', fontSize: '11px' }}>Try an example</p>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {EXAMPLE_WALLETS.map((example) => (
                    <button key={example.address} type="button" className="ws-example-chip" onClick={() => setInput(example.address)} title={`Fill ${example.address}`}>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{example.label}</span>
                      <span style={{ color: '#64748b' }}>{example.address.slice(0, 6)}…{example.address.slice(-4)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Module errors, non-blocking (stuck-at-module-11 task): a module that timed out/failed
              still contributed a degrade-shape fallback to the result above it, so the scan itself
              completed — this is informational only, never replaces the result view. */}
          {!loading && result && moduleErrors && Object.keys(moduleErrors).length > 0 && (
            <div className="ws-card" style={{ borderColor: 'rgba(234,179,8,0.35)', background: 'rgba(234,179,8,0.06)', color: '#facc15', fontSize: '12px', marginBottom: '12px' }}>
              Some modules did not complete in time and used fallback data:
              <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                {Object.entries(moduleErrors).map(([moduleName, message]) => (
                  <li key={moduleName}>{moduleName}: {message}</li>
                ))}
              </ul>
            </div>
          )}

          {/* V2 engine results — DISCLOSED: intentionally rendered whenever `result` exists,
              regardless of `loading` (see the "STAGED-REFRESH FIX" comment on the setResult() call
              above) — a refresh of the SAME wallet keeps its last-known-good total and full report
              visible under the "Scanning…" banner above, instead of blanking to the idle placeholder
              for the whole duration of the new scan. `result` is only ever null here for a genuinely
              new wallet with nothing to show yet. */}
          {result && WALLET_SCANNER_UI_V3 && (
            <WalletScannerResultsV3
              report={result}
              loading={loading}
              isFullRecoveryAdmin={isFullRecoveryAdmin}
              onDeepScan={() => void handleScan('deep')}
              onAdminAction={() => void handleScan('deep')}
              deepScanDisabled={deepScanAtLimit}
              scanDurationMs={scanDurationMs}
              moduleErrors={moduleErrors}
              robinhoodResult={robinhoodResult}
              onRobinhoodRescan={() => void handleRobinhoodScan({ refresh: true })}
              robinhoodRescanLoading={robinhoodLoading}
              debugMode={debugMode}
            />
          )}

          {result && !WALLET_SCANNER_UI_V3 && (
            <div className="ws-result-fade">
              <WalletProfileHeader
                report={result}
                loading={loading}
                isFullRecoveryAdmin={isFullRecoveryAdmin}
                onDeepScan={() => void handleScan('deep')}
                onAdminAction={() => void handleScan('deep')}
                robinhoodResult={robinhoodResult}
              />
              <SectionDivider label="Wallet Personality" />
              <div className="ws-card">
                <FinalSummaryView summary={result.finalSummary} sellTimeline={result.timelines?.sellTimelineV2} />
              </div>

              <SectionDivider label="PnL Summary" />
              <div className="ws-card">
                {/* SINGLE-VERIFIED-SOURCE PNL, UPDATED DISCLOSURE (found live, this task — confirmed
                    ~$500k fabricated Unrealized PnL bug): realized/ROI/cost-basis still read ONLY
                    result.pnlV2 (unchanged) — but Unrealized PnL specifically now reads
                    result.fifoAndPnl.unrealizedReconciliation.officialUnrealizedPnlUsd, the real
                    canonical, balance-reconciled figure, NEVER pnlV2.unrealizedPnlUsd (the legacy,
                    un-reconciled field that produced the reported bug). result.pnlSummaryV2/
                    ayriAttribution and any other PnL source remain excluded, unchanged. */}
                <PnlStatusCard
                  pnlV2={result.pnlV2}
                  publicPnlStatus={result.finalSummary?.financialStatus?.officialPnlStatus}
                  syntheticPnl={result.syntheticPnl}
                  unrealizedReconciliation={result.fifoAndPnl?.unrealizedReconciliation}
                  reconciliationSummary={result.reconciliationSummary}
                  canonicalSampleManifestAudit={result.canonicalSampleManifestAudit}
                  walletPnlEvidenceAudit={result.walletPnlEvidenceAudit}
                />
              </div>

              {/* SELL ACTIVITY, ADDITIVE/DISCLOSED: sourced from result.timelines.sellTimelineV2 —
                  real data the scan API already returns but this page never rendered before. This
                  never merges into PnlStatusCard's pnlV2-derived numbers above (separate section,
                  separate data source, no fallback either direction). */}
              <SectionDivider label="Sell Activity" />
              <div className="ws-card">
                <SellActivitySummary
                  sellTimeline={result.timelines?.sellTimelineV2}
                  pnlV2={result.pnlV2}
                  publicPnlStatus={result.finalSummary?.financialStatus?.officialPnlStatus}
                />
              </div>

              <SectionDivider label="Scan Diagnostics" optional />
              <div className="ws-card">
                <ScanDiagnosticsCard scanDurationMs={scanDurationMs} providerDiagnostics={result.providerDiagnostics} />
              </div>

              {/* WALLET CONDITION PANEL, DISCLOSED: renders exactly what
                  buildWalletConditionMessages() (src/pipeline/walletConditionMessages.ts) returned —
                  no extra assumptions, no client-side re-derivation of any condition. Only rendered
                  at all when the array is non-empty; each entry is shown as-is (the module itself
                  already decided which sections apply to this wallet). */}
              {result.walletConditionMessages && result.walletConditionMessages.length > 0 && (
                <>
                  <SectionDivider label="Wallet Condition" />
                  <div className="ws-card">
                    <ul style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: 0, padding: 0, listStyle: 'none' }}>
                      {result.walletConditionMessages.map((section) => (
                        <li key={section.id} style={{ fontSize: '0.9rem', lineHeight: 1.5, color: '#cbd5e1' }}>
                          {section.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              <SectionDivider label="Holdings" />
              <div className="ws-card">
                <HoldingsViewV2
                  pricedHoldings={result.pricedHoldings}
                  chainValueUsd={result.chainValueUsd}
                  buyEntries={result.timelines?.buyTimeline?.entries}
                  bridgeEntries={result.bridgeTimeline}
                />
              </div>
              <SectionDivider label="Behavior Intel" />
              <div className="ws-card"><BehaviorIntelView data={result.behaviorIntel} /></div>

              <SectionDivider label="Recovery Health" />
              <div className="ws-card"><RecoveryHealthCard data={result.recoveryPolicy} /></div>

              <SectionDivider label="Window Coverage" />
              <div className="ws-card"><CoverageTimelineCard data={result.windowCoverage} /></div>

              {/* Buy/Sell(legacy)/Distribution timelines are still intentionally not rendered — the
                  raw data is still returned in the scan API response (result.timelines.*), visible
                  via the browser's Network tab. sellTimelineV2 is the one exception, now rendered
                  above via SellActivitySummary. */}
              <SectionDivider label="Diagnostics" optional />
              <div className="ws-card"><ChainSelectionView data={result.chainSelection} chainActivityV2={result.chainActivityV2} /></div>
            </div>
          )}
          </div>
        </div>

        {/* ── Right: CORTEX Wallet Read + Watchlist ─────────────────────────── */}
        <aside className="mob-verdict-panel" style={{
          width: '360px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          background: 'rgba(8,12,20,0.72)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ height: '2px', flexShrink: 0, background: 'linear-gradient(90deg, transparent 0%, #2DD4BF 40%, #8b5cf6 70%, transparent 100%)', opacity: cortexRead ? 0.85 : 0.15, transition: 'opacity 0.5s' }} />

          <div style={{ padding: '22px 24px 16px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: result ? '10px' : 0 }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: cortexRead ? '#2DD4BF' : 'rgba(45,212,191,0.20)', boxShadow: cortexRead ? '0 0 10px rgba(45,212,191,0.70)' : 'none' }} />
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                CORTEX · Wallet Read
              </span>
            </div>
            {result?.scanMetadata?.walletAddress && (
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>
                {result.scanMetadata.walletAddress.slice(0, 10)}…{result.scanMetadata.walletAddress.slice(-8)}
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* CORTEX-PANEL-NEVER-STUCK FIX, DISCLOSED (stuck-scanning-lifecycle fix): "reading…"
                is now gated on `loading && !limitedEvidenceMode` instead of `loading` alone, so it
                can never sit forever once holdings/pricing/portfolio are ready and the grace period
                has elapsed — it hands off to an honest "still processing in the background" message
                instead, which itself upgrades to the real WalletReadPanel the moment `result` (and
                therefore `cortexRead`) actually lands. */}
            {loading && !limitedEvidenceMode && (
              <p style={{ fontSize: '12px', color: 'rgba(45,212,191,0.60)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>CORTEX reading wallet activity…</p>
            )}
            {loading && limitedEvidenceMode && !cortexRead && (
              <p style={{ fontSize: '12px', color: 'rgba(251,191,36,0.75)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', lineHeight: 1.6 }}>
                Portfolio ready. CORTEX wallet read is still processing in the background — it will appear here automatically when the scan finishes.
              </p>
            )}
            {!loading && !cortexRead && (
              /* Pre-scan placeholder: clearly a preview (AWAITING SCAN, skeleton bars), never a fake read. */
              <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '16px' }}>
                  <svg aria-hidden="true" width="44" height="44" viewBox="0 0 44 44" fill="none">
                    <circle cx="22" cy="22" r="17" stroke="rgba(148,163,184,0.16)" strokeWidth="4" />
                    <path d="M22 5a17 17 0 0116.2 11.8" stroke="rgba(45,212,191,0.35)" strokeWidth="4" strokeLinecap="round" />
                  </svg>
                  <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', padding: '3px 8px', borderRadius: '999px', color: '#2DD4BF', background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.28)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', whiteSpace: 'nowrap' }}>
                    AWAITING SCAN
                  </span>
                </div>
                {[
                  { label: 'Personality', width: '62%' },
                  { label: 'Risk score', width: '38%' },
                  { label: 'Biggest flag', width: '78%' },
                ].map((row, idx) => (
                  <div key={row.label} style={{ padding: '12px 0', borderTop: idx > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none', ...(idx === 2 ? { paddingBottom: 0 } : {}) }}>
                    <p style={{ margin: '0 0 8px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#64748b', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{row.label}</p>
                    <div className="ws-skeleton" style={{ width: row.width }} />
                  </div>
                ))}
              </div>
            )}
            {/* PREMIUM WALLET READ, DISCLOSED (Wallet Read / CORTEX sidebar redesign task): the old
                flat verdict/read/keySignals/risks/nextAction card stack is replaced by
                WalletReadPanel — a single component driven entirely by buildCortexReadV2's
                structured WalletReadV2 output (identity, headline, key signals, why-this-label
                bullets, verified/partial/missing evidence, isolated PnL lanes, next action). See
                app/frontend/lib/walletReadBuilder.ts's own header for the full disclosure. */}
            {(!loading || limitedEvidenceMode) && cortexRead && <WalletReadPanel read={cortexRead} />}

            <div style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '10px', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Wallet Watchlist</p>
                  <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#64748b', lineHeight: 1.4 }}>Saved wallets stay here until you remove them.</p>
                </div>
                <button
                  type="button"
                  className="ws-wl-save"
                  onClick={handleAddWalletToWatchlist}
                  disabled={!result?.scanMetadata?.walletAddress || watchlistStatus === 'saving'}
                >
                  {watchlistStatus === 'saving' ? 'Saving…' : 'Save'}
                </button>
              </div>

              {watchlistMessage && (
                <p style={{ margin: '0 0 10px', fontSize: '11px', color: watchlistStatus === 'error' ? '#f87171' : watchlistStatus === 'exists' ? '#7dd3fc' : '#4ade80', lineHeight: 1.4 }}>
                  {watchlistMessage}
                </p>
              )}

              {watchlistLoading ? (
                <p style={{ margin: 0, fontSize: '12px', color: '#64748b' }}>Loading saved wallets…</p>
              ) : watchlistWallets.length === 0 ? (
                <p style={{ margin: 0, fontSize: '12px', color: '#64748b', lineHeight: 1.55 }}>No saved wallets yet. Scan a wallet, then click Save.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {watchlistWallets.map((wallet) => {
                    const deleting = watchlistDeleting?.toLowerCase() === wallet.address.toLowerCase()
                    const hasValue = wallet.portfolio_value != null && Number.isFinite(wallet.portfolio_value)
                    const sizeTag = hasValue ? watchlistSizeTag(wallet.portfolio_value as number) : null
                    return (
                      <div key={wallet.id ?? wallet.address} className="ws-wl-row">
                        <button type="button" onClick={() => setInput(wallet.address)} title="Load wallet address" style={{ minWidth: 0, flex: 1, textAlign: 'left', border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}>
                          <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', color: '#e2e8f0', fontWeight: 600, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}</p>
                          <p style={{ margin: '3px 0 0', fontSize: '11px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {hasValue ? fmtUSD(wallet.portfolio_value as number) : 'Value not saved'}
                            {sizeTag ? ` · ${sizeTag}` : ''}
                            {wallet.label ? ` · ${wallet.label}` : ''}
                          </p>
                        </button>
                        <button
                          type="button"
                          className="ws-wl-scan"
                          disabled={loading && !limitedEvidenceMode}
                          onClick={() => {
                            // One click: fill the input, then the pendingScanAddressRef effect runs the
                            // normal handleScan() once the input state holds this address.
                            pendingScanAddressRef.current = wallet.address
                            setInput(wallet.address)
                            // Input already holds this address: no state change, so scan directly.
                            if (input === wallet.address) { pendingScanAddressRef.current = null; void handleScan() }
                          }}
                        >
                          Scan
                        </button>
                        <button type="button" className="ws-wl-del" aria-label="Remove wallet from watchlist" title="Remove from watchlist" disabled={deleting} onClick={() => handleRemoveWalletFromWatchlist(wallet.address)}>
                          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div style={{ flexShrink: 0, padding: '12px 22px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: '10px', color: 'rgba(255,255,255,0.16)', letterSpacing: '0.06em', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            CORTEX · Verified on-chain analysis only
          </div>
        </aside>
      </div>
    </>
  )
}

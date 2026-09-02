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
import { supabase } from '@/lib/supabaseClient'
import { scanWalletV2, type WalletScanStageProgress, type WalletChainSelectionAudit, type ScanWalletStatusUpdate } from '@/app/frontend/api/scanWallet'
import { logEngineConsistencyIfDev } from '@/app/frontend/lib/engineConsistencyCheck'
import { logScanIdentityIfDev } from '@/app/frontend/lib/walletScanIdentity'
import { resolvePreservedResultOnScanStart } from '@/app/frontend/lib/walletScanPreservation'
import { computeMergedTotalValueUsd, deriveCanonicalMergeOverride, computeRobinhoodDisplayState } from '@/app/frontend/lib/mergedWalletView'
import { fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { buildWalletReadV2, type WalletReadV2 } from '@/app/frontend/lib/walletReadBuilder'
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
import type { FinalReport } from '@/src/modules/finalReportAssembler/types'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import type { Portfolio as EnginePortfolioV2 } from '@/lib/engine/modules/portfolio/types'
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import type { ChainActivityRecord } from '@/lib/engine/modules/activity/types'
import type { SmartMoneyScore } from '@/lib/engine/modules/smartMoney/types'
import type { PersonalityV2 } from '@/lib/engine/modules/personality/types'
import type { BehaviorV2 } from '@/lib/engine/modules/behavior/types'
import type { RiskV2 } from '@/lib/engine/modules/risk/types'
import type { SignalV2 } from '@/lib/engine/modules/signals/types'
import type { WalletConditionSection } from '@/src/pipeline/walletConditionMessages'
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
  const merged = computeMergedTotalValueUsd(stats.totalValueUsd, robinhoodResult, deriveCanonicalMergeOverride(report))
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

  return buildWalletReadV2({
    walletAddress: report.scanMetadata?.walletAddress,
    scanTimestamp: report.scanMetadata?.scanTimestamp,
    chainsScanned: Array.isArray(report.scanMetadata?.chainsScanned) ? report.scanMetadata.chainsScanned : [],
    behaviorIntel: b,
    finalSummary: report.finalSummary,
    totalValueUsd: merged.totalValueUsd,
    robinhoodIncluded: merged.robinhoodIncluded,
    chainBreakdown,
    pricedTokenCount: stats.pricedTokenCount + (merged.robinhoodIncluded && robinhoodResult?.ok ? robinhoodResult.holdings.holdings.filter((h) => h.valueUsd != null).length + (robinhoodResult.holdings.native?.valueUsd != null ? 1 : 0) : 0),
    concentrationDetail: stats.concentration?.detail ?? null,
    concentrationLabel: b?.concentrationSignals?.concentrationLabel ?? null,
    matchedLotsCount: report.fifoAndPnl?.matchedLots?.length ?? 0,
    lastActiveMs,
    evmPnlLane,
    robinhoodPnlLane,
    robinhoodDisplayState,
    robinhoodResult,
    pnlConfidence,
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
  const [partialSnapshot, setPartialSnapshot] = useState<NonNullable<ScanWalletStatusUpdate['partial']> | null>(null)
  const uiFirstResultMsRef = useRef<number | null>(null)
  const robinhoodSidecarDurationMsRef = useRef<number | null>(null)
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
  const [watchlistLoading, setWatchlistLoading] = useState(false)
  // ROBINHOOD CHAIN WALLET SCANNER, DISCLOSED (phased Robinhood Chain Wallet Scanner rollout,
  // Phase 1+2 UI): deliberately its OWN state, own handler, own results card — never mixed into
  // `result`/`resultEnvelope`/`loading` above, which belong entirely to the existing Base/Ethereum
  // V2 pipeline (scanWalletV2). This block never touches those, so a Robinhood scan can never
  // clobber or be clobbered by a Base/ETH scan's state.
  const [robinhoodLoading, setRobinhoodLoading] = useState(false)
  const [robinhoodError, setRobinhoodError] = useState<string | null>(null)
  const [robinhoodResult, setRobinhoodResult] = useState<RobinhoodWalletScanResponse | null>(null)
  // DEBUG-ONLY RAW VIEW, DISCLOSED (multi-chain integration task's own "no separate custom page
  // unless debug=true" requirement): the normal Robinhood card UI below never depends on this — it
  // only gates an OPTIONAL raw-JSON troubleshooting block appended after the real cards, for anyone
  // who lands on this page with ?debug=true.
  const [debugMode, setDebugMode] = useState(false)
  const [watchlistDeleting, setWatchlistDeleting] = useState<string | null>(null)

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
          // Same canonical-total fix as PortfolioSnapshot/buildCortexReadV2 above — never persist
          // the stale V1 total to the watchlist.
          portfolio_value: result.portfolioV2?.totalValueUsd ?? result.portfolio?.totalValueUsd ?? null,
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
    const address = input.trim()
    if (!address) return
    if (scanInFlightRef.current) return
    scanInFlightRef.current = true

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

    setLoading(true)
    setError(null)
    setPartialSnapshot(null)
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
    void handleRobinhoodScan().finally(() => {
      robinhoodSidecarDurationMsRef.current = Date.now() - scanStartedAt
    })
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

    // SCAN IDENTITY CAPTURE, DISCLOSED: held in a local (not read back from `currentJobId` state,
    // which the finally-block below deliberately clears) so the completed report is bound to the
    // exact job that produced it, with no dependency on React state timing.
    let scanJobId: string | null = null
    try {
      // ACCESS TOKEN, FIXED (audit: wallet-scanner plan gate): the enqueue route now checks the
      // caller's plan server-side — forward the same access token every other authenticated call
      // in this file already reads via supabase.auth.getSession() (see lines above).
      const { data: { session: scanSession } } = await supabase.auth.getSession()
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
      const response = await scanWalletV2(address, ['base', 'eth', 'robinhood'], mode, ({ jobId, status, progress, partial, walletChainSelectionAudit }) => {
        scanJobId = jobId
        setCurrentJobId(jobId)
        setJobStatusMessage(status === 'queued' ? 'queued — still scanning…' : status === 'running' ? 'running — still scanning…' : status)
        // REAL STAGE LABEL, DISCLOSED: only ever set from a real backend checkpoint (see
        // WalletScanStageProgress's own header) — never advanced by a client-side timer/guess, and
        // never cleared back to null mid-scan (a later poll simply hasn't reached a new checkpoint
        // yet — the last real stage stays visible rather than the UI reverting to a generic spinner).
        if (progress) setScanProgress(progress)
        if (partial) {
          if (uiFirstResultMsRef.current == null) uiFirstResultMsRef.current = Date.now() - scanStartedAt
          setPartialSnapshot(partial)
        }
        // Only present on the enqueue update — kept on later polls that don't carry it (see
        // ScanWalletStatusUpdate's own header in scanWallet.ts).
        if (walletChainSelectionAudit) {
          setChainSelectionAudit(walletChainSelectionAudit)
          // eslint-disable-next-line no-console
          console.log('[SCAN] walletChainSelectionAudit', walletChainSelectionAudit)
        }
      }, scanSession?.access_token)
      setScanDurationMs(Date.now() - scanStartedAt)
      // CONFIRMED ROOT-CAUSE FIX, DISCLOSED (live-value staleness task): both failure paths below
      // previously left the PRESERVED previous result on screen — the `degraded` branch did a bare
      // `return`, and a thrown scan only called setError() — while the results block renders on
      // `result` alone, independent of `error`. A wallet whose real value had since changed
      // therefore kept displaying its OLD total, indistinguishable from a current one, after every
      // failed rescan. Dropping the envelope here is the honest outcome: a scan that did not
      // produce a new complete result must never leave stale totals presented as current.
      if (response.degraded) {
        setResultEnvelope(null)
        setError('Final scan result is temporarily unavailable. The scan reached a terminal degraded state; please rescan in a moment. Previous results were cleared — they may no longer reflect this wallet\'s current value.')
        return
      }
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? 'Scan failed')
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
      setPartialSnapshot(null)
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
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('Scan failed', err)
      setResultEnvelope(null)
      setPartialSnapshot(null)
      setError(err instanceof Error ? err.message : 'Scan failed — try again later')
    } finally {
      setLoading(false)
      setJobStatusMessage(null)
      setCurrentJobId(null)
      setScanProgress(null)
    }
  }

  // ROBINHOOD CHAIN SCAN, DISCLOSED (phased rollout, Phase 1+2): a genuinely separate request to a
  // genuinely separate route (GET /api/wallet-scan/robinhood) — never touches scanWalletV2, never
  // touches resultEnvelope/loading/error above. Runs entirely independently of a Base/ETH scan; a
  // user can have both a Base/ETH result and a Robinhood result on screen at once.
  async function handleRobinhoodScan() {
    const address = input.trim()
    if (!address) return
    setRobinhoodLoading(true)
    setRobinhoodError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(`/api/wallet-scan/robinhood?address=${encodeURIComponent(address)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const json = await res.json().catch(() => null) as (RobinhoodWalletScanResponse & { error?: { message?: string } }) | null
      if (!res.ok || !json?.ok) {
        setRobinhoodResult(null)
        setRobinhoodError(json?.error?.message ?? 'Robinhood scan failed — try again later')
        return
      }
      setRobinhoodResult(json)
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

  return (
    <>
      <style>{`
        .ws-row:hover { background: rgba(255,255,255,0.030) !important; }
        .ws-scan-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #2DD4BF, #22c5ae) !important;
          box-shadow: 0 0 28px rgba(45,212,191,0.50), 0 4px 16px rgba(0,0,0,0.30) !important;
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
        .ws-content-col { max-width: 1180px; margin: 0 auto; }
        @media (max-width: 768px) {
          .wallet-main { padding: 52px 16px 100px !important; }
          .wallet-input-row { flex-direction: column; max-width: 100% !important; }
          .wallet-input-row button { width: 100%; justify-content: center; }
        }
      `}</style>

      <div className="flex h-full overflow-hidden" style={{ color: '#e2e8f0' }}>
        {/* ── Left: scrollable main area ─────────────────────────────────── */}
        <div className="mob-scan-main wallet-main" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '36px 40px 120px', background: 'radial-gradient(ellipse 80% 35% at 50% 0%, rgba(45,212,191,0.035) 0%, transparent 65%)' }}>
          <div className="ws-content-col">

          {/* Header */}
          <div style={{ marginBottom: '36px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '12px' }}>
              <h1 style={{
                fontSize: '32px', fontWeight: 900, lineHeight: 1.05,
                margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)',
                letterSpacing: '-0.03em',
                background: 'linear-gradient(135deg, #f1f5f9 0%, #94a3b8 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}>
                Wallet Scanner
              </h1>
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                padding: '4px 12px', borderRadius: '99px',
                background: 'linear-gradient(135deg, rgba(139,92,246,0.22), rgba(168,85,247,0.14))',
                border: '1px solid rgba(139,92,246,0.45)',
                color: '#c4b5fd',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase', flexShrink: 0,
                boxShadow: '0 0 16px rgba(139,92,246,0.15)',
              }}>
                Elite
              </span>
            </div>
            <p style={{ fontSize: '14px', color: 'rgba(148,163,184,0.80)', margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '0.01em' }}>
              Advanced on-chain intelligence · AI-powered wallet analysis · 180-Day Intelligence Engine
            </p>
          </div>

          {/* Input */}
          <div className="wallet-input-row" style={{ display: 'flex', gap: '10px', maxWidth: '700px', marginBottom: '20px' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleScan() }}
              disabled={loading}
              placeholder="0x… wallet address"
              spellCheck={false}
              style={{
                flex: 1, padding: '14px 16px', background: 'rgba(255,255,255,0.035)',
                border: '1px solid rgba(255,255,255,0.09)', borderRadius: '13px', color: '#e2e8f0',
                fontSize: '15px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                outline: 'none', boxSizing: 'border-box', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.18)',
              }}
            />
            <button
              className="ws-scan-btn"
              onClick={() => void handleScan()}
              disabled={loading || !input.trim()}
              style={{
                padding: '14px 24px', borderRadius: '13px', border: 'none',
                background: (loading || !input.trim()) ? 'rgba(45,212,191,0.20)' : 'linear-gradient(135deg, #2DD4BF, #22c5ae)',
                color: (loading || !input.trim()) ? 'rgba(255,255,255,0.30)' : '#03121e',
                fontSize: '11px', fontWeight: 900, letterSpacing: '0.12em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              {loading ? 'Scanning…' : 'Scan'}
            </button>
          </div>

          {/* Deep Scan and admin-only recovery controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap', marginBottom: '24px' }}>
            <button
              onClick={() => void handleScan('deep')}
              disabled={loading || !input.trim()}
              title="Deep scan — holdings and portfolio first, then recovery and PnL."
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 13px', borderRadius: '8px', border: '1px solid rgba(45,212,191,0.45)',
                background: 'rgba(45,212,191,0.08)', color: '#2DD4BF',
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
                cursor: (loading || !input.trim()) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}
            >
              Deep Scan
            </button>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.04em' }}>
              Holdings + portfolio first · PnL and recovery follow
            </span>
            {/* ROBINHOOD SEPARATE BUTTON REMOVED, DISCLOSED (multi-chain integration task): Robinhood
                Chain is no longer a separate, bolt-on action — handleScan() above now fires
                handleRobinhoodScan() automatically as part of a normal multi-chain scan (chainSlug
                'robinhood', chainId 4663, alongside Base/ETH). Explicit re-scanning stays possible
                via the "Rescan" control inside the Robinhood card itself, once results exist. */}
          </div>

          {/* Loading state */}
          {loading && (
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
              {scanProgress && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>
                  {(scanProgress.elapsedMs / 1000).toFixed(1)}s elapsed
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

          {loading && partialSnapshot && !result && (() => {
            const merged = computeMergedTotalValueUsd(partialSnapshot.portfolioTotalValueUsd, robinhoodResult)
            const chainLabels = partialSnapshot.activeChainIds.map((id) => (
              id === 8453 ? 'Base' : id === 1 ? 'ETH' : id === 4663 ? 'Robinhood' : `chain ${id}`
            ))
            if (merged.robinhoodIncluded && !chainLabels.includes('Robinhood')) chainLabels.push('Robinhood')
            const top = partialSnapshot.topHoldings.slice(0, 5)
            return (
              <div className="ws-card" style={{ marginBottom: '16px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                <div style={{ fontSize: '9px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#2DD4BF', marginBottom: '10px' }}>
                  Portfolio snapshot · live
                </div>
                <div style={{ fontSize: '22px', fontWeight: 800, color: '#e2e8f0', marginBottom: '8px' }}>
                  {fmtUsd(merged.totalValueUsd)}
                </div>
                <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.8)', marginBottom: '10px' }}>
                  Chains: {chainLabels.join(', ') || 'pending'} · {partialSnapshot.holdingsCount} holdings
                  {merged.robinhoodIncluded ? ' · includes Robinhood' : ''}
                </div>
                {top.length > 0 && (
                  <div style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>
                    {top.map((h) => `${h.symbol} ${fmtUsd(h.valueUsd)}`).join(' · ')}
                  </div>
                )}
                <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24' }}>
                  PnL: pending — Base/ETH and Robinhood lanes stay separate. Deep scan still running.
                </div>
              </div>
            )
          })()}

          {/* Error state */}
          {!loading && error && (
            <div className="ws-card" style={{ borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.06)', color: '#fca5a5', fontSize: '13px' }}>
              Scan failed — try again later. ({error})
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
          {!robinhoodLoading && robinhoodError && !result && (
            <div className="ws-card" style={{ borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.06)', color: '#fca5a5', fontSize: '13px', marginBottom: '16px' }}>
              Robinhood Chain scan failed — try again later. ({robinhoodError})
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

          {robinhoodResult && (!result || debugMode) && !partialSnapshot && (
            <div className="ws-card" style={{ marginBottom: '16px' }}>
              <RobinhoodChainSection
                result={robinhoodResult}
                onRescan={() => void handleRobinhoodScan()}
                rescanLoading={robinhoodLoading}
                debugMode={debugMode}
              />
            </div>
          )}

          {/* Idle placeholder */}
          {!loading && !error && !result && (
            <div className="ws-card ws-card-hover" style={{ textAlign: 'center', padding: '48px 24px', color: 'rgba(255,255,255,0.30)' }}>
              <div className="ws-section-header" style={{ color: 'rgba(45,212,191,0.55)', marginBottom: '10px' }}>CORTEX · Wallet Intelligence</div>
              <p style={{ fontSize: '13px', lineHeight: 1.7, margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                Enter a wallet address above to generate a CORTEX wallet read — portfolio value, holdings, and on-chain behavior via the 180-Day Intelligence Engine.
              </p>
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
              scanDurationMs={scanDurationMs}
              moduleErrors={moduleErrors}
              robinhoodResult={robinhoodResult}
              onRobinhoodRescan={() => void handleRobinhoodScan()}
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
        <aside className="mob-verdict-panel hidden md:flex" style={{
          width: '360px', flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          background: 'linear-gradient(180deg, #070b14 0%, #060a12 100%)',
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

          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {loading && (
              <p style={{ fontSize: '12px', color: 'rgba(45,212,191,0.60)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>CORTEX reading wallet activity…</p>
            )}
            {!loading && !cortexRead && (
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.18)', lineHeight: 1.7, fontFamily: 'var(--font-inter, Inter, sans-serif)', margin: 0 }}>
                Scan a wallet to generate a CORTEX wallet read.
              </p>
            )}
            {/* PREMIUM WALLET READ, DISCLOSED (Wallet Read / CORTEX sidebar redesign task): the old
                flat verdict/read/keySignals/risks/nextAction card stack is replaced by
                WalletReadPanel — a single component driven entirely by buildCortexReadV2's
                structured WalletReadV2 output (identity, headline, key signals, why-this-label
                bullets, verified/partial/missing evidence, isolated PnL lanes, next action). See
                app/frontend/lib/walletReadBuilder.ts's own header for the full disclosure. */}
            {!loading && cortexRead && <WalletReadPanel read={cortexRead} />}

            <div style={{ marginTop: '4px', background: 'rgba(45,212,191,0.035)', border: '1px solid rgba(45,212,191,0.12)', borderRadius: '14px', padding: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '9px', fontWeight: 800, color: 'rgba(45,212,191,0.70)', letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Wallet Watchlist</p>
                  <p style={{ margin: '5px 0 0', fontSize: '11px', color: 'rgba(148,163,184,0.68)', lineHeight: 1.4 }}>Saved wallets stay here until you remove them.</p>
                </div>
                <button
                  type="button"
                  onClick={handleAddWalletToWatchlist}
                  disabled={!result?.scanMetadata?.walletAddress || watchlistStatus === 'saving'}
                  style={{ border: '1px solid rgba(45,212,191,0.30)', background: result?.scanMetadata?.walletAddress ? 'rgba(45,212,191,0.10)' : 'rgba(148,163,184,0.06)', color: result?.scanMetadata?.walletAddress ? '#2DD4BF' : 'rgba(148,163,184,0.35)', borderRadius: '999px', padding: '7px 10px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', cursor: result?.scanMetadata?.walletAddress && watchlistStatus !== 'saving' ? 'pointer' : 'not-allowed' }}
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
                <p style={{ margin: 0, fontSize: '12px', color: 'rgba(148,163,184,0.55)' }}>Loading saved wallets…</p>
              ) : watchlistWallets.length === 0 ? (
                <p style={{ margin: 0, fontSize: '12px', color: 'rgba(148,163,184,0.45)', lineHeight: 1.55 }}>No saved wallets yet. Scan a wallet, then click Save.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {watchlistWallets.map((wallet) => {
                    const deleting = watchlistDeleting?.toLowerCase() === wallet.address.toLowerCase()
                    return (
                      <div key={wallet.id ?? wallet.address} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '10px', borderRadius: '11px', background: 'rgba(6,10,18,0.72)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <button type="button" onClick={() => setInput(wallet.address)} title="Load wallet address" style={{ minWidth: 0, flex: 1, textAlign: 'left', border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}>
                          <p style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{wallet.address.slice(0, 8)}…{wallet.address.slice(-6)}</p>
                          <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'rgba(148,163,184,0.55)' }}>{wallet.portfolio_value ? fmtUSD(wallet.portfolio_value) : 'Value not saved'}{wallet.label ? ` · ${wallet.label}` : ''}</p>
                        </button>
                        <button type="button" aria-label="Remove wallet from watchlist" disabled={deleting} onClick={() => handleRemoveWalletFromWatchlist(wallet.address)} style={{ width: '30px', height: '30px', flexShrink: 0, borderRadius: '9px', border: '1px solid rgba(248,113,113,0.22)', background: 'rgba(248,113,113,0.08)', color: deleting ? 'rgba(248,113,113,0.45)' : '#f87171', cursor: deleting ? 'wait' : 'pointer', fontSize: '14px', lineHeight: 1 }}>
                          🗑
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

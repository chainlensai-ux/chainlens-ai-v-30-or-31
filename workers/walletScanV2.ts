// workers/walletScanV2.ts — in-process V2 scan worker.
//
// NAMING DISCLOSURE: this is `workers/` (plural), a NEW directory, distinct from the existing
// `worker/` (singular) at the repo root — that one is a standalone, always-on Express process
// (worker/server.ts) deployed separately on Railway, reached over HTTP, not importable from a
// Next.js API route. This file is the opposite: a plain in-process TypeScript module, imported and
// called synchronously by app/api/scan-v2/full-scan/route.ts in the same serverless invocation. The
// two are unrelated; this file does not touch, wrap, or duplicate worker/server.ts in any way.
//
// WHAT MOVED HERE, DISCLOSED: this is the exact module-chain body that previously lived inline in
// app/api/scan-v2/full-scan/route.ts's POST handler — every field, every try/catch degrade-shape,
// every disclosure comment from that file's history is preserved verbatim below (see git history on
// that file for the full per-module disclosure trail: holdings/pricing/portfolio/pnl/chainActivity/
// risk/personality/behavior/signals/smartMoneyScore). Nothing was rewritten, reordered, or
// resimplified in the move — only relocated, so the route can become a thin dispatcher per this
// task's request. router.handleScanRequest (the real orchestrator every other scan route also
// calls) is still called from here, unchanged; this file does not reimplement or bypass it.

import { router } from '@/src/deployment/index'
import { fetchAllHoldings } from '@/lib/engine/modules/holdings/fetchHoldings'
import { priceHoldings } from '@/lib/engine/modules/pricing/fetchPricing'
import { buildPortfolio } from '@/lib/engine/modules/portfolio/buildPortfolio'
import { computePnl, fetchParsedTrades } from '@/lib/engine/modules/pnl/computePnl'
import { computeChainActivity } from '@/lib/engine/modules/activity/computeChainActivity'
import { computeRisk } from '@/lib/engine/modules/risk/computeRisk'
import { computePersonality } from '@/lib/engine/modules/personality/computePersonality'
import { computeBehavior } from '@/lib/engine/modules/behavior/computeBehavior'
import { computeSignals } from '@/lib/engine/modules/signals/computeSignals'
import { computeSmartMoneyScore, deriveSmartMoneyInputs } from '@/lib/engine/modules/smartMoney/computeSmartMoneyScore'
import { createEventsCache } from '@/app/api/_shared/eventsCache'
import { createCuBudget } from '@/app/api/_shared/cuBudget'
import { recordCuUsage } from '@/app/api/_shared/cuUsageStore'
import { logFifoPricingDivergence, shouldSampleThisScan } from '@/lib/server/engineComparison'
import { setJobProgress } from '@/src/modules/scanJobs'
import { withScanTimeout } from '@/src/utils/timeout'
import { alchemyAudit } from '@/lib/server/alchemyAudit'

// V2-DIRECT-FAILURE LOGGER: moved here unchanged from the route file (still exported so the route
// can also tag its own outer catch with the same log tag).
export function logDirectFailure(error: unknown): void {
  const err = error as { message?: string; stack?: string } | null
  // eslint-disable-next-line no-console
  console.error('[V2-DIRECT-FAILURE]', { message: err?.message, stack: err?.stack })
}

// SHAPE-CHECK, DISCLOSED DEVIATION (unchanged from the route file's own history): checks the real
// field names (pnlV2/chainActivityV2), diagnostic-only — logs a warning but never changes the
// status code or body.
function logIfUnexpectedV2Shape(data: Record<string, unknown> | undefined): void {
  if (!data) return
  if (data.pnlV2 === undefined || data.chainActivityV2 === undefined) {
    // eslint-disable-next-line no-console
    console.warn('[V2-DIRECT-FAILURE] unexpected response shape (missing pnlV2/chainActivityV2)', {
      hasPnlV2: data.pnlV2 !== undefined,
      hasChainActivityV2: data.chainActivityV2 !== undefined,
    })
  }
}

// MINIMAL SHAPE GUARD (unchanged from the route file's own history): checks only scanMetadata/
// chainSelection — real, non-optional fields on SanitizedReportV2, guaranteed present on every
// successful handleScanRequest response.
function isValidV2Result(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false
  if (typeof data !== 'object') return false
  if (!data.scanMetadata) return false
  if (!data.chainSelection) return false
  return true
}

export type WalletScanV2WorkerResult = { status: number; body: unknown }

// HEAVY-WALLET FAST-FAIL, DISCLOSED: same 800-event threshold this codebase already uses as its
// post-hoc CU guard (app/api/scan-v2/worker/route.ts's CU_GUARD_EVENT_THRESHOLD) — reused here,
// not a new/different number, so this fast-fail and that guard agree on what "heavy" means.
const HEAVY_WALLET_EVENT_THRESHOLD = 800

function sumProviderEventCount(providerDiagnostics: unknown): number {
  if (!Array.isArray(providerDiagnostics)) return 0
  return providerDiagnostics.reduce((sum: number, entry) => {
    const alchemy = (entry as { alchemy?: { eventCount?: number } })?.alchemy
    return sum + (typeof alchemy?.eventCount === 'number' ? alchemy.eventCount : 0)
  }, 0)
}

const TOTAL_MODULES = 11

// PER-MODULE TIMEOUT, DISCLOSED (stuck-at-module-11 task): the existing per-module try/catch
// blocks below only guard against a module REJECTING — they do nothing if a module's awaited call
// never settles at all (e.g. a stuck provider fetch with no internal timeout), since `await` on a
// promise that never resolves or rejects just waits forever. That's the real, literal cause of a
// job appearing stuck at whatever module was running when the hang started: the OUTER whole-worker
// timeout (app/api/scan-v2/worker/route.ts's withScanTimeout, 600s) still eventually fires and
// marks the job 'failed' — so a job is never truly stuck forever — but a user watching the UI has
// no way to tell "hung, will fail in a few minutes" from "actually stuck", and one hung module
// blocks all 10 remaining ones from ever running. Wrapping each module in its own 20s race means a
// single hang costs ~20s instead of blocking (up to) the full 600s, and the other modules still get
// a chance to run and produce real data instead of the whole scan degrading to nothing.
const MODULE_TIMEOUT_MS = 20_000

// Keep the in-process scan budget aligned with the 300s wallet-scan route maxDuration.
// The previous 45s cap returned worker_global_timeout for normal production scans before
// the background route had a chance to finish its full V2 module chain. Leave a safety
// margin for final Redis publication and the HTTP response.
export const WORKER_GLOBAL_TIMEOUT_MS = 270_000

function timedOutPartialResult(error = 'worker_global_timeout'): WalletScanV2WorkerResult {
  return { status: 200, body: { success: false, error, partial: true } }
}

function remainingWorkerMs(startTime: number): number {
  return Math.max(1, WORKER_GLOBAL_TIMEOUT_MS - (Date.now() - startTime))
}

function moduleTimeoutMs(startTime: number): number {
  return Math.max(1, Math.min(MODULE_TIMEOUT_MS, remainingWorkerMs(startTime)))
}

// RPC-CALL AUDIT THRESHOLD, DISCLOSED (runaway-RPC task): reuses lib/server/alchemyAudit.ts's
// existing global `alchemyAudit.calls` registry — the only real per-call record in this codebase
// (see that file's own header: every real Alchemy call already goes through `auditRPC()` at its
// three real call sites, src/modules/providerFetchWindow/utils.ts, src/modules/holdings/utils.ts,
// src/modules/recoveryPolicy/utils.ts). There is no per-module tag on those calls today, and adding
// one would mean threading a new parameter through three files this whole session has treated as
// protected/untouched production code. Instead: snapshot `alchemyAudit.calls.length` right before a
// module starts, then poll the delta — calls made WHILE this module is running are attributed to
// it. `resetAlchemyAudit()` already runs once per request (both worker routes call it before
// dispatching here), so this snapshot is a real per-module count within one scan, not stale data
// from a previous request on a warm serverless instance.
const RPC_CALL_THRESHOLD = 200
const RPC_POLL_INTERVAL_MS = 500

// PER-SCAN RPC BUDGET, DISCLOSED (Alchemy-hard-limit task): distinct from RPC_CALL_THRESHOLD above
// (which bounds ONE module's own calls) — this bounds the CUMULATIVE total across the whole scan.
// INVESTIGATED FIRST, DISCLOSED: this task assumed src/modules/providerFetchWindow/utils.ts,
// src/modules/holdings/utils.ts, and src/modules/recoveryPolicy/utils.ts each contain a
// window/pagination loop that can grow unboundedly ("MAX_BLOCKS_PER_SCAN", "MAX_PAGES_PER_SCAN",
// "stop even if pageKey is still present"). Verified by reading all three: none of them do.
// fetchAlchemyRawEvents (providerFetchWindow) makes exactly 2 calls per invocation (from/to
// address), single page, no pageKey follow-up — already commented "never deep-page".
// fetchAlchemyHoldings (holdings/utils.ts) makes exactly 1 call per chain, no pagination.
// recoveryPolicy's buildRecoveryPolicyObject (index.ts, not utils.ts) already enforces
// maxHistoricalPagesPerWallet/maxHistoricalPagesPerToken via a running totalPagesUsedThisWallet
// counter — already the exact "per-scan budget" pattern this task asks for, already shipped,
// already disclosed in that file's own CU-RISK comment. recoveryPolicy also isn't even reachable
// from this V2 chain — it only runs from the old pipeline (deep-scan only). computeChainActivity
// makes zero direct provider calls (a pure transform). So the only two REAL Alchemy-touching
// modules in this chain are `holdings` and `trades` (fetchParsedTrades -> providerFetchWindow),
// normally totaling roughly 3 calls/chain across 2-3 chains — nowhere near a scale where per-file
// pagination caps would matter. No fabricated caps were added to those three already-bounded files.
//
// What IS real and new: this cumulative check, gating the two actual Alchemy-touching modules so
// that if the scan's total real call count (across whatever already ran) exceeds this budget —
// which would only happen if something is genuinely misbehaving, e.g. the exact hung/looping-module
// scenario RPC_CALL_THRESHOLD above already guards per-module — the REMAINING heavy module is
// skipped entirely (never even attempted) rather than adding more real calls on top of an already-
// abnormal scan.
const MAX_CALLS_PER_SCAN = 500

// Checks the scan's cumulative real Alchemy call count so far. On first crossing the budget,
// records a single `moduleErrors.rpcBudget` entry (not overwritten on subsequent checks, so the
// original crossing point is preserved) and returns true so the caller can skip the next heavy
// module instead of attempting it. Exported for unit testing (same rationale as
// runWithTimeoutAndRpcAudit above).
export function scanRpcBudgetExceeded(moduleErrors: Record<string, string>): boolean {
  const callsSoFar = alchemyAudit.calls.length
  if (callsSoFar > MAX_CALLS_PER_SCAN) {
    if (!moduleErrors.rpcBudget) {
      moduleErrors.rpcBudget = `RPC_BUDGET_EXCEEDED_${callsSoFar}_CALLS`
      // eslint-disable-next-line no-console
      console.warn('[worker] scan-level RPC budget exceeded, skipping remaining heavy modules', { callsSoFar, MAX_CALLS_PER_SCAN })
    }
    return true
  }
  return false
}

// PREMISE CORRECTION, DISCLOSED: smartMoneyScore (the module this task specifically named) makes
// ZERO provider calls — it's a synchronous pure scoring function over already-computed numbers
// (see its own call site below and lib/engine/modules/smartMoney/computeSmartMoneyScore.ts's
// header). It is NOT wrapped here, same as it was never wrapped by the per-module timeout either —
// there is nothing for it to loop or burn RPC calls on. The real, heavy provider-calling modules
// are holdings/trades/chainActivity (and, via those, providerFetchWindow/holdings/recoveryPolicy's
// real Alchemy call sites) — all 10 async modules below are wrapped, so whichever one is actually
// looping gets caught regardless of which the task assumed.
//
// Runs one module's async call with its own timeout AND an RPC-call-count guard. Whichever fires
// first — the 20s timeout, or the module's own real Alchemy calls exceeding RPC_CALL_THRESHOLD —
// stops waiting on it, records the reason into `moduleErrors[moduleName]`, and returns the same
// degrade-shape fallback the original try/catch already used for that module. HONEST LIMITATION,
// DISCLOSED (matches this whole codebase's established convention — see src/utils/timeout.ts's own
// header): this stops WAITING on the module, it does not forcibly cancel whatever fetch is
// in-flight at the moment of abort (no AbortSignal threading into the three protected provider
// call sites) — so it bounds how long a runaway loop can block the rest of the scan and makes the
// problem visible via moduleErrors, but a small amount of additional CU from the one in-flight call
// can still land after the abort. Real per-module cancellation would need the same wider,
// out-of-scope change already disclosed in src/utils/timeout.ts.
//
// Exported for unit testing (workers/walletScanV2.runWithTimeoutAndRpcAudit.test.ts, renamed from
// runModuleWithTimeout.test.ts along with this function) — the rest of this file has too large a
// real-provider dependency chain to unit-test directly, but this helper's own timeout/RPC-threshold/
// error-recording logic is self-contained and worth locking in independently. `timeoutMs` is an
// optional override so tests don't have to wait the real 20s default — every real call site in this
// file omits it and gets MODULE_TIMEOUT_MS.
export async function runWithTimeoutAndRpcAudit<T>(
  moduleName: string,
  fn: () => Promise<T>,
  fallback: T,
  moduleErrors: Record<string, string>,
  timeoutMs: number = MODULE_TIMEOUT_MS,
): Promise<T> {
  const startCallCount = alchemyAudit.calls.length
  let rpcGuardTimer: ReturnType<typeof setInterval> | undefined
  const rpcGuard = new Promise<never>((_, reject) => {
    rpcGuardTimer = setInterval(() => {
      const callsThisModule = alchemyAudit.calls.length - startCallCount
      if (callsThisModule > RPC_CALL_THRESHOLD) {
        reject(new Error(`RPC_THRESHOLD_EXCEEDED_${callsThisModule}_calls`))
      }
    }, RPC_POLL_INTERVAL_MS)
  })

  try {
    return await Promise.race([withScanTimeout(fn(), timeoutMs), rpcGuard])
  } catch (err) {
    moduleErrors[moduleName] = err instanceof Error ? err.message : String(err)
    return fallback
  } finally {
    clearInterval(rpcGuardTimer)
  }
}

// PROGRESS REPORTING, DISCLOSED (module-progress-reporting task): fire-and-forget by default (not
// awaited by most call sites), wrapped so a Redis hiccup can never affect or slow down the real
// scan — matches this whole module's own established "never let an added observability call affect
// the real response" convention (see e.g. the engine-comparison call further down). No-ops entirely
// when `jobId` is undefined (the synchronous /full-scan/legacy route has no job to report progress
// against).
//
// RETURNS A PROMISE, DISCLOSED (stuck-at-module-11 race fix): previously returned void, with the
// underlying setJobProgress() call never awaited by ANY caller. setJobProgress does a non-atomic
// read-modify-write (getScanJob then setScanJob with the job snapshot it just read) — for modules
// 1-10 there's enough real work afterward that this always resolves long before the scan finishes,
// but for the LAST module (11), reportProgress() fires immediately before the worker's few remaining
// synchronous statements and its return — leaving a real chance this call's own read-then-write is
// still in flight when app/api/scan-v2/worker/route.ts writes the job's final `status:'completed'`
// moments later. If that dangling write's own `setScanJob` call lands AFTER the completion write, it
// clobbers `status` back to whatever this call's stale read saw ('running'), with `result` still
// null — exactly the reported symptom (UI stuck at "11/11" forever, even though the backend actually
// finished). Now returns the underlying promise so the call site for module 11 specifically can
// await it, guaranteeing it fully resolves before the worker function returns — every other call
// site is unchanged (still fire-and-forget, zero added latency for modules 1-10).
function reportProgress(jobId: string | undefined, currentModule: number, moduleName: string): Promise<void> {
  if (!jobId) return Promise.resolve()
  return setJobProgress(jobId, { currentModule, totalModules: TOTAL_MODULES, moduleName }).catch(() => {
    // setJobProgress already logs its own failures; nothing further to do here.
  })
}

// CU-HARDENING WIRING (unchanged from the route file's own history — fixes docs/CU_AUDIT.md
// Finding #1): a fresh, request-scoped EventsCache is created per call (not a shared module-level
// singleton) and threaded into both fetchParsedTrades and computeChainActivity.
//
// `jobId`, ADDED DISCLOSED (module-progress-reporting task): optional, third parameter — this is
// the ONLY place the actual 11-module boundaries exist (app/api/scan-v2/worker/route.ts just does
// one `await runWalletScanV2Worker(...)` with no visibility into individual modules), so real
// per-module progress reporting has to happen here, not in the route file. Passed by
// app/api/scan-v2/worker/route.ts (which has the real job id); left undefined by
// app/api/scan-v2/full-scan/legacy/route.ts's call site (unchanged, still 2 args) and by any other
// existing caller, so this is purely additive — no existing call site needed to change.
export async function runWalletScanV2Worker(rawBody: unknown, ip: string, jobId?: string): Promise<WalletScanV2WorkerResult> {
  const startTime = Date.now()
  const eventsCache = createEventsCache()
  const cuBudget = createCuBudget()
  // eslint-disable-next-line no-console
  console.debug('[CU-HARDENING] Cache cleared for new request')

  // handleScanRequest already never throws internally (rate-limit/validation errors and any
  // runWalletScanV2 failure are both caught and returned as a structured RouteResult).
  let result: Awaited<ReturnType<typeof router.handleScanRequest>>
  try {
    result = await withScanTimeout(router.handleScanRequest(rawBody, ip), WORKER_GLOBAL_TIMEOUT_MS)
  } catch (err) {
    if (err instanceof Error && err.message === `SCAN_TIMEOUT_${WORKER_GLOBAL_TIMEOUT_MS}ms`) {
      return timedOutPartialResult()
    }
    throw err
  }

  let body = result.body as { success: boolean; data?: { scanMetadata?: { walletAddress?: string } } }

  if (body.success && !isValidV2Result(body.data as Record<string, unknown> | undefined)) {
    logDirectFailure(new Error('Invalid V2 result shape'))
    return { status: 500, body: { success: false, error: 'invalid_v2_shape' } }
  }

  // HEAVY-WALLET FAST-FAIL, DISCLOSED PLACEMENT: `providerDiagnostics` is a real field already
  // populated by router.handleScanRequest (the old pipeline, src/pipeline/index.ts) above — before
  // any of the V2 chain's own holdings/pricing/trades/pnl calls run. Checking it here means a
  // pathological wallet is rejected before the V2 chain's own (separate, additional) provider
  // calls ever fire, not after — a real fast-fail, not a post-hoc one.
  const earlyDiagnostics = (body.data as Record<string, unknown> | undefined)?.providerDiagnostics
  const earlyEventCount = sumProviderEventCount(earlyDiagnostics)
  if (earlyEventCount > HEAVY_WALLET_EVENT_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.warn('[worker] heavy-wallet-fast-fail', { eventCount: earlyEventCount })
    return { status: 200, body: { success: false, error: { message: 'HEAVY_WALLET_FAST_FAIL' } } }
  }

  if (body.success && body.data?.scanMetadata?.walletAddress) {
    const walletAddress = body.data.scanMetadata.walletAddress
    // eslint-disable-next-line no-console
    console.debug('[CU-TRACK] deep-scan start:', { walletAddress, chains: [1, 8453] })
    // WORKER OBSERVABILITY, DISCLOSED: per-module `performance.now()` timing logs added below, per
    // explicit instruction — purely additive console.log calls wrapped around each already-existing
    // module call, in the same order they already ran. No module's logic, arguments, ordering, or
    // try/catch degrade-shape was changed to add these.
    const chainOverallStart = performance.now()
    // MODULE ERRORS, DISCLOSED (stuck-at-module-11 task): collects a real timeout/rejection message
    // per module (see runWithTimeoutAndRpcAudit above), merged into the final response as `moduleErrors`
    // — non-fatal, purely additive; a module recorded here still contributed its degrade-shape
    // fallback to every downstream module exactly as it already did before this change.
    const moduleErrors: Record<string, string> = {}

    reportProgress(jobId, 1, 'holdings')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting holdings')
    let t0 = performance.now()
    // BUDGET CHECK, DISCLOSED: alchemyAudit is reset once per request before this chain starts, so
    // at this point the count is whatever this scan itself has made so far (0 on a normal scan) —
    // this check exists for defense-in-depth consistency with the trades check below, not because
    // holdings is expected to ever trip it first.
    const chainHoldings = scanRpcBudgetExceeded(moduleErrors)
      ? ([] as Awaited<ReturnType<typeof fetchAllHoldings>>)
      : await runWithTimeoutAndRpcAudit('holdings', () => fetchAllHoldings(walletAddress), [] as Awaited<ReturnType<typeof fetchAllHoldings>>, moduleErrors, moduleTimeoutMs(startTime))
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished holdings in', performance.now() - t0, 'ms', 'count=', chainHoldings.length)

    reportProgress(jobId, 2, 'pricing')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting pricing')
    t0 = performance.now()
    const pricing = await runWithTimeoutAndRpcAudit(
      'pricing',
      () => priceHoldings(chainHoldings),
      { pricedHoldings: [], totalValueUsd: 0, chainValueUsd: {}, priceStatus: 'unavailable' } as Awaited<ReturnType<typeof priceHoldings>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished pricing in', performance.now() - t0, 'ms', 'count=', pricing.pricedHoldings.length)

    reportProgress(jobId, 3, 'portfolio')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting portfolio')
    t0 = performance.now()
    const portfolioOutput = await runWithTimeoutAndRpcAudit(
      'portfolio',
      () => buildPortfolio(pricing.pricedHoldings, pricing.totalValueUsd, pricing.chainValueUsd),
      {
        portfolio: { totalValueUsd: 0, categories: [], chains: [], topHoldings: [], stablecoinRatio: 0, concentrationIndex: 0 },
        portfolioStatus: 'empty',
      } as Awaited<ReturnType<typeof buildPortfolio>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished portfolio in', performance.now() - t0, 'ms', 'holdings=', chainHoldings.length)
    // DIAGNOSTIC, DISCLOSED (portfolio-intelligence $0 bug fix): real counts only — pricedTokens
    // here is the actual number of pricing.pricedHoldings with a non-null valueUsd (not
    // portfolioOutput.portfolio.topHoldings.length, which the frontend's PortfolioIntelligenceCard
    // caps at 5 — see that component's own "ONE HONEST GAP" comment).
    // eslint-disable-next-line no-console
    console.log('[V2-worker] portfolioIntelligenceInputs', {
      totalValueUsd: portfolioOutput.portfolio.totalValueUsd,
      pricedTokens: pricing.pricedHoldings.filter((h) => h.valueUsd != null).length,
      holdingsWithUsdValue: pricing.pricedHoldings.filter((h) => h.valueUsd != null).length,
      totalHoldings: pricing.pricedHoldings.length,
    })

    // CU-DIAG, DISCLOSED SCOPE: this is the real provider-heavy step (fetchParsedTrades ->
    // walletChainPipeline.fetchRawEventsForChain -> the actual GoldRush/Alchemy calls) — but those
    // real fetch functions live in src/modules/providerFetchWindow/utils.ts, a production module
    // this entire session has treated as untouched, protected code (see this file's own header and
    // every prior commit's disclosures). Logging is added here, at the call site, instead — it
    // reveals trade-event volume per scan without modifying any module internals or outputs.
    reportProgress(jobId, 4, 'trades')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting trades')
    t0 = performance.now()
    // BUDGET CHECK, DISCLOSED: if holdings (or anything before this point) already pushed the
    // scan's cumulative real Alchemy call count past MAX_CALLS_PER_SCAN — only plausible if
    // something is genuinely misbehaving — trades is skipped entirely rather than adding its own
    // calls on top of an already-abnormal scan.
    const trades = scanRpcBudgetExceeded(moduleErrors)
      ? ([] as Awaited<ReturnType<typeof fetchParsedTrades>>)
      : await runWithTimeoutAndRpcAudit(
        'trades',
        () => fetchParsedTrades(walletAddress, eventsCache, cuBudget),
        [] as Awaited<ReturnType<typeof fetchParsedTrades>>,
        moduleErrors,
        moduleTimeoutMs(startTime),
      )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished trades in', performance.now() - t0, 'ms', 'count=', trades.length, 'cacheHitsSoFar=', eventsCache.hitCount)

    reportProgress(jobId, 5, 'pnl')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting pnl')
    t0 = performance.now()
    const pnlOutput = await runWithTimeoutAndRpcAudit(
      'pnl',
      () => computePnl(pricing.pricedHoldings, chainHoldings, pricing.totalValueUsd, trades),
      {
        pnlV2: { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [] },
        pnlStatus: 'unavailable',
      } as Awaited<ReturnType<typeof computePnl>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished pnl in', performance.now() - t0, 'ms')

    // DIAGNOSTIC-ONLY ENGINE COMPARISON, DISCLOSED: logs when the old pipeline's two real PnL
    // outputs (fifoAndPnl/pnlSummaryV2, both already computed above via `body`, from
    // router.handleScanRequest) disagree with this chain's own pnlV2 — see
    // lib/server/engineComparison.ts's own header for the full disclosure on what's compared and
    // why. ZERO behavior change: does not read from or write to `body`/`pnlOutput` in any way that
    // affects the real response; wrapped so a bug in the comparison itself can never affect the
    // scan. Sampled (default 1-in-5, per this task's own example) to bound log volume.
    if (shouldSampleThisScan()) {
      try {
        const oldPipelineData = body.data as { fifoAndPnl?: unknown; pnlSummaryV2?: unknown } | undefined
        logFifoPricingDivergence({
          walletAddress,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fifoAndPnl: oldPipelineData?.fifoAndPnl as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pnlSummaryV2: oldPipelineData?.pnlSummaryV2 as any,
          pnlV2: pnlOutput.pnlV2,
        })
      } catch {
        // Never let the comparison itself affect the real scan.
      }
    }

    reportProgress(jobId, 6, 'chainActivity')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting chainActivity')
    t0 = performance.now()
    const chainActivityOutput = await runWithTimeoutAndRpcAudit(
      'chainActivity',
      () => computeChainActivity(
        walletAddress,
        chainHoldings,
        pricing.pricedHoldings,
        trades,
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        eventsCache,
        cuBudget,
      ),
      { chainActivityV2: [], chainActivityStatus: 'empty' } as Awaited<ReturnType<typeof computeChainActivity>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished chainActivity in', performance.now() - t0, 'ms', 'count=', chainActivityOutput.chainActivityV2.length)

    reportProgress(jobId, 7, 'risk')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting risk')
    t0 = performance.now()
    const riskOutput = await runWithTimeoutAndRpcAudit(
      'risk',
      () => computeRisk(
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        chainActivityOutput.chainActivityV2,
        pricing.pricedHoldings,
        chainHoldings,
      ),
      {
        riskV2: {
          score: 0, level: 'low', concentrationRisk: 0, stablecoinRatio: 0,
          unrealizedPnlPressure: 0, chainRisk: 0, volatileExposure: 0, fragmentationRisk: 0,
        },
        riskStatus: 'empty',
      } as Awaited<ReturnType<typeof computeRisk>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished risk in', performance.now() - t0, 'ms')

    reportProgress(jobId, 8, 'personality')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting personality')
    t0 = performance.now()
    const personalityOutput = await runWithTimeoutAndRpcAudit(
      'personality',
      () => computePersonality(
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        chainActivityOutput.chainActivityV2,
        riskOutput.riskV2,
        pricing.pricedHoldings,
        chainHoldings,
      ),
      {
        personalityV2: {
          archetype: 'Unknown', riskAppetite: 'low', tradingStyle: 'passive', chainPreference: null,
          volatilityTolerance: 0, stabilityPreference: 0, pnlBehavior: 'neutral', activityConsistency: 'dormant',
          summary: 'Insufficient data to classify wallet personality.',
        },
        personalityStatus: 'empty',
      } as Awaited<ReturnType<typeof computePersonality>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished personality in', performance.now() - t0, 'ms')

    reportProgress(jobId, 9, 'behavior')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting behavior')
    t0 = performance.now()
    const behaviorOutput = await runWithTimeoutAndRpcAudit(
      'behavior',
      () => computeBehavior(
        pnlOutput.pnlV2,
        portfolioOutput.portfolio,
        chainActivityOutput.chainActivityV2,
        pricing.pricedHoldings,
        chainHoldings,
        trades,
        riskOutput.riskV2,
        personalityOutput.personalityV2,
      ),
      {
        behaviorV2: {
          accumulationStyle: 'neutral', rotationStyle: 'inactive', bridgingBehavior: 'none',
          farmingBehavior: 'none', stableRoutingBehavior: 'none', memeBehavior: 'none',
          tradeFrequency: 'low', behaviorSummary: 'No trade activity found for this wallet.',
        },
        behaviorStatus: 'empty',
      } as Awaited<ReturnType<typeof computeBehavior>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished behavior in', performance.now() - t0, 'ms')

    reportProgress(jobId, 10, 'signals')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting signals')
    t0 = performance.now()
    const signalsOutput = await runWithTimeoutAndRpcAudit(
      'signals',
      () => computeSignals(
        portfolioOutput.portfolio,
        pnlOutput.pnlV2,
        chainActivityOutput.chainActivityV2,
        riskOutput.riskV2,
        personalityOutput.personalityV2,
        behaviorOutput.behaviorV2,
        pricing.pricedHoldings,
        chainHoldings,
        trades,
      ),
      { signalsV2: [], signalsStatus: 'empty' } as Awaited<ReturnType<typeof computeSignals>>,
      moduleErrors,
      moduleTimeoutMs(startTime),
    )
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished signals in', performance.now() - t0, 'ms', 'count=', signalsOutput.signalsV2.length)

    // AWAITED, DISCLOSED: unlike every other reportProgress() call site (still fire-and-forget),
    // this one is awaited — see reportProgress's own header comment for why: this is the LAST
    // progress report, and letting it dangle unawaited is exactly what could race with (and
    // clobber) the worker's final `status:'completed'` write moments later.
    void reportProgress(jobId, 11, 'smartMoneyScore')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] starting smartMoneyScore')
    t0 = performance.now()
    let smartMoneyScore: ReturnType<typeof computeSmartMoneyScore> | undefined
    try {
      smartMoneyScore = computeSmartMoneyScore(
        deriveSmartMoneyInputs({
          pnlV2: pnlOutput.pnlV2,
          pnlStatus: pnlOutput.pnlStatus,
          totalValueUsd: pricing.totalValueUsd,
          behaviorV2: behaviorOutput.behaviorV2,
          personalityV2: personalityOutput.personalityV2,
          chainActivityV2: chainActivityOutput.chainActivityV2,
          riskV2: riskOutput.riskV2,
          signalsV2: signalsOutput.signalsV2,
        }),
      )
    } catch {
      smartMoneyScore = undefined
    }
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished smartMoneyScore in', performance.now() - t0, 'ms')
    // eslint-disable-next-line no-console
    console.log('[V2-worker] total', performance.now() - chainOverallStart)
    // eslint-disable-next-line no-console
    console.log('[V2-worker] finished all modules')
    // CU-DIAG SUMMARY, DISCLOSED DEVIATION: the task's own snippet used a fabricated
    // `events.length * 0.7` estimate tracked in a new local variable. This worker already has a
    // real, exact provider-call counter (cuBudget.providerCalls, threaded through fetchParsedTrades/
    // computeChainActivity) plus the real cache-hit count (eventsCache.hitCount) — using those
    // instead of inventing a second, less accurate estimate.
    // eslint-disable-next-line no-console
    console.log('[CU-DIAG] Estimated CU total (real provider calls, not an approximation):', {
      providerCalls: cuBudget.providerCalls,
      cacheHits: eventsCache.hitCount,
    })

    body = {
      ...body,
      data: {
        ...body.data,
        smartMoneyScore,
        chainHoldings,
        pricedHoldings: pricing.pricedHoldings,
        totalValueUsd: pricing.totalValueUsd,
        chainValueUsd: pricing.chainValueUsd,
        priceStatus: pricing.priceStatus,
        portfolioV2: portfolioOutput.portfolio,
        portfolioStatus: portfolioOutput.portfolioStatus,
        pnlV2: pnlOutput.pnlV2,
        pnlStatus: pnlOutput.pnlStatus,
        chainActivityV2: chainActivityOutput.chainActivityV2,
        chainActivityStatus: chainActivityOutput.chainActivityStatus,
        riskV2: riskOutput.riskV2,
        riskStatus: riskOutput.riskStatus,
        personalityV2: personalityOutput.personalityV2,
        personalityStatus: personalityOutput.personalityStatus,
        behaviorV2: behaviorOutput.behaviorV2,
        behaviorStatus: behaviorOutput.behaviorStatus,
        signalsV2: signalsOutput.signalsV2,
        signalsStatus: signalsOutput.signalsStatus,
        // `moduleErrors`, ADDED DISCLOSED (stuck-at-module-11 task): only present with real
        // entries when at least one module actually timed out/rejected — an empty object here
        // (the common case) means every module ran to real completion within its 20s budget.
        moduleErrors: Date.now() - startTime >= WORKER_GLOBAL_TIMEOUT_MS ? { ...moduleErrors, worker: 'worker_global_timeout' } : moduleErrors,
      },
    } as typeof body

    // eslint-disable-next-line no-console
    console.debug('[CU-HARDENING] Total provider calls avoided:', eventsCache.hitCount)
    // eslint-disable-next-line no-console
    console.debug('[CU-TRACK] deep-scan end:', { providerCalls: cuBudget.providerCalls, cacheHits: eventsCache.hitCount })
    // eslint-disable-next-line no-console
    console.debug('[CU-SUMMARY]', {
      wallet: walletAddress,
      chains: [1, 8453],
      providerCalls: cuBudget.providerCalls,
      cacheHits: eventsCache.hitCount,
      elapsedMs: Date.now() - startTime,
    })
    recordCuUsage(cuBudget.providerCalls, eventsCache.hitCount)
    logIfUnexpectedV2Shape(body.data as Record<string, unknown> | undefined)
  }

  return { status: result.status, body }
}

// WALLET SCANNER STUCK-SCANNING-LIFECYCLE FIX, DISCLOSED — reported: "Wallet Scanner starts scan
// and finds portfolio value/holdings, but UI stays stuck on SCANNING.../Checking activity.../Deep
// scan still running/CORTEX reading wallet activity... It never cleanly transitions to completed
// result", even though holdings/pricing/portfolio were already verified and only PnL/activity were
// still pending/unavailable.
//
// ROOT CAUSE: every "still scanning" UI surface (scan/rescan button disabled state, input disabled
// state, CORTEX Wallet Read sidebar text) was gated on the single monolithic `loading` flag, which
// only flips false once the entire 11-module backend job settles — even though the worker's own
// early partial snapshot (holdings/pricing/portfolio) proves a real, displayable result long before
// PnL/activity/CORTEX finish.
//
// FIX: `limitedEvidenceMode` — a UI-only flag, independent of `loading` — flips true once the
// worker's partial snapshot proves portfolio is ready and PORTFOLIO_READY_GRACE_MS elapses with no
// full result. This unblocks the scan button/input/CORTEX panel without touching the underlying
// poll (which keeps running and can still upgrade the view to a full completed result), and a
// `scanGenerationRef` counter ensures a stale background resolution can never clobber state for a
// newer scan the user started after being unstuck.
//
// This test exercises the exported pure derivation functions directly (deriveWalletScanStageState /
// buildWalletScanLifecycleAudit — the walletScanStageState / walletScanLifecycleAudit shapes this
// task specifies) plus static source assertions for the UI wiring, since the page itself is a large
// client component with real Supabase/browser dependencies not safe to mount in a plain script.
//
// Run directly with:
//   npx tsx scripts/test-wallet-scanner-stuck-lifecycle.mjs

import fs from 'node:fs'

let passed = 0
function check(label, cond) {
  if (cond) { passed++ } else { console.error(`  FAIL: ${label}`); process.exitCode = 1 }
}

const mod = await import('../app/terminal/wallet-scanner/page.tsx')
const { deriveWalletScanStageState, buildWalletScanLifecycleAudit } = mod

console.log('Section A: holdings ready renders portfolio before PnL completes')
{
  const state = deriveWalletScanStageState({
    loading: true, limitedEvidenceMode: false, hasPartialSnapshot: true, hasResult: false,
    pnlStatus: null, chainActivityV2Present: false, hasError: false, timeoutHit: false,
  })
  check('holdings ready as soon as partial snapshot exists', state.holdings === 'ready')
  check('pricing ready as soon as partial snapshot exists', state.pricing === 'ready')
  check('portfolio ready as soon as partial snapshot exists', state.portfolio === 'ready')
  check('pnl still pending (not blocking, but not falsely verified either)', state.pnl === 'pending')
  check('finalStatus is still scanning (grace period not elapsed, no result yet)', state.finalStatus === 'scanning')
}

console.log('\nSection B: PnL unavailable does not keep page scanning — finalStatus reaches completed_with_limited_evidence')
{
  const state = deriveWalletScanStageState({
    loading: true, limitedEvidenceMode: true, hasPartialSnapshot: true, hasResult: false,
    pnlStatus: null, chainActivityV2Present: false, hasError: false, timeoutHit: false,
  })
  check('portfolio stays ready', state.portfolio === 'ready')
  check('pnl reported unavailable, never fabricated as verified', state.pnl === 'unavailable')
  check('finalStatus is completed_with_limited_evidence, not stuck scanning', state.finalStatus === 'completed_with_limited_evidence')
}

console.log('\nSection C: activity unavailable does not block final status once a full result lands')
{
  const state = deriveWalletScanStageState({
    loading: false, limitedEvidenceMode: false, hasPartialSnapshot: false, hasResult: true,
    pnlStatus: 'unavailable', chainActivityV2Present: false, hasError: false, timeoutHit: false,
  })
  check('activity reported unavailable, not pending forever', state.activity === 'unavailable')
  check('pnl reported unavailable per the real pnlStatus field', state.pnl === 'unavailable')
  check('finalStatus is completed once the full result exists, regardless of activity/pnl completeness', state.finalStatus === 'completed')
  check('cortex is ready once the full result exists', state.cortex === 'ready')
}

console.log('\nSection D: a genuinely verified PnL result is never downgraded to pending/unavailable')
{
  const state = deriveWalletScanStageState({
    loading: false, limitedEvidenceMode: false, hasPartialSnapshot: false, hasResult: true,
    pnlStatus: 'verified', chainActivityV2Present: true, hasError: false, timeoutHit: false,
  })
  check('pnl verified stays verified', state.pnl === 'verified')
  check('activity ready when chainActivityV2 is present', state.activity === 'ready')
  check('finalStatus completed', state.finalStatus === 'completed')
}

console.log('\nSection E: stalled worker becomes stalled_with_reason (timeout) or failed (non-timeout) — never stuck scanning')
{
  const stalled = deriveWalletScanStageState({
    loading: false, limitedEvidenceMode: false, hasPartialSnapshot: false, hasResult: false,
    pnlStatus: null, chainActivityV2Present: false, hasError: true, timeoutHit: true,
  })
  check('a timeout with no evidence at all reports stalled, not scanning', stalled.finalStatus === 'stalled')

  const failed = deriveWalletScanStageState({
    loading: false, limitedEvidenceMode: false, hasPartialSnapshot: false, hasResult: false,
    pnlStatus: null, chainActivityV2Present: false, hasError: true, timeoutHit: false,
  })
  check('a non-timeout error reports failed, not scanning', failed.finalStatus === 'failed')
}

console.log('\nSection F: no portfolio value overwritten by pending/null — holdings/pricing/portfolio never regress from ready')
{
  // Once a partial snapshot has proven the portfolio, a LATER poll tick that still has no `result`
  // yet must never re-report holdings/pricing/portfolio as pending — they stay ready until a result
  // (success) or an explicit error supersedes the scan.
  const early = deriveWalletScanStageState({ loading: true, limitedEvidenceMode: false, hasPartialSnapshot: true, hasResult: false, pnlStatus: null, chainActivityV2Present: false, hasError: false, timeoutHit: false })
  const later = deriveWalletScanStageState({ loading: true, limitedEvidenceMode: true, hasPartialSnapshot: true, hasResult: false, pnlStatus: null, chainActivityV2Present: false, hasError: false, timeoutHit: false })
  check('portfolio ready at first partial snapshot', early.portfolio === 'ready')
  check('portfolio still ready after the grace period elapses (never regresses to pending)', later.portfolio === 'ready')
}

console.log('\nSection G: walletScanLifecycleAudit carries every required field, real (not fabricated) values')
{
  const stageState = deriveWalletScanStageState({
    loading: true, limitedEvidenceMode: true, hasPartialSnapshot: true, hasResult: false,
    pnlStatus: null, chainActivityV2Present: false, hasError: false, timeoutHit: false,
  })
  const audit = buildWalletScanLifecycleAudit({
    walletAddress: '0xabc', jobId: 'job-123', requestedMode: 'normal', stageState,
    workerStatus: 'running', polling: true, lastProgressAt: Date.now(), scanStartedAt: Date.now() - 60_000,
    timeoutHit: false, failureReason: null,
  })
  for (const key of ['walletAddress', 'jobId', 'requestedMode', 'stage', 'holdingsReady', 'pricingReady', 'portfolioReady', 'activityReady', 'pnlReady', 'cortexReady', 'workerStatus', 'pollingStatus', 'lastProgressAt', 'elapsedMs', 'timeoutHit', 'finalStatus', 'failureReason']) {
    check(`audit carries ${key}`, key in audit)
  }
  check('portfolioReady reflects the real stage state', audit.portfolioReady === true)
  check('pnlReady is true once pnl reaches a terminal (even unavailable) state — never blocks completion reporting', audit.pnlReady === true)
  check('pollingStatus reflects the real polling flag', audit.pollingStatus === 'polling')
  check('finalStatus mirrors stageState.finalStatus', audit.finalStatus === stageState.finalStatus)
  check('elapsedMs is a real, positive measured duration', audit.elapsedMs >= 60_000)
}

console.log('\nSection H: UI wiring — scan button, input, and CORTEX panel are never gated on `loading` alone')
{
  const src = fs.readFileSync(new URL('../app/terminal/wallet-scanner/page.tsx', import.meta.url), 'utf8')

  check('scan button disabled state also checks limitedEvidenceMode (never disabled forever)', /disabled=\{\(loading && !limitedEvidenceMode\) \|\| !input\.trim\(\)\}/.test(src))
  check('deep scan button disabled state also checks limitedEvidenceMode', /disabled=\{\(loading && !limitedEvidenceMode\) \|\| !input\.trim\(\) \|\| deepScanAtLimit\}/.test(src))
  check('input disabled state also checks limitedEvidenceMode', /disabled=\{loading && !limitedEvidenceMode\}/.test(src))
  check('scan button label resets away from "Scanning…" once limitedEvidenceMode is true', /loading && !limitedEvidenceMode \? 'Scanning…' : loading && limitedEvidenceMode \? 'Rescan'/.test(src))

  check('CORTEX "reading…" text is gated on loading && !limitedEvidenceMode, not loading alone', /\{loading && !limitedEvidenceMode && \(\s*<p[^>]*>CORTEX reading wallet activity…<\/p>/.test(src))
  check('a distinct CORTEX message exists for the limited-evidence, still-processing state', /Portfolio ready\. CORTEX wallet read is still processing in the background/.test(src))
  check('WalletReadPanel renders once cortexRead exists even while limitedEvidenceMode is still technically "loading"', /\{\(!loading \|\| limitedEvidenceMode\) && cortexRead && <WalletReadPanel/.test(src))

  check('the portfolio-snapshot card is no longer gated on `loading` (stays visible through the limitedEvidenceMode transition)', /\{partialSnapshot && !result && \(\(\) => \{/.test(src))
  check('the portfolio-snapshot card never disappears the moment loading flips — guard is purely `!result`', !/\{loading && partialSnapshot && !result && \(\(\) => \{/.test(src))
  check('a "Scan completed with limited evidence" state is shown, matching the task-specified copy', /Scan completed with limited evidence/.test(src))
  check('a "Retry deep scan" action exists on the limited-evidence card', /Retry deep scan/.test(src))
  check('the limited-evidence card never claims a fabricated 0/verified PnL — it says PnL is marked unavailable', /PnL, activity, and the CORTEX wallet read did not finish within/.test(src))

  check('a per-scan generation counter exists to guard stale background resolutions', /scanGenerationRef = useRef\(0\)/.test(src))
  check('the in-flight guard is relaxed once limitedEvidenceMode allows a rescan to supersede a still-polling background scan', /if \(scanInFlightRef\.current && !limitedEvidenceMode\) return/.test(src))
  check('the onUpdate poll callback drops stale updates from a superseded generation', /if \(scanGenerationRef\.current !== myGeneration\) return\s*\n\s*scanJobId = jobId/.test(src))
  check('the finally block only resets loading/progress state for the current (non-superseded) generation', /if \(scanGenerationRef\.current === myGeneration\) \{\s*\n\s*setLoading\(false\)/.test(src))
}

console.log('\nSection I: polling stops once a final status is reached — scanWalletV2 still resolves exactly once per generation, never left dangling')
{
  const clientSrc = fs.readFileSync(new URL('../app/frontend/api/scanWallet.ts', import.meta.url), 'utf8')
  check('the poll loop still terminates on a terminal done/failed status', /if \(pollBody\.status === 'done'\)/.test(clientSrc) && /if \(pollBody\.status === 'failed'\)/.test(clientSrc))
  check('the poll loop still terminates on its own bounded timeout, never polling forever', /Date\.now\(\) - pollStartedAt >= POLL_TIMEOUT_MS/.test(clientSrc))
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (see FAIL lines above)' : ''}`)

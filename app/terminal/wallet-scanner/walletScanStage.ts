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


// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// WALLET-SCAN JOB/POLL PATH: scanWalletV2() enqueues exactly one wallet-scan job through
// /api/wallet-scan, stores the returned jobId in the caller via onUpdate, and polls
// /api/wallet-scan/:jobId every 2.5 seconds until the worker writes the final result. The
// client-facing enqueue request never runs runWalletScanV2Worker inline.
//
// QSTASH REMOVAL, DISCLOSED: this path intentionally avoids the deleted QStash-backed
// /api/scan-start, /api/scan-status, /api/scan-v2/worker, and full-scan start/status routes.

import type { PortfolioEvidence } from '@/lib/walletScan/portfolioEvidence'

export type ScanMode = 'normal' | 'deep'

export type ScanWalletApiResponse = {
  success: boolean
  data?: unknown
  error?: { message: string; category: string; details?: string[] }
  degraded?: boolean
  // Timed out after the holdings/portfolio snapshot: PnL continues in this follow-up job.
  pnlStillProcessing?: boolean
  pnlFollowUpJobId?: string | null
}

const MODULE_ENDPOINTS = [
  ['scanMetadata', 'metadata'],
  ['chainSelection', 'chain-selection'],
  ['timelines', 'timelines'],
  ['holdings', 'holdings'],
  ['portfolio', 'portfolio'],
  ['behaviorIntel', 'behavior-intel'],
  ['recoveryPolicy', 'recovery-policy'],
  ['windowCoverage', 'window-coverage'],
  ['finalSummary', 'final-summary'],
  ['bridgeTimeline', 'bridge-timeline'],
] as const

type ModuleApiResponse = {
  success: boolean
  ok?: boolean
  module?: string
  data?: unknown
  error?: { message: string; category: string; details?: string[] }
}

// SAFETY WRAPPER: never throws. A non-2xx response, a network failure (fetch() itself rejecting —
// offline, DNS, CORS, etc.), or a non-JSON body all resolve to the same structured failure shape
// below instead of propagating an exception — so one module's failure can never crash the whole
// scan.
function moduleFetchFailed(endpoint: string, detail: string): ModuleApiResponse {
  return {
    success: false,
    ok: false,
    module: endpoint,
    error: { message: 'module-failed', category: 'network', details: [detail] },
  }
}

// Fetches a single module. Exported so callers that only need one section (e.g. a component that
// wants just `holdings`) can fetch it directly instead of going through scanWalletV2().
export async function fetchScanModule(
  endpoint: (typeof MODULE_ENDPOINTS)[number][1],
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ModuleApiResponse> {
  try {
    const res = await fetch(`/api/scan-v2/modules/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, chains, scanMode }),
    })

    if (!res.ok) {
      return moduleFetchFailed(endpoint, `HTTP ${res.status}`)
    }

    return await res.json()
  } catch (err) {
    // Network failure (offline, DNS, CORS, timeout) or a malformed/non-JSON body — never throw out
    // of this function.
    return moduleFetchFailed(endpoint, err instanceof Error ? err.message : String(err))
  }
}

const WALLET_SCAN_ROUTE = '/api/wallet-scan'
const POLL_INTERVAL_MS = 2_500
export const POLL_TIMEOUT_MS = 295_000
// Past POLL_TIMEOUT_MS the client keeps waiting only while the server says the job is running and
// its worker reported in recently (the server watchdog fails a silent job after 90s), up to this cap:
// the worker's own 300s function limit plus queueing and the final result write.
export const POLL_HARD_CAP_MS = 420_000
const POLL_LIVE_HEARTBEAT_MS = 45_000
// A joined scan whose job record never appears (its starting request was refused or failed to
// enqueue) is given up on instead of polling a missing job until the overall timeout.
export const POLL_NEVER_FOUND_GIVE_UP_MS = 30_000

/** PURE. Whether the client should keep polling a job that has not finished yet. */
export function shouldKeepPollingWalletScan(params: {
  elapsedMs: number
  status: WalletScanJobStatus | null
  lastWorkerUpdateAgoMs: number | null
}): boolean {
  if (params.elapsedMs < POLL_TIMEOUT_MS) return true
  if (params.elapsedMs >= POLL_HARD_CAP_MS) return false
  return params.status === 'running'
    && params.lastWorkerUpdateAgoMs != null
    && params.lastWorkerUpdateAgoMs < POLL_LIVE_HEARTBEAT_MS
}

type WalletScanJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'not-found'

// STAGE PROGRESS, DISCLOSED (perceived-speed follow-up task): real, present only while the poll
// route's own job record still carries one — see app/api/wallet-scan/[jobId]/route.ts and
// src/modules/walletScanQueue.ts's WalletScanJobProgress for the real, non-fabricated source.
export type WalletScanStageProgress = {
  stage: string
  label: string
  elapsedMs: number
}

// CHAIN SELECTION AUDIT, DISCLOSED (Wallet Scanner deep scan chain coverage fix): the shape
// lib/server/walletChainSelectionAudit.ts's buildWalletChainSelectionAudit() returns, only ever
// echoed back from the /api/wallet-scan POST response — never computed client-side.
export type WalletChainSelectionAudit = {
  requestedMode: string
  enableRobinhood: boolean
  envHasRobinhoodRpc: boolean
  envHasGoldrush: boolean
  envHasBlockscout: boolean
  requestedChains: number[]
  allowedChains: number[]
  omittedChains: number[]
  omittedReasons: Record<string, string>
  finalChainsScanned: string[]
}

type WalletScanJobResponse = {
  jobId?: string
  status?: WalletScanJobStatus
  result?: ScanWalletApiResponse
  error?: string | { message?: string }
  degraded?: boolean
  progress?: WalletScanStageProgress
  partial?: ScanWalletStatusUpdate['partial']
  walletChainSelectionAudit?: WalletChainSelectionAudit
  // Server clock (ms): job creation, the worker's latest heartbeat, and "now" when the poll answered.
  createdAt?: number | null
  heartbeatAt?: number | null
  serverNow?: number
}

export type ScanWalletStatusUpdate = {
  jobId: string
  status: WalletScanJobStatus
  progress?: WalletScanStageProgress
  /** How long ago (ms) the worker last reported in, from the server clock; null before it started. */
  lastWorkerUpdateAgoMs?: number | null
  // FAST SNAPSHOT, DISCLOSED: the worker publishes holdings/portfolio totals on the job record
  // while FIFO/PnL is still running (see publishWalletScanPartialSnapshot). The poll route already
  // echoes `partial`; this client previously dropped it, so the UI waited for the full ~100s job.
  partial?: {
    portfolioTotalValueUsd: number | null
    portfolioEvidence?: PortfolioEvidence | null
    portfolioPricingEvidence?: {
      freshPricedCount: number
      staleVerifiedPricedCount: number
      unpricedCount: number
      freshSubtotalUsd: number
      staleSupportedSubtotalUsd: number
      dominantUnpricedValuePreviouslyUsd?: number
    } | null
    holdingsCount: number
    topHoldings: Array<{ chainId: number; tokenAddress: string; symbol: string; valueUsd: number | null }>
    activeChainIds: number[]
    publishedAtElapsedMs: number
  }
  // Only ever present on the initial enqueue update (the /api/wallet-scan POST response) — a
  // subsequent poll response never carries it, so this field is never overwritten with an absent
  // value on later updates.
  walletChainSelectionAudit?: WalletChainSelectionAudit
}

// The enqueue route answers { error: { message } } for auth/plan/rate/quota/validation, but
// { error: 'scan-queue-unavailable' } (a string) when KV/Redis fails, and a platform timeout has no JSON
// body at all — both previously collapsed into the opaque 'scan-enqueue-failed'.
export function enqueueFailureMessage(httpStatus: number, body: { error?: unknown } | null): string {
  const error = body?.error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message
  if (error === 'scan-queue-unavailable') return 'The scan queue is temporarily unavailable. Please try again in a moment.'
  if (httpStatus === 504 || httpStatus === 408) return 'Starting the scan timed out. Please try again in a moment.'
  return `scan-enqueue-failed (HTTP ${httpStatus})`
}

// Watchdog codes from app/api/wallet-scan/[jobId]/route.ts, in words a user can act on.
export function jobFailureMessage(code: string): string {
  if (code === 'worker_not_started') return 'The scan never started — the background worker did not pick it up within 90 seconds. Please retry.'
  if (code === 'worker_stalled') return 'The scan stopped responding — no progress for 90 seconds. Please retry.'
  return code
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

function toErrorResponse(message: string, details?: string[]): ScanWalletApiResponse {
  return { success: false, error: { message, category: 'network', details } }
}

function isTerminalScanUnavailable(body: WalletScanJobResponse | null): boolean {
  return body?.degraded === true && (body.error === 'scan-queue-unavailable' || body.error === 'scan-status-unavailable')
}

function scanUnavailableResponse(): ScanWalletApiResponse {
  return { success: false, degraded: true, error: { message: 'Scan is currently unavailable. Please try again later.', category: 'network' } }
}

function scanAuthenticationResponse(): ScanWalletApiResponse {
  return { success: false, error: { message: 'Your session has expired. Please sign in again.', category: 'auth' } }
}

// JOB/POLL SCAN PATH: POST returns immediately with a jobId, then this client polls the status
// endpoint every 2.5s until the background worker stores the full scan response. The heavy
// runWalletScanV2Worker call is never made by this client-facing HTTP request.
// A scan can be polled for several minutes, longer than one access token may stay valid while the
// browser session refreshes it. Callers may pass a getter that returns the session's current token;
// a 401/403 then re-reads it once and carries on instead of abandoning a scan that is still running.
export type WalletScanAccessToken = string | (() => Promise<string | null | undefined>)

async function resolveAccessToken(source: WalletScanAccessToken | null | undefined): Promise<string | null> {
  if (!source) return null
  if (typeof source === 'string') return source
  try { return (await source()) ?? null } catch { return null }
}

export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
  onUpdate?: (update: ScanWalletStatusUpdate) => void,
  // ACCESS TOKEN, FIXED (audit: wallet-scanner plan gate): the enqueue route now checks the
  // caller's plan server-side (app/api/wallet-scan/route.ts) — without forwarding the caller's
  // Supabase access token, every request would resolve to 'free' and a legitimate Pro/Elite user
  // would be rejected even though the page already confirmed their access client-side.
  accessTokenSource?: WalletScanAccessToken | null,
): Promise<ScanWalletApiResponse> {
  // Both the enqueue and status routes are user-authenticated. Refuse to start a job that this
  // client cannot subsequently poll rather than leaving the UI indefinitely showing "queued".
  const accessToken = await resolveAccessToken(accessTokenSource)
  if (!accessToken) {
    return scanAuthenticationResponse()
  }

  try {
    const startRes = await fetch(WALLET_SCAN_ROUTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ walletAddress, chains, scanMode }),
    })

    const startBody = await startRes.json().catch(() => null) as WalletScanJobResponse | null
    if (isTerminalScanUnavailable(startBody)) {
      return scanUnavailableResponse()
    }

    if (!startRes.ok || !startBody?.jobId || !startBody.status) {
      return toErrorResponse(enqueueFailureMessage(startRes.status, startBody), [`HTTP ${startRes.status}`])
    }

    onUpdate?.({ jobId: startBody.jobId, status: startBody.status, walletChainSelectionAudit: startBody.walletChainSelectionAudit })

    if (startBody.status === 'done') {
      return startBody.result ?? { success: false, degraded: true, error: { message: 'Final scan result is temporarily unavailable. Please rescan in a moment.', category: 'network' } }
    }

    return await pollWalletScanJob(startBody.jobId, typeof accessTokenSource === 'function' ? accessTokenSource : accessToken, onUpdate)
  } catch (err) {
    return {
      success: false,
      error: { message: err instanceof Error ? err.message : String(err), category: 'network' },
    }
  }
}

// Polls an existing wallet-scan job until it is done/failed (also used for a heavy wallet's
// follow-up PnL job, whose id arrives on the first job's result as `pnlFollowUpJobId`).
export async function pollWalletScanJob(
  jobId: string,
  accessTokenSource: WalletScanAccessToken,
  onUpdate?: (update: ScanWalletStatusUpdate) => void,
): Promise<ScanWalletApiResponse> {
  try {
    let accessToken = await resolveAccessToken(accessTokenSource)
    if (!accessToken) return scanAuthenticationResponse()
    const pollStartedAt = Date.now()
    let lastStatus: WalletScanJobStatus | null = null
    let lastWorkerUpdateAgoMs: number | null = null
    let everFound = false
    const keepPolling = () => shouldKeepPollingWalletScan({ elapsedMs: Date.now() - pollStartedAt, status: lastStatus, lastWorkerUpdateAgoMs })

    for (;;) {
      await sleep(POLL_INTERVAL_MS)
      let pollRes: Response
      try {
        pollRes = await fetch(`${WALLET_SCAN_ROUTE}/${encodeURIComponent(jobId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      } catch (err) {
        // A dropped connection on one poll is not a failed scan: the job keeps running server-side.
        if (keepPolling()) continue
        return toErrorResponse('Scan status is temporarily unavailable. Please rescan in a moment.', [err instanceof Error ? err.message : String(err)])
      }
      const pollBody = await pollRes.json().catch(() => null) as WalletScanJobResponse | null

      // Authentication failures cannot recover by retrying the same credential: re-read the session's
      // current token (it may have been refreshed during a long scan) and retry with it; stop only when
      // there is no newer token, so callers can prompt for a fresh session.
      if (pollRes.status === 401 || pollRes.status === 403) {
        const refreshed = typeof accessTokenSource === 'function' ? await resolveAccessToken(accessTokenSource) : null
        if (refreshed && refreshed !== accessToken) {
          accessToken = refreshed
          continue
        }
        return scanAuthenticationResponse()
      }

      if (isTerminalScanUnavailable(pollBody)) {
        return scanUnavailableResponse()
      }

      if (!pollRes.ok || !pollBody) {
        if (pollRes.status === 404 && !everFound && Date.now() - pollStartedAt >= POLL_NEVER_FOUND_GIVE_UP_MS) {
          return toErrorResponse('This scan could not be started. Please rescan.', ['HTTP 404'])
        }
        // TRANSIENT-POLL-FAILURE RETRY, DISCLOSED (confirmed bug — real production evidence): this
        // previously only retried a 404 "not-found" (a job not yet visible to a cold KV read) —
        // every OTHER non-OK response (in particular a 503 { error: 'scan-status-unavailable' },
        // the poll route's own catch-all for a single transient kv.get() failure) was treated as an
        // immediate, permanent failure, aborting an otherwise-healthy scan on one isolated blip. This
        // exact deployment's KV reads have repeatedly shown occasional transient slowness elsewhere
        // in this same investigation (kv_timeout_safe warnings scattered through real pricing logs) —
        // a single bad poll is expected background noise, not proof the scan itself failed. The
        // isTerminalScanUnavailable() check above already carves out the one case that SHOULD stop
        // immediately (an explicit, repeated degraded-queue signal from the server); every other
        // non-OK/unparsable response now retries like the 404 case already did, bounded by the same
        // overall POLL_TIMEOUT_MS this loop already enforces — a genuinely dead backend still times
        // out honestly, it just no longer gives up on the first isolated hiccup.
        if (keepPolling()) {
          continue
        }
        return toErrorResponse('Scan status is temporarily unavailable. Please rescan in a moment.', [`HTTP ${pollRes.status}`])
      }

      // The poll endpoint returns only { status } / { status, result } and never echoes jobId back
      // (see app/api/wallet-scan/[jobId]/route.ts and its key-alignment tests). We already know the
      // jobId from the enqueue response, so only `status` is required here — requiring pollBody.jobId
      // made every scan fail on its first poll.
      if (!pollBody.status) {
        return toErrorResponse('Scan status is temporarily unavailable. Please rescan in a moment.')
      }

      everFound = true
      lastStatus = pollBody.status
      lastWorkerUpdateAgoMs = typeof pollBody.serverNow === 'number' && typeof pollBody.heartbeatAt === 'number' ? Math.max(0, pollBody.serverNow - pollBody.heartbeatAt) : null
      onUpdate?.({
        jobId: jobId, status: pollBody.status, progress: pollBody.progress, partial: pollBody.partial,
        lastWorkerUpdateAgoMs,
      })

      if (pollBody.status === 'done') {
        const result = pollBody.result
        if (result?.degraded) {
          const degradedError = typeof result.error === 'string' ? result.error : result.error?.message
          return { success: false, degraded: true, error: { message: degradedError ?? 'scan-final-result-unavailable', category: 'network' } }
        }
        return result ?? { success: false, degraded: true, error: { message: 'Final scan result is temporarily unavailable. Please rescan in a moment.', category: 'network' } }
      }

      if (pollBody.status === 'failed') {
        const message = typeof pollBody.error === 'string' ? pollBody.error : pollBody.error?.message
        return toErrorResponse(jobFailureMessage(message ?? 'scan-failed'))
      }

      if (!keepPolling()) {
        return toErrorResponse('Scan timed out before a final result was available. Please rescan in a moment.', [`timeout ${Date.now() - pollStartedAt}ms`])
      }
    }
  } catch (err) {
    return {
      success: false,
      error: { message: err instanceof Error ? err.message : String(err), category: 'network' },
    }
  }
}

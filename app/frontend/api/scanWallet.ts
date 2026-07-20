// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// QSTASH/WORKER REMOVAL, DISCLOSED (explicit instruction: remove all QStash/worker/job-poll
// infrastructure without touching scanner logic): this file previously had two paths —
// scanWalletV2() (background job/poll via /api/scan-start, /api/scan-v2/full-scan/start +
// /api/scan-status, /api/scan-v2/full-scan/status, all QStash-triggered) and
// scanWalletV2Legacy() (a single synchronous POST to /api/scan-v2/full-scan/legacy, kept as a
// fallback). The job/poll path and everything behind it (src/modules/scanJobCreation.ts,
// app/api/scan-start, app/api/scan-status, app/api/scan-v2/worker, app/api/scan-v2/full-scan/
// {start,status}, app/api/scan-health, app/api/qstash-env-debug) has been deleted entirely. The
// synchronous path is renamed to scanWalletV2() below and is now the only path for both `normal`
// and `deep` scanMode — startDeepScanJob/startFullScanJob/pollScanJobOnce/pollScanJobUntilDone and
// their associated types are removed along with it (no callers remain; app/terminal/
// wallet-scanner/page.tsx was updated to call scanWalletV2() directly for both modes).
//
// REAL TRADEOFF, DISCLOSED: this reintroduces exactly the risk the job/poll system was built to
// remove — a genuinely slow/cold scan can hit app/api/scan-v2/full-scan/legacy/route.ts's own
// maxDuration=300 ceiling and get killed mid-request, and the UI's incremental
// "pending"/"running"/per-module progress display (jobStatusMessage/scanProgress in page.tsx) has
// nothing left to populate it, since there is no longer a poll loop producing status updates — the
// user now sees a single loading state for the whole scan duration instead. This was an explicit,
// informed tradeoff (confirmed before making this change), not an oversight.
//
// runWalletScanV2, runWalletScanV2Worker, holdingsEngine/pricingEngine/portfolioAssembler,
// /api/scan, /api/scan-v2, /api/token-scan, Clark AI, /api/portfolio, and Redis caching are
// completely untouched by this change.
//
// `fetchScanModule` (below) is unrelated to the job/poll system removed above — still exported,
// unchanged, for any caller that wants just one module's section.

export type ScanMode = 'normal' | 'deep'

export type ScanWalletApiResponse = {
  success: boolean
  data?: unknown
  error?: { message: string; category: string; details?: string[] }
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
const MAX_POLL_ATTEMPTS = 80

type WalletScanJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'not-found'

type WalletScanJobResponse = {
  jobId: string
  status: WalletScanJobStatus
  result?: ScanWalletApiResponse
  error?: string | { message?: string }
}

export type ScanWalletStatusUpdate = {
  jobId: string
  status: WalletScanJobStatus
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

function toErrorResponse(message: string, details?: string[]): ScanWalletApiResponse {
  return { success: false, error: { message, category: 'network', details } }
}

// JOB/POLL SCAN PATH: POST returns immediately with a jobId, then this client polls the status
// endpoint every 2.5s until the background worker stores the full scan response. The heavy
// runWalletScanV2Worker call is never made by this client-facing HTTP request.
export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
  onUpdate?: (update: ScanWalletStatusUpdate) => void,
): Promise<ScanWalletApiResponse> {
  try {
    const startRes = await fetch(WALLET_SCAN_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, chains, scanMode }),
    })

    const startBody = await startRes.json().catch(() => null) as WalletScanJobResponse | null
    if (!startRes.ok || !startBody?.jobId) {
      return toErrorResponse(startBody?.error && typeof startBody.error === 'object' && startBody.error.message ? startBody.error.message : 'scan-enqueue-failed')
    }

    onUpdate?.({ jobId: startBody.jobId, status: startBody.status })

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS)
      const pollRes = await fetch(`${WALLET_SCAN_ROUTE}/${encodeURIComponent(startBody.jobId)}`)
      const pollBody = await pollRes.json().catch(() => null) as WalletScanJobResponse | null

      if (!pollRes.ok || !pollBody) {
        return toErrorResponse('scan-status-unavailable', [`HTTP ${pollRes.status}`])
      }

      onUpdate?.({ jobId: pollBody.jobId, status: pollBody.status })

      if (pollBody.status === 'done') {
        return pollBody.result ?? toErrorResponse('scan-result-missing')
      }

      if (pollBody.status === 'failed') {
        const message = typeof pollBody.error === 'string' ? pollBody.error : pollBody.error?.message
        return toErrorResponse(message ?? 'scan-failed')
      }
    }

    return toErrorResponse('scan-still-running', [`Timed out after ${Math.round((POLL_INTERVAL_MS * MAX_POLL_ATTEMPTS) / 1000)}s of polling.`])
  } catch (err) {
    return {
      success: false,
      error: { message: err instanceof Error ? err.message : String(err), category: 'network' },
    }
  }
}

// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// WALLET-SCAN JOB/POLL PATH: scanWalletV2() enqueues exactly one wallet-scan job through
// /api/wallet-scan, stores the returned jobId in the caller via onUpdate, and polls
// /api/wallet-scan/:jobId every 2.5 seconds until the worker writes the final result. The
// client-facing enqueue request never runs runWalletScanV2Worker inline.
//
// QSTASH REMOVAL, DISCLOSED: this path intentionally avoids the deleted QStash-backed
// /api/scan-start, /api/scan-status, /api/scan-v2/worker, and full-scan start/status routes.

export type ScanMode = 'normal' | 'deep'

export type ScanWalletApiResponse = {
  success: boolean
  data?: unknown
  error?: { message: string; category: string; details?: string[] }
  degraded?: boolean
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

    for (;;) {
      await sleep(POLL_INTERVAL_MS)
      const pollRes = await fetch(`${WALLET_SCAN_ROUTE}/${encodeURIComponent(startBody.jobId)}`)
      const pollBody = await pollRes.json().catch(() => null) as WalletScanJobResponse | null

      if (!pollRes.ok || !pollBody) {
        return toErrorResponse('scan-status-unavailable', [`HTTP ${pollRes.status}`])
      }

      onUpdate?.({ jobId: pollBody.jobId, status: pollBody.status })

      if (pollBody.status === 'done') {
        const result = pollBody.result
        if (result?.degraded) {
          const degradedError = typeof result.error === 'string' ? result.error : result.error?.message
          return { success: false, degraded: true, error: { message: degradedError ?? 'scan-final-result-unavailable', category: 'network' } }
        }
        return result ?? toErrorResponse('scan-final-result-unavailable')
      }

      if (pollBody.status === 'failed') {
        const message = typeof pollBody.error === 'string' ? pollBody.error : pollBody.error?.message
        return toErrorResponse(message ?? 'scan-failed')
      }
    }
  } catch (err) {
    return {
      success: false,
      error: { message: err instanceof Error ? err.message : String(err), category: 'network' },
    }
  }
}

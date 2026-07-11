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

const V2_SCAN_ROUTE = '/api/scan-v2/full-scan/legacy'

// THE ONLY SCAN PATH, DISCLOSED (see file header): a single synchronous POST that waits for the
// entire module chain (runWalletScanV2Worker, unchanged) to finish in one request/response round
// trip — no job, no queue, no worker, no QStash, no auth beyond whatever the route itself already
// enforces. Handles both `normal` and `deep` scanMode identically; the route itself dispatches to
// the same runWalletScanV2Worker chain regardless of mode.
//
// ABORT-CONTROLLER: intentionally absent — there is no client-side ceiling on how long this fetch
// can hang; a genuinely stuck connection waits indefinitely rather than failing after some fixed
// timeout. The route's own maxDuration=300 is the real backstop.
//
// Never throws: a network failure or non-2xx response resolves to a structured
// {success:false, error:{...}} instead of propagating an exception.
export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ScanWalletApiResponse> {
  // eslint-disable-next-line no-console
  console.log('[SCAN] calling scanWalletV2 with', walletAddress, chains, scanMode)
  try {
    const res = await fetch(V2_SCAN_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, chains, scanMode }),
    })
    // eslint-disable-next-line no-console
    console.log('[SCAN] response status', res.status)
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      let parsed: ScanWalletApiResponse | null = null
      try {
        parsed = bodyText ? (JSON.parse(bodyText) as ScanWalletApiResponse) : null
      } catch {
        parsed = null
      }
      if (parsed?.error?.message) {
        return { success: false, error: parsed.error }
      }
      // NON-JSON BODY, DISCLOSED: this route (app/api/scan-v2/full-scan/legacy/route.ts) always
      // returns a real JSON error body on a normal failure — a non-JSON body here (HTML, empty,
      // etc.) means something outside that route handler produced this response, most likely the
      // platform itself killing the invocation once it exceeds its own maxDuration (a real, cold
      // heavy scan taking longer than the route's timeout ceiling). Surfacing that distinction
      // instead of an always-identical "network-failed" so a genuinely stuck/slow scan reads
      // differently from an actual network/CORS/offline failure.
      const looksLikeGatewayTimeout = res.status >= 500 && !bodyText.trim().startsWith('{')
      return {
        success: false,
        error: {
          message: looksLikeGatewayTimeout
            ? 'The scan took too long and was stopped by the server. Try again, or try a lighter wallet.'
            : 'network-failed',
          category: 'network',
          details: [`HTTP ${res.status}`, bodyText].filter(Boolean),
        },
      }
    }
    const body = (await res.json()) as ScanWalletApiResponse
    // eslint-disable-next-line no-console
    console.log('[SCAN] wrapper keys:', Object.keys(body))
    // eslint-disable-next-line no-console
    console.log('[SCAN] data keys:', Object.keys(body.data || {}))
    return body
  } catch (err) {
    return {
      success: false,
      error: { message: err instanceof Error ? err.message : String(err), category: 'network' },
    }
  }
}

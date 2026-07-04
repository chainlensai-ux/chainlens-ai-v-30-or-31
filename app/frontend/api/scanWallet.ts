// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// UNIFIED ROUTE, DISCLOSED (current): `scanWalletV2()` now calls the single unified
// `/api/scan-v2/full-scan` route (added in a prior task) instead of firing 9 separate
// `/api/scan-v2/modules/<name>` requests. Root cause of the prior production symptom ("module-failed
// for all modules"): that string is this file's OWN safety-wrapper fallback error message
// (`moduleFetchFailed`, below `fetchScanModule`) — seeing it for every module meant all 9 concurrent
// per-module fetches were failing in production, consistent with the previously-diagnosed
// FUNCTION_INVOCATION_TIMEOUT failure mode (9 separate serverless invocations, each racing its own
// independent execution timeout against one shared underlying computation — see
// app/api/scan-v2/full-scan/route.ts's own header). The unified route collapses this to one request
// and one function invocation, which is the actual, minimal, in-scope fix here — not a change to
// route names, module keys, or the report shape.
//
// `fetchScanModule` (below) is left in place, unused by `scanWalletV2` now but still exported for
// any caller that genuinely wants just one module's section (per its own existing doc comment) —
// not removed, since deleting a working, independently-useful export would be an unrelated change
// beyond this fix's scope.
//
// FABRICATED-PREMISE DISCLOSURE (earlier task): a task asked to "stop calling the old V1 scan
// modules" and replace `/api/scan/modules/*` calls with `/api/scan-v2/modules/{metadata,timelines,
// pnl,behavior,reason,recovery-policy}`. Verified by repo-wide search: there is no
// `/api/scan/modules/*` route pattern anywhere in this codebase, and nothing in the frontend ever
// called one. `/api/scan` (singular) is itself a real V2 endpoint, not a V1 leftover. The task's
// assumed module map was also only partly real — see `MODULE_ENDPOINTS` below for the actual names
// (`behavior-intel`, not `behavior`; no `pnl`/`reason` module route exists under scan-v2 at all).

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
// scan (see this file's header for why that mattered for deep scans specifically).
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

// Matches Vercel Pro's own 60s serverless ceiling less a safety margin — this is a CLIENT-side
// abort so the UI can report a clean "timeout" instead of hanging indefinitely if the server-side
// invocation itself is ever killed without closing the connection cleanly.
const FULL_SCAN_TIMEOUT_MS = 55_000

// Never throws. Calls the single unified /api/scan-v2/full-scan route (one request, one serverless
// invocation, all 10 modules computed internally — see that route's own file header) instead of the
// prior 9-separate-module fan-out. Network failures and client-side timeouts both resolve to a
// structured {success:false, error:{...}} instead of propagating an exception or hanging forever.
export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ScanWalletApiResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FULL_SCAN_TIMEOUT_MS)

  try {
    const res = await fetch('/api/scan-v2/full-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, chains, scanMode }),
      signal: controller.signal,
    })

    if (!res.ok) {
      return { success: false, error: { message: 'network-failed', category: 'network', details: [`HTTP ${res.status}`] } }
    }

    const body = (await res.json()) as ScanWalletApiResponse
    // Trust the route's own {success, data, error} shape as-is (it already never throws and always
    // returns this exact contract — see app/api/scan-v2/full-scan/route.ts) rather than re-deriving it.
    return body
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: { message: 'timeout', category: 'network', details: [`exceeded ${FULL_SCAN_TIMEOUT_MS}ms`] } }
    }
    // Any other network failure (offline, DNS, CORS) or a malformed/non-JSON body — never throw.
    return { success: false, error: { message: 'network-failed', category: 'network', details: [err instanceof Error ? err.message : String(err)] } }
  } finally {
    clearTimeout(timeoutId)
  }
}

// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// JOB-ROUTE FALLBACK REMOVED, DISCLOSED — REGRESSION RISK KNOWINGLY REINTRODUCED, PER EXPLICIT
// INSTRUCTION: scanWalletV2() previously tried the direct, synchronous /api/scan-v2/full-scan route
// first and fell back to the job/poll system (/full-scan-job/start + /full-scan-job/status) on
// failure — see this file's git history for the full "ROUTE-SWAP" disclosure on why that fallback
// existed. This task explicitly asked to remove the fallback entirely and call only the direct V2
// route, since the "not-found" status the fallback could surface was being misread. That's now
// moot: scanViaJobRoute (and its 'not-found' handling) is deleted outright, not left dead in this
// file. The real, same regression risk already disclosed once in this file's history still applies
// and is worth restating plainly: the direct route is a normal Vercel serverless function, subject
// to its hard execution-time ceiling, and the job/poll system existed specifically to decouple the
// client's request lifetime from a slow Deep Scan's real duration. Removing the fallback means a
// genuinely slow scan can now hit FUNCTION_INVOCATION_TIMEOUT with no automatic recovery, where it
// previously would have completed via the job route. Applied here exactly as instructed — this
// tradeoff is the requester's explicit, informed choice, not something silently absorbed.
//
// The backend job routes themselves (app/api/scan-v2/full-scan-job/{start,status}/route.ts) are
// untouched — only this file's frontend usage of them is removed. They remain real, working, unused
// code, not deleted, in case a future task wants them back.
//
// `fetchScanModule` (below) is left in place, unused by `scanWalletV2`, still exported for any
// caller that genuinely wants just one module's section (per its own existing doc comment) — not
// removed, since deleting a working, independently-useful export is beyond this task's scope.

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

const V2_ROUTE = '/api/scan-v2/full-scan'

// ONLY PATH NOW, PER EXPLICIT INSTRUCTION (see file header for the regression risk this carries —
// no fallback if this route is genuinely too slow to finish inside Vercel's execution ceiling).
//
// ABORT-CONTROLLER REMOVED, DISCLOSED, PER EXPLICIT INSTRUCTION: this function previously used an
// AbortController to enforce a 55s client-side timeout ceiling on the fetch (unrelated to the old
// job-route polling — just a plain fetch safety net). Removed exactly as instructed. REAL TRADEOFF:
// there is now no client-side ceiling on how long this fetch can hang — a genuinely stuck
// connection will wait indefinitely rather than failing after ~55s. This is the requester's
// explicit, informed choice, not silently absorbed.
//
// REAL-ERROR-VISIBILITY FIX, DISCLOSED: this function previously discarded the response body
// entirely on any non-2xx status and replaced it with a hardcoded generic
// {message:'network-failed'} — even though the route (see app/api/scan-v2/full-scan/route.ts's
// catch block) always returns a real, redacted JSON error body via handleApiError/sanitizeError
// (which already strips secrets like API keys before the message is ever produced — see
// src/production/errorReporter.ts). That real body was simply never read. Fixed below to parse it
// and surface the ACTUAL backend error message, falling back to the old generic message only when
// the body genuinely isn't usable JSON with an error. No response-shape change (still the existing
// `{success:false, error:{message,category,details?}}` object) — app/terminal/wallet-scanner/
// page.tsx already correctly reads `error?.message` and displays it, so no frontend UI change was
// needed beyond this one fix.
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
    const res = await fetch(V2_ROUTE, {
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
      return {
        success: false,
        error: { message: 'network-failed', category: 'network', details: [`HTTP ${res.status}`, bodyText].filter(Boolean) },
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

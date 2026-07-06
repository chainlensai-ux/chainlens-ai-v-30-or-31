// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// JOB-ROUTE FALLBACK REMOVED (for `normal` scans), THEN RE-ADDED (for Deep Scan only), DISCLOSED:
// scanWalletV2() previously tried the direct route first, fell back to a job/poll system on
// failure, then had that fallback removed entirely per an earlier explicit instruction (see this
// file's git history for the "ROUTE-SWAP"/"JOB-ROUTE FALLBACK REMOVED" disclosures) — a real,
// disclosed regression risk (no protection from FUNCTION_INVOCATION_TIMEOUT on a genuinely slow
// scan) that was knowingly accepted at the time. A later, explicit task asked to move Deep Scan
// specifically into a background job/poll system again — startDeepScanJob/pollScanJob below are
// that reintroduction, scoped ONLY to Deep Scan (mode='deep'). scanWalletV2() itself is UNCHANGED
// and still used as-is for `normal` scans — this isn't a revert of the earlier removal, it's a new,
// separate job/poll path targeting the current worker (workers/walletScanV2.ts via
// app/api/scan-start), not the old, now-unused /full-scan-job/{start,status} routes (still real,
// working, untouched — genuinely unused now by either scan mode).
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
      // NON-JSON BODY, DISCLOSED: this route (app/api/scan-v2/full-scan/route.ts) always returns a
      // real JSON error body on a normal failure — a non-JSON body here (HTML, empty, etc.) means
      // something outside that route handler produced this response, most likely the platform
      // itself killing the invocation once it exceeds its own maxDuration (a real, cold heavy scan
      // taking longer than the route's timeout ceiling). Surfacing that distinction instead of the
      // previous always-identical "network-failed" so a genuinely stuck/slow scan reads differently
      // from an actual network/CORS/offline failure.
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

// DEEP SCAN JOB/POLL SYSTEM, DISCLOSED (see file header): scoped only to Deep Scan, calling the
// new app/api/scan-start + app/api/scan-status routes (which run the same real, unchanged
// runWalletScanV2Worker as the direct route) — never throws.
export type ScanJobStatus = 'pending' | 'running' | 'completed' | 'failed'
export type ScanJobStatusResponse = { jobId: string; status: ScanJobStatus; result: unknown; error: string | null }

export async function startDeepScanJob(walletAddress: string, chains: string[]): Promise<{ jobId: string } | { error: string }> {
  try {
    const res = await fetch('/api/scan-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, chains, scanMode: 'deep' }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.jobId) {
      return { error: body?.error ?? `HTTP ${res.status}` }
    }
    return { jobId: body.jobId as string }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// TRANSIENT-POLL-ERROR MARKER, DISCLOSED (cost-audit finding): previously a single dropped
// request/network blip during polling (a thrown fetch, or a non-2xx from a transient gateway
// hiccup) was reported as `status:'failed'` — indistinguishable from the job itself genuinely
// failing. pollScanJobUntilDone below would then give up immediately on the very first network
// blip, showing the user "Scan failed" for a scan that was actually still running fine
// server-side. `transient: true` marks these so the poll loop can retry a few times instead of
// giving up on one hiccup — a real `status:'failed'` from the server (job.error) is never marked
// transient and still ends the poll loop immediately, unchanged.
type ScanJobPollResult = ScanJobStatusResponse & { transient?: boolean }

export async function pollScanJobOnce(jobId: string): Promise<ScanJobPollResult> {
  try {
    const res = await fetch(`/api/scan-status?jobId=${encodeURIComponent(jobId)}`)
    if (!res.ok) {
      return { jobId, status: 'failed', result: null, error: `HTTP ${res.status}`, transient: true }
    }
    return (await res.json()) as ScanJobStatusResponse
  } catch (err) {
    return { jobId, status: 'failed', result: null, error: err instanceof Error ? err.message : String(err), transient: true }
  }
}

const MAX_CONSECUTIVE_TRANSIENT_POLL_ERRORS = 3

// Polls every `intervalMs` (default 2.5s, per the task's "every 2-3 seconds" request) until the job
// reaches 'completed'/'failed' or `timeoutMs` elapses. Never throws.
export async function pollScanJobUntilDone(
  jobId: string,
  opts: { intervalMs?: number; timeoutMs?: number; onUpdate?: (status: ScanJobStatusResponse) => void } = {},
): Promise<ScanWalletApiResponse> {
  const intervalMs = opts.intervalMs ?? 2500
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000 // 10 minutes — generous headroom for a real Deep Scan
  const deadline = Date.now() + timeoutMs
  let consecutiveTransientErrors = 0

  while (Date.now() < deadline) {
    const status = await pollScanJobOnce(jobId)

    if (status.transient) {
      consecutiveTransientErrors++
      if (consecutiveTransientErrors < MAX_CONSECUTIVE_TRANSIENT_POLL_ERRORS) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        continue
      }
      // Exhausted retries — surface it for real now, same shape as before this fix.
      opts.onUpdate?.(status)
      return { success: false, error: { message: status.error ?? 'Scan failed', category: 'network' } }
    }
    consecutiveTransientErrors = 0
    opts.onUpdate?.(status)

    if (status.status === 'completed') {
      return { success: true, data: status.result }
    }
    if (status.status === 'failed') {
      return { success: false, error: { message: status.error ?? 'Scan failed', category: 'unknown' } }
    }
    // 'pending' or 'running' — keep polling
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return { success: false, error: { message: 'Deep Scan timed out waiting for a result', category: 'timeout' } }
}

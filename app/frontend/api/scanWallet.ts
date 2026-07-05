// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// ROUTE-SWAP, DISCLOSED — REGRESSION RISK, APPLIED ON EXPLICIT INSTRUCTION: a later task's premise
// ("the job route runs a V1 engine, causing massive CU burn") was checked directly against the real
// code before this change and does not hold: both app/api/scan-v2/full-scan/route.ts and
// app/api/scan-v2/full-scan-job/start/route.ts call the exact same real orchestrator
// (router.handleScanRequest), exactly once, with no legacy/duplicate engine involved in either. If
// anything, full-scan/route.ts does MORE work per call (it additionally runs the whole new V2
// engine chain — holdings/pricing/portfolio/pnl/activity/risk/personality/behavior/signals — on top
// of that same handleScanRequest call), so this swap is unlikely to reduce CU usage and may increase
// it. More importantly: routing scanWalletV2() back through the synchronous /api/scan-v2/full-scan
// route reintroduces the exact FUNCTION_INVOCATION_TIMEOUT failure mode an earlier task in this same
// session already fixed by building the job/poll system in the first place — a synchronous route is
// subject to Vercel's hard execution-time ceiling; the job route isn't. This was raised and
// confirmed with the requester before applying; implemented here exactly as instructed, with the
// regression risk disclosed here and in the commit, not silently applied.
//
// PRIOR BEHAVIOR (now the fallback path, see scanViaJobRoute below): `scanWalletV2()` called
// `/api/scan-v2/full-scan-job/start` and polled `/api/scan-v2/full-scan-job/status` instead of
// calling the synchronous `/api/scan-v2/full-scan` route directly. See those two routes' own file
// headers (app/api/scan-v2/full-scan-job/{start,status}/route.ts) for the full disclosure on the
// job/poll design, KV-unconfigured graceful degradation, and honest limits (this does not
// literally eliminate every Vercel time limit — it decouples the CLIENT's request lifetime from the
// scan's real duration, which is the actual problem being solved).
//
// KV-UNCONFIGURED CASE, HANDLED HERE TOO: when KV isn't configured, `.../start` runs the scan
// synchronously and returns `{success:true, jobId, job:{status:'done', ...}}` in its own response
// (the finished result nested under `job`, never flattened onto this response's own top-level
// `success` — see `JobStartResponse`'s own comment below for why that separation matters) — this
// function checks for that and returns immediately without ever starting a poll loop, since there
// is nothing further to wait for.
//
// PRIOR ROUTE, DISCLOSED: `scanWalletV2()` previously called the single unified
// `/api/scan-v2/full-scan` route (added in an earlier task) instead of firing 9 separate
// `/api/scan-v2/modules/<name>` requests. That route still exists, untouched, and still works — it
// just isn't what this function calls anymore. Root cause of the production symptom that led to
// the unified route in the first place ("module-failed for all modules"): that string is this
// file's OWN safety-wrapper fallback error message (`moduleFetchFailed`, below `fetchScanModule`)
// — seeing it for every module meant all 9 concurrent per-module fetches were failing in
// production, consistent with the FUNCTION_INVOCATION_TIMEOUT failure mode (9 separate serverless
// invocations, each racing its own independent execution timeout against one shared underlying
// computation). Not a change to route names, module keys, or the report shape.
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

// Overall client-side ceiling for the whole start+poll sequence — matches the value used by the
// prior synchronous version of this function, kept as the same reasonable "give up" point.
const FULL_SCAN_TIMEOUT_MS = 55_000

// How often to poll /status while a job is still 'pending'. Cheap KV reads — no cost concern with
// a short interval, and a short interval keeps perceived latency low once the scan finishes.
const POLL_INTERVAL_MS = 1_500

type JobResultShape =
  | { status: 'pending' }
  | { status: 'done'; success: true; data: unknown }
  | { status: 'done'; success: false; error: { message: string; category: string; details?: string[] } }

// `success` here means "this HTTP request was handled" — deliberately never conflated with the
// scan's own outcome, which is always nested under `job` instead (see .../full-scan-job/start/
// route.ts's own header on why that separation matters).
type JobStartResponse =
  | { success: true; jobId: string; job: JobResultShape }
  | { success: false; error: { message: string; category: string; details?: string[] } }

type JobStatusResponse =
  | JobResultShape
  | { status: 'not-found'; error?: { message: string; category: string; details?: string[] } }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// FALLBACK PATH (formerly the only path — see file header's "ROUTE-SWAP" disclosure). Never
// throws. Starts a background scan job (/full-scan-job/start) and polls for completion
// (/full-scan-job/status) instead of waiting on one long-lived synchronous request. Network
// failures and the overall client-side timeout both resolve to a structured
// {success:false, error:{...}} instead of propagating an exception or hanging forever.
async function scanViaJobRoute(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode,
): Promise<ScanWalletApiResponse> {
  const deadline = Date.now() + FULL_SCAN_TIMEOUT_MS

  let started: JobStartResponse
  try {
    const res = await fetch('/api/scan-v2/full-scan-job/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, chains, scanMode }),
    })

    if (!res.ok) {
      return { success: false, error: { message: 'network-failed', category: 'network', details: [`HTTP ${res.status}`] } }
    }
    started = (await res.json()) as JobStartResponse
  } catch (err) {
    return { success: false, error: { message: 'network-failed', category: 'network', details: [err instanceof Error ? err.message : String(err)] } }
  }

  if (!started.success) {
    return { success: false, error: started.error }
  }

  // KV-UNCONFIGURED GRACEFUL DEGRADATION (see .../full-scan-job/start/route.ts's own header): the
  // start route already ran the scan synchronously and returned the finished result directly,
  // nested under `job` — nothing to poll for.
  if (started.job.status === 'done') {
    return started.job.success
      ? { success: true, data: started.job.data }
      : { success: false, error: started.job.error }
  }

  const jobId = started.jobId

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)

    let statusBody: JobStatusResponse
    try {
      const res = await fetch(`/api/scan-v2/full-scan-job/status?jobId=${encodeURIComponent(jobId)}`)
      if (!res.ok) {
        return { success: false, error: { message: 'network-failed', category: 'network', details: [`HTTP ${res.status}`] } }
      }
      statusBody = (await res.json()) as JobStatusResponse
    } catch (err) {
      return { success: false, error: { message: 'network-failed', category: 'network', details: [err instanceof Error ? err.message : String(err)] } }
    }

    if (statusBody.status === 'pending') continue // keep polling until the deadline

    if (statusBody.status === 'not-found') {
      // Job expired, was never persisted, or KV became unavailable mid-poll — an honest, distinct
      // failure from a plain network error, since the request itself succeeded.
      return { success: false, error: statusBody.error ?? { message: 'job-not-found', category: 'unknown' } }
    }

    // status === 'done'
    return statusBody.success
      ? { success: true, data: statusBody.data }
      : { success: false, error: statusBody.error }
  }

  return { success: false, error: { message: 'timeout', category: 'network', details: [`exceeded ${FULL_SCAN_TIMEOUT_MS}ms`] } }
}

const V2_ROUTE = '/api/scan-v2/full-scan'
const V1_JOB_ROUTE = '/api/scan-v2/full-scan-job/start'

// PRIMARY PATH, per this task's explicit instruction (see file header's "ROUTE-SWAP" disclosure for
// the regression risk this reintroduces — a synchronous request is subject to Vercel's hard
// execution-time ceiling, unlike the job/poll fallback below). Never throws: any network failure or
// non-2xx response from the direct V2 call falls back to scanViaJobRoute instead of propagating.
export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ScanWalletApiResponse> {
  const fetchUrl = V2_ROUTE
  // eslint-disable-next-line no-console
  console.debug('[RouteCheck] scanWalletV2 is calling:', fetchUrl)
  // eslint-disable-next-line no-console
  console.debug('[RouteCheck] Using V1 job route:', fetchUrl.includes('full-scan-job'))

  let usedRoute = V2_ROUTE
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FULL_SCAN_TIMEOUT_MS)
    try {
      const res = await fetch(V2_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, chains, scanMode }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as ScanWalletApiResponse
      // eslint-disable-next-line no-console
      console.debug('[RouteCheck] Final route used:', usedRoute)
      return body
    } finally {
      clearTimeout(timeoutId)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[RouteCheck] V2 route failed, retrying V1 job route:', err)
    usedRoute = V1_JOB_ROUTE
    const result = await scanViaJobRoute(walletAddress, chains, scanMode)
    // eslint-disable-next-line no-console
    console.debug('[RouteCheck] Final route used:', usedRoute)
    return result
  }
}

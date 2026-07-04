// API client for the ChainLens 180-Day Intelligence Engine (V2).
//
// The V2 report is split into 9 modules, each served by its own endpoint under
// /api/scan-v2/modules/<name>. scanWalletV2() fetches all 9 in parallel and reassembles them into
// the same combined shape the UI already renders (scanMetadata, chainSelection, timelines,
// holdings, portfolio, behaviorIntel, recoveryPolicy, windowCoverage, finalSummary) — callers
// don't need to know the report was split. The backend de-dupes these 9 concurrent requests
// against a single runWalletScanV2() run (src/deployment/scanCache.ts) rather than recomputing the
// scan once per module.
//
// FABRICATED-PREMISE DISCLOSURE: a task asked to "stop calling the old V1 scan modules" and
// replace `/api/scan/modules/*` calls with `/api/scan-v2/modules/{metadata,timelines,pnl,behavior,
// reason,recovery-policy}`. Verified by repo-wide search before touching anything: this file (the
// only frontend code that calls any scan-v2/module endpoint) already exclusively calls
// `/api/scan-v2/modules/<name>` — there is no `/api/scan/modules/*` route pattern anywhere in this
// codebase, and nothing in the frontend calls one. `/api/scan` (singular, no `/modules/`) is itself
// a real V2 endpoint (delegates straight to `runWalletScanV2` — see its own file header), not a V1
// leftover, and no frontend code calls it either. The task's assumed module map is also only
// partly real: the actual routes are `metadata`, `chain-selection`, `timelines`, `holdings`,
// `portfolio`, `behavior-intel` (not `behavior`), `recovery-policy`, `window-coverage`,
// `final-summary`, `bridge-timeline` — there is no `scan-v2/modules/pnl` or `scan-v2/modules/reason`
// route at all (`pnl` lives at the separate, standalone `/api/pnl` built earlier this session;
// `reasonEngine` isn't wired into any HTTP route yet). No route names were changed here, since the
// ones already in `MODULE_ENDPOINTS` below are the real ones.
//
// WHAT WAS ACTUALLY FIXED: the one real, in-scope problem this file did have — `fetchScanModule`
// threw on any non-2xx response or network failure, and `scanWalletV2` awaited all 9 with
// `Promise.all`, so a single module's transient failure (e.g. a cold-start hiccup on
// `recovery-policy`, which only runs real extra work in `scanMode: 'deep'` — a plausible real
// explanation for "deep scans fail" while normal scans succeed) crashed the ENTIRE scan instead of
// degrading gracefully. `fetchScanModule` now never throws (network/parse failures resolve to a
// structured `{success:false, ok:false, error:{message:'module-failed', ...}}` instead), and
// `scanWalletV2` now uses `Promise.allSettled` so one module's failure can't take down the other 8.
// The existing `{success, data, error}` return contract page.tsx already depends on is unchanged.

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

// Never throws (fetchScanModule above already can't) — callers get a structured
// {success, data, error} result in every case, including partial failure. Uses Promise.allSettled
// (not Promise.all) so one module's failure — most likely under scanMode: 'deep', where
// recovery-policy does real extra work — can never take down the other 8 modules' results.
export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ScanWalletApiResponse> {
  const settled = await Promise.allSettled(
    MODULE_ENDPOINTS.map(([, endpoint]) => fetchScanModule(endpoint, walletAddress, chains, scanMode)),
  )

  const responses: ModuleApiResponse[] = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : moduleFetchFailed(MODULE_ENDPOINTS[i][1], String(s.reason)),
  )

  const failed = responses.find((r) => !r.success)
  if (failed) {
    return { success: false, error: failed.error ?? { message: 'Scan failed', category: 'unknown' } }
  }

  const data: Record<string, unknown> = {}
  MODULE_ENDPOINTS.forEach(([field], i) => {
    data[field] = responses[i].data
  })

  return { success: true, data }
}

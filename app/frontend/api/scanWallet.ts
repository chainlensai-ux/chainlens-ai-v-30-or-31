// API client for the ChainLens 90-Day Intelligence Engine (V2).
//
// The V2 report is split into 9 modules, each served by its own endpoint under
// /api/scan-v2/modules/<name>. scanWalletV2() fetches all 9 in parallel and reassembles them into
// the same combined shape the UI already renders (scanMetadata, chainSelection, timelines,
// holdings, portfolio, behaviorIntel, recoveryPolicy, windowCoverage, finalSummary) — callers
// don't need to know the report was split. The backend de-dupes these 9 concurrent requests
// against a single runWalletScanV2() run (src/deployment/scanCache.ts) rather than recomputing the
// scan once per module.

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
  module?: string
  data?: unknown
  error?: { message: string; category: string; details?: string[] }
}

// Fetches a single module. Exported so callers that only need one section (e.g. a component that
// wants just `holdings`) can fetch it directly instead of going through scanWalletV2().
export async function fetchScanModule(
  endpoint: (typeof MODULE_ENDPOINTS)[number][1],
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ModuleApiResponse> {
  const res = await fetch(`/api/scan-v2/modules/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress, chains, scanMode }),
  })

  if (!res.ok) {
    throw new Error(`Scan module '${endpoint}' failed: ${res.status}`)
  }

  return await res.json()
}

// Throws on any non-2xx response or network failure — callers are responsible for their own
// try/catch and user-facing error handling (see app/terminal/wallet-scanner/page.tsx for the
// pattern, since this file has no UI/toast dependency of its own).
export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ScanWalletApiResponse> {
  const responses = await Promise.all(
    MODULE_ENDPOINTS.map(([, endpoint]) => fetchScanModule(endpoint, walletAddress, chains, scanMode)),
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

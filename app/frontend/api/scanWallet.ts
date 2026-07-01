// API client for the ChainLens 90-Day Intelligence Engine (V2).
//
// scanWalletV2() is the only scanner client in the frontend — it calls POST /api/scan-v2, which
// returns the Step 5 unified report (scanMetadata, chainSelection, timelines, recoveryPolicy,
// fifoAndPnl, behaviorIntel, windowCoverage, finalSummary, normalizationErrors) plus holdings +
// portfolio value (src/modules/holdings, pricing, portfolio). Production's POST /api/scan now
// returns the same V2 shape (see src/deployment/router.ts), so either route works; the wallet
// scanner UI (app/terminal/wallet-scanner/page.tsx) uses this client against /api/scan-v2, which
// remains available as a stable, explicitly-named debugging alias.

export type ScanMode = 'normal' | 'deep'

export type ScanWalletApiResponse = {
  success: boolean
  data?: unknown
  error?: { message: string; category: string; details?: string[] }
}

// Throws on any non-2xx response or network failure — callers are responsible for their own
// try/catch and user-facing error handling (see app/terminal/wallet-scanner/page.tsx for the
// pattern, since this file has no UI/toast dependency of its own).
export async function scanWalletV2(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ScanWalletApiResponse> {
  const res = await fetch('/api/scan-v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress,
      chains,
      scanMode,
    }),
  })

  if (!res.ok) {
    throw new Error(`Scan failed: ${res.status}`)
  }

  return await res.json()
}

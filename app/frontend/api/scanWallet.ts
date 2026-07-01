// V2 SCANNER PREVIEW — API client for the new ChainLens 90-Day Intelligence Engine.
//
// This is intentionally a thin, separate client — it does NOT touch or replace any of the
// existing wallet-scanner API calls (app/api/wallet/route.ts / app/terminal/wallet-scanner still
// call their own endpoint, unchanged). This calls the new POST /api/scan route only, which
// returns the Step 5 unified report shape from runWalletScan().

export type ScanMode = 'normal' | 'deep'

export type ScanWalletApiResponse = {
  success: boolean
  data?: unknown
  error?: { message: string; category: string; details?: string[] }
}

// Throws on any non-2xx response or network failure — callers are responsible for their own
// try/catch and user-facing error handling (see app/wallet-v2-preview/[address]/page.tsx for the
// pattern, since this file has no UI/toast dependency of its own).
export async function scanWallet(
  walletAddress: string,
  chains: string[],
  scanMode: ScanMode = 'normal',
): Promise<ScanWalletApiResponse> {
  const res = await fetch('/api/scan', {
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

// Calls the V2 engine route (app/api/scan-v2/route.ts), which returns everything scanWallet()
// does PLUS holdings + portfolio (from the promoted src/modules/holdings / pricing / portfolio
// modules). Production's /api/scan and scanWallet() above are completely unaffected by this —
// this is additive, not a replacement, until the production migration steps are separately run.
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

// V1 ENGINE REPLACED WITH A LIGHTWEIGHT V2-COMPATIBLE FALLBACK: this previously called
// fetchWalletSnapshot() (lib/server/walletSnapshot.ts, which fires Alchemy RPC calls). It now
// delegates to getWalletLite() (lib/server/walletLite.ts) instead — an honest, zero-RPC empty
// placeholder, never a fabricated identity/balance. See that file's own header for the full
// rationale.
import { getWalletLite } from '@/lib/server/walletLite'

export type WalletScannerRunnerInput = {
  address: string
  refresh?: boolean
  deepScan?: boolean
  deepActivity?: boolean
  chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
}

// Kept for any other caller of the old runWalletScanner() contract — delegates to
// getWalletLite() so there is exactly one place (lib/server/walletLite.ts) that defines what
// "lite" wallet data actually is.
export async function runWalletScanner(input: WalletScannerRunnerInput) {
  const address = String(input.address ?? '').trim().toLowerCase()
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, status: 400, error: 'Invalid wallet address.' as const }
  }
  const lite = await getWalletLite(address)
  return { ...lite, status: 200 as const }
}

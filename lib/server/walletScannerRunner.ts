// V2 ENGINE INTEGRATED (route-level only): this previously called fetchWalletSnapshot()
// (lib/server/walletSnapshot.ts, V1, Alchemy RPC), then was replaced with the zero-RPC
// getWalletLite() fallback. It now tries the real V2 engine first (getWalletFromV2, KV-cached 45s,
// see lib/server/v2Adapters.ts for the full CU-tradeoff disclosure), falling back to
// getWalletLite() only when V2 is unavailable — never throws, always returns ok: true/false.
import { getWalletLite } from '@/lib/server/walletLite'
import { getWalletFromV2 } from '@/lib/server/v2Adapters'

export type WalletScannerRunnerInput = {
  address: string
  refresh?: boolean
  deepScan?: boolean
  deepActivity?: boolean
  chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
}

// Kept for any other caller of the old runWalletScanner() contract.
export async function runWalletScanner(input: WalletScannerRunnerInput) {
  const address = String(input.address ?? '').trim().toLowerCase()
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, status: 400, error: 'Invalid wallet address.' as const }
  }
  const v2 = await getWalletFromV2(address)
  const result = v2 ?? await getWalletLite(address)
  return { ...result, status: 200 as const }
}

// V1 ENGINE REPLACED WITH A LIGHTWEIGHT V2-COMPATIBLE FALLBACK: this previously called
// fetchWalletSnapshot() (lib/server/walletSnapshot.ts, which fires Alchemy RPC calls), then was
// stubbed to always return { ok: false }. getWalletLite() below restores an { ok: true } response
// WITHOUT calling walletSnapshot.ts or any Alchemy RPC — it is an honest empty placeholder (empty
// arrays/object, not fabricated identity/balances), not a real data source. Real GoldRush/Zerion/
// ENS wiring described in the parent task's own "Goal" section is NOT implemented here (the literal
// shape specified for this function has zero provider calls) — flagged explicitly so this isn't
// mistaken for "Clark's wallet lookup actually has data now."

export type WalletScannerRunnerInput = {
  address: string
  refresh?: boolean
  deepScan?: boolean
  deepActivity?: boolean
  chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
}

export async function getWalletLite(address: string): Promise<{
  ok: true
  address: string
  identity: Record<string, unknown>
  balances: unknown[]
  positions: unknown[]
}> {
  return {
    ok: true,
    address,
    identity: {},
    balances: [],
    positions: [],
  }
}

// Kept for any other caller of the old runWalletScanner() contract — delegates to getWalletLite()
// so there is exactly one place (above) that defines what "lite" wallet data actually is.
export async function runWalletScanner(input: WalletScannerRunnerInput) {
  const address = String(input.address ?? '').trim().toLowerCase()
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, status: 400, error: 'Invalid wallet address.' as const }
  }
  const lite = await getWalletLite(address)
  return { ...lite, status: 200 as const }
}

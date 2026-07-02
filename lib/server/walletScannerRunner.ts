// V1 ENGINE DISABLED: this previously called fetchWalletSnapshot() (lib/server/walletSnapshot.ts)
// directly. Per an explicit, confirmed request to cut V1 CU usage ahead of a V2 integration that
// hasn't landed yet, that call — and the import itself, so no V1 code path can execute from this
// file — has been removed. This is Clark AI's only path into the V1 engine (app/api/clark/route.ts
// calls runWalletScanner(), never fetchWalletSnapshot() directly), so stubbing it here disables V1
// for Clark too. walletSnapshot.ts itself is untouched (not deleted).

export type WalletScannerRunnerInput = {
  address: string
  refresh?: boolean
  deepScan?: boolean
  deepActivity?: boolean
  chainMode?: 'auto' | 'base' | 'eth' | 'base_eth' | 'all_supported'
}

export async function runWalletScanner(input: WalletScannerRunnerInput) {
  const address = String(input.address ?? '').trim().toLowerCase()
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, status: 400, error: 'Invalid wallet address.' as const }
  }
  return { ok: false, status: 200, error: 'V1 engine disabled' as const }
}

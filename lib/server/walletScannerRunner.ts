import { fetchWalletSnapshot, type WalletSnapshotOptions } from '@/lib/server/walletSnapshot'

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
  const options: WalletSnapshotOptions = { refresh: input.refresh === true }
  const snapshot: any = await fetchWalletSnapshot(address, options)
  return {
    ok: true,
    status: 200,
    address: snapshot.address,
    holdings: snapshot.holdings ?? [],
    totalValue: snapshot.totalValue ?? null,
    txCount: snapshot.txCount ?? null,
    behaviorChain: snapshot.behaviorChain ?? null,
    walletBehavior: snapshot.walletBehavior ?? null,
    estimatedPnl: snapshot.estimatedPnl ?? null,
    dataFreshness: snapshot.dataFreshness ?? 'live',
    cacheAgeSeconds: snapshot.cacheAgeSeconds ?? null,
    historicalRecoveryStatus: snapshot.historicalRecoveryStatus ?? snapshot.historicalCoverage?.status ?? null,
    pnlCoverage: snapshot.pnlCoverage ?? snapshot.estimatedPnl?.coverage ?? null,
    openLots: snapshot.openLots ?? snapshot.walletOpenPositionSummary?.openLots ?? null,
    closedLots: snapshot.closedLots ?? snapshot.estimatedPnl?.closedLots ?? null,
    walletProfile: snapshot.walletProfile ?? null,
  }
}

// Which tracked wallets the next sync batch scans.
// With tracked_wallets.last_scanned_at available, a batch takes the STALEST wallets first (never
// scanned, then oldest scan), so repeated "Sync wallets" clicks rotate through the whole set instead
// of rescanning the first rows, and a wallet that failed (its timestamp is not advanced) is retried
// first next time. Without the column, the previous offset slicing is used unchanged.

export type ScanOrderedWallet = { last_scanned_at?: string | null }

function scannedAtMs(wallet: ScanOrderedWallet): number {
  const t = wallet.last_scanned_at ? Date.parse(wallet.last_scanned_at) : Number.NaN
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY // never scanned = stalest
}

export function selectWalletBatch<T extends ScanOrderedWallet>(
  wallets: readonly T[],
  options: { offset: number; limit: number; stalestFirst: boolean },
): T[] {
  const limit = Math.max(0, options.limit)
  if (!options.stalestFirst) return wallets.slice(options.offset, options.offset + limit)
  // offset counts wallets already covered this round; the last batch only takes what is left, so
  // a 152-wallet round ends with 2 wallets instead of rescanning 8 just-scanned ones.
  const remaining = Math.max(0, wallets.length - Math.max(0, options.offset))
  return wallets
    .map((wallet, index) => ({ wallet, index, at: scannedAtMs(wallet) }))
    .sort((a, b) => (a.at - b.at) || (a.index - b.index))
    .slice(0, Math.min(limit, remaining))
    .map(entry => entry.wallet)
}

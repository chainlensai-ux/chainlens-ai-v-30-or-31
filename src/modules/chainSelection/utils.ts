// MODULE 3 — chainSelection: pure helper functions.

import type { NormalizedEvent } from '../normalization/types'
import type { SupportedChain } from '../providerFetchWindow/types'

// Counts distinct wallet-side transactions (unique txHash where direction is inbound or outbound)
// for a single chain — a transaction count, not a per-leg event count, matching Architecture
// Step 1 §2's "wallet_side_transactions" semantics.
export function countWalletSideTransactions(normalizedEvents: NormalizedEvent[], chain: SupportedChain): number {
  const txHashes = new Set<string>()
  for (const event of normalizedEvents) {
    if (event.chain !== chain) continue
    if (event.direction === 'unknown') continue
    txHashes.add(event.txHash)
  }
  return txHashes.size
}

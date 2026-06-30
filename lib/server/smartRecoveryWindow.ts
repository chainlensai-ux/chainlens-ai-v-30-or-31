// SMART-RECOVERY-WINDOW: isolated, additive module. Does NOT modify existing scan modes,
// FIFO matching, swap detection, or price evidence. Admin-only caller (gated in route.ts)
// pages cheaply through token transfer history to find the wallet's active trading window
// before any targeted/full recovery work is attempted.
import { fetchMoralisTransfers, moralisChainFromAny, type MoralisChain } from './moralis'

export type SmartRecoveryWindow = {
  startTimestamp: string | null
  endTimestamp: string | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  pagesUsed: number
  transfersSeen: number
  reason: string | null
}

export async function detectTradingWindow(
  address: string,
  chain: string,
  maxPages: number,
): Promise<SmartRecoveryWindow> {
  const moralisChain: MoralisChain | null = moralisChainFromAny(chain)
  if (!moralisChain) {
    return { startTimestamp: null, endTimestamp: null, confidence: 'none', pagesUsed: 0, transfersSeen: 0, reason: 'unsupported_chain' }
  }

  const pageCap = Math.max(1, Math.min(maxPages, 2))
  let cursor: string | undefined
  let earliest: number | null = null
  let latest: number | null = null
  let transfersSeen = 0
  let pagesUsed = 0

  for (let page = 0; page < pageCap; page++) {
    const result = await fetchMoralisTransfers(address, moralisChain, 100, cursor)
    pagesUsed += 1
    if (!result.usable || result.items.length === 0) break
    transfersSeen += result.items.length
    for (const item of result.items) {
      const ts = item.block_timestamp ? Date.parse(item.block_timestamp) : NaN
      if (!Number.isFinite(ts)) continue
      if (earliest === null || ts < earliest) earliest = ts
      if (latest === null || ts > latest) latest = ts
    }
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }

  if (earliest === null || latest === null) {
    return { startTimestamp: null, endTimestamp: null, confidence: 'none', pagesUsed, transfersSeen, reason: 'no_transfer_activity_found' }
  }

  const confidence: SmartRecoveryWindow['confidence'] =
    transfersSeen >= 50 ? 'high' : transfersSeen >= 10 ? 'medium' : 'low'

  return {
    startTimestamp: new Date(earliest).toISOString(),
    endTimestamp: new Date(latest).toISOString(),
    confidence,
    pagesUsed,
    transfersSeen,
    reason: null,
  }
}

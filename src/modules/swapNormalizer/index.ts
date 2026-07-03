// MODULE — swapNormalizer (public entry point)
//
// STANDALONE, ADDITIVE, NOT WIRED INTO THE PIPELINE — see types.ts header for the full disclosure
// on why this lives in its own directory (not inside src/modules/normalization/, which is a
// different, already-shipped, numbered architecture module) and on the input-shape contract this
// module was designed against. No pricing logic, no FIFO logic, no PnL logic — normalization and
// classification only, per this task's own scope rules.

import type { NormalizedTrade, RawTxBundle } from './types'
import { swapNormalizer } from './swapNormalizer'

export type {
  NormalizedTrade,
  RawTxBundle,
  RawTransfer,
  RawDexSwap,
  RawLog,
  PoolMetadata,
  TokenRef,
  TradeType,
  SwapNormalizerChain,
} from './types'
export { UNKNOWN_TOKEN, ZERO_ADDRESS } from './types'

export { swapNormalizer } from './swapNormalizer'
export { classifyTransfer, classifyTransfers, type TransferClass } from './transferClassifier'
export { detectBuySell, isQuoteAsset, type BuySellResult } from './buySellDetector'
export { detectLpAddRemove, type LpDetection } from './lpAddRemoveDetector'
export { resolveRouterPath, type SwapLeg, type ResolvedPath } from './routerPathResolver'
export { detectRouterType, isKnownRouter, routerName, type RouterType } from './routers'
export { toDecimalAmount, wrappedNativeAddress, isWrappedNative, isZeroAddress, tokenRefFromTransfer, byLogIndex } from './tokenUtils'

// Deterministic dedupe key — a chain+txHash pair should never produce more than one trade, since
// swapNormalizer() already treats one tx bundle as one atomic trade (see swapNormalizer.ts header).
// Guards against a caller accidentally passing the same tx bundle twice (e.g. two providers
// reporting the same tx), which would otherwise silently double-count a trade.
function txKey(tx: RawTxBundle): string {
  return `${tx.chain}:${tx.txHash.toLowerCase()}`
}

// Public entry point. Normalizes a list of raw per-transaction event bundles into a deterministic,
// deduplicated, chronologically-sorted list of trades for the given wallet. Never throws: a
// malformed or wallet-irrelevant tx bundle is simply skipped (swapNormalizer() returns null for it),
// never fabricated into a placeholder trade.
export function normalizeTrades(events: RawTxBundle[], walletAddress: string): NormalizedTrade[] {
  const seen = new Set<string>()
  const trades: NormalizedTrade[] = []

  for (const tx of events) {
    const key = txKey(tx)
    if (seen.has(key)) continue
    seen.add(key)

    const trade = swapNormalizer(tx, walletAddress)
    if (trade) trades.push(trade)
  }

  // Stable, deterministic ordering: ascending timestamp, then txHash as a tiebreaker so two trades
  // sharing a timestamp always sort the same way regardless of input order.
  trades.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return a.txHash.localeCompare(b.txHash)
  })

  return trades
}

// MODULE — swapNormalizer: swapNormalizer()
//
// Normalizes ONE transaction bundle into at most one NormalizedTrade. This module treats a
// transaction as the atomic grouping unit (matching the input contract, which groups dexSwaps/
// transfers/logs by tx) — a single tx containing two genuinely independent, unrelated swaps (e.g.
// a batched multicall touching two unrelated pools) would need per-pool grouping to split into two
// trades, which is out of scope here and disclosed rather than silently mishandled: this module
// always combines everything relevant to the wallet within one tx into a single first-in/last-out
// trade, by design.
//
// Priority within a tx: LP_ADD/LP_REMOVE detection runs first (an LP operation is never also
// reported as a SWAP/BUY/SELL for the same tx); then provider-supplied dexSwaps (authoritative, if
// present); then reconstruction from transfers (the fallback, and the only path exercised when a
// provider — as this codebase's real fetchers do today — supplies only flat transfers).

import type { NormalizedTrade, RawTxBundle, TokenRef } from './types'
import { UNKNOWN_TOKEN } from './types'
import { classifyTransfers } from './transferClassifier'
import { detectLpAddRemove } from './lpAddRemoveDetector'
import { resolveRouterPath, type SwapLeg } from './routerPathResolver'
import { detectBuySell } from './buySellDetector'
import { detectRouterType } from './routers'
import { byLogIndex, toDecimalAmount } from './tokenUtils'

type ReconstructedPath = {
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountIn: number
  amountOut: number
  hops: number
  missingSide: 'none' | 'tokenIn' | 'tokenOut'
} | null

// Reconstructs a swap path purely from classified transfers, when no provider-supplied dexSwaps
// exist for this tx. Picks the EARLIEST wallet-outgoing leg as tokenIn (what the wallet first parts
// with) and the LATEST wallet-incoming leg as tokenOut (the final hop) — this is what lets a
// multi-hop swap fragmented across several transfer records collapse into one trade.
function reconstructFromTransfers(tx: RawTxBundle, walletAddress: string): ReconstructedPath {
  const transfers = tx.transfers ?? []
  if (transfers.length === 0) return null

  const classified = classifyTransfers(transfers, walletAddress, tx.router).sort((a, b) =>
    byLogIndex(a.transfer, b.transfer),
  )

  const outgoing = classified.filter((c) => c.class === 'ROUTER_IN' || c.class === 'TRANSFER_OUT')
  const incoming = classified.filter((c) => c.class === 'ROUTER_OUT' || c.class === 'TRANSFER_IN')

  if (outgoing.length === 0 && incoming.length === 0) return null

  const firstOut = outgoing[0] ?? null
  const lastIn = incoming.length > 0 ? incoming[incoming.length - 1] : null

  const internalBetween = firstOut && lastIn
    ? classified.filter(
        (c) =>
          c.class === 'INTERNAL' &&
          c.transfer.logIndex > firstOut.transfer.logIndex &&
          c.transfer.logIndex < lastIn.transfer.logIndex,
      ).length
    : 0

  if (firstOut && lastIn) {
    return {
      tokenIn: { address: firstOut.transfer.contract.toLowerCase(), symbol: firstOut.transfer.symbol ?? '?', decimals: firstOut.transfer.decimals ?? 18 },
      tokenOut: { address: lastIn.transfer.contract.toLowerCase(), symbol: lastIn.transfer.symbol ?? '?', decimals: lastIn.transfer.decimals ?? 18 },
      amountIn: toDecimalAmount(firstOut.transfer.amountRaw, firstOut.transfer.decimals),
      amountOut: toDecimalAmount(lastIn.transfer.amountRaw, lastIn.transfer.decimals),
      hops: internalBetween + 1,
      missingSide: 'none',
    }
  }

  if (firstOut && !lastIn) {
    return {
      tokenIn: { address: firstOut.transfer.contract.toLowerCase(), symbol: firstOut.transfer.symbol ?? '?', decimals: firstOut.transfer.decimals ?? 18 },
      tokenOut: UNKNOWN_TOKEN,
      amountIn: toDecimalAmount(firstOut.transfer.amountRaw, firstOut.transfer.decimals),
      amountOut: 0,
      hops: 1,
      missingSide: 'tokenOut',
    }
  }

  // !firstOut && lastIn
  return {
    tokenIn: UNKNOWN_TOKEN,
    tokenOut: { address: lastIn!.transfer.contract.toLowerCase(), symbol: lastIn!.transfer.symbol ?? '?', decimals: lastIn!.transfer.decimals ?? 18 },
    amountIn: 0,
    amountOut: toDecimalAmount(lastIn!.transfer.amountRaw, lastIn!.transfer.decimals),
    hops: 1,
    missingSide: 'tokenIn',
  }
}

function fromDexSwaps(tx: RawTxBundle): ReconstructedPath & { router: string | null } {
  const legs: SwapLeg[] = [...tx.dexSwaps!]
    .sort((a, b) => a.logIndex - b.logIndex)
    .map((leg) => ({
      logIndex: leg.logIndex,
      tokenIn: leg.tokenIn,
      amountIn: toDecimalAmount(leg.amountIn, leg.tokenIn.decimals),
      tokenOut: leg.tokenOut,
      amountOut: toDecimalAmount(leg.amountOut, leg.tokenOut.decimals),
      router: leg.router ?? null,
    }))

  const resolved = resolveRouterPath(legs, tx.router ?? null)
  return {
    tokenIn: resolved.tokenIn,
    tokenOut: resolved.tokenOut,
    amountIn: resolved.amountIn,
    amountOut: resolved.amountOut,
    hops: resolved.hops,
    missingSide: 'none',
    router: resolved.router,
  }
}

// Normalizes a single transaction bundle. Returns null when there is nothing relevant to the
// scanned wallet in this tx (e.g. every transfer is INTERNAL to other addresses) — never a
// fabricated/empty trade row.
export function swapNormalizer(tx: RawTxBundle, walletAddress: string): NormalizedTrade | null {
  const lp = detectLpAddRemove(tx.transfers ?? [], tx.poolMetadata ?? [], walletAddress)
  if (lp) {
    return {
      type: lp.type,
      chain: tx.chain,
      timestamp: tx.timestamp,
      txHash: tx.txHash,
      wallet: walletAddress.toLowerCase(),
      tokenIn: lp.tokenIn,
      tokenOut: lp.tokenOut,
      amountIn: lp.amountIn,
      amountOut: lp.amountOut,
      router: tx.router ? tx.router.toLowerCase() : null,
      isBuy: false,
      isSell: false,
      meta: {
        hops: 1,
        routerType: detectRouterType(tx.chain, tx.router),
        reconstructedFromTransfers: true,
        missingSide: 'none',
      },
    }
  }

  let path: (ReconstructedPath & { router?: string | null }) | null = null
  let router: string | null = tx.router ?? null

  if (tx.dexSwaps && tx.dexSwaps.length > 0) {
    const result = fromDexSwaps(tx)
    path = result
    router = result.router
  } else {
    path = reconstructFromTransfers(tx, walletAddress)
  }

  if (!path) return null

  const { type, isBuy, isSell } = detectBuySell(tx.chain, path.tokenIn, path.tokenOut, path.missingSide)

  return {
    type,
    chain: tx.chain,
    timestamp: tx.timestamp,
    txHash: tx.txHash,
    wallet: walletAddress.toLowerCase(),
    tokenIn: path.tokenIn,
    tokenOut: path.tokenOut,
    amountIn: path.amountIn,
    amountOut: path.amountOut,
    router: router ? router.toLowerCase() : null,
    isBuy,
    isSell,
    meta: {
      hops: path.hops,
      routerType: detectRouterType(tx.chain, router),
      reconstructedFromTransfers: !(tx.dexSwaps && tx.dexSwaps.length > 0),
      missingSide: path.missingSide,
    },
  }
}

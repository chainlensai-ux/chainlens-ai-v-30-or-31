// MODULE — swapNormalizer: routerPathResolver()
//
// Collapses an ordered list of swap legs (either provider-supplied dexSwaps, or legs reconstructed
// from transfers) belonging to the SAME transaction into a single normalized swap: tokenIn/amountIn
// from the first leg (what the wallet actually parted with), tokenOut/amountOut from the LAST leg
// (what the wallet actually ended up with) — the "final hop" requirement. Pure, deterministic:
// legs must already be sorted (by logIndex) before being passed in here; this function never
// re-sorts using Map/Set iteration order.

import type { TokenRef } from './types'

export type SwapLeg = {
  logIndex: number
  tokenIn: TokenRef
  amountIn: number
  tokenOut: TokenRef
  amountOut: number
  router: string | null
}

export type ResolvedPath = {
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountIn: number
  amountOut: number
  router: string | null
  hops: number
}

// Never called with an empty array by this module's own internal callers — guarded anyway so a
// misuse from a future caller fails safe (empty tokenIn/tokenOut) rather than throwing.
export function resolveRouterPath(legs: SwapLeg[], txLevelRouter: string | null): ResolvedPath {
  if (legs.length === 0) {
    return {
      tokenIn: { address: '', symbol: 'UNKNOWN', decimals: 18 },
      tokenOut: { address: '', symbol: 'UNKNOWN', decimals: 18 },
      amountIn: 0,
      amountOut: 0,
      router: txLevelRouter,
      hops: 0,
    }
  }

  const first = legs[0]
  const last = legs[legs.length - 1]

  return {
    tokenIn: first.tokenIn,
    tokenOut: last.tokenOut,
    amountIn: first.amountIn,
    amountOut: last.amountOut,
    router: txLevelRouter ?? first.router ?? last.router ?? null,
    hops: legs.length,
  }
}

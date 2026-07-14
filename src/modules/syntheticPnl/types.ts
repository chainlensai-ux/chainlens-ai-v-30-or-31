// MODULE — syntheticPnl: type definitions.
//
// UI-DISPLAY-ONLY, DISCLOSED: every type here is for the inferred/unverified read model this
// task requested — never fed into fifoEngine, priceLotsForWallet, or PRICE_SOURCES, never used to
// compute pnlV2. See index.ts's own header for the full reasoning.

export type SyntheticTradeConfidence = 'high' | 'medium' | 'low'

export type SyntheticTrade = {
  chain: string
  txHash: string
  timestamp: string
  tokenIn: string
  tokenOut: string
  amountIn: number
  amountOut: number
  confidence: SyntheticTradeConfidence
  // ENTRY-TIME PRICING, DISCLOSED: resolved once, at inference time, from the poolData snapshot
  // inferSyntheticTrades was given — a real, already-resolved USD price, never fabricated. Baked
  // onto the trade itself (rather than re-looked-up later) so computeSyntheticPnl's realized-PnL
  // math uses the SAME entry price this trade was actually inferred against, while a SEPARATE,
  // later `currentPrices` snapshot (computeSyntheticPnl's second argument) can genuinely differ —
  // the only way "cost basis at trade time" vs "current value" can honestly diverge without a full
  // historical price-series feed (out of scope here; see index.ts's own disclosure).
  tokenInPriceUsd: number
  tokenOutPriceUsd: number
}

// Caller-injected, real pool pricing data — this module never fetches anything itself. Keyed by
// `${chain}:${token.toLowerCase()}`. `midPriceUsd` is a real, already-resolved USD price (see this
// module's own pipeline-wiring disclosure for where the real number comes from); `liquidityUsd`
// drives the dead/dust/real pool classification (reused from routerTradeReconstruction).
export type PoolPriceData = {
  midPriceUsd: number
  liquidityUsd: number | null
}

export type PoolDataMap = Record<string, PoolPriceData>

export type SyntheticPnlSummary = {
  syntheticRealizedPnlUsd: number
  syntheticUnrealizedPnlUsd: number
  syntheticTotalPnlUsd: number
  syntheticRoiPct: number | null
  tradeCount: number
  highConfidenceCount: number
  mediumConfidenceCount: number
  lowConfidenceCount: number
}

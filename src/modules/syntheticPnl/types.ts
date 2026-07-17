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
  pricedViaDexScreener?: boolean
}

// Caller-injected, real pool pricing data — this module never fetches anything itself. Keyed by
// `${chain}:${token.toLowerCase()}`. `midPriceUsd` is a real, already-resolved USD price (see this
// module's own pipeline-wiring disclosure for where the real number comes from); `liquidityUsd`
// drives the dead/dust/real pool classification (reused from routerTradeReconstruction).
export type PoolPriceData = {
  midPriceUsd: number
  liquidityUsd: number | null
  pricedViaDexScreener?: boolean
}

export type PoolDataMap = Record<string, PoolPriceData>

// RENAMED, DISCLOSED (this task's own field names, replacing syntheticRealizedPnlUsd/
// syntheticUnrealizedPnlUsd/syntheticTotalPnlUsd/syntheticRoiPct from the prior version — every
// consumer, SyntheticPnlBlock.tsx included, updated in the same commit). Fields are now nullable:
// null means "no evidence to compute this," never a fabricated 0.
export type SyntheticChainPnl = {
  chainId: string
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  totalPnlUsd: number | null
  roiPercent: number | null
  costBasisUsd: number | null
}

export type SyntheticPnlSummary = {
  totalRealizedPnlUsd: number | null
  totalUnrealizedPnlUsd: number | null
  totalPnlUsd: number | null
  roiPercent: number | null
  costBasisUsd: number | null
  // PER-CHAIN, ADDITIVE (this task's own request): independently computed from the same trade set
  // as the totals above — never gated on the totals being non-null, and vice versa. See index.ts's
  // own header for the real, disclosed limitation on when this can actually diverge from the totals
  // given how routerDistributorMode is currently computed (globally, not per chain).
  perChain: SyntheticChainPnl[]
  tradeCount: number
  highConfidenceCount: number
  mediumConfidenceCount: number
  lowConfidenceCount: number
  pricedViaDexScreenerCount: number
}

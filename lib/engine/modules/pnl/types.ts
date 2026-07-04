// lib/engine/modules/pnl/types.ts — shared types for the new PnL module.
//
// FILE-LOCATION DISCLOSURE (same as holdings/pricing/portfolio before it): no single shared
// "engine types" file exists anywhere in this codebase — co-located with this module instead.
//
// PnlV2/PnlEngineOutput SHAPES, EXACTLY AS SPECIFIED (no changes).
//
// ParsedTrade, DISCLOSED: the task assumed a pre-existing `ParsedTrade` type from an "existing tx
// indexer + swap parser" — no type or module by that name exists anywhere in this codebase
// (verified by search). The real, closest existing capability is
// lib/engines/tradeTimelineEngineV2.ts's `TradeEntry` (already real, already computes buy/sell
// classification with pricing-backed costBasisUsd/proceedsUsd via the real swapNormalizer/
// tradeIntent/lotOpener/lotCloser chain — see that file's own header). `ParsedTrade` below is a
// minimal, self-contained shape this new module's own FIFO algorithm (computePnl.ts) actually
// needs; `fetchParsedTrades` (computePnl.ts) maps the real `TradeEntry[]` into it rather than
// inventing a second trade-parsing pipeline.

export type TokenCostBasis = {
  tokenAddress: string
  chainId: number
  totalQuantity: number // remaining quantity
  totalCostUsd: number // cost basis for remaining quantity
  averageCostUsd: number // totalCostUsd / totalQuantity
}

export type TokenRealizedPnl = {
  tokenAddress: string
  chainId: number
  realizedPnlUsd: number
}

export type TokenUnrealizedPnl = {
  tokenAddress: string
  chainId: number
  unrealizedPnlUsd: number
}

export type ChainPnlBreakdown = {
  chainId: number
  realizedPnlUsd: number
  unrealizedPnlUsd: number
}

export type PnlV2 = {
  realizedPnlUsd: number
  unrealizedPnlUsd: number
  costBasis: TokenCostBasis[]
  realized: TokenRealizedPnl[]
  unrealized: TokenUnrealizedPnl[]
  chainBreakdown: ChainPnlBreakdown[]
}

export type PnlEngineOutput = {
  pnlV2: PnlV2
  pnlStatus: 'ok' | 'partial' | 'unavailable'
}

// Minimal trade shape this module's own FIFO algorithm needs — see file header disclosure.
export type ParsedTrade = {
  tokenAddress: string
  chainId: number
  type: 'buy' | 'sell'
  quantity: number
  valueUsd: number | null // costUsd for a buy, proceedsUsd for a sell; null if unpriced
  timestamp: number
}

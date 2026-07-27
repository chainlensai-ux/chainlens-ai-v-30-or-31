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

// CANONICAL-BALANCE RECONCILIATION, DISCLOSED, ADDITIVE (found live, this task — confirmed
// production evidence: the wallet-scanner UI's "PnL (Verified V2)" panel, backed by THIS module,
// showed a fabricated -$545,833.02 unrealized PnL on chain 8453 even after src/modules/fifoEngine's
// own canonical-balance reconciliation was already fixed. ROOT CAUSE: this is a SEPARATE, parallel
// PnL engine — the fix applied to src/modules/fifoEngine never touched this file. Step C below
// (unrealized PnL) computed `holding.valueUsd - match.totalCostUsd` by matching purely on
// (chainId, tokenAddress), NEVER checking whether `match.totalQuantity` (this module's own FIFO
// remaining quantity, derived purely from trade-event replay) was anywhere close to
// `holding.quantity` (the real, independently-fetched current canonical balance). A missed sell, a
// duplicated/mis-normalized trade, or a decimal-scaling bug inflating the FIFO-replayed quantity
// produces exactly this failure mode: a real, small current holding value minus a hugely inflated
// FIFO cost basis.
export type UnrealizedExclusionReason =
  // No priced holding evidence exists for this (chainId, tokenAddress) at all.
  | 'missing_canonical_balance'
  // This module's FIFO-replayed remaining quantity exceeds the real current holding quantity.
  | 'quantity_exceeds_balance'
  // The holding's own quantity string did not parse to a finite, non-negative number.
  | 'invalid_canonical_quantity'

export type ExcludedUnrealizedPosition = {
  chainId: number
  tokenAddress: string
  fifoRemainingQuantity: number
  canonicalQuantity: number | null
  fifoCostBasisUsd: number
  canonicalValueUsd: number | null
  // The unrealizedPnlUsd this position WOULD have reported had it not been excluded — the refused,
  // fabricated-looking figure itself, reported so the inflation is visible and auditable. NEVER
  // summed into the official unrealizedPnlUsd total.
  candidateUnrealizedPnlUsd: number
  exclusionReason: UnrealizedExclusionReason
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
  // Diagnostics-only, additive — see ExcludedUnrealizedPosition's own header above. Never
  // subtracted from / added to unrealizedPnlUsd or chainBreakdown; purely a report of what was
  // refused and why. OPTIONAL, DISCLOSED: kept optional (rather than required) so every existing
  // PnlV2 test fixture across this codebase (computeBehavior.test.ts, computeRisk.test.ts,
  // computeSmartMoneyScore.test.ts, etc.) continues to typecheck unchanged — computePnl's own real
  // output always populates it (never actually undefined from the one real producer of this type).
  unrealizedExcludedPositions?: ExcludedUnrealizedPosition[]
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

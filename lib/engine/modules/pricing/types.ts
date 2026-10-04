// lib/engine/modules/pricing/types.ts — shared types for the new pricing module.
//
// FILE-LOCATION DISCLOSURE (same as lib/engine/modules/holdings/types.ts): no single shared
// "engine types" file exists anywhere in this codebase — co-located with this module instead,
// matching every other engine file's own convention.
//
// SHAPE, EXACTLY AS SPECIFIED (no changes), except `classification` is typed against the real
// ChainHolding['classification'] union (holdings/types.ts) rather than a bare `string` — every
// PricedHolding here is built directly from a real ChainHolding, so its classification can only
// ever be one of those 5 real values; widening it to `string` would just discard type information
// this module already has for free, not add any real flexibility.

import type { ChainHolding } from '../holdings/types'

export type PricedHolding = {
  chainId: number
  tokenAddress: string
  symbol: string
  decimals: number
  quantity: string
  priceUsd: number | null // null if no reliable price
  valueUsd: number | null // quantity * priceUsd
  classification: ChainHolding['classification']
  // PER-HOLDING EVIDENCE (repeated-scan portfolio-value audit). priceUsd/valueUsd above stay FRESH-ONLY (every
  // existing consumer — portfolio build, PnL — is unchanged); a recent verified price reused after a transient
  // failure lives only in the stale* fields and is labelled stale_verified. Unavailable is never 0.
  /** 'unavailable' when the quantity rests on assumed decimals that could not be verified. */
  balanceStatus?: HoldingEvidenceStatus
  priceStatus?: HoldingPriceStatus
  valueStatus?: HoldingPriceStatus
  /** Source that observed the price in use (fresh or stale); null when unavailable. */
  priceSource?: string | null
  /** ORIGINAL observation time of the price in use — never re-stamped by a cache hit or a reuse. */
  priceObservedAt?: number | null
  /** Why no fresh price (e.g. 'error:http_429', 'no_matching_pair', 'not_looked_up_budget'); null when fresh. */
  priceFailureReason?: string | null
  staleVerifiedPriceUsd?: number | null
  staleVerifiedValueUsd?: number | null
}

export type HoldingEvidenceStatus = 'verified' | 'unavailable'
export type HoldingPriceStatus = 'verified' | 'stale_verified' | 'unavailable'

/** How the EVM value is supported, by evidence kind (counted separately, never blended silently). */
export type PortfolioPricingEvidence = {
  freshPricedCount: number
  staleVerifiedPricedCount: number
  unpricedCount: number
  freshSubtotalUsd: number
  staleSupportedSubtotalUsd: number
  /** Largest prior value (last verified price × current balance) among holdings now fully unpriced. */
  dominantUnpricedValuePreviouslyUsd?: number
}

export type PricingEngineOutput = {
  pricedHoldings: PricedHolding[]
  totalValueUsd: number
  chainValueUsd: Record<number, number>
  priceStatus: 'ok' | 'partial' | 'unavailable'
  /** Unpriced holdings with a REAL local materiality signal above dust (provider partial value / stable peg). */
  potentiallyMaterialUnpricedCount?: number
  /** Per-holding fallback selection audit (lanes, ranks, skip reasons) — debug only. */
  fallbackAudit?: import('./fetchPricing').HoldingsFallbackAudit
  portfolioPricingEvidence?: PortfolioPricingEvidence
}

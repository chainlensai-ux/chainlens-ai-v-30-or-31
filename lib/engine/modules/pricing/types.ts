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
}

export type PricingEngineOutput = {
  pricedHoldings: PricedHolding[]
  totalValueUsd: number
  chainValueUsd: Record<number, number>
  priceStatus: 'ok' | 'partial' | 'unavailable'
}

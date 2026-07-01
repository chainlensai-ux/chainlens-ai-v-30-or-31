// MODULE 11 — pricingEngine: type definitions.
//
// Resolves a CURRENT USD price per token, for valuing holdings (portfolioAssembler). This is
// distinct from any historical price-at-time evidence used elsewhere for FIFO cost basis —
// pricingEngine only ever answers "what is this token worth right now."

import type { SupportedChain } from '../providerFetchWindow/types'

export type PriceSource = 'provider_supplied' | 'dexscreener_fallback' | 'unavailable'

export type TokenPrice = {
  chain: SupportedChain
  contract: string
  priceUsd: number | null
  source: PriceSource
}

export type PricingRequest = {
  chain: SupportedChain
  contract: string
  // A price the caller already has for free (e.g. GoldRush's balances_v2 quote_rate) — pricingEngine
  // uses this instead of spending a fallback lookup, and never overwrites it with a lower-quality
  // source.
  knownPriceUsd?: number | null
}

// Bounds how many missing-price fallback lookups a single pricing pass will make — cost safety,
// mirroring the "never deep-page" bounding used throughout this engine.
export const MAX_FALLBACK_PRICE_LOOKUPS = 10

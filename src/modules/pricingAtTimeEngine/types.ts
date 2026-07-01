// MODULE — pricingAtTimeEngine: type definitions.
//
// Fully additive: computes historical (at-transaction-time) USD pricing for buyTimeline +
// sellTimelineV2 entries, keyed by their real txHash. Does NOT modify fifoEngine (which has its
// own, separate priceUsdLookup/currentPriceUsdLookup injection mechanism and is left completely
// untouched) or any other existing pricing logic.
//
// HONESTY NOTE: this module never fetches a price itself and never guesses one — `priceSources`
// (primary/fallback) are caller-injected functions, exactly like fifoEngine's priceUsdLookup and
// pnlEngine's resolveCostUsdEstimate/resolveProceedsUsdEstimate. No real historical-price API
// (GoldRush price-at-timestamp, CoinGecko historical, etc.) is integrated anywhere in this
// codebase, so the pipeline wires this module up with sources that honestly always return null
// (src/pipeline/utils.ts's noPriceSources()) until a real one is verified and injected — see
// pipeline/index.ts's wiring comment.

import type { SupportedChain } from '../providerFetchWindow/types'

// Returns a real USD price at the given timestamp, or null when the source has no data. May be
// sync or async — this module always awaits it either way.
export type PriceSourceFn = (
  token: string,
  chain: SupportedChain,
  timestamp: number,
) => number | null | Promise<number | null>

export type PriceSources = {
  primary: PriceSourceFn
  fallback: PriceSourceFn
}

export type PriceSourceUsed = 'primary' | 'fallback' | 'failed'

export type SourceBreakdown = {
  primary: number
  fallback: number
  failed: number
}

export type PricingAtTimeResult = {
  costUsd: Record<string, number | null>
  proceedsUsd: Record<string, number | null>
  evidenceMissingCount: number
  sourceBreakdown: SourceBreakdown
}

// Minimal shape this module actually needs from a buy/sell entry — deliberately not importing the
// full BuyTimelineEntry/SellTimelineEntry types, so this module has no compile-time coupling to
// either producing module beyond the fields it genuinely reads.
export type PriceableEntry = {
  txHash: string
  token: string
  chain: SupportedChain
  timestamp: number
  amount: string
}

export type ResolvePricingAtTimeParams = {
  buyEntries: PriceableEntry[]
  sellEntries: PriceableEntry[]
  priceSources: PriceSources
}

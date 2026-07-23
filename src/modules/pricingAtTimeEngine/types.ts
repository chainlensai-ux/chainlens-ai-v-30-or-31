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
  // PRIORITY, ADDITIVE/OPTIONAL, DISCLOSED: when true, this entry is a verified FIFO closed lot's own
  // entry or exit requirement (see priceLotsForWallet.ts's structural pre-pass) — priceAllEntries
  // dispatches all priority entries (combined across buys+sells) before any non-priority entry of the
  // same token, so the shared per-token lookup cap is spent on the decisive buy+sell pair a real
  // closed lot needs, not crowded out by unrelated/lower-value activity for the same token. Omitted
  // (undefined) is the same as false — every existing caller that doesn't set this is unaffected.
  priority?: boolean
}

// EXTERNAL FALLBACK, ADDITIVE/OPTIONAL, DISCLOSED: `resolvePricingAtTime` below is called from TWO
// real sites — src/pipeline/priceLotsForWallet.ts (feeds fifoEngine's cost basis, MUST stay
// byte-identical) and src/pipeline/index.ts's own display-only pricingAtTime pass (stage 6c,
// additive). This entire `fallbackPricing` config is optional and defaults to unused — when a
// caller doesn't pass it (priceLotsForWallet.ts never does), behavior is 100% identical to before
// this type existed. Only the display pass (src/pipeline/index.ts) is authorized to pass one,
// wired to src/modules/fallbackPricing (BaseScan/GeckoTerminal, current-price-only). A plain
// function type, not a concrete import of that module's class, matching this file's own existing
// "caller-injected function" convention (PriceSourceFn/PriceSources above) — keeps this module
// with zero compile-time coupling to fallbackPricing.
export type FallbackPricingRoute = 'BaseScan' | 'GeckoTerminal' | 'failed'

export type FallbackPricingAttemptFn = (params: {
  chain: SupportedChain
  tokenAddress: string
  timestampMs?: number
}) => Promise<
  | { ok: true; priceUsd: number; source: 'BaseScan' | 'GeckoTerminal' }
  | { ok: false; errorReason: string }
>

export type FallbackPricingConfig = {
  attempt: FallbackPricingAttemptFn
  // Router-distributor-mode signal, threaded through for observability/disclosure — see
  // resolvePricingAtTime's own header for why this doesn't change the attempt logic today (the
  // fallback is already attempted on every primary miss regardless; there is no existing
  // budget/cap this flag would need to bypass).
  routerDistributorMode?: boolean
  onRouteRecorded?: (info: { token: string; chain: SupportedChain; timestamp: number; route: FallbackPricingRoute }) => void
}

export type ResolvePricingAtTimeParams = {
  buyEntries: PriceableEntry[]
  sellEntries: PriceableEntry[]
  priceSources: PriceSources
  fallbackPricing?: FallbackPricingConfig
}

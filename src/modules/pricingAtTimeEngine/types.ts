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
  // PAIR-RANK, ADDITIVE/OPTIONAL, DISCLOSED: when set, this entry is a verified FIFO closed lot's own
  // entry or exit requirement (see priceLotsForWallet.ts's structural pre-pass). Lower rank = higher
  // priority. COMPLETE-PAIR FIX, DISCLOSED (confirmed bug: a boolean `priority` flag alone still let
  // ALL priority buys dispatch before ANY priority sell for a token with multiple closed lots — the
  // cap of 2 was spent on 2 unrelated buys, leaving every sell capped, i.e. 0 fully priced lots for
  // that token, despite the boolean version already fixing the single-closed-lot case). A numeric
  // rank groups a pair's own buy+sell adjacently (same rank = same closed lot) and orders pairs for
  // the same token deterministically, so priceAllEntries can finish rank 0's complete pair before
  // ever touching rank 1's — "one full pair" beats "two half pairs" under the same bounded cap.
  // Omitted (undefined) means "not a closed-lot requirement" — sorts after every ranked entry, same
  // relative order as before this field existed. Every existing caller that doesn't set this is
  // unaffected.
  pairRank?: number
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

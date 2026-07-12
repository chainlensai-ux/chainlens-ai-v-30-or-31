// lib/engine/modules/holdings/types.ts — shared types for the new ChainHolding holdings module.
//
// FILE-LOCATION DISCLOSURE: the task asked for these types to live "in the engine types file
// (where other engine inputs live)" — no single shared engine-types file exists anywhere in this
// codebase (each lib/engines/*.ts file — pricingAtTimeEngine.ts, unrealizedPnlEngine.ts,
// tradeTimelineEngineV2.ts, smartMoneyScoreEngine.ts, metadataEngine.ts — defines its own types
// inline, co-located with its own logic). Rather than fabricate a new shared file that doesn't
// match this codebase's actual convention, these types are co-located with the new module itself,
// consistent with every other engine file's own pattern.
//
// SHAPE, mostly as originally specified, plus two additive fields (see below):

export type ChainHolding = {
  chainId: number
  tokenAddress: string
  symbol: string
  decimals: number
  quantity: string // kept as string, per request
  lastActivityAt: string | null // ISO or null
  classification: 'stable' | 'blue_chip' | 'meme' | 'lp' | 'other'
  // PORTFOLIO-INTELLIGENCE $0 BUG FIX, DISCLOSED: the underlying src/modules/holdings's
  // TokenHolding already carries these for free from the balances provider (GoldRush's
  // balances_v2 call returns a quote/quote_rate alongside the balance) — this adapter was
  // previously dropping both fields entirely, forcing lib/engine/modules/pricing/fetchPricing.ts
  // to re-price every token from scratch via a second, weaker, capped DexScreener-only fallback
  // (src/modules/pricing's resolvePrices) that had no idea a price was already available. For
  // low-liquidity tokens that second lookup can legitimately fail while the first, real provider
  // price was sitting right here unused — see fetchPricing.ts's own updated header for how this
  // is now actually consumed.
  // Optional (not required) so existing test fixtures constructing a ChainHolding literal without
  // these fields still typecheck unchanged; priceHoldings() below treats a missing field the same
  // as an explicit null (honestly falls through to the real fallback lookup).
  providerPriceUsd?: number | null
  providerValueUsd?: number | null
}

export type HoldingsEngineInput = {
  walletAddress: string
  holdings: ChainHolding[]
}

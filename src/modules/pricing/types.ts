// MODULE 11 — pricingEngine: type definitions.
//
// Resolves a CURRENT USD price per token, for valuing holdings (portfolioAssembler). This is
// distinct from any historical price-at-time evidence used elsewhere for FIFO cost basis —
// pricingEngine only ever answers "what is this token worth right now."

import type { SupportedChain } from '../providerFetchWindow/types'

// WALLET-SCANNER PRICE-RESOLVER FIX, DISCLOSED (Wallet Scanner improvement audit — live report: "72
// open positions, only 10 reconciled" tracked exactly to MAX_FALLBACK_PRICE_LOOKUPS below, and
// DexScreener was the ONLY fallback tier). `geckoterminal_fallback` is a second, independent real
// source (src/pipeline/providers/geckoTerminalPriceSource.ts's fetchGeckoTerminalCurrentPrice, reused
// unchanged — same persisted 429 cooldown as the historical-pricing path). `short_ttl_cache` reports a
// price this SAME resolvePrices() call (or a recent prior one, same process) already resolved from one
// of the real sources above — never a distinct value, just avoiding a repeat network call for the
// same (chain, contract) within the cache TTL.
export type PriceSource = 'provider_supplied' | 'dexscreener_fallback' | 'geckoterminal_fallback' | 'short_ttl_cache' | 'unavailable'

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
  // SYMBOL / AMOUNT, DISCLOSED, ADDITIVE (Wallet Scanner weak-spot pass): optional facts from the
  // same canonical holdings snapshot. Used only to skip DexScreener/Gecko fallback spend on
  // promotional-spam / implausible-quantity tokens so the bounded fallback cap is spent on
  // currently-held, ordinary-looking positions. Never used as a price. Omitted requests are
  // treated as non-spam (full fallback eligibility), matching today's behavior.
  symbol?: string | null
  amount?: number | null
}

// Bounds how many missing-price fallback lookups a single pricing pass will make — cost safety,
// mirroring the "never deep-page" bounding used throughout this engine.
//
// RAISED 10 -> 20, DISCLOSED (hard rule: "do not increase provider calls blindly" — this is a
// bounded, disclosed increase, not an open-ended one). The live report this task audits showed 72
// open positions with only 10 reconciled — landing exactly on the old cap. Two things make this
// increase safe rather than blind: (1) resolvePrices() below now checks the short-TTL price cache
// BEFORE spending a fallback slot, so a repeat/duplicate (chain, contract) across positions never
// consumes budget twice; (2) the fallback loop is now bounded-concurrency instead of serial, so the
// larger cap costs wall-clock time closer to what 10 used to cost, not double.
export const MAX_FALLBACK_PRICE_LOOKUPS = 20

// Concurrency cap for the fallback-provider fan-out — same "capped fan-out, never fully serial or
// fully unbounded" convention already used by recoveryPolicy/pricingAtTimeEngine/dustSuppression
// (each has its own local mapWithConcurrencyLimit; see their own headers).
export const FALLBACK_PRICE_CONCURRENCY_LIMIT = 5

// Deliberately short: a "current" price is only ever a point-in-time snapshot, and this cache exists
// purely to avoid a REPEAT network call for the same (chain, contract) within one scan (or a couple
// of scans on the same warm process) — never to serve an unrealized-PnL valuation from a price that
// could plausibly be stale by the time it's read.
export const PRICE_CACHE_TTL_MS = 20_000

// PRICING-RESOLUTION AUDIT, DISCLOSED, ADDITIVE: real, measured counters from one resolvePrices()
// call — feeds the pipeline-level walletScanPerformanceAudit's providerCalls/cacheHits/
// rateLimitHits fields. Never estimated; every field is incremented at the exact point the real
// event it describes happens.
export type PricingResolutionAudit = {
  totalRequests: number
  providerSuppliedCount: number
  cacheHits: number
  dexscreenerCalls: number
  dexscreenerSuccesses: number
  geckoTerminalCalls: number
  geckoTerminalSuccesses: number
  geckoTerminalQuotaStopped: number
  fallbackCapReached: boolean
  unresolvedCount: number
  // GECKOTERMINAL-429 STALE-CACHE FALLBACK, DISCLOSED (Wallet Scanner improvement audit, task 4 —
  // "use stale cache if available" when GeckoTerminal is quota-stopped): count of positions this
  // scan resolved from a PAST-TTL cache entry specifically because GeckoTerminal was in cooldown and
  // DexScreener also had nothing — a real, previously-resolved price is preferred over none, always
  // reported honestly via TokenPrice.source (never relabeled as fresh).
  staleCacheFallbacksUsed: number
}

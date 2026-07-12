// MODULE (orchestration layer) — pricingAtTimeAdapter
//
// Composes this pipeline's real price sources into pricingAtTimeEngine's two-slot PriceSources
// contract (src/modules/pricingAtTimeEngine/types.ts's `{ primary, fallback }` — never modified
// here).
//
// CHAIN-AWARE ROUTING, DISCLOSED (per this task's own request): GoldRush historical pricing is
// tried first for every chain EXCEPT Base, where GeckoTerminal is tried first instead; DexScreener
// (current-price-only, never historical — see its own module header) sits in the middle for both;
// whichever of GoldRush/GeckoTerminal wasn't tried first runs last. FALSE PREMISE IN THE REQUEST,
// DISCLOSED: the request assumed "GoldRush will return null for Base" — that's not true. GoldRush's
// real chain-slug map (src/modules/pricingAtTimeEngine/sources/goldrushPriceSource.ts's
// GOLDRUSH_CHAIN_SLUGS) has genuine, verified coverage for Base (`base-mainnet`). It is still tried
// last for Base per this request (a legitimate "prefer free sources first" choice) — it just may
// genuinely return a real price rather than null.
//
// COVERAGE PRESERVED, DISCLOSED (explicit user confirmation this session): the literal 3-provider
// ordering below never mentions CoinGecko or the on-chain Uniswap V3 source (basedex) — both
// currently provide real coverage via multiProviderPriceSource. Rather than silently dropping that
// coverage (a real regression, not just a reorder), both run as one final fallback attempt after
// GoldRush/DexScreener/GeckoTerminal have all failed, for every chain.
//
// SCOPE NOTE, DISCLOSED: no new "dexScreenerPriceSource.ts" historical source was built (from the
// prior task in this session). DexScreener already runs inside multiProviderPriceSource (protected,
// src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource.ts -> dexscreener.ts) and that
// module's own header already discloses it as current-price-only — DexScreener's real public API
// has no historical OHLCV endpoint. This file calls that same real, existing function directly
// (not a new integration) wherever "DexScreener" appears in the routing below.

import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'
import type { SupportedChain } from '../modules/providerFetchWindow/types'
import { fetchDexscreenerPriceDetailed } from '../modules/pricingAtTimeEngine/sources/dexscreener'
import { multiProviderPriceSource } from '../modules/pricingAtTimeEngine/sources/multiProviderPriceSource'
import { fetchGeckoTerminalPriceDetailed } from './providers/geckoTerminalPriceSource'

// Sanity guard, applied to every price this pipeline resolves — a price outside this range is
// provider garbage, never rendered. Independent of pnlSummaryAdapter.ts's separate $1e12
// PnL-overflow guard.
const MIN_VALID_USD_PRICE = 0
const MAX_VALID_USD_PRICE = 1e6

function isSanePrice(price: number | null | undefined): price is number {
  return price != null && Number.isFinite(price) && price > MIN_VALID_USD_PRICE && price <= MAX_VALID_USD_PRICE
}

// Wraps any existing PriceSourceFn so an out-of-range result is discarded (logged, treated as no
// data) instead of ever reaching fifoEngine/pnlEngine's real cost-basis calculations. Kept exported
// — still used standalone in src/pipeline/index.ts for defense-in-depth around the GoldRush client
// construction path.
export function withSanePriceGuard(source: PriceSourceFn, sourceLabel: string): PriceSourceFn {
  return async (token, chain, timestamp) => {
    const result = await source(token, chain, timestamp)
    if (result === null) return null
    if (isSanePrice(result)) return result
    // eslint-disable-next-line no-console
    console.warn('[pricingAtTimeAdapter] out-of-range price discarded', { sourceLabel, token, chain, price: result })
    return null
  }
}

// Extends an existing fallback source (multiProviderPriceSource — DexScreener/CoinGecko/basedex,
// all real, already integrated) with GeckoTerminal as one more real historical attempt when the
// existing chain comes up empty. Never replaces the existing chain, only extends it. Kept exported
// for any caller still using the simpler (non-chain-aware) composition.
export function withGeckoTerminalFallback(existingFallback: PriceSourceFn): PriceSourceFn {
  return async (token, chain, timestamp) => {
    const fromExisting = await existingFallback(token, chain, timestamp)
    if (fromExisting !== null) return fromExisting

    const geckoResult = await fetchGeckoTerminalPriceDetailed(token, chain, timestamp)
    return geckoResult.priceUsd
  }
}

export type PricingRouteUsed = 'goldrush' | 'geckoterminal' | 'dexscreener' | 'coingecko_or_basedex' | 'none'

export type PricingRouteRecord = {
  token: string
  chain: SupportedChain
  timestamp: number
  route: PricingRouteUsed
}

// Process-lifetime, cross-request log of which real provider actually answered each pricing
// attempt — same disclosed in-memory pattern as lib/server/rpcDebug.ts's rpcDebugLog elsewhere in
// this codebase. A per-request view requires the same snapshot-length-before/slice-after pattern
// already used around rpcDebugLog in src/pipeline/index.ts.
export const pricingRouteLog: PricingRouteRecord[] = []

function recordRoute(token: string, chain: SupportedChain, timestamp: number, route: PricingRouteUsed): void {
  pricingRouteLog.push({ token, chain, timestamp, route })
}

// Builds the full chain-aware historical-pricing router described above. `goldrush` is the
// caller's real (or always-null, if no API key/client) GoldRush source — this function does not
// construct a GoldRushClient itself.
export function buildChainAwareHistoricalPriceSource(goldrush: PriceSourceFn): PriceSourceFn {
  const tryGoldrush = async (token: string, chain: SupportedChain, timestamp: number): Promise<number | null> => {
    const price = await goldrush(token, chain, timestamp)
    return isSanePrice(price) ? price : null
  }
  const tryDexscreener = async (token: string, chain: SupportedChain, timestamp: number): Promise<number | null> => {
    const result = await fetchDexscreenerPriceDetailed(token, chain, timestamp)
    return isSanePrice(result.priceUsd) ? result.priceUsd : null
  }
  const tryGeckoTerminal = async (token: string, chain: SupportedChain, timestamp: number): Promise<number | null> => {
    const result = await fetchGeckoTerminalPriceDetailed(token, chain, timestamp)
    return isSanePrice(result.priceUsd) ? result.priceUsd : null
  }
  // Final safety net, DISCLOSED (see file header "COVERAGE PRESERVED"): re-uses the existing,
  // already-real multiProviderPriceSource chain (DexScreener/CoinGecko/basedex). DexScreener will
  // already have been tried above by this point — a harmless redundant attempt, not a new call
  // pattern — before this reaches CoinGecko/basedex, which are the actual new coverage being
  // preserved here.
  const coverageSafetyNet = multiProviderPriceSource()

  return async (token, chain, timestamp) => {
    let price: number | null = null

    if (chain === 'base') {
      price = await tryGeckoTerminal(token, chain, timestamp)
      if (price !== null) { recordRoute(token, chain, timestamp, 'geckoterminal'); return price }
      price = await tryDexscreener(token, chain, timestamp)
      if (price !== null) { recordRoute(token, chain, timestamp, 'dexscreener'); return price }
      price = await tryGoldrush(token, chain, timestamp)
      if (price !== null) { recordRoute(token, chain, timestamp, 'goldrush'); return price }
    } else {
      price = await tryGoldrush(token, chain, timestamp)
      if (price !== null) { recordRoute(token, chain, timestamp, 'goldrush'); return price }
      price = await tryDexscreener(token, chain, timestamp)
      if (price !== null) { recordRoute(token, chain, timestamp, 'dexscreener'); return price }
      price = await tryGeckoTerminal(token, chain, timestamp)
      if (price !== null) { recordRoute(token, chain, timestamp, 'geckoterminal'); return price }
    }

    const safetyNetPrice = await coverageSafetyNet(token, chain, timestamp)
    if (isSanePrice(safetyNetPrice)) {
      recordRoute(token, chain, timestamp, 'coingecko_or_basedex')
      return safetyNetPrice
    }

    recordRoute(token, chain, timestamp, 'none')
    return null
  }
}

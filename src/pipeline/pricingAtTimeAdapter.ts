// MODULE (orchestration layer) — pricingAtTimeAdapter
//
// Composes this pipeline's real price sources into pricingAtTimeEngine's two-slot PriceSources
// contract (src/modules/pricingAtTimeEngine/types.ts's `{ primary, fallback }` — never modified
// here). GoldRush stays primary (the only paid/reliable full-history source in this codebase,
// already wired that way in src/pipeline/index.ts's buildPriceSources()); `fallback` additionally
// tries the new, real GeckoTerminal historical source after the existing DexScreener/CoinGecko/
// on-chain-Uniswap-V3 chain (multiProviderPriceSource) — genuine new coverage, not a reorder of
// what already worked.
//
// SCOPE NOTE, DISCLOSED: no new "dexScreenerPriceSource.ts" historical source was built. DexScreener
// already runs first inside multiProviderPriceSource (protected,
// src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource.ts -> dexscreener.ts) and that
// module's own header already discloses it as current-price-only — DexScreener's real public API
// has no historical OHLCV endpoint to build a second integration against. Duplicating it under a
// new file name would either re-implement the same current-price-only logic twice, or fabricate
// historical accuracy DexScreener doesn't have.

import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'
import { fetchGeckoTerminalPriceDetailed } from './providers/geckoTerminalPriceSource'

// Sanity guard, applied to every price this pipeline resolves (both primary and fallback slots) —
// a price outside this range is provider garbage, never rendered. Same $1e6/$0 ceiling convention
// requested for this task; independent of pnlSummaryAdapter.ts's separate $1e12 PnL-overflow guard.
const MIN_VALID_USD_PRICE = 0
const MAX_VALID_USD_PRICE = 1e6

function isSanePrice(price: number | null): price is number {
  return price != null && Number.isFinite(price) && price > MIN_VALID_USD_PRICE && price <= MAX_VALID_USD_PRICE
}

// Wraps any existing PriceSourceFn so an out-of-range result is discarded (logged, treated as no
// data) instead of ever reaching fifoEngine/pnlEngine's real cost-basis calculations.
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
// existing chain comes up empty. Never replaces the existing chain, only extends it.
export function withGeckoTerminalFallback(existingFallback: PriceSourceFn): PriceSourceFn {
  return async (token, chain, timestamp) => {
    const fromExisting = await existingFallback(token, chain, timestamp)
    if (fromExisting !== null) return fromExisting

    const geckoResult = await fetchGeckoTerminalPriceDetailed(token, chain, timestamp)
    return geckoResult.priceUsd
  }
}

// MODULE 11 — pricingEngine
//
// Resolves current USD prices for a set of tokens. Prefers a price the caller already has for
// free (e.g. from holdingsEngine's GoldRush balances_v2 call) over spending a fallback lookup, and
// caps how many fallback lookups a single call will make (MAX_FALLBACK_PRICE_LOOKUPS) — cost is
// bounded regardless of how many unpriced tokens a wallet holds.

import type { PricingRequest, TokenPrice } from './types'
import { MAX_FALLBACK_PRICE_LOOKUPS } from './types'
import { fetchDexscreenerPrice } from './utils'

export type { PriceSource, PricingRequest, TokenPrice } from './types'
export { MAX_FALLBACK_PRICE_LOOKUPS } from './types'

export async function resolvePrices(requests: PricingRequest[]): Promise<TokenPrice[]> {
  const results: TokenPrice[] = []
  let fallbackLookupsUsed = 0

  for (const request of requests) {
    if (typeof request.knownPriceUsd === 'number' && request.knownPriceUsd > 0) {
      results.push({ chain: request.chain, contract: request.contract, priceUsd: request.knownPriceUsd, source: 'provider_supplied' })
      continue
    }

    if (fallbackLookupsUsed >= MAX_FALLBACK_PRICE_LOOKUPS) {
      results.push({ chain: request.chain, contract: request.contract, priceUsd: null, source: 'unavailable' })
      continue
    }

    fallbackLookupsUsed += 1
    // eslint-disable-next-line no-await-in-loop
    const priceUsd = await fetchDexscreenerPrice(request.contract)
    results.push({
      chain: request.chain,
      contract: request.contract,
      priceUsd,
      source: priceUsd != null ? 'dexscreener_fallback' : 'unavailable',
    })
  }

  return results
}

// lib/providers/coingecko.ts — CoinGecko historical price provider adapter for PricingAtTimeEngine.
//
// REUSE, NOT REIMPLEMENTATION, DISCLOSED: delegates to the REAL, already-shipped CoinGecko
// historical price source at src/modules/pricingAtTimeEngine/sources/coingecko.ts (its real
// /coins/{platform}/contract/{address}/market_chart/range lookup), rather than a second parallel
// fetch implementation. See lib/providers/goldrush.ts's header for the same rationale.

import { fetchCoingeckoPriceDetailed } from '@/src/modules/pricingAtTimeEngine/sources/coingecko'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'

export type CoingeckoPriceRequest = { chain: SupportedChain; tokenAddress: string; timestamp: number }
export type CoingeckoPriceResult = { priceUsd: number | null; timestamp: number; notes?: string }

// Gracefully returns { priceUsd: null } for any failure — unverified chain/platform id, rate
// limit, network error, or genuinely no price data in range. Never throws.
export async function fetchCoingeckoHistoricalPrice(req: CoingeckoPriceRequest): Promise<CoingeckoPriceResult> {
  try {
    const result = await fetchCoingeckoPriceDetailed(req.tokenAddress, req.chain, req.timestamp * 1000)
    return { priceUsd: result.priceUsd, timestamp: req.timestamp, notes: result.reason ?? undefined }
  } catch (err) {
    return { priceUsd: null, timestamp: req.timestamp, notes: `coingecko_error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

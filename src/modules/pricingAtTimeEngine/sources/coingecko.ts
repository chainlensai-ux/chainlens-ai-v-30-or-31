// MODULE — pricingAtTimeEngine/sources: coingecko
//
// Split out of multiProviderPriceSource.ts for modularization. Logic is unchanged from that file.
//
// Uses CoinGecko's real, documented /coins/{platform}/contract/{address}/market_chart/range
// endpoint, which genuinely supports a historical date range (unlike DexScreener's public API) —
// this is a real price-at-timestamp lookup, not a current-price approximation.

import type { SupportedChain } from '../../providerFetchWindow/types'

const COINGECKO_PLATFORM_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  // hyperevm intentionally omitted — not a verified CoinGecko asset platform id.
}

const COINGECKO_RANGE_WINDOW_SECONDS = 24 * 60 * 60 // +/- 1 day around the target timestamp

export type CoingeckoPriceResult = { priceUsd: number | null; reason: string | null }

// Detailed variant — used by the orchestrator (getPriceAtTime) for structured debug output.
export async function fetchCoingeckoPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<CoingeckoPriceResult> {
  const platform = COINGECKO_PLATFORM_IDS[chain]
  if (!platform) return { priceUsd: null, reason: 'unverified_chain_for_coingecko' }

  const targetSec = Math.floor(timestamp / 1000)
  const url = new URL(
    `https://api.coingecko.com/api/v3/coins/${platform}/contract/${token.toLowerCase()}/market_chart/range`,
  )
  url.searchParams.set('vs_currency', 'usd')
  url.searchParams.set('from', String(targetSec - COINGECKO_RANGE_WINDOW_SECONDS))
  url.searchParams.set('to', String(targetSec + COINGECKO_RANGE_WINDOW_SECONDS))

  const apiKey = process.env.COINGECKO_API_KEY

  try {
    const res = await fetch(url.toString(), {
      headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

    const data = (await res.json()) as { prices?: Array<[number, number]> }
    const prices = data.prices ?? []
    if (prices.length === 0) return { priceUsd: null, reason: 'no_price_series_in_range' }

    const closest = prices.reduce((a, b) => (Math.abs(b[0] - timestamp) < Math.abs(a[0] - timestamp) ? b : a))
    return Number.isFinite(closest[1]) ? { priceUsd: closest[1], reason: null } : { priceUsd: null, reason: 'unparseable_price' }
  } catch (err) {
    return { priceUsd: null, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// Public export matching this codebase's PriceSourceFn contract exactly (token, chain, timestamp)
// -> number | null — a clean USD price or null, never a fabricated value.
export async function fetchCoingeckoPrice(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<number | null> {
  const result = await fetchCoingeckoPriceDetailed(token, chain, timestamp)
  return result.priceUsd
}

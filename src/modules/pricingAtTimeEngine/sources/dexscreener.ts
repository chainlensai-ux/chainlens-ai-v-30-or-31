// MODULE — pricingAtTimeEngine/sources: dexscreener
//
// Split out of multiProviderPriceSource.ts for modularization. Logic is unchanged from that file.
//
// DEXSCREENER IS A CURRENT-PRICE SOURCE ONLY: its real public API
// (api.dexscreener.com/latest/dex/tokens/{address}) exposes live pair state — price, liquidity,
// volume as of "now" — with no historical OHLCV/candle endpoint (this sandbox's network policy
// blocks outbound calls to api.dexscreener.com, so this can't be re-verified live here, but it's a
// stable, long-documented fact about a well-known public API, not an assumption). So
// fetchDexscreenerPrice() only returns a real value when `timestamp` is within
// DEXSCREENER_FRESHNESS_TOLERANCE_MS of "now" — otherwise it honestly returns null rather than
// silently substituting today's price for a historical one.

import type { SupportedChain } from '../../providerFetchWindow/types'

const DEXSCREENER_CHAIN_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  // hyperevm intentionally omitted — no verified DexScreener chainId confirmed for it.
}

const DEXSCREENER_FRESHNESS_TOLERANCE_MS = 5 * 60 * 1000 // 5 minutes

export type DexscreenerPriceResult = { priceUsd: number | null; reason: string | null }

// Detailed variant — used by the orchestrator (getPriceAtTime) for structured debug output.
export async function fetchDexscreenerPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<DexscreenerPriceResult> {
  const chainId = DEXSCREENER_CHAIN_IDS[chain]
  if (!chainId) return { priceUsd: null, reason: 'unverified_chain_for_dexscreener' }

  const ageMs = Math.abs(Date.now() - timestamp)
  if (ageMs > DEXSCREENER_FRESHNESS_TOLERANCE_MS) {
    return { priceUsd: null, reason: 'dexscreener_only_exposes_current_price_timestamp_too_far_from_now' }
  }

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

    const data = (await res.json()) as {
      pairs?: Array<{ chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }>
    }
    const candidates = (data.pairs ?? []).filter((p) => p.chainId === chainId && p.priceUsd)
    if (candidates.length === 0) return { priceUsd: null, reason: 'no_matching_pair' }

    // "Resolve best pair" = highest real reported USD liquidity, the standard signal for which
    // pair's price is most trustworthy.
    const best = candidates.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a))
    const price = Number(best.priceUsd)
    return Number.isFinite(price) ? { priceUsd: price, reason: null } : { priceUsd: null, reason: 'unparseable_price' }
  } catch (err) {
    return { priceUsd: null, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// Public export matching this codebase's PriceSourceFn contract exactly (token, chain, timestamp)
// -> number | null — a clean USD price or null, never a fabricated value.
export async function fetchDexscreenerPrice(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<number | null> {
  const result = await fetchDexscreenerPriceDetailed(token, chain, timestamp)
  return result.priceUsd
}

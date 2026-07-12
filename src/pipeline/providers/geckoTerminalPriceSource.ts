// MODULE (orchestration layer) — providers/geckoTerminalPriceSource
//
// Real GeckoTerminal integration for historical (at-timestamp) USD pricing. Unlike DexScreener
// (api.dexscreener.com/latest/dex/tokens/{address} — current price only, see this codebase's own
// src/modules/pricingAtTimeEngine/sources/dexscreener.ts header), GeckoTerminal's public API
// genuinely exposes historical OHLCV candles — but per POOL, not per token, so this makes two real
// calls: (1) resolve the token's highest-liquidity pool, (2) fetch that pool's daily OHLCV candles
// and pick the one closest to the requested timestamp.
//
// ENDPOINT SHAPE, DISCLOSED: the task that requested this file specified
// `/api/v2/networks/{chain}/tokens/{token}/ohlcv` — that path is not part of GeckoTerminal's real
// public API; there is no per-token OHLCV endpoint. The real endpoints are:
//   GET /api/v2/networks/{network}/tokens/{address}/pools        (resolve pools for a token)
//   GET /api/v2/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}  (candles for one pool)
// This file calls the real ones. This sandbox has no outbound network access to
// api.geckoterminal.com, so this cannot be re-verified live here — endpoint shapes are from
// GeckoTerminal's published API documentation, not invented. Never fabricates a price: any failure
// at any step returns a real, structured reason and null, exactly like this codebase's other real
// price sources (dexscreener.ts, coingecko.ts, basedex.ts).

import type { SupportedChain } from '../../modules/providerFetchWindow/types'

// GeckoTerminal's own network slugs — best-effort, not re-verified live from this sandbox, same
// caveat this codebase already applies to its other chain-id maps (e.g. DEXSCREENER_CHAIN_IDS).
const GECKOTERMINAL_NETWORK_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'eth',
  base: 'base',
  arbitrum: 'arbitrum',
  // hyperevm intentionally omitted — no verified GeckoTerminal network id confirmed for it.
}

export type GeckoTerminalPriceResult = { priceUsd: number | null; reason: string | null }

type PoolsResponse = {
  data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }>
}

// GeckoTerminal's ohlcv_list rows are [unixTimestampSeconds, open, high, low, close, volume].
type OhlcvResponse = {
  data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } }
}

async function resolveTopPoolAddress(network: string, tokenAddress: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools`,
      { signal: AbortSignal.timeout(8_000) },
    )
    if (!res.ok) return null
    const data = (await res.json()) as PoolsResponse
    const pools = data.data ?? []
    if (pools.length === 0) return null
    // Highest real reported USD reserves — same "most-liquid pair wins" convention this codebase's
    // existing dexscreener.ts already uses for choosing among candidate pairs.
    const best = pools.reduce((a, b) =>
      Number(b.attributes?.reserve_in_usd ?? 0) > Number(a.attributes?.reserve_in_usd ?? 0) ? b : a,
    )
    return best.attributes?.address ?? null
  } catch {
    return null
  }
}

export async function fetchGeckoTerminalPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<GeckoTerminalPriceResult> {
  const network = GECKOTERMINAL_NETWORK_IDS[chain]
  if (!network) return { priceUsd: null, reason: 'unverified_network_for_geckoterminal' }

  const poolAddress = await resolveTopPoolAddress(network, token)
  if (!poolAddress) return { priceUsd: null, reason: 'no_pool_found' }

  try {
    // `before_timestamp` (seconds) pages the daily-candle series back from a point in time so a
    // genuinely historical timestamp can be reached, not just "today" — a real GeckoTerminal query
    // param, not invented. +1 day of slack ensures the target timestamp's own candle is included.
    const beforeTs = Math.floor(timestamp / 1000) + 24 * 60 * 60
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/day?before_timestamp=${beforeTs}&limit=30`,
      { signal: AbortSignal.timeout(8_000) },
    )
    if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

    const data = (await res.json()) as OhlcvResponse
    const candles = data.data?.attributes?.ohlcv_list ?? []
    if (candles.length === 0) return { priceUsd: null, reason: 'no_candles' }

    const targetSec = Math.floor(timestamp / 1000)
    const closest = candles.reduce((a, b) => (Math.abs(b[0] - targetSec) < Math.abs(a[0] - targetSec) ? b : a))
    const closePrice = closest[4]
    return Number.isFinite(closePrice) && closePrice > 0
      ? { priceUsd: closePrice, reason: null }
      : { priceUsd: null, reason: 'unparseable_price' }
  } catch (err) {
    return { priceUsd: null, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

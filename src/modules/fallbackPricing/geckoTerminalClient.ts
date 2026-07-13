// MODULE — fallbackPricing/geckoTerminalClient
//
// Real GeckoTerminal integration for a CURRENT (not historical) USD token price — deliberately
// different from src/pipeline/providers/geckoTerminalPriceSource.ts (which fetches historical OHLCV
// candles for a specific past timestamp, used by the chain-aware PRICE_SOURCES router). This
// client's required signature (getTokenPriceUsd(tokenAddress): Promise<number|null>) takes no
// timestamp — matching this task's own stated use ("use fallback price ONLY for current portfolio
// valuation"), a current-price lookup is the correct, honest thing to build here, not a
// re-implementation of the historical client with a hardcoded "now."
//
// REAL ENDPOINT: GET /api/v2/networks/{network}/tokens/{address}/pools — the same real, documented
// GeckoTerminal endpoint providers/geckoTerminalPriceSource.ts already uses to resolve a token's
// top pool; this client reads that same response's `base_token_price_usd` attribute directly
// instead of making a second OHLCV call, since only a current price is needed here. NEVER
// FABRICATES: any failure (no pool found, malformed response, non-200) returns null with a
// structured reason.
//
// CHAIN, DISCLOSED: this task's literal `getTokenPriceUsd(tokenAddress: string)` signature has no
// chain parameter, but GeckoTerminal's real API requires a network slug to resolve pools — the
// network is bound at construction time instead (one client instance per chain), same pattern this
// module's DefaultFallbackPricingService uses to select which client to call.

import type { SupportedChain } from '../providerFetchWindow/types'

// Same real network-slug map as providers/geckoTerminalPriceSource.ts (kept independent — no
// cross-import — so this new, additive module has no runtime coupling to that existing file).
const GECKOTERMINAL_NETWORK_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'eth',
  base: 'base',
  arbitrum: 'arbitrum',
}

export type GeckoTerminalPriceResult = { priceUsd: number | null; reason: string | null }

type PoolsResponse = {
  data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string; base_token_price_usd?: string } }>
}

function safeParsedUsdPrice(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export class GeckoTerminalClient {
  constructor(private readonly chain: SupportedChain) {}

  async getTokenPriceUsd(tokenAddress: string): Promise<number | null> {
    const result = await this.getTokenPriceUsdDetailed(tokenAddress)
    return result.priceUsd
  }

  // Detailed variant — exposed for tests/observability that want the real failure reason.
  async getTokenPriceUsdDetailed(tokenAddress: string): Promise<GeckoTerminalPriceResult> {
    const network = GECKOTERMINAL_NETWORK_IDS[this.chain]
    if (!network) return { priceUsd: null, reason: 'unverified_network_for_geckoterminal' }

    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools`,
        { signal: AbortSignal.timeout(8_000) },
      )
      if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

      const data = (await res.json()) as PoolsResponse
      // Highest-liquidity pool first — same tie-break as providers/geckoTerminalPriceSource.ts's
      // resolveTopPoolAddress, applied here directly since price is read from this same response.
      const pools = (data.data ?? [])
        .map((p) => ({
          priceUsd: safeParsedUsdPrice(p.attributes?.base_token_price_usd),
          liquidityUsd: safeParsedUsdPrice(p.attributes?.reserve_in_usd) ?? 0,
        }))
        .filter((p) => p.priceUsd !== null)
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd)

      if (pools.length === 0) return { priceUsd: null, reason: 'no_pool_found' }
      return { priceUsd: pools[0].priceUsd, reason: null }
    } catch (err) {
      return { priceUsd: null, reason: err instanceof Error ? err.message : 'unknown_error' }
    }
  }
}

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
import { selectGeckoTerminalPool } from '@/lib/pricing/currentPriceResolver'

// Same real network-slug map as providers/geckoTerminalPriceSource.ts (kept independent — no
// cross-import — so this new, additive module has no runtime coupling to that existing file).
const GECKOTERMINAL_NETWORK_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'eth',
  base: 'base',
  arbitrum: 'arbitrum',
}

export type GeckoTerminalPriceResult = { priceUsd: number | null; reason: string | null }

function safeParsedUsdPrice(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function geckoTerminalNetworkId(chain: SupportedChain): string | null {
  return GECKOTERMINAL_NETWORK_IDS[chain] ?? null
}

/** One pool from /tokens/{address}/pools with its exact token identities (relationships), unranked. */
export type GeckoTerminalTokenPool = {
  poolAddress: string
  dexId: string | null
  network: string
  baseTokenAddress: string
  quoteTokenAddress: string
  basePriceUsd: number | null
  quotePriceUsd: number | null
  reserveUsd: number | null
  volume24hUsd: number | null
}

type PoolsResponseDetailed = {
  data?: Array<{
    id?: string
    attributes?: { address?: string; reserve_in_usd?: string; base_token_price_usd?: string; quote_token_price_usd?: string; volume_usd?: { h24?: string } }
    relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } }
  }>
}

// GeckoTerminal ids are `${network}_${address}` — split strictly; anything else is not usable identity.
function splitGtId(id: unknown): { network: string; address: string } | null {
  if (typeof id !== 'string') return null
  const i = id.indexOf('_0x')
  if (i <= 0) return null
  return { network: id.slice(0, i), address: id.slice(i + 1).toLowerCase() }
}

export class GeckoTerminalClient {
  constructor(private readonly chain: SupportedChain) {}

  /**
   * Every pool GeckoTerminal lists for this exact token address, with base/quote token identity from the
   * response's own relationships. Selection (side, network, liquidity) is the caller's job — see
   * lib/pricing/currentPriceResolver.ts selectGeckoTerminalPool. Never throws.
   */
  async getTokenPools(tokenAddress: string): Promise<{ network: string | null; pools: GeckoTerminalTokenPool[]; reason: string | null }> {
    const network = GECKOTERMINAL_NETWORK_IDS[this.chain] ?? null
    if (!network) return { network: null, pools: [], reason: 'unverified_network_for_geckoterminal' }
    try {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools`, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) return { network, pools: [], reason: `http_${res.status}` }
      const data = (await res.json()) as PoolsResponseDetailed
      const pools: GeckoTerminalTokenPool[] = []
      for (const p of data.data ?? []) {
        const id = splitGtId(p.id)
        const base = splitGtId(p.relationships?.base_token?.data?.id)
        const quote = splitGtId(p.relationships?.quote_token?.data?.id)
        if (!id || !base || !quote) continue
        pools.push({
          poolAddress: (p.attributes?.address ?? id.address).toLowerCase(),
          dexId: p.relationships?.dex?.data?.id ?? null,
          // The pool's network must match for BOTH tokens, or it is not this chain's market.
          network: id.network === base.network && id.network === quote.network ? id.network : `${id.network}|mismatch`,
          baseTokenAddress: base.address,
          quoteTokenAddress: quote.address,
          basePriceUsd: safeParsedUsdPrice(p.attributes?.base_token_price_usd),
          quotePriceUsd: safeParsedUsdPrice(p.attributes?.quote_token_price_usd),
          reserveUsd: safeParsedUsdPrice(p.attributes?.reserve_in_usd),
          volume24hUsd: safeParsedUsdPrice(p.attributes?.volume_usd?.h24),
        })
      }
      return { network, pools, reason: pools.length === 0 ? 'no_pool_found' : null }
    } catch (err) {
      return { network, pools: [], reason: err instanceof Error ? err.message : 'unknown_error' }
    }
  }

  async getTokenPriceUsd(tokenAddress: string): Promise<number | null> {
    const result = await this.getTokenPriceUsdDetailed(tokenAddress)
    return result.priceUsd
  }

  // Detailed variant — exposed for tests/observability that want the real failure reason.
  // SIDE FIX (current-price resolver task): previously read `base_token_price_usd` from the most liquid
  // pool even when the requested token was that pool's QUOTE token — i.e. the OTHER token's price. Now
  // uses the same identity-checked selection as the canonical resolver (exact network, the token's own
  // side, positive price, reserve floor, strongest market).
  async getTokenPriceUsdDetailed(tokenAddress: string): Promise<GeckoTerminalPriceResult> {
    const r = await this.getTokenPools(tokenAddress)
    if (r.reason && r.pools.length === 0) return { priceUsd: null, reason: r.reason }
    const pick = selectGeckoTerminalPool(r.pools, tokenAddress, r.network)
    return pick.pool ? { priceUsd: pick.priceUsd, reason: null } : { priceUsd: null, reason: pick.reason }
  }
}

import { getOrFetchCached } from '@/lib/coingeckoCache'

export type MergedTrendingToken = {
  contract: string; symbol: string; name: string; chain: string; price: number | null; liquidity: number | null; volume: number | null; change24h: number | null; source: string
}
type GTPool = { relationships?: { base_token?: { data?: { id?: string } } }; attributes?: { base_token_price_usd?: number | string; reserve_in_usd?: number | string; volume_usd?: { h24?: number | string }; price_change_percentage?: { h24?: number | string } } }
type CGCoin = { item?: { id?: string; symbol?: string; name?: string; data?: { price?: number | string; total_volume?: number | null; price_change_percentage_24h?: { usd?: number | null } } } }

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number(value.trim().replace(/[$,\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

async function fetchGeckoTrending(): Promise<{ tokens: MergedTrendingToken[]; warning?: string }> {
  try {
    const result = await getOrFetchCached<{ data?: GTPool[]; included?: Array<{ id?: string; attributes?: { address?: string; symbol?: string; name?: string } }> }>({
      key: 'coingecko:trending-base', ttlMs: 60_000, onLog: message => console.info(`[trending] ${message}`),
      fetcher: async () => {
        const response = await fetch('https://api.geckoterminal.com/api/v2/networks/base/pools?page=1&include=base_token,quote_token', { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) throw new Error(`GeckoTerminal trending failed (${response.status})`)
        return response.json() as Promise<{ data?: GTPool[]; included?: Array<{ id?: string; attributes?: { address?: string; symbol?: string; name?: string } }> }>
      },
    })
    const included = Array.isArray(result.data?.included) ? result.data.included : []
    const tokens = (Array.isArray(result.data?.data) ? result.data.data : []).flatMap(pool => {
      const id = pool.relationships?.base_token?.data?.id
      const meta = id ? included.find(item => item.id === id)?.attributes : null
      if (!meta?.symbol) return []
      const attrs = pool.attributes
      const volume = numberOrNull(attrs?.volume_usd?.h24) ?? numberOrNull((attrs as { volume_usd?: unknown } | undefined)?.volume_usd)
      return [{ contract: meta.address ?? '', symbol: meta.symbol, name: meta.name ?? '', chain: 'base', price: numberOrNull(attrs?.base_token_price_usd), liquidity: numberOrNull(attrs?.reserve_in_usd), volume, change24h: numberOrNull(attrs?.price_change_percentage?.h24), source: 'geckoterminal' }]
    })
    return { tokens, warning: result.warning }
  } catch { return { tokens: [] } }
}

async function fetchCoinGeckoTrending(): Promise<{ tokens: MergedTrendingToken[]; warning?: string }> {
  try {
    const result = await getOrFetchCached<{ coins?: CGCoin[] }>({
      key: 'coingecko:trending-search', ttlMs: 120_000, onLog: message => console.info(`[trending] ${message}`),
      fetcher: async () => {
        const response = await fetch('https://api.coingecko.com/api/v3/search/trending', { cache: 'no-store' })
        if (!response.ok) throw new Error(`CoinGecko trending failed (${response.status})`)
        return response.json() as Promise<{ coins?: CGCoin[] }>
      },
    })
    const tokens = (Array.isArray(result.data?.coins) ? result.data.coins : []).map(coin => {
      const item = coin.item
      const rawPrice = item?.data?.price
      const price = typeof rawPrice === 'number' ? rawPrice : typeof rawPrice === 'string' ? Number.parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || null : null
      return { contract: item?.id ?? '', symbol: item?.symbol ?? '', name: item?.name ?? '', chain: 'coingecko', price, liquidity: null, volume: item?.data?.total_volume ?? null, change24h: item?.data?.price_change_percentage_24h?.usd ?? null, source: 'coingecko' }
    })
    return { tokens, warning: result.warning }
  } catch { return { tokens: [] } }
}

/** Shared server-side source for the token screener and Clark; never imported from a route file. */
export async function getMergedTrendingTokens(): Promise<{ data: MergedTrendingToken[]; warning?: string }> {
  const [gecko, coinGecko] = await Promise.all([fetchGeckoTrending(), fetchCoinGeckoTrending()])
  const bySymbol = [...gecko.tokens, ...coinGecko.tokens].reduce<Record<string, MergedTrendingToken>>((all, token) => {
    if (token.symbol && !all[token.symbol]) all[token.symbol] = token
    return all
  }, {})
  const data = Object.values(bySymbol).sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0) || (b.volume ?? 0) - (a.volume ?? 0))
  return { data, warning: gecko.warning ?? coinGecko.warning }
}

// COINGECKO BASE TRENDING, DISCLOSED (Clark AI "pumping vs Base Radar" follow-up).
//
// "What's pumping on Base" and "Base Radar" were conflated: both intents (correctly kept
// SEPARATE in lib/server/clarkRouting.ts's routing — see base_radar vs base_market_discovery)
// nonetheless resolved to the exact same underlying data source, getBaseMarketUniverse(), an
// internal GeckoTerminal-style POOL feed — the same feed the Base Radar page itself reads. A
// "what's pumping" question deserves an answer sourced independently of Base Radar's own feed,
// so the two questions can genuinely disagree instead of always echoing each other.
//
// This module adds that independent source: CoinGecko's public /coins/markets endpoint, filtered
// to the "base-ecosystem" category and sorted by 24h price change — real, third-party market data,
// not Base Radar's own pool index. Used as the PRIMARY source for the base_market_discovery
// intent in app/api/clark/route.ts; falls back to the existing getBaseMarketUniverse() path
// unchanged when this returns nothing (network failure, empty category, rate limit) — never a
// regression from today's behavior, only an upgrade when it succeeds.
//
// LIVE-VERIFICATION DISCLOSED: the "base-ecosystem" category slug is CoinGecko's own documented
// convention for chain-ecosystem categories, but has not been confirmed against a live response
// from this sandbox (outbound network to api.coingecko.com is not exercised here). Defensive by
// construction: any unexpected shape, empty result, or HTTP failure degrades to `ok: false`,
// never a crash, never fabricated tokens.

export type CoinGeckoBaseTrendingRow = {
  symbol: string | null
  name: string | null
  priceUsd: number | null
  change24h: number | null
  volume24hUsd: number | null
  marketCapUsd: number | null
  contract: string | null
}

export type CoinGeckoBaseTrendingResult =
  | { ok: true; rows: CoinGeckoBaseTrendingRow[] }
  | { ok: false; reason: string }

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'
export const LOW_CAP_MEME_MAX_MARKET_CAP_USD = 25_000_000

function parseMarketRows(json: unknown, changeField = 'price_change_percentage_24h'): CoinGeckoBaseTrendingRow[] {
  if (!Array.isArray(json)) return []
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return json.map((raw): CoinGeckoBaseTrendingRow | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    const symbol = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : null
    const name = typeof r.name === 'string' ? r.name : null
    if (!symbol && !name) return null
    return {
      symbol, name,
      priceUsd: num(r.current_price),
      change24h: num(r[changeField]),
      volume24hUsd: num(r.total_volume),
      marketCapUsd: num(r.market_cap),
      contract: null,
    }
  }).filter((r): r is CoinGeckoBaseTrendingRow => r != null)
}

export async function fetchCoinGeckoBaseTrending(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<CoinGeckoBaseTrendingResult> {
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&category=base-ecosystem&order=price_change_percentage_24h_desc&per_page=15&page=1&price_change_percentage=24h&sparkline=false`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } })
    if (!res.ok) return { ok: false, reason: `coingecko_http_${res.status}` }
    const json = await res.json().catch(() => null) as unknown
    if (!Array.isArray(json)) return { ok: false, reason: 'coingecko_unexpected_shape' }
    const rows = parseMarketRows(json)
    if (rows.length === 0) return { ok: false, reason: 'coingecko_empty_category' }
    return { ok: true, rows }
  } catch {
    return { ok: false, reason: 'coingecko_unreachable' }
  }
}

export async function fetchCoinGeckoBaseLowCapMemes(
  window: '24h' | '7d',
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<CoinGeckoBaseTrendingResult> {
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&category=base-meme-coins&order=volume_desc&per_page=100&page=1&price_change_percentage=24h%2C7d&sparkline=false`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } })
    if (!res.ok) return { ok: false, reason: `coingecko_http_${res.status}` }
    const json = await res.json().catch(() => null) as unknown
    if (!Array.isArray(json)) return { ok: false, reason: 'coingecko_unexpected_shape' }
    const changeField = window === '7d' ? 'price_change_percentage_7d_in_currency' : 'price_change_percentage_24h'
    const rows = parseMarketRows(json, changeField)
      .filter(row => row.marketCapUsd != null && row.marketCapUsd > 0 && row.marketCapUsd <= LOW_CAP_MEME_MAX_MARKET_CAP_USD)
      .filter(row => row.volume24hUsd != null && row.volume24hUsd > 0)
      .sort((a, b) => {
        const score = (row: CoinGeckoBaseTrendingRow) => Math.max(-20, row.change24h ?? -20) * 2 + Math.log10((row.volume24hUsd ?? 0) + 1) * 4
        return score(b) - score(a)
      })
      .slice(0, 10)
    return rows.length > 0 ? { ok: true, rows } : { ok: false, reason: 'no_verified_low_cap_base_memes' }
  } catch {
    return { ok: false, reason: 'coingecko_unreachable' }
  }
}

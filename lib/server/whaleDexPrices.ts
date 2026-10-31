// Base token prices from DexScreener, batched 30 addresses per request — the one lookup the Whale
// Alerts feed and the sync share. Only a Base pair whose BASE token is the address counts (a quote-side
// pair carries the other token's price), highest liquidity first. Cached 2 minutes per address.

const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens'
const CACHE_TTL_MS = 120_000
const cache = new Map<string, { expiresAt: number; priceUsd: number }>()

export function __resetWhaleDexPriceCacheForTest(): void { cache.clear() }

export async function fetchBaseDexScreenerPrices(addresses: readonly string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  const now = Date.now()
  const uncached: string[] = []
  for (const address of new Set(addresses.map((a) => a.toLowerCase()))) {
    const cached = cache.get(address)
    if (cached && cached.expiresAt > now) prices.set(address, cached.priceUsd)
    else uncached.push(address)
  }
  for (let i = 0; i < uncached.length; i += 30) {
    const chunk = uncached.slice(i, i + 30)
    try {
      const res = await fetchImpl(`${DEXSCREENER_TOKEN_URL}/${chunk.join(',')}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const json = await res.json().catch(() => null) as { pairs?: Array<Record<string, unknown>> } | null
      const best = new Map<string, { price: number; liq: number }>()
      for (const pair of Array.isArray(json?.pairs) ? json.pairs : []) {
        if ((typeof pair.chainId === 'string' ? pair.chainId.toLowerCase() : '') !== 'base') continue
        const baseAddr = (pair.baseToken as { address?: string } | undefined)?.address?.toLowerCase()
        if (!baseAddr || !chunk.includes(baseAddr)) continue
        const price = Number.parseFloat(String(pair.priceUsd ?? ''))
        if (!Number.isFinite(price) || price <= 0) continue
        const liq = Number((pair.liquidity as { usd?: number } | undefined)?.usd ?? 0)
        const prev = best.get(baseAddr)
        if (!prev || liq >= prev.liq) best.set(baseAddr, { price, liq: Number.isFinite(liq) ? liq : 0 })
      }
      for (const [addr, v] of best) {
        prices.set(addr, v.price)
        cache.set(addr, { expiresAt: now + CACHE_TTL_MS, priceUsd: v.price })
      }
    } catch {
      // A miss stays unpriced; the feed's own fallbacks run later.
    }
  }
  return prices
}

// Fixture harness: drives the REAL /api/radar GET handler with a mocked global fetch. No network, no
// Redis (unconfigured → in-memory paths), no Supabase (trusted cron header bypasses the plan gate).
// Each provider call is recorded so tests can assert call counts and failure classes.

process.env.BASE_RADAR_CRON_SECRET = 'radar-harness-secret'
process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.ALCHEMY_ROBINHOOD_RPC_URL = 'http://robinhood-rpc.invalid/v2/key'
process.env.GOLDRUSH_API_KEY = 'harness-goldrush'
delete process.env.ANTHROPIC_API_KEY
delete process.env.KV_REST_API_URL
delete process.env.UPSTASH_REDIS_REST_URL

export type ProviderCall = { url: string; host: string; kind: string }
export type GtBehaviour = 'ok' | 'empty' | 'r429' | 'r500' | 'timeout' | 'network'
export type Scenario = {
  /** Per GeckoTerminal list source ('new_pools' | 'trending_pools' | 'pools') → behaviour. Default ok. */
  gt?: Partial<Record<'new_pools' | 'trending_pools' | 'pools', GtBehaviour>>
  /** Pools returned by OK GT list pages, keyed by source. */
  gtPools?: Partial<Record<'new_pools' | 'trending_pools' | 'pools', Array<ReturnType<typeof gtPool>>>>
  /** DexScreener pairs returned by /latest/dex/tokens/... (already in DS shape). */
  dsPairs?: Record<string, unknown>[]
  /** DexScreener boost/profile list entries. */
  dsLists?: Record<string, unknown>[]
  /** Blockscout PoolManager logs (Blockscout shape). */
  blockscoutLogs?: Record<string, unknown>[]
  holders?: number
}

const ADDR = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(20)}`
export const tokenAddr = ADDR
export function gtPool(n: number, chain: string, over: Record<string, unknown> = {}) {
  const addr = ADDR(n)
  return {
    pool: {
      id: `${chain}_0x${'p'.charCodeAt(0).toString(16)}${n.toString(16).padStart(38, '0')}`,
      type: 'pool',
      attributes: {
        address: `0x${n.toString(16).padStart(40, 'a')}`,
        name: `TK${n} / WETH`,
        base_token_price_usd: '0.0015',
        reserve_in_usd: '150000',
        fdv_usd: '900000',
        market_cap_usd: '600000',
        pool_created_at: new Date(Date.now() - (2 + n) * 3600_000).toISOString(),
        volume_usd: { h24: '220000', h6: '60000', h1: '9000' },
        price_change_percentage: { h24: '12', h6: '3', h1: '1' },
        transactions: { h24: { buys: 400, sells: 380, buyers: 220, sellers: 200 } },
        ...over,
      },
      relationships: {
        base_token: { data: { id: `${chain}_${addr}`, type: 'token' } },
        quote_token: { data: { id: `${chain}_0x4200000000000000000000000000000000000006`, type: 'token' } },
        dex: { data: { id: 'uniswap-v4', type: 'dex' } },
      },
    },
    included: [
      { id: `${chain}_${addr}`, type: 'token', attributes: { address: addr, name: `Token ${n}`, symbol: `TK${n}` } },
      { id: `${chain}_0x4200000000000000000000000000000000000006`, type: 'token', attributes: { address: '0x4200000000000000000000000000000000000006', name: 'Wrapped Ether', symbol: 'WETH' } },
    ],
  }
}

export function dsPair(n: number, chainId: string, over: Record<string, unknown> = {}) {
  return {
    chainId, dexId: 'uniswap', pairAddress: `0x${n.toString(16).padStart(40, 'b')}`,
    baseToken: { address: ADDR(n), name: `Token ${n}`, symbol: `TK${n}` },
    quoteToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
    priceUsd: '0.0015', liquidity: { usd: 150000 }, fdv: 900000, marketCap: 600000,
    volume: { h24: 220000 }, priceChange: { h24: 12, h6: 3, h1: 1 }, pairCreatedAt: Date.now() - 5 * 3600_000,
    ...over,
  }
}

export const calls: ProviderCall[] = []
let scenario: Scenario = {}
export function setScenario(s: Scenario) { scenario = s }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const u = new URL(url)
  const kind = u.host.includes('geckoterminal') ? 'gt'
    : u.host.includes('dexscreener') ? 'ds'
      : u.host.includes('covalenthq') ? 'goldrush'
        : u.host.includes('blockscout') ? 'blockscout'
          : u.host.includes('robinhood-rpc') ? 'rpc'
            : u.host.includes('honeypot') ? 'honeypot' : 'other'
  calls.push({ url, host: u.host, kind })
  if (kind === 'gt') {
    const m = u.pathname.match(/\/networks\/([^/]+)\/(new_pools|trending_pools|pools)$/)
    if (m) {
      const source = m[2] as 'new_pools' | 'trending_pools' | 'pools'
      const behaviour = scenario.gt?.[source] ?? 'ok'
      if (behaviour === 'r429') return json({ errors: [{ status: '429' }] }, 429)
      if (behaviour === 'r500') return json({ errors: [{ status: '500' }] }, 500)
      if (behaviour === 'network') throw new TypeError('fetch failed')
      if (behaviour === 'timeout') {
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal
          const err = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e) }
          if (signal?.aborted) return err()
          signal?.addEventListener('abort', err)
        })
      }
      const page = Number(u.searchParams.get('page') ?? '1')
      const list = behaviour === 'empty' || page > 1 ? [] : (scenario.gtPools?.[source] ?? [])
      return json({ data: list.map(p => p.pool), included: list.flatMap(p => p.included) })
    }
    // token → pools lookups (DexScreener supplementary): empty
    return json({ data: [], included: [] })
  }
  if (kind === 'ds') {
    if (u.pathname.includes('token-profiles') || u.pathname.includes('token-boosts')) return json(scenario.dsLists ?? [])
    if (u.pathname.includes('/latest/dex/tokens/') || u.pathname.startsWith('/tokens/v1/')) {
      const wanted = new Set(decodeURIComponent(u.pathname.split('/').pop() ?? '').toLowerCase().split(','))
      const pairs = (scenario.dsPairs ?? []).filter(p => wanted.has(String((p.baseToken as { address: string }).address).toLowerCase()))
      return u.pathname.startsWith('/tokens/v1/') ? json(pairs) : json({ pairs })
    }
    return json({ pairs: [] })
  }
  if (kind === 'goldrush') return json({ data: { items: [], pagination: { total_count: scenario.holders ?? 250 } } })
  if (kind === 'blockscout') {
    if (u.pathname.endsWith('/logs')) return json({ items: scenario.blockscoutLogs ?? [], next_page_params: null })
    return json({})
  }
  if (kind === 'rpc') return json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'harness rpc unavailable' } })
  return json({}, 404)
}) as typeof fetch
export function restoreFetch() { globalThis.fetch = realFetch }

let ip = 0
export async function callRadar(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { NextRequest } = await import('next/server')
  const { GET } = await import('../../app/api/radar/route')
  const req = new NextRequest(`http://localhost/api/radar?${query}`, {
    headers: { 'x-base-radar-cron-secret': 'radar-harness-secret', 'x-forwarded-for': `10.0.0.${++ip}` },
  })
  const res = await GET(req)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
export function resetCalls() { calls.length = 0 }
export function countCalls(kind: string) { return calls.filter(c => c.kind === kind).length }

// Server-only — reads MORALIS_API_KEY from server env. No NEXT_PUBLIC usage.

type MoralisHolding = {
  contract?: string
  name: string
  symbol: string
  icon: string | null
  chain: string | null
  balance: number
  value: number
  price: number | null
  change24h: null
  verified: boolean
}

export type MoralisFetchResult = {
  holdings: MoralisHolding[]
  attempted: boolean
  usable: boolean
  cacheHit: boolean
  reason: string
  httpStatus?: number | null
}

const MORALIS_TTL_MS = 10 * 60 * 1000
const _cache = new Map<string, { holdings: MoralisHolding[]; cachedAt: number }>()
const _inflight = new Map<string, Promise<MoralisFetchResult>>()

const NOT_NEEDED: MoralisFetchResult = { holdings: [], attempted: false, usable: false, cacheHit: false, reason: 'not_needed' }

export type MoralisChain = 'eth' | 'base' | 'polygon' | 'bsc' | 'arbitrum' | 'optimism' | 'avalanche' | 'fantom' | 'cronos' | 'gnosis'

// Moralis chain identifiers
// Some chains use hex identifiers per Moralis v2.2 token balances API.
const CHAIN_PARAM: Record<MoralisChain, string> = {
  eth: 'eth',
  base: '0x2105',
  polygon: 'polygon',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  avalanche: 'avalanche',
  fantom: 'fantom',
  cronos: 'cronos',
  gnosis: 'gnosis',
}

export async function fetchMoralisBalances(
  address: string,
  chain: MoralisChain,
): Promise<MoralisFetchResult> {
  const apiKey = process.env.MORALIS_API_KEY ?? ''
  if (!apiKey) return { ...NOT_NEEDED, reason: 'not_configured' }

  const cacheKey = `moralis:${chain}:${address.toLowerCase()}`
  const hit = _cache.get(cacheKey)
  if (hit && Date.now() - hit.cachedAt <= MORALIS_TTL_MS) {
    return {
      holdings: hit.holdings,
      attempted: false,
      usable: true,
      cacheHit: true,
      reason: hit.holdings.length > 0 ? '' : 'no_priced_holdings',
    }
  }

  const url =
    `https://deep-index.moralis.io/api/v2.2/${address}/erc20` +
    `?chain=${CHAIN_PARAM[chain]}&exclude_spam=true`

  const inFlight = _inflight.get(cacheKey)
  if (inFlight) return inFlight

  const run = (async (): Promise<MoralisFetchResult> => {
  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    })

    if (!res.ok) {
      return {
        holdings: [],
        attempted: true,
        usable: false,
        cacheHit: false,
        reason: `http_${res.status}`,
        httpStatus: res.status,
      }
    }

    const json: unknown = await res.json()
    const raw = json as Record<string, unknown> | null
    const items: unknown[] = Array.isArray(json)
      ? json
      : Array.isArray(raw?.result)
      ? (raw!.result as unknown[])
      : []

    const chainShort = chain
    const holdings: MoralisHolding[] = items
      .map((item) => {
        const it = item as Record<string, unknown>
        const rawDec = it.decimals
        const decimals =
          typeof rawDec === 'number'
            ? rawDec
            : Number.parseInt(String(rawDec ?? '18'), 10)
        const balance =
          parseFloat(String(it.balance ?? '0')) /
          Math.pow(10, Number.isFinite(decimals) ? decimals : 18)
        const value = typeof it.usd_value === 'number' ? it.usd_value : 0
        const price =
          typeof it.usd_price === 'number' && it.usd_price > 0
            ? it.usd_price
            : null
        const icon =
          typeof it.thumbnail === 'string' &&
          (it.thumbnail as string).startsWith('http')
            ? (it.thumbnail as string)
            : null
        const contract =
          typeof it.token_address === 'string'
            ? (it.token_address as string).toLowerCase()
            : undefined
        return {
          contract,
          name: typeof it.name === 'string' ? (it.name as string) : 'Unknown',
          symbol: typeof it.symbol === 'string' ? (it.symbol as string) : '?',
          icon,
          chain: chainShort,
          balance,
          value,
          price,
          change24h: null,
          verified: it.verified_contract === true || it.possible_spam === false,
        } satisfies MoralisHolding
      })
      .filter((h) => h.value > 0.01)

    _cache.set(cacheKey, { holdings, cachedAt: Date.now() })
    return {
      holdings,
      attempted: true,
      usable: true,
      cacheHit: false,
      reason: holdings.length > 0 ? '' : 'no_priced_holdings',
      httpStatus: res.status,
    }
  } catch {
    return {
      holdings: [],
      attempted: true,
      usable: false,
      cacheHit: false,
      reason: 'fetch_failed',
    }
  }} )()
  _inflight.set(cacheKey, run)
  try { return await run } finally { _inflight.delete(cacheKey) }
}

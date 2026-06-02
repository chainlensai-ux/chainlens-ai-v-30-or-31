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

// ── ERC20 Transfer History ─────────────────────────────────────────────────

export type MoralisTransferItem = {
  from_address: string | null
  to_address: string | null
  token_address: string | null   // resolved from address|token_address|tokenAddress
  value: string | null           // raw integer string (needs /10^decimals)
  value_decimal: string | null   // pre-formatted decimal value (preferred for amount)
  transaction_hash: string | null
  block_timestamp: string | null
  token_name: string | null
  token_symbol: string | null
  token_decimals: string | null
  possible_spam: boolean | null
}

export type MoralisTransferFetchResult = {
  items: MoralisTransferItem[]
  rawSample: unknown[]           // up to 3 raw API rows for debug shape inspection
  nextCursor: string | null      // Moralis cursor for next page (null = no more pages)
  attempted: boolean
  usable: boolean
  cacheHit: boolean
  rawCount: number
  reason: string
  httpStatus?: number | null
}

const MORALIS_TRANSFERS_TTL_MS = 5 * 60 * 1000
const _transfersCache = new Map<string, { items: MoralisTransferItem[]; nextCursor: string | null; cachedAt: number }>()
const _transfersInFlight = new Map<string, Promise<MoralisTransferFetchResult>>()

export async function fetchMoralisTransfers(
  address: string,
  chain: MoralisChain,
  limit = 100,
  cursor?: string,
): Promise<MoralisTransferFetchResult> {
  const apiKey = process.env.MORALIS_API_KEY ?? ''
  if (!apiKey) return { items: [], rawSample: [], nextCursor: null, attempted: false, usable: false, cacheHit: false, rawCount: 0, reason: 'not_configured' }

  const cacheKey = `moralis:transfers:${chain}:${address.toLowerCase()}:${limit}:${cursor ?? 'p1'}`
  const hit = _transfersCache.get(cacheKey)
  if (hit && Date.now() - hit.cachedAt <= MORALIS_TRANSFERS_TTL_MS) {
    return { items: hit.items, rawSample: [], nextCursor: hit.nextCursor, attempted: false, usable: true, cacheHit: true, rawCount: hit.items.length, reason: hit.items.length > 0 ? '' : 'cached_empty' }
  }

  const inflight = _transfersInFlight.get(cacheKey)
  if (inflight) return inflight

  const url = `https://deep-index.moralis.io/api/v2.2/${address}/erc20/transfers?chain=${CHAIN_PARAM[chain]}&limit=${limit}&exclude_spam=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`

  const run = (async (): Promise<MoralisTransferFetchResult> => {
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) {
        return { items: [], rawSample: [], nextCursor: null, attempted: true, usable: false, cacheHit: false, rawCount: 0, reason: `http_${res.status}`, httpStatus: res.status }
      }
      const json: unknown = await res.json()
      const raw = json as Record<string, unknown> | null
      const rawItems: unknown[] = Array.isArray(raw?.result) ? (raw!.result as unknown[]) : Array.isArray(json) ? (json as unknown[]) : []
      const rawSample = rawItems.slice(0, 3)
      const nextCursor = typeof raw?.cursor === 'string' && raw.cursor ? raw.cursor : null
      const items: MoralisTransferItem[] = rawItems.map((it) => {
        const i = it as Record<string, unknown>
        // Moralis ERC20 transfers v2.2 uses 'address' for the token contract, not 'token_address'
        const tokenAddr =
          typeof i.token_address === 'string' ? i.token_address :
          typeof i.address === 'string' ? i.address :
          typeof i.tokenAddress === 'string' ? i.tokenAddress : null
        const txHash =
          typeof i.transaction_hash === 'string' ? i.transaction_hash :
          typeof i.transactionHash === 'string' ? i.transactionHash :
          typeof i.tx_hash === 'string' ? i.tx_hash : null
        const blockTs =
          typeof i.block_timestamp === 'string' ? i.block_timestamp :
          typeof i.blockTimestamp === 'string' ? i.blockTimestamp : null
        const fromAddr =
          typeof i.from_address === 'string' ? i.from_address :
          typeof i.fromAddress === 'string' ? i.fromAddress : null
        const toAddr =
          typeof i.to_address === 'string' ? i.to_address :
          typeof i.toAddress === 'string' ? i.toAddress : null
        const rawValue =
          typeof i.value === 'string' ? i.value :
          typeof i.value === 'number' ? String(i.value) : null
        const valueDecimal =
          typeof i.value_decimal === 'string' ? i.value_decimal :
          typeof i.value_formatted === 'string' ? i.value_formatted : null
        const tokenDec =
          typeof i.token_decimals === 'string' ? i.token_decimals :
          typeof i.decimals === 'string' ? i.decimals :
          typeof i.token_decimals === 'number' ? String(i.token_decimals) :
          typeof i.decimals === 'number' ? String(i.decimals) : null
        const tokenSym =
          typeof i.token_symbol === 'string' ? i.token_symbol :
          typeof i.symbol === 'string' ? i.symbol : null
        const tokenName =
          typeof i.token_name === 'string' ? i.token_name :
          typeof i.name === 'string' ? i.name : null
        const possibleSpam = typeof i.possible_spam === 'boolean' ? i.possible_spam : null
        return {
          from_address: fromAddr,
          to_address: toAddr,
          token_address: tokenAddr,
          value: rawValue,
          value_decimal: valueDecimal,
          transaction_hash: txHash,
          block_timestamp: blockTs,
          token_name: tokenName,
          token_symbol: tokenSym,
          token_decimals: tokenDec,
          possible_spam: possibleSpam,
        }
      })
      _transfersCache.set(cacheKey, { items, nextCursor, cachedAt: Date.now() })
      return { items, rawSample, nextCursor, attempted: true, usable: true, cacheHit: false, rawCount: items.length, reason: items.length > 0 ? '' : 'no_transfers', httpStatus: res.status }
    } catch {
      return { items: [], rawSample: [], nextCursor: null, attempted: true, usable: false, cacheHit: false, rawCount: 0, reason: 'fetch_failed' }
    }
  })()

  _transfersInFlight.set(cacheKey, run)
  try { return await run } finally { _transfersInFlight.delete(cacheKey) }
}

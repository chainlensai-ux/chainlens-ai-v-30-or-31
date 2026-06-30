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

export function moralisChainFromAny(chain: string | null | undefined): MoralisChain | null {
  const c = (chain ?? '').toLowerCase()
  if (c === 'eth' || c === 'ethereum' || c === 'eth-mainnet' || c === '1') return 'eth'
  if (c === 'base' || c === 'base-mainnet' || c === '8453' || c === '0x2105') return 'base'
  if (c === 'polygon' || c === 'matic' || c === '137') return 'polygon'
  if (c === 'bsc' || c === 'bnb' || c === '56' || c.includes('binance')) return 'bsc'
  if (c === 'arbitrum' || c === 'arb' || c === '42161') return 'arbitrum'
  if (c === 'optimism' || c === 'op' || c === '10') return 'optimism'
  if (c === 'avalanche' || c === 'avax' || c === '43114') return 'avalanche'
  if (c === 'fantom' || c === 'ftm' || c === '250') return 'fantom'
  if (c === 'cronos' || c === '25') return 'cronos'
  if (c === 'gnosis' || c === 'xdai' || c === '100') return 'gnosis'
  return null
}

export type MoralisHistoricalPriceResult = {
  priceUsd: number | null
  attempted: boolean
  usable: boolean
  cacheHit: boolean
  reason: string
  httpStatus?: number | null
}

const MORALIS_PRICE_TTL_MS = 30 * 60 * 1000
const _priceCache = new Map<string, { priceUsd: number | null; cachedAt: number }>()
const _priceInflight = new Map<string, Promise<MoralisHistoricalPriceResult>>()

export async function fetchMoralisHistoricalTokenPrice(
  contractAddress: string,
  chainLike: string,
  timestamp: string,
): Promise<MoralisHistoricalPriceResult> {
  const apiKey = process.env.MORALIS_API_KEY ?? ''
  if (!apiKey) return { priceUsd: null, attempted: false, usable: false, cacheHit: false, reason: 'not_configured' }
  const chain = moralisChainFromAny(chainLike)
  if (!chain) return { priceUsd: null, attempted: false, usable: false, cacheHit: false, reason: 'unsupported_chain' }
  const contract = (contractAddress ?? '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(contract)) return { priceUsd: null, attempted: false, usable: false, cacheHit: false, reason: 'invalid_contract' }
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return { priceUsd: null, attempted: false, usable: false, cacheHit: false, reason: 'invalid_timestamp' }
  const toDate = date.toISOString()
  const day = toDate.slice(0, 10)
  const cacheKey = `moralis:price:${chain}:${contract}:${day}`
  const hit = _priceCache.get(cacheKey)
  if (hit && Date.now() - hit.cachedAt <= MORALIS_PRICE_TTL_MS) {
    return { priceUsd: hit.priceUsd, attempted: false, usable: hit.priceUsd != null, cacheHit: true, reason: hit.priceUsd != null ? '' : 'cached_empty' }
  }
  const inflight = _priceInflight.get(cacheKey)
  if (inflight) return inflight

  const url = `https://deep-index.moralis.io/api/v2.2/erc20/${contract}/price?chain=${CHAIN_PARAM[chain]}&to_date=${encodeURIComponent(toDate)}`
  const run = (async (): Promise<MoralisHistoricalPriceResult> => {
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) {
        _priceCache.set(cacheKey, { priceUsd: null, cachedAt: Date.now() })
        return { priceUsd: null, attempted: true, usable: false, cacheHit: false, reason: `http_${res.status}`, httpStatus: res.status }
      }
      const json = await res.json() as Record<string, unknown>
      const raw =
        typeof json.usdPrice === 'number' ? json.usdPrice :
        typeof json.usd_price === 'number' ? json.usd_price :
        typeof json.priceUsd === 'number' ? json.priceUsd :
        typeof json.price_usd === 'number' ? json.price_usd :
        null
      const priceUsd = raw != null && Number.isFinite(raw) && raw > 1e-12 ? raw : null
      _priceCache.set(cacheKey, { priceUsd, cachedAt: Date.now() })
      return { priceUsd, attempted: true, usable: priceUsd != null, cacheHit: false, reason: priceUsd != null ? '' : 'no_price', httpStatus: res.status }
    } catch {
      _priceCache.set(cacheKey, { priceUsd: null, cachedAt: Date.now() })
      return { priceUsd: null, attempted: true, usable: false, cacheHit: false, reason: 'fetch_failed' }
    }
  })()
  _priceInflight.set(cacheKey, run)
  try { return await run } finally { _priceInflight.delete(cacheKey) }
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

// ── Wallet Profitability Summary (provider-level realized PnL, not lot-level) ──
export type MoralisProfitabilitySummary = {
  totalTrades: number
  totalBuys: number
  totalSells: number
  totalTradeVolumeUsd: number
  totalBoughtVolumeUsd: number
  totalSoldVolumeUsd: number
  realizedPnlUsd: number
  realizedPnlPercent: number
}

export function parseNumberish(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const numberishOrZero = (v: unknown): number => parseNumberish(v) ?? 0

const pickNumberish = (raw: Record<string, unknown>, snakeKey: string, camelKey: string): number => {
  const snake = parseNumberish(raw[snakeKey])
  if (snake !== null) return snake
  return numberishOrZero(raw[camelKey])
}

export function parseMoralisProfitabilitySummary(rawInput: unknown): MoralisProfitabilitySummary {
  const raw = (rawInput ?? {}) as Record<string, unknown>
  return {
    totalTrades: pickNumberish(raw, 'total_count_of_trades', 'totalCountOfTrades'),
    totalBuys: pickNumberish(raw, 'total_buys', 'totalBuys'),
    totalSells: pickNumberish(raw, 'total_sells', 'totalSells'),
    totalTradeVolumeUsd: pickNumberish(raw, 'total_trade_volume', 'totalTradeVolume'),
    totalBoughtVolumeUsd: pickNumberish(raw, 'total_bought_volume_usd', 'totalBoughtVolumeUsd'),
    totalSoldVolumeUsd: pickNumberish(raw, 'total_sold_volume_usd', 'totalSoldVolumeUsd'),
    realizedPnlUsd: pickNumberish(raw, 'total_realized_profit_usd', 'totalRealizedProfitUsd'),
    realizedPnlPercent: pickNumberish(raw, 'total_realized_profit_percentage', 'totalRealizedProfitPercentage'),
  }
}

export function isUsableProviderPnlSummary(summary: MoralisProfitabilitySummary | null | undefined): summary is MoralisProfitabilitySummary {
  if (!summary || summary.totalTrades <= 0) return false
  return Math.abs(summary.realizedPnlUsd) > 0.01
    || summary.totalTradeVolumeUsd > 1
    || summary.totalBoughtVolumeUsd > 1
    || summary.totalSoldVolumeUsd > 1
}

export type MoralisProfitabilityFetchResult = {
  summary: MoralisProfitabilitySummary | null
  attempted: boolean
  usable: boolean
  cacheHit: boolean
  reason: string
  httpStatus?: number | null
}

const MORALIS_PROFITABILITY_TTL_MS = 30 * 60 * 1000
const _profitabilityCache = new Map<string, { summary: MoralisProfitabilitySummary; cachedAt: number }>()
const _profitabilityInFlight = new Map<string, Promise<MoralisProfitabilityFetchResult>>()

export async function fetchMoralisProfitabilitySummary(
  address: string,
  chain: MoralisChain,
  timeframe: 'all' | '7' | '30' | '60' | '90' = 'all',
): Promise<MoralisProfitabilityFetchResult> {
  const apiKey = process.env.MORALIS_API_KEY ?? ''
  if (!apiKey) return { summary: null, attempted: false, usable: false, cacheHit: false, reason: 'not_configured' }

  const cacheKey = `moralis:profitability:${chain}:${address.toLowerCase()}:${timeframe}`
  const hit = _profitabilityCache.get(cacheKey)
  if (hit && Date.now() - hit.cachedAt <= MORALIS_PROFITABILITY_TTL_MS) {
    return { summary: hit.summary, attempted: false, usable: isUsableProviderPnlSummary(hit.summary), cacheHit: true, reason: '' }
  }

  const inflight = _profitabilityInFlight.get(cacheKey)
  if (inflight) return inflight

  const url = `https://deep-index.moralis.io/api/v2.2/wallets/${address}/profitability/summary?chain=${CHAIN_PARAM[chain]}&days=${timeframe}`

  const run = (async (): Promise<MoralisProfitabilityFetchResult> => {
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(6_000),
      })
      if (!res.ok) {
        return { summary: null, attempted: true, usable: false, cacheHit: false, reason: `http_${res.status}`, httpStatus: res.status }
      }
      const json: unknown = await res.json()
      const summary = parseMoralisProfitabilitySummary(json)
      _profitabilityCache.set(cacheKey, { summary, cachedAt: Date.now() })
      return { summary, attempted: true, usable: isUsableProviderPnlSummary(summary), cacheHit: false, reason: isUsableProviderPnlSummary(summary) ? '' : 'economically_unusable', httpStatus: res.status }
    } catch {
      return { summary: null, attempted: true, usable: false, cacheHit: false, reason: 'fetch_failed' }
    }
  })()

  _profitabilityInFlight.set(cacheKey, run)
  try { return await run } finally { _profitabilityInFlight.delete(cacheKey) }
}

// ── Paginated ERC20 Transfer History (deep/recovery scans only) ────────────
// MORALIS-PAGINATION-1: loops fetchMoralisTransfers() following its cursor, bounded by an event
// cap (default 500-1500, never 5000 unless admin/debug) and a page cap, so a deep/recovery scan
// can pull real multi-page history without ever making an unbounded number of calls. Never throws
// — any failure mid-loop returns the events collected so far with a structured stoppedReason so
// the caller can fall back to GoldRush.
export type MoralisPaginatedResult = {
  events: MoralisTransferItem[]
  pagesUsed: number
  eventsFetched: number
  stoppedReason: 'cursor_null' | 'event_cap' | 'page_cap' | 'budget_cap' | 'fetch_failed' | 'not_configured'
  durationMs: number
  error: string | null
}

export async function fetchMoralisTransfersPaginated(
  address: string,
  chain: MoralisChain,
  opts?: { maxEvents?: number; maxPages?: number; pageSize?: number; adminOverride?: boolean },
): Promise<MoralisPaginatedResult> {
  const start = Date.now()
  const apiKey = process.env.MORALIS_API_KEY ?? ''
  if (!apiKey) {
    return { events: [], pagesUsed: 0, eventsFetched: 0, stoppedReason: 'not_configured', durationMs: Date.now() - start, error: null }
  }

  const adminOverride = opts?.adminOverride === true
  // Hard safety: never exceed 5000 events unless an explicit admin/debug override is passed.
  const requestedMaxEvents = opts?.maxEvents ?? 1000
  const maxEvents = adminOverride ? Math.min(5000, Math.max(1, requestedMaxEvents)) : Math.min(1500, Math.max(500, requestedMaxEvents))
  const maxPages = Math.min(adminOverride ? 50 : 15, Math.max(1, opts?.maxPages ?? 10))
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 100))

  const events: MoralisTransferItem[] = []
  let cursor: string | undefined
  let pagesUsed = 0
  let stoppedReason: MoralisPaginatedResult['stoppedReason'] = 'cursor_null'
  let error: string | null = null

  while (pagesUsed < maxPages) {
    let page: MoralisTransferFetchResult
    try {
      page = await fetchMoralisTransfers(address, chain, pageSize, cursor)
    } catch (e) {
      error = e instanceof Error ? e.message : 'fetch_failed'
      stoppedReason = 'fetch_failed'
      break
    }
    pagesUsed++
    if (!page.usable) {
      error = page.reason || 'fetch_failed'
      stoppedReason = 'fetch_failed'
      break
    }
    events.push(...page.items)
    if (events.length >= maxEvents) { stoppedReason = 'event_cap'; break }
    if (!page.nextCursor) { stoppedReason = 'cursor_null'; break }
    cursor = page.nextCursor
    if (pagesUsed >= maxPages) { stoppedReason = 'page_cap'; break }
  }

  const trimmed = events.length > maxEvents ? events.slice(0, maxEvents) : events
  return {
    events: trimmed,
    pagesUsed,
    eventsFetched: trimmed.length,
    stoppedReason,
    durationMs: Date.now() - start,
    error,
  }
}

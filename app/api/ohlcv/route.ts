import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const GT = 'https://api.geckoterminal.com/api/v2'
const GT_HEADERS = { accept: 'application/json' }

type ChainKey = 'base' | 'eth'
type Interval = '1h' | '6h' | '24h'
type GTPool = {
  id?: string
  attributes?: { reserve_in_usd?: string | number | null; name?: string | null }
  relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } }
}

type OhlcvPoint = { timestamp: number; open: number; high: number; low: number; close: number; volume: number | null }

const NETWORK: Record<ChainKey, string> = { base: 'base', eth: 'eth' }
const EMPTY = { timestamps: [] as number[], open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[], points: [] as OhlcvPoint[] }

function normalizeChain(raw: string | null): ChainKey {
  return raw === 'eth' || raw === 'ethereum' ? 'eth' : 'base'
}

function normalizeInterval(raw: string | null): Interval {
  return raw === '1h' || raw === '6h' || raw === '24h' ? raw : '24h'
}

function idToAddress(id: string | undefined): string | null {
  if (!id) return null
  const idx = id.indexOf('_')
  const address = idx === -1 ? id : id.slice(idx + 1)
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? address : null
}

function toNum(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

async function fetchPrimaryPool(address: string, chain: ChainKey): Promise<{ poolAddress: string; tokenSide: 'base' | 'quote' } | null> {
  const network = NETWORK[chain]
  let res: Response
  try {
    res = await fetch(`${GT}/networks/${network}/tokens/${address}/pools?include=base_token,quote_token,dex`, {
      headers: GT_HEADERS,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const json = await res.json().catch(() => null) as { data?: GTPool[] } | null
  const pools = Array.isArray(json?.data) ? json.data : []
  if (pools.length === 0) return null

  const lower = address.toLowerCase()
  const sorted = [...pools].sort((a, b) => (toNum(b.attributes?.reserve_in_usd) ?? 0) - (toNum(a.attributes?.reserve_in_usd) ?? 0))
  const selected = sorted[0]
  const poolAddress = idToAddress(selected.id)
  if (!poolAddress) return null

  const baseAddress = idToAddress(selected.relationships?.base_token?.data?.id)?.toLowerCase()
  const quoteAddress = idToAddress(selected.relationships?.quote_token?.data?.id)?.toLowerCase()
  const tokenSide: 'base' | 'quote' = quoteAddress === lower && baseAddress !== lower ? 'quote' : 'base'
  return { poolAddress, tokenSide }
}

async function fetchGtOhlcv(poolAddress: string, tokenSide: 'base' | 'quote', chain: ChainKey, interval: Interval): Promise<OhlcvPoint[]> {
  const network = NETWORK[chain]
  const config: Record<Interval, { timeframe: 'hour' | 'day'; aggregate: number; limit: number }> = {
    '1h': { timeframe: 'hour', aggregate: 1, limit: 24 },
    '6h': { timeframe: 'hour', aggregate: 6, limit: 28 },
    '24h': { timeframe: 'day', aggregate: 1, limit: 30 },
  }
  const { timeframe, aggregate, limit } = config[interval]
  const qs = new URLSearchParams({ aggregate: String(aggregate), limit: String(limit), currency: 'usd', token: tokenSide })
  let res: Response
  try {
    res = await fetch(`${GT}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?${qs.toString()}`, {
      headers: GT_HEADERS,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return []
  }
  if (!res.ok) return []
  const json = await res.json().catch(() => null) as { data?: { attributes?: { ohlcv_list?: unknown[] } } } | null
  const rows = Array.isArray(json?.data?.attributes?.ohlcv_list) ? json.data.attributes.ohlcv_list : []
  return rows
    .map((row) => {
      if (!Array.isArray(row)) return null
      const timestamp = toNum(row[0])
      const open = toNum(row[1])
      const high = toNum(row[2])
      const low = toNum(row[3])
      const close = toNum(row[4])
      const volumeValue = toNum(row[5])
      if (timestamp == null || open == null || high == null || low == null || close == null) return null
      return { timestamp, open, high, low, close, volume: volumeValue }
    })
    .filter((point): point is OhlcvPoint => point !== null)
    .sort((a, b) => a.timestamp - b.timestamp)
}

function shape(points: OhlcvPoint[], interval: Interval, source: string, reason: string | null) {
  return {
    timestamps: points.map((p) => p.timestamp),
    open: points.map((p) => p.open),
    high: points.map((p) => p.high),
    low: points.map((p) => p.low),
    close: points.map((p) => p.close),
    volume: points.map((p) => p.volume ?? 0),
    points,
    timeframe: interval,
    source,
    status: points.length > 0 ? 'ok' : 'partial',
    reason,
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const address = url.searchParams.get('address') ?? url.searchParams.get('contract') ?? ''
  const chain = normalizeChain(url.searchParams.get('chain'))
  const interval = normalizeInterval(url.searchParams.get('interval') ?? url.searchParams.get('timeframe'))

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid or missing address parameter.' }, { status: 400 })
  }

  const pool = await fetchPrimaryPool(address, chain)
  if (!pool) return NextResponse.json({ ...EMPTY, timeframe: interval, source: 'geckoterminal', status: 'partial', reason: 'no_geckoterminal_pool' })

  const points = await fetchGtOhlcv(pool.poolAddress, pool.tokenSide, chain, interval)
  return NextResponse.json(shape(points, interval, 'geckoterminal', points.length > 0 ? null : 'empty_geckoterminal_ohlcv'))
}

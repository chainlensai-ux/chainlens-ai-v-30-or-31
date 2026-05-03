import { NextResponse } from 'next/server'
import { getOrFetchCached } from '@/lib/coingeckoCache'

export const dynamic = 'force-dynamic'

const EXCLUDED = new Set([
  'USDC', 'USDT', 'DAI', 'USDBC', 'WETH', 'ETH', 'CBBTC', 'BTC', 'WBTC',
  'BUSD', 'FRAX', 'CBETH', 'STETH', 'RETH', 'WSTETH', 'EURC', 'BSDETH', 'USD+', 'AXLUSDC',
])

export type PumpCategory = 'HIGH_MOMENTUM' | 'VOLUME_EXPANSION' | 'THIN_MOONSHOT' | 'WATCH'
export type PumpRisk = 'HIGH' | 'MEDIUM' | 'LOW'

export interface PumpAlert {
  symbol: string
  name: string
  contract: string
  priceUsd: number | null
  change24h: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  category: PumpCategory
  reason: string
  riskLevel: PumpRisk
}

type GTIncluded = { id?: string; attributes?: { address?: string; symbol?: string; name?: string } }
type GTPool = {
  relationships?: { base_token?: { data?: { id?: string } } }
  attributes?: {
    base_token_price_usd?: number | string
    reserve_in_usd?: number | string
    fdv_usd?: number | string
    volume_usd?: { h24?: number | string }
    price_change_percentage?: { h24?: number | string }
  }
}

// Server-process-lifetime rotation memory: track last 3 batches of shown contract addresses
const MAX_HISTORY_BATCHES = 3
const shownBatches: string[][] = []

function parseNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''))
    return Number.isFinite(n) && n !== 0 ? n : null
  }
  return null
}

function categorize(
  change24h: number | null,
  volume: number | null,
  liquidity: number | null,
): { category: PumpCategory; reason: string; riskLevel: PumpRisk } | null {
  const ch = change24h ?? 0
  const vol = volume ?? 0
  const liq = liquidity ?? 0

  if (ch >= 20 && vol >= 100_000 && liq >= 25_000) {
    return {
      category: 'HIGH_MOMENTUM',
      reason: `+${ch.toFixed(1)}% in 24h with $${(vol / 1000).toFixed(0)}K volume`,
      riskLevel: liq >= 100_000 ? 'LOW' : 'MEDIUM',
    }
  }
  if (vol >= 500_000 && ch > 5) {
    return {
      category: 'VOLUME_EXPANSION',
      reason: `$${vol >= 1_000_000 ? (vol / 1_000_000).toFixed(1) + 'M' : (vol / 1000).toFixed(0) + 'K'} volume surge with +${ch.toFixed(1)}% move`,
      riskLevel: liq >= 50_000 ? 'LOW' : 'MEDIUM',
    }
  }
  if (ch >= 100 && liq < 25_000) {
    return {
      category: 'THIN_MOONSHOT',
      reason: `+${ch.toFixed(0)}% on thin liquidity ($${(liq / 1000).toFixed(1)}K) — treat as high risk`,
      riskLevel: 'HIGH',
    }
  }
  if (liq >= 25_000 || vol >= 75_000 || Math.abs(ch) >= 8) {
    const volFmt = vol >= 1_000_000 ? `$${(vol / 1_000_000).toFixed(1)}M` : `$${(vol / 1000).toFixed(0)}K`
    const liqFmt = `$${(liq / 1000).toFixed(0)}K`
    const parts: string[] = []
    if (Math.abs(ch) >= 8) parts.push(`${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% move`)
    if (vol >= 75_000) parts.push(`${volFmt} volume`)
    if (liq >= 25_000) parts.push(`${liqFmt} liquidity`)
    return {
      category: 'WATCH',
      reason: parts.join(' · ') || `${liqFmt} liquidity`,
      riskLevel: liq >= 50_000 ? 'LOW' : 'MEDIUM',
    }
  }
  return null
}

const CATEGORY_ORDER: Record<PumpCategory, number> = {
  HIGH_MOMENTUM: 0,
  VOLUME_EXPANSION: 1,
  THIN_MOONSHOT: 2,
  WATCH: 3,
}

// Per-category cap to avoid one category dominating output
const CAT_CAP: Record<PumpCategory, number> = {
  HIGH_MOMENTUM: 8,
  VOLUME_EXPANSION: 8,
  THIN_MOONSHOT: 6,
  WATCH: 12,
}

function applyRotationAndDiversity(scored: PumpAlert[]): PumpAlert[] {
  const recentAddrs = new Set(shownBatches.flat())

  // Prefer tokens not shown in recent batches
  const fresh = scored.filter(a => !recentAddrs.has(a.contract.toLowerCase()))
  const stale = scored.filter(a =>  recentAddrs.has(a.contract.toLowerCase()))

  function pickWithCaps(pool: PumpAlert[], limit: number): PumpAlert[] {
    const counts: Record<string, number> = {}
    const out: PumpAlert[] = []
    for (const a of pool) {
      if (out.length >= limit) break
      const c = counts[a.category] ?? 0
      if (c >= CAT_CAP[a.category]) continue
      out.push(a)
      counts[a.category] = c + 1
    }
    return out
  }

  // Fill primarily from fresh; backfill from stale when pool is thin
  const primary = pickWithCaps(fresh, 20)
  const taken = new Set(primary.map(a => a.contract.toLowerCase()))
  const backfill = pickWithCaps(
    stale.filter(a => !taken.has(a.contract.toLowerCase())),
    25 - primary.length,
  )
  const output = [...primary, ...backfill]

  // Final sort: category priority, then volume desc within category
  output.sort((a, b) => {
    const od = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    return od !== 0 ? od : (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)
  })

  // Record this batch; trim ring buffer
  shownBatches.push(output.map(a => a.contract.toLowerCase()))
  if (shownBatches.length > MAX_HISTORY_BATCHES) shownBatches.shift()

  return output
}

async function fetchGTPage(page: number, signal: AbortSignal): Promise<{ data?: GTPool[]; included?: GTIncluded[] }> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/base/pools?page=${page}&include=base_token,quote_token`,
    { headers: { accept: 'application/json' }, cache: 'no-store', signal },
  )
  if (!res.ok) throw new Error(`GT ${res.status}`)
  return res.json()
}

export async function GET() {
  let pools: GTPool[] = []
  let included: GTIncluded[] = []

  try {
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), 10_000)
    try {
      // Fetch 3 pages in parallel (~60 raw rows for a deeper candidate pool)
      const results = await Promise.allSettled([
        fetchGTPage(1, ac.signal),
        fetchGTPage(2, ac.signal),
        fetchGTPage(3, ac.signal),
      ])
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        if (Array.isArray(r.value.data)) pools.push(...(r.value.data as GTPool[]))
        if (Array.isArray(r.value.included)) included.push(...(r.value.included as GTIncluded[]))
      }
      if (pools.length === 0) throw new Error('no data')
    } finally {
      clearTimeout(tid)
    }
  } catch {
    // Fallback to shared cache (page 1 only)
    try {
      const result = await getOrFetchCached<{ data?: GTPool[]; included?: GTIncluded[] }>({
        key: 'coingecko:trending-base',
        ttlMs: 60_000,
        onLog: msg => console.info(`[pump-alerts] ${msg}`),
        fetcher: async () => {
          const ac = new AbortController()
          const tid = setTimeout(() => ac.abort(), 6000)
          try {
            const res = await fetch(
              'https://api.geckoterminal.com/api/v2/networks/base/pools?page=1&include=base_token,quote_token',
              { headers: { accept: 'application/json' }, cache: 'no-store', signal: ac.signal },
            )
            if (!res.ok) throw new Error(`GT ${res.status}`)
            return res.json()
          } finally {
            clearTimeout(tid)
          }
        },
      })
      pools = Array.isArray(result.data?.data) ? (result.data.data as GTPool[]) : []
      included = Array.isArray(result.data?.included) ? (result.data.included as GTIncluded[]) : []
    } catch {
      return NextResponse.json({ alerts: [], fetchedAt: new Date().toISOString() })
    }
  }

  // Deduplicate included tokens (3-page fetch may have duplicates)
  const includedById = new Map<string, GTIncluded>()
  for (const item of included) {
    if (item.id && !includedById.has(item.id)) includedById.set(item.id, item)
  }

  const seen = new Set<string>()
  const allScored: PumpAlert[] = []

  for (const pool of pools) {
    const tokenId = pool.relationships?.base_token?.data?.id
    if (!tokenId) continue
    const meta = includedById.get(tokenId)
    if (!meta?.attributes?.address) continue

    const sym = (meta.attributes.symbol ?? '').toUpperCase()
    const addr = meta.attributes.address.toLowerCase()

    if (EXCLUDED.has(sym)) continue
    if (seen.has(addr)) continue
    seen.add(addr)

    const attrs = pool.attributes
    const change24h = parseNum(attrs?.price_change_percentage?.h24)
    const volume = parseNum(attrs?.volume_usd?.h24)
    const liquidity = parseNum(attrs?.reserve_in_usd)
    const price = parseNum(attrs?.base_token_price_usd)
    const fdv = parseNum(attrs?.fdv_usd)

    const scored = categorize(change24h, volume, liquidity)
    if (!scored) continue

    allScored.push({
      symbol: meta.attributes.symbol ?? '?',
      name: meta.attributes.name ?? 'Unknown',
      contract: meta.attributes.address,
      priceUsd: price,
      change24h,
      volume24hUsd: volume,
      liquidityUsd: liquidity,
      fdvUsd: fdv,
      ...scored,
    })
  }

  // Quality-sort before rotation so rotation prioritises best candidates
  allScored.sort((a, b) => {
    const od = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    return od !== 0 ? od : (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)
  })

  const alerts = applyRotationAndDiversity(allScored)

  return NextResponse.json({ alerts, fetchedAt: new Date().toISOString() })
}

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
  if (liq >= 20_000 && vol >= 15_000) {
    const volFmt = vol >= 1_000_000 ? `$${(vol / 1_000_000).toFixed(1)}M` : `$${(vol / 1000).toFixed(0)}K`
    return {
      category: 'WATCH',
      reason: `$${(liq / 1000).toFixed(0)}K liquidity with ${volFmt} volume`,
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

export async function GET() {
  let pools: GTPool[] = []
  let included: GTIncluded[] = []

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

  const seen = new Set<string>()
  const alerts: PumpAlert[] = []

  for (const pool of pools) {
    const tokenId = pool.relationships?.base_token?.data?.id
    if (!tokenId) continue
    const meta = included.find(i => i.id === tokenId)
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

    alerts.push({
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

  alerts.sort((a, b) => {
    const od = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    return od !== 0 ? od : (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)
  })

  return NextResponse.json({ alerts: alerts.slice(0, 30), fetchedAt: new Date().toISOString() })
}

import { NextResponse } from 'next/server'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

export const dynamic = 'force-dynamic'
const PUMP_ROUTE_CACHE_TTL_MS = 45_000
const pumpCache = new Map<string, { exp: number; payload: unknown }>()
const pumpRate = new Map<string, { count: number; resetAt: number }>()
const PUMP_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 3, pro: 12, elite: 24 }

function getIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

async function getServerPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try {
    const { plan } = await getCurrentUserPlanFromBearerToken(token)
    return plan
  } catch {
    return 'free'
  }
}

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
  tags: string[]
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

function qualityScore(a: PumpAlert): number {
  let s = 0
  const liq = a.liquidityUsd ?? 0
  const vol = a.volume24hUsd ?? 0
  const fdv = a.fdvUsd ?? 0
  if (liq >= 100_000) s += 3; else if (liq >= 25_000) s += 2
  if (vol >= 500_000) s += 3; else if (vol >= 100_000) s += 2
  if (fdv >= 100_000) s += 2; else if (fdv >= 50_000) s += 1
  if ((a.change24h ?? 0) > 0) s += 1
  if (liq > 0 && liq < 10_000) s -= 3
  if (fdv > 0 && fdv < 20_000) s -= 2
  if (a.volume24hUsd == null) s -= 2
  if (!a.symbol || a.symbol === '?') s -= 1
  if (!a.name || a.name === 'Unknown') s -= 1
  return s
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

// Loose per-category caps applied only to fresh candidates (diversity nudge, not a hard filter)
const FRESH_CAT_CAP: Record<PumpCategory, number> = {
  HIGH_MOMENTUM: 10,
  VOLUME_EXPANSION: 10,
  THIN_MOONSHOT: 8,
  WATCH: 15,
}

interface RotationResult {
  alerts: PumpAlert[]
  freshCount: number
  staleCount: number
  fallbackUsed: boolean
}

function applyRotationAndDiversity(scored: PumpAlert[]): RotationResult {
  if (scored.length === 0) return { alerts: [], freshCount: 0, staleCount: 0, fallbackUsed: false }

  const recentAddrs = new Set(shownBatches.flat())
  const fresh = scored.filter(a => !recentAddrs.has(a.contract.toLowerCase()))
  const stale = scored.filter(a =>  recentAddrs.has(a.contract.toLowerCase()))

  const output: PumpAlert[] = []
  const taken = new Set<string>()

  // Pass 1: fresh candidates with loose diversity caps
  const counts: Record<string, number> = {}
  for (const a of fresh) {
    if (output.length >= 25) break
    const c = counts[a.category] ?? 0
    if (c >= FRESH_CAT_CAP[a.category]) continue
    output.push(a)
    taken.add(a.contract.toLowerCase())
    counts[a.category] = c + 1
  }

  // Pass 2: stale backfill — NO category caps, just fill remaining slots
  for (const a of stale) {
    if (output.length >= 25) break
    if (!taken.has(a.contract.toLowerCase())) {
      output.push(a)
      taken.add(a.contract.toLowerCase())
    }
  }

  // Hard fallback: if rotation logic somehow produced empty, use scored directly
  let fallbackUsed = false
  if (output.length === 0) {
    output.push(...scored.slice(0, 25))
    fallbackUsed = true
  }

  // Sort by quality for display
  output.sort((a, b) => {
    const od = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    if (od !== 0) return od
    const qd = qualityScore(b) - qualityScore(a)
    return qd !== 0 ? qd : (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)
  })

  // Record batch only when we have real results
  if (output.length > 0) {
    shownBatches.push(output.map(a => a.contract.toLowerCase()))
    if (shownBatches.length > MAX_HISTORY_BATCHES) shownBatches.shift()
  }

  return { alerts: output, freshCount: fresh.length, staleCount: stale.length, fallbackUsed }
}

async function fetchGTPage(page: number, signal: AbortSignal): Promise<{ data?: GTPool[]; included?: GTIncluded[] }> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/base/pools?page=${page}&include=base_token,quote_token`,
    { headers: { accept: 'application/json' }, cache: 'no-store', signal },
  )
  if (!res.ok) throw new Error(`GT ${res.status}`)
  return res.json()
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  let plan: 'free' | 'pro' | 'elite' = 'free'
  let settingsRowFound = false
  if (token) {
    const planData = await getCurrentUserPlanFromBearerToken(token).catch(() => null)
    if (planData) { plan = planData.plan; settingsRowFound = planData.settingsRowFound }
  }
  if (plan === 'free') {
    return NextResponse.json({ error: 'Included in Pro and Elite.', rateLimited: false, planGate: { verifiedPlan: plan, requiredPlan: 'pro', settingsRowFound, planSource: token ? 'bearer_token' : 'no_token' } }, { status: 403 })
  }
  const ip = getIp(req)
  const now = Date.now()
  const rrKey = `${ip}:${plan}`
  const rr = pumpRate.get(rrKey)
  if (!rr || rr.resetAt <= now) pumpRate.set(rrKey, { count: 1, resetAt: now + 60_000 })
  else if (rr.count >= PUMP_RATE_LIMIT[plan]) {
    return NextResponse.json({ error: 'Rate limit reached. Try again shortly.', rateLimited: true }, { status: 429 })
  } else rr.count += 1

  const cacheKey = `pump:${plan}`
  const cached = pumpCache.get(cacheKey)
  if (cached && cached.exp > now) return NextResponse.json(cached.payload)

  let pools: GTPool[] = []
  let included: GTIncluded[] = []
  let providerStatus: 'ok' | 'partial' | 'unavailable' = 'ok'

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
    providerStatus = 'partial'
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
      providerStatus = 'unavailable'
      return NextResponse.json({ alerts: [], fetchedAt: new Date().toISOString() })
    }
  }

  const seen = new Set<string>()
  const allScored: PumpAlert[] = []

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

    const tags: string[] = []
    if (fdv != null && fdv > 0 && fdv < 100_000) tags.push('Microcap')
    if (volume == null || liquidity == null) tags.push('Needs Review')

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
      tags,
    })
  }

  // Quality-sort before rotation so rotation prioritises best candidates
  allScored.sort((a, b) => {
    const od = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    if (od !== 0) return od
    const qd = qualityScore(b) - qualityScore(a)
    return qd !== 0 ? qd : (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)
  })

  const { alerts, freshCount, staleCount, fallbackUsed } = applyRotationAndDiversity(allScored)

  const payload = {
    alerts,
    fetchedAt: new Date().toISOString(),
    diagnostics: process.env.NODE_ENV === 'development' ? { cacheHit: false, providerStatus, rateLimited: false } : undefined,
    _debug: {
      rawCount: pools.length,
      scoredCount: allScored.length,
      freshCount,
      staleCount,
      selectedCount: alerts.length,
      fallbackUsed,
    },
  }
  pumpCache.set(cacheKey, { exp: Date.now() + PUMP_ROUTE_CACHE_TTL_MS, payload })
  return NextResponse.json(payload)
}

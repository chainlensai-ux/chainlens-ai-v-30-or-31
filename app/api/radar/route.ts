import { NextResponse, type NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { DEFAULT_RADAR_ALLOW_FDV_FALLBACK, DEFAULT_RADAR_MIN_LIQUIDITY_USD, DEFAULT_RADAR_MIN_VALUATION_USD, getRadarValuationBasis, tokenPassesRadarValuationFilters, type RadarValuationBasis } from '@/lib/baseRadarValuation'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })

const EXCLUDED = new Set([
  'USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'USDBC', 'ETH', 'BUSD', 'FRAX',
  'CBETH', 'CBBTC', 'CBUSD', 'AXLUSDC', 'USD+', 'STETH', 'RETH',
  'WSTETH', 'EURC', 'BSDETH',
])

type RiskLevel = 'DANGER' | 'CAUTION' | 'SAFE'

interface HoneypotResult {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  simulationSuccess: boolean
}

export interface RadarToken {
  name: string
  symbol: string
  contract: string
  ageMinutes: number
  liquidityUsd: number
  volume24h: number
  fdvUsd: number | null
  marketCapUsd: number | null
  marketCapStatus: 'verified' | 'inferred' | 'partial'
  valuationBasis: RadarValuationBasis
  valuationUsd: number | null
  valuationLabel: string
  valuationVerified: boolean
  valuationReason: string
  evidenceGaps: string[]
  riskLevel: RiskLevel
  honeypot: HoneypotResult | null
  clarkVerdict: string | null
}

export interface RadarStats {
  totalNewTokens: number
  averageLiquidity: number
  mostCommonRisk: RiskLevel
  dangerCount: number
  cautionCount: number
  safeCount: number
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([promise.finally(() => clearTimeout(timer!)), timeout])
}

async function fetchHoneypot(contract: string): Promise<HoneypotResult | null> {
  try {
    const res = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?address=${contract}&chainID=8453`,
      { cache: 'no-store' }
    )
    if (!res.ok) return null
    const data = await res.json()
    return {
      isHoneypot:        data.honeypotResult?.isHoneypot        ?? null,
      buyTax:            data.simulationResult?.buyTax           ?? null,
      sellTax:           data.simulationResult?.sellTax          ?? null,
      simulationSuccess: data.simulationSuccess                  ?? false,
    }
  } catch {
    return null
  }
}

function scoreRisk(hp: HoneypotResult | null): RiskLevel {
  if (!hp || !hp.simulationSuccess) return 'SAFE'
  if (hp.isHoneypot === true) return 'DANGER'
  if ((hp.sellTax ?? 0) > 10 || (hp.buyTax ?? 0) > 10) return 'CAUTION'
  return 'SAFE'
}

function fmtK(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

async function getClarkVerdicts(tokens: Omit<RadarToken, 'clarkVerdict'>[]): Promise<Map<string, string>> {
  if (tokens.length === 0) return new Map()

  const lines = tokens.map((t, i) => {
    const hp  = t.honeypot
    const sec = hp?.simulationSuccess
      ? (hp.isHoneypot ? 'HONEYPOT' : `BuyTax:${hp.buyTax?.toFixed(1) ?? '0'}% SellTax:${hp.sellTax?.toFixed(1) ?? '0'}%`)
      : 'HP:UNVERIFIED'
    return `${i + 1}. [${t.contract}] ${t.name} (${t.symbol}) Age:${t.ageMinutes}min Liq:${fmtK(t.liquidityUsd)} Vol:${fmtK(t.volume24h)} ${sec} Risk:${t.riskLevel}`
  })

  const prompt =
    `You are Clark — Base chain radar analyst. For each new token give ONE punchy verdict (max 12 words). ` +
    `Lead with BUY, AVOID, or WATCH. If Risk=DANGER or HONEYPOT detected, always use AVOID.\n\n` +
    `Output ONLY these lines, nothing else. Format exactly: CONTRACT_ADDRESS|verdict\n\n` +
    lines.join('\n')

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    })

    const text     = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : ''
    const verdicts = new Map<string, string>()

    for (const line of text.split('\n')) {
      const pipe = line.indexOf('|')
      if (pipe === -1) continue
      const addr    = line.slice(0, pipe).trim()
      const verdict = line.slice(pipe + 1).trim()
      if (/^0x[a-fA-F0-9]{40}$/.test(addr) && verdict) {
        verdicts.set(addr.toLowerCase(), verdict)
      }
    }

    // Positional fallback if address parsing failed
    if (verdicts.size === 0) {
      text.split('\n').filter(Boolean).forEach((raw, i) => {
        if (tokens[i]) {
          const clean = raw.replace(/^\d+\.\s*/, '').replace(/^[^|]*\|/, '').trim()
          verdicts.set(tokens[i].contract.toLowerCase(), clean)
        }
      })
    }

    return verdicts
  } catch (err) {
    console.error('[radar] Clark verdict error:', err)
    return new Map()
  }
}

const EMPTY_STATS: RadarStats = { totalNewTokens: 0, averageLiquidity: 0, mostCommonRisk: 'SAFE', dangerCount: 0, cautionCount: 0, safeCount: 0 }

const HONEYPOT_CACHE_TTL_MS = 5 * 60 * 1000
const RADAR_CACHE_TTL_MS = 5 * 60 * 1000
const radarPayloadCache = new Map<string, { cachedAt: number; payload: { tokens: RadarToken[]; stats: RadarStats; fetchedAt: string; limitedLiveFeed: boolean; _debug?: Record<string, unknown> } }>()
const honeypotCache = new Map<string, { result: HoneypotResult | null; cachedAt: number }>()

async function getCachedHoneypot(contract: string): Promise<HoneypotResult | null> {
  const key = contract.toLowerCase()
  const now = Date.now()
  const cached = honeypotCache.get(key)
  if (cached && now - cached.cachedAt <= HONEYPOT_CACHE_TTL_MS) return cached.result
  const result = await fetchHoneypot(contract)
  honeypotCache.set(key, { result, cachedAt: Date.now() })
  return result
}

export async function GET(req: NextRequest) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  let plan: 'free' | 'pro' | 'elite' = 'free'
  if (token) {
    try { plan = (await getCurrentUserPlanFromBearerToken(token)).plan } catch { plan = 'free' }
  }
  if (plan === 'free') return NextResponse.json({ error: 'Included in Pro and Elite.' }, { status: 403 })
  const debug = req.nextUrl.searchParams.get('debug') === 'true'
  const minValuationUsd = Number(req.nextUrl.searchParams.get('minValuationUsd')) || DEFAULT_RADAR_MIN_VALUATION_USD
  const minLiquidityUsd = Number(req.nextUrl.searchParams.get('minLiquidityUsd')) || DEFAULT_RADAR_MIN_LIQUIDITY_USD
  const allowFdvFallback = req.nextUrl.searchParams.get('allowFdvFallback') === 'false' ? false : DEFAULT_RADAR_ALLOW_FDV_FALLBACK
  const now = Date.now()
  const cacheKey = `plan:${plan}:minValuation:${minValuationUsd}:minLiquidity:${minLiquidityUsd}:fdvFallback:${allowFdvFallback}`
  const cachedPayload = radarPayloadCache.get(cacheKey)
  if (cachedPayload && now - cachedPayload.cachedAt <= RADAR_CACHE_TTL_MS) {
    const payload = cachedPayload.payload
    return NextResponse.json({
      ...payload,
      ...(debug ? { _debug: { ...(payload._debug ?? {}), cacheHit: true, effectivePlan: plan, upsellVisible: false } } : {}),
    })
  }

  const sourceSpecs = [
    { key: 'new_p1', url: 'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=1&include=base_token%2Cquote_token&per_page=20' },
    { key: 'new_p2', url: 'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=2&include=base_token%2Cquote_token&per_page=20' },
    { key: 'trending_p1', url: 'https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1&include=base_token%2Cquote_token&per_page=20' },
  ] as const
  const sourceCounts: Record<string, number> = {}
  let sourcesSucceeded = 0
  const sourcesAttempted = sourceSpecs.length
  const sourcePayloads: Record<string, unknown>[] = []
  for (const spec of sourceSpecs) {
    try {
      const result = await getOrFetchCached<Record<string, unknown>>({
        key: `coingecko:base-radar:${spec.key}`,
        ttlMs: RADAR_CACHE_TTL_MS,
        onLog: msg => console.info(`[radar] ${msg}`),
        fetcher: async () => {
          const ac = new AbortController()
          const tid = setTimeout(() => ac.abort(), 6000)
          try {
            const gtRes = await fetch(spec.url, { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: ac.signal })
            if (!gtRes.ok) throw new Error(`market_source_unavailable_${gtRes.status}`)
            return gtRes.json() as Promise<Record<string, unknown>>
          } finally { clearTimeout(tid) }
        },
      })
      const count = Array.isArray(result.data?.data) ? result.data.data.length : 0
      sourceCounts[spec.key] = count
      if (count > 0) {
        sourcesSucceeded += 1
        sourcePayloads.push(result.data)
      }
    } catch {
      sourceCounts[spec.key] = 0
    }
  }

  try {
    const pooled: Record<string, unknown>[] = []
    const includedAll: Record<string, unknown>[] = []
    for (const src of sourcePayloads) {
      const pools = Array.isArray(src?.data) ? (src.data as Record<string, unknown>[]) : []
      const included = Array.isArray(src?.included) ? (src.included as Record<string, unknown>[]) : []
      pooled.push(...pools)
      includedAll.push(...included)
    }

    // Build token lookup from ?include= entities
    const tokenMap = new Map<string, { name: string; symbol: string; address: string }>()
    for (const item of includedAll) {
      const attrs = item.attributes as Record<string, string> | undefined
      if (item.type === 'token' && attrs?.address) {
        tokenMap.set(item.id as string, {
          name:    attrs.name   ?? 'Unknown',
          symbol:  attrs.symbol ?? '?',
          address: attrs.address,
        })
      }
    }

    const now       = Date.now()
    const TWO_HOURS = 2  * 60 * 60 * 1000
    const DAY_MS    = 24 * 60 * 60 * 1000

    type Candidate = Omit<RadarToken, 'clarkVerdict'>
    const candidates: Candidate[] = []
    const allDay24h:  number[]    = []
    const seenContracts = new Set<string>()
    const seenPools = new Set<string>()

    for (const pool of pooled) {
      const poolId = String(pool.id ?? '').toLowerCase()
      if (poolId && seenPools.has(poolId)) continue
      if (poolId) seenPools.add(poolId)
      const attrs = pool.attributes  as Record<string, unknown>         | undefined
      const rels  = pool.relationships as Record<string, unknown>       | undefined
      const volObj = attrs?.volume_usd as Record<string, string>        | undefined
      const createdAt = attrs?.pool_created_at as string | undefined
      if (!createdAt) continue

      const ageMs      = now - new Date(createdAt).getTime()
      const ageMinutes = Math.floor(ageMs / 60000)
      const liquidityUsd = parseFloat(String(attrs?.reserve_in_usd ?? '0')) || 0
      const volume24h    = parseFloat(volObj?.h24 ?? '0') || 0

      if (ageMs < DAY_MS && liquidityUsd >= 1000) allDay24h.push(liquidityUsd)

      if (ageMs  >= 6 * 60 * 60 * 1000) continue

      const baseData    = ((rels?.base_token as Record<string, unknown>)?.data) as Record<string, string> | undefined
      const baseToken   = baseData?.id ? tokenMap.get(baseData.id) : undefined
      if (!baseToken) continue

      if (EXCLUDED.has(baseToken.symbol.toUpperCase())) continue

      const key = baseToken.address.toLowerCase()
      if (seenContracts.has(key)) continue
      seenContracts.add(key)

      const fdvUsd = parseFloat(String(attrs?.fdv_usd ?? '0')) || null
      const marketCapUsd = parseFloat(String(attrs?.market_cap_usd ?? '0')) || null
      const marketCapStatus = marketCapUsd != null ? 'verified' : (fdvUsd != null ? 'inferred' : 'partial')
      const filterResult = tokenPassesRadarValuationFilters({ marketCapUsd, marketCapStatus, fdvUsd, liquidityUsd, minValuationUsd, minLiquidityUsd, allowFdvFallback })
      if (!filterResult.included) continue
      const valuation = getRadarValuationBasis({ marketCapUsd, marketCapStatus, fdvUsd: allowFdvFallback ? fdvUsd : null })
      const evidenceGaps = valuation.basis === 'fdv_fallback'
        ? ['Market cap unavailable; FDV used as fallback valuation.']
        : valuation.basis === 'unavailable'
          ? ['Market valuation unavailable.']
          : []
      candidates.push({
        name: baseToken.name, symbol: baseToken.symbol, contract: baseToken.address,
        ageMinutes, liquidityUsd, volume24h, fdvUsd, marketCapUsd, marketCapStatus, valuationBasis: valuation.basis, valuationUsd: valuation.valueUsd, valuationLabel: valuation.label, valuationVerified: valuation.verified, valuationReason: valuation.reason, evidenceGaps, riskLevel: 'SAFE', honeypot: null,
      })
    }

    // Sort by blend of momentum/liquidity/volume/freshness
    candidates.sort((a, b) => {
      const mA = a.liquidityUsd > 0 ? a.volume24h / a.liquidityUsd : 0
      const mB = b.liquidityUsd > 0 ? b.volume24h / b.liquidityUsd : 0
      const sA = (mA * 40) + Math.log10(Math.max(a.liquidityUsd, 1)) * 18 + Math.log10(Math.max(a.volume24h, 1)) * 18 + (a.ageMinutes <= 120 ? 12 : 0) + (a.fdvUsd && a.fdvUsd > 0 ? 6 : 0)
      const sB = (mB * 40) + Math.log10(Math.max(b.liquidityUsd, 1)) * 18 + Math.log10(Math.max(b.volume24h, 1)) * 18 + (b.ageMinutes <= 120 ? 12 : 0) + (b.fdvUsd && b.fdvUsd > 0 ? 6 : 0)
      return sB - sA
    })
    const toCheck = candidates.slice(0, 50)

    // 2. Honeypot checks in parallel with 5s timeout each
    const hpCacheHitFlags = toCheck.map(t => { const c = honeypotCache.get(t.contract.toLowerCase()); return !!(c && Date.now() - c.cachedAt <= HONEYPOT_CACHE_TTL_MS) })
    const hpResults = await Promise.allSettled(
      toCheck.map(t => withTimeout(getCachedHoneypot(t.contract), 5000, null))
    )

    const scored: Candidate[] = toCheck.map((token, i) => {
      const hp = hpResults[i].status === 'fulfilled' ? hpResults[i].value : null
      return { ...token, honeypot: hp, riskLevel: scoreRisk(hp) }
    })

    // 3. Clark verdicts for top 5 by liquidity
    const top5     = [...scored].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 5)
    const verdicts = await getClarkVerdicts(top5)

    // 4. Final output — newest first for live feed
    const tokens: RadarToken[] = [...scored]
      .sort((a, b) => a.ageMinutes - b.ageMinutes)
      .map(t => ({ ...t, clarkVerdict: verdicts.get(t.contract.toLowerCase()) ?? null }))

    // 5. Stats
    const dangerCount  = scored.filter(t => t.riskLevel === 'DANGER').length
    const cautionCount = scored.filter(t => t.riskLevel === 'CAUTION').length
    const safeCount    = scored.filter(t => t.riskLevel === 'SAFE').length
    const avgLiq       = allDay24h.length > 0 ? allDay24h.reduce((s, v) => s + v, 0) / allDay24h.length : 0
    const mostCommonRisk: RiskLevel =
      dangerCount >= cautionCount && dangerCount >= safeCount ? 'DANGER'
      : cautionCount >= safeCount ? 'CAUTION' : 'SAFE'

    const stats: RadarStats = {
      totalNewTokens:   allDay24h.length,
      averageLiquidity: Math.round(avgLiq),
      mostCommonRisk,
      dangerCount, cautionCount, safeCount,
    }

    const limitedLiveFeed = tokens.length > 0 && tokens.length < 5
    const hpHitCount = hpCacheHitFlags.filter(Boolean).length
    const payload = { tokens, stats, fetchedAt: new Date().toISOString(), limitedLiveFeed }
    const debugPayload = {
      sourcesAttempted,
      sourcesSucceeded,
      sourceCounts,
      mergedCount: candidates.length,
      filters: { minValuationUsd, minLiquidityUsd, allowFdvFallback },
      finalTokenCount: tokens.length,
      cacheHit: false,
      effectivePlan: plan,
      upsellVisible: false,
      honeypotCacheHits: hpHitCount,
      honeypotCacheMisses: hpCacheHitFlags.length - hpHitCount,
    }
    radarPayloadCache.set(cacheKey, { cachedAt: Date.now(), payload: { ...payload, _debug: debugPayload } })
    return NextResponse.json({ ...payload, ...(debug ? { _debug: debugPayload } : {}) })
  } catch (err) {
    console.error('[radar] processing error:', err)
    if (cachedPayload) return NextResponse.json(cachedPayload.payload)
    return NextResponse.json({ tokens: [], stats: EMPTY_STATS, fetchedAt: new Date().toISOString(), limitedLiveFeed: false })
  }
}

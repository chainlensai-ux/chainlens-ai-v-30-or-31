import { NextResponse, type NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { DEFAULT_RADAR_ALLOW_FDV_FALLBACK, DEFAULT_RADAR_MIN_LIQUIDITY_USD, DEFAULT_RADAR_MIN_VALUATION_USD, getRadarCortexValuationLine, getRadarValuationCardDisplay, getRadarValuationEvidenceGap, resolveBaseRadarMarketCap, selectDexScreenerMarketCapRescuePair, tokenPassesRadarValuationFilters, type DexScreenerMarketCapRescueResult, type RadarValuationBasis } from '@/lib/baseRadarValuation'
import { getRadarSimulationDisplay, type RadarSimulationOpenCheckReason, type RadarSimulationStatus } from '@/lib/baseRadarSimulation'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })

const EXCLUDED = new Set([
  'USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'USDBC', 'ETH', 'BUSD', 'FRAX',
  'CBETH', 'CBBTC', 'CBUSD', 'AXLUSDC', 'USD+', 'STETH', 'RETH',
  'WSTETH', 'EURC', 'BSDETH',
])

type RiskLevel = 'DANGER' | 'CAUTION' | 'WATCH' | 'SAFE'

interface HoneypotResult {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  simulationSuccess: boolean | null
  failureReason?: RadarSimulationOpenCheckReason
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
  marketCapStatus: 'verified' | 'unavailable'
  valuationBasis: RadarValuationBasis
  valuationUsd: number | null
  valuationLabel: string
  valuationSublabel: string | null
  valuationVerified: boolean
  valuationReason: string
  valuationCortexLine: string | null
  evidenceGaps: string[]
  riskLevel: RiskLevel
  honeypot: HoneypotResult | null
  simulationStatus: RadarSimulationStatus
  simulationReason: RadarSimulationOpenCheckReason | null
  simulationLabel: string
  simulationCortexLine: string
  clarkVerdict: string | null
  marketCapDiagnostics?: {
    selectedMarketCapUsd: number | null
    selectedMarketCapStatus: 'verified' | 'unavailable'
    selectedMarketCapFieldPath: string | null
    selectedValuationBasis: RadarValuationBasis
    fdvUsd: number | null
    rawCandidates: { path: string; value: unknown }[]
    resolverReason: string
    rescueAttempted: boolean
    rescueCacheHit: boolean
    rescuePairCount: number
    rescueSelectedPairAddress: string | null
    rescueSelectedDexId: string | null
    rescueSelectedLiquidityUsd: number | null
    rescueRawCandidates: { path: string; value: unknown }[]
  }
}

export interface RadarStats {
  totalNewTokens: number
  averageLiquidity: number
  mostCommonRisk: RiskLevel
  dangerCount: number
  cautionCount: number
  watchCount: number
  safeCount: number
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([promise.finally(() => clearTimeout(timer!)), timeout])
}

async function fetchHoneypot(contract: string): Promise<HoneypotResult | null> {
  const ac = new AbortController()
  const tid = setTimeout(() => ac.abort(), 2500)
  try {
    const res = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?address=${contract}&chainID=8453`,
      { cache: 'no-store', signal: ac.signal }
    )
    if (!res.ok) return { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'provider_unavailable' }
    const data = await res.json()
    return {
      isHoneypot:        data.honeypotResult?.isHoneypot        ?? null,
      buyTax:            data.simulationResult?.buyTax           ?? null,
      sellTax:           data.simulationResult?.sellTax          ?? null,
      simulationSuccess: data.simulationSuccess                  ?? false,
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    return { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: name === 'AbortError' ? 'timeout_after_retry' : 'provider_unavailable' }
  } finally {
    clearTimeout(tid)
  }
}

const RADAR_VERY_NEW_MAX_AGE_MINUTES = 15
const RADAR_AGGRESSIVE_VOLUME_TO_LIQUIDITY_RATIO = 5

function scoreRisk(input: {
  hp: HoneypotResult | null
  simulationStatus: RadarSimulationStatus
  ageMinutes: number
  liquidityUsd: number
  volume24h: number
}): RiskLevel {
  const { hp, simulationStatus, ageMinutes, liquidityUsd, volume24h } = input

  if (hp?.isHoneypot === true) return 'DANGER'

  // A verified market cap does not make a token SAFE — simulation must have
  // passed and honeypot must be known before SAFE/CAUTION can be assigned.
  if (simulationStatus === 'passed' && hp != null && hp.simulationSuccess && hp.isHoneypot != null) {
    if ((hp.sellTax ?? 0) > 10 || (hp.buyTax ?? 0) > 10) return 'CAUTION'
    return 'SAFE'
  }

  const veryNew = ageMinutes < RADAR_VERY_NEW_MAX_AGE_MINUTES
  const weakLiquidity = liquidityUsd < DEFAULT_RADAR_MIN_LIQUIDITY_USD
  const aggressiveVolume = liquidityUsd > 0 && volume24h / liquidityUsd >= RADAR_AGGRESSIVE_VOLUME_TO_LIQUIDITY_RATIO
  if (veryNew || weakLiquidity || aggressiveVolume) return 'CAUTION'
  return 'WATCH'
}

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
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

const EMPTY_STATS: RadarStats = { totalNewTokens: 0, averageLiquidity: 0, mostCommonRisk: 'SAFE', dangerCount: 0, cautionCount: 0, watchCount: 0, safeCount: 0 }

const HONEYPOT_CACHE_TTL_MS = 5 * 60 * 1000
// CACHE-TTL-VS-POLL-INTERVAL FIX, DISCLOSED (Base Radar speed audit): the frontend
// (app/terminal/base-radar/page.tsx) polls this endpoint every 120s per client. At the previous
// 45s/15s TTLs, most polls still missed cache (TTL << 120s poll interval) and re-ran the full
// multi-source fetch + scoring pipeline (including the Clark AI verdict call) on nearly every tick
// from every connected client. Raised closer to — but still safely under — the 120s poll interval,
// so a single client's own poll cadence still always sees fresh-enough data (never a full 2 cycles
// stale) while multiple concurrent clients polling on staggered schedules now actually share the
// cached result instead of each re-triggering the full pipeline independently.
const RADAR_FULL_CACHE_TTL_MS = 100 * 1000
const RADAR_SHALLOW_CACHE_TTL_MS = 30 * 1000
export const DEX_MARKET_CAP_RESCUE_TTL_MS = 2 * 60 * 1000
const radarPayloadCache = new Map<string, { cachedAt: number; ttlMs: number; payload: { tokens: RadarToken[]; stats: RadarStats; fetchedAt: string; limitedLiveFeed: boolean; mode: 'shallow' | 'full'; _debug?: Record<string, unknown> } }>()
const honeypotCache = new Map<string, { result: HoneypotResult | null; cachedAt: number }>()
const honeypotInflight = new Map<string, Promise<HoneypotResult | null>>()
const dexMarketCapRescueCache = new Map<string, { result: DexScreenerMarketCapRescueResult; cachedAt: number }>()
const dexMarketCapRescueInflight = new Map<string, Promise<DexScreenerMarketCapRescueResult>>()

async function getCachedHoneypot(contract: string, retry = false): Promise<HoneypotResult | null> {
  const key = contract.toLowerCase()
  const now = Date.now()
  const cached = honeypotCache.get(key)
  if (cached && now - cached.cachedAt <= HONEYPOT_CACHE_TTL_MS && !(retry && cached.result == null)) return cached.result
  const existing = honeypotInflight.get(key)
  if (existing) return existing
  const promise = (async () => {
    const first = await fetchHoneypot(contract)
    if (first || !retry) return first
    return withTimeout(fetchHoneypot(contract), 2500, { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'timeout_after_retry' })
  })()
  honeypotInflight.set(key, promise)
  try {
    const result = await promise
    honeypotCache.set(key, { result, cachedAt: Date.now() })
    return result
  } finally {
    honeypotInflight.delete(key)
  }
}

async function getDexMarketCapRescue(input: { chain: string; token: string; primaryPoolAddress?: string | null }): Promise<DexScreenerMarketCapRescueResult & { cacheHit: boolean }> {
  const chain = input.chain.toLowerCase()
  const token = input.token.toLowerCase()
  const key = `base-radar:market-cap-rescue:${chain}:${token}`
  const cached = dexMarketCapRescueCache.get(key)
  if (cached && Date.now() - cached.cachedAt <= DEX_MARKET_CAP_RESCUE_TTL_MS) return { ...cached.result, cacheHit: true }

  const existing = dexMarketCapRescueInflight.get(key)
  if (existing) return { ...(await existing), cacheHit: true }

  const promise = (async () => {
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), 3000)
    try {
      const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(token)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: ac.signal,
      })
      if (!res.ok) {
        // DIAGNOSTIC FIX, DISCLOSED: previously a non-OK HTTP response (including a 429 rate-limit)
        // was thrown and caught below, producing the exact same result/reason as "the request
        // succeeded but no pair had an explicit market cap field" — indistinguishable from the
        // outside. Tagging the real HTTP status here so a rate-limit burst is now visible in
        // debugPayload (see rescueRateLimited/rescueHttpFailed counts below) instead of looking
        // identical to an honest "no data" outcome.
        const err = new Error(`dex_rescue_http_${res.status}`) as Error & { httpStatus?: number }
        err.httpStatus = res.status
        throw err
      }
      const data = await res.json()
      const pairs: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as Record<string, unknown>)?.pairs) ? (data as Record<string, unknown>).pairs as unknown[] : []
      return selectDexScreenerMarketCapRescuePair({
        pairs: pairs.filter((pair): pair is Record<string, unknown> => !!pair && typeof pair === 'object'),
        chain,
        primaryPoolAddress: input.primaryPoolAddress,
      })
    } catch (err) {
      const httpStatus = (err as { httpStatus?: number } | undefined)?.httpStatus ?? null
      const result = selectDexScreenerMarketCapRescuePair({ pairs: [], chain, primaryPoolAddress: input.primaryPoolAddress })
      return {
        ...result,
        reason: httpStatus === 429
          ? 'DexScreener rate-limited this rescue request (429).'
          : httpStatus != null
            ? `DexScreener rescue request failed (HTTP ${httpStatus}).`
            : err instanceof Error && err.name === 'AbortError'
              ? 'DexScreener rescue request timed out.'
              : result.reason,
      }
    } finally {
      clearTimeout(tid)
    }
  })()
  dexMarketCapRescueInflight.set(key, promise)
  try {
    const result = await promise
    dexMarketCapRescueCache.set(key, { result, cachedAt: Date.now() })
    return { ...result, cacheHit: false }
  } finally {
    dexMarketCapRescueInflight.delete(key)
  }
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
  const requestedMode: 'shallow' | 'full' = req.nextUrl.searchParams.get('mode') === 'full' ? 'full' : 'shallow'
  const cacheKeyBase = `plan:${plan}:minValuation:${minValuationUsd}:minLiquidity:${minLiquidityUsd}:fdvFallback:${allowFdvFallback}`
  const fullCacheKey = `${cacheKeyBase}:mode:full`
  const shallowCacheKey = `${cacheKeyBase}:mode:shallow`
  const preferredCacheKey = requestedMode === 'full' ? fullCacheKey : shallowCacheKey
  const fullCachedPayload = radarPayloadCache.get(fullCacheKey)
  if (fullCachedPayload && now - fullCachedPayload.cachedAt <= fullCachedPayload.ttlMs) {
    const payload = fullCachedPayload.payload
    return NextResponse.json({
      ...payload,
      ...(debug ? { _debug: { ...(payload._debug ?? {}), cacheHit: true, cacheMode: 'full', effectivePlan: plan, upsellVisible: false } } : {}),
    })
  }
  const cachedPayload = radarPayloadCache.get(preferredCacheKey)
  if (cachedPayload && now - cachedPayload.cachedAt <= cachedPayload.ttlMs) {
    const payload = cachedPayload.payload
    return NextResponse.json({
      ...payload,
      ...(debug ? { _debug: { ...(payload._debug ?? {}), cacheHit: true, cacheMode: requestedMode, effectivePlan: plan, upsellVisible: false } } : {}),
    })
  }
  const shallowMode = requestedMode === 'shallow'

  const sourceSpecs = [
    { key: 'new_p1', url: 'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=1&include=base_token%2Cquote_token&per_page=20' },
    { key: 'new_p2', url: 'https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=2&include=base_token%2Cquote_token&per_page=20' },
    { key: 'trending_p1', url: 'https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1&include=base_token%2Cquote_token&per_page=20' },
  ] as const
  const sourceCounts: Record<string, number> = {}
  let sourcesSucceeded = 0
  const sourcesAttempted = sourceSpecs.length
  const sourcePayloads: Record<string, unknown>[] = []
  // TOKEN-SAVER: these 3 source fetches are independent (different URLs/cache
  // keys) — fetching them in parallel instead of one-by-one cuts radar feed
  // load latency without changing what is fetched or how results are scored.
  const sourceResults = await Promise.all(sourceSpecs.map(async (spec) => {
    try {
      const result = await getOrFetchCached<Record<string, unknown>>({
        key: `coingecko:base-radar:${spec.key}`,
        ttlMs: shallowMode ? RADAR_SHALLOW_CACHE_TTL_MS : RADAR_FULL_CACHE_TTL_MS,
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
      return { key: spec.key, count, data: count > 0 ? { ...result.data, __radarSourceKey: spec.key } : null }
    } catch {
      return { key: spec.key, count: 0, data: null }
    }
  }))
  for (const r of sourceResults) {
    sourceCounts[r.key] = r.count
    if (r.data) {
      sourcesSucceeded += 1
      sourcePayloads.push(r.data)
    }
  }

  try {
    const pooled: Record<string, unknown>[] = []
    const includedAll: Record<string, unknown>[] = []
    for (const src of sourcePayloads) {
      const pools = Array.isArray(src?.data) ? (src.data as Record<string, unknown>[]) : []
      const included = Array.isArray(src?.included) ? (src.included as Record<string, unknown>[]) : []
      const sourceKey = typeof src?.__radarSourceKey === 'string' ? src.__radarSourceKey : 'unknown'
      pooled.push(...pools.map(pool => ({ ...pool, __radarSourceKey: sourceKey })))
      includedAll.push(...included)
    }

    // Build token lookup from ?include= entities
    const tokenMap = new Map<string, { name: string; symbol: string; address: string; attributes: Record<string, unknown> }>()
    for (const item of includedAll) {
      const attrs = item.attributes as Record<string, unknown> | undefined
      if (item.type === 'token' && attrs?.address) {
        tokenMap.set(item.id as string, {
          name:    typeof attrs.name === 'string' ? attrs.name : 'Unknown',
          symbol:  typeof attrs.symbol === 'string' ? attrs.symbol : '?',
          address: String(attrs.address),
          attributes: attrs,
        })
      }
    }

    const now       = Date.now()
    const TWO_HOURS = 2  * 60 * 60 * 1000
    const DAY_MS    = 24 * 60 * 60 * 1000

    type Candidate = Omit<RadarToken, 'clarkVerdict'> & { pairAddress?: string | null }
    const candidates: Candidate[] = []
    const fallbackCandidates: Candidate[] = []
    const allDay24h:  number[]    = []
    const seenContracts = new Set<string>()
    const seenPools = new Set<string>()

    // SERIAL-BOTTLENECK FIX, DISCLOSED (Base Radar speed audit): getDexMarketCapRescue() used to be
    // awaited inline inside this loop, one pool at a time — for a batch of N pools all missing a
    // resolved market cap on a cold cache, that's N sequential DexScreener round-trips (each with
    // its own 3s timeout) serialized end-to-end, adding many seconds to every cache-miss request.
    // Split into two passes instead: pass 1 runs every synchronous filter/dedup step exactly as
    // before (identical order, identical seenPools/seenContracts semantics — nothing about which
    // pools survive or in what order changes) and, instead of awaiting a needed rescue inline,
    // records a draft with a `needsRescue` flag; pass 2 fires all needed rescues concurrently via
    // Promise.all (each still individually capped by its own timeout and de-duped by
    // getDexMarketCapRescue's own cache/in-flight map — see that function's header); pass 3 replays
    // the exact original post-rescue logic per draft, in the original order, using the resolved
    // rescue result instead of a fresh await.
    type PoolDraft = {
      baseToken: NonNullable<ReturnType<typeof tokenMap.get>>
      ageMinutes: number; liquidityUsd: number; volume24h: number; isPrimaryAgeWindow: boolean; isFallbackAgeWindow: boolean
      fdvUsd: number | null; resolvedMarketCap: ReturnType<typeof resolveBaseRadarMarketCap>; primaryPoolAddress: string | null
      needsRescue: boolean
    }
    const drafts: PoolDraft[] = []

    for (const pool of pooled) {
      const poolId = String(pool.id ?? '').toLowerCase()
      if (poolId && seenPools.has(poolId)) continue
      if (poolId) seenPools.add(poolId)
      const attrs = pool.attributes  as Record<string, unknown>         | undefined
      const rels  = pool.relationships as Record<string, unknown>       | undefined
      const radarSourceKey = typeof pool.__radarSourceKey === 'string' ? pool.__radarSourceKey : 'unknown'
      const volObj = attrs?.volume_usd as Record<string, string>        | undefined
      const createdAt = attrs?.pool_created_at as string | undefined
      if (!createdAt) continue

      const ageMs      = now - new Date(createdAt).getTime()
      const ageMinutes = Math.floor(ageMs / 60000)
      const liquidityUsd = parseFloat(String(attrs?.reserve_in_usd ?? '0')) || 0
      const volume24h    = parseFloat(volObj?.h24 ?? '0') || 0

      if (ageMs < DAY_MS && liquidityUsd >= 1000) allDay24h.push(liquidityUsd)

      const isPrimaryAgeWindow = ageMs < 6 * 60 * 60 * 1000
      const isFallbackAgeWindow = radarSourceKey.startsWith('trending') && ageMs < DAY_MS
      if (!isPrimaryAgeWindow && !isFallbackAgeWindow) continue

      const baseData    = ((rels?.base_token as Record<string, unknown>)?.data) as Record<string, string> | undefined
      const baseToken   = baseData?.id ? tokenMap.get(baseData.id) : undefined
      if (!baseToken) continue

      if (EXCLUDED.has(baseToken.symbol.toUpperCase())) continue

      const key = baseToken.address.toLowerCase()
      if (seenContracts.has(key)) continue
      seenContracts.add(key)

      const fdvUsd = parseFloat(String(attrs?.fdv_usd ?? '0')) || null
      const resolvedMarketCap = resolveBaseRadarMarketCap({ geckoPool: { attributes: attrs }, geckoIncludedToken: { attributes: baseToken.attributes } })
      const primaryPoolAddress = typeof attrs?.address === 'string'
        ? attrs.address
        : poolId.includes('_') ? poolId.split('_').pop() ?? null : null

      drafts.push({
        baseToken, ageMinutes, liquidityUsd, volume24h, isPrimaryAgeWindow, isFallbackAgeWindow,
        fdvUsd, resolvedMarketCap, primaryPoolAddress, needsRescue: resolvedMarketCap.marketCapUsd == null,
      })
    }

    // CONCURRENCY-CAP FIX, DISCLOSED (real regression found while investigating a "market cap not
    // confirming, feed nearly empty" report): the unbounded Promise.all above (kept here as a
    // comment for context) fires every needed rescue call at once — on a batch with many pools
    // missing a market cap, that's a burst of dozens of simultaneous requests to DexScreener's
    // public API. getDexMarketCapRescue treats ANY non-OK response (including a 429 rate-limit)
    // identically to "genuinely no market cap data" — silently returning 'unavailable' with no way
    // to tell the two apart. Unlike the previous sequential-await version (naturally throttled one
    // request at a time), this burst very plausibly trips DexScreener's own rate limiting, causing
    // market cap resolution to fail far more often than before across an entire batch at once —
    // exactly the symptom reported. Capped to a small bounded concurrency instead, preserving most
    // of the original parallelization's speed win while not hammering DexScreener with a burst large
    // enough to trigger rate limiting in the first place.
    const RESCUE_CONCURRENCY_LIMIT = 6
    const rescueResults: (DexScreenerMarketCapRescueResult & { cacheHit: boolean } | null)[] = new Array(drafts.length)
    {
      let nextIndex = 0
      const worker = async () => {
        for (;;) {
          const i = nextIndex++
          if (i >= drafts.length) return
          const d = drafts[i]
          rescueResults[i] = d.needsRescue
            ? await getDexMarketCapRescue({ chain: 'base', token: d.baseToken.address, primaryPoolAddress: d.primaryPoolAddress })
            : null
        }
      }
      await Promise.all(Array.from({ length: Math.min(RESCUE_CONCURRENCY_LIMIT, drafts.length) }, () => worker()))
    }

    // AGGREGATE DIAGNOSTIC, DISCLOSED: surfaces whether rescue failures this request were genuinely
    // "no market cap data" vs. actual DexScreener rate-limiting/HTTP failures — visible via
    // ?debug=1 without needing to guess from user reports again.
    let rescueAttempts = 0, rescueVerified = 0, rescueRateLimited = 0, rescueHttpFailed = 0, rescueTimedOut = 0
    for (const r of rescueResults) {
      if (!r) continue
      rescueAttempts++
      if (r.marketCapStatus === 'verified') rescueVerified++
      else if (r.reason?.includes('rate-limited')) rescueRateLimited++
      else if (r.reason?.includes('timed out')) rescueTimedOut++
      else if (r.reason?.includes('HTTP')) rescueHttpFailed++
    }

    for (let i = 0; i < drafts.length; i++) {
      const { baseToken, ageMinutes, liquidityUsd, volume24h, isPrimaryAgeWindow, isFallbackAgeWindow, fdvUsd, resolvedMarketCap, primaryPoolAddress } = drafts[i]
      const rescue = rescueResults[i]
      const marketCapUsd = resolvedMarketCap.marketCapUsd ?? rescue?.marketCapUsd ?? null
      const marketCapStatus = marketCapUsd != null ? 'verified' : resolvedMarketCap.marketCapStatus
      const marketCapFieldPath = resolvedMarketCap.marketCapUsd != null ? resolvedMarketCap.marketCapFieldPath : rescue?.marketCapFieldPath ?? resolvedMarketCap.marketCapFieldPath
      const resolverReason = resolvedMarketCap.marketCapUsd != null ? resolvedMarketCap.reason : rescue?.reason ?? resolvedMarketCap.reason
      const filterResult = tokenPassesRadarValuationFilters({ marketCapUsd, marketCapStatus, fdvUsd, liquidityUsd, minValuationUsd, minLiquidityUsd, allowFdvFallback })
      const shouldHoldAsFallback = !filterResult.included
        && isFallbackAgeWindow
        && liquidityUsd >= minLiquidityUsd
        && (volume24h >= 5_000 || (liquidityUsd > 0 && volume24h / liquidityUsd >= 0.2))
      if (!filterResult.included && !shouldHoldAsFallback) continue
      const valuation = filterResult.valuation
      const valuationCardDisplay = getRadarValuationCardDisplay(valuation, fmtK)
      const valuationEvidenceGap = getRadarValuationEvidenceGap(valuation)
      const evidenceGaps = [
        ...(valuationEvidenceGap ? [valuationEvidenceGap] : []),
        ...(!filterResult.included ? ['Relaxed fallback: default valuation filter did not pass, but liquidity/volume is active'] : []),
      ]
      const candidate = {
        name: baseToken.name, symbol: baseToken.symbol, contract: baseToken.address,
        ageMinutes, liquidityUsd, volume24h, fdvUsd, marketCapUsd, marketCapStatus, valuationBasis: valuation.basis, valuationUsd: valuation.valueUsd, valuationLabel: valuation.label, valuationSublabel: valuationCardDisplay.sublabel, valuationVerified: valuation.verified, valuationReason: valuation.reason, valuationCortexLine: getRadarCortexValuationLine(valuation), evidenceGaps, riskLevel: 'SAFE', honeypot: null,
        simulationStatus: 'open_check', simulationReason: null, simulationLabel: '', simulationCortexLine: '', pairAddress: primaryPoolAddress,
        ...(debug ? { marketCapDiagnostics: {
          selectedMarketCapUsd: marketCapUsd,
          selectedMarketCapStatus: marketCapStatus,
          selectedMarketCapFieldPath: marketCapFieldPath,
          selectedValuationBasis: valuation.basis,
          fdvUsd,
          rawCandidates: resolvedMarketCap.rawCandidates,
          resolverReason,
          rescueAttempted: rescue != null,
          rescueCacheHit: rescue?.cacheHit ?? false,
          rescuePairCount: rescue?.pairCount ?? 0,
          rescueSelectedPairAddress: rescue?.selectedPairAddress ?? null,
          rescueSelectedDexId: rescue?.selectedDexId ?? null,
          rescueSelectedLiquidityUsd: rescue?.selectedLiquidityUsd ?? null,
          rescueRawCandidates: rescue?.rawCandidates ?? [],
        } } : {}),
      } satisfies Candidate
      if (filterResult.included && isPrimaryAgeWindow) candidates.push(candidate)
      else fallbackCandidates.push(candidate)
    }

    if (candidates.length === 0 && fallbackCandidates.length > 0) {
      candidates.push(...fallbackCandidates)
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

    // 2. Full mode runs honeypot/simulation enrichment; shallow mode keeps the
    // feed to market data plus basic risk flags and does not invent evidence.
    const hpCacheHitFlags = shallowMode ? [] : toCheck.map(t => { const c = honeypotCache.get(t.contract.toLowerCase()); return !!(c && Date.now() - c.cachedAt <= HONEYPOT_CACHE_TTL_MS) })
    const hpResults = shallowMode ? [] : await Promise.allSettled(
      toCheck.map(t => withTimeout(getCachedHoneypot(t.contract, true), 5000, null))
    )

    const scored: Candidate[] = toCheck.map((token, i) => {
      const hp = shallowMode ? null : hpResults[i]?.status === 'fulfilled' ? hpResults[i].value : null
      const simulation = shallowMode
        ? { status: 'open_check' as const, reason: null, label: 'Buy/sell simulation not checked in shallow mode', cortexLine: 'Simulation evidence not fetched in shallow mode.' }
        : getRadarSimulationDisplay({ contract: token.contract, liquidityUsd: token.liquidityUsd, pairAddress: token.pairAddress ?? null, honeypot: hp })
      return {
        ...token,
        honeypot: hp,
        riskLevel: scoreRisk({
          hp,
          simulationStatus: simulation.status,
          ageMinutes: token.ageMinutes,
          liquidityUsd: token.liquidityUsd,
          volume24h: token.volume24h,
        }),
        simulationStatus: simulation.status,
        simulationReason: simulation.reason,
        simulationLabel: simulation.label,
        simulationCortexLine: simulation.cortexLine,
        evidenceGaps: simulation.status === 'passed' ? token.evidenceGaps : Array.from(new Set([...(token.evidenceGaps ?? []), 'Buy/sell simulation not confirmed', simulation.label, 'Honeypot/tax status not confirmed', ...(token.ageMinutes < 15 ? ['Token is very new'] : [])])),
      }
    })

    // 3. Clark verdicts for top 5 by liquidity. Shallow mode skips AI verdicts.
    const top5     = shallowMode ? [] : [...scored].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 5)
    const verdicts = shallowMode ? new Map<string, string>() : await getClarkVerdicts(top5)

    // 4. Final output — newest first for live feed
    const tokens: RadarToken[] = [...scored]
      .sort((a, b) => a.ageMinutes - b.ageMinutes)
      .map(t => { const { pairAddress: _pairAddress, ...rest } = t; return { ...rest, clarkVerdict: verdicts.get(t.contract.toLowerCase()) ?? null } })

    // 5. Stats — counts reflect the final adjusted risk labels (post-scoreRisk),
    // not a raw honeypot-only SAFE default.
    const dangerCount  = scored.filter(t => t.riskLevel === 'DANGER').length
    const cautionCount = scored.filter(t => t.riskLevel === 'CAUTION').length
    const watchCount   = scored.filter(t => t.riskLevel === 'WATCH').length
    const safeCount    = scored.filter(t => t.riskLevel === 'SAFE').length
    const avgLiq       = allDay24h.length > 0 ? allDay24h.reduce((s, v) => s + v, 0) / allDay24h.length : 0
    const counts: [RiskLevel, number][] = [
      ['DANGER', dangerCount],
      ['CAUTION', cautionCount],
      ['WATCH', watchCount],
      ['SAFE', safeCount],
    ]
    const mostCommonRisk: RiskLevel = counts.reduce((best, current) => current[1] > best[1] ? current : best)[0]

    const stats: RadarStats = {
      totalNewTokens:   allDay24h.length,
      averageLiquidity: Math.round(avgLiq),
      mostCommonRisk,
      dangerCount, cautionCount, watchCount, safeCount,
    }

    const limitedLiveFeed = tokens.length > 0 && tokens.length < 5
    const hpHitCount = hpCacheHitFlags.filter(Boolean).length
    const payload = { tokens, stats, fetchedAt: new Date().toISOString(), limitedLiveFeed, mode: requestedMode }
    const debugPayload = {
      sourcesAttempted,
      sourcesSucceeded,
      sourceCounts,
      mergedCount: candidates.length,
      filters: { minValuationUsd, minLiquidityUsd, allowFdvFallback },
      finalTokenCount: tokens.length,
      cacheHit: false,
      mode: requestedMode,
      effectivePlan: plan,
      upsellVisible: false,
      rescueAttempts, rescueVerified, rescueRateLimited, rescueHttpFailed, rescueTimedOut,
      honeypotCacheHits: hpHitCount,
      honeypotCacheMisses: hpCacheHitFlags.length - hpHitCount,
    }
    radarPayloadCache.set(preferredCacheKey, { cachedAt: Date.now(), ttlMs: shallowMode ? RADAR_SHALLOW_CACHE_TTL_MS : RADAR_FULL_CACHE_TTL_MS, payload: { ...payload, _debug: debugPayload } })
    return NextResponse.json({ ...payload, ...(debug ? { _debug: debugPayload } : {}) })
  } catch (err) {
    console.error('[radar] processing error:', err)
    if (cachedPayload) return NextResponse.json(cachedPayload.payload)
    return NextResponse.json({ tokens: [], stats: EMPTY_STATS, fetchedAt: new Date().toISOString(), limitedLiveFeed: false })
  }
}

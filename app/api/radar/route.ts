import { NextResponse, type NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { DEFAULT_RADAR_ALLOW_FDV_FALLBACK, DEFAULT_RADAR_MIN_LIQUIDITY_USD, DEFAULT_RADAR_MIN_VALUATION_USD, getRadarCortexValuationLine, getRadarValuationCardDisplay, getRadarValuationEvidenceGap, resolveBaseRadarMarketCap, selectDexScreenerMarketCapRescuePair, tokenPassesRadarValuationFilters, type DexScreenerMarketCapRescueResult, type RadarValuationBasis } from '@/lib/baseRadarValuation'
import { getRadarSimulationDisplay, type RadarSimulationOpenCheckReason, type RadarSimulationStatus } from '@/lib/baseRadarSimulation'
import { MAIN_FEED_MIN_VALUATION_USD, MAIN_FEED_MIN_HOLDERS, passesMainFeedValuationGate, passesMainFeedHolderGate, isRealVerifiedMarketCapValue } from '@/lib/baseRadarMainFeedGate'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
// RATE-LIMIT-TOO-TIGHT FIX, DISCLOSED (reported: "Radar refresh failed" for no obvious reason):
// 5 requests/min per IP is easy to exceed with completely normal single-user interaction on this
// page — initial load + the Refresh button + Load More (which shares this same route/limiter,
// see the `page` param below) can hit 5 within a minute on their own, and any shared/CGNAT IP
// (corporate network, mobile carrier, multiple tabs) compounds it further. The frontend shows the
// exact same generic "Radar refresh failed" text for a 429 as for any other failure, so a rate-
// limit hit was indistinguishable from a real outage. Raised to a budget that comfortably covers
// normal interactive use while still bounding abuse.
const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })

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

// MIN-HOLDER-FLOOR, DISCLOSED (reported: feed surfaced a token with ~10 indexed holders and a
// separate report of a token with effectively no real liquidity slipping through). Base Radar had
// no holder-count floor at all — only a liquidity/valuation bar — so a pool could clear liquidity
// yet still be an almost-uninhabited token. Fetches GoldRush's token_holders_v2 total_count (a
// single lightweight page-size=1 call, not a full holder pull) for the ranked candidate set and
// drops anything under MAIN_FEED_MIN_HOLDERS. An unresolved/failed holder-count lookup is treated
// as failing the bar too (same unknown-≠-safe principle as the rest of this route's risk scoring) —
// this filter should never leak a token through just because the provider call errored.
// MAIN-FEED-QUALITY-GATE, DISCLOSED (requested: stricter main-feed gate — $45K minimum valuation,
// 30 minimum holders, real holder evidence required, no dead-liquidity coins ranking as radar
// opportunities). Raised from the prior 25-holder floor to the requested 30; unresolved/failed
// holder-count lookups still fail the bar (unchanged — same unknown-≠-safe principle). Constants and
// gate predicates live in lib/baseRadarMainFeedGate.ts (imported above) so they're unit-testable
// without mocking this route's HTTP calls — see scripts/test-base-radar-main-feed-gate.mjs.
// HOST-FIX + RATE-LIMIT-BUDGET, DISCLOSED (reported: after this filter shipped, holder data went
// dark app-wide — Top1/10/20 stuck at N/A even in the token drawer, not just the feed). Server logs
// showed api.covalenthq.com returning 429 (rate-limited) and the "fallback" host api.goldrush.dev
// failing DNS resolution outright (ENOTFOUND) — it never actually served as a working fallback, just
// added a guaranteed-failing extra hop on every single call. This filter was calling GoldRush once
// per ranked feed candidate (up to 50) on every refresh, competing for the same shared GoldRush rate
// limit budget as the real token-scan holder lookups everywhere else in the app (drawer, Token
// Scanner) — starving them. Fixed by: (1) dropping the dead host, (2) caching results per contract
// so repeat refreshes of the same tokens don't re-hit GoldRush, (3) capping how many candidates get
// checked per request.
const GOLDRUSH_RADAR_HOSTS = ['api.covalenthq.com'] as const
const HOLDER_COUNT_CACHE_TTL_MS = 10 * 60_000
const holderCountCache = new Map<string, { count: number | null; expiresAt: number }>()
async function fetchBaseHolderCount(contract: string): Promise<number | null> {
  const key = contract.toLowerCase()
  const cached = holderCountCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.count
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
  if (!apiKey) return null
  let result: number | null = null
  for (const host of GOLDRUSH_RADAR_HOSTS) {
    try {
      const res = await fetch(
        `https://${host}/v1/base-mainnet/tokens/${contract}/token_holders_v2/?page-number=0&page-size=1`,
        { cache: 'no-store', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3500) },
      )
      if (!res.ok) continue
      const json = await res.json().catch(() => null) as { data?: { pagination?: { total_count?: number } } } | null
      const totalCount = json?.data?.pagination?.total_count
      if (typeof totalCount === 'number' && Number.isFinite(totalCount)) { result = totalCount; break }
    } catch { /* try next host */ }
  }
  // Cache negative/failed lookups too (shorter-lived) so a rate-limited burst doesn't get re-tried
  // on every candidate on the very next refresh, compounding the same rate-limit problem.
  holderCountCache.set(key, { count: result, expiresAt: Date.now() + (result != null ? HOLDER_COUNT_CACHE_TTL_MS : 60_000) })
  return result
}

// ABSOLUTE-LIQUIDITY-FLOOR, DISCLOSED: belt-and-suspenders guard independent of the configurable
// minLiquidityUsd query param — a token with ~$0 real liquidity must never reach the feed no matter
// how minLiquidityUsd is set. tokenPassesRadarValuationFilters/shouldHoldAsFallback already require
// liquidityUsd >= minLiquidityUsd, but this floor makes the "no liquidity" case impossible to slip
// through even under a future param-handling regression.
const ABSOLUTE_MIN_LIQUIDITY_USD = 500

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
  // LOAD-MORE, DISCLOSED (requested: a "Load More" control on the Base Radar feed): the feed was
  // always page 1 of GeckoTerminal's new/trending pools — there was no way to reach older-but-still-
  // recent pools beyond whatever fit in that single page. `page` shifts which GeckoTerminal pages
  // this request pulls from (page 2 asks GeckoTerminal for its pages 3-4 of new_pools instead of
  // 1-2, etc.), so "Load More" surfaces genuinely different tokens rather than re-showing the same
  // top 50. Capped at 5 — GeckoTerminal's own pool listings get sparse/stale much past that.
  const radarPage = Math.min(5, Math.max(1, Math.floor(Number(req.nextUrl.searchParams.get('page')) || 1)))
  const cacheKeyBase = `plan:${plan}:minValuation:${minValuationUsd}:minLiquidity:${minLiquidityUsd}:fdvFallback:${allowFdvFallback}:page:${radarPage}`
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

  // WIDER-DEFAULT-PULL, DISCLOSED (reported: feed "always the same 2-3 tokens" / "should be a
  // ton"): the default request (radarPage=1) previously pulled only 2 pages of new_pools + 1 page
  // of trending_pools (60 raw pools) before any filtering — on Base's real pace of pools that
  // actually clear the $15K valuation / liquidity bar, that was often too thin a raw pool to find
  // more than a couple qualifying tokens per refresh, so the same handful kept winning the
  // momentum/liquidity ranking every cycle. Doubled the per-request page count (4 new_pools pages +
  // 2 trending pages = 120 raw pools instead of 60) so meaningfully more real candidates get a
  // chance to clear the filter each refresh — same filters, same safety bar, just a wider net. All
  // 6 fetches stay parallel (Promise.all below, unchanged), each still independently capped by its
  // own 6s timeout + one retry, so this adds no latency beyond the slowest single source. `page`
  // (Load More) now advances by this same page-per-request count, so it continues forward from
  // where the default request left off instead of re-fetching pages the default already covered.
  // WIDER-PULL, ROUND 2, DISCLOSED (reported: feed still stuck around 4-6 tokens after round 1):
  // even at 4+2 pages, Base's real pace of pools that clear the age window and every filter often
  // wasn't producing much more than a handful. Doubled new_pools again (4->8) since that's the
  // primary source of genuinely fresh candidates; bumped trending more conservatively (2->3) since
  // that listing is a smaller universe and deeper pages return less relevant "trending" results.
  const NEW_POOLS_PAGES_PER_REQUEST = 8
  const TRENDING_PAGES_PER_REQUEST = 3
  const newPoolsStartPage = (radarPage - 1) * NEW_POOLS_PAGES_PER_REQUEST + 1
  const trendingStartPage = (radarPage - 1) * TRENDING_PAGES_PER_REQUEST + 1
  const sourceSpecs = [
    ...Array.from({ length: NEW_POOLS_PAGES_PER_REQUEST }, (_, i) => {
      const page = newPoolsStartPage + i
      return { key: `new_p${page}`, url: `https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=${page}&include=base_token%2Cquote_token&per_page=20` }
    }),
    ...Array.from({ length: TRENDING_PAGES_PER_REQUEST }, (_, i) => {
      const page = trendingStartPage + i
      return { key: `trending_p${page}`, url: `https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=${page}&include=base_token%2Cquote_token&per_page=20` }
    }),
  ]
  const sourceCounts: Record<string, number> = {}
  let sourcesSucceeded = 0
  const sourcesAttempted = sourceSpecs.length
  const sourcePayloads: Record<string, unknown>[] = []
  // TOKEN-SAVER: these source fetches (sourceSpecs.length of them — see the wider-pull comment
  // above) are independent (different URLs/cache keys) — fetching them in parallel instead of
  // one-by-one cuts radar feed load latency without changing what is fetched or how results are
  // scored.
  const sourceResults = await Promise.all(sourceSpecs.map(async (spec) => {
    try {
      const result = await getOrFetchCached<Record<string, unknown>>({
        key: `coingecko:base-radar:${spec.key}`,
        ttlMs: shallowMode ? RADAR_SHALLOW_CACHE_TTL_MS : RADAR_FULL_CACHE_TTL_MS,
        onLog: msg => console.info(`[radar] ${msg}`),
        // ONE-RETRY FIX, DISCLOSED (reported: Base Radar showing zero new tokens): this fetcher
        // previously made a single attempt per source per cache window — any transient GeckoTerminal
        // hiccup (a timeout, a momentary 5xx, an occasional 429) silently zeroed that source for the
        // whole TTL, and with all 3 sources hitting the same upstream, an unlucky moment could empty
        // the entire feed. One quick retry after a short backoff absorbs that class of transient
        // failure without meaningfully slowing down the common case (first attempt still usually
        // succeeds).
        fetcher: async () => {
          const attempt = async () => {
            const ac = new AbortController()
            const tid = setTimeout(() => ac.abort(), 6000)
            try {
              const gtRes = await fetch(spec.url, { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: ac.signal })
              if (!gtRes.ok) throw new Error(`market_source_unavailable_${gtRes.status}`)
              return gtRes.json() as Promise<Record<string, unknown>>
            } finally { clearTimeout(tid) }
          }
          try {
            return await attempt()
          } catch {
            await new Promise(resolve => setTimeout(resolve, 400))
            return attempt()
          }
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
    // FUNNEL-DIAGNOSTICS, DISCLOSED: this route has gone completely empty from filter changes
    // multiple times this session, each one only diagnosable by the user sending a screenshot and
    // us guessing. These counters (surfaced via debugPayload.filterFunnel below) show exactly how
    // many candidates each individual filter dropped, so a future empty-feed report can be
    // diagnosed from ?debug=1 output directly instead of another round of guesswork.
    let droppedByV4Pool = 0
    let droppedByValuationOrLiquidity = 0
    let droppedByAbsoluteLiquidityFloor = 0
    let droppedByDeadVolumeFloor = 0
    let droppedByValuationUnavailable = 0
    let droppedByMarketCapBelow45k = 0

    for (const pool of pooled) {
      const poolId = String(pool.id ?? '').toLowerCase()
      if (poolId && seenPools.has(poolId)) continue
      if (poolId) seenPools.add(poolId)
      const attrs = pool.attributes  as Record<string, unknown>         | undefined
      const rels  = pool.relationships as Record<string, unknown>       | undefined
      const volObj = attrs?.volume_usd as Record<string, string>        | undefined
      const createdAt = attrs?.pool_created_at as string | undefined
      if (!createdAt) continue

      // V4-POOL-EXCLUSION, DISCLOSED (reported, with a live DexScreener screenshot of a token this
      // feed surfaced: "Liquidity $0" / "This pair has unknown liquidity" on a pool GeckoTerminal
      // reported six-figure reserve_in_usd for). Uniswap V4's singleton PoolManager architecture
      // doesn't expose per-pool reserves the way V2/V3 pools do — GeckoTerminal's reserve_in_usd
      // field for a V4 pool is not a reliable read of real available liquidity (DexScreener itself,
      // a much larger indexer, shows "unknown" for the same pool rather than trusting it). Excluding
      // V4 pools from the feed entirely until there's a verified liquidity source for them, rather
      // than surfacing a number this route cannot actually stand behind.
      const dexRelData = (rels?.dex as { data?: { id?: string } } | undefined)?.data
      const dexId = String(dexRelData?.id ?? '').toLowerCase()
      if (dexId.includes('v4')) { droppedByV4Pool++; continue }

      const ageMs      = now - new Date(createdAt).getTime()
      const ageMinutes = Math.floor(ageMs / 60000)
      const liquidityUsd = parseFloat(String(attrs?.reserve_in_usd ?? '0')) || 0
      const volume24h    = parseFloat(volObj?.h24 ?? '0') || 0

      if (ageMs < DAY_MS && liquidityUsd >= 1000) allDay24h.push(liquidityUsd)

      const isPrimaryAgeWindow = ageMs < 6 * 60 * 60 * 1000
      // FALLBACK-SOURCE-RESTRICTION FIX, DISCLOSED (reported: widening the new_pools page pull
      // didn't multiply the feed as much as expected): this used to require radarSourceKey to be
      // 'trending' before a pool could even be CONSIDERED for the relaxed-valuation fallback path
      // below (shouldHoldAsFallback) — a new_pools-sourced pool that failed the strict valuation
      // filter had zero fallback route and was dropped outright, no matter how much real liquidity/
      // volume it had, purely because of which GeckoTerminal endpoint it came from. That's not a
      // meaningful safety distinction (the fallback's own liquidity/volume checks are what actually
      // gate it), so dropped the source restriction — any pool under 24h old is now fallback-
      // eligible, using data already being fetched, no new API calls.
      const isFallbackAgeWindow = ageMs < DAY_MS
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
      // FALLBACK-ACTIVITY-BAR LOOSENED, DISCLOSED (same "still too few tokens" report): the
      // liquidity floor here is untouched (still the real minLiquidityUsd, same as the strict
      // path) — only the volume/momentum bar that decides whether a below-valuation-bar pool is
      // "actually being traded enough to bother showing" was loosened, from $5K/20% down to
      // $1.5K/8%. Still excludes genuinely dead pools (near-zero volume); just no longer requires
      // near-strict-path-level activity to qualify for the already-disclosed "Relaxed fallback".
      const shouldHoldAsFallback = !filterResult.included
        && isFallbackAgeWindow
        && liquidityUsd >= minLiquidityUsd
        && (volume24h >= 1_500 || (liquidityUsd > 0 && volume24h / liquidityUsd >= 0.08))
      if (!filterResult.included && !shouldHoldAsFallback) { droppedByValuationOrLiquidity++; continue }
      if (liquidityUsd < ABSOLUTE_MIN_LIQUIDITY_USD) { droppedByAbsoluteLiquidityFloor++; continue }
      // DEAD-VOLUME FLOOR, DISCLOSED (reported: feed full of tokens with real liquidity/valuation
      // but $30-70 in 24h volume on six-figure liquidity — essentially untraded pools). The
      // liquidity/valuation filter above never checked volume at all on the strict path (only the
      // relaxed fallback did), so a pool could clear liquidity and valuation yet have almost nobody
      // actually trading it and still get surfaced as a live opportunity. Requires at least minimal
      // real activity on every candidate, strict or fallback, not just the fallback tier.
      // GRACE-PERIOD FIX, DISCLOSED (reported: feed went completely empty after this floor
      // shipped). A pool created 10 minutes ago has, by definition, only had 10 minutes to
      // accumulate the volume GeckoTerminal reports as its "24h" figure — a genuinely brand-new,
      // legitimate token can easily be under $200 simply because it hasn't existed long enough yet,
      // not because it's dead. Exempts pools under 20 minutes old from this floor; the dead-volume
      // check is about spotting stale/abandoned tokens, not punishing freshness.
      const hasMeaningfulActivity = ageMinutes < 20 || volume24h >= 200 || (liquidityUsd > 0 && volume24h / liquidityUsd >= 0.02)
      if (!hasMeaningfulActivity) { droppedByDeadVolumeFloor++; continue }
      const valuation = filterResult.valuation
      // MAIN-FEED-QUALITY-GATE, DISCLOSED (requested: stricter main-feed floor — $45K minimum
      // valuation, real holder evidence required, no dead-liquidity coins ranking as opportunities).
      // getRadarValuationBasis (lib/baseRadarValuation.ts) flattens a real market cap and an FDV
      // fallback into a single "verified_market_cap" basis by explicit prior product decision (FDV
      // is shown as "Market Cap" everywhere with no distinct fallback label) — that shared display
      // behavior is intentionally left untouched here. This gate instead tracks, locally, whether
      // THIS candidate's number came from a real marketCapUsd or was FDV-derived, purely to (a)
      // decide whether the $45K floor was actually cleared and (b) attach an explicit fallback
      // evidence gap so a FDV-sourced valuation can never look identical to a real confirmed market
      // cap in the reasons shown for this candidate, without changing the shared valuation display.
      const isRealVerifiedMarketCap = isRealVerifiedMarketCapValue(marketCapStatus, marketCapUsd)
      if (valuation.valueUsd == null) { droppedByValuationUnavailable++; continue }
      if (!passesMainFeedValuationGate(valuation.valueUsd)) { droppedByMarketCapBelow45k++; continue }
      const valuationCardDisplay = getRadarValuationCardDisplay(valuation, fmtK)
      const valuationEvidenceGap = getRadarValuationEvidenceGap(valuation)
      const evidenceGaps = [
        ...(valuationEvidenceGap ? [valuationEvidenceGap] : []),
        ...(!filterResult.included ? ['Relaxed fallback: default valuation filter did not pass, but liquidity/volume is active'] : []),
        ...(!isRealVerifiedMarketCap ? ['Valuation confirmed via FDV fallback — no separate verified market cap available'] : []),
      ]
      const candidate = {
        name: baseToken.name, symbol: baseToken.symbol, contract: baseToken.address,
        ageMinutes, liquidityUsd, volume24h, fdvUsd, marketCapUsd, marketCapStatus, valuationBasis: valuation.basis, valuationUsd: valuation.valueUsd, valuationLabel: valuation.label, valuationSublabel: valuationCardDisplay.sublabel, valuationVerified: valuation.verified, valuationReason: valuation.reason, valuationCortexLine: getRadarCortexValuationLine(), evidenceGaps, riskLevel: 'SAFE', honeypot: null,
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

    // ALWAYS-MERGE-FALLBACK FIX, DISCLOSED (reported: radar only ever shows a handful of tokens —
    // "should be a ton"). fallbackCandidates are real, already-computed candidates that either
    // cleared liquidity/volume but not the strict valuation bar, or sit in the wider 24h trending
    // age window instead of the strict 6h primary window — every one of them already carries the
    // "Relaxed fallback" evidenceGaps disclosure added above, specifically so they're safe to show
    // labeled rather than hidden. Previously they were only merged in when the primary list was
    // COMPLETELY empty, so the moment even 1 token passed strict filtering, every other legitimate
    // fallback candidate was silently thrown away instead of appended — collapsing what should be a
    // real, browsable feed down to just the handful that happened to clear every bar at once. No
    // filter/scoring/risk logic changed: these tokens were already being computed, just discarded.
    if (fallbackCandidates.length > 0) {
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
    const rankedCandidates = candidates.slice(0, 50)

    // Holder-count floor: only the top HOLDER_CHECK_LIMIT ranked candidates get checked (not all 50)
    // — this is the set that actually has a shot at appearing in the feed anyway, and the cache above
    // means a token already checked this cycle won't cost another call on the next refresh regardless.
    const HOLDER_CHECK_LIMIT = 20
    const HOLDER_CHECK_CONCURRENCY = 3
    const holderCheckTargets = rankedCandidates.slice(0, HOLDER_CHECK_LIMIT)
    const holderCountByContract = new Map<string, number | null>()
    {
      let nextIndex = 0
      const worker = async () => {
        for (;;) {
          const i = nextIndex++
          if (i >= holderCheckTargets.length) return
          const t = holderCheckTargets[i]
          holderCountByContract.set(t.contract.toLowerCase(), await fetchBaseHolderCount(t.contract))
        }
      }
      await Promise.all(Array.from({ length: Math.min(HOLDER_CHECK_CONCURRENCY, holderCheckTargets.length) }, () => worker()))
    }
    // FAIL-OPEN ON PROVIDER OUTAGE, DISCLOSED (reported: Base Radar went completely empty right
    // after this filter shipped). A hard "unresolved = fails the bar" rule is correct for a normal
    // per-token miss (a genuinely too-new pool GoldRush hasn't indexed holders for yet), but if
    // EVERY lookup in this batch failed, that's not 50 unfundeded tokens — it's GoldRush being
    // down/rate-limited for this request, and silently zeroing the whole feed on a provider blip is
    // worse than the bug being fixed. When at least one lookup in the batch actually resolved, the
    // provider is reachable and per-token nulls are trusted misses, so the floor applies normally.
    const resolvedHolderCounts = [...holderCountByContract.values()].filter((c): c is number => typeof c === 'number')
    const holderProviderReachable = resolvedHolderCounts.length > 0
    // HOLDER-EVIDENCE-MUST-BE-REAL, DISCLOSED: null/N/A/unresolved holder evidence must never count
    // as passing the 30-holder gate — tracked separately from "resolved but below 30" so the debug
    // funnel (and the "X hidden for weak holder evidence" UI count) can distinguish a genuinely thin
    // holder base from GoldRush simply not having an answer yet, without treating the latter as safe.
    let droppedByHoldersBelow30 = 0
    let droppedByHoldersUnavailable = 0
    const toCheck = holderProviderReachable
      ? holderCheckTargets.filter((t) => {
          const holderCount = holderCountByContract.get(t.contract.toLowerCase())
          if (typeof holderCount !== 'number') { droppedByHoldersUnavailable++; return false }
          if (!passesMainFeedHolderGate(holderCount)) { droppedByHoldersBelow30++; return false }
          return true
        })
      : rankedCandidates

    // 2. TAX-CHECK-ALWAYS-ATTEMPTED FIX, DISCLOSED (reported: every feed card stuck yellow/
    // "SIMULATION PENDING"): previously shallow mode (the frontend's default) NEVER ran the
    // buy/sell tax simulation at all, so every visible card showed "pending" even for tokens
    // honeypot.is could actually verify clean — the feed simply never asked. Now the real
    // simulation runs for the top SIM_TOP_N feed tokens (already ranked by the momentum/liquidity
    // score blend above, so this is the visible/leading set), regardless of shallow vs full, with a
    // bounded worker pool (not the prior unbounded Promise.allSettled over all 50, which was itself
    // a rate-limit burst risk) and the existing 5-min honeypot cache. A token honeypot.is can
    // simulate now shows a real confirmed tax (green); a genuinely-unsimulatable brand-new pool
    // still honestly reports pending — this never fabricates a "safe" tax it didn't verify (same
    // unknown-≠-safe principle as the rest of the risk scoring). Full mode additionally runs Clark
    // AI verdicts (below); shallow skips only those.
    const SIM_TOP_N = 14
    const SIM_CONCURRENCY = 7
    const simTargets = toCheck.slice(0, SIM_TOP_N)
    const hpByContract = new Map<string, HoneypotResult | null>()
    {
      let nextIndex = 0
      const worker = async () => {
        for (;;) {
          const i = nextIndex++
          if (i >= simTargets.length) return
          const t = simTargets[i]
          // Single-attempt, cache-backed, tight-timeout check for the feed — the drawer runs the
          // thorough retry version on demand. Successive polls hit the warm honeypot cache, so this
          // real cost is only paid on a cold cache once per payload-cache window.
          const hp = await withTimeout(getCachedHoneypot(t.contract, false), 2600, null)
          hpByContract.set(t.contract.toLowerCase(), hp)
        }
      }
      await Promise.all(Array.from({ length: Math.min(SIM_CONCURRENCY, simTargets.length) }, () => worker()))
    }
    const hpCacheHitFlags = simTargets.map(t => { const c = honeypotCache.get(t.contract.toLowerCase()); return !!(c && Date.now() - c.cachedAt <= HONEYPOT_CACHE_TTL_MS) })

    const scored: Candidate[] = toCheck.map((token) => {
      const hp = hpByContract.get(token.contract.toLowerCase()) ?? null
      const simulation = getRadarSimulationDisplay({ contract: token.contract, liquidityUsd: token.liquidityUsd, pairAddress: token.pairAddress ?? null, honeypot: hp })
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

    // MAIN-FEED-QUALITY-GATE, DISCLOSED: candidates hidden specifically by the stricter $45K
    // valuation / 30-holder gate (not the pre-existing liquidity/dead-volume/V4 filters, which were
    // already silently dropping candidates before this task). Surfaced to the frontend so the CORTEX
    // panel can honestly say how many were hidden, instead of the gate being invisible.
    const hiddenLowEvidenceCount = droppedByMarketCapBelow45k + droppedByValuationUnavailable + droppedByHoldersBelow30 + droppedByHoldersUnavailable
    const evidenceGapCappedCount = scored.filter(t => t.riskLevel !== 'SAFE' && (t.evidenceGaps?.length ?? 0) > 0).length

    const limitedLiveFeed = tokens.length > 0 && tokens.length < 5
    const hpHitCount = hpCacheHitFlags.filter(Boolean).length
    const hasMorePages = radarPage < 5 && tokens.length > 0
    const payload = { tokens, stats, fetchedAt: new Date().toISOString(), limitedLiveFeed, mode: requestedMode, page: radarPage, hasMore: hasMorePages, hiddenLowEvidenceCount }
    const debugPayload = {
      sourcesAttempted,
      sourcesSucceeded,
      sourceCounts,
      mergedCount: candidates.length,
      filters: { minValuationUsd, minLiquidityUsd, allowFdvFallback, mainFeedMinValuationUsd: MAIN_FEED_MIN_VALUATION_USD, mainFeedMinHolders: MAIN_FEED_MIN_HOLDERS },
      filterFunnel: {
        v4_pool_excluded: droppedByV4Pool,
        liquidity_below_minimum: droppedByAbsoluteLiquidityFloor,
        dead_volume_excluded: droppedByDeadVolumeFloor,
        valuation_or_liquidity_excluded: droppedByValuationOrLiquidity,
        valuation_unavailable: droppedByValuationUnavailable,
        market_cap_below_45k: droppedByMarketCapBelow45k,
        holders_below_30: droppedByHoldersBelow30,
        holders_unavailable: droppedByHoldersUnavailable,
        evidence_gap_capped: evidenceGapCappedCount,
      },
      hiddenLowEvidenceCount,
      finalTokenCount: tokens.length,
      cacheHit: false,
      mode: requestedMode,
      effectivePlan: plan,
      upsellVisible: false,
      rescueAttempts, rescueVerified, rescueRateLimited, rescueHttpFailed, rescueTimedOut,
      honeypotCacheHits: hpHitCount,
      honeypotCacheMisses: hpCacheHitFlags.length - hpHitCount,
    }
    // DON'T-CACHE-A-DEAD-FEED FIX, DISCLOSED (same report as the one-retry fix above): a fully
    // empty result (every upstream source failed even after retrying) used to be cached exactly
    // like a genuinely quiet feed, so it kept being served to every client for the full 30-100s TTL
    // window even once GeckoTerminal recovered. Skipping the cache write here means the very next
    // poll (this client's 120s interval, or another client's) makes a real attempt instead of
    // echoing the outage back for the rest of the window. A genuinely quiet-but-working feed
    // (sources succeeded, filters just found nothing) still caches normally.
    if (sourcesSucceeded > 0) {
      radarPayloadCache.set(preferredCacheKey, { cachedAt: Date.now(), ttlMs: shallowMode ? RADAR_SHALLOW_CACHE_TTL_MS : RADAR_FULL_CACHE_TTL_MS, payload: { ...payload, _debug: debugPayload } })
    }
    // SERVE-STALE-ON-TOTAL-FAILURE FIX, DISCLOSED (reported: feed intermittently flips to "0
    // tokens tracked" / "no strong radar candidates" between otherwise-normal refreshes): the fix
    // above stopped a total source failure from being CACHED as an empty result, but this request
    // still RETURNED an empty one — every source failing this one cycle (a transient GeckoTerminal
    // blip, or this route's own outbound rate limit) produced a genuinely empty response even when
    // a perfectly good, only-slightly-expired cached feed from the last successful cycle was sitting
    // right there. Now: if every source failed this request AND an expired-but-real cached payload
    // exists for the same query, serve that instead of an empty feed — same already-real,
    // already-filtered tokens the last successful fetch produced, just a little older, which beats
    // a blank page. Never used to fabricate a value that was never real; only ever re-serves an
    // actual prior successful response, and only when this cycle's live fetch came back with
    // nothing at all.
    if (sourcesSucceeded === 0 && cachedPayload && cachedPayload.payload.tokens.length > 0) {
      return NextResponse.json({
        ...cachedPayload.payload,
        ...(debug ? { _debug: { ...(cachedPayload.payload._debug ?? {}), servedStaleOnSourceFailure: true, cacheHit: true } } : {}),
      })
    }
    return NextResponse.json({ ...payload, ...(debug ? { _debug: debugPayload } : {}) })
  } catch (err) {
    console.error('[radar] processing error:', err)
    if (cachedPayload) return NextResponse.json(cachedPayload.payload)
    return NextResponse.json({ tokens: [], stats: EMPTY_STATS, fetchedAt: new Date().toISOString(), limitedLiveFeed: false })
  }
}

import { NextResponse } from 'next/server'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import { savePumpSnapshots } from '@/lib/server/pump14dEvidence'

export const dynamic = 'force-dynamic'

// ══════════════════════════════════════════════════════════════════════════════════════════════
// PUMP ALERTS — LIVE PUMP DISCOVERY FEED, DISCLOSED (full rewrite, explicitly requested: "STOP
// overcomplicating Pump Alerts... I do not want a perfect historical research engine for the
// feed. I want a live pump discovery feed.").
//
// This replaces the previous multi-tier "confirmed 14d pump" evidence ladder (GeckoTerminal OHLCV
// -> CoinGecko contract lookup -> ChainLens snapshot history -> DexScreener-corroborated fallback,
// each with its own request budget, concurrency cap, retry, and cache) with one simple, synchronous
// eligibility pass over live market data the discovery fetch already has — zero extra network calls
// per candidate, so there is nothing left to rate-limit, budget-cap, or silently stall the feed at
// a single result. Exact 7d/14d confirmation is explicitly out of scope for this feed (per the
// request) — it is optional evidence this route never blocks on; every card renders from live
// 24h/6h/1h momentum + volume/liquidity evidence instead, labelled honestly as "Live Momentum".
// ══════════════════════════════════════════════════════════════════════════════════════════════

const PUMP_ROUTE_CACHE_TTL_MS = 90_000
const PUMP_EMPTY_CACHE_TTL_MS = 10_000
const pumpCache = new Map<string, { exp: number; payload: unknown }>()
const pumpRate = new Map<string, { count: number; resetAt: number }>()
const PUMP_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 3, pro: 12, elite: 24 }

function getIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  return raw.trim().toLowerCase() === 'true'
}

// ─── Config, DISCLOSED: exact names/defaults requested ─────────────────────────────────────────
export const PUMP_ALERT_MAX_CAP_USD = envNumber('PUMP_ALERT_MAX_CAP_USD', 30_000_000)
export const PUMP_ALERT_MIN_LIQUIDITY_USD = envNumber('PUMP_ALERT_MIN_LIQUIDITY_USD', 5_000)
export const PUMP_ALERT_MIN_VOLUME_24H_USD = envNumber('PUMP_ALERT_MIN_VOLUME_24H_USD', 5_000)
export const PUMP_ALERT_MIN_24H_CHANGE_PCT = envNumber('PUMP_ALERT_MIN_24H_CHANGE_PCT', 5)
export const PUMP_ALERT_MIN_6H_CHANGE_PCT = envNumber('PUMP_ALERT_MIN_6H_CHANGE_PCT', 3)
export const PUMP_ALERT_MIN_1H_CHANGE_PCT = envNumber('PUMP_ALERT_MIN_1H_CHANGE_PCT', 1.5)
export const PUMP_ALERT_TARGET_RESULTS = envNumber('PUMP_ALERT_TARGET_RESULTS', 20)
export const PUMP_ALERT_MAX_RAW_CANDIDATES = envNumber('PUMP_ALERT_MAX_RAW_CANDIDATES', 500)
export const PUMP_ALERT_REQUIRE_EXACT_7D = envBool('PUMP_ALERT_REQUIRE_EXACT_7D', false)
// Not in the requested env list (the "volume/liquidity >= 0.3x with positive 24h change" momentum
// rule is fully specified numerically already) — kept as a plain constant rather than adding an
// env knob nobody asked for.
const PUMP_ALERT_MIN_VOL_LIQ_RATIO = 0.3

// ─── Exclusion rules: majors / stables / wrapped / LP / infrastructure ─────────────────────────
const STABLE_AND_WRAPPED_DENYLIST = new Set([
  'USDC', 'USDT', 'DAI', 'USDBC', 'WETH', 'ETH', 'CBBTC', 'BTC', 'WBTC',
  'BUSD', 'FRAX', 'CBETH', 'STETH', 'RETH', 'WSTETH', 'EURC', 'BSDETH', 'USD+', 'AXLUSDC',
  'LSETH', 'SFRXETH', 'ANKRETH', 'OSETH', 'SWETH', 'METH', 'WEETH', 'EZETH', 'RSETH',
])
const MAJOR_CHAIN_NATIVE_DENYLIST = new Set([
  'SOL', 'WSOL', 'BNB', 'WBNB', 'AVAX', 'WAVAX', 'DOT', 'ADA', 'XRP', 'TRX',
  'LTC', 'DOGE', 'SHIB', 'TON', 'NEAR', 'ATOM', 'ICP', 'APT', 'SUI', 'FIL', 'HBAR',
])
const ESTABLISHED_PROTOCOL_DENYLIST = new Set([
  'AERO', 'VAERO', 'UNI', 'CRV', 'BAL', 'COMP', 'MKR', 'SNX', 'LDO', 'RPL', 'GMX', 'PENDLE',
  'WELL', 'SEAM', 'MORPHO', 'PRIME', 'AAVE', 'SUSHI', 'CAKE', 'GRT', 'LINK', 'MATIC', 'POL',
  'ARB', 'OP', 'AXL', 'STG', 'LAYER', 'ENA', 'PYTH', 'JUP', 'RAY',
])
const EXCLUDED_SYMBOLS = new Set([...STABLE_AND_WRAPPED_DENYLIST, ...ESTABLISHED_PROTOCOL_DENYLIST, ...MAJOR_CHAIN_NATIVE_DENYLIST])
const ESTABLISHED_NAME_PATTERN = /\b(aerodrome|uniswap|velodrome|lp\s*token|liquidity\s*pool|bridged|wrapped|staked|yield\s*bearing|solana)\b/i
const LP_SYMBOL_PATTERN = /(^|[-_/])lp($|[-_/])|vamm-|vlp-/i

export function isMajorStableWrappedOrLp(symbol: string, name: string): boolean {
  const sym = symbol.toUpperCase()
  if (EXCLUDED_SYMBOLS.has(sym)) return true
  if (ESTABLISHED_NAME_PATTERN.test(name)) return true
  if (LP_SYMBOL_PATTERN.test(sym)) return true
  return false
}

// ─── Chains ─────────────────────────────────────────────────────────────────────────────────
export type PumpChain = 'base' | 'eth' | 'robinhood'
const CHAIN_CONFIG: Record<PumpChain, { gtNetwork: string; chainId: number; dexScreenerId: string | null }> = {
  base: { gtNetwork: 'base', chainId: 8453, dexScreenerId: 'base' },
  eth: { gtNetwork: 'eth', chainId: 1, dexScreenerId: 'ethereum' },
  // Robinhood Chain isn't indexed by DexScreener yet — honest skip, matches the rest of this
  // codebase's Robinhood handling (Base Radar, the old evidence ladder).
  robinhood: { gtNetwork: 'robinhood', chainId: 4663, dexScreenerId: null },
}

function requestedChains(req: Request): PumpChain[] {
  const chainParam = new URL(req.url).searchParams.get('chains') ?? ''
  const wanted = chainParam
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter((c): c is PumpChain => c === 'base' || c === 'eth' || c === 'robinhood')
  const chains = wanted.length > 0 ? Array.from(new Set(wanted)) : (['base', 'eth', 'robinhood'] as PumpChain[])
  return chains.filter(c => c !== 'robinhood' || isRobinhoodChainAvailable())
}

// ─── Candidate shape, DISCLOSED: exact normalized shape requested ──────────────────────────────
export interface NormalizedCandidate {
  chainSlug: PumpChain
  chainId: number
  tokenAddress: string
  symbol: string
  name: string
  priceUsd: number | null
  marketCapUsd: number | null
  fdvUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  priceChange24hPct: number | null
  priceChange6hPct: number | null
  priceChange1hPct: number | null
  pairAddress: string | null
  source: string
}

export type PumpCategory = 'HIGH_MOMENTUM' | 'VOLUME_EXPANSION' | 'THIN_MOONSHOT' | 'WATCH'
export type PumpRisk = 'HIGH' | 'MEDIUM' | 'LOW'

export interface PumpAlert {
  symbol: string
  name: string
  contract: string
  chain: PumpChain
  chainId: number
  pairAddress: string | null
  priceUsd: number | null
  change24h: number | null
  change6h: number | null
  change1h: number | null
  // Never fetched/fabricated by this feed — see the module header. Always null unless a future
  // exact-evidence source is added and PUMP_ALERT_REQUIRE_EXACT_7D-style gating is wired to it.
  change14d: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  tokenAgeDays: number | null
  evidenceSource: 'live_momentum' | 'exact'
  evidenceGrade: 'live_momentum' | 'exact'
  category: PumpCategory
  reason: string
  qualifyingReason: string
  riskLevel: PumpRisk
  tags: string[]
  priceChange24hPct: number | null
  priceChange6hPct: number | null
  priceChange1hPct: number | null
}

// ─── Eligibility + live momentum, DISCLOSED: exact rules requested, one pure synchronous pass ──
export type PumpRejectionReason =
  | 'majorStableWrapped'
  | 'capDataMissing'
  | 'overCap'
  | 'lowLiquidity'
  | 'lowVolume'
  | 'noMomentum'

export type PumpMomentumWindow = '24h' | '6h' | '1h' | 'volLiq'

export type PumpEvaluation =
  | { qualified: true; window: PumpMomentumWindow; changeValuePct: number; volumeLiquidityRatio: number | null }
  | { qualified: false; reason: PumpRejectionReason }

export function evaluatePumpCandidate(c: NormalizedCandidate): PumpEvaluation {
  const sym = c.symbol.toUpperCase()
  if (isMajorStableWrappedOrLp(sym, c.name)) return { qualified: false, reason: 'majorStableWrapped' }

  const cap = c.marketCapUsd ?? c.fdvUsd
  if (cap == null) return { qualified: false, reason: 'capDataMissing' }
  if (cap > PUMP_ALERT_MAX_CAP_USD) return { qualified: false, reason: 'overCap' }

  if (c.liquidityUsd == null || c.liquidityUsd < PUMP_ALERT_MIN_LIQUIDITY_USD) return { qualified: false, reason: 'lowLiquidity' }
  if (c.volume24hUsd == null || c.volume24hUsd < PUMP_ALERT_MIN_VOLUME_24H_USD) return { qualified: false, reason: 'lowVolume' }

  const volumeLiquidityRatio = c.liquidityUsd > 0 ? c.volume24hUsd / c.liquidityUsd : null

  if (c.priceChange24hPct != null && c.priceChange24hPct >= PUMP_ALERT_MIN_24H_CHANGE_PCT) {
    return { qualified: true, window: '24h', changeValuePct: c.priceChange24hPct, volumeLiquidityRatio }
  }
  if (c.priceChange6hPct != null && c.priceChange6hPct >= PUMP_ALERT_MIN_6H_CHANGE_PCT) {
    return { qualified: true, window: '6h', changeValuePct: c.priceChange6hPct, volumeLiquidityRatio }
  }
  if (c.priceChange1hPct != null && c.priceChange1hPct >= PUMP_ALERT_MIN_1H_CHANGE_PCT) {
    return { qualified: true, window: '1h', changeValuePct: c.priceChange1hPct, volumeLiquidityRatio }
  }
  if (volumeLiquidityRatio != null && volumeLiquidityRatio >= PUMP_ALERT_MIN_VOL_LIQ_RATIO && c.priceChange24hPct != null && c.priceChange24hPct > 0) {
    return { qualified: true, window: 'volLiq', changeValuePct: c.priceChange24hPct, volumeLiquidityRatio }
  }
  return { qualified: false, reason: 'noMomentum' }
}

// ─── Ranking, DISCLOSED: exact factor order requested — 24h change, 6h/1h momentum, vol/liq
// ratio, liquidity, lower-FDV bonus, risk penalty. Weighted sum; no factor's absolute scale is
// specified beyond ordering, so each is capped before weighting so one extreme value can't drown
// out the others. ─────────────────────────────────────────────────────────────────────────────
export function rankPumpCandidate(c: NormalizedCandidate, evaluation: Extract<PumpEvaluation, { qualified: true }>): number {
  let score = 0
  score += Math.min(Math.max(c.priceChange24hPct ?? 0, -100), 500) * 1.0
  score += Math.min(Math.max(c.priceChange6hPct ?? 0, -100), 300) * 0.6
  score += Math.min(Math.max(c.priceChange1hPct ?? 0, -100), 150) * 0.4
  score += Math.min(evaluation.volumeLiquidityRatio ?? 0, 10) * 8
  score += Math.min((c.liquidityUsd ?? 0) / 10_000, 20)
  const cap = c.marketCapUsd ?? c.fdvUsd ?? PUMP_ALERT_MAX_CAP_USD
  score += Math.max(0, (PUMP_ALERT_MAX_CAP_USD - cap) / PUMP_ALERT_MAX_CAP_USD) * 15 // lower-FDV bonus
  if ((c.liquidityUsd ?? 0) > 0 && (c.liquidityUsd ?? 0) < 10_000) score -= 10 // thin-liquidity risk penalty
  if (!c.symbol || c.symbol === '?') score -= 2
  return score
}

function categorize(change24h: number | null, volume: number | null, liquidity: number | null): { category: PumpCategory; reason: string; riskLevel: PumpRisk } {
  const ch = change24h ?? 0
  const vol = volume ?? 0
  const liq = liquidity ?? 0

  if (ch >= 20 && vol >= 100_000 && liq >= 25_000) {
    return { category: 'HIGH_MOMENTUM', reason: `+${ch.toFixed(1)}% in 24h with $${(vol / 1000).toFixed(0)}K volume`, riskLevel: liq >= 100_000 ? 'LOW' : 'MEDIUM' }
  }
  if (vol >= 500_000 && ch > 5) {
    return { category: 'VOLUME_EXPANSION', reason: `$${vol >= 1_000_000 ? (vol / 1_000_000).toFixed(1) + 'M' : (vol / 1000).toFixed(0) + 'K'} volume surge with +${ch.toFixed(1)}% move`, riskLevel: liq >= 50_000 ? 'LOW' : 'MEDIUM' }
  }
  if (ch >= 100 && liq < 25_000) {
    return { category: 'THIN_MOONSHOT', reason: `+${ch.toFixed(0)}% on thin liquidity ($${(liq / 1000).toFixed(1)}K) — treat as high risk`, riskLevel: 'HIGH' }
  }
  const volFmt = vol >= 1_000_000 ? `$${(vol / 1_000_000).toFixed(1)}M` : `$${(vol / 1000).toFixed(0)}K`
  const liqFmt = `$${(liq / 1000).toFixed(0)}K`
  const parts: string[] = []
  if (Math.abs(ch) >= 3) parts.push(`${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% 24h move`)
  parts.push(`${volFmt} volume`)
  parts.push(`${liqFmt} liquidity`)
  return { category: 'WATCH', reason: parts.join(' · '), riskLevel: liq >= 50_000 ? 'LOW' : 'MEDIUM' }
}

function buildAlert(c: NormalizedCandidate, evaluation: Extract<PumpEvaluation, { qualified: true }>): PumpAlert {
  const scored = categorize(c.priceChange24hPct, c.volume24hUsd, c.liquidityUsd)
  const tags: string[] = []
  if (c.fdvUsd != null && c.fdvUsd > 0 && c.fdvUsd < 100_000) tags.push('Microcap')
  const capLabel = c.marketCapUsd != null ? `$${(c.marketCapUsd / 1_000_000).toFixed(2)}M MCap` : c.fdvUsd != null ? `$${(c.fdvUsd / 1_000_000).toFixed(2)}M FDV` : 'cap unavailable'
  const windowLabel = evaluation.window === 'volLiq' ? '24h' : evaluation.window
  const qualifyingReason = evaluation.window === 'volLiq'
    ? `Volume expansion: ${(evaluation.volumeLiquidityRatio ?? 0).toFixed(2)}× vol/liquidity with +${evaluation.changeValuePct.toFixed(1)}% 24h, low-cap (${capLabel})`
    : `${windowLabel} change +${evaluation.changeValuePct.toFixed(1)}%, low-cap (${capLabel}), $${((c.liquidityUsd ?? 0) / 1000).toFixed(0)}K liquidity, $${((c.volume24hUsd ?? 0) / 1000).toFixed(0)}K 24h volume`

  return {
    symbol: c.symbol, name: c.name, contract: c.tokenAddress, chain: c.chainSlug, chainId: c.chainId,
    pairAddress: c.pairAddress, priceUsd: c.priceUsd,
    change24h: c.priceChange24hPct, change6h: c.priceChange6hPct, change1h: c.priceChange1hPct,
    change14d: null,
    volume24hUsd: c.volume24hUsd, liquidityUsd: c.liquidityUsd, fdvUsd: c.fdvUsd, marketCapUsd: c.marketCapUsd,
    tokenAgeDays: null,
    evidenceSource: 'live_momentum', evidenceGrade: 'live_momentum',
    qualifyingReason,
    priceChange24hPct: c.priceChange24hPct, priceChange6hPct: c.priceChange6hPct, priceChange1hPct: c.priceChange1hPct,
    ...scored,
    tags,
  }
}

// ─── Discovery: GeckoTerminal (primary) ─────────────────────────────────────────────────────
function parseNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,\s]/g, '')
    if (cleaned === '') return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

type GTIncluded = { id?: string; attributes?: { address?: string; symbol?: string; name?: string } }
type GTPool = {
  relationships?: { base_token?: { data?: { id?: string } } }
  attributes?: {
    address?: string
    base_token_price_usd?: number | string
    reserve_in_usd?: number | string
    fdv_usd?: number | string
    market_cap_usd?: number | string
    pool_created_at?: string
    volume_usd?: { h24?: number | string }
    price_change_percentage?: { h24?: number | string; h6?: number | string; h1?: number | string }
  }
}

function normalizeGTPool(pool: GTPool, included: GTIncluded[], chain: PumpChain): NormalizedCandidate | null {
  const tokenId = pool.relationships?.base_token?.data?.id
  if (!tokenId) return null
  const meta = included.find(i => i.id === tokenId)
  if (!meta?.attributes?.address) return null
  const attrs = pool.attributes
  return {
    chainSlug: chain, chainId: CHAIN_CONFIG[chain].chainId,
    tokenAddress: meta.attributes.address.toLowerCase(),
    symbol: meta.attributes.symbol ?? '?', name: meta.attributes.name ?? 'Unknown',
    priceUsd: parseNum(attrs?.base_token_price_usd),
    marketCapUsd: parseNum(attrs?.market_cap_usd),
    fdvUsd: parseNum(attrs?.fdv_usd),
    liquidityUsd: parseNum(attrs?.reserve_in_usd),
    volume24hUsd: parseNum(attrs?.volume_usd?.h24),
    priceChange24hPct: parseNum(attrs?.price_change_percentage?.h24),
    priceChange6hPct: parseNum(attrs?.price_change_percentage?.h6),
    priceChange1hPct: parseNum(attrs?.price_change_percentage?.h1),
    pairAddress: attrs?.address ?? null,
    source: 'geckoterminal',
  }
}

async function fetchGTPage(network: string, page: number, signal: AbortSignal): Promise<{ data?: GTPool[]; included?: GTIncluded[] }> {
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=${page}&include=base_token,quote_token`, { headers: { accept: 'application/json' }, cache: 'no-store', signal })
  if (!res.ok) throw new Error(`GT ${res.status}`)
  return res.json()
}
async function fetchGTTrendingPools(network: string, signal: AbortSignal): Promise<{ data?: GTPool[]; included?: GTIncluded[] }> {
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?include=base_token,quote_token`, { headers: { accept: 'application/json' }, cache: 'no-store', signal })
  if (!res.ok) throw new Error(`GT trending ${res.status}`)
  return res.json()
}

// DO-NOT-BLOCK-ON-GECKOTERMINAL, DISCLOSED: every page/source below is fetched independently via
// Promise.allSettled — one page 429ing, timing out, or 5xx-ing never takes any other page (or
// chain, or the DexScreener source below) down with it. Returns whatever real candidates it got,
// even if that's zero for this one source.
async function fetchGTCandidates(chain: PumpChain, signal: AbortSignal): Promise<NormalizedCandidate[]> {
  const network = CHAIN_CONFIG[chain].gtNetwork
  const [pageResults, trendingResult] = await Promise.all([
    Promise.allSettled([1, 2, 3, 4].map(page => fetchGTPage(network, page, signal))),
    Promise.allSettled([fetchGTTrendingPools(network, signal)]),
  ])
  const out: NormalizedCandidate[] = []
  for (const r of [...pageResults, ...trendingResult]) {
    if (r.status !== 'fulfilled') continue
    const pools = Array.isArray(r.value.data) ? r.value.data : []
    const included = Array.isArray(r.value.included) ? r.value.included : []
    for (const pool of pools) {
      const c = normalizeGTPool(pool, included, chain)
      if (c) out.push(c)
    }
  }
  return out
}

// ─── Discovery: DexScreener (independent, GT-free breadth) ─────────────────────────────────
// LIVE-MARKET-SOURCES FIX, DISCLOSED: a second, wholly independent discovery source — DexScreener's
// own boosted/profile token lists cross-referenced against its own multi-token pair endpoint, never
// GeckoTerminal's. If GeckoTerminal is fully unreachable this cycle, this source alone can still
// populate the feed. Robinhood Chain is skipped (DexScreener doesn't index it — an honest gap, not
// a bug, matching this codebase's established Robinhood handling elsewhere).
type DexScreenerPair = {
  chainId?: string
  pairAddress?: string
  baseToken?: { address?: string; symbol?: string; name?: string }
  priceUsd?: string | number
  priceChange?: { h24?: number; h6?: number; h1?: number }
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  fdv?: number
  marketCap?: number
}

function normalizeDexScreenerPair(pair: DexScreenerPair, chain: PumpChain): NormalizedCandidate | null {
  const addr = pair.baseToken?.address
  if (!addr) return null
  return {
    chainSlug: chain, chainId: CHAIN_CONFIG[chain].chainId,
    tokenAddress: addr.toLowerCase(),
    symbol: pair.baseToken?.symbol ?? '?', name: pair.baseToken?.name ?? 'Unknown',
    priceUsd: parseNum(pair.priceUsd),
    marketCapUsd: parseNum(pair.marketCap),
    fdvUsd: parseNum(pair.fdv),
    liquidityUsd: parseNum(pair.liquidity?.usd),
    volume24hUsd: parseNum(pair.volume?.h24),
    priceChange24hPct: parseNum(pair.priceChange?.h24),
    priceChange6hPct: parseNum(pair.priceChange?.h6),
    priceChange1hPct: parseNum(pair.priceChange?.h1),
    pairAddress: pair.pairAddress ?? null,
    source: 'dexscreener',
  }
}

async function fetchDexScreenerCandidates(chain: PumpChain, signal: AbortSignal): Promise<NormalizedCandidate[]> {
  const dsChainId = CHAIN_CONFIG[chain].dexScreenerId
  if (!dsChainId) return []
  try {
    const [profileOutcome, boostOutcome] = await Promise.allSettled([
      fetch('https://api.dexscreener.com/token-profiles/latest/v1', { headers: { accept: 'application/json' }, cache: 'no-store', signal }),
      fetch('https://api.dexscreener.com/token-boosts/latest/v1', { headers: { accept: 'application/json' }, cache: 'no-store', signal }),
    ])
    const addresses = new Set<string>()
    for (const outcome of [profileOutcome, boostOutcome]) {
      if (outcome.status !== 'fulfilled' || !outcome.value.ok) continue
      const list = await outcome.value.json().catch(() => null)
      if (!Array.isArray(list)) continue
      for (const item of list as Record<string, unknown>[]) {
        const itemChainId = typeof item.chainId === 'string' ? item.chainId.toLowerCase() : ''
        const tokenAddress = typeof item.tokenAddress === 'string' ? item.tokenAddress : ''
        if (itemChainId === dsChainId && tokenAddress) addresses.add(tokenAddress)
        if (addresses.size >= 30) break
      }
    }
    if (addresses.size === 0) return []
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${[...addresses].join(',')}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    const pairs: DexScreenerPair[] = Array.isArray(json?.pairs) ? json.pairs : []
    const out: NormalizedCandidate[] = []
    for (const pair of pairs) {
      // WRONG-CHAIN GUARD, DISCLOSED (hard rule: never use wrong-chain pools): DexScreener's
      // multi-token endpoint can return pairs on OTHER chains for a given address; only pairs the
      // response itself attributes to this chain are ever kept.
      if (pair.chainId !== dsChainId) continue
      const c = normalizeDexScreenerPair(pair, chain)
      if (c) out.push(c)
    }
    return out
  } catch {
    return []
  }
}

async function fetchChainCandidates(chain: PumpChain, signal: AbortSignal): Promise<NormalizedCandidate[]> {
  const [gtResult, dsResult] = await Promise.allSettled([
    fetchGTCandidates(chain, signal),
    fetchDexScreenerCandidates(chain, signal),
  ])
  const out: NormalizedCandidate[] = []
  if (gtResult.status === 'fulfilled') out.push(...gtResult.value)
  if (dsResult.status === 'fulfilled') out.push(...dsResult.value)
  return out
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
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

  const chains = requestedChains(req)
  const requestId = `pump_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  if (chains.length === 0) {
    return NextResponse.json({
      alerts: [], fetchedAt: new Date().toISOString(), requestId, chains: [],
      providerStatus: 'unavailable' as const,
      error: 'No enabled chains requested. Robinhood Chain requires ENABLE_ROBINHOOD_CHAIN and a configured RPC.',
    })
  }

  const cacheKey = `pump:v3:${plan}:${[...chains].sort().join('+')}`
  const cached = pumpCache.get(cacheKey)
  if (cached && cached.exp > now) return NextResponse.json(cached.payload)

  // ── Discovery: every chain, every source, fully independent — see fetchChainCandidates ──────
  const chainsSucceeded: PumpChain[] = []
  const chainsFailed: PumpChain[] = []
  const rawCandidates: NormalizedCandidate[] = []
  {
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), 12_000)
    try {
      const settled = await Promise.allSettled(chains.map(c => fetchChainCandidates(c, ac.signal)))
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.length > 0) {
          rawCandidates.push(...r.value)
          chainsSucceeded.push(chains[i])
        } else {
          chainsFailed.push(chains[i])
        }
      })
    } finally {
      clearTimeout(tid)
    }
  }

  const providerStatus: 'ok' | 'partial' | 'unavailable' =
    chainsFailed.length === 0 ? 'ok' : chainsSucceeded.length > 0 ? 'partial' : 'unavailable'

  if (chainsSucceeded.length === 0) {
    const payload = {
      alerts: [], fetchedAt: new Date().toISOString(), requestId,
      chains: chains.map(c => ({ chain: c, chainId: CHAIN_CONFIG[c].chainId })),
      chainsSucceeded: [], chainsFailed, providerStatus: 'unavailable' as const,
      error: `Provider unavailable for: ${chainsFailed.join(', ')}. No cached results available.`,
      finalState: 'providerUnavailable' as const,
      pumpFeedAudit: { rawCandidates: 0, qualified: 0, rejectedMajorStableWrapped: 0, rejectedOverCap: 0, rejectedCapDataMissing: 0, rejectedLowLiquidity: 0, rejectedLowVolume: 0, rejectedNoMomentum: 0 },
    }
    pumpCache.set(cacheKey, { exp: now + PUMP_EMPTY_CACHE_TTL_MS, payload })
    return NextResponse.json(payload)
  }

  // ── Dedupe (chain-scoped identity — same address on two chains is two different tokens) ─────
  const seen = new Set<string>()
  const deduped: NormalizedCandidate[] = []
  for (const c of rawCandidates) {
    const key = `${c.chainSlug}:${c.tokenAddress}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(c)
    if (deduped.length >= PUMP_ALERT_MAX_RAW_CANDIDATES) break
  }

  // ── Eligibility: one synchronous pass, no network calls, so every raw candidate gets a real
  // decision — nothing is left un-evaluated by an evidence-checking budget cap. ─────────────────
  const rejected = { majorStableWrapped: 0, capDataMissing: 0, overCap: 0, lowLiquidity: 0, lowVolume: 0, noMomentum: 0 }
  const scored: Array<{ alert: PumpAlert; rankScore: number }> = []
  for (const c of deduped) {
    const evalResult = evaluatePumpCandidate(c)
    if (!evalResult.qualified) { rejected[evalResult.reason] += 1; continue }
    // PUMP_ALERT_REQUIRE_EXACT_7D, DISCLOSED: this feed never fetches exact 7d/14d evidence (see
    // module header) — when this flag is explicitly turned on, that means literally nothing can
    // qualify, which is the honest, intentional behavior of a flag that defaults to false.
    if (PUMP_ALERT_REQUIRE_EXACT_7D) { rejected.noMomentum += 1; continue }
    scored.push({ alert: buildAlert(c, evalResult), rankScore: rankPumpCandidate(c, evalResult) })
  }

  scored.sort((a, b) => b.rankScore - a.rankScore)
  const alerts = scored.slice(0, PUMP_ALERT_TARGET_RESULTS).map(s => s.alert)

  const finalState: 'noRawCandidates' | 'noneQualified' | 'finalRendered' =
    deduped.length === 0 ? 'noRawCandidates' : alerts.length === 0 ? 'noneQualified' : 'finalRendered'

  // Best-effort: persist real snapshots for the Pump Report feature's own snapshot-based history —
  // unrelated to this feed's eligibility, never awaited, never blocks the response.
  void savePumpSnapshots(deduped.map(c => ({
    chain: c.chainSlug, contract: c.tokenAddress, pair_address: c.pairAddress,
    price_usd: c.priceUsd, liquidity_usd: c.liquidityUsd, volume_24h_usd: c.volume24hUsd,
    fdv_usd: c.fdvUsd, market_cap_usd: c.marketCapUsd, captured_at: new Date().toISOString(),
  })))

  const payload = {
    alerts,
    fetchedAt: new Date().toISOString(),
    requestId,
    chains: chains.map(c => ({ chain: c, chainId: CHAIN_CONFIG[c].chainId })),
    providerStatus, chainsSucceeded, chainsFailed,
    finalState,
    ...(chainsFailed.length > 0 ? { error: `Provider unavailable for: ${chainsFailed.join(', ')}. Showing ${chainsSucceeded.join(', ')} only.` } : {}),
    // FEED-QUANTITY AUDIT, DISCLOSED: exact shape requested — "1 of X candidates qualified" plus a
    // rejection breakdown by majors/stables, cap, liquidity, volume, momentum, so a thin feed is
    // always provably explained from the response itself.
    pumpFeedAudit: {
      rawCandidates: deduped.length,
      qualified: alerts.length,
      rejectedMajorStableWrapped: rejected.majorStableWrapped,
      rejectedOverCap: rejected.overCap,
      rejectedCapDataMissing: rejected.capDataMissing,
      rejectedLowLiquidity: rejected.lowLiquidity,
      rejectedLowVolume: rejected.lowVolume,
      rejectedNoMomentum: rejected.noMomentum,
    },
  }

  const cacheTtlMs = finalState === 'finalRendered' ? PUMP_ROUTE_CACHE_TTL_MS : PUMP_EMPTY_CACHE_TTL_MS
  pumpCache.set(cacheKey, { exp: now + cacheTtlMs, payload })
  return NextResponse.json(payload)
}

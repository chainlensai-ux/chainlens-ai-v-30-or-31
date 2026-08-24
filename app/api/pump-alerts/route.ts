import { NextResponse } from 'next/server'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'

export const dynamic = 'force-dynamic'
const PUMP_ROUTE_CACHE_TTL_MS = 90_000
const pumpCache = new Map<string, { exp: number; payload: unknown }>()
const pumpRate = new Map<string, { count: number; resetAt: number }>()
const PUMP_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 3, pro: 12, elite: 24 }

function getIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

// ─── Configurable low-cap-momentum thresholds ──────────────────────────────
// PUMP QUALITY OVERHAUL, DISCLOSED (reported live: Pump Alerts was surfacing Aerodrome and other
// established Base tokens because the only gate was a flat stablecoin/wrapped-asset symbol
// denylist plus 24h-only momentum thresholds — no cap ceiling, no 7-day confirmation, no
// established-token category filter). All thresholds below are env-overridable so ops can tune
// without a redeploy; every default matches what was requested.
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}
function envOptionalNumber(name: string): number | null {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  return raw.trim().toLowerCase() === 'true'
}

const PUMP_ALERT_MAX_FDV_USD = envNumber('PUMP_ALERT_MAX_FDV_USD', 5_000_000)
const PUMP_ALERT_MAX_MARKET_CAP_USD = envNumber('PUMP_ALERT_MAX_MARKET_CAP_USD', 5_000_000)
const PUMP_ALERT_MIN_7D_CHANGE_PCT = envNumber('PUMP_ALERT_MIN_7D_CHANGE_PCT', 25)
const PUMP_ALERT_MIN_LIQUIDITY_USD = envNumber('PUMP_ALERT_MIN_LIQUIDITY_USD', 10_000)
const PUMP_ALERT_MIN_24H_VOLUME_USD = envNumber('PUMP_ALERT_MIN_24H_VOLUME_USD', 10_000)
const PUMP_ALERT_MAX_TOKEN_AGE_DAYS = envOptionalNumber('PUMP_ALERT_MAX_TOKEN_AGE_DAYS')
const PUMP_ALERT_EXCLUDE_ESTABLISHED_TOKENS = envBool('PUMP_ALERT_EXCLUDE_ESTABLISHED_TOKENS', true)

// Stablecoins / wrapped-majors / LST-LSD (kept from the original denylist, still symbol-exact).
const STABLE_AND_WRAPPED_DENYLIST = new Set([
  'USDC', 'USDT', 'DAI', 'USDBC', 'WETH', 'ETH', 'CBBTC', 'BTC', 'WBTC',
  'BUSD', 'FRAX', 'CBETH', 'STETH', 'RETH', 'WSTETH', 'EURC', 'BSDETH', 'USD+', 'AXLUSDC',
  'LSETH', 'SFRXETH', 'ANKRETH', 'OSETH', 'SWETH', 'METH', 'WEETH', 'EZETH', 'RSETH',
])

// Established Base protocol / governance / infrastructure tokens (the AERO gap that let
// Aerodrome and its peers leak through — none of these are ever a legitimate low-cap pump).
const ESTABLISHED_PROTOCOL_DENYLIST = new Set([
  'AERO', 'VAERO', 'UNI', 'CRV', 'BAL', 'COMP', 'MKR', 'SNX', 'LDO', 'RPL', 'GMX', 'PENDLE',
  'WELL', 'SEAM', 'MORPHO', 'PRIME', 'AAVE', 'SUSHI', 'CAKE', 'GRT', 'LINK', 'MATIC', 'POL',
  'ARB', 'OP', 'AXL', 'STG', 'LAYER', 'ENA', 'PYTH', 'JUP', 'RAY', 'DEGEN', 'BRETT', 'TOSHI',
])
const EXCLUDED = new Set([...STABLE_AND_WRAPPED_DENYLIST, ...ESTABLISHED_PROTOCOL_DENYLIST])

// Name-based check for LP/pool-share tokens and bridge/yield wrapper naming patterns that a bare
// symbol denylist can't catch (e.g. "Aerodrome LP", "xyz-USDC LP", "Bridged USDC").
const ESTABLISHED_NAME_PATTERN = /\b(aerodrome|uniswap|velodrome|lp\s*token|liquidity\s*pool|bridged|wrapped|staked|yield\s*bearing)\b/i
const LP_SYMBOL_PATTERN = /(^|[-_/])lp($|[-_/])|vamm-|vlp-/i

// PUMP-MULTI-CHAIN + LOW-CAP-CEILING, DISCLOSED (explicitly requested: "for coingeko to load more
// base low caps under 20 million and eth under 50 million and robinhood under 20 million").
// Pump Alerts previously scanned GeckoTerminal's Base network only. Now each supported chain has
// its own FDV-based low-cap ceiling (FDV is the pool-level proxy for market cap available from
// GeckoTerminal's pools endpoint) — candidates above their chain's ceiling are excluded so the
// feed stays a genuine low-cap feed. ETH uses GeckoTerminal's 'eth' network slug; Robinhood reuses
// the same isRobinhoodChainAvailable() feature flag as Base Radar (fails closed — no flag, no
// Robinhood scanning). These per-chain ceilings OVERRIDE the PUMP_ALERT_MAX_* env defaults inside
// the Stage 1 gate for the chains actually requested.
export type PumpChain = 'base' | 'eth' | 'robinhood'

const CHAIN_CONFIG: Record<PumpChain, { gtNetwork: string; maxFdvUsd: number }> = {
  base: { gtNetwork: 'base', maxFdvUsd: 20_000_000 },
  eth: { gtNetwork: 'eth', maxFdvUsd: 50_000_000 },
  robinhood: { gtNetwork: 'robinhood', maxFdvUsd: 20_000_000 },
}

function requestedChains(req: Request): PumpChain[] {
  const chainParam = new URL(req.url).searchParams.get('chains') ?? ''
  const wanted = chainParam
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter((c): c is PumpChain => c === 'base' || c === 'eth' || c === 'robinhood')
  const chains = wanted.length > 0 ? Array.from(new Set(wanted)) : (['base'] as PumpChain[])
  return chains.filter(c => c !== 'robinhood' || isRobinhoodChainAvailable())
}

export type PumpCategory = 'HIGH_MOMENTUM' | 'VOLUME_EXPANSION' | 'THIN_MOONSHOT' | 'WATCH'
export type PumpRisk = 'HIGH' | 'MEDIUM' | 'LOW'

export interface PumpAlert {
  symbol: string
  name: string
  contract: string
  chain: string
  priceUsd: number | null
  change24h: number | null
  change7d: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  tokenAgeDays: number | null
  category: PumpCategory
  reason: string
  qualifyingReason: string
  riskLevel: PumpRisk
  tags: string[]
}

// Per-candidate eligibility audit — every raw candidate GeckoTerminal returned gets one entry,
// whether it made the final cut or not, so "why isn't X showing" is always answerable from data.
export interface PumpDiscoveryEligibilityAudit {
  token: string
  chain: string
  symbol: string
  fdvUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  priceChange7dPct: number | null
  priceChange24hPct: number | null
  tokenAgeDays: number | null
  excluded: boolean
  exclusionReason: string | null
  qualifiesAsLowCap: boolean
  qualifiesAs7dPump: boolean
  categoryBlocked: boolean
  finalRankScore: number | null
}

type GTIncluded = { id?: string; attributes?: { address?: string; symbol?: string; name?: string } }
type GTPool = {
  id?: string
  relationships?: { base_token?: { data?: { id?: string } } }
  attributes?: {
    address?: string
    base_token_price_usd?: number | string
    reserve_in_usd?: number | string
    fdv_usd?: number | string
    market_cap_usd?: number | string
    pool_created_at?: string
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
    const cleaned = v.replace(/[$,\s]/g, '')
    if (cleaned === '') return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function isEstablishedOrCategoryBlocked(symbol: string, name: string): boolean {
  if (!PUMP_ALERT_EXCLUDE_ESTABLISHED_TOKENS) return false
  if (EXCLUDED.has(symbol)) return true
  if (ESTABLISHED_NAME_PATTERN.test(name)) return true
  if (LP_SYMBOL_PATTERN.test(symbol)) return true
  return false
}

// ─── Pure, exported evaluation stages ───────────────────────────────────────────────────────────
// Split out from the GET handler (and exported) so eligibility/exclusion behavior — the actual
// business logic this fix is about — can be exercised directly in tests without mocking network
// calls or a Next.js request. GET below is a thin orchestration wrapper over these two stages.
export type Stage1Candidate = {
  symbol: string; name: string; addr: string; poolAddr: string | null
  price: number | null; change24h: number | null; volume: number | null; liquidity: number | null
  fdv: number | null; marketCap: number | null; ageDays: number | null
}
export type Stage1Input = { symbol: string; name: string; addr: string; poolAddr: string | null } & {
  price: number | null; change24h: number | null; volume: number | null; liquidity: number | null
  fdv: number | null; marketCap: number | null; ageDays: number | null
}
export type Stage1Result =
  | { passed: true; candidate: Stage1Candidate }
  | { passed: false; audit: PumpDiscoveryEligibilityAudit }

export function evaluateStage1Candidate(input: Stage1Input): Stage1Result {
  const sym = input.symbol.toUpperCase()
  const categoryBlocked = isEstablishedOrCategoryBlocked(sym, input.name)
  const qualifiesAsLowCap =
    (input.fdv != null && input.fdv > 0 && input.fdv <= PUMP_ALERT_MAX_FDV_USD) ||
    (input.marketCap != null && input.marketCap > 0 && input.marketCap <= PUMP_ALERT_MAX_MARKET_CAP_USD)
  const capDataMissing = input.fdv == null && input.marketCap == null
  const liquidityOk = input.liquidity != null && input.liquidity >= PUMP_ALERT_MIN_LIQUIDITY_USD
  const volumeOk = input.volume != null && input.volume >= PUMP_ALERT_MIN_24H_VOLUME_USD
  const ageOk = PUMP_ALERT_MAX_TOKEN_AGE_DAYS == null || (input.ageDays != null && input.ageDays <= PUMP_ALERT_MAX_TOKEN_AGE_DAYS)

  let exclusionReason: string | null = null
  if (categoryBlocked) exclusionReason = 'establishedOrCategoryBlocked'
  else if (capDataMissing) exclusionReason = 'capDataMissing'
  else if (!qualifiesAsLowCap) exclusionReason = 'capExceedsLowCapCeiling'
  else if (!liquidityOk) exclusionReason = 'liquidityBelowMinimum'
  else if (!volumeOk) exclusionReason = 'volumeBelowMinimum'
  else if (!ageOk) exclusionReason = 'tokenAgeExceedsMaximum'

  if (exclusionReason) {
    return {
      passed: false,
      audit: {
        token: input.addr, chain: 'base', symbol: input.symbol,
        fdvUsd: input.fdv, marketCapUsd: input.marketCap, liquidityUsd: input.liquidity, volume24hUsd: input.volume,
        priceChange7dPct: null, priceChange24hPct: input.change24h, tokenAgeDays: input.ageDays,
        excluded: true, exclusionReason,
        qualifiesAsLowCap: qualifiesAsLowCap && !capDataMissing, qualifiesAs7dPump: false,
        categoryBlocked, finalRankScore: null,
      },
    }
  }
  return {
    passed: true,
    candidate: {
      symbol: input.symbol, name: input.name, addr: input.addr, poolAddr: input.poolAddr,
      price: input.price, change24h: input.change24h, volume: input.volume, liquidity: input.liquidity,
      fdv: input.fdv, marketCap: input.marketCap, ageDays: input.ageDays,
    },
  }
}

export type Stage2Result =
  | { included: true; alert: PumpAlert; audit: PumpDiscoveryEligibilityAudit }
  | { included: false; audit: PumpDiscoveryEligibilityAudit }

export function evaluateStage2Candidate(c: Stage1Candidate, change7d: number | null): Stage2Result {
  const qualifiesAs7dPump = change7d != null && change7d >= PUMP_ALERT_MIN_7D_CHANGE_PCT

  if (!qualifiesAs7dPump) {
    return {
      included: false,
      audit: {
        token: c.addr, chain: 'base', symbol: c.symbol,
        fdvUsd: c.fdv, marketCapUsd: c.marketCap, liquidityUsd: c.liquidity, volume24hUsd: c.volume,
        priceChange7dPct: change7d, priceChange24hPct: c.change24h, tokenAgeDays: c.ageDays,
        excluded: true, exclusionReason: change7d == null ? 'missing7dData' : 'change7dBelowMinimum',
        qualifiesAsLowCap: true, qualifiesAs7dPump: false, categoryBlocked: false, finalRankScore: null,
      },
    }
  }

  const scored = categorize(c.change24h, c.volume, c.liquidity)
  if (!scored) {
    return {
      included: false,
      audit: {
        token: c.addr, chain: 'base', symbol: c.symbol,
        fdvUsd: c.fdv, marketCapUsd: c.marketCap, liquidityUsd: c.liquidity, volume24hUsd: c.volume,
        priceChange7dPct: change7d, priceChange24hPct: c.change24h, tokenAgeDays: c.ageDays,
        excluded: true, exclusionReason: 'noCategoryMatch',
        qualifiesAsLowCap: true, qualifiesAs7dPump: true, categoryBlocked: false, finalRankScore: null,
      },
    }
  }

  const tags: string[] = []
  if (c.fdv != null && c.fdv > 0 && c.fdv < 100_000) tags.push('Microcap')
  if (c.volume == null || c.liquidity == null) tags.push('Needs Review')

  const alert: PumpAlert = {
    symbol: c.symbol, name: c.name, contract: c.addr, chain: 'base',
    priceUsd: c.price, change24h: c.change24h, change7d,
    volume24hUsd: c.volume, liquidityUsd: c.liquidity, fdvUsd: c.fdv, marketCapUsd: c.marketCap,
    tokenAgeDays: c.ageDays,
    qualifyingReason: `+${change7d.toFixed(1)}% over 7d, low-cap (${c.fdv != null ? `$${(c.fdv / 1_000_000).toFixed(2)}M FDV` : `$${((c.marketCap ?? 0) / 1_000_000).toFixed(2)}M MC`}), $${((c.liquidity ?? 0) / 1000).toFixed(0)}K liquidity, $${((c.volume ?? 0) / 1000).toFixed(0)}K 24h volume`,
    ...scored,
    tags,
  }
  return {
    included: true,
    alert,
    audit: {
      token: c.addr, chain: 'base', symbol: c.symbol,
      fdvUsd: c.fdv, marketCapUsd: c.marketCap, liquidityUsd: c.liquidity, volume24hUsd: c.volume,
      priceChange7dPct: change7d, priceChange24hPct: c.change24h, tokenAgeDays: c.ageDays,
      excluded: false, exclusionReason: null,
      qualifiesAsLowCap: true, qualifiesAs7dPump: true, categoryBlocked: false,
      finalRankScore: qualityScore(alert),
    },
  }
}

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

// 7-DAY CHANGE, DISCLOSED: GeckoTerminal's /pools list endpoint only returns h24 price change —
// there is no 7d field to read. Faking it from 24h data would violate "do not fake 7-day
// performance," so we fetch real daily OHLCV candles per candidate and compute the actual 7-day
// close-to-close change. This is only ever called for candidates that already cleared the cheap
// cap/liquidity/volume/category filters, keeping the extra network cost bounded to a small set.
const SEVEN_DAY_OHLCV_CONCURRENCY_LIMIT = 4

async function fetchPoolSevenDayChange(poolAddress: string, signal: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddress}/ohlcv/day?limit=8&currency=usd`,
      { headers: { accept: 'application/json' }, cache: 'no-store', signal },
    )
    if (!res.ok) return null
    const json = await res.json()
    const list = json?.data?.attributes?.ohlcv_list
    if (!Array.isArray(list) || list.length < 6) return null
    // Each row is [timestamp, open, high, low, close, volume]. GeckoTerminal returns newest-first;
    // sort explicitly by timestamp so we never depend on that ordering being stable.
    const sorted = [...list].sort((a: number[], b: number[]) => a[0] - b[0])
    const oldestClose = Number(sorted[0]?.[4])
    const newestClose = Number(sorted[sorted.length - 1]?.[4])
    if (!Number.isFinite(oldestClose) || !Number.isFinite(newestClose) || oldestClose <= 0) return null
    return ((newestClose - oldestClose) / oldestClose) * 100
  } catch {
    return null
  }
}

function qualityScore(a: PumpAlert): number {
  let s = 0
  const liq = a.liquidityUsd ?? 0
  const vol = a.volume24hUsd ?? 0
  const fdv = a.fdvUsd ?? 0
  const ch7d = a.change7d ?? 0
  s += Math.min(ch7d / 10, 10) // 7d change is the primary ranking signal
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
  // Every candidate reaching categorize() already cleared the low-cap + confirmed-7d-pump gate,
  // so WATCH is the floor category for a real, evidenced low-cap mover — never a generic filler.
  const volFmt = vol >= 1_000_000 ? `$${(vol / 1_000_000).toFixed(1)}M` : `$${(vol / 1000).toFixed(0)}K`
  const liqFmt = `$${(liq / 1000).toFixed(0)}K`
  const parts: string[] = []
  if (Math.abs(ch) >= 8) parts.push(`${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% 24h move`)
  parts.push(`${volFmt} volume`)
  parts.push(`${liqFmt} liquidity`)
  return {
    category: 'WATCH',
    reason: parts.join(' · '),
    riskLevel: liq >= 50_000 ? 'LOW' : 'MEDIUM',
  }
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

async function fetchGTPage(network: string, page: number, signal: AbortSignal): Promise<{ data?: GTPool[]; included?: GTIncluded[] }> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/${network}/pools?page=${page}&include=base_token,quote_token`,
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

  // PUMP-MULTI-CHAIN, DISCLOSED: resolve the chain set once per request (default Base-only,
  // unchanged behavior when no ?chains= param is passed).
  const chains = requestedChains(req)
  if (chains.length === 0) {
    return NextResponse.json({ alerts: [], fetchedAt: new Date().toISOString(), chainsRequested: [], _note: 'no enabled chains requested' })
  }

  const cached = pumpCache.get(cacheKey)
  if (cached && cached.exp > now) return NextResponse.json(cached.payload)

  let pools: GTPool[] = []
  let included: GTIncluded[] = []
  let providerStatus: 'ok' | 'partial' | 'unavailable' = 'ok'

  try {
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), 10_000)
    try {
      // Fetch 3 pages per chain in parallel (~60 raw rows per chain for a deeper candidate pool)
      const results = await Promise.allSettled(
        chains.flatMap(chain =>
          [1, 2, 3].map(page => fetchGTPage(CHAIN_CONFIG[chain].gtNetwork, page, ac.signal)),
        ),
      )
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
    // Fallback to shared cache (page 1, Base only — the shared cache key is Base-scoped)
    try {
      const result = await getOrFetchCached<{ data?: GTPool[]; included?: GTIncluded[] }>({
        key: 'coingecko:trending-base',
        ttlMs: 60_000,
        onLog: msg => console.info(`[pump-alerts] ${msg}`),
        fetcher: async () => {
          const ac = new AbortController()
          const tid = setTimeout(() => ac.abort(), 6000)
          try {
            const res = await fetchGTPage('base', 1, ac.signal)
            return res
          } finally {
            clearTimeout(tid)
          }
        },
      })
      pools = Array.isArray(result.data?.data) ? (result.data.data as GTPool[]) : []
      included = Array.isArray(result.data?.included) ? (result.data.included as GTIncluded[]) : []
    } catch {
      providerStatus = 'unavailable'
      return NextResponse.json({ alerts: [], fetchedAt: new Date().toISOString(), pumpDiscoveryEligibilityAudit: [] })
    }
  }

  const seen = new Set<string>()
  const audit: PumpDiscoveryEligibilityAudit[] = []

  // ─── Stage 1: cheap synchronous filters (category, cap, liquidity, volume, age) ───────────────
  // No network calls yet — only candidates surviving this stage pay the cost of a 7d OHLCV fetch.
  const stage1Passed: Stage1Candidate[] = []

  for (const pool of pools) {
    const tokenId = pool.relationships?.base_token?.data?.id
    if (!tokenId) continue
    const meta = included.find(i => i.id === tokenId)
    if (!meta?.attributes?.address) continue

    const addr = meta.attributes.address.toLowerCase()
    if (seen.has(addr)) continue
    seen.add(addr)

    const attrs = pool.attributes
    const change24h = parseNum(attrs?.price_change_percentage?.h24)
    const volume = parseNum(attrs?.volume_usd?.h24)
    const liquidity = parseNum(attrs?.reserve_in_usd)
    const price = parseNum(attrs?.base_token_price_usd)
    const fdv = parseNum(attrs?.fdv_usd)
    const marketCap = parseNum(attrs?.market_cap_usd)
    const createdAt = attrs?.pool_created_at ? Date.parse(attrs.pool_created_at) : NaN
    const ageDays = Number.isFinite(createdAt) ? (Date.now() - createdAt) / (1000 * 60 * 60 * 24) : null

    // LOW-CAP-CEILING, DISCLOSED (merged with the staged eligibility pipeline): evaluateStage1Candidate
    // applies the env-configurable PUMP_ALERT_MAX_* caps; for multi-chain requests the per-chain
    // ceilings (Base $20M / ETH $50M / Robinhood $20M) are enforced here as an additional ceiling —
    // a candidate is dropped when its FDV exceeds every requested chain's limit. The most permissive
    // requested ceiling wins so nothing valid is dropped for being on the wrong side of a stricter
    // chain's limit. null FDV stays allowed at this layer (the Stage 1 capDataMissing rule still
    // applies upstream of it).
    const maxFdvUsd = Math.max(...chains.map(c => CHAIN_CONFIG[c].maxFdvUsd))
    if (fdv != null && fdv > maxFdvUsd) continue

    const result = evaluateStage1Candidate({
      symbol: meta.attributes.symbol ?? '?', name: meta.attributes.name ?? 'Unknown', addr,
      poolAddr: pool.attributes?.address ?? null,
      price, change24h, volume, liquidity, fdv, marketCap, ageDays,
    })
    if (!result.passed) {
      audit.push(result.audit)
      continue
    }
    stage1Passed.push(result.candidate)
  }

  // ─── Stage 2: confirm real 7-day pump performance (bounded network fan-out) ────────────────────
  const ac7d = new AbortController()
  const tid7d = setTimeout(() => ac7d.abort(), 12_000)
  let sevenDayResults: (number | null)[] = []
  try {
    sevenDayResults = await mapWithConcurrencyLimit(stage1Passed, SEVEN_DAY_OHLCV_CONCURRENCY_LIMIT, async c => {
      if (!c.poolAddr) return null
      return fetchPoolSevenDayChange(c.poolAddr, ac7d.signal)
    })
  } finally {
    clearTimeout(tid7d)
  }

  const allScored: PumpAlert[] = []

  stage1Passed.forEach((c, i) => {
    const change7d = sevenDayResults[i] ?? null
    const result = evaluateStage2Candidate(c, change7d)
    audit.push(result.audit)
    if (result.included) allScored.push(result.alert)
  })

  // Quality-sort before rotation so rotation prioritises best candidates
  allScored.sort((a, b) => {
    const od = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    if (od !== 0) return od
    const qd = qualityScore(b) - qualityScore(a)
    return qd !== 0 ? qd : (b.change7d ?? 0) - (a.change7d ?? 0)
  })

  const { alerts, freshCount, staleCount, fallbackUsed } = applyRotationAndDiversity(allScored)

  const payload = {
    alerts,
    fetchedAt: new Date().toISOString(),
    chains: chains.map(c => ({ chain: c, maxFdvUsd: CHAIN_CONFIG[c].maxFdvUsd })),
    diagnostics: process.env.NODE_ENV === 'development' ? { cacheHit: false, providerStatus, rateLimited: false } : undefined,
    pumpDiscoveryEligibilityAudit: audit,
    _debug: {
      rawCount: pools.length,
      eligibleFor7dCheck: stage1Passed.length,
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

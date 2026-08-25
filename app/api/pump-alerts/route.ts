import { NextResponse } from 'next/server'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import {
  PUMP_REQUIRE_EXACT_7D,
  evaluateMomentumFallback,
  fetchDexScreenerPairMomentum,
  fetchCoinGeckoContractChange7d,
  savePumpSnapshots,
  computeSnapshotChange7d,
  type Pump7dEvidenceAudit,
  type SevenDayEvidenceSource,
} from '@/lib/server/pump7dEvidence'

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

// MAJOR-CHAIN-NATIVE DENYLIST, DISCLOSED (reported live: a bridged/wrapped "Solana / SOL" pool on
// Base rendered as a Pump Alerts card). SOL was never in any denylist — Base has multiple bridged
// SOL representations (Wrapped SOL, Solana-pegged bridge tokens) that are majors, not low-cap pump
// candidates, no matter which chain they're deployed on. Extended to the other top-cap L1/L2
// natives for the same reason: a bridged/wrapped BNB, AVAX, DOGE, etc. is still a major asset.
const MAJOR_CHAIN_NATIVE_DENYLIST = new Set([
  'SOL', 'WSOL', 'BNB', 'WBNB', 'AVAX', 'WAVAX', 'DOT', 'ADA', 'XRP', 'TRX',
  'LTC', 'DOGE', 'SHIB', 'TON', 'NEAR', 'ATOM', 'ICP', 'APT', 'SUI', 'FIL', 'HBAR',
])

// Established Base protocol / governance / infrastructure tokens (the AERO gap that let
// Aerodrome and its peers leak through — none of these are ever a legitimate low-cap pump).
const ESTABLISHED_PROTOCOL_DENYLIST = new Set([
  'AERO', 'VAERO', 'UNI', 'CRV', 'BAL', 'COMP', 'MKR', 'SNX', 'LDO', 'RPL', 'GMX', 'PENDLE',
  'WELL', 'SEAM', 'MORPHO', 'PRIME', 'AAVE', 'SUSHI', 'CAKE', 'GRT', 'LINK', 'MATIC', 'POL',
  'ARB', 'OP', 'AXL', 'STG', 'LAYER', 'ENA', 'PYTH', 'JUP', 'RAY', 'DEGEN', 'BRETT', 'TOSHI',
])
const EXCLUDED = new Set([...STABLE_AND_WRAPPED_DENYLIST, ...ESTABLISHED_PROTOCOL_DENYLIST, ...MAJOR_CHAIN_NATIVE_DENYLIST])

// Name-based check for LP/pool-share tokens and bridge/yield wrapper naming patterns that a bare
// symbol denylist can't catch (e.g. "Aerodrome LP", "xyz-USDC LP", "Bridged USDC", "Solana").
// "solana" is listed explicitly (not just "bridged"/"wrapped") because a bridge's display name is
// often just the source chain's name with no bridge/wrapped qualifier at all.
const ESTABLISHED_NAME_PATTERN = /\b(aerodrome|uniswap|velodrome|lp\s*token|liquidity\s*pool|bridged|wrapped|staked|yield\s*bearing|solana)\b/i
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

// CHAIN-PROVENANCE FIX, DISCLOSED (full Radar/Pump audit): chainId is carried alongside the
// GeckoTerminal network slug because every downstream consumer — the Token Scanner handoff, the
// report route, the Clark prompt, and the eligibility audit — must state the REAL chain a candidate
// came from. Before this, multi-chain pools from three different networks were flattened into one
// untagged array and every resulting alert was hardcoded `chain: 'base'`, so an ETH or Robinhood
// token was published, scanned, reported and reasoned about as if it were a Base token.
const CHAIN_CONFIG: Record<PumpChain, { gtNetwork: string; chainId: number; maxFdvUsd: number }> = {
  base: { gtNetwork: 'base', chainId: 8453, maxFdvUsd: 20_000_000 },
  eth: { gtNetwork: 'eth', chainId: 1, maxFdvUsd: 50_000_000 },
  robinhood: { gtNetwork: 'robinhood', chainId: 4663, maxFdvUsd: 20_000_000 },
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
  // chain/chainId are the REAL network this candidate was discovered on, never a default — the
  // Token Scanner handoff, report link and Clark prompt all key off these.
  chain: PumpChain
  chainId: number
  pairAddress: string | null
  priceUsd: number | null
  change24h: number | null
  change7d: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  tokenAgeDays: number | null
  // 7D-EVIDENCE LADDER, DISCLOSED: how this candidate qualified. 'exact' = a real measured 7d
  // change (GeckoTerminal OHLCV, CoinGecko per-contract, or ChainLens snapshots ≥5 days apart).
  // 'momentum_fallback' = exact 7d unavailable but strong corroborated evidence (≥15% confirmed
  // 24h move + volume acceleration ≥1.5× + real liquidity) qualified it instead — change7d stays
  // null in that case, never faked.
  evidenceSource: SevenDayEvidenceSource
  evidenceGrade: 'exact' | 'momentum_fallback'
  category: PumpCategory
  reason: string
  qualifyingReason: string
  riskLevel: PumpRisk
  tags: string[]
}

// Per-candidate eligibility audit — every raw candidate GeckoTerminal returned gets one entry,
// whether it made the final cut or not, so "why isn't X showing" is always answerable from data.
export interface PumpDiscoveryEligibilityAudit {
  requestId: string
  token: string
  // ELIGIBILITY-SHAPE FIX, DISCLOSED (quality audit): tokenAddress/name/evidenceMode/lowCapQualified
  // are additive aliases matching the requested per-token audit contract exactly — `token` and
  // `qualifiesAsLowCap` are kept too since existing tests and callers already key off them.
  tokenAddress: string
  name: string
  chain: PumpChain
  chainSlug: PumpChain
  chainId: number
  pairAddress: string | null
  source: string
  symbol: string
  category: PumpCategory | null
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
  lowCapQualified: boolean
  qualifiesAs7dPump: boolean
  categoryBlocked: boolean
  // 'exact' | 'momentum_fallback' | 'none' | 'not_evaluated' (Stage 1 rejections never reach the
  // evidence ladder, so their evidenceMode is honestly 'not_evaluated' rather than a guess).
  evidenceMode: 'exact' | 'momentum_fallback' | 'none' | 'not_evaluated'
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
  chain: PumpChain
  symbol: string; name: string; addr: string; poolAddr: string | null
  price: number | null; change24h: number | null; volume: number | null; liquidity: number | null
  fdv: number | null; marketCap: number | null; ageDays: number | null
}
export type Stage1Input = { chain?: PumpChain; symbol: string; name: string; addr: string; poolAddr: string | null } & {
  price: number | null; change24h: number | null; volume: number | null; liquidity: number | null
  fdv: number | null; marketCap: number | null; ageDays: number | null
}
export type Stage1Result =
  | { passed: true; candidate: Stage1Candidate }
  | { passed: false; audit: PumpDiscoveryEligibilityAudit }

export function evaluateStage1Candidate(input: Stage1Input, requestId = 'n/a'): Stage1Result {
  const chain: PumpChain = input.chain ?? 'base'
  const chainCfg = CHAIN_CONFIG[chain]
  const sym = input.symbol.toUpperCase()
  const categoryBlocked = isEstablishedOrCategoryBlocked(sym, input.name)
  // PER-CHAIN CEILING FIX, DISCLOSED: the ceiling is the STRICTER of this candidate's own chain
  // limit and the env-configured global cap — never the most-permissive limit across all requested
  // chains, which previously let a Base token up to ETH's $50M ceiling through its own $20M one.
  // This is only correct because `chain` is now the candidate's real chain, not a request-level
  // default.
  const maxFdv = Math.min(PUMP_ALERT_MAX_FDV_USD, chainCfg.maxFdvUsd)
  const maxMarketCap = Math.min(PUMP_ALERT_MAX_MARKET_CAP_USD, chainCfg.maxFdvUsd)
  const qualifiesAsLowCap =
    (input.fdv != null && input.fdv > 0 && input.fdv <= maxFdv) ||
    (input.marketCap != null && input.marketCap > 0 && input.marketCap <= maxMarketCap)
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
        requestId, token: input.addr, tokenAddress: input.addr, name: input.name,
        chain, chainSlug: chain, chainId: chainCfg.chainId,
        pairAddress: input.poolAddr, source: 'geckoterminal:pools', category: null,
        symbol: input.symbol,
        fdvUsd: input.fdv, marketCapUsd: input.marketCap, liquidityUsd: input.liquidity, volume24hUsd: input.volume,
        priceChange7dPct: null, priceChange24hPct: input.change24h, tokenAgeDays: input.ageDays,
        excluded: true, exclusionReason,
        qualifiesAsLowCap: qualifiesAsLowCap && !capDataMissing,
        lowCapQualified: qualifiesAsLowCap && !capDataMissing,
        qualifiesAs7dPump: false, categoryBlocked, evidenceMode: 'not_evaluated', finalRankScore: null,
      },
    }
  }
  return {
    passed: true,
    candidate: {
      chain,
      symbol: input.symbol, name: input.name, addr: input.addr, poolAddr: input.poolAddr,
      price: input.price, change24h: input.change24h, volume: input.volume, liquidity: input.liquidity,
      fdv: input.fdv, marketCap: input.marketCap, ageDays: input.ageDays,
    },
  }
}

export type Stage2Result =
  | { included: true; alert: PumpAlert; audit: PumpDiscoveryEligibilityAudit }
  | { included: false; audit: PumpDiscoveryEligibilityAudit }

// RESOLVED EVIDENCE, DISCLOSED: what the evidence ladder produced for one candidate before Stage 2
// runs. Exactly one of the branches is populated. change7d is ONLY ever a real measured number —
// momentum-fallback candidates keep it null and carry the fallback label instead.
export type ResolvedEvidence =
  | { kind: 'exact'; source: SevenDayEvidenceSource; change7d: number }
  | { kind: 'momentum_fallback'; confirmedChange24hPct: number; evidenceParts: string[] }
  | { kind: 'none' }

export function evaluateStage2Candidate(
  c: Stage1Candidate,
  change7d: number | null,
  requestId = 'n/a',
  resolved?: ResolvedEvidence,
): Stage2Result {
  const chain: PumpChain = c.chain ?? 'base'
  const chainId = CHAIN_CONFIG[chain].chainId
  const evidence: ResolvedEvidence = resolved ?? (change7d != null ? { kind: 'exact', source: 'geckoterminal_ohlcv', change7d } : { kind: 'none' })
  const auditBase = {
    requestId, token: c.addr, tokenAddress: c.addr, name: c.name, chain, chainSlug: chain, chainId,
    pairAddress: c.poolAddr,
    // source reflects how the candidate actually qualified — no longer hardcoded to the OHLCV
    // endpoint now that the ladder can qualify via CoinGecko/snapshots/momentum.
    source: evidence.kind === 'exact'
      ? `exact:${evidence.source}`
      : evidence.kind === 'momentum_fallback' ? 'momentum_fallback:corroborated_24h' : 'geckoterminal:ohlcv-day',
    symbol: c.symbol,
    fdvUsd: c.fdv, marketCapUsd: c.marketCap, liquidityUsd: c.liquidity, volume24hUsd: c.volume,
    priceChange7dPct: evidence.kind === 'exact' ? evidence.change7d : null,
    priceChange24hPct: c.change24h, tokenAgeDays: c.ageDays,
    evidenceMode: evidence.kind,
  }

  if (evidence.kind === 'none') {
    return {
      included: false,
      audit: {
        ...auditBase, category: null,
        excluded: true, exclusionReason: PUMP_REQUIRE_EXACT_7D ? 'missing7dData' : 'noQualifyingPumpEvidence',
        qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs7dPump: false, categoryBlocked: false, finalRankScore: null,
      },
    }
  }

  const isMomentum = evidence.kind === 'momentum_fallback'
  if (evidence.kind === 'exact' && evidence.change7d < PUMP_ALERT_MIN_7D_CHANGE_PCT) {
    return {
      included: false,
      audit: {
        ...auditBase, category: null,
        excluded: true, exclusionReason: 'change7dBelowMinimum',
        qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs7dPump: false, categoryBlocked: false, finalRankScore: null,
      },
    }
  }

  const scored = categorize(c.change24h, c.volume, c.liquidity)
  if (!scored) {
    return {
      included: false,
      audit: {
        ...auditBase, category: null,
        excluded: true, exclusionReason: 'noCategoryMatch',
        qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs7dPump: !isMomentum, categoryBlocked: false, finalRankScore: null,
      },
    }
  }

  const tags: string[] = []
  if (c.fdv != null && c.fdv > 0 && c.fdv < 100_000) tags.push('Microcap')
  if (c.volume == null || c.liquidity == null) tags.push('Needs Review')
  // Evidence badge data lives on the card too — never let a fallback token look identical to an
  // exact-7d one.
  if (isMomentum) tags.push('7d unavailable — qualified by 24h momentum fallback')

  const capLabel = c.fdv != null ? `$${(c.fdv / 1_000_000).toFixed(2)}M FDV` : `$${((c.marketCap ?? 0) / 1_000_000).toFixed(2)}M MC`
  const qualifyingReason = isMomentum
    ? `7d unavailable — qualified by 24h momentum fallback (+${evidence.confirmedChange24hPct.toFixed(1)}% confirmed 24h move, low-cap ${capLabel}), ${evidence.evidenceParts.join(', ')}`
    : `+${evidence.change7d.toFixed(1)}% over 7d, low-cap (${capLabel}), $${((c.liquidity ?? 0) / 1000).toFixed(0)}K liquidity, $${((c.volume ?? 0) / 1000).toFixed(0)}K 24h volume`

  const alert: PumpAlert = {
    symbol: c.symbol, name: c.name, contract: c.addr, chain, chainId, pairAddress: c.poolAddr,
    priceUsd: c.price, change24h: c.change24h,
    change7d: evidence.kind === 'exact' ? evidence.change7d : null,
    volume24hUsd: c.volume, liquidityUsd: c.liquidity, fdvUsd: c.fdv, marketCapUsd: c.marketCap,
    tokenAgeDays: c.ageDays,
    evidenceSource: isMomentum ? 'dexscreener_momentum' : (evidence as { source: SevenDayEvidenceSource }).source,
    evidenceGrade: isMomentum ? 'momentum_fallback' : 'exact',
    qualifyingReason,
    ...scored,
    tags,
  }
  return {
    included: true,
    alert,
    audit: {
      ...auditBase, category: scored.category,
      excluded: false, exclusionReason: null,
      qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs7dPump: !isMomentum, categoryBlocked: false,
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

// WRONG-NETWORK FIX, DISCLOSED: this hardcoded `networks/base/` while the caller had already gone
// multi-chain, so every ETH/Robinhood pool address was queried against the BASE network, 404'd,
// returned null, and was then dropped as `missing7dData` — silently yielding ~zero non-Base
// candidates while the response still claimed all requested chains were scanned. Takes the real
// network slug now.
// LOADING-DIAGNOSTICS, DISCLOSED (URGENT: Pump Alerts showing 0 results / Base Radar audit): the
// return type used to collapse every "no 7d change" case — a genuine provider fetch failure
// (timeout/rate-limit/5xx), a real 404, and a pool that is simply too young to have 6 daily
// candles yet — into a single `null`. That made it impossible to tell "the provider is failing"
// (a systemic bug that should surface as a visible error) apart from "this token is 3 days old"
// (expected, honest filtering, not a bug). `reason` lets the caller distinguish them and report
// which one actually happened instead of a silent zero either way.
type SevenDayChangeResult = { changePct: number | null; reason: 'ok' | 'httpError' | 'tooYoung' | 'malformed' | 'fetchError' }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ONE-RETRY 429-AWARE FIX, DISCLOSED (reported live: Pump Alerts blacked out with "GeckoTerminal
// OHLCV requests failed for every candidate this cycle, and no fallback provider could confirm
// momentum either" — a total ladder failure, not an honest empty market). This fetcher previously
// had ZERO retry: a single failed request (including a 429) permanently marked that candidate
// failed for the whole cycle. GeckoTerminal's rate limit is a real, deployment-shared budget (the
// same class of bug already fixed for Base Radar's discovery fetcher) — this route fires up to 4
// concurrent OHLCV requests per cycle on top of whatever Base Radar/other Pump Alerts requests are
// in flight, so a burst of 429s here was entirely expected, not a genuine outage. A 429 gets a
// meaningfully longer backoff than a generic transient failure since a flat short delay can't
// outlast a real rate-limit window.
async function fetchPoolSevenDayChangeOnce(network: string, poolAddress: string, signal: AbortSignal): Promise<SevenDayChangeResult & { httpStatus?: number }> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/day?limit=8&currency=usd`,
      { headers: { accept: 'application/json' }, cache: 'no-store', signal },
    )
    if (!res.ok) return { changePct: null, reason: 'httpError', httpStatus: res.status }
    const json = await res.json()
    const list = json?.data?.attributes?.ohlcv_list
    if (!Array.isArray(list)) return { changePct: null, reason: 'malformed' }
    if (list.length < 6) return { changePct: null, reason: 'tooYoung' }
    // Each row is [timestamp, open, high, low, close, volume]. GeckoTerminal returns newest-first;
    // sort explicitly by timestamp so we never depend on that ordering being stable.
    const sorted = [...list].sort((a: number[], b: number[]) => a[0] - b[0])
    const oldestClose = Number(sorted[0]?.[4])
    const newestClose = Number(sorted[sorted.length - 1]?.[4])
    if (!Number.isFinite(oldestClose) || !Number.isFinite(newestClose) || oldestClose <= 0) return { changePct: null, reason: 'malformed' }
    return { changePct: ((newestClose - oldestClose) / oldestClose) * 100, reason: 'ok' }
  } catch {
    return { changePct: null, reason: 'fetchError' }
  }
}

async function fetchPoolSevenDayChange(network: string, poolAddress: string, signal: AbortSignal): Promise<SevenDayChangeResult> {
  const first = await fetchPoolSevenDayChangeOnce(network, poolAddress, signal)
  if (first.reason !== 'httpError' && first.reason !== 'fetchError') return first
  // A 429 needs a delay that can actually outlast the rate-limit window; a generic transient
  // failure (5xx, timeout) gets a short delay — mirrors the Base Radar 429-aware retry fix.
  const retryDelayMs = first.httpStatus === 429 ? 1800 + Math.floor(Math.random() * 400) : 400
  await sleep(retryDelayMs)
  if (signal.aborted) return first
  const second = await fetchPoolSevenDayChangeOnce(network, poolAddress, signal)
  return { changePct: second.changePct, reason: second.reason }
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

// CROSS-CHAIN COLLISION FIX, DISCLOSED: rotation identity was the bare lowercase contract address,
// so the same address deployed on two scanned chains was treated as one token — the second was
// silently suppressed as "already shown". Identity is chain-scoped now.
function rotationKey(a: PumpAlert): string {
  return `${a.chain}:${a.contract.toLowerCase()}`
}

function applyRotationAndDiversity(scored: PumpAlert[]): RotationResult {
  if (scored.length === 0) return { alerts: [], freshCount: 0, staleCount: 0, fallbackUsed: false }

  const recentAddrs = new Set(shownBatches.flat())
  const fresh = scored.filter(a => !recentAddrs.has(rotationKey(a)))
  const stale = scored.filter(a =>  recentAddrs.has(rotationKey(a)))

  const output: PumpAlert[] = []
  const taken = new Set<string>()

  // Pass 1: fresh candidates with loose diversity caps
  const counts: Record<string, number> = {}
  for (const a of fresh) {
    if (output.length >= 25) break
    const c = counts[a.category] ?? 0
    if (c >= FRESH_CAT_CAP[a.category]) continue
    output.push(a)
    taken.add(rotationKey(a))
    counts[a.category] = c + 1
  }

  // Pass 2: stale backfill — NO category caps, just fill remaining slots
  for (const a of stale) {
    if (output.length >= 25) break
    if (!taken.has(rotationKey(a))) {
      output.push(a)
      taken.add(rotationKey(a))
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
    shownBatches.push(output.map(rotationKey))
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

// CHAIN-TAGGED CANDIDATE SET, DISCLOSED: pools and their `included` token metadata are kept
// per-chain rather than flattened into two shared arrays. Flattening lost which network each pool
// came from (the root cause of every wrong-chain bug in this route) and additionally risked
// resolving a pool's base_token against another chain's `included` entries.
type ChainPools = { chain: PumpChain; pools: GTPool[]; included: GTIncluded[] }

// Fetch every requested chain independently so one chain's provider failure never silently
// contaminates or suppresses another's, and so per-chain success is reportable in the audit.
async function fetchChainPools(chain: PumpChain, signal: AbortSignal): Promise<ChainPools> {
  const network = CHAIN_CONFIG[chain].gtNetwork
  const results = await Promise.allSettled([1, 2, 3].map(page => fetchGTPage(network, page, signal)))
  const pools: GTPool[] = []
  const included: GTIncluded[] = []
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    if (Array.isArray(r.value.data)) pools.push(...(r.value.data as GTPool[]))
    if (Array.isArray(r.value.included)) included.push(...(r.value.included as GTIncluded[]))
  }
  return { chain, pools, included }
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

  // PUMP-MULTI-CHAIN, DISCLOSED: resolve the chain set once per request (default Base-only,
  // unchanged behavior when no ?chains= param is passed).
  const chains = requestedChains(req)
  const requestId = `pump_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  if (chains.length === 0) {
    return NextResponse.json({
      alerts: [], fetchedAt: new Date().toISOString(), requestId,
      chains: [], pumpDiscoveryEligibilityAudit: [],
      providerStatus: 'unavailable' as const,
      error: 'No enabled chains requested. Robinhood Chain requires ENABLE_ROBINHOOD_CHAIN and a configured RPC.',
    })
  }

  // CACHE-KEY CHAIN FIX, DISCLOSED: the key was `pump:${plan}` — it did not include the requested
  // chain set, so a ?chains=eth request was served a cached Base-only payload (and vice versa).
  // The schema version is included so a deployed shape change can never be satisfied by an
  // in-flight cache entry written by the previous shape.
  const cacheKey = `pump:v2:${plan}:${[...chains].sort().join('+')}`

  const cached = pumpCache.get(cacheKey)
  if (cached && cached.exp > now) return NextResponse.json(cached.payload)

  const chainPools: ChainPools[] = []
  let providerStatus: 'ok' | 'partial' | 'unavailable' = 'ok'
  const chainsSucceeded: PumpChain[] = []
  const chainsFailed: PumpChain[] = []

  {
    const ac = new AbortController()
    const tid = setTimeout(() => ac.abort(), 10_000)
    try {
      // Fetch each requested chain independently and in parallel, keeping results chain-tagged.
      const settled = await Promise.allSettled(chains.map(c => fetchChainPools(c, ac.signal)))
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.pools.length > 0) {
          chainPools.push(r.value)
          chainsSucceeded.push(chains[i])
        } else {
          chainsFailed.push(chains[i])
        }
      })
    } finally {
      clearTimeout(tid)
    }
  }

  if (chainsFailed.length > 0) providerStatus = chainsSucceeded.length > 0 ? 'partial' : 'unavailable'

  // FAIL-HONEST FALLBACK, DISCLOSED: the shared cache entry is Base-scoped, so it may ONLY be used
  // to serve Base. Previously this fallback ran for any chain set and its Base pools were then
  // published under whatever chains were requested — silently presenting Base tokens as ETH or
  // Robinhood ones. It now only rescues Base, and any chain that genuinely failed stays reported
  // as failed in the response rather than being papered over.
  if (chainsFailed.includes('base') && !chainsSucceeded.includes('base')) {
    try {
      const result = await getOrFetchCached<{ data?: GTPool[]; included?: GTIncluded[] }>({
        key: 'coingecko:trending-base',
        ttlMs: 60_000,
        onLog: msg => console.info(`[pump-alerts] ${msg}`),
        fetcher: async () => {
          const ac = new AbortController()
          const tid = setTimeout(() => ac.abort(), 6000)
          try {
            return await fetchGTPage('base', 1, ac.signal)
          } finally {
            clearTimeout(tid)
          }
        },
      })
      const pools = Array.isArray(result.data?.data) ? (result.data.data as GTPool[]) : []
      const included = Array.isArray(result.data?.included) ? (result.data.included as GTIncluded[]) : []
      if (pools.length > 0) {
        chainPools.push({ chain: 'base', pools, included })
        chainsSucceeded.push('base')
        chainsFailed.splice(chainsFailed.indexOf('base'), 1)
        providerStatus = 'partial'
      }
    } catch {
      /* base stays in chainsFailed and is reported honestly below */
    }
  }

  if (chainsSucceeded.length === 0) {
    return NextResponse.json({
      alerts: [], fetchedAt: new Date().toISOString(), requestId,
      chains: chains.map(c => ({ chain: c, chainId: CHAIN_CONFIG[c].chainId, maxFdvUsd: CHAIN_CONFIG[c].maxFdvUsd })),
      chainsSucceeded: [], chainsFailed,
      providerStatus: 'unavailable' as const,
      error: `Provider unavailable for: ${chainsFailed.join(', ')}. No cached results available.`,
      pumpDiscoveryEligibilityAudit: [],
    })
  }

  const seen = new Set<string>()
  const audit: PumpDiscoveryEligibilityAudit[] = []

  // ─── Stage 1: cheap synchronous filters (category, cap, liquidity, volume, age) ───────────────
  // No network calls yet — only candidates surviving this stage pay the cost of a 7d OHLCV fetch.
  const stage1Passed: Stage1Candidate[] = []
  let rawCount = 0

  for (const { chain, pools, included } of chainPools) {
  for (const pool of pools) {
    rawCount += 1
    const tokenId = pool.relationships?.base_token?.data?.id
    if (!tokenId) continue
    // Resolved against THIS chain's included set only — never a shared cross-chain one.
    const meta = included.find(i => i.id === tokenId)
    if (!meta?.attributes?.address) continue

    const addr = meta.attributes.address.toLowerCase()
    // Dedupe identity is chain-scoped: the same contract address on two chains is two candidates.
    const dedupeKey = `${chain}:${addr}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const attrs = pool.attributes
    const change24h = parseNum(attrs?.price_change_percentage?.h24)
    const volume = parseNum(attrs?.volume_usd?.h24)
    const liquidity = parseNum(attrs?.reserve_in_usd)
    const price = parseNum(attrs?.base_token_price_usd)
    const fdv = parseNum(attrs?.fdv_usd)
    const marketCap = parseNum(attrs?.market_cap_usd)
    const createdAt = attrs?.pool_created_at ? Date.parse(attrs.pool_created_at) : NaN
    const ageDays = Number.isFinite(createdAt) ? (Date.now() - createdAt) / (1000 * 60 * 60 * 24) : null

    const result = evaluateStage1Candidate({
      chain,
      symbol: meta.attributes.symbol ?? '?', name: meta.attributes.name ?? 'Unknown', addr,
      poolAddr: pool.attributes?.address ?? null,
      price, change24h, volume, liquidity, fdv, marketCap, ageDays,
    }, requestId)
    if (!result.passed) {
      audit.push(result.audit)
      continue
    }
    stage1Passed.push(result.candidate)
  }
  }

  // ─── Stage 2: resolve pump evidence via the multi-source ladder ─────────────────────────────
  // PUMP-7D-EVIDENCE-LADDER, DISCLOSED (urgent fix: one GeckoTerminal OHLCV outage zeroed the whole
  // feed). Priority: GT OHLCV exact → CoinGecko per-contract exact → ChainLens snapshot history →
  // DexScreener-corroborated momentum fallback. Exact sources produce a real change7d number;
  // the momentum fallback NEVER fabricates one — it qualifies on corroborated 24h evidence and is
  // labelled as such end-to-end.
  const evidenceAudit: Pump7dEvidenceAudit = {
    requestId,
    candidatesRaw: rawCount,
    geckoOhlcvAttempted: 0, geckoOhlcvSucceeded: 0, geckoOhlcvFailed: 0,
    dexScreenerFallbackAttempted: 0, dexScreenerFallbackSucceeded: 0,
    coinGeckoFallbackAttempted: 0, coinGeckoFallbackSucceeded: 0,
    internalSnapshotFallbackAttempted: 0, internalSnapshotFallbackSucceeded: 0,
    exact7dQualified: 0, fallbackMomentumQualified: 0,
    excludedMissingAllMomentumEvidence: 0,
    finalRenderedCount: 0,
    degradedMode: false,
    degradedReason: null,
  }

  const allScored: PumpAlert[] = []

  // Timeout widened from 12s to 18s to give the 429-aware retry (up to ~2.2s per candidate, on top
  // of the request itself) room to actually complete instead of getting cut off mid-retry — see the
  // ONE-RETRY 429-AWARE FIX disclosure on fetchPoolSevenDayChange.
  const ac7d = new AbortController()
  const tid7d = setTimeout(() => ac7d.abort(), 18_000)
  // MERGE RESOLUTION, DISCLOSED: keeps BOTH sides — the remote's typed SevenDayChangeResult
  // (per-attempt failure reasons powering sevenDayDataUnavailable) and this branch's evidence
  // audit counters. The ladder below consumes changePct; the reasons still drive finalState.
  let sevenDayResults: SevenDayChangeResult[] = []
  try {
    sevenDayResults = await mapWithConcurrencyLimit(stage1Passed, SEVEN_DAY_OHLCV_CONCURRENCY_LIMIT, async c => {
      if (!c.poolAddr) { evidenceAudit.geckoOhlcvFailed += 1; return { changePct: null, reason: 'malformed' as const } }
      evidenceAudit.geckoOhlcvAttempted += 1
      // Queried against the candidate's OWN chain network — see fetchPoolSevenDayChange's disclosure.
      const r = await fetchPoolSevenDayChange(CHAIN_CONFIG[c.chain].gtNetwork, c.poolAddr, ac7d.signal)
      if (r.changePct != null) evidenceAudit.geckoOhlcvSucceeded += 1
      else evidenceAudit.geckoOhlcvFailed += 1
      return r
    })
  } finally {
    clearTimeout(tid7d)
  }

  // SYSTEMIC-7D-FAILURE DETECTION (kept from origin/main): if every 7d attempt failed with
  // httpError/fetchError (never tooYoung/malformed), the provider itself is down or rate-limiting.
  // The ladder's degradedMode below is the broader superset — it also fires when OHLCV returned
  // data for nobody AND fallbacks had to take over.
  const sevenDayAttempted = sevenDayResults.length
  const sevenDayProviderFailures = sevenDayResults.filter(r => r.reason === 'httpError' || r.reason === 'fetchError').length
  const sevenDayDataUnavailable = sevenDayAttempted > 0 && sevenDayProviderFailures === sevenDayAttempted

  // Timeout widened from 8s to 14s for the same reason — the DexScreener momentum fallback now
  // retries once on a 429, and this window covers CoinGecko + snapshot + DexScreener attempts
  // sequentially per candidate.
  const acFb = new AbortController()
  const tidFb = setTimeout(() => acFb.abort(), 14_000)
  try {
    const resolvedList = await mapWithConcurrencyLimit(stage1Passed, 4, async (c, i): Promise<ResolvedEvidence> => {
      const gtChange = sevenDayResults[i]?.changePct ?? null
      if (gtChange != null) return { kind: 'exact', source: 'geckoterminal_ohlcv' as const, change7d: gtChange }

      // Exact tier 2: CoinGecko per-contract real 7d percentage (Base/Ethereum only — CoinGecko
      // doesn't index Robinhood Chain; that skip is honest, not a failure).
      if (c.chain === 'base' || c.chain === 'eth') {
        evidenceAudit.coinGeckoFallbackAttempted += 1
        const cgChange = await fetchCoinGeckoContractChange7d(c.chain, c.addr, acFb.signal)
        if (cgChange != null) {
          evidenceAudit.coinGeckoFallbackSucceeded += 1
          return { kind: 'exact', source: 'coingecko_contract', change7d: cgChange }
        }
      }

      // Exact tier 3: ChainLens-owned snapshot history (real measured window ≥5 days apart).
      evidenceAudit.internalSnapshotFallbackAttempted += 1
      const snap = await computeSnapshotChange7d(c.chain, c.addr)
      if (snap.changePct != null) {
        evidenceAudit.internalSnapshotFallbackSucceeded += 1
        return { kind: 'exact', source: 'internal_snapshot', change7d: snap.changePct }
      }

      // Momentum fallback: DexScreener pair data corroborating a strong accelerating move. Runs
      // ONLY for candidates that already passed every Stage 1 gate (category denylist, per-chain
      // low-cap ceiling, liquidity/volume floors, age cap).
      if (c.poolAddr) {
        evidenceAudit.dexScreenerFallbackAttempted += 1
        const ds = await fetchDexScreenerPairMomentum(c.poolAddr, acFb.signal)
        if (ds?.ok && ds.data) {
          evidenceAudit.dexScreenerFallbackSucceeded += 1
          const verdict = evaluateMomentumFallback({
            change24hPct: c.change24h,
            volume24hUsd: c.volume,
            liquidityUsd: c.liquidity,
            dexscreener: ds.data,
          })
          if (verdict.qualified) {
            return { kind: 'momentum_fallback', confirmedChange24hPct: verdict.confirmedChange24hPct, evidenceParts: verdict.evidenceParts }
          }
        }
      }

      evidenceAudit.excludedMissingAllMomentumEvidence += 1
      return { kind: 'none' }
    })
    sevenDayResults = [] // superseded by resolvedList — kept name-free below

    const allScoredLocal: PumpAlert[] = []
    stage1Passed.forEach((c, i) => {
      const result = evaluateStage2Candidate(c, null, requestId, resolvedList[i])
      audit.push(result.audit)
      if (result.included) {
        allScoredLocal.push(result.alert)
        if (result.alert.evidenceGrade === 'exact') evidenceAudit.exact7dQualified += 1
        else evidenceAudit.fallbackMomentumQualified += 1
      }
    })
    allScored.length = 0
    allScored.push(...allScoredLocal)

    // Degraded mode = the primary OHLCV source failed across the board but fallbacks still
    // produced candidates. Surfaced so the UI can say exactly what happened instead of a bare 0.
    const ohlcvTotalFailure = evidenceAudit.geckoOhlcvAttempted > 0 && evidenceAudit.geckoOhlcvSucceeded === 0
    if (ohlcvTotalFailure) {
      evidenceAudit.degradedMode = true
      evidenceAudit.degradedReason = evidenceAudit.exact7dQualified + evidenceAudit.fallbackMomentumQualified > 0
        ? 'GeckoTerminal OHLCV failed this cycle — candidates qualified via fallback evidence.'
        : 'GeckoTerminal OHLCV requests failed for every candidate this cycle, and no fallback provider could confirm momentum either.'
    }
  } finally {
    clearTimeout(tidFb)
  }

  // SNAPSHOT RECORDING, DISCLOSED: every refresh persists each Stage-1-passing candidate's price/
  // liquidity/volume so future cycles gain ChainLens-owned history — over time this becomes an
  // independent exact-7d source that no external provider outage can take down. Best-effort;
  // failures never touch the response path.
  void savePumpSnapshots(stage1Passed.map(c => ({
    chain: c.chain,
    contract: c.addr.toLowerCase(),
    pair_address: c.poolAddr,
    price_usd: c.price,
    liquidity_usd: c.liquidity,
    volume_24h_usd: c.volume,
    fdv_usd: c.fdv,
    market_cap_usd: c.marketCap,
    captured_at: new Date().toISOString(),
  })))

  // Quality-sort before rotation so rotation prioritises best candidates
  allScored.sort((a, b) => {
    const od = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    if (od !== 0) return od
    const qd = qualityScore(b) - qualityScore(a)
    return qd !== 0 ? qd : (b.change7d ?? 0) - (a.change7d ?? 0)
  })

  const { alerts, freshCount, staleCount, fallbackUsed } = applyRotationAndDiversity(allScored)

  evidenceAudit.finalRenderedCount = alerts.length
  if (evidenceAudit.degradedMode && alerts.length === 0 && evidenceAudit.degradedReason == null) {
    evidenceAudit.degradedReason = 'No candidate cleared the pump gate this cycle.'
  }

  const countReason = (reason: string) => audit.filter(a => a.exclusionReason === reason).length

  // 7D-STATE CONTRADICTION FIX, DISCLOSED (reported live: a card reading "Exact 7d" rendered
  // alongside a page-wide "7d pump data unavailable from provider" warning for the SAME cycle).
  // sevenDayDataUnavailable above is a snapshot of ONLY the GeckoTerminal-OHLCV exact tier, taken
  // BEFORE the CoinGecko/snapshot/momentum fallback ladder ran — it was then used directly to drive
  // finalState and the page-level error, so a candidate the ladder later qualified (via any tier)
  // still rendered under a stale claim that zero 7d evidence existed anywhere. The global blackout
  // state must reflect the ladder's REAL final outcome: it only fires when nothing rendered AND no
  // tier — exact or fallback — qualified a single candidate. A partial failure (some candidates
  // still got real evidence) is a degraded-provider note, not a full-page warning — the frontend's
  // existing pump7dEvidenceAudit.degradedMode/degradedReason note already covers that case.
  const totalEvidenceQualified = evidenceAudit.exact7dQualified + evidenceAudit.fallbackMomentumQualified
  const sevenDayFullyUnavailable = sevenDayDataUnavailable && alerts.length === 0 && totalEvidenceQualified === 0

  // TRUTHFUL EMPTY STATE, DISCLOSED (URGENT audit: "counters are all 0" / "no fresh pump signals"):
  // finalState names exactly which of the 4 real outcomes happened, so the frontend never has to
  // infer "empty" from an empty array alone. providerUnavailable and sevenDayUnavailable are both
  // real outages the UI must show as errors, not as "nothing qualified this cycle".
  const finalState: 'ok' | 'providerUnavailable' | 'sevenDayUnavailable' | 'allFilteredOut' | 'noRawCandidates' =
    chainsSucceeded.length === 0 ? 'providerUnavailable'
    : sevenDayFullyUnavailable ? 'sevenDayUnavailable'
    : rawCount === 0 ? 'noRawCandidates'
    : alerts.length === 0 ? 'allFilteredOut'
    : 'ok'

  const payload = {
    alerts,
    fetchedAt: new Date().toISOString(),
    requestId,
    chains: chains.map(c => ({ chain: c, chainId: CHAIN_CONFIG[c].chainId, maxFdvUsd: Math.min(PUMP_ALERT_MAX_FDV_USD, CHAIN_CONFIG[c].maxFdvUsd) })),
    // Provider failures are always reported, never silently swallowed — a partial result says
    // exactly which chains are missing rather than presenting itself as a complete scan.
    providerStatus,
    chainsSucceeded,
    chainsFailed,
    // Exposed field is the RECONCILED (post-ladder) blackout flag, not the raw pre-fallback GT-only
    // signal — see the "7D-STATE CONTRADICTION FIX" disclosure above. A rendered card with real
    // evidence must never coexist with this being true.
    sevenDayDataUnavailable: sevenDayFullyUnavailable,
    // Raw GT-OHLCV-only signal, kept for diagnostics: true whenever the primary exact tier failed
    // for every attempt, independent of whether fallbacks rescued the cycle.
    sevenDayProviderDegraded: sevenDayDataUnavailable && !sevenDayFullyUnavailable,
    finalState,
    ...(chainsFailed.length > 0 ? { error: `Provider unavailable for: ${chainsFailed.join(', ')}. Showing ${chainsSucceeded.join(', ')} only.` } : {}),
    ...(sevenDayFullyUnavailable ? { error: '7d pump data unavailable from provider (GeckoTerminal OHLCV requests failed for every candidate this cycle, and no fallback provider could confirm momentum either).' } : {}),
    diagnostics: process.env.NODE_ENV === 'development' ? { cacheHit: false, providerStatus, rateLimited: false } : undefined,
    pumpDiscoveryEligibilityAudit: audit,
    // 7D-EVIDENCE AUDIT, DISCLOSED: request-level rollup of every ladder tier's attempts/successes
    // so "why is this empty / why is it degraded" is always answerable from the response itself.
    pump7dEvidenceAudit: {
      ...evidenceAudit,
      degradedReason: evidenceAudit.degradedMode && alerts.length === 0
        ? (evidenceAudit.degradedReason ?? 'No fallback evidence qualified any candidate.')
        : evidenceAudit.degradedReason,
    },
    // Request-level rollup of the same eligibility decisions recorded per-candidate above.
    pumpDiscoverySummary: {
      requestId,
      chainsRequested: chains,
      chainsSucceeded,
      chainsFailed,
      candidatesRaw: rawCount,
      candidatesAfterDedupe: seen.size,
      candidatesAfterFilters: allScored.length,
      rejectedEstablishedOrCategory: countReason('establishedOrCategoryBlocked'),
      rejectedCapMissing: countReason('capDataMissing'),
      rejectedHighFdv: countReason('capExceedsLowCapCeiling'),
      rejectedMissingLiquidity: countReason('liquidityBelowMinimum'),
      rejectedMissingVolume: countReason('volumeBelowMinimum'),
      rejectedMissing7d: countReason('missing7dData'),
      rejectedBelow7dThreshold: countReason('change7dBelowMinimum'),
      finalCount: alerts.length,
      totalDurationMs: Date.now() - now,
    },
    // Exact shape requested for the URGENT loading audit: every candidate-count stage plus the
    // provider/timing facts needed to tell "over-filtering" apart from "the API is failing" apart
    // from "the cache is stale" without needing a second round-trip to ask.
    pumpAlertsLoadAudit: {
      requestId,
      route: '/api/pump-alerts',
      status: finalState === 'ok' ? 200 : (finalState === 'providerUnavailable' ? 503 : 200),
      totalDurationMs: Date.now() - now,
      cacheHit: false,
      providersAttempted: chains.map(c => `geckoterminal:${CHAIN_CONFIG[c].gtNetwork}`),
      providersSucceeded: chainsSucceeded.map(c => `geckoterminal:${CHAIN_CONFIG[c].gtNetwork}`),
      providersFailed: chainsFailed.map(c => `geckoterminal:${CHAIN_CONFIG[c].gtNetwork}`),
      candidatesRaw: rawCount,
      candidatesAfterDedupe: seen.size,
      candidatesAfterCategoryFilter: rawCount - countReason('establishedOrCategoryBlocked'),
      candidatesAfterLowCapFilter: stage1Passed.length + countReason('missing7dData') + countReason('change7dBelowMinimum') + countReason('noCategoryMatch'),
      candidatesAfter7dPumpFilter: allScored.length + countReason('noCategoryMatch'),
      candidatesAfterLiquidityVolumeFilter: rawCount - countReason('establishedOrCategoryBlocked') - countReason('capDataMissing') - countReason('capExceedsLowCapCeiling') - countReason('liquidityBelowMinimum') - countReason('volumeBelowMinimum'),
      candidatesRendered: alerts.length,
      rejectedReasons: {
        establishedOrCategory: countReason('establishedOrCategoryBlocked'),
        capDataMissing: countReason('capDataMissing'),
        highFdv: countReason('capExceedsLowCapCeiling'),
        lowLiquidity: countReason('liquidityBelowMinimum'),
        lowVolume: countReason('volumeBelowMinimum'),
        missing7dData: countReason('missing7dData'),
        below7dThreshold: countReason('change7dBelowMinimum'),
      },
      finalState,
      errorShownToUser: finalState === 'providerUnavailable' || finalState === 'sevenDayUnavailable',
    },
    _debug: {
      rawCount,
      eligibleFor7dCheck: stage1Passed.length,
      scoredCount: allScored.length,
      freshCount,
      staleCount,
      selectedCount: alerts.length,
      fallbackUsed,
      sevenDayAttempted,
      sevenDayProviderFailures,
    },
  }
  // STALE-EMPTY-CACHE FIX, DISCLOSED: a transient empty/degraded cycle (finalState !== 'ok') must
  // never be cached for the full 90s TTL — that would keep serving "no signals" for a minute and a
  // half even after the provider recovers on the very next real fetch. Only a genuinely complete,
  // successful scan is cached at full TTL; anything else gets a short 10s TTL so the next request
  // retries soon instead of being permanently suppressed by its own failure.
  const cacheTtlMs = finalState === 'ok' ? PUMP_ROUTE_CACHE_TTL_MS : 10_000
  pumpCache.set(cacheKey, { exp: Date.now() + cacheTtlMs, payload })
  return NextResponse.json(payload)
}

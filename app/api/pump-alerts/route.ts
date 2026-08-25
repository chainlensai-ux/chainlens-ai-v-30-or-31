import { NextResponse } from 'next/server'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import {
  PUMP_REQUIRE_EXACT_14D,
  fetchCoinGeckoContractChange14d,
  savePumpSnapshots,
  computeSnapshotChange14d,
  type Pump14dEvidenceAudit,
  type FourteenDayEvidenceSource,
} from '@/lib/server/pump14dEvidence'

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
// denylist plus 24h-only momentum thresholds — no cap ceiling, no 14-day confirmation, no
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
const PUMP_ALERT_MIN_14D_CHANGE_PCT = envNumber('PUMP_ALERT_MIN_14D_CHANGE_PCT', 25)
const PUMP_ALERT_MIN_LIQUIDITY_USD = envNumber('PUMP_ALERT_MIN_LIQUIDITY_USD', 10_000)
const PUMP_ALERT_MIN_24H_VOLUME_USD = envNumber('PUMP_ALERT_MIN_24H_VOLUME_USD', 10_000)
const PUMP_ALERT_MAX_TOKEN_AGE_DAYS = envOptionalNumber('PUMP_ALERT_MAX_TOKEN_AGE_DAYS')
const PUMP_ALERT_EXCLUDE_ESTABLISHED_TOKENS = envBool('PUMP_ALERT_EXCLUDE_ESTABLISHED_TOKENS', true)

// CANDIDATE-EVALUATION-DEPTH FIX, DISCLOSED (reported live: candidatesRaw=20 but every evidence
// tier only ever attempted 3 — the whole feed went dark once those 3 failed, even though nothing
// says the other 17 were majors/stables; Stage 1 already evaluates every raw candidate, so a small
// stage1Passed count is a genuine "few eligible candidates this cycle" fact, not an early-stop bug
// — but the pipeline had no way to say so, and no way to keep trying past a small qualifying set
// when a larger one exists). These three knobs make evaluation depth explicit and tunable instead
// of implicitly "whatever Stage 1 happened to pass":
// - target: stop early once this many candidates have qualified (success case, don't overspend budget)
// - max evaluated: hard ceiling so a huge stage1Passed set (never seen yet, but possible) can't run
//   the request past its time budget
// - min before stop: below this qualified count, an evaluation cut short by the max-evaluated
//   ceiling is reported as budget-exhausted (there was more to try) rather than as a clean "nothing
//   qualified" result
const PUMP_ALERT_TARGET_RESULTS = envNumber('PUMP_ALERT_TARGET_RESULTS', 10)
const PUMP_ALERT_MAX_CANDIDATES_EVALUATED = envNumber('PUMP_ALERT_MAX_CANDIDATES_EVALUATED', 50)
const PUMP_ALERT_MIN_RESULTS_BEFORE_STOP = envNumber('PUMP_ALERT_MIN_RESULTS_BEFORE_STOP', 5)

// LIVE-MOMENTUM ELIGIBILITY MODE, DISCLOSED (URGENT fix request: "Pump Alerts should not require
// perfect 14d/7d OHLCV proof before showing anything... show live low-cap momentum coins using
// available evidence, then clearly label evidence quality"). Reported live: 12 candidates reached
// evidence checking, 0 qualified exact, 0 qualified momentum-fallback — the feed went empty even
// though GeckoTerminal's OWN pool-list response already carries h24/h6/h1 price-change and volume
// figures for every candidate, with ZERO extra network calls needed. The old momentum_fallback tier
// required a separate DexScreener fetch AND strict two-provider corroboration, so it failed whenever
// DexScreener itself was unreachable — exactly the "every provider failed" scenario reported live.
// Live Momentum mode below is evaluated synchronously from data Stage 1 already has, so a candidate
// can ALWAYS be checked for it regardless of whether any external OHLCV/CoinGecko/DexScreener call
// ever succeeds. It never fabricates a 7d/14d number — change14d stays null and the card is labelled
// "Live Momentum", never "Exact 14d". Its FDV ceiling is deliberately wider than the exact-evidence
// ceiling (still capped by each chain's own hard limit) since a real live mover is worth surfacing
// even above the exact tier's stricter low-cap bar.
const PUMP_ALERT_LIVE_MOMENTUM_MIN_24H_CHANGE_PCT = envNumber('PUMP_ALERT_LIVE_MOMENTUM_MIN_24H_CHANGE_PCT', 8)
const PUMP_ALERT_LIVE_MOMENTUM_MIN_6H_CHANGE_PCT = envNumber('PUMP_ALERT_LIVE_MOMENTUM_MIN_6H_CHANGE_PCT', 4)
const PUMP_ALERT_LIVE_MOMENTUM_MIN_1H_CHANGE_PCT = envNumber('PUMP_ALERT_LIVE_MOMENTUM_MIN_1H_CHANGE_PCT', 2)
const PUMP_ALERT_LIVE_MOMENTUM_MAX_FDV_USD = envNumber('PUMP_ALERT_LIVE_MOMENTUM_MAX_FDV_USD', 25_000_000)
// "Volume expansion / strong volume relative to liquidity" from the fix request, made concrete: 24h
// volume must be at least this fraction of liquidity — a real, actively-traded pool, not a stale one
// that happens to show a stale price delta. Not specified numerically in the request; disclosed here
// as this route's own choice, env-overridable like every other threshold in this file.
const PUMP_ALERT_LIVE_MOMENTUM_MIN_VOL_LIQ_RATIO = envNumber('PUMP_ALERT_LIVE_MOMENTUM_MIN_VOL_LIQ_RATIO', 0.5)

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
  // LIVE MOMENTUM MODE, DISCLOSED: 6h/1h change from GeckoTerminal's own pool data, shown on the
  // card when available so a live-momentum qualification is never just a bare, unexplained badge.
  change6h: number | null
  change1h: number | null
  change14d: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  tokenAgeDays: number | null
  // ELIGIBILITY-MODEL FIX, DISCLOSED: how this candidate qualified. 'exact' = a real measured 14d
  // change (GeckoTerminal OHLCV, CoinGecko per-contract, or ChainLens snapshots ≥12 days apart).
  // 'live_momentum' = exact 14d evidence was unavailable or never attempted, but real live 24h/6h/1h
  // price movement + volume-relative-to-liquidity evidence qualified it instead, evaluated straight
  // from the same GeckoTerminal pool data Stage 1 already has (no extra network call) — change14d
  // stays null in that case, never faked.
  evidenceSource: FourteenDayEvidenceSource | 'live_momentum'
  evidenceGrade: 'exact' | 'live_momentum'
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
  priceChange14dPct: number | null
  priceChange24hPct: number | null
  tokenAgeDays: number | null
  excluded: boolean
  exclusionReason: string | null
  qualifiesAsLowCap: boolean
  lowCapQualified: boolean
  qualifiesAs14dPump: boolean
  categoryBlocked: boolean
  // 'exact' | 'live_momentum' | 'none' | 'not_evaluated' (Stage 1 rejections never reach the
  // evidence ladder, so their evidenceMode is honestly 'not_evaluated' rather than a guess).
  evidenceMode: 'exact' | 'live_momentum' | 'none' | 'not_evaluated'
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
    volume_usd?: { h24?: number | string; h6?: number | string; h1?: number | string }
    price_change_percentage?: { h24?: number | string; h6?: number | string; h1?: number | string }
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
  price: number | null
  change24h: number | null; change6h: number | null; change1h: number | null
  volume: number | null; liquidity: number | null
  fdv: number | null; marketCap: number | null; ageDays: number | null
  // DUAL-CEILING MODEL, DISCLOSED: a candidate can be too big for the strict exact-evidence tier
  // while still legitimately fitting the wider live-momentum tier's FDV ceiling (both are always
  // additionally capped by the candidate's own chain's hard limit). Stage 1 only hard-rejects on
  // cap when NEITHER mode's ceiling is met; which mode(s) actually apply is carried forward here so
  // Stage 2 enforces the correct, mode-specific ceiling rather than the union used for the initial
  // pass/fail gate.
  qualifiesForExactCap: boolean
  qualifiesForLiveMomentumCap: boolean
}
export type Stage1Input = { chain?: PumpChain; symbol: string; name: string; addr: string; poolAddr: string | null } & {
  price: number | null
  change24h: number | null; change6h: number | null; change1h: number | null
  volume: number | null; liquidity: number | null
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
  // PER-CHAIN CEILING FIX, DISCLOSED: each mode's ceiling is the STRICTER of this candidate's own
  // chain limit and the env-configured cap for that mode — never the most-permissive limit across
  // all requested chains, which previously let a Base token up to ETH's $50M ceiling through its
  // own $20M one. This is only correct because `chain` is now the candidate's real chain, not a
  // request-level default.
  const exactMaxFdv = Math.min(PUMP_ALERT_MAX_FDV_USD, chainCfg.maxFdvUsd)
  const exactMaxMarketCap = Math.min(PUMP_ALERT_MAX_MARKET_CAP_USD, chainCfg.maxFdvUsd)
  const liveMomentumMaxFdv = Math.min(PUMP_ALERT_LIVE_MOMENTUM_MAX_FDV_USD, chainCfg.maxFdvUsd)
  const qualifiesForExactCap =
    (input.fdv != null && input.fdv > 0 && input.fdv <= exactMaxFdv) ||
    (input.marketCap != null && input.marketCap > 0 && input.marketCap <= exactMaxMarketCap)
  const qualifiesForLiveMomentumCap =
    (input.fdv != null && input.fdv > 0 && input.fdv <= liveMomentumMaxFdv) ||
    (input.marketCap != null && input.marketCap > 0 && input.marketCap <= liveMomentumMaxFdv)
  // ELIGIBILITY-MODEL FIX, DISCLOSED: the pass/fail gate uses the UNION of both ceilings — a
  // candidate is only hard-rejected on cap when it fits under NEITHER mode. Previously a single
  // ceiling could reject a $20M-FDV candidate before it ever got a chance at live-momentum
  // qualification (its wider, deliberately more permissive ceiling).
  const qualifiesAsLowCap = qualifiesForExactCap || qualifiesForLiveMomentumCap
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
        priceChange14dPct: null, priceChange24hPct: input.change24h, tokenAgeDays: input.ageDays,
        excluded: true, exclusionReason,
        qualifiesAsLowCap: qualifiesAsLowCap && !capDataMissing,
        lowCapQualified: qualifiesAsLowCap && !capDataMissing,
        qualifiesAs14dPump: false, categoryBlocked, evidenceMode: 'not_evaluated', finalRankScore: null,
      },
    }
  }
  return {
    passed: true,
    candidate: {
      chain,
      symbol: input.symbol, name: input.name, addr: input.addr, poolAddr: input.poolAddr,
      price: input.price, change24h: input.change24h, change6h: input.change6h, change1h: input.change1h,
      volume: input.volume, liquidity: input.liquidity,
      fdv: input.fdv, marketCap: input.marketCap, ageDays: input.ageDays,
      qualifiesForExactCap, qualifiesForLiveMomentumCap,
    },
  }
}

// LIVE MOMENTUM MODE, DISCLOSED (URGENT fix request, model "B"): qualifies a candidate on real,
// currently-observable momentum — no exact 7d/14d change required, no external OHLCV/CoinGecko/
// DexScreener call needed. Every input here already exists on the Stage 1 candidate, sourced
// straight from GeckoTerminal's own pools-list response. Pure and synchronous by design — this is
// the tier that guarantees the feed can show something real even during a total exact-evidence
// provider outage, without ever fabricating a 7d/14d number.
export type LiveMomentumVerdict =
  | { qualified: true; changeWindow: '24h' | '6h' | '1h'; changeValuePct: number; volumeLiquidityRatio: number; evidenceParts: string[] }
  | { qualified: false; reason: string }

export function evaluateLiveMomentum(c: Stage1Candidate): LiveMomentumVerdict {
  if (!c.qualifiesForLiveMomentumCap) return { qualified: false, reason: 'capExceedsLiveMomentumCeiling' }
  if (c.liquidity == null || c.liquidity < PUMP_ALERT_MIN_LIQUIDITY_USD) return { qualified: false, reason: 'liquidityBelowMinimum' }
  if (c.volume == null || c.volume < PUMP_ALERT_MIN_24H_VOLUME_USD) return { qualified: false, reason: 'volumeBelowMinimum' }

  let changeWindow: '24h' | '6h' | '1h' | null = null
  let changeValuePct = 0
  if (c.change24h != null && c.change24h >= PUMP_ALERT_LIVE_MOMENTUM_MIN_24H_CHANGE_PCT) {
    changeWindow = '24h'; changeValuePct = c.change24h
  } else if (c.change6h != null && c.change6h >= PUMP_ALERT_LIVE_MOMENTUM_MIN_6H_CHANGE_PCT) {
    changeWindow = '6h'; changeValuePct = c.change6h
  } else if (c.change1h != null && c.change1h >= PUMP_ALERT_LIVE_MOMENTUM_MIN_1H_CHANGE_PCT) {
    changeWindow = '1h'; changeValuePct = c.change1h
  }
  if (changeWindow == null) return { qualified: false, reason: 'noMomentum' }

  // "Volume expansion / strong volume relative to liquidity" — real, active trading, not a stale
  // price delta on a dead pool.
  const volumeLiquidityRatio = c.volume / c.liquidity
  if (!Number.isFinite(volumeLiquidityRatio) || volumeLiquidityRatio < PUMP_ALERT_LIVE_MOMENTUM_MIN_VOL_LIQ_RATIO) {
    return { qualified: false, reason: 'volumeNotExpanding' }
  }

  const evidenceParts = [
    `${changeWindow} change +${changeValuePct.toFixed(1)}%`,
    `volume/liquidity ${volumeLiquidityRatio.toFixed(2)}×`,
    `$${(c.liquidity / 1000).toFixed(0)}K liquidity`,
    `$${(c.volume / 1000).toFixed(0)}K 24h volume`,
  ]
  return { qualified: true, changeWindow, changeValuePct, volumeLiquidityRatio, evidenceParts }
}

export type Stage2Result =
  | { included: true; alert: PumpAlert; audit: PumpDiscoveryEligibilityAudit }
  | { included: false; audit: PumpDiscoveryEligibilityAudit }

// RESOLVED EVIDENCE, DISCLOSED: what the evidence resolution produced for one candidate before
// Stage 2 runs. Exactly one of the branches is populated. change14d is ONLY ever a real measured
// number — live-momentum candidates keep it null and carry the live-momentum label instead.
export type ResolvedEvidence =
  | { kind: 'exact'; source: FourteenDayEvidenceSource; change14d: number }
  | { kind: 'live_momentum'; verdict: LiveMomentumVerdict & { qualified: true } }
  | { kind: 'none' }

export function evaluateStage2Candidate(
  c: Stage1Candidate,
  change14d: number | null,
  requestId = 'n/a',
  resolved?: ResolvedEvidence,
): Stage2Result {
  const chain: PumpChain = c.chain ?? 'base'
  const chainId = CHAIN_CONFIG[chain].chainId
  const evidence: ResolvedEvidence = resolved ?? (change14d != null ? { kind: 'exact', source: 'geckoterminal_ohlcv', change14d } : { kind: 'none' })
  const auditBase = {
    requestId, token: c.addr, tokenAddress: c.addr, name: c.name, chain, chainSlug: chain, chainId,
    pairAddress: c.poolAddr,
    // source reflects how the candidate actually qualified — no longer hardcoded to the OHLCV
    // endpoint now that evidence can resolve via CoinGecko/snapshots/live momentum.
    source: evidence.kind === 'exact'
      ? `exact:${evidence.source}`
      : evidence.kind === 'live_momentum' ? 'live_momentum:gt_pool_data' : 'geckoterminal:ohlcv-day',
    symbol: c.symbol,
    fdvUsd: c.fdv, marketCapUsd: c.marketCap, liquidityUsd: c.liquidity, volume24hUsd: c.volume,
    priceChange14dPct: evidence.kind === 'exact' ? evidence.change14d : null,
    priceChange24hPct: c.change24h, tokenAgeDays: c.ageDays,
    evidenceMode: evidence.kind,
  }

  // ELIGIBILITY-MODEL FIX, DISCLOSED: PUMP_REQUIRE_EXACT_14D's whole purpose is "require a real
  // measured change before showing any candidate" — live-momentum evidence must never bypass that
  // when the flag is explicitly set, so it's treated as if no evidence resolved at all.
  // DUAL-CEILING DEFENSE, DISCLOSED: exact evidence resolved for a candidate that only fits the
  // wider live-momentum ceiling is also treated as unresolved — model A explicitly requires the
  // candidate to be low-cap under the STRICTER exact-mode ceiling, not the union used at Stage 1.
  // The real pipeline never fetches exact evidence for such a candidate in the first place, but
  // this function is pure and must not trust that its caller always got that right.
  const liveMomentumAllowed = !PUMP_REQUIRE_EXACT_14D
  const exactRejectedByCap = evidence.kind === 'exact' && !c.qualifiesForExactCap
  if (evidence.kind === 'none' || (evidence.kind === 'live_momentum' && !liveMomentumAllowed) || exactRejectedByCap) {
    return {
      included: false,
      audit: {
        ...auditBase, category: null, evidenceMode: 'none',
        excluded: true, exclusionReason: exactRejectedByCap ? 'capExceedsLowCapCeiling' : (PUMP_REQUIRE_EXACT_14D ? 'missing14dData' : 'rejectedNoMomentum'),
        qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs14dPump: false, categoryBlocked: false, finalRankScore: null,
      },
    }
  }

  const isLiveMomentum = evidence.kind === 'live_momentum'
  if (evidence.kind === 'exact' && evidence.change14d < PUMP_ALERT_MIN_14D_CHANGE_PCT) {
    return {
      included: false,
      audit: {
        ...auditBase, category: null,
        excluded: true, exclusionReason: 'change14dBelowMinimum',
        qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs14dPump: false, categoryBlocked: false, finalRankScore: null,
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
        qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs14dPump: !isLiveMomentum, categoryBlocked: false, finalRankScore: null,
      },
    }
  }

  const tags: string[] = []
  if (c.fdv != null && c.fdv > 0 && c.fdv < 100_000) tags.push('Microcap')
  if (c.volume == null || c.liquidity == null) tags.push('Needs Review')
  // Evidence badge data lives on the card too — never let a live-momentum token look identical to
  // an exact-14d one.
  if (isLiveMomentum) tags.push('Live Momentum — no exact 14d change confirmed yet')

  const capLabel = c.fdv != null ? `$${(c.fdv / 1_000_000).toFixed(2)}M FDV` : `$${((c.marketCap ?? 0) / 1_000_000).toFixed(2)}M MC`
  const qualifyingReason = isLiveMomentum
    ? `Live momentum: ${evidence.verdict.evidenceParts.join(', ')}, low-cap (${capLabel})`
    : `+${evidence.change14d.toFixed(1)}% over 14d, low-cap (${capLabel}), $${((c.liquidity ?? 0) / 1000).toFixed(0)}K liquidity, $${((c.volume ?? 0) / 1000).toFixed(0)}K 24h volume`

  const alert: PumpAlert = {
    symbol: c.symbol, name: c.name, contract: c.addr, chain, chainId, pairAddress: c.poolAddr,
    priceUsd: c.price, change24h: c.change24h, change6h: c.change6h, change1h: c.change1h,
    change14d: evidence.kind === 'exact' ? evidence.change14d : null,
    volume24hUsd: c.volume, liquidityUsd: c.liquidity, fdvUsd: c.fdv, marketCapUsd: c.marketCap,
    tokenAgeDays: c.ageDays,
    evidenceSource: isLiveMomentum ? 'live_momentum' : (evidence as { source: FourteenDayEvidenceSource }).source,
    evidenceGrade: isLiveMomentum ? 'live_momentum' : 'exact',
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
      qualifiesAsLowCap: true, lowCapQualified: true, qualifiesAs14dPump: !isLiveMomentum, categoryBlocked: false,
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

// CANDIDATE-EVALUATION-DEPTH FIX, DISCLOSED (URGENT fix request: "the backend is only attempting
// 14d/7d/fallback momentum checks on 3 candidates out of 20 — if those 3 fail, Pump Alerts shows
// zero results even though there may be valid candidates later in the raw list"). Extracted as a
// pure, exported, network-free function specifically so the stopping DECISION — keep evaluating
// until the target is hit, the eligible pool is exhausted, or the evaluation budget runs out — is
// directly unit-testable with a fake per-batch evaluator instead of only reachable through a live
// GET request. GET's Stage 2 below is the only real caller; evaluateBatch there does the actual
// OHLCV/CoinGecko/snapshot/DexScreener work as a side effect and reports back how many of its batch
// qualified.
export type CandidateEvaluationConfig = {
  targetResults: number
  maxCandidatesEvaluated: number
  minResultsBeforeStop: number
  batchSize: number
}
export type CandidateEvaluationOutcome = {
  evaluatedCount: number
  qualifiedCount: number
  stoppedReason: 'targetReached' | 'allCandidatesExhausted' | 'budgetExhausted'
}

export async function evaluateCandidatesInBatches(
  rankedIndices: number[],
  config: CandidateEvaluationConfig,
  evaluateBatch: (batchIndices: number[]) => Promise<{ qualifiedInBatch: number }>,
): Promise<CandidateEvaluationOutcome> {
  const pool = rankedIndices.slice(0, config.maxCandidatesEvaluated)
  const evaluationTruncatedByBudget = rankedIndices.length > pool.length

  let evaluatedCount = 0
  let qualifiedCount = 0
  let stoppedReason: CandidateEvaluationOutcome['stoppedReason'] = 'allCandidatesExhausted'

  for (let start = 0; start < pool.length; start += config.batchSize) {
    const batchIndices = pool.slice(start, start + config.batchSize)
    const { qualifiedInBatch } = await evaluateBatch(batchIndices)
    evaluatedCount += batchIndices.length
    qualifiedCount += qualifiedInBatch
    if (qualifiedCount >= config.targetResults) { stoppedReason = 'targetReached'; break }
  }

  if (stoppedReason !== 'targetReached') {
    stoppedReason = (evaluationTruncatedByBudget && qualifiedCount < config.minResultsBeforeStop)
      ? 'budgetExhausted'
      : 'allCandidatesExhausted'
  }

  return { evaluatedCount, qualifiedCount, stoppedReason }
}

// 14-DAY CHANGE, DISCLOSED: GeckoTerminal's /pools list endpoint only returns h24 price change —
// there is no 14d field to read. Faking it from 24h data would violate "do not fake 14-day
// performance," so we fetch real daily OHLCV candles per candidate and compute the actual 14-day
// close-to-close change. This is only ever called for candidates that already cleared the cheap
// cap/liquidity/volume/category filters, keeping the extra network cost bounded to a small set.
const FOURTEEN_DAY_OHLCV_CONCURRENCY_LIMIT = 2
// REQUEST-BUDGET CAP, DISCLOSED (reported live: the total-blackout message persisted across
// refreshes with fourteenDayFailureStatusSample showing every attempt failing, not just some — a
// sign the deployment's shared GeckoTerminal budget is chronically over-subscribed, not just
// bursty). Every stage1-passing candidate previously got its own OHLCV request regardless of how
// many there were; on a busy cycle that alone could exceed GT's free-tier per-minute budget before
// a single request had a chance to succeed. Only the top-N candidates by 24h volume (the strongest,
// most legitimate-looking movers — also the ones most worth spending the scarce OHLCV budget on)
// get a live request; the rest skip straight to the fallback ladder (DexScreener/CoinGecko/
// snapshot), which has its own, separate rate budget.
const FOURTEEN_DAY_OHLCV_BUDGET_CAP = 10

// WRONG-NETWORK FIX, DISCLOSED: this hardcoded `networks/base/` while the caller had already gone
// multi-chain, so every ETH/Robinhood pool address was queried against the BASE network, 404'd,
// returned null, and was then dropped as `missing14dData` — silently yielding ~zero non-Base
// candidates while the response still claimed all requested chains were scanned. Takes the real
// network slug now.
// LOADING-DIAGNOSTICS, DISCLOSED (URGENT: Pump Alerts showing 0 results / Base Radar audit): the
// return type used to collapse every "no 14d change" case — a genuine provider fetch failure
// (timeout/rate-limit/5xx), a real 404, and a pool that is simply too young to have 6 daily
// candles yet — into a single `null`. That made it impossible to tell "the provider is failing"
// (a systemic bug that should surface as a visible error) apart from "this token is 3 days old"
// (expected, honest filtering, not a bug). `reason` lets the caller distinguish them and report
// which one actually happened instead of a silent zero either way.
type FourteenDayChangeResult = { changePct: number | null; reason: 'ok' | 'httpError' | 'tooYoung' | 'malformed' | 'fetchError' | 'skippedBudget'; httpStatus?: number }

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
// 14-DAY WINDOW, DISCLOSED (explicitly requested: change the pump window from 7 to 14 days). This
// is a real window change, not a rename: limit=15 requests up to 15 daily candles (spans up to 14
// days close-to-close), and the young-pool guard now requires at least 13 candles (~12-day span
// minimum) before honestly computing a 14d change — a 6-candle minimum would still be labelling a
// ~5-day move as "14d", which is exactly the kind of fabrication this route exists to prevent.
async function fetchPoolFourteenDayChangeOnce(network: string, poolAddress: string, signal: AbortSignal): Promise<FourteenDayChangeResult & { httpStatus?: number }> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/day?limit=15&currency=usd`,
      { headers: { accept: 'application/json' }, cache: 'no-store', signal },
    )
    if (!res.ok) return { changePct: null, reason: 'httpError', httpStatus: res.status }
    const json = await res.json()
    const list = json?.data?.attributes?.ohlcv_list
    if (!Array.isArray(list)) return { changePct: null, reason: 'malformed' }
    if (list.length < 13) return { changePct: null, reason: 'tooYoung' }
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

// SUSTAINED-RATE-LIMIT FIX, DISCLOSED (reported live: the total-blackout message persisted across
// repeated refreshes even after the 429-aware retry was added). One retry only survives a single
// short burst — it does nothing against a SUSTAINED exhaustion, and this route was structurally
// guaranteed to cause one: every cycle re-fetched OHLCV for every stage1-passing candidate from
// scratch with no cache, and a degraded/failed cycle was itself cached for only 10s (the
// STALE-EMPTY-CACHE fix), so the very next request — from this user's own auto-refresh or any
// other user hitting the route — re-fired the identical full burst 10 seconds later. Across
// multiple concurrent users plus Base Radar sharing the same deployment-wide GeckoTerminal budget,
// that reburst-every-10s pattern never let the rate limit recover, which is indistinguishable from
// "the provider is down" from inside a single request even though the provider itself is fine.
// A pool's 14-day OHLCV history barely changes minute to minute (it's a close-to-close window over
// daily candles), so a successful result is cached for 10 minutes — only FAILURES re-fetch fresh
// every cycle (a failure might succeed on retry; a success would just be recomputing the same
// number). This cuts steady-state request volume by roughly the refresh-cycle-to-cache-TTL ratio
// once the cache is warm, which is what actually lets the rate limit recover.
const FOURTEEN_DAY_CACHE_TTL_MS = 10 * 60 * 1000
const fourteenDayResultCache = new Map<string, { result: FourteenDayChangeResult; cachedAt: number }>()

async function fetchPoolFourteenDayChange(network: string, poolAddress: string, signal: AbortSignal): Promise<FourteenDayChangeResult> {
  const cacheKey = `${network}:${poolAddress.toLowerCase()}`
  const cached = fourteenDayResultCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < FOURTEEN_DAY_CACHE_TTL_MS) return cached.result

  const first = await fetchPoolFourteenDayChangeOnce(network, poolAddress, signal)
  let final: FourteenDayChangeResult = first
  if (first.reason === 'httpError' || first.reason === 'fetchError') {
    // A 429 needs a delay that can actually outlast the rate-limit window; a generic transient
    // failure (5xx, timeout) gets a short delay — mirrors the Base Radar 429-aware retry fix.
    const retryDelayMs = first.httpStatus === 429 ? 1800 + Math.floor(Math.random() * 400) : 400
    await sleep(retryDelayMs)
    if (!signal.aborted) {
      const second = await fetchPoolFourteenDayChangeOnce(network, poolAddress, signal)
      final = { changePct: second.changePct, reason: second.reason, httpStatus: second.httpStatus }
    }
  }
  if (final.reason === 'ok') fourteenDayResultCache.set(cacheKey, { result: final, cachedAt: Date.now() })
  return final
}

function qualityScore(a: PumpAlert): number {
  let s = 0
  const liq = a.liquidityUsd ?? 0
  const vol = a.volume24hUsd ?? 0
  const fdv = a.fdvUsd ?? 0
  const ch7d = a.change14d ?? 0
  s += Math.min(ch7d / 10, 10) // 14d change is the primary ranking signal
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
  // Every candidate reaching categorize() already cleared the low-cap + confirmed-14d-pump gate,
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
  // No network calls yet — only candidates surviving this stage pay the cost of a 14d OHLCV fetch.
  const stage1Passed: Stage1Candidate[] = []
  let rawCount = 0
  // CANDIDATE-FUNNEL ACCURACY FIX, DISCLOSED (reported live: the funnel breakdown showed "passed
  // liquidity/volume: 91" while only 14 candidates were actually evidence-checked — a real
  // discrepancy, not a display quirk). rawCount includes every pool GeckoTerminal returned, but a
  // pool with no resolvable base-token id/address, or a duplicate of one already seen, is skipped
  // BELOW without ever reaching evaluateStage1Candidate — so it never gets an audit row. The
  // funnel counts below were being approximated as rawCount minus every KNOWN exclusion reason,
  // which silently assumed every raw pool reached Stage 1 evaluation. It didn't — GeckoTerminal's
  // pool list routinely contains stale/malformed/duplicate entries. Tracking the real skip count
  // here means the funnel breakdown adds up to what actually happened, not an inflated estimate.
  let skippedBeforeStage1 = 0

  for (const { chain, pools, included } of chainPools) {
  for (const pool of pools) {
    rawCount += 1
    const tokenId = pool.relationships?.base_token?.data?.id
    if (!tokenId) { skippedBeforeStage1 += 1; continue }
    // Resolved against THIS chain's included set only — never a shared cross-chain one.
    const meta = included.find(i => i.id === tokenId)
    if (!meta?.attributes?.address) { skippedBeforeStage1 += 1; continue }

    const addr = meta.attributes.address.toLowerCase()
    // Dedupe identity is chain-scoped: the same contract address on two chains is two candidates.
    const dedupeKey = `${chain}:${addr}`
    if (seen.has(dedupeKey)) { skippedBeforeStage1 += 1; continue }
    seen.add(dedupeKey)

    const attrs = pool.attributes
    const change24h = parseNum(attrs?.price_change_percentage?.h24)
    // LIVE MOMENTUM MODE, DISCLOSED: h6/h1 come from the SAME GeckoTerminal pools-list response
    // already being fetched for h24 — no extra request, no extra provider dependency.
    const change6h = parseNum(attrs?.price_change_percentage?.h6)
    const change1h = parseNum(attrs?.price_change_percentage?.h1)
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
      price, change24h, change6h, change1h, volume, liquidity, fdv, marketCap, ageDays,
    }, requestId)
    if (!result.passed) {
      audit.push(result.audit)
      continue
    }
    stage1Passed.push(result.candidate)
  }
  }

  // ─── Stage 2: resolve pump evidence via the multi-source ladder ─────────────────────────────
  // PUMP-14D-EVIDENCE-LADDER, DISCLOSED (urgent fix: one GeckoTerminal OHLCV outage zeroed the whole
  // feed). Priority: GT OHLCV exact → CoinGecko per-contract exact → ChainLens snapshot history →
  // DexScreener-corroborated momentum fallback. Exact sources produce a real change14d number;
  // the momentum fallback NEVER fabricates one — it qualifies on corroborated 24h evidence and is
  // labelled as such end-to-end.
  const evidenceAudit: Pump14dEvidenceAudit = {
    requestId,
    candidatesRaw: rawCount,
    geckoOhlcvAttempted: 0, geckoOhlcvSucceeded: 0, geckoOhlcvFailed: 0, geckoOhlcvSkippedBudget: 0,
    dexScreenerFallbackAttempted: 0, dexScreenerFallbackSucceeded: 0,
    coinGeckoFallbackAttempted: 0, coinGeckoFallbackSucceeded: 0,
    internalSnapshotFallbackAttempted: 0, internalSnapshotFallbackSucceeded: 0,
    exact14dQualified: 0, fallbackMomentumQualified: 0,
    excludedMissingAllMomentumEvidence: 0,
    finalRenderedCount: 0,
    degradedMode: false,
    degradedReason: null,
  }

  const allScored: PumpAlert[] = []

  // Timeout widened from 12s to 18s to give the 429-aware retry (up to ~2.2s per candidate, on top
  // of the request itself) room to actually complete instead of getting cut off mid-retry — see the
  // ONE-RETRY 429-AWARE FIX disclosure on fetchPoolFourteenDayChange. Shared across every batch
  // below since batches run sequentially within the same request — once it fires, every in-flight
  // and future OHLCV fetch fails fast instead of the request running past its time budget.
  const ac14d = new AbortController()
  const tid14d = setTimeout(() => ac14d.abort(), 18_000)
  // Timeout widened from 8s to 14s for the same reason — the DexScreener momentum fallback now
  // retries once on a 429, and this window covers CoinGecko + snapshot + DexScreener attempts
  // sequentially per candidate.
  const acFb = new AbortController()
  const tidFb = setTimeout(() => acFb.abort(), 14_000)

  // Rank ALL stage1-passing candidates by 24h volume once — both the OHLCV sub-budget and the
  // overall evaluation-depth cap spend their effort on the strongest, most legitimate-looking
  // movers first.
  const rankedStage1Indices = stage1Passed
    .map((_, i) => i)
    .sort((a, b) => (stage1Passed[b].volume ?? 0) - (stage1Passed[a].volume ?? 0))
  const evaluationPool = rankedStage1Indices.slice(0, PUMP_ALERT_MAX_CANDIDATES_EVALUATED)
  // Only the strongest FOURTEEN_DAY_OHLCV_BUDGET_CAP candidates in the pool get a live OHLCV
  // request — GeckoTerminal's rate budget is scarcer than DexScreener/CoinGecko/snapshot, so it's
  // reserved for the strongest movers; everyone else in the pool still gets the full fallback ladder.
  const ohlcvBudgetEligible = new Set(evaluationPool.slice(0, FOURTEEN_DAY_OHLCV_BUDGET_CAP))

  let fourteenDayAttemptedCount = 0
  let fourteenDayProviderFailureCount = 0
  const fourteenDayFailureStatusSample: number[] = []

  // LIVE MOMENTUM MODE, DISCLOSED: verdicts keyed by stage1Passed index, computed synchronously
  // per-batch (see the batch evaluator below) and consulted whenever exact evidence doesn't
  // resolve — this is the tracking that lets a candidate qualify on live momentum even when every
  // exact-evidence provider fails for the whole cycle.
  const liveMomentumVerdicts = new Map<number, LiveMomentumVerdict & { qualified: true }>()
  const liveMomentumAudit = { liveMomentumAttempted: 0, liveMomentumQualified: 0 }

  // CANDIDATE-EVALUATION-DEPTH FIX, DISCLOSED (reported live: candidatesRaw=20 but every evidence
  // tier only ever attempted 3 — the whole feed went dark once those 3 failed). This was NOT an
  // early-stop bug: Stage 1 already evaluates every raw candidate, so a stage1Passed count of 3
  // was a genuine "few eligible candidates existed this cycle" fact. The real gap was that nothing
  // kept trying past whatever Stage 1 happened to pass, and the response had no way to distinguish
  // "we tried everything eligible and truly found nothing" from "there was more we didn't get to."
  // evaluateCandidatesInBatches (defined above, exported and independently unit-tested) drives the
  // stop/continue decision; this closure supplies the real per-batch OHLCV/fallback work as a side
  // effect and reports back how many of its batch actually qualified.
  const EVAL_BATCH_SIZE = FOURTEEN_DAY_OHLCV_CONCURRENCY_LIMIT * 3
  let outcome: CandidateEvaluationOutcome = { evaluatedCount: 0, qualifiedCount: 0, stoppedReason: 'allCandidatesExhausted' }
  try {
    outcome = await evaluateCandidatesInBatches(
      rankedStage1Indices,
      {
        targetResults: PUMP_ALERT_TARGET_RESULTS,
        maxCandidatesEvaluated: PUMP_ALERT_MAX_CANDIDATES_EVALUATED,
        minResultsBeforeStop: PUMP_ALERT_MIN_RESULTS_BEFORE_STOP,
        batchSize: EVAL_BATCH_SIZE,
      },
      async (batchIndices): Promise<{ qualifiedInBatch: number }> => {
        // LIVE MOMENTUM MODE, DISCLOSED: computed synchronously for every candidate in the batch —
        // zero network calls, sourced entirely from Stage 1's GeckoTerminal pool data — BEFORE any
        // exact-evidence fetch is attempted. This guarantees a candidate with real live momentum can
        // still qualify even if every exact-evidence provider is unreachable this cycle.
        batchIndices.forEach(idx => {
          const c = stage1Passed[idx]
          liveMomentumAudit.liveMomentumAttempted += 1
          const verdict = evaluateLiveMomentum(c)
          if (verdict.qualified) liveMomentumVerdicts.set(idx, verdict)
        })

        const batch14dResults = await mapWithConcurrencyLimit(batchIndices, FOURTEEN_DAY_OHLCV_CONCURRENCY_LIMIT, async idx => {
          const c = stage1Passed[idx]
          // Exact-tier network calls are reserved for candidates the exact-mode ceiling actually
          // allows — a candidate only fitting under the wider live-momentum ceiling can never use
          // exact evidence anyway (see the dual-ceiling model on Stage1Candidate), so skipping it
          // here both saves budget and keeps the grading correct.
          if (!c.qualifiesForExactCap) { evidenceAudit.geckoOhlcvSkippedBudget += 1; return { changePct: null, reason: 'skippedBudget' as const } }
          if (!c.poolAddr) { evidenceAudit.geckoOhlcvFailed += 1; return { changePct: null, reason: 'malformed' as const } }
          if (!ohlcvBudgetEligible.has(idx)) { evidenceAudit.geckoOhlcvSkippedBudget += 1; return { changePct: null, reason: 'skippedBudget' as const } }
          evidenceAudit.geckoOhlcvAttempted += 1
          fourteenDayAttemptedCount += 1
          // Queried against the candidate's OWN chain network — see fetchPoolFourteenDayChange's disclosure.
          const r = await fetchPoolFourteenDayChange(CHAIN_CONFIG[c.chain].gtNetwork, c.poolAddr, ac14d.signal)
          if (r.changePct != null) evidenceAudit.geckoOhlcvSucceeded += 1
          else evidenceAudit.geckoOhlcvFailed += 1
          if (r.reason === 'httpError' || r.reason === 'fetchError') fourteenDayProviderFailureCount += 1
          if (r.httpStatus != null && fourteenDayFailureStatusSample.length < 8) fourteenDayFailureStatusSample.push(r.httpStatus)
          return r
        })

        const batchResolved = await mapWithConcurrencyLimit(batchIndices, 4, async (idx, j): Promise<ResolvedEvidence> => {
          const c = stage1Passed[idx]
          const liveMomentumFallback: ResolvedEvidence = liveMomentumVerdicts.has(idx)
            ? { kind: 'live_momentum', verdict: liveMomentumVerdicts.get(idx)! }
            : { kind: 'none' }

          if (!c.qualifiesForExactCap) return liveMomentumFallback

          const gtChange = batch14dResults[j]?.changePct ?? null
          if (gtChange != null) return { kind: 'exact', source: 'geckoterminal_ohlcv' as const, change14d: gtChange }

          // Exact tier 2: CoinGecko per-contract real 14d percentage (Base/Ethereum only — CoinGecko
          // doesn't index Robinhood Chain; that skip is honest, not a failure).
          if (c.chain === 'base' || c.chain === 'eth') {
            evidenceAudit.coinGeckoFallbackAttempted += 1
            const cgChange = await fetchCoinGeckoContractChange14d(c.chain, c.addr, acFb.signal)
            if (cgChange != null) {
              evidenceAudit.coinGeckoFallbackSucceeded += 1
              return { kind: 'exact', source: 'coingecko_contract', change14d: cgChange }
            }
          }

          // Exact tier 3: ChainLens-owned snapshot history (real measured window ≥12 days apart).
          evidenceAudit.internalSnapshotFallbackAttempted += 1
          const snap = await computeSnapshotChange14d(c.chain, c.addr)
          if (snap.changePct != null) {
            evidenceAudit.internalSnapshotFallbackSucceeded += 1
            return { kind: 'exact', source: 'internal_snapshot', change14d: snap.changePct }
          }

          // No exact evidence resolved — fall back to whatever live-momentum verdict was already
          // computed synchronously above, never leaving a real live mover unqualified just because
          // every exact-evidence provider failed.
          evidenceAudit.excludedMissingAllMomentumEvidence += liveMomentumFallback.kind === 'none' ? 1 : 0
          return liveMomentumFallback
        })

        let qualifiedInBatch = 0
        batchIndices.forEach((idx, j) => {
          const c = stage1Passed[idx]
          const result = evaluateStage2Candidate(c, null, requestId, batchResolved[j])
          audit.push(result.audit)
          if (result.included) {
            allScored.push(result.alert)
            qualifiedInBatch += 1
            if (result.alert.evidenceGrade === 'exact') evidenceAudit.exact14dQualified += 1
            else { evidenceAudit.fallbackMomentumQualified += 1; liveMomentumAudit.liveMomentumQualified += 1 }
          }
        })
        return { qualifiedInBatch }
      },
    )

    // Degraded mode = the primary OHLCV source failed across the board but fallbacks still
    // produced candidates. Surfaced so the UI can say exactly what happened instead of a bare 0.
    const ohlcvTotalFailure = evidenceAudit.geckoOhlcvAttempted > 0 && evidenceAudit.geckoOhlcvSucceeded === 0
    if (ohlcvTotalFailure) {
      evidenceAudit.degradedMode = true
      evidenceAudit.degradedReason = evidenceAudit.exact14dQualified + evidenceAudit.fallbackMomentumQualified > 0
        ? 'GeckoTerminal OHLCV failed this cycle — candidates qualified via fallback evidence.'
        : 'GeckoTerminal OHLCV requests failed for every candidate this cycle, and no fallback provider could confirm momentum either.'
    }
  } finally {
    clearTimeout(tid14d)
    clearTimeout(tidFb)
  }
  const candidatesEvaluated = outcome.evaluatedCount
  const stoppedReason = outcome.stoppedReason

  // SYSTEMIC-14D-FAILURE DETECTION (kept from origin/main): if every real 14d attempt failed with
  // httpError/fetchError (never tooYoung/malformed/skippedBudget), the provider itself is down or
  // rate-limiting. The ladder's degradedMode above is the broader superset — it also fires when
  // OHLCV returned data for nobody AND fallbacks had to take over.
  const fourteenDayDataUnavailable = fourteenDayAttemptedCount > 0 && fourteenDayProviderFailureCount === fourteenDayAttemptedCount

  // SNAPSHOT RECORDING, DISCLOSED: every refresh persists each Stage-1-passing candidate's price/
  // liquidity/volume so future cycles gain ChainLens-owned history — over time this becomes an
  // independent exact-14d source that no external provider outage can take down. Best-effort;
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
    return qd !== 0 ? qd : (b.change14d ?? 0) - (a.change14d ?? 0)
  })

  const { alerts, freshCount, staleCount, fallbackUsed } = applyRotationAndDiversity(allScored)

  evidenceAudit.finalRenderedCount = alerts.length
  if (evidenceAudit.degradedMode && alerts.length === 0 && evidenceAudit.degradedReason == null) {
    evidenceAudit.degradedReason = 'No candidate cleared the pump gate this cycle.'
  }

  const countReason = (reason: string) => audit.filter(a => a.exclusionReason === reason).length

  // TRUTHFUL, SPECIFIC EMPTY-STATE FIX, DISCLOSED (URGENT fix request): finalState previously
  // collapsed every empty-result cause — no eligible candidates, a truncated evaluation budget, and
  // a genuinely exhausted evaluation that found nothing — into the same 'fourteenDayUnavailable' or
  // 'allFilteredOut' label, which is exactly what produced the misleading "14d data unavailable"
  // message reported live for a cycle where only 3 of 20 raw candidates were ever eligible for
  // evidence checks in the first place. Each of the 5 states below names ONE real, distinguishable
  // outcome so the frontend never has to guess which kind of empty this is:
  // - noEligibleLowCapCandidates: nothing survived category/cap/liquidity/volume filtering at all
  // - providerBudgetExhausted: the evaluation-depth cap cut off evidence checks before the eligible
  //   pool was exhausted, and too few candidates had qualified yet to call it a clean result
  // - allCandidatesExhaustedNoMomentum: every eligible candidate really was checked through the full
  //   evidence ladder, and none qualified — a true, complete "nothing pumped this cycle"
  // - providerDegradedPartial: candidates DID render, but only because the primary OHLCV tier failed
  //   broadly and fallback evidence carried the cycle — still a real result, just worth flagging
  // - finalRendered: a clean, non-degraded successful cycle
  const finalState: 'providerUnavailable' | 'noRawCandidates' | 'noEligibleLowCapCandidates'
    | 'providerBudgetExhausted' | 'allCandidatesExhaustedNoMomentum' | 'providerDegradedPartial' | 'finalRendered' =
    chainsSucceeded.length === 0 ? 'providerUnavailable'
    : rawCount === 0 ? 'noRawCandidates'
    : stage1Passed.length === 0 ? 'noEligibleLowCapCandidates'
    : alerts.length > 0 ? (evidenceAudit.degradedMode ? 'providerDegradedPartial' : 'finalRendered')
    : stoppedReason === 'budgetExhausted' ? 'providerBudgetExhausted'
    : 'allCandidatesExhaustedNoMomentum'

  // PER-TOKEN CANDIDATE-FUNNEL AUDIT, DISCLOSED: exact shape requested — answers "why is this empty"
  // (or "why is this small") from the response itself, at every stage of the pipeline, not just the
  // evidence-ladder tiers. CANDIDATE-FUNNEL ACCURACY FIX (reported live: this showed "passed
  // liquidity/volume: 91" while only 14 candidates were ever evidence-checked — a real math bug,
  // not a display quirk): candidatesReachingStage1 excludes pools skipped before evaluateStage1Candidate
  // ever ran (no resolvable token id/address, or a cross-chain dedupe hit) so the funnel below adds
  // up to stage1Passed.length exactly, not an inflated estimate assuming every raw pool was evaluated.
  const candidatesReachingStage1 = rawCount - skippedBeforeStage1
  const categoryFilteredCount = countReason('establishedOrCategoryBlocked')
  const capDataMissingCount = countReason('capDataMissing')
  const capExceedsCount = countReason('capExceedsLowCapCeiling')
  const liquidityBelowCount = countReason('liquidityBelowMinimum')
  const volumeBelowCount = countReason('volumeBelowMinimum')
  const lowCapCandidatesCount = Math.max(0, candidatesReachingStage1 - categoryFilteredCount - capDataMissingCount - capExceedsCount)
  const liquidityVolumeCandidatesCount = Math.max(0, lowCapCandidatesCount - liquidityBelowCount - volumeBelowCount)
  const pumpCandidateEvaluationAudit = {
    rawCandidates: rawCount,
    categoryFiltered: categoryFilteredCount,
    lowCapCandidates: lowCapCandidatesCount,
    liquidityVolumeCandidates: liquidityVolumeCandidatesCount,
    candidatesEvaluated,
    candidatesSkippedBeforeOhlcv: evidenceAudit.geckoOhlcvSkippedBudget,
    geckoAttempts: evidenceAudit.geckoOhlcvAttempted,
    geckoSuccesses: evidenceAudit.geckoOhlcvSucceeded,
    dexFallbackAttempts: evidenceAudit.dexScreenerFallbackAttempted,
    dexFallbackSuccesses: evidenceAudit.dexScreenerFallbackSucceeded,
    coinGeckoAttempts: evidenceAudit.coinGeckoFallbackAttempted,
    coinGeckoSuccesses: evidenceAudit.coinGeckoFallbackSucceeded,
    internalSnapshotAttempts: evidenceAudit.internalSnapshotFallbackAttempted,
    internalSnapshotSuccesses: evidenceAudit.internalSnapshotFallbackSucceeded,
    qualifiedExact7d: evidenceAudit.exact14dQualified,
    qualifiedMomentumFallback: evidenceAudit.fallbackMomentumQualified,
    rejectedAfterEvidenceCheck: Math.max(0, candidatesEvaluated - evidenceAudit.exact14dQualified - evidenceAudit.fallbackMomentumQualified),
    stoppedReason,
    finalRenderedCount: alerts.length,
  }

  // NEW ELIGIBILITY MODEL AUDIT, DISCLOSED: exact shape requested — the exact-vs-live-momentum
  // funnel this fix introduced, distinct from the older per-provider ladder audit above (kept for
  // callers/tests already relying on it). rejectedNoMomentum counts candidates that reached
  // evidence checking (survived category/low-cap/liquidity/volume) but qualified under NEITHER
  // exact evidence NOR live momentum — the only genuinely "nothing here" outcome in this model.
  const pumpQualificationAudit = {
    rawCandidates: rawCount,
    allowedCategoryCandidates: candidatesReachingStage1 - categoryFilteredCount,
    lowCapCandidates: lowCapCandidatesCount,
    liquidityVolumeCandidates: liquidityVolumeCandidatesCount,
    exactEvidenceAttempted: evidenceAudit.geckoOhlcvAttempted + evidenceAudit.coinGeckoFallbackAttempted + evidenceAudit.internalSnapshotFallbackAttempted,
    exactEvidenceQualified: evidenceAudit.exact14dQualified,
    liveMomentumAttempted: liveMomentumAudit.liveMomentumAttempted,
    liveMomentumQualified: liveMomentumAudit.liveMomentumQualified,
    rejectedMajorStableWrapped: categoryFilteredCount,
    rejectedHighFdv: capExceedsCount,
    rejectedLowLiquidity: liquidityBelowCount,
    rejectedLowVolume: volumeBelowCount,
    rejectedNoMomentum: countReason('rejectedNoMomentum') + countReason('missing14dData'),
    finalRenderedCount: alerts.length,
    finalState,
  }

  // UI-POLISH FIX, DISCLOSED (requested: ensure the API response carries priceChange24hPct/6hPct/
  // 1hPct alongside the existing change24h/change6h/change1h names). Purely additive aliasing over
  // the already-computed alert objects — no discovery/eligibility logic changes, no new fields are
  // computed, nothing here can change which candidates qualify or how they're ranked.
  const alertsWithAliases = alerts.map(a => ({
    ...a,
    priceChange24hPct: a.change24h,
    priceChange6hPct: a.change6h,
    priceChange1hPct: a.change1h,
  }))

  const payload = {
    alerts: alertsWithAliases,
    fetchedAt: new Date().toISOString(),
    requestId,
    chains: chains.map(c => ({ chain: c, chainId: CHAIN_CONFIG[c].chainId, maxFdvUsd: Math.min(PUMP_ALERT_MAX_FDV_USD, CHAIN_CONFIG[c].maxFdvUsd) })),
    // Provider failures are always reported, never silently swallowed — a partial result says
    // exactly which chains are missing rather than presenting itself as a complete scan.
    providerStatus,
    chainsSucceeded,
    chainsFailed,
    // Exposed field is the RECONCILED (post-ladder) blackout flag, not the raw pre-fallback GT-only
    // signal — a rendered card with real evidence must never coexist with this being true. True
    // only when the primary tier failed AND nothing rendered AND no tier — exact or fallback —
    // qualified a single candidate; see finalState === 'allCandidatesExhaustedNoMomentum' /
    // 'providerBudgetExhausted' for the specific, truthful reason it's empty.
    fourteenDayDataUnavailable: fourteenDayDataUnavailable && alerts.length === 0
      && evidenceAudit.exact14dQualified + evidenceAudit.fallbackMomentumQualified === 0,
    // Raw GT-OHLCV-only signal, kept for diagnostics: true whenever the primary exact tier failed
    // for every attempt, independent of whether fallbacks rescued the cycle.
    fourteenDayProviderDegraded: fourteenDayDataUnavailable && alerts.length > 0,
    finalState,
    ...(chainsFailed.length > 0 ? { error: `Provider unavailable for: ${chainsFailed.join(', ')}. Showing ${chainsSucceeded.join(', ')} only.` } : {}),
    diagnostics: process.env.NODE_ENV === 'development' ? { cacheHit: false, providerStatus, rateLimited: false } : undefined,
    pumpDiscoveryEligibilityAudit: audit,
    // 14D-EVIDENCE AUDIT, DISCLOSED: request-level rollup of every ladder tier's attempts/successes
    // so "why is this empty / why is it degraded" is always answerable from the response itself.
    pump14dEvidenceAudit: {
      ...evidenceAudit,
      degradedReason: evidenceAudit.degradedMode && alerts.length === 0
        ? (evidenceAudit.degradedReason ?? 'No fallback evidence qualified any candidate.')
        : evidenceAudit.degradedReason,
    },
    // CANDIDATE-EVALUATION-DEPTH FIX, DISCLOSED: exact shape requested — the full candidate funnel
    // (raw -> category -> low-cap -> liquidity/volume -> evidence-evaluated -> qualified) plus
    // exactly why evaluation stopped, so a small finalRenderedCount is never mistaken for a provider
    // outage when it was actually a small eligible pool, a budget cutoff, or a truly clean zero.
    pumpCandidateEvaluationAudit,
    // ELIGIBILITY-MODEL FIX, DISCLOSED: exact-vs-live-momentum funnel audit, per the fix request.
    pumpQualificationAudit,
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
      rejectedMissing14d: countReason('missing14dData'),
      rejectedBelow14dThreshold: countReason('change14dBelowMinimum'),
      finalCount: alerts.length,
      totalDurationMs: Date.now() - now,
    },
    // Exact shape requested for the URGENT loading audit: every candidate-count stage plus the
    // provider/timing facts needed to tell "over-filtering" apart from "the API is failing" apart
    // from "the cache is stale" without needing a second round-trip to ask.
    pumpAlertsLoadAudit: {
      requestId,
      route: '/api/pump-alerts',
      status: finalState === 'providerUnavailable' ? 503 : 200,
      totalDurationMs: Date.now() - now,
      cacheHit: false,
      providersAttempted: chains.map(c => `geckoterminal:${CHAIN_CONFIG[c].gtNetwork}`),
      providersSucceeded: chainsSucceeded.map(c => `geckoterminal:${CHAIN_CONFIG[c].gtNetwork}`),
      providersFailed: chainsFailed.map(c => `geckoterminal:${CHAIN_CONFIG[c].gtNetwork}`),
      candidatesRaw: rawCount,
      candidatesAfterDedupe: seen.size,
      candidatesAfterCategoryFilter: rawCount - countReason('establishedOrCategoryBlocked'),
      candidatesAfterLowCapFilter: stage1Passed.length + countReason('missing14dData') + countReason('change14dBelowMinimum') + countReason('noCategoryMatch'),
      candidatesAfter14dPumpFilter: allScored.length + countReason('noCategoryMatch'),
      candidatesAfterLiquidityVolumeFilter: rawCount - countReason('establishedOrCategoryBlocked') - countReason('capDataMissing') - countReason('capExceedsLowCapCeiling') - countReason('liquidityBelowMinimum') - countReason('volumeBelowMinimum'),
      candidatesRendered: alerts.length,
      rejectedReasons: {
        establishedOrCategory: countReason('establishedOrCategoryBlocked'),
        capDataMissing: countReason('capDataMissing'),
        highFdv: countReason('capExceedsLowCapCeiling'),
        lowLiquidity: countReason('liquidityBelowMinimum'),
        lowVolume: countReason('volumeBelowMinimum'),
        missing14dData: countReason('missing14dData'),
        below14dThreshold: countReason('change14dBelowMinimum'),
      },
      finalState,
      errorShownToUser: finalState === 'providerUnavailable',
    },
    _debug: {
      rawCount,
      eligibleFor14dCheck: stage1Passed.length,
      scoredCount: allScored.length,
      freshCount,
      staleCount,
      selectedCount: alerts.length,
      fallbackUsed,
      fourteenDayAttempted: fourteenDayAttemptedCount,
      fourteenDayProviderFailures: fourteenDayProviderFailureCount,
      fourteenDayFailureStatusSample,
    },
  }
  // STALE-EMPTY-CACHE FIX, DISCLOSED: a transient empty/degraded cycle (not finalRendered) must
  // never be cached for the full 90s TTL — that would keep serving "no signals" for a minute and a
  // half even after the provider recovers on the very next real fetch. Only a genuinely complete,
  // successful scan is cached at full TTL; anything else gets a short 10s TTL so the next request
  // retries soon instead of being permanently suppressed by its own failure.
  const cacheTtlMs = finalState === 'finalRendered' || finalState === 'providerDegradedPartial' ? PUMP_ROUTE_CACHE_TTL_MS : 10_000
  pumpCache.set(cacheKey, { exp: Date.now() + cacheTtlMs, payload })
  return NextResponse.json(payload)
}

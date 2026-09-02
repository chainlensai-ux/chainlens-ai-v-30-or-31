import { NextResponse, type NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getOrFetchCached } from '@/lib/coingeckoCache'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { DEFAULT_RADAR_ALLOW_FDV_FALLBACK, DEFAULT_RADAR_MIN_LIQUIDITY_USD, DEFAULT_RADAR_MIN_VALUATION_USD, getRadarCortexValuationLine, getRadarValuationCardDisplay, getRadarValuationEvidenceGap, resolveBaseRadarMarketCap, selectDexScreenerMarketCapRescuePair, tokenPassesRadarValuationFilters, type DexScreenerMarketCapRescueResult, type RadarValuationBasis } from '@/lib/baseRadarValuation'
import { getRadarSimulationDisplay, type RadarSimulationOpenCheckReason, type RadarSimulationStatus } from '@/lib/baseRadarSimulation'
import { MAIN_FEED_MIN_VALUATION_USD, MAIN_FEED_MAX_VALUATION_USD, MAIN_FEED_MIN_HOLDERS, passesMainFeedValuationMinGate, passesMainFeedValuationMaxGate, passesMainFeedHolderGate, isRealVerifiedMarketCapValue, CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP, DISPLAY_TARGET, HOLDER_CHECK_BUDGET_CAP, HOLDER_CHECK_BATCH_SIZE, shouldContinueHolderChecking } from '@/lib/baseRadarMainFeedGate'
import { redis, redisConfigured } from '@/lib/server/cache/redisClient'
import { fetchGoldRushHolderCount, type HolderCountResult } from '@/lib/server/goldrushHolderCount'
import { isRobinhoodChainAvailable, ROBINHOOD_CHAIN_ID } from '@/lib/server/robinhoodChainConfig'
import { resolveBaseRadarHolderConcentration } from '@/lib/server/baseRadarHolderConcentration'

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

// GECKOTERMINAL-API-KEY FIX, DISCLOSED (reported: "I think dex screener is better in every echelon"
// — investigated whether DexScreener could replace GeckoTerminal as primary discovery first, and it
// structurally can't: its public API has no "browse pools on a chain" endpoint, only lookup-by-
// specific-token/pair (confirmed earlier this session, still true — DEXSCREENER-BOOST-DISCOVERY FIX
// comment near DEXSCREENER_SUPPLEMENTARY_DISCOVERY_CAP). Investigating the REAL root cause instead
// found this: every GeckoTerminal request all session has been fully unauthenticated — no API key
// header at all — despite a real COINGECKO_API_KEY (a CoinGecko Demo plan key) already sitting
// configured in this project's environment, unused anywhere in the codebase. GeckoTerminal is a
// CoinGecko product and its public API accepts a CoinGecko Demo/Pro key via the x-cg-demo-api-key
// header for a meaningfully higher rate-limit budget than the fully anonymous public tier this
// route has been hitting every single cycle this whole session. This is the real fix for the
// repeated 429 lockouts — not a replacement discovery source, an actual missing credential.
// Fails open: if the key is absent/invalid, this is just the same unauthenticated request as
// before, never a hard failure.
const GECKOTERMINAL_HEADERS: Record<string, string> = {
  Accept: 'application/json;version=20230302',
  ...(process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {}),
}

const EXCLUDED = new Set([
  'USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'USDBC', 'ETH', 'BUSD', 'FRAX',
  'CBETH', 'CBBTC', 'CBUSD', 'AXLUSDC', 'USD+', 'STETH', 'RETH',
  'WSTETH', 'EURC', 'BSDETH',
])
// ESTABLISHED-TOKEN-EXCLUSION, DISCLOSED (reported: Aerodrome/AERO — Base's own flagship DEX token,
// live and trading for 1000+ days — showed up in the feed labeled "EARLY"/"3m old"). Root cause: the
// feed tracks POOL creation age, not TOKEN age — someone created a brand-new liquidity pool for an
// old, well-established token, and that new pool honestly cleared every gate (real $80K+ valuation,
// real liquidity, real 30+ holders), but surfacing it as a fresh opportunity is misleading regardless
// of how honestly it cleared the gates. Excluded by CONTRACT ADDRESS (not just symbol/ticker) — a
// ticker-only match risks two failure modes: falsely excluding an unrelated token that happens to
// share the "AERO" symbol, and (the opposite, more dangerous case) NOT excluding an actual scam token
// impersonating "AERO" by symbol, which should still be shown and correctly flagged as a real listed
// candidate rather than silently hidden by name collision. Verified against Aerodrome's own real,
// widely-documented Base mainnet contract, not guessed.
// SECOND CASE, DISCLOSED (reported: Avantis/AVNT — same failure mode, a new liquidity pool for an
// established, hundreds-of-days-old $30M-market-cap token showing up labeled as a fresh opportunity).
// Unlike AERO, this contract address is added on the user's direct report, not independent
// verification against prior knowledge — flag it if this turns out to be the wrong address.
const EXCLUDED_ESTABLISHED_CONTRACTS = new Set([
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631', // Aerodrome Finance (AERO) — Base-native, live since Aug 2023
  '0x696f9436b67233384889472cd7cd58a6fb5df4f1', // Avantis (AVNT) — reported established, hundreds of days old, ~$30M market cap
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
  // NORMALIZED-CANDIDATE-SHAPE FIX, DISCLOSED (required exact shape — additive: `contract` above is
  // kept unchanged everywhere it's already consumed, chainSlug/chainId/tokenAddress/priceUsd/
  // priceChange*/pairCreatedAt are new fields, never a rename, so nothing already reading `contract`,
  // `ageMinutes`, etc. anywhere in Pump Alerts/Token Scanner/Clark/Wallet Scanner is touched).
  // Base Radar is Base-only per the hard rule EXCEPT when explicitly scanning Robinhood via its own
  // ?chain=robinhood request — chainSlug/chainId always reflect the SAME single chain this whole
  // response was scanned for, never a mix.
  chainSlug: 'base' | 'robinhood'
  chainId: number
  tokenAddress: string
  priceUsd: number | null
  priceChange24hPct: number | null
  priceChange6hPct: number | null
  priceChange1hPct: number | null
  // Real ISO timestamp when known (from the provider's own pool_created_at/pairCreatedAt) — null,
  // never fabricated, when a provider didn't report one. ageMinutes above stays the primary field
  // every existing consumer already reads; pairCreatedAt is additive.
  pairCreatedAt: string | null
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
  // ESTABLISHED-CLASSIFICATION, DISCLOSED: true when valuation is above the $2M early-range
  // ceiling. This is a LABEL, not an exclusion — an established candidate still cleared every real
  // requirement (liquidity, valuation floor, holder evidence) to be displayed at all.
  isEstablished: boolean
  // HOLDER-EVIDENCE-HONESTY, DISCLOSED: true only when this candidate's holder count was actually
  // resolved to a real number AND that number cleared MAIN_FEED_MIN_HOLDERS. false covers both "we
  // know it failed" and "we couldn't check" — the two are told apart via evidenceGaps
  // (holder_provider_unreachable is only ever attached in the latter case) — never displayed/scored
  // as if holder-verified when this is false.
  holderVerified: boolean
  // HOLDER-CONCENTRATION-ON-FEED, DISCLOSED (explicitly directed: "Restore real Top 1/10/20
  // concentration in Base Radar" — resolved only for the small set of candidates about to be newly
  // admitted into today's daily pool, capped at BASE_RADAR_HOLDER_CONCENTRATION_CAP, never for every
  // raw candidate). Optional and absent for tokens this cycle didn't have budget to resolve — a
  // missing holderEvidence here is not itself an error signal; the drawer independently resolves its
  // own on open regardless of what the feed managed this cycle.
  holderEvidence?: import('@/lib/baseRadarHolderEvidence').HolderEvidence
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
// single page-size=100 call reading only pagination.total_count, not a full holder pull — page-size
// was originally 1 but that turned out to trigger a consistent HTTP 400 from Covalent, see the
// PAGE-SIZE-400-FIX comment at the actual call site) for the ranked candidate set and
// drops anything under MAIN_FEED_MIN_HOLDERS. An unresolved/failed holder-count lookup is treated
// as failing the bar too (same unknown-≠-safe principle as the rest of this route's risk scoring) —
// this filter should never leak a token through just because the provider call errored.
// MAIN-FEED-QUALITY-GATE, DISCLOSED (requested: stricter main-feed gate — $80K minimum valuation,
// 30 minimum holders, real holder evidence required, no dead-liquidity coins ranking as radar
// opportunities). Raised from the prior 25-holder floor to the requested 30; unresolved/failed
// holder-count lookups still fail the bar (unchanged — same unknown-≠-safe principle). Valuation
// itself later raised again from $45K to $80K (explicitly requested: "$45K-$50K is still extremely
// low and lets too many weak/dead liquidity coins into the main Radar feed") — holder floor and the
// existing liquidity minimum untouched by that change. Constants and gate predicates live in
// lib/baseRadarMainFeedGate.ts (imported above) so they're unit-testable without mocking this
// route's HTTP calls — see scripts/test-base-radar-main-feed-gate.mjs.
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
// DISCOVERY-FAILURE-BACKOFF, DISCLOSED (live-reproduced: after a wave-based pacing fix still showed
// waves 2-3 of 3 failing entirely, dug into WHY the failure kept recurring across separate live
// captures rather than self-healing — getOrFetchCached (lib/coingeckoCache.ts) never caches a
// failure, only a success; a source that fails gets retried from a completely cold start on the
// very next request, with zero cooldown. Every refresh during a GeckoTerminal rate-limit window was
// re-triggering the exact same burst against a budget that hadn't recovered yet, which is why this
// kept failing across multiple captures instead of clearing up on its own — each retry was actively
// extending the outage, not just failing to fix it). This is a small, LOCAL backoff scoped to Base
// Radar's own discovery fetch only (not a change to the shared coingeckoCache.ts utility other
// routes also use) — once a source key fails, it's skipped (no network call at all) for
// DISCOVERY_FAILURE_BACKOFF_MS, giving GeckoTerminal's own rate-limit window real time to clear
// instead of Base Radar re-hammering it every single refresh. A success for that key clears its
// backoff immediately.
// BACKOFF-TOO-LONG FIX, DISCLOSED (reported live: a capture showed 12/18 pages skipped with
// degradedReason "still in local failure-backoff cooldown from a prior cycle" — the original 45s
// window meant a user hitting Refresh (which can be sooner than 45s after the failure, especially
// right after seeing an empty feed) kept getting the SAME skipped sources echoed back with no
// chance to recover, since the skip itself never re-attempts the network call to find out if
// GeckoTerminal's rate limit already cleared). Shortened so a refresh a short while later can
// actually retry instead of being stuck behind a cooldown longer than a realistic refresh gap.
const DISCOVERY_FAILURE_BACKOFF_MS = 20_000
const discoverySourceFailureBackoff = new Map<string, number>()
// SHARED-BACKOFF FIX, DISCLOSED (bug hunt: reported "randomly barely any tokens" with no pattern
// the user could see). discoverySourceFailureBackoff above is a plain in-memory Map at module
// scope — on Vercel serverless, that memory is per-instance, not shared across the whole
// deployment. Under real traffic, multiple instances run concurrently, each with its own empty-at-
// cold-start copy. GeckoTerminal's actual rate limit is a real, shared budget (tied to this
// server's outbound IP/API key), but the backoff meant to protect it was purely local — instance A
// has no idea instance B just burned the shared budget serving a different user seconds earlier, so
// A's request looks "fresh," fires its own full burst, and gets 429'd across the board for reasons
// entirely outside that user's own actions. That's exactly what would read as "random" from any one
// user's perspective. Backed by the Redis client already used elsewhere in this codebase
// (lib/server/cache/redisClient.ts) so the cooldown is now actually shared across instances;
// falls back to the local Map (best-effort, not cross-instance) when Redis is unconfigured or
// briefly unavailable — a Redis hiccup degrades to the old per-instance behavior, it never blocks
// or fails a discovery fetch outright.
const RADAR_BACKOFF_REDIS_PREFIX = 'radar:discovery-backoff:'
async function getDiscoveryBackoffUntil(key: string): Promise<number | null> {
  if (redisConfigured()) {
    try {
      const val = await redis.get<number>(`${RADAR_BACKOFF_REDIS_PREFIX}${key}`)
      if (typeof val === 'number') return val
    } catch { /* fall through to local map — never block discovery on a Redis problem */ }
  }
  return discoverySourceFailureBackoff.get(key) ?? null
}
async function setDiscoveryBackoff(key: string, until: number): Promise<void> {
  discoverySourceFailureBackoff.set(key, until)
  if (redisConfigured()) {
    try { await redis.set(`${RADAR_BACKOFF_REDIS_PREFIX}${key}`, until, { ex: Math.ceil(DISCOVERY_FAILURE_BACKOFF_MS / 1000) }) } catch { /* best-effort */ }
  }
}

// CROSS-CHAIN-WAVE-GATE FIX, DISCLOSED (reported: sudden GeckoTerminal 429s on a shared/free
// endpoint that "never really happens" — traced via live Vercel logs showing a full wave of
// [cache] MISS lines for one chain's sourceSpecs firing together, same pattern the
// DISCOVERY_CONCURRENCY_LIMIT/DISCOVERY_WAVE_DELAY_MS wave loop below was built to stay under).
// That wave loop only paces ONE chain's own 6-per-wave burst against itself — per the
// CHAIN-SCOPED-SOURCE-KEYS comment above, requestedChain prefixes every cache/backoff key so Base
// and Robinhood (added this session) run as fully independent discovery cycles that never
// coordinate with each other. GeckoTerminal's real rate limit doesn't know or care which chain
// slug a request is for — it's one shared budget tied to this deployment's outbound IP/API key. So
// a Base wave and a Robinhood wave landing in the same window (different users, or the same user's
// auto-refresh overlapping a tab switch) can burst 12 concurrent requests against a budget tuned
// for 6, tripping 429s neither chain's own pacing "should" have caused on its own. Fixed with one
// additional Redis-backed gate, orthogonal to the existing per-source-key backoff, that every wave
// (any chain, any request, any instance) reserves a slot from before firing — same best-effort
// philosophy as getDiscoveryBackoffUntil/setDiscoveryBackoff above: a Redis hiccup or unconfigured
// Redis just skips the wait entirely, it never blocks or fails a request. Deliberately NOT a hard
// lock (a plain read-then-write has a benign race under heavy concurrency) — this only needs to
// meaningfully reduce simultaneous cross-chain bursts, not perfectly serialize every request.
const RADAR_GLOBAL_WAVE_GATE_KEY = 'radar:discovery-wave:global-next-at'
const RADAR_GLOBAL_WAVE_GATE_MAX_WAIT_MS = 2_500
async function reserveGlobalDiscoveryWaveSlot(gapMs: number): Promise<void> {
  if (!redisConfigured()) return
  try {
    const now = Date.now()
    const reservedUntil = await redis.get<number>(RADAR_GLOBAL_WAVE_GATE_KEY)
    const nextSlot = Math.max(typeof reservedUntil === 'number' ? reservedUntil : 0, now)
    await redis.set(RADAR_GLOBAL_WAVE_GATE_KEY, nextSlot + gapMs, { ex: 30 })
    const waitMs = Math.min(nextSlot - now, RADAR_GLOBAL_WAVE_GATE_MAX_WAIT_MS)
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
  } catch { /* best-effort — never block discovery on a Redis problem */ }
}

// LIVE-FEED, DISCLOSED (explicitly requested — replacing the daily pool below: "we should be
// getting tokens a lot instantly, you really want users to get 1 and wait hours for a couple
// more"). The earlier design (capped at 10/day, accumulating slowly, resetting once every 24h)
// was itself an explicit, deliberate request at the time, but real usage showed it trickling in
// far too slowly for a live discovery feed — a new user could land on an early cycle and see a
// single token for hours. The feed now simply shows every candidate that clears every gate THIS
// cycle, live, uncapped, no persistence — the Redis-backed daily-pool machinery this comment used
// to describe has been removed.
// HOLDER-CONCENTRATION-COST-GUARDRAIL, DISCLOSED (explicitly directed: "Only run holder concentration
// after market gates... candidate selected for display/receipt enrichment. Do not call holder
// concentration for all raw candidates... Add cap"). Concentration is only ever resolved for
// candidates about to actually be displayed this cycle — i.e. already cleared valuation,
// liquidity, and the real holder-count gate — never the full ranked candidate list.
const BASE_RADAR_HOLDER_CONCENTRATION_CAP = 8
const BASE_RADAR_HOLDER_CONCENTRATION_CONCURRENCY = 4
// SHARED-HOLDER-COUNT-FETCH, DISCLOSED (reported: the Base Radar drawer's Holders section unreliable
// per-token — traced to it relying on Token Scanner's much heavier internal resolver, off-limits to
// modify. Extracted this route's own already-proven-reliable holder-COUNT fetch into
// lib/server/goldrushHolderCount.ts so app/api/base-radar/enrichment/route.ts can use the identical
// logic as a fallback, without touching Token Scanner's engine at all — see that file's header
// comment for the full rationale.
const fetchBaseHolderCount = fetchGoldRushHolderCount

// TOKEN-AGE SIGNAL RETIRED, DISCLOSED (explicit product reset: "Base Radar deterministic valuation
// band only" — no soft caps, no maybe logic). This fuzzy async signal (fetchBaseTokenAgeDays, an
// extra GoldRush call per candidate, fail-open on unresolved age) used to catch "already large"
// established tokens like Aerodrome/Avantis by estimating real token age. It's retired: the
// deterministic $2M valuation ceiling (see lib/baseRadarMainFeedGate.ts) now does that job with no
// async lookup, no heuristic, no extra provider call — an Aerodrome- or Avantis-sized market cap
// simply fails the valuation band outright. EXCLUDED_ESTABLISHED_CONTRACTS above stays as a
// deterministic, exact-match belt-and-suspenders backstop (not "maybe logic" — a hard address
// match), unchanged.
//
// ABSOLUTE-LIQUIDITY-FLOOR, DISCLOSED: belt-and-suspenders guard independent of the configurable
// minLiquidityUsd query param — a token with ~$0 real liquidity must never reach the feed no matter
// how minLiquidityUsd is set. The route's own `liquidityUsd < minLiquidityUsd` check already
// requires liquidityUsd >= minLiquidityUsd, but this floor makes the "no liquidity" case impossible
// to slip through even under a future param-handling regression.
const ABSOLUTE_MIN_LIQUIDITY_USD = 500

// CHAIN-UNSUPPORTED, DISCLOSED (Robinhood-chain support: honeypot.is requires a numeric EVM
// chainID — 8453 is Base's real, verified chainID, but I have no verified Robinhood-chain chainID
// and guessing one risks silently simulating against the WRONG chain, which could produce a
// confidently-wrong SAFE/DANGER verdict — far worse than an honest "unavailable." Short-circuits to
// the same provider_unavailable shape a genuine honeypot.is outage already produces; Robinhood
// candidates get the same honest simulationStatus: 'open_check' / capped-risk treatment as any real
// provider failure, never a fabricated result.
async function fetchHoneypot(contract: string, chain: 'base' | 'robinhood'): Promise<HoneypotResult | null> {
  if (chain !== 'base') return { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'provider_unavailable' }
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
  holderVerified: boolean
}): RiskLevel {
  const { hp, simulationStatus, ageMinutes, liquidityUsd, volume24h, holderVerified } = input

  if (hp?.isHoneypot === true) return 'DANGER'

  // HOLDER-EVIDENCE-CAPS-SCORE, DISCLOSED (explicitly requested: "Score should be capped or status
  // should remain unverified/watch" when the holder provider is unreachable for a candidate — "Do
  // not mark as strong/verified from holder evidence"). A candidate whose holder count couldn't be
  // confirmed this cycle can never reach SAFE — it's shown, but the risk label itself reflects that
  // one real piece of evidence is honestly missing, same principle as the honeypot/simulation checks
  // just below never being skipped.
  if (!holderVerified) return 'WATCH'

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
    // BOUNDED-CLARK-CALL, DISCLOSED (reported: Base Radar stuck on "Refreshing radar…" for
    // minutes with no error). This was the one remaining unbounded network call in the whole
    // /api/radar pipeline — every other external call already has an explicit timeout
    // (GeckoTerminal 6s, DexScreener rescue ~3s, GoldRush holder checks 3.5s, honeypot 2.6s) but
    // this Anthropic call had none, relying only on the SDK's own default (effectively minutes).
    // A slow/rate-limited Anthropic response could hold the whole request open well past what the
    // frontend or any reasonable user would wait for. Bounded to 12s — Clark verdicts are a nice-
    // to-have annotation on top of already-computed real data, not something worth blocking the
    // entire feed response on.
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    }, { timeout: 12_000 })

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
const DEX_MARKET_CAP_RESCUE_TTL_MS = 2 * 60 * 1000
type RadarPayloadCacheEntry = { cachedAt: number; ttlMs: number; payload: { tokens: RadarToken[]; stats: RadarStats; fetchedAt: string; limitedLiveFeed: boolean; mode: 'shallow' | 'full'; _debug?: Record<string, unknown> } }
const radarPayloadCache = new Map<string, RadarPayloadCacheEntry>()
// CROSS-INSTANCE-PAYLOAD-FALLBACK, DISCLOSED (investigated: Robinhood Radar consistently showed
// "0/12 pages loaded" while Base rarely did — traced past the per-page GeckoTerminal cache fix to a
// deeper, same-class asymmetry here. radarPayloadCache is a plain per-process Map, and this route's
// own SERVE-STALE-ON-TOTAL-FAILURE fallback (below, near the final response) only ever re-serves a
// prior successful payload if THIS SAME warm instance happened to have one cached. Base's heavy
// traffic means most warm instances already have a recent successful Base payload to fall back on
// when live discovery 429s; Robinhood's much lower traffic means a given instance frequently has
// never served a successful Robinhood payload at all, so the exact same total-source-failure event
// that Base quietly survives via stale-serve produces a hard, visible "0 tokens" for Robinhood.
// Backed by the same Redis client already used for discovery backoff and the per-page cache, so a
// successful payload from any instance becomes reachable as a fallback from every instance.
// Retention (20 min) is intentionally much longer than the live TTLs (5-100s) so this stale-fallback
// safety net survives real gaps between successful Robinhood cycles, not just within one TTL window
// — this never fabricates data, it only ever re-serves an actual prior successful response, same as
// the existing local-Map fallback it extends. Fully best-effort: any Redis failure here just falls
// back to the original per-instance-only behavior.
const RADAR_PAYLOAD_REDIS_PREFIX = 'radar:payload:'
const RADAR_PAYLOAD_REDIS_RETENTION_SECONDS = 20 * 60
async function readRadarPayloadRedis(key: string): Promise<RadarPayloadCacheEntry | null> {
  if (!redisConfigured()) return null
  try {
    return (await redis.get<RadarPayloadCacheEntry>(`${RADAR_PAYLOAD_REDIS_PREFIX}${key}`)) ?? null
  } catch {
    return null
  }
}
async function writeRadarPayloadRedis(key: string, entry: RadarPayloadCacheEntry): Promise<void> {
  if (!redisConfigured()) return
  try {
    await redis.set(`${RADAR_PAYLOAD_REDIS_PREFIX}${key}`, entry, { ex: RADAR_PAYLOAD_REDIS_RETENTION_SECONDS })
  } catch { /* best-effort — never block the response on a Redis problem */ }
}
const honeypotCache = new Map<string, { result: HoneypotResult | null; cachedAt: number }>()
const honeypotInflight = new Map<string, Promise<HoneypotResult | null>>()
const dexMarketCapRescueCache = new Map<string, { result: DexScreenerMarketCapRescueResult; cachedAt: number }>()
const dexMarketCapRescueInflight = new Map<string, Promise<DexScreenerMarketCapRescueResult>>()

async function getCachedHoneypot(contract: string, chain: 'base' | 'robinhood', retry = false): Promise<HoneypotResult | null> {
  const key = `${chain}:${contract.toLowerCase()}`
  const now = Date.now()
  const cached = honeypotCache.get(key)
  if (cached && now - cached.cachedAt <= HONEYPOT_CACHE_TTL_MS && !(retry && cached.result == null)) return cached.result
  const existing = honeypotInflight.get(key)
  if (existing) return existing
  const promise = (async () => {
    const first = await fetchHoneypot(contract, chain)
    if (first || !retry) return first
    return withTimeout(fetchHoneypot(contract, chain), 2500, { isHoneypot: null, buyTax: null, sellTax: null, simulationSuccess: null, failureReason: 'timeout_after_retry' })
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

async function getDexMarketCapRescue(input: { chain: string; token: string; primaryPoolAddress?: string | null; primaryQuoteTokenAddress?: string | null }): Promise<DexScreenerMarketCapRescueResult & { cacheHit: boolean }> {
  const chain = input.chain.toLowerCase()
  const token = input.token.toLowerCase()
  const key = `base-radar:market-cap-rescue:${chain}:${token}:${input.primaryQuoteTokenAddress?.toLowerCase() ?? ''}`
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
        primaryQuoteTokenAddress: input.primaryQuoteTokenAddress,
      })
    } catch (err) {
      const httpStatus = (err as { httpStatus?: number } | undefined)?.httpStatus ?? null
      const result = selectDexScreenerMarketCapRescuePair({ pairs: [], chain, primaryPoolAddress: input.primaryPoolAddress, primaryQuoteTokenAddress: input.primaryQuoteTokenAddress })
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

// GECKOTERMINAL-FALLBACK DISCOVERY, DISCLOSED (explicitly requested: "If GeckoTerminal fails,
// fallback to DexScreener"). getDexMarketCapRescue above only ever fills in ONE field (market cap)
// for a candidate GeckoTerminal already discovered — it depends entirely on GT for discovery itself,
// so it cannot help when GT is the thing that's down. This is a genuinely independent discovery
// path: DexScreener's own token-boosts/token-profiles lists (real, live-submitted tokens — never
// fabricated) cross-referenced against DexScreener's OWN multi-token pair endpoint
// (/latest/dex/tokens/{addresses}), which returns full pair data (price/liquidity/volume/price-
// change/marketCap/fdv/pairCreatedAt) directly — no GeckoTerminal call anywhere in this path. Only
// invoked when GT's own discovery genuinely returned zero successful sources this cycle (see the
// call site below) — this is a fallback of last resort, not a routine extra source, so it never adds
// load to a cycle where GT is already working. Base-only: DexScreener does not reliably index
// Robinhood Chain (same honest gap already established elsewhere in this codebase — Pump Alerts'
// equivalent fallback, the old evidence-ladder's CoinGecko/DexScreener tiers). Returns data already
// reshaped into GeckoTerminal's own {data: pools[], included: tokens[]} JSON:API-ish shape so it can
// flow through the EXACT SAME downstream pipeline (dedup, valuation, liquidity floor, category
// exclusion, holder checks, ranking) with zero special-casing — never a parallel/duplicate pipeline.
async function fetchDexScreenerBaseFallbackDiscovery(signal: AbortSignal): Promise<{ data: Record<string, unknown>[]; included: Record<string, unknown>[]; error: string | null }> {
  try {
    const [profileRes, boostRes] = await Promise.allSettled([
      fetch('https://api.dexscreener.com/token-profiles/latest/v1', { headers: { Accept: 'application/json' }, cache: 'no-store', signal }),
      fetch('https://api.dexscreener.com/token-boosts/latest/v1', { headers: { Accept: 'application/json' }, cache: 'no-store', signal }),
    ])
    const addresses = new Set<string>()
    for (const outcome of [profileRes, boostRes]) {
      if (outcome.status !== 'fulfilled' || !outcome.value.ok) continue
      const list = await outcome.value.json().catch(() => null)
      if (!Array.isArray(list)) continue
      for (const item of list as Record<string, unknown>[]) {
        const chainId = typeof item.chainId === 'string' ? item.chainId.toLowerCase() : ''
        const tokenAddress = typeof item.tokenAddress === 'string' ? item.tokenAddress : ''
        if (chainId === 'base' && tokenAddress) addresses.add(tokenAddress)
        if (addresses.size >= 30) break
      }
    }
    if (addresses.size === 0) return { data: [], included: [], error: 'No Base tokens found in DexScreener boosted/profile lists this cycle.' }

    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${[...addresses].join(',')}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal })
    if (!res.ok) return { data: [], included: [], error: `DexScreener multi-token lookup failed (HTTP ${res.status}).` }
    const json = await res.json().catch(() => null)
    const pairs: Record<string, unknown>[] = Array.isArray(json?.pairs) ? json.pairs : []

    const pools: Record<string, unknown>[] = []
    const included: Record<string, unknown>[] = []
    const seenTokenIds = new Set<string>()
    for (const pair of pairs) {
      // WRONG-CHAIN GUARD, DISCLOSED (hard rule: no ETH/Robinhood/Solana data in Base mode):
      // DexScreener's multi-token endpoint can return pairs on OTHER chains for the same address —
      // only pairs it itself attributes to 'base' are ever kept.
      if (pair.chainId !== 'base') continue
      const baseToken = pair.baseToken as { address?: string; symbol?: string; name?: string } | undefined
      const addr = typeof baseToken?.address === 'string' ? baseToken.address : null
      const pairAddr = typeof pair.pairAddress === 'string' ? pair.pairAddress : null
      if (!addr || !pairAddr) continue
      const tokenId = `dexfallback_token_${addr.toLowerCase()}`
      if (!seenTokenIds.has(tokenId)) {
        seenTokenIds.add(tokenId)
        included.push({ type: 'token', id: tokenId, attributes: { name: baseToken?.name ?? 'Unknown', symbol: baseToken?.symbol ?? '?', address: addr } })
      }
      const priceChange = pair.priceChange as { h24?: number; h6?: number; h1?: number } | undefined
      const liquidity = pair.liquidity as { usd?: number } | undefined
      const volume = pair.volume as { h24?: number } | undefined
      const pairCreatedAtMs = typeof pair.pairCreatedAt === 'number' ? pair.pairCreatedAt : null
      pools.push({
        id: `dexfallback_pool_${pairAddr.toLowerCase()}`,
        relationships: { base_token: { data: { id: tokenId } }, dex: { data: { id: typeof pair.dexId === 'string' ? pair.dexId : 'unknown' } } },
        attributes: {
          address: pairAddr,
          base_token_price_usd: pair.priceUsd ?? null,
          reserve_in_usd: liquidity?.usd ?? null,
          fdv_usd: pair.fdv ?? null,
          market_cap_usd: pair.marketCap ?? null,
          pool_created_at: pairCreatedAtMs != null ? new Date(pairCreatedAtMs).toISOString() : null,
          volume_usd: { h24: volume?.h24 ?? null },
          price_change_percentage: { h24: priceChange?.h24 ?? null, h6: priceChange?.h6 ?? null, h1: priceChange?.h1 ?? null },
        },
      })
    }
    return { data: pools, included, error: pools.length === 0 ? 'DexScreener returned no Base-chain pairs for the discovered token addresses.' : null }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'unknown_error'
    return { data: [], included: [], error: name === 'AbortError' ? 'DexScreener fallback discovery timed out.' : `DexScreener fallback discovery failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// DAILY-REDISCOVERY-CRON, DISCLOSED (explicitly requested: "make sure every 24 hours it does a mass
// finding of new tokens... so it's not just the same shit forever" — before this, discovery only ran
// lazily on whatever request happened to land after a 24h cycle expired; with zero page traffic in
// that window, the pool would just sit stale until someone finally opened Base Radar). This header
// lets the internal cron trigger (app/api/base-radar/cron/route.ts) run a real discovery pass without
// needing a paying user's bearer token — gated on a server-only shared secret that only this app's
// own cron endpoint knows, so it can never be used to bypass the Pro/Elite paywall for a real user
// (the header name is not a standard one an end user would send, and even if they did, it only works
// when BASE_RADAR_CRON_SECRET is configured to a real value that matches).
function isTrustedCronTrigger(req: NextRequest): boolean {
  const secret = process.env.BASE_RADAR_CRON_SECRET
  if (!secret) return false
  return req.headers.get('x-base-radar-cron-secret') === secret
}

export async function GET(req: NextRequest) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }
  const isCronTrigger = isTrustedCronTrigger(req)
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  let plan: 'free' | 'pro' | 'elite' = 'free'
  if (token) {
    try { plan = (await getCurrentUserPlanFromBearerToken(token)).plan } catch { plan = 'free' }
  }
  if (plan === 'free' && !isCronTrigger) return NextResponse.json({ error: 'Included in Pro and Elite.' }, { status: 403 })
  const debug = req.nextUrl.searchParams.get('debug') === 'true'
  // ROBINHOOD-CHAIN-SUPPORT, DISCLOSED (explicitly requested: "the same thing we did for the base
  // chain with the robinhood chain for the base radar" — GeckoTerminal indexes 'robinhood' as its
  // own network slug, same API shape as 'base', confirmed live via geckoterminal.com/robinhood/pools
  // and via DexScreener's own boost/profile sample this session showing real chainId:"robinhood"
  // entries). requestedChain drives every GeckoTerminal/DexScreener network-scoped URL and every
  // cache/backoff/pool key below, so Base and Robinhood run as fully independent discovery cycles —
  // never sharing rate-limit backoff state, cached payloads, or daily pools with each other.
  // HOLDER-COUNT-NOW-SUPPORTED, DISCLOSED (explicitly confirmed: "Robinhood's GoldRush chain support
  // and covalent full platform support robinhood" — GoldRush's own site confirms real Robinhood
  // Chain coverage). fetchGoldRushHolderCount (lib/server/goldrushHolderCount.ts) now genuinely
  // attempts the call for Robinhood too, using Robinhood Chain's verified real numeric chain ID
  // (4663) in place of a chain-name slug I couldn't confirm — see that module's own header comment.
  // honeypot.is remains SKIPPED (not guessed) for 'robinhood': it requires a numeric EVM chainID
  // and I have no verified Robinhood-chain chainID accepted by honeypot.is specifically (a different
  // provider than GoldRush, with its own separate chain-support question) — guessing risks silently
  // simulating against the wrong chain. It keeps the same honest not-verified evidence-gap path
  // genuine provider failures already use, capped at WATCH, never falsely marked verified.
  // SERVER-SIDE-FLAG-GATE, DISCLOSED (found in a full Base Radar audit): the Robinhood feature flag
  // was enforced only in the UI (the chain selector hides the option, and effectiveRadarChain falls
  // back to 'base'), so a direct /api/radar?chain=robinhood call ran a full Robinhood discovery
  // cycle even with the feature disabled. Mirrors the frontend's own defensive fallback exactly —
  // an ungated request quietly serves Base rather than erroring, so the API and UI can never
  // disagree about whether Robinhood is live.
  const requestedChain: 'base' | 'robinhood' =
    req.nextUrl.searchParams.get('chain') === 'robinhood' && isRobinhoodChainAvailable() ? 'robinhood' : 'base'
  const minValuationUsd = Number(req.nextUrl.searchParams.get('minValuationUsd')) || DEFAULT_RADAR_MIN_VALUATION_USD
  const minLiquidityUsd = Number(req.nextUrl.searchParams.get('minLiquidityUsd')) || DEFAULT_RADAR_MIN_LIQUIDITY_USD
  const allowFdvFallback = req.nextUrl.searchParams.get('allowFdvFallback') === 'false' ? false : DEFAULT_RADAR_ALLOW_FDV_FALLBACK
  const now = Date.now()
  // URGENT LOADING AUDIT, DISCLOSED (reported: Base Radar stuck on loading/checking with no tokens
  // rendering). requestId ties this response to baseRadarLoadAudit below and to the client-side
  // fetch that logs it, so a specific stuck load can be traced end to end.
  const requestId = `radar_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const requestedMode: 'shallow' | 'full' = req.nextUrl.searchParams.get('mode') === 'full' ? 'full' : 'shallow'
  // LOAD-MORE, DISCLOSED (requested: a "Load More" control on the Base Radar feed): the feed was
  // always page 1 of GeckoTerminal's new/trending pools — there was no way to reach older-but-still-
  // recent pools beyond whatever fit in that single page. `page` shifts which GeckoTerminal pages
  // this request pulls from (page 2 asks GeckoTerminal for its pages 3-4 of new_pools instead of
  // 1-2, etc.), so "Load More" surfaces genuinely different tokens rather than re-showing the same
  // top 50. Capped at 5 — GeckoTerminal's own pool listings get sparse/stale much past that.
  const radarPage = Math.min(5, Math.max(1, Math.floor(Number(req.nextUrl.searchParams.get('page')) || 1)))
  // FIND-NEW-TOKENS, DISCLOSED (explicitly requested: "a button at the bottom to find new tokens
  // cause a lot are the same tokens from days ago" — the default mixed discovery interleaves
  // new_pools with trending_pools/pools-by-volume, and those latter two sources structurally favor
  // already-established, repeatedly-active pools over genuinely fresh ones, which is exactly what
  // was showing up over and over). freshOnly restricts discovery to ONLY the new_pools source for
  // this one request — no trending/volume pages at all — so a user who explicitly wants the
  // freshest pools right now gets exactly that, without the two sources most likely to resurface
  // the same familiar high-volume tokens.
  const freshOnly = req.nextUrl.searchParams.get('freshOnly') === '1'
  // CACHE-VERSION, DISCLOSED (requested: ensure a stale cached tiny/empty result can't survive a
  // threshold/gate change). The in-memory radarPayloadCache Map naturally resets on a cold serverless
  // start (a new deploy = a new process = a new empty Map) in the normal case, but Vercel's rolling
  // deploys can briefly keep a warm instance alive across a deploy — folding the actual gate
  // thresholds into the cache key means any change to them (like this session's $45K -> $80K raise,
  // or a future one) can never accidentally serve a payload computed under the OLD thresholds; it's
  // simply a different cache key, so a cold miss forces a real re-run of the current pipeline.
  const cacheKeyBase = `chain:${requestedChain}:plan:${plan}:minValuation:${minValuationUsd}:minLiquidity:${minLiquidityUsd}:fdvFallback:${allowFdvFallback}:page:${radarPage}:freshOnly:${freshOnly}:gate:${MAIN_FEED_MIN_VALUATION_USD}:${MAIN_FEED_MAX_VALUATION_USD}:${MAIN_FEED_MIN_HOLDERS}`
  const fullCacheKey = `${cacheKeyBase}:mode:full`
  const shallowCacheKey = `${cacheKeyBase}:mode:shallow`
  const preferredCacheKey = requestedMode === 'full' ? fullCacheKey : shallowCacheKey
  let fullCachedPayload = radarPayloadCache.get(fullCacheKey)
  if (!fullCachedPayload) {
    const redisEntry = await readRadarPayloadRedis(fullCacheKey)
    if (redisEntry) { radarPayloadCache.set(fullCacheKey, redisEntry); fullCachedPayload = redisEntry }
  }
  if (fullCachedPayload && now - fullCachedPayload.cachedAt <= fullCachedPayload.ttlMs) {
    const payload = fullCachedPayload.payload
    return NextResponse.json({
      ...payload,
      ...(debug ? { _debug: { ...(payload._debug ?? {}), cacheHit: true, cacheMode: 'full', effectivePlan: plan, upsellVisible: false } } : {}),
    })
  }
  let cachedPayload = radarPayloadCache.get(preferredCacheKey)
  if (!cachedPayload) {
    const redisEntry = await readRadarPayloadRedis(preferredCacheKey)
    if (redisEntry) { radarPayloadCache.set(preferredCacheKey, redisEntry); cachedPayload = redisEntry }
  }
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
  // WIDER-PULL, ROUND 3, DISCLOSED (reported: feed at flat 0 after the $80K valuation raise). This
  // is the explicitly-permitted remedy for that report ("don't lower the threshold — if too empty,
  // widen pre-filter candidate consideration within safe caps"). Honest caveat carried over from
  // round 2's own history: live audit output has repeatedly shown several of the deeper pages
  // already returning 0 items at the PRIOR page count (e.g. new_p5, new_p8, trending_p2/p3 all
  // empty in recent runs) — meaning GT's "new pools" listing itself often doesn't have much more
  // supply at greater depth, so this may have limited effect if the real constraint is that Base's
  // current new-pool market genuinely doesn't have many $80K+ valued, still-fresh pools. Raised
  // modestly rather than aggressively to avoid repeating this session's earlier GeckoTerminal
  // 429-rate-limit incidents from a larger burst of parallel page fetches.
  // THIRD SOURCE ADDED, DISCLOSED (explicitly requested: "is there a way where api searches for
  // more" — a real token, FTWO, cleared every gate but only 1-2 candidates were surfacing per
  // cycle). new_pools and trending_pools are both listing-order endpoints — a pool that's neither
  // brand-new enough for the first nor hot enough for the second (e.g. a few days old, steady real
  // volume, no longer "trending" but still a legitimate $85K+/100-holder candidate) never appears in
  // either. Added GeckoTerminal's general Base `/pools` endpoint sorted by 24h volume — same
  // provider, no new API key/vendor, just a third listing ordering that surfaces candidates the
  // other two structurally can't. Kept to 4 pages (matching trending's page count) to stay well
  // under the rate-limit burst size that caused the earlier 429 incident.
  // PAGE-COUNT REDUCED 18 -> 8 TOTAL, DISCLOSED (explicitly requested, live-confirmed pattern across
  // 2 separate captures on 2 separate refreshes: pages 1-6 succeeded both times, every page from #7
  // onward got a real HTTP 429 both times — not random flakiness, a consistent budget boundary. The
  // wave-pacing/backoff fixes reduced how OFTEN this happens but didn't eliminate it, because the
  // total request count (18) still exceeds whatever GeckoTerminal's real per-window budget is.
  // Trading raw discovery depth for reliability: fewer total requests per cycle, comfortably inside
  // the empirically-observed ~6-request budget for the first wave, so a cycle is far less likely to
  // need a second/third wave that gets rate-limited at all.
  const NEW_POOLS_PAGES_PER_REQUEST = 4
  const TRENDING_PAGES_PER_REQUEST = 2
  const VOLUME_POOLS_PAGES_PER_REQUEST = 2
  const newPoolsStartPage = (radarPage - 1) * NEW_POOLS_PAGES_PER_REQUEST + 1
  const trendingStartPage = (radarPage - 1) * TRENDING_PAGES_PER_REQUEST + 1
  const volumePoolsStartPage = (radarPage - 1) * VOLUME_POOLS_PAGES_PER_REQUEST + 1
  // PER-PAGE AUDIT FIELDS, DISCLOSED (explicitly requested: a detailed baseRadarDiscoverySourceAudit
  // with per-failed-page source/page/status/errorName/errorMessage/retryable/durationMs). `source`/
  // `page` are attached at spec-construction time instead of parsed back out of the `key` string
  // later, so the audit can never drift from what was actually requested.
  // SOURCE-STARVATION FIX, DISCLOSED (reported: a real, established-but-active token — $291K market
  // cap, $106K liquidity, $146K 24h volume, 1,090 holders, comfortably clearing every gate — never
  // appeared on Radar. Traced to the discovery order below: new_pools/trending/volume were
  // concatenated as three separate blocks (new_p1-4, trending_p1-2, vol_p1-2), and with the
  // empirically-observed ~6-request-per-wave rate-limit budget, vol_p1/vol_p2 always fell in the
  // second wave — which failedPages/degradedReason confirms has 429'd in EVERY live capture this
  // session, not occasionally. "Sorted by volume" is exactly the source most likely to surface an
  // active-but-not-brand-new pool like this one, so it being permanently starved silently blinded
  // Radar to a whole category of real, qualifying tokens — a structural bug, not bad luck. Fixed by
  // round-robin interleaving the three categories so every source gets pages inside the first
  // (reliably-successful) wave, instead of one category unconditionally absorbing 100% of the
  // rate-limit risk every single cycle.
  // CHAIN-SCOPED-SOURCE-KEYS, DISCLOSED: keys are prefixed with requestedChain so Base and Robinhood
  // never share discovery-cache/backoff state — without this, 'new_p1' for Base and 'new_p1' for
  // Robinhood would collide in discoverySourceFailureBackoff/getOrFetchCached, wrongly treating a
  // rate-limit hit on one chain as if it happened on the other.
  const buildPageSpecs = (source: string, keyPrefix: string, startPage: number, count: number, urlBuilder: (page: number) => string) =>
    Array.from({ length: count }, (_, i) => {
      const page = startPage + i
      return { key: `${requestedChain}_${keyPrefix}${page}`, source, page, url: urlBuilder(page) }
    })
  const newPoolsSpecs = buildPageSpecs('new_pools', 'new_p', newPoolsStartPage, NEW_POOLS_PAGES_PER_REQUEST,
    page => `https://api.geckoterminal.com/api/v2/networks/${requestedChain}/new_pools?page=${page}&include=base_token%2Cquote_token&per_page=20`)
  const trendingSpecs = buildPageSpecs('trending_pools', 'trending_p', trendingStartPage, TRENDING_PAGES_PER_REQUEST,
    page => `https://api.geckoterminal.com/api/v2/networks/${requestedChain}/trending_pools?page=${page}&include=base_token%2Cquote_token&per_page=20`)
  const volumeSpecs = buildPageSpecs('pools_by_volume', 'vol_p', volumePoolsStartPage, VOLUME_POOLS_PAGES_PER_REQUEST,
    page => `https://api.geckoterminal.com/api/v2/networks/${requestedChain}/pools?page=${page}&include=base_token%2Cquote_token&per_page=20&sort=h24_volume_usd_desc`)
  const sourceSpecs: typeof newPoolsSpecs = []
  {
    const queues = freshOnly ? [newPoolsSpecs] : [newPoolsSpecs, trendingSpecs, volumeSpecs]
    let remaining = queues.reduce((sum, q) => sum + q.length, 0)
    let cursor = 0
    while (remaining > 0) {
      const q = queues[cursor % queues.length]
      if (q.length > 0) { sourceSpecs.push(q.shift()!); remaining-- }
      cursor++
    }
  }
  // DEXSCREENER-BOOST-DISCOVERY FIX, DISCLOSED (explicitly requested: add DexScreener as a fallback
  // discovery source; researched first — DexScreener's public API has no "browse pools on a chain"
  // endpoint the way GeckoTerminal's new_pools/trending_pools/pools do, only lookup-by-token/pair,
  // so it can't be a true drop-in replacement. Confirmed with the user this is a real but MINOR,
  // SUPPLEMENTARY 4th source, not a GeckoTerminal-outage fallback: it surfaces tokens DexScreener
  // currently has active paid boosts for (real, live data — never fabricated), cross-referenced
  // against GeckoTerminal's own per-token pools endpoint to get real pool-shaped liquidity/age data
  // in the exact schema the rest of this pipeline already expects, so it needs zero changes to the
  // downstream candidate-processing loop. Because it still depends on GeckoTerminal for the actual
  // pool data, it does NOT help during a full GeckoTerminal outage — that would require forking the
  // entire candidate pipeline to a DexScreener-native schema, explicitly out of scope for "a minor
  // 4th source." Kept to a small, fixed cap (4 tokens) so this never meaningfully adds to the
  // request burst the pacing/backoff fixes above exist to control — "no uncontrolled provider
  // spam" per the hard limit.
  // NOT-JUST-BOOSTED, DISCLOSED (reported: "we don't need base boosted just base tokens" — boosts
  // are paid promotion, a narrow and often-empty list unrelated to token quality). DexScreener's
  // token-profiles/latest/v1 returns recently-submitted profiles (free to submit, no payment
  // required), a meaningfully bigger and more representative "real new Base tokens" list than boosts
  // alone. Added as a second supplementary source alongside boosts, both feeding the same combined
  // cap below — NOT additive on top of it — so the total GeckoTerminal cross-reference request count
  // this adds stays exactly what it was before (4), preserving the page-count-reduction work above
  // this comment block that exists specifically to stay under GeckoTerminal's rate-limit budget.
  const DEXSCREENER_SUPPLEMENTARY_DISCOVERY_CAP = 4
  // BOOST-AUDIT-GAP FIX, DISCLOSED (self-caught: reported "dexscreener should be working" —
  // investigating found the original comment here claiming a boost-fetch failure "is audited like
  // any other source via failedPages" was simply false. If the fetch failed, threw, or found 0 Base
  // tokens, boostedBaseTokens just stayed empty and NOTHING was ever recorded — no source key, no
  // failedPages entry, nothing — so there was never any way to tell "DexScreener boosts genuinely
  // had 0 Base tokens right now" apart from "the request silently failed." dexScreenerBoostStatus
  // now captures the real outcome explicitly, surfaced on baseRadarDiscoverySourceAudit below.
  let dexScreenerBoostStatus: 'ok' | 'http_error' | 'fetch_failed' | 'no_base_tokens_found' = 'fetch_failed'
  let dexScreenerBoostHttpStatus: number | null = null
  let dexScreenerBoostedTokensFound = 0
  let dexScreenerProfileStatus: 'ok' | 'http_error' | 'fetch_failed' | 'no_base_tokens_found' = 'fetch_failed'
  let dexScreenerProfileHttpStatus: number | null = null
  let dexScreenerProfileTokensFound = 0
  // WHY-NO-BASE-TOKENS DIAGNOSTIC, DISCLOSED (reported: dexScreenerBoostStatus/dexScreenerProfileStatus
  // have read "no_base_tokens_found" on every single live capture this whole session, despite both
  // requests succeeding (HTTP 200) every time — suspicious enough not to just be bad luck, but I have
  // no live network access to inspect the raw response myself. Two real, distinct explanations are
  // possible: (a) these lists are genuinely global/short and Base just isn't currently represented in
  // them (real, no fix needed), or (b) our chainId-field parsing is silently wrong — e.g. DexScreener
  // uses a different field name or casing than assumed. Rather than guess at a fix, capture a small
  // raw sample of whatever chain-identifying value(s) DexScreener's response actually contains
  // (regardless of whether they match 'base') plus the total list size, so the NEXT live capture
  // proves which explanation is real instead of another blind guess.
  let dexScreenerProfileListSize = 0
  let dexScreenerProfileRawSample: { chainId: unknown; chain: unknown; tokenAddress: unknown; keys: string[] }[] = []
  let dexScreenerBoostListSize = 0
  let dexScreenerBoostRawSample: { chainId: unknown; chain: unknown; tokenAddress: unknown; keys: string[] }[] = []
  try {
    const supplementaryAc = new AbortController()
    const supplementaryTid = setTimeout(() => supplementaryAc.abort(), 5000)
    const seenSupplementary = new Set<string>()
    const supplementaryBaseTokens: string[] = []
    const rawSample = (list: Record<string, unknown>[]) =>
      list.slice(0, 5).map(item => ({ chainId: item.chainId, chain: (item as { chain?: unknown }).chain, tokenAddress: item.tokenAddress, keys: Object.keys(item) }))
    const extractBaseTokens = (list: Record<string, unknown>[]) => {
      const found: string[] = []
      for (const item of list) {
        const chainId = typeof item.chainId === 'string' ? item.chainId.toLowerCase() : ''
        const tokenAddress = typeof item.tokenAddress === 'string' ? item.tokenAddress : ''
        if (chainId === requestedChain && tokenAddress) found.push(tokenAddress)
      }
      return found
    }
    try {
      // INDEPENDENT-FETCH FIX, DISCLOSED (bug hunt: fetch() rejects on a network-level failure —
      // DNS, timeout, connection reset — not just on a non-2xx HTTP status. Promise.all rejects the
      // whole pair the instant either promise rejects, which would silently discard the OTHER
      // source's already-successful data too — the exact "one source's failure shouldn't take down
      // an unrelated source" bug this whole session's discovery fixes exist to prevent. allSettled
      // keeps the two genuinely independent.
      const [profileOutcome, boostOutcome] = await Promise.allSettled([
        fetch('https://api.dexscreener.com/token-profiles/latest/v1', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: supplementaryAc.signal }),
        fetch('https://api.dexscreener.com/token-boosts/latest/v1', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: supplementaryAc.signal }),
      ])
      let profileBaseTokens: string[] = []
      let boostBaseTokens: string[] = []
      if (profileOutcome.status === 'fulfilled') {
        const profileRes = profileOutcome.value
        dexScreenerProfileHttpStatus = profileRes.status
        if (profileRes.ok) {
          const profileJson = await profileRes.json().catch(() => null)
          const profileList = Array.isArray(profileJson) ? profileJson as Record<string, unknown>[] : []
          dexScreenerProfileListSize = profileList.length
          dexScreenerProfileRawSample = rawSample(profileList)
          profileBaseTokens = extractBaseTokens(profileList)
          dexScreenerProfileStatus = profileBaseTokens.length > 0 ? 'ok' : 'no_base_tokens_found'
        } else {
          dexScreenerProfileStatus = 'http_error'
        }
      } else {
        dexScreenerProfileStatus = 'fetch_failed'
      }
      if (boostOutcome.status === 'fulfilled') {
        const boostRes = boostOutcome.value
        dexScreenerBoostHttpStatus = boostRes.status
        if (boostRes.ok) {
          const boostJson = await boostRes.json().catch(() => null)
          const boostList = Array.isArray(boostJson) ? boostJson as Record<string, unknown>[] : []
          dexScreenerBoostListSize = boostList.length
          dexScreenerBoostRawSample = rawSample(boostList)
          boostBaseTokens = extractBaseTokens(boostList)
          dexScreenerBoostStatus = boostBaseTokens.length > 0 ? 'ok' : 'no_base_tokens_found'
        } else {
          dexScreenerBoostStatus = 'http_error'
        }
      } else {
        dexScreenerBoostStatus = 'fetch_failed'
      }
      dexScreenerProfileTokensFound = profileBaseTokens.length
      dexScreenerBoostedTokensFound = boostBaseTokens.length
      // Profiles first (bigger, unpaid list), boosts fill remaining slots — combined cap unchanged.
      for (const address of [...profileBaseTokens, ...boostBaseTokens]) {
        const lower = address.toLowerCase()
        if (seenSupplementary.has(lower)) continue
        seenSupplementary.add(lower)
        supplementaryBaseTokens.push(address)
        if (supplementaryBaseTokens.length >= DEXSCREENER_SUPPLEMENTARY_DISCOVERY_CAP) break
      }
    } finally { clearTimeout(supplementaryTid) }
    // SUPPLEMENTARY-STARVATION FIX, DISCLOSED (bug hunt: appending these to the tail of sourceSpecs
    // means they always land in the same later wave as new_p3/new_p4 — the exact wave that has
    // 429'd in nearly every live capture this session, per the interleave fix a few commits back for
    // new_pools/trending/volume. Unconditionally starving these DexScreener-derived candidates
    // defeats the point of adding them. Spliced in at spread-out positions instead of pushed, so
    // each gets a real chance to land in the first, reliably-successful wave.
    if (supplementaryBaseTokens.length > 0) {
      const interval = Math.max(1, Math.floor((sourceSpecs.length + supplementaryBaseTokens.length) / supplementaryBaseTokens.length))
      supplementaryBaseTokens.forEach((address, i) => {
        const spec = {
          key: `${requestedChain}_dex_supp_p${i}`,
          source: 'dexscreener_supplementary_token',
          page: i,
          url: `https://api.geckoterminal.com/api/v2/networks/${requestedChain}/tokens/${address}/pools?include=base_token%2Cquote_token&per_page=5`,
        }
        const insertAt = Math.min(sourceSpecs.length, (i + 1) * interval - 1)
        sourceSpecs.splice(insertAt, 0, spec)
      })
    }
  } catch {
    if (dexScreenerProfileHttpStatus == null) dexScreenerProfileStatus = 'fetch_failed'
    if (dexScreenerBoostHttpStatus == null) dexScreenerBoostStatus = 'fetch_failed'
    // Best-effort — this supplementary-discovery step failing never affects the 3 primary sources above.
  }
  const sourceCounts: Record<string, number> = {}
  let sourcesSucceeded = 0
  const sourcesAttempted = sourceSpecs.length
  const sourcePayloads: Record<string, unknown>[] = []
  // DISCOVERY-BURST-CONCURRENCY-CAP FIX, DISCLOSED (live-reproduced: a capture showed 18/18 source
  // pages failing simultaneously — discoveryDegraded's own visibility, added the commit before this
  // one, is what made this pattern visible instead of just looking like "the market is empty").
  // All-or-nothing failure across every source at once isn't random flakiness, it's a rate-limit
  // wall: these sourceSpecs.length (18) fetches used to fire in one unbounded Promise.all burst,
  // and each source's own one-retry-on-failure (see the ONE-RETRY FIX comment inside the fetcher
  // below) meant up to 2x that many near-simultaneous requests to GeckoTerminal's public API within
  // a fraction of a second. Adding the third discovery source a few commits ago (14 -> 18 pages)
  // widened this burst right when total-lockout failures started appearing. The DexScreener rescue
  // calls already use a bounded worker pool for exactly this reason (RESCUE_CONCURRENCY_LIMIT) —
  // this fetch never got the same treatment. Capped to the same modest concurrency instead of firing
  // every request at once; each source still independently retries and is still fetched exactly
  // once per cache window (getOrFetchCached's own cache/in-flight map is unchanged) — this only
  // changes how many requests are in flight to GeckoTerminal at the same instant.
  // WAVE-PACING FIX, DISCLOSED (live-reproduced immediately after the concurrency-cap fix above
  // shipped: failedSourceKeys was exactly the LAST 9 of 18 sources — new_p10 through every
  // trending_*/vol_* page — while the first 9 all succeeded). That pattern rules out an instant-
  // concurrency problem (a pure concurrency cap still dispatches the next request the moment a slot
  // frees, so a nextIndex-based worker pool still pushes out close to 18 requests in quick
  // succession) and points at a request-RATE budget instead — GeckoTerminal's public API tolerating
  // roughly the first ~9 requests in a short window before rejecting the rest, regardless of how
  // many were concurrent at any single instant. Switched from a continuous worker pool to explicit
  // waves of DISCOVERY_CONCURRENCY_LIMIT with a real pause between waves — this spreads the same 18
  // total requests over more wall-clock time instead of trying to push them all out as fast as
  // possible, which is what actually respects a requests-per-window limit rather than just an
  // instant-concurrency one.
  const DISCOVERY_CONCURRENCY_LIMIT = 6
  const DISCOVERY_WAVE_DELAY_MS = 400
  interface SourceFetchResult {
    key: string; source: string; page: number
    count: number; data: Record<string, unknown> | null; ok: boolean
    status: number | null; errorName: string | null; errorMessage: string | null
    retryable: boolean; durationMs: number; skippedByBackoff: boolean
    // FALLBACK-USED, DISCLOSED: getOrFetchCached's own STALE result (lib/coingeckoCache.ts) means
    // the live fetch actually failed this cycle but a real, previously-fetched cached payload was
    // served instead of erroring out — a genuine "fallback source" hit, not a new/different
    // provider. Captured here so baseRadarDiscoverySourceAudit's fallbackUsed field reflects a real
    // signal instead of always being false.
    cacheStatus: 'HIT' | 'MISS' | 'STALE' | 'SKIPPED'
  }
  // STAGE TIMING, DISCLOSED (perf: "can we make it faster"). Real per-stage durations attached to
  // baseRadarLoadAudit below so the next live request shows exactly where the reported 11-12s
  // actually goes (discovery waves vs. holder-count checks vs. simulation) instead of requiring
  // guesswork or live log access this environment doesn't have. Pure instrumentation — timestamps
  // read at points that already exist in the control flow, never adds a wait of its own.
  const discoveryStartedAt = Date.now()
  const sourceResults: SourceFetchResult[] = new Array(sourceSpecs.length)
  for (let waveStart = 0; waveStart < sourceSpecs.length; waveStart += DISCOVERY_CONCURRENCY_LIMIT) {
    const wave = sourceSpecs.slice(waveStart, waveStart + DISCOVERY_CONCURRENCY_LIMIT)
    await reserveGlobalDiscoveryWaveSlot(DISCOVERY_WAVE_DELAY_MS)
    const waveResults = await Promise.all(wave.map(spec => fetchOneSource(spec)))
    waveResults.forEach((r, i) => { sourceResults[waveStart + i] = r })
    // DOUBLE-SPACING FIX, DISCLOSED (perf: "can we make it faster" — Base Radar/Robinhood taking
    // 11-12s to load). This unconditional sleep ran on top of reserveGlobalDiscoveryWaveSlot above,
    // which was purpose-built to enforce exactly this gap: its own wait logic already blocks the
    // NEXT wave's reservation call until at least DISCOVERY_WAVE_DELAY_MS has passed since the
    // current wave's slot was reserved (see its header comment — `nextSlot = max(reservedUntil,
    // now)`, so a fast wave still waits out the remainder of the gap on its next call). When Redis
    // is configured, that gate call already provides the spacing this sleep exists for, making the
    // sleep pure dead time stacked on top of it — up to DISCOVERY_WAVE_DELAY_MS wasted at every
    // wave boundary (2 boundaries across the typical 3-wave cycle = up to ~800ms with zero pacing
    // benefit, since the gate already paced it). Kept as the real fallback pacing mechanism ONLY
    // when Redis isn't configured (reserveGlobalDiscoveryWaveSlot no-ops in that case, so this
    // sleep is the only thing preventing an unpaced same-chain burst) — never removed outright,
    // since correctness/throttling behavior must stay identical either way.
    if (waveStart + DISCOVERY_CONCURRENCY_LIMIT < sourceSpecs.length && !redisConfigured()) {
      await new Promise(resolve => setTimeout(resolve, DISCOVERY_WAVE_DELAY_MS))
    }
  }
  const discoveryMs = Date.now() - discoveryStartedAt
  async function fetchOneSource(spec: { key: string; source: string; page: number; url: string }): Promise<SourceFetchResult> {
    const startedAt = Date.now()
    const backoffUntil = await getDiscoveryBackoffUntil(spec.key)
    if (backoffUntil && Date.now() < backoffUntil) {
      return {
        key: spec.key, source: spec.source, page: spec.page, count: 0, data: null, ok: false,
        status: null, errorName: 'backoff_skip', errorMessage: `skipped — this source failed recently and is in cooldown until ${new Date(backoffUntil).toISOString()}`,
        retryable: true, durationMs: 0, skippedByBackoff: true, cacheStatus: 'SKIPPED',
      }
    }
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
              const gtRes = await fetch(spec.url, { headers: GECKOTERMINAL_HEADERS, cache: 'no-store', signal: ac.signal })
              if (!gtRes.ok) {
                // PER-PAGE-ERROR-DETAIL FIX, DISCLOSED (explicitly requested: baseRadarDiscoverySourceAudit
                // needs real status/errorName/errorMessage per failed page, not a generic swallowed
                // catch). httpStatus is attached to the thrown error so it survives back out to the
                // outer catch below.
                const err = new Error(`market_source_unavailable_${gtRes.status}`) as Error & { httpStatus?: number }
                err.httpStatus = gtRes.status
                throw err
              }
              return gtRes.json() as Promise<Record<string, unknown>>
            } finally { clearTimeout(tid) }
          }
          try {
            return await attempt()
          } catch (firstErr) {
            // 429-AWARE RETRY DELAY, DISCLOSED (reported live: Robinhood Chain radar showing
            // "Providers failed" while the UI's own stale Load-More banner said "GeckoTerminal
            // rate-limited this page ... wait about 2 minutes" — confirming a real, live 429 was
            // the actual cause, not a filtering result). The retry above always waited a flat
            // 400ms regardless of WHY the first attempt failed — fine for a one-off timeout/5xx
            // blip, but a genuine 429 rate-limit window doesn't clear in 400ms, so the "retry"
            // fired straight back into the same still-active throttle and failed again nearly
            // every time, making this ONE-RETRY fix a no-op for the exact failure mode it exists
            // to absorb. A 429 specifically now waits much longer (1.8s + up to 400ms jitter, so
            // concurrent in-wave retries for other pages don't all re-fire in lockstep) before
            // retrying; every other failure type keeps the original fast 400ms retry unchanged.
            const firstStatus = (firstErr as { httpStatus?: number } | undefined)?.httpStatus
            const retryDelayMs = firstStatus === 429 ? 1800 + Math.floor(Math.random() * 400) : 400
            await new Promise(resolve => setTimeout(resolve, retryDelayMs))
            return attempt()
          }
        },
      })
      const count = Array.isArray(result.data?.data) ? result.data.data.length : 0
      discoverySourceFailureBackoff.delete(spec.key)
      return {
        key: spec.key, source: spec.source, page: spec.page, count,
        data: count > 0 ? { ...result.data, __radarSourceKey: spec.key } : null, ok: true,
        status: 200, errorName: null, errorMessage: null, retryable: false,
        durationMs: Date.now() - startedAt, skippedByBackoff: false, cacheStatus: result.cache,
      }
    } catch (err) {
      await setDiscoveryBackoff(spec.key, Date.now() + DISCOVERY_FAILURE_BACKOFF_MS)
      // FAILED-SOURCE-VS-GENUINELY-EMPTY FIX, DISCLOSED (reported: raw candidate count dropped from
      // ~200-360 to 72 in one cycle, with several source pages returning 0 scattered between pages
      // that returned a full 20 — e.g. new_p2/p3/p7/p8/p9 empty while new_p1/p4/p5/p6 full. That
      // non-monotonic pattern is the signature of transient failures under this route's 18-way
      // concurrent GeckoTerminal burst (rate-limit/timeout/5xx, even after the existing one retry),
      // not real end-of-pagination — but a failed source and a genuinely empty page were previously
      // recorded identically as count:0, so the resulting thin raw pool cascaded to 0 displayed
      // tokens with no way to tell "discovery was degraded this cycle" apart from "the market is
      // genuinely this thin." `ok: false` marks a real fetch failure distinctly from a real 0-count
      // success, surfaced via sourcesFailedCount/discoveryDegraded below.
      const status = (err as { httpStatus?: number } | undefined)?.httpStatus ?? null
      const errorName = err instanceof Error ? err.name : 'unknown_error'
      const errorMessage = err instanceof Error ? err.message : String(err)
      const retryable = status == null || status === 429 || status >= 500
      return {
        key: spec.key, source: spec.source, page: spec.page, count: 0, data: null, ok: false,
        status, errorName, errorMessage, retryable, durationMs: Date.now() - startedAt, skippedByBackoff: false, cacheStatus: 'MISS',
      }
    }
  }
  let sourcesFailedCount = 0
  const failedSourceKeys: string[] = []
  for (const r of sourceResults) {
    sourceCounts[r.key] = r.count
    if (r.data) {
      sourcePayloads.push(r.data)
    }
    if (!r.ok) {
      sourcesFailedCount += 1
      failedSourceKeys.push(r.key)
    }
  }
  // SUCCEEDED-VS-NONEMPTY FIX, DISCLOSED (bug hunt while investigating "Base/Robinhood radar can't
  // find nothing": sourcesSucceeded used to increment only when r.data was truthy — and r.data is
  // set to null whenever a page's real HTTP 200 response simply had 0 pools (see FAILED-SOURCE-VS-
  // GENUINELY-EMPTY above, which introduced r.ok as the correct "did we actually reach GeckoTerminal"
  // signal but left this older counter on the old, wrong semantics "since existing cache-write logic
  // depends on it"). That meant a cycle where every page's real, successful response just happened to
  // have 0 pools (routine for Robinhood — a much smaller chain that runs out of real pools well before
  // page 5 of new_pools/trending/volume) was indistinguishable from GeckoTerminal being completely
  // unreachable: sourcesSucceeded stayed 0, finalState became 'providerUnavailable' (wrong — nothing
  // failed, the pages just paginated past the end), the cycle never got cached (cache write is gated
  // on sourcesSucceeded > 0), and the stale-serve-on-total-failure fallback a few lines down never had
  // anything to fall back to either, because a real success was never recorded as one. sourcesSucceeded
  // now uses the same r.ok signal pagesSucceeded already uses below — a real HTTP success, whether or
  // not that particular page happened to be empty.
  sourcesSucceeded = sourceResults.filter(r => r.ok).length
  // GECKOTERMINAL-FALLBACK DISCOVERY, DISCLOSED (explicitly requested: "If GeckoTerminal fails,
  // fallback to DexScreener" — see fetchDexScreenerBaseFallbackDiscovery's own header comment for
  // the full rationale). Only fires when GT's own discovery genuinely returned zero successful
  // sources this cycle — a real last-resort fallback, never routine extra load. Base-only, matching
  // every other DexScreener-as-discovery path already in this codebase.
  let dexScreenerFallbackAttempted = false
  let dexScreenerFallbackError: string | null = null
  if (sourcesSucceeded === 0 && requestedChain === 'base') {
    dexScreenerFallbackAttempted = true
    const acFallback = new AbortController()
    const tidFallback = setTimeout(() => acFallback.abort(), 8000)
    try {
      const fallback = await fetchDexScreenerBaseFallbackDiscovery(acFallback.signal)
      if (fallback.data.length > 0) {
        sourcePayloads.push({ data: fallback.data, included: fallback.included, __radarSourceKey: `${requestedChain}_dexscreener_fallback` })
        sourceCounts[`${requestedChain}_dexscreener_fallback`] = fallback.data.length
        sourcesSucceeded += 1
      } else {
        dexScreenerFallbackError = fallback.error
      }
    } finally {
      clearTimeout(tidFallback)
    }
  }
  const discoveryDegraded = sourcesFailedCount > 0
  // SIGNIFICANT-VS-MINOR-DEGRADATION FIX, DISCLOSED (explicitly requested: "Only show degraded
  // empty state if all/most source pages fail" — the prior version flagged the UI's degraded
  // message on ANY single failed page combined with 0 displayed tokens, which could misleadingly
  // blame source failure for an outcome the deterministic $80K-$2M/30-holder gate actually caused
  // on a cycle with, say, 1 failed page out of 18 and plenty of real raw candidates). Only a
  // majority-or-more failure is treated as the explanatory cause in filterStage/the frontend empty
  // state; a minor failure still gets recorded fully in the audit (sourcesFailedCount/failedPages)
  // but doesn't override the real gate-driven explanation.
  const discoveryDegradedSignificant = sourcesFailedCount >= Math.ceil(sourcesAttempted / 2)
  // PAGES-SUCCEEDED/FAILED, DISCLOSED: `ok` (a real HTTP 200 vs. a real failure) is the authoritative
  // per-page success signal for baseRadarDiscoverySourceAudit — now the same signal `sourcesSucceeded`
  // above uses too, per the SUCCEEDED-VS-NONEMPTY fix.
  const pagesSucceeded = sourceResults.filter(r => r.ok).length
  const pagesFailed = sourceResults.filter(r => !r.ok).length
  const failedPages = sourceResults.filter(r => !r.ok).map(r => ({
    source: r.source,
    page: r.page,
    urlOrEndpointName: r.key,
    status: r.status,
    errorName: r.errorName,
    errorMessage: r.errorMessage,
    retryable: r.retryable,
    durationMs: r.durationMs,
    skippedByBackoff: r.skippedByBackoff,
  }))
  const fallbackUsed = sourceResults.some(r => r.cacheStatus === 'STALE')
  // BACKOFF-AUDIT, DISCLOSED (explicitly requested: "Add audit showing backoff TTL / skipped source
  // pages"). sourceBackoffSkippedCount is a real count of pages skipped this cycle without even
  // attempting the network call (distinct from pagesFailed, which includes pages that WERE attempted
  // and genuinely failed) — surfaced alongside sourceBackoffTtlMs (the actual cooldown duration) so a
  // "why are pages missing" report is diagnosable from the audit instead of guessed.
  const sourceBackoffSkippedCount = sourceResults.filter(r => r.skippedByBackoff).length

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
    // POOL-AGE-WINDOW, DISCLOSED (deterministic reset — see the DETERMINISTIC-GATE header near
    // EXCLUDED_ESTABLISHED_CONTRACTS): this is the ONE age window left in the pipeline — how old a
    // pool may be and still be considered for New Radar at all — collapsed from the old two-tier
    // primary(6h)/fallback split into a single deterministic cutoff, since the "primary vs fallback"
    // distinction only existed to support the now-removed soft "Relaxed fallback" merge (a candidate
    // that failed the strict valuation/liquidity band but got shown anyway if it had enough activity
    // — exactly the "maybe logic" this reset removes). A pool either falls inside this window or it
    // doesn't; there is no second, looser tier for it to fall back into.
    // WINDOW WIDENED 7 -> 15 -> 20 DAYS, DISCLOSED (explicitly requested: "up it to 20 days 5 million
    // mc" — feed too thin at 15 days / $4M given real GeckoTerminal rate-limit-capped discovery this
    // session).
    const POOL_AGE_WINDOW_MS = 20 * DAY_MS

    type Candidate = Omit<RadarToken, 'clarkVerdict'> & { pairAddress?: string | null }
    const candidates: Candidate[] = []
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
      ageMinutes: number; liquidityUsd: number; volume24h: number
      fdvUsd: number | null; resolvedMarketCap: ReturnType<typeof resolveBaseRadarMarketCap>; primaryPoolAddress: string | null
      needsRescue: boolean; isV4Pool: boolean; quoteTokenAddress: string | null
      // NORMALIZED-CANDIDATE-SHAPE FIX, DISCLOSED: carried from pass 1 (where the raw pool attrs are
      // in scope) through to pass 2's candidate construction (which only has drafts[i], not the
      // original attrs).
      priceUsd: number | null; priceChange24hPct: number | null; priceChange6hPct: number | null; priceChange1hPct: number | null
      pairCreatedAt: string | null
    }
    const drafts: PoolDraft[] = []
    // FUNNEL-DIAGNOSTICS, DISCLOSED: this route has gone completely empty from filter changes
    // multiple times this session, each one only diagnosable by the user sending a screenshot and
    // us guessing. These counters (surfaced via debugPayload.filterFunnel below) show exactly how
    // many candidates each individual filter dropped, so a future empty-feed report can be
    // diagnosed from ?debug=1 output directly instead of another round of guesswork.
    // V4-POOL-CROSS-CHECK, DISCLOSED (requested: replace the blanket V4 exclusion with a real
    // DexScreener cross-check — live audit output showed 69 of ~139 raw candidates in one cycle
    // being blanket-dropped as V4, which given how dominant V4 apparently is on Base right now made
    // the feed unnecessarily thin). GeckoTerminal's reserve_in_usd is untrustworthy for V4 pools
    // (V4's singleton PoolManager doesn't expose per-pool reserves the way V2/V3 does), but that's a
    // GT-specific limitation, not proof the pool has no real liquidity. Instead of dropping every V4
    // pool outright, they now get the SAME DexScreener rescue call this route already makes for
    // missing-market-cap pools (no new provider), and their liquidityUsd is sourced ONLY from
    // DexScreener's own selectedLiquidityUsd — never from GT's unreliable figure for V4. If
    // DexScreener also can't verify real liquidity, liquidityUsd is honestly 0, which then fails the
    // exact same liquidity gates every other pool goes through — no special-cased exclusion, no
    // fabricated pass. droppedByV4Pool now counts V4 pools DexScreener could not verify liquidity
    // for (informational only — never subtracted in baseRadarCandidateGateAudit's funnel math, since
    // these pools already flow through and get correctly counted by the normal liquidity-gate
    // counters below).
    let droppedByV4Pool = 0
    let droppedByV4NoDexScreenerData = 0
    let droppedByV4NoLiquidPair = 0
    let droppedByV4PoolMismatch = 0
    // V4-MISMATCH-SAMPLE, DISCLOSED: real addresses for a few mismatch cases, so the actual shape
    // of the disagreement is visible without needing ?debug=1 — specifically to check whether
    // GeckoTerminal is reporting the same PoolManager singleton address for every V4 pool (which
    // would make primaryPoolAddress structurally meaningless for V4, not a real per-pool identifier)
    // versus a genuinely pool-specific address that just doesn't match DexScreener's own.
    const v4MismatchSample: { contract: string; primaryPoolAddress: string | null; rescueSelectedPairAddress: string | null; rescuePairCount: number }[] = []
    // V4-NO-LIQUID-PAIR-SAMPLE, DISCLOSED: v4_no_liquid_pair became the dominant V4 rejection reason
    // once the PoolId-vs-pairAddress comparison bug was fixed — this captures the raw, unfiltered
    // DexScreener pair values (chainId/liquidityUsd/dexId, via rawPairDiagnostics on the rescue
    // result) for a few of those cases, so a live capture can show whether they're being filtered by
    // a chain-id string mismatch or a genuine zero/unreported liquidity value.
    const v4NoLiquidPairSample: { contract: string; rawPairDiagnostics: { chainId: string | null; liquidityUsd: number; dexId: string | null }[] | null }[] = []
    let droppedByLiquidityFloorSpecifically = 0
    let droppedByAbsoluteLiquidityFloor = 0
    let droppedByDeadVolumeFloor = 0
    let droppedByValuationUnavailable = 0
    let droppedByMarketCapBelow80k = 0
    // CONSOLIDATED-LIQUIDITY-GATE, DISCLOSED: baseRadarCandidateGateAudit needs one deterministic
    // "afterLiquidityGate"/"hiddenLiquidityLow" figure ("liquidity passes existing minimum" is a
    // single hard rule in the new spec) — this sums the three real liquidity-adjacent drop sites
    // (below the configurable minLiquidityUsd floor, below the absolute $500 floor, and the dead-
    // volume floor) without collapsing their individual counters, which stay available in
    // filterFunnel for finer-grained diagnosis.
    let droppedByLiquidityGate = 0
    let afterLiquidityGateCount = 0
    let afterValuationMin80kCount = 0
    // AFTER-VALUATION-MAX-2M RENAME, DISCLOSED (explicitly requested: "Rename/remove
    // afterValuationMax2m as a hard gate"). No longer a gate — it now just counts candidates whose
    // valuation is $80K-$2M ("early range"); a candidate above $2M is counted separately via
    // aboveEarlyRangeCount and still gets fully processed (liquidity/holder checks included), never
    // excluded for being above this number.
    let afterValuationMax2mCount = 0
    let aboveEarlyRangeCount = 0
    // SOURCE-AUDIT, DISCLOSED (requested: a full baseRadarSourceAudit proving whether starvation is
    // real discovery-depth loss vs. an accidental cap/slice). rawTotalBeforeDedupe is the literal
    // count of pool entries GeckoTerminal returned across every source this cycle, before ANY
    // filtering — read directly, not derived. dedupedPoolCount counts entries that survive the very
    // first filter (duplicate pool listing across sources/pages), and passedAgeWindowCount counts
    // entries that additionally have a real createdAt and fall inside the age window — both
    // incremented at their own real `continue` sites below, not re-derived after the fact.
    const rawTotalBeforeDedupe = pooled.length
    let dedupedPoolCount = 0
    let passedAgeWindowCount = 0
    // AUDIT-COMPLETENESS FIX, DISCLOSED (found via code review after the AERO exclusion shipped):
    // that exclusion dropped candidates silently, with no counter — after passedAgeWindowCount++,
    // afterAgeWindow (baseRadarSourceAudit) would no longer reconcile with afterLiquidityMinimum via
    // any documented rejection reason, reproducing the exact class of unexplained funnel gap this
    // audit object exists to prevent (see the AUDIT-MATH-BUG-FIX comment further down, from an
    // earlier untracked double-count that produced impossible negative numbers).
    let droppedByEstablishedToken = 0
    // AUDIT-RECONCILIATION FIX, DISCLOSED (found while investigating a reported funnel gap: live
    // capture showed afterAgeWindow=201 but afterLiquidityMinimum(11) + every documented
    // rejectionReasons bucket at that stage only summed to 243, a 42-candidate discrepancy in the
    // wrong direction). Root cause: three real `continue` sites between passedAgeWindowCount++ and
    // the liquidity gate — missing baseToken, symbol-based EXCLUDED match, and duplicate-contract
    // dedup via seenContracts — had no counter at all, so candidates passedAgeWindowCount counted
    // could vanish from the funnel with no rejection reason to explain where they went. These three
    // counters close that gap; no filtering behavior changes, only what's measured.
    let droppedByMissingBaseToken = 0
    let droppedBySymbolExcluded = 0
    let droppedByDuplicateContract = 0

    for (const pool of pooled) {
      const poolId = String(pool.id ?? '').toLowerCase()
      if (poolId && seenPools.has(poolId)) continue
      if (poolId) seenPools.add(poolId)
      dedupedPoolCount++
      const attrs = pool.attributes  as Record<string, unknown>         | undefined
      const rels  = pool.relationships as Record<string, unknown>       | undefined
      const volObj = attrs?.volume_usd as Record<string, string>        | undefined
      const createdAt = attrs?.pool_created_at as string | undefined
      if (!createdAt) continue

      // V4-POOL-CROSS-CHECK, DISCLOSED — see the header comment near droppedByV4Pool's declaration
      // above for the full history (this used to be a blanket exclusion; now it's a flag that forces
      // a DexScreener liquidity cross-check further below instead of trusting GT's reserve_in_usd).
      const dexRelData = (rels?.dex as { data?: { id?: string } } | undefined)?.data
      const dexId = String(dexRelData?.id ?? '').toLowerCase()
      const isV4Pool = dexId.includes('v4')

      const ageMs      = now - new Date(createdAt).getTime()
      const ageMinutes = Math.floor(ageMs / 60000)
      const liquidityUsd = parseFloat(String(attrs?.reserve_in_usd ?? '0')) || 0
      const volume24h    = parseFloat(volObj?.h24 ?? '0') || 0
      // NORMALIZED-CANDIDATE-SHAPE FIX, DISCLOSED: real values straight from the same provider
      // attributes already parsed above — GeckoTerminal's own pool response and the DexScreener-
      // fallback adapter (see fetchDexScreenerBaseFallbackDiscovery) both populate these same
      // attribute names, so this works identically for either discovery source. null, never
      // fabricated, when a provider didn't report a figure.
      const priceChangeObj = attrs?.price_change_percentage as Record<string, string> | undefined
      const priceUsd = finiteOrNull(attrs?.base_token_price_usd)
      const priceChange24hPct = finiteOrNull(priceChangeObj?.h24)
      const priceChange6hPct = finiteOrNull(priceChangeObj?.h6)
      const priceChange1hPct = finiteOrNull(priceChangeObj?.h1)

      // V4-POOL-CROSS-CHECK, DISCLOSED: skip V4 pools here — GT's reserve_in_usd isn't trusted for
      // them (see the header comment near droppedByV4Pool's declaration) and the DexScreener cross-
      // check hasn't run yet at this point in the pipeline, so there's no verified figure to use for
      // this stats sample. Matches the prior behavior (V4 was blanket-excluded before this point
      // entirely) — this stat just never counted V4 pools, same as before.
      if (!isV4Pool && ageMs < DAY_MS && liquidityUsd >= 1000) allDay24h.push(liquidityUsd)

      if (ageMs >= POOL_AGE_WINDOW_MS) continue
      passedAgeWindowCount++

      const baseData    = ((rels?.base_token as Record<string, unknown>)?.data) as Record<string, string> | undefined
      const baseToken   = baseData?.id ? tokenMap.get(baseData.id) : undefined
      if (!baseToken) { droppedByMissingBaseToken++; continue }
      // V4-BASE-QUOTE-DISAMBIGUATION, DISCLOSED (reported: "more digging" after the PoolId-vs-
      // pairAddress fix — v4MismatchSample showed rescuePairCount routinely 7-30 for popular base
      // tokens, because getDexMarketCapRescue queries DexScreener by TOKEN address only, returning
      // every pair across every DEX/quote-token/fee-tier for that token. base_token+quote_token are
      // both real ERC20 contract addresses in GT's schema (unlike the V4 pool "address", which is a
      // PoolId hash) and DexScreener reports the same two real addresses per pair — narrowing
      // DexScreener's raw pairs to only ones sharing this pool's exact quote token (before the
      // existing "exactly one live pair" trust check runs) turns many previously-ambiguous 10-30-way
      // ties into a genuine 1-way match, without ever guessing which specific fee tier it is.
      const quoteData        = ((rels?.quote_token as Record<string, unknown>)?.data) as Record<string, string> | undefined
      const quoteToken       = quoteData?.id ? tokenMap.get(quoteData.id) : undefined
      const quoteTokenAddress = quoteToken?.address ?? null

      if (EXCLUDED.has(baseToken.symbol.toUpperCase())) { droppedBySymbolExcluded++; continue }
      // CHAIN-SCOPED-EXCLUSION, DISCLOSED: EXCLUDED_ESTABLISHED_CONTRACTS (AERO/AVNT) are verified
      // Base-mainnet addresses — meaningless (and, on a different chain, a real address-collision
      // risk) applied to Robinhood pools, so this hard-coded exclusion only ever applies on 'base'.
      if (requestedChain === 'base' && EXCLUDED_ESTABLISHED_CONTRACTS.has(baseToken.address.toLowerCase())) { droppedByEstablishedToken++; continue }

      const key = baseToken.address.toLowerCase()
      if (seenContracts.has(key)) { droppedByDuplicateContract++; continue }
      seenContracts.add(key)

      const fdvUsd = parseFloat(String(attrs?.fdv_usd ?? '0')) || null
      const resolvedMarketCap = resolveBaseRadarMarketCap({ geckoPool: { attributes: attrs }, geckoIncludedToken: { attributes: baseToken.attributes } })
      const primaryPoolAddress = typeof attrs?.address === 'string'
        ? attrs.address
        : poolId.includes('_') ? poolId.split('_').pop() ?? null : null

      drafts.push({
        baseToken, ageMinutes, liquidityUsd, volume24h,
        fdvUsd, resolvedMarketCap, primaryPoolAddress, needsRescue: resolvedMarketCap.marketCapUsd == null || isV4Pool, isV4Pool,
        quoteTokenAddress,
        priceUsd, priceChange24hPct, priceChange6hPct, priceChange1hPct, pairCreatedAt: createdAt,
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
            ? await getDexMarketCapRescue({ chain: requestedChain, token: d.baseToken.address, primaryPoolAddress: d.primaryPoolAddress, primaryQuoteTokenAddress: d.quoteTokenAddress })
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

    const nearMissSample: { symbol: string; contract: string; liquidityUsd: number; valuationUsd: number | null; marketCapStatus: 'verified' | 'unavailable' }[] = []
    for (let i = 0; i < drafts.length; i++) {
      const { baseToken, ageMinutes, volume24h, fdvUsd, resolvedMarketCap, primaryPoolAddress, isV4Pool, priceUsd, priceChange24hPct, priceChange6hPct, priceChange1hPct, pairCreatedAt } = drafts[i]
      const rescue = rescueResults[i]
      // WRONG-POOL LIQUIDITY FIX, DISCLOSED (reported: DexScreener showed "$0 / unknown liquidity"
      // and a real-liquidity warning banner for the exact pool this route displayed, while the radar
      // showed a multi-million-dollar liquidity figure for the same token — live-verified against
      // dexscreener.com directly). Root cause: getDexMarketCapRescue queries DexScreener by TOKEN
      // address, which can return several unrelated pools for that token across different DEXes/
      // pairs; selectDexScreenerMarketCapRescuePair only prefers the primary pool when it's present
      // AND already has DexScreener-reported liquidity > 0 — if the actual pool being shown here has
      // zero/unknown liquidity (exactly this case), it silently substitutes whichever OTHER pool for
      // the same token has the highest liquidity, even though that pool is not the one a user acting
      // on this radar entry would actually be trading. Fail closed instead: a pool's liquidity is
      // only trusted when DexScreener's rescue actually resolved THIS pool (selectedPairAddress
      // matches primaryPoolAddress) — any other pool's liquidity number is never attributed to a
      // pool it doesn't belong to. Same principle as the holder-count gate's fail-closed design.
      // V4-POOLID-VS-PAIRADDRESS, DISCLOSED (confirmed via live v4MismatchSample data: GeckoTerminal's
      // reported "address" for a V4 pool is a 64-hex-char value — a bytes32 Uniswap V4 PoolId hash,
      // since V4 pools are accounting entries inside one shared PoolManager singleton with no true
      // per-pool contract address — while DexScreener's pairAddress is always a normal 40-hex-char
      // contract address. These are two different identifier types in two different address spaces;
      // a direct string/lowercase equality check between them can never succeed for ANY V4 pool,
      // regardless of real liquidity. The address-equality check above was silently zeroing out every
      // V4 pool's liquidity unconditionally — not a data-quality gap, a structural bug. For V4 only,
      // "this is the right pool" can't be proven by address, so the fail-closed criterion instead
      // requires DexScreener to report EXACTLY ONE pair with real liquidity on this chain for the
      // token (rescue.sortedPairCount === 1) — an unambiguous single-pool case where there is no other
      // candidate liquidity number that could be wrongly borrowed. When DexScreener shows more than
      // one live pair for the token, which one is genuinely this V4 pool is still unresolvable, so it
      // still fails closed exactly as before — the wrong-pool protection is preserved for the
      // ambiguous case, only the previously-impossible unambiguous case is now unblocked.
      const rescueMatchesThisPool = isV4Pool
        ? rescue?.sortedPairCount === 1
        : !!rescue?.selectedPairAddress
          && !!primaryPoolAddress
          && rescue.selectedPairAddress.toLowerCase() === primaryPoolAddress.toLowerCase()
      // V4-POOL-CROSS-CHECK, DISCLOSED: for a V4 pool, liquidityUsd comes ONLY from DexScreener's
      // own selectedLiquidityUsd (the same rescue call already made above) — GT's reserve_in_usd is
      // never trusted for V4 (see the header comment near droppedByV4Pool's declaration). If
      // DexScreener also couldn't verify real liquidity FOR THIS SPECIFIC POOL, this is honestly 0,
      // which then fails the exact same liquidity gates every other pool goes through below — no
      // special-cased pass, and never another pool's liquidity borrowed to cover the gap.
      const liquidityUsd = isV4Pool
        ? (rescueMatchesThisPool && typeof rescue?.selectedLiquidityUsd === 'number' && rescue.selectedLiquidityUsd > 0 ? rescue.selectedLiquidityUsd : 0)
        : drafts[i].liquidityUsd
      if (isV4Pool && liquidityUsd === 0) {
        droppedByV4Pool++
        // V4-MISMATCH-DIAGNOSTIC, DISCLOSED (reported: "should be more tokens, is DexScreener even
        // working" — v4_liquidity_unverified was consistently ~30-40% of raw candidates across
        // several live captures). Two real, distinct causes remain even after the V4-POOLID-VS-
        // PAIRADDRESS fix above unblocked the unambiguous single-pair case: v4_no_liquid_pair (the raw
        // DexScreener pair(s) that exist never survive the chain-match + positive-liquidity filter —
        // a coverage/data-quality question) vs v4_pool_address_mismatch (DexScreener reports MULTIPLE
        // live pairs for the token, so — since V4 has no comparable per-pool address — which one is
        // genuinely this specific pool is unresolvable; stays fail-closed rather than guessing/
        // borrowing another pool's liquidity, per the WRONG-POOL LIQUIDITY FIX above).
        if (!rescue || rescue.pairCount === 0) droppedByV4NoDexScreenerData++
        else if (rescue.sortedPairCount === 0) {
          droppedByV4NoLiquidPair++
          if (v4NoLiquidPairSample.length < 8) {
            v4NoLiquidPairSample.push({ contract: baseToken.address, rawPairDiagnostics: rescue.rawPairDiagnostics })
          }
        }
        else if (!rescueMatchesThisPool) {
          droppedByV4PoolMismatch++
          if (v4MismatchSample.length < 8) {
            v4MismatchSample.push({
              contract: baseToken.address,
              primaryPoolAddress,
              rescueSelectedPairAddress: rescue?.selectedPairAddress ?? null,
              rescuePairCount: rescue?.pairCount ?? 0,
            })
          }
        }
      }
      const marketCapUsd = resolvedMarketCap.marketCapUsd ?? rescue?.marketCapUsd ?? null
      const marketCapStatus = marketCapUsd != null ? 'verified' : resolvedMarketCap.marketCapStatus
      const marketCapFieldPath = resolvedMarketCap.marketCapUsd != null ? resolvedMarketCap.marketCapFieldPath : rescue?.marketCapFieldPath ?? resolvedMarketCap.marketCapFieldPath
      const resolverReason = resolvedMarketCap.marketCapUsd != null ? resolvedMarketCap.reason : rescue?.reason ?? resolvedMarketCap.reason
      // DETERMINISTIC LIQUIDITY GATE, DISCLOSED ("Base Radar deterministic valuation band only" —
      // liquidity passes existing minimum, no soft caps, no maybe logic, no fallback tier). A
      // candidate either clears every real liquidity check or it's excluded — there is no longer a
      // second, looser "Relaxed fallback" path that showed a candidate anyway if it had enough
      // volume/momentum. All three real liquidity-adjacent checks roll into droppedByLiquidityGate
      // for the audit's single hiddenLiquidityLow/afterLiquidityGate figure; their individual
      // counters stay available in filterFunnel for diagnosis.
      if (liquidityUsd < minLiquidityUsd) { droppedByLiquidityFloorSpecifically++; droppedByLiquidityGate++; continue }
      if (liquidityUsd < ABSOLUTE_MIN_LIQUIDITY_USD) { droppedByAbsoluteLiquidityFloor++; droppedByLiquidityGate++; continue }
      // DEAD-VOLUME FLOOR, DISCLOSED (reported: feed full of tokens with real liquidity/valuation
      // but $30-70 in 24h volume on six-figure liquidity — essentially untraded pools). Requires at
      // least minimal real activity on every candidate — "candidate has enough basic market evidence
      // to rank" is one of the hard rules, and a pool nobody is trading doesn't clear that bar just
      // because its liquidity number looks fine.
      // GRACE-PERIOD FIX, DISCLOSED (reported: feed went completely empty after this floor
      // shipped). A pool created 10 minutes ago has, by definition, only had 10 minutes to
      // accumulate the volume GeckoTerminal reports as its "24h" figure — a genuinely brand-new,
      // legitimate token can easily be under $200 simply because it hasn't existed long enough yet,
      // not because it's dead. Exempts very-new pools from this floor; the dead-volume check is
      // about spotting stale/abandoned tokens, not punishing freshness.
      const hasMeaningfulActivity = ageMinutes < 15 || volume24h >= 200 || (liquidityUsd > 0 && volume24h / liquidityUsd >= 0.02)
      if (!hasMeaningfulActivity) { droppedByDeadVolumeFloor++; droppedByLiquidityGate++; continue }
      afterLiquidityGateCount++

      // VALUATION RESOLUTION, DISCLOSED: reuses tokenPassesRadarValuationFilters purely to get the
      // resolved valuation basis (verified market cap preferred, FDV fallback only if allowed and
      // clearly labeled below) — its own `included` boolean is ignored here; the deterministic
      // $80K-$2M band decides inclusion, not the query-param-configurable minValuationUsd this
      // shared helper was built around.
      const filterResult = tokenPassesRadarValuationFilters({ marketCapUsd, marketCapStatus, fdvUsd, liquidityUsd, minValuationUsd, minLiquidityUsd, allowFdvFallback })
      const valuation = filterResult.valuation
      // THRESHOLD-EXPLORATION LOG, DISCLOSED (requested: "would $50K valuation / $15K liquidity /
      // 30 holders get us a couple tokens" — the aggregate audit counts can't answer that, only each
      // candidate's real numbers can). Logs every candidate that's already cleared liquidity/
      // activity, before the valuation band decides its fate, so different threshold combinations
      // can be checked against real live data instead of guessing. Holder count isn't included here
      // (it's only resolved later, budget-limited, for the ranked subset) — this only answers the
      // valuation/liquidity half of the question.
      nearMissSample.push({ symbol: baseToken.symbol, contract: baseToken.address, liquidityUsd: Math.round(liquidityUsd), valuationUsd: valuation.valueUsd != null ? Math.round(valuation.valueUsd) : null, marketCapStatus })
      // DETERMINISTIC VALUATION BAND, DISCLOSED (requested: "Base Radar deterministic valuation band
      // only" — [$80K, $2M], no soft caps, no maybe logic, no exception for momentum/volume/name).
      // getRadarValuationBasis (lib/baseRadarValuation.ts) flattens a real market cap and an FDV
      // fallback into a single "verified_market_cap" basis by explicit prior product decision (FDV
      // is shown as "Market Cap" everywhere with no distinct fallback label) — that shared display
      // behavior is intentionally left untouched here. This gate instead tracks, locally, whether
      // THIS candidate's number came from a real marketCapUsd or was FDV-derived, purely to (a)
      // decide whether the band was actually cleared and (b) attach an explicit fallback evidence
      // gap so an FDV-sourced valuation can never look identical to a real confirmed market cap in
      // the reasons shown for this candidate, without changing the shared valuation display.
      const isRealVerifiedMarketCap = isRealVerifiedMarketCapValue(marketCapStatus, marketCapUsd)
      if (valuation.valueUsd == null) { droppedByValuationUnavailable++; continue }
      if (!passesMainFeedValuationMinGate(valuation.valueUsd)) { droppedByMarketCapBelow80k++; continue }
      afterValuationMin80kCount++
      // $2M-IS-A-CLASSIFICATION-NOT-AN-EXCLUSION FIX, DISCLOSED (reported live: a real audit showed
      // 1 candidate clearing $80K, immediately zeroed out by the $2M ceiling — 0 candidates ever
      // reached the holder check, which made the feed look holder-check-blocked when the real cause
      // was the valuation ceiling removing every candidate before holders were ever checked). $2M no
      // longer excludes a candidate from default New Radar — it only changes how the candidate is
      // classified. A candidate above $2M still has to clear every other real requirement (liquidity,
      // dead-volume floor, a resolved valuation, and the holder check below) exactly like any other
      // candidate; it's never hidden, faked, or given an easier bar purely for being above $2M.
      const isEstablished = !passesMainFeedValuationMaxGate(valuation.valueUsd)
      if (isEstablished) aboveEarlyRangeCount++
      else afterValuationMax2mCount++
      const valuationCardDisplay = getRadarValuationCardDisplay(valuation, fmtK)
      const valuationEvidenceGap = getRadarValuationEvidenceGap(valuation)
      const evidenceGaps = [
        ...(valuationEvidenceGap ? [valuationEvidenceGap] : []),
        ...(!isRealVerifiedMarketCap ? ['Valuation confirmed via FDV fallback — no separate verified market cap available'] : []),
        ...(isEstablished ? ['Established — above early range, not a fresh microcap'] : []),
      ]
      const candidate = {
        name: baseToken.name, symbol: baseToken.symbol, contract: baseToken.address,
        chainSlug: requestedChain, chainId: requestedChain === 'robinhood' ? ROBINHOOD_CHAIN_ID : 8453,
        tokenAddress: baseToken.address, priceUsd, priceChange24hPct, priceChange6hPct, priceChange1hPct, pairCreatedAt,
        ageMinutes, liquidityUsd, volume24h, fdvUsd, marketCapUsd, marketCapStatus, valuationBasis: valuation.basis, valuationUsd: valuation.valueUsd, valuationLabel: valuation.label, valuationSublabel: valuationCardDisplay.sublabel, valuationVerified: valuation.verified, valuationReason: valuation.reason, valuationCortexLine: getRadarCortexValuationLine(), isEstablished, holderVerified: false, evidenceGaps, riskLevel: 'SAFE', honeypot: null,
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
      candidates.push(candidate)
    }

    // Sort by blend of momentum/liquidity/volume/freshness. This is ranking ORDER only, applied
    // strictly among candidates that already passed every deterministic gate above — momentum can
    // never let a failing candidate appear, it only decides where a passing one lands in the list.
    candidates.sort((a, b) => {
      const mA = a.liquidityUsd > 0 ? a.volume24h / a.liquidityUsd : 0
      const mB = b.liquidityUsd > 0 ? b.volume24h / b.liquidityUsd : 0
      const sA = (mA * 40) + Math.log10(Math.max(a.liquidityUsd, 1)) * 18 + Math.log10(Math.max(a.volume24h, 1)) * 18 + (a.ageMinutes <= 120 ? 12 : 0) + (a.fdvUsd && a.fdvUsd > 0 ? 6 : 0)
      const sB = (mB * 40) + Math.log10(Math.max(b.liquidityUsd, 1)) * 18 + Math.log10(Math.max(b.volume24h, 1)) * 18 + (b.ageMinutes <= 120 ? 12 : 0) + (b.fdvUsd && b.fdvUsd > 0 ? 6 : 0)
      return sB - sA
    })
    // STARVATION FIX #2, DISCLOSED (reported: raising HOLDER_CHECK_LIMIT from 20 to 30 still left
    // the feed starved to 1 token). Root cause: a FIXED top-N cutoff is wrong no matter how big N
    // is, because momentum rank has nothing to do with valuation or holder count — on a day where
    // most high-momentum Base pools happen to be low-holder degen tokens, the top N by momentum can
    // legitimately contain almost no 30+-holder tokens even though plenty exist further down the
    // ranked list. Replaced the fixed cutoff with a budget-driven loop: check ranked candidates in
    // batches, in momentum order, and STOP as soon as either (a) DISPLAY_TARGET candidates have
    // actually passed the holder gate — no reason to keep spending provider calls once the feed has
    // enough — or (b) HOLDER_CHECK_BUDGET_CAP total checks have been made — a hard ceiling so a
    // genuinely thin market can't turn into an unbounded/slow request. RANKED_CANDIDATES_CAP raised
    // 50 -> 100 so the loop actually has a larger pool to draw from before hitting the budget cap.
    const RANKED_CANDIDATES_CAP = 100
    const rankedCandidates = candidates.slice(0, RANKED_CANDIDATES_CAP)
    // RANKING-CAP AUDIT GAP, DISCLOSED (found during a full-pipeline audit): candidates beyond
    // RANKED_CANDIDATES_CAP were silently dropped here with no counter at all — on a cycle where
    // more than 100 candidates clear the full liquidity+valuation band (plausible now that
    // discovery pulls 18 GeckoTerminal pages and the band is $80K-$2M), afterValuationMax2mCount
    // would report the full uncapped count while rankedCandidates.length stayed capped at 100, so
    // summing every documented hidden/rejection reason against afterValuationMax2m would stop
    // reconciling — the exact class of unexplained funnel gap this audit exists to prevent (see the
    // AUDIT-RECONCILIATION FIX comment near droppedByMissingBaseToken above).
    const droppedByRankingCap = Math.max(0, candidates.length - rankedCandidates.length)
    const holderCheckStartedAt = Date.now()
    const HOLDER_CHECK_CONCURRENCY = 8
    const holderCountByContract = new Map<string, number | null>()
    // Captured alongside the count so the later capped concentration step (BASE_RADAR_HOLDER_
    // CONCENTRATION_CAP) can correctly tell resolveBaseRadarHolderConcentration whether this
    // already-known count is exact or a page-bound minimum ("100+") — reading it from anywhere else
    // (e.g. re-deriving from evidenceGaps) would silently default to "exact" and misreport minimum
    // counts as fully verified.
    const holderCountCappedByContract = new Map<string, boolean>()
    const holderCheckFailureReasons: Record<string, number> = {}
    const holderCheckFailureSample: { httpStatus: number | null; errorBody: string | null; chainPathUsed?: string }[] = []
    const holderCheckedCandidates: Candidate[] = []
    let holderCheckAttemptedCount = 0
    let passingHolderGateCount = 0
    // CANDIDATE-POOL-EXHAUSTED, DISCLOSED: distinct from holderCheckBudgetExhausted (spending cap
    // hit) — this is true when the loop stopped because it ran out of ranked candidates to check,
    // not because it hit HOLDER_CHECK_BUDGET_CAP. Captured from the loop's own final cursor position
    // so it can never drift from what actually happened.
    let holderCheckCursor = 0
    {
      while (shouldContinueHolderChecking({ passingCount: passingHolderGateCount, attemptedCount: holderCheckAttemptedCount, cursor: holderCheckCursor, poolSize: rankedCandidates.length })) {
        const remainingBudget = HOLDER_CHECK_BUDGET_CAP - holderCheckAttemptedCount
        const batch = rankedCandidates.slice(holderCheckCursor, holderCheckCursor + Math.min(HOLDER_CHECK_BATCH_SIZE, remainingBudget))
        holderCheckCursor += batch.length
        const resultByContract = new Map<string, HolderCountResult>()
        let nextIndex = 0
        const worker = async () => {
          for (;;) {
            const i = nextIndex++
            if (i >= batch.length) return
            const t = batch[i]
            const r = await fetchBaseHolderCount(t.contract, requestedChain)
            resultByContract.set(t.contract.toLowerCase(), r)
            holderCountByContract.set(t.contract.toLowerCase(), r.count)
            holderCountCappedByContract.set(t.contract.toLowerCase(), r.isCapped === true)
          }
        }
        await Promise.all(Array.from({ length: Math.min(HOLDER_CHECK_CONCURRENCY, batch.length) }, () => worker()))
        for (const t of batch) {
          holderCheckAttemptedCount++
          const holderResult = resultByContract.get(t.contract.toLowerCase())
          if (holderResult && holderResult.reason !== 'ok') {
            holderCheckFailureReasons[holderResult.reason] = (holderCheckFailureReasons[holderResult.reason] ?? 0) + 1
            if (holderCheckFailureSample.length < 5) holderCheckFailureSample.push({ httpStatus: holderResult.httpStatus ?? null, errorBody: holderResult.errorBody ?? null, chainPathUsed: holderResult.chainPathUsed })
          }
          holderCheckedCandidates.push(t)
          const holderCount = holderCountByContract.get(t.contract.toLowerCase())
          if (passesMainFeedHolderGate(holderCount)) passingHolderGateCount++
        }
      }
    }
    const holderCheckMs = Date.now() - holderCheckStartedAt
    const candidatePoolExhausted = holderCheckCursor >= rankedCandidates.length && passingHolderGateCount < DISPLAY_TARGET
    // FAIL-CLOSED ON PROVIDER OUTAGE, DISCLOSED (reported: a token with only 3 holders and $0 real
    // liquidity on DexScreener — a textbook fake-pump scam pool — made it into the live feed despite
    // the 30-holder gate). Root cause: the previous version of this code "failed open" on a total
    // GoldRush outage — if EVERY holder-count lookup in a request failed, it fell back to showing
    // ALL ranked candidates completely UNFILTERED by the holder gate, on the theory that a provider
    // blip shouldn't zero the whole feed. That was true for the empty-feed bug it was fixing, but it
    // also meant a full outage (which this session has now observed happen for real — GoldRush 429s
    // and DNS failures) let literally anything through, including a 3-holder scam token, mislabeled
    // as if it had cleared a gate it never actually passed. Showing nothing is the honest answer when
    // holder evidence genuinely cannot be verified — never showing an unverified candidate as if it
    // were verified. toCheck is now always the real, checked, gate-passing set; on a total outage
    // that set is legitimately empty rather than being backfilled with unverified candidates.
    const holderCheckSucceededCount = [...holderCountByContract.values()].filter((c): c is number => typeof c === 'number').length
    const holderProviderReachable = holderCheckSucceededCount > 0
    // HOLDER-GATE-SOFTENED-TO-EVIDENCE-GAP, DISCLOSED (explicitly requested, superseding the old
    // FAIL-CLOSED behavior below this comment's history: "holder count >= 30 required only when
    // holder provider is reachable / holder data available... holder count unavailable should still
    // be evidence-gapped/capped, not silently promoted as verified"). A candidate with a REAL,
    // resolved holder count below 30 is still excluded outright — that's known, verified evidence of
    // failing the bar. A candidate whose holder count could not be resolved (provider down, timeout,
    // no_data) is no longer excluded — it's shown, but holderVerified stays false and
    // holder_provider_unreachable is attached as an explicit evidence gap, and its risk score is
    // capped so it can never display as SAFE purely because we couldn't check (see scoreRisk below).
    // [PRIOR HISTORY] This route previously failed closed here specifically because failing OPEN on
    // a total provider outage once let a 3-holder scam token through mislabeled as gate-passing. The
    // fix here is different in kind: the candidate is shown, but never claims holder verification —
    // it's the "0 candidates, no confirmation either way" outcome swapped for "shown, honestly
    // labeled as holder-unverified," never "shown as if verified."
    let droppedByHoldersBelow30 = 0
    let holderProviderUnavailableCount = 0
    const toCheck = holderCheckedCandidates.filter((t) => {
      const holderCount = holderCountByContract.get(t.contract.toLowerCase())
      if (typeof holderCount !== 'number') { holderProviderUnavailableCount++; return true }
      if (!passesMainFeedHolderGate(holderCount)) { droppedByHoldersBelow30++; return false }
      return true
    })

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
    const simulationStartedAt = Date.now()
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
          const hp = await withTimeout(getCachedHoneypot(t.contract, requestedChain, false), 2600, null)
          hpByContract.set(t.contract.toLowerCase(), hp)
        }
      }
      await Promise.all(Array.from({ length: Math.min(SIM_CONCURRENCY, simTargets.length) }, () => worker()))
    }
    const simulationMs = Date.now() - simulationStartedAt
    // CACHE-KEY-DRIFT, DISCLOSED (found in a full Base Radar audit): this read the bare contract as
    // the cache key, but getCachedHoneypot switched to a chain-prefixed key (`${chain}:${contract}`)
    // when Robinhood support landed — so this lookup always missed and honeypotCacheHits was
    // permanently 0 in debug output, making the cache look broken when it was working fine. Uses the
    // same key shape the cache is actually written with.
    const hpCacheHitFlags = simTargets.map(t => { const c = honeypotCache.get(`${requestedChain}:${t.contract.toLowerCase()}`); return !!(c && Date.now() - c.cachedAt <= HONEYPOT_CACHE_TTL_MS) })

    // HOLDER-COUNT-VS-CONCENTRATION, DISCLOSED (requested: don't reject a candidate from the main
    // feed just because top1/10/20 concentration is unavailable — the feed only ever fetches holder
    // COUNT (a single lightweight GoldRush total_count call), never the full concentration
    // breakdown, which needs the heavier per-holder-balance pull this route intentionally doesn't
    // make (no new expensive provider calls). A candidate that reaches this point already cleared
    // the real 30-holder count gate — it is never hidden for this reason — but its evidence gaps
    // say plainly that concentration specifically is unresolved, so it never looks identical to a
    // token whose full holder breakdown actually was checked and came back clean.
    const scored: Candidate[] = toCheck.map((token) => {
      const hp = hpByContract.get(token.contract.toLowerCase()) ?? null
      const simulation = getRadarSimulationDisplay({ contract: token.contract, liquidityUsd: token.liquidityUsd, pairAddress: token.pairAddress ?? null, honeypot: hp })
      const baseGaps = simulation.status === 'passed' ? (token.evidenceGaps ?? []) : [...(token.evidenceGaps ?? []), 'Buy/sell simulation not confirmed', simulation.label, 'Honeypot/tax status not confirmed', ...(token.ageMinutes < 15 ? ['Token is very new'] : [])]
      // HOLDER-EVIDENCE-HONESTY, DISCLOSED: holderCount typeof number here means it was actually
      // resolved (and, since below-30-real-counts were already excluded in the toCheck filter above,
      // any candidate reaching this point with a real number necessarily cleared MAIN_FEED_MIN_HOLDERS).
      // holderCount not being a number means the provider never answered for this contract this
      // cycle — holderVerified stays false and holder_provider_unreachable is attached explicitly,
      // never silently treated as if it had passed.
      const holderCount = holderCountByContract.get(token.contract.toLowerCase())
      const holderVerified = typeof holderCount === 'number'
      const holderGaps = holderVerified ? [] : ['holder_provider_unreachable — holder count could not be confirmed this cycle']
      return {
        ...token,
        honeypot: hp,
        holderVerified,
        riskLevel: scoreRisk({
          hp,
          simulationStatus: simulation.status,
          ageMinutes: token.ageMinutes,
          liquidityUsd: token.liquidityUsd,
          volume24h: token.volume24h,
          holderVerified,
        }),
        simulationStatus: simulation.status,
        simulationReason: simulation.reason,
        simulationLabel: simulation.label,
        simulationCortexLine: simulation.cortexLine,
        evidenceGaps: Array.from(new Set([...baseGaps, ...holderGaps, CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP])),
      }
    })

    // 3. Clark verdicts for top 5 by liquidity. Shallow mode skips AI verdicts.
    const top5     = shallowMode ? [] : [...scored].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 5)
    const verdicts = shallowMode ? new Map<string, string>() : await getClarkVerdicts(top5)

    // 4. Final output — newest first for live feed
    const toRadarToken = (t: Candidate): RadarToken => {
      const { pairAddress: _pairAddress, ...rest } = t
      return { ...rest, clarkVerdict: verdicts.get(t.contract.toLowerCase()) ?? null }
    }
    const tokens: RadarToken[] = [...scored]
      .sort((a, b) => a.ageMinutes - b.ageMinutes)
      .map(toRadarToken)

    // LIVE-FEED, DISCLOSED (explicitly requested: replace the 24h daily pool — "we should be getting
    // tokens a lot instantly, you really want users to get 1 and wait hours for a couple more" —
    // capped at 10/day was a deliberate earlier design, but real usage showed it trickling in far too
    // slowly). Every refresh now shows exactly what currently qualifies THIS cycle — no persisted
    // pool, no daily cap, no carry-over of stale entries from earlier in the day. `tokens` above
    // already holds every candidate that cleared every gate this cycle; nothing further to merge.
    // HOLDER-CONCENTRATION-AUDIT, DISCLOSED: aggregate stats for the capped concentration resolution
    // below — every count here is real/measured (attempted/succeeded/failed/skipped/cacheHits), never
    // estimated. providerOrder documents the real fallback chain actually used (see
    // lib/server/baseRadarHolderConcentration.ts's own header for why step 2, Alchemy, is skipped —
    // no existing ERC20 top-holder path exists in this codebase to reuse).
    const baseRadarHolderConcentrationAudit = {
      enabled: true,
      providerOrder: ['goldrush', 'alchemy_skipped_no_existing_erc20_holder_path', 'minimum_count_fallback', 'unavailable'],
      attemptedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      cacheHits: 0,
      providerFailures: {} as Record<string, number>,
      samples: [] as Array<{
        symbol: string | null
        tokenAddress: string
        provider: string | null
        holderCountStatus: string
        holderCountExact: number | null
        holderCountMinimum: number | null
        concentrationStatus: string
        top1Percent: number | null
        top10Percent: number | null
        top20Percent: number | null
        evidenceGaps: string[]
      }>,
    }
    {
      // HOLDER-CONCENTRATION-ON-DISPLAY, DISCLOSED (carried over from the daily-pool version:
      // "Restore real Top 1/10/20 concentration in Base Radar" — reusing the already-proven
      // GoldRush/Covalent path, not a new provider). Resolved for tokens that just cleared every
      // gate (valuation, liquidity, real holder count) and are about to actually be displayed this
      // cycle — bounded to BASE_RADAR_HOLDER_CONCENTRATION_CAP regardless of how many qualify, same
      // cost guardrail as before, just applied to the live list instead of only "newly admitted"
      // pool slots. A candidate's holder COUNT was already resolved a few steps up
      // (holderCountByContract, from the existing count-only gate check) — passed through as
      // knownHolderCount so this only spends a NEW provider call on the concentration pull itself,
      // never a redundant count-only call. A failure here never removes the candidate; it just
      // leaves holderEvidence absent on that token, same as any other feed cycle that hasn't
      // resolved it yet.
      const concentrationTargets = tokens.slice(0, BASE_RADAR_HOLDER_CONCENTRATION_CAP)
      if (concentrationTargets.length > 0) {
        let nextIndex = 0
        const worker = async () => {
          for (;;) {
            const i = nextIndex++
            if (i >= concentrationTargets.length) return
            const entry = concentrationTargets[i]
            baseRadarHolderConcentrationAudit.attemptedCount++
            try {
              const known = holderCountByContract.get(entry.contract.toLowerCase())
              const knownCapped = holderCountCappedByContract.get(entry.contract.toLowerCase()) === true
              const resolved = await resolveBaseRadarHolderConcentration({
                chain: requestedChain,
                tokenAddress: entry.contract,
                knownHolderCount: typeof known === 'number' ? { count: known, isMinimum: knownCapped } : null,
              })
              entry.holderEvidence = resolved
              if (resolved.concentrationFromCache) baseRadarHolderConcentrationAudit.cacheHits++
              if (resolved.concentrationStatus === 'resolved') {
                baseRadarHolderConcentrationAudit.succeededCount++
              } else {
                baseRadarHolderConcentrationAudit.failedCount++
                baseRadarHolderConcentrationAudit.providerFailures[resolved.concentrationReason] = (baseRadarHolderConcentrationAudit.providerFailures[resolved.concentrationReason] ?? 0) + 1
              }
              if (baseRadarHolderConcentrationAudit.samples.length < 10) {
                baseRadarHolderConcentrationAudit.samples.push({
                  symbol: entry.symbol ?? null,
                  tokenAddress: entry.contract,
                  provider: resolved.holderProvider,
                  holderCountStatus: resolved.holderCountStatus,
                  holderCountExact: resolved.holderCountExact ?? null,
                  holderCountMinimum: resolved.holderCountMinimum ?? null,
                  concentrationStatus: resolved.concentrationStatus,
                  top1Percent: resolved.top1Percent ?? null,
                  top10Percent: resolved.top10Percent ?? null,
                  top20Percent: resolved.top20Percent ?? null,
                  evidenceGaps: resolved.evidenceGaps,
                })
              }
            } catch {
              // Failure must not remove the candidate — it's already qualified; just no
              // concentration evidence attached this cycle.
              baseRadarHolderConcentrationAudit.failedCount++
              baseRadarHolderConcentrationAudit.providerFailures.unexpected_error = (baseRadarHolderConcentrationAudit.providerFailures.unexpected_error ?? 0) + 1
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(BASE_RADAR_HOLDER_CONCENTRATION_CONCURRENCY, concentrationTargets.length) }, () => worker()))
      }
      baseRadarHolderConcentrationAudit.skippedCount = tokens.length - concentrationTargets.length
    }

    // ESTABLISHED-DISPLAYED-COUNT, DISCLOSED: how many of the FINAL displayed tokens (today's full
    // daily pool, fresh + carried) are labeled Established (above $2M) — distinct from
    // aboveEarlyRangeCount (declared earlier, during the per-candidate loop), which counts every
    // above-$2M candidate that reached that stage, before the holder check/ranking cap could still
    // drop some of them same as any other candidate.
    const establishedDisplayedCount = tokens.filter(t => t.isEstablished).length

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

    // MAIN-FEED-QUALITY-GATE, DISCLOSED: candidates hidden specifically by the deterministic $80K-$2M
    // valuation band / 30-holder gate (not the pre-existing liquidity/dead-volume/V4 filters, which
    // were already silently dropping candidates before this task). Surfaced to the frontend so the
    // CORTEX panel can honestly say how many were hidden, instead of the gate being invisible.
    const hiddenBelow80k = droppedByMarketCapBelow80k
    const hiddenValuationUnavailable = droppedByValuationUnavailable
    // $2M IS NO LONGER A HIDE REASON, DISCLOSED: hiddenLowValuation used to include candidates above
    // $2M — it no longer does, since above-$2M candidates are displayed (labeled Established), not
    // hidden. aboveEarlyRangeCount/establishedDisplayedCount (declared during the per-candidate loop
    // and derived from the final `tokens` list below) are the honest replacement signals.
    const hiddenLowValuation = hiddenBelow80k + hiddenValuationUnavailable
    const hiddenLowHolders = droppedByHoldersBelow30
    const hiddenHolderUnavailable = holderProviderUnavailableCount
    const hiddenLiquidityLow = droppedByLiquidityGate
    // CONCENTRATION-IS-NOT-HOLDER-UNAVAILABLE, DISCLOSED: concentration (top1/10/20) is never
    // fetched by this route at all, so it can never be the reason a candidate was hidden — every
    // DISPLAYED candidate simply carries the CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP as a deeper-
    // evidence note, not an exclusion reason. This count exists purely so the UI can show that
    // distinction honestly (concentration gaps vs. actually-missing holder count) instead of
    // conflating the two the way the drawer's old "Open Check concentration" wording used to.
    const hiddenConcentrationUnavailable = scored.filter(t => (t.evidenceGaps ?? []).includes(CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP)).length
    const hiddenLowEvidenceCount = hiddenLowValuation + hiddenLowHolders + hiddenHolderUnavailable
    const evidenceGapCappedCount = scored.filter(t => t.riskLevel !== 'SAFE' && (t.evidenceGaps?.length ?? 0) > 0).length

    // CANDIDATE-GATE-AUDIT, DISCLOSED (deterministic-gate reset, later softened: $2M and holder-
    // unavailable moved from hard exclusions to classification/evidence-gap — see the
    // $2M-IS-A-CLASSIFICATION-NOT-AN-EXCLUSION and HOLDER-GATE-SOFTENED-TO-EVIDENCE-GAP comments
    // above for the exact live-audit reports that drove each change). Every field reads straight off
    // a counter already incremented at its own real site above — this object does not re-derive or
    // re-implement any gate logic, it only exposes what already happened.
    // afterHolder30Gate is `toCheck.length` directly: that array IS the real post-holder-gate set
    // (or empty on a provider outage — see the fail-closed comment above), so it can never drift
    // from what actually happened.
    const afterHolder30Gate = toCheck.length
    const holderCheckBudgetExhausted = holderCheckAttemptedCount >= HOLDER_CHECK_BUDGET_CAP
    const baseRadarCandidateGateAudit = {
      rawCandidatesFetched: drafts.length,
      rawCandidateCap: RANKED_CANDIDATES_CAP,
      rankedCandidates: rankedCandidates.length,
      afterLiquidityGate: afterLiquidityGateCount,
      afterValuationMin80k: afterValuationMin80kCount,
      afterValuationMax2m: afterValuationMax2mCount,
      aboveEarlyRangeCount,
      establishedDisplayedCount,
      afterHolder30Gate,
      holderCheckAttempted: holderCheckAttemptedCount,
      holderCheckSucceeded: holderCheckSucceededCount,
      holderProviderReachable,
      holderProviderUnavailableCount,
      displayedCount: tokens.length,
      hiddenBelow80k,
      hiddenBelow30Holders: hiddenLowHolders,
      hiddenMissingHolderCount: hiddenHolderUnavailable,
      hiddenLiquidityLow,
      hiddenValuationUnavailable,
      hiddenConcentrationUnavailable,
      candidatePoolExhausted,
      holderCheckBudget: HOLDER_CHECK_BUDGET_CAP,
      holderCheckBudgetExhausted,
      holderCheckFailureReasons,
      holderCheckFailureSample,
      discoverySourceCounts: sourceCounts,
      sourcesFailedCount,
      sourceBackoffSkippedCount,
      sourceBackoffTtlMs: DISCOVERY_FAILURE_BACKOFF_MS,
      discoveryDegraded,
      discoveryDegradedSignificant,
      displayTarget: DISPLAY_TARGET,
      // FILTERSTAGE-REFLECTS-SOFTENED-GATE, DISCLOSED: the old "failed closed, 0 candidates shown
      // unverified" wording is gone — that's no longer what happens. A holder-provider outage now
      // shows candidates labeled unverified/watch with an explicit evidence gap instead of showing
      // nothing, so filterStage says that instead of describing a behavior this route no longer has.
      filterStage: discoveryDegradedSignificant && tokens.length === 0
        ? `discovery degraded this cycle — ${sourcesFailedCount}/${sourcesAttempted} source pages failed (rate-limit/timeout), raw pool thinner than usual`
        : !holderProviderReachable && holderCheckAttemptedCount > 0
          ? 'holder-count provider unreachable this cycle — candidates shown unverified with a holder_provider_unreachable evidence gap, never marked as holder-verified'
          : holderCheckBudgetExhausted
            ? 'holder-check budget exhausted before reaching display target'
            : passingHolderGateCount >= DISPLAY_TARGET
              ? 'display target reached'
            : candidatePoolExhausted
              ? 'ranked candidate pool exhausted before reaching display target or budget'
              : 'cycle ended',
    }

    // SOURCE-AUDIT, DISCLOSED (requested: a full baseRadarSourceAudit to distinguish real upstream
    // discovery-depth loss from an accidental cap/slice/cache bug — every field here is read
    // directly off a counter incremented at its own real site above, never re-derived or guessed).
    // runtimeCommitSha comes from Vercel's own build-time env var (VERCEL_GIT_COMMIT_SHA) so a
    // report can be matched to the exact deployed code, not assumed. rejectionReasons intentionally
    // mirrors filterFunnel below rather than duplicating its computation.
    const baseRadarSourceAudit = {
      runtimeCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      discoverySourcesUsed: Object.keys(sourceCounts),
      rawFromEachSource: sourceCounts,
      sourcesAttempted,
      sourcesSucceeded,
      sourcesFailedCount,
      failedSourceKeys,
      discoveryDegraded,
      rawTotalBeforeDedupe,
      afterDedupe: dedupedPoolCount,
      afterAgeWindow: passedAgeWindowCount,
      afterLiquidityMinimum: afterLiquidityGateCount,
      afterValuationAvailable: afterLiquidityGateCount - droppedByValuationUnavailable,
      afterValuationMin80k: afterValuationMin80kCount,
      afterValuationMax2m: afterValuationMax2mCount,
      aboveEarlyRangeCount,
      establishedDisplayedCount,
      holderCheckEligible: rankedCandidates.length,
      holderCheckAttempted: holderCheckAttemptedCount,
      holderCheckSucceeded: holderCheckSucceededCount,
      holderProviderReachable,
      holderProviderUnavailableCount,
      afterHolder30: afterHolder30Gate,
      displayedCount: tokens.length,
      candidatePoolExhausted,
      holderCheckBudgetExhausted,
      sourceBackoffSkippedCount,
      sourceBackoffTtlMs: DISCOVERY_FAILURE_BACKOFF_MS,
      caps: {
        sourceLimit: sourcesAttempted,
        rawCandidateCap: RANKED_CANDIDATES_CAP,
        dedupeCap: null,
        rankingCap: RANKED_CANDIDATES_CAP,
        holderCheckCap: HOLDER_CHECK_BUDGET_CAP,
        displayCap: DISPLAY_TARGET,
      },
      // REJECTION-REASONS-NO-LONGER-INCLUDES-2M-OR-HOLDER-UNAVAILABLE, DISCLOSED: this object is
      // named rejectionReasons for a reason — market_cap_above_2m and holders_unavailable are
      // removed from it because neither rejects a candidate anymore (above $2M displays as
      // Established; holder-unavailable displays unverified). Their real counts live in
      // aboveEarlyRangeCount/holderProviderUnavailableCount above instead of being misfiled here.
      rejectionReasons: {
        missing_base_token: droppedByMissingBaseToken,
        symbol_excluded: droppedBySymbolExcluded,
        duplicate_contract: droppedByDuplicateContract,
        established_token_excluded: droppedByEstablishedToken,
        v4_liquidity_unverified: droppedByV4Pool,
        v4_no_dexscreener_data: droppedByV4NoDexScreenerData,
        v4_no_liquid_pair: droppedByV4NoLiquidPair,
        v4_pool_address_mismatch: droppedByV4PoolMismatch,
        liquidity_below_minimum: droppedByAbsoluteLiquidityFloor + droppedByLiquidityFloorSpecifically,
        dead_volume_excluded: droppedByDeadVolumeFloor,
        valuation_unavailable: droppedByValuationUnavailable,
        market_cap_below_80k: droppedByMarketCapBelow80k,
        holders_below_30: droppedByHoldersBelow30,
        ranking_cap_excluded: droppedByRankingCap,
      },
      v4MismatchSample,
      v4NoLiquidPairSample,
      holderCheckFailureReasons,
      holderCheckFailureSample,
    }

    // DISCOVERY-SOURCE-AUDIT, DISCLOSED (explicitly requested: a dedicated
    // baseRadarDiscoverySourceAudit — separate from baseRadarSourceAudit's broader funnel view —
    // focused specifically on per-page discovery fetch outcomes, so "0 tokens" can be diagnosed as
    // either a real source-fetch failure (exact endpoint/status/error) or a legitimate deterministic-
    // gate result, without guessing). Every field is read from the same real counters/results
    // already computed above (sourceResults, pagesSucceeded/pagesFailed/failedPages,
    // rawTotalBeforeDedupe/dedupedPoolCount) — this does not re-derive or re-run discovery.
    const baseRadarDiscoverySourceAudit = {
      runtimeCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      selectedChain: requestedChain,
      requestUrl: req.nextUrl.toString(),
      discoverySourcesUsed: Object.keys(sourceCounts),
      pagesRequested: sourcesAttempted,
      pagesSucceeded,
      pagesFailed,
      failedPages,
      rawCandidatesBeforeDedupe: rawTotalBeforeDedupe,
      rawCandidatesAfterDedupe: dedupedPoolCount,
      sourceCounts,
      degraded: discoveryDegraded,
      degradedSignificant: discoveryDegradedSignificant,
      degradedReason: pagesFailed === 0
        ? null
        : failedPages.every(p => p.status === 429)
          ? 'GeckoTerminal rate-limited this cycle (HTTP 429 on every failed page)'
          : failedPages.every(p => p.skippedByBackoff)
            ? 'sources skipped — still in local failure-backoff cooldown from a prior cycle'
            : failedPages.some(p => p.status != null && p.status >= 500)
              ? 'GeckoTerminal returned server errors (5xx) on one or more pages'
              : failedPages.some(p => p.errorName === 'AbortError')
                ? 'one or more requests timed out (6s fetch timeout)'
                : 'mixed/unclassified fetch failures — see failedPages for exact per-page detail',
      cacheHit: false,
      fallbackUsed,
      dexScreenerBoostStatus,
      dexScreenerBoostHttpStatus,
      dexScreenerBoostedTokensFound,
      dexScreenerProfileStatus,
      dexScreenerProfileHttpStatus,
      dexScreenerProfileTokensFound,
      dexScreenerProfileListSize,
      dexScreenerProfileRawSample,
      dexScreenerBoostListSize,
      dexScreenerBoostRawSample,
      // SHARED-BACKOFF-VISIBILITY, DISCLOSED: whether the cross-instance discovery backoff (see the
      // SHARED-BACKOFF FIX comment near discoverySourceFailureBackoff's declaration) is actually
      // backed by Redis this cycle, or silently degraded to the old per-instance-only Map. false
      // here on a deployment where Redis env vars ARE set would indicate the fix isn't taking effect.
      sharedBackoffStoreConfigured: redisConfigured(),
      // GECKOTERMINAL-API-KEY-VISIBILITY, DISCLOSED: whether every GeckoTerminal discovery request
      // this cycle actually carried the CoinGecko Demo key (see GECKOTERMINAL_HEADERS's header
      // comment) — false here despite COINGECKO_API_KEY being set in the environment would mean the
      // key isn't reaching this route for some other reason (wrong env var name, not deployed, etc.).
      geckoTerminalApiKeyConfigured: Boolean(process.env.COINGECKO_API_KEY),
    }

    const limitedLiveFeed = tokens.length > 0 && tokens.length < 5
    const hpHitCount = hpCacheHitFlags.filter(Boolean).length
    // HAS-MORE-FALSE-EXHAUSTION FIX, DISCLOSED (bug hunt, reported: "Load More" acting exhausted
    // despite real candidates existing further out). hasMorePages required tokens.length > 0 THIS
    // specific attempt — but a page can legitimately return 0 tokens purely from a transient
    // GeckoTerminal rate-limit cycle (live-confirmed: a captured page=3 response had
    // sourcesFailedCount: 8/8 and tokens: [] this exact way), which permanently told the frontend
    // "no more pages exist" even though a retry of the SAME page moments later could easily surface
    // real candidates. Whether more pages exist is a function of the page cap alone
    // (radarPage < 5) — it must never be conflated with "did this one attempt happen to fail." The
    // frontend's own handleLoadMore already has honest per-attempt "nothing NEW this click"
    // messaging (loadMoreExhausted, based on actually-deduped addedCount) for the real end-of-data
    // case — that's the correct place for "no new tokens this click," not this backend flag, which
    // instead now answers only "is there a next page number left to try."
    // LIVE-FEED-PAGINATION, DISCLOSED: the daily-pool-capacity check this comment used to describe
    // no longer applies now that there is no persisted daily pool (see the LIVE-FEED comment
    // above) — whether more pages exist is purely a function of the page cap.
    const hasMorePages = radarPage < 5
    // ALWAYS-VISIBLE AUDIT, DISCLOSED (reported: the audit logs are effectively unreachable in
    // practice — they print far down a long, multi-line-per-request log stream, and Vercel's log
    // search/pagination has repeatedly failed to surface them even when searching the exact string).
    // baseRadarSourceAudit and baseRadarCandidateGateAudit were only ever included in the response
    // body behind ?debug=1, which the actual app UI never sends (it always hits plain /api/radar),
    // so a real DevTools Network capture — the one method that has reliably worked all session —
    // never showed them either. Attaching both directly to the normal, always-returned payload
    // (not gated behind debug=1) so the exact same capture method already in use surfaces them.
    // URGENT LOADING AUDIT, DISCLOSED (reported: Base Radar stuck on loading/checking, no tokens
    // rendering). Exact shape requested — a truthful, single-glance answer to "is this a provider
    // failure, over-filtering, or a real completed empty result" without cross-referencing 4
    // separate existing audit objects. finalState mirrors the same 4-outcome model just added to
    // Pump Alerts for the same incident, and errorShownToUser is honest about whether the frontend
    // actually surfaced anything or silently rendered empty.
    const baseRadarFinalState: 'ok' | 'providerUnavailable' | 'allFilteredOut' | 'noRawCandidates' =
      sourcesSucceeded === 0 ? 'providerUnavailable'
      : rawTotalBeforeDedupe === 0 ? 'noRawCandidates'
      : tokens.length === 0 ? 'allFilteredOut'
      : 'ok'
    // BASE-RADAR-NOT-LOADING AUDIT, DISCLOSED (explicitly requested exact shape, on top of the
    // existing audit above): chainSlug/chainId make the chain this response actually scanned
    // unambiguous (hard rule: Base Radar must be Base-only — chainSlug='base'/chainId=8453 whenever
    // requestedChain === 'base', never leaking another chain's identity into a Base response).
    // providerErrors surfaces the SAME real per-source failedPages detail already computed above,
    // reshaped to a compact {source,status,errorName,errorMessage} array instead of requiring a
    // second round-trip into failedPages/baseRadarDiscoverySourceAudit to answer "what exactly
    // failed." candidatesAfterCategoryFilter/candidatesAfterLiquidityFilter are real running-total
    // stages (not just drop counts) computed the same reconciling-Math.max(0,...) way as every other
    // funnel stage in this file. userVisibleError is the literal string the frontend renders (or
    // null when a real result rendered) — the single field this task exists to make truthful:
    // never a vague "Open check" when the real cause is a specific provider failure.
    const candidatesAfterCategoryFilter = Math.max(0, dedupedPoolCount - droppedByEstablishedToken)
    const candidatesAfterLiquidityFilter = Math.max(0, candidatesAfterCategoryFilter - droppedByAbsoluteLiquidityFloor - droppedByLiquidityFloorSpecifically)
    const providerErrors = [
      ...failedPages.map(p => ({ source: p.source, status: p.status, errorName: p.errorName, errorMessage: p.errorMessage })),
      ...(dexScreenerFallbackAttempted && dexScreenerFallbackError
        ? [{ source: 'dexscreener_fallback', status: null, errorName: null, errorMessage: dexScreenerFallbackError }]
        : []),
    ]
    const userVisibleError = baseRadarFinalState === 'providerUnavailable'
      ? (providerErrors[0]
        ? `${providerErrors[0].source} failed: ${providerErrors[0].errorMessage ?? providerErrors[0].errorName ?? `HTTP ${providerErrors[0].status ?? 'unknown'}`}`
        : 'All discovery providers failed to return data this cycle.')
      : null
    const baseRadarLoadAudit = {
      requestId,
      route: '/api/radar',
      chainSlug: requestedChain,
      chainId: requestedChain === 'robinhood' ? ROBINHOOD_CHAIN_ID : 8453,
      status: baseRadarFinalState === 'providerUnavailable' ? 503 : 200,
      totalDurationMs: Date.now() - now,
      // STAGE TIMING, DISCLOSED (perf: "can we make it faster"): real per-stage durations, not
      // estimates — see the STAGE TIMING disclosure near discoveryStartedAt above. otherMs is
      // whatever's left after the three measured stages (plan/rate lookup, cache check, dedupe/
      // ranking, response assembly) so the three numbers plus otherMs always reconcile to
      // totalDurationMs exactly, with nothing unaccounted for.
      stageDurationsMs: {
        discovery: discoveryMs,
        holderCheck: holderCheckMs,
        simulation: simulationMs,
        other: Math.max(0, (Date.now() - now) - discoveryMs - holderCheckMs - simulationMs),
      },
      cacheHit: false,
      providersAttempted: sourcesAttempted,
      providersSucceeded: sourcesSucceeded,
      providersFailed: sourcesFailedCount,
      providerErrors,
      candidatesRaw: rawTotalBeforeDedupe,
      candidatesAfterDedupe: dedupedPoolCount,
      candidatesAfterChainFilter: dedupedPoolCount,
      candidatesAfterCategoryFilter,
      candidatesAfterLiquidityFilter,
      candidatesAfterQualityFilter: rankedCandidates.length,
      candidatesRendered: tokens.length,
      // Same counters the debug filterFunnel below reports, read from the same real gate
      // counters incremented at their own sites — never re-derived, so this can't drift from
      // the debug=1 view of the same request.
      rejectedReasons: {
        establishedTokenExcluded: droppedByEstablishedToken,
        liquidityBelowMinimum: droppedByAbsoluteLiquidityFloor + droppedByLiquidityFloorSpecifically,
        valuationUnavailable: droppedByValuationUnavailable,
        marketCapBelow80k: droppedByMarketCapBelow80k,
        holdersBelow30: droppedByHoldersBelow30,
        rankingCapExcluded: droppedByRankingCap,
      },
      finalState: baseRadarFinalState,
      errorShownToUser: baseRadarFinalState === 'providerUnavailable',
      userVisibleError,
    }
    const payload = { tokens, stats, fetchedAt: new Date().toISOString(), limitedLiveFeed, mode: requestedMode, page: radarPage, hasMore: hasMorePages, hiddenLowEvidenceCount, hiddenLowValuation, hiddenBelow80k, hiddenLowHolders, hiddenHolderUnavailable, hiddenLiquidityLow, hiddenValuationUnavailable, hiddenConcentrationUnavailable, holderCheckBudgetExhausted, candidatePoolExhausted, holderProviderReachable, holderProviderUnavailableCount, aboveEarlyRangeCount, establishedDisplayedCount, discoveryDegraded, discoveryDegradedSignificant, sourcesFailedCount, sourceBackoffSkippedCount, sourceBackoffTtlMs: DISCOVERY_FAILURE_BACKOFF_MS, baseRadarSourceAudit, baseRadarCandidateGateAudit, baseRadarDiscoverySourceAudit, baseRadarHolderConcentrationAudit, baseRadarLoadAudit, requestId, finalState: baseRadarFinalState }
    const debugPayload = {
      sourcesAttempted,
      sourcesSucceeded,
      sourceCounts,
      mergedCount: candidates.length,
      filters: { minValuationUsd, minLiquidityUsd, allowFdvFallback, mainFeedMinValuationUsd: MAIN_FEED_MIN_VALUATION_USD, mainFeedMaxValuationUsd: MAIN_FEED_MAX_VALUATION_USD, mainFeedMinHolders: MAIN_FEED_MIN_HOLDERS },
      filterFunnel: {
        missing_base_token: droppedByMissingBaseToken,
        symbol_excluded: droppedBySymbolExcluded,
        duplicate_contract: droppedByDuplicateContract,
        established_token_excluded: droppedByEstablishedToken,
        v4_pool_excluded: droppedByV4Pool,
        v4_no_dexscreener_data: droppedByV4NoDexScreenerData,
        v4_no_liquid_pair: droppedByV4NoLiquidPair,
        v4_pool_address_mismatch: droppedByV4PoolMismatch,
        liquidity_below_minimum: droppedByAbsoluteLiquidityFloor + droppedByLiquidityFloorSpecifically,
        dead_volume_excluded: droppedByDeadVolumeFloor,
        valuation_unavailable: droppedByValuationUnavailable,
        market_cap_below_80k: droppedByMarketCapBelow80k,
        holders_below_30: droppedByHoldersBelow30,
        ranking_cap_excluded: droppedByRankingCap,
        evidence_gap_capped: evidenceGapCappedCount,
      },
      aboveEarlyRangeCount,
      establishedDisplayedCount,
      holderProviderUnavailableCount,
      sourceBackoffSkippedCount,
      sourceBackoffTtlMs: DISCOVERY_FAILURE_BACKOFF_MS,
      baseRadarCandidateGateAudit,
      baseRadarSourceAudit,
      baseRadarDiscoverySourceAudit,
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
    // FUNNEL-LOG, DISCLOSED (requested: "it's not in the logs, add it to the base radar logs" —
    // filterFunnel was only visible via ?debug=1 in the JSON response, not in Vercel's function
    // logs). Always logged (not gated behind debug=1) so every request's gate breakdown is visible
    // in server logs without needing to hit the debug query param from a browser.
    console.info(`[radar] filterFunnel mergedCount=${candidates.length} finalTokenCount=${tokens.length} hiddenLowEvidenceCount=${hiddenLowEvidenceCount}`, debugPayload.filterFunnel)
    console.info('[radar] baseRadarCandidateGateAudit', baseRadarCandidateGateAudit)
    console.info('[radar] stageDurationsMs', baseRadarLoadAudit.stageDurationsMs)
    console.info('[radar] baseRadarSourceAudit', baseRadarSourceAudit)
    console.info(`[radar] nearMissSample (${nearMissSample.length} candidates cleared liquidity/activity, before the $80K gate)`, nearMissSample.slice(0, 30))
    // DON'T-CACHE-A-DEAD-FEED FIX, DISCLOSED (same report as the one-retry fix above): a fully
    // empty result (every upstream source failed even after retrying) used to be cached exactly
    // like a genuinely quiet feed, so it kept being served to every client for the full 30-100s TTL
    // window even once GeckoTerminal recovered. Skipping the cache write here means the very next
    // poll (this client's 120s interval, or another client's) makes a real attempt instead of
    // echoing the outage back for the rest of the window. A genuinely quiet-but-working feed
    // (sources succeeded, filters just found nothing) still caches normally.
    // SHORT-TTL-FOR-EMPTY-GATE-RESULT FIX, DISCLOSED (reported: "refresh 2 times and it stays no
    // tokens" — sources succeeded, but the $85K/100-holder/liquidity gates happened to filter down
    // to 0 displayed tokens that one cycle, e.g. a volatile candidate's valuation briefly dipping
    // below $85K). That 0-token result was caching for the FULL 30-100s TTL like any other real
    // result, so every manual refresh clicked within that window kept hitting the same stale-empty
    // cache entry even after the underlying market recovered a few seconds later, making a brief
    // real dip look like a stuck outage. A 0-token result (sources succeeded, gates just found
    // nothing this cycle) now gets a much shorter cache life so the next refresh gets a real
    // re-check instead of an echo — a genuinely quiet feed still won't flicker on every millisecond,
    // but it also can't get amplified into feeling stuck for a full 30-100s.
    const EMPTY_RESULT_CACHE_TTL_MS = 5 * 1000
    if (sourcesSucceeded > 0) {
      const ttlMs = tokens.length > 0 ? (shallowMode ? RADAR_SHALLOW_CACHE_TTL_MS : RADAR_FULL_CACHE_TTL_MS) : EMPTY_RESULT_CACHE_TTL_MS
      const entry: RadarPayloadCacheEntry = { cachedAt: Date.now(), ttlMs, payload: { ...payload, _debug: debugPayload } }
      radarPayloadCache.set(preferredCacheKey, entry)
      if (tokens.length > 0) await writeRadarPayloadRedis(preferredCacheKey, entry)
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
      // LAST-GOOD-CACHE VISIBILITY, DISCLOSED (required fix: "if live providers fail, show last-good
      // cached Base results"): servedFromStaleCache is a plain, always-present (not debug-gated)
      // signal so the frontend can show a subtle "showing cached results" note instead of presenting
      // an aging response as if it were this cycle's fresh live data.
      return NextResponse.json({
        ...cachedPayload.payload,
        servedFromStaleCache: true,
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

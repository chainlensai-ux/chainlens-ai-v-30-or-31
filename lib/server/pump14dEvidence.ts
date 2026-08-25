// PUMP 14-DAY EVIDENCE LADDER, DISCLOSED (urgent fix request): Pump Alerts went dark whenever
// GeckoTerminal's OHLCV endpoint failed — every candidate was dropped as `missing14dData` and the
// page rendered "0 results" even though plenty of valid low-cap movers were sitting right there in
// the discovery pools. One provider failure must never kill the whole feed.
//
// This module resolves 14-day pump evidence through a strict priority ladder:
//   1. geckoterminal_ohlcv   — real daily candles, close-to-close 14d change (exact grade)
//   2. dexscreener_momentum  — pair priceChange/volume data; NEVER produces a fake 14d number,
//                              only a labelled momentum-fallback qualification
//   3. coingecko_contract    — CoinGecko's per-contract market data (real 14d percentage, exact
//                              grade) — only usable where CoinGecko indexes the chain (Base/Ethereum)
//                              and only trusted because the response is keyed by the contract
//                              address itself, so token identity + chain are verified by construction
//   4. internal_snapshot     — ChainLens-owned price snapshots taken on every refresh cycle;
//                              yields a real measured change once enough history exists
//
// Hard rules enforced here (mirrored from the fix request):
// - No fabricated 14d numbers: a momentum fallback sets change14d = null and carries its own
//   evidence label instead.
// - Majors/stables/wrapped assets stay blocked: the fallback evaluator runs ON TOP of the existing
//   Stage 1 gate, never instead of it — category denylist, low-cap ceilings, liquidity/volume
//   floors and age checks all still apply before any fallback can qualify anything.
// - Nothing passes silently: every tier attempt is counted in Pump14dEvidenceAudit.

import { createServiceRoleClient } from '@/lib/supabase/userSettings'

// ─── Env-configurable knobs (defaults per the fix request) ──────────────────────────────────────
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

/** Require a real measured 14d change before showing any candidate. */
export const PUMP_REQUIRE_EXACT_14D = envBool('PUMP_ALERT_REQUIRE_EXACT_14D', false)
/** Minimum 24h % change for a candidate to qualify via momentum fallback. */
export const PUMP_MIN_24H_CHANGE_FALLBACK_PCT = envNumber('PUMP_ALERT_MIN_24H_CHANGE_FALLBACK_PCT', 15)
/** Minimum volume acceleration ((h6 × 4) ÷ h24) required by momentum fallback. */
export const PUMP_MIN_VOLUME_ACCELERATION = envNumber('PUMP_ALERT_MIN_VOLUME_ACCELERATION', 1.5)
/** Master switch for momentum fallback mode. */
export const PUMP_ALLOW_MOMENTUM_FALLBACK = envBool('PUMP_ALERT_ALLOW_MOMENTUM_FALLBACK', true)

export type PumpChainSlug = 'base' | 'eth' | 'robinhood'

export type FourteenDayEvidenceSource =
  | 'geckoterminal_ohlcv'
  | 'coingecko_contract'
  | 'internal_snapshot'
  | 'dexscreener_momentum'

export type MomentumFallbackInput = {
  /** Candidate's own-chain 24h % change from the GeckoTerminal pools list. */
  change24hPct: number | null
  /** Candidate's 24h USD volume (pool-level). */
  volume24hUsd: number | null
  /** Candidate's pool liquidity in USD. */
  liquidityUsd: number | null
  /** DexScreener pair-derived values (may be null when DexScreener itself failed). */
  dexscreener: {
    priceChange24hPct: number | null
    priceChange6hPct: number | null
    priceChange1hPct: number | null
    volume24hUsd: number | null
    volume6hUsd: number | null
    liquidityUsd: number | null
    priceUsd: number | null
    // MARKET-CAP VERIFICATION FIX, DISCLOSED: DexScreener's own pair payload reports marketCap/fdv
    // directly (real, provider-computed values — never derived here). Optional so existing callers
    // that don't need them (evaluateMomentumFallback ignores these) stay unaffected.
    marketCapUsd?: number | null
    fdvUsd?: number | null
  } | null
}

export type MomentumFallbackVerdict =
  | {
      qualified: true
      /** Best corroborated 24h figure across providers — displayed honestly AS a 24h figure. */
      confirmedChange24hPct: number
      volumeAcceleration: number | null
      evidenceParts: string[]
    }
  | { qualified: false; reason: string }

/**
 * Decide whether a candidate qualifies via momentum fallback. Pure — unit-testable without mocks.
 *
 * Every axis must be backed by real observed data; a missing value fails that axis rather than
 * silently passing ("do NOT silently pass missing data"). The two hard axes are:
 *  - a ≥15% 24h move, corroborated when both GT and DexScreener report it (the weaker single
 *    reading alone can qualify ONLY if the other provider simply has no data — a CONTRADICTORY
 *    reading from the other provider disqualifies);
 *  - volume expansion ≥ 1.5× (current 6h rate projected to 24h vs trailing 24h volume).
 */
export function evaluateMomentumFallback(input: MomentumFallbackInput): MomentumFallbackVerdict {
  if (!PUMP_ALLOW_MOMENTUM_FALLBACK) return { qualified: false, reason: 'fallbackDisabledByConfig' }

  // ── Axis 1: strong positive 24h momentum ────────────────────────────────────────
  const gtMove = input.change24hPct
  const dsMove = input.dexscreener?.priceChange24hPct ?? null
  let confirmedMove: number | null = null
  if (gtMove != null && dsMove != null) {
    // Both providers have data — they must AGREE on direction and rough magnitude. Agreement band:
    // both ≥ threshold, and neither contradicts the story (one ≥ +15% while the other deeply
    // negative would mean one of the readings describes something else entirely).
    const bothUp = Math.min(gtMove, dsMove)
    if (bothUp < PUMP_MIN_24H_CHANGE_FALLBACK_PCT) {
      return { qualified: false, reason: 'moveBelowFallbackThreshold' }
    }
    confirmedMove = bothUp // conservative: the weaker of the two agreeing readings
  } else {
    // Only one provider reported — accept it if it clears the bar, reject if it doesn't.
    const solo = gtMove ?? dsMove
    if (solo == null || solo < PUMP_MIN_24H_CHANGE_FALLBACK_PCT) {
      return { qualified: false, reason: solo == null ? 'noMoveDataFromAnyProvider' : 'moveBelowFallbackThreshold' }
    }
    confirmedMove = solo
  }

  // ── Axis 2: volume expansion ≥ configured multiplier ────────────────────────────
  const v24 = input.volume24hUsd ?? input.dexscreener?.volume24hUsd ?? null
  const v6 = input.dexscreener?.volume6hUsd ?? null
  if (v24 == null || v6 == null || v24 <= 0) {
    return { qualified: false, reason: 'volumeAccelerationUnmeasurable' }
  }
  const acceleration = (v6 * 4) / v24
  if (!Number.isFinite(acceleration) || acceleration < PUMP_MIN_VOLUME_ACCELERATION) {
    return { qualified: false, reason: 'volumeNotAccelerating' }
  }

  // ── Axis 3: real liquidity behind the move (Stage 1 floor, restated defensively here because a
  // DexScreener liquidity figure being present is also what makes the pair "verified") ──
  const liq = input.liquidityUsd ?? input.dexscreener?.liquidityUsd ?? null
  if (liq == null || liq <= 0) {
    return { qualified: false, reason: 'noLiquidityEvidence' }
  }

  const evidenceParts = [
    `confirmed 24h move ≥ ${confirmedMove.toFixed(1)}%`,
    `volume accelerating ${(acceleration).toFixed(1)}×`,
    `$${(liq / 1000).toFixed(0)}K live liquidity`,
  ]
  return { qualified: true, confirmedChange24hPct: confirmedMove, volumeAcceleration: acceleration, evidenceParts }
}

// ─── DexScreener pair fallback ──────────────────────────────────────────────────────────────────
export type DexScreenerMomentumResult = {
  ok: boolean
  data: MomentumFallbackInput['dexscreener']
} | null

// ONE-RETRY 429-AWARE FIX, DISCLOSED (reported live: Pump Alerts blacked out with "no fallback
// provider could confirm momentum either" — this is the tier specifically meant to rescue a
// GeckoTerminal OHLCV outage, so it failing too with zero retry compounded the same rate-limit
// burst into a total ladder failure instead of an honest empty market). Mirrors the same
// 429-aware backoff already applied to the primary GT OHLCV fetch above.
async function fetchDexScreenerPairMomentumOnce(pairAddress: string, signal: AbortSignal): Promise<DexScreenerMomentumResult & { httpStatus?: number }> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${pairAddress}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    })
    if (!res.ok) return { ok: false, data: null, httpStatus: res.status }
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    const pair = (json?.pair ?? Array.isArray(json?.pairs) ? (json?.pairs as unknown[])[0] : null) as Record<string, unknown> | null
    if (!pair || typeof pair !== 'object') return { ok: false, data: null }
    const pc = pair.priceChange as Record<string, unknown> | undefined
    const vol = pair.volume as Record<string, unknown> | undefined
    const num = (v: unknown): number | null => {
      const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
      return Number.isFinite(n) ? n : null
    }
    return {
      ok: true,
      data: {
        priceChange24hPct: num(pc?.h24),
        priceChange6hPct: num(pc?.h6),
        priceChange1hPct: num(pc?.h1),
        volume24hUsd: num(vol?.h24),
        volume6hUsd: num(vol?.h6),
        liquidityUsd: (() => {
          const liq = pair.liquidity as Record<string, unknown> | undefined
          return num(liq?.usd)
        })(),
        priceUsd: num(pair.priceUsd),
        // MARKET-CAP VERIFICATION FIX, DISCLOSED: DexScreener reports marketCap and fdv directly on
        // the pair object — a real, provider-computed value, not something derived here.
        marketCapUsd: num(pair.marketCap),
        fdvUsd: num(pair.fdv),
      },
    }
  } catch {
    return { ok: false, data: null }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// SUSTAINED-RATE-LIMIT FIX, DISCLOSED (reported live: total blackout persisted across repeated
// refreshes even after the 429-aware retry landed — a single retry only survives one short burst,
// not a sustained exhaustion caused by every refresh cycle re-fetching from scratch with no cache).
// Momentum data moves faster than 14d OHLCV, so this cache is short — 2 minutes, roughly one refresh
// cycle — just enough to stop back-to-back auto-refreshes (and other users' concurrent requests)
// from re-issuing the identical burst before the rate limit has any chance to recover.
const DEXSCREENER_MOMENTUM_CACHE_TTL_MS = 2 * 60 * 1000
const dexScreenerMomentumCache = new Map<string, { result: DexScreenerMomentumResult; cachedAt: number }>()

export async function fetchDexScreenerPairMomentum(pairAddress: string, signal: AbortSignal): Promise<DexScreenerMomentumResult> {
  const cacheKey = pairAddress.toLowerCase()
  const cached = dexScreenerMomentumCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < DEXSCREENER_MOMENTUM_CACHE_TTL_MS) return cached.result

  const first = await fetchDexScreenerPairMomentumOnce(pairAddress, signal)
  let final: DexScreenerMomentumResult = first
  if (!first.ok) {
    const retryDelayMs = first.httpStatus === 429 ? 1800 + Math.floor(Math.random() * 400) : 400
    await sleep(retryDelayMs)
    if (!signal.aborted) {
      const second = await fetchDexScreenerPairMomentumOnce(pairAddress, signal)
      final = { ok: second.ok, data: second.data }
    }
  }
  if (final?.ok) dexScreenerMomentumCache.set(cacheKey, { result: final, cachedAt: Date.now() })
  return final
}

// ─── CoinGecko per-contract exact 14d (identity verified by construction) ────────────────────────
const COINGECKO_PLATFORM_BY_CHAIN: Partial<Record<PumpChainSlug, string>> = {
  base: 'base',
  eth: 'ethereum',
  // Robinhood Chain is not indexed by CoinGecko — the tier is skipped there, honestly.
}

export type CoinGeckoContractLookup = { change14d: number | null; marketCapUsd: number | null }

// MARKET-CAP VERIFICATION FIX, DISCLOSED (requested: "make marketcaps working so it verifies it and
// works"). GeckoTerminal's pool `market_cap_usd` is null for most fresh pump tokens (no verified
// circulating supply), which is why cards were showing "MCap unavailable" so often. This function
// already fetches CoinGecko's full per-contract payload to read the 14d change — its market_data
// also carries a real, CoinGecko-verified market_cap.usd for any token CoinGecko has indexed. Reading
// it here is zero extra network cost (same response, same identity-verified contract match) and is a
// second REAL provider, never a computed/derived guess — so it stays honest with the "do not fake
// market cap" rule while actually filling the field more often. Returns null for either field when
// CoinGecko doesn't have it (still-unindexed tokens, or Robinhood Chain which CoinGecko doesn't
// track at all) — the caller keeps showing "MCap unavailable" in that case, exactly as before.
export async function fetchCoinGeckoContractChange14d(chain: PumpChainSlug, contract: string, signal: AbortSignal): Promise<CoinGeckoContractLookup> {
  const platform = COINGECKO_PLATFORM_BY_CHAIN[chain]
  if (!platform) return { change14d: null, marketCapUsd: null }
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${encodeURIComponent(contract)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    })
    if (!res.ok) return { change14d: null, marketCapUsd: null }
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    if (!json || typeof json !== 'object') return { change14d: null, marketCapUsd: null }
    // Identity verification: CoinGecko resolves BY platform+contract, so a hit is inherently the
    // right token on the right chain. Guard anyway against odd proxy responses.
    const platforms = (json.platforms ?? json.detail_platforms) as Record<string, unknown> | undefined
    if (platforms && typeof platforms === 'object') {
      const addr = platforms[platform]
      if (typeof addr === 'string' && addr.toLowerCase() !== contract.toLowerCase()) return { change14d: null, marketCapUsd: null }
    }
    const md = json.market_data as Record<string, unknown> | undefined
    // 14-DAY WINDOW, DISCLOSED: CoinGecko's market_data carries a genuine price_change_percentage_14d
    // field alongside its 7d one — this reads the 14d field specifically, not the 7d value
    // relabelled. Reading the 7d field here would make the 'exact' evidence grade a lie for this
    // tier: it would claim a 14-day close-to-close change while actually reporting a 7-day one.
    const ch14d = md?.price_change_percentage_14d
    const ch14dN = typeof ch14d === 'number' && Number.isFinite(ch14d) ? ch14d : NaN
    const marketCapUsdRaw = (md?.market_cap as Record<string, unknown> | undefined)?.usd
    const marketCapN = typeof marketCapUsdRaw === 'number' && Number.isFinite(marketCapUsdRaw) && marketCapUsdRaw > 0 ? marketCapUsdRaw : NaN
    return {
      change14d: Number.isFinite(ch14dN) ? ch14dN : null,
      marketCapUsd: Number.isFinite(marketCapN) ? marketCapN : null,
    }
  } catch {
    return { change14d: null, marketCapUsd: null }
  }
}

// ─── Internal snapshot store (ChainLens-owned 14d change over time) ──────────────────────────────
export type PumpSnapshotRow = {
  chain: PumpChainSlug
  contract: string
  pair_address: string | null
  price_usd: number | null
  liquidity_usd: number | null
  volume_24h_usd: number | null
  fdv_usd: number | null
  market_cap_usd: number | null
  captured_at: string
}

// In-process ring buffer so history builds even when Supabase isn't configured. Keyed
// chain:contract → array of snapshots (oldest first), capped per key.
const SNAPSHOT_MEMORY_CAP_PER_KEY = 40
const snapshotMemory = new Map<string, PumpSnapshotRow[]>()

function snapshotKey(chain: PumpChainSlug, contract: string): string {
  return `${chain}:${contract.toLowerCase()}`
}

export async function savePumpSnapshots(rows: PumpSnapshotRow[]): Promise<{ persisted: boolean; savedCount: number }> {
  for (const row of rows) {
    const key = snapshotKey(row.chain, row.contract)
    const arr = snapshotMemory.get(key) ?? []
    arr.push(row)
    if (arr.length > SNAPSHOT_MEMORY_CAP_PER_KEY) arr.splice(0, arr.length - SNAPSHOT_MEMORY_CAP_PER_KEY)
    snapshotMemory.set(key, arr)
  }
  // Best-effort durable persistence — a missing/unwritable table degrades to memory-only and is
  // reported in the audit, never thrown into the request path.
  try {
    const admin = createServiceRoleClient()
    if (!admin) return { persisted: false, savedCount: rows.length }
    const { error } = await admin.from('pump_alert_snapshots').insert(rows)
    if (error) return { persisted: false, savedCount: rows.length }
    return { persisted: true, savedCount: rows.length }
  } catch {
    return { persisted: false, savedCount: rows.length }
  }
}

/**
 * Compute a ChainLens-owned change over the longest snapshot window available (up to ~14 days).
 * Returns a real measured number only when the window spans at least MIN_SNAPSHOT_SPAN_DAYS —
 * a shorter window is returned as null (too little history is NOT quietly treated as 14d).
 */
export async function computeSnapshotChange14d(chain: PumpChainSlug, contract: string, now = Date.now()): Promise<{
  changePct: number | null
  spanDays: number | null
}> {
  const key = snapshotKey(chain, contract)
  const arr = snapshotMemory.get(key) ?? []
  // 14-DAY WINDOW, DISCLOSED: raised from 5/10 to 12/17 alongside the route-wide 14d->14d change —
  // a 5-day-apart pair of snapshots was already a stretch to label "14d"; labelling it "14d" would
  // be outright wrong. 12 days minimum span, allowing the newest snapshot to be up to 17 days old.
  const MIN_SNAPSHOT_SPAN_DAYS = 12
  const MAX_SNAPSHOT_AGE_DAYS = 17
  if (arr.length < 2) return { changePct: null, spanDays: null }
  const sorted = [...arr].sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at))
  const oldest = sorted[0]
  const newest = sorted[sorted.length - 1]
  const spanDays = (Date.parse(newest.captured_at) - Date.parse(oldest.captured_at)) / 86_400_000
  const ageDays = (now - Date.parse(newest.captured_at)) / 86_400_000
  if (spanDays < MIN_SNAPSHOT_SPAN_DAYS || ageDays > MAX_SNAPSHOT_AGE_DAYS) return { changePct: null, spanDays }
  if (oldest.price_usd == null || newest.price_usd == null || oldest.price_usd <= 0) return { changePct: null, spanDays }
  return { changePct: ((newest.price_usd - oldest.price_usd) / oldest.price_usd) * 100, spanDays }
}

/** Test hook: clear the in-memory snapshot store. */
export function _resetSnapshotMemoryForTest(): void {
  snapshotMemory.clear()
}

/** Test hook: seed the in-memory snapshot store directly (bypasses Supabase). */
export function _seedSnapshotMemoryForTest(rows: PumpSnapshotRow[]): void {
  for (const row of rows) {
    const key = snapshotKey(row.chain, row.contract)
    const arr = snapshotMemory.get(key) ?? []
    arr.push(row)
    snapshotMemory.set(key, arr)
  }
}

// ─── Request-level evidence audit ───────────────────────────────────────────────────────────────
export interface Pump14dEvidenceAudit {
  requestId: string
  candidatesRaw: number
  geckoOhlcvAttempted: number
  geckoOhlcvSucceeded: number
  geckoOhlcvFailed: number
  // REQUEST-BUDGET CAP, DISCLOSED: only the top-N candidates by volume get a live OHLCV request per
  // cycle (see FOURTEEN_DAY_OHLCV_BUDGET_CAP in route.ts) — the rest go straight to the fallback
  // ladder. Counted separately from geckoOhlcvFailed since skipping-by-design is not a provider
  // failure and must never be mistaken for one in the outage detector.
  geckoOhlcvSkippedBudget: number
  dexScreenerFallbackAttempted: number
  dexScreenerFallbackSucceeded: number
  coinGeckoFallbackAttempted: number
  coinGeckoFallbackSucceeded: number
  internalSnapshotFallbackAttempted: number
  internalSnapshotFallbackSucceeded: number
  exact14dQualified: number
  fallbackMomentumQualified: number
  excludedMissingAllMomentumEvidence: number
  finalRenderedCount: number
  degradedMode: boolean
  degradedReason: string | null
}

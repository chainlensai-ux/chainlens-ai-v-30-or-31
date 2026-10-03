// lib/radarDiscoveryResilience.ts — pure decisions for Radar discovery under provider failure.
//
// Why this exists (Robinhood Radar outage, Oct 2026): a Robinhood refresh landing inside the 20s
// per-source cooldown saw every GeckoTerminal page return `backoff_skip`, had no non-GeckoTerminal
// source, and no usable stale payload — so the feed rendered 0 tokens with an internal cooldown
// message. These helpers keep every existing protection (backoff, pacing, retries) and decide:
//   - how a failure is classified (and remembered as the backoff's origin),
//   - how many GeckoTerminal pages each chain spends,
//   - whether one manual recovery probe is allowed,
//   - whether the response is live, last-verified (stale) or an honest empty state.
// No I/O here; app/api/radar/route.ts does the fetching.

export type RadarChainSlug = 'base' | 'robinhood'

export type RadarSourceFailureClass =
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_5xx'
  | 'provider_http_error'
  | 'network_error'
  | 'backoff_skip'

/** Cycle-level outcome classes in addition to per-page failures. */
export type RadarDiscoveryOutcomeClass = RadarSourceFailureClass | 'genuine_empty_page' | 'filtered_to_zero' | 'ok'

export function classifyRadarSourceFailure(input: { status: number | null; errorName: string | null; skippedByBackoff?: boolean }): RadarSourceFailureClass {
  if (input.skippedByBackoff || input.errorName === 'backoff_skip') return 'backoff_skip'
  if (input.status === 429) return 'provider_rate_limited'
  if (input.status != null && input.status >= 500) return 'provider_5xx'
  if (input.status != null) return 'provider_http_error'
  if (input.errorName === 'AbortError' || input.errorName === 'TimeoutError') return 'provider_timeout'
  return 'network_error'
}

// ─── Backoff records ───────────────────────────────────────────────────────────────────────────
// Previously the shared backoff stored only `until`, so a skipped page could never say WHY it was
// cooling down. The record keeps the original failure; a bare number (pre-existing Redis/memory
// values) is still read as a record with an unknown origin.
export type RadarBackoffRecord = { until: number; status: number | null; failureClass: RadarSourceFailureClass | 'unknown'; setAt: number | null }

export function decodeRadarBackoff(value: unknown): RadarBackoffRecord | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { until: value, status: null, failureClass: 'unknown', setAt: null }
  if (value && typeof value === 'object') {
    const v = value as Partial<RadarBackoffRecord>
    if (typeof v.until !== 'number' || !Number.isFinite(v.until)) return null
    return {
      until: v.until,
      status: typeof v.status === 'number' ? v.status : null,
      failureClass: typeof v.failureClass === 'string' ? v.failureClass as RadarBackoffRecord['failureClass'] : 'unknown',
      setAt: typeof v.setAt === 'number' ? v.setAt : null,
    }
  }
  return null
}

// ─── Per-chain GeckoTerminal budget ───────────────────────────────────────────────────────────
// Base keeps its wide discovery. Robinhood is a much smaller market whose deeper GeckoTerminal pages
// are routinely empty (see the EMPTY-PAGE note in route.ts): 4 calls instead of 8 per cycle halves its
// share of the shared GeckoTerminal budget without changing any quality gate.
export type RadarDiscoveryBudget = { newPoolsPages: number; trendingPages: number; volumePages: number }
export function radarDiscoveryBudget(chain: RadarChainSlug): RadarDiscoveryBudget {
  return chain === 'robinhood'
    ? { newPoolsPages: 2, trendingPages: 1, volumePages: 1 }
    : { newPoolsPages: 4, trendingPages: 2, volumePages: 2 }
}

// ─── Manual recovery probe ────────────────────────────────────────────────────────────────────
/**
 * One probe, only on an explicit manual Refresh, only when EVERY primary page is cooling down, and
 * never when any of those cooldowns came from a 429 (provider protection wins). The caller still has to
 * take the shared probe lock, so concurrent users cannot each probe.
 */
export function chooseRadarRecoveryProbe(input: {
  manual: boolean
  primaryKeys: string[]
  backoffs: Record<string, RadarBackoffRecord | null>
  now: number
}): string | null {
  if (!input.manual || input.primaryKeys.length === 0) return null
  const active = input.primaryKeys.map(k => input.backoffs[k]).filter((b): b is RadarBackoffRecord => !!b && input.now < b.until)
  if (active.length !== input.primaryKeys.length) return null
  if (active.some(b => b.failureClass === 'provider_rate_limited' || b.status === 429)) return null
  return input.primaryKeys[0]
}

// ─── Delivery decision ────────────────────────────────────────────────────────────────────────
/** A previously verified payload may stand in for at most this long; it always keeps its own fetchedAt. */
export const RADAR_LAST_VERIFIED_MAX_AGE_MS = 2 * 60 * 60 * 1000

export type RadarDelivery =
  | { kind: 'live' }
  | { kind: 'stale'; staleAgeMs: number }
  | { kind: 'empty_provider_unavailable' }

export function decideRadarDelivery(input: {
  liveTokenCount: number
  /** Any primary/fallback page failed or was skipped this cycle. */
  discoveryDegraded: boolean
  /** No source (primary or fallback) succeeded at all. */
  allSourcesFailed: boolean
  stale: { tokenCount: number; fetchedAt: string } | null
  now: number
}): RadarDelivery {
  if (input.liveTokenCount > 0) return { kind: 'live' }
  // A healthy cycle that genuinely found nothing is an honest empty market, never replaced by old cards.
  if (!input.discoveryDegraded && !input.allSourcesFailed) return { kind: 'live' }
  if (input.stale && input.stale.tokenCount > 0) {
    const age = input.now - Date.parse(input.stale.fetchedAt)
    if (Number.isFinite(age) && age >= 0 && age <= RADAR_LAST_VERIFIED_MAX_AGE_MS) return { kind: 'stale', staleAgeMs: age }
  }
  return input.allSourcesFailed ? { kind: 'empty_provider_unavailable' } : { kind: 'live' }
}

export function radarPublicDiscoveryMessage(chain: RadarChainSlug, mode: 'delayed_no_stale' | 'delayed_with_stale'): string {
  const name = chain === 'robinhood' ? 'Robinhood market discovery' : 'Base market discovery'
  return mode === 'delayed_with_stale'
    ? `${name} is temporarily delayed. Showing the latest verified Radar results.`
    : `${name} is temporarily delayed. Retrying automatically.`
}

/** Longest remaining cooldown among this cycle's failed/skipped primary pages, so the client retries after it. */
export function radarRetryAfterMs(backoffUntils: Array<number | null | undefined>, now: number, failureBackoffMs: number): number | null {
  const remaining = backoffUntils.filter((u): u is number => typeof u === 'number' && u > now).map(u => u - now)
  if (remaining.length === 0) return null
  return Math.min(Math.max(...remaining), failureBackoffMs)
}

// ─── Fallback discovery (non-GeckoTerminal) ───────────────────────────────────────────────────
// Seeds: last-verified Radar tokens, DexScreener profile/boost tokens already fetched this cycle, and
// tokens of pools recently initialised on the Robinhood V4 PoolManager (Blockscout logs). Market data
// then comes from ONE DexScreener multi-token lookup; only pairs DexScreener itself reports on the
// requested chain are kept, so a chain DexScreener does not index simply yields nothing.
export const RADAR_FALLBACK_ADDRESS_CAP = 30
export const V4_INITIALIZE_TOPIC0 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
const ZERO = '0x0000000000000000000000000000000000000000'

export function mergeRadarFallbackAddresses(lists: string[][], cap = RADAR_FALLBACK_ADDRESS_CAP): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const raw of list) {
      if (typeof raw !== 'string' || !/^0x[\da-fA-F]{40}$/.test(raw)) continue
      const a = raw.toLowerCase()
      if (a === ZERO || seen.has(a)) continue
      seen.add(a)
      out.push(a)
      if (out.length >= cap) return out
    }
  }
  return out
}

/** Token addresses from V4 `Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, …)` logs. */
export function v4InitializeTokenAddresses(logs: Array<{ topics?: (string | null)[] | null; address?: { hash?: string } | string | null }>, poolManager: string, max = 10): string[] {
  const pm = poolManager.toLowerCase()
  const out: string[] = []
  for (const log of logs) {
    const emitter = typeof log.address === 'string' ? log.address : log.address?.hash
    if (!emitter || emitter.toLowerCase() !== pm) continue
    const topics = log.topics ?? []
    if ((topics[0] ?? '').toLowerCase() !== V4_INITIALIZE_TOPIC0) continue
    for (const t of [topics[2], topics[3]]) {
      if (typeof t !== 'string' || t.length !== 66) continue
      const addr = `0x${t.slice(26)}`.toLowerCase()
      if (addr !== ZERO && !out.includes(addr)) out.push(addr)
    }
    if (out.length >= max) break
  }
  return out.slice(0, max)
}

export type DexPairMappingAudit = {
  accepted: number
  rejected: { wrongChain: number; malformed: number; notRequested: number; quoteSideUnpriced: number; duplicate: number }
}

const EVM_ADDRESS = /^0x[\da-fA-F]{40}$/

function pairLiquidityUsd(pair: Record<string, unknown>): number {
  const v = Number((pair.liquidity as { usd?: unknown } | undefined)?.usd)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * DexScreener pairs → the GeckoTerminal-shaped pool records the Radar pipeline already gates.
 *
 * EXACT-TOKEN IDENTITY (follow-up to ff2069cb): every candidate must be one of the exact addresses sent
 * to the DexScreener lookup. `/latest/dex/tokens/{addresses}` returns pairs where a requested token is
 * EITHER the base or the quote, and on a pair `priceUsd`, `fdv` and `marketCap` always describe the BASE
 * token — the same contract ChainLens already enforces in src/modules/pricingAtTimeEngine/sources/
 * dexscreener.ts and clarkMarketDataProviders' dexScreenerPairIsRequestedPricedToken. So:
 *   - base is requested            → that base is the candidate, priced by this pair;
 *   - only the quote is requested  → rejected as quote_side_unpriced: the pair carries no USD price,
 *     FDV or market cap for the requested token, and the unrelated base token is never promoted. No
 *     reciprocal price is derived. The token can still qualify through a pair where it IS the base;
 *   - both sides requested         → the base is the candidate; the quote gets nothing from this pair;
 *   - several pairs for one token  → one record: highest liquidity, then lowest pair address.
 */
export function dexPairsToRadarPools(
  pairs: Record<string, unknown>[],
  chain: RadarChainSlug,
  requestedAddresses: Iterable<string>,
  idPrefix = 'dexfallback',
): { data: Record<string, unknown>[]; included: Record<string, unknown>[]; audit: DexPairMappingAudit } {
  const requested = new Set<string>()
  for (const a of requestedAddresses) if (typeof a === 'string' && EVM_ADDRESS.test(a)) requested.add(a.toLowerCase())
  const audit: DexPairMappingAudit = { accepted: 0, rejected: { wrongChain: 0, malformed: 0, notRequested: 0, quoteSideUnpriced: 0, duplicate: 0 } }
  const best = new Map<string, Record<string, unknown>>()
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object') { audit.rejected.malformed++; continue }
    if (pair.chainId !== chain) { audit.rejected.wrongChain++; continue }
    const baseAddr = (pair.baseToken as { address?: unknown } | undefined)?.address
    const quoteAddr = (pair.quoteToken as { address?: unknown } | undefined)?.address
    const pairAddr = pair.pairAddress
    const base = typeof baseAddr === 'string' && EVM_ADDRESS.test(baseAddr) ? baseAddr.toLowerCase() : null
    const quote = typeof quoteAddr === 'string' && EVM_ADDRESS.test(quoteAddr) ? quoteAddr.toLowerCase() : null
    if (!base || typeof pairAddr !== 'string' || !pairAddr) { audit.rejected.malformed++; continue }
    if (!requested.has(base)) {
      if (quote && requested.has(quote)) audit.rejected.quoteSideUnpriced++
      else audit.rejected.notRequested++
      continue
    }
    const current = best.get(base)
    if (current) {
      audit.rejected.duplicate++
      const better = pairLiquidityUsd(pair) > pairLiquidityUsd(current)
        || (pairLiquidityUsd(pair) === pairLiquidityUsd(current) && pairAddr.toLowerCase() < String(current.pairAddress).toLowerCase())
      if (!better) continue
    }
    best.set(base, pair)
  }
  const pools: Record<string, unknown>[] = []
  const included: Record<string, unknown>[] = []
  for (const [addr, pair] of [...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const baseToken = pair.baseToken as { symbol?: string; name?: string; address: string }
    const pairAddr = String(pair.pairAddress)
    const tokenId = `${idPrefix}_token_${addr}`
    included.push({ type: 'token', id: tokenId, attributes: { name: baseToken?.name ?? 'Unknown', symbol: baseToken?.symbol ?? '?', address: baseToken.address } })
    const priceChange = pair.priceChange as { h24?: number; h6?: number; h1?: number } | undefined
    const liquidity = pair.liquidity as { usd?: number } | undefined
    const volume = pair.volume as { h24?: number } | undefined
    const pairCreatedAtMs = typeof pair.pairCreatedAt === 'number' ? pair.pairCreatedAt : null
    pools.push({
      id: `${idPrefix}_pool_${pairAddr.toLowerCase()}`,
      relationships: { base_token: { data: { id: tokenId } }, dex: { data: { id: typeof pair.dexId === 'string' ? pair.dexId : 'unknown' } } },
      attributes: {
        address: pairAddr,
        // Base-side values only: the candidate IS this pair's base token, so these are its own figures.
        base_token_price_usd: pair.priceUsd ?? null,
        reserve_in_usd: liquidity?.usd ?? null,
        fdv_usd: pair.fdv ?? null,
        market_cap_usd: pair.marketCap ?? null,
        pool_created_at: pairCreatedAtMs != null ? new Date(pairCreatedAtMs).toISOString() : null,
        volume_usd: { h24: volume?.h24 ?? null },
        price_change_percentage: { h24: priceChange?.h24 ?? null, h6: priceChange?.h6 ?? null, h1: priceChange?.h1 ?? null },
      },
    })
    audit.accepted++
  }
  return { data: pools, included, audit }
}

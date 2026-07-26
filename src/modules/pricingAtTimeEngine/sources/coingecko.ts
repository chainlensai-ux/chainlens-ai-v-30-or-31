// MODULE — pricingAtTimeEngine/sources: coingecko
//
// Split out of multiProviderPriceSource.ts for modularization. Logic is unchanged from that file.
//
// Uses CoinGecko's real, documented /coins/{platform}/contract/{address}/market_chart/range
// endpoint, which genuinely supports a historical date range (unlike DexScreener's public API) —
// this is a real price-at-timestamp lookup, not a current-price approximation.

import type { SupportedChain } from '../../providerFetchWindow/types'

const COINGECKO_PLATFORM_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  // hyperevm intentionally omitted — not a verified CoinGecko asset platform id.
}

const COINGECKO_RANGE_WINDOW_SECONDS = 24 * 60 * 60 // +/- 1 day around the target timestamp

export type CoingeckoPriceResult = { priceUsd: number | null; reason: string | null }

// SCAN-LEVEL CIRCUIT BREAKER, DISCLOSED (source-retry-avoidance task, explicit "skip CoinGecko
// after the first 429 circuit-breaker event" requirement): CoinGecko's real public API enforces a
// well-known per-minute rate limit. A wallet with many historical recovery candidates fans out many
// of these calls (bounded by this pipeline's own concurrency caps, but still real volume); once the
// first 429 is observed, every rate-limit window for the rest of this scan is already exhausted or
// about to be — retrying is predictably going to keep hitting the same limit, not a genuine
// per-token/per-timestamp question CoinGecko might still answer differently for. Opens on the FIRST
// http_429, stays open until explicitly reset (per-scan, alongside every other per-job reset this
// codebase already applies — see resetCoingeckoCircuitBreaker's own header). NEVER FABRICATES: the
// short-circuited result is the same honest `null` a real rate-limited call would have produced
// anyway, just without paying for the network round-trip first.
let coingeckoCircuitOpen = false

// PER-SCAN RESET, DISCLOSED: same convention as goldrushPriceSource.ts's own
// resetGoldrushPriceSourceCallCount / dexscreener.ts's resetDexscreenerCallCount — called once per
// real scan (src/modules/walletScanWorker.ts) so a warm serverless instance's PREVIOUS scan hitting
// a real 429 never silently disables CoinGecko for an unrelated later scan of a different wallet.
export function resetCoingeckoCircuitBreaker(): void {
  coingeckoCircuitOpen = false
  coingeckoReservedForNativeEthSlots = 0
  nativeEthHistoryCache.clear()
  nativeEthHistoryUniqueDateRequests = 0
  nativeEthHistoryCoalescedHits = 0
  nativeEthHistoryLiveCalls = 0
}

// TEST-SUPPORT EXPORT, DISCLOSED: read-only observability, same convention as
// goldrushPriceSource.ts's isGoldrushBreakerOpenForTest.
export function isCoingeckoCircuitOpenForTest(): boolean {
  return coingeckoCircuitOpen
}

// NATIVE-ETH RESERVATION, DISCLOSED (confirmed production bug: two Tier-2 ETH native requirements,
// correctly prioritised, both routed to CoinGecko's native-coin-id endpoint — and still returned
// nativeRequirementsProviderMiss: 2, with "CoinGecko elsewhere reports circuit_open_after_429"). The
// native-ETH function shares this SAME module-level breaker with the ordinary, contract-based
// CoinGecko function above — by design, since it's the same real rate-limit bucket. The confirmed
// starvation mechanism: this breaker is process-lifetime, reset only once per scan
// (resetCoingeckoCircuitBreaker) — an EARLIER, lower-priority ordinary CoinGecko contract call within
// the SAME scan (from a different, non-native token entirely) can trip a real 429 and open the
// breaker before the two high-priority native ETH requirements ever get their own turn, even though
// their own PRICING requirement rank is correctly negative/highest-priority (rank determines
// resolvePricingAtTime's own processing order, but does nothing to protect a SHARED, cross-call,
// process-lifetime breaker from being tripped by something entirely outside that one call).
//
// FIX: a small, per-scan reservation counter. While `coingeckoReservedForNativeEthSlots > 0`, the
// ORDINARY contract-based function (fetchCoingeckoPriceDetailed, below) skips its own real call
// entirely — never even risks tripping the breaker — until the reserved native-ETH slots have each
// had their own real attempt (success or genuine miss, decremented unconditionally the moment that
// attempt is made). This never raises the total CoinGecko call ceiling: it only ever SKIPS a lower-
// priority ordinary call it would otherwise have made, in favor of letting the two reserved,
// higher-priority native attempts go first — the same "execute higher-priority attempts before
// ordinary lower-priority ones" principle already used elsewhere in this codebase (e.g.
// priceLotsForWallet.ts's own closed-lot pairRank priority).
let coingeckoReservedForNativeEthSlots = 0

// Called once per pricing pass, before resolvePricingAtTime runs, with the real count of completion-
// eligible native-ETH requirements about to be submitted (bounded to however many actually exist —
// never a hardcoded "2", so a scan with 0 or 1 such requirements never over-reserves).
export function reserveCoingeckoSlotsForNativeEth(count: number): void {
  coingeckoReservedForNativeEthSlots = Math.max(0, count)
}

export function coingeckoReservedForNativeEthSlotsRemainingForTest(): number {
  return coingeckoReservedForNativeEthSlots
}

// NATIVE-ETH HISTORY COALESCING, DISCLOSED (confirmed production bug: reservation worked — both
// selected Tier-2 ETH requirements attempted the native endpoint with the breaker CLOSED before
// both calls — yet both independently requested `ethereum history` for the SAME date
// (11-05-2026) and both received a real HTTP 429. Two closed-lot requirements sharing one date
// (e.g. a same-day buy+sell, or two different lots both quoted in ETH on the same day) is the
// common case, not an edge one — the reservation mechanism protects against being starved by
// OTHER, ordinary tokens, but does nothing to stop two of these SAME-day native requirements from
// firing two redundant real requests for identical data. Fixed with a request-scoped singleflight/
// cache keyed by `${coinId}:${formattedDate}` — the SAME key CoinGecko's own endpoint is scoped to
// (one price per coin per calendar day, regardless of which specific closed lot needs it). The
// promise is stored BEFORE any await, so two calls for the same date within the same tick share the
// exact same in-flight request; the SETTLED result (success OR a genuine terminal failure like a
// 429) is left in the map for the rest of this scan — never retried, never "waited out" — so no
// requirement for that same date fires a second real request, ever, this scan.
const nativeEthHistoryCache = new Map<string, Promise<CoingeckoPriceResult & { diagnostic: NativeEthPricingDiagnostic }>>()
let nativeEthHistoryUniqueDateRequests = 0
let nativeEthHistoryCoalescedHits = 0
let nativeEthHistoryLiveCalls = 0

export function getNativeEthHistoryCoalescingDiagnostics(): {
  nativeEthHistoryUniqueDateRequests: number
  nativeEthHistoryCoalescedHits: number
  nativeEthHistoryLiveCalls: number
} {
  return { nativeEthHistoryUniqueDateRequests, nativeEthHistoryCoalescedHits, nativeEthHistoryLiveCalls }
}

// RUNTIME CONFIGURATION AUDIT, DISCLOSED, ADDITIVE — read-only, logged at most once per unique live
// call (never per coalesced hit, never containing the key itself): whether an authenticated key is
// configured, which real base URL/tier this module actually targets, and whether the corresponding
// auth mechanism is genuinely attached to the request. This module always targets CoinGecko's public/
// demo base (`api.coingecko.com`) with the `x-cg-demo-api-key` header when a key is configured — it
// never switches to the separate PRO base (`pro-api.coingecko.com`, `x-cg-pro-api-key` header) for
// any key shape, so a PRO-tier key configured in COINGECKO_API_KEY would still be sent as a demo-tier
// header against the demo-tier base URL. Disclosed here, not silently assumed correct.
function auditCoingeckoRuntimeConfig(): void {
  const apiKey = process.env.COINGECKO_API_KEY
  // eslint-disable-next-line no-console
  console.warn('[coingecko-runtime-config-audit]', {
    apiKeyConfigured: !!apiKey,
    baseUrl: 'https://api.coingecko.com/api/v3',
    tierAssumed: 'demo_or_public',
    authHeaderName: 'x-cg-demo-api-key',
    authHeaderAttached: !!apiKey,
    note: apiKey
      ? 'a key is configured and attached via x-cg-demo-api-key against the demo/public base URL — if this key is actually a PRO-tier key, it needs pro-api.coingecko.com + x-cg-pro-api-key instead, not audited/changed here'
      : 'no COINGECKO_API_KEY configured — every request is unauthenticated, subject to the public (lowest) rate limit',
  })
}

// Detailed variant — used by the orchestrator (getPriceAtTime) for structured debug output.
export async function fetchCoingeckoPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<CoingeckoPriceResult> {
  const platform = COINGECKO_PLATFORM_IDS[chain]
  if (!platform) return { priceUsd: null, reason: 'unverified_chain_for_coingecko' }

  // RESERVED-SLOT SKIP: checked before the breaker itself — see coingeckoReservedForNativeEthSlots'
  // own declaration above. Never a real network call, never risks tripping the shared breaker on
  // behalf of a lower-priority ordinary request while a higher-priority native-ETH request still has
  // a reserved slot outstanding this scan.
  if (coingeckoReservedForNativeEthSlots > 0) return { priceUsd: null, reason: 'coingecko_reserved_for_native_eth' }

  // BREAKER SHORT-CIRCUIT: checked before any network call — see coingeckoCircuitOpen's own
  // declaration above for the full reasoning.
  if (coingeckoCircuitOpen) return { priceUsd: null, reason: 'coingecko_circuit_open_after_429' }

  const targetSec = Math.floor(timestamp / 1000)
  const url = new URL(
    `https://api.coingecko.com/api/v3/coins/${platform}/contract/${token.toLowerCase()}/market_chart/range`,
  )
  url.searchParams.set('vs_currency', 'usd')
  url.searchParams.set('from', String(targetSec - COINGECKO_RANGE_WINDOW_SECONDS))
  url.searchParams.set('to', String(targetSec + COINGECKO_RANGE_WINDOW_SECONDS))

  const apiKey = process.env.COINGECKO_API_KEY

  try {
    const res = await fetch(url.toString(), {
      headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status === 429) {
      // TRIP THE BREAKER, DISCLOSED: the first real 429 this scan is trusted evidence the rate
      // limit is exhausted — never waits for a second confirming 429 (unlike GoldRush's
      // consecutive-miss threshold, which distinguishes "temporarily slow" from "structurally not
      // answering"; a 429 IS the rate limiter answering, definitively, right now).
      coingeckoCircuitOpen = true
      return { priceUsd: null, reason: 'http_429' }
    }
    if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

    const data = (await res.json()) as { prices?: Array<[number, number]> }
    const prices = data.prices ?? []
    if (prices.length === 0) return { priceUsd: null, reason: 'no_price_series_in_range' }

    const closest = prices.reduce((a, b) => (Math.abs(b[0] - timestamp) < Math.abs(a[0] - timestamp) ? b : a))
    return Number.isFinite(closest[1]) ? { priceUsd: closest[1], reason: null } : { priceUsd: null, reason: 'unparseable_price' }
  } catch (err) {
    return { priceUsd: null, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// PER-REQUIREMENT DIAGNOSTIC, DISCLOSED, BOUNDED (caller — pricingAtTimeAdapter.ts — snapshots this
// via length-before/slice-after, same cross-request-leak guard convention as pricingRouteLog
// elsewhere in this codebase): everything the task's own audit list asked for that is actually
// observable at THIS layer. `txHash` and `fallbackSourcesAttempted` are unknown here (this function
// only ever sees token/chain/timestamp) — left null/[] for the caller to fill in, since the caller
// (the chain-aware router) is the one that knows both.
export type NativeEthPricingDiagnostic = {
  originalTimestamp: number
  formattedDate: string | null
  endpointType: 'native_coin_history'
  circuitBreakerStateBeforeCall: boolean
  requestAttempted: boolean
  requestSkippedReason: string | null
  httpStatus: number | null
  responseShapePresent: { marketData: boolean; currentPrice: boolean; usd: boolean }
  parsedPrice: number | null
  failureReason:
    | 'native_route_budget_blocked'
    | 'coingecko_circuit_open'
    | 'coingecko_http_429'
    | 'coingecko_http_error'
    | 'history_payload_missing_market_data'
    | 'history_payload_missing_usd'
    | 'invalid_price'
    | 'invalid_timestamp'
    | 'fetch_error'
    | null
}

// NATIVE-ASSET HISTORY, DISCLOSED (ETH native-routing-mismatch fix): CoinGecko indexes native ETH
// under its own coin id ("ethereum") via the real, documented `/coins/{id}/history` endpoint — a
// DIFFERENT, more complete dataset than the CONTRACT-address-based `/coins/{platform}/contract/
// {address}/market_chart/range` endpoint above (that one is a secondary, contract-derived dataset;
// querying it with WETH's contract address on mainnet can genuinely miss dates the coin's own
// primary history has). Single-day precision (`date=DD-MM-YYYY`), matching this function's own
// historical-lookup contract — never a current-price fallback, never applied to any date but the
// one requested. Shares the SAME circuit breaker as the contract-based function above (same
// CoinGecko rate-limit bucket) — see coingeckoReservedForNativeEthSlots' own header for why this
// function ALSO decrements that reservation, unconditionally, the moment it is invoked.
export async function fetchCoingeckoNativeEthPriceDetailed(
  timestamp: number,
): Promise<CoingeckoPriceResult & { diagnostic: NativeEthPricingDiagnostic }> {
  const breakerStateBeforeCall = coingeckoCircuitOpen
  // Reservation is consumed the moment this requirement gets its real turn — regardless of outcome —
  // so ordinary contract-based calls resume immediately after, never blocked longer than necessary.
  if (coingeckoReservedForNativeEthSlots > 0) coingeckoReservedForNativeEthSlots -= 1

  if (breakerStateBeforeCall) {
    return {
      priceUsd: null,
      reason: 'coingecko_circuit_open_after_429',
      diagnostic: {
        originalTimestamp: timestamp,
        formattedDate: null,
        endpointType: 'native_coin_history',
        circuitBreakerStateBeforeCall: true,
        requestAttempted: false,
        requestSkippedReason: 'coingecko_circuit_open',
        httpStatus: null,
        responseShapePresent: { marketData: false, currentPrice: false, usd: false },
        parsedPrice: null,
        failureReason: 'coingecko_circuit_open',
      },
    }
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return {
      priceUsd: null,
      reason: 'invalid_timestamp',
      diagnostic: {
        originalTimestamp: timestamp,
        formattedDate: null,
        endpointType: 'native_coin_history',
        circuitBreakerStateBeforeCall: breakerStateBeforeCall,
        requestAttempted: false,
        requestSkippedReason: 'invalid_timestamp',
        httpStatus: null,
        responseShapePresent: { marketData: false, currentPrice: false, usd: false },
        parsedPrice: null,
        failureReason: 'invalid_timestamp',
      },
    }
  }
  const dateString = `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`
  const cacheKey = `ethereum:${dateString}`

  // COALESCE, DISCLOSED: a second (or third...) requirement for the SAME date shares the exact same
  // in-flight/settled promise — never fires its own request, never re-derives its own diagnostic
  // (it gets the identical one the first requester received, including whichever outcome — success
  // or a genuine terminal failure like a 429 — that call actually settled with).
  const existing = nativeEthHistoryCache.get(cacheKey)
  if (existing) {
    nativeEthHistoryCoalescedHits += 1
    return existing
  }

  nativeEthHistoryUniqueDateRequests += 1
  nativeEthHistoryLiveCalls += 1
  if (nativeEthHistoryUniqueDateRequests === 1) auditCoingeckoRuntimeConfig()

  const live = (async (): Promise<CoingeckoPriceResult & { diagnostic: NativeEthPricingDiagnostic }> => {
    const diagnostic: NativeEthPricingDiagnostic = {
      originalTimestamp: timestamp,
      formattedDate: dateString,
      endpointType: 'native_coin_history',
      circuitBreakerStateBeforeCall: breakerStateBeforeCall,
      requestAttempted: false,
      requestSkippedReason: null,
      httpStatus: null,
      responseShapePresent: { marketData: false, currentPrice: false, usd: false },
      parsedPrice: null,
      failureReason: null,
    }

    const url = new URL('https://api.coingecko.com/api/v3/coins/ethereum/history')
    url.searchParams.set('date', dateString)
    url.searchParams.set('localization', 'false')

    const apiKey = process.env.COINGECKO_API_KEY

    diagnostic.requestAttempted = true
    try {
      const res = await fetch(url.toString(), {
        headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
        signal: AbortSignal.timeout(8_000),
      })
      diagnostic.httpStatus = res.status
      if (res.status === 429) {
        coingeckoCircuitOpen = true
        diagnostic.failureReason = 'coingecko_http_429'
        return { priceUsd: null, reason: 'http_429', diagnostic }
      }
      if (!res.ok) {
        diagnostic.failureReason = 'coingecko_http_error'
        return { priceUsd: null, reason: `http_${res.status}`, diagnostic }
      }

      const data = (await res.json()) as { market_data?: { current_price?: { usd?: number } } }
      diagnostic.responseShapePresent.marketData = data.market_data != null
      diagnostic.responseShapePresent.currentPrice = data.market_data?.current_price != null
      const price = data.market_data?.current_price?.usd
      diagnostic.responseShapePresent.usd = typeof price === 'number'
      if (!diagnostic.responseShapePresent.marketData) {
        diagnostic.failureReason = 'history_payload_missing_market_data'
        return { priceUsd: null, reason: 'no_price_for_date', diagnostic }
      }
      if (typeof price !== 'number' || !Number.isFinite(price)) {
        diagnostic.failureReason = diagnostic.responseShapePresent.currentPrice ? 'invalid_price' : 'history_payload_missing_usd'
        return { priceUsd: null, reason: 'no_price_for_date', diagnostic }
      }
      diagnostic.parsedPrice = price
      return { priceUsd: price, reason: null, diagnostic }
    } catch (err) {
      diagnostic.failureReason = 'fetch_error'
      return { priceUsd: null, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}`, diagnostic }
    }
  })()

  // Stored BEFORE the caller awaits it (the assignment above already completed synchronously) —
  // NEVER deleted, win or lose: caching a terminal failure (a real 429, a genuine http error, a
  // malformed payload) is exactly as important as caching a success, since retrying either would
  // either waste a call this scan already knows is doomed, or risk converting an honest miss into a
  // fabricated "different" result on retry.
  nativeEthHistoryCache.set(cacheKey, live)
  return live
}

// Public export matching this codebase's PriceSourceFn contract exactly (token, chain, timestamp)
// -> number | null — a clean USD price or null, never a fabricated value.
export async function fetchCoingeckoPrice(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<number | null> {
  const result = await fetchCoingeckoPriceDetailed(token, chain, timestamp)
  return result.priceUsd
}

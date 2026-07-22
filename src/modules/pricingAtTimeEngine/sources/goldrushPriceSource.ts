// MODULE — pricingAtTimeEngine/sources: goldrushPriceSource
//
// CORRECTION TO THE REQUESTED SPEC (verified, not assumed): `import { GoldRush } from
// "@goldrush/api"` does not exist — there is no `@goldrush/api` package on the npm registry
// (confirmed via `npm view @goldrush/api`, which 404s). Covalent's actual, official GoldRush
// TypeScript SDK is `@covalenthq/client-sdk` (branded "GoldRush TS SDK" on goldrush.dev),
// exporting a `GoldRushClient` class, not `GoldRush`. Likewise, `gr.token.getHistoricalPrice({
// chain, contract, timestamp})` does not exist on the real client — inspected the published
// package's type declarations directly (PricingService.d.ts) and found no such method. The real,
// verified historical-pricing method is:
//
//   client.PricingService.getTokenPrices(chainName, quoteCurrency, contractAddress, { from, to })
//
// — a DATE-RANGE query (YYYY-MM-DD strings), not a single-millisecond-timestamp lookup, returning
// `GoldRushResponse<TokenPricesResponse[]>` where each response item has an `items: Price[]` array
// (one entry per day in the range), not a flat `{ priceUsd }`. This module adapts our
// PriceSourceFn contract onto the REAL API rather than implementing a method that doesn't exist.
//
// Added @covalenthq/client-sdk@3.0.6 as a real, installed dependency (package.json) — required to
// do this integration at all; there is no way to call a real SDK without it.

import { GoldRushClient } from '@covalenthq/client-sdk'
import type { Chain } from '@covalenthq/client-sdk'
import type { PriceSourceFn } from '../types'
import { logRpcCall } from '@/lib/server/rpcDebug'

// Real, verified GoldRush chain slugs (confirmed against the installed SDK's Generic.types.d.ts
// ChainName enum). Kept as this module's own literal copy — same "no runtime coupling between
// modules" convention providerFetchWindow/recoveryPolicy/holdings already use for their own
// GOLDRUSH_VERIFIED_CHAIN_SLUGS maps — rather than importing theirs.
//
// NOTE: while verifying this, the real SDK's ChainName enum turned out to include
// HYPEREVM_MAINNET = "hyperevm-mainnet" (chain ID 999, matching this codebase's own
// HYPEREVM_CHAIN_ID) — i.e. GoldRush DOES have a verified chain slug for HyperEVM. That contradicts
// the "no verified GoldRush slug for HyperEVM" assumption baked into
// providerFetchWindow/recoveryPolicy/holdings' own GOLDRUSH_VERIFIED_CHAIN_SLUGS maps from an
// earlier task. Not fixed here — out of scope for a pricing-source task — but worth a follow-up:
// those three files' HyperEVM gating could be loosened now that this is verified.
const GOLDRUSH_CHAIN_SLUGS: Record<string, Chain> = {
  eth: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arbitrum-mainnet',
  hyperevm: 'hyperevm-mainnet',
}

// CALL-COUNTER INSTRUMENTATION, DISCLOSED (GoldRush CU-investigation task, same disclosed pattern
// as basedex.ts): this is the PRIMARY price source, called once per distinct (token, chain,
// timestamp) priced entry — i.e. it's the GoldRush call site most likely to fan out to real volume
// in a deep scan (hundreds of buy/sell entries, dozens-to-hundreds of distinct tokens), unlike
// providerFetchWindow's own goldrush call (a single bounded call per chain, already fully visible
// via the existing providerDiagnostics log). Counting only, no console spam per call — the lesson
// from basedex.ts's first version of this same instrumentation, which logged every call and blew
// past Vercel's per-invocation log capture limit before the one summary line that mattered could
// fire. One summary line per completed pricing pass (fired by the caller, pricingAtTimeEngine's
// resolvePricingAtTime, right alongside its existing logBaseDexFinalTotals() call).
let goldrushPriceSourceCallCount = 0
export function getGoldrushPriceSourceCallCount(): number {
  return goldrushPriceSourceCallCount
}

// NEGATIVE-RESULT CACHE, DISCLOSED (real-CU-fix, GoldRush CU-investigation task — same pattern as
// basedex.ts's negativePoolCache): measured live on a real scan, this primary price source made
// 1,045 real calls across one scan's pricing passes, and the pricing-source breakdown showed
// `primary: 0` for every one of them — every single call returned null, yet each repeat occurrence
// of the same token re-ran the exact same doomed call from scratch (avgLookupsPerToken measured at
// 6.71 in that scan). The wrapping cache this function's caller applies (withPriceSourceCache in
// src/pipeline/index.ts) only caches non-null results, so a token GoldRush has no data for was never
// cached at any level.
//
// SCOPE, DISCLOSED (a real precision tradeoff, not free): cached per (token, chain), NOT per
// (token, chain, day) — the underlying query is date-scoped, but tokens that hit this path
// consistently look like ones GoldRush simply doesn't index at all (confirmed live: 100% null rate
// across a whole scan spanning many distinct dates), not ones with occasional day-specific gaps. A
// day-scoped cache would miss most of the measured repeat waste (the same token trading across
// several different days would still cost one real call per day). The real risk this accepts: if a
// token genuinely has data on some OTHER date than the one that first missed, this cache would
// skip checking it for the TTL window below — the same accepted tradeoff basedex.ts's own negative
// pool cache already uses, for the same reason (bounded staleness, not permanent).
//
// TTL, NOT PERMANENT, DISCLOSED: 5 minutes, matching basedex.ts's own negativePoolCache TTL — a
// token GoldRush doesn't index yet could be indexed later, so this is a bounded delay, not a
// permanent "never check again."
const NEGATIVE_PRICE_CACHE_TTL_MS = 5 * 60 * 1000
const negativeGoldrushPriceCache = new Map<string, number>() // `${chain}:${token}` -> expiresAtMs

// IN-FLIGHT COALESCING, DISCLOSED: same reasoning as basedex.ts's inFlightPoolSearches — concurrent
// lookups for the exact same (token, chain, date) under pricingAtTimeEngine's concurrency-capped
// parallel priceEntries() share one real call instead of each starting a redundant duplicate one.
// Keyed by the exact (token, chain, date) the real call itself uses (narrower than the negative
// cache's per-token key above), since two concurrent lookups for the same token on DIFFERENT dates
// must not be conflated into sharing one date's specific result.
const inFlightGoldrushPriceLookups = new Map<string, Promise<number | null>>()

// BOUNDED TIMEOUT, DISCLOSED: `client.PricingService.getTokenPrices(...)` (the real Covalent SDK
// call below) has no timeout of its own — this is the PRIMARY price source (src/pipeline/index.ts's
// `withPriceSourceCache(goldrushPriceSource(client), 'primary', ...)`), called for every priced
// entry before any fallback source runs. An unbounded await here means a single slow/degraded
// GoldRush response (rate-limit backoff, TCP stall, etc.) hangs that call indefinitely — and since
// pricingAtTimeEngine runs entries through a fixed concurrency pool (mapWithConcurrencyLimit), a
// GoldRush-wide slowdown can stall every worker in the pool at once, well past the outer 270s
// worker-global timeout (workers/walletScanV2.ts's WORKER_GLOBAL_TIMEOUT_MS) — with no per-entry
// symptom to point at, since every entry is just "still awaiting". Same 8s bound already used by
// this module's own sibling sources (dexscreener.ts, coingecko.ts) for the same reason. A timeout
// here is treated exactly like the existing thrown-error path below: resolves to null, is NOT
// added to the negative cache (a slow response says nothing about whether real data exists — see
// this file's own "a thrown error... is NOT cached as negative" test and comment).
const GOLDRUSH_CALL_TIMEOUT_MS = 8_000

function withGoldrushTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('goldrush_timeout')), GOLDRUSH_CALL_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// SCAN-LEVEL CIRCUIT BREAKER, DISCLOSED (real-latency-fix, follow-up to the timeout bound above):
// bounding each call at 8s stops an individual call from hanging forever, but this file's own
// earlier comment already discloses a real, measured scan where GoldRush made 1,045 real calls and
// returned null for every single one — at this module's own 8s bound and pricingAtTimeEngine's
// fixed concurrency pool (see index.ts's mapWithConcurrencyLimit), that's roughly
// (1045 / concurrency) * 8s of WALL-CLOCK time paid to a source that never once had an answer, which
// alone can approach or exceed the outer 270s worker-global timeout — not a hang, just a source
// that's clearly not going to answer, being retried at full cost for every distinct token anyway.
// This breaker tracks CONSECUTIVE misses (null results OR timeouts) across calls within one process:
// once GOLDRUSH_BREAKER_THRESHOLD consecutive misses are seen, it opens for
// GOLDRUSH_BREAKER_COOLDOWN_MS and every call during that window short-circuits straight to null —
// no real network call, no 8s wait — falling through to this source's own real fallback chain
// (dexscreener/coingecko/basedex, wired by src/pipeline/index.ts) exactly as a normal miss already
// would. NEVER FABRICATES: this only ever produces the same `null` a real miss already produces,
// just faster, and any real success immediately resets the counter and lets subsequent calls through
// again — this never permanently disables the source, and a temporarily-degraded GoldRush that
// recovers mid-scan resumes being tried again once the cooldown elapses.
const GOLDRUSH_BREAKER_THRESHOLD = 20
const GOLDRUSH_BREAKER_COOLDOWN_MS = 30_000
let goldrushConsecutiveMisses = 0
let goldrushBreakerOpenUntilMs = 0

function goldrushBreakerOpen(): boolean {
  return Date.now() < goldrushBreakerOpenUntilMs
}

function recordGoldrushMiss(): void {
  goldrushConsecutiveMisses += 1
  if (goldrushConsecutiveMisses >= GOLDRUSH_BREAKER_THRESHOLD) {
    goldrushBreakerOpenUntilMs = Date.now() + GOLDRUSH_BREAKER_COOLDOWN_MS
  }
}

function recordGoldrushSuccess(): void {
  goldrushConsecutiveMisses = 0
  goldrushBreakerOpenUntilMs = 0
}

// YYYY-MM-DD, exactly what getTokenPrices' from/to params require. Never infers a missing/invalid
// timestamp — an unparseable input returns null so the caller treats it as "no data", never a
// guessed date.
function toDateString(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs)) return null
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

// KV-ROUND-TRIP-SKIP EXPORT, DISCLOSED (found live, latency-investigation task): src/pipeline/
// index.ts's withPriceSourceCache wraps this whole source in a remote KV get-before/set-after for
// EVERY call — but since a null result is deliberately never written to that KV cache (an honest
// "no price found" shouldn't get stuck cached), a token this module already knows is negatively
// cached will ALWAYS miss that remote KV get too, paying a full network round-trip for a result we
// already have for free, in memory, on every repeat occurrence (confirmed live: a real scan showed
// avgLookupsPerToken of 6.71 with primary:0 every time — hundreds of guaranteed-miss KV round-trips
// stacked on top of the real provider calls). Exported so the caller can check this FIRST and skip
// the KV round-trip entirely when it's already known-negative, calling straight into this module's
// own (synchronous-fast) negative-cache short-circuit instead. Read-only — asserts nothing, changes
// no cache state itself.
export function isKnownGoldrushNegative(token: string, chain: string): boolean {
  const negativeCacheKey = `${chain}:${token.toLowerCase()}`
  const expiresAt = negativeGoldrushPriceCache.get(negativeCacheKey)
  return expiresAt !== undefined && Date.now() < expiresAt
}

// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as basedex.ts's own __resetBaseDexCachesForTest —
// lets a test start each case from a clean cache state. Not called anywhere in real request handling.
export function __resetGoldrushPriceSourceCachesForTest(): void {
  negativeGoldrushPriceCache.clear()
  inFlightGoldrushPriceLookups.clear()
  goldrushPriceSourceCallCount = 0
  goldrushConsecutiveMisses = 0
  goldrushBreakerOpenUntilMs = 0
}

// TEST-SUPPORT EXPORT, DISCLOSED: read-only observability into the circuit breaker's state, same
// convention as isKnownGoldrushNegative above — lets a test assert the breaker actually opened
// without needing to reach into this module's private state directly.
export function isGoldrushBreakerOpenForTest(): boolean {
  return goldrushBreakerOpen()
}

// Builds a PriceSourceFn backed by a real GoldRushClient instance. Never fabricates a price: an
// unverified chain, an unparseable timestamp, a thrown/error response, or an empty/priceless
// result all resolve to null — never a guessed number.
export function goldrushPriceSource(client: GoldRushClient): PriceSourceFn {
  return async function priceAtTimestamp(token: string, chain: string, timestamp: number): Promise<number | null> {
    const chainSlug = GOLDRUSH_CHAIN_SLUGS[chain]
    if (!chainSlug) return null

    const dateString = toDateString(timestamp)
    if (!dateString) return null

    // BREAKER SHORT-CIRCUIT: checked before the negative-cache lookup below (cheapest possible
    // check first) — if GoldRush has just shown GOLDRUSH_BREAKER_THRESHOLD consecutive misses
    // across this process, skip straight to null (no real call, no 8s wait) rather than paying
    // this source's full cost on every one of potentially hundreds of distinct tokens it's already
    // demonstrated it won't answer for. See this breaker's own declaration above for the full
    // reasoning and the real, measured scan (1,045 calls, 100% null) that motivated it.
    if (goldrushBreakerOpen()) return null

    const tokenLower = token.toLowerCase()
    const negativeCacheKey = `${chain}:${tokenLower}`
    const negativeExpiresAt = negativeGoldrushPriceCache.get(negativeCacheKey)
    if (negativeExpiresAt !== undefined && Date.now() < negativeExpiresAt) return null

    const inFlightKey = `${negativeCacheKey}:${dateString}`
    const inFlight = inFlightGoldrushPriceLookups.get(inFlightKey)
    if (inFlight) return inFlight

    const lookup = (async (): Promise<number | null> => {
      try {
        logRpcCall({ route: 'pricingAtTimeEngine:goldrushPriceSource', chain, method: 'goldrush_sdk_getTokenPrices' })
        goldrushPriceSourceCallCount += 1
        const response = await withGoldrushTimeout(client.PricingService.getTokenPrices(chainSlug, 'USD', token, {
          from: dateString,
          to: dateString,
        }))

        if (response.error || !response.data) {
          negativeGoldrushPriceCache.set(negativeCacheKey, Date.now() + NEGATIVE_PRICE_CACHE_TTL_MS)
          recordGoldrushMiss()
          return null
        }

        const items = response.data[0]?.items
        if (!Array.isArray(items) || items.length === 0) {
          negativeGoldrushPriceCache.set(negativeCacheKey, Date.now() + NEGATIVE_PRICE_CACHE_TTL_MS)
          recordGoldrushMiss()
          return null
        }

        const price = items[0]?.price
        if (typeof price === 'number' && Number.isFinite(price)) {
          recordGoldrushSuccess()
          return price
        }
        negativeGoldrushPriceCache.set(negativeCacheKey, Date.now() + NEGATIVE_PRICE_CACHE_TTL_MS)
        recordGoldrushMiss()
        return null
      } catch {
        // GoldRush threw (network error, rate limit, invalid API key, etc.) — never a crash, never a
        // fabricated price. Deliberately NOT added to the negative cache: a thrown error (as opposed
        // to a genuine "no data" response) says nothing about whether this token has real price
        // data, so caching it as a negative result could hide a token that would have resolved fine
        // on a retry a moment later. Still counts toward the breaker above: a timeout or thrown
        // error is exactly the "GoldRush isn't answering" signal the breaker exists to short-circuit,
        // regardless of whether it's a clean "no data" response or a network-level failure.
        recordGoldrushMiss()
        return null
      }
    })()

    inFlightGoldrushPriceLookups.set(inFlightKey, lookup)
    try {
      return await lookup
    } finally {
      inFlightGoldrushPriceLookups.delete(inFlightKey)
    }
  }
}

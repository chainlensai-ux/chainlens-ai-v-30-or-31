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
import type { SupportedChain } from '../../providerFetchWindow/types'
import { logRpcCall } from '@/lib/server/rpcDebug'
import { tryConsume, recordDuplicatePrevented, recordCallOutcome, type CostStage } from '../../providerCost/walletProviderCostLedger'

// AMBIENT PASS-CONTEXT, DISCLOSED (wallet-provider-cost-audit follow-up task — confirmed production
// confusion: `wallet-provider-cost-audit` reported 80 calls under `historical_pricing` for a scan
// whose historical/manifest-replay path had genuinely made zero, because this SAME price source
// function is reused, unmodified, for BOTH resolvePricingAtTime passes in priceLotsForWallet.ts —
// the at-trade-time historical pass AND the current/open-position pass. Neither this module's own
// PriceSourceFn signature (types.ts) nor pricingAtTimeEngine's own resolvePricingAtTime call
// contract carries a "which pass is this" parameter, so there is no way to thread the real stage
// through the normal call chain without changing that shared, well-tested contract. This ambient,
// scan-scoped flag is the SAME "set immediately before, read inside, reset after" convention this
// codebase already uses for `getGoldrushPriceSourceCallCount`'s own before/after delta pattern
// (priceLotsForWallet.ts's own `currentPriceGoldrushLiveCalls` computation) — the caller that DOES
// know which pass it's running sets this right before invoking resolvePricingAtTime for that pass.
let goldrushPriceSourceStage: CostStage = 'historical_pricing'
export function setGoldrushPriceSourceStage(stage: CostStage): void {
  goldrushPriceSourceStage = stage
}
export function resetGoldrushPriceSourceStage(): void {
  goldrushPriceSourceStage = 'historical_pricing'
}

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

// PERF-SPRINT TASK, DISCLOSED ("Deduplicate identical token+timestamp lookups before any provider
// call" / "Reuse a single historical price across every lot sharing the same token and timestamp
// bucket" / "Persist historical prices indefinitely (historical prices are immutable)"): a REAL,
// confirmed gap — `inFlightGoldrushPriceLookups` above only coalesces CONCURRENT duplicate lookups
// (the promise is deleted from that map in its own `finally` the instant it settles), so two lots
// needing the same (chain, token, UTC day) that are NOT in flight at the same moment — the common
// case, since pricingAtTimeEngine's worker pool processes entries as a queue, not in lockstep —
// still each pay a full live GoldRush call, even though the SECOND call's answer is provably
// identical to the first (see this file's own "TIME-BUCKET DEDUPE KEY" comment below: the real
// query itself is date-scoped, `from === to === dateString`, so two requirements for the same
// token on the same day genuinely cannot produce different answers). This positive cache closes
// that gap: once a real call resolves to a genuine, finite price for a (chain, token, day), every
// later lookup for that exact key — this call, a later call in the same scan, or a call from a
// DIFFERENT scan on the same warm serverless instance — reuses it directly, zero network cost,
// zero accuracy change (it is the literal same fact GoldRush would return again). Deliberately NOT
// given a TTL: unlike the negative cache above (a real "no data yet" can become "has data later"),
// a resolved historical price for a past, already-mined day cannot un-happen — see kvClient.ts's
// own HISTORICAL_TTL_SECONDS header for the same "immutable fact" reasoning applied to this
// source's own remote KV layer. Process-lifetime, matching negativeGoldrushPriceCache/
// inFlightGoldrushPriceLookups' own established convention (see resetGoldrushPriceSourceCallCount's
// own comment: "process-lifetime... must survive across scans on a warm serverless instance for
// their real cost-saving purpose") — never reset per-scan, only per-test via
// __resetGoldrushPriceSourceCachesForTest.
const positiveGoldrushPriceCache = new Map<string, number>() // `${chain}:${token}:${dateString}` -> priceUsd

// LATENCY TRACKING, DISCLOSED (perf-sprint task's "Time saved" diagnostic requirement): real,
// measured elapsed time for every GENUINE live GoldRush call this process makes (never for a
// breaker short-circuit, negative-cache hit, singleflight join, or this new positive-cache hit —
// only the real network round trip itself) — lets a caller compute an honest
// `duplicatesEliminated * averageObservedLiveCallLatencyMs` estimate from THIS process's own real
// timings, rather than a guessed constant. Reset alongside the call counter (per-scan, via
// resetGoldrushPriceSourceCallCount) so the average reported for one scan reflects that scan's own
// real provider latency, not a stale cross-scan blend.
let goldrushLiveCallTotalMs = 0
let goldrushLiveCallCount = 0
export function getGoldrushLiveCallLatencyStats(): { totalMs: number; count: number; avgMs: number | null } {
  return { totalMs: goldrushLiveCallTotalMs, count: goldrushLiveCallCount, avgMs: goldrushLiveCallCount > 0 ? goldrushLiveCallTotalMs / goldrushLiveCallCount : null }
}
function resetGoldrushLiveCallLatencyStats(): void {
  goldrushLiveCallTotalMs = 0
  goldrushLiveCallCount = 0
}

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

// PER-SCAN COUNTER RESET, DISCLOSED (provider-call-audit task): unlike the test-only reset below,
// this ONLY zeroes the call counter — never the negative-result cache, in-flight dedupe map, or
// circuit-breaker state, all of which are deliberately process-lifetime (see this file's own
// caching/breaker headers) and must survive across scans on a warm serverless instance for their
// real cost-saving purpose. Called once per real scan (walletScanWorker.ts) purely so the
// per-stage provider-call diagnostic reports THIS scan's own count, not a stale cumulative total.
export function resetGoldrushPriceSourceCallCount(): void {
  goldrushPriceSourceCallCount = 0
  resetGoldrushPriceSourceStage()
  resetGoldrushLiveCallLatencyStats()
}

// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as basedex.ts's own __resetBaseDexCachesForTest —
// lets a test start each case from a clean cache state. Not called anywhere in real request handling.
export function __resetGoldrushPriceSourceCachesForTest(): void {
  negativeGoldrushPriceCache.clear()
  inFlightGoldrushPriceLookups.clear()
  positiveGoldrushPriceCache.clear()
  goldrushPriceSourceCallCount = 0
  goldrushConsecutiveMisses = 0
  goldrushBreakerOpenUntilMs = 0
  resetGoldrushLiveCallLatencyStats()
}

// TEST-SUPPORT EXPORT, DISCLOSED: same convention as isKnownGoldrushNegative — lets a test assert a
// (chain, token, day) is already positively cached without reaching into this module's private
// state directly.
export function isKnownGoldrushPositive(token: string, chain: string, timestampMs: number): boolean {
  const dateString = toDateString(timestampMs)
  if (!dateString) return false
  return positiveGoldrushPriceCache.has(`${chain}:${token.toLowerCase()}:${dateString}`)
}

// TEST-SUPPORT EXPORT, DISCLOSED: read-only observability into the circuit breaker's state, same
// convention as isKnownGoldrushNegative above — lets a test assert the breaker actually opened
// without needing to reach into this module's private state directly.
export function isGoldrushBreakerOpenForTest(): boolean {
  return goldrushBreakerOpen()
}

// REAL (NON-TEST) EXPORT, DISCLOSED (source-retry-avoidance task, "skip GoldRush for token/chain
// classes already returning unsupported" requirement): src/pipeline/pricingAtTimeAdapter.ts's
// router previously always ATTEMPTED GoldRush for every recovery candidate, even once this file's
// own breaker had already opened after GOLDRUSH_BREAKER_THRESHOLD consecutive misses — the
// underlying call still short-circuited to null at effectively zero cost, but the router still paid
// an await + array-push + its place in the per-candidate ordering for a source already known, for
// the rest of this cooldown window, not to answer. Exported so the router can skip the attempt
// entirely (and, more importantly, let a more-likely source run in GoldRush's place in the ordering)
// instead of just short-circuiting one layer down. Same real breaker state either way — this is not
// a second, separate circuit, just a real read of the one that already exists.
export function isGoldrushCircuitOpen(): boolean {
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
    if (negativeExpiresAt !== undefined && Date.now() < negativeExpiresAt) {
      recordDuplicatePrevented('goldrush', 'negative_cache')
      return null
    }

    // TIME-BUCKET DEDUPE KEY, DISCLOSED: (chain, token, UTC day) — the exact granularity the real
    // query itself uses (getTokenPrices takes YYYY-MM-DD from/to), so two requirements for the same
    // token on the same day genuinely cannot produce different answers and are correctly collapsed
    // onto one call.
    const inFlightKey = `${negativeCacheKey}:${dateString}`

    // PERF-SPRINT TASK, DISCLOSED: checked BEFORE the in-flight/singleflight map below — a genuine,
    // already-settled positive result for this exact (chain, token, day) beats even joining an
    // in-flight promise (there's nothing to join; the answer is already known). See this cache's own
    // declaration above for the full "why this is 100% accuracy-safe" disclosure.
    const cachedPositive = positiveGoldrushPriceCache.get(inFlightKey)
    if (cachedPositive !== undefined) {
      recordDuplicatePrevented('goldrush', 'request_cache')
      return cachedPositive
    }

    const inFlight = inFlightGoldrushPriceLookups.get(inFlightKey)
    if (inFlight) {
      recordDuplicatePrevented('goldrush', 'singleflight')
      return inFlight
    }

    // HARD PER-SCAN CAP, DISCLOSED (cost-audit finding B.3 — see
    // docs/wallet-provider-cost-audit.md). The consecutive-miss breaker above bounds LATENCY, not
    // SPEND: it reopens after its 30s cooldown and this source resumes at full cost, which is
    // exactly how a real measured scan reached 1,045 calls with zero accepted results. This is the
    // shared, scan-wide ceiling on top of it. Checked AFTER the breaker/negative-cache/singleflight
    // short-circuits above, so a question already answerable for free is always served regardless
    // of budget state — the cap only ever refuses a genuinely NEW live call. FAILS CLOSED: returns
    // the same honest null a real miss produces; never a fabricated price, never a retry.
    if (!tryConsume({ provider: 'goldrush', endpoint: 'goldrush_getTokenPrices', chain: chain as SupportedChain, stage: goldrushPriceSourceStage, isPricing: true })) {
      return null
    }

    const lookup = (async (): Promise<number | null> => {
      // PERF-SPRINT TASK, DISCLOSED: real elapsed ms around exactly this network call, feeding
      // getGoldrushLiveCallLatencyStats() — see that function's own header for why (an honest,
      // measured "time saved" estimate for the positive-cache hits above, never a guessed constant).
      const callStartedAtMs = performance.now()
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
          recordCallOutcome('goldrush', false)
          return null
        }

        const items = response.data[0]?.items
        if (!Array.isArray(items) || items.length === 0) {
          negativeGoldrushPriceCache.set(negativeCacheKey, Date.now() + NEGATIVE_PRICE_CACHE_TTL_MS)
          recordGoldrushMiss()
          recordCallOutcome('goldrush', false)
          return null
        }

        const price = items[0]?.price
        if (typeof price === 'number' && Number.isFinite(price)) {
          recordGoldrushSuccess()
          // A real call whose result the scan genuinely consumed — the numerator of the cost
          // audit's own callsWhoseResultWasUsed/Unused split.
          recordCallOutcome('goldrush', true)
          // PERF-SPRINT TASK, DISCLOSED: the one place a genuine, finite price is known — cached
          // here, keyed by the exact (chain, token, day) `inFlightKey` this call itself used, so
          // every later lookup for this key (this scan or a later one) reuses it instead of paying
          // another live call. See positiveGoldrushPriceCache's own declaration for the full "why
          // this is safe" disclosure.
          positiveGoldrushPriceCache.set(inFlightKey, price)
          return price
        }
        negativeGoldrushPriceCache.set(negativeCacheKey, Date.now() + NEGATIVE_PRICE_CACHE_TTL_MS)
        recordGoldrushMiss()
        recordCallOutcome('goldrush', false)
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
      } finally {
        // PERF-SPRINT TASK, DISCLOSED: measures every real attempt (success, "no data" miss, or a
        // thrown timeout/error) uniformly — an honest average real-provider round-trip time, not
        // just the subset that happened to succeed.
        goldrushLiveCallTotalMs += performance.now() - callStartedAtMs
        goldrushLiveCallCount += 1
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

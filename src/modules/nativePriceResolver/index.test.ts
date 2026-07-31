import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  NATIVE_PRICE_BUCKET_MS,
  isEthNativeChain,
  nativePriceBucketStart,
  prefetchNativeUsdPrices,
  readPrefetchedNativeUsdPrice,
  resolveHistoricalNativeUsdPrice,
  getNativePriceResolverDiagnostics,
  resetNativePriceResolverForScan,
  registerIndependentNativePriceSource,
  __resetNativePriceResolverForTest,
  __seedAcceptedNativePriceForTest,
} from './index'
import { resetCoingeckoCircuitBreaker } from '../pricingAtTimeEngine/sources/coingecko'

// A real past instant, used across every case. Mid-day so bucket-distance assertions are meaningful.
const TRADE_MS = Date.UTC(2026, 4, 11, 13, 45, 0)
const SAME_DAY_LATER_MS = Date.UTC(2026, 4, 11, 22, 5, 0)
const NEXT_DAY_MS = Date.UTC(2026, 4, 12, 9, 0, 0)
const NOW_MS = Date.UTC(2026, 6, 1, 0, 0, 0)

const NATIVE_HISTORY_BODY = JSON.stringify({ market_data: { current_price: { usd: 3000 } } })
const CONTRACT_RANGE_BODY = JSON.stringify({ prices: [[1000, 2950]] })

const originalFetch = global.fetch

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

// Installs a CoinGecko mock that answers each real endpoint independently, so a test can make the
// native route fail while the contract route succeeds (or vice versa) and observe the real chain.
function mockCoingecko(handlers: { nativeHistory?: () => Response; contractRange?: () => Response }): { calls: string[] } {
  const calls: string[] = []
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    // GeckoTerminal is a DIFFERENT host and must be routed separately — folding it into the CoinGecko
    // contract branch would misattribute its request and hide whether the CoinGecko quota was spent.
    if (url.includes('api.geckoterminal.com')) {
      calls.push('geckoterminal')
      return new Response('{}', { status: 500 })
    }
    if (url.includes('/coins/ethereum/history')) {
      calls.push('native_history')
      return handlers.nativeHistory ? handlers.nativeHistory() : new Response('{}', { status: 500 })
    }
    calls.push('contract_range')
    return handlers.contractRange ? handlers.contractRange() : new Response('{}', { status: 500 })
  }) as unknown as typeof fetch
  return { calls }
}

beforeEach(() => {
  __resetNativePriceResolverForTest()
  // coingecko.ts keeps its own per-scan breaker and native-date cache; production clears both once
  // per scan via walletScanWorker, so the equivalent per-case reset belongs here.
  resetCoingeckoCircuitBreaker()
  // No network in this environment — every test that wants a source to answer installs its own mock.
  global.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = originalFetch
})

test('bucket is one UTC day and distance is reported honestly', () => {
  const bucket = nativePriceBucketStart(TRADE_MS)
  assert.equal(bucket, Date.UTC(2026, 4, 11, 0, 0, 0))
  assert.equal(nativePriceBucketStart(SAME_DAY_LATER_MS), bucket)
  assert.notEqual(nativePriceBucketStart(NEXT_DAY_MS), bucket)
  assert.equal(NATIVE_PRICE_BUCKET_MS, 86_400_000)
})

test('Base, Ethereum and Arbitrum are ETH-native; hyperevm is not', () => {
  assert.equal(isEthNativeChain('base'), true)
  assert.equal(isEthNativeChain('eth'), true)
  assert.equal(isEthNativeChain('arbitrum'), true)
  assert.equal(isEthNativeChain('hyperevm'), false)
})

test('an ineligible chain fails closed — never served an ETH price', async () => {
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'goldrush_historical')
  const result = await resolveHistoricalNativeUsdPrice({ chain: 'hyperevm', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(result, null)
  assert.equal(getNativePriceResolverDiagnostics().rejectedIneligibleChain, 1)
})

test('a future timestamp fails closed — a current price is never historical proof', async () => {
  __seedAcceptedNativePriceForTest(NOW_MS + NATIVE_PRICE_BUCKET_MS * 5, 9999, 'goldrush_historical')
  const result = await resolveHistoricalNativeUsdPrice({
    chain: 'base',
    timestamp: NOW_MS + NATIVE_PRICE_BUCKET_MS * 5,
    nowMs: NOW_MS,
  })
  assert.equal(result, null)
  assert.equal(getNativePriceResolverDiagnostics().rejectedInvalidTimestamp, 1)
})

test('an invalid timestamp fails closed, never guessed', async () => {
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: bad, nowMs: NOW_MS }), null)
  }
  assert.equal(getNativePriceResolverDiagnostics().rejectedInvalidTimestamp, 4)
})

// ─── THE PRODUCTION FAILURE THIS REVISION FIXES ──────────────────────────────────────────────────

test('primary returns 429 and the INDEPENDENT source succeeds — the exact production failure, now recovered', async () => {
  // GoldRush is registered and answers. CoinGecko would 429, exactly as production showed.
  registerIndependentNativePriceSource(async () => 3120.5)
  mockCoingecko({ nativeHistory: () => new Response('{}', { status: 429 }) })

  const result = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })

  assert.equal(result?.priceUsd, 3120.5)
  assert.equal(result?.source, 'goldrush_historical')
  assert.equal(result?.confidence, 'verified')

  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(diagnostics.acceptedResolutions, 1)
  assert.equal(diagnostics.successesBySource.goldrush_historical, 1)
  // The independent source is FIRST, so the exhausted CoinGecko quota is never even touched.
  assert.equal(diagnostics.attemptsBySource.coingecko_native_coin_history, 0)
})

test('independent source unavailable, CoinGecko native 429s, and the second CoinGecko endpoint is correctly reported as sharing the exhausted quota', async () => {
  // No GoldRush key configured — the previous revision's exact situation: CoinGecko falling back to
  // CoinGecko. The audit must now show WHY that cannot work, rather than an opaque "no price".
  registerIndependentNativePriceSource(null)
  const { calls } = mockCoingecko({ nativeHistory: () => new Response('{}', { status: 429 }) })

  const result = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(result, null)

  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(diagnostics.failureReasonsBySource.goldrush_historical['goldrush_source_not_configured'], 1)
  assert.equal(diagnostics.failureReasonsBySource.coingecko_native_coin_history['coingecko_http_429'], 1)
  // The contract endpoint is SKIPPED, explicitly attributed to the shared quota — not silently retried.
  assert.equal(diagnostics.failureReasonsBySource.coingecko_weth_contract_history['skipped_quota_group_already_exhausted'], 1)
  assert.equal(calls.filter((c) => c === 'contract_range').length, 0, 'a guaranteed-failing same-quota call must not be spent')
  assert.equal(diagnostics.httpStatusesBySource.coingecko_native_coin_history['429'], 1)
  assert.deepEqual(diagnostics.unresolvedBuckets, ['2026-05-11'])
})

test('primary malformed response, fallback succeeds', async () => {
  registerIndependentNativePriceSource(null)
  // Native history returns 200 with a shape that carries no usable price; the contract endpoint does.
  mockCoingecko({
    nativeHistory: () => new Response(JSON.stringify({ market_data: {} }), { status: 200 }),
    contractRange: () => new Response(CONTRACT_RANGE_BODY, { status: 200 }),
  })

  const result = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })

  assert.equal(result?.priceUsd, 2950)
  assert.equal(result?.source, 'coingecko_weth_contract_history')
  const diagnostics = getNativePriceResolverDiagnostics()
  // A malformed 200 is NOT a quota signal, so the same-quota fallback is correctly still attempted.
  assert.equal(diagnostics.attemptsBySource.coingecko_weth_contract_history, 1)
  assert.equal(diagnostics.attemptLog[0].fallbackRan, true)
  assert.equal(diagnostics.attemptLog[0].retried, false)
})

test('every source fails => unavailable, never a fabricated value', async () => {
  registerIndependentNativePriceSource(async () => null)
  mockCoingecko({
    nativeHistory: () => new Response(JSON.stringify({}), { status: 200 }),
    contractRange: () => new Response(JSON.stringify({ prices: [] }), { status: 200 }),
  })

  const result = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(result, null)
  assert.notEqual(result, 0)

  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(diagnostics.sourceAttempts, 4, 'all four sources genuinely attempted when no quota is exhausted')
  assert.equal(diagnostics.sourceSuccesses, 0)
  assert.equal(diagnostics.acceptedResolutions, 0)
})

test('the per-attempt audit record carries every field the audit brief requires, and no secret', async () => {
  registerIndependentNativePriceSource(null)
  mockCoingecko({ nativeHistory: () => new Response('{}', { status: 429 }) })
  await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: TRADE_MS, nowMs: NOW_MS })

  const { attemptLog } = getNativePriceResolverDiagnostics()
  assert.equal(attemptLog.length, 4)
  for (const attempt of attemptLog) {
    assert.equal(attempt.bucketDateUtc, '2026-05-11')
    assert.equal(attempt.bucketStartMs, nativePriceBucketStart(TRADE_MS))
    assert.ok(attempt.source)
    assert.ok(attempt.quotaGroup)
    assert.ok(attempt.endpoint)
    assert.equal(attempt.retried, false)
    assert.ok('httpStatus' in attempt && 'responseShape' in attempt && 'parsedValue' in attempt)
    assert.ok(attempt.rejectionReason, 'a failed attempt must state why')
    assert.ok(!/api[-_]?key|x-cg-|0x[a-f0-9]{32}/i.test(attempt.endpoint), 'endpoint must never carry a secret')
  }
  // Quota grouping is explicit: the two CoinGecko endpoints share one group, GoldRush does not.
  assert.equal(attemptLog.filter((a) => a.quotaGroup === 'coingecko').length, 2)
  assert.equal(attemptLog.filter((a) => a.quotaGroup === 'goldrush').length, 1)
  assert.equal(attemptLog.filter((a) => a.quotaGroup === 'geckoterminal').length, 1)
})

// ─── GECKOTERMINAL: THE INDEPENDENT SOURCE ADDED AFTER GOLDRUSH ALSO CAME BACK EMPTY ─────────────

const GT_ETH_POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'
const TRADE_BUCKET_SEC = nativePriceBucketStart(TRADE_MS) / 1000

function gtCandle(timestampSec: number, close: number): unknown {
  return [timestampSec, close * 0.99, close * 1.02, close * 0.97, close, 1_000_000]
}

// Answers GeckoTerminal OHLCV; every other host is failed so nothing else can accidentally satisfy.
function mockGeckoTerminal(rows: unknown[], status = 200): { geckoCalls: number } {
  const counters = { geckoCalls: 0 }
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes('api.geckoterminal.com')) {
      counters.geckoCalls += 1
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: rows } } }), { status })
    }
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch
  return counters
}

test('GoldRush returns null and GeckoTerminal succeeds — the exact current production failure, recovered', async () => {
  registerIndependentNativePriceSource(async () => null) // 25/25 goldrush_no_price, as production showed
  const counters = mockGeckoTerminal([gtCandle(TRADE_BUCKET_SEC, 3120.5)])

  // The production path: prefetch primes ONE bounded range, then every bucket resolves from it.
  const prefetched = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  const result = readPrefetchedNativeUsdPrice(prefetched, TRADE_MS)

  assert.equal(result?.priceUsd, 3120.5)
  assert.equal(result?.source, 'geckoterminal_eth_ohlcv')
  assert.equal(result?.confidence, 'verified')
  // Provenance is preserved on the resolution itself, not just in a log.
  assert.equal(result?.poolAddress, GT_ETH_POOL)
  assert.equal(result?.candleTimestampMs, nativePriceBucketStart(TRADE_MS))
  assert.equal(counters.geckoCalls, 1)

  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(diagnostics.successesBySource.geckoterminal_eth_ohlcv, 1)
  assert.equal(diagnostics.failureReasonsBySource.goldrush_historical['goldrush_no_price'], 1)
  // Ordered after GoldRush and before CoinGecko — the CoinGecko group is never reached.
  assert.equal(diagnostics.attemptsBySource.coingecko_native_coin_history, 0)
  assert.deepEqual(diagnostics.acceptedBuckets, ['2026-05-11'])
  assert.equal(diagnostics.selectedPools[0].poolAddress, GT_ETH_POOL)
  assert.equal(diagnostics.selectedPools[0].candleTimestampMs, nativePriceBucketStart(TRADE_MS))
})

test('an open CoinGecko breaker does NOT block GeckoTerminal — separate quota groups', async () => {
  registerIndependentNativePriceSource(async () => null)
  // Trip the real CoinGecko breaker first, exactly as production had it.
  mockCoingecko({ nativeHistory: () => new Response('{}', { status: 429 }) })
  await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: NEXT_DAY_MS, nowMs: NOW_MS })

  const counters = mockGeckoTerminal([gtCandle(TRADE_BUCKET_SEC, 3120.5)])
  const prefetched = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  const result = readPrefetchedNativeUsdPrice(prefetched, TRADE_MS)

  assert.equal(result?.priceUsd, 3120.5)
  assert.equal(result?.source, 'geckoterminal_eth_ohlcv')
  assert.equal(counters.geckoCalls, 1, 'GeckoTerminal must still be attempted while CoinGecko is exhausted')
})

test('a GeckoTerminal provider miss still falls through, and if nothing answers the bucket is unavailable', async () => {
  registerIndependentNativePriceSource(async () => null)
  // GeckoTerminal has no candle for the requested day; CoinGecko answers nothing either.
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes('api.geckoterminal.com')) {
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [gtCandle(TRADE_BUCKET_SEC - 86_400, 2900)] } } }), { status: 200 })
    }
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch

  const prefetched = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  const result = readPrefetchedNativeUsdPrice(prefetched, TRADE_MS)
  assert.equal(result, null)

  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(
    diagnostics.failureReasonsBySource.geckoterminal_eth_ohlcv['geckoterminal_no_candle_for_requested_utc_day'],
    1,
    'a stale/adjacent candle must be rejected, never substituted',
  )
  assert.equal(diagnostics.acceptedResolutions, 0)
  assert.deepEqual(diagnostics.unresolvedBuckets, ['2026-05-11'])
})

test('a GeckoTerminal-accepted day serves Base, Ethereum and Arbitrum consumers with no second request', async () => {
  registerIndependentNativePriceSource(async () => null)
  const counters = mockGeckoTerminal([gtCandle(TRADE_BUCKET_SEC, 3120.5)])

  const prefetched = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  const base = readPrefetchedNativeUsdPrice(prefetched, TRADE_MS)
  const eth = await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })
  // Arbitrum has no allowlisted pool of its own, yet is served correctly — one accepted ETH/USD day is
  // chain-independent, which is the entire basis of the shared cache.
  const arb = await resolveHistoricalNativeUsdPrice({ chain: 'arbitrum', timestamp: TRADE_MS + 60_000, nowMs: NOW_MS })

  assert.equal(base?.priceUsd, 3120.5)
  assert.equal(eth?.priceUsd, 3120.5)
  assert.equal(arb?.priceUsd, 3120.5)
  assert.equal(counters.geckoCalls, 1, 'a cached day must cause no second network request')
  assert.equal(getNativePriceResolverDiagnostics().permanentCacheHits, 2)
})

test('a GeckoTerminal-accepted day survives a scan reset with no second network request', async () => {
  registerIndependentNativePriceSource(async () => null)
  const counters = mockGeckoTerminal([gtCandle(TRADE_BUCKET_SEC, 3120.5)])

  const firstPrefetch = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  assert.equal(readPrefetchedNativeUsdPrice(firstPrefetch, TRADE_MS)?.priceUsd, 3120.5)

  resetNativePriceResolverForScan()

  // A new scan: the accepted day is already known, so the range prime is skipped entirely.
  const secondPrefetch = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  const second = readPrefetchedNativeUsdPrice(secondPrefetch, TRADE_MS)
  assert.equal(second?.priceUsd, 3120.5)
  assert.equal(second?.servedFromPermanentCache, true)
  assert.equal(second?.poolAddress, GT_ETH_POOL, 'provenance survives the cache too')
  assert.equal(counters.geckoCalls, 1, 'a cached day must trigger no second range request')
})

test('same-day consumers coalesce onto one GeckoTerminal request', async () => {
  registerIndependentNativePriceSource(async () => null)
  let geckoCalls = 0
  global.fetch = (async (input: RequestInfo | URL) => {
    if (urlOf(input).includes('api.geckoterminal.com')) {
      geckoCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [gtCandle(TRADE_BUCKET_SEC, 3120.5)] } } }), { status: 200 })
    }
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch

  // Prime once (one bounded range), then three same-day consumers resolve with no further request.
  await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  const [a, b, c] = await Promise.all([
    resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS }),
    resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS }),
    resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS + 5_000, nowMs: NOW_MS }),
  ])

  assert.equal(geckoCalls, 1, 'three same-day consumers share exactly one real request')
  assert.equal(a?.priceUsd, 3120.5)
  assert.equal(b?.priceUsd, 3120.5)
  assert.equal(c?.priceUsd, 3120.5)
  // Under the range architecture the prime resolves and accepts the day up front, so the three
  // consumers are served by the accepted-day cache rather than by in-flight coalescing. Both paths
  // spend zero additional requests; in-flight coalescing itself is still exercised directly by the
  // GoldRush coalescing test above, where no prime precedes the concurrent callers.
  assert.equal(getNativePriceResolverDiagnostics().permanentCacheHits, 3)
})

test('a GeckoTerminal failure is scan-scoped, not permanent', async () => {
  registerIndependentNativePriceSource(async () => null)
  let geckoCalls = 0
  global.fetch = (async (input: RequestInfo | URL) => {
    if (urlOf(input).includes('api.geckoterminal.com')) {
      geckoCalls += 1
      const rows = geckoCalls <= 2 ? [] : [gtCandle(TRADE_BUCKET_SEC, 3120.5)]
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: rows } } }), { status: 200 })
    }
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch

  const firstPrefetch = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  assert.equal(readPrefetchedNativeUsdPrice(firstPrefetch, TRADE_MS), null)
  // Same scan: the doomed bucket is not retried.
  await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })
  assert.ok(geckoCalls <= 2, 'at most the two allowlisted pools, never a retry')
  const callsAfterFirstScan = geckoCalls

  resetNativePriceResolverForScan()

  const recoveredPrefetch = await prefetchNativeUsdPrices({ requirements: [{ chain: 'base', timestamp: TRADE_MS }], nowMs: NOW_MS })
  const recovered = readPrefetchedNativeUsdPrice(recoveredPrefetch, TRADE_MS)
  assert.equal(recovered?.priceUsd, 3120.5, 'a new scan may legitimately retry a transiently failed day')
  assert.ok(geckoCalls > callsAfterFirstScan)
})

// ─── SHARING, COALESCING AND CACHING ─────────────────────────────────────────────────────────────

test('one accepted bucket price serves Base ETH, Ethereum ETH and WETH consumers for that day', async () => {
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'goldrush_historical')

  const base = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  const eth = await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })
  const arb = await resolveHistoricalNativeUsdPrice({ chain: 'arbitrum', timestamp: TRADE_MS + 60_000, nowMs: NOW_MS })

  // The SAME accepted ETH/USD figure serves every ETH-native chain and both the native and WETH
  // aliases — that identity is the entire basis of the coalescing win.
  assert.equal(base?.priceUsd, 3120.5)
  assert.equal(eth?.priceUsd, 3120.5)
  assert.equal(arb?.priceUsd, 3120.5)
  assert.equal(base?.servedFromPermanentCache, true)

  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(diagnostics.permanentCacheHits, 3)
  assert.equal(diagnostics.liveBucketRequests, 0)
})

test('same-day consumers coalesce onto one in-flight resolution covering the whole source chain', async () => {
  let goldrushCalls = 0
  registerIndependentNativePriceSource(async () => {
    goldrushCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return 3120.5
  })

  const [a, b, c] = await Promise.all([
    resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS }),
    resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS }),
    resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS + 5_000, nowMs: NOW_MS }),
  ])

  assert.equal(goldrushCalls, 1, 'three same-day consumers must share exactly one real resolution')
  assert.equal(a?.priceUsd, 3120.5)
  assert.equal(b?.priceUsd, 3120.5)
  assert.equal(c?.priceUsd, 3120.5)
  assert.equal(getNativePriceResolverDiagnostics().coalescedHits, 2)
  // Distance stays honest per consumer even when the price is shared.
  assert.notEqual(a?.timestampDistanceMs, b?.timestampDistanceMs)
})

test('timestampDistanceMs is per-consumer honest and always within the bucket', async () => {
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'goldrush_historical')
  const early = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  const late = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })

  assert.equal(early?.bucketStartMs, late?.bucketStartMs)
  assert.equal(early?.timestampDistanceMs, TRADE_MS - nativePriceBucketStart(TRADE_MS))
  assert.equal(late?.timestampDistanceMs, SAME_DAY_LATER_MS - nativePriceBucketStart(SAME_DAY_LATER_MS))
  assert.ok(early!.timestampDistanceMs >= 0 && early!.timestampDistanceMs < NATIVE_PRICE_BUCKET_MS)
})

test('an accepted historical value is cached permanently — it survives a scan reset', async () => {
  let goldrushCalls = 0
  registerIndependentNativePriceSource(async () => {
    goldrushCalls += 1
    return 3120.5
  })

  const first = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(first?.priceUsd, 3120.5)
  assert.equal(goldrushCalls, 1)

  resetNativePriceResolverForScan()

  const second = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(second?.priceUsd, 3120.5)
  assert.equal(second?.servedFromPermanentCache, true)
  assert.equal(goldrushCalls, 1, 'an immutable past day must never be re-fetched')
  assert.equal(getNativePriceResolverDiagnostics().liveBucketRequests, 0)
})

test('a transient failure is NOT cached permanently — the next scan retries that bucket', async () => {
  let goldrushCalls = 0
  registerIndependentNativePriceSource(async () => {
    goldrushCalls += 1
    return goldrushCalls === 1 ? null : 3120.5
  })

  const first = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(first, null)

  // Within the SAME scan the doomed bucket is not retried.
  await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })
  assert.equal(goldrushCalls, 1)

  resetNativePriceResolverForScan()

  // A NEW scan may retry it — and here it genuinely recovers, which a permanent failure cache would
  // have made impossible.
  const afterReset = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(afterReset?.priceUsd, 3120.5)
  assert.ok(goldrushCalls > 1)
})

test('a different day is never served a neighbouring day price', async () => {
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'goldrush_historical')
  registerIndependentNativePriceSource(async () => null)
  const nextDay = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: NEXT_DAY_MS, nowMs: NOW_MS })
  assert.equal(nextDay, null)
})

test('prefetch collapses many requirements into distinct buckets and reads back per-timestamp', async () => {
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'goldrush_historical')

  const prefetched = await prefetchNativeUsdPrices({
    requirements: [
      { chain: 'base', timestamp: TRADE_MS },
      { chain: 'base', timestamp: SAME_DAY_LATER_MS },
      { chain: 'eth', timestamp: TRADE_MS + 1000 },
      { chain: 'eth', timestamp: SAME_DAY_LATER_MS - 5000 },
    ],
  })

  assert.equal(prefetched.size, 1)
  assert.equal(readPrefetchedNativeUsdPrice(prefetched, TRADE_MS)?.priceUsd, 3120.5)
  assert.equal(readPrefetchedNativeUsdPrice(prefetched, SAME_DAY_LATER_MS)?.priceUsd, 3120.5)
  assert.equal(readPrefetchedNativeUsdPrice(prefetched, NEXT_DAY_MS), null)
  assert.equal(getNativePriceResolverDiagnostics().bucketsRequested, 1)
  assert.equal(getNativePriceResolverDiagnostics().liveBucketRequests, 0)
})

test('prefetch drops ineligible chains and invalid timestamps before spending anything', async () => {
  registerIndependentNativePriceSource(async () => 3120.5)
  const prefetched = await prefetchNativeUsdPrices({
    requirements: [
      { chain: 'hyperevm', timestamp: TRADE_MS },
      { chain: 'base', timestamp: Number.NaN },
      { chain: 'eth', timestamp: -5 },
    ],
  })
  assert.equal(prefetched.size, 0)
  assert.equal(getNativePriceResolverDiagnostics().liveBucketRequests, 0)
})

test('seeding rejects a non-price value — a fabricated figure cannot enter the cache', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => __seedAcceptedNativePriceForTest(TRADE_MS, bad, 'goldrush_historical'))
  }
})

import { test } from 'node:test'
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
  __resetNativePriceResolverForTest,
  __seedAcceptedNativePriceForTest,
} from './index'

// A real past instant, used across every case. Mid-day so bucket-distance assertions are meaningful.
const TRADE_MS = Date.UTC(2026, 4, 11, 13, 45, 0)
const SAME_DAY_LATER_MS = Date.UTC(2026, 4, 11, 22, 5, 0)
const NEXT_DAY_MS = Date.UTC(2026, 4, 12, 9, 0, 0)
const NOW_MS = Date.UTC(2026, 6, 1, 0, 0, 0)

test('bucket is one UTC day and distance is reported honestly', () => {
  __resetNativePriceResolverForTest()
  const bucket = nativePriceBucketStart(TRADE_MS)
  assert.equal(bucket, Date.UTC(2026, 4, 11, 0, 0, 0))
  assert.equal(nativePriceBucketStart(SAME_DAY_LATER_MS), bucket)
  assert.notEqual(nativePriceBucketStart(NEXT_DAY_MS), bucket)
  assert.equal(NATIVE_PRICE_BUCKET_MS, 86_400_000)
})

test('Base native ETH, Ethereum native ETH and Arbitrum are ETH-native; hyperevm is not', () => {
  assert.equal(isEthNativeChain('base'), true)
  assert.equal(isEthNativeChain('eth'), true)
  assert.equal(isEthNativeChain('arbitrum'), true)
  assert.equal(isEthNativeChain('hyperevm'), false)
})

test('an ineligible chain fails closed — never served an ETH price', async () => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'coingecko_native_coin_history')
  const result = await resolveHistoricalNativeUsdPrice({ chain: 'hyperevm', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(result, null)
  assert.equal(getNativePriceResolverDiagnostics().rejectedIneligibleChain, 1)
})

test('a future timestamp is rejected — a current price is never historical proof', async () => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(NOW_MS + NATIVE_PRICE_BUCKET_MS * 5, 9999, 'coingecko_native_coin_history')
  const result = await resolveHistoricalNativeUsdPrice({
    chain: 'base',
    timestamp: NOW_MS + NATIVE_PRICE_BUCKET_MS * 5,
    nowMs: NOW_MS,
  })
  assert.equal(result, null)
  assert.equal(getNativePriceResolverDiagnostics().rejectedInvalidTimestamp, 1)
})

test('an invalid timestamp is rejected, never guessed', async () => {
  __resetNativePriceResolverForTest()
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: bad, nowMs: NOW_MS }), null)
  }
})

test('an accepted price is reused across chains and across same-day consumers with zero extra calls', async () => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'coingecko_native_coin_history')

  const base = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  const eth = await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })

  assert.equal(base?.priceUsd, 3120.5)
  // The SAME accepted ETH/USD figure serves Base native ETH and Ethereum native ETH — that identity
  // is the whole basis of the Phase 1 coalescing win.
  assert.equal(eth?.priceUsd, 3120.5)
  assert.equal(base?.confidence, 'verified')
  assert.equal(base?.source, 'coingecko_native_coin_history')
  assert.equal(base?.servedFromPermanentCache, true)
  assert.equal(eth?.servedFromPermanentCache, true)

  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(diagnostics.permanentCacheHits, 2)
  assert.equal(diagnostics.liveBucketRequests, 0)
})

test('timestampDistanceMs is per-consumer honest, not the shared bucket-leader distance', async () => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'coingecko_native_coin_history')

  const early = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  const late = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })

  assert.equal(early?.bucketStartMs, late?.bucketStartMs)
  assert.equal(early?.timestampDistanceMs, TRADE_MS - nativePriceBucketStart(TRADE_MS))
  assert.equal(late?.timestampDistanceMs, SAME_DAY_LATER_MS - nativePriceBucketStart(SAME_DAY_LATER_MS))
  assert.notEqual(early?.timestampDistanceMs, late?.timestampDistanceMs)
  assert.ok(early!.timestampDistanceMs >= 0 && early!.timestampDistanceMs < NATIVE_PRICE_BUCKET_MS)
})

test('the accepted-price cache survives a scan reset — past historical prices are immutable', async () => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'coingecko_native_coin_history')

  resetNativePriceResolverForScan()

  const afterReset = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(afterReset?.priceUsd, 3120.5)
  assert.equal(afterReset?.servedFromPermanentCache, true)
  assert.equal(getNativePriceResolverDiagnostics().liveBucketRequests, 0)
})

test('a different day is never served a neighbouring day price', async () => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'coingecko_native_coin_history')

  // No network is reachable in this environment, so the live path genuinely resolves nothing — which
  // is exactly the assertion: an adjacent, already-accepted bucket is NEVER substituted.
  const nextDay = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: NEXT_DAY_MS, nowMs: NOW_MS })
  assert.equal(nextDay, null)
})

test('prefetch collapses many requirements into distinct buckets and reads back per-timestamp', async () => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(TRADE_MS, 3120.5, 'coingecko_native_coin_history')

  // 4 requirements, all on the same UTC day, across two ETH-native chains — one bucket.
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
  // A day that was never a requirement is genuinely absent — reading it returns null, not a nearby price.
  assert.equal(readPrefetchedNativeUsdPrice(prefetched, NEXT_DAY_MS), null)
  assert.equal(getNativePriceResolverDiagnostics().liveBucketRequests, 0)
})

test('prefetch drops ineligible chains and invalid timestamps before spending anything', async () => {
  __resetNativePriceResolverForTest()
  const prefetched = await prefetchNativeUsdPrices({
    requirements: [
      { chain: 'hyperevm', timestamp: TRADE_MS },
      { chain: 'base', timestamp: Number.NaN },
      { chain: 'eth', timestamp: -5 },
    ],
  })
  assert.equal(prefetched.size, 0)
  const diagnostics = getNativePriceResolverDiagnostics()
  assert.equal(diagnostics.liveBucketRequests, 0)
  assert.equal(diagnostics.rejectedIneligibleChain, 0) // filtered before dispatch, never even attempted
})

test('unavailable stays null and is never upgraded to a fabricated zero or a spot price', async () => {
  __resetNativePriceResolverForTest()
  const result = await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  assert.equal(result, null)
  assert.notEqual(result, 0)
  // Failure is remembered for this scan only — a second ask in the same scan spends nothing more.
  const before = getNativePriceResolverDiagnostics().liveBucketRequests
  await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: SAME_DAY_LATER_MS, nowMs: NOW_MS })
  assert.equal(getNativePriceResolverDiagnostics().liveBucketRequests, before)
})

test('a transient failure is NOT cached permanently — the next scan may retry that bucket', async () => {
  __resetNativePriceResolverForTest()
  await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  const afterFirstScan = getNativePriceResolverDiagnostics().liveBucketRequests
  assert.equal(afterFirstScan, 1)

  resetNativePriceResolverForScan()

  await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: TRADE_MS, nowMs: NOW_MS })
  // Counters were reset, so this scan's own live count starts fresh — proving the bucket was retried
  // rather than being permanently blacklisted by one transient miss.
  assert.equal(getNativePriceResolverDiagnostics().liveBucketRequests, 1)
})

test('seeding rejects a non-price value — a fabricated figure cannot enter the cache', () => {
  __resetNativePriceResolverForTest()
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => __seedAcceptedNativePriceForTest(TRADE_MS, bad, 'coingecko_native_coin_history'))
  }
})

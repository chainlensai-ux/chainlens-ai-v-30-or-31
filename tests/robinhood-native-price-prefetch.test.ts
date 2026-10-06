import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prefetchRobinhoodNativePriceDays } from '../lib/server/robinhoodWalletScanner.ts'
import { RH_NATIVE, RH_WETH, selectRobinhoodNativePriceDays, type RhVerifiedSwap } from '../lib/server/robinhoodPnlV1.ts'
import {
  __resetNativePriceResolverForTest, getNativePriceResolverDiagnostics,
  registerIndependentNativePriceSource, resolveHistoricalNativeUsdPrice,
} from '../src/modules/nativePriceResolver/index.ts'
import { __setNativePriceKvForTest } from '../src/modules/nativePriceResolver/persistentEvidence.ts'
import { resetCoingeckoCircuitBreaker } from '../src/modules/pricingAtTimeEngine/sources/coingecko.ts'

const DAY_MS = 86_400_000
const TS = 1790155166
const BUCKET = Math.floor(TS * 1000 / DAY_MS) * DAY_MS
const PRICE = 2752.629093198004
const originalFetch = global.fetch

function swap(timestampSec: number, inputToken = RH_NATIVE): RhVerifiedSwap {
  return {
    txHash: `0x${timestampSec.toString(16).padStart(64, '0')}`,
    blockNumber: 1, firstLogIndex: 0, timestampSec,
    inputToken, outputToken: '0x1111111111111111111111111111111111111111',
    inputRaw: BigInt(1), outputRaw: BigInt(1), inputDecimals: 18, outputDecimals: 18,
    hops: [], intermediary: null,
  }
}

function mockKv() {
  const records = new Map<string, unknown>()
  let writes = 0
  __setNativePriceKvForTest({
    get: (async (key: string) => records.get(key) ?? null) as never,
    set: (async (key: string, value: unknown, options?: { nx?: boolean }) => {
      writes += 1
      if (options?.nx && records.has(key)) return null
      records.set(key, value)
      return 'OK'
    }) as never,
  })
  return { records, get writes() { return writes } }
}

function mockProviders(native: () => Response) {
  const calls: string[] = []
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    if (url.includes('/coins/ethereum/history')) return native()
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  return calls
}

async function captureAudit(fn: () => Promise<void>) {
  const audit: Record<string, unknown>[] = []
  const previous = console.warn
  console.warn = (...args: unknown[]) => {
    if (args[0] === '[robinhood-native-price-prefetch-audit]') audit.push(args[1] as Record<string, unknown>)
  }
  try { await fn() } finally { console.warn = previous }
  assert.equal(audit.length, 1)
  return audit[0]
}

beforeEach(() => {
  __resetNativePriceResolverForTest()
  __setNativePriceKvForTest(null)
  resetCoingeckoCircuitBreaker()
})
afterEach(() => { __setNativePriceKvForTest(null); global.fetch = originalFetch })

test('cold Robinhood native day resolves and persists before broad pricing; next worker hits KV with no provider', async () => {
  const kv = mockKv()
  const calls = mockProviders(() => new Response(JSON.stringify({ market_data: { current_price: { usd: PRICE } } }), { status: 200 }))
  const first = await captureAudit(() => prefetchRobinhoodNativePriceDays([swap(TS)]))
  assert.deepEqual(first.requestedBuckets, [BUCKET])
  assert.deepEqual(first.resolvedBuckets, [BUCKET])
  assert.equal(first.liveAttempts, 1)
  assert.equal(first.persistedWrites, 1)
  assert.equal(first.sourceByBucket && (first.sourceByBucket as Record<string, string>)[BUCKET], 'coingecko_native_coin_history')
  assert.equal(kv.writes, 1)
  assert.ok(calls.some((url) => url.includes('/coins/ethereum/history')))

  __resetNativePriceResolverForTest() // new worker, same persistent KV
  resetCoingeckoCircuitBreaker()
  const failedProviderCalls = mockProviders(() => new Response('{}', { status: 429 }))
  const second = await captureAudit(() => prefetchRobinhoodNativePriceDays([swap(TS)]))
  assert.equal(second.persistentHits, 1)
  assert.equal(second.liveAttempts, 0)
  assert.equal(second.persistedWrites, 0)
  assert.deepEqual(failedProviderCalls, [])
  assert.equal((await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: TS * 1000 }))?.priceUsd, PRICE)
})

test('broad historical provider exhaustion after the reservation does not erase the Robinhood price', async () => {
  mockKv()
  mockProviders(() => new Response(JSON.stringify({ market_data: { current_price: { usd: PRICE } } }), { status: 200 }))
  await captureAudit(() => prefetchRobinhoodNativePriceDays([swap(TS)]))
  mockProviders(() => new Response('{}', { status: 429 }))
  await resolveHistoricalNativeUsdPrice({ chain: 'base', timestamp: (TS - 5 * 86_400) * 1000 })
  assert.equal((await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: TS * 1000 }))?.priceUsd, PRICE)
})

test('only native-leg verified swaps qualify; distinct UTC days are capped at three', async () => {
  const kv = mockKv()
  registerIndependentNativePriceSource(async () => 3000)
  mockProviders(() => new Response('{}', { status: 429 }))
  const swaps = [swap(TS), swap(TS + 30), swap(TS - 86_400, RH_WETH), swap(TS - 2 * 86_400), swap(TS - 3 * 86_400), swap(TS - 4 * 86_400, '0x2222222222222222222222222222222222222222')]
  const selection = selectRobinhoodNativePriceDays(swaps)
  assert.equal(selection.requestedBuckets.length, 4)
  assert.equal(selection.selectedTimestampsSec.length, 3)
  assert.equal(selection.skippedByCap, 1)
  const audit = await captureAudit(() => prefetchRobinhoodNativePriceDays(swaps))
  assert.equal((audit.resolvedBuckets as number[]).length, 3)
  assert.equal(audit.skippedByCap, 1)
  assert.equal(audit.liveAttempts, 3)
  assert.equal(audit.persistedWrites, 3)
  assert.equal(kv.writes, 3)
})

test('429 remains unpriced with no durable record or current/spot fallback', async () => {
  const kv = mockKv()
  const calls = mockProviders(() => new Response('{}', { status: 429 }))
  const audit = await captureAudit(() => prefetchRobinhoodNativePriceDays([swap(TS)]))
  assert.deepEqual(audit.unresolvedBuckets, [BUCKET])
  assert.equal(audit.persistedWrites, 0)
  assert.equal(kv.writes, 0)
  assert.equal((await resolveHistoricalNativeUsdPrice({ chain: 'eth', timestamp: TS * 1000 }))?.priceUsd ?? null, null)
  assert.equal(calls.some((url) => url.includes('/simple/price') || url.includes('/coins/ethereum/market_chart/range')), false)
  assert.equal(getNativePriceResolverDiagnostics().acceptedResolutions, 0)
})

test('an open current UTC day is not reserved or persisted from a spot-adjacent quote', async () => {
  const kv = mockKv()
  registerIndependentNativePriceSource(async () => 3000)
  const calls = mockProviders(() => new Response('{}', { status: 500 }))
  const nowSec = Math.floor(Date.now() / 1000)
  const audit = await captureAudit(() => prefetchRobinhoodNativePriceDays([swap(nowSec)]))
  assert.deepEqual(audit.requestedBuckets, [])
  assert.equal(audit.liveAttempts, 0)
  assert.equal(kv.writes, 0)
  assert.deepEqual(calls, [])
})

test('the worker and orchestrator release broad EVM pricing only after the Robinhood prefetch signal', () => {
  const worker = readFileSync(resolve('workers/walletScanV2.ts'), 'utf8')
  const orchestrator = readFileSync(resolve('lib/server/walletScanOrchestrator.ts'), 'utf8')
  assert.ok(worker.indexOf('await withScanTimeout(nativePricePriorityReady') < worker.indexOf('const fastSnapshotPromise = computeFastSnapshot()'))
  assert.ok(worker.indexOf('await withScanTimeout(nativePricePriorityReady') < worker.indexOf('const corePromise = withScanTimeout('))
  assert.ok(orchestrator.indexOf('await nativePricePriorityReady') < orchestrator.indexOf('evmReport = await runV2Scan('))
})

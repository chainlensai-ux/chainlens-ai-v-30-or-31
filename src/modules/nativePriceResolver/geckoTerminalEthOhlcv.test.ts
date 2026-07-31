import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWLISTED_ETH_USD_POOLS,
  MAX_GECKOTERMINAL_RANGE_REQUESTS_PER_SCAN,
  allowlistedPoolForChain,
  getGeckoTerminalEthOhlcvRequestCount,
  getGeckoTerminalRangeDiagnostics,
  isGeckoTerminalQuotaStopped,
  parseCandleRow,
  primeGeckoTerminalRangeForBuckets,
  readGeckoTerminalEthUsdForUtcDay,
  resetGeckoTerminalEthOhlcvForScan,
} from './geckoTerminalEthOhlcv'

const DAY_MS = 86_400_000
const BUCKET_MS = Date.UTC(2026, 4, 11, 0, 0, 0)
const BUCKET_SEC = BUCKET_MS / 1000

const ETH_POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'
const ETH_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const BASE_POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224'
const BASE_WETH = '0x4200000000000000000000000000000000000006'

const originalFetch = global.fetch

function candle(timestampSec: number, close: number): [number, number, number, number, number, number] {
  return [timestampSec, close * 0.99, close * 1.02, close * 0.97, close, 1_000_000]
}

function ohlcvBody(rows: unknown[], meta?: unknown): string {
  return JSON.stringify({ data: { attributes: { ohlcv_list: rows } }, ...(meta ? { meta } : {}) })
}

// Routes by pool address so a test can make the Ethereum pool fail and the Base pool answer.
function mockPools(handlers: { eth?: () => Response; base?: () => Response }): { urls: string[] } {
  const urls: string[] = []
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    urls.push(url)
    if (url.includes(ETH_POOL)) return handlers.eth ? handlers.eth() : new Response('{}', { status: 500 })
    if (url.includes(BASE_POOL)) return handlers.base ? handlers.base() : new Response('{}', { status: 500 })
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch
  return { urls }
}

beforeEach(() => {
  resetGeckoTerminalEthOhlcvForScan()
})

afterEach(() => {
  global.fetch = originalFetch
})

test('the pool allowlist is fixed, Ethereum first, with canonical WETH addresses', () => {
  assert.equal(ALLOWLISTED_ETH_USD_POOLS.length, 2)
  // Ethereum is attempted first — the deepest ETH/USD venue.
  assert.equal(ALLOWLISTED_ETH_USD_POOLS[0].chain, 'eth')
  assert.equal(ALLOWLISTED_ETH_USD_POOLS[0].poolAddress, ETH_POOL)
  assert.equal(allowlistedPoolForChain('base')?.poolAddress, BASE_POOL)
  assert.equal(allowlistedPoolForChain('base')?.wethAddress, BASE_WETH)
  assert.equal(allowlistedPoolForChain('eth')?.wethAddress, ETH_WETH)
  // No pool reviewed for these — never discovered dynamically.
  assert.equal(allowlistedPoolForChain('arbitrum'), null)
  assert.equal(allowlistedPoolForChain('hyperevm'), null)
})

test('ONE range request resolves many required days — the fix for 25 requests / 25 HTTP 429s', async () => {
  const requiredBuckets = Array.from({ length: 25 }, (_, i) => BUCKET_MS + i * DAY_MS)
  const rows = requiredBuckets.map((b, i) => candle(b / 1000, 3000 + i))
  const { urls } = mockPools({ eth: () => new Response(ohlcvBody(rows), { status: 200 }) })

  const diagnostics = await primeGeckoTerminalRangeForBuckets(requiredBuckets)

  assert.equal(urls.length, 1, '25 required days must cost exactly ONE request')
  assert.equal(getGeckoTerminalEthOhlcvRequestCount(), 1)
  assert.equal(diagnostics.requiredBucketCount, 25)
  assert.equal(diagnostics.rangeRequests, 1)
  assert.equal(diagnostics.candlesReturned, 25)
  assert.equal(diagnostics.exactDaysMatched, 25)
  assert.deepEqual(diagnostics.missingDays, [])
  assert.equal(diagnostics.rangeStartUtc, '2026-05-11')
  assert.equal(diagnostics.rangeEndUtc, new Date(BUCKET_MS + 24 * DAY_MS).toISOString().slice(0, 10))

  // Every bucket now resolves locally, with zero further requests.
  for (let i = 0; i < 25; i += 1) {
    const hit = readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: requiredBuckets[i] })
    assert.equal(hit.priceUsd, 3000 + i)
    assert.equal(hit.poolAddress, ETH_POOL)
    assert.equal(hit.candleTimestampMs, requiredBuckets[i])
  }
  assert.equal(urls.length, 1, 'reads must never issue a request')
})

test('the range request carries the explicit WETH token parameter, a bounded limit and a historical anchor', async () => {
  const { urls } = mockPools({ eth: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }) })
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS, BUCKET_MS + 3 * DAY_MS])

  const url = urls[0]
  assert.ok(url.includes(`/pools/${ETH_POOL}/ohlcv/day`))
  assert.ok(url.includes(`token=${ETH_WETH}`), 'the WETH side must be requested explicitly, never the stablecoin side')
  assert.ok(url.includes('currency=usd'))
  assert.ok(url.includes('before_timestamp='), 'must anchor to the historical window, never "now"')
  const limit = Number(new URL(url).searchParams.get('limit'))
  assert.ok(limit > 0 && limit <= 1000, 'limit must be bounded')
})

test('the Base pool is used only as a second INDEPENDENT pool fallback, and never more than 2 requests', async () => {
  const { urls } = mockPools({
    eth: () => new Response(ohlcvBody([]), { status: 200 }), // Ethereum pool genuinely returns nothing
    base: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }),
  })

  const diagnostics = await primeGeckoTerminalRangeForBuckets([BUCKET_MS])

  assert.equal(urls.length, 2)
  assert.ok(urls[0].includes(ETH_POOL), 'Ethereum pool first')
  assert.ok(urls[1].includes(BASE_POOL), 'Base pool second — a different venue, not a retry')
  assert.equal(diagnostics.rangeRequests, MAX_GECKOTERMINAL_RANGE_REQUESTS_PER_SCAN)
  assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS }).priceUsd, 3120.5)
  assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS }).poolAddress, BASE_POOL)
})

test('the Base pool is NOT requested when the Ethereum range already covered every required day', async () => {
  const { urls } = mockPools({ eth: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }) })
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS])
  assert.equal(urls.length, 1, 'no second request when nothing is missing')
})

test('HTTP 429 stops the GeckoTerminal quota group for the scan — the second pool is not attempted', async () => {
  const { urls } = mockPools({
    eth: () => new Response('{}', { status: 429 }),
    base: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }),
  })

  const diagnostics = await primeGeckoTerminalRangeForBuckets([BUCKET_MS])

  assert.equal(urls.length, 1, 'a 429 must stop the quota group, not roll on to the next pool')
  assert.equal(isGeckoTerminalQuotaStopped(), true)
  assert.equal(diagnostics.quotaStopped, true)
  assert.equal(diagnostics.httpStatuses[0].status, 429)
  const read = readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS })
  assert.equal(read.priceUsd, null)
  assert.equal(read.rejectionReason, 'geckoterminal_quota_stopped_this_scan')
})

test('priming is once per scan and resets per scan', async () => {
  const { urls } = mockPools({ eth: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }) })
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS])
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS, BUCKET_MS + DAY_MS])
  assert.equal(urls.length, 1, 'a second prime in the same scan must not re-fetch')

  resetGeckoTerminalEthOhlcvForScan()
  assert.equal(getGeckoTerminalEthOhlcvRequestCount(), 0)
  assert.equal(isGeckoTerminalQuotaStopped(), false)
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS])
  assert.equal(urls.length, 2, 'a new scan may prime again')
})

test('a day genuinely absent from the returned range is reported missing and fails closed', async () => {
  const present = BUCKET_MS
  const absent = BUCKET_MS + 5 * DAY_MS
  mockPools({
    eth: () => new Response(ohlcvBody([candle(present / 1000, 3120.5)]), { status: 200 }),
    base: () => new Response(ohlcvBody([]), { status: 200 }),
  })

  const diagnostics = await primeGeckoTerminalRangeForBuckets([present, absent])

  assert.equal(diagnostics.exactDaysMatched, 1)
  assert.deepEqual(diagnostics.missingDays, [new Date(absent).toISOString().slice(0, 10)])
  const read = readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: absent })
  assert.equal(read.priceUsd, null)
  assert.equal(read.rejectionReason, 'geckoterminal_no_candle_for_requested_utc_day')
})

test('an adjacent/stale candle is never substituted for a requested day', async () => {
  mockPools({
    eth: () => new Response(ohlcvBody([candle((BUCKET_MS - DAY_MS) / 1000, 2900), candle((BUCKET_MS + DAY_MS) / 1000, 3300)]), { status: 200 }),
    base: () => new Response(ohlcvBody([]), { status: 200 }),
  })
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS])

  const read = readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS })
  assert.equal(read.priceUsd, null, 'neighbouring days must not fill the requested day')
  // The neighbours ARE indexed under their own days — correct, and provably not cross-assigned.
  assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS - DAY_MS }).priceUsd, 2900)
})

test('malformed, zero, negative and non-day-aligned candles are excluded from the index', async () => {
  mockPools({
    eth: () =>
      new Response(
        ohlcvBody([
          [BUCKET_SEC, 1, 2], // too short
          [BUCKET_SEC + 3600, 1, 2, 3, 3120.5, 5], // not UTC-day aligned
          [BUCKET_SEC + DAY_MS / 1000, 1, 2, 3, 0, 5], // zero close
          [BUCKET_SEC + (2 * DAY_MS) / 1000, 1, 2, 3, -10, 5], // negative close
          [BUCKET_SEC + (3 * DAY_MS) / 1000, 1, 2, 3, 'nope', 5], // non-numeric close
        ]),
        { status: 200 },
      ),
    base: () => new Response(ohlcvBody([]), { status: 200 }),
  })

  const diagnostics = await primeGeckoTerminalRangeForBuckets([BUCKET_MS, BUCKET_MS + DAY_MS, BUCKET_MS + 2 * DAY_MS, BUCKET_MS + 3 * DAY_MS])
  assert.equal(diagnostics.exactDaysMatched, 0, 'no malformed row may enter the index')
  for (const offset of [0, 1, 2, 3]) {
    assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS + offset * DAY_MS }).priceUsd, null)
  }
})

test('a pool-identity mismatch rejects the whole response', async () => {
  mockPools({
    eth: () =>
      new Response(
        ohlcvBody([candle(BUCKET_SEC, 3120.5)], {
          base: { address: '0x0000000000000000000000000000000000000dead', symbol: 'NOPE' },
          quote: { address: '0x0000000000000000000000000000000000000beef', symbol: 'ALSONOPE' },
        }),
        { status: 200 },
      ),
    base: () => new Response(ohlcvBody([]), { status: 200 }),
  })

  const diagnostics = await primeGeckoTerminalRangeForBuckets([BUCKET_MS])
  assert.equal(diagnostics.httpStatuses[0].rejectionReason, 'pool_identity_mismatch')
  assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS }).priceUsd, null)
})

test('matching pool metadata is accepted', async () => {
  mockPools({
    eth: () =>
      new Response(
        ohlcvBody([candle(BUCKET_SEC, 3120.5)], {
          base: { address: ETH_WETH.toUpperCase(), symbol: 'WETH' },
          quote: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' },
        }),
        { status: 200 },
      ),
  })
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS])
  assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS }).priceUsd, 3120.5)
})

test('an implausible value — such as the stablecoin side read by mistake — is excluded, never clamped', async () => {
  mockPools({
    eth: () => new Response(ohlcvBody([candle(BUCKET_SEC, 1.0001)]), { status: 200 }),
    base: () => new Response(ohlcvBody([]), { status: 200 }),
  })
  const diagnostics = await primeGeckoTerminalRangeForBuckets([BUCKET_MS])
  assert.equal(diagnostics.exactDaysMatched, 0)
  assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS }).priceUsd, null)
})

test('a non-200, non-429 response fails closed without retrying that pool', async () => {
  const { urls } = mockPools({
    eth: () => new Response('{}', { status: 503 }),
    base: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }),
  })
  const diagnostics = await primeGeckoTerminalRangeForBuckets([BUCKET_MS])

  assert.equal(diagnostics.httpStatuses[0].status, 503)
  assert.equal(urls.filter((u) => u.includes(ETH_POOL)).length, 1, 'never retried')
  // A 503 is not a quota signal, so the second, independent pool is still tried.
  assert.equal(readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS }).priceUsd, 3120.5)
})

test('reading before priming is reported distinctly, never as a missing day', () => {
  const read = readGeckoTerminalEthUsdForUtcDay({ chain: 'base', bucketStartMs: BUCKET_MS })
  assert.equal(read.priceUsd, null)
  assert.equal(read.rejectionReason, 'geckoterminal_range_not_primed')
})

test('an unsupported chain fails closed', () => {
  const read = readGeckoTerminalEthUsdForUtcDay({ chain: 'hyperevm', bucketStartMs: BUCKET_MS })
  assert.equal(read.priceUsd, null)
  assert.equal(read.rejectionReason, 'unsupported_network_for_geckoterminal')
})

test('no required buckets means no request at all', async () => {
  const { urls } = mockPools({ eth: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }) })
  const diagnostics = await primeGeckoTerminalRangeForBuckets([])
  assert.equal(urls.length, 0)
  assert.equal(diagnostics.rangeRequests, 0)
})

test('range diagnostics are exposed for the scan audit', async () => {
  mockPools({ eth: () => new Response(ohlcvBody([candle(BUCKET_SEC, 3120.5)]), { status: 200 }) })
  await primeGeckoTerminalRangeForBuckets([BUCKET_MS])
  const snapshot = getGeckoTerminalRangeDiagnostics()
  assert.ok(snapshot)
  assert.equal(snapshot!.requiredBucketCount, 1)
  assert.equal(snapshot!.exactDaysMatched, 1)
  assert.equal(snapshot!.rangeRequests, 1)
})

test('parseCandleRow validates structure without inventing values', () => {
  assert.deepEqual(parseCandleRow([BUCKET_SEC, 1, 2, 3, 3120.5, 9]), { timestampSec: BUCKET_SEC, close: 3120.5 })
  assert.equal(parseCandleRow(null), null)
  assert.equal(parseCandleRow([]), null)
  assert.equal(parseCandleRow([BUCKET_SEC, 1, 2, 3]), null)
  assert.equal(parseCandleRow([0, 1, 2, 3, 3120.5, 9]), null)
  assert.equal(parseCandleRow([BUCKET_SEC, 1, 2, 3, Number.NaN, 9]), null)
})

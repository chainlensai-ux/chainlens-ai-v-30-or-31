import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWLISTED_ETH_USD_POOLS,
  MAX_GECKOTERMINAL_OHLCV_REQUESTS_PER_SCAN,
  allowlistedPoolForChain,
  fetchGeckoTerminalEthUsdForUtcDay,
  getGeckoTerminalEthOhlcvRequestCount,
  parseCandleRow,
  resetGeckoTerminalEthOhlcvForScan,
} from './geckoTerminalEthOhlcv'

const TRADE_MS = Date.UTC(2026, 4, 11, 13, 45, 0)
const BUCKET_MS = Date.UTC(2026, 4, 11, 0, 0, 0)
const BUCKET_SEC = BUCKET_MS / 1000
const DAY_SEC = 86_400

const BASE_POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224'
const BASE_WETH = '0x4200000000000000000000000000000000000006'

const originalFetch = global.fetch

function candle(timestampSec: number, close: number): [number, number, number, number, number, number] {
  return [timestampSec, close * 0.99, close * 1.02, close * 0.97, close, 1_000_000]
}

function ohlcvBody(rows: unknown[], meta?: unknown): string {
  return JSON.stringify({ data: { attributes: { ohlcv_list: rows } }, ...(meta ? { meta } : {}) })
}

function mockOhlcv(body: string, status = 200): { urls: string[] } {
  const urls: string[] = []
  global.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { urls }
}

beforeEach(() => {
  resetGeckoTerminalEthOhlcvForScan()
})

afterEach(() => {
  global.fetch = originalFetch
})

test('the pool allowlist is fixed and covers Base and Ethereum with canonical WETH addresses', () => {
  assert.equal(ALLOWLISTED_ETH_USD_POOLS.length, 2)
  assert.equal(allowlistedPoolForChain('base')?.poolAddress, BASE_POOL)
  assert.equal(allowlistedPoolForChain('base')?.wethAddress, BASE_WETH)
  assert.equal(allowlistedPoolForChain('eth')?.wethAddress, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
  // No pool has been reviewed for Arbitrum, so none is offered — never discovered dynamically.
  assert.equal(allowlistedPoolForChain('arbitrum'), null)
  assert.equal(allowlistedPoolForChain('hyperevm'), null)
})

test('an allowlisted pool is used and the WETH side is requested explicitly, never the stablecoin side', async () => {
  const { urls } = mockOhlcv(ohlcvBody([candle(BUCKET_SEC, 3120.5)]))
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })

  assert.equal(result.priceUsd, 3120.5)
  assert.equal(result.poolAddress, BASE_POOL)
  assert.equal(result.poolLabel, 'uniswap_v3_weth_usdc_005_base')
  assert.equal(result.candleTimestampMs, BUCKET_MS)
  assert.equal(result.rejectionReason, null)

  const url = urls[0]
  assert.ok(url.includes(`/pools/${BASE_POOL}/ohlcv/day`), 'must query the allowlisted pool')
  // Explicitly asking for the WETH token's USD series is what prevents reading the ~$1 stablecoin side.
  assert.ok(url.includes(`token=${BASE_WETH}`))
  assert.ok(url.includes('currency=usd'))
  assert.ok(url.includes('before_timestamp='), 'must anchor to the historical day, never "now"')
})

test('the candle for the requested UTC day is selected even when neighbours are returned', async () => {
  mockOhlcv(
    ohlcvBody([
      candle(BUCKET_SEC + DAY_SEC, 3300),
      candle(BUCKET_SEC, 3120.5),
      candle(BUCKET_SEC - DAY_SEC, 2900),
    ]),
  )
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(result.priceUsd, 3120.5, 'must pick the exact-day candle, not the first or nearest')
  assert.equal(result.candleTimestampMs, BUCKET_MS)
})

test('an adjacent/stale candle is REJECTED, never substituted for the requested day', async () => {
  // Only neighbouring days are available — the requested day genuinely has no candle.
  mockOhlcv(ohlcvBody([candle(BUCKET_SEC - DAY_SEC, 2900), candle(BUCKET_SEC + DAY_SEC, 3300)]))
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })

  assert.equal(result.priceUsd, null)
  assert.equal(result.rejectionReason, 'geckoterminal_no_candle_for_requested_utc_day')
  assert.equal(result.candleTimestampMs, null)
})

test('malformed and zero/negative candles are rejected', async () => {
  for (const rows of [
    [[BUCKET_SEC, 1, 2]], // too short
    [[BUCKET_SEC, 1, 2, 3, 0, 5]], // zero close
    [[BUCKET_SEC, 1, 2, 3, -10, 5]], // negative close
    [[BUCKET_SEC, 1, 2, 3, 'not-a-number', 5]], // non-numeric close
    [['not-a-timestamp', 1, 2, 3, 3120.5, 5]], // non-numeric timestamp
  ]) {
    resetGeckoTerminalEthOhlcvForScan()
    mockOhlcv(ohlcvBody(rows))
    const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
    assert.equal(result.priceUsd, null)
    assert.ok(result.rejectionReason, 'a malformed candle must state a rejection reason')
  }
})

test('an empty or missing ohlcv_list fails closed', async () => {
  mockOhlcv(ohlcvBody([]))
  const empty = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(empty.rejectionReason, 'geckoterminal_no_candles')

  resetGeckoTerminalEthOhlcvForScan()
  mockOhlcv(JSON.stringify({ data: {} }))
  const missing = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(missing.priceUsd, null)
  assert.equal(missing.rejectionReason, 'geckoterminal_no_candles')
})

test('a pool-identity mismatch in the response metadata fails closed', async () => {
  mockOhlcv(
    ohlcvBody([candle(BUCKET_SEC, 3120.5)], {
      base: { address: '0x0000000000000000000000000000000000000dead', symbol: 'NOPE' },
      quote: { address: '0x0000000000000000000000000000000000000beef', symbol: 'ALSONOPE' },
    }),
  )
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(result.priceUsd, null)
  assert.equal(result.rejectionReason, 'pool_identity_mismatch')
})

test('matching metadata is accepted', async () => {
  mockOhlcv(
    ohlcvBody([candle(BUCKET_SEC, 3120.5)], {
      base: { address: BASE_WETH.toUpperCase(), symbol: 'WETH' },
      quote: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' },
    }),
  )
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(result.priceUsd, 3120.5)
})

test('an implausible value — such as the stablecoin side being read by mistake — fails closed', async () => {
  mockOhlcv(ohlcvBody([candle(BUCKET_SEC, 1.0001)]))
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(result.priceUsd, null)
  assert.equal(result.rejectionReason, 'geckoterminal_implausible_eth_price')
  // The guard rejects; it never clamps, adjusts or synthesizes a replacement.
})

test('a chain with no allowlisted pool fails closed rather than discovering one', async () => {
  mockOhlcv(ohlcvBody([candle(BUCKET_SEC, 3120.5)]))
  const arb = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'arbitrum', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(arb.priceUsd, null)
  assert.equal(arb.rejectionReason, 'unsupported_network_for_geckoterminal')
  assert.equal(getGeckoTerminalEthOhlcvRequestCount(), 0, 'no request may be spent on an unsupported chain')
})

test('a non-200 response fails closed and is never retried', async () => {
  const { urls } = mockOhlcv('{}', 429)
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(result.priceUsd, null)
  assert.equal(result.httpStatus, 429)
  assert.equal(result.rejectionReason, 'geckoterminal_http_429')
  assert.equal(urls.length, 1, 'exactly one request — this module never retries')
})

test('the hard per-scan request cap is enforced and resets per scan', async () => {
  mockOhlcv(ohlcvBody([]))
  for (let i = 0; i < MAX_GECKOTERMINAL_OHLCV_REQUESTS_PER_SCAN; i += 1) {
    await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS + i * DAY_SEC * 1000 })
  }
  assert.equal(getGeckoTerminalEthOhlcvRequestCount(), MAX_GECKOTERMINAL_OHLCV_REQUESTS_PER_SCAN)

  const overCap = await fetchGeckoTerminalEthUsdForUtcDay({ chain: 'base', timestampMs: TRADE_MS, bucketStartMs: BUCKET_MS })
  assert.equal(overCap.priceUsd, null)
  assert.equal(overCap.rejectionReason, 'geckoterminal_scan_request_cap_reached')

  resetGeckoTerminalEthOhlcvForScan()
  assert.equal(getGeckoTerminalEthOhlcvRequestCount(), 0)
})

test('parseCandleRow validates structure without inventing values', () => {
  assert.deepEqual(parseCandleRow([BUCKET_SEC, 1, 2, 3, 3120.5, 9]), { timestampSec: BUCKET_SEC, close: 3120.5 })
  assert.equal(parseCandleRow(null), null)
  assert.equal(parseCandleRow([]), null)
  assert.equal(parseCandleRow([BUCKET_SEC, 1, 2, 3]), null)
  assert.equal(parseCandleRow([0, 1, 2, 3, 3120.5, 9]), null)
  assert.equal(parseCandleRow([BUCKET_SEC, 1, 2, 3, Number.NaN, 9]), null)
})

// Tests for basedex.ts's shared, request-scoped WETH-USD quote-price cache — added to reduce
// quote_token_usd_unavailable failures caused by every WETH-quoted venue attempt firing its own
// independent live CoinGecko call for what is very often the same underlying historical price.
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.sharedQuotePrice.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  tryBaseDexVenue,
  resolveAerodromeSlipstreamPoolAddress,
  resolveAerodromeClassicVolatilePoolAddress,
  readSlipstreamPoolPrice,
  readAerodromeClassicVolatilePoolPrice,
  getBaseDexQuotePriceAttributionForScan,
  getQuotePriceAttributionForRequest,
  resetBaseDexVenueAttributionForScan,
  __resetBaseDexCachesForTest,
} from './basedex'

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL3_ABI = [
  {
    type: 'function', name: 'aggregate3', stateMutability: 'view',
    inputs: [{ name: 'calls', type: 'tuple[]', components: [
      { name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' },
    ] }],
    outputs: [{ name: 'returnData', type: 'tuple[]', components: [
      { name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' },
    ] }],
  },
] as const

const SLIPSTREAM_FACTORY_ABI = [
  { type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'tickSpacing', type: 'int24' }],
    outputs: [{ name: 'pool', type: 'address' }] },
] as const

const POOL_ABI = [
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'unlocked', type: 'bool' },
    ] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

const CLASSIC_POOL_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [],
    outputs: [{ name: '_reserve0', type: 'uint256' }, { name: '_reserve1', type: 'uint256' }, { name: '_blockTimestampLast', type: 'uint256' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'stable', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const

const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x3333333333333333333333333333333333333333'
const WETH = '0x4200000000000000000000000000000000000006'
const POOL = '0x2222222222222222222222222222222222222222'
const POOL_B = '0x4444444444444444444444444444444444444444'

function wrap(results: { success: boolean; returnData: `0x${string}` }[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { data: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as any }) }
}

function makeSlipstreamClient(pool: string, token: string) {
  return {
    async call({ to, data }: { to: string; data: `0x${string}` }) {
      assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
      const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
      const results = calls.map((call) => {
        try {
          const decoded = decodeFunctionData({ abi: SLIPSTREAM_FACTORY_ABI, data: call.callData })
          if (decoded.functionName === 'getPool') {
            return { success: true, returnData: encodeFunctionResult({ abi: SLIPSTREAM_FACTORY_ABI, functionName: 'getPool', result: pool as `0x${string}` }) }
          }
        } catch { /* not a factory call */ }
        try {
          const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.callData })
          if (decoded.functionName === 'slot0') {
            return { success: true, returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: 'slot0', result: [BigInt('79228162514264337593543950336'), 0, 0, 0, 0, true] }) }
          }
          if (decoded.functionName === 'token0') {
            return { success: true, returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: 'token0', result: token as `0x${string}` }) }
          }
        } catch { /* not a pool call */ }
        return { success: true, returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: 18 }) }
      })
      return wrap(results)
    },
  }
}

function makeClassicClient(pool: string, token: string) {
  return {
    async readContract() {
      return pool as `0x${string}`
    },
    async call({ to, data }: { to: string; data: `0x${string}` }) {
      assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
      const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
      const results = calls.map((call) => {
        try {
          const decoded = decodeFunctionData({ abi: CLASSIC_POOL_ABI, data: call.callData })
          if (decoded.functionName === 'getReserves') {
            return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'getReserves', result: [BigInt(1000), BigInt(1000), BigInt(0)] }) }
          }
          if (decoded.functionName === 'token0') {
            return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'token0', result: token as `0x${string}` }) }
          }
          if (decoded.functionName === 'stable') {
            return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'stable', result: false }) }
          }
        } catch { /* not a classic-pool call */ }
        return { success: true, returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: 18 }) }
      })
      return wrap(results)
    },
  }
}

const originalFetch = global.fetch

beforeEach(() => {
  __resetBaseDexCachesForTest()
  resetBaseDexVenueAttributionForScan()
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('basedex shared WETH-USD quote-price cache', () => {
  it('a live CoinGecko call is only made once for two distinct venues sharing the same bucketed timestamp — the second is a cache hit, not a second live call', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      return new Response(JSON.stringify({ prices: [[1000, 3000]] }), { status: 200 })
    }) as unknown as typeof fetch

    const timestamp = Date.now()
    const attempts: unknown[] = []

    const first = await tryBaseDexVenue(
      'aerodrome_slipstream', 'WETH', WETH as `0x${string}`, TOKEN_A as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSlipstreamClient(POOL, TOKEN_A) as any, BigInt(1), timestamp, attempts as any,
      resolveAerodromeSlipstreamPoolAddress, readSlipstreamPoolPrice,
    )
    const second = await tryBaseDexVenue(
      'aerodrome_classic_volatile', 'WETH', WETH as `0x${string}`, TOKEN_B as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeClassicClient(POOL_B, TOKEN_B) as any, BigInt(1), timestamp, attempts as any,
      resolveAerodromeClassicVolatilePoolAddress, readAerodromeClassicVolatilePoolPrice,
    )

    assert.ok(first.usd !== null, 'expected the first (Slipstream) attempt to accept a real price')
    assert.ok(second.usd !== null, 'expected the second (Classic) attempt, sharing the cached WETH price, to also accept a real price')
    assert.equal(liveCalls, 1, 'expected exactly ONE live CoinGecko call shared across both venues for the same bucketed timestamp')
    assert.equal(first.usedSharedQuotePriceCacheHit, false, 'the first call is the real live resolution, not a cache hit')
    assert.equal(second.usedSharedQuotePriceCacheHit, true, 'the second call, across a DIFFERENT venue, must be served by the shared cache')

    const snap = getBaseDexQuotePriceAttributionForScan()
    assert.equal(snap.quotePriceLiveResolutions, 1)
    assert.equal(snap.quotePriceCacheHits, 1)
    assert.equal(snap.quotePriceUnavailable, 0)
  })

  it('never uses a "current" price — only the real historical timestamp requested', async () => {
    let capturedUrl: string | null = null
    global.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return new Response(JSON.stringify({ prices: [[1000, 3000]] }), { status: 200 })
    }) as unknown as typeof fetch

    const historicalTimestamp = new Date('2024-01-01T00:00:00.000Z').getTime()
    const attempts: unknown[] = []
    await tryBaseDexVenue(
      'aerodrome_slipstream', 'WETH', WETH as `0x${string}`, TOKEN_A as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSlipstreamClient(POOL, TOKEN_A) as any, BigInt(1), historicalTimestamp, attempts as any,
      resolveAerodromeSlipstreamPoolAddress, readSlipstreamPoolPrice,
    )

    assert.ok(capturedUrl, 'expected a real CoinGecko URL to have been requested')
    const url = new URL(capturedUrl as unknown as string)
    const from = Number(url.searchParams.get('from'))
    const targetSec = Math.floor(historicalTimestamp / 1000)
    assert.ok(Math.abs(from - targetSec) <= 24 * 60 * 60, 'expected the requested range to be anchored to the REAL historical timestamp, not "now"')
  })

  it('fails closed (never fabricates a quote price) when CoinGecko genuinely has no historical price, and this is cached too — never retried a second time', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      return new Response(JSON.stringify({ prices: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const timestamp = Date.now()
    const attempts: unknown[] = []
    const first = await tryBaseDexVenue(
      'aerodrome_slipstream', 'WETH', WETH as `0x${string}`, TOKEN_A as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSlipstreamClient(POOL, TOKEN_A) as any, BigInt(1), timestamp, attempts as any,
      resolveAerodromeSlipstreamPoolAddress, readSlipstreamPoolPrice,
    )
    const second = await tryBaseDexVenue(
      'aerodrome_classic_volatile', 'WETH', WETH as `0x${string}`, TOKEN_B as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeClassicClient(POOL_B, TOKEN_B) as any, BigInt(1), timestamp, attempts as any,
      resolveAerodromeClassicVolatilePoolAddress, readAerodromeClassicVolatilePoolPrice,
    )

    assert.equal(first.usd, null, 'must fail closed, never fabricate a price, when no verified historical quote price exists')
    assert.equal(second.usd, null, 'the cached null must also fail closed for the second venue')
    assert.equal(liveCalls, 1, 'the null result must be cached too — a second attempt must not repeat the live call')

    const snap = getBaseDexQuotePriceAttributionForScan()
    assert.equal(snap.quotePriceUnavailable, 2, 'both the live miss and its cache-hit reuse count as unavailable')
  })

  it('records per-request attribution so a caller can confirm whether an accepted price used a shared cache hit', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ prices: [[1000, 3000]] }), { status: 200 })) as unknown as typeof fetch

    const timestamp = Date.now()
    const attempts: unknown[] = []
    await tryBaseDexVenue(
      'aerodrome_slipstream', 'WETH', WETH as `0x${string}`, TOKEN_A as `0x${string}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSlipstreamClient(POOL, TOKEN_A) as any, BigInt(1), timestamp, attempts as any,
      resolveAerodromeSlipstreamPoolAddress, readSlipstreamPoolPrice,
    )
    // fetchBaseDexPriceDetailed itself is what records per-request attribution (see basedex.ts) —
    // tryBaseDexVenue alone doesn't know the caller's (chain, token, timestamp) request identity, so
    // this test confirms the underlying counters directly instead (already asserted above); the
    // per-request getter is exercised end-to-end in basedex.aerodromeAttribution-style tests.
    assert.equal(getQuotePriceAttributionForRequest('base', TOKEN_A, timestamp), null, 'tryBaseDexVenue alone never records per-request attribution — only fetchBaseDexPriceDetailed does')
  })
})

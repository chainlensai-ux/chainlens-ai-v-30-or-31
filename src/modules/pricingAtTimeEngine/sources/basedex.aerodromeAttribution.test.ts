// Tests for basedex.ts's per-scan Aerodrome/venue attribution counters (poolsFoundByVenue,
// pricesAcceptedByVenue, failureReasonsByVenue, rpcCallsByVenue) — additive, read-only bookkeeping,
// no pricing behavior change. NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.aerodromeAttribution.test.ts

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  tryBaseDexVenue,
  resolveAerodromeSlipstreamPoolAddress,
  resolveAerodromeClassicVolatilePoolAddress,
  readAerodromeClassicVolatilePoolPrice,
  readPoolPrice,
  getBaseDexVenueAttributionForScan,
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
      { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
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

const TOKEN = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
const POOL = '0x2222222222222222222222222222222222222222'

function wrap(results: { success: boolean; returnData: `0x${string}` }[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { data: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as any }) }
}

beforeEach(() => {
  __resetBaseDexCachesForTest()
  resetBaseDexVenueAttributionForScan()
})

describe('Classic accepted price increments only Classic counters', () => {
  it('a full Classic success bumps aerodrome_classic_volatile poolsFound/pricesAccepted and nothing else', async () => {
    const client = {
      async readContract() {
        return POOL as `0x${string}`
      },
      async call({ to, data }: { to: string; data: `0x${string}` }) {
        assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map((call) => {
          try {
            const decoded = decodeFunctionData({ abi: CLASSIC_POOL_ABI, data: call.callData })
            if (decoded.functionName === 'getReserves') {
              return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'getReserves', result: [BigInt(1000), BigInt(2000), BigInt(0)] }) }
            }
            if (decoded.functionName === 'token0') {
              return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'token0', result: TOKEN as `0x${string}` }) }
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
    const attempts: unknown[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usd = await tryBaseDexVenue('aerodrome_classic_volatile', 'USDC', WETH as `0x${string}`, TOKEN as `0x${string}`, client as any, BigInt(1), Date.now(), attempts as any, resolveAerodromeClassicVolatilePoolAddress, readAerodromeClassicVolatilePoolPrice)
    assert.ok(usd !== null, 'expected a real accepted price')

    const snap = getBaseDexVenueAttributionForScan()
    assert.equal(snap.poolsFoundByVenue.aerodrome_classic_volatile, 1)
    assert.equal(snap.pricesAcceptedByVenue.aerodrome_classic_volatile, 1)
    assert.equal(snap.poolsFoundByVenue.aerodrome_slipstream, 0, 'Slipstream counter must stay untouched')
    assert.equal(snap.poolsFoundByVenue.uniswap_v3, 0, 'Uniswap V3 counter must stay untouched')
    assert.equal(snap.pricesAcceptedByVenue.aerodrome_slipstream, 0)
    assert.equal(snap.pricesAcceptedByVenue.uniswap_v3, 0)
  })
})

describe('Slipstream accepted price increments only Slipstream counters', () => {
  it('a full Slipstream success bumps aerodrome_slipstream poolsFound/pricesAccepted and nothing else', async () => {
    const client = {
      async call({ to, data }: { to: string; data: `0x${string}` }) {
        assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map((call) => {
          try {
            const decoded = decodeFunctionData({ abi: SLIPSTREAM_FACTORY_ABI, data: call.callData })
            if (decoded.functionName === 'getPool') {
              return { success: true, returnData: encodeFunctionResult({ abi: SLIPSTREAM_FACTORY_ABI, functionName: 'getPool', result: POOL as `0x${string}` }) }
            }
          } catch { /* not a factory call */ }
          try {
            const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.callData })
            if (decoded.functionName === 'slot0') {
              return { success: true, returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: 'slot0', result: [BigInt('79228162514264337593543950336'), 0, 0, 0, 0, 0, true] }) }
            }
            if (decoded.functionName === 'token0') {
              return { success: true, returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: 'token0', result: TOKEN as `0x${string}` }) }
            }
          } catch { /* not a pool call */ }
          return { success: true, returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: 18 }) }
        })
        return wrap(results)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async readContract(): Promise<any> {
        throw new Error('unexpected readContract call — multicall path should not fall back here')
      },
    }
    const attempts: unknown[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usd = await tryBaseDexVenue('aerodrome_slipstream', 'USDC', WETH as `0x${string}`, TOKEN as `0x${string}`, client as any, BigInt(1), Date.now(), attempts as any, resolveAerodromeSlipstreamPoolAddress, readPoolPrice)
    assert.ok(usd !== null, 'expected a real accepted price')

    const snap = getBaseDexVenueAttributionForScan()
    assert.equal(snap.poolsFoundByVenue.aerodrome_slipstream, 1)
    assert.equal(snap.pricesAcceptedByVenue.aerodrome_slipstream, 1)
    assert.equal(snap.poolsFoundByVenue.aerodrome_classic_volatile, 0, 'Classic counter must stay untouched')
    assert.equal(snap.poolsFoundByVenue.uniswap_v3, 0, 'Uniswap V3 counter must stay untouched')
    assert.equal(snap.pricesAcceptedByVenue.aerodrome_classic_volatile, 0)
    assert.equal(snap.pricesAcceptedByVenue.uniswap_v3, 0)
  })
})

describe('Found pool with rejected price does not count as success', () => {
  it('a discovered Classic pool with zero liquidity increments poolsFound but never pricesAccepted', async () => {
    const client = {
      async readContract() {
        return POOL as `0x${string}`
      },
      async call({ to, data }: { to: string; data: `0x${string}` }) {
        assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map((call) => {
          try {
            const decoded = decodeFunctionData({ abi: CLASSIC_POOL_ABI, data: call.callData })
            if (decoded.functionName === 'getReserves') {
              // ZERO LIQUIDITY — a real, deployed pool that must never be priced.
              return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'getReserves', result: [BigInt(0), BigInt(0), BigInt(0)] }) }
            }
            if (decoded.functionName === 'token0') {
              return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'token0', result: TOKEN as `0x${string}` }) }
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
    const attempts: unknown[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usd = await tryBaseDexVenue('aerodrome_classic_volatile', 'USDC', WETH as `0x${string}`, TOKEN as `0x${string}`, client as any, BigInt(1), Date.now(), attempts as any, resolveAerodromeClassicVolatilePoolAddress, readAerodromeClassicVolatilePoolPrice)
    assert.equal(usd, null, 'zero liquidity must never be priced')

    const snap = getBaseDexVenueAttributionForScan()
    assert.equal(snap.poolsFoundByVenue.aerodrome_classic_volatile, 1, 'the pool WAS found — discovery must still be counted')
    assert.equal(snap.pricesAcceptedByVenue.aerodrome_classic_volatile, 0, 'a rejected price must NEVER count as an accepted price')
    assert.ok(
      Object.keys(snap.failureReasonsByVenue.aerodrome_classic_volatile).length > 0,
      'expected a real failure reason recorded for this rejection',
    )
  })
})

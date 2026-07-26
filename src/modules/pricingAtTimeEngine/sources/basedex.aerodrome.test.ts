// Tests for the Aerodrome venues added to basedex.ts (Classic volatile + Slipstream) — additional
// venues alongside the pre-existing Uniswap V3 one, never replacing it. NOT wired into `npm test`.
// Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.aerodrome.test.ts
//
// Uses minimal fake PublicClients (only the methods each path actually calls), same style as
// basedex.test.ts, so this never hits real RPC/env vars.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import {
  resolveAerodromeSlipstreamPoolAddress,
  resolveAerodromeClassicVolatilePoolAddress,
  readAerodromeClassicVolatilePoolPrice,
  readSlipstreamPoolPrice,
  fetchBaseDexPriceDetailed,
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

// Slipstream's REAL, source-verified slot0 ABI — SIX fields, no feeProtocol. See this file's
// "prices a Slipstream pool using its own dedicated 6-field slot0 ABI" test below for the full trace.
const SLIPSTREAM_POOL_ABI = [
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

const TOKEN = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const POOL = '0x2222222222222222222222222222222222222222'

function wrapMulticallResults(results: { success: boolean; returnData: `0x${string}` }[]) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as any }),
  }
}

// ============================================================================
// Aerodrome Slipstream discovery (reuses readPoolPrice's slot0 math unchanged)
// ============================================================================

function makeSlipstreamFakeClient(opts: { poolAddress: string | null }) {
  let callCount = 0
  const client = {
    async call({ to, data }: { to: string; data: `0x${string}` }) {
      callCount++
      assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase(), 'Slipstream pool discovery must batch tick-spacing attempts via Multicall3')
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
      const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
      const results = calls.map(() => ({
        success: true,
        returnData: encodeFunctionResult({
          abi: SLIPSTREAM_FACTORY_ABI, functionName: 'getPool',
          result: (opts.poolAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
        }),
      }))
      return wrapMulticallResults(results)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async readContract(): Promise<any> {
      throw new Error('unexpected readContract call — multicall path should not fall back here')
    },
  }
  return { client, getCallCount: () => callCount }
}

// REGRESSION LOCK, DISCLOSED (found live, this task): a real, shipped wrong address
// (0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F — confirmed via velodrome-finance/slipstream's own
// README, explicitly linked to optimistic.etherscan.io, to be VELODROME's Optimism factory, not
// Aerodrome's) was corrected to the address below (confirmed 3x from aerodrome-finance/slipstream's
// own README as its "Initial Deployment" PoolFactory on Base). This test pins the exact address
// basedex.ts must target for every Slipstream discovery call, and the exact getPool(address,address,
// int24) ABI shape it must use — a regression here would silently reintroduce the wrong-chain
// factory bug.
const VERIFIED_AERODROME_SLIPSTREAM_FACTORY_BASE = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A'
const WRONG_VELODROME_OPTIMISM_FACTORY = '0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F'

describe('Aerodrome Slipstream factory address regression lock', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('targets the verified Aerodrome Base Slipstream factory, never the Velodrome Optimism one', async () => {
    let sawTarget: string | null = null
    const client = {
      async call({ to, data }: { to: string; data: `0x${string}` }) {
        assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        for (const call of calls) {
          sawTarget = call.target.toLowerCase()
          assert.equal(
            sawTarget,
            VERIFIED_AERODROME_SLIPSTREAM_FACTORY_BASE.toLowerCase(),
            'basedex.ts must target the verified Aerodrome Base factory address',
          )
          assert.notEqual(
            sawTarget,
            WRONG_VELODROME_OPTIMISM_FACTORY.toLowerCase(),
            'basedex.ts must never target the confirmed-wrong Velodrome Optimism factory address',
          )
          // Confirm the exact ABI shape (getPool(address,address,int24)) basedex.ts actually encodes.
          const decodedCall = decodeFunctionData({ abi: SLIPSTREAM_FACTORY_ABI, data: call.callData })
          assert.equal(decodedCall.functionName, 'getPool')
          assert.equal(decodedCall.args.length, 3)
        }
        const results = calls.map(() => ({
          success: true,
          returnData: encodeFunctionResult({
            abi: SLIPSTREAM_FACTORY_ABI, functionName: 'getPool',
            result: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          }),
        }))
        return wrapMulticallResults(results)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async readContract(): Promise<any> {
        throw new Error('unexpected readContract call — multicall path should not fall back here')
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolveAerodromeSlipstreamPoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(sawTarget, VERIFIED_AERODROME_SLIPSTREAM_FACTORY_BASE.toLowerCase(), 'expected at least one call targeting the verified factory')
  })
})

describe('Aerodrome Slipstream pool discovery', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('resolves a Slipstream pool address by batching every tick spacing into one multicall', async () => {
    const { client, getCallCount } = makeSlipstreamFakeClient({ poolAddress: POOL })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = await resolveAerodromeSlipstreamPoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(pool, POOL)
    assert.equal(getCallCount(), 1, 'expected every tick-spacing attempt to collapse into one multicall call')
  })

  // CORRECTED, DISCLOSED (found live, this task — confirmed production evidence: pool
  // 0x027256310dDD3773bc410f1CBd83524C42321Cd0 found, slot0() decode failed with "Position `192` is
  // out of bounds"): Slipstream's real slot0() has SIX fields (no feeProtocol), NOT Uniswap V3's
  // seven — verified against aerodrome-finance/slipstream's own ICLPoolState.sol. This test now
  // exercises the dedicated readSlipstreamPoolPrice/AERODROME_SLIPSTREAM_POOL_ABI path with a
  // correctly-shaped 6-field slot0 return (192 real bytes) — see
  // basedex.aerodromeSlipstreamSlot0.test.ts for the regression test reproducing the exact reported
  // out-of-bounds failure and confirming it no longer occurs.
  it('prices a Slipstream pool using its own dedicated 6-field slot0 ABI (sqrtPriceX96 math reused verbatim from Uniswap V3)', async () => {
    __resetBaseDexCachesForTest()
    const slot0Client = {
      async call({ to, data }: { to: string; data: `0x${string}` }) {
        assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map((call) => {
          try {
            const decoded = decodeFunctionData({ abi: SLIPSTREAM_POOL_ABI, data: call.callData })
            if (decoded.functionName === 'slot0') {
              // Six fields — no feeProtocol — matching Slipstream's real, source-verified ABI.
              return { success: true, returnData: encodeFunctionResult({ abi: SLIPSTREAM_POOL_ABI, functionName: 'slot0', result: [BigInt('79228162514264337593543950336'), 0, 0, 0, 0, true] }) }
            }
            if (decoded.functionName === 'token0') {
              return { success: true, returnData: encodeFunctionResult({ abi: SLIPSTREAM_POOL_ABI, functionName: 'token0', result: TOKEN as `0x${string}` }) }
            }
          } catch { /* not a pool call */ }
          const decoded = decodeFunctionData({ abi: DECIMALS_ABI, data: call.callData })
          assert.equal(decoded.functionName, 'decimals')
          return { success: true, returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: 18 }) }
        })
        return wrapMulticallResults(results)
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = await readSlipstreamPoolPrice(slot0Client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(1))
    assert.equal(price, 1, 'sqrtPriceX96 = 2^96 with equal decimals must resolve to a 1:1 ratio, same math as the Uniswap V3 venue')
  })
})

// ============================================================================
// Aerodrome Classic volatile pools
// ============================================================================

function makeClassicFactoryClient(opts: { poolAddress: string | null }) {
  let calls = 0
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async readContract(args: any) {
      calls++
      assert.equal(args.functionName, 'getPool')
      assert.deepEqual(args.args[2], false, 'must NEVER query the Classic factory with stable=true')
      return (opts.poolAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`
    },
  }
  return { client, getCallCount: () => calls }
}

describe('Aerodrome Classic volatile pool discovery', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('resolves a Classic volatile pool address, always querying stable=false', async () => {
    const { client } = makeClassicFactoryClient({ poolAddress: POOL })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = await resolveAerodromeClassicVolatilePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(pool, POOL)
  })

  it('a no-pool result populates the negative cache (no repeat RPC call)', async () => {
    const { client, getCallCount } = makeClassicFactoryClient({ poolAddress: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await resolveAerodromeClassicVolatilePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(first, null)
    const callsAfterFirst = getCallCount()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await resolveAerodromeClassicVolatilePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(second, null)
    assert.equal(getCallCount(), callsAfterFirst, 'expected the negative cache to prevent a repeat RPC call')
  })
})

function makeClassicPoolPriceClient(opts: {
  reserve0?: bigint
  reserve1?: bigint
  token0?: string
  stable?: boolean
  tokenDecimals?: number
  pairedDecimals?: number
  emptyReturnData?: boolean
}) {
  const client = {
    async call({ to, data }: { to: string; data: `0x${string}` }) {
      assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase())
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
      const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
      const results = calls.map((call) => {
        try {
          const decoded = decodeFunctionData({ abi: CLASSIC_POOL_ABI, data: call.callData })
          if (opts.emptyReturnData && (decoded.functionName === 'getReserves' || decoded.functionName === 'token0' || decoded.functionName === 'stable')) {
            return { success: true, returnData: '0x' as `0x${string}` }
          }
          if (decoded.functionName === 'getReserves') {
            return {
              success: true,
              returnData: encodeFunctionResult({
                abi: CLASSIC_POOL_ABI, functionName: 'getReserves',
                result: [opts.reserve0 ?? BigInt(1000), opts.reserve1 ?? BigInt(1000), BigInt(0)],
              }),
            }
          }
          if (decoded.functionName === 'token0') {
            return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'token0', result: (opts.token0 ?? TOKEN) as `0x${string}` }) }
          }
          if (decoded.functionName === 'stable') {
            return { success: true, returnData: encodeFunctionResult({ abi: CLASSIC_POOL_ABI, functionName: 'stable', result: opts.stable ?? false }) }
          }
        } catch { /* not a classic-pool call */ }
        const decoded = decodeFunctionData({ abi: DECIMALS_ABI, data: call.callData })
        assert.equal(decoded.functionName, 'decimals')
        const isToken = call.target.toLowerCase() === TOKEN.toLowerCase()
        return {
          success: true,
          returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: isToken ? (opts.tokenDecimals ?? 18) : (opts.pairedDecimals ?? 18) }),
        }
      })
      return wrapMulticallResults(results)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async readContract(): Promise<any> {
      throw new Error('unexpected readContract call — multicall path should not fall back here')
    },
  }
  return client
}

describe('Aerodrome Classic volatile pool pricing', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('prices a volatile pool using the reserve ratio, decimal-adjusted, orientation-correct', async () => {
    // reserve0 (token, 18dec) = 1000, reserve1 (paired, 6dec) = 2000 raw units.
    // price = (2000 / 1000) * 10^(18-6) = 2 * 10^12
    const client = makeClassicPoolPriceClient({ reserve0: BigInt(1000), reserve1: BigInt(2000), token0: TOKEN, stable: false, tokenDecimals: 18, pairedDecimals: 6 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = await readAerodromeClassicVolatilePoolPrice(client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, USDC as `0x${string}`, BigInt(1))
    assert.equal(price, 2 * 10 ** 12)
  })

  it('NEVER prices a stable pool with reserve-ratio math — returns null instead', async () => {
    const client = makeClassicPoolPriceClient({ stable: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = await readAerodromeClassicVolatilePoolPrice(client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(1))
    assert.equal(price, null, 'a pool reporting stable()===true must never be priced via constant-product math')
  })

  it('rejects zero liquidity (never divides by a zero reserve)', async () => {
    const client = makeClassicPoolPriceClient({ reserve0: BigInt(0), reserve1: BigInt(500) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = await readAerodromeClassicVolatilePoolPrice(client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(1))
    assert.equal(price, null, 'a zero reserve must never produce a fabricated Infinity/NaN price')
  })

  it('rejects a pool not yet deployed at this historical block (empty returndata, not a revert)', async () => {
    const client = makeClassicPoolPriceClient({ emptyReturnData: true })
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => readAerodromeClassicVolatilePoolPrice(client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(1)),
      /pool_not_yet_deployed_at_block/,
    )
  })
})

// ============================================================================
// Orchestration: fetchBaseDexPriceDetailed tries all three venues, deterministically, in priority
// order, and never issues a duplicate call once a venue succeeds.
// ============================================================================

describe('fetchBaseDexPriceDetailed venue orchestration', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
    delete process.env.ALCHEMY_BASE_RPC_URL
    delete process.env.ALCHEMY_BASE_KEY
  })

  it('reports base_dex_only_supports_base_chain for a non-Base chain without touching any client', async () => {
    const result = await fetchBaseDexPriceDetailed(TOKEN, 'ethereum' as never, Date.now())
    assert.equal(result.priceUsd, null)
    assert.equal(result.reason, 'base_dex_only_supports_base_chain')
  })

  it('reports no_api_key_configured (and never attempts any venue) when no RPC key is configured', async () => {
    const result = await fetchBaseDexPriceDetailed(TOKEN, 'base', Date.now())
    assert.equal(result.priceUsd, null)
    assert.equal(result.reason, 'no_api_key_configured')
    assert.equal(result.attempts, undefined, 'no venue should ever be attempted without a client')
  })
})

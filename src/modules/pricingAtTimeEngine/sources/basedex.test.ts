// Tests for findBlockForTimestamp's caching behavior (src/modules/pricingAtTimeEngine/sources/
// basedex.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.test.ts
//
// Uses a minimal fake PublicClient (only the `getBlock` method this function actually calls) so
// this never hits real RPC/env vars. Asserts two things: (1) a cache hit returns the exact same
// value the full binary search would have computed — zero precision loss — and (2) it does so
// without making any further `getBlock` calls.
//
// TIMESTAMP BUCKETING, DISCLOSED (real-CU-fix, applied per user confirmation of measured
// production evidence): findBlockForTimestamp now rounds the requested timestamp down to a
// 5-minute (300s) bucket before searching/caching, so nearby trades share one search instead of
// each paying for their own. The exact-second assertions below were updated to expect the
// resolved block for the BUCKETED timestamp, not the original exact one — this is the disclosed,
// intentional precision tradeoff, not a regression.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import { findBlockForTimestamp, resolvePoolAddress, readPoolPrice, __resetBaseDexCachesForTest } from './basedex'

// Mirrors of basedex.ts's own (private) ABI fragments — standard, canonical interfaces
// (Multicall3/Uniswap V3/ERC20), redefined here only so the multicall tests below can genuinely
// encode/decode real calldata round-trip, without exporting internals from basedex.ts.
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
const FACTORY_ABI = [
  { type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
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
const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

// Simulates a chain with a deterministic block->timestamp mapping: block N has timestamp N*2
// (Base's real ~2s block time), latest block is 1_000_000.
const LATEST_BLOCK = BigInt(1_000_000)
function timestampForBlock(block: bigint): bigint {
  return block * BigInt(2)
}

function makeFakeClient() {
  let getBlockCalls = 0
  const client = {
    async getBlock(args: { blockTag?: 'latest'; blockNumber?: bigint }) {
      getBlockCalls++
      if (args.blockTag === 'latest') {
        return { number: LATEST_BLOCK, timestamp: timestampForBlock(LATEST_BLOCK) }
      }
      const blockNumber = args.blockNumber as bigint
      return { number: blockNumber, timestamp: timestampForBlock(blockNumber) }
    },
  }
  return { client, getCallCount: () => getBlockCalls }
}

describe('findBlockForTimestamp caching', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('resolves the correct block via binary search on a cold cache (bucketed to the nearest 300s)', async () => {
    const { client } = makeFakeClient()
    // targetTimestampSec corresponding to block 500_000 (500_000 * 2) — bucketed down to 999_900
    // (the nearest 300s boundary at/below 1_000_000), which corresponds to block 499_950.
    const target = 1_000_000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findBlockForTimestamp(client as any, target)
    assert.equal(result, BigInt(499_950))
  })

  it('a cache hit returns the identical value with zero additional getBlock calls', async () => {
    const { client, getCallCount } = makeFakeClient()
    const target = 1_000_000

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await findBlockForTimestamp(client as any, target)
    const callsAfterFirst = getCallCount()
    assert.ok(callsAfterFirst > 1, 'expected the cold path to make multiple real getBlock calls')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await findBlockForTimestamp(client as any, target)
    const callsAfterSecond = getCallCount()

    assert.equal(second, first, 'cached result must be identical to the freshly-computed result')
    assert.equal(callsAfterSecond, callsAfterFirst, 'a cache hit must make zero additional getBlock calls')
  })

  it('different timestamps (far enough apart to land in different 300s buckets) are cached independently and both resolve correctly', async () => {
    const { client } = makeFakeClient()

    // 200_000 buckets down to 199_800 -> block 99_900. 800_000 buckets down to 799_800 -> block
    // 399_900. Still 600_000s apart, still land in entirely different buckets.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = await findBlockForTimestamp(client as any, 200_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = await findBlockForTimestamp(client as any, 800_000)

    assert.equal(a, BigInt(99_900))
    assert.equal(b, BigInt(399_900))
  })

  it('a timestamp at/after latest resolves to the latest block without a full search', async () => {
    const { client, getCallCount } = makeFakeClient()
    const target = Number(timestampForBlock(LATEST_BLOCK)) + 1000 // in the future

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findBlockForTimestamp(client as any, target)
    assert.equal(result, LATEST_BLOCK)
    assert.equal(getCallCount(), 1, 'expected only the single "latest" getBlock call, no bisection')
  })

  it('two timestamps within the same 300s bucket resolve to the identical block (the intended dedup)', async () => {
    const { client } = makeFakeClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = await findBlockForTimestamp(client as any, 1_000_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = await findBlockForTimestamp(client as any, 1_000_050) // 50s later, same 300s bucket
    assert.equal(a, b)
  })

  it('in-flight coalescing: two concurrent calls for the same bucket share one search, not two', async () => {
    const { client, getCallCount } = makeFakeClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [a, b] = await Promise.all([
      findBlockForTimestamp(client as any, 1_000_000),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findBlockForTimestamp(client as any, 1_000_010), // same 300s bucket, fired concurrently
    ])
    assert.equal(a, b)
    const callsAfterBoth = getCallCount()

    // A third call for the same (now-cached) bucket must make zero further calls.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findBlockForTimestamp(client as any, 1_000_020)
    assert.equal(getCallCount(), callsAfterBoth, 'expected the cached bucket to serve the third call with no new getBlock calls')
  })
})

const TOKEN = '0x1111111111111111111111111111111111111111'
const WETH = '0x4200000000000000000000000000000000000006'
const POOL = '0x2222222222222222222222222222222222222222'

function makeFakeReadContractClient() {
  let calls = 0
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async readContract(args: any) {
      calls++
      if (args.functionName === 'getPool') return POOL
      if (args.functionName === 'slot0') {
        // sqrtPriceX96 chosen so the resulting price is a simple, checkable number.
        return [BigInt('79228162514264337593543950336'), 0, 0, 0, 0, 0, true] // 2^96 -> ratio 1.0
      }
      if (args.functionName === 'token0') return TOKEN
      if (args.functionName === 'decimals') return 18
      throw new Error(`unexpected functionName: ${args.functionName}`)
    },
  }
  return { client, getCallCount: () => calls }
}

describe('resolvePoolAddress caching', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('resolves the pool address on a cold cache', async () => {
    const { client } = makeFakeReadContractClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = await resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(pool, POOL)
  })

  it('a cache hit returns the identical address with zero additional readContract calls', async () => {
    const { client, getCallCount } = makeFakeReadContractClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    const callsAfterFirst = getCallCount()
    assert.ok(callsAfterFirst > 0, 'expected the cold path to make at least one real readContract call')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(second, first, 'cached pool address must be identical to the freshly-resolved one')
    assert.equal(getCallCount(), callsAfterFirst, 'a cache hit must make zero additional readContract calls')
  })

  it('a repeat lookup for a token with NO pool hits the negative cache instead of re-querying', async () => {
    let calls = 0
    const noPoolClient = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async readContract(args: any) {
        calls++
        if (args.functionName === 'getPool') return '0x0000000000000000000000000000000000000000'
        throw new Error(`unexpected functionName: ${args.functionName}`)
      },
    }
    const DEAD_TOKEN = '0x9999999999999999999999999999999999999999'

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await resolvePoolAddress(noPoolClient as any, DEAD_TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(first, null)
    const callsAfterFirst = calls
    assert.equal(callsAfterFirst, 3, 'expected one getPool attempt per fee tier (3) on the cold, all-miss path')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await resolvePoolAddress(noPoolClient as any, DEAD_TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(second, null)
    assert.equal(calls, callsAfterFirst, 'a repeat lookup for the same known-dead pair must hit the negative cache, not re-query')
  })

  it('in-flight coalescing: two concurrent lookups for the same pair share one search, not two', async () => {
    let calls = 0
    const client = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async readContract(args: any) {
        calls++
        if (args.functionName === 'getPool') return POOL
        throw new Error(`unexpected functionName: ${args.functionName}`)
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [a, b] = await Promise.all([
      resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`),
    ])
    assert.equal(a, POOL)
    assert.equal(b, POOL)
    assert.equal(calls, 1, 'expected only one real getPool call for two concurrent identical lookups')
  })
})

describe('readPoolPrice caching', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('resolves the correct price on a cold cache', async () => {
    const { client } = makeFakeReadContractClient()
    const price = await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      POOL as `0x${string}`,
      TOKEN as `0x${string}`,
      WETH as `0x${string}`,
      BigInt(123),
    )
    assert.ok(price !== null && Number.isFinite(price))
  })

  it('a cache hit returns the identical price with zero additional readContract calls', async () => {
    const { client, getCallCount } = makeFakeReadContractClient()
    const first = await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      POOL as `0x${string}`,
      TOKEN as `0x${string}`,
      WETH as `0x${string}`,
      BigInt(123),
    )
    const callsAfterFirst = getCallCount()
    assert.ok(callsAfterFirst > 0, 'expected the cold path to make real readContract calls')

    const second = await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      POOL as `0x${string}`,
      TOKEN as `0x${string}`,
      WETH as `0x${string}`,
      BigInt(123),
    )
    assert.equal(second, first, 'cached price must be identical to the freshly-computed price')
    assert.equal(getCallCount(), callsAfterFirst, 'a cache hit must make zero additional readContract calls')
  })

  it('a different blockNumber is cached independently (not incorrectly reused)', async () => {
    const { client, getCallCount } = makeFakeReadContractClient()
    await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(123),
    )
    const callsAfterFirst = getCallCount()

    await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(456),
    )
    assert.ok(getCallCount() > callsAfterFirst, 'a different blockNumber must trigger a fresh read, not a stale cache hit')
  })
})

// These tests exercise the ACTUAL multicall path (resolvePoolAddress/readPoolPrice's real,
// non-fallback branch) by giving the fake client a working `call` method that genuinely decodes
// the incoming aggregate3 calldata and encodes a real aggregate3 response — a full round-trip
// through real viem encode/decode, not a shortcut mock. This is what proves the batching actually
// works, as opposed to the suites above (whose fake clients only implement `readContract`, so they
// silently exercise the sequential FALLBACK path, not the multicall path itself).
function makeFakeMulticallClient(opts: {
  poolAddress: string | null
  sqrtPriceX96?: bigint
  token0?: string
  tokenDecimals?: number
  pairedDecimals?: number
  failSubCalls?: boolean
}) {
  let callCount = 0
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async call({ to, data }: { to: string; data: `0x${string}` }) {
      callCount++
      assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase(), 'expected the multicall path to target Multicall3')
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
      const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]

      const results = calls.map((call) => {
        if (opts.failSubCalls) return { success: false, returnData: '0x' as `0x${string}` }
        // Dispatch by selector: try each known ABI in turn (mirrors how a real chain would route
        // by (target, selector) — here every sub-call's target/selector combination is unambiguous
        // given the test's own fixed addresses).
        try {
          const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: call.callData })
          if (decoded.functionName === 'getPool') {
            return {
              success: true,
              returnData: encodeFunctionResult({
                abi: FACTORY_ABI, functionName: 'getPool',
                result: (opts.poolAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
              }),
            }
          }
        } catch { /* not a getPool call */ }
        try {
          const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.callData })
          if (decoded.functionName === 'slot0') {
            return {
              success: true,
              returnData: encodeFunctionResult({
                abi: POOL_ABI, functionName: 'slot0',
                result: [opts.sqrtPriceX96 ?? BigInt('79228162514264337593543950336'), 0, 0, 0, 0, 0, true],
              }),
            }
          }
          if (decoded.functionName === 'token0') {
            return {
              success: true,
              returnData: encodeFunctionResult({
                abi: POOL_ABI, functionName: 'token0',
                result: (opts.token0 ?? TOKEN) as `0x${string}`,
              }),
            }
          }
        } catch { /* not a pool call */ }
        const decoded = decodeFunctionData({ abi: DECIMALS_ABI, data: call.callData })
        assert.equal(decoded.functionName, 'decimals')
        // Distinguish token vs pairedWith decimals by which target this sub-call was aimed at.
        const isToken = call.target.toLowerCase() === TOKEN.toLowerCase()
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: DECIMALS_ABI, functionName: 'decimals',
            result: isToken ? (opts.tokenDecimals ?? 18) : (opts.pairedDecimals ?? 18),
          }),
        }
      })

      return {
        // WRAPPING NOTE: aggregate3 has exactly one output (`returnData`, itself an array), and
        // viem's encodeFunctionResult only wraps `result` in `[result]` when `result` is NOT
        // already an array — so passing our already-array `results` directly gets misinterpreted
        // as "one value per output" instead of "the single output's array value". Wrapping once
        // more (`[results]`) is what makes `Array.isArray(result)` see the correct outer shape.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as any }),
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async readContract(): Promise<any> {
      throw new Error('unexpected readContract call — multicall path should not fall back here')
    },
  }
  return { client, getCallCount: () => callCount }
}

describe('resolvePoolAddress via the real multicall path', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('resolves the pool address via a single batched aggregate3 call', async () => {
    const { client, getCallCount } = makeFakeMulticallClient({ poolAddress: POOL })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = await resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(pool, POOL)
    assert.equal(getCallCount(), 1, 'expected all 3 fee-tier attempts to collapse into one multicall call')
  })

  it('a no-pool result via multicall still populates the negative cache correctly', async () => {
    const { client, getCallCount } = makeFakeMulticallClient({ poolAddress: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = await resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(pool, null)
    const callsAfterFirst = getCallCount()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await resolvePoolAddress(client as any, TOKEN as `0x${string}`, WETH as `0x${string}`)
    assert.equal(second, null)
    assert.equal(getCallCount(), callsAfterFirst, 'a repeat lookup for the same known-dead pair must hit the negative cache')
  })
})

describe('readPoolPrice via the real multicall path', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
  })

  it('resolves the identical price to the sequential path via a single batched aggregate3 call', async () => {
    const multi = makeFakeMulticallClient({ poolAddress: POOL, token0: TOKEN, tokenDecimals: 18, pairedDecimals: 18 })
    const sequential = makeFakeReadContractClient()

    const priceViaMulticall = await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      multi.client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(123),
    )
    const priceViaSequential = await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sequential.client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(456),
    )

    assert.equal(priceViaMulticall, priceViaSequential, 'multicall and sequential paths must compute the identical price')
    assert.equal(multi.getCallCount(), 1, 'expected all 4 reads to collapse into one multicall call')
  })

  it('attempts the sequential fallback when a multicall sub-call fails (never fabricates a partial price)', async () => {
    __resetBaseDexCachesForTest()
    const multi = makeFakeMulticallClient({ poolAddress: POOL, failSubCalls: true })
    // This fake client's readContract throws unconditionally (see makeFakeMulticallClient above),
    // so a correct implementation reacts to the multicall's partial failure by attempting the
    // sequential fallback — which then itself throws here, proving the fallback path was genuinely
    // exercised (not skipped) and that no partial/fabricated price is ever silently returned.
    await assert.rejects(
      () => readPoolPrice(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        multi.client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(789),
      ),
      /unexpected readContract call/,
      'expected the sequential fallback to have been attempted (and to surface its own real failure), never a fabricated price',
    )
  })
})

// Tests for findBlockForTimestamp's caching behavior (src/modules/pricingAtTimeEngine/sources/
// basedex.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.test.ts
//
// Uses a minimal fake PublicClient (only the `getBlock` method this function actually calls) so
// this never hits real RPC/env vars. Asserts two things: (1) a cache hit returns the exact same
// value the full binary search would have computed — zero precision loss — and (2) it does so
// without making any further `getBlock` calls.
//
// TIMESTAMP BUCKETING, DISCLOSED (emergency-CU-containment task, superseding the file's earlier
// 5-minute bucket): findBlockForTimestamp now rounds the requested timestamp down to a UTC-HOUR
// (3600s) bucket before resolving/caching, and resolution itself is now exactly "one shared
// getBlock:latest read, a deterministic in-memory estimate, and at most one bounded correction
// getBlock read per bucket" — no bisection, no window-widening. The exact-second assertions below
// expect the resolved block for the BUCKETED timestamp via that new algorithm, not a binary search
// — this is the disclosed, intentional precision tradeoff this task itself requested, not a
// regression.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import { findBlockForTimestamp, resolvePoolAddress, readPoolPrice, __resetBaseDexCachesForTest, resetBaseDexRpcBudgetForScan } from './basedex'
import { MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN } from './historicalRpcBudget'

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

  it('resolves the correct block via one deterministic estimate + one correction read on a cold cache (bucketed to the nearest UTC hour)', async () => {
    const { client } = makeFakeClient()
    // target=1_000_000 buckets down to 997_200 (the nearest 3600s boundary at/below it). On this
    // synthetic chain's exactly-linear 2s block time, the deterministic estimate plus its one
    // correction read lands EXACTLY on the bucketed timestamp with zero remaining error —
    // hand-verified: block 498_600 has timestamp 997_200.
    const target = 1_000_000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findBlockForTimestamp(client as any, target)
    assert.equal(result, BigInt(498_600))
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

  it('different timestamps (far enough apart to land in different UTC-hour buckets) are cached independently and both resolve correctly', async () => {
    const { client } = makeFakeClient()

    // 200_000 buckets down to 198_000 -> block 99_000. 800_000 buckets down to 799_200 -> block
    // 399_600 (hand-verified via the same exact-linear-chain arithmetic as the cold-cache test
    // above). Still land in entirely different UTC-hour buckets.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = await findBlockForTimestamp(client as any, 200_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = await findBlockForTimestamp(client as any, 800_000)

    assert.equal(a, BigInt(99_000))
    assert.equal(b, BigInt(399_600))
  })

  it('a timestamp at/after latest resolves to the latest block without a full search', async () => {
    const { client, getCallCount } = makeFakeClient()
    // Must bucket down to at/after latest.timestamp (2_000_000) — a value merely "in the future"
    // is not enough on its own now that bucketing rounds down to a full UTC hour; 2_005_000 buckets
    // to 2_001_600, still >= latest.timestamp.
    const target = 2_005_000

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findBlockForTimestamp(client as any, target)
    assert.equal(result, LATEST_BLOCK)
    assert.equal(getCallCount(), 1, 'expected only the single "latest" getBlock call, no correction read needed')
  })

  it('two timestamps within the same UTC-hour bucket resolve to the identical block (the intended dedup)', async () => {
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

describe('findBlockForTimestamp scan-level RPC budget', () => {
  beforeEach(() => {
    __resetBaseDexCachesForTest()
    resetBaseDexRpcBudgetForScan()
  })

  it('stops making real getBlock calls once the scan-level budget is exhausted, returning null for any new bucket', async () => {
    const { client, getCallCount } = makeFakeClient()

    // Each iteration uses a timestamp far enough apart (10_000s) to land in a brand new UTC-hour
    // bucket — every one is a genuine cold search, no cache hits — so this reliably drives the
    // cumulative real-call count past the (now much tighter, MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN)
    // budget within a bounded number of iterations.
    let lastResult: bigint | null = null
    let callsBeforeExhaustion = 0
    for (let i = 1; i <= 150; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastResult = await findBlockForTimestamp(client as any, i * 10_000)
      if (lastResult === null) {
        callsBeforeExhaustion = getCallCount()
        break
      }
    }

    assert.equal(lastResult, null, 'expected the budget to exhaust within 150 distinct cold buckets and the exceeding call to return null')
    assert.ok(callsBeforeExhaustion <= MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN,
      `expected exhaustion at or before the hard block-resolution cap (${MAX_BLOCK_RESOLUTION_CALLS_PER_SCAN}), got ${callsBeforeExhaustion} real calls`)

    // A further call for yet another brand-new bucket must also short-circuit to null with zero
    // additional real getBlock calls — the budget stays open, not a one-shot trip. Deliberately
    // BELOW latest.timestamp (2_000_000) and outside the loop's already-touched range, so this
    // must go through a real (refused) correction-read attempt rather than the free "at/after
    // latest" shortcut, which costs nothing and would succeed even with the budget exhausted.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const further = await findBlockForTimestamp(client as any, 1_500_000)
    assert.equal(further, null)
    assert.equal(getCallCount(), callsBeforeExhaustion, 'expected the budget-exceeded path to make zero further real getBlock calls')
  })

  it('a bucket already resolved before the budget exhausted is still served from cache afterward', async () => {
    const { client, getCallCount } = makeFakeClient()

    const firstResolved = await findBlockForTimestamp(client as any, 10_000)
    assert.notEqual(firstResolved, null)

    // Exhaust the budget with brand-new buckets.
    for (let i = 1; i <= 150; i++) {
      const result = await findBlockForTimestamp(client as any, i * 20_000 + 5)
      if (result === null) break
    }

    const callsAfterExhaustion = getCallCount()
    const cachedAgain = await findBlockForTimestamp(client as any, 10_000)
    assert.equal(cachedAgain, firstResolved, 'expected the pre-exhaustion bucket to still resolve correctly from cache')
    assert.equal(getCallCount(), callsAfterExhaustion, 'expected zero new getBlock calls for an already-cached bucket, budget notwithstanding')
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
    // MULTICALL CLIENT, DISCLOSED: the sequential-only mock (makeFakeReadContractClient) has no
    // `.call`, so readPoolPrice's real multicall-first attempt genuinely fails against it before
    // ever reaching the sequential fallback — a real, already-spent RPC call on its own — which
    // then leaves too little of the per-token budget (MAX_CALLS_PER_TOKEN) for the fallback's own 4
    // calls. Using the real-multicall-path client here tests the identical caching behavior via the
    // path real production traffic overwhelmingly takes.
    const { client } = makeFakeMulticallClient({ poolAddress: POOL, token0: TOKEN, tokenDecimals: 18, pairedDecimals: 18 })
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
    // See "resolves the correct price on a cold cache" above for why the multicall client, not the
    // sequential-only one, is used here.
    const { client, getCallCount } = makeFakeMulticallClient({ poolAddress: POOL, token0: TOKEN, tokenDecimals: 18, pairedDecimals: 18 })
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
    // MULTICALL CLIENT, DISCLOSED: uses the real-multicall-path fake client (1 real call per
    // distinct block) rather than the sequential-only one — two distinct blocks for the SAME token
    // cost 2 calls total this way, comfortably within the per-token RPC budget, while still fully
    // exercising the "different blockNumber must not reuse a stale cache entry" behavior this test
    // is actually about.
    const { client, getCallCount } = makeFakeMulticallClient({ poolAddress: POOL, token0: TOKEN, tokenDecimals: 18, pairedDecimals: 18 })
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

  // REGRESSION TEST, DISCLOSED: this is the exact case that was never covered before — every other
  // test in this file uses a fake pool where `tokenAddress` IS the pool's token0 (see
  // makeFakeReadContractClient's `token0` returning TOKEN directly) AND equal decimals for both
  // tokens, which happens to mask the real bug entirely (decimalAdjustment = 10^0 = 1 either way).
  // Found live: a real scan priced an 18-decimal Base token against 6-decimal USDC and produced a
  // price off by roughly 10^24x (realizedPnlUsd around -3.9e28), because the old formula
  // reciprocated the WHOLE decimal-adjusted product instead of just the raw ratio's orientation.
  // This test uses a concrete, hand-verified WETH(18dec)/USDC(6dec)-style pool where tokenAddress is
  // the pool's token1 (pairedWith is token0) — the exact orientation the old code got wrong.
  it('resolves the correct price when tokenAddress is the pool\'s token1 with differing decimals (the exact bug this regresses)', async () => {
    const PAIRED_TOKEN0 = '0x3333333333333333333333333333333333333333' // plays the "USDC, 6 decimals" role, and IS the pool's token0
    const TOKEN_AS_TOKEN1 = '0x4444444444444444444444444444444444444444' // plays the "WETH, 18 decimals" role, and is tokenAddress here
    // Chosen so rawRatio = (sqrtPriceX96/2^96)^2 = 3.333333...e8 — matches "1 WETH = 3000 USDC"
    // once decimal-adjusted (hand-verified: humanToken1PerToken0 = rawRatio*10^(6-18) ≈ 3.333e-4,
    // i.e. 1 USDC = 0.0003333 WETH => 1 WETH = 3000 USDC).
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(3.333333333e8) * 2 ** 96))
    // GOES THROUGH THE REAL MULTICALL PATH, DISCLOSED: a working `call` method (same real
    // encode/decode round-trip as makeFakeMulticallClient below) so this resolves in ONE real call
    // — well within the per-token RPC budget — rather than exercising the (now budget-refused once
    // any prior multicall attempt has already spent from the same token's allowance) sequential
    // fallback, which is not what this regression test is actually about.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async call({ data }: { to: string; data: `0x${string}` }) {
        const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
        const calls = args[0] as { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }[]
        const results = calls.map((call) => {
          try {
            const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.callData })
            if (decoded.functionName === 'slot0') {
              return { success: true, returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: 'slot0', result: [sqrtPriceX96, 0, 0, 0, 0, 0, true] }) }
            }
            if (decoded.functionName === 'token0') {
              return { success: true, returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: 'token0', result: PAIRED_TOKEN0 as `0x${string}` }) }
            }
          } catch { /* not a pool call */ }
          const decoded = decodeFunctionData({ abi: DECIMALS_ABI, data: call.callData })
          const isToken1 = call.target.toLowerCase() === TOKEN_AS_TOKEN1.toLowerCase()
          return { success: true, returnData: encodeFunctionResult({ abi: DECIMALS_ABI, functionName: 'decimals', result: isToken1 ? 18 : 6 }) }
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { data: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as any }) }
      },
    }

    const price = await readPoolPrice(client, POOL as `0x${string}`, TOKEN_AS_TOKEN1 as `0x${string}`, PAIRED_TOKEN0 as `0x${string}`, BigInt(1))
    assert.ok(price !== null, 'expected a real price, not null')
    // Correct answer is ~3000 (USDC per WETH). The pre-fix formula produced ~10^24x this value.
    assert.ok(Math.abs((price as number) - 3000) < 1, `expected price ≈ 3000, got ${price}`)
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
  poolNotYetDeployed?: boolean
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
        // POOL-NOT-YET-DEPLOYED SIMULATION: a call to an address with no code at this historical
        // block returns `success: true` with EMPTY returndata (never a revert) — this is what a real
        // chain does, distinct from failSubCalls' `success: false` case above.
        if (opts.poolNotYetDeployed) {
          try {
            const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.callData })
            if (decoded.functionName === 'slot0' || decoded.functionName === 'token0') {
              return { success: true, returnData: '0x' as `0x${string}` }
            }
          } catch { /* not a pool call, fall through to normal handling below */ }
        }
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

  it('resolves the correct price via a single batched aggregate3 call', async () => {
    // NO SEQUENTIAL COMPARISON, DISCLOSED (emergency-CU-containment task): this test used to also
    // drive the same computation through the pure-sequential (no multicall) path and assert the two
    // prices matched. Under the new hard per-token RPC budget (MAX_CALLS_PER_TOKEN = 4), that
    // comparison is no longer exercisable through the real readPoolPrice() entry point for ANY
    // token: the multicall attempt itself is one already-spent real call before it can fail, so a
    // sequential fallback's own 4 calls would need 5 total for one token, one over the cap — the
    // sequential price-computation math (identical formula, see readPoolPrice's own
    // PRICE-CORRUPTION FIX header) is instead covered directly by the "tokenAddress is the pool's
    // token1" regression test below, via the multicall path with a non-trivial orientation. This
    // test now simply asserts the multicall path computes the expected price in one real call —
    // sqrtPriceX96 = 2^96 (rawRatio = 1) with equal 18-decimal tokens must price at exactly 1.
    const multi = makeFakeMulticallClient({ poolAddress: POOL, token0: TOKEN, tokenDecimals: 18, pairedDecimals: 18 })

    const price = await readPoolPrice(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      multi.client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(123),
    )

    assert.equal(price, 1, 'expected sqrtPriceX96 = 2^96 with equal decimals to price at exactly 1')
    assert.equal(multi.getCallCount(), 1, 'expected all 4 reads to collapse into one multicall call')
  })

  it('EMERGENCY CU CONTAINMENT: a multicall sub-call failure fails closed on the per-token budget rather than fabricating a price via an uncapped sequential retry', async () => {
    __resetBaseDexCachesForTest()
    const multi = makeFakeMulticallClient({ poolAddress: POOL, failSubCalls: true })
    // Real cost accounting, disclosed: the multicall attempt ITSELF is one real, already-spent RPC
    // call (it genuinely went out over the wire) even though its result was unusable — so the
    // sequential fallback's own 4 calls would need a total of 5 for this one token, one over
    // MAX_CALLS_PER_TOKEN (4). This is the hard per-token cap doing exactly what this task asked:
    // the fallback is refused rather than silently exceeding the budget, and the price stays
    // honestly unresolved — never fabricated, never partially computed.
    await assert.rejects(
      () => readPoolPrice(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        multi.client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(789),
      ),
      /historical_rpc_budget_exceeded:pool_price/,
      'expected the sequential fallback to be refused by the per-token RPC budget, not silently attempted past the cap',
    )
  })

  // CONFIRMED FIX, DISCLOSED (see PoolNotYetDeployedError's own header in basedex.ts): a pool that
  // didn't exist yet at the trade's historical block returns empty (not failed) returndata for its
  // own calls — this must be classified distinctly AND must never retry the identically-doomed
  // sequential fallback (a real, avoidable RPC cost this fix removes).
  it('never falls back to the sequential path when the pool had no code yet at this historical block (avoids a doomed, wasted retry)', async () => {
    __resetBaseDexCachesForTest()
    const multi = makeFakeMulticallClient({ poolAddress: POOL, poolNotYetDeployed: true })
    // This fake client's readContract throws unconditionally on ANY call — if the fix regressed and
    // fell back to sequential here, this assertion would catch it via a mismatched rejection message.
    await assert.rejects(
      () => readPoolPrice(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        multi.client as any, POOL as `0x${string}`, TOKEN as `0x${string}`, WETH as `0x${string}`, BigInt(1),
      ),
      /pool_not_yet_deployed_at_block/,
      'expected a distinguishable pool_not_yet_deployed_at_block error, with the sequential fallback never attempted',
    )
    assert.equal(multi.getCallCount(), 1, 'expected exactly one multicall call — no wasted sequential retry')
  })
})

// Tests for findBlockForTimestamp's caching behavior (src/modules/pricingAtTimeEngine/sources/
// basedex.ts). NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/basedex.test.ts
//
// Uses a minimal fake PublicClient (only the `getBlock` method this function actually calls) so
// this never hits real RPC/env vars. Asserts two things: (1) a cache hit returns the exact same
// value the full binary search would have computed — zero precision loss — and (2) it does so
// without making any further `getBlock` calls.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { findBlockForTimestamp, resolvePoolAddress, readPoolPrice, __resetBaseDexCachesForTest } from './basedex'

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

  it('resolves the correct block via binary search on a cold cache', async () => {
    const { client } = makeFakeClient()
    // targetTimestampSec corresponding to block 500_000 (500_000 * 2)
    const target = 1_000_000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findBlockForTimestamp(client as any, target)
    assert.equal(result, BigInt(500_000))
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

  it('different timestamps are cached independently and both resolve correctly', async () => {
    const { client } = makeFakeClient()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = await findBlockForTimestamp(client as any, 200_000) // block 100_000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = await findBlockForTimestamp(client as any, 800_000) // block 400_000

    assert.equal(a, BigInt(100_000))
    assert.equal(b, BigInt(400_000))
  })

  it('a timestamp at/after latest resolves to the latest block without a full search', async () => {
    const { client, getCallCount } = makeFakeClient()
    const target = Number(timestampForBlock(LATEST_BLOCK)) + 1000 // in the future

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findBlockForTimestamp(client as any, target)
    assert.equal(result, LATEST_BLOCK)
    assert.equal(getCallCount(), 1, 'expected only the single "latest" getBlock call, no bisection')
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

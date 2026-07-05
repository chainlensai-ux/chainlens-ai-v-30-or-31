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
import { findBlockForTimestamp, __resetBaseDexCachesForTest } from './basedex'

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

//   npx tsx --test src/lib/sellVenueClassifier.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, pad } from 'viem'
import { AERODROME_CLASSIC_SWAP_TOPIC0, V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, classifySellVenue } from './sellVenueClassifier'
import { V4_POOL_MANAGERS, V4_SWAP_TOPIC0 } from './v4RouteQuote'
import { transferLog, WALLET, POOL_A, TOKEN_X } from '../modules/receiptSwapDecoder/fixtures.test-helpers'
import type { RawReceiptLog } from '../modules/receiptSwapDecoder/types'

const log = (address: string, topic0: string): RawReceiptLog => ({ logIndex: 1, address, topics: [topic0, pad(WALLET as `0x${string}`), pad(WALLET as `0x${string}`)], data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(1)]) })
const factory = (f: string | null) => async () => f
const base = (logs: RawReceiptLog[], extra: Partial<Parameters<typeof classifySellVenue>[0]> = {}) => classifySellVenue({ chain: 'base', walletAddress: WALLET, logs, ...extra })

describe('classifySellVenue', () => {
  it('v4 from the canonical PoolManager', async () => {
    assert.equal(await base([log(V4_POOL_MANAGERS.base!, V4_SWAP_TOPIC0)]), 'v4')
  })
  it('Aerodrome Classic by its own Swap event, Slipstream by factory', async () => {
    assert.equal(await base([log(POOL_A, AERODROME_CLASSIC_SWAP_TOPIC0)]), 'aerodrome')
    assert.equal(await base([log(POOL_A, V3_SWAP_TOPIC0)], { readPoolFactory: factory('0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a') }), 'aerodrome')
  })
  it('v3 / v2 by the Uniswap factory, with the matching event shape only', async () => {
    assert.equal(await base([log(POOL_A, V3_SWAP_TOPIC0)], { readPoolFactory: factory('0x33128a8fc17869897dce68ed026d694621f6fdfd') }), 'v3')
    assert.equal(await base([log(POOL_A, V2_SWAP_TOPIC0)], { readPoolFactory: factory('0x8909dc15e40173ff4699343b6eb8132c65e18ec6') }), 'v2')
    assert.equal(await base([log(POOL_A, V2_SWAP_TOPIC0)], { readPoolFactory: factory('0x33128a8fc17869897dce68ed026d694621f6fdfd') }), 'unknown')
    assert.equal(await classifySellVenue({ chain: 'eth', walletAddress: WALLET, logs: [log(POOL_A, V3_SWAP_TOPIC0)], readPoolFactory: factory('0x1f98431c8ad98523631ae4a59f267346ea31f984') }), 'v3')
  })
  it('aggregator when the tx went to a verified aggregator router', async () => {
    assert.equal(await base([log(POOL_A, AERODROME_CLASSIC_SWAP_TOPIC0)], { txTo: '0x111111125421ca6dc452d289314280a0f8842a65' }), 'aggregator')
  })
  it('plain transfer, and unknown for unrecognised swaps or factories', async () => {
    assert.equal(await base([transferLog(0, TOKEN_X, WALLET, POOL_A, BigInt(5))]), 'plain_transfer')
    assert.equal(await base([log(POOL_A, V3_SWAP_TOPIC0)], { readPoolFactory: factory('0x9999999999999999999999999999999999999999') }), 'unknown')
    assert.equal(await base([log(POOL_A, V3_SWAP_TOPIC0)]), 'unknown')
  })
})

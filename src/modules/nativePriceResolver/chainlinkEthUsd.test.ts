// Chainlink ETH/USD on Base: exact block for a timestamp, strict decoding, budget-gated calls.
// Block numbers and prices are the live values read for 2026-09-16 and 2026-10-27 at 23:59:59 UTC.
//   npx tsx --test src/modules/nativePriceResolver/chainlinkEthUsd.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { baseBlockAtTimestamp, CHAINLINK_ETH_USD_BASE_FEED, createChainlinkBaseEthUsdReader, decodeLatestRoundData } from './chainlinkEthUsd'

const word = (v: bigint) => v.toString(16).padStart(64, '0')
const round = (answer: bigint, updatedAt: number) => `0x${word(BigInt(1))}${word(answer)}${word(BigInt(updatedAt))}${word(BigInt(updatedAt))}${word(BigInt(1))}`

test('Base block for a timestamp: 2-second blocks from genesis (live-verified)', () => {
  assert.equal(baseBlockAtTimestamp(Date.parse('2026-09-16T23:59:59Z') / 1000), 51406926)
  assert.equal(baseBlockAtTimestamp(Date.parse('2026-10-27T23:59:59Z') / 1000), 53178126)
  assert.equal(baseBlockAtTimestamp(1_600_000_000), null, 'before Base existed')
})

test('decoding: 8 decimals; zero, negative or malformed answers are errors', () => {
  assert.deepEqual(decodeLatestRoundData(round(BigInt(241861697712), 1789602671)), { priceUsd: 2418.61697712, updatedAtSec: 1789602671 })
  assert.deepEqual(decodeLatestRoundData(round(BigInt(0), 1)), { error: 'chainlink_non_positive_answer' })
  assert.deepEqual(decodeLatestRoundData(round((BigInt(1) << BigInt(256)) - BigInt(5), 1)), { error: 'chainlink_non_positive_answer' })
  assert.deepEqual(decodeLatestRoundData('0x1234'), { error: 'chainlink_malformed_response' })
})

test('reader: one eth_call to the feed at the computed block; no call at all when the budget refuses', async () => {
  const bodies: Array<{ method: string; params: [{ to: string; data: string }, string] }> = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return Response.json({ jsonrpc: '2.0', id: 1, result: round(BigInt(234750008150), 1793145547) })
  }) as unknown as typeof fetch
  const reader = createChainlinkBaseEthUsdReader({ rpcUrl: 'https://rpc.test', consume: () => true, fetchImpl })!
  const at = Date.parse('2026-10-27T23:59:59Z') / 1000
  assert.deepEqual(await reader(at), { priceUsd: 2347.5000815, updatedAtSec: 1793145547 })
  assert.equal(bodies[0].method, 'eth_call')
  assert.equal(bodies[0].params[0].to, CHAINLINK_ETH_USD_BASE_FEED)
  assert.equal(bodies[0].params[1], `0x${(53178126).toString(16)}`)

  const refused = createChainlinkBaseEthUsdReader({ rpcUrl: 'https://rpc.test', consume: () => false, fetchImpl })!
  assert.deepEqual(await refused(at), { error: 'chainlink_rpc_budget_exhausted' })
  assert.equal(bodies.length, 1)
  assert.equal(createChainlinkBaseEthUsdReader({ rpcUrl: null, consume: () => true }), null)
})

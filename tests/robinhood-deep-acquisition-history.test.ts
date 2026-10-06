import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __resetRobinhoodBlockscoutRateLimitForTest, getBlockscoutHistoricalTokenInbounds } from '../lib/server/robinhoodBlockscoutEvidence.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'test-key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const TOKEN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54'
const SELL_TS = 1790155166
const row = (id: number, token = TOKEN, to = WALLET, time = '2026-09-22T12:00:00Z') => ({
  transaction_hash: `0x${id.toString(16).padStart(64, '0')}`, timestamp: time,
  from: { hash: '0x1111111111111111111111111111111111111111' }, to: { hash: to },
  total: { value: String(id), decimals: '18' }, token: { address: token },
})
const reply = (items: unknown[], next: unknown) => new Response(JSON.stringify({ items, next_page_params: next }), { status: 200, headers: { 'content-type': 'application/json' } })
beforeEach(() => __resetRobinhoodBlockscoutRateLimitForTest())

test('historical pager follows cursors and admits only exact older inbound token rows', async () => {
  const paths: string[] = []
  const fetchImpl = async (url: string) => {
    paths.push(url)
    return paths.length === 1
      ? reply([row(1), row(2, '0x2222222222222222222222222222222222222222'), row(3, TOKEN, WALLET, '2026-09-24T00:00:00Z')], { block_number: 123, index: 4 })
      : reply([row(4), row(5, TOKEN, '0x3333333333333333333333333333333333333333')], null)
  }
  const r = await getBlockscoutHistoricalTokenInbounds(WALLET, TOKEN, SELL_TS, fetchImpl, { maxPages: 4, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
  assert.equal(r.pagesRequested, 2)
  assert.equal(r.pagesSucceeded, 2)
  assert.equal(r.olderInboundRowsFound, 2)
  assert.deepEqual(r.rows.map((x) => x.txHash), [row(1).transaction_hash, row(4).transaction_hash])
  assert.match(paths[0], /type=ERC-20&filter=to&token=0x12f190a9f9d7d37a250758b26824b97ce941bf54/)
  assert.match(paths[1], /block_number=123/)
})

test('historical pager never exceeds four pages or twenty inbound rows', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return reply([row(calls)], { page: calls + 1 }) }
  const r = await getBlockscoutHistoricalTokenInbounds(WALLET, TOKEN, SELL_TS, fetchImpl, { maxPages: 10, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
  assert.equal(calls, 4)
  assert.equal(r.stopReason, 'page_cap')
  __resetRobinhoodBlockscoutRateLimitForTest()
  const many = await getBlockscoutHistoricalTokenInbounds(WALLET, TOKEN, SELL_TS, async () => reply(Array.from({ length: 30 }, (_, i) => row(i + 1)), { page: 2 }), { maxPages: 4, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
  assert.equal(many.rows.length, 20)
  assert.equal(many.pagesRequested, 1)
  assert.equal(many.stopReason, 'candidate_cap')
})

test('provider 429 or malformed cursor yields no invented acquisition evidence', async () => {
  const rateLimited = await getBlockscoutHistoricalTokenInbounds(WALLET, TOKEN, SELL_TS, async () => new Response('no', { status: 429 }), { maxPages: 4, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
  assert.deepEqual(rateLimited.rows, [])
  assert.equal(rateLimited.pagesSucceeded, 0)
  __resetRobinhoodBlockscoutRateLimitForTest()
  const malformed = await getBlockscoutHistoricalTokenInbounds(WALLET, TOKEN, SELL_TS, async () => reply([], { nested: { bad: true } }), { maxPages: 4, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
  assert.equal(malformed.stopReason, 'invalid_cursor')
})

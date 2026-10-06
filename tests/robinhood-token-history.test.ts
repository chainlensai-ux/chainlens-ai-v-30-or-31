import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __resetRobinhoodBlockscoutRateLimitForTest, getBlockscoutTokenHistoryInbounds } from '../lib/server/robinhoodBlockscoutEvidence.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'test-key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const wallet = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const token = '0x12f190a9f9d7d37a250758b26824b97ce941bf54'
const sellTs = 1790155166
const txHash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
const row = (i: number, overrides: Record<string, unknown> = {}) => ({
  transaction_hash: txHash(i), timestamp: '2026-09-22T12:00:00Z',
  to: { hash: wallet }, total: { value: String(i) }, token: { address_hash: token, type: 'ERC-20' }, ...overrides,
})
const page = (items: unknown[], next: unknown = null) => new Response(JSON.stringify({ items, next_page_params: next }), { status: 200 })
beforeEach(() => __resetRobinhoodBlockscoutRateLimitForTest())

async function scan(pages: Response[]) {
  const paths: string[] = []
  const audits: Array<Record<string, unknown>> = []
  const oldWarn = console.warn
  console.warn = (tag: unknown, value: unknown) => { if (tag === '[robinhood-token-history-page-audit]') audits.push(value as Record<string, unknown>) }
  try {
    const result = await getBlockscoutTokenHistoryInbounds(wallet, token, sellTs, async (url) => {
      paths.push(url)
      assert.ok(paths.length <= pages.length)
      return pages[paths.length - 1]
    }, { maxPages: 4, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
    return { result, paths, audits }
  } finally { console.warn = oldWarn }
}

test('token endpoint recognizes four production-shaped wallet inbounds and advances to an older candidate', async () => {
  const known = [1, 2, 3, 4].map((i) => row(i))
  const { result, paths, audits } = await scan([
    page(known, { block_number: 123, index: 4, items_count: 50 }),
    page([row(5), row(6, { to: { hash: '0x1111111111111111111111111111111111111111' } })]),
  ])
  assert.equal(result.pagesRequested, 2)
  assert.equal(result.walletMatches, 5)
  assert.equal(result.candidatesFound, 5)
  assert.equal(audits[0].acceptedRowCount, 4)
  assert.deepEqual(result.rows.map((r) => r.txHash), [1, 2, 3, 4, 5].map(txHash))
  assert.match(paths[0], /\/api\/v2\/tokens\/0x12f190.*\/transfers$/)
  assert.match(paths[1], /block_number=123&index=4&items_count=50/)
})

test('token endpoint locally rejects after-sell, invalid amount, wrong token, wrong recipient and duplicates', async () => {
  const { result, audits } = await scan([page([
    row(1), row(1), row(2, { timestamp: '2026-09-24T00:00:00Z' }),
    row(3, { total: { value: '0' } }), row(4, { total: { value: 'bad' } }),
    row(5, { token: { address_hash: '0x1111111111111111111111111111111111111111' } }),
    row(6, { token: { address: token, address_hash: '0x1111111111111111111111111111111111111111' } }),
    row(7, { to: { hash: '0x1111111111111111111111111111111111111111' } }),
  ])])
  assert.equal(result.candidatesFound, 1)
  assert.equal(audits[0].walletInboundMatches, 7)
  assert.equal(audits[0].beforeSellMatches, 6)
})

test('token history follows only flat provider cursor and caps at four pages', async () => {
  const pages = Array.from({ length: 4 }, (_, i) => page([], { block_number: 100 - i, index: i }))
  const { result, paths } = await scan(pages)
  assert.equal(result.pagesRequested, 4)
  assert.equal(result.stopReason, 'page_cap')
  assert.ok(paths[3].includes('block_number=98'))
  __resetRobinhoodBlockscoutRateLimitForTest()
  const nested = await scan([page([], { nested: { page: 2 } })])
  assert.equal(nested.result.stopReason, 'invalid_cursor')
  assert.equal(nested.audits[0].cursorRejectedReason, 'nested_value')
  __resetRobinhoodBlockscoutRateLimitForTest()
  const repeated = await scan([page([], { index: 2 }), page([], { index: 2 })])
  assert.equal(repeated.result.stopReason, 'invalid_cursor')
  assert.equal(repeated.audits[1].cursorRejectedReason, 'repeated_cursor')
})

test('token-history intake stops at twenty exact wallet inbounds', async () => {
  const { result, paths } = await scan([page(Array.from({ length: 30 }, (_, i) => row(i + 1)), { index: 2 })])
  assert.equal(result.candidatesFound, 20)
  assert.equal(result.stopReason, 'candidate_cap')
  assert.equal(paths.length, 1)
})

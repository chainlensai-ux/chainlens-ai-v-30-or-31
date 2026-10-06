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

async function scanPage(items: unknown[], next: unknown = null) {
  const audits: Array<Record<string, unknown>> = []
  const previous = console.warn
  console.warn = (tag: unknown, audit: unknown) => { if (tag === '[robinhood-deep-history-page-audit]') audits.push(audit as Record<string, unknown>) }
  try {
    const result = await getBlockscoutHistoricalTokenInbounds(WALLET, TOKEN, SELL_TS, async () => reply(items, next), { maxPages: 4, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
    return { result, audits }
  } finally { console.warn = previous }
}

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

test('Blockscout TokenInfo address_hash and address variants require an exact valid identity', async () => {
  const onlyHash = { ...row(10), token: { address_hash: TOKEN, symbol: 'not-proof' } }
  const onlyAddress = { ...row(11), token: { address: TOKEN } }
  const bothEqual = { ...row(12), token: { address: TOKEN.toUpperCase().replace('0X', '0x'), address_hash: TOKEN } }
  const bothConflict = { ...row(13), token: { address: TOKEN, address_hash: '0x2222222222222222222222222222222222222222' } }
  const wrongToken = { ...row(14), token: { address_hash: '0x2222222222222222222222222222222222222222', symbol: 'same-name' } }
  const wrongRecipient = { ...row(15), token: { address_hash: TOKEN }, to: { hash: '0x3333333333333333333333333333333333333333' } }
  const afterSell = { ...row(16, TOKEN, WALLET, '2026-09-24T00:00:00Z'), token: { address_hash: TOKEN } }
  const invalidAddress = { ...row(17), token: { address_hash: 'not-an-address', symbol: 'same-name' } }
  const invalidTx = { ...row(18), transaction_hash: 'not-a-tx', token: { address_hash: TOKEN } }
  const invalidRaw = { ...row(19), total: { value: '0', decimals: '18' }, token: { address_hash: TOKEN } }
  const { result, audits } = await scanPage([onlyHash, onlyAddress, bothEqual, bothConflict, wrongToken, wrongRecipient, afterSell, invalidAddress, invalidTx, invalidRaw])
  assert.deepEqual(result.rows.map((item) => item.txHash), [onlyHash.transaction_hash, onlyAddress.transaction_hash, bothEqual.transaction_hash])
  const audit = audits[0]
  assert.equal(audit.rawItemCount, 10)
  assert.equal(audit.acceptedRowCount, 3)
  assert.equal(audit.token_identity_conflict, 1)
  assert.equal(audit.rejectedWrongToken, 3)
  assert.equal(audit.rejectedWrongDirection, 1)
  assert.equal(audit.rejectedTimestamp, 1)
  assert.equal(audit.rejectedTxHash, 1)
  assert.equal(audit.rejectedRawAmount, 1)
  assert.deepEqual(audit.tokenAddressFieldSeen, { address: 1, address_hash: 7, both: 2, none: 0 })
  assert.equal(audit.authMode, 'none')
  assert.equal(audit.httpStatus, 200)
  assert.equal(audit.queryType, 'ERC-20')
  assert.equal(audit.queryFilter, 'to')
  assert.equal(audit.requestedToken, TOKEN)
})

test('production-shaped first page counts four known exact-token inbounds and continues to older page', async () => {
  // The four published hashes were truncated; these suffixes are fixture bytes, not claimed on-chain hashes.
  const knownPrefixes = ['455896', '68a04c', '48ed6d', 'cc37ff']
  const known = knownPrefixes.map((prefix, i) => ({ ...row(i + 1), transaction_hash: `0x${prefix}${'0'.repeat(64 - prefix.length)}`, token: { address_hash: TOKEN, symbol: 'ignored' } }))
  const older = { ...row(5, TOKEN, WALLET, '2026-09-20T00:00:00Z'), token: { address_hash: TOKEN } }
  const pages = [reply(known, { block_number: 123, index: 4 }), reply([older], null)]
  const pageAudits: Array<Record<string, unknown>> = []
  const previous = console.warn
  console.warn = (tag: unknown, audit: unknown) => { if (tag === '[robinhood-deep-history-page-audit]') pageAudits.push(audit as Record<string, unknown>) }
  try {
    let calls = 0
    const result = await getBlockscoutHistoricalTokenInbounds(WALLET, TOKEN, SELL_TS, async () => pages[calls++], { maxPages: 4, maxCandidates: 20, deadlineAt: Date.now() + 5000 })
    assert.equal(calls, 2)
    assert.equal(result.pagesSucceeded, 2)
    assert.equal(result.olderInboundRowsFound, 5)
    assert.equal(pageAudits[0].rawItemCount, 4)
    assert.equal(pageAudits[0].acceptedRowCount, 4)
    assert.equal(pageAudits[0].nextPagePresent, true)
    assert.equal(pageAudits[1].acceptedRowCount, 1)
    assert.equal(result.stopReason, 'history_exhausted')
  } finally { console.warn = previous }
})

test('true empty filtered history reports history_exhausted with zero raw items', async () => {
  const { result, audits } = await scanPage([])
  assert.equal(result.stopReason, 'history_exhausted')
  assert.equal(result.olderInboundRowsFound, 0)
  assert.equal(audits[0].rawItemCount, 0)
  assert.equal(audits[0].nextPagePresent, false)
})

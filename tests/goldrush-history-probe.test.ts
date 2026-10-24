import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGoldrushProbeInput, runGoldrushHistoryProbe, type ProbeFetch } from '../lib/server/goldrushHistoryProbe.ts'

const W = '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811'
const NOW = Date.UTC(2026, 9, 24)
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

function row(ms: number, swap: boolean) {
  return {
    tx_hash: `0x${ms.toString(16)}`, block_signed_at: iso(ms), value_quote: 1.5,
    log_events: [
      { sender_address: '0xTOKEN', decoded: { name: 'Transfer', params: [] } },
      ...(swap ? [{ sender_address: '0xpool', sender_name: 'Aerodrome', decoded: { name: 'Swap', params: [{ name: 'amount0In' }, { name: 'amount1Out' }] } }] : []),
    ],
  }
}

test('pages back through links.prev, counts swaps/prices, extrapolates pages for 90 days', async () => {
  const calls: string[] = []
  const fetchJson: ProbeFetch = async (url) => {
    calls.push(url)
    if (url.includes('transactions_summary')) return { status: 200, ms: 50, json: { data: { items: [{ total_count: 12345, earliest_transaction: { block_signed_at: iso(NOW - 200 * DAY) }, latest_transaction: { block_signed_at: iso(NOW) } }] } } }
    if (url.includes('transfers_v2')) return { status: 200, ms: 80, json: { data: { items: [{ block_signed_at: iso(NOW - DAY), transfers: [{ quote_rate: 1.01, delta_quote: 50 }, { quote_rate: null, delta_quote: null }] }] } } }
    const page = Number(/page=(\d+)/.exec(url)?.[1] ?? 0)
    // each page covers one day, newest first
    return { status: 200, ms: 400, json: { data: { items: [row(NOW - page * DAY - 3600_000, true), row(NOW - (page + 1) * DAY + 60_000, false)], links: { prev: `/v1/base-mainnet/address/${W}/transactions_v3/page=${page + 1}/` } } } }
  }
  const input = parseGoldrushProbeInput(new URLSearchParams({ wallet: W, maxPages: '5' }))
  assert.ok(!('error' in input))
  const result = await runGoldrushHistoryProbe({ ...input, now: NOW }, fetchJson)
  assert.equal(result.summary.totalCount, 12345)
  assert.equal(result.transactionsV3.pagesFetched, 5)
  assert.equal(result.transactionsV3.stopReason, 'max_pages')
  assert.equal(result.transactionsV3.rowStats.swapLogs, 5)
  assert.equal(result.transactionsV3.rowStats.withValueQuote, 10)
  // 5 pages reached ~5 days back → ~90 pages for 90 days at ~0.4s each
  assert.ok([90, 91].includes(result.transactionsV3.estimatedPagesFor90Days))
  assert.ok([36, 37].includes(result.transactionsV3.estimatedSecondsFor90DaysSequential ?? -1))
  assert.equal(result.transfersV2?.withQuoteRate, 1)
  assert.ok(calls[2].startsWith('https://api.covalenthq.com/v1/'), 'relative prev links resolve against the API host')
  assert.ok(!JSON.stringify(result).includes('Bearer'))
})

test('stops once 90 days are reached, and rejects bad input', async () => {
  const fetchJson: ProbeFetch = async (url) => url.includes('transactions_v3')
    ? { status: 200, ms: 10, json: { data: { items: [row(NOW - 95 * DAY, false)], links: { prev: 'https://api.covalenthq.com/next' } } } }
    : { status: 404, ms: 10, json: null }
  const result = await runGoldrushHistoryProbe({ wallet: W, chain: 'base-mainnet', maxPages: 10, budgetMs: 10_000, now: NOW }, fetchJson)
  assert.equal(result.transactionsV3.stopReason, 'reached_90_days')
  assert.equal(result.transactionsV3.pagesFetched, 1)
  assert.ok('error' in parseGoldrushProbeInput(new URLSearchParams({ wallet: 'nope' })))
})

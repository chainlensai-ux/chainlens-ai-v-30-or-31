// fetchAlchemyTokenHistoryStrict with outbound recovery: separate to/from queries (Alchemy ANDs the
// two filters), cursor pagination within a page budget, and explicit per-direction status so a
// capped, failed, budget-refused or unsupported query is never read as complete history.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAlchemyTokenHistoryStrict, resetRecoveryHistoricalPageRequestCache } from './utils'
import { __resetWalletProviderCostLedgerForTest, tryConsume } from '../providerCost/walletProviderCostLedger'

const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const originalFetch = global.fetch
const originalKey = process.env.ALCHEMY_BASE_KEY
type Params = Record<string, unknown>
const requests: Params[] = []

function transfer(i: number, dir: 'in' | 'out', iso: string) {
  return {
    hash: `0x${dir}${i}`, uniqueId: `0x${dir}${i}:log:${i % 3}`, blockNum: `0x${(100 + i).toString(16)}`,
    from: dir === 'in' ? '0xother' : WALLET, to: dir === 'in' ? WALLET : '0xother', asset: 'T',
    metadata: { blockTimestamp: iso }, rawContract: { address: TOKEN, value: '0x1', decimal: '0x12' },
  }
}
// pages[direction] = list of pages; each page = { count, iso, last? }
function mockAlchemy(pages: { in: Array<{ count: number; iso: string }>; out: Array<{ count: number; iso: string }> | 'fail' }) {
  global.fetch = (async (_url: string, init: { body: string }) => {
    const params = JSON.parse(init.body).params[0] as Params
    requests.push(params)
    const dir = 'toAddress' in params ? 'in' : 'out'
    if (dir === 'out' && pages.out === 'fail') return new Response('boom', { status: 500 })
    const list = dir === 'in' ? pages.in : pages.out as Array<{ count: number; iso: string }>
    const index = typeof params.pageKey === 'string' ? Number(String(params.pageKey).split('-')[1]) : 0
    const page = list[index] ?? { count: 0, iso: '2025-01-01T00:00:00Z' }
    const transfers = Array.from({ length: page.count }, (_, i) => transfer(index * 1000 + i, dir, page.iso))
    const result: Record<string, unknown> = { transfers }
    if (index + 1 < list.length) result.pageKey = `${dir}-${index + 1}`
    return new Response(JSON.stringify({ result }), { status: 200 })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-base-key'
  resetRecoveryHistoricalPageRequestCache()
  __resetWalletProviderCostLedgerForTest()
  requests.length = 0
})
afterEach(() => {
  global.fetch = originalFetch
  process.env.ALCHEMY_BASE_KEY = originalKey
  __resetWalletProviderCostLedgerForTest()
})

test('inbound and outbound are SEPARATE queries — never one query carrying both from and to filters', async () => {
  mockAlchemy({ in: [{ count: 2, iso: '2025-01-01T00:00:00Z' }], out: [{ count: 1, iso: '2025-02-01T00:00:00Z' }] })
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN, 'asc', { includeOutbound: true })
  assert.equal(requests.length, 2)
  assert.ok(requests.every((p) => !('toAddress' in p && 'fromAddress' in p)))
  assert.ok(requests.every((p) => p.order === 'asc' && p.fromBlock === '0x0' && JSON.stringify(p.category) === '["erc20"]' && JSON.stringify(p.contractAddresses) === JSON.stringify([TOKEN])))
  assert.deepEqual([r.inboundStatus, r.outboundStatus, r.events.length, r.outboundEvents?.length], ['complete', 'complete', 2, 1])
  assert.equal(r.outboundEvents![0]!.fromAddress, WALLET.toLowerCase())
  // Position fields come from Alchemy's blockNum and uniqueId (<tx>:log:<n>).
  assert.deepEqual([r.events[1]!.blockNumber, r.events[1]!.logIndex, r.events[1]!.uniqueId], [101, 1, '0xin1:log:1'])
})

test('pagination: cursors are followed in both directions within the page budget', async () => {
  mockAlchemy({
    in: [{ count: 100, iso: '2024-01-01T00:00:00Z' }, { count: 40, iso: '2024-02-01T00:00:00Z' }],
    out: [{ count: 100, iso: '2024-01-05T00:00:00Z' }, { count: 100, iso: '2024-01-06T00:00:00Z' }, { count: 5, iso: '2024-01-07T00:00:00Z' }],
  })
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN, 'asc', { includeOutbound: true, maxPagesPerDirection: 3 })
  assert.deepEqual([r.inboundStatus, r.inboundPagesFetched, r.events.length], ['complete', 2, 140])
  assert.deepEqual([r.outboundStatus, r.outboundPagesFetched, r.outboundEvents!.length], ['complete', 3, 205])
  assert.deepEqual(requests.filter((p) => 'fromAddress' in p).map((p) => p.pageKey ?? null), [null, 'out-1', 'out-2'])
  assert.equal(r.providerCalls, 5)
})

test('capped: more pages exist but the page budget ran out — never reported as complete', async () => {
  mockAlchemy({
    in: [{ count: 10, iso: '2024-01-01T00:00:00Z' }],
    out: [{ count: 100, iso: '2024-01-05T00:00:00Z' }, { count: 100, iso: '2024-03-01T00:00:00Z' }],
  })
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN, 'asc', { includeOutbound: true, maxPagesPerDirection: 1 })
  assert.equal(r.outboundStatus, 'capped')
  assert.equal(r.outboundCoveredUntil, Date.parse('2024-01-05T00:00:00Z'))
})

test('covered_to_bound: oldest-first paging stops once a page reaches the window start', async () => {
  mockAlchemy({
    in: [{ count: 100, iso: '2024-06-01T00:00:00Z' }, { count: 100, iso: '2024-07-01T00:00:00Z' }],
    out: [{ count: 100, iso: '2024-01-01T00:00:00Z' }, { count: 100, iso: '2024-06-02T00:00:00Z' }, { count: 1, iso: '2024-08-01T00:00:00Z' }],
  })
  const bound = Date.parse('2024-05-01T00:00:00Z')
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN, 'asc', { includeOutbound: true, maxPagesPerDirection: 3, coverUntilTimestamp: bound })
  assert.deepEqual([r.inboundStatus, r.inboundPagesFetched], ['covered_to_bound', 1])
  assert.deepEqual([r.outboundStatus, r.outboundPagesFetched], ['covered_to_bound', 2])
})

test('outbound failure while inbound succeeds: inbound stays usable, outbound is explicitly failed', async () => {
  mockAlchemy({ in: [{ count: 3, iso: '2024-01-01T00:00:00Z' }], out: 'fail' })
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN, 'asc', { includeOutbound: true })
  assert.deepEqual([r.ok, r.inboundStatus, r.outboundQueryOk, r.outboundStatus], [true, 'complete', false, 'failed'])
})

test('empty: a completed query with no transfers is `empty`, distinct from failed', async () => {
  mockAlchemy({ in: [{ count: 2, iso: '2024-01-01T00:00:00Z' }], out: [{ count: 0, iso: '2024-01-01T00:00:00Z' }] })
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN, 'asc', { includeOutbound: true })
  assert.deepEqual([r.outboundStatus, r.outboundQueryOk, r.outboundEvents!.length], ['empty', true, 0])
})

test('unsupported chain: no Alchemy transfer index → `unsupported`, no request made', async () => {
  mockAlchemy({ in: [], out: [] })
  const r = await fetchAlchemyTokenHistoryStrict('hyperevm', WALLET, TOKEN, 'asc', { includeOutbound: true })
  assert.deepEqual([r.ok, r.inboundStatus, r.outboundStatus, requests.length], [false, 'unsupported', 'unsupported', 0])
})

test('budget exhaustion: a refused call is `budget_exhausted` and spends nothing', async () => {
  while (tryConsume({ provider: 'alchemy', endpoint: 'alchemy_getAssetTransfers', chain: 'base', stage: 'recovery' })) { /* drain the recovery budget */ }
  mockAlchemy({ in: [{ count: 1, iso: '2024-01-01T00:00:00Z' }], out: [{ count: 1, iso: '2024-01-01T00:00:00Z' }] })
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN, 'asc', { includeOutbound: true })
  assert.deepEqual([r.inboundStatus, r.outboundStatus, r.providerCalls, requests.length], ['budget_exhausted', 'budget_exhausted', 0, 0])
})

test('default call (no options) keeps the previous single-page, inbound-only behaviour', async () => {
  mockAlchemy({ in: [{ count: 100, iso: '2024-01-01T00:00:00Z' }, { count: 1, iso: '2024-02-01T00:00:00Z' }], out: [] })
  const r = await fetchAlchemyTokenHistoryStrict('base', WALLET, TOKEN)
  assert.deepEqual([requests.length, r.inboundPageCapped, r.outboundStatus, r.outboundQueryOk], [1, true, 'not_requested', false])
})

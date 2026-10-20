// Wallet Scanner missed-trades fixes: Alchemy token history pagination and native ETH history.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { capAlchemyEventsByTime, fetchAlchemyNativeRawEvents, fetchAlchemyRawEvents, NATIVE_ASSET_ADDRESS, ALCHEMY_ERC20_MAX_PAGES_PER_DIRECTION } from './utils'
import { MAX_RAW_EVENTS_PER_PROVIDER } from './types'
import { resetProviderFetchWindowRequestCache } from './index'
import { __resetWalletProviderCostLedgerForTest } from '../providerCost/walletProviderCostLedger'

const W = '0x' + '1'.repeat(40)
const originalFetch = global.fetch
const originalKey = process.env.ALCHEMY_BASE_KEY
type Params = Record<string, unknown>
const calls: Params[] = []

beforeEach(() => {
  __resetWalletProviderCostLedgerForTest()
  resetProviderFetchWindowRequestCache('missed-trades-test')
  process.env.ALCHEMY_BASE_KEY = 'test-key'
  calls.length = 0
})
afterEach(() => {
  global.fetch = originalFetch
  process.env.ALCHEMY_BASE_KEY = originalKey
  __resetWalletProviderCostLedgerForTest()
})

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
const row = (i: number, dir: string, iso: string, native = false) => ({
  hash: `0x${dir}${i}`, from: dir === 'from' ? W : '0xother', to: dir === 'from' ? '0xother' : W, asset: native ? 'ETH' : 'TKN',
  rawContract: native ? { address: null, value: '0xde0b6b3a7640000', decimal: '0x12' } : { address: '0x' + 'a'.repeat(40), value: '0x1', decimal: '0x12' },
  metadata: { blockTimestamp: iso },
})

// pages[dir] = list of { count, ageDays }; pageKey present while more pages remain.
function mockPages(pages: Record<string, Array<{ count: number; ageDays: number }>>) {
  global.fetch = (async (_url: string, init: { body: string }) => {
    const params = JSON.parse(init.body).params[0] as Params
    calls.push(params)
    const dir = 'fromAddress' in params ? 'from' : 'to'
    const cat = (params.category as string[])[0]
    const list = pages[`${cat}:${dir}`] ?? []
    const index = typeof params.pageKey === 'string' ? Number(String(params.pageKey).split('-').pop()) : 0
    const page = list[index] ?? { count: 0, ageDays: 1 }
    const transfers = Array.from({ length: page.count }, (_, i) => row(index * 1000 + i, dir, daysAgo(page.ageDays), cat !== 'erc20'))
    const result: Params = { transfers }
    if (index + 1 < list.length) result.pageKey = `${cat}-${dir}-${index + 1}`
    return new Response(JSON.stringify({ result }), { status: 200 })
  }) as unknown as typeof fetch
}

test('token history follows pageKey per direction until the window is covered (was: first page only)', async () => {
  mockPages({
    'erc20:from': [{ count: 200, ageDays: 5 }, { count: 200, ageDays: 30 }, { count: 50, ageDays: 60 }],
    'erc20:to': [{ count: 10, ageDays: 2 }],
  })
  const r = await fetchAlchemyRawEvents('base', W, 90)
  assert.equal(r.ok, true)
  assert.equal(r.events.length, 460, 'every page inside the window is read')
  assert.deepEqual(calls.filter(p => 'fromAddress' in p).map(p => p.pageKey ?? null), [null, 'erc20-from-1', 'erc20-from-2'])
  assert.equal(r.pagination?.nextPageKeyPresent, false)
})

test('pagination stops once a page reaches past the window start (no wasted calls)', async () => {
  mockPages({ 'erc20:from': [{ count: 200, ageDays: 120 }, { count: 200, ageDays: 200 }], 'erc20:to': [] })
  await fetchAlchemyRawEvents('base', W, 90)
  assert.equal(calls.filter(p => 'fromAddress' in p).length, 1)
})

test('page cap is respected and reported as more history available', async () => {
  const many = Array.from({ length: ALCHEMY_ERC20_MAX_PAGES_PER_DIRECTION + 2 }, (_, i) => ({ count: 50, ageDays: 1 + i }))
  mockPages({ 'erc20:from': many, 'erc20:to': [] })
  const r = await fetchAlchemyRawEvents('base', W, 90)
  assert.equal(calls.filter(p => 'fromAddress' in p).length, ALCHEMY_ERC20_MAX_PAGES_PER_DIRECTION)
  assert.equal(r.pagination?.nextPageKeyPresent, true)
})

test('native history: ETH paid (external, from wallet) and ETH received (internal, to wallet) as native legs', async () => {
  mockPages({ 'external:from': [{ count: 2, ageDays: 3 }], 'internal:to': [{ count: 3, ageDays: 3 }] })
  const r = await fetchAlchemyNativeRawEvents('base', W, 90)
  assert.equal(r.events.length, 5)
  assert.ok(r.events.every(e => e.contract === NATIVE_ASSET_ADDRESS && e.tokenDecimals === 18 && e.amountRaw === '1000000000000000000'))
  assert.deepEqual(calls.map(p => [(p.category as string[])[0], 'fromAddress' in p ? 'from' : 'to']), [['external', 'from'], ['internal', 'to']])
})

test('native history failure (e.g. chain without internal transfers) yields no rows and never throws', async () => {
  global.fetch = (async () => new Response(JSON.stringify({ error: { code: -32602, message: 'internal not supported' } }), { status: 200 })) as unknown as typeof fetch
  const r = await fetchAlchemyNativeRawEvents('base', W, 90)
  assert.deepEqual([r.events.length, r.failedCalls], [0, 2])
})

test('a page-capped history reports the range it covered and drops the older rows of the deeper direction', async () => {
  const capped = Array.from({ length: ALCHEMY_ERC20_MAX_PAGES_PER_DIRECTION + 1 }, (_, i) => ({ count: 200, ageDays: 1 + i * 3 }))
  mockPages({
    // The sells reach back further than the buys: their rows older than the buys' last page go.
    'erc20:from': capped.map((page) => ({ ...page, ageDays: page.ageDays * 2 })),
    'erc20:to': capped,
  })
  const r = await fetchAlchemyRawEvents('base', W, 90)
  assert.equal(r.pagination?.nextPageKeyPresent, true)
  const covered = r.pagination?.coveredFromMs
  assert.ok(typeof covered === 'number')
  const lastToPageAge = 1 + (ALCHEMY_ERC20_MAX_PAGES_PER_DIRECTION - 1) * 3
  assert.ok(Math.abs(covered - (Date.now() - lastToPageAge * 86_400_000)) < 60_000, 'the shallower direction bounds the range')
  assert.ok(r.events.every((e) => Date.parse(e.timestamp!) >= covered), 'nothing older than the covered start')
})

test('a fully paged history has no covered-range narrowing', async () => {
  mockPages({ 'erc20:from': [{ count: 5, ageDays: 3 }], 'erc20:to': [{ count: 5, ageDays: 4 }] })
  const r = await fetchAlchemyRawEvents('base', W, 90)
  assert.equal(r.pagination?.nextPageKeyPresent, false)
  assert.equal(r.pagination?.coveredFromMs, null)
})

test('the event cap cuts at one point in time and keeps the covered range proven', () => {
  const rows = [5, 4, 4, 3, 2, 1].map((ms, i) => ({ event: `r${i}`, ms }))
  const r = capAlchemyEventsByTime(rows, 2)
  // The 3rd-newest row (ms 4) does not fit, so both ms-4 rows go: no half of a block is kept.
  assert.deepEqual(r, { events: ['r0'], eventCapHit: true, cappedCoveredFromMs: 5 })
  assert.deepEqual(capAlchemyEventsByTime(rows, 6), { events: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'], eventCapHit: false, cappedCoveredFromMs: null })
})

test('a history over the event cap still reports a contiguous covered range (was: no range at all)', async () => {
  // Both directions busy over the last days, page cap reached: more rows than the event cap.
  const pages = Array.from({ length: ALCHEMY_ERC20_MAX_PAGES_PER_DIRECTION + 1 }, (_, i) => ({ count: 200, ageDays: 0.1 + i * 0.1 }))
  mockPages({ 'erc20:from': pages, 'erc20:to': pages })
  const r = await fetchAlchemyRawEvents('base', W, 90)
  assert.ok(r.events.length <= MAX_RAW_EVENTS_PER_PROVIDER)
  assert.equal(r.pagination?.paginationExhausted, false)
  assert.equal(r.pagination?.providerCapReached, true)
  const covered = r.pagination?.coveredFromMs
  assert.ok(typeof covered === 'number', 'the time cut is a proven range')
  assert.ok(r.events.every((e) => Date.parse(e.timestamp!) >= covered))
  assert.ok(r.events.some((e) => Date.parse(e.timestamp!) === covered), 'the oldest kept row marks the start')
  const directions = new Set(r.events.map((e) => (e.fromAddress === W.toLowerCase() ? 'out' : 'in')))
  assert.equal(directions.size, 2, 'both directions keep their rows of the covered range')
})

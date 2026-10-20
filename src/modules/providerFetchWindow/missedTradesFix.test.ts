// Wallet Scanner missed-trades fixes: Alchemy token history pagination and native ETH history.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAlchemyNativeRawEvents, fetchAlchemyRawEvents, NATIVE_ASSET_ADDRESS, ALCHEMY_ERC20_MAX_PAGES_PER_DIRECTION } from './utils'
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

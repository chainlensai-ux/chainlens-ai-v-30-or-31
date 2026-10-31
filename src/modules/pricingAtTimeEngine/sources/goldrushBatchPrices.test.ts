// Batched GoldRush historical prices: grouping, day clustering, hint widening (never an extra call),
// the named-unknown-contract retry, failure fallback to today's single call, budget refusal, the
// positive-cache prefill, and the kill switch.
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/goldrushBatchPrices.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { GoldRushClient } from '@covalenthq/client-sdk'
import { clusterDays, createGoldrushPriceBatcher, MAX_UNKNOWN_CONTRACT_DROPS, isGoldrushBatchPricingEnabled, missingContractFromError, widenWithHints } from './goldrushBatchPrices'
import { goldrushPriceSource, registerGoldrushPriceHints, clearGoldrushPriceHints, __resetGoldrushPriceSourceCachesForTest } from './goldrushPriceSource'
import { __resetWalletProviderCostLedgerForTest } from '../../providerCost/walletProviderCostLedger'

const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const BAD = '0x' + 'd'.repeat(40)
const day = (d: string) => Date.parse(`${d}T12:00:00Z`)

type Reply = { status: number; body: unknown }
function fakeFetch(replyFor: (url: string) => Reply) {
  const urls: string[] = []
  const fetchImpl = (async (url: string) => {
    urls.push(String(url))
    const r = replyFor(String(url))
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as unknown as typeof fetch
  return { fetchImpl, urls }
}
const pricesBody = (rows: Record<string, Record<string, number>>) => ({
  error: false,
  data: Object.entries(rows).map(([addr, days]) => ({ contract_address: addr, prices: Object.entries(days).map(([date, price]) => ({ date, price })) })),
})

describe('day clustering and hint widening', () => {
  it('groups days within a 30-day span; far days start a new range', () => {
    assert.deepEqual(clusterDays(['2026-03-05', '2026-03-03', '2026-03-03', '2026-03-20', '2026-06-20']), [{ from: '2026-03-03', to: '2026-03-20' }, { from: '2026-06-20', to: '2026-06-20' }])
    assert.deepEqual(clusterDays(['2026-03-05', '2026-03-03'], 3), [{ from: '2026-03-03', to: '2026-03-05' }])
    const daily = Array.from({ length: 45 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))
    const parts = clusterDays(daily)
    assert.equal(parts.length, 2)
    assert.deepEqual(parts[0], { from: '2026-01-01', to: '2026-01-31' })
  })
  it('widens toward hinted days only within the 30-day span', () => {
    assert.deepEqual(widenWithHints({ from: '2026-03-10', to: '2026-03-10' }, ['2026-03-01', '2026-03-25', '2026-08-01']), { from: '2026-03-01', to: '2026-03-25' })
    assert.deepEqual(widenWithHints({ from: '2026-03-10', to: '2026-03-10' }, ['2026-05-01']), { from: '2026-03-10', to: '2026-03-10' }, 'a far hint is ignored, never a new call')
  })
  it('reads the contract a "not found" 400 names', () => {
    assert.equal(missingContractFromError(`Contract address '${BAD}' not found!`), BAD)
    assert.equal(missingContractFromError('Rate limited'), null)
  })
})

describe('batcher', () => {
  it('concurrent lookups for several tokens on a day are ONE call; every answer is that day’s price', async () => {
    const { fetchImpl, urls } = fakeFetch(() => ({ status: 200, body: pricesBody({ [A]: { '2026-10-20': 2.5 }, [B]: { '2026-10-20': 7 } }) }))
    const b = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl, windowMs: 5 })
    const answers = await Promise.all([b.request('base-mainnet', 'base', A, '2026-10-20'), b.request('base-mainnet', 'base', B, '2026-10-20'), b.request('base-mainnet', 'base', A.toUpperCase().replace('0X', '0x'), '2026-10-20')])
    assert.equal(urls.length, 1)
    assert.match(urls[0], new RegExp(`/USD/${A},${B}/\\?from=2026-10-20&to=2026-10-20$`))
    assert.deepEqual(answers, [{ status: 'price', price: 2.5 }, { status: 'price', price: 7 }, { status: 'price', price: 2.5 }])
  })

  it('a named unknown contract is answered "no price" and the rest retried once', async () => {
    const { fetchImpl, urls } = fakeFetch((url) => url.includes(BAD)
      ? { status: 400, body: { error: true, error_message: `Contract address '${BAD}' not found!` } }
      : { status: 200, body: pricesBody({ [A]: { '2026-10-20': 1 } }) })
    const b = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl, windowMs: 5 })
    const [a, bad] = await Promise.all([b.request('base-mainnet', 'base', A, '2026-10-20'), b.request('base-mainnet', 'base', BAD, '2026-10-20')])
    assert.equal(urls.length, 2)
    assert.deepEqual(a, { status: 'price', price: 1 })
    assert.deepEqual(bad, { status: 'no_price', tokenHasAnyPrice: false })
  })

  it('several unknown contracts in one batch are each dropped in turn — the rest still priced in one batch, never per-token calls', async () => {
    const bads = [1, 2, 3].map(n => '0x' + String(n).repeat(40))
    const { fetchImpl, urls } = fakeFetch((url) => {
      const named = bads.find(x => url.includes(x))
      return named
        ? { status: 400, body: { error: true, error_message: `Contract address '${named}' not found!` } }
        : { status: 200, body: pricesBody({ [A]: { '2026-10-20': 1 }, [B]: { '2026-10-20': 2 } }) }
    })
    const b = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl, windowMs: 5 })
    const answers = await Promise.all([A, B, ...bads].map(t => b.request('base-mainnet', 'base', t, '2026-10-20')))
    assert.equal(urls.length, 4, '3 rejections + 1 success, not 2 calls + 4 single-token fallbacks')
    assert.deepEqual(answers.slice(0, 2), [{ status: 'price', price: 1 }, { status: 'price', price: 2 }])
    for (const a of answers.slice(2)) assert.deepEqual(a, { status: 'no_price', tokenHasAnyPrice: false })
  })

  it(`past ${MAX_UNKNOWN_CONTRACT_DROPS} unknown contracts the rest fall back ("error"), as before`, async () => {
    const bads = Array.from({ length: MAX_UNKNOWN_CONTRACT_DROPS + 1 }, (_, n) => '0x' + (n + 1).toString(16).repeat(40))
    const { fetchImpl, urls } = fakeFetch((url) => {
      const named = bads.find(x => url.includes(x))!
      return { status: 400, body: { error: true, error_message: `Contract address '${named}' not found!` } }
    })
    const b = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl, windowMs: 5 })
    const answers = await Promise.all([...bads, A].map(t => b.request('base-mainnet', 'base', t, '2026-10-20')))
    assert.equal(urls.length, MAX_UNKNOWN_CONTRACT_DROPS + 1)
    assert.equal(answers.filter(a => a.status === 'no_price').length, MAX_UNKNOWN_CONTRACT_DROPS)
    assert.equal(answers.filter(a => a.status === 'error').length, 2)
  })

  it('429 / 5xx answer "error" (caller falls back); a refused budget answers "refused"; no call is made when refused', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 429, body: { error: true, error_message: 'rate limited' } }))
    const b = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl, windowMs: 5 })
    assert.deepEqual(await b.request('base-mainnet', 'base', A, '2026-10-20'), { status: 'error' })
    const never = fakeFetch(() => ({ status: 200, body: pricesBody({}) }))
    const refused = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl: never.fetchImpl, windowMs: 5, consume: () => false })
    assert.deepEqual(await refused.request('base-mainnet', 'base', A, '2026-10-20'), { status: 'refused' })
    assert.equal(never.urls.length, 0)
  })

  it('days far apart are separate calls; hints only widen them (never add a call); groups cap at 20 tokens', async () => {
    const { fetchImpl, urls } = fakeFetch(() => ({ status: 200, body: pricesBody({}) }))
    const b = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl, windowMs: 5, hintsFor: () => ['2026-03-01', '2026-12-31'] })
    await Promise.all([b.request('eth-mainnet', 'eth', A, '2026-03-10'), b.request('eth-mainnet', 'eth', A, '2026-06-10')])
    assert.equal(urls.length, 2)
    assert.ok(urls.some(u => u.includes('from=2026-03-01&to=2026-03-10')), 'widened to the hinted 1 March')
    assert.ok(urls.some(u => u.includes('from=2026-06-10&to=2026-06-10')), 'no far hint added')
    const many = fakeFetch(() => ({ status: 200, body: pricesBody({}) }))
    const g = createGoldrushPriceBatcher({ apiKey: 'k', fetchImpl: many.fetchImpl, windowMs: 5 })
    await Promise.all(Array.from({ length: 45 }, (_, i) => g.request('eth-mainnet', 'eth', '0x' + i.toString(16).padStart(40, '0'), '2026-10-20')))
    assert.equal(many.urls.length, 3, '45 tokens → 20 + 20 + 5')
  })

  it('kill switch', () => {
    assert.equal(isGoldrushBatchPricingEnabled({}), true)
    assert.equal(isGoldrushBatchPricingEnabled({ GOLDRUSH_BATCH_PRICING: '0' }), false)
  })
})

describe('goldrushPriceSource with batching', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { __resetGoldrushPriceSourceCachesForTest(); __resetWalletProviderCostLedgerForTest(); clearGoldrushPriceHints(); delete process.env.GOLDRUSH_BATCH_PRICING })
  afterEach(() => { globalThis.fetch = realFetch; clearGoldrushPriceHints(); delete process.env.GOLDRUSH_BATCH_PRICING })

  const singleClient = (price: number | null) => {
    let calls = 0
    const client = { PricingService: { async getTokenPrices() { calls++; return { error: false, data: [{ items: price == null ? [] : [{ price }] }] } } } }
    return { client: client as unknown as GoldRushClient, calls: () => calls }
  }

  it('groups lookups into one call, prefills hinted days so a later day costs nothing, prices identical', async () => {
    const { fetchImpl, urls } = fakeFetch(() => ({ status: 200, body: pricesBody({ [A]: { '2026-10-18': 1.1, '2026-10-20': 1.3 }, [B]: { '2026-10-20': 9 } }) }))
    globalThis.fetch = fetchImpl
    const single = singleClient(999)
    registerGoldrushPriceHints([{ token: A, chain: 'eth', timestamp: day('2026-10-18') }])
    const source = goldrushPriceSource(single.client, { apiKey: 'test-key' })
    const [a, b] = await Promise.all([source(A, 'eth', day('2026-10-20')), source(B, 'eth', day('2026-10-20'))])
    assert.deepEqual([a, b], [1.3, 9])
    assert.equal(urls.length, 1)
    assert.match(urls[0], /from=2026-10-18&to=2026-10-20/)
    assert.equal(await source(A, 'eth', day('2026-10-18')), 1.1, 'hinted day served from the prefilled cache')
    assert.equal(urls.length, 1)
    assert.equal(single.calls(), 0)
  })

  it('a failed batch falls back to today’s single call — never worse', async () => {
    globalThis.fetch = fakeFetch(() => ({ status: 503, body: { error: true } })).fetchImpl
    const single = singleClient(4.2)
    const source = goldrushPriceSource(single.client, { apiKey: 'test-key-2' })
    assert.equal(await source(A, 'eth', day('2026-10-20')), 4.2)
    assert.equal(single.calls(), 1)
  })

  it('kill switch and no key: today’s single call only', async () => {
    const watcher = fakeFetch(() => ({ status: 200, body: pricesBody({}) }))
    globalThis.fetch = watcher.fetchImpl
    process.env.GOLDRUSH_BATCH_PRICING = '0'
    const s1 = singleClient(3)
    assert.equal(await goldrushPriceSource(s1.client, { apiKey: 'test-key-3' })(A, 'eth', day('2026-10-20')), 3)
    delete process.env.GOLDRUSH_BATCH_PRICING
    const s2 = singleClient(5)
    assert.equal(await goldrushPriceSource(s2.client)(B, 'eth', day('2026-10-20')), 5)
    assert.equal(watcher.urls.length, 0)
    assert.equal(s1.calls() + s2.calls(), 2)
  })
})

describe('single call reads the SDK 3.x response shape', () => {
  beforeEach(() => { __resetGoldrushPriceSourceCachesForTest(); __resetWalletProviderCostLedgerForTest(); process.env.GOLDRUSH_BATCH_PRICING = '0' })
  afterEach(() => { delete process.env.GOLDRUSH_BATCH_PRICING })
  it('price comes from data[0].prices for the requested day (items is null in SDK 3.x)', async () => {
    const client = { PricingService: { async getTokenPrices() {
      return { error: false, data: [{ items: null, prices: [{ date: '2026-10-20', price: 2448.2573 }, { date: '2026-10-19', price: 2407.5 }] }] }
    } } } as unknown as GoldRushClient
    assert.equal(await goldrushPriceSource(client)(A, 'eth', day('2026-10-20')), 2448.2573)
    assert.equal(await goldrushPriceSource(client)(A, 'eth', day('2026-10-19')), 2407.5, 'the asked day, not the first row')
  })
})

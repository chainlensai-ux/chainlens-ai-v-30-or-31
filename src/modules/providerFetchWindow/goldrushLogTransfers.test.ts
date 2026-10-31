// GoldRush transactions_v3 carries ERC-20 movements as decoded Transfer logs and signals older pages
// through `links`; the Base scanner read neither, so a busy wallet's page gave 0 events and claimed
// the end of history.
//   npx tsx --test src/modules/providerFetchWindow/goldrushLogTransfers.test.ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGoldrushRawEvents, goldrushLogTransferEvents } from './utils'
import { __resetWalletProviderCostLedgerForTest } from '../providerCost/walletProviderCostLedger'

const W = '0x' + '1'.repeat(40)
const TOKEN = '0x' + 'a'.repeat(40)
const POOL = '0x' + 'b'.repeat(40)
const transferLog = (from: string, to: string, value: string, contract = TOKEN) => ({
  sender_address: contract, sender_contract_ticker_symbol: 'TKN', sender_contract_decimals: 18,
  decoded: { name: 'Transfer', params: [{ name: 'from', value: from }, { name: 'to', value: to }, { name: 'value', value }] },
})
const originalFetch = global.fetch
const originalKey = process.env.GOLDRUSH_API_KEY
afterEach(() => {
  global.fetch = originalFetch
  process.env.GOLDRUSH_API_KEY = originalKey
  __resetWalletProviderCostLedgerForTest()
})

test('keeps only the wallet\'s own ERC-20 legs from decoded Transfer logs', () => {
  const tx = {
    log_events: [
      transferLog(W.toUpperCase(), POOL, '1000'),
      transferLog(POOL, W, '250', '0x' + 'c'.repeat(40)),
      transferLog(POOL, '0x' + 'd'.repeat(40), '999'),
      { sender_address: TOKEN, decoded: { name: 'Transfer', params: [{ name: 'from', value: W }, { name: 'to', value: POOL }, { name: 'tokenId', value: '7' }] } },
      { sender_address: TOKEN, decoded: { name: 'Approval', params: [] } },
    ],
  }
  const events = goldrushLogTransferEvents(tx, W)
  assert.deepEqual(events.map((e) => [e.fromAddress, e.toAddress, e.amountRaw]), [[W, POOL, '1000'], [POOL, W, '250']])
  assert.equal(events[0].contract, TOKEN)
  assert.equal(events[0].tokenDecimals, 18)
})

test('a v3 page with a prev link is not the end of history, and its log transfers become events', async () => {
  process.env.GOLDRUSH_API_KEY = 'test-key'
  global.fetch = (async () => new Response(JSON.stringify({ data: {
    links: { prev: 'https://api.covalenthq.com/v1/base-mainnet/address/x/transactions_v3/page/3/', next: null },
    items: [{ tx_hash: '0xabc', block_signed_at: new Date().toISOString(), from_address: W, to_address: POOL, value: '0', log_events: [transferLog(W, POOL, '1000')] }],
  } }), { status: 200 })) as unknown as typeof fetch
  const r = await fetchGoldrushRawEvents('base', W, 90)
  assert.equal(r.ok, true)
  assert.equal(r.events.length, 1)
  assert.equal(r.pagination?.paginationExhausted, false)
  assert.equal(r.pagination?.nextPageKeyPresent, true)
})

test('a gateway error (504) is retried once with the smaller page; a second failure stays a failure', async () => {
  process.env.GOLDRUSH_API_KEY = 'test-key'
  const page = JSON.stringify({ data: { links: { prev: null, next: null }, items: [{ tx_hash: '0xabc', block_signed_at: new Date().toISOString(), from_address: W, to_address: POOL, value: '0', log_events: [transferLog(W, POOL, '1000')] }] } })
  const urls: string[] = []
  global.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return urls.length === 1 ? new Response('gateway timeout', { status: 504 }) : new Response(page, { status: 200 }) }) as typeof fetch
  const recovered = await fetchGoldrushRawEvents('base', W, 90)
  assert.equal(recovered.ok, true)
  assert.equal(urls.length, 2)
  assert.match(urls[1], /page-size=100/)

  __resetWalletProviderCostLedgerForTest()
  urls.length = 0
  global.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('gateway timeout', { status: 504 }) }) as typeof fetch
  const failed = await fetchGoldrushRawEvents('base', W, 90)
  assert.equal(failed.ok, false)
  assert.equal(failed.errorReason, 'http_504')
  assert.equal(urls.length, 2, 'exactly one retry')

  urls.length = 0
  global.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response('bad request', { status: 400 }) }) as typeof fetch
  assert.equal((await fetchGoldrushRawEvents('base', W, 90)).errorReason, 'http_400')
  assert.equal(urls.length, 1, 'a client error is not retried')
})

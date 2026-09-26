// Read-only CoinGecko on-chain OHLCV probe: never returns the API key, one upstream call, admin-gated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseProbeInput, runCoingeckoOnchainProbe, type ProbeFetch } from '../lib/server/coingeckoOnchainProbe.ts'

const KEY = 'CG-supersecret-test-key-123'
const POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224'

function fakeFetch(calls: Array<{ url: string; headers: Record<string, string> }>, status: number, body: string, headers: Record<string, string> = {}): ProbeFetch {
  return async (url, init) => {
    calls.push({ url, headers: init.headers })
    return { status, headers: { forEach: (cb) => Object.entries(headers).forEach(([k, v]) => cb(v, k)) }, text: async () => body }
  }
}
const input = () => {
  const p = parseProbeInput(new URLSearchParams({ network: 'base', pool: POOL, token: 'quote' }))
  assert.ok(!('error' in p))
  return p
}

test('sends the key only as the demo header, one call, and never returns it', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const body = JSON.stringify({ data: { attributes: { ohlcv_list: [[1700000900, 1, 2, 0.5, 1.5, 10], [1700000000, 1, 2, 0.5, 1.5, 10]] } }, meta: { base: { address: '0xa', symbol: 'WETH' }, quote: { address: '0xb', symbol: 'USDC' } } })
  const out = await runCoingeckoOnchainProbe(input(), KEY, fakeFetch(calls, 200, body, { 'x-ratelimit-remaining': '29', 'content-type': 'application/json' }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers['x-cg-demo-api-key'], KEY)
  assert.match(calls[0].url, /^https:\/\/api\.coingecko\.com\/api\/v3\/onchain\/networks\/base\/pools\/0xd0b5.*\/ohlcv\/minute\?aggregate=15&limit=100&currency=usd&token=quote$/)
  assert.doesNotMatch(calls[0].url, new RegExp(KEY))
  assert.equal(out.httpStatus, 200)
  assert.equal(out.keyAccepted, true)
  assert.deepEqual(out.rateLimitHeaders, { 'x-ratelimit-remaining': '29' })
  assert.equal(out.ohlcv?.rows, 2)
  assert.equal(out.ohlcv?.newestFirst, true)
  assert.deepEqual(out.sideMeta, { base: { address: '0xa', symbol: 'WETH' }, quote: { address: '0xb', symbol: 'USDC' } })
  assert.doesNotMatch(JSON.stringify(out), new RegExp(KEY))
})

test('a key echoed back in an error body or header is redacted', async () => {
  const out = await runCoingeckoOnchainProbe(input(), KEY, fakeFetch([], 401, `{"error":"invalid key ${KEY}"}`, { 'x-cg-echo': KEY }))
  assert.equal(out.keyAccepted, false)
  assert.doesNotMatch(JSON.stringify(out), new RegExp(KEY))
  assert.match(String(out.bodySnippet), /\[redacted\]/)
})

test('no key configured -> no key header sent', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const out = await runCoingeckoOnchainProbe(input(), null, fakeFetch(calls, 429, '{}', { 'retry-after': '30' }))
  assert.equal(calls[0].headers['x-cg-demo-api-key'], undefined)
  assert.equal(out.keyConfigured, false)
  assert.equal(out.keyAccepted, null)
  assert.deepEqual(out.rateLimitHeaders, { 'retry-after': '30' })
})

test('input validation rejects bad pools/limits', () => {
  assert.ok('error' in parseProbeInput(new URLSearchParams({ pool: 'nope' })))
  assert.ok('error' in parseProbeInput(new URLSearchParams({ pool: POOL, limit: '5000' })))
  assert.ok('error' in parseProbeInput(new URLSearchParams({ pool: POOL, token: 'both' })))
})

test('route is admin-gated (Bearer ADMIN_SECRET, 404 otherwise) and rate limited', () => {
  const src = readFileSync(new URL('../app/api/debug/coingecko-onchain-probe/route.ts', import.meta.url), 'utf8')
  assert.match(src, /token === process\.env\.ADMIN_SECRET/)
  assert.match(src, /status: 404/)
  assert.match(src, /limiter\.check\(/)
})

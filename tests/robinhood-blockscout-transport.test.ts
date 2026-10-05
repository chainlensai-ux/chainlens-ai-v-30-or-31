// Robinhood Blockscout transport: community host without a key first; on 401/403 one PRO-gateway attempt
// (api.blockscout.com/4663, Bearer header). The PRO key is never sent to the community host and never logged.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  getBlockscoutAddressTransactions, getBlockscoutAddressTokenTransfers, classifyBlockscoutFailure,
  __resetRobinhoodBlockscoutRateLimitForTest,
} from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { resolveRobinhoodWalletActivity, robinhoodPnlV1CandidatesFromActivity } from '../lib/server/robinhoodWalletScanner.ts'

const KEY = 'proapi_SECRET_test_key_123'
process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = KEY
process.env.GOLDRUSH_API_KEY = 'test-goldrush'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const TOKEN = '0xaaaa000000000000000000000000000000000001'
const H1 = `0x${'1'.repeat(64)}`
let seq = 0
const nextWallet = () => `0x${(0xb10c00 + ++seq).toString(16).padStart(40, '0')}`

type Reply = 'ok' | 'cf403' | 'auth403' | 'plain403' | 429 | 'timeout'
type Seen = { url: string; auth: string | null }
function transport(wallet: string, community: Reply, gateway: Reply) {
  const seen: Seen[] = []
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null
    seen.push({ url, auth })
    if (url.includes('api.covalenthq.com')) return new Response('{}', { status: 429 })
    const reply = url.startsWith('https://api.blockscout.com/') ? gateway : community
    if (reply === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e }
    if (reply === 429) return new Response('{"message":"Too Many Requests"}', { status: 429, headers: { 'content-type': 'application/json' } })
    if (reply === 'cf403') return new Response('<html><title>Just a moment...</title>Cloudflare Ray ID: x</html>', { status: 403, headers: { 'content-type': 'text/html', server: 'cloudflare' } })
    if (reply === 'auth403') return new Response('{"message":"Invalid API key"}', { status: 403, headers: { 'content-type': 'application/json' } })
    if (reply === 'plain403') return new Response('{"message":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } })
    const items = url.includes('/token-transfers')
      ? [{ transaction_hash: H1, timestamp: '2026-10-01T10:00:00Z', from: { hash: PM }, to: { hash: wallet }, total: { value: '5' }, token: { address: TOKEN, symbol: 'AAA' } }]
      : url.includes('/logs') ? [] : [{ hash: H1, timestamp: '2026-10-01T10:00:00Z', from: { hash: wallet }, to: { hash: PM }, value: '1' }]
    return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fn, seen }
}
const blockscoutCalls = (seen: Seen[]) => seen.filter((s) => s.url.includes('blockscout.com'))

beforeEach(() => { __resetRobinhoodBlockscoutRateLimitForTest() })

test('1. community public endpoint succeeds without a key (none sent, no gateway call)', async () => {
  const wallet = nextWallet()
  const t = transport(wallet, 'ok', 'ok')
  const r = await getBlockscoutAddressTransactions(wallet, t.fn)
  assert.equal(r.audit.blockscoutStatus, 'ok')
  assert.deepEqual({ host: r.audit.requestHost, auth: r.audit.authMode, status: r.audit.httpStatus, ct: r.audit.contentType }, { host: 'robinhoodchain.blockscout.com', auth: 'none', status: 200, ct: 'application/json' })
  const calls = blockscoutCalls(t.seen)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet}/transactions`)
  assert.equal(calls[0].auth, null)
})

test('2. community 403 -> one documented PRO-gateway attempt succeeds (Bearer header, chain 4663 path)', async () => {
  const wallet = nextWallet()
  const t = transport(wallet, 'cf403', 'ok')
  const r = await getBlockscoutAddressTokenTransfers(wallet, t.fn)
  assert.equal(r.audit.blockscoutStatus, 'ok')
  assert.equal(r.audit.authMode, 'gateway')
  assert.equal(r.audit.requestHost, 'api.blockscout.com')
  assert.deepEqual(r.audit.transportAttempts.map((a) => [a.requestHost, a.authMode, a.httpStatus, a.failureClass]), [
    ['robinhoodchain.blockscout.com', 'none', 403, 'cloudflare_forbidden'],
    ['api.blockscout.com', 'gateway', 200, null],
  ])
  const calls = blockscoutCalls(t.seen)
  assert.equal(calls[1].url, `https://api.blockscout.com/4663/api/v2/addresses/${wallet}/token-transfers`)
  assert.equal(calls[1].auth, `Bearer ${KEY}`)
  assert.equal(calls[0].auth, null, 'the PRO key is never sent to the community host')
})

test('3. both transports refuse -> unavailable with the exact blocker', async () => {
  const wallet = nextWallet()
  const a = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: transport(wallet, 'plain403', 'auth403').fn })
  assert.equal(a.status, 'unavailable')
  assert.equal(a.reason, 'rate_limited; Blockscout fallback failed: http_403 (forbidden_invalid_auth; tried robinhoodchain.blockscout.com/none:403, api.blockscout.com/gateway:403)')
  assert.equal(robinhoodPnlV1CandidatesFromActivity(a).candidates.length, 0)
})

test('4. the key never appears in a URL, an audit, a result or a log line', async () => {
  const wallet = nextWallet()
  const t = transport(wallet, 'cf403', 'ok')
  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const capture = (...args: unknown[]) => { lines.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  console.log = capture; console.warn = capture; console.error = capture
  let result: unknown
  try {
    result = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: t.fn })
  } finally {
    Object.assign(console, orig)
  }
  for (const s of t.seen) assert.ok(!s.url.includes(KEY), s.url)
  assert.ok(!JSON.stringify(result).includes(KEY))
  assert.ok(lines.length > 0)
  for (const l of lines) assert.ok(!l.includes(KEY))
})

test('5. a 429 stays rate_limited and never triggers the alternate transport', async () => {
  const wallet = nextWallet()
  const t = transport(wallet, 429, 'ok')
  const r = await getBlockscoutAddressTransactions(wallet, t.fn)
  assert.equal(r.audit.failureClass, 'rate_limited')
  assert.equal(r.audit.blockscoutError, 'rate_limited_by_blockscout')
  assert.equal(blockscoutCalls(t.seen).length, 1)
})

test('6. a timeout stays timeout and never triggers the alternate transport', async () => {
  const wallet = nextWallet()
  const t = transport(wallet, 'timeout', 'ok')
  const r = await getBlockscoutAddressTransactions(wallet, t.fn)
  assert.equal(r.audit.failureClass, 'timeout')
  assert.equal(r.audit.blockscoutError, 'timeout')
  assert.equal(r.audit.httpStatus, null)
  assert.equal(blockscoutCalls(t.seen).length, 1)
})

test('7. GoldRush 429 + community 403 + gateway success -> activity rows and candidates', async () => {
  const wallet = nextWallet()
  const a = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: transport(wallet, 'cf403', 'ok').fn })
  assert.equal(a.status, 'partial')
  assert.equal(a.activityProvenance?.fallbackStatus, 'succeeded')
  assert.ok(a.items.length > 0)
  const c = robinhoodPnlV1CandidatesFromActivity(a)
  assert.ok(c.transactionCount > 0 && c.transferCount > 0 && c.candidates.length > 0)
})

test('403 classification: cloudflare / invalid auth / host policy / unsupported gateway chain', () => {
  const h = (o: Record<string, string>) => new Headers(o)
  assert.equal(classifyBlockscoutFailure(403, h({ 'cf-mitigated': 'challenge' }), '', false), 'cloudflare_forbidden')
  assert.equal(classifyBlockscoutFailure(403, h({ 'content-type': 'text/html', server: 'cloudflare' }), '<html>error code: 1020</html>', false), 'cloudflare_forbidden')
  assert.equal(classifyBlockscoutFailure(403, h({}), '{"message":"Invalid API key"}', true), 'forbidden_invalid_auth')
  assert.equal(classifyBlockscoutFailure(401, h({}), '', true), 'forbidden_invalid_auth')
  assert.equal(classifyBlockscoutFailure(403, h({}), '{"message":"Forbidden"}', false), 'forbidden_host_policy')
  assert.equal(classifyBlockscoutFailure(404, h({}), '{"message":"Chain not supported"}', true), 'unsupported_chain_gateway')
  assert.equal(classifyBlockscoutFailure(429, h({}), '', false), 'rate_limited')
})

test('8. V4 / PnL code untouched: the V1 lane and the swap decoder do not depend on the Blockscout transport', () => {
  for (const f of ['lib/server/robinhoodPnlV1.ts', 'lib/server/robinhoodSwapDecoder.ts']) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /robinhoodBlockscoutEvidence/, f)
  }
})

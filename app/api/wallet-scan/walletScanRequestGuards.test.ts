// Request guards on the wallet-scan routes: the EVM chain list is checked before any quota or job, a deep scan
// whose job could not be queued gets its quota unit back, a refused deep scan takes nothing, and the Robinhood
// route (which can start a paid standalone scan) requires an account like POST /api/wallet-scan does.
//   npx tsx --test app/api/wallet-scan/walletScanRequestGuards.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearWalletScanTestAuth, installWalletScanTestAuth, walletScanTestAuthHeaders } from './walletScanTestAuth'
import { normalizeRequestedEvmChains } from './walletScanChains'
import { kv } from '@/lib/server/kv'
import { __resetScanQuotaForTest, consumeDailyScan, snapshotDailyScan } from '@/lib/scanQuota'

const WALLET = '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811'
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const original = { get: kv.get, set: kv.set, setIfAbsent: kv.setIfAbsent, compareAndSet: kv.compareAndSet }
let store: Map<string, unknown>
let failJobWrites = false
function memoryKv(): Map<string, unknown> {
  const m = new Map<string, unknown>()
  kv.get = async <T = unknown>(key: string | null) => ((key === null ? undefined : m.get(key)) as T | undefined) ?? null
  kv.set = async (key: string, value: unknown) => {
    if (failJobWrites && key.startsWith('walletScanJob:')) throw new Error('kv down')
    m.set(key, value)
    return 'OK'
  }
  kv.setIfAbsent = async (key: string, value: unknown) => {
    if (m.has(key)) return false
    m.set(key, value)
    return true
  }
  kv.compareAndSet = async (key: string, expected: string, next: string | null) => {
    if (m.get(key) !== expected) return false
    if (next === null) m.delete(key)
    else m.set(key, next)
    return true
  }
  return m
}

let ipSeq = 0
async function postScan(body: Record<string, unknown>) {
  const { POST } = await import('./route')
  const res = await POST(new Request('http://localhost/api/wallet-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.20.0.${++ipSeq}`, ...walletScanTestAuthHeaders },
    body: JSON.stringify({ walletAddress: WALLET, ...body }),
  }))
  return { status: res.status, body: await res.json() as { jobId?: string; error?: { category?: string } | string } }
}
const jobIds = () => [...store.keys()].filter((k) => k.startsWith('walletScanJob:'))
const quotaUsed = async () => (await snapshotDailyScan('free', 'user:user-a')).used

describe('normalizeRequestedEvmChains (pure)', () => {
  it('keeps supported EVM chains, lower-cased and de-duplicated, and drops robinhood', () => {
    assert.deepEqual(normalizeRequestedEvmChains(['base', 'eth', 'robinhood']), ['base', 'eth'])
    assert.deepEqual(normalizeRequestedEvmChains([' BASE ', 'Ethereum', 'eth']), ['base', 'eth'])
  })
  it('refuses a list with no EVM chain, an unknown chain, or an oversized list', () => {
    assert.equal(normalizeRequestedEvmChains([]), null)
    assert.equal(normalizeRequestedEvmChains(['robinhood']), null)
    assert.equal(normalizeRequestedEvmChains(['base', 'solana']), null)
    assert.equal(normalizeRequestedEvmChains(Array.from({ length: 17 }, () => 'base')), null)
  })
})

describe('POST /api/wallet-scan — chains and deep-scan quota', () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://x.upstash.io'
    process.env.KV_REST_API_TOKEN = 't'
    process.env.WALLET_SCAN_WORKER_SECRET = 'secret'
    process.env.WALLET_SCAN_WORKER_BASE_URL = 'https://worker.test'
    globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch
    store = memoryKv()
    failJobWrites = false
    __resetScanQuotaForTest()
    installWalletScanTestAuth('user-a')
  })
  afterEach(() => { process.env = { ...originalEnv }; Object.assign(kv, original); globalThis.fetch = originalFetch; clearWalletScanTestAuth() })

  for (const chains of [['robinhood'], [], ['solana'], ['base', 7], 'base']) {
    it(`refuses chains ${JSON.stringify(chains)} before any quota or job`, async () => {
      const res = await postScan({ chains, scanMode: 'deep' })
      assert.equal(res.status, 400)
      assert.equal((res.body.error as { category?: string }).category, 'validation')
      assert.equal(jobIds().length, 0)
      assert.equal(await quotaUsed(), 0)
    })
  }

  it('accepts mixed-case chains and queues the normalized list', async () => {
    const res = await postScan({ chains: ['BASE', 'Ethereum', 'robinhood'], scanMode: 'normal' })
    assert.equal(res.status, 200)
    const job = store.get(`walletScanJob:${res.body.jobId}`) as { payload?: { chains?: string[] }; chains?: string[] } | undefined
    assert.ok(job)
    assert.ok(JSON.stringify(job).includes('"chains":["base","eth"]'))
  })

  it('a deep scan whose job cannot be queued gives its quota unit back', async () => {
    failJobWrites = true
    const res = await postScan({ chains: ['base', 'eth'], scanMode: 'deep' })
    assert.equal(res.status, 503)
    assert.equal(await quotaUsed(), 0, 'the scan never started, so nothing is spent')
    failJobWrites = false
    const retry = await postScan({ chains: ['base', 'eth'], scanMode: 'deep' })
    assert.equal(retry.status, 200)
    assert.equal(await quotaUsed(), 1)
  })
})

describe('consumeDailyScan', () => {
  beforeEach(() => __resetScanQuotaForTest())
  it('a refused attempt takes nothing, and a refund is given back once', async () => {
    const taken = []
    for (let i = 0; i < 3; i++) taken.push(await consumeDailyScan('free', 'actor-refund'))
    assert.ok(taken.every((r) => r.allowed))
    assert.equal((await consumeDailyScan('free', 'actor-refund')).allowed, false)
    assert.equal((await consumeDailyScan('free', 'actor-refund')).allowed, false)
    assert.equal((await snapshotDailyScan('free', 'actor-refund')).used, 3, 'used never exceeds the limit')
    await taken[0].refund()
    await taken[0].refund()
    assert.equal((await snapshotDailyScan('free', 'actor-refund')).used, 2, 'one refund per consumed unit')
  })
})

describe('GET /api/wallet-scan/robinhood — account required', () => {
  beforeEach(() => installWalletScanTestAuth('user-a'))
  afterEach(() => clearWalletScanTestAuth())
  it('refuses an anonymous or unrecognised caller before any scan', async () => {
    const { GET } = await import('./robinhood/route')
    const anonymous = await GET(new Request(`http://localhost/api/wallet-scan/robinhood?address=${WALLET}`, { headers: { 'x-forwarded-for': '10.30.0.1' } }))
    const wrong = await GET(new Request(`http://localhost/api/wallet-scan/robinhood?address=${WALLET}`, { headers: { 'x-forwarded-for': '10.30.0.2', authorization: 'Bearer nope' } }))
    assert.deepEqual([anonymous.status, wrong.status], [401, 401])
  })
})

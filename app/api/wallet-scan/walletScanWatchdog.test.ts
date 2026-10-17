// Watchdog: stuck jobs fail with a clear code, unclaimed jobs are re-triggered, a job is claimed once.
//   npx tsx --test app/api/wallet-scan/walletScanWatchdog.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearWalletScanTestAuth, installWalletScanTestAuth, walletScanTestAuthHeaders } from './walletScanTestAuth'
import { kv } from '@/lib/server/kv'
import {
  WALLET_SCAN_WATCHDOG_MS, WALLET_SCAN_RETRIGGER_AFTER_MS, WALLET_SCAN_MAX_TRIGGER_ATTEMPTS,
  claimWalletScanPayload, heartbeatWalletScanJob, superviseWalletScanJob, walletScanClaimLockKey, walletScanJobKey, walletScanJobLiveKey,
  type WalletScanJobMetadata,
} from '@/src/modules/walletScanQueue'
import { jobFailureMessage } from '@/app/frontend/api/scanWallet'
import { GET as pollJob } from './[jobId]/route'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const original = { get: kv.get, set: kv.set, setIfAbsent: kv.setIfAbsent }
type Stored = { value: unknown; opts?: { ex?: number } }
function memoryKv(): Map<string, Stored> {
  const store = new Map<string, Stored>()
  kv.get = async <T = unknown>(key: string | null) => ((key === null ? undefined : store.get(key)?.value) as T | undefined) ?? null
  kv.set = async (key: string, value: unknown, opts?: { ex?: number }) => { store.set(key, { value, opts }); return 'OK' }
  kv.setIfAbsent = async (key: string, value: unknown, ex: number) => { if (store.has(key)) return false; store.set(key, { value, opts: { ex } }); return true }
  return store
}
const job = (over: Partial<WalletScanJobMetadata>): WalletScanJobMetadata => ({
  jobId: 'j1', userId: 'user-a', wallet: '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811', status: 'queued', createdAt: 1_000_000, updatedAt: 1_000_000, ...over,
})

describe('superviseWalletScanJob', () => {
  const t0 = 1_000_000
  it('a fresh queued job is left alone, then re-triggered, a bounded number of times', () => {
    assert.deepEqual(superviseWalletScanJob(job({}), t0 + 1_000), { action: 'none' })
    assert.deepEqual(superviseWalletScanJob(job({}), t0 + WALLET_SCAN_RETRIGGER_AFTER_MS), { action: 'retrigger', attempt: 1 })
    assert.deepEqual(superviseWalletScanJob(job({ triggerAttempts: 1, lastTriggerAt: t0 + 8_000 }), t0 + 10_000), { action: 'none' })
    assert.deepEqual(superviseWalletScanJob(job({ triggerAttempts: WALLET_SCAN_MAX_TRIGGER_ATTEMPTS, lastTriggerAt: t0 }), t0 + 60_000), { action: 'none' })
  })
  it('a queued job never claimed for 90s fails as worker_not_started', () => {
    assert.deepEqual(superviseWalletScanJob(job({}), t0 + WALLET_SCAN_WATCHDOG_MS + 1), { action: 'fail', error: 'worker_not_started', silentForMs: WALLET_SCAN_WATCHDOG_MS + 1 })
  })
  it('a running job fails only after 90s without a heartbeat', () => {
    const running = job({ status: 'running', claimedAt: t0, heartbeatAt: t0 + 100_000 })
    assert.deepEqual(superviseWalletScanJob(running, t0 + 150_000), { action: 'none' })
    assert.equal(superviseWalletScanJob(running, t0 + 100_000 + WALLET_SCAN_WATCHDOG_MS + 1).action, 'fail')
    assert.equal((superviseWalletScanJob(running, t0 + 300_000) as { error: string }).error, 'worker_stalled')
  })
  it('terminal jobs are never touched', () => {
    assert.deepEqual(superviseWalletScanJob(job({ status: 'done' }), t0 + 10 * WALLET_SCAN_WATCHDOG_MS), { action: 'none' })
    assert.deepEqual(superviseWalletScanJob(job({ status: 'failed' }), t0 + 10 * WALLET_SCAN_WATCHDOG_MS), { action: 'none' })
  })
})

describe('claim + heartbeat', () => {
  beforeEach(() => { process.env.KV_REST_API_URL = 'https://x.upstash.io'; process.env.KV_REST_API_TOKEN = 't' })
  afterEach(() => { process.env = { ...originalEnv }; Object.assign(kv, original) })

  it('a job is claimed exactly once, even when the worker is triggered again', async () => {
    const store = memoryKv()
    store.set(walletScanJobKey('j1'), { value: job({}) })
    assert.ok(await claimWalletScanPayload('j1'))
    assert.equal(await claimWalletScanPayload('j1'), null) // now running
    const claimed = store.get(walletScanJobKey('j1'))?.value as WalletScanJobMetadata
    assert.equal(claimed.status, 'running')
    assert.equal(typeof claimed.heartbeatAt, 'number')
    // A queued record whose lock another invocation already holds is not claimed twice.
    store.set(walletScanJobKey('j2'), { value: job({ jobId: 'j2' }) })
    store.set(walletScanClaimLockKey('j2'), { value: 1 })
    assert.equal(await claimWalletScanPayload('j2'), null)
  })
  it('heartbeats on the live key and never rewrites the job record', async () => {
    const store = memoryKv()
    const running = job({ jobId: 'j3', status: 'running', heartbeatAt: 1 })
    store.set(walletScanJobKey('j3'), { value: running })
    await heartbeatWalletScanJob('j3')
    assert.ok(((store.get(walletScanJobLiveKey('j3'))?.value as { heartbeatAt: number }).heartbeatAt ?? 0) > 1)
    assert.deepEqual(store.get(walletScanJobKey('j3'))?.value, running, 'job record untouched')
    const done = job({ jobId: 'j4', status: 'done' })
    store.set(walletScanJobKey('j4'), { value: done })
    await heartbeatWalletScanJob('j4')
    assert.deepEqual(store.get(walletScanJobKey('j4'))?.value, done, 'a terminal job record is never touched')
  })
})

describe('poll route watchdog', () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://x.upstash.io'; process.env.KV_REST_API_TOKEN = 't'; process.env.WALLET_SCAN_WORKER_SECRET = 's'
    installWalletScanTestAuth()
  })
  afterEach(() => { process.env = { ...originalEnv }; Object.assign(kv, original); globalThis.fetch = originalFetch; clearWalletScanTestAuth() })
  const poll = (jobId: string) => pollJob(new Request(`http://localhost/api/wallet-scan/${jobId}`, { headers: walletScanTestAuthHeaders }), { params: Promise.resolve({ jobId }) })

  it('a running job silent for over 90s is marked failed and reported as worker_stalled', async () => {
    const store = memoryKv()
    store.set(walletScanJobKey('stuck'), { value: job({ jobId: 'stuck', status: 'running', heartbeatAt: Date.now() - WALLET_SCAN_WATCHDOG_MS - 5_000 }) })
    const body = await (await poll('stuck')).json()
    assert.deepEqual(body, { status: 'failed', error: 'worker_stalled' })
    assert.equal((store.get(walletScanJobKey('stuck'))?.value as WalletScanJobMetadata).status, 'failed')
  })
  it('a queued job is re-triggered and the response carries the clock fields', async () => {
    const store = memoryKv()
    const triggered: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => { triggered.push(String(url)); return new Response(null, { status: 202 }) }) as typeof fetch
    store.set(walletScanJobKey('q1'), { value: job({ jobId: 'q1', createdAt: Date.now() - 10_000 }) })
    const body = await (await poll('q1')).json() as Record<string, unknown>
    assert.equal(body.status, 'queued')
    assert.equal(typeof body.serverNow, 'number')
    assert.equal(triggered.length, 1)
    assert.match(triggered[0], /\/api\/wallet-scan\/worker$/)
    assert.equal((store.get(walletScanJobKey('q1'))?.value as WalletScanJobMetadata).triggerAttempts, 1)
  })
  it('watchdog codes read as plain sentences', () => {
    assert.match(jobFailureMessage('worker_stalled'), /no progress for 90 seconds/)
    assert.match(jobFailureMessage('worker_not_started'), /never started/)
  })
})

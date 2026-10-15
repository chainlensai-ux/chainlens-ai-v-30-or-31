// Enqueue hardening: non-blocking worker trigger, stage-tagged failures, stale pending list, record TTLs.
//   npx tsx --test src/modules/walletScanEnqueue.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import {
  MAX_PENDING_JOB_IDS, WalletScanQueueUnavailableError, claimWalletScanPayload, describeKvError, enqueueWalletScanJob,
  publishWalletScanPartialSnapshot, triggerWalletScanWorker, updateWalletScanJobProgress, walletScanJobKey, walletScanPendingKey,
} from './walletScanQueue'
import { enqueueFailureMessage } from '../../app/frontend/api/scanWallet'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const originalGet = kv.get
const originalSet = kv.set
type Stored = { value: unknown; opts?: { ex?: number } }
function memoryKv(): Map<string, Stored> {
  const store = new Map<string, Stored>()
  kv.get = async <T = unknown>(key: string | null) => ((key === null ? undefined : store.get(key)?.value) as T | undefined) ?? null
  kv.set = async (key: string, value: unknown, opts?: { ex?: number }) => { store.set(key, { value, opts }); return 'OK' }
  return store
}
const payload = (jobId: string) => ({ userId: 'u', jobId, walletAddress: '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811', chains: ['base'], scanMode: 'normal' as const, ip: '1.1.1.1' })

describe('worker trigger', () => {
  beforeEach(() => { process.env.WALLET_SCAN_WORKER_SECRET = 's' })
  afterEach(() => { process.env = { ...originalEnv }; globalThis.fetch = originalFetch })

  it('does not wait for the worker to finish the job; the request is kept alive separately', async () => {
    let kept: Promise<unknown> | null = null
    const started = Date.now()
    const outcome = await triggerWalletScanWorker('job-1', { fetchImpl: () => new Promise<Response>(() => {}), keepAlive: (w) => { kept = w }, dispatchWaitMs: 30 })
    assert.equal(outcome.kind, 'dispatched')
    assert.ok(Date.now() - started < 1_000)
    assert.ok(kept)
  })
  it('reports a fast worker refusal (e.g. 401) instead of hiding it', async () => {
    const outcome = await triggerWalletScanWorker('job-2', { fetchImpl: async () => new Response(null, { status: 401 }), keepAlive: () => {} })
    assert.deepEqual({ kind: outcome.kind, status: (outcome as { status?: number }).status }, { kind: 'responded', status: 401 })
  })
  it('without the worker secret nothing is sent', async () => {
    delete process.env.WALLET_SCAN_WORKER_SECRET
    let calls = 0
    const outcome = await triggerWalletScanWorker('job-3', { fetchImpl: async () => { calls += 1; return new Response(null) }, keepAlive: () => {} })
    assert.deepEqual(outcome, { kind: 'not_configured' })
    assert.equal(calls, 0)
  })
})

describe('enqueue', () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io'
    process.env.KV_REST_API_TOKEN = 't'
    process.env.WALLET_SCAN_WORKER_SECRET = 's'
    globalThis.fetch = async () => new Response(null, { status: 202 })
  })
  afterEach(() => { process.env = { ...originalEnv }; globalThis.fetch = originalFetch; kv.get = originalGet; kv.set = originalSet })

  it('a failure names its stage and keeps the underlying KV error', async () => {
    memoryKv()
    kv.set = async (key: string) => {
      if (key === walletScanJobKey('job-x')) throw Object.assign(new Error('ERR max daily request limit exceeded'), { status: 429 })
      return 'OK'
    }
    await assert.rejects(() => enqueueWalletScanJob('job-x', payload('job-x')), (err: unknown) => {
      assert.ok(err instanceof WalletScanQueueUnavailableError)
      assert.equal(err.stage, 'write_job_record')
      assert.match(err.detail ?? '', /max daily request limit exceeded/)
      assert.match(err.detail ?? '', /status=429/)
      return true
    })
  })
  it('a malformed or oversized stale pending list never blocks a new job', async () => {
    const store = memoryKv()
    store.set(walletScanPendingKey(), { value: 'not-an-array' })
    await enqueueWalletScanJob('job-a', payload('job-a'))
    assert.deepEqual(store.get(walletScanPendingKey())?.value, ['job-a'])
    store.set(walletScanPendingKey(), { value: Array.from({ length: MAX_PENDING_JOB_IDS + 50 }, (_, i) => `stale-${i}`) })
    await enqueueWalletScanJob('job-b', payload('job-b'))
    const pending = store.get(walletScanPendingKey())?.value as string[]
    assert.equal(pending.length, MAX_PENDING_JOB_IDS)
    assert.equal(pending[pending.length - 1], 'job-b')
  })
  it('a main job and its follow-up are separate records (distinct ids, follow-up flag kept)', async () => {
    const store = memoryKv()
    await enqueueWalletScanJob('main', payload('main'))
    await enqueueWalletScanJob('follow', { ...payload('follow'), heavyWalletFollowUp: true })
    assert.equal((store.get(walletScanJobKey('main'))?.value as { heavyWalletFollowUp?: boolean }).heavyWalletFollowUp, undefined)
    assert.equal((store.get(walletScanJobKey('follow'))?.value as { heavyWalletFollowUp?: boolean }).heavyWalletFollowUp, true)
  })
  it('claim, progress and partial-snapshot writes keep the 30-minute expiry, so a killed job cannot leave a permanent "running" record', async () => {
    const store = memoryKv()
    await enqueueWalletScanJob('job-ttl', payload('job-ttl'))
    await claimWalletScanPayload('job-ttl')
    assert.equal(store.get(walletScanJobKey('job-ttl'))?.opts?.ex, 1800)
    await updateWalletScanJobProgress('job-ttl', { stage: 'core', label: 'x', elapsedMs: 1 })
    assert.equal(store.get(walletScanJobKey('job-ttl'))?.opts?.ex, 1800)
    await publishWalletScanPartialSnapshot('job-ttl', { portfolioTotalValueUsd: 1, holdingsCount: 1, topHoldings: [], activeChainIds: [8453], publishedAtElapsedMs: 1 })
    assert.equal(store.get(walletScanJobKey('job-ttl'))?.opts?.ex, 1800)
  })
})

describe('error text', () => {
  it('describeKvError keeps status/code/cause', () => {
    assert.equal(describeKvError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })), 'Error: boom | code=ETIMEDOUT')
  })
  it('the client no longer collapses every enqueue failure into scan-enqueue-failed', () => {
    assert.equal(enqueueFailureMessage(503, { error: 'scan-queue-unavailable' }), 'The scan queue is temporarily unavailable. Please try again in a moment.')
    assert.equal(enqueueFailureMessage(504, null), 'Starting the scan timed out. Please try again in a moment.')
    assert.equal(enqueueFailureMessage(429, { error: { message: 'Rate limit reached.' } }), 'Rate limit reached.')
    assert.equal(enqueueFailureMessage(502, null), 'scan-enqueue-failed (HTTP 502)')
  })
})

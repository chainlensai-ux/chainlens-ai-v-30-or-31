import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import {
  claimNextWalletScanPayload,
  claimWalletScanPayload,
  enqueueWalletScanJob,
  readWalletScanJob,
  readWalletScanResult,
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
} from './walletScanQueue'
import { publishFinal } from './walletScanWorker'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const originalGet = kv.get
const originalSet = kv.set

type Stored = { value: unknown; opts?: { ex?: number } }

function restore(): void {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
  kv.get = originalGet
  kv.set = originalSet
}

function configureRestEnv(): void {
  process.env.KV_REST_API_URL = 'https://settled-iad1-example.upstash.io'
  process.env.KV_REST_API_TOKEN = 'test-token'
}

function installMemoryKv(): Map<string, Stored> {
  const store = new Map<string, Stored>()
  kv.get = async <T = unknown>(key: string | null): Promise<T | null> => ((key === null ? undefined : store.get(key)?.value) as T | undefined) ?? null
  kv.set = async (key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> => { store.set(key, { value, opts }); return 'OK' }
  return store
}

describe('wallet scan queue with KV', () => {
  beforeEach(() => {
    restore()
    configureRestEnv()
    globalThis.fetch = async () => new Response(null, { status: 202 })
  })

  afterEach(restore)

  it('simulates KV timeout without enqueueing jobId into the pending queue', async () => {
    const store = installMemoryKv()
    const timeout = Object.assign(new Error('redis rest request timed out'), { code: 'ETIMEDOUT', name: 'TimeoutError' })
    kv.get = async <T = unknown>(key: string | null): Promise<T | null> => {
      if (key === walletScanPendingKey()) throw timeout
      return ((key === null ? undefined : store.get(key)?.value) as T | undefined) ?? null
    }

    await assert.rejects(
      () => enqueueWalletScanJob('timeout-job', { jobId: 'timeout-job', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' }),
      /redis rest request timed out/,
    )
    assert.equal(store.get(walletScanPendingKey())?.value, undefined)
  })

  it('simulates KV success for enqueue and claim', async () => {
    installMemoryKv()

    await enqueueWalletScanJob('job-success', { jobId: 'job-success', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
    const payload = await claimNextWalletScanPayload()

    assert.deepEqual(payload, { jobId: 'job-success', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
  })

  it('transitions a claimed job from queued to running to done', async () => {
    const store = installMemoryKv()

    await enqueueWalletScanJob('job-flow', { jobId: 'job-flow', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
    const payload = await claimNextWalletScanPayload()
    assert.equal(payload?.jobId, 'job-flow')

    const running = await readWalletScanJob('job-flow')
    assert.equal(running?.status, 'running')

    await publishFinal('job-flow', { status: 'done', startedAt: 1, finishedAt: 3, durationMs: 2, pipelineDiagnostics: null }, { success: true })
    const done = await readWalletScanJob('job-flow')
    const result = await readWalletScanResult('job-flow')

    assert.equal(done?.status, 'done')
    assert.deepEqual(result, { success: true })
    assert.equal(store.get(walletScanPendingJobKey('job-flow'))?.value, false)
  })

  it('final publish writes result and job keys without TTL', async () => {
    const store = installMemoryKv()

    const outcome = await publishFinal('final-job', { status: 'done', startedAt: 1, finishedAt: 3, durationMs: 2, pipelineDiagnostics: null }, { ok: true })

    assert.equal(outcome, undefined)
    assert.deepEqual(store.get(walletScanResultKey('final-job')), { value: { ok: true }, opts: undefined })
    assert.equal(store.get(walletScanJobKey('final-job'))?.opts, undefined)
  })

  it('a repeated worker invocation for an already-done job is NOT re-claimed and its published result survives untouched', async () => {
    installMemoryKv()

    await enqueueWalletScanJob('job-idem', { jobId: 'job-idem', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
    const first = await claimWalletScanPayload('job-idem')
    assert.equal(first?.jobId, 'job-idem')

    await publishFinal('job-idem', { status: 'done', startedAt: 1, finishedAt: 3, durationMs: 2, pipelineDiagnostics: null }, { success: true, real: 'result' })

    const second = await claimWalletScanPayload('job-idem')
    assert.equal(second, null, 'expected a done job to never be re-claimed by a duplicate worker invocation')

    const job = await readWalletScanJob('job-idem')
    const result = await readWalletScanResult('job-idem')
    assert.equal(job?.status, 'done', 'expected the duplicate invocation to leave the done status untouched (not reset to running)')
    assert.deepEqual(result, { success: true, real: 'result' })
  })

  it('a failed job is likewise never re-claimed', async () => {
    installMemoryKv()

    await enqueueWalletScanJob('job-failed-idem', { jobId: 'job-failed-idem', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
    await kv.set(walletScanJobKey('job-failed-idem'), { jobId: 'job-failed-idem', wallet: '0x1', status: 'failed', createdAt: 1, updatedAt: 2 })

    const claimed = await claimWalletScanPayload('job-failed-idem')
    assert.equal(claimed, null)
  })

})

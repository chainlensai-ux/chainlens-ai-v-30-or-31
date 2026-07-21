import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { redis } from '@/lib/server/cache/redisClient'
import {
  WALLET_SCAN_FINAL_RESULT_UNAVAILABLE,
  claimNextWalletScanPayload,
  enqueueWalletScanJob,
  publishFinalWalletScanResult,
  readWalletScanJob,
  readWalletScanResult,
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
  writeWalletScanJob,
} from './walletScanQueue'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const originalGet = redis.get
const originalSet = redis.set
const originalSetCritical = redis.setCritical

type Stored = { value: unknown; opts?: { ex?: number } }

function restore(): void {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
  redis.get = originalGet
  redis.set = originalSet
  redis.setCritical = originalSetCritical
}

function configureRestEnv(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://settled-iad1-example.upstash.io'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
  process.env.UPSTASH_REDIS_REGION = 'iad1'
}

function installMemoryRedis(): Map<string, Stored> {
  const store = new Map<string, Stored>()
  redis.get = async <T = unknown>(key: string): Promise<T | null> => (store.get(key)?.value as T | undefined) ?? null
  redis.set = async (key: string, value: unknown, opts?: { ex?: number }): Promise<void> => { store.set(key, { value, opts }) }
  redis.setCritical = async (key: string, value: unknown, opts?: { ex?: number }): Promise<void> => { store.set(key, { value, opts }) }
  return store
}

describe('wallet scan queue with Upstash REST Redis', () => {
  beforeEach(() => {
    restore()
    configureRestEnv()
    globalThis.fetch = async () => new Response(null, { status: 202 })
  })

  afterEach(restore)

  it('simulates Redis REST timeout without enqueueing jobId into the pending queue', async () => {
    const store = installMemoryRedis()
    const timeout = Object.assign(new Error('redis rest request timed out'), { code: 'ETIMEDOUT', name: 'TimeoutError' })
    redis.get = async <T = unknown>(key: string): Promise<T | null> => {
      if (key === walletScanPendingKey()) throw timeout
      return (store.get(key)?.value as T | undefined) ?? null
    }

    await assert.rejects(
      () => enqueueWalletScanJob('timeout-job', { jobId: 'timeout-job', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' }),
      /redis rest request timed out/,
    )
    assert.equal(store.get(walletScanPendingKey())?.value, undefined)
  })

  it('simulates Redis REST success for enqueue and claim', async () => {
    installMemoryRedis()

    await enqueueWalletScanJob('job-success', { jobId: 'job-success', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
    const payload = await claimNextWalletScanPayload()

    assert.deepEqual(payload, { jobId: 'job-success', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
  })

  it('transitions a claimed job from queued to running to done', async () => {
    const store = installMemoryRedis()

    await enqueueWalletScanJob('job-flow', { jobId: 'job-flow', walletAddress: '0x1', chains: ['base'], scanMode: 'normal', ip: '127.0.0.1' })
    const payload = await claimNextWalletScanPayload()
    assert.equal(payload?.jobId, 'job-flow')

    const queued = await readWalletScanJob('job-flow')
    assert.equal(queued?.status, 'queued')

    await writeWalletScanJob({ ...queued!, status: 'running' })
    const running = await readWalletScanJob('job-flow')
    assert.equal(running?.status, 'running')

    await publishFinalWalletScanResult('job-flow', { success: true })
    const done = await readWalletScanJob('job-flow')
    const result = await readWalletScanResult('job-flow')

    assert.equal(done?.status, 'done')
    assert.deepEqual(result, { success: true })
    assert.equal(store.get(walletScanPendingJobKey('job-flow'))?.value, false)
  })

  it('final publish writes result and job keys without TTL', async () => {
    const store = installMemoryRedis()

    const outcome = await publishFinalWalletScanResult('final-job', { ok: true })

    assert.equal(outcome, undefined)
    assert.deepEqual(store.get(walletScanResultKey('final-job')), { value: { ok: true }, opts: undefined })
    assert.equal(store.get(walletScanJobKey('final-job'))?.opts, undefined)
  })

  it('returns degraded final-result-unavailable when REST final publish fails', async () => {
    installMemoryRedis()
    redis.setCritical = async (): Promise<void> => { throw Object.assign(new Error('REST timeout'), { code: 'ETIMEDOUT' }) }

    const outcome = await publishFinalWalletScanResult('final-fail', { ok: false }) as { error?: string; degraded?: boolean }

    assert.equal(outcome.error, WALLET_SCAN_FINAL_RESULT_UNAVAILABLE.error)
    assert.equal(outcome.degraded, true)
  })

  it('retries budget_exceeded final writes with adaptive backoff and still publishes', async () => {
    const store = installMemoryRedis()
    let attempts = 0
    redis.setCritical = async (key: string, value: unknown, opts?: { ex?: number }): Promise<void> => {
      attempts++
      if (attempts <= 2) throw Object.assign(new Error('budget_exceeded'), { code: 'budget_exceeded', remainingRps: 0, remainingBandwidth: 0, remainingPipelineBudget: 0, latencyMs: 42, clusterHealth: 'degraded' })
      store.set(key, { value, opts })
    }

    const outcome = await publishFinalWalletScanResult('budget-job', { success: true, data: { moduleErrors: {} } })

    assert.equal(outcome, undefined)
    assert.ok(attempts >= 3)
    assert.deepEqual(store.get(walletScanResultKey('budget-job'))?.value, { success: true, data: { moduleErrors: {} } })
    assert.equal((store.get(walletScanJobKey('budget-job'))?.value as { status?: string } | undefined)?.status, 'done')
  })

  it('keeps final publish in degraded partial-write mode when one key exhausts retries', async () => {
    const store = installMemoryRedis()
    redis.setCritical = async (key: string, value: unknown, opts?: { ex?: number }): Promise<void> => {
      if (key === walletScanResultKey('partial-job')) throw Object.assign(new Error('kv_timeout_safe'), { code: 'ETIMEDOUT' })
      store.set(key, { value, opts })
    }

    const outcome = await publishFinalWalletScanResult('partial-job', { success: true, data: { moduleErrors: {} } }) as { degraded?: boolean; finalResult?: { degraded?: boolean; data?: { degraded?: boolean; degradedModules?: string[] } } }

    assert.equal(outcome.degraded, true)
    assert.equal(outcome.finalResult?.degraded, true)
    assert.equal(outcome.finalResult?.data?.degraded, true)
    assert.ok(outcome.finalResult?.data?.degradedModules?.includes('holdings'))
    assert.ok(outcome.finalResult?.data?.degradedModules?.includes('provider-window'))
    assert.equal((store.get(walletScanJobKey('partial-job'))?.value as { status?: string } | undefined)?.status, 'done')
  })

})

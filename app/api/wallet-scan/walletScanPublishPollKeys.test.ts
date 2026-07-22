import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { redis } from '@/lib/server/cache/redisClient'
import { publishFinalWalletScanResult, walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueue'

const originalEnv = { ...process.env }
const originalGet = redis.get
const originalSet = redis.set

type Stored = { value: unknown; opts?: { ex?: number } }

function restore(): void {
  process.env = { ...originalEnv }
  redis.get = originalGet
  redis.set = originalSet
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
  return store
}

async function poll(jobId: string): Promise<{ status: number; body: unknown }> {
  const { GET } = await import('./[jobId]/route.ts')
  const res = await GET(new Request(`http://localhost/api/wallet-scan/${encodeURIComponent(jobId)}`), { params: Promise.resolve({ jobId }) })
  return { status: res.status, body: await res.json() }
}

describe('wallet-scan final publish and poll key alignment', () => {
  beforeEach(() => {
    restore()
    configureRestEnv()
  })

  afterEach(restore)

  it('publish → poll returns the full successful result', async () => {
    installMemoryRedis()
    const result = { success: true, data: { wallet: '0x1', pnl: { realized: 42 } } }

    await publishFinalWalletScanResult('job-full', result)
    const response = await poll('job-full')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, result)
  })

  it('publish → poll returns a degraded terminal fallback when the result key is missing', async () => {
    const store = installMemoryRedis()
    await publishFinalWalletScanResult('job-missing-result', { success: true })
    store.delete(walletScanResultKey('job-missing-result'))

    const response = await poll('job-missing-result')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { jobId: 'job-missing-result', status: 'done', result: { error: 'scan-final-result-unavailable', degraded: true } })
  })

  it('poll uses the exact jobId formatting written by final publish', async () => {
    const store = installMemoryRedis()
    const jobId = 'wallet:scan/job 1'

    await publishFinalWalletScanResult(jobId, { success: true })
    await poll(jobId)

    assert.equal(store.has(walletScanJobKey(jobId)), true)
    assert.equal(store.has(walletScanResultKey(jobId)), true)
  })

  it('poll uses the same key prefixes as final publish', async () => {
    const store = installMemoryRedis()
    await publishFinalWalletScanResult('job-prefix', { success: true })
    await poll('job-prefix')

    assert.deepEqual([...store.keys()].sort(), ['walletScanJob:job-prefix', 'walletScanResult:job-prefix'])
  })

  it('poll returns the full result when both final keys exist', async () => {
    installMemoryRedis()
    const result = { success: true, report: { sections: ['holdings', 'pnl', 'behavior'] } }

    await publishFinalWalletScanResult('job-both-keys', result)
    const response = await poll('job-both-keys')

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, result)
  })
})

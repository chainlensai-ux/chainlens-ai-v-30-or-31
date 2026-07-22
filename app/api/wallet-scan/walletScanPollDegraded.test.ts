import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { kv } from '@/lib/server/kv'
import { walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueue'

const originalEnv = { ...process.env }
const originalGet = kv.get

type Stored = { value: unknown }

function restore(): void {
  process.env = { ...originalEnv }
  kv.get = originalGet
}

function configureRestEnv(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://settled-iad1-example.upstash.io'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
  process.env.UPSTASH_REDIS_REGION = 'iad1'
}

describe('wallet-scan poll degraded final result behavior', () => {
  beforeEach(() => {
    restore()
    configureRestEnv()
  })

  afterEach(restore)

  it('returns done/degraded instead of unavailable when the final result read fails', async () => {
    const store = new Map<string, Stored>()
    store.set(walletScanJobKey('degraded-job'), { value: { jobId: 'degraded-job', wallet: '0x1', status: 'done', createdAt: 1, updatedAt: 2, finishedAt: 3 } })
    kv.get = async <T = unknown>(key: string | null): Promise<T | null> => {
      if (key === null) return null
      if (key === walletScanResultKey('degraded-job')) throw Object.assign(new Error('read failed'), { code: 'READ_FAILED' })
      return (store.get(key)?.value as T | undefined) ?? null
    }

    const { GET } = await import('./[jobId]/route.ts')
    const res = await GET(new Request('http://localhost/api/wallet-scan/degraded-job'), { params: Promise.resolve({ jobId: 'degraded-job' }) })
    const body = await res.json() as { status?: string; result?: { error?: string; degraded?: boolean } }

    assert.equal(res.status, 200)
    assert.equal(body.status, 'done')
    assert.deepEqual(body.result, { error: 'scan-final-result-unavailable', degraded: true })
  })

  it('returns done/degraded when the stored final result is degraded', async () => {
    const store = new Map<string, Stored>()
    store.set(walletScanJobKey('stored-degraded-job'), { value: { jobId: 'stored-degraded-job', wallet: '0x1', status: 'done', createdAt: 1, updatedAt: 2, finishedAt: 3 } })
    store.set(walletScanResultKey('stored-degraded-job'), { value: { success: true, degraded: true, data: { degraded: true } } })
    kv.get = async <T = unknown>(key: string | null): Promise<T | null> => (key === null ? null : (store.get(key)?.value as T | undefined) ?? null)

    const { GET } = await import('./[jobId]/route.ts')
    const res = await GET(new Request('http://localhost/api/wallet-scan/stored-degraded-job'), { params: Promise.resolve({ jobId: 'stored-degraded-job' }) })
    const body = await res.json() as { status?: string; result?: { success?: boolean; degraded?: boolean; data?: { degraded?: boolean } } }

    assert.equal(res.status, 200)
    assert.equal(body.status, 'done')
    assert.equal(body.result?.success, true)
    assert.equal(body.result?.degraded, true)
    assert.equal(body.result?.data?.degraded, true)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const VALID_WALLET = '0x0000000000000000000000000000000000000001'

async function withoutRedisUrl<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.REDIS_URL
  delete process.env.REDIS_URL
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = original
  }
}

describe('wallet-scan queue unavailable behavior', () => {
  it('queue unavailable makes the enqueue route return a degraded terminal error without a jobId', async () => {
    await withoutRedisUrl(async () => {
      const { POST } = await import('./route.ts')
      const res = await POST(new Request('http://localhost/api/wallet-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: VALID_WALLET, chains: ['base'], scanMode: 'normal' }),
      }))
      const body = await res.json()

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-queue-unavailable', degraded: true })
      assert.equal('jobId' in body, false)
    })
  })

  it('worker queue claim unavailable returns a degraded terminal error', async () => {
    await withoutRedisUrl(async () => {
      const { POST } = await import('./worker/route.ts')
      const res = await POST()
      const body = await res.json()

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-queue-unavailable', degraded: true })
      assert.equal('jobId' in body, false)
    })
  })

  it('poll route returns degraded status-unavailable when Redis cannot read job keys', async () => {
    await withoutRedisUrl(async () => {
      const { GET } = await import('./[jobId]/route.ts')
      const res = await GET(new Request('http://localhost/api/wallet-scan/job-1'), { params: Promise.resolve({ jobId: 'job-1' }) })
      const body = await res.json() as { error: string; degraded: boolean; status?: string }

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-status-unavailable', degraded: true })
      assert.equal(body.status, undefined)
    })
  })
})

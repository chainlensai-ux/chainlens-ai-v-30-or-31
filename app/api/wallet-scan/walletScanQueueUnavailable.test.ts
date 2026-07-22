import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const VALID_WALLET = '0x0000000000000000000000000000000000000001'

async function withoutKvRest<T>(fn: () => Promise<T>): Promise<T> {
  const original = { ...process.env }
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  try {
    return await fn()
  } finally {
    process.env = original
  }
}

describe('wallet-scan queue unavailable behavior', () => {
  it('queue unavailable makes the enqueue route return an error without a jobId', async () => {
    await withoutKvRest(async () => {
      const { POST } = await import('./route.ts')
      const res = await POST(new Request('http://localhost/api/wallet-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: VALID_WALLET, chains: ['base'], scanMode: 'normal' }),
      }))
      const body = await res.json()

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-queue-unavailable' })
      assert.equal('jobId' in body, false)
    })
  })

  it('worker queue claim unavailable returns an error', async () => {
    await withoutKvRest(async () => {
      const { POST } = await import('./worker/route.ts')
      const res = await POST(new Request('http://localhost/api/wallet-scan/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'job-1' }) }))
      const body = await res.json()

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-queue-unavailable' })
      assert.equal('jobId' in body, false)
    })
  })

  it('poll route returns status-unavailable when KV cannot read job keys', async () => {
    await withoutKvRest(async () => {
      const { GET } = await import('./[jobId]/route.ts')
      const res = await GET(new Request('http://localhost/api/wallet-scan/job-1'), { params: Promise.resolve({ jobId: 'job-1' }) })
      const body = await res.json() as { error: string; status?: string }

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-status-unavailable' })
      assert.equal(body.status, undefined)
    })
  })
})

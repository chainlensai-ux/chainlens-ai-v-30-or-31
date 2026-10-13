import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clearWalletScanTestAuth, installWalletScanTestAuth, walletScanTestAuthHeaders } from './walletScanTestAuth'

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
  it('unauthenticated poll and worker calls are still refused (the test seam never bypasses auth)', async () => {
    const { GET } = await import('./[jobId]/route.ts')
    installWalletScanTestAuth('user-a')
    try {
      const noToken = await GET(new Request('http://localhost/api/wallet-scan/job-1'), { params: Promise.resolve({ jobId: 'job-1' }) })
      const wrongToken = await GET(new Request('http://localhost/api/wallet-scan/job-1', { headers: { authorization: 'Bearer not-the-test-token' } }), { params: Promise.resolve({ jobId: 'job-1' }) })
      assert.deepEqual([noToken.status, wrongToken.status], [401, 401])
    } finally { clearWalletScanTestAuth() }
    const { POST } = await import('./worker/route.ts')
    const original = process.env.WALLET_SCAN_WORKER_SECRET
    process.env.WALLET_SCAN_WORKER_SECRET = 'wallet-scan-worker-test-secret'
    try {
      const res = await POST(new Request('http://localhost/api/wallet-scan/worker', { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' }))
      assert.equal(res.status, 401)
    } finally {
      if (original === undefined) delete process.env.WALLET_SCAN_WORKER_SECRET; else process.env.WALLET_SCAN_WORKER_SECRET = original
    }
  })

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
      // The worker route is secret-gated: an authorized worker call reaching an unavailable queue.
      process.env.WALLET_SCAN_WORKER_SECRET = 'wallet-scan-worker-test-secret'
      const res = await POST(new Request('http://localhost/api/wallet-scan/worker', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer wallet-scan-worker-test-secret' }, body: JSON.stringify({ jobId: 'job-1' }) }))
      const body = await res.json()

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-queue-unavailable' })
      assert.equal('jobId' in body, false)
    })
  })

  it('poll route returns status-unavailable when KV cannot read job keys', async () => {
    await withoutKvRest(async () => {
      const { GET } = await import('./[jobId]/route.ts')
      // An authenticated caller (the poll route is account-required) whose job keys cannot be read.
      installWalletScanTestAuth('user-a')
      const res = await GET(new Request('http://localhost/api/wallet-scan/job-1', { headers: walletScanTestAuthHeaders }), { params: Promise.resolve({ jobId: 'job-1' }) }).finally(clearWalletScanTestAuth)
      const body = await res.json() as { error: string; status?: string }

      assert.equal(res.status, 503)
      assert.deepEqual(body, { error: 'scan-status-unavailable' })
      assert.equal(body.status, undefined)
    })
  })
})

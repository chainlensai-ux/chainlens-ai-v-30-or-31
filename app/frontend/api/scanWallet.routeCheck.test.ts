// Tests for app/frontend/api/scanWallet.ts. Uses node:test with a mocked global.fetch (no real
// network/dev-server dependency). Run directly with:
//   npx tsx --test app/frontend/api/scanWallet.routeCheck.test.ts

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

const originalSetTimeout = global.setTimeout

describe('scanWalletV2 (wallet-scan background job + polling)', () => {
  it('enqueues via /api/wallet-scan, polls by jobId, and returns the completed full scan result', async () => {
    const calls: string[] = []
    const updates: string[] = []
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/wallet-scan') {
        return new Response(JSON.stringify({ jobId: 'job-1', status: 'queued' }), { status: 200 })
      }
      return new Response(JSON.stringify({ jobId: 'job-1', status: 'done', result: { success: true, data: { fromJob: true } } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'normal', ({ status }) => updates.push(status))

      assert.deepEqual(calls, ['/api/wallet-scan', '/api/wallet-scan/job-1'])
      assert.deepEqual(updates, ['queued', 'done'])
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { fromJob: true })
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
    }
  })

  it('returns a structured error when enqueue fails validation/server-side', async () => {
    const originalFetch = global.fetch
    global.fetch = mock.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid wallet address' } }), { status: 400 })) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('bad', ['base'], 'normal')

      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'Invalid wallet address')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('returns a structured error when the background job fails', async () => {
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      if (url === '/api/wallet-scan') {
        return new Response(JSON.stringify({ jobId: 'job-2', status: 'queued' }), { status: 200 })
      }
      return new Response(JSON.stringify({ jobId: 'job-2', status: 'failed', error: 'provider failure' }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'deep')

      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'provider failure')
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
    }
  })

  it('returns degraded final-result-unavailable as a terminal result', async () => {
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      if (url === '/api/wallet-scan') {
        return new Response(JSON.stringify({ jobId: 'job-3', status: 'queued' }), { status: 200 })
      }
      return new Response(JSON.stringify({ jobId: 'job-3', status: 'done', result: { error: 'scan-final-result-unavailable', degraded: true } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

      assert.equal(result.degraded, true)
      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'scan-final-result-unavailable')
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
    }
  })


  it('keeps polling through a transient not-found status response', async () => {
    const calls: string[] = []
    const updates: string[] = []
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/wallet-scan') {
        return new Response(JSON.stringify({ jobId: 'job-transient', status: 'queued' }), { status: 200 })
      }
      const pollCount = calls.filter((call) => call === '/api/wallet-scan/job-transient').length
      if (pollCount === 1) {
        return new Response(JSON.stringify({ jobId: 'job-transient', status: 'not-found' }), { status: 404 })
      }
      return new Response(JSON.stringify({ jobId: 'job-transient', status: 'done', result: { success: true, data: { recovered: true } } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'normal', ({ status }) => updates.push(status))

      assert.deepEqual(calls, ['/api/wallet-scan', '/api/wallet-scan/job-transient', '/api/wallet-scan/job-transient'])
      assert.deepEqual(updates, ['queued', 'done'])
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { recovered: true })
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
    }
  })


  it('returns an immediate done result when the enqueue route falls back to synchronous scan', async () => {
    const calls: string[] = []
    const updates: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({
        jobId: 'job-inline',
        status: 'done',
        result: { success: true, data: { inlineFallback: true } },
      }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'normal', ({ status }) => updates.push(status))

      assert.deepEqual(calls, ['/api/wallet-scan'])
      assert.deepEqual(updates, ['done'])
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { inlineFallback: true })
    } finally {
      global.fetch = originalFetch
    }
  })


  it('treats queue unavailable as terminal and does not poll', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ error: 'scan-queue-unavailable', degraded: true }), { status: 503 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

      assert.deepEqual(calls, ['/api/wallet-scan'])
      assert.equal(result.success, false)
      assert.equal(result.degraded, true)
      assert.equal(result.error?.message, 'Scan is currently unavailable. Please try again later.')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('retries through a transient poll 503 lacking the degraded flag, instead of failing immediately', async () => {
    // Confirmed real production shape: the poll route's own catch-all for a single transient
    // kv.get() failure returns { error: 'scan-status-unavailable' } with NO `degraded` field (see
    // WALLET_SCAN_STATUS_UNAVAILABLE in src/modules/walletScanQueue.ts) — this must NOT match
    // isTerminalScanUnavailable() (which requires degraded === true) and must retry within budget,
    // unlike the always-terminal shape covered by the test above.
    const calls: string[] = []
    const updates: string[] = []
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/wallet-scan') {
        return new Response(JSON.stringify({ jobId: 'job-transient-503', status: 'queued' }), { status: 200 })
      }
      const pollCount = calls.filter((call) => call === '/api/wallet-scan/job-transient-503').length
      if (pollCount === 1) {
        return new Response(JSON.stringify({ error: 'scan-status-unavailable' }), { status: 503 })
      }
      return new Response(JSON.stringify({ jobId: 'job-transient-503', status: 'done', result: { success: true, data: { recovered: true } } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'normal', ({ status }) => updates.push(status))

      assert.deepEqual(calls, ['/api/wallet-scan', '/api/wallet-scan/job-transient-503', '/api/wallet-scan/job-transient-503'])
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { recovered: true })
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
    }
  })

  it('treats status unavailable as terminal without queued/not-found retry loops', async () => {
    const calls: string[] = []
    const updates: string[] = []
    global.setTimeout = ((cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0)) as typeof setTimeout
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/wallet-scan') {
        return new Response(JSON.stringify({ jobId: 'job-unavailable', status: 'queued' }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'scan-status-unavailable', degraded: true }), { status: 503 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet.ts')
      const result = await scanWalletV2('0xabc', ['base'], 'normal', ({ status }) => updates.push(status))

      assert.deepEqual(calls, ['/api/wallet-scan', '/api/wallet-scan/job-unavailable'])
      assert.deepEqual(updates, ['queued'])
      assert.equal(result.success, false)
      assert.equal(result.degraded, true)
      assert.equal(result.error?.message, 'Scan is currently unavailable. Please try again later.')
    } finally {
      global.fetch = originalFetch
      global.setTimeout = originalSetTimeout
    }
  })

})

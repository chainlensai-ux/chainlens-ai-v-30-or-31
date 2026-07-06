// Tests for app/frontend/api/scanWallet.ts. Uses node:test with a mocked global.fetch (no real
// network/dev-server dependency). NOT wired into `npm test` (which runs a single hardcoded file —
// see package.json). Run directly with:
//   npx tsx --test app/frontend/api/scanWallet.routeCheck.test.ts
//
// RENAMED, DISCLOSED (Migrate-full-scan-to-job/poll task): this file previously tested
// `scanWalletV2`'s old synchronous-direct-route behavior. That behavior now lives, unchanged, in
// `scanWalletV2Legacy` (see scanWallet.ts's own header) — the tests below were repointed at that
// renamed function rather than deleted, since the behavior itself is still real and still exported.
// A new suite was added for `scanWalletV2`'s new job/poll behavior (the function every real call
// site actually uses now).

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('scanWalletV2Legacy (direct V2 route only, no fallback)', () => {
  it('calls only the legacy V2 route (/api/scan-v2/full-scan/legacy) on success', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ success: true, data: { fromV2: true } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2Legacy } = await import('./scanWallet')
      const result = await scanWalletV2Legacy('0xabc', ['base'], 'normal')

      assert.equal(calls.length, 1)
      assert.equal(calls[0], '/api/scan-v2/full-scan/legacy')
      assert.ok(!calls.some((c) => c.includes('full-scan-job')), 'expected the job route to never be called')
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { fromV2: true })
    } finally {
      global.fetch = originalFetch
    }
  })

  it('a V2-route network failure resolves to a structured error, with no fallback call', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      throw new Error('simulated network failure')
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2Legacy } = await import('./scanWallet')
      const result = await scanWalletV2Legacy('0xabc', ['base'], 'normal')

      assert.equal(calls.length, 1, 'expected exactly one call attempt, no fallback retry')
      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'simulated network failure')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('a non-2xx V2-route response with no usable JSON body resolves to a generic network error', async () => {
    const originalFetch = global.fetch
    // A non-500 status with an empty body has no plausible gateway-timeout signal, so this still
    // exercises the plain "network-failed" fallback path (see the 5xx-empty-body case below for the
    // gateway-timeout-detection path this same fallback now also covers).
    global.fetch = mock.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch

    try {
      const { scanWalletV2Legacy } = await import('./scanWallet')
      const result = await scanWalletV2Legacy('0xabc', ['base'], 'normal')

      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'network-failed')
      assert.deepEqual(result.error?.details, ['HTTP 404'])
    } finally {
      global.fetch = originalFetch
    }
  })

  it('a 5xx response with no JSON body (platform gateway timeout) surfaces a clear timeout message, not the generic one', async () => {
    const originalFetch = global.fetch
    global.fetch = mock.fn(async () => new Response('<html>504 Gateway Timeout</html>', { status: 504 })) as unknown as typeof fetch

    try {
      const { scanWalletV2Legacy } = await import('./scanWallet')
      const result = await scanWalletV2Legacy('0xabc', ['base'], 'normal')

      assert.equal(result.success, false)
      assert.match(result.error?.message ?? '', /took too long/)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('a non-2xx V2-route response WITH a real backend error body surfaces that real message (the actual bug this fixes)', async () => {
    const originalFetch = global.fetch
    global.fetch = mock.fn(async () => new Response(
      JSON.stringify({ success: false, error: { message: 'goldrush_client_error: invalid api key', category: 'unknown' } }),
      { status: 500 },
    )) as unknown as typeof fetch

    try {
      const { scanWalletV2Legacy } = await import('./scanWallet')
      const result = await scanWalletV2Legacy('0xabc', ['base'], 'normal')

      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'goldrush_client_error: invalid api key', 'expected the REAL backend error message, not a generic "network-failed"')
      assert.equal(result.error?.category, 'unknown')
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('scanWalletV2 (job/poll, migrated off the synchronous route)', () => {
  it('enqueues via /api/scan-v2/full-scan/start, then polls /api/scan-v2/full-scan/status, and returns the completed result', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    let pollCount = 0
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/scan-v2/full-scan/start') {
        return new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200 })
      }
      if (url.startsWith('/api/scan-v2/full-scan/status')) {
        pollCount++
        if (pollCount < 2) {
          return new Response(JSON.stringify({ jobId: 'job-1', status: 'running', result: null, error: null }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ jobId: 'job-1', status: 'completed', result: { fromJob: true }, error: null }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

      assert.ok(calls.includes('/api/scan-v2/full-scan/start'))
      assert.ok(calls.some((c) => c.startsWith('/api/scan-v2/full-scan/status')))
      assert.ok(!calls.some((c) => c === '/api/scan-v2/full-scan/legacy'), 'the legacy synchronous route must never be called by the new path')
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { fromJob: true })
    } finally {
      global.fetch = originalFetch
    }
  })

  it('does not run the 11-module chain inline: a failed enqueue never calls the status route', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ error: 'invalid wallet address' }), { status: 400 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('not-a-wallet', ['base'], 'normal')

      assert.equal(calls.length, 1)
      assert.equal(calls[0], '/api/scan-v2/full-scan/start')
      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'invalid wallet address')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('a failed job status surfaces the real backend error message', async () => {
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      if (url === '/api/scan-v2/full-scan/start') {
        return new Response(JSON.stringify({ jobId: 'job-2' }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ jobId: 'job-2', status: 'failed', result: null, error: 'goldrush_client_error: invalid api key' }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'goldrush_client_error: invalid api key')
    } finally {
      global.fetch = originalFetch
    }
  })
})

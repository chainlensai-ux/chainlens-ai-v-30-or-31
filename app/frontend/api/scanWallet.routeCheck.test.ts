// Tests for app/frontend/api/scanWallet.ts. Uses node:test with a mocked global.fetch (no real
// network/dev-server dependency). NOT wired into `npm test` (which runs a single hardcoded file —
// see package.json). Run directly with:
//   npx tsx --test app/frontend/api/scanWallet.routeCheck.test.ts
//
// QSTASH/WORKER REMOVAL, DISCLOSED (explicit instruction: remove all QStash/worker/job-poll
// infrastructure without touching scanner logic): the job/poll suite that previously tested
// `scanWalletV2`'s background-job behavior (enqueue via /api/scan-v2/full-scan/start, poll
// /api/scan-v2/full-scan/status) is removed along with that system — those routes no longer exist.
// The suite that tested `scanWalletV2Legacy`'s direct-route behavior is kept, unchanged in
// substance, repointed at the renamed `scanWalletV2` (now the only exported scan function, per
// scanWallet.ts's own header).

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('scanWalletV2 (direct V2 route only, no job/poll, no QStash)', () => {
  it('calls only the V2 route (/api/scan-v2/full-scan/legacy) on success', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ success: true, data: { fromV2: true } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

      assert.equal(calls.length, 1)
      assert.equal(calls[0], '/api/scan-v2/full-scan/legacy')
      assert.ok(!calls.some((c) => c.includes('full-scan-job') || c.includes('scan-start') || c.includes('scan-status')), 'expected no job/poll route to ever be called')
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
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

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
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

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
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

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
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

      assert.equal(result.success, false)
      assert.equal(result.error?.message, 'goldrush_client_error: invalid api key', 'expected the REAL backend error message, not a generic "network-failed"')
      assert.equal(result.error?.category, 'unknown')
    } finally {
      global.fetch = originalFetch
    }
  })

  it('calls the same route for scanMode "deep" (no separate job-based Deep Scan path anymore)', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ success: true, data: { fromV2: true } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'deep')

      assert.equal(calls.length, 1)
      assert.equal(calls[0], '/api/scan-v2/full-scan/legacy')
      assert.equal(result.success, true)
    } finally {
      global.fetch = originalFetch
    }
  })
})

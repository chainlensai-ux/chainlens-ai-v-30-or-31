// Test for scanWalletV2's direct-V2-only behavior (app/frontend/api/scanWallet.ts). Uses node:test
// with a mocked global.fetch (no real network/dev-server dependency). NOT wired into `npm test`
// (which runs a single hardcoded file — see package.json). Run directly with:
//   npx tsx --test app/frontend/api/scanWallet.routeCheck.test.ts
//
// FALLBACK TESTS REMOVED, DISCLOSED: this file previously also tested a fallback to the V1 job
// route (/full-scan-job/start) on V2-route failure — that fallback was removed from scanWallet.ts
// per explicit instruction (see its own file header). Those tests are deleted here, not left
// asserting on code that no longer exists. The remaining tests lock in: the V2 route is the only
// route ever called, and a V2-route failure surfaces as a structured error instead of throwing or
// silently retrying anywhere else.

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('scanWalletV2 (direct V2 route only, no fallback)', () => {
  it('calls only the V2 route (/api/scan-v2/full-scan) on success', async () => {
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
      assert.equal(calls[0], '/api/scan-v2/full-scan')
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
})

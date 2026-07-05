// Test for scanWalletV2's route-swap + fallback behavior (app/frontend/api/scanWallet.ts). Uses
// node:test with a mocked global.fetch (no real network/dev-server dependency). NOT wired into
// `npm test` (which runs a single hardcoded file — see package.json). Run directly with:
//   npx tsx --test app/frontend/api/scanWallet.routeCheck.test.ts
//
// REGRESSION-RISK DISCLOSURE: this test locks in the literally-requested behavior (V2 route first,
// fall back to the V1 job route on failure) — see scanWallet.ts's own file header for why this
// specific behavior reintroduces a real risk (the synchronous V2 route is subject to Vercel's
// execution-time ceiling) that an earlier task in this session had deliberately fixed. Applied here
// on the requester's explicit, confirmed instruction after that risk was raised.

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('scanWalletV2 route selection', () => {
  it('detects and calls the V2 route (/api/scan-v2/full-scan) by default, not the V1 job route', async () => {
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
      assert.ok(!calls[0].includes('full-scan-job'), 'expected the V1 job route to NOT be called on the happy path')
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { fromV2: true })
    } finally {
      global.fetch = originalFetch
    }
  })

  it('falls back to the V1 job route when the V2 route fails (network error)', async () => {
    const calls: string[] = []
    const originalFetch = global.fetch
    global.fetch = mock.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/scan-v2/full-scan') {
        throw new Error('simulated network failure')
      }
      if (url === '/api/scan-v2/full-scan-job/start') {
        return new Response(JSON.stringify({ success: true, jobId: 'job-1', job: { status: 'done', success: true, data: { fromV1Job: true } } }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet')
      const result = await scanWalletV2('0xabc', ['base'], 'normal')

      assert.ok(calls.includes('/api/scan-v2/full-scan'), 'expected the V2 route to be attempted first')
      assert.ok(calls.includes('/api/scan-v2/full-scan-job/start'), 'expected fallback to the V1 job route')
      assert.equal(result.success, true)
      assert.deepEqual(result.data, { fromV1Job: true })
    } finally {
      global.fetch = originalFetch
    }
  })

  it('debug logs fire: route-check log before the call, warn on fallback, final-route log after', async () => {
    const originalFetch = global.fetch
    const debugCalls: unknown[][] = []
    const warnCalls: unknown[][] = []
    const originalDebug = console.debug
    const originalWarn = console.warn
    console.debug = (...args: unknown[]) => { debugCalls.push(args) }
    console.warn = (...args: unknown[]) => { warnCalls.push(args) }

    global.fetch = mock.fn(async (url: string) => {
      if (url === '/api/scan-v2/full-scan') throw new Error('simulated failure')
      return new Response(JSON.stringify({ success: true, jobId: 'job-2', job: { status: 'done', success: true, data: {} } }), { status: 200 })
    }) as unknown as typeof fetch

    try {
      const { scanWalletV2 } = await import('./scanWallet')
      await scanWalletV2('0xabc', ['base'], 'normal')

      assert.ok(debugCalls.some((c) => String(c[0]).includes('[RouteCheck] scanWalletV2 is calling:')))
      assert.ok(debugCalls.some((c) => String(c[0]).includes('[RouteCheck] Using V1 job route:')))
      assert.ok(warnCalls.some((c) => String(c[0]).includes('[RouteCheck] V2 route failed')))
      assert.ok(debugCalls.some((c) => String(c[0]).includes('[RouteCheck] Final route used:')))
    } finally {
      global.fetch = originalFetch
      console.debug = originalDebug
      console.warn = originalWarn
    }
  })
})

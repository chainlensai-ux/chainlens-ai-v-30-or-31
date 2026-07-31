// Regression test for the CU-leak audit fix: /api/test/alchemy-multichain previously had NEITHER a
// production admin gate NOR a rate limit, unlike its sibling /api/test/alchemy/route.ts — a public,
// unauthenticated route making a real Alchemy call. This confirms the fix without ever making a
// real network call (invalid chain / no API key configured in this sandbox short-circuits before
// fetch() would run).
//
// NOT wired into `npm test` by directory convention (matches
// app/api/admin/pool-provenance/route.test.ts). Run directly with:
//   npx tsx --test app/api/test/alchemy-multichain/route.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GET } from './route'

function req(headers: Record<string, string> = {}, chain = 'base'): Request {
  return new Request(`http://localhost/api/test/alchemy-multichain?chain=${chain}`, { headers })
}

function withNodeEnv<T>(value: string, fn: () => T): T {
  const env = process.env as { NODE_ENV: string }
  const original = env.NODE_ENV
  env.NODE_ENV = value
  try {
    return fn()
  } finally {
    env.NODE_ENV = original
  }
}

test('production without x-admin-secret is rejected 404, never reaches Alchemy', async () => {
  await withNodeEnv('production', async () => {
    const res = await GET(req())
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.deepEqual(body, { error: 'Not available' })
  })
})

test('production with a wrong x-admin-secret is still rejected 404', async () => {
  await withNodeEnv('production', async () => {
    const originalSecret = process.env.ADMIN_SECRET
    process.env.ADMIN_SECRET = 'real-secret'
    try {
      const res = await GET(req({ 'x-admin-secret': 'wrong' }))
      assert.equal(res.status, 404)
    } finally {
      if (originalSecret === undefined) delete process.env.ADMIN_SECRET
      else process.env.ADMIN_SECRET = originalSecret
    }
  })
})

// HARDENING, DISCLOSED (follow-up task): the CORRECT admin secret must no longer bypass production
// either — this route is now local-development-only with zero exception, never a live path to a
// real Alchemy call in production regardless of any header.
test('production with the CORRECT x-admin-secret is STILL rejected 404 -- no bypass exists anymore', async () => {
  await withNodeEnv('production', async () => {
    const originalSecret = process.env.ADMIN_SECRET
    process.env.ADMIN_SECRET = 'real-secret'
    try {
      const res = await GET(req({ 'x-admin-secret': 'real-secret' }))
      assert.equal(res.status, 404)
      const body = await res.json()
      assert.deepEqual(body, { error: 'Not available' })
    } finally {
      if (originalSecret === undefined) delete process.env.ADMIN_SECRET
      else process.env.ADMIN_SECRET = originalSecret
    }
  })
})

test('response always carries Cache-Control: no-store, even on the 404 path', async () => {
  await withNodeEnv('production', async () => {
    const res = await GET(req())
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
  })
})

test('an invalid chain is rejected 400 before any Alchemy call, in a non-production environment', async () => {
  await withNodeEnv('test', async () => {
    const res = await GET(req({}, 'not-a-real-chain'))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.ok, false)
  })
})

test('rate limiting: the 4th request within the window from the same IP is rejected 429', async () => {
  await withNodeEnv('test', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.55' }
    // First 3 requests use an invalid chain (400, cheap, never reaches Alchemy) purely to exercise
    // the rate limiter without depending on real API key configuration.
    await GET(req(headers, 'not-a-real-chain'))
    await GET(req(headers, 'not-a-real-chain'))
    await GET(req(headers, 'not-a-real-chain'))
    const fourth = await GET(req(headers, 'not-a-real-chain'))
    assert.equal(fourth.status, 429)
    const body = await fourth.json()
    assert.deepEqual(body, { error: 'Rate limited' })
  })
})

test('never returns HTML on any path', async () => {
  await withNodeEnv('production', async () => {
    const res = await GET(req())
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
  })
})

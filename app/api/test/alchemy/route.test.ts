// Regression test for the CU-leak audit hardening: /api/test/alchemy previously allowed a
// production bypass via x-admin-secret === ADMIN_SECRET — a live path to a real Alchemy call in
// production. This confirms it is now local-development-only with zero exception.
//
// NOT wired into `npm test` by directory convention (matches
// app/api/admin/pool-provenance/route.test.ts). Run directly with:
//   npx tsx --test app/api/test/alchemy/route.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { GET } from './route'

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/test/alchemy', { headers })
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

test('production without any header is rejected 404', async () => {
  await withNodeEnv('production', async () => {
    const res = await GET(req())
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.deepEqual(body, { error: 'Not available' })
  })
})

test('production with the CORRECT x-admin-secret is STILL rejected 404 -- the bypass is removed', async () => {
  await withNodeEnv('production', async () => {
    const originalSecret = process.env.ADMIN_SECRET
    process.env.ADMIN_SECRET = 'real-secret'
    try {
      const res = await GET(req({ 'x-admin-secret': 'real-secret' }))
      assert.equal(res.status, 404)
    } finally {
      if (originalSecret === undefined) delete process.env.ADMIN_SECRET
      else process.env.ADMIN_SECRET = originalSecret
    }
  })
})

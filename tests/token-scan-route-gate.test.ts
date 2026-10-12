// /api/token-scan spends paid historical-price calls and has no product caller: in production it is
// admin-only (same gate as /api/debug-engines) and has no wildcard CORS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { POST } from '../app/api/token-scan/route.ts'

const req = (headers: Record<string, string> = {}) => new Request('https://x.test/api/token-scan', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ chain: 'nope', tokenAddress: '0x1', timestamp: 1 }),
})
const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
  try { await fn() } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

test('production: no admin key header → 404 before any provider work', async () => {
  await withEnv({ NODE_ENV: 'production', CHAINLENS_ADMIN_KEY: 'k' }, async () => {
    assert.equal((await POST(req())).status, 404)
    assert.equal((await POST(req({ 'x-chainlens-admin': 'wrong' }))).status, 404)
  })
})

test('production without CHAINLENS_ADMIN_KEY configured → always 404', async () => {
  await withEnv({ NODE_ENV: 'production', CHAINLENS_ADMIN_KEY: undefined }, async () => {
    assert.equal((await POST(req({ 'x-chainlens-admin': '' }))).status, 404)
  })
})

test('production with the admin key reaches validation (unsupported chain → 400)', async () => {
  await withEnv({ NODE_ENV: 'production', CHAINLENS_ADMIN_KEY: 'k' }, async () => {
    assert.equal((await POST(req({ 'x-chainlens-admin': 'k' }))).status, 400)
  })
})

test('vercel.json no longer opens /api/token-scan to every origin', () => {
  const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { headers: Array<{ source: string }> }
  assert.equal(cfg.headers.some((h) => h.source.startsWith('/api/token-scan')), false)
})

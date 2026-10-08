import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getRuntimeIdentity } from '../lib/server/runtimeIdentity.ts'
import { GET } from '../app/api/health/route.ts'

const SHA = '5415d8601874f1761085926a13c10300d5e713f7'

test('runtimeCommitSha comes from VERCEL_GIT_COMMIT_SHA; VERCEL_ENV maps to the deployment environment', () => {
  assert.deepEqual(getRuntimeIdentity({ VERCEL_GIT_COMMIT_SHA: SHA, VERCEL_ENV: 'production' }), { runtimeCommitSha: SHA, vercelEnv: 'production', deploymentEnvironment: 'production' })
  assert.equal(getRuntimeIdentity({ VERCEL_GIT_COMMIT_SHA: SHA.toUpperCase(), VERCEL_ENV: 'preview' }).runtimeCommitSha, SHA)
  assert.equal(getRuntimeIdentity({ VERCEL_ENV: 'preview' }).deploymentEnvironment, 'preview')
})

test('missing or malformed values return null / unknown cleanly', () => {
  assert.deepEqual(getRuntimeIdentity({}), { runtimeCommitSha: null, vercelEnv: null, deploymentEnvironment: 'unknown' })
  assert.deepEqual(getRuntimeIdentity({ VERCEL_GIT_COMMIT_SHA: 'not-a-sha; rm -rf', VERCEL_ENV: 'staging' }), { runtimeCommitSha: null, vercelEnv: null, deploymentEnvironment: 'unknown' })
})

test('no other environment value is ever serialized', async () => {
  const secret = 'sk-live-should-never-appear'
  const env = { VERCEL_GIT_COMMIT_SHA: SHA, VERCEL_ENV: 'production', KV_REST_API_TOKEN: secret, BLOCKSCOUT_API_KEY: secret, GOLDRUSH_API_KEY: secret }
  const out = getRuntimeIdentity(env)
  assert.deepEqual(Object.keys(out).sort(), ['deploymentEnvironment', 'runtimeCommitSha', 'vercelEnv'])
  assert.ok(!JSON.stringify(out).includes(secret))

  // the real endpoint, with a secret in process.env
  const prev = { sha: process.env.VERCEL_GIT_COMMIT_SHA, env: process.env.VERCEL_ENV, tok: process.env.RUNTIME_IDENTITY_TEST_SECRET }
  process.env.VERCEL_GIT_COMMIT_SHA = SHA
  process.env.VERCEL_ENV = 'production'
  process.env.RUNTIME_IDENTITY_TEST_SECRET = secret
  try {
    const res = await GET()
    const body = await res.json()
    assert.deepEqual(body, { status: 'ok', runtimeCommitSha: SHA, vercelEnv: 'production', deploymentEnvironment: 'production' })
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.ok(!JSON.stringify(body).includes(secret))
  } finally {
    for (const [k, v] of [['VERCEL_GIT_COMMIT_SHA', prev.sha], ['VERCEL_ENV', prev.env], ['RUNTIME_IDENTITY_TEST_SECRET', prev.tok]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

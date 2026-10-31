import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GET } from '../app/api/cortex/history/route'

const URL = 'http://localhost/api/cortex/history?chain=base&contract=0xe34356dcd3d7bb991248f322e4ec31b5d60bc54e'

test('permanent account history requires authentication in production', async () => {
  const previous = process.env.VERCEL_ENV
  try {
    process.env.VERCEL_ENV = 'production'
    const response = await GET(new Request(URL))
    assert.equal(response.status, 401)
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previous
  }
})

test('CORTEX history requires authentication in Preview', async () => {
  const previousEnv = process.env.VERCEL_ENV
  const previousFlag = process.env.CORTEX_SCAN_MEMORY_ENABLED
  try {
    process.env.VERCEL_ENV = 'preview'
    process.env.CORTEX_SCAN_MEMORY_ENABLED = 'true'
    const response = await GET(new Request(URL))
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error, 'unauthorized')
  } finally {
    if (previousEnv === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnv
    if (previousFlag === undefined) delete process.env.CORTEX_SCAN_MEMORY_ENABLED
    else process.env.CORTEX_SCAN_MEMORY_ENABLED = previousFlag
  }
})

test('CORTEX history rejects invalid chains and addresses', async () => {
  const { __setAuthTokenVerifierForTest } = await import('../lib/server/requireAuth')
  const previousEnv = process.env.VERCEL_ENV
  const previousFlag = process.env.CORTEX_SCAN_MEMORY_ENABLED

  try {
    process.env.VERCEL_ENV = 'preview'
    process.env.CORTEX_SCAN_MEMORY_ENABLED = 'true'

    __setAuthTokenVerifierForTest(async () => ({
      userId: 'test-user',
      email: null,
      plan: 'free',
    }) as any)

    for (const params of [
      'chain=solana&contract=0xe34356dcd3d7bb991248f322e4ec31b5d60bc54e',
      'chain=base&contract=not-an-address',
    ]) {
      const response = await GET(new Request(
        `http://localhost/api/cortex/history?${params}`,
        { headers: { Authorization: 'Bearer test-token' } }
      ))
      assert.equal(response.status, 400)
    }
  } finally {
    __setAuthTokenVerifierForTest(null)
    if (previousEnv === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnv
    if (previousFlag === undefined) delete process.env.CORTEX_SCAN_MEMORY_ENABLED
    else process.env.CORTEX_SCAN_MEMORY_ENABLED = previousFlag
  }
})

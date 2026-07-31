import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDevOnlyProviderRouteAllowed, devOnlyProviderRouteBlockedResponse } from './devOnlyProviderRoute'

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

test('production is never allowed', () => {
  withNodeEnv('production', () => {
    assert.equal(isDevOnlyProviderRouteAllowed(), false)
  })
})

test('development is allowed', () => {
  withNodeEnv('development', () => {
    assert.equal(isDevOnlyProviderRouteAllowed(), true)
  })
})

test('test env is allowed (treated as non-production)', () => {
  withNodeEnv('test', () => {
    assert.equal(isDevOnlyProviderRouteAllowed(), true)
  })
})

test('the blocked response is a 404, no-store, honest error -- never HTML', () => {
  const res = devOnlyProviderRouteBlockedResponse()
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
})

test('the blocked response body matches the existing production-block convention exactly', async () => {
  const res = devOnlyProviderRouteBlockedResponse()
  const body = await res.json()
  assert.deepEqual(body, { error: 'Not available' })
})

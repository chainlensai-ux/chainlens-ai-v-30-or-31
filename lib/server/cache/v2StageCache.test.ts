// Tests for lib/server/cache/v2StageCache.ts's dev-only KV warm mode. Uses node:test, same
// convention as the other module test files this session. Only tests resolveEffectiveTtl() in
// isolation (a pure function) rather than withStageCache() itself, since the latter depends on a
// real KV client this sandbox has no credentials for — testing the pure TTL-selection logic
// directly avoids needing to mock that client while still covering the actual behavior change.
// Run directly with:
//   npx tsx --test lib/server/cache/v2StageCache.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTtl } from './v2StageCache'

describe('resolveEffectiveTtl — production behavior unchanged', () => {
  it('returns the caller-supplied ttlSeconds exactly, untouched, when NODE_ENV is production', () => {
    assert.equal(resolveEffectiveTtl(30, 'production'), 30)
    assert.equal(resolveEffectiveTtl(45, 'production'), 45)
    assert.equal(resolveEffectiveTtl(5, 'production'), 5) // even a tiny TTL is never widened in prod
  })
})

describe('resolveEffectiveTtl — dev-only KV warm mode', () => {
  it('widens a short TTL to 600s (10 minutes) when NODE_ENV is not production', () => {
    assert.equal(resolveEffectiveTtl(30, 'development'), 600)
    assert.equal(resolveEffectiveTtl(45, 'test'), 600)
    assert.equal(resolveEffectiveTtl(30, undefined), 600)
  })

  it('never shrinks a TTL that is already longer than 10 minutes outside production', () => {
    assert.equal(resolveEffectiveTtl(3600, 'development'), 3600)
  })
})

describe('resolveEffectiveTtl — determinism', () => {
  it('is pure — same input always produces the same output', () => {
    assert.equal(resolveEffectiveTtl(30, 'development'), resolveEffectiveTtl(30, 'development'))
  })
})

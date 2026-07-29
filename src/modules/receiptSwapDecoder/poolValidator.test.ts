import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tryClassicStableVariants } from './poolValidator'

const POOL = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const OTHER_POOL = '0x9999999999999999999999999999999999999999'

// AUDIT FIX, DISCLOSED: production evidence — the Aerodrome Classic factory validator previously
// hardcoded stable=false only, so a real, exact swap through the pair's STABLE pool would always
// fail validation and fall closed to inference, even though the pool is 100% real and canonical.
// This regression test proves the fix without a live RPC client.

test('a stable-pool match is found on the second (stable=true) attempt when volatile does not match', async () => {
  const calls: boolean[] = []
  const fetchPool = async (stable: boolean) => {
    calls.push(stable)
    return stable ? POOL : ZERO
  }
  const result = await tryClassicStableVariants(fetchPool, POOL)
  assert.equal(result, true)
  assert.deepEqual(calls, [false, true])
})

test('a volatile-pool match short-circuits on the first attempt -- stable=true is never called', async () => {
  const calls: boolean[] = []
  const fetchPool = async (stable: boolean) => {
    calls.push(stable)
    return stable ? OTHER_POOL : POOL
  }
  const result = await tryClassicStableVariants(fetchPool, POOL)
  assert.equal(result, true)
  assert.deepEqual(calls, [false])
})

test('neither variant matching returns false after trying exactly both keys, never more', async () => {
  const calls: boolean[] = []
  const fetchPool = async (stable: boolean) => {
    calls.push(stable)
    return ZERO
  }
  const result = await tryClassicStableVariants(fetchPool, POOL)
  assert.equal(result, false)
  assert.deepEqual(calls, [false, true])
})

test('address comparison is case-insensitive', async () => {
  const fetchPool = async (stable: boolean) => (stable ? POOL.toUpperCase() : ZERO)
  const result = await tryClassicStableVariants(fetchPool, POOL.toLowerCase())
  assert.equal(result, true)
})

test('a non-string/undefined return for a given key is never mistaken for a match', async () => {
  const fetchPool = async () => undefined
  const result = await tryClassicStableVariants(fetchPool, POOL)
  assert.equal(result, false)
})

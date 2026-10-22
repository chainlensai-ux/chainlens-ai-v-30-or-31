import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { EXTRA_SLIPSTREAM_FACTORIES_ENV, listedExtraSlipstreamFactories, tryClassicStableVariants, validateByListedSlipstreamFactory } from './poolValidator'

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

describe('operator-listed Slipstream factories', () => {
  // Production 0xd40e…b811: pools 0x160d7e9d…/0x3fe04a59… report factory 0xf8f2eb49…, not the canonical one.
  const FACTORY = '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef'
  const POOL = '0x3fe04a59ebd38cf06080a6f60a98d124eb59392a'
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const WETH = '0x4200000000000000000000000000000000000006'
  const reads = (returned: string | null) => ({
    poolTickSpacing: async () => 100,
    factoryGetPool: async (_f: string, _a: string, _b: string, ts: number) => (ts === 100 ? returned : null),
  })

  it('reads the env list, ignoring malformed entries', () => {
    const listed = listedExtraSlipstreamFactories({ [EXTRA_SLIPSTREAM_FACTORIES_ENV]: ` ${FACTORY.toUpperCase().replace('0X', '0x')} , nope, 0x12 ` })
    assert.deepEqual([...listed], [FACTORY])
    assert.equal(listedExtraSlipstreamFactories({}).size, 0)
  })

  it('an unlisted factory never validates, even when it vouches for the pool', async () => {
    assert.equal(await validateByListedSlipstreamFactory(reads(POOL), FACTORY, POOL, USDC, WETH, new Set()), false)
  })

  it('a listed factory validates only when it returns this exact pool for the pool\'s tick spacing', async () => {
    const listed = new Set([FACTORY])
    const attempts: Array<{ key: string; returnedPool: string | null }> = []
    assert.equal(await validateByListedSlipstreamFactory(reads(POOL), FACTORY, POOL, USDC, WETH, listed, attempts), true)
    assert.equal(attempts[0].key, 'listedFactory.getPool(tickSpacing=100)')
    assert.equal(await validateByListedSlipstreamFactory(reads('0x0000000000000000000000000000000000000001'), FACTORY, POOL, USDC, WETH, listed), false)
    assert.equal(await validateByListedSlipstreamFactory({ ...reads(POOL), poolTickSpacing: async () => null }, FACTORY, POOL, USDC, WETH, listed), false)
  })
})

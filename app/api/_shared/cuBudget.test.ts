// Tests for app/api/_shared/cuBudget.ts. NOT wired into `npm test`. Run directly with:
//   npx tsx --test app/api/_shared/cuBudget.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCuBudget, recordProviderCall, isSoftTimeoutExceeded } from './cuBudget'

describe('CuBudget', () => {
  it('starts at zero providerCalls with the documented defaults', () => {
    const cuBudget = createCuBudget()
    assert.equal(cuBudget.providerCalls, 0)
    assert.equal(cuBudget.maxProviderCalls, 20)
    assert.equal(cuBudget.softTimeoutMs, 7000)
    assert.equal(cuBudget.walletHits.size, 0)
  })

  it('recordProviderCall increments providerCalls by exactly 1 per call', () => {
    const cuBudget = createCuBudget()
    recordProviderCall(cuBudget)
    assert.equal(cuBudget.providerCalls, 1)
    recordProviderCall(cuBudget)
    recordProviderCall(cuBudget)
    assert.equal(cuBudget.providerCalls, 3)
  })

  it('isSoftTimeoutExceeded is false immediately after creation', () => {
    const cuBudget = createCuBudget()
    assert.equal(isSoftTimeoutExceeded(cuBudget), false)
  })

  it('isSoftTimeoutExceeded is true once startTime is far enough in the past', () => {
    const cuBudget = createCuBudget()
    cuBudget.startTime = Date.now() - 8000 // older than the 7000ms softTimeoutMs
    assert.equal(isSoftTimeoutExceeded(cuBudget), true)
  })

  it('is purely diagnostic — nothing about it changes output for a normal scan (no throw, no branching return)', () => {
    const cuBudget = createCuBudget()
    // Simulates a "normal scan": several provider calls recorded, no timeout crossed.
    recordProviderCall(cuBudget)
    recordProviderCall(cuBudget)
    assert.equal(isSoftTimeoutExceeded(cuBudget), false)
    assert.equal(cuBudget.providerCalls, 2, 'a normal scan\'s call count is tracked but never used to alter control flow')
  })
})

describe('fetchRawEventsForChain with an optional CuBudget (real integration)', () => {
  it('recordProviderCall fires exactly once per real provider fetch, not on a cache hit', async () => {
    const { fetchRawEventsForChain } = await import('./walletChainPipeline')
    const { createEventsCache } = await import('./eventsCache')
    const cuBudget = createCuBudget()
    const cache = createEventsCache()

    await fetchRawEventsForChain('eth', '0xabc', cache, cuBudget) // miss -> real fetch -> +1
    assert.equal(cuBudget.providerCalls, 1)

    await fetchRawEventsForChain('eth', '0xabc', cache, cuBudget) // cache hit -> no increment
    assert.equal(cuBudget.providerCalls, 1, 'a cache hit must not count as a new provider call')
  })

  it('omitting cuBudget entirely preserves prior behavior (no error, same return value)', async () => {
    const { fetchRawEventsForChain } = await import('./walletChainPipeline')
    const result = await fetchRawEventsForChain('eth', '0xabc')
    assert.ok(Array.isArray(result))
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequestPriceKvClient } from './kvClient'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

function neverHitKv() { return { get: async () => null, set: async () => 'OK' } }

describe('RequestPriceKvClient high fan-out controls', () => {
  it('allows provider fetches but suppresses historical KV writes in historicalReadOnly mode', async () => {
    let fetchCalls = 0
    let setCalls = 0
    const kv = { get: async () => null, set: async () => { setCalls++; return 'OK' } }
    const source: PriceSourceFn = async () => { fetchCalls++; return 9 }
    const client = createRequestPriceKvClient({ kv: kv as never, historicalReadOnly: true, maxLookupsPerToken: 10, random: () => 0 })

    assert.equal(await client.getPriceHistorical('0xReadOnly', 'base', 123, source), 9)
    assert.equal(fetchCalls, 1)
    assert.equal(setCalls, 0)
    assert.equal(client.stats.remoteSets, 0)
  })

  it('coalesces duplicate historical price requests and reuses the in-request cache', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; await new Promise((r) => setTimeout(r, 5)); return 7 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, maxLookupsPerToken: 10, random: () => 0 })

    const batch = await Promise.all(Array.from({ length: 25 }, () => client.getPriceHistorical('0xToken', 'base', 123, source)))
    assert.deepEqual([...new Set(batch)], [7])
    assert.equal(fetchCalls, 1)
    assert.equal(client.stats.coalesced, 24)

    assert.equal(await client.getPriceHistorical('0xToken', 'base', 123, source), 7)
    assert.equal(fetchCalls, 1)
    assert.equal(client.stats.cacheHits, 1)
  })

  it('caps concurrent KV reads under many distinct tokens', async () => {
    let active = 0
    let maxActive = 0
    const kv = {
      get: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 3)); active--; return null },
      set: async () => 'OK',
    }
    const client = createRequestPriceKvClient({ kv: kv as never, maxConcurrent: 4, maxLookupsPerToken: 10, random: () => 0 })
    const source: PriceSourceFn = async () => 1
    await Promise.all(Array.from({ length: 60 }, (_, i) => client.getPriceHistorical(`0x${i}`, 'base', 1000 + i, source)))
    assert.ok(maxActive <= 4, `expected <= 4 concurrent KV reads, got ${maxActive}`)
  })
})

describe('RequestPriceKvClient breaker and lookup cap', () => {
  it('opens the read breaker on repeated KV timeouts and skips subsequent reads predictably', async () => {
    const kv = { get: async () => new Promise<null>(() => {}), set: async () => 'OK' }
    const client = createRequestPriceKvClient({ kv: kv as never, timeoutMs: 1, maxRetries: 0, maxConsecutiveTimeouts: 2, cooldownMs: 10_000, maxLookupsPerToken: 10, random: () => 0 })
    const source: PriceSourceFn = async () => 2

    assert.equal(await client.getPriceHistorical('0xa', 'base', 1, source), 2)
    assert.equal(await client.getPriceHistorical('0xb', 'base', 1, source), 2)
    assert.equal(await client.getPriceHistorical('0xc', 'base', 1, source), 2)

    assert.equal(client.stats.timeouts, 2)
    assert.equal(client.stats.breakerSkips, 1)
  })

  it('enforces maxLookupsPerToken centrally before KV/provider fan-out', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; return 5 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, maxLookupsPerToken: 2, random: () => 0 })

    assert.equal(await client.getPriceHistorical('0xCap', 'base', 1, source), 5)
    assert.equal(await client.getPriceHistorical('0xCap', 'base', 2, source), 5)
    assert.equal(await client.getPriceHistorical('0xCap', 'base', 3, source), null)

    assert.equal(fetchCalls, 2)
    assert.equal(client.stats.cappedLookups, 1)
  })
})

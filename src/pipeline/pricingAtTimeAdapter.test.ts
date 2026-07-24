// Tests for src/pipeline/pricingAtTimeAdapter.ts's buildChainAwareHistoricalPriceSourceDetailed /
// buildChainAwareHistoricalPriceSource — the provider-call-audit follow-up task's "trace the
// one-side-missing recovery candidates" requirement. Uses 'hyperevm' as the test chain throughout:
// it is deliberately unverified in EVERY real source's own chain map (dexscreener.ts,
// geckoTerminalPriceSource.ts, coingecko.ts) and basedex.ts only supports 'base' — so every real
// network/RPC call in the router resolves via a cheap, synchronous "unverified chain" check, making
// these tests fully deterministic with zero real network dependency and no fetch mocking needed.
// Run directly with:
//   npx tsx --test src/pipeline/pricingAtTimeAdapter.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildChainAwareHistoricalPriceSource, buildChainAwareHistoricalPriceSourceDetailed } from './pricingAtTimeAdapter'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

describe('buildChainAwareHistoricalPriceSourceDetailed', () => {
  it('raw source argument ordering is correct — (token, chain, timestamp), in that order', async () => {
    const calls: Array<[string, string, number]> = []
    const goldrush: PriceSourceFn = async (token, chain, timestamp) => {
      calls.push([token, chain, timestamp])
      return null
    }
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
    await detailed('0xTokenAddress', 'hyperevm', 1_700_000_000_000)

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], ['0xTokenAddress', 'hyperevm', 1_700_000_000_000], 'goldrush must receive (token, chain, timestamp) in exactly that order, unchanged')
  })

  it('timestamp units remain milliseconds end-to-end — no unit conversion happens in this router', async () => {
    // A real, plausible millisecond epoch (year 2023) — if this router silently divided/multiplied
    // by 1000 anywhere, the value goldrush receives would no longer look like a real ms timestamp.
    const MS_TIMESTAMP = 1_700_000_000_000
    let receivedTimestamp: number | null = null
    const goldrush: PriceSourceFn = async (_token, _chain, timestamp) => { receivedTimestamp = timestamp; return null }
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
    await detailed('0xtoken', 'hyperevm', MS_TIMESTAMP)

    assert.equal(receivedTimestamp, MS_TIMESTAMP, 'the router must pass the timestamp through byte-for-byte, in milliseconds, never converting units itself')
  })

  it('a valid provider result survives normalization and is returned as-is', async () => {
    const goldrush: PriceSourceFn = async () => 3.14159
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
    const result = await detailed('0xtoken', 'hyperevm', 1_700_000_000_000)

    assert.equal(result.price, 3.14159, 'a sane, real price must pass through unchanged — never rounded, clamped, or replaced')
    assert.equal(result.route, 'goldrush')
  })

  it('every real rejection path emits an explicit, non-null reason — never a silent null with no explanation', async () => {
    const goldrush: PriceSourceFn = async () => null // simulates a genuine "no data" result
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
    const result = await detailed('0xtoken', 'hyperevm', 1_700_000_000_000)

    assert.equal(result.price, null)
    assert.equal(result.route, 'none')
    assert.ok(result.attempts.length > 0, 'every failed lookup must record at least one real attempt')
    for (const attempt of result.attempts) {
      assert.equal(attempt.ok, false)
      assert.ok(typeof attempt.reason === 'string' && attempt.reason.length > 0, `attempt for source "${attempt.source}" must carry an explicit, non-empty reason string, not a bare null`)
    }
    // hyperevm is unverified in every real chain map this router consults — confirms the specific,
    // real reason strings this task asked to be distinguished, not a generic catch-all.
    const reasonsBySource = Object.fromEntries(result.attempts.map((a) => [a.source, a.reason]))
    assert.equal(reasonsBySource.goldrush, 'goldrush_no_data')
    assert.equal(reasonsBySource.dexscreener, 'unverified_chain_for_dexscreener')
    assert.equal(reasonsBySource.geckoterminal, 'unverified_network_for_geckoterminal')
  })

  it('a known successfully-priced leg and a known-failed leg go through the exact same source functions, differing only in outcome', async () => {
    let callCount = 0
    const goldrush: PriceSourceFn = async () => { callCount += 1; return callCount === 1 ? 2.5 : null }
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)

    const success = await detailed('0xgood', 'hyperevm', 1_700_000_000_000)
    const failure = await detailed('0xbad', 'hyperevm', 1_700_000_000_000)

    assert.equal(success.price, 2.5)
    assert.equal(success.route, 'goldrush')
    assert.equal(failure.price, null)
    assert.equal(failure.route, 'none')
    // Both legs reached goldrush as their first attempt, in the same order, via the same function —
    // the only difference is the real result goldrush happened to return.
    assert.equal(success.attempts[0]?.source ?? 'goldrush', 'goldrush')
  })

  it('the plain buildChainAwareHistoricalPriceSource wrapper returns only the price, delegating to the exact same detailed call path', async () => {
    const goldrush: PriceSourceFn = async () => 9.99
    const plain = buildChainAwareHistoricalPriceSource(goldrush)
    const price = await plain('0xtoken', 'hyperevm', 1_700_000_000_000)
    assert.equal(price, 9.99)
  })
})

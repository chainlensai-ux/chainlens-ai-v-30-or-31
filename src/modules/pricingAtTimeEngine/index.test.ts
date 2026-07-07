// Tests for resolvePricingAtTime's concurrency cap (src/modules/pricingAtTimeEngine/index.ts),
// added for the real-CU-fix task. NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/index.test.ts

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePricingAtTime, type PriceableEntry, type PriceSourceFn } from './index'

function makeEntries(count: number): PriceableEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    txHash: `tx-${i}`,
    token: '0xabc',
    chain: 'base',
    timestamp: Date.now(),
    amount: '1',
  }))
}

describe('resolvePricingAtTime concurrency cap', () => {
  it('never runs more than 15 concurrent price-source calls at once', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const trackingSource: PriceSourceFn = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
      return 1
    }

    await resolvePricingAtTime({
      buyEntries: makeEntries(60),
      sellEntries: [],
      priceSources: { primary: trackingSource, fallback: trackingSource },
    })

    assert.ok(maxConcurrent <= 15, `expected max concurrency <= 15, got ${maxConcurrent}`)
  })

  it('still resolves every entry correctly under the concurrency cap (no dropped/misordered results)', async () => {
    const source: PriceSourceFn = async (token) => (token === '0xabc' ? 2 : null)

    const result = await resolvePricingAtTime({
      buyEntries: makeEntries(30),
      sellEntries: [],
      priceSources: { primary: source, fallback: source },
    })

    assert.equal(Object.keys(result.costUsd).length, 30)
    for (const key of Object.keys(result.costUsd)) {
      assert.equal(result.costUsd[key], 2)
    }
  })
})

describe('resolvePricingAtTime distinct-token ratio logging', () => {
  it('reports a high avgLookupsPerToken when the same token repeats many times', async () => {
    const source: PriceSourceFn = async () => 1
    const warnMock = mock.method(console, 'warn', () => {})
    try {
      // All 20 entries use the same token ('0xabc', per makeEntries) -> 1 distinct token, 20 lookups.
      await resolvePricingAtTime({
        buyEntries: makeEntries(20),
        sellEntries: [],
        priceSources: { primary: source, fallback: source },
      })
    } finally {
      warnMock.mock.restore()
    }
    const ratioCall = warnMock.mock.calls.find((c) => c.arguments[0] === '[RPC-INVESTIGATION] pricingAtTimeEngine distinct-token ratio')
    assert.ok(ratioCall, 'expected the distinct-token ratio log to have fired')
    const payload = ratioCall!.arguments[1] as { totalEntries: number; distinctTokens: number; avgLookupsPerToken: number }
    assert.equal(payload.totalEntries, 20)
    assert.equal(payload.distinctTokens, 1)
    assert.equal(payload.avgLookupsPerToken, 20)
  })

  it('reports avgLookupsPerToken of 1 when every entry is a genuinely distinct token', async () => {
    const source: PriceSourceFn = async () => 1
    const distinctEntries: PriceableEntry[] = Array.from({ length: 10 }, (_, i) => ({
      txHash: `tx-${i}`,
      token: `0x${i}`,
      chain: 'base',
      timestamp: Date.now(),
      amount: '1',
    }))

    const warnMock = mock.method(console, 'warn', () => {})
    try {
      await resolvePricingAtTime({
        buyEntries: distinctEntries,
        sellEntries: [],
        priceSources: { primary: source, fallback: source },
      })
    } finally {
      warnMock.mock.restore()
    }
    const ratioCall = warnMock.mock.calls.find((c) => c.arguments[0] === '[RPC-INVESTIGATION] pricingAtTimeEngine distinct-token ratio')
    const payload = ratioCall!.arguments[1] as { totalEntries: number; distinctTokens: number; avgLookupsPerToken: number }
    assert.equal(payload.totalEntries, 10)
    assert.equal(payload.distinctTokens, 10)
    assert.equal(payload.avgLookupsPerToken, 1)
  })
})

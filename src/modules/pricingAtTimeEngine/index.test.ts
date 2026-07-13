// Tests for resolvePricingAtTime's concurrency cap (src/modules/pricingAtTimeEngine/index.ts),
// added for the real-CU-fix task. NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/index.test.ts

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePricingAtTime, resolveMaxLookupsPerToken, type PriceableEntry, type PriceSourceFn } from './index'

function makeEntries(count: number): PriceableEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    txHash: `tx-${i}`,
    token: '0xabc',
    chain: 'base',
    timestamp: Date.now(),
    amount: '1',
  }))
}

// PER-TOKEN LOOKUP CAP, DISCLOSED: makeEntries() above (all same token '0xabc') is now exactly what
// the new per-token cap throttles — beyond MAX_LOOKUPS_PER_TOKEN_DEFAULT (2) real lookups of the
// same token, later entries are intentionally left unpriced. Tests below that want every entry
// genuinely priced use DISTINCT tokens instead, so the cap never engages and the concurrency
// behavior under test stays isolated from the new capping behavior.
function makeDistinctTokenEntries(count: number): PriceableEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    txHash: `tx-${i}`,
    token: `0xtoken${i}`,
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
    const source: PriceSourceFn = async () => 2

    const result = await resolvePricingAtTime({
      buyEntries: makeDistinctTokenEntries(30), // distinct tokens — the per-token cap never engages
      sellEntries: [],
      priceSources: { primary: source, fallback: source },
    })

    assert.equal(Object.keys(result.costUsd).length, 30)
    for (const key of Object.keys(result.costUsd)) {
      assert.equal(result.costUsd[key], 2)
    }
  })
})

describe('resolvePricingAtTime per-token lookup cap', () => {
  it('resolveMaxLookupsPerToken returns 2 by default, 1 when distinctTokenCount > 120', () => {
    assert.equal(resolveMaxLookupsPerToken(1), 2)
    assert.equal(resolveMaxLookupsPerToken(120), 2)
    assert.equal(resolveMaxLookupsPerToken(121), 1)
    assert.equal(resolveMaxLookupsPerToken(500), 1)
  })

  it('caps a heavily-repeated single token at 2 real lookups, leaving later entries unpriced (never fabricated)', async () => {
    let realCalls = 0
    const source: PriceSourceFn = async () => { realCalls += 1; return 5 }

    const result = await resolvePricingAtTime({
      buyEntries: makeEntries(10), // all the same token — makeEntries()'s literal purpose now
      sellEntries: [],
      priceSources: { primary: source, fallback: source },
    })

    assert.equal(realCalls, 2, 'expected only 2 real price-source calls for the repeated token')
    const pricedCount = Object.values(result.costUsd).filter((v) => v === 5).length
    const unpricedCount = Object.values(result.costUsd).filter((v) => v === null).length
    assert.equal(pricedCount, 2)
    assert.equal(unpricedCount, 8)
    assert.equal(result.evidenceMissingCount, 8) // capped entries count as missing, never a fabricated reused price
  })

  it('distinct tokens are each capped independently — no cross-token interference', async () => {
    const source: PriceSourceFn = async () => 7
    const entriesTokenA = makeEntries(3) // token '0xabc', all default txHashes
    const entriesTokenB: PriceableEntry[] = Array.from({ length: 3 }, (_, i) => ({
      txHash: `tx-b-${i}`, token: '0xdef', chain: 'base', timestamp: Date.now(), amount: '1',
    }))

    const result = await resolvePricingAtTime({
      buyEntries: [...entriesTokenA, ...entriesTokenB],
      sellEntries: [],
      priceSources: { primary: source, fallback: source },
    })

    const pricedCount = Object.values(result.costUsd).filter((v) => v === 7).length
    assert.equal(pricedCount, 4) // 2 from token A + 2 from token B, each capped independently
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

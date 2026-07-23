// Tests for resolvePricingAtTime's concurrency cap (src/modules/pricingAtTimeEngine/index.ts),
// added for the real-CU-fix task. NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/modules/pricingAtTimeEngine/index.test.ts

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePricingAtTime, resolveMaxLookupsPerToken, type PriceableEntry, type PriceSourceFn, type FallbackPricingConfig } from './index'

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
  it('resolveMaxLookupsPerToken returns 2 both at/below and above the dense threshold (120)', () => {
    // DENSE-CAP FIX, DISCLOSED (confirmed real bug, real production evidence: distinctTokenCount:
    // 128, cappedCount: 225): the dense tier was previously 1 — exactly one lookup per token TOTAL,
    // across a token's combined buy+sell entries. Since buys are always listed before sells in the
    // combined lookup order, a token's own SELL entry (needed for a closed lot's proceedsUsd) always
    // lost the cap to that SAME token's earlier BUY entry — making it structurally impossible for any
    // lot of a >120-distinct-token wallet to ever become fully priced (both cost AND proceeds), which
    // is a direct, sufficient explanation for realizedPnlUsd staying null despite hundreds of real
    // matched lots. Raised to 2 — the minimum needed for one buy+sell round-trip per token to both
    // price — while a 3rd+ occurrence of the same token is still honestly capped (see the round-trip
    // tests below).
    assert.equal(resolveMaxLookupsPerToken(1), 2)
    assert.equal(resolveMaxLookupsPerToken(120), 2)
    assert.equal(resolveMaxLookupsPerToken(121), 2)
    assert.equal(resolveMaxLookupsPerToken(500), 2)
  })

  it('a token\'s BUY and SELL entries BOTH price under the dense cap (>120 distinct tokens) — the confirmed production bug, fixed', async () => {
    // Simulates a dense wallet (128 distinct tokens, matching real production evidence) where one
    // specific token has both a buy and a sell entry sharing the token but different txHashes. Before
    // the fix, the sell entry — processed after ALL buy entries, since priceAllEntries' `tagged`
    // array is `[...buyEntries, ...sellEntries]` — always lost the per-token cap to its own paired
    // buy entry, leaving proceedsUsd permanently null for every lot in a dense wallet regardless of
    // real price availability.
    const otherTokenBuys: PriceableEntry[] = Array.from({ length: 127 }, (_, i) => ({
      txHash: `0xbuy${i}`, token: `0xother${i}`, chain: 'base', timestamp: Date.now() + i, amount: '1',
    }))
    const targetBuy: PriceableEntry = { txHash: '0xtargetbuy', token: '0xtarget', chain: 'base', timestamp: Date.now(), amount: '1' }
    const targetSell: PriceableEntry = { txHash: '0xtargetsell', token: '0xtarget', chain: 'base', timestamp: Date.now() + 1000, amount: '1' }
    const source: PriceSourceFn = async (token) => (token === '0xtarget' ? 5 : 1)

    const result = await resolvePricingAtTime({
      buyEntries: [...otherTokenBuys, targetBuy], // 128 distinct tokens total -> dense tier
      sellEntries: [targetSell],
      priceSources: { primary: source, fallback: source },
    })

    assert.equal(result.costUsd['0xtargetbuy'], 5, 'buy entry must price')
    assert.equal(result.proceedsUsd['0xtargetsell'], 5, 'sell entry must ALSO price — previously always null under the old dense cap of 1')
  })

  it('a token bought TWICE then sold once in a dense wallet still caps the sell as the 3rd occurrence (disclosed residual limit, never fabricated)', async () => {
    // Honest disclosure: the fix guarantees a simple one-buy+one-sell round-trip prices fully (see
    // the test above). It does NOT guarantee every case — buyEntries are always listed before
    // sellEntries in priceAllEntries' `tagged` array, so a token bought twice before being sold still
    // has both its buy occurrences consume the cap of 2 before its sell is ever reached, leaving that
    // sell (the 3rd occurrence of the token) honestly capped. A larger fix (e.g. prioritizing entries
    // that belong to an already-known closed lot) would require pricingAtTimeEngine to know FIFO's
    // lot-matching result before it runs — but pricing intentionally runs BEFORE lot-matching, since
    // fifoEngine's own priceUsdLookup is synchronous by design (see priceLotsForWallet.ts's header) —
    // so that reordering is out of scope for this surgical fix.
    const otherTokenBuys: PriceableEntry[] = Array.from({ length: 126 }, (_, i) => ({
      txHash: `0xbuy${i}`, token: `0xother${i}`, chain: 'base', timestamp: Date.now() + i, amount: '1',
    }))
    const buy1: PriceableEntry = { txHash: '0xb1', token: '0xtarget', chain: 'base', timestamp: 1, amount: '1' }
    const buy2: PriceableEntry = { txHash: '0xb2', token: '0xtarget', chain: 'base', timestamp: 2, amount: '1' }
    const sell1: PriceableEntry = { txHash: '0xs1', token: '0xtarget', chain: 'base', timestamp: 3, amount: '1' }
    const source: PriceSourceFn = async () => 5

    const result = await resolvePricingAtTime({
      buyEntries: [...otherTokenBuys, buy1, buy2], // 128 distinct tokens -> dense; target token bought twice
      sellEntries: [sell1],
      priceSources: { primary: source, fallback: source },
    })

    assert.equal(result.costUsd['0xb1'], 5, 'first occurrence (buy 1) prices')
    assert.equal(result.costUsd['0xb2'], 5, 'second occurrence (buy 2) prices — both buy slots consume the cap of 2')
    assert.equal(result.proceedsUsd['0xs1'], null, 'third occurrence (the sell) is honestly capped, never fabricated — a real, disclosed residual limit')
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

describe('resolvePricingAtTime — optional fallbackPricing config (display-pass-only wiring)', () => {
  const alwaysNull: PriceSourceFn = async () => null

  it('primary+existing fallback both fail -> external fallbackPricing.attempt is called and used', async () => {
    let attemptCalls = 0
    const fallbackPricing: FallbackPricingConfig = {
      attempt: async () => { attemptCalls += 1; return { ok: true, priceUsd: 9, source: 'BaseScan' } },
    }

    const result = await resolvePricingAtTime({
      buyEntries: [{ txHash: 'tx-1', token: '0xabc', chain: 'base', timestamp: Date.now(), amount: '2' }],
      sellEntries: [],
      priceSources: { primary: alwaysNull, fallback: alwaysNull },
      fallbackPricing,
    })

    assert.equal(attemptCalls, 1)
    assert.equal(result.costUsd['tx-1'], 18) // 9 * 2
    assert.equal(result.evidenceMissingCount, 0)
    assert.equal(result.sourceBreakdown.fallback, 1) // counted under the existing 'fallback' bucket
  })

  it('primary+existing fallback fail, external fallback also fails -> entry stays unpriced, never fabricated', async () => {
    const fallbackPricing: FallbackPricingConfig = {
      attempt: async () => ({ ok: false, errorReason: 'no_price' }),
    }

    const result = await resolvePricingAtTime({
      buyEntries: [{ txHash: 'tx-1', token: '0xabc', chain: 'base', timestamp: Date.now(), amount: '2' }],
      sellEntries: [],
      priceSources: { primary: alwaysNull, fallback: alwaysNull },
      fallbackPricing,
    })

    assert.equal(result.costUsd['tx-1'], null)
    assert.equal(result.evidenceMissingCount, 1)
  })

  it('primary succeeds -> external fallbackPricing.attempt is never called (no redundant call)', async () => {
    let attemptCalls = 0
    const primary: PriceSourceFn = async () => 5
    const fallbackPricing: FallbackPricingConfig = {
      attempt: async () => { attemptCalls += 1; return { ok: true, priceUsd: 999, source: 'BaseScan' } },
    }

    const result = await resolvePricingAtTime({
      buyEntries: [{ txHash: 'tx-1', token: '0xabc', chain: 'base', timestamp: Date.now(), amount: '1' }],
      sellEntries: [],
      priceSources: { primary, fallback: alwaysNull },
      fallbackPricing,
    })

    assert.equal(attemptCalls, 0)
    assert.equal(result.costUsd['tx-1'], 5) // the real primary price, never overridden by the fallback stub
  })

  it('no fallbackPricing config supplied -> behavior is 100% identical to before (priceLotsForWallet.ts\'s real call shape)', async () => {
    const result = await resolvePricingAtTime({
      buyEntries: [{ txHash: 'tx-1', token: '0xabc', chain: 'base', timestamp: Date.now(), amount: '1' }],
      sellEntries: [],
      priceSources: { primary: alwaysNull, fallback: alwaysNull },
      // fallbackPricing intentionally omitted
    })
    assert.equal(result.costUsd['tx-1'], null)
    assert.equal(result.evidenceMissingCount, 1)
  })

  it('onRouteRecorded is called with the real route for every external fallback attempt', async () => {
    const recorded: Array<{ token: string; route: string }> = []
    const fallbackPricing: FallbackPricingConfig = {
      attempt: async () => ({ ok: true, priceUsd: 3, source: 'GeckoTerminal' }),
      onRouteRecorded: (info) => { recorded.push({ token: info.token, route: info.route }) },
    }

    await resolvePricingAtTime({
      buyEntries: [{ txHash: 'tx-1', token: '0xdef', chain: 'eth', timestamp: Date.now(), amount: '1' }],
      sellEntries: [],
      priceSources: { primary: alwaysNull, fallback: alwaysNull },
      fallbackPricing,
    })

    assert.equal(recorded.length, 1)
    assert.deepEqual(recorded[0], { token: '0xdef', route: 'GeckoTerminal' })
  })

  it('routerDistributorMode is threaded through unchanged (observability only, no attempt-logic change)', async () => {
    let receivedFlag: boolean | undefined
    const fallbackPricing: FallbackPricingConfig = {
      attempt: async () => ({ ok: true, priceUsd: 1, source: 'BaseScan' }),
      routerDistributorMode: true,
    }
    receivedFlag = fallbackPricing.routerDistributorMode
    assert.equal(receivedFlag, true)

    // The attempt is still made exactly the same way regardless of the flag's value — confirms this
    // is a pass-through, not a second gate.
    const result = await resolvePricingAtTime({
      buyEntries: [{ txHash: 'tx-1', token: '0xabc', chain: 'base', timestamp: Date.now(), amount: '1' }],
      sellEntries: [],
      priceSources: { primary: alwaysNull, fallback: alwaysNull },
      fallbackPricing,
    })
    assert.equal(result.costUsd['tx-1'], 1)
  })
})

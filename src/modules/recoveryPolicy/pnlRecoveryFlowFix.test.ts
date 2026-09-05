// Tests for the PNL-RECOVERY-FLOW-FIX (Wallet Scanner PnL recovery bottleneck task — confirmed
// production shape: 8 tokens triggered, only 3 succeeded, "page cap 6 funds only 3 tokens").
//
// ROOT CAUSE, CONFIRMED (see index.ts's own PNL-RECOVERY-FLOW-FIX comment on buildRecoveryPolicyObject):
// fetchGoldrushHistoricalPage's real request has NO token parameter — it fetches the whole wallet's
// page-1 transactions and is already request-scope coalesced by (chain, wallet, page). Before this
// fix, a triggered candidate that planRecoveryFetches allocated ZERO wallet-page budget to (the
// scarce budget was already spent on higher-materiality candidates) was skipped OUTRIGHT via
// `Promise.resolve({ events: [], pagesUsed: 0 })` — discarding data for its own token that was
// already sitting in the SAME already-fetched page another candidate paid for.
//
// Mocks global.fetch (no real network dependency), same pattern already used by
// historicalPageCoalescing.test.ts. Run directly with:
//   npx tsx --test src/modules/recoveryPolicy/pnlRecoveryFlowFix.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildRecoveryPolicyObject } from './index'
import { resetRecoveryHistoricalPageRequestCache } from './utils'
import { DEFAULT_RECOVERY_CAPS } from './types'
import type { BuyTimeline, SellTimeline, SellTimelineEntry } from '../timelineBuilder/types'
import type { SupportedChain } from '../providerFetchWindow/types'

const originalFetch = global.fetch
const originalGoldrushKey = process.env.GOLDRUSH_API_KEY
const WALLET = '0xwa11e7000000000000000000000000000000001'

beforeEach(() => {
  resetRecoveryHistoricalPageRequestCache()
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
})

afterEach(() => {
  global.fetch = originalFetch
  resetRecoveryHistoricalPageRequestCache()
  process.env.GOLDRUSH_API_KEY = originalGoldrushKey
})

function tokenContract(n: number): string {
  return `0x${'a'.repeat(39)}${n}`
}

// 8 distinct tokens, each sold a DIFFERENT number of times (descending) so evaluateRecoveryTriggers'
// real coverageMateriality (sellCount) naturally ranks them 1..8, matching the confirmed production
// shape ("5/8 triggered tokens got zero historical pages").
const CHAIN_CONTEXT = { includedChains: ['base'] as SupportedChain[], excludedChains: [] }
const CHAIN_SELECTION_REF = { status: 'active_intelligence' as const, gatesPassed: ['valueGate', 'activityGate', 'swapGate'] }

function buildTimelines(): { buyTimeline: BuyTimeline; sellTimeline: SellTimeline } {
  const entries: SellTimelineEntry[] = []
  for (let i = 1; i <= 8; i++) {
    const sellCount = 9 - i // token 1 sold 8x (highest), token 8 sold 1x (lowest)
    for (let s = 0; s < sellCount; s++) {
      entries.push({
        timestamp: 1_700_000_000 + s,
        chain: 'base',
        token: tokenContract(i),
        symbol: `T${i}`,
        amount: '1000',
        proceedsUsdEstimate: null,
        matchedBuyLotId: null,
        confidence: 'high',
        txHash: `0xsell${i}-${s}`,
        chainSelectionRef: CHAIN_SELECTION_REF,
      })
    }
  }
  return {
    buyTimeline: { totalBuys: 0, chainContext: CHAIN_CONTEXT, entries: [] },
    sellTimeline: { totalSells: entries.length, chainContext: CHAIN_CONTEXT, entries },
  }
}

// One real GoldRush page-1 response carrying a real matching transfer for EVERY one of the 8 tokens
// — proving the shared, untargeted, coalesced fetch already has the data every eligible token needs.
function mockGoldrushPageWithAllEightTokens(): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    const transfers = Array.from({ length: 8 }, (_, i) => ({
      from_address: '0xpool000000000000000000000000000000000',
      to_address: WALLET,
      contract_address: tokenContract(i + 1),
      contract_ticker_symbol: `T${i + 1}`,
      delta: '1000',
      contract_decimals: 18,
    }))
    return new Response(
      JSON.stringify({ data: { items: [{ tx_hash: '0xabc', block_signed_at: '2024-01-01T00:00:00Z', transfers }] } }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('buildRecoveryPolicyObject — free-riding zero-budget candidates onto an already-paid shared page', () => {
  it('THE BUG: with DEFAULT_RECOVERY_CAPS, only 3 of 8 triggered candidates get real wallet-page budget', async () => {
    mockGoldrushPageWithAllEightTokens()
    const { buyTimeline, sellTimeline } = buildTimelines()
    const result = await buildRecoveryPolicyObject({ buyTimeline, sellTimeline, holdings: [], walletAddress: WALLET, caps: DEFAULT_RECOVERY_CAPS })
    const funded = result.evaluation.filter((e) => e.pagesUsed > 0)
    assert.equal(funded.length, 3, 'the wallet page cap (6) funds exactly floor(6/2)=3 real-budget candidates')
  })

  it('THE FIX: all 8 triggered candidates recover their own token from the SAME already-fetched page — zero extra GoldRush calls', async () => {
    const { getCallCount } = mockGoldrushPageWithAllEightTokens()
    const { buyTimeline, sellTimeline } = buildTimelines()
    const result = await buildRecoveryPolicyObject({ buyTimeline, sellTimeline, holdings: [], walletAddress: WALLET, caps: DEFAULT_RECOVERY_CAPS })

    for (const entry of result.evaluation) {
      assert.ok(entry.recoveredEvents.length > 0, `token ${entry.token} must recover its own real event from the shared page, budgeted or not`)
    }
    assert.equal(getCallCount(), 1, 'every candidate (funded or free-riding) must share exactly ONE real GoldRush network call for this chain+page')
  })

  it('a free-riding candidate reports pagesUsed: 0 — it never claims to have spent its own (nonexistent) budget', async () => {
    mockGoldrushPageWithAllEightTokens()
    const { buyTimeline, sellTimeline } = buildTimelines()
    const result = await buildRecoveryPolicyObject({ buyTimeline, sellTimeline, holdings: [], walletAddress: WALLET, caps: DEFAULT_RECOVERY_CAPS })
    const freeRiders = result.evaluation.filter((e) => e.pagesUsed === 0)
    assert.equal(freeRiders.length, 5, 'the 5 unbudgeted candidates must be exactly the free-riders')
    for (const e of freeRiders) assert.ok(e.recoveredEvents.length > 0, 'a free-rider still recovers real events despite pagesUsed 0')
  })

  it('a chain with NO real paying candidate never triggers an extra fetch for a free-rider (total call volume unchanged)', async () => {
    const { getCallCount } = mockGoldrushPageWithAllEightTokens()
    // No buy/sell entries at all -> distinctTokensFromTimelines finds zero tokens -> zero candidates
    // -> no paying candidate exists on 'base', so nobody should free-ride into a fresh fetch either.
    const emptyBuy: BuyTimeline = { totalBuys: 0, chainContext: CHAIN_CONTEXT, entries: [] }
    const emptySell: SellTimeline = { totalSells: 0, chainContext: CHAIN_CONTEXT, entries: [] }
    const result = await buildRecoveryPolicyObject({ buyTimeline: emptyBuy, sellTimeline: emptySell, holdings: [], walletAddress: WALLET, caps: DEFAULT_RECOVERY_CAPS })
    assert.equal(result.evaluation.length, 0, 'no distinct tokens, no candidates at all')
    assert.equal(getCallCount(), 0, 'zero candidates means zero network calls')
  })

  it('pnlRecoveryFlowAudit reports the compact per-token flow trace with honest dropStage/dropReason', async () => {
    mockGoldrushPageWithAllEightTokens()
    const { buyTimeline, sellTimeline } = buildTimelines()
    const result = await buildRecoveryPolicyObject({ buyTimeline, sellTimeline, holdings: [], walletAddress: WALLET, caps: DEFAULT_RECOVERY_CAPS })
    assert.ok(result.pnlRecoveryFlowAudit, 'pnlRecoveryFlowAudit must be present')
    assert.equal(result.pnlRecoveryFlowAudit!.length, 8)
    for (const entry of result.pnlRecoveryFlowAudit!) {
      assert.equal(entry.includedInSharedRequest, true, 'every candidate rode the shared base-chain request')
      assert.equal(entry.matchingEventsFound, 1)
      assert.equal(entry.dropStage, 'not_dropped')
      assert.equal(entry.dropReason, null)
      // recoveryPolicy runs strictly before fifoEngine/pricing — it cannot know these.
      assert.equal(entry.priceRequirements, null)
      assert.equal(entry.pricesResolved, null)
      assert.equal(entry.lotsVerified, null)
    }
    // Ranked 0 must be the highest-materiality token (token 1, sellCount 8).
    const rankZero = result.pnlRecoveryFlowAudit!.find((e) => e.ranked === 0)
    assert.equal(rankZero?.token, tokenContract(1))
    assert.equal(rankZero?.lotCount, 8)
  })

  it('a genuinely non-triggered token is honestly marked dropStage "not_triggered"', async () => {
    mockGoldrushPageWithAllEightTokens()
    // A buy with a tiny USD value and only ONE sell occurrence still triggers (min count 1 by
    // default) — so to get a non-triggered candidate we'd need a token with no buy/sell entries at
    // all, which by construction never appears in distinctTokensFromTimelines. Instead, assert the
    // dropStage enum/logic directly covers the not_triggered branch via a caller-supplied
    // triggerConfig that raises the sell-repeat threshold above every real sell count.
    const { buyTimeline, sellTimeline } = buildTimelines()
    const result = await buildRecoveryPolicyObject({
      buyTimeline, sellTimeline, holdings: [], walletAddress: WALLET, caps: DEFAULT_RECOVERY_CAPS,
      triggerConfig: { token_value_usd_gte: 1_000_000_000, in_top_3_holdings: false, repeated_in_sell_timeline_min_count: 999 },
    })
    for (const entry of result.pnlRecoveryFlowAudit!) {
      assert.equal(entry.dropStage, 'not_triggered')
      assert.equal(entry.includedInSharedRequest, false)
      assert.equal(entry.matchingEventsFound, 0)
    }
  })
})

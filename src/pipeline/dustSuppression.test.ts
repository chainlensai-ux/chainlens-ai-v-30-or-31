// Unit tests for upstream dust suppression (src/pipeline/index.ts) — the pure decision functions
// (computeDustCandidateKeys, isSuppressibleDustToken) that gate what's excluded from
// priceLotsForWallet's input and the display-only pricingAtTime pass, BEFORE either runs. The async
// orchestrator (resolveDustSuppressionKeys) is not exported/driven directly here — it's a thin,
// network-calling wrapper around these two pure pieces plus a bounded worker pool, so testing the
// pure decision logic in isolation covers the actual behavior without needing to mock fetch/DNS.
// Run with: npx tsx --test src/pipeline/dustSuppression.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeDustCandidateKeys, isSuppressibleDustToken } from './index'
import type { BuyTimelineEntry, SourceType } from '../modules/timelineBuilder/types'
import type { SellTimelineEntry } from '../modules/sellTimeline/types'
import type { CheapDustPriceResult } from '../../lib/server/dustPriceCheck'

function makeBuy(overrides: Partial<BuyTimelineEntry> & { sourceType: SourceType }): BuyTimelineEntry {
  return {
    timestamp: Date.now(),
    chain: 'base',
    token: '0xdust000000000000000000000000000000dust',
    symbol: 'DUST',
    amount: '100',
    usdValueEstimate: null,
    txHash: '0xabc',
    chainSelectionRef: { status: 'active_intelligence', gatesPassed: [] },
    ...overrides,
  }
}

function makeSell(overrides: Partial<SellTimelineEntry> = {}): SellTimelineEntry {
  return {
    timestamp: Date.now(),
    chain: 'base',
    token: '0xdust000000000000000000000000000000dust',
    symbol: 'DUST',
    amount: '10',
    proceedsUsdEstimate: null,
    matchedBuyLotId: null,
    confidence: 'medium',
    txHash: '0xsell',
    chainSelectionRef: { status: 'active_intelligence', gatesPassed: [] },
    recipient: null,
    ...overrides,
  } as SellTimelineEntry
}

describe('computeDustCandidateKeys', () => {
  it('flags a pure airdrop-only token (no real buy, no sell) as a candidate', () => {
    const buys = [makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xdust' })]
    const candidates = computeDustCandidateKeys(buys, [])
    assert.ok(candidates.has('base:0xdust'))
  })

  it('does NOT flag a token with any real (non-airdrop) buy', () => {
    const buys = [
      makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xtoken' }),
      makeBuy({ sourceType: 'swap', chain: 'base', token: '0xtoken' }),
    ]
    const candidates = computeDustCandidateKeys(buys, [])
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('does NOT flag a mint-sourced token', () => {
    const candidates = computeDustCandidateKeys([makeBuy({ sourceType: 'mint', chain: 'base', token: '0xtoken' })], [])
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('does NOT flag a plain transfer-in token', () => {
    const candidates = computeDustCandidateKeys([makeBuy({ sourceType: 'transfer', chain: 'base', token: '0xtoken' })], [])
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('airdrop-then-sell token is NOT a candidate (protects the sold-dust case)', () => {
    const buys = [makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xtoken' })]
    const sells = [makeSell({ chain: 'base', token: '0xtoken' })]
    const candidates = computeDustCandidateKeys(buys, sells)
    assert.ok(!candidates.has('base:0xtoken'))
  })

  it('is case-insensitive and chain-scoped for the token key', () => {
    const buys = [makeBuy({ sourceType: 'airdrop', chain: 'base', token: '0xDUST' })]
    const candidates = computeDustCandidateKeys(buys, [])
    assert.ok(candidates.has('base:0xdust'))
    assert.ok(!candidates.has('eth:0xdust'))
  })
})

describe('isSuppressibleDustToken', () => {
  it('suppresses when the cheap lookup finds no price source anywhere', () => {
    const cheap: CheapDustPriceResult = { hasAnyPriceSource: false, priceUsdPerToken: null, liquidityUsd: null }
    assert.equal(isSuppressibleDustToken(cheap), true)
  })

  it('does NOT suppress once the cheap lookup finds a real price (dust token later gets a real price)', () => {
    const cheap: CheapDustPriceResult = { hasAnyPriceSource: true, priceUsdPerToken: 0.0000001, liquidityUsd: 500 }
    assert.equal(isSuppressibleDustToken(cheap), false)
  })

  it('does NOT suppress for a well-priced, high-value token', () => {
    const cheap: CheapDustPriceResult = { hasAnyPriceSource: true, priceUsdPerToken: 3200, liquidityUsd: 900_000 }
    assert.equal(isSuppressibleDustToken(cheap), false)
  })
})

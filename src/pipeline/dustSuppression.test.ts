// Unit tests for isDustEligibleForDisplayPricing (src/pipeline/index.ts) — the pure decision
// function behind dust suppression in the DISPLAY-ONLY pricingAtTime pass (stage 6c). Does not
// drive the full pipeline (see that function's own header for why: real priceSources injection
// isn't parameterized at the pipeline entry point, and this decision logic is fully testable in
// isolation). Run with: npx tsx --test src/pipeline/dustSuppression.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isDustEligibleForDisplayPricing } from './index'
import type { BuyTimelineEntry, SourceType } from '../modules/timelineBuilder/types'

function makeEntry(overrides: Partial<BuyTimelineEntry> & { sourceType: SourceType }): BuyTimelineEntry {
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

describe('isDustEligibleForDisplayPricing', () => {
  it('suppresses an airdrop-only entry with a known, sub-threshold current value', () => {
    const entry = makeEntry({ sourceType: 'airdrop', amount: '10' })
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => 0.01) // 10 * 0.01 = $0.10
    assert.equal(result, true)
  })

  it('never suppresses a real swap-sourced buy, regardless of value', () => {
    const entry = makeEntry({ sourceType: 'swap', amount: '10' })
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => 0.01)
    assert.equal(result, false)
  })

  it('never suppresses a mint-sourced entry', () => {
    const entry = makeEntry({ sourceType: 'mint', amount: '10' })
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => 0.01)
    assert.equal(result, false)
  })

  it('never suppresses a plain transfer-in', () => {
    const entry = makeEntry({ sourceType: 'transfer', amount: '10' })
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => 0.01)
    assert.equal(result, false)
  })

  it('never suppresses an airdrop-sourced token that was later sold (protects the sold-dust case)', () => {
    const entry = makeEntry({ sourceType: 'airdrop', chain: 'base', token: '0xToKeN', amount: '10' })
    const neverSuppressKeys = new Set(['base:0xtoken']) // built from sells + non-airdrop buys elsewhere
    const result = isDustEligibleForDisplayPricing(entry, neverSuppressKeys, () => 0.01)
    assert.equal(result, false)
  })

  it('never suppresses when the current price is unknown (null) — conservative default', () => {
    const entry = makeEntry({ sourceType: 'airdrop', amount: '10' })
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => null)
    assert.equal(result, false)
  })

  it('does not suppress once a real, non-negligible price exists (dust token later gets a real price)', () => {
    const entry = makeEntry({ sourceType: 'airdrop', amount: '10' })
    // 10 * 50 = $500 — well above the $5 threshold, so no longer dust-eligible.
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => 50)
    assert.equal(result, false)
  })

  it('is a boundary check at exactly the threshold: $5.00 is NOT suppressed (< threshold, not <=)', () => {
    const entry = makeEntry({ sourceType: 'airdrop', amount: '1' })
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => 5)
    assert.equal(result, false)
  })

  it('handles a non-finite estimated value (e.g. malformed amount) by not suppressing', () => {
    const entry = makeEntry({ sourceType: 'airdrop', amount: 'not-a-number' })
    const result = isDustEligibleForDisplayPricing(entry, new Set(), () => 0.01)
    assert.equal(result, false)
  })
})

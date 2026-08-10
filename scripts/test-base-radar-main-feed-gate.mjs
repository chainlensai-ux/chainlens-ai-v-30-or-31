import assert from 'node:assert/strict'
import { MAIN_FEED_MIN_VALUATION_USD, MAIN_FEED_MIN_HOLDERS, passesMainFeedValuationGate, passesMainFeedHolderGate, isRealVerifiedMarketCapValue } from '../lib/baseRadarMainFeedGate.ts'

assert.equal(MAIN_FEED_MIN_VALUATION_USD, 45_000)
assert.equal(MAIN_FEED_MIN_HOLDERS, 30)

// ─── Valuation gate ─────────────────────────────────────────────────────────
// market cap $44,999 excluded
assert.equal(passesMainFeedValuationGate(44_999), false)
// market cap $45,000 included (boundary — inclusive, not exclusive)
assert.equal(passesMainFeedValuationGate(45_000), true)
assert.equal(passesMainFeedValuationGate(50_000), true)
// valuation unavailable (null/undefined) excluded — never bypasses the gate
assert.equal(passesMainFeedValuationGate(null), false)
assert.equal(passesMainFeedValuationGate(undefined), false)
assert.equal(passesMainFeedValuationGate(NaN), false)

// ─── Holder gate ────────────────────────────────────────────────────────────
// holders 29 excluded
assert.equal(passesMainFeedHolderGate(29), false)
// holders 30 included (boundary)
assert.equal(passesMainFeedHolderGate(30), true)
assert.equal(passesMainFeedHolderGate(35), true)
// holders null/N/A/open-check/unavailable must never count as passing
assert.equal(passesMainFeedHolderGate(null), false)
assert.equal(passesMainFeedHolderGate(undefined), false)
assert.equal(passesMainFeedHolderGate(NaN), false)

// ─── FDV fallback must not be indistinguishable from a real verified market cap ────────────────
// A real verified market cap: isRealVerifiedMarketCapValue is true.
assert.equal(isRealVerifiedMarketCapValue('verified', 50_000), true)
// FDV-derived valuation (marketCapStatus not 'verified', or marketCapUsd itself null) — this is the
// case app/api/radar/route.ts uses to attach the "Valuation confirmed via FDV fallback" evidence
// gap even though the candidate clears the $45K gate via FDV. Must never report as a real MC.
assert.equal(isRealVerifiedMarketCapValue(null, null), false)
assert.equal(isRealVerifiedMarketCapValue('unavailable', null), false)
assert.equal(isRealVerifiedMarketCapValue('verified', null), false)
assert.equal(isRealVerifiedMarketCapValue(null, 50_000), false)
// A candidate can pass the $45K valuation gate via FDV fallback (the flattened valuation.valueUsd
// used by passesMainFeedValuationGate) while isRealVerifiedMarketCapValue is still false for it —
// this is exactly the "FDV fallback does not bypass evidence warnings" case: the gate check and the
// fallback-labeling check are independent, so passing one never silently satisfies the other.
{
  const fdvFallbackValuationUsd = 60_000 // what getRadarValuationBasis's flattening reports for a valid FDV fallback
  const rawMarketCapStatus = null // the real, pre-flattening marketCapStatus for this candidate
  const rawMarketCapUsd = null
  assert.equal(passesMainFeedValuationGate(fdvFallbackValuationUsd), true, 'FDV-derived valuation still clears the $45K gate')
  assert.equal(isRealVerifiedMarketCapValue(rawMarketCapStatus, rawMarketCapUsd), false, 'but is correctly flagged as not a real verified market cap, so the fallback evidence gap still attaches')
}

// ─── Existing strong candidate still appears ───────────────────────────────
// A token with a real verified $200K market cap and 500 holders clears every part of the gate.
{
  const marketCapStatus = 'verified'
  const marketCapUsd = 200_000
  assert.equal(passesMainFeedValuationGate(marketCapUsd), true)
  assert.equal(passesMainFeedHolderGate(500), true)
  assert.equal(isRealVerifiedMarketCapValue(marketCapStatus, marketCapUsd), true)
}

console.log('test-base-radar-main-feed-gate.mjs: all assertions passed')

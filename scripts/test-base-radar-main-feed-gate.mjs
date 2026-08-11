import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAIN_FEED_MIN_VALUATION_USD, MAIN_FEED_MIN_HOLDERS, passesMainFeedValuationGate, passesMainFeedHolderGate, isRealVerifiedMarketCapValue, CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP } from '../lib/baseRadarMainFeedGate.ts'

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

// ─── Holder count vs. holder concentration ─────────────────────────────────
// holders=100 and concentration N/A: passes the holder gate (concentration is a separate concept
// this route never even fetches — see CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP's own header) and the
// evidence-gap string app/api/radar/route.ts attaches to every displayed candidate exists and is
// worded to say "unavailable", not "open check" (which would read as holder count itself missing).
assert.equal(passesMainFeedHolderGate(100), true, 'holders=100 passes the holder gate regardless of concentration availability')
assert.equal(typeof CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP, 'string')
assert.ok(CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP.toLowerCase().includes('concentration'))
assert.ok(!CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP.toLowerCase().includes('open check'), 'must not read as if holder count itself is missing')

// holders=null fails the holder gate
assert.equal(passesMainFeedHolderGate(null), false)

// holders=29 fails / holders=30 passes if valuation/liquidity pass (boundary, restated together
// with a passing valuation to mirror the exact scenario the task describes)
assert.equal(passesMainFeedHolderGate(29) && passesMainFeedValuationGate(50_000), false)
assert.equal(passesMainFeedHolderGate(30) && passesMainFeedValuationGate(50_000), true)

// marketCap=44,999 excluded / marketCap=45,000 included if holder/liquidity pass
assert.equal(passesMainFeedValuationGate(44_999) && passesMainFeedHolderGate(30), false)
assert.equal(passesMainFeedValuationGate(45_000) && passesMainFeedHolderGate(30), true)

// ─── Raw candidate pool vs. display cap (starvation fix) ───────────────────
// Reads the actual constants out of app/api/radar/route.ts's source (that file itself can't be
// imported directly by a plain node script — it pulls in next/server and the Anthropic SDK, which
// need the Next.js bundler's module resolution) to assert the real fix shipped: the holder-check
// limit that was capping how many ranked candidates ever got a chance at the holder gate (the
// actual cause of "main feed only shows 1 token even though the market has more candidates") is
// raised above its old starved value, and stays below the full ranked-candidate pool it draws from
// (so it can never itself become the new starvation point by silently exceeding what's available).
{
  const routeSource = readFileSync(fileURLToPath(new URL('../app/api/radar/route.ts', import.meta.url)), 'utf8')
  const holderCheckLimitMatch = routeSource.match(/const HOLDER_CHECK_LIMIT = (\d+)/)
  const rankedCapMatch = routeSource.match(/const RANKED_CANDIDATES_CAP = (\d+)/)
  assert.ok(holderCheckLimitMatch, 'HOLDER_CHECK_LIMIT constant must exist in app/api/radar/route.ts')
  assert.ok(rankedCapMatch, 'RANKED_CANDIDATES_CAP constant must exist in app/api/radar/route.ts')
  const holderCheckLimit = Number(holderCheckLimitMatch[1])
  const rankedCandidatesCap = Number(rankedCapMatch[1])
  assert.ok(holderCheckLimit > 20, `HOLDER_CHECK_LIMIT must be raised above the old starved value of 20 (is ${holderCheckLimit})`)
  assert.ok(holderCheckLimit <= rankedCandidatesCap, 'the holder-check limit must never exceed the pool of ranked candidates it draws from — a raw pool larger than the display cap must be trimmed by the expansion, not silently overrun')
  // baseRadarCandidateGateAudit must exist and expose the raw-vs-filtered funnel the task asked for,
  // so "displayed count starved by pre-filter cap" is diagnosable from a log line, not a guess.
  for (const field of ['rawCandidates', 'afterLiquidityGate', 'afterValuation45kGate', 'afterHolder30Gate', 'displayedCount', 'hiddenLowValuation', 'hiddenLowHolders', 'hiddenHolderUnavailable', 'rawCandidateCap', 'filterStage']) {
    assert.ok(routeSource.includes(field), `baseRadarCandidateGateAudit must expose "${field}"`)
  }
}

console.log('test-base-radar-main-feed-gate.mjs: all assertions passed')

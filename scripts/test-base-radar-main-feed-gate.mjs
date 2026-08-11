import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAIN_FEED_MIN_VALUATION_USD, MAIN_FEED_MIN_HOLDERS, passesMainFeedValuationGate, passesMainFeedHolderGate, isRealVerifiedMarketCapValue, CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP, DISPLAY_TARGET, HOLDER_CHECK_BUDGET_CAP, HOLDER_CHECK_BATCH_SIZE, shouldContinueHolderChecking } from '../lib/baseRadarMainFeedGate.ts'

assert.equal(MAIN_FEED_MIN_VALUATION_USD, 80_000)
assert.equal(MAIN_FEED_MIN_HOLDERS, 30)

// ─── Valuation gate ─────────────────────────────────────────────────────────
// market cap $79,999 excluded
assert.equal(passesMainFeedValuationGate(79_999), false)
// market cap $80,000 included (boundary — inclusive, not exclusive)
assert.equal(passesMainFeedValuationGate(80_000), true)
assert.equal(passesMainFeedValuationGate(100_000), true)
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
// gap even though the candidate clears the $80K gate via FDV. Must never report as a real MC.
assert.equal(isRealVerifiedMarketCapValue(null, null), false)
assert.equal(isRealVerifiedMarketCapValue('unavailable', null), false)
assert.equal(isRealVerifiedMarketCapValue('verified', null), false)
assert.equal(isRealVerifiedMarketCapValue(null, 50_000), false)
// A candidate can pass the $80K valuation gate via FDV fallback (the flattened valuation.valueUsd
// used by passesMainFeedValuationGate) while isRealVerifiedMarketCapValue is still false for it —
// this is exactly the "FDV fallback does not bypass evidence warnings" case: the gate check and the
// fallback-labeling check are independent, so passing one never silently satisfies the other.
{
  const fdvFallbackValuationUsd = 90_000 // what getRadarValuationBasis's flattening reports for a valid FDV fallback
  const rawMarketCapStatus = null // the real, pre-flattening marketCapStatus for this candidate
  const rawMarketCapUsd = null
  assert.equal(passesMainFeedValuationGate(fdvFallbackValuationUsd), true, 'FDV-derived valuation still clears the $80K gate')
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
assert.equal(passesMainFeedHolderGate(29) && passesMainFeedValuationGate(90_000), false)
assert.equal(passesMainFeedHolderGate(30) && passesMainFeedValuationGate(90_000), true)

// marketCap=79,999 excluded / marketCap=80,000 included if holder/liquidity pass
assert.equal(passesMainFeedValuationGate(79_999) && passesMainFeedHolderGate(30), false)
assert.equal(passesMainFeedValuationGate(80_000) && passesMainFeedHolderGate(30), true)

// ─── Holder-check budget loop (starvation fix #2) ──────────────────────────
// shouldContinueHolderChecking IS the exact condition app/api/radar/route.ts's while-loop uses
// (imported directly, not re-implemented) — these exercise it as a pure state machine.

// DISPLAY_TARGET/HOLDER_CHECK_BUDGET_CAP are real, sane values: budget clearly exceeds the old fixed
// 20/30 cutoffs that caused the starvation, and the display target is more than 1 (proving the loop
// is designed to keep going, not stop at the first pass).
assert.ok(DISPLAY_TARGET > 1, 'display target must aim for more than a single passing candidate')
assert.ok(HOLDER_CHECK_BUDGET_CAP > 30, `budget cap must exceed the old starved 30-candidate cutoff (is ${HOLDER_CHECK_BUDGET_CAP})`)
assert.ok(HOLDER_CHECK_BATCH_SIZE > 0 && HOLDER_CHECK_BATCH_SIZE <= HOLDER_CHECK_BUDGET_CAP)

// holder-check loop continues past top 30 until display target or budget cap: with a pool of 100 and
// nothing passing yet, the loop must still say "keep going" well past cursor=30.
assert.equal(shouldContinueHolderChecking({ passingCount: 0, attemptedCount: 30, cursor: 30, poolSize: 100 }), true, 'must not stop just because 30 candidates have been checked — that was the old bug')
assert.equal(shouldContinueHolderChecking({ passingCount: 0, attemptedCount: 45, cursor: 45, poolSize: 100 }), true, 'must keep going past rank 40+ as long as budget and pool remain')

// Stops once DISPLAY_TARGET candidates have actually passed — no reason to keep spending calls.
assert.equal(shouldContinueHolderChecking({ passingCount: DISPLAY_TARGET, attemptedCount: 12, cursor: 12, poolSize: 100 }), false)
assert.equal(shouldContinueHolderChecking({ passingCount: DISPLAY_TARGET - 1, attemptedCount: 12, cursor: 12, poolSize: 100 }), true)

// Stops once the budget is exhausted, even if the display target was never reached — a hard ceiling
// so a genuinely thin market can't turn into an unbounded/slow request.
assert.equal(shouldContinueHolderChecking({ passingCount: 1, attemptedCount: HOLDER_CHECK_BUDGET_CAP, cursor: HOLDER_CHECK_BUDGET_CAP, poolSize: 200 }), false)

// Stops once the ranked pool itself is exhausted, even under budget — can't check candidates that
// don't exist. This is the honest "only 1 genuinely passed" case: the loop tried everything it had.
assert.equal(shouldContinueHolderChecking({ passingCount: 1, attemptedCount: 12, cursor: 12, poolSize: 12 }), false)

// ─── Simulated end-to-end: valid candidate ranked 40th can still appear ────
// Mirrors app/api/radar/route.ts's batching loop against a synthetic 50-candidate ranked pool where
// ranks 1-39 fail the holder gate (e.g. low-holder degen tokens dominating momentum rank that day)
// and rank 40 is a real $80K+/30-holder candidate. Proves the starvation-fix loop reaches it instead
// of stopping at the old fixed top-20/top-30 cutoff.
{
  const pool = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, holderCount: i === 39 ? 100 : 5 }))
  let cursor = 0, attemptedCount = 0, passingCount = 0
  const checked = []
  while (shouldContinueHolderChecking({ passingCount, attemptedCount, cursor, poolSize: pool.length })) {
    const batch = pool.slice(cursor, cursor + HOLDER_CHECK_BATCH_SIZE)
    cursor += batch.length
    for (const candidate of batch) {
      attemptedCount++
      checked.push(candidate.rank)
      if (passesMainFeedHolderGate(candidate.holderCount)) passingCount++
    }
  }
  assert.ok(checked.includes(40), 'rank-40 candidate must have been holder-checked, not skipped by an old fixed top-N cutoff')
  assert.equal(passingCount, 1, 'exactly the one real candidate (rank 40) passes')
}

// ─── Feed does not starve to 1 when 5+ passing candidates exist ───────────
{
  const pool = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, holderCount: i < 6 ? 100 : 5 })) // ranks 1-6 pass
  let cursor = 0, attemptedCount = 0, passingCount = 0
  while (shouldContinueHolderChecking({ passingCount, attemptedCount, cursor, poolSize: pool.length })) {
    const batch = pool.slice(cursor, cursor + HOLDER_CHECK_BATCH_SIZE)
    cursor += batch.length
    for (const candidate of batch) {
      attemptedCount++
      if (passesMainFeedHolderGate(candidate.holderCount)) passingCount++
    }
  }
  assert.equal(passingCount, 6, 'all 6 real candidates surface, not just the first one found')
}

// ─── If only 1 genuinely passes, the loop still proves it exhausted the pool/budget ────────────
{
  const pool = Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, holderCount: i === 0 ? 100 : 5 })) // only rank 1 passes, pool is small
  let cursor = 0, attemptedCount = 0, passingCount = 0
  while (shouldContinueHolderChecking({ passingCount, attemptedCount, cursor, poolSize: pool.length })) {
    const batch = pool.slice(cursor, cursor + HOLDER_CHECK_BATCH_SIZE)
    cursor += batch.length
    for (const candidate of batch) {
      attemptedCount++
      if (passesMainFeedHolderGate(candidate.holderCount)) passingCount++
    }
  }
  assert.equal(passingCount, 1)
  assert.equal(cursor, pool.length, 'the entire (small) pool was exhausted trying to find more — 1 passing is honest, not a starved cutoff')
}

// ─── Raw candidate pool vs. display cap (starvation fix) ───────────────────
// Reads the actual constants out of app/api/radar/route.ts's source (that file itself can't be
// imported directly by a plain node script — it pulls in next/server and the Anthropic SDK, which
// need the Next.js bundler's module resolution) to assert the real fix shipped.
{
  const routeSource = readFileSync(fileURLToPath(new URL('../app/api/radar/route.ts', import.meta.url)), 'utf8')
  const rankedCapMatch = routeSource.match(/const RANKED_CANDIDATES_CAP = (\d+)/)
  assert.ok(rankedCapMatch, 'RANKED_CANDIDATES_CAP constant must exist in app/api/radar/route.ts')
  const rankedCandidatesCap = Number(rankedCapMatch[1])
  assert.ok(rankedCandidatesCap >= 100, `RANKED_CANDIDATES_CAP must be expanded to at least 100 (is ${rankedCandidatesCap})`)
  assert.ok(routeSource.includes('shouldContinueHolderChecking'), 'the live loop must use the same tested stopping condition, not a re-implementation')
  // baseRadarCandidateGateAudit must exist and expose the raw-vs-filtered funnel the task asked for,
  // so "displayed count starved by pre-filter cap" is diagnosable from a log line, not a guess.
  for (const field of ['rawCandidatesFetched', 'rawCandidateCap', 'rankedCandidates', 'liquidityPassed', 'valuationChecked', 'valuationPassed80k', 'holderCheckAttempted', 'holderCheckSucceeded', 'holdersPassed30', 'displayedCount', 'hiddenBelow80k', 'hiddenBelow30Holders', 'hiddenMissingHolderCount', 'hiddenConcentrationUnavailable', 'holderCheckBudget', 'holderCheckBudgetExhausted', 'discoverySourceCounts', 'displayTarget']) {
    assert.ok(routeSource.includes(field), `baseRadarCandidateGateAudit must expose "${field}"`)
  }

  // ─── baseRadarSourceAudit must exist with the full requested schema ─────────────────────────
  assert.ok(routeSource.includes('baseRadarSourceAudit'), 'baseRadarSourceAudit must exist')
  for (const field of ['runtimeCommitSha', 'discoverySourcesUsed', 'rawFromEachSource', 'rawTotalBeforeDedupe', 'afterDedupe', 'afterAgeWindow', 'afterLiquidityMinimum', 'afterValuationAvailable', 'afterValuation80k', 'holderCheckEligible', 'rejectionReasons']) {
    assert.ok(routeSource.includes(field), `baseRadarSourceAudit must expose "${field}"`)
  }

  // ─── No accidental pre-filter slice/top-N cap ahead of the valuation/holder gates ────────────
  // The only small-number .slice(0, N) calls in this file must be for things that run AFTER
  // filtering (Clark AI verdicts on the top 5 already-final tokens, the debug nearMissSample log
  // cap) — never a hidden cap on the raw/ranked candidate pool itself before the gates run.
  const smallSlices = [...routeSource.matchAll(/\.slice\(0,\s*(\d+)\)/g)].map(m => Number(m[1])).filter(n => n <= 30)
  assert.ok(smallSlices.length <= 2, `found ${smallSlices.length} small-N .slice(0, <=30) calls (expected at most 2: the top-5 Clark verdict slice and the 30-entry nearMissSample log cap) — a new one could be an accidental pre-filter cap: ${smallSlices.join(', ')}`)

  // ─── Cache key includes the gate thresholds (stale-cache-after-threshold-change fix) ─────────
  assert.ok(routeSource.includes('MAIN_FEED_MIN_VALUATION_USD') && /cacheKeyBase\s*=[\s\S]{0,400}MAIN_FEED_MIN_VALUATION_USD/.test(routeSource), 'the cache key must fold in MAIN_FEED_MIN_VALUATION_USD so a threshold change can never serve a stale payload computed under the old gate')
}

console.log('test-base-radar-main-feed-gate.mjs: all assertions passed')

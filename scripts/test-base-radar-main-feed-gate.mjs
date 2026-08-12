import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAIN_FEED_MIN_VALUATION_USD, MAIN_FEED_MAX_VALUATION_USD, MAIN_FEED_MIN_HOLDERS, passesMainFeedValuationMinGate, passesMainFeedValuationMaxGate, passesMainFeedValuationGate, passesMainFeedHolderGate, isRealVerifiedMarketCapValue, CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP, DISPLAY_TARGET, HOLDER_CHECK_BUDGET_CAP, HOLDER_CHECK_BATCH_SIZE, shouldContinueHolderChecking } from '../lib/baseRadarMainFeedGate.ts'

assert.equal(MAIN_FEED_MIN_VALUATION_USD, 80_000)
assert.equal(MAIN_FEED_MAX_VALUATION_USD, 2_000_000)
assert.equal(MAIN_FEED_MIN_HOLDERS, 30)

// ─── Valuation: $80K floor is a real exclusion; $2M is a CLASSIFICATION boundary, not an
// exclusion (explicit product change — see the $2M-IS-A-CLASSIFICATION-NOT-AN-EXCLUSION comment
// in app/api/radar/route.ts). passesMainFeedValuationMinGate is the real route-level exclusion
// (droppedByMarketCapBelow80k). passesMainFeedValuationMaxGate/passesMainFeedValuationGate remain
// pure predicates describing the $80K-$2M "early range" band — route.ts uses
// !passesMainFeedValuationMaxGate(...) to set isEstablished (a label), never to `continue`/exclude.
// $79,999 excluded (below the real $80K floor)
assert.equal(passesMainFeedValuationMinGate(79_999), false)
assert.equal(passesMainFeedValuationGate(79_999), false)
// $80,000 included if liquidity passes (boundary — inclusive, not exclusive)
assert.equal(passesMainFeedValuationMinGate(80_000), true)
// $2,000,000 is still inside the early-range band (both predicates true)
assert.equal(passesMainFeedValuationGate(2_000_000), true)
assert.equal(passesMainFeedValuationMaxGate(2_000_000), true)
// $2,000,001 is NOT excluded only for being above $2M — passesMainFeedValuationMinGate (the real
// exclusion predicate) is still true; only the max/early-range classification predicate flips.
assert.equal(passesMainFeedValuationMinGate(2_000_001), true, '$2,000,001 must still clear the real $80K floor — being above $2M is not itself an exclusion')
assert.equal(passesMainFeedValuationMaxGate(2_000_001), false, 'above $2M correctly falls outside the early-range classification boundary (used for the Established label, not exclusion)')
// mid-band value passes both halves
assert.equal(passesMainFeedValuationGate(500_000), true)
// valuation unavailable (null/undefined/NaN) excluded — never bypasses the real $80K floor
assert.equal(passesMainFeedValuationMinGate(null), false)
assert.equal(passesMainFeedValuationMinGate(undefined), false)
assert.equal(passesMainFeedValuationMinGate(NaN), false)

// ─── Holder gate ────────────────────────────────────────────────────────────
// holders 29 excluded
assert.equal(passesMainFeedHolderGate(29), false)
// holders 30 included if all other gates pass (boundary)
assert.equal(passesMainFeedHolderGate(30), true)
assert.equal(passesMainFeedHolderGate(150), true)
// missing holder count excluded — null/undefined/NaN must never count as passing
assert.equal(passesMainFeedHolderGate(null), false)
assert.equal(passesMainFeedHolderGate(undefined), false)
assert.equal(passesMainFeedHolderGate(NaN), false)

// ─── FDV fallback must not be indistinguishable from a real verified market cap ────────────────
// A real verified market cap: isRealVerifiedMarketCapValue is true.
assert.equal(isRealVerifiedMarketCapValue('verified', 500_000), true)
// FDV-derived valuation (marketCapStatus not 'verified', or marketCapUsd itself null) — this is the
// case app/api/radar/route.ts uses to attach the "Valuation confirmed via FDV fallback" evidence
// gap even though the candidate clears the valuation band via FDV. Must never report as a real MC.
assert.equal(isRealVerifiedMarketCapValue(null, null), false)
assert.equal(isRealVerifiedMarketCapValue('unavailable', null), false)
assert.equal(isRealVerifiedMarketCapValue('verified', null), false)
assert.equal(isRealVerifiedMarketCapValue(null, 500_000), false)
// A candidate can pass the valuation band via FDV fallback (the flattened valuation.valueUsd used
// by passesMainFeedValuationGate) while isRealVerifiedMarketCapValue is still false for it — this
// is exactly the "FDV fallback does not bypass evidence warnings" case: the gate check and the
// fallback-labeling check are independent, so passing one never silently satisfies the other.
{
  const fdvFallbackValuationUsd = 500_000 // what getRadarValuationBasis's flattening reports for a valid FDV fallback
  const rawMarketCapStatus = null // the real, pre-flattening marketCapStatus for this candidate
  const rawMarketCapUsd = null
  assert.equal(passesMainFeedValuationGate(fdvFallbackValuationUsd), true, 'FDV-derived valuation still clears the $80K-$2M band')
  assert.equal(isRealVerifiedMarketCapValue(rawMarketCapStatus, rawMarketCapUsd), false, 'but is correctly flagged as not a real verified market cap, so the fallback evidence gap still attaches')
}

// ─── Existing strong candidate still appears ───────────────────────────────
// A token with a real verified $500K market cap and 500 holders clears every part of the gate.
{
  const marketCapStatus = 'verified'
  const marketCapUsd = 500_000
  assert.equal(passesMainFeedValuationGate(marketCapUsd), true)
  assert.equal(passesMainFeedHolderGate(500), true)
  assert.equal(isRealVerifiedMarketCapValue(marketCapStatus, marketCapUsd), true)
}

// ─── Above-$2M established/large token gets the Established label, NOT exclusion ────────────────
// (explicit product change: $2M moved from a hard exclusion to a classification boundary)
{
  const marketCapUsd = 400_000_000 // e.g. an Aerodrome-sized market cap
  assert.equal(passesMainFeedValuationMinGate(marketCapUsd), true, 'a large/established-sized market cap still clears the real $80K floor — it is not excluded from default New Radar')
  assert.equal(passesMainFeedValuationMaxGate(marketCapUsd), false, 'but correctly falls outside the early-range classification boundary — this is what drives isEstablished=true / the "Established" label, not an exclusion')
}

// ─── An OpenAI-style candidate above $2M displays as Established, not excluded, if it passes
// liquidity/valuation evidence (explicitly requested scenario) ──────────────────────────────────
{
  const openAiStyleMarketCapUsd = 9_500_000 // e.g. a large, liquid, above-early-range token
  const liquidityUsd = 7_100_000 // real, ample liquidity
  assert.equal(passesMainFeedValuationMinGate(openAiStyleMarketCapUsd), true)
  assert.equal(liquidityUsd >= 5_000, true, 'clears the liquidity minimum')
  const isEstablished = !passesMainFeedValuationMaxGate(openAiStyleMarketCapUsd)
  assert.equal(isEstablished, true, 'a $9.5M-valuation, liquid candidate must be classified Established, not hidden — it cleared every real requirement (valuation floor + liquidity)')
}

// ─── Holder count vs. holder concentration ─────────────────────────────────
// holders=30 and concentration N/A: passes the holder gate (concentration is a separate concept
// this route never even fetches — see CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP's own header) and the
// evidence-gap string app/api/radar/route.ts attaches to every displayed candidate exists and is
// worded to say "unavailable", not "open check" (which would read as holder count itself missing).
// Concentration unavailable does not exclude a candidate that already passed the real holder gate.
assert.equal(passesMainFeedHolderGate(30), true, 'holders=30 passes the holder gate regardless of concentration availability')
assert.equal(typeof CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP, 'string')
assert.ok(CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP.toLowerCase().includes('concentration'))
assert.ok(!CONCENTRATION_UNAVAILABLE_EVIDENCE_GAP.toLowerCase().includes('open check'), 'must not read as if holder count itself is missing')

// ─── Liquidity below minimum excluded (combined-gate scenario) ─────────────
// The valuation/holder gates are pure functions with no liquidity parameter — liquidity is checked
// separately in app/api/radar/route.ts (droppedByLiquidityFloorSpecifically/droppedByAbsoluteLiquidityFloor/
// droppedByDeadVolumeFloor, all rolled into droppedByLiquidityGate). This asserts the combined
// real-world scenario: a candidate can clear valuation AND holders and still be correctly excluded
// once liquidity is below minimum, by simulating the route's own three-part liquidity check.
{
  const minLiquidityUsd = 5_000
  const absoluteMinLiquidityUsd = 500
  function passesLiquidityGate(liquidityUsd, volume24h, ageMinutes) {
    if (liquidityUsd < minLiquidityUsd) return false
    if (liquidityUsd < absoluteMinLiquidityUsd) return false
    const hasMeaningfulActivity = ageMinutes < 15 || volume24h >= 200 || (liquidityUsd > 0 && volume24h / liquidityUsd >= 0.02)
    return hasMeaningfulActivity
  }
  assert.equal(passesLiquidityGate(4_999, 1_000, 60), false, 'liquidity below the configured minimum is excluded even with valuation/holders passing')
  assert.equal(passesLiquidityGate(10_000, 1_000, 60), true)
  assert.equal(
    passesLiquidityGate(10_000, 1_000, 60) && passesMainFeedValuationGate(500_000) && passesMainFeedHolderGate(30),
    true,
    'a candidate clearing liquidity + $80K-$2M valuation + 30 holders passes every hard rule',
  )
}

// holders=29 fails / holders=30 passes if valuation/liquidity pass (boundary, restated together
// with a passing valuation to mirror the exact scenario the task describes)
assert.equal(passesMainFeedHolderGate(29) && passesMainFeedValuationGate(500_000), false)
assert.equal(passesMainFeedHolderGate(30) && passesMainFeedValuationGate(500_000), true)

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

// ─── Valid candidate ranked lower by momentum still appears if it passes gates ─────────────────
// Mirrors app/api/radar/route.ts's batching loop against a synthetic 50-candidate ranked pool where
// ranks 1-39 fail the holder gate (e.g. low-holder degen tokens dominating momentum rank that day)
// and rank 40 is a real $80K-$2M/30-holder candidate. Proves the starvation-fix loop reaches it
// instead of stopping at an old fixed top-20/top-30 cutoff — momentum decides ORDER, never inclusion.
{
  const pool = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, holderCount: i === 39 ? 30 : 5 }))
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

// ─── Feed does not starve due to a pre-filter cap when multiple valid candidates exist ──────────
{
  const pool = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, holderCount: i < 6 ? 30 : 5 })) // ranks 1-6 pass
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
  const pool = Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, holderCount: i === 0 ? 30 : 5 })) // only rank 1 passes, pool is small
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

// ─── Raw candidate pool vs. display cap (starvation fix), plus deterministic-gate audit surface ──
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

  // baseRadarCandidateGateAudit must exist and expose exactly the requested audit fields (updated:
  // hiddenAbove2m removed — above-$2M is no longer a hide reason — replaced with
  // aboveEarlyRangeCount/establishedDisplayedCount/holderProviderReachable/
  // holderProviderUnavailableCount/sourceBackoffSkippedCount/sourceBackoffTtlMs).
  for (const field of [
    'rawCandidatesFetched', 'afterLiquidityGate', 'afterValuationMin80k', 'afterValuationMax2m',
    'afterHolder30Gate', 'displayedCount', 'hiddenBelow80k', 'hiddenBelow30Holders',
    'hiddenMissingHolderCount', 'hiddenLiquidityLow', 'hiddenValuationUnavailable',
    'hiddenConcentrationUnavailable', 'holderCheckAttempted', 'holderCheckSucceeded',
    'candidatePoolExhausted', 'holderCheckBudgetExhausted',
    'aboveEarlyRangeCount', 'establishedDisplayedCount', 'holderProviderReachable',
    'holderProviderUnavailableCount', 'sourceBackoffSkippedCount', 'sourceBackoffTtlMs',
  ]) {
    assert.ok(routeSource.includes(field), `baseRadarCandidateGateAudit must expose "${field}"`)
  }
  // hiddenAbove2m must actually be gone from the field list — its reappearance would mean the
  // $2M-is-a-classification reset regressed back to treating it as a hide reason.
  assert.ok(!/hiddenAbove2m/.test(routeSource), 'hiddenAbove2m must be removed — above $2M is a classification, not a hide reason')

  // ─── baseRadarSourceAudit must exist with the full requested schema ─────────────────────────
  assert.ok(routeSource.includes('baseRadarSourceAudit'), 'baseRadarSourceAudit must exist')
  for (const field of ['runtimeCommitSha', 'discoverySourcesUsed', 'rawFromEachSource', 'rawTotalBeforeDedupe', 'afterDedupe', 'afterAgeWindow', 'afterLiquidityMinimum', 'afterValuationAvailable', 'afterValuationMin80k', 'afterValuationMax2m', 'holderCheckEligible', 'rejectionReasons', 'sourceBackoffSkippedCount', 'sourceBackoffTtlMs']) {
    assert.ok(routeSource.includes(field), `baseRadarSourceAudit must expose "${field}"`)
  }

  // ─── No leftover soft-fallback machinery ─────────────────────────────────────────────────────
  // "Base Radar deterministic valuation band only" — no soft caps, no maybe logic. The relaxed-
  // fallback path (a candidate shown anyway if it had activity, despite failing strict valuation/
  // liquidity) was explicitly retired; its reappearance would mean the reset regressed. Only checks
  // for actual functional identifiers, not the disclosure comments explaining the retirement (which
  // legitimately reference the removed names by history).
  for (const removed of ['fallbackCandidates', 'shouldHoldAsFallback']) {
    assert.ok(!routeSource.includes(removed), `deterministic-gate reset must remove "${removed}" — no soft caps, no maybe logic`)
  }
  // "Relaxed fallback" as an actual evidenceGaps entry (not the disclosure-comment history mentions
  // explaining why it was retired) must be gone — checked as the literal array-string form it used
  // to appear in.
  assert.ok(!routeSource.includes("'Relaxed fallback:"), 'the "Relaxed fallback" evidenceGaps entry must be removed — no soft caps, no maybe logic')
  // The fuzzy async token-age heuristic (fetchBaseTokenAgeDays/MAX_TOKEN_AGE_DAYS) is retired too —
  // asserted by absence of the actual function declaration, not just the name (which the disclosure
  // comment above it legitimately still mentions for history).
  assert.ok(!/function fetchBaseTokenAgeDays/.test(routeSource), 'the fuzzy token-age heuristic function must be removed — the $2M deterministic ceiling replaces it')
  assert.ok(!/const MAX_TOKEN_AGE_DAYS/.test(routeSource), 'the fuzzy token-age threshold constant must be removed')

  // ─── No accidental pre-filter slice/top-N cap ahead of the valuation/holder gates ────────────
  // The only small-number .slice(0, N) calls in this file must be for things that run AFTER
  // filtering (Clark AI verdicts on the top 5 already-final tokens, the debug nearMissSample log
  // cap) — never a hidden cap on the raw/ranked candidate pool itself before the gates run.
  const smallSlices = [...routeSource.matchAll(/\.slice\(0,\s*(\d+)\)/g)].map(m => Number(m[1])).filter(n => n <= 30)
  assert.ok(smallSlices.length <= 2, `found ${smallSlices.length} small-N .slice(0, <=30) calls (expected at most 2: the top-5 Clark verdict slice and the 30-entry nearMissSample log cap) — a new one could be an accidental pre-filter cap: ${smallSlices.join(', ')}`)

  // ─── Cache key includes the gate thresholds (stale-cache-after-threshold-change fix) ─────────
  assert.ok(routeSource.includes('MAIN_FEED_MIN_VALUATION_USD') && /cacheKeyBase\s*=[\s\S]{0,400}MAIN_FEED_MIN_VALUATION_USD/.test(routeSource), 'the cache key must fold in MAIN_FEED_MIN_VALUATION_USD so a threshold change can never serve a stale payload computed under the old gate')

  // ─── Discovery source resilience (explicitly requested: "Fix Base Radar discovery source
  // failures — not a threshold/UI issue") ────────────────────────────────────────────────────

  // Failed page does not wipe successful pages: each source is fetched independently
  // (fetchOneSource per spec) and only successful payloads (r.data) are pushed into
  // sourcePayloads/pooled — a failed source is simply absent from that list, not something that
  // clears or short-circuits the sources that already succeeded.
  assert.ok(/if \(r\.data\)/.test(routeSource) && /sourcePayloads\.push\(r\.data\)/.test(routeSource), 'only successful source payloads must be pushed into sourcePayloads — a failed page must not remove or block already-successful ones')
  assert.ok(!/if \(!r\.ok\)[\s\S]{0,80}(return|break|throw)/.test(routeSource), 'a single failed source page must never abort the whole discovery cycle')

  // Invalid page/cursor is skipped and audited, and requests never exceed a safe page cap: page
  // numbers are generated from fixed, always-positive constants (NEW_POOLS_PAGES_PER_REQUEST etc.),
  // never from unbounded/unvalidated user input, and the total requested page count is a fixed,
  // finite constant — not something that can grow unbounded from a malformed cursor.
  for (const constName of ['NEW_POOLS_PAGES_PER_REQUEST', 'TRENDING_PAGES_PER_REQUEST', 'VOLUME_POOLS_PAGES_PER_REQUEST']) {
    assert.ok(new RegExp(`const ${constName} = \\d+`).test(routeSource), `${constName} must be a fixed, safe page-count cap, not unbounded`)
  }
  // A failed/skipped page is captured with real per-page detail (source/page/status/errorName/
  // errorMessage/retryable/durationMs) — "audited" means real fields, not a swallowed catch.
  for (const field of ['source', 'page', 'urlOrEndpointName', 'status', 'errorName', 'errorMessage', 'retryable', 'durationMs', 'skippedByBackoff']) {
    assert.ok(routeSource.includes(field), `failedPages entries must expose "${field}" — real per-page failure detail, not a generic swallowed catch`)
  }

  // Degraded empty result is not cached as healthy: a 0-token result gets a short TTL
  // (EMPTY_RESULT_CACHE_TTL_MS), never the full 30-100s TTL a real result gets — this applies
  // regardless of WHY it's empty (gate-driven or discovery-degraded), so a degraded cycle can never
  // get echoed back to every refresh for the long window.
  assert.ok(/EMPTY_RESULT_CACHE_TTL_MS/.test(routeSource), 'a 0-token result must get a short cache TTL, not the full normal-result TTL')
  assert.ok(/tokens\.length > 0 \? \(shallowMode[\s\S]{0,120}\) : EMPTY_RESULT_CACHE_TTL_MS/.test(routeSource), 'the short TTL must actually gate on tokens.length, not just exist unused')

  // Successful fallback source can still populate candidates: getOrFetchCached's STALE result
  // (a real, previously-fetched payload served because the live fetch failed) is captured as a
  // genuine cacheStatus and still returned with ok:true/real data — a stale-but-real fallback still
  // reaches sourcePayloads and can still produce candidates, it isn't treated as a hard failure.
  assert.ok(/cacheStatus: result\.cache/.test(routeSource), 'a successful fetch (including a STALE fallback recovery) must carry its real cache status through, not be flattened to a generic success/failure boolean')
  assert.ok(/fallbackUsed = sourceResults\.some\(r => r\.cacheStatus === 'STALE'\)/.test(routeSource), 'fallbackUsed must reflect a real STALE-cache recovery, not always be false')

  // Per-source failure backoff exists (stops re-hammering an already-failing/rate-limited source
  // every single refresh) and the wave-based pacing that replaced the old unbounded burst.
  assert.ok(/discoverySourceFailureBackoff/.test(routeSource) && /DISCOVERY_FAILURE_BACKOFF_MS/.test(routeSource), 'a per-source failure backoff must exist so a failing source is not retried from a cold start on every single refresh')
  assert.ok(/DISCOVERY_CONCURRENCY_LIMIT/.test(routeSource) && /DISCOVERY_WAVE_DELAY_MS/.test(routeSource), 'discovery fetches must be paced (bounded concurrency + real inter-wave delay), not fired as one unbounded burst')

  // baseRadarDiscoverySourceAudit must exist with the full requested schema.
  assert.ok(routeSource.includes('baseRadarDiscoverySourceAudit'), 'baseRadarDiscoverySourceAudit must exist')
  for (const field of ['runtimeCommitSha', 'selectedChain', 'requestUrl', 'discoverySourcesUsed', 'pagesRequested', 'pagesSucceeded', 'pagesFailed', 'failedPages', 'rawCandidatesBeforeDedupe', 'rawCandidatesAfterDedupe', 'sourceCounts', 'degraded', 'degradedReason', 'cacheHit', 'fallbackUsed']) {
    assert.ok(routeSource.includes(field), `baseRadarDiscoverySourceAudit must expose "${field}"`)
  }

  // Only a significant (majority-or-more) source failure is allowed to drive the degraded-empty
  // UI message — a single failed page combined with a real gate-driven 0 must not be mislabeled.
  assert.ok(/discoveryDegradedSignificant = sourcesFailedCount >= Math\.ceil\(sourcesAttempted \/ 2\)/.test(routeSource), 'discoveryDegradedSignificant must require a majority-or-more failure, not any single failed page')

  // Gate still excludes below $80K / a real resolved below-30-holders count, even once raw
  // candidates load correctly — re-asserted here specifically in the context of the discovery-
  // resilience fix, so a future change to the fetch layer can't accidentally loosen the real
  // exclusions. Above $2M is deliberately NOT re-asserted as an exclusion here (it isn't one).
  assert.equal(passesMainFeedValuationMinGate(79_999), false)
  assert.equal(passesMainFeedHolderGate(29), false)

  // Source returns 50+ raw candidates then strict gate runs: the per-pool loop applies the same
  // liquidity -> valuation -> holder sequence regardless of how many raw candidates came in — no
  // separate/looser code path keyed on raw candidate volume.
  assert.ok(routeSource.includes('afterLiquidityGateCount') && routeSource.includes('afterValuationMin80kCount') && routeSource.includes('afterValuationMax2mCount'), 'the same liquidity -> valuation -> holder gate sequence must run regardless of raw candidate volume — no separate high-volume code path')

  // ─── $2M is a classification, not an exclusion (route-level) ────────────────────────────────
  assert.ok(/isEstablished = !passesMainFeedValuationMaxGate/.test(routeSource), 'above-$2M must be computed as a classification flag (isEstablished), not fed into a continue/exclusion')
  assert.ok(!/passesMainFeedValuationMaxGate\(valuation\.valueUsd\)\)\s*\{\s*droppedByMarketCapAbove2m\+\+;\s*continue/.test(routeSource), 'there must be no continue/exclusion site keyed on the max valuation gate')
  assert.ok(routeSource.includes('Established — above early range'), 'an above-$2M candidate must be labeled Established, not silently dropped')

  // ─── Holder provider unreachable creates an evidence gap, never a fake holder pass ───────────
  assert.ok(routeSource.includes('holder_provider_unreachable'), 'holder_provider_unreachable evidence gap must exist')
  assert.ok(/if \(typeof holderCount !== 'number'\) \{ holderProviderUnavailableCount\+\+; return true \}/.test(routeSource), 'a candidate with an unresolved holder count must be kept (return true), not excluded — but never silently marked verified')
  assert.ok(/holderVerified = typeof holderCount === 'number'/.test(routeSource), 'holderVerified must be strictly tied to an actually-resolved real number, never assumed true')
  assert.ok(/if \(!holderVerified\) return 'WATCH'/.test(routeSource), 'no token may be marked holder-verified (reach SAFE) when its holder count could not be confirmed — risk score must be capped')

  // ─── Degraded empty cache is not treated as healthy (already covered above, re-asserted here) ─
  assert.ok(/EMPTY_RESULT_CACHE_TTL_MS/.test(routeSource))

  // ─── Backoff skipped pages are audited ────────────────────────────────────────────────────────
  assert.ok(routeSource.includes('sourceBackoffSkippedCount') && routeSource.includes('sourceBackoffTtlMs'), 'backoff-skipped pages and the backoff TTL must both be surfaced in the audit')
  assert.ok(/DISCOVERY_FAILURE_BACKOFF_MS = 20_000/.test(routeSource), 'the backoff window must be short enough for a realistic refresh gap to actually retry (shortened from 45s to 20s per live report of prolonged degradation)')
}

console.log('test-base-radar-main-feed-gate.mjs: all assertions passed')

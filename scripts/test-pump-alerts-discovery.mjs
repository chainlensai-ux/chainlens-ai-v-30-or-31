import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateStage1Candidate, evaluateStage2Candidate, evaluateCandidatesInBatches } from '../app/api/pump-alerts/route.ts'

// PUMP DISCOVERY QUALITY + CHAIN STRICTNESS, DISCLOSED.
//
// Part 1 (eligibility) covers the original report: Pump Alerts was surfacing Aerodrome and other
// established Base tokens. Part 2 (chain provenance) covers the follow-up full Radar/Pump audit,
// which found that once this route went multi-chain, every candidate was still hardcoded to Base —
// so ETH/Robinhood tokens were published, scanned, reported and reasoned about as Base tokens.
//
// These exercise the real exported stage functions the GET handler calls, not mocks.

const base = {
  chain: 'base',
  symbol: 'TEST', name: 'Test Token', addr: '0xabc0000000000000000000000000000000000a',
  poolAddr: '0xpool000000000000000000000000000000000a',
  price: 0.002, change24h: 40, volume: 200_000, liquidity: 50_000,
  fdv: 900_000, marketCap: null, ageDays: 20,
}

// ─── Part 1: eligibility filtering ──────────────────────────────────────────

// AERO exclusion
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'AERO', name: 'Aerodrome Finance' })
  assert.equal(r.passed, false, 'AERO must never pass stage 1')
  assert.equal(r.audit.categoryBlocked, true)
  assert.equal(r.audit.exclusionReason, 'establishedOrCategoryBlocked')
}

// Stablecoin exclusion
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'USDC', name: 'USD Coin', fdv: 40_000_000_000 })
  assert.equal(r.passed, false, 'USDC must never pass stage 1')
  assert.equal(r.audit.categoryBlocked, true)
}

// Wrapped-asset exclusion
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'WETH', name: 'Wrapped Ether' })
  assert.equal(r.passed, false, 'WETH must never pass stage 1')
  assert.equal(r.audit.categoryBlocked, true)
}

// High-FDV exclusion
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'BIGCAP', name: 'Big Cap Token', fdv: 50_000_000 })
  assert.equal(r.passed, false, 'a token above the FDV ceiling must be excluded')
  assert.equal(r.audit.exclusionReason, 'capExceedsLowCapCeiling')
  assert.equal(r.audit.categoryBlocked, false, 'must be excluded for cap, not miscategorized as established')
}

// Missing cap data must not silently pass as low-cap
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'NOCAP', name: 'No Cap Data', fdv: null, marketCap: null })
  assert.equal(r.passed, false)
  assert.equal(r.audit.exclusionReason, 'capDataMissing')
}

// Liquidity / volume floors
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'THIN', name: 'Thin Token', liquidity: 500 })
  assert.equal(r.passed, false)
  assert.equal(r.audit.exclusionReason, 'liquidityBelowMinimum')
}
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'QUIET', name: 'Quiet Token', volume: 100 })
  assert.equal(r.passed, false)
  assert.equal(r.audit.exclusionReason, 'volumeBelowMinimum')
}

// LP-token symbol pattern blocked without an exact-symbol denylist hit
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'AERO-USDC-LP', name: 'Aerodrome LP Vault' })
  assert.equal(r.passed, false)
  assert.equal(r.audit.categoryBlocked, true)
}

// Valid low-cap token passes stage 1
let stage1Candidate
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'MOON', name: 'Moon Token' })
  assert.equal(r.passed, true, 'a genuine low-cap, liquid, traded token must pass stage 1')
  stage1Candidate = r.candidate
}

// Missing 14d must exclude — never faked from 24h data. (Reason renamed by the 14D-EVIDENCE-LADDER
// fix: with fallback tiers available, "no evidence qualified" is the honest label for a candidate
// that neither an exact source nor corroborated momentum could back.)
{
  const r = evaluateStage2Candidate(stage1Candidate, null)
  assert.equal(r.included, false, 'missing 14d data must exclude the candidate, never fake it')
  assert.ok(
    r.audit.exclusionReason === 'missing14dData' || r.audit.exclusionReason === 'noQualifyingPumpEvidence',
    `unexpected exclusion reason: ${r.audit.exclusionReason}`,
  )
  assert.equal(r.audit.priceChange14dPct, null)
}

// Below-threshold 14d excludes
{
  const r = evaluateStage2Candidate(stage1Candidate, 10)
  assert.equal(r.included, false)
  assert.equal(r.audit.exclusionReason, 'change14dBelowMinimum')
}

// Valid low-cap confirmed 14d pump is included
{
  const r = evaluateStage2Candidate(stage1Candidate, 60)
  assert.equal(r.included, true, 'a confirmed 14d pump on an eligible low-cap token must be included')
  assert.equal(r.audit.excluded, false)
  assert.equal(r.audit.qualifiesAs14dPump, true)
  assert.equal(r.audit.qualifiesAsLowCap, true)
  assert.ok(r.audit.finalRankScore != null, 'an included candidate must carry a real rank score')
  assert.equal(r.alert.change14d, 60)
  assert.match(r.alert.qualifyingReason, /60\.0% over 14d/)
  assert.match(r.alert.qualifyingReason, /low-cap/)
}

// ─── Part 2: chain provenance and strictness ────────────────────────────────

// An ETH candidate must stay ETH end-to-end — never be relabelled Base.
{
  const r1 = evaluateStage1Candidate({ ...base, chain: 'eth', symbol: 'ETHMOON', name: 'Eth Moon' })
  assert.equal(r1.passed, true)
  assert.equal(r1.candidate.chain, 'eth', 'stage 1 must preserve the candidate\'s real chain')
  const r2 = evaluateStage2Candidate(r1.candidate, 80)
  assert.equal(r2.included, true)
  assert.equal(r2.alert.chain, 'eth', 'an ETH token must never be published as a Base token')
  assert.equal(r2.alert.chainId, 1, 'chainId must match the real chain')
  assert.equal(r2.audit.chainSlug, 'eth')
  assert.equal(r2.audit.chainId, 1)
}

// A Robinhood candidate keeps its own chain + chainId.
{
  const r1 = evaluateStage1Candidate({ ...base, chain: 'robinhood', symbol: 'RHMOON', name: 'RH Moon' })
  assert.equal(r1.passed, true)
  const r2 = evaluateStage2Candidate(r1.candidate, 45)
  assert.equal(r2.included, true)
  assert.equal(r2.alert.chain, 'robinhood')
  assert.equal(r2.alert.chainId, 4663, 'Robinhood Chain ID must be 4663, matching robinhoodChainConfig')
}

// Base stays Base with the correct chainId.
{
  const r = evaluateStage2Candidate(stage1Candidate, 30)
  assert.equal(r.alert.chain, 'base')
  assert.equal(r.alert.chainId, 8453)
}

// Per-chain ceiling is the STRICTER of the chain limit and the env cap — never the most permissive
// across requested chains. A $30M token is over Base's $20M ceiling but under ETH's $50M one.
{
  const onBase = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'MIDCAP', name: 'Mid Cap', fdv: 30_000_000 })
  assert.equal(onBase.passed, false, 'a $30M token must be rejected on Base ($20M ceiling)')
  assert.equal(onBase.audit.exclusionReason, 'capExceedsLowCapCeiling')
  assert.equal(onBase.audit.chainSlug, 'base', 'the rejection must be attributed to the real chain')
}

// Every audit row carries the full chain-strict identity the audit spec requires.
{
  const r = evaluateStage1Candidate({ ...base, chain: 'eth', symbol: 'AERO', name: 'Aerodrome' }, 'req_test_1')
  assert.equal(r.passed, false)
  for (const field of ['requestId', 'chainSlug', 'chainId', 'pairAddress', 'source', 'token', 'symbol']) {
    assert.ok(field in r.audit, `eligibility audit must include ${field}`)
  }
  assert.equal(r.audit.requestId, 'req_test_1', 'requestId must be threaded into the audit row')
  assert.equal(r.audit.pairAddress, base.poolAddr)
}

// ─── Part 3: route-level chain-strictness invariants (static source assertions) ──
// These guard the orchestration that the pure stage functions above can't reach.
const routeSrc = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// No ALERT or AUDIT row may hardcode Base. (The one legitimate `chain: 'base'` left in the route
// is the Base-scoped shared-cache fallback, which really is Base — asserted separately below.)
assert.doesNotMatch(routeCode, /chain: 'base', symbol:/, 'audit rows must carry the candidate\'s real chain, not a hardcoded Base')
assert.doesNotMatch(routeCode, /contract: c\.addr, chain: 'base'/, 'published alerts must carry the candidate\'s real chain')
assert.match(routeCode, /chainPools\.push\(\{ chain: 'base', pools, included \}\)/, 'the only remaining hardcoded Base is the Base-scoped cache fallback, which is correct')
assert.match(routeCode, /token: c\.addr, tokenAddress: c\.addr, name: c\.name, chain, chainSlug: chain, chainId/, 'audit rows must be built from the real chain variable')
assert.match(routeCode, /networks\/\$\{network\}\/pools\/\$\{poolAddress\}\/ohlcv/, '14d OHLCV must be fetched from the candidate\'s own network, not a hardcoded one')
assert.doesNotMatch(routeCode, /networks\/base\/pools\/\$\{poolAddress\}/, 'the hardcoded base OHLCV URL must be gone')
assert.match(routeCode, /const cacheKey = `pump:v2:\$\{plan\}:\$\{\[\.\.\.chains\]\.sort\(\)\.join\('\+'\)\}`/, 'cache key must include schema version and the requested chain set')
assert.match(routeCode, /const dedupeKey = `\$\{chain\}:\$\{addr\}`/, 'dedupe identity must be chain-scoped')
assert.match(routeCode, /\$\{a\.chain\}:\$\{a\.contract\.toLowerCase\(\)\}/, 'rotation identity must be chain-scoped')
assert.match(routeCode, /chainsSucceeded/, 'provider failures must be reported per chain, not swallowed')
assert.match(routeCode, /pumpDiscoverySummary/, 'a request-level discovery audit must be returned')

// ─── Part 4: chain-strict handoff (Scan / Report / Clark) ───────────────────
const pageSrc = fs.readFileSync(new URL('../app/terminal/pump-alerts/page.tsx', import.meta.url), 'utf8')
const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.match(pageCode, /alert\.chain === 'base' \? '' : `&chain=\$\{alert\.chain\}`/, 'Scan handoff must pass the real chain to Token Scanner')
assert.doesNotMatch(pageCode, /chain: 'base',/, 'the report handoff must not hardcode chain: base')
assert.match(pageCode, /chain: alert\.chain,/, 'the report handoff must pass the alert\'s real chain')
assert.match(pageCode, /`Chain: \$\{chainName\}`/, 'the Clark prompt must state the real chain')
assert.match(pageCode, /setFeedError/, 'provider failures must surface in the UI, not be swallowed')
assert.doesNotMatch(pageCode, /catch \{\s*setAlerts\(\[\]\)\s*\}/, 'a failed refresh must not blank the feed')

// ─── Part 5: URGENT loading audit (route-level static assertions) ──────────
// Locks the fixes for the reported "counters all 0" / Base Radar stuck-loading incident: a
// distinct 14d-provider-outage signal (vs. an honest empty filter result), a truthful finalState
// on every response, and the stale-empty-cache bug that could re-serve a degraded cycle's "no
// signals" result for the full 90s TTL even after the provider recovered.
{
  const routeSrc2 = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
  const routeCode2 = routeSrc2.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  assert.match(routeCode2, /fourteenDayDataUnavailable/, 'a systemic 14d-provider-failure signal must exist, distinct from an honest empty filter result')
  assert.match(routeCode2, /reason === 'httpError' \|\| r\.reason === 'fetchError'/, 'the 14d outage detector must only count real provider failures, never a genuinely young pool (tooYoung) as an outage')
  assert.match(
    routeCode2,
    /finalState:.*'providerUnavailable' \| 'noRawCandidates' \| 'noEligibleLowCapCandidates'/,
    'every response must report one of the truthful, specific final states',
  )
  assert.match(routeCode2, /pumpAlertsLoadAudit:/, 'the exact requested pumpAlertsLoadAudit object must be returned')
  for (const field of [
    'requestId', 'route', 'status', 'totalDurationMs', 'cacheHit', 'providersAttempted', 'providersSucceeded',
    'providersFailed', 'candidatesRaw', 'candidatesAfterDedupe', 'candidatesAfterCategoryFilter',
    'candidatesAfterLowCapFilter', 'candidatesAfter14dPumpFilter', 'candidatesAfterLiquidityVolumeFilter',
    'candidatesRendered', 'rejectedReasons', 'finalState', 'errorShownToUser',
  ]) {
    assert.ok(routeCode2.includes(field), `pumpAlertsLoadAudit must include ${field}`)
  }

  // STALE-EMPTY-CACHE FIX: a degraded/empty cycle must get a short TTL, not the full 90s one —
  // otherwise a transient provider hiccup looks like "no pumps" for a minute and a half after
  // the provider has already recovered.
  assert.match(
    routeCode2,
    /const cacheTtlMs = finalState === 'finalRendered' \|\| finalState === 'providerDegradedPartial' \? PUMP_ROUTE_CACHE_TTL_MS : 10_000/,
    'a non-clean-success cycle must not be cached at the full TTL',
  )
  assert.doesNotMatch(routeCode2, /pumpCache\.set\(cacheKey, \{ exp: Date\.now\(\) \+ PUMP_ROUTE_CACHE_TTL_MS, payload \}\)/, 'the flat-TTL cache write must be gone — it is what let a degraded empty cycle be re-served for the full 90s')
}

// ─── Part 6: frontend truthful empty state (static assertions) ─────────────
{
  const pageSrc2 = fs.readFileSync(new URL('../app/terminal/pump-alerts/page.tsx', import.meta.url), 'utf8')
  const pageCode2 = pageSrc2.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(pageCode2, /finalState === 'providerUnavailable'/, 'the empty state must distinguish a provider outage from an honest empty filter result')
  assert.match(pageCode2, /finalState === 'noRawCandidates'/, 'the empty state must distinguish zero raw candidates from over-filtering')
  assert.match(pageCode2, /finalState === 'noEligibleLowCapCandidates'/, 'the empty state must distinguish "nothing eligible" from a budget cutoff or an exhausted search')
  assert.match(pageCode2, /finalState === 'providerBudgetExhausted'/, 'the empty state must say when evaluation stopped early due to budget, not exhaustion')
  assert.match(pageCode2, /finalState === 'allCandidatesExhaustedNoMomentum'/, 'the empty state must distinguish a truly exhausted search from a truncated one')
  assert.match(pageCode2, /candidateAudit/, 'the frontend must consume the candidate-evaluation-funnel audit for the empty-state breakdown')
  assert.match(pageCode2, /interface PumpCandidateEvaluationAudit/, 'the frontend must declare the exact candidate-evaluation audit shape')
}

// ─── Part 7: Pump Alerts quality audit (reported live: SOL/Base rendered as a low-cap pump card
// alongside a contradictory "14d pump data unavailable" page warning) ────────────────────────────

// SOL on Base must be excluded as a major/wrapped/bridged asset — this is the exact reported leak.
{
  const r = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'SOL', name: 'Solana', fdv: 21_200_000 })
  assert.equal(r.passed, false, 'SOL must never pass stage 1, on any chain')
  assert.equal(r.audit.categoryBlocked, true, 'SOL must be excluded as a category-blocked major, not merely over the cap')
}
// A bridged/wrapped SOL representation with a different symbol must still be caught by name.
{
  const r = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'BSOL', name: 'Bridged Solana', fdv: 900_000 })
  assert.equal(r.passed, false, 'a bridged Solana representation must be excluded by name, even with an unlisted symbol')
  assert.equal(r.audit.categoryBlocked, true)
}

// The other explicitly required majors/wrapped/bridged assets must all be excluded.
for (const [symbol, name] of [
  ['ETH', 'Ethereum'], ['WETH', 'Wrapped Ether'], ['CBETH', 'Coinbase Wrapped Staked ETH'], ['WSTETH', 'Wrapped stETH'],
  ['BTC', 'Bitcoin'], ['WBTC', 'Wrapped Bitcoin'], ['CBBTC', 'Coinbase Wrapped BTC'],
  ['USDC', 'USD Coin'], ['USDT', 'Tether'], ['DAI', 'Dai Stablecoin'],
  ['AERO', 'Aerodrome Finance'],
]) {
  const r = evaluateStage1Candidate({ ...base, symbol, name, fdv: 900_000 })
  assert.equal(r.passed, false, `${symbol} must be excluded as a major/wrapped/bridged/stable asset`)
  assert.equal(r.audit.categoryBlocked, true, `${symbol} must be flagged categoryBlocked, not just filtered on cap`)
}

// A token above the configured max FDV must be excluded even when everything else about it looks
// like a valid low-cap pump candidate — the exact reported $21.2M-on-Base scenario, symbol clean.
{
  const r = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'BIGMOVE', name: 'Big Move Token', fdv: 21_200_000 })
  assert.equal(r.passed, false, 'a $21.2M FDV token must be excluded on Base (ceiling is min($5M default, $20M chain) = $5M)')
  assert.equal(r.audit.exclusionReason, 'capExceedsLowCapCeiling')
}

// Fallback (momentum) mode still applies category and low-cap filters — a Stage-1-blocked candidate
// never reaches evaluateStage2Candidate at all, so a momentum_fallback ResolvedEvidence can only
// ever apply to a candidate that already cleared category + cap + liquidity + volume + age.
{
  const majorFdvBlocked = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'SOL', name: 'Solana', fdv: 900_000 })
  assert.equal(majorFdvBlocked.passed, false, 'SOL must be blocked at stage 1 regardless of how small its FDV looks')
  // A low-cap, non-major candidate legitimately qualifying via momentum fallback still passes.
  const r2 = evaluateStage2Candidate(stage1Candidate, null, 'req_test_fallback', {
    kind: 'momentum_fallback', confirmedChange24hPct: 22.5, evidenceParts: ['confirmed 24h move ≥ 22.5%'],
  })
  assert.equal(r2.included, true, 'a low-cap candidate with qualifying momentum-fallback evidence must be included')
  assert.equal(r2.alert.evidenceGrade, 'momentum_fallback')
  assert.equal(r2.alert.change14d, null, 'momentum fallback must never fabricate a 14d number')
  assert.equal(r2.audit.lowCapQualified, true, 'low-cap rule must still be recorded true for a fallback-qualified candidate')
}

// Valid low-cap token with exact 14d passes, and its audit records the full eligibility shape.
{
  const r = evaluateStage2Candidate(stage1Candidate, 60, 'req_test_shape')
  assert.equal(r.included, true)
  assert.equal(r.alert.evidenceGrade, 'exact')
  for (const field of [
    'symbol', 'name', 'chain', 'tokenAddress', 'fdvUsd', 'marketCapUsd', 'liquidityUsd',
    'priceChange14dPct', 'evidenceMode', 'category', 'categoryBlocked', 'lowCapQualified',
    'excluded', 'exclusionReason',
  ]) {
    assert.ok(field in r.audit, `per-token eligibility audit must include ${field}`)
  }
  assert.equal(r.audit.evidenceMode, 'exact')
  assert.equal(r.audit.tokenAddress, stage1Candidate.addr)
}

// ─── Part 8: 14d-state contradiction fix (route-level static assertions) ────────────────────────
// Reported live: a card reading "Exact 14d" rendered under a page-wide "14d pump data unavailable
// from provider" warning in the SAME response. The exposed fourteenDayDataUnavailable field and
// finalState must both be reconciled against the ladder's REAL final outcome (alerts.length +
// exact/fallback qualified counts), never the raw pre-fallback GT-OHLCV-only signal.
{
  const routeSrc3 = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
  const routeCode3 = routeSrc3.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  assert.match(
    routeCode3,
    /fourteenDayDataUnavailable: fourteenDayDataUnavailable && alerts\.length === 0\s*\n\s*&& evidenceAudit\.exact14dQualified \+ evidenceAudit\.fallbackMomentumQualified === 0,/,
    'the exposed fourteenDayDataUnavailable field must require BOTH zero rendered alerts AND zero qualified evidence across the whole ladder — a card with real evidence must never coexist with this being true',
  )
  assert.match(
    routeCode3,
    /: stage1Passed\.length === 0 \? 'noEligibleLowCapCandidates'\s*\n\s*: alerts\.length > 0 \? \(evidenceAudit\.degradedMode \? 'providerDegradedPartial' : 'finalRendered'\)\s*\n\s*: stoppedReason === 'budgetExhausted' \? 'providerBudgetExhausted'\s*\n\s*: 'allCandidatesExhaustedNoMomentum'/,
    'finalState must key off the real post-ladder outcome (rendered alerts + why evaluation stopped), never a raw pre-fallback signal',
  )
  assert.match(
    routeCode3,
    /fourteenDayProviderDegraded: fourteenDayDataUnavailable && alerts\.length > 0,/,
    'a partial 14d-provider failure that still rendered results must be exposed separately from the full blackout, for a small degraded note rather than a full-page warning',
  )
}

// ─── Part 9: 429-aware retry on the evidence ladder (route-level static assertions) ─────────────
// Reported live (follow-up to Part 8's contradiction fix): once the contradiction was gone, the
// feed went to a genuine, honest full blackout ("no fallback provider could confirm momentum
// either") on every refresh — not just once. Root cause: fetchPoolFourteenDayChange and
// fetchDexScreenerPairMomentum each had ZERO retry, so a single 429 from GeckoTerminal's shared,
// deployment-wide rate-limit budget (this route fires up to 4 concurrent OHLCV requests per cycle
// on top of Base Radar/other Pump Alerts traffic) permanently failed that candidate for the whole
// cycle — the exact bug class already fixed for Base Radar's discovery fetcher.
{
  const routeSrc4 = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
  assert.match(
    routeSrc4,
    /const retryDelayMs = first\.httpStatus === 429 \? 1800 \+ Math\.floor\(Math\.random\(\) \* 400\) : 400/,
    'the primary 14d OHLCV fetch must retry once with a 429-aware backoff, not fail permanently on the first attempt',
  )
  assert.match(routeSrc4, /async function fetchPoolFourteenDayChangeOnce/, 'the retry wrapper must sit on top of a single-attempt fetcher, not duplicate the fetch logic')

  const evidenceSrc = fs.readFileSync(new URL('../lib/server/pump14dEvidence.ts', import.meta.url), 'utf8')
  assert.match(
    evidenceSrc,
    /const retryDelayMs = first\.httpStatus === 429 \? 1800 \+ Math\.floor\(Math\.random\(\) \* 400\) : 400/,
    'the DexScreener momentum-fallback fetch — the tier specifically meant to rescue a GT OHLCV outage — must also retry once with a 429-aware backoff',
  )
}

// ─── Part 10: sustained-rate-limit fix — success-result caching (route-level static assertions) ──
// Reported live: the total-blackout message persisted across repeated refreshes even AFTER the
// 429-aware retry landed. Root cause: every refresh cycle re-fetched OHLCV/momentum data for every
// candidate from scratch with zero caching, and a failed cycle was itself cached for only 10s, so
// the identical full request burst re-fired every ~10s across every user hitting the route —
// never letting GeckoTerminal's shared rate-limit budget recover. A single retry only survives one
// short burst, not a sustained one caused by the route's own request pattern.
{
  const routeSrc5 = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
  assert.match(routeSrc5, /const fourteenDayResultCache = new Map/, 'successful 14d OHLCV results must be cached so every refresh cycle does not re-fetch from scratch')
  assert.match(routeSrc5, /if \(cached && Date\.now\(\) - cached\.cachedAt < FOURTEEN_DAY_CACHE_TTL_MS\) return cached\.result/, 'a fresh-enough cached OHLCV result must be served without a network call')
  assert.match(routeSrc5, /if \(final\.reason === 'ok'\) fourteenDayResultCache\.set/, 'only successful results may be cached — failures must still retry fresh next cycle')

  const evidenceSrc2 = fs.readFileSync(new URL('../lib/server/pump14dEvidence.ts', import.meta.url), 'utf8')
  assert.match(evidenceSrc2, /const dexScreenerMomentumCache = new Map/, 'successful DexScreener momentum fetches must be cached for the same reason')
  assert.match(evidenceSrc2, /if \(final\?\.ok\) dexScreenerMomentumCache\.set/, 'only successful momentum fetches may be cached — failures must still retry fresh next cycle')
}

// ─── Part 11: candidate-evaluation-depth pipeline (URGENT fix request) ─────────────────────────
// Reported live: candidatesRaw=20 but every evidence tier only ever attempted 3 — the feed went
// dark once those 3 failed, even though 17 more raw candidates existed. evaluateCandidatesInBatches
// is the extracted, pure, network-free stepping/stopping algorithm GET's Stage 2 actually calls —
// these tests drive it with a fake per-batch evaluator so the exact reported scenarios are provable
// without mocking fetch or GeckoTerminal.

// 20 raw candidates, first 3 provider-fail, candidate index 7 ("the 8th candidate") qualifies —
// evaluation must keep going past the first 3 failures and render the later winner.
{
  const rankedIndices = Array.from({ length: 20 }, (_, i) => i)
  const evaluatedBatches = []
  const outcome = await evaluateCandidatesInBatches(
    rankedIndices,
    { targetResults: 1, maxCandidatesEvaluated: 50, minResultsBeforeStop: 1, batchSize: 1 },
    async batchIndices => {
      evaluatedBatches.push(batchIndices)
      const qualifiedInBatch = batchIndices.includes(7) ? 1 : 0
      return { qualifiedInBatch }
    },
  )
  assert.equal(outcome.stoppedReason, 'targetReached', 'evaluation must stop once the target is reached, not run past it')
  assert.equal(outcome.qualifiedCount, 1, 'the qualifying candidate at index 7 must be counted')
  assert.equal(outcome.evaluatedCount, 8, 'evaluation must have continued through index 7 (8 candidates), never stopping at the first 3 failures')
  assert.deepEqual(evaluatedBatches.flat(), [0, 1, 2, 3, 4, 5, 6, 7], 'candidates must be evaluated in order, and the first 3 failing must not halt the loop')
}

// First 3 fail but more candidates remain (none of which are ever tried in a config that only
// evaluates 3) — must be reported as budget-exhausted, never as a provider/data-unavailable blackout.
{
  const rankedIndices = Array.from({ length: 20 }, (_, i) => i)
  const outcome = await evaluateCandidatesInBatches(
    rankedIndices,
    { targetResults: 5, maxCandidatesEvaluated: 3, minResultsBeforeStop: 5, batchSize: 3 },
    async () => ({ qualifiedInBatch: 0 }),
  )
  assert.equal(outcome.evaluatedCount, 3, 'only the budget-capped 3 candidates should have been evaluated')
  assert.equal(outcome.stoppedReason, 'budgetExhausted', 'stopping with more eligible candidates left and too few qualified must be reported as budget-exhausted, not as a provider outage')
}
// The route-level finalState union no longer has a "data unavailable" catch-all for this case —
// confirm the removed literal is genuinely gone, not just renamed in a comment.
assert.doesNotMatch(routeCode, /'fourteenDayUnavailable'/, 'the misleading blanket "14d data unavailable" finalState must be gone — replaced by specific, truthful reasons')

// Provider budget genuinely exhausted (more candidates existed than the cap allowed, and too few
// qualified) — distinct from a truly exhausted search.
{
  const rankedIndices = Array.from({ length: 50 }, (_, i) => i)
  const outcome = await evaluateCandidatesInBatches(
    rankedIndices,
    { targetResults: 10, maxCandidatesEvaluated: 20, minResultsBeforeStop: 5, batchSize: 5 },
    async batchIndices => ({ qualifiedInBatch: batchIndices.includes(0) ? 2 : 0 }),
  )
  assert.equal(outcome.evaluatedCount, 20, 'evaluation must stop at the configured MAX_CANDIDATES_EVALUATED cap')
  assert.equal(outcome.qualifiedCount, 2, 'only the 2 qualified before the cap should count')
  assert.equal(outcome.stoppedReason, 'budgetExhausted', '2 qualified < minResultsBeforeStop(5) with more candidates left beyond the cap must report budget-exhausted')
}

// All candidates genuinely exhausted (no truncation — every eligible candidate really was checked)
// and none qualified — a true, complete empty result, distinct from a budget cutoff.
{
  const rankedIndices = Array.from({ length: 12 }, (_, i) => i)
  const outcome = await evaluateCandidatesInBatches(
    rankedIndices,
    { targetResults: 10, maxCandidatesEvaluated: 50, minResultsBeforeStop: 5, batchSize: 4 },
    async () => ({ qualifiedInBatch: 0 }),
  )
  assert.equal(outcome.evaluatedCount, 12, 'every eligible candidate must have been evaluated — nothing left untried')
  assert.equal(outcome.qualifiedCount, 0)
  assert.equal(outcome.stoppedReason, 'allCandidatesExhausted', 'a fully-evaluated pool with zero qualifiers must be reported as genuinely exhausted, not budget-exhausted')
}

// Majors/stables/wrapped assets are filtered at Stage 1 — before any evidence ladder / OHLCV call
// is ever made for them. Reconfirmed here against the specific "filtered before OHLCV" requirement.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'SOL', name: 'Solana', fdv: 900_000 })
  assert.equal(r.passed, false, 'SOL must never reach Stage 2 (the evidence/OHLCV stage) at all')
}

// High-FDV tokens are filtered at Stage 1 — before any evidence ladder / OHLCV call.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'WHALE', name: 'Whale Cap', fdv: 100_000_000 })
  assert.equal(r.passed, false, 'a high-FDV token must never reach Stage 2 (the evidence/OHLCV stage) at all')
  assert.equal(r.audit.exclusionReason, 'capExceedsLowCapCeiling')
}

// No wrong-chain pool is accepted: a candidate's chain is fixed at Stage 1 and carried unchanged
// through Stage 2 — an ETH candidate can never be evaluated or published as Base/Robinhood.
{
  const r1 = evaluateStage1Candidate({ ...base, chain: 'eth', symbol: 'ETHCHK', name: 'Eth Check' })
  assert.equal(r1.passed, true)
  assert.equal(r1.candidate.chain, 'eth')
  const r2 = evaluateStage2Candidate(r1.candidate, 60)
  assert.equal(r2.included, true)
  assert.equal(r2.alert.chain, 'eth', 'the published alert must keep the exact chain the candidate was discovered on')
  assert.notEqual(r2.alert.chain, 'base', 'an ETH candidate must never be accepted as a Base pool')
}

console.log('test-pump-alerts-discovery.mjs: all assertions passed')

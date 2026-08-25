import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateStage1Candidate, evaluateStage2Candidate, evaluateCandidatesInBatches, evaluateLiveMomentum } from '../app/api/pump-alerts/route.ts'

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
  price: 0.002, change24h: 40, change6h: null, change1h: null, volume: 200_000, liquidity: 50_000,
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

// Missing 14d evidence AND no live-momentum evidence resolved must exclude — never faked from 24h
// data. (Reason renamed by the ELIGIBILITY-MODEL fix: "rejectedNoMomentum" is the honest label for
// a candidate that neither an exact source nor live momentum evidence could back.)
{
  const r = evaluateStage2Candidate(stage1Candidate, null)
  assert.equal(r.included, false, 'missing 14d data with no resolved evidence must exclude the candidate, never fake it')
  assert.equal(r.audit.exclusionReason, 'rejectedNoMomentum')
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

// Live momentum mode still applies category and low-cap filters — a Stage-1-blocked candidate
// never reaches evaluateStage2Candidate at all, so a live_momentum ResolvedEvidence can only
// ever apply to a candidate that already cleared category + cap + liquidity + volume + age.
{
  const majorFdvBlocked = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'SOL', name: 'Solana', fdv: 900_000 })
  assert.equal(majorFdvBlocked.passed, false, 'SOL must be blocked at stage 1 regardless of how small its FDV looks')
  // A low-cap, non-major candidate legitimately qualifying via live momentum still passes.
  const r2 = evaluateStage2Candidate(stage1Candidate, null, 'req_test_livemomentum', {
    kind: 'live_momentum',
    verdict: { qualified: true, changeWindow: '24h', changeValuePct: 22.5, volumeLiquidityRatio: 0.8, evidenceParts: ['24h change +22.5%'] },
  })
  assert.equal(r2.included, true, 'a low-cap candidate with qualifying live-momentum evidence must be included')
  assert.equal(r2.alert.evidenceGrade, 'live_momentum')
  assert.equal(r2.alert.evidenceSource, 'live_momentum')
  assert.equal(r2.alert.change14d, null, 'live momentum must never fabricate a 14d number')
  assert.equal(r2.audit.lowCapQualified, true, 'low-cap rule must still be recorded true for a live-momentum-qualified candidate')
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

// ─── Part 12: candidate-funnel accuracy fix (route-level static assertions) ────────────────────
// Reported live: the new funnel breakdown itself showed "passed liquidity/volume: 91" while only
// 14 candidates were ever evidence-checked — a real reconciliation bug, not a display quirk.
// rawCount includes every pool GeckoTerminal returned, but a pool with no resolvable base-token
// id/address, or a duplicate of one already seen, is skipped before evaluateStage1Candidate ever
// runs and never gets an audit row — so approximating survivors as rawCount minus known exclusion
// reasons silently assumed every raw pool reached Stage 1, which GeckoTerminal's pool lists (full
// of stale/malformed/duplicate entries) never guarantee.
{
  const routeSrc6 = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
  const routeCode6 = routeSrc6.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(routeCode6, /let skippedBeforeStage1 = 0/, 'pools skipped before Stage 1 evaluation must be counted, not silently dropped from the funnel math')
  assert.match(routeCode6, /if \(!tokenId\) \{ skippedBeforeStage1 \+= 1; continue \}/, 'a pool with no resolvable token id must be counted as skipped-before-Stage-1')
  assert.match(routeCode6, /if \(!meta\?\.attributes\?\.address\) \{ skippedBeforeStage1 \+= 1; continue \}/, 'a pool with no resolvable token address must be counted as skipped-before-Stage-1')
  assert.match(routeCode6, /if \(seen\.has\(dedupeKey\)\) \{ skippedBeforeStage1 \+= 1; continue \}/, 'a duplicate pool must be counted as skipped-before-Stage-1')
  assert.match(
    routeCode6,
    /const candidatesReachingStage1 = rawCount - skippedBeforeStage1/,
    'the funnel math must start from candidates that actually reached Stage 1, not the raw pool count',
  )
  assert.match(
    routeCode6,
    /const lowCapCandidatesCount = Math\.max\(0, candidatesReachingStage1 - categoryFilteredCount - capDataMissingCount - capExceedsCount\)/,
    'lowCapCandidates must be derived from candidatesReachingStage1, not the inflated raw pool count',
  )
}

// ─── Part 13: live momentum eligibility model (URGENT fix request) ─────────────────────────────
// Reported live: 12 candidates reached evidence checking, 0 qualified exact, 0 qualified fallback —
// the feed went empty even though GeckoTerminal's own pool data already carries the 24h/6h/1h
// momentum and volume/liquidity figures needed to evaluate a candidate WITHOUT any exact 7d/14d
// proof. evaluateLiveMomentum is the new, pure, network-free evaluator for that — these tests drive
// it directly against real Stage1Candidate objects produced by evaluateStage1Candidate.

// Qualifies on 24h change with sufficient volume/liquidity ratio.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'PUMP1', name: 'Pump One', change24h: 12, volume: 50_000, liquidity: 80_000 })
  assert.equal(r.passed, true)
  const verdict = evaluateLiveMomentum(r.candidate)
  assert.equal(verdict.qualified, true, 'a real 24h move with real volume relative to liquidity must qualify')
  assert.equal(verdict.changeWindow, '24h')
}

// Falls back to 6h momentum when 24h is below threshold.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'PUMP2', name: 'Pump Two', change24h: 3, change6h: 5, volume: 50_000, liquidity: 80_000 })
  assert.equal(r.passed, true)
  const verdict = evaluateLiveMomentum(r.candidate)
  assert.equal(verdict.qualified, true, '6h momentum must qualify when 24h does not clear its own bar')
  assert.equal(verdict.changeWindow, '6h')
}

// Falls back to 1h momentum when both 24h and 6h are below threshold.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'PUMP3', name: 'Pump Three', change24h: 1, change6h: 1, change1h: 3, volume: 50_000, liquidity: 80_000 })
  assert.equal(r.passed, true)
  const verdict = evaluateLiveMomentum(r.candidate)
  assert.equal(verdict.qualified, true, '1h momentum must qualify as the last resort when 24h/6h do not')
  assert.equal(verdict.changeWindow, '1h')
}

// No momentum on any window → rejected, never faked.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'FLAT', name: 'Flat Token', change24h: 1, change6h: 1, change1h: 1, volume: 50_000, liquidity: 80_000 })
  assert.equal(r.passed, true)
  const verdict = evaluateLiveMomentum(r.candidate)
  assert.equal(verdict.qualified, false)
  assert.equal(verdict.reason, 'noMomentum')
}

// Real momentum but volume is NOT actually expanding relative to liquidity — a stale price delta
// on a barely-traded pool must not qualify just because a number moved.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'STALE', name: 'Stale Mover', change24h: 20, volume: 10_000, liquidity: 100_000 })
  assert.equal(r.passed, true)
  const verdict = evaluateLiveMomentum(r.candidate)
  assert.equal(verdict.qualified, false)
  assert.equal(verdict.reason, 'volumeNotExpanding')
}

// DUAL-CEILING MODEL: a candidate above the exact tier's ceiling but within live-momentum's wider
// ceiling must still pass Stage 1 (never hard-rejected on cap when live momentum could still apply),
// carrying qualifiesForExactCap=false / qualifiesForLiveMomentumCap=true.
{
  const r = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'MIDCAP2', name: 'Mid Cap Mover', fdv: 15_000_000, change24h: 15 })
  assert.equal(r.passed, true, 'a $15M-FDV Base candidate must still pass Stage 1 — over the $5M exact ceiling but under the $20M live-momentum ceiling')
  assert.equal(r.candidate.qualifiesForExactCap, false)
  assert.equal(r.candidate.qualifiesForLiveMomentumCap, true)
  const verdict = evaluateLiveMomentum(r.candidate)
  assert.equal(verdict.qualified, true, 'it must still be eligible for live momentum qualification')
  // Defense-in-depth: exact evidence resolved for this candidate must never be accepted, even if
  // somehow produced — model A explicitly requires the STRICTER exact-mode ceiling.
  const exactAttempt = evaluateStage2Candidate(r.candidate, null, 'req_dualcap', { kind: 'exact', source: 'geckoterminal_ohlcv', change14d: 60 })
  assert.equal(exactAttempt.included, false, 'exact evidence must never qualify a candidate that only fits the wider live-momentum ceiling')
  assert.equal(exactAttempt.audit.exclusionReason, 'capExceedsLowCapCeiling')
}

// A candidate above BOTH ceilings is hard-rejected at Stage 1 — never reaches evidence checking.
{
  const r = evaluateStage1Candidate({ ...base, chain: 'base', symbol: 'MEGACAP', name: 'Mega Cap', fdv: 30_000_000 })
  assert.equal(r.passed, false, 'a $30M-FDV Base candidate exceeds even the $20M live-momentum ceiling and must be rejected')
  assert.equal(r.audit.exclusionReason, 'capExceedsLowCapCeiling')
}

// END-TO-END SCENARIO (as reported): candidates pass liquidity/volume, exact evidence fails for
// everyone (total provider outage simulated), but some have real live momentum — the feed must
// still render exactly those, labelled Live Momentum, never "Exact 14d", and never empty.
{
  const candidates = []
  for (let i = 0; i < 12; i++) {
    const hasMomentum = i < 3 // first 3 of the 12 have real live momentum
    const r = evaluateStage1Candidate({
      ...base, symbol: `LIVE${i}`, name: `Live Candidate ${i}`, addr: `0x${i.toString().padStart(40, '0')}`,
      change24h: hasMomentum ? 15 : 2, volume: 50_000, liquidity: 80_000,
    })
    assert.equal(r.passed, true)
    candidates.push(r.candidate)
  }

  const rendered = []
  for (const c of candidates) {
    // Simulate total exact-evidence provider failure: OHLCV/CoinGecko/snapshot all resolve to
    // nothing, exactly like the reported "exactEvidenceQualified: 0" scenario.
    const liveVerdict = evaluateLiveMomentum(c)
    const resolved = liveVerdict.qualified ? { kind: 'live_momentum', verdict: liveVerdict } : { kind: 'none' }
    const result = evaluateStage2Candidate(c, null, 'req_e2e', resolved)
    if (result.included) rendered.push(result.alert)
  }

  assert.equal(rendered.length, 3, 'exactly the 3 candidates with real live momentum must render when every exact-evidence source fails')
  for (const alert of rendered) {
    assert.equal(alert.evidenceGrade, 'live_momentum', 'a card rendered without exact evidence must be labelled live_momentum, never exact')
    assert.equal(alert.change14d, null, 'no 14d number may ever be fabricated for a live-momentum card')
    assert.match(alert.qualifyingReason, /Live momentum/, 'the qualifying reason must state it was live momentum, not exact evidence')
  }
}

// Exact 7d/14d success still renders the 'exact' grade — the badge a real measured change earns.
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'EXACTOK', name: 'Exact OK', change24h: 15 })
  assert.equal(r.passed, true)
  const result = evaluateStage2Candidate(r.candidate, null, 'req_exact_badge', { kind: 'exact', source: 'geckoterminal_ohlcv', change14d: 45 })
  assert.equal(result.included, true)
  assert.equal(result.alert.evidenceGrade, 'exact', 'real exact 14d evidence must earn the exact badge, not live_momentum')
  assert.equal(result.alert.change14d, 45)
}

// ─── Part 14: Pump Alerts UI polish + Load More (static source assertions) ─────────────────────
//
// This file has no DOM/React renderer, so — matching Part 4/6's established convention — these
// assert against the real page/route source text rather than mounting components.
{
  const pageSrc14 = fs.readFileSync(new URL('../app/terminal/pump-alerts/page.tsx', import.meta.url), 'utf8')
  const pageCode14 = pageSrc14.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const routeSrc14 = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
  const routeCode14 = routeSrc14.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const evidenceSrc14 = fs.readFileSync(new URL('../lib/server/pump14dEvidence.ts', import.meta.url), 'utf8')
  const evidenceCode14 = evidenceSrc14.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  // Market Cap renders when available; honest "MCap unavailable" when it isn't; FDV stays separate.
  assert.match(pageCode14, /MCap unavailable/, 'card must show an honest empty state when marketCapUsd is null, never a fake $0')
  assert.match(pageCode14, /alert\.marketCapUsd != null \? fmtUSD\(alert\.marketCapUsd\)/, 'card must render a real formatted market cap when it exists')
  assert.match(pageCode14, /label="FDV"/, 'FDV must remain its own visible metric, never removed')
  assert.match(pageCode14, /label="Market Cap"/, 'Market Cap must be its own dedicated metric cell')
  assert.match(pageCode14, /label="FDV" value=\{fmtUSD\(alert\.fdvUsd\)\}/, 'the card\'s FDV cell must render fdvUsd directly, never fall back to market cap')

  // Backend response carries the requested field aliases, purely additive over the existing values.
  assert.match(routeCode14, /priceChange24hPct: a\.change24h/, 'API response must alias change24h as priceChange24hPct')
  assert.match(routeCode14, /priceChange6hPct: a\.change6h/, 'API response must alias change6h as priceChange6hPct')
  assert.match(routeCode14, /priceChange1hPct: a\.change1h/, 'API response must alias change1h as priceChange1hPct')

  // Load More: client-side pagination over the already-fetched alerts array, no refetch.
  assert.match(pageCode14, /const PAGE_SIZE = 10/, 'initial render / page size must be 8-10 alerts')
  assert.match(pageCode14, /const visible = useMemo\(\(\) => filtered\.slice\(0, visibleCount\)/, 'Load More must slice the already-fetched alerts client-side, never refetch')
  assert.match(pageCode14, /Showing \{visible\.length\} of \{filtered\.length\}/, 'feed must show a "Showing X of Y" count')
  assert.match(pageCode14, /All current pump candidates shown\./, 'feed must say so once all alerts are loaded')
  assert.match(pageCode14, /const hasMore = visibleCount < filtered\.length/, 'Load More button must hide once everything is shown')
  assert.match(pageCode14, /loadMoreLoading/, 'Load More must expose a loading state on its button')

  // Filters still apply after Load More: pagination resets on filter change, not on background refresh.
  assert.match(pageCode14, /if \(activeFilter !== prevActiveFilterForReset\)/, 'pagination must reset to page 1 when the active filter changes')
  assert.doesNotMatch(pageCode14, /useEffect\(\(\) => \{ setVisibleCount\(PAGE_SIZE\) \}, \[activeFilter\]\)/, 'the filter-change reset must not resync alerts on every background refresh via a naive effect')

  // Actions preserved: Scan / Copy CA / Clark / Report handlers still wired on the rewritten card.
  assert.match(pageCode14, /onClick=\{onScan\}/, 'Scan action must still be wired')
  assert.match(pageCode14, /onClick=\{onCopyCA\}/, 'Copy CA action must still be wired')
  assert.match(pageCode14, /onClick=\{onAskClark\}/, 'Ask Clark action must still be wired')
  assert.match(pageCode14, /onClick=\{onReport\}/, 'Report action must still be wired')

  // Badges preserved: risk/evidence/category/FDV-tier badges never removed.
  assert.match(pageCode14, /Live Momentum/, 'live-momentum evidence badge must remain')
  assert.match(pageCode14, /Exact 14d/, 'exact evidence badge must remain')
  assert.match(pageCode14, /RISK_LABEL\[alert\.riskLevel\]/, 'risk badge must remain')
  assert.match(pageCode14, /fdvStyle\.label/, 'FDV-tier badge must remain')

  // Non-blanking refresh: last-good alerts stay visible while refreshing, feed is never blanked.
  assert.match(pageCode14, /refreshing/i, 'a subtle refreshing indicator must exist')
  assert.doesNotMatch(pageCode14, /setAlerts\(\[\]\)/, 'alerts must never be reset to empty on refresh — that would blank the feed')

  // Audit logging surface required by the task.
  for (const key of [
    'totalAlertsFromApi', 'initialRenderedCount', 'currentRenderedCount', 'hasMore',
    'marketCapAvailableCount', 'marketCapMissingCount', 'fdvAvailableCount',
    'loadMoreClicks', 'activeFilter', 'activeChains',
  ]) {
    assert.match(pageCode14, new RegExp(key), `pumpAlertsUiAudit must include ${key}`)
  }
  assert.match(pageCode14, /pumpAlertsUiAudit/, 'the audit object must be named pumpAlertsUiAudit')

  // Mobile responsiveness: dead CSS from the old layout is gone, new responsive rules target the
  // rewritten card structure, and the grid collapses to one column so nothing overflows horizontally.
  assert.doesNotMatch(pageCode14, /pump-card-left|pump-card-center|pump-card-right|pump-metric-band|pump-mini-bar|pump-liq-depth/, 'dead CSS/classes from the old 3-column layout must be fully removed')
  assert.match(pageCode14, /\.pump-card-grid-container \{ grid-template-columns: 1fr !important; \}/, 'the card grid must collapse to a single column on narrow viewports')
  assert.match(pageCode14, /\.pump-card-top\s*\{ flex-wrap: wrap !important/, 'the card header must wrap on narrow viewports instead of overflowing')

  // Chain visibility: a real colored badge, not small truncating text — checked in both the header
  // and the metric grid cell.
  assert.match(pageCode14, /CHAIN_LABEL\[alert\.chain\]/, 'chain must render via a label lookup, not raw lowercase text prone to clipping')
  assert.match(pageCode14, /CHAIN_COLOR\[alert\.chain\]/, 'chain badge must be colored so it reads at a glance')
  assert.match(pageCode14, /const CHAIN_LABEL: Record<'base' \| 'eth' \| 'robinhood', string>/, 'chain label map must cover every supported chain')

  // Market cap verification: a second real provider (CoinGecko) fills marketCapUsd when
  // GeckoTerminal's pool data doesn't have it, never a computed/fabricated value.
  assert.match(evidenceCode14, /export type CoinGeckoContractLookup = \{ change14d: number \| null; marketCapUsd: number \| null \}/, 'CoinGecko lookup must expose a real, provider-sourced market cap alongside the 14d change')
  assert.match(routeCode14, /if \(c\.marketCap == null && cgLookup\.marketCapUsd != null\) c\.marketCap = cgLookup\.marketCapUsd/, 'market cap must only be filled from a real provider response, and only when GeckoTerminal did not already have one')

  // Market cap verification, round 2: a DexScreener fill pass covers live-momentum candidates on
  // every chain (including Robinhood, which CoinGecko cannot), sourced from DexScreener's own
  // marketCap field, never derived, and only applied to alerts still missing it after GeckoTerminal/
  // CoinGecko, never overwriting a value already resolved.
  assert.match(routeCode14, /const marketCapFillTargets = alerts\.filter\(a => a\.marketCapUsd == null && a\.pairAddress\)/, 'the market-cap fill pass must only target alerts still missing a real value')
  assert.match(routeCode14, /fetchDexScreenerPairMomentum\(alert\.chain, alert\.pairAddress as string, acMcap\.signal\)/, 'route must use the real DexScreener pair fetch (chain-scoped) to verify market cap')
  assert.match(routeCode14, /if \(result\?\.ok && dsMarketCap != null\) alert\.marketCapUsd = dsMarketCap/, 'market cap must only be set from a successful, real DexScreener response')
  assert.match(evidenceCode14, /marketCapUsd: num\(pair\.marketCap\)/, 'DexScreener pair parsing must read the provider\'s own marketCap field')

  // Discovery logic untouched: the hard rule this whole task was bound by.
  assert.match(routeCode14, /export function evaluateStage1Candidate/, 'Stage 1 discovery function must be untouched and still exported')
  assert.match(routeCode14, /export function evaluateStage2Candidate/, 'Stage 2 discovery function must be untouched and still exported')
}

// ─── Part 15: feed-quantity fix (reported live: "Pump Alerts only shows 1 token") ───────────────
//
// The stop condition (evaluateCandidatesInBatches) was already correct — it only stops early once
// qualifiedCount >= targetResults, never after the first qualifier — Part 11 above already proves
// that with targetResults:1. What was missing was proof it keeps CONTINUING to collect MULTIPLE
// qualifiers when the target is higher than 1, which is the actual "should show 10-20, not just 1"
// requirement.
{
  const rankedIndices = Array.from({ length: 30 }, (_, i) => i)
  const qualifyingIndices = new Set([2, 5, 9, 14, 20, 27]) // 6 real qualifiers scattered through the pool
  const evaluatedBatches = []
  const outcome = await evaluateCandidatesInBatches(
    rankedIndices,
    { targetResults: 15, maxCandidatesEvaluated: 100, minResultsBeforeStop: 10, batchSize: 1 },
    async batchIndices => {
      evaluatedBatches.push(batchIndices)
      const qualifiedInBatch = batchIndices.filter(i => qualifyingIndices.has(i)).length
      return { qualifiedInBatch }
    },
  )
  assert.equal(outcome.qualifiedCount, 6, 'evaluation must keep going past the FIRST qualifier and collect every real one found, not stop at 1')
  assert.equal(outcome.stoppedReason, 'allCandidatesExhausted', 'fewer real qualifiers than the target must exhaust the pool honestly, never stop early pretending the target was hit')
  assert.equal(outcome.evaluatedCount, 30, 'every candidate must have been tried when the target was never reached')
}

// Bumped default config: target/eval-depth/min-before-stop match the requested defaults, plus the
// new raw-candidate ceiling and the trending-pools breadth addition (route-level static assertions —
// this file has no live network access to GeckoTerminal).
{
  const routeSrc15 = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
  const routeCode15 = routeSrc15.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(routeCode15, /PUMP_ALERT_TARGET_RESULTS', 15\)/, 'target results default must be raised to 15')
  assert.match(routeCode15, /PUMP_ALERT_MAX_CANDIDATES_EVALUATED', 100\)/, 'max candidates evaluated default must be raised to 100')
  assert.match(routeCode15, /PUMP_ALERT_MIN_RESULTS_BEFORE_STOP', 10\)/, 'min results before stop default must be raised to 10')
  assert.match(routeCode15, /PUMP_ALERT_MAX_RAW_CANDIDATES = envNumber\('PUMP_ALERT_MAX_RAW_CANDIDATES', 200\)/, 'a configurable raw-candidate ceiling must exist, defaulting to 200')
  assert.match(routeCode15, /fetchGTTrendingPools/, 'route must fetch a real trending-pools source, not just the paginated default list, to widen the raw candidate pool')
  assert.match(routeCode15, /\[1, 2, 3, 4, 5\]\.map\(page => fetchGTPage/, 'pagination must be widened beyond the original 3 pages per chain')

  // pumpFeedQuantityAudit: exact shape requested, so "why only 1" is always provable from the response.
  for (const field of [
    'rawCandidates', 'candidatesAfterCategoryFilter', 'candidatesAfterChainFilter',
    'candidatesAfterLowCapFilter', 'candidatesAfterLiquidityVolumeFilter', 'liveMomentumQualified',
    'finalRenderedCount', 'targetResults', 'stoppedReason', 'topRejectedReasons',
  ]) {
    assert.match(routeCode15, new RegExp(field), `pumpFeedQuantityAudit must include ${field}`)
  }
  assert.match(routeCode15, /const pumpFeedQuantityAudit = \{/, 'pumpFeedQuantityAudit must be a real object built in the route')
  assert.match(routeCode15, /pumpFeedQuantityAudit,\s*\n/, 'pumpFeedQuantityAudit must actually be included in the response payload')

  // UI: the "1 of N candidates qualified" explanation, sourced from real audit numbers, not a
  // hardcoded string.
  const pageSrc15 = fs.readFileSync(new URL('../app/terminal/pump-alerts/page.tsx', import.meta.url), 'utf8')
  const pageCode15 = pageSrc15.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(pageCode15, /\{alerts\.length\} of \{candidateAudit\.rawCandidates\} candidates qualified/, 'low-count UI must cite the real qualified/raw counts, matching the requested "1 of 200 candidates qualified" format')
}

console.log('test-pump-alerts-discovery.mjs: all assertions passed')

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateStage1Candidate, evaluateStage2Candidate } from '../app/api/pump-alerts/route.ts'

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

// Missing 7d must exclude — never faked from 24h data
{
  const r = evaluateStage2Candidate(stage1Candidate, null)
  assert.equal(r.included, false, 'missing 7d data must exclude the candidate, never fake it')
  assert.equal(r.audit.exclusionReason, 'missing7dData')
  assert.equal(r.audit.priceChange7dPct, null)
}

// Below-threshold 7d excludes
{
  const r = evaluateStage2Candidate(stage1Candidate, 10)
  assert.equal(r.included, false)
  assert.equal(r.audit.exclusionReason, 'change7dBelowMinimum')
}

// Valid low-cap confirmed 7d pump is included
{
  const r = evaluateStage2Candidate(stage1Candidate, 60)
  assert.equal(r.included, true, 'a confirmed 7d pump on an eligible low-cap token must be included')
  assert.equal(r.audit.excluded, false)
  assert.equal(r.audit.qualifiesAs7dPump, true)
  assert.equal(r.audit.qualifiesAsLowCap, true)
  assert.ok(r.audit.finalRankScore != null, 'an included candidate must carry a real rank score')
  assert.equal(r.alert.change7d, 60)
  assert.match(r.alert.qualifyingReason, /60\.0% over 7d/)
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
assert.match(routeCode, /token: c\.addr, chain, chainSlug: chain, chainId/, 'audit rows must be built from the real chain variable')
assert.match(routeCode, /networks\/\$\{network\}\/pools\/\$\{poolAddress\}\/ohlcv/, '7d OHLCV must be fetched from the candidate\'s own network, not a hardcoded one')
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

console.log('test-pump-alerts-discovery.mjs: all assertions passed')

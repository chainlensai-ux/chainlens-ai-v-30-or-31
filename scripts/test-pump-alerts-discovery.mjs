import assert from 'node:assert/strict'
import { evaluateStage1Candidate, evaluateStage2Candidate } from '../app/api/pump-alerts/route.ts'

// PUMP DISCOVERY QUALITY, DISCLOSED (reported live: Pump Alerts was surfacing Aerodrome and other
// established Base tokens). These tests exercise the real eligibility functions the GET handler
// calls — evaluateStage1Candidate (category/cap/liquidity/volume/age) and evaluateStage2Candidate
// (confirmed 7d pump gate) — not a mock or a static source-text check, since both are now pure and
// exported specifically so this logic is testable directly.

const base = {
  symbol: 'TEST', name: 'Test Token', addr: '0xabc0000000000000000000000000000000000a',
  poolAddr: '0xpool000000000000000000000000000000000a',
  price: 0.002, change24h: 40, volume: 200_000, liquidity: 50_000,
  fdv: 900_000, marketCap: null, ageDays: 20,
}

// ── AERO exclusion ──────────────────────────────────────────────────────────
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'AERO', name: 'Aerodrome Finance' })
  assert.equal(r.passed, false, 'AERO must never pass stage 1')
  assert.equal(r.audit.categoryBlocked, true)
  assert.equal(r.audit.exclusionReason, 'establishedOrCategoryBlocked')
}

// ── Stablecoin exclusion ────────────────────────────────────────────────────
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'USDC', name: 'USD Coin', fdv: 40_000_000_000 })
  assert.equal(r.passed, false, 'USDC must never pass stage 1')
  assert.equal(r.audit.categoryBlocked, true)
  assert.equal(r.audit.exclusionReason, 'establishedOrCategoryBlocked')
}

// ── High-FDV exclusion (well-formed low-cap-looking symbol, but cap too high) ──
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'BIGCAP', name: 'Big Cap Token', fdv: 50_000_000, marketCap: null })
  assert.equal(r.passed, false, 'a token above the FDV/market-cap ceiling must be excluded')
  assert.equal(r.audit.exclusionReason, 'capExceedsLowCapCeiling')
  assert.equal(r.audit.categoryBlocked, false, 'must be excluded for cap, not miscategorized as an established-token block')
}

// ── Missing cap data must not silently pass as low-cap ──────────────────────
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'NOCAP', name: 'No Cap Data', fdv: null, marketCap: null })
  assert.equal(r.passed, false)
  assert.equal(r.audit.exclusionReason, 'capDataMissing')
}

// ── Valid low-cap token passes stage 1 ──────────────────────────────────────
let stage1Candidate
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'MOON', name: 'Moon Token' })
  assert.equal(r.passed, true, 'a genuine low-cap, adequately-liquid, adequately-traded token must pass stage 1')
  stage1Candidate = r.candidate
}

// ── Missing 7d exclusion: stage 1 pass does not guarantee inclusion — a null 7d change must
//    exclude, never silently pass or get faked from 24h data ────────────────
{
  const r = evaluateStage2Candidate(stage1Candidate, null)
  assert.equal(r.included, false, 'missing 7d data must exclude the candidate, never fake it')
  assert.equal(r.audit.exclusionReason, 'missing7dData')
  assert.equal(r.audit.priceChange7dPct, null)
}

// ── Below-threshold 7d change excludes even with everything else eligible ───
{
  const r = evaluateStage2Candidate(stage1Candidate, 10) // below default PUMP_ALERT_MIN_7D_CHANGE_PCT=25
  assert.equal(r.included, false)
  assert.equal(r.audit.exclusionReason, 'change7dBelowMinimum')
}

// ── Valid low-cap 7d pump inclusion: confirmed 7d change above threshold + real stage-1 eligibility
{
  const r = evaluateStage2Candidate(stage1Candidate, 60)
  assert.equal(r.included, true, 'a confirmed 7d pump on an already-eligible low-cap token must be included')
  assert.equal(r.audit.excluded, false)
  assert.equal(r.audit.qualifiesAs7dPump, true)
  assert.equal(r.audit.qualifiesAsLowCap, true)
  assert.equal(r.audit.categoryBlocked, false)
  assert.ok(r.audit.finalRankScore != null, 'an included candidate must carry a real rank score')
  assert.equal(r.alert.change7d, 60)
  assert.match(r.alert.qualifyingReason, /60\.0% over 7d/)
  assert.match(r.alert.qualifyingReason, /low-cap/)
}

// ── Liquidity/volume floors still apply even to an otherwise-eligible low-cap token ──
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

// ── LP-token symbol pattern is blocked even without an exact-symbol denylist hit ────
{
  const r = evaluateStage1Candidate({ ...base, symbol: 'AERO-USDC-LP', name: 'Aerodrome LP Vault' })
  assert.equal(r.passed, false)
  assert.equal(r.audit.categoryBlocked, true)
}

console.log('test-pump-alerts-discovery.mjs: all assertions passed')

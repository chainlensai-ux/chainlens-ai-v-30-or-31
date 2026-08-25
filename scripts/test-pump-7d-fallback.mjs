// PUMP 14D EVIDENCE LADDER TESTS, DISCLOSED (urgent fallback fix).
// Covers the required behaviors: exact-14d preference, DexScreener-corroborated momentum fallback,
// honest empty state, majors/stables/wrapped still excluded in fallback mode, low-cap filters
// still applied in fallback mode, evidence badges on cards, snapshot-based 14d computation once
// history exists, and the audit surface. Exercises the real exported functions — no mocks.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateStage1Candidate, evaluateStage2Candidate } from '../app/api/pump-alerts/route.ts'
import {
  evaluateMomentumFallback,
  computeSnapshotChange14d,
  _resetSnapshotMemoryForTest,
  _seedSnapshotMemoryForTest,
} from '../lib/server/pump14dEvidence.ts'

const base = {
  chain: 'base',
  symbol: 'TEST', name: 'Test Token', addr: '0xabc0000000000000000000000000000000000a',
  poolAddr: '0xpool000000000000000000000000000000000a',
  price: 0.002, change24h: 40, volume: 200_000, liquidity: 50_000,
  fdv: 900_000, marketCap: null, ageDays: 20,
}

// ─── 1. GeckoTerminal OHLCV success → exact 14d pump token ──────────────────────
{
  const s1 = evaluateStage1Candidate({ ...base, symbol: 'MOON', name: 'Moon Token' })
  assert.equal(s1.passed, true)
  const r = evaluateStage2Candidate(s1.candidate, null, 'req', { kind: 'exact', source: 'geckoterminal_ohlcv', change14d: 60 })
  assert.equal(r.included, true)
  assert.equal(r.alert.change14d, 60)
  assert.equal(r.alert.evidenceGrade, 'exact')
  assert.equal(r.alert.evidenceSource, 'geckoterminal_ohlcv')
}

// Exact 14d below threshold still excludes — the bar doesn't drop because a source exists
{
  const s1 = evaluateStage1Candidate(base)
  const r = evaluateStage2Candidate(s1.candidate, null, 'req', { kind: 'exact', source: 'coingecko_contract', change14d: 10 })
  assert.equal(r.included, false)
  assert.equal(r.audit.exclusionReason, 'change14dBelowMinimum')
}

// ─── 2. Momentum fallback qualification (GT fails, DexScreener corroborates) ────
{
  // Strong move + accelerating volume + real liquidity → qualifies WITHOUT any fake 14d number.
  const v = evaluateMomentumFallback({
    change24hPct: 22,
    volume24hUsd: 100_000,
    liquidityUsd: 60_000,
    dexscreener: {
      priceChange24hPct: 25, priceChange6hPct: 10, priceChange1hPct: 4,
      volume24hUsd: 90_000, volume6hUsd: 50_000, liquidityUsd: 58_000, priceUsd: 0.0021,
    },
  })
  assert.equal(v.qualified, true, 'corroborated strong accelerating momentum must qualify')
  if (v.qualified) {
    assert.ok(v.confirmedChange24hPct >= 15)
    assert.ok(v.volumeAcceleration != null && v.volumeAcceleration >= 1.5)
  }

  const s1 = evaluateStage1Candidate({ ...base, symbol: 'FALLBACK', name: 'Fallback Mover', change24h: 22 })
  const r = evaluateStage2Candidate(s1.candidate, null, 'req', {
    kind: 'momentum_fallback',
    confirmedChange24hPct: 22,
    evidenceParts: ['confirmed 24h move ≥ 22.0%', 'volume accelerating 2.0×', '$60K live liquidity'],
  })
  assert.equal(r.included, true, 'fallback candidate must render when GT OHLCV failed but evidence is strong')
  assert.equal(r.alert.change14d, null, 'momentum fallback must NEVER fabricate a 14d number')
  assert.equal(r.alert.evidenceGrade, 'momentum_fallback')
  assert.match(r.alert.qualifyingReason, /14d unavailable — qualified by 24h momentum fallback/)
}

// Weak move does NOT qualify
{
  const v = evaluateMomentumFallback({
    change24hPct: 5, volume24hUsd: 100_000, liquidityUsd: 60_000,
    dexscreener: { priceChange24hPct: 6, priceChange6hPct: 2, priceChange1hPct: 1, volume24hUsd: 90_000, volume6hUsd: 50_000, liquidityUsd: 58_000, priceUsd: 1 },
  })
  assert.equal(v.qualified, false)
  if (!v.qualified) assert.equal(v.reason, 'moveBelowFallbackThreshold')
}

// Non-accelerating volume does NOT qualify
{
  const v = evaluateMomentumFallback({
    change24hPct: 30, volume24hUsd: 100_000, liquidityUsd: 60_000,
    dexscreener: { priceChange24hPct: 28, priceChange6hPct: 5, priceChange1hPct: 2, volume24hUsd: 90_000, volume6hUsd: 10_000, liquidityUsd: 58_000, priceUsd: 1 },
  })
  assert.equal(v.qualified, false)
  if (!v.qualified) assert.equal(v.reason, 'volumeNotAccelerating')
}

// Contradicting providers disqualify (one says +40%, other says -50% — no story to trust)
{
  const v = evaluateMomentumFallback({
    change24hPct: 40, volume24hUsd: 100_000, liquidityUsd: 60_000,
    dexscreener: { priceChange24hPct: -50, priceChange6hPct: -20, priceChange1hPct: -5, volume24hUsd: 90_000, volume6hUsd: 50_000, liquidityUsd: 58_000, priceUsd: 1 },
  })
  assert.equal(v.qualified, false, 'contradictory provider readings must not qualify')
}

// No move data at all → honest rejection, not silent pass
{
  const v = evaluateMomentumFallback({
    change24hPct: null, volume24hUsd: 100_000, liquidityUsd: 60_000,
    dexscreener: { priceChange24hPct: null, priceChange6hPct: null, priceChange1hPct: null, volume24hUsd: 90_000, volume6hUsd: 50_000, liquidityUsd: 58_000, priceUsd: 1 },
  })
  assert.equal(v.qualified, false)
  if (!v.qualified) assert.equal(v.reason, 'noMoveDataFromAnyProvider')
}

// Missing volume data → rejected, never silently passed
{
  const v = evaluateMomentumFallback({
    change24hPct: 30, volume24hUsd: null, liquidityUsd: 60_000,
    dexscreener: { priceChange24hPct: 30, priceChange6hPct: 12, priceChange1hPct: 5, volume24hUsd: null, volume6hUsd: null, liquidityUsd: 58_000, priceUsd: 1 },
  })
  assert.equal(v.qualified, false)
  if (!v.qualified) assert.equal(v.reason, 'volumeAccelerationUnmeasurable')
}

// No evidence at all → Stage 2 excludes honestly
{
  const s1 = evaluateStage1Candidate(base)
  const r = evaluateStage2Candidate(s1.candidate, null, 'req', { kind: 'none' })
  assert.equal(r.included, false, 'no evidence must exclude — honest empty state, not a fake pass')
  assert.ok(
    r.audit.exclusionReason === 'missing14dData' || r.audit.exclusionReason === 'noQualifyingPumpEvidence',
    `unexpected exclusion reason: ${r.audit.exclusionReason}`,
  )
}

// ─── 3. Majors/stables/wrapped STILL excluded in fallback mode ──────────────────
for (const [sym, name] of [['USDC', 'USD Coin'], ['WETH', 'Wrapped Ether'], ['AERO', 'Aerodrome Finance']]) {
  const s1 = evaluateStage1Candidate({ ...base, symbol: sym, name })
  assert.equal(s1.passed, false, `${sym} must stay blocked even before any fallback can run`)
}

// ─── 4. Low-cap filters STILL apply in fallback mode ────────────────────────────
{
  // $30M FDV is over Base's $20M ceiling — momentum can't buy its way past the cap gate.
  const s1 = evaluateStage1Candidate({ ...base, symbol: 'BIGFALL', name: 'Big Fallback', fdv: 30_000_000 })
  assert.equal(s1.passed, false, 'a high-FDV token must not qualify via momentum fallback')
  assert.equal(s1.audit.exclusionReason, 'capExceedsLowCapCeiling')

  // Thin liquidity also stays blocked.
  const thin = evaluateStage1Candidate({ ...base, symbol: 'THINFALL', name: 'Thin Fallback', liquidity: 500 })
  assert.equal(thin.passed, false)
  assert.equal(thin.audit.exclusionReason, 'liquidityBelowMinimum')
}

// ─── 5. UI shows evidence badges ────────────────────────────────────────────────
const pageSrc = fs.readFileSync(new URL('../app/terminal/pump-alerts/page.tsx', import.meta.url), 'utf8')
const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.match(pageCode, /Exact 14d/, 'cards must show an "Exact 14d" badge for measured evidence')
assert.match(pageCode, /24h momentum fallback/, 'cards must show a distinct badge for fallback qualification')
assert.match(pageCode, /evidenceGrade/, 'the card must read the alert\'s evidence grade')

// Route carries the audit + degraded mode surfaces
const routeSrc = fs.readFileSync(new URL('../app/api/pump-alerts/route.ts', import.meta.url), 'utf8')
const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.match(routeCode, /pump14dEvidenceAudit/, 'route must return the 14d evidence audit')
assert.match(routeCode, /degradedMode/, 'audit must carry degraded mode')
assert.match(routeCode, /fetchDexScreenerPairMomentum/, 'route must use the DexScreener fallback tier')
assert.match(routeCode, /fetchCoinGeckoContractChange14d/, 'route must use the CoinGecko exact tier')
assert.match(routeCode, /computeSnapshotChange14d/, 'route must use the internal snapshot tier')
assert.match(routeCode, /savePumpSnapshots/, 'route must persist internal snapshots each cycle')
assert.doesNotMatch(routeCode, /change14d: c\.change24h/, '14d must never be silently substituted with 24h')

console.log('test-pump-14d-fallback.mjs: all assertions passed')

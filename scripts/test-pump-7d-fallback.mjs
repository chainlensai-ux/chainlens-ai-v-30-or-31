// PUMP 14D EVIDENCE LADDER TESTS (lib/server/pump14dEvidence.ts), DISCLOSED.
//
// pump14dEvidence.ts is NOT part of the main Pump Alerts feed anymore (see the "STOP
// overcomplicating Pump Alerts" rewrite in app/api/pump-alerts/route.ts's module header) — it is
// still used by the separate Pump Report deep-dive feature (app/api/pump-alerts/intelligence/route.ts),
// which this task never touched. This file now tests only that module's own exports directly —
// the parts that used to import evaluateStage1Candidate/evaluateStage2Candidate from the main feed
// route were testing route-integration shape that no longer exists and have been removed.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { evaluateMomentumFallback } from '../lib/server/pump14dEvidence.ts'

// ─── Momentum fallback qualification (GT fails, DexScreener corroborates) ───────────────────────
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

// The Pump Report feature (unaffected by the feed rewrite) still uses this module directly.
const intelSrc = fs.readFileSync(new URL('../app/api/pump-alerts/intelligence/route.ts', import.meta.url), 'utf8')
assert.match(intelSrc, /from '@\/lib\/server\/pump14dEvidence'/, 'the Pump Report route must still use pump14dEvidence.ts — this task never touched that feature')

console.log('test-pump-7d-fallback.mjs: all assertions passed')

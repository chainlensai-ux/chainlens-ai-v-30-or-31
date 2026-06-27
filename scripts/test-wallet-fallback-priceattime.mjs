import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// fallbackPriceAtTime exists as a tier-3 fallback, gated on deepScan, cached per (token, day),
// and returns the exact { priceUsd, source: 'fallback', confidence: 'low' } shape on success.
assert.match(snap, /async function fallbackPriceAtTime\(/, 'fallbackPriceAtTime is defined')
assert.match(snap, /if \(!deepScan\) return null/, 'fallbackPriceAtTime is skipped entirely when deepScan=false')
assert.match(snap, /source: 'fallback', confidence: 'low'/, 'fallbackPriceAtTime returns the required { source, confidence } shape')
assert.match(snap, /const cacheKey = `fallback:\$\{normalizeChain\(chain\)\}:\$\{contractAddress\.toLowerCase\(\)\}:\$\{dateStr\}`/, 'fallback price is cached per (chain, token, day)')
assert.match(snap, /const _fallbackPriceCache = new Map<string, \{ exp: number; priceUsd: number \| null \}>\(\)/, 'fallback price cache is a module-level Map keyed per (token, day)')

// Case 1: GoldRush/provider tiers missing -> fallback is attempted before falling through to the
// current-holding-price estimate tier, only inside buildPriceAtTimeEvidence's per-event resolution
// (i.e. only after both existing tiers above have already returned null for that event).
assert.match(snap, /skippedHistoricalUnavailable\+\+\s*\n\s*\n\s*\/\/ FALLBACK-PRICEATTIME-1[\s\S]{0,400}const _fallback = await fallbackPriceAtTime\(e\.contract, e\.timestamp \?\? '', deepScan, e\.chain\)/, 'fallback is only attempted after the existing historical-price tier returns null')
assert.match(snap, /if \(_fallback\) \{\s*\n\s*return priced\(e, _fallback\.priceUsd, 'fallback', 'low',/, 'a successful fallback price marks the event priced with source=fallback (non-zero PnL becomes possible)')

// Case 2: fallback disabled (deepScan=false) -> buildPriceAtTimeEvidence is called with deepScan
// threaded through from the same flag that gates deep/recovery scans elsewhere in this file.
assert.match(snap, /deepScan = false,\s*\n\): Promise<\{/, 'buildPriceAtTimeEvidence defaults deepScan to false so normal scans never attempt the fallback')
const callLines = snap.split('\n').filter(l => l.includes('await buildPriceAtTimeEvidence('))
assert.ok(callLines.length >= 6, 'buildPriceAtTimeEvidence has multiple call sites')
for (const line of callLines) {
  assert.match(line, /, deepScan\)+\)?$/, `call site passes deepScan through: ${line.trim().slice(0, 60)}...`)
}

// Case 3 / Case 4: fallback-priced lots are classified as a non-independent ('fallback_price_reused')
// price source, so they are excluded from verified/performance-grade PnL (win rate/profit skill
// stay locked) but remain real-backed (not synthetic), so OpenCheck PnL — which is computed from
// real-backed lots regardless of verified status (see OPENCHECK-PNL-1) — still includes them.
assert.match(snap, /const FALLBACK_PRICE_REUSE_SOURCES = new Set\(\['historical_price', 'unavailable', 'synthetic', 'fallback'\]\)/, "'fallback' source is enumerated as a non-independent price source")
assert.match(snap, /source: 'stable_leg' \| 'weth_leg' \| 'native_leg' \| 'historical_price' \| 'swap_derived' \| 'provider_event_usd' \| 'current_holding_price_open_lot_estimate' \| 'eth_native_value_router_reconstruction' \| 'current_price_fallback_not_used' \| 'swap_reconstruction_v1' \| 'fallback' \| 'unavailable'/, "PriceAtTimeEvidence['source'] includes 'fallback'")
// classifyClosedLotForPublicPerformance already rejects missing_independent_price/current_price_reused/
// fallback_price_reused as not performanceEligible/verifiedPnlEligible — unchanged by this patch,
// confirming fallback lots can never unlock win rate or profit skill (verified=true path ignores them).
assert.match(snap, /if \(lot\.priceIndependenceStatus === 'missing_independent_price' \|\| lot\.priceIndependenceStatus === 'current_price_reused' \|\| lot\.priceIndependenceStatus === 'fallback_price_reused'\) return \{ reconstructedEligible: true, verifiedPnlEligible: false, performanceEligible: false,/, 'fallback-priced lots are never verifiedPnlEligible/performanceEligible (verified PnL ignores fallback prices)')

console.log('wallet fallback priceAtTime checks passed')

import assert from 'node:assert/strict'
import { buildPumpIntelligenceReport } from '../lib/server/pumpIntelligence.ts'

// PUMP-INTELLIGENCE-REPORT, DISCLOSED: the report's whole premise is "never fabricate evidence,
// Unknown stays Unknown, separate verified facts from inference." These assertions exist to catch
// a regression where someone later "fills in" a plausible-looking number for a section this
// codebase genuinely has no data source for (most importantly Historical Similarity, and the
// liquidity/holder trend fields — both real gaps confirmed via a full data-source audit before
// this module was written, not laziness).

const baseAlert = {
  symbol: 'TEST', name: 'Test Token', contract: '0xabc0000000000000000000000000000000000a',
  priceUsd: 0.001, change24h: 45, volume24hUsd: 500_000, liquidityUsd: 80_000, fdvUsd: 900_000,
  reason: '+45.0% in 24h with $500K volume', riskLevel: 'MEDIUM',
}

// ── 1. With ZERO tokenAnalysis and ZERO whale rows, the report must still build (never throw)
//    and must mark every unresolvable field honestly rather than guessing. ──
const emptyReport = buildPumpIntelligenceReport({
  alert: baseAlert, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
})

assert.equal(emptyReport.historicalSimilarity.available, false, 'Historical Similarity must always be unavailable — no pump-outcome history table exists anywhere in this codebase')
assert.match(emptyReport.historicalSimilarity.reason, /no table|does not|not available/i, 'the reason must honestly explain the real gap, not a generic placeholder')

assert.equal(emptyReport.marketStructure.liquidityTrend.confidence, 'unavailable', 'liquidity trend must never claim a confidence level — only a point-in-time snapshot exists')
assert.equal(emptyReport.marketStructure.liquidityTrend.value, null, 'liquidity trend must never carry a fabricated value')
assert.equal(emptyReport.marketStructure.holderTrend.confidence, 'unavailable', 'holder trend must never claim a confidence level — only a point-in-time snapshot exists')
assert.equal(emptyReport.marketStructure.holderTrend.value, null, 'holder trend must never carry a fabricated value')

assert.equal(emptyReport.walletIntelligence.creatorActivity.confidence, 'unavailable', 'creator activity has no Base/EVM resolver — must stay unavailable, not inferred')
assert.equal(emptyReport.walletIntelligence.clusterAnalysis.confidence, 'unavailable', 'cluster/insider analysis is Solana-only — must stay unavailable for Base tokens')

// Risk factors this system genuinely cannot detect on any chain must render as 'unknown', never
// as a false 'clear' (which would read as "checked, and it's fine" — worse than not showing it).
const washTrading = emptyReport.riskAnalysis.find(r => r.label === 'Wash trading')
const bundleActivity = emptyReport.riskAnalysis.find(r => r.label === 'Bundle activity')
const botActivity = emptyReport.riskAnalysis.find(r => r.label === 'Bot activity')
const creatorSelling = emptyReport.riskAnalysis.find(r => r.label === 'Creator selling')
for (const factor of [washTrading, bundleActivity, botActivity, creatorSelling]) {
  assert.ok(factor, `expected a risk row for ${factor?.label ?? '(missing)'}`)
  assert.equal(factor.status, 'unknown', `${factor.label} is not implemented anywhere in this system — must be 'unknown', never 'clear' or 'confirmed'`)
  assert.equal(factor.confidence, 'unavailable', `${factor.label} must carry unavailable confidence, not a guessed level`)
}

// Momentum/continuation/pullback must degrade to 'unavailable' rather than inventing a score when
// the CORTEX risk read (riskEngine) never resolved.
assert.equal(emptyReport.executiveSummary.momentumScore, null, 'momentum score must be null, not a fabricated number, when riskEngine.rugRiskScore never resolved')
assert.equal(emptyReport.executiveSummary.continuationProbability, 'unavailable')
assert.equal(emptyReport.executiveSummary.pullbackRisk, 'unavailable')

// Every unresolved field above must ALSO be reflected in evidenceGaps — the honesty footer the UI
// renders — not just silently defaulted with no explanation surfaced to the reader.
assert.ok(emptyReport.evidenceGaps.length >= 4, `expected multiple evidence gaps to be recorded for an all-null input, got ${emptyReport.evidenceGaps.length}`)
assert.ok(emptyReport.evidenceGaps.some(g => /historical/i.test(g)), 'evidenceGaps must mention the Historical Similarity gap')

// ── 2. With real whale rows present, wallet intelligence must reflect them exactly — sorted by
//    USD descending, correctly split into buyers/sellers, and correctly flag tracked wallets. ──
const whaleRows = [
  { wallet_address: '0xWHALE1', side: 'buy', amount_usd: 50_000, occurred_at: '2026-01-01T00:00:00Z' },
  { wallet_address: '0xWHALE2', side: 'buy', amount_usd: 200_000, occurred_at: '2026-01-01T00:05:00Z' },
  { wallet_address: '0xWHALE3', side: 'sell', amount_usd: 30_000, occurred_at: '2026-01-01T00:10:00Z' },
]
const trackedAddresses = new Set(['0xwhale2'])
const populatedReport = buildPumpIntelligenceReport({
  alert: baseAlert, chain: 'base', tokenAnalysis: null, whaleRows, trackedAddresses,
})

assert.equal(populatedReport.walletIntelligence.largestBuyers.length, 2)
assert.equal(populatedReport.walletIntelligence.largestBuyers[0].address, '0xWHALE2', 'largest buyer must be sorted by amountUsd descending')
assert.equal(populatedReport.walletIntelligence.largestBuyers[0].isTracked, true, 'a wallet present in tracked_wallets must be flagged isTracked (case-insensitive match)')
assert.equal(populatedReport.walletIntelligence.largestBuyers[1].isTracked, false)
assert.equal(populatedReport.walletIntelligence.largestSellers.length, 1)
assert.equal(populatedReport.walletIntelligence.largestSellers[0].address, '0xWHALE3')
assert.equal(populatedReport.walletIntelligence.eventCount, 3)

// Historical Similarity must STILL be unavailable even with rich whale data present — this gap is
// about a missing DATA SOURCE (pump outcome history), not about this particular token's evidence.
assert.equal(populatedReport.historicalSimilarity.available, false)

// Timeline must include the whale events, most-recent first.
assert.ok(populatedReport.timeline.length >= 3, 'timeline must include the whale events')
assert.ok(new Date(populatedReport.timeline[0].timestamp).getTime() >= new Date(populatedReport.timeline[1].timestamp).getTime(), 'timeline must be sorted most-recent-first')

console.log('test-pump-intelligence-report.mjs: all assertions passed')

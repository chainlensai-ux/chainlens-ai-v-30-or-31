import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildPumpIntelligenceReport,
  computeLiveMomentumScore,
  computeLiveContinuationProbability,
  computeLivePullbackRisk,
} from '../lib/server/pumpIntelligence.ts'

// PUMP-INTELLIGENCE-REPORT, DISCLOSED: the report's whole premise is "never fabricate evidence,
// Unknown stays Unknown, separate verified facts from inference." These assertions exist to catch
// a regression where someone later "fills in" a plausible-looking number for a section this
// codebase genuinely has no data source for (most importantly Historical Similarity, and the
// liquidity/holder trend fields — both real gaps confirmed via a full data-source audit before
// this module was written, not laziness).
//
// LIVE-EVIDENCE REPORT FIX, DISCLOSED (audit requested: "too many core fields show Unavailable" even
// though the Pump Alert card already has real live market evidence). Momentum/continuation/pullback
// now compute from that live evidence whenever it exists, no longer gated entirely behind a
// successful internal /api/token (CORTEX) call — the assertions below were updated to match that
// intentional behavior change, while every genuinely-unsupported gap (Historical Similarity, trend
// fields, Solana-only wallet analysis, wash trading/bundle/bot detection) still asserts unavailable.

const baseAlert = {
  symbol: 'TEST', name: 'Test Token', contract: '0xabc0000000000000000000000000000000000a',
  priceUsd: 0.001, change24h: 45, change6h: 12, change1h: 3, volume24hUsd: 500_000, liquidityUsd: 80_000, fdvUsd: 900_000,
  tokenAgeDays: 3, pairAddress: '0xpool000000000000000000000000000000000a',
  reason: '+45.0% in 24h with $500K volume', riskLevel: 'MEDIUM',
}

// A truly empty alert — no live evidence at all — used to confirm scores genuinely degrade to
// unavailable rather than always finding *something* to compute from.
const emptyAlert = {
  symbol: 'EMPTY', name: 'Empty Token', contract: '0xdef0000000000000000000000000000000000b',
  priceUsd: null, change24h: null, volume24hUsd: null, liquidityUsd: null, fdvUsd: null,
  reason: 'Flagged by pump detection.', riskLevel: 'MEDIUM',
}

// ── 1. With ZERO tokenAnalysis, ZERO whale rows, and ZERO live evidence, the report must still
//    build (never throw) and must mark every unresolvable field honestly rather than guessing. ──
const emptyReport = buildPumpIntelligenceReport({
  alert: emptyAlert, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
})

assert.equal(emptyReport.historicalSimilarity.available, false, 'Historical Similarity must always be unavailable — no pump-outcome history table exists anywhere in this codebase')
assert.match(emptyReport.historicalSimilarity.reason, /no table|does not|not available/i, 'the reason must honestly explain the real gap, not a generic placeholder')

assert.equal(emptyReport.marketStructure.liquidityTrend.confidence, 'unavailable', 'liquidity trend must never claim a confidence level — only a point-in-time snapshot exists')
assert.equal(emptyReport.marketStructure.liquidityTrend.value, null, 'liquidity trend must never carry a fabricated value')
assert.equal(emptyReport.marketStructure.holderTrend.confidence, 'unavailable', 'holder trend must never claim a confidence level — only a point-in-time snapshot exists')
assert.equal(emptyReport.marketStructure.holderTrend.value, null, 'holder trend must never carry a fabricated value')

assert.equal(emptyReport.walletIntelligence.creatorActivity.confidence, 'unavailable', 'creator activity has no Base/EVM resolver — must stay unavailable, not inferred')
assert.equal(emptyReport.walletIntelligence.clusterAnalysis.confidence, 'unavailable', 'cluster/insider analysis is Solana-only — must stay unavailable for Base tokens')

// UNSUPPORTED-VS-UNKNOWN FIX, DISCLOSED: risk factors this system genuinely cannot detect on ANY
// chain must render as 'unsupported' (permanent gap), never 'unknown' (implies a retry might help)
// and never a false 'clear' (which would read as "checked, and it's fine" — worse than not showing it).
const washTrading = emptyReport.riskAnalysis.find(r => r.label === 'Wash trading')
const bundleActivity = emptyReport.riskAnalysis.find(r => r.label === 'Bundle activity')
const botActivity = emptyReport.riskAnalysis.find(r => r.label === 'Bot activity')
const creatorSelling = emptyReport.riskAnalysis.find(r => r.label === 'Creator selling')
for (const factor of [washTrading, bundleActivity, botActivity, creatorSelling]) {
  assert.ok(factor, `expected a risk row for ${factor?.label ?? '(missing)'}`)
  assert.equal(factor.status, 'unsupported', `${factor.label} is not implemented anywhere in this system — must be 'unsupported', never 'unknown', 'clear', or 'confirmed'`)
  assert.equal(factor.confidence, 'unavailable', `${factor.label} must carry unavailable confidence, not a guessed level`)
}

// Momentum/continuation/pullback must degrade to unavailable when there is genuinely ZERO evidence —
// no live market data AND no CORTEX read.
assert.equal(emptyReport.executiveSummary.momentumScore, null, 'momentum score must be null, not a fabricated number, with zero live evidence and no CORTEX read')
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

// ── 3. Live Momentum card opens report and computes Momentum Score (no CORTEX read at all). ──
{
  const liveOnlyReport = buildPumpIntelligenceReport({
    alert: baseAlert, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
  })
  assert.notEqual(liveOnlyReport.executiveSummary.momentumScore, null, 'Momentum Score must compute from live card evidence alone, without requiring a CORTEX read')
  assert.ok(liveOnlyReport.executiveSummary.momentumScore >= 0 && liveOnlyReport.executiveSummary.momentumScore <= 100, 'momentum score must stay within 0-100')
  assert.notEqual(liveOnlyReport.executiveSummary.momentumConfidence, 'unavailable', 'a purely live-evidence score without CORTEX must still carry a real confidence level')
  assert.notEqual(liveOnlyReport.executiveSummary.momentumConfidence, 'high', 'a purely live-evidence score without a CORTEX read must not claim the highest confidence tier — that is reserved for a blended read')
  assert.match(liveOnlyReport.executiveSummary.momentumEvidence, /Live estimate/, 'momentum evidence text must disclose it is a live estimate, not a CORTEX-verified read')
}

// ── 4. Report computes Continuation Probability without buy/sell split. ──
{
  const cont = computeLiveContinuationProbability(baseAlert, null, null)
  assert.notEqual(cont.band, 'unavailable', 'continuation probability must compute from live market structure even with no buy/sell split')
  const report = buildPumpIntelligenceReport({ alert: baseAlert, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set() })
  assert.notEqual(report.executiveSummary.continuationProbability, 'unavailable')
  assert.match(report.executiveSummary.continuationEvidence, /buy\/sell split unavailable/i, 'evidence text must explicitly disclose the missing buy/sell split per the required label')
}

// ── 5. Report computes Pullback Risk from 24h pump + liquidity + age. ──
{
  const extremePump = { ...baseAlert, change24h: 250, liquidityUsd: 5_000, tokenAgeDays: 0.1, fdvUsd: 25_000_000 }
  const pb = computeLivePullbackRisk(extremePump, false, false)
  assert.equal(pb.band, 'high', 'extreme 24h pump + thin liquidity + very young pool + high FDV + unresolved LP/honeypot must score as high pullback risk')
  assert.ok(pb.parts.some(p => /pump/i.test(p)))
  assert.ok(pb.parts.some(p => /liquidity/i.test(p)))
  assert.ok(pb.parts.some(p => /pool/i.test(p)))
  const report = buildPumpIntelligenceReport({ alert: extremePump, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set() })
  assert.equal(report.executiveSummary.pullbackRisk, 'high')
}

// ── 6. DexScreener txns.h24 maps into buys/sells/transactions. ──
{
  const dexScreenerTxns = { buys24h: 120, sells24h: 40, buys6h: 30, sells6h: 10, buys1h: 5, sells1h: 2 }
  const report = buildPumpIntelligenceReport({
    alert: baseAlert, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
    dexScreenerTxns, dexScreenerAttempted: true, dexScreenerSucceeded: true,
  })
  assert.equal(report.marketStructure.buys24h, 120)
  assert.equal(report.marketStructure.sells24h, 40)
  assert.equal(report.marketStructure.txns24h, 160)
  assert.equal(report.marketStructure.txnsSource, 'dexscreener', 'buys/sells must record which real provider resolved them')
  assert.ok(Math.abs(report.marketStructure.buySellRatio - 3) < 0.001)
}

// GeckoTerminal (via poolActivity) must be preferred over DexScreener when both resolve.
{
  const tokenAnalysis = { poolActivity: { buys24h: 80, sells24h: 20, pairCreatedAt: '2026-01-01T00:00:00Z' } }
  const dexScreenerTxns = { buys24h: 999, sells24h: 999, buys6h: null, sells6h: null, buys1h: null, sells1h: null }
  const report = buildPumpIntelligenceReport({
    alert: baseAlert, chain: 'base', tokenAnalysis, whaleRows: [], trackedAddresses: new Set(),
    dexScreenerTxns, dexScreenerAttempted: true, dexScreenerSucceeded: true,
  })
  assert.equal(report.marketStructure.buys24h, 80, 'GeckoTerminal poolActivity must win over DexScreener when both resolved')
  assert.equal(report.marketStructure.txnsSource, 'geckoterminal')
}

// ── 7. Missing exact 7d does not blank executive summary. ──
{
  const report = buildPumpIntelligenceReport({ alert: baseAlert, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set() })
  assert.equal(report.marketStructure.priceChange7d, null, 'exact 7d/14d change must stay honestly null when no provider resolved it')
  assert.notEqual(report.executiveSummary.momentumScore, null, 'a missing exact 7d/14d figure must NOT blank the Momentum Score — they are independent')
  assert.ok(report.evidenceGaps.some(g => /7d\/14d/i.test(g)), 'the specific 7d/14d gap must be recorded')
}

// ── 8. Token Scanner risk data populates risk cards. ──
{
  const tokenAnalysis = {
    riskEngine: { rugRiskScore: 20, rugRiskLabel: 'low', lpRisk: { confidence: 'high' } },
    holderDistribution: { top1: 8.2, top10: 34.5 },
    honeypot: false,
  }
  const report = buildPumpIntelligenceReport({ alert: baseAlert, chain: 'base', tokenAnalysis, whaleRows: [], trackedAddresses: new Set() })
  const holderRisk = report.riskAnalysis.find(r => r.label === 'Holder concentration')
  const honeypotRisk = report.riskAnalysis.find(r => r.label === 'Honeypot / sell-blocking')
  assert.equal(holderRisk.status, 'clear', 'Token Scanner holder distribution must resolve the holder-concentration risk card')
  assert.equal(honeypotRisk.status, 'clear', 'a resolved honeypot:false must render as clear, not unknown')
  assert.equal(honeypotRisk.confidence, 'high')
  assert.equal(report.executiveSummary.momentumConfidence, 'high', 'a resolved CORTEX read blended with live evidence must upgrade confidence to high')
}

// ── 9. Direct report URL attempts provider enrichment (route-level static assertion — this file has
//    no live server, so this checks the real route source calls the real enrichment functions). ──
{
  const routeSrc = fs.readFileSync(new URL('../app/api/pump-alerts/intelligence/route.ts', import.meta.url), 'utf8')
  const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(routeCode, /fetchDexScreenerPairMomentum/, 'route must attempt DexScreener enrichment')
  assert.match(routeCode, /computeSnapshotChange14d/, 'route must attempt internal snapshot enrichment when the alert has no exact 7d/14d figure')
  assert.match(routeCode, /searchParams\.get\('change14d'\)/, 'route must read the change14d param the Pump Alert card actually sends (previously only read the nonexistent change7d param)')
}

// ── 10. Wrong-chain provider result is rejected. ──
{
  const routeSrc = fs.readFileSync(new URL('../app/api/pump-alerts/intelligence/route.ts', import.meta.url), 'utf8')
  const routeCode = routeSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(routeCode, /result\.data\.chainId && result\.data\.chainId !== expectedChainId/, 'route must reject a DexScreener pair whose own chainId does not match the requested chain')
  assert.match(routeCode, /DEXSCREENER_CHAIN_ID/, 'route must map each supported chain to its real DexScreener chain id before trusting a pair')
}

// Wallet Intelligence collapse — UI-level static assertion (no DOM renderer in this harness).
{
  const pageSrc = fs.readFileSync(new URL('../app/terminal/pump-alerts/report/page.tsx', import.meta.url), 'utf8')
  const pageCode = pageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(pageCode, /report\.walletIntelligence\.eventCount === 0/, 'Wallet Intelligence must check for zero events to decide whether to collapse')
  assert.match(pageCode, /Wallet-level buyer\/seller evidence not available for this chain\/provider yet\./, 'collapsed Wallet Intelligence must show the specific required message')
  assert.match(pageCode, /unsupported: '#475569'/, 'RiskFactor status colors must cover the unsupported state')
  assert.match(pageCode, /unsupported: 'Unsupported'/, 'RiskFactor status labels must render Unsupported, not a generic Unknown')
}

console.log('test-pump-intelligence-report.mjs: all assertions passed')

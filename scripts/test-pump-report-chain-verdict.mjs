import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildPumpIntelligenceReport,
  chainTokenLabel,
} from '../lib/server/pumpIntelligence.ts'

// Chain copy + Clark Verdict pullback (ETH SPARKY / pullback=100 bugs).
const baseAlert = {
  symbol: 'TEST', name: 'Test Token', contract: '0xabc0000000000000000000000000000000000a',
  priceUsd: 0.001, change24h: 45, change6h: 12, change1h: 3, volume24hUsd: 500_000, liquidityUsd: 80_000, fdvUsd: 900_000,
  tokenAgeDays: 3, pairAddress: '0xpool000000000000000000000000000000000a',
  reason: '+45.0% in 24h with $500K volume', riskLevel: 'MEDIUM',
}

assert.equal(chainTokenLabel('eth'), 'Ethereum')
assert.equal(chainTokenLabel('ethereum'), 'Ethereum')
assert.equal(chainTokenLabel('ETH'), 'Ethereum')
assert.equal(chainTokenLabel('robinhood'), 'Robinhood Chain')
assert.equal(chainTokenLabel('base'), 'Base')
assert.equal(chainTokenLabel('Base'), 'Base')

const ethReport = buildPumpIntelligenceReport({
  alert: baseAlert, chain: 'eth', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
})
const creatorSelling = ethReport.riskAnalysis.find(r => r.label === 'Creator selling')
assert.ok(creatorSelling, 'Creator selling risk row must exist')
assert.match(creatorSelling.evidence, /Ethereum/, 'ETH reports must name Ethereum, not Base, in creator-selling copy')
assert.doesNotMatch(creatorSelling.evidence, /Base tokens|Base\/EVM/, 'ETH reports must not hardcode Base token copy')
const creatorKill = ethReport.killSignals.find(k => k.label === 'Creator sell')
assert.ok(creatorKill, 'Creator sell kill signal must exist')
assert.match(creatorKill.evidence, /Ethereum/, 'ETH kill-signal copy must name Ethereum')
assert.doesNotMatch(creatorKill.evidence, /Base tokens/, 'ETH kill-signal copy must not say Base tokens')

const robinReport = buildPumpIntelligenceReport({
  alert: baseAlert, chain: 'robinhood', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
})
assert.match(robinReport.riskAnalysis.find(r => r.label === 'Creator selling').evidence, /Robinhood Chain/)
const baseReport = buildPumpIntelligenceReport({
  alert: baseAlert, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
})
assert.match(baseReport.riskAnalysis.find(r => r.label === 'Creator selling').evidence, /Base tokens/)

const extremePump = { ...baseAlert, change24h: 250, liquidityUsd: 5_000, tokenAgeDays: 0.1, fdvUsd: 25_000_000 }
const report = buildPumpIntelligenceReport({
  alert: extremePump, chain: 'base', tokenAnalysis: null, whaleRows: [], trackedAddresses: new Set(),
})
assert.equal(report.executiveSummary.pullbackRisk, 'high', 'extreme pump fixture must resolve high pullback risk')
const topRisk = report.riskAnalysis.find(r => r.status === 'confirmed') ?? report.riskAnalysis.find(r => r.status === 'possible')
const highProbKill = report.killSignals.find(k => k.probability === 'high')
const es = report.executiveSummary
const pullbackRiskLabel = es.pullbackEvidence.split(/[.!?](?:\s|$)/)[0]?.trim() || 'High pullback risk'
const biggestRisk = topRisk?.label
  ?? (es.pullbackRisk === 'high' ? pullbackRiskLabel : undefined)
  ?? highProbKill?.label
  ?? 'No confirmed risk'
assert.notEqual(biggestRisk, 'No confirmed risk', 'high pullback must not surface "No confirmed risk" as biggest risk')
assert.equal(biggestRisk, pullbackRiskLabel, 'with no confirmed/possible rows, biggest risk must come from live pullback evidence')

const reportPageSrc = fs.readFileSync(new URL('../app/terminal/pump-alerts/report/page.tsx', import.meta.url), 'utf8')
const reportPageCode = reportPageSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
assert.match(reportPageCode, /es\.pullbackRisk === 'high'/, 'Clark Verdict must fall back to high pullback when no confirmed/possible risk row exists')
assert.match(reportPageCode, /High pullback risk/, 'Clark Verdict pullback fallback must have a short default label from the report')
assert.match(reportPageCode, /\{biggestRisk\}/, 'Clark Verdict biggest-risk slot must render the computed biggestRisk')
assert.doesNotMatch(reportPageCode, /topRisk\?\.label \?\? 'No confirmed risk'/, 'Clark Verdict must not ignore pullbackRisk and jump straight to "No confirmed risk"')
assert.match(reportPageCode, /tokenAgeDays\*24\)\.toFixed\(1\)\}h/, 'SeedShell age under 1 day must render hours to match the feed')
assert.doesNotMatch(reportPageCode, /tokenAgeDays < 1 \? '<1d'/, 'SeedShell must not collapse sub-day age to <1d')

console.log('test-pump-report-chain-verdict.mjs: all assertions passed')

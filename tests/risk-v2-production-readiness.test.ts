import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateTokenRiskScore, TOKEN_RISK_METHODOLOGY_VERSION } from '../lib/server/riskScore'
import { isCachedScanServable } from '../lib/server/cachedScanReuse'
import { TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, sanitizePublicTokenResponse } from '../lib/server/tokenPublicResponse'
import { snapshotFromScan } from '../lib/server/tokenOutcomeReceipt'
import { renderClarkTokenVerdictForEvm } from '../lib/server/clarkRouting'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TokenRiskEvidenceNotice from '../components/TokenRiskEvidenceNotice'
import { readFileSync, existsSync } from 'node:fs'

test('unrated remains null through the public API, Clark and Track eligibility', () => {
  const scan = { chain: 'base', contract: '0x' + 'a'.repeat(40), ...calculateTokenRiskScore({}), riskScoreType: 'risk_score', riskScoreDirection: 'higher_is_riskier' }
  assert.equal(sanitizePublicTokenResponse(scan, false).riskScore, null)
  assert.equal(snapshotFromScan(scan, 'user'), null)
  const text = renderClarkTokenVerdictForEvm({ ok: true, riskScore: null, riskScoreType: 'risk_score' }, scan.contract, 'Base', false)
  assert.match(text, /Risk Score: Unrated/)
  assert.doesNotMatch(text, /Risk Score: (0|50)\/100/)
})

test('every rated total can be reconstructed from the measured component ledger', () => {
  for (const input of [
    { marketCapUsd: 1e9, liquidityUsd: 1e7, holderDistribution: { top1: 2, top10: 20 } },
    { marketCapUsd: 2e6, liquidityUsd: 1e5, holderDistribution: { top1: 20, top10: 70 } },
    { liquidityUsd: 100, holderDistribution: { top1: 95 }, lpControl: { status: 'team_controlled' } },
  ]) {
    const r = calculateTokenRiskScore(input)
    const points = r.scoreEvidence.reduce((n, x) => n + x.safetyPoints, 0)
    const max = r.scoreEvidence.reduce((n, x) => n + x.maxPoints, 0)
    assert.equal(r.riskScore, 100 - Math.round(100 * points / max))
    assert.deepEqual(r.riskInputsUsed, r.scoreEvidence.map(x => x.input))
    assert.notEqual(r.confidence, 'high', 'market/holder evidence alone lacks LP and security proof')
  }
})

test('current-schema cache cannot serve a v1 score', async () => {
  const contract = '0x' + 'a'.repeat(40)
  const expectation = { chainSlug: 'base', chainId: 8453, contract }
  const entry = { chain: 'base', contract, scanResponseSchemaVersion: TOKEN_SCAN_RESPONSE_SCHEMA_VERSION, riskMethodologyVersion: 'evm_token_risk_score:v1' }
  assert.equal(await isCachedScanServable(entry, expectation, Date.now(), async () => false), false)
  assert.equal(await isCachedScanServable({ ...entry, riskMethodologyVersion: TOKEN_RISK_METHODOLOGY_VERSION }, expectation, Date.now(), async () => false), true)
})

test('concentrated model and missing simulation cannot supply high confidence or LP safety points', () => {
  const r = calculateTokenRiskScore({ marketCapUsd: 1e9, liquidityUsd: 1e7, holderDistribution: { top1: 2, top10: 20 }, lpControl: { status: 'concentrated_liquidity' } })
  assert.notEqual(r.confidence, 'high')
  assert.ok(!r.scoreEvidence.some(x => x.input === 'lpControl' || x.input === 'simulation'))
  const blocked = calculateTokenRiskScore({ honeypot: { isHoneypot: true } })
  assert.ok(blocked.riskScore! >= 85)
})

test('captured live WETH and USDT security evidence differs without treating possible admin flags as a proven critical finding', () => {
  const scores = ['not_detected', 'possible'].map(status => calculateTokenRiskScore({
    contractFlags: { mint: { status }, blacklist: { status }, pause: { status } },
    honeypot: { isHoneypot: false, buyTax: 0, sellTax: 0 },
  }))
  assert.deepEqual(scores.map(x => x.riskScore), [0, 40])
  assert.deepEqual(scores.map(x => x.confidence), ['low', 'low'])
  assert.deepEqual(scores.map(x => x.evidenceCoveragePercent), [25, 25])
})

test('captured WETH/USDT public scores retain coverage, visible caution, Clark interpretation and exact ledgers', () => {
  for (const [status, expected] of [['not_detected', 0], ['possible', 40]] as const) {
    const r = calculateTokenRiskScore({ contractFlags: { mint: { status }, blacklist: { status }, pause: { status } }, honeypot: { isHoneypot: false, buyTax: 0, sellTax: 0 } })
    const payload = sanitizePublicTokenResponse({ riskScore: r.riskScore, scoreEvidence: r.scoreEvidence, scoreAdjustments: r.scoreAdjustments, riskEvidenceCoveragePercent: r.evidenceCoveragePercent, riskEngine: { confidence: r.confidence } }, false)
    assert.equal(payload.riskScore, expected)
    assert.equal(payload.riskEvidenceCoveragePercent, 25)
    const html = renderToStaticMarkup(React.createElement(TokenRiskEvidenceNotice, { coverage: payload.riskEvidenceCoveragePercent, confidence: payload.riskEngine.confidence }))
    assert.match(html, /LIMITED EVIDENCE/)
    assert.match(html, /25% coverage/)
    assert.match(html, /low confidence/)
    assert.match(html, /including 0, is not a guarantee of safety/)
    const text = renderClarkTokenVerdictForEvm({ ok: true, riskScore: payload.riskScore, riskScoreType: 'risk_score', riskEvidenceCoveragePercent: payload.riskEvidenceCoveragePercent, riskConfidence: payload.riskEngine.confidence }, '0x' + 'a'.repeat(40), 'Ethereum', true)
    assert.match(text, new RegExp(`Risk Score: ${expected}/100`))
    assert.match(text, /25% coverage; low confidence/)
    const points = payload.scoreEvidence.reduce((sum, x) => sum + x.safetyPoints, 0)
    const max = payload.scoreEvidence.reduce((sum, x) => sum + x.maxPoints, 0)
    const adjusted = payload.scoreAdjustments.at(-1)?.safetyAfter ?? Math.round(points / max * 100)
    assert.equal(payload.riskScore, 100 - adjusted)
  }
  const page = readFileSync('app/terminal/token-scanner/page.tsx', 'utf8')
  assert.match(page, /riskEvidenceCoveragePercent: typeof json\.riskEvidenceCoveragePercent/)
  assert.match(page, /<TokenRiskEvidenceNotice coverage=\{result\.riskEvidenceCoveragePercent\}/)
})

test('Unrated notice renders and Risk Evolution restricts comparisons to matching methodologies', () => {
  const html = renderToStaticMarkup(React.createElement(TokenRiskEvidenceNotice, { coverage: 0, confidence: 'low' }))
  assert.match(html, /LIMITED EVIDENCE/)
  assert.match(html, /0% coverage/)
  const modelPath = 'app/terminal/token-scanner/cortexRiskEvolutionModel.ts'
  const evolution = readFileSync(existsSync(modelPath) ? modelPath : 'app/terminal/token-scanner/CortexRiskEvolution.tsx', 'utf8')
  assert.match(evolution, /o\.riskMethodologyVersion === latest\.riskMethodologyVersion/)
  assert.match(evolution, /o\.scannerVersion === latest\.scannerVersion/)
})

test('an inferred deployer cannot suppress measured cluster influence and hard caps record their adjustment', () => {
  const r = calculateTokenRiskScore({ deployerProfile: { clusterRisk: 'inferred' }, supplyControl: { clusterInfluence: { clusterRiskLabel: 'high' } } })
  assert.ok(r.scoreEvidence.some(x => x.input === 'clusterInfluence' && x.safetyPoints === 0))
  assert.equal(r.riskScore, 100)
  const taxOnly = calculateTokenRiskScore({ honeypot: { sellTax: 99 } })
  assert.equal(taxOnly.riskScore, 100)
  assert.equal(taxOnly.confidence, 'low')
  const capped = calculateTokenRiskScore({ marketCapUsd: 1e9, liquidityUsd: 1e7, holderDistribution: { top1: 2, top10: 20 }, lpControl: { status: 'burned' }, honeypot: { isHoneypot: true } })
  assert.equal(capped.scoreAdjustments[0]?.reason, 'confirmed_honeypot')
  assert.equal(capped.scoreAdjustments[0]?.safetyAfter, capped.safetyScore)
})

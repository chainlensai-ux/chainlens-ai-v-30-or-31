import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  CANONICAL_RISK_THRESHOLD,
  normalizeRiskScore,
  riskGaugeFillPercent,
} from '../lib/riskScoreDirection'
import { calculateTokenRiskScore } from '../lib/server/riskScore'
import { renderClarkTokenVerdictForEvm, type TokenScanEvidence } from '../lib/server/clarkRouting'

describe('canonical Risk Score direction', () => {
  it('maps raw risk 80 to Critical Risk and raw risk 20 to Low Risk', () => {
    const high = normalizeRiskScore({ rawScore: 80, rawScoreType: 'risk_score', source: 'test' })
    const low = normalizeRiskScore({ rawScore: 20, rawScoreType: 'risk_score', source: 'test' })
    assert.equal(high.riskScore0To100, 80)
    assert.equal(high.riskLabel, 'Critical Risk')
    assert.equal(low.riskScore0To100, 20)
    assert.equal(low.riskLabel, 'Low Risk')
    assert.equal(high.audit.inverted, false)
  })

  it('converts a Safety Score exactly once', () => {
    const result = normalizeRiskScore({
      rawScore: 25,
      rawScoreType: 'safety_score',
      riskDrivers: ['wallet-controlled LP'],
      confidence: 'high',
      source: 'legacy_safety_engine',
      displayLocation: 'risk_engine',
    })
    assert.equal(result.riskScore0To100, 75)
    assert.equal(result.riskLabel, 'Critical Risk')
    assert.equal(result.audit.inverted, true)
    assert.equal(result.audit.rawScore, 25)
    assert.equal(result.audit.convertedRiskScore, 75)
    assert.equal(result.audit.scoreDirection, 'higher_is_riskier')
    assert.equal(result.audit.thresholdUsed, CANONICAL_RISK_THRESHOLD)
  })

  it('does not guess the direction of an untyped historical score', () => {
    const result = normalizeRiskScore({ rawScore: 25, rawScoreType: 'unknown', source: 'legacy_watchlist' })
    assert.equal(result.riskScore0To100, null)
    assert.equal(result.riskLabel, null)
    assert.match(result.explanation, /direction was not recorded/)
  })

  it('preserves historical evidence points while exposing the inverse canonical total', () => {
    const scored = calculateTokenRiskScore({
      marketCapUsd: 50_000_000,
      liquidityUsd: 2_000_000,
      holderDistribution: { top1: 8, top5: 20, top10: 35 },
      lpControl: { status: 'burned', burnStatus: 'burned', lpControllerType: 'burn' },
      lpLockStatus: 'burned',
      lpProofApplicability: 'applicable',
      sourceVerified: true,
      contractFlags: {
        mint: { status: 'not_detected' }, blacklist: { status: 'not_detected' }, pause: { status: 'not_detected' },
      },
    })
    assert.equal(scored.riskScore, 100 - scored.safetyScore)
    assert.equal(scored.riskBreakdown.safetyTotal, scored.safetyScore)
    assert.equal(scored.riskBreakdown.total, scored.riskScore)
    assert.equal(scored.riskScoreDirectionAudit.inverted, true)
  })

  it('gives Overview and Risk Engine the same canonical presentation', () => {
    const apiScore = 67
    const overview = normalizeRiskScore({ rawScore: apiScore, rawScoreType: 'risk_score', source: 'token_scanner', displayLocation: 'overview' })
    const riskEngine = normalizeRiskScore({ rawScore: apiScore, rawScoreType: 'risk_score', source: 'token_scanner', displayLocation: 'risk_engine_tab' })
    assert.equal(overview.riskScore0To100, riskEngine.riskScore0To100)
    assert.equal(overview.riskLabel, riskEngine.riskLabel)
  })

  it('makes Clark state the same canonical Risk Score and label', () => {
    const evidence: TokenScanEvidence = {
      ok: true,
      token: { name: 'Test', symbol: 'TEST', address: '0x0000000000000000000000000000000000000001' },
      riskScore: 75,
      riskLabel: 'Critical Risk',
      riskScoreType: 'risk_score',
      market: { liquidity: 100_000 },
    }
    const answer = renderClarkTokenVerdictForEvm(evidence, evidence.token!.address!, 'Base', true)
    assert.match(answer, /Risk Score: 75\/100 — Critical Risk \(higher = riskier\)/)
  })

  it('increases gauge fill as risk increases', () => {
    assert.ok(riskGaugeFillPercent(80) > riskGaugeFillPercent(20))
    assert.equal(riskGaugeFillPercent(110), 100)
    assert.equal(riskGaugeFillPercent(-5), 0)
  })

  it('keeps Token Scanner and watchlist wired to canonical direction metadata', () => {
    const scanner = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
    const watchlist = readFileSync(new URL('../app/terminal/watchlist/page.tsx', import.meta.url), 'utf8')
    assert.match(scanner, /displayLocation: 'overview'/)
    assert.match(scanner, /displayLocation: 'risk_engine_tab'/)
    assert.match(scanner, /riskLabel: getRiskLabelDisplay\(result\.riskLabel\)/)
    assert.doesNotMatch(scanner, />TOKEN SAFETY SCORE</)
    assert.doesNotMatch(scanner, /Higher score means safer — evidence-weighted/)
    assert.match(watchlist, /effectiveScoreType === 'risk_score'/)
    assert.match(watchlist, /risk_score:/)
    assert.match(watchlist, /Rescan required/)
    assert.doesNotMatch(watchlist, /const score = 55 \+/)
  })
})

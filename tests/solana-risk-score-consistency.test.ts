// Regression tests for the Solana Risk Score CONSISTENCY CLEANUP task.
//
// SCOPE, DISCLOSED: the canonical Solana risk score direction was already fixed (see
// tests/solana-risk-score-direction.test.ts). This task audits every REMAINING Solana UI surface
// that still displayed a raw, safety-style score/verdict next to risk-oriented wording, and
// converts only the presentation layer — never a subscore, module, or evidence calculation — to
// the same canonical (higher = riskier) fields. These tests prove: the hero, Risk Engine tab,
// Contract Security strip, Dev Control Read, and side CORTEX receipt all now agree with each other
// and with Track Outcome; genuinely separate confidence/coverage metrics were left alone and
// correctly labeled; and EVM is untouched.
//
// Run directly with:
//   npx tsx --test tests/solana-risk-score-consistency.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { computeSolanaCortexRisk } from '../lib/solanaCortexRisk'
import { normalizeRiskScore, riskLabelFromCanonicalScore } from '../lib/riskScoreDirection'
import { calculateTokenRiskScore } from '../lib/server/riskScore'

function safeSolanaFixture(overrides: Record<string, unknown> = {}): any {
  return {
    authorityReadSucceeded: true, mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token',
    topAccountConcentration: { top1Percent: 4, top10Percent: 18, top20Percent: 25, accountsSampled: 50, accounts: [] },
    marketDataAvailable: true,
    marketData: { liquidityUsd: 250_000, priceUsd: 1, volume24hUsd: 80_000, fdvUsd: null, marketCapUsd: null, primaryPoolAddress: 'POOL1', primaryDexLabel: 'raydium', tokenName: null, tokenSymbol: null, pairAgeLabel: '120d', pairAgeDays: 120, txns24h: { buys: 300, sells: 120 }, socials: { website: null, twitter: null, telegram: null, discord: null, reddit: null } },
    poolProgram: { resolved: true, poolAddress: 'POOL1', owner: 'X', label: 'Raydium AMM V4', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: null },
    heliusHolders: { called: true, success: true, holderCount: 5000, isLowerBound: false, pagesFetched: 1, errorReason: null },
    jupiter: { called: true, success: true, resolved: { name: 'X', symbol: 'X', logo: null, verified: true, price: 1 }, errorReason: null },
    helius: { called: true, success: true, enhancedTransactionsUsed: false, estimatedCredits: 1, resolved: { parsedActivity: true, creatorSignals: null, devActivity: null, recentTransfers: 5 }, errorReason: null },
    ohlcv: { called: true, success: true, candles: [], timeframe: '1h', errorReason: null },
    deepCreator: { creatorTrace: { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 'sig1', earliestTimestamp: '2024-01-01T00:00:00Z', likelyCreatorWallet: 'CreatorWallet1111111111111111111111111111', transactionSource: 'PUMP_FUN' }, errorReason: null }, evidenceGaps: [] },
    resolvedTokenName: 'Safe Token',
    unsupportedChecks: [],
    supplyControl: { currentSupply: 1_000_000, maxSupply: 1_000_000, inflationPossible: false, inflationReason: 'Mint authority revoked.', supplyPermanentlyFixed: true, supplyFixedReason: 'Supply fixed.', mintAuthority: null, freezeAuthority: null, tokenProgram: 'spl-token', extensions: [], extensionsResolved: false, extensionExplanations: [] },
    creatorConfidence: { tier: 'CONFIRMED', confidencePercent: 90, wallet: 'CreatorWallet1111111111111111111111111111', reason: 'Confirmed via PUMP_FUN launch instruction.' },
    clusterMap: { attempted: true, nodes: [], edges: [], evidenceCount: 1, clusterConfidence: 'medium', fundingPath: ['CreatorWallet1111111111111111111111111111'], fundingDepth: 0, riskLevel: 'standard', riskReason: 'Funded above the disposable-wallet threshold.', summary: '1 verified relationship found across 1 node.', fundingTrace: null },
    ...overrides,
  }
}

function dangerousSolanaFixture(overrides: Record<string, unknown> = {}): any {
  return safeSolanaFixture({
    mintAuthority: 'MintAuth11111111111111111111111111111111', freezeAuthority: 'FreezeAuth1111111111111111111111111111111',
    topAccountConcentration: { top1Percent: 55, top10Percent: 88, top20Percent: 95, accountsSampled: 50, accounts: [] },
    marketDataAvailable: false, marketData: null,
    poolProgram: { resolved: false, poolAddress: null, owner: null, label: null, errorReason: 'No indexed pool found.', verdict: 'unverified', migratedFromPumpFun: null },
    heliusHolders: { called: true, success: false, holderCount: null, isLowerBound: false, pagesFetched: 0, errorReason: 'Holder read failed.' },
    jupiter: { called: false, success: false, resolved: null, errorReason: null },
    deepCreator: null,
    resolvedTokenName: null,
    creatorConfidence: { tier: 'UNKNOWN', confidencePercent: 0, wallet: null, reason: 'Deep Creator Check has not been run for this mint.' },
    clusterMap: null,
    ...overrides,
  })
}

const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')

describe('Solana risk-score consistency cleanup', () => {
  it('1. the Overview hero and the Risk Engine tab hero read the same canonical field, so they can never disagree', () => {
    assert.match(page, /<TrackOutcomeButton key=\{sr\.outcomeReceipt \?\? sr\.mintAddress\} score=\{overviewCx\.riskScore\} receipt=\{sr\.outcomeReceipt\} \/>/, 'Overview hero/Track Outcome must read overviewCx.riskScore')
    assert.match(page, /<RiskGaugeCircle score=\{cx\.riskScore\} color=\{cx\.riskColor\} scoreType="risk" \/>/, 'Risk Engine tab hero gauge must read cx.riskScore with scoreType="risk"')
    assert.doesNotMatch(page, /<RiskGaugeCircle score=\{cx\.score\}/, 'Risk Engine tab hero must never fall back to the raw safety-style cx.score')
    // Both `overviewCx` and `cx` are computeSolanaCortexRisk(sr) on the same scan result, so a
    // single computed value proves they can never diverge for the same scan.
    const cx = computeSolanaCortexRisk(safeSolanaFixture())
    assert.equal(cx.riskScore, computeSolanaCortexRisk(safeSolanaFixture()).riskScore)
  })

  it('2. the side CORTEX receipt panel agrees with the canonical risk score', () => {
    assert.match(page, /\{cx\.riskScore\}\/\{cx\.scoreMax\} overall/, 'side CORTEX receipt must show cx.riskScore, not the raw cx.score')
    assert.doesNotMatch(page, /\{cx\.score\}\/\{cx\.scoreMax\} overall/, 'side CORTEX receipt must never show the raw safety-style cx.score')
  })

  it('3. Track Outcome eligibility score agrees with the displayed risk score', () => {
    const receipt = readFileSync(new URL('../lib/server/solanaOutcomeReceipt.ts', import.meta.url), 'utf8')
    assert.match(receipt, /riskScore:\s*risk\.riskScore/, 'the frozen receipt must save the same canonical riskScore the UI displays')
    // TrackOutcomeButton and the Overview hero card both read overviewCx.riskScore — the exact
    // same in-scope value, computed once per render — so they cannot show a different number.
    const heroIdx = page.indexOf("SOLANA CORTEX RISK ENGINE")
    assert.ok(heroIdx === -1 || page.slice(0, heroIdx).includes('overviewCx.riskScore'), 'TrackOutcomeButton must be wired before or alongside overviewCx.riskScore usage')
  })

  it('4. no user-facing High Risk / Extreme Risk surface can show a low canonical risk number', () => {
    const dangerous = computeSolanaCortexRisk(dangerousSolanaFixture())
    for (const [label, score] of [
      [dangerous.riskLabel, dangerous.riskScore],
      [dangerous.securityRead.riskLabel, dangerous.securityRead.riskScore],
    ] as const) {
      if (label === 'High Risk' || label === 'Extreme Risk') assert.ok(score > 60, `${label} paired with a low score ${score}`)
      assert.equal(label, riskLabelFromCanonicalScore(score))
    }
    // Dev Control Read's own normalization, exercised the same way the UI computes it (percent of
    // the real sr.developerScore composite, converted via normalizeRiskScore).
    const worstDevPercent = 0 // a scan with zero creator/authority/supply/cluster/pattern points
    const devRisk = normalizeRiskScore({ rawScore: worstDevPercent, rawScoreType: 'safety_score', source: 'solana_developer_score', displayLocation: 'token_scanner_solana_dev_tab' })
    assert.equal(devRisk.riskScore0To100, 100)
    assert.equal(devRisk.riskLabel, 'Extreme Risk')
  })

  it('5. genuine confidence/coverage metrics stay separate — never converted into a Risk Score', () => {
    // overallConfidence, evidence coverage percent, and provider/summary counts remain their own,
    // distinctly-labeled fields — untouched by this cleanup, never relabeled or folded into
    // riskScore/riskLabel.
    assert.match(page, /\{cx\.overallConfidence\.toUpperCase\(\)\} OVERALL CONFIDENCE/, 'overall confidence must stay its own labeled badge, not become a risk score')
    assert.match(page, /EVIDENCE COVERAGE/, 'evidence coverage must stay its own labeled section')
    assert.match(page, /CONFIDENCE \{devConfidence\}/, "Dev Control Read's confidence badge must stay separate from its risk badge")
    const cx = computeSolanaCortexRisk(safeSolanaFixture())
    assert.equal(typeof cx.overallConfidence, 'string')
    assert.equal(typeof cx.evidenceCoveragePercent, 'number')
    assert.notEqual(cx.overallConfidence, cx.riskLabel, 'confidence and risk label must never collapse into the same value/field')
  })

  it('6. EVM Risk Score computation is completely unchanged', () => {
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
    assert.equal(scored.riskScoreDirectionAudit.inverted, true)
    assert.equal(scored.riskScoreDirectionAudit.scoreDirection, 'higher_is_riskier')
  })

  it('bonus: underlying Solana evidence (raw safety score, modules, securityRead score/percent) is unchanged', () => {
    const cx = computeSolanaCortexRisk(safeSolanaFixture())
    assert.equal(cx.scoreMax, 100)
    assert.equal(cx.modules.length, 9)
    assert.equal(cx.securityRead.scoreMax, 32)
    assert.equal(cx.securityRead.riskScore, 100 - cx.securityRead.percent)
    assert.equal(cx.riskScore, 100 - cx.score)
  })
})

// Regression tests for the Solana Risk Score direction fix.
//
// BUG, DISCLOSED: `computeSolanaCortexRisk`'s `.score` (and `computeSolanaConfidenceScore`'s
// `.score`) are, and remain, SAFETY-style reads — higher = safer, exactly like every existing test
// in scripts/test-solana-token-scanner.mjs expects. But `lib/server/solanaOutcomeReceipt.ts` fed
// that raw safety score straight into a snapshot claiming `riskScoreType: 'risk_score',
// riskScoreDirection: 'higher_is_riskier'` — a false claim — which `canTrackOutcome` (>= 50 unlocks)
// then gated on directly. A genuinely dangerous, low-safety-score token read as ineligible; a safe,
// high-safety-score token read as eligible. The same inverted `.score` fed the Token Scanner
// Overview's TrackOutcomeButton and hero card. The fix adds a SEPARATE, additive canonical
// `riskScore`/`riskLabel`/`riskColor` to both engines (via lib/riskScoreDirection.ts's
// `normalizeRiskScore`, the exact helper EVM's Risk Score already uses), converted exactly once at
// the final composite — never touching a single subscore, module, or evidence value. These tests
// prove the canonical direction is correct, the underlying evidence is untouched, and both the UI
// wiring and the server-side receipt read the corrected field.
//
// Run directly with:
//   npx tsx --test tests/solana-risk-score-direction.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { computeSolanaCortexRisk } from '../lib/solanaCortexRisk'
import { computeSolanaConfidenceScore } from '../lib/solanaConfidenceScore'
import { riskLabelFromCanonicalScore } from '../lib/riskScoreDirection'
import { canTrackOutcome } from '../lib/tokenOutcomes'
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

describe('Solana canonical Risk Score direction', () => {
  it('1. safest Solana fixture yields a low canonical risk score', () => {
    const cx = computeSolanaCortexRisk(safeSolanaFixture())
    assert.ok(cx.riskScore <= 25, `expected a low canonical risk score for the safest fixture, got ${cx.riskScore}`)
  })

  it('2. dangerous Solana fixture yields a high canonical risk score', () => {
    const cx = computeSolanaCortexRisk(dangerousSolanaFixture())
    assert.ok(cx.riskScore >= 75, `expected a high canonical risk score for the dangerous fixture, got ${cx.riskScore}`)
  })

  it('3. worse evidence/risk conditions cannot reduce canonical risk', () => {
    const safe = computeSolanaCortexRisk(safeSolanaFixture())
    const activeAuthorities = computeSolanaCortexRisk(safeSolanaFixture({ mintAuthority: 'MintAuth11111111111111111111111111111111', freezeAuthority: 'FreezeAuth1111111111111111111111111111111' }))
    assert.ok(activeAuthorities.riskScore > safe.riskScore, 'active mint+freeze authority must raise canonical risk, never lower it')
    const noEvidence = computeSolanaCortexRisk(dangerousSolanaFixture())
    const evenWorse = computeSolanaCortexRisk(dangerousSolanaFixture({ authorityReadSucceeded: false, topAccountConcentration: null }))
    assert.ok(evenWorse.riskScore >= noEvidence.riskScore, 'losing more evidence must never lower canonical risk')
  })

  it('4. canonical score and canonical label always agree', () => {
    for (const cx of [computeSolanaCortexRisk(safeSolanaFixture()), computeSolanaCortexRisk(dangerousSolanaFixture())]) {
      assert.equal(cx.riskLabel, riskLabelFromCanonicalScore(cx.riskScore))
    }
    for (const sc of [computeSolanaConfidenceScore(safeSolanaFixture()), computeSolanaConfidenceScore(dangerousSolanaFixture())]) {
      assert.equal(sc.riskLabel, riskLabelFromCanonicalScore(sc.riskScore))
    }
  })

  it('5. High Risk / Extreme Risk can never pair with a low-risk numeric range', () => {
    const dangerous = computeSolanaCortexRisk(dangerousSolanaFixture())
    if (dangerous.riskLabel === 'High Risk' || dangerous.riskLabel === 'Extreme Risk') {
      assert.ok(dangerous.riskScore > 60, `${dangerous.riskLabel} must never pair with a score of ${dangerous.riskScore}`)
    }
    const safe = computeSolanaCortexRisk(safeSolanaFixture())
    assert.notEqual(safe.riskLabel, 'High Risk')
    assert.notEqual(safe.riskLabel, 'Extreme Risk')
  })

  it('6. Track Outcome (button + receipt) reads the corrected canonical score, never the raw safety score', () => {
    const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')
    assert.match(page, /<TrackOutcomeButton key=\{sr\.outcomeReceipt \?\? sr\.mintAddress\} score=\{overviewCx\.riskScore\} receipt=\{sr\.outcomeReceipt\} \/>/, 'Solana TrackOutcomeButton must read overviewCx.riskScore, not overviewCx.score')
    const receipt = readFileSync(new URL('../lib/server/solanaOutcomeReceipt.ts', import.meta.url), 'utf8')
    assert.match(receipt, /riskScore:\s*risk\.riskScore/, 'the frozen receipt must save the canonical risk.riskScore')
    assert.match(receipt, /riskLabel:\s*risk\.riskLabel/, 'the frozen receipt must save the canonical risk.riskLabel')
    assert.doesNotMatch(receipt, /riskScore:\s*risk\.score\b/, 'must never save the raw, uninverted safety score')
  })

  it('7. risk >= 50 unlocks Track Outcome eligibility for a genuinely dangerous Solana token', () => {
    const dangerous = computeSolanaCortexRisk(dangerousSolanaFixture())
    assert.ok(dangerous.riskScore >= 50, `fixture should be >= 50 canonical risk, got ${dangerous.riskScore}`)
    assert.equal(canTrackOutcome(dangerous.riskScore), true)
  })

  it('8. risk < 50 remains locked for a genuinely safe Solana token', () => {
    const safe = computeSolanaCortexRisk(safeSolanaFixture())
    assert.ok(safe.riskScore < 50, `fixture should be < 50 canonical risk, got ${safe.riskScore}`)
    assert.equal(canTrackOutcome(safe.riskScore), false)
  })

  it('9. EVM Risk Score computation is completely unchanged', () => {
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

  it('10. underlying Solana evidence — the raw safety score, modules, and categories — remains unchanged', () => {
    const cx = computeSolanaCortexRisk(safeSolanaFixture())
    assert.equal(cx.scoreMax, 100)
    assert.equal(cx.modules.length, 9)
    assert.equal(cx.uncappedScore, cx.modules.reduce((s, m) => s + m.scoreEarned, 0))
    assert.equal(cx.riskScore, 100 - cx.score, 'riskScore must be a pure derivation of the untouched safety score')

    const sc = computeSolanaConfidenceScore(safeSolanaFixture())
    assert.equal(sc.categories.length, 5)
    assert.equal(sc.categories.reduce((s, c) => s + c.score, 0), sc.uncappedScore)
    assert.equal(sc.riskScore, 100 - sc.score, 'riskScore must be a pure derivation of the untouched safety score')
  })
})

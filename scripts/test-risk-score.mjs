/**
 * Validation script for the deterministic Token Risk Score
 * (lib/server/riskScore.ts).
 *
 * Runs three canonical scenarios — a VIRTUAL-like mature token with a
 * wallet-controlled LP, a fresh microcap, and a burned/locked mature
 * token — and checks the relative ordering and labels described in the
 * Token Risk Scoring System task. Also checks determinism, missing-field
 * defaults, and absence of provider names in the output.
 *
 * Run: node --experimental-strip-types scripts/test-risk-score.mjs
 */

import { calculateTokenRiskScore } from '../lib/server/riskScore.ts'

let passed = 0
let failed = 0

function assert(label, condition, got) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ FAIL: ${label} — got: ${JSON.stringify(got)}`)
    failed++
  }
}

// ─── Scenario 1: VIRTUAL-like mature token ─────────────────────────────────
console.log('\nScenario 1: VIRTUAL-like mature token (mcap ~$400M, liquidity ~$4.3M, top10 ~48%, wallet-controlled LP, mint detected)')
const virtualInput = {
  marketCapUsd: 400_000_000,
  fdvUsd: 420_000_000,
  displayMarketValue: 400_000_000,
  displayMarketValueLabel: 'Market Cap',
  displayMarketValueConfidence: 'verified',
  liquidityUsd: 4_300_000,
  holderDistribution: { top1: 12, top5: 30, top10: 48 },
  lpControl: {
    status: 'team_controlled',
    displayLpModel: 'erc20_lp_token',
    lockStatus: 'not_confirmed',
    burnStatus: 'not_confirmed',
    proofStatus: 'open_check',
    lpController: '0xTeamWallet',
    lpControllerType: 'wallet',
  },
  lpLockStatus: 'unverified',
  lpProofApplicability: 'applicable',
  lpProofStatus: 'open_check',
  lpModelProof: { model: 'v2', standardLockApplies: true },
  lpMigrationProof: { status: 'low' },
  contractFlags: {
    mint: { status: 'verified' },
    blacklist: { status: 'not_detected' },
    pause: { status: 'not_detected' },
  },
  honeypot: { buyTax: 1, sellTax: 1, transferTax: 0 },
  sourceVerified: true,
  deployerProfile: { status: 'verified', clusterRisk: 'clean' },
  sniperActivity: { status: 'low_signal' },
  holderIntelligence: { earlyBuyerConcentration: 'low' },
  supplyControl: { clusterInfluence: { clusterRiskScore: 5, clusterRiskLabel: 'low' } },
}
const virtualResult = calculateTokenRiskScore(virtualInput)
console.log('  riskScore:', virtualResult.riskScore, 'riskLabel:', virtualResult.riskLabel)
console.log('  breakdown:', JSON.stringify(virtualResult.riskBreakdown, null, 2))

assert('marketMaturity is high (>=20/30)', virtualResult.riskBreakdown.marketMaturity.score >= 20, virtualResult.riskBreakdown.marketMaturity.score)
assert('liquiditySafety is low (<=10/30) due to wallet-controlled LP', virtualResult.riskBreakdown.liquiditySafety.score <= 10, virtualResult.riskBreakdown.liquiditySafety.score)
assert('lpLockOrBurn component is 0 (team-controlled, no lock/burn)', virtualResult.riskBreakdown.liquiditySafety.components.lpLockOrBurn === 0, virtualResult.riskBreakdown.liquiditySafety.components.lpLockOrBurn)
assert('contractSafety penalized for mint (<=15/20)', virtualResult.riskBreakdown.contractSafety.score <= 15, virtualResult.riskBreakdown.contractSafety.score)
assert('total is meaningful (not extreme/0)', virtualResult.riskScore > 30, virtualResult.riskScore)

// ─── Scenario 2: Fresh microcap ─────────────────────────────────────────────
console.log('\nScenario 2: Fresh microcap (mcap <$1M, liquidity <$50k, top1>50%, LP unknown/unlocked, unverified source, unknown deployer)')
const microcapInput = {
  marketCapUsd: 400_000,
  fdvUsd: 1_000_000,
  displayMarketValue: 400_000,
  displayMarketValueLabel: 'Market Cap',
  displayMarketValueConfidence: 'low',
  liquidityUsd: 12_000,
  holderDistribution: { top1: 65, top5: 80, top10: 90 },
  lpControl: {
    status: 'open_check',
    displayLpModel: 'open_check',
    lockStatus: 'not_confirmed',
    burnStatus: 'not_confirmed',
    proofStatus: 'open_check',
    lpController: null,
    lpControllerType: 'unknown',
  },
  lpLockStatus: 'unverified',
  lpProofApplicability: 'unknown',
  lpProofStatus: 'open_check',
  lpModelProof: { model: 'unknown', standardLockApplies: null },
  lpMigrationProof: { status: 'inferred' },
  contractFlags: {
    mint: { status: 'inferred' },
    blacklist: { status: 'inferred' },
    pause: { status: 'inferred' },
  },
  honeypot: null,
  sourceVerified: false,
  deployerProfile: { status: 'inferred', clusterRisk: 'inferred' },
  sniperActivity: { status: null },
  holderIntelligence: { earlyBuyerConcentration: 'inferred' },
  supplyControl: { clusterInfluence: { clusterRiskScore: null, clusterRiskLabel: 'open_check' } },
}
const microcapResult = calculateTokenRiskScore(microcapInput)
console.log('  riskScore:', microcapResult.riskScore, 'riskLabel:', microcapResult.riskLabel)

assert('microcap riskScore is much lower than VIRTUAL', microcapResult.riskScore < virtualResult.riskScore - 15, { microcap: microcapResult.riskScore, virtual: virtualResult.riskScore })
assert('microcap riskLabel is extreme or high', microcapResult.riskLabel === 'extreme' || microcapResult.riskLabel === 'high', microcapResult.riskLabel)

// ─── Scenario 3: Burned/locked mature token ─────────────────────────────────
console.log('\nScenario 3: Burned/locked mature token (good market maturity, burned LP, no critical flags)')
const burnedInput = {
  marketCapUsd: 50_000_000,
  fdvUsd: 50_000_000,
  displayMarketValue: 50_000_000,
  displayMarketValueLabel: 'Market Cap',
  displayMarketValueConfidence: 'verified',
  liquidityUsd: 2_000_000,
  holderDistribution: { top1: 8, top5: 20, top10: 35 },
  lpControl: {
    status: 'burned',
    displayLpModel: 'erc20_lp_token',
    lockStatus: 'not_applicable',
    burnStatus: 'burned',
    proofStatus: 'verified',
    lpController: '0x000000000000000000000000000000000000dEaD',
    lpControllerType: 'burn',
  },
  lpLockStatus: 'burned',
  lpProofApplicability: 'applicable',
  lpProofStatus: 'confirmed',
  lpModelProof: { model: 'v2', standardLockApplies: true },
  lpMigrationProof: { status: 'low' },
  contractFlags: {
    mint: { status: 'not_detected' },
    blacklist: { status: 'not_detected' },
    pause: { status: 'not_detected' },
  },
  honeypot: { buyTax: 0, sellTax: 0, transferTax: 0 },
  sourceVerified: true,
  deployerProfile: { status: 'verified', clusterRisk: 'clean' },
  sniperActivity: { status: 'low_signal' },
  holderIntelligence: { earlyBuyerConcentration: 'low' },
  supplyControl: { clusterInfluence: { clusterRiskScore: 2, clusterRiskLabel: 'low' } },
}
const burnedResult = calculateTokenRiskScore(burnedInput)
console.log('  riskScore:', burnedResult.riskScore, 'riskLabel:', burnedResult.riskLabel)

assert('burned/locked token riskScore is high (>=61)', burnedResult.riskScore >= 61, burnedResult.riskScore)
assert('burned/locked token riskLabel is low or very_low', burnedResult.riskLabel === 'low' || burnedResult.riskLabel === 'very_low', burnedResult.riskLabel)
assert('burned/locked token scores higher than VIRTUAL', burnedResult.riskScore > virtualResult.riskScore, { burned: burnedResult.riskScore, virtual: virtualResult.riskScore })

// ─── Scenario 4: VIRTUAL-like with unknown LP controller, no lock/burn proof ──
console.log('\nScenario 4: VIRTUAL-like mature token but LP controller is unresolved/unknown (same market evidence as Scenario 1)')
const unknownControllerInput = {
  ...virtualInput,
  lpControl: {
    status: 'partial',
    displayLpModel: 'erc20_lp_token',
    lockStatus: 'not_confirmed',
    burnStatus: 'not_confirmed',
    proofStatus: 'open_check',
    lpController: null,
    lpControllerType: 'unknown',
  },
}
const unknownControllerResult = calculateTokenRiskScore(unknownControllerInput)
console.log('  riskScore:', unknownControllerResult.riskScore, 'riskLabel:', unknownControllerResult.riskLabel)

assert('lpLockOrBurn for unknown controller is 0 (not higher than wallet-controlled)', unknownControllerResult.riskBreakdown.liquiditySafety.components.lpLockOrBurn === 0, unknownControllerResult.riskBreakdown.liquiditySafety.components.lpLockOrBurn)
assert('lpControllerRisk for unknown controller is 0 (not higher than wallet-controlled)', unknownControllerResult.riskBreakdown.liquiditySafety.components.lpControllerRisk === 0, unknownControllerResult.riskBreakdown.liquiditySafety.components.lpControllerRisk)
assert('unknown-controller liquiditySafety is not higher than wallet-controlled VIRTUAL', unknownControllerResult.riskBreakdown.liquiditySafety.score <= virtualResult.riskBreakdown.liquiditySafety.score, { unknown: unknownControllerResult.riskBreakdown.liquiditySafety.score, virtual: virtualResult.riskBreakdown.liquiditySafety.score })
assert('unknown-controller riskScore is not higher (more bullish) than wallet-controlled VIRTUAL', unknownControllerResult.riskScore <= virtualResult.riskScore, { unknown: unknownControllerResult.riskScore, virtual: virtualResult.riskScore })
assert('unknown-controller riskLabel is not a "safer" label than VIRTUAL', !(unknownControllerResult.riskLabel === 'low' && virtualResult.riskLabel === 'moderate'), { unknown: unknownControllerResult.riskLabel, virtual: virtualResult.riskLabel })

// ─── Determinism ────────────────────────────────────────────────────────────
console.log('\nDeterminism checks')
const virtualResult2 = calculateTokenRiskScore(virtualInput)
assert('same input returns same riskScore', virtualResult.riskScore === virtualResult2.riskScore, { a: virtualResult.riskScore, b: virtualResult2.riskScore })
assert('same input returns same riskLabel', virtualResult.riskLabel === virtualResult2.riskLabel, { a: virtualResult.riskLabel, b: virtualResult2.riskLabel })
assert('same input returns deep-equal breakdown', JSON.stringify(virtualResult.riskBreakdown) === JSON.stringify(virtualResult2.riskBreakdown), 'mismatch')

// ─── Missing fields / no throwing ──────────────────────────────────────────
console.log('\nMissing-field safety checks')
let emptyResult
try {
  emptyResult = calculateTokenRiskScore({})
  assert('empty input does not throw', true)
} catch (e) {
  assert('empty input does not throw', false, String(e))
  emptyResult = null
}
if (emptyResult) {
  assert('empty input riskScore is a finite number between 0 and 100', Number.isFinite(emptyResult.riskScore) && emptyResult.riskScore >= 0 && emptyResult.riskScore <= 100, emptyResult.riskScore)
  assert('empty input total matches riskScore', emptyResult.riskBreakdown.total === emptyResult.riskScore, emptyResult.riskBreakdown)
}

// ─── No provider names in output ────────────────────────────────────────────
console.log('\nProvider-name leakage check')
const providerNames = ['goldrush', 'goplus', 'honeypot.is', 'moralis', 'geckoterminal', 'alchemy', 'pinklock']
const serialized = JSON.stringify([virtualResult, microcapResult, burnedResult, emptyResult]).toLowerCase()
for (const name of providerNames) {
  assert(`no "${name}" in output`, !serialized.includes(name), name)
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}

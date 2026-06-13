/**
 * Regression test for the CORTEX Risk Engine score/verdict calculation
 * (lib/token/scoring.ts -> calculateCortexScoreV2).
 *
 * Verifies:
 *  - Scary evidence (extreme holder concentration, wallet/team-controlled
 *    LP, no lock/burn proof, active owner) produces a real, low numeric
 *    score with a non-"Open Check" verdict, even when other categories
 *    (security/dev) are missing.
 *  - "Open Check" is reserved for genuinely no usable evidence across all
 *    core categories.
 *  - A healthy/verified token is not capped and gets a strong score.
 *
 * Run: node --experimental-strip-types scripts/test-cortex-risk-engine.mjs
 */

import { calculateCortexScoreV2 } from '../lib/token/scoring.ts'

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

// ─── Section A: Scary-evidence token (Top10/Top20 = 100%, wallet-controlled LP) ───

console.log('Section A: Scary-evidence token (Top10/Top20 = 100%, wallet-controlled LP, active owner)')

const scaryInput = {
  price: 0.0000012,
  liquidity: 8_000,
  liquidityUsd: 8_000,
  marketCapUsd: 12_000,
  volume24h: 500,
  holderDistribution: {
    top1: 96,
    top10: 100,
    top20: 100,
    holderCount: 8,
  },
  lpControl: {
    status: 'team_controlled',
    evidence: ['owner_lp_share=100.00%'],
  },
  security: {
    devOwnership: { isRenounced: false },
  },
  riskDrivers: [
    'LP Control indicates a dominant team wallet can control liquidity.',
    'Dev Control: ownership is held by a wallet.',
    'Holder concentration is very high (Top 10 > 70%).',
  ],
}

const scary = calculateCortexScoreV2(scaryInput)

assert('riskScore (cortexScore) is a number', typeof scary.cortexScore === 'number', scary.cortexScore)
assert('verdict is not Open Check', scary.cortexVerdict !== 'Open Check', scary.cortexVerdict)
assert('displayScore is numeric (not "Open Check")', scary.displayScore !== 'Open Check', scary.displayScore)
assert('isOpenCheck is false', scary.isOpenCheck === false, scary.isOpenCheck)
assert('score is capped <= 30 (severe risk profile)', scary.cortexScore != null && scary.cortexScore <= 30, scary.cortexScore)
assert('severity verdict is High Risk', scary.cortexVerdict === 'High Risk', scary.cortexVerdict)
assert('open checks can exist alongside a numeric score', Array.isArray(scary.openChecks), scary.openChecks)
assert('coverage is reported alongside the numeric score', typeof scary.scoreCoveragePercent === 'number' && scary.scoreCoveragePercent > 0, scary.scoreCoveragePercent)

// ─── Section B: Genuinely no usable evidence ───────────────────────────────

console.log('\nSection B: Genuinely no usable evidence across core categories')

const emptyResult = calculateCortexScoreV2({})

assert('score is null when there is no usable evidence at all', emptyResult.cortexScore === null, emptyResult.cortexScore)
assert('verdict is Open Check', emptyResult.cortexVerdict === 'Open Check', emptyResult.cortexVerdict)
assert('isOpenCheck is true', emptyResult.isOpenCheck === true, emptyResult.isOpenCheck)
assert('displayScore is "Open Check"', emptyResult.displayScore === 'Open Check', emptyResult.displayScore)
assert('confidence is insufficient', emptyResult.cortexConfidence === 'insufficient', emptyResult.cortexConfidence)

// ─── Section C: Healthy token regression (no severe caps applied) ─────────

console.log('\nSection C: Healthy token regression (verified LP burn, low concentration)')

const healthyInput = {
  price: 0.05,
  liquidity: 2_000_000,
  liquidityUsd: 2_000_000,
  marketCapUsd: 25_000_000,
  fdvUsd: 26_000_000,
  volume24h: 800_000,
  pools: [{}],
  priceChange24h: 4,
  poolActivity: { pairCreatedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() },
  holderDistribution: {
    top1: 8,
    top10: 32,
    top20: 45,
    holderCount: 5_000,
  },
  lpControl: {
    status: 'burned',
    evidence: ['burn_share=100.00%'],
  },
  honeypot: { isHoneypot: false, buyTax: 1, sellTax: 1, simulationSuccess: true },
  contractFlags: {
    mint: { status: 'not_detected' },
    pause: { status: 'not_detected' },
    blacklist: { status: 'not_detected' },
    proxy: { status: 'not_detected' },
    withdraw: { status: 'not_detected' },
    bytecodeChecked: true,
  },
  security: {
    devOwnership: { isRenounced: true },
    contractFlags: { mint: false, pause: false, blacklist: false, proxy: false },
  },
}

const healthy = calculateCortexScoreV2(healthyInput)

assert('healthy token gets a numeric score', typeof healthy.cortexScore === 'number', healthy.cortexScore)
assert('healthy token is not Open Check', healthy.cortexVerdict !== 'Open Check', healthy.cortexVerdict)
assert('healthy token score is not severely capped (> 50)', healthy.cortexScore != null && healthy.cortexScore > 50, healthy.cortexScore)
assert('healthy token verdict reflects a strong/positive read', healthy.cortexVerdict === 'Strong' || healthy.cortexVerdict === 'Watch', healthy.cortexVerdict)

// ─── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

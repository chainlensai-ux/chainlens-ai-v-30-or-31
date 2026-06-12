/**
 * Validation script for the /api/token public-vs-debug response shape
 * (lib/server/publicTokenResponse.ts, lib/server/lpProof.ts publicLpDataMode).
 *
 * Checks that normal (debug !== true) responses:
 *  - keep the Token Safety Score (riskScore/riskLabel/riskBreakdown)
 *  - drop the legacy top-level CORTEX V2 score fields
 *  - drop riskEngine.rugRiskScore/rugRiskLabel/cortexScoreDebug
 *  - cap heavy priceChart.points arrays
 *  - keep LP public status fields internally consistent and non-conflicting
 *  - leave GOAL/concentrated proofApplicability untouched
 * and that debug=true responses are returned unchanged.
 *
 * Run: node --experimental-strip-types scripts/test-token-public-sanitization.mjs
 */

import { sanitizePublicTokenResponse } from '../lib/server/publicTokenResponse.ts'
import { publicLpDataMode } from '../lib/server/lpProof.ts'

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

function buildVirtualLikePayload() {
  return {
    chain: 'base',
    contract: '0xVirtualLikeToken',
    riskScore: 62,
    riskLabel: 'elevated',
    riskBreakdown: {
      marketMaturity: { score: 18, max: 25, reasons: ['Verified market cap'] },
      liquiditySafety: { score: 10, max: 25, reasons: ['LP is wallet-controlled'] },
      contractSafety: { score: 20, max: 25, reasons: ['No mint detected'] },
      behavioralRisk: { score: 14, max: 25, reasons: ['Top10 concentration moderate'] },
    },
    // Legacy top-level CORTEX V2 fields — must be dropped from public output.
    cortexScore: 71,
    cortexVerdict: 'Watch',
    cortexConfidence: 'medium',
    scoreReasons: ['Liquidity verified', 'Mint not detected'],
    missingScoreInputs: ['holder_concentration'],
    scoreCoveragePercent: 80,
    cortexScoreDebug: { rawInputs: { liquidityUsd: 4_300_000 } },
    riskEngine: {
      rugRiskScore: 38,
      rugRiskLabel: 'watch',
      cortexScoreDebug: { rawInputs: { liquidityUsd: 4_300_000 } },
      confidence: 'medium',
      cortexScore: 71,
      cortexVerdict: 'Watch',
      cortexConfidence: 'medium',
      cortexRead: 'Score calculated from available evidence.',
      verifiedSignals: ['LP Control shows team_controlled.'],
      riskDrivers: ['LP Control indicates a dominant team wallet can control liquidity.'],
      openChecks: ['LP lock/burn not confirmed.'],
    },
    lpControl: {
      status: 'team_controlled',
      proofStatus: 'team_controlled',
      lockStatus: 'not_confirmed',
      burnStatus: 'not_confirmed',
    },
    lpExitRisk: 'watch',
    liquidityDepthRisk: 'low',
    lpMigrationProof: { status: 'low' },
    lpProofApplicability: 'applicable',
    lpProofStatus: 'partial',
    lpDataMode: 'evidence_based',
    lpDataModeRaw: 'fallback',
    lpMeta: {
      primaryMarketDex: 'Aerodrome',
      lpControlState: 'team_controlled',
    },
    sections: {
      liquidity: {
        lpLockBurnProofStatus: 'partial',
        lpMeta: {
          primaryMarketDex: 'Aerodrome',
          lpControlState: 'team_controlled',
        },
      },
    },
    priceChart: {
      timeframe: '24h',
      sourceStatus: 'ok',
      points: Array.from({ length: 400 }, (_, i) => ({
        timestamp: new Date(i * 60_000).toISOString(),
        open: 1, high: 1, low: 1, close: 1, volume: 1, priceUsd: 1,
      })),
    },
  }
}

function buildGoalLikePayload() {
  return {
    chain: 'base',
    contract: '0xGoalLikeToken',
    riskScore: 30,
    riskLabel: 'watch',
    riskBreakdown: {},
    lpProofApplicability: 'not_applicable',
    lpProofStatus: 'not_applicable',
    lpModelProof: { model: 'concentrated' },
    lpControl: { status: 'concentrated_liquidity', proofStatus: 'not_applicable' },
    lpMeta: { lpControlState: 'concentrated_liquidity' },
    sections: { liquidity: { lpLockBurnProofStatus: 'not_applicable', lpMeta: { lpControlState: 'concentrated_liquidity' } } },
    lpDataMode: 'indexed',
    lpDataModeRaw: 'insufficient',
    priceChart: { timeframe: '24h', sourceStatus: 'ok', points: [] },
  }
}

// ─── Scenario 1: VIRTUAL-like, normal public output ────────────────────────
console.log('\nScenario 1: VIRTUAL-like token, debug !== true')
{
  const result = sanitizePublicTokenResponse(buildVirtualLikePayload(), false)

  assert('keeps riskScore', result.riskScore === 62, result.riskScore)
  assert('keeps riskLabel', result.riskLabel === 'elevated', result.riskLabel)
  assert('keeps riskBreakdown', typeof result.riskBreakdown === 'object' && result.riskBreakdown != null)

  assert('drops top-level cortexScore', !('cortexScore' in result))
  assert('drops top-level cortexVerdict', !('cortexVerdict' in result))
  assert('drops top-level cortexConfidence', !('cortexConfidence' in result))
  assert('drops top-level scoreReasons', !('scoreReasons' in result))
  assert('drops top-level missingScoreInputs', !('missingScoreInputs' in result))
  assert('drops top-level scoreCoveragePercent', !('scoreCoveragePercent' in result))
  assert('drops top-level cortexScoreDebug', !('cortexScoreDebug' in result))

  assert('drops riskEngine.rugRiskScore', !('rugRiskScore' in result.riskEngine), result.riskEngine)
  assert('drops riskEngine.rugRiskLabel', !('rugRiskLabel' in result.riskEngine), result.riskEngine)
  assert('drops riskEngine.cortexScoreDebug', !('cortexScoreDebug' in result.riskEngine), result.riskEngine)
  assert('keeps riskEngine.cortexScore for CORTEX read', result.riskEngine.cortexScore === 71)

  assert('drops lpDataModeRaw', !('lpDataModeRaw' in result))
  assert('keeps normalized public lpDataMode', result.lpDataMode === 'evidence_based', result.lpDataMode)

  assert('caps priceChart.points', result.priceChart.points.length === 150, result.priceChart.points.length)

  // LP public status fields are internally consistent / non-conflicting.
  assert('lpMeta.lpControlState reflects LP control state', result.lpMeta.lpControlState === 'team_controlled')
  assert('sections.liquidity.lpLockBurnProofStatus is distinct from top-level lpProofStatus',
    result.sections.liquidity.lpLockBurnProofStatus === 'partial' && result.lpProofStatus === 'partial')
  assert('no field named bare "proofStatus" at lpMeta top level', !('proofStatus' in result.lpMeta))
  assert('no field named bare "proofStatus" at sections.liquidity.lpMeta', !('proofStatus' in result.sections.liquidity.lpMeta))
}

// ─── Scenario 2: debug=true leaves payload untouched ───────────────────────
console.log('\nScenario 2: VIRTUAL-like token, debug === true')
{
  const input = buildVirtualLikePayload()
  const result = sanitizePublicTokenResponse(input, true)

  assert('debug payload is returned as-is (same reference)', result === input)
  assert('debug keeps cortexScore', result.cortexScore === 71)
  assert('debug keeps riskEngine.rugRiskScore', result.riskEngine.rugRiskScore === 38)
  assert('debug keeps lpDataModeRaw', result.lpDataModeRaw === 'fallback')
  assert('debug keeps full priceChart.points', result.priceChart.points.length === 400)
}

// ─── Scenario 3: GOAL/concentrated pool — proofApplicability regression ───
console.log('\nScenario 3: GOAL/concentrated pool, debug !== true')
{
  const result = sanitizePublicTokenResponse(buildGoalLikePayload(), false)

  assert('proofApplicability remains not_applicable', result.lpProofApplicability === 'not_applicable')
  assert('lpProofStatus remains not_applicable', result.lpProofStatus === 'not_applicable')
  assert('lpModelProof.model remains concentrated', result.lpModelProof.model === 'concentrated')
  assert('sections.liquidity.lpLockBurnProofStatus remains not_applicable', result.sections.liquidity.lpLockBurnProofStatus === 'not_applicable')
  assert('lpMeta.lpControlState remains concentrated_liquidity', result.lpMeta.lpControlState === 'concentrated_liquidity')
}

// ─── Scenario 4: publicLpDataMode mapping ──────────────────────────────────
console.log('\nScenario 4: publicLpDataMode mapping')
{
  assert('strict -> resolved', publicLpDataMode('strict', true, true) === 'resolved')
  assert('strict -> resolved even without pool data', publicLpDataMode('strict', false, false) === 'resolved')
  assert('fallback + usable pool + ownership verified -> evidence_based',
    publicLpDataMode('fallback', true, true) === 'evidence_based')
  assert('fallback without ownership proof -> indexed (never "fallback")',
    publicLpDataMode('fallback', true, false) === 'indexed')
  assert('minimal -> indexed', publicLpDataMode('minimal', true, false) === 'indexed')
  assert('insufficient -> indexed', publicLpDataMode('insufficient', false, false) === 'indexed')
  assert('public mode is never the raw "fallback" string',
    !['strict', 'minimal', 'fallback', 'insufficient'].includes(publicLpDataMode('fallback', true, true)))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

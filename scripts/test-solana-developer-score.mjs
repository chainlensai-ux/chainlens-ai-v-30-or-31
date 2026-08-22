// TESTS — Solana Dev Intelligence Phase 3: Creator Confidence, Pattern Analysis, Developer Score.
// Pure unit tests, no network.

import assert from 'node:assert/strict'
import { analyzeSolanaCreatorConfidence } from '../lib/server/solana/creatorConfidenceAnalyzer.ts'
import { analyzeSolanaPatterns } from '../lib/server/solana/patternAnalyzer.ts'
import { buildSolanaDeveloperScore } from '../lib/server/solana/developerScoreAnalyzer.ts'
import { buildSolanaSupplyControl } from '../lib/server/solana/supplyControlAnalyzer.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

// ─── Creator Confidence tiers ────────────────────────────────────────────────────────────────
{
  check('not run => UNKNOWN', analyzeSolanaCreatorConfidence(null).tier === 'UNKNOWN')
  const notResolved = { called: true, success: false, enhancedTransactionsUsed: true, estimatedCredits: 1, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: null, earliestTimestamp: null, likelyCreatorWallet: null, transactionSource: null }, errorReason: 'no_signature_history_found' }
  check('ran but no wallet => UNKNOWN', analyzeSolanaCreatorConfidence(notResolved).tier === 'UNKNOWN')

  const confirmed = { called: true, success: true, enhancedTransactionsUsed: true, estimatedCredits: 2, pagesFetched: 1, reachedGenesis: true, resolved: { earliestSignature: 's1', earliestTimestamp: 't1', likelyCreatorWallet: 'W1', transactionSource: 'PUMP_FUN' }, errorReason: null }
  const cConf = analyzeSolanaCreatorConfidence(confirmed)
  check('genesis reached + recognized launch source => CONFIRMED', cConf.tier === 'CONFIRMED' && cConf.confidencePercent === 90)

  const likely = { ...confirmed, resolved: { ...confirmed.resolved, transactionSource: 'UNKNOWN_PROGRAM' } }
  check('genesis reached, unrecognized source => LIKELY', analyzeSolanaCreatorConfidence(likely).tier === 'LIKELY')

  const possible = { ...confirmed, reachedGenesis: false }
  check('genesis NOT reached => POSSIBLE', analyzeSolanaCreatorConfidence(possible).tier === 'POSSIBLE')
}

// ─── Pattern Analysis: real detections vs honest unavailable ───────────────────────────────────
{
  const sc = buildSolanaSupplyControl({ ok: true, tokenProgram: 'spl-token', decimals: 6, totalSupply: 1000, rawSupply: 1000, mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true, rawExtensions: null, evidenceGaps: [] })
  const patterns = analyzeSolanaPatterns({
    poolProgram: { resolved: true, poolAddress: 'P1', owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'PumpSwap AMM', errorReason: null, verdict: 'verified_official_pool', migratedFromPumpFun: true },
    supplyControl: sc,
    top1Percent: 25,
    helius: { called: true, success: true, resolved: { recentTransfers: 5 } },
  })
  const byKey = Object.fromEntries(patterns.patterns.map(p => [p.key, p]))
  check('pumpfun migration detected true with HIGH confidence from real pool-program identity', byKey.pumpfun_migration.detected === true && byKey.pumpfun_migration.confidence === 'HIGH')
  check('raydium launch correctly false (pool is PumpSwap, not Raydium)', byKey.raydium_launch.detected === false)
  check('liquidity additions/removals honestly unavailable, never guessed', byKey.liquidity_additions.detected === null && byKey.liquidity_removals.detected === null)
  check('mint activity false + HIGH confidence when mint authority is revoked (definitional)', byKey.mint_activity.detected === false && byKey.mint_activity.confidence === 'HIGH')
  check('wash trading / bot activity / coordinated buys all honestly unavailable', ['wash_trading', 'bot_activity', 'coordinated_buys'].every(k => byKey[k].detected === null))
  check('holder concentration at 25% flagged true with real percent cited', byKey.holder_concentration.detected === true && byKey.holder_concentration.evidence.includes('25.00%'))
}
{
  const patterns = analyzeSolanaPatterns({
    poolProgram: { resolved: false, poolAddress: null, owner: null, label: null, errorReason: null, verdict: 'unverified', migratedFromPumpFun: null },
    supplyControl: buildSolanaSupplyControl({ ok: true, tokenProgram: 'spl-token', decimals: 6, totalSupply: 1000, rawSupply: 1000, mintAuthority: 'Auth1', freezeAuthority: null, authorityReadSucceeded: true, rawExtensions: null, evidenceGaps: [] }),
    top1Percent: null,
    helius: { called: false, success: false, resolved: { recentTransfers: null } },
  })
  const byKey = Object.fromEntries(patterns.patterns.map(p => [p.key, p]))
  check('no pool => pumpfun/raydium honestly unavailable, never guessed false', byKey.pumpfun_migration.detected === null && byKey.raydium_launch.detected === null)
  check('active mint authority, no activity signal => mint activity unavailable, never guessed true', byKey.mint_activity.detected === null)
  check('no top1 data => holder concentration unavailable', byKey.holder_concentration.detected === null)
}

// ─── Developer Score: every component sums correctly and is explainable ────────────────────────
{
  const sc = buildSolanaSupplyControl({ ok: true, tokenProgram: 'spl-token', decimals: 6, totalSupply: 1000, rawSupply: 1000, mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true, rawExtensions: null, evidenceGaps: [] })
  const creatorConfidence = { tier: 'CONFIRMED', confidencePercent: 90, wallet: 'W1', reason: 'test reason' }
  const patterns = { patterns: [{ key: 'holder_concentration', label: 'Holder concentration', detected: false, confidence: 'MEDIUM', evidence: 'low concentration' }] }
  const score = buildSolanaDeveloperScore({ creatorConfidence, supplyControl: sc, authorityReadSucceeded: true, freezeAuthority: null, clusterMap: null, patterns })
  check('score sums components exactly', score.score === score.components.reduce((s, c) => s + c.points, 0))
  check('maxScore is 100', score.maxScore === 100)
  check('every component has a non-empty, evidence-cited reason', score.components.every(c => typeof c.reason === 'string' && c.reason.length > 0))
  check('mint+freeze both revoked => full 30 authority points', score.components.find(c => c.label === 'Authority Safety').points === 30)
  check('supply permanently fixed => full 15 supply points', score.components.find(c => c.label === 'Supply Safety').points === 15)
  check('cluster not attempted => 0 points with an explicit reason, never guessed', score.components.find(c => c.label === 'Cluster / Funding Confidence').points === 0)
  check('no risky pattern detected => full 10 pattern points', score.components.find(c => c.label === 'Pattern Safety').points === 10)
  // scaledMaxScore excludes the never-run Cluster/Funding component (15 pts) from the denominator,
  // so a scan that never opted into Deep Cluster Check isn't silently capped below every other
  // scan's ceiling — see docs/token-scanner-audit-solana-2026-08-22.md finding #3.
  check('cluster skipped => marked skipped on its component', score.components.find(c => c.label === 'Cluster / Funding Confidence').skipped === true)
  check('scaledMaxScore excludes the skipped 15-pt cluster component (85, not 100)', score.scaledMaxScore === 85)
  check('score never exceeds scaledMaxScore', score.score <= score.scaledMaxScore)
}
{
  // When Deep Cluster Check DID run and found evidence, its points count normally and nothing is
  // excluded from the denominator.
  const sc = buildSolanaSupplyControl({ ok: true, tokenProgram: 'spl-token', decimals: 6, totalSupply: 1000, rawSupply: 1000, mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true, rawExtensions: null, evidenceGaps: [] })
  const clusterMap = { attempted: true, evidenceCount: 2, clusterConfidence: 'medium', riskLevel: 'standard', summary: 'test summary', riskReason: 'test risk reason' }
  const score = buildSolanaDeveloperScore({ creatorConfidence: { tier: 'CONFIRMED', confidencePercent: 90, wallet: 'W1', reason: 'test' }, supplyControl: sc, authorityReadSucceeded: true, freezeAuthority: null, clusterMap, patterns: { patterns: [] } })
  check('cluster attempted with evidence => not skipped', score.components.find(c => c.label === 'Cluster / Funding Confidence').skipped !== true)
  check('scaledMaxScore equals full maxScore (100) when cluster actually ran', score.scaledMaxScore === score.maxScore && score.maxScore === 100)
}
{
  // HIGH cluster confidence (the intelligence-graph engine's new top tier) must earn MORE than
  // medium, never fall through to 0 — the exact bug a naive ternary would have introduced.
  const sc = buildSolanaSupplyControl({ ok: true, tokenProgram: 'spl-token', decimals: 6, totalSupply: 1000, rawSupply: 1000, mintAuthority: null, freezeAuthority: null, authorityReadSucceeded: true, rawExtensions: null, evidenceGaps: [] })
  const mk = (clusterConfidence) => buildSolanaDeveloperScore({
    creatorConfidence: { tier: 'CONFIRMED', confidencePercent: 90, wallet: 'W1', reason: 'test' },
    supplyControl: sc, authorityReadSucceeded: true, freezeAuthority: null,
    clusterMap: { attempted: true, evidenceCount: 9, clusterConfidence, riskLevel: 'standard', summary: 's', riskReason: 'r' },
    patterns: { patterns: [] },
  })
  const high = mk('high').components.find(c => c.label === 'Cluster / Funding Confidence')
  const medium = mk('medium').components.find(c => c.label === 'Cluster / Funding Confidence')
  check('high cluster confidence earns more than medium, never 0', high.points > medium.points && high.points > 0)
  check('cluster component never exceeds its own maxPoints', high.points <= high.maxPoints)
}
{
  // Authority-unresolved and mint-active cases never silently score high.
  const scActive = buildSolanaSupplyControl({ ok: true, tokenProgram: 'spl-token', decimals: 6, totalSupply: 1000, rawSupply: 1000, mintAuthority: 'Auth1', freezeAuthority: 'Freeze1', authorityReadSucceeded: true, rawExtensions: null, evidenceGaps: [] })
  const score = buildSolanaDeveloperScore({ creatorConfidence: { tier: 'UNKNOWN', confidencePercent: 0, wallet: null, reason: 'not run' }, supplyControl: scActive, authorityReadSucceeded: true, freezeAuthority: 'Freeze1', clusterMap: null, patterns: { patterns: [] } })
  check('active mint+freeze authority => 0 authority points', score.components.find(c => c.label === 'Authority Safety').points === 0)
  check('unresolved creator => 0 creator points', score.components.find(c => c.label === 'Creator Confidence').points === 0)
  check('mutable supply => 0 supply points', score.components.find(c => c.label === 'Supply Safety').points === 0)
}

console.log(`test-solana-developer-score.mjs: all ${passed} assertions passed`)

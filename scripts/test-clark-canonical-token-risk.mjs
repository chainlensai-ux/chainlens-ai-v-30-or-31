import assert from 'node:assert/strict'
import fs from 'node:fs'
import { canonicalTokenRiskFromEvidence, renderClarkTokenVerdictForEvm, renderClarkTokenVerdictForSolana } from '../lib/server/clarkRouting.ts'
import { buildClarkTokenAnalystSnapshot } from '../lib/server/clarkTokenAnalyst.ts'
import { TOKEN_SCANNER_RISK_SCORE_SOURCE } from '../lib/tokenScannerPipelineAudit.ts'

// Clark/CORTEX audit Item 10: Clark consumes Token Scanner riskScore/riskLabel/
// riskScoreSource/riskInputsUsed. It must not independently re-score or re-threshold
// a scanner label into a different one.

const routingSrc = fs.readFileSync(new URL('../lib/server/clarkRouting.ts', import.meta.url), 'utf8')
const analystSrc = fs.readFileSync(new URL('../lib/server/clarkTokenAnalyst.ts', import.meta.url), 'utf8')
const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')

assert.doesNotMatch(routingSrc, /calculateTokenRiskScore\(/, 'Clark routing must not compute Token Scanner risk itself')
assert.doesNotMatch(analystSrc, /calculateTokenRiskScore\(/, 'Clark token analyst must not compute Token Scanner risk itself')
assert.match(routingSrc, /export function canonicalTokenRiskFromEvidence/, 'Clark must expose a consume-only canonical risk helper')
assert.match(analystSrc, /canonicalTokenRiskFromEvidence\(ev\)/, 'token analyst snapshot consumes canonical scanner risk')
assert.doesNotMatch(analystSrc, /normalizeRiskScore\(/, 'token analyst must not re-normalize scanner risk')
assert.match(routeSrc, /riskScoreSource: typeof t\.riskScoreSource === "string" \? t\.riskScoreSource : null/, 'Clark evidence mapper copies scanner riskScoreSource')
assert.match(routeSrc, /riskInputsUsed: Array\.isArray\(t\.riskInputsUsed\)/, 'Clark evidence mapper copies scanner riskInputsUsed')
assert.match(routeSrc, /riskScore: solRiskScore/, 'Solana Clark path consumes scanner riskScore')
assert.match(routeSrc, /riskScoreSource: solRiskScoreSource/, 'Solana Clark path consumes scanner riskScoreSource')

{
  const consumed = canonicalTokenRiskFromEvidence({
    riskScore: 58,
    riskLabel: 'High Risk',
    riskScoreType: 'risk_score',
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    riskInputsUsed: ['marketMaturity', 'liquiditySafety', 'contractSafety'],
  })
  assert.ok(consumed)
  assert.equal(consumed.score, 58)
  assert.equal(consumed.label, 'High Risk', 'scanner label wins even when numeric thresholds would map 58 to Caution')
  assert.equal(consumed.source, TOKEN_SCANNER_RISK_SCORE_SOURCE)
  assert.deepEqual(consumed.inputsUsed, ['marketMaturity', 'liquiditySafety', 'contractSafety'])
}

{
  const consumed = canonicalTokenRiskFromEvidence({
    riskScore: 75,
    riskLabel: 'High Risk',
    riskScoreType: 'risk_score',
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    riskInputsUsed: ['contractSafety'],
  })
  const answer = renderClarkTokenVerdictForEvm({
    ok: true,
    token: { name: 'Test', symbol: 'TEST', address: '0x0000000000000000000000000000000000000001' },
    riskScore: 75,
    riskLabel: 'High Risk',
    riskScoreType: 'risk_score',
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    riskInputsUsed: ['contractSafety'],
    market: { liquidity: 100_000 },
  }, '0x0000000000000000000000000000000000000001', 'Base', true)
  assert.match(answer, /Risk Score: 75\/100 — High Risk \(higher = riskier\)/)
  assert.match(answer, new RegExp(`Risk score source: ${TOKEN_SCANNER_RISK_SCORE_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(answer, /Risk inputs used: contractSafety/)
  assert.equal(consumed.label, 'High Risk')
}

{
  const mismatched = renderClarkTokenVerdictForEvm({
    ok: true,
    token: { name: 'Test', symbol: 'TEST', address: '0x0000000000000000000000000000000000000001' },
    riskScore: 58,
    riskLabel: 'High Risk',
    riskScoreType: 'risk_score',
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    riskInputsUsed: ['behavioralRisk'],
    market: { liquidity: 100_000 },
  }, '0x0000000000000000000000000000000000000001', 'Base', true)
  assert.match(mismatched, /Risk Score: 58\/100 — High Risk \(higher = riskier\)/, 'Clark must not re-threshold 58 into Caution')
  assert.doesNotMatch(mismatched, /Risk Score: 58\/100 — Caution/)
}

{
  const snap = buildClarkTokenAnalystSnapshot({
    ok: true,
    token: { name: 'Test', symbol: 'TEST', address: '0x0000000000000000000000000000000000000001' },
    riskScore: 58,
    riskLabel: 'High Risk',
    riskScoreType: 'risk_score',
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    riskInputsUsed: ['liquiditySafety'],
  }, 'Base')
  assert.equal(snap.riskScore, 58)
  assert.equal(snap.riskLabel, 'High Risk')
  assert.equal(snap.riskScoreSource, TOKEN_SCANNER_RISK_SCORE_SOURCE)
  assert.deepEqual(snap.riskInputsUsed, ['liquiditySafety'])
}

{
  const legacy = canonicalTokenRiskFromEvidence({
    riskScore: 80,
    riskLabel: null,
    riskScoreType: 'safety_score',
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    riskInputsUsed: [],
  })
  assert.ok(legacy)
  assert.equal(legacy.score, 20, 'legacy safety_score is inverted once, not re-scored from evidence')
  assert.equal(legacy.label, 'Low Risk')
}

{
  const solana = renderClarkTokenVerdictForSolana({
    tokenAddress: 'SoLTokenMintAddress11111111111111111111111',
    tokenName: 'Test Token', tokenSymbol: 'TEST',
    mintAuthority: null, mintAuthorityResolved: true,
    freezeAuthority: null, freezeAuthorityResolved: true,
    marketCap: 500_000, fdv: 600_000, liquidityUsd: 90_000, volume24h: 40_000,
    primaryDexLabel: 'Raydium', primaryPoolAddress: 'PoolAddr1111111111111111111111111111111111',
    top1Pct: 5, top10Pct: 20, accountsSampled: 500,
    likelyCreator: 'CreatorAddr111111111111111111111111111111', creatorConfidenceTier: 'high',
    deployerRugHistoryCount: 0,
    usableEvidence: true,
    riskScore: 41,
    riskLabel: 'Caution',
    riskScoreType: 'risk_score',
    riskScoreSource: TOKEN_SCANNER_RISK_SCORE_SOURCE,
    riskInputsUsed: ['marketMaturity'],
  })
  assert.match(solana, /Risk Score: 41\/100 — Caution \(higher = riskier\)/)
  assert.match(solana, /Risk score source: lib\/server\/riskScore\.calculateTokenRiskScore/)
}

assert.equal(canonicalTokenRiskFromEvidence({ riskScore: null, riskLabel: 'High Risk' }), null, 'no invented score when scanner did not return one')

console.log('test-clark-canonical-token-risk.mjs: all assertions passed')

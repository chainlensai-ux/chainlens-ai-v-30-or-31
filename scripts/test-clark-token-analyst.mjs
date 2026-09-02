import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkTokenAnalystTopic,
  renderClarkTokenAnalystAnswer,
  renderClarkTokenAnalystFromEvidence,
  buildClarkTokenAnalystSnapshot,
  clarkTokenAnalystContainsFinancialAdvice,
  tokenScanEvidenceFromSolanaScan,
} from '../lib/server/clarkTokenAnalyst.ts'
import { classifyClarkPrompt, isTokenFollowupPrompt } from '../lib/server/clarkRouting.ts'

const ADDR = '0x1234567890123456789012345678901234567890'
const SOL = 'So11111111111111111111111111111111111111112'

function evmEv(overrides = {}) {
  return {
    ok: true,
    token: { name: 'Test Token', symbol: 'TEST', address: ADDR },
    chain: 'base',
    riskScore: 58,
    riskLabel: 'Caution',
    riskScoreType: 'risk_score',
    market: { price: 0.01, change24h: 12, volume24h: 90_000, liquidity: 80_000, marketCap: 1_000_000, fdv: 1_200_000 },
    holders: { top1: 18, top10: 44, holderCount: 900, status: 'ok' },
    security: { honeypot: false, buyTax: 1, sellTax: 2, ownerRenounced: null, mintable: false, proxy: false, blacklist: false },
    lpControl: { status: 'unverified', poolType: 'v3', proofApplicability: 'not_applicable', displayLpModel: 'concentrated_liquidity', positionProofStatus: 'open_check' },
    deployerAddress: null,
    deployerProfile: {},
    tradingSimulation: { sellable: true, status: 'sellable', buyTax: 1, sellTax: 2, reason: null },
    ...overrides,
  }
}

function hasSections(text) {
  assert.match(text, /^Verdict:/m)
  assert.match(text, /^Key reasons:/m)
  assert.match(text, /^Verified evidence:/m)
  assert.match(text, /^Missing \/ unsupported checks:/m)
  assert.match(text, /^Next action:/m)
}

assert.equal(classifyClarkTokenAnalystTopic('Is this safe?'), 'safe')
assert.equal(classifyClarkTokenAnalystTopic('Is this token safe to ape?'), 'safe')
assert.equal(classifyClarkTokenAnalystTopic('Why risk 58?'), 'risk')
assert.equal(classifyClarkTokenAnalystTopic('Is LP safe?'), 'lp')
assert.equal(classifyClarkTokenAnalystTopic('Who controls supply?'), 'supply')
assert.equal(classifyClarkTokenAnalystTopic('Is holder concentration bad?'), 'holders')
assert.equal(classifyClarkTokenAnalystTopic('Has the dev rugged before?'), 'dev')
assert.equal(classifyClarkTokenAnalystTopic('Can I sell this token?'), 'sell')
assert.equal(classifyClarkTokenAnalystTopic('What are the taxes?'), 'taxes')
assert.equal(classifyClarkTokenAnalystTopic('Why is this pumping?'), 'pumping')
assert.equal(classifyClarkTokenAnalystTopic('What are the biggest red flags?'), 'red_flags')
assert.equal(classifyClarkTokenAnalystTopic('What are the good signs?'), 'good_signs')
assert.equal(classifyClarkTokenAnalystTopic('What should I check next?'), 'next')
assert.equal(classifyClarkTokenAnalystTopic('Explain LP in simple words'), 'explain_lp')
assert.equal(classifyClarkTokenAnalystTopic('Explain holders'), 'explain_holders')
assert.equal(classifyClarkTokenAnalystTopic('Explain risk'), 'explain_risk')
assert.equal(classifyClarkTokenAnalystTopic('Explain market'), 'explain_market')
assert.equal(classifyClarkTokenAnalystTopic('Explain dev'), 'explain_dev')

assert.equal(isTokenFollowupPrompt('Can I sell this token?'), true)
assert.equal(isTokenFollowupPrompt('What are the taxes?'), true)
assert.equal(isTokenFollowupPrompt('What are the good signs?'), true)
assert.equal(classifyClarkPrompt(`Can I sell this token? ${ADDR}`).intent, 'token_ape_risk')
assert.equal(classifyClarkPrompt(`What are the taxes? ${ADDR}`).intent, 'token_ape_risk')

{
  const ev = evmEv()
  const snap = buildClarkTokenAnalystSnapshot(ev, 'Base')
  assert.equal(snap.riskScore, 58)
  assert.equal(snap.riskLabel, 'Caution')
  assert.equal(snap.holdersVerified, true)
  assert.equal(snap.lpConcentrated, true)
  assert.equal(snap.family, 'evm')

  const safe = renderClarkTokenAnalystFromEvidence(ev, 'Is this safe?', 'Base')
  hasSections(safe)
  assert.match(safe, /Verdict: Caution/)
  assert.match(safe, /Holder concentration is verified/)
  assert.match(safe, /liquidity exists/i)
  assert.match(safe, /Position owner proof unavailable — active liquidity positions not indexed\./)
  assert.match(safe, /dev origin is unresolved/)
  assert.match(safe, /not financial advice/i)
  assert.equal(clarkTokenAnalystContainsFinancialAdvice(safe), false)
  assert.doesNotMatch(safe, /this token is safe/i)
  assert.doesNotMatch(safe, /you should (?:buy|ape)/i)

  const risk = renderClarkTokenAnalystFromEvidence(ev, 'Why risk 58?', 'Base')
  hasSections(risk)
  assert.match(risk, /58\/100 = Caution/)
  assert.match(risk, /Main drivers:/)
  assert.match(risk, /Good signs:/)

  const lp = renderClarkTokenAnalystFromEvidence(ev, 'Is LP safe?', 'Base')
  hasSections(lp)
  assert.match(lp, /Standard ERC-20 LP lock\/burn is not applicable/)
  assert.match(lp, /V3\/V4/)

  const holders = renderClarkTokenAnalystFromEvidence(ev, 'Is holder concentration bad?', 'Base')
  hasSections(holders)
  assert.match(holders, /top-10 44\.0%/)

  const supply = renderClarkTokenAnalystFromEvidence(ev, 'Who controls supply?', 'Base')
  hasSections(supply)

  const dev = renderClarkTokenAnalystFromEvidence(ev, 'Has the dev rugged before?', 'Base')
  hasSections(dev)
  assert.match(dev, /prior rug history is not confirmed/)
  assert.doesNotMatch(dev, /confirmed prior rug/)

  const sell = renderClarkTokenAnalystFromEvidence(ev, 'Can I sell this token?', 'Base')
  hasSections(sell)
  assert.match(sell, /Trading simulation: Sellable/)
  assert.match(sell, /Buy tax: 1\.0%/)
  assert.match(sell, /Sell tax: 2\.0%/)
  assert.match(sell, /not full token safety/)

  const taxes = renderClarkTokenAnalystFromEvidence(ev, 'What are the taxes?', 'Base')
  hasSections(taxes)
  assert.match(taxes, /Buy tax: 1\.0%/)
  assert.match(taxes, /Sell tax: 2\.0%/)

  const pump = renderClarkTokenAnalystFromEvidence(ev, 'Why is this pumping?', 'Base')
  hasSections(pump)
  assert.match(pump, /not a safety signal/)

  const flags = renderClarkTokenAnalystFromEvidence(ev, 'What are the biggest red flags?', 'Base')
  hasSections(flags)
  assert.match(flags, /Missing \/ unsupported checks:/)

  const goods = renderClarkTokenAnalystFromEvidence(ev, 'What are the good signs?', 'Base')
  hasSections(goods)
  assert.match(goods, /Liquidity is present/)

  const next = renderClarkTokenAnalystFromEvidence(ev, 'What should I check next?', 'Base')
  hasSections(next)

  for (const q of ['Explain LP', 'Explain holders', 'Explain dev', 'Explain risk', 'Explain market']) {
    const out = renderClarkTokenAnalystFromEvidence(ev, q, 'Base')
    hasSections(out)
  }
}

{
  const rh = evmEv({
    chain: 'robinhood',
    tradingSimulation: { sellable: null, status: 'unsupported', buyTax: null, sellTax: null, reason: 'No configured honeypot provider supports chainId 4663.' },
    security: { honeypot: null, buyTax: null, sellTax: null, ownerRenounced: false, mintable: false, proxy: false },
  })
  const sell = renderClarkTokenAnalystAnswer(rh, 'sell', 'Robinhood')
  hasSections(sell)
  assert.match(sell, /Unsupported/)
  assert.match(sell, /unsupported or unavailable/i)
  const snap = buildClarkTokenAnalystSnapshot(rh, 'Robinhood')
  assert.equal(snap.family, 'robinhood')
}

{
  const v2 = evmEv({
    lpControl: { status: 'locked', poolType: 'v2', proofApplicability: 'applicable', displayLpModel: 'locked', lockStatus: 'locked', proofStatus: 'confirmed' },
    holders: { top1: 4, top10: 18, holderCount: 2000 },
    riskScore: 12,
    riskLabel: 'Low Risk',
  })
  const safe = renderClarkTokenAnalystAnswer(v2, 'safe', 'Ethereum')
  hasSections(safe)
  assert.doesNotMatch(safe, /^Verdict: (?:Safe|this is safe)/im)
  assert.match(safe, /not treat this as fully verified/)
}

{
  const sol = tokenScanEvidenceFromSolanaScan({
    tokenAddress: SOL,
    tokenName: 'Bonk',
    tokenSymbol: 'BONK',
    mintAuthority: null,
    mintAuthorityResolved: true,
    freezeAuthority: null,
    freezeAuthorityResolved: true,
    liquidityUsd: 90_000,
    volume24h: 40_000,
    top1Pct: 5,
    top10Pct: 20,
    accountsSampled: 500,
    likelyCreator: 'Creator111',
    rugHistoryCount: 0,
    usable: true,
  })
  const safe = renderClarkTokenAnalystAnswer(sol, 'safe', 'Solana')
  hasSections(safe)
  assert.doesNotMatch(safe, /owner renounced/i)
  assert.doesNotMatch(safe, /proxy contract/i)
  assert.match(safe, /not applicable on Solana/i)
  assert.match(safe, /Mint authority is revoked/)
  const sell = renderClarkTokenAnalystAnswer(sol, 'sell', 'Solana')
  assert.match(sell, /Not applicable/)
  const supply = renderClarkTokenAnalystAnswer(sol, 'supply', 'Solana')
  assert.match(supply, /Mint authority is revoked/)
  const lp = renderClarkTokenAnalystAnswer(sol, 'lp', 'Solana')
  assert.match(lp, /not an ERC-20 LP lock/)
}

{
  const bnb = evmEv({ chain: 'bnb', riskScore: 72, riskLabel: 'High Risk', security: { honeypot: true, buyTax: 0, sellTax: 99 } })
  const safe = renderClarkTokenAnalystAnswer(bnb, 'safe', 'BNB')
  assert.match(safe, /Verdict: Avoid/)
  const sell = renderClarkTokenAnalystAnswer(bnb, 'sell', 'BNB')
  assert.match(sell, /Blocked/)
}

{
  // concentratedLpPositionOwnershipAudit wired through: a real verified position owner must
  // read as verified, not the old vague "not verified" text.
  const verifiedOwner = evmEv({
    lpControl: {
      status: 'unverified', poolType: 'v3', proofApplicability: 'not_applicable', displayLpModel: 'concentrated_liquidity',
      positionProofStatus: 'verified',
      positionOwnershipFinalStatus: 'verified_position_owner',
      positionOwnershipFinalReason: 'Position ownership resolved from 3 position record(s); top owner controls 62% of resolved concentrated liquidity.',
    },
  })
  const lp = renderClarkTokenAnalystAnswer(verifiedOwner, 'lp', 'Base')
  assert.match(lp, /Position ownership resolved from 3 position record\(s\)/)
  assert.doesNotMatch(lp, /LP position ownership is not verified/)

  // No indexed positions: exact required reason, never the old bare "not verified" phrasing.
  const noIndex = evmEv({
    lpControl: {
      status: 'unverified', poolType: 'v3', proofApplicability: 'not_applicable', displayLpModel: 'concentrated_liquidity',
      positionProofStatus: 'not_supported',
      positionOwnershipFinalStatus: 'owner_unavailable',
      positionOwnershipFinalReason: 'Position owner proof unavailable — active liquidity positions not indexed.',
    },
  })
  const lp2 = renderClarkTokenAnalystAnswer(noIndex, 'lp', 'Base')
  assert.match(lp2, /Position owner proof unavailable — active liquidity positions not indexed\./)
  assert.doesNotMatch(lp2, /LP position ownership is not verified/)
}

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
assert.match(routeSrc, /renderClarkTokenAnalystFromEvidence/)
assert.match(routeSrc, /classifyClarkTokenAnalystTopic/)
assert.match(routeSrc, /tokenScanEvidenceFromSolanaScan/)
assert.match(routeSrc, /tradingSimulation:/)
assert.match(routeSrc, /else if \(followupKind === "risk"\) \{ analysis = formatRiskExplanation\(ev, followupChainLabel\); intentBadge = "risk_explanation"; \}/)

console.log('test-clark-token-analyst.mjs: all assertions passed')

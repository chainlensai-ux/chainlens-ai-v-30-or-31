import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyClarkPrompt,
  isTokenSafetyPrompt,
  isDevRugHistoryPrompt,
  classifyTokenOrWalletAddress,
  formatTokenApeRiskRead,
  formatDevHistoryRead,
  deriveDevHistoryFromTokenEvidence,
  classifyAppContextFollowup,
} from '../lib/server/clarkRouting.ts'

const routeSrc = fs.readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
const PROVIDER_RE = /goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i

const tokenAddr = '0x' + '1'.repeat(40)
const walletAddr = '0x' + '2'.repeat(40)

// 1. "Is this token safe to ape right now?" with a token address routes to the token-risk read.
{
  const r = classifyClarkPrompt(`Is this token safe to ape right now? ${tokenAddr}`)
  assert.equal(r.intent, 'token_ape_risk')
  assert.equal(r.address, tokenAddr)
}

// 2. "Is this CA safe?" routes to token safety.
{
  assert.ok(isTokenSafetyPrompt(`Is this CA safe? ${tokenAddr}`))
  const r = classifyClarkPrompt(`Is this CA safe? ${tokenAddr}`)
  assert.equal(r.intent, 'token_ape_risk')
}

// 3. "Should I buy this token?" is recognized as a safety prompt — no financial-advice wording
//    is baked into the risk-read formatter, and the bottom line is always the cautious disclaimer.
{
  assert.ok(isTokenSafetyPrompt('Should I buy this token?'))
  const out = formatTokenApeRiskRead(null)
  assert.ok(/I can't guarantee safety/.test(out))
  assert.ok(/risk read, not financial advice/.test(out))
  assert.ok(!/\bguaranteed?\s+safe\b/i.test(out))
}

// 4. Current tokenSummary + "is this safe?" / "full risk breakdown" resolves from appContext
//    (token_risks) without requiring the user to paste the address again.
{
  assert.equal(classifyAppContextFollowup('is this safe to ape?'), 'token_risks')
  assert.equal(classifyAppContextFollowup('give me a full risk breakdown'), 'token_risks')
}

// 5. "Has this dev ever rugged before?" with a token CA routes through dev/token intelligence.
{
  assert.ok(isDevRugHistoryPrompt(`Has this dev ever rugged before? ${tokenAddr}`))
  const r = classifyClarkPrompt(`Has this dev ever rugged before? ${tokenAddr}`)
  assert.equal(r.intent, 'dev_rug_history')
  assert.equal(r.address, tokenAddr)
  assert.equal(classifyTokenOrWalletAddress(`Has this dev ever rugged before? ${tokenAddr}`), 'none')
}

// 6. A wallet/dev address + dev-rug-history prompt is recognized as a wallet address (routes to
//    the existing dev-wallet pipeline in route.ts, never fabricated locally).
{
  const prompt = `Check this wallet history ${walletAddr}`
  assert.ok(isDevRugHistoryPrompt(prompt))
  assert.equal(classifyTokenOrWalletAddress(prompt), 'wallet')
  assert.ok(routeSrc.includes('clarkDevHistoryResolvedFrom: "wallet_input"'), 'wallet dev-history prompts are handled explicitly and gracefully when wallet history is unavailable')
}

// 7. No address/context → a short ask for a CA or dev wallet, not a generic failure.
{
  assert.ok(routeSrc.includes('Paste a token contract address (CA) or a dev/deployer wallet address'))
}

// 8. Missing evidence returns Open Check, never a fabricated clean or rugged verdict.
{
  const out = formatTokenApeRiskRead(null)
  const lines = out.split('\n')
  assert.equal(lines[0], 'CORTEX TOKEN RISK READ')
  assert.equal(lines[2], 'Verdict:')
  assert.equal(lines[3], '- Open Check')
  assert.equal(lines[4], '- Ape risk: Unknown')

  const derivedEmpty = deriveDevHistoryFromTokenEvidence(null)
  assert.equal(derivedEmpty.status, 'open_check')
  const historyOut = formatDevHistoryRead({ status: derivedEmpty.status, gaps: derivedEmpty.evidenceGaps })
  assert.ok(/No confirmed rug evidence|Open Check/.test(historyOut))
  assert.ok(!/Confirmed prior rug evidence found/i.test(historyOut))
}

// 9. Dev-history read never upgrades token-local contract-control signals into cross-token
//    deployer history. It remains Open Check unless cross-token/wallet evidence exists.
{
  const riskyEv = { token: { symbol: 'X' }, security: { ownerRenounced: false, mintable: true }, lpControl: null, ok: true }
  const derived = deriveDevHistoryFromTokenEvidence(riskyEv)
  assert.equal(derived.status, 'open_check')
  const out = formatDevHistoryRead({ status: derived.status, tokenLocalRiskSignals: derived.tokenLocalRiskSignals, gaps: derived.evidenceGaps })
  assert.ok(/This token has risk signals, but I cannot confirm this dev has rugged before/.test(out))
  assert.ok(!/confirmed rug history/i.test(out))
}

// 10. No provider names in the new public-facing risk-read output.
{
  assert.ok(!PROVIDER_RE.test(formatTokenApeRiskRead(null)))
  assert.ok(!PROVIDER_RE.test(formatDevHistoryRead({ status: 'open_check' })))
}

// Output format: exact CORTEX header + section structure for the token risk read.
{
  const out = formatTokenApeRiskRead(null)
  const lines = out.split('\n')
  assert.equal(lines[0], 'CORTEX TOKEN RISK READ')
  assert.ok(lines.includes('Verdict:'))
  assert.ok(lines.includes('Risk sections:'))
  assert.ok(lines.includes('Evidence gaps:'))
  assert.ok(lines.includes('Ape checklist:'))
  assert.ok(lines.includes('Bottom line:'))
  assert.ok(lines.some((l) => l.startsWith('- Ape risk:')))
  assert.ok(lines.some((l) => l.startsWith('- Confidence:')))
}

// All 6 numbered risk sections are present (Open Check / no evidence case).
{
  const out = formatTokenApeRiskRead(null)
  assert.ok(out.includes('1. Liquidity / LP'))
  assert.ok(out.includes('2. Ownership / Contract Control'))
  assert.ok(out.includes('3. Holder Concentration'))
  assert.ok(out.includes('4. Dev / Deployer'))
  assert.ok(out.includes('5. Security / Honeypot'))
  assert.ok(out.includes('6. Market Quality'))
  // Missing evidence -> every section reads as Open Check, never a fabricated verdict.
  const sectionLines = out.split('\n').filter((l) => l.trim().startsWith('- Status:'))
  assert.equal(sectionLines.length, 6)
  for (const l of sectionLines) assert.ok(l.includes('Open Check'))
}

// All 6 risk sections are present with real evidence too, each with a Status + Why it matters line.
{
  const ev = {
    token: { symbol: 'X' },
    security: { ownerRenounced: false, mintable: true, honeypot: false, buyTax: 1, sellTax: 1 },
    lpControl: { status: 'wallet_controlled', reason: 'dev wallet holds LP' },
    holders: { top1: 30, top10: 55 },
    market: { liquidity: 5000, volume24h: 1000 },
    ok: true,
  }
  const out = formatTokenApeRiskRead(ev)
  for (const title of ['Liquidity / LP', 'Ownership / Contract Control', 'Holder Concentration', 'Dev / Deployer', 'Security / Honeypot', 'Market Quality']) {
    assert.ok(out.includes(title), `missing section: ${title}`)
  }
  const statusLines = out.split('\n').filter((l) => l.trim().startsWith('- Status:'))
  const whyLines = out.split('\n').filter((l) => l.trim().startsWith('- Why it matters:'))
  assert.equal(statusLines.length, 6)
  assert.equal(whyLines.length, 6)

  // Bad LP/team control + non-renounced owner + concentrated holders -> Caution/Avoid verdict,
  // and the bottom line must not sound bullish.
  assert.ok(/^- (Caution|Avoid)$/m.test(out))
  const bottomLine = out.split('Bottom line:\n')[1]
  assert.ok(!/\b(strong buy|moon|guaranteed|safe to ape|bullish)\b/i.test(bottomLine))
  assert.ok(/I can't guarantee safety\. This is a risk read, not financial advice\./.test(bottomLine))
  assert.ok(!/\bsafe to ape\b/i.test(out))
}

// Dev-history output format.
{
  const out = formatDevHistoryRead({ status: 'open_check' })
  const lines = out.split('\n')
  assert.equal(lines[0], 'CORTEX DEV HISTORY READ')
  assert.ok(lines.includes('Status:'))
  assert.ok(lines.includes('Target:'))
  assert.ok(lines.includes('Deployer / dev identity:'))
  assert.ok(lines.includes('Token-local risk signals:'))
  assert.ok(lines.includes('Cross-token / wallet-history evidence:'))
  assert.ok(lines.includes('Evidence gaps:'))
  assert.ok(lines.includes('Bottom line:'))
}

// Debug fields are wired through route.ts for the new CORTEX risk-read branches.
{
  assert.ok(routeSrc.includes('clarkRiskIntent: "token_ape_risk"'))
  assert.ok(routeSrc.includes('clarkRiskIntent: "dev_rug_history"'))
  assert.ok(routeSrc.includes('clarkAddressType:'))
  assert.ok(routeSrc.includes('clarkSafetyResolvedFrom:'))
  assert.ok(routeSrc.includes('clarkDevHistoryResolvedFrom:'))
  assert.ok(routeSrc.includes('clarkEvidenceGaps:'))
  assert.ok(routeSrc.includes('clarkRiskReportFormat: "cortex_token_risk_read"'))
  assert.ok(routeSrc.includes('clarkRiskReportFormat: "cortex_dev_history_read"'))
  assert.ok(routeSrc.includes('clarkDevHistoryEvidenceLevel'))
  assert.ok(routeSrc.includes('clarkDevHistoryApiPathsUsed'))
  assert.ok(routeSrc.includes('clarkRiskSectionsIncluded'))
  assert.ok(routeSrc.includes('clarkRiskConfidence'))
}

// Actions: token-risk reads include a Token Scanner link plus prompt-based follow-up actions;
// dev-history reads include the reciprocal prompt actions.
{
  assert.ok(routeSrc.includes('function buildTokenRiskActions'))
  assert.ok(routeSrc.includes('function buildDevHistoryActions'))
  assert.ok(routeSrc.includes('Check Dev History'))
  assert.ok(routeSrc.includes('Explain LP Risk'))
  assert.ok(routeSrc.includes('Check Token Risk'))
  assert.ok(routeSrc.includes('Explain Dev Control'))
}

console.log('clark risk-intent (token safety / dev rug history) checks passed')

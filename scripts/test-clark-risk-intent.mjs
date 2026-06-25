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
  assert.ok(routeSrc.includes('clarkDevHistoryResolvedFrom: "dev_wallet_route"'), 'wallet dev-history prompts route through the existing dev-wallet pipeline')
}

// 7. No address/context → a short ask for a CA or dev wallet, not a generic failure.
{
  assert.ok(routeSrc.includes('Paste a token contract address (CA) or a dev/deployer wallet address'))
}

// 8. Missing evidence returns Open Check, never a fabricated clean or rugged verdict.
{
  const out = formatTokenApeRiskRead(null)
  assert.equal(out.split('\n')[1], '- Verdict: Open Check')
  assert.equal(out.split('\n')[2], '- Ape risk: Unknown')

  const derivedEmpty = deriveDevHistoryFromTokenEvidence(null)
  assert.equal(derivedEmpty.status, 'open_check')
  const historyOut = formatDevHistoryRead({ status: derivedEmpty.status, gaps: derivedEmpty.gaps })
  assert.ok(/No confirmed rug evidence|Open Check/.test(historyOut))
  assert.ok(!/confirmed rug|has rugged/i.test(historyOut))
}

// 9. Dev-history read never claims confirmed rug history when only contract-control signals
//    (not actual cross-token deployer history) are present — wording stays "signals consistent
//    with risky deployer behavior", never an outright accusation.
{
  const riskyEv = { token: { symbol: 'X' }, security: { ownerRenounced: false, mintable: true }, lpControl: null, ok: true }
  const derived = deriveDevHistoryFromTokenEvidence(riskyEv)
  assert.equal(derived.status, 'risk_signals')
  const out = formatDevHistoryRead({ status: derived.status, riskSignals: derived.riskSignals, gaps: derived.gaps })
  assert.ok(/I found signals consistent with risky deployer behavior/.test(out))
  assert.ok(!/\bhas\s+rugged\b/i.test(out))
  assert.ok(!/confirmed rug history/i.test(out))
}

// 10. No provider names in the new public-facing risk-read output.
{
  assert.ok(!PROVIDER_RE.test(formatTokenApeRiskRead(null)))
  assert.ok(!PROVIDER_RE.test(formatDevHistoryRead({ status: 'open_check' })))
}

// Output format: exact section header + bullet labels for the token ape-risk read.
{
  const out = formatTokenApeRiskRead(null)
  const lines = out.split('\n')
  assert.equal(lines[0], 'TOKEN APE RISK READ')
  assert.ok(lines.some(l => l.startsWith('- Verdict:')))
  assert.ok(lines.some(l => l.startsWith('- Ape risk:')))
  assert.ok(lines.some(l => l.startsWith('- Main risks:')))
  assert.ok(lines.some(l => l.startsWith('- Evidence gaps:')))
  assert.ok(lines.some(l => l.startsWith("- What I'd check next:")))
  assert.ok(lines.some(l => l.startsWith('- Bottom line:')))
}
{
  const out = formatDevHistoryRead({ status: 'open_check' })
  const lines = out.split('\n')
  assert.equal(lines[0], 'DEV HISTORY READ')
  assert.ok(lines.some(l => l.startsWith('- Status:')))
  assert.ok(lines.some(l => l.startsWith('- Deployer/dev:')))
  assert.ok(lines.some(l => l.startsWith('- Risk signals:')))
  assert.ok(lines.some(l => l.startsWith('- Evidence gaps:')))
  assert.ok(lines.some(l => l.startsWith('- Bottom line:')))
}

// Debug fields are wired through route.ts for the new risk-read branches.
{
  assert.ok(routeSrc.includes('clarkRiskIntent: "token_ape_risk"'))
  assert.ok(routeSrc.includes('clarkRiskIntent: "dev_rug_history"'))
  assert.ok(routeSrc.includes('clarkAddressType:'))
  assert.ok(routeSrc.includes('clarkSafetyResolvedFrom:'))
  assert.ok(routeSrc.includes('clarkDevHistoryResolvedFrom:'))
  assert.ok(routeSrc.includes('clarkEvidenceGaps:'))
}

console.log('clark risk-intent (token safety / dev rug history) checks passed')

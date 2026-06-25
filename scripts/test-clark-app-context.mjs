import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  classifyAppContextFollowup,
  formatWalletPnlLockedExplanation,
  formatWalletContextRead,
  formatWalletQualityRead,
  formatWalletNextSteps,
  formatTokenContextRead,
  formatTokenRiskRead,
  formatAppContextMissingAsk,
} from '../lib/server/clarkRouting.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routeSrc = fs.readFileSync(path.join(__dirname, '../app/api/clark/route.ts'), 'utf8')

// 1. Follow-up classification covers the required phrasings.
const cases = [
  ['why is pnl locked', 'pnl_locked'],
  ['why is my pnl hidden', 'pnl_locked'],
  ['what should I do next', 'next_step'],
  ["what's next", 'next_step'],
  ['is this wallet good', 'wallet_quality'],
  ['scan this token', 'scan_token'],
  ['explain this token', 'token_explain'],
  ['what are the risks', 'token_risks'],
  ['explain this', 'explain'],
  ['explain this wallet', 'explain'],
  ['what does this mean', 'explain'],
]
for (const [prompt, kind] of cases) {
  assert.equal(classifyAppContextFollowup(prompt), kind, `"${prompt}" -> ${kind}`)
}
assert.equal(classifyAppContextFollowup('what is FDV'), null, 'unrelated prompt is not an app-context follow-up')
assert.equal(classifyAppContextFollowup('scan 1'), null, 'scan 1 stays a market rank follow-up, not app-context')

// 2. Wallet PnL locked explanation uses the provided reason and names no providers.
const walletSummary = {
  address: '0x' + 'a'.repeat(40),
  totalValue: 12345,
  holdingsCount: 8,
  publicPnlStatus: 'locked_small_sample',
  publicPnlDisplayLabel: 'PnL locked (small sample)',
  publicPnlDisplayReason: 'verified closed-lot sample too small to prove win rate',
  walletPnlRead: { mode: 'raw_reconstruction_locked', label: 'PnL locked', reason: 'sample below threshold' },
  walletModuleCoverage: { portfolio: 'ok', tradeStats: 'open_check' },
  walletOpenPositionSummary: { summary: '3 open lots across 2 tokens' },
}
const pnlCopy = formatWalletPnlLockedExplanation(walletSummary)
assert.ok(pnlCopy.includes('sample below threshold'), 'pnl explanation cites the provided reason')
assert.ok(!/goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i.test(pnlCopy), 'pnl explanation names no providers')
assert.ok(!pnlCopy.includes('COULD NOT COMPLETE'), 'pnl explanation is not a could-not-complete block')

// 3. Wallet reads use the summary, not a generic fallback, and never expose providers.
const PROVIDER_RE = /goldrush|covalent|geckoterminal|coingecko|dexscreener|alchemy/i
for (const out of [formatWalletContextRead(walletSummary), formatWalletQualityRead(walletSummary), formatWalletNextSteps(walletSummary)]) {
  assert.ok(!PROVIDER_RE.test(out), 'wallet read names no providers')
  assert.ok(!out.includes('COULD NOT COMPLETE'), 'wallet read is not a could-not-complete block')
}
assert.ok(formatWalletQualityRead(walletSummary).toLowerCase().includes("can't grade profitability"), 'locked wallet quality stays behavior-only')

// 4. Token reads cite section statuses and risks from context, no providers.
const tokenSummary = {
  chain: 'base',
  address: '0x' + 'b'.repeat(40),
  symbol: 'PEPE2',
  name: 'Pepe Two',
  score: 62,
  verdict: 'Watch',
  topRisks: ['High sell tax (12%).', 'Concentrated holders — top 10 hold 78%.'],
  sectionStatus: { security: 'ok', holders: 'partial', liquidity: 'ok', lp: 'open_check' },
}
const tokenRead = formatTokenContextRead(tokenSummary)
assert.ok(tokenRead.includes('PEPE2') && tokenRead.includes('Watch'), 'token read uses symbol + verdict')
assert.ok(tokenRead.includes('holders: partial'), 'token read cites section statuses')
const riskRead = formatTokenRiskRead(tokenSummary)
assert.ok(riskRead.includes('High sell tax'), 'risk read lists the top risks')
assert.ok(riskRead.includes('lp: open_check'), 'risk read cites coverage statuses')
for (const out of [tokenRead, riskRead]) assert.ok(!PROVIDER_RE.test(out), 'token read names no providers')

// 5. Missing-context asks are short and never a could-not-complete block.
for (const kind of ['pnl_locked', 'next_step', 'wallet_quality', 'scan_token', 'token_explain', 'token_risks', 'explain']) {
  const ask = formatAppContextMissingAsk(kind)
  assert.ok(!ask.includes('COULD NOT COMPLETE'), `${kind} missing-ask is graceful`)
  assert.ok(ask.length < 200, `${kind} missing-ask is short`)
}

// 6. Backend accepts appContext summaries and wires the follow-up dispatcher + debug fields.
assert.ok(/walletSummary\?: ClarkWalletContextSummary/.test(routeSrc), 'appContext type carries walletSummary')
assert.ok(/tokenSummary\?: ClarkTokenContextSummary/.test(routeSrc), 'appContext type carries tokenSummary')
assert.ok(/classifyAppContextFollowup\(prompt\)/.test(routeSrc), 'route uses the app-context follow-up classifier')
for (const field of [
  'appContextReceived', 'appContextRoute', 'appContextFeature', 'appContextUsed',
  'appContextMissingReason', 'clarkFollowupResolvedFrom',
]) {
  assert.ok(routeSrc.includes(field), `route exposes debug field ${field}`)
}
assert.ok(/clarkFollowupResolvedFrom: resolvedFrom/.test(routeSrc), 'resolved-from is set from the resolved context')
// Falls through to session memory when appContext lacks the summary (no regression).
assert.ok(/canDeferToMemory/.test(routeSrc), 'dispatcher defers to session memory when appContext is empty')

console.log('clark app context checks passed')

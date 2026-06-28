import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// walletNoPnlReason supports the relayed-trader provider-summary variant alongside the generic one.
assert.match(snap, /'provider_summary_available_fifo_missing' \| 'relayed_trader_provider_summary_available'/, 'WalletSnapshot.walletNoPnlReason union includes relayed_trader_provider_summary_available')

// walletRecoveryRecommendation must never be left pointing at non_trader_address_type once the
// provider summary has proven the wallet is a real trader.
assert.match(snap, /if \(snapshot\.walletRecoveryRecommendation\?\.reason === 'non_trader_address_type'\) \{\s*\n\s*snapshot\.walletRecoveryRecommendation = \{ \.\.\.snapshot\.walletRecoveryRecommendation, reason: _providerSummaryNoPnlReason \}/, 'walletRecoveryRecommendation.reason is patched away from non_trader_address_type for provider-summary wallets')

// walletProfile.nextAction/weaknesses are patched post-computeWalletProfile for provider-summary mode.
assert.match(snap, /snapshot\.walletProfile\.nextAction = 'Provider PnL is available\. Profit skill, win rate, and wallet score remain locked until ChainLens reconstructs verified FIFO lots\.'/, 'walletProfile.nextAction is rewritten for provider-summary mode')
assert.match(snap, /weaknesses\.filter\(w => !\/pnl integrity failed\/i\.test\(w\)\)/, 'stale "PnL integrity failed" weakness copy is stripped for provider-summary mode')

// apiAudit gains the requested debug fields without restructuring the existing warning logic.
assert.match(snap, /costByPurposeDetail: \{/, 'apiAudit exposes costByPurposeDetail')
assert.match(snap, /auditNotes: \[/, 'apiAudit exposes auditNotes')
assert.match(snap, /callsPrevented: \{\s*\n\s*zerionCallsSavedByCache: _zerionCacheDebug\.callsSavedByCache,\s*\n\s*providerPnlSkippedChains: _providerPnlSkippedChains as string\[\],/, 'apiAudit.callsPrevented exposes providerPnlSkippedChains')

// route.ts re-applies provider-summary copy to walletPersonality/walletBotScore after the route-level
// recompute would otherwise overwrite walletSnapshot.ts's own patch.
assert.match(route, /\(snapshot\.walletPersonality as any\)\.profitSkillStatus = 'provider_summary_available'/, 'route.ts restores walletPersonality.profitSkillStatus for provider-summary mode')
assert.match(route, /\(snapshot\.walletBotScore as any\)\.profitSkillStatus = 'provider_summary_available'/, 'route.ts restores walletBotScore.profitSkillStatus for provider-summary mode')

// route.ts forces walletLoadState to a clean final state (pnlReady=true, unlike the non-trader case)
// for a provider-summary-final response instead of leaving heavyModulesPending populated.
assert.match(route, /const providerSummaryFinal = payload\.walletNoPnlReason === 'provider_summary_available_fifo_missing' \|\| payload\.walletNoPnlReason === 'relayed_trader_provider_summary_available'/, 'route.ts detects the provider-summary-final verdict from walletNoPnlReason')
assert.match(route, /\} else if \(providerSummaryFinal\) \{\s*\n\s*stage = 'final'\s*\n\s*finalPnlReady = true\s*\n\s*finalRecoveryReady = true\s*\n\s*finalHeavyModulesPending = \[\]\s*\n\s*\}/, 'route.ts forces stage=final, pnlReady=true, recoveryReady=true, heavyModulesPending=[] for a provider-summary-final wallet')
assert.match(route, /providerSummaryFinal \? \{ skippedReason: 'provider_summary_available_fifo_missing' \} : \{\}/, 'route.ts records the provider-summary skippedReason note')

console.log('wallet provider-summary state cleanup checks passed')

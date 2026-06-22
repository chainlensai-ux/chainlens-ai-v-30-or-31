import fs from 'node:fs'
import assert from 'node:assert/strict'

const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const pnlGate = fs.readFileSync('scripts/test-wallet-pnl-integrity-gate.mjs', 'utf8')

assert.match(intel, /const pnlIntegrityInvalid = [\s\S]*publicPnlStatus === 'open_check_integrity_invalid'/, 'bot score detects invalid public PnL integrity')
assert.match(intel, /const enoughBehaviorEvidence = tradeIntelLots >= 20 \|\| walletSideTxs >= 50 \|\| swapLikeTxs >= 30/, 'bot score unlocks from behavior lots or wallet-side activity')
assert.doesNotMatch(intel, /scoreUnlocked !== true \|\| \(tradeStats as any\)\?\.pnlIntegrityStatus === 'invalid'[\s\S]*Bot\/automation read is locked/, 'bot score no longer locks behind public performance checks')
assert.match(intel, /basis: pnlIntegrityInvalid \? 'behavior_only'/, 'invalid integrity returns behavior_only basis')
assert.match(intel, /profitSkillStatus: pnlIntegrityInvalid \? 'not_proven'/, 'invalid integrity marks profit skill not proven')
assert.match(intel, /pnlUsed: false/, 'bot score reports that PnL was not used')
assert.match(intel, /signals: string\[\]/, 'bot score exposes behavior signals')
assert.match(intel, /classification: 'Human-like' \| 'Assisted \/ semi-automated' \| 'Likely bot' \| 'High-frequency bot' \| 'Not enough behavior data'/, 'bot classifications use behavior-only labels')

const reasonMatch = intel.match(/const reason = `([\s\S]*?)`/)
assert.ok(reasonMatch, 'bot score has a templated behavior reason')
assert.doesNotMatch(reasonMatch[1], /profit|win rate|smart money|profitable/i, 'bot score reason does not cite profit, win rate, smart money, or profitability')

assert.match(route, /walletSideTransactions: snapshot\.walletActivitySummary\?\.walletSideTransactions/, 'API passes wallet-side activity into bot score')
assert.match(route, /tradeIntelLots: snapshot\.tradeIntelligence\?\.tradeIntelLots/, 'API passes trade intelligence lots into bot score')
assert.match(route, /repeatedTokenPatterns: snapshot\.tradeIntelligence\?\.repeatedTokenPatterns/, 'API passes repeated token patterns into bot score')

assert.match(page, /Bot score is behavior-only\. Profit skill is locked because PnL integrity failed\./, 'UI explains behavior-only bot score when PnL integrity failed')
assert.doesNotMatch(page, /Automation confidence remains limited due to insufficient performance-grade trade evidence\./, 'UI no longer explains bot score as performance-grade locked when behavior score exists')

assert.match(pnlGate, /publicWinRatePercent = null/, 'public win rate remains locked under invalid integrity')
assert.match(pnlGate, /open_check_integrity_invalid/, 'public PnL remains integrity-invalid when integrity fails')

console.log('wallet bot score behavior-only checks passed')

import fs from 'node:fs'
import assert from 'node:assert/strict'

const routing = fs.readFileSync('lib/server/clarkRouting.ts', 'utf8')
const route = fs.readFileSync('app/api/clark/route.ts', 'utf8')

// 1. Clark wallet context includes walletPnlRead when /api/wallet returns estimatedPerformanceRead —
// buildWalletPnlRead reads estimatedPerformanceRead off the raw /api/wallet response and the
// derived field is wired onto the Clark-facing wallet snapshot.
assert.match(routing, /const rawEstimated = raw\.estimatedPerformanceRead && typeof raw\.estimatedPerformanceRead === 'object'/, 'buildWalletPnlRead reads estimatedPerformanceRead from the raw /api/wallet response')
assert.match(route, /walletPnlRead: buildWalletPnlRead\(rawWallet\),/, 'normalizeWalletSnapshotEvidence attaches walletPnlRead to the Clark wallet snapshot')
assert.match(route, /walletPnlRead\?: ClarkWalletPnlRead \| null;/, 'ClarkToolEvidence walletSnapshot type carries walletPnlRead')

// 2. Clark wallet context includes walletPnlRead when /api/wallet returns publicSamplePerformanceRead.
assert.match(routing, /const rawSample = raw\.publicSamplePerformanceRead && typeof raw\.publicSamplePerformanceRead === 'object'/, 'buildWalletPnlRead reads publicSamplePerformanceRead from the raw /api/wallet response')

// 3. Clark never maps estimatedPerformanceRead into official PnL/win rate — official fields are
// only ever populated from publicRealizedPnlUsd/publicWinRatePercent, gated on officialUnlocked.
assert.match(routing, /officialRealizedPnlUsd: officialUnlocked \? publicRealizedPnlUsd : null,/, 'officialRealizedPnlUsd is only ever sourced from the public/official pipeline, never the estimated read')
assert.match(routing, /officialWinRatePercent: officialUnlocked \? publicWinRatePercent : null,/, 'officialWinRatePercent is only ever sourced from the public/official pipeline, never the estimated read')

// 4. Clark never maps publicSamplePerformanceRead into profit skill/wallet score/official win rate —
// those three fields are derived strictly from tradeIntelligence/walletTradeStatsSummary, never from
// the sample read object.
assert.match(routing, /const profitSkillStatus = String\(tradeIntelligence\.profitSkillStatus \?\? ts\.profitSkillStatus \?\? 'locked_small_sample'\);/, 'profitSkillStatus is sourced only from tradeIntelligence/walletTradeStatsSummary')
assert.match(routing, /const walletScoreStatus: 'locked' \| 'unlocked' = ts\.scoreUnlocked === true \? 'unlocked' : 'locked';/, 'walletScoreStatus is sourced only from walletTradeStatsSummary.scoreUnlocked')
assert.ok(!/profitSkillStatus = .*publicSamplePerformanceRead/.test(routing), 'profitSkillStatus is never rewired through publicSamplePerformanceRead')
assert.ok(!/walletScoreStatus.*publicSamplePerformanceRead/.test(routing), 'walletScoreStatus is never rewired through publicSamplePerformanceRead')

// 5. Clark uses "Estimated only — not verified" copy, plus the required excluded-from sentence.
assert.match(routing, /"Status: Estimated only — not verified",/, 'estimated_only display mode uses the required status copy')
assert.match(routing, /"Estimated PnL exists, but it is not verified and is excluded from win rate, profit skill, wallet score, and verified PnL\.",/, 'estimated_only display mode uses the required explanatory sentence')

// 6. Clark uses "Limited sample" copy with the below-threshold explanation.
assert.match(routing, /"Status: Limited sample",/, 'limited_sample display mode uses the required status copy')
assert.match(routing, /`Limited sample exists, but it is below the required \$\{read\.requiredPublicGradeLots\} public-grade lots\.`,/, 'limited_sample display mode explains the required public-grade lot threshold')

// 7. Clark holdings-only path says performance data was not part of this scan.
assert.match(routing, /if \(!read\) return "This read only includes holdings\/activity, not performance\.";/, 'formatWalletPnlRead falls back to the holdings-only disclosure when no PnL read exists')
assert.match(route, /formatWalletPnlRead\(snapshot\.walletPnlRead \?\? null\)/, 'route.ts renders the wallet PnL read (or its holdings-only fallback) into Clark wallet replies')

// 8. Provider names are not present in Clark-facing wallet context — buildWalletPnlRead/formatWalletPnlRead
// never reference moralis/zerion/goldrush or other raw provider identifiers.
const pnlReadSection = routing.slice(routing.indexOf('REQUIRED_PUBLIC_GRADE_LOTS'), routing.indexOf('Build an honest "unsupported compare" reply'))
assert.ok(!/moralis|zerion|goldrush/i.test(pnlReadSection), 'the Clark wallet PnL read never names a provider')

// Profit skill / wallet score / official win rate stay locked whenever displayMode is not
// verified_public — the formatter says so explicitly in every non-verified branch.
assert.match(routing, /"Profit skill remains locked\.",\s*\n\s*"Wallet score remains locked\.",\s*\n\s*"Official win rate remains locked\.",/, 'non-verified display modes explicitly state profit skill/wallet score/official win rate remain locked')

console.log('clark wallet PnL read checks passed')

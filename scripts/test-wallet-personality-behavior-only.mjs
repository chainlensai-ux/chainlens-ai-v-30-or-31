import fs from 'node:fs'
import assert from 'node:assert/strict'

const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const identity = fs.readFileSync('lib/server/walletIdentity.ts', 'utf8')

// 1/2/3/4: computeWalletPersonality produces a behavior-only personality instead of "Not enough
// data" when tradeIntelligence is ready/partial with strong behavior evidence, even though the
// legacy PnL-gated path stayed locked (e.g. invalid integrity).
assert.match(intel, /const enoughBehaviorEvidence = tradeIntelReady && \(tradeIntelLots >= 20 \|\| walletSideTxs >= 50 \|\| swapLikeTxs >= 30\)/, 'computeWalletPersonality unlocks a behavior-only read from tradeIntelligence lots or wallet-side/swap activity')
assert.match(intel, /basis: 'behavior_only',\s*\n\s*pnlUsed: false,\s*\n\s*profitSkillStatus,/, 'behavior-only personality reports basis/pnlUsed/profitSkillStatus')
assert.match(intel, /profitSkillStatus: WalletPersonalityResult\['profitSkillStatus'\] = pnlIntegrityInvalid \? 'integrity_invalid_not_proven' : 'not_proven'/, 'profitSkillStatus is integrity_invalid_not_proven specifically when PnL integrity failed')
assert.match(intel, /const styleLabel = readableTradeStyleLabel\(behaviorEvidence\.primaryStyle\) \?\? 'Mixed behavior'/, 'behavior-only personality derives a style label from tradeIntelligence.primaryStyle')
assert.match(intel, /const botLike = behaviorEvidence\.botClassification === 'Likely bot' \|\| behaviorEvidence\.botClassification === 'High-frequency bot'/, 'behavior-only personality factors in bot classification for a combined label')
assert.match(intel, /Strong behavior evidence from \$\{tradeIntelLots\} behavior lots, \$\{swapLikeTxs\} swap-like transactions/, 'behavior-only summary cites concrete behavior evidence counts')
assert.match(intel, /Profit skill is not proven because PnL integrity failed\./, 'behavior-only summary explains the integrity failure when that is the actual cause')

// computeWalletPersonality must still import the same style-label mapping bot score/profile use,
// so personality and trading-behavior labels never disagree.
assert.match(intel, /import \{ readableTradeStyleLabel \} from '\.\/walletIdentity'/, 'computeWalletPersonality reuses readableTradeStyleLabel from walletIdentity')

// route.ts must compute walletBotScore before walletPersonality (personality's bot-like label
// depends on the bot classification) and pass tradeIntelligence/behavior evidence into personality.
const botScoreIdx = route.indexOf('snapshot.walletBotScore = computeBotScore(')
const personalityIdx = route.indexOf('snapshot.walletPersonality = computeWalletPersonality(')
assert.ok(botScoreIdx >= 0 && personalityIdx >= 0 && botScoreIdx < personalityIdx, 'route.ts computes walletBotScore before walletPersonality so the bot-like label is available')
assert.match(route, /tradeIntelStatus: snapshot\.tradeIntelligence\?\.status \?\? null,/, 'route.ts passes tradeIntelligence status into computeWalletPersonality')
assert.match(route, /botClassification: snapshot\.walletBotScore\?\.classification \?\? null,/, 'route.ts passes walletBotScore classification into computeWalletPersonality')

// 5/6/7: walletTradeStatsSummary public PnL/win-rate fields stay nulled under the existing
// integrity gate (already covered by test-wallet-pnl-integrity-gate.mjs); verify the raw aliases
// added in this pass do not regress that nulling.
assert.match(snap, /ts\.publicWinRatePercent = null/, 'walletTradeStatsSummary.publicWinRatePercent stays nulled on hard-invalid')
assert.match(snap, /ts\.publicRealizedPnlUsd = null/, 'walletTradeStatsSummary.publicRealizedPnlUsd stays nulled on hard-invalid')
assert.match(snap, /ts\.winRateStatus = 'locked_integrity_invalid'/, 'walletTradeStatsSummary.winRateStatus stays locked_integrity_invalid on hard-invalid')
assert.match(snap, /if \(ts\.realizedPnlUsd !== undefined\) ts\.rawRealizedPnlUsd = ts\.realizedPnlUsd/, 'walletTradeStatsSummary gets an explicit rawRealizedPnlUsd alias instead of losing the raw value')
assert.match(snap, /if \(ts\.winRatePercent !== undefined\) ts\.rawWinRatePercent = ts\.winRatePercent/, 'walletTradeStatsSummary gets an explicit rawWinRatePercent alias instead of losing the raw value')

// 8: public sample lots (closed-trade samples, verified/excluded/public-performance samples) must
// not expose a public-safe realizedPnlUsd/realizedPnlPercent once integrity is hard-invalid —
// move them under raw-only aliases and mark them explicitly locked.
assert.match(snap, /s\.pnlLockedReason = 'PnL integrity check failed'/, 'sample lot sanitizer sets pnlLockedReason')
assert.match(snap, /s\.rawRealizedPnlUsd = s\.realizedPnlUsd\s*\n\s*s\.realizedPnlUsd = null/, 'sample lot sanitizer nulls realizedPnlUsd and preserves it under rawRealizedPnlUsd')
assert.match(snap, /s\.rawRealizedPnlPercent = s\.realizedPnlPercent\s*\n\s*s\.realizedPnlPercent = null/, 'sample lot sanitizer nulls realizedPnlPercent and preserves it under rawRealizedPnlPercent')

// page.tsx's "Matched Closed Trades" panel must fall back to the raw aliases so internal disclosure
// still renders once the public-safe fields are nulled.
assert.match(page, /const lotPnlUsd = s\.realizedPnlUsd \?\? s\.rawRealizedPnlUsd \?\? null/, 'page.tsx matched-trades panel falls back to rawRealizedPnlUsd when realizedPnlUsd is nulled')
assert.match(page, /const lotPnlPercent = s\.realizedPnlPercent \?\? s\.rawRealizedPnlPercent \?\? null/, 'page.tsx matched-trades panel falls back to rawRealizedPnlPercent when realizedPnlPercent is nulled')

// 9: walletProfile.reasons must not include the stale "Trading behavior not classified" reason
// once tradeIntelligence resolves a real style label (already fixed in the prior pass; verify it
// still holds).
assert.match(identity, /reasons\[i\]\.startsWith\('Trading behavior not classified'\)/, 'computeWalletProfile strips stale not-classified reason once tradeIntel resolves a style label')

// 10: page/report/export logic must not use raw winRatePercent/realizedPnlUsd as an official public
// read when integrity is invalid — buildWalletReport's integrityInvalid/profitSkillProven gating
// (added in the prior pass) and the windowed-PnL integrity lock cover this; verify both still hold.
assert.match(page, /const integrityInvalid = \(result\.publicPnlStatus \?\? ts\?\.publicPnlStatus\) === 'open_check_integrity_invalid'/, 'buildWalletReport computes an integrityInvalid flag')
assert.match(page, /const profitSkillProven = publicLots >= 10 && !integrityInvalid/, 'buildWalletReport profitSkillProven requires integrity to not be invalid')

// UI copy: behavior-only personality must show a "Behavior-only read. Profit skill locked..."
// banner distinct from the existing small-sample lock banner, and bot score numeric read stays.
assert.match(page, /Behavior-only read\. Profit skill locked because/, 'page.tsx shows a behavior-only personality banner when profit skill is not proven')
assert.match(page, /walletPersonality\?: \{[\s\S]*?basis\?: 'behavior_only' \| 'pnl_verified'/, 'walletPersonality type declares the basis field')

console.log('wallet personality behavior-only checks passed')

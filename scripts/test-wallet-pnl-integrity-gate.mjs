import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// Fix 1: a single gate, run after _p6Integrity is computed, classifies errors into hard-invalid
// vs soft-partial-only and overwrites the already-frozen public PnL fields rather than trusting
// the earlier (integrity-unaware) call sites.
assert.match(snap, /const HARD_INVALID_PNL_ERRORS = new Set\(\[/, 'gate defines a hard-invalid error classification set')
assert.match(snap, /'sells_exceed_buys',/, 'hard-invalid set includes sells_exceed_buys')
assert.match(snap, /'pnl_portfolio_delta_mismatch',/, 'hard-invalid set includes pnl_portfolio_delta_mismatch')

// Fix 2: hard-invalid downgrades publicPnlStatus away from "ok", locks win rate, and forces
// profitSkillStatus to integrity_invalid_not_proven — unconditionally, not only when it was
// previously 'unlocked'.
assert.match(snap, /if \(_p6GateApplies && _p6HardInvalid\) \{/, 'gate branches on hard-invalid case')
assert.match(snap, /\(snapshot as any\)\.publicPnlStatus = 'open_check_integrity_invalid'/, 'hard-invalid sets publicPnlStatus to open_check_integrity_invalid')
assert.match(snap, /ts\.publicWinRatePercent = null/, 'hard-invalid locks publicWinRatePercent to null')
assert.match(snap, /snapshot\.tradeIntelligence\.profitSkillStatus = 'integrity_invalid_not_proven'/, 'hard-invalid forces profitSkillStatus to integrity_invalid_not_proven')

// Fix 3: soft-partial-only (coverage_percent_below_threshold alone) still allows a labeled
// partial-sample read, and only unlocks win rate at >= 10 public-grade closed lots.
assert.match(snap, /else if \(_p6GateApplies && _p6SoftPartialOnly\) \{/, 'gate branches on soft-partial-only case')
assert.match(snap, /_publicPerfLots >= 10 \? 'Verified FIFO sample — partial coverage' : 'Profit skill locked — sample too small'/, 'soft-partial case keeps partial label only when public fields can be visible')
assert.match(snap, /if \(_publicPerfLots < 10\) \{/, 'soft-partial win rate only unlocks at 10+ public-grade closed lots')

// Fix 4: debug field exposing the gate's before/after state.
assert.match(snap, /snapshot\.publicPnlIntegrityGate = \{/, 'gate writes publicPnlIntegrityGate debug field')
assert.match(snap, /publicPnlIntegrityGate\?: \{[\s\S]*?applied: boolean/, 'publicPnlIntegrityGate type is declared on the snapshot')

const identity = fs.readFileSync('lib/server/walletIdentity.ts', 'utf8')

// Fix 5: walletProfile's "Smart Money Candidate"/trading-evidence gating must also treat a
// hard-invalid integrity status (and the new open_check_integrity_invalid status) as locked,
// not just the older publicPnlStatus values.
assert.match(identity, /publicPnlStatus === 'open_check_integrity_invalid' \|\| pnlIntegrityStatusForLock === 'invalid'/, 'tradingLockedByPublicPnl directly checks pnlIntegrityStatus and the new integrity-invalid status')

const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// Fix 6: walletPersonality stays locked on invalid integrity, while walletBotScore remains
// behavior-only and explicitly avoids PnL use.
const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')
assert.match(intel, /\(tradeStats as any\)\?\.pnlIntegrityStatus === 'invalid'/, 'computeWalletPersonality locks on invalid pnlIntegrityStatus')
assert.match(intel, /basis: pnlIntegrityInvalid \? 'behavior_only'/, 'computeBotScore switches to behavior-only basis on invalid pnlIntegrityStatus')
assert.match(intel, /pnlUsed: false/, 'computeBotScore reports no PnL use')

// Fix 7: UI shows a clear integrity-failure message instead of a clean PnL/win-rate read, and the
// "Smart Money Candidate" derivation is gated off the same integrity status so it cannot leak from
// a hard-invalid integrity result.
assert.match(page, /'open_check_integrity_invalid'/, 'page.tsx PnL card branches on the open_check_integrity_invalid status')
assert.match(page, /PnL integrity check failed/, 'page.tsx shows the PnL integrity check failed message')
assert.match(page, /ts\.pnlIntegrityStatus !== 'invalid' &&/, 'isTradeStatsGradeable requires pnlIntegrityStatus to not be invalid before treating stats as gradeable (blocks Smart Money Candidate leak)')

// Fix 8: walletEvidenceModel is a separately-built nested object and must be sanitized by the
// same gate — not just the top-level/walletTradeStatsSummary fields — since the UI/export/Clark
// facts read it directly and previously kept stale "Verified FIFO sample" labels and win rates.
assert.match(snap, /em\.publicPnlStatus = 'open_check_integrity_invalid'/, 'walletEvidenceModel.publicPnlStatus is downgraded on hard-invalid')
assert.match(snap, /em\.publicWinRatePercent = null/, 'walletEvidenceModel.publicWinRatePercent is nulled on hard-invalid')
assert.match(snap, /em\.publicPnlDisplayLabel = 'PnL integrity check failed'/, 'walletEvidenceModel.publicPnlDisplayLabel reflects the integrity failure')
assert.match(snap, /em\.publicPnlBlockedReason = _reasonText/, 'walletEvidenceModel carries a publicPnlBlockedReason explaining the gate')

// Fix 9: walletTradeStatsSummary must also lock scoreUnlocked/readyForWalletScore and use the
// integrity-specific winRateStatus value (not just the small-sample one), since several downstream
// reads (computeWindowedPnl's scoreUnlocked gate, the wallet score pipeline) key off these flags.
assert.match(snap, /ts\.winRateStatus = 'locked_integrity_invalid'/, 'walletTradeStatsSummary.winRateStatus uses the integrity-specific locked value')
assert.match(snap, /ts\.scoreUnlocked = false\s*\n\s*ts\.readyForWalletScore = false/, 'hard-invalid locks scoreUnlocked and readyForWalletScore on walletTradeStatsSummary')

// Fix 10: the free-text tradeStyleSummary generated before the integrity verdict exists must be
// rewritten when it would otherwise claim profit skill is available/profitable/winning while
// profitSkillStatus is now integrity_invalid_not_proven.
assert.match(snap, /profit skill is available\|profitable\|smart money\|winning/i, 'gate detects and rewrites stale profit-skill wording in tradeStyleSummary')
assert.match(snap, /profit skill is not proven because PnL integrity failed/, 'rewritten tradeStyleSummary explains the integrity failure')

const intelSrc = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')

// Fix 11: walletPnlWindows (3d/7d/30d) must not show stale realizedPnlUsd/winRatePercent once the
// parent integrity check is hard-invalid — these are computed from the same lots, downstream of
// walletSnapshot, in a separate computeWindowedPnl call, so the gate must be wired through there too.
assert.match(intelSrc, /integrityInvalid\?: boolean/, 'computeWindowedPnl accepts an integrityInvalid option')
assert.match(intelSrc, /realizedPnlUsd: null,[\s\S]{0,200}winRateStatus: 'locked_integrity_invalid'/, 'computeWindowedPnl nulls realizedPnlUsd/winRatePercent and locks winRateStatus when integrity is invalid')

const routeSrc = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
assert.match(routeSrc, /integrityInvalid: snapshot\.publicPnlStatus === 'open_check_integrity_invalid' \|\| snapshot\.pnlIntegrityCheck\?\.status === 'invalid'/, 'route.ts wires the integrity-invalid flag into computeWindowedPnl')

// Fix 12: the client-side export report (buildWalletReport) must not show a public-sample PnL
// number or claim "Profit skill evidence-eligible" once integrity is invalid, even though
// publicLots >= 10 might otherwise satisfy the old, integrity-unaware threshold check.
assert.match(page, /const integrityInvalid = \(result\.publicPnlStatus \?\? ts\?\.publicPnlStatus\) === 'open_check_integrity_invalid'/, 'buildWalletReport computes an integrityInvalid flag')
assert.match(page, /const profitSkillProven = publicLots >= 10 && !integrityInvalid/, 'buildWalletReport profitSkillProven requires integrity to not be invalid')
assert.match(snap, /Public PnL and win rate remain locked; behavior-only reads may still be shown\./, 'integrity gate wording never implies public PnL is visible when public fields are null')
assert.match(snap, /const _canonicalPublicPnlDisplay = \(/, 'final gate defines one canonical public PnL display mapper')
assert.match(snap, /label: 'Open check — flat\/estimate-only lots excluded'[\s\S]{0,180}reason: 'Public PnL and win rate remain locked because matched lots use flat or estimate-only pricing\.'/,
  'flat_estimate_only canonical label/reason are exact')
assert.match(snap, /label: 'Open check — no public-grade performance lots'/, 'open_check canonical label is exact')
assert.match(snap, /label: 'Profit skill locked — sample too small'/, 'locked_small_sample canonical label is exact')
assert.match(snap, /_applyCanonicalPublicPnlDisplay\(\)/, 'canonical public PnL display is applied after integrity gates')
assert.match(snap, /ts\.publicPnlDisplayLabel = display\.label[\s\S]{0,120}ts\.publicPnlDisplayReason = display\.reason/, 'canonical display is applied to walletTradeStatsSummary')
assert.match(snap, /em\.publicPnlDisplayLabel = display\.label[\s\S]{0,120}em\.publicPnlDisplayReason = display\.reason/, 'canonical display is applied to walletEvidenceModel')

// Fix 13: top-level publicRealizedPnlUsd/publicPerformanceRealizedPnlUsd (computed pre-integrity,
// same as publicWinRatePercent) must also be nulled on hard-invalid, not just the win rate.
assert.match(snap, /\(snapshot as any\)\.publicRealizedPnlUsd = null/, 'hard-invalid nulls top-level publicRealizedPnlUsd')
assert.match(snap, /\(snapshot as any\)\.publicPerformanceRealizedPnlUsd = null/, 'hard-invalid nulls top-level publicPerformanceRealizedPnlUsd')

// Fix 14: walletTradeStatsSummary's public realized PnL fields must mirror the top-level nulling
// since the frontend can read either surface.
assert.match(snap, /ts\.publicRealizedPnlUsd = null/, 'walletTradeStatsSummary.publicRealizedPnlUsd nulled on hard-invalid')
assert.match(snap, /ts\.publicPerformanceRealizedPnlUsd = null/, 'walletTradeStatsSummary.publicPerformanceRealizedPnlUsd nulled on hard-invalid')

// Fix 15: closed-trade sample arrays (built before the integrity verdict exists) must not expose
// publicPnlStatus: 'ok' / includedInPublicStats: true once integrity is hard-invalid.
assert.match(snap, /_sanitizeSampleLotsForIntegrity/, 'gate defines a sample-lot sanitizer for hard-invalid')
assert.match(snap, /_sanitizeSampleLotsForIntegrity\(snapshot\.walletClosedTradeSamples\)/, 'sanitizer applied to walletClosedTradeSamples')
assert.match(snap, /_sanitizeSampleLotsForIntegrity\(snapshot\.walletSyntheticClosedTradeSamples\)/, 'sanitizer applied to walletSyntheticClosedTradeSamples')
assert.match(snap, /_sanitizeSampleLotsForIntegrity\(snapshot\.sampleFlatPriceExcludedLots\)/, 'sanitizer applied to sampleFlatPriceExcludedLots')
assert.match(snap, /_sanitizeSampleLotsForIntegrity\(snapshot\.sampleVerifiedPnlLots\)/, 'sanitizer applied to sampleVerifiedPnlLots')
assert.match(snap, /_sanitizeSampleLotsForIntegrity\(snapshot\.samplePublicPerformanceLots\)/, 'sanitizer applied to samplePublicPerformanceLots')
assert.match(snap, /_sanitizeSampleLotsForIntegrity\(snapshot\.sampleVerifiedButExcludedLots\)/, 'sanitizer applied to sampleVerifiedButExcludedLots')
assert.match(snap, /if \(s\.pnlDisplayStatus === 'verified_pnl'\) s\.pnlDisplayStatus = _publicPnlStatusFinal === 'flat_estimate_only' \? 'flat_estimate_only' : 'pnl_locked_excluded'/,
  'locked/excluded samples do not keep pnlDisplayStatus verified_pnl in flat_estimate_only/open_check/small-sample states')
assert.match(snap, /if \(s\.pnlDisplayStatus === 'verified_pnl'\) s\.pnlDisplayStatus = 'pnl_locked_excluded'/,
  'integrity-locked samples do not keep pnlDisplayStatus verified_pnl')

// Fix 16: stale walletPnlOutlierNote wording ("Public PnL and trade stats use the remaining
// verified lots") must be rewritten once integrity is hard-invalid, since it implies a still-valid
// public PnL read.
assert.match(snap, /PnL integrity failed, so public PnL, win rate, and profit skill are locked\. Trade behavior can still be shown from non-profit evidence\./, 'gate rewrites stale walletPnlOutlierNote wording on hard-invalid')

// Fix 17: walletProfileHints.realizedWinRateBucket must not default to "medium" once integrity is
// hard-invalid — it must be explicitly 'locked' so the UI cannot imply a plausible-but-unknown win rate.
assert.match(snap, /snapshot\.walletProfileHints\.realizedWinRateBucket = 'locked'/, 'walletProfileHints.realizedWinRateBucket forced to locked on hard-invalid')
assert.match(snap, /realizedWinRateBucket: 'low' \| 'medium' \| 'high' \| 'locked'/, 'walletProfileHints type declares the locked bucket value')

// Fix 18: computeWalletProfile must not let a stale "Trading behavior not classified" reason
// coexist with a properly-set tradingBehavior once tradeIntelligence resolves a style label.
assert.match(identity, /reasons\[i\]\.startsWith\('Trading behavior not classified'\)/, 'computeWalletProfile strips stale not-classified reason once tradeIntel resolves a style label')

// Fix 19: nextAction must cite the specific PnL-integrity-failed cause, not the generic
// near-flat/limited-sample wording, when pnlIntegrityStatus is actually invalid.
assert.match(identity, /pnlIntegrityStatus === 'invalid'\s*\n\s*\? \(tradeIntelUnlocked && tradingBehavior/, 'nextAction branches specifically on pnlIntegrityStatus invalid')
assert.match(identity, /profit skill is not proven because PnL integrity failed\./, 'nextAction cites PnL integrity failed specifically')


// Fix 16: public-locked PnL also nulls legacy walletTradeStatsSummary profit fields and keeps
// raw values only behind explicit raw/debug aliases.
assert.match(snap, /const _sanitizePublicLockedTradeStats = \(\) => \{/, 'locked public PnL has a legacy trade-stats sanitizer')
assert.match(snap, /ts\.rawRealizedPnlUsd = ts\.realizedPnlUsd[\s\S]{0,900}ts\.realizedPnlUsd = null/, 'realizedPnlUsd is preserved as raw-only then nulled for public legacy output')
assert.match(snap, /ts\.rawRealizedPnlPercent = ts\.realizedPnlPercent[\s\S]{0,900}ts\.realizedPnlPercent = null/, 'realizedPnlPercent is preserved as raw-only then nulled for public legacy output')
assert.match(snap, /ts\.rawWinningClosedLots = ts\.winningClosedLots[\s\S]{0,900}ts\.winningClosedLots = 0/, 'winningClosedLots is preserved as raw-only then public legacy output is zeroed')
assert.match(snap, /ts\.rawAvgPnlUsdPerClosedLot = ts\.avgPnlUsdPerClosedLot[\s\S]{0,900}ts\.avgPnlUsdPerClosedLot = null/, 'avg PnL per lot is preserved as raw-only then nulled')
assert.match(snap, /ts\.rawLargestWinUsd = ts\.largestWinUsd[\s\S]{0,900}ts\.largestWinUsd = null/, 'largest win is preserved as raw-only then nulled')
assert.match(snap, /ts\.meaningfulRealizedPnlUsd = null/, 'meaningfulRealizedPnlUsd is nulled in locked public output')
assert.match(snap, /ts\.rawDebugOnly = true/, 'raw aliases are marked debug-only')
assert.match(snap, /_sanitizePublicLockedTradeStats\(\)/, 'legacy trade-stats sanitizer runs after canonical public PnL display')

console.log('wallet PnL integrity gate checks passed')

import fs from 'node:fs'
import assert from 'node:assert/strict'

const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. Fully-locked public PnL (zero public-grade lots) replaces raw green metric cards with "Locked" —
// the win rate / realized PnL / avg PnL / avg return / median return cards switch to a publicLock
// card only when publicPnlFullyLocked() is true; a nonzero-but-below-threshold sample shows a
// sampleLock card with real numbers instead.
assert.match(page, /const publicLocked = publicPnlLocked\(result, ts\)/, 'early metric grid computes publicLocked from the public-safe gate')
assert.match(page, /const fullyLocked = publicPnlFullyLocked\(result, ts\)/, 'early metric grid computes fullyLocked from the narrow zero-lots gate')
assert.match(page, /const lockedPnlCard = \(label: string\) => \(\{ label, value: 'Locked', publicLock: true \}\)/, 'locked PnL cards render the literal Locked value')
assert.match(page, /const sampleCard = \(label: string, value: string \| null, pnl\?: number \| null\) => \(\{ label, value: value \?\? '—', pnl, sampleLock: true \}\)/, 'sample PnL cards render the limited-sample value')
for (const label of ['Win Rate', 'Realized PnL', 'Avg PnL / Lot', 'Avg Return / Lot', 'Median Return']) {
  assert.match(page, new RegExp(`fullyLocked \\? lockedPnlCard\\('${label.replace(/\//g, '\\/')}'\\)`), `${label} card fully locks only when zero public-grade lots exist`)
}

// 2. publicPerformanceClosedLots 0 forces the visible copy banner with the required wording.
assert.match(page, /Raw matched lots found, but .*passed public-grade performance checks\. Trade behavior is usable; profit skill is not proven\./, 'fully-locked banner copy matches spec')

// 2b. publicPerformanceClosedLots > 0 but below threshold shows the limited-sample banner instead of
// the fully-locked banner, and surfaces real sample numbers labeled "Limited sample".
assert.match(page, /raw matched lots found\. \{_pubLotsCopy\} passed public-grade performance checks\. Limited sample PnL is shown, but profit skill is not proven\./, 'limited-sample banner copy matches spec')
assert.match(page, /const showSample = publicLocked && !fullyLocked && !!sampleRead/, 'sample banner/cards only render when a nonzero below-threshold public sample exists')

// 3. Fully-locked PnL cards must NOT use green profit styling — the publicLock branch uses amber
// (#fbbf24) "Locked" text and never the green/red pnl color path. Sample-locked cards use the same
// amber family but show real values with a "Limited sample" badge, never green/red profit styling.
assert.match(page, /card\.publicLock \? \(\s*\n\s*<div style=\{\{ fontSize: '14px', fontWeight: 800, color: '#fbbf24'/, 'publicLock cards render amber Locked, not green profit')
assert.match(page, /card\.sampleLock \? \(\s*\n\s*<div style=\{\{ fontSize: '16px', fontWeight: 800, color: '#fbbf24'/, 'sampleLock cards render amber sample values, not green profit')
assert.match(page, /Limited sample<\/span>/, 'sample cards carry a Limited sample badge')

// 4. Summary grid (Matched Realized PnL / Return) also neutralizes to Locked when public PnL locked.
assert.match(page, /const summaryPublicLocked = publicPnlLocked\(result, ts\)/, 'summary grid computes public lock')
assert.match(page, /label: 'Matched Realized PnL', value: summaryPublicLocked \? 'Locked'/, 'matched realized PnL card locks')

// 5. includedInPublicStats === false rows show Locked (not raw PnL) and explain why, keeping
// verify-entry/exit buttons intact. includedInPublicStats === true rows show their sample PnL with a
// "Limited sample" badge when the overall sample is below threshold (sampleBadgeShown), and never fall
// back to fully-locked unless there are zero public-grade lots overall (publicPnlFullyLocked).
assert.match(page, /const samplePnlLocked = publicPnlFullyLocked\(result, ts\) \|\| s\.includedInPublicStats === false \|\| s\.publicPnlStatus !== 'ok'/, 'sample row lock condition includes includedInPublicStats false, gated on the narrow fully-locked check')
assert.match(page, /const sampleBadgeShown = !samplePnlLocked && publicPnlLocked\(result, ts\)/, 'individually-included rows are badged as limited sample when the overall sample is below threshold')
assert.match(page, /\(samplePnlLocked \? 'Locked' : '—'\)/, 'locked sample rows show Locked instead of raw PnL')
assert.match(page, /Not public-grade: estimate-only price, missing independent entry price, synthetic cost basis, dust lot, or integrity lock\./, 'locked sample row explains why')
assert.match(page, /Verify entry ↗/, 'verify entry button retained')
assert.match(page, /Verify exit ↗/, 'verify exit button retained')

// 6. Visible closed-trade samples are deduped by the spec key — raw evidence is not mutated.
assert.match(page, /\$\{\(s\.tokenAddress \?\? ''\)\.toLowerCase\(\)\}\|\$\{s\.entryTxHash \?\? ''\}\|\$\{s\.exitTxHash \?\? ''\}\|\$\{s\.amountClosed\}\|\$\{s\.openedAt\}\|\$\{s\.closedAt\}/, 'visible samples deduped by tokenAddress+entryTx+exitTx+amount+openedAt+closedAt')
assert.match(page, /Dedupe ONLY the rendered rows/, 'dedupe is scoped to rendered rows only')

// 7. Section copy is consistent with the locked public status (no "Matched PnL is calculated" claim).
assert.ok(!page.includes('Matched PnL is calculated only from reconstructed buy → sell lots. It excludes'), 'contradictory "Matched PnL is calculated" copy removed')
assert.match(page, /These are behavior evidence only unless they pass public-grade PnL checks/, 'section copy reframed as behavior evidence')

// 8. SERVER: receipt-proven sell with weak/provider buy increments missingBuyPrice and produces the
// buy_price_not_public_grade lock reason — not flatPrice / generic estimateOnly.
assert.match(snap, /_reconExclusionTally\.missingBuyPrice \+= _receiptProvenSellsWithWeakBuy/, 'receipt-proven sells without a public-grade buy increment missingBuyPrice')
assert.match(snap, /const _receiptProvenSellsWithWeakBuy = Math\.max\(0, \(_swapReconstructionV1Debug\.swapReconstructionEventsPromotedSell \?\? 0\) - _receiptProvenPublicGradeSells\)/, 'honest measure: promoted receipt sells minus receipt-priced public-grade sells')
assert.match(snap, /'sell_price_receipt_proven \| buy_price_not_public_grade'/, 'lock reason matches spec wording')


// 9. Small public-performance samples are canonicalized to locked_small_sample, with the tiny
// public-grade sample retained only under limitedSample* diagnostics.
assert.match(snap, /const status = 'locked_small_sample'/, 'small public-grade sample uses locked_small_sample')
assert.match(snap, /limitedSampleRealizedPnlUsd = limitedPnl/, 'limited sample PnL is preserved separately')
assert.match(snap, /publicRealizedPnlUsd = null/, 'top-level publicRealizedPnlUsd is locked/null for small samples')
assert.match(snap, /publicPerformanceRealizedPnlUsd = null/, 'top-level publicPerformanceRealizedPnlUsd is locked/null for small samples')
assert.match(snap, /sampleLimitedPerformanceLots = limitedSamples/, 'below-threshold public-grade lots move to sampleLimitedPerformanceLots')
assert.match(snap, /samplePublicPerformanceLots = samplePublic\.filter\(\(s: any\) => s\?\.includedInPublicStats === true\)/, 'samplePublicPerformanceLots contains only included public stats rows')
assert.match(snap, /em\.publicPnlStatus = status/, 'walletEvidenceModel status aligns to locked_small_sample')
assert.match(snap, /ts\.publicPnlStatus = status/, 'walletTradeStatsSummary status aligns to locked_small_sample')
assert.match(snap, /excludedLots = Math\.max\(0, rawLots - publicLots\)/, 'excluded lot count has one source of truth')

// 10. UI shows locked small-sample cards and only a diagnostic limited sample disclosure.
assert.match(page, /Limited sample: \{result\.limitedSampleClosedLots \?\? ts\.limitedSampleClosedLots\} lot/, 'limited sample diagnostic copy is present')
assert.match(page, /not enough to publish/, 'limited sample is explicitly not publishable')


// 11. Separate Estimated PnL lane is additive and excluded from verified performance consumers.
assert.match(snap, /estimatedPerformanceRead\?: \{[\s\S]*status: 'available' \| 'unavailable'[\s\S]*excludedFrom: \['win_rate', 'profit_skill', 'wallet_score', 'verified_pnl'\]/, 'estimatedPerformanceRead shape is explicit and excluded from verified metrics')
assert.match(snap, /const _estimatedPerformanceReadLocked = _publicPnlStatusFinal !== 'ok' \|\| _performanceClosedLotsFinal\.length < 10/, 'estimatedPerformanceRead only targets locked or limited public-PnL cases')
assert.match(snap, /status: 'unavailable',[\s\S]*No useful reconstructed cost-basis estimate is available from existing lots\./, 'estimatedPerformanceRead is unavailable when no useful raw estimate exists')
assert.match(page, /Estimated only — not verified\./, 'UI includes estimated-only not-verified warning')
assert.match(page, /Not used for win rate, wallet score, or profit skill\./, 'UI says estimated PnL is excluded from score metrics')
assert.match(page, /label: 'Estimated realized PnL'/, 'UI labels the number as estimated realized PnL')
assert.match(page, /color: '#fbbf24'/, 'estimated PnL uses amber/neutral styling, not verified profit styling')

// 12. publicSamplePerformanceRead — separates "public-grade PnL evidence exists" from "sample is big
// enough to call profit skill". Asserts the 8 required behaviors for showing a limited public PnL
// sample instead of falsely locking the whole UI when publicPerformanceClosedLots > 0.
// 12a. publicPerformanceClosedLots > 0 produces an available publicSamplePerformanceRead.
assert.match(snap, /const _publicSamplePerformanceRead: NonNullable<WalletSnapshot\['publicSamplePerformanceRead'\]> = _performanceClosedLotsFinal\.length > 0/, 'publicSamplePerformanceRead is available whenever a public-grade performance lot exists')
assert.match(snap, /status: 'available',\s*\n\s*sampleLocked: _limitedVerifiedPublicSample,\s*\n\s*closedLots: _performanceClosedLotsFinal\.length,/, 'available sample read reports the public-grade closed lot count')
// 12b. It uses only public-grade lots — sourced from _performanceClosedLotsFinal / _performanceRealizedPnlUsd / _performanceStats, the same public-grade-only pipeline as profit skill, never raw lots.
assert.match(snap, /realizedPnlUsd: _performanceRealizedPnlUsd,/, 'sample realized PnL is sourced from the public-grade-only performance pipeline')
assert.match(snap, /winRatePercent: _performanceStats\.winRatePercent \?\? null,/, 'sample win rate is sourced from the public-grade-only performance stats')
// 12c. profitSkillStatus / scoreUnlocked stay on the untouched >=10-lot gate — sample read is excluded.
assert.match(snap, /excludedFrom: \['profit_skill', 'wallet_score', 'official_win_rate'\]/, 'publicSamplePerformanceRead declares itself excluded from profit skill, wallet score, and official win rate')
assert.ok(!/_limitedVerifiedPublicSample = .*publicSamplePerformanceRead/.test(snap), 'the existing profit-skill threshold gate is not rewired through the new sample read')
// 12d/12e. Wallet score and official win rate do not consume publicSamplePerformanceRead.
assert.ok(!/walletScore[\s\S]{0,200}publicSamplePerformanceRead/.test(snap), 'wallet score computation does not read publicSamplePerformanceRead')
// 12f. Realized PnL card (and the other detail cards) show the limited sample when available.
assert.match(page, /showSample \? sampleCard\('Realized PnL', fmtSignedUSD\(sampleRead!\.realizedPnlUsd\), sampleRead!\.realizedPnlUsd\)/, 'Realized PnL card shows the limited public sample PnL when available')
// 12g. Full "Locked" only renders when publicPerformanceClosedLots === 0 (or integrity invalid).
assert.match(page, /function publicPnlFullyLocked\(result: WalletResult, ts: WalletResult\['walletTradeStatsSummary'\] \| undefined = result\.walletTradeStatsSummary\): boolean \{/, 'publicPnlFullyLocked helper exists as the narrow zero-lots gate')
assert.match(page, /return integrityInvalid \|\| publicLots === 0/, 'fully-locked is true only for zero public-grade lots or invalid integrity')
// 12h. includedInPublicStats true -> sample PnL shown; false -> Locked; rawRealizedPnlUsd never leaks into public sample rows.
assert.match(page, /s\.includedInPublicStats === false \|\| s\.publicPnlStatus !== 'ok'/, 'includedInPublicStats false forces the per-lot row to Locked')
assert.ok(!/sampleRead![^;]*rawRealizedPnlUsd/.test(page), 'sample PnL cards never read rawRealizedPnlUsd')
assert.ok(!/samplePnlLocked[^;\n]*rawRealizedPnlUsd/.test(page), 'per-lot sample rows never fall back to rawRealizedPnlUsd')

console.log('wallet public PnL display-lock checks passed')

import fs from 'node:fs'
import assert from 'node:assert/strict'

const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// 1. Locked public PnL must replace raw green metric cards with "Locked" — the win rate / avg PnL /
// avg return / median return cards switch to a publicLock card when publicPnlLocked() is true.
assert.match(page, /const publicLocked = publicPnlLocked\(result, ts\)/, 'early metric grid computes publicLocked from the public-safe gate')
assert.match(page, /const lockedPnlCard = \(label: string\) => \(\{ label, value: 'Locked', publicLock: true \}\)/, 'locked PnL cards render the literal Locked value')
for (const label of ['Win Rate', 'Avg PnL / Lot', 'Avg Return / Lot', 'Median Return']) {
  assert.match(page, new RegExp(`publicLocked \\? lockedPnlCard\\('${label.replace(/\//g, '\\/')}'\\)`), `${label} card locks when public PnL is locked`)
}

// 2. publicPerformanceClosedLots 0 forces the visible copy banner with the required wording.
assert.match(page, /raw matched lots found, but .*passed public-grade performance checks\. Trade behavior is usable\. Profit skill is not proven\./, 'locked banner copy matches spec')

// 3. Locked PnL cards must NOT use green profit styling — the publicLock branch uses amber (#fbbf24)
// "Locked" text and never the green/red pnl color path.
assert.match(page, /card\.publicLock \? \(\s*\n\s*<div style=\{\{ fontSize: '14px', fontWeight: 800, color: '#fbbf24'/, 'publicLock cards render amber Locked, not green profit')

// 4. Summary grid (Matched Realized PnL / Return) also neutralizes to Locked when public PnL locked.
assert.match(page, /const summaryPublicLocked = publicPnlLocked\(result, ts\)/, 'summary grid computes public lock')
assert.match(page, /label: 'Matched Realized PnL', value: summaryPublicLocked \? 'Locked'/, 'matched realized PnL card locks')

// 5. includedInPublicStats === false rows show Locked (not raw PnL) and explain why, keeping
// verify-entry/exit buttons intact.
assert.match(page, /const samplePnlLocked = publicPnlLocked\(result, ts\) \|\| s\.includedInPublicStats === false \|\| s\.publicPnlStatus !== 'ok'/, 'sample row lock condition includes includedInPublicStats false')
assert.match(page, /\(samplePnlLocked \? 'Locked' : '—'\)/, 'locked sample rows show Locked instead of raw PnL')
assert.match(page, /Not public-grade: integrity check failed \/ estimate-only price \/ missing independent entry price\./, 'locked sample row explains why')
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

console.log('wallet public PnL display-lock checks passed')

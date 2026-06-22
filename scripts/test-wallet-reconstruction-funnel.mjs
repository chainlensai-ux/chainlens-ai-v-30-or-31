import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// RECON-FUNNEL-1: a compact, additive diagnostic funnel must exist on the snapshot type and be
// computed entirely from already-derived values (no new provider calls, no new exclusion rules).
assert.match(snap, /walletTradeReconstructionFunnel\?:\s*\{/, 'walletTradeReconstructionFunnel type is declared on WalletSnapshot')
for (const field of [
  'walletSideTransactions:', 'swapCandidateEvents:', 'candidateSwapTransactions:', 'parsedSwapTransactions:',
  'candidateBuyLegs:', 'candidateSellLegs:', 'matchedBuySellPairs:', 'rawClosedLots:', 'publicGradeClosedLots:',
  'excludedClosedLots:', 'exclusionBreakdown:', 'topFailureReasons:',
]) {
  assert.match(snap, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `walletTradeReconstructionFunnel type exposes ${field}`)
}
for (const field of [
  'estimateOnly', 'syntheticCostBasis', 'flatPrice', 'missingCost', 'missingSellPrice', 'missingBuyPrice',
  'weakIndependence', 'dust', 'unsupportedRouter', 'noQuoteLeg', 'noPriorBuy', 'budgetCapped',
]) {
  assert.match(snap, new RegExp(`${field}:`), `exclusionBreakdown type exposes ${field}`)
}

// The funnel must be derived from existing classification output (no new rejection logic) and
// must never feed back into FIFO/PnL/scoring — it only reads _publicLotClassifications and other
// values that are already computed above it.
assert.match(snap, /const _walletTradeReconstructionFunnel: WalletSnapshot\['walletTradeReconstructionFunnel'\] = \{/, 'funnel object is built from already-computed snapshot values')
assert.match(snap, /for \(const x of _publicLotClassifications\) \{/, 'exclusion tally iterates the existing public-grade lot classifications')
assert.match(snap, /rawClosedLots: _rawMatchedClosedLotsFinal,/, 'funnel rawClosedLots reuses the existing raw matched lot count')
assert.match(snap, /publicGradeClosedLots: _reconPublicLots,/, 'funnel publicGradeClosedLots reuses the existing public-grade lot count')

// Wired through to the snapshot output.
assert.match(snap, /walletTradeReconstructionFunnel: _walletTradeReconstructionFunnel,/, 'walletTradeReconstructionFunnel is attached to the snapshot output')

// UI: a collapsible funnel card renders only when there are candidates/lots to explain, and never
// claims "no activity" when swap candidates exist.
assert.match(ui, /walletTradeReconstructionFunnel\?:\s*\{/, 'WalletResult type declares walletTradeReconstructionFunnel')
assert.match(ui, /Trade Reconstruction Funnel/, 'UI funnel card title present')
assert.match(ui, /No reconstruction funnel available for this scan\./, 'funnel card explains when no reconstruction funnel is available')
for (const label of ['Swap candidate events', 'Parsed swap transactions', 'Matched buy/sell pairs', 'Raw closed lots', 'Public-grade closed lots', 'Excluded closed lots']) {
  assert.match(ui, new RegExp(`'${label}'`), `UI funnel card shows ${label}`)
}
assert.match(ui, /Top failure reasons:/, 'UI funnel card surfaces top exclusion reasons')

console.log('wallet reconstruction funnel checks passed')

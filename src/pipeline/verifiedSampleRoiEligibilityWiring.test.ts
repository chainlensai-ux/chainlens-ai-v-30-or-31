// STATIC WIRING GUARD: quote-cash ROI eligibility must see the same normalized events FIFO used,
// and pairing must use the full structural FIFO (including unpriced lots), not only the published
// verified sample. Manifest-replayed historical quote legs must not lose identity just because
// the bounded event window no longer contains those txs.
//
// Run with:
//   npx tsx --test src/pipeline/verifiedSampleRoiEligibilityWiring.test.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pipelineSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const reconcileSource = readFileSync(new URL('../lib/pnlReconciliation.ts', import.meta.url), 'utf8')

function position(label: string, needle: string, source = pipelineSource): number {
  const index = source.indexOf(needle)
  assert.notEqual(index, -1, `${label} must remain in the source`)
  return index
}

test('reconcile receives normalizedEvents so unpaired stablecoin lots are not left unresolved by omission', () => {
  const callStart = position('reconcile call site', 'const reconciledPnlSummary = await pnlReconciliation.reconcile({')
  const callEnd = pipelineSource.indexOf('\n  })', callStart)
  assert.notEqual(callEnd, -1)
  const callBody = pipelineSource.slice(callStart, callEnd)
  assert.match(callBody, /normalizedEvents:/, 'reconcile must receive normalizedEvents for ROI quote-leg identity')
  assert.match(callBody, /canonicalNormalizedEvents/, 'events passed into reconcile must be the FIFO canonical set')
})

test('computeVerifiedSampleAndFullHistoryPerformance classifies ROI membership from structural lots + events', () => {
  assert.match(reconcileSource, /classifyVerifiedSampleRoiEligibility/)
  assert.match(reconcileSource, /structuralLots\?: readonly MatchedLot\[\]/)
  assert.match(reconcileSource, /verifiedSampleRoiEligibleLots/)
  assert.match(reconcileSource, /unresolved_quote_leg_identity/)
})

test('ROI pairing universe is closed FIFO lots plus unmatched non-stable buy/sell identities', () => {
  const callStart = reconcileSource.indexOf('computeVerifiedSampleAndFullHistoryPerformance({')
  assert.notEqual(callStart, -1, 'performance call site must remain in pnlReconciliation')
  const callEnd = reconcileSource.indexOf('\n      })', callStart)
  assert.notEqual(callEnd, -1)
  const callBody = reconcileSource.slice(callStart, callEnd)
  assert.match(callBody, /structuralLots: roiPairingStructuralLots/, 'pairing must include unmatched FIFO identities, not only closed lots')
  assert.doesNotMatch(callBody, /structuralLots: publishedFifoLots/, 'published verified sample is not the pairing universe')
  assert.doesNotMatch(callBody, /structuralLots: consistentFifoLots/, 'closed FIFO lots alone drop bounded-window risk counterparts')
  assert.match(reconcileSource, /buildRoiPairingStructuralLots\(consistentFifoLots, input\.fifoEngineResult\)/)
  assert.match(reconcileSource, /unmatchedBuyEvents/)
  assert.match(reconcileSource, /unmatchedSellEvents/)
  assert.match(reconcileSource, /\[roi-quote-leg-classification\]/)
  assert.match(callBody, /persistedProofs/, 'ROI classification must receive replayed quote-leg proofs from the canonical sample')
})

test('pipeline replays persisted ROI quote-leg proofs from the canonical sample and writes newly proven ones back', () => {
  assert.match(pipelineSource, /roiQuoteLegProofs:/, 'selector must return existing ROI quote-leg proofs')
  assert.match(pipelineSource, /persistRoiQuoteLegProofs\(/, 'pipeline must persist live-proven ROI quote-leg proofs after reconcile')
  const reconcileCall = pipelineSource.indexOf('const reconciledPnlSummary = await pnlReconciliation.reconcile({')
  const persistCall = pipelineSource.indexOf('await persistRoiQuoteLegProofs(')
  assert.notEqual(reconcileCall, -1)
  assert.notEqual(persistCall, -1)
  assert.ok(persistCall > reconcileCall, 'proof persist must run after reconcile so live-proven identities from this scan are included')
})

test('pipeline wires targeted ROI quote-leg tx backfill into reconcile without fetching full wallet history', () => {
  const callStart = position('createPnlReconciliation call site', 'const pnlReconciliation = createPnlReconciliation({')
  const callEnd = pipelineSource.indexOf('\n  })', callStart)
  assert.notEqual(callEnd, -1)
  const callBody = pipelineSource.slice(callStart, callEnd)
  assert.match(callBody, /roiQuoteLegTxBackfill:/, 'production reconcile must run targeted tx backfill for unproven stable lots')
  assert.match(callBody, /fetchTxReceipt:\s*fetchRoiQuoteLegTxReceipt/, 'backfill must use the exact-tx receipt fetcher')
  assert.match(pipelineSource, /from '\.\.\/lib\/roiQuoteLegTxBackfill'/)
  const backfillSource = readFileSync(new URL('../lib/roiQuoteLegTxBackfill.ts', import.meta.url), 'utf8')
  assert.match(backfillSource, /eth_getTransactionReceipt/, 'backfill fetches individual receipts')
  assert.doesNotMatch(backfillSource, /alchemy_getAssetTransfers/, 'must not paginate asset transfers for ROI quote-leg backfill')
})

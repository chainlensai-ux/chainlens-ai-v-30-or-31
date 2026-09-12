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

test('ROI pairing universe is the full structural FIFO, not only the published verified sample', () => {
  const callStart = reconcileSource.indexOf('computeVerifiedSampleAndFullHistoryPerformance({')
  assert.notEqual(callStart, -1, 'performance call site must remain in pnlReconciliation')
  const callEnd = reconcileSource.indexOf('\n      })', callStart)
  assert.notEqual(callEnd, -1)
  const callBody = reconcileSource.slice(callStart, callEnd)
  assert.match(callBody, /structuralLots: consistentFifoLots/, 'pairing must use all structural matched lots including unpriced')
  assert.doesNotMatch(callBody, /structuralLots: publishedFifoLots/, 'published verified sample is not the pairing universe')
})

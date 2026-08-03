// STATIC WIRING GUARD, DISCLOSED (canonical-manifest-replay follow-up task — confirmed real
// production failure this guards against recurring): the canonical sample manifest was previously
// resolved AFTER `pnlReconciliation.reconcile()` had already computed and returned the public gate
// figures, and the published lot array was then patched in place afterwards. The result was a scan
// that simultaneously reported `canonicalSampleEvidenceUnavailable: true` and published the live
// 23-lot / 85.19% / +4105.85 sample the manifest was supposed to freeze at 21 / 77.78% / -979.81.
//
// Requirement #5 fixes the ORDER: manifest selection must be applied BEFORE the gate, AYRI,
// fingerprints, serialization and the UI result are calculated — which structurally means it must
// be passed INTO reconcile as a selector, never applied to its output. These are static source
// position assertions (same pattern as providerOnlyExecution.test.ts and
// acceptedEvidenceKvWiring.test.ts) — cheap, no pipeline execution, and they fail loudly if anyone
// moves the manifest back downstream of the gate.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pipelineSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function position(label: string, needle: string): number {
  const index = pipelineSource.indexOf(needle)
  assert.notEqual(index, -1, `${label} must remain in the pipeline`)
  return index
}

test('the canonical sample selector is passed INTO reconcile, so manifest selection precedes every gate calculation', () => {
  const callStart = position('reconcile call site', 'const reconciledPnlSummary = await pnlReconciliation.reconcile({')
  const callEnd = pipelineSource.indexOf('\n  })', callStart)
  assert.notEqual(callEnd, -1)
  const callBody = pipelineSource.slice(callStart, callEnd)
  assert.match(callBody, /canonicalSampleSelector,?/, 'reconcile must receive the canonical sample selector')
})

test('the selector is defined before the reconcile call it is passed to', () => {
  const selectorDefinition = position('canonical sample selector definition', 'const canonicalSampleSelector: CanonicalSampleSelector =')
  const reconcileCall = position('reconcile call site', 'const reconciledPnlSummary = await pnlReconciliation.reconcile({')
  assert.ok(selectorDefinition < reconcileCall)
})

test('HARD ASSERTION: every downstream consumer reads reconcile\'s own published array, never the raw pre-reconciliation fifoAndPnl lots', () => {
  const reconciledStart = position('reconciledFifoAndPnl construction', 'const reconciledFifoAndPnl: FifoOutput = {')
  const reconciledEnd = pipelineSource.indexOf('\n  }', reconciledStart)
  assert.notEqual(reconciledEnd, -1)
  const body = pipelineSource.slice(reconciledStart, reconciledEnd)
  // The confirmed 18-vs-23 AYRI/gate divergence was caused by this object spreading `...fifoAndPnl`
  // and inheriting its RAW matchedLots, which predated accepted-evidence hydration entirely.
  assert.match(body, /matchedLots:\s*reconciledPnlSummary\.publishedMatchedLots/, 'reconciledFifoAndPnl must take its matchedLots from the reconciled, manifest-selected published array')
})

test('AYRI and the determinism audit both consume the same reconciled published array', () => {
  const ayriStart = position('ayri build call', 'const ayriAttribution = createAyriAttribution().build({')
  const ayriEnd = pipelineSource.indexOf('\n  })', ayriStart)
  const ayriBody = pipelineSource.slice(ayriStart, ayriEnd)
  assert.match(ayriBody, /reconciledLots:\s*reconciledFifoAndPnl\.matchedLots/)

  const determinismStart = position('scan determinism audit', 'const scanDeterminismAudit = buildScanDeterminismAudit({')
  const determinismEnd = pipelineSource.indexOf('\n  })', determinismStart)
  const determinismBody = pipelineSource.slice(determinismStart, determinismEnd)
  assert.match(determinismBody, /matchedLots:\s*reconciledFifoAndPnl\.matchedLots/)
})

test('the manifest is never auto-refreshed — refresh is driven only by the explicit request flag', () => {
  assert.match(pipelineSource, /params\.refreshCanonicalPnlSample === true/, 'refresh must come from the explicit caller flag')
  // A replay failure must never be turned into a refresh (requirement #9): the only refresh trigger
  // in the manifest branch is the explicit flag itself.
  assert.doesNotMatch(pipelineSource, /refreshCanonicalSampleRequested\s*=\s*true/, 'nothing may promote itself to a refresh at runtime')
})

test('the manifest write is awaited before the scan can report success', () => {
  assert.match(pipelineSource, /await writeCanonicalPnlSampleManifest\(/)
})

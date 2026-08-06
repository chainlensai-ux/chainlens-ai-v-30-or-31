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

// SHARED CANONICALIZATION WIRING, DISCLOSED (surgical manifest-replay fix follow-up task — confirmed
// production bug: manifest_fingerprint_mismatch 2 with matching identity/side-evidence/cost/proceeds,
// e.g. storedRealizedPnlUsd -583.97 vs recomputedRealizedPnlUsd -583.96). `replayManifest` was always
// called with `computeFingerprints: computeManifestFingerprints`, but the manifest-CREATE calls
// (`buildRefreshedManifest`/`buildManifestFromCandidate` on a first scan or explicit refresh) omitted
// it — so creation wrote the caller's raw, pre-allocation total/fingerprints while every later replay
// correctly recomputed the corrected, cent-rounded ones, guaranteeing a permanent mismatch.
test('HARD ASSERTION: manifest creation (buildRefreshedManifest and buildManifestFromCandidate) passes the SAME computeFingerprints helper replayManifest uses', () => {
  const replayCallStart = position('replayManifest call site', 'const firstReplay = await replayManifest({')
  const replayCallEnd = pipelineSource.indexOf('\n    })', replayCallStart)
  const replayBody = pipelineSource.slice(replayCallStart, replayCallEnd)
  assert.match(replayBody, /computeFingerprints:\s*computeManifestFingerprints/, 'replayManifest must receive the shared canonicalization helper')

  const refreshedCallStart = position('buildRefreshedManifest call site', 'await buildRefreshedManifest({')
  const refreshedCallEnd = pipelineSource.indexOf('\n          })', refreshedCallStart)
  const refreshedBody = pipelineSource.slice(refreshedCallStart, refreshedCallEnd)
  assert.match(refreshedBody, /computeFingerprints:\s*computeManifestFingerprints/, 'buildRefreshedManifest must receive the SAME shared canonicalization helper as replay')

  const createCallStart = position('buildManifestFromCandidate (create) call site', 'await buildManifestFromCandidate({\n            identity: manifestIdentity, allCandidateLots: reconciledLots, candidateVerifiedLots,')
  const createCallEnd = pipelineSource.indexOf('\n          })', createCallStart)
  const createBody = pipelineSource.slice(createCallStart, createCallEnd)
  assert.match(createBody, /computeFingerprints:\s*computeManifestFingerprints/, 'buildManifestFromCandidate (the manifest-creation path) must receive the SAME shared canonicalization helper as replay')
})

// STALE-MANIFEST SELF-HEAL WIRING, DISCLOSED (stale-manifest self-heal follow-up task — confirmed
// production shape: a manifest written before 66adf73c permanently mismatches its own replay). Static
// source position/content assertions, same convention as the rest of this file.
test('HARD ASSERTION: a stale-canonicalization mismatch triggers exactly one rebuild-and-rewrite, published only from a re-replay of the refreshed manifest', () => {
  const firstReplayStart = position('first replay call site', 'const firstReplay = await replayManifest({')
  const selfHealGuardStart = position('self-heal guard', 'if (firstReplay.staleManifestCanonicalizationMismatch) {')
  const refreshedManifestStart = position('refreshed manifest build', 'const refreshedManifest = await buildRefreshedManifest({')
  const rewriteStart = position('refreshed manifest write', 'const rewriteSuccess = await writeCanonicalPnlSampleManifest(canonicalSampleManifestKv, refreshedManifest)')
  const secondReplayStart = position('second replay call site', 'const secondReplay = await replayManifest({\n            manifest: refreshedManifest, allCandidateLots: reconciledLots,')
  const effectiveReplayAssignStart = position('effectiveReplay assignment on success', 'effectiveReplay = secondReplay')
  const replayAliasStart = position('replay alias', 'const replay = effectiveReplay')

  assert.ok(firstReplayStart < selfHealGuardStart)
  assert.ok(selfHealGuardStart < refreshedManifestStart)
  assert.ok(refreshedManifestStart < rewriteStart)
  assert.ok(rewriteStart < secondReplayStart)
  assert.ok(secondReplayStart < effectiveReplayAssignStart)
  assert.ok(effectiveReplayAssignStart < replayAliasStart, 'everything downstream must read the (possibly healed) effectiveReplay, never the raw first attempt')

  const refreshedManifestCallEnd = pipelineSource.indexOf('\n        })', refreshedManifestStart)
  const refreshedManifestBody = pipelineSource.slice(refreshedManifestStart, refreshedManifestCallEnd)
  assert.match(refreshedManifestBody, /priorManifest:\s*manifest,/, 'the refresh must be built against the ORIGINAL stored manifest')
  assert.match(refreshedManifestBody, /computeFingerprints:\s*computeManifestFingerprints/, 'the rebuild must use the same shared canonicalization helper')
})

test('HARD ASSERTION: manifestRefreshAttempted/Applied/Reason and staleManifestCanonicalizationMismatch are only ever set from the FIRST replay attempt, never fabricated', () => {
  const auditStart = position('replay-path audit construction', 'canonicalSampleManifestAudit = {\n      ...emptyCanonicalSampleManifestAudit(manifestKey),\n      manifestFound: true,')
  const auditEnd = pipelineSource.indexOf('\n    }', auditStart)
  const auditBody = pipelineSource.slice(auditStart, auditEnd)
  assert.match(auditBody, /staleManifestCanonicalizationMismatch:\s*firstReplay\.staleManifestCanonicalizationMismatch,/)
  assert.match(auditBody, /manifestRefreshAttempted,/)
  assert.match(auditBody, /manifestRefreshApplied,/)
  assert.match(auditBody, /manifestRefreshReason,/)
})

test('HARD ASSERTION: a deployment-proof audit (methodology/fingerprint-helper version, commit sha) is logged on both the manifest-creation and manifest-replay paths', () => {
  const versionConstant = position('methodology/helper version constants', 'const MANIFEST_FINGERPRINT_HELPER_VERSION = 2')
  assert.match(pipelineSource, /canonicalValueMethodologyVersion:\s*CANONICAL_VALUE_METHODOLOGY_VERSION,/)
  assert.match(pipelineSource, /manifestFingerprintHelperVersion:\s*MANIFEST_FINGERPRINT_HELPER_VERSION,/)
  const logCallSites = [...pipelineSource.matchAll(/logDeploymentProofAudit\(manifestKey, canonicalSampleManifestAudit\)/g)]
  assert.equal(logCallSites.length, 2, 'the deployment-proof audit must be logged on BOTH the manifest-creation return and the manifest-replay return')
  assert.ok(versionConstant >= 0)
})

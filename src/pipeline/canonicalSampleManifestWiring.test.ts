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

test('automatic reconciliation is limited to non-structural partial replay failures', () => {
  assert.match(pipelineSource, /params\.refreshCanonicalPnlSample === true/, 'manual refresh remains supported')
  assert.match(pipelineSource, /shouldRefreshPartiallyUnreproducibleManifest\(\s*firstReplay, candidateVerifiedLots\.length/, 'partial refresh must use the centralized integrity policy')
  assert.match(pipelineSource, /buildManifestAdditiveGrowthAudit\(/, 'additive candidate evolution must use the centralized safety predicate')
  assert.match(pipelineSource, /shouldRefreshAdditiveCandidateEvolution\(/, 'additive growth must be gated on the audit')
  assert.match(pipelineSource, /buildManifestAdditiveProviderDependencyAudit\(/, 'additive growth must use evidence-scoped provider usability, not chain-wide partial')
  assert.match(pipelineSource, /providerUsable:\s*additiveProviderDependencyAudit\.additiveCandidateEvidenceProviderUsable/, 'GoldRush history timeout must not automatically block independently proven additive lots')
  assert.doesNotMatch(pipelineSource, /providerUsable:\s*!scanIsProviderPartialForBootstrap/, 'bootstrap partial-scan guard must not be reused as the additive providerUsable predicate')
  assert.match(pipelineSource, /firstReplay\.structuralIntegrityFailure/, 'structural failures must remain explicitly audited')
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
  const selfHealGuardStart = position('self-heal guard', 'if (firstReplay.staleManifestCanonicalizationMismatch || partialReconciliationEligible || additiveGrowthEligible) {')
  const refreshedManifestStart = position('refreshed manifest build', 'const refreshedManifest = await buildRefreshedManifest({')
  const applyStart = position('refresh application helper', 'const application = await applyRefreshedCanonicalManifest({')
  const effectiveReplayAssignStart = position('effectiveReplay assignment on success', 'effectiveReplay = application.replay')
  const replayAliasStart = position('replay alias', 'const replay = effectiveReplay')

  assert.ok(firstReplayStart < selfHealGuardStart)
  assert.ok(selfHealGuardStart < refreshedManifestStart)
  assert.ok(refreshedManifestStart < applyStart)
  assert.ok(applyStart < effectiveReplayAssignStart)
  assert.ok(effectiveReplayAssignStart < replayAliasStart, 'everything downstream must read the (possibly healed) effectiveReplay, never the raw first attempt')
  assert.match(pipelineSource, /requireVerifiedLotCount:\s*additiveGrowthEligible \? candidateVerifiedLots\.length : null/, 'additive growth must refuse to persist a rebuilt count below current candidates')
  assert.match(pipelineSource, /manifestWriteSuccess = application\.audit\.writeSuccess/, 'refreshApplied cannot be true while write success stays the empty-audit false')

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

test('HARD ASSERTION: a deployment-proof audit (methodology/fingerprint-helper version, commit sha) is logged on the manifest-creation, manifest-replay, AND migration-blocked-fresh-creation paths', () => {
  const versionConstant = position('methodology/helper version constants', 'const MANIFEST_FINGERPRINT_HELPER_VERSION = 2')
  assert.match(pipelineSource, /canonicalValueMethodologyVersion:\s*CANONICAL_VALUE_METHODOLOGY_VERSION,/)
  assert.match(pipelineSource, /manifestFingerprintHelperVersion:\s*MANIFEST_FINGERPRINT_HELPER_VERSION,/)
  const logCallSites = [...pipelineSource.matchAll(/logDeploymentProofAudit\(manifestKey, canonicalSampleManifestAudit\)/g)]
  // THREE sites, DISCLOSED (v3->v4 canonical manifest migration follow-up task): the original two
  // (manifest-creation, manifest-replay) plus the new migration-blocked-fresh-creation early return
  // (rule 6 — an unsafe scan with a prior-schema manifest found writes nothing and returns early,
  // but still logs the same deployment-proof audit shape as every other return path).
  assert.equal(logCallSites.length, 3, 'the deployment-proof audit must be logged on the manifest-creation, manifest-replay, AND migration-blocked-fresh-creation returns')
  assert.ok(versionConstant >= 0)
})

// PARTIAL-SCAN BOOTSTRAP GUARD WIRING, DISCLOSED (v3->v4 schema-bump pre-merge safety audit —
// confirmed gap: a manifest schema-version bump changes the manifest's own KV key, so an
// established wallet's good manifest under the prior schema reads back as `null` under the new
// schema — indistinguishable, from the bootstrap branch, from a genuinely brand-new wallet. Without
// a guard, the FIRST scan under a new schema could durably persist a degraded/partial sample as the
// new canonical floor). Static source-position/content assertions, same convention as this file.
test('HARD ASSERTION: the manifest bootstrap-persist path is skipped for a provider-partial scan when no manifest exists yet, but never for an explicit refresh or an empty-bootstrap replacement', () => {
  const guardStart = position('partial-scan bootstrap guard', 'const scanIsProviderPartialForBootstrap = providerDiagnostics.some((d) => d.providerStatus === \'partial\' || d.providerStatus === \'provider_unavailable\')')
  const skipFlagStart = position('skip flag definition', 'const skipUnsafeBootstrapPersist = !existingRead.manifest && !refreshCanonicalSampleRequested')
  const bootstrapBranchStart = position('bootstrap branch', 'if (!existingRead.manifest || refreshCanonicalSampleRequested || replaceEmptyBootstrapManifest) {')
  const writeGuardStart = position('write guarded by skip flag', 'const writeSuccess = skipUnsafeBootstrapPersist ? false : await writeCanonicalPnlSampleManifest(canonicalSampleManifestKv, newManifest)')
  assert.ok(guardStart < skipFlagStart)
  assert.ok(skipFlagStart < bootstrapBranchStart, 'the skip flag must be computed before the branch it gates')
  assert.ok(bootstrapBranchStart < writeGuardStart)

  const skipFlagEnd = pipelineSource.indexOf('\n', pipelineSource.indexOf('scanIsProviderPartialForBootstrap', skipFlagStart + 1))
  const skipFlagBody = pipelineSource.slice(skipFlagStart, skipFlagEnd)
  assert.match(skipFlagBody, /!replaceEmptyBootstrapManifest/, 'replacing a genuinely empty bootstrap must never be blocked by this guard')
})

// V3->V4 SCHEMA MIGRATION WIRING, DISCLOSED (v3->v4 canonical manifest migration follow-up task —
// confirmed gap: the partial-scan bootstrap guard above only ever PREVENTED a fresh, smaller write;
// it never attempted to RECOVER the prior schema's real canonical sample, so a wallet's existing
// 37-lot sample stayed permanently orphaned under the old key forever after a schema bump). Static
// source-position/content assertions, same convention as this file.
test('HARD ASSERTION: the v3->v4 migration block looks up the immediately previous schema version under the EXACT SAME identity, gates on a structural-integrity replay of the prior manifest, confirms the rebuilt candidate with a second replay before ever writing, and blocks BOTH migration and fresh bootstrap-creation when the scan itself is unsafe', () => {
  const previousIdentityStart = position('previous-schema identity lookup', 'manifestSchemaVersion: manifestIdentity.manifestSchemaVersion - 1,')
  const previousReadStart = position('previous-schema manifest read', 'const previousRead = await readCanonicalPnlSampleManifest(canonicalSampleManifestKv, previousSchemaIdentity)')
  const unsafeCheckStart = position('migration unsafe-scan check', 'const scanUnsafeForMigration = scanIsProviderPartialForBootstrap')
  const priorReplayStart = position('prior manifest structural-integrity replay', 'const priorManifestReplay = await replayManifest({\n            manifest: previousRead.manifest, allCandidateLots: reconciledLots,')
  const structuralFailureCheckStart = position('structural-integrity gate on the prior manifest', 'if (priorManifestReplay.manifestStructuralFailureAudit.structuralFailure) {')
  const migratedBuildStart = position('migrated candidate reconstruction', 'const migratedCandidate = await buildRefreshedManifest({\n              priorManifest: previousRead.manifest, identity: manifestIdentity, allCandidateLots: reconciledLots,')
  const confirmReplayStart = position('migration confirmation replay', 'const migrationConfirmReplay = await replayManifest({\n              manifest: migratedCandidate, allCandidateLots: reconciledLots,')
  const migrationWriteStart = position('migration write, gated on confirmed applied outcome', 'if (migrationConfirmReplay.outcome === \'applied\') {')
  const migrationWriteCallStart = position('migration write call', 'const migrationWriteSuccess = await writeCanonicalPnlSampleManifest(canonicalSampleManifestKv, migratedCandidate)')
  const blockedReturnStart = position('migration-blocked-fresh-creation early return', 'if (migrationBlockedFreshCreation) {')
  const bootstrapBranchStart = position('bootstrap branch (again)', 'if (!existingRead.manifest || refreshCanonicalSampleRequested || replaceEmptyBootstrapManifest) {')

  assert.ok(previousIdentityStart < previousReadStart)
  assert.ok(previousReadStart < unsafeCheckStart)
  assert.ok(unsafeCheckStart < priorReplayStart, 'the unsafe-scan check must be evaluated before any migration reconstruction work runs')
  assert.ok(priorReplayStart < structuralFailureCheckStart)
  assert.ok(structuralFailureCheckStart < migratedBuildStart, 'genuine corruption must be checked BEFORE reconstruction is ever attempted')
  assert.ok(migratedBuildStart < confirmReplayStart)
  assert.ok(confirmReplayStart < migrationWriteStart)
  assert.ok(migrationWriteStart < migrationWriteCallStart, 'the write must be gated on the confirmed second replay, never on the first')
  assert.ok(migrationWriteCallStart < blockedReturnStart)
  assert.ok(blockedReturnStart < bootstrapBranchStart, 'the migration-blocked early return must occur BEFORE the plain bootstrap-create branch, so an unsafe scan can never fall through to a fresh, smaller write')

  const unsafeCheckEnd = pipelineSource.indexOf('\n', pipelineSource.indexOf('historyCoverageStatus', unsafeCheckStart))
  const unsafeCheckBody = pipelineSource.slice(unsafeCheckStart, unsafeCheckEnd)
  assert.match(unsafeCheckBody, /unmatchedEvidenceAudit\.windowBoundaryProven\s*!==\s*true/, 'migration must require a proven window boundary')
  assert.match(unsafeCheckBody, /unmatchedEvidenceAudit\.historyCoverageStatus\s*===\s*'truncated'/, 'migration must treat truncated history as unsafe')

  const blockedReturnStatement = position('migration-blocked-fresh-creation return statement', 'return { publishedLots: [...reconciledLots], forcePublicPnlUnavailable: false }')
  assert.ok(blockedReturnStart < blockedReturnStatement)
  const blockedReturnBody = pipelineSource.slice(blockedReturnStart, blockedReturnStatement)
  assert.doesNotMatch(blockedReturnBody, /writeCanonicalPnlSampleManifest/, 'the migration-blocked path must never call the manifest writer — nothing durable is written for an unsafe scan')
})

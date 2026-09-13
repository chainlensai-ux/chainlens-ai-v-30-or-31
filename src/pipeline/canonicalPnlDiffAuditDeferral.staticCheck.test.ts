// WALLET-SCANNER-SPEED-AUDIT TASK, OPPORTUNITY #3, DISCLOSED: static source checks for deferring
// the canonical-PnL diff audit (a diagnostic-only manifest rebuild + evidence-map load) off the
// synchronous scan critical path — same "read the real source, assert on it directly" convention
// already used in scanPerformance.staticCheck.test.ts for this exact function (runWalletScan() is
// 3500+ lines with a deep provider/KV/scheduler dependency graph a pure-function/mock-KV unit test
// can't reach without the extensive real-pipeline fixture setup other src/pipeline/*.test.ts files
// own).
//
// Run directly with:
//   npx tsx --test src/pipeline/canonicalPnlDiffAuditDeferral.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

describe('canonical-PnL diff audit deferred off the critical path (wallet-scanner speed audit, opportunity #3)', () => {
  it('canonicalPnlDiffAuditEnabled is declared exactly once, before the block it gates', () => {
    const flagIndex = src.indexOf("const canonicalPnlDiffAuditEnabled = process.env.CANONICAL_PNL_DIFF_AUDIT_ENABLED === 'true'")
    const blockDeclIndex = src.indexOf('const runCanonicalPnlDiffAudit = async (): Promise<void> =>')
    assert.notEqual(flagIndex, -1, 'canonicalPnlDiffAuditEnabled must be declared')
    assert.notEqual(blockDeclIndex, -1, 'runCanonicalPnlDiffAudit must be declared')
    assert.ok(flagIndex < blockDeclIndex, 'the flag must be read before the block is declared, so the block can be dispatched conditionally on it')
    const declarationCount = (src.match(/const canonicalPnlDiffAuditEnabled = process\.env\.CANONICAL_PNL_DIFF_AUDIT_ENABLED/g) ?? []).length
    assert.equal(declarationCount, 1, 'canonicalPnlDiffAuditEnabled must be declared exactly once — never a second env read')
  })

  it('the diff-audit block runs synchronously (awaited) when explicitly enabled, and is deferred via setImmediate when it is not — same dispatch shape as the shadow receipt-decode block', () => {
    const dispatchMatch = src.match(/if \(canonicalPnlDiffAuditEnabled\) \{\s*\n\s*await runCanonicalPnlDiffAudit\(\)\s*\n\s*\} else \{\s*\n\s*setImmediate\(\(\) => \{ runCanonicalPnlDiffAudit\(\)\.catch\(\(\) => \{\}\) \}\)\s*\n\s*\}/)
    assert.ok(dispatchMatch, 'must find the exact awaited-when-enabled / deferred-when-not dispatch pattern')
  })

  it('the deferred branch never drops the diagnostic — it is still invoked and still allowed to log, just off the synchronous path (never a no-op / never silently skipped)', () => {
    // Distinguishes "deferred" from "disabled": the else branch must actually CALL
    // runCanonicalPnlDiffAudit(), not merely skip it.
    assert.match(src, /setImmediate\(\(\) => \{ runCanonicalPnlDiffAudit\(\)\.catch\(\(\) => \{\}\) \}\)/, 'the default path must still execute the diagnostic (deferred), never omit it')
  })

  it('nothing runCanonicalPnlDiffAudit computes is read by canonicalSampleManifestAudit or this function\'s own return value — proves deferring it cannot change the scan result', () => {
    const blockStart = src.indexOf('const runCanonicalPnlDiffAudit = async (): Promise<void> =>')
    assert.notEqual(blockStart, -1, 'could not locate runCanonicalPnlDiffAudit')
    const dispatchStart = src.indexOf('if (canonicalPnlDiffAuditEnabled) {', blockStart)
    assert.notEqual(dispatchStart, -1, 'could not locate the dispatch that follows the block')
    const dispatchEnd = src.indexOf('const publishedVerifiedLotCount =', dispatchStart)
    assert.notEqual(dispatchEnd, -1, 'could not locate the end of the dispatch')

    const block = src.slice(blockStart, dispatchStart)
    // Every local const this block declares for its own use.
    const localNames = ['candidateManifestForDiff', 'diffEvidenceKeys', 'allDiffRecords', 'diffEvidenceByKey', 'amountByGroupKey']
    for (const name of localNames) {
      assert.match(block, new RegExp(`const ${name} =`), `${name} must be declared inside the diff-audit block`)
    }

    // The remainder of the function, from right after the dispatch to the end of this
    // canonicalSampleSelector closure (its own return statement), must never reference any of
    // these names — that is the actual proof that deferring the block changes nothing downstream.
    const afterDispatch = src.slice(dispatchEnd)
    const closureEnd = afterDispatch.indexOf('\n  }\n\n  const reconciledPnlSummary = await pnlReconciliation.reconcile({')
    assert.notEqual(closureEnd, -1, 'could not locate the end of the canonicalSampleSelector closure this diff-audit block lives in')
    const remainderOfClosure = afterDispatch.slice(0, closureEnd)
    for (const name of localNames) {
      assert.doesNotMatch(remainderOfClosure, new RegExp(`\\b${name}\\b`), `${name} must never be read after the diff-audit dispatch — otherwise deferring the block could change the returned result`)
    }
  })

  it('buildManifestFromCandidate (the rebuild) is never assigned to a variable that outlives the block, and its own module performs no KV/store writes', () => {
    // The ONLY call to buildManifestFromCandidate for diff purposes assigns to the block-local
    // candidateManifestForDiff, never to `manifest`/`effectiveManifest`/a persisted variable.
    assert.doesNotMatch(src, /(?:manifest|effectiveManifest)\s*=\s*await buildManifestFromCandidate/, 'buildManifestFromCandidate\'s diff-audit result must never be assigned to a persisted manifest variable')

    const manifestModuleSrc = readFileSync(fileURLToPath(new URL('../lib/canonicalPnlSampleManifest.ts', import.meta.url)), 'utf8')
    const fnStart = manifestModuleSrc.indexOf('export async function buildManifestFromCandidate')
    assert.notEqual(fnStart, -1, 'could not locate buildManifestFromCandidate in canonicalPnlSampleManifest.ts')
    const nextExportStart = manifestModuleSrc.indexOf('\nexport async function buildRefreshedManifest', fnStart)
    assert.notEqual(nextExportStart, -1, 'could not locate the next export to bound the function body')
    const fnBody = manifestModuleSrc.slice(fnStart, nextExportStart)
    // Named write functions only — local in-memory Maps (`byKey.set(...)`, `shareByLot.set(...)`,
    // etc., used throughout this function for pure allocation bookkeeping) are not KV/store writes
    // and must not trip this check.
    assert.doesNotMatch(fnBody, /writeAcceptedEvidence\(|writeCanonicalPnlSampleManifest\(|\.upsert\(|\.insert\(/, 'buildManifestFromCandidate must perform no persistence — a diagnostic rebuild must never write')
  })

  it('loadAcceptedEvidence (the evidence loader the diff audit reuses) is read-only — delegates only to the read functions, never writeAcceptedEvidence', () => {
    const startIndex = src.indexOf('const loadAcceptedEvidence: AcceptedEvidenceLoader =')
    assert.notEqual(startIndex, -1, 'could not locate the loadAcceptedEvidence definition')
    const endIndex = src.indexOf('const computeManifestFingerprints =', startIndex)
    assert.notEqual(endIndex, -1, 'could not bound the loadAcceptedEvidence definition')
    const loaderSrc = src.slice(startIndex, endIndex)
    assert.match(loaderSrc, /readAcceptedEvidenceAnyLotVersion|readAcceptedEvidence\(/, 'loadAcceptedEvidence must delegate to a read function')
    assert.doesNotMatch(loaderSrc, /writeAcceptedEvidence|\.set\(/, 'loadAcceptedEvidence must never write')
  })

  it('the deferred branch preserves observability — the diagnostic still logs via logCanonicalPnlDiffAudit exactly as before, just after this scan has already returned', () => {
    assert.match(src, /logCanonicalPnlDiffAudit\(buildCanonicalPnlDiffAudit\(\{/, 'the diff-audit block must still build and log the same audit object as before deferral')
  })
})

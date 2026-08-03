// STATIC WIRING GUARD, DISCLOSED (accepted-evidence-canonical-seeding-eligibility follow-up task —
// confirmed real production gap: `createPnlReconciliation()` never actually passed
// `acceptedEvidenceKv` at this call site, across every prior determinism follow-up task, so the
// accepted-evidence hydration/seeding passes always ran against `config.acceptedEvidenceKv ===
// undefined` in real scans despite passing every unit test that injects a fake KV directly). Same
// static-source-position pattern as providerOnlyExecution.test.ts — cheap, no pipeline execution
// required, and directly guards against this exact wiring regression recurring silently.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pipelineSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('createPnlReconciliation is wired with a real acceptedEvidenceKv — the accepted-evidence store is reachable in production, not silently undefined', () => {
  const callStart = pipelineSource.indexOf('const pnlReconciliation = createPnlReconciliation({')
  assert.notEqual(callStart, -1, 'createPnlReconciliation call site must remain in the pipeline')
  const callEnd = pipelineSource.indexOf('\n  })', callStart)
  assert.notEqual(callEnd, -1)
  const callBody = pipelineSource.slice(callStart, callEnd)
  assert.match(callBody, /acceptedEvidenceKv:\s*\S/, 'createPnlReconciliation must be given a real acceptedEvidenceKv, not omitted')
  assert.doesNotMatch(callBody, /acceptedEvidenceKv:\s*undefined\b/, 'must never be explicitly wired to undefined either')
})

test('the acceptedEvidenceKv passed is a real @vercel/kv import, never a fabricated in-memory stand-in', () => {
  assert.match(pipelineSource, /import\s*\{\s*kv as acceptedEvidenceRealKv\s*\}\s*from\s*'@vercel\/kv'/)
})

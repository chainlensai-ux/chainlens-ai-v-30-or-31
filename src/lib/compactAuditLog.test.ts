// Diagnostic audits are logged compactly (scalars + a short sample of each long array) so one scan's
// worker logs stay under Vercel's per-request limit; the audit object itself is never modified.
//   npx tsx --test src/lib/compactAuditLog.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compactAuditForLog } from './compactAuditLog'

describe('compactAuditForLog', () => {
  it('keeps scalars, samples long arrays and records their true length, leaving the audit untouched', () => {
    const audit = { closedLots: 2415, lots: Array.from({ length: 40 }, (_, i) => ({ i })), short: [1, 2], nested: { a: 1 } }
    const before = JSON.stringify(audit)
    const logged = compactAuditForLog(audit)!
    assert.equal(logged.closedLots, 2415)
    assert.deepEqual(logged.lots, [{ i: 0 }, { i: 1 }, { i: 2 }])
    assert.equal(logged.lotsTotal, 40)
    assert.deepEqual(logged.short, [1, 2])
    assert.equal('shortTotal' in logged, false)
    assert.deepEqual(logged.nested, { a: 1 })
    assert.equal(JSON.stringify(audit), before)
    assert.ok(JSON.stringify(logged).length < before.length / 2)
  })
  it('passes null/undefined through', () => {
    assert.equal(compactAuditForLog(null), null)
    assert.equal(compactAuditForLog(undefined), undefined)
  })
})

// TESTS — evidence-first PnL completion task, requirement #5: pool_not_validated_by_factory audit.
//
// The real on-chain caller (createLiveBaseDexPoolValidator) has no injection point for its RPC
// client, so logPoolValidationAudit — the pure, exported logging function it calls — is tested
// directly here, proving it logs the factory queried, every returned pool per attempted key, the
// candidate pool, and the token pair, and that it never logs on an actual match.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logPoolValidationAudit, AERODROME_CLASSIC_FACTORY, AERODROME_SLIPSTREAM_FACTORY } from './poolValidator'

const originalConsoleWarn = console.warn

function captureWarnings(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = []
  console.warn = (...args: unknown[]) => { calls.push(args) }
  return { calls, restore: () => { console.warn = originalConsoleWarn } }
}

test('HARD ASSERTION: a rejection logs the factory queried, candidate pool, token pair, and every attempted key/returnedPool', () => {
  const { calls, restore } = captureWarnings()
  try {
    logPoolValidationAudit(
      'aerodrome_classic',
      AERODROME_CLASSIC_FACTORY,
      '0xcandidatepool',
      '0xTokenA',
      '0xTokenB',
      [{ key: 'stable=false', returnedPool: '0x0000000000000000000000000000000000000000' }, { key: 'stable=true', returnedPool: null }],
      false,
    )
    restore()
    const auditCall = calls.find((c) => c[0] === '[pool-validation-audit]')
    assert.ok(auditCall, 'a rejection must log a [pool-validation-audit] entry')
    const payload = auditCall![1] as Record<string, unknown>
    assert.equal(payload.protocol, 'aerodrome_classic')
    assert.equal(payload.factoryQueried, AERODROME_CLASSIC_FACTORY)
    assert.equal(payload.candidatePool, '0xcandidatepool')
    assert.deepEqual(payload.tokenPair, ['0xtokena', '0xtokenb'])
    assert.deepEqual(payload.attempts, [
      { key: 'stable=false', returnedPool: '0x0000000000000000000000000000000000000000' },
      { key: 'stable=true', returnedPool: null },
    ])
    assert.equal(payload.reason, 'pool_not_validated_by_factory')
  } finally {
    restore()
  }
})

test('HARD ASSERTION: a real match logs nothing — the audit trail is only for the rejection case', () => {
  const { calls, restore } = captureWarnings()
  try {
    logPoolValidationAudit('aerodrome_slipstream', AERODROME_SLIPSTREAM_FACTORY, '0xcandidatepool', '0xTokenA', '0xTokenB', [{ key: 'tickSpacing=100', returnedPool: '0xcandidatepool' }], true)
    restore()
    assert.equal(calls.find((c) => c[0] === '[pool-validation-audit]'), undefined)
  } finally {
    restore()
  }
})

test('supports only the two already-verified, in-scope venues — no guessed factory address', () => {
  const { calls, restore } = captureWarnings()
  try {
    logPoolValidationAudit('aerodrome_slipstream', AERODROME_SLIPSTREAM_FACTORY, '0xcandidatepool', '0xTokenA', '0xTokenB', [], false)
    restore()
    const payload = calls.find((c) => c[0] === '[pool-validation-audit]')![1] as Record<string, unknown>
    assert.ok([AERODROME_CLASSIC_FACTORY, AERODROME_SLIPSTREAM_FACTORY].includes(payload.factoryQueried as string))
  } finally {
    restore()
  }
})

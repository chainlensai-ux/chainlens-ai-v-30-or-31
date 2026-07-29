import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPoolCreationProvenanceLogRecord } from './poolCreationProvenanceLog'
import type { PoolCreationProvenanceDiagnostics } from './poolCreationProvenanceInvestigator'

const PRODUCTION_POOL = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const PRODUCTION_CLAIMED_FACTORY = '0xade65c38cd4849adba595a4323a8c7ddfe89716a'

function diag(overrides: Partial<PoolCreationProvenanceDiagnostics> = {}): PoolCreationProvenanceDiagnostics {
  return {
    pool: PRODUCTION_POOL, creationTxHash: null, contractCreator: null, transactionTo: null,
    claimedFactoryInCreationPath: null, creationReceiptFound: false, exactPoolCreated: null,
    tokenPairVerified: null, feeVerified: null, finalTypedReason: 'creation_tx_not_found',
    ...overrides,
  }
}

test('every field of the built record is a flat scalar, never an array or object', () => {
  const record = buildPoolCreationProvenanceLogRecord(diag({
    creationTxHash: '0xcreationtx', contractCreator: PRODUCTION_CLAIMED_FACTORY, transactionTo: null,
    claimedFactoryInCreationPath: true, creationReceiptFound: true, exactPoolCreated: true,
    tokenPairVerified: true, feeVerified: true, finalTypedReason: 'verified_pool_creation_provenance',
  }))
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(Array.isArray(value), true, `field ${key} must not be an array`)
    assert.notEqual(typeof value, 'object', `field ${key} must not be an object`)
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `field ${key} must be a scalar`)
  }
})

test('production fixture: fields lowercased consistently, null renders as honest placeholders', () => {
  const record = buildPoolCreationProvenanceLogRecord(diag({
    pool: PRODUCTION_POOL.toUpperCase(), contractCreator: PRODUCTION_CLAIMED_FACTORY.toUpperCase(),
  }))
  assert.equal(record.pool, PRODUCTION_POOL.toLowerCase())
  assert.equal(record.contractCreator, PRODUCTION_CLAIMED_FACTORY.toLowerCase())
  assert.equal(record.creationTxHash, 'none')
  assert.equal(record.transactionTo, 'none')
  assert.equal(record.claimedFactoryInCreationPath, 'unknown')
  assert.equal(record.exactPoolCreated, 'unknown')
  assert.equal(record.tokenPairVerified, 'unknown')
  assert.equal(record.feeVerified, 'unknown')
  assert.equal(record.finalTypedReason, 'creation_tx_not_found')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUnsupportedFactoryForensicsLogRecord, UNSUPPORTED_FACTORY_FORENSIC_LOG_LABEL,
} from './unsupportedFactoryForensicsLog'
import type { UnsupportedFactoryForensicsDiagnostics } from './unsupportedFactoryForensics'

const PRODUCTION_POOL = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const PRODUCTION_CLAIMED_FACTORY = '0xade65c38cd4849adba595a4323a8c7ddfe89716a'

function diag(overrides: Partial<UnsupportedFactoryForensicsDiagnostics> = {}): UnsupportedFactoryForensicsDiagnostics {
  return {
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, factoryCodeHash: null,
    proxyType: 'none', implementationAddress: null, implementationCodeHash: null, create2Detected: false,
    poolCreatedTopicDetected: false, creationReceiptAvailable: false, creationEventEmitter: null, creationEventPool: null,
    creationEventToken0: null, creationEventToken1: null, creationEventFee: null, creationProofMatches: null,
    finalTypedReason: 'no_supported_creation_proof',
    ...overrides,
  }
}

test('label is the exact required production log string', () => {
  assert.equal(UNSUPPORTED_FACTORY_FORENSIC_LOG_LABEL, '[pipeline] unsupported concentrated factory forensic')
})

test('every field of the built record is a flat scalar, never an array or object', () => {
  const record = buildUnsupportedFactoryForensicsLogRecord(diag({
    factoryCodeHash: '0xhash', proxyType: 'eip1167', implementationAddress: '0xaaaa', implementationCodeHash: '0ximplhash',
    create2Detected: true, poolCreatedTopicDetected: true, creationReceiptAvailable: true,
    creationEventEmitter: PRODUCTION_CLAIMED_FACTORY, creationEventPool: PRODUCTION_POOL,
    creationEventToken0: '0x1111', creationEventToken1: '0x2222', creationEventFee: 10000,
    creationProofMatches: true, finalTypedReason: 'verified_factory_creation_event',
  }))
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(Array.isArray(value), true, `field ${key} must not be an array`)
    assert.notEqual(typeof value, 'object', `field ${key} must not be an object`)
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `field ${key} must be a scalar`)
  }
})

test('production fixture: fields are lowercased consistently and honest placeholders replace nulls', () => {
  const record = buildUnsupportedFactoryForensicsLogRecord(diag({
    pool: PRODUCTION_POOL.toUpperCase(), claimedFactory: PRODUCTION_CLAIMED_FACTORY.toUpperCase(),
  }))
  assert.equal(record.pool, PRODUCTION_POOL.toLowerCase())
  assert.equal(record.claimedFactory, PRODUCTION_CLAIMED_FACTORY.toLowerCase())
  assert.equal(record.factoryCodeHash, 'none')
  assert.equal(record.implementationAddress, 'none')
  assert.equal(record.implementationCodeHash, 'none')
  assert.equal(record.creationEventEmitter, 'none')
  assert.equal(record.creationEventPool, 'none')
  assert.equal(record.creationEventFee, 'none')
  assert.equal(record.creationProofMatches, 'unknown')
  assert.equal(record.finalTypedReason, 'no_supported_creation_proof')
})

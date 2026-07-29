import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUnknownConcentratedFactoryVerificationLogRecord, UNKNOWN_CONCENTRATED_FACTORY_VERIFICATION_LOG_LABEL,
} from './unknownConcentratedFactoryVerificationLog'
import type { UnknownConcentratedFactoryVerificationDiagnostics } from './unknownConcentratedFactoryVerifier'

const PRODUCTION_EMITTER = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const PRODUCTION_CLAIMED_FACTORY = '0xade65c38cd4849adba595a4323a8c7ddfe89716a'

function diag(overrides: Partial<UnknownConcentratedFactoryVerificationDiagnostics> = {}): UnknownConcentratedFactoryVerificationDiagnostics {
  return {
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: null, discoveryMethod: null, discoveredPool: null, emitterMatchesDiscoveredPool: null,
    poolCodeHash: null, knownImplementationCodeMatch: null, proposedProtocol: null, confidence: 'low',
    finalTypedReason: 'factory_rpc_failure',
    ...overrides,
  }
}

test('label is the exact required production log string', () => {
  assert.equal(UNKNOWN_CONCENTRATED_FACTORY_VERIFICATION_LOG_LABEL, '[pipeline] unknown concentrated factory verification')
})

test('every field of the built record is a flat scalar, never an array or object', () => {
  const record = buildUnknownConcentratedFactoryVerificationLogRecord(diag({
    factoryCodeHash: '0xhash', discoveryMethod: 'getPool', discoveredPool: PRODUCTION_EMITTER,
    emitterMatchesDiscoveredPool: true, poolCodeHash: '0xpoolhash', knownImplementationCodeMatch: true,
    proposedProtocol: 'uniswap_v3', confidence: 'high', finalTypedReason: 'factory_created_emitter',
  }))
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(Array.isArray(value), true, `field ${key} must not be an array`)
    assert.notEqual(typeof value, 'object', `field ${key} must not be an object`)
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `field ${key} must be a scalar`)
  }
})

test('production fixture: factory_created_emitter record surfaces every field flat and lowercased', () => {
  const record = buildUnknownConcentratedFactoryVerificationLogRecord(diag({
    eventEmitter: PRODUCTION_EMITTER.toUpperCase(), claimedFactory: PRODUCTION_CLAIMED_FACTORY.toUpperCase(),
    factoryCodeHash: '0xhash', discoveryMethod: 'getPool', discoveredPool: PRODUCTION_EMITTER.toUpperCase(),
    emitterMatchesDiscoveredPool: true, poolCodeHash: null, knownImplementationCodeMatch: null,
    proposedProtocol: null, confidence: 'medium', finalTypedReason: 'factory_created_emitter',
  }))
  assert.equal(record.eventEmitter, PRODUCTION_EMITTER.toLowerCase())
  assert.equal(record.claimedFactory, PRODUCTION_CLAIMED_FACTORY.toLowerCase())
  assert.equal(record.discoveredPool, PRODUCTION_EMITTER.toLowerCase())
  assert.equal(record.discoveryMethod, 'getPool')
  assert.equal(record.emitterMatchesDiscoveredPool, 'true')
  assert.equal(record.poolCodeHash, 'none')
  assert.equal(record.knownImplementationCodeMatch, 'unknown')
  assert.equal(record.proposedProtocol, 'none')
  assert.equal(record.confidence, 'medium')
  assert.equal(record.finalTypedReason, 'factory_created_emitter')
})

test('unsupported discovery method renders as an honest placeholder, never null/undefined', () => {
  const record = buildUnknownConcentratedFactoryVerificationLogRecord(diag({ discoveryMethod: null, finalTypedReason: 'unsupported_factory_interface' }))
  assert.equal(record.discoveryMethod, 'unsupported')
})

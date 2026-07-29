import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildConcentratedPoolEmitterForensicLogRecord, CONCENTRATED_POOL_EMITTER_FORENSIC_LOG_LABEL,
} from './concentratedPoolEmitterForensicLog'
import type { ConcentratedEmitterFingerprintDiagnostics } from './concentratedPoolEmitterFingerprint'
import { AERODROME_SLIPSTREAM_FACTORY } from './poolValidator'

const PRODUCTION_EMITTER = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const WETH = '0x4200000000000000000000000000000000000006'
const PRODUCTION_TOKEN_X = '0x5576d6ed9181f2225aff5282ac0ed29f755437ea'

function diag(overrides: Partial<ConcentratedEmitterFingerprintDiagnostics> = {}): ConcentratedEmitterFingerprintDiagnostics {
  return {
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, emitterFactory: null, emitterToken0: null, emitterToken1: null,
    emitterFee: null, runtimeCodeHash: null, matchedProtocol: null, matchedFactory: null, tokenPairMatches: null,
    finalTypedReason: 'emitter_rpc_failure',
    ...overrides,
  }
}

test('label is the exact required production log string', () => {
  assert.equal(CONCENTRATED_POOL_EMITTER_FORENSIC_LOG_LABEL, '[pipeline] concentrated pool emitter forensic')
})

test('every field of the built record is a flat scalar, never an array or object', () => {
  const record = buildConcentratedPoolEmitterForensicLogRecord(diag({
    emitterFactory: AERODROME_SLIPSTREAM_FACTORY, emitterToken0: WETH, emitterToken1: PRODUCTION_TOKEN_X,
    emitterFee: 10000, runtimeCodeHash: '0xhash', matchedProtocol: 'aerodrome_slipstream',
    matchedFactory: AERODROME_SLIPSTREAM_FACTORY, tokenPairMatches: true, finalTypedReason: 'verified_non_uniswap_factory',
  }))
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(Array.isArray(value), true, `field ${key} must not be an array`)
    assert.notEqual(typeof value, 'object', `field ${key} must not be an object`)
    assert.ok(['string', 'number', 'boolean'].includes(typeof value), `field ${key} must be a scalar`)
  }
})

test('production fixture: verified_non_uniswap_factory record surfaces every field flat and lowercased', () => {
  const record = buildConcentratedPoolEmitterForensicLogRecord(diag({
    emitterFactory: AERODROME_SLIPSTREAM_FACTORY.toUpperCase(), emitterToken0: WETH.toUpperCase(),
    emitterToken1: PRODUCTION_TOKEN_X.toUpperCase(), emitterFee: 10000, runtimeCodeHash: '0xhash',
    matchedProtocol: 'aerodrome_slipstream', matchedFactory: AERODROME_SLIPSTREAM_FACTORY.toUpperCase(),
    tokenPairMatches: true, finalTypedReason: 'verified_non_uniswap_factory',
  }))
  assert.equal(record.eventEmitter, PRODUCTION_EMITTER.toLowerCase())
  assert.equal(record.emitterFactory, AERODROME_SLIPSTREAM_FACTORY.toLowerCase())
  assert.equal(record.emitterToken0, WETH.toLowerCase())
  assert.equal(record.emitterToken1, PRODUCTION_TOKEN_X.toLowerCase())
  assert.equal(record.emitterFee, '10000')
  assert.equal(record.matchedProtocol, 'aerodrome_slipstream')
  assert.equal(record.matchedFactory, AERODROME_SLIPSTREAM_FACTORY.toLowerCase())
  assert.equal(record.tokenPairMatches, 'true')
  assert.equal(record.finalTypedReason, 'verified_non_uniswap_factory')
})

test('missing/null fields render as honest placeholder strings, never crash or print [object Object]', () => {
  const record = buildConcentratedPoolEmitterForensicLogRecord(diag())
  assert.equal(record.emitterFactory, 'none')
  assert.equal(record.emitterToken0, 'none')
  assert.equal(record.emitterToken1, 'none')
  assert.equal(record.emitterFee, 'none')
  assert.equal(record.runtimeCodeHash, 'none')
  assert.equal(record.matchedProtocol, 'none')
  assert.equal(record.matchedFactory, 'none')
  assert.equal(record.tokenPairMatches, 'unknown')
})

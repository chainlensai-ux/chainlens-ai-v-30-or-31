import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyEmitterFingerprint, VERIFIED_BASE_CONCENTRATED_FACTORIES,
  createCachedConcentratedPoolEmitterFingerprinter, createConcentratedFingerprintRequestScope,
  type ConcentratedPoolEmitterFingerprinter, type ConcentratedEmitterFingerprintDiagnostics,
} from './concentratedPoolEmitterFingerprint'
import { AERODROME_SLIPSTREAM_FACTORY } from './poolValidator'

// PRODUCTION FIXTURE, DISCLOSED (this task's exact reported evidence): a real concentrated pool
// whose swap signs/transfer amounts reconcile exactly, but the canonical Uniswap V3 factory returns
// a DIFFERENT pool at fee 10000, and Aerodrome validation (the old, pre-fingerprint path) already
// failed too.
const PRODUCTION_EMITTER = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const WETH = '0x4200000000000000000000000000000000000006'
const PRODUCTION_TOKEN_X = '0x5576d6ed9181f2225aff5282ac0ed29f755437ea'

test('the verified registry currently holds exactly the previously-verified Aerodrome Slipstream factory', () => {
  assert.equal(VERIFIED_BASE_CONCENTRATED_FACTORIES.length, 1)
  assert.equal(VERIFIED_BASE_CONCENTRATED_FACTORIES[0].factory, AERODROME_SLIPSTREAM_FACTORY)
  assert.equal(VERIFIED_BASE_CONCENTRATED_FACTORIES[0].protocol, 'aerodrome_slipstream')
})

test('production fixture: emitter whose real factory is the verified Aerodrome Slipstream factory classifies as verified_non_uniswap_factory', () => {
  const result = classifyEmitterFingerprint({
    txHash: '0xabc', emitter: PRODUCTION_EMITTER, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X,
    factoryRaw: AERODROME_SLIPSTREAM_FACTORY, token0Raw: WETH, token1Raw: PRODUCTION_TOKEN_X, feeRaw: 10000,
    runtimeCodeHash: '0xcodehash',
  })
  assert.equal(result.finalTypedReason, 'verified_non_uniswap_factory')
  assert.equal(result.matchedProtocol, 'aerodrome_slipstream')
  assert.equal(result.matchedFactory, AERODROME_SLIPSTREAM_FACTORY.toLowerCase())
  assert.equal(result.tokenPairMatches, true)
  assert.equal(result.eventEmitter, PRODUCTION_EMITTER.toLowerCase())
  assert.equal(result.emitterFee, 10000)
})

test('an emitter whose factory is unrecognized (neither Uniswap V3 nor Aerodrome Slipstream) fails closed as unknown_concentrated_factory', () => {
  const result = classifyEmitterFingerprint({
    txHash: '0xabc', emitter: PRODUCTION_EMITTER, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X,
    factoryRaw: '0x9999999999999999999999999999999999999999', token0Raw: WETH, token1Raw: PRODUCTION_TOKEN_X, feeRaw: 500,
    runtimeCodeHash: '0xcodehash',
  })
  assert.equal(result.finalTypedReason, 'unknown_concentrated_factory')
  assert.equal(result.matchedProtocol, null)
})

// SELF-CONTRADICTORY EVIDENCE, DISCLOSED (this file's own header): an emitter claiming
// factory() === Uniswap V3's own factory is never upgraded to a trusted result here — this module
// is only ever consulted after Uniswap's OWN getPool() already failed to validate this exact
// emitter, so this is deliberately excluded from the registry and falls through to
// unknown_concentrated_factory.
test('an emitter claiming the Uniswap V3 factory itself is never trusted -- falls through to unknown_concentrated_factory', () => {
  const result = classifyEmitterFingerprint({
    txHash: '0xabc', emitter: PRODUCTION_EMITTER, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X,
    factoryRaw: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', token0Raw: WETH, token1Raw: PRODUCTION_TOKEN_X, feeRaw: 3000,
    runtimeCodeHash: '0xcodehash',
  })
  assert.equal(result.finalTypedReason, 'unknown_concentrated_factory')
})

test('factory_method_unavailable when factory() itself never returned an address, regardless of other reads', () => {
  const result = classifyEmitterFingerprint({
    txHash: '0xabc', emitter: PRODUCTION_EMITTER, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X,
    factoryRaw: null, token0Raw: WETH, token1Raw: PRODUCTION_TOKEN_X, feeRaw: 3000, runtimeCodeHash: '0xcodehash',
  })
  assert.equal(result.finalTypedReason, 'factory_method_unavailable')
})

test('token_pair_mismatch when the emitter\'s own token0/token1 do not match the expected pair', () => {
  const result = classifyEmitterFingerprint({
    txHash: '0xabc', emitter: PRODUCTION_EMITTER, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X,
    factoryRaw: AERODROME_SLIPSTREAM_FACTORY, token0Raw: WETH, token1Raw: '0x6666666666666666666666666666666666666666', feeRaw: 10000,
    runtimeCodeHash: '0xcodehash',
  })
  assert.equal(result.finalTypedReason, 'token_pair_mismatch')
  assert.equal(result.tokenPairMatches, false)
  // Fails closed even though the factory itself is a verified one -- token identity is the more
  // fundamental fact here, never overridden by a plausible-looking factory match.
  assert.equal(result.matchedProtocol, null)
})

test('emitter_rpc_failure when every single read (including bytecode) failed', () => {
  const result = classifyEmitterFingerprint({
    txHash: '0xabc', emitter: PRODUCTION_EMITTER, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X,
    factoryRaw: null, token0Raw: null, token1Raw: null, feeRaw: null, runtimeCodeHash: null,
  })
  assert.equal(result.finalTypedReason, 'emitter_rpc_failure')
})

test('token pair match is order-insensitive', () => {
  const result = classifyEmitterFingerprint({
    txHash: '0xabc', emitter: PRODUCTION_EMITTER, expectedToken0: PRODUCTION_TOKEN_X, expectedToken1: WETH,
    factoryRaw: AERODROME_SLIPSTREAM_FACTORY, token0Raw: WETH, token1Raw: PRODUCTION_TOKEN_X, feeRaw: 10000,
    runtimeCodeHash: '0xcodehash',
  })
  assert.equal(result.tokenPairMatches, true)
  assert.equal(result.finalTypedReason, 'verified_non_uniswap_factory')
})

function fakeFingerprinter(result: ConcentratedEmitterFingerprintDiagnostics, calls: string[]): ConcentratedPoolEmitterFingerprinter {
  return {
    async fingerprint(txHash, emitter, t0, t1) {
      calls.push(`${txHash}:${emitter}:${t0}:${t1}`)
      return result
    },
  }
}

test('caching: fingerprinting the same emitter twice for the same tx only triggers one real call', async () => {
  const calls: string[] = []
  const fake: ConcentratedEmitterFingerprintDiagnostics = {
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, emitterFactory: AERODROME_SLIPSTREAM_FACTORY.toLowerCase(),
    emitterToken0: WETH, emitterToken1: PRODUCTION_TOKEN_X, emitterFee: 10000, runtimeCodeHash: '0xhash',
    matchedProtocol: 'aerodrome_slipstream', matchedFactory: AERODROME_SLIPSTREAM_FACTORY.toLowerCase(),
    tokenPairMatches: true, finalTypedReason: 'verified_non_uniswap_factory',
  }
  const { fingerprinter, callCount } = createCachedConcentratedPoolEmitterFingerprinter(
    fakeFingerprinter(fake, calls), createConcentratedFingerprintRequestScope(),
  )
  await fingerprinter.fingerprint('0xabc', PRODUCTION_EMITTER, WETH, PRODUCTION_TOKEN_X)
  await fingerprinter.fingerprint('0xabc', PRODUCTION_EMITTER, WETH, PRODUCTION_TOKEN_X)
  assert.equal(calls.length, 1)
  assert.equal(callCount(), 1)
})

test('singleflight: two concurrent fingerprint attempts for the same emitter only trigger one real call', async () => {
  let liveCalls = 0
  let resolveFn: ((v: ConcentratedEmitterFingerprintDiagnostics) => void) | null = null
  const inner: ConcentratedPoolEmitterFingerprinter = {
    async fingerprint() {
      liveCalls += 1
      return new Promise((resolve) => { resolveFn = resolve })
    },
  }
  const { fingerprinter } = createCachedConcentratedPoolEmitterFingerprinter(inner, createConcentratedFingerprintRequestScope())
  const p1 = fingerprinter.fingerprint('0xabc', PRODUCTION_EMITTER, WETH, PRODUCTION_TOKEN_X)
  const p2 = fingerprinter.fingerprint('0xabc', PRODUCTION_EMITTER, WETH, PRODUCTION_TOKEN_X)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(liveCalls, 1)
  resolveFn!({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, emitterFactory: null, emitterToken0: null, emitterToken1: null,
    emitterFee: null, runtimeCodeHash: null, matchedProtocol: null, matchedFactory: null, tokenPairMatches: null,
    finalTypedReason: 'emitter_rpc_failure',
  })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.deepEqual(r1, r2)
})

test('different emitters are fingerprinted independently, never conflated', async () => {
  const calls: string[] = []
  const fake: ConcentratedEmitterFingerprintDiagnostics = {
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, emitterFactory: null, emitterToken0: null, emitterToken1: null,
    emitterFee: null, runtimeCodeHash: null, matchedProtocol: null, matchedFactory: null, tokenPairMatches: null,
    finalTypedReason: 'unknown_concentrated_factory',
  }
  const { fingerprinter } = createCachedConcentratedPoolEmitterFingerprinter(fakeFingerprinter(fake, calls), createConcentratedFingerprintRequestScope())
  await fingerprinter.fingerprint('0xabc', PRODUCTION_EMITTER, WETH, PRODUCTION_TOKEN_X)
  await fingerprinter.fingerprint('0xdef', '0x8888888888888888888888888888888888888888', WETH, PRODUCTION_TOKEN_X)
  assert.equal(calls.length, 2)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyUnknownFactoryVerification, KNOWN_CONCENTRATED_POOL_IMPLEMENTATION_CODE_HASHES,
  createCachedUnknownConcentratedFactoryVerifier, createUnknownFactoryVerificationRequestScope,
  type UnknownConcentratedFactoryVerifier, type UnknownConcentratedFactoryVerificationDiagnostics,
} from './unknownConcentratedFactoryVerifier'

// PRODUCTION FIXTURE, DISCLOSED (this task's exact reported evidence): a real concentrated pool
// whose factory() claims an unrecognized address, matching token0/token1/fee=10000 with the
// receipt, while both Uniswap V3 and Aerodrome Slipstream validation already failed.
const PRODUCTION_EMITTER = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const PRODUCTION_CLAIMED_FACTORY = '0xade65c38cd4849adba595a4323a8c7ddfe89716a'
const WETH = '0x4200000000000000000000000000000000000006'
const PRODUCTION_TOKEN_X = '0x5576d6ed9181f2225aff5282ac0ed29f755437ea'

test('the known-implementation registry ships empty -- no guessed hashes, real verification is a follow-up step', () => {
  assert.equal(KNOWN_CONCENTRATED_POOL_IMPLEMENTATION_CODE_HASHES.length, 0)
})

test('production fixture: factory genuinely created and owns this exact emitter -- factory_created_emitter, medium confidence when the pool code hash could not be captured', () => {
  const result = classifyUnknownFactoryVerification({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', discoveryMethod: 'getPool', discoveredPool: PRODUCTION_EMITTER,
    poolCodeHash: null,
  })
  assert.equal(result.finalTypedReason, 'factory_created_emitter')
  assert.equal(result.emitterMatchesDiscoveredPool, true)
  assert.equal(result.discoveryMethod, 'getPool')
  assert.equal(result.knownImplementationCodeMatch, null)
  assert.equal(result.proposedProtocol, null)
  assert.equal(result.confidence, 'medium')
})

test('factory_created_emitter reaches high confidence only when the pool code hash matches a known, already-verified implementation', () => {
  const knownImplementations = [{ codeHash: '0xknownuniswapv3poolhash', protocol: 'uniswap_v3' }]
  const result = classifyUnknownFactoryVerification({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', discoveryMethod: 'getPool', discoveredPool: PRODUCTION_EMITTER,
    poolCodeHash: '0xKNOWNUNISWAPV3POOLHASH',
  }, knownImplementations)
  assert.equal(result.finalTypedReason, 'factory_created_emitter')
  assert.equal(result.knownImplementationCodeMatch, true)
  assert.equal(result.proposedProtocol, 'uniswap_v3')
  assert.equal(result.confidence, 'high')
})

test('pool_code_mismatch: address evidence matches but the discovered pool bytecode resembles no known implementation, and the registry is non-empty', () => {
  const knownImplementations = [{ codeHash: '0xsomeotherknownhash', protocol: 'aerodrome_slipstream' }]
  const result = classifyUnknownFactoryVerification({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', discoveryMethod: 'getPool', discoveredPool: PRODUCTION_EMITTER,
    poolCodeHash: '0xunrecognizedpoolcodehash',
  }, knownImplementations)
  assert.equal(result.finalTypedReason, 'pool_code_mismatch')
  assert.equal(result.knownImplementationCodeMatch, false)
  assert.equal(result.proposedProtocol, null)
  assert.equal(result.confidence, 'low')
  // Still surfaces the positive address-match evidence -- pool_code_mismatch is a caution flag on
  // top of it, not a replacement of the discovery result.
  assert.equal(result.emitterMatchesDiscoveredPool, true)
  assert.equal(result.discoveredPool, PRODUCTION_EMITTER.toLowerCase())
})

test('factory_returned_zero when the discovery method succeeded but returned no pool at all', () => {
  const result = classifyUnknownFactoryVerification({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', discoveryMethod: 'getPool', discoveredPool: null, poolCodeHash: null,
  })
  assert.equal(result.finalTypedReason, 'factory_returned_zero')
  assert.equal(result.confidence, 'high')
})

test('factory_returned_different_pool when the factory knows a pool for this pair/fee, but it is not this emitter', () => {
  const result = classifyUnknownFactoryVerification({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', discoveryMethod: 'getPool',
    discoveredPool: '0x9999999999999999999999999999999999999999', poolCodeHash: '0xsomehash',
  })
  assert.equal(result.finalTypedReason, 'factory_returned_different_pool')
  assert.equal(result.emitterMatchesDiscoveredPool, false)
  assert.equal(result.confidence, 'high')
})

test('unsupported_factory_interface when the factory has bytecode but no discovery method ever succeeded', () => {
  const result = classifyUnknownFactoryVerification({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', discoveryMethod: null, discoveredPool: null, poolCodeHash: null,
  })
  assert.equal(result.finalTypedReason, 'unsupported_factory_interface')
})

test('factory_rpc_failure when nothing at all was learned -- no bytecode and no discovery method', () => {
  const result = classifyUnknownFactoryVerification({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: null, discoveryMethod: null, discoveredPool: null, poolCodeHash: null,
  })
  assert.equal(result.finalTypedReason, 'factory_rpc_failure')
})

function fakeVerifier(result: UnknownConcentratedFactoryVerificationDiagnostics, calls: string[]): UnknownConcentratedFactoryVerifier {
  return {
    async verify(txHash, emitter, factory, t0, t1, fee) {
      calls.push(`${txHash}:${emitter}:${factory}:${t0}:${t1}:${fee}`)
      return result
    },
  }
}

test('caching: verifying the same emitter+factory+pair+fee twice only triggers one real call', async () => {
  const calls: string[] = []
  const fake: UnknownConcentratedFactoryVerificationDiagnostics = {
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xhash', discoveryMethod: 'getPool', discoveredPool: PRODUCTION_EMITTER,
    emitterMatchesDiscoveredPool: true, poolCodeHash: '0xpoolhash', knownImplementationCodeMatch: false,
    proposedProtocol: null, confidence: 'high', finalTypedReason: 'factory_created_emitter',
  }
  const { verifier, callCount } = createCachedUnknownConcentratedFactoryVerifier(
    fakeVerifier(fake, calls), createUnknownFactoryVerificationRequestScope(),
  )
  await verifier.verify('0xabc', PRODUCTION_EMITTER, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, 10000)
  await verifier.verify('0xabc', PRODUCTION_EMITTER, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, 10000)
  assert.equal(calls.length, 1)
  assert.equal(callCount(), 1)
})

test('singleflight: two concurrent verify attempts for the same key only trigger one real call', async () => {
  let liveCalls = 0
  let resolveFn: ((v: UnknownConcentratedFactoryVerificationDiagnostics) => void) | null = null
  const inner: UnknownConcentratedFactoryVerifier = {
    async verify() {
      liveCalls += 1
      return new Promise((resolve) => { resolveFn = resolve })
    },
  }
  const { verifier } = createCachedUnknownConcentratedFactoryVerifier(inner, createUnknownFactoryVerificationRequestScope())
  const p1 = verifier.verify('0xabc', PRODUCTION_EMITTER, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, 10000)
  const p2 = verifier.verify('0xabc', PRODUCTION_EMITTER, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, 10000)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(liveCalls, 1)
  resolveFn!({
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: null, discoveryMethod: null, discoveredPool: null, emitterMatchesDiscoveredPool: null,
    poolCodeHash: null, knownImplementationCodeMatch: null, proposedProtocol: null, confidence: 'low',
    finalTypedReason: 'factory_rpc_failure',
  })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.deepEqual(r1, r2)
})

test('different fee tiers for the same emitter+factory+pair are verified independently, never conflated', async () => {
  const calls: string[] = []
  const fake: UnknownConcentratedFactoryVerificationDiagnostics = {
    txHash: '0xabc', eventEmitter: PRODUCTION_EMITTER, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: null, discoveryMethod: null, discoveredPool: null, emitterMatchesDiscoveredPool: null,
    poolCodeHash: null, knownImplementationCodeMatch: null, proposedProtocol: null, confidence: 'low',
    finalTypedReason: 'unsupported_factory_interface',
  }
  const { verifier } = createCachedUnknownConcentratedFactoryVerifier(fakeVerifier(fake, calls), createUnknownFactoryVerificationRequestScope())
  await verifier.verify('0xabc', PRODUCTION_EMITTER, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, 10000)
  await verifier.verify('0xabc', PRODUCTION_EMITTER, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, 3000)
  assert.equal(calls.length, 2)
})

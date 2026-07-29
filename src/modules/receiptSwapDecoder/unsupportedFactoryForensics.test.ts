import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyUnsupportedFactoryForensics, POOL_CREATED_TOPIC0, EIP1967_IMPLEMENTATION_SLOT, EIP1967_BEACON_SLOT,
  createCachedUnsupportedFactoryForensicsAnalyzer, createUnsupportedFactoryForensicsRequestScope,
  type UnsupportedFactoryForensicsAnalyzer, type UnsupportedFactoryForensicsDiagnostics,
} from './unsupportedFactoryForensics'
import { keccak256, toBytes } from 'viem'

// PRODUCTION FIXTURE, DISCLOSED (this task's exact reported evidence): a real concentrated pool
// whose claimed factory has real bytecode but supports neither getPool() nor poolByPair() -- the
// prior task's terminal 'unsupported_factory_interface' outcome. token0/token1/fee are already
// verified from the receipt itself.
const PRODUCTION_POOL = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const PRODUCTION_CLAIMED_FACTORY = '0xade65c38cd4849adba595a4323a8c7ddfe89716a'
const WETH = '0x4200000000000000000000000000000000000006'
const PRODUCTION_TOKEN_X = '0x5576d6ed9181f2225aff5282ac0ed29f755437ea'
const PRODUCTION_FEE = 10000

test('the EIP-1967 storage slots are self-verified, computed from the exact standardized labels, never hardcoded blindly', () => {
  const implHash = BigInt(keccak256(toBytes('eip1967.proxy.implementation'))) - BigInt(1)
  const beaconHash = BigInt(keccak256(toBytes('eip1967.proxy.beacon'))) - BigInt(1)
  assert.equal(BigInt(EIP1967_IMPLEMENTATION_SLOT), implHash)
  assert.equal(BigInt(EIP1967_BEACON_SLOT), beaconHash)
})

test('PoolCreated topic0 is the real, standard Uniswap-V3-shaped event signature hash', () => {
  assert.equal(POOL_CREATED_TOPIC0, keccak256(toBytes('PoolCreated(address,address,uint24,int24,address)')))
})

test('production fixture: bytecode exists but shows no proxy pattern, no CREATE2+PoolCreated evidence, no creation event -- honest no_supported_creation_proof', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'none', implementationAddress: null, implementationCodeHash: null,
    create2Detected: false, poolCreatedTopicDetected: false, creationReceiptAvailable: false,
    creationEventEmitter: null, creationEventPool: null, creationEventToken0: null, creationEventToken1: null,
    creationEventFee: null, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'no_supported_creation_proof')
  assert.equal(result.creationProofMatches, null)
})

test('verified_factory_creation_event when the pool creation receipt is available and its PoolCreated log exactly matches', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'none', implementationAddress: null, implementationCodeHash: null,
    create2Detected: false, poolCreatedTopicDetected: true, creationReceiptAvailable: true,
    creationEventEmitter: PRODUCTION_CLAIMED_FACTORY, creationEventPool: PRODUCTION_POOL,
    creationEventToken0: WETH, creationEventToken1: PRODUCTION_TOKEN_X, creationEventFee: PRODUCTION_FEE,
    expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'verified_factory_creation_event')
  assert.equal(result.creationProofMatches, true)
})

test('verified_factory_creation_event also holds when the emitter is the resolved proxy implementation, not the claimed factory directly', () => {
  const implementation = '0x9999999999999999999999999999999999999999'
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'eip1967_implementation', implementationAddress: implementation,
    implementationCodeHash: '0ximplcodehash', create2Detected: false, poolCreatedTopicDetected: true, creationReceiptAvailable: true,
    creationEventEmitter: implementation, creationEventPool: PRODUCTION_POOL,
    creationEventToken0: WETH, creationEventToken1: PRODUCTION_TOKEN_X, creationEventFee: PRODUCTION_FEE,
    expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'verified_factory_creation_event')
})

test('creation_event_mismatch when a PoolCreated-shaped log was found but its fields do not match this exact pool/pair/fee', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'none', implementationAddress: null, implementationCodeHash: null,
    create2Detected: false, poolCreatedTopicDetected: true, creationReceiptAvailable: true,
    creationEventEmitter: PRODUCTION_CLAIMED_FACTORY, creationEventPool: '0x8888888888888888888888888888888888888888',
    creationEventToken0: WETH, creationEventToken1: PRODUCTION_TOKEN_X, creationEventFee: PRODUCTION_FEE,
    expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'creation_event_mismatch')
  assert.equal(result.creationProofMatches, false)
})

test('creation_event_mismatch when the fields match but the emitter is unrelated to the claimed factory/implementation', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'none', implementationAddress: null, implementationCodeHash: null,
    create2Detected: false, poolCreatedTopicDetected: true, creationReceiptAvailable: true,
    creationEventEmitter: '0x7777777777777777777777777777777777777777', creationEventPool: PRODUCTION_POOL,
    creationEventToken0: WETH, creationEventToken1: PRODUCTION_TOKEN_X, creationEventFee: PRODUCTION_FEE,
    expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'creation_event_mismatch')
})

test('proxy_implementation_resolved when an EIP-1167 minimal proxy was fully resolved but no creation event is available', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'eip1167', implementationAddress: '0xaaaa',
    implementationCodeHash: '0ximplhash', create2Detected: false, poolCreatedTopicDetected: false, creationReceiptAvailable: false,
    creationEventEmitter: null, creationEventPool: null, creationEventToken0: null, creationEventToken1: null,
    creationEventFee: null, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'proxy_implementation_resolved')
})

test('verified_create2_derivation when structural CREATE2 + PoolCreated-topic evidence exists but no creation event or proxy was found', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'none', implementationAddress: null, implementationCodeHash: null,
    create2Detected: true, poolCreatedTopicDetected: true, creationReceiptAvailable: false,
    creationEventEmitter: null, creationEventPool: null, creationEventToken0: null, creationEventToken1: null,
    creationEventFee: null, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'verified_create2_derivation')
})

test('proxy_resolution_failed when a beacon proxy pattern was detected but not fully resolved within budget', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: '0xfactorycodehash', proxyType: 'eip1967_beacon', implementationAddress: null, implementationCodeHash: null,
    create2Detected: false, poolCreatedTopicDetected: false, creationReceiptAvailable: false,
    creationEventEmitter: null, creationEventPool: null, creationEventToken0: null, creationEventToken1: null,
    creationEventFee: null, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'proxy_resolution_failed')
})

test('rpc_failure when nothing at all was learned -- no bytecode, no proxy classification attempted', () => {
  const result = classifyUnsupportedFactoryForensics({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY,
    factoryCodeHash: null, proxyType: null, implementationAddress: null, implementationCodeHash: null,
    create2Detected: false, poolCreatedTopicDetected: false, creationReceiptAvailable: false,
    creationEventEmitter: null, creationEventPool: null, creationEventToken0: null, creationEventToken1: null,
    creationEventFee: null, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE,
  })
  assert.equal(result.finalTypedReason, 'rpc_failure')
})

function fakeAnalyzer(result: UnsupportedFactoryForensicsDiagnostics, calls: string[]): UnsupportedFactoryForensicsAnalyzer {
  return {
    async analyze(input) {
      calls.push(`${input.txHash}:${input.pool}:${input.claimedFactory}:${input.expectedToken0}:${input.expectedToken1}:${input.expectedFee}`)
      return result
    },
  }
}

test('caching: analyzing the same pool+factory+pair+fee twice only triggers one real call', async () => {
  const calls: string[] = []
  const fake: UnsupportedFactoryForensicsDiagnostics = {
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, factoryCodeHash: '0xhash',
    proxyType: 'none', implementationAddress: null, implementationCodeHash: null, create2Detected: false,
    poolCreatedTopicDetected: false, creationReceiptAvailable: false, creationEventEmitter: null, creationEventPool: null,
    creationEventToken0: null, creationEventToken1: null, creationEventFee: null, creationProofMatches: null,
    finalTypedReason: 'no_supported_creation_proof',
  }
  const { analyzer, callCount } = createCachedUnsupportedFactoryForensicsAnalyzer(fakeAnalyzer(fake, calls), createUnsupportedFactoryForensicsRequestScope())
  const args = { txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE }
  await analyzer.analyze(args)
  await analyzer.analyze(args)
  assert.equal(calls.length, 1)
  assert.equal(callCount(), 1)
})

test('singleflight: two concurrent analyze attempts for the same key only trigger one real call', async () => {
  let liveCalls = 0
  let resolveFn: ((v: UnsupportedFactoryForensicsDiagnostics) => void) | null = null
  const inner: UnsupportedFactoryForensicsAnalyzer = {
    async analyze() {
      liveCalls += 1
      return new Promise((resolve) => { resolveFn = resolve })
    },
  }
  const { analyzer } = createCachedUnsupportedFactoryForensicsAnalyzer(inner, createUnsupportedFactoryForensicsRequestScope())
  const args = { txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE }
  const p1 = analyzer.analyze(args)
  const p2 = analyzer.analyze(args)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(liveCalls, 1)
  resolveFn!({
    txHash: '0xabc', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, factoryCodeHash: null,
    proxyType: null, implementationAddress: null, implementationCodeHash: null, create2Detected: false,
    poolCreatedTopicDetected: false, creationReceiptAvailable: false, creationEventEmitter: null, creationEventPool: null,
    creationEventToken0: null, creationEventToken1: null, creationEventFee: null, creationProofMatches: null,
    finalTypedReason: 'rpc_failure',
  })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.deepEqual(r1, r2)
})

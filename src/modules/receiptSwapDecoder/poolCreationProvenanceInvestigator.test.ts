import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyPoolCreationProvenance, createPoolCreationProvenanceInvestigator, createPoolCreationProvenanceCache,
  type IndexedContractCreationLookup, type PoolCreationReceiptFetcher, type RawPoolCreationProvenanceInput,
} from './poolCreationProvenanceInvestigator'
import { POOL_CREATED_TOPIC0 } from './unsupportedFactoryForensics'
import type { RawReceiptLog } from './types'
import { encodeAbiParameters, pad } from 'viem'

// PRODUCTION FIXTURE, DISCLOSED (this task's exact reported evidence): pool
// 0x7f31b371ac675bca3357fd9c26854fed067400c0, claimed factory
// 0xade65c38cd4849adba595a4323a8c7ddfe89716a -- the prior forensic pass already found
// create2Detected=true, no PoolCreated topic, no proxy, no creation receipt available, terminated
// at no_supported_creation_proof.
const PRODUCTION_POOL = '0x7f31b371ac675bca3357fd9c26854fed067400c0'
const PRODUCTION_CLAIMED_FACTORY = '0xade65c38cd4849adba595a4323a8c7ddfe89716a'
const WETH = '0x4200000000000000000000000000000000000006'
const PRODUCTION_TOKEN_X = '0x5576d6ed9181f2225aff5282ac0ed29f755437ea'
const PRODUCTION_FEE = 10000
const CREATION_TX = '0xcreationtxhash'

function poolCreatedLog(logIndex: number, emitter: string, token0: string, token1: string, fee: number, pool: string): RawReceiptLog {
  return {
    logIndex, address: emitter.toLowerCase(),
    topics: [POOL_CREATED_TOPIC0, pad(token0 as `0x${string}`), pad(token1 as `0x${string}`), pad(`0x${fee.toString(16)}` as `0x${string}`)],
    data: encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [200, pool as `0x${string}`]),
  }
}

function baseInput(overrides: Partial<RawPoolCreationProvenanceInput> = {}): RawPoolCreationProvenanceInput {
  return {
    pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X,
    expectedFee: PRODUCTION_FEE, lookupFailed: false, creationTxHash: null, contractCreator: null,
    creationTraceCalledContracts: null, receiptFetchFailed: false, creationReceiptFound: false, transactionTo: null,
    contractAddressFromReceipt: null, creationLogs: [],
    ...overrides,
  }
}

test('provider_failure when the indexed lookup itself fails', () => {
  const result = classifyPoolCreationProvenance(baseInput({ lookupFailed: true }))
  assert.equal(result.finalTypedReason, 'provider_failure')
})

test('creation_tx_not_found when the indexed lookup succeeds but finds nothing for this pool', () => {
  const result = classifyPoolCreationProvenance(baseInput({ lookupFailed: false, creationTxHash: null }))
  assert.equal(result.finalTypedReason, 'creation_tx_not_found')
})

test('provider_failure when the creation tx was found but its receipt fetch failed', () => {
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, receiptFetchFailed: true, creationReceiptFound: false,
  }))
  assert.equal(result.finalTypedReason, 'provider_failure')
  assert.equal(result.creationTxHash, CREATION_TX)
})

test('creator_mismatch when the receipt is available but the claimed factory appears nowhere in the creation path', () => {
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: '0x1111111111111111111111111111111111111111',
    receiptFetchFailed: false, creationReceiptFound: true, transactionTo: '0x2222222222222222222222222222222222222222',
    contractAddressFromReceipt: PRODUCTION_POOL, creationLogs: [],
  }))
  assert.equal(result.finalTypedReason, 'creator_mismatch')
  assert.equal(result.claimedFactoryInCreationPath, false)
})

test('creation_receipt_mismatch when the claimed factory is in the path but this exact pool was not created in that receipt', () => {
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, receiptFetchFailed: false,
    creationReceiptFound: true, transactionTo: null, contractAddressFromReceipt: '0x9999999999999999999999999999999999999999',
    creationLogs: [],
  }))
  assert.equal(result.finalTypedReason, 'creation_receipt_mismatch')
  assert.equal(result.claimedFactoryInCreationPath, true)
  assert.equal(result.exactPoolCreated, false)
})

// PRODUCTION FIXTURE SHAPE, DISCLOSED: exactly this task's reported starting state -- no
// PoolCreated topic was ever detected, so even with a real creation receipt in hand, no decodable
// creation event exists to confirm the token pair/fee. Honestly 'trace_unavailable', never a guess.
test('production fixture shape: no PoolCreated log in the creation receipt -- honest trace_unavailable, not a guess', () => {
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, receiptFetchFailed: false,
    creationReceiptFound: true, transactionTo: null, contractAddressFromReceipt: PRODUCTION_POOL, creationLogs: [],
  }))
  assert.equal(result.finalTypedReason, 'trace_unavailable')
  assert.equal(result.claimedFactoryInCreationPath, true)
  assert.equal(result.exactPoolCreated, true)
  assert.equal(result.tokenPairVerified, null)
  assert.equal(result.feeVerified, null)
})

test('creation_receipt_mismatch when a PoolCreated log decodes but its fields do not match the expected pair/fee', () => {
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, receiptFetchFailed: false,
    creationReceiptFound: true, transactionTo: null, contractAddressFromReceipt: PRODUCTION_POOL,
    creationLogs: [poolCreatedLog(0, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, 3000, PRODUCTION_POOL)],
  }))
  assert.equal(result.finalTypedReason, 'creation_receipt_mismatch')
  assert.equal(result.tokenPairVerified, true)
  assert.equal(result.feeVerified, false)
})

test('verified_pool_creation_provenance when every requirement is satisfied: factory in path, exact pool, matching pair and fee', () => {
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, receiptFetchFailed: false,
    creationReceiptFound: true, transactionTo: null, contractAddressFromReceipt: PRODUCTION_POOL,
    creationLogs: [poolCreatedLog(0, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, PRODUCTION_FEE, PRODUCTION_POOL)],
  }))
  assert.equal(result.finalTypedReason, 'verified_pool_creation_provenance')
  assert.equal(result.claimedFactoryInCreationPath, true)
  assert.equal(result.exactPoolCreated, true)
  assert.equal(result.tokenPairVerified, true)
  assert.equal(result.feeVerified, true)
})

test('claimed-factory-in-path is honored via a genuine internal-call trace when available, even without a matching creator', () => {
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: '0x1111111111111111111111111111111111111111',
    creationTraceCalledContracts: [PRODUCTION_CLAIMED_FACTORY], receiptFetchFailed: false,
    creationReceiptFound: true, transactionTo: null, contractAddressFromReceipt: PRODUCTION_POOL,
    creationLogs: [poolCreatedLog(0, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, PRODUCTION_FEE, PRODUCTION_POOL)],
  }))
  assert.equal(result.claimedFactoryInCreationPath, true)
  assert.equal(result.finalTypedReason, 'verified_pool_creation_provenance')
})

test('exactPoolCreated also recognizes the pool as an emitter within the creation receipt, not only as the top-level contractAddress', () => {
  const poolOwnInitLog: RawReceiptLog = { logIndex: 1, address: PRODUCTION_POOL, topics: ['0xdeadbeef'], data: '0x' }
  const result = classifyPoolCreationProvenance(baseInput({
    creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, receiptFetchFailed: false,
    creationReceiptFound: true, transactionTo: PRODUCTION_CLAIMED_FACTORY, contractAddressFromReceipt: null,
    creationLogs: [
      poolCreatedLog(0, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, PRODUCTION_FEE, PRODUCTION_POOL),
      poolOwnInitLog,
    ],
  }))
  assert.equal(result.exactPoolCreated, true)
})

function fakeLookup(result: Awaited<ReturnType<IndexedContractCreationLookup['lookupContractCreation']>>, calls: string[]): IndexedContractCreationLookup {
  return {
    async lookupContractCreation(chain, pool) {
      calls.push(`${chain}:${pool}`)
      return result
    },
  }
}

function fakeReceiptFetcher(outcome: Awaited<ReturnType<PoolCreationReceiptFetcher>>, calls: string[]): PoolCreationReceiptFetcher {
  return async (chain, txHash) => {
    calls.push(`${chain}:${txHash}`)
    return outcome
  }
}

test('bounded calls: exactly one lookup call and one receipt fetch per fresh investigation', async () => {
  const lookupCalls: string[] = []
  const receiptCalls: string[] = []
  const lookup = fakeLookup({ creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, creationTrace: null }, lookupCalls)
  const receiptFetcher = fakeReceiptFetcher(
    { status: 'ok', to: null, contractAddress: PRODUCTION_POOL, logs: [poolCreatedLog(0, PRODUCTION_CLAIMED_FACTORY, WETH, PRODUCTION_TOKEN_X, PRODUCTION_FEE, PRODUCTION_POOL)] },
    receiptCalls,
  )
  const investigator = createPoolCreationProvenanceInvestigator(lookup, receiptFetcher, createPoolCreationProvenanceCache())
  const result = await investigator.investigate({ chain: 'base', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE })
  assert.equal(lookupCalls.length, 1)
  assert.equal(receiptCalls.length, 1)
  assert.equal(result.finalTypedReason, 'verified_pool_creation_provenance')
})

test('permanent cache: investigating the same chain+pool twice only triggers the bounded calls once', async () => {
  const lookupCalls: string[] = []
  const receiptCalls: string[] = []
  const lookup = fakeLookup({ creationTxHash: CREATION_TX, contractCreator: PRODUCTION_CLAIMED_FACTORY, creationTrace: null }, lookupCalls)
  const receiptFetcher = fakeReceiptFetcher(
    { status: 'ok', to: null, contractAddress: PRODUCTION_POOL, logs: [] },
    receiptCalls,
  )
  const cache = createPoolCreationProvenanceCache()
  const investigator = createPoolCreationProvenanceInvestigator(lookup, receiptFetcher, cache)
  const args = { chain: 'base' as const, pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE }
  const r1 = await investigator.investigate(args)
  const r2 = await investigator.investigate(args)
  assert.equal(lookupCalls.length, 1)
  assert.equal(receiptCalls.length, 1)
  assert.deepEqual(r1, r2)
  // The cache is genuinely permanent, not request-scoped -- a fresh investigator sharing the same
  // cache instance still hits it without any new calls.
  const investigator2 = createPoolCreationProvenanceInvestigator(lookup, receiptFetcher, cache)
  await investigator2.investigate(args)
  assert.equal(lookupCalls.length, 1)
  assert.equal(receiptCalls.length, 1)
})

test('no retries: a lookup that throws once is never retried, terminates immediately as provider_failure', async () => {
  const lookupCalls: string[] = []
  const lookup: IndexedContractCreationLookup = {
    async lookupContractCreation(chain, pool) {
      lookupCalls.push(`${chain}:${pool}`)
      throw new Error('provider down')
    },
  }
  const receiptCalls: string[] = []
  const receiptFetcher = fakeReceiptFetcher({ status: 'missing' }, receiptCalls)
  const investigator = createPoolCreationProvenanceInvestigator(lookup, receiptFetcher, createPoolCreationProvenanceCache())
  const result = await investigator.investigate({ chain: 'base', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE })
  assert.equal(lookupCalls.length, 1)
  assert.equal(receiptCalls.length, 0)
  assert.equal(result.finalTypedReason, 'provider_failure')
})

test('different pools are cached and investigated independently, never conflated', async () => {
  const lookupCalls: string[] = []
  const lookup = fakeLookup(null, lookupCalls)
  const receiptCalls: string[] = []
  const receiptFetcher = fakeReceiptFetcher({ status: 'missing' }, receiptCalls)
  const investigator = createPoolCreationProvenanceInvestigator(lookup, receiptFetcher, createPoolCreationProvenanceCache())
  await investigator.investigate({ chain: 'base', pool: PRODUCTION_POOL, claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE })
  await investigator.investigate({ chain: 'base', pool: '0x8888888888888888888888888888888888888888', claimedFactory: PRODUCTION_CLAIMED_FACTORY, expectedToken0: WETH, expectedToken1: PRODUCTION_TOKEN_X, expectedFee: PRODUCTION_FEE })
  assert.equal(lookupCalls.length, 2)
})

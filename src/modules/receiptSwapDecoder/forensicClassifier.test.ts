import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyReceiptForensics, createRecordingPoolValidator, MAX_FORENSIC_SAMPLES } from './forensicClassifier'
import { decodeReceiptSwap } from './index'
import type { PoolValidator } from './poolValidator'
import {
  WALLET, POOL_A, USDC, TOKEN_X, transferLog, classicSwapLog, slipstreamSwapLog, alwaysValidValidator, neverValidValidator,
} from './fixtures.test-helpers'
import { WETH_BASE_ADDRESS } from './signatures'

const WETH = WETH_BASE_ADDRESS.toLowerCase()
const wallet = WALLET.toLowerCase()
const poolA = POOL_A.toLowerCase()
const tokenX = TOKEN_X.toLowerCase()

async function decodeWithRecording(logs: Parameters<typeof decodeReceiptSwap>[0]['logs'], validator: PoolValidator) {
  const recorded: Parameters<typeof classifyReceiptForensics>[0]['factoryValidationAttempts'] = []
  const recordingValidator = createRecordingPoolValidator(validator, recorded)
  const result = await decodeReceiptSwap(
    { chain: 'base', txHash: '0x1', walletAddress: wallet, logs, tokenMeta: { [WETH]: { symbol: 'WETH', decimals: 18 }, [tokenX]: { symbol: 'X', decimals: 18 } } },
    recordingValidator,
  )
  return { result, recorded }
}

test('plain ordinary transfer classifies as ordinary_transfer with zero recognised swap events', async () => {
  const logs = [transferLog(0, TOKEN_X, wallet, poolA, BigInt('1'))]
  const { result, recorded } = await decodeWithRecording(logs, alwaysValidValidator())
  const sample = classifyReceiptForensics({
    txHash: '0x1', candidatePriorityTier: 2, candidatePriorityReason: 'existing_one_leg_swap_candidate',
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  })
  assert.equal(sample.finalRejectionReason, 'plain_transfer_no_swap_event')
  assert.equal(sample.aerodromeSwapEventCount, 0)
  assert.equal(sample.transferCount, 1)
  assert.equal(sample.likelyRoute, 'ordinary_transfer')
  assert.equal(sample.factoryValidationAttempts.length, 0)
  assert.equal(sample.contradiction, null)
})

test('multi-hop-shaped transfers with no swap event classify as aggregator_or_router', async () => {
  const routerA = '0x2222222222222222222222222222222222222222'
  const routerB = '0x9999999999999999999999999999999999999999'
  const logs = [
    transferLog(0, WETH, wallet, routerA, BigInt('1')),
    transferLog(1, TOKEN_X, routerB, wallet, BigInt('500')),
  ]
  const { result, recorded } = await decodeWithRecording(logs, alwaysValidValidator())
  const sample = classifyReceiptForensics({
    txHash: '0x1', candidatePriorityTier: null, candidatePriorityReason: null,
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  })
  assert.equal(sample.likelyRoute, 'aggregator_or_router')
  assert.equal(sample.finalRejectionReason, 'plain_transfer_no_swap_event')
})

test('pool_not_validated_by_factory exposes the exact factory getPool inputs/result and classifies as uniswap_v2_like', async () => {
  const logs = [
    transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
    classicSwapLog(1, poolA, wallet, BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000')),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
  ]
  const { result, recorded } = await decodeWithRecording(logs, neverValidValidator())
  const sample = classifyReceiptForensics({
    txHash: '0x1', candidatePriorityTier: 3, candidatePriorityReason: 'verified_quote_address',
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  })
  assert.equal(sample.finalRejectionReason, 'pool_not_validated_by_factory')
  assert.equal(sample.aerodromeSwapEventCount, 1)
  assert.equal(sample.candidatePoolAddresses.length, 1)
  assert.equal(sample.candidatePoolAddresses[0], poolA)
  assert.equal(sample.factoryValidationAttempts.length, 1)
  assert.equal(sample.factoryValidationAttempts[0].protocol, 'aerodrome_classic')
  assert.equal(sample.factoryValidationAttempts[0].poolAddress, poolA)
  assert.equal(sample.factoryValidationAttempts[0].token0, WETH)
  assert.equal(sample.factoryValidationAttempts[0].token1, tokenX)
  assert.equal(sample.factoryValidationAttempts[0].result, false)
  assert.equal(sample.likelyRoute, 'uniswap_v2_like')
})

test('a validated Aerodrome Classic pool classifies as aerodrome_classic', async () => {
  const logs = [
    transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
    classicSwapLog(1, poolA, wallet, BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000')),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
  ]
  const { result, recorded } = await decodeWithRecording(logs, alwaysValidValidator())
  const sample = classifyReceiptForensics({
    txHash: '0x1', candidatePriorityTier: 2, candidatePriorityReason: 'existing_one_leg_swap_candidate',
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  })
  assert.equal(sample.finalRejectionReason, null)
  assert.equal(sample.likelyRoute, 'aerodrome_classic')
  assert.equal(sample.factoryValidationAttempts[0].result, true)
})

test('contradictory_legs exposes the bounded decoded transfer flow and the exact contradiction', async () => {
  // REVERSED, DISCLOSED (evidence-first PnL completion task, requirement #7 — Aerodrome Slipstream
  // multihop fix): this fixture previously used two IDENTICAL duplicate incoming WETH transfers
  // that happened to sum EXACTLY to the Swap event's own amount — Slipstream now nets same-token
  // multi-transfer legs the same way Classic already does (resolveSlipstreamMultiTransferLeg,
  // aerodromeSlipstreamLeg.ts), so that case now correctly resolves as a real swap instead of
  // contradicting (see index.test.ts's "Slipstream: duplicate identical transfer logs now aggregate
  // successfully" test for that reversal). This fixture is rewritten to a contradiction the netting
  // fix does NOT resolve: two DIFFERENT tokens (WETH, USDC) both transferred into the pool, each
  // independently within tolerance of the Swap event's own incoming amount — genuinely ambiguous
  // WHICH token is the real swap leg, never picked arbitrarily.
  const logs = [
    transferLog(0, WETH, wallet, poolA, BigInt('2000000000000000000')),
    transferLog(1, USDC, wallet, poolA, BigInt('2000000000000000000')), // ambiguous: also matches
    slipstreamSwapLog(2, poolA, wallet, wallet, BigInt('2000000000000000000'), BigInt('-500000000000000000000')),
    transferLog(3, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
  ]
  const { result, recorded } = await decodeWithRecording(logs, alwaysValidValidator())
  const sample = classifyReceiptForensics({
    txHash: '0x1', candidatePriorityTier: 1, candidatePriorityReason: 'could_complete_missing_exit',
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  })
  assert.equal(sample.finalRejectionReason, 'contradictory_legs')
  assert.ok(sample.contradiction)
  assert.equal(sample.contradiction?.poolAddress, poolA)
  assert.equal(sample.contradiction?.incomingTransferCount, 2)
  assert.equal(sample.contradiction?.outgoingTransferCount, 1)
  assert.match(sample.contradiction!.contradiction, /expected exactly 1 incoming transfer/)
  assert.ok(sample.contradiction!.transfers.length <= 10)
  // No factory validation was ever attempted — contradiction is detected before validation runs.
  assert.equal(sample.factoryValidationAttempts.length, 0)
})

test('an unrecognized topic0 is surfaced verbatim, never decoded, bounded to 5 distinct values', async () => {
  const unknownTopics = Array.from({ length: 8 }, (_, i) => `0x${(i + 1).toString().padStart(64, '0')}`)
  const logs = unknownTopics.map((topic, i) => ({ logIndex: i, address: poolA, topics: [topic], data: '0x' }))
  const { result, recorded } = await decodeWithRecording(logs, alwaysValidValidator())
  const sample = classifyReceiptForensics({
    txHash: '0x1', candidatePriorityTier: null, candidatePriorityReason: null,
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  })
  assert.equal(sample.unsupportedSwapLikeTopic0.length, 5)
  for (const t of sample.unsupportedSwapLikeTopic0) assert.ok(unknownTopics.includes(t))
  assert.equal(sample.likelyRoute, 'unknown')
})

test('logCount, uniqueEmitterCount, recognisedTopicCounts, wrapCount and lpEventCount are all reported', async () => {
  const logs = [
    transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
    classicSwapLog(1, poolA, wallet, BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000')),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
  ]
  const { result, recorded } = await decodeWithRecording(logs, alwaysValidValidator())
  const sample = classifyReceiptForensics({
    txHash: '0x1', candidatePriorityTier: 2, candidatePriorityReason: 'existing_one_leg_swap_candidate',
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  })
  assert.equal(sample.logCount, 3)
  assert.equal(sample.uniqueEmitterCount, 3) // WETH, pool, TOKEN_X are 3 distinct emitting addresses
  assert.equal(sample.recognisedTopicCounts.classic_swap, 1)
  assert.equal(sample.recognisedTopicCounts.erc20_transfer, 2)
  assert.equal(sample.wrapCount, 0)
  assert.equal(sample.lpEventCount, 0)
  assert.equal(sample.candidatePriorityTier, 2)
  assert.equal(sample.candidatePriorityReason, 'existing_one_leg_swap_candidate')
})

test('MAX_FORENSIC_SAMPLES is exactly 10, matching the receipt-acquisition cap', () => {
  assert.equal(MAX_FORENSIC_SAMPLES, 10)
})

test('deterministic output: identical input produces an identical classification across repeated calls', async () => {
  const logs = [
    transferLog(0, WETH, wallet, poolA, BigInt('1000000000000000000')),
    classicSwapLog(1, poolA, wallet, BigInt('1000000000000000000'), BigInt('0'), BigInt('0'), BigInt('500000000000000000000')),
    transferLog(2, TOKEN_X, poolA, wallet, BigInt('500000000000000000000')),
  ]
  const { result, recorded } = await decodeWithRecording(logs, alwaysValidValidator())
  const input = {
    txHash: '0x1', candidatePriorityTier: 2, candidatePriorityReason: 'existing_one_leg_swap_candidate',
    logs, decodeResult: result, factoryValidationAttempts: recorded,
  }
  const s1 = classifyReceiptForensics(input)
  const s2 = classifyReceiptForensics(input)
  assert.deepEqual(s1, s2)
})

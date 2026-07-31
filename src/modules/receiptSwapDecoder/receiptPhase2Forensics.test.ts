import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters } from 'viem'
import {
  auditCachedReceipt, clusterReceiptForensics, buildReceiptPhase2ForensicsDiagnostic,
  type CachedReceiptAuditInput,
} from './receiptPhase2Forensics'
import { ERC20_TRANSFER_TOPIC0, CLASSIC_MINT_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, WETH_BASE_ADDRESS } from './signatures'
import type { RawReceiptLog } from './types'

const WALLET = '0x1111111111111111111111111111111111111111'
const POOL = '0x2222222222222222222222222222222222222222'
const ROUTER = '0x3333333333333333333333333333333333333333'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const UNSUPPORTED_TOPIC = '0xdeadbeef00000000000000000000000000000000000000000000000000000000'

function addrTopic(addr: string): string {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}`
}

function transferLog(logIndex: number, token: string, from: string, to: string, value: bigint): RawReceiptLog {
  return {
    logIndex, address: token,
    topics: [ERC20_TRANSFER_TOPIC0, addrTopic(from), addrTopic(to)],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  }
}

function wrapLog(logIndex: number, kind: 'deposit' | 'withdrawal', account: string, amount: bigint): RawReceiptLog {
  return {
    logIndex, address: WETH_BASE_ADDRESS,
    topics: [kind === 'deposit' ? WETH_DEPOSIT_TOPIC0 : WETH_WITHDRAWAL_TOPIC0, addrTopic(account)],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  }
}

function unsupportedLog(logIndex: number, emitter: string): RawReceiptLog {
  return { logIndex, address: emitter, topics: [UNSUPPORTED_TOPIC], data: '0x' }
}

function baseInput(overrides: Partial<CachedReceiptAuditInput> = {}): CachedReceiptAuditInput {
  return {
    chain: 'base',
    txHash: '0x1',
    missingClosedLotSide: 'entry',
    walletLeg: { contract: TOKEN_A, direction: 'outbound', amount: 100 },
    routerOrCounterpartyAddress: null,
    isKnownRouter: false,
    logs: [],
    ...overrides,
  }
}

test('an ordinary single-token transfer with no opposing inflow is classified ordinary_transfer', () => {
  const record = auditCachedReceipt(baseInput({
    logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100))],
  }))
  assert.equal(record.classification, 'ordinary_transfer')
  assert.equal(record.balancedEconomicExchange, false)
})

test('a real two-token exchange (wallet pays token A, receives token B) is a balanced economic exchange', () => {
  const record = auditCachedReceipt(baseInput({
    logs: [
      transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)),
      transferLog(1, TOKEN_B, POOL, WALLET, BigInt(90)),
    ],
  }))
  assert.equal(record.balancedEconomicExchange, true)
  assert.equal(record.walletNetTokenFlows[TOKEN_A.toLowerCase()], '-100')
  assert.equal(record.walletNetTokenFlows[TOKEN_B.toLowerCase()], '90')
})

test('a balanced exchange through a known router touching multiple emitters is classified aggregator_swap', () => {
  const record = auditCachedReceipt(baseInput({
    isKnownRouter: true,
    routerOrCounterpartyAddress: ROUTER,
    logs: [
      transferLog(0, TOKEN_A, WALLET, ROUTER, BigInt(100)),
      transferLog(1, TOKEN_A, ROUTER, POOL, BigInt(100)),
      transferLog(2, TOKEN_B, POOL, WALLET, BigInt(90)),
    ],
  }))
  assert.equal(record.classification, 'aggregator_swap')
})

test('a balanced exchange alongside an unrecognized topic0 at a non-router emitter is unsupported_pool_swap', () => {
  const record = auditCachedReceipt(baseInput({
    logs: [
      transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)),
      unsupportedLog(1, POOL),
      transferLog(2, TOKEN_B, POOL, WALLET, BigInt(90)),
    ],
  }))
  assert.equal(record.classification, 'unsupported_pool_swap')
  assert.deepEqual(record.unsupportedTopicEmitters[UNSUPPORTED_TOPIC], [POOL.toLowerCase()])
})

test('a balanced exchange with no router and no unrecognized topic fails closed to unknown, never guessed', () => {
  const record = auditCachedReceipt(baseInput({
    logs: [
      transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)),
      transferLog(1, TOKEN_B, POOL, WALLET, BigInt(90)),
    ],
  }))
  assert.equal(record.classification, 'unknown')
})

test('wrap-only activity (WETH deposit, no ERC20 transfer) is classified wrap_unwrap_only', () => {
  const record = auditCachedReceipt(baseInput({
    walletLeg: { contract: WETH_BASE_ADDRESS, direction: 'outbound', amount: 1 },
    logs: [wrapLog(0, 'deposit', WALLET, BigInt(1000))],
  }))
  assert.equal(record.classification, 'wrap_unwrap_only')
})

test('an LP mint/burn event is classified liquidity_or_staking regardless of any other signal', () => {
  const record = auditCachedReceipt(baseInput({
    isKnownRouter: true,
    logs: [
      { logIndex: 0, address: POOL, topics: [CLASSIC_MINT_TOPIC0], data: '0x' },
      transferLog(1, TOKEN_A, WALLET, POOL, BigInt(100)),
      transferLog(2, TOKEN_B, POOL, WALLET, BigInt(90)),
    ],
  }))
  assert.equal(record.classification, 'liquidity_or_staking')
})

test('transaction input selector is honestly reported unavailable, never fabricated', () => {
  const record = auditCachedReceipt(baseInput({}))
  assert.equal(record.txInputSelector, null)
  assert.equal(record.txInputSelectorUnavailableReason, 'receipt_logs_do_not_include_calldata')
})

test('the transfer/wrap sequence is ordered by real logIndex, not insertion order', () => {
  const record = auditCachedReceipt(baseInput({
    logs: [
      wrapLog(2, 'withdrawal', WALLET, BigInt(50)),
      transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)),
      wrapLog(1, 'deposit', WALLET, BigInt(1000)),
    ],
  }))
  assert.deepEqual(record.transferFlowSequence.map((s) => s.logIndex), [0, 1, 2])
})

test('unique topic0 counts include every observed topic, known and unsupported alike', () => {
  const record = auditCachedReceipt(baseInput({
    logs: [
      transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)),
      transferLog(1, TOKEN_B, POOL, WALLET, BigInt(90)),
      unsupportedLog(2, POOL),
      unsupportedLog(3, POOL),
    ],
  }))
  assert.equal(record.uniqueTopic0Counts[ERC20_TRANSFER_TOPIC0.toLowerCase()], 2)
  assert.equal(record.uniqueTopic0Counts[UNSUPPORTED_TOPIC], 2)
})

test('a receipt this module cannot anchor to the wallet nets to an empty flow, never a fabricated one', () => {
  const record = auditCachedReceipt(baseInput({
    walletLeg: { contract: TOKEN_A, direction: 'outbound', amount: 100 },
    logs: [transferLog(0, TOKEN_B, ROUTER, POOL, BigInt(50))], // no TOKEN_A transfer at all
  }))
  assert.deepEqual(record.walletNetTokenFlows, {})
  assert.equal(record.balancedEconomicExchange, false)
})

test('clustering groups by router/counterparty, unsupported topic, emitter and transfer-flow fingerprint', () => {
  const records = [
    auditCachedReceipt(baseInput({
      txHash: '0xa', routerOrCounterpartyAddress: ROUTER,
      logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)), unsupportedLog(1, POOL), transferLog(2, TOKEN_B, POOL, WALLET, BigInt(90))],
    })),
    auditCachedReceipt(baseInput({
      txHash: '0xb', routerOrCounterpartyAddress: ROUTER,
      logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(50)), unsupportedLog(1, POOL), transferLog(2, TOKEN_B, POOL, WALLET, BigInt(45))],
    })),
  ]
  const clusters = clusterReceiptForensics(records)
  assert.deepEqual(clusters.byRouterCounterparty[ROUTER.toLowerCase()].sort(), ['0xa', '0xb'])
  assert.deepEqual(clusters.byUnsupportedTopic[UNSUPPORTED_TOPIC].sort(), ['0xa', '0xb'])
  assert.deepEqual(clusters.byEmitter[POOL.toLowerCase()].sort(), ['0xa', '0xb'])
  assert.deepEqual(clusters.byTransferFlowFingerprint[records[0].transferFlowFingerprint].sort(), ['0xa', '0xb'])
})

test('the diagnostic reports classification counts, repeated-only clusters, and honestly empty repeatedSelectors', () => {
  const records = [
    auditCachedReceipt(baseInput({ txHash: '0xa', logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100))] })), // ordinary_transfer
    auditCachedReceipt(baseInput({
      txHash: '0xb',
      logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)), unsupportedLog(1, POOL), transferLog(2, TOKEN_B, POOL, WALLET, BigInt(90))],
    })), // unsupported_pool_swap
    auditCachedReceipt(baseInput({
      txHash: '0xc',
      logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(50)), unsupportedLog(1, POOL), transferLog(2, TOKEN_B, POOL, WALLET, BigInt(45))],
    })), // unsupported_pool_swap, same unsupported topic + emitter repeated
  ]
  const diagnostic = buildReceiptPhase2ForensicsDiagnostic(records)
  assert.equal(diagnostic.receiptsAudited, 3)
  assert.equal(diagnostic.classificationCounts.ordinary_transfer, 1)
  assert.equal(diagnostic.classificationCounts.unsupported_pool_swap, 2)
  assert.deepEqual(diagnostic.repeatedSelectors, {})
  assert.equal(diagnostic.repeatedUnsupportedTopics[UNSUPPORTED_TOPIC], 2)
  assert.equal(diagnostic.repeatedEmitters[POOL.toLowerCase()], 2)
  assert.equal(diagnostic.genuineTransferCount, 1)
  assert.equal(diagnostic.likelyUnsupportedSwapCount, 2)
  assert.ok(diagnostic.candidateDecoderFamilies.some((f) => f.includes(UNSUPPORTED_TOPIC)))
})

test('a decoder family is never proposed from a single occurrence', () => {
  const records = [
    auditCachedReceipt(baseInput({
      txHash: '0xa',
      logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)), unsupportedLog(1, POOL), transferLog(2, TOKEN_B, POOL, WALLET, BigInt(90))],
    })),
  ]
  const diagnostic = buildReceiptPhase2ForensicsDiagnostic(records)
  assert.deepEqual(diagnostic.candidateDecoderFamilies, [])
  assert.deepEqual(diagnostic.repeatedUnsupportedTopics, {})
})

test('a decoder family is never proposed when the repeated topic never co-occurs with a balanced exchange', () => {
  const records = [
    auditCachedReceipt(baseInput({ txHash: '0xa', logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(100)), unsupportedLog(1, POOL)] })), // ordinary_transfer + unsupported topic, no balance
    auditCachedReceipt(baseInput({ txHash: '0xb', logs: [transferLog(0, TOKEN_A, WALLET, POOL, BigInt(50)), unsupportedLog(1, POOL)] })),
  ]
  const diagnostic = buildReceiptPhase2ForensicsDiagnostic(records)
  assert.equal(diagnostic.repeatedUnsupportedTopics[UNSUPPORTED_TOPIC], 2, 'still reported as repeated')
  assert.deepEqual(diagnostic.candidateDecoderFamilies, [], 'but never proposed as decoder work without balanced-exchange evidence')
})

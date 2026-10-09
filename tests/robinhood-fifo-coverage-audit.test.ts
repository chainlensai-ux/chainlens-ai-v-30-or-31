// [robinhood-fifo-coverage-audit] (diagnostic only): why each verified Robinhood sell does / does not close a FIFO
// lot, against the full merged activity set before staged receipt truncation. An inbound transfer is evidence that an
// acquisition candidate exists, never a buy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { robinhoodFifoCoverageAudit, type RhFifoCoverageInput } from '../lib/server/robinhoodFifoCoverageAudit.ts'

const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const NATIVE = '0x0000000000000000000000000000000000000000'
const TOKEN = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5'
const SELL = '0x0d1ec4c6e899efa938dc930c57e605e1ff25c49dc48d51ad76dbcf821bc5f081'
const SELL_RAW = BigInt('182346336691191146625479')
const SELL_TS = 1_790_000_000
const h = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
const sell = { txHash: SELL, timestampSec: SELL_TS, inputToken: TOKEN, outputToken: NATIVE, inputRaw: SELL_RAW, outputRaw: BigInt(355089710063636165) }
const buy = (i: number, raw: bigint, ts = SELL_TS - 1000) => ({ txHash: h(i), timestampSec: ts, inputToken: NATIVE, outputToken: TOKEN, inputRaw: BigInt(1e17), outputRaw: raw })
const inbound = (i: number, raw: bigint | string, tsSec = SELL_TS - 1000, token = TOKEN) => ({ txHash: h(i), timestampMs: tsSec * 1000, token, rawAmount: raw.toString() })

function run(over: Partial<RhFifoCoverageInput> = {}) {
  const input: RhFifoCoverageInput = {
    wallet: WALLET, isQuote: (t) => t.toLowerCase() === NATIVE, swaps: [sell], evidence: [{ swapTxHash: SELL, bothLegsVerified: true }],
    matchedLots: [], inbound: [], candidatePool: [SELL], selectedStage1: [SELL], outcomes: [{ txHash: SELL, receiptFetched: true, rejection: null, swap: sell }],
    tracedTxHashes: new Set([SELL]), recovery: { sellTxHash: SELL, candidatesFound: 0, recoveredBuyCount: 0, classifications: {} }, ...over,
  }
  const r = robinhoodFifoCoverageAudit(input)
  return { row: r.sells[0], summary: r.summary }
}

test('0x0d1ec4 production state: no inbound of the sold token anywhere in activity → no_earlier_inbound_exists', () => {
  const { row, summary } = run()
  assert.equal(row.fifoBlocker, 'no_earlier_inbound_exists')
  assert.deepEqual([row.earlierInboundCandidatesInFullActivity, row.acquisitionRecoveryAttempted, row.acquisitionRecoveryResult], [0, true, 'no_earlier_inbound_of_sold_token'])
  assert.equal(row.sellRaw, SELL_RAW.toString())
  assert.equal(summary.verifiedSellCountWithNoEarlierInboundAtAll, 1)
})

test('earlier inbound exists but its receipt was dropped by the staged budget → earlier_inbound_dropped_by_candidate_budget', () => {
  const { row, summary } = run({ inbound: [inbound(1, SELL_RAW)], candidatePool: [SELL, h(1)] })
  assert.equal(row.fifoBlocker, 'earlier_inbound_dropped_by_candidate_budget')
  assert.deepEqual([row.earlierInboundCandidatesDroppedByBudget, row.earlierInbound[0].lotReason], [1, 'receipt_never_checked_staged_budget'])
  assert.equal(summary.verifiedSellCountBlockedOnlyByCandidateBudget, 1)
})

test('earlier inbound selected but attribution rejected → earlier_inbound_rejected_attribution', () => {
  const { row, summary } = run({
    inbound: [inbound(2, SELL_RAW)], candidatePool: [SELL, h(2)], selectedStage1: [SELL, h(2)],
    outcomes: [{ txHash: SELL, receiptFetched: true, rejection: null, swap: sell }, { txHash: h(2), receiptFetched: true, rejection: 'wallet_not_tx_sender', swap: null }],
  })
  assert.equal(row.fifoBlocker, 'earlier_inbound_rejected_attribution')
  assert.deepEqual([row.earlierInbound[0].stage, row.earlierInbound[0].preTraceClassification, row.earlierInbound[0].lotReason], ['stage1_selected', 'wallet_not_tx_sender', 'attribution_rejected:wallet_not_tx_sender'])
  assert.equal(summary.verifiedSellCountBlockedByAttribution, 1)
})

test('earlier inbound verified as a buy but unpriced → earlier_inbound_unpriced', () => {
  const b = buy(3, SELL_RAW)
  const { row, summary } = run({
    swaps: [sell, b], inbound: [inbound(3, SELL_RAW)], candidatePool: [SELL, h(3)],
    outcomes: [{ txHash: SELL, receiptFetched: true, rejection: null, swap: sell }, { txHash: h(3), receiptFetched: true, rejection: null, swap: b }],
  })
  assert.equal(row.fifoBlocker, 'earlier_inbound_unpriced')
  assert.deepEqual([row.verifiedAcquisitionLots, row.pricedAcquisitionLots, row.earlierInbound[0].pricing], [1, 0, 'unpriced'])
  assert.equal(row.earlierInboundCandidatesInStage2Checked, 1)
  assert.equal(summary.verifiedSellCountBlockedByPricing, 1)
})

test('multiple partial acquisition lots, priced and matched → closed_lot_possible with the exact raw bound', () => {
  const half = SELL_RAW / BigInt(2)
  const b1 = buy(4, half, SELL_TS - 2000)
  const b2 = buy(5, half / BigInt(2), SELL_TS - 1000)
  const { row } = run({
    swaps: [sell, b1, b2], evidence: [{ swapTxHash: SELL, bothLegsVerified: true }, { swapTxHash: h(4), bothLegsVerified: true }, { swapTxHash: h(5), bothLegsVerified: true }],
    matchedLots: [{ openedTxHash: h(4), closedTxHash: SELL, token: TOKEN }, { openedTxHash: h(5), closedTxHash: SELL, token: TOKEN }],
    inbound: [inbound(4, half, SELL_TS - 2000), inbound(5, half / BigInt(2))], candidatePool: [SELL, h(4), h(5)],
  })
  assert.equal(row.fifoBlocker, 'closed_lot_possible')
  assert.deepEqual([row.verifiedAcquisitionLots, row.pricedAcquisitionLots, row.closedLotsForSell], [2, 2, 2])
  assert.equal(row.closedRawPossible, (half + half / BigInt(2)).toString())
})

test('inbound only after the sell → acquisition_after_sell_only', () => {
  const { row } = run({ inbound: [inbound(6, SELL_RAW, SELL_TS + 100)], candidatePool: [SELL, h(6)] })
  assert.equal(row.fifoBlocker, 'acquisition_after_sell_only')
  assert.deepEqual(row.laterInboundTxHashes, [h(6)])
})

test('duplicate activity rows count once', () => {
  const { row } = run({ inbound: [inbound(7, SELL_RAW), inbound(7, SELL_RAW), inbound(7, SELL_RAW)], candidatePool: [SELL, h(7)] })
  assert.equal(row.earlierInboundCandidatesInFullActivity, 1)
  assert.equal(row.inboundRawBeforeSell, SELL_RAW.toString())
})

test('token address normalization: checksummed / upper-case rows match; a different token never does', () => {
  const checksummed = '0xDEE52F2AB639B6942B0D0F0565400B93B7A0FBE5'
  const other = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe6'
  const { row } = run({ inbound: [inbound(8, SELL_RAW, SELL_TS - 10, checksummed), inbound(9, SELL_RAW, SELL_TS - 10, other)], candidatePool: [SELL, h(8), h(9)] })
  assert.deepEqual(row.earlierInboundTxHashes, [h(8)])
})

test('unknown-timestamp inbound only → ambiguous (cannot be ordered against the sell)', () => {
  const { row } = run({ inbound: [{ txHash: h(10), timestampMs: null, token: TOKEN, rawAmount: SELL_RAW.toString() }], candidatePool: [SELL, h(10)] })
  assert.equal(row.fifoBlocker, 'ambiguous')
})

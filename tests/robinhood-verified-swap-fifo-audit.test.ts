// [robinhood-verified-swap-fifo-audit] (observational only): the canonical verified-swap set vs what the REAL FIFO
// builder (buildRobinhoodPnlV1Fifo → fifoEngine) matched, with an independent raw-integer re-run. Each case feeds the
// real engine first, so "actual" below is production behaviour, not a model of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRobinhoodPnlV1Fifo, RH_NATIVE, type RhVerifiedSwap, type RhPriceEvidence } from '../lib/server/robinhoodPnlV1.ts'
import { robinhoodVerifiedSwapFifoAudit } from '../lib/server/robinhoodVerifiedSwapFifoAudit.ts'

const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const TOKEN = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5'
const OTHER_SAME_SYMBOL = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe6'
const SELL_0D1E = '0x0d1ec4c6e899efa938dc930c57e605e1ff25c49dc48d51ad76dbcf821bc5f081'
const E18 = BigInt(10) ** BigInt(18)
const h = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
let blk = 1000
const swap = (txHash: string, ts: number, inputToken: string, outputToken: string, inputRaw: bigint, outputRaw: bigint): RhVerifiedSwap => ({
  txHash, blockNumber: blk++, firstLogIndex: 0, timestampSec: ts, inputToken, outputToken, inputRaw, outputRaw, inputDecimals: 18, outputDecimals: 18, hops: [], intermediary: null,
})
const buy = (i: number, ts: number, raw: bigint, token = TOKEN) => swap(h(i), ts, RH_NATIVE, token, E18 / BigInt(100), raw)
const sell = (txHash: string, ts: number, raw: bigint, token = TOKEN) => swap(txHash, ts, token, RH_NATIVE, raw, E18 / BigInt(50))
const priced = (s: RhVerifiedSwap): RhPriceEvidence => ({ swapTxHash: s.txHash, inputToken: s.inputToken, outputToken: s.outputToken, inputAmount: Number(s.inputRaw) / 1e18, outputAmount: Number(s.outputRaw) / 1e18, inputPriceUsd: 1, outputPriceUsd: 1, inputSource: 'x', outputSource: 'x', bothLegsVerified: true, rejectionReason: null })
const unpriced = (s: RhVerifiedSwap): RhPriceEvidence => ({ ...priced(s), inputPriceUsd: null, bothLegsVerified: false, rejectionReason: 'no_price' })

function run(canonical: RhVerifiedSwap[], evidence: RhPriceEvidence[] = canonical.map(priced), extra: RhVerifiedSwap[] = []) {
  const { fifo } = buildRobinhoodPnlV1Fifo(WALLET, [...canonical, ...extra], evidence)
  const audit = robinhoodVerifiedSwapFifoAudit({
    chain: 'robinhood', isQuote: (t) => t === RH_NATIVE || t === '0x0000000000000000000000000000000000000000', canonicalSwaps: canonical,
    extraSwaps: extra.map((swap) => ({ swap, source: 'acquisition_recovery' })), evidence, matchedLots: fifo.matchedLots,
  })
  return { fifo, ...audit }
}
const rowOf = (rows: ReturnType<typeof run>['rows'], tx: string, side: string) => rows.find((r) => r.txHash === tx && r.side === side)!

test('9 verified buys only → 0 closed lots is correct (no overlap)', () => {
  const nine = Array.from({ length: 9 }, (_, i) => buy(i + 1, 1000 + i, E18, `0x${(0xaa00 + i).toString(16)}${'0'.repeat(36)}`))
  const r = run(nine)
  assert.equal(r.fifo.matchedLots.length, 0)
  assert.deepEqual([r.summary.verifiedSwapCount, r.summary.verifiedBuyCount, r.summary.verifiedSellCount], [9, 9, 0])
  assert.deepEqual([r.summary.definiteFifoDefect, r.summary.conclusion], [false, 'zero_closed_lots_correct_no_overlap'])
  assert.ok(r.rows.every((x) => x.exactFifoBlocker === 'no_later_verified_sell'))
})

test('the 0x0d1ec4 sell with no earlier verified buy → no_earlier_verified_buy, 0 matchable', () => {
  const r = run([sell(SELL_0D1E, 2000, BigInt('182346336691191146625479')), buy(2, 1000, E18, OTHER_SAME_SYMBOL)])
  const s = rowOf(r.rows, SELL_0D1E, 'sell')
  assert.deepEqual([s.exactFifoBlocker, s.matchedRaw, s.earlierVerifiedBuys], ['no_earlier_verified_buy', '0', []])
  assert.equal(r.summary.verifiedSellsWithNoEarlierVerifiedBuy, 1)
  assert.deepEqual(r.summary.theoreticalMatchableRawByToken, {})
})

test('verified buy then later verified sell of the same token → closed lot (engine and simulation agree)', () => {
  const r = run([buy(1, 1000, E18), sell(h(2), 2000, E18)])
  assert.equal(r.fifo.matchedLots.length, 1)
  assert.deepEqual([rowOf(r.rows, h(2), 'sell').exactFifoBlocker, rowOf(r.rows, h(2), 'sell').matchedRaw], ['none', E18.toString()])
  assert.deepEqual([r.summary.definiteFifoDefect, r.summary.conclusion, r.summary.actualVerifiedClosedLotCount], [false, 'closed_lots_exist', 1])
})

test('verified sell before the buy → no close (buy_after_sell)', () => {
  const r = run([sell(h(2), 1000, E18), buy(1, 2000, E18)])
  assert.equal(r.fifo.matchedLots.length, 0)
  assert.equal(rowOf(r.rows, h(2), 'sell').exactFifoBlocker, 'buy_after_sell')
  assert.equal(r.summary.definiteFifoDefect, false)
})

test('partial quantity: buy 1, sell 3 → 1 matched, 2 unmatched (insufficient_verified_buy_quantity)', () => {
  const r = run([buy(1, 1000, E18), sell(h(2), 2000, BigInt(3) * E18)])
  const s = rowOf(r.rows, h(2), 'sell')
  assert.deepEqual([s.matchedRaw, s.unmatchedRaw, s.exactFifoBlocker], [E18.toString(), (BigInt(2) * E18).toString(), 'insufficient_verified_buy_quantity'])
  assert.equal(r.fifo.matchedLots.length, 1)
})

test('multiple buys then one sell: FIFO consumes the oldest first', () => {
  const r = run([buy(1, 1000, E18), buy(2, 1100, E18), sell(h(3), 2000, (E18 * BigInt(3)) / BigInt(2))])
  const s = rowOf(r.rows, h(3), 'sell')
  assert.deepEqual(s.matchedAgainstTxHashes, [h(1), h(2)])
  assert.deepEqual([rowOf(r.rows, h(1), 'buy').openLotRawConsumed, rowOf(r.rows, h(2), 'buy').openLotRawConsumed], [E18.toString(), (E18 / BigInt(2)).toString()])
  assert.equal(r.fifo.matchedLots.length, 2)
})

test('one buy then multiple sells: the second sell finds the lot already consumed', () => {
  const r = run([buy(1, 1000, E18), sell(h(2), 2000, E18), sell(h(3), 3000, E18)])
  assert.deepEqual([rowOf(r.rows, h(2), 'sell').exactFifoBlocker, rowOf(r.rows, h(3), 'sell').exactFifoBlocker], ['none', 'buy_quantity_already_consumed'])
  assert.equal(r.fifo.matchedLots.length, 1)
})

test('same "symbol", different token addresses → never matched', () => {
  const r = run([buy(1, 1000, E18, OTHER_SAME_SYMBOL), sell(h(2), 2000, E18)])
  assert.equal(r.fifo.matchedLots.length, 0)
  assert.equal(rowOf(r.rows, h(2), 'sell').exactFifoBlocker, 'no_earlier_verified_buy')
})

test('checksummed vs lowercase address of the same token → one key, matched by engine and simulation', () => {
  const r = run([buy(1, 1000, E18, '0xDEE52F2AB639B6942B0D0F0565400B93B7A0FBE5'), sell(h(2), 2000, E18)])
  assert.equal(r.fifo.matchedLots.length, 1)
  assert.deepEqual([r.tokens.length, rowOf(r.rows, h(2), 'sell').exactFifoBlocker], [1, 'none'])
})

test('missing pricing but matchable pair → lot exists but unpriced; reported as a pricing gate, not "no lot"', () => {
  const b = buy(1, 1000, E18)
  const s = sell(h(2), 2000, E18)
  const r = run([b, s], [priced(b), unpriced(s)])
  assert.equal(r.fifo.matchedLots.length, 1, 'engine matching ignores pricing')
  assert.equal(r.fifo.matchedLots[0].evidenceQuality, 'unpriced')
  assert.equal(rowOf(r.rows, h(2), 'sell').exactFifoBlocker, 'missing_sell_price')
  assert.deepEqual([r.summary.conclusion, r.summary.verifiedPairsBlockedByPricing], ['closed_lots_exist_but_unpriced', 1])
})

test('verified swap counted but excluded before FIFO (quote ↔ quote) → excluded_by_fifo_source_filter', () => {
  const wrap = swap(h(9), 1000, RH_NATIVE, '0x0000000000000000000000000000000000000000', E18, E18)
  const r = run([wrap, buy(1, 1100, E18)])
  assert.equal(r.rows.find((x) => x.txHash === h(9))!.exactFifoBlocker, 'excluded_by_fifo_source_filter')
  assert.equal(r.summary.verifiedPairsExcludedBeforeFifo, 1)
})

test('a duplicate tx (main lane + recovery) cannot create a duplicate lot', () => {
  const b = buy(1, 1000, E18)
  const s = sell(h(2), 2000, E18)
  const r = run([b, s], [priced(b), priced(s)], [b])
  assert.equal(r.fifo.matchedLots.length, 1)
  assert.ok(r.rows.some((x) => x.exactFifoBlocker === 'duplicate_or_deduped_swap'))
  assert.equal(r.summary.definiteFifoDefect, false)
})

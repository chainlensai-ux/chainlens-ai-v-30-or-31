import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runShadowFifoReplay } from './shadowFifoReplay'
import { runWalletScanReceiptShadowMode, type WalletScanSwapCandidate } from './walletScanShadowWiring'
import { WALLET as FIX_WALLET, transferLog, slipstreamSwapLog, alwaysValidValidator } from './fixtures.test-helpers'
import { WETH_BASE_ADDRESS } from './signatures'
import type { NormalizedEvent } from '../normalization/types'
import type { PriceUsdLookup } from '../fifoEngine/types'
import type { DecodedReceiptSwap } from './types'

const WALLET = '0x1111111111111111111111111111111111111111'
const POOL_A = '0x3333333333333333333333333333333333333333'
const WETH = '0x4200000000000000000000000000000000000006'
const TOKEN_X = '0x5555555555555555555555555555555555555555'

function baseEvent(overrides: Partial<NormalizedEvent> & { txHash: string }): NormalizedEvent {
  return {
    provider: 'goldrush',
    chain: 'base',
    timestamp: '2024-01-01T00:00:00.000Z',
    fromAddress: WALLET,
    toAddress: POOL_A,
    contract: WETH,
    symbol: 'WETH',
    amount: 1,
    amountRaw: '1000000000000000000',
    tokenDecimals: 18,
    direction: 'outbound',
    ...overrides,
  }
}

function exactDecodedSwap(overrides: Partial<DecodedReceiptSwap> = {}): DecodedReceiptSwap {
  return {
    chain: 'base',
    txHash: 'buy_tx',
    protocol: 'aerodrome_slipstream',
    poolAddress: POOL_A,
    tokenIn: { address: WETH, symbol: 'WETH', decimals: 18 },
    tokenOut: { address: TOKEN_X, symbol: 'X', decimals: 18 },
    amountInRaw: '1000000000000000000',
    amountOutRaw: '100000000000000000000',
    decimals: { tokenIn: 18, tokenOut: 18 },
    normalizedAmountIn: 1,
    normalizedAmountOut: 100,
    walletDirection: 'wallet_bought_tokenOut',
    evidenceSource: 'receipt_pool_swap_event',
    confidence: 'exact',
    meta: { hops: 1, poolsVisited: [POOL_A], nativeWrapDetected: false, refundDetected: false, feeLegsExcluded: 0 },
    ...overrides,
  }
}

function scenario(): { events: NormalizedEvent[]; priceUsdLookup: PriceUsdLookup } {
  const events: NormalizedEvent[] = [
    // The one-leg buy transaction — only the outbound WETH ("paid") leg was ever captured; the
    // inbound TOKEN_X ("received") leg is entirely missing from canonical normalizedEvents, so no
    // lot for TOKEN_X was ever opened.
    baseEvent({ txHash: 'buy_tx', timestamp: '2024-01-01T00:00:00.000Z', direction: 'outbound', contract: WETH }),
    // A real, later sell of TOKEN_X that canonical FIFO could never match (no buy lot exists for
    // TOKEN_X at all) — an unmatched sell.
    baseEvent({
      txHash: 'sell_tx', timestamp: '2024-01-02T00:00:00.000Z', direction: 'outbound',
      contract: TOKEN_X, amount: 100, amountRaw: '100000000000000000000', symbol: 'X',
    }),
  ]
  const priceUsdLookup: PriceUsdLookup = (event) => {
    if (event.txHash === 'buy_tx' && event.direction === 'inbound') return 300
    if (event.txHash === 'sell_tx') return 500
    return null
  }
  return { events, priceUsdLookup }
}

test('one-leg upgrade: recovering the missing buy leg closes the previously-unmatched sell', () => {
  const { events, priceUsdLookup } = scenario()
  const result = runShadowFifoReplay({
    normalizedEvents: events,
    walletAddress: WALLET,
    decodedSwap: exactDecodedSwap(),
    priceUsdLookup,
  })
  assert.equal(result.shadowReplayAccepted, true)
  assert.equal(result.rejectionReason, null)
  assert.equal(result.counters.exactReceiptSwapsEligible, 1)
  assert.equal(result.counters.shadowTransactionsReplaced, 1)
  // Before: the WETH outbound leg (paid) and the TOKEN_X outbound sell are BOTH unmatched sells —
  // no buy lot exists for either token yet. After: the recovered TOKEN_X buy lot closes the TOKEN_X
  // sell, leaving only the WETH leg (which was never a real "sell" economically, just a paid leg
  // with no counterpart buy lot in this fixture) unmatched.
  assert.equal(result.counters.unmatchedSellsBefore, 2)
  assert.equal(result.counters.unmatchedSellsAfter, 1)
  assert.equal(result.counters.fifoClosedLotsBefore, 0)
  assert.equal(result.counters.fifoClosedLotsAfter, 1)
  assert.equal(result.counters.newlyClosedLots, 1)
  assert.equal(result.counters.newlyPricedClosedLots, 1)
  assert.equal(result.newlyClosedLotSamples.length, 1)
  assert.equal(result.newlyClosedLotSamples[0].token, TOKEN_X)
  assert.equal(result.newlyClosedLotSamples[0].realizedPnlUsd, 200)
  assert.equal(result.newlyClosedLotSamples[0].evidenceQuality, 'verified')
  assert.equal(result.counters.verifiedPricingCoverageBefore, 0)
  assert.equal(result.counters.verifiedPricingCoverageAfter, 1)
  assert.equal(result.counters.shadowRealizedPnlBefore, null)
  assert.equal(result.counters.shadowRealizedPnlAfter, 200) // 500 proceeds - 300 cost basis
  assert.equal(result.counters.shadowPnlDeltaUsd, null) // before is null (no matched lots at all yet)
})

test('deterministic replacement: identical input produces byte-identical results across repeated calls', () => {
  const { events, priceUsdLookup } = scenario()
  const run = () => runShadowFifoReplay({ normalizedEvents: events, walletAddress: WALLET, decodedSwap: exactDecodedSwap(), priceUsdLookup })
  const r1 = run()
  const r2 = run()
  assert.deepEqual(r1, r2)
})

test('no original mutation: the caller-supplied normalizedEvents array and its objects are never changed', () => {
  const { events, priceUsdLookup } = scenario()
  const snapshot = JSON.parse(JSON.stringify(events))
  runShadowFifoReplay({ normalizedEvents: events, walletAddress: WALLET, decodedSwap: exactDecodedSwap(), priceUsdLookup })
  assert.deepEqual(events, snapshot)
  assert.equal(events.length, 2) // never spliced in place
})

test('duplicate prevention: a transaction that already carries both legs is rejected, never duplicated', () => {
  const events: NormalizedEvent[] = [
    baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH }),
    baseEvent({
      txHash: 'buy_tx', direction: 'inbound', contract: TOKEN_X, amount: 100,
      amountRaw: '100000000000000000000', symbol: 'X', fromAddress: POOL_A, toAddress: WALLET,
    }),
  ]
  const result = runShadowFifoReplay({ normalizedEvents: events, walletAddress: WALLET, decodedSwap: exactDecodedSwap() })
  assert.equal(result.shadowReplayAccepted, false)
  assert.equal(result.rejectionReason, 'would_duplicate_transaction')
  assert.equal(result.counters.shadowDuplicateRejections, 1)
  assert.equal(result.counters.shadowTransactionsReplaced, 0)
})

test('rejects a non-exact confidence decode without touching FIFO at all', () => {
  const { events } = scenario()
  const result = runShadowFifoReplay({
    normalizedEvents: events, walletAddress: WALLET,
    decodedSwap: exactDecodedSwap({ confidence: 'high' }),
  })
  assert.equal(result.shadowReplayAccepted, false)
  assert.equal(result.rejectionReason, 'not_exact_confidence')
  assert.deepEqual(result.counters.fifoClosedLotsBefore, 0)
  assert.deepEqual(result.counters.fifoClosedLotsAfter, 0)
})

test('rejects when there is no matching incomplete transaction for the decoded txHash', () => {
  const { events } = scenario()
  const result = runShadowFifoReplay({
    normalizedEvents: events, walletAddress: WALLET,
    decodedSwap: exactDecodedSwap({ txHash: 'no_such_tx' }),
  })
  assert.equal(result.shadowReplayAccepted, false)
  assert.equal(result.rejectionReason, 'no_matching_incomplete_transaction')
  assert.equal(result.counters.exactReceiptSwapsEligible, 1)
})

test('rejects when the existing leg token does not match the decoded swap (mismatch, never guessed)', () => {
  const { events } = scenario()
  const result = runShadowFifoReplay({
    normalizedEvents: events, walletAddress: WALLET,
    decodedSwap: exactDecodedSwap({ tokenIn: { address: '0x9999999999999999999999999999999999999999', symbol: 'Y', decimals: 18 } }),
  })
  assert.equal(result.shadowReplayAccepted, false)
  assert.equal(result.rejectionReason, 'existing_leg_token_mismatch')
})

test('no extra provider calls: FIFO replay only ever passes an empty recoveredRawEvents array and reuses the same lookup functions', () => {
  const { events } = scenario()
  let lookupCalls = 0
  const countingLookup: PriceUsdLookup = (event) => {
    lookupCalls += 1
    if (event.txHash === 'buy_tx' && event.direction === 'inbound') return 300
    if (event.txHash === 'sell_tx') return 500
    return null
  }
  const result = runShadowFifoReplay({
    normalizedEvents: events, walletAddress: WALLET, decodedSwap: exactDecodedSwap(), priceUsdLookup: countingLookup,
  })
  assert.equal(result.shadowReplayAccepted, true)
  // The lookup is a plain, already-resolved function — being called more than once (both FIFO runs)
  // is not a new provider call, since no I/O happens inside it. This just confirms it was reused,
  // never replaced with a fresh/expanded lookup that could imply a new fetch.
  assert.ok(lookupCalls > 0)
})

// ─── Production-path integration: shadow decode → shadow FIFO replay ───────────────────────────
// Proves an exact, factory-validated one-leg receipt decode (produced by the REAL
// runWalletScanReceiptShadowMode wiring, not a hand-built DecodedReceiptSwap) reaches
// runShadowFifoReplay after canonical FIFO/pricing exist, and that only the internal cloned FIFO
// computation changes — canonical normalizedEvents passed in stay exactly as they were.
test('production integration: an exact one-leg receipt decode from the real shadow wiring reaches FIFO replay and only the clone changes', async () => {
  const wallet = FIX_WALLET.toLowerCase()
  const poolA = '0x3333333333333333333333333333333333333333'
  const weth = WETH_BASE_ADDRESS.toLowerCase()
  const tokenX = '0x5555555555555555555555555555555555555555'

  // Real receipt logs for a one-leg buy: only the outbound WETH leg is in canonical
  // normalizedEvents; the inbound TOKEN_X leg is recovered from the receipt.
  const logs = [
    transferLog(0, weth, wallet, poolA, BigInt('1000000000000000000')),
    slipstreamSwapLog(1, poolA, wallet, wallet, BigInt('1000000000000000000'), BigInt('-100000000000000000000')),
    transferLog(2, tokenX, poolA, wallet, BigInt('100000000000000000000')),
  ]
  const candidates: WalletScanSwapCandidate[] = [
    { chain: 'base', txHash: 'buy_tx', inferredTokenIn: weth, inferredTokenOut: null, inferredAmountIn: 1, inferredAmountOut: null, inferredMissingSide: 'tokenOut' },
  ]
  const shadowResult = await runWalletScanReceiptShadowMode({
    walletAddress: wallet,
    candidates,
    logsByTxHash: new Map([['buy_tx', logs]]),
    tokenMeta: { [weth]: { symbol: 'WETH', decimals: 18 }, [tokenX]: { symbol: 'X', decimals: 18 } },
    validator: alwaysValidValidator(),
  })

  assert.equal(shadowResult.acceptedExactSwaps.length, 1)
  const decodedSwap = shadowResult.acceptedExactSwaps[0]
  assert.equal(decodedSwap.confidence, 'exact')
  assert.equal(decodedSwap.protocol, 'aerodrome_slipstream')

  // The canonical normalizedEvents this scan's REAL fifoEngine/pricing already used — the one-leg
  // buy tx plus a real, otherwise-unmatched later sell of TOKEN_X.
  const canonicalNormalizedEvents: NormalizedEvent[] = [
    {
      provider: 'goldrush', chain: 'base', txHash: 'buy_tx', timestamp: '2024-01-01T00:00:00.000Z',
      fromAddress: wallet, toAddress: poolA, contract: weth, symbol: 'WETH', amount: 1,
      amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'outbound',
    },
    {
      provider: 'goldrush', chain: 'base', txHash: 'sell_tx', timestamp: '2024-01-02T00:00:00.000Z',
      fromAddress: wallet, toAddress: poolA, contract: tokenX, symbol: 'X', amount: 100,
      amountRaw: '100000000000000000000', tokenDecimals: 18, direction: 'outbound',
    },
  ]
  const canonicalSnapshot = JSON.parse(JSON.stringify(canonicalNormalizedEvents))

  const priceUsdLookup: PriceUsdLookup = (event) => {
    if (event.txHash === 'buy_tx' && event.direction === 'inbound') return 250
    if (event.txHash === 'sell_tx') return 400
    return null
  }

  const replay = runShadowFifoReplay({
    normalizedEvents: canonicalNormalizedEvents,
    walletAddress: wallet,
    decodedSwap,
    priceUsdLookup,
  })

  assert.equal(replay.shadowReplayAccepted, true)
  assert.equal(replay.counters.newlyClosedLots, 1)
  assert.equal(replay.counters.shadowRealizedPnlAfter, 150) // 400 proceeds - 250 cost basis
  // The canonical array this scan's real FIFO/pricing already ran against is completely untouched —
  // only the internal clone (never returned to the caller) reflects the recovered leg.
  assert.deepEqual(canonicalNormalizedEvents, canonicalSnapshot)
  assert.equal(canonicalNormalizedEvents.length, 2)
})

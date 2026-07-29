import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promoteVerifiedReceiptSwaps, RECEIPT_EXACT_SWAP_RECOVERY_SOURCE } from './canonicalPromotion'
import type { NormalizedEvent } from '../normalization/types'
import type { DecodedReceiptSwap } from './types'

const WALLET = '0x1111111111111111111111111111111111111111'
const POOL_A = '0x3333333333333333333333333333333333333333'
const POOL_B = '0x4444444444444444444444444444444444444444'
const WETH = '0x4200000000000000000000000000000000000006'
const TOKEN_X = '0x5555555555555555555555555555555555555555'
const TOKEN_Y = '0x6666666666666666666666666666666666666666'

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

function exactSwap(overrides: Partial<DecodedReceiptSwap> = {}): DecodedReceiptSwap {
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

test('promotes a genuinely missing leg, additively, with explicit receipt_exact_swap_recovery source metadata', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()] })

  assert.equal(result.promotedEvents.length, 2)
  assert.equal(result.addedLegs.length, 1)
  assert.equal(result.addedLegs[0].contract, TOKEN_X)
  assert.equal(result.addedLegs[0].direction, 'inbound')
  assert.equal(result.promotions.length, 0 + 1)
  assert.equal(result.promotions[0].source, RECEIPT_EXACT_SWAP_RECOVERY_SOURCE)
  assert.equal(result.promotions[0].source, 'receipt_exact_swap_recovery')
  assert.equal(result.promotions[0].txHash, 'buy_tx')
  assert.equal(result.rejections.length, 0)
  // The original array is never mutated.
  assert.equal(events.length, 1)
})

test('never overwrites or removes the existing leg -- both original and added event survive intact', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH, provider: 'alchemy' })]
  const result = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()] })

  const original = result.promotedEvents.find((e) => e.contract === WETH)
  assert.ok(original)
  assert.equal(original!.direction, 'outbound')
  assert.equal(original!.provider, 'alchemy')
  assert.equal(original!.amount, 1)
})

test('never promotes into a transaction that already has both real legs (already complete)', () => {
  const events: NormalizedEvent[] = [
    baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH }),
    baseEvent({ txHash: 'buy_tx', direction: 'inbound', contract: TOKEN_X, fromAddress: POOL_A, toAddress: WALLET, amount: 100, amountRaw: '100000000000000000000', symbol: 'X' }),
  ]
  const result = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()] })
  assert.equal(result.addedLegs.length, 0)
  assert.equal(result.rejections.length, 1)
  assert.equal(result.rejections[0].reason, 'would_duplicate_transaction')
  assert.equal(result.promotedEvents.length, 2)
})

test('rejects ambiguity: more than one candidate match for the same tx is never guessed at', () => {
  const events: NormalizedEvent[] = [
    baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH }),
    baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: TOKEN_Y }),
    baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH }),
  ]
  const result = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()] })
  assert.equal(result.addedLegs.length, 0)
  assert.equal(result.rejections[0].reason, 'multiple_incomplete_matches_ambiguous')
})

test('rejects a not-exact-confidence decoded swap even if a plausible matching leg exists', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap({ confidence: 'high' })],
  })
  assert.equal(result.addedLegs.length, 0)
  assert.equal(result.rejections[0].reason, 'not_exact_confidence')
})

// UNKNOWN/UNSUPPORTED FACTORY, DISCLOSED: this module never whitelists a protocol tag it doesn't
// recognize -- an accepted swap tagged with any protocol outside the three real, factory-validated
// ones this module explicitly supports is rejected, never promoted, regardless of confidence.
test('unsupported/unknown protocol tags are rejected, never promoted -- the unknown factory is never whitelisted', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET,
    acceptedExactSwaps: [exactSwap({ protocol: 'unknown_concentrated_factory' as unknown as DecodedReceiptSwap['protocol'] })],
  })
  assert.equal(result.addedLegs.length, 0)
  assert.equal(result.rejections[0].reason, 'protocol_not_recognized')
})

test('uniswap_v3 is a supported, promotable protocol', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap({ protocol: 'uniswap_v3' })],
  })
  assert.equal(result.addedLegs.length, 1)
  assert.equal(result.promotions[0].protocol, 'uniswap_v3')
})

test('token mismatch between the existing leg and the decoded swap is rejected, never forced', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: TOKEN_Y })]
  const result = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()] })
  assert.equal(result.addedLegs.length, 0)
  assert.equal(result.rejections[0].reason, 'existing_leg_token_mismatch')
})

test('deterministic dedupe: the same (chain, txHash) appearing twice in acceptedExactSwaps is only ever promoted once', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap(), exactSwap()],
  })
  assert.equal(result.addedLegs.length, 1)
  assert.equal(result.promotions.length, 1)
})

test('deterministic ordering: processing order is independent of acceptedExactSwaps input order', () => {
  const events: NormalizedEvent[] = [
    baseEvent({ txHash: 'aaa_tx', direction: 'outbound', contract: WETH }),
    baseEvent({ txHash: 'zzz_tx', direction: 'outbound', contract: WETH, toAddress: POOL_B }),
  ]
  const swapA = exactSwap({ txHash: 'aaa_tx' })
  const swapZ = exactSwap({ txHash: 'zzz_tx', poolAddress: POOL_B })

  const forward = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [swapA, swapZ] })
  const reversed = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [swapZ, swapA] })

  assert.deepEqual(forward.promotedEvents, reversed.promotedEvents)
  assert.deepEqual(forward.promotions, reversed.promotions)
})

test('multiple distinct transactions can each be promoted independently in one call', () => {
  const events: NormalizedEvent[] = [
    baseEvent({ txHash: 'aaa_tx', direction: 'outbound', contract: WETH }),
    baseEvent({ txHash: 'zzz_tx', direction: 'outbound', contract: WETH, toAddress: POOL_B }),
  ]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET,
    acceptedExactSwaps: [exactSwap({ txHash: 'aaa_tx' }), exactSwap({ txHash: 'zzz_tx', poolAddress: POOL_B })],
  })
  assert.equal(result.addedLegs.length, 2)
  assert.equal(result.promotions.length, 2)
  assert.equal(result.rejections.length, 0)
})

test('a scan with no accepted exact swaps promotes nothing and returns an unchanged-content array', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [] })
  assert.equal(result.addedLegs.length, 0)
  assert.deepEqual(result.promotedEvents, events)
})

// DOUBLE-FILL GUARD, DISCLOSED (audit fix): recoveryPolicy independently recovers missing legs via
// its own historical-page-fetch mechanism, held in a separate array from canonical normalizedEvents
// until fifoEngine's own mergeNormalizedEvents combines them later (an EXACT-field-match dedupe a
// receipt-derived leg could differ from by even one field, e.g. fromAddress). Passing those already-
// recovered events as `recoveredEvents` must prevent this module from proposing the same leg again.
test('never promotes a leg that recoveryPolicy already independently recovered for the same tx (exact-shape match)', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const alreadyRecovered: NormalizedEvent[] = [
    baseEvent({ txHash: 'buy_tx', direction: 'inbound', contract: TOKEN_X, fromAddress: POOL_A, toAddress: WALLET, amount: 100, amountRaw: '100000000000000000000', symbol: 'X' }),
  ]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()], recoveredEvents: alreadyRecovered,
  })
  assert.equal(result.addedLegs.length, 0)
  assert.equal(result.rejections[0].reason, 'would_duplicate_transaction')
  // The canonical array is untouched -- recoveryPolicy's own separate merge (outside this module)
  // is what actually completes this transaction.
  assert.equal(result.promotedEvents.length, 1)
})

test('never promotes a leg that recoveryPolicy already recovered even when its shape differs from what this module would have produced (a genuine double-fill risk without the guard)', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  // Differs from what this module would propose: a router intermediary address instead of the pool,
  // and a slightly different amountRaw -- exactly the "would NOT dedupe via mergeNormalizedEvents's
  // exact-match key" scenario this guard exists for.
  const alreadyRecovered: NormalizedEvent[] = [
    baseEvent({
      txHash: 'buy_tx', direction: 'inbound', contract: TOKEN_X, fromAddress: '0x9999999999999999999999999999999999999999',
      toAddress: WALLET, amount: 99.999, amountRaw: '99999000000000000000', symbol: 'X',
    }),
  ]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()], recoveredEvents: alreadyRecovered,
  })
  assert.equal(result.addedLegs.length, 0)
  assert.ok(['would_duplicate_transaction', 'multiple_incomplete_matches_ambiguous'].includes(result.rejections[0].reason))
})

test('recoveredEvents for a DIFFERENT transaction never blocks promotion of the transaction actually being promoted', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const unrelatedRecovered: NormalizedEvent[] = [
    baseEvent({ txHash: 'other_tx', direction: 'inbound', contract: TOKEN_Y, fromAddress: POOL_B, toAddress: WALLET }),
  ]
  const result = promoteVerifiedReceiptSwaps({
    normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()], recoveredEvents: unrelatedRecovered,
  })
  assert.equal(result.addedLegs.length, 1)
  assert.equal(result.rejections.length, 0)
})

test('omitting recoveredEvents entirely preserves original behavior (backward compatible)', () => {
  const events: NormalizedEvent[] = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = promoteVerifiedReceiptSwaps({ normalizedEvents: events, walletAddress: WALLET, acceptedExactSwaps: [exactSwap()] })
  assert.equal(result.addedLegs.length, 1)
})

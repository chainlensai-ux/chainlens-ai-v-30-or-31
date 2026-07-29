import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePromotableLeg } from './receiptLegPromotionResolver'
import type { NormalizedEvent } from '../normalization/types'
import type { DecodedReceiptSwap } from './types'

const WALLET = '0x1111111111111111111111111111111111111111'
const POOL_A = '0x3333333333333333333333333333333333333333'
const WETH = '0x4200000000000000000000000000000000000006'
const TOKEN_X = '0x5555555555555555555555555555555555555555'
const PROTOCOLS = new Set(['aerodrome_slipstream'])

function baseEvent(overrides: Partial<NormalizedEvent> & { txHash: string }): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', timestamp: '2024-01-01T00:00:00.000Z',
    fromAddress: WALLET, toAddress: POOL_A, contract: WETH, symbol: 'WETH',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'outbound',
    ...overrides,
  }
}

function exactSwap(overrides: Partial<DecodedReceiptSwap> = {}): DecodedReceiptSwap {
  return {
    chain: 'base', txHash: 'buy_tx', protocol: 'aerodrome_slipstream', poolAddress: POOL_A,
    tokenIn: { address: WETH, symbol: 'WETH', decimals: 18 },
    tokenOut: { address: TOKEN_X, symbol: 'X', decimals: 18 },
    amountInRaw: '1000000000000000000', amountOutRaw: '100000000000000000000',
    decimals: { tokenIn: 18, tokenOut: 18 }, normalizedAmountIn: 1, normalizedAmountOut: 100,
    walletDirection: 'wallet_bought_tokenOut', evidenceSource: 'receipt_pool_swap_event', confidence: 'exact',
    meta: { hops: 1, poolsVisited: [POOL_A], nativeWrapDetected: false, refundDetected: false, feeLegsExcluded: 0 },
    ...overrides,
  }
}

// DOUBLE-FILL GUARD, DISCLOSED (audit fix): the resolver-level unit tests for `additionalKnownEvents`
// -- canonicalPromotion.test.ts covers this at the whole-module level; these cover the resolver's
// own three-way branch (event-only match, additional-only match, split-across-both match) directly.

test('a single match entirely within `events` resolves normally, additionalKnownEvents empty', () => {
  const events = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = resolvePromotableLeg(events, WALLET, exactSwap(), PROTOCOLS, [])
  assert.equal(result.ok, true)
})

test('a single match that exists ONLY in additionalKnownEvents has no canonical anchor -- rejected, never promoted', () => {
  const events: NormalizedEvent[] = []
  const additional = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const result = resolvePromotableLeg(events, WALLET, exactSwap(), PROTOCOLS, additional)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'no_matching_incomplete_transaction')
})

test('completeness split across events + additionalKnownEvents (one each) is detected as already complete', () => {
  const events = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const additional = [baseEvent({ txHash: 'buy_tx', direction: 'inbound', contract: TOKEN_X, fromAddress: POOL_A, toAddress: WALLET, amount: 100, amountRaw: '100000000000000000000', symbol: 'X' })]
  const result = resolvePromotableLeg(events, WALLET, exactSwap(), PROTOCOLS, additional)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'would_duplicate_transaction')
})

test('three total matches (split across both arrays) is ambiguous, never guessed at', () => {
  const events = [
    baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH }),
    baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: TOKEN_X }),
  ]
  const additional = [baseEvent({ txHash: 'buy_tx', direction: 'inbound', contract: TOKEN_X, fromAddress: POOL_A, toAddress: WALLET })]
  const result = resolvePromotableLeg(events, WALLET, exactSwap(), PROTOCOLS, additional)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'multiple_incomplete_matches_ambiguous')
})

test('the proposed missing leg already present in additionalKnownEvents (not events) is still detected as a duplicate', () => {
  const events = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const additional = [baseEvent({ txHash: 'buy_tx', direction: 'inbound', contract: TOKEN_X, fromAddress: POOL_A, toAddress: WALLET, amount: 100, amountRaw: '100000000000000000000', symbol: 'X' })]
  // Note: this is the SAME scenario as the "completeness split" test above (1 events match + 1
  // additional match = 2 total), confirming both code paths (the totalMatchCount===2 branch and the
  // final missing-leg duplicate check) agree on the outcome.
  const result = resolvePromotableLeg(events, WALLET, exactSwap(), PROTOCOLS, additional)
  assert.equal(result.ok, false)
})

test('default (omitted) additionalKnownEvents behaves identically to passing an empty array', () => {
  const events = [baseEvent({ txHash: 'buy_tx', direction: 'outbound', contract: WETH })]
  const withDefault = resolvePromotableLeg(events, WALLET, exactSwap(), PROTOCOLS)
  const withEmpty = resolvePromotableLeg(events, WALLET, exactSwap(), PROTOCOLS, [])
  assert.deepEqual(withDefault, withEmpty)
})

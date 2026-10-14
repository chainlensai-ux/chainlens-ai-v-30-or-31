// Payment / proceeds / refund legs are not trades of the quote asset.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBuyPaymentLeg, isQuoteAssetEvent, isQuoteRefundLeg, isSellProceedsLeg } from './tradeLegRole'
import type { NormalizedEvent } from '../modules/normalization/types'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const WETH = '0x4200000000000000000000000000000000000006'
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const TOKEN = '0x' + 'a'.repeat(40)
const ev = (contract: string, direction: 'inbound' | 'outbound'): NormalizedEvent => ({
  provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '2026-10-01T00:00:00Z', fromAddress: '', toAddress: '',
  contract, symbol: '?', amount: 1, amountRaw: '1', tokenDecimals: 18, direction,
})

test('quote assets: verified stablecoins, canonical WETH, native ETH — not arbitrary tokens', () => {
  for (const c of [USDC, WETH, ETH]) assert.equal(isQuoteAssetEvent({ chain: 'base', contract: c }), true)
  assert.equal(isQuoteAssetEvent({ chain: 'base', contract: TOKEN }), false)
})

test('buy: USDC/ETH paid for a token is a payment, not a sell', () => {
  const pay = ev(USDC, 'outbound'), got = ev(TOKEN, 'inbound')
  assert.equal(isBuyPaymentLeg(pay, [pay, got]), true)
  assert.equal(isBuyPaymentLeg(ev(ETH, 'outbound'), [ev(ETH, 'outbound'), got]), true)
  assert.equal(isBuyPaymentLeg(ev(TOKEN, 'outbound'), [ev(TOKEN, 'outbound'), ev(USDC, 'inbound')]), false, 'selling a token is still a sell')
})

test('sell: USDC/ETH received for a token is proceeds, not a buy', () => {
  const proceeds = ev(ETH, 'inbound'), sold = ev(TOKEN, 'outbound')
  assert.equal(isSellProceedsLeg(proceeds, [proceeds, sold]), true)
  assert.equal(isSellProceedsLeg(ev(TOKEN, 'inbound'), [ev(TOKEN, 'inbound'), ev(USDC, 'outbound')]), false, 'buying a token is still a buy')
})

test('refund: ETH handed back in a tx that also paid ETH is not a buy of ETH', () => {
  const paid = ev(ETH, 'outbound'), refund = ev(ETH, 'inbound'), got = ev(TOKEN, 'inbound')
  assert.equal(isQuoteRefundLeg(refund, [paid, refund, got]), true)
  assert.equal(isQuoteRefundLeg(ev(ETH, 'inbound'), [ev(ETH, 'inbound')]), false)
})

// End to end through the buy/sell timelines.
import { buildTimelines } from '../modules/timelineBuilder/index'
import type { ChainSelectionResult } from '../modules/chainSelection/types'
const active = { chains: [{ chain: 'base', status: 'active_intelligence', gates: { valueGate: true, activityGate: true, swapGate: true } }], activeChainCount: 1, dustChainCount: 0 } as unknown as ChainSelectionResult
const tx = (hash: string, contract: string, direction: 'inbound' | 'outbound'): NormalizedEvent => ({ ...ev(contract, direction), txHash: hash })

test('timelines: buy with USDC = 1 buy, 0 sells; token→ETH sell (ETH now fetched) = 1 sell, 0 buys', () => {
  const t = buildTimelines([
    tx('0xbuy', USDC, 'outbound'), tx('0xbuy', TOKEN, 'inbound'),
    tx('0xsell', TOKEN, 'outbound'), tx('0xsell', ETH, 'inbound'),
  ], active)
  assert.deepEqual(t.buyTimeline.entries.map(e => [e.txHash, e.token]), [['0xbuy', TOKEN]])
  assert.deepEqual(t.sellTimeline.entries.map(e => [e.txHash, e.token]), [['0xsell', TOKEN]])
})

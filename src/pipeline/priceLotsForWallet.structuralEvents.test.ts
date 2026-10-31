// The historical pricing pass prices the lots the real FIFO run builds, not every raw event: airdrops,
// address-poisoning spoofs, stablecoins and liquidity legs never take a price lookup. Live shape: the
// pricing pre-pass matched 238 "closed lots" (175 of them USDC, plus airdrop→spoof pairs of spam
// tokens) while FIFO matched 63, so spam tokens and USDC took the scheduler's lookup slots.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet'
import { selectFifoTradeEvents } from './index'
import type { NormalizedEvent } from '../modules/normalization/types'

const WALLET = '0x30ec8aea2ab3d5000da703912193294a81430cc8'
const ROUTER = '0xf5cf170523aaaaaaaaaaaaaaaaaaaaaaaaaa7244'
const LOOKALIKE_1 = '0xf5cf24bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb7244'
const LOOKALIKE_2 = '0xf5cf1fcccccccccccccccccccccccccccccc7244'
const REAL = '0x3333333333333333333333333333333333333333'
const SPAM_1 = '0x1111111111111111111111111111111111111111'
const SPAM_2 = '0x2222222222222222222222222222222222222222'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: ROUTER, toAddress: WALLET, contract: REAL, symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function fixture() {
  const realBuy = event({ txHash: '0xrealbuy', contract: REAL, amount: 5, timestamp: '2026-01-01T00:00:00.000Z' })
  const usdcPaid = event({ txHash: '0xrealbuy', contract: USDC_BASE, amount: 100, direction: 'outbound', fromAddress: WALLET, toAddress: ROUTER, timestamp: '2026-01-01T00:00:00.000Z' })
  const realSell = event({ txHash: '0xrealsell', contract: REAL, amount: 5, direction: 'outbound', fromAddress: WALLET, toAddress: ROUTER, timestamp: '2026-01-03T00:00:00.000Z' })
  const usdcReceived = event({ txHash: '0xrealsell', contract: USDC_BASE, amount: 120, timestamp: '2026-01-03T00:00:00.000Z' })
  const airdrop1 = event({ txHash: '0xair1', contract: SPAM_1, amount: 4615.521096, fromAddress: '0x9999999999999999999999999999999999999999', timestamp: '2026-01-02T00:00:00.000Z' })
  const airdrop2 = event({ txHash: '0xair2', contract: SPAM_2, amount: 4615.521096, fromAddress: '0x9999999999999999999999999999999999999999', timestamp: '2026-01-02T00:00:00.000Z' })
  const spoof1 = event({ txHash: '0xspoof1', contract: SPAM_1, amount: 4615.521096, direction: 'outbound', fromAddress: WALLET, toAddress: LOOKALIKE_1, timestamp: '2026-01-04T00:00:00.000Z' })
  const spoof2 = event({ txHash: '0xspoof2', contract: SPAM_2, amount: 4615.521096, direction: 'outbound', fromAddress: WALLET, toAddress: LOOKALIKE_2, timestamp: '2026-01-04T00:00:00.000Z' })
  return { realBuy, usdcPaid, realSell, usdcReceived, airdrop1, airdrop2, spoof1, spoof2, all: [realBuy, usdcPaid, realSell, usdcReceived, airdrop1, airdrop2, spoof1, spoof2] }
}

test('selectFifoTradeEvents keeps genuine trade legs and drops spoofs, stablecoins and liquidity legs', () => {
  const f = fixture()
  const selected = selectFifoTradeEvents(f.all, [], new Set())
  const kept = new Set(selected.normalizedEvents)
  assert.ok(kept.has(f.realBuy) && kept.has(f.realSell), 'the real trade stays')
  assert.ok(!kept.has(f.spoof1) && !kept.has(f.spoof2), 'poisoning spoofs are not trades')
  assert.ok(!kept.has(f.usdcPaid) && !kept.has(f.usdcReceived), 'stablecoins are cash, not lots')

  const withLiquidity = selectFifoTradeEvents(f.all, [f.realBuy], new Set(['base:0xrealbuy']))
  assert.ok(!withLiquidity.normalizedEvents.includes(f.realBuy), 'a liquidity tx leg never enters FIFO')
  assert.equal(withLiquidity.recoveredEvents.length, 0, 'recovered events follow the same liquidity and stablecoin rules')
})

test('the pricing pass only requests prices for lots FIFO builds when given the FIFO input set', async () => {
  const f = fixture()
  const requested: string[] = []
  const recordingSource = (token: string, _chain: string, timestamp: number) => { requested.push(`${token.toLowerCase()}@${timestamp}`); return null }
  const spoofAt = Date.parse(f.spoof1.timestamp)
  const spoofSideRequested = () => requested.some((r) => r === `${SPAM_1}@${spoofAt}` || r === `${SPAM_2}@${spoofAt}`)
  const tokenRequested = (token: string) => requested.some((r) => r.startsWith(`${token}@`))

  await priceLotsForWallet({
    normalizedEvents: f.all,
    recoveredEvents: [],
    structuralEvents: selectFifoTradeEvents(f.all, [], new Set()),
    priceSources: { primary: recordingSource, fallback: () => null },
  })
  assert.ok(tokenRequested(REAL), 'the real token is still priced')
  assert.ok(!spoofSideRequested(), 'a poisoning spoof is not a sell, so it takes no lookup')
  assert.ok(!tokenRequested(USDC_BASE), 'USDC takes no lookup')
  // The junk airdrop is still an open buy in the real FIFO run, so it keeps its own (open-lot) side.

  // Omitted = every event is a requirement (callers that never wired it are unchanged).
  requested.length = 0
  await priceLotsForWallet({
    normalizedEvents: f.all,
    recoveredEvents: [],
    priceSources: { primary: recordingSource, fallback: () => null },
  })
  assert.ok(spoofSideRequested(), 'without the FIFO input set the spoof is priced as a sell')
  assert.ok(tokenRequested(USDC_BASE), 'and USDC is priced as a traded token')
})

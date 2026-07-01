import assert from 'node:assert/strict'
import { buildBuyTimeline } from '../lib/server/buyTimeline.ts'

const WALLET = '0x30ec8aea2ab3d5000da703912193294a81430cc8'
const walletLower = WALLET.toLowerCase()

// GoldRush-only input (no Alchemy events at all) must reconstruct BUYs correctly and never
// require Alchemy data to be present.
const goldrushOnlyEvents = [
  { provider: 'goldrush', event: { txHash: '0xgr1', timestamp: '2026-02-01T00:00:00.000Z', fromAddress: '0xrouterA', toAddress: walletLower, contract: '0xaaa', symbol: 'AAA', amount: 10, amountRaw: '10000000000000000000', chain: 'base', direction: 'buy' } },
  { provider: 'goldrush', event: { txHash: '0xgr2', timestamp: '2026-02-02T00:00:00.000Z', fromAddress: '0xrouterB', toAddress: walletLower, contract: '0xbbb', symbol: 'BBB', amount: 20, amountRaw: '20000000000000000000', chain: 'base', direction: 'buy' } },
  // A same-tx GoldRush outbound leg for AAA's tx (pairing signal only, not required for BUY).
  { provider: 'goldrush', event: { txHash: '0xgr1', timestamp: '2026-02-01T00:00:00.000Z', fromAddress: walletLower, toAddress: '0xrouterA', contract: '0xusdc', symbol: 'USDC', amount: 5, amountRaw: '5000000', chain: 'base', direction: 'sell' } },
]

const result = buildBuyTimeline(goldrushOnlyEvents, WALLET)
assert.equal(result.totalBuys, 2, 'GoldRush-only input reconstructs both real buys')
assert.ok(result.buys.every(b => b.provider === 'goldrush'), 'every reconstructed buy is tagged goldrush when input is GoldRush-only')
assert.equal(result.buys[0].pairedWithSameTxOutbound, true, 'same-tx GoldRush sell leg is surfaced as pairing context')
assert.equal(result.buys[1].pairedWithSameTxOutbound, false)

// A GoldRush unknown-direction (pool-internal/third-party) leg must never be promoted, even with
// no Alchemy data available to cross-check against — this is the exact "router unknown" case that
// caused the swap-detection collapse, and buyTimeline must not silently invent a wallet BUY for it.
const withUnknownLeg = buildBuyTimeline([
  ...goldrushOnlyEvents,
  { provider: 'goldrush', event: { txHash: '0xgr3', timestamp: '2026-02-03T00:00:00.000Z', fromAddress: '0xpoolA', toAddress: '0xpoolB', contract: '0xccc', symbol: 'CCC', amount: 1, amountRaw: '1', chain: 'base', direction: 'unknown' } },
], WALLET)
assert.equal(withUnknownLeg.totalBuys, 2, 'GoldRush unknown-direction legs are never promoted to BUYs')

console.log('test-buy-timeline-goldrush-only: all assertions passed')

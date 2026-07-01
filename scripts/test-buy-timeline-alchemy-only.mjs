import assert from 'node:assert/strict'
import { buildBuyTimeline } from '../lib/server/buyTimeline.ts'

const WALLET = '0x30ec8aea2ab3d5000da703912193294a81430cc8'
const walletLower = WALLET.toLowerCase()

// Alchemy-only input (no GoldRush events at all) must reconstruct BUYs correctly. Alchemy's own
// direction is assigned by which query batch a transfer came from (toAddress batch -> buy), which
// is exactly the "inbound ERC20 Transfer event to walletAddress" rule.
const alchemyOnlyEvents = [
  { provider: 'alchemy', event: { txHash: '0xal1', timestamp: '2026-03-01T00:00:00.000Z', fromAddress: '0xrouterA', toAddress: walletLower, contract: '0xaaa', symbol: 'AAA', amount: 15, amountRaw: '15000000000000000000', chain: 'base', direction: 'buy' } },
  { provider: 'alchemy', event: { txHash: '0xal2', timestamp: '2026-03-02T00:00:00.000Z', fromAddress: '0xrouterB', toAddress: walletLower, contract: '0xbbb', symbol: 'BBB', amount: 25, amountRaw: '25000000000000000000', chain: 'base', direction: 'buy' } },
]

const result = buildBuyTimeline(alchemyOnlyEvents, WALLET)
assert.equal(result.totalBuys, 2, 'Alchemy-only input reconstructs both real buys')
assert.ok(result.buys.every(b => b.provider === 'alchemy'), 'every reconstructed buy is tagged alchemy when input is Alchemy-only')

// An Alchemy outbound transfer (fromAddress === wallet, the "sell batch") must never be counted
// as a BUY, mirroring fetchAlchemyPnlEvents' own from-batch -> sell / to-batch -> buy split.
const withOutbound = buildBuyTimeline([
  ...alchemyOnlyEvents,
  { provider: 'alchemy', event: { txHash: '0xal3', timestamp: '2026-03-03T00:00:00.000Z', fromAddress: walletLower, toAddress: '0xrouterC', contract: '0xccc', symbol: 'CCC', amount: 5, amountRaw: '5000000000000000000', chain: 'base', direction: 'sell' } },
], WALLET)
assert.equal(withOutbound.totalBuys, 2, 'Alchemy outbound (sell-batch) transfers are never counted as BUYs')

// Cross-chain: an Alchemy ETH-mainnet buy must retain its own chain tag, not default to base.
const ethBuy = buildBuyTimeline([
  { provider: 'alchemy', event: { txHash: '0xal4', timestamp: '2026-03-04T00:00:00.000Z', fromAddress: '0xrouterD', toAddress: walletLower, contract: '0xddd', symbol: 'DDD', amount: 1, amountRaw: '1000000000000000000', chain: 'eth', direction: 'buy' } },
], WALLET)
assert.equal(ethBuy.buys[0].chain, 'eth', 'chain tag is preserved as reported by the provider, not hardcoded')

console.log('test-buy-timeline-alchemy-only: all assertions passed')

import assert from 'node:assert/strict'
import { buildBuyTimeline } from '../lib/server/buyTimeline.ts'

const WALLET = '0x30ec8aea2ab3d5000da703912193294a81430cc8'
const walletLower = WALLET.toLowerCase()

function goldrushBuy(overrides) {
  return {
    provider: 'goldrush',
    event: {
      txHash: '0xtx1', timestamp: '2026-01-01T00:00:00.000Z',
      fromAddress: '0xrouter', toAddress: walletLower,
      contract: '0xaaa', symbol: 'AAA', amount: 100, amountRaw: '100000000000000000000',
      chain: 'base', direction: 'buy',
      ...overrides,
    },
  }
}

function alchemyBuy(overrides) {
  return {
    provider: 'alchemy',
    event: {
      txHash: '0xtx2', timestamp: '2026-01-02T00:00:00.000Z',
      fromAddress: '0xrouter', toAddress: walletLower,
      contract: '0xbbb', symbol: 'BBB', amount: 50, amountRaw: '50000000000000000000',
      chain: 'base', direction: 'buy',
      ...overrides,
    },
  }
}

// Basic: one GoldRush buy + one Alchemy buy, sorted chronologically, totalBuys correct.
{
  const result = buildBuyTimeline([goldrushBuy(), alchemyBuy()], WALLET)
  assert.equal(result.totalBuys, 2)
  assert.equal(result.buys.length, 2)
  assert.equal(result.buys[0].provider, 'goldrush')
  assert.equal(result.buys[1].provider, 'alchemy')
  assert.ok(result.buys[0].timestamp < result.buys[1].timestamp, 'buys are sorted chronologically')
  assert.equal(result.buys[0].token, 'AAA')
  assert.equal(result.buys[0].chain, 'base')
}

// Sell events (direction === 'sell') must never be counted as BUYs.
{
  const result = buildBuyTimeline([
    goldrushBuy(),
    { provider: 'goldrush', event: { txHash: '0xtx3', timestamp: '2026-01-03T00:00:00.000Z', fromAddress: walletLower, toAddress: '0xrouter', contract: '0xccc', symbol: 'CCC', amount: 10, amountRaw: '10', chain: 'base', direction: 'sell' } },
  ], WALLET)
  assert.equal(result.totalBuys, 1, 'sell-direction events must never be classified as BUYs')
}

// Unknown-direction events must never be promoted to BUYs (never invented evidence).
{
  const result = buildBuyTimeline([
    { provider: 'goldrush', event: { txHash: '0xtx4', timestamp: '2026-01-04T00:00:00.000Z', fromAddress: '0xpoolA', toAddress: '0xpoolB', contract: '0xddd', symbol: 'DDD', amount: 10, amountRaw: '10', chain: 'base', direction: 'unknown' } },
  ], WALLET)
  assert.equal(result.totalBuys, 0, 'unknown-direction (non-wallet-side) events must never become BUYs')
}

// A missing timestamp or non-0x contract must be skipped, not crash or fabricate a row.
{
  const result = buildBuyTimeline([
    goldrushBuy({ timestamp: null }),
    goldrushBuy({ contract: 'not-an-address' }),
  ], WALLET)
  assert.equal(result.totalBuys, 0, 'events missing a usable timestamp or contract are skipped')
}

// Duplicate events (same tx/contract/amount/provider) must be deduped.
{
  const result = buildBuyTimeline([goldrushBuy(), goldrushBuy()], WALLET)
  assert.equal(result.totalBuys, 1, 'duplicate buy events are deduped')
}

// pairedWithSameTxOutbound is informational only — never gates promotion either way.
{
  const paired = buildBuyTimeline([
    goldrushBuy({ txHash: '0xpair' }),
    { provider: 'goldrush', event: { txHash: '0xpair', timestamp: '2026-01-01T00:00:00.000Z', fromAddress: walletLower, toAddress: '0xrouter', contract: '0xeee', symbol: 'EEE', amount: 5, amountRaw: '5', chain: 'base', direction: 'sell' } },
  ], WALLET)
  assert.equal(paired.totalBuys, 1)
  assert.equal(paired.buys[0].pairedWithSameTxOutbound, true, 'same-tx outbound leg is surfaced as informational pairing context')

  const unpaired = buildBuyTimeline([goldrushBuy({ txHash: '0xsolo' })], WALLET)
  assert.equal(unpaired.buys[0].pairedWithSameTxOutbound, false)
}

// Summary shape sanity.
{
  const result = buildBuyTimeline([goldrushBuy(), alchemyBuy()], WALLET)
  assert.equal(result.summary.firstBuyAt, result.buys[0].timestamp)
  assert.equal(result.summary.lastBuyAt, result.buys[1].timestamp)
  assert.ok(result.summary.mostActivePeriod)
  assert.ok(Array.isArray(result.summary.topAcquiredTokens))
  assert.equal(typeof result.summary.acquisitionVelocity, 'number')
}

// Empty input never crashes, produces an honest empty summary.
{
  const result = buildBuyTimeline([], WALLET)
  assert.equal(result.totalBuys, 0)
  assert.deepEqual(result.summary, { firstBuyAt: null, lastBuyAt: null, mostActivePeriod: null, topAcquiredTokens: [], acquisitionVelocity: null })
}

console.log('test-buy-timeline-basic: all assertions passed')

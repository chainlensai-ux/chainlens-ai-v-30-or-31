// Tests for lib/engine/modules/behavior/computeBehavior.ts. Uses node:test, same convention as the
// other module test files this session. NOT wired into `npm test` (which runs a single hardcoded
// file — see package.json). Run directly with:
//   npx tsx --test lib/engine/modules/behavior/computeBehavior.test.ts
//
// BRIDGE/FARMING TEST SCOPE, DISCLOSED: per computeBehavior.ts's own header, bridgingBehavior/
// farmingBehavior always resolve to "none" (a real, structural gap — this function's own
// task-specified signature never receives a walletAddress, so real bridge/LP counts cannot be
// fetched). No test asserts a non-"none" value for either field, since that would require
// fabricating data this function cannot actually produce given its real signature.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeBehavior } from './computeBehavior'
import type { PnlV2 } from '../pnl/types'
import type { Portfolio } from '../portfolio/types'
import type { ChainActivityRecord } from '../activity/types'
import type { PricedHolding } from '../pricing/types'
import type { ParsedTrade } from '../pnl/types'
import type { RiskV2 } from '../risk/types'
import type { PersonalityV2 } from '../personality/types'

function pnl(overrides: Partial<PnlV2>): PnlV2 {
  return { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [], ...overrides }
}
function portfolio(overrides: Partial<Portfolio>): Portfolio {
  return { totalValueUsd: 1000, categories: [], chains: [], topHoldings: [], stablecoinRatio: 0, concentrationIndex: 0, ...overrides }
}
function risk(overrides: Partial<RiskV2>): RiskV2 {
  return { score: 0, level: 'low', concentrationRisk: 0, stablecoinRatio: 0, unrealizedPnlPressure: 0, chainRisk: 0, volatileExposure: 0, fragmentationRisk: 0, ...overrides }
}
function personality(overrides: Partial<PersonalityV2>): PersonalityV2 {
  return {
    archetype: 'General User', riskAppetite: 'low', tradingStyle: 'passive', chainPreference: null,
    volatilityTolerance: 0, stabilityPreference: 0, pnlBehavior: 'neutral', activityConsistency: 'dormant',
    summary: '', ...overrides,
  }
}
function trade(overrides: Partial<ParsedTrade>): ParsedTrade {
  return { tokenAddress: '0xa', chainId: 1, type: 'buy', quantity: 1, valueUsd: 100, timestamp: 1000, ...overrides }
}
function priced(overrides: Partial<PricedHolding>): PricedHolding {
  return { chainId: 1, tokenAddress: '0xtoken', symbol: 'TOKEN', decimals: 18, quantity: '1', priceUsd: 1, valueUsd: 1, classification: 'other', ...overrides }
}
const NO_ACTIVITY: ChainActivityRecord[] = []

describe('computeBehavior', () => {
  it('empty trades -> behaviorStatus "empty", accumulationStyle "neutral"', async () => {
    const result = await computeBehavior(pnl({}), portfolio({}), NO_ACTIVITY, [], [], [], risk({}), personality({}))
    assert.equal(result.behaviorStatus, 'empty')
    assert.equal(result.behaviorV2.accumulationStyle, 'neutral')
  })

  it('accumulator: net buys > net sells -> accumulationStyle "accumulator"', async () => {
    const trades: ParsedTrade[] = [trade({ type: 'buy', quantity: 5 }), trade({ type: 'sell', quantity: 2 })]
    const result = await computeBehavior(pnl({}), portfolio({}), NO_ACTIVITY, [], [], trades, risk({}), personality({}))
    assert.equal(result.behaviorV2.accumulationStyle, 'accumulator')
  })

  it('distributor: net sells > net buys -> accumulationStyle "distributor"', async () => {
    const trades: ParsedTrade[] = [trade({ type: 'buy', quantity: 2 }), trade({ type: 'sell', quantity: 5 })]
    const result = await computeBehavior(pnl({}), portfolio({}), NO_ACTIVITY, [], [], trades, risk({}), personality({}))
    assert.equal(result.behaviorV2.accumulationStyle, 'distributor')
  })

  it('meme-active: meme tokens > 20% of portfolio -> memeBehavior "meme-active"', async () => {
    const holdings: PricedHolding[] = [
      priced({ tokenAddress: '0xmeme', classification: 'meme', valueUsd: 300 }),
      priced({ tokenAddress: '0xother', classification: 'other', valueUsd: 700 }),
    ]
    const trades: ParsedTrade[] = [trade({})]
    const result = await computeBehavior(pnl({}), portfolio({ totalValueUsd: 1000 }), NO_ACTIVITY, holdings, [], trades, risk({}), personality({}))
    assert.equal(result.behaviorV2.memeBehavior, 'meme-active')
  })

  it('bridge-heavy / LP farmer: honestly "none" (real structural gap — see file header)', async () => {
    // computeBehavior cannot fetch real bridge/LP counts without a wallet address, which its own
    // task-specified signature never receives — asserting the real, honest output rather than a
    // fabricated "bridge-heavy"/"farmer" this function cannot actually produce.
    const trades: ParsedTrade[] = [trade({})]
    const result = await computeBehavior(pnl({}), portfolio({}), NO_ACTIVITY, [], [], trades, risk({}), personality({}))
    assert.equal(result.behaviorV2.bridgingBehavior, 'none')
    assert.equal(result.behaviorV2.farmingBehavior, 'none')
  })

  it('rotation detection: sell A + buy B within 24h -> rotationStyle "rotating"', async () => {
    const trades: ParsedTrade[] = [
      trade({ tokenAddress: '0xa', type: 'sell', timestamp: 1_000_000 }),
      trade({ tokenAddress: '0xb', type: 'buy', timestamp: 1_000_000 + 3600 }), // 1h later, same day
    ]
    const result = await computeBehavior(pnl({}), portfolio({}), NO_ACTIVITY, [], [], trades, risk({}), personality({}))
    assert.equal(result.behaviorV2.rotationStyle, 'rotating')
  })

  it('inactive: no buys/sells at all in the last 30 days -> rotationStyle "inactive"', async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60 // 40 days ago
    const trades: ParsedTrade[] = [trade({ tokenAddress: '0xa', type: 'buy', timestamp: oldTimestamp })]
    const result = await computeBehavior(pnl({}), portfolio({}), NO_ACTIVITY, [], [], trades, risk({}), personality({}))
    assert.equal(result.behaviorV2.rotationStyle, 'inactive') // no activity in the last 30 days at all
  })

  it('holding: a >30-day-old buy with no sell, but SOME unrelated recent trade -> rotationStyle "holding"', async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 40 * 24 * 60 * 60 // 40 days ago, never sold
    const recentTimestamp = Math.floor(Date.now() / 1000) - 24 * 60 * 60 // 1 day ago
    const trades: ParsedTrade[] = [
      trade({ tokenAddress: '0xa', type: 'buy', timestamp: oldTimestamp }),
      trade({ tokenAddress: '0xa', type: 'buy', timestamp: recentTimestamp }), // keeps recentActivity true, same token, no sell anywhere
    ]
    const result = await computeBehavior(pnl({}), portfolio({}), NO_ACTIVITY, [], [], trades, risk({}), personality({}))
    assert.equal(result.behaviorV2.rotationStyle, 'holding')
  })
})

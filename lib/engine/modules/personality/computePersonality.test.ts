// Tests for lib/engine/modules/personality/computePersonality.ts. Uses node:test, same convention
// as the other module test files this session. NOT wired into `npm test` (which runs a single
// hardcoded file — see package.json). Run directly with:
//   npx tsx --test lib/engine/modules/personality/computePersonality.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePersonality } from './computePersonality'
import type { Portfolio } from '../portfolio/types'
import type { PnlV2 } from '../pnl/types'
import type { ChainActivityRecord } from '../activity/types'
import type { RiskV2 } from '../risk/types'
import type { PricedHolding } from '../pricing/types'

function portfolio(overrides: Partial<Portfolio>): Portfolio {
  return { totalValueUsd: 1000, categories: [], chains: [], topHoldings: [], stablecoinRatio: 0, concentrationIndex: 0, ...overrides }
}
function pnl(overrides: Partial<PnlV2>): PnlV2 {
  return { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [], ...overrides }
}
function activity(overrides: Partial<ChainActivityRecord>): ChainActivityRecord {
  return { chainId: 1, lastActiveAt: null, activityLevel: 'low', primaryUse: 'other', txCount30d: 0, valueHeldUsd: 0, valueMovedUsd30d: 0, ...overrides }
}
function risk(overrides: Partial<RiskV2>): RiskV2 {
  return { score: 0, level: 'low', concentrationRisk: 0, stablecoinRatio: 0, unrealizedPnlPressure: 0, chainRisk: 0, volatileExposure: 0, fragmentationRisk: 0, ...overrides }
}
function priced(overrides: Partial<PricedHolding>): PricedHolding {
  return { chainId: 1, tokenAddress: '0xtoken', symbol: 'TOKEN', decimals: 18, quantity: '1', priceUsd: 1, valueUsd: 1, classification: 'other', ...overrides }
}

describe('computePersonality', () => {
  it('empty portfolio -> personalityStatus "empty", archetype "Unknown"', async () => {
    const result = await computePersonality(portfolio({ totalValueUsd: 0 }), pnl({}), [], risk({}), [], [])
    assert.equal(result.personalityStatus, 'empty')
    assert.equal(result.personalityV2.archetype, 'Unknown')
  })

  it('Degen Trader: volatilityTolerance > 0.6 + tradingStyle "active" -> archetype "Degen Trader"', async () => {
    const result = await computePersonality(
      portfolio({ totalValueUsd: 1000 }),
      pnl({}),
      [activity({ chainId: 1, txCount30d: 35, activityLevel: 'high' })],
      risk({ volatileExposure: 0.7, level: 'high' }),
      [priced({})],
      [],
    )
    assert.equal(result.personalityV2.tradingStyle, 'active')
    assert.equal(result.personalityV2.volatilityTolerance, 0.7)
    assert.equal(result.personalityV2.archetype, 'Degen Trader')
  })

  it('Stable Farmer: stablecoinRatio > 0.6 + riskAppetite "low" -> archetype "Stable Farmer"', async () => {
    const result = await computePersonality(
      portfolio({ totalValueUsd: 1000, stablecoinRatio: 0.8 }),
      pnl({}),
      [activity({ chainId: 1, txCount30d: 1, activityLevel: 'low' })],
      risk({ level: 'low', volatileExposure: 0.1 }),
      [priced({})],
      [],
    )
    assert.equal(result.personalityV2.stabilityPreference, 0.8)
    assert.equal(result.personalityV2.riskAppetite, 'low')
    assert.equal(result.personalityV2.archetype, 'Stable Farmer')
  })

  it('Base Native Trader: chainPreference = 8453 + pnlBehavior "profit-seeking" -> archetype "Base Native Trader"', async () => {
    const result = await computePersonality(
      portfolio({ totalValueUsd: 1000, stablecoinRatio: 0.5, concentrationIndex: 0.5 }), // avoid Diversified Holder match
      pnl({ realizedPnlUsd: 500 }),
      [activity({ chainId: 8453, valueHeldUsd: 1000, txCount30d: 2 })],
      risk({ level: 'medium', volatileExposure: 0.3, concentrationRisk: 0.5 }), // avoid Degen/Stable/Diversified matches
      [priced({ chainId: 8453 })],
      [],
    )
    assert.equal(result.personalityV2.chainPreference, 8453)
    assert.equal(result.personalityV2.pnlBehavior, 'profit-seeking')
    assert.equal(result.personalityV2.archetype, 'Base Native Trader')
  })

  it('activity consistency: high -> "consistent", medium -> "sporadic", low/dust-only -> "dormant"', async () => {
    const consistent = await computePersonality(
      portfolio({ totalValueUsd: 1000 }), pnl({}), [activity({ activityLevel: 'high' })], risk({}), [priced({})], [],
    )
    assert.equal(consistent.personalityV2.activityConsistency, 'consistent')

    const sporadic = await computePersonality(
      portfolio({ totalValueUsd: 1000 }), pnl({}), [activity({ activityLevel: 'medium' })], risk({}), [priced({})], [],
    )
    assert.equal(sporadic.personalityV2.activityConsistency, 'sporadic')

    const dormant = await computePersonality(
      portfolio({ totalValueUsd: 1000 }), pnl({}), [activity({ activityLevel: 'low' }), activity({ chainId: 8453, activityLevel: 'dust-only' })], risk({}), [priced({})], [],
    )
    assert.equal(dormant.personalityV2.activityConsistency, 'dormant')
  })

  it('personalityStatus "ok" when all holdings priced; "partial" with a null-priced holding', async () => {
    const ok = await computePersonality(portfolio({ totalValueUsd: 1000 }), pnl({}), [], risk({}), [priced({})], [])
    assert.equal(ok.personalityStatus, 'ok')

    const partial = await computePersonality(
      portfolio({ totalValueUsd: 1000 }), pnl({}), [], risk({}),
      [priced({}), priced({ tokenAddress: '0xunpriced', priceUsd: null, valueUsd: null })], [],
    )
    assert.equal(partial.personalityStatus, 'partial')
  })
})

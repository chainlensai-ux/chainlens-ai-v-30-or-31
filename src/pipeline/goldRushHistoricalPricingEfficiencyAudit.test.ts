import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildGoldRushHistoricalPricingEfficiencyAudit, planUnheldOpenBuySkip } from './goldRushHistoricalPricingEfficiencyAudit'

describe('buildGoldRushHistoricalPricingEfficiencyAudit', () => {
  it('reports unheld-open-buy waste only when the cheaper strategy was not applied', () => {
    const shadowOnly = buildGoldRushHistoricalPricingEfficiencyAudit({
      liveHistoricalGoldrushCalls: 40,
      liveCurrentPriceGoldrushCalls: 2,
      uniqueTokenTimestampRequests: 30,
      duplicateRequestsEliminated: 12,
      negativeCacheHitsAvoided: 8,
      acceptedEvidenceSidesSkipped: 5,
      cheaperStrategy: {
        strategy: 'skip_unheld_open_buys',
        realizedPnlIdentity: 'structurally_identical',
        closedLotSidesRetained: 10,
        heldOpenBuysRetained: 3,
        unheldOpenBuysWouldSkip: 20,
        enabled: false,
        applied: false,
      },
    })
    assert.equal(shadowOnly.liveCallsForUnheldOpenBuys, 20)
    assert.equal(shadowOnly.liveCallsThatCouldAffectRealized, 40)
    assert.equal(shadowOnly.cheaperStrategy.realizedPnlIdentity, 'structurally_identical')

    const applied = buildGoldRushHistoricalPricingEfficiencyAudit({
      liveHistoricalGoldrushCalls: 20,
      liveCurrentPriceGoldrushCalls: 2,
      uniqueTokenTimestampRequests: 10,
      duplicateRequestsEliminated: 12,
      negativeCacheHitsAvoided: 8,
      acceptedEvidenceSidesSkipped: 5,
      cheaperStrategy: {
        strategy: 'skip_unheld_open_buys',
        realizedPnlIdentity: 'structurally_identical',
        closedLotSidesRetained: 10,
        heldOpenBuysRetained: 3,
        unheldOpenBuysWouldSkip: 20,
        enabled: true,
        applied: true,
      },
    })
    assert.equal(applied.liveCallsForUnheldOpenBuys, 0)
    assert.equal(applied.acceptedEvidenceSidesSkipped, 5)
  })
})

describe('planUnheldOpenBuySkip — cheaper strategy is structurally identical for realized PnL', () => {
  const closedBuy = { chain: 'base', txHash: '0xclosedbuy', contract: '0xclosed' }
  const closedSell = { chain: 'base', txHash: '0xclosedsell', contract: '0xclosed' }
  const unheldOpenBuy = { chain: 'base', txHash: '0xunheldbuy', contract: '0xunheld' }
  const heldOpenBuy = { chain: 'base', txHash: '0xheldbuy', contract: '0xheld' }
  const matchedLotSideKeys = new Set([
    'base:0xclosedbuy:entry',
    'base:0xclosedsell:exit',
  ])
  const canonicalHoldingKeys = new Set(['base:0xheld'])

  it('never removes a closed-lot side, only unmatched buys whose token is not held', () => {
    const { cheaperStrategy, buyIndexesToRemove } = planUnheldOpenBuySkip({
      buys: [closedBuy, unheldOpenBuy, heldOpenBuy],
      sells: [closedSell],
      matchedLotSideKeys,
      canonicalHoldingKeys,
    })
    assert.equal(cheaperStrategy.realizedPnlIdentity, 'structurally_identical')
    assert.equal(cheaperStrategy.applied, true)
    assert.equal(cheaperStrategy.closedLotSidesRetained, 2)
    assert.equal(cheaperStrategy.heldOpenBuysRetained, 1)
    assert.equal(cheaperStrategy.unheldOpenBuysWouldSkip, 1)
    assert.deepEqual(buyIndexesToRemove, [1], 'only the unheld open buy index is removed')
  })

  it('shadow/off path reports the same skip set but removes nothing', () => {
    const { cheaperStrategy, buyIndexesToRemove } = planUnheldOpenBuySkip({
      buys: [closedBuy, unheldOpenBuy, heldOpenBuy],
      sells: [closedSell],
      matchedLotSideKeys,
      canonicalHoldingKeys,
      skipUnheldOpenBuys: false,
    })
    assert.equal(cheaperStrategy.applied, false)
    assert.equal(cheaperStrategy.unheldOpenBuysWouldSkip, 1)
    assert.deepEqual(buyIndexesToRemove, [])
  })

  it('without canonicalHoldingKeys, nothing is skipped (byte-identical to prior scans)', () => {
    const { cheaperStrategy, buyIndexesToRemove } = planUnheldOpenBuySkip({
      buys: [unheldOpenBuy],
      sells: [],
      matchedLotSideKeys: new Set(),
    })
    assert.equal(cheaperStrategy.applied, false)
    assert.equal(cheaperStrategy.enabled, false)
    assert.deepEqual(buyIndexesToRemove, [])
  })
})

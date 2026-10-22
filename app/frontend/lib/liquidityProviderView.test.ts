// npx tsx --test app/frontend/lib/liquidityProviderView.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildLiquidityProviderView } from './liquidityProviderView'
import { emptyLpPositionsSummary } from '../../../src/lib/walletLpPositions'

const activity = (lpStrategyWallet: boolean) => ({
  lpStrategyWallet, liquidityAddTxs: 1606, liquidityRemoveTxs: 1993, zapDepositTxs: 900, zapWithdrawTxs: 300,
  totalTxs: 5714, liquidityTxShare: 0.63, liquidityTokens: [],
})

describe('buildLiquidityProviderView', () => {
  it('hidden for a trader with no open positions', () => {
    assert.equal(buildLiquidityProviderView(activity(false), emptyLpPositionsSummary('ok', null), 1000), null)
  })

  it('adds valued positions to the wallet total', () => {
    const positions = { ...emptyLpPositionsSummary('ok', null), openPositions: 2, pricedPositions: 2, totalValueUsd: 12500 }
    const view = buildLiquidityProviderView(activity(true), positions, 40351.16)!
    assert.equal(view.positionsValueUsd, 12500)
    assert.equal(view.totalWithPositionsUsd, 52851.16)
    assert.equal(view.liquiditySharePct, 63)
    assert.equal(view.positionsNote, null)
  })

  it('never shows $0 positions or a combined total when positions could not be read', () => {
    const view = buildLiquidityProviderView(activity(true), emptyLpPositionsSummary('unavailable', 'position_discovery_failed'), 40351.16)!
    assert.equal(view.positionsValueUsd, null)
    assert.equal(view.totalWithPositionsUsd, null)
    assert.match(view.positionsNote!, /could not be read/)
  })

  it('says how many positions are unvalued', () => {
    const positions = { ...emptyLpPositionsSummary('partial', 'some_positions_unpriced'), openPositions: 3, pricedPositions: 2, totalValueUsd: 900 }
    assert.match(buildLiquidityProviderView(activity(true), positions, 100)!.positionsNote!, /1 of 3 positions/)
  })
})

it('a budget-stopped read says how many positions were checked, not "no open positions"', () => {
  const view = buildLiquidityProviderView(
    { lpStrategyWallet: true, liquidityAddTxs: 2017, liquidityRemoveTxs: 2260, zapDepositTxs: 409, zapWithdrawTxs: 272, totalTxs: 5734, liquidityTxShare: 0.746, liquidityTokens: [] },
    { ...emptyLpPositionsSummary('partial', 'position_reads_stopped_by_budget'), mintsFound: 177, positionsChecked: 30, burnedPositions: 30 },
    32325.8,
  )
  assert.match(view!.positionsNote!, /newest 30 of 177/)
})

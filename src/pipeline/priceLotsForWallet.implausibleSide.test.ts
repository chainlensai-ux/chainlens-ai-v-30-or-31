// Per-trade side totals beyond any real DEX trade are dropped before they can complete a lot.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dropImplausibleTradeSideTotals, MAX_PLAUSIBLE_TRADE_SIDE_USD } from './priceLotsForWallet.ts'

describe('dropImplausibleTradeSideTotals', () => {
  it('removes a unit-error side value and keeps real ones, reporting the token that owned it', () => {
    const values = {
      costUsd: { '0xbuy': 250, '0xhuge': 8.7569e17 } as Record<string, number | null>,
      proceedsUsd: { '0xsell': 1_200_000, '0xinf': Number.POSITIVE_INFINITY, '0xnull': null } as Record<string, number | null>,
    }
    const owners = { cost: new Map([['0xhuge', '0xtoken']]), proceeds: new Map<string, string>() }
    const dropped = dropImplausibleTradeSideTotals(values, owners)
    assert.deepEqual(dropped.map((d) => [d.side, d.txHash, d.token]), [['entry', '0xhuge', '0xtoken'], ['exit', '0xinf', null]])
    assert.deepEqual(values.costUsd, { '0xbuy': 250 })
    assert.deepEqual(values.proceedsUsd, { '0xsell': 1_200_000, '0xnull': null })
  })

  it('keeps a side exactly at the ceiling', () => {
    const values = { costUsd: { '0xa': MAX_PLAUSIBLE_TRADE_SIDE_USD }, proceedsUsd: {} }
    assert.equal(dropImplausibleTradeSideTotals(values).length, 0)
  })
})

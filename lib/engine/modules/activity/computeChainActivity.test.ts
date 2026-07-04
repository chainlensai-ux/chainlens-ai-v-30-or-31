// Tests for lib/engine/modules/activity/computeChainActivity.ts.
//
// TESTING DEVIATION, DISCLOSED: computeChainActivity's own public signature (as specified) takes
// only `walletAddress` for tx/bridge/LP signal data — it fetches those itself internally via real
// network-backed functions (fetchRawEventsForChain, buildTradesWithIntentForChain,
// normalizeEvents/buildBridgeDetectionObject). This sandbox has no provider keys configured
// (confirmed throughout this session), so those internal fetches always resolve to empty/degraded
// real results here — there is no way to drive txCount30d/bridgeTxCount/lpEventCount to a specific
// non-zero value through the public function alone without live provider data. Per this session's
// established pattern (see lib/engine/modules/pricing/fetchPricing.ts's own testing-seam
// disclosure), the internal pure helper functions this module already needs to compose its output
// (`activityLevelFor`, `primaryUseFor`) are exported for direct, deterministic unit testing of the
// exact rules the task specifies — the task's own "txCount30d = X -> activityLevel = Y" and
// "majority Z -> primaryUse" cases are pure classification rules with no network dependency, and
// are tested as such. The public `computeChainActivity` itself is also tested end-to-end for its
// real, honest degraded behavior (empty case) — not skipped.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeChainActivity, activityLevelFor, primaryUseFor } from './computeChainActivity'
import type { ChainHolding } from '../holdings/types'
import type { Portfolio } from '../portfolio/types'
import type { PnlV2 } from '../pnl/types'

const EMPTY_PORTFOLIO: Portfolio = {
  totalValueUsd: 0,
  categories: [],
  chains: [],
  topHoldings: [],
  stablecoinRatio: 0,
  concentrationIndex: 0,
}
const EMPTY_PNL: PnlV2 = { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [] }

describe('computeChainActivity (end-to-end, no provider keys in this environment)', () => {
  it('no trades, no txs (real degraded network result) -> chainActivityStatus "empty"', async () => {
    const result = await computeChainActivity('0xf85679316f1c3998c6387f6f707b31aeeb3a9abe', [], [], [], EMPTY_PORTFOLIO, EMPTY_PNL)
    assert.equal(result.chainActivityStatus, 'empty')
    assert.equal(result.chainActivityV2.length, 2) // chainId 1 and 8453, both real, both zero here
    for (const record of result.chainActivityV2) {
      assert.equal(record.txCount30d, 0)
      assert.equal(record.activityLevel, 'dust-only')
    }
  })
})

describe('activityLevelFor (pure classification rule, per the task\'s own thresholds)', () => {
  it('txCount30d = 3 -> "low"', () => {
    assert.equal(activityLevelFor(3, 0), 'low')
  })
  it('txCount30d = 15 -> "medium"', () => {
    assert.equal(activityLevelFor(15, 0), 'medium')
  })
  it('txCount30d = 60 -> "high"', () => {
    assert.equal(activityLevelFor(60, 0), 'high')
  })
  it('txCount30d = 0, valueMovedUsd30d = 0 -> "dust-only"', () => {
    assert.equal(activityLevelFor(0, 0), 'dust-only')
  })
  it('valueMovedUsd30d alone can also drive the tier (>= 10,000 -> high)', () => {
    assert.equal(activityLevelFor(0, 10_000), 'high')
  })
})

function holding(overrides: Partial<ChainHolding>): ChainHolding {
  return {
    chainId: 1,
    tokenAddress: '0xtoken',
    symbol: 'TOKEN',
    decimals: 18,
    quantity: '1',
    lastActivityAt: null,
    classification: 'other',
    ...overrides,
  }
}

describe('primaryUseFor (pure classification rule)', () => {
  it('majority trades -> "trading"', () => {
    const result = primaryUseFor({
      tradeCount: 8,
      bridgeTxCount: 0,
      lpEventCount: 0,
      totalClassifiedEventCount: 10,
      chainHoldings: [holding({})],
      valueHeldUsd: 100,
      stableValueUsd: 0,
    })
    assert.equal(result, 'trading')
  })

  it('majority bridge txs -> "bridging"', () => {
    const result = primaryUseFor({
      tradeCount: 1,
      bridgeTxCount: 9,
      lpEventCount: 0,
      totalClassifiedEventCount: 10,
      chainHoldings: [holding({})],
      valueHeldUsd: 100,
      stableValueUsd: 0,
    })
    assert.equal(result, 'bridging')
  })

  it('majority LP events -> "farming"', () => {
    const result = primaryUseFor({
      tradeCount: 1,
      bridgeTxCount: 0,
      lpEventCount: 9,
      totalClassifiedEventCount: 10,
      chainHoldings: [holding({})],
      valueHeldUsd: 100,
      stableValueUsd: 0,
    })
    assert.equal(result, 'farming')
  })

  it('majority meme holdings -> "memecoins"', () => {
    const result = primaryUseFor({
      tradeCount: 0,
      bridgeTxCount: 0,
      lpEventCount: 0,
      totalClassifiedEventCount: 0,
      chainHoldings: [holding({ classification: 'meme' }), holding({ classification: 'meme' }), holding({ classification: 'other' })],
      valueHeldUsd: 100,
      stableValueUsd: 0,
    })
    assert.equal(result, 'memecoins')
  })

  it('majority value in stablecoins -> "stable-routing"', () => {
    const result = primaryUseFor({
      tradeCount: 0,
      bridgeTxCount: 0,
      lpEventCount: 0,
      totalClassifiedEventCount: 0,
      chainHoldings: [holding({})],
      valueHeldUsd: 100,
      stableValueUsd: 80,
    })
    assert.equal(result, 'stable-routing')
  })

  it('no majority signal at all -> "other"', () => {
    const result = primaryUseFor({
      tradeCount: 0,
      bridgeTxCount: 0,
      lpEventCount: 0,
      totalClassifiedEventCount: 0,
      chainHoldings: [holding({})],
      valueHeldUsd: 100,
      stableValueUsd: 0,
    })
    assert.equal(result, 'other')
  })
})

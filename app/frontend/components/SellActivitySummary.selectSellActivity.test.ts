// Direct test for SellActivitySummary.tsx's selectSellActivity adapter. Uses node:test, same
// convention as the other component test files this session. Run directly with:
//   npx tsx --test app/frontend/components/SellActivitySummary.selectSellActivity.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectSellActivity } from './SellActivitySummary'
import type { SellTimelineResult, SellTimelineEntry } from '@/src/modules/sellTimeline/types'
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'

function entry(overrides: Partial<SellTimelineEntry>): SellTimelineEntry {
  return {
    timestamp: 1_700_000_000_000,
    chain: 'base',
    token: '0xtoken',
    symbol: 'PEPE',
    amount: '1000',
    proceedsUsdEstimate: 50,
    matchedBuyLotId: null,
    confidence: 'high',
    txHash: '0xtx',
    chainSelectionRef: { status: 'active_intelligence', gatesPassed: [] },
    counterparty: '0xrouter',
    ...overrides,
  }
}

function timeline(entries: SellTimelineEntry[]): SellTimelineResult {
  return { totalSells: entries.length, chainContext: { includedChains: [], excludedChains: [] }, entries }
}

function pnlV2(overrides: Partial<PnlV2>): PnlV2 {
  return { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [], ...overrides }
}

describe('selectSellActivity — Profit Skill unlock', () => {
  it('total sells == 0 -> locked, no unlock regardless of pnlV2', () => {
    const result = selectSellActivity(timeline([]), pnlV2({ realizedPnlUsd: 500 }))
    assert.equal(result.totalSells, 0)
    assert.equal(result.profitSkillUnlocked, false)
  })

  it('total sells > 0 but pnlV2 has no realizedPnlUsd number -> still locked (no number to back the claim)', () => {
    const result = selectSellActivity(timeline([entry({})]), { ...pnlV2({}), realizedPnlUsd: null as unknown as number })
    assert.equal(result.profitSkillUnlocked, false)
  })

  it('total sells > 5 and pnlV2 has a real realizedPnlUsd -> unlocked, verified sample (not limited)', () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry({ txHash: `0xtx${i}` }))
    const result = selectSellActivity(timeline(entries), pnlV2({ realizedPnlUsd: 1234 }), 'ok')
    assert.equal(result.totalSells, 6)
    assert.equal(result.profitSkillUnlocked, true)
    assert.equal(result.showLimitedLabel, false)
  })

  it('caller omits pnlV2 entirely -> falls back to totalSells-only unlock rule (no fabricated default)', () => {
    const result = selectSellActivity(timeline([entry({})]))
    assert.equal(result.profitSkillUnlocked, true)
  })

  it('real backend publicPnlStatus != "ok" always shows the limited label, even with a large sample', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ txHash: `0xtx${i}` }))
    const result = selectSellActivity(timeline(entries), pnlV2({ realizedPnlUsd: 1 }), 'limited_verified_sample')
    assert.equal(result.showLimitedLabel, true)
  })
})

describe('selectSellActivity — proceeds/top-tokens', () => {
  it('never fabricates a price — proceeds omitted when no entry has a proceedsUsdEstimate', () => {
    const result = selectSellActivity(timeline([entry({ proceedsUsdEstimate: null })]))
    assert.equal(result.hasAnyProceeds, false)
    assert.equal(result.totalProceedsUsd, 0)
  })

  it('sums only the real, non-null proceedsUsdEstimate values', () => {
    const result = selectSellActivity(timeline([entry({ proceedsUsdEstimate: 50 }), entry({ proceedsUsdEstimate: null, txHash: '0xtx2' }), entry({ proceedsUsdEstimate: 25, txHash: '0xtx3' })]))
    assert.equal(result.hasAnyProceeds, true)
    assert.equal(result.totalProceedsUsd, 75)
  })
})

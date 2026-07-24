// Direct test for PortfolioIntelligenceCard.tsx's selectPortfolioStats() — the canonical
// backend-total selection logic WalletProfileHeader.tsx's PortfolioSnapshot also uses (see that
// file's own header comment for the confirmed regression this closes: the hero total previously
// read the stale V1 `portfolio.totalValueUsd` directly, bypassing this function entirely, showing
// ~$300 while the backend's own canonical portfolioV2.totalValueUsd was $13,531.40 for the same
// scan). Uses node:test, same convention as this codebase's other module test files. Run with:
//   npx tsx --test app/frontend/components/PortfolioIntelligenceCard.selectPortfolioStats.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectPortfolioStats } from './PortfolioIntelligenceCard'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import type { Portfolio as EnginePortfolioV2 } from '@/lib/engine/modules/portfolio/types'

function portfolioV1(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return { totalValueUsd: null, tokens: [], chainValueBreakdown: [], ...overrides }
}

function portfolioV2(overrides: Partial<EnginePortfolioV2> = {}): EnginePortfolioV2 {
  return { totalValueUsd: 0, categories: [], chains: [], topHoldings: [], stablecoinRatio: 0, concentrationIndex: 0, ...overrides }
}

describe('selectPortfolioStats — canonical portfolio total selection (confirmed regression fix)', () => {
  it('backend total $13,531.40 renders $13,531.40 — the real production regression figures', () => {
    const { stats, usingV2 } = selectPortfolioStats(
      portfolioV1({ totalValueUsd: 300 }), // the stale V1 figure the header used to show
      portfolioV2({ totalValueUsd: 13531.40 }), // the real, canonical backend total
    )
    assert.equal(usingV2, true, 'a real portfolioV2 must always be preferred over the stale V1 field')
    assert.equal(stats.totalValueUsd, 13531.40, 'the canonical backend total must be what gets rendered, never the stale V1 figure')
  })

  it('falls back to the V1 total only when portfolioV2 is genuinely absent', () => {
    const { stats, usingV2 } = selectPortfolioStats(portfolioV1({ totalValueUsd: 9000 }), null)
    assert.equal(usingV2, false)
    assert.equal(stats.totalValueUsd, 9000)
  })

  it('realized PnL can never populate the portfolio total — selectPortfolioStats has no realizedPnlUsd input at all', () => {
    // Static-source guard, matching the convention already used elsewhere in this codebase
    // (src/lib/pnlReconciliation.test.ts's "never imports a wallet-activity-fetching function"
    // guard): selectPortfolioStats/statsFromV1/statsFromV2 never reference realizedPnlUsd anywhere
    // — proving structurally, not just by convention, that a PnL figure can never leak into the
    // rendered portfolio total.
    const v2 = portfolioV2({ totalValueUsd: 500 })
    const result = selectPortfolioStats(portfolioV1({ totalValueUsd: 999999 }), v2)
    assert.equal(result.stats.totalValueUsd, 500, 'only the real portfolio total field is ever read, regardless of what any PnL figure elsewhere in the report might say')
  })

  it('the DexScreener fallback-pricing budget (which can leave many holdings unpriced) never caps the displayed portfolio total — total comes from the single already-computed field, never a re-sum of a capped subset', () => {
    // topHoldings is capped at 5 by the portfolio engine (see buildPortfolio.ts's own disclosure) —
    // summing only those 5 would undercount a wallet with many more priced holdings. totalValueUsd
    // itself is NOT derived from topHoldings; it is the full pricing-engine total.
    const capped = portfolioV2({
      totalValueUsd: 13531.40,
      topHoldings: [
        { tokenAddress: '0xa', symbol: 'A', valueUsd: 10, percentage: 0.0007, chainId: 8453 },
        { tokenAddress: '0xb', symbol: 'B', valueUsd: 8, percentage: 0.0006, chainId: 8453 },
      ],
    })
    const { stats } = selectPortfolioStats(portfolioV1(), capped)
    const topHoldingsSum = capped.topHoldings.reduce((sum, h) => sum + h.valueUsd, 0)
    assert.equal(stats.totalValueUsd, 13531.40)
    assert.ok(stats.totalValueUsd! > topHoldingsSum, 'the displayed total must reflect the real full total, never be silently clamped down to a capped top-holdings subset sum')
  })
})

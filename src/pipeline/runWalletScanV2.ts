// STEP 2 — pipelineOrchestrator V2 (runWalletScanV2)
//
// This does NOT modify or replace runWalletScan() (src/pipeline/index.ts) — it calls it unchanged,
// alongside the newly-promoted holdings/pricing/portfolio modules, and merges the results. The
// original Step 5 report from runWalletScan() is never mutated; V2's holdings/portfolio fields
// are additive alongside it.
//
// Supersedes the earlier sandbox file src/pipeline/runWalletScanWithHoldings.ts (removed as part
// of this promotion — nothing else referenced it besides app/api/scan-preview, which this step's
// app/api/scan-v2 route supersedes too).

import { runWalletScan } from './index'
import type { RunWalletScanParams, RunWalletScanResult } from './types'
import { validatePreScan } from './utils'

import { fetchHoldings } from '../modules/holdings/index'
import type { TokenHolding } from '../modules/holdings/types'
import { resolvePrices } from '../modules/pricing/index'
import type { PricingRequest } from '../modules/pricing/types'
import { buildPortfolioSummary } from '../modules/portfolio/index'
import type { PortfolioSummary } from '../modules/portfolio/types'
import { withStageCache } from '../../lib/server/cache/v2StageCache'

export type RunWalletScanV2Result = RunWalletScanResult & {
  holdings: TokenHolding[]
  portfolio: PortfolioSummary
}

function emptyPortfolio(): PortfolioSummary {
  return { totalValueUsd: null, tokens: [], chainValueBreakdown: [] }
}

// Never mutates the report runWalletScan() returns — holdings/portfolio are computed
// independently and merged into a new object at the end.
export async function runWalletScanV2(params: RunWalletScanParams): Promise<RunWalletScanV2Result> {
  const preScan = validatePreScan(params)

  // KV read-before/write-after (lib/server/cache/v2StageCache.ts) — pipeline-level caching only,
  // fetchHoldings' own source is never touched. 20s TTL: shortest of the 4 wrapped stages, since
  // current balances are the most time-sensitive of the cached data (a stale balance is more
  // visibly wrong to a user than a slightly-stale historical event window).
  const [report, holdingsResults] = await Promise.all([
    runWalletScan(params),
    preScan.valid
      ? Promise.all(preScan.sanitizedChains.map((chain) =>
          withStageCache(
            `v2:holdings:${chain}:${params.walletAddress.toLowerCase()}`,
            20,
            () => fetchHoldings(chain, params.walletAddress),
          ),
        ))
      : Promise.resolve([]),
  ])

  const holdings: TokenHolding[] = holdingsResults.flatMap((r) => r.holdings)

  let portfolio: PortfolioSummary
  try {
    const pricingRequests: PricingRequest[] = holdings.map((h) => ({
      chain: h.chain,
      contract: h.contract,
      knownPriceUsd: h.providerPriceUsd,
    }))
    const prices = await resolvePrices(pricingRequests)
    portfolio = buildPortfolioSummary(holdings, prices)
  } catch {
    portfolio = emptyPortfolio()
  }

  return { ...report, holdings, portfolio }
}

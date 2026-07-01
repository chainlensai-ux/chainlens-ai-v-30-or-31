// PREVIEW-ONLY EXTENDED ORCHESTRATOR — runWalletScanWithHoldings
//
// This file does NOT modify src/pipeline/index.ts, src/modules/finalReportAssembler, or anything
// that backs the real, production-reachable POST /api/scan route. It is a separate, additive
// composition: it calls the existing, unchanged runWalletScan() for the Step 5 report, and
// separately calls the three new modules (holdingsEngine, pricingEngine, portfolioAssembler) to
// produce holdings/portfolio data, merging both into one extended result used ONLY by the V2
// preview (app/api/scan-preview/route.ts + the preview page).
//
// Because this never mutates `report` itself (see the isolation guarantees this whole engine has
// followed throughout: "finalReportAssembler must never alter upstream sections" applies equally
// here), report.chainSelection's visible_value_usd fields still read 0 — a real integration would
// need pipelineOrchestrator itself to pass real holdings value into chainSelection's gate
// evaluation, which is intentionally NOT done here to keep this fully isolated from production.
// portfolio.totalValueUsd / chainValueBreakdown below are the real, priced holdings data; treat
// them as the source of truth for "does this wallet have value," not chainSelection's gates, until
// a real (non-preview) integration is done.

import { runWalletScan } from './index'
import type { RunWalletScanParams, RunWalletScanResult } from './types'
import { validatePreScan } from './utils'

import { fetchHoldings } from '../modules/holdingsEngine/index'
import type { TokenHolding } from '../modules/holdingsEngine/types'
import { resolvePrices } from '../modules/pricingEngine/index'
import type { PricingRequest } from '../modules/pricingEngine/types'
import { buildPortfolioSummary } from '../modules/portfolioAssembler/index'
import type { PortfolioSummary } from '../modules/portfolioAssembler/types'

export type RunWalletScanWithHoldingsResult = RunWalletScanResult & {
  holdings: TokenHolding[]
  portfolio: PortfolioSummary
}

function emptyPortfolio(): PortfolioSummary {
  return { totalValueUsd: null, tokens: [], chainValueBreakdown: [] }
}

export async function runWalletScanWithHoldings(params: RunWalletScanParams): Promise<RunWalletScanWithHoldingsResult> {
  const preScan = validatePreScan(params)

  const [report, holdingsResults] = await Promise.all([
    runWalletScan(params),
    preScan.valid
      ? Promise.all(preScan.sanitizedChains.map((chain) => fetchHoldings(chain, params.walletAddress)))
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

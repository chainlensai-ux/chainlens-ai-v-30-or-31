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
import { createHoldingsKvWriter, withStageCache } from '../../lib/server/cache/v2StageCache'

export type RunWalletScanV2Result = RunWalletScanResult & {
  holdings: TokenHolding[]
  portfolio: PortfolioSummary
}

function emptyPortfolio(): PortfolioSummary {
  return { totalValueUsd: null, tokens: [], chainValueBreakdown: [] }
}

// CANONICAL-BALANCE RECONCILIATION, DISCLOSED (found live, this task — confirmed architectural gap
// behind a false ~$545k unrealized PnL): `report` (via fifoEngine) and `holdings`/`portfolio` used
// to be computed FULLY INDEPENDENTLY in parallel and merged with zero cross-check — the file's own
// original header literally said "V2's holdings/portfolio fields are additive alongside it," which
// was true but meant fifoEngine's event-replay-derived open quantity for a token could silently
// diverge, without limit, from this SAME wallet's real current on-chain balance. Fixed by fetching
// holdings FIRST, building a real, sync canonical-balance lookup from it, and passing that into
// runWalletScan() so fifoEngine's own computePnl can exclude (never silently clamp) any token whose
// FIFO-derived open quantity fails to reconcile against this real balance BEFORE reporting
// unrealizedPnlUsd as official — see fifoEngine/types.ts's CanonicalBalanceLookup for the full
// mechanism.
//
// LATENCY TRADEOFF, DISCLOSED: holdings and the rest of the scan no longer run fully in parallel —
// holdings must resolve before fifoEngine's own pricing/PnL stage can consult it. This is a
// deliberate correctness-over-speed tradeoff, not a free win: a wallet whose holdings fetch is slow
// now adds that latency to the whole scan, rather than only to the holdings/portfolio fields. Same
// KV read-before/write-after caching (lib/server/cache/v2StageCache.ts) as before — fetchHoldings'
// own source is never touched, and the 20s TTL is unchanged.
function buildCanonicalBalanceLookup(holdings: TokenHolding[]): import('../modules/fifoEngine/types').CanonicalBalanceLookup {
  const byKey = new Map<string, number>()
  for (const h of holdings) {
    const key = `${h.chain}:${h.contract.toLowerCase()}`
    // A wallet can never hold a real NEGATIVE balance — a provider bug reporting one is not real
    // evidence of ANY balance, so it is treated the same as "unknown" (never coerced to 0, which
    // would incorrectly exclude every open lot for a token that might genuinely still be held).
    if (!Number.isFinite(h.amount) || h.amount < 0) continue
    byKey.set(key, (byKey.get(key) ?? 0) + h.amount)
  }
  return (token, chain) => byKey.get(`${chain}:${token.toLowerCase()}`) ?? null
}

// Never mutates the report runWalletScan() returns — holdings/portfolio are computed
// independently and merged into a new object at the end.
export async function runWalletScanV2(params: RunWalletScanParams): Promise<RunWalletScanV2Result> {
  const preScan = validatePreScan(params)
  const holdingsKvWriter = createHoldingsKvWriter()

  // KV read-before/write-after (lib/server/cache/v2StageCache.ts) — pipeline-level caching only,
  // fetchHoldings' own source is never touched. 20s TTL: shortest of the 4 wrapped stages, since
  // current balances are the most time-sensitive of the cached data (a stale balance is more
  // visibly wrong to a user than a slightly-stale historical event window).
  const holdingsResults = preScan.valid
    ? await Promise.all(preScan.sanitizedChains.map((chain) =>
        withStageCache(
          `v2:holdings:${chain}:${params.walletAddress.toLowerCase()}`,
          20,
          () => fetchHoldings(chain, params.walletAddress),
          { writer: holdingsKvWriter },
        ),
      ))
    : []

  const holdings: TokenHolding[] = holdingsResults.flatMap((r) => r.holdings)
  const report = await runWalletScan({ ...params, canonicalBalanceLookup: buildCanonicalBalanceLookup(holdings) })

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

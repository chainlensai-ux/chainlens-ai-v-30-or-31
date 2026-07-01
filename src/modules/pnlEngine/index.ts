// MODULE — pnlEngine
//
// Additive read model over real sellTimelineV2 + buyTimeline entries, producing the
// closedLots[]/winLossRate/chainBreakdown/confidenceBasis/evidenceMissingCount shape. Does NOT
// replace or modify src/modules/fifoEngine (the real PnL engine, which does true quantity-based
// FIFO lot matching and never depended on report.timelines.sellTimeline in the first place — see
// types.ts header for the full rationale). Pure — no provider calls, no side effects.

import type {
  BuildPnlSummaryParams,
  ChainBreakdownEntry,
  ClosedLot,
  PnlConfidenceBasis,
  PnlSummaryResult,
  ResolveCostUsdEstimate,
  ResolveProceedsUsdEstimate,
  WinLossRate,
} from './types'
import { buildChainBreakdown, buildConfidenceBasis, evaluateWinLoss } from './utils'

export type {
  BuildPnlSummaryParams,
  ChainBreakdownEntry,
  ClosedLot,
  PnlConfidenceBasis,
  PnlConfidenceLevel,
  PnlLotEvidence,
  PnlSummaryResult,
  ResolveCostUsdEstimate,
  ResolveProceedsUsdEstimate,
  WinLossRate,
} from './types'

// Default lookups read each entry's own real field — always null today (see types.ts header).
const defaultResolveProceedsUsdEstimate: ResolveProceedsUsdEstimate = (sell) => sell.proceedsUsdEstimate

// buyTimeline entries carry no lot-id field, so a matchedBuyLotId (never populated today anyway)
// could not be resolved against them even if present. Defaults to null — never guessed.
const defaultResolveCostUsdEstimate: ResolveCostUsdEstimate = () => null

// PURE. Builds one ClosedLot per real sellTimelineV2 entry. Migration Rule 1: uses
// sell.matchedBuyLotId when sellTimelineV2 ever supplies one; otherwise treats the sell as an
// unmatched exit with a stable (non-fabricated) key derived from its own real txHash — never
// force-matched to an arbitrary buy.
function buildClosedLot(
  sell: BuildPnlSummaryParams['sellEntries'][number],
  buyEntries: BuildPnlSummaryParams['buyEntries'],
  resolveCostUsdEstimate: ResolveCostUsdEstimate,
  resolveProceedsUsdEstimate: ResolveProceedsUsdEstimate,
): ClosedLot {
  const proceedsUsdEstimate = resolveProceedsUsdEstimate(sell)
  const costUsdEstimate = resolveCostUsdEstimate(sell, buyEntries)
  const hasEvidence = proceedsUsdEstimate != null && costUsdEstimate != null

  return {
    lotId: sell.matchedBuyLotId ?? `unmatched:${sell.txHash}`,
    matchedBuyLotId: sell.matchedBuyLotId,
    token: sell.token,
    symbol: sell.symbol,
    chain: sell.chain,
    timestamp: sell.timestamp,
    txHash: sell.txHash,
    amount: sell.amount,
    costUsdEstimate,
    proceedsUsdEstimate,
    realizedPnlUsd: hasEvidence ? proceedsUsdEstimate! - costUsdEstimate! : null,
    confidence: sell.confidence,
    evidence: hasEvidence ? 'complete' : 'evidence_missing',
  }
}

// PURE. Assembles the full PnL summary. Migration Rule 2/3: realizedPnlUsd/winLossRate are
// computed strictly over 'complete'-evidence lots — a lot missing either cost or proceeds
// contributes nothing to either (never a fabricated 0), and realizedPnlUsd itself stays null (not
// 0) when there isn't a single complete-evidence lot to sum (same convention fifoEngine's
// computePnl already uses).
export function buildPnlSummary(params: BuildPnlSummaryParams): PnlSummaryResult {
  const resolveCostUsdEstimate = params.resolveCostUsdEstimate ?? defaultResolveCostUsdEstimate
  const resolveProceedsUsdEstimate = params.resolveProceedsUsdEstimate ?? defaultResolveProceedsUsdEstimate

  const closedLots = params.sellEntries.map((sell) =>
    buildClosedLot(sell, params.buyEntries, resolveCostUsdEstimate, resolveProceedsUsdEstimate),
  )

  const completeLots = closedLots.filter((l) => l.evidence === 'complete')
  const realizedPnlUsd = completeLots.length > 0 ? completeLots.reduce((sum, l) => sum + l.realizedPnlUsd!, 0) : null

  return {
    realizedPnlUsd,
    closedLots,
    winLossRate: evaluateWinLoss(closedLots),
    chainBreakdown: buildChainBreakdown(closedLots),
    confidenceBasis: buildConfidenceBasis(closedLots),
    evidenceMissingCount: closedLots.filter((l) => l.evidence === 'evidence_missing').length,
  }
}

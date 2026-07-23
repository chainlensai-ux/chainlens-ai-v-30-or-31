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

// PURE. Exported for direct testing and for the pipeline's own duplicate-rejection diagnostic.
//
// DUPLICATE-SELL-ENTRY FIX, DISCLOSED (confirmed root cause of the two-engine realized-PnL
// divergence, real production evidence: pnlSummaryV2 $270.02 vs fifoEngine-based reconciliation
// $174.01): buildPnlSummary previously built one ClosedLot per RAW sellEntries array element with
// zero deduplication. sellTimelineV2 (this function's real, only caller's source for sellEntries)
// has an already-disclosed gap where the SAME real transfer can appear more than once — once via
// its "transfer-out to known router" mechanism, once via its "bridge-exit" mechanism — sharing the
// identical (chain, token, txHash, amount) identity. Both duplicate rows resolve to the SAME
// fifoEngine-backed cost/proceeds (keyed only by txHash — see buildFifoBackedPnlResolvers in
// src/pipeline/index.ts), so both were summed into realizedPnlUsd, double-counting that one real
// sell's contribution. fifoEngine's own total has no equivalent risk (built from normalization's
// already-deduped event set), which is exactly why only pnlEngine's independent total came out
// inflated. Fixed by deduping sellEntries by (chain, token, txHash, amount) — the same real-transfer
// identity sellTimelineV2's own dedupeKey targets — before building closedLots. This does not touch
// sellTimelineV2 itself (a separate module, out of this fix's scope); it hardens this consumer
// against a known duplicate-input risk regardless of whether the upstream gap is ever separately
// closed. Never removes a genuinely distinct sell (different token/chain/txHash/amount combination
// keeps its own row) — only an exact-identity repeat.
export function dedupeSellEntries(sellEntries: BuildPnlSummaryParams['sellEntries']): { deduped: BuildPnlSummaryParams['sellEntries']; duplicatesRejected: number } {
  const seen = new Set<string>()
  const deduped: BuildPnlSummaryParams['sellEntries'] = []
  let duplicatesRejected = 0
  for (const sell of sellEntries) {
    const key = `${sell.chain}|${sell.txHash}|${sell.token.toLowerCase()}|${sell.amount}`
    if (seen.has(key)) {
      duplicatesRejected += 1
      continue
    }
    seen.add(key)
    deduped.push(sell)
  }
  return { deduped, duplicatesRejected }
}

// PURE. Assembles the full PnL summary. Migration Rule 2/3: realizedPnlUsd/winLossRate are
// computed strictly over 'complete'-evidence lots — a lot missing either cost or proceeds
// contributes nothing to either (never a fabricated 0), and realizedPnlUsd itself stays null (not
// 0) when there isn't a single complete-evidence lot to sum (same convention fifoEngine's
// computePnl already uses).
export function buildPnlSummary(params: BuildPnlSummaryParams): PnlSummaryResult {
  const resolveCostUsdEstimate = params.resolveCostUsdEstimate ?? defaultResolveCostUsdEstimate
  const resolveProceedsUsdEstimate = params.resolveProceedsUsdEstimate ?? defaultResolveProceedsUsdEstimate

  const { deduped: dedupedSellEntries, duplicatesRejected } = dedupeSellEntries(params.sellEntries)
  if (duplicatesRejected > 0) {
    // eslint-disable-next-line no-console
    console.warn('[pnlEngine] duplicate sell entries rejected before closed-lot construction', {
      totalSellEntries: params.sellEntries.length, duplicatesRejected, uniqueSellEntries: dedupedSellEntries.length,
    })
  }

  const closedLots = dedupedSellEntries.map((sell) =>
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

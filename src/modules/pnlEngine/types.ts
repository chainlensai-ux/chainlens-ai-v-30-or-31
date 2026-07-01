// MODULE — pnlEngine: type definitions.
//
// NOT a replacement for src/modules/fifoEngine (the real, existing PnL engine — quantity-based
// FIFO lot matching over normalized events, with its own injectable priceUsdLookup mechanism).
// fifoEngine never read report.timelines.sellTimeline to begin with, so there was no legacy
// binding to migrate away from. This module exists because the requested output shape
// (closedLots[]/winLossRate/chainBreakdown/confidenceBasis/evidenceMissingCount) never existed
// anywhere in this codebase — it's new, additive read-model over real sellTimelineV2 + buyTimeline
// entries, not a rewiring of fifoEngine's real lot-matching algorithm.
//
// HONESTY NOTE: sellTimelineV2.proceedsUsdEstimate and buyTimeline.usdValueEstimate are BOTH always
// null today — no pricing-at-time module exists anywhere in this codebase (see sellTimeline and
// timelineBuilder's own "NOTE ON SCOPE" comments). This module therefore honestly reports
// evidence_missing for every lot until a real pricing module is wired in via the optional
// resolveCostUsdEstimate/resolveProceedsUsdEstimate lookups below (same "inject a real lookup or
// stay honestly null" pattern fifoEngine's priceUsdLookup already uses).
// matchedBuyLotId is likewise never populated by sellTimelineV2 today (lot matching is
// fifoEngine's job) AND buyTimeline entries carry no lot-id field to match against even if it
// were — so a matched-by-id closed lot is not fabricated here; every sell is honestly treated as
// an unmatched exit (Migration Rule 1's documented fallback), never force-matched.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { SellConfidence, SellTimelineEntry } from '../sellTimeline/types'
import type { BuyTimelineEntry } from '../timelineBuilder/types'

export type PnlLotEvidence = 'complete' | 'evidence_missing'

export type ClosedLot = {
  // matchedBuyLotId when sellTimelineV2 ever supplies one (never true today); otherwise a stable,
  // non-fabricated key derived from the sell's own real txHash — never an invented match.
  lotId: string
  matchedBuyLotId: string | null
  token: string
  symbol: string | null
  chain: SupportedChain
  timestamp: number
  txHash: string
  amount: string
  costUsdEstimate: number | null
  proceedsUsdEstimate: number | null
  realizedPnlUsd: number | null
  confidence: SellConfidence
  evidence: PnlLotEvidence
}

export type WinLossRate = {
  wins: number
  losses: number
  evaluated: number // lots with 'complete' evidence only
  rate: number | null // wins / evaluated; null when evaluated === 0
}

export type ChainBreakdownEntry = {
  chain: SupportedChain
  closedLotCount: number
  realizedPnlUsd: number | null // sum over 'complete'-evidence lots on this chain; null if none
}

export type PnlConfidenceLevel = 'high' | 'medium' | 'low' | 'unavailable'

export type PnlConfidenceBasis = {
  high: number
  medium: number
  low: number
  aggregate: PnlConfidenceLevel
}

export type PnlSummaryResult = {
  realizedPnlUsd: number | null
  closedLots: ClosedLot[]
  winLossRate: WinLossRate
  chainBreakdown: ChainBreakdownEntry[]
  confidenceBasis: PnlConfidenceBasis
  evidenceMissingCount: number
}

export type ResolveCostUsdEstimate = (sell: SellTimelineEntry, buyEntries: BuyTimelineEntry[]) => number | null
export type ResolveProceedsUsdEstimate = (sell: SellTimelineEntry) => number | null

export type BuildPnlSummaryParams = {
  sellEntries: SellTimelineEntry[]
  buyEntries: BuyTimelineEntry[]
  // Optional, caller-supplied lookups — default to reading each entry's own real (always-null
  // today) field. Once a real pricing-at-time / lot-matching module exists, a caller can supply a
  // real lookup here with no change to this module's logic, mirroring fifoEngine's own
  // priceUsdLookup convention.
  resolveCostUsdEstimate?: ResolveCostUsdEstimate
  resolveProceedsUsdEstimate?: ResolveProceedsUsdEstimate
}

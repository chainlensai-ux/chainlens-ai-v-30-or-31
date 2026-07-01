// MODULE 4 — timelineBuilder: type definitions.
// Builds buyTimeline / sellTimeline / distributionTimeline as read models over normalized events,
// scoped to active_intelligence chains only (Architecture Step 2 / Step 3 §1). Pure — no provider
// calls, no side effects.
//
// NOTE ON SCOPE: no swap-detection, router database, price-at-time, or FIFO/lot-matching module
// exists in this foundation delivery. Sell classification here is therefore a same-tx-pairing
// heuristic only (never router-confirmed), so `confidence` never reaches "high" and
// `usdValueEstimate` / `proceedsUsdEstimate` / `matchedBuyLotId` are always null placeholders —
// those fields are wired up by future modules (recoveryPolicy / fifoEngine), not this one.

import type { ChainGateStatus } from '../chainSelection/types'
import type { SupportedChain } from '../providerFetchWindow/types'

export type SourceType = 'swap' | 'transfer' | 'airdrop' | 'mint'
export type SellConfidence = 'high' | 'medium' | 'low'
export type RecipientType = 'EOA' | 'contract' | string

export type ChainSelectionRef = {
  status: ChainGateStatus
  gatesPassed: string[]
}

export type ChainContextExcludedChain = {
  chain: SupportedChain
  status: ChainGateStatus
  reason: string
}

export type ChainContext = {
  includedChains: SupportedChain[]
  excludedChains: ChainContextExcludedChain[]
}

export type BuyTimelineEntry = {
  timestamp: number
  chain: SupportedChain
  token: string
  symbol: string
  amount: string
  usdValueEstimate: number | null
  sourceType: SourceType
  txHash: string
  chainSelectionRef: ChainSelectionRef
}

export type SellTimelineEntry = {
  timestamp: number
  chain: SupportedChain
  token: string
  symbol: string
  amount: string
  proceedsUsdEstimate: number | null
  matchedBuyLotId: string | null
  confidence: SellConfidence
  txHash: string
  chainSelectionRef: ChainSelectionRef
}

export type DistributionTimelineEntry = {
  timestamp: number
  chain: SupportedChain
  token: string
  symbol: string
  amount: string
  recipientAddress: string
  recipientType: RecipientType
  txHash: string
  chainSelectionRef: ChainSelectionRef
}

export type BuyTimeline = {
  totalBuys: number
  chainContext: ChainContext
  entries: BuyTimelineEntry[]
}

export type SellTimeline = {
  totalSells: number
  chainContext: ChainContext
  entries: SellTimelineEntry[]
}

export type DistributionTimeline = {
  totalDistributions: number
  chainContext: ChainContext
  entries: DistributionTimelineEntry[]
}

export type TimelineBuilderResult = {
  buyTimeline: BuyTimeline
  sellTimeline: SellTimeline
  distributionTimeline: DistributionTimeline
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

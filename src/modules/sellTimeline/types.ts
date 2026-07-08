// MODULE — sellTimeline: type definitions.
//
// Reconstructs sell events across every chain chainSelection admits to active intelligence, via
// four mechanisms (see index.ts for what's real vs. TODO per mechanism). Additive/standalone: this
// does NOT replace timelineBuilder's existing `timelines.sellTimeline` (consumed today by
// fifoEngine, behaviorIntel, and the UI) — it is a separate, richer read model pending an explicit
// integration decision. See index.ts header for the full rationale.
//
// NEVER FABRICATE: every entry here traces back to a real NormalizedEvent, a real
// BridgeCandidateEvent, or a real recoveryPolicy.recoveredEvents item. No entry is ever
// synthesized from a balance gap or an unverified router/contract guess.

import type { ChainGateStatus } from '../chainSelection/types'
import type { SupportedChain } from '../providerFetchWindow/types'

export type SellConfidence = 'high' | 'medium' | 'low'

// Maps chainSelection's real ChainGateStatus ('active_intelligence' | 'dust_low_signal') onto the
// two labels this module's caller asked for. 'dust_low_signal' -> 'excluded' is a relabeling only,
// never a different judgment than chainSelection already made.
export type SellChainSelectionStatus = 'active_intelligence' | 'excluded'

export type SellChainSelectionRef = {
  status: SellChainSelectionStatus
  gatesPassed: string[]
}

export type SellTimelineEntry = {
  timestamp: number
  chain: SupportedChain
  token: string
  symbol: string | null
  amount: string
  proceedsUsdEstimate: number | null
  matchedBuyLotId: string | null
  confidence: SellConfidence
  txHash: string
  chainSelectionRef: SellChainSelectionRef
  // DEDUPE-KEY FIX, DISCLOSED (wallet-scanner audit): the recipient address this leg's tokens moved
  // to (lowercased), when known — null for bridge-exit entries, which have no single "recipient"
  // concept in the same sense. Without this, two genuinely distinct sell legs in the same tx with the
  // same token/amount but different recipients (e.g. a sell split across two router calls) collapsed
  // to one dedupe key and the second real sell was silently dropped. NormalizedEvent has no logIndex
  // field today, so recipient address is the best available discriminator without a larger pipeline
  // change to carry per-log ordering through RawProviderEvent -> NormalizedEvent -> here.
  counterparty: string | null
}

export type SellChainContext = {
  includedChains: SupportedChain[]
  excludedChains: SupportedChain[]
}

export type SellTimelineResult = {
  totalSells: number
  chainContext: SellChainContext
  entries: SellTimelineEntry[]
}

export function mapChainGateStatus(status: ChainGateStatus): SellChainSelectionStatus {
  return status === 'active_intelligence' ? 'active_intelligence' : 'excluded'
}

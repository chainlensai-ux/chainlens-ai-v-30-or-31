// MODULE 6 — fifoEngine: type definitions.
//
// Computes real, quantity-based FIFO lot matching over normalized + recovered events. NO pricing
// module exists yet in this delivery, so this engine never invents a USD figure: it accepts an
// optional, caller-supplied `priceUsdLookup` for cost basis / proceeds and an optional
// `currentPriceUsdLookup` for marking open lots to market. When neither is supplied, every lot is
// genuinely, honestly unpriced — quantity matching still runs for real, but every USD field stays
// null rather than being guessed (Architecture Step 9 §4: "fifoEngine must never guess cost basis").

import type { SupportedChain } from '../providerFetchWindow/types'
import type { NormalizedEvent } from '../normalization/types'

export type LotEvidenceQuality = 'verified' | 'unpriced'

export type OpenLot = {
  lotId: string
  token: string
  chain: SupportedChain
  openedAt: number
  openedTxHash: string
  amountOpened: number
  amountRemaining: number
  costBasisUsd: number | null
  evidenceQuality: LotEvidenceQuality
}

export type MatchedLot = {
  lotId: string
  token: string
  chain: SupportedChain
  openedAt: number
  closedAt: number
  openedTxHash: string
  closedTxHash: string
  amount: number
  costBasisUsd: number | null
  proceedsUsd: number | null
  realizedPnlUsd: number | null
  evidenceQuality: LotEvidenceQuality
}

export type IntegrityFlags = {
  hardInvalid: boolean
  estimateOnlyLotsExcluded: number
  syntheticLotsExcluded: number
}

export type PublicPnlStatus = 'unavailable' | 'limited_verified_sample' | 'ok'

export type FifoOutput = {
  matchedLots: MatchedLot[]
  unmatchedBuys: number
  unmatchedSells: number
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  costBasisUsd: number | null
  publicPnlStatus: PublicPnlStatus
  integrityFlags: IntegrityFlags
}

// PURE lookup contracts — supplied by a future price-at-time module. Defaulting to "always null"
// keeps this engine's current output honest (no priced module exists yet), while allowing it to
// resolve real cost basis/PnL the moment such a module is wired in, with no change to this file.
export type PriceUsdLookup = (event: NormalizedEvent) => number | null
export type CurrentPriceUsdLookup = (token: string, chain: SupportedChain) => number | null

export type { NormalizedEvent }

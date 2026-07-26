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
  // See CanonicalBalanceLookup's own header below — `${chain}:${token}` keys excluded from
  // unrealizedPnlUsd because their FIFO-derived open quantity could not be reconciled against a
  // real canonical balance. Always empty when no canonicalBalanceLookup was supplied.
  unrealizedPnlExcludedTokens: string[]
}

// PURE lookup contracts — supplied by a future price-at-time module. Defaulting to "always null"
// keeps this engine's current output honest (no priced module exists yet), while allowing it to
// resolve real cost basis/PnL the moment such a module is wired in, with no change to this file.
export type PriceUsdLookup = (event: NormalizedEvent) => number | null
export type CurrentPriceUsdLookup = (token: string, chain: SupportedChain) => number | null

// CANONICAL-BALANCE RECONCILIATION, DISCLOSED, ADDITIVE (found live, this task — confirmed
// architectural gap behind a false ~$545k unrealized PnL): this engine's own `remainingOpenLots`
// (see computePnl in index.ts) is derived PURELY from event-replay (buys minus matched sells) —
// there was NEVER any cross-check against the wallet's real, independently-fetched current token
// balance (src/modules/holdings) before multiplying an open quantity by a current price. A missed
// sell, a duplicated/mis-normalized buy event, or a raw-unit/decimal scaling bug in ANY upstream
// provider can inflate a token's event-replay-derived open quantity far past its real on-chain
// balance — and this engine, previously, had no way to catch that before reporting the resulting
// (fabricated-looking) unrealizedPnlUsd as official.
//
// Optional, defaulting to undefined: a caller that does not supply this gets BYTE-IDENTICAL
// existing behavior (see computePnl's own "ZERO-CHANGE PATH" comment) — this is purely an opt-in
// safety layer, never a change to FIFO lot matching/identity itself (buildLots/matchLotsFIFO are
// completely untouched). Returns the real current on-chain balance for (token, chain), or `null`
// when that balance genuinely isn't known/trustworthy for this token — `null` is a real, honest
// "unknown" result, never coerced to 0 or Infinity.
export type CanonicalBalanceLookup = (token: string, chain: SupportedChain) => number | null

export type { NormalizedEvent }

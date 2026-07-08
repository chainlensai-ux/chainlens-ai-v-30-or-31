// MODULE 6 — fifoEngine
//
// Computes real, quantity-based FIFO lot matching over normalized (base + recovered) events.
// Pure — no provider calls anywhere in this module. Never modifies timelines (no import of
// timelineBuilder at all) and never modifies recoveryPolicy (reads only the RawProviderEvent[]
// it produced, has no write path back into it). Never guesses cost basis: every USD figure comes
// only from an optional, caller-supplied price lookup — when absent, figures stay honestly null
// rather than estimated (Architecture Step 9 §4).

import type { NormalizedEvent } from '../normalization/types'
import { normalizeEvents } from '../normalization/index'
import type { RawProviderEvent, SupportedChain } from '../providerFetchWindow/types'
import type {
  CurrentPriceUsdLookup,
  FifoOutput,
  IntegrityFlags,
  MatchedLot,
  OpenLot,
  PriceUsdLookup,
  PublicPnlStatus,
} from './types'
import { buildLotId, groupByToken, mergeNormalizedEvents } from './utils'

export type {
  CurrentPriceUsdLookup,
  FifoOutput,
  IntegrityFlags,
  LotEvidenceQuality,
  MatchedLot,
  OpenLot,
  PriceUsdLookup,
  PublicPnlStatus,
} from './types'

const noPriceLookup: PriceUsdLookup = () => null
const noCurrentPriceLookup: CurrentPriceUsdLookup = () => null

// PURE. Builds the chronologically-sorted open-lot inventory from every inbound (buy) leg across
// the merged base + recovered event set. `recoveredEvents` here are already-normalized (the
// RawProviderEvent -> NormalizedEvent conversion for recovery output happens once, in
// buildFifoOutput, via the existing normalization module's normalizeEvents — never re-implemented
// here). Every lot's costBasisUsd is resolved via priceUsdLookup only; absent that, it's null.
export function buildLots(
  normalizedEvents: NormalizedEvent[],
  recoveredEvents: NormalizedEvent[],
  priceUsdLookup: PriceUsdLookup = noPriceLookup,
): OpenLot[] {
  const merged = mergeNormalizedEvents(normalizedEvents, recoveredEvents)
  const buys = merged.filter((e) => e.direction === 'inbound')

  const lots: OpenLot[] = buys.map((event) => {
    const costBasisUsd = priceUsdLookup(event)
    return {
      lotId: buildLotId(event.chain, event.contract, event.txHash, Date.parse(event.timestamp)),
      token: event.contract,
      chain: event.chain,
      openedAt: Date.parse(event.timestamp),
      openedTxHash: event.txHash,
      amountOpened: event.amount,
      amountRemaining: event.amount,
      costBasisUsd,
      evidenceQuality: costBasisUsd != null ? 'verified' : 'unpriced',
    }
  })

  return lots.sort((a, b) => a.openedAt - b.openedAt)
}

type MatchResult = {
  matchedLots: MatchedLot[]
  remainingOpenLots: OpenLot[]
  unmatchedSells: number
}

// PURE. Matches every outbound leg in the merged event set against the oldest available open lot
// for that token first (true FIFO order). A sell that finds no open lot at all (or only a partial
// lot, leaving a remainder with no earlier buy to draw from) counts toward `unmatchedSells` — it
// is never backfilled with an invented lot (Architecture Step 9 §4).
export function matchLotsFIFO(
  lots: OpenLot[],
  sellEvents: NormalizedEvent[],
  priceUsdLookup: PriceUsdLookup = noPriceLookup,
): MatchResult {
  // Work on a deep-enough copy so the caller's `lots` array is never mutated.
  const workingLots = lots.map((lot) => ({ ...lot }))
  const lotsByToken = groupByToken(workingLots)
  const matchedLots: MatchedLot[] = []
  let unmatchedSells = 0

  const sortedSells = [...sellEvents].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))

  for (const sell of sortedSells) {
    const key = `${sell.chain}:${sell.contract.toLowerCase()}`
    const tokenLots = (lotsByToken.get(key) ?? []).filter((l) => l.amountRemaining > 0)
    let remainingToMatch = sell.amount
    let matchedAnyAmount = false
    const proceedsUsdTotal = priceUsdLookup(sell)

    for (const lot of tokenLots) {
      if (remainingToMatch <= 0) break
      if (lot.amountRemaining <= 0) continue

      const amountFromThisLot = Math.min(lot.amountRemaining, remainingToMatch)
      const proportionOfSell = proceedsUsdTotal != null && sell.amount > 0 ? (amountFromThisLot / sell.amount) * proceedsUsdTotal : null
      const costBasisForPortion = lot.costBasisUsd != null && lot.amountOpened > 0
        ? (amountFromThisLot / lot.amountOpened) * lot.costBasisUsd
        : null
      const isVerified = costBasisForPortion != null && proportionOfSell != null

      matchedLots.push({
        lotId: lot.lotId,
        token: lot.token,
        chain: lot.chain,
        openedAt: lot.openedAt,
        closedAt: Date.parse(sell.timestamp),
        openedTxHash: lot.openedTxHash,
        closedTxHash: sell.txHash,
        amount: amountFromThisLot,
        costBasisUsd: costBasisForPortion,
        proceedsUsd: proportionOfSell,
        realizedPnlUsd: isVerified ? proportionOfSell! - costBasisForPortion! : null,
        evidenceQuality: isVerified ? 'verified' : 'unpriced',
      })

      // Shrink the lot's cost basis by the same proportion as the amount just consumed, so a
      // partially-sold lot's remaining costBasisUsd reflects only its remaining amount — not the
      // original full-lot cost basis. Without this, computePnl's remaining-open-lot cost basis
      // double-counts the portion already realized above (costBasisForPortion).
      if (lot.costBasisUsd != null) lot.costBasisUsd -= costBasisForPortion ?? 0
      lot.amountOpened -= amountFromThisLot
      lot.amountRemaining -= amountFromThisLot
      remainingToMatch -= amountFromThisLot
      matchedAnyAmount = true
    }

    if (remainingToMatch > 0 || !matchedAnyAmount) unmatchedSells += 1
  }

  const remainingOpenLots = [...lotsByToken.values()].flat().filter((l) => l.amountRemaining > 0)
  return { matchedLots, remainingOpenLots, unmatchedSells }
}

type PnlSummary = {
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  costBasisUsd: number | null
}

// PURE. Aggregates PnL strictly from verified (priced, non-estimate) matched lots — an unpriced
// lot contributes nothing to realizedPnlUsd/costBasisUsd (never a fabricated 0), and if there is
// not a single verified figure to sum, the aggregate itself stays null rather than reporting 0
// (Architecture Step 9 §4 / Step 7 §6).
export function computePnl(
  matchedLots: MatchedLot[],
  remainingOpenLots: OpenLot[],
  currentPriceUsdLookup: CurrentPriceUsdLookup = noCurrentPriceLookup,
): PnlSummary {
  const verifiedMatched = matchedLots.filter((l) => l.evidenceQuality === 'verified')

  const realizedPnlUsd = verifiedMatched.length > 0
    ? verifiedMatched.reduce((sum, l) => sum + (l.realizedPnlUsd ?? 0), 0)
    : null

  const pricedCostBasisLots = [
    ...verifiedMatched.map((l) => l.costBasisUsd as number),
    ...remainingOpenLots.filter((l) => l.costBasisUsd != null).map((l) => l.costBasisUsd as number),
  ]
  const costBasisUsd = pricedCostBasisLots.length > 0 ? pricedCostBasisLots.reduce((sum, v) => sum + v, 0) : null

  const unrealizedTerms = remainingOpenLots
    .map((lot) => {
      const currentPrice = currentPriceUsdLookup(lot.token, lot.chain)
      if (currentPrice == null || lot.costBasisUsd == null) return null
      return currentPrice * lot.amountRemaining - lot.costBasisUsd
    })
    .filter((v): v is number => v != null)
  const unrealizedPnlUsd = unrealizedTerms.length > 0 ? unrealizedTerms.reduce((sum, v) => sum + v, 0) : null

  return { realizedPnlUsd, unrealizedPnlUsd, costBasisUsd }
}

// COVERAGE FIX, DISCLOSED (Clark-summary-confidence-mislabeling task): previously this only checked
// `verifiedMatchedCount >= 10` (an absolute count) to return 'ok' — completely ignoring how much of
// the wallet's real sell activity actually got matched at all. Found live: a wallet with 17 verified
// closed lots but 118 unmatched sells (i.e. ~87% of its real sell events have NO cost-basis match at
// all) was still labeled "Verified FIFO sample — official PnL available." — a real, honest-looking
// confidence claim the underlying evidence doesn't support. Now also requires that verified lots
// make up at least half of the wallet's total attempted sell activity (every matched lot, verified
// or not, plus every completely unmatched sell) before granting the strongest confidence tier —
// `totalSellAttempts` counts ALL matched lots (`matchedCount`, verified or lower-quality) plus
// unmatched sells, so a wallet whose sells are mostly unresolved never crosses this bar regardless
// of its absolute verified count.
// TEST-SUPPORT EXPORT, DISCLOSED: exported solely so a test can assert this coverage-threshold
// logic directly, without constructing full normalizedEvents/lot fixtures through buildFifoOutput —
// no behavior change, same function real callers use.
export function derivePublicPnlStatus(
  verifiedMatchedCount: number,
  matchedCount: number,
  unmatchedSells: number,
  hardInvalid: boolean,
): PublicPnlStatus {
  if (hardInvalid) return 'unavailable'
  if (verifiedMatchedCount === 0) return 'unavailable'
  if (verifiedMatchedCount < 10) return 'limited_verified_sample'
  const totalSellAttempts = matchedCount + unmatchedSells
  const verifiedCoverageRatio = totalSellAttempts > 0 ? verifiedMatchedCount / totalSellAttempts : 1
  if (verifiedCoverageRatio < 0.5) return 'limited_verified_sample'
  return 'ok'
}

// Orchestrates the full FIFO pipeline into the final output shape. `recoveredRawEvents` are
// recoveryPolicy's raw output — normalized here via the existing normalization module (a pure
// reuse, not a new provider call) before being merged into the lot/match pipeline.
export function buildFifoOutput(params: {
  normalizedEvents: NormalizedEvent[]
  recoveredRawEvents: RawProviderEvent[]
  walletAddress: string
  priceUsdLookup?: PriceUsdLookup
  currentPriceUsdLookup?: CurrentPriceUsdLookup
}): FifoOutput {
  const priceUsdLookup = params.priceUsdLookup ?? noPriceLookup
  const currentPriceUsdLookup = params.currentPriceUsdLookup ?? noCurrentPriceLookup

  const { normalizedEvents: recoveredNormalized } = normalizeEvents(params.recoveredRawEvents, params.walletAddress)
  const mergedAll = mergeNormalizedEvents(params.normalizedEvents, recoveredNormalized)
  const sells = mergedAll.filter((e) => e.direction === 'outbound')

  const lots = buildLots(params.normalizedEvents, recoveredNormalized, priceUsdLookup)
  const { matchedLots, remainingOpenLots, unmatchedSells } = matchLotsFIFO(lots, sells, priceUsdLookup)
  const { realizedPnlUsd, unrealizedPnlUsd, costBasisUsd } = computePnl(matchedLots, remainingOpenLots, currentPriceUsdLookup)

  const verifiedMatchedCount = matchedLots.filter((l) => l.evidenceQuality === 'verified').length
  const estimateOnlyLotsExcluded = matchedLots.filter((l) => l.evidenceQuality === 'unpriced').length
  const hardInvalid = params.normalizedEvents.length === 0 && recoveredNormalized.length === 0

  const integrityFlags: IntegrityFlags = {
    hardInvalid,
    estimateOnlyLotsExcluded,
    // This engine never fabricates a lot from missing evidence, so there is no code path that can
    // ever produce a synthetic lot — this stays 0 by construction, not by a runtime check.
    syntheticLotsExcluded: 0,
  }

  return {
    matchedLots,
    unmatchedBuys: remainingOpenLots.length,
    unmatchedSells,
    realizedPnlUsd,
    unrealizedPnlUsd,
    costBasisUsd,
    publicPnlStatus: derivePublicPnlStatus(verifiedMatchedCount, matchedLots.length, unmatchedSells, hardInvalid),
    integrityFlags,
  }
}

export type { SupportedChain }

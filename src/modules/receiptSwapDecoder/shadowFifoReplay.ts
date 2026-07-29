// MODULE — receiptSwapDecoder: shadow FIFO replay.
//
// GOAL, DISCLOSED: production proof — one exact, factory-validated Aerodrome Slipstream swap was
// recovered by decodeReceiptSwap, upgrading a real one-leg transaction (wouldCompleteMissingLotSide:
// true, candidateLotsUnlocked: 1). Every prior pass only COUNTED that as a possible unlock — this
// module actually measures what closing that lot would do to FIFO/PnL, entirely in a throwaway
// clone, so the real effect is visible before any promotion decision is made.
//
// SHADOW MODE, ABSOLUTE, DISCLOSED: this function NEVER touches the caller's real normalizedEvents
// array or any other canonical structure — it deep-clones before making any change, and everything
// it returns is a plain diagnostics object (counters + a boolean + a typed rejection reason). The
// canonical pipeline (src/pipeline/index.ts's real buildFifoOutput call, matchedLots,
// publicPnlStatus, official PnL) is never called by this module and never sees this module's output.
//
// NO NEW PROVIDER CALLS, DISCLOSED: `recoveredRawEvents` is always `[]` for both the "before" and
// "after" FIFO runs (recoveryPolicy's historical-page fetching is never invoked here), and
// `priceUsdLookup`/`currentPriceUsdLookup` are the SAME caller-supplied functions reused unchanged
// for both runs — the newly unlocked leg either matches an existing priced entry those lookups
// already know about, or it doesn't and stays honestly unpriced (LotEvidenceQuality 'unpriced');
// this module never fetches a new price to make it look priced.
//
// STRICT ACCEPTANCE, DISCLOSED: only a decodeReceiptSwap result satisfying every one of this task's
// required conditions is ever replayed — everything else returns a typed rejection reason. Because
// decodeReceiptSwap itself already fails closed on ambiguity/mismatch/non-exact resolution before
// ever returning `ok: true` (see index.ts's own header), most of these checks are defensive
// restatements of guarantees the decoder already provides, not new logic layered on top.

import type { NormalizedEvent } from '../normalization/types'
import type { PriceUsdLookup, CurrentPriceUsdLookup, MatchedLot } from '../fifoEngine/types'
import { buildFifoOutput } from '../fifoEngine/index'
import type { DecodedReceiptSwap } from './types'
import { resolvePromotableLeg } from './receiptLegPromotionResolver'

export type ShadowRejectionReason =
  | 'not_exact_confidence'
  | 'not_two_sided_resolution'
  | 'protocol_not_recognized'
  | 'no_matching_incomplete_transaction'
  | 'multiple_incomplete_matches_ambiguous'
  | 'existing_leg_token_mismatch'
  | 'existing_leg_direction_unknown'
  | 'would_duplicate_transaction'

export type ShadowFifoReplayCounters = {
  exactReceiptSwapsEligible: number
  shadowTransactionsReplaced: number
  shadowDuplicateRejections: number
  fifoClosedLotsBefore: number
  fifoClosedLotsAfter: number
  unmatchedBuysBefore: number
  unmatchedBuysAfter: number
  unmatchedSellsBefore: number
  unmatchedSellsAfter: number
  newlyClosedLots: number
  newlyPricedClosedLots: number
  verifiedPricingCoverageBefore: number
  verifiedPricingCoverageAfter: number
  shadowRealizedPnlBefore: number | null
  shadowRealizedPnlAfter: number | null
  shadowPnlDeltaUsd: number | null
}

export type ShadowClosedLotSample = {
  token: string
  chain: string
  openedTxHash: string
  closedTxHash: string
  amount: number
  costBasisUsd: number | null
  proceedsUsd: number | null
  realizedPnlUsd: number | null
  evidenceQuality: MatchedLot['evidenceQuality']
}

export type ShadowFifoReplayResult = {
  shadowReplayAccepted: boolean
  rejectionReason: ShadowRejectionReason | null
  counters: ShadowFifoReplayCounters
  // Bounded to at most 5 — never an unbounded lot dump. Empty whenever shadowReplayAccepted is
  // false or no lot was newly closed.
  newlyClosedLotSamples: ShadowClosedLotSample[]
}

export type ShadowFifoReplayInput = {
  // Canonical, already-normalized events — READ ONLY. Cloned before any modification; the exact
  // same array/objects the caller passed in are never mutated.
  normalizedEvents: readonly NormalizedEvent[]
  walletAddress: string
  decodedSwap: DecodedReceiptSwap
  // Reused unchanged for both the "before" and "after" FIFO runs — see file header.
  priceUsdLookup?: PriceUsdLookup
  currentPriceUsdLookup?: CurrentPriceUsdLookup
}

const RECOGNIZED_PROTOCOLS = new Set(['aerodrome_classic', 'aerodrome_slipstream'])

function lotKey(lot: MatchedLot): string {
  return `${lot.chain}:${lot.openedTxHash}:${lot.closedTxHash}:${lot.token}:${lot.amount}`
}

function verifiedCoverage(lots: MatchedLot[]): number {
  if (lots.length === 0) return 0
  return lots.filter((l) => l.evidenceQuality === 'verified').length / lots.length
}

function zeroCounters(): ShadowFifoReplayCounters {
  return {
    exactReceiptSwapsEligible: 0,
    shadowTransactionsReplaced: 0,
    shadowDuplicateRejections: 0,
    fifoClosedLotsBefore: 0,
    fifoClosedLotsAfter: 0,
    unmatchedBuysBefore: 0,
    unmatchedBuysAfter: 0,
    unmatchedSellsBefore: 0,
    unmatchedSellsAfter: 0,
    newlyClosedLots: 0,
    newlyPricedClosedLots: 0,
    verifiedPricingCoverageBefore: 0,
    verifiedPricingCoverageAfter: 0,
    shadowRealizedPnlBefore: null,
    shadowRealizedPnlAfter: null,
    shadowPnlDeltaUsd: null,
  }
}

function rejected(reason: ShadowRejectionReason, extra: Partial<ShadowFifoReplayCounters> = {}): ShadowFifoReplayResult {
  return { shadowReplayAccepted: false, rejectionReason: reason, counters: { ...zeroCounters(), ...extra }, newlyClosedLotSamples: [] }
}

const MAX_CLOSED_LOT_SAMPLES = 5

function toClosedLotSample(lot: MatchedLot): ShadowClosedLotSample {
  return {
    token: lot.token,
    chain: lot.chain,
    openedTxHash: lot.openedTxHash,
    closedTxHash: lot.closedTxHash,
    amount: lot.amount,
    costBasisUsd: lot.costBasisUsd,
    proceedsUsd: lot.proceedsUsd,
    realizedPnlUsd: lot.realizedPnlUsd,
    evidenceQuality: lot.evidenceQuality,
  }
}

// PURE. Deep-clones `normalizedEvents` (plain data — JSON round-trip is exact and safe here, same
// convention already used elsewhere in this codebase for serialization-safety), locates the single
// matching one-leg transaction, and replaces it with both real legs — never mutating the original.
export function runShadowFifoReplay(input: ShadowFifoReplayInput): ShadowFifoReplayResult {
  const { decodedSwap } = input

  // STRICT ACCEPTANCE GATE, DISCLOSED — see file header: confidence exact, two-sided resolution
  // (both tokens real, non-empty addresses), and a recognized protocol. A non-reverted receipt and
  // "no ambiguity/mismatch" are already guaranteed by decodeReceiptSwap only ever returning
  // `ok: true` under those exact conditions (index.ts's own fail-closed contract) — restated here
  // defensively, never re-derived with different logic. Matching/missing-leg logic itself now lives
  // in receiptLegPromotionResolver.ts, shared with the real canonical-promotion path — see that
  // file's own header.
  const resolution = resolvePromotableLeg(input.normalizedEvents, input.walletAddress, decodedSwap, RECOGNIZED_PROTOCOLS)
  if (!resolution.ok) {
    if (resolution.reason === 'not_exact_confidence' || resolution.reason === 'protocol_not_recognized' || resolution.reason === 'not_two_sided_resolution') {
      return rejected(resolution.reason)
    }
    const eligibleCounters: Partial<ShadowFifoReplayCounters> = { exactReceiptSwapsEligible: 1 }
    if (resolution.reason === 'would_duplicate_transaction') {
      return rejected(resolution.reason, { ...eligibleCounters, shadowDuplicateRejections: 1 })
    }
    return rejected(resolution.reason, eligibleCounters)
  }
  const { missingEvent, existingIndex } = resolution

  // DEEP CLONE, DISCLOSED: plain-data JSON round-trip — exact, safe, and guarantees the original
  // `input.normalizedEvents` array/objects are never touched by the splice below.
  const cloned: NormalizedEvent[] = JSON.parse(JSON.stringify(input.normalizedEvents))
  // Deterministic ordering, disclosed: the new leg is inserted immediately after the existing one,
  // in-place — every other event keeps its original relative order.
  cloned.splice(existingIndex + 1, 0, missingEvent)

  const priceUsdLookup = input.priceUsdLookup
  const currentPriceUsdLookup = input.currentPriceUsdLookup

  const before = buildFifoOutput({
    normalizedEvents: [...input.normalizedEvents],
    recoveredRawEvents: [],
    walletAddress: input.walletAddress,
    priceUsdLookup,
    currentPriceUsdLookup,
  })
  const after = buildFifoOutput({
    normalizedEvents: cloned,
    recoveredRawEvents: [],
    walletAddress: input.walletAddress,
    priceUsdLookup,
    currentPriceUsdLookup,
  })

  const beforeKeys = new Set(before.matchedLots.map(lotKey))
  const newlyClosed = after.matchedLots.filter((l) => !beforeKeys.has(lotKey(l)))
  const newlyPriced = newlyClosed.filter((l) => l.evidenceQuality === 'verified')

  const realizedBefore = before.realizedPnlUsd
  const realizedAfter = after.realizedPnlUsd
  const pnlDelta = realizedBefore !== null && realizedAfter !== null ? realizedAfter - realizedBefore : null

  return {
    shadowReplayAccepted: true,
    rejectionReason: null,
    counters: {
      exactReceiptSwapsEligible: 1,
      shadowTransactionsReplaced: 1,
      shadowDuplicateRejections: 0,
      fifoClosedLotsBefore: before.matchedLots.length,
      fifoClosedLotsAfter: after.matchedLots.length,
      unmatchedBuysBefore: before.unmatchedBuys,
      unmatchedBuysAfter: after.unmatchedBuys,
      unmatchedSellsBefore: before.unmatchedSells,
      unmatchedSellsAfter: after.unmatchedSells,
      newlyClosedLots: newlyClosed.length,
      newlyPricedClosedLots: newlyPriced.length,
      verifiedPricingCoverageBefore: verifiedCoverage(before.matchedLots),
      verifiedPricingCoverageAfter: verifiedCoverage(after.matchedLots),
      shadowRealizedPnlBefore: realizedBefore,
      shadowRealizedPnlAfter: realizedAfter,
      shadowPnlDeltaUsd: pnlDelta,
    },
    newlyClosedLotSamples: newlyClosed.slice(0, MAX_CLOSED_LOT_SAMPLES).map(toClosedLotSample),
  }
}

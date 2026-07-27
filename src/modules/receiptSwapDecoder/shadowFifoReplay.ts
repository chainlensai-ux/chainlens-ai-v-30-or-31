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

export type ShadowFifoReplayResult = {
  shadowReplayAccepted: boolean
  rejectionReason: ShadowRejectionReason | null
  counters: ShadowFifoReplayCounters
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
  return { shadowReplayAccepted: false, rejectionReason: reason, counters: { ...zeroCounters(), ...extra } }
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
  // defensively, never re-derived with different logic.
  if (decodedSwap.confidence !== 'exact') return rejected('not_exact_confidence')
  if (!RECOGNIZED_PROTOCOLS.has(decodedSwap.protocol)) return rejected('protocol_not_recognized')
  if (!decodedSwap.tokenIn.address || !decodedSwap.tokenOut.address || decodedSwap.tokenIn.address === decodedSwap.tokenOut.address) {
    return rejected('not_two_sided_resolution')
  }

  const eligibleCounters: Partial<ShadowFifoReplayCounters> = { exactReceiptSwapsEligible: 1 }

  const txHashLower = decodedSwap.txHash.toLowerCase()
  const matchIndices: number[] = []
  input.normalizedEvents.forEach((e, i) => {
    if (e.chain === decodedSwap.chain && e.txHash.toLowerCase() === txHashLower) matchIndices.push(i)
  })

  if (matchIndices.length === 0) return rejected('no_matching_incomplete_transaction', eligibleCounters)
  if (matchIndices.length > 2) return rejected('multiple_incomplete_matches_ambiguous', eligibleCounters)

  if (matchIndices.length === 2) {
    // ALREADY COMPLETE, NOT AMBIGUOUS, DISCLOSED: exactly two events for this tx that already match
    // the decoded swap's own (tokenIn, outbound) + (tokenOut, inbound) pair is a transaction that
    // already carries both real legs — there is no "incomplete transaction" left to replace, and
    // replaying it would only ever create a duplicate. A pair that does NOT match that shape (e.g.
    // two unrelated events sharing a txHash) is genuinely ambiguous instead.
    const [a, b] = matchIndices.map((i) => input.normalizedEvents[i])
    const isCompletePair = (x: NormalizedEvent, y: NormalizedEvent) =>
      x.direction === 'outbound' && x.contract.toLowerCase() === decodedSwap.tokenIn.address.toLowerCase()
      && y.direction === 'inbound' && y.contract.toLowerCase() === decodedSwap.tokenOut.address.toLowerCase()
    if (isCompletePair(a, b) || isCompletePair(b, a)) {
      return rejected('would_duplicate_transaction', { ...eligibleCounters, shadowDuplicateRejections: 1 })
    }
    return rejected('multiple_incomplete_matches_ambiguous', eligibleCounters)
  }

  const existingIndex = matchIndices[0]
  const existingEvent = input.normalizedEvents[existingIndex]

  if (existingEvent.direction !== 'inbound' && existingEvent.direction !== 'outbound') {
    return rejected('existing_leg_direction_unknown', eligibleCounters)
  }

  const existingContract = existingEvent.contract.toLowerCase()
  let missingEvent: NormalizedEvent
  if (existingEvent.direction === 'outbound') {
    if (existingContract !== decodedSwap.tokenIn.address.toLowerCase()) return rejected('existing_leg_token_mismatch', eligibleCounters)
    missingEvent = {
      provider: existingEvent.provider,
      chain: decodedSwap.chain,
      txHash: existingEvent.txHash,
      timestamp: existingEvent.timestamp,
      fromAddress: decodedSwap.poolAddress,
      toAddress: input.walletAddress,
      contract: decodedSwap.tokenOut.address,
      symbol: decodedSwap.tokenOut.symbol,
      amount: decodedSwap.normalizedAmountOut,
      amountRaw: decodedSwap.amountOutRaw,
      tokenDecimals: decodedSwap.decimals.tokenOut,
      direction: 'inbound',
    }
  } else {
    if (existingContract !== decodedSwap.tokenOut.address.toLowerCase()) return rejected('existing_leg_token_mismatch', eligibleCounters)
    missingEvent = {
      provider: existingEvent.provider,
      chain: decodedSwap.chain,
      txHash: existingEvent.txHash,
      timestamp: existingEvent.timestamp,
      fromAddress: input.walletAddress,
      toAddress: decodedSwap.poolAddress,
      contract: decodedSwap.tokenIn.address,
      symbol: decodedSwap.tokenIn.symbol,
      amount: decodedSwap.normalizedAmountIn,
      amountRaw: decodedSwap.amountInRaw,
      tokenDecimals: decodedSwap.decimals.tokenIn,
      direction: 'outbound',
    }
  }

  // NO DUPLICATE TRANSACTION/LEG, DISCLOSED: a canonical set that already carries BOTH sides for
  // this tx (an event matching the missing leg's exact chain/txHash/contract/direction already
  // present) means this transaction is already complete — replaying would create a duplicate leg,
  // never accepted.
  const wouldDuplicate = input.normalizedEvents.some(
    (e) => e.chain === missingEvent.chain
      && e.txHash.toLowerCase() === txHashLower
      && e.contract.toLowerCase() === missingEvent.contract.toLowerCase()
      && e.direction === missingEvent.direction,
  )
  if (wouldDuplicate) {
    return rejected('would_duplicate_transaction', { ...eligibleCounters, shadowDuplicateRejections: 1 })
  }

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
  }
}

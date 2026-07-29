// MODULE — receiptSwapDecoder: shared, pure resolver for "does this exact receipt-decoded swap fill
// a genuinely missing canonical leg for this exact transaction, and if so, what is that missing
// leg" — extracted from shadowFifoReplay.ts (unchanged behavior there) so BOTH the pure shadow
// measurement path (shadowFifoReplay.ts) and the real, flag-gated canonical promotion path
// (canonicalPromotion.ts) share the exact same matching/rejection logic rather than two independently
// maintained copies that could silently diverge.
//
// PURE, DISCLOSED: no I/O, no provider calls, no mutation of its `events` input — returns a plain
// missing-leg description or a typed rejection reason. `recognizedProtocols` is caller-supplied so
// each caller can scope which protocols it trusts (shadowFifoReplay.ts keeps its own original,
// narrower set; canonicalPromotion.ts uses its own, separately disclosed set) without this shared
// module hardcoding either caller's policy.

import type { NormalizedEvent } from '../normalization/types'
import type { DecodedReceiptSwap } from './types'

export type PromotableLegRejectionReason =
  | 'not_exact_confidence'
  | 'not_two_sided_resolution'
  | 'protocol_not_recognized'
  | 'no_matching_incomplete_transaction'
  | 'multiple_incomplete_matches_ambiguous'
  | 'existing_leg_token_mismatch'
  | 'existing_leg_direction_unknown'
  | 'would_duplicate_transaction'

export type PromotableLegResolution =
  | { ok: true; missingEvent: NormalizedEvent; existingIndex: number }
  | { ok: false; reason: PromotableLegRejectionReason }

// PURE. Never mutates `events`. Requires exactly one existing, incomplete (one-sided) canonical
// event for this exact (chain, txHash) whose own token/direction is consistent with the decoded
// swap's own tokenIn/tokenOut before proposing the missing opposite leg — every ambiguity (zero
// matches, more than two matches, an already-complete pair, a token/direction mismatch, a duplicate
// of the proposed leg) fails closed with a real, attributable reason, never a guess.
export function resolvePromotableLeg(
  events: readonly NormalizedEvent[],
  walletAddress: string,
  decodedSwap: DecodedReceiptSwap,
  recognizedProtocols: ReadonlySet<string>,
): PromotableLegResolution {
  if (decodedSwap.confidence !== 'exact') return { ok: false, reason: 'not_exact_confidence' }
  if (!recognizedProtocols.has(decodedSwap.protocol)) return { ok: false, reason: 'protocol_not_recognized' }
  if (!decodedSwap.tokenIn.address || !decodedSwap.tokenOut.address || decodedSwap.tokenIn.address === decodedSwap.tokenOut.address) {
    return { ok: false, reason: 'not_two_sided_resolution' }
  }

  const txHashLower = decodedSwap.txHash.toLowerCase()
  const matchIndices: number[] = []
  events.forEach((e, i) => {
    if (e.chain === decodedSwap.chain && e.txHash.toLowerCase() === txHashLower) matchIndices.push(i)
  })

  if (matchIndices.length === 0) return { ok: false, reason: 'no_matching_incomplete_transaction' }
  if (matchIndices.length > 2) return { ok: false, reason: 'multiple_incomplete_matches_ambiguous' }

  if (matchIndices.length === 2) {
    // ALREADY COMPLETE, NOT AMBIGUOUS, DISCLOSED: exactly two events for this tx that already match
    // the decoded swap's own (tokenIn, outbound) + (tokenOut, inbound) pair is a transaction that
    // already carries both real legs — nothing missing to fill. A pair that does NOT match that
    // shape (e.g. two unrelated events sharing a txHash) is genuinely ambiguous instead.
    const [a, b] = matchIndices.map((i) => events[i])
    const isCompletePair = (x: NormalizedEvent, y: NormalizedEvent) =>
      x.direction === 'outbound' && x.contract.toLowerCase() === decodedSwap.tokenIn.address.toLowerCase()
      && y.direction === 'inbound' && y.contract.toLowerCase() === decodedSwap.tokenOut.address.toLowerCase()
    if (isCompletePair(a, b) || isCompletePair(b, a)) {
      return { ok: false, reason: 'would_duplicate_transaction' }
    }
    return { ok: false, reason: 'multiple_incomplete_matches_ambiguous' }
  }

  const existingIndex = matchIndices[0]
  const existingEvent = events[existingIndex]

  if (existingEvent.direction !== 'inbound' && existingEvent.direction !== 'outbound') {
    return { ok: false, reason: 'existing_leg_direction_unknown' }
  }

  const existingContract = existingEvent.contract.toLowerCase()
  let missingEvent: NormalizedEvent
  if (existingEvent.direction === 'outbound') {
    if (existingContract !== decodedSwap.tokenIn.address.toLowerCase()) return { ok: false, reason: 'existing_leg_token_mismatch' }
    missingEvent = {
      provider: existingEvent.provider,
      chain: decodedSwap.chain,
      txHash: existingEvent.txHash,
      timestamp: existingEvent.timestamp,
      fromAddress: decodedSwap.poolAddress,
      toAddress: walletAddress,
      contract: decodedSwap.tokenOut.address,
      symbol: decodedSwap.tokenOut.symbol,
      amount: decodedSwap.normalizedAmountOut,
      amountRaw: decodedSwap.amountOutRaw,
      tokenDecimals: decodedSwap.decimals.tokenOut,
      direction: 'inbound',
    }
  } else {
    if (existingContract !== decodedSwap.tokenOut.address.toLowerCase()) return { ok: false, reason: 'existing_leg_token_mismatch' }
    missingEvent = {
      provider: existingEvent.provider,
      chain: decodedSwap.chain,
      txHash: existingEvent.txHash,
      timestamp: existingEvent.timestamp,
      fromAddress: walletAddress,
      toAddress: decodedSwap.poolAddress,
      contract: decodedSwap.tokenIn.address,
      symbol: decodedSwap.tokenIn.symbol,
      amount: decodedSwap.normalizedAmountIn,
      amountRaw: decodedSwap.amountInRaw,
      tokenDecimals: decodedSwap.decimals.tokenIn,
      direction: 'outbound',
    }
  }

  // NO DUPLICATE TRANSACTION/LEG, DISCLOSED: a canonical set that already carries the proposed
  // missing leg (same chain/txHash/contract/direction) means there is nothing left to add.
  const wouldDuplicate = events.some(
    (e) => e.chain === missingEvent.chain
      && e.txHash.toLowerCase() === txHashLower
      && e.contract.toLowerCase() === missingEvent.contract.toLowerCase()
      && e.direction === missingEvent.direction,
  )
  if (wouldDuplicate) return { ok: false, reason: 'would_duplicate_transaction' }

  return { ok: true, missingEvent, existingIndex }
}

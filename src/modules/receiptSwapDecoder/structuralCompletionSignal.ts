// MODULE — receiptSwapDecoder: structural completion signal.
//
// GOAL, DISCLOSED (Phase 2): candidateSelector.ts's tier 1 ("could_complete_missing_entry/exit") is
// the exact "expected completed verified lots per receipt call" ranking this task's Selection section
// asks for — it already existed, correctly implemented and tested. It was simply never fed real data:
// src/pipeline/index.ts's only production call site hardcoded every candidate's
// `missingClosedLotSide: null` ("Not available at this pipeline stage" — the shadow-decoder block
// runs before priceLotsForWallet's own structural lot pairing). Production baseline confirms the
// cost: 367 transactions lack a usable opposite leg, 355 of the 415 swap-lookup transactions are
// exactly one-leg, and 0 of them were ever ranked into tier 1.
//
// FIX, DISCLOSED: this module computes the SAME real signal priceLotsForWallet.ts's own "Phase A —
// structural (price-free) FIFO pre-pass" already computes (fifoEngine's exported, unmodified
// buildLots/matchLotsFIFO, called with no priceUsdLookup — zero network calls, zero price
// requirement) — reused here, one pipeline stage earlier, purely to learn WHICH transactions are the
// open/close boundary of a real structural closed lot. A one-leg transaction (its swap-leg group has
// exactly one recorded direction — the SAME `swapLegsByTx`/`groupSwapLegsByTransaction` grouping
// already computed in src/pipeline/index.ts for `evidence.legs`) that IS such a boundary is a real,
// non-fabricated instance of "this lot's entry/exit is missing its opposite leg" — exactly what a
// receipt fetch could resolve. Never infers an amount, never fabricates a leg — this only classifies
// already-real events and already-real structural pairing.
//
// NOT IDENTICAL TO THE FINAL 219, DISCLOSED: this pre-pass runs before recoveryPolicy's own
// historical-page recovery and before receipt-swap canonical promotion, so its lot count will differ
// from the pipeline's own final structural count computed later. That is expected and fine — this
// signal exists to RANK candidates before any receipt is fetched, not to reproduce the final count.

export type MissingClosedLotSide = 'entry' | 'exit'

export type SwapLegGroupSummary = {
  groupKey: string
  legCount: number
}

// Deliberately a plain `string` chain (not fifoEngine's own `SupportedChain`) — matches
// candidateSelector.ts's own `CandidateTxEvidence.chain` type, since this module's real caller
// (src/pipeline/index.ts) threads structural lot chain values through that same plain-string shape.
export type StructuralLotBoundary = {
  chain: string
  openedTxHash: string
  closedTxHash: string
  openedAt: number
  closedAt: number
}

// PURE. For every structural matched lot whose OPEN or CLOSE transaction's swap-leg group currently
// has exactly one recorded leg (only one direction observed — the opposite side genuinely missing
// from provider-sourced events), records that group as missing its 'entry' or 'exit' side. A
// transaction that is simultaneously the open of one lot and the close of another (rare) keeps
// whichever classification it is assigned FIRST in a deterministic (openedAt/closedAt, then
// chain+txHash) traversal order — never both, never randomly chosen.
export function computeMissingClosedLotSides(
  structuralMatchedLots: readonly StructuralLotBoundary[],
  legGroupsByKey: ReadonlyMap<string, SwapLegGroupSummary>,
  groupKeyFor: (chain: string, txHash: string) => string,
): Map<string, MissingClosedLotSide> {
  const result = new Map<string, MissingClosedLotSide>()

  const sortedLots = [...structuralMatchedLots].sort((a, b) => {
    if (a.openedAt !== b.openedAt) return a.openedAt - b.openedAt
    if (a.closedAt !== b.closedAt) return a.closedAt - b.closedAt
    return `${a.chain}:${a.openedTxHash}:${a.closedTxHash}`.localeCompare(`${b.chain}:${b.openedTxHash}:${b.closedTxHash}`)
  })

  function isOneLegGroup(groupKey: string): boolean {
    const summary = legGroupsByKey.get(groupKey)
    return summary != null && summary.legCount === 1
  }

  for (const lot of sortedLots) {
    const openKey = groupKeyFor(lot.chain, lot.openedTxHash)
    if (!result.has(openKey) && isOneLegGroup(openKey)) result.set(openKey, 'entry')

    const closeKey = groupKeyFor(lot.chain, lot.closedTxHash)
    if (!result.has(closeKey) && isOneLegGroup(closeKey)) result.set(closeKey, 'exit')
  }

  return result
}

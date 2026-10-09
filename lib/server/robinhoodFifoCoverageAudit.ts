// Robinhood FIFO coverage audit — DIAGNOSTIC ONLY (never changes verification, pricing, FIFO, budgets or selection).
//
// For every verified sell: does the wallet's observed activity (the full merged activity set, BEFORE staged receipt
// truncation) contain an earlier inbound transfer of the sold token, and if so, what happened to that transaction in
// this scan — never entered the candidate pool, dropped by the staged receipt budget, receipt unchecked, attribution
// rejected, verified but unpriced, or a priced acquisition lot? An inbound transfer is only evidence that an
// acquisition CANDIDATE exists; it is never a buy by itself.

export type RhFifoBlocker =
  | 'no_earlier_inbound_exists' | 'earlier_inbound_dropped_by_candidate_budget' | 'earlier_inbound_receipt_unchecked'
  | 'earlier_inbound_rejected_attribution' | 'earlier_inbound_unpriced' | 'insufficient_verified_quantity'
  | 'acquisition_after_sell_only' | 'closed_lot_possible' | 'ambiguous'

type Swap = { txHash: string; timestampSec: number; inputToken: string; outputToken: string; inputRaw: bigint; outputRaw: bigint }
type Evidence = { swapTxHash: string; bothLegsVerified: boolean }
type Outcome = { txHash: string; receiptFetched: boolean; rejection: string | null; swap: unknown | null }
type Inbound = { txHash: string; timestampMs: number | null; token: string; rawAmount: string | null }

export type RhFifoCoverageInput = {
  wallet: string
  isQuote: (token: string) => boolean
  /** Every verified swap of the scan (main + acquisition recovery + deep acquisition). */
  swaps: readonly Swap[]
  evidence: readonly Evidence[]
  matchedLots: ReadonlyArray<{ openedTxHash: string; closedTxHash: string; token: string }>
  /** The full merged activity inbound token rows (observational universe, before staged truncation). */
  inbound: readonly Inbound[]
  /** Every candidate tx the PnL lane was given (before the stage-1 cap and the staged budget). */
  candidatePool: readonly string[]
  /** Stage-1 selection (the first receipt sample). */
  selectedStage1: readonly string[]
  /** Every main-lane receipt outcome (stage 1 + staged stage 2). */
  outcomes: readonly Outcome[]
  /** Txs with a resolved (complete) native trace this scan. */
  tracedTxHashes: ReadonlySet<string>
  recovery: { sellTxHash: string | null; candidatesFound: number; recoveredBuyCount: number; classifications: Record<string, number> } | null
}

export type RhFifoInboundRow = {
  txHash: string; rawAmount: string | null; timestampMs: number | null
  inCandidatePool: boolean
  stage: 'stage1_selected' | 'stage2_checked' | 'dropped_by_candidate_budget' | 'selected_receipt_unchecked' | 'not_in_candidate_pool' | 'verified_by_recovery'
  receiptChecked: boolean
  preTraceClassification: string | null
  traceEvidence: boolean
  attribution: 'verified_buy_of_token' | 'verified_other_swap' | 'rejected' | 'not_checked'
  pricing: 'both_legs_priced' | 'unpriced' | null
  lotReason: string
}

export type RhFifoCoverageSellRow = {
  sellTxHash: string; token: string; sellTimestamp: number; sellRaw: string; sellVerified: true; sellBothLegPriced: boolean
  earlierInboundCandidatesInFullActivity: number
  earlierInboundCandidatesInSelected20: number
  earlierInboundCandidatesInStage2Checked: number
  earlierInboundCandidatesDroppedByBudget: number
  earlierInboundTxHashes: string[]
  earlierInbound: RhFifoInboundRow[]
  laterInboundTxHashes: string[]
  inboundUnknownTimestampCount: number
  earliestInboundTimestamp: number | null
  inboundRawTotal: string
  inboundRawBeforeSell: string
  acquisitionRecoveryAttempted: boolean
  acquisitionRecoveryResult: string | null
  verifiedAcquisitionLots: number
  verifiedAcquisitionRaw: string
  pricedAcquisitionLots: number
  closedLotsForSell: number
  /** Upper bound: min(sellRaw, priced verified acquisition raw before the sell) — other sells may consume it first. */
  closedRawPossible: string
  fifoBlocker: RhFifoBlocker
}

export type RhFifoCoverageSummary = {
  verifiedSwapCount: number; verifiedBuyCount: number; verifiedSellCount: number
  bothLegPricedBuyCount: number; bothLegPricedSellCount: number; verifiedClosedLotCount: number
  verifiedSellCountWithEarlierInboundCandidate: number
  verifiedSellCountBlockedOnlyByCandidateBudget: number
  verifiedSellCountBlockedByAttribution: number
  verifiedSellCountBlockedByPricing: number
  verifiedSellCountWithNoEarlierInboundAtAll: number
  /** Earliest timestamp of any observed activity row: nothing before it was observable in this scan. */
  observationalWindowStartMs: number | null
  blockers: Partial<Record<RhFifoBlocker, number>>
}

const lower = (s: string) => s.toLowerCase()
const ZERO = BigInt(0)
const raw = (s: string | null) => (s != null && /^\d+$/.test(s) ? BigInt(s) : null)

/** PURE. One row per verified sell plus a summary. */
export function robinhoodFifoCoverageAudit(input: RhFifoCoverageInput): { sells: RhFifoCoverageSellRow[]; summary: RhFifoCoverageSummary } {
  const priced = new Set(input.evidence.filter((e) => e.bothLegsVerified).map((e) => lower(e.swapTxHash)))
  const swaps = input.swaps.map((s) => ({ ...s, txHash: lower(s.txHash), inputToken: lower(s.inputToken), outputToken: lower(s.outputToken) }))
  const isSell = (s: Swap) => !input.isQuote(s.inputToken) && input.isQuote(s.outputToken)
  const isBuy = (s: Swap) => input.isQuote(s.inputToken) && !input.isQuote(s.outputToken)
  const sells = swaps.filter(isSell)
  const buys = swaps.filter(isBuy)
  const pool = new Set(input.candidatePool.map(lower))
  const stage1 = new Set(input.selectedStage1.map(lower))
  const outcomes = new Map(input.outcomes.map((o) => [lower(o.txHash), o]))
  const swapByHash = new Map(swaps.map((s) => [s.txHash, s]))
  // Duplicate activity rows (same tx, token, amount, time) count once.
  const seen = new Set<string>()
  const inbound = input.inbound
    .map((r) => ({ ...r, txHash: lower(r.txHash), token: lower(r.token) }))
    .filter((r) => { const k = `${r.txHash}|${r.token}|${r.rawAmount}|${r.timestampMs}`; if (seen.has(k)) return false; seen.add(k); return true })
  const windowStarts = inbound.map((r) => r.timestampMs).filter((t): t is number => t != null)

  const rows: RhFifoCoverageSellRow[] = sells.map((sell) => {
    const token = sell.inputToken
    const sellMs = sell.timestampSec * 1000
    const ofToken = inbound.filter((r) => r.token === token && r.txHash !== sell.txHash)
    const earlier = ofToken.filter((r) => r.timestampMs != null && r.timestampMs < sellMs)
    const later = ofToken.filter((r) => r.timestampMs != null && r.timestampMs >= sellMs)
    const unknownTs = ofToken.filter((r) => r.timestampMs == null)
    const detail: RhFifoInboundRow[] = earlier.map((r) => {
      const o = outcomes.get(r.txHash)
      const sw = swapByHash.get(r.txHash)
      const inPool = pool.has(r.txHash)
      const stage: RhFifoInboundRow['stage'] = o?.receiptFetched ? (stage1.has(r.txHash) ? 'stage1_selected' : 'stage2_checked')
        : o ? 'selected_receipt_unchecked'
        : sw ? 'verified_by_recovery'
        : inPool ? 'dropped_by_candidate_budget' : 'not_in_candidate_pool'
      const verifiedBuy = sw != null && isBuy(sw) && sw.outputToken === token
      const attribution: RhFifoInboundRow['attribution'] = verifiedBuy ? 'verified_buy_of_token' : sw ? 'verified_other_swap' : o?.receiptFetched ? 'rejected' : 'not_checked'
      const pricing = verifiedBuy ? (priced.has(r.txHash) ? 'both_legs_priced' : 'unpriced') : null
      const lotReason = verifiedBuy ? (pricing === 'both_legs_priced' ? 'priced_acquisition_lot' : 'verified_buy_unpriced')
        : sw ? 'verified_swap_is_not_a_buy_of_the_sold_token'
        : stage === 'dropped_by_candidate_budget' ? 'receipt_never_checked_staged_budget'
        : stage === 'not_in_candidate_pool' ? 'not_a_pnl_candidate'
        : stage === 'selected_receipt_unchecked' ? `receipt_unchecked:${o?.rejection ?? 'unknown'}`
        : `attribution_rejected:${o?.rejection ?? 'unknown'}`
      return {
        txHash: r.txHash, rawAmount: r.rawAmount, timestampMs: r.timestampMs, inCandidatePool: inPool, stage, receiptChecked: o?.receiptFetched === true,
        preTraceClassification: o ? (o.swap ? 'accepted' : o.rejection) : null, traceEvidence: input.tracedTxHashes.has(r.txHash), attribution, pricing, lotReason,
      }
    })
    const acq = buys.filter((b) => b.outputToken === token && b.timestampSec * 1000 < sellMs)
    const acqPriced = acq.filter((b) => priced.has(b.txHash))
    const acqRaw = acq.reduce((t, b) => t + b.outputRaw, ZERO)
    const pricedRaw = acqPriced.reduce((t, b) => t + b.outputRaw, ZERO)
    const closed = input.matchedLots.filter((l) => lower(l.closedTxHash) === sell.txHash).length
    const sumRaw = (rs: typeof ofToken) => rs.reduce((t, r) => t + (raw(r.rawAmount) ?? ZERO), ZERO)
    const rec = input.recovery && lower(input.recovery.sellTxHash ?? '') === sell.txHash ? input.recovery : null
    const blocker: RhFifoBlocker = closed > 0 ? 'closed_lot_possible'
      : ofToken.length === 0 && acq.length === 0 ? 'no_earlier_inbound_exists'
      : earlier.length === 0 && acq.length === 0 ? (unknownTs.length > 0 ? 'ambiguous' : later.length > 0 ? 'acquisition_after_sell_only' : 'no_earlier_inbound_exists')
      : pricedRaw > ZERO ? 'insufficient_verified_quantity' // a priced lot exists but FIFO closed nothing against this sell
      : acq.length > 0 ? 'earlier_inbound_unpriced'
      : detail.some((d) => d.stage === 'dropped_by_candidate_budget') ? 'earlier_inbound_dropped_by_candidate_budget'
      : detail.some((d) => d.stage === 'selected_receipt_unchecked') ? 'earlier_inbound_receipt_unchecked'
      : detail.some((d) => d.attribution === 'rejected' || d.attribution === 'verified_other_swap') ? 'earlier_inbound_rejected_attribution'
      : 'ambiguous'
    return {
      sellTxHash: sell.txHash, token, sellTimestamp: sell.timestampSec, sellRaw: sell.inputRaw.toString(), sellVerified: true, sellBothLegPriced: priced.has(sell.txHash),
      earlierInboundCandidatesInFullActivity: earlier.length,
      earlierInboundCandidatesInSelected20: detail.filter((d) => d.stage === 'stage1_selected').length,
      earlierInboundCandidatesInStage2Checked: detail.filter((d) => d.stage === 'stage2_checked').length,
      earlierInboundCandidatesDroppedByBudget: detail.filter((d) => d.stage === 'dropped_by_candidate_budget').length,
      earlierInboundTxHashes: [...new Set(earlier.map((r) => r.txHash))],
      earlierInbound: detail,
      laterInboundTxHashes: [...new Set(later.map((r) => r.txHash))],
      inboundUnknownTimestampCount: unknownTs.length,
      earliestInboundTimestamp: ofToken.reduce<number | null>((m, r) => (r.timestampMs != null && (m == null || r.timestampMs < m) ? r.timestampMs : m), null),
      inboundRawTotal: sumRaw(ofToken).toString(),
      inboundRawBeforeSell: sumRaw(earlier).toString(),
      acquisitionRecoveryAttempted: rec != null,
      acquisitionRecoveryResult: rec ? (rec.recoveredBuyCount > 0 ? `recovered_${rec.recoveredBuyCount}` : rec.candidatesFound === 0 ? 'no_earlier_inbound_of_sold_token' : `no_recovery:${Object.keys(rec.classifications).join(',') || 'none'}`) : null,
      verifiedAcquisitionLots: acq.length,
      verifiedAcquisitionRaw: acqRaw.toString(),
      pricedAcquisitionLots: acqPriced.length,
      closedLotsForSell: closed,
      closedRawPossible: (pricedRaw < sell.inputRaw ? pricedRaw : sell.inputRaw).toString(),
      fifoBlocker: blocker,
    }
  })
  const count = (b: RhFifoBlocker) => rows.filter((r) => r.fifoBlocker === b).length
  const blockers: Partial<Record<RhFifoBlocker, number>> = {}
  for (const r of rows) blockers[r.fifoBlocker] = (blockers[r.fifoBlocker] ?? 0) + 1
  return {
    sells: rows,
    summary: {
      verifiedSwapCount: swaps.length, verifiedBuyCount: buys.length, verifiedSellCount: sells.length,
      bothLegPricedBuyCount: buys.filter((b) => priced.has(b.txHash)).length, bothLegPricedSellCount: sells.filter((s) => priced.has(s.txHash)).length,
      verifiedClosedLotCount: input.matchedLots.length,
      verifiedSellCountWithEarlierInboundCandidate: rows.filter((r) => r.earlierInboundCandidatesInFullActivity > 0).length,
      verifiedSellCountBlockedOnlyByCandidateBudget: rows.filter((r) => r.fifoBlocker === 'earlier_inbound_dropped_by_candidate_budget'
        && r.earlierInbound.every((d) => d.stage === 'dropped_by_candidate_budget' || d.attribution === 'not_checked')).length,
      verifiedSellCountBlockedByAttribution: count('earlier_inbound_rejected_attribution'),
      verifiedSellCountBlockedByPricing: count('earlier_inbound_unpriced'),
      verifiedSellCountWithNoEarlierInboundAtAll: rows.filter((r) => r.earlierInboundCandidatesInFullActivity === 0 && r.verifiedAcquisitionLots === 0).length,
      observationalWindowStartMs: windowStarts.length ? Math.min(...windowStarts) : null,
      blockers,
    },
  }
}

// MODULE — walletScannerPipelineAudit (Wallet Scanner audit, Item 11).
//
// GOAL, DISCLOSED: a single, compact, stage-by-stage funnel object — raw provider events all the
// way through to the final PnL status — so an operator can see exactly which stage a wallet's
// evidence was lost at, without cross-referencing half a dozen separate per-module audit objects.
//
// HARD SCOPE, DISCLOSED. This module is PURE and READ-ONLY: it makes zero provider calls, performs
// zero pricing, and never mutates any upstream value. Every field is either a real count already
// produced by an earlier pipeline stage (re-read, never recomputed with different logic) or a cheap,
// deterministic re-derivation of already-fetched data (e.g. a dedupe-key Set over events already in
// hand). A field this layer has no real visibility into is honestly `null`, never fabricated —
// `robinhoodVerifiedSwaps` is always `null` here because this V2 Base/ETH pipeline never touches the
// separate, standalone Robinhood scanner (lib/server/robinhoodWalletScanner.ts) at all; that scanner
// builds its own equivalent proof object (robinhoodPnlVerificationAudit) independently.

import type { EventClassification } from '../modules/eventClassification/index'

export type PipelineFailureStage =
  | 'provider_fetch'
  | 'normalization'
  | 'classification'
  | 'fifo_matching'
  | 'pricing_verification'
  | null

export type WalletScannerPipelineAudit = {
  wallet: string
  chains: string[]
  rawEvents: number
  normalizedEvents: number
  dedupedEvents: number
  inboundEvents: number
  outboundEvents: number
  distributionsExcluded: number
  knownRouterHits: number
  routerCandidates: number
  routersAccepted: number
  swapCandidates: number | null
  receiptCandidates: number | null
  receiptsFetched: number | null
  receiptBudgetRejected: number
  verifiedBuys: number
  verifiedSells: number
  fifoInputBuys: number
  fifoInputSells: number
  closedLots: number
  verifiedClosedLots: number
  pricingCoverage: number | null
  quoteLegsRecovered: number
  recoveryCalls: number
  robinhoodVerifiedSwaps: null
  finalPnlStatus: 'ok' | 'limited_verified_sample' | 'unavailable'
  firstFailureStage: PipelineFailureStage
  exactFailureReason: string | null
}

function firstFailureStageFor(params: {
  rawEvents: number
  normalizedEvents: number
  fifoInputBuys: number
  fifoInputSells: number
  closedLots: number
  verifiedClosedLots: number
  finalPnlStatus: WalletScannerPipelineAudit['finalPnlStatus']
}): PipelineFailureStage {
  if (params.finalPnlStatus === 'ok') return null
  if (params.rawEvents === 0) return 'provider_fetch'
  if (params.normalizedEvents === 0) return 'normalization'
  if (params.fifoInputBuys === 0 && params.fifoInputSells === 0) return 'classification'
  if (params.closedLots === 0) return 'fifo_matching'
  return 'pricing_verification'
}

export function buildWalletScannerPipelineAudit(input: {
  wallet: string
  chains: readonly string[]
  rawEventCount: number
  normalizedEventCount: number
  dedupedEventCount: number
  inboundEventCount: number
  outboundEventCount: number
  eventsByClassification: Record<EventClassification, number>
  knownRouterHits: number
  routerCandidates: number
  swapCandidates: number | null
  receiptCandidates: number | null
  receiptsFetched: number | null
  receiptBudgetRejected: number
  verifiedBuys: number
  verifiedSells: number
  fifoInputBuys: number
  fifoInputSells: number
  closedLots: number
  verifiedClosedLots: number
  quoteLegsRecovered: number
  recoveryCalls: number
  finalPnlStatus: WalletScannerPipelineAudit['finalPnlStatus']
  exactFailureReason: string | null
}): WalletScannerPipelineAudit {
  const pricingCoverage = input.closedLots > 0
    ? Math.round((input.verifiedClosedLots / input.closedLots) * 10000) / 10000
    : null

  const finalPnlStatus = input.finalPnlStatus
  const firstFailureStage = firstFailureStageFor({
    rawEvents: input.rawEventCount,
    normalizedEvents: input.normalizedEventCount,
    fifoInputBuys: input.fifoInputBuys,
    fifoInputSells: input.fifoInputSells,
    closedLots: input.closedLots,
    verifiedClosedLots: input.verifiedClosedLots,
    finalPnlStatus,
  })

  return {
    wallet: input.wallet,
    chains: [...input.chains],
    rawEvents: input.rawEventCount,
    normalizedEvents: input.normalizedEventCount,
    dedupedEvents: input.dedupedEventCount,
    inboundEvents: input.inboundEventCount,
    outboundEvents: input.outboundEventCount,
    distributionsExcluded: input.eventsByClassification.distribution_airdrop,
    knownRouterHits: input.knownRouterHits,
    routerCandidates: input.routerCandidates,
    // A verified-registry router hit never needs inference to be trusted — it is "accepted" by
    // construction, the same known ∪ high-confidence-inferred rule Item 1 established.
    routersAccepted: input.knownRouterHits,
    swapCandidates: input.swapCandidates,
    receiptCandidates: input.receiptCandidates,
    receiptsFetched: input.receiptsFetched,
    receiptBudgetRejected: input.receiptBudgetRejected,
    verifiedBuys: input.verifiedBuys,
    verifiedSells: input.verifiedSells,
    fifoInputBuys: input.fifoInputBuys,
    fifoInputSells: input.fifoInputSells,
    closedLots: input.closedLots,
    verifiedClosedLots: input.verifiedClosedLots,
    pricingCoverage,
    quoteLegsRecovered: input.quoteLegsRecovered,
    recoveryCalls: input.recoveryCalls,
    robinhoodVerifiedSwaps: null,
    finalPnlStatus,
    firstFailureStage,
    exactFailureReason: finalPnlStatus === 'ok' ? null : input.exactFailureReason,
  }
}

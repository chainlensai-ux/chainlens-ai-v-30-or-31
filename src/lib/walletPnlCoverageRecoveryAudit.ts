// MODULE — walletPnlCoverageRecoveryAudit (verified-coverage recovery task).
//
// GOAL, DISCLOSED: when Wallet Scanner withholds official PnL because verified coverage sits below
// the 50% gate, say exactly WHY, per lot, in terms an operator can act on — instead of the current
// single opaque "PnL unavailable due to missing evidence" line. Confirmed live shape this exists to
// explain: 51 verified / 110 closed lots = 46.36%, 5 recovery candidates triggered but only 3
// funded.
//
// HARD SCOPE, DISCLOSED. This module is PURE and READ-ONLY:
//   - it makes zero provider calls and performs zero pricing
//   - it never mutates lots, events, timelines or the recovery policy
//   - it never promotes, creates, or reclassifies a lot — it only COUNTS and EXPLAINS what the
//     real pipeline already decided
// It therefore cannot fabricate a verified lot or move the coverage number by construction. The
// `verifiedCoveragePercent` it reports is recomputed with the SAME shared canonical predicate the
// public PnL gate itself uses (isCanonicalVerifiedPublishedLot), never a second local definition.

import type { MatchedLot } from '../modules/fifoEngine/types'
import type { RecoveryPolicyResult } from '../modules/recoveryPolicy/types'
import { canonicalVerifiedRejectionReason } from './canonicalVerifiedLot'

// The task's required per-lot classification taxonomy.
export type CoverageMissingLotReason =
  | 'missing_entry_buy'
  | 'missing_exit_sell'
  | 'missing_price'
  | 'transfer_only'
  | 'lp_action_excluded'
  | 'concentrated_position_action'
  | 'synthetic_lot_only'
  | 'provider_cap_truncated'
  | 'duplicate_removed'
  | 'untrusted_graph_event'
  | 'unsupported_chain_or_model'

export const COVERAGE_MISSING_LOT_REASONS: readonly CoverageMissingLotReason[] = [
  'missing_entry_buy',
  'missing_exit_sell',
  'missing_price',
  'transfer_only',
  'lp_action_excluded',
  'concentrated_position_action',
  'synthetic_lot_only',
  'provider_cap_truncated',
  'duplicate_removed',
  'untrusted_graph_event',
  'unsupported_chain_or_model',
]

export type CoverageMissingLotReasonCounts = Record<CoverageMissingLotReason, number>

export function emptyCoverageMissingLotReasonCounts(): CoverageMissingLotReasonCounts {
  return {
    missing_entry_buy: 0,
    missing_exit_sell: 0,
    missing_price: 0,
    transfer_only: 0,
    lp_action_excluded: 0,
    concentrated_position_action: 0,
    synthetic_lot_only: 0,
    provider_cap_truncated: 0,
    duplicate_removed: 0,
    untrusted_graph_event: 0,
    unsupported_chain_or_model: 0,
  }
}

export type WalletPnlCoverageRecoveryAudit = {
  wallet: string
  chains: string[]
  closedLotsTotal: number
  verifiedClosedLots: number
  verifiedCoveragePercent: number
  thresholdRequired: number
  missingLotsCount: number
  missingLotsByReason: CoverageMissingLotReasonCounts
  triggeredRecoveryTokens: string[]
  recoverySucceededTokens: string[]
  recoveryFailedTokens: string[]
  graphSourcesAvailable: string[]
  graphSourcesAttempted: string[]
  graphSourcesSucceeded: string[]
  graphSourcesFailed: string[]
  recoverablePreWindowExits: number
  recoveredEntryLots: number
  recoveredExitLots: number
  stillExcludedLots: number
  officialPnlEligibleAfterRecovery: boolean
  officialPnlStillBlockedReason: string | null
}

// Maps the shared canonical rejection reason onto the task's taxonomy.
//
// HONESTY NOTE, DISCLOSED: this maps only what the finalized lot actually proves, and deliberately
// does NOT guess. In particular `missing_cost_basis` is reported as `missing_entry_buy` because
// that is what an absent cost basis means at this stage — the entry side has no usable priced
// evidence, whether because the buy predates the fetch window or because it was never priced. It is
// NOT further split into "buy absent" vs "buy present but unpriced", because a finalized MatchedLot
// does not carry enough information to tell those apart, and inventing that distinction would make
// the audit look more precise than the underlying evidence actually is.
//
// The taxonomy values this function never returns — transfer_only, lp_action_excluded,
// concentrated_position_action, synthetic_lot_only, provider_cap_truncated, duplicate_removed,
// unsupported_chain_or_model — are exclusions applied EARLIER in the pipeline (classification,
// dedupe, provider windowing), so by construction those events never become a MatchedLot and can
// never appear in this lot-level pass. They remain in the type as always-present zero keys so a
// zero reads as a real measured zero rather than an absent key, and so a future caller that does
// have event-level exclusion data can populate them without changing this shape.
function classifyMissingLot(lot: MatchedLot): CoverageMissingLotReason | null {
  const reason = canonicalVerifiedRejectionReason(lot)
  if (reason === null) return null
  switch (reason) {
    // An impossible timeline (sell stamped before its own matched buy) is not a trustworthy event.
    case 'invalid_chronology': return 'untrusted_graph_event'
    case 'missing_cost_basis': return 'missing_entry_buy'
    case 'missing_proceeds': return 'missing_exit_sell'
    case 'missing_realized_pnl': return 'missing_price'
    case 'non_finite_value': return 'missing_price'
    // Both sides present and finite but the lot is still not marked verified — the remaining
    // difference is a pricing-quality judgement made upstream, not a structural gap.
    case 'evidence_quality_not_verified': return 'missing_price'
  }
}

/**
 * Builds the coverage/recovery audit from already-finalized pipeline output.
 *
 * `matchedLots` MUST be the same finalized, priced lot array the public PnL gate publishes from,
 * so this audit can never disagree with the gate it is explaining.
 */
export function buildWalletPnlCoverageRecoveryAudit(params: {
  wallet: string
  chains: readonly string[]
  matchedLots: readonly MatchedLot[]
  recoveryPolicy: RecoveryPolicyResult | null
  /** Coverage ratio required by the public gate, as a fraction (0.5 = 50%). */
  thresholdRequired?: number
  /** Providers this deployment has configured for graph/indexed recovery. */
  graphSourcesAvailable?: readonly string[]
}): WalletPnlCoverageRecoveryAudit {
  const thresholdRequired = params.thresholdRequired ?? 0.5
  const lots = params.matchedLots

  const closedLotsTotal = lots.length
  const missingLotsByReason = emptyCoverageMissingLotReasonCounts()
  let verifiedClosedLots = 0
  for (const lot of lots) {
    const reason = classifyMissingLot(lot)
    if (reason === null) verifiedClosedLots += 1
    else missingLotsByReason[reason] += 1
  }
  const missingLotsCount = closedLotsTotal - verifiedClosedLots
  const verifiedCoveragePercent = closedLotsTotal > 0
    ? Math.round((verifiedClosedLots / closedLotsTotal) * 10000) / 100
    : 0

  // ── Recovery attribution ────────────────────────────────────────────────────────────────────
  const evaluation = params.recoveryPolicy?.evaluation ?? []
  const triggered = evaluation.filter((e) => e.recoveryTriggered)
  const triggeredRecoveryTokens = triggered.map((e) => `${e.chain}:${e.token}`)
  // "Succeeded" means the fetch actually returned usable events — not merely that it was attempted.
  const succeeded = triggered.filter((e) => e.pagesUsed > 0 && e.recoveredEvents.length > 0)
  const recoverySucceededTokens = succeeded.map((e) => `${e.chain}:${e.token}`)
  // A triggered token that got no pages was starved by the wallet page cap, not proven empty —
  // that distinction is the whole point of separating these two lists.
  const recoveryFailedTokens = triggered
    .filter((e) => !(e.pagesUsed > 0 && e.recoveredEvents.length > 0))
    .map((e) => `${e.chain}:${e.token}`)

  // Recovered legs, split by direction relative to the scanned wallet. Entry = inbound (supplies a
  // missing cost basis), exit = outbound (supplies missing proceeds).
  const walletLower = params.wallet.toLowerCase()
  let recoveredEntryLots = 0
  let recoveredExitLots = 0
  for (const entry of evaluation) {
    for (const ev of entry.recoveredEvents) {
      const to = (ev.toAddress ?? '').toLowerCase()
      const from = (ev.fromAddress ?? '').toLowerCase()
      if (to === walletLower) recoveredEntryLots += 1
      else if (from === walletLower) recoveredExitLots += 1
    }
  }

  // Pre-window exits that recovery could still bridge: outbound legs recovered from BEYOND the base
  // fetch window are exactly what the historical pages exist to surface. Counted from real recovered
  // events only — never estimated.
  const recoverablePreWindowExits = recoveredExitLots

  // ── Provider/source accounting ──────────────────────────────────────────────────────────────
  // fetchHistoricalPages targets GoldRush (page 1) and Alchemy (page 2). "Attempted" is derived
  // from pages actually budgeted and spent, never assumed.
  const graphSourcesAvailable = [...(params.graphSourcesAvailable ?? ['goldrush', 'alchemy'])]
  const anyPagesSpent = evaluation.some((e) => e.pagesUsed > 0)
  const anyTwoPageFetch = evaluation.some((e) => e.pagesUsed >= 2)
  const graphSourcesAttempted: string[] = []
  if (anyPagesSpent) graphSourcesAttempted.push('goldrush')
  if (anyTwoPageFetch) graphSourcesAttempted.push('alchemy')
  // Succeeded/failed is only claimed at the granularity the recovery result actually proves: if any
  // triggered token came back with events, the attempted sources produced usable data for this
  // wallet. Per-provider success is NOT split further, because fetchHistoricalPages merges both
  // providers' events into one array before returning and does not attribute them per source —
  // claiming a per-provider breakdown here would be inventing detail the data does not contain.
  const anyEventsRecovered = evaluation.some((e) => e.recoveredEvents.length > 0)
  const graphSourcesSucceeded = anyEventsRecovered ? [...graphSourcesAttempted] : []
  const graphSourcesFailed = anyEventsRecovered ? [] : [...graphSourcesAttempted]

  // ── Gate outcome ────────────────────────────────────────────────────────────────────────────
  const stillExcludedLots = missingLotsCount
  const officialPnlEligibleAfterRecovery = closedLotsTotal > 0 && verifiedClosedLots / closedLotsTotal >= thresholdRequired

  let officialPnlStillBlockedReason: string | null = null
  if (!officialPnlEligibleAfterRecovery) {
    if (closedLotsTotal === 0) {
      officialPnlStillBlockedReason = 'No closed lots were produced for this wallet, so there is nothing to verify.'
    } else {
      const needed = Math.max(0, Math.ceil(thresholdRequired * closedLotsTotal) - verifiedClosedLots)
      const starvedByCap = triggered.length - succeeded.length
      const dominant = (Object.entries(missingLotsByReason) as Array<[CoverageMissingLotReason, number]>)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])[0]
      const parts = [
        `Verified coverage ${verifiedCoveragePercent}% is below the required ${Math.round(thresholdRequired * 100)}%.`,
        `${needed} more verified closed lot${needed === 1 ? '' : 's'} needed (${verifiedClosedLots}/${closedLotsTotal} verified).`,
      ]
      if (dominant) parts.push(`Largest blocker: ${dominant[0]} (${dominant[1]} lots).`)
      if (starvedByCap > 0) {
        parts.push(
          `${starvedByCap} of ${triggered.length} triggered token${triggered.length === 1 ? '' : 's'} received no historical pages — ` +
          `the wallet page cap (${params.recoveryPolicy?.caps.maxHistoricalPagesPerWallet ?? 'n/a'}) funds only ` +
          `${Math.floor((params.recoveryPolicy?.caps.maxHistoricalPagesPerWallet ?? 0) / 2)} tokens per scan.`,
        )
      }
      officialPnlStillBlockedReason = parts.join(' ')
    }
  }

  return {
    wallet: params.wallet,
    chains: [...params.chains],
    closedLotsTotal,
    verifiedClosedLots,
    verifiedCoveragePercent,
    thresholdRequired,
    missingLotsCount,
    missingLotsByReason,
    triggeredRecoveryTokens,
    recoverySucceededTokens,
    recoveryFailedTokens,
    graphSourcesAvailable,
    graphSourcesAttempted,
    graphSourcesSucceeded,
    graphSourcesFailed,
    recoverablePreWindowExits,
    recoveredEntryLots,
    recoveredExitLots,
    stillExcludedLots,
    officialPnlEligibleAfterRecovery,
    officialPnlStillBlockedReason,
  }
}

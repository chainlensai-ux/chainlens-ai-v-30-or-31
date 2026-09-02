// buildWalletPnlViewModel — ONE shared PnL view model for the Wallet Scanner UI AND CORTEX,
// DISCLOSED (Wallet Scanner "Smart Money Score + PnL Evidence UI" simplification task).
//
// WHY: the UI (PnlStatusCard) previously derived its PnL wording/badges directly from several
// independent selectors (selectDisplayedPnl, selectVerifiedPnlData, selectPnlConfidenceStatus,
// selectEvmPnlLaneStatus, selectRobinhoodPnlLaneStatus) rendered as separate top badges ("Active",
// "Not verified", "PnL unavailable") that could contradict the per-chain rows a few lines below
// (e.g. a top "PnL unavailable" badge next to a verified Robinhood row). CORTEX's sidebar
// (walletReadBuilder.ts) built its own, separately-worded summary of the same data. This file is
// the single place that reconciles all of that into ONE combined status + one set of box/row
// objects, so the UI and CORTEX read the same words for the same evidence.
//
// NO NEW PNL MATH, DISCLOSED (this task's own hard rule "do not change FIFO/PnL math", "do not
// loosen Robinhood verified PnL gates"): every number below is read from the EXISTING, already-
// tested selectors this file imports from PnlStatusCard.tsx/RobinhoodChainSection.tsx — this module
// only reshapes/labels their outputs. It never recomputes a PnL figure, never invents a threshold,
// and never marks Robinhood "verified" except via the exact same selectRobinhoodPnlLaneStatus gate
// (Phase 3 sidecar, verifiedSwapCount > 0) the main card and CORTEX already required.
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import type { PublicPnlStatus, UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'
import type { PnlReconciliationSummary } from '@/src/lib/pnlReconciliation'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'
import { fmtSignedUsd, fmtUsd, fmtChainLabel } from '@/app/frontend/lib/holdingsHeuristics'
import type { RobinhoodWalletScanResponse } from '@/app/frontend/components/RobinhoodChainSection'
import { selectRobinhoodPnlLaneStatus } from '@/app/frontend/components/RobinhoodChainSection'
import {
  selectVerifiedPnlData,
  selectDisplayedPnl,
  selectPnlConfidenceStatus,
  selectEvmPnlLaneStatus,
  selectBoundedSampleDisclosure,
  resolveEffectivePublicPnlStatus,
  buildRealizedVerifiedMessage,
  PNL_UNAVAILABLE_MESSAGE,
  CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL,
} from '@/app/frontend/components/PnlStatusCard'

export type WalletPnlBoxStatus = 'Verified' | 'Partial' | 'Locked' | 'Unavailable'

export type WalletPnlBox = {
  value: string | null
  status: WalletPnlBoxStatus
  reason: string
}

export type WalletPnlChainRowStatus = 'Verified' | 'Partial' | 'Unavailable' | 'Not verified'

export type WalletPnlChainRow = {
  chain: string
  label: string
  status: WalletPnlChainRowStatus
  value: string | null
}

export type WalletRobinhoodPnlProof = {
  source: string
  verifiedSwaps: number
  closedLots: number
  priceEvidence: string
}

export type WalletPnlCombinedStatus = 'verified' | 'partial' | 'locked' | 'unavailable'

export type WalletPnlViewModel = {
  combinedStatus: WalletPnlCombinedStatus
  combinedReason: string
  realizedBox: WalletPnlBox
  unrealizedBox: WalletPnlBox
  roiBox: WalletPnlBox
  costBasisBox: WalletPnlBox
  chainRows: WalletPnlChainRow[]
  robinhoodProof: WalletRobinhoodPnlProof | null
}

// EXACT COPY, DISCLOSED (this task's own required replacement text): shown whenever the official
// combined (Base/ETH) PnL is not fully verified but Robinhood's own, independently-gated realized
// PnL IS verified — replaces the old generic "PnL unavailable due to missing evidence" wording for
// exactly this case, never for a wallet with no verified evidence anywhere.
export const COMBINED_PNL_LOCKED_ROBINHOOD_VERIFIED_MESSAGE =
  'Official combined PnL is locked because Base/ETH history is partial. Robinhood realized PnL is verified separately.'

export type BuildWalletPnlViewModelParams = {
  pnlV2: PnlV2 | null | undefined
  publicPnlStatus?: PublicPnlStatus | null
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
  reconciliationSummary?: PnlReconciliationSummary | null
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
  robinhoodResult?: RobinhoodWalletScanResponse | null
  chainsScanned?: string[]
}

function box(value: string | null, status: WalletPnlBoxStatus, reason: string): WalletPnlBox {
  return { value, status, reason }
}

export function buildWalletPnlViewModel(params: BuildWalletPnlViewModelParams): WalletPnlViewModel {
  const { pnlV2, publicPnlStatus, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit, robinhoodResult, chainsScanned } = params

  const canonicalSampleUnavailable = canonicalSampleManifestAudit?.canonicalSampleEvidenceUnavailable === true
  const effectiveStatus = resolveEffectivePublicPnlStatus(publicPnlStatus, reconciliationSummary, canonicalSampleManifestAudit)
  const isBoundedSample = effectiveStatus === 'limited_verified_sample'
  const isActive = pnlV2 != null

  const pnl = selectVerifiedPnlData(pnlV2, effectiveStatus, unrealizedReconciliation)
  const displayed = selectDisplayedPnl({ pnlV2, publicPnlStatus, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit })
  const confidence = selectPnlConfidenceStatus(effectiveStatus, unrealizedReconciliation, reconciliationSummary)
  const boundedSample = selectBoundedSampleDisclosure(publicPnlStatus, reconciliationSummary, canonicalSampleManifestAudit)
  const evmLane = selectEvmPnlLaneStatus({ pnlV2, publicPnlStatus, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit })
  const robinhoodLane = selectRobinhoodPnlLaneStatus(robinhoodResult)

  // SAME blocked GUARD PnlStatusCard.tsx's own render uses (magnitude heuristic + stability guard),
  // never recomputed differently — a bounded sample is exempt (reads reconciliationSummary instead).
  const blocked = isBoundedSample ? false : isActive && (pnl.unreliable || !pnl.stable)

  const confidenceToBoxStatus = (v: 'Verified' | 'Partial' | 'Locked' | 'Full' | 'Unavailable'): WalletPnlBoxStatus =>
    v === 'Full' ? 'Verified' : v

  // REALIZED, DISCLOSED: same precedence as the card's own header icon/badges — canonical-
  // unavailable fails closed first, then the magnitude/stability guard, then the real backend
  // classification (selectPnlConfidenceStatus.realized), never a new heuristic.
  const realizedStatus: WalletPnlBoxStatus = canonicalSampleUnavailable
    ? 'Unavailable'
    : blocked
      ? 'Locked'
      : confidenceToBoxStatus(confidence.realized)
  const realizedBox = box(
    displayed.realizedPnlUsd == null || realizedStatus === 'Unavailable' || realizedStatus === 'Locked' ? null : fmtSignedUsd(displayed.realizedPnlUsd),
    realizedStatus,
    canonicalSampleUnavailable
      ? CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
      : realizedStatus === 'Locked'
        ? 'Magnitude/stability guard blocked this figure.'
        : realizedStatus === 'Partial'
          ? (boundedSample?.label ?? 'Bounded verified sample.')
          : realizedStatus === 'Verified'
            ? (buildRealizedVerifiedMessage(effectiveStatus) ?? 'Closed-lot coverage confirmed.')
            : PNL_UNAVAILABLE_MESSAGE,
  )

  // UNREALIZED, DISCLOSED: reuses confidence.unrealized ('Full'/'Partial'/'Unavailable' — mapped to
  // 'Verified'/'Partial'/'Unavailable') — the SAME reconciliation-status-derived classification the
  // card's own confidence row already shows, never a new derivation.
  const unrealizedStatus: WalletPnlBoxStatus = canonicalSampleUnavailable
    ? 'Unavailable'
    : blocked
      ? 'Locked'
      : confidenceToBoxStatus(confidence.unrealized)
  const unrealizedBox = box(
    displayed.unrealizedPnlUsd == null || unrealizedStatus === 'Unavailable' || unrealizedStatus === 'Locked' ? null : fmtSignedUsd(displayed.unrealizedPnlUsd),
    unrealizedStatus,
    canonicalSampleUnavailable
      ? CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
      : unrealizedStatus === 'Locked'
        ? 'Magnitude/stability guard blocked this figure.'
        : unrealizedStatus === 'Verified'
          ? 'Open-position estimate reconciled with live prices.'
          : unrealizedStatus === 'Partial'
            ? 'Some open positions could not be independently verified this scan.'
            : 'No reconciled open-position evidence.',
  )

  // ROI, DISCLOSED: same displayed.roiPercent/roiLabel this card's own ROI tile already reads —
  // status derived from the same canonical/bounded/blocked precedence as the other boxes.
  const roiStatus: WalletPnlBoxStatus = canonicalSampleUnavailable
    ? 'Unavailable'
    : blocked
      ? 'Locked'
      : isBoundedSample
        ? 'Partial'
        : displayed.roiPercent != null
          ? 'Verified'
          : 'Unavailable'
  const roiBox = box(
    roiStatus === 'Verified' || (roiStatus === 'Partial' && displayed.roiPercent != null) ? displayed.roiLabel : null,
    roiStatus,
    canonicalSampleUnavailable
      ? CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
      : roiStatus === 'Locked'
        ? 'Magnitude/stability guard blocked this figure.'
        : roiStatus === 'Verified'
          ? 'Realized PnL vs verified cost basis.'
          : displayed.roiLabel ?? 'Not available.',
  )

  // COST BASIS, DISCLOSED: pnl.totalCostBasisUsd (pnlV2's own summed cost basis) — 'Unavailable' for
  // a bounded sample per selectDisplayedPnl's own costBasisLabel (no canonical per-wallet cost-basis
  // figure exists for that source, see that function's own header).
  const costBasisStatus: WalletPnlBoxStatus = canonicalSampleUnavailable
    ? 'Unavailable'
    : isBoundedSample
      ? 'Unavailable'
      : pnl.unreliable
        ? 'Locked'
        : pnl.totalCostBasisUsd != null
          ? 'Verified'
          : 'Unavailable'
  const costBasisBox = box(
    costBasisStatus === 'Verified' ? fmtUsd(pnl.totalCostBasisUsd) : null,
    costBasisStatus,
    canonicalSampleUnavailable
      ? CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
      : costBasisStatus === 'Locked'
        ? 'Magnitude guard blocked this figure.'
        : costBasisStatus === 'Verified'
          ? 'Sum of verified per-token cost basis.'
          : displayed.costBasisLabel ?? 'Not available.',
  )

  // CHAIN ROWS, DISCLOSED: Base/ETH share pnlV2's ONE combined EVM lane status (pnlV2 has never
  // computed a real per-chain-verified/partial split — see ChainBreakdownTable's own header in
  // PnlStatusCard.tsx) with a real per-chain realized figure pulled from pnlV2.chainBreakdown where
  // present. Robinhood is its own, separately-gated row — never blended into the EVM figure above.
  const EVM_CHAIN_ID_BY_SLUG: Record<string, number> = { base: 8453, eth: 1, ethereum: 1 }
  const evmRowStatus: WalletPnlChainRowStatus = evmLane === 'verified' ? 'Verified' : evmLane === 'partial' ? 'Partial' : 'Unavailable'
  const chainRows: WalletPnlChainRow[] = (chainsScanned ?? [])
    .filter((c) => c === 'base' || c === 'eth' || c === 'ethereum')
    .map((c) => {
      const chainId = EVM_CHAIN_ID_BY_SLUG[c]
      const row = pnlV2?.chainBreakdown.find((cb) => cb.chainId === chainId)
      const rowUnreliable = pnl.unreliable && row != null && Math.abs(row.realizedPnlUsd) > 1e9
      return {
        chain: c,
        label: fmtChainLabel(c === 'ethereum' ? 'eth' : c),
        status: evmRowStatus,
        value: !canonicalSampleUnavailable && row != null && !rowUnreliable && evmRowStatus !== 'Unavailable' ? fmtSignedUsd(row.realizedPnlUsd) : null,
      }
    })

  let robinhoodProof: WalletRobinhoodPnlProof | null = null
  if (robinhoodResult) {
    const audit = robinhoodResult.robinhoodPnlVerificationAudit
    const rowStatus: WalletPnlChainRowStatus = robinhoodLane === 'verified' ? 'Verified' : robinhoodLane === 'not_verified' ? 'Not verified' : 'Unavailable'
    chainRows.push({
      chain: 'robinhood',
      label: fmtChainLabel('robinhood'),
      status: rowStatus,
      value: robinhoodLane === 'verified' ? fmtSignedUsd(robinhoodResult.pnl.realizedPnlUsd) : null,
    })
    if (robinhoodLane === 'verified' && audit) {
      robinhoodProof = {
        source: 'Phase 3 sidecar',
        verifiedSwaps: audit.verifiedSwapCount,
        closedLots: audit.fifoClosedLots,
        priceEvidence: 'both legs verified',
      }
    }
  }

  // COMBINED, DISCLOSED: describes the OFFICIAL combined (pnlV2/Base+ETH) figure only — Robinhood's
  // realized PnL is never summed into it (per this task's own "do not loosen Robinhood verified PnL
  // gates" and the pre-existing "Realized/ROI/cost basis stay pnlV2-only" rule) — but when Base/ETH
  // is not fully verified WHILE Robinhood's own separate lane is verified, this says so explicitly
  // instead of a blanket "unavailable", so a real verified Robinhood figure is never buried behind a
  // combined-PnL failure message that reads as if nothing were verified at all.
  const baseCombinedStatus: WalletPnlCombinedStatus = canonicalSampleUnavailable
    ? 'unavailable'
    : (effectiveStatus === 'ok' && !blocked)
      ? 'verified'
      : isBoundedSample
        ? 'partial'
        : 'unavailable'

  let combinedStatus: WalletPnlCombinedStatus = baseCombinedStatus
  let combinedReason: string
  if (baseCombinedStatus !== 'verified' && robinhoodLane === 'verified') {
    combinedStatus = 'locked'
    combinedReason = COMBINED_PNL_LOCKED_ROBINHOOD_VERIFIED_MESSAGE
  } else if (canonicalSampleUnavailable) {
    combinedReason = CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
  } else if (baseCombinedStatus === 'verified') {
    combinedReason = buildRealizedVerifiedMessage(effectiveStatus) ?? 'Realized PnL: Verified — closed-lot coverage confirmed.'
  } else if (baseCombinedStatus === 'partial') {
    combinedReason = boundedSample?.label ?? 'Verified bounded sample.'
  } else {
    combinedReason = PNL_UNAVAILABLE_MESSAGE
  }

  return {
    combinedStatus,
    combinedReason,
    realizedBox,
    unrealizedBox,
    roiBox,
    costBasisBox,
    chainRows,
    robinhoodProof,
  }
}

export default buildWalletPnlViewModel

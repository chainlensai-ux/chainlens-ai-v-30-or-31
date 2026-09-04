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
import { fmtSignedUsd, fmtChainLabel } from '@/app/frontend/lib/holdingsHeuristics'
import type { RobinhoodWalletScanResponse } from '@/app/frontend/components/RobinhoodChainSection'
import { selectRobinhoodPnlLaneStatus, ROBINHOOD_PNL_NOT_VERIFIED_REASON } from '@/app/frontend/components/RobinhoodChainSection'
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
  // ZERO-SUPPRESSION REASON, DISCLOSED (portfolio-vs-PnL contradiction fix): Partial/Unavailable/
  // Not-verified rows never carry a dollar figure — the reason is what the user sees under "—".
  reason: string
}

export type WalletRobinhoodPnlProof = {
  source: string
  verifiedSwaps: number
  closedLots: number
  priceEvidence: string
}

// DEDICATED ROBINHOOD BOX, DISCLOSED (PnL Evidence UI cleanup follow-up — this task's own explicit
// requirement: a distinct "Robinhood Realized PnL" box among the main 4, never a number that could
// be read as part of the combined figure). Same status vocabulary as a chain row (never fabricates a
// "Locked" state for Robinhood — it is either Verified, genuinely not verified, or has no scan at
// all) plus the compact proof fields shown inline in the box itself.
export type WalletPnlRobinhoodBox = {
  status: WalletPnlChainRowStatus
  value: string | null
  reason: string
  proof: WalletRobinhoodPnlProof | null
}

export type WalletPnlCombinedStatus = 'verified' | 'partial' | 'locked' | 'unavailable'

export type WalletPnlViewModel = {
  combinedStatus: WalletPnlCombinedStatus
  combinedReason: string
  // COMBINED REALIZED BOX, DISCLOSED: status is ALWAYS the same as combinedStatus (Title Case) —
  // structurally impossible to disagree with the header badge, closing the reported bug where this
  // box showed a big "verified" number while the header said "Combined Locked". Only ever carries a
  // real Base/ETH-only value (never Robinhood's) for 'Verified'/'Partial'; null for 'Locked'/
  // 'Unavailable' — a locked/unavailable combined figure never pretends to have a number.
  combinedRealizedBox: WalletPnlBox
  robinhoodBox: WalletPnlRobinhoodBox
  unrealizedBox: WalletPnlBox
  roiBox: WalletPnlBox
  chainRows: WalletPnlChainRow[]
  // Kept for backward compatibility with existing callers/tests — identical to robinhoodBox.proof.
  robinhoodProof: WalletRobinhoodPnlProof | null
}

// EXACT COPY, DISCLOSED, UPDATED (PnL Evidence UI cleanup follow-up — this task's own required exact
// subtext, replacing the earlier task's near-identical "Official combined PnL is locked..." wording):
// shown whenever the combined (Base/ETH) PnL is not fully verified but Robinhood's own,
// independently-gated realized PnL IS verified — replaces the old generic "PnL unavailable due to
// missing evidence" wording for exactly this case, never for a wallet with no verified evidence
// anywhere.
export const COMBINED_PNL_LOCKED_ROBINHOOD_VERIFIED_MESSAGE =
  'Combined PnL is locked because Base/ETH history is partial. Robinhood realized PnL is verified separately.'

// CHAIN-ROW COPY, DISCLOSED (portfolio-vs-PnL contradiction fix): Partial/unavailable chain PnL
// must never render a green $0.00 — that $0 is the engine's empty-lot default, not a verified
// realized figure. These strings are the honest reason shown next to "—".
export const CHAIN_PNL_PARTIAL_REASON = 'Partial — realized PnL is not independently verified.'
export const CHAIN_PNL_UNAVAILABLE_REASON = 'No verified PnL evidence for this chain.'
export const CHAIN_PNL_VERIFIED_REASON = 'Verified closed-lot realized PnL.'

export function chainPnlRowReason(status: WalletPnlChainRowStatus): string {
  if (status === 'Verified') return CHAIN_PNL_VERIFIED_REASON
  if (status === 'Partial') return CHAIN_PNL_PARTIAL_REASON
  if (status === 'Not verified') return ROBINHOOD_PNL_NOT_VERIFIED_REASON
  return CHAIN_PNL_UNAVAILABLE_REASON
}

// NUMERIC PNL DISPLAY GATE, DISCLOSED: a chain PnL dollar figure is only shown when that chain's
// own status is Verified. Partial/Unavailable/Not-verified always render as "—" — including the
// engine's default realizedPnlUsd=0 when closedLots=0 (the live $8.67K-holdings / $0.00-Base-PnL
// contradiction). Verified + a real 0 still shows $0.00, because that 0 was independently proven.
export function displayChainPnlValue(
  status: WalletPnlChainRowStatus,
  realizedPnlUsd: number | null | undefined,
): string | null {
  if (status !== 'Verified') return null
  if (realizedPnlUsd == null || !Number.isFinite(realizedPnlUsd)) return null
  return fmtSignedUsd(realizedPnlUsd)
}

export function shouldSuppressUnverifiedZeroPnl(
  status: WalletPnlChainRowStatus | WalletPnlBoxStatus | WalletPnlCombinedStatus,
  realizedPnlUsd: number | null | undefined,
): boolean {
  const verified = status === 'Verified' || status === 'verified'
  return !verified && realizedPnlUsd === 0
}

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

  // COMBINED, DISCLOSED, MOVED EARLIER (PnL Evidence UI cleanup follow-up — this task's own explicit
  // requirement: "Combined Realized PnL" box status must ALWAYS match the header badge): describes
  // the OFFICIAL combined (pnlV2/Base+ETH) figure only — Robinhood's realized PnL is never summed
  // into it (per "do not loosen Robinhood verified PnL gates" and the pre-existing "Realized/ROI stay
  // pnlV2-only" rule) — but when Base/ETH is not fully verified WHILE Robinhood's own separate lane
  // is verified, this says so explicitly instead of a blanket "unavailable", so a real verified
  // Robinhood figure is never buried behind a combined-PnL failure message that reads as if nothing
  // were verified at all.
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

  // COMBINED REALIZED BOX, DISCLOSED (this task's own root-cause fix — confirmed reported bug: the
  // old "Realized PnL" tile computed its OWN status from confidence.realized/blocked independently of
  // combinedStatus above, so it could show "Verified" with a big number while the header badge said
  // "Combined Locked" for the exact same scan). This box's status is now a DIRECT, structural mirror
  // of combinedStatus (Title Case) — there is no code path where they can disagree. A 'Locked' or
  // 'Unavailable' combined figure NEVER shows a number here, even though the underlying Base/ETH data
  // may technically have one — showing it would read as "this locked figure is actually verified",
  // exactly the contradiction this task asks to close. 'Verified'/'Partial' still show the real,
  // already-computed Base/ETH-only figure (never Robinhood's).
  const combinedRealizedBoxStatus: WalletPnlBoxStatus =
    combinedStatus === 'verified' ? 'Verified' : combinedStatus === 'partial' ? 'Partial' : combinedStatus === 'locked' ? 'Locked' : 'Unavailable'
  // ZERO SUPPRESSION, DISCLOSED (portfolio-vs-PnL contradiction fix): a Partial combined figure of
  // $0.00 is the empty-lot default, not a verified realized 0. Only a Verified combined status may
  // show $0.00. Bounded-sample Partial still shows its real non-zero number.
  const rawCombinedUsd = combinedRealizedBoxStatus === 'Verified'
    ? (displayed.realizedPnlUsd ?? null)
    : combinedRealizedBoxStatus === 'Partial'
      ? (boundedSample?.realizedPnlUsd ?? displayed.realizedPnlUsd ?? null)
      : null
  const combinedRealizedValue = combinedRealizedBoxStatus === 'Locked' || combinedRealizedBoxStatus === 'Unavailable'
    ? null
    : shouldSuppressUnverifiedZeroPnl(combinedRealizedBoxStatus, rawCombinedUsd)
      ? null
      : (rawCombinedUsd != null && Number.isFinite(rawCombinedUsd) ? fmtSignedUsd(rawCombinedUsd) : null)
  const combinedRealizedBox = box(
    combinedRealizedValue,
    combinedRealizedBoxStatus,
    combinedRealizedBoxStatus === 'Unavailable' && canonicalSampleUnavailable
      ? CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
      : combinedRealizedBoxStatus === 'Locked'
        ? (baseCombinedStatus === 'partial' ? 'Base/ETH history is partial.' : 'Base/ETH PnL is not yet verified.')
        : combinedRealizedBoxStatus === 'Partial'
          ? (boundedSample?.label ?? 'Base/ETH history is a bounded, verified sample.')
          : combinedRealizedBoxStatus === 'Verified'
            ? (buildRealizedVerifiedMessage(effectiveStatus) ?? 'Closed-lot coverage confirmed.')
            : PNL_UNAVAILABLE_MESSAGE,
  )

  // ROBINHOOD BOX, DISCLOSED: a distinct top-row box (never folded into the combined figure above) —
  // 'Verified' shows the real gated figure + compact proof; a genuinely not-verified or absent scan
  // never shows a number, matching the exact same selectRobinhoodPnlLaneStatus gate the chain row and
  // CORTEX both already use.
  const robinhoodBoxStatus: WalletPnlChainRowStatus = robinhoodLane === 'verified' ? 'Verified' : robinhoodLane === 'not_verified' ? 'Not verified' : 'Unavailable'

  // UNREALIZED, DISCLOSED: reuses confidence.unrealized ('Full'/'Partial'/'Unavailable' — mapped to
  // 'Verified'/'Partial'/'Unavailable') — the SAME reconciliation-status-derived classification the
  // card's own confidence row already shows, never a new derivation. A genuinely separate concern
  // from combinedStatus — an open-position estimate can be partial even when realized PnL is fully
  // verified, and vice versa.
  const unrealizedStatus: WalletPnlBoxStatus = canonicalSampleUnavailable
    ? 'Unavailable'
    : blocked
      ? 'Locked'
      : confidenceToBoxStatus(confidence.unrealized)
  const unrealizedBox = box(
    displayed.unrealizedPnlUsd == null || unrealizedStatus === 'Unavailable' || unrealizedStatus === 'Locked' || shouldSuppressUnverifiedZeroPnl(unrealizedStatus, displayed.unrealizedPnlUsd) ? null : fmtSignedUsd(displayed.unrealizedPnlUsd),
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

  // ROI, DISCLOSED, SIMPLIFIED (this task's own explicit spec — "ROI: Locked until combined PnL is
  // verified"): ROI is a derivative of the COMBINED realized figure, so it is now gated on
  // combinedStatus directly rather than its own bounded/blocked nuance — 'Verified' only when the
  // combined figure itself is fully verified, 'Locked' otherwise (including the bounded-sample case,
  // which previously showed as its own real ROI number even though the headline combined PnL was not
  // fully verified — the same class of contradiction this task's box-1 fix closes).
  const roiStatus: WalletPnlBoxStatus = canonicalSampleUnavailable
    ? 'Unavailable'
    : combinedStatus === 'verified'
      ? 'Verified'
      : 'Locked'
  const roiBox = box(
    roiStatus === 'Verified' && displayed.roiPercent != null ? displayed.roiLabel : null,
    roiStatus,
    canonicalSampleUnavailable
      ? CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
      : roiStatus === 'Verified'
        ? 'Realized PnL vs verified cost basis.'
        : 'Locked until combined PnL is verified.',
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
      const rawUsd = !canonicalSampleUnavailable && row != null && !rowUnreliable ? row.realizedPnlUsd : null
      return {
        chain: c,
        label: fmtChainLabel(c === 'ethereum' ? 'eth' : c),
        status: evmRowStatus,
        value: displayChainPnlValue(evmRowStatus, rawUsd),
        reason: chainPnlRowReason(evmRowStatus),
      }
    })

  let robinhoodProof: WalletRobinhoodPnlProof | null = null
  if (robinhoodResult) {
    const audit = robinhoodResult.robinhoodPnlVerificationAudit
    chainRows.push({
      chain: 'robinhood',
      label: fmtChainLabel('robinhood'),
      status: robinhoodBoxStatus,
      value: robinhoodLane === 'verified' ? fmtSignedUsd(robinhoodResult.pnl.realizedPnlUsd) : null,
      reason: chainPnlRowReason(robinhoodBoxStatus),
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

  const robinhoodBox: WalletPnlRobinhoodBox = {
    status: robinhoodBoxStatus,
    value: robinhoodLane === 'verified' && robinhoodResult ? fmtSignedUsd(robinhoodResult.pnl.realizedPnlUsd) : null,
    reason: robinhoodBoxStatus === 'Verified'
      ? `${robinhoodProof?.verifiedSwaps ?? 0} verified swap${robinhoodProof?.verifiedSwaps === 1 ? '' : 's'} — Phase 3 sidecar realized PnL.`
      : robinhoodBoxStatus === 'Not verified'
        ? ROBINHOOD_PNL_NOT_VERIFIED_REASON
        : 'No Robinhood scan for this wallet.',
    proof: robinhoodProof,
  }

  return {
    combinedStatus,
    combinedReason,
    combinedRealizedBox,
    robinhoodBox,
    unrealizedBox,
    roiBox,
    chainRows,
    robinhoodProof,
  }
}

export default buildWalletPnlViewModel

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
import type { PnlV2, WalletPnlEvidenceAudit } from '@/lib/engine/modules/pnl/types'
import type { PublicPnlStatus, UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'
import type { PnlReconciliationSummary, PublicPnlGateBlockingReason } from '@/src/lib/pnlReconciliation'
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
  buildUnrealizedPartialReasonMessage,
  PNL_UNAVAILABLE_MESSAGE,
  CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL,
  GUARDRAIL_ABS_LIMIT,
} from '@/app/frontend/components/PnlStatusCard'

export type WalletPnlBoxStatus = 'Verified' | 'Partial' | 'Locked' | 'Unavailable'

export type WalletPnlBox = {
  value: string | null
  status: WalletPnlBoxStatus
  reason: string
  // Optional presentation label. Sample tiles use this so the badge can read
  // "PARTIAL / VERIFIED BOUNDED SAMPLE" without inventing a new status enum.
  statusLabel?: string
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
  // LABEL, DISCLOSED (verified-sample-vs-full-history follow-up): this box is Combined / Full Wallet
  // Realized PnL — complete-wallet performance. Bounded-sample arithmetic lives in
  // verifiedSampleRealizedBox / roiBox and is never relabeled as complete-wallet history.
  combinedRealizedBox: WalletPnlBox
  // VERIFIED SAMPLE REALIZED BOX, DISCLOSED: included canonical closed-lot arithmetic. Independent
  // of unmatched sells outside the sample. Never labeled complete-wallet / full-history.
  verifiedSampleRealizedBox: WalletPnlBox
  robinhoodBox: WalletPnlRobinhoodBox
  unrealizedBox: WalletPnlBox
  roiBox: WalletPnlBox
  chainRows: WalletPnlChainRow[]
  // CORTEX / sidebar: same sample wording as the tiles. Null when the sample is not allowed.
  sampleEvidenceLine: string | null
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

// OFFICIAL UNAVAILABLE COPY, DISCLOSED (Wallet PnL publish Item 1 — confirmed production lie:
// Combined UNAVAILABLE headline/sidebar used V2 `wallet-pnl-evidence-audit.failureReason`
// "Sell activity was found but did not match any earlier buy — no verified closed lot could be
// built" while canonical recon already counted 586 closed lots / 242 verified / 41.3% coverage
// and blocked publication on the real 50% pricing-coverage gate).
//
// ONE official publish path for publicPnlStatus, headline, combined-box reason, and CORTEX
// sidebar: canonical fifo + reconciliation + publicPnlGateAudit. V2/pnlSummaryV2/
// walletPnlEvidenceAudit is diagnostic-only. Its closedLots:0 failureReason is used ONLY when
// canonical recon has zero closed lots (or recon isn't wired) — never as an override of a
// canonical gate that already counted lots. Does NOT change combinedStatus (still
// resolveEffectivePublicPnlStatus). Does NOT lower the 10-lot / 50% bars. Does NOT invent a
// verified sample.
const V2_ZERO_LOT_COPY_RE = /no verified closed lot could be built|did not match any earlier buy/i
const OFFICIAL_MIN_VERIFIED_PRICING_COVERAGE = 0.5
const OFFICIAL_MIN_VERIFIED_CLOSED_LOTS = 10

function formatCoveragePercent(ratio: number | null | undefined): string | null {
  if (ratio == null || !Number.isFinite(ratio)) return null
  const pct = Math.min(100, Math.max(0, ratio * 100))
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`
}

function canonicalClosedLotCounts(summary: PnlReconciliationSummary | null | undefined): {
  verified: number
  structural: number
} | null {
  const audit = summary?.publicPnlGateAudit
  if (!audit) return null
  const verified = audit.verifiedClosedLots
  const structural = audit.structuralClosedLots
  if (!(structural > 0 || verified > 0)) return null
  return { verified, structural }
}

function formatNamedGateBlocker(rule: string): string | null {
  if (rule === 'fifo_result_hard_invalid') return 'FIFO result is hard-invalid.'
  if (rule === 'window_boundary_proven') return 'Window boundary is not proven.'
  if (rule === 'window_boundary_unproven_for_unmatched_sells') return 'Unmatched sells cannot be resolved because the transaction-history boundary is not proven.'
  if (rule === 'realized_pnl_present') return 'Canonical realized PnL is not present.'
  return null
}

function collectNamedBlockers(reasons: readonly PublicPnlGateBlockingReason[] | undefined, seen: Set<string>): string[] {
  const out: string[] = []
  for (const reason of reasons ?? []) {
    if (seen.has(reason.rule)) continue
    seen.add(reason.rule)
    const phrase = formatNamedGateBlocker(reason.rule)
    if (phrase) out.push(phrase)
  }
  return out
}

export function formatCanonicalUnavailableReason(summary: PnlReconciliationSummary): string {
  const audit = summary.publicPnlGateAudit
  const verified = audit.verifiedClosedLots
  const structural = audit.structuralClosedLots
  const coverageRatio = audit.verifiedPricingCoverage != null && Number.isFinite(audit.verifiedPricingCoverage)
    ? audit.verifiedPricingCoverage
    : (structural > 0 ? verified / structural : null)
  const coveragePct = formatCoveragePercent(coverageRatio)

  const sentences: string[] = [
    `PnL unavailable — ${verified} of ${structural} closed lots verified${coveragePct != null ? ` (${coveragePct} coverage)` : ''}.`,
  ]

  if (coverageRatio != null && coverageRatio < OFFICIAL_MIN_VERIFIED_PRICING_COVERAGE) {
    sentences.push(`Verified pricing coverage ${coveragePct} is below the 50% gate.`)
  } else if (verified < OFFICIAL_MIN_VERIFIED_CLOSED_LOTS) {
    sentences.push(`Verified closed lots ${verified} is below the ${OFFICIAL_MIN_VERIFIED_CLOSED_LOTS}-lot gate.`)
  }

  const unmatchedSells = audit.unmatchedSellCount
  const unmatchedBuys = audit.unmatchedBuyCount
  if (unmatchedSells > 0) sentences.push(`${unmatchedSells} unmatched sell${unmatchedSells === 1 ? '' : 's'}.`)
  if (unmatchedBuys > 0) sentences.push(`${unmatchedBuys} unmatched buy${unmatchedBuys === 1 ? '' : 's'}.`)

  const missing = summary.missingEvidenceCount
  if (missing > 0) sentences.push(`Missing evidence on ${missing} lot side${missing === 1 ? '' : 's'}.`)

  const seen = new Set([
    'minimum_verified_pricing_coverage',
    'minimum_verified_closed_lots',
    'unmatched_buys',
    'unmatched_sells',
    'missing_evidence_count',
  ])
  sentences.push(
    ...collectNamedBlockers(audit.boundedSampleBlockingReasons, seen),
    ...collectNamedBlockers(audit.blockingReasons, seen),
    ...collectNamedBlockers(audit.fullAvailabilityBlockingReasons, seen),
  )

  return sentences.join(' ')
}

export function formatFullWalletUnavailableReason(summary: PnlReconciliationSummary | null | undefined): string | null {
  const count = summary?.publicPnlGateAudit.unmatchedSellCount ?? 0
  if (count > 0) return `${count} unmatched sell${count === 1 ? '' : 's'} prevent complete-wallet verification`
  return null
}

export function fmtSignedPercent(value: number | null | undefined, digits = 1): string | null {
  if (value == null || !Number.isFinite(value)) return null
  const abs = Math.abs(value).toFixed(digits)
  if (value > 0) return `+${abs}%`
  if (value < 0) return `-${abs}%`
  return `${Number(0).toFixed(digits)}%`
}

export const VERIFIED_SAMPLE_PNL_REASON = (verifiedLotCount: number, pricingCoverage: number): string =>
  `PARTIAL · ${verifiedLotCount} verified closed lots · ${(pricingCoverage * 100).toFixed(0)}% pricing coverage`

export const VERIFIED_SAMPLE_ROI_REASON = 'PARTIAL · realized-only bounded sample'

export const VERIFIED_BOUNDED_SAMPLE_STATUS_LABEL = 'PARTIAL / VERIFIED BOUNDED SAMPLE'

export const VERIFIED_SAMPLE_UNAVAILABLE_REASON = 'Verified sample PnL is unavailable — included lot integrity failed.'

export const FULL_WALLET_ROI_LOCKED_REASON = 'Full-wallet ROI is locked until complete-wallet history is verified. Verified Sample ROI is realized-only and does not include unrealized PnL.'


export function buildOfficialUnavailableReason(params: {
  reconciliationSummary?: PnlReconciliationSummary | null
  walletPnlEvidenceAudit?: WalletPnlEvidenceAudit | null
}): string {
  const summary = params.reconciliationSummary ?? null
  if (canonicalClosedLotCounts(summary) && summary) {
    return formatCanonicalUnavailableReason(summary)
  }
  const v2Reason = params.walletPnlEvidenceAudit?.failureReason
  if (typeof v2Reason === 'string' && v2Reason.trim() !== '') return v2Reason
  return PNL_UNAVAILABLE_MESSAGE
}

export function isV2ZeroLotUnavailableCopy(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && V2_ZERO_LOT_COPY_RE.test(reason)
}

function officialUnrealizedIsFinite(unrealizedReconciliation: UnrealizedReconciliationSummary | null | undefined): boolean {
  const value = unrealizedReconciliation?.officialUnrealizedPnlUsd
  return value != null && Number.isFinite(value)
}

function officialUnrealizedMagnitudeCorrupt(unrealizedReconciliation: UnrealizedReconciliationSummary | null | undefined): boolean {
  const value = unrealizedReconciliation?.officialUnrealizedPnlUsd
  return value != null && Number.isFinite(value) && Math.abs(value) > GUARDRAIL_ABS_LIMIT
}

function mapConfidenceToUnrealizedBoxStatus(
  v: 'Verified' | 'Partial' | 'Locked' | 'Full' | 'Unavailable',
): WalletPnlBoxStatus {
  if (v === 'Full') return 'Verified'
  if (v === 'Partial') return 'Partial'
  if (v === 'Verified') return 'Verified'
  if (v === 'Locked') return 'Locked'
  return 'Unavailable'
}

// OFFICIAL UNREALIZED BOX, DISCLOSED (Wallet PnL publish Item 2 — confirmed production bug:
// officialUnrealizedPnlUsd was a finite reconciled figure (~-$68.96, reconciliationStatus
// partial/failed, cappedOpenPositions present) but the Unrealized tile rendered LOCKED
// "Magnitude/stability guard blocked this figure" because `blocked` is computed from pnlV2
// magnitude + isStablePnl, and isStablePnl fails whenever publicPnlStatus === 'unavailable').
//
// A finite official reconciled unrealized is Partial (or Verified when recon is ok) — never
// Locked merely because the realized gate is unavailable, and never Locked because V2's raw
// FIFO×price candidate is huge. LOCK remains only for: canonical-sample replay failure, no
// official figure, or the published official magnitude itself exceeding GUARDRAIL_ABS_LIMIT
// ($1e9) — a corruption threshold, documented, applied to the official number only. Does NOT
// invent prices, does NOT force unrealized = portfolio − cost, does NOT publish realized.
export function resolveOfficialUnrealizedBoxStatus(params: {
  canonicalSampleUnavailable: boolean
  blocked: boolean
  confidenceUnrealized: 'Verified' | 'Partial' | 'Locked' | 'Full' | 'Unavailable'
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
}): WalletPnlBoxStatus {
  if (params.canonicalSampleUnavailable) return 'Unavailable'
  if (officialUnrealizedMagnitudeCorrupt(params.unrealizedReconciliation)) return 'Locked'
  if (officialUnrealizedIsFinite(params.unrealizedReconciliation)) {
    const mapped = mapConfidenceToUnrealizedBoxStatus(params.confidenceUnrealized)
    if (mapped === 'Verified') return 'Verified'
    return 'Partial'
  }
  if (params.blocked) return 'Locked'
  return mapConfidenceToUnrealizedBoxStatus(params.confidenceUnrealized)
}

export function buildOfficialUnrealizedBoxReason(params: {
  status: WalletPnlBoxStatus
  canonicalSampleUnavailable: boolean
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
}): string {
  if (params.canonicalSampleUnavailable) return CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
  if (params.status === 'Locked') {
    if (officialUnrealizedMagnitudeCorrupt(params.unrealizedReconciliation)) {
      return `Magnitude guard blocked this figure — official unrealized exceeds the ${GUARDRAIL_ABS_LIMIT} USD integrity threshold.`
    }
    return 'Magnitude/stability guard blocked this figure.'
  }
  if (params.status === 'Verified') return 'Open-position estimate reconciled with live prices.'
  if (params.status === 'Partial') {
    const specific = buildUnrealizedPartialReasonMessage(params.unrealizedReconciliation)
    if (specific) return specific
    const recon = params.unrealizedReconciliation
    const excluded = recon?.excludedOpenPositions ?? 0
    const total = recon?.totalOpenPositions ?? 0
    const capped = recon?.cappedOpenPositions ?? 0
    const reconWord = recon?.reconciliationStatus === 'failed' ? 'failed' : 'partial'
    const bits: string[] = [`Open-position estimate is ${reconWord}`]
    if (total > 0) bits.push(`${excluded} of ${total} positions excluded`)
    if (capped > 0) bits.push(`${capped} capped to canonical balance`)
    return `${bits.join(' — ')}.`
  }
  return 'No reconciled open-position evidence.'
}

export type BuildWalletPnlViewModelParams = {
  pnlV2: PnlV2 | null | undefined
  publicPnlStatus?: PublicPnlStatus | null
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
  reconciliationSummary?: PnlReconciliationSummary | null
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
  robinhoodResult?: RobinhoodWalletScanResponse | null
  chainsScanned?: string[]
  // WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED: does NOT change combinedStatus/blocked/any gating —
  // officialPnlStatus (publicPnlStatus above) stays the sole authority for verified/partial/
  // unavailable, per this file's own "NO NEW PNL MATH" rule. V2 walletPnlEvidenceAudit.failureReason
  // is diagnostic-only and is used as unavailable copy ONLY when canonical recon has zero closed
  // lots (or recon isn't wired). When publicPnlGateAudit has real closed lots, official copy comes
  // from that gate (coverage, unmatched, missing evidence) — never V2's closedLots:0 line.
  walletPnlEvidenceAudit?: WalletPnlEvidenceAudit | null
}

function box(value: string | null, status: WalletPnlBoxStatus, reason: string, statusLabel?: string): WalletPnlBox {
  return statusLabel ? { value, status, reason, statusLabel } : { value, status, reason }
}

export function buildWalletPnlViewModel(params: BuildWalletPnlViewModelParams): WalletPnlViewModel {
  const { pnlV2, publicPnlStatus, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit, robinhoodResult, chainsScanned, walletPnlEvidenceAudit } = params
  const specificUnavailableReason = buildOfficialUnavailableReason({ reconciliationSummary, walletPnlEvidenceAudit })

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
    combinedReason = formatFullWalletUnavailableReason(reconciliationSummary) ?? specificUnavailableReason
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
            : (formatFullWalletUnavailableReason(reconciliationSummary) ?? specificUnavailableReason),
  )

  const sample = reconciliationSummary?.verifiedSamplePerformance
  const sampleWired = sample != null && (sample.status === 'verified_bounded_sample' || sample.verifiedLotCount > 0)
  const sampleAllowed = sample?.status === 'verified_bounded_sample' && sample.realizedPnlUsd != null && Number.isFinite(sample.realizedPnlUsd)
  const sampleBlockedReason = reconciliationSummary?.verifiedSamplePerformanceAudit?.samplePerformanceBlockedReason
  const verifiedSampleRealizedBox = canonicalSampleUnavailable
    ? box(null, 'Unavailable', CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL)
    : sampleAllowed
      ? box(
        fmtSignedUsd(sample!.realizedPnlUsd),
        'Partial',
        VERIFIED_SAMPLE_PNL_REASON(sample!.verifiedLotCount, sample!.pricingCoverage),
        VERIFIED_BOUNDED_SAMPLE_STATUS_LABEL,
      )
      : box(
        null,
        'Unavailable',
        sampleBlockedReason
          ? `Verified sample unavailable (${sampleBlockedReason}).`
          : VERIFIED_SAMPLE_UNAVAILABLE_REASON,
      )

  // ROBINHOOD BOX, DISCLOSED: a distinct top-row box (never folded into the combined figure above) —
  // 'Verified' shows the real gated figure + compact proof; a genuinely not-verified or absent scan
  // never shows a number, matching the exact same selectRobinhoodPnlLaneStatus gate the chain row and
  // CORTEX both already use.
  const robinhoodBoxStatus: WalletPnlChainRowStatus = robinhoodLane === 'verified' ? 'Verified' : robinhoodLane === 'not_verified' ? 'Not verified' : 'Unavailable'

  // UNREALIZED, DISCLOSED: a finite officialUnrealizedPnlUsd is Partial/Verified from the
  // reconciliation itself — never Locked just because realized publicPnlStatus is unavailable or
  // because pnlV2's raw magnitude tripped the combined guard. See resolveOfficialUnrealizedBoxStatus.
  const unrealizedStatus = resolveOfficialUnrealizedBoxStatus({
    canonicalSampleUnavailable,
    blocked,
    confidenceUnrealized: confidence.unrealized,
    unrealizedReconciliation,
  })
  const unrealizedBox = box(
    displayed.unrealizedPnlUsd == null || unrealizedStatus === 'Unavailable' || unrealizedStatus === 'Locked' || shouldSuppressUnverifiedZeroPnl(unrealizedStatus, displayed.unrealizedPnlUsd) ? null : fmtSignedUsd(displayed.unrealizedPnlUsd),
    unrealizedStatus,
    buildOfficialUnrealizedBoxReason({
      status: unrealizedStatus,
      canonicalSampleUnavailable,
      unrealizedReconciliation,
    }),
  )

  // ROI, DISCLOSED (verified-sample-vs-full-history follow-up): realized-only Verified Sample ROI
  // from the included canonical lots. Full-wallet / combined (realized+unrealized) ROI is never
  // computed — open-position coverage is not independently verified. Unmatched sells outside the
  // sample must not erase this number. A caller that has not yet wired verifiedSamplePerformance
  // keeps the prior Combined-gated ROI (Verified only when Combined itself is verified).
  const sampleRoiAllowed = sampleAllowed && sample?.realizedRoiPct != null && Number.isFinite(sample.realizedRoiPct)
  const roiStatus: WalletPnlBoxStatus = canonicalSampleUnavailable
    ? 'Unavailable'
    : sampleWired
      ? (sampleRoiAllowed ? 'Partial' : 'Unavailable')
      : combinedStatus === 'verified'
        ? 'Verified'
        : 'Locked'
  const roiBox = box(
    sampleWired
      ? (sampleRoiAllowed ? fmtSignedPercent(sample!.realizedRoiPct) : null)
      : (roiStatus === 'Verified' && displayed.roiPercent != null ? displayed.roiLabel : null),
    roiStatus,
    canonicalSampleUnavailable
      ? CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL
      : sampleRoiAllowed
        ? VERIFIED_SAMPLE_ROI_REASON
        : sampleWired && sampleAllowed && sample?.realizedCostBasisUsd != null && sample.realizedCostBasisUsd <= 0
          ? 'Verified Sample ROI unavailable — sample cost basis is not positive.'
          : sampleWired
            ? VERIFIED_SAMPLE_UNAVAILABLE_REASON
            : roiStatus === 'Verified'
              ? 'Realized PnL vs verified cost basis.'
              : 'Locked until combined PnL is verified.',
    sampleRoiAllowed ? VERIFIED_BOUNDED_SAMPLE_STATUS_LABEL : undefined,
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

  const sampleEvidenceLine = sampleAllowed
    ? [
      `Verified Sample Realized PnL ${fmtSignedUsd(sample!.realizedPnlUsd)}`,
      sampleRoiAllowed ? `ROI ${fmtSignedPercent(sample!.realizedRoiPct)}` : null,
      VERIFIED_BOUNDED_SAMPLE_STATUS_LABEL,
    ].filter((part): part is string => part != null).join(' · ')
    : null

  return {
    combinedStatus,
    combinedReason,
    combinedRealizedBox,
    verifiedSampleRealizedBox,
    robinhoodBox,
    unrealizedBox,
    roiBox,
    chainRows,
    sampleEvidenceLine,
    robinhoodProof,
  }
}

export default buildWalletPnlViewModel

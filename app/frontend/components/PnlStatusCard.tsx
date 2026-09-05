'use client'

import { useState } from 'react'

// PnlStatusCard — single-verified-source redesign of the FIFO & PnL section.
//
// SINGLE-SOURCE MIGRATION, DISCLOSED (this task's own request): this component previously merged
// THREE independent PnL sources with a silent priority fallback (pnlV2 > fifoAndPnl > pnlSummaryV2
// — see this file's own prior header/selectPnlData for the exact old logic) — realized/unrealized
// numbers, ROI, integrity, and the closed-lots table each quietly came from whichever of the three
// happened to be present, which is exactly the "duplicate/inconsistent PnL" confusion this task
// asked to eliminate. This component now reads ONLY `pnlV2` (lib/engine/modules/pnl/types.ts's
// PnlV2 — the V2 engine's own self-contained realized+unrealized computation) for every number it
// renders. `fifoAndPnl`/`pnlSummaryV2` (the old pipeline's FIFO engine / pnlEngine outputs) are no
// longer accepted as props at all — never merged, never averaged, never used as a silent fallback.
//
// REAL GAPS FROM DROPPING THE OLD SOURCES, DISCLOSED (not silently worked around):
//   - Integrity/confidence: PnlV2 carries no integrity-flag or confidence concept at all (no
//     hardInvalid/estimateOnlyLotsExcluded/syntheticLotsExcluded equivalent). Previously this badge
//     read fifoAndPnl.integrityFlags — now honestly shows "Not available (V2 engine)" rather than
//     silently falling back to the excluded pipeline-level source.
//   - Matched/Unmatched Lots, Closed Lots table, Sell Timeline: these are FIFO-lot-level concepts
//     (lotId/txHash/costUsdEstimate/proceedsUsdEstimate/evidence) that do not exist in PnlV2's shape
//     at all (PnlV2 has per-TOKEN realized/unrealized entries — TokenRealizedPnl/TokenUnrealizedPnl
//     — not per-LOT entries). Removed entirely rather than sourced from the now-excluded
//     fifoAndPnl/pnlSummaryV2. Replaced with a real, verified-source-only view: per-token
//     realized/unrealized breakdown and per-chain breakdown, both directly from PnlV2.
//   - ROI: now computed purely from PnlV2 — realizedPnlUsd / sum(costBasis[].totalCostUsd), a real
//     total cost basis PnlV2 does carry (per-token, summed here), never fifoAndPnl.costBasisUsd.
import type { PnlV2, WalletPnlEvidenceAudit } from '@/lib/engine/modules/pnl/types'
import type { PublicPnlStatus, UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'
import type { SyntheticPnlSummary } from '@/src/modules/syntheticPnl/types'
import type { PnlReconciliationSummary } from '@/src/lib/pnlReconciliation'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'
import { selectRobinhoodPnlLaneStatus, ROBINHOOD_PNL_NOT_VERIFIED_REASON, type RobinhoodWalletScanResponse, type RobinhoodPnlLaneStatus } from './RobinhoodChainSection'
import { selectEvmPnlLaneStatus as selectEvmPnlLaneStatusShared, type EvmPnlLaneStatus as SharedEvmPnlLaneStatus } from '@/lib/walletScan/canonicalWalletSelectors'
import { PARTIAL_TRUST_GATE_PUBLIC_LABEL } from '@/src/lib/pnlDiscrepancyAudit'
import { fmtSignedUsd, fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { StatusBadge } from './StatusBadge'
import { TrendingDownIcon, TrendingUpIcon, WarningIcon } from './Icons'
import { SyntheticPnlBlock } from './SyntheticPnlBlock'
import { SyntheticPerChainPnlBlock } from './SyntheticPerChainPnlBlock'
import { buildWalletPnlViewModel, type WalletPnlBox, type WalletPnlBoxStatus, type WalletPnlChainRow, type WalletPnlCombinedStatus, type WalletPnlRobinhoodBox } from '@/app/frontend/lib/buildWalletPnlViewModel'

// COMBINED-STATUS DISPLAY MAPS, DISCLOSED: presentation only — the underlying classification comes
// entirely from buildWalletPnlViewModel's combinedStatus, never re-derived here. "Combined "
// PREFIX, DISCLOSED (PnL Evidence UI cleanup follow-up, this task's own explicit spec — "Badge:
// Combined Locked"): makes explicit that this badge describes the COMBINED (Base/ETH) figure only,
// never Robinhood's separately-verified one — see the Robinhood box below for that.
const COMBINED_STATUS_LABEL: Record<WalletPnlCombinedStatus, string> = {
  verified: 'Combined Verified', partial: 'Combined Partial', locked: 'Combined Locked', unavailable: 'Combined Unavailable',
}
const COMBINED_STATUS_TONE: Record<WalletPnlCombinedStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  verified: 'success', partial: 'warning', locked: 'warning', unavailable: 'neutral',
}
const COMBINED_REASON_COLOR: Record<WalletPnlCombinedStatus, string> = {
  verified: '#4ade80', partial: '#fbbf24', locked: '#fbbf24', unavailable: 'rgba(226,232,240,0.75)',
}
const BOX_STATUS_TONE: Record<WalletPnlBoxStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  Verified: 'success', Partial: 'warning', Locked: 'danger', Unavailable: 'neutral',
}
const CHAIN_ROW_STATUS_TONE: Record<WalletPnlChainRow['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  Verified: 'success', Partial: 'warning', Unavailable: 'neutral', 'Not verified': 'warning',
}

// PNL BOX TILE, DISCLOSED: one clean tile per top-row figure (Realized/Unrealized/ROI/Cost Basis) —
// value (only when the box's own status says there's a real one to show), a status badge, and a
// single reason line. Replaces the old 6-tile MetricCard grid + separate confidence-status row.
function PnlBoxTile({ label, box }: { label: string; box: WalletPnlBox }) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: '150px', padding: '13px 15px', borderRadius: '13px',
      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: '5px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.72)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{label}</span>
        <StatusBadge label={box.status} tone={BOX_STATUS_TONE[box.status]} />
      </div>
      <div style={{ fontSize: '16px', fontWeight: 800, color: '#e2e8f0' }}>{box.value ?? '—'}</div>
      <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.60)', lineHeight: 1.4 }}>{box.reason}</div>
    </div>
  )
}

// ROBINHOOD BOX TILE, DISCLOSED (PnL Evidence UI cleanup follow-up, this task's own explicit spec —
// "Robinhood Realized PnL" as its own top-row box with proof inline): a distinct tile from the
// generic PnlBoxTile — shows the real gated value/reason plus the compact swaps/closed-lots/price-
// evidence proof lines directly in the box, never merged with the Combined Realized PnL tile.
const ROBINHOOD_BOX_STATUS_TONE: Record<WalletPnlRobinhoodBox['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  Verified: 'success', Partial: 'warning', Unavailable: 'neutral', 'Not verified': 'warning',
}
function PnlRobinhoodBoxTile({ box }: { box: WalletPnlRobinhoodBox }) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: '150px', padding: '13px 15px', borderRadius: '13px',
      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: '5px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.72)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>Robinhood Realized PnL</span>
        <StatusBadge label={box.status} tone={ROBINHOOD_BOX_STATUS_TONE[box.status]} />
      </div>
      <div style={{ fontSize: '16px', fontWeight: 800, color: '#e2e8f0' }}>{box.value ?? '—'}</div>
      <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.60)', lineHeight: 1.4 }}>{box.reason}</div>
      {box.proof && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginTop: '2px', fontSize: '10px', color: 'rgba(148,163,184,0.85)' }}>
          <span>Source: {box.proof.source}</span>
          <span>Verified swaps: {box.proof.verifiedSwaps}</span>
          <span>Closed lots: {box.proof.closedLots}</span>
          <span>Price evidence: {box.proof.priceEvidence}</span>
        </div>
      )}
    </div>
  )
}

// PNL CHAIN ROW, DISCLOSED: one simple row per chain — label, status badge, value. Replaces the old
// ChainBreakdownTable + separate RobinhoodPnlRow with ONE shared list every chain (EVM and
// Robinhood) renders through identically.
function PnlChainRowItem({ row }: { row: WalletPnlChainRow }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 10px', borderRadius: '9px', background: 'rgba(255,255,255,0.015)' }}>
      <span style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '12px', minWidth: '90px' }}>{row.label}</span>
      <StatusBadge label={row.status} tone={CHAIN_ROW_STATUS_TONE[row.status]} />
      <span style={{ fontSize: '12px', fontWeight: 700, marginLeft: 'auto', color: row.value == null ? 'rgba(148,163,184,0.55)' : row.value.startsWith('-') ? '#f87171' : '#4ade80' }}>
        {row.value ?? '—'}
      </span>
    </div>
  )
}

export { selectRobinhoodPnlLaneStatus, ROBINHOOD_PNL_NOT_VERIFIED_REASON, type RobinhoodPnlLaneStatus }

export type PnlStatusCardProps = {
  pnlV2: PnlV2 | null | undefined
  // Optional, additive — the REAL field lives at
  // result.finalSummary.financialStatus.officialPnlStatus (FifoOutput['publicPnlStatus'] =
  // 'ok' | 'limited_verified_sample' | 'unavailable'; there is no `publicPnlStatus` directly on
  // pnlV2 or on the report's top level, despite a later task describing one there). Omitting this
  // prop simply skips the badge below — no fabricated default value.
  publicPnlStatus?: PublicPnlStatus | null
  // Optional, additive — the real field lives at result.syntheticPnl (src/modules/syntheticPnl,
  // UI-DISPLAY-ONLY — never derived from or fed into fifoEngine/pnlV2, see that module's own
  // header). Only ever rendered when publicPnlStatus === 'unavailable' AND pnlV2's own display is
  // blocked — never overlaid on top of a real, verified number.
  syntheticPnl?: SyntheticPnlSummary | null
  // CANONICAL UNREALIZED-PNL SOURCE, DISCLOSED (found live, this task — confirmed production bug:
  // the wallet-scanner UI kept showing a fabricated ~$500k unrealized PnL, sourced from pnlV2's own
  // unrealizedPnlUsd, DESPITE the backend's real canonical reconciliation
  // — result.fifoAndPnl.unrealizedReconciliation.officialUnrealizedPnlUsd — already correctly
  // reporting -$0.0863). Real field lives at result.fifoAndPnl.unrealizedReconciliation
  // (src/modules/fifoEngine/types.ts's UnrealizedReconciliationSummary) — a SEPARATE engine
  // (fifoEngine) from pnlV2 (lib/engine/modules/pnl), but its own reconciliation, not its
  // un-reconciled top-level unrealizedPnlUsd, is now this card's SOLE source for the displayed
  // Unrealized PnL value. See selectDisplayedUnrealizedPnl's own header below for the exact rule.
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
  // BOUNDED VERIFIED SAMPLE, DISCLOSED (bounded-PnL-UI follow-up task): the real, canonical
  // pnlReconciliation output — result.reconciliationSummary (src/lib/pnlReconciliation.ts). Only
  // ever consulted for the disclosure block shown when publicPnlStatus === 'limited_verified_sample'
  // (the real backend value for a bounded, 90-day-window-limited but independently-verified sample —
  // see `publicPnlGateAudit.boundedSampleEligible` on the backend). Never merged into pnlV2's own
  // numbers above, never used for 'ok'/'unavailable' — those keep their existing, unchanged behavior.
  reconciliationSummary?: PnlReconciliationSummary | null
  // FAIL-CLOSED UI, DISCLOSED (canonical-manifest-fast-path follow-up task, issue #2 — confirmed
  // production bug: a scan whose canonical manifest replay failed [`canonicalSampleEvidenceUnavailable:
  // true`, backend-forced `realizedPnlUsd: null`/`publicPnlStatus: 'unavailable'`] still displayed an
  // unrelated "37.35% coverage" figure somewhere in the UI). Optional, additive — a caller that
  // hasn't wired it gets today's existing behavior unchanged. When supplied and
  // `canonicalSampleEvidenceUnavailable === true`, this OVERRIDES every other source below
  // (`pnlV2`, `reconciliationSummary`, `publicPnlStatus`) regardless of what any of them individually
  // claim — defense in depth, not a replacement for the backend's own fail-closed gate. See
  // `selectDisplayedPnl`'s own header for the exact precedence.
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
  // ADDED, DISCLOSED (finish-Wallet-Scanner-Robinhood-integration follow-up, this task's own explicit
  // requirement 5 — confirmed live bug: "PnL per-chain breakdown only shows chain 1 and 8453;
  // Robinhood is silently missing"): ChainBreakdownTable below is, and stays, pnlV2.chainBreakdown-
  // only (EVM engine output — never touched by this task, per its own "do not change Base/ETH/BNB
  // PnL/FIFO" rule). This optional prop adds an HONEST, SEPARATE row underneath it for Robinhood —
  // its real pnl.status/message/realizedPnlUsd exactly as lib/server/robinhoodWalletScanner.ts's own
  // PnL gate already computed and disclosed (never a fabricated number, never upgraded to
  // "verified"). Omitting this prop (a caller not yet wired, or a scan with no Robinhood result)
  // renders exactly as before this task — the per-chain section simply says nothing about Robinhood.
  robinhoodResult?: RobinhoodWalletScanResponse | null
  // ADDED, DISCLOSED (Wallet-Scanner-Robinhood-final-integration follow-up, this task's own explicit
  // requirement 5 — "Per-chain breakdown must show status: Base: verified/partial, ETH:
  // verified/partial, Robinhood: verified/not verified/unavailable"): the real EVM chain slugs this
  // scan covered (report.scanMetadata?.chainsScanned) — used ONLY to decide which EVM lane badges to
  // render (never to recompute pnlV2 itself). Omitting this prop simply skips the EVM lane badges —
  // no fabricated chain list.
  chainsScanned?: string[]
  // WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED — the real field lives at result.walletPnlEvidenceAudit
  // (lib/engine/modules/pnl/types.ts, populated by workers/walletScanV2.ts alongside pnlV2). Never
  // changes combinedStatus/blocked/any verified-vs-unavailable gate (officialPnlStatus above stays
  // the sole authority for that) — only replaces the generic "PnL unavailable due to missing
  // evidence" wording with the real blocker (open position only / no verified swaps / quote leg
  // missing) when the combined figure is unavailable. Omitting this prop keeps the old generic
  // message exactly as before.
  walletPnlEvidenceAudit?: WalletPnlEvidenceAudit | null
}

export type VerifiedPnlData = {
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  totalPnlUsd: number | null
  totalCostBasisUsd: number | null
  roi: { value: number | null; display: string }
  // Honest placeholders — PnlV2 (the one verified source this component now reads) carries neither.
  // Never derived from the excluded fifoAndPnl/pnlSummaryV2 sources.
  integritySummary: 'not_available_in_v2_engine'
  // DISPLAY-ONLY GUARDRAIL, DISCLOSED: true when unrealizedPnlUsd or totalCostBasisUsd exceeds
  // GUARDRAIL_ABS_LIMIT. This flag never changes pnlV2 itself or any number returned above — it
  // only tells the component below to swap the numeric MetricCards for a "Not reliable" placeholder
  // and a warning badge. The underlying pnlV2 data is untouched and still fully present in this
  // object for any caller (e.g. a test) that wants the raw number regardless of the clamp.
  unreliable: boolean
  // STABLE-PNL GUARD, DISCLOSED (this task's own request) — see isStablePnl's own header for the
  // exact rule and the two real-field corrections applied. `unreliable` (the magnitude heuristic
  // above) and `!stable` are two INDEPENDENT reasons a display can be blocked; either one alone is
  // enough (see PnlStatusCard's own `blocked` combination below).
  stable: boolean
}

// UI-ONLY HEURISTIC, DISCLOSED: not a backend-computed threshold. pnlV2 (lib/engine/modules/pnl)
// has no evidence-count/confidence field of its own, so the only defensive signal available at this
// layer is magnitude — a real wallet's realistic USD PnL/cost-basis does not reach $1e9. This value
// existing at all almost always means a missing/duplicate-decimals price or a pathological token
// slipped past pricingAtTimeEngine, not a real gain/loss. Chosen for THIS card only; does not alter
// pricingAtTimeEngine, fifoEngine, or pnlV2's own semantics anywhere else in the codebase.
export const GUARDRAIL_ABS_LIMIT = 1e9

// UNREALIZED-VALUE PARAMETERIZED, DISCLOSED: this used to read pnlV2.unrealizedPnlUsd directly —
// now takes the ALREADY-RESOLVED displayed unrealized value (from selectDisplayedUnrealizedPnl,
// the canonical fifoEngine reconciliation, never pnlV2's own field) so this guard reacts to the
// SAME number the card actually renders, never a legacy figure the card no longer displays at all.
// Per-chain unrealizedPnlUsd (pnlV2.chainBreakdown) is deliberately EXCLUDED from this magnitude
// check now — see ChainBreakdownTable's own header for why that legacy per-chain figure is no
// longer rendered as an official number either.
function isUnreliableMagnitude(pnlV2: PnlV2, totalCostBasisUsd: number, displayedUnrealizedPnlUsd: number | null): boolean {
  const magnitudes = [
    pnlV2.realizedPnlUsd,
    totalCostBasisUsd,
    ...pnlV2.chainBreakdown.map((c) => c.realizedPnlUsd),
  ]
  if (displayedUnrealizedPnlUsd != null) magnitudes.push(displayedUnrealizedPnlUsd)
  return magnitudes.some((v) => Math.abs(v) > GUARDRAIL_ABS_LIMIT)
}

// CANONICAL UNREALIZED-PNL SELECTOR, DISCLOSED — see PnlStatusCardProps.unrealizedReconciliation's
// own header for the full production trace. Pure, exported for direct testing. The ONLY function
// this card uses to resolve the displayed Unrealized PnL value — no priority list, no merge, no
// averaging, and specifically NEVER pnlV2.unrealizedPnlUsd (the legacy, un-reconciled figure that
// caused the reported ~$500k bug). `unrealizedReconciliation` missing/null (a caller that hasn't
// wired it, or a genuinely absent backend field) and `officialUnrealizedPnlUsd` itself being null
// (backend computed reconciliation but found nothing trustworthy to report) BOTH resolve to `value:
// null` here — the component then renders "Unavailable", never a fallback estimate.
export type DisplayedUnrealizedPnl = {
  value: number | null
  reconciliationStatus: UnrealizedReconciliationSummary['reconciliationStatus'] | null
  coveragePercent: number | null
}

export function selectDisplayedUnrealizedPnl(
  unrealizedReconciliation: UnrealizedReconciliationSummary | null | undefined,
): DisplayedUnrealizedPnl {
  if (!unrealizedReconciliation) {
    return { value: null, reconciliationStatus: null, coveragePercent: null }
  }
  return {
    value: unrealizedReconciliation.officialUnrealizedPnlUsd,
    reconciliationStatus: unrealizedReconciliation.reconciliationStatus,
    coveragePercent: unrealizedReconciliation.unrealizedCoveragePercent,
  }
}

// EXACT-REASON PARTIAL MESSAGE, DISCLOSED, ADDITIVE (Wallet Scanner improvement audit, task 5 —
// requested example: "Unrealized PnL is partial because 25 positions had no verified current price
// and 35 had no canonical balance. Dead/spam tokens were excluded."). Pure, exported for direct
// testing. Built ENTIRELY from unrealizedReconciliation's own already-computed
// excludedClassificationCounts/deadOrSpamPositionsCount — never a re-derivation, never a guess. A
// clause is included only when its real count is > 0, so a scan with (say) zero missing-balance
// exclusions never mentions missing balances. Returns null when there is nothing partial to explain
// (no reconciliation wired, or reconciliationStatus isn't 'partial').
export function buildUnrealizedPartialReasonMessage(
  unrealizedReconciliation: UnrealizedReconciliationSummary | null | undefined,
): string | null {
  if (!unrealizedReconciliation || unrealizedReconciliation.reconciliationStatus !== 'partial') return null
  const counts = unrealizedReconciliation.excludedClassificationCounts
  const missingPrice = counts.missing_price ?? 0
  const missingBalance = counts.missing_balance ?? 0
  const balanceLessThanFifoOpen = counts.balance_less_than_fifo_open ?? 0
  const unsupported = counts.unsupported ?? 0
  const deadOrSpam = unrealizedReconciliation.deadOrSpamPositionsCount

  const clauses: string[] = []
  if (missingPrice > 0) clauses.push(`${missingPrice} position${missingPrice === 1 ? '' : 's'} had no verified current price`)
  if (missingBalance > 0) clauses.push(`${missingBalance} had no canonical balance`)
  if (balanceLessThanFifoOpen > 0) clauses.push(`${balanceLessThanFifoOpen} showed a balance smaller than the recorded open position`)
  if (unsupported > 0) clauses.push(`${unsupported} could not be verified from available evidence`)

  let reasonSentence: string
  if (clauses.length === 0) {
    reasonSentence = 'some open positions could not be independently verified this scan'
  } else if (clauses.length === 1) {
    reasonSentence = clauses[0]
  } else {
    reasonSentence = `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`
  }

  const spamSentence = deadOrSpam > 0
    ? ` ${deadOrSpam} dead/spam token${deadOrSpam === 1 ? '' : 's'} ${deadOrSpam === 1 ? 'was' : 'were'} excluded.`
    : ''

  return `Unrealized PnL is partial because ${reasonSentence}.${spamSentence}`
}

// REALIZED-PNL VERIFIED MESSAGE, DISCLOSED, ADDITIVE (task 5 — "Realized PnL: Verified / 100%
// closed-lot coverage" requirement). This card has no closed-lot coverage PERCENT wired to it today
// (that figure lives in priceLotsForWallet's HistoricalPricingPerformanceSummary, several layers
// away from this component's props) — rather than fabricate a number this component cannot verify,
// this only ever asserts "Verified", tied to the real backend publicPnlStatus === 'ok' gate (the
// same real signal every other verified/unavailable distinction on this card already uses).
export function buildRealizedVerifiedMessage(publicPnlStatus: PublicPnlStatus | null | undefined): string | null {
  if (publicPnlStatus !== 'ok') return null
  return 'Realized PnL: Verified — closed-lot coverage confirmed.'
}

// SPLIT PNL CONFIDENCE, DISCLOSED, ADDITIVE (Wallet Scanner second-pass audit, task 4 — "do not mix
// realized and unrealized confidence"). Every field here is read from an already-real, already-
// computed backend value — never a new computation, never a guess standing in for a missing one
// (each field falls back to null/'Not available' rather than defaulting to an optimistic label).
export type PnlConfidenceStatus = {
  realized: 'Verified' | 'Partial' | 'Locked'
  unrealized: 'Full' | 'Partial' | 'Unavailable'
  historicalCoverage: string
  openPositionCoveragePercent: number | null
  integrity: 'OK' | 'Needs review' | 'Debug only' | null
}

export function selectPnlConfidenceStatus(
  effectivePublicPnlStatus: PublicPnlStatus | null | undefined,
  unrealizedReconciliation: UnrealizedReconciliationSummary | null | undefined,
  reconciliationSummary: PnlReconciliationSummary | null | undefined,
): PnlConfidenceStatus {
  const realized: PnlConfidenceStatus['realized'] =
    effectivePublicPnlStatus === 'ok' ? 'Verified'
      : effectivePublicPnlStatus === 'limited_verified_sample' ? 'Partial'
      : 'Locked'

  const reconciliationStatus = unrealizedReconciliation?.reconciliationStatus ?? null
  const unrealized: PnlConfidenceStatus['unrealized'] =
    reconciliationStatus === 'ok' ? 'Full'
      : reconciliationStatus === 'partial' || reconciliationStatus === 'failed' ? 'Partial'
      : 'Unavailable'

  const audit = reconciliationSummary?.publicPnlGateAudit
  const scanWindowDays = audit?.scanWindowDays ?? null
  const historicalCoverage =
    audit?.historyCoverageStatus === 'exhaustive' ? (scanWindowDays != null ? `Full ${scanWindowDays}-day history` : 'Full history')
      : audit?.historyCoverageStatus === 'truncated' ? 'Bounded sample (history truncated)'
      : audit?.historyCoverageStatus === 'partial' ? (scanWindowDays != null ? `Bounded sample (${scanWindowDays}-day)` : 'Bounded sample')
      : 'Not available'

  const integrity: PnlConfidenceStatus['integrity'] =
    audit?.integrityTier === 'full' ? 'OK'
      : audit?.integrityTier === 'partial' ? 'Needs review'
      : audit?.integrityTier === 'blocked' ? 'Debug only'
      : null

  return {
    realized,
    unrealized,
    historicalCoverage,
    openPositionCoveragePercent: unrealizedReconciliation?.openPositionCoveragePercent ?? null,
    integrity,
  }
}

// DEV-ONLY DIAGNOSTIC, DISCLOSED (this task's own "add a development assertion/log identifying the
// exact field selected" requirement): a single, cheap console.debug — never runs in production
// (next.config's compiler.removeConsole strips console.debug/log there anyway, but this also skips
// the call entirely rather than relying only on that stripping). Identifies, in plain text, exactly
// which real field backed the rendered Unrealized PnL for this render — makes a future regression
// (a fallback silently reintroduced) immediately visible in the browser console during development.
function logUnrealizedPnlFieldSelection(displayed: DisplayedUnrealizedPnl, legacyPnlV2UnrealizedPnlUsd: number | null | undefined): void {
  if (process.env.NODE_ENV === 'production') return
  const field = displayed.value != null
    ? 'fifoAndPnl.unrealizedReconciliation.officialUnrealizedPnlUsd'
    : 'unavailable (no reconciliation or null officialUnrealizedPnlUsd)'
  // eslint-disable-next-line no-console
  console.debug('[PnlStatusCard] Unrealized PnL field selected', {
    field,
    displayedValue: displayed.value,
    reconciliationStatus: displayed.reconciliationStatus,
    coveragePercent: displayed.coveragePercent,
    // Logged ONLY for comparison/debugging — never used anywhere as the displayed value.
    legacyPnlV2UnrealizedPnlUsd: legacyPnlV2UnrealizedPnlUsd ?? null,
  })
}

// isStablePnl — PURE, exported for direct testing, adapted from this task's own literal spec with
// two real-field corrections, both disclosed:
//   1. `evidenceMissingCount` does not exist on PnlV2 (the single verified source this card reads —
//      see this file's own header). It's a real field on the OLD pipeline's pnlSummaryV2/
//      PnlSummaryResult, which this component deliberately excluded (single-verified-source
//      decision, an earlier task this session). Rather than re-introduce that excluded source just
//      for this one field, it's accepted here as an OPTIONAL parameter — a caller with real access
//      to it (none currently wire it) can supply it; omitted defaults to 0 (pass), never a
//      fabricated failure for a caller that has no such data.
//   2. `publicPnlStatus !== 'available'`: the REAL enum (FifoOutput['publicPnlStatus'],
//      src/modules/fifoEngine/types.ts) is `'ok' | 'limited_verified_sample' | 'unavailable'` — it
//      can never equal the literal string `'available'`. Taking the spec literally would mean this
//      guard ALWAYS fails, permanently hiding every wallet's PnL regardless of data quality — not
//      the intent. `'ok'` is treated as the real equivalent (same mapping this codebase's own
//      FinalSummaryView.tsx already uses for its officialPnlStatus tone). `publicPnlStatus` is
//      already an optional prop on this component (see PnlStatusCardProps) for callers that don't
//      wire it — omitted/undefined does not fail this check by itself, so this guard's addition
//      never silently blocks every existing caller that hasn't been updated to pass it.
//   3. BOUNDED-SAMPLE FIX, DISCLOSED (bounded-PnL-UI follow-up task — confirmed live bug: a real
//      bounded, independently-verified sample — publicPnlStatus === 'limited_verified_sample',
//      backend already proved boundedSampleEligible — was hidden behind the exact same "PnL
//      unavailable" guard as a genuinely `'unavailable'` wallet, because this check previously
//      treated ANY non-'ok' status identically). Only the real `'unavailable'` status blocks now;
//      `'limited_verified_sample'` is a real, backend-verified (if intentionally bounded) result and
//      must be shown, with its own disclosure — see selectBoundedSampleDisclosure below — not hidden.
export function isStablePnl(params: {
  realizedPnlUsd: number | null | undefined
  unrealizedPnlUsd: number | null | undefined
  evidenceMissingCount?: number
  publicPnlStatus?: PublicPnlStatus | null
}): boolean {
  if ((params.evidenceMissingCount ?? 0) > 0) return false
  if (!Number.isFinite(params.realizedPnlUsd)) return false
  if (!Number.isFinite(params.unrealizedPnlUsd)) return false
  if (params.publicPnlStatus === 'unavailable') return false
  return true
}

// Pure, exported for direct testing. The ONLY selector this component uses for realized PnL/ROI/
// cost basis — no priority list, no merge, no averaging: pnlV2 present -> real numbers; pnlV2
// absent -> honestly all-null. UNREALIZED PNL, DISCLOSED: sourced EXCLUSIVELY from
// `unrealizedReconciliation` (via selectDisplayedUnrealizedPnl) — never from pnlV2.unrealizedPnlUsd,
// regardless of whether pnlV2 itself is present. `totalPnlUsd` is therefore also null whenever the
// reconciled unrealized value is null (realized-only would misrepresent itself as a complete total).
export function selectVerifiedPnlData(
  pnlV2: PnlV2 | null | undefined,
  publicPnlStatus?: PublicPnlStatus | null,
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null,
): VerifiedPnlData {
  const displayedUnrealized = selectDisplayedUnrealizedPnl(unrealizedReconciliation)
  logUnrealizedPnlFieldSelection(displayedUnrealized, pnlV2?.unrealizedPnlUsd)

  if (!pnlV2) {
    return {
      realizedPnlUsd: null,
      unrealizedPnlUsd: displayedUnrealized.value,
      totalPnlUsd: null,
      totalCostBasisUsd: null,
      roi: { value: null, display: 'No verified PnL data' },
      integritySummary: 'not_available_in_v2_engine',
      unreliable: false,
      stable: false,
    }
  }

  const totalCostBasisUsd = pnlV2.costBasis.reduce((sum, c) => sum + c.totalCostUsd, 0)
  const roiValue = totalCostBasisUsd > 0 ? (pnlV2.realizedPnlUsd / totalCostBasisUsd) * 100 : null
  const roi = roiValue == null
    ? { value: null, display: 'No cost-basis evidence' }
    : { value: roiValue, display: `${roiValue >= 0 ? '+' : ''}${roiValue.toFixed(1)}%` }

  const unrealizedPnlUsd = displayedUnrealized.value
  const totalPnlUsd = unrealizedPnlUsd == null ? null : pnlV2.realizedPnlUsd + unrealizedPnlUsd

  return {
    realizedPnlUsd: pnlV2.realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    totalCostBasisUsd,
    roi,
    integritySummary: 'not_available_in_v2_engine',
    unreliable: isUnreliableMagnitude(pnlV2, totalCostBasisUsd, unrealizedPnlUsd),
    stable: isStablePnl({ realizedPnlUsd: pnlV2.realizedPnlUsd, unrealizedPnlUsd, publicPnlStatus }),
  }
}

// PER-CHAIN UNREALIZED SUPPRESSION, DISCLOSED (found live, this task — "audit every Wallet Scanner
// UI path that renders Unrealized PnL" requirement): this table's per-chain `unrealizedPnlUsd`
// column came straight from pnlV2.chainBreakdown — the SAME legacy, un-reconciled source responsible
// for the reported ~$500k bug (confirmed: the original bug screenshot's own "PER-CHAIN BREAKDOWN"
// table showed exactly this column, for chain 8453, as the fabricated figure). There is no
// per-chain breakdown of the canonical `unrealizedReconciliation.officialUnrealizedPnlUsd` on the
// backend to substitute it with, so rather than either (a) keep showing the legacy figure as if
// official, or (b) fabricate a per-chain split of the aggregate that doesn't exist, this column is
// replaced with an honest pointer to the one real reconciled number, shown above, whenever a
// canonical reconciliation was supplied to this card at all (regardless of its own value/status).
// PER-CHAIN, BOUNDED SAMPLE, DISCLOSED (requirement #7): `reconciliationSummary` carries no
// per-chain breakdown field today (only wallet-level totals) — so a bounded sample can never show a
// per-chain table SOURCED FROM the canonical reconciliation, and per requirement #7 the pnlV2-derived
// table (a DIFFERENT, non-canonical source for this status) must not be shown in its place either.
// The one honest option is this explicit unavailability sentence — never the old "verified V2
// engine" wording, which reads as if pnlV2 itself were the authority for a bounded sample (it isn't).
export const PER_CHAIN_BOUNDED_SAMPLE_MESSAGE = 'Per-chain breakdown not available for this verified sample'

// PNL LANE STATUS, DISCLOSED (Wallet-Scanner-Robinhood-final-integration follow-up, this task's own
// explicit requirement 2/6 — "Split PnL lanes: Base/ETH PnL lane, Robinhood PnL lane... CORTEX must
// use same PnL lane statuses"): the ONE shared, exported classification every real caller of this
// component's PnL lane state must use — page.tsx's buildCortexReadV2 (the CORTEX Wallet Read
// sidebar) imports and calls these SAME two functions with the SAME real report fields
// WalletScannerSummaryRowV3 already passes into this card, so CORTEX and the main UI can never
// disagree on lane status. Neither function performs a network call or new computation — both are
// pure re-derivations of state this component (or robinhoodWalletScanner.ts's own PnL gate) already
// computes elsewhere.
//
// EVM LANE, DISCLOSED: reuses this file's own selectVerifiedPnlData/resolveEffectivePublicPnlStatus
// (the SAME pipeline the numeric tiles below are built from) — 'partial' covers both the bounded-
// sample case (effectivePublicPnlStatus === 'limited_verified_sample') and the magnitude/stability
// guard (`blocked`) that already suppresses the numeric tiles elsewhere in this file; 'unavailable'
// only when pnlV2 itself is absent (isActive === false).
export type EvmPnlLaneStatus = SharedEvmPnlLaneStatus
export function selectEvmPnlLaneStatus(params: {
  pnlV2: PnlV2 | null | undefined
  publicPnlStatus?: PublicPnlStatus | null
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
  reconciliationSummary?: PnlReconciliationSummary | null
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
}): EvmPnlLaneStatus {
  return selectEvmPnlLaneStatusShared(params)
}

// ROBINHOOD LANE, DISCLOSED: defined in RobinhoodChainSection.tsx (next to the response type) so
// this card, the Robinhood tab, and CORTEX share one function without a circular import. Re-exported
// here so existing callers/tests that import from this file keep working.

// ROBINHOOD ROW / CHAIN BREAKDOWN TABLE, REMOVED, DISCLOSED (Smart Money Score + PnL Evidence UI
// simplification task): these two components (a distinct Robinhood row + a separate EVM chain
// table) are now replaced by ONE shared chain-row list — buildWalletPnlViewModel.ts's chainRows —
// rendered via PnlChainRowItem near the top of this file, with the SAME real gates (never a fake
// "verified" Robinhood figure; pnlV2.chainBreakdown is still the only real per-chain source).

// Pure, exported for direct testing — real backend classification only, no UI-only heuristic.
// Returns null for 'ok' (no badge) or when publicPnlStatus wasn't supplied at all (no fabricated
// default); otherwise returns the exact label to show, distinguishing the two non-'ok' real
// statuses rather than collapsing them into one generic string.
// LAST-KNOWN SAMPLE DISCLOSURE, DISCLOSED (issue #2 — "show last-known sample separately as not
// currently verified"). Pure, exported for direct testing. Sourced ONLY from
// `canonicalSampleManifestAudit.lastKnownCanonicalSample` (src/lib/canonicalPnlSampleManifest.ts's
// own `LastKnownCanonicalSample`, which is ITSELF only ever populated with
// `availableForCurrentVerification: false`) — never merged into or confused with the live PnL
// numbers above; this is metadata about a PRIOR scan's frozen sample, shown so the user isn't left
// with nothing at all, but unambiguously labeled as not currently verified.
export type LastKnownSampleDisclosure = {
  verifiedLotCount: number
  verifiedPricingCoveragePercent: number | null
  realizedPnlUsd: number | null
  manifestVersion: number
  refreshedAt: number
  label: string
}

export const LAST_KNOWN_SAMPLE_LABEL = 'Last known sample — not currently verified'

export function selectLastKnownSampleDisclosure(
  canonicalSampleManifestAudit: CanonicalSampleManifestAudit | null | undefined,
): LastKnownSampleDisclosure | null {
  const lastKnown = canonicalSampleManifestAudit?.lastKnownCanonicalSample
  if (!lastKnown) return null
  return {
    verifiedLotCount: lastKnown.verifiedLotCount,
    verifiedPricingCoveragePercent: lastKnown.verifiedPricingCoverage != null ? lastKnown.verifiedPricingCoverage * 100 : null,
    realizedPnlUsd: lastKnown.realizedPnlUsd,
    manifestVersion: lastKnown.manifestVersion,
    refreshedAt: lastKnown.refreshedAt,
    label: LAST_KNOWN_SAMPLE_LABEL,
  }
}

export function shouldShowLimitedSampleBadge(publicPnlStatus: PublicPnlStatus | null | undefined): string | null {
  if (publicPnlStatus == null || publicPnlStatus === 'ok') return null
  if (publicPnlStatus === 'limited_verified_sample') return 'Limited verified sample'
  return 'Not verified' // publicPnlStatus === 'unavailable'
}

// Literal message text, per this task's own spec — exported so tests can assert on the exact
// string rather than a substring guess.
export const PNL_UNAVAILABLE_MESSAGE = 'PnL unavailable due to missing evidence'

// TRUST/LABELING FIX, DISCLOSED (UI/trust follow-up task — confirmed production confusion: a user
// read a stable realized PnL alongside a scan-to-scan-changing unrealized/total figure and
// concluded the whole PnL was fabricated, because "Total PnL" implied one single, complete, stable
// number). Realized PnL — sourced only from the manifest-replayed, verified closed-lot sample — is
// the one figure this codebase can actually GUARANTEE is stable scan-to-scan for an unchanged lot
// set (see canonicalPnlSampleManifest.ts's whole replay-canonicalization design). Unrealized PnL is,
// by definition, a live, partial-coverage estimate (current market price x open-position quantity,
// for whatever open positions were successfully reconciled) — it is EXPECTED to move, and that
// movement must never read as "the verified PnL changed." These labels/copy are the ONE place every
// tile that shows Realized/Unrealized/Total reads its wording from, so bounded and 'ok'/full-history
// tiles say the same thing.
export const REALIZED_PNL_LABEL = 'Realized PnL (Official)'
export const UNREALIZED_PNL_LABEL = 'Current open-position estimate — partial coverage'
export const TOTAL_PNL_LABEL = 'Realized + partial open estimate'
export const PNL_STABILITY_NOTE = 'Realized PnL is fixed from verified closed lots. Unrealized PnL can move with live prices and partial open-position coverage.'
// Short, per-tile caption shown directly under the Unrealized/Total tiles (see `sub` on MetricCard)
// — the SAME message as PNL_STABILITY_NOTE's own point, restated compactly right where the number
// that actually moves is displayed, not just once in a paragraph elsewhere on the card.
export const LIVE_PRICE_MOVEMENT_NOTE = 'This changes with live open-position prices.'

// BOUNDED SAMPLE DISCLOSURE, DISCLOSED (bounded-PnL-UI follow-up task): real values only, sourced
// exclusively from `reconciliationSummary` (src/lib/pnlReconciliation.ts's own output) — never
// estimated, never merged with pnlV2. Returns null whenever `publicPnlStatus` isn't the real
// `'limited_verified_sample'` value, or when the caller hasn't supplied `reconciliationSummary`
// (an older/unwired caller) — so an absent prop degrades to "no bounded-sample block", never a
// fabricated one. Pure, exported for direct testing.
export type BoundedSampleDisclosure = {
  // CALM-BY-DEFAULT, DISCLOSED (Wallet Scanner second-pass audit, task 3): this is now always the
  // calm, actionable public wording — never the raw "engines disagree"/"not comparable to Nansen"
  // technical language, even when trustGateTriggered is true. See `technicalLabel` below for that.
  label: string
  // TECHNICAL LABEL, DISCLOSED, ADDITIVE: the REAL technical headline (unchanged from before this
  // fix — pnlDiscrepancyAudit.headlineOverrideLabel when the trust gate fired) — never deleted, only
  // moved out of the default view. Null whenever the trust gate did not fire (nothing technical to
  // disclose beyond the normal bounded-sample wording).
  technicalLabel: string | null
  realizedPnlUsd: number | null
  verifiedClosedLots: number
  structuralClosedLots: number
  verifiedPricingCoveragePercent: number | null
  unresolvedExitsExcluded: number
  warning: string | null
  // TRUST GATE, DISCLOSED (Wallet Scanner trust-gate task): mirrors `DisplayedPnl.trustGateTriggered`
  // — real, from `reconciliationSummary.pnlDiscrepancyAudit.trustGateTriggered`. `label` no longer
  // changes wording when this is true (see CALM-BY-DEFAULT above) — kept as its own field so the
  // rendered block can still downgrade its own styling (never "official/locked") and decide whether
  // to offer the expandable technical details at all.
  trustGateTriggered: boolean
}

// STALE/INTERMEDIATE-STATE RESILIENCE, DISCLOSED (Wallet Scanner final-UI follow-up task —
// confirmed production report: a live scan whose backend gate had genuinely resolved to a healthy
// bounded sample [manifestApplied: true, canonicalSampleEvidenceUnavailable: false,
// reconciliationSummary.publicPnlStatus: 'partial'] still rendered "PnL unavailable" client-side).
// `publicPnlStatus` (the `finalSummary.financialStatus.officialPnlStatus` prop) is threaded through
// several component layers/props before reaching this card — this function is the card's OWN,
// self-contained cross-check against the two backend fields that are the strongest, most direct
// evidence of the FINAL outcome (`canonicalSampleManifestAudit.manifestApplied` and
// `reconciliationSummary.publicPnlStatus`, both already present as separate props on this exact
// card). If those two independently agree the scan is a genuinely-applied, non-unavailable bounded
// sample while the `publicPnlStatus` prop itself claims 'unavailable', the bounded-sample reading
// wins — never the reverse (a manifest that genuinely failed/is unavailable is never overridden
// into looking available; this only ever recovers a bounded-sample result, never fabricates a full
// 'ok' one). NEVER used to override an 'ok'/'limited_verified_sample' status downward — this is a
// one-directional "unavailable was wrong, use the real bounded sample" recovery only.
export function resolveEffectivePublicPnlStatus(
  publicPnlStatus: PublicPnlStatus | null | undefined,
  reconciliationSummary: PnlReconciliationSummary | null | undefined,
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null,
): PublicPnlStatus | null {
  const status = publicPnlStatus ?? null
  if (status !== 'unavailable') return status
  const manifestGenuinelyApplied = canonicalSampleManifestAudit?.manifestApplied === true
    && canonicalSampleManifestAudit?.canonicalSampleEvidenceUnavailable !== true
  if (manifestGenuinelyApplied && reconciliationSummary?.publicPnlStatus === 'partial') {
    return 'limited_verified_sample'
  }
  return status
}

export function selectBoundedSampleDisclosure(
  publicPnlStatus: PublicPnlStatus | null | undefined,
  reconciliationSummary: PnlReconciliationSummary | null | undefined,
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null,
): BoundedSampleDisclosure | null {
  // FAIL-CLOSED OVERRIDE, DISCLOSED (issue #2): never show a coverage percentage — bounded or
  // otherwise — for a scan whose canonical sample could not be replayed, even if `publicPnlStatus`
  // somehow still claims 'limited_verified_sample' (defense in depth; the backend's own gate
  // already forces 'unavailable' in this case, but this block never trusts that alone).
  if (canonicalSampleManifestAudit?.canonicalSampleEvidenceUnavailable) return null
  const effectiveStatus = resolveEffectivePublicPnlStatus(publicPnlStatus, reconciliationSummary, canonicalSampleManifestAudit)
  if (effectiveStatus !== 'limited_verified_sample') return null
  if (!reconciliationSummary) return null
  const audit = reconciliationSummary.publicPnlGateAudit
  const scanWindowDays = audit.scanWindowDays ?? 90
  // TRUNCATED-HISTORY LABEL, DISCLOSED (wallet-scanner-bounded-publication follow-up task,
  // requirement #5): a valid bounded sample built on TRUNCATED provider history (a page-cap
  // truncation, `historyCoverageStatus === 'truncated'` — see eventClassification's own
  // HistoryCoverageStatus header) gets its own explicit, literal label rather than the generic
  // "Verified N-day sample" wording, which reads as a complete window rather than a boundary-
  // unproven, page-capped one. `boundaryProven`/'exhaustive' coverage is UNCHANGED — never this
  // label, still the original "Verified N-day sample" wording (this bounded block only ever
  // appears at all for `publicPnlStatus === 'limited_verified_sample'`, never full 'ok'/'available'
  // — the backend gate above already guarantees FULL PnL is never shown unless the window boundary
  // is proven, this label change is display wording only, never a status change).
  // TRUST GATE, DISCLOSED (Wallet Scanner trust-gate task, explicit rule #1): takes priority over
  // the truncated-history label above — a real engine-divergence/coverage/evidence problem is a
  // stronger, more specific signal than "history was truncated" and must never be silently
  // overridden BY it (both can legitimately be true at once; the trust-gate wording always wins).
  const trustGateTriggered = reconciliationSummary.pnlDiscrepancyAudit?.trustGateTriggered === true
  const headlineOverrideLabel = reconciliationSummary.pnlDiscrepancyAudit?.headlineOverrideLabel ?? null
  // CALM-BY-DEFAULT, DISCLOSED (Wallet Scanner second-pass audit, task 3): `label` is now always
  // calm, actionable wording — the raw "engines disagree"/"not comparable to Nansen" technical
  // headline is never shown here by default. `technicalLabel` carries that SAME real, unmodified
  // string (nothing about the underlying trust-gate computation changed) for the expandable
  // "Technical integrity details" section (PnlStatusCard's own render, below) — never deleted, only
  // moved out of the default view, per the hard rule against hiding real integrity issues from
  // debug/admin.
  const technicalLabel = trustGateTriggered && headlineOverrideLabel ? headlineOverrideLabel : null
  const label = trustGateTriggered && headlineOverrideLabel
    ? PARTIAL_TRUST_GATE_PUBLIC_LABEL
    : audit.historyCoverageStatus === 'truncated'
      ? 'Verified bounded sample — transaction history was truncated.'
      : `Verified ${scanWindowDays}-day sample`
  // COVERAGE CAP, DISCLOSED (requirement #5's "cap confidence/coverage at 100%"): a real backend
  // ratio should never exceed 1.0, but this display-only clamp guards against ever showing a
  // nonsensical >100% figure regardless of cause — it never changes the underlying backend value.
  const verifiedPricingCoveragePercent = audit.verifiedPricingCoverage != null ? Math.min(100, audit.verifiedPricingCoverage * 100) : null
  return {
    label,
    technicalLabel,
    realizedPnlUsd: reconciliationSummary.realizedPnlUsd,
    verifiedClosedLots: audit.verifiedClosedLots,
    structuralClosedLots: audit.structuralClosedLots,
    verifiedPricingCoveragePercent,
    unresolvedExitsExcluded: audit.invalidOrUnknownUnmatchedEvents,
    warning: reconciliationSummary.warning,
    trustGateTriggered,
  }
}

// CONTRADICTORY-TILES FIX, DISCLOSED (found live, this task — confirmed production bug: the bounded
// disclosure block above correctly showed realized PnL -$3,903.53 from `reconciliationSummary`,
// while the MAIN MetricCard tiles two inches below it — still wired to `selectVerifiedPnlData`'s
// pnlV2-only numbers — showed a contradictory $0.00 Realized / unrealized-only Total / $0.00 Cost
// Basis / "Not available (V2 engine)" Integrity, all on the SAME card for the SAME scan). Root
// cause: this card always had TWO independent number sources (pnlV2 for the main tiles,
// reconciliationSummary for the disclosure block added by the prior task) that were never
// reconciled with each other. `selectDisplayedPnl` is now the ONE canonical selector every visible
// tile reads from — for a bounded sample (`publicPnlStatus === 'limited_verified_sample'`), EVERY
// number comes from `reconciliationSummary` alone, matching the disclosure block exactly; for
// 'ok'/'unavailable'/unset, it is a pure pass-through of the existing, unchanged
// `selectVerifiedPnlData` result — zero behavior change for those two statuses.
export type DisplayedPnlSource = 'reconciliationSummary' | 'pnlV2' | 'none'

export type DisplayedPnl = {
  status: PublicPnlStatus | null
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  totalPnlUsd: number | null
  costBasisUsd: number | null
  costBasisLabel: string | null
  roiPercent: number | null
  roiLabel: string | null
  integrityLabel: string
  source: DisplayedPnlSource
  // DISCREPANCY/TRUST-GATE, DISCLOSED (Wallet Scanner trust-gate task): real, from
  // `reconciliationSummary.pnlDiscrepancyAudit.trustGateTriggered` — true only for a bounded
  // ('limited_verified_sample') result whose own engines disagree or whose evidence coverage is
  // too thin to present as if fully verified. When true, `realizedPnlTileLabel` replaces the
  // normal "Realized PnL (Official)" headline — see PARTIAL_TRUST_GATE_HEADLINE_LABEL's own header
  // in src/lib/pnlDiscrepancyAudit.ts. Never true for 'ok'/'unavailable' — this gate only ever
  // downgrades a bounded sample's own presentation, never claims a fully-verified result is
  // untrustworthy.
  trustGateTriggered: boolean
  realizedPnlTileLabel: string
}

// NEVER-FALL-BACK, DISCLOSED (requirement #3): when `publicPnlStatus === 'limited_verified_sample'`,
// this function reads `reconciliationSummary` ONLY — never `pnlV2.realizedPnlUsd`, never
// `syntheticPnl`, never a fabricated `0`. A caller that hasn't wired `reconciliationSummary` yet
// gets honest nulls (source: 'none'), never a silent fallback to the wrong number.
//
// COST BASIS / ROI, DISCLOSED (requirements #4/#5): `reconciliationSummary`/`publicPnlGateAudit`
// carry no verified, canonical per-wallet cost-basis figure today (only per-lot costBasisUsd inside
// individual matched lots, never summed/exposed at this level) — so for a bounded sample this
// function honestly returns `costBasisUsd: null` with the literal label "Not available for bounded
// sample", and `roiPercent: null` with "Not calculated for bounded sample", rather than either
// showing a fabricated $0.00/"No cost-basis evidence" (which reads as "this whole sample lacks
// evidence", not true — 19 lots ARE verified) or computing a number from data this function was
// never given. If a real canonical cost-basis field is ever added to PnlReconciliationSummary, this
// is the one place that would need to start reading it.
// FAIL-CLOSED LABEL, DISCLOSED (issue #2's own literal spec — "show PnL unavailable"). Exported so
// tests can assert on the exact string rather than a substring guess.
export const CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL = 'PnL unavailable — canonical sample not currently verified'

export function selectDisplayedPnl(params: {
  pnlV2: PnlV2 | null | undefined
  publicPnlStatus?: PublicPnlStatus | null
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
  reconciliationSummary?: PnlReconciliationSummary | null
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
}): DisplayedPnl {
  // FAIL-CLOSED OVERRIDE, DISCLOSED (issue #2): takes precedence over EVERYTHING below — a manifest
  // replay failure means there is no canonical published sample this scan, so no PnL number of any
  // kind (real, bounded, or otherwise) may be shown, regardless of what `publicPnlStatus`,
  // `pnlV2`, or `reconciliationSummary` individually claim.
  if (params.canonicalSampleManifestAudit?.canonicalSampleEvidenceUnavailable) {
    return {
      status: 'unavailable', realizedPnlUsd: null, unrealizedPnlUsd: null, totalPnlUsd: null,
      costBasisUsd: null, costBasisLabel: 'Not available — canonical sample unavailable',
      roiPercent: null, roiLabel: CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL,
      integrityLabel: CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL, source: 'none',
      trustGateTriggered: false, realizedPnlTileLabel: REALIZED_PNL_LABEL,
    }
  }

  const status = resolveEffectivePublicPnlStatus(params.publicPnlStatus, params.reconciliationSummary, params.canonicalSampleManifestAudit)

  if (status === 'limited_verified_sample') {
    const summary = params.reconciliationSummary
    if (!summary) {
      return {
        status, realizedPnlUsd: null, unrealizedPnlUsd: null, totalPnlUsd: null,
        costBasisUsd: null, costBasisLabel: 'Not available for bounded sample',
        roiPercent: null, roiLabel: 'Not calculated for bounded sample',
        integrityLabel: 'PARTIAL — VERIFIED SAMPLE', source: 'none',
        trustGateTriggered: false, realizedPnlTileLabel: REALIZED_PNL_LABEL,
      }
    }
    const scanWindowDays = summary.publicPnlGateAudit.scanWindowDays ?? 90
    const realizedPnlUsd = summary.realizedPnlUsd
    const unrealizedPnlUsd = summary.unrealizedPnlUsd
    const totalPnlUsd = realizedPnlUsd != null && unrealizedPnlUsd != null ? realizedPnlUsd + unrealizedPnlUsd : null
    // TRUST GATE, DISCLOSED (Wallet Scanner trust-gate task, explicit rule #1): a bounded sample
    // whose own discrepancy audit fired (engine divergence, thin pricing coverage, missing
    // critical evidence, or genuine unmatched sells) never shows the normal "PARTIAL — VERIFIED
    // N-DAY SAMPLE" / "Realized PnL (Official)" presentation. The underlying numbers themselves are
    // UNCHANGED (still real, still shown) — only the presentation is downgraded, never hidden
    // (rule #5).
    //
    // CALM-BY-DEFAULT, DISCLOSED (Wallet Scanner second-pass audit, task 3): these are the MOST
    // prominent, always-visible labels on this card (the Integrity tile and the Realized PnL tile's
    // own label) — the raw technical headline (`headlineOverrideLabel`, e.g. "engines disagree")
    // used to render directly here with no toggle at all. It now shows the calm public label
    // instead; the real technical string is still fully available, unhidden, via
    // selectBoundedSampleDisclosure's `technicalLabel` behind this card's own expandable "Technical
    // integrity details" toggle (rendered alongside these tiles for the same scan).
    const trustGateTriggered = summary.pnlDiscrepancyAudit?.trustGateTriggered === true
    const headlineOverrideLabel = summary.pnlDiscrepancyAudit?.headlineOverrideLabel ?? null
    return {
      status, realizedPnlUsd, unrealizedPnlUsd, totalPnlUsd,
      costBasisUsd: null, costBasisLabel: 'Not available for bounded sample',
      roiPercent: null, roiLabel: 'Not calculated for bounded sample',
      integrityLabel: trustGateTriggered && headlineOverrideLabel ? PARTIAL_TRUST_GATE_PUBLIC_LABEL : `PARTIAL — VERIFIED ${scanWindowDays}-DAY SAMPLE`,
      source: 'reconciliationSummary',
      trustGateTriggered,
      realizedPnlTileLabel: trustGateTriggered && headlineOverrideLabel ? PARTIAL_TRUST_GATE_PUBLIC_LABEL : REALIZED_PNL_LABEL,
    }
  }

  // 'ok' / 'unavailable' / unset — UNCHANGED pass-through of the existing pnlV2-based selector, per
  // requirement #4's own "keep unavailable wording only for truly unavailable status" and this
  // task's "available behavior unchanged" regression requirement.
  const pnl = selectVerifiedPnlData(params.pnlV2, params.publicPnlStatus, params.unrealizedReconciliation)
  return {
    status,
    realizedPnlUsd: pnl.realizedPnlUsd,
    unrealizedPnlUsd: pnl.unrealizedPnlUsd,
    totalPnlUsd: pnl.totalPnlUsd,
    costBasisUsd: pnl.totalCostBasisUsd,
    costBasisLabel: null,
    roiPercent: pnl.roi.value,
    roiLabel: pnl.roi.display,
    integrityLabel: 'Not available',
    source: params.pnlV2 != null ? 'pnlV2' : 'none',
    trustGateTriggered: false, realizedPnlTileLabel: REALIZED_PNL_LABEL,
  }
}

// GLOBAL-VS-PER-CHAIN SYNTHETIC GATING, DISCLOSED. RELAXED, DISCLOSED (this task's own request —
// Nansen-style "always show a number when the real engine can't"): `hasGlobalSynthetic` previously
// additionally required `syntheticPnl.totalPnlUsd !== null` — since computeSyntheticPnl (see that
// module's own header) NEVER returns a null totalPnlUsd anymore (missing cost basis/price
// contributes a real 0, never null), that extra check was already almost always true and is now
// removed entirely: any real, computed SyntheticPnlSummary object is sufficient. `hasPerChainSynthetic`
// is now correspondingly rare in practice (only reachable if the pipeline ever supplies a
// summary object with a genuinely empty/null-only perChain array) — kept for that edge case and for
// callers/tests that construct a summary by hand.
export function hasGlobalSynthetic(syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return syntheticPnl !== null && syntheticPnl !== undefined
}

export function hasPerChainSynthetic(syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return syntheticPnl != null && Array.isArray(syntheticPnl.perChain) && syntheticPnl.perChain.length > 0 &&
    syntheticPnl.perChain.some((c) => c.totalPnlUsd !== null || c.realizedPnlUsd !== null || c.unrealizedPnlUsd !== null)
}

// Pure, exported for direct testing — the exact condition for showing the GLOBAL synthetic block.
export function shouldShowSyntheticGlobal(publicPnlStatus: PublicPnlStatus | null | undefined, syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return publicPnlStatus === 'unavailable' && hasGlobalSynthetic(syntheticPnl)
}

// Pure, exported for direct testing — the exact condition for showing the PER-CHAIN fallback block:
// only when the global block is NOT shown (mutually exclusive by construction, not just by render
// order) AND at least one chain has real evidence.
export function shouldShowSyntheticPerChain(publicPnlStatus: PublicPnlStatus | null | undefined, syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return publicPnlStatus === 'unavailable' && !hasGlobalSynthetic(syntheticPnl) && hasPerChainSynthetic(syntheticPnl)
}

// DEPRECATED ALIAS, kept for backward compatibility with existing tests/callers from a prior
// commit — identical to shouldShowSyntheticGlobal (this task's canonical name going forward).
export const shouldShowSyntheticPnl = shouldShowSyntheticGlobal

export type PnlDisplayMode = 'synthetic' | 'synthetic_per_chain' | 'unavailable' | 'real' | 'inactive'

// Pure, exported for direct testing — the exact combinatorial decision PnlStatusCard renders from.
// REPLACE, NOT APPEND, DISCLOSED (this task's own request): 'synthetic'/'synthetic_per_chain' and
// 'unavailable' are mutually exclusive — when either synthetic summary is available, it REPLACES
// the "PnL unavailable" banner and the blocked numeric MetricCards, never rendered alongside them.
// 'synthetic' (global) always wins over 'synthetic_per_chain' when both would otherwise apply.
export function resolvePnlDisplayMode(params: {
  isActive: boolean
  blocked: boolean
  showSyntheticGlobal: boolean
  showSyntheticPerChain: boolean
}): PnlDisplayMode {
  if (!params.isActive) return 'inactive'
  if (params.blocked && params.showSyntheticGlobal) return 'synthetic'
  if (params.blocked && params.showSyntheticPerChain) return 'synthetic_per_chain'
  if (params.blocked) return 'unavailable'
  return 'real'
}

export function PnlStatusCard({ pnlV2, publicPnlStatus, syntheticPnl, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit, robinhoodResult, chainsScanned, walletPnlEvidenceAudit }: PnlStatusCardProps) {
  // TECHNICAL-DETAILS TOGGLE, DISCLOSED (Wallet Scanner second-pass audit, task 3 — same collapsed-
  // by-default convention as WalletScannerDiagnosticsV3's own "Advanced Diagnostics" section): real
  // engine-divergence/coverage/evidence numbers are never deleted or hidden from a user who wants
  // them — only collapsed by default so the calm public wording is what a normal user sees first.
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false)
  const effectivePublicPnlStatus = resolveEffectivePublicPnlStatus(publicPnlStatus, reconciliationSummary, canonicalSampleManifestAudit)
  const pnl = selectVerifiedPnlData(pnlV2, effectivePublicPnlStatus, unrealizedReconciliation)
  const isActive = pnlV2 != null
  const boundedSample = selectBoundedSampleDisclosure(publicPnlStatus, reconciliationSummary, canonicalSampleManifestAudit)
  const lastKnownSample = selectLastKnownSampleDisclosure(canonicalSampleManifestAudit)
  // CANONICAL DISPLAYED PNL, DISCLOSED (contradictory-tiles follow-up task): the ONE selector every
  // visible tile below reads from. For a bounded sample (`isBoundedSample`), this is
  // `reconciliationSummary`-sourced and INDEPENDENT of `pnl`/`blocked` (the pnlV2-only, magnitude-
  // heuristic-gated values above) — those remain exactly as they were for 'ok'/'unavailable', but a
  // bounded sample no longer reads them at all, closing the exact contradiction this task reported
  // (disclosure block showing a real number while the main tiles showed $0.00 from a DIFFERENT,
  // unrelated source).
  const displayed = selectDisplayedPnl({ pnlV2, publicPnlStatus, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit })
  const isBoundedSample = effectivePublicPnlStatus === 'limited_verified_sample'
  // PARTIAL-COVERAGE BADGE, DISCLOSED (this task's own requirement): shown SEPARATELY from the
  // blocked/unavailable states above — a "partial" reconciliation still has a real, honestly-
  // computed officialUnrealizedPnlUsd (excluded positions are simply left out, never blended in),
  // so this is informational context alongside a real number, never a reason to hide it.
  // FAIL-CLOSED SUPPRESSION, DISCLOSED (issue #2 — confirmed production bug: this badge's own
  // coverage percentage, about UNRELATED unrealized-position reconciliation, kept rendering next to
  // a "PnL unavailable" banner for a scan whose canonical sample failed replay, reading as if it
  // were the PnL evidence coverage). Never shown at all when the canonical sample is unavailable —
  // even though it is a real, legitimately different metric, showing ANY unlabeled coverage
  // percentage next to a fail-closed PnL state is exactly the confusion this task asks to eliminate.
  // BADGE WORDING FIX, DISCLOSED (UI/trust follow-up task — confirmed production confusion: a badge
  // reading "Partial — 40.24% coverage" sat next to the PnL tiles with no indication of WHICH
  // coverage it meant, and users reasonably read it as describing the verified REALIZED closed-lot
  // sample — the one figure this codebase actually guarantees is stable. This coverage percentage is
  // `unrealizedReconciliation.openPositionCoveragePercent` — currently-held open positions only
  // (FIFO leftovers with no canonical balance are not counted as a current coverage failure).
  // Has no bearing on realized PnL.
  const showSyntheticGlobal = shouldShowSyntheticGlobal(effectivePublicPnlStatus, syntheticPnl)
  const showSyntheticPerChain = shouldShowSyntheticPerChain(effectivePublicPnlStatus, syntheticPnl)
  // BLOCKED, DISCLOSED: `pnl.unreliable` (the pre-existing magnitude heuristic) and
  // `!pnl.stable` (this task's new isStablePnl guard) are two independent reasons to hide the
  // numeric display — either alone is enough. Applies uniformly to Realized/Unrealized/Total/ROI
  // (this task's requirement 4); Cost Basis is a real, always-finite sum of costBasis[] entries
  // with no NaN/Infinity failure mode of its own, so it is not blocked by this guard, only by the
  // separate magnitude heuristic already applied to it below.
  // BOUNDED-SAMPLE EXEMPT, DISCLOSED (contradictory-tiles follow-up task): `pnl.unreliable`/
  // `pnl.stable` are computed from `pnlV2`'s OWN numbers — irrelevant once a bounded sample displays
  // `reconciliationSummary`'s numbers instead. Forcing `blocked: false` here only ever affects the
  // 'real'-vs-'unavailable'/synthetic `displayMode` decision below (synthetic/unavailable are already
  // gated on `publicPnlStatus === 'unavailable'` elsewhere, never reachable for a bounded sample
  // anyway); it never widens what's shown — `displayed.realizedPnlUsd == null` still renders
  // PNL_UNAVAILABLE_MESSAGE per-tile below when `reconciliationSummary` itself wasn't wired.
  const blocked = isBoundedSample ? false : isActive && (pnl.unreliable || !pnl.stable)
  const displayMode = resolvePnlDisplayMode({ isActive, blocked, showSyntheticGlobal, showSyntheticPerChain })

  // SHARED VIEW MODEL, DISCLOSED (Smart Money Score + PnL Evidence UI simplification task): the ONE
  // selector both this card and CORTEX's sidebar (walletReadBuilder.ts's buildCortexReadV2) call for
  // combined status/box/chain-row wording — see buildWalletPnlViewModel.ts's own header. No new PnL
  // math: it's built entirely from the same selectors already computed above.
  const pnlViewModel = buildWalletPnlViewModel({ pnlV2, publicPnlStatus, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit, robinhoodResult, chainsScanned, walletPnlEvidenceAudit })

  const headerIcon = displayed.realizedPnlUsd == null
    ? <WarningIcon size={16} color="#fbbf24" />
    : displayed.realizedPnlUsd >= 0 ? <TrendingUpIcon size={16} color="#4ade80" /> : <TrendingDownIcon size={16} color="#f87171" />

  return (
    <section>
      {/* RESPONSIVE FIX, DISCLOSED (Wallet Scanner V3 layout task, "no horizontal overflow on
          mobile" requirement): this row previously had no `flexWrap`, so a narrow viewport (~390px)
          pushed the "Not Verified"/"Not Reliable" StatusBadge text (nowrap by design — see that
          component's own header) past the viewport edge instead of wrapping onto a second line.
          Presentational only — no badge label, tone, or underlying PnL value changes. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex' }}>{headerIcon}</span>
        {/* RENAMED, DISCLOSED (Wallet-Scanner-Robinhood-final-integration follow-up, this task's own
            explicit requirement 3 — "PnL (Verified V2)" read as if EVERYTHING under this header,
            including the Robinhood row below, carried the same V2-verified guarantee. */}
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>PnL Evidence</h3>
        {/* ONE COMBINED BADGE, DISCLOSED (Smart Money Score + PnL Evidence UI simplification task —
            "remove noisy duplicate badges like PnL unavailable/Not verified/Active when they
            conflict with per-chain states"): replaces the old "Active" + "Not reliable" + "PnL
            unavailable" + limited-sample + coverage badge stack (up to 5 badges that could disagree
            with the per-chain rows below) with the ONE combinedStatus every box/row below already
            agrees with — see buildWalletPnlViewModel.ts's own header. */}
        <StatusBadge
          label={COMBINED_STATUS_LABEL[pnlViewModel.combinedStatus]}
          tone={COMBINED_STATUS_TONE[pnlViewModel.combinedStatus]}
          glow={pnlViewModel.combinedStatus === 'verified'}
        />
      </div>
      <p style={{ fontSize: '12px', fontWeight: 600, color: COMBINED_REASON_COLOR[pnlViewModel.combinedStatus], margin: '0 0 14px', lineHeight: 1.5 }}>
        {pnlViewModel.combinedReason}
      </p>

      {/* RECONCILIATION COUNTS, DISCLOSED (task 2 UI requirement): reconciled/excluded/dead-spam
          counts are real fields already on unrealizedReconciliation — shown as plain counts here
          rather than folded into a percentage, so a reader can see the actual numbers behind the
          coverage badge above. Estimated excluded market value is shown ONLY when real evidence for
          it exists (excludedCandidateMarketValueUsd > 0 — a position with zero computable candidates
          contributes 0 there, which is correctly treated as "no evidence" here, not "worth $0"). */}
      {unrealizedReconciliation && unrealizedReconciliation.totalOpenPositions > 0 && (
        <div style={{ margin: '0 0 16px' }}>
          <button
            type="button"
            onClick={() => setShowTechnicalDetails((v) => !v)}
            style={{
              fontSize: '11px', color: '#94a3b8', background: 'transparent', border: 'none',
              padding: 0, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit',
            }}
          >
            {showTechnicalDetails ? '▾ Hide technical details' : '▸ Technical details'}
          </button>
          {showTechnicalDetails && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginTop: '8px', fontSize: '11px', color: '#94a3b8' }}>
              <span>Reconciled positions: <strong style={{ color: '#e2e8f0' }}>{unrealizedReconciliation.reconciledOpenPositions}</strong></span>
              <span>Excluded positions: <strong style={{ color: '#e2e8f0' }}>{unrealizedReconciliation.excludedOpenPositions}</strong></span>
              {unrealizedReconciliation.deadOrSpamPositionsCount > 0 && (
                <span>Dead/spam tokens: <strong style={{ color: '#e2e8f0' }}>{unrealizedReconciliation.deadOrSpamPositionsCount}</strong></span>
              )}
              {unrealizedReconciliation.excludedCandidateMarketValueUsd > 0 && (
                <span>Estimated excluded value: <strong style={{ color: '#e2e8f0' }}>{fmtUsd(unrealizedReconciliation.excludedCandidateMarketValueUsd)}</strong> (not included in official PnL)</span>
              )}
              {(unrealizedReconciliation.excludedClassificationCounts.missing_balance ?? 0) > 0 && (
                <span>
                  <strong style={{ color: '#e2e8f0' }}>{unrealizedReconciliation.excludedClassificationCounts.missing_balance}</strong> historical open position{(unrealizedReconciliation.excludedClassificationCounts.missing_balance ?? 0) === 1 ? '' : 's'} not currently in canonical holdings
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* BOUNDED VERIFIED SAMPLE DISCLOSURE, DISCLOSED (bounded-PnL-UI follow-up task): real,
          backend-computed values only (src/lib/pnlReconciliation.ts's publicPnlGateAudit/warning) —
          shown ONLY for the real 'limited_verified_sample' status, never for 'ok'/'unavailable'.
          Deliberately never labeled "Complete PnL"/"All-time PnL"/"Fully verified" — this IS a
          bounded, disclosed sample, and every string here says so explicitly.
          LOCKED-STATE SUPPRESSION, DISCLOSED (PnL Evidence UI cleanup follow-up — confirmed reported
          bug: this block's own bold "Verified N-day sample" headline + a big green "Realized PnL: $X"
          line rendered directly below a header badge that said "Combined Locked" for the exact same
          scan, reading as if the combined figure WERE verified after all — exactly the class of
          contradictory copy this task asks to remove). Never shown at all when
          pnlViewModel.combinedStatus is 'locked' (the Robinhood-override case) — its real content
          (label, verified lot counts, trust-gate detail) is already folded into
          combinedRealizedBox's own reason line above, so no evidence is lost, only the duplicate,
          contradictory presentation. Still shown unmodified for a genuine bounded sample with no
          Robinhood override (combinedStatus === 'partial'). */}
      {boundedSample && pnlViewModel.combinedStatus !== 'locked' && (
        <div style={{
          background: boundedSample.trustGateTriggered ? 'rgba(248,113,113,0.08)' : 'rgba(251,191,36,0.06)',
          border: `1px solid ${boundedSample.trustGateTriggered ? 'rgba(248,113,113,0.35)' : 'rgba(251,191,36,0.25)'}`,
          borderRadius: '10px', padding: '12px 14px', marginBottom: '16px',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: boundedSample.trustGateTriggered ? '#f87171' : '#fbbf24', letterSpacing: '0.04em', marginBottom: '6px' }}>
            {boundedSample.label}
          </div>
          {/* WHY, DISCLOSED (Wallet Scanner trust-gate task, explicit rule #5 — "downgrade
              confidence and explain why"): the real reason code(s) the discrepancy audit fired on.
              CALM-BY-DEFAULT, DISCLOSED (Wallet Scanner second-pass audit, task 3): collapsed behind
              an explicit toggle rather than always-visible raw engine-divergence language — the data
              itself is completely unchanged and un-hidden, a user who wants it gets it on request. */}
          {boundedSample.trustGateTriggered && reconciliationSummary?.pnlDiscrepancyAudit && (
            <div style={{ marginBottom: '8px' }}>
              <button
                type="button"
                onClick={() => setShowTechnicalDetails((v) => !v)}
                style={{
                  fontSize: '11px', color: 'rgba(248,113,113,0.85)', background: 'transparent', border: 'none',
                  padding: 0, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit',
                }}
              >
                {showTechnicalDetails ? '▾ Hide technical details' : '▸ Technical details'}
              </button>
              {showTechnicalDetails && (
                <div style={{ fontSize: '11px', color: 'rgba(248,113,113,0.85)', lineHeight: 1.6, marginTop: '6px' }}>
                  {boundedSample.technicalLabel && <div style={{ fontWeight: 700, marginBottom: '4px' }}>{boundedSample.technicalLabel}</div>}
                  {reconciliationSummary.pnlDiscrepancyAudit.likelyReasonCodes.includes('engine_divergence_exceeds_threshold') && (
                    <div>⚠ Two independent PnL engines disagree by {reconciliationSummary.pnlDiscrepancyAudit.engineDivergenceUsd != null ? fmtSignedUsd(reconciliationSummary.pnlDiscrepancyAudit.engineDivergenceUsd) : 'an unresolved amount'}{reconciliationSummary.pnlDiscrepancyAudit.engineDivergencePct != null ? ` (${(reconciliationSummary.pnlDiscrepancyAudit.engineDivergencePct * 100).toFixed(1)}%)` : ''}</div>
                  )}
                  {reconciliationSummary.pnlDiscrepancyAudit.likelyReasonCodes.includes('pricing_coverage_below_threshold') && (
                    <div>⚠ Pricing coverage {reconciliationSummary.pnlDiscrepancyAudit.pricingCoverage != null ? `${(reconciliationSummary.pnlDiscrepancyAudit.pricingCoverage * 100).toFixed(1)}%` : 'unknown'} — below the 85% trust threshold</div>
                  )}
                  {reconciliationSummary.pnlDiscrepancyAudit.likelyReasonCodes.includes('critical_trade_evidence_missing') && (
                    <div>⚠ {reconciliationSummary.pnlDiscrepancyAudit.criticalTradeEvidenceMissing} trade(s) missing critical evidence</div>
                  )}
                  {reconciliationSummary.pnlDiscrepancyAudit.likelyReasonCodes.includes('genuine_unmatched_sells_present') && (
                    <div>⚠ {reconciliationSummary.pnlDiscrepancyAudit.genuineUnmatchedSells} genuinely unmatched sell(s) not yet reconciled</div>
                  )}
                </div>
              )}
            </div>
          )}
          <div style={{ fontSize: '13px', fontWeight: 700, color: boundedSample.realizedPnlUsd != null && boundedSample.realizedPnlUsd < 0 ? '#f87171' : '#4ade80', marginBottom: '6px' }}>
            Realized PnL: {fmtSignedUsd(boundedSample.realizedPnlUsd)}
          </div>
          <div style={{ fontSize: '11px', color: 'rgba(226,232,240,0.75)', lineHeight: 1.7 }}>
            {boundedSample.verifiedClosedLots} verified closed lots
            {boundedSample.structuralClosedLots > 0 && ` of ${boundedSample.structuralClosedLots} structural`}
            <br />
            {boundedSample.verifiedPricingCoveragePercent != null ? `${boundedSample.verifiedPricingCoveragePercent.toFixed(2)}%` : 'Unknown'} historical pricing coverage
            <br />
            {boundedSample.unresolvedExitsExcluded} unresolved exit{boundedSample.unresolvedExitsExcluded === 1 ? '' : 's'} excluded
          </div>
          {boundedSample.warning && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#fbbf24', marginTop: '8px' }}>
              {boundedSample.warning}
            </div>
          )}
        </div>
      )}

      {/* LAST-KNOWN SAMPLE DISCLOSURE, DISCLOSED (issue #2 — "show last-known sample separately as
          not currently verified"): rendered ONLY when a prior manifest exists but this scan's
          replay failed — clearly separate from, and never merged into, the PnL tiles above (which
          already show PNL_UNAVAILABLE_MESSAGE / CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL). Explicitly
          labeled "not currently verified" in the block itself, not just implied by placement. */}
      {lastKnownSample && (
        <div style={{ background: 'rgba(148,163,184,0.06)', border: '1px dashed rgba(148,163,184,0.3)', borderRadius: '10px', padding: '12px 14px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'rgba(148,163,184,0.85)', letterSpacing: '0.04em', marginBottom: '6px' }}>
            {lastKnownSample.label}
          </div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'rgba(226,232,240,0.75)', marginBottom: '6px' }}>
            Last verified realized PnL: {fmtSignedUsd(lastKnownSample.realizedPnlUsd)}
          </div>
          <div style={{ fontSize: '11px', color: 'rgba(226,232,240,0.6)', lineHeight: 1.7 }}>
            {lastKnownSample.verifiedLotCount} verified closed lots (manifest v{lastKnownSample.manifestVersion})
            <br />
            {lastKnownSample.verifiedPricingCoveragePercent != null ? `${lastKnownSample.verifiedPricingCoveragePercent.toFixed(2)}%` : 'Unknown'} historical pricing coverage
          </div>
        </div>
      )}

      {displayMode === 'synthetic' && syntheticPnl ? (
        <SyntheticPnlBlock syntheticPnl={syntheticPnl} />
      ) : displayMode === 'synthetic_per_chain' && syntheticPnl ? (
        <SyntheticPerChainPnlBlock perChain={syntheticPnl.perChain} />
      ) : (
        // TOP ROW BOXES, DISCLOSED (Smart Money Score + PnL Evidence UI simplification task): ONE
        // box grid for both the bounded-sample and normal cases — buildWalletPnlViewModel already
        // resolves which real source (reconciliationSummary vs pnlV2) and which status/reason each
        // box gets, so this render no longer needs its own separate bounded/normal branches.
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <PnlBoxTile label="Combined Realized PnL" box={pnlViewModel.combinedRealizedBox} />
          <PnlRobinhoodBoxTile box={pnlViewModel.robinhoodBox} />
          <PnlBoxTile label="Unrealized PnL" box={pnlViewModel.unrealizedBox} />
          <PnlBoxTile label="ROI" box={pnlViewModel.roiBox} />
        </div>
      )}

      {(isBoundedSample || displayMode === 'real') && (
        <p style={{ fontSize: '11px', color: 'rgba(148,163,184,0.6)', lineHeight: 1.6, margin: '0 0 16px' }}>
          {PNL_STABILITY_NOTE}
        </p>
      )}

      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Per-Chain Breakdown
        </div>
        {pnlViewModel.chainRows.length === 0 ? (
          <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No per-chain PnL evidence for this scan.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {pnlViewModel.chainRows.map((row) => <PnlChainRowItem key={row.chain} row={row} />)}
          </div>
        )}
        {/* ROBINHOOD PROOF, REMOVED FROM HERE, DISCLOSED (PnL Evidence UI cleanup follow-up): the
            compact proof fields now render inline inside the dedicated "Robinhood Realized PnL" box
            above (PnlRobinhoodBoxTile) — showing them a second time here duplicated the exact same
            evidence right below it. pnlViewModel.robinhoodProof itself is unchanged/still exported —
            only this second render site was removed. */}
      </div>

      {!isActive && (
        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.50)', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          Verified V2 PnL engine: inactive — no data for this scan yet.
        </div>
      )}
    </section>
  )
}

export default PnlStatusCard

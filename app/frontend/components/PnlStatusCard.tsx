'use client'

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
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import type { PublicPnlStatus, UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'
import type { SyntheticPnlSummary } from '@/src/modules/syntheticPnl/types'
import type { PnlReconciliationSummary } from '@/src/lib/pnlReconciliation'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'
import { fmtSignedUsd, fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { StatusBadge } from './StatusBadge'
import { MetricCard, toneFromNumber } from './MetricCard'
import { TrendingDownIcon, TrendingUpIcon, WarningIcon } from './Icons'
import { SyntheticPnlBlock } from './SyntheticPnlBlock'
import { SyntheticPerChainPnlBlock } from './SyntheticPerChainPnlBlock'

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

function ChainBreakdownTable({
  chainBreakdown,
  unreliable,
  hasCanonicalUnrealizedSource,
}: {
  chainBreakdown: PnlV2['chainBreakdown']
  unreliable: boolean
  hasCanonicalUnrealizedSource: boolean
}) {
  if (chainBreakdown.length === 0) {
    return <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No per-chain PnL breakdown from the verified V2 engine.</p>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'rgba(148,163,184,0.55)', fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            <th style={{ padding: '6px 10px' }}>Chain ID</th>
            <th style={{ padding: '6px 10px' }}>Realized PnL</th>
            <th style={{ padding: '6px 10px' }}>Unrealized PnL</th>
          </tr>
        </thead>
        <tbody>
          {chainBreakdown.map((c) => {
            // Same GUARDRAIL_ABS_LIMIT clamp applied per-chain-row, per task requirement — the
            // per-chain breakdown must not leak an absurd number even if the aggregate is clamped.
            // Only applied to realizedPnlUsd now (still a real, pnlV2-sourced figure) — the legacy
            // unrealized figure is suppressed unconditionally below, never rendered as official.
            const rowUnreliable = unreliable && Math.abs(c.realizedPnlUsd) > GUARDRAIL_ABS_LIMIT
            return (
              <tr key={c.chainId} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{c.chainId}</td>
                {rowUnreliable ? (
                  <td colSpan={2} style={{ padding: '9px 10px', fontWeight: 700, color: '#fbbf24' }}>Not reliable — sample too incomplete</td>
                ) : (
                  <>
                    <td style={{ padding: '9px 10px', fontWeight: 700, color: c.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(c.realizedPnlUsd)}</td>
                    <td style={{ padding: '9px 10px', color: 'rgba(148,163,184,0.55)', fontStyle: 'italic' }}>
                      {hasCanonicalUnrealizedSource ? 'See reconciled total above' : fmtSignedUsd(c.unrealizedPnlUsd)}
                    </td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

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

// BOUNDED SAMPLE DISCLOSURE, DISCLOSED (bounded-PnL-UI follow-up task): real values only, sourced
// exclusively from `reconciliationSummary` (src/lib/pnlReconciliation.ts's own output) — never
// estimated, never merged with pnlV2. Returns null whenever `publicPnlStatus` isn't the real
// `'limited_verified_sample'` value, or when the caller hasn't supplied `reconciliationSummary`
// (an older/unwired caller) — so an absent prop degrades to "no bounded-sample block", never a
// fabricated one. Pure, exported for direct testing.
export type BoundedSampleDisclosure = {
  label: string
  realizedPnlUsd: number | null
  verifiedClosedLots: number
  structuralClosedLots: number
  verifiedPricingCoveragePercent: number | null
  unresolvedExitsExcluded: number
  warning: string | null
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
  if (publicPnlStatus !== 'limited_verified_sample') return null
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
  const label = audit.historyCoverageStatus === 'truncated'
    ? 'Verified bounded sample — transaction history was truncated.'
    : `Verified ${scanWindowDays}-day sample`
  // COVERAGE CAP, DISCLOSED (requirement #5's "cap confidence/coverage at 100%"): a real backend
  // ratio should never exceed 1.0, but this display-only clamp guards against ever showing a
  // nonsensical >100% figure regardless of cause — it never changes the underlying backend value.
  const verifiedPricingCoveragePercent = audit.verifiedPricingCoverage != null ? Math.min(100, audit.verifiedPricingCoverage * 100) : null
  return {
    label,
    realizedPnlUsd: reconciliationSummary.realizedPnlUsd,
    verifiedClosedLots: audit.verifiedClosedLots,
    structuralClosedLots: audit.structuralClosedLots,
    verifiedPricingCoveragePercent,
    unresolvedExitsExcluded: audit.invalidOrUnknownUnmatchedEvents,
    warning: reconciliationSummary.warning,
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
    }
  }

  const status = params.publicPnlStatus ?? null

  if (status === 'limited_verified_sample') {
    const summary = params.reconciliationSummary
    if (!summary) {
      return {
        status, realizedPnlUsd: null, unrealizedPnlUsd: null, totalPnlUsd: null,
        costBasisUsd: null, costBasisLabel: 'Not available for bounded sample',
        roiPercent: null, roiLabel: 'Not calculated for bounded sample',
        integrityLabel: 'PARTIAL — VERIFIED SAMPLE', source: 'none',
      }
    }
    const scanWindowDays = summary.publicPnlGateAudit.scanWindowDays ?? 90
    const realizedPnlUsd = summary.realizedPnlUsd
    const unrealizedPnlUsd = summary.unrealizedPnlUsd
    const totalPnlUsd = realizedPnlUsd != null && unrealizedPnlUsd != null ? realizedPnlUsd + unrealizedPnlUsd : null
    return {
      status, realizedPnlUsd, unrealizedPnlUsd, totalPnlUsd,
      costBasisUsd: null, costBasisLabel: 'Not available for bounded sample',
      roiPercent: null, roiLabel: 'Not calculated for bounded sample',
      integrityLabel: `PARTIAL — VERIFIED ${scanWindowDays}-DAY SAMPLE`, source: 'reconciliationSummary',
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
    integrityLabel: 'Not available (V2 engine)',
    source: params.pnlV2 != null ? 'pnlV2' : 'none',
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

export function PnlStatusCard({ pnlV2, publicPnlStatus, syntheticPnl, unrealizedReconciliation, reconciliationSummary, canonicalSampleManifestAudit }: PnlStatusCardProps) {
  const pnl = selectVerifiedPnlData(pnlV2, publicPnlStatus, unrealizedReconciliation)
  const isActive = pnlV2 != null
  const canonicalSampleUnavailable = canonicalSampleManifestAudit?.canonicalSampleEvidenceUnavailable === true
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
  const isBoundedSample = publicPnlStatus === 'limited_verified_sample'
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
  const unrealizedCoverageBadgeLabel = canonicalSampleUnavailable
    ? null
    : unrealizedReconciliation?.reconciliationStatus === 'partial'
      ? `Partial — ${unrealizedReconciliation.unrealizedCoveragePercent.toFixed(2)}% coverage`
      : null
  const limitedSampleBadgeLabel = shouldShowLimitedSampleBadge(publicPnlStatus)
  const showSyntheticGlobal = shouldShowSyntheticGlobal(publicPnlStatus, syntheticPnl)
  const showSyntheticPerChain = shouldShowSyntheticPerChain(publicPnlStatus, syntheticPnl)
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
  const showUnavailableBanner = displayMode === 'unavailable'

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex' }}>{headerIcon}</span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>PnL (Verified V2)</h3>
        <StatusBadge label={isActive ? 'Active' : 'Unavailable'} tone={isActive ? 'success' : 'neutral'} glow={isActive} />
        {/* BOUNDED-SAMPLE EXEMPT, DISCLOSED: these two badges are computed from `pnl` (pnlV2's own
            magnitude/stability heuristics) — irrelevant once a bounded sample displays
            `reconciliationSummary`'s numbers instead (see `displayed`/`isBoundedSample` above).
            Suppressed here so the header never contradicts the real, canonical tiles below. */}
        {!isBoundedSample && pnl.unreliable && <StatusBadge label="Not reliable (magnitude)" tone="warning" glow />}
        {!isBoundedSample && !pnl.stable && isActive && <StatusBadge label="PnL unavailable" tone="warning" glow />}
        {/* REAL backend classification (fifoEngine's publicPnlStatus, via
            finalSummary.financialStatus.officialPnlStatus) — a SEPARATE signal from the UI-only
            magnitude clamp above; shown whenever it isn't 'ok', regardless of magnitude. */}
        {limitedSampleBadgeLabel && <StatusBadge label={limitedSampleBadgeLabel} tone="warning" />}
        {unrealizedCoverageBadgeLabel && <StatusBadge label={unrealizedCoverageBadgeLabel} tone="warning" />}
      </div>

      {showUnavailableBanner && (
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#fbbf24', margin: '0 0 12px' }}>
          {PNL_UNAVAILABLE_MESSAGE}
        </p>
      )}

      {/* BOUNDED VERIFIED SAMPLE DISCLOSURE, DISCLOSED (bounded-PnL-UI follow-up task): real,
          backend-computed values only (src/lib/pnlReconciliation.ts's publicPnlGateAudit/warning) —
          shown ONLY for the real 'limited_verified_sample' status, never for 'ok'/'unavailable'.
          Deliberately never labeled "Complete PnL"/"All-time PnL"/"Fully verified" — this IS a
          bounded, disclosed sample, and every string here says so explicitly. */}
      {boundedSample && (
        <div style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: '10px', padding: '12px 14px', marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#fbbf24', letterSpacing: '0.04em', marginBottom: '6px' }}>
            {boundedSample.label}
          </div>
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
      ) : isBoundedSample ? (
        // BOUNDED-SAMPLE TILES, DISCLOSED (contradictory-tiles follow-up task): every value here is
        // `displayed.*` — the SAME `reconciliationSummary`-sourced numbers the disclosure block above
        // shows, never `pnl.*` (pnlV2). `displayed.realizedPnlUsd == null` here means the caller
        // hasn't wired `reconciliationSummary` at all — shown as PNL_UNAVAILABLE_MESSAGE, never a
        // fabricated $0.00.
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <MetricCard label={REALIZED_PNL_LABEL} value={displayed.realizedPnlUsd == null ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(displayed.realizedPnlUsd)} tone={toneFromNumber(displayed.realizedPnlUsd)} index={0} />
          <MetricCard label={UNREALIZED_PNL_LABEL} value={displayed.unrealizedPnlUsd == null ? 'Unavailable' : fmtSignedUsd(displayed.unrealizedPnlUsd)} tone={toneFromNumber(displayed.unrealizedPnlUsd)} index={1} />
          <MetricCard label={TOTAL_PNL_LABEL} value={displayed.totalPnlUsd == null ? 'Unavailable' : fmtSignedUsd(displayed.totalPnlUsd)} tone={toneFromNumber(displayed.totalPnlUsd)} index={2} />
          <MetricCard label="ROI" value={displayed.roiLabel ?? 'Not calculated for bounded sample'} tone="neutral" index={3} />
          <MetricCard label="Cost Basis" value={displayed.costBasisLabel ?? 'Not available for bounded sample'} index={4} />
          <MetricCard label="Integrity" value={<StatusBadge label={displayed.integrityLabel} tone="warning" />} index={5} />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <MetricCard label={REALIZED_PNL_LABEL} value={blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.realizedPnlUsd)} tone={blocked ? 'neutral' : toneFromNumber(pnl.realizedPnlUsd)} index={0} />
          <MetricCard
            label={UNREALIZED_PNL_LABEL}
            value={pnl.unrealizedPnlUsd == null ? 'Unavailable' : blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.unrealizedPnlUsd)}
            tone={pnl.unrealizedPnlUsd == null || blocked ? 'neutral' : toneFromNumber(pnl.unrealizedPnlUsd)}
            index={1}
          />
          <MetricCard label={TOTAL_PNL_LABEL} value={blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.totalPnlUsd)} tone={blocked ? 'neutral' : toneFromNumber(pnl.totalPnlUsd)} index={2} />
          <MetricCard label="ROI" value={blocked ? PNL_UNAVAILABLE_MESSAGE : pnl.roi.display} tone={blocked ? 'neutral' : toneFromNumber(pnl.roi.value)} index={3} />
          <MetricCard label="Cost Basis" value={pnl.unreliable ? 'Not reliable' : fmtUsd(pnl.totalCostBasisUsd)} index={4} />
          <MetricCard label="Integrity" value={<StatusBadge label="Not available (V2 engine)" tone="neutral" />} index={5} />
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
        {canonicalSampleUnavailable ? (
          // FAIL-CLOSED, DISCLOSED (issue #2/#3 — "no $0 per-chain PnL"): never render pnlV2's own
          // per-chain figures when the canonical sample is unavailable, regardless of
          // `isBoundedSample` (which reads the raw `publicPnlStatus` prop and can disagree with the
          // manifest audit) — pnlV2 is a completely separate engine with no awareness of manifest
          // replay state, so its own numbers must never fill this gap with an unrelated $0.00 table.
          <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>{CANONICAL_SAMPLE_UNAVAILABLE_PNL_LABEL}</p>
        ) : isBoundedSample ? (
          <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>{PER_CHAIN_BOUNDED_SAMPLE_MESSAGE}</p>
        ) : (
          // hasCanonicalUnrealizedSource: `!== undefined`, NOT `!= null` — a caller that explicitly
          // passes `null` (a real "checked, found nothing trustworthy" result) must still suppress
          // the legacy per-chain figure; only a prop that was never supplied at all (a caller not
          // yet migrated to this fix) falls back to it.
          <ChainBreakdownTable chainBreakdown={pnlV2?.chainBreakdown ?? []} unreliable={pnl.unreliable || blocked} hasCanonicalUnrealizedSource={unrealizedReconciliation !== undefined} />
        )}
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

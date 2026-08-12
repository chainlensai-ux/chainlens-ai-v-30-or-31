// Base Radar holder-evidence clarity, DISCLOSED (reported directly off the live drawer: "Holders:
// 100+ / Status: Not confirmed / Concentration unavailable" alongside copy that said "Holder count
// verified" — self-contradictory, since a minimum count ("at least 100") is not the same evidence
// as an exact, fully verified count, and neither implies anything about top-holder concentration.
// This module makes that distinction structural instead of implicit: a real minimum count can still
// pass the feed's holder gate (>=30), but it is never presented as "verified", and concentration
// (Top 1/10/20) is only ever populated from real resolved top-holder balances — never inferred from
// a bare count, minimum or exact.

export type HolderCountStatus = 'exact' | 'minimum' | 'unavailable'
export type ConcentrationStatus = 'resolved' | 'unavailable'

export const HOLDER_GATE_MIN_COUNT = 30

export interface HolderEvidenceInput {
  // A real holder count from a provider. `countIsMinimum` says whether that count is a proven exact
  // total (e.g. has_more:false from GoldRush/Covalent) or a page-bound minimum (e.g. "100+", where
  // has_more:true or the page-size-equality heuristic applies) — see lib/server/goldrushHolderCount.ts
  // for how this is determined upstream. `holderCount: null` means no provider returned any count.
  holderCount: number | null
  countIsMinimum: boolean
  // Real top1/10/20 percentages computed from actually-resolved holder balances (never estimated
  // from the count alone). Pass null for any that weren't resolved.
  top1Percent?: number | null
  top10Percent?: number | null
  top20Percent?: number | null
  // Whether a provider call for holder balances actually completed (even if it returned zero useful
  // rows) — distinguishes "the provider was reachable but had nothing" from "the provider could not
  // be reached at all" (timeout, no API key, rate limited, HTTP error) for the evidence-gap code.
  holderProviderReachable: boolean
  // Which provider actually produced the resolved top1/10/20 (e.g. 'goldrush'). Only meaningful when
  // concentration resolves; left null/omitted otherwise. Purely descriptive — never affects the
  // computed evidence itself.
  concentrationProvider?: string | null
}

export interface HolderEvidence {
  holderCountStatus: HolderCountStatus
  holderCountExact?: number
  holderCountMinimum?: number
  holderCountDisplay: string
  holderGatePassed: boolean
  holderVerified: boolean
  concentrationStatus: ConcentrationStatus
  concentrationProvider?: string | null
  topHolderBalancesResolved: boolean
  top1Percent?: number
  top10Percent?: number
  top20Percent?: number
  evidenceGaps: string[]
}

export function buildBaseRadarHolderEvidence(input: HolderEvidenceInput): HolderEvidence {
  const evidenceGaps: string[] = []
  let holderCountStatus: HolderCountStatus
  let holderCountDisplay: string
  let holderGatePassed = false
  let holderVerified = false
  let holderCountExact: number | undefined
  let holderCountMinimum: number | undefined

  const count = typeof input.holderCount === 'number' && Number.isFinite(input.holderCount) ? input.holderCount : null

  if (count == null) {
    holderCountStatus = 'unavailable'
    holderCountDisplay = 'Open Check'
    evidenceGaps.push(input.holderProviderReachable ? 'holder_count_unavailable' : 'holder_provider_unreachable')
  } else if (input.countIsMinimum) {
    holderCountStatus = 'minimum'
    holderCountMinimum = count
    holderCountDisplay = `${count}+`
    holderGatePassed = count >= HOLDER_GATE_MIN_COUNT
    // Rule: a minimum count is real evidence — it can pass the feed's holder gate — but it is never
    // "verified", since the exact total is genuinely unknown, not just unresolved by a bug.
    holderVerified = false
    evidenceGaps.push('exact_holder_count_unconfirmed')
  } else {
    holderCountStatus = 'exact'
    holderCountExact = count
    holderCountDisplay = String(count)
    holderGatePassed = count >= HOLDER_GATE_MIN_COUNT
    holderVerified = true
  }

  // Concentration only ever comes from real resolved top-holder balances — never derived from
  // holderCount/holderCountMinimum, exact or otherwise. A token can have a confirmed minimum count
  // of "100+" and simultaneously have zero concentration evidence; the two are unrelated facts.
  const hasRealTop = [input.top1Percent, input.top10Percent, input.top20Percent].some(
    (v) => typeof v === 'number' && Number.isFinite(v),
  )
  const concentrationStatus: ConcentrationStatus = hasRealTop ? 'resolved' : 'unavailable'
  if (concentrationStatus === 'unavailable') {
    evidenceGaps.push('holder_concentration_unavailable')
  }

  return {
    holderCountStatus,
    holderCountExact,
    holderCountMinimum,
    holderCountDisplay,
    holderGatePassed,
    holderVerified,
    concentrationStatus,
    concentrationProvider: concentrationStatus === 'resolved' ? (input.concentrationProvider ?? null) : null,
    topHolderBalancesResolved: concentrationStatus === 'resolved',
    top1Percent: concentrationStatus === 'resolved' && typeof input.top1Percent === 'number' && Number.isFinite(input.top1Percent) ? input.top1Percent : undefined,
    top10Percent: concentrationStatus === 'resolved' && typeof input.top10Percent === 'number' && Number.isFinite(input.top10Percent) ? input.top10Percent : undefined,
    top20Percent: concentrationStatus === 'resolved' && typeof input.top20Percent === 'number' && Number.isFinite(input.top20Percent) ? input.top20Percent : undefined,
    evidenceGaps,
  }
}

// Rule: minimum-count evidence (or unavailable concentration) must never be presented as full
// verification — used to cap the drawer/feed severity label below the top tier ('STRONGER') and to
// gate SAFE/Strong/Verified-style copy anywhere it's derived from holder evidence.
export function holderEvidenceBlocksTopTier(evidence: Pick<HolderEvidence, 'holderVerified' | 'concentrationStatus'>): boolean {
  return !evidence.holderVerified || evidence.concentrationStatus === 'unavailable'
}

export function getHolderCountCopy(evidence: Pick<HolderEvidence, 'holderCountStatus' | 'holderCountDisplay'>): string {
  if (evidence.holderCountStatus === 'exact') {
    return `Holder count verified — ${evidence.holderCountDisplay} holders.`
  }
  if (evidence.holderCountStatus === 'minimum') {
    return `Holder count minimum confirmed — at least ${evidence.holderCountDisplay.replace('+', '')} holders.`
  }
  return 'Holder count is an open check — no provider returned a usable count.'
}

export function getConcentrationCopy(evidence: Pick<HolderEvidence, 'concentrationStatus' | 'concentrationProvider'>): string {
  if (evidence.concentrationStatus === 'resolved') {
    const provider = evidence.concentrationProvider === 'goldrush' ? 'GoldRush/Covalent' : evidence.concentrationProvider
    return provider
      ? `Top holder balances resolved via ${provider} snapshot.`
      : 'Top 1/10/20 supply concentration is resolved from real indexed holder balances.'
  }
  return 'The provider confirmed a holder count, but did not return the holder balance list needed for Top 1/10/20 concentration.'
}

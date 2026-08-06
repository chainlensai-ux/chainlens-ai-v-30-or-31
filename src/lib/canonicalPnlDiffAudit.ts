// MODULE — canonicalPnlDiffAudit (canonical-PnL-movement audit task).
//
// PURPOSE, DISCLOSED: this module DIAGNOSES, it never repairs. Production reported the SAME 26
// canonical lots — stable lot set, stable `verifiedLotIdentityFingerprint` — reporting ~$1.4k, then
// ~$3.6k, then $5,066.84 realized PnL, with `acceptedHistoricalPriceFingerprint` and
// `realizedPnlFingerprint` both moving each time. A stable identity fingerprint alongside a moving
// price fingerprint proves the movement is entirely in the VALUES attached to an unchanged lot set,
// so this module reconstructs a deterministic per-lot value diff and names the exact groups
// responsible, rather than changing anything.
//
// NOTHING HERE MUTATES OR REFRESHES A MANIFEST. Every function is pure; the only side-effecting
// export is the logging wrapper at the bottom, and it writes to a caller-supplied logger.
//
// ============================================================================
// THE VALUE-SEMANTICS DEFECT THIS AUDIT WAS BUILT TO SURFACE, TRACED IN FULL
// ============================================================================
//
// `acceptedEvidenceStore`'s envelope carries BOTH `priceUsd` and `valueUsd`, and the two writers /
// readers in this codebase agree on what they mean:
//
//   * WRITER — pnlReconciliation's `seedAcceptedEvidenceForVerifiedLots`:
//         priceUsd: price, valueUsd: price * lot.amount
//     where `price` is `lot.costBasisUsd` (entry) or `lot.proceedsUsd` (exit) — i.e. `priceUsd` is
//     ONE MATCHED LOT'S OWN already-apportioned USD figure, and `valueUsd` is that figure scaled by
//     the lot's quantity.
//
//   * READER — pnlReconciliation's `hydrateFromAcceptedEvidence`:
//         if (s.side === 'entry') costBasisUsd = evidence.priceUsd
//         else                    proceedsUsd  = evidence.priceUsd
//     a direct 1:1 restore of that same per-lot figure.
//
// So `priceUsd` is a PER-LOT value, NOT a transaction-side total awaiting division. But the
// accepted-evidence KEY is per (chain, token, txHash, side, timestamp) and deliberately excludes the
// lot — so when one transaction side is shared by N sibling partial-fill lots, all N write the SAME
// key and the LAST writer's value survives. `priceUsd` for a shared side is therefore ONE ARBITRARY
// SIBLING'S cost basis.
//
// Both historical treatments of that value are wrong in opposite directions, which is precisely the
// up-and-down movement production observed on an unchanged lot set:
//   * FLAT COPY (the original behaviour): every sibling restored the full `priceUsd`, so a shared
//     side contributed N x one-sibling's-value — OVER-counts whenever N > 1.
//   * QUANTITY ALLOCATION (the later behaviour): siblings split `priceUsd` proportionally, so the
//     side contributed one-sibling's-value in total — UNDER-counts by roughly a factor of N.
// Neither reproduces the real total, because the stored record simply does not contain the
// side total that either treatment assumes it does.
//
// `checkValueSemantics` below detects exactly this, per group, with the real numbers attached — see
// its own header. This module deliberately stops at diagnosis: choosing the correct remediation
// (re-seed evidence with a genuine side total, or key evidence per-lot) changes accepted-evidence
// precedence and is not this task's scope.

import type { CanonicalManifestLotRecord } from './canonicalPnlSampleManifest'

// OBSOLETE-SCHEMA GATE, DISCLOSED (wallet-scanner-bounded-publication follow-up task — confirmed
// false-positive source: `checkValueSemantics` below was built to detect ONE specific, now-fixed
// defect — the v1 accepted-evidence writer persisting a PER-LOT value under a side-scoped key,
// later restored 1:1 as if it were the side TOTAL (see this module's own header). The
// accepted-evidence-persistence follow-up task fixed the writer to persist a genuine side total
// (bumping ACCEPTED_EVIDENCE_SCHEMA_VERSION 1 -> 2) — for schema-2+ evidence, a group's claimed
// total legitimately equals `evidence.priceUsd` DIRECTLY (never `priceUsd * occurrenceCount`), so
// `checkValueSemantics`'s own "does the claimed total equal N x priceUsd" test is testing for a
// pattern that can only arise from OBSOLETE v1 data — evaluating it against current-schema evidence
// produces a false CRITICAL on genuinely-correct data. `OBSOLETE_ACCEPTED_EVIDENCE_SCHEMA_VERSION`
// names that one known-obsolete version literally (never "not the current version", which would
// also silently swallow a genuinely NEW, real defect pattern introduced by some future schema bump).
export const OBSOLETE_ACCEPTED_EVIDENCE_SCHEMA_VERSION = 1

// Cent-scale tolerance, matching the manifest module's own `CANONICAL_TOTAL_TOLERANCE_USD` — real
// value drift in the confirmed production case was thousands of dollars, nowhere near this.
export const PNL_DIFF_TOLERANCE_USD = 0.01
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

function sumOrNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null
  if (values.some((v) => v === null)) return null
  let total = 0
  for (const v of values) total += v as number
  return round8(total)
}

function deltaOrNull(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null
  return round8(current - previous)
}

// ============================================================================
// PER-LOT DIFF
// ============================================================================

export type CanonicalPnlDiffChangeKind = 'added' | 'removed' | 'changed' | 'unchanged'

export type CanonicalPnlDiffRow = {
  canonicalGroupKey: string
  canonicalAmount: string
  occurrenceCount: number
  previousOccurrenceCount: number | null
  entryEvidenceKey: string | null
  exitEvidenceKey: string | null
  entryPriceUsd: number | null
  exitPriceUsd: number | null
  costBasisUsd: number | null
  proceedsUsd: number | null
  realizedPnlUsd: number | null
  entrySource: string | null
  exitSource: string | null
  evidenceSchemaVersion: number | null
  pricingMethodologyVersion: number | null
  // The prior snapshot's own figures for this same group, and the resulting contribution change.
  previousCostBasisUsd: number | null
  previousProceedsUsd: number | null
  previousRealizedPnlUsd: number | null
  realizedPnlDeltaUsd: number | null
  costBasisDeltaUsd: number | null
  proceedsDeltaUsd: number | null
  changeKind: CanonicalPnlDiffChangeKind
}

function rowFromRecords(
  key: string,
  current: CanonicalManifestLotRecord | undefined,
  previous: CanonicalManifestLotRecord | undefined,
): CanonicalPnlDiffRow {
  const currentPnl = current?.groupRealizedPnlUsd ?? null
  const previousPnl = previous?.groupRealizedPnlUsd ?? null
  const currentCost = current?.groupCostBasisUsd ?? null
  const previousCost = previous?.groupCostBasisUsd ?? null
  const currentProceeds = current?.groupProceedsUsd ?? null
  const previousProceeds = previous?.groupProceedsUsd ?? null

  // A group present on only one side contributes its whole figure as the change — reported as the
  // real signed delta against zero, never as an unexplained null.
  const realizedPnlDeltaUsd = current && previous
    ? deltaOrNull(currentPnl, previousPnl)
    : current
      ? currentPnl
      : previousPnl === null ? null : round8(-previousPnl)

  const changeKind: CanonicalPnlDiffChangeKind = !previous
    ? 'added'
    : !current
      ? 'removed'
      : (realizedPnlDeltaUsd !== null && Math.abs(realizedPnlDeltaUsd) > PNL_DIFF_TOLERANCE_USD)
        || (deltaOrNull(currentCost, previousCost) !== null && Math.abs(deltaOrNull(currentCost, previousCost) as number) > PNL_DIFF_TOLERANCE_USD)
        || (deltaOrNull(currentProceeds, previousProceeds) !== null && Math.abs(deltaOrNull(currentProceeds, previousProceeds) as number) > PNL_DIFF_TOLERANCE_USD)
        || current.occurrenceCount !== previous.occurrenceCount
        ? 'changed'
        : 'unchanged'

  const source = current ?? previous
  return {
    canonicalGroupKey: key,
    canonicalAmount: source?.canonicalAmount ?? '',
    occurrenceCount: current?.occurrenceCount ?? 0,
    previousOccurrenceCount: previous?.occurrenceCount ?? null,
    entryEvidenceKey: source?.entryEvidenceKey ?? null,
    exitEvidenceKey: source?.exitEvidenceKey ?? null,
    entryPriceUsd: current?.entryPriceUsd ?? null,
    exitPriceUsd: current?.exitPriceUsd ?? null,
    costBasisUsd: currentCost,
    proceedsUsd: currentProceeds,
    realizedPnlUsd: currentPnl,
    entrySource: source?.entrySource ?? null,
    exitSource: source?.exitSource ?? null,
    evidenceSchemaVersion: source?.evidenceSchemaVersion ?? null,
    pricingMethodologyVersion: source?.pricingMethodologyVersion ?? null,
    previousCostBasisUsd: previousCost,
    previousProceedsUsd: previousProceeds,
    previousRealizedPnlUsd: previousPnl,
    realizedPnlDeltaUsd,
    costBasisDeltaUsd: current && previous ? deltaOrNull(currentCost, previousCost) : null,
    proceedsDeltaUsd: current && previous ? deltaOrNull(currentProceeds, previousProceeds) : null,
    changeKind,
  }
}

// ============================================================================
// VALIDATION FINDINGS
// ============================================================================

export type CanonicalPnlValidationCode =
  | 'shared_side_value_duplicated_across_groups'
  | 'shared_side_value_not_allocated_exactly_once'
  | 'stablecoin_side_not_unit_priced'
  | 'price_usd_confused_with_total_transaction_value'
  | 'entry_exit_sides_reversed'
  | 'group_total_does_not_equal_accepted_side_total'

export type CanonicalPnlValidationFinding = {
  code: CanonicalPnlValidationCode
  severity: 'critical' | 'warning'
  canonicalGroupKeys: string[]
  evidenceKey: string | null
  detail: string
  // Real, measured numbers backing the finding — never a bare message.
  observedUsd: number | null
  expectedUsd: number | null
  differenceUsd: number | null
}

// The accepted-evidence figures a caller loaded for one side key. Every field is the envelope's
// own, unmodified value. `schemaVersion` is optional/additive — omitted (undefined) means the
// caller hasn't wired it, in which case `checkValueSemantics` conservatively treats the evidence as
// current-schema (never obsolete) rather than guessing; a caller that HAS wired it gets the real
// obsolete-schema exemption.
export type AcceptedEvidenceSideTotals = { priceUsd: number; valueUsd: number; schemaVersion?: number }

export type CanonicalPnlDiffInput = {
  currentRecords: readonly CanonicalManifestLotRecord[]
  previousRecords: readonly CanonicalManifestLotRecord[]
  // Optional real evidence values, keyed by accepted-evidence key — enables the side-total,
  // allocated-exactly-once and priceUsd-semantics checks. Omitted -> those checks are skipped
  // entirely rather than guessed at.
  evidenceByKey?: ReadonlyMap<string, AcceptedEvidenceSideTotals | null>
  // Real stablecoin predicate (src/modules/quoteLegPricing's isVerifiedStablecoinAddress). Omitted
  // -> the stablecoin check is skipped, never approximated by symbol string matching.
  isStablecoin?: (chain: string, token: string) => boolean
  // Per-occurrence quantity for the stablecoin unit-price check, keyed by canonical group key.
  // Omitted -> that check is skipped.
  amountByGroupKey?: ReadonlyMap<string, number>
}

// SHARED-EVIDENCE ALLOCATION CHECKS, DISCLOSED (this task's "transaction-side evidence value is not
// duplicated across sibling groups" / "shared evidence is allocated exactly once" / "group totals
// equal the original accepted-evidence side totals"). Every group referencing the same
// accepted-evidence key is collected, its claimed total summed, and the sum compared against the
// evidence record's OWN `priceUsd` and `valueUsd`. Reporting BOTH comparisons is deliberate: which
// one the sum matches is itself the diagnosis of what the code currently believes that field means.
function checkSharedEvidenceAllocation(input: CanonicalPnlDiffInput): CanonicalPnlValidationFinding[] {
  const findings: CanonicalPnlValidationFinding[] = []
  if (!input.evidenceByKey) return findings

  for (const side of ['entry', 'exit'] as const) {
    const byEvidenceKey = new Map<string, CanonicalManifestLotRecord[]>()
    for (const record of input.currentRecords) {
      const key = side === 'entry' ? record.entryEvidenceKey : record.exitEvidenceKey
      if (!key) continue
      const existing = byEvidenceKey.get(key)
      if (existing) existing.push(record)
      else byEvidenceKey.set(key, [record])
    }

    for (const [evidenceKey, records] of byEvidenceKey) {
      const evidence = input.evidenceByKey.get(evidenceKey)
      if (!evidence) continue
      const claimed = records.map((r) => (side === 'entry' ? r.groupCostBasisUsd : r.groupProceedsUsd))
      const claimedSum = sumOrNull(claimed)
      if (claimedSum === null) continue
      const groupKeys = records.map((r) => r.key).sort()

      // STABLECOIN-NORMALIZATION AWARENESS, DISCLOSED (vv6 audit-consistency follow-up task —
      // confirmed production false positive: canonicalPnlSampleManifest.ts's `stablecoinNormalizedGroupTotal`
      // correctly overrides a verified stablecoin side's group total to the deterministic $1/token
      // figure — that is now what the manifest/replay genuinely, correctly claims — but this check
      // still compared that NORMALIZED claim against the accepted-evidence record's own RAW, possibly
      // stale `priceUsd`/`valueUsd`, firing false `shared_side_value_duplicated_across_groups`/
      // `group_total_does_not_equal_accepted_side_total` CRITICAL findings on every normalized
      // stablecoin side. For a verified stablecoin side with real per-occurrence amount data
      // available, the EXPECTED total here is now the SAME deterministic $1/token figure
      // stablecoinNormalizedGroupTotal itself computes (sum of every sharing group's own
      // amount x occurrenceCount) — never the raw accepted-evidence figure the normalization exists
      // specifically to override. Without real amount data for every sharing group, this key is
      // SKIPPED entirely (never guessed) rather than validated against a comparison that no longer
      // reflects the real expected value. A non-stablecoin side takes the EXACT SAME, completely
      // unmodified priceUsd/valueUsd comparison as before — this never weakens that check.
      const representative = records[0]
      const isStablecoinSide = input.isStablecoin?.(representative.chain, representative.token) ?? false
      let expected = evidence.priceUsd
      if (isStablecoinSide) {
        if (!input.amountByGroupKey) continue
        let normalizedTotal = 0
        let missingAmount = false
        for (const r of records) {
          const amount = input.amountByGroupKey.get(r.key)
          if (amount === undefined || !Number.isFinite(amount)) { missingAmount = true; break }
          normalizedTotal += amount * r.occurrenceCount
        }
        if (missingAmount) continue
        expected = round8(normalizedTotal)
      }

      const matchesExpected = Math.abs(claimedSum - expected) <= PNL_DIFF_TOLERANCE_USD
      // For a stablecoin side there is exactly ONE correct answer (the normalized $1/token total) —
      // `matchesValue` collapses to the same comparison so the OR-logic below behaves identically to
      // the pre-existing "neither priceUsd nor valueUsd matches" shape. A non-stablecoin side still
      // independently checks the evidence record's own valueUsd, completely unchanged.
      const matchesValue = isStablecoinSide ? matchesExpected : Math.abs(claimedSum - evidence.valueUsd) <= PNL_DIFF_TOLERANCE_USD

      if (!matchesExpected && !matchesValue) {
        findings.push({
          code: 'group_total_does_not_equal_accepted_side_total',
          severity: 'critical',
          canonicalGroupKeys: groupKeys,
          evidenceKey,
          detail: isStablecoinSide
            ? `${side} side: the sum of every group's claimed total does not match the deterministic $1/token normalized total for this verified stablecoin side`
            : `${side} side: the sum of every group's claimed total matches neither the evidence record's priceUsd nor its valueUsd`,
          observedUsd: claimedSum,
          expectedUsd: expected,
          differenceUsd: round8(claimedSum - expected),
        })
      }

      // DUPLICATION: more than one DISTINCT occurrence group draws on one shared side, and each
      // claims a full side's worth — so the side's value is counted once per group.
      if (records.length > 1 && !matchesExpected && claimedSum > expected + PNL_DIFF_TOLERANCE_USD) {
        findings.push({
          code: 'shared_side_value_duplicated_across_groups',
          severity: 'critical',
          canonicalGroupKeys: groupKeys,
          evidenceKey,
          detail: isStablecoinSide
            ? `${side} side is shared by ${records.length} distinct occurrence groups whose claimed totals sum ABOVE the deterministic $1/token normalized total — the side value is being counted more than once`
            : `${side} side is shared by ${records.length} distinct occurrence groups whose claimed totals sum ABOVE the evidence record's own priceUsd — the side value is being counted more than once`,
          observedUsd: claimedSum,
          expectedUsd: expected,
          differenceUsd: round8(claimedSum - expected),
        })
      }

      if (!matchesExpected && !matchesValue && records.length === 1) {
        findings.push({
          code: 'shared_side_value_not_allocated_exactly_once',
          severity: 'critical',
          canonicalGroupKeys: groupKeys,
          evidenceKey,
          detail: isStablecoinSide
            ? `${side} side's single owning group claims a total that does not match the deterministic $1/token normalized total — the side was not allocated exactly once`
            : `${side} side's single owning group claims a total that is neither the evidence priceUsd nor its valueUsd — the side was not allocated exactly once`,
          observedUsd: claimedSum,
          expectedUsd: expected,
          differenceUsd: round8(claimedSum - expected),
        })
      }
    }
  }
  return findings
}

// PRICE-VS-TOTAL SEMANTICS CHECK, DISCLOSED — the decisive detector for the confirmed defect this
// module's own header traces in full. `priceUsd` is written as ONE LOT'S own USD figure and read
// back 1:1 by `hydrateFromAcceptedEvidence`, so a group of N occurrences that restores it correctly
// must claim N x priceUsd in total. A group claiming exactly `priceUsd` for N > 1 occurrences has
// divided a per-lot figure as though it were a side total (an N-fold UNDER-count); a group claiming
// N x priceUsd where the siblings' real values differ has flat-copied it (an OVER-count). Both are
// reported with the real signed difference so the direction is never ambiguous.
function checkValueSemantics(input: CanonicalPnlDiffInput): CanonicalPnlValidationFinding[] {
  const findings: CanonicalPnlValidationFinding[] = []
  if (!input.evidenceByKey) return findings

  for (const record of input.currentRecords) {
    if (record.occurrenceCount <= 1) continue
    for (const side of ['entry', 'exit'] as const) {
      const evidenceKey = side === 'entry' ? record.entryEvidenceKey : record.exitEvidenceKey
      const claimedTotal = side === 'entry' ? record.groupCostBasisUsd : record.groupProceedsUsd
      if (!evidenceKey || claimedTotal === null) continue
      const evidence = input.evidenceByKey.get(evidenceKey)
      if (!evidence) continue
      // OBSOLETE-SCHEMA GATE, DISCLOSED: this check exists ONLY to detect the confirmed v1 defect
      // (see OBSOLETE_ACCEPTED_EVIDENCE_SCHEMA_VERSION's own header) — for schema-2+ evidence the
      // claimed total legitimately equals `evidence.priceUsd` directly, so testing it against
      // `priceUsd * occurrenceCount` here would be a false positive on genuinely-correct data.
      if (evidence.schemaVersion !== OBSOLETE_ACCEPTED_EVIDENCE_SCHEMA_VERSION) continue
      // STABLECOIN EXEMPTION, DISCLOSED (vv6 audit-consistency follow-up task): a verified
      // stablecoin side's claimed total is the deterministic $1/token normalized figure
      // (stablecoinNormalizedGroupTotal), never a raw `priceUsd`/`priceUsd x occurrenceCount`
      // restore of the accepted-evidence record — this v1-schema defect detector does not apply to
      // it and must never fire a false positive by testing it against either shape.
      if (input.isStablecoin?.(record.chain, record.token)) continue

      const perLotRestore = round8(evidence.priceUsd * record.occurrenceCount)
      if (Math.abs(claimedTotal - perLotRestore) <= PNL_DIFF_TOLERANCE_USD) continue

      const dividedInstead = Math.abs(claimedTotal - evidence.priceUsd) <= PNL_DIFF_TOLERANCE_USD
      findings.push({
        code: 'price_usd_confused_with_total_transaction_value',
        severity: 'critical',
        canonicalGroupKeys: [record.key],
        evidenceKey,
        detail: dividedInstead
          ? `${side} side: this group's ${record.occurrenceCount} occurrences claim exactly the evidence record's priceUsd in TOTAL, but priceUsd is a PER-LOT figure (written as lot.costBasisUsd/proceedsUsd, restored 1:1 by hydrateFromAcceptedEvidence) — a per-lot value was divided as if it were a transaction-side total, under-counting this side ${record.occurrenceCount}-fold`
          : `${side} side: this group's claimed total is neither ${record.occurrenceCount} x priceUsd (the correct per-lot restore) nor priceUsd itself — the value semantics of this side cannot be reconciled with either treatment`,
        observedUsd: claimedTotal,
        expectedUsd: perLotRestore,
        differenceUsd: round8(claimedTotal - perLotRestore),
      })
    }
  }
  return findings
}

// ENTRY/EXIT ORIENTATION CHECK, DISCLOSED: the two evidence keys a record carries must address the
// OPENING transaction on the entry side and the CLOSING transaction on the exit side, and must be
// tagged with the matching side literal. A record whose entry key names its closing tx (or carries
// `:exit:`) has its sides reversed, which would silently swap cost basis and proceeds — inverting
// the sign of that group's realized PnL.
function checkSideOrientation(input: CanonicalPnlDiffInput): CanonicalPnlValidationFinding[] {
  const findings: CanonicalPnlValidationFinding[] = []
  for (const record of input.currentRecords) {
    const entryOk = record.entryEvidenceKey.includes(':entry:') && record.entryEvidenceKey.includes(record.openedTxHash)
    const exitOk = record.exitEvidenceKey.includes(':exit:') && record.exitEvidenceKey.includes(record.closedTxHash)
    if (entryOk && exitOk) continue
    findings.push({
      code: 'entry_exit_sides_reversed',
      severity: 'critical',
      canonicalGroupKeys: [record.key],
      evidenceKey: entryOk ? record.exitEvidenceKey : record.entryEvidenceKey,
      detail: !entryOk
        ? `entry evidence key does not address this group's opening transaction (${record.openedTxHash}) on the ':entry:' side`
        : `exit evidence key does not address this group's closing transaction (${record.closedTxHash}) on the ':exit:' side`,
      observedUsd: null,
      expectedUsd: null,
      differenceUsd: null,
    })
  }
  return findings
}

// STABLECOIN CHECK, DISCLOSED (this task's "stablecoins use $1 where required"): a verified
// stablecoin side is worth $1 per token, so its per-occurrence USD figure must equal the
// occurrence's own quantity. Only runs when the caller supplies BOTH a real stablecoin predicate
// and real per-occurrence quantities — never inferred from a symbol string.
function checkStablecoinUnitPricing(input: CanonicalPnlDiffInput): CanonicalPnlValidationFinding[] {
  const findings: CanonicalPnlValidationFinding[] = []
  if (!input.isStablecoin || !input.amountByGroupKey) return findings

  for (const record of input.currentRecords) {
    if (!input.isStablecoin(record.chain, record.token)) continue
    const amount = input.amountByGroupKey.get(record.key)
    if (amount === undefined || !Number.isFinite(amount)) continue
    for (const side of ['entry', 'exit'] as const) {
      const claimedTotal = side === 'entry' ? record.groupCostBasisUsd : record.groupProceedsUsd
      if (claimedTotal === null) continue
      const expected = round8(amount * record.occurrenceCount)
      if (Math.abs(claimedTotal - expected) <= PNL_DIFF_TOLERANCE_USD) continue
      findings.push({
        code: 'stablecoin_side_not_unit_priced',
        severity: 'warning',
        canonicalGroupKeys: [record.key],
        evidenceKey: side === 'entry' ? record.entryEvidenceKey : record.exitEvidenceKey,
        detail: `${side} side of a verified stablecoin position is not valued at $1/token: expected ${expected} for ${record.occurrenceCount} occurrence(s) of ${amount}`,
        observedUsd: claimedTotal,
        expectedUsd: expected,
        differenceUsd: round8(claimedTotal - expected),
      })
    }
  }
  return findings
}

// ============================================================================
// AUDIT
// ============================================================================

export const CANONICAL_PNL_DIFF_TOP_CAUSES = 10

export type CanonicalPnlDiffAudit = {
  currentRealizedPnlUsd: number | null
  previousRealizedPnlUsd: number | null
  realizedPnlDeltaUsd: number | null
  currentVerifiedLotCount: number
  previousVerifiedLotCount: number
  // Every group, sorted by |realized PnL delta| descending — fully deterministic.
  rows: CanonicalPnlDiffRow[]
  // The `CANONICAL_PNL_DIFF_TOP_CAUSES` largest movers, in the same order.
  topCauses: CanonicalPnlDiffRow[]
  // How much of the total movement the top causes account for — real, measured.
  topCausesDeltaUsd: number | null
  findings: CanonicalPnlValidationFinding[]
}

// PURE, DETERMINISTIC. Sorted by absolute realized-PnL delta descending, tie-broken by canonical
// group key ascending — two runs over the same inputs always produce byte-identical output, so this
// audit can itself be diffed across scans.
export function buildCanonicalPnlDiffAudit(input: CanonicalPnlDiffInput): CanonicalPnlDiffAudit {
  const currentByKey = new Map(input.currentRecords.map((r) => [r.key, r]))
  const previousByKey = new Map(input.previousRecords.map((r) => [r.key, r]))
  const allKeys = [...new Set([...currentByKey.keys(), ...previousByKey.keys()])].sort()

  const rows = allKeys
    .map((key) => rowFromRecords(key, currentByKey.get(key), previousByKey.get(key)))
    .sort((a, b) => {
      const aDelta = Math.abs(a.realizedPnlDeltaUsd ?? 0)
      const bDelta = Math.abs(b.realizedPnlDeltaUsd ?? 0)
      if (aDelta !== bDelta) return bDelta - aDelta
      return a.canonicalGroupKey.localeCompare(b.canonicalGroupKey)
    })

  const topCauses = rows.slice(0, CANONICAL_PNL_DIFF_TOP_CAUSES)
  const topCausesDeltaUsd = topCauses.length === 0
    ? null
    : round8(topCauses.reduce((sum, r) => sum + (r.realizedPnlDeltaUsd ?? 0), 0))

  const currentRealizedPnlUsd = sumOrNull(input.currentRecords.map((r) => r.groupRealizedPnlUsd))
  const previousRealizedPnlUsd = sumOrNull(input.previousRecords.map((r) => r.groupRealizedPnlUsd))

  return {
    currentRealizedPnlUsd,
    previousRealizedPnlUsd,
    realizedPnlDeltaUsd: deltaOrNull(currentRealizedPnlUsd, previousRealizedPnlUsd),
    currentVerifiedLotCount: input.currentRecords.reduce((sum, r) => sum + r.occurrenceCount, 0),
    previousVerifiedLotCount: input.previousRecords.reduce((sum, r) => sum + r.occurrenceCount, 0),
    rows,
    topCauses,
    topCausesDeltaUsd,
    findings: [
      ...checkSharedEvidenceAllocation(input),
      ...checkValueSemantics(input),
      ...checkSideOrientation(input),
      ...checkStablecoinUnitPricing(input),
    ],
  }
}

// LOGGING WRAPPER, DISCLOSED: the only side-effecting export. Emits ONE bounded summary line plus at
// most `CANONICAL_PNL_DIFF_TOP_CAUSES` cause lines and the validation findings — never one line per
// lot (this codebase has repeatedly confirmed that per-lot logging over a real wallet's lot count
// can block on stdout backpressure). Critical findings use `logger.error`; the diff summary itself
// is `logger.warn`, matching this codebase's own production-log-survival convention.
export function logCanonicalPnlDiffAudit(
  audit: CanonicalPnlDiffAudit,
  logger: Pick<Console, 'warn' | 'error'> = console,
): void {
  logger.warn('[canonical-pnl-diff-audit] summary', {
    currentRealizedPnlUsd: audit.currentRealizedPnlUsd,
    previousRealizedPnlUsd: audit.previousRealizedPnlUsd,
    realizedPnlDeltaUsd: audit.realizedPnlDeltaUsd,
    currentVerifiedLotCount: audit.currentVerifiedLotCount,
    previousVerifiedLotCount: audit.previousVerifiedLotCount,
    changedGroups: audit.rows.filter((r) => r.changeKind !== 'unchanged').length,
    topCausesDeltaUsd: audit.topCausesDeltaUsd,
  })
  if (audit.topCauses.some((r) => r.changeKind !== 'unchanged')) {
    logger.warn('[canonical-pnl-diff-audit] top causes by absolute PnL difference', {
      causes: audit.topCauses.map((r) => ({
        canonicalGroupKey: r.canonicalGroupKey,
        canonicalAmount: r.canonicalAmount,
        occurrenceCount: r.occurrenceCount,
        previousOccurrenceCount: r.previousOccurrenceCount,
        entryEvidenceKey: r.entryEvidenceKey,
        exitEvidenceKey: r.exitEvidenceKey,
        entryPriceUsd: r.entryPriceUsd,
        exitPriceUsd: r.exitPriceUsd,
        costBasisUsd: r.costBasisUsd,
        proceedsUsd: r.proceedsUsd,
        realizedPnlUsd: r.realizedPnlUsd,
        previousRealizedPnlUsd: r.previousRealizedPnlUsd,
        realizedPnlDeltaUsd: r.realizedPnlDeltaUsd,
        entrySource: r.entrySource,
        exitSource: r.exitSource,
        evidenceSchemaVersion: r.evidenceSchemaVersion,
        pricingMethodologyVersion: r.pricingMethodologyVersion,
        changeKind: r.changeKind,
      })),
    })
  }
  const critical = audit.findings.filter((f) => f.severity === 'critical')
  if (critical.length > 0) {
    logger.error('CRITICAL canonical_pnl_value_semantics_violation', {
      findingCount: critical.length,
      findings: critical.slice(0, CANONICAL_PNL_DIFF_TOP_CAUSES),
    })
  }
  const warnings = audit.findings.filter((f) => f.severity === 'warning')
  if (warnings.length > 0) {
    logger.warn('[canonical-pnl-diff-audit] validation warnings', { findings: warnings.slice(0, CANONICAL_PNL_DIFF_TOP_CAUSES) })
  }
}

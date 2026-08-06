// Regression tests for the canonical per-lot PnL diff audit (canonical-PnL-movement audit task).
//
// This audit exists to explain the confirmed production movement: the SAME 26 canonical lots, a
// STABLE `verifiedLotIdentityFingerprint`, but realized PnL moving ~$1.4k -> ~$3.6k -> $5,066.84 with
// `acceptedHistoricalPriceFingerprint` and `realizedPnlFingerprint` changing each time.
//
// Run directly with: npx tsx --test src/lib/canonicalPnlDiffAudit.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCanonicalPnlDiffAudit, logCanonicalPnlDiffAudit, CANONICAL_PNL_DIFF_TOP_CAUSES,
  OBSOLETE_ACCEPTED_EVIDENCE_SCHEMA_VERSION,
  type AcceptedEvidenceSideTotals,
} from './canonicalPnlDiffAudit.ts'
import {
  buildManifestFromCandidate, buildManifestIdentity, replayManifest, type CanonicalManifestLotRecord,
  type AcceptedEvidenceLoader,
} from './canonicalPnlSampleManifest.ts'
import { buildScanDeterminismAudit } from './scanDeterminismAudit.ts'
import {
  buildAcceptedEvidenceEnvelope, buildAcceptedEvidenceKey, lotIdentityVersion,
  readAcceptedEvidence, readAcceptedEvidenceAnyLotVersion, type AcceptedEvidenceKvLike,
} from './acceptedEvidenceStore.ts'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot.ts'
import type { MatchedLot } from '../modules/fifoEngine/types'

const NOW = 1_000_000

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified',
    ...overrides,
  }
}

// Minimal manifest-record fixture — only the fields this audit reads vary meaningfully.
function record(overrides: Partial<CanonicalManifestLotRecord> = {}): CanonicalManifestLotRecord {
  return {
    key: 'v3:base:0xtoken:0xbuy:0xsell:1:2:amt:1.000000000000',
    canonicalAmount: '1.000000000000',
    occurrenceCount: 1,
    partialFillGroupSize: 1,
    groupCostBasisUsd: 10,
    groupProceedsUsd: 12,
    groupRealizedPnlUsd: 2,
    chain: 'base',
    token: '0xtoken',
    openedTxHash: '0xbuy',
    closedTxHash: '0xsell',
    openedAt: 1,
    closedAt: 2,
    lotIdentityVersion: 'base:0xtoken:0xbuy:0xsell:1:2:1',
    entryEvidenceKey: 'v1:accepted-evidence:base:0xtoken:0xbuy:entry:1',
    exitEvidenceKey: 'v1:accepted-evidence:base:0xtoken:0xsell:exit:2',
    entryEvidenceLotIdentityVersion: null,
    exitEvidenceLotIdentityVersion: null,
    entryPriceUsd: 10,
    entryValueUsd: 10,
    exitPriceUsd: 12,
    exitValueUsd: 12,
    costBasisUsd: 10,
    proceedsUsd: 12,
    realizedPnlUsd: 2,
    evidenceQuality: 'verified',
    entrySource: 'canonical-upstream',
    exitSource: 'canonical-upstream',
    pricingMethodologyVersion: 1,
    evidenceSchemaVersion: 1,
    acceptedEvidenceValueType: 'total_side_value_usd',
    entrySideGroupIdentity: 'v1:accepted-evidence:base:0xtoken:0xbuy:entry:1',
    entrySideGroupRawQuantity: '0',
    entryLotRawQuantity: '0',
    entryAllocationNumerator: '0',
    entryAllocationDenominator: '0',
    exitSideGroupIdentity: 'v1:accepted-evidence:base:0xtoken:0xsell:exit:2',
    exitSideGroupRawQuantity: '0',
    exitLotRawQuantity: '0',
    exitAllocationNumerator: '0',
    exitAllocationDenominator: '0',
    allocatedCostBasisUsd: 10,
    allocatedProceedsUsd: 12,
    ...overrides,
  }
}

describe('canonicalPnlDiffAudit — per-lot diff (deterministic, sorted by absolute PnL difference)', () => {
  it('HARD ASSERTION: ranks groups by absolute realized-PnL delta and reports the top causes', () => {
    const previous = [
      record({ key: 'g:small', groupRealizedPnlUsd: 10 }),
      record({ key: 'g:huge', groupRealizedPnlUsd: 100 }),
      record({ key: 'g:medium', groupRealizedPnlUsd: 50 }),
    ]
    const current = [
      record({ key: 'g:small', groupRealizedPnlUsd: 12 }),        // +2
      record({ key: 'g:huge', groupRealizedPnlUsd: 3100 }),        // +3000  <- the $3k+ mover
      record({ key: 'g:medium', groupRealizedPnlUsd: -150 }),      // -200
    ]
    const audit = buildCanonicalPnlDiffAudit({ currentRecords: current, previousRecords: previous })

    assert.equal(audit.previousRealizedPnlUsd, 160)
    assert.equal(audit.currentRealizedPnlUsd, 2962)
    assert.equal(audit.realizedPnlDeltaUsd, 2802)
    assert.deepEqual(audit.rows.map((r) => r.canonicalGroupKey), ['g:huge', 'g:medium', 'g:small'])
    assert.equal(audit.rows[0].realizedPnlDeltaUsd, 3000, 'the largest absolute mover ranks first')
    assert.equal(audit.rows[1].realizedPnlDeltaUsd, -200, 'a large NEGATIVE move outranks a small positive one')
    assert.equal(audit.topCauses.length, 3)
    assert.equal(audit.topCausesDeltaUsd, 2802)
  })

  it('caps top causes at exactly CANONICAL_PNL_DIFF_TOP_CAUSES while keeping every row available', () => {
    const previous = Array.from({ length: 25 }, (_, i) => record({ key: `g:${i}`, groupRealizedPnlUsd: 0 }))
    const current = Array.from({ length: 25 }, (_, i) => record({ key: `g:${i}`, groupRealizedPnlUsd: i }))
    const audit = buildCanonicalPnlDiffAudit({ currentRecords: current, previousRecords: previous })
    assert.equal(audit.topCauses.length, CANONICAL_PNL_DIFF_TOP_CAUSES)
    assert.equal(audit.rows.length, 25)
    assert.equal(audit.topCauses[0].canonicalGroupKey, 'g:24', 'largest mover first')
  })

  it('is fully deterministic — identical inputs produce byte-identical output, ties broken by group key', () => {
    const previous = [record({ key: 'g:b', groupRealizedPnlUsd: 0 }), record({ key: 'g:a', groupRealizedPnlUsd: 0 })]
    const current = [record({ key: 'g:b', groupRealizedPnlUsd: 5 }), record({ key: 'g:a', groupRealizedPnlUsd: 5 })]
    const first = buildCanonicalPnlDiffAudit({ currentRecords: current, previousRecords: previous })
    const second = buildCanonicalPnlDiffAudit({ currentRecords: [...current].reverse(), previousRecords: [...previous].reverse() })
    assert.deepEqual(first, second, 'input array order must never change the audit')
    assert.deepEqual(first.rows.map((r) => r.canonicalGroupKey), ['g:a', 'g:b'], 'equal deltas tie-break on group key')
  })

  it('classifies added / removed / changed / unchanged groups honestly', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ key: 'g:kept', groupRealizedPnlUsd: 2 }), record({ key: 'g:new', groupRealizedPnlUsd: 40 })],
      previousRecords: [record({ key: 'g:kept', groupRealizedPnlUsd: 2 }), record({ key: 'g:gone', groupRealizedPnlUsd: 7 })],
    })
    const byKey = new Map(audit.rows.map((r) => [r.canonicalGroupKey, r]))
    assert.equal(byKey.get('g:kept')!.changeKind, 'unchanged')
    assert.equal(byKey.get('g:new')!.changeKind, 'added')
    assert.equal(byKey.get('g:new')!.realizedPnlDeltaUsd, 40, 'an added group contributes its whole figure')
    assert.equal(byKey.get('g:gone')!.changeKind, 'removed')
    assert.equal(byKey.get('g:gone')!.realizedPnlDeltaUsd, -7, 'a removed group contributes its negated figure')
  })

  it('a changed occurrence count alone marks the group as changed', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ key: 'g:1', occurrenceCount: 3, groupRealizedPnlUsd: 2 })],
      previousRecords: [record({ key: 'g:1', occurrenceCount: 2, groupRealizedPnlUsd: 2 })],
    })
    assert.equal(audit.rows[0].changeKind, 'changed')
    assert.equal(audit.rows[0].occurrenceCount, 3)
    assert.equal(audit.rows[0].previousOccurrenceCount, 2)
    assert.equal(audit.currentVerifiedLotCount, 3, 'lot counts sum occurrence counts, never record counts')
    assert.equal(audit.previousVerifiedLotCount, 2)
  })

  it('every required field is present on every row', () => {
    const audit = buildCanonicalPnlDiffAudit({ currentRecords: [record()], previousRecords: [] })
    const row = audit.rows[0]
    for (const field of [
      'canonicalGroupKey', 'canonicalAmount', 'occurrenceCount', 'entryEvidenceKey', 'exitEvidenceKey',
      'entryPriceUsd', 'exitPriceUsd', 'costBasisUsd', 'proceedsUsd', 'realizedPnlUsd',
      'entrySource', 'exitSource', 'evidenceSchemaVersion', 'pricingMethodologyVersion', 'realizedPnlDeltaUsd',
    ] as const) {
      assert.ok(field in row, `${field} must be present on every diff row`)
    }
  })
})

describe('canonicalPnlDiffAudit — value-semantics validation', () => {
  const entryKey = 'v1:accepted-evidence:base:0xtoken:0xbuy:entry:1'
  const exitKey = 'v1:accepted-evidence:base:0xtoken:0xsell:exit:2'

  function evidence(entries: Record<string, AcceptedEvidenceSideTotals>): Map<string, AcceptedEvidenceSideTotals> {
    return new Map(Object.entries(entries))
  }

  it('HARD ASSERTION (the confirmed defect): a group that DIVIDES a per-lot priceUsd across its occurrences is flagged with the exact under-count (OBSOLETE v1 evidence only)', () => {
    // priceUsd is written as ONE lot's own cost basis and restored 1:1, so 3 occurrences must claim
    // 3 x 100 = 300. Claiming exactly 100 means a per-lot figure was divided as a side total. This
    // defect can only arise from OBSOLETE v1 accepted-evidence (schemaVersion: 1) — see
    // OBSOLETE_ACCEPTED_EVIDENCE_SCHEMA_VERSION's own header.
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 3, groupCostBasisUsd: 100, groupProceedsUsd: 160, groupRealizedPnlUsd: 60 })],
      previousRecords: [],
      evidenceByKey: evidence({
        [entryKey]: { priceUsd: 100, valueUsd: 200, schemaVersion: 1 },
        [exitKey]: { priceUsd: 160, valueUsd: 320, schemaVersion: 1 },
      }),
    })
    const semantic = audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value')
    assert.equal(semantic.length, 2, 'both sides of the group must be flagged')
    const entryFinding = semantic.find((f) => f.evidenceKey === entryKey)!
    assert.equal(entryFinding.severity, 'critical')
    assert.equal(entryFinding.observedUsd, 100)
    assert.equal(entryFinding.expectedUsd, 300, 'the correct per-lot restore is occurrenceCount x priceUsd')
    assert.equal(entryFinding.differenceUsd, -200, 'the under-count is reported as a real signed difference')
    assert.match(entryFinding.detail, /under-counting this side 3-fold/)
  })

  it('a group that correctly restores occurrenceCount x priceUsd raises no semantics finding', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 3, groupCostBasisUsd: 300, groupProceedsUsd: 480, groupRealizedPnlUsd: 180 })],
      previousRecords: [],
      evidenceByKey: evidence({ [entryKey]: { priceUsd: 100, valueUsd: 200 }, [exitKey]: { priceUsd: 160, valueUsd: 320 } }),
    })
    assert.equal(audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value').length, 0)
  })

  it('a single-occurrence group is never flagged for value semantics (nothing to divide)', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 1, groupCostBasisUsd: 100, groupProceedsUsd: 160 })],
      previousRecords: [],
      evidenceByKey: evidence({ [entryKey]: { priceUsd: 100, valueUsd: 100 }, [exitKey]: { priceUsd: 160, valueUsd: 160 } }),
    })
    assert.equal(audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value').length, 0)
  })

  it('HARD ASSERTION: one shared side claimed by two DISTINCT groups above its own value is flagged as duplicated', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [
        record({ key: 'g:a', canonicalAmount: '1.000000000000', groupCostBasisUsd: 100 }),
        record({ key: 'g:b', canonicalAmount: '2.000000000000', groupCostBasisUsd: 100 }),
      ],
      previousRecords: [],
      evidenceByKey: evidence({ [entryKey]: { priceUsd: 100, valueUsd: 100 }, [exitKey]: { priceUsd: 12, valueUsd: 12 } }),
    })
    const dup = audit.findings.find((f) => f.code === 'shared_side_value_duplicated_across_groups')
    assert.ok(dup, 'two groups each claiming the full side value must be flagged')
    assert.deepEqual(dup!.canonicalGroupKeys, ['g:a', 'g:b'])
    assert.equal(dup!.observedUsd, 200)
    assert.equal(dup!.expectedUsd, 100)
    assert.equal(dup!.differenceUsd, 100)
  })

  it('a shared side allocated exactly once across its groups raises no allocation finding', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [
        record({ key: 'g:a', canonicalAmount: '1.000000000000', groupCostBasisUsd: 60, groupProceedsUsd: 6 }),
        record({ key: 'g:b', canonicalAmount: '2.000000000000', groupCostBasisUsd: 40, groupProceedsUsd: 6 }),
      ],
      previousRecords: [],
      evidenceByKey: evidence({ [entryKey]: { priceUsd: 100, valueUsd: 100 }, [exitKey]: { priceUsd: 12, valueUsd: 12 } }),
    })
    assert.equal(audit.findings.filter((f) => f.code === 'shared_side_value_duplicated_across_groups').length, 0)
    assert.equal(audit.findings.filter((f) => f.code === 'group_total_does_not_equal_accepted_side_total').length, 0)
  })

  it('HARD ASSERTION: reversed entry/exit sides are detected', () => {
    const reversed = record({
      entryEvidenceKey: 'v1:accepted-evidence:base:0xtoken:0xsell:exit:2',
      exitEvidenceKey: 'v1:accepted-evidence:base:0xtoken:0xbuy:entry:1',
    })
    const audit = buildCanonicalPnlDiffAudit({ currentRecords: [reversed], previousRecords: [] })
    const finding = audit.findings.find((f) => f.code === 'entry_exit_sides_reversed')
    assert.ok(finding, 'a swapped entry/exit pair must be caught — it would invert the group\'s PnL sign')
    assert.equal(finding!.severity, 'critical')
  })

  it('correctly oriented entry/exit sides raise no orientation finding', () => {
    const audit = buildCanonicalPnlDiffAudit({ currentRecords: [record()], previousRecords: [] })
    assert.equal(audit.findings.filter((f) => f.code === 'entry_exit_sides_reversed').length, 0)
  })

  it('HARD ASSERTION: a verified stablecoin side not valued at $1/token is flagged', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ key: 'g:usdc', token: '0xusdc', occurrenceCount: 2, groupCostBasisUsd: 900, groupProceedsUsd: 1000 })],
      previousRecords: [],
      isStablecoin: (_chain, token) => token === '0xusdc',
      amountByGroupKey: new Map([['g:usdc', 500]]),
    })
    const finding = audit.findings.find((f) => f.code === 'stablecoin_side_not_unit_priced')
    assert.ok(finding)
    assert.equal(finding!.expectedUsd, 1000, '2 occurrences of 500 tokens at $1 = $1000')
    assert.equal(finding!.observedUsd, 900)
    assert.equal(finding!.differenceUsd, -100)
  })

  it('a stablecoin side valued exactly at $1/token raises no finding', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ key: 'g:usdc', token: '0xusdc', occurrenceCount: 2, groupCostBasisUsd: 1000, groupProceedsUsd: 1000 })],
      previousRecords: [],
      isStablecoin: (_chain, token) => token === '0xusdc',
      amountByGroupKey: new Map([['g:usdc', 500]]),
    })
    assert.equal(audit.findings.filter((f) => f.code === 'stablecoin_side_not_unit_priced').length, 0)
  })

  // VV6 AUDIT-CONSISTENCY FOLLOW-UP TASK — confirmed production false positive: after
  // canonicalPnlSampleManifest.ts's stablecoinNormalizedGroupTotal correctly overrides a verified
  // stablecoin side's claimed total to the deterministic $1/token figure, this audit's own
  // shared-evidence-allocation check still compared that NORMALIZED claim against the accepted-
  // evidence record's own RAW, stale priceUsd/valueUsd — firing false CRITICAL
  // shared_side_value_duplicated_across_groups / group_total_does_not_equal_accepted_side_total
  // findings on every correctly-normalized stablecoin side.
  it('HARD ASSERTION (required regression): stale stablecoin accepted evidence with a provider value != the $1-normalized total does NOT trigger a false CRITICAL under methodology v6', () => {
    // Confirmed production shape: Base USDC side claims the correct, normalized $1197.164051
    // (1194.1715 units x $1), but the stale accepted-evidence record still carries its old, wrong
    // priceUsd/valueUsd of $5.985462.
    const usdcKey = 'v1:accepted-evidence:base:0xusdc:0xbuy:entry:1'
    const usdcExitKey = 'v1:accepted-evidence:base:0xusdc:0xsell:exit:2'
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({
        key: 'g:usdc-vv6', token: '0xusdc', canonicalAmount: '1194.171500000000',
        entryEvidenceKey: usdcKey, exitEvidenceKey: usdcExitKey,
        groupCostBasisUsd: 1197.164051, groupProceedsUsd: 1197.164051, groupRealizedPnlUsd: 0,
      })],
      previousRecords: [],
      evidenceByKey: evidence({
        [usdcKey]: { priceUsd: 5.985462, valueUsd: 5.985462 },
        [usdcExitKey]: { priceUsd: 5.985462, valueUsd: 5.985462 },
      }),
      isStablecoin: (_chain, token) => token === '0xusdc',
      amountByGroupKey: new Map([['g:usdc-vv6', 1197.164051]]),
    })
    const critical = audit.findings.filter((f) => f.severity === 'critical')
    assert.deepEqual(critical, [], 'a verified stablecoin side correctly normalized to $1/token must never be flagged against stale accepted-evidence figures the normalization exists specifically to override')
  })

  it('HARD ASSERTION (required regression): a real duplicated shared stablecoin side still triggers CRITICAL under methodology v6', () => {
    // Two DISTINCT groups, each genuinely holding 500 real tokens (so the correct combined
    // normalized total is 500 + 500 = $1000), but each INCORRECTLY claims the FULL $1000 for
    // itself instead of its own $500 share — a real duplication (claimedSum 2000 vs the correct
    // combined normalized total 1000), never a normalization artifact (which would instead show each
    // group correctly claiming its own $500 share, summing exactly to the correct $1000).
    const sharedKey = 'v1:accepted-evidence:base:0xusdc:0xbuy:entry:1'
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [
        record({ key: 'g:usdc-a', token: '0xusdc', canonicalAmount: '500.000000000000', entryEvidenceKey: sharedKey, groupCostBasisUsd: 1000 }),
        record({ key: 'g:usdc-b', token: '0xusdc', canonicalAmount: '500.000000000000', entryEvidenceKey: sharedKey, groupCostBasisUsd: 1000 }),
      ],
      previousRecords: [],
      evidenceByKey: evidence({ [sharedKey]: { priceUsd: 5.99, valueUsd: 5.99 } }), // stale, deliberately irrelevant
      isStablecoin: (_chain, token) => token === '0xusdc',
      amountByGroupKey: new Map([['g:usdc-a', 500], ['g:usdc-b', 500]]),
    })
    const dup = audit.findings.find((f) => f.code === 'shared_side_value_duplicated_across_groups')
    assert.ok(dup, 'a genuinely duplicated stablecoin side must still be caught — normalization awareness never masks a real defect')
    assert.equal(dup!.severity, 'critical')
    assert.equal(dup!.observedUsd, 2000, 'both groups over-claiming the full total sum to 2000')
    assert.equal(dup!.expectedUsd, 1000, 'the correct combined normalized total for the two real 500-unit occurrences')
  })

  it('a verified stablecoin side is SKIPPED (never guessed) when real per-occurrence amount data is unavailable', () => {
    const usdcKey = 'v1:accepted-evidence:base:0xusdc:0xbuy:entry:1'
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ key: 'g:usdc-noamount', token: '0xusdc', entryEvidenceKey: usdcKey, groupCostBasisUsd: 1197.164051 })],
      previousRecords: [],
      evidenceByKey: evidence({ [usdcKey]: { priceUsd: 5.985462, valueUsd: 5.985462 } }),
      isStablecoin: (_chain, token) => token === '0xusdc',
      // amountByGroupKey intentionally omitted — nothing to validate against, never guessed.
    })
    assert.equal(audit.findings.filter((f) => f.evidenceKey === usdcKey).length, 0)
  })

  it('checks needing optional inputs are SKIPPED, never guessed, when those inputs are absent', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 3, groupCostBasisUsd: 100 })],
      previousRecords: [],
    })
    assert.equal(audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value').length, 0)
    assert.equal(audit.findings.filter((f) => f.code === 'stablecoin_side_not_unit_priced').length, 0)
  })

  // ===============================================================================================
  // OBSOLETE-SCHEMA GATE — wallet-scanner-bounded-publication follow-up task. The
  // price_usd_confused_with_total_transaction_value check exists ONLY to catch the confirmed v1
  // defect; it must never fire a false CRITICAL against genuinely-correct current-schema (2+)
  // evidence, while still catching the real defect on evidence that genuinely IS obsolete v1.
  // ===============================================================================================

  it('HARD ASSERTION (required fix): the exact same claimed-total shape that would be a v1 defect is NEVER flagged for current-schema (2+) evidence — it is legitimately correct there', () => {
    assert.equal(OBSOLETE_ACCEPTED_EVIDENCE_SCHEMA_VERSION, 1)
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 3, groupCostBasisUsd: 100, groupProceedsUsd: 160, groupRealizedPnlUsd: 60 })],
      previousRecords: [],
      evidenceByKey: evidence({
        [entryKey]: { priceUsd: 100, valueUsd: 200, schemaVersion: 2 },
        [exitKey]: { priceUsd: 160, valueUsd: 320, schemaVersion: 2 },
      }),
    })
    assert.equal(audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value').length, 0, 'for schema-2+ evidence, claimedTotal === priceUsd directly IS the correct shape, never a defect')
  })

  it('a caller that has not wired schemaVersion at all is treated conservatively as current-schema — never a false positive from an unmigrated caller', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 3, groupCostBasisUsd: 100, groupProceedsUsd: 160, groupRealizedPnlUsd: 60 })],
      previousRecords: [],
      evidenceByKey: evidence({
        [entryKey]: { priceUsd: 100, valueUsd: 200 },
        [exitKey]: { priceUsd: 160, valueUsd: 320 },
      }),
    })
    assert.equal(audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value').length, 0)
  })

  it('genuinely obsolete v1 evidence (schemaVersion: 1) still fires the finding — the gate exempts current data, it never disables real detection', () => {
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 3, groupCostBasisUsd: 100, groupProceedsUsd: 160, groupRealizedPnlUsd: 60 })],
      previousRecords: [],
      evidenceByKey: evidence({
        [entryKey]: { priceUsd: 100, valueUsd: 200, schemaVersion: 1 },
        [exitKey]: { priceUsd: 160, valueUsd: 320, schemaVersion: 1 },
      }),
    })
    assert.equal(audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value').length, 2)
  })
})

describe('canonicalPnlDiffAudit — end-to-end against a REAL manifest build (the confirmed production mechanism)', () => {
  it('HARD ASSERTION: a real 3-sibling partial fill built through buildManifestFromCandidate freezes a 3x UNDER-counted total, and the audit names it with exact numbers', async () => {
    const store = new Map<string, string>()
    const kv: AcceptedEvidenceKvLike = {
      get: async <T>(key: string) => (store.has(key) ? (JSON.parse(store.get(key)!) as T) : null),
      set: async (key: string, value: unknown) => { store.set(key, JSON.stringify(value)); return 'OK' },
    }
    // Three identical siblings, each genuinely worth $100 cost / $160 proceeds -> real group PnL $180.
    const siblings = [0, 1, 2].map((i) => lot({
      lotId: `s${i}`, token: '0xshared', openedTxHash: '0xsharedbuy', closedTxHash: '0xsharedsell',
      openedAt: 100, closedAt: 200, amount: 2, costBasisUsd: 100, proceedsUsd: 160, realizedPnlUsd: 60,
    }))
    // Seeded EXACTLY as pnlReconciliation's seedAcceptedEvidenceForVerifiedLots does:
    // priceUsd = one lot's own figure, valueUsd = that figure x the lot's quantity.
    for (const l of siblings) {
      for (const side of ['entry', 'exit'] as const) {
        const price = (side === 'entry' ? l.costBasisUsd : l.proceedsUsd) as number
        const identity = {
          chain: l.chain, token: l.token, txHash: side === 'entry' ? l.openedTxHash : l.closedTxHash,
          side, timestamp: side === 'entry' ? l.openedAt : l.closedAt, lotIdentityVersion: lotIdentityVersion(l),
        }
        await kv.set(buildAcceptedEvidenceKey(identity), buildAcceptedEvidenceEnvelope({
          identity, priceUsd: price, valueUsd: price * l.amount,
          source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, now: NOW,
        }))
      }
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
        : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)
    const computeFingerprints = (lots: readonly MatchedLot[], realizedPnlUsd: number | null) => {
      const a = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
      return {
        verifiedLotIdentityFingerprint: a.verifiedLotIdentityFingerprint,
        acceptedHistoricalPriceFingerprint: a.acceptedHistoricalPriceFingerprint,
        realizedPnlFingerprint: a.realizedPnlFingerprint,
        scanFingerprint: a.scanFingerprint,
      }
    }

    const manifest = await buildManifestFromCandidate({
      identity: buildManifestIdentity({ walletAddress: '0xw', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp' }),
      allCandidateLots: siblings, candidateVerifiedLots: siblings, structuralLotCount: siblings.length,
      fingerprints: computeFingerprints(siblings, 180), realizedPnlUsd: 180,
      verifiedPricingCoverage: 1, now: 1, loadEvidence: loader, computeFingerprints,
    })

    // THE DEFECT, PROVEN: the real group is worth $180, the manifest froze $60 — exactly 1/3.
    assert.equal(manifest.verifiedLotRecords.length, 1)
    assert.equal(manifest.verifiedLotRecords[0].occurrenceCount, 3)
    assert.equal(manifest.verifiedLotRecords[0].groupRealizedPnlUsd, 60, 'the frozen group PnL is a 3x under-count of the real $180')
    assert.equal(manifest.realizedPnlUsd, 60)

    // The audit names it, with the real numbers and the real direction. `schemaVersion: 1` here
    // represents what a genuinely OBSOLETE v1 accepted-evidence record looked like — this exact
    // per-sibling-overwrite shape is what production actually persisted before the accepted-
    // evidence-persistence follow-up task fixed the writer to aggregate before writing (bumping
    // ACCEPTED_EVIDENCE_SCHEMA_VERSION 1 -> 2); a real schema-2+ writer can no longer produce it.
    const evidenceByKey = new Map<string, AcceptedEvidenceSideTotals>()
    for (const [key, raw] of store) {
      const envelope = JSON.parse(raw) as { priceUsd: number; valueUsd: number }
      evidenceByKey.set(key, { priceUsd: envelope.priceUsd, valueUsd: envelope.valueUsd, schemaVersion: 1 })
    }
    const audit = buildCanonicalPnlDiffAudit({ currentRecords: manifest.verifiedLotRecords, previousRecords: [], evidenceByKey })

    const semantic = audit.findings.filter((f) => f.code === 'price_usd_confused_with_total_transaction_value')
    assert.equal(semantic.length, 2, 'both the entry and exit side of the under-counted group are flagged')
    const entryFinding = semantic.find((f) => f.evidenceKey?.includes(':entry:'))!
    assert.equal(entryFinding.observedUsd, 100, 'the manifest claims one lot\'s value for the whole 3-lot group')
    assert.equal(entryFinding.expectedUsd, 300, 'the correct per-lot restore is 3 x 100')
    assert.equal(entryFinding.differenceUsd, -200)
    const exitFinding = semantic.find((f) => f.evidenceKey?.includes(':exit:'))!
    assert.equal(exitFinding.observedUsd, 160)
    assert.equal(exitFinding.expectedUsd, 480)
    assert.equal(exitFinding.differenceUsd, -320)
  })

  // VV6 AUDIT-CONSISTENCY FOLLOW-UP TASK — required regression: a CRITICAL audit result must never
  // coexist with a public verified publish. Once the confirmed false-positive source is fixed
  // (stablecoin normalization awareness), a correctly-normalized stablecoin lot must produce BOTH
  // zero critical findings from this audit AND a real, independent 'applied' outcome from
  // replayManifest — the two systems must agree, never one silently publishing while the other
  // still screams CRITICAL.
  it('HARD ASSERTION (required regression): a correctly vv6-normalized stablecoin lot produces zero CRITICAL findings, in agreement with a real, independently-successful manifest replay', async () => {
    const store = new Map<string, string>()
    const kv: AcceptedEvidenceKvLike = {
      get: async <T>(key: string) => (store.has(key) ? (JSON.parse(store.get(key)!) as T) : null),
      set: async (key: string, value: unknown) => { store.set(key, JSON.stringify(value)); return 'OK' },
    }
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const stableLot = lot({
      lotId: 'stable', token: BASE_USDC, openedTxHash: '0xstablebuy', closedTxHash: '0xstablesell',
      openedAt: 100, closedAt: 200, amount: 1194.1715, costBasisUsd: 1194.1715, proceedsUsd: 1194.1715, realizedPnlUsd: 0,
    })
    // Seed the STALE, mispriced accepted evidence — the exact confirmed production shape ($5.985462
    // instead of the correct $1194.1715 at $1/token).
    for (const side of ['entry', 'exit'] as const) {
      const identity = {
        chain: stableLot.chain, token: stableLot.token, txHash: side === 'entry' ? stableLot.openedTxHash : stableLot.closedTxHash,
        side, timestamp: side === 'entry' ? stableLot.openedAt : stableLot.closedAt, lotIdentityVersion: lotIdentityVersion(stableLot),
      }
      await kv.set(buildAcceptedEvidenceKey(identity), buildAcceptedEvidenceEnvelope({
        identity, priceUsd: 5.985462, valueUsd: 5.985462,
        source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, now: NOW,
      }))
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
        : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)
    const computeFingerprints = (lots: readonly MatchedLot[], realizedPnlUsd: number | null) => {
      const a = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
      return {
        verifiedLotIdentityFingerprint: a.verifiedLotIdentityFingerprint,
        acceptedHistoricalPriceFingerprint: a.acceptedHistoricalPriceFingerprint,
        realizedPnlFingerprint: a.realizedPnlFingerprint,
        scanFingerprint: a.scanFingerprint,
      }
    }
    const identity = buildManifestIdentity({ walletAddress: '0xw', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp-stable' })
    const manifest = await buildManifestFromCandidate({
      identity, allCandidateLots: [stableLot], candidateVerifiedLots: [stableLot], structuralLotCount: 1,
      fingerprints: computeFingerprints([stableLot], null), realizedPnlUsd: null,
      verifiedPricingCoverage: 1, now: 1, loadEvidence: loader, computeFingerprints,
    })
    assert.equal(manifest.verifiedLotRecords[0].groupCostBasisUsd, 1194.1715, 'the manifest stores the normalized total, not the stale evidence figure')

    // The audit, wired with the SAME real isStablecoin predicate/amount data a real scan supplies.
    const evidenceByKey = new Map<string, AcceptedEvidenceSideTotals>()
    for (const [key, raw] of store) {
      const envelope = JSON.parse(raw) as { priceUsd: number; valueUsd: number }
      evidenceByKey.set(key, { priceUsd: envelope.priceUsd, valueUsd: envelope.valueUsd, schemaVersion: 2 })
    }
    const amountByGroupKey = new Map([[manifest.verifiedLotRecords[0].key, stableLot.amount]])
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: manifest.verifiedLotRecords, previousRecords: [], evidenceByKey,
      isStablecoin: (_chain, token) => token.toLowerCase() === BASE_USDC.toLowerCase(),
      amountByGroupKey,
    })
    assert.equal(audit.findings.filter((f) => f.severity === 'critical').length, 0, 'a correctly normalized stablecoin lot must never be flagged CRITICAL')

    // AGREEMENT, PROVEN: a real, independent replay of the SAME manifest also succeeds — the audit's
    // "no critical findings" and the actual publish path's "applied" outcome are not two unrelated
    // claims, they describe the same real, valid data.
    const replay = await replayManifest({ manifest, allCandidateLots: [stableLot], loadEvidence: loader, computeFingerprints })
    assert.equal(replay.outcome, 'applied')
    assert.equal(replay.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 1)
  })
})

describe('canonicalPnlDiffAudit — logging', () => {
  function captureLogger() {
    const warns: unknown[][] = []
    const errors: unknown[][] = []
    return { warns, errors, warn: (...a: unknown[]) => { warns.push(a) }, error: (...a: unknown[]) => { errors.push(a) } }
  }

  it('logs a bounded summary plus the top causes, and never one line per lot', () => {
    const previous = Array.from({ length: 200 }, (_, i) => record({ key: `g:${i}`, groupRealizedPnlUsd: 0 }))
    const current = Array.from({ length: 200 }, (_, i) => record({ key: `g:${i}`, groupRealizedPnlUsd: i }))
    const logger = captureLogger()
    logCanonicalPnlDiffAudit(buildCanonicalPnlDiffAudit({ currentRecords: current, previousRecords: previous }), logger)
    assert.equal(logger.warns.length, 2, 'exactly one summary line and one top-causes line, never 200')
    assert.equal(logger.warns[0][0], '[canonical-pnl-diff-audit] summary')
    const causes = (logger.warns[1][1] as { causes: unknown[] }).causes
    assert.equal(causes.length, CANONICAL_PNL_DIFF_TOP_CAUSES)
  })

  it('a critical value-semantics finding is logged at error severity', () => {
    const logger = captureLogger()
    const audit = buildCanonicalPnlDiffAudit({
      currentRecords: [record({ occurrenceCount: 3, groupCostBasisUsd: 100, groupProceedsUsd: 160 })],
      previousRecords: [],
      evidenceByKey: new Map([
        ['v1:accepted-evidence:base:0xtoken:0xbuy:entry:1', { priceUsd: 100, valueUsd: 200, schemaVersion: 1 }],
        ['v1:accepted-evidence:base:0xtoken:0xsell:exit:2', { priceUsd: 160, valueUsd: 320, schemaVersion: 1 }],
      ]),
    })
    logCanonicalPnlDiffAudit(audit, logger)
    assert.equal(logger.errors.length, 1)
    assert.equal(logger.errors[0][0], 'CRITICAL canonical_pnl_value_semantics_violation')
  })

  it('an unchanged, clean audit logs only the summary and never an error', () => {
    const logger = captureLogger()
    const same = [record({ key: 'g:1', groupRealizedPnlUsd: 5 })]
    logCanonicalPnlDiffAudit(buildCanonicalPnlDiffAudit({ currentRecords: same, previousRecords: same }), logger)
    assert.equal(logger.warns.length, 1, 'no top-causes line when nothing changed')
    assert.equal(logger.errors.length, 0)
  })
})

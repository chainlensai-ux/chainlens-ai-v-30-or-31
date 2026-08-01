// TESTS — pricingAtTimeEngine: success-probability-weighted historical-pricing scheduling.
//
// Companion to completionYieldScheduler.test.ts (which covers the UNWEIGHTED structural selection).
// Everything here concerns the added term: expectedLotsCompleted x sourceSuccessProbability /
// estimatedCost, and the invariants the task requires it to preserve.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  annotateRequirement,
  annotateSuccessWeighting,
  selectBySuccessWeightedYield,
  selectByCompletionYield,
  computeSuccessWeightedComparison,
  FAIRNESS_FLOOR_PER_TOKEN,
  type SchedulerLotRef,
  type SchedulerRequirement,
} from './completionYieldScheduler'
import {
  recordPricingAttemptOutcome,
  resetSourceSuccessEvidence,
  snapshotSourceSuccessEvidence,
  emptySourceSuccessEvidence,
  routeSourceOrderFor,
  type PricingSourceName,
} from './sourceSuccessEvidence'
import type { PriceableEntry } from './types'

const CHAIN = 'base' as const
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TOKEN_C = '0xcccccccccccccccccccccccccccccccccccccccc'

function entry(overrides: Partial<PriceableEntry> & { txHash: string; token: string }): PriceableEntry {
  return { chain: CHAIN, timestamp: 1000, amount: '1', ...overrides }
}

function lot(o: { lotId: string; token: string; openedTxHash: string; closedTxHash: string }): SchedulerLotRef {
  return { chain: CHAIN, ...o }
}

function txKey(txHash: string): string {
  return `${CHAIN}:${txHash.toLowerCase()}`
}

function annotate(
  e: PriceableEntry,
  list: 'buy' | 'sell',
  lots: SchedulerLotRef[],
  verifiedQuoteTxHashes: ReadonlySet<string> = new Set(),
): SchedulerRequirement {
  const lotsByOpenKey = new Map<string, SchedulerLotRef[]>()
  const lotsByCloseKey = new Map<string, SchedulerLotRef[]>()
  for (const l of lots) {
    const openKey = `${l.chain}:${l.openedTxHash.toLowerCase()}`
    const closeKey = `${l.chain}:${l.closedTxHash.toLowerCase()}`
    lotsByOpenKey.set(openKey, [...(lotsByOpenKey.get(openKey) ?? []), l])
    lotsByCloseKey.set(closeKey, [...(lotsByCloseKey.get(closeKey) ?? []), l])
  }
  return annotateRequirement({
    entry: e,
    list,
    lotsByOpenKey,
    lotsByCloseKey,
    alreadyResolvedKeys: new Set(),
    verifiedQuoteTxHashes,
  })
}

// Builds a requirement that genuinely completes one lot outright (opposite side verified).
function completingRequirement(token: string, openTx: string, closeTx: string, lotId: string): SchedulerRequirement {
  const l = lot({ lotId, token, openedTxHash: openTx, closedTxHash: closeTx })
  return annotate(entry({ txHash: openTx, token }), 'buy', [l], new Set([txKey(closeTx)]))
}

function killSourcesFor(token: string, times = 10, reason: string | null = 'no_pool'): void {
  for (const source of routeSourceOrderFor(CHAIN)) {
    for (let i = 0; i < times; i += 1) {
      recordPricingAttemptOutcome({
        chain: CHAIN, token, source: source as PricingSourceName,
        assetClass: 'other', requirementType: 'entry', ok: false, reason,
      })
    }
  }
}

function proveSourcesFor(token: string, times = 10): void {
  for (const source of routeSourceOrderFor(CHAIN)) {
    for (let i = 0; i < times; i += 1) {
      recordPricingAttemptOutcome({
        chain: CHAIN, token, source: source as PricingSourceName,
        assetClass: 'other', requirementType: 'entry', ok: true, reason: null,
      })
    }
  }
}

beforeEach(() => resetSourceSuccessEvidence())

test('the score really is expectedLots x probability / cost', () => {
  const req = completingRequirement(TOKEN_A, '0xopen', '0xclose', 'lot-1')
  const w = annotateSuccessWeighting(req, emptySourceSuccessEvidence())
  assert.equal(w.expectedLotsCompleted, 1, 'a verified-opposite-side requirement completes its lot outright')
  assert.equal(w.score, (w.expectedLotsCompleted * w.sourceSuccessProbability) / w.estimatedCu)
})

test('two structurally identical requirements are separated purely by real observed source success', () => {
  killSourcesFor(TOKEN_A)
  proveSourcesFor(TOKEN_B)
  const evidence = snapshotSourceSuccessEvidence()

  const dead = annotateSuccessWeighting(completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a'), evidence)
  const alive = annotateSuccessWeighting(completingRequirement(TOKEN_B, '0xopenB', '0xcloseB', 'lot-b'), evidence)

  assert.equal(dead.expectedLotsCompleted, alive.expectedLotsCompleted, 'structurally identical by construction')
  assert.ok(alive.score > dead.score,
    `the token whose sources actually answer must outrank the one that repeatedly returns no_pool (${alive.score} vs ${dead.score})`)
})

test('a proven-dead requirement loses its slot to a proven-live one under a budget of 1', () => {
  killSourcesFor(TOKEN_A)
  proveSourcesFor(TOKEN_B)
  const evidence = snapshotSourceSuccessEvidence()

  const requirements = [
    completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a'),
    completingRequirement(TOKEN_B, '0xopenB', '0xcloseB', 'lot-b'),
  ]
  const result = selectBySuccessWeightedYield(requirements, 1, evidence)
  assert.equal(result.selected.length, 1)
  assert.equal(result.selected[0].requirement.entry.token, TOKEN_B)
})

test('SPEC RULE: verified immediate-completion requirements remain highest-value structurally, even with worse odds', () => {
  // The completing requirement's sources are heavily discounted; the non-completing one's are proven.
  killSourcesFor(TOKEN_A)
  proveSourcesFor(TOKEN_B)
  const evidence = snapshotSourceSuccessEvidence()

  const completing = completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a')
  // No lot at all — structurally the weakest class, however good its odds.
  const nonCompleting = annotate(entry({ txHash: '0xloose', token: TOKEN_B }), 'buy', [])

  const result = selectBySuccessWeightedYield([nonCompleting, completing], 1, evidence)
  assert.equal(result.selected.length, 1)
  assert.equal(result.selected[0].requirement.entry.token, TOKEN_A,
    'structural precedence must not be overridable by probability alone')
})

test('SPEC RULE: a permanent negative-cache / token_not_found requirement is skipped, never merely discounted', () => {
  recordPricingAttemptOutcome({
    chain: CHAIN, token: TOKEN_A, source: 'geckoterminal',
    assetClass: 'other', requirementType: 'entry', ok: false, reason: 'token_not_found',
  })
  const evidence = snapshotSourceSuccessEvidence()

  const doomed = completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a')
  const fine = completingRequirement(TOKEN_B, '0xopenB', '0xcloseB', 'lot-b')

  // Budget of 2 — room for both; the doomed one must STILL be skipped, not merely ranked last.
  const result = selectBySuccessWeightedYield([doomed, fine], 2, evidence)
  assert.equal(result.selected.length, 1)
  assert.equal(result.selected[0].requirement.entry.token, TOKEN_B)
  assert.equal(result.skippedHardFailures.length, 1)
  assert.equal(result.skippedHardFailures[0].requirement.entry.token, TOKEN_A)
})

test('SPEC RULE: no_pool discounts but never skips — a no_pool token is still selectable when budget allows', () => {
  killSourcesFor(TOKEN_A, 10, 'no_pool')
  const evidence = snapshotSourceSuccessEvidence()
  const req = completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a')
  const result = selectBySuccessWeightedYield([req], 1, evidence)
  assert.equal(result.skippedHardFailures.length, 0, 'no_pool is venue/time specific — it must never hard-skip')
  assert.equal(result.selected.length, 1)
  assert.ok(result.selected[0].sourceSuccessProbability < 0.5, 'but it must be genuinely discounted')
})

test('SPEC RULE: an unseen requirement gets the deterministic fallback and ranks between proven-good and proven-bad', () => {
  killSourcesFor(TOKEN_A)
  proveSourcesFor(TOKEN_B)
  const evidence = snapshotSourceSuccessEvidence()

  const bad = annotateSuccessWeighting(completingRequirement(TOKEN_A, '0xa', '0xa2', 'l-a'), evidence)
  const good = annotateSuccessWeighting(completingRequirement(TOKEN_B, '0xb', '0xb2', 'l-b'), evidence)
  const unseen = annotateSuccessWeighting(completingRequirement(TOKEN_C, '0xc', '0xc2', 'l-c'), evidence)

  assert.ok(unseen.score > bad.score && unseen.score < good.score,
    `unseen (${unseen.score}) must sit between proven-bad (${bad.score}) and proven-good (${good.score})`)
})

test('SPEC RULE: the total budget is never grown — the weighted selection never exceeds the budget given', () => {
  const requirements = Array.from({ length: 30 }, (_, i) =>
    completingRequirement(`0x${String(i).padStart(40, '0')}`, `0xopen${i}`, `0xclose${i}`, `lot-${i}`))
  const budget = 7
  const result = selectBySuccessWeightedYield(requirements, budget, emptySourceSuccessEvidence())
  assert.equal(result.selected.length, budget)
})

test('SPEC RULE: the fairness cap is unchanged — one token can never exceed FAIRNESS_FLOOR_PER_TOKEN', () => {
  const requirements = Array.from({ length: FAIRNESS_FLOOR_PER_TOKEN + 6 }, (_, i) =>
    completingRequirement(TOKEN_A, `0xopen${i}`, `0xclose${i}`, `lot-${i}`))
  const result = selectBySuccessWeightedYield(requirements, 100, emptySourceSuccessEvidence())
  assert.equal(result.selected.length, FAIRNESS_FLOOR_PER_TOKEN)
  assert.equal(result.skippedByFairnessCap.length, 6)
})

test('selection is fully deterministic — identical inputs give byte-identical output, repeatedly', () => {
  killSourcesFor(TOKEN_A)
  proveSourcesFor(TOKEN_B)
  const evidence = snapshotSourceSuccessEvidence()
  const requirements = [
    completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a'),
    completingRequirement(TOKEN_B, '0xopenB', '0xcloseB', 'lot-b'),
    completingRequirement(TOKEN_C, '0xopenC', '0xcloseC', 'lot-c'),
  ]
  const first = selectBySuccessWeightedYield(requirements, 2, evidence).selected.map((w) => w.requirement.entry.txHash)
  for (let i = 0; i < 5; i += 1) {
    const again = selectBySuccessWeightedYield(requirements, 2, evidence).selected.map((w) => w.requirement.entry.txHash)
    assert.deepEqual(again, first)
  }
})

test('selection is independent of input ORDER — shuffling the requirement list changes nothing', () => {
  killSourcesFor(TOKEN_A)
  proveSourcesFor(TOKEN_B)
  const evidence = snapshotSourceSuccessEvidence()
  const requirements = [
    completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a'),
    completingRequirement(TOKEN_B, '0xopenB', '0xcloseB', 'lot-b'),
    completingRequirement(TOKEN_C, '0xopenC', '0xcloseC', 'lot-c'),
  ]
  const forward = selectBySuccessWeightedYield(requirements, 2, evidence).selected.map((w) => w.requirement.entry.txHash)
  const reversed = selectBySuccessWeightedYield([...requirements].reverse(), 2, evidence).selected.map((w) => w.requirement.entry.txHash)
  assert.deepEqual(reversed, forward)
})

test('shadow comparison reports every required field, and the weighted selection beats the baseline on expected RESOLVED lots', () => {
  // A pool where the baseline's structural ordering would happily pick dead tokens: give the dead
  // tokens the lower (better) pairRank so the flat/structural order prefers them.
  killSourcesFor(TOKEN_A)
  const evidence = snapshotSourceSuccessEvidence()

  const requirements = [
    completingRequirement(TOKEN_A, '0xopenA1', '0xcloseA1', 'lot-a1'),
    completingRequirement(TOKEN_A, '0xopenA2', '0xcloseA2', 'lot-a2'),
    completingRequirement(TOKEN_B, '0xopenB1', '0xcloseB1', 'lot-b1'),
    completingRequirement(TOKEN_C, '0xopenC1', '0xcloseC1', 'lot-c1'),
  ]

  const { comparison } = computeSuccessWeightedComparison(requirements, 2, evidence)

  for (const field of [
    'baselineSelected', 'weightedSelected', 'overlap',
    'baselineExpectedLots', 'weightedExpectedLots',
    'baselineExpectedResolvedLots', 'weightedExpectedResolvedLots',
    'selectedBySource', 'discountedByFailureReason', 'skippedHardFailures',
    'estimatedCalls', 'estimatedCu',
  ]) {
    assert.ok(field in comparison, `missing required diagnostic field: ${field}`)
  }

  assert.equal(comparison.baselineSelected, 2)
  assert.equal(comparison.weightedSelected, 2)
  assert.ok(comparison.weightedExpectedResolvedLots >= comparison.baselineExpectedResolvedLots,
    `weighting must not reduce expected RESOLVED lots (${comparison.weightedExpectedResolvedLots} vs ${comparison.baselineExpectedResolvedLots})`)
  assert.ok(comparison.discountedByFailureReason.no_pool > 0, 'the real observed reason must be reported')
  assert.equal(comparison.selectedBySource.geckoterminal, 2, 'Base requirements are attributed to their real first source')
})

test('the shadow comparison never changes the baseline selection it is compared against', () => {
  killSourcesFor(TOKEN_A)
  const evidence = snapshotSourceSuccessEvidence()
  const requirements = [
    completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a'),
    completingRequirement(TOKEN_B, '0xopenB', '0xcloseB', 'lot-b'),
  ]
  const before = selectByCompletionYield(requirements, 1).selected.map((r) => r.entry.txHash)
  computeSuccessWeightedComparison(requirements, 1, evidence)
  const after = selectByCompletionYield(requirements, 1).selected.map((r) => r.entry.txHash)
  assert.deepEqual(after, before, 'computing the shadow must be side-effect free')
})

test('expected RESOLVED lots never double-counts a lot reachable via several selected requirements', () => {
  const shared = lot({ lotId: 'lot-shared', token: TOKEN_A, openedTxHash: '0xopen', closedTxHash: '0xclose' })
  const both = [
    annotate(entry({ txHash: '0xopen', token: TOKEN_A }), 'buy', [shared], new Set([txKey('0xclose')])),
    annotate(entry({ txHash: '0xclose', token: TOKEN_A }), 'sell', [shared], new Set([txKey('0xopen')])),
  ]
  const { comparison } = computeSuccessWeightedComparison(both, 2, emptySourceSuccessEvidence())
  assert.equal(comparison.weightedExpectedLots, 1, 'one distinct lot, however many requirements touch it')
  assert.ok(comparison.weightedExpectedResolvedLots <= 1,
    `a single lot can never contribute more than 1.0 expected completion, got ${comparison.weightedExpectedResolvedLots}`)
})

test('estimated calls and CU count only the selected requirements, and never exceed the full route per requirement', () => {
  const requirements = [
    completingRequirement(TOKEN_A, '0xopenA', '0xcloseA', 'lot-a'),
    completingRequirement(TOKEN_B, '0xopenB', '0xcloseB', 'lot-b'),
  ]
  const { comparison } = computeSuccessWeightedComparison(requirements, 1, emptySourceSuccessEvidence())
  const routeLength = routeSourceOrderFor(CHAIN).length
  assert.equal(comparison.weightedSelected, 1)
  assert.ok(comparison.estimatedCalls > 0 && comparison.estimatedCalls <= routeLength,
    `one selected requirement cannot cost more than its full route (${comparison.estimatedCalls})`)
  assert.ok(comparison.estimatedCu > 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectReceiptFetchCandidates } from './receiptAcquisition'
import type { SelectedCandidate } from './candidateSelector'

function candidate(txHash: string, priorityTier: 1 | 2 | 3 | 4 | 5): SelectedCandidate {
  return {
    chain: 'base',
    txHash,
    priorityTier,
    priorityReason: 'test',
    inferredTokenIn: '0xaaa',
    inferredTokenOut: '0xbbb',
    inferredMissingSide: 'none',
    economicValueUsd: null,
  }
}

function tier(count: number, tierNum: 1 | 2 | 3 | 4 | 5, prefix: string): SelectedCandidate[] {
  return Array.from({ length: count }, (_, i) => candidate(`${prefix}${i}`, tierNum))
}

test('quota: exactly 5 tier-3 and 5 tier-4 selected when both are abundant', () => {
  const candidates = [...tier(10, 3, 't3-'), ...tier(10, 4, 't4-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selectedByTier[3], 5)
  assert.equal(result.selectedByTier[4], 5)
  assert.equal(result.selected.length, 10)
  assert.equal(result.quotaBackfilled, 0)
  assert.equal(result.skippedByTierQuota[3], 5)
  assert.equal(result.skippedByTierQuota[4], 5)
})

test('quota fixes the exact production regression: abundant tier 3 no longer starves scarce tier 4', () => {
  // Production proof: 20 tier-3 candidates existed alongside only 3 real tier-4 candidates in a
  // scan that (under the old plain top-10 selection) took 7 tier-3 and 3 tier-4. With the 5/5
  // quota, tier 4's 3 real candidates are ALL selected (never starved down further), and tier 3
  // backfills only the genuinely unused capacity (2 slots), landing at the same 7/3 split here —
  // but for the right reason: tier 4 got everything it had, not merely "whatever was left".
  const candidates = [...tier(20, 3, 't3-'), ...tier(3, 4, 't4-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selectedByTier[4], 3) // every real tier-4 candidate is selected
  assert.equal(result.selectedByTier[3], 7) // backfilled with tier-3's own next candidates
  assert.equal(result.quotaBackfilled, 2)
  assert.equal(result.skippedByTierQuota[4], 0)
})

test('backfill: a scarce tier 3 is backfilled by an abundant tier 4', () => {
  const candidates = [...tier(2, 3, 't3-'), ...tier(20, 4, 't4-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selectedByTier[3], 2) // all of tier 3's real candidates
  assert.equal(result.selectedByTier[4], 8) // its own 5 quota + 3 backfilled from tier 3's shortfall
  assert.equal(result.quotaBackfilled, 3)
})

test('tier 1 and 2 always come first and reduce the capacity the tier-3/4 quota draws from', () => {
  const candidates = [...tier(3, 1, 't1-'), ...tier(2, 2, 't2-'), ...tier(10, 3, 't3-'), ...tier(10, 4, 't4-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selectedByTier[1], 3)
  assert.equal(result.selectedByTier[2], 2)
  // Only 5 slots remain (10 - 3 - 2) for tier 3/4 combined — quota shrinks accordingly.
  assert.equal(result.selectedByTier[3] + result.selectedByTier[4], 5)
  assert.equal(result.selected.length, 10)
})

test('tier 1/2 can consume the entire cap, leaving zero for tiers 3/4/5', () => {
  const candidates = [...tier(12, 1, 't1-'), ...tier(5, 3, 't3-'), ...tier(5, 4, 't4-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selectedByTier[1], 10)
  assert.equal(result.selectedByTier[3], 0)
  assert.equal(result.selectedByTier[4], 0)
  assert.equal(result.selected.length, 10)
})

test('tier 5 fills any capacity left over after tiers 1-4 are exhausted', () => {
  const candidates = [...tier(1, 3, 't3-'), ...tier(1, 4, 't4-'), ...tier(20, 5, 't5-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selectedByTier[3], 1)
  assert.equal(result.selectedByTier[4], 1)
  assert.equal(result.selectedByTier[5], 8)
  assert.equal(result.selected.length, 10)
})

test('unchanged 10-call cap: total selected never exceeds maxLiveCalls regardless of tier abundance', () => {
  const candidates = [...tier(50, 1, 't1-'), ...tier(50, 3, 't3-'), ...tier(50, 4, 't4-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selected.length, 10)
})

test('preserves within-tier ordering (economic-value/tie-break order set upstream by candidateSelector)', () => {
  const t3 = tier(7, 3, 't3-')
  const t4 = tier(7, 4, 't4-')
  const result = selectReceiptFetchCandidates([...t3, ...t4], 10)
  assert.deepEqual(result.selected.filter((c) => c.priorityTier === 3).map((c) => c.txHash), t3.slice(0, 5).map((c) => c.txHash))
  assert.deepEqual(result.selected.filter((c) => c.priorityTier === 4).map((c) => c.txHash), t4.slice(0, 5).map((c) => c.txHash))
})

test('deterministic: identical input produces an identical selection across repeated calls (no rotation)', () => {
  const candidates = [...tier(20, 3, 't3-'), ...tier(3, 4, 't4-')]
  const r1 = selectReceiptFetchCandidates(candidates, 10)
  const r2 = selectReceiptFetchCandidates(candidates, 10)
  assert.deepEqual(r1, r2)
  const r3 = selectReceiptFetchCandidates(candidates, 10)
  assert.deepEqual(r1.selected.map((c) => c.txHash), r3.selected.map((c) => c.txHash))
})

test('no candidates in tier 3 or 4 at all: capacity flows entirely to tier 1/2/5', () => {
  const candidates = [...tier(2, 1, 't1-'), ...tier(30, 5, 't5-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selectedByTier[1], 2)
  assert.equal(result.selectedByTier[3], 0)
  assert.equal(result.selectedByTier[4], 0)
  assert.equal(result.selectedByTier[5], 8)
  assert.equal(result.quotaBackfilled, 0)
})

test('fewer total candidates than the cap: selection just takes everything, no phantom backfill', () => {
  const candidates = [...tier(2, 3, 't3-'), ...tier(1, 4, 't4-')]
  const result = selectReceiptFetchCandidates(candidates, 10)
  assert.equal(result.selected.length, 3)
  assert.equal(result.selectedByTier[3], 2)
  assert.equal(result.selectedByTier[4], 1)
  assert.equal(result.quotaBackfilled, 0)
})

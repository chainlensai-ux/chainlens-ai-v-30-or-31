// Tests for adaptFifoMatchedLots() — the pure canonical-FIFO-to-VerifiedTradeEvidence adapter.
// NOT wired into `npm test`. Run with:
//   npx tsx --test lib/engine/modules/smartMoney/adaptFifoMatchedLots.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adaptFifoMatchedLots } from './adaptFifoMatchedLots'
import { computeSmartMoneyScore, MIN_COVERAGE_PERCENT_FOR_OFFICIAL } from './computeSmartMoneyScore'
import type { MatchedLot } from '@/src/modules/fifoEngine/types'

const DAY = 86_400_000
const NOW = Date.now()

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: `lot-${Math.random()}`, token: '0xtoken', chain: 'base',
    openedAt: NOW - 10 * DAY, closedAt: NOW - 5 * DAY,
    openedTxHash: '0xopen', closedTxHash: '0xclose',
    amount: 1, costBasisUsd: 100, proceedsUsd: 120, realizedPnlUsd: 20,
    evidenceQuality: 'verified',
    ...overrides,
  }
}

test('219 structural lots + 10 verified lots => 10 verified trades and ~4.57% coverage', () => {
  const verified = Array.from({ length: 10 }, (_, i) => lot({ lotId: `v${i}`, closedTxHash: `0xclose${i}` }))
  const unpriced = Array.from({ length: 209 }, (_, i) =>
    lot({ lotId: `u${i}`, closedTxHash: `0xuclose${i}`, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }))
  const result = adaptFifoMatchedLots([...verified, ...unpriced])
  assert.ok(result != null)
  assert.equal(result!.verifiedTrades.length, 10)
  assert.equal(result!.structuralClosedLotCount, 219)

  const score = computeSmartMoneyScore({ trades: result!.verifiedTrades, structuralClosedLotCount: result!.structuralClosedLotCount })
  assert.equal(score.evidenceConfidence.fullyPricedTradeCount, 10)
  assert.equal(score.evidenceConfidence.totalMatchedLotCount, 219)
  assert.ok(Math.abs((score.evidenceConfidence.verifiedCoveragePercent ?? 0) - 4.5662) < 0.01)
})

test('official score remains locked below 50% coverage even though 10 verified trades clears the sample-size bar', () => {
  const verified = Array.from({ length: 10 }, (_, i) => lot({ lotId: `v${i}`, closedTxHash: `0xclose${i}` }))
  const unpriced = Array.from({ length: 209 }, (_, i) =>
    lot({ lotId: `u${i}`, closedTxHash: `0xuclose${i}`, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }))
  const result = adaptFifoMatchedLots([...verified, ...unpriced])
  const score = computeSmartMoneyScore({ trades: result!.verifiedTrades, structuralClosedLotCount: result!.structuralClosedLotCount })
  assert.equal(score.status, 'not_yet_rated')
  assert.equal(score.officialScore, null)
  assert.ok((score.evidenceConfidence.verifiedCoveragePercent ?? 100) < MIN_COVERAGE_PERCENT_FOR_OFFICIAL)
  assert.ok(score.reasonNotRated!.includes("wallet's closed history"))
})

test('0 genuine closed lots => 0 verified trades, 0 structural count, honest empty-history state (never confused with unavailable)', () => {
  const result = adaptFifoMatchedLots([])
  assert.ok(result != null)
  assert.equal(result!.verifiedTrades.length, 0)
  assert.equal(result!.structuralClosedLotCount, 0)

  const score = computeSmartMoneyScore({ trades: result!.verifiedTrades, structuralClosedLotCount: result!.structuralClosedLotCount })
  assert.equal(score.evidenceConfidence.totalMatchedLotCount, 0)
  assert.equal(score.evidenceConfidence.verifiedCoveragePercent, 0)
  assert.equal(score.status, 'not_yet_rated')
})

test('unavailable canonical FIFO data (null) resolves to null, never a fabricated zero', () => {
  const result = adaptFifoMatchedLots(null)
  assert.equal(result, null)

  const score = computeSmartMoneyScore({ trades: [], structuralClosedLotCount: null })
  assert.equal(score.evidenceConfidence.totalMatchedLotCount, null)
  assert.equal(score.evidenceConfidence.verifiedCoveragePercent, null)
  assert.equal(score.status, 'not_yet_rated')
  assert.ok(score.reasonNotRated!.includes('unavailable'))
})

test('estimated/unpriced lots are excluded from verified trades but still counted in the structural denominator', () => {
  const verified = lot({ lotId: 'v1' })
  const unpriced = lot({ lotId: 'u1', evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null })
  const nonFiniteRealized = lot({ lotId: 'bad1', realizedPnlUsd: Number.NaN })
  const zeroCostBasis = lot({ lotId: 'bad2', costBasisUsd: 0 })
  const result = adaptFifoMatchedLots([verified, unpriced, nonFiniteRealized, zeroCostBasis])
  assert.equal(result!.verifiedTrades.length, 1)
  assert.equal(result!.structuralClosedLotCount, 4)
})

test('duplicate lots (same lotId/chain/closedTxHash) are deduped deterministically', () => {
  const original = lot({ lotId: 'dup1', closedTxHash: '0xdup' })
  const exactDuplicate = { ...original }
  const genuinelyDifferent = lot({ lotId: 'dup2', closedTxHash: '0xdup2' })
  const result = adaptFifoMatchedLots([original, exactDuplicate, genuinelyDifferent])
  assert.equal(result!.structuralClosedLotCount, 2)
  assert.equal(result!.verifiedTrades.length, 2)
})

test('enough verified coverage (>= 50%) unlocks official scoring via the adapter path', () => {
  const verified = Array.from({ length: 15 }, (_, i) => lot({
    lotId: `v${i}`, closedTxHash: `0xclose${i}`,
    closedAt: NOW - (100 - i * 7) * DAY, openedAt: NOW - (100 - i * 7 + 5) * DAY,
    realizedPnlUsd: i % 3 === 0 ? -5 : 15,
  }))
  const unpriced = Array.from({ length: 10 }, (_, i) =>
    lot({ lotId: `u${i}`, closedTxHash: `0xuclose${i}`, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }))
  const result = adaptFifoMatchedLots([...verified, ...unpriced])
  assert.equal(result!.structuralClosedLotCount, 25)
  assert.equal(result!.verifiedTrades.length, 15) // 60% coverage
  const score = computeSmartMoneyScore({ trades: result!.verifiedTrades, structuralClosedLotCount: result!.structuralClosedLotCount })
  assert.equal(score.status, 'official')
  assert.notEqual(score.officialScore, null)
})

test('deterministic adapter output: identical input always produces an identical result', () => {
  const lots = Array.from({ length: 5 }, (_, i) => lot({ lotId: `v${i}`, closedTxHash: `0xclose${i}` }))
  const a = adaptFifoMatchedLots(lots)
  const b = adaptFifoMatchedLots(lots)
  assert.deepEqual(a, b)
})

test('never fabricates timestamps: a lot with a non-finite openedAt/closedAt is excluded, not defaulted', () => {
  const badOpened = lot({ lotId: 'bad-opened', openedAt: Number.NaN })
  const badClosed = lot({ lotId: 'bad-closed', closedAt: Number.NaN })
  const closedBeforeOpened = lot({ lotId: 'bad-order', openedAt: NOW, closedAt: NOW - DAY })
  const result = adaptFifoMatchedLots([badOpened, badClosed, closedBeforeOpened])
  assert.equal(result!.verifiedTrades.length, 0)
  assert.equal(result!.structuralClosedLotCount, 3)
})

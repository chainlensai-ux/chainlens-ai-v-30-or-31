import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMissingClosedLotSides, type SwapLegGroupSummary } from './structuralCompletionSignal'

function groupKeyFor(chain: string, txHash: string): string {
  return `${chain}:${txHash.toLowerCase()}`
}

function lot(overrides: Partial<{ chain: string; openedTxHash: string; closedTxHash: string; openedAt: number; closedAt: number }>) {
  return { chain: 'base', openedTxHash: '0xopen', closedTxHash: '0xclose', openedAt: 1000, closedAt: 2000, ...overrides }
}

test('a one-leg open transaction is classified entry', () => {
  const legGroups = new Map<string, SwapLegGroupSummary>([['base:0xopen', { groupKey: 'base:0xopen', legCount: 1 }]])
  const result = computeMissingClosedLotSides([lot({})], legGroups, groupKeyFor)
  assert.equal(result.get('base:0xopen'), 'entry')
  assert.equal(result.has('base:0xclose'), false)
})

test('a one-leg close transaction is classified exit', () => {
  const legGroups = new Map<string, SwapLegGroupSummary>([['base:0xclose', { groupKey: 'base:0xclose', legCount: 1 }]])
  const result = computeMissingClosedLotSides([lot({})], legGroups, groupKeyFor)
  assert.equal(result.get('base:0xclose'), 'exit')
  assert.equal(result.has('base:0xopen'), false)
})

test('a two-leg transaction (both sides already known) is never classified as missing', () => {
  const legGroups = new Map<string, SwapLegGroupSummary>([
    ['base:0xopen', { groupKey: 'base:0xopen', legCount: 2 }],
    ['base:0xclose', { groupKey: 'base:0xclose', legCount: 2 }],
  ])
  const result = computeMissingClosedLotSides([lot({})], legGroups, groupKeyFor)
  assert.equal(result.size, 0)
})

test('a transaction absent from the leg-group map is never classified (never fabricated)', () => {
  const result = computeMissingClosedLotSides([lot({})], new Map(), groupKeyFor)
  assert.equal(result.size, 0)
})

test('a transaction that is simultaneously an open and a close keeps its first, deterministic classification', () => {
  const legGroups = new Map<string, SwapLegGroupSummary>([['base:0xshared', { groupKey: 'base:0xshared', legCount: 1 }]])
  const lots = [
    lot({ openedTxHash: '0xshared', closedTxHash: '0xclose-a', openedAt: 500, closedAt: 1500 }),
    lot({ openedTxHash: '0xopen-b', closedTxHash: '0xshared', openedAt: 1000, closedAt: 2000 }),
  ]
  const result = computeMissingClosedLotSides(lots, legGroups, groupKeyFor)
  // Sorted by openedAt ascending: the first lot (openedAt 500) processes its OPEN side ('entry') first.
  assert.equal(result.get('base:0xshared'), 'entry')
})

test('deterministic regardless of input lot order', () => {
  const legGroups = new Map<string, SwapLegGroupSummary>([
    ['base:0xopen1', { groupKey: 'base:0xopen1', legCount: 1 }],
    ['base:0xopen2', { groupKey: 'base:0xopen2', legCount: 1 }],
  ])
  const lotA = lot({ openedTxHash: '0xopen1', closedTxHash: '0xclose1', openedAt: 100, closedAt: 200 })
  const lotB = lot({ openedTxHash: '0xopen2', closedTxHash: '0xclose2', openedAt: 300, closedAt: 400 })
  const forward = computeMissingClosedLotSides([lotA, lotB], legGroups, groupKeyFor)
  const reversed = computeMissingClosedLotSides([lotB, lotA], legGroups, groupKeyFor)
  assert.deepEqual([...forward.entries()].sort(), [...reversed.entries()].sort())
})

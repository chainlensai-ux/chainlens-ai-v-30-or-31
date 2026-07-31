import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  annotateRequirement, selectByFlatCap, selectByCompletionYield, computeSchedulerComparison,
  FAIRNESS_FLOOR_PER_TOKEN, type SchedulerLotRef, type SchedulerRequirement,
} from './completionYieldScheduler'
import type { PriceableEntry } from './types'

const CHAIN = 'base' as const
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

function entry(overrides: Partial<PriceableEntry> & { txHash: string; token: string }): PriceableEntry {
  return { chain: CHAIN, timestamp: 1000, amount: '1', ...overrides }
}

function lot(overrides: Partial<SchedulerLotRef> & { lotId: string; openedTxHash: string; closedTxHash: string; token: string }): SchedulerLotRef {
  return { chain: CHAIN, ...overrides }
}

function buildLotMaps(lots: SchedulerLotRef[]) {
  const lotsByOpenKey = new Map<string, SchedulerLotRef[]>()
  const lotsByCloseKey = new Map<string, SchedulerLotRef[]>()
  for (const l of lots) {
    const openKey = `${l.chain}:${l.openedTxHash.toLowerCase()}`
    const closeKey = `${l.chain}:${l.closedTxHash.toLowerCase()}`
    lotsByOpenKey.set(openKey, [...(lotsByOpenKey.get(openKey) ?? []), l])
    lotsByCloseKey.set(closeKey, [...(lotsByCloseKey.get(closeKey) ?? []), l])
  }
  return { lotsByOpenKey, lotsByCloseKey }
}

// verifiedQuoteTxHashes: real per-transaction evidence of "this transaction already has a same-tx
// verified stablecoin/native/WETH quote leg" — the SAME real signal priceLotsForWallet.ts computes
// from swapLegsByTx/isVerifiedQuoteLegAddress (see the AUDIT FIX in completionYieldScheduler.ts's own
// header — a lot's own traded token is never the quote currency, so this must be checked at the
// TRANSACTION level, never derived from the lot's own token identity).
function annotate(
  e: PriceableEntry,
  list: 'buy' | 'sell',
  lots: SchedulerLotRef[],
  opts: { alreadyResolvedKeys?: ReadonlySet<string>; verifiedQuoteTxHashes?: ReadonlySet<string> } = {},
): SchedulerRequirement {
  const { lotsByOpenKey, lotsByCloseKey } = buildLotMaps(lots)
  return annotateRequirement({
    entry: e,
    list,
    lotsByOpenKey,
    lotsByCloseKey,
    alreadyResolvedKeys: opts.alreadyResolvedKeys ?? new Set(),
    verifiedQuoteTxHashes: opts.verifiedQuoteTxHashes ?? new Set(),
  })
}

function txKey(chain: string, txHash: string): string {
  return `${chain}:${txHash.toLowerCase()}`
}

test('annotateRequirement: a buy entry whose lot close side has no verified quote leg is both-sides-missing', () => {
  const l = lot({ lotId: 'lot-1', token: TOKEN_A, openedTxHash: '0xopen', closedTxHash: '0xclose' })
  const buyEntry = entry({ txHash: '0xopen', token: TOKEN_A })
  const req = annotate(buyEntry, 'buy', [l])
  assert.deepEqual(req.lotIds, ['lot-1'])
  // No verifiedQuoteTxHashes entry for '0xclose' — honestly both-sides-missing, never assumed one-sided.
  assert.equal(req.oppositeSideVerified, false)
  assert.equal(req.missingSide, 'both')
})

test('AUDIT FIX: a lot whose traded token itself happens to look like a stablecoin/native address must NOT be treated as verified — only the OPPOSITE TRANSACTION\'s real quote leg counts', () => {
  // The lot's own `token` field is set to a canonical native pseudo-address here — the exact shape
  // of the original bug (checking the lot's own token identity instead of the opposite
  // transaction's real swap legs). With no verifiedQuoteTxHashes entry, this must still be
  // both-sides-missing.
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const l = lot({ lotId: 'lot-1', token: NATIVE, openedTxHash: '0xopen', closedTxHash: '0xclose' })
  const buyEntry = entry({ txHash: '0xopen', token: NATIVE })
  const req = annotate(buyEntry, 'buy', [l])
  assert.equal(req.oppositeSideVerified, false, 'the lot\'s own token identity must never substitute for real opposite-transaction evidence')
  assert.equal(req.missingSide, 'both')
})

test('annotateRequirement: a sell entry whose lot OPEN TRANSACTION has a real same-tx verified quote leg is immediately completable', () => {
  const l = lot({ lotId: 'lot-1', token: TOKEN_A, openedTxHash: '0xopen', closedTxHash: '0xclose' })
  const sellEntry = entry({ txHash: '0xclose', token: TOKEN_A })
  const verifiedQuoteTxHashes = new Set([txKey(CHAIN, '0xopen')])
  const req = annotate(sellEntry, 'sell', [l], { verifiedQuoteTxHashes })
  assert.equal(req.oppositeSideVerified, true)
  assert.equal(req.missingSide, 'exit')
})

test('annotateRequirement: a requirement not tied to any structural lot has null missingSide and empty lotIds', () => {
  const orphan = entry({ txHash: '0xnowhere', token: TOKEN_A })
  const req = annotate(orphan, 'buy', [])
  assert.deepEqual(req.lotIds, [])
  assert.equal(req.missingSide, null)
})

test('annotateRequirement: already-resolved opposite side (from an earlier scheduling round) counts as verified', () => {
  const l = lot({ lotId: 'lot-1', token: TOKEN_A, openedTxHash: '0xopen', closedTxHash: '0xclose' })
  const buyEntry = entry({ txHash: '0xopen', token: TOKEN_A })
  const resolvedKey = `${CHAIN}:${TOKEN_A.toLowerCase()}:0xclose:sell`
  const req = annotate(buyEntry, 'buy', [l], { alreadyResolvedKeys: new Set([resolvedKey]) })
  assert.equal(req.oppositeSideVerified, true)
  assert.equal(req.missingSide, 'entry')
})

// ─── PRIORITY ORDERING ────────────────────────────────────────────────────────────────────────────

test('immediate lot completion outranks an unrelated (non-lot) requirement', () => {
  const l = lot({ lotId: 'lot-1', token: TOKEN_A, openedTxHash: '0xopen', closedTxHash: '0xclose' })
  const verifiedQuoteTxHashes = new Set([txKey(CHAIN, '0xopen')])
  const completable = annotate(entry({ txHash: '0xclose', token: TOKEN_A }), 'sell', [l], { verifiedQuoteTxHashes })
  const unrelated = annotate(entry({ txHash: '0xunrelated', token: TOKEN_B }), 'buy', [])
  const result = selectByCompletionYield([unrelated, completable], 1)
  assert.equal(result.selected[0], completable)
})

test('one request completing MULTIPLE lots ranks first, ahead of a single-lot completion', () => {
  const lotSingle = lot({ lotId: 'lot-single', token: TOKEN_A, openedTxHash: '0xopenA', closedTxHash: '0xclose-shared' })
  const lotMulti1 = lot({ lotId: 'lot-multi-1', token: TOKEN_B, openedTxHash: '0xopenB1', closedTxHash: '0xclose-shared-2' })
  const lotMulti2 = lot({ lotId: 'lot-multi-2', token: TOKEN_B, openedTxHash: '0xopenB2', closedTxHash: '0xclose-shared-2' })

  const verifiedQuoteTxHashes = new Set([txKey(CHAIN, '0xopenA'), txKey(CHAIN, '0xopenB1'), txKey(CHAIN, '0xopenB2')])
  const singleReq = annotate(entry({ txHash: '0xclose-shared', token: TOKEN_A }), 'sell', [lotSingle], { verifiedQuoteTxHashes })
  const multiReq = annotate(entry({ txHash: '0xclose-shared-2', token: TOKEN_B }), 'sell', [lotMulti1, lotMulti2], { verifiedQuoteTxHashes })

  const result = selectByCompletionYield([singleReq, multiReq], 2)
  assert.equal(result.selected[0], multiReq)
  assert.equal(result.selected[1], singleReq)
})

test('one-side-missing outranks both-sides-missing', () => {
  const l1 = lot({ lotId: 'lot-1', token: TOKEN_A, openedTxHash: '0xopen1', closedTxHash: '0xclose1' })
  const l2 = lot({ lotId: 'lot-2', token: TOKEN_B, openedTxHash: '0xopen2', closedTxHash: '0xclose2' })
  // oneSided: opposite (close) TRANSACTION has a real verified quote leg — real one-side-missing shape.
  const oneSided = annotate(entry({ txHash: '0xopen1', token: TOKEN_A }), 'buy', [l1], { verifiedQuoteTxHashes: new Set([txKey(CHAIN, '0xclose1')]) })
  // bothSided: opposite (close) transaction has no verified quote leg — real both-sides-missing shape.
  const bothSided = annotate(entry({ txHash: '0xopen2', token: TOKEN_B }), 'buy', [l2])
  const result = selectByCompletionYield([bothSided, oneSided], 2)
  assert.equal(result.selected[0], oneSided)
  assert.equal(result.selected[1], bothSided)
})

test('native/WETH/stable requirement eligibility outranks an equally-unlotted ordinary token requirement', () => {
  const stable = annotate(entry({ txHash: '0xstable', token: USDC_BASE }), 'buy', [])
  const ordinary = annotate(entry({ txHash: '0xordinary', token: TOKEN_A }), 'buy', [])
  const result = selectByCompletionYield([ordinary, stable], 2)
  assert.equal(result.selected[0], stable)
})

test('a requirement with prior negative-cache history is skipped while real candidates remain, even if it would technically fit the budget', () => {
  const negative: SchedulerRequirement = { ...annotate(entry({ txHash: '0xneg', token: TOKEN_A }), 'buy', []), hasPriorNegativeCacheHit: true }
  const real = annotate(entry({ txHash: '0xreal', token: TOKEN_B }), 'buy', [])
  const result = selectByCompletionYield([negative, real], 2)
  assert.deepEqual(result.selected, [real])
  assert.deepEqual(result.skippedByNegativeCache, [negative])
})

// ─── FAIRNESS FLOOR ───────────────────────────────────────────────────────────────────────────────

test('a dense token CAN exceed the old flat cap of 2 when real completion yield justifies it', () => {
  // 5 distinct real lots for TOKEN_A, each immediately completable via a real verified opposite
  // transaction.
  const openTxHashes = Array.from({ length: 5 }, (_, i) => `0xopen${i}`)
  const verifiedQuoteTxHashes = new Set(openTxHashes.map((h) => txKey(CHAIN, h)))
  const requirements = openTxHashes.map((openTxHash, i) => {
    const l = lot({ lotId: `lot-${i}`, token: TOKEN_A, openedTxHash: openTxHash, closedTxHash: `0xclose${i}` })
    return annotate(entry({ txHash: `0xclose${i}`, token: TOKEN_A }), 'sell', [l], { verifiedQuoteTxHashes })
  })
  const result = selectByCompletionYield(requirements, 5)
  assert.equal(result.selected.length, 5, 'all 5 — well beyond the old flat cap of 2 — are selected when yield justifies it')
})

test('the fairness floor prevents one dense token from consuming the entire budget', () => {
  const denseCount = FAIRNESS_FLOOR_PER_TOKEN + 10
  const denseOpenTxHashes = Array.from({ length: denseCount }, (_, i) => `0xdopen${i}`)
  const verifiedQuoteTxHashes = new Set([...denseOpenTxHashes.map((h) => txKey(CHAIN, h)), txKey(CHAIN, '0xopenOther')])
  const denseTokenRequirements = denseOpenTxHashes.map((openTxHash, i) => {
    const l = lot({ lotId: `dense-lot-${i}`, token: TOKEN_A, openedTxHash: openTxHash, closedTxHash: `0xdclose${i}` })
    return annotate(entry({ txHash: `0xdclose${i}`, token: TOKEN_A }), 'sell', [l], { verifiedQuoteTxHashes })
  })
  const otherTokenRequirement = (() => {
    const l = lot({ lotId: 'other-lot', token: TOKEN_B, openedTxHash: '0xopenOther', closedTxHash: '0xcloseOther' })
    return annotate(entry({ txHash: '0xcloseOther', token: TOKEN_B }), 'sell', [l], { verifiedQuoteTxHashes })
  })()

  const result = selectByCompletionYield([...denseTokenRequirements, otherTokenRequirement], denseTokenRequirements.length + 1)
  const selectedDense = result.selected.filter((r) => r.entry.token === TOKEN_A)
  assert.equal(selectedDense.length, FAIRNESS_FLOOR_PER_TOKEN, 'the dense token is capped at the fairness floor, never unbounded')
  assert.ok(result.selected.includes(otherTokenRequirement), 'the other token still gets its real budget slot')
  assert.ok(result.skippedByFairnessCap.length >= 1)
})

// ─── DETERMINISM AND BUDGET PARITY ───────────────────────────────────────────────────────────────

test('deterministic under shuffled requirement order', () => {
  const openTxHashes = Array.from({ length: 12 }, (_, i) => `0xopen${i}`)
  const verifiedQuoteTxHashes = new Set(openTxHashes.map((h) => txKey(CHAIN, h)))
  const requirements = openTxHashes.map((openTxHash, i) => {
    const token = i % 2 === 0 ? TOKEN_A : TOKEN_B
    const l = lot({ lotId: `lot-${i}`, token, openedTxHash: openTxHash, closedTxHash: `0xclose${i}` })
    return annotate(entry({ txHash: `0xclose${i}`, token }), 'sell', [l], { verifiedQuoteTxHashes })
  })
  const shuffled = [requirements[7], requirements[2], requirements[11], requirements[0], requirements[5], requirements[9], ...requirements.slice(1, 12).filter((_, i) => ![7, 2, 11, 0, 5, 9].includes(i + 1))]
  const a = selectByCompletionYield(requirements, 6)
  const b = selectByCompletionYield(shuffled, 6)
  assert.deepEqual(
    a.selected.map((r) => r.entry.txHash).sort(),
    b.selected.map((r) => r.entry.txHash).sort(),
  )
})

test('the yield selection never exceeds the same total budget the flat-cap selection would have used', () => {
  const requirements = Array.from({ length: 40 }, (_, i) => annotate(entry({ txHash: `0x${i}`, token: i % 5 === 0 ? TOKEN_A : TOKEN_B }), 'buy', []))
  const { existing, yieldSelection } = computeSchedulerComparison(requirements, 2)
  assert.ok(yieldSelection.selected.length <= existing.length)
})

test('computeSchedulerComparison reports the exact shadow fields with no provider call made', () => {
  const l = lot({ lotId: 'lot-1', token: TOKEN_A, openedTxHash: '0xopen', closedTxHash: '0xclose' })
  const verifiedQuoteTxHashes = new Set([txKey(CHAIN, '0xclose')])
  const req = annotate(entry({ txHash: '0xopen', token: TOKEN_A }), 'buy', [l], { verifiedQuoteTxHashes })
  const { comparison } = computeSchedulerComparison([req], 2)
  assert.equal(comparison.existingSelectedCount, 1)
  assert.equal(comparison.yieldSelectedCount, 1)
  assert.equal(comparison.overlapCount, 1)
  assert.equal(comparison.estimatedCalls, 1)
  assert.equal(comparison.estimatedCu, 1)
  assert.ok(typeof comparison.selectedByToken === 'object')
})

test('selectByFlatCap replicates the real, existing pairRank + flat per-token-cap rule', () => {
  const a1 = annotate(entry({ txHash: '0xa1', token: TOKEN_A, pairRank: 0 }), 'buy', [])
  const a2 = annotate(entry({ txHash: '0xa2', token: TOKEN_A, pairRank: 1 }), 'buy', [])
  const a3 = annotate(entry({ txHash: '0xa3', token: TOKEN_A, pairRank: 2 }), 'buy', [])
  const selected = selectByFlatCap([a3, a1, a2], 2)
  assert.deepEqual(selected.map((r) => r.entry.txHash), ['0xa1', '0xa2'])
})

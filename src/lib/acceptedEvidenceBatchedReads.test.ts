// Accepted-evidence reads on the scan's hot path go through MGET batches, not one GET per side, and
// give exactly the same answers as the single-key readers.
//   npx tsx --test src/lib/acceptedEvidenceBatchedReads.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAcceptedEvidenceEnvelope, createMemoizedAcceptedEvidenceLoader, lotIdentityVersion, writeAcceptedEvidence,
  type AcceptedEvidenceKvLike,
} from '@/src/lib/acceptedEvidenceStore'
import { createPnlReconciliation } from '@/src/lib/pnlReconciliation'
import { emptyUnrealizedReconciliation, type FifoOutput, type MatchedLot } from '@/src/modules/fifoEngine/types'

function countingKv() {
  const store = new Map<string, unknown>()
  const calls = { get: 0, mget: 0 }
  const kv: AcceptedEvidenceKvLike = {
    get: async <T,>(key: string) => { calls.get += 1; return (store.get(key) as T) ?? null },
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    mget: async (...keys: string[]) => { calls.mget += 1; return keys.map((key) => store.get(key) ?? null) },
  }
  return { kv, calls, store }
}

const lot = (i: number, over: Partial<MatchedLot> = {}): MatchedLot => ({
  lotId: `lot-${i}`, token: '0xtoken', chain: 'base', openedAt: 1_000 + i, closedAt: 2_000 + i,
  openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, amount: 1 + i, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2,
  evidenceQuality: 'verified', ...over,
})

describe('batched accepted-evidence reads', () => {
  it('a primed memo loader answers strict and discovery reads with no GET, identical to unprimed reads', async () => {
    const { kv, calls } = countingKv()
    const l = lot(1)
    const identity = { chain: 'base', token: '0xtoken', txHash: l.openedTxHash, side: 'entry' as const, timestamp: l.openedAt, lotIdentityVersion: lotIdentityVersion(l) }
    await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity, priceUsd: 10, valueUsd: 10, source: 'geckoterminal', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: 5_000 }))
    const missing = { ...identity, txHash: '0xnothing' }

    const unprimed = createMemoizedAcceptedEvidenceLoader(kv, 5_001)
    const expected = [await unprimed.load(identity), await unprimed.load({ ...identity, lotIdentityVersion: null }), await unprimed.load({ ...identity, lotIdentityVersion: 'wrong-version' }), await unprimed.load(missing)]
    calls.get = 0

    const primed = createMemoizedAcceptedEvidenceLoader(kv, 5_001)
    await primed.prime([identity, missing])
    const actual = [await primed.load(identity), await primed.load({ ...identity, lotIdentityVersion: null }), await primed.load({ ...identity, lotIdentityVersion: 'wrong-version' }), await primed.load(missing)]
    assert.deepEqual(actual, expected)
    assert.notEqual(actual[0], null)
    assert.equal(actual[2], null, 'strict validation still rejects a version mismatch')
    assert.equal(calls.get, 0)
    assert.equal(calls.mget, 1)
  })

  it('reconcile hydrates and seeds through MGET, never one GET per side', async () => {
    const { kv, calls } = countingKv()
    const lots = Array.from({ length: 250 }, (_, i) => lot(i))
    const fifo: FifoOutput = { matchedLots: lots, unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [], realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasisUsd: 0, publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation() }
    const pnl = { realizedPnlUsd: 0, closedLots: [], winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: null }, chainBreakdown: [], confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'low' }, evidenceMissingCount: 0 }
    const r = createPnlReconciliation({ logger: { warn() {} }, acceptedEvidenceKv: kv })
    const first = await r.reconcile({ fifoEngineResult: fifo, pnlEngineResult: pnl as never, syntheticPnlAssemblyOutput: null })
    assert.equal(calls.get, 0)
    assert.ok(calls.mget > 0 && calls.mget <= 20, `few batched reads: ${calls.mget}`)
    // The second scan hydrates every side from what the first one seeded.
    const second = await r.reconcile({ fifoEngineResult: fifo, pnlEngineResult: pnl as never, syntheticPnlAssemblyOutput: null })
    assert.equal(calls.get, 0)
    assert.equal(second.acceptedEvidenceAudit.persistedAcceptedSidesLoaded, 500)
    assert.equal(first.acceptedEvidenceAudit.persistedAcceptedSidesLoaded, 0)
  })
})

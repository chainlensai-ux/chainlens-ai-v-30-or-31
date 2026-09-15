// Regression tests for buildManifestFromCandidate's bounded-concurrency-8 evidence loading, ported
// from perf commit 7d8ad677 ("perf(wallet-scan): memoize accepted-evidence reads; bound manifest
// build loads"). The original commit's own test coverage only exercised the memoized loader
// (src/lib/acceptedEvidenceStore.test.ts) — this file adds the coverage the port task explicitly
// requires for the SECOND optimization (bounded-concurrency group loading inside
// buildManifestFromCandidate itself): concurrency never exceeds 8, the result is order-deterministic
// regardless of completion order, no extra loader calls are introduced, and a loader failure still
// fails the whole build closed — never a partial, silently-degraded manifest.
//
// Run directly with: npx tsx --test src/lib/canonicalPnlSampleManifestConcurrency.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildManifestIdentity, buildManifestFromCandidate,
  type AcceptedEvidenceLoader,
} from './canonicalPnlSampleManifest.ts'
import { buildScanDeterminismAudit } from './scanDeterminismAudit.ts'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot.ts'
import { buildAcceptedEvidenceEnvelope, type AcceptedEvidenceEnvelope } from './acceptedEvidenceStore.ts'
import type { MatchedLot } from '../modules/fifoEngine/types'

const NOW = 1_000_000
const roundCents = (n: number) => Math.round(n * 100) / 100

function identity(matchedLotFingerprint = 'fp1') {
  return buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint })
}

const computeFingerprints = (lots: readonly MatchedLot[], realizedPnlUsd: number | null) => {
  const a = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
  return {
    verifiedLotIdentityFingerprint: a.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint: a.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint: a.realizedPnlFingerprint,
    scanFingerprint: a.scanFingerprint,
  }
}

function realizedTotal(lots: readonly MatchedLot[]): number | null {
  const verified = lots.filter(isCanonicalVerifiedPublishedLot)
  return verified.length > 0 ? roundCents(verified.reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0)) : null
}

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified',
    ...overrides,
  }
}

// N distinct, fully-verified, non-overlapping lots — every lot gets its own entry AND exit group
// (distinct openedTxHash/closedTxHash), so N lots means N entry groups + N exit groups = 2N total
// loader calls, well over the concurrency-8 bound when N > 4.
function buildDistinctLots(count: number): MatchedLot[] {
  return Array.from({ length: count }, (_, i) => lot({
    lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`,
    openedAt: i, closedAt: 1000 + i, amount: 1,
    costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10,
  }))
}

function envelopeFor(lot: MatchedLot, side: 'entry' | 'exit'): AcceptedEvidenceEnvelope {
  const priceUsd = side === 'entry' ? (lot.costBasisUsd as number) : (lot.proceedsUsd as number)
  const identityRecord = {
    chain: lot.chain, token: lot.token,
    txHash: side === 'entry' ? lot.openedTxHash : lot.closedTxHash,
    side, timestamp: side === 'entry' ? lot.openedAt : lot.closedAt,
    lotIdentityVersion: '',
  }
  return buildAcceptedEvidenceEnvelope({
    identity: identityRecord, priceUsd, valueUsd: priceUsd * lot.amount,
    source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
  })
}

// Instrumented loader: resolves after a per-call artificial delay (so calls genuinely overlap in
// time rather than settling synchronously), tracks concurrent in-flight count, total call count,
// and the ORDER calls settle in — every knob the concurrency/determinism assertions below need.
function instrumentedLoader(lots: readonly MatchedLot[], opts: { delayMsFor?: (txHash: string) => number } = {}) {
  const byTxHash = new Map<string, { lot: MatchedLot; side: 'entry' | 'exit' }>()
  for (const l of lots) {
    byTxHash.set(l.openedTxHash, { lot: l, side: 'entry' })
    byTxHash.set(l.closedTxHash, { lot: l, side: 'exit' })
  }
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  const settleOrder: string[] = []
  const loader: AcceptedEvidenceLoader = (identity) => {
    calls += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    const delayMs = opts.delayMsFor?.(identity.txHash) ?? 0
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight -= 1
        settleOrder.push(identity.txHash)
        const found = byTxHash.get(identity.txHash)
        resolve(found ? envelopeFor(found.lot, found.side) : null)
      }, delayMs)
    })
  }
  return { loader, stats: () => ({ calls, maxInFlight }), settleOrder }
}

async function buildWith(lots: readonly MatchedLot[], loader: AcceptedEvidenceLoader) {
  return buildManifestFromCandidate({
    identity: identity(), allCandidateLots: lots, candidateVerifiedLots: lots.filter(isCanonicalVerifiedPublishedLot),
    structuralLotCount: lots.length, fingerprints: computeFingerprints(lots, realizedTotal(lots)),
    realizedPnlUsd: realizedTotal(lots), verifiedPricingCoverage: lots.length > 0 ? 1 : null,
    now: 1000, loadEvidence: loader, computeFingerprints,
  })
}

describe('buildManifestFromCandidate — bounded concurrency-8 evidence loading', () => {
  it('concurrency never exceeds 8, even with far more than 8 independent groups', async () => {
    const lots = buildDistinctLots(20) // 40 total entry+exit groups
    const { loader, stats } = instrumentedLoader(lots, { delayMsFor: () => 5 })
    await buildWith(lots, loader)
    assert.ok(stats().maxInFlight <= 8, `observed ${stats().maxInFlight} concurrent loads, expected <= 8`)
    assert.ok(stats().maxInFlight >= 2, 'sanity: the loads genuinely overlapped rather than running serially')
  })

  it('no provider calls added — exactly one loader call per unique entry/exit group, never more', async () => {
    const lots = buildDistinctLots(12)
    const { loader, stats } = instrumentedLoader(lots, { delayMsFor: () => 1 })
    await buildWith(lots, loader)
    // 12 distinct lots, each with its own non-shared entry + exit group = 24 unique groups.
    assert.equal(stats().calls, 24)
  })

  it('result has identical keys/values/order regardless of which jobs settle first', async () => {
    const lots = buildDistinctLots(15)
    // Loader A: first jobs finish first (ascending delay by discovery order).
    let n = 0
    const ascending = instrumentedLoader(lots, { delayMsFor: () => (n++ % 8) * 2 })
    // Loader B: deliberately reversed — later-discovered groups resolve first, forcing out-of-order
    // completion relative to the original entryGroups/exitGroups Map insertion order.
    const reversed = instrumentedLoader(lots, { delayMsFor: (txHash) => (txHash.endsWith('0') ? 20 : 1) })

    const manifestA = await buildWith(lots, ascending.loader)
    const manifestB = await buildWith(lots, reversed.loader)

    assert.notDeepEqual(ascending.settleOrder, reversed.settleOrder, 'sanity: the two runs really did settle in different orders')
    // The real invariant: whatever order the concurrent loads happen to SETTLE in, the published
    // manifest — keys, values, AND the array order itself (canonicalize -> sort -> dedupe by key,
    // see this function's own comment) — must be byte-identical, exactly as a fully serial
    // implementation (which always settles in submission order) would have produced.
    assert.deepEqual(manifestA.verifiedLotRecords, manifestB.verifiedLotRecords, 'out-of-order completion must never change the published lot records, their values, or their order')
    assert.equal(manifestA.realizedPnlUsd, manifestB.realizedPnlUsd)
    assert.equal(manifestA.acceptedHistoricalPriceFingerprint, manifestB.acceptedHistoricalPriceFingerprint)
    // The shared order is the deliberate sort-by-canonical-key this function always applies before
    // persistence (never raw completion order, and never raw allCandidateLots order either) —
    // confirms both runs converged on that SAME deterministic ordering, not merely on equal content.
    const sortedKeys = [...manifestA.verifiedLotRecords.map((r) => r.key)].sort()
    assert.deepEqual(manifestA.verifiedLotRecords.map((r) => r.key), sortedKeys)
  })

  it('matches a fully serial (zero-delay) baseline exactly — keys, values, and order', async () => {
    const lots = buildDistinctLots(9) // > 8 so the bound genuinely engages
    const serial = instrumentedLoader(lots, { delayMsFor: () => 0 })
    const overlapped = instrumentedLoader(lots, { delayMsFor: (txHash) => (txHash.endsWith('3') ? 15 : 4) })
    const serialManifest = await buildWith(lots, serial.loader)
    const overlappedManifest = await buildWith(lots, overlapped.loader)
    assert.notDeepEqual(serial.settleOrder, overlapped.settleOrder, 'sanity: the two runs really did settle in different orders')
    assert.deepEqual(overlappedManifest.verifiedLotRecords, serialManifest.verifiedLotRecords)
    assert.deepEqual(overlappedManifest, serialManifest)
  })

  it('fails closed: a loader rejection fails the whole build, never a silently partial manifest', async () => {
    const lots = buildDistinctLots(10)
    const { loader } = instrumentedLoader(lots, { delayMsFor: () => 1 })
    const failingLoader: AcceptedEvidenceLoader = (identity) => {
      if (identity.txHash === lots[5].openedTxHash) return Promise.reject(new Error('kv unavailable'))
      return loader(identity)
    }
    await assert.rejects(() => buildWith(lots, failingLoader), /kv unavailable/)
  })
})

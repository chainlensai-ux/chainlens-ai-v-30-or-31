// Canonical verified sample destroyed after pricing — regression tests.
//
// Production (runtime 35210768): pricing 10/13 verified (76.92%), canonical selection 0, dropReasons
// `canonical_selection:evidence_quality_not_verified: 10`; replay `manifestLotsStillValid: 5`,
// `manifest_exit_price_mismatch: 5`, `manifest_proceeds_mismatch: 5`; yet `[canonical-pnl-diff-audit]`
// reported realized 392.93 → 392.93 with delta 0.
//
// Root cause, reproduced below with the real FIFO engine and the real manifest build/replay:
//   1. The quality is lost in `replayManifest`, not in a copied DTO: when any manifest group fails,
//      `buildPublished(failed)` withholds EVERY verified lot (`evidenceQuality: 'unpriced'`).
//   2. The 5 failures compare a group's frozen per-FRAGMENT values against a re-allocation of the
//      AGGREGATE accepted tx-side total. FIFO prorates one tx-level USD figure per SELL EVENT, so a tx
//      with two outbound events of the token (swap + fee transfer) gives fragments that are not
//      quantity-proportional (70/20/90 for 700/200/100 units), while replay allocates the same
//      accepted total by quantity (126/36/18). The side total is identical (realized unchanged), but
//      the per-group comparison was classified `canonical_value_disagreement` (structural), which
//      also blocks the refresh that would heal it.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptedEvidenceIdentityKeysForLot,
  allocateSideValueAcrossGroup,
  applyRefreshedCanonicalManifest,
  buildCanonicalLotIdentities,
  buildManifestFromCandidate,
  buildManifestIdentity,
  buildRefreshedManifest,
  replayManifest,
  shouldRefreshPartiallyUnreproducibleManifest,
  type AcceptedEvidenceLoader,
  type CanonicalPnlSampleManifest,
} from './canonicalPnlSampleManifest.ts'
import { buildScanDeterminismAudit, sortLotsByCanonicalIdentity, sumQuantizedUsd } from './scanDeterminismAudit.ts'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot.ts'
import {
  buildAcceptedEvidenceCoverageFingerprint,
  buildAcceptedEvidenceEnvelope,
  buildAcceptedEvidenceKey,
  lotIdentityVersion,
  type AcceptedEvidenceEnvelope,
  type AcceptedEvidenceKvLike,
} from './acceptedEvidenceStore.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { MatchedLot } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'

const CLAW = '0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3'
const WALLET = `0x${'9'.repeat(40)}`

function event(txHash: string, direction: 'inbound' | 'outbound', amount: number, at: string, logIndex = 0): NormalizedEvent {
  return {
    chain: 'base', txHash, contract: CLAW, direction, amount, timestamp: at, tokenDecimals: 18,
    fromAddress: direction === 'inbound' ? '0xpool' : WALLET,
    toAddress: direction === 'inbound' ? WALLET : logIndex > 0 ? '0xfee' : '0xpool',
    amountRaw: (BigInt(Math.round(amount * 1e6)) * BigInt(10) ** BigInt(12)).toString(), logIndex,
  } as unknown as NormalizedEvent
}

const BUY = '2026-04-01T00:00:00Z'
const SELL = '2026-04-02T00:00:00Z'

/**
 * 13 structural lots, 10 verified: sX and sY each have TWO outbound events in one tx (swap + fee
 * transfer) priced by one aggregate tx-side quote; sV is a single sell over three buys; sZ is a plain
 * single fill; three unpriced buys are sold in their own txs. The final lot's exit is tuned so the
 * live realized total is exactly $392.93.
 */
function fixtureLots(): MatchedLot[] {
  const buys = [
    event('0xb1', 'inbound', 700, BUY), event('0xb2', 'inbound', 300, BUY),
    event('0xb3', 'inbound', 500, BUY), event('0xb4', 'inbound', 500, BUY),
    event('0xb5', 'inbound', 200, BUY),
    event('0xb7', 'inbound', 100, BUY), event('0xb8', 'inbound', 100, BUY), event('0xb9', 'inbound', 100, BUY),
    event('0xu1', 'inbound', 50, BUY), event('0xu2', 'inbound', 60, BUY), event('0xu3', 'inbound', 70, BUY),
  ]
  const sells = [
    event('0xsx', 'outbound', 900, SELL, 0), event('0xsx', 'outbound', 100, SELL, 1),
    event('0xsy', 'outbound', 600, SELL, 0), event('0xsy', 'outbound', 400, SELL, 1),
    event('0xsz', 'outbound', 200, SELL),
    event('0xsv', 'outbound', 300, SELL),
    event('0xsu1', 'outbound', 50, SELL), event('0xsu2', 'outbound', 60, SELL), event('0xsu3', 'outbound', 70, SELL),
  ]
  const cost: Record<string, number> = { '0xb1': 70, '0xb2': 30, '0xb3': 50, '0xb4': 55, '0xb5': 40, '0xb7': 10, '0xb8': 11, '0xb9': 12 }
  // One aggregate tx-side quote per sell tx (what the receipt-quote lane stores per txHash).
  const proceeds: Record<string, number> = { '0xsx': 90, '0xsy': 160, '0xsv': 45, '0xsu1': 5, '0xsu2': 6, '0xsu3': 7 }
  const base = (txFixedSz: number) => {
    const lookup = (e: NormalizedEvent) => (e.direction === 'inbound' ? cost[e.txHash] : e.txHash === '0xsz' ? txFixedSz : proceeds[e.txHash]) ?? null
    return matchLotsFIFO(buildLots(buys, [], lookup), sells, lookup).matchedLots
  }
  const realizedWithout = sumQuantizedUsd(base(0).filter((l) => l.closedTxHash !== '0xsz' && l.evidenceQuality === 'verified').map((l) => l.realizedPnlUsd))!
  return base(Math.round((40 + 392.93 - realizedWithout) * 100) / 100)
}

function fingerprints(lots: readonly MatchedLot[], realizedPnlUsd: number | null) {
  const a = buildScanDeterminismAudit({ matchedLots: lots, realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
  return { verifiedLotIdentityFingerprint: a.verifiedLotIdentityFingerprint, acceptedHistoricalPriceFingerprint: a.acceptedHistoricalPriceFingerprint, realizedPnlFingerprint: a.realizedPnlFingerprint, scanFingerprint: a.scanFingerprint }
}

/** Canonical seeding semantics: one record per tx side = the sum of its verified siblings' values. */
function seedAcceptedEvidence(lots: readonly MatchedLot[]): Map<string, AcceptedEvidenceEnvelope> {
  const groups = new Map<string, { lots: MatchedLot[]; total: number; side: 'entry' | 'exit'; txHash: string; timestamp: number }>()
  for (const lot of lots) {
    if (!isCanonicalVerifiedPublishedLot(lot)) continue
    const [entryKey, exitKey] = acceptedEvidenceIdentityKeysForLot(lot)
    const sides = [
      { key: entryKey, side: 'entry' as const, txHash: lot.openedTxHash, timestamp: lot.openedAt, value: lot.costBasisUsd! },
      { key: exitKey, side: 'exit' as const, txHash: lot.closedTxHash, timestamp: lot.closedAt, value: lot.proceedsUsd! },
    ]
    for (const s of sides) {
      const g = groups.get(s.key) ?? { lots: [], total: 0, side: s.side, txHash: s.txHash, timestamp: s.timestamp }
      g.lots.push(lot)
      g.total += s.value
      groups.set(s.key, g)
    }
  }
  const store = new Map<string, AcceptedEvidenceEnvelope>()
  for (const [key, g] of groups) {
    const total = Math.round(g.total * 1e8) / 1e8
    store.set(key, buildAcceptedEvidenceEnvelope({
      identity: { chain: 'base', token: CLAW, txHash: g.txHash, side: g.side, timestamp: g.timestamp, lotIdentityVersion: g.lots.map(lotIdentityVersion).sort()[0] },
      priceUsd: total, valueUsd: total, valueType: 'total_side_value_usd', coveredLotCount: g.lots.length,
      coverageFingerprint: buildAcceptedEvidenceCoverageFingerprint(g.lots), source: 'canonical-upstream', evidenceType: 'unknown',
      providerTimestampBucket: null, now: 1,
    }))
  }
  return store
}

function loaderFor(store: Map<string, AcceptedEvidenceEnvelope>): AcceptedEvidenceLoader {
  return async (identity) => {
    const envelope = store.get(buildAcceptedEvidenceKey({ ...identity, lotIdentityVersion: '' })) ?? null
    if (!envelope) return null
    return identity.lotIdentityVersion === null || envelope.lotIdentityVersion === identity.lotIdentityVersion ? envelope : null
  }
}

/** Accepted-evidence hydration of the next scan: each side's total allocated across ALL its siblings. */
function hydrate(lots: readonly MatchedLot[], store: Map<string, AcceptedEvidenceEnvelope>): MatchedLot[] {
  const groups = new Map<string, MatchedLot[]>()
  for (const lot of lots) for (const key of acceptedEvidenceIdentityKeysForLot(lot)) groups.set(key, [...(groups.get(key) ?? []), lot])
  const shares = new Map<MatchedLot, { cost?: number; proceeds?: number }>()
  for (const [key, group] of groups) {
    const evidence = store.get(key)
    if (!evidence) continue
    for (const share of allocateSideValueAcrossGroup(group, evidence.priceUsd)) {
      const s = shares.get(share.lot) ?? {}
      if (key.includes(':entry:')) s.cost = share.allocatedValueUsd
      else s.proceeds = share.allocatedValueUsd
      shares.set(share.lot, s)
    }
  }
  return lots.map((lot) => {
    const s = shares.get(lot) ?? {}
    const costBasisUsd = s.cost ?? lot.costBasisUsd
    const proceedsUsd = s.proceeds ?? lot.proceedsUsd
    return { ...lot, costBasisUsd, proceedsUsd, realizedPnlUsd: costBasisUsd != null && proceedsUsd != null ? proceedsUsd - costBasisUsd : null }
  })
}

const identity = buildManifestIdentity({ walletAddress: WALLET, chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fixture' })

async function buildManifest(lots: readonly MatchedLot[], load: AcceptedEvidenceLoader, additive = false) {
  const verified = lots.filter(isCanonicalVerifiedPublishedLot)
  return buildManifestFromCandidate({
    identity, allCandidateLots: lots, candidateVerifiedLots: verified, structuralLotCount: lots.length,
    fingerprints: fingerprints(lots, null), realizedPnlUsd: null, verifiedPricingCoverage: verified.length / lots.length, now: 1,
    loadEvidence: load, computeFingerprints: fingerprints,
    ...(additive ? { preferLiveCanonicalValuesWhenAllocatedNotPositive: true, priorManifest: null } : {}),
  })
}

/** The manifest production holds today: every group frozen with its LIVE FIFO fragment values. */
function legacyLiveFrozenManifest(manifest: CanonicalPnlSampleManifest, liveLots: readonly MatchedLot[], provenance: boolean): CanonicalPnlSampleManifest {
  const identities = buildCanonicalLotIdentities(liveLots)
  const byKey = new Map<string, MatchedLot[]>()
  for (const lot of liveLots) {
    const key = identities.get(lot)?.key
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), lot])
  }
  const round8 = (v: number) => Math.round(v * 1e8) / 1e8
  const records = manifest.verifiedLotRecords.map((r) => {
    const members = byKey.get(r.key)!
    const cost = round8(members.reduce((s, l) => s + l.costBasisUsd!, 0))
    const proceeds = round8(members.reduce((s, l) => s + l.proceedsUsd!, 0))
    const pnl = Math.round((proceeds - cost) * 100) / 100
    return {
      ...r, groupCostBasisUsd: cost, groupProceedsUsd: proceeds, groupRealizedPnlUsd: pnl,
      costBasisUsd: cost / members.length, proceedsUsd: proceeds / members.length, realizedPnlUsd: pnl / members.length,
      entryPriceUsd: cost / members.length, exitPriceUsd: proceeds / members.length,
      ...(provenance ? { valueProvenance: 'live_canonical_candidate' as const } : {}),
    }
  })
  return { ...manifest, verifiedLotRecords: records, realizedPnlUsd: sumQuantizedUsd(records.map((r) => r.groupRealizedPnlUsd)) }
}

function memoryKv(): AcceptedEvidenceKvLike {
  const m = new Map<string, unknown>()
  return {
    get: async <T>(key: string) => (m.get(key) as T | undefined) ?? null,
    set: async (key: string, value: unknown) => { m.set(key, value); return 'OK' },
  } as unknown as AcceptedEvidenceKvLike
}

const verifiedCount = (lots: readonly MatchedLot[]) => lots.filter(isCanonicalVerifiedPublishedLot).length
const realizedOf = (lots: readonly MatchedLot[]) => sumQuantizedUsd(sortLotsByCanonicalIdentity(lots.filter(isCanonicalVerifiedPublishedLot)).map((l) => l.realizedPnlUsd))

describe('fixture sanity — the production shape', () => {
  it('13 structural lots, 10 verified (76.92%), live realized $392.93; two-event sells give non-proportional fragments', () => {
    const lots = fixtureLots()
    assert.equal(lots.length, 13)
    assert.equal(verifiedCount(lots), 10)
    assert.equal(realizedOf(lots), 392.93)
    const sx = lots.filter((l) => l.closedTxHash === '0xsx').map((l) => [l.amount, l.proceedsUsd])
    assert.deepEqual(sx, [[700, 70], [200, 20], [100, 90]], 'FIFO prorates the aggregate per sell EVENT')
  })
})

describe('canonical selection keeps the verified sample', () => {
  it('root cause reproduced: a live-frozen manifest replayed against hydrated allocation withholds all 10 (before the fix this was structural)', async () => {
    const live = fixtureLots()
    const store = seedAcceptedEvidence(live)
    const load = loaderFor(store)
    const legacy = legacyLiveFrozenManifest(await buildManifest(live, load), live, true)
    const next = hydrate(live, store)
    const replay = await replayManifest({ manifest: legacy, allCandidateLots: next, loadEvidence: load, computeFingerprints: fingerprints })
    assert.equal(replay.outcome, 'unavailable')
    assert.ok(replay.reasonCounts.manifest_exit_price_mismatch > 0)
    assert.equal(replay.reasonCounts.manifest_entry_price_mismatch, 0)
    assert.equal(verifiedCount(replay.publishedLots), 0, 'fail-closed replay withholds the whole sample')
    // First divergence is in manifest replay (not a copied DTO), recorded per lot.
    const audit = replay.canonicalLotTransitionAudit!
    assert.equal(audit.length, 10)
    for (const row of audit) {
      assert.equal(row.evidenceQualityAfterPricing, 'verified')
      assert.equal(row.evidenceQualityBeforeSelection, 'unpriced')
      assert.match(row.firstDivergenceStage!, /^manifest_replay:/)
    }
    // The fix: an aggregate-conserving fragment re-allocation is NOT structural corruption.
    assert.equal(replay.structuralIntegrityFailure, false)
    assert.ok(replay.aggregateSideAllocationAudit!.every((row) => row.acceptedSideTotalConserved))
    assert.ok((replay.manifestStructuralFailureAudit.staleEvidenceReasons.aggregate_side_evidence_fragment_allocation_changed ?? 0) > 0)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(replay, verifiedCount(next)), true)
  })

  it('1. 10 verified priced lots remain 10 through canonical selection (self-heal refresh applies, realized unchanged)', async () => {
    const live = fixtureLots()
    const store = seedAcceptedEvidence(live)
    const load = loaderFor(store)
    for (const provenance of [true, false]) {
      const legacy = legacyLiveFrozenManifest(await buildManifest(live, load), live, provenance)
      const next = hydrate(live, store)
      assert.equal(verifiedCount(next), 10, 'pricing stage')
      const first = await replayManifest({ manifest: legacy, allCandidateLots: next, loadEvidence: load, computeFingerprints: fingerprints })
      assert.equal(first.structuralIntegrityFailure, false)
      const rebuilt = await buildRefreshedManifest({
        priorManifest: legacy, identity, allCandidateLots: next, candidateVerifiedLots: next.filter(isCanonicalVerifiedPublishedLot),
        structuralLotCount: next.length, fingerprints: fingerprints(next, null), realizedPnlUsd: null, verifiedPricingCoverage: 10 / 13,
        now: 2, refreshReason: 'partially-unreproducible-manifest-current-evidence-refresh', loadEvidence: load, computeFingerprints: fingerprints,
      })
      const applied = await applyRefreshedCanonicalManifest({ kv: memoryKv(), identity, rebuilt, allCandidateLots: next, loadEvidence: load, computeFingerprints: fingerprints })
      assert.equal(applied.applied, true, String(applied.audit.writeFailureReason))
      assert.equal(verifiedCount(applied.replay!.publishedLots), 10, 'canonical selection')
      assert.equal(applied.replay!.recomputedRealizedPnlUsd, legacy.realizedPnlUsd, 'side totals conserved → realized unchanged')
      assert.equal(applied.replay!.recomputedRealizedPnlUsd, 392.93)
    }
  })

  it('2. one tx-side quote backing multiple FIFO fragments does not create a false manifest mismatch', async () => {
    const live = fixtureLots()
    const store = seedAcceptedEvidence(live)
    const load = loaderFor(store)
    // Additive growth (the path that froze live values) now freezes the accepted allocation.
    const manifest = await buildManifest(live, load, true)
    assert.equal(manifest.verifiedLotCount, 10)
    assert.ok(manifest.verifiedLotRecords.every((r) => r.valueProvenance !== 'live_canonical_candidate'))
    const replay = await replayManifest({ manifest, allCandidateLots: hydrate(live, store), loadEvidence: load, computeFingerprints: fingerprints })
    assert.equal(replay.outcome, 'applied')
    assert.equal(replay.reasonCounts.manifest_exit_price_mismatch, 0)
    assert.equal(replay.reasonCounts.manifest_proceeds_mismatch, 0)
    assert.equal(verifiedCount(replay.publishedLots), 10)
    assert.ok(replay.canonicalLotTransitionAudit!.every((row) => row.firstDivergenceStage === null && row.evidenceQualityBeforeSelection === 'verified'))
  })

  it('3. aggregate accepted evidence is prorated into fragment values by quantity, conserving the side total', async () => {
    const live = fixtureLots()
    const store = seedAcceptedEvidence(live)
    const sx = live.filter((l) => l.closedTxHash === '0xsx')
    const [, exitKey] = acceptedEvidenceIdentityKeysForLot(sx[0])
    const total = store.get(exitKey)!.priceUsd
    assert.equal(total, 180, 'accepted evidence keeps the full tx-side value immutable')
    const shares = allocateSideValueAcrossGroup(sx, total)
    assert.deepEqual(shares.map((s) => [s.lot.amount, s.allocatedValueUsd]).sort((a, b) => b[0] - a[0]), [[700, 126], [200, 36], [100, 18]])
    assert.equal(shares.reduce((sum, s) => sum + s.allocatedValueUsd, 0), total)
    const replay = await replayManifest({ manifest: await buildManifest(live, loaderFor(store)), allCandidateLots: hydrate(live, store), loadEvidence: loaderFor(store), computeFingerprints: fingerprints })
    const row = replay.canonicalLotTransitionAudit!.find((r) => r.exitUsdAfterPricing === 18)!
    assert.equal(row.acceptedExitRawUsd, 180)
    assert.equal(row.fragmentAllocationFactor, 100 / 1000)
    assert.equal(row.manifestExitUsd, 18)
  })

  it('4. a genuine evidence-quality downgrade still rejects', async () => {
    const live = fixtureLots()
    const store = seedAcceptedEvidence(live)
    const load = loaderFor(store)
    const manifest = await buildManifest(live, load)
    const next = hydrate(live, store)
    const downgraded = next.map((l, i) => (i === next.findIndex(isCanonicalVerifiedPublishedLot) ? { ...l, evidenceQuality: 'unpriced' as const } : l))
    const replay = await replayManifest({ manifest, allCandidateLots: downgraded, loadEvidence: load, computeFingerprints: fingerprints })
    assert.equal(replay.outcome, 'unavailable')
    assert.ok(replay.reasonCounts.manifest_evidence_quality_mismatch > 0)
    assert.equal(verifiedCount(replay.publishedLots), 0)
  })

  it('5. a genuine value mismatch still rejects (accepted side total changed → structural)', async () => {
    const live = fixtureLots()
    const store = seedAcceptedEvidence(live)
    const legacy = legacyLiveFrozenManifest(await buildManifest(live, loaderFor(store)), live, false)
    const [, exitKey] = acceptedEvidenceIdentityKeysForLot(live.find((l) => l.closedTxHash === '0xsx')!)
    const tampered = new Map(store)
    tampered.set(exitKey, { ...store.get(exitKey)!, priceUsd: 200, valueUsd: 200 })
    const replay = await replayManifest({ manifest: legacy, allCandidateLots: hydrate(live, tampered), loadEvidence: loaderFor(tampered), computeFingerprints: fingerprints })
    assert.equal(replay.outcome, 'unavailable')
    assert.equal(replay.structuralIntegrityFailure, true)
    assert.ok((replay.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0) > 0)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(replay, 10), false)
    // A fresh build over the same changed evidence still replays exactly (no tolerance was added).
    const fresh = await buildManifest(hydrate(live, tampered), loaderFor(tampered))
    const ok = await replayManifest({ manifest: fresh, allCandidateLots: hydrate(live, tampered), loadEvidence: loaderFor(tampered), computeFingerprints: fingerprints })
    assert.equal(ok.outcome, 'applied')
  })

  it('6. repeated identical scans reproduce 10/13 and $392.93', async () => {
    const live = fixtureLots()
    const store = seedAcceptedEvidence(live)
    const load = loaderFor(store)
    const manifest = await buildManifest(live, load, true)
    for (let scan = 0; scan < 3; scan += 1) {
      const lots = hydrate(fixtureLots(), store)
      const replay = await replayManifest({ manifest, allCandidateLots: lots, loadEvidence: load, computeFingerprints: fingerprints })
      assert.equal(replay.outcome, 'applied')
      assert.equal(lots.length, 13)
      assert.equal(verifiedCount(replay.publishedLots), 10)
      assert.equal(replay.recomputedRealizedPnlUsd, 392.93)
    }
  })
})

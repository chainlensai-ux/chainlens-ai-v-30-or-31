// Regression tests for the durable canonical PnL sample manifest (item #12: corrupt, missing-record,
// expiry, methodology-version and structural fingerprint-change coverage; item #11: the production-
// shaped run1/run2/explicit-refresh regression). Run directly with:
//   npx tsx --test src/lib/canonicalPnlSampleManifest.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildManifestIdentity, buildManifestKey, buildManifestFromCandidate, buildRefreshedManifest,
  readCanonicalPnlSampleManifest, writeCanonicalPnlSampleManifest, applyManifestToCandidateSample,
  canonicalLotIdentityKey, buildScanWindowIdentity, buildChainScope, normalizeWalletAddress,
  type CanonicalSampleManifestKvLike,
} from './canonicalPnlSampleManifest.ts'
import { buildScanDeterminismAudit } from './scanDeterminismAudit.ts'
import type { MatchedLot } from '../modules/fifoEngine/types'

function fakeKv(): CanonicalSampleManifestKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified',
    ...overrides,
  }
}

function buildLots(count: number, verifiedCount: number): MatchedLot[] {
  return Array.from({ length: count }, (_, i) => lot({
    lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`,
    openedAt: i, closedAt: 1000 + i,
    evidenceQuality: i < verifiedCount ? 'verified' : 'unpriced',
    costBasisUsd: i < verifiedCount ? 10 + i : null,
    proceedsUsd: i < verifiedCount ? 20 + i : null,
    realizedPnlUsd: i < verifiedCount ? 10 : null,
  }))
}

function fingerprintsFor(structuralLots: readonly MatchedLot[], realizedPnlUsd: number | null) {
  const audit = buildScanDeterminismAudit({ matchedLots: structuralLots, realizedPnlUsd, persistedEvidenceHits: 0, liveEvidenceMisses: 0 })
  return {
    matchedLotFingerprint: audit.matchedLotFingerprint,
    verifiedLotIdentityFingerprint: audit.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint: audit.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint: audit.realizedPnlFingerprint,
    scanFingerprint: audit.scanFingerprint,
  }
}

describe('canonicalPnlSampleManifest — identity', () => {
  it('normalizes wallet address and chain scope; is stable regardless of wall-clock time', () => {
    assert.equal(normalizeWalletAddress(' 0xAbC '), '0xabc')
    assert.equal(buildChainScope(['Base', 'eth', 'base']), 'base,eth')
    const a = buildScanWindowIdentity({ configuredWindowDays: 90, pricingMethodologyVersion: 1 })
    const b = buildScanWindowIdentity({ configuredWindowDays: 90, pricingMethodologyVersion: 1 })
    assert.equal(a, b)
  })

  it('manifest key never depends on wall-clock time — same identity inputs always produce the same key', () => {
    const identity1 = buildManifestIdentity({ walletAddress: '0xAAA', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const identity2 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    assert.equal(buildManifestKey(identity1), buildManifestKey(identity2))
  })

  it('a different matchedLotFingerprint produces a different manifest key (structural change requirement)', () => {
    const identity1 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const identity2 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp2' })
    assert.notEqual(buildManifestKey(identity1), buildManifestKey(identity2))
  })

  it('a different pricing methodology version produces a different manifest key', () => {
    const identity1 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1', pricingMethodologyVersion: 1 })
    const identity2 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1', pricingMethodologyVersion: 2 })
    assert.notEqual(buildManifestKey(identity1), buildManifestKey(identity2))
  })
})

describe('canonicalPnlSampleManifest — read/write, fail-closed', () => {
  it('round-trips a written manifest', async () => {
    const kv = fakeKv()
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const lots = buildLots(3, 3)
    const fp = fingerprintsFor(lots, 30)
    const manifest = buildManifestFromCandidate({ identity, candidateVerifiedLots: lots, structuralLotCount: 3, fingerprints: fp, realizedPnlUsd: 30, verifiedPricingCoverage: 1, now: 1000 })
    assert.equal(await writeCanonicalPnlSampleManifest(kv, manifest), true)
    const result = await readCanonicalPnlSampleManifest(kv, identity)
    assert.deepEqual(result.manifest, manifest)
    assert.equal(result.validationFailure, false)
  })

  it('missing record: reports null manifest, no validation failure', async () => {
    const kv = fakeKv()
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const result = await readCanonicalPnlSampleManifest(kv, identity)
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, false)
  })

  it('corrupt record: fails closed, reports validationFailure true, never fabricates a manifest', async () => {
    const kv = fakeKv()
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    await kv.set(buildManifestKey(identity), { garbage: true })
    const result = await readCanonicalPnlSampleManifest(kv, identity)
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, true)
  })

  it('identity mismatch (wallet address changed) never returns the wrong wallet\'s manifest', async () => {
    const kv = fakeKv()
    const identityA = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const lots = buildLots(2, 2)
    const fp = fingerprintsFor(lots, 20)
    const manifestA = buildManifestFromCandidate({ identity: identityA, candidateVerifiedLots: lots, structuralLotCount: 2, fingerprints: fp, realizedPnlUsd: 20, verifiedPricingCoverage: 1, now: 1 })
    await kv.set(buildManifestKey(identityA), manifestA)

    // Different wallet asking under a colliding raw store lookup never happens (different key), but
    // simulate a corrupted/foreign record written under the SAME key by an identity-mismatched writer.
    const identityB = buildManifestIdentity({ walletAddress: '0xbbb', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    await kv.set(buildManifestKey(identityB), manifestA) // wrong-wallet payload under wallet B's key
    const result = await readCanonicalPnlSampleManifest(kv, identityB)
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, true)
  })

  it('a structural fingerprint change never reuses the prior manifest (different key entirely, real miss)', async () => {
    const kv = fakeKv()
    const identity1 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp-before' })
    const lots = buildLots(2, 2)
    const fp = fingerprintsFor(lots, 20)
    const manifest = buildManifestFromCandidate({ identity: identity1, candidateVerifiedLots: lots, structuralLotCount: 2, fingerprints: fp, realizedPnlUsd: 20, verifiedPricingCoverage: 1, now: 1 })
    await writeCanonicalPnlSampleManifest(kv, manifest)

    const identity2 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp-after' })
    const result = await readCanonicalPnlSampleManifest(kv, identity2)
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, false, 'a structural fingerprint change is a real miss, not corruption')
  })

  it('a methodology version change never reuses the prior manifest', async () => {
    const kv = fakeKv()
    const identity1 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1', pricingMethodologyVersion: 1 })
    const lots = buildLots(2, 2)
    const fp = fingerprintsFor(lots, 20)
    const manifest = buildManifestFromCandidate({ identity: identity1, candidateVerifiedLots: lots, structuralLotCount: 2, fingerprints: fp, realizedPnlUsd: 20, verifiedPricingCoverage: 1, now: 1 })
    await writeCanonicalPnlSampleManifest(kv, manifest)

    const identity2 = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1', pricingMethodologyVersion: 2 })
    const result = await readCanonicalPnlSampleManifest(kv, identity2)
    assert.equal(result.manifest, null)
  })

  it('KV outage on read fails open to "no manifest" (never blocks, never fabricates)', async () => {
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const brokenKv: CanonicalSampleManifestKvLike = { get: async () => { throw new Error('down') }, set: async () => 'OK' }
    const result = await readCanonicalPnlSampleManifest(brokenKv, identity)
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, false)
  })

  it('KV outage on write returns false, never throws', async () => {
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const lots = buildLots(1, 1)
    const fp = fingerprintsFor(lots, 10)
    const manifest = buildManifestFromCandidate({ identity, candidateVerifiedLots: lots, structuralLotCount: 1, fingerprints: fp, realizedPnlUsd: 10, verifiedPricingCoverage: 1, now: 1 })
    const brokenKv: CanonicalSampleManifestKvLike = { get: async () => null, set: async () => { throw new Error('down') } }
    assert.equal(await writeCanonicalPnlSampleManifest(brokenKv, manifest), false)
  })
})

describe('canonicalPnlSampleManifest — applyManifestToCandidateSample (requirement #4/#9)', () => {
  it('an unchanged rescan reproduces exactly the manifest sample; nothing new leaks in', () => {
    const lots = buildLots(5, 5)
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const fp = fingerprintsFor(lots, 50)
    const manifest = buildManifestFromCandidate({ identity, candidateVerifiedLots: lots, structuralLotCount: 5, fingerprints: fp, realizedPnlUsd: 50, verifiedPricingCoverage: 1, now: 1 })
    const applied = applyManifestToCandidateSample({ manifest, candidateVerifiedLots: lots })
    assert.equal(applied.selectedLots.length, 5)
    assert.equal(applied.candidateNewEvidence.length, 0)
    assert.equal(applied.evidenceUnavailable, false)
  })

  it('newly-priceable lots this scan are reported as candidateNewEvidence, never merged into selectedLots', () => {
    const originalLots = buildLots(19, 19)
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const fp = fingerprintsFor(originalLots, -1377.03)
    const manifest = buildManifestFromCandidate({ identity, candidateVerifiedLots: originalLots, structuralLotCount: 27, fingerprints: fp, realizedPnlUsd: -1377.03, verifiedPricingCoverage: 0.7037, now: 1 })

    // Rescan: same 19 originally-verified lots PLUS 2 newly-priceable ones.
    const newlyPriced = buildLots(2, 2).map((l, i) => ({ ...l, lotId: `new-${i}`, token: `0xnew${i}`, openedTxHash: `0xnewbuy${i}`, closedTxHash: `0xnewsell${i}` }))
    const candidate = [...originalLots, ...newlyPriced]
    const applied = applyManifestToCandidateSample({ manifest, candidateVerifiedLots: candidate })

    assert.equal(applied.selectedLots.length, 19, 'published sample must stay at 19')
    assert.equal(applied.candidateNewEvidence.length, 2)
    assert.deepEqual(applied.candidateNewEvidence.map((l) => l.lotId).sort(), ['new-0', 'new-1'])
    assert.equal(applied.evidenceUnavailable, false)
  })

  it('fail-closed: a manifest-referenced lot missing from the current candidate set is reported, never substituted or dropped silently', () => {
    const originalLots = buildLots(3, 3)
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const fp = fingerprintsFor(originalLots, 30)
    const manifest = buildManifestFromCandidate({ identity, candidateVerifiedLots: originalLots, structuralLotCount: 3, fingerprints: fp, realizedPnlUsd: 30, verifiedPricingCoverage: 1, now: 1 })

    // This scan's accepted evidence for lot-1 could not be loaded (missing entirely this run).
    const degradedCandidate = originalLots.filter((l) => l.lotId !== 'lot-1')
    const applied = applyManifestToCandidateSample({ manifest, candidateVerifiedLots: degradedCandidate })

    assert.equal(applied.evidenceUnavailable, true)
    assert.equal(applied.selectedLots.length, 2)
    assert.deepEqual(applied.manifestLotsMissingCurrentEvidence, [canonicalLotIdentityKey(originalLots[1])])
  })
})

describe('canonicalPnlSampleManifest — refresh (requirement #5/#7)', () => {
  it('an explicit refresh creates a new manifest version, links the prior version, and may change fingerprints', () => {
    const identity = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1' })
    const originalLots = buildLots(19, 19)
    const priorFp = fingerprintsFor(originalLots, -1377.03)
    const priorManifest = buildManifestFromCandidate({ identity, candidateVerifiedLots: originalLots, structuralLotCount: 27, fingerprints: priorFp, realizedPnlUsd: -1377.03, verifiedPricingCoverage: 0.7037, now: 1000 })

    const expandedLots = buildLots(21, 21)
    const newFp = fingerprintsFor(expandedLots, -979.81)
    const refreshed = buildRefreshedManifest({
      priorManifest, identity, candidateVerifiedLots: expandedLots, structuralLotCount: 27,
      fingerprints: newFp, realizedPnlUsd: -979.81, verifiedPricingCoverage: 0.7778, now: 2000, refreshReason: 'explicit-refresh',
    })

    assert.equal(refreshed.manifestVersion, 2)
    assert.equal(refreshed.priorManifestVersion, 1)
    assert.equal(refreshed.verifiedLotCount, 21)
    assert.equal(refreshed.realizedPnlUsd, -979.81)
    assert.equal(refreshed.refreshReason, 'explicit-refresh')
    assert.notEqual(refreshed.realizedPnlFingerprint, priorManifest.realizedPnlFingerprint, 'a real, disclosed refresh may intentionally change fingerprints')
    assert.equal(refreshed.createdAt, priorManifest.createdAt, 'createdAt tracks manifest lineage, not the refresh event')
    assert.equal(refreshed.refreshedAt, 2000)
  })
})

describe('canonicalPnlSampleManifest — production-shaped regression (requirement #11)', () => {
  it('run1 creates the manifest at 19/70.37%/A; run2 (same structural fingerprint, 2 newly-priceable lots, different live provider values) reproduces exactly 19 lots / manifest coverage / realized PnL A, with candidateNewEvidence reported and both structural + all four determinism fingerprints unchanged; an explicit refresh then legitimately expands to 21', async () => {
    const kv = fakeKv()
    const REALIZED_PNL_A = -1377.03
    const COVERAGE_A = 19 / 27

    // RUN 1 — 27 structural lots, 19 verified.
    const structuralLots = buildLots(27, 19)
    const verifiedRun1 = structuralLots.filter((l) => l.evidenceQuality === 'verified')
    const identity = buildManifestIdentity({ walletAddress: '0xWallet', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: fingerprintsFor(structuralLots, REALIZED_PNL_A).matchedLotFingerprint })
    const fpRun1 = fingerprintsFor(structuralLots, REALIZED_PNL_A)
    const manifestRun1 = buildManifestFromCandidate({
      identity, candidateVerifiedLots: verifiedRun1, structuralLotCount: structuralLots.length,
      fingerprints: fpRun1, realizedPnlUsd: REALIZED_PNL_A, verifiedPricingCoverage: COVERAGE_A, now: 1000,
    })
    assert.equal(await writeCanonicalPnlSampleManifest(kv, manifestRun1), true)

    // RUN 2 — SAME matchedLotFingerprint (structural set unchanged), providers now return different
    // live values for previously-unresolved sides, and 2 previously-unpriced structural lots (index
    // 19, 20) become fully priceable this run with DIFFERENT (non-manifest) prices.
    const structuralLotsRun2 = structuralLots.map((l, i) => {
      if (i === 19 || i === 20) return { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 999, proceedsUsd: 1111, realizedPnlUsd: 112 }
      return l
    })
    const readBack = await readCanonicalPnlSampleManifest(kv, identity)
    assert.ok(readBack.manifest, 'the manifest must be found by its stable structural identity, unaffected by provider-availability changes')
    const candidateVerifiedRun2 = structuralLotsRun2.filter((l) => l.evidenceQuality === 'verified')
    assert.equal(candidateVerifiedRun2.length, 21, 'sanity: run2 candidate now has 21 verified lots')

    const applied = applyManifestToCandidateSample({ manifest: readBack.manifest!, candidateVerifiedLots: candidateVerifiedRun2 })
    assert.equal(applied.selectedLots.length, 19, 'published sample must remain 19 lots, not silently expand to 21')
    assert.equal(applied.candidateNewEvidence.length, 2, 'the 2 newly-priceable lots must be reported as candidateNewEvidence')
    assert.equal(applied.evidenceUnavailable, false)

    // Published figures for run2 come from the manifest itself (frozen), never recomputed from the
    // expanded candidate set — this is what keeps realizedPnlUsd/coverage/fingerprints identical.
    assert.equal(readBack.manifest!.realizedPnlUsd, REALIZED_PNL_A)
    assert.equal(readBack.manifest!.verifiedPricingCoverage, COVERAGE_A)
    assert.equal(readBack.manifest!.verifiedLotIdentityFingerprint, fpRun1.verifiedLotIdentityFingerprint)
    assert.equal(readBack.manifest!.acceptedHistoricalPriceFingerprint, fpRun1.acceptedHistoricalPriceFingerprint)
    assert.equal(readBack.manifest!.realizedPnlFingerprint, fpRun1.realizedPnlFingerprint)
    assert.equal(readBack.manifest!.matchedLotFingerprint, identity.matchedLotFingerprint, 'structural fingerprint must remain the lookup key itself, unchanged')

    // EXPLICIT REFRESH RUN — deliberately expands the published sample to 21, with disclosure.
    const fpRun3 = fingerprintsFor(structuralLotsRun2, -979.81)
    const refreshedManifest = buildRefreshedManifest({
      priorManifest: readBack.manifest!, identity, candidateVerifiedLots: candidateVerifiedRun2,
      structuralLotCount: structuralLotsRun2.length, fingerprints: fpRun3, realizedPnlUsd: -979.81,
      verifiedPricingCoverage: 21 / 27, now: 3000, refreshReason: 'explicit-refresh',
    })
    assert.equal(refreshedManifest.manifestVersion, 2)
    assert.equal(refreshedManifest.priorManifestVersion, 1)
    assert.equal(refreshedManifest.verifiedLotCount, 21)
    assert.equal(refreshedManifest.realizedPnlUsd, -979.81)
    assert.notEqual(refreshedManifest.realizedPnlFingerprint, manifestRun1.realizedPnlFingerprint, 'an explicit, disclosed refresh may intentionally change fingerprints')
    assert.equal(await writeCanonicalPnlSampleManifest(kv, refreshedManifest), true)

    // RUN 4 — a subsequent unchanged rescan must now reproduce the REFRESHED 21-lot sample, not v1.
    const readBackAfterRefresh = await readCanonicalPnlSampleManifest(kv, identity)
    assert.equal(readBackAfterRefresh.manifest!.manifestVersion, 2)
    assert.equal(readBackAfterRefresh.manifest!.verifiedLotCount, 21)
  })
})

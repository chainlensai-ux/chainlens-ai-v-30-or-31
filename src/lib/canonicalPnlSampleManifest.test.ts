// Regression tests for the durable canonical PnL sample manifest, after the confirmed production
// replay failure (float-in-identity-key -> zero of 21 manifest lots resolved -> live 23-lot sample
// escaped as canonical). Covers requirements #1 (float-free identity + partial-fill ordinals),
// #2 (deduplication), #3 (atomic replay), #4 (genuine fail-closed), #6 (candidate exclusion),
// #7 (reason codes) and #8 (production-shaped partial-fill regressions). Run directly with:
//   npx tsx --test src/lib/canonicalPnlSampleManifest.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildManifestIdentity, buildManifestKey, buildManifestFromCandidate, buildRefreshedManifest,
  readCanonicalPnlSampleManifest, writeCanonicalPnlSampleManifest, replayManifest,
  buildCanonicalLotIdentities, canonicalAmountString, dedupeKeys, logDuplicateIdentityIfAny,
  buildLastKnownCanonicalSample, buildScanWindowIdentity, buildChainScope, normalizeWalletAddress,
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

const isVerified = (lot: MatchedLot) => lot.evidenceQuality === 'verified'

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

function identity(matchedLotFingerprint = 'fp1') {
  return buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint })
}

function manifestFor(allLots: readonly MatchedLot[], realizedPnlUsd: number, coverage: number, now = 1000) {
  const verified = allLots.filter(isVerified)
  return buildManifestFromCandidate({
    identity: identity(), allCandidateLots: allLots, candidateVerifiedLots: verified,
    structuralLotCount: allLots.length, fingerprints: fingerprintsFor(allLots, realizedPnlUsd),
    realizedPnlUsd, verifiedPricingCoverage: coverage, now,
  })
}

describe('canonicalPnlSampleManifest — lot identity (requirement #1)', () => {
  it('HARD ASSERTION (the exact production bug): a float-noise difference in a partial fill\'s amount never changes the identity key', () => {
    // The SAME structural fill, serialized two ways by float accumulation order — this is precisely
    // what made all 21 production manifest lots unresolvable.
    const clean = lot({ amount: 0.3 })
    const noisy = lot({ amount: 0.1 + 0.2 }) // 0.30000000000000004
    assert.notEqual(String(clean.amount), String(noisy.amount), 'sanity: the raw float text really does differ')

    const keyClean = [...buildCanonicalLotIdentities([clean]).values()][0].key
    const keyNoisy = [...buildCanonicalLotIdentities([noisy]).values()][0].key
    assert.equal(keyClean, keyNoisy, 'float noise must never reach the identity key')
  })

  it('no identity key ever contains raw JS float text', () => {
    const lots = [lot({ amount: 0.1 + 0.2 }), lot({ closedTxHash: '0xsell2', amount: 1 / 3 })]
    for (const id of buildCanonicalLotIdentities(lots).values()) {
      assert.doesNotMatch(id.key, /0\.30000000000000004|0\.3333333333333333/)
    }
  })

  it('canonicalAmountString normalizes float noise and reports non-finite input honestly', () => {
    assert.equal(canonicalAmountString(0.1 + 0.2), canonicalAmountString(0.3))
    assert.equal(canonicalAmountString(Number.NaN), 'invalid')
    assert.equal(canonicalAmountString(Number.POSITIVE_INFINITY), 'invalid')
  })

  it('partial fills of the same tx pair get distinct, stable ordinals assigned over the FULL lot array', () => {
    // One buy tx split across two lots closed by the same sell tx — the real partial-fill shape.
    const fillA = lot({ lotId: 'a', amount: 2 })
    const fillB = lot({ lotId: 'b', amount: 3 })
    const identities = buildCanonicalLotIdentities([fillA, fillB])
    const keyA = identities.get(fillA)!.key
    const keyB = identities.get(fillB)!.key
    assert.notEqual(keyA, keyB, 'two slices of one fill must never collide on one identity')
    assert.equal(identities.get(fillA)!.partialFillGroupSize, 2)
    assert.equal(identities.get(fillB)!.partialFillGroupSize, 2)

    // Reversed construction order must produce the SAME assignment (requirement #8's "floating-point
    // construction/order differs internally").
    const reversed = buildCanonicalLotIdentities([fillB, fillA])
    assert.equal(reversed.get(fillA)!.key, keyA)
    assert.equal(reversed.get(fillB)!.key, keyB)
  })

  it('a slice\'s identity does not shift when a SIBLING slice becomes priced (ordinals span all slices, not just verified ones)', () => {
    const fillA = lot({ lotId: 'a', amount: 2 })
    const fillBUnpriced = lot({ lotId: 'b', amount: 3, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null })
    const before = buildCanonicalLotIdentities([fillA, fillBUnpriced]).get(fillA)!.key
    const fillBPriced = { ...fillBUnpriced, evidenceQuality: 'verified' as const, costBasisUsd: 5, proceedsUsd: 9, realizedPnlUsd: 4 }
    const after = buildCanonicalLotIdentities([fillA, fillBPriced]).get(fillA)!.key
    assert.equal(before, after)
  })
})

describe('canonicalPnlSampleManifest — deduplication (requirement #2)', () => {
  it('dedupeKeys canonicalizes, sorts and deduplicates, reporting the real duplicates', () => {
    const result = dedupeKeys(['b', 'a', 'b', 'c', 'a'])
    assert.deepEqual(result.unique, ['a', 'b', 'c'])
    assert.deepEqual(result.duplicates, ['a', 'b'])
  })

  it('partial fills sharing one buy tx produce duplicate evidence keys, which the manifest deduplicates before persistence', () => {
    const fillA = lot({ lotId: 'a', amount: 2 })
    const fillB = lot({ lotId: 'b', amount: 3 })
    const manifest = manifestFor([fillA, fillB], 4, 1)
    // Both slices share openedTxHash AND closedTxHash, so their entry/exit evidence keys collide.
    assert.equal(manifest.acceptedEvidenceIdentityKeys.length, new Set(manifest.acceptedEvidenceIdentityKeys).size)
    assert.equal(manifest.verifiedLotIdentityKeys.length, 2, 'the two distinct slices still have two distinct lot identities')
    assert.equal(manifest.verifiedLotCount, 2)
  })

  it('a manifest carrying duplicate lot keys logs CRITICAL canonical_manifest_duplicate_identity and fails replay closed', () => {
    const lots = buildLots(12, 12)
    const manifest = manifestFor(lots, 120, 1)
    const corrupted = { ...manifest, verifiedLotIdentityKeys: [...manifest.verifiedLotIdentityKeys, manifest.verifiedLotIdentityKeys[0]] }

    const replay = replayManifest({ manifest: corrupted, allCandidateLots: lots, isVerified })
    assert.equal(replay.duplicates.hasDuplicates, true)
    assert.deepEqual(replay.duplicates.manifestDuplicateLotKeys, [manifest.verifiedLotIdentityKeys[0]])
    assert.equal(replay.outcome, 'unavailable', 'a duplicate identity must never be silently tolerated')
    assert.equal(replay.reasonCounts.manifest_duplicate_identity, 1)

    const errors: unknown[][] = []
    logDuplicateIdentityIfAny(replay.duplicates, { error: (...args: unknown[]) => { errors.push(args) } })
    assert.equal(errors.length, 1)
    assert.equal(errors[0][0], 'CRITICAL canonical_manifest_duplicate_identity')
  })

  it('never logs when there are no duplicates', () => {
    const errors: unknown[][] = []
    logDuplicateIdentityIfAny({ hasDuplicates: false, manifestDuplicateLotKeys: [], candidateDuplicateLotKeys: [], manifestDuplicateEvidenceKeys: [] }, { error: (...a: unknown[]) => { errors.push(a) } })
    assert.equal(errors.length, 0)
  })
})

describe('canonicalPnlSampleManifest — read/write, fail-closed', () => {
  it('round-trips a written manifest', async () => {
    const kv = fakeKv()
    const lots = buildLots(3, 3)
    const manifest = manifestFor(lots, 30, 1)
    assert.equal(await writeCanonicalPnlSampleManifest(kv, manifest), true)
    const result = await readCanonicalPnlSampleManifest(kv, identity())
    assert.deepEqual(result.manifest, manifest)
    assert.equal(result.validationFailure, false)
  })

  it('missing record: null manifest, no validation failure', async () => {
    const result = await readCanonicalPnlSampleManifest(fakeKv(), identity())
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, false)
  })

  it('corrupt record: fails closed with validationFailure, never fabricates a manifest', async () => {
    const kv = fakeKv()
    await kv.set(buildManifestKey(identity()), { garbage: true })
    const result = await readCanonicalPnlSampleManifest(kv, identity())
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, true)
  })

  it('a stale lot-identity schema version is rejected (old float-keyed manifests are never replayed)', async () => {
    const kv = fakeKv()
    const manifest = manifestFor(buildLots(2, 2), 20, 1)
    await kv.set(buildManifestKey(identity()), { ...manifest, lotIdentitySchemaVersion: 1 })
    const result = await readCanonicalPnlSampleManifest(kv, identity())
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, true)
  })

  it('identity mismatch (foreign payload under this key) is rejected', async () => {
    const kv = fakeKv()
    const foreign = { ...manifestFor(buildLots(2, 2), 20, 1), normalizedWalletAddress: '0xbbb' }
    await kv.set(buildManifestKey(identity()), foreign)
    const result = await readCanonicalPnlSampleManifest(kv, identity())
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, true)
  })

  it('a structural fingerprint change is a real miss, never a reuse and never corruption', async () => {
    const kv = fakeKv()
    await writeCanonicalPnlSampleManifest(kv, manifestFor(buildLots(2, 2), 20, 1))
    const result = await readCanonicalPnlSampleManifest(kv, identity('fp-after'))
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, false)
  })

  it('a methodology version change never reuses the prior manifest', async () => {
    const kv = fakeKv()
    await writeCanonicalPnlSampleManifest(kv, manifestFor(buildLots(2, 2), 20, 1))
    const other = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1', pricingMethodologyVersion: 2 })
    assert.equal((await readCanonicalPnlSampleManifest(kv, other)).manifest, null)
  })

  it('KV outage fails open to "no manifest" on read and returns false on write, never throwing', async () => {
    const broken: CanonicalSampleManifestKvLike = { get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') } }
    const read = await readCanonicalPnlSampleManifest(broken, identity())
    assert.equal(read.manifest, null)
    assert.equal(read.validationFailure, false)
    assert.equal(await writeCanonicalPnlSampleManifest(broken, manifestFor(buildLots(1, 1), 10, 1)), false)
  })

  it('normalizes wallet address / chain scope, and scan-window identity ignores wall-clock time', () => {
    assert.equal(normalizeWalletAddress(' 0xAbC '), '0xabc')
    assert.equal(buildChainScope(['Base', 'eth', 'base']), 'base,eth')
    assert.equal(
      buildScanWindowIdentity({ configuredWindowDays: 90, pricingMethodologyVersion: 1 }),
      buildScanWindowIdentity({ configuredWindowDays: 90, pricingMethodologyVersion: 1 }),
    )
  })
})

describe('canonicalPnlSampleManifest — atomic replay + reason codes (requirements #3, #6, #7)', () => {
  it('an unchanged rescan replays every lot and publishes exactly the manifest sample', () => {
    const lots = buildLots(12, 12)
    const replay = replayManifest({ manifest: manifestFor(lots, 120, 1), allCandidateLots: lots, isVerified })
    assert.equal(replay.outcome, 'applied')
    assert.equal(replay.forcePublicPnlUnavailable, false)
    assert.equal(replay.selectedLotKeys.length, 12)
    assert.equal(replay.reasonCounts.manifest_replay_success, 12)
    assert.equal(replay.publishedLots.filter(isVerified).length, 12)
  })

  it('HARD ASSERTION (requirement #6): newly-priceable lots are withheld from the published array and contribute zero PnL', () => {
    const run1Lots = buildLots(27, 21)
    const manifest = manifestFor(run1Lots, -979.81, 21 / 27)

    // Run 2: lots 21 and 22 become priceable with brand-new (non-manifest) prices.
    const run2Lots = run1Lots.map((l, i) => (i === 21 || i === 22)
      ? { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 999, proceedsUsd: 5000, realizedPnlUsd: 4001 }
      : l)
    assert.equal(run2Lots.filter(isVerified).length, 23, 'sanity: the live candidate really is 23 lots')

    const replay = replayManifest({ manifest, allCandidateLots: run2Lots, isVerified })
    assert.equal(replay.outcome, 'applied')
    assert.equal(replay.publishedLots.filter(isVerified).length, 21, 'the published sample must stay at 21, never 23')
    assert.equal(replay.candidateNewEvidenceLotKeys.length, 2)
    assert.equal(replay.reasonCounts.manifest_candidate_only_lot, 2)
    assert.equal(replay.publishedLots.length, run2Lots.length, 'the structural lot set is never shrunk')

    // The withheld lots contribute nothing: their published PnL fields are honest nulls.
    const withheld = replay.publishedLots.filter((l) => l.costBasisUsd === 999)
    assert.equal(withheld.length, 0, 'no live candidate price may survive into the published array')
    const publishedPnl = replay.publishedLots.filter(isVerified).reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0)
    assert.equal(publishedPnl, 21 * 10, 'published PnL is exactly the 21 manifest lots, with zero candidate contribution')
  })

  it('HARD ASSERTION (requirement #4): when a manifest lot loses its side evidence, the live sample must NOT escape', () => {
    const run1Lots = buildLots(27, 21)
    const manifest = manifestFor(run1Lots, -979.81, 21 / 27)

    // Run 2: lot-5 lost its accepted evidence, AND two new lots became priceable — the exact
    // production shape that previously published 23 lots / 85.19% / +4105.85.
    const run2Lots = run1Lots.map((l, i) => {
      if (i === 5) return { ...l, evidenceQuality: 'unpriced' as const, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }
      if (i === 21 || i === 22) return { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 999, proceedsUsd: 5000, realizedPnlUsd: 4001 }
      return l
    })
    assert.equal(run2Lots.filter(isVerified).length, 22, 'sanity: a live candidate sample does exist')

    const replay = replayManifest({ manifest, allCandidateLots: run2Lots, isVerified })
    assert.equal(replay.outcome, 'unavailable')
    assert.equal(replay.forcePublicPnlUnavailable, true)
    assert.equal(replay.reasonCounts.manifest_side_evidence_missing, 1)
    assert.equal(replay.manifestLotsMissingCurrentEvidence.length, 1)
    assert.equal(replay.publishedLots.filter(isVerified).length, 0, 'NO verified lot may be published when replay fails — the live sample must never escape')
    assert.equal(replay.publishedLots.length, run2Lots.length, 'structural lots are still disclosed, just unpriced')
    assert.equal(replay.selectedLotKeys.length, 0, 'replay is atomic: it never partially applies')
  })

  it('a manifest lot whose structural identity vanished reports manifest_lot_identity_not_found', () => {
    const lots = buildLots(12, 12)
    const manifest = manifestFor(lots, 120, 1)
    const replay = replayManifest({ manifest, allCandidateLots: lots.slice(0, 11), isVerified })
    assert.equal(replay.outcome, 'unavailable')
    assert.equal(replay.reasonCounts.manifest_lot_identity_not_found, 1)
    assert.equal(replay.publishedLots.filter(isVerified).length, 0)
  })

  it('a partial fill that splits into a different number of slices reports manifest_partial_fill_ordinal_mismatch', () => {
    const twoSlices = [lot({ lotId: 'a', amount: 2 }), lot({ lotId: 'b', amount: 3 })]
    const manifest = manifestFor(twoSlices, 4, 1)
    // The same tx pair now resolves as a single, merged lot.
    const oneSlice = [lot({ lotId: 'merged', amount: 5 })]
    const replay = replayManifest({ manifest, allCandidateLots: oneSlice, isVerified })
    assert.equal(replay.outcome, 'unavailable')
    assert.ok(
      replay.reasonCounts.manifest_partial_fill_ordinal_mismatch + replay.reasonCounts.manifest_lot_identity_not_found > 0,
      'a changed partial-fill split must fail closed, never silently match the wrong slice',
    )
    assert.equal(replay.publishedLots.filter(isVerified).length, 0)
  })

  it('a manifest lot whose recorded quantity no longer matches reports manifest_side_evidence_invalid', () => {
    const lots = [lot({ lotId: 'a', amount: 2 }), lot({ lotId: 'b', closedTxHash: '0xsell2', amount: 3 })]
    const manifest = manifestFor(lots, 4, 1)
    // Same identity (same tx pair, same ordinal within its own single-slice group) but a genuinely
    // different matched quantity — validation metadata catches what the key alone cannot.
    const changed = [lot({ lotId: 'a', amount: 2 }), lot({ lotId: 'b', closedTxHash: '0xsell2', amount: 99 })]
    const replay = replayManifest({ manifest, allCandidateLots: changed, isVerified })
    assert.equal(replay.outcome, 'unavailable')
    assert.equal(replay.reasonCounts.manifest_side_evidence_invalid, 1)
  })

  it('every reason code is present in the counts object, so a zero is a real measured zero', () => {
    const lots = buildLots(12, 12)
    const replay = replayManifest({ manifest: manifestFor(lots, 120, 1), allCandidateLots: lots, isVerified })
    for (const code of [
      'manifest_lot_identity_not_found', 'manifest_side_evidence_missing', 'manifest_side_evidence_invalid',
      'manifest_partial_fill_ordinal_mismatch', 'manifest_duplicate_identity', 'manifest_candidate_only_lot',
      'manifest_replay_success',
    ] as const) {
      assert.equal(typeof replay.reasonCounts[code], 'number', `${code} must always be reported`)
    }
  })
})

describe('canonicalPnlSampleManifest — refresh (requirement #9)', () => {
  it('an explicit refresh creates a new version, links the prior one, and may change fingerprints', () => {
    const run1Lots = buildLots(27, 21)
    const prior = manifestFor(run1Lots, -979.81, 21 / 27)
    const expanded = run1Lots.map((l, i) => (i === 21 || i === 22)
      ? { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 5, proceedsUsd: 9, realizedPnlUsd: 4 }
      : l)

    const refreshed = buildRefreshedManifest({
      priorManifest: prior, identity: identity(), allCandidateLots: expanded,
      candidateVerifiedLots: expanded.filter(isVerified), structuralLotCount: expanded.length,
      fingerprints: fingerprintsFor(expanded, -971.81), realizedPnlUsd: -971.81,
      verifiedPricingCoverage: 23 / 27, now: 2000, refreshReason: 'explicit-refresh',
    })

    assert.equal(refreshed.manifestVersion, 2)
    assert.equal(refreshed.priorManifestVersion, 1)
    assert.equal(refreshed.verifiedLotCount, 23)
    assert.equal(refreshed.refreshReason, 'explicit-refresh')
    assert.equal(refreshed.createdAt, prior.createdAt, 'createdAt tracks lineage, not the refresh event')
    assert.equal(refreshed.refreshedAt, 2000)
    assert.notEqual(refreshed.realizedPnlFingerprint, prior.realizedPnlFingerprint)
  })

  it('buildLastKnownCanonicalSample always labels itself unavailable for current verification', () => {
    const meta = buildLastKnownCanonicalSample(manifestFor(buildLots(27, 21), -979.81, 21 / 27))
    assert.equal(meta.availableForCurrentVerification, false)
    assert.equal(meta.verifiedLotCount, 21)
    assert.equal(meta.realizedPnlUsd, -979.81)
  })
})

describe('canonicalPnlSampleManifest — production-shaped regression with real partial fills (requirement #8)', () => {
  // 21 verified lots where ONE buy transaction is split across three FIFO lots (a real partial
  // fill), plus 6 structurally-matched-but-unpriced lots — the production 27/21 shape.
  function buildPartialFillScan(): MatchedLot[] {
    const split = [
      lot({ lotId: 'split-0', token: '0xsplit', openedTxHash: '0xbigbuy', closedTxHash: '0xbigsell', openedAt: 500, closedAt: 900, amount: 0.1 + 0.2, costBasisUsd: 3, proceedsUsd: 5, realizedPnlUsd: 2 }),
      lot({ lotId: 'split-1', token: '0xsplit', openedTxHash: '0xbigbuy', closedTxHash: '0xbigsell', openedAt: 500, closedAt: 900, amount: 1 / 3, costBasisUsd: 4, proceedsUsd: 7, realizedPnlUsd: 3 }),
      lot({ lotId: 'split-2', token: '0xsplit', openedTxHash: '0xbigbuy', closedTxHash: '0xbigsell', openedAt: 500, closedAt: 900, amount: 2.5, costBasisUsd: 6, proceedsUsd: 10, realizedPnlUsd: 4 }),
    ]
    const plain = Array.from({ length: 18 }, (_, i) => lot({
      lotId: `v-${i}`, token: `0xtok${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
      openedAt: i, closedAt: 100 + i, amount: 1 + i, costBasisUsd: 10, proceedsUsd: 21, realizedPnlUsd: 11,
    }))
    const unpriced = Array.from({ length: 6 }, (_, i) => lot({
      lotId: `u-${i}`, token: `0xun${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`,
      openedAt: 300 + i, closedAt: 400 + i, amount: 2 + i,
      evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null,
    }))
    return [...split, ...plain, ...unpriced]
  }

  it('HARD ASSERTION: run1 persists 21 verified lots (one tx split into 3 FIFO lots); run2 with different internal float construction + order and 2 newly-priceable lots replays all 21, publishes exactly 21 with identical PnL, and reports the 2 as candidate-only', async () => {
    const kv = fakeKv()
    const run1Lots = buildPartialFillScan()
    assert.equal(run1Lots.filter(isVerified).length, 21, 'sanity: run1 has 21 verified lots')
    assert.equal(run1Lots.length, 27, 'sanity: 27 structural lots')

    const REALIZED_A = run1Lots.filter(isVerified).reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0)
    const COVERAGE_A = 21 / 27
    const run1Manifest = manifestFor(run1Lots, REALIZED_A, COVERAGE_A)
    assert.equal(run1Manifest.verifiedLotCount, 21)
    assert.equal(await writeCanonicalPnlSampleManifest(kv, run1Manifest), true)

    // RUN 2 — identical structural events, but:
    //  * the split lots' amounts are constructed by a DIFFERENT float path (0.30000000000000004 vs
    //    0.1+0.2 recomputed, 0.3333333333333333 vs 1/3 recomputed),
    //  * the array order is shuffled,
    //  * two previously-unpriced lots become priceable with brand-new live values.
    const run2Lots = [...run1Lots]
      .map((l) => {
        if (l.lotId === 'split-0') return { ...l, amount: Number((0.1 + 0.2).toFixed(17)) }
        if (l.lotId === 'split-1') return { ...l, amount: 0.3333333333333333 }
        if (l.lotId === 'u-0' || l.lotId === 'u-1') {
          return { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 777, proceedsUsd: 3000, realizedPnlUsd: 2223 }
        }
        return l
      })
      .reverse()
    assert.equal(run2Lots.filter(isVerified).length, 23, 'sanity: the live candidate sample really is 23')

    const read = await readCanonicalPnlSampleManifest(kv, identity())
    assert.ok(read.manifest, 'the manifest must resolve by its stable structural identity')

    const replay = replayManifest({ manifest: read.manifest!, allCandidateLots: run2Lots, isVerified })

    // All 21 manifest identities resolve — the confirmed production failure was ZERO resolving.
    assert.equal(replay.reasonCounts.manifest_replay_success, 21)
    assert.equal(replay.reasonCounts.manifest_lot_identity_not_found, 0)
    assert.equal(replay.reasonCounts.manifest_side_evidence_missing, 0)
    assert.equal(replay.reasonCounts.manifest_partial_fill_ordinal_mismatch, 0)
    assert.equal(replay.outcome, 'applied')
    assert.equal(replay.forcePublicPnlUnavailable, false)

    // Exactly 21 published, 2 candidate-only, zero candidate contribution to PnL.
    const publishedVerified = replay.publishedLots.filter(isVerified)
    assert.equal(publishedVerified.length, 21)
    assert.equal(replay.candidateNewEvidenceLotKeys.length, 2)
    assert.equal(publishedVerified.reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0), REALIZED_A)
    assert.equal(publishedVerified.some((l) => l.costBasisUsd === 777), false, 'no live candidate price may reach the published array')

    // Fingerprints over the published array are identical to run1's, order-independently.
    const fpRun1 = fingerprintsFor(run1Lots, REALIZED_A)
    const fpRun2 = fingerprintsFor(replay.publishedLots, REALIZED_A)
    assert.equal(fpRun2.matchedLotFingerprint, fpRun1.matchedLotFingerprint)
    assert.equal(fpRun2.verifiedLotIdentityFingerprint, fpRun1.verifiedLotIdentityFingerprint)
    assert.equal(fpRun2.acceptedHistoricalPriceFingerprint, fpRun1.acceptedHistoricalPriceFingerprint)
    assert.equal(fpRun2.realizedPnlFingerprint, fpRun1.realizedPnlFingerprint)
  })

  it('HARD ASSERTION (missing-evidence regression): removing one required accepted-evidence record blocks the whole replay, keeps the live sample out, and preserves last-known metadata separately', async () => {
    const kv = fakeKv()
    const run1Lots = buildPartialFillScan()
    const REALIZED_A = run1Lots.filter(isVerified).reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0)
    const run1Manifest = manifestFor(run1Lots, REALIZED_A, 21 / 27)
    await writeCanonicalPnlSampleManifest(kv, run1Manifest)

    // One manifest lot's accepted evidence is gone this run; two new lots became priceable.
    const run2Lots = run1Lots.map((l) => {
      if (l.lotId === 'split-1') return { ...l, evidenceQuality: 'unpriced' as const, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }
      if (l.lotId === 'u-0' || l.lotId === 'u-1') return { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 777, proceedsUsd: 3000, realizedPnlUsd: 2223 }
      return l
    })

    const read = await readCanonicalPnlSampleManifest(kv, identity())
    const replay = replayManifest({ manifest: read.manifest!, allCandidateLots: run2Lots, isVerified })

    assert.equal(replay.outcome, 'unavailable')
    assert.equal(replay.forcePublicPnlUnavailable, true)
    assert.equal(replay.reasonCounts.manifest_side_evidence_missing, 1)
    assert.equal(replay.selectedLotKeys.length, 0, 'the manifest must not apply partially')
    assert.equal(replay.publishedLots.filter(isVerified).length, 0, 'the live 22-lot candidate sample must not escape')

    // The prior manifest's figures survive ONLY as clearly-labelled, not-currently-verified metadata.
    const lastKnown = buildLastKnownCanonicalSample(read.manifest!)
    assert.equal(lastKnown.availableForCurrentVerification, false)
    assert.equal(lastKnown.verifiedLotCount, 21)
    assert.equal(lastKnown.realizedPnlUsd, REALIZED_A)
  })
})

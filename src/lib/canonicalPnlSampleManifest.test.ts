// Regression tests for the durable canonical PnL sample manifest.
//
// Covers two confirmed production failures in sequence:
//  1. IDENTITY replay (fixed earlier): the lot identity key embedded JS float text, so FIFO
//     partial-fill amounts serialized differently between scans and zero of 21 manifest lots
//     resolved.
//  2. VALUE replay (this task): identity replay then succeeded 23/23 with stable identity
//     fingerprints, but the canonical PRICES were never frozen — the manifest carried no side
//     references or values at all, so replay republished the current scan's own prices and the
//     realized total moved 1791.71 -> 4286.93 with acceptedHistoricalPriceFingerprint 705231e0 ->
//     fd9bffdb.
//
// Run directly with: npx tsx --test src/lib/canonicalPnlSampleManifest.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildManifestIdentity, buildManifestKey, buildManifestFromCandidate, buildRefreshedManifest,
  readCanonicalPnlSampleManifest, writeCanonicalPnlSampleManifest, replayManifest, shouldRefreshPartiallyUnreproducibleManifest,
  buildManifestAdditiveGrowthAudit, shouldRefreshAdditiveCandidateEvolution, applyRefreshedCanonicalManifest,
  buildManifestAdditiveProviderDependencyAudit,
  buildCanonicalLotIdentities, canonicalAmountString, dedupeKeys, logDuplicateIdentityIfAny,
  buildLastKnownCanonicalSample, buildScanWindowIdentity, buildChainScope, normalizeWalletAddress,
  CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION, CANONICAL_VALUE_METHODOLOGY_VERSION, CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
  splitGroupTotalAcrossOccurrences, buildFingerprintMismatchDiagnostic, stablecoinNormalizedGroupTotal,
  demoteLotsOnIncompleteAcceptedSides, lotsOnIncompleteAcceptedSides, acceptedEvidenceIdentityKeysForLot,
  acceptedEvidenceAllocationsAreCanonicalPositive,
  CANONICAL_VALUE_TOLERANCE, groupCompositionFingerprint,
  type CanonicalSampleManifestKvLike, type AcceptedEvidenceLoader, type CanonicalPnlSampleManifest,
} from './canonicalPnlSampleManifest.ts'
import { buildScanDeterminismAudit } from './scanDeterminismAudit.ts'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot.ts'
import {
  buildAcceptedEvidenceEnvelope, buildAcceptedEvidenceKey, lotIdentityVersion, readAcceptedEvidence,
  readAcceptedEvidenceAnyLotVersion, ACCEPTED_EVIDENCE_SCHEMA_VERSION,
  type AcceptedEvidenceKvLike,
} from './acceptedEvidenceStore.ts'
import type { MatchedLot } from '../modules/fifoEngine/types'
import { buildCanonicalPnlDiffAudit } from './canonicalPnlDiffAudit.ts'

const NOW = 1_000_000
const roundCents = (n: number) => Math.round(n * 100) / 100

function fakeKv(): CanonicalSampleManifestKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

// REAL JSON-SERIALIZING KV, DISCLOSED (canonical-manifest-fast-path follow-up task, issue #4 —
// "reload from persisted JSON/KV. Do not test only in-memory objects"). Every other `fakeKv`/
// `seededEvidence` helper in this file stores the raw JS object BY REFERENCE — a genuine
// serialization bug (a field that doesn't round-trip through JSON, e.g. `undefined`) could hide
// behind that shortcut forever. This wrapper forces every write through `JSON.stringify` and every
// read back through `JSON.parse`, the same encoding a real Redis-backed KV performs, so any manifest
// record or accepted-evidence envelope actually persisted here is proven byte-for-byte reconstructable
// from its own serialized form — not just a live object reference surviving in memory.
function jsonKv(): CanonicalSampleManifestKvLike & AcceptedEvidenceKvLike & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    get: async <T>(key: string) => (raw.has(key) ? (JSON.parse(raw.get(key)!) as T) : null),
    set: async (key: string, value: unknown) => { raw.set(key, JSON.stringify(value)); return 'OK' },
  }
}

// A real accepted-evidence store seeded from a lot array, read back through the REAL
// readAcceptedEvidence — so identity/side/timestamp/lot-identity-version/schema validation and
// expiry are all genuinely exercised, never stubbed past.
function seededEvidence(lots: readonly MatchedLot[]) {
  const store = new Map<string, unknown>()
  const kv: AcceptedEvidenceKvLike = {
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
  const identityFor = (lot: MatchedLot, side: 'entry' | 'exit') => ({
    chain: lot.chain, token: lot.token,
    txHash: side === 'entry' ? lot.openedTxHash : lot.closedTxHash,
    side, timestamp: side === 'entry' ? lot.openedAt : lot.closedAt,
    lotIdentityVersion: lotIdentityVersion(lot),
  })
  const keyFor = (lot: MatchedLot, side: 'entry' | 'exit') => buildAcceptedEvidenceKey(identityFor(lot, side))
  for (const lot of lots) {
    if (!isCanonicalVerifiedPublishedLot(lot)) continue
    for (const side of ['entry', 'exit'] as const) {
      const priceUsd = (side === 'entry' ? lot.costBasisUsd : lot.proceedsUsd) as number
      const identity = identityFor(lot, side)
      store.set(buildAcceptedEvidenceKey(identity), buildAcceptedEvidenceEnvelope({
        identity, priceUsd, valueUsd: priceUsd * lot.amount,
        source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
      }))
    }
  }
  const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
    version === null
      ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
      : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)
  return { store, kv, loader, keyFor }
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

function identity(matchedLotFingerprint = 'fp1') {
  return buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint })
}

// Builds a manifest whose stored realized total is the REAL cent-rounded sum of its own lots, whose
// fingerprints are computed over the full structural array, and whose per-lot records carry the
// canonical side references — i.e. exactly what a real creation scan writes. Returns the matching
// seeded evidence store so a replay can be driven against it.
async function manifestWithEvidence(allLots: readonly MatchedLot[], manifestIdentity = identity()) {
  const evidence = seededEvidence(allLots)
  const verified = allLots.filter(isCanonicalVerifiedPublishedLot)
  const manifest = await buildManifestFromCandidate({
    identity: manifestIdentity, allCandidateLots: allLots, candidateVerifiedLots: verified,
    structuralLotCount: allLots.length,
    // `fingerprints`/`realizedPnlUsd` here are only the LEGACY FALLBACK (used when no
    // evidence/allocation happens) — with `loadEvidence` + `computeFingerprints` both supplied, the
    // real, self-consistent total and fingerprints are recomputed internally from the ALLOCATED
    // per-lot values (Part A), never from this fixture's own pre-allocation numbers.
    fingerprints: computeFingerprints(allLots, realizedTotal(allLots)),
    realizedPnlUsd: realizedTotal(allLots),
    verifiedPricingCoverage: allLots.length > 0 ? verified.length / allLots.length : null,
    now: 1000, loadEvidence: evidence.loader, computeFingerprints,
  })
  return { manifest, evidence, total: manifest.realizedPnlUsd }
}

function replay(manifest: CanonicalPnlSampleManifest, allCandidateLots: readonly MatchedLot[], loadEvidence: AcceptedEvidenceLoader) {
  return replayManifest({ manifest, allCandidateLots, loadEvidence, computeFingerprints })
}

describe('canonicalPnlSampleManifest — lot identity (float-free, partial-fill ordinals)', () => {
  it('CORRECTED (canonical-manifest-shared-group-allocation follow-up task): a verified partial fill still publishes its own conserving share even when its entry side is shared with an unverified sibling', async () => {
    const verified = lot({ lotId: 'verified', amount: 4, closedTxHash: '0xsell-a' })
    const unverifiedSibling = lot({
      lotId: 'unverified', amount: 6, closedTxHash: '0xsell-b', closedAt: 3,
      proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    })
    const { loader } = seededEvidence([verified])
    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: [verified, unverifiedSibling], candidateVerifiedLots: [verified],
      structuralLotCount: 2, fingerprints: computeFingerprints([verified], 2), realizedPnlUsd: 2,
      verifiedPricingCoverage: 0.5, now: NOW, loadEvidence: loader, computeFingerprints,
    })

    // `verified` (amount 4) shares its entry ($10 total) with `unverifiedSibling` (amount 6) —
    // allocation gives `verified` its own real 4/10 share ($4), never the unverified sibling's $6,
    // never the full $10. Exit is not shared (distinct closedTxHash), so verified's own $12 exit
    // evidence publishes in full. This is a correct, conserving partial publication — not the
    // `group_total_does_not_equal_accepted_side_total` failure the old blanket-demotion policy
    // conflated it with (see canonicalPnlSampleManifest.ts's own "WHOLE-GROUP DEMOTION REMOVED"
    // header — confirmed production regression: this exact pattern collapsed a live 108-candidate
    // scan to 37 published lots).
    assert.equal(manifest.verifiedLotCount, 1, 'the verified partial fill publishes its own real share')
    assert.equal(manifest.verifiedLotRecords[0].costBasisUsd, 4)
    assert.equal(manifest.verifiedLotRecords[0].proceedsUsd, 12)
    const audit = buildCanonicalPnlDiffAudit({ currentRecords: manifest.verifiedLotRecords, previousRecords: [] })
    assert.equal(audit.findings.filter((finding) => finding.severity === 'critical').length, 0)
  })

  it('HARD ASSERTION: a float-noise difference in a partial fill\'s amount never changes the identity key', () => {
    const clean = lot({ amount: 0.3 })
    const noisy = lot({ amount: 0.1 + 0.2 })
    assert.notEqual(String(clean.amount), String(noisy.amount), 'sanity: the raw float text really does differ')
    assert.equal(
      [...buildCanonicalLotIdentities([clean]).values()][0].key,
      [...buildCanonicalLotIdentities([noisy]).values()][0].key,
    )
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
  })

  it('partial fills get distinct, construction-order-independent ordinals assigned over the FULL array', () => {
    const a = lot({ lotId: 'a', amount: 2 })
    const b = lot({ lotId: 'b', amount: 3 })
    const forward = buildCanonicalLotIdentities([a, b])
    const reversed = buildCanonicalLotIdentities([b, a])
    assert.notEqual(forward.get(a)!.key, forward.get(b)!.key)
    assert.equal(reversed.get(a)!.key, forward.get(a)!.key)
    assert.equal(forward.get(a)!.partialFillGroupSize, 2)
  })

  it('a slice\'s identity does not shift when a sibling slice becomes priced', () => {
    const a = lot({ lotId: 'a', amount: 2 })
    const unpricedSibling = lot({ lotId: 'b', amount: 3, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null })
    const before = buildCanonicalLotIdentities([a, unpricedSibling]).get(a)!.key
    const pricedSibling = { ...unpricedSibling, evidenceQuality: 'verified' as const, costBasisUsd: 5, proceedsUsd: 9, realizedPnlUsd: 4 }
    assert.equal(buildCanonicalLotIdentities([a, pricedSibling]).get(a)!.key, before)
  })
})

describe('canonicalPnlSampleManifest — canonical side references (requirement #1)', () => {
  it('every manifest lot record carries its accepted-evidence keys, canonical side values and source metadata', async () => {
    const lots = buildLots(3, 3)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    assert.equal(manifest.verifiedLotRecords.length, 3)
    for (const record of manifest.verifiedLotRecords) {
      const source = lots.find((l) => l.openedTxHash === record.openedTxHash)!
      assert.equal(record.entryEvidenceKey, evidence.keyFor(source, 'entry'))
      assert.equal(record.exitEvidenceKey, evidence.keyFor(source, 'exit'))
      assert.equal(record.entryPriceUsd, source.costBasisUsd)
      assert.equal(record.exitPriceUsd, source.proceedsUsd)
      assert.equal(record.costBasisUsd, source.costBasisUsd)
      assert.equal(record.proceedsUsd, source.proceedsUsd)
      assert.equal(record.realizedPnlUsd, source.realizedPnlUsd)
      assert.equal(record.evidenceQuality, 'verified')
      assert.equal(record.entrySource, 'test-source')
      assert.equal(record.exitSource, 'test-source')
      assert.equal(record.pricingMethodologyVersion, manifest.pricingMethodologyVersion)
      assert.equal(record.evidenceSchemaVersion, ACCEPTED_EVIDENCE_SCHEMA_VERSION)
      assert.equal(typeof record.lotIdentityVersion, 'string')
    }
  })

  it('the schema version is 4 — a v2 manifest genuinely lacks the side references replay now requires', async () => {
    assert.equal(CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION, 4)
    const kv = fakeKv()
    const { manifest } = await manifestWithEvidence(buildLots(2, 2))
    await kv.set(buildManifestKey(identity()), { ...manifest, manifestSchemaVersion: 2 })
    assert.equal((await readCanonicalPnlSampleManifest(kv, identity())).manifest, null, 'a v2 manifest is never replayed under the v3 identity')
  })

  it('without an evidence loader, source metadata is honestly null and no value is fabricated', async () => {
    const lots = buildLots(2, 2)
    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: lots, candidateVerifiedLots: lots,
      structuralLotCount: lots.length, fingerprints: computeFingerprints(lots, realizedTotal(lots)),
      realizedPnlUsd: realizedTotal(lots), verifiedPricingCoverage: 1, now: 1000,
    })
    for (const record of manifest.verifiedLotRecords) {
      assert.equal(record.entrySource, null)
      assert.equal(record.exitSource, null)
      assert.equal(record.entryValueUsd, null)
      assert.ok(record.entryEvidenceKey.length > 0, 'the evidence REFERENCE is still recorded')
    }
  })
})

describe('canonicalPnlSampleManifest — read/write, fail-closed', () => {
  it('round-trips a written manifest', async () => {
    const kv = fakeKv()
    const { manifest } = await manifestWithEvidence(buildLots(3, 3))
    assert.equal(await writeCanonicalPnlSampleManifest(kv, manifest), true)
    const result = await readCanonicalPnlSampleManifest(kv, identity())
    assert.deepEqual(result.manifest, manifest)
    assert.equal(result.validationFailure, false)
  })

  // V3 -> V4 MIGRATION SAFETY, DISCLOSED (pre-merge schema-bump audit): proves the EXACT production
  // shape — a literal, persisted 37-lot v3 manifest for the regression wallet — entering v4 code.
  it('HARD ASSERTION (pre-merge v3->v4 migration safety): a literal persisted v3 37-lot manifest is never read, mutated, or deleted by v4 code — it orphans cleanly under a distinct key, coexists untouched, and a fresh v4 manifest can be built independently alongside it', async () => {
    const kv = fakeKv()
    const v3Identity = buildManifestIdentity({
      walletAddress: '0x4dbb3835744b2976560e0259cb218cab89abef96', chains: ['base'], configuredWindowDays: 90,
      matchedLotFingerprint: 'fp-v3-production', manifestSchemaVersion: 3,
    })
    const v4Identity = buildManifestIdentity({
      walletAddress: '0x4dbb3835744b2976560e0259cb218cab89abef96', chains: ['base'], configuredWindowDays: 90,
      matchedLotFingerprint: 'fp-v3-production',
    })
    assert.equal(v4Identity.manifestSchemaVersion, CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION)
    assert.notEqual(v3Identity.manifestSchemaVersion, v4Identity.manifestSchemaVersion)

    // The KV KEY itself differs (the schema version is embedded in it) — a v3 record and a v4
    // record for the SAME wallet/window/fingerprint occupy entirely separate KV slots.
    const v3Key = buildManifestKey(v3Identity)
    const v4Key = buildManifestKey(v4Identity)
    assert.notEqual(v3Key, v4Key)
    assert.ok(v3Key.endsWith(':s3'))
    assert.ok(v4Key.endsWith(`:s${CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION}`))

    // Persist a literal 37-lot v3 manifest — the exact production shape.
    const lots37 = buildLots(37, 37)
    const { manifest: v3Manifest } = await manifestWithEvidence(lots37, v3Identity)
    assert.equal(v3Manifest.verifiedLotCount, 37)
    assert.equal(await writeCanonicalPnlSampleManifest(kv, v3Manifest), true)

    // v4 code reading under the v4 identity gets a CLEAN MISS — never validationFailure (which would
    // imply corruption) — because the v3 record simply lives at a different key it never touches.
    const v4Read = await readCanonicalPnlSampleManifest(kv, v4Identity)
    assert.equal(v4Read.manifest, null, 'a v3 record is invisible to a v4 read — never silently reinterpreted')
    assert.equal(v4Read.validationFailure, false, 'a schema-version orphan is a real miss, never reported as corruption')

    // The v3 record itself is completely untouched — still readable, byte-identical, under its OWN
    // v3 identity. v4 code never deletes or mutates it.
    const v3ReadBack = await readCanonicalPnlSampleManifest(kv, v3Identity)
    assert.deepEqual(v3ReadBack.manifest, v3Manifest, 'the persisted v3 manifest survives a v4 deploy completely unmodified')

    // A fresh v4 manifest built from the SAME 37 lots is created independently, at the v4 key,
    // without ever reading, overwriting, or invalidating the coexisting v3 record.
    const v4Manifest = await buildManifestFromCandidate({
      identity: v4Identity, allCandidateLots: lots37, candidateVerifiedLots: lots37.filter(isCanonicalVerifiedPublishedLot),
      structuralLotCount: lots37.length, fingerprints: computeFingerprints(lots37, realizedTotal(lots37)),
      realizedPnlUsd: realizedTotal(lots37), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: (await manifestWithEvidence(lots37, v3Identity)).evidence.loader, computeFingerprints,
    })
    assert.equal(v4Manifest.verifiedLotCount, 37, 'the fresh v4 manifest independently reproduces the full 37-lot sample from the SAME live evidence')
    assert.equal(await writeCanonicalPnlSampleManifest(kv, v4Manifest), true)
    const v3StillThere = await readCanonicalPnlSampleManifest(kv, v3Identity)
    assert.deepEqual(v3StillThere.manifest, v3Manifest, 'writing the new v4 manifest never touches the coexisting v3 record')
  })

  // V3->V4 MIGRATION MECHANISM, DISCLOSED (v3->v4 canonical manifest migration follow-up task):
  // exercises the EXACT sequence pipeline/index.ts's migration block runs — replay the old manifest
  // against current candidates (structural-integrity gate), reconstruct via buildRefreshedManifest
  // (never a blind copy — entirely from current candidates + live evidence), confirm via a second
  // replay, then write only on a confirmed 'applied' outcome — using the same functions this whole
  // module already exports and every other refresh path already relies on.
  it('HARD ASSERTION: a valid migration on the confirmed production 37-v3/30-current shape carries the prior sample forward deterministically — the 30 reproducible lots migrate, the 7 no-longer-present ones are honestly counted as rejected, never a crash or a silent whole-sample loss', async () => {
    const v3Identity = buildManifestIdentity({
      walletAddress: '0x4dbb3835744b2976560e0259cb218cab89abef96', chains: ['base'], configuredWindowDays: 90,
      matchedLotFingerprint: 'fp-migration-production', manifestSchemaVersion: 3,
    })
    const v4Identity = buildManifestIdentity({
      walletAddress: '0x4dbb3835744b2976560e0259cb218cab89abef96', chains: ['base'], configuredWindowDays: 90,
      matchedLotFingerprint: 'fp-migration-production',
    })
    const lots37 = buildLots(37, 37)
    const { manifest: v3Manifest, evidence } = await manifestWithEvidence(lots37, v3Identity)
    assert.equal(v3Manifest.verifiedLotCount, 37)

    // THIS scan's own current candidates: only 30 of the original 37 structural lots are present —
    // the exact confirmed production shape (history truncated this scan, 7 lots simply absent from
    // the current structural set, never corrupted).
    const currentLots30 = lots37.slice(0, 30)

    // Step 1: the OLD manifest's own first replay against CURRENT candidates — the structural-
    // integrity gate that decides whether migration may proceed at all.
    const priorReplay = await replay(v3Manifest, currentLots30, evidence.loader)
    assert.equal(priorReplay.manifestStructuralFailureAudit.structuralFailure, false, 'lots simply absent this scan (never corrupted) must not register as a structural integrity failure')

    // Step 2/3/4: reconstruct — buildRefreshedManifest, informed by the prior v3 manifest for
    // version-chaining ONLY, built entirely from THIS scan's current candidates and live evidence.
    const migratedCandidate = await buildRefreshedManifest({
      priorManifest: v3Manifest, identity: v4Identity, allCandidateLots: currentLots30,
      candidateVerifiedLots: currentLots30.filter(isCanonicalVerifiedPublishedLot), structuralLotCount: currentLots30.length,
      fingerprints: computeFingerprints(currentLots30, realizedTotal(currentLots30)), realizedPnlUsd: realizedTotal(currentLots30),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'schema-migration-previous-version-carried-forward',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    assert.equal(migratedCandidate.manifestSchemaVersion, CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION, 'the migrated manifest is written under the NEW schema identity, never the old one')
    assert.equal(migratedCandidate.verifiedLotCount, 30, 'reconstructed entirely from THIS scan\'s own 30 current candidates and live evidence — never a blind copy inflating it back to 37')

    // Step 5: confirm via a REAL second replay — only a confirmed 'applied' outcome is ever durable.
    const confirmReplay = await replay(migratedCandidate, currentLots30, evidence.loader)
    assert.equal(confirmReplay.outcome, 'applied', 'a genuinely self-consistent migrated manifest must replay cleanly against the exact candidates it was built from')

    // Deterministic reproduction: exactly the 30 reproducible old lots migrated; the other 7 are
    // honestly counted as rejected, never silently vanished without a trace.
    const previousLotKeys = new Set(v3Manifest.verifiedLotIdentityKeys)
    const migratedLotKeys = new Set(migratedCandidate.verifiedLotIdentityKeys)
    const migratedLots = [...previousLotKeys].filter((key) => migratedLotKeys.has(key)).length
    const rejectedLots = previousLotKeys.size - migratedLots
    assert.equal(migratedLots, 30, 'exactly the 30 lots this scan could still structurally reproduce migrated')
    assert.equal(rejectedLots, 7, 'the 7 lots absent from this scan\'s structural set are honestly rejected, not silently dropped from the count')

    const kv = fakeKv()
    assert.equal(await writeCanonicalPnlSampleManifest(kv, migratedCandidate), true)
    const v4ReadBack = await readCanonicalPnlSampleManifest(kv, v4Identity)
    assert.deepEqual(v4ReadBack.manifest, migratedCandidate, 'the migrated manifest round-trips cleanly under its new v4 key')
  })

  it('companion — genuine value corruption on the prior v3 manifest is caught by the structural-integrity gate and must block migration, never silently promoted to v4', async () => {
    const v3Identity = buildManifestIdentity({
      walletAddress: '0xmigrationcorrupt', chains: ['base'], configuredWindowDays: 90,
      matchedLotFingerprint: 'fp-migration-corrupt', manifestSchemaVersion: 3,
    })
    const corruptedLot = lot({
      lotId: 'corrupted', token: '0xmigrationcorrupt', openedTxHash: '0xbuy', closedTxHash: '0xsell',
      openedAt: 1, closedAt: 2, amount: 10, costBasisUsd: 40, proceedsUsd: 100, realizedPnlUsd: 60,
    })
    const { manifest: v3Manifest, evidence } = await manifestWithEvidence([corruptedLot], v3Identity)
    assert.equal(v3Manifest.verifiedLotCount, 1)

    // The accepted-evidence record itself is rewritten to a materially different value — a genuine
    // value change on the IDENTICAL lot the v3 manifest was built from, never a legitimate candidate
    // evolution (same single-member group, no sibling ever joins it).
    const exitIdentity = { chain: 'base', token: '0xmigrationcorrupt', txHash: '0xsell', side: 'exit' as const, timestamp: 2, lotIdentityVersion: lotIdentityVersion(corruptedLot) }
    evidence.store.set(buildAcceptedEvidenceKey(exitIdentity), buildAcceptedEvidenceEnvelope({
      identity: exitIdentity, priceUsd: 999, valueUsd: 999,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))

    // Step 1: the structural-integrity gate — this is exactly what pipeline/index.ts's migration
    // block checks BEFORE ever attempting a reconstruction.
    const priorReplay = await replay(v3Manifest, [corruptedLot], evidence.loader)
    assert.equal(priorReplay.outcome, 'unavailable')
    assert.equal(priorReplay.manifestStructuralFailureAudit.structuralFailure, true, 'a genuine value change must register as a structural integrity failure — this is what blocks migration outright')
    assert.ok((priorReplay.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0) > 0)
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

  it('a stale lot-identity schema version is rejected', async () => {
    const kv = fakeKv()
    const { manifest } = await manifestWithEvidence(buildLots(2, 2))
    await kv.set(buildManifestKey(identity()), { ...manifest, lotIdentitySchemaVersion: 1 })
    const result = await readCanonicalPnlSampleManifest(kv, identity())
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, true)
  })

  it('a structural fingerprint change is a real miss, never a reuse and never corruption', async () => {
    const kv = fakeKv()
    const { manifest } = await manifestWithEvidence(buildLots(2, 2))
    await writeCanonicalPnlSampleManifest(kv, manifest)
    const result = await readCanonicalPnlSampleManifest(kv, identity('fp-after'))
    assert.equal(result.manifest, null)
    assert.equal(result.validationFailure, false)
  })

  it('KV outage fails open on read and returns false on write, never throwing', async () => {
    const broken: CanonicalSampleManifestKvLike = { get: async () => { throw new Error('down') }, set: async () => { throw new Error('down') } }
    const read = await readCanonicalPnlSampleManifest(broken, identity())
    assert.equal(read.manifest, null)
    assert.equal(read.validationFailure, false)
    const { manifest } = await manifestWithEvidence(buildLots(1, 1))
    assert.equal(await writeCanonicalPnlSampleManifest(broken, manifest), false)
  })

  it('normalizes wallet address / chain scope; scan-window identity ignores wall-clock time', () => {
    assert.equal(normalizeWalletAddress(' 0xAbC '), '0xabc')
    assert.equal(buildChainScope(['Base', 'eth', 'base']), 'base,eth')
    assert.equal(
      buildScanWindowIdentity({ configuredWindowDays: 90, pricingMethodologyVersion: 1 }),
      buildScanWindowIdentity({ configuredWindowDays: 90, pricingMethodologyVersion: 1 }),
    )
  })
})

describe('canonicalPnlSampleManifest — deduplication (requirement #2)', () => {
  it('dedupeKeys canonicalizes, sorts and deduplicates, reporting the real duplicates', () => {
    const result = dedupeKeys(['b', 'a', 'b', 'c', 'a'])
    assert.deepEqual(result.unique, ['a', 'b', 'c'])
    assert.deepEqual(result.duplicates, ['a', 'b'])
  })

  it('partial fills sharing one tx pair dedupe their shared evidence keys but keep distinct lot identities', async () => {
    const fills = [lot({ lotId: 'a', amount: 2 }), lot({ lotId: 'b', amount: 3 })]
    const { manifest } = await manifestWithEvidence(fills)
    assert.equal(manifest.acceptedEvidenceIdentityKeys.length, new Set(manifest.acceptedEvidenceIdentityKeys).size)
    assert.equal(manifest.verifiedLotIdentityKeys.length, 2)
    assert.equal(manifest.verifiedLotCount, 2)
  })

  it('a duplicate lot key logs CRITICAL canonical_manifest_duplicate_identity and fails replay closed', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    const corrupted = { ...manifest, verifiedLotIdentityKeys: [...manifest.verifiedLotIdentityKeys, manifest.verifiedLotIdentityKeys[0]] }

    const result = await replay(corrupted, lots, evidence.loader)
    assert.equal(result.duplicates.hasDuplicates, true)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.reasonCounts.manifest_duplicate_identity, 1)

    const errors: unknown[][] = []
    logDuplicateIdentityIfAny(result.duplicates, { error: (...args: unknown[]) => { errors.push(args) } })
    assert.equal(errors[0][0], 'CRITICAL canonical_manifest_duplicate_identity')
  })
})

describe('canonicalPnlSampleManifest — value replay + reason codes (requirements #2, #3, #7)', () => {
  it('an unchanged rescan replays every lot from accepted evidence and publishes the manifest sample', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence, total } = await manifestWithEvidence(lots)
    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_replay_success, 12)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 12)
    assert.equal(result.recomputedRealizedPnlUsd, total)
    assert.deepEqual(result.manifestReplayedButNotCanonicalVerifiedLotKeys, [])
  })

  it('HARD ASSERTION (the exact production bug): current provider prices are REJECTED and manifest accepted values are published', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence, total } = await manifestWithEvidence(lots)

    // Run 2: every side now resolves to a completely different live provider price.
    const drifted = lots.map((l) => ({ ...l, costBasisUsd: 500, proceedsUsd: 900, realizedPnlUsd: 400 }))
    const result = await replay(manifest, drifted, evidence.loader)

    assert.equal(result.outcome, 'applied', 'a pure price drift must still replay — the manifest values are restorable')
    const published = result.publishedLots.filter(isCanonicalVerifiedPublishedLot)
    assert.equal(published.length, 12)
    assert.equal(published.some((l) => l.costBasisUsd === 500 || l.proceedsUsd === 900), false, 'no live provider value may survive into the published array')
    for (const l of published) {
      const original = lots.find((o) => o.openedTxHash === l.openedTxHash)!
      assert.equal(l.costBasisUsd, original.costBasisUsd)
      assert.equal(l.proceedsUsd, original.proceedsUsd)
      assert.equal(l.realizedPnlUsd, original.realizedPnlUsd)
    }
    assert.equal(result.recomputedRealizedPnlUsd, total, 'the frozen total is re-derived by summing the rebuilt lots')
    assert.equal(result.recomputedFingerprints!.acceptedHistoricalPriceFingerprint, manifest.acceptedHistoricalPriceFingerprint)
    assert.equal(result.recomputedFingerprints!.realizedPnlFingerprint, manifest.realizedPnlFingerprint)
    assert.equal(result.recomputedFingerprints!.verifiedLotIdentityFingerprint, manifest.verifiedLotIdentityFingerprint)
  })

  it('a side whose accepted-evidence record is gone reports manifest_side_evidence_missing and fails closed', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    evidence.store.delete(evidence.keyFor(lots[3], 'entry'))

    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.reasonCounts.manifest_side_evidence_missing, 1)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0)
    assert.equal(result.recomputedRealizedPnlUsd, null)
  })

  it('HARD ASSERTION: a CORRUPTED accepted side price is caught by value validation, never published', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    // The record still validates structurally, but its price no longer matches the frozen canonical
    // value — the manifest's own stored number must NOT be used to paper over this.
    const key = evidence.keyFor(lots[4], 'exit')
    const envelope = evidence.store.get(key) as { priceUsd: number }
    evidence.store.set(key, { ...envelope, priceUsd: envelope.priceUsd + 123.45 })

    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.ok(
      result.reasonCounts.manifest_exit_price_mismatch > 0 || result.reasonCounts.manifest_proceeds_mismatch > 0,
      'a corrupted accepted price must surface as an explicit value mismatch',
    )
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0, 'no live PnL may escape')
    assert.equal(result.recomputedRealizedPnlUsd, null)
  })

  it('a manifest whose stored total disagrees with its own lots fails on manifest_realized_total_mismatch', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    const tampered = { ...manifest, realizedPnlUsd: (manifest.realizedPnlUsd ?? 0) + 500 }
    const result = await replay(tampered, lots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.reasonCounts.manifest_realized_total_mismatch, 1)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0)
  })

  it('a manifest whose stored fingerprints disagree with the rebuilt array fails on manifest_fingerprint_mismatch', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    const tampered = { ...manifest, acceptedHistoricalPriceFingerprint: 'deadbeef' }
    const result = await replay(tampered, lots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.ok(result.reasonCounts.manifest_fingerprint_mismatch > 0)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0)
  })

  it('a manifest lot whose structural identity vanished reports manifest_lot_identity_not_found', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    const result = await replay(manifest, lots.slice(0, 11), evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.reasonCounts.manifest_lot_identity_not_found, 1)
  })

  it('a partial fill that splits differently fails closed', async () => {
    const twoSlices = [lot({ lotId: 'a', amount: 2 }), lot({ lotId: 'b', amount: 3 })]
    const { manifest } = await manifestWithEvidence(twoSlices)
    const merged = [lot({ lotId: 'merged', amount: 5 })]
    const result = await replay(manifest, merged, seededEvidence(merged).loader)
    assert.equal(result.outcome, 'unavailable')
    assert.ok(result.reasonCounts.manifest_partial_fill_ordinal_mismatch + result.reasonCounts.manifest_lot_identity_not_found > 0)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0)
  })

  it('with no loadable evidence at all, replay fails closed rather than trusting the manifest\'s own numbers', async () => {
    const lots = buildLots(12, 12)
    const { manifest } = await manifestWithEvidence(lots)
    const emptyLoader: AcceptedEvidenceLoader = async () => null
    const result = await replay(manifest, lots, emptyLoader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.reasonCounts.manifest_side_evidence_missing, 12)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0)
  })

  it('every reason code is always present in the counts object, so a zero is a real measured zero', async () => {
    const lots = buildLots(12, 12)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    const result = await replay(manifest, lots, evidence.loader)
    for (const code of [
      'manifest_lot_identity_not_found', 'manifest_side_evidence_missing', 'manifest_side_evidence_invalid',
      'manifest_partial_fill_ordinal_mismatch', 'manifest_duplicate_identity', 'manifest_candidate_only_lot',
      'manifest_replay_success', 'manifest_entry_price_mismatch', 'manifest_exit_price_mismatch',
      'manifest_cost_basis_mismatch', 'manifest_proceeds_mismatch', 'manifest_realized_pnl_mismatch',
      'manifest_evidence_quality_mismatch', 'manifest_canonical_verifier_rejection',
      'manifest_realized_total_mismatch', 'manifest_fingerprint_mismatch',
    ] as const) {
      assert.equal(typeof result.reasonCounts[code], 'number', `${code} must always be reported`)
    }
  })
})

describe('canonicalPnlSampleManifest — refresh (requirement #9: explicit only)', () => {
  it('an explicit refresh creates a new version, links the prior one, and may change fingerprints', async () => {
    const run1Lots = buildLots(27, 21)
    const { manifest: prior } = await manifestWithEvidence(run1Lots)
    const expanded = run1Lots.map((l, i) => (i === 21 || i === 22)
      ? { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 5, proceedsUsd: 9, realizedPnlUsd: 4 }
      : l)
    const expandedEvidence = seededEvidence(expanded)

    const refreshed = await buildRefreshedManifest({
      priorManifest: prior, identity: identity(), allCandidateLots: expanded,
      candidateVerifiedLots: expanded.filter(isCanonicalVerifiedPublishedLot), structuralLotCount: expanded.length,
      fingerprints: computeFingerprints(expanded, realizedTotal(expanded)), realizedPnlUsd: realizedTotal(expanded),
      verifiedPricingCoverage: 23 / 27, now: 2000, refreshReason: 'explicit-refresh',
      loadEvidence: expandedEvidence.loader,
    })

    assert.equal(refreshed.manifestVersion, 2)
    assert.equal(refreshed.priorManifestVersion, 1)
    assert.equal(refreshed.verifiedLotCount, 23)
    assert.equal(refreshed.createdAt, prior.createdAt, 'createdAt tracks lineage, not the refresh event')
    assert.equal(refreshed.refreshedAt, 2000)
    assert.notEqual(refreshed.realizedPnlFingerprint, prior.realizedPnlFingerprint)
  })

  it('buildLastKnownCanonicalSample always labels itself unavailable for current verification', async () => {
    const lots = buildLots(27, 21)
    const { manifest, total } = await manifestWithEvidence(lots)
    const meta = buildLastKnownCanonicalSample(manifest)
    assert.equal(meta.availableForCurrentVerification, false)
    assert.equal(meta.verifiedLotCount, 21)
    assert.equal(meta.realizedPnlUsd, total)
  })
})

describe('canonicalPnlSampleManifest — production-shaped regression (requirement #9)', () => {
  // 23 verified lots where one buy tx is split across three FIFO lots (a real partial fill), plus
  // 4 structurally-matched-but-unpriced lots — the production 27/23 shape.
  function buildProductionScan(): MatchedLot[] {
    const split = [
      // REALISTIC PARTIAL FILL: three FIFO slices of ONE buy tx closed by ONE sell tx. They share
      // both accepted-evidence records — and therefore both per-side prices — because this codebase
      // treats costBasisUsd/proceedsUsd as the accepted per-side PRICE of that transaction (see
      // pnlReconciliation's hydrateFromAcceptedEvidence). Only the matched AMOUNT differs per slice.
      lot({ lotId: 'split-0', token: '0xsplit', openedTxHash: '0xbigbuy', closedTxHash: '0xbigsell', openedAt: 500, closedAt: 900, amount: 0.1 + 0.2, costBasisUsd: 3.25, proceedsUsd: 5.5, realizedPnlUsd: 2.25 }),
      lot({ lotId: 'split-1', token: '0xsplit', openedTxHash: '0xbigbuy', closedTxHash: '0xbigsell', openedAt: 500, closedAt: 900, amount: 1 / 3, costBasisUsd: 3.25, proceedsUsd: 5.5, realizedPnlUsd: 2.25 }),
      lot({ lotId: 'split-2', token: '0xsplit', openedTxHash: '0xbigbuy', closedTxHash: '0xbigsell', openedAt: 500, closedAt: 900, amount: 2.5, costBasisUsd: 3.25, proceedsUsd: 5.5, realizedPnlUsd: 2.25 }),
    ]
    const plain = Array.from({ length: 20 }, (_, i) => lot({
      lotId: `v-${i}`, token: `0xtok${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
      openedAt: i, closedAt: 100 + i, amount: 1 + i,
      costBasisUsd: 10 + i * 0.5, proceedsUsd: 21 + i * 0.75, realizedPnlUsd: 11 + i * 0.25,
    }))
    const unpriced = Array.from({ length: 4 }, (_, i) => lot({
      lotId: `u-${i}`, token: `0xun${i}`, openedTxHash: `0xub${i}`, closedTxHash: `0xus${i}`,
      openedAt: 300 + i, closedAt: 400 + i, amount: 2 + i,
      evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null,
    }))
    return [...split, ...plain, ...unpriced]
  }

  it('HARD ASSERTION: run 1 creates a 23-lot manifest with exact accepted side values; run 2 with different provider prices, recovered evidenceQuality labels and 2 newly-priceable lots publishes the EXACT manifest values, 23 canonical verified lots, frozen coverage and total A, and all three fingerprints identical', async () => {
    const kv = fakeKv()
    const run1Lots = buildProductionScan()
    assert.equal(run1Lots.length, 27)
    assert.equal(run1Lots.filter(isCanonicalVerifiedPublishedLot).length, 23)

    // RUN 1 — create and persist the manifest end-to-end under the new schema.
    const { manifest: run1Manifest, evidence, total: TOTAL_A } = await manifestWithEvidence(run1Lots)
    assert.equal(run1Manifest.manifestSchemaVersion, 4)
    assert.equal(run1Manifest.verifiedLotCount, 23)
    assert.equal(run1Manifest.verifiedPricingCoverage, 23 / 27)
    assert.equal(await writeCanonicalPnlSampleManifest(kv, run1Manifest), true)

    // RUN 2 — same structural identities, but current providers return different prices for several
    // manifest sides, two previously-unpriced lots become priceable, and internal float construction
    // and array order both differ.
    const run2Lots = [...run1Lots]
      .map((l, i) => {
        if (l.lotId === 'split-0') return { ...l, amount: Number((0.1 + 0.2).toFixed(17)), costBasisUsd: 99.9, proceedsUsd: 250.5, realizedPnlUsd: 150.6 }
        if (l.lotId === 'split-1') return { ...l, amount: 0.3333333333333333, costBasisUsd: 88.8, proceedsUsd: 111.1, realizedPnlUsd: 22.3 }
        if (l.lotId === 'split-2') return { ...l, costBasisUsd: 77.7, proceedsUsd: 133.3, realizedPnlUsd: 55.6 }
        if (i >= 5 && i <= 9) return { ...l, costBasisUsd: (l.costBasisUsd ?? 0) + 42, proceedsUsd: (l.proceedsUsd ?? 0) + 77, realizedPnlUsd: (l.realizedPnlUsd ?? 0) + 35 }
        if (l.lotId === 'u-0' || l.lotId === 'u-1') return { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 777, proceedsUsd: 3000, realizedPnlUsd: 2223 }
        return l
      })
      .reverse()
    assert.equal(run2Lots.filter(isCanonicalVerifiedPublishedLot).length, 25, 'sanity: the live candidate sample really did grow and drift')

    const read = await readCanonicalPnlSampleManifest(kv, identity())
    assert.ok(read.manifest, 'the manifest must resolve by its stable structural identity')

    const result = await replay(read.manifest!, run2Lots, evidence.loader)

    // Every current provider conflict rejected; every manifest lot replayed.
    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_replay_success, 23)
    assert.equal(result.reasonCounts.manifest_lot_identity_not_found, 0)
    assert.equal(result.reasonCounts.manifest_side_evidence_missing, 0)
    assert.equal(result.reasonCounts.manifest_candidate_only_lot, 2)
    assert.deepEqual(result.manifestReplayedButNotCanonicalVerifiedLotKeys, [], 'requirement #7: empty after a successful replay')

    // Published lots carry the EXACT manifest accepted values (Part A: each partial-fill sibling's
    // own ALLOCATED share of the shared evidence total, never a flat copy and never the drifted
    // live ones) — compared against the manifest's OWN frozen per-lot records, the real source of
    // truth, not the test fixture's own pre-allocation numbers.
    const published = result.publishedLots.filter(isCanonicalVerifiedPublishedLot)
    assert.equal(published.length, 23, '23 canonical verified lots')
    assert.equal(published.some((l) => l.costBasisUsd === 99.9 || l.costBasisUsd === 88.8 || l.costBasisUsd === 777), false)
    const run1IdentityByLotId = new Map([...buildCanonicalLotIdentities(run1Lots).entries()].map(([lot, id]) => [lot.lotId, id.key]))
    const recordByKey = new Map(run1Manifest.verifiedLotRecords.map((r) => [r.key, r]))
    for (const l of published) {
      const record = recordByKey.get(run1IdentityByLotId.get(l.lotId)!)!
      assert.equal(l.costBasisUsd, record.allocatedCostBasisUsd, `${l.lotId} cost basis must be the frozen canonical allocated value`)
      assert.equal(l.proceedsUsd, record.allocatedProceedsUsd, `${l.lotId} proceeds must be the frozen canonical allocated value`)
      assert.equal(l.realizedPnlUsd, record.realizedPnlUsd)
    }
    // The three-way partial fill's allocated shares sum exactly back to the shared evidence total.
    const splitRecords = run1Manifest.verifiedLotRecords.filter((r) => r.openedTxHash === '0xbigbuy')
    assert.equal(splitRecords.length, 3)
    const splitEntryTotal = Math.round(splitRecords.reduce((s, r) => s + (r.allocatedCostBasisUsd ?? 0), 0) * 1e8) / 1e8
    assert.equal(splitEntryTotal, Math.round((evidence.store.get(splitRecords[0].entryEvidenceKey) as { priceUsd: number }).priceUsd * 1e8) / 1e8)

    // Coverage and total are DERIVED from the published array, not copied off the manifest.
    assert.equal(published.length / result.publishedLots.length, 23 / 27)
    assert.equal(result.recomputedRealizedPnlUsd, TOTAL_A)
    assert.equal(result.recomputedRealizedPnlUsd, realizedTotal(result.publishedLots))
    assert.equal(read.manifest!.realizedPnlUsd, TOTAL_A)

    // All three result fingerprints identical.
    assert.equal(result.recomputedFingerprints!.verifiedLotIdentityFingerprint, run1Manifest.verifiedLotIdentityFingerprint)
    assert.equal(result.recomputedFingerprints!.acceptedHistoricalPriceFingerprint, run1Manifest.acceptedHistoricalPriceFingerprint)
    assert.equal(result.recomputedFingerprints!.realizedPnlFingerprint, run1Manifest.realizedPnlFingerprint)
  })

  it('HARD ASSERTION (failure regression): corrupting one accepted side price makes replay fail atomically — no live PnL escapes and only last-known metadata survives', async () => {
    const kv = fakeKv()
    const run1Lots = buildProductionScan()
    const { manifest: run1Manifest, evidence, total: TOTAL_A } = await manifestWithEvidence(run1Lots)
    await writeCanonicalPnlSampleManifest(kv, run1Manifest)

    // Corrupt exactly one accepted side record, and let two new lots become priceable alongside it.
    const key = evidence.keyFor(run1Lots[7], 'entry')
    const envelope = evidence.store.get(key) as { priceUsd: number }
    evidence.store.set(key, { ...envelope, priceUsd: envelope.priceUsd * 3 })

    const run2Lots = run1Lots.map((l) => (l.lotId === 'u-0' || l.lotId === 'u-1')
      ? { ...l, evidenceQuality: 'verified' as const, costBasisUsd: 777, proceedsUsd: 3000, realizedPnlUsd: 2223 }
      : l)

    const read = await readCanonicalPnlSampleManifest(kv, identity())
    const result = await replay(read.manifest!, run2Lots, evidence.loader)

    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.forcePublicPnlUnavailable, true)
    assert.equal(result.selectedLotKeys.length, 0, 'the manifest must not apply partially')
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0, 'no live PnL may escape')
    assert.equal(result.recomputedRealizedPnlUsd, null)
    assert.equal(result.recomputedFingerprints, null)
    assert.equal(result.publishedLots.length, run2Lots.length, 'structural lots stay disclosed, just unpriced')

    const lastKnown = buildLastKnownCanonicalSample(read.manifest!)
    assert.equal(lastKnown.availableForCurrentVerification, false)
    assert.equal(lastKnown.verifiedLotCount, 23)
    assert.equal(lastKnown.realizedPnlUsd, TOTAL_A)
  })
})

describe('canonicalPnlSampleManifest — five-sibling partial-fill value allocation (Part A, requirement #8)', () => {
  it('HARD ASSERTION: five FIFO slices sharing ONE entry evidence record each replay their own exact frozen allocated value, and the five sum back to the shared accepted total', async () => {
    // Five slices of the same buy tx, closed by five DIFFERENT sells (a real "one buy consumed by
    // many sells" partial fill) — deliberately non-uniform amounts so a flat per-lot copy (the
    // confirmed bug) would be trivially distinguishable from a correct quantity-proportional split.
    const amounts = [0.5, 1.25, 0.1 + 0.2, 3, 10 / 3]
    const siblings = amounts.map((amount, i) => lot({
      lotId: `sib-${i}`, token: '0xshared', openedTxHash: '0xsharedbuy', closedTxHash: `0xsell${i}`,
      openedAt: 100, closedAt: 200 + i, amount,
      // Placeholder pre-allocation values — irrelevant once evidence-driven allocation runs.
      costBasisUsd: 1, proceedsUsd: 2, realizedPnlUsd: 1,
    }))

    const { manifest, evidence } = await manifestWithEvidence(siblings)
    const splitRecords = manifest.verifiedLotRecords
    assert.equal(splitRecords.length, 5)

    // All five resolved entryEvidenceKey to the SAME shared record.
    const uniqueEntryKeys = new Set(splitRecords.map((r) => r.entryEvidenceKey))
    assert.equal(uniqueEntryKeys.size, 1)
    const sharedEntryTotal = (evidence.store.get(splitRecords[0].entryEvidenceKey) as { priceUsd: number }).priceUsd

    // Every sibling's own allocated share sums back to the shared total, deterministically.
    const allocatedSum = Math.round(splitRecords.reduce((s, r) => s + (r.allocatedCostBasisUsd ?? 0), 0) * 1e8) / 1e8
    assert.equal(allocatedSum, Math.round(sharedEntryTotal * 1e8) / 1e8)

    // No sibling was given a flat copy of the shared total (the confirmed bug).
    for (const record of splitRecords) {
      assert.notEqual(record.allocatedCostBasisUsd, sharedEntryTotal)
      assert.equal(record.acceptedEvidenceValueType, 'total_side_value_usd')
      assert.equal(record.entrySideGroupIdentity, splitRecords[0].entryEvidenceKey)
    }

    // Replay reproduces the EXACT same five allocated values from evidence alone.
    const result = await replay(manifest, siblings, evidence.loader)
    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_replay_success, 5)
    const published = result.publishedLots.filter(isCanonicalVerifiedPublishedLot)
    assert.equal(published.length, 5)
    const recordByKey = new Map(splitRecords.map((r) => [r.key, r]))
    const identityByLotId = new Map([...buildCanonicalLotIdentities(siblings).entries()].map(([l, id]) => [l.lotId, id.key]))
    for (const l of published) {
      const record = recordByKey.get(identityByLotId.get(l.lotId)!)!
      assert.equal(l.costBasisUsd, record.allocatedCostBasisUsd)
    }
    const publishedSum = Math.round(published.reduce((s, l) => s + (l.costBasisUsd ?? 0), 0) * 1e8) / 1e8
    assert.equal(publishedSum, Math.round(sharedEntryTotal * 1e8) / 1e8, 'the five replayed shares must still sum exactly to the shared accepted total')
  })
})

describe('canonicalPnlSampleManifest — value methodology version (issue #1: manifest compatibility)', () => {
  it('HARD ASSERTION: a manifest built under an OLDER value methodology version is never found under the current identity, so a rescan creates a fresh manifest instead of repeatedly failing replay', async () => {
    const kv = fakeKv()
    const lots = buildLots(6, 6)
    const oldMethodologyIdentity = buildManifestIdentity({
      walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1',
      valueMethodologyVersion: CANONICAL_VALUE_METHODOLOGY_VERSION - 1,
    })
    const { manifest: oldManifest } = await manifestWithEvidence(lots, oldMethodologyIdentity)
    await writeCanonicalPnlSampleManifest(kv, oldManifest)

    // A rescan resolves identity under the CURRENT (default) value methodology version.
    const currentIdentity = identity()
    assert.notEqual(buildManifestKey(oldMethodologyIdentity), buildManifestKey(currentIdentity), 'the two identities must key to different manifest slots')
    const read = await readCanonicalPnlSampleManifest(kv, currentIdentity)
    assert.equal(read.manifest, null, 'the old-methodology manifest must simply miss, not be found-and-fail')
    assert.equal(read.validationFailure, false, 'a version mismatch is a real miss, never reported as corruption')
  })

  it('HARD ASSERTION (fingerprint-migration follow-up, required regression): the value methodology version is 6 — a stored vv5 manifest (fingerprinted before stablecoin-side normalization) misses cleanly under the current identity, and the very next scan creates one fresh manifest', async () => {
    assert.equal(CANONICAL_VALUE_METHODOLOGY_VERSION, 6)
    const kv = fakeKv()
    const lots = buildLots(6, 6)
    const vv5Identity = buildManifestIdentity({
      walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1',
      valueMethodologyVersion: 5,
    })
    const vv5Manifest = { ...(await manifestWithEvidence(lots, vv5Identity)).manifest, verifiedLotIdentityFingerprint: 'old-pre-stablecoin-normalization-fingerprint' }
    await writeCanonicalPnlSampleManifest(kv, vv5Manifest)
    assert.ok(buildManifestKey(vv5Identity).includes(':vv5:'), 'sanity: the old manifest really is keyed under vv5')

    const currentRead = await readCanonicalPnlSampleManifest(kv, identity())
    assert.equal(currentRead.manifest, null, 'the vv5 manifest must never be found under the vv6 identity')
    assert.equal(currentRead.validationFailure, false, 'a methodology-version miss is a clean miss, never reported as corruption')

    // The next scan (no manifest found) builds and persists a fresh vv6 manifest — never a manual
    // refresh/delete of the stale vv5 record, which remains untouched in the store under its own key.
    const { manifest: freshManifest } = await manifestWithEvidence(lots)
    assert.equal(freshManifest.valueMethodologyVersion, 6)
    assert.ok(buildManifestKey(identity()).includes(':vv6:'))
  })

  it('a manifest with the correct value methodology version still resolves normally', async () => {
    const kv = fakeKv()
    const lots = buildLots(6, 6)
    const { manifest } = await manifestWithEvidence(lots)
    assert.equal(manifest.valueMethodologyVersion, CANONICAL_VALUE_METHODOLOGY_VERSION)
    await writeCanonicalPnlSampleManifest(kv, manifest)
    const read = await readCanonicalPnlSampleManifest(kv, identity())
    assert.deepEqual(read.manifest, manifest)
  })

  it('structural lot identity schema stays unchanged by the value methodology bump', () => {
    assert.equal(CANONICAL_LOT_IDENTITY_SCHEMA_VERSION, 3)
  })
})

describe('canonicalPnlSampleManifest — real JSON/KV persistence round-trip (issue #4)', () => {
  it('HARD ASSERTION: create manifest -> persist to a real JSON-serializing KV -> reload -> replay a partial-fill group entirely from the reloaded, byte-for-byte-reconstructed manifest', async () => {
    const evidenceKv = jsonKv()
    const manifestKv = jsonKv()
    const NOW = 1_000_000

    // Five FIFO slices sharing BOTH the same buy tx and the same sell tx (a real partial fill,
    // production shape) — so BOTH sides pool a shared total to allocate, and both sums are
    // independently provable. Non-uniform amounts so tie-based ordinal ambiguity is never
    // accidentally hit.
    const amounts = [0.5, 1.25, 0.1 + 0.2, 3, 10 / 3]
    const siblings = amounts.map((amount, i) => lot({
      lotId: `sib-${i}`, token: '0xshared', openedTxHash: '0xsharedbuy', closedTxHash: '0xsharedsell',
      openedAt: 100, closedAt: 200, amount, costBasisUsd: 1, proceedsUsd: 2, realizedPnlUsd: 1,
    }))

    // Seed accepted evidence through the REAL readAcceptedEvidence/writeAcceptedEvidence path,
    // against the real JSON-serializing KV — never a shortcut in-memory store.
    for (const l of siblings) {
      for (const side of ['entry', 'exit'] as const) {
        const priceUsd = side === 'entry' ? 20 : 35
        const identity = {
          chain: l.chain, token: l.token, txHash: side === 'entry' ? l.openedTxHash : l.closedTxHash,
          side, timestamp: side === 'entry' ? l.openedAt : l.closedAt, lotIdentityVersion: lotIdentityVersion(l),
        }
        const envelope = buildAcceptedEvidenceEnvelope({ identity, priceUsd, valueUsd: priceUsd * l.amount, source: 'json-kv-test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW })
        await evidenceKv.set(buildAcceptedEvidenceKey(identity), envelope)
      }
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(evidenceKv, rest, NOW)
        : readAcceptedEvidence(evidenceKv, { ...rest, lotIdentityVersion: version }, NOW)

    // BUILD, through the real writeCanonicalPnlSampleManifest -> a real JSON-serializing KV.
    // `realizedPnlUsd`/`fingerprints` passed here are only the legacy fallback — the manifest's own
    // internally-recomputed, self-consistent total (from the ALLOCATED values) is what actually gets
    // stored; see buildManifestFromCandidate's own "REALIZED TOTAL / FINGERPRINTS" note.
    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: siblings, candidateVerifiedLots: siblings,
      structuralLotCount: siblings.length, fingerprints: computeFingerprints(siblings, realizedTotal(siblings)),
      realizedPnlUsd: realizedTotal(siblings), verifiedPricingCoverage: 1, now: 1000, loadEvidence: loader, computeFingerprints,
    })
    const total = manifest.realizedPnlUsd
    assert.equal(await writeCanonicalPnlSampleManifest(manifestKv, manifest), true)

    // RELOAD — a completely fresh read, through JSON.parse of the actually-persisted string. Proves
    // the manifest (including every allocation field: entryEvidenceKey, entryEvidenceLotIdentityVersion,
    // allocatedCostBasisUsd, etc.) survives real serialization intact.
    const reloaded = await readCanonicalPnlSampleManifest(manifestKv, identity())
    assert.ok(reloaded.manifest, 'the manifest must be found after a real JSON round-trip')
    assert.equal(reloaded.validationFailure, false)
    assert.deepEqual(reloaded.manifest, manifest, 'the reloaded manifest must be byte-for-byte identical to what was written')

    // REPLAY entirely from the reloaded manifest and a fresh evidence loader over the SAME
    // JSON-serializing evidence KV — no in-memory object identity anywhere in this path.
    const result = await replayManifest({ manifest: reloaded.manifest!, allCandidateLots: siblings, loadEvidence: loader, computeFingerprints })

    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_replay_success, 5)
    assert.equal(result.reasonCounts.manifest_side_evidence_missing, 0)
    assert.equal(result.reasonCounts.manifest_partial_fill_ordinal_mismatch, 0)
    const published = result.publishedLots.filter(isCanonicalVerifiedPublishedLot)
    assert.equal(published.length, 5)
    for (const l of published) {
      assert.notEqual(l.costBasisUsd, null, 'HARD ASSERTION: reloaded-from-JSON replay must never leave cost basis null')
      assert.notEqual(l.proceedsUsd, null, 'HARD ASSERTION: reloaded-from-JSON replay must never leave proceeds null')
      assert.notEqual(l.realizedPnlUsd, null, 'HARD ASSERTION: reloaded-from-JSON replay must never leave realized PnL null')
    }
    assert.equal(result.recomputedRealizedPnlUsd, total)
    assert.equal(result.recomputedFingerprints!.verifiedLotIdentityFingerprint, manifest.verifiedLotIdentityFingerprint)
    assert.equal(result.recomputedFingerprints!.acceptedHistoricalPriceFingerprint, manifest.acceptedHistoricalPriceFingerprint)
    assert.equal(result.recomputedFingerprints!.realizedPnlFingerprint, manifest.realizedPnlFingerprint)

    // The five allocated shares still sum exactly to the shared accepted total after the full
    // build -> JSON persist -> reload -> replay -> JSON persist round trip.
    const sharedTotal = (JSON.parse(evidenceKv.raw.get(buildAcceptedEvidenceKey({ chain: 'base', token: '0xshared', txHash: '0xsharedbuy', side: 'entry', timestamp: 100, lotIdentityVersion: '' }))!) as { priceUsd: number }).priceUsd
    const publishedSum = Math.round(published.reduce((s, l) => s + (l.costBasisUsd ?? 0), 0) * 1e8) / 1e8
    assert.equal(publishedSum, Math.round(sharedTotal * 1e8) / 1e8)
  })

  it('HARD ASSERTION: a full manifest replay-failure path also survives real JSON persistence — corrupting one persisted evidence record through the real KV still fails closed with no live PnL escaping', async () => {
    const evidenceKv = jsonKv()
    const manifestKv = jsonKv()
    const lots = buildLots(6, 6)
    const { manifest } = await manifestWithEvidenceOnKv(lots, evidenceKv)
    await writeCanonicalPnlSampleManifest(manifestKv, manifest)

    // Corrupt the persisted JSON string for one evidence record directly (simulating real storage
    // corruption, not an in-memory object mutation).
    const key = buildAcceptedEvidenceKey({ chain: lots[2].chain, token: lots[2].token, txHash: lots[2].openedTxHash, side: 'entry', timestamp: lots[2].openedAt, lotIdentityVersion: '' })
    const stored = JSON.parse(evidenceKv.raw.get(key)!) as { priceUsd: number }
    evidenceKv.raw.set(key, JSON.stringify({ ...stored, priceUsd: stored.priceUsd * 7 }))

    const reloadedManifest = await readCanonicalPnlSampleManifest(manifestKv, identity())
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(evidenceKv, rest, NOW)
        : readAcceptedEvidence(evidenceKv, { ...rest, lotIdentityVersion: version }, NOW)
    const result = await replayManifest({ manifest: reloadedManifest.manifest!, allCandidateLots: lots, loadEvidence: loader, computeFingerprints })

    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0, 'no live PnL may escape even after a real KV round-trip')
    assert.equal(result.recomputedRealizedPnlUsd, null)
  })

  it('a tied-amount partial-fill group fails closed rather than risk cross-wiring identities across scans', async () => {
    const evidenceKv = jsonKv()
    // Two siblings with the IDENTICAL matched amount — canonicalAmount ties, so the ordinal
    // tie-break (closedTxHash/openedTxHash) is a no-op since both fields are shared by definition.
    const tied = [
      lot({ lotId: 'tied-a', token: '0xtied', openedTxHash: '0xtiedbuy', closedTxHash: '0xtiedsell', openedAt: 100, closedAt: 200, amount: 1.5 }),
      lot({ lotId: 'tied-b', token: '0xtied', openedTxHash: '0xtiedbuy', closedTxHash: '0xtiedsell', openedAt: 100, closedAt: 200, amount: 1.5 }),
    ]
    for (const l of tied) {
      for (const side of ['entry', 'exit'] as const) {
        const priceUsd = side === 'entry' ? 10 : 15
        const idn = { chain: l.chain, token: l.token, txHash: side === 'entry' ? l.openedTxHash : l.closedTxHash, side, timestamp: side === 'entry' ? l.openedAt : l.closedAt, lotIdentityVersion: lotIdentityVersion(l) }
        await evidenceKv.set(buildAcceptedEvidenceKey(idn), buildAcceptedEvidenceEnvelope({ identity: idn, priceUsd, valueUsd: priceUsd * l.amount, source: 't', evidenceType: 'x', providerTimestampBucket: null, now: NOW }))
      }
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(evidenceKv, rest, NOW)
        : readAcceptedEvidence(evidenceKv, { ...rest, lotIdentityVersion: version }, NOW)

    // GROUPED MULTIPLICITY, DISCLOSED: both identical lots resolve to ONE occurrence-group identity
    // carrying occurrenceCount 2 — there is no ordinal left to be ambiguous about.
    const identities = buildCanonicalLotIdentities(tied)
    const distinctKeys = new Set([...identities.values()].map((id) => id.key))
    assert.equal(distinctKeys.size, 1, 'two identical lots must share exactly one occurrence-group identity')
    for (const id of identities.values()) assert.equal(id.occurrenceCount, 2)

    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: tied, candidateVerifiedLots: tied,
      structuralLotCount: tied.length, fingerprints: computeFingerprints(tied, realizedTotal(tied)),
      realizedPnlUsd: realizedTotal(tied), verifiedPricingCoverage: 1, now: 1000, loadEvidence: loader, computeFingerprints,
    })
    assert.equal(manifest.verifiedLotRecords.length, 1, 'one record stands for the whole identical group')
    assert.equal(manifest.verifiedLotRecords[0].occurrenceCount, 2)
    assert.equal(manifest.verifiedLotCount, 2, 'verifiedLotCount counts LOTS, never groups')

    // Replayed on a DIFFERENT (reversed) array order — the exact scenario that used to cross-wire
    // positional ordinals. With grouped multiplicity it now replays cleanly and identically.
    const result = await replayManifest({ manifest, allCandidateLots: [...tied].reverse(), loadEvidence: loader, computeFingerprints })
    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_partial_fill_ordinal_mismatch, 0)
    assert.equal(result.reasonCounts.manifest_replay_success, 2, 'replay success counts LOTS, not groups')
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 2)
    assert.equal(result.recomputedRealizedPnlUsd, manifest.realizedPnlUsd)
    assert.equal(result.recomputedFingerprints!.acceptedHistoricalPriceFingerprint, manifest.acceptedHistoricalPriceFingerprint)
  })

  it('HARD ASSERTION: a genuinely CHANGED group count (2 identical lots become 3) fails closed', async () => {
    const evidenceKv = jsonKv()
    const two = [0, 1].map((i) => lot({ lotId: `dup-${i}`, token: '0xdup', openedTxHash: '0xdupbuy', closedTxHash: '0xdupsell', openedAt: 100, closedAt: 200, amount: 1.5 }))
    for (const l of two) {
      for (const side of ['entry', 'exit'] as const) {
        const priceUsd = side === 'entry' ? 10 : 15
        const idn = { chain: l.chain, token: l.token, txHash: side === 'entry' ? l.openedTxHash : l.closedTxHash, side, timestamp: side === 'entry' ? l.openedAt : l.closedAt, lotIdentityVersion: lotIdentityVersion(l) }
        await evidenceKv.set(buildAcceptedEvidenceKey(idn), buildAcceptedEvidenceEnvelope({ identity: idn, priceUsd, valueUsd: priceUsd * l.amount, source: 't', evidenceType: 'x', providerTimestampBucket: null, now: NOW }))
      }
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null ? readAcceptedEvidenceAnyLotVersion(evidenceKv, rest, NOW) : readAcceptedEvidence(evidenceKv, { ...rest, lotIdentityVersion: version }, NOW)

    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: two, candidateVerifiedLots: two,
      structuralLotCount: two.length, fingerprints: computeFingerprints(two, realizedTotal(two)),
      realizedPnlUsd: realizedTotal(two), verifiedPricingCoverage: 1, now: 1000, loadEvidence: loader, computeFingerprints,
    })

    const three = [...two, lot({ lotId: 'dup-2', token: '0xdup', openedTxHash: '0xdupbuy', closedTxHash: '0xdupsell', openedAt: 100, closedAt: 200, amount: 1.5 })]
    const result = await replayManifest({ manifest, allCandidateLots: three, loadEvidence: loader, computeFingerprints })
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.reasonCounts.manifest_partial_fill_ordinal_mismatch, 1, 'a real change in group multiplicity is the one structural condition that must fail')
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0)
  })
})

// Builds a manifest end-to-end using a REAL JSON-serializing KV for accepted evidence (issue #4).
async function manifestWithEvidenceOnKv(allLots: readonly MatchedLot[], evidenceKv: AcceptedEvidenceKvLike) {
  for (const lot of allLots) {
    if (!isCanonicalVerifiedPublishedLot(lot)) continue
    for (const side of ['entry', 'exit'] as const) {
      const priceUsd = (side === 'entry' ? lot.costBasisUsd : lot.proceedsUsd) as number
      const identityFor = { chain: lot.chain, token: lot.token, txHash: side === 'entry' ? lot.openedTxHash : lot.closedTxHash, side, timestamp: side === 'entry' ? lot.openedAt : lot.closedAt, lotIdentityVersion: lotIdentityVersion(lot) }
      await evidenceKv.set(buildAcceptedEvidenceKey(identityFor), buildAcceptedEvidenceEnvelope({ identity: identityFor, priceUsd, valueUsd: priceUsd * lot.amount, source: 'json-kv-test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW }))
    }
  }
  const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
    version === null
      ? readAcceptedEvidenceAnyLotVersion(evidenceKv, rest, NOW)
      : readAcceptedEvidence(evidenceKv, { ...rest, lotIdentityVersion: version }, NOW)
  const total = realizedTotal(allLots)
  const verified = allLots.filter(isCanonicalVerifiedPublishedLot)
  const manifest = await buildManifestFromCandidate({
    identity: identity(), allCandidateLots: allLots, candidateVerifiedLots: verified,
    structuralLotCount: allLots.length, fingerprints: computeFingerprints(allLots, total),
    realizedPnlUsd: total, verifiedPricingCoverage: allLots.length > 0 ? verified.length / allLots.length : null,
    now: 1000, loadEvidence: loader, computeFingerprints,
  })
  return { manifest, loader }
}

describe('canonicalPnlSampleManifest — identical duplicate FIFO lots, grouped multiplicity (requirement #4)', () => {
  // Seeds accepted evidence for a lot set through the real JSON-serializing KV and returns a real
  // strict/relaxed loader over it.
  async function seedOnJsonKv(lots: readonly MatchedLot[], evidenceKv: ReturnType<typeof jsonKv>, entryPriceUsd: number, exitPriceUsd: number) {
    for (const l of lots) {
      for (const side of ['entry', 'exit'] as const) {
        const priceUsd = side === 'entry' ? entryPriceUsd : exitPriceUsd
        const idn = {
          chain: l.chain, token: l.token, txHash: side === 'entry' ? l.openedTxHash : l.closedTxHash,
          side, timestamp: side === 'entry' ? l.openedAt : l.closedAt, lotIdentityVersion: lotIdentityVersion(l),
        }
        await evidenceKv.set(buildAcceptedEvidenceKey(idn), buildAcceptedEvidenceEnvelope({
          identity: idn, priceUsd, valueUsd: priceUsd * l.amount,
          source: 'grouped-test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
        }))
      }
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(evidenceKv, rest, NOW)
        : readAcceptedEvidence(evidenceKv, { ...rest, lotIdentityVersion: version }, NOW)
    return loader
  }

  // Deterministic, seeded shuffle — proves order-independence without Math.random making the test
  // itself nondeterministic.
  function shuffle<T>(items: readonly T[], seed: number): T[] {
    const out = [...items]
    let state = seed
    for (let i = out.length - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) % 2147483648
      const j = state % (i + 1)
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  for (const occurrenceCount of [2, 5]) {
    it(`HARD ASSERTION: ${occurrenceCount} COMPLETELY IDENTICAL sibling lots survive a JSON/KV round-trip and a shuffled reload — exact count, PnL and all three fingerprints reproduced`, async () => {
      const evidenceKv = jsonKv()
      const manifestKv = jsonKv()

      // Every field identical — the exact shape the old positional-ordinal identity could not
      // resolve (production: 11 partial-fill ordinal mismatches, only 6/26 replayed).
      const identical = Array.from({ length: occurrenceCount }, (_, i) => lot({
        lotId: `identical-${i}`, token: '0xidentical',
        openedTxHash: '0xidenticalbuy', closedTxHash: '0xidenticalsell',
        openedAt: 500, closedAt: 900, amount: 2.5,
        costBasisUsd: 1, proceedsUsd: 2, realizedPnlUsd: 1,
      }))
      // Plus one genuinely distinct lot, so the manifest is not trivially single-group.
      const distinct = lot({ lotId: 'distinct', token: '0xother', openedTxHash: '0xotherbuy', closedTxHash: '0xothersell', openedAt: 1, closedAt: 2, amount: 7, costBasisUsd: 3, proceedsUsd: 9, realizedPnlUsd: 6 })
      const allLots = [...identical, distinct]

      const loader = await seedOnJsonKv(identical, evidenceKv, 40, 95)
      await seedOnJsonKv([distinct], evidenceKv, 3, 9)

      // SCAN ONE — build and persist through the real JSON KV.
      const manifest = await buildManifestFromCandidate({
        identity: identity(), allCandidateLots: allLots, candidateVerifiedLots: allLots,
        structuralLotCount: allLots.length, fingerprints: computeFingerprints(allLots, realizedTotal(allLots)),
        realizedPnlUsd: realizedTotal(allLots), verifiedPricingCoverage: 1, now: 1000,
        loadEvidence: loader, computeFingerprints,
      })
      assert.equal(await writeCanonicalPnlSampleManifest(manifestKv, manifest), true)

      // ONE record stands for all N identical lots; the distinct lot gets its own.
      assert.equal(manifest.verifiedLotRecords.length, 2, 'identical siblings collapse into exactly one occurrence-group record')
      const groupRecord = manifest.verifiedLotRecords.find((r) => r.openedTxHash === '0xidenticalbuy')!
      assert.equal(groupRecord.occurrenceCount, occurrenceCount)
      assert.equal(manifest.verifiedLotCount, occurrenceCount + 1, 'verifiedLotCount counts LOTS, never groups')
      // The group's stored totals are the sum of its own occurrences' allocated values.
      const groupShares = splitGroupTotalAcrossOccurrences(groupRecord.groupCostBasisUsd, occurrenceCount)
      let groupShareSum = 0
      for (const share of groupShares) groupShareSum += share as number
      assert.equal(Math.round(groupShareSum * 1e8) / 1e8, groupRecord.groupCostBasisUsd)

      // SCAN TWO — reload from the persisted JSON, then replay against a SHUFFLED array. Array order
      // is exactly what the old ordinal identity depended on, so this is the decisive check.
      const reloaded = await readCanonicalPnlSampleManifest(manifestKv, identity())
      assert.ok(reloaded.manifest)
      assert.deepEqual(reloaded.manifest, manifest, 'the manifest must survive real JSON serialization byte-for-byte')

      const shuffled = shuffle(allLots, 9973)
      const result = await replayManifest({ manifest: reloaded.manifest!, allCandidateLots: shuffled, loadEvidence: loader, computeFingerprints })

      assert.equal(result.outcome, 'applied')
      assert.equal(result.reasonCounts.manifest_partial_fill_ordinal_mismatch, 0, 'identical siblings must never report an ordinal mismatch again')
      assert.equal(result.reasonCounts.manifest_replay_success, occurrenceCount + 1)
      assert.equal(result.reasonCounts.manifest_side_evidence_missing, 0)

      const published = result.publishedLots.filter(isCanonicalVerifiedPublishedLot)
      assert.equal(published.length, occurrenceCount + 1, 'exact lot count reproduced')
      for (const l of published) {
        assert.notEqual(l.costBasisUsd, null)
        assert.notEqual(l.proceedsUsd, null)
        assert.notEqual(l.realizedPnlUsd, null)
      }

      // Exact PnL and all three fingerprints reproduced from the shuffled reload.
      assert.equal(result.recomputedRealizedPnlUsd, manifest.realizedPnlUsd)
      assert.equal(result.recomputedFingerprints!.verifiedLotIdentityFingerprint, manifest.verifiedLotIdentityFingerprint)
      assert.equal(result.recomputedFingerprints!.acceptedHistoricalPriceFingerprint, manifest.acceptedHistoricalPriceFingerprint)
      assert.equal(result.recomputedFingerprints!.realizedPnlFingerprint, manifest.realizedPnlFingerprint)

      // The identical group's replayed shares still sum exactly to its frozen total.
      const identicalPublished = published.filter((l) => l.openedTxHash === '0xidenticalbuy')
      assert.equal(identicalPublished.length, occurrenceCount)
      assert.equal(
        Math.round(identicalPublished.reduce((s, l) => s + (l.costBasisUsd ?? 0), 0) * 1e8) / 1e8,
        groupRecord.groupCostBasisUsd,
      )
    })
  }

  it('HARD ASSERTION: replaying the SAME identical-sibling manifest against several different shuffles always yields byte-identical fingerprints', async () => {
    const evidenceKv = jsonKv()
    const identical = Array.from({ length: 5 }, (_, i) => lot({
      lotId: `s-${i}`, token: '0xsame', openedTxHash: '0xsamebuy', closedTxHash: '0xsamesell',
      openedAt: 10, closedAt: 20, amount: 1 / 3, costBasisUsd: 1, proceedsUsd: 2, realizedPnlUsd: 1,
    }))
    const loader = await seedOnJsonKv(identical, evidenceKv, 17, 41)
    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: identical, candidateVerifiedLots: identical,
      structuralLotCount: identical.length, fingerprints: computeFingerprints(identical, realizedTotal(identical)),
      realizedPnlUsd: realizedTotal(identical), verifiedPricingCoverage: 1, now: 1000,
      loadEvidence: loader, computeFingerprints,
    })

    for (const seed of [1, 42, 12345, 999983]) {
      const result = await replayManifest({ manifest, allCandidateLots: shuffle(identical, seed), loadEvidence: loader, computeFingerprints })
      assert.equal(result.outcome, 'applied', `shuffle seed ${seed} must replay cleanly`)
      assert.equal(result.recomputedRealizedPnlUsd, manifest.realizedPnlUsd, `shuffle seed ${seed} must reproduce the frozen total`)
      assert.equal(result.recomputedFingerprints!.acceptedHistoricalPriceFingerprint, manifest.acceptedHistoricalPriceFingerprint, `shuffle seed ${seed} must reproduce the price fingerprint`)
      assert.equal(result.recomputedFingerprints!.realizedPnlFingerprint, manifest.realizedPnlFingerprint)
    }
  })
})

// =================================================================================================
// FINGERPRINT-MISMATCH DIAGNOSTIC — fingerprint-mismatch audit task (production shape: replay
// resolves 23/23 lots, zero per-group value mismatches, yet manifest_fingerprint_mismatch still
// fires -> manifestApplied:false / canonicalSampleEvidenceUnavailable:true). Diagnosis only.
// =================================================================================================

describe('canonicalPnlSampleManifest — fingerprint-mismatch diagnostic (audit task)', () => {
  it('HARD ASSERTION: isolates the exact lot(s) whose pre-rebuild live value differs from its rebuilt value, and which sub-fingerprint(s) disagree', async () => {
    const lots = buildLots(3, 3)
    const { manifest } = await manifestWithEvidence(lots)

    // Simulate the confirmed production shape: replay resolves every lot and every per-group value
    // check passes, but the RECOMPUTED fingerprints differ from the STORED ones (two independently
    // re-derived allocations agreeing on VALUE within tolerance but not on the exact float/string).
    const identities = buildCanonicalLotIdentities(lots)
    const rebuiltByLot = new Map<MatchedLot, MatchedLot>()
    // lots[0]: rebuilt with a genuine, sub-cent divergence from its own live value.
    rebuiltByLot.set(lots[0], { ...lots[0], costBasisUsd: lots[0].costBasisUsd! + 0.001, realizedPnlUsd: lots[0].realizedPnlUsd! - 0.001 })
    // lots[1] and lots[2]: rebuilt identically to their live values — never flagged as divergent.
    rebuiltByLot.set(lots[1], lots[1])
    rebuiltByLot.set(lots[2], lots[2])

    const recomputedFingerprints = { ...computeFingerprints(lots, manifest.realizedPnlUsd), acceptedHistoricalPriceFingerprint: 'DIFFERENT-HASH' }
    const diagnostic = buildFingerprintMismatchDiagnostic({
      manifest, recomputedFingerprints, recomputedRealizedPnlUsd: manifest.realizedPnlUsd, rebuiltByLot, identities,
    })

    assert.equal(diagnostic.acceptedHistoricalPriceFingerprintMismatch, true)
    assert.equal(diagnostic.verifiedLotIdentityFingerprintMismatch, false)
    assert.equal(diagnostic.realizedPnlFingerprintMismatch, false)
    assert.equal(diagnostic.replayedLotCount, 3)
    assert.equal(diagnostic.divergentLotCount, 1, 'only the ONE lot with a genuine live-vs-rebuilt difference is flagged — never the two that match exactly')
    assert.equal(diagnostic.topDivergentLots.length, 1)
    assert.equal(diagnostic.topDivergentLots[0].groupKey, identities.get(lots[0])!.key)
    assert.equal(diagnostic.topDivergentLots[0].livePreRebuildCostBasisUsd, lots[0].costBasisUsd)
    assert.equal(diagnostic.topDivergentLots[0].rebuiltCostBasisUsd, lots[0].costBasisUsd! + 0.001)
    assert.ok(Math.abs(diagnostic.topDivergentLots[0].maxAbsDifferenceUsd - 0.001) < 1e-9)
  })

  it('returns zero divergent lots when every rebuilt value is byte-identical to its live value — proving a real mismatch must come from the realized-PnL SUM, not any single lot', async () => {
    const lots = buildLots(2, 2)
    const { manifest } = await manifestWithEvidence(lots)
    const identities = buildCanonicalLotIdentities(lots)
    const rebuiltByLot = new Map<MatchedLot, MatchedLot>([[lots[0], lots[0]], [lots[1], lots[1]]])
    const recomputedFingerprints = { ...computeFingerprints(lots, manifest.realizedPnlUsd), realizedPnlFingerprint: 'DIFFERENT-HASH' }
    const diagnostic = buildFingerprintMismatchDiagnostic({
      manifest, recomputedFingerprints, recomputedRealizedPnlUsd: manifest.realizedPnlUsd, rebuiltByLot, identities,
    })
    assert.equal(diagnostic.realizedPnlFingerprintMismatch, true)
    assert.equal(diagnostic.divergentLotCount, 0, 'no per-lot divergence — the mismatch must be isolated to the aggregate sum/fingerprint, not any single lot value')
    assert.deepEqual(diagnostic.topDivergentLots, [])
  })

  it('bounds the divergent-lot list to the top 10, sorted by largest absolute difference, never unbounded per-lot logging', async () => {
    const lots = buildLots(15, 15)
    const { manifest } = await manifestWithEvidence(lots)
    const identities = buildCanonicalLotIdentities(lots)
    const rebuiltByLot = new Map<MatchedLot, MatchedLot>()
    lots.forEach((l, i) => rebuiltByLot.set(l, { ...l, costBasisUsd: l.costBasisUsd! + (i + 1) * 0.001 }))
    const recomputedFingerprints = { ...computeFingerprints(lots, manifest.realizedPnlUsd), acceptedHistoricalPriceFingerprint: 'DIFFERENT-HASH' }
    const diagnostic = buildFingerprintMismatchDiagnostic({
      manifest, recomputedFingerprints, recomputedRealizedPnlUsd: manifest.realizedPnlUsd, rebuiltByLot, identities,
    })
    assert.equal(diagnostic.divergentLotCount, 15, 'the real total is still honestly disclosed')
    assert.equal(diagnostic.topDivergentLots.length, 10, 'log output itself is bounded to the top 10')
    assert.equal(diagnostic.topDivergentLots[0].groupKey, identities.get(lots[14])!.key, 'largest divergence (lot 14, +0.015) sorts first')
    for (let i = 1; i < diagnostic.topDivergentLots.length; i++) {
      assert.ok(diagnostic.topDivergentLots[i - 1].maxAbsDifferenceUsd >= diagnostic.topDivergentLots[i].maxAbsDifferenceUsd, 'descending order')
    }
  })
})

describe('canonicalPnlSampleManifest — create/replay shared canonicalization (surgical manifest-replay fix follow-up task)', () => {
  // Real production shape: 21 verified lots whose RAW per-lot realizedPnlUsd (fifoEngine's own,
  // pre-allocation output) carries sub-cent noise, e.g. -0.8850539 rather than the canonical
  // cent-rounded -0.89 — proceeds/cost stay exact so acceptedHistoricalPriceFingerprint (cost/
  // proceeds only) is unaffected; only the realized total/fingerprint were at risk.
  function buildLiveShapeLots(): MatchedLot[] {
    return Array.from({ length: 21 }, (_, i) => {
      const cost = 100 + i * 3.333333
      const proceeds = cost - (0.8850539 + i * 0.0001)
      return lot({
        lotId: `live-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`,
        openedAt: i, closedAt: 1000 + i,
        costBasisUsd: cost, proceedsUsd: proceeds,
        // The RAW, un-rounded difference — exactly what a caller that skips the shared
        // canonicalization helper would carry, e.g. -0.8850539 rather than -0.89.
        realizedPnlUsd: proceeds - cost,
      })
    })
  }

  it('HARD ASSERTION (confirmed production bug — the fix this task adds): building a manifest WITHOUT computeFingerprints stores the raw, uncorrected total/fingerprints, and a later replay (which always recomputes via the corrected, cent-rounded per-occurrence shares) then permanently mismatches even though identity/side-evidence/cost/proceeds all agree', async () => {
    const lots = buildLiveShapeLots()
    const evidence = seededEvidence(lots)
    const verified = lots.filter(isCanonicalVerifiedPublishedLot)
    const rawRealizedTotal = Math.round(verified.reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0) * 1e8) / 1e8

    // THE BUG, REPRODUCED: buildManifestFromCandidate called the way the broken pipeline wiring did
    // — `loadEvidence` supplied, but `computeFingerprints` OMITTED — so its own internal correction
    // never runs and the manifest is written with the caller's raw pre-allocation total/fingerprints.
    const brokenManifest = await buildManifestFromCandidate({
      identity: identity('live-shape'), allCandidateLots: lots, candidateVerifiedLots: verified,
      structuralLotCount: lots.length,
      fingerprints: computeFingerprints(lots, rawRealizedTotal),
      realizedPnlUsd: rawRealizedTotal,
      verifiedPricingCoverage: 1, now: 1000, loadEvidence: evidence.loader,
      // computeFingerprints intentionally NOT passed — this is the exact bug.
    })
    assert.notEqual(brokenManifest.realizedPnlUsd, roundCents(rawRealizedTotal), 'sanity: the raw total really is off-cent noise, not already clean')

    const brokenReplay = await replay(brokenManifest, lots, evidence.loader)
    assert.equal(brokenReplay.outcome, 'unavailable', 'a manifest written without the shared canonicalization permanently mismatches its own later replay')
    assert.equal(brokenReplay.reasonCounts.manifest_realized_total_mismatch, 1)
    // THE SELF-HEAL SIGNAL (stale-manifest self-heal follow-up task): every per-lot check passed
    // (identity, side evidence, cost/proceeds tolerance) and the stored identity fingerprint itself
    // still matches — the ONLY disagreement is the derived USD fingerprints/total. This is exactly
    // the safe-to-rebuild shape the pipeline's self-heal uses to trigger a one-time refresh.
    assert.equal(brokenReplay.staleManifestCanonicalizationMismatch, true)

    // THE FIX, VERIFIED: rebuilding a manifest for the SAME candidate sample WITH computeFingerprints
    // (exactly what the pipeline's self-heal now does) produces a manifest that replays cleanly.
    const healedManifest = await buildRefreshedManifest({
      priorManifest: brokenManifest, identity: identity('live-shape'), allCandidateLots: lots,
      candidateVerifiedLots: verified, structuralLotCount: lots.length,
      fingerprints: computeFingerprints(lots, null), realizedPnlUsd: null,
      verifiedPricingCoverage: 1, now: 2000, refreshReason: 'stale-manifest-canonicalization-self-heal',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    assert.equal(healedManifest.realizedPnlUsd, roundCents(healedManifest.realizedPnlUsd!), 'the healed manifest stores a cent-clean canonical total (sum of cent-rounded per-lot allocated shares, not a rounded raw sum)')
    const healedReplay = await replay(healedManifest, lots, evidence.loader)
    assert.equal(healedReplay.outcome, 'applied')
    assert.equal(healedReplay.reasonCounts.manifest_replay_success, 21)
    assert.equal(healedReplay.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 21)
    assert.equal(healedReplay.staleManifestCanonicalizationMismatch, false, 'a clean, self-consistent replay is never itself flagged as stale')
  })

  it('staleManifestCanonicalizationMismatch is false on a genuine identity mismatch (never a safe rebuild target)', async () => {
    const lots = buildLiveShapeLots()
    const { manifest, evidence } = await manifestWithEvidence(lots, identity('live-shape-identity'))
    // A genuinely different candidate sample — the manifest's own lots are entirely absent.
    const differentLots = buildLiveShapeLots().map((l) => ({ ...l, openedTxHash: `${l.openedTxHash}-other`, closedTxHash: `${l.closedTxHash}-other` }))
    const result = await replay(manifest, differentLots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.staleManifestCanonicalizationMismatch, false)
  })

  it('staleManifestCanonicalizationMismatch is false on missing side evidence (never a safe rebuild target)', async () => {
    const lots = buildLiveShapeLots()
    const { manifest, evidence } = await manifestWithEvidence(lots, identity('live-shape-missing'))
    const key = evidence.keyFor(lots[0], 'entry')
    evidence.store.delete(key)
    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.staleManifestCanonicalizationMismatch, false)
  })

  it('staleManifestCanonicalizationMismatch is false on a genuine cost/proceeds mismatch (never a safe rebuild target)', async () => {
    const lots = buildLiveShapeLots()
    const { manifest, evidence } = await manifestWithEvidence(lots, identity('live-shape-corrupted'))
    const key = evidence.keyFor(lots[0], 'entry')
    const envelope = evidence.store.get(key) as { priceUsd: number }
    evidence.store.set(key, { ...envelope, priceUsd: envelope.priceUsd + 50 })
    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.staleManifestCanonicalizationMismatch, false)
  })

  it('staleManifestCanonicalizationMismatch is false on a genuinely successful replay (nothing to heal)', async () => {
    const lots = buildLiveShapeLots()
    const { manifest, evidence } = await manifestWithEvidence(lots, identity('live-shape-clean'))
    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'applied')
    assert.equal(result.staleManifestCanonicalizationMismatch, false)
  })

  it('HARD ASSERTION (required regression): live-shape 21-lot sample — build WITH the shared computeFingerprints helper, then replay applies and publishes all 21, with identical fingerprints', async () => {
    const lots = buildLiveShapeLots()
    const { manifest, evidence } = await manifestWithEvidence(lots, identity('live-shape-fixed'))

    // The stored total is the CANONICAL cent-rounded-and-integer-summed figure, never the raw
    // per-lot noise — this is what "one shared quantized value representation" means in practice.
    assert.equal(manifest.realizedPnlUsd, roundCents(manifest.realizedPnlUsd!), 'stored total is cent-clean')

    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_replay_success, 21)
    assert.equal(result.reasonCounts.manifest_realized_total_mismatch, 0)
    assert.equal(result.reasonCounts.manifest_fingerprint_mismatch, 0)
    const published = result.publishedLots.filter(isCanonicalVerifiedPublishedLot)
    assert.equal(published.length, 21, 'replay applies and publishes all 21 canonical lots')

    // Fingerprints (identity, price, realized total) are stable across create and replay.
    assert.equal(result.recomputedFingerprints!.verifiedLotIdentityFingerprint, manifest.verifiedLotIdentityFingerprint)
    assert.equal(result.recomputedFingerprints!.acceptedHistoricalPriceFingerprint, manifest.acceptedHistoricalPriceFingerprint)
    assert.equal(result.recomputedFingerprints!.realizedPnlFingerprint, manifest.realizedPnlFingerprint)
    assert.equal(result.recomputedRealizedPnlUsd, manifest.realizedPnlUsd)
  })

  it('a genuine cost/proceeds mismatch (a real, above-tolerance provider disagreement) must still fail closed under the shared canonicalization', async () => {
    const lots = buildLiveShapeLots()
    const { manifest, evidence } = await manifestWithEvidence(lots, identity('live-shape-corrupt'))

    const key = evidence.keyFor(lots[3], 'entry')
    const envelope = evidence.store.get(key) as { priceUsd: number }
    evidence.store.set(key, { ...envelope, priceUsd: envelope.priceUsd + 5 })

    const result = await replay(manifest, lots, evidence.loader)
    assert.equal(result.outcome, 'unavailable')
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0, 'no live PnL escapes on a genuine mismatch')
  })
})

describe('stablecoinNormalizedGroupTotal — deterministic $1/token normalization (stablecoin-side-normalization follow-up task)', () => {
  // Real, address-verified Base USDC — src/modules/quoteLegPricing/index.ts's own STABLECOIN_ADDRESSES.
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const NON_STABLE_TOKEN = '0xsome-other-token'

  it('HARD ASSERTION (required regression — confirmed production shape): a verified stablecoin side whose stored total is materially non-$1/token is normalized to amount x $1, never left as verified truth', () => {
    // Confirmed live shape: one Base USDC side stored ~$5.9705 for an occurrence quantity that
    // should value at ~$1194.1715 at $1/token — a ~200x undervaluation.
    const group = [lot({ chain: 'base', token: BASE_USDC, amount: 1194.1715 })]
    const normalized = stablecoinNormalizedGroupTotal(group, 5.9705)
    assert.equal(normalized, 1194.1715, 'the wrong stored total is replaced with the deterministic amount x $1 figure')
  })

  it('sums every sibling occurrence amount for a multi-lot stablecoin group', () => {
    const group = [
      lot({ chain: 'base', token: BASE_USDC, amount: 100 }),
      lot({ chain: 'base', token: BASE_USDC, amount: 250.5 }),
    ]
    assert.equal(stablecoinNormalizedGroupTotal(group, 1), 350.5)
  })

  it('a non-stablecoin token is completely untouched — the stored total passes through unchanged', () => {
    const group = [lot({ chain: 'base', token: NON_STABLE_TOKEN, amount: 1194.1715 })]
    assert.equal(stablecoinNormalizedGroupTotal(group, 5.9705), 5.9705, 'never invents a price for anything that is not address-verified')
  })

  it('a verified stablecoin whose stored total already equals $1/token is unaffected (no spurious change)', () => {
    const group = [lot({ chain: 'base', token: BASE_USDC, amount: 100 })]
    assert.equal(stablecoinNormalizedGroupTotal(group, 100), 100)
  })

  it('an empty group returns the input total unchanged (nothing to normalize)', () => {
    assert.equal(stablecoinNormalizedGroupTotal([], 42), 42)
  })

  it('HARD ASSERTION (end-to-end, required regression): a manifest built from a mispriced verified-stablecoin side stores the normalized $1/token total, not the stale wrong figure — and canonical-pnl-diff-audit no longer has anything to warn about', async () => {
    const stableLot = lot({
      lotId: 'stable-0', token: BASE_USDC, chain: 'base', openedTxHash: '0xstablebuy', closedTxHash: '0xstablesell',
      openedAt: 1, closedAt: 2, amount: 1194.1715,
      costBasisUsd: 5.9705, proceedsUsd: 5.9705, realizedPnlUsd: 0,
    })
    const evidence = seededEvidence([stableLot])
    // Overwrite the seeded entry evidence with the WRONG, confirmed-production total ($5.9705
    // instead of the correct $1194.1715 at $1/token) — simulating stale/corrupted accepted evidence.
    const entryKey = evidence.keyFor(stableLot, 'entry')
    const entryEnvelope = evidence.store.get(entryKey) as { priceUsd: number; valueUsd: number }
    evidence.store.set(entryKey, { ...entryEnvelope, priceUsd: 5.9705, valueUsd: 5.9705 })

    const manifest = await buildManifestFromCandidate({
      identity: identity('stablecoin-normalization'), allCandidateLots: [stableLot], candidateVerifiedLots: [stableLot],
      structuralLotCount: 1, fingerprints: computeFingerprints([stableLot], null), realizedPnlUsd: null,
      verifiedPricingCoverage: 1, now: 1000, loadEvidence: evidence.loader, computeFingerprints,
    })

    const record = manifest.verifiedLotRecords[0]
    assert.equal(record.groupCostBasisUsd, 1194.1715, 'the manifest stores the deterministic $1/token total, never the stale wrong figure')
    assert.equal(record.costBasisUsd, 1194.1715)
  })
})

describe('canonicalPnlSampleManifest — incomplete accepted sides demoted (Wallet PnL Item 1)', () => {
  it('HARD ASSERTION: a verified lot sharing a buy with an unpriced sibling is demoted, never left in the verified sample', () => {
    const verified = lot({
      lotId: 'a', amount: 1, costBasisUsd: 50, proceedsUsd: 80, realizedPnlUsd: 30, evidenceQuality: 'verified',
    })
    const unpriced = lot({
      lotId: 'b', amount: 1, closedTxHash: '0xsell-b', closedAt: 3,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    })
    const demote = lotsOnIncompleteAcceptedSides([verified, unpriced])
    assert.equal(demote.has(verified), true, 'the verified sibling of an unpriced lot on the same buy must be demoted')
    assert.equal(demote.has(unpriced), false, 'the already-unpriced sibling is not the demotion target')
    const demoted = demoteLotsOnIncompleteAcceptedSides([verified, unpriced])
    assert.equal(demoted[0].evidenceQuality, 'unpriced')
    assert.equal(isCanonicalVerifiedPublishedLot(demoted[0]), false)
    assert.equal(isCanonicalVerifiedPublishedLot(demoted[1]), false)
  })

  it('two fully verified siblings sharing a side are not demoted', () => {
    const a = lot({ lotId: 'a', amount: 1, costBasisUsd: 50, proceedsUsd: 80, realizedPnlUsd: 30 })
    const b = lot({ lotId: 'b', amount: 1, closedTxHash: '0xsell-b', closedAt: 3, costBasisUsd: 50, proceedsUsd: 90, realizedPnlUsd: 40 })
    assert.equal(lotsOnIncompleteAcceptedSides([a, b]).size, 0)
    const demoted = demoteLotsOnIncompleteAcceptedSides([a, b])
    assert.equal(demoted[0].evidenceQuality, 'verified')
    assert.equal(demoted[1].evidenceQuality, 'verified')
    assert.equal(isCanonicalVerifiedPublishedLot(demoted[0]), true)
    assert.equal(isCanonicalVerifiedPublishedLot(demoted[1]), true)
  })

  it('an isolated verified lot with no siblings is untouched', () => {
    const only = lot({ lotId: 'solo' })
    assert.equal(lotsOnIncompleteAcceptedSides([only]).size, 0)
    assert.equal(demoteLotsOnIncompleteAcceptedSides([only])[0].evidenceQuality, 'verified')
  })

  it('HARD ASSERTION: a $1 group total that dusts a sibling is not canonical-positive coverage', () => {
    const tiny = lot({ lotId: 'tiny', amount: 1, closedTxHash: '0xsell-tiny' })
    const huge = lot({ lotId: 'huge', amount: 10_000_000_000, closedTxHash: '0xsell-huge', closedAt: 3 })
    assert.equal(acceptedEvidenceAllocationsAreCanonicalPositive([tiny, huge], 1), false)
    assert.equal(acceptedEvidenceAllocationsAreCanonicalPositive([tiny, huge], 20_000_000_000), true)
    assert.equal(acceptedEvidenceAllocationsAreCanonicalPositive([tiny], 5), true)
    assert.equal(acceptedEvidenceAllocationsAreCanonicalPositive([tiny], 0), false)
  })

  it('HARD ASSERTION (end-to-end, CORRECTED — canonical-manifest-shared-group-allocation follow-up task): a mixed-quality shared side publishes the verified sibling\'s own conserving share, never demotes it merely because an unrelated sibling is unpriced', async () => {
    // Production shape: one buy consumed by two FIFO lots, only one of which is priced. Schema-2
    // accepted evidence is a SIDE TOTAL ($100). Allocation over the full sibling set gives the
    // verified lot its own real, quantity-proportional $50 share — publishing exactly that $50 (never
    // the unpriced sibling's $50, never the full $100) is NOT
    // `group_total_does_not_equal_accepted_side_total`; it is a correct, conserving partial
    // publication. Confirmed production regression this replaces (see
    // canonicalPnlSampleManifest.ts's own "WHOLE-GROUP DEMOTION REMOVED" header): the prior blanket
    // demotion here collapsed a live 108-candidate scan to 37 published lots purely because each
    // demoted lot happened to share a transaction side with SOME unrelated, unverified sibling.
    const verified = lot({
      lotId: 'priced', token: '0xfacy', openedTxHash: '0xsharedbuy', closedTxHash: '0xasell',
      openedAt: 100, closedAt: 200, amount: 1, costBasisUsd: 50, proceedsUsd: 80, realizedPnlUsd: 30,
    })
    const unpriced = lot({
      lotId: 'unpriced', token: '0xfacy', openedTxHash: '0xsharedbuy', closedTxHash: '0xbsell',
      openedAt: 100, closedAt: 300, amount: 1,
      costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced',
    })
    const allLots = [verified, unpriced]

    const store = new Map<string, unknown>()
    const kv: AcceptedEvidenceKvLike = {
      get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    }
    const seedSide = async (lotRef: MatchedLot, side: 'entry' | 'exit', totalUsd: number) => {
      const identity = {
        chain: lotRef.chain, token: lotRef.token,
        txHash: side === 'entry' ? lotRef.openedTxHash : lotRef.closedTxHash,
        side, timestamp: side === 'entry' ? lotRef.openedAt : lotRef.closedAt,
        lotIdentityVersion: lotIdentityVersion(lotRef),
      }
      store.set(buildAcceptedEvidenceKey(identity), buildAcceptedEvidenceEnvelope({
        identity, priceUsd: totalUsd, valueUsd: totalUsd,
        source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, now: NOW,
      }))
    }
    await seedSide(verified, 'entry', 100)
    await seedSide(verified, 'exit', 80)
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
        : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)

    const manifest = await buildManifestFromCandidate({
      identity: identity('incomplete-side'),
      allCandidateLots: allLots,
      candidateVerifiedLots: [verified],
      structuralLotCount: allLots.length,
      fingerprints: computeFingerprints(allLots, 30),
      realizedPnlUsd: 30,
      verifiedPricingCoverage: 0.5,
      now: 1000,
      loadEvidence: loader,
      computeFingerprints,
    })

    assert.equal(manifest.verifiedLotRecords.length, 1, 'the verified sibling still publishes its own real, conserving share')
    assert.equal(manifest.verifiedLotCount, 1)
    assert.equal(manifest.verifiedLotRecords[0].costBasisUsd, 50, 'exactly this lot\'s own proportional share of the $100 entry total — never the full $100, never fabricated')
    assert.equal(manifest.verifiedLotRecords[0].proceedsUsd, 80, 'exit side is not shared — the lot\'s own exact accepted value')
    assert.equal(manifest.realizedPnlUsd, 30, 'never null — the unpriced sibling never enters this lot\'s own realized figure')

    // Never silently erased: the unpriced sibling's own $50 share of the shared $100 entry total is
    // explicitly accounted for as a residual, not fabricated into `verified`'s own claim and not
    // dropped from the record without explanation.
    const entryGroupAudit = manifest.manifestAllocationBuildAudit?.groups.find((g) => g.side === 'entry')
    assert.ok(entryGroupAudit, 'the entry group (shared with the unpriced sibling) is surfaced in the build audit')
    assert.equal(entryGroupAudit!.acceptedEvidenceUsd, 100)
    assert.equal(entryGroupAudit!.publishedUsdSum, 50)
    assert.equal(entryGroupAudit!.residualUsd, 50, 'the unpriced sibling\'s own real share stays an explicit, accounted-for residual')
    assert.equal(entryGroupAudit!.conservationSatisfied, true, 'allocatedUsdSum (published + residual) still equals the real accepted evidence total')
  })

  it('HARD ASSERTION (control): two verified lots sharing a schema-2 side stay published and their claimed totals sum to the accepted side total', async () => {
    const a = lot({
      lotId: 'a', token: '0xfacy', openedTxHash: '0xsharedbuy', closedTxHash: '0xasell',
      openedAt: 100, closedAt: 200, amount: 1, costBasisUsd: 50, proceedsUsd: 80, realizedPnlUsd: 30,
    })
    const b = lot({
      lotId: 'b', token: '0xfacy', openedTxHash: '0xsharedbuy', closedTxHash: '0xbsell',
      openedAt: 100, closedAt: 300, amount: 1, costBasisUsd: 50, proceedsUsd: 90, realizedPnlUsd: 40,
    })
    const allLots = [a, b]
    const store = new Map<string, unknown>()
    const kv: AcceptedEvidenceKvLike = {
      get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    }
    const seedSide = async (lotRef: MatchedLot, side: 'entry' | 'exit', totalUsd: number) => {
      const identity = {
        chain: lotRef.chain, token: lotRef.token,
        txHash: side === 'entry' ? lotRef.openedTxHash : lotRef.closedTxHash,
        side, timestamp: side === 'entry' ? lotRef.openedAt : lotRef.closedAt,
        lotIdentityVersion: lotIdentityVersion(lotRef),
      }
      store.set(buildAcceptedEvidenceKey(identity), buildAcceptedEvidenceEnvelope({
        identity, priceUsd: totalUsd, valueUsd: totalUsd,
        source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, now: NOW,
      }))
    }
    await seedSide(a, 'entry', 100)
    await seedSide(a, 'exit', 80)
    await seedSide(b, 'exit', 90)
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
        : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)

    const manifest = await buildManifestFromCandidate({
      identity: identity('complete-side'),
      allCandidateLots: allLots,
      candidateVerifiedLots: allLots,
      structuralLotCount: allLots.length,
      fingerprints: computeFingerprints(allLots, 70),
      realizedPnlUsd: 70,
      verifiedPricingCoverage: 1,
      now: 1000,
      loadEvidence: loader,
      computeFingerprints,
    })

    assert.equal(manifest.verifiedLotRecords.length, 2)
    assert.equal(manifest.verifiedLotCount, 2)
    const claimedEntry = Math.round(manifest.verifiedLotRecords.reduce((s, r) => s + (r.groupCostBasisUsd ?? 0), 0) * 1e8) / 1e8
    assert.equal(claimedEntry, 100, 'verified group claims on a complete shared side must sum to the accepted side total')
  })
})

describe('canonical manifest partial reconciliation policy', () => {
  it('does not collapse the confirmed 97-old/108-current/37-replay-success shape', async () => {
    const oldLots = buildLots(97, 97)
    const newLots = Array.from({ length: 11 }, (_, offset) => {
      const i = 97 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('live-97-108'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const stale = {
      ...original,
      verifiedLotRecords: original.verifiedLotRecords.map((record, i) => i < 60
        ? { ...record, entryEvidenceLotIdentityVersion: `expired-${i}` }
        : record),
    }

    const first = await replay(stale, currentLots, evidence.loader)
    assert.equal(first.reasonCounts.manifest_replay_success, 37)
    assert.equal(first.manifestLotsMissingCurrentEvidence.length, 60)
    assert.equal(first.candidateNewEvidenceLotKeys.length, 11)
    assert.equal(first.structuralIntegrityFailure, false)
    assert.equal(first.manifestStructuralFailureAudit.refreshAllowed, true)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(first, 108), true)
    assert.equal(first.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0, 'the stale manifest remains fail-closed before durable refresh')

    const kv = jsonKv()
    const refreshed = await buildRefreshedManifest({
      priorManifest: stale, identity: identity('live-97-108'), allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'partially-unreproducible-manifest-current-evidence-refresh',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    assert.equal(await writeCanonicalPnlSampleManifest(kv, refreshed), true)
    const reloaded = await readCanonicalPnlSampleManifest(kv, identity('live-97-108'))
    assert.ok(reloaded.manifest)
    const second = await replay(reloaded.manifest!, currentLots, evidence.loader)
    assert.equal(second.outcome, 'applied')
    assert.equal(second.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 108)
  })

  it('refreshes the exact live 24-old/29-current shape without publishing invalid stale records', async () => {
    const oldLots = buildLots(24, 24)
    const currentLots = [...oldLots, ...Array.from({ length: 5 }, (_, offset) => {
      const i = 24 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    // Models three old references that no longer satisfy CURRENT evidence identity. The current
    // candidates and current accepted evidence remain valid; stale references themselves must not publish.
    const stale = {
      ...original,
      verifiedLotRecords: original.verifiedLotRecords.map((record, i) => i < 3
        ? { ...record, entryEvidenceLotIdentityVersion: `obsolete-${i}` }
        : record),
    }
    const first = await replay(stale, currentLots, evidence.loader)
    assert.equal(first.outcome, 'unavailable')
    assert.equal(first.manifestLotsMissingCurrentEvidence.length, 3)
    assert.equal(first.candidateNewEvidenceLotKeys.length, 5)
    assert.equal(first.structuralIntegrityFailure, false)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(first, 29), true)
    assert.equal(first.manifestStructuralFailureAudit.structuralFailure, false)
    assert.equal(first.manifestStructuralFailureAudit.refreshAllowed, true)
    assert.equal(first.manifestStructuralFailureAudit.staleEvidenceReasons.accepted_side_evidence_unavailable, 3)
    assert.equal(first.reasonCounts.manifest_evidence_quality_mismatch, 0)
    assert.ok(first.manifestEvidenceQualityComparisonAudit.every((row) => row.normalizedManifestQuality === 'verified'
      && row.normalizedCurrentQuality === 'verified' && row.equalityResult && row.mismatchReason === null),
    'verified -> verified comparisons must never be called evidence-quality mismatches')
    assert.equal(first.manifestSideEvidenceAudit.filter((row) => row.exactMissingSide !== null).length, 3)
    assert.ok(first.manifestSideEvidenceAudit.filter((row) => row.exactMissingSide !== null)
      .every((row) => row.structuralOrEvidenceOnly === 'evidence_only' && row.canonicalCandidatePresent && row.currentLotVerified))
    assert.equal(first.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 0, 'stale replay itself remains atomic and fail closed')

    const refreshed = await buildRefreshedManifest({
      priorManifest: stale, identity: identity(), allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'partially-unreproducible-manifest-current-evidence-refresh',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const second = await replay(refreshed, currentLots, evidence.loader)
    assert.equal(second.outcome, 'applied')
    assert.equal(second.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 29)
    assert.equal(second.manifestLotsMissingCurrentEvidence.length, 0)
    assert.equal(second.manifestStructuralFailureAudit.structuralFailure, false)
  })

  it('never refreshes a structurally incompatible manifest', async () => {
    const lots = buildLots(2, 2)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    const corrupt = { ...manifest, verifiedLotIdentityKeys: [...manifest.verifiedLotIdentityKeys, manifest.verifiedLotIdentityKeys[0]] }
    const result = await replay(corrupt, lots, evidence.loader)
    assert.equal(result.structuralIntegrityFailure, true)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(result, 2), false)
    assert.equal(result.manifestStructuralFailureAudit.structuralFailure, true)
    assert.equal(result.manifestStructuralFailureAudit.refreshAllowed, false)
    assert.equal(result.manifestStructuralFailureAudit.refreshBlockedReason, 'true_structural_or_value_integrity_failure')
    assert.ok(result.manifestStructuralFailureAudit.actualStructuralReasons.duplicate_canonical_identity > 0)
  })
})

describe('canonical manifest additive candidate evolution (81+27 → 108)', () => {
  it('HARD ASSERTION: 81 valid manifest + 27 independently verified candidates safely refreshes to 108', async () => {
    const oldLots = buildLots(81, 81)
    const newLots = Array.from({ length: 27 }, (_, offset) => {
      const i = 81 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('additive-81-108'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const first = await replay(original, currentLots, evidence.loader)
    assert.equal(first.outcome, 'applied')
    assert.equal(first.reasonCounts.manifest_replay_success, 81)
    assert.equal(first.manifestLotsMissingCurrentEvidence.length, 0)
    assert.equal(first.candidateNewEvidenceLotKeys.length, 27)
    assert.equal(first.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 81, 'pre-growth replay still withholds the 27')
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(first, 108), false, 'partial-unreproducible path must stay dark — the 81 are fully valid')
    assert.equal(first.manifestStructuralFailureAudit.refreshAllowed, false)

    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: true,
    })
    assert.equal(audit.existingCount, 81)
    assert.equal(audit.currentCandidateCount, 108)
    assert.equal(audit.newCandidateCount, 27)
    assert.equal(audit.existingReplayAllValid, true)
    assert.equal(audit.strictSuperset, true)
    assert.equal(audit.noValueDisagreement, true)
    assert.equal(audit.noFingerprintMismatch, true)
    assert.equal(audit.noDuplicates, true)
    assert.equal(audit.providerUsable, true)
    assert.equal(audit.growthAllowed, true)
    assert.equal(audit.growthBlockedReason, null)
    assert.equal(shouldRefreshAdditiveCandidateEvolution(audit), true)

    const originalRecords = original.verifiedLotRecords.map((r) => ({ key: r.key, cost: r.costBasisUsd, proceeds: r.proceedsUsd, pnl: r.realizedPnlUsd }))
    const refreshed = await buildRefreshedManifest({
      priorManifest: original, identity: identity('additive-81-108'), allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    assert.equal(refreshed.verifiedLotCount, 108)
    for (const old of originalRecords) {
      const next = refreshed.verifiedLotRecords.find((r) => r.key === old.key)
      assert.ok(next, `existing lot ${old.key} must survive additive growth`)
      assert.equal(next!.costBasisUsd, old.cost)
      assert.equal(next!.proceedsUsd, old.proceeds)
      assert.equal(next!.realizedPnlUsd, old.pnl)
    }
    const second = await replay(refreshed, currentLots, evidence.loader)
    assert.equal(second.outcome, 'applied')
    assert.equal(second.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 108)
    assert.equal(second.manifestLotsMissingCurrentEvidence.length, 0)
    assert.equal(second.structuralIntegrityFailure, false)
  })

  it('HARD ASSERTION: same 81-lot manifest + one existing value mismatch blocks growth', async () => {
    const oldLots = buildLots(81, 81)
    const newLots = Array.from({ length: 27 }, (_, offset) => {
      const i = 81 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('additive-mismatch'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const mutated = {
      ...original,
      verifiedLotRecords: original.verifiedLotRecords.map((record, i) => i === 0
        ? { ...record, groupCostBasisUsd: (record.groupCostBasisUsd ?? 0) + 50, costBasisUsd: (record.costBasisUsd ?? 0) + 50 }
        : record),
    }
    const first = await replay(mutated, currentLots, evidence.loader)
    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: true,
    })
    assert.equal(audit.growthAllowed, false)
    assert.ok(audit.growthBlockedReason === 'existing_manifest_not_fully_reproducible' || audit.growthBlockedReason === 'value_disagreement' || audit.growthBlockedReason === 'structural_integrity_failure')
    assert.equal(shouldRefreshAdditiveCandidateEvolution(audit), false)
  })

  it('HARD ASSERTION: current candidates fewer than the manifest never shrink it', async () => {
    const oldLots = buildLots(81, 81)
    const fewer = oldLots.slice(0, 70)
    const evidence = seededEvidence(oldLots)
    const original = await buildManifestFromCandidate({
      identity: identity('additive-noshrink'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const first = await replay(original, fewer, evidence.loader)
    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: fewer.filter(isCanonicalVerifiedPublishedLot).length, providerUsable: true,
    })
    assert.ok(audit.currentCandidateCount < audit.existingCount)
    assert.equal(audit.growthAllowed, false)
    assert.equal(audit.growthBlockedReason, 'would_shrink_manifest')
  })

  it('HARD ASSERTION: a duplicate candidate blocks additive growth', async () => {
    const oldLots = buildLots(81, 81)
    const newLots = Array.from({ length: 27 }, (_, offset) => {
      const i = 81 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('additive-dup'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const first = await replay(original, currentLots, evidence.loader)
    const withDuplicates = {
      ...first,
      duplicates: {
        ...first.duplicates,
        hasDuplicates: true,
        candidateDuplicateLotKeys: [first.candidateNewEvidenceLotKeys[0] ?? 'dup'],
      },
    }
    const audit = buildManifestAdditiveGrowthAudit({
      replay: withDuplicates, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: true,
    })
    assert.equal(audit.noDuplicates, false)
    assert.equal(audit.growthAllowed, false)
    assert.equal(audit.growthBlockedReason, 'duplicate_canonical_identity')
  })

  it('HARD ASSERTION: a structurally incompatible candidate set blocks additive growth', async () => {
    const lots = buildLots(2, 2)
    const { manifest, evidence } = await manifestWithEvidence(lots)
    const extra = lot({ lotId: 'lot-2', token: '0xtoken2', openedTxHash: '0xbuy2', closedTxHash: '0xsell2', openedAt: 2, closedAt: 1002, costBasisUsd: 12, proceedsUsd: 22, realizedPnlUsd: 10 })
    const corrupt = { ...manifest, verifiedLotIdentityKeys: [...manifest.verifiedLotIdentityKeys, manifest.verifiedLotIdentityKeys[0]] }
    const result = await replay(corrupt, [...lots, extra], evidence.loader)
    const audit = buildManifestAdditiveGrowthAudit({
      replay: result, manifestVerifiedLotCount: manifest.verifiedLotCount,
      currentCandidateVerifiedLotCount: 3, providerUsable: true,
    })
    assert.equal(audit.growthAllowed, false)
    assert.equal(audit.growthBlockedReason, 'structural_integrity_failure')
  })

  it('HARD ASSERTION: partial/unusable provider state cannot unsafe-refresh', async () => {
    const oldLots = buildLots(81, 81)
    const newLots = Array.from({ length: 27 }, (_, offset) => {
      const i = 81 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('additive-partial'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const first = await replay(original, currentLots, evidence.loader)
    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: false,
    })
    assert.equal(audit.providerUsable, false)
    assert.equal(audit.growthAllowed, false)
    assert.equal(audit.growthBlockedReason, 'provider_unusable')
    assert.equal(shouldRefreshAdditiveCandidateEvolution(audit), false)
  })
})

describe('additive provider-usable gate (GoldRush timeout vs independently proven candidates)', () => {
  const basePartial = {
    chain: 'base', providerStatus: 'partial',
    goldrush: { ok: false, errorReason: 'timeout' }, alchemy: { ok: true, errorReason: null },
  }
  const allOk = {
    chain: 'base', providerStatus: 'ok',
    goldrush: { ok: true, errorReason: null }, alchemy: { ok: true, errorReason: null },
  }

  it('HARD ASSERTION: GoldRush fails, all additive candidates independently verified by Alchemy/accepted evidence → growth allowed', async () => {
    const oldLots = buildLots(98, 98)
    const newLots = Array.from({ length: 10 }, (_, offset) => {
      const i = 98 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('provider-alchemy-ok'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const first = await replay(original, currentLots, evidence.loader)
    const identities = buildCanonicalLotIdentities(currentLots)
    const newKeys = new Set(first.candidateNewEvidenceLotKeys)
    const snapshots = newLots.map((lot) => ({
      lotKey: identities.get(lot)!.key, chain: lot.chain,
      entryEvidenceSource: 'canonical-upstream', exitEvidenceSource: 'canonical-upstream',
      independentlyVerified: true,
    })).filter((row) => newKeys.has(row.lotKey) || true)
    const dependency = buildManifestAdditiveProviderDependencyAudit({
      providerDiagnostics: [basePartial], newCandidates: snapshots,
    })
    assert.equal(dependency.historyBoundaryProviderUsable, false, 'full-history boundary remains PARTIAL')
    assert.equal(dependency.failedProviders.some((p) => p.provider === 'goldrush'), true)
    assert.equal(dependency.candidatesDependingOnFailedProvider, 0)
    assert.equal(dependency.candidatesIndependentOfFailedProvider, 10)
    assert.equal(dependency.additiveEvidenceUsable, true)
    assert.equal(dependency.additiveCandidateEvidenceProviderUsable, true)
    assert.ok(dependency.candidates.every((row) => row.independentlyVerifiedWithoutGoldrush && row.liveAlchemyUsed && !row.liveGoldrushUsed))
    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: dependency.additiveCandidateEvidenceProviderUsable,
    })
    assert.equal(audit.growthAllowed, true)
    assert.equal(audit.growthBlockedReason, null)
  })

  it('HARD ASSERTION: GoldRush fails and one candidate requires GoldRush → growth blocked', async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      lotKey: `lot-${i}`, chain: i === 0 ? 'eth' : 'base',
      entryEvidenceSource: i === 0 ? null : 'canonical-upstream',
      exitEvidenceSource: i === 0 ? null : 'canonical-upstream',
      independentlyVerified: true,
    }))
    const dependency = buildManifestAdditiveProviderDependencyAudit({
      providerDiagnostics: [
        basePartial,
        { chain: 'eth', providerStatus: 'provider_unavailable', goldrush: { ok: false, errorReason: 'timeout' }, alchemy: { ok: false, errorReason: 'timeout' } },
      ],
      newCandidates: snapshots,
    })
    assert.equal(dependency.candidatesDependingOnFailedProvider, 1)
    assert.equal(dependency.candidatesIndependentOfFailedProvider, 9)
    assert.equal(dependency.additiveEvidenceUsable, false)
    assert.equal(dependency.growthBlockedReason, 'additive_candidates_depend_on_failed_provider')
    assert.equal(dependency.candidates[0].independentlyVerifiedWithoutGoldrush, false)
    const oldLots = buildLots(98, 98)
    const newLots = Array.from({ length: 10 }, (_, offset) => {
      const i = 98 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('provider-one-depends'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const first = await replay(original, currentLots, evidence.loader)
    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: dependency.additiveCandidateEvidenceProviderUsable,
    })
    assert.equal(audit.growthAllowed, false)
    assert.equal(audit.growthBlockedReason, 'provider_unusable')
  })

  it('HARD ASSERTION: provider partial can never shrink the manifest', async () => {
    const oldLots = buildLots(98, 98)
    const fewer = oldLots.slice(0, 90)
    const evidence = seededEvidence(oldLots)
    const original = await buildManifestFromCandidate({
      identity: identity('provider-noshrink'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const first = await replay(original, fewer, evidence.loader)
    const dependency = buildManifestAdditiveProviderDependencyAudit({
      providerDiagnostics: [basePartial], newCandidates: [],
    })
    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: fewer.filter(isCanonicalVerifiedPublishedLot).length,
      providerUsable: dependency.additiveCandidateEvidenceProviderUsable,
    })
    assert.ok(audit.currentCandidateCount < audit.existingCount)
    assert.equal(audit.growthAllowed, false)
    assert.equal(audit.growthBlockedReason, 'would_shrink_manifest')
  })

  it('HARD ASSERTION: existing manifest mismatch still blocks growth even when Alchemy is ok', async () => {
    const oldLots = buildLots(98, 98)
    const newLots = Array.from({ length: 10 }, (_, offset) => {
      const i = 98 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const original = await buildManifestFromCandidate({
      identity: identity('provider-mismatch'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const mutated = {
      ...original,
      verifiedLotRecords: original.verifiedLotRecords.map((record, i) => i === 0
        ? { ...record, groupCostBasisUsd: (record.groupCostBasisUsd ?? 0) + 50, costBasisUsd: (record.costBasisUsd ?? 0) + 50 }
        : record),
    }
    const first = await replay(mutated, currentLots, evidence.loader)
    const dependency = buildManifestAdditiveProviderDependencyAudit({
      providerDiagnostics: [allOk],
      newCandidates: newLots.map((lot, i) => ({
        lotKey: `new-${i}`, chain: lot.chain,
        entryEvidenceSource: 'canonical-upstream', exitEvidenceSource: 'canonical-upstream',
        independentlyVerified: true,
      })),
    })
    assert.equal(dependency.additiveCandidateEvidenceProviderUsable, true)
    const audit = buildManifestAdditiveGrowthAudit({
      replay: first, manifestVerifiedLotCount: original.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: dependency.additiveCandidateEvidenceProviderUsable,
    })
    assert.equal(audit.growthAllowed, false)
    assert.ok(audit.growthBlockedReason === 'existing_manifest_not_fully_reproducible' || audit.growthBlockedReason === 'value_disagreement' || audit.growthBlockedReason === 'structural_integrity_failure')
  })
})

describe('additive rebuild freezes live verified values instead of dust allocation', () => {
  function dustSharedEntryLots() {
    const existing = lot({
      lotId: 'existing-usdc', token: '0xusdc', amount: 10_000_000_000,
      openedTxHash: '0xsharedbuy', closedTxHash: '0xsell-existing', openedAt: 1, closedAt: 2,
      costBasisUsd: 100, proceedsUsd: 110, realizedPnlUsd: 10,
    })
    const additive = lot({
      lotId: 'additive-usdc', token: '0xusdc', amount: 1,
      openedTxHash: '0xsharedbuy', closedTxHash: '0xsell-additive', openedAt: 1, closedAt: 3,
      costBasisUsd: 42.5, proceedsUsd: 50, realizedPnlUsd: 7.5,
    })
    return { existing, additive }
  }

  function seedDustEntry(existing: MatchedLot, additive: MatchedLot, extra: MatchedLot[] = []) {
    const store = new Map<string, unknown>()
    const kv: AcceptedEvidenceKvLike = {
      get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    }
    const write = (lotRef: MatchedLot, side: 'entry' | 'exit', priceUsd: number) => {
      const identity = {
        chain: lotRef.chain, token: lotRef.token,
        txHash: side === 'entry' ? lotRef.openedTxHash : lotRef.closedTxHash,
        side, timestamp: side === 'entry' ? lotRef.openedAt : lotRef.closedAt,
        lotIdentityVersion: lotIdentityVersion(lotRef),
      }
      store.set(buildAcceptedEvidenceKey(identity), buildAcceptedEvidenceEnvelope({
        identity, priceUsd, valueUsd: priceUsd, source: 'canonical-upstream',
        evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
      }))
    }
    write(existing, 'entry', 1)
    write(existing, 'exit', existing.proceedsUsd as number)
    write(additive, 'exit', additive.proceedsUsd as number)
    for (const lotRef of extra) {
      write(lotRef, 'entry', (lotRef.costBasisUsd as number) || 1)
      write(lotRef, 'exit', (lotRef.proceedsUsd as number) || 1)
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
        : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)
    return { loader, kv }
  }

  it('HARD ASSERTION: additive candidate with verified live values + dust accepted allocation freezes live verified values', async () => {
    const { existing, additive } = dustSharedEntryLots()
    assert.equal(isCanonicalVerifiedPublishedLot(additive), true)
    const evidence = seedDustEntry(existing, additive)
    const original = await buildManifestFromCandidate({
      identity: identity('rebuild-live-dust'), allCandidateLots: [existing], candidateVerifiedLots: [existing],
      structuralLotCount: 1, fingerprints: computeFingerprints([existing], realizedTotal([existing])),
      realizedPnlUsd: realizedTotal([existing]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const existingKey = original.verifiedLotRecords[0].key
    const existingCost = original.verifiedLotRecords[0].costBasisUsd
    const existingProceeds = original.verifiedLotRecords[0].proceedsUsd
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: identity('rebuild-live-dust'),
      allCandidateLots: [existing, additive], candidateVerifiedLots: [existing, additive],
      structuralLotCount: 2, fingerprints: computeFingerprints([existing, additive], realizedTotal([existing, additive])),
      realizedPnlUsd: realizedTotal([existing, additive]), verifiedPricingCoverage: 1, now: NOW + 1,
      refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
      preferLiveCanonicalValuesWhenAllocatedNotPositive: true,
    })
    assert.equal(rebuilt.verifiedLotCount, 2)
    const additiveIdentity = [...buildCanonicalLotIdentities([additive]).values()][0]
    const additiveRecord = rebuilt.verifiedLotRecords.find((r) => r.key === additiveIdentity.key)
    assert.ok(additiveRecord, 'additive lot must be emitted')
    assert.equal(additiveRecord!.costBasisUsd, 42.5)
    assert.equal(additiveRecord!.proceedsUsd, 50)
    const auditRow = rebuilt.manifestAdditiveRebuildCandidateAudit?.candidates.find((row) => row.lotKey === additiveIdentity.key)
    assert.equal(auditRow?.sourceChosen, 'live_canonical_candidate')
    assert.equal(auditRow?.emitted, true)
    assert.equal(auditRow?.dropReason, null)
    const existingRecord = rebuilt.verifiedLotRecords.find((r) => r.key === existingKey)
    assert.ok(existingRecord)
    assert.equal(existingRecord!.costBasisUsd, existingCost)
    assert.equal(existingRecord!.proceedsUsd, existingProceeds)
  })

  it('HARD ASSERTION: non-verified live candidate + dust allocation is still rejected', async () => {
    const { existing, additive } = dustSharedEntryLots()
    const unverified = { ...additive, evidenceQuality: 'unpriced' as const, costBasisUsd: 42.5, proceedsUsd: 50, realizedPnlUsd: 7.5 }
    const evidence = seedDustEntry(existing, unverified)
    const original = await buildManifestFromCandidate({
      identity: identity('rebuild-unverified'), allCandidateLots: [existing], candidateVerifiedLots: [existing],
      structuralLotCount: 1, fingerprints: computeFingerprints([existing], realizedTotal([existing])),
      realizedPnlUsd: realizedTotal([existing]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: identity('rebuild-unverified'),
      allCandidateLots: [existing, unverified], candidateVerifiedLots: [existing],
      structuralLotCount: 2, fingerprints: computeFingerprints([existing], realizedTotal([existing])),
      realizedPnlUsd: realizedTotal([existing]), verifiedPricingCoverage: 0.5, now: NOW + 1,
      refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
      preferLiveCanonicalValuesWhenAllocatedNotPositive: true,
    })
    const unverifiedKey = [...buildCanonicalLotIdentities([unverified]).values()][0].key
    assert.ok(!rebuilt.verifiedLotIdentityKeys.includes(unverifiedKey))
    assert.equal(rebuilt.verifiedLotCount, 1)
  })

  it('HARD ASSERTION: existing manifest lots never switch from frozen evidence to live values', async () => {
    const existing = lot({
      lotId: 'existing-independent', token: '0xold', openedTxHash: '0xoldbuy', closedTxHash: '0xoldsell',
      costBasisUsd: 100, proceedsUsd: 110, realizedPnlUsd: 10,
    })
    const additive = lot({
      lotId: 'additive-independent', token: '0xnew', openedTxHash: '0xnewbuy', closedTxHash: '0xnewsell',
      openedAt: 5, closedAt: 6, costBasisUsd: 42.5, proceedsUsd: 50, realizedPnlUsd: 7.5,
    })
    const evidence = seededEvidence([existing, additive])
    const original = await buildManifestFromCandidate({
      identity: identity('rebuild-existing-frozen'), allCandidateLots: [existing], candidateVerifiedLots: [existing],
      structuralLotCount: 1, fingerprints: computeFingerprints([existing], realizedTotal([existing])),
      realizedPnlUsd: realizedTotal([existing]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const frozenCost = original.verifiedLotRecords[0].costBasisUsd
    const frozenProceeds = original.verifiedLotRecords[0].proceedsUsd
    const liveDrifted = { ...existing, costBasisUsd: 999, proceedsUsd: 1000, realizedPnlUsd: 1 }
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: identity('rebuild-existing-frozen'),
      allCandidateLots: [liveDrifted, additive], candidateVerifiedLots: [liveDrifted, additive],
      structuralLotCount: 2, fingerprints: computeFingerprints([liveDrifted, additive], realizedTotal([liveDrifted, additive])),
      realizedPnlUsd: realizedTotal([liveDrifted, additive]), verifiedPricingCoverage: 1, now: NOW + 1,
      refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
      preferLiveCanonicalValuesWhenAllocatedNotPositive: true,
    })
    const existingKey = original.verifiedLotRecords[0].key
    const existingRecord = rebuilt.verifiedLotRecords.find((r) => r.key === existingKey)
    assert.ok(existingRecord)
    assert.equal(existingRecord!.costBasisUsd, frozenCost)
    assert.equal(existingRecord!.proceedsUsd, frozenProceeds)
    assert.notEqual(existingRecord!.costBasisUsd, 999)
  })

  it('HARD ASSERTION: rebuild count below candidates aborts without write', async () => {
    const { existing, additive } = dustSharedEntryLots()
    const unverified = { ...additive, evidenceQuality: 'unpriced' as const }
    const evidence = seedDustEntry(existing, unverified)
    const original = await buildManifestFromCandidate({
      identity: identity('rebuild-abort'), allCandidateLots: [existing], candidateVerifiedLots: [existing],
      structuralLotCount: 1, fingerprints: computeFingerprints([existing], realizedTotal([existing])),
      realizedPnlUsd: realizedTotal([existing]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const kv = jsonKv()
    await writeCanonicalPnlSampleManifest(kv, original)
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: identity('rebuild-abort'),
      allCandidateLots: [existing, unverified], candidateVerifiedLots: [existing],
      structuralLotCount: 2, fingerprints: computeFingerprints([existing, unverified], realizedTotal([existing])),
      realizedPnlUsd: realizedTotal([existing]), verifiedPricingCoverage: 0.5, now: NOW + 1,
      refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
      preferLiveCanonicalValuesWhenAllocatedNotPositive: true,
    })
    assert.ok(rebuilt.verifiedLotCount < 2)
    const application = await applyRefreshedCanonicalManifest({
      kv, identity: identity('rebuild-abort'), rebuilt,
      allCandidateLots: [existing, unverified],
      loadEvidence: evidence.loader, computeFingerprints,
      requireVerifiedLotCount: 2, growthAllowed: true,
    })
    assert.equal(application.applied, false)
    assert.equal(application.audit.writeAttempted, false)
    assert.equal(application.audit.writeFailureReason, 'rebuilt_count_below_candidates')
    const intact = await readCanonicalPnlSampleManifest(kv, identity('rebuild-abort'))
    assert.equal(intact.manifest?.verifiedLotCount, 1)
  })
})

describe('additive live-canonical provenance replay', () => {
  function dustPair() {
    const existing = lot({
      lotId: 'existing-usdc', token: '0xusdc', amount: 10_000_000_000,
      openedTxHash: '0xsharedbuy', closedTxHash: '0xsell-existing', openedAt: 1, closedAt: 2,
      costBasisUsd: 100, proceedsUsd: 110, realizedPnlUsd: 10,
    })
    const additive = lot({
      lotId: 'additive-usdc', token: '0xusdc', amount: 1,
      openedTxHash: '0xsharedbuy', closedTxHash: '0xsell-additive', openedAt: 1, closedAt: 3,
      costBasisUsd: 42.5, proceedsUsd: 50, realizedPnlUsd: 7.5,
    })
    return { existing, additive }
  }
  function seedDust(existing: MatchedLot, additive: MatchedLot) {
    const store = new Map<string, unknown>()
    const kv: AcceptedEvidenceKvLike = {
      get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    }
    const write = (lotRef: MatchedLot, side: 'entry' | 'exit', priceUsd: number) => {
      const identityFields = {
        chain: lotRef.chain, token: lotRef.token,
        txHash: side === 'entry' ? lotRef.openedTxHash : lotRef.closedTxHash,
        side, timestamp: side === 'entry' ? lotRef.openedAt : lotRef.closedAt,
        lotIdentityVersion: lotIdentityVersion(lotRef),
      }
      store.set(buildAcceptedEvidenceKey(identityFields), buildAcceptedEvidenceEnvelope({
        identity: identityFields, priceUsd, valueUsd: priceUsd, source: 'canonical-upstream',
        evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
      }))
    }
    write(existing, 'entry', 1)
    write(existing, 'exit', existing.proceedsUsd as number)
    write(additive, 'exit', additive.proceedsUsd as number)
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
        : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)
    return { loader }
  }
  async function rebuiltDustManifest() {
    const { existing, additive } = dustPair()
    const evidence = seedDust(existing, additive)
    const original = await buildManifestFromCandidate({
      identity: identity('live-prov'), allCandidateLots: [existing], candidateVerifiedLots: [existing],
      structuralLotCount: 1, fingerprints: computeFingerprints([existing], realizedTotal([existing])),
      realizedPnlUsd: realizedTotal([existing]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: identity('live-prov'),
      allCandidateLots: [existing, additive], candidateVerifiedLots: [existing, additive],
      structuralLotCount: 2, fingerprints: computeFingerprints([existing, additive], realizedTotal([existing, additive])),
      realizedPnlUsd: realizedTotal([existing, additive]), verifiedPricingCoverage: 1, now: NOW + 1,
      refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
      preferLiveCanonicalValuesWhenAllocatedNotPositive: true,
    })
    return { existing, additive, evidence, original, rebuilt }
  }

  it('HARD ASSERTION: additive manifest record sourced from verified live canonical candidate replays successfully', async () => {
    const { existing, additive, evidence, rebuilt } = await rebuiltDustManifest()
    const additiveKey = [...buildCanonicalLotIdentities([additive]).values()][0].key
    const additiveRecord = rebuilt.verifiedLotRecords.find((r) => r.key === additiveKey)
    assert.equal(additiveRecord?.valueProvenance, 'live_canonical_candidate')
    const replayResult = await replay(rebuilt, [existing, additive], evidence.loader)
    assert.equal(replayResult.outcome, 'applied')
    assert.equal(replayResult.reasonCounts.manifest_replay_success, 2)
    const published = replayResult.publishedLots.filter(isCanonicalVerifiedPublishedLot)
    assert.equal(published.length, 2)
    const publishedAdditive = published.find((l) => l.closedTxHash === additive.closedTxHash)
    assert.equal(publishedAdditive?.costBasisUsd, 42.5)
    assert.equal(publishedAdditive?.proceedsUsd, 50)
  })

  it('HARD ASSERTION: same record with changed live value fails replay', async () => {
    const { existing, additive, evidence, rebuilt } = await rebuiltDustManifest()
    const changed = { ...additive, costBasisUsd: 99, proceedsUsd: 80, realizedPnlUsd: -19 }
    const replayResult = await replay(rebuilt, [existing, changed], evidence.loader)
    assert.equal(replayResult.outcome, 'unavailable')
    assert.ok(replayResult.reasonCounts.manifest_cost_basis_mismatch > 0 || replayResult.reasonCounts.manifest_proceeds_mismatch > 0)
  })

  it('HARD ASSERTION: same record without provenance fails closed', async () => {
    const { existing, additive, evidence, rebuilt } = await rebuiltDustManifest()
    const additiveKey = [...buildCanonicalLotIdentities([additive]).values()][0].key
    const stripped: CanonicalPnlSampleManifest = {
      ...rebuilt,
      verifiedLotRecords: rebuilt.verifiedLotRecords.map((record) => {
        if (record.key !== additiveKey) return record
        const { valueProvenance: _drop, ...rest } = record
        return rest
      }),
    }
    const replayResult = await replay(stripped, [existing, additive], evidence.loader)
    assert.equal(replayResult.outcome, 'unavailable')
    assert.equal(stripped.verifiedLotRecords.find((r) => r.key === additiveKey)?.valueProvenance, undefined)
  })

  it('HARD ASSERTION: existing accepted-evidence manifest records unchanged', async () => {
    const { existing, additive, evidence, original, rebuilt } = await rebuiltDustManifest()
    const existingKey = original.verifiedLotRecords[0].key
    const existingRecord = rebuilt.verifiedLotRecords.find((r) => r.key === existingKey)!
    assert.equal(existingRecord.valueProvenance, undefined)
    assert.equal(existingRecord.costBasisUsd, original.verifiedLotRecords[0].costBasisUsd)
    assert.equal(existingRecord.proceedsUsd, original.verifiedLotRecords[0].proceedsUsd)
    const replayResult = await replay(rebuilt, [existing, additive], evidence.loader)
    assert.equal(replayResult.outcome, 'applied')
    const publishedExisting = replayResult.publishedLots.find((l) => l.closedTxHash === existing.closedTxHash)
    assert.equal(publishedExisting?.costBasisUsd, original.verifiedLotRecords[0].costBasisUsd)
    assert.equal(publishedExisting?.proceedsUsd, original.verifiedLotRecords[0].proceedsUsd)
  })
})

describe('additive manifest refresh application / persistence', () => {
  async function builtAdditivePair(existingCount: number, newCount: number) {
    const oldLots = buildLots(existingCount, existingCount)
    const newLots = Array.from({ length: newCount }, (_, offset) => {
      const i = existingCount + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 1000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const id = identity(`apply-${existingCount}-${newCount}-${currentLots.length}`)
    const original = await buildManifestFromCandidate({
      identity: id, allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    return { oldLots, newLots, currentLots, evidence, id, original }
  }

  it('HARD ASSERTION: 98→108 additive refresh persists and publishes in the same scan', async () => {
    const { currentLots, evidence, id, original } = await builtAdditivePair(98, 10)
    const kv = jsonKv()
    assert.equal(await writeCanonicalPnlSampleManifest(kv, original), true)
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: id, allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
      preferLiveCanonicalValuesWhenAllocatedNotPositive: true,
    })
    const application = await applyRefreshedCanonicalManifest({
      kv, identity: id, rebuilt, allCandidateLots: currentLots,
      loadEvidence: evidence.loader, computeFingerprints,
      requireVerifiedLotCount: 108, growthAllowed: true,
    })
    assert.equal(application.applied, true)
    assert.equal(application.audit.writeAttempted, true)
    assert.equal(application.audit.writeSuccess, true)
    assert.equal(application.audit.writeFailureReason, null)
    assert.equal(application.audit.rebuiltLotCount, 108)
    assert.equal(application.audit.rereadCount, 108)
    assert.equal(application.audit.publishedCount, 108)
    assert.equal(application.persisted?.verifiedLotCount, 108)
    assert.equal(application.replay?.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 108)
    const reread = await readCanonicalPnlSampleManifest(kv, id)
    assert.equal(reread.manifest?.verifiedLotCount, 108)
  })

  it('HARD ASSERTION: refreshApplied cannot be true if write did not happen', async () => {
    const { currentLots, evidence, id, original } = await builtAdditivePair(98, 10)
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: id, allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const failingKv: CanonicalSampleManifestKvLike = {
      get: async <T>(_key: string) => original as T,
      set: async () => { throw new Error('kv write denied') },
    }
    const application = await applyRefreshedCanonicalManifest({
      kv: failingKv, identity: id, rebuilt, allCandidateLots: currentLots,
      loadEvidence: evidence.loader, computeFingerprints,
      requireVerifiedLotCount: 108, growthAllowed: true,
    })
    assert.equal(application.applied, false)
    assert.equal(application.audit.writeAttempted, true)
    assert.equal(application.audit.writeSuccess, false)
    assert.equal(application.audit.writeFailureReason, 'write_failed')
    assert.equal(application.persisted, null)
  })

  it('HARD ASSERTION: failed write leaves the old 98-lot manifest/publication intact and reports failure', async () => {
    const { currentLots, evidence, id, original } = await builtAdditivePair(98, 10)
    const kv = jsonKv()
    assert.equal(await writeCanonicalPnlSampleManifest(kv, original), true)
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: id, allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const failingKv: CanonicalSampleManifestKvLike = {
      get: async <T>(key: string) => kv.get<T>(key),
      set: async () => { throw new Error('kv write denied') },
    }
    const application = await applyRefreshedCanonicalManifest({
      kv: failingKv, identity: id, rebuilt, allCandidateLots: currentLots,
      loadEvidence: evidence.loader, computeFingerprints,
      requireVerifiedLotCount: 108, growthAllowed: true,
    })
    assert.equal(application.applied, false)
    assert.equal(application.audit.writeSuccess, false)
    const intact = await readCanonicalPnlSampleManifest(kv, id)
    assert.equal(intact.manifest?.verifiedLotCount, 98, 'the durable 98-lot sample must not be overwritten on write failure')
  })

  it('HARD ASSERTION: next identical scan after a successful 108 write performs no refresh', async () => {
    const { currentLots, evidence, id, original } = await builtAdditivePair(98, 10)
    const kv = jsonKv()
    await writeCanonicalPnlSampleManifest(kv, original)
    const rebuilt = await buildRefreshedManifest({
      priorManifest: original, identity: id, allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'additive-candidate-evolution-strict-superset',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const firstApply = await applyRefreshedCanonicalManifest({
      kv, identity: id, rebuilt, allCandidateLots: currentLots,
      loadEvidence: evidence.loader, computeFingerprints,
      requireVerifiedLotCount: 108, growthAllowed: true,
    })
    assert.equal(firstApply.applied, true)
    const stored = (await readCanonicalPnlSampleManifest(kv, id)).manifest!
    const secondReplay = await replay(stored, currentLots, evidence.loader)
    assert.equal(secondReplay.outcome, 'applied')
    assert.equal(secondReplay.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 108)
    const audit = buildManifestAdditiveGrowthAudit({
      replay: secondReplay, manifestVerifiedLotCount: stored.verifiedLotCount,
      currentCandidateVerifiedLotCount: 108, providerUsable: true,
    })
    assert.equal(audit.growthAllowed, false)
    assert.equal(audit.newCandidateCount, 0)
    assert.equal(audit.growthBlockedReason, 'no_new_candidates')
  })
})

describe('refreshed canonical manifest replay failure — build-time self-validation (Wallet PnL manifest-refresh follow-up task)', () => {
  // CONFIRMED ROOT CAUSE, DISCLOSED: two individually-verified sells (both costBasisUsd/proceedsUsd
  // already positive BEFORE any evidence reallocation) funded by the SAME buy transaction, with
  // wildly different amounts. `allocateSideValueAcrossGroup`'s proportional BigInt split gives the
  // tiny-amount sibling a genuinely floored-to-zero share of that shared entry evidence total — a
  // real, deterministic truncation, not a fluke — while the large sibling absorbs the whole
  // remainder. Before this fix, `buildManifestFromCandidate` persisted that zero-valued
  // reconstruction into the manifest unconditionally; `replayManifest` (which independently
  // reconstructs and validates every occurrence) then correctly, and identically on every refresh,
  // rejected it as `manifest_canonical_verifier_rejection` — reproducing the same broken count
  // forever, since a rebuild-and-rewrite refresh recomputes the exact same allocation from the exact
  // same evidence.
  function sharedEntryGroupLots() {
    const tiny = lot({
      lotId: 'tiny', token: '0xshared', amount: 0.000001,
      openedTxHash: '0xsharedbuy', closedTxHash: '0xsellaaatiny', openedAt: 1, closedAt: 2,
      costBasisUsd: 5, proceedsUsd: 6, realizedPnlUsd: 1,
    })
    const large = lot({
      lotId: 'large', token: '0xshared', amount: 1000,
      openedTxHash: '0xsharedbuy', closedTxHash: '0xsellzzzlarge', openedAt: 1, closedAt: 3,
      costBasisUsd: 4, proceedsUsd: 9, realizedPnlUsd: 5,
    })
    return { tiny, large }
  }

  it('never persists a manifest record whose reconstructed value would fail the shared canonical predicate — excludes the floored-to-zero sibling instead of freezing it', async () => {
    const { tiny, large } = sharedEntryGroupLots()
    const evidence = seededEvidence([tiny, large])
    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: [tiny, large], candidateVerifiedLots: [tiny, large],
      structuralLotCount: 2, fingerprints: computeFingerprints([tiny, large], realizedTotal([tiny, large])),
      realizedPnlUsd: realizedTotal([tiny, large]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    // The genuinely floored-to-zero sibling never becomes a manifest record at all.
    const largeIdentity = [...buildCanonicalLotIdentities([large]).values()][0]
    const tinyIdentity = [...buildCanonicalLotIdentities([tiny]).values()][0]
    assert.ok(manifest.verifiedLotIdentityKeys.includes(largeIdentity.key), 'the genuinely valid sibling is still published')
    assert.ok(!manifest.verifiedLotIdentityKeys.includes(tinyIdentity.key), 'the floored-to-zero sibling is never frozen into the manifest')
    assert.equal(manifest.verifiedLotCount, 1)

    // Diagnosed, not silently dropped.
    assert.ok(manifest.manifestCanonicalVerifierAudit)
    assert.equal(manifest.manifestCanonicalVerifierAudit!.rejectedCount, 1)
    assert.equal(manifest.manifestCanonicalVerifierAudit!.reasons.non_positive_entry_price, 1)
    assert.equal(manifest.manifestCanonicalVerifierAudit!.examples[0].canonicalLotKey, tinyIdentity.key)
    assert.equal(manifest.manifestCanonicalVerifierAudit!.examples[0].costBasisUsd, 0)

    // A manifest containing ONLY records it has already proven pass the predicate must replay clean —
    // never reproduce `manifest_canonical_verifier_rejection` on the exact evidence it was built from.
    const result = await replay(manifest, [tiny, large], evidence.loader)
    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_canonical_verifier_rejection, 0)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 1)
  })

  it('a refresh built from the same degenerate evidence does not reproduce the same rejection forever — it converges instead of looping', async () => {
    const { tiny, large } = sharedEntryGroupLots()
    const currentLots = [tiny, large]
    const evidence = seededEvidence(currentLots)
    // First (pre-fix-shaped) manifest: simulate the historical bug by writing a record for BOTH
    // siblings via a manifest built before this fix existed — i.e. skip self-validation by directly
    // constructing a stale manifest whose `tiny` record still carries a zero group total, matching
    // exactly what production observed.
    const validManifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: currentLots, candidateVerifiedLots: currentLots,
      structuralLotCount: 2, fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)),
      realizedPnlUsd: realizedTotal(currentLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const tinyIdentity = [...buildCanonicalLotIdentities([tiny]).values()][0]
    const [realEntryEvidenceKey, realExitEvidenceKey] = acceptedEvidenceIdentityKeysForLot(tiny)
    // The REAL entry evidence total for tiny's evidence group (shared with `large`) floors to exactly
    // $0 under the genuine BigInt proportional allocation — matching what a pre-fix build would have
    // frozen. Using the real keys (not a fake placeholder) is essential: replay must resolve real
    // evidence and recompute the SAME live $0 total, so this record exercises the canonical-verifier
    // rejection branch specifically, never the earlier missing-evidence branch.
    const staleRecordShape = {
      key: tinyIdentity.key, canonicalAmount: tinyIdentity.canonicalAmount, occurrenceCount: 1, partialFillGroupSize: 1,
      groupCostBasisUsd: 0, groupProceedsUsd: 6, groupRealizedPnlUsd: 6,
      chain: tiny.chain, token: tiny.token, openedTxHash: tiny.openedTxHash, closedTxHash: tiny.closedTxHash,
      openedAt: tiny.openedAt, closedAt: tiny.closedAt, lotIdentityVersion: lotIdentityVersion(tiny),
      entryEvidenceKey: realEntryEvidenceKey, exitEvidenceKey: realExitEvidenceKey,
      entryEvidenceLotIdentityVersion: lotIdentityVersion(large), exitEvidenceLotIdentityVersion: lotIdentityVersion(tiny),
      entryPriceUsd: 0, entryValueUsd: null, exitPriceUsd: 6, exitValueUsd: null,
      costBasisUsd: 0, proceedsUsd: 6, realizedPnlUsd: 6, evidenceQuality: 'verified' as const,
      entrySource: null, exitSource: null, pricingMethodologyVersion: 2, evidenceSchemaVersion: null,
      acceptedEvidenceValueType: 'total_side_value_usd' as const,
      entrySideGroupIdentity: 'stale-entry', entrySideGroupRawQuantity: '0', entryLotRawQuantity: '0',
      entryAllocationNumerator: '0', entryAllocationDenominator: '0',
      exitSideGroupIdentity: 'stale-exit', exitSideGroupRawQuantity: '0', exitLotRawQuantity: '0',
      exitAllocationNumerator: '0', exitAllocationDenominator: '0',
      allocatedCostBasisUsd: 0, allocatedProceedsUsd: 6,
      entryGroupTotalUsd: 0, exitGroupTotalUsd: 6,
      entryGroupFingerprint: 'stale-entry-fingerprint', exitGroupFingerprint: 'stale-exit-fingerprint',
    }
    const preFixShapedManifest: CanonicalPnlSampleManifest = {
      ...validManifest,
      verifiedLotIdentityKeys: [...validManifest.verifiedLotIdentityKeys, tinyIdentity.key],
      verifiedLotRecords: [...validManifest.verifiedLotRecords, staleRecordShape],
      verifiedLotCount: validManifest.verifiedLotCount + 1,
    }

    const firstReplay = await replay(preFixShapedManifest, currentLots, evidence.loader)
    assert.equal(firstReplay.reasonCounts.manifest_canonical_verifier_rejection, 1, 'reproduces the confirmed production symptom')
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(firstReplay, currentLots.length), true)

    // Refresh: rebuild FROM CURRENT CANDIDATES via this fix's own build-time self-validation.
    const refreshed = await buildRefreshedManifest({
      priorManifest: preFixShapedManifest, identity: identity(), allCandidateLots: currentLots,
      candidateVerifiedLots: currentLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentLots, realizedTotal(currentLots)), realizedPnlUsd: realizedTotal(currentLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'partially-unreproducible-manifest-current-evidence-refresh',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const secondReplay = await replay(refreshed, currentLots, evidence.loader)
    // MUST NOT silently reproduce the old rejection — either it converges clean, or it fails with a
    // genuinely different, honestly-diagnosed reason. It never loops on the identical broken shape.
    assert.equal(secondReplay.reasonCounts.manifest_canonical_verifier_rejection, 0, 'the refreshed manifest never carries the floored-to-zero record forward')
    assert.equal(secondReplay.outcome, 'applied')
    assert.equal(secondReplay.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 1, 'only the genuinely valid sibling publishes')
  })

  it('a current candidate marked verified but with a non-positive entry price is excluded before refresh, with the exact reason, and never promoted', async () => {
    const zeroEntry = lot({
      lotId: 'zero-entry', token: '0xzero', amount: 5, openedTxHash: '0xzerobuy', closedTxHash: '0xzerosell',
      costBasisUsd: 0, proceedsUsd: 10, realizedPnlUsd: 10, evidenceQuality: 'verified',
    })
    assert.equal(isCanonicalVerifiedPublishedLot(zeroEntry), false, 'the shared predicate already rejects a zero entry price on its own')
    const evidence = seededEvidence([])
    // No accepted evidence exists for this lot (a zero-priced "verified" candidate is never a real
    // accepted-evidence record) — build must still never promote it via the legacy no-evidence
    // fallback path either.
    const manifest = await buildManifestFromCandidate({
      identity: identity(), allCandidateLots: [zeroEntry], candidateVerifiedLots: [zeroEntry],
      structuralLotCount: 1, fingerprints: computeFingerprints([], null), realizedPnlUsd: null,
      verifiedPricingCoverage: 0, now: NOW, loadEvidence: evidence.loader, computeFingerprints,
    })
    assert.equal(manifest.verifiedLotCount, 0)
    assert.equal(manifest.verifiedLotIdentityKeys.length, 0)
  })
})

describe('canonical pricing methodology compatibility', () => {
  it('uses methodology v2 so manifests that predate strict quote normalization miss cleanly', () => {
    const current = identity()
    const preNormalization = buildManifestIdentity({ walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1', pricingMethodologyVersion: 1 })
    assert.equal(current.pricingMethodologyVersion, 2)
    assert.notEqual(buildManifestKey(current), buildManifestKey(preNormalization))
    assert.match(buildManifestKey(current), /methodology-v2/)
  })
})

describe('canonical-manifest-shared-group-allocation follow-up task — production shape', () => {
  // Live production shape this reproduces: 108 canonical-valid input candidates, 6 with a
  // genuinely-dust ENTRY-side allocation (their true fractional share of a shared buy floors below
  // the smallest representable USD unit) and 7 with a genuinely-dust EXIT-side allocation — none of
  // which involve any OTHER structural defect. Before this fix, the (now-removed) whole-group
  // demotion collapsed this shape to 37 published lots; the correct output preserves every valid
  // sibling and excludes ONLY the 13 genuinely-dust occurrences.
  function buildProductionShapeFixture() {
    const hosts: MatchedLot[] = Array.from({ length: 95 }, (_, i) => lot({
      lotId: `host-${i}`, token: `0xtok${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`,
      openedAt: i, closedAt: 1000 + i, amount: 100,
      costBasisUsd: 50 + i, proceedsUsd: 80 + i, realizedPnlUsd: 30,
    }))
    // Hosts 0..5 each get a dust ENTRY-side sibling (shares the host's OWN buy tx).
    const tinyEntries: MatchedLot[] = Array.from({ length: 6 }, (_, i) => {
      const host = hosts[i]
      return lot({
        lotId: `tiny-entry-${i}`, token: host.token, openedTxHash: host.openedTxHash, closedTxHash: `0xtinyentrysell${i}`,
        openedAt: host.openedAt, closedAt: 2000 + i, amount: 0.000000001,
        costBasisUsd: 0.000005, proceedsUsd: 0.000006, realizedPnlUsd: 0.000001,
      })
    })
    // Hosts 6..12 (distinct from the entry-tiny hosts) each get a dust EXIT-side sibling (shares the
    // host's OWN sell tx).
    const tinyExits: MatchedLot[] = Array.from({ length: 7 }, (_, i) => {
      const host = hosts[6 + i]
      return lot({
        lotId: `tiny-exit-${i}`, token: host.token, openedTxHash: `0xtinyexitbuy${i}`, closedTxHash: host.closedTxHash,
        openedAt: i, closedAt: host.closedAt, amount: 0.000000001,
        costBasisUsd: 0.000005, proceedsUsd: 0.000006, realizedPnlUsd: 0.000001,
      })
    })
    return { hosts, tinyEntries, tinyExits, allLots: [...hosts, ...tinyEntries, ...tinyExits] }
  }

  function customEvidenceStore() {
    const store = new Map<string, unknown>()
    const kv: AcceptedEvidenceKvLike = {
      get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
      set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
    }
    const seedSide = (lotRef: MatchedLot, side: 'entry' | 'exit', totalUsd: number) => {
      const sideIdentity = {
        chain: lotRef.chain, token: lotRef.token,
        txHash: side === 'entry' ? lotRef.openedTxHash : lotRef.closedTxHash,
        side, timestamp: side === 'entry' ? lotRef.openedAt : lotRef.closedAt,
        lotIdentityVersion: lotIdentityVersion(lotRef),
      }
      store.set(buildAcceptedEvidenceKey(sideIdentity), buildAcceptedEvidenceEnvelope({
        identity: sideIdentity, priceUsd: totalUsd, valueUsd: totalUsd,
        source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
      }))
    }
    const loader: AcceptedEvidenceLoader = ({ lotIdentityVersion: version, ...rest }) =>
      version === null
        ? readAcceptedEvidenceAnyLotVersion(kv, rest, NOW)
        : readAcceptedEvidence(kv, { ...rest, lotIdentityVersion: version }, NOW)
    return { seedSide, loader }
  }

  it('13 genuinely-dust local occurrences never cascade into the 71-lot loss the old whole-group demotion caused', async () => {
    const { hosts, tinyEntries, tinyExits, allLots } = buildProductionShapeFixture()
    const { seedSide, loader } = customEvidenceStore()

    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i]
      if (i < 6) {
        // Shared entry: the real total is host's real cost basis plus its dust sibling's real (tiny)
        // cost basis — never fabricated, the true combined transaction-side value.
        seedSide(host, 'entry', host.costBasisUsd! + tinyEntries[i].costBasisUsd!)
        seedSide(host, 'exit', host.proceedsUsd!) // unshared
      } else if (i < 13) {
        seedSide(host, 'entry', host.costBasisUsd!) // unshared
        seedSide(host, 'exit', host.proceedsUsd! + tinyExits[i - 6].proceedsUsd!) // shared
      } else {
        seedSide(host, 'entry', host.costBasisUsd!)
        seedSide(host, 'exit', host.proceedsUsd!)
      }
    }
    for (const t of tinyEntries) seedSide(t, 'exit', t.proceedsUsd!) // unshared own exit
    for (const t of tinyExits) seedSide(t, 'entry', t.costBasisUsd!) // unshared own entry

    const manifest = await buildManifestFromCandidate({
      identity: identity('production-shape-108'), allCandidateLots: allLots, candidateVerifiedLots: allLots,
      structuralLotCount: allLots.length, fingerprints: computeFingerprints(allLots, realizedTotal(allLots)),
      realizedPnlUsd: realizedTotal(allLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: loader, computeFingerprints,
    })

    // NEVER hardcoded to the old broken "37" — this exact figure is what THIS test's own group
    // structure justifies: 108 input candidates minus exactly the 13 genuinely-dust occurrences
    // (6 entry + 7 exit), with every OTHER sibling — including the 13 non-dust hosts those dust
    // siblings shared a side with — still publishing its own real, conserving share.
    assert.equal(manifest.verifiedLotCount, 95, '108 input candidates minus exactly the 13 genuinely-dust local occurrences')
    assert.notEqual(manifest.verifiedLotCount, 37, 'must never reproduce the old whole-group-demotion collapse')

    assert.ok(manifest.manifestCanonicalVerifierAudit)
    assert.equal(manifest.manifestCanonicalVerifierAudit!.rejectedCount, 13)
    assert.equal(manifest.manifestCanonicalVerifierAudit!.reasons.non_positive_entry_price, 6)
    assert.equal(manifest.manifestCanonicalVerifierAudit!.reasons.non_positive_exit_price, 7)

    assert.ok(manifest.manifestAllocationBuildAudit)
    assert.equal(manifest.manifestAllocationBuildAudit!.inputCanonicalCandidates, 108)
    assert.equal(manifest.manifestAllocationBuildAudit!.occurrenceLocalRejects, 13)
    assert.equal(manifest.manifestAllocationBuildAudit!.finalManifestLots, 95)
    assert.equal(manifest.manifestAllocationBuildAudit!.conservationFailures, 0, 'no group ever disagrees with its own accepted-evidence total')
    // The 6 shared ENTRY groups (host + dust sibling) and 7 shared EXIT groups conserve exactly —
    // the dust sibling's own allocated share is genuinely $0, so excluding it from publication loses
    // nothing (residual 0, never flagged).
    const sharedGroupResiduals = manifest.manifestAllocationBuildAudit!.groups
      .filter((g) => g.allocations.length > 1)
    assert.equal(sharedGroupResiduals.length, 0, 'every multi-member (shared) group conserves with zero residual — the dust member had no value to lose')
    // Every OTHER reported group is a dust lot's own UNSHARED side — a real, individually-positive
    // value that never publishes only because that same lot's OTHER side is the genuine dust one, so
    // the whole occurrence is (correctly) excluded. Never silently erased: this is exactly why it
    // is still reported here, not proof of a conservation bug.
    for (const g of manifest.manifestAllocationBuildAudit!.groups) {
      if (g.allocations.length === 1) assert.equal(g.publishedUsdSum, 0, 'the sole member is a rejected occurrence — its own otherwise-fine side stays unpublished with it')
    }

    // The 6 non-dust hosts sharing an entry side, and the 7 sharing an exit side, all still publish.
    const publishedKeys = new Set(manifest.verifiedLotIdentityKeys)
    for (let i = 0; i < 13; i++) {
      const hostKey = [...buildCanonicalLotIdentities([hosts[i]]).values()][0].key
      assert.ok(publishedKeys.has(hostKey), `host-${i} (sharing a side with a dust sibling) still publishes`)
    }
    for (const t of [...tinyEntries, ...tinyExits]) {
      const tinyKey = [...buildCanonicalLotIdentities([t]).values()][0].key
      assert.ok(!publishedKeys.has(tinyKey), `${t.lotId} (genuine dust) is excluded`)
    }

    // Build and replay must agree — refresh converges rather than reproducing the old collapse.
    const result = await replay(manifest, allLots, loader)
    assert.equal(result.outcome, 'applied')
    assert.equal(result.reasonCounts.manifest_canonical_verifier_rejection, 0)
    assert.equal(result.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 95)
  })

  it('deterministic allocation is stable regardless of candidate array order', async () => {
    const { allLots } = buildProductionShapeFixture()
    const { seedSide, loader } = customEvidenceStore()
    const hosts = allLots.slice(0, 95)
    const tinyEntries = allLots.slice(95, 101)
    const tinyExits = allLots.slice(101, 108)
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i]
      if (i < 6) { seedSide(host, 'entry', host.costBasisUsd! + tinyEntries[i].costBasisUsd!); seedSide(host, 'exit', host.proceedsUsd!) }
      else if (i < 13) { seedSide(host, 'entry', host.costBasisUsd!); seedSide(host, 'exit', host.proceedsUsd! + tinyExits[i - 6].proceedsUsd!) }
      else { seedSide(host, 'entry', host.costBasisUsd!); seedSide(host, 'exit', host.proceedsUsd!) }
    }
    for (const t of tinyEntries) seedSide(t, 'exit', t.proceedsUsd!)
    for (const t of tinyExits) seedSide(t, 'entry', t.costBasisUsd!)

    const forward = await buildManifestFromCandidate({
      identity: identity('order-a'), allCandidateLots: allLots, candidateVerifiedLots: allLots,
      structuralLotCount: allLots.length, fingerprints: computeFingerprints(allLots, realizedTotal(allLots)),
      realizedPnlUsd: realizedTotal(allLots), verifiedPricingCoverage: 1, now: NOW, loadEvidence: loader, computeFingerprints,
    })
    const shuffled = [...allLots].reverse()
    const backward = await buildManifestFromCandidate({
      identity: identity('order-a'), allCandidateLots: shuffled, candidateVerifiedLots: shuffled,
      structuralLotCount: shuffled.length, fingerprints: computeFingerprints(shuffled, realizedTotal(shuffled)),
      realizedPnlUsd: realizedTotal(shuffled), verifiedPricingCoverage: 1, now: NOW, loadEvidence: loader, computeFingerprints,
    })
    assert.equal(forward.verifiedLotCount, backward.verifiedLotCount)
    assert.equal(forward.verifiedLotIdentityFingerprint, backward.verifiedLotIdentityFingerprint)
    assert.equal(forward.realizedPnlUsd, backward.realizedPnlUsd)
    assert.deepEqual([...forward.verifiedLotIdentityKeys].sort(), [...backward.verifiedLotIdentityKeys].sort())
  })
})

describe('canonical-manifest-false-structural-disagreement follow-up task', () => {
  // CONFIRMED PRODUCTION SHAPE, DISCLOSED: live wallet 0x4dbb3835744b2976560e0259cb218cab89abef96
  // compared acceptedEvidenceUsd=15198.6051810152 (the accepted-evidence record's own RAW priceUsd —
  // a real double carrying MORE than the system's own declared 8-decimal-place precision) against
  // allocatedUsdSum=15198.60518102 (the SAME value after `toScaledValue`'s own
  // `Math.round(x * 1e8)` quantization — the FIRST, unavoidable step every allocation performs).
  // These two numbers describe the identical real price; the ~4.8e-9 gap between them is exactly the
  // fractional precision `toScaledValue` rounds away by construction, bounded by construction to
  // well under one VALUE_SCALE atomic unit (1e-8) — never a second, independently-priced accepted-
  // evidence record.
  it('the exact reported live delta (15198.6051810152 vs 15198.60518102) is quantization noise, not a real disagreement', () => {
    const accepted = 15198.6051810152
    const allocated = 15198.60518102
    assert.ok(Math.abs(accepted - allocated) > 1e-9, 'sanity: the prior (too-tight) 1e-9 tolerance would have flagged this exact pair')
    assert.ok(Math.abs(accepted - allocated) <= CANONICAL_VALUE_TOLERANCE, 'the corrected tolerance — derived from VALUE_SCALE\'s own declared atomic unit — absorbs it')
  })

  it('a lone lot whose accepted evidence carries more precision than the 8-decimal system standard still conserves and publishes (no false group_total_does_not_equal_accepted_side_total)', async () => {
    const rawPreciseLot = lot({
      lotId: 'precise', token: '0xprecise', openedTxHash: '0xprecisebuy', closedTxHash: '0xprecisesell',
      amount: 1, costBasisUsd: 15198.6051810152, proceedsUsd: 20000, realizedPnlUsd: 4801.39,
    })
    const evidence = seededEvidence([rawPreciseLot])
    const manifest = await buildManifestFromCandidate({
      identity: identity('precision-108'), allCandidateLots: [rawPreciseLot], candidateVerifiedLots: [rawPreciseLot],
      structuralLotCount: 1, fingerprints: computeFingerprints([rawPreciseLot], realizedTotal([rawPreciseLot])),
      realizedPnlUsd: realizedTotal([rawPreciseLot]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    assert.equal(manifest.verifiedLotCount, 1, 'never demoted for carrying more raw precision than the system persists')
    assert.equal(manifest.verifiedLotRecords[0].groupCostBasisUsd, 15198.60518102, 'frozen at the system\'s own 8-decimal precision')
    const entryAudit = manifest.manifestAllocationBuildAudit?.groups.find((g) => g.side === 'entry')
    // No residual/anomaly for a fully-published, single-member group — real conservation, not a gap.
    assert.ok(!entryAudit, 'a fully conserving, fully published group is never flagged in the bounded anomaly list')
  })

  it('replay: an old manifest whose frozen value differs from freshly re-verified accepted evidence by quantization noise alone replays clean — never canonical_value_disagreement', async () => {
    const lotRef = lot({
      lotId: 'noise-lot', token: '0xnoise', openedTxHash: '0xnoisebuy', closedTxHash: '0xnoisesell',
      amount: 1, costBasisUsd: 15198.60518102, proceedsUsd: 20000, realizedPnlUsd: 4801.39,
    })
    const { manifest, evidence } = await manifestWithEvidence([lotRef], identity('noise-108'))
    assert.equal(manifest.verifiedLotCount, 1)

    // Simulate the accepted-evidence record being re-verified with its full raw provider precision
    // (15198.6051810152, same real price as the frozen 15198.60518102) rather than an assumption
    // that only the exact 8-decimal figure was ever stored.
    const entryIdentity = { chain: lotRef.chain, token: lotRef.token, txHash: lotRef.openedTxHash, side: 'entry' as const, timestamp: lotRef.openedAt, lotIdentityVersion: lotIdentityVersion(lotRef) }
    evidence.store.set(buildAcceptedEvidenceKey(entryIdentity), buildAcceptedEvidenceEnvelope({
      identity: entryIdentity, priceUsd: 15198.6051810152, valueUsd: 15198.6051810152,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))

    const result = await replay(manifest, [lotRef], evidence.loader)
    assert.equal(result.outcome, 'applied', 'quantization-noise-level re-verification never blocks replay')
    assert.equal(result.reasonCounts.manifest_cost_basis_mismatch, 0)
    assert.equal(result.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0, 0)
    // Nonzero delta IS still captured in the bounded audit, honestly classified as noise, never blocking.
    const noiseEntry = result.manifestValueDisagreementAudit.find((d) => d.side === 'entry')
    if (noiseEntry) {
      assert.equal(noiseEntry.classification, 'quantization_noise')
      assert.equal(noiseEntry.refreshBlocking, false)
    }
  })

  it('replay: a REAL value disagreement (a materially different accepted-evidence price) still fails closed — canonical_value_disagreement, structural failure, refresh blocked', async () => {
    const lotRef = lot({
      lotId: 'corrupt-lot', token: '0xcorrupt', openedTxHash: '0xcorruptbuy', closedTxHash: '0xcorruptsell',
      amount: 1, costBasisUsd: 15198.60518102, proceedsUsd: 20000, realizedPnlUsd: 4801.39,
    })
    const { manifest, evidence } = await manifestWithEvidence([lotRef], identity('corrupt-108'))
    assert.equal(manifest.verifiedLotCount, 1)

    // A GENUINE price change — off by $50, orders of magnitude above any atomic-unit noise floor.
    const entryIdentity = { chain: lotRef.chain, token: lotRef.token, txHash: lotRef.openedTxHash, side: 'entry' as const, timestamp: lotRef.openedAt, lotIdentityVersion: lotIdentityVersion(lotRef) }
    evidence.store.set(buildAcceptedEvidenceKey(entryIdentity), buildAcceptedEvidenceEnvelope({
      identity: entryIdentity, priceUsd: 15248.60518102, valueUsd: 15248.60518102,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))

    const result = await replay(manifest, [lotRef], evidence.loader)
    assert.equal(result.outcome, 'unavailable', 'a real $50 price move must still fail closed')
    assert.equal(result.reasonCounts.manifest_cost_basis_mismatch, 1)
    assert.ok((result.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0) > 0)
    assert.equal(result.manifestStructuralFailureAudit.structuralFailure, true)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(result, 1), false, 'a true structural/value integrity failure never qualifies for the controlled refresh path')

    const corruptionEntry = result.manifestValueDisagreementAudit.find((d) => d.side === 'entry')
    assert.ok(corruptionEntry)
    assert.equal(corruptionEntry!.classification, 'possible_value_corruption')
    assert.equal(corruptionEntry!.refreshBlocking, true)
    assert.equal(Math.round(corruptionEntry!.deltaUsd), 50)
  })

  it('production shape: reproduces 37-old-manifest / 111-current-candidate with 14 quantization-noise disagreements — refresh converges, real corruption among them still blocks', async () => {
    // 111 current canonical-valid candidates: 37 already in the old manifest (frozen at the system's
    // 8-decimal precision) plus 74 new candidates the old manifest never saw. Of the 37 already-
    // published lots, 14 have since had their accepted-evidence record re-verified with extra raw
    // provider precision (quantization noise only, same real price) — the exact live shape.
    const oldLots = buildLots(37, 37)
    const newLots = Array.from({ length: 74 }, (_, offset) => {
      const i = 37 + offset
      return lot({ lotId: `lot-${i}`, token: `0xtoken${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, openedAt: i, closedAt: 2000 + i, costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10 })
    })
    const currentLots = [...oldLots, ...newLots]
    const evidence = seededEvidence(currentLots)
    const oldManifest = await buildManifestFromCandidate({
      identity: identity('live-37-111'), allCandidateLots: oldLots, candidateVerifiedLots: oldLots,
      structuralLotCount: oldLots.length, fingerprints: computeFingerprints(oldLots, realizedTotal(oldLots)),
      realizedPnlUsd: realizedTotal(oldLots), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    assert.equal(oldManifest.verifiedLotCount, 37)

    // Re-verify 14 of the 37 entry sides with extra raw precision (same real price, noise-level delta).
    for (let i = 0; i < 14; i++) {
      const target = oldLots[i]
      const entryIdentity = { chain: target.chain, token: target.token, txHash: target.openedTxHash, side: 'entry' as const, timestamp: target.openedAt, lotIdentityVersion: lotIdentityVersion(target) }
      const preciseValue = Number((target.costBasisUsd! + 0.0000000048).toFixed(10))
      evidence.store.set(buildAcceptedEvidenceKey(entryIdentity), buildAcceptedEvidenceEnvelope({
        identity: entryIdentity, priceUsd: preciseValue, valueUsd: preciseValue,
        source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
      }))
    }

    const firstReplay = await replay(oldManifest, currentLots, evidence.loader)
    assert.equal(firstReplay.outcome, 'applied', 'quantization-noise-only re-verification never even requires the refresh path')
    assert.equal(firstReplay.reasonCounts.manifest_cost_basis_mismatch, 0)
    assert.equal(firstReplay.candidateNewEvidenceLotKeys.length, 74)
    assert.equal(firstReplay.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, 37, 'all 37 previously-published lots still publish')

    // Companion: if ONE of those 14 is a REAL corruption instead of noise, it must still block —
    // proves the fix never masks genuine over-claim/value corruption.
    const corruptedTarget = oldLots[0]
    const corruptEntryIdentity = { chain: corruptedTarget.chain, token: corruptedTarget.token, txHash: corruptedTarget.openedTxHash, side: 'entry' as const, timestamp: corruptedTarget.openedAt, lotIdentityVersion: lotIdentityVersion(corruptedTarget) }
    const corruptValue = corruptedTarget.costBasisUsd! + 500
    evidence.store.set(buildAcceptedEvidenceKey(corruptEntryIdentity), buildAcceptedEvidenceEnvelope({
      identity: corruptEntryIdentity, priceUsd: corruptValue, valueUsd: corruptValue,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))
    const secondReplay = await replay(oldManifest, currentLots, evidence.loader)
    assert.equal(secondReplay.outcome, 'unavailable', 'a real $500 disagreement among otherwise-harmless noise still fails closed')
    assert.ok((secondReplay.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0) > 0)
  })
})

describe('canonical-manifest-false-structural-disagreement follow-up task — "6 atomic unit" group-membership-growth regression', () => {
  // CONFIRMED LIVE SHAPE, DISCLOSED: wallet 0x4dbb3835744b2976560e0259cb218cab89abef96 —
  // structuralClosedLots=137, pricingStageVerifiedLots=111, old manifest=37, candidateNewEvidenceCount=74,
  // exactly ONE canonical_value_disagreement (side=exit, acceptedUsd=1210.84637925,
  // rebuiltUsd=1210.84637919, deltaUsd=-6e-8). A single-member evidence-side group is mathematically
  // GUARANTEED to reproduce bit-identically (share = totalValueScaled exactly, for ANY nonzero
  // quantity), so this nonzero delta PROVES the exit evidence side now has >= 2 structural members —
  // exactly reproduced here: the target lot was the manifest's sole claimant at build time; one of
  // the 74 newly-recovered candidates turns out to share the SAME sell transaction, so replay's live
  // group (built from ALL 111 current candidates) redistributes the SAME real accepted-evidence total
  // across two members instead of one.
  const targetAmount = 138263955.736919075251
  const targetLot = lot({
    lotId: 'target-6unit', token: '0xbf8e8f0e8866a7052f948c16508644347c57aba3',
    openedTxHash: '0xc2d274362af44b209ea981eae2adc31ad7a945b24ce77dcf69659db11834c425',
    closedTxHash: '0xa00618c549d5b3542fa0304f028d5b59838794ec4ae9045224ee491d53cc2806',
    openedAt: 1779796767000, closedAt: 1784590253000, amount: targetAmount,
    costBasisUsd: 5000, proceedsUsd: 1210.84637925, realizedPnlUsd: -3789.15362075,
  })

  it('replays cleanly and reclassifies as refresh-eligible candidate evolution, never a hard structural block, when the ONLY explanation is a new sibling sharing the same evidence side', async () => {
    const { manifest: oldManifest, evidence } = await manifestWithEvidence([targetLot], identity('6unit-wallet'))
    assert.equal(oldManifest.verifiedLotCount, 1)
    assert.equal(oldManifest.verifiedLotRecords[0].groupProceedsUsd, 1210.84637925)

    // One of the 74 newly-recovered candidates shares the exact same sell transaction — a real,
    // structurally-recovered sibling, not a fabricated one — with a tiny quantity relative to the
    // target lot's own ~138M tokens. amount=0.007 reproduces the EXACT reported live delta: with
    // this sibling in the group, the target's exact BigInt share floors from 121084637925 to
    // 121084637919 scaled units — precisely the reported rebuiltUsd=1210.84637919 (deltaScaled=-6).
    const newSibling = lot({
      lotId: 'new-sibling-74', token: targetLot.token, openedTxHash: '0xnewsiblingbuy',
      closedTxHash: targetLot.closedTxHash, openedAt: 1, closedAt: targetLot.closedAt,
      amount: 0.007, costBasisUsd: 0.005, proceedsUsd: 0.005, realizedPnlUsd: 0,
    })
    // Seed the sibling's own (unshared) entry evidence and the SAME real exit evidence total the
    // group already had — the accepted-evidence record itself never changes.
    const siblingEntryIdentity = { chain: newSibling.chain, token: newSibling.token, txHash: newSibling.openedTxHash, side: 'entry' as const, timestamp: newSibling.openedAt, lotIdentityVersion: lotIdentityVersion(newSibling) }
    evidence.store.set(buildAcceptedEvidenceKey(siblingEntryIdentity), buildAcceptedEvidenceEnvelope({
      identity: siblingEntryIdentity, priceUsd: 0.005, valueUsd: 0.005,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))
    const currentLots = [targetLot, newSibling]

    const firstReplay = await replay(oldManifest, currentLots, evidence.loader)
    assert.equal(firstReplay.outcome, 'unavailable', 'the target lot\'s own frozen value genuinely no longer matches its live (now-shared) share')
    assert.equal((firstReplay.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0), 0, 'never counted as an unexplained structural failure')
    assert.ok((firstReplay.manifestStructuralFailureAudit.candidateEvolutionReasons.candidate_evolution_group_membership_changed ?? 0) > 0, 'reclassified as explainable candidate evolution')
    assert.equal(firstReplay.manifestStructuralFailureAudit.structuralFailure, false)
    assert.equal(firstReplay.manifestStructuralFailureAudit.refreshAllowed, true)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(firstReplay, currentLots.length), true)

    // The bounded exact-scaled-integer audit proves the mechanism, not just asserts it.
    const groupAudit = firstReplay.manifestGroupReconciliationAudit.find((g) => g.side === 'exit')
    assert.ok(groupAudit)
    assert.equal(groupAudit!.occurrenceCount, 2, 'the live group now has two structural members')
    assert.equal(groupAudit!.firstDivergenceStage, 'group_membership_grew')
    assert.equal(groupAudit!.allocatedScaledTotal, groupAudit!.acceptedScaled, 'BigInt-exact conservation: allocated total equals the accepted evidence total exactly')
    assert.equal(groupAudit!.deltaScaled, '-6', 'reproduces the EXACT reported live deltaAtomicOrScale=-6')

    // The controlled refresh path actually converges: rebuild from current candidates, persist,
    // replay again — never publishing the stale frozen number, always the freshly-verified one.
    const currentVerifiedLots = currentLots.filter(isCanonicalVerifiedPublishedLot)
    const refreshed = await buildRefreshedManifest({
      priorManifest: oldManifest, identity: identity('6unit-wallet'), allCandidateLots: currentLots,
      candidateVerifiedLots: currentVerifiedLots, structuralLotCount: currentLots.length,
      fingerprints: computeFingerprints(currentVerifiedLots, realizedTotal(currentVerifiedLots)), realizedPnlUsd: realizedTotal(currentVerifiedLots),
      verifiedPricingCoverage: 1, now: NOW + 1, refreshReason: 'partially-unreproducible-manifest-current-evidence-refresh',
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const secondReplay = await replay(refreshed, currentLots, evidence.loader)
    assert.equal(secondReplay.outcome, 'applied')
    assert.equal(secondReplay.publishedLots.filter(isCanonicalVerifiedPublishedLot).length, currentVerifiedLots.length)
    assert.notEqual(secondReplay.publishedLots.find((l) => l.lotId === 'target-6unit')?.proceedsUsd, 1210.84637925, 'publishes the freshly recomputed (now correctly shared) value, never the stale one')
  })

  it('companion — a GENUINE evidence value change on a multi-member group still fails closed as evidence_raw_value_changed, never reclassified', async () => {
    const { manifest: oldManifest, evidence } = await manifestWithEvidence([targetLot], identity('6unit-corrupt'))
    const newSibling = lot({
      lotId: 'new-sibling-corrupt', token: targetLot.token, openedTxHash: '0xnewsiblingbuy2',
      closedTxHash: targetLot.closedTxHash, openedAt: 1, closedAt: targetLot.closedAt,
      amount: 0.000000000123, costBasisUsd: 0.00001, proceedsUsd: 0.00001, realizedPnlUsd: 0,
    })
    const siblingEntryIdentity = { chain: newSibling.chain, token: newSibling.token, txHash: newSibling.openedTxHash, side: 'entry' as const, timestamp: newSibling.openedAt, lotIdentityVersion: lotIdentityVersion(newSibling) }
    evidence.store.set(buildAcceptedEvidenceKey(siblingEntryIdentity), buildAcceptedEvidenceEnvelope({
      identity: siblingEntryIdentity, priceUsd: 0.00001, valueUsd: 0.00001,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))
    // GENUINE corruption: the shared exit evidence record itself is re-written with a materially
    // different total ($50 higher) — a real price/value change, not membership growth.
    const exitIdentity = { chain: targetLot.chain, token: targetLot.token, txHash: targetLot.closedTxHash, side: 'exit' as const, timestamp: targetLot.closedAt, lotIdentityVersion: lotIdentityVersion(targetLot) }
    evidence.store.set(buildAcceptedEvidenceKey(exitIdentity), buildAcceptedEvidenceEnvelope({
      identity: exitIdentity, priceUsd: 1260.84637925, valueUsd: 1260.84637925,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))
    const currentLots = [targetLot, newSibling]

    const firstReplay = await replay(oldManifest, currentLots, evidence.loader)
    assert.equal(firstReplay.outcome, 'unavailable')
    assert.ok((firstReplay.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0) > 0, 'a real $50 evidence change stays a hard structural failure')
    assert.equal(firstReplay.manifestStructuralFailureAudit.structuralFailure, true)
    assert.equal(firstReplay.manifestStructuralFailureAudit.refreshAllowed, false)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(firstReplay, currentLots.length), false)

    const groupAudit = firstReplay.manifestGroupReconciliationAudit.find((g) => g.side === 'exit')
    assert.ok(groupAudit)
    assert.equal(groupAudit!.firstDivergenceStage, 'evidence_raw_value_changed', 'correctly attributed to the evidence record itself, never misread as membership growth')
  })
})

describe('accepted-evidence-raw-value-mutation follow-up task, part 2 — coveredLotCount is not composition; schema v4 group-total/fingerprint reconciliation', () => {
  // CONFIRMED ROOT CAUSE, DISCLOSED: the prior `reconcileGroup` compared the live evidence-SIDE-GROUP
  // total against `record.groupProceedsUsd`/`groupCostBasisUsd` — the target lot's own
  // OCCURRENCE-multiplicity total (this lot's frozen per-instance share), never the whole shared-side
  // group's total. Whenever a group has other, differently-shaped siblings (the common real-world
  // case), those two quantities are simply different numbers, so `evidenceUnchanged` reported "changed"
  // even when the accepted-evidence record itself never moved — exactly the live report's own proof:
  // persistedRawUsd === upstreamRawUsd === canonicalSeedRawUsd (perfectly stable), yet replay still
  // misclassified the mismatch as `evidence_raw_value_changed`. Schema v4 fixes this by persisting the
  // group's REAL total (`entryGroupTotalUsd`/`exitGroupTotalUsd`) and a composition fingerprint
  // (`entryGroupFingerprint`/`exitGroupFingerprint`) at build time, so replay can finally compare the
  // SAME quantity on both sides and tell apart: evidence moved / composition changed / nothing changed.
  const buildSharedExitGroup = () => {
    const target = lot({
      lotId: 'target', token: '0xshared-group', openedTxHash: '0xtargetbuy', closedTxHash: '0xsell-shared',
      openedAt: 1, closedAt: 2, amount: 100, costBasisUsd: 40, proceedsUsd: 100, realizedPnlUsd: 60,
    })
    const siblingA = lot({
      lotId: 'siblingA', token: '0xshared-group', openedTxHash: '0xsiblingAbuy', closedTxHash: '0xsell-shared',
      openedAt: 1, closedAt: 2, amount: 200, costBasisUsd: 80, proceedsUsd: 200, realizedPnlUsd: 120,
    })
    return { target, siblingA }
  }
  const seedCleanExitTotal = (evidence: ReturnType<typeof seededEvidence>, closedTxHash: string, closedAt: number, totalUsd: number) => {
    const exitIdentity = { chain: 'base', token: '0xshared-group', txHash: closedTxHash, side: 'exit' as const, timestamp: closedAt, lotIdentityVersion: 'shared-group-representative' }
    evidence.store.set(buildAcceptedEvidenceKey(exitIdentity), buildAcceptedEvidenceEnvelope({
      identity: exitIdentity, priceUsd: totalUsd, valueUsd: totalUsd,
      source: 'test-source', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: NOW,
    }))
  }

  it('regression 1 — SAME COUNT, DIFFERENT SIBLING SET: a group whose composition changed (a different sibling swapped in at the same size) is correctly reclassified as group_membership_grew, never evidence_raw_value_changed, even though the accepted evidence total never moved', async () => {
    const { target, siblingA } = buildSharedExitGroup()
    const { evidence } = await manifestWithEvidence([target, siblingA], identity('composition-change-wallet'))
    seedCleanExitTotal(evidence, target.closedTxHash, target.closedAt, 300) // target 100/300*300=100, siblingA 200/300*300=200 — divides exactly, no remainder noise
    // Rebuild against the clean $300 evidence (manifestWithEvidence's own per-lot seeding does not
    // aggregate) so the frozen record's own entryGroupTotalUsd/exitGroupTotalUsd is the real $300.
    const rebuilt = await buildManifestFromCandidate({
      identity: identity('composition-change-wallet'), allCandidateLots: [target, siblingA], candidateVerifiedLots: [target, siblingA],
      structuralLotCount: 2, fingerprints: computeFingerprints([target, siblingA], realizedTotal([target, siblingA])),
      realizedPnlUsd: realizedTotal([target, siblingA]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const targetRecord = rebuilt.verifiedLotRecords.find((r) => r.lotIdentityVersion === lotIdentityVersion(target))!
    assert.equal(targetRecord.exitGroupTotalUsd, 300)
    assert.equal(targetRecord.proceedsUsd, 100, 'target\'s own frozen share at build time: 100/300 of $300')

    // Replay with siblingA REPLACED by a differently-sized siblingB — same COUNT (still 2 members),
    // genuinely different composition. The evidence record itself is untouched (still $300).
    const siblingB = lot({
      lotId: 'siblingB', token: '0xshared-group', openedTxHash: '0xsiblingBbuy', closedTxHash: '0xsell-shared',
      openedAt: 1, closedAt: 2, amount: 50, costBasisUsd: 20, proceedsUsd: 50, realizedPnlUsd: 30,
    })
    const currentLots = [target, siblingB]
    const firstReplay = await replay(rebuilt, currentLots, evidence.loader)
    assert.equal(firstReplay.outcome, 'unavailable', 'the target\'s own share genuinely moved (100 -> 200), so replay cannot silently republish the stale value')
    assert.equal((firstReplay.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0), 0, 'must NOT be a hard structural block — the evidence record itself never changed')
    assert.ok((firstReplay.manifestStructuralFailureAudit.candidateEvolutionReasons.candidate_evolution_group_membership_changed ?? 0) > 0)
    assert.equal(firstReplay.manifestStructuralFailureAudit.structuralFailure, false)
    assert.equal(firstReplay.manifestStructuralFailureAudit.refreshAllowed, true)

    const groupAudit = firstReplay.manifestGroupReconciliationAudit.find((g) => g.side === 'exit')
    assert.ok(groupAudit)
    assert.equal(groupAudit!.firstDivergenceStage, 'group_membership_grew', 'count-equal composition change must be attributed to membership, never to the evidence record')
    assert.equal(groupAudit!.acceptedRawUsd, 300, 'the accepted evidence total itself never moved')
  })

  it('regression 2 — SAME SET, DIFFERENT ORDERING: replay is bit-identical regardless of candidate array order', async () => {
    const { target, siblingA } = buildSharedExitGroup()
    const { evidence } = await manifestWithEvidence([target, siblingA], identity('order-independence-wallet'))
    seedCleanExitTotal(evidence, target.closedTxHash, target.closedAt, 300)
    const rebuilt = await buildManifestFromCandidate({
      identity: identity('order-independence-wallet'), allCandidateLots: [target, siblingA], candidateVerifiedLots: [target, siblingA],
      structuralLotCount: 2, fingerprints: computeFingerprints([target, siblingA], realizedTotal([target, siblingA])),
      realizedPnlUsd: realizedTotal([target, siblingA]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const reversedReplay = await replay(rebuilt, [siblingA, target], evidence.loader)
    assert.equal(reversedReplay.outcome, 'applied', 'reversed array order must never produce a mismatch')
    assert.equal(reversedReplay.reasonCounts.manifest_replay_success, 2)
    assert.equal(reversedReplay.manifestGroupReconciliationAudit.length, 0, 'no reconciliation is even invoked — nothing mismatched')
  })

  it('regression 3 — SAME SET, SAME TOTAL: deterministic replay reproduces the exact frozen values and the persisted fingerprints match the live recomputation exactly', async () => {
    const { target, siblingA } = buildSharedExitGroup()
    const { evidence } = await manifestWithEvidence([target, siblingA], identity('deterministic-wallet'))
    seedCleanExitTotal(evidence, target.closedTxHash, target.closedAt, 300)
    const rebuilt = await buildManifestFromCandidate({
      identity: identity('deterministic-wallet'), allCandidateLots: [target, siblingA], candidateVerifiedLots: [target, siblingA],
      structuralLotCount: 2, fingerprints: computeFingerprints([target, siblingA], realizedTotal([target, siblingA])),
      realizedPnlUsd: realizedTotal([target, siblingA]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    const targetRecord = rebuilt.verifiedLotRecords.find((r) => r.lotIdentityVersion === lotIdentityVersion(target))!
    assert.equal(targetRecord.exitGroupFingerprint, groupCompositionFingerprint([target, siblingA]))

    const result = await replay(rebuilt, [target, siblingA], evidence.loader)
    assert.equal(result.outcome, 'applied')
    const published = result.publishedLots.filter(isCanonicalVerifiedPublishedLot)
    const publishedTarget = published.find((l) => l.lotId === 'target')!
    assert.equal(publishedTarget.proceedsUsd, 100)
  })

  it('regression 4 — GENUINE MATERIAL VALUE CHANGE: the same exact composition, with the accepted-evidence record itself rewritten, still fails closed as evidence_raw_value_changed', async () => {
    const { target, siblingA } = buildSharedExitGroup()
    const { evidence } = await manifestWithEvidence([target, siblingA], identity('material-change-wallet'))
    seedCleanExitTotal(evidence, target.closedTxHash, target.closedAt, 300)
    const rebuilt = await buildManifestFromCandidate({
      identity: identity('material-change-wallet'), allCandidateLots: [target, siblingA], candidateVerifiedLots: [target, siblingA],
      structuralLotCount: 2, fingerprints: computeFingerprints([target, siblingA], realizedTotal([target, siblingA])),
      realizedPnlUsd: realizedTotal([target, siblingA]), verifiedPricingCoverage: 1, now: NOW,
      loadEvidence: evidence.loader, computeFingerprints,
    })
    // Same exact two lots (identical composition) — but the accepted-evidence record itself is
    // rewritten to a materially different total ($900 instead of $300).
    seedCleanExitTotal(evidence, target.closedTxHash, target.closedAt, 900)
    const firstReplay = await replay(rebuilt, [target, siblingA], evidence.loader)
    assert.equal(firstReplay.outcome, 'unavailable')
    assert.ok((firstReplay.manifestStructuralFailureAudit.actualStructuralReasons.canonical_value_disagreement ?? 0) > 0, 'a genuine evidence change on the IDENTICAL composition must still hard-block')
    assert.equal(firstReplay.manifestStructuralFailureAudit.structuralFailure, true)
    assert.equal(firstReplay.manifestStructuralFailureAudit.refreshAllowed, false)
    assert.equal(shouldRefreshPartiallyUnreproducibleManifest(firstReplay, 2), false)

    const groupAudit = firstReplay.manifestGroupReconciliationAudit.find((g) => g.side === 'exit')
    assert.ok(groupAudit)
    assert.equal(groupAudit!.firstDivergenceStage, 'evidence_raw_value_changed')
    assert.equal(groupAudit!.acceptedRawUsd, 900)
  })
})

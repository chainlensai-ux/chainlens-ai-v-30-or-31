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
  readCanonicalPnlSampleManifest, writeCanonicalPnlSampleManifest, replayManifest,
  buildCanonicalLotIdentities, canonicalAmountString, dedupeKeys, logDuplicateIdentityIfAny,
  buildLastKnownCanonicalSample, buildScanWindowIdentity, buildChainScope, normalizeWalletAddress,
  CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION, CANONICAL_VALUE_METHODOLOGY_VERSION, CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
  splitGroupTotalAcrossOccurrences, buildFingerprintMismatchDiagnostic,
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

  it('the schema version is 3 — a v2 manifest genuinely lacks the side references replay now requires', async () => {
    assert.equal(CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION, 3)
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
      'manifest_evidence_quality_mismatch', 'manifest_realized_total_mismatch', 'manifest_fingerprint_mismatch',
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
    assert.equal(run1Manifest.manifestSchemaVersion, 3)
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

  it('HARD ASSERTION (fingerprint-migration follow-up, required regression): the value methodology version is 5 — a stored vv4 manifest (fingerprinted by the old 1e-9 price-fingerprint algorithm) misses cleanly under the current identity, and the very next scan creates one fresh manifest', async () => {
    assert.equal(CANONICAL_VALUE_METHODOLOGY_VERSION, 5)
    const kv = fakeKv()
    const lots = buildLots(6, 6)
    const vv4Identity = buildManifestIdentity({
      walletAddress: '0xaaa', chains: ['base'], configuredWindowDays: 90, matchedLotFingerprint: 'fp1',
      valueMethodologyVersion: 4,
    })
    const vv4Manifest = { ...(await manifestWithEvidence(lots, vv4Identity)).manifest, verifiedLotIdentityFingerprint: 'old-1e9-price-fingerprint' }
    await writeCanonicalPnlSampleManifest(kv, vv4Manifest)
    assert.ok(buildManifestKey(vv4Identity).includes(':vv4:'), 'sanity: the old manifest really is keyed under vv4')

    const currentRead = await readCanonicalPnlSampleManifest(kv, identity())
    assert.equal(currentRead.manifest, null, 'the vv4 manifest must never be found under the vv5 identity')
    assert.equal(currentRead.validationFailure, false, 'a methodology-version miss is a clean miss, never reported as corruption')

    // The next scan (no manifest found) builds and persists a fresh vv5 manifest — never a manual
    // refresh/delete of the stale vv4 record, which remains untouched in the store under its own key.
    const { manifest: freshManifest } = await manifestWithEvidence(lots)
    assert.equal(freshManifest.valueMethodologyVersion, 5)
    assert.ok(buildManifestKey(identity()).includes(':vv5:'))
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

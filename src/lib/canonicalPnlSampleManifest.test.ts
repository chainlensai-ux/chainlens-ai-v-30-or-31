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
  type CanonicalSampleManifestKvLike, type AcceptedEvidenceLoader, type CanonicalPnlSampleManifest,
} from './canonicalPnlSampleManifest.ts'
import { buildScanDeterminismAudit } from './scanDeterminismAudit.ts'
import { isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot.ts'
import {
  buildAcceptedEvidenceEnvelope, buildAcceptedEvidenceKey, lotIdentityVersion, readAcceptedEvidence,
  readAcceptedEvidenceAnyLotVersion,
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
      assert.equal(record.evidenceSchemaVersion, 1)
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
    assert.equal(CANONICAL_LOT_IDENTITY_SCHEMA_VERSION, 2)
  })
})

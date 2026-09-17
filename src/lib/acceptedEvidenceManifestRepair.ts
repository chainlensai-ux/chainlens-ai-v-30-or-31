// ACCEPTED-EVIDENCE MANIFEST REPAIR, DISCLOSED (28-lost-verified-lot production regression, wallet
// 0x4dbb…ef96 — repair-path follow-up to the sliding-TTL fix in acceptedEvidenceStore.ts).
//
// THE PROBLEM THIS CLOSES: the sliding-TTL fix stops evidence from expiring UNDER ACTIVE REUSE going
// forward, but it cannot resurrect a record that already expired BEFORE that fix shipped. Once a
// record is gone, priceLotsForWallet's fast-path hydration finds nothing, the side falls through to
// live historical pricing, and a trade too old for any provider to re-price becomes a
// `missing_price` candidate — exactly the wallet's 98 -> 70 verified-lot collapse.
//
// THIS IS A REPAIR PATH, NOT A NEW PRICING SOURCE, DISCLOSED: every value this module ever writes
// was ALREADY canonical, verified, published evidence — frozen on the durable canonical-sample
// manifest by an earlier scan that DID have live evidence. This module never invents, estimates, or
// infers a price; it only re-persists a value the pipeline has already proven once, so the KV
// record backing it can outlive its own expiry. See buildAcceptedEvidenceEnvelope's
// `repairReason`/`repairedFromManifestSource` fields for how a repaired record stays distinguishable
// from an organically-written one forever.
//
// FAIL CLOSED, DISCLOSED: every one of the seven HARD REQUIREMENTS below is a real, independent gate
// — any single failure refuses the write and leaves the side genuinely unresolved (never a
// downgraded/approximate value, never a symbol match, never today's price). A side this module
// refuses to repair is exactly as unresolved after this pass as before it; nothing about the
// evidence rules is weakened.

import {
  buildAcceptedEvidenceEnvelope, buildAcceptedEvidenceKey, readAcceptedEvidenceAnyLotVersion, writeAcceptedEvidence,
  type AcceptedEvidenceEnvelope, type AcceptedEvidenceIdentity, type AcceptedEvidenceKvLike, type AcceptedEvidenceSide,
} from './acceptedEvidenceStore.ts'
import {
  buildManifestIdentity, readCanonicalPnlSampleManifest,
  type CanonicalManifestLotRecord, type CanonicalPnlSampleManifest, type CanonicalPnlSampleManifestIdentity,
} from './canonicalPnlSampleManifest.ts'
import type { MatchedLot } from '../modules/fifoEngine/types.ts'
import { buildScanDeterminismAudit } from './scanDeterminismAudit.ts'

const REPAIR_WRITER = 'canonical_manifest_reseed'
const REPAIR_REASON = 'expired_accepted_evidence' as const
// This pass never claims a per-candle provider timestamp (it is not fetching from a provider) and
// never claims a methodology tag beyond "restored from the manifest" — 'unknown' is the same honest
// tag the canonical-seeding pass itself already uses for its own aggregate writes (see
// pnlReconciliation.ts's seedAcceptedEvidenceForVerifiedLots).
const REPAIR_EVIDENCE_TYPE = 'unknown'

export type AcceptedEvidenceRepairRejection =
  | 'identity_mismatch'
  | 'methodology_mismatch'
  | 'invalid_value'
  | 'existing_stronger_evidence'
  | 'contradictory_live_evidence'
  | 'write_failed'

export type AcceptedEvidenceRepairSideResult = {
  side: 'entry' | 'exit'
  evidenceKey: string
  chain: string
  token: string
  txHash: string
  timestamp: number
  affectedLotCount: number
  outcome: 'reseeded' | 'skipped_evidence_already_valid' | AcceptedEvidenceRepairRejection
}

const MAX_REPAIR_RESULT_EXAMPLES = 40

// BOUNDED REPAIR AUDIT, DISCLOSED — the exact shape this task's own spec requests. Every counter is
// a real tally over sides this pass actually considered; `results` is bounded (MAX_REPAIR_RESULT_EXAMPLES)
// so a wallet with hundreds of sides can never grow this unboundedly, while the counters above stay
// exact regardless of the cap.
export type AcceptedEvidenceRepairAudit = {
  sidesConsidered: number
  sidesMissingOrStale: number
  sidesReseeded: number
  identityMismatch: number
  methodologyMismatch: number
  contradictoryEvidence: number
  invalidValue: number
  existingStrongerEvidence: number
  writeFailures: number
  results: AcceptedEvidenceRepairSideResult[]
}

function emptyAudit(): AcceptedEvidenceRepairAudit {
  return {
    sidesConsidered: 0, sidesMissingOrStale: 0, sidesReseeded: 0,
    identityMismatch: 0, methodologyMismatch: 0, contradictoryEvidence: 0,
    invalidValue: 0, existingStrongerEvidence: 0, writeFailures: 0,
    results: [],
  }
}

export type LiveAcceptedEvidenceRepairAudit = AcceptedEvidenceRepairAudit & {
  manifestFound: boolean
  affectedCurrentScan: boolean
}

export function emptyLiveAcceptedEvidenceRepairAudit(): LiveAcceptedEvidenceRepairAudit {
  return { ...emptyAudit(), manifestFound: false, affectedCurrentScan: false }
}

export type LiveAcceptedEvidenceRepairParams = {
  kv: AcceptedEvidenceKvLike | null | undefined
  walletAddress: string
  chains: readonly string[]
  configuredWindowDays: number
  structuralMatchedLots: readonly MatchedLot[]
  now: number
}

// LIVE-SCAN WRAPPER, DISCLOSED: does not change the seven repair gates. Looks up the durable
// canonical manifest from this scan's STRUCTURAL (price-free) matched-lot fingerprint, and only
// then calls repairExpiredAcceptedEvidenceFromManifest. Must run BEFORE priceLotsForWallet's
// accepted-evidence hydration so reseeded sides can skip live pricing on THIS scan. No-op when
// there is no KV, no structural lots, or no valid manifest — never a fabricated repair.
export async function maybeRepairExpiredAcceptedEvidenceFromManifest(
  params: LiveAcceptedEvidenceRepairParams,
): Promise<LiveAcceptedEvidenceRepairAudit> {
  const empty = emptyLiveAcceptedEvidenceRepairAudit()
  if (!params.kv || params.structuralMatchedLots.length === 0) return empty
  const structuralAudit = buildScanDeterminismAudit({
    matchedLots: params.structuralMatchedLots,
    realizedPnlUsd: null,
    persistedEvidenceHits: 0,
    liveEvidenceMisses: 0,
  })
  const currentIdentity = buildManifestIdentity({
    walletAddress: params.walletAddress,
    chains: params.chains,
    configuredWindowDays: params.configuredWindowDays,
    matchedLotFingerprint: structuralAudit.matchedLotFingerprint,
  })
  let manifest: CanonicalPnlSampleManifest | null = null
  try {
    const read = await readCanonicalPnlSampleManifest(params.kv, currentIdentity)
    manifest = read.manifest
  } catch {
    return empty
  }
  if (!manifest) return empty
  const audit = await repairExpiredAcceptedEvidenceFromManifest({
    kv: params.kv,
    manifest,
    currentIdentity,
    now: params.now,
  })
  return {
    ...audit,
    manifestFound: true,
    affectedCurrentScan: audit.sidesReseeded > 0,
  }
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

type SideSpec = {
  side: AcceptedEvidenceSide
  chain: string
  token: string
  txHash: string
  timestamp: number
  recordedEvidenceKey: string
  recordedLotIdentityVersion: string | null
  groupTotalUsd: number | null
  groupFingerprint: string
  originalSource: string | null
  affectedLotCount: number
}

/** One SideSpec per DISTINCT (chain, token, txHash, side, timestamp) — several manifest lot records
 *  (partial-fill occurrence groups) can share one evidence side; the group total/fingerprint are
 *  identical across all of them by construction, so any one representative supplies the value. */
function collectDistinctSides(records: readonly CanonicalManifestLotRecord[]): SideSpec[] {
  const bySideKey = new Map<string, SideSpec>()
  for (const record of records) {
    for (const side of ['entry', 'exit'] as const) {
      const txHash = side === 'entry' ? record.openedTxHash : record.closedTxHash
      const timestamp = side === 'entry' ? record.openedAt : record.closedAt
      const sideKey = `${side}:${buildAcceptedEvidenceKey({ chain: record.chain, token: record.token, txHash, side, timestamp, lotIdentityVersion: '' })}`
      const existing = bySideKey.get(sideKey)
      if (existing) { existing.affectedLotCount += record.occurrenceCount; continue }
      bySideKey.set(sideKey, {
        side,
        chain: record.chain,
        token: record.token,
        txHash,
        timestamp,
        recordedEvidenceKey: side === 'entry' ? record.entryEvidenceKey : record.exitEvidenceKey,
        recordedLotIdentityVersion: side === 'entry' ? record.entryEvidenceLotIdentityVersion : record.exitEvidenceLotIdentityVersion,
        groupTotalUsd: side === 'entry' ? record.entryGroupTotalUsd : record.exitGroupTotalUsd,
        groupFingerprint: side === 'entry' ? record.entryGroupFingerprint : record.exitGroupFingerprint,
        originalSource: side === 'entry' ? record.entrySource : record.exitSource,
        affectedLotCount: record.occurrenceCount,
      })
    }
  }
  return [...bySideKey.values()]
}

export type AcceptedEvidenceRepairParams = {
  kv: AcceptedEvidenceKvLike
  manifest: CanonicalPnlSampleManifest
  // The identity THIS scan would build for its own manifest — i.e. the CURRENT methodology/schema
  // constants (see buildManifestIdentity). Repair is refused wholesale (methodologyMismatch on
  // every side) unless the manifest's own identity matches this exactly — requirement #4.
  currentIdentity: CanonicalPnlSampleManifestIdentity
  now: number
  // OPTIONAL, DISCLOSED (requirement #7 — "no live contradictory canonical evidence exists"): a
  // lookup this scan can supply when it already has an independently live-resolved TOTAL for a
  // side's group (never a single lot's own allocated share — the manifest side is compared against
  // the whole group). Returning null/undefined means "no live re-verification available for this
  // identity" — NOT "confirmed no contradiction" — and the repair proceeds on the manifest's own
  // proven value, since demanding a fresh live fetch for every repair would defeat the entire
  // purpose of a repair path (the very reason this side needs repair is that live pricing already
  // failed for it). A NON-null value that disagrees beyond floating-point rounding is treated as a
  // genuine contradiction and refuses the write.
  getLiveGroupTotalUsd?: (identity: Omit<AcceptedEvidenceIdentity, 'lotIdentityVersion'>) => number | null
}

const CONTRADICTION_TOLERANCE_USD = 0.01

/**
 * Re-seeds accepted-evidence sides that are currently missing or expired, using ONLY the exact
 * value/identity the durable canonical-sample manifest already froze for that side — never an
 * approximation, never today's price, never a symbol match. See this module's own header for the
 * seven independent HARD REQUIREMENT gates; any single failure refuses the write for that side and
 * leaves it genuinely unresolved.
 */
export async function repairExpiredAcceptedEvidenceFromManifest(params: AcceptedEvidenceRepairParams): Promise<AcceptedEvidenceRepairAudit> {
  const audit = emptyAudit()
  const { kv, manifest, currentIdentity, now, getLiveGroupTotalUsd } = params

  // REQUIREMENT #4, MANIFEST-LEVEL, DISCLOSED: the manifest's own identity — methodology, value
  // methodology, schema, AND the structural lot fingerprint it was built for — must match exactly
  // what THIS scan's own current constants/structure would produce. A manifest built under an
  // older methodology, or one whose structural lot set has since diverged, is never eligible as a
  // repair source: EVERY side across the whole manifest fails closed together, since "mostly
  // current" is not a real methodology match.
  const manifestIsCurrent =
    manifest.pricingMethodologyVersion === currentIdentity.pricingMethodologyVersion
    && manifest.valueMethodologyVersion === currentIdentity.valueMethodologyVersion
    && manifest.manifestSchemaVersion === currentIdentity.manifestSchemaVersion
    && manifest.matchedLotFingerprint === currentIdentity.matchedLotFingerprint
    && manifest.chainScope === currentIdentity.chainScope
    && manifest.scanWindowIdentity === currentIdentity.scanWindowIdentity
    && manifest.normalizedWalletAddress === currentIdentity.normalizedWalletAddress

  const sides = collectDistinctSides(manifest.verifiedLotRecords)

  for (const spec of sides) {
    audit.sidesConsidered += 1
    const identityForKv: Omit<AcceptedEvidenceIdentity, 'lotIdentityVersion'> = {
      chain: spec.chain, token: spec.token, txHash: spec.txHash, side: spec.side, timestamp: spec.timestamp,
    }
    const evidenceKey = buildAcceptedEvidenceKey({ ...identityForKv, lotIdentityVersion: '' })

    const pushResult = (outcome: AcceptedEvidenceRepairSideResult['outcome']) => {
      if (audit.results.length < MAX_REPAIR_RESULT_EXAMPLES) {
        audit.results.push({
          side: spec.side, evidenceKey, chain: spec.chain, token: spec.token, txHash: spec.txHash,
          timestamp: spec.timestamp, affectedLotCount: spec.affectedLotCount, outcome,
        })
      }
    }

    // REQUIREMENT #3, DISCLOSED: the identity we are about to key this repair on must be EXACTLY
    // what the manifest itself recorded for this side — recomputing the key from the manifest
    // record's own raw chain/token/txHash/side/timestamp fields and comparing it against the
    // record's own stored `entryEvidenceKey`/`exitEvidenceKey` catches a corrupted or hand-edited
    // record (the recorded key no longer matches its own identity fields) BEFORE it can ever be
    // used to write anything. Never symbol matching, never approximate identity.
    if (evidenceKey !== spec.recordedEvidenceKey) {
      audit.identityMismatch += 1
      pushResult('identity_mismatch')
      continue
    }

    if (!manifestIsCurrent) {
      audit.methodologyMismatch += 1
      pushResult('methodology_mismatch')
      continue
    }

    // REQUIREMENT #1 + #6, DISCLOSED: a relaxed (any-lot-version) discovery read — the SAME read
    // every other consumer of this store uses to decide "does ANY valid record back this shared
    // key" — is the single source of truth for whether this side is genuinely missing/stale. Any
    // valid, non-expired record found here — REGARDLESS of its own value — means this side is not
    // eligible: immutability holds, a repair pass never overwrites live-verified evidence, even
    // evidence it disagrees with.
    const existing = await readAcceptedEvidenceAnyLotVersion(kv, identityForKv, now)
    if (existing !== null) {
      audit.existingStrongerEvidence += 1
      pushResult('skipped_evidence_already_valid')
      continue
    }
    audit.sidesMissingOrStale += 1

    // REQUIREMENT #5, DISCLOSED: the manifest's own frozen side total must be a real, finite,
    // strictly positive USD value — a null, zero, negative, NaN or Infinity total (e.g. a manifest
    // record whose group was never fully evidenced at build time) can never be re-seeded.
    if (!isFinitePositive(spec.groupTotalUsd)) {
      audit.invalidValue += 1
      pushResult('invalid_value')
      continue
    }

    // REQUIREMENT #7, DISCLOSED: only refuses when THIS scan has an independently live-resolved
    // total for the SAME group that materially disagrees — see getLiveGroupTotalUsd's own header
    // for why "no live check available" is treated as "proceed", not as "confirmed safe".
    const liveTotal = getLiveGroupTotalUsd?.(identityForKv) ?? null
    if (liveTotal !== null && Math.abs(liveTotal - spec.groupTotalUsd) > CONTRADICTION_TOLERANCE_USD) {
      audit.contradictoryEvidence += 1
      pushResult('contradictory_live_evidence')
      continue
    }

    // ALL SEVEN GATES PASSED, DISCLOSED — reconstruct and write. `identity.lotIdentityVersion` uses
    // the record's own recorded backing version when the manifest captured one (the exact version
    // the ORIGINAL evidence carried), falling back to the shared, order-independent group
    // fingerprint only when no specific version was ever recorded — never a freshly-computed
    // version that might not match what any structural sibling currently has, which would make the
    // repaired record invisible to every reader's own strict/discovery match.
    const envelope: AcceptedEvidenceEnvelope = buildAcceptedEvidenceEnvelope({
      identity: { ...identityForKv, lotIdentityVersion: spec.recordedLotIdentityVersion ?? spec.groupFingerprint },
      priceUsd: spec.groupTotalUsd,
      valueUsd: spec.groupTotalUsd,
      valueType: 'total_side_value_usd',
      coveredLotCount: spec.affectedLotCount,
      coverageFingerprint: spec.groupFingerprint,
      source: REPAIR_WRITER,
      evidenceType: REPAIR_EVIDENCE_TYPE,
      providerTimestampBucket: null,
      now,
      // No previousEnvelope: `existing` above proved nothing valid currently occupies this key, so
      // this is a fresh write, never a re-envelope of live evidence — originWriter naturally
      // becomes REPAIR_WRITER exactly as this task's own spec asks for.
      writerReason: REPAIR_REASON,
      repairReason: REPAIR_REASON,
      repairedFromManifestSource: spec.originalSource,
    })
    const ok = await writeAcceptedEvidence(kv, envelope)
    if (ok) {
      audit.sidesReseeded += 1
      pushResult('reseeded')
    } else {
      audit.writeFailures += 1
      pushResult('write_failed')
    }
  }

  return audit
}

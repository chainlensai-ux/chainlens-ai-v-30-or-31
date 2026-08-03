// MODULE — canonicalPnlSampleManifest (durable-canonical-sample follow-up task).
//
// GOAL, DISCLOSED: production evidence proved that once accepted-evidence precedence and
// gate/AYRI agreement were both fixed, a NEW nondeterminism surfaced — newly available evidence
// (a provider that couldn't price a lot before now can) silently EXPANDED the published verified
// sample between rescans (19 lots/70.37%/-1377.03 -> 21 lots/77.78%/-979.81) for the same wallet,
// chain scope and structural lot set. Nothing upstream was wrong (accepted evidence still won,
// gate and AYRI still agreed with EACH OTHER) — there was simply no durable record of "this is the
// sample we already published" for a rescan to reproduce. This module is that record.
//
// IDENTITY, DISCLOSED: keyed by (wallet, chain scope, scan-window identity, structural
// matchedLotFingerprint, pricing methodology version, manifest schema version) — deliberately NOT
// by wall-clock scan time. `scanWindowIdentity` is built from the CONFIGURED window duration and
// the pricing methodology version only (see buildScanWindowIdentity below) — the production
// evidence showed the scan's own latest-event wall-clock timestamp advancing while
// matchedLotFingerprint stayed identical; a manifest keyed on that wall-clock value would have
// missed on every single rescan, which is the exact failure this module exists to prevent.
// matchedLotFingerprint itself (supplied by the caller, from scanDeterminismAudit.ts) already
// captures the real canonical structural evidence boundary (every matched lot's own chain/token/
// tx-hash/timestamp/amount) — this module does not re-derive it.
//
// FAIL-CLOSED, DISCLOSED: readCanonicalPnlSampleManifest never substitutes a fabricated manifest
// when the stored record is corrupt or its identity fields don't match what the caller expects —
// it reports the record unusable and lets the caller treat this exactly like "no manifest found"
// (never like "sample confirmed empty"). applyManifestToCandidateSample never fabricates a price
// or lot for a manifest-referenced lot the current scan can't reproduce — it reports the miss so
// the caller can expose canonical_sample_evidence_unavailable and refuse to silently substitute or
// drop it (see this function's own header below).

import type { MatchedLot } from '../modules/fifoEngine/types'
import { buildAcceptedEvidenceKey, lotIdentityVersion, type AcceptedEvidenceKvLike } from './acceptedEvidenceStore'

export const CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION = 1
// Bumped only when the CANONICAL SELECTION LOGIC changes (e.g. which accepted-evidence precedence
// rule governs a lot's published price) — never for a provider-availability change, which is
// precisely the class of change this whole module exists to make invisible to the published sample.
export const CANONICAL_PRICING_METHODOLOGY_VERSION = 1

// Reuses the exact same duck-typed KV interface accepted-evidence records already use — same
// underlying store, a genuinely separate key namespace (`v1:canonical-pnl-sample-manifest:...`).
export type CanonicalSampleManifestKvLike = AcceptedEvidenceKvLike

// IDENTITY KEY, DISCLOSED: the same lot-identity fields scanDeterminismAudit.ts's own
// (unexported) `lotIdentityKey` uses — chain/token/openedTxHash/closedTxHash/openedAt/closedAt/
// amount. Deliberately duplicated (not imported) rather than exporting scanDeterminismAudit's
// private helper — this module's own identity key is a public contract records get persisted
// against, so it gets its own explicit, testable definition rather than inheriting one designed
// for an internal fingerprint hash.
type IdentityLot = Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount'>

export function canonicalLotIdentityKey(lot: IdentityLot): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt, lot.amount].join(':')
}

// The two accepted-evidence identity keys (entry + exit) a verified lot's own persisted evidence
// would live under — see acceptedEvidenceStore.ts's own buildAcceptedEvidenceKey. Recorded on the
// manifest per requirement #2 ("accepted entry/exit evidence identity keys for those lots") purely
// as an audit trail of WHICH evidence records this manifest depends on — this module never reads
// or writes accepted-evidence records itself, it only records their keys.
export function acceptedEvidenceIdentityKeysForLot(lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount'>): [string, string] {
  const version = lotIdentityVersion(lot)
  return [
    buildAcceptedEvidenceKey({ chain: lot.chain, token: lot.token, txHash: lot.openedTxHash, side: 'entry', timestamp: lot.openedAt, lotIdentityVersion: version }),
    buildAcceptedEvidenceKey({ chain: lot.chain, token: lot.token, txHash: lot.closedTxHash, side: 'exit', timestamp: lot.closedAt, lotIdentityVersion: version }),
  ]
}

export function normalizeWalletAddress(walletAddress: string): string {
  return walletAddress.trim().toLowerCase()
}

export function buildChainScope(chains: readonly string[]): string {
  return [...new Set(chains.map((c) => c.toLowerCase()))].sort().join(',')
}

// SCAN-WINDOW IDENTITY, DISCLOSED (requirement #6 — "do not invalidate the sample merely because
// the wall-clock scan time advanced"): a stable boundary tied ONLY to the configured window
// duration and the pricing methodology version — never to any wall-clock/observed-event timestamp.
// The canonical structural evidence boundary requirement #6 also asks for is already fully captured
// by the separate `matchedLotFingerprint` identity field (every matched lot's own real tx/timestamp
// data) — folding it in here too would make this field redundant with that one and would risk this
// identity drifting on every rescan for the reason production evidence already proved: the latest
// observed event timestamp changes run to run even when nothing structural did.
export function buildScanWindowIdentity(params: { configuredWindowDays: number; pricingMethodologyVersion: number }): string {
  return `${params.configuredWindowDays}d:methodology-v${params.pricingMethodologyVersion}`
}

export type CanonicalPnlSampleManifestIdentity = {
  normalizedWalletAddress: string
  chainScope: string
  scanWindowIdentity: string
  matchedLotFingerprint: string
  pricingMethodologyVersion: number
  manifestSchemaVersion: number
}

export function buildManifestIdentity(params: {
  walletAddress: string
  chains: readonly string[]
  configuredWindowDays: number
  matchedLotFingerprint: string
  pricingMethodologyVersion?: number
  manifestSchemaVersion?: number
}): CanonicalPnlSampleManifestIdentity {
  const pricingMethodologyVersion = params.pricingMethodologyVersion ?? CANONICAL_PRICING_METHODOLOGY_VERSION
  return {
    normalizedWalletAddress: normalizeWalletAddress(params.walletAddress),
    chainScope: buildChainScope(params.chains),
    scanWindowIdentity: buildScanWindowIdentity({ configuredWindowDays: params.configuredWindowDays, pricingMethodologyVersion }),
    matchedLotFingerprint: params.matchedLotFingerprint,
    pricingMethodologyVersion,
    manifestSchemaVersion: params.manifestSchemaVersion ?? CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION,
  }
}

export function buildManifestKey(identity: CanonicalPnlSampleManifestIdentity): string {
  return [
    'v1:canonical-pnl-sample-manifest',
    identity.normalizedWalletAddress,
    identity.chainScope,
    identity.scanWindowIdentity,
    identity.matchedLotFingerprint,
    `v${identity.pricingMethodologyVersion}`,
    `s${identity.manifestSchemaVersion}`,
  ].join(':')
}

export type CanonicalPnlSampleManifest = CanonicalPnlSampleManifestIdentity & {
  manifestVersion: number
  priorManifestVersion: number | null
  verifiedLotIdentityKeys: string[]
  acceptedEvidenceIdentityKeys: string[]
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  scanFingerprint: string
  realizedPnlUsd: number | null
  verifiedLotCount: number
  structuralLotCount: number
  verifiedPricingCoverage: number | null
  createdAt: number
  refreshedAt: number
  refreshReason: string | null
}

type DeterminismFingerprints = {
  verifiedLotIdentityFingerprint: string
  acceptedHistoricalPriceFingerprint: string
  realizedPnlFingerprint: string
  scanFingerprint: string
}

export function buildManifestFromCandidate(params: {
  identity: CanonicalPnlSampleManifestIdentity
  candidateVerifiedLots: readonly MatchedLot[]
  structuralLotCount: number
  fingerprints: DeterminismFingerprints
  realizedPnlUsd: number | null
  verifiedPricingCoverage: number | null
  now: number
  priorManifest?: CanonicalPnlSampleManifest | null
  refreshReason?: string | null
}): CanonicalPnlSampleManifest {
  const verifiedLotIdentityKeys = params.candidateVerifiedLots.map(canonicalLotIdentityKey).sort()
  const acceptedEvidenceIdentityKeys = params.candidateVerifiedLots.flatMap(acceptedEvidenceIdentityKeysForLot).sort()
  return {
    ...params.identity,
    manifestVersion: params.priorManifest ? params.priorManifest.manifestVersion + 1 : 1,
    priorManifestVersion: params.priorManifest ? params.priorManifest.manifestVersion : null,
    verifiedLotIdentityKeys,
    acceptedEvidenceIdentityKeys,
    verifiedLotIdentityFingerprint: params.fingerprints.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint: params.fingerprints.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint: params.fingerprints.realizedPnlFingerprint,
    scanFingerprint: params.fingerprints.scanFingerprint,
    realizedPnlUsd: params.realizedPnlUsd,
    verifiedLotCount: params.candidateVerifiedLots.length,
    structuralLotCount: params.structuralLotCount,
    verifiedPricingCoverage: params.verifiedPricingCoverage,
    createdAt: params.priorManifest ? params.priorManifest.createdAt : params.now,
    refreshedAt: params.now,
    refreshReason: params.priorManifest ? (params.refreshReason ?? null) : null,
  }
}

// VALIDATION, DISCLOSED, FAIL-CLOSED: any identity-field mismatch or structurally-corrupt record
// (missing/wrong-typed required fields) makes the record unusable — same posture as
// acceptedEvidenceStore.ts's own isValidAcceptedEvidence. Never throws.
export function isValidCanonicalPnlSampleManifest(raw: unknown, expectedIdentity: CanonicalPnlSampleManifestIdentity): raw is CanonicalPnlSampleManifest {
  if (raw === null || typeof raw !== 'object') return false
  const m = raw as Partial<CanonicalPnlSampleManifest>
  if (m.normalizedWalletAddress !== expectedIdentity.normalizedWalletAddress) return false
  if (m.chainScope !== expectedIdentity.chainScope) return false
  if (m.scanWindowIdentity !== expectedIdentity.scanWindowIdentity) return false
  if (m.matchedLotFingerprint !== expectedIdentity.matchedLotFingerprint) return false
  if (m.pricingMethodologyVersion !== expectedIdentity.pricingMethodologyVersion) return false
  if (m.manifestSchemaVersion !== expectedIdentity.manifestSchemaVersion) return false
  if (!Array.isArray(m.verifiedLotIdentityKeys)) return false
  if (!Array.isArray(m.acceptedEvidenceIdentityKeys)) return false
  if (typeof m.verifiedLotIdentityFingerprint !== 'string') return false
  if (typeof m.acceptedHistoricalPriceFingerprint !== 'string') return false
  if (typeof m.realizedPnlFingerprint !== 'string') return false
  if (typeof m.scanFingerprint !== 'string') return false
  if (typeof m.manifestVersion !== 'number') return false
  if (typeof m.verifiedLotCount !== 'number') return false
  if (typeof m.structuralLotCount !== 'number') return false
  if (typeof m.createdAt !== 'number') return false
  if (typeof m.refreshedAt !== 'number') return false
  return true
}

export type ReadCanonicalPnlSampleManifestResult = {
  manifest: CanonicalPnlSampleManifest | null
  // A record existed at this key but failed validation (corrupt or identity-mismatched) — distinct
  // from "no record at this key at all", reported separately so the caller's audit never conflates
  // "first scan" with "a manifest exists but we can't trust it".
  validationFailure: boolean
}

export async function readCanonicalPnlSampleManifest(
  kv: CanonicalSampleManifestKvLike,
  identity: CanonicalPnlSampleManifestIdentity,
  now: number = Date.now(),
): Promise<ReadCanonicalPnlSampleManifestResult> {
  void now // reserved for a future TTL policy; manifests are durable (no expiry) today, disclosed.
  try {
    const raw = await kv.get<unknown>(buildManifestKey(identity))
    if (raw === null || raw === undefined) return { manifest: null, validationFailure: false }
    if (!isValidCanonicalPnlSampleManifest(raw, identity)) return { manifest: null, validationFailure: true }
    return { manifest: raw, validationFailure: false }
  } catch {
    // I/O failure fails OPEN to "no manifest" (matching acceptedEvidenceStore's own read posture)
    // — never fabricated as a validation failure, which would misreport a transient outage as data
    // corruption in the audit.
    return { manifest: null, validationFailure: false }
  }
}

export async function writeCanonicalPnlSampleManifest(kv: CanonicalSampleManifestKvLike, manifest: CanonicalPnlSampleManifest): Promise<boolean> {
  try {
    await kv.set(buildManifestKey(manifest), manifest)
    return true
  } catch {
    return false
  }
}

export function buildRefreshedManifest(params: {
  priorManifest: CanonicalPnlSampleManifest
  identity: CanonicalPnlSampleManifestIdentity
  candidateVerifiedLots: readonly MatchedLot[]
  structuralLotCount: number
  fingerprints: DeterminismFingerprints
  realizedPnlUsd: number | null
  verifiedPricingCoverage: number | null
  now: number
  refreshReason: string
}): CanonicalPnlSampleManifest {
  return buildManifestFromCandidate({
    identity: params.identity,
    candidateVerifiedLots: params.candidateVerifiedLots,
    structuralLotCount: params.structuralLotCount,
    fingerprints: params.fingerprints,
    realizedPnlUsd: params.realizedPnlUsd,
    verifiedPricingCoverage: params.verifiedPricingCoverage,
    now: params.now,
    priorManifest: params.priorManifest,
    refreshReason: params.refreshReason,
  })
}

export type ApplyManifestResult = {
  // Exactly the lots named by manifest.verifiedLotIdentityKeys that this scan's own candidate
  // array could reproduce — the published sample.
  selectedLots: MatchedLot[]
  // Verified this scan but NOT named by the manifest — real, newly-priceable evidence that must
  // never silently enter the published sample (requirement #4). Disclosed to the caller only.
  candidateNewEvidence: MatchedLot[]
  // Manifest-named identity keys this scan's candidate array could NOT reproduce at all (the lot
  // vanished from the candidate set, or is present but no longer verified this run) — FAIL CLOSED:
  // the caller must never substitute a new value or silently drop these; see requirement #9.
  manifestLotsMissingCurrentEvidence: string[]
  evidenceUnavailable: boolean
}

// PURE, DISCLOSED (requirement #4/#9): never mutates a lot, never fabricates a price. A manifest
// lot missing from `candidateVerifiedLots` is reported, never substituted or dropped silently —
// `evidenceUnavailable` tells the caller this manifest cannot be honestly applied in full this run.
export function applyManifestToCandidateSample(params: {
  manifest: CanonicalPnlSampleManifest
  candidateVerifiedLots: readonly MatchedLot[]
}): ApplyManifestResult {
  const candidateByKey = new Map(params.candidateVerifiedLots.map((lot) => [canonicalLotIdentityKey(lot), lot]))
  const manifestKeySet = new Set(params.manifest.verifiedLotIdentityKeys)

  const selectedLots: MatchedLot[] = []
  const manifestLotsMissingCurrentEvidence: string[] = []
  for (const key of params.manifest.verifiedLotIdentityKeys) {
    const lot = candidateByKey.get(key)
    if (lot) selectedLots.push(lot)
    else manifestLotsMissingCurrentEvidence.push(key)
  }

  const candidateNewEvidence = params.candidateVerifiedLots.filter((lot) => !manifestKeySet.has(canonicalLotIdentityKey(lot)))

  return {
    selectedLots,
    candidateNewEvidence,
    manifestLotsMissingCurrentEvidence,
    evidenceUnavailable: manifestLotsMissingCurrentEvidence.length > 0,
  }
}

export type CanonicalSampleManifestAudit = {
  manifestKey: string
  manifestFound: boolean
  manifestCreated: boolean
  manifestApplied: boolean
  manifestVersion: number | null
  manifestVerifiedLotCount: number | null
  currentCandidateVerifiedLotCount: number
  candidateNewEvidenceCount: number
  candidateNewEvidenceLotKeys: string[]
  manifestLotsMissingCurrentEvidence: string[]
  manifestEvidenceHydrated: boolean
  manifestIdentityMismatches: number
  manifestValidationFailures: number
  manifestWriteSuccess: boolean
  manifestWriteFailure: boolean
  refreshRequested: boolean
  refreshReason: string | null
  // Fail-closed disclosure surfaced to the caller/UI (requirement #9) — true only when a manifest
  // exists but could not be applied in full this run because required evidence vanished.
  canonicalSampleEvidenceUnavailable: boolean
}

export function emptyCanonicalSampleManifestAudit(manifestKey: string): CanonicalSampleManifestAudit {
  return {
    manifestKey,
    manifestFound: false,
    manifestCreated: false,
    manifestApplied: false,
    manifestVersion: null,
    manifestVerifiedLotCount: null,
    currentCandidateVerifiedLotCount: 0,
    candidateNewEvidenceCount: 0,
    candidateNewEvidenceLotKeys: [],
    manifestLotsMissingCurrentEvidence: [],
    manifestEvidenceHydrated: true,
    manifestIdentityMismatches: 0,
    manifestValidationFailures: 0,
    manifestWriteSuccess: false,
    manifestWriteFailure: false,
    refreshRequested: false,
    refreshReason: null,
    canonicalSampleEvidenceUnavailable: false,
  }
}

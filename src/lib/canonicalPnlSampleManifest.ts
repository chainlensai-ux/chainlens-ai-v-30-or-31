// MODULE — canonicalPnlSampleManifest (durable-canonical-sample follow-up task; identity/replay
// rewrite after the confirmed production replay failure).
//
// GOAL, DISCLOSED: production evidence proved that once accepted-evidence precedence and gate/AYRI
// agreement were both fixed, a NEW nondeterminism surfaced — newly available evidence silently
// EXPANDED the published verified sample between rescans of the SAME structural lot set. This
// module is the durable record of "the sample we already published" that a rescan reproduces
// unless an explicit refresh occurs.
//
// CONFIRMED REPLAY FAILURE THIS REWRITE FIXES, DISCLOSED: the first implementation put the matched
// lot's `amount` (a JS double) directly into the identity key as `String(amount)`. FIFO partial
// fills derive their amounts by repeated subtraction, so the SAME structural fill can serialize as
// `0.30000000000000004` on one scan and `0.3` on the next depending purely on internal accumulation
// order. Production result: a manifest with 21 lots resolved ZERO of them
// (`manifestEvidenceHydrated: false`, `canonicalSampleEvidenceUnavailable: true`) even though every
// lot was genuinely present. Fixed here (requirement #1) — the identity is now built from stable
// structural fields ONLY, plus a deterministic partial-fill ORDINAL; quantities survive as
// validation metadata in a canonical, float-noise-tolerant decimal string, never as key text.
//
// IDENTITY, DISCLOSED: keyed by (wallet, chain scope, scan-window identity, structural
// matchedLotFingerprint, pricing methodology version, manifest schema version) — deliberately NOT
// by wall-clock scan time. `scanWindowIdentity` is built from the CONFIGURED window duration and
// the pricing methodology version only — production evidence showed the scan's own latest-event
// wall-clock timestamp advancing while matchedLotFingerprint stayed identical; a manifest keyed on
// that value would miss on every rescan, the exact failure this module exists to prevent.
//
// FAIL-CLOSED, DISCLOSED: `replayManifest` is ATOMIC (requirement #3) — it either resolves EVERY
// manifest lot and returns a fully-validated published array, or it resolves none and returns
// `outcome: 'unavailable'` with a published array in which NO verified lot is published at all.
// It never partially applies, never substitutes provider evidence for a missing manifest lot, and
// never lets the current live candidate sample escape as canonical (requirement #4).

import type { MatchedLot } from '../modules/fifoEngine/types'
import { buildAcceptedEvidenceKey, lotIdentityVersion, type AcceptedEvidenceKvLike } from './acceptedEvidenceStore'

// Bumped to 2 by the identity rewrite (requirement #1). This version is part of the KV key itself,
// so every v1 manifest (built with the broken float-in-key identity) is simply never looked up
// again — a clean rebuild on the next scan, never a silent reuse of identities this module can no
// longer reproduce.
export const CANONICAL_SAMPLE_MANIFEST_SCHEMA_VERSION = 2
export const CANONICAL_LOT_IDENTITY_SCHEMA_VERSION = 2
// Bumped only when the CANONICAL SELECTION LOGIC changes (e.g. which accepted-evidence precedence
// rule governs a lot's published price) — never for a provider-availability change, which is
// precisely the class of change this whole module exists to make invisible to the published sample.
export const CANONICAL_PRICING_METHODOLOGY_VERSION = 1

// Reuses the exact same duck-typed KV interface accepted-evidence records already use — same
// underlying store, a genuinely separate key namespace (`v1:canonical-pnl-sample-manifest:...`).
export type CanonicalSampleManifestKvLike = AcceptedEvidenceKvLike

// ============================================================================
// LOT IDENTITY (requirement #1)
// ============================================================================

type IdentityLot = Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount'>

// CANONICAL AMOUNT STRING, DISCLOSED: VALIDATION METADATA ONLY — never a key component
// (requirement #1's own "never use JS floating-point string output in the key"). Fixed 12-decimal
// normalization deliberately absorbs exactly the float-accumulation noise that broke the first
// implementation: 0.30000000000000004 and 0.3 both normalize to "0.300000000000", so a partial
// fill's quantity can still be cross-checked between runs without that check itself becoming a new
// source of spurious mismatches. Non-finite input yields the honest literal 'invalid', never a
// fabricated 0.
export function canonicalAmountString(amount: number): string {
  if (!Number.isFinite(amount)) return 'invalid'
  return amount.toFixed(12)
}

// STRUCTURAL GROUP KEY, DISCLOSED: everything that identifies a matched lot EXCEPT which slice of a
// partial fill it is — chain, normalized token, both tx hashes, both event timestamps. Two lots
// sharing this key are, by construction, two slices of the same buy tx consumed by the same sell tx
// (a real FIFO partial fill); the ordinal below is what separates them.
function structuralGroupKey(lot: IdentityLot): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt].join(':')
}

export type CanonicalLotIdentity = {
  key: string
  groupKey: string
  partialFillOrdinal: number
  // The group's total size, recorded so a replay can detect that a partial fill SPLIT DIFFERENTLY
  // between runs (same structural key, different slice count) instead of silently matching the
  // wrong slice — see `manifest_partial_fill_ordinal_mismatch`.
  partialFillGroupSize: number
  canonicalAmount: string
}

// PARTIAL-FILL ORDINAL, DISCLOSED (requirement #1): assigned over the FULL canonical lot array —
// never over a verified-only subset, because whether a given slice happens to be priced this run
// must never shift another slice's identity. Within a structural group, slices are ordered by
// (canonicalAmount, closedTxHash, openedTxHash) rather than by raw array position: array position
// depends on FIFO's internal accumulation order, which is exactly the kind of run-to-run variation
// requirement #8 asks this identity to survive. Amount is used here purely as an ORDERING signal in
// its already-normalized, noise-tolerant form — never as key text.
export function buildCanonicalLotIdentities(lots: readonly MatchedLot[]): Map<MatchedLot, CanonicalLotIdentity> {
  const groups = new Map<string, MatchedLot[]>()
  for (const lot of lots) {
    const gk = structuralGroupKey(lot)
    const existing = groups.get(gk)
    if (existing) existing.push(lot)
    else groups.set(gk, [lot])
  }

  const identities = new Map<MatchedLot, CanonicalLotIdentity>()
  for (const [gk, members] of groups) {
    const ordered = [...members].sort((a, b) => {
      const amountCompare = canonicalAmountString(a.amount).localeCompare(canonicalAmountString(b.amount))
      if (amountCompare !== 0) return amountCompare
      const closedCompare = a.closedTxHash.localeCompare(b.closedTxHash)
      if (closedCompare !== 0) return closedCompare
      return a.openedTxHash.localeCompare(b.openedTxHash)
    })
    ordered.forEach((lot, ordinal) => {
      identities.set(lot, {
        key: `v${CANONICAL_LOT_IDENTITY_SCHEMA_VERSION}:${gk}:${ordinal}`,
        groupKey: gk,
        partialFillOrdinal: ordinal,
        partialFillGroupSize: ordered.length,
        canonicalAmount: canonicalAmountString(lot.amount),
      })
    })
  }
  return identities
}

// The two accepted-evidence identity keys (entry + exit) a verified lot's own persisted evidence
// lives under. Recorded on the manifest per requirement #2 purely as an audit trail of WHICH
// evidence records the manifest depends on — this module never reads or writes accepted-evidence
// records itself. NOTE, DISCLOSED: two slices of the same partial fill legitimately share both of
// these keys (buildAcceptedEvidenceKey is per-tx-side, not per-lot), which is precisely why the
// stored evidence-key list must be deduplicated (requirement #2).
export function acceptedEvidenceIdentityKeysForLot(lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt' | 'amount'>): [string, string] {
  const version = lotIdentityVersion(lot)
  return [
    buildAcceptedEvidenceKey({ chain: lot.chain, token: lot.token, txHash: lot.openedTxHash, side: 'entry', timestamp: lot.openedAt, lotIdentityVersion: version }),
    buildAcceptedEvidenceKey({ chain: lot.chain, token: lot.token, txHash: lot.closedTxHash, side: 'exit', timestamp: lot.closedAt, lotIdentityVersion: version }),
  ]
}

// ============================================================================
// DEDUPLICATION (requirement #2)
// ============================================================================

export type DedupeResult = { unique: string[]; duplicates: string[] }

// CANONICALIZE -> SORT -> DEDUPLICATE, DISCLOSED (requirement #2, in that exact order): every key
// list this module persists or replays passes through here, so a duplicate can never silently
// inflate a manifest's own lot count or produce a phantom "missing" entry on replay. Returns the
// real duplicate keys (each reported once), never just a count.
export function dedupeKeys(keys: readonly string[]): DedupeResult {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) duplicated.add(key)
    else seen.add(key)
  }
  return { unique: [...seen].sort(), duplicates: [...duplicated].sort() }
}

export type DuplicateIdentityCheck = {
  hasDuplicates: boolean
  manifestDuplicateLotKeys: string[]
  candidateDuplicateLotKeys: string[]
  manifestDuplicateEvidenceKeys: string[]
}

// LOGGING WRAPPER, DISCLOSED: the pure check above stays testable; this is the only piece that does
// I/O. `logger.error`, not `.warn` — requirement #2 asks explicitly for CRITICAL severity.
export function logDuplicateIdentityIfAny(check: DuplicateIdentityCheck, logger: Pick<Console, 'error'> = console): void {
  if (!check.hasDuplicates) return
  logger.error('CRITICAL canonical_manifest_duplicate_identity', {
    manifestDuplicateLotKeys: check.manifestDuplicateLotKeys,
    candidateDuplicateLotKeys: check.candidateDuplicateLotKeys,
    manifestDuplicateEvidenceKeys: check.manifestDuplicateEvidenceKeys,
  })
}

// ============================================================================
// MANIFEST IDENTITY / KEYING
// ============================================================================

export function normalizeWalletAddress(walletAddress: string): string {
  return walletAddress.trim().toLowerCase()
}

export function buildChainScope(chains: readonly string[]): string {
  return [...new Set(chains.map((c) => c.toLowerCase()))].sort().join(',')
}

// SCAN-WINDOW IDENTITY, DISCLOSED (requirement #6 of the prior task — "do not invalidate the sample
// merely because the wall-clock scan time advanced"): a stable boundary tied ONLY to the configured
// window duration and the pricing methodology version, never to any observed-event timestamp. The
// canonical structural evidence boundary is already fully captured by the separate
// `matchedLotFingerprint` identity field.
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

// ============================================================================
// MANIFEST RECORD
// ============================================================================

// Per-lot validation metadata (requirement #1's "treat them as validation metadata, not the primary
// identity"). Keyed by the lot identity key; never consulted to FIND a lot, only to confirm the one
// found by identity still describes the same fill.
export type CanonicalManifestLotRecord = {
  key: string
  canonicalAmount: string
  partialFillOrdinal: number
  partialFillGroupSize: number
}

export type CanonicalPnlSampleManifest = CanonicalPnlSampleManifestIdentity & {
  lotIdentitySchemaVersion: number
  manifestVersion: number
  priorManifestVersion: number | null
  verifiedLotIdentityKeys: string[]
  verifiedLotRecords: CanonicalManifestLotRecord[]
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
  // The FULL canonical lot array — required so partial-fill ordinals are assigned over every slice,
  // not just the priced ones (see buildCanonicalLotIdentities' own header).
  allCandidateLots: readonly MatchedLot[]
  candidateVerifiedLots: readonly MatchedLot[]
  structuralLotCount: number
  fingerprints: DeterminismFingerprints
  realizedPnlUsd: number | null
  verifiedPricingCoverage: number | null
  now: number
  priorManifest?: CanonicalPnlSampleManifest | null
  refreshReason?: string | null
}): CanonicalPnlSampleManifest {
  const identities = buildCanonicalLotIdentities(params.allCandidateLots)
  const records: CanonicalManifestLotRecord[] = []
  const rawLotKeys: string[] = []
  const rawEvidenceKeys: string[] = []
  for (const lot of params.candidateVerifiedLots) {
    const identity = identities.get(lot)
    if (!identity) continue
    rawLotKeys.push(identity.key)
    records.push({
      key: identity.key,
      canonicalAmount: identity.canonicalAmount,
      partialFillOrdinal: identity.partialFillOrdinal,
      partialFillGroupSize: identity.partialFillGroupSize,
    })
    rawEvidenceKeys.push(...acceptedEvidenceIdentityKeysForLot(lot))
  }
  // CANONICALIZE -> SORT -> DEDUPE before persistence (requirement #2).
  const { unique: verifiedLotIdentityKeys } = dedupeKeys(rawLotKeys)
  const { unique: acceptedEvidenceIdentityKeys } = dedupeKeys(rawEvidenceKeys)
  const dedupedRecords = verifiedLotIdentityKeys
    .map((key) => records.find((r) => r.key === key))
    .filter((r): r is CanonicalManifestLotRecord => r !== undefined)

  return {
    ...params.identity,
    lotIdentitySchemaVersion: CANONICAL_LOT_IDENTITY_SCHEMA_VERSION,
    manifestVersion: params.priorManifest ? params.priorManifest.manifestVersion + 1 : 1,
    priorManifestVersion: params.priorManifest ? params.priorManifest.manifestVersion : null,
    verifiedLotIdentityKeys,
    verifiedLotRecords: dedupedRecords,
    acceptedEvidenceIdentityKeys,
    verifiedLotIdentityFingerprint: params.fingerprints.verifiedLotIdentityFingerprint,
    acceptedHistoricalPriceFingerprint: params.fingerprints.acceptedHistoricalPriceFingerprint,
    realizedPnlFingerprint: params.fingerprints.realizedPnlFingerprint,
    scanFingerprint: params.fingerprints.scanFingerprint,
    realizedPnlUsd: params.realizedPnlUsd,
    // The REAL published count — deduplicated, so it can never be inflated by a duplicate key.
    verifiedLotCount: verifiedLotIdentityKeys.length,
    structuralLotCount: params.structuralLotCount,
    verifiedPricingCoverage: params.verifiedPricingCoverage,
    createdAt: params.priorManifest ? params.priorManifest.createdAt : params.now,
    refreshedAt: params.now,
    refreshReason: params.priorManifest ? (params.refreshReason ?? null) : null,
  }
}

export function buildRefreshedManifest(params: {
  priorManifest: CanonicalPnlSampleManifest
  identity: CanonicalPnlSampleManifestIdentity
  allCandidateLots: readonly MatchedLot[]
  candidateVerifiedLots: readonly MatchedLot[]
  structuralLotCount: number
  fingerprints: DeterminismFingerprints
  realizedPnlUsd: number | null
  verifiedPricingCoverage: number | null
  now: number
  refreshReason: string
}): CanonicalPnlSampleManifest {
  return buildManifestFromCandidate({ ...params, priorManifest: params.priorManifest })
}

// VALIDATION, DISCLOSED, FAIL-CLOSED: any identity-field mismatch or structurally-corrupt record
// makes the manifest unusable — same posture as acceptedEvidenceStore's own isValidAcceptedEvidence.
// Never throws.
export function isValidCanonicalPnlSampleManifest(raw: unknown, expectedIdentity: CanonicalPnlSampleManifestIdentity): raw is CanonicalPnlSampleManifest {
  if (raw === null || typeof raw !== 'object') return false
  const m = raw as Partial<CanonicalPnlSampleManifest>
  if (m.normalizedWalletAddress !== expectedIdentity.normalizedWalletAddress) return false
  if (m.chainScope !== expectedIdentity.chainScope) return false
  if (m.scanWindowIdentity !== expectedIdentity.scanWindowIdentity) return false
  if (m.matchedLotFingerprint !== expectedIdentity.matchedLotFingerprint) return false
  if (m.pricingMethodologyVersion !== expectedIdentity.pricingMethodologyVersion) return false
  if (m.manifestSchemaVersion !== expectedIdentity.manifestSchemaVersion) return false
  if (m.lotIdentitySchemaVersion !== CANONICAL_LOT_IDENTITY_SCHEMA_VERSION) return false
  if (!Array.isArray(m.verifiedLotIdentityKeys)) return false
  if (!Array.isArray(m.verifiedLotRecords)) return false
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
  validationFailure: boolean
}

export async function readCanonicalPnlSampleManifest(
  kv: CanonicalSampleManifestKvLike,
  identity: CanonicalPnlSampleManifestIdentity,
): Promise<ReadCanonicalPnlSampleManifestResult> {
  try {
    const raw = await kv.get<unknown>(buildManifestKey(identity))
    if (raw === null || raw === undefined) return { manifest: null, validationFailure: false }
    if (!isValidCanonicalPnlSampleManifest(raw, identity)) return { manifest: null, validationFailure: true }
    return { manifest: raw, validationFailure: false }
  } catch {
    // I/O failure fails OPEN to "no manifest" (matching acceptedEvidenceStore's own read posture) —
    // never fabricated as a validation failure, which would misreport a transient outage as data
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

// ============================================================================
// REPLAY (requirements #3, #4, #6, #7)
// ============================================================================

export type ManifestReplayReason =
  | 'manifest_lot_identity_not_found'
  | 'manifest_side_evidence_missing'
  | 'manifest_side_evidence_invalid'
  | 'manifest_partial_fill_ordinal_mismatch'
  | 'manifest_duplicate_identity'
  | 'manifest_candidate_only_lot'
  | 'manifest_replay_success'

export type ManifestReplayReasonCounts = Record<ManifestReplayReason, number>

function emptyReplayReasonCounts(): ManifestReplayReasonCounts {
  return {
    manifest_lot_identity_not_found: 0,
    manifest_side_evidence_missing: 0,
    manifest_side_evidence_invalid: 0,
    manifest_partial_fill_ordinal_mismatch: 0,
    manifest_duplicate_identity: 0,
    manifest_candidate_only_lot: 0,
    manifest_replay_success: 0,
  }
}

export type ManifestReplayResult = {
  outcome: 'applied' | 'unavailable'
  // The ONE canonical array every downstream consumer publishes from (requirement #5/#10). Always
  // the same length and the same structural lots as the input array — this function never adds,
  // removes or reorders a lot, it only decides which verified lots are PUBLISHED. A lot that is not
  // published is returned in the honest `'unpriced'` state rather than being deleted, so structural
  // coverage denominators and FIFO's own matched-lot set are completely unaffected.
  publishedLots: MatchedLot[]
  // Set when the manifest could not be replayed in full — the caller must publish a degraded/
  // unavailable public result, never the live candidate sample (requirement #4).
  forcePublicPnlUnavailable: boolean
  selectedLotKeys: string[]
  candidateNewEvidenceLotKeys: string[]
  manifestLotsMissingCurrentEvidence: string[]
  reasonCounts: ManifestReplayReasonCounts
  duplicates: DuplicateIdentityCheck
}

// Reverts a lot to the honest unpriced state for PUBLICATION purposes only. Never mutates the input
// (returns a new object), never changes chain/token/tx/timestamp/amount — FIFO matching,
// classification and the structural lot set are all completely untouched (this task's own explicit
// "do not change FIFO, pricing values, gates, classifications" constraint). The lot's real live
// price still exists upstream; it is simply not published as canonical this scan.
function withheldFromPublication(lot: MatchedLot): MatchedLot {
  if (lot.evidenceQuality !== 'verified' && lot.costBasisUsd === null && lot.proceedsUsd === null) return lot
  return { ...lot, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }
}

// ATOMIC REPLAY, DISCLOSED (requirement #3): every list below is computed in full BEFORE any
// published array is constructed, and the published array is built exactly once, from a single
// decision. There is no incremental mutation of a shared lot array anywhere in this function — the
// prior implementation's mutate-then-decide shape is exactly what let a live 23-lot sample escape
// while the audit simultaneously reported the manifest as unavailable.
export function replayManifest(params: {
  manifest: CanonicalPnlSampleManifest
  allCandidateLots: readonly MatchedLot[]
  isVerified: (lot: MatchedLot) => boolean
}): ManifestReplayResult {
  const reasonCounts = emptyReplayReasonCounts()

  // 1. Build the current candidate identity map over the FULL array (ordinals must see every slice).
  const identities = buildCanonicalLotIdentities(params.allCandidateLots)
  const candidateVerifiedLots = params.allCandidateLots.filter(params.isVerified)

  // 2. Canonicalize + dedupe both sides (requirement #2).
  const manifestDedupe = dedupeKeys(params.manifest.verifiedLotIdentityKeys)
  const candidateVerifiedKeys = candidateVerifiedLots.map((lot) => identities.get(lot)?.key ?? '')
  const candidateDedupe = dedupeKeys(candidateVerifiedKeys.filter((k) => k !== ''))
  const evidenceDedupe = dedupeKeys(params.manifest.acceptedEvidenceIdentityKeys)
  const duplicates: DuplicateIdentityCheck = {
    hasDuplicates: manifestDedupe.duplicates.length > 0 || candidateDedupe.duplicates.length > 0 || evidenceDedupe.duplicates.length > 0,
    manifestDuplicateLotKeys: manifestDedupe.duplicates,
    candidateDuplicateLotKeys: candidateDedupe.duplicates,
    manifestDuplicateEvidenceKeys: evidenceDedupe.duplicates,
  }
  reasonCounts.manifest_duplicate_identity = manifestDedupe.duplicates.length + candidateDedupe.duplicates.length + evidenceDedupe.duplicates.length

  // 3. Resolve + validate EVERY manifest lot. Nothing is published until this loop completes.
  const candidateVerifiedByKey = new Map<string, MatchedLot>()
  for (const lot of candidateVerifiedLots) {
    const identity = identities.get(lot)
    if (identity && !candidateVerifiedByKey.has(identity.key)) candidateVerifiedByKey.set(identity.key, lot)
  }
  const anyCandidateByKey = new Map<string, MatchedLot>()
  for (const lot of params.allCandidateLots) {
    const identity = identities.get(lot)
    if (identity && !anyCandidateByKey.has(identity.key)) anyCandidateByKey.set(identity.key, lot)
  }
  const recordByKey = new Map(params.manifest.verifiedLotRecords.map((r) => [r.key, r]))

  const selectedLotKeys: string[] = []
  const manifestLotsMissingCurrentEvidence: string[] = []
  for (const key of manifestDedupe.unique) {
    const structuralLot = anyCandidateByKey.get(key)
    if (!structuralLot) {
      reasonCounts.manifest_lot_identity_not_found += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    const currentIdentity = identities.get(structuralLot)
    const record = recordByKey.get(key)
    if (record && currentIdentity && record.partialFillGroupSize !== currentIdentity.partialFillGroupSize) {
      // The same structural tx pair split into a DIFFERENT number of FIFO slices this run — the
      // identity resolved, but it no longer describes the same fill. Fail closed rather than publish
      // a slice the manifest never actually recorded.
      reasonCounts.manifest_partial_fill_ordinal_mismatch += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    if (record && currentIdentity && record.canonicalAmount !== currentIdentity.canonicalAmount) {
      reasonCounts.manifest_side_evidence_invalid += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    if (!candidateVerifiedByKey.has(key)) {
      // The lot is structurally present but its accepted side evidence could not be reproduced this
      // run (one or both sides lost their price) — never substitute a live provider value for it.
      reasonCounts.manifest_side_evidence_missing += 1
      manifestLotsMissingCurrentEvidence.push(key)
      continue
    }
    reasonCounts.manifest_replay_success += 1
    selectedLotKeys.push(key)
  }

  // 4. Candidate-only lots — real, newly-priceable evidence, never merged into the published sample.
  const manifestKeySet = new Set(manifestDedupe.unique)
  const candidateNewEvidenceLotKeys = candidateDedupe.unique.filter((key) => !manifestKeySet.has(key))
  reasonCounts.manifest_candidate_only_lot = candidateNewEvidenceLotKeys.length

  // 5. ONE atomic decision, then ONE published array (requirement #3/#4).
  const replayFailed = manifestLotsMissingCurrentEvidence.length > 0 || duplicates.hasDuplicates
  const selectedKeySet = new Set(selectedLotKeys)
  const publishedLots = params.allCandidateLots.map((lot) => {
    if (!params.isVerified(lot)) return lot
    // FAIL CLOSED (requirement #4): when the manifest could not be replayed in full, NO verified lot
    // is published at all — the live candidate sample must never escape as canonical. When it
    // replayed cleanly, only manifest-selected lots are published; candidate-only lots are withheld
    // (requirement #6 — zero contribution to public realized PnL).
    if (replayFailed) return withheldFromPublication(lot)
    const identity = identities.get(lot)
    if (!identity || !selectedKeySet.has(identity.key)) return withheldFromPublication(lot)
    return lot
  })

  return {
    outcome: replayFailed ? 'unavailable' : 'applied',
    publishedLots,
    forcePublicPnlUnavailable: replayFailed,
    // ATOMIC REPORTING, DISCLOSED: on failure this is EMPTY, because zero lots were actually
    // selected for publication — reporting the lots that happened to resolve before the failure
    // would claim a selection that never reached the published array, which is precisely the
    // audit-vs-reality mismatch this task exists to eliminate (production reported
    // `manifestVerifiedLotCount: 21` next to a published 23-lot live sample). The per-lot diagnostic
    // detail survives honestly in `reasonCounts.manifest_replay_success`.
    selectedLotKeys: replayFailed ? [] : selectedLotKeys,
    candidateNewEvidenceLotKeys,
    manifestLotsMissingCurrentEvidence,
    reasonCounts,
    duplicates,
  }
}

// ============================================================================
// AUDIT (requirement #8 of the prior task, extended per #2/#4/#7 here)
// ============================================================================

// LAST-KNOWN CANONICAL SAMPLE, DISCLOSED (requirement #4): the previous manifest's stored figures,
// preserved as clearly-labelled METADATA when replay fails. `availableForCurrentVerification` is
// always false here — these numbers describe a sample this scan could NOT re-verify, and must never
// be presented as freshly verified.
export type LastKnownCanonicalSample = {
  manifestVersion: number
  verifiedLotCount: number
  verifiedPricingCoverage: number | null
  realizedPnlUsd: number | null
  refreshedAt: number
  availableForCurrentVerification: false
}

export function buildLastKnownCanonicalSample(manifest: CanonicalPnlSampleManifest): LastKnownCanonicalSample {
  return {
    manifestVersion: manifest.manifestVersion,
    verifiedLotCount: manifest.verifiedLotCount,
    verifiedPricingCoverage: manifest.verifiedPricingCoverage,
    realizedPnlUsd: manifest.realizedPnlUsd,
    refreshedAt: manifest.refreshedAt,
    availableForCurrentVerification: false,
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
  publishedVerifiedLotCount: number
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
  canonicalSampleEvidenceUnavailable: boolean
  replayReasonCounts: ManifestReplayReasonCounts
  manifestDuplicateLotKeys: string[]
  candidateDuplicateLotKeys: string[]
  manifestDuplicateEvidenceKeys: string[]
  lastKnownCanonicalSample: LastKnownCanonicalSample | null
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
    publishedVerifiedLotCount: 0,
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
    replayReasonCounts: emptyReplayReasonCounts(),
    manifestDuplicateLotKeys: [],
    candidateDuplicateLotKeys: [],
    manifestDuplicateEvidenceKeys: [],
    lastKnownCanonicalSample: null,
  }
}

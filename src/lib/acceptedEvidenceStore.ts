// MODULE — acceptedEvidenceStore (determinism follow-up task, requirement #1-#4).
//
// GOAL, DISCLOSED: the prior determinism fix (src/lib/kvClient.ts's long-TTL historical price
// cache) keys purely by (chain, token, timestamp) — a real improvement, but still generic
// token-price evidence, not the FINAL, ACCEPTED value for a specific matched-lot SIDE. Production
// proof showed the same 27-lot structural match still produced a DIFFERENT verified-lot set and
// realized PnL across two identical rescans (one buy-side price recovered differently). This module
// persists the exact accepted evidence for one matched-lot SIDE (entry/exit) — keyed tightly enough
// that a rescan can ONLY ever reuse it for the exact same lot, side, and timestamp it was accepted
// for, never a coincidentally-matching token/timestamp pair from an unrelated lot.
//
// FAIL-CLOSED, DISCLOSED (requirement #4): a persisted entry is used ONLY when every identity field
// matches EXACTLY — chain, token, txHash, side, timestamp, lot-identity-version, and schemaVersion.
// Any mismatch, corruption, or expiry is a cache MISS, never an invalidation event of its own kind —
// this module does not "invalidate" in the sense of deleting a stale entry; it simply never accepts
// one for the wrong lot/side/version. A provider returning null, a source cooling down, a new source
// becoming available, or the scan simply happening later are explicitly NEVER reasons to reject an
// otherwise-matching accepted entry (requirement #4's own "do not invalidate because..." list).

export type AcceptedEvidenceSide = 'entry' | 'exit'

// SCHEMA BUMP TO 2, GENUINELY REQUIRED, DISCLOSED (accepted-evidence-persistence follow-up task —
// confirmed root cause: every persisted envelope's `priceUsd` was ONE sibling FIFO partial-fill
// lot's own apportioned USD value, even though the KV key it lived under is scoped to the whole
// transaction SIDE (chain/token/txHash/side/timestamp) and is shared by every sibling lot drawing
// from that side. The writer now aggregates every eligible sibling's value into one genuine
// side-total before writing — a v1 record's `priceUsd` is NOT that total, so it must never be
// reused as if it were. Bumping the schema version is what makes `isValidAcceptedEvidence` treat
// every existing v1 record as a clean miss (never a corrupt/invalid value to reject loudly, never a
// value to silently reinterpret) — a rescan simply re-seeds it correctly under the new version.
export const ACCEPTED_EVIDENCE_SCHEMA_VERSION = 2
// IMMUTABLE HISTORICAL FACT, DISCLOSED: same reasoning as kvClient.ts's HISTORICAL_TTL_SECONDS — an
// accepted price for a specific past (chain, token, txHash, timestamp) can never legitimately
// change, so a long TTL is safe. Still finite (not "forever") to bound storage growth.
export const ACCEPTED_EVIDENCE_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

// VALUE SEMANTICS, EXPLICITLY STORED, DISCLOSED (accepted-evidence-persistence follow-up task): the
// canonical-sample manifest module's own allocation math (`allocateSideValueAcrossGroup`) already
// assumed every envelope's `priceUsd` was the TOTAL value for the whole transaction side, splitting
// it across siblings by raw quantity. That assumption is now genuinely true of every value this
// store's own writers persist — recorded explicitly on the envelope itself (never left implicit)
// so any reader can confirm which formula applies without having to trust the writer's own comment.
// `'unit_price_usd'` remains a documented, supported value for a future evidence source whose own
// price genuinely is a per-token unit price (a caller would multiply by the lot's own amount
// directly, with no group allocation needed) — this store does not produce that value today.
export type AcceptedEvidenceValueType = 'unit_price_usd' | 'total_side_value_usd'

export type AcceptedEvidenceIdentity = {
  chain: string
  token: string
  txHash: string
  side: AcceptedEvidenceSide
  timestamp: number
  // Composite identity of the MATCHED LOT this evidence was accepted for (see `lotIdentityVersion`
  // below) — the same (chain, token, txHash, timestamp) triple could in principle be revisited by a
  // FIFO rematch that produces a structurally different lot (different amount, different opposite
  // tx) if upstream data changes; this field is the guard against reusing evidence across that case.
  lotIdentityVersion: string
}

export type AcceptedEvidenceEnvelope = AcceptedEvidenceIdentity & {
  schemaVersion: number
  priceUsd: number
  valueUsd: number
  valueType: AcceptedEvidenceValueType
  // COVERAGE, DISCLOSED, ADDITIVE (accepted-evidence-raw-value-mutation follow-up task — confirmed
  // root cause: a side's group can genuinely grow structural membership between scans as new
  // siblings are recovered, but the ONLY prior write guard was "a valid record already exists at
  // this key, never touch it again" — so a write made while only ONE sibling was known stayed frozen
  // forever, even once a second, legitimate sibling sharing the exact same transaction side was
  // discovered. Records how many sibling lots' values this envelope's own `valueUsd` total actually
  // sums over, so a later writer can tell "this record already reflects the full group" (never
  // rewrite — immutability holds) apart from "this record only ever reflected a partial group"
  // (a genuine, deterministic completion, safe to reseed). Missing on any pre-existing record
  // (written before this field existed) reads back as 1 — the conservative assumption that never
  // treats an old record as MORE complete than it actually was.
  coveredLotCount: number
  // COMPOSITION FINGERPRINT, DISCLOSED, ADDITIVE (accepted-evidence-raw-value-mutation follow-up
  // task, part 2 — confirmed gap: `coveredLotCount` alone cannot tell "the exact same sibling set"
  // apart from "a genuinely different sibling set that happens to be the same size" (e.g. a stale
  // 2-lot record reading $2 next to a live 2-lot recompute reading $15,198 — same count, wrong
  // conclusion if count were the only signal). A stable, order-independent identity of exactly which
  // lots this envelope's total was aggregated over (each covered lot's own identity, sorted before
  // joining) — see `buildAcceptedEvidenceCoverageFingerprint`'s own header. Missing on any
  // pre-existing record reads back as `''`, which can never equal a real live fingerprint, so a
  // legacy record is conservatively treated as an unconfirmed composition (eligible for correction
  // once its `coveredLotCount` no longer suffices, never silently trusted purely by count).
  coverageFingerprint: string
  source: string
  evidenceType: string
  // The provider's own original timestamp/bucket for the candle/quote actually used, when known —
  // null when the underlying source function doesn't surface one (this module never fabricates it).
  providerTimestampBucket: number | null
  // Milliseconds between the requested lot-side timestamp and the accepted evidence's own
  // provider timestamp — null exactly when providerTimestampBucket is null.
  temporalDistanceMs: number | null
  verificationStatus: 'verified'
  acceptedAt: number
  expiresAt: number
}

export type AcceptedEvidenceKvLike = {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>
}

// ================================================================================================
// LEGACY PER-UNIT-AS-TOTAL MIGRATION, DISCLOSED (legacy-accepted-evidence-repair follow-up task).
//
// CONFIRMED PRE-1b3675a BUG, DISCLOSED: pnlReconciliation.ts's live recovery-lane writer used to
// persist `priceUsd: recoveredBuy` — the price source's raw PER-TOKEN unit price — while its OWN
// `valueUsd: recoveredBuy * lot.amount` field, computed at that exact same write from the exact same
// already-known lot amount, already held the CORRECT total side value. Every reader in this codebase
// (hydrateFromAcceptedEvidence, canonicalPnlSampleManifest.ts's own allocation call sites) uses
// `evidence.priceUsd` as the group's total — a legacy record's `priceUsd` is therefore silently
// wrong while its own `valueUsd` sibling field was right all along. `1b3675a` fixed the WRITER (new
// records now set `priceUsd === valueUsd`, both the true total) but never touched records already
// persisted under the old semantics — this migration repairs those, in place, on read.
//
// PROOF, NEVER A GUESS, DISCLOSED: "the stored value is tiny" is explicitly NOT sufficient proof — a
// genuinely tiny total (a dust-sized real trade) is not corruption. Repair requires BOTH:
//   1. PROVENANCE — the record's own shape matches the ONE writer that ever produced this bug: only
//      the live recovery lane ever wrote a per-lot (never per-group) record (`source ===
//      'recovery-lane'`, `coveredLotCount === 1` — the old writer's only possible shape; the
//      canonical-seeding writer has always set `priceUsd === valueUsd`, so no genuine post-fix or
//      canonical-seeding record can ever satisfy this proof).
//   2. SELF-CONSISTENCY — an exact, deterministic reconstruction: `priceUsd * lotAmount === valueUsd`
//      (within float tolerance). This is the "equally deterministic signature" the old writer's own
//      arithmetic already left behind — `valueUsd` was computed from the SAME provider call and the
//      SAME lot amount, at write time, so recomputing `priceUsd * amount` and finding it matches
//      `valueUsd` exactly is proof the record was written under the old per-unit semantics, not a
//      guess. A record whose `priceUsd * amount` does NOT reconcile to `valueUsd` (tampered data, or
//      a genuine, unrelated value disagreement) reports no proof and no reconstructed total — the
//      caller must treat it as ineligible for repair and fail closed, never coerce a value in.
// A record already written under the new semantics (`priceUsd === valueUsd`) always reports no proof
// — there is nothing to repair, whether or not the shared value happens to be small.
export type AcceptedEvidenceMigrationClassification = 'legacy_recovery_per_unit_total'

export type LegacyPerUnitTotalDetection = {
  legacyProof: AcceptedEvidenceMigrationClassification | null
  reconstructedTotalUsd: number | null
}

// PURE, DETERMINISTIC. `lotAmount` must be the CURRENT, real amount of the exact single lot this
// record's own `coveredLotCount: 1` scope refers to — the caller is responsible for only calling
// this when the record's declared scope (1 lot) still matches the live group's real composition
// (still exactly 1 lot); a group that has since grown beyond that scope is a genuinely different,
// unrelated question (composition drift) this function does not attempt to answer.
export function detectLegacyPerUnitTotalRecord(
  envelope: Pick<AcceptedEvidenceEnvelope, 'priceUsd' | 'valueUsd' | 'source' | 'coveredLotCount'>,
  lotAmount: number,
): LegacyPerUnitTotalDetection {
  const none: LegacyPerUnitTotalDetection = { legacyProof: null, reconstructedTotalUsd: null }
  // PROVENANCE, DISCLOSED: the old writer's ONE distinguishing shape — a per-lot recovery-lane write.
  if (envelope.source !== 'recovery-lane' || envelope.coveredLotCount !== 1) return none
  if (!Number.isFinite(envelope.priceUsd) || !Number.isFinite(envelope.valueUsd) || !Number.isFinite(lotAmount) || lotAmount <= 0) return none
  // Already the current (post-fix) shape — priceUsd IS the total, nothing to repair, regardless of
  // how small the shared value is.
  if (envelope.priceUsd === envelope.valueUsd) return none
  const expectedFromUnitPrice = envelope.priceUsd * lotAmount
  const tolerance = Math.max(1e-9, Math.abs(envelope.valueUsd) * 1e-9)
  const selfConsistent = Math.abs(expectedFromUnitPrice - envelope.valueUsd) <= tolerance
  if (!selfConsistent) return none
  if (envelope.valueUsd <= 0) return none
  return { legacyProof: 'legacy_recovery_per_unit_total', reconstructedTotalUsd: envelope.valueUsd }
}

export type AcceptedEvidenceState =
  | 'verified_valid'
  | 'partial_unverified'
  | 'invalid'
  | 'stale'
  | 'identity_mismatch'
  | 'missing_metadata'
  | 'absent'

export type InvalidAcceptedEvidenceReason =
  | 'missingSourceQuality'
  | 'unverifiedSource'
  | 'invalidPrice'
  | 'missingTimestamp'
  | 'temporalMismatch'
  | 'identityMismatch'
  | 'missingSchemaMetadata'
  | 'other'

export type AcceptedEvidenceClassification = {
  state: AcceptedEvidenceState
  reason: InvalidAcceptedEvidenceReason | null
  envelope: AcceptedEvidenceEnvelope | null
}

// LOT IDENTITY VERSION, DISCLOSED: the same composite fields this codebase already uses for lot
// equality elsewhere (pnlReconciliation.ts's own `lotKey`, scanDeterminismAudit.ts's
// `lotIdentityKey`) plus `amount` — reused here for consistency, not reinvented.
export function lotIdentityVersion(lot: { chain: string; token: string; openedTxHash: string; closedTxHash: string; openedAt: number; closedAt: number; amount: number }): string {
  const canonicalAmount = Number.isFinite(lot.amount) ? Number(lot.amount.toFixed(12)).toString() : 'invalid'
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt, canonicalAmount].join(':')
}

// COVERAGE FINGERPRINT, DISCLOSED (accepted-evidence-raw-value-mutation follow-up task): a stable,
// order-independent identity of exactly which lots a writer aggregated into one side's total —
// every covered lot's own `lotIdentityVersion`, sorted before joining so array order can never
// change the fingerprint. Two aggregations covering the SAME NUMBER of lots can still be genuinely
// different sets (a different lot swapped in at the same count) — this is the actual identity check
// `coveredLotCount` alone cannot provide.
export function buildAcceptedEvidenceCoverageFingerprint(lots: readonly { chain: string; token: string; openedTxHash: string; closedTxHash: string; openedAt: number; closedAt: number; amount: number }[]): string {
  return lots.map((lot) => lotIdentityVersion(lot)).sort().join('|')
}

export function buildAcceptedEvidenceKey(identity: AcceptedEvidenceIdentity): string {
  return `v1:accepted-evidence:${identity.chain}:${identity.token.toLowerCase()}:${identity.txHash}:${identity.side}:${identity.timestamp}`
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// FAIL-CLOSED VALIDATION, DISCLOSED (requirement #4): every identity field must match EXACTLY —
// this is the ONLY invalidation logic this module has, and it is structural, never behavioral
// (never triggered by provider availability, cooldown state, or wall-clock time alone beyond the
// bounded TTL expiry itself).
export function isValidAcceptedEvidence(raw: unknown, expected: AcceptedEvidenceIdentity, now: number): raw is AcceptedEvidenceEnvelope {
  return classifyAcceptedEvidence(raw, expected, now).state === 'verified_valid'
}

/** The single fail-closed definition used by persistence, fast-path suppression and hydration. */
export function classifyAcceptedEvidence(raw: unknown, expected: AcceptedEvidenceIdentity, now: number): AcceptedEvidenceClassification {
  if (raw == null) return { state: 'absent', reason: null, envelope: null }
  if (typeof raw !== 'object') return { state: 'invalid', reason: 'other', envelope: null }
  const e = raw as Partial<AcceptedEvidenceEnvelope>
  if (!isFiniteNumber(e.schemaVersion) || typeof e.valueType !== 'string') return { state: 'missing_metadata', reason: 'missingSchemaMetadata', envelope: null }
  if (e.schemaVersion !== ACCEPTED_EVIDENCE_SCHEMA_VERSION) return { state: 'invalid', reason: 'missingSchemaMetadata', envelope: null }
  if (e.chain !== expected.chain || typeof e.token !== 'string' || e.token.toLowerCase() !== expected.token.toLowerCase()
    || e.txHash !== expected.txHash || e.side !== expected.side || e.lotIdentityVersion !== expected.lotIdentityVersion) {
    return { state: 'identity_mismatch', reason: 'identityMismatch', envelope: null }
  }
  if (!isFiniteNumber(e.timestamp)) return { state: 'missing_metadata', reason: 'missingTimestamp', envelope: null }
  if (e.timestamp !== expected.timestamp) return { state: 'identity_mismatch', reason: 'temporalMismatch', envelope: null }
  if (e.verificationStatus !== 'verified') return { state: 'partial_unverified', reason: 'unverifiedSource', envelope: null }
  if (typeof e.source !== 'string' || e.source.trim() === '' || typeof e.evidenceType !== 'string' || e.evidenceType.trim() === '') {
    return { state: 'missing_metadata', reason: 'missingSourceQuality', envelope: null }
  }
  if (!isFiniteNumber(e.priceUsd) || e.priceUsd <= 0 || !isFiniteNumber(e.valueUsd) || e.valueUsd <= 0) {
    return { state: 'invalid', reason: 'invalidPrice', envelope: null }
  }
  if (!isFiniteNumber(e.acceptedAt) || !isFiniteNumber(e.expiresAt)) return { state: 'missing_metadata', reason: 'missingSchemaMetadata', envelope: null }
  if (e.expiresAt <= now) return { state: 'stale', reason: 'other', envelope: null }
  return { state: 'verified_valid', reason: null, envelope: e as AcceptedEvidenceEnvelope }
}

// PARTIAL-FILL DISCOVERY READ, DISCLOSED, ADDITIVE (canonical-price-replay follow-up task).
// CONFIRMED MODELLING GAP THIS ADDRESSES: an accepted-evidence KEY is per (chain, token, txHash,
// side, timestamp) — it deliberately does NOT include `lotIdentityVersion` — but the envelope's
// validation DOES require an exact `lotIdentityVersion` match. When one buy tx is split across
// several FIFO lots (a real partial fill), every slice shares the same key while carrying a
// different lot-identity version (the version includes `amount`), so the seeding pass writes the
// key once per slice and only the LAST writer's version survives. A later strict read for any other
// slice then legitimately misses, even though the price evidence for that tx side is present and
// correct.
//
// This read exists purely so a caller can DISCOVER which lot-identity version actually backs a
// stored side, and record it. It validates every other identity field exactly as strictly as
// `isValidAcceptedEvidence` does — chain, token, txHash, side, timestamp, schemaVersion,
// verificationStatus, finite price, expiry — and relaxes NOTHING else. It is never a substitute for
// the strict read: the canonical-sample manifest uses this once at build time to record the backing
// version, then always reads strictly (version included) on every subsequent replay.
export function isValidAcceptedEvidenceIgnoringLotVersion(raw: unknown, expected: Omit<AcceptedEvidenceIdentity, 'lotIdentityVersion'>, now: number): raw is AcceptedEvidenceEnvelope {
  if (!raw || typeof raw !== 'object') return false
  const e = raw as Partial<AcceptedEvidenceEnvelope>
  if (typeof e.lotIdentityVersion !== 'string') return false
  return classifyAcceptedEvidence(raw, { ...expected, lotIdentityVersion: e.lotIdentityVersion }, now).state === 'verified_valid'
}

export async function readAcceptedEvidenceAnyLotVersion(
  kv: AcceptedEvidenceKvLike,
  identity: Omit<AcceptedEvidenceIdentity, 'lotIdentityVersion'>,
  now: number,
): Promise<AcceptedEvidenceEnvelope | null> {
  try {
    const raw = await kv.get<unknown>(buildAcceptedEvidenceKey({ ...identity, lotIdentityVersion: '' }))
    return isValidAcceptedEvidenceIgnoringLotVersion(raw, identity, now) ? raw : null
  } catch {
    return null
  }
}

// FAIL-OPEN ON I/O, FAIL-CLOSED ON CONTENT, DISCLOSED: a KV outage/timeout degrades to "no accepted
// evidence found" (never blocks or throws) — but any VALUE that IS returned is validated with zero
// tolerance; a corrupt or mismatched entry is treated exactly like a cache miss.
export async function readAcceptedEvidence(
  kv: AcceptedEvidenceKvLike,
  identity: AcceptedEvidenceIdentity,
  now: number,
): Promise<AcceptedEvidenceEnvelope | null> {
  try {
    const raw = await kv.get<unknown>(buildAcceptedEvidenceKey(identity))
    return isValidAcceptedEvidence(raw, identity, now) ? raw : null
  } catch {
    return null
  }
}

// AWAITED, DISCLOSED (requirement #5's "await or reliably flush all accepted-evidence writes before
// final scan completion"): returns a real boolean the caller can aggregate into
// acceptedEvidenceWriteSuccesses/Failures — never fire-and-forget, never silently swallowed.
export async function writeAcceptedEvidence(kv: AcceptedEvidenceKvLike, envelope: AcceptedEvidenceEnvelope): Promise<boolean> {
  try {
    await kv.set(buildAcceptedEvidenceKey(envelope), envelope, { ex: ACCEPTED_EVIDENCE_TTL_SECONDS })
    return true
  } catch {
    return false
  }
}

// BOUNDED-CONCURRENCY BATCH READ, DISCLOSED, ADDITIVE (canonical-manifest-fast-path follow-up task,
// Part C — confirmed perf issue: a manifest replay/pre-validation over N lots was issuing 2*N fully
// SEQUENTIAL `await`s, one per side, each a real KV round trip; for 26 manifest lots that is 52
// serial awaits, a real, measurable chunk of a 77s scan). Deduplicates by the exact identity tuple
// BEFORE issuing any read (a shared partial-fill group's side is fetched once, never once per
// sibling), runs up to `concurrency` reads in flight at a time (never unbounded fan-out against the
// KV backend), and returns a Map keyed by the SAME real KV key `buildAcceptedEvidenceKey` produces —
// so a caller can look up any of the original (possibly-duplicate) identities it asked for by
// re-deriving that same key. `anyLotVersion: true` on an identity dispatches to
// `readAcceptedEvidenceAnyLotVersion` (the relaxed discovery read) for that one entry; everything
// else uses the strict, exact-version `readAcceptedEvidence`. Every individual read already fails
// open to `null` on its own timeout/error (unchanged); this function adds no additional timeout of
// its own — bounding concurrency IS the batch-level time bound, since no more than `concurrency`
// reads are ever simultaneously in flight regardless of how many identities are requested.
export type AcceptedEvidenceBatchIdentity =
  | (AcceptedEvidenceIdentity & { anyLotVersion?: false })
  | (Omit<AcceptedEvidenceIdentity, 'lotIdentityVersion'> & { anyLotVersion: true })

export type AcceptedEvidenceBatchResult = {
  byKey: Map<string, AcceptedEvidenceEnvelope | null>
  keysRequested: number
  uniqueKeysRead: number
  elapsedMs: number
}

const DEFAULT_BATCH_READ_CONCURRENCY = 8

export async function readAcceptedEvidenceBatch(
  kv: AcceptedEvidenceKvLike,
  identities: readonly AcceptedEvidenceBatchIdentity[],
  now: number,
  concurrency: number = DEFAULT_BATCH_READ_CONCURRENCY,
): Promise<AcceptedEvidenceBatchResult> {
  const start = Date.now()
  const uniqueByKey = new Map<string, AcceptedEvidenceBatchIdentity>()
  for (const identity of identities) {
    const key = buildAcceptedEvidenceKey('lotIdentityVersion' in identity && !identity.anyLotVersion ? identity : { ...identity, lotIdentityVersion: '' })
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, identity)
  }
  const entries = [...uniqueByKey.entries()]
  const byKey = new Map<string, AcceptedEvidenceEnvelope | null>()

  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= entries.length) return
      const [key, identity] = entries[index]
      // eslint-disable-next-line no-await-in-loop
      const envelope = identity.anyLotVersion
        ? await readAcceptedEvidenceAnyLotVersion(kv, identity, now)
        : await readAcceptedEvidence(kv, identity, now)
      byKey.set(key, envelope)
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, entries.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return { byKey, keysRequested: identities.length, uniqueKeysRead: entries.length, elapsedMs: Date.now() - start }
}

export function buildAcceptedEvidenceEnvelope(params: {
  identity: AcceptedEvidenceIdentity
  priceUsd: number
  valueUsd: number
  // Defaults to 'total_side_value_usd' — the only value this store's own writers actually produce
  // today (see this module's own header) — so existing callers that don't pass it explicitly still
  // persist an honest, correct tag rather than an omitted field.
  valueType?: AcceptedEvidenceValueType
  // Defaults to 1 — the conservative, honest default for a writer that only ever knows about a
  // single lot's own contribution to this side (e.g. the live recovery lane). A writer that
  // genuinely aggregated N siblings (the canonical seeding pass) must pass the real N explicitly —
  // see this envelope field's own header on `AcceptedEvidenceEnvelope`.
  coveredLotCount?: number
  // Defaults to the identity's own `lotIdentityVersion` — the correct fingerprint for a writer that
  // only ever knows about ONE lot (matches `coveredLotCount`'s own default of 1). A writer that
  // aggregated N siblings must pass the real, multi-lot fingerprint explicitly (see
  // `buildAcceptedEvidenceCoverageFingerprint`).
  coverageFingerprint?: string
  source: string
  evidenceType: string
  providerTimestampBucket: number | null
  now: number
}): AcceptedEvidenceEnvelope {
  return {
    ...params.identity,
    schemaVersion: ACCEPTED_EVIDENCE_SCHEMA_VERSION,
    priceUsd: params.priceUsd,
    valueUsd: params.valueUsd,
    valueType: params.valueType ?? 'total_side_value_usd',
    coveredLotCount: params.coveredLotCount ?? 1,
    coverageFingerprint: params.coverageFingerprint ?? params.identity.lotIdentityVersion,
    source: params.source,
    evidenceType: params.evidenceType,
    providerTimestampBucket: params.providerTimestampBucket,
    temporalDistanceMs: params.providerTimestampBucket === null ? null : Math.abs(params.identity.timestamp - params.providerTimestampBucket),
    verificationStatus: 'verified',
    acceptedAt: params.now,
    expiresAt: params.now + ACCEPTED_EVIDENCE_TTL_SECONDS * 1000,
  }
}

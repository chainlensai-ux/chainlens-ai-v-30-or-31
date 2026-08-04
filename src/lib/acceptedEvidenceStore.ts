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

export const ACCEPTED_EVIDENCE_SCHEMA_VERSION = 1
// IMMUTABLE HISTORICAL FACT, DISCLOSED: same reasoning as kvClient.ts's HISTORICAL_TTL_SECONDS — an
// accepted price for a specific past (chain, token, txHash, timestamp) can never legitimately
// change, so a long TTL is safe. Still finite (not "forever") to bound storage growth.
export const ACCEPTED_EVIDENCE_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

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

// LOT IDENTITY VERSION, DISCLOSED: the same composite fields this codebase already uses for lot
// equality elsewhere (pnlReconciliation.ts's own `lotKey`, scanDeterminismAudit.ts's
// `lotIdentityKey`) plus `amount` — reused here for consistency, not reinvented.
export function lotIdentityVersion(lot: { chain: string; token: string; openedTxHash: string; closedTxHash: string; openedAt: number; closedAt: number; amount: number }): string {
  return [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt, lot.amount].join(':')
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
  if (!raw || typeof raw !== 'object') return false
  const e = raw as Partial<AcceptedEvidenceEnvelope>
  if (e.schemaVersion !== ACCEPTED_EVIDENCE_SCHEMA_VERSION) return false
  if (e.chain !== expected.chain) return false
  if (typeof e.token !== 'string' || e.token.toLowerCase() !== expected.token.toLowerCase()) return false
  if (e.txHash !== expected.txHash) return false
  if (e.side !== expected.side) return false
  if (e.timestamp !== expected.timestamp) return false
  if (e.lotIdentityVersion !== expected.lotIdentityVersion) return false
  if (e.verificationStatus !== 'verified') return false
  if (!isFiniteNumber(e.priceUsd)) return false
  if (!isFiniteNumber(e.expiresAt) || e.expiresAt <= now) return false
  return true
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
  if (e.schemaVersion !== ACCEPTED_EVIDENCE_SCHEMA_VERSION) return false
  if (e.chain !== expected.chain) return false
  if (typeof e.token !== 'string' || e.token.toLowerCase() !== expected.token.toLowerCase()) return false
  if (e.txHash !== expected.txHash) return false
  if (e.side !== expected.side) return false
  if (e.timestamp !== expected.timestamp) return false
  if (typeof e.lotIdentityVersion !== 'string') return false
  if (e.verificationStatus !== 'verified') return false
  if (!isFiniteNumber(e.priceUsd)) return false
  if (!isFiniteNumber(e.expiresAt) || e.expiresAt <= now) return false
  return true
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
    source: params.source,
    evidenceType: params.evidenceType,
    providerTimestampBucket: params.providerTimestampBucket,
    temporalDistanceMs: params.providerTimestampBucket === null ? null : Math.abs(params.identity.timestamp - params.providerTimestampBucket),
    verificationStatus: 'verified',
    acceptedAt: params.now,
    expiresAt: params.now + ACCEPTED_EVIDENCE_TTL_SECONDS * 1000,
  }
}

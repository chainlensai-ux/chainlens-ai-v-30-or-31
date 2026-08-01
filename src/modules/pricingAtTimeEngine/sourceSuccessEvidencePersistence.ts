// MODULE — pricingAtTimeEngine: durable source-success evidence across serverless workers.
//
// WHY, DISCLOSED: sourceSuccessEvidence.ts's ledger is process-local. On Vercel, every cold start
// begins with an empty ledger, so the very first scan on a fresh worker scores every requirement at
// the deterministic 0.5 prior and learns nothing from the thousands of typed outcomes previous
// workers already observed. The evidence is real; it was simply being thrown away at the process
// boundary. This module carries the AGGREGATE COUNTERS — and only the aggregate counters — across
// that boundary.
//
// WHAT IS PERSISTED, DISCLOSED, EXHAUSTIVE: source, chain, token (a CONTRACT address), asset class,
// requirement type, typed outcome, success/failure counts, and lastUpdatedAt. Nothing else. There is
// no field in this module capable of holding a wallet address, a transaction hash, an amount, a PnL
// figure, a lot id, or a raw provider response — those values are not merely filtered at the
// serialization boundary, they never enter the ledger this module reads from in the first place
// (sourceSuccessEvidence.ts's recorder accepts only {chain, token, source, assetClass,
// requirementType, ok, reason}). The key grammar below is additionally validated on every write, so
// a future change that tried to smuggle one of those values into a key would fail closed rather than
// silently persist it. See assertPersistableLevelKey.
//
// COST, DISCLOSED: exactly ONE read round-trip and ONE batched write round-trip per scan, both
// pipelined. Never a per-requirement call, never a retry, and never a pricing-provider call of any
// kind — this module talks only to KV.
//
// FAIL-OPEN, DISCLOSED: every KV interaction is bounded by a strict timeout and wrapped so that any
// failure — timeout, missing credentials, malformed payload, KV outage — leaves the scan running on
// the deterministic default priors, exactly as if persistence had never been enabled. Scan
// correctness never depends on KV being reachable.
//
// CONCURRENCY, DISCLOSED: writes are per-field HINCRBY deltas, never read-modify-write. Two workers
// flushing overlapping evidence at the same instant both have their counts applied by the server;
// neither can clobber the other's. This is the specific reason counters are stored as hash fields
// incremented in place rather than as a serialized blob.

import { kv as realKv } from '@vercel/kv'
import type { PricingSourceName, PricingAssetClass, PricingRequirementType } from './sourceSuccessEvidence'

// ONE hash for all broad (non-token) evidence and ONE for token-level evidence, so a full load is
// two pipelined HGETALLs in a single round trip rather than N key reads.
export const AGGREGATE_HASH_KEY = 'v1:pricing-source-evidence:aggregate'
export const TOKEN_HASH_KEY = 'v1:pricing-source-evidence:token'

// RETENTION, DISCLOSED, ASYMMETRIC BY DESIGN. Broad source/class evidence describes a provider's
// behaviour for a whole asset class and stays true for a long time — it is the evidence most worth
// keeping and is retained far longer. Token-level evidence is the volatile part: a token with no
// pool today may have deep liquidity next week, so a stale token-level verdict is actively harmful
// and expires quickly. Broad evidence is never evicted by the token-level cap.
export const TOKEN_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const AGGREGATE_EVIDENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000

// KEY CAP, DISCLOSED: token-level evidence is the only unbounded dimension (one entry per contract
// ever priced), so it alone is capped. Eviction is fully deterministic — oldest lastUpdatedAt first,
// ties broken by level key — never random, never recency-sampled.
export const MAX_TOKEN_EVIDENCE_KEYS = 5000

// STRICT TIMEOUTS, DISCLOSED: a scan must never wait on KV. These are deliberately short — shorter
// than a single pricing provider call — because the entire value of the read is "start warm instead
// of cold", which is worthless if it costs latency.
export const EVIDENCE_READ_TIMEOUT_MS = 400
export const EVIDENCE_WRITE_TIMEOUT_MS = 600

export function isEvidencePersistenceEnabled(): boolean {
  return process.env.HISTORICAL_PRICING_EVIDENCE_PERSISTENCE_ENABLED === 'true'
}

// ---------------------------------------------------------------------------------------------
// Key grammar — the structural guarantee that no forbidden value can ever be serialized.
// ---------------------------------------------------------------------------------------------

const VALID_SOURCES: ReadonlySet<string> = new Set([
  'goldrush', 'dexscreener', 'geckoterminal', 'coingecko', 'base_dex', 'alchemy',
])
const VALID_ASSET_CLASSES: ReadonlySet<string> = new Set(['native', 'stable', 'other'])
const VALID_REQUIREMENT_TYPES: ReadonlySet<string> = new Set(['entry', 'exit', 'both', 'unranked'])
// A contract address, or the native pseudo-address. Exactly 40 hex characters — a transaction hash
// (64 hex characters) cannot match this pattern, so a tx hash can never occupy the token slot even
// if some future caller mistakenly passed one.
const TOKEN_PATTERN = /^0x[0-9a-f]{40}$/
const CHAIN_PATTERN = /^[a-z0-9_-]{1,20}$/

export const PERSISTED_COUNTER_FIELDS = ['attempts', 'successes', 'hardFailures'] as const
export type PersistedCounterField = typeof PERSISTED_COUNTER_FIELDS[number]
// The ONLY non-counter field ever written. Holds a millisecond timestamp — never an amount, never a
// price, never any wallet-derived value.
export const LAST_UPDATED_FIELD = 'lastUpdatedAt'

// PURE. Validates a level key against the exact, enumerated grammar sourceSuccessEvidence.ts
// produces. Returns false for anything else — the write path SKIPS such keys rather than persisting
// them, so an unrecognised key shape is dropped, never stored.
export function assertPersistableLevelKey(levelKey: string): boolean {
  const parts = levelKey.split('|')
  if (parts.length === 0 || parts.length > 4) return false

  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) return false
    const name = part.slice(0, eq)
    const value = part.slice(eq + 1)
    switch (name) {
      case 's': if (!VALID_SOURCES.has(value)) return false; break
      case 'c': if (!VALID_ASSET_CLASSES.has(value)) return false; break
      case 'r': if (!VALID_REQUIREMENT_TYPES.has(value)) return false; break
      case 'ch': if (!CHAIN_PATTERN.test(value)) return false; break
      case 't': if (!TOKEN_PATTERN.test(value)) return false; break
      // Any other dimension is unknown to this schema and is refused outright — this is the branch
      // that would reject a hypothetical future `w=<wallet>` or `tx=<hash>` key.
      default: return false
    }
  }
  // Every key must be anchored on a source; a key without one is not source-specific evidence.
  return parts[0].startsWith('s=')
}

export function isTokenLevelKey(levelKey: string): boolean {
  return levelKey.includes('|t=')
}

function fieldName(levelKey: string, field: string): string {
  return `${levelKey}#${field}`
}

function parseField(field: string): { levelKey: string; field: string } | null {
  const hash = field.lastIndexOf('#')
  if (hash <= 0) return null
  return { levelKey: field.slice(0, hash), field: field.slice(hash + 1) }
}

function toCount(value: unknown): number {
  // Upstash returns hash values as strings or numbers depending on codec — both are accepted, and
  // anything that is not a real, finite, non-negative integer is discarded rather than coerced.
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

// ---------------------------------------------------------------------------------------------
// KV surface — narrowly typed so tests can inject a fake without pulling in the real client.
// ---------------------------------------------------------------------------------------------

export type EvidencePipelineLike = {
  hgetall(key: string): unknown
  hincrby(key: string, field: string, increment: number): unknown
  hset(key: string, value: Record<string, unknown>): unknown
  hdel(key: string, ...fields: string[]): unknown
  expire(key: string, seconds: number): unknown
  exec(): Promise<unknown[]>
}

export type EvidenceKvLike = { pipeline(): EvidencePipelineLike }

function defaultKv(): EvidenceKvLike {
  return realKv as unknown as EvidenceKvLike
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('evidence_kv_timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------------------------

export type LoadedEvidence = {
  levelCounts: Map<string, { attempts: number; successes: number; hardFailures: number }>
  aggregateKeysLoaded: number
  tokenKeysLoaded: number
  timedOut: boolean
  // True when this load produced no usable evidence for ANY reason — disabled, timed out, empty
  // store, or unparseable payload — meaning the scan proceeds entirely on default priors.
  usedDefaultPriors: boolean
}

export function emptyLoadedEvidence(usedDefaultPriors = true): LoadedEvidence {
  return { levelCounts: new Map(), aggregateKeysLoaded: 0, tokenKeysLoaded: 0, timedOut: false, usedDefaultPriors }
}

// PURE. Rebuilds level counts from two raw hash payloads, dropping anything stale, malformed, or
// outside the key grammar. `now` is injected so TTL behaviour is directly testable and never depends
// on wall-clock timing during a test run.
export function decodeEvidenceHashes(
  aggregateHash: Record<string, unknown> | null,
  tokenHash: Record<string, unknown> | null,
  now: number,
): { levelCounts: Map<string, { attempts: number; successes: number; hardFailures: number }>; aggregateKeysLoaded: number; tokenKeysLoaded: number } {
  const levelCounts = new Map<string, { attempts: number; successes: number; hardFailures: number }>()

  // Token-level entries carry their own lastUpdatedAt and expire independently of the broad
  // evidence, so a stale token verdict is ignored while the source/class evidence built from the
  // same original observations is retained.
  const tokenLastUpdated = new Map<string, number>()
  for (const [field, value] of Object.entries(tokenHash ?? {})) {
    const parsed = parseField(field)
    if (parsed && parsed.field === LAST_UPDATED_FIELD) tokenLastUpdated.set(parsed.levelKey, toCount(value))
  }

  function ingest(hash: Record<string, unknown> | null, tokenScoped: boolean): number {
    const seen = new Set<string>()
    for (const [field, value] of Object.entries(hash ?? {})) {
      const parsed = parseField(field)
      if (!parsed) continue
      if (parsed.field === LAST_UPDATED_FIELD) continue
      if (!(PERSISTED_COUNTER_FIELDS as readonly string[]).includes(parsed.field)) continue
      if (!assertPersistableLevelKey(parsed.levelKey)) continue
      if (tokenScoped) {
        const updatedAt = tokenLastUpdated.get(parsed.levelKey) ?? 0
        if (updatedAt <= 0 || now - updatedAt > TOKEN_EVIDENCE_TTL_MS) continue
      }
      const counts = levelCounts.get(parsed.levelKey) ?? { attempts: 0, successes: 0, hardFailures: 0 }
      counts[parsed.field as PersistedCounterField] += toCount(value)
      levelCounts.set(parsed.levelKey, counts)
      seen.add(parsed.levelKey)
    }
    return seen.size
  }

  const aggregateKeysLoaded = ingest(aggregateHash, false)
  const tokenKeysLoaded = ingest(tokenHash, true)
  return { levelCounts, aggregateKeysLoaded, tokenKeysLoaded }
}

// ONE read round-trip. Fails open to default priors on any error — the caller never sees a rejection.
export async function loadPersistedEvidence(options: {
  kv?: EvidenceKvLike
  now?: number
  timeoutMs?: number
} = {}): Promise<LoadedEvidence> {
  if (!isEvidencePersistenceEnabled()) return emptyLoadedEvidence()

  const kv = options.kv ?? defaultKv()
  const now = options.now ?? Date.now()
  try {
    const pipeline = kv.pipeline()
    pipeline.hgetall(AGGREGATE_HASH_KEY)
    pipeline.hgetall(TOKEN_HASH_KEY)
    const results = await withTimeout(pipeline.exec(), options.timeoutMs ?? EVIDENCE_READ_TIMEOUT_MS)

    const aggregateHash = (results?.[0] ?? null) as Record<string, unknown> | null
    const tokenHash = (results?.[1] ?? null) as Record<string, unknown> | null
    const decoded = decodeEvidenceHashes(aggregateHash, tokenHash, now)

    return {
      levelCounts: decoded.levelCounts,
      aggregateKeysLoaded: decoded.aggregateKeysLoaded,
      tokenKeysLoaded: decoded.tokenKeysLoaded,
      timedOut: false,
      usedDefaultPriors: decoded.levelCounts.size === 0,
    }
  } catch (err) {
    const timedOut = err instanceof Error && err.message === 'evidence_kv_timeout'
    // eslint-disable-next-line no-console
    console.warn('[source-success-evidence] load failed, falling back to default priors', {
      timedOut, reason: err instanceof Error ? err.message : String(err),
    })
    return { ...emptyLoadedEvidence(true), timedOut }
  }
}

// ---------------------------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------------------------

export type EvidenceDelta = ReadonlyMap<string, { attempts: number; successes: number; hardFailures: number }>

export type FlushResult = { written: boolean; fieldsWritten: number; evictedTokenKeys: number; timedOut: boolean }

// PURE. Decides which token-level keys must be evicted to honour MAX_TOKEN_EVIDENCE_KEYS, given the
// keys already stored (with their lastUpdatedAt) and the keys this flush is about to add. Oldest
// first, ties broken by level key — the same inputs always produce the same eviction list.
export function planTokenEviction(
  existingTokenKeys: ReadonlyMap<string, number>,
  incomingTokenKeys: readonly string[],
  now: number,
  maxKeys: number = MAX_TOKEN_EVIDENCE_KEYS,
): string[] {
  const merged = new Map<string, number>(existingTokenKeys)
  for (const key of incomingTokenKeys) merged.set(key, now)
  if (merged.size <= maxKeys) return []

  const ordered = [...merged.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  return ordered.slice(0, merged.size - maxKeys).map(([key]) => key)
}

// ONE batched write round-trip. Every counter is applied as a per-field HINCRBY delta, so concurrent
// flushes from different workers add rather than overwrite and no count can be lost. Fails open —
// a write failure is logged and discarded; it never propagates into the scan.
export async function flushEvidenceDelta(
  delta: EvidenceDelta,
  options: {
    kv?: EvidenceKvLike
    now?: number
    timeoutMs?: number
    existingTokenKeys?: ReadonlyMap<string, number>
    maxTokenKeys?: number
  } = {},
): Promise<FlushResult> {
  if (!isEvidencePersistenceEnabled()) return { written: false, fieldsWritten: 0, evictedTokenKeys: 0, timedOut: false }
  if (delta.size === 0) return { written: false, fieldsWritten: 0, evictedTokenKeys: 0, timedOut: false }

  const kv = options.kv ?? defaultKv()
  const now = options.now ?? Date.now()

  try {
    const pipeline = kv.pipeline()
    let fieldsWritten = 0
    const incomingTokenKeys: string[] = []

    for (const [levelKey, counts] of [...delta.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      // GRAMMAR GATE, DISCLOSED: a key that does not match the enumerated schema is DROPPED, never
      // written. This is the structural guarantee referenced in this file's header.
      if (!assertPersistableLevelKey(levelKey)) continue
      const tokenScoped = isTokenLevelKey(levelKey)
      const hashKey = tokenScoped ? TOKEN_HASH_KEY : AGGREGATE_HASH_KEY

      for (const field of PERSISTED_COUNTER_FIELDS) {
        const increment = counts[field]
        if (increment <= 0) continue
        pipeline.hincrby(hashKey, fieldName(levelKey, field), increment)
        fieldsWritten += 1
      }
      if (tokenScoped) {
        pipeline.hset(TOKEN_HASH_KEY, { [fieldName(levelKey, LAST_UPDATED_FIELD)]: now })
        incomingTokenKeys.push(levelKey)
      }
    }

    if (fieldsWritten === 0) return { written: false, fieldsWritten: 0, evictedTokenKeys: 0, timedOut: false }

    // Deterministic eviction, batched into the SAME write — never a second round trip.
    const evicted = planTokenEviction(options.existingTokenKeys ?? new Map(), incomingTokenKeys, now, options.maxTokenKeys)
    if (evicted.length > 0) {
      const fields = evicted.flatMap((key) => [
        ...PERSISTED_COUNTER_FIELDS.map((f) => fieldName(key, f)),
        fieldName(key, LAST_UPDATED_FIELD),
      ])
      pipeline.hdel(TOKEN_HASH_KEY, ...fields)
    }

    // Whole-hash retention: token-level evidence expires far sooner than the broad source/class
    // evidence, which is deliberately retained much longer (see this file's RETENTION header).
    pipeline.expire(TOKEN_HASH_KEY, Math.floor(TOKEN_EVIDENCE_TTL_MS / 1000))
    pipeline.expire(AGGREGATE_HASH_KEY, Math.floor(AGGREGATE_EVIDENCE_TTL_MS / 1000))

    await withTimeout(pipeline.exec(), options.timeoutMs ?? EVIDENCE_WRITE_TIMEOUT_MS)
    return { written: true, fieldsWritten, evictedTokenKeys: evicted.length, timedOut: false }
  } catch (err) {
    const timedOut = err instanceof Error && err.message === 'evidence_kv_timeout'
    // eslint-disable-next-line no-console
    console.warn('[source-success-evidence] flush failed, evidence discarded for this scan', {
      timedOut, reason: err instanceof Error ? err.message : String(err),
    })
    return { written: false, fieldsWritten: 0, evictedTokenKeys: 0, timedOut }
  }
}

// ---------------------------------------------------------------------------------------------
// Diagnostic
// ---------------------------------------------------------------------------------------------

export type SourceSuccessEvidenceSummary = {
  persistenceEnabled: boolean
  evidenceLoadedBeforeScan: boolean
  evidenceRecordedThisScan: number
  aggregateKeysLoaded: number
  tokenKeysLoaded: number
  readTimedOut: boolean
  writeTimedOut: boolean
  usedDefaultPriors: boolean
  processInstanceId: string
}

// PROCESS INSTANCE ID, DISCLOSED: identifies THIS worker process in the diagnostic, so a cold start
// is directly visible as a new id paired with evidenceLoadedBeforeScan — the exact signal this whole
// feature exists to change. Generated once per process; carries no wallet, request or user identity.
const PROCESS_INSTANCE_ID = `pse-${Math.random().toString(36).slice(2, 10)}`

export function processInstanceId(): string {
  return PROCESS_INSTANCE_ID
}

export function buildEvidenceSummary(params: {
  loaded: LoadedEvidence
  flush: FlushResult
  evidenceRecordedThisScan: number
  processInstanceId: string
}): SourceSuccessEvidenceSummary {
  return {
    persistenceEnabled: isEvidencePersistenceEnabled(),
    evidenceLoadedBeforeScan: params.loaded.levelCounts.size > 0,
    evidenceRecordedThisScan: params.evidenceRecordedThisScan,
    aggregateKeysLoaded: params.loaded.aggregateKeysLoaded,
    tokenKeysLoaded: params.loaded.tokenKeysLoaded,
    readTimedOut: params.loaded.timedOut,
    writeTimedOut: params.flush.timedOut,
    usedDefaultPriors: params.loaded.usedDefaultPriors,
    processInstanceId: params.processInstanceId,
  }
}

// Unused-import guards for the types this module's public surface references.
export type { PricingSourceName, PricingAssetClass, PricingRequirementType }

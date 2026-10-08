// ROBINHOOD VERIFIED-SWAP CANDIDATE MANIFEST.
//
// A per-wallet list of tx hashes that a previous scan's unchanged verifier accepted as an exact wallet swap
// (direct_wallet_swap / direct_mixed_route_proven / relayed_wallet_swap_proven). It is ONLY a candidate hint:
// "this tx produced exact positive proof before — include it in the next bounded receipt sample". Nothing here
// is acceptance, a classifier result, an amount or a price; every listed tx is re-fetched and re-verified from
// its current receipt (and exact native trace, where the verifier needs one) on every scan, and fails closed
// when that proof cannot be replayed.
//
// Storage: one Redis hash per wallet, one field per tx hash. Writes are field-level HSETs of the txs verified in
// this scan, so concurrent scans can only add/refresh fields — a stale scan can never erase a newer entry (no
// read-modify-overwrite of the whole manifest). Same KV client and bounded-timeout conventions as the native
// trace persistence (robinhoodNativeTracePersistence.ts). Nothing is ever deleted automatically.

import { kv as vercelKv } from '@vercel/kv'

export const ROBINHOOD_VERIFIED_SWAP_MANIFEST_PROOF_VERSION = 1
/** Fields one wallet's manifest may hold; new hashes beyond this are not added (existing ones still refresh). */
export const ROBINHOOD_VERIFIED_SWAP_MANIFEST_MAX_ENTRIES = 64
const READ_TIMEOUT_MS = 800
const WRITE_TIMEOUT_MS = 1_500

export type RobinhoodVerifiedSwapManifestEntry = {
  txHash: string
  blockNumber: number | null
  timestampMs: number | null
  firstVerifiedAt: number
  lastVerifiedAt: number
  proofVersion: number
}

type ManifestKv = Pick<typeof vercelKv, 'hgetall' | 'hset'>
let kvOverrideForTest: ManifestKv | null = null
export function __setRobinhoodVerifiedSwapManifestKvForTest(client: ManifestKv | null): void { kvOverrideForTest = client }

const TX_HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

export function robinhoodVerifiedSwapManifestKey(wallet: string): string {
  return `robinhood:verified-swap-manifest:v1:${wallet.toLowerCase()}`
}

function configured(): boolean {
  return kvOverrideForTest !== null || Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('verified_swap_manifest_kv_timeout')), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** PURE. A stored field is used only if it is exactly this schema and its key matches its own txHash. */
export function validateRobinhoodVerifiedSwapManifestEntry(raw: unknown, fieldTxHash: string): RobinhoodVerifiedSwapManifestEntry | null {
  const field = fieldTxHash.toLowerCase()
  if (!TX_HASH.test(field)) return null
  const value = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return null } })() : raw
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.txHash !== field || r.proofVersion !== ROBINHOOD_VERIFIED_SWAP_MANIFEST_PROOF_VERSION) return null
  if (r.blockNumber !== null && !nonNegInt(r.blockNumber)) return null
  if (r.timestampMs !== null && !nonNegInt(r.timestampMs)) return null
  if (!nonNegInt(r.firstVerifiedAt) || !nonNegInt(r.lastVerifiedAt)) return null
  return {
    txHash: field, blockNumber: r.blockNumber as number | null, timestampMs: r.timestampMs as number | null,
    firstVerifiedAt: r.firstVerifiedAt, lastVerifiedAt: r.lastVerifiedAt, proofVersion: ROBINHOOD_VERIFIED_SWAP_MANIFEST_PROOF_VERSION,
  }
}

/** PURE. blockNumber DESC (known first), then timestampMs DESC (known first), then txHash ASC. */
export function orderRobinhoodVerifiedSwapManifest(entries: readonly RobinhoodVerifiedSwapManifestEntry[]): RobinhoodVerifiedSwapManifestEntry[] {
  return [...entries].sort((a, b) =>
    (b.blockNumber ?? -1) - (a.blockNumber ?? -1) || (b.timestampMs ?? -1) - (a.timestampMs ?? -1) || a.txHash.localeCompare(b.txHash))
}

export type RobinhoodVerifiedSwapManifestRead = { entries: RobinhoodVerifiedSwapManifestEntry[]; reason: string | null; invalidEntries: number }

export async function readRobinhoodVerifiedSwapManifest(wallet: string): Promise<RobinhoodVerifiedSwapManifestRead> {
  const w = wallet.toLowerCase()
  if (!ADDRESS.test(w)) return { entries: [], reason: 'invalid_wallet', invalidEntries: 0 }
  if (!configured()) return { entries: [], reason: 'kv_not_configured', invalidEntries: 0 }
  try {
    const raw = await bounded((kvOverrideForTest ?? vercelKv).hgetall<Record<string, unknown>>(robinhoodVerifiedSwapManifestKey(w)), READ_TIMEOUT_MS)
    if (!raw) return { entries: [], reason: 'manifest_absent', invalidEntries: 0 }
    const entries: RobinhoodVerifiedSwapManifestEntry[] = []
    let invalidEntries = 0
    for (const [field, value] of Object.entries(raw)) {
      const e = validateRobinhoodVerifiedSwapManifestEntry(value, field)
      if (e) entries.push(e); else invalidEntries += 1
    }
    return { entries: orderRobinhoodVerifiedSwapManifest(entries), reason: entries.length ? null : 'manifest_empty', invalidEntries }
  } catch {
    return { entries: [], reason: 'manifest_lookup_failed', invalidEntries: 0 }
  }
}

export type RobinhoodVerifiedSwapManifestVerified = { txHash: string; blockNumber: number | null; timestampMs: number | null }
export type RobinhoodVerifiedSwapManifestWrite = { written: number; skippedOverCap: number; writeFailed: boolean; reason: string | null }

/**
 * Additive, idempotent: one HSET of the txs this scan's verifier accepted. `known` is the manifest this scan read
 * (keeps firstVerifiedAt and bounds growth); fields absent from it are only added while under the entry cap.
 */
export async function recordRobinhoodVerifiedSwaps(
  wallet: string, verified: readonly RobinhoodVerifiedSwapManifestVerified[], known: readonly RobinhoodVerifiedSwapManifestEntry[], now: number,
): Promise<RobinhoodVerifiedSwapManifestWrite> {
  const w = wallet.toLowerCase()
  if (!ADDRESS.test(w)) return { written: 0, skippedOverCap: 0, writeFailed: false, reason: 'invalid_wallet' }
  if (!configured()) return { written: 0, skippedOverCap: 0, writeFailed: false, reason: 'kv_not_configured' }
  const prior = new Map(known.map((e) => [e.txHash, e]))
  let room = Math.max(0, ROBINHOOD_VERIFIED_SWAP_MANIFEST_MAX_ENTRIES - prior.size)
  let skippedOverCap = 0
  const fields: Record<string, string> = {}
  for (const v of verified) {
    const h = v.txHash.toLowerCase()
    if (!TX_HASH.test(h) || fields[h]) continue
    const old = prior.get(h)
    if (!old) { if (room === 0) { skippedOverCap += 1; continue } room -= 1 }
    const entry: RobinhoodVerifiedSwapManifestEntry = {
      txHash: h,
      blockNumber: nonNegInt(v.blockNumber) ? v.blockNumber : old?.blockNumber ?? null,
      timestampMs: nonNegInt(v.timestampMs) ? v.timestampMs : old?.timestampMs ?? null,
      firstVerifiedAt: old?.firstVerifiedAt ?? now,
      lastVerifiedAt: now,
      proofVersion: ROBINHOOD_VERIFIED_SWAP_MANIFEST_PROOF_VERSION,
    }
    fields[h] = JSON.stringify(entry)
  }
  const count = Object.keys(fields).length
  if (count === 0) return { written: 0, skippedOverCap, writeFailed: false, reason: skippedOverCap ? 'manifest_full' : 'nothing_verified' }
  try {
    await bounded((kvOverrideForTest ?? vercelKv).hset(robinhoodVerifiedSwapManifestKey(w), fields), WRITE_TIMEOUT_MS)
    return { written: count, skippedOverCap, writeFailed: false, reason: null }
  } catch {
    return { written: 0, skippedOverCap, writeFailed: true, reason: 'manifest_write_failed' }
  }
}

// ── Manifest bootstrap (empty manifest → bounded, resumable historical discovery) ─────────────────────────────
//
// Discovery reads the wallet's paginated Blockscout ERC-20 transfers. A row is ONLY a candidate hint: the tx is
// re-fetched and run through the unchanged verifier like any other candidate, and only a current-scan acceptance
// is written to the manifest. The marker persists the resume cursor so each scan continues where the last one
// stopped (never page 1 again), bounded per scan and per wallet lifetime. Once started, a bootstrap keeps resuming
// even after the manifest gains entries, until history is exhausted, the lifetime page cap is hit, or the marker
// completes. Hint rows that were found but not yet tried wait in a bounded `pending` list.

export const ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS = {
  maxPagesPerScan: 4,
  maxPagesLifetime: 12,
  deadlineMs: 4_000,
  maxCandidatesPerScan: 8,
  maxPending: 64,
  /** A pending hint whose proof was transiently unavailable is retried this many times in total. */
  maxAttempts: 3,
  /**
   * Consecutive scans whose discovery failed before any page succeeded (timeout / 429 / 5xx / transport / malformed).
   * Transient failures NEVER complete the marker; from this many on, discovery pauses for a bounded, growing cooldown
   * and then retries from the saved cursor.
   */
  maxConsecutiveFailures: 3,
  failureCooldownBaseMs: 15 * 60_000,
  failureCooldownMaxMs: 6 * 60 * 60_000,
  /** Hints already decided (verified / rejected / out of attempts): never re-added by a merge or a later page. */
  maxRetired: 640,
} as const

export type RobinhoodBootstrapTransferRow = {
  txHash: string
  blockNumber: number | null
  timestampMs: number | null
  token: string | null
  /** The wallet's counterparty on this transfer is the V4 PoolManager — a structural hint, never proof. */
  poolManagerCounterparty: boolean
}
export type RobinhoodBootstrapDiscovery = {
  rows: RobinhoodBootstrapTransferRow[]
  pagesRequested: number
  pagesSucceeded: number
  rowsScanned: number
  /** Cursor to resume from: advanced only past pages that succeeded; null once history is exhausted. */
  nextCursor: string | null
  exhausted: boolean
  stopReason: string
}
export type RobinhoodBootstrapPending = { txHash: string; blockNumber: number | null; poolManagerCounterparty: boolean; attempts: number }
export type RobinhoodManifestBootstrapMarker = {
  schemaVersion: 1
  wallet: string
  cursor: string | null
  pagesScanned: number
  rowsScanned: number
  /** Discovery is finished (exhausted / lifetime cap / unrecoverable cursor / repeated failures). */
  discoveryDone: boolean
  completed: boolean
  completedAt: number | null
  stopReason: string | null
  updatedAt: number
  consecutiveFailures: number
  /** Discovery retry backoff after repeated transient failures (null = not paused). Never a completion. */
  pausedUntil: number | null
  pending: RobinhoodBootstrapPending[]
  /** Tombstones for decided hints, so a concurrent writer's stale `pending` can never bring one back. */
  retired: string[]
  /** Compare-and-set version: every stored write increments it; a write against a stale version is retried. */
  version: number
}

type MarkerKv = Pick<typeof vercelKv, 'get' | 'eval'>
/**
 * Atomic compare-and-set on the marker's `version` (Upstash stores string values raw, so the JSON is decodable here).
 * A missing key, or a stored value without a numeric version, is version 0.
 */
export const ROBINHOOD_MANIFEST_BOOTSTRAP_CAS_SCRIPT = `local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then
  local ok, d = pcall(cjson.decode, cur)
  if ok and type(d) == 'table' and type(d.version) == 'number' then v = d.version end
end
if v ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`
const MARKER_CAS_ATTEMPTS = 4
let markerKvOverrideForTest: MarkerKv | null = null
export function __setRobinhoodManifestBootstrapKvForTest(client: MarkerKv | null): void { markerKvOverrideForTest = client }
const markerConfigured = () => markerKvOverrideForTest !== null || Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)

export function robinhoodManifestBootstrapKey(wallet: string): string {
  return `robinhood:verified-swap-manifest-bootstrap:v1:${wallet.toLowerCase()}`
}

const nullableBlock = (v: unknown) => v === null || nonNegInt(v)

/** PURE. A stored marker is used only if it is exactly this schema for this wallet. */
export function validateRobinhoodManifestBootstrapMarker(raw: unknown, wallet: string): RobinhoodManifestBootstrapMarker | null {
  const value = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return null } })() : raw
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== 1 || r.wallet !== wallet.toLowerCase()) return null
  if (r.cursor !== null && (typeof r.cursor !== 'string' || !/^[A-Za-z0-9_.~%=&+-]{1,512}$/.test(r.cursor))) return null
  if (!nonNegInt(r.pagesScanned) || !nonNegInt(r.rowsScanned) || !nonNegInt(r.updatedAt) || !nonNegInt(r.consecutiveFailures)) return null
  if (typeof r.discoveryDone !== 'boolean' || typeof r.completed !== 'boolean') return null
  if (r.completedAt !== null && !nonNegInt(r.completedAt)) return null
  if (r.stopReason !== null && typeof r.stopReason !== 'string') return null
  if (!Array.isArray(r.pending) || r.pending.length > ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS.maxPending) return null
  for (const p of r.pending) {
    if (!p || typeof p !== 'object') return null
    const x = p as Record<string, unknown>
    if (typeof x.txHash !== 'string' || !TX_HASH.test(x.txHash) || !nullableBlock(x.blockNumber) || typeof x.poolManagerCounterparty !== 'boolean' || !nonNegInt(x.attempts)) return null
  }
  // `retired` is absent on markers written before it existed: read as none.
  const retired = r.retired === undefined ? [] : r.retired
  if (!Array.isArray(retired) || retired.length > ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS.maxRetired || retired.some((h) => typeof h !== 'string' || !TX_HASH.test(h))) return null
  // `version` is absent on markers written before compare-and-set existed: read as 0.
  const version = r.version === undefined ? 0 : r.version
  if (!nonNegInt(version)) return null
  // `pausedUntil` is absent on markers written before the failure backoff existed: read as not paused.
  const pausedUntil = r.pausedUntil === undefined ? null : r.pausedUntil
  if (pausedUntil !== null && !nonNegInt(pausedUntil)) return null
  // Markers that earlier code closed with `failure_cap` were closed by transient provider failures, not a terminal
  // discovery condition: reopen them (cursor/progress/pending kept) so the bootstrap retries from where it was.
  if (r.stopReason === 'failure_cap') {
    return { ...(r as RobinhoodManifestBootstrapMarker), retired: retired as string[], version, pausedUntil: null, discoveryDone: false, completed: false, completedAt: null, stopReason: 'failure_cap_reopened' }
  }
  return { ...(r as RobinhoodManifestBootstrapMarker), retired: retired as string[], version, pausedUntil }
}

/**
 * PURE. Merge two markers for the same wallet so no writer's progress is lost: furthest page progress wins the cursor
 * (a finished discovery wins a tie), counters take the max, done/completed are sticky, `retired` is unioned, and
 * `pending` is the union by txHash (max attempts, ORed PoolManager flag, best known block) minus anything retired.
 */
export function mergeRobinhoodManifestBootstrapMarkers(stored: RobinhoodManifestBootstrapMarker, proposed: RobinhoodManifestBootstrapMarker): RobinhoodManifestBootstrapMarker {
  const L = ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS
  const furthest = stored.pagesScanned > proposed.pagesScanned ? stored
    : proposed.pagesScanned > stored.pagesScanned ? proposed
      : stored.discoveryDone && !proposed.discoveryDone ? stored : proposed
  const retired = [...new Set([...stored.retired, ...proposed.retired])].sort().slice(-L.maxRetired)
  const gone = new Set(retired)
  const byHash = new Map<string, RobinhoodBootstrapPending>()
  for (const p of [...stored.pending, ...proposed.pending]) {
    if (gone.has(p.txHash)) continue
    const o = byHash.get(p.txHash)
    byHash.set(p.txHash, o ? {
      txHash: p.txHash,
      attempts: Math.max(o.attempts, p.attempts),
      poolManagerCounterparty: o.poolManagerCounterparty || p.poolManagerCounterparty,
      blockNumber: o.blockNumber == null ? p.blockNumber : p.blockNumber == null ? o.blockNumber : Math.max(o.blockNumber, p.blockNumber),
    } : { ...p })
  }
  const completed = stored.completed || proposed.completed
  const completedAts = [stored.completedAt, proposed.completedAt].filter((v): v is number => v != null)
  return {
    schemaVersion: 1, wallet: proposed.wallet,
    cursor: furthest.cursor,
    pagesScanned: Math.max(stored.pagesScanned, proposed.pagesScanned),
    rowsScanned: Math.max(stored.rowsScanned, proposed.rowsScanned),
    discoveryDone: stored.discoveryDone || proposed.discoveryDone,
    completed,
    completedAt: completed ? (completedAts.length ? Math.min(...completedAts) : Math.max(stored.updatedAt, proposed.updatedAt)) : null,
    stopReason: stored.discoveryDone && !proposed.discoveryDone ? stored.stopReason : furthest.stopReason,
    updatedAt: Math.max(stored.updatedAt, proposed.updatedAt),
    // Failure/backoff state: a strictly further page advance is authoritative (a successful page resets both); at
    // equal page progress a stale writer must never shorten or clear a newer cooldown.
    ...(stored.pagesScanned !== proposed.pagesScanned
      ? { consecutiveFailures: furthest.consecutiveFailures, pausedUntil: furthest.pausedUntil }
      : {
          consecutiveFailures: Math.max(stored.consecutiveFailures, proposed.consecutiveFailures),
          pausedUntil: stored.pausedUntil == null ? proposed.pausedUntil : proposed.pausedUntil == null ? stored.pausedUntil : Math.max(stored.pausedUntil, proposed.pausedUntil),
        }),
    pending: rankRobinhoodBootstrapPending([...byHash.values()]).slice(0, L.maxPending),
    retired,
    version: Math.max(stored.version, proposed.version),
  }
}

export async function readRobinhoodManifestBootstrapMarker(wallet: string): Promise<{ marker: RobinhoodManifestBootstrapMarker | null; reason: string | null }> {
  const w = wallet.toLowerCase()
  if (!ADDRESS.test(w)) return { marker: null, reason: 'invalid_wallet' }
  if (!markerConfigured()) return { marker: null, reason: 'kv_not_configured' }
  try {
    const raw = await bounded((markerKvOverrideForTest ?? vercelKv).get<unknown>(robinhoodManifestBootstrapKey(w)), READ_TIMEOUT_MS)
    if (raw == null) return { marker: null, reason: 'marker_absent' }
    const marker = validateRobinhoodManifestBootstrapMarker(raw, w)
    return marker ? { marker, reason: null } : { marker: null, reason: 'invalid_marker' }
  } catch {
    return { marker: null, reason: 'marker_lookup_failed' }
  }
}

/**
 * Merge + atomic compare-and-set: read the stored marker, merge the proposal into it
 * (mergeRobinhoodManifestBootstrapMarkers), and SET only if the stored version is still the one read; on a conflict
 * re-read and merge again (bounded). A concurrent or stale writer — even at the same page count — therefore never
 * erases another scan's cursor progress, pending hints, attempts, tombstones or completion.
 */
export async function writeRobinhoodManifestBootstrapMarker(wallet: string, marker: RobinhoodManifestBootstrapMarker): Promise<{ written: boolean; reason: string | null }> {
  const w = wallet.toLowerCase()
  const proposed = validateRobinhoodManifestBootstrapMarker(marker, w)
  if (!proposed) return { written: false, reason: 'invalid_marker' }
  if (!markerConfigured()) return { written: false, reason: 'kv_not_configured' }
  const client = markerKvOverrideForTest ?? vercelKv
  const key = robinhoodManifestBootstrapKey(w)
  try {
    for (let attempt = 1; attempt <= MARKER_CAS_ATTEMPTS; attempt++) {
      const raw = await bounded(client.get<unknown>(key), READ_TIMEOUT_MS)
      const rawObj = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return null } })() : raw
      const expected = rawObj && typeof rawObj === 'object' && nonNegInt((rawObj as Record<string, unknown>).version) ? (rawObj as { version: number }).version : 0
      const stored = validateRobinhoodManifestBootstrapMarker(raw, w)
      const merged = stored ? mergeRobinhoodManifestBootstrapMarkers(stored, proposed) : proposed
      const next = { ...merged, version: expected + 1 }
      const ok = await bounded(client.eval<[string, string], number>(ROBINHOOD_MANIFEST_BOOTSTRAP_CAS_SCRIPT, [key], [String(expected), JSON.stringify(next)]), WRITE_TIMEOUT_MS)
      if (Number(ok) === 1) return { written: true, reason: stored ? 'merged_with_stored' : null }
    }
    return { written: false, reason: 'marker_cas_conflict' }
  } catch {
    return { written: false, reason: 'marker_write_failed' }
  }
}

export function newRobinhoodManifestBootstrapMarker(wallet: string, now: number): RobinhoodManifestBootstrapMarker {
  return { schemaVersion: 1, wallet: wallet.toLowerCase(), cursor: null, pagesScanned: 0, rowsScanned: 0, discoveryDone: false, completed: false, completedAt: null, stopReason: null, updatedAt: now, consecutiveFailures: 0, pausedUntil: null, pending: [], retired: [], version: 0 }
}

/** PURE. PoolManager counterparty first, then blockNumber DESC (known first), then txHash ASC. */
export function rankRobinhoodBootstrapPending(pending: readonly RobinhoodBootstrapPending[]): RobinhoodBootstrapPending[] {
  return [...pending].sort((a, b) => Number(b.poolManagerCounterparty) - Number(a.poolManagerCounterparty)
    || (b.blockNumber ?? -1) - (a.blockNumber ?? -1) || a.txHash.localeCompare(b.txHash))
}

/** PURE. Folds one discovery pass into the marker: cursor/pages/rows, stop state, and the deduped pending hints. */
export function advanceRobinhoodManifestBootstrapMarker(
  prev: RobinhoodManifestBootstrapMarker, discovery: RobinhoodBootstrapDiscovery | null, exclude: ReadonlySet<string>, now: number,
): RobinhoodManifestBootstrapMarker {
  const L = ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS
  const next: RobinhoodManifestBootstrapMarker = { ...prev, pending: prev.pending.map((p) => ({ ...p })), retired: [...(prev.retired ?? [])], updatedAt: now }
  const retired = new Set(next.retired)
  if (discovery) {
    if (discovery.pagesSucceeded > 0) {
      next.cursor = discovery.nextCursor
      next.pagesScanned = prev.pagesScanned + discovery.pagesSucceeded
      next.rowsScanned = prev.rowsScanned + discovery.rowsScanned
      next.consecutiveFailures = 0
      next.pausedUntil = null
    }
    const failedBeforeAnyPage = discovery.pagesSucceeded === 0 && !discovery.exhausted
    if (failedBeforeAnyPage && discovery.stopReason !== 'page_cap') {
      // Transient: keep cursor / progress / pending, count it, and back off once repeated — never complete.
      next.consecutiveFailures = prev.consecutiveFailures + 1
      if (next.consecutiveFailures >= L.maxConsecutiveFailures) {
        const exp = Math.min(next.consecutiveFailures - L.maxConsecutiveFailures, 10)
        next.pausedUntil = now + Math.min(L.failureCooldownMaxMs, L.failureCooldownBaseMs * 2 ** exp)
      }
    }
    next.stopReason = discovery.stopReason
    // Only terminal discovery conditions finish discovery: exhausted history, the lifetime page cap, or a
    // deterministic cursor the provider handed back that can never be followed.
    if (discovery.exhausted) { next.discoveryDone = true; next.stopReason = 'history_exhausted' }
    else if (discovery.stopReason === 'repeated_cursor' || discovery.stopReason === 'invalid_cursor') next.discoveryDone = true
    else if (next.pagesScanned >= L.maxPagesLifetime) { next.discoveryDone = true; next.stopReason = 'lifetime_page_cap' }
    const byHash = new Map(next.pending.map((p) => [p.txHash, p]))
    for (const row of discovery.rows) {
      if (exclude.has(row.txHash) || retired.has(row.txHash)) continue
      const old = byHash.get(row.txHash)
      byHash.set(row.txHash, old
        ? { ...old, poolManagerCounterparty: old.poolManagerCounterparty || row.poolManagerCounterparty, blockNumber: old.blockNumber ?? row.blockNumber }
        : { txHash: row.txHash, blockNumber: row.blockNumber, poolManagerCounterparty: row.poolManagerCounterparty, attempts: 0 })
    }
    next.pending = rankRobinhoodBootstrapPending([...byHash.values()]).slice(0, L.maxPending)
  }
  next.pending = next.pending.filter((p) => !exclude.has(p.txHash))
  return next
}

export type RobinhoodBootstrapCandidateResult = 'verified' | 'rejected' | 'receipt_unavailable' | 'trace_unavailable'

/** PURE. After verification: a decided hint leaves `pending`; a transiently unprovable one is retried (bounded). */
export function settleRobinhoodManifestBootstrapMarker(
  marker: RobinhoodManifestBootstrapMarker, results: ReadonlyMap<string, RobinhoodBootstrapCandidateResult>, now: number,
): RobinhoodManifestBootstrapMarker {
  const pending: RobinhoodBootstrapPending[] = []
  const retired = [...(marker.retired ?? [])]
  for (const p of marker.pending) {
    const r = results.get(p.txHash)
    if (!r) { pending.push(p); continue }
    const attempts = p.attempts + 1
    if (r === 'verified' || r === 'rejected' || attempts >= ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS.maxAttempts) { retired.push(p.txHash); continue }
    pending.push({ ...p, attempts })
  }
  const completed = marker.discoveryDone && pending.length === 0
  return {
    ...marker, pending, retired: [...new Set(retired)].sort().slice(-ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS.maxRetired),
    completed, completedAt: completed ? (marker.completedAt ?? now) : null, updatedAt: now,
  }
}

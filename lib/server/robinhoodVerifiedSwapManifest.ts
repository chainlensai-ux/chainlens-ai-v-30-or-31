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

// MODULE — diffEvidenceLoader (wallet-scanner speed audit task).
//
// PURPOSE, DISCLOSED: this is a pure EXTRACTION of the accepted-evidence load that
// `src/pipeline/index.ts`'s canonical-PnL diff audit already performed inline, with two mechanical
// changes that provably cannot alter its output:
//
//   1. SEQUENTIAL -> BOUNDED-CONCURRENT READS. The inline version awaited one KV read per key
//      INSIDE a `for` loop (it carried its own `eslint-disable no-await-in-loop`), so a wallet whose
//      two manifest snapshots reference N unique evidence keys paid N FULLY SERIAL KV round trips
//      before the scan could continue — for the 98-lot regression wallet that is ~196 keys per
//      snapshot, and this audit unions BOTH snapshots. The reads are independent, read-only, and
//      already deduplicated by key, so they are issued with the SAME bounded worker pool
//      (`DIFF_EVIDENCE_CONCURRENCY`, matching replayManifest's own `BATCH_CONCURRENCY`) this
//      codebase already uses for exactly this kind of per-key evidence batch load.
//
//   2. O(n^2) OWNER SCAN -> ONE-PASS INDEX. The inline version ran `records.find(...)` per key
//      (a full array scan each time). The index below is built in a single pass and resolves each
//      key in O(1). FIRST-MATCH SEMANTICS ARE PRESERVED EXACTLY: the index only sets a key the
//      first time it is seen while iterating `records` in their given order, which is precisely
//      what `Array.prototype.find` returned.
//
// OUTPUT IS BYTE-IDENTICAL, DISCLOSED: results are collected concurrently but the returned Map is
// populated by iterating the ORIGINAL `keys` array in order, so both the entry set AND the Map's
// own insertion order match the previous sequential implementation exactly — no caller needs to
// reason about whether it iterates this Map or only `.get()`s from it. A key with no owning record
// is skipped entirely (absent from the Map), the same `continue` the inline loop performed; a key
// whose evidence is genuinely absent is recorded as an explicit `null`, never omitted and never
// fabricated.
//
// ERROR PATH, DISCLOSED: a throwing loader still rejects, exactly as before, and the caller's own
// try/catch still degrades the whole diagnostic. The ONLY observable difference is that up to
// `concurrency - 1` sibling reads may already be in flight when the first rejection happens — reads
// that are read-only and whose results are discarded. No output, no published value, and no
// write path is reachable from here.

import type { AcceptedEvidenceLoader } from '../lib/canonicalPnlSampleManifest'

export const DIFF_EVIDENCE_CONCURRENCY = 8

// The exact accepted-evidence fields the canonical-PnL diff audit consumes — never the whole
// envelope, so nothing else can accidentally start depending on this diagnostic's read.
export type DiffEvidenceSideTotals = { priceUsd: number; valueUsd: number; schemaVersion: number }

// Structurally the subset of CanonicalManifestLotRecord this loader actually reads. Kept as its own
// shape (rather than importing the full record type) so a future record-schema change cannot
// silently widen what this diagnostic depends on.
export type DiffEvidenceOwnerRecord = {
  chain: string
  token: string
  openedTxHash: string
  closedTxHash: string
  openedAt: number
  closedAt: number
  entryEvidenceKey: string
  exitEvidenceKey: string
}

type ResolvedOwner = { record: DiffEvidenceOwnerRecord; side: 'entry' | 'exit' }

// FIRST-WINS INDEX, DISCLOSED: reproduces `records.find(r => r.entryEvidenceKey === key ||
// r.exitEvidenceKey === key)` for every key, in one pass instead of one scan per key. A record's
// entry side is checked before its exit side for the SAME record, matching the original predicate's
// own `||` short-circuit order.
export function buildDiffEvidenceOwnerIndex(
  records: readonly DiffEvidenceOwnerRecord[],
): Map<string, ResolvedOwner> {
  const byKey = new Map<string, ResolvedOwner>()
  for (const record of records) {
    if (!byKey.has(record.entryEvidenceKey)) byKey.set(record.entryEvidenceKey, { record, side: 'entry' })
    if (!byKey.has(record.exitEvidenceKey)) byKey.set(record.exitEvidenceKey, { record, side: 'exit' })
  }
  return byKey
}

export async function loadDiffEvidenceByKey(params: {
  keys: readonly string[]
  records: readonly DiffEvidenceOwnerRecord[]
  loadEvidence: AcceptedEvidenceLoader
  concurrency?: number
}): Promise<Map<string, DiffEvidenceSideTotals | null>> {
  const ownerIndex = buildDiffEvidenceOwnerIndex(params.records)
  // Only keys that genuinely have an owning record are ever read — a key without one was skipped by
  // the original loop and is skipped here too.
  const owned = params.keys
    .map((key) => ({ key, owner: ownerIndex.get(key) }))
    .filter((entry): entry is { key: string; owner: ResolvedOwner } => entry.owner !== undefined)

  const resolved = new Map<string, DiffEvidenceSideTotals | null>()
  const limit = Math.max(1, Math.min(params.concurrency ?? DIFF_EVIDENCE_CONCURRENCY, owned.length || 1))
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= owned.length) return
      const { key, owner } = owned[index]
      const { record, side } = owner
      const envelope = await params.loadEvidence({
        chain: record.chain,
        token: record.token,
        txHash: side === 'entry' ? record.openedTxHash : record.closedTxHash,
        side,
        timestamp: side === 'entry' ? record.openedAt : record.closedAt,
        lotIdentityVersion: null,
      })
      resolved.set(key, envelope ? { priceUsd: envelope.priceUsd, valueUsd: envelope.valueUsd, schemaVersion: envelope.schemaVersion } : null)
    }
  }
  await Promise.all(Array.from({ length: owned.length === 0 ? 0 : limit }, () => worker()))

  // DETERMINISTIC INSERTION ORDER, DISCLOSED: rebuilt in the caller's own `keys` order so the
  // returned Map is indistinguishable from the sequential original, entry-for-entry.
  const ordered = new Map<string, DiffEvidenceSideTotals | null>()
  for (const key of params.keys) {
    if (!resolved.has(key)) continue
    ordered.set(key, resolved.get(key) ?? null)
  }
  return ordered
}

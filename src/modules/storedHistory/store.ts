// STORED WALLET HISTORY — persistence. Table DDL: supabase/wallet-history-store.sql
//
// One meta row per (wallet, chain) holding the stream cursors + a revision, and the transfers in
// monthly chunk rows. Writers take a short LEASE on the meta row first, so two scans of the same
// wallet can never interleave chunk writes (which could leave a hole inside a claimed range). Only
// chunks that changed are written; the meta row (cursors) is written LAST, so a crash mid-save can
// leave extra rows but never a cursor claiming rows that were not written.

import { createServiceRoleClient } from '@/lib/supabase/userSettings'
import { STORED_HISTORY_VERSION, chunkTransfers, dirtyChunks, emptyHistory, type StoredHistory, type StoredTransfer, type StreamCursor, type StreamKey } from './core'

export const STORED_HISTORY_LEASE_MS = 120_000

export type Lease = { chain: string; wallet: string; token: string }

export interface HistoryStore {
  /** Takes the (wallet, chain) lease; null when another writer holds it. */
  acquire(chain: string, wallet: string, nowMs: number): Promise<Lease | null>
  release(lease: Lease): Promise<void>
  /** Loads the history (empty when none / wrong version). Only call while holding the lease. */
  load(lease: Lease): Promise<StoredHistory>
  /** Writes changed chunks then the meta row. Only call while holding the lease. */
  save(lease: Lease, before: StoredHistory, after: StoredHistory, nowMs: number): Promise<'saved' | 'conflict' | 'error'>
}

// ── In-memory store (tests, and a reference for the semantics) ──────────────────────────────────
export function createMemoryHistoryStore(): HistoryStore & { dump(chain: string, wallet: string): StoredHistory | null } {
  const meta = new Map<string, { rev: number; version: number; cursors: Record<StreamKey, StreamCursor>; leaseToken: string | null; leaseUntil: number; updatedAt: string | null }>()
  const chunks = new Map<string, Map<string, StoredTransfer[]>>()
  const key = (chain: string, wallet: string) => `${chain}:${wallet.toLowerCase()}`
  let seq = 0
  const read = (chain: string, wallet: string): StoredHistory => {
    const m = meta.get(key(chain, wallet))
    if (!m || m.version !== STORED_HISTORY_VERSION) return emptyHistory(chain, wallet)
    const rows = [...(chunks.get(key(chain, wallet))?.values() ?? [])].flat().sort((a, b) => a.block - b.block || (a.uid < b.uid ? -1 : 1))
    return { version: m.version, chain, wallet: wallet.toLowerCase(), rev: m.rev, cursors: structuredClone(m.cursors), transfers: rows.map((t) => ({ ...t })), updatedAt: m.updatedAt }
  }
  return {
    async acquire(chain, wallet, nowMs) {
      const k = key(chain, wallet)
      const m = meta.get(k) ?? { rev: 0, version: STORED_HISTORY_VERSION, cursors: emptyHistory(chain, wallet).cursors, leaseToken: null, leaseUntil: 0, updatedAt: null }
      if (m.leaseToken && m.leaseUntil > nowMs) return null
      const token = `lease-${++seq}`
      meta.set(k, { ...m, leaseToken: token, leaseUntil: nowMs + STORED_HISTORY_LEASE_MS })
      return { chain, wallet: wallet.toLowerCase(), token }
    },
    async release(lease) {
      const m = meta.get(key(lease.chain, lease.wallet))
      if (m && m.leaseToken === lease.token) meta.set(key(lease.chain, lease.wallet), { ...m, leaseToken: null, leaseUntil: 0 })
    },
    async load(lease) { return read(lease.chain, lease.wallet) },
    async save(lease, before, after, nowMs) {
      const k = key(lease.chain, lease.wallet)
      const m = meta.get(k)
      if (!m || m.leaseToken !== lease.token || m.rev !== before.rev) return 'conflict'
      const byChunk = chunkTransfers(after.transfers)
      const store = chunks.get(k) ?? new Map<string, StoredTransfer[]>()
      for (const c of dirtyChunks(before.transfers, after.transfers)) {
        const rows = byChunk.get(c)
        if (rows && rows.length) store.set(c, rows.map((t) => ({ ...t })))
        else store.delete(c)
      }
      chunks.set(k, store)
      meta.set(k, { ...m, rev: before.rev + 1, version: STORED_HISTORY_VERSION, cursors: structuredClone(after.cursors), updatedAt: new Date(nowMs).toISOString() })
      return 'saved'
    },
    dump(chain, wallet) { return meta.has(key(chain, wallet)) ? read(chain, wallet) : null },
  }
}

// ── Supabase store ──────────────────────────────────────────────────────────────────────────────
const META = 'wallet_history_meta'
const CHUNKS = 'wallet_history_chunks'

export function supabaseHistoryStoreAvailable(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

type MetaRow = { wallet: string; chain: string; version: number; rev: number; cursors: Record<StreamKey, StreamCursor>; lease_token: string | null; lease_until: string | null; updated_at: string | null }

export function createSupabaseHistoryStore(): HistoryStore | null {
  const client = createServiceRoleClient()
  if (!client) return null
  const newToken = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return {
    async acquire(chain, wallet, nowMs) {
      const w = wallet.toLowerCase()
      const token = newToken()
      const until = new Date(nowMs + STORED_HISTORY_LEASE_MS).toISOString()
      try {
        // Ensure the row exists (no-op when it does), then take the lease only if it is free/expired.
        await client.from(META).upsert({ wallet: w, chain, version: STORED_HISTORY_VERSION, rev: 0, cursors: emptyHistory(chain, w).cursors }, { onConflict: 'wallet,chain', ignoreDuplicates: true })
        const { data, error } = await client.from(META)
          .update({ lease_token: token, lease_until: until })
          .eq('wallet', w).eq('chain', chain)
          .or(`lease_until.is.null,lease_until.lt."${new Date(nowMs).toISOString()}"`)
          .select('wallet')
        if (error || !data || data.length === 0) return null
        return { chain, wallet: w, token }
      } catch {
        return null
      }
    },
    async release(lease) {
      try { await client.from(META).update({ lease_token: null, lease_until: null }).eq('wallet', lease.wallet).eq('chain', lease.chain).eq('lease_token', lease.token) } catch { /* lease expires on its own */ }
    },
    async load(lease) {
      const { data: m, error } = await client.from(META).select('*').eq('wallet', lease.wallet).eq('chain', lease.chain).maybeSingle()
      if (error) throw new Error(`stored_history_meta_read_failed: ${error.message}`)
      const row = m as MetaRow | null
      // A different version means the stored format changed: wipe its chunks (we hold the lease) and
      // start over rather than trust or mix them.
      if (!row || row.version !== STORED_HISTORY_VERSION) {
        if (row) {
          const { error: wipeErr } = await client.from(CHUNKS).delete().eq('wallet', lease.wallet).eq('chain', lease.chain)
          if (wipeErr) throw new Error(`stored_history_wipe_failed: ${wipeErr.message}`)
        }
        return { ...emptyHistory(lease.chain, lease.wallet), rev: row?.rev ?? 0 }
      }
      const { data: rows, error: chunkErr } = await client.from(CHUNKS).select('chunk, transfers').eq('wallet', lease.wallet).eq('chain', lease.chain)
      if (chunkErr) throw new Error(`stored_history_chunks_read_failed: ${chunkErr.message}`)
      const transfers = ((rows ?? []) as Array<{ transfers: StoredTransfer[] }>).flatMap((r) => Array.isArray(r.transfers) ? r.transfers : [])
        .sort((a, b) => a.block - b.block || (a.uid < b.uid ? -1 : 1))
      return { version: row.version, chain: lease.chain, wallet: lease.wallet, rev: row.rev, cursors: row.cursors, transfers, updatedAt: row.updated_at }
    },
    async save(lease, before, after, nowMs) {
      try {
        const byChunk = chunkTransfers(after.transfers)
        const nowIso = new Date(nowMs).toISOString()
        for (const c of dirtyChunks(before.transfers, after.transfers)) {
          const rows = byChunk.get(c)
          if (rows && rows.length) {
            const { error } = await client.from(CHUNKS).upsert({ wallet: lease.wallet, chain: lease.chain, chunk: c, transfers: rows, updated_at: nowIso }, { onConflict: 'wallet,chain,chunk' })
            if (error) return 'error'
          } else {
            const { error } = await client.from(CHUNKS).delete().eq('wallet', lease.wallet).eq('chain', lease.chain).eq('chunk', c)
            if (error) return 'error'
          }
        }
        // Cursors last, and only if we still hold the lease at the revision we loaded.
        const { data, error } = await client.from(META)
          .update({ version: STORED_HISTORY_VERSION, rev: before.rev + 1, cursors: after.cursors, transfer_count: after.transfers.length, updated_at: nowIso })
          .eq('wallet', lease.wallet).eq('chain', lease.chain).eq('lease_token', lease.token).eq('rev', before.rev)
          .select('wallet')
        if (error) return 'error'
        return data && data.length > 0 ? 'saved' : 'conflict'
      } catch {
        return 'error'
      }
    },
  }
}

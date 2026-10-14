import { isMissingOwnershipColumn } from './whaleAlertScope'

type PostgrestLikeError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null }
type QueryResult = { data: unknown[] | null; error: PostgrestLikeError | null }
type AlertRow = Record<string, unknown>

/** The slice of the Supabase client the whale_alerts write path uses (structural, so tests can fake it). */
export interface WhaleAlertsDb {
  from(table: 'whale_alerts'): {
    upsert(rows: AlertRow[], options: { onConflict: string; ignoreDuplicates: boolean }): { select(columns: string): PromiseLike<QueryResult> }
    insert(rows: AlertRow[]): { select(columns: string): PromiseLike<QueryResult> }
    select(columns: string): { in(column: string, values: string[]): PromiseLike<QueryResult> }
  }
}

export type WhaleAlertWritePath = 'upsert' | 'dedupe_insert' | 'legacy_no_owner'

export type WhaleAlertWriteResult = {
  inserted: number
  skipped: number
  path: WhaleAlertWritePath
  /** Private (FOMO-owned) alerts that were NOT written because the DB cannot store their owner. */
  privateDropped: number
  /** Errors that were recovered from on the way (e.g. the PGRST204 that triggered legacy mode). */
  recovered: PostgrestLikeError[]
  error: PostgrestLikeError | null
}

const OWNER_KEY = ['tx_hash', 'wallet_address', 'token_address', 'alert_type', 'owner_user_id'] as const
const LEGACY_KEY = ['tx_hash', 'wallet_address', 'token_address', 'alert_type'] as const

function isMissingConflictTarget(error: PostgrestLikeError): boolean {
  return error.code === '42P10' || /no unique or exclusion constraint/i.test(error.message ?? '')
}

// Dedupe in code on the same key tuple against existing rows, then plain insert.
async function dedupeInsert(db: WhaleAlertsDb, rows: AlertRow[], key: readonly string[]): Promise<{ inserted: number; skipped: number; error: PostgrestLikeError | null }> {
  const keyOf = (row: AlertRow) => key.map((col) => (row[col] == null ? '' : String(row[col]).toLowerCase())).join('|')
  const txHashes = [...new Set(rows.map((row) => String(row.tx_hash ?? '')).filter(Boolean))]
  const existing = txHashes.length > 0
    ? await db.from('whale_alerts').select(key.join(',')).in('tx_hash', txHashes)
    : { data: [], error: null }
  if (existing.error) return { inserted: 0, skipped: rows.length, error: existing.error }
  const seen = new Set((existing.data ?? []).map((row) => keyOf(row as AlertRow)))
  const fresh = rows.filter((row) => {
    const k = keyOf(row)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (fresh.length === 0) return { inserted: 0, skipped: rows.length, error: null }
  const plain = await db.from('whale_alerts').insert(fresh).select('id')
  if (plain.error) return { inserted: 0, skipped: rows.length, error: plain.error }
  const inserted = plain.data?.length ?? 0
  return { inserted, skipped: Math.max(rows.length - inserted, 0), error: null }
}

/**
 * Persist whale alerts with the ownership-aware dedupe key, degrading only on a CONFIRMED schema gap:
 *  - missing unique constraint (42P10) → dedupe in code + plain insert, same key;
 *  - missing whale_alerts.owner_user_id column (PGRST204/42703 naming it — the FOMO ownership
 *    migration has not been applied) → write system alerts without the column, deduped on the
 *    pre-migration key. Such a DB can only serve rows ownerless (the feed's legacy read path), so a
 *    private alert (`isPrivate`) is never written there — it would leak to every user — and is
 *    counted in `privateDropped` instead.
 * Any other error is returned untouched so the caller reports it.
 */
export async function persistWhaleAlerts(
  db: WhaleAlertsDb,
  rows: AlertRow[],
  options: { isPrivate?: (row: AlertRow) => boolean } = {},
): Promise<WhaleAlertWriteResult> {
  const base = { privateDropped: 0, recovered: [] as PostgrestLikeError[] }
  if (rows.length === 0) return { ...base, inserted: 0, skipped: 0, path: 'upsert', error: null }

  const upsert = await db.from('whale_alerts')
    .upsert(rows, { onConflict: OWNER_KEY.join(','), ignoreDuplicates: true })
    .select('id')
  if (!upsert.error) {
    const inserted = upsert.data?.length ?? 0
    return { ...base, inserted, skipped: Math.max(rows.length - inserted, 0), path: 'upsert', error: null }
  }

  if (isMissingOwnershipColumn(upsert.error, ['owner_user_id'])) {
    const shareable = rows.filter((row) => !options.isPrivate?.(row))
    const legacyRows = shareable.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'owner_user_id')))
    const privateDropped = rows.length - shareable.length
    const result = legacyRows.length > 0
      ? await dedupeInsert(db, legacyRows, LEGACY_KEY)
      : { inserted: 0, skipped: 0, error: null }
    return {
      ...result,
      skipped: result.skipped + privateDropped,
      path: 'legacy_no_owner',
      privateDropped,
      recovered: [upsert.error],
    }
  }

  if (isMissingConflictTarget(upsert.error)) {
    const result = await dedupeInsert(db, rows, OWNER_KEY)
    return { ...base, ...result, path: 'dedupe_insert', recovered: [upsert.error] }
  }

  return { ...base, inserted: 0, skipped: rows.length, path: 'upsert', error: upsert.error }
}

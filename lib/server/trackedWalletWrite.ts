// FOMO + Add write, tolerant of the tracked_wallets schema actually deployed. The insert names
// provenance columns (chain_slug, source_handle, source_rank, fomo_window, tags, added_at…) that
// exist in docs/supabase-whale-alerts.sql but NOT all in docs/migrations/20260904 — PostgREST rejects
// the whole insert when one is missing (PGRST204), so every Add failed with "Retry". Optional columns
// are dropped one at a time and the write retried; required ones (the wallet, its owner, chain,
// source, active flag) never are — a schema without them returns an exact reason instead.

export type PgError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null }

export const REQUIRED_TRACKED_COLUMNS = ['address', 'wallet_address', 'user_id', 'chain_id', 'source', 'is_active'] as const
const MAX_DROPS = 10

/** Name of the column a PGRST204 / 42703 error is about, or null. */
export function missingColumnName(error: PgError | null | undefined): string | null {
  if (!error || (error.code !== 'PGRST204' && error.code !== '42703')) return null
  const text = [error.message, error.details, error.hint].filter(Boolean).join(' ')
  const m = text.match(/'([a-z_][a-z0-9_]*)' column/i) ?? text.match(/column "?(?:[a-z_]+\.)?([a-z_][a-z0-9_]*)"? (?:of relation \S+ )?does not exist/i)
  return m ? m[1].toLowerCase() : null
}

export async function writeTrackedWallet(
  row: Record<string, unknown>,
  write: (row: Record<string, unknown>) => PromiseLike<{ error: PgError | null }>,
): Promise<{ error: PgError | null; droppedColumns: string[]; missingRequired: string | null }> {
  const current = { ...row }
  const droppedColumns: string[] = []
  for (let attempt = 0; attempt <= MAX_DROPS; attempt += 1) {
    const { error } = await write(current)
    if (!error) return { error: null, droppedColumns, missingRequired: null }
    const column = missingColumnName(error)
    if (!column || !(column in current)) return { error, droppedColumns, missingRequired: null }
    if ((REQUIRED_TRACKED_COLUMNS as readonly string[]).includes(column)) return { error, droppedColumns, missingRequired: column }
    delete current[column]
    droppedColumns.push(column)
  }
  return { error: { code: 'too_many_missing_columns', message: droppedColumns.join(',') }, droppedColumns, missingRequired: null }
}

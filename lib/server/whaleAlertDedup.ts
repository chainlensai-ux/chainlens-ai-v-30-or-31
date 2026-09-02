export type WhaleAlertRow = Record<string, unknown>

export function collapseRapidWhaleAlertRepeats(rows: WhaleAlertRow[]): WhaleAlertRow[] {
  const repeatWindowMs = 5 * 60 * 1000
  const seen = new Map<string, { firstTime: number; idx: number; count: number }>()
  const result: WhaleAlertRow[] = []
  for (const row of rows) {
    const key = [(row.wallet_address as string | null) ?? '', (row.token_symbol as string | null) ?? '', (row.side as string | null) ?? ''].join('::')
    const timestamp = row.occurred_at ? new Date(row.occurred_at as string).getTime() : 0
    const existing = seen.get(key)
    if (existing && timestamp > 0 && existing.firstTime > 0 && Math.abs(existing.firstTime - timestamp) < repeatWindowMs) {
      existing.count += 1
      result[existing.idx] = { ...result[existing.idx], repeats: existing.count }
    } else {
      const idx = result.length
      result.push({ ...row, repeats: 1 })
      seen.set(key, { firstTime: timestamp, idx, count: 1 })
    }
  }
  return result
}

type PostgrestLikeError = {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

export const BASE_WHALE_CHAIN_ID = 8453

/** System wallets are shared; FOMO-added wallets belong only to the signed-in user. */
export function userOrSystemScope(column: 'user_id' | 'owner_user_id', userId: string): string {
  return `${column}.is.null,${column}.eq.${userId}`
}

/**
 * Existing production databases may briefly lag the additive FOMO ownership migration. Only a
 * confirmed missing-column error may use the legacy read path; provider/auth/query failures stay
 * fail-closed and visible.
 */
export function isMissingOwnershipColumn(
  error: PostgrestLikeError | null | undefined,
  columns: readonly string[],
): boolean {
  if (!error) return false
  const text = [error.message, error.details, error.hint].filter(Boolean).join(' ').toLowerCase()
  const missingColumnCode = error.code === '42703' || error.code === 'PGRST204'
  return missingColumnCode && columns.some((column) => text.includes(column.toLowerCase()))
}

export function dedupeTrackedWallets<T extends { address: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const address = row.address.trim().toLowerCase()
    if (!address || seen.has(address)) return false
    seen.add(address)
    return true
  })
}

// FOMO ATTRIBUTION for the Whale Alerts feed. A wallet added from the FOMO board is a per-user
// tracked_wallets row (source 'fomo_board', source_handle, added_at). Attribution is derived at READ
// time from that row — not copied into each alert — so it survives refreshes, reloads, cached feeds,
// re-adds and a wallet that is also in the shared system set, and disappears when the wallet is removed.
//
// NEW vs HISTORICAL: the first sync after an add backfills the scan window, so trades from before the
// add are real but not "new". A trade is new only when it happened at or after the add time.

type Row = Record<string, unknown>

export type FomoWallet = { handle: string | null; addedAtMs: number | null }
export type TrackedRow = { address?: unknown; wallet_address?: unknown; source?: unknown; source_handle?: unknown; added_at?: unknown; created_at?: unknown }

const lower = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null)

export function isFomoSource(source: unknown): boolean {
  return typeof source === 'string' && /^fomo/i.test(source.trim())
}

/** The caller's active private wallets (any source) and the FOMO subset, by lowercase address. */
export function buildFomoIndex(rows: readonly TrackedRow[]): { active: Set<string>; fomo: Map<string, FomoWallet> } {
  const active = new Set<string>()
  const fomo = new Map<string, FomoWallet>()
  for (const row of rows) {
    const address = lower(row.wallet_address) ?? lower(row.address)
    if (!address) continue
    active.add(address)
    if (!isFomoSource(row.source)) continue
    const added = Date.parse(String(row.added_at ?? row.created_at ?? ''))
    fomo.set(address, { handle: typeof row.source_handle === 'string' ? row.source_handle : null, addedAtMs: Number.isFinite(added) ? added : null })
  }
  return { active, fomo }
}

/** Alerts privately produced for this user from a wallet they no longer track are not shown. */
export function isRemovedPrivateAlert(row: Row, userId: string, active: ReadonlySet<string>): boolean {
  if (row.owner_user_id !== userId) return false
  const wallet = lower(row.wallet_address)
  return wallet != null && !active.has(wallet)
}

/** Adds fomo / fomo_handle / fomo_new_count / fomo_observed to a feed row (grouped or single). */
export function annotateFomo(row: Row, fomo: ReadonlyMap<string, FomoWallet>): Row {
  const wallet = lower(row.wallet_address)
  const entry = wallet ? fomo.get(wallet) : undefined
  if (!entry) return row
  const members = Array.isArray(row.activity_members) && row.activity_members.length > 0
    ? (row.activity_members as Array<{ occurred_at?: unknown }>).map(m => m.occurred_at)
    : [row.occurred_at]
  const times = members.map(t => Date.parse(String(t ?? ''))).filter(Number.isFinite)
  // Unknown add time → never claim new.
  const newCount = entry.addedAtMs == null ? 0 : times.filter(t => t >= entry.addedAtMs!).length
  const observed = newCount === 0 ? 'before_add' : newCount === times.length ? 'new' : 'mixed'
  return {
    ...row,
    fomo: true,
    fomo_handle: entry.handle,
    fomo_added_at: entry.addedAtMs == null ? null : new Date(entry.addedAtMs).toISOString(),
    fomo_new_count: newCount,
    fomo_observed: observed,
  }
}

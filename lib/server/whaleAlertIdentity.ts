// Alert identity helpers shared by the whale_alerts producers (sync, cron, Alchemy webhook) and
// the feed reader. One on-chain movement = (tx_hash, wallet, token, alert_type, side); the owner
// column only scopes visibility, it is not part of what happened on chain.

/** Native ETH movements are stored under this token address by every producer. */
export const NATIVE_ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
export const BASE_WETH_ADDRESS = '0x4200000000000000000000000000000000000006'

/**
 * whale_alerts.owner_user_id for an alert produced from a tracked wallet. A shared system wallet
 * (user_id NULL) produces a shared alert no matter who ran the sync, so every producer converges on
 * one row per movement; a private FOMO wallet produces an alert visible only to its owner.
 */
export function alertOwnerForWallet(wallet: { user_id?: string | null }): string | null {
  return wallet.user_id ?? null
}

type Row = Record<string, unknown>

function lower(value: unknown): string {
  return value == null ? '' : String(value).trim().toLowerCase()
}

/** Identity of one movement leg, independent of which owner/producer stored it. */
export function movementKey(row: Row): string {
  return [row.tx_hash, row.wallet_address, row.token_address, row.alert_type, row.side].map(lower).join('|')
}

/**
 * Drop repeated copies of the same movement leg (e.g. a shared row plus a pre-fix per-user copy of
 * the same system-wallet transfer). Without this the feed grouped both copies as a two-leg "swap"
 * and summed their USD twice. Distinct legs — another token, the other side, another wallet —
 * are kept. Rows without a tx hash have no on-chain identity to compare and are always kept.
 * The first occurrence wins (callers pass newest-first rows).
 */
export function dedupeMovementLegs<T extends Row>(rows: readonly T[]): { rows: T[]; removed: number } {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const row of rows) {
    if (!lower(row.tx_hash)) { kept.push(row); continue }
    const key = movementKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(row)
  }
  return { rows: kept, removed: rows.length - kept.length }
}

/** Token address used for price lookups: native ETH is priced as WETH (1:1 wrapped). */
export function pricingAddressFor(tokenAddress: unknown, symbol: unknown): string | null {
  const address = typeof tokenAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(tokenAddress) ? tokenAddress.toLowerCase() : null
  if (address === NATIVE_ETH_SENTINEL) return BASE_WETH_ADDRESS
  const sym = String(symbol ?? '').toUpperCase().trim()
  return address ?? (sym === 'ETH' || sym === 'WETH' ? BASE_WETH_ADDRESS : null)
}

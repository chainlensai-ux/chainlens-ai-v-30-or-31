// Shared input validation for watchlist writes (app/api/watchlist/tokens, app/api/watchlist/
// wallets). Extracted to one place so app/api/watchlist/tokens/route.ts and app/api/watchlist/
// wallets/route.ts can't drift out of sync, and so this is directly unit-testable.
//
// HARDENING, DISCLOSED (security hardening pass): both routes previously accepted any non-empty
// string as an "address" with no format check, and the token route accepted any string as "chain"
// with no allowlist — the same real-address / real-chain validation Token Scanner itself already
// enforces on its own scan inputs was missing here.

import { isValidSolanaMintAddress } from '@/lib/solanaAddress'

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// Same chain union this app already uses everywhere else (app/terminal/token-scanner/page.tsx's
// own chain type) — not a new chain, just enforcing the existing one server-side.
// SOLANA-WATCHLIST FIX, DISCLOSED (Track This Token repair — Token Scanner's own chain tabs
// already include "SOLANA BETA", so wiring its Track button through this validator without also
// allowing a Solana mint here would 400 every Solana track/untrack).
const ALLOWED_CHAINS = new Set(['base', 'eth', 'bnb', 'robinhood', 'solana'])

export const MAX_WATCHLIST_LABEL_LEN = 200

export function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && (ADDRESS_RE.test(value) || isValidSolanaMintAddress(value))
}

export function isAllowedChain(value: unknown): value is string {
  return typeof value === 'string' && ALLOWED_CHAINS.has(value)
}

export function isValidLabel(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.length <= MAX_WATCHLIST_LABEL_LEN)
}

export type WatchlistTokenWriteFields = {
  user_id: string
  address: string
  symbol: string | null
  name: string | null
  chain: string
  risk_label: string | null
  score: number | null
  score_type: string | null
  score_direction: string | null
  saved_at: string
}

export type WatchlistTokenUpsertAttempt = {
  row: Record<string, unknown>
  onConflict: string
}

// The documented live table uses `contract_address` (docs/supabase-watchlist-tokens.sql).
// Newer writes use `address` + (user_id, address, chain). Track fails if we only write the
// newer shape. Try both column names and both unique-key shapes; never invent a token.
export function watchlistTokenUpsertAttempts(fields: WatchlistTokenWriteFields): WatchlistTokenUpsertAttempt[] {
  const withScoreMeta = {
    user_id: fields.user_id,
    symbol: fields.symbol,
    name: fields.name,
    chain: fields.chain,
    risk_label: fields.risk_label,
    score: fields.score,
    score_type: fields.score_type,
    score_direction: fields.score_direction,
    saved_at: fields.saved_at,
  }
  const withoutScoreMeta = {
    user_id: fields.user_id,
    symbol: fields.symbol,
    name: fields.name,
    chain: fields.chain,
    risk_label: fields.risk_label,
    score: fields.score,
    saved_at: fields.saved_at,
  }
  return [
    { row: { ...withScoreMeta, address: fields.address }, onConflict: 'user_id,address,chain' },
    { row: { ...withoutScoreMeta, address: fields.address }, onConflict: 'user_id,address,chain' },
    { row: { ...withScoreMeta, contract_address: fields.address }, onConflict: 'user_id,contract_address,chain' },
    { row: { ...withoutScoreMeta, contract_address: fields.address }, onConflict: 'user_id,contract_address,chain' },
    { row: { ...withScoreMeta, contract_address: fields.address }, onConflict: 'user_id,contract_address' },
    { row: { ...withoutScoreMeta, contract_address: fields.address }, onConflict: 'user_id,contract_address' },
  ]
}

export function isRetryableWatchlistSchemaError(message: string | null | undefined): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes('could not find')
    || m.includes('schema cache')
    || m.includes('column')
    || m.includes('on conflict')
    || m.includes('no unique')
    || m.includes('exclusion constraint')
    || m.includes('score_type')
    || m.includes('score_direction')
  )
}

export function watchlistTokenDeleteAttempts(address: string, chain: string): Array<{ column: 'address' | 'contract_address'; chain: string | null }> {
  return [
    { column: 'address', chain },
    { column: 'contract_address', chain },
    { column: 'contract_address', chain: null },
    { column: 'address', chain: null },
  ]
}

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

// CHAIN-ID SUPPORT, DISCLOSED (Track This Token save-failure diagnosis): the same numeric chainId
// convention Token Scanner's own API route already uses (app/api/token/route.ts's CHAIN_ID_MAP).
// Solana has no EVM chainId — null is the honest value, not a fabricated one. Robinhood's 4663 is
// explicitly included so it is never silently dropped/rejected.
export const CHAIN_ID_BY_SLUG: Record<string, number | null> = {
  base: 8453,
  eth: 1,
  bnb: 56,
  robinhood: 4663,
  solana: null,
}

export function chainIdForSlug(slug: string): number | null {
  return Object.prototype.hasOwnProperty.call(CHAIN_ID_BY_SLUG, slug) ? CHAIN_ID_BY_SLUG[slug] : null
}

// A client-supplied chainId is only ever used to CONFIRM the slug's own well-known id (Robinhood
// scans, in particular, must never be silently coerced to another chain's numeric id) — never to
// override it with an arbitrary client value.
export function chainIdMatchesSlug(chainId: unknown, slug: string): boolean {
  if (chainId == null) return true // not supplied — server derives it from slug alone
  if (typeof chainId !== 'number' || !Number.isFinite(chainId)) return false
  return chainIdForSlug(slug) === chainId
}

export const MAX_WATCHLIST_LABEL_LEN = 200

// SAFE CLIENT-FACING SAVE REASONS, DISCLOSED (Track This Token save-failure diagnosis): the
// generic "Could not save this token. Try again." string was shown for every failure mode
// (unauthenticated, duplicate, RLS/db error, genuine schema problem) alike, giving the user no way
// to tell a permanent problem from "you already saved this" or "sign in first". These are the only
// reasons ever sent to the client — the real Postgres error (code/message) is logged server-side
// only via watchlistSaveAudit, never returned in the response body.
export type WatchlistSaveReason =
  | 'saved'
  | 'unauthenticated'
  | 'invalid_payload'
  | 'duplicate'
  | 'limit_reached'
  | 'db_error'
  | 'unknown'

// The only strings ever shown to the user for a non-2xx or non-saved outcome — every other
// detail (Postgres code/message, which onConflict attempt failed) stays in watchlistSaveAudit's
// server-side log only. 'unknown' is the sole case that still shows the old generic wording, and
// only when nothing more specific was ever determined.
export const WATCHLIST_SAVE_CLIENT_MESSAGE: Record<Exclude<WatchlistSaveReason, 'saved'>, string> = {
  unauthenticated: 'Sign in to save tokens.',
  invalid_payload: 'This token could not be saved — invalid data.',
  duplicate: 'Already in watchlist.',
  limit_reached: 'Watchlist limit reached.',
  db_error: 'Could not save this token — a database error occurred. This has been logged; please try again shortly.',
  unknown: 'Could not save this token. Try again.',
}

export interface WatchlistSaveAudit {
  userIdPresent: boolean
  authSessionReady: boolean
  plan: string | null
  limit: number | null
  currentSavedCount: number | null
  tokenAddress: string | null
  chainId: number | null
  chainSlug: string | null
  symbol: string | null
  name: string | null
  payloadValid: boolean
  duplicateDetected: boolean
  supabaseInsertAttempted: boolean
  supabaseErrorCode: string | null
  supabaseErrorMessage: string | null
  rlsRejected: boolean
  finalStatus: 'saved' | 'duplicate' | 'failed'
  finalReason: WatchlistSaveReason
}

export function emptyWatchlistSaveAudit(): WatchlistSaveAudit {
  return {
    userIdPresent: false,
    authSessionReady: false,
    plan: null,
    limit: null,
    currentSavedCount: null,
    tokenAddress: null,
    chainId: null,
    chainSlug: null,
    symbol: null,
    name: null,
    payloadValid: false,
    duplicateDetected: false,
    supabaseInsertAttempted: false,
    supabaseErrorCode: null,
    supabaseErrorMessage: null,
    rlsRejected: false,
    finalStatus: 'failed',
    finalReason: 'unknown',
  }
}

// Server-side only — never send this to the client. Mirrors this codebase's existing audit-log
// convention (paypalPaymentAudit, robinhoodTokenEvidenceAudit) — one typed shape, one log call.
export function logWatchlistSaveAudit(audit: WatchlistSaveAudit): void {
  console.log('watchlistSaveAudit', JSON.stringify(audit))
}

// A Postgres/PostgREST error whose message plausibly indicates an RLS policy rejection, so the
// audit's rlsRejected flag reflects real evidence rather than a guess.
export function isLikelyRlsRejection(message: string | null | undefined): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return m.includes('row-level security') || m.includes('permission denied') || m.includes('rls')
}

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
  // CHAIN-ID SUPPORT, DISCLOSED: optional/best-effort — written when the live table has a
  // chain_id column (docs/supabase-watchlist-tokens.sql's migration adds it), dropped from the
  // row automatically by the same "could not find the column" retry path already handling
  // address/contract_address drift when it doesn't. Never required for a save to succeed.
  chainId: number | null
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
//
// CHAIN-SCOPED-CONFLICT-TARGET FIX, DISCLOSED (Track This Token save-failure diagnosis): the
// live table's ONLY real unique index (docs/supabase-watchlist-tokens.sql, pre-fix) was
// `(user_id, lower(contract_address))` — no chain, and a functional/expression index, which
// does not satisfy ANY of `user_id,address,chain` / `user_id,contract_address,chain` /
// `user_id,contract_address` as an onConflict target. Every one of those attempts therefore
// failed with "no unique or exclusion constraint matching the ON CONFLICT specification" on
// every single save, on every schema — not just during a migration gap — burning 6 wasted
// round-trips before falling through to the plain-insert fallback in route.ts on every write.
// The migration now creates the real composite index this app actually needs
// (user_id, chain, contract_address) — this first attempt targets exactly that, so a migrated
// database saves in one round-trip; unmigrated databases still fall through the same legacy
// attempts as before (unchanged) and reach the same working plain-insert fallback.
export function watchlistTokenUpsertAttempts(fields: WatchlistTokenWriteFields): WatchlistTokenUpsertAttempt[] {
  const withScoreMeta = {
    user_id: fields.user_id,
    symbol: fields.symbol,
    name: fields.name,
    chain: fields.chain,
    chain_id: fields.chainId,
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
    chain_id: fields.chainId,
    risk_label: fields.risk_label,
    score: fields.score,
    saved_at: fields.saved_at,
  }
  return [
    { row: { ...withScoreMeta, contract_address: fields.address }, onConflict: 'user_id,chain,contract_address' },
    { row: { ...withoutScoreMeta, contract_address: fields.address }, onConflict: 'user_id,chain,contract_address' },
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

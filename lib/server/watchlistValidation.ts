// Shared input validation for watchlist writes (app/api/watchlist/tokens, app/api/watchlist/
// wallets). Extracted to one place so app/api/watchlist/tokens/route.ts and app/api/watchlist/
// wallets/route.ts can't drift out of sync, and so this is directly unit-testable.
//
// HARDENING, DISCLOSED (security hardening pass): both routes previously accepted any non-empty
// string as an "address" with no format check, and the token route accepted any string as "chain"
// with no allowlist — the same real-address / real-chain validation Token Scanner itself already
// enforces on its own scan inputs was missing here.

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// Same chain union this app already uses everywhere else (app/terminal/token-scanner/page.tsx's
// own chain type) — not a new chain, just enforcing the existing one server-side.
const ALLOWED_CHAINS = new Set(['base', 'eth', 'bnb', 'robinhood'])

export const MAX_WATCHLIST_LABEL_LEN = 200

export function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value)
}

export function isAllowedChain(value: unknown): value is string {
  return typeof value === 'string' && ALLOWED_CHAINS.has(value)
}

export function isValidLabel(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.length <= MAX_WATCHLIST_LABEL_LEN)
}

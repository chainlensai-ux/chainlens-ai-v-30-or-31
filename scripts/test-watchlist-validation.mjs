// Test for lib/server/watchlistValidation.ts — the address/chain/label format checks added to
// app/api/watchlist/tokens/route.ts and app/api/watchlist/wallets/route.ts during a security
// hardening pass.
//
// Run: node scripts/test-watchlist-validation.mjs

import assert from 'node:assert'
import {
  isValidAddress, isAllowedChain, isValidLabel, MAX_WATCHLIST_LABEL_LEN,
  watchlistTokenUpsertAttempts, isRetryableWatchlistSchemaError, watchlistTokenDeleteAttempts,
  CHAIN_ID_BY_SLUG, chainIdForSlug, chainIdMatchesSlug, isLikelyRlsRejection, emptyWatchlistSaveAudit,
} from '../lib/server/watchlistValidation.ts'

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed++
}

// Address validation
check('real 40-hex address accepted', isValidAddress('0x1234567890abcdef1234567890ABCDEF12345678') === true)
check('address missing 0x prefix rejected', isValidAddress('1234567890abcdef1234567890ABCDEF12345678') === false)
check('address too short rejected', isValidAddress('0x1234') === false)
check('address with non-hex characters rejected', isValidAddress('0xZZZZ567890abcdef1234567890ABCDEF123456') === false)
check('SQL-injection-shaped string rejected', isValidAddress("0x'; DROP TABLE watchlist_tokens; --") === false)
check('empty string rejected', isValidAddress('') === false)
check('null rejected', isValidAddress(null) === false)
check('non-string rejected', isValidAddress(12345) === false)

// SOLANA-WATCHLIST FIX, DISCLOSED (Track This Token repair — Token Scanner's own chain tabs
// already include "SOLANA BETA", so this validator must accept a real Solana mint too).
check('real Solana mint accepted', isValidAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') === true)
check('too-short base58 string rejected', isValidAddress('abc123') === false)
check('EVM address on the Solana path is still just an EVM address', isValidAddress('0x1234567890abcdef1234567890ABCDEF12345678') === true)

// Chain allowlist
check('base allowed', isAllowedChain('base') === true)
check('eth allowed', isAllowedChain('eth') === true)
check('bnb allowed', isAllowedChain('bnb') === true)
check('robinhood allowed', isAllowedChain('robinhood') === true)
check('solana allowed', isAllowedChain('solana') === true)
check('arbitrary string rejected', isAllowedChain('../../etc/passwd') === false)
check('empty string rejected', isAllowedChain('') === false)

// Label length
check('short label accepted', isValidLabel('My favorite token') === true)
check('null label accepted (optional field)', isValidLabel(null) === true)
check('undefined label accepted (optional field)', isValidLabel(undefined) === true)
check('label at max length accepted', isValidLabel('a'.repeat(MAX_WATCHLIST_LABEL_LEN)) === true)
check('oversized label rejected', isValidLabel('a'.repeat(MAX_WATCHLIST_LABEL_LEN + 1)) === false)

const attempts = watchlistTokenUpsertAttempts({
  user_id: 'user-1',
  address: '0x1234567890abcdef1234567890abcdef12345678',
  symbol: 'WASSETS',
  name: 'Wassets',
  chain: 'base',
  chainId: 8453,
  risk_label: 'High Risk',
  score: 58,
  score_type: 'risk_score',
  score_direction: 'higher_is_riskier',
  saved_at: '2026-09-02T00:00:00.000Z',
})
// CHAIN-SCOPED-CONFLICT-TARGET FIX, UPDATED DISCLOSED (Track This Token save-failure diagnosis):
// the live table's real unique index was `(user_id, lower(contract_address))` — no chain, and a
// functional index that doesn't satisfy ANY of the legacy onConflict targets (address+chain,
// contract_address+chain, or bare contract_address) — every save burned all of them before
// falling through to the working plain-insert fallback. The first attempt now targets the real
// composite index the fresh migration creates (user_id, chain, contract_address); the legacy
// attempts are unchanged and still run in order for a database that hasn't migrated yet.
check('first upsert now targets the real chain-scoped composite index', attempts[0].onConflict === 'user_id,chain,contract_address' && 'contract_address' in attempts[0].row)
check('first upsert carries chain_id best-effort', attempts[0].row.chain_id === 8453)
check('a legacy address + chain conflict attempt still exists for unmigrated databases', attempts.some((a) => a.onConflict === 'user_id,address,chain' && 'address' in a.row))
check('later upsert uses contract_address for the documented table', attempts.some((a) => a.onConflict.includes('contract_address') && 'contract_address' in a.row))
check('no attempt mixes factory-style fake addresses', attempts.every((a) => (a.row.address ?? a.row.contract_address) === '0x1234567890abcdef1234567890abcdef12345678'))
check('missing address column is retryable', isRetryableWatchlistSchemaError("Could not find the 'address' column of 'watchlist_tokens' in the schema cache") === true)
check('on-conflict mismatch is retryable', isRetryableWatchlistSchemaError('there is no unique or exclusion constraint matching the ON CONFLICT specification') === true)
check('unrelated db error is not retried forever', isRetryableWatchlistSchemaError('permission denied for table watchlist_tokens') === false)
const deletes = watchlistTokenDeleteAttempts('0x1234567890abcdef1234567890abcdef12345678', 'base')
check('delete tries address then contract_address', deletes[0].column === 'address' && deletes.some((d) => d.column === 'contract_address'))

// CHAIN-ID SUPPORT
check('base chainId is 8453', chainIdForSlug('base') === 8453)
check('eth chainId is 1', chainIdForSlug('eth') === 1)
check('bnb chainId is 56', chainIdForSlug('bnb') === 56)
check('robinhood chainId is 4663 — never dropped/rejected', chainIdForSlug('robinhood') === 4663)
check('solana has no EVM chainId — honestly null, not fabricated', chainIdForSlug('solana') === null)
check('unknown slug has no chainId', chainIdForSlug('polygon') === null)
check('CHAIN_ID_BY_SLUG exposes the same mapping', CHAIN_ID_BY_SLUG.robinhood === 4663)
check('a matching client-supplied chainId is accepted', chainIdMatchesSlug(4663, 'robinhood') === true)
check('a mismatched client-supplied chainId is rejected (never silently coerced)', chainIdMatchesSlug(8453, 'robinhood') === false)
check('an omitted chainId is accepted — server derives it', chainIdMatchesSlug(null, 'robinhood') === true)
check('a non-numeric chainId is rejected', chainIdMatchesSlug('4663', 'robinhood') === false)

// SAFE-REASON AUDIT SHAPE
check('RLS rejection message is detected', isLikelyRlsRejection('new row violates row-level security policy for table "watchlist_tokens"') === true)
check('permission denied message is detected as a likely RLS rejection', isLikelyRlsRejection('permission denied for table watchlist_tokens') === true)
check('an unrelated error message is not flagged as RLS', isLikelyRlsRejection('there is no unique or exclusion constraint matching the ON CONFLICT specification') === false)
const emptyAudit = emptyWatchlistSaveAudit()
check('empty audit defaults to a failed/unknown final state, never a fabricated success', emptyAudit.finalStatus === 'failed' && emptyAudit.finalReason === 'unknown')
check('empty audit never claims a Supabase insert was attempted', emptyAudit.supabaseInsertAttempted === false)

console.log(`test-watchlist-validation.mjs: all ${passed} assertions passed`)

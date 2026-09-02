// Token Scanner "Track this token" save failure — diagnosis + fix regression tests.
//
// Root cause (diagnosis): docs/supabase-watchlist-tokens.sql's ONLY real unique index was
// `(user_id, lower(contract_address))` — no chain, and a functional/expression index. It matched
// NONE of app/api/watchlist/tokens/route.ts's upsert onConflict targets
// (`user_id,address,chain` / `user_id,contract_address,chain` / `user_id,contract_address`), so
// EVERY save failed the onConflict match with "no unique or exclusion constraint matching the ON
// CONFLICT specification" before falling through to a plain-insert fallback — not a migration-gap
// edge case, the normal path for every single write. Two further real bugs alongside that: (1)
// the fallback UPDATE-on-duplicate branch was never chain-scoped, so the same 0x address tracked
// on two different chains silently overwrote each other's row; (2) every failure mode collapsed
// to one hardcoded client message, discarding the server's actual error/reason.
//
// Fixed: a real chain-scoped composite unique index (docs/supabase-watchlist-tokens.sql), a
// chain_id column + Robinhood(4663)-aware chainId support, an explicit chain-scoped duplicate
// pre-check (fast, predictable "already tracked" instead of racing the onConflict cascade), the
// UPDATE-path chain-scoping bug fixed, a typed watchlistSaveAudit logged server-side, and a safe
// per-reason client message the UI now actually displays instead of one hardcoded string.
//
// Verified by source contract (this route has no dependency-injection seam for a live-request
// test, matching the existing convention in scripts/test-token-scanner-chain-strict.mjs for this
// same file) plus pure-logic replication of the exported validation helpers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  chainIdForSlug, chainIdMatchesSlug, CHAIN_ID_BY_SLUG,
  watchlistTokenUpsertAttempts, isRetryableWatchlistSchemaError,
  WATCHLIST_SAVE_CLIENT_MESSAGE, emptyWatchlistSaveAudit, isLikelyRlsRejection,
} from '../lib/server/watchlistValidation.ts'

const routeSrc = readFileSync(new URL('../app/api/watchlist/tokens/route.ts', import.meta.url), 'utf8')
const sqlSrc = readFileSync(new URL('../docs/supabase-watchlist-tokens.sql', import.meta.url), 'utf8')
const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ }
  else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

console.log('Diagnosis: the real root cause is fixed in the SQL migration doc')
check(
  'the broken chain-less functional unique index is dropped',
  sqlSrc.includes('drop index if exists public.watchlist_tokens_user_contract_idx')
)
check(
  'the real composite index (user_id, chain, contract_address) is created',
  /create unique index if not exists watchlist_tokens_user_chain_contract_idx\s*\n\s*on public\.watchlist_tokens \(user_id, chain, contract_address\)/.test(sqlSrc)
)
check('chain_id column is added', sqlSrc.includes('add column if not exists chain_id integer'))
check('chain_id is backfilled from the existing chain slug', sqlSrc.includes('set chain_id = case lower(coalesce(chain'))
check('Robinhood backfills to 4663', /when 'robinhood' then 4663/.test(sqlSrc))
check('Solana backfills to null — never guessed', /else null.*never guessed/.test(sqlSrc))

console.log('\nSection A: save Base/ETH/BNB/Robinhood/Solana — chainId is real, never fabricated')
check('base -> 8453', chainIdForSlug('base') === 8453)
check('eth -> 1', chainIdForSlug('eth') === 1)
check('bnb -> 56', chainIdForSlug('bnb') === 56)
check('robinhood -> 4663 (chainId 4663 support)', chainIdForSlug('robinhood') === 4663)
check('solana -> null (no EVM chainId — honest, not fabricated)', chainIdForSlug('solana') === null)
check('CHAIN_ID_BY_SLUG is exported for the client to mirror', CHAIN_ID_BY_SLUG.robinhood === 4663)

console.log('\nSection B: same address on different chains never collides as a duplicate')
check(
  'the duplicate pre-check is scoped by chain, not just user_id + address',
  /\.eq\('user_id', userId\)\s*\n\s*\.eq\(column, normalizedAddress\)\s*\n\s*\.eq\('chain', chainValue\)/.test(routeSrc)
)
check(
  'the fallback UPDATE-on-duplicate branch is chain-scoped (the real overwrite bug, fixed)',
  /\.eq\('user_id', userId\)\s*\n\s*\.eq\('contract_address', writeFields\.address\)\s*\n\s*\.eq\('chain', writeFields\.chain\)/.test(routeSrc)
)
check(
  'a client-supplied chainId can never be silently coerced onto a different chain slug',
  chainIdMatchesSlug(8453, 'robinhood') === false && chainIdMatchesSlug(4663, 'robinhood') === true
)

console.log('\nSection C: duplicate shows "Already in watchlist" and marks tracked')
check('the duplicate pre-check runs before the insert cascade', routeSrc.indexOf('if (existing) {') < routeSrc.indexOf('supabaseInsertAttempted = true'))
check('a duplicate returns 200 with duplicate: true, not an error', /return NextResponse\.json\(\{ token: existing, duplicate: true, reason: 'duplicate' as const \}\)/.test(routeSrc))
check('WATCHLIST_SAVE_CLIENT_MESSAGE.duplicate reads "Already in watchlist."', WATCHLIST_SAVE_CLIENT_MESSAGE.duplicate === 'Already in watchlist.')
check('the client marks the duplicate response as tracked (no error), not a save failure', /if \(res\.ok && json\?\.duplicate === true\) \{\s*\n\s*setTrackedSaveError\(null\)/.test(pageSrc))

console.log('\nSection D: distinct, safe messages per failure reason (limit reached / unauthenticated / db error)')
check('WATCHLIST_SAVE_CLIENT_MESSAGE.unauthenticated reads "Sign in to save tokens."', WATCHLIST_SAVE_CLIENT_MESSAGE.unauthenticated === 'Sign in to save tokens.')
check('WATCHLIST_SAVE_CLIENT_MESSAGE.limit_reached reads "Watchlist limit reached."', WATCHLIST_SAVE_CLIENT_MESSAGE.limit_reached === 'Watchlist limit reached.')
check('the generic message is reserved for the truly-unknown reason only', WATCHLIST_SAVE_CLIENT_MESSAGE.unknown === 'Could not save this token. Try again.')
check('unauthenticated returns 401 via the unauthenticated reason', /if \(!userId\) return fail\(401, 'unauthenticated'\)/.test(routeSrc))
check('a real db/RLS error never leaks the raw Postgres message to the client', /return fail\(500, 'db_error'\)/.test(routeSrc) && !/error\.message \}\), \{ status: 500 \}\)/.test(routeSrc))

console.log('\nSection E: RLS/db failure logs the exact safe reason in debug logs (server-side only, never the client response)')
check('supabaseErrorCode/supabaseErrorMessage are captured on failure', /audit\.supabaseErrorCode = error\.code \?\? null/.test(routeSrc) && /audit\.supabaseErrorMessage = error\.message/.test(routeSrc))
check('rlsRejected is set from real evidence via isLikelyRlsRejection', /audit\.rlsRejected = isLikelyRlsRejection\(error\.message\)/.test(routeSrc))
check('logWatchlistSaveAudit is called on every real failure path', /logWatchlistSaveAudit\(audit\)/.test(routeSrc))
check('RLS rejection message detection works', isLikelyRlsRejection('new row violates row-level security policy') === true)
check('empty audit never claims a fabricated success', emptyWatchlistSaveAudit().finalStatus === 'failed')

console.log('\nSection F: sidebar updates instantly after save (optimistic save + rollback)')
const saveTrackedTokenStart = pageSrc.indexOf('async function saveTrackedToken()')
const saveTrackedTokenEnd = pageSrc.indexOf('async function removeTrackedToken(')
assert.ok(saveTrackedTokenStart !== -1 && saveTrackedTokenEnd !== -1 && saveTrackedTokenEnd > saveTrackedTokenStart, 'saveTrackedToken must be found in page.tsx')
const saveTrackedTokenSrc = pageSrc.slice(saveTrackedTokenStart, saveTrackedTokenEnd)
check(
  'the token is added to local state immediately, before the network call resolves',
  saveTrackedTokenSrc.indexOf('setTrackedTokens(prev => [optimisticToken, ...prev])') < saveTrackedTokenSrc.indexOf("const res = await fetch('/api/watchlist/tokens'")
)
check('a rollback exists and is called on 401/failure/thrown-error', (saveTrackedTokenSrc.match(/rollback\(\)/g) ?? []).length >= 3)

console.log('\nSection G: onConflict resilience — wrong-chain cache still rejected, schema drift still retried')
const attempts = watchlistTokenUpsertAttempts({
  user_id: 'user-1', address: '0x' + 'a'.repeat(40), symbol: 'X', name: 'X Token',
  chain: 'robinhood', chainId: 4663, risk_label: null, score: null, score_type: null, score_direction: null,
  saved_at: '2026-09-02T00:00:00.000Z',
})
check('the first (preferred) attempt targets the real chain-scoped composite index', attempts[0].onConflict === 'user_id,chain,contract_address')
check('robinhood chain_id 4663 is carried through the write attempt', attempts[0].row.chain_id === 4663)
check('a legacy fallback attempt still exists for a database that has not migrated yet', attempts.some((a) => a.onConflict === 'user_id,contract_address'))
check('an onConflict-mismatch error is retried, not treated as a hard failure', isRetryableWatchlistSchemaError('there is no unique or exclusion constraint matching the ON CONFLICT specification') === true)
check('a genuine permission error is NOT endlessly retried', isRetryableWatchlistSchemaError('permission denied for table watchlist_tokens') === false)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

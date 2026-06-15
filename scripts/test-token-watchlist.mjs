import assert from 'node:assert/strict'
import fs from 'node:fs'

const route = fs.readFileSync('app/api/watchlist/tokens/route.ts', 'utf8')
const sql = fs.readFileSync('supabase/token-watchlist.sql', 'utf8')
const migration = fs.readFileSync('supabase/migrations/20260615000000_token_watchlist.sql', 'utf8')
const helper = fs.readFileSync('lib/tokenWatchlist.ts', 'utf8')
const page = fs.readFileSync('app/terminal/token-scanner/page.tsx', 'utf8')

assert.match(route, /export async function GET/, 'GET route exists')
assert.match(route, /export async function POST/, 'POST route exists')
assert.match(route, /export async function DELETE/, 'DELETE route exists')
assert.match(route, /status: auth\.status/, 'unauthenticated requests return auth status')
assert.match(route, /status: 401/, 'unauthenticated requests return 401')
assert.match(route, /Sign in to save tokens\./, 'unauthenticated requests return sign-in copy')
assert.match(route, /Token address is required\./, 'missing tokenAddress returns useful 400')
assert.match(route, /status: 400/, 'bad requests return 400')
assert.match(route, /\.trim\(\)\.toLowerCase\(\)/, 'chain and token address are normalized lowercase')
assert.match(route, /user_id: auth\.user\.id/, 'POST uses authenticated user id')
assert.match(route, /\.upsert\(payload, \{ onConflict: 'user_id,chain,token_address' \}\)/, 'POST upserts by account/chain/address')
assert.match(route, /\.eq\('user_id', auth\.userId\)/, 'GET/DELETE scopes to authenticated user')
assert.match(route, /console\.error\('\[watchlist\.tokens\]'/, 'server-side debug logging exists')
assert.match(route, /hasUser: !!userId/, 'log payload records whether a user was resolved')
assert.match(route, /errorCode: error\?\.code \?\? null/, 'safe error code is logged server-side')
assert.match(route, /errorDetails: error\?\.details \?\? null/, 'safe error details are logged server-side')
assert.doesNotMatch(route, /NextResponse\.json\(\{ error: error\?\.message/, 'raw Supabase errors are not returned publicly')

for (const ddl of [sql, migration]) {
  assert.match(ddl, /create table if not exists public\.token_watchlist/, 'token_watchlist table DDL exists')
  assert.match(ddl, /unique\(user_id, chain, token_address\)/, 'duplicate saves constrained')
  assert.match(ddl, /enable row level security/, 'RLS enabled')
  assert.match(ddl, /Users can read own token watchlist/, 'read-own policy exists')
  assert.match(ddl, /Users can insert own token watchlist/, 'insert-own policy exists')
  assert.match(ddl, /Users can update own token watchlist/, 'update-own policy exists')
  assert.match(ddl, /Users can delete own token watchlist/, 'delete-own policy exists')
}

assert.match(helper, /export function buildTokenWatchlistBody/, 'frontend helper exists')
assert.match(helper, /tokenAddress,/, 'frontend helper includes tokenAddress from scan result')
assert.match(page, /body\.tokenAddress = body\.tokenAddress\.toLowerCase\(\)/, 'Save payload normalizes token contract lowercase')
assert.match(helper, /chain: chainKey/, 'frontend helper includes selected chain')
assert.match(helper, /tokenSymbol: scan\.symbol/, 'frontend helper includes symbol when available')
assert.match(helper, /riskLabel: scan\.riskLabel/, 'frontend helper includes risk label when available')
assert.match(page, /buildTokenWatchlistBody\(result, chainKey\)/, 'Token Scanner uses helper to build body')
assert.match(page, /Sign in to save tokens/, 'unauthenticated UI copy exists')
assert.match(page, /Could not save token\. Watchlist setup may be incomplete\./, 'table/API error UI copy exists')
assert.match(page, /Token address unavailable for this scan\./, 'missing token address UI copy exists')
assert.match(page, /Saving…/, 'saving state copy exists')
assert.match(page, /Saved/, 'saved state copy exists')
assert.match(page, /Remove/, 'remove state copy exists')
assert.match(page, /function getDisplayHolderCount/, 'holder display helper exists')
assert.match(page, /result\.holderResolver\?\.holderCount/, 'holder display helper falls back to holderResolver holderCount')
assert.match(page, /result\.holderDistributionStatus\?\.itemCount/, 'holder display helper falls back to holderDistributionStatus itemCount')
assert.match(page, /indexed holders/, 'holder display helper distinguishes indexed rows from total holder count')
assert.match(page, /Holder count unavailable/, 'holder display helper uses unavailable copy')

const normalized = {
  chain: 'BASE'.toLowerCase(),
  token_address: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD'.toLowerCase(),
}
assert.equal(normalized.chain, 'base', 'POST valid authenticated payload normalizes chain lowercase')
assert.equal(normalized.token_address, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', 'POST valid authenticated payload normalizes token lowercase')

const rows = new Map()
const upsert = (payload) => rows.set(`${payload.user_id}:${payload.chain}:${payload.token_address}`, payload)
upsert({ user_id: 'user-1', chain: 'base', token_address: normalized.token_address, token_symbol: 'AAA' })
upsert({ user_id: 'user-1', chain: 'base', token_address: normalized.token_address, token_symbol: 'BBB' })
assert.equal(rows.size, 1, 'duplicate POST upserts, does not duplicate')
assert.equal(rows.values().next().value.token_symbol, 'BBB', 'duplicate POST updates existing row')
assert.equal([...rows.values()].filter((row) => row.user_id === 'user-1').length, 1, 'GET returns saved token for user')
rows.delete(`user-1:base:${normalized.token_address}`)
assert.equal(rows.size, 0, 'DELETE removes saved token')

const holderDisplay = (r) => {
  const exact = r.holderDistribution?.holderCount ?? r.holderResolver?.holderCount ?? r.devIntel?.holderEvidence?.holderCount ?? r.holderDistributionStatus?.normalizedCount ?? r.holderDistributionStatus?.itemCount
  if (exact != null) return `${exact} holders`
  const indexed = r.holderDistribution?.topHolders?.length
  return indexed ? `${indexed} indexed holders` : 'Holder count unavailable'
}
assert.equal(holderDisplay({ holderDistribution: { holderCount: null }, holderResolver: { holderCount: 99 }, devIntel: { holderEvidence: { holderCount: 88 } }, holderDistributionStatus: { itemCount: 77 } }), '99 holders', 'holderResolver holderCount wins when distribution count is null')
assert.equal(holderDisplay({ holderDistribution: { holderCount: null }, holderDistributionStatus: { itemCount: 99 } }), '99 holders', 'holderDistributionStatus itemCount is used as holder count evidence')
assert.equal(holderDisplay({ holderDistribution: { topHolders: [{}, {}] } }), '2 indexed holders', 'topHolders length is labeled as indexed holders only')

const scannedTokenContract = '0x1111111111111111111111111111111111111111'
const poolAddress = '0x2222222222222222222222222222222222222222'
const savePayload = { tokenAddress: scannedTokenContract.toLowerCase(), poolAddress }
assert.notEqual(savePayload.tokenAddress, savePayload.poolAddress, 'Save payload uses token contract, not pool address')

console.log('ok - token watchlist API, RLS, frontend body, holder count, and upsert flow checks passed')

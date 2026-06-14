import assert from 'node:assert/strict'
import fs from 'node:fs'

const route = fs.readFileSync('app/api/watchlist/tokens/route.ts', 'utf8')
const sql = fs.readFileSync('supabase/token-watchlist.sql', 'utf8')

assert.match(route, /status: 401/, 'unauthenticated requests return 401')
assert.match(route, /\.upsert\(payload, \{ onConflict: 'user_id,chain,token_address' \}\)/, 'POST upserts by account/chain/address')
assert.match(route, /\.eq\('user_id', auth\.userId\)/, 'GET/DELETE scopes to authenticated user')
assert.match(route, /\.toLowerCase\(\)/, 'token address normalized lowercase')
assert.match(sql, /unique\(user_id, chain, token_address\)/, 'duplicate saves constrained')
assert.match(sql, /enable row level security/, 'RLS enabled')
assert.match(sql, /Users can read own token watchlist/, 'read-own policy exists')
assert.match(sql, /Users can insert own token watchlist/, 'insert-own policy exists')
assert.match(sql, /Users can update own token watchlist/, 'update-own policy exists')
assert.match(sql, /Users can delete own token watchlist/, 'delete-own policy exists')
console.log('ok - token watchlist API and RLS structure checks passed')

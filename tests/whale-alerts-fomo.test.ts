// FOMO Board → Whale Alerts: + Add stores a per-user fomo_board wallet, triggers a targeted one-wallet
// sync (own 30s limit, only wallets the caller tracks), and the feed derives FOMO attribution from the
// caller's own tracked row — surviving caching, reloads, re-adds and system-set overlap — with trades
// from before the add never labelled new, removal hiding the badge and private alerts, and the usual
// $250 / priced-only rules still applied.
//   npx tsx --test tests/whale-alerts-fomo.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { annotateFomo, buildFomoIndex, isFomoSource, isRemovedPrivateAlert } from '../lib/server/whaleFomoAttribution'
import { targetedSyncAllowed, TARGETED_SYNC_COOLDOWN_MS } from '../lib/server/whaleTargetedSync'
import { groupWhaleActivity } from '../lib/server/whaleActivityGroups'
import { feedValueReason, tradeUsdValue } from '../lib/server/whaleFeedCuration'

const FOMO = '0x1234567890abcdef1234567890abcdef12345678'
const OTHER = '0x9999999999999999999999999999999999999999'
const USER = 'user-1'
const ADDED = Date.parse('2026-10-31T10:00:00Z')
const at = (minFromAdd: number) => new Date(ADDED + minFromAdd * 60_000).toISOString()
const tracked = [
  { wallet_address: FOMO.toUpperCase().replace('0X', '0x'), source: 'fomo_board', source_handle: '@alpha', added_at: new Date(ADDED).toISOString() },
  { wallet_address: FOMO, source: 'fomo_board', source_handle: '@alpha', added_at: new Date(ADDED).toISOString() }, // duplicate add
  { address: OTHER, source: 'manual' },
]

test('index: one FOMO entry per address (duplicates collapse), other private wallets stay active but unbadged', () => {
  const { active, fomo } = buildFomoIndex(tracked)
  assert.equal(fomo.size, 1)
  assert.deepEqual(fomo.get(FOMO), { handle: '@alpha', addedAtMs: ADDED })
  assert.ok(active.has(OTHER))
  assert.equal(isFomoSource('fomo_board'), true)
  assert.equal(isFomoSource('FOMO'), true)
  assert.equal(isFomoSource('manual'), false)
})

const trade = (kind: string, usd: number, min: number, extra: Record<string, unknown> = {}) => ({
  tx_hash: `0x${kind}${min + 1000}`, wallet_address: FOMO, wallet_label: 'alpha', trade_kind: kind, trade_token_symbol: 'AERO',
  trade_token_address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', amount_usd: usd, amount_token: usd, occurred_at: at(min), ...extra,
})

test('new vs historical: before the add is never NEW; after is NEW; a run across the add is mixed with an exact count', () => {
  const { fomo } = buildFomoIndex(tracked)
  const [before] = groupWhaleActivity([trade('buy', 5_000, -120)]).map(r => annotateFomo(r, fomo))
  assert.equal(before.fomo, true)
  assert.equal(before.fomo_handle, '@alpha')
  assert.equal(before.fomo_observed, 'before_add')
  assert.equal(before.fomo_new_count, 0)
  const [after] = groupWhaleActivity([trade('sell', 5_000, 15)]).map(r => annotateFomo(r, fomo))
  assert.equal(after.fomo_observed, 'new')
  const [mixed] = groupWhaleActivity([trade('buy', 1_000, -30), trade('buy', 2_000, 20), trade('buy', 3_000, 40)]).map(r => annotateFomo(r, fomo))
  assert.equal(mixed.fomo_observed, 'mixed')
  assert.equal(mixed.fomo_new_count, 2)
  // Unknown add time never claims new.
  const unknown = buildFomoIndex([{ wallet_address: FOMO, source: 'fomo_board' }]).fomo
  assert.equal(annotateFomo(trade('buy', 5_000, 60), unknown).fomo_observed, 'before_add')
  // Non-FOMO wallets are untouched.
  assert.equal(annotateFomo({ ...trade('buy', 5_000, 60), wallet_address: OTHER }, fomo).fomo, undefined)
})

test('feed rules still apply to FOMO trades: unpriced and sub-$250 are excluded, a swap is one side', () => {
  assert.equal(feedValueReason(tradeUsdValue([{ side: 'buy', token_symbol: 'AERO', amount_usd: null }])), 'unpriced')
  assert.equal(feedValueReason(tradeUsdValue([{ side: 'sell', token_symbol: 'USDC', amount_usd: 240 }, { side: 'buy', token_symbol: 'AERO', amount_usd: 245 }])), 'below_min')
  assert.equal(tradeUsdValue([{ side: 'sell', token_symbol: 'USDC', amount_usd: 900 }, { side: 'buy', token_symbol: 'AERO', amount_usd: 905 }]), 900)
})

test('removal: private alerts of a wallet the user no longer tracks are hidden; shared and still-tracked ones stay', () => {
  const { active } = buildFomoIndex(tracked)
  assert.equal(isRemovedPrivateAlert({ owner_user_id: USER, wallet_address: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' }, USER, active), true)
  assert.equal(isRemovedPrivateAlert({ owner_user_id: USER, wallet_address: FOMO }, USER, active), false)
  assert.equal(isRemovedPrivateAlert({ owner_user_id: null, wallet_address: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' }, USER, active), false, 'shared system alert')
  assert.equal(isRemovedPrivateAlert({ owner_user_id: 'someone-else', wallet_address: FOMO }, USER, active), false)
})

test('targeted sync limit: once per wallet per user per 30s; other wallets and users unaffected', () => {
  const t = 1_000_000_000
  assert.equal(targetedSyncAllowed('u-a', FOMO, t).ok, true)
  const again = targetedSyncAllowed('u-a', FOMO.toUpperCase().replace('0X', '0x'), t + 1_000)
  assert.equal(again.ok, false)
  assert.equal(again.retryAfterMs, TARGETED_SYNC_COOLDOWN_MS - 1_000)
  assert.equal(targetedSyncAllowed('u-a', OTHER, t + 1_000).ok, true)
  assert.equal(targetedSyncAllowed('u-b', FOMO, t + 1_000).ok, true)
  assert.equal(targetedSyncAllowed('u-a', FOMO, t + TARGETED_SYNC_COOLDOWN_MS).ok, true)
})

const sync = readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const feed = readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const tw = readFileSync(new URL('../app/api/whale-alerts/tracked-wallets/route.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../components/whale-alerts/FomoBoardPanel.tsx', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

test('wiring: Add saves fomo_board, triggers ?wallet= sync of a tracked wallet only, feed annotates, UI badges', () => {
  assert.match(tw, /source: 'fomo_board',/)
  assert.match(tw, /export async function DELETE/)
  assert.match(tw, /\.update\(\{ is_active: false \}\)\n\s+\.eq\('user_id', auth\.userId\)/, 'removal touches only the caller’s own row')
  assert.match(sync, /\.filter\(w => !targetWallet \|\| w\.address\.trim\(\)\.toLowerCase\(\) === targetWallet\)/)
  assert.match(sync, /error: 'wallet_not_tracked'/)
  assert.match(sync, /const stalestFirst = lastScannedAvailable && mode === 'batch' && !targetWallet/)
  assert.match(feed, /annotateFomo\(\{ \.\.\.alert, activity_priority/)
  assert.match(feed, /!isRemovedPrivateAlert\(row, userId, fomoIndex\.active\)/)
  assert.match(panel, /\/api\/whale-alerts\/sync\?wallet=\$\{key\}/)
  assert.match(panel, /if \(!alreadyTracked \|\| syncStates\[addr\.toLowerCase\(\)\]\?\.status !== 'synced'\) void syncTrackedWallet\(addr\)/)
  assert.match(page, /className="wa-fomo-badge"/)
  assert.match(page, /before you added/)
  assert.match(page, /addEventListener\('chainlens:whale-feed-refresh'/)
})

test('Add write survives a tracker table without optional provenance columns; required ones fail with the exact column', async () => {
  const { missingColumnName, writeTrackedWallet } = await import('../lib/server/trackedWalletWrite')
  assert.equal(missingColumnName({ code: 'PGRST204', message: "Could not find the 'fomo_window' column of 'tracked_wallets' in the schema cache" }), 'fomo_window')
  assert.equal(missingColumnName({ code: '42703', message: 'column tracked_wallets.chain_slug does not exist' }), 'chain_slug')
  assert.equal(missingColumnName({ code: '23505', message: 'duplicate key' }), null)

  const deployed = new Set(['address', 'wallet_address', 'user_id', 'chain_id', 'source', 'is_active', 'label', 'source_handle', 'added_at'])
  const writes: string[][] = []
  const write = async (r: Record<string, unknown>) => {
    writes.push(Object.keys(r))
    const missing = Object.keys(r).find(k => !deployed.has(k))
    return { error: missing ? { code: 'PGRST204', message: `Could not find the '${missing}' column of 'tracked_wallets' in the schema cache` } : null }
  }
  const row = { address: FOMO, wallet_address: FOMO, user_id: USER, chain_id: 8453, chain_slug: 'base', source: 'fomo_board', source_handle: '@alpha', source_rank: 1, fomo_window: '24h', label: 'alpha', category: 'fomo_trader', tags: ['fomo'], is_active: true, added_at: new Date(ADDED).toISOString() }
  const ok = await writeTrackedWallet(row, write)
  assert.equal(ok.error, null)
  assert.deepEqual(ok.droppedColumns.sort(), ['category', 'chain_slug', 'fomo_window', 'source_rank', 'tags'])
  assert.ok(writes.at(-1)!.includes('source') && writes.at(-1)!.includes('source_handle'), 'FOMO attribution columns kept')

  const noOwner = await writeTrackedWallet({ address: FOMO, user_id: USER }, async (r) => ({ error: 'user_id' in r ? { code: 'PGRST204', message: "Could not find the 'user_id' column of 'tracked_wallets' in the schema cache" } : null }))
  assert.equal(noOwner.missingRequired, 'user_id', 'never saved without its owner')
})

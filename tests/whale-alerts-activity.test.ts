// Whale Alerts intelligence + incremental sync: repeated trades become verified activity summaries
// (accumulation / distribution / exit) with every tx kept as evidence, priority ordering, and a cheap
// Alchemy activity check that lets quiet wallets skip the heavy GoldRush page without ever losing one.
//   npx tsx --test tests/whale-alerts-activity.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ACTIVITY_GAP_MS, groupWhaleActivity, markUnusual, sortWhaleActivity, whaleActivityPriority } from '../lib/server/whaleActivityGroups'
import { ACTIVITY_CURSOR_OVERLAP_MS, activityCursorMs, checkWalletActivity } from '../lib/server/whaleActivityCheck'

const W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631'
const T0 = Date.parse('2026-10-31T00:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const trade = (kind: string, usd: number, min: number, extra: Record<string, unknown> = {}) => ({
  tx_hash: `0x${kind}${min}`, wallet_address: W, wallet_label: 'Smart Whale', trade_kind: kind, trade_token_symbol: 'AERO',
  trade_token_address: AERO, amount_usd: usd, amount_token: usd, occurred_at: at(min), ...extra,
})

test('three buys of one token by one wallet become one accumulation with the exact sum and every tx', () => {
  const [row, ...rest] = groupWhaleActivity([trade('buy', 20_000, 0), trade('buy', 25_000, 30), trade('buy', 20_000, 90)])
  assert.equal(rest.length, 0)
  assert.equal(row.activity_kind, 'accumulation')
  assert.equal(row.amount_usd, 65_000)
  assert.equal(row.activity_headline, 'Smart Whale accumulated $65K AERO across 3 buys')
  assert.deepEqual((row.activity_members as Array<{ tx_hash: string }>).map(m => m.tx_hash), ['0xbuy90', '0xbuy30', '0xbuy0'])
  assert.equal(row.occurred_at, at(90), 'timestamp is the latest trade')
  assert.equal(row.first_occurred_at, at(0))
  assert.ok((row.activity_why as string[]).includes('3 buys in 2h'))
})

test('exit only from a verified EXIT trade; a plain sell stays a sell', () => {
  const [exit] = groupWhaleActivity([trade('sell', 14_500, 0), trade('exit', 20_000, 20)])
  assert.equal(exit.activity_kind, 'exit')
  assert.equal(exit.activity_headline, 'Smart Whale exited AERO — sold $34.5K across 2 sells')
  assert.ok((exit.activity_why as string[]).some(w => w.includes('holds 0 AERO')))
  const [sell] = groupWhaleActivity([trade('sell', 34_500, 0)])
  assert.equal(sell.activity_kind, 'sell')
  assert.doesNotMatch(String(sell.activity_headline), /exit/i)
})

test('different direction, token, wallet or a long gap never merge', () => {
  const rows = groupWhaleActivity([
    trade('buy', 1_000, 0),
    trade('sell', 1_000, 5),
    trade('buy', 1_000, 10, { trade_token_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', trade_token_symbol: 'X' }),
    trade('buy', 1_000, 15, { wallet_address: '0xcccccccccccccccccccccccccccccccccccccccc' }),
    trade('buy', 1_000, ACTIVITY_GAP_MS / 60_000 + 30),
  ])
  assert.equal(rows.length, 5)
  assert.equal(rows.reduce((s, r) => s + (r.amount_usd as number), 0), 5_000, 'no value double counted')
})

test('priority: exits and large or unusual activity first, bots never on repetition alone, newest first within a tier', () => {
  const [accum] = groupWhaleActivity([trade('buy', 6_000, 0), trade('buy', 6_000, 10)])
  assert.equal(whaleActivityPriority(accum), 'high')
  const [botAccum] = groupWhaleActivity([trade('buy', 6_000, 0, { wallet_label: 'High-Frequency Bot' }), trade('buy', 6_000, 10, { wallet_label: 'High-Frequency Bot' })])
  assert.equal(whaleActivityPriority(botAccum), 'normal')
  const [small] = groupWhaleActivity([trade('buy', 800, 50)])
  const sorted = sortWhaleActivity([small, botAccum, accum])
  assert.equal(sorted[0], accum)
  const unusual = markUnusual(small.amount_usd === 800 ? { ...small, amount_usd: 30_000 } : small, { alertCount7d: 10, verifiedUsdFlow7d: 20_000 })
  assert.equal(unusual.activity_unusual, true)
  assert.equal(markUnusual({ ...small, amount_usd: 30_000 }, { alertCount7d: 2, verifiedUsdFlow7d: 1_000 }).activity_unusual, undefined, 'needs real history')
})

test('activity cursor: last scan minus overlap for the 24h sync, never before the window, window start otherwise', () => {
  const windowStartMs = T0
  const last = new Date(T0 + 5 * 3_600_000).toISOString()
  assert.equal(activityCursorMs({ windowStartMs, lastScannedAt: last, useLastScan: true }), T0 + 5 * 3_600_000 - ACTIVITY_CURSOR_OVERLAP_MS)
  assert.equal(activityCursorMs({ windowStartMs, lastScannedAt: last, useLastScan: false }), T0)
  assert.equal(activityCursorMs({ windowStartMs, lastScannedAt: new Date(T0 - 86_400_000).toISOString(), useLastScan: true }), T0)
  assert.equal(activityCursorMs({ windowStartMs, lastScannedAt: null, useLastScan: true }), T0)
})

test('activity check: quiet wallets skip, active and errored wallets are fetched (fail open)', async () => {
  const bodies: Array<{ params: [Record<string, string>] }> = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    const f = body.params[0]
    const who = (f.fromAddress ?? f.toAddress) as string
    if (who.startsWith('0xbad')) return new Response('nope', { status: 500 })
    const active = who.startsWith('0xac') && f.toAddress
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { transfers: active ? [{}] : [] } }))
  }) as unknown as typeof fetch
  const since = Date.parse('2026-10-30T00:00:00Z')
  const r = await checkWalletActivity([
    { address: '0xac00000000000000000000000000000000000000', sinceMs: since },
    { address: '0x9000000000000000000000000000000000000000', sinceMs: since },
    { address: '0xbad0000000000000000000000000000000000000', sinceMs: since },
  ], { rpcUrl: 'https://rpc.test', fetchImpl })
  assert.deepEqual([...r.active], ['0xac00000000000000000000000000000000000000'])
  assert.deepEqual([...r.inactive], ['0x9000000000000000000000000000000000000000'])
  assert.deepEqual([...r.unknown], ['0xbad0000000000000000000000000000000000000'])
  assert.equal(r.calls, 6)
  assert.deepEqual(bodies[0].params[0].category, ['external', 'erc20', 'internal'])
  const noRpc = await checkWalletActivity([{ address: '0x9000000000000000000000000000000000000000', sinceMs: since }], { rpcUrl: null })
  assert.equal(noRpc.unknown.size, 1, 'no Alchemy endpoint → every wallet fetched as before')
})

const sync = readFileSync(new URL('../app/api/whale-alerts/sync/route.ts', import.meta.url), 'utf8')
const feed = readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

test('wiring: sync fetches only non-quiet wallets, stamps quiet ones, reports stage timings; feed groups activity', () => {
  assert.match(sync, /const fetchBatch = walletBatch\.filter\(w => !activity\.inactive\.has/)
  assert.match(sync, /for \(let i = 0; i < fetchBatch\.length; i \+= effectiveConcurrency\)/)
  assert.match(sync, /\.\.\.quietWallets\.map\(w => w\.address\),/)
  assert.match(sync, /stageMs,\n/)
  assert.match(feed, /const collapsed = sortWhaleActivity\(groupWhaleActivity\(deNoised\)\)/)
  assert.match(page, /activity_headline/)
  assert.match(page, /aria-expanded=\{expanded\}/)
  assert.doesNotMatch(page, /signalStyle\(signal\)/, 'WATCH / LOW SIGNAL badge removed')
})

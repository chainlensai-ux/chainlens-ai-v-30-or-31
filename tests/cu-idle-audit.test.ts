// CU idle audit: the only provider work that runs with no user action is the two daily crons and
// Alchemy-pushed webhook events; every client poll that reaches a provider-backed route stops while
// its tab is hidden; the unused GoldRush proxy cannot spend credits outside local development; and the
// in-memory provider-call log is bounded and attributes whale calls to their feature.
//   npx tsx --test tests/cu-idle-audit.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('scheduled background work is exactly two once-a-day crons (a new one must be reviewed for CU)', () => {
  const crons = (JSON.parse(read('vercel.json')).crons ?? []) as Array<{ path: string; schedule: string }>
  assert.deepEqual(crons.map(c => c.path).sort(), ['/api/base-radar/cron', '/api/whale-alerts/sync'])
  for (const c of crons) assert.match(c.schedule, /^\d+ \d+ \* \* \*$/, `${c.path} runs once a day`)
})

test('no server-side timers run provider work on their own', () => {
  // The only server interval is the wallet-scan job heartbeat (KV only, during an active scan).
  const queue = read('src/modules/walletScanQueue.ts')
  assert.match(queue, /setInterval\(\(\) => \{ void heartbeatWalletScanJob\(jobId\) \}/)
})

test('client polls stop while the tab is hidden', () => {
  assert.match(read('app/dashboard/live/page.tsx'), /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) loadData\(\); \}, 30000\)/)
  assert.match(read('components/HomeTokenScreener.tsx'), /if \(document\.visibilityState === 'visible'\) void poll\(\)/)
  assert.match(read('app/terminal/pump-alerts/page.tsx'), /if \(document\.visibilityState !== 'visible'\) return\n\s+setCountdown/)
  // Already gated before this audit — kept that way.
  assert.match(read('app/terminal/whale-alerts/page.tsx'), /if \(document\.visibilityState === 'visible'\) void loadAlerts\(\{ silent: true \}\)/)
  assert.match(read('app/terminal/track/page.tsx'), /async function tick\(force = false\) \{\n\s+if \(cancelled \|\| inFlight\) return\n\s+if \(typeof document !== 'undefined' && document\.visibilityState === 'hidden'\) return/)
  assert.match(read('components/outcomes/OutcomeCard.tsx'), /document\.visibilityState === 'hidden'\) return/)
  assert.match(read('app/terminal/base-radar/page.tsx'), /if \(hiddenRef\.current\) return/)
})

test('the unused GoldRush proxy cannot spend credits outside local development', async () => {
  const src = read('app/api/proxy/goldrush/route.ts')
  assert.ok(src.indexOf('isDevOnlyProviderRouteAllowed()') < src.indexOf('verifyBearerToken(request)'), 'blocked before any work')
  const { isDevOnlyProviderRouteAllowed } = await import('../lib/server/devOnlyProviderRoute')
  const env = process.env as Record<string, string | undefined>
  const prev = env.NODE_ENV
  env.NODE_ENV = 'production'
  try { assert.equal(isDevOnlyProviderRouteAllowed(), false, 'Vercel Production and Preview both run NODE_ENV=production') }
  finally { env.NODE_ENV = prev }
})

test('provider-call log is bounded and whale Alchemy calls are attributed to a feature', async () => {
  const { logRpcCall, rpcDebugLog, RPC_DEBUG_LOG_MAX } = await import('../lib/server/rpcDebug')
  rpcDebugLog.length = 0
  for (let i = 0; i < RPC_DEBUG_LOG_MAX + 25; i += 1) logRpcCall({ method: `m${i}` })
  assert.equal(rpcDebugLog.length, RPC_DEBUG_LOG_MAX)
  assert.equal(rpcDebugLog[rpcDebugLog.length - 1].method, `m${RPC_DEBUG_LOG_MAX + 24}`, 'keeps the newest')
  rpcDebugLog.length = 0

  const { checkWalletActivity } = await import('../lib/server/whaleActivityCheck')
  const fetchImpl = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { transfers: [] } }))) as unknown as typeof fetch
  await checkWalletActivity([{ address: '0x9000000000000000000000000000000000000000', sinceMs: Date.parse('2026-10-30T00:00:00Z') }], { rpcUrl: 'https://rpc.test', fetchImpl })
  assert.equal(rpcDebugLog.filter(e => e.feature === 'whale_sync_activity_check').length, 2, 'from + to, both counted')
  for (const [file, feature] of [
    ['lib/server/whaleAlchemyTransfers.ts', 'whale_sync_goldrush_fallback'],
    ['lib/server/whaleEthAtTime.ts', 'whale_feed_eth_price_at_tx'],
    ['lib/server/whaleExitCheck.ts', 'whale_feed_exit_check'],
    ['lib/server/whaleWalletKind.ts', 'whale_sync_wallet_kind'],
  ]) assert.match(read(file), new RegExp(`feature: '${feature}'`))
})

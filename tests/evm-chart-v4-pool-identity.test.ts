// EVM price chart: bytes32 V4 / Infinity pool identity end to end, and the client keeping the chart
// fields the server sends. Fixtures are GeckoTerminal-shaped (resource id "<network>_<hex>"), and the
// fake provider 404s any pool identifier it doesn't hold, like the real one does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COINGECKO_V4_POOL_ID_OHLCV_CONFIRMED, GECKOTERMINAL_V4_POOL_ID_OHLCV_CONFIRMED, runEvmCandleLadder, type LadderDeps, type LadderFetchResult, type LadderPool } from '../lib/evmChartCandles.ts'
import { fetchCoingeckoOnchainPoolOhlcv } from '../lib/server/coingeckoOnchainOhlcv.ts'
import { loadOnDemandCandles, resetOnDemandCandleState, rememberVerifiedChartPool } from '../lib/server/chartCandlesOnDemand.ts'
import { parseProbeInput } from '../lib/server/coingeckoOnchainProbe.ts'
import { sanitizePublicTokenResponse } from '../lib/server/tokenPublicResponse.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const route = read('app/api/token/route.ts')
const page = read('app/terminal/token-scanner/page.tsx')

// Lift the route's real helpers (not exported) and run them as-is.
function lift(name: string): string {
  const start = route.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  return route.slice(start, route.indexOf('\n}\n', start) + 2)
}
const stripTypes = (src: string) => src
  .replace(/\(rawId: unknown, attrAddress: unknown\): \{[^\n]*\} \{/, '(rawId, attrAddress) {')
  .replace(/\(pool: Record<string, unknown> \| null \| undefined\): string \| null \{/g, '(pool) {')
  .replace(/ as Record<string, unknown> \| undefined/g, '')
  .replace(/ as Record<string, unknown>/g, '')
  .replace(/: "contract" \| "pool_id" \| "unknown"/g, '')
const helpers = new Function(`${stripTypes(lift('extractPoolAddressOrId'))}\n${stripTypes(lift('chartPoolIdentifier'))}\n${stripTypes(lift('extractGeckoTerminalPoolAddress'))}\nreturn { chartPoolIdentifier, extractGeckoTerminalPoolAddress }`)() as {
  chartPoolIdentifier: (p: unknown) => string | null
  extractGeckoTerminalPoolAddress: (p: unknown) => string | null
}

const TOKEN = '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb'
const WETH = '0x4200000000000000000000000000000000000006'
const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
const V4_A = '0x' + '9f3c'.repeat(16)
const V4_B = '0x' + '51ab'.repeat(16)
const V3 = '0x' + '7a'.repeat(20)
const AERO = '0x' + 'ae'.repeat(20)
const rel = (dex: string) => ({ base_token: { data: { id: `base_${TOKEN}` } }, quote_token: { data: { id: `base_${WETH}` } }, dex: { data: { id: dex } } })
const gtPool = (hexId: string, attrAddress: string, dex: string) => ({ id: `base_${hexId}`, type: 'pool', attributes: { address: attrAddress, name: 'TKN / WETH', reserve_in_usd: '250000' }, relationships: rel(dex) })

// ── Route extraction ─────────────────────────────────────────────────────────────────────────────
test('V4 pool: the 64-hex PoolId survives route extraction unchanged (was truncated to 40 hex)', () => {
  const p = gtPool(V4_A, V4_A, 'uniswap-v4-base')
  assert.equal(helpers.chartPoolIdentifier(p), V4_A)
  assert.equal(helpers.extractGeckoTerminalPoolAddress(p), V4_A.slice(0, 42), 'documents the old truncation')
})

test('V4 pool: the shared PoolManager in attributes.address is never used as the pool identity', () => {
  const p = gtPool(V4_A, POOL_MANAGER, 'uniswap-v4-base')
  assert.equal(helpers.chartPoolIdentifier(p), V4_A)
  assert.notEqual(helpers.chartPoolIdentifier(p), POOL_MANAGER)
  // PancakeSwap Infinity labels don't say "uniswap" — the pool id still wins.
  assert.equal(helpers.chartPoolIdentifier(gtPool(V4_B, POOL_MANAGER, 'pancakeswap-infinity-cl-bsc')), V4_B)
})

test('multiple V4 pools do not collapse into one (dedupe is by true PoolId)', () => {
  const ids = [gtPool(V4_A, POOL_MANAGER, 'uniswap-v4-base'), gtPool(V4_B, POOL_MANAGER, 'uniswap-v4-base')].map(helpers.chartPoolIdentifier)
  assert.deepEqual(ids, [V4_A, V4_B])
  assert.match(route, /const uniqueChartPools = chartPoolCandidates\.filter\(\(c, i, arr\) => arr\.findIndex\(\(x\) => x\.address\.toLowerCase\(\) === c\.address\.toLowerCase\(\)\) === i\)/)
  assert.match(route, /const address = chartPoolIdentifier\(p as Record<string, unknown>\)/)
  assert.match(route, /const primaryAddr = chartPoolIdentifier\(mainPool/)
})

test('V3 / Aerodrome / V2 pools resolve exactly as before', () => {
  for (const p of [gtPool(V3, V3, 'uniswap-v3-base'), gtPool(AERO, AERO, 'aerodrome-base'), gtPool(AERO, '', 'aerodrome-slipstream')]) {
    assert.equal(helpers.chartPoolIdentifier(p), helpers.extractGeckoTerminalPoolAddress(p))
  }
  assert.equal(helpers.chartPoolIdentifier(gtPool(V3, V3, 'uniswap-v3-base')), V3)
})

// ── Ladder: true id kept, never requested while provider support is unproven ─────────────────────
const END = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000)
const rows = Array.from({ length: 672 }, (_, i) => [END - i * 900, 1, 1.1, 0.9, 1.05, 10])
const serveOnly = (truth: string) => (addr: string): LadderFetchResult => (addr === truth ? { httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows } } } } : { httpStatus: 404, json: null })
const ladderPool = (id: string, dex: string): LadderPool => ({ poolId: `base_${id}`, address: id, name: 'TKN / WETH', liquidityUsd: 250_000, pool: gtPool(id, id, dex) })
function deps(serve: (a: string) => LadderFetchResult, calls: string[]): LadderDeps {
  return {
    fetchCoingeckoPoolOhlcv: async (a) => { calls.push(`CG ${a}`); return serve(a) },
    fetchPoolOhlcv: async (a, rung) => { calls.push(`GT ${rung.key} ${a}`); return serve(a) },
    fetchTrades: async (a) => { calls.push(`trades ${a}`); return { httpStatus: 404, json: null } },
  }
}

test('provider support for 64-hex pool ids is NOT marked confirmed (per provider)', () => {
  assert.equal(COINGECKO_V4_POOL_ID_OHLCV_CONFIRMED, false)
  assert.equal(GECKOTERMINAL_V4_POOL_ID_OHLCV_CONFIRMED, false)
})

test('V4-only token: zero provider calls (was 5 wasted), honest provider_unsupported_pool_id, true id in the trail', async () => {
  const calls: string[] = []
  const r = await runEvmCandleLadder({ pools: [ladderPool(V4_A, 'uniswap-v4-base')], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 1.05 }, deps(serveOnly(V4_A), calls))
  assert.deepEqual(calls, [])
  assert.equal(r.totalHttpCalls, 0)
  assert.equal(r.priceChart, null, 'no fabricated candles; the route then shows its estimated trend')
  assert.equal(r.candleFailure?.code, 'provider_unsupported_pool_id')
  assert.ok(r.attempts.length > 0)
  for (const a of r.attempts) {
    assert.equal(a.code, 'provider_unsupported_pool_id')
    assert.equal(a.poolAddress, V4_A, 'never truncated, never the PoolManager')
    assert.equal(a.httpStatus, null)
  }
  assert.deepEqual(r.attempts.map((a) => a.route), ['coingecko_pool', 'pool', 'swaps'])
})

test('V4 primary + V3 alternate: the V3 pool still charts, V4 costs zero calls', async () => {
  const calls: string[] = []
  const r = await runEvmCandleLadder({ pools: [ladderPool(V4_A, 'uniswap-v4-base'), ladderPool(V3, 'uniswap-v3-base')], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 1.05 }, deps(serveOnly(V3), calls))
  assert.deepEqual(calls, [`GT 24h ${V3}`])
  assert.equal(r.selectedPool?.address, V3)
  assert.equal(r.chartCandles?.points.length, 672)
})

test('once support is confirmed, the FULL 64-hex id is what gets requested', async () => {
  const calls: string[] = []
  const r = await runEvmCandleLadder({ pools: [ladderPool(V4_A, 'uniswap-v4-base')], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 1.05, poolIdSupport: { coingecko: true, geckoterminal: true } }, deps(serveOnly(V4_A), calls))
  assert.deepEqual(calls, [`CG ${V4_A}`])
  assert.equal(r.chartCandles?.poolAddress, V4_A)
  assert.equal(r.candleProvider, 'coingecko_onchain')
})

test('V3 pool: call pattern unchanged (one CoinGecko call)', async () => {
  const calls: string[] = []
  await runEvmCandleLadder({ pools: [ladderPool(V3, 'uniswap-v3-base')], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 1.05 }, deps(serveOnly(V3), calls))
  assert.deepEqual(calls, [`CG ${V3}`])
})

// ── Fetcher / 5M / probe validation ──────────────────────────────────────────────────────────────
const MALFORMED_POOLS = ['0x' + 'a'.repeat(63), '0x' + 'a'.repeat(41), '0x' + 'g'.repeat(64), 'a'.repeat(64), '0x' + 'a'.repeat(65), '']

test('CoinGecko fetcher: accepts a 64-hex pool id whole, rejects malformed ids and non-40-hex tokens', async () => {
  const prev = process.env.COINGECKO_API_KEY
  process.env.COINGECKO_API_KEY = 'test-key'
  try {
    const seen: string[] = []
    const f = async (url: string) => { seen.push(url); return { status: 200, ok: true, json: async () => ({}) } }
    const req = { resolution: 'minute' as const, aggregate: 15, limit: 672 }
    await fetchCoingeckoOnchainPoolOhlcv('base', V4_A, req, 'base', f)
    assert.equal(seen.length, 1)
    assert.match(seen[0], new RegExp(`/pools/${V4_A}/ohlcv/minute\\?`))
    for (const bad of MALFORMED_POOLS) {
      assert.deepEqual(await fetchCoingeckoOnchainPoolOhlcv('base', bad, req, 'base', f), { json: null, httpStatus: null }, bad)
    }
    assert.deepEqual(await fetchCoingeckoOnchainPoolOhlcv('base', V3, req, V4_A, f), { json: null, httpStatus: null }, 'token param must stay a 40-hex address (or base/quote)')
    assert.equal(seen.length, 1)
  } finally {
    if (prev === undefined) delete process.env.COINGECKO_API_KEY
    else process.env.COINGECKO_API_KEY = prev
  }
})

test('5M endpoint: accepts a 64-hex pool id (honest unsupported reason, zero calls), rejects malformed ids, token stays strict', async () => {
  resetOnDemandCandleState()
  let calls = 0
  const fetchJson = async () => { calls++; return { httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows } } } } }
  const cg = async () => { calls++; return { httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows } } } } }
  const v4 = await loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: V4_A, timeframe: '5m' }, fetchJson, { fetchCoingecko: cg })
  assert.equal(v4.result.ok, false)
  assert.equal(!v4.result.ok && v4.result.code, 'provider_unsupported_pool_id')
  assert.equal(v4.providerCalls, 0)
  for (const bad of MALFORMED_POOLS) {
    const out = await loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: bad, timeframe: '5m' }, fetchJson, { fetchCoingecko: cg })
    assert.equal(!out.result.ok && out.result.code, 'invalid_request', bad)
  }
  const badToken = await loadOnDemandCandles({ chain: 'base', token: V4_A, pool: V3, timeframe: '5m' }, fetchJson, { fetchCoingecko: cg })
  assert.equal(!badToken.result.ok && badToken.result.code, 'invalid_request', 'a 64-hex token is still rejected')
  assert.equal(calls, 0)
  // With support confirmed, the full id is requested.
  rememberVerifiedChartPool('base', TOKEN, V4_A, 'base')
  const seen: string[] = []
  const ok = await loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: V4_A, timeframe: '5m' }, fetchJson, { fetchCoingecko: async (_c, pool) => { seen.push(pool); return cg() }, poolIdSupport: { coingecko: true, geckoterminal: true } })
  assert.equal(ok.result.ok, true)
  assert.deepEqual(seen, [V4_A])
})

test('admin probe accepts a 64-hex pool id (so support can be verified live) and still rejects malformed ids', () => {
  const ok = parseProbeInput(new URLSearchParams({ network: 'base', pool: V4_A }))
  assert.ok(!('error' in ok))
  assert.equal(!('error' in ok) && ok.pool, V4_A)
  for (const bad of ['0x' + 'a'.repeat(63), '0x' + 'a'.repeat(41), '0x' + 'g'.repeat(64)]) {
    assert.ok('error' in parseProbeInput(new URLSearchParams({ pool: bad })), bad)
  }
})

// ── Client: chart fields survive API -> mapped result -> PriceChartPanel ──────────────────────────
function mappedChartFields(json: Record<string, unknown>): Record<string, unknown> {
  const start = page.indexOf('const mapped: ScanResult = {')
  const block = page.slice(start, page.indexOf('\n        }\n        setResult(mapped)', start))
  const lines = block.split('\n').filter((l) => /^\s+(chartCandles|chartCandleStatus|chartDebug|priceChart|chartSource|chartStatus):/.test(l))
  return new Function('json', `return {\n${lines.join('\n')}\n}`)(json) as Record<string, unknown>
}

test('chartCandles, chartCandleStatus and chartDebug survive sanitizer -> JSON -> mapped ScanResult', () => {
  const points = rows.slice().reverse().map((r) => ({ timestamp: new Date((r[0] as number) * 1000).toISOString(), open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 10, priceUsd: 1.05 }))
  const server = {
    chain: 'base',
    priceChart: { timeframe: '24h', points: points.slice(-96), sourceStatus: 'ok' },
    chartCandles: { intervalSec: 900, points, poolAddress: V4_A, tokenSide: 'quote' },
    chartCandleStatus: { available: false, code: 'provider_unsupported_pool_id', message: 'not requested' },
    chartDebug: { finalSource: 'none', attempts: [{ stage: 'coingecko_15m', pool: V4_A }] },
    chartStatus: 'ok',
    chartSource: 'pool_ohlcv',
  }
  const wire = JSON.parse(JSON.stringify(sanitizePublicTokenResponse(server, false)))
  assert.equal(wire.chartCandles.points.length, 672, 'public response keeps all 672')
  const mapped = mappedChartFields(wire)
  assert.equal((mapped.chartCandles as { points: unknown[] }).points.length, 672, 'client keeps all 672 (was dropped)')
  assert.equal((mapped.chartCandles as { poolAddress: string }).poolAddress, V4_A)
  assert.deepEqual(mapped.chartCandleStatus, server.chartCandleStatus)
  assert.ok(mapped.chartDebug, 'debug trail reaches the client (was dropped)')
  // Absent fields stay null, never undefined surprises.
  const empty = mappedChartFields({})
  assert.deepEqual([empty.chartCandles, empty.chartCandleStatus, empty.chartDebug], [null, null, null])
})

test('PriceChartPanel is fed chartCandles, the reason comes from chartCandleStatus, and ?debug=1 renders the panel', () => {
  assert.match(page, /candles=\{result\.chartCandles\?\.points \?\? result\.priceChart!\.points\}/)
  assert.match(page, /loadFiveMinute=\{makeFiveMinuteLoader\(result\.chain, result\.contract, result\.chartCandles\?\.poolAddress\)\}/)
  assert.match(page, /const _candleReason = result\.chartCandleStatus\?\.message/)
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\.get\('debug'\) === '1'/)
  assert.match(page, /\{result\.chartDebug && <ChartDebugPanel debug=\{result\.chartDebug\} chain=\{result\.chain\} token=\{result\.contract\} livePriceUsd=\{result\.price \?\? null\} \/>\}/)
})

test('Solana result handling is untouched (whole JSON, no whitelist)', () => {
  assert.match(page, /setSolanaResult\(json as SolanaBetaResult\)/)
})

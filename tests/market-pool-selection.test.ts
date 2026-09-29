// Token Scanner pool roles (lib/marketPoolSelection.ts + app/api/token/route.ts wiring): the market
// pool (Market Pulse + Price Chart) is the most ACTIVE pool; the liquidity pool (LP Safety / custody)
// stays the deepest pool. Includes the live TE / MUc failure shape and the chart ladder consequence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  marketPoolMetrics,
  orderPoolsByLiquidity,
  orderPoolsForMarket,
  selectLiquidityPool,
  selectMarketPool,
} from '../lib/marketPoolSelection.ts'
import { runEvmCandleLadder, type LadderPool } from '../lib/evmChartCandles.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const TE = '0x' + 'e1'.repeat(20)
const MUC = '0x' + 'cc'.repeat(20)
const AERO = '0x8d6ad9946b9220e666690e77ce49f933e1ff15c9'
const V4_ID = '0x' + 'ab'.repeat(32)

type GtPool = { id: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> }
function gtPool(addr: string, o: { reserve: number | string; volume: number | string | null; buys?: number | null; sells?: number | null; dex: string; created?: string; baseToken?: string; quoteToken?: string }): GtPool {
  return {
    id: `base_${addr}`,
    attributes: {
      address: addr.length === 66 ? '0x498581ff718922c3f8e6a244956af099b2652b2b' : addr,
      name: 'TE / MUc',
      reserve_in_usd: String(o.reserve),
      volume_usd: o.volume == null ? {} : { h24: String(o.volume) },
      transactions: { h24: { buys: o.buys ?? 0, sells: o.sells ?? 0 } },
      pool_created_at: o.created ?? '2026-09-26T00:00:00Z',
      base_token_price_usd: '0.0105',
    },
    relationships: {
      base_token: { data: { id: `base_${o.baseToken ?? TE}` } },
      quote_token: { data: { id: `base_${o.quoteToken ?? MUC}` } },
      dex: { data: { id: o.dex } },
    },
  }
}
// Live failure shape: a dormant high-reserve V4 pool and the real Aerodrome market.
const POOL_A = gtPool(V4_ID, { reserve: 2_680_000, volume: 0, buys: 0, sells: 0, dex: 'uniswap-v4-base', created: '2026-09-26T00:00:00Z' })
const POOL_B = gtPool(AERO, { reserve: 78_000, volume: 198_000, buys: 800, sells: 752, dex: 'aerodrome-slipstream', created: '2026-09-20T00:00:00Z' })

// ── TE / MUc live failure shape ──────────────────────────────────────────────────────────────────
test('TE/MUc: marketPool = Aerodrome (active), liquidityPool = the dormant V4 pool, chart primary = Aerodrome', () => {
  for (const order of [[POOL_A, POOL_B], [POOL_B, POOL_A]]) {
    const m = selectMarketPool(order)
    assert.equal(m.pool, POOL_B)
    assert.equal(m.rule, 'active_market')
    assert.equal(m.activePoolCount, 1)
    assert.equal(selectLiquidityPool(order), POOL_A, 'LP Safety keeps the deepest pool')
    assert.equal(orderPoolsForMarket(order)[0], POOL_B, 'chart primary')
    assert.deepEqual(m.metrics && [m.metrics.reserveUsd, m.metrics.volume24hUsd, m.metrics.txns24h, m.metrics.buys24h, m.metrics.sells24h], [78_000, 198_000, 1_552, 800, 752])
  }
})

test('TE/MUc before vs after: the old reserve-only rule picked the $0-volume pool', () => {
  const before = [POOL_B, POOL_A].sort((a, b) => parseFloat(String(b.attributes.reserve_in_usd)) - parseFloat(String(a.attributes.reserve_in_usd)))[0]
  assert.equal(before, POOL_A, 'previous mainPool: $2.68M reserve, $0 volume, 0 txns')
  assert.equal(selectMarketPool([POOL_B, POOL_A]).pool, POOL_B, 'now: $198K volume, 1,552 txns')
})

test('TE/MUc chart: the Aerodrome pool is tried first and returns real candles in one provider call — no V4 / quote-USD fallback', async () => {
  const toLadder = (p: GtPool): LadderPool => {
    const address = p.id.slice(5)
    return { poolId: p.id, address, name: String(p.attributes.name), liquidityUsd: Number(p.attributes.reserve_in_usd), pool: p as unknown as Record<string, unknown> }
  }
  const rows = Array.from({ length: 96 }, (_, i) => [1_800_000_000 - (96 - i) * 900, 0.01, 0.011, 0.0095, 0.0105, 2000])
  const run = async (pools: GtPool[]) => {
    const calls: string[] = []
    const serve = (a: string) => (a === AERO ? { httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows } }, meta: { base: { address: TE }, quote: { address: MUC } } } } : { httpStatus: 200, json: { data: { attributes: { ohlcv_list: [] } } } })
    const r = await runEvmCandleLadder({ pools: pools.map(toLadder), contract: TE, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 0.0105 }, {
      fetchCoingeckoPoolOhlcv: async (a) => { calls.push(`CG ${a}`); return serve(a) },
      fetchPoolOhlcv: async (a) => { calls.push(`GT ${a}`); return serve(a) },
      fetchTrades: async (a) => { calls.push(`trades ${a}`); return { httpStatus: 200, json: { data: [] } } },
      fetchV4SwapCandles: async () => { calls.push('V4'); return { ok: false, code: 'quote_usd_price_unproven', poolManager: null, logsFound: 0, candles: [], intervalSec: 300, timeResolution: null, callsUsed: 3, pagesFetched: 0, budgetStopReason: null } },
    })
    return { r, calls }
  }
  const fillerA = gtPool('0x' + 'a1'.repeat(20), { reserve: 300_000, volume: 0, dex: 'uniswap_v3' })
  const fillerB = gtPool('0x' + 'b1'.repeat(20), { reserve: 150_000, volume: 0, dex: 'uniswap_v3' })
  const all = [POOL_A, fillerA, fillerB, POOL_B]
  const before = await run(orderPoolsByLiquidity(all))
  assert.equal(before.r.candleFailure?.code, 'quote_usd_price_unproven', 'old order reproduces the live failure')
  assert.ok(!before.calls.some((c) => c.includes(AERO)), 'the Aerodrome pool was never even tried')
  const after = await run(orderPoolsForMarket(all))
  assert.equal(after.r.selectedPool?.address, AERO)
  assert.equal(after.r.chartCandles?.points.length, 96)
  assert.deepEqual(after.calls, [`CG ${AERO}`], 'one provider call (CoinGecko primary); no V4 read, no quote-token lane')
})

// ── Ranking rules ────────────────────────────────────────────────────────────────────────────────
const P = (id: string, reserve: number, volume: number, txns: number) => gtPool('0x' + id.repeat(20), { reserve, volume, buys: Math.ceil(txns / 2), sells: Math.floor(txns / 2), dex: 'uniswap_v3' })

test('two active pools: highest 24h volume wins even against much deeper reserve', () => {
  const deep = P('11', 5_000_000, 10_000, 900)
  const busy = P('22', 50_000, 400_000, 300)
  assert.equal(selectMarketPool([deep, busy]).pool, busy)
})

test('equal volume: more txns wins; equal volume + txns: deeper reserve wins; all equal: pool id ascending', () => {
  const a = P('33', 100_000, 50_000, 200)
  const b = P('44', 10_000, 50_000, 900)
  assert.equal(selectMarketPool([a, b]).pool, b)
  const c = P('55', 90_000, 50_000, 900)
  assert.equal(selectMarketPool([b, c]).pool, c)
  const d = P('66', 90_000, 50_000, 900)
  assert.equal(selectMarketPool([d, c]).pool, c, 'base_0x5555… < base_0x6666…')
  assert.equal(selectMarketPool([c, d]).pool, c, 'order-independent')
})

test('active requires BOTH 24h volume > 0 and 24h txns > 0 — neither alone beats deeper liquidity', () => {
  const volOnly = P('77', 1_000, 90_000, 0)
  const txOnly = P('88', 1_000, 0, 40)
  const deep = P('99', 2_000_000, 0, 0)
  const s = selectMarketPool([volOnly, txOnly, deep])
  assert.equal(s.rule, 'deepest_liquidity_fallback')
  assert.equal(s.pool, deep)
})

test('all inactive: exactly the previous deepest-liquidity rule (reserve desc, id tie-break)', () => {
  const pools = [P('aa', 10, 0, 0), P('bb', 500, 0, 0), P('cc', 500, 0, 0), P('dd', 50, 0, 0)]
  const legacy = [...pools].sort((a, b) => (parseFloat(String(b.attributes.reserve_in_usd)) - parseFloat(String(a.attributes.reserve_in_usd))) || a.id.localeCompare(b.id))
  assert.deepEqual(orderPoolsForMarket(pools), legacy)
  assert.deepEqual(orderPoolsByLiquidity(pools), legacy)
  assert.equal(selectMarketPool(pools).rule, 'deepest_liquidity_fallback')
  assert.deepEqual(selectMarketPool([]), { pool: null, rule: 'none', metrics: null, activePoolCount: 0 })
})

test('chart alternates: market pool, then remaining active pools by the same ranking, then inactive by liquidity — deterministic', () => {
  const act1 = P('12', 20_000, 300_000, 500)
  const act2 = P('13', 900_000, 100_000, 50)
  const act3 = P('14', 5_000, 100_000, 80)
  const dead1 = P('15', 3_000_000, 0, 0)
  const dead2 = P('16', 8_000, 0, 0)
  const expected = [act1, act3, act2, dead1, dead2]
  for (const perm of [[dead1, act2, dead2, act3, act1], [act3, dead2, act1, dead1, act2], expected]) {
    assert.deepEqual(orderPoolsForMarket(perm), expected)
  }
})

test('metrics are robust to provider shapes: scalar txns, buy/sell keys, missing/NaN fields', () => {
  assert.equal(marketPoolMetrics({ id: 'x', attributes: { volume_usd: { h24: '5' }, transactions: { h24: 7 } } }).txns24h, 7)
  assert.equal(marketPoolMetrics({ id: 'x', attributes: { volume_usd: { h24: '5' }, transactions: { h24: { buy: 2, sell: 3 } } } }).txns24h, 5)
  const bad = marketPoolMetrics({ id: 'x', attributes: { reserve_in_usd: 'abc', volume_usd: { h24: null } } })
  assert.deepEqual([bad.reserveUsd, bad.volume24hUsd, bad.txns24h, bad.active], [0, 0, 0, false])
  assert.equal(marketPoolMetrics(null).active, false)
})

test('V4-only dormant token: the V4 pool stays the market and chart pool (honest V4 path unchanged)', () => {
  const s = selectMarketPool([POOL_A])
  assert.equal(s.pool, POOL_A)
  assert.equal(s.rule, 'deepest_liquidity_fallback')
  assert.equal(orderPoolsForMarket([POOL_A])[0], POOL_A)
})

// ── Route wiring: roles, field consistency, LP unchanged, no extra calls, cache ───────────────────
test('route: mainPool is the market pool; LP Safety keeps the liquidity order; chart uses market order', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /const matchingPools = orderPoolsByLiquidity\(gtAllPools\);\s*const liquidityPool = matchingPools\[0\] \?\? null;\s*const marketPoolSelection = selectMarketPool\(matchingPools\);\s*const mainPool = marketPoolSelection\.pool;/)
  assert.match(route, /const normalizedPools = matchingPools\.map\(\(p\) => normalizePool\(p, includedTokenById, gtIncluded\)\);/, 'LP pools stay in liquidity order')
  assert.match(route, /const canonicalPrimaryPool = normalizedPools\[0\] \?\? null/, 'LP Safety pool = deepest')
  assert.match(route, /const chartPoolCandidates = orderPoolsForMarket\(matchingPools\)/)
  assert.match(route, /const primaryAddr = chartPoolIdentifier\(mainPool as Record<string, unknown> \| null\)/)
  assert.doesNotMatch(route, /const chartPoolCandidates = \[mainPool, \.\.\.matchingPools/, 'no liquidity-first chart ordering left')
})

test('route: Market Pulse fields all read the market pool (price, liquidity, volume, txns, pair age, protocol, chart)', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /const _gtPoolLiquidity = pickNum\(mainPool\?\.attributes\?\.reserve_in_usd\)/)
  assert.match(route, /const _gtPoolVolume = pickNum\(\(mainPool\?\.attributes\?\.volume_usd/)
  assert.match(route, /const _txns = _gtPoolLiquidityLooksStale \? null : \(mainPoolAttr\.transactions/)
  assert.match(route, /const pairCreatedAt = String\(mainPoolAttr\.pool_created_at \?\? ''\)/)
  assert.match(route, /const _extractedDexId = \(\(\) => \{\s*if \(!mainPool\) return null/)
  assert.match(route, /const tokenPrice = pickNum\(marketPoolTokenPriceUsd, gtToken\?\.price_usd, gtToken\?\.price\)/)
  assert.match(route, /const marketPoolTokenPriceUsd = marketPoolTokenSide === 'quote' \? pickNum\(mainPoolAttr\.quote_token_price_usd\) : pickNum\(mainPoolAttr\.base_token_price_usd\)/, 'pool price is the scanned token\'s side')
  assert.match(route, /const _chartCacheKey = `evm-candles-v2:\$\{chain\}:\$\{contract\.toLowerCase\(\)\}:\$\{primaryAddr \|\| 'no_pool'\}/, 'chart cache key carries the market pool identity')
})

test('route: LP-only derivations stay on the liquidity pool', () => {
  const route = read('app/api/token/route.ts')
  assert.match(route, /extractPoolAddressOrId\(liquidityPool\?\.id, liquidityPoolAttr\.address\)/)
  assert.match(route, /const dexId = String\(liquidityPoolAttr\.dex_id \?\? liquidityPoolAttr\.dex \?\? ""\)/)
  assert.match(route, /const _lpRoleLiquidityUsd = mainPool === liquidityPool \? liquidityUsd : pickNum\(liquidityPool\?\.attributes\?\.reserve_in_usd\)/)
  assert.match(route, /_deriveMigrationProof\(gtAllPools, _lpRoleLiquidityUsd, Boolean\(lpPool\), lpControl\.primaryPoolDex \?\? null, _lpRolePoolCreatedAt\)/)
})

test('no extra provider calls: the selector is pure and the route fetches the same pool list once', () => {
  const lib = read('lib/marketPoolSelection.ts')
  assert.doesNotMatch(lib, /\bfetch\(|process\.env|from '\.\/server/)
  const route = read('app/api/token/route.ts')
  assert.equal((route.match(/fetchGeckoTerminal\(contract, chain\)/g) ?? []).length, 3, 'same call sites as before this change')
  assert.equal((route.match(/fetchDexScreenerFallback\(contract, chain\)/g) ?? []).length, 1)
})

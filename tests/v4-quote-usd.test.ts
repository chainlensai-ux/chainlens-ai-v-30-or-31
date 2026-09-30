// One-hop independent quote-token USD pricing for Uniswap V4 swap candles (lib/server/v4QuoteUsd.ts +
// lib/server/v4SwapCandlesRpc.ts). Fixture mirrors the live BANKAT / BNKR Base V4 pair: BANKAT is
// priced in BNKR by its V4 swaps, and BNKR/USD comes ONLY from an independent BNKR/WETH pool's own
// historical USD candles. Addresses are fixture values, not claims about the live contracts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { V4_INITIALIZE_TOPIC0, V4_POOL_MANAGER_ABI, V4_SWAP_TOPIC0, type RawEvmLog } from '../lib/v4SwapCandles.ts'
import { QUOTE_USD_MAX_GAP_MS, loadV4SwapCandles, resetV4SwapCandleCache, type V4SwapDeps } from '../lib/server/v4SwapCandlesRpc.ts'
import { QUOTE_POOL_MIN_LIQUIDITY_USD, quoteSeriesFromCandles, resetQuoteUsdCache, resolveIndependentQuoteUsd, selectIndependentQuotePool, type QuoteUsdDeps } from '../lib/server/v4QuoteUsd.ts'
import { EVM_MAX_OHLCV_CALLS, runEvmCandleLadder, type LadderPool } from '../lib/evmChartCandles.ts'

const POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
const V4_POOL = ('0x' + '3b8e6c1f'.repeat(8)) as Hex // BANKAT / BNKR V4 PoolId (fixture)
const BNKR = '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b'
const BANKAT = '0x7a1c3e5b9d2f4a6c8e0b1d3f5a7c9e1b3d5f7a9c'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ZORA = '0x1111111111166b7fe7bd91427724b487980afc69'
const BNKR_WETH_POOL = '0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703'
const BANKAT_BNKR_V2 = '0x' + '5c'.repeat(20)
const BNKR_ZORA_POOL = '0x' + '6d'.repeat(20)
const BNKR_USDC_THIN = '0x' + '7e'.repeat(20)
const ANCHORS = new Set(['0x0000000000000000000000000000000000000000', WETH, USDC, '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'])
const LATEST = 30_000_000
const LATEST_TS = 1_800_000_000 // divisible by 300
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`

// currency0 = BNKR (0x22… < 0x7a…), currency1 = BANKAT. price0in1 = BANKAT per BNKR.
function sqrtX96(price0in1Human: number): bigint {
  return BigInt(Math.round(Math.sqrt(price0in1Human) * 2 ** 96)) // both 18 decimals
}
function initLog(): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', args: { id: V4_POOL, currency0: BNKR as Hex, currency1: BANKAT as Hex } })
  const data = encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [10000, 200, '0x0000000000000000000000000000000000000000', sqrtX96(0.5), 0])
  return { address: POOL_MANAGER, topics: topics as string[], data, blockNumber: hex(LATEST - 5_000), logIndex: '0x0', removed: false }
}
function swapLog(block: number, bankatPerBnkr: number, bnkrIn: number, withTs = true, poolId: Hex = V4_POOL): RawEvmLog {
  const topics = encodeEventTopics({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', args: { id: poolId, sender: '0x000000000000000000000000000000000000beef' } })
  const amount0 = -BigInt(Math.round(bnkrIn * 1e6)) * BigInt(1e12) // BNKR paid in (18 dec)
  const amount1 = BigInt(Math.round(bnkrIn * bankatPerBnkr * 1e6)) * BigInt(1e12)
  const data = encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, sqrtX96(bankatPerBnkr), BigInt(1e21), 0, 10000])
  return { address: POOL_MANAGER, topics: topics as string[], data, blockNumber: hex(block), logIndex: '0x1', removed: false, ...(withTs ? { blockTimestamp: hex(LATEST_TS - (LATEST - block) * 2) } : {}) }
}

// BANKAT trades at 2.0, 2.2 and 1.9 BNKR each (the pool's price0in1 is the inverse: BANKAT per BNKR).
const SWAPS = [
  { block: LATEST - 900, bnkrPerBankat: 2.0, bnkrIn: 1000 }, // t = -1800s
  { block: LATEST - 600, bnkrPerBankat: 2.2, bnkrIn: 500 }, //  t = -1200s
  { block: LATEST - 30, bnkrPerBankat: 1.9, bnkrIn: 250 }, //   t = -60s
]
const tOf = (block: number) => LATEST_TS - (LATEST - block) * 2
// Independent BNKR/WETH pool's own 5m USD candles (newest first, CoinGecko shape). Candle [t, o,h,l,c,v]
// covers t..t+300; its close is the price at t+300, which is the point used for alignment.
const BNKR_USD_CANDLES = [
  [LATEST_TS - 300, 0.00049, 0.00049, 0.00047, 0.00048, 900], // close @ LATEST_TS
  [LATEST_TS - 1500, 0.00051, 0.00053, 0.0005, 0.00052, 800], // close @ -1200
  [LATEST_TS - 2100, 0.0005, 0.00051, 0.00049, 0.0005, 700], //  close @ -1800
]

function discoveryJson() {
  const pool = (address: string, base: string, quote: string, reserve: string, idHex = address) => ({
    id: `base_${idHex}`, type: 'pool', attributes: { address, name: 'x', reserve_in_usd: reserve },
    relationships: { base_token: { data: { id: `base_${base}`, type: 'token' } }, quote_token: { data: { id: `base_${quote}`, type: 'token' } } },
  })
  return {
    data: [
      pool(V4_POOL, BANKAT, BNKR, '9000000', V4_POOL), // the V4 pool being priced (64-hex) — never independent
      pool(BANKAT_BNKR_V2, BANKAT, BNKR, '8000000'), // contains the scanned token — circular
      pool(BNKR_ZORA_POOL, BNKR, ZORA, '7000000'), // third token — would need a second hop
      pool(BNKR_USDC_THIN, BNKR, USDC, String(QUOTE_POOL_MIN_LIQUIDITY_USD - 1)), // too thin
      pool(BNKR_WETH_POOL, BNKR, WETH, '2500000'), // the genuine independent anchor pool
    ],
    included: [
      { id: `base_${BNKR}`, type: 'token', attributes: { address: BNKR, symbol: 'BNKR', decimals: 18 } },
      { id: `base_${WETH}`, type: 'token', attributes: { address: WETH, symbol: 'WETH', decimals: 18 } },
    ],
  }
}

function quoteDeps(opts: { discovery?: unknown; candles?: unknown[][]; meta?: unknown } = {}) {
  const calls: string[] = []
  const deps: QuoteUsdDeps = {
    now: () => LATEST_TS * 1000,
    fetchTokenPools: async (_c, token) => { calls.push(`pools ${token}`); return { json: opts.discovery ?? discoveryJson(), httpStatus: 200 } },
    fetchPoolUsdOhlcv: async (_c, pool, side) => {
      calls.push(`ohlcv ${pool} ${side}`)
      return { json: { data: { attributes: { ohlcv_list: opts.candles ?? BNKR_USD_CANDLES } }, meta: opts.meta ?? { base: { address: BNKR, symbol: 'BNKR' }, quote: { address: WETH, symbol: 'WETH' } } }, httpStatus: 200 }
    },
  }
  return { deps, calls }
}

function chain(opts: { swaps?: RawEvmLog[]; quote?: ReturnType<typeof quoteDeps> } = {}) {
  const rpcCalls: string[] = []
  const q = opts.quote ?? quoteDeps()
  const deps: V4SwapDeps = {
    now: () => LATEST_TS * 1000,
    rpc: async (method, params) => {
      rpcCalls.push(method)
      if (method === 'eth_getBlockByNumber') return { result: { number: hex(LATEST), timestamp: hex(LATEST_TS) }, error: false }
      const f = params[0] as { topics: string[] }
      if (f.topics[0] === V4_INITIALIZE_TOPIC0) return { result: [initLog()], error: false }
      if (f.topics[0] === V4_SWAP_TOPIC0) return { result: opts.swaps ?? [...SWAPS.map((s) => swapLog(s.block, 1 / s.bnkrPerBankat, s.bnkrIn)), swapLog(LATEST - 40, 1 / 99, 5, true, ('0x' + 'ab'.repeat(32)) as Hex)], error: false }
      return { result: [], error: false }
    },
    ethUsdSeries: async () => { throw new Error('ETH/USD must not be requested for a BNKR-quoted pool') },
    quoteUsd: (input) => resolveIndependentQuoteUsd({ chain: 'base', ...input }, q.deps),
  }
  return { deps, rpcCalls, quoteCalls: q.calls }
}
const input = { chain: 'base', poolId: V4_POOL, token: BANKAT, tokenDecimals: 18, livePriceUsd: 1.9 * 0.00048 }
const reset = () => { resetV4SwapCandleCache(); resetQuoteUsdCache() }

// ── Independent pool selection ───────────────────────────────────────────────────────────────────
test('selection: only the liquid BNKR/WETH pool qualifies — V4 pool, scanned-token pool, third-token pool and thin pool rejected', () => {
  const { choice } = selectIndependentQuotePool(discoveryJson(), { quoteToken: BNKR, scannedToken: BANKAT, excludePool: V4_POOL, anchors: ANCHORS })
  assert.deepEqual(choice, { pool: BNKR_WETH_POOL, side: 'base', pairedWith: WETH, quoteSymbol: 'BNKR', quoteDecimals: 18, liquidityUsd: 2_500_000 })
})

test('same-pool / circular "independent" pricing is rejected', () => {
  const onlyBad = discoveryJson()
  onlyBad.data = onlyBad.data.filter((p) => p.attributes.address !== BNKR_WETH_POOL)
  const sel = selectIndependentQuotePool(onlyBad, { quoteToken: BNKR, scannedToken: BANKAT, excludePool: V4_POOL, anchors: ANCHORS })
  assert.equal(sel.choice, null)
  assert.equal(sel.detail, 'no_independent_quote_pool_with_eth_or_stable_liquidity')
  // Even an ordinary 20-byte pool is refused when it IS the pool being excluded.
  const sameAsExcluded = selectIndependentQuotePool(discoveryJson(), { quoteToken: BNKR, scannedToken: BANKAT, excludePool: BNKR_WETH_POOL, anchors: ANCHORS })
  assert.notEqual(sameAsExcluded.choice?.pool, BNKR_WETH_POOL)
})

test('one hop only: a quote token paired only with a third token gets no USD evidence (no TOKEN -> A -> B -> USD)', async () => {
  reset()
  const d = discoveryJson()
  d.data = d.data.filter((p) => p.attributes.address === BNKR_ZORA_POOL)
  const q = quoteDeps({ discovery: d })
  const r = await resolveIndependentQuoteUsd({ chain: 'base', quoteToken: BNKR, scannedToken: BANKAT, excludePool: V4_POOL, anchors: ANCHORS, budget: 5, deadlineMs: LATEST_TS * 1000 + 8000 }, q.deps)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'quote_usd_price_unproven')
  assert.deepEqual(q.calls, [`pools ${BNKR}`], 'no second discovery for ZORA — never recursive')
})

test('wrong token side: candles whose meta puts BNKR on the other side are rejected', () => {
  const json = { data: { attributes: { ohlcv_list: BNKR_USD_CANDLES } }, meta: { base: { address: WETH }, quote: { address: BNKR } } }
  const out = quoteSeriesFromCandles(json, 200, BNKR, 'base', 300)
  assert.equal(out.points, null)
  assert.equal(out.detail, 'quote_series_side_mismatch')
})

// ── BANKAT / BNKR end to end ─────────────────────────────────────────────────────────────────────
test('BANKAT/USD = (BNKR per BANKAT from V4 swaps) x (BNKR/USD from the independent pool), aligned per trade', async () => {
  reset()
  const c = chain()
  const r = await loadV4SwapCandles(input, c.deps)
  assert.equal(r.ok, true, `${r.code} ${r.quote?.reason}`)
  assert.equal(r.counterAsset, 'independent_quote')
  assert.equal(r.tokenCurrencyIndex, 1)
  assert.equal(r.logsFound, 3, 'the other PoolId\'s swap was ignored')
  assert.deepEqual([r.quote?.symbol, r.quote?.source, r.quote?.pool, r.quote?.pairedWith, r.quote?.evidence, r.quote?.points], ['BNKR', 'independent_pool', BNKR_WETH_POOL, WETH, 'verified', 3])
  assert.equal(r.quote?.maxGapMs, 60_000, 'largest trade-to-quote-point distance actually used: 1 minute')
  const near = (a: number, b: number) => Math.abs(a - b) / b < 1e-9
  // Trade t=-1800 -> BNKR $0.00050 (close @ -1800); t=-1200 -> $0.00052; t=-60 -> $0.00048 (close @ 0).
  const expected = [
    { t: tOf(SWAPS[0].block), usd: 2.0 * 0.0005, vol: 1000 * 0.0005 },
    { t: tOf(SWAPS[1].block), usd: 2.2 * 0.00052, vol: 500 * 0.00052 },
    { t: tOf(SWAPS[2].block), usd: 1.9 * 0.00048, vol: 250 * 0.00048 },
  ]
  assert.equal(r.candles.length, 3)
  r.candles.forEach((k, i) => {
    assert.equal(Date.parse(k.timestamp) / 1000, Math.floor(expected[i].t / 300) * 300)
    assert.ok(near(k.open, expected[i].usd) && near(k.high, expected[i].usd) && near(k.low, expected[i].usd) && near(k.close, expected[i].usd), `candle ${i}: ${k.close} vs ${expected[i].usd}`)
    assert.ok(near(k.volume!, expected[i].vol), `volume ${i}: ${k.volume} vs ${expected[i].vol}`)
  })
  assert.ok(near(r.candles[2].close, 0.000912), '1.9 BNKR x $0.00048 = $0.000912')
})

test('stale quote point: a trade with no BNKR/USD point within 15 minutes is dropped, never priced from a far point', async () => {
  reset()
  // Only the newest BNKR candle: the -1800s and -1200s trades are 30 and 20 minutes from it.
  const c = chain({ quote: quoteDeps({ candles: [BNKR_USD_CANDLES[0], [LATEST_TS - 7200, 0.0006, 0.0006, 0.0006, 0.0006, 1]] }) })
  const r = await loadV4SwapCandles(input, c.deps)
  assert.equal(QUOTE_USD_MAX_GAP_MS, 15 * 60_000)
  assert.equal(r.tradesUsed, 1)
  assert.equal(r.code, 'v4_swap_history_empty', 'one real priced trade is not a chart')
  reset()
  const allStale = chain({ quote: quoteDeps({ candles: [[LATEST_TS - 36_000, 0.0006, 0.0006, 0.0006, 0.0006, 1], [LATEST_TS - 36_300, 0.0006, 0.0006, 0.0006, 0.0006, 1]] }) })
  const r2 = await loadV4SwapCandles(input, allStale.deps)
  assert.equal(r2.code, 'quote_usd_price_unproven')
  assert.equal(r2.quote?.reason, 'no_quote_usd_point_within_15m_of_any_trade')
})

test('unavailable quote evidence stays honest: quote_usd_price_unproven with the reason, zero page calls spent', async () => {
  reset()
  const d = discoveryJson()
  d.data = d.data.filter((p) => p.attributes.address !== BNKR_WETH_POOL)
  const c = chain({ quote: quoteDeps({ discovery: d }) })
  const r = await loadV4SwapCandles(input, c.deps)
  assert.equal(r.code, 'quote_usd_price_unproven')
  assert.deepEqual([r.quote?.evidence, r.quote?.reason], ['unavailable', 'no_independent_quote_pool_with_eth_or_stable_liquidity'])
  assert.ok(!c.rpcCalls.slice(2).includes('eth_getLogs'), 'failed fast before any swap-log page')
})

// ── Budget and cache ─────────────────────────────────────────────────────────────────────────────
test('cold BNKR-quoted scan: 5 calls (header, Initialize, discovery, BNKR history, 1 swap page); cache hit: 0', async () => {
  reset()
  const c = chain()
  const r = await loadV4SwapCandles(input, c.deps)
  assert.equal(r.callsUsed, 5)
  assert.deepEqual(c.quoteCalls, [`pools ${BNKR}`, `ohlcv ${BNKR_WETH_POOL} base`])
  const again = chain()
  const hit = await loadV4SwapCandles(input, again.deps)
  assert.deepEqual([hit.callsUsed, again.rpcCalls.length, again.quoteCalls.length], [0, 0, 0])
  resetV4SwapCandleCache() // drop only the V4 result + Initialize caches: the BNKR quote caches stay warm
  const warmQuote = chain()
  const r3 = await loadV4SwapCandles(input, warmQuote.deps)
  assert.equal(warmQuote.quoteCalls.length, 0, 'discovery (24h) and BNKR history (10-min slot) reused across scans')
  assert.equal(r3.callsUsed, 3)
})

test('budget: the quote lane never overspends and always leaves a call for a swap page; tight budgets stop honestly', async () => {
  for (const budget of [2, 3, 4]) {
    reset()
    const c = chain()
    const r = await loadV4SwapCandles(input, c.deps, budget)
    assert.ok(r.callsUsed <= budget, `budget ${budget}: used ${r.callsUsed}`)
    assert.equal(r.code, 'call_budget_exhausted', `budget ${budget}`)
  }
  reset()
  const five = await loadV4SwapCandles(input, chain().deps, 5)
  assert.equal(five.ok, true)
  assert.equal(five.callsUsed, 5)
})

test('whole candle path stays <= 10 calls with the BNKR quote lane included', async () => {
  reset()
  const c = chain()
  const rel = { base_token: { data: { id: `base_${BANKAT}` } }, quote_token: { data: { id: `base_${BNKR}` } } }
  const pool = (id: string): LadderPool => ({ poolId: `base_${id}`, address: id, name: 'BANKAT / BNKR', liquidityUsd: 1e5, pool: { id: `base_${id}`, relationships: rel } })
  let v4Calls = 0
  const r = await runEvmCandleLadder({ pools: [pool(V4_POOL), pool('0x' + '7a'.repeat(20)), pool('0x' + '7b'.repeat(20))], contract: BANKAT, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: input.livePriceUsd }, {
    fetchCoingeckoPoolOhlcv: async () => ({ httpStatus: 404, json: null }),
    fetchPoolOhlcv: async () => ({ httpStatus: 404, json: null }),
    fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
    fetchV4SwapCandles: async (_p, budget) => { const v = await loadV4SwapCandles(input, c.deps, budget); v4Calls = v.callsUsed; return v },
  })
  assert.equal(r.candleProvider, 'v4_swap_events')
  assert.equal(v4Calls, 5)
  assert.equal(r.totalHttpCalls, 5, 'market V4 pool charted first from its own swaps: 5 for the V4/BNKR lane, no alternate reads')
  assert.ok(r.totalHttpCalls <= EVM_MAX_OHLCV_CALLS)
  assert.equal(r.v4Swap?.quote?.source, 'independent_pool')
})

// ── Preserved paths ──────────────────────────────────────────────────────────────────────────────
test('USDC and WETH quote paths never touch the independent quote lane', () => {
  const src = readFileSync(new URL('../lib/server/v4SwapCandlesRpc.ts', import.meta.url), 'utf8')
  assert.match(src, /if \(r\.counterAsset === 'other'\) \{/, 'the quote lane runs only for tokens that are neither ETH/WETH nor a verified stable')
  const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  assert.match(route, /quoteUsd: \(q\) => resolveIndependentQuoteUsd\(\{ chain, \.\.\.q \}/)
  assert.match(route, /fetchCoingeckoOnchainPoolOhlcv\(chain, quotePool, QUOTE_SERIES_REQUEST, side\)/)
})

// Token Scanner chart audit regressions (all chains / pool models). Each block pins one audited rule:
//   EVM   — proven-side series must still pass the provider's own side meta and the live-price band;
//           base- and quote-side scans request the scanned token's own side; the 5M lane checks meta.
//   MERGE — initial + history overlap yields one candle per timestamp, today's day once, no double volume.
//   1D    — long history rolls up to UTC days; a young pool shows only its real days; the first 1D batch
//           replaces the short scan chart in one update; V4 history reports its end evidence.
//   PRICE/MCAP — the same candle timestamps, no refetch.
//   SOLANA — its own lane: exact-case identity, proven side (never a base default), active market pair,
//           live-price band, and genuine hourly older history with evidence-based end.
// Addresses below are fixtures unless stated otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EVM_CHART_NETWORK, runEvmCandleLadder, seriesPassesLivePriceSanity, type LadderDeps, type LadderFetchResult, type LadderPool } from '../lib/evmChartCandles.ts'
import { loadOnDemandCandles, rememberVerifiedChartPool, resetOnDemandCandleState } from '../lib/server/chartCandlesOnDemand.ts'
import { aggregateCandles, buildChartTimeframes, normalizeChartCandles, type ChartCandle } from '../lib/priceChartCandles.ts'
import { DAILY_FIRST_BATCH_MIN_CANDLES, historyCutoffMs, loadHistoryBatch, withHistory, type HistoryWindowResult } from '../lib/chartHistory.ts'
import { scaleCandlesToMarketCap } from '../lib/chartMarketCap.ts'
import { fetchSolanaOhlcv } from '../lib/server/solanaProviders.ts'
import { analyzeSolanaMarket, selectSolanaChartPair } from '../lib/server/solana/marketAnalyzer.ts'
import { loadSolanaPoolHistory, resetSolanaChartHistoryState, resolveSolanaGtPoolSide, SOLANA_HISTORY_MAX_PROVIDER_CALLS } from '../lib/server/solanaChartHistory.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'
const WETH = '0x4200000000000000000000000000000000000006'
const P1 = '0x1111111111111111111111111111111111111111'
const P2 = '0x2222222222222222222222222222222222222222'
const END = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000)
const H = 3_600_000
const DAY = 86_400_000

const rows = (n: number, stepSec: number, close = 1.05) => Array.from({ length: n }, (_, i) => [END - i * stepSec, close, close * 1.05, close * 0.95, close, 10 + i])
const ohlcv = (n: number, stepSec = 900, close = 1.05, meta?: unknown): LadderFetchResult => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: rows(n, stepSec, close) } }, ...(meta ? { meta } : {}) } })
function pool(net: string, address: string, side: 'base' | 'quote'): LadderPool {
  const rel = { base_token: { data: { id: `${net}_${side === 'base' ? TOKEN : WETH}` } }, quote_token: { data: { id: `${net}_${side === 'base' ? WETH : TOKEN}` } } }
  return { poolId: `${net}_${address}`, address, name: 'TKN / WETH', liquidityUsd: 100_000, pool: { id: `${net}_${address}`, relationships: rel } }
}

// ── EVM: proven side still has to pass meta + live price ─────────────────────────────────────────
for (const chain of ['base', 'eth', 'bnb', 'robinhood'] as const) {
  const net = EVM_CHART_NETWORK[chain]
  test(`${chain}: base-side and quote-side scans request the scanned token's own side`, async () => {
    for (const side of ['base', 'quote'] as const) {
      const sides: string[] = []
      const d: LadderDeps = { fetchPoolOhlcv: async (_a, _r, s) => { sides.push(s); return ohlcv(672) }, fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }) }
      const r = await runEvmCandleLadder({ pools: [pool(net, P1, side)], contract: TOKEN, networkId: net, currentPriceUsd: 1 }, d)
      assert.deepEqual([sides, r.chartCandles?.tokenSide, r.candleProvider], [[side], side, 'geckoterminal'])
    }
  })

  test(`${chain}: a proven-side series far from the live price is rejected (price_sanity_mismatch); the next pool is used`, async () => {
    const calls: string[] = []
    const d: LadderDeps = {
      // P1 returns a WETH-priced series ($3000) for a $1 token; P2 returns the token's own price.
      fetchPoolOhlcv: async (a: string) => { calls.push(a); return a === P1 ? ohlcv(672, 900, 3000) : ohlcv(672, 900, 1.02) },
      fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
    }
    const r = await runEvmCandleLadder({ pools: [pool(net, P1, 'base'), pool(net, P2, 'base')], contract: TOKEN, networkId: net, currentPriceUsd: 1 }, d)
    assert.equal(r.selectedPool?.address, P2)
    assert.ok(r.attempts.some((a) => a.poolAddress === P1 && a.code === 'price_sanity_mismatch'))
    assert.deepEqual(calls, [P1, P2], 'the mismatched pool is not retried at other rungs')
  })

  test(`${chain}: provider meta naming the token on the OTHER side rejects the series (token_identity_unverified)`, async () => {
    const meta = { base: { address: WETH }, quote: { address: TOKEN } } // token is quote per meta
    const d: LadderDeps = {
      fetchPoolOhlcv: async (a: string) => (a === P1 ? ohlcv(672, 900, 1, meta) : ohlcv(672, 900, 1)),
      fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
    }
    const r = await runEvmCandleLadder({ pools: [pool(net, P1, 'base'), pool(net, P2, 'base')], contract: TOKEN, networkId: net, currentPriceUsd: 1 }, d)
    assert.equal(r.selectedPool?.address, P2)
    assert.ok(r.attempts.some((a) => a.poolAddress === P1 && a.code === 'token_identity_unverified'))
  })
}

test('CoinGecko proven side: meta on the other side or a far close falls through to GeckoTerminal', async () => {
  for (const cgJson of [ohlcv(672, 900, 1, { base: { address: WETH }, quote: { address: TOKEN } }), ohlcv(672, 900, 50)]) {
    const d: LadderDeps = {
      fetchCoingeckoPoolOhlcv: async () => cgJson,
      fetchPoolOhlcv: async () => ohlcv(672, 900, 1),
      fetchTrades: async () => ({ httpStatus: 200, json: { data: [] } }),
    }
    const r = await runEvmCandleLadder({ pools: [pool('base', P1, 'base')], contract: TOKEN, networkId: 'base', coingeckoNetworkId: 'base', currentPriceUsd: 1 }, d)
    assert.equal(r.candleProvider, 'geckoterminal')
    assert.ok(['token_identity_unverified', 'price_sanity_mismatch'].includes(String(r.attempts[0].code)))
  }
})

test('no live price: a proven side stands on its own (unchanged behavior)', () => {
  const pts = [{ timestamp: 'x', open: 1, high: 1, low: 1, close: 3000, volume: 1, priceUsd: 3000 }]
  assert.equal(seriesPassesLivePriceSanity(pts, null), true)
  assert.equal(seriesPassesLivePriceSanity(pts, 1), false)
  assert.equal(seriesPassesLivePriceSanity(pts, 2000), true)
})

test('on-demand 5M: CoinGecko meta on the other side is not used; GeckoTerminal is asked for the proven side', async () => {
  resetOnDemandCandleState()
  rememberVerifiedChartPool('base', TOKEN, P1, 'base')
  const urls: string[] = []
  const five = Array.from({ length: 288 }, (_, i) => [END - i * 300, 1, 1.1, 0.9, 1.05, 5])
  const out = await loadOnDemandCandles({ chain: 'base', token: TOKEN, pool: P1, timeframe: '5m' }, async (url) => { urls.push(url); return { httpStatus: 200, json: { data: { attributes: { ohlcv_list: five } } } } }, {
    fetchCoingecko: async () => ({ httpStatus: 200, json: { data: { attributes: { ohlcv_list: five } }, meta: { base: { address: WETH }, quote: { address: TOKEN } } } }),
  })
  assert.equal(out.result.ok, true)
  assert.equal(out.result.ok && out.result.source, 'geckoterminal')
  assert.match(urls[0], /token=base/)
})

// ── Merge / dedupe / 1D ──────────────────────────────────────────────────────────────────────────
const hourly = (fromMs: number, toMs: number, px = 1): Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> => {
  const out = []
  for (let t = fromMs; t < toMs; t += H) out.push({ timestamp: t, open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 10 })
  return out
}
const fifteen = (endMs: number, n: number) => normalizeChartCandles(Array.from({ length: n }, (_, i) => ({ timestamp: endMs - (n - 1 - i) * 900_000, open: 2, high: 2.1, low: 1.9, close: 2, volume: 3 })))

test('initial hour X + history hour X => exactly one candle for X; scan evidence wins; no double volume', async () => {
  const now = Date.UTC(2026, 8, 29, 14, 0)
  const scan = fifteen(now, 672) // 7 days of 15m
  const cutoff = historyCutoffMs(scan)!
  // History overlaps the cutoff by 5 hours (hours the scan already holds).
  const out = await loadHistoryBatch({
    start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[scan.length - 1].t, maxRequests: 1, targetSpanSec: null,
    load: async () => ({ ok: true, points: hourly(cutoff - 10 * DAY, cutoff + 5 * H, 9), hasMore: true, nextBeforeSec: cutoff / 1000 - 10 * 86_400 }),
  })
  const tf = withHistory(buildChartTimeframes(scan, 900), out.candles, cutoff)
  const h1 = tf.timeframes.find((t) => t.key === '1H')!.candles
  assert.equal(new Set(h1.map((c) => c.t)).size, h1.length, 'unique hours')
  const overlap = h1.filter((c) => c.t >= cutoff && c.t < cutoff + 5 * H)
  assert.ok(overlap.every((c) => c.close === 2 && c.volume === 12), 'hours >= cutoff come from the scan (4 x 15m x 3 volume), never the history copy')
  const d1 = tf.timeframes.find((t) => t.key === '1D')!.candles
  assert.equal(new Set(d1.map((c) => c.t)).size, d1.length)
  assert.ok(d1.every((c) => c.t % DAY === 0), 'UTC day boundaries')
  assert.equal(d1.filter((c) => c.t === Date.UTC(2026, 8, 29)).length, 1, "today's partial day appears once")
  const totalVol = h1.reduce((s, c) => s + (c.volume ?? 0), 0)
  assert.equal(d1.reduce((s, c) => s + (c.volume ?? 0), 0), totalVol, 'daily volume = sum of hourly, no double count')
})

test('long 1D history: 60+ real days after one batch; OHLC per UTC day is first/max/min/last', async () => {
  const now = Date.UTC(2026, 8, 29, 14, 0)
  const scan = fifteen(now, 672)
  const cutoff = historyCutoffMs(scan)!
  const windows: HistoryWindowResult[] = [
    { ok: true, points: hourly(cutoff - 41 * DAY, cutoff, 1), hasMore: true, nextBeforeSec: cutoff / 1000 - 41 * 86_400 },
    { ok: true, points: hourly(cutoff - 82 * DAY, cutoff - 41 * DAY, 1), hasMore: true, nextBeforeSec: cutoff / 1000 - 82 * 86_400 },
  ]
  let i = 0
  const out = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[scan.length - 1].t, maxRequests: 3, targetSpanSec: 60 * 86_400, load: async () => windows[i++] })
  assert.equal(out.requests, 2, 'stops once the 60-day target is covered')
  const d1 = withHistory(buildChartTimeframes(scan, 900), out.candles, cutoff).timeframes.find((t) => t.key === '1D')!.candles
  assert.ok(d1.length >= 60, `${d1.length} daily candles`)
  assert.ok(d1.length >= DAILY_FIRST_BATCH_MIN_CANDLES)
  const day: ChartCandle[] = normalizeChartCandles([{ timestamp: Date.UTC(2026, 0, 1, 1), open: 1, high: 5, low: 0.5, close: 2, volume: 1 }, { timestamp: Date.UTC(2026, 0, 1, 7), open: 2, high: 4.5, low: 0.2, close: 4, volume: 2 }])
  assert.deepEqual(aggregateCandles(day, 86_400), [{ t: Date.UTC(2026, 0, 1), open: 1, high: 5, low: 0.2, close: 4, volume: 3 }])
})

test('young pool: 2 real days => 2 daily candles; nothing fabricated for missing days; end reason kept', async () => {
  const now = Date.UTC(2026, 8, 29, 14, 0)
  const scan = fifteen(now, 4 * 38) // ~38h of trading, spanning two UTC days
  const cutoff = historyCutoffMs(scan)!
  const out = await loadHistoryBatch({ start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[scan.length - 1].t, maxRequests: 3, targetSpanSec: 60 * 86_400, load: async () => ({ ok: true, points: [], hasMore: false, nextBeforeSec: null, endReason: 'reached_pool_creation' }) })
  assert.deepEqual([out.requests, out.hasMore, out.endReason], [1, false, 'reached_pool_creation'])
  const d1 = withHistory(buildChartTimeframes(scan, 900), out.candles, cutoff).timeframes.find((t) => t.key === '1D')!
  assert.equal(d1.candles.length, 2)
})

test('1D first batch: the panel keeps the previous timeframe until a useful daily series is applied', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /dailyCandleCount < DAILY_FIRST_BATCH_MIN_CANDLES/)
  assert.equal(DAILY_FIRST_BATCH_MIN_CANDLES, 30)
})

test('V4 history reports its end evidence (reached_pool_creation / max_history_age) through the route', () => {
  const rpc = read('lib/server/v4SwapCandlesRpc.ts')
  assert.match(rpc, /stopReason: 'pool_creation', endReason: 'reached_pool_creation'/)
  assert.match(rpc, /r\.endReason = r\.hasMore \? null : reachedCreation \? 'reached_pool_creation' : 'max_history_age'/)
  assert.match(read('app/api/token/chart-candles/route.ts'), /endReason: h\.endReason \?\? null, windowEndSec: h\.windowEndSec, source: 'v4_swap_events'/)
})

test('PRICE <-> MCAP: same timestamps and candle count, volume untouched, no new data', () => {
  const price = fifteen(Date.UTC(2026, 8, 29), 96)
  const mcap = scaleCandlesToMarketCap(price, 1_000_000)
  assert.deepEqual(mcap.map((c) => c.t), price.map((c) => c.t))
  assert.deepEqual(mcap.map((c) => c.volume), price.map((c) => c.volume))
  assert.ok(mcap.every((c, i) => c.close === price[i].close * 1_000_000))
})

// ── Solana ───────────────────────────────────────────────────────────────────────────────────────
const MINT = 'So1anaMintCaseSensitiveAAAAAAAAAAAAAAAAAAAB' // fixture base58
const MINT_LOWER_TWIN = 'so1anaMintCaseSensitiveAAAAAAAAAAAAAAAAAAAB'
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL = 'So11111111111111111111111111111111111111112'
const DEEP_IDLE = 'DeepIdLePoo1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ACTIVE = 'ActivePoo1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const QUOTE_SIDE = 'QuoteSidePoo1CCCCCCCCCCCCCCCCCCCCCCCCCCCCC'

const pair = (pairAddress: string, base: string, quote: string, liq: number, vol: number, txns: number, priceUsd = '1') => ({
  chainId: 'solana', pairAddress, dexId: 'raydium', baseToken: { address: base, symbol: 'B' }, quoteToken: { address: quote, symbol: 'Q' },
  liquidity: { usd: liq }, volume: { h24: vol }, txns: { h24: { buys: Math.ceil(txns / 2), sells: Math.floor(txns / 2) } }, priceUsd,
})

test('solana: the chart pair is the ACTIVE market pair, not the deepest idle one; exact-case identity', () => {
  const pairs = [pair(DEEP_IDLE, MINT, SOL, 5_000_000, 0, 0), pair(ACTIVE, MINT, USDC_SOL, 50_000, 900_000, 400), pair('Twin', MINT_LOWER_TWIN, SOL, 9e9, 9e9, 9e9)]
  assert.deepEqual(selectSolanaChartPair(pairs, MINT), { pairAddress: ACTIVE, side: 'base', rule: 'active_market' })
  // Only idle pairs: deepest as an honest fallback. A case-twin mint's pair never qualifies.
  assert.deepEqual(selectSolanaChartPair([pair(DEEP_IDLE, MINT, SOL, 5e6, 0, 0), pair('Twin', MINT_LOWER_TWIN, SOL, 9e9, 9e9, 9e9)], MINT), { pairAddress: DEEP_IDLE, side: 'base', rule: 'liquidity_fallback' })
  assert.equal(selectSolanaChartPair([pair('Twin', MINT_LOWER_TWIN, SOL, 9e9, 9e9, 9e9)], MINT), null)
  // Quote-side mint in the active pair: side 'quote'.
  assert.deepEqual(selectSolanaChartPair([pair(QUOTE_SIDE, USDC_SOL, MINT, 10_000, 5_000, 20)], MINT), { pairAddress: QUOTE_SIDE, side: 'quote', rule: 'active_market' })
})

test('solana: analyzeSolanaMarket keeps primaryPoolAddress (deepest) and adds the chart pair separately', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ pairs: [pair(DEEP_IDLE, MINT, SOL, 5_000_000, 0, 0), pair(ACTIVE, MINT, USDC_SOL, 50_000, 900_000, 400)] }), { status: 200 })) as unknown as typeof fetch
  const m = await analyzeSolanaMarket(MINT, fetchImpl)
  assert.deepEqual([m.data?.primaryPoolAddress, m.data?.chartPoolAddress, m.data?.chartPoolTokenSide, m.data?.chartPoolRule], [DEEP_IDLE, ACTIVE, 'base', 'active_market'])
})

function gtSolana(urls: string[], close: number) {
  return (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const t = END
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[t + 900, close, close, close, close, 20], [t, close, close, close, close, 10]] } } }), { status: 200 })
  }) as typeof fetch
}

test('solana ohlcv: unresolved side => no request; far close vs live price => price_sanity_mismatch; exact pool kept', async () => {
  const urls: string[] = []
  const none = await fetchSolanaOhlcv(ACTIVE, gtSolana(urls, 1), null, 1)
  assert.deepEqual([urls.length, none.success, none.errorReason], [0, false, 'token_side_unresolved'])
  const far = await fetchSolanaOhlcv(ACTIVE, gtSolana(urls, 150), 'quote', 1)
  assert.deepEqual([far.success, far.errorReason], [false, 'price_sanity_mismatch'])
  const ok = await fetchSolanaOhlcv(ACTIVE, gtSolana(urls, 1.2), 'quote', 1)
  assert.deepEqual([ok.success, ok.poolAddress, ok.tokenSide], [true, ACTIVE, 'quote'])
  assert.match(urls[urls.length - 1], new RegExp(`/networks/solana/pools/${ACTIVE}/ohlcv/minute\\?aggregate=15&limit=672&currency=usd&token=quote`))
})

// Solana older history
const SOL_NOW = END + 3600
const hourRows = (beforeSec: number, n: number) => Array.from({ length: n }, (_, i) => [beforeSec - 3600 * (i + 1), 1, 1.1, 0.9, 1.05, 7])
function solFetch(opts: { side?: 'base' | 'quote'; mintInPool?: string; createdSec?: number | null; rows?: (url: string) => unknown[]; meta?: unknown }, urls: string[]) {
  return async (url: string) => {
    urls.push(url)
    if (/\/pools\/[^/]+$/.test(url)) {
      const m = opts.mintInPool ?? MINT
      const rel = opts.side === 'quote'
        ? { base_token: { data: { id: `solana_${SOL}` } }, quote_token: { data: { id: `solana_${m}` } } }
        : { base_token: { data: { id: `solana_${m}` } }, quote_token: { data: { id: `solana_${SOL}` } } }
      return { httpStatus: 200, json: { data: { id: `solana_${ACTIVE}`, attributes: { pool_created_at: opts.createdSec ? new Date(opts.createdSec * 1000).toISOString() : null }, relationships: rel } } }
    }
    const before = Number(/before_timestamp=(\d+)/.exec(url)?.[1])
    return { httpStatus: 200, json: { data: { attributes: { ohlcv_list: opts.rows ? opts.rows(url) : hourRows(before, 1000) } }, ...(opts.meta ? { meta: opts.meta } : {}) } }
  }
}

test('solana history: exact-case proof, hourly before cursor, strictly decreasing cursor, <= 2 calls, cached', async () => {
  resetSolanaChartHistoryState()
  const urls: string[] = []
  const f = solFetch({ side: 'quote' }, urls)
  const a = await loadSolanaPoolHistory({ mint: MINT, pool: ACTIVE, side: 'quote', before: END }, f, { now: () => SOL_NOW * 1000 })
  assert.equal(a.result.ok, true)
  assert.ok(a.providerCalls <= SOLANA_HISTORY_MAX_PROVIDER_CALLS)
  assert.match(urls[0], new RegExp(`/networks/solana/pools/${ACTIVE}$`), 'pool id case preserved')
  assert.match(urls[1], /\/ohlcv\/hour\?aggregate=1&limit=1000&currency=usd&token=quote&before_timestamp=/)
  if (!a.result.ok) return
  assert.ok(a.result.points.every((p) => Date.parse(p.timestamp) / 1000 < END))
  assert.ok(a.result.hasMore && a.result.nextBeforeSec != null && a.result.nextBeforeSec < END)
  const b = await loadSolanaPoolHistory({ mint: MINT, pool: ACTIVE, side: 'quote', before: a.result.nextBeforeSec! }, f, { now: () => SOL_NOW * 1000 })
  assert.equal(b.providerCalls, 1, 'side proof cached')
  assert.ok(b.result.ok && b.result.nextBeforeSec! < a.result.nextBeforeSec!)
  const again = await loadSolanaPoolHistory({ mint: MINT, pool: ACTIVE, side: 'quote', before: END }, f, { now: () => SOL_NOW * 1000 })
  assert.deepEqual([again.cacheHit, again.providerCalls], [true, 0])
})

test('solana history: lowercased mint, wrong claimed side, case-twin pool token and meta mismatch are all rejected', async () => {
  resetSolanaChartHistoryState()
  const urls: string[] = []
  const lower = await loadSolanaPoolHistory({ mint: MINT_LOWER_TWIN, pool: ACTIVE, side: 'base', before: END }, solFetch({ side: 'base' }, urls), { now: () => SOL_NOW * 1000 })
  assert.equal(!lower.result.ok && lower.result.code, 'token_side_unresolved', 'the pool names MINT, not its lowercase twin')
  resetSolanaChartHistoryState()
  const wrongSide = await loadSolanaPoolHistory({ mint: MINT, pool: ACTIVE, side: 'base', before: END }, solFetch({ side: 'quote' }, urls), { now: () => SOL_NOW * 1000 })
  assert.equal(!wrongSide.result.ok && wrongSide.result.code, 'token_side_unresolved')
  resetSolanaChartHistoryState()
  const twin = await loadSolanaPoolHistory({ mint: MINT, pool: ACTIVE, side: 'base', before: END }, solFetch({ side: 'base', mintInPool: MINT_LOWER_TWIN }, urls), { now: () => SOL_NOW * 1000 })
  assert.equal(!twin.result.ok && twin.result.code, 'token_side_unresolved')
  resetSolanaChartHistoryState()
  const meta = await loadSolanaPoolHistory({ mint: MINT, pool: ACTIVE, side: 'base', before: END }, solFetch({ side: 'base', meta: { base: { address: SOL }, quote: { address: MINT } } }, urls), { now: () => SOL_NOW * 1000 })
  assert.equal(!meta.result.ok && meta.result.code, 'token_identity_unverified')
  const bad = await loadSolanaPoolHistory({ mint: '0xnot-base58', pool: ACTIVE, side: 'base', before: END }, solFetch({}, urls), { now: () => SOL_NOW * 1000 })
  assert.equal(!bad.result.ok && bad.result.code, 'invalid_request')
  assert.equal(resolveSolanaGtPoolSide({ relationships: { base_token: { data: { id: `solana_${MINT}` } } } }, MINT), 'base')
  assert.equal(resolveSolanaGtPoolSide({ relationships: { base_token: { data: { id: `solana_${MINT}` } } } }, MINT_LOWER_TWIN), null)
})

test('solana history: end only on evidence — zero rows, pool creation, or a non-advancing cursor; a short page keeps going', async () => {
  const run = async (opts: Parameters<typeof solFetch>[0]) => { resetSolanaChartHistoryState(); return (await loadSolanaPoolHistory({ mint: MINT, pool: ACTIVE, side: 'base', before: END }, solFetch({ side: 'base', ...opts }, []), { now: () => SOL_NOW * 1000 })).result }
  const empty = await run({ rows: () => [] })
  assert.deepEqual(empty.ok && [empty.hasMore, empty.endReason], [false, 'no_older_candles'])
  const created = await run({ createdSec: END - 5 * 3600, rows: () => hourRows(END, 5) })
  assert.deepEqual(created.ok && [created.hasMore, created.endReason, created.points.length], [false, 'reached_pool_creation', 5])
  const notAdvancing = await run({ rows: () => [[END, 1, 1, 1, 1, 1], [END + 3600, 1, 1, 1, 1, 1]] })
  assert.deepEqual(notAdvancing.ok && [notAdvancing.hasMore, notAdvancing.endReason], [false, 'history_cursor_not_advancing'])
  const short = await run({ rows: () => hourRows(END, 3) })
  assert.deepEqual(short.ok && [short.hasMore, short.endReason], [true, null], 'a short page is not the end')
})

test('solana wiring: route lane before EVM checks; panel gets the exact-case loader; clear unavailable reasons', () => {
  const route = read('app/api/token/chart-candles/route.ts')
  assert.ok(route.indexOf("if (chain === 'solana')") > 0 && route.indexOf("if (chain === 'solana')") < route.indexOf('if (/^0x[a-fA-F0-9]{40}$/.test(pool))'))
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /loadHistory=\{makeSolanaHistoryLoader\(sr\.mintAddress, sr\.ohlcv\.poolAddress, sr\.ohlcv\.tokenSide\)\}/)
  assert.doesNotMatch(page.slice(page.indexOf('function makeSolanaHistoryLoader'), page.indexOf('function solanaChartUnavailableText')), /toLowerCase/)
  assert.match(page, /reason === 'token_side_unresolved'/)
  assert.match(page, /reason === 'price_sanity_mismatch'/)
  const merge = read('lib/server/solana/providerMerge.ts')
  assert.match(merge, /analyzeSolanaCandles\(chartPool, fetchImpl, chartSide, chartLivePrice, mintAddress\)/)
})

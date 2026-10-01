// Solana Token Scanner chart parity: exact-case pool + proven side end to end, deterministic provider
// rows (never rewritten), truthful debug/coverage, on-demand 5M / 1M ONLY when the provider proves the
// interval for the same exact pool, latest-close freshness, and history ends only on evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchSolanaOhlcv } from '../lib/server/solanaProviders.ts'
import {
  GENUINE_INTERVAL_MIN_PROOF_ROWS, SOLANA_INTRADAY_REQUEST, isGenuineIntervalSeries, loadSolanaPoolHistory, loadSolanaPoolIntraday,
  resetSolanaChartHistoryState,
} from '../lib/server/solanaChartHistory.ts'
import { auditLatestClose, LATEST_CANDLE_STALE_MIN_SEC } from '../lib/chartMarketCap.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const MINT = 'So1anaMintCaseSensitiveAAAAAAAAAAAAAAAAAAAB'
const MINT_LOWER_TWIN = 'so1anaMintCaseSensitiveAAAAAAAAAAAAAAAAAAAB'
const SOL = 'So11111111111111111111111111111111111111112'
const POOL = 'ActivePoo1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const POOL_LOWER = 'activePoo1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const NOW = 1_800_000_000 - (1_800_000_000 % 3600)

// GeckoTerminal fake for the Solana lanes: pool record (side proof) + minute/hour OHLCV.
function gt(opts: { side?: 'base' | 'quote'; mintInPool?: string; rows?: (url: string) => unknown[]; meta?: unknown; status?: number }) {
  const urls: string[] = []
  const fetchJson = async (url: string) => {
    urls.push(url)
    if (/\/pools\/[^/?]+$/.test(url)) {
      const m = opts.mintInPool ?? MINT
      const rel = opts.side === 'quote'
        ? { base_token: { data: { id: `solana_${SOL}` } }, quote_token: { data: { id: `solana_${m}` } } }
        : { base_token: { data: { id: `solana_${m}` } }, quote_token: { data: { id: `solana_${SOL}` } } }
      return { httpStatus: 200, json: { data: { id: `solana_${POOL}`, attributes: { pool_created_at: null }, relationships: rel } } }
    }
    if (opts.status) return { httpStatus: opts.status, json: null }
    return { httpStatus: 200, json: { data: { attributes: { ohlcv_list: opts.rows ? opts.rows(url) : [] } }, ...(opts.meta ? { meta: opts.meta } : {}) } }
  }
  return { fetchJson, urls }
}
// Newest-first GT rows every `step` seconds (genuine buckets), `n` of them.
const rows = (step: number, n: number, end = NOW, price = 1) => Array.from({ length: n }, (_, i) => [end - step * (i + 1), price, price * 1.01, price * 0.99, price, 5])
const opts = { now: () => NOW * 1000 }

test('solana 5M: genuine provider minute/5 rows for the exact pool + proven side (base and quote)', async () => {
  for (const side of ['base', 'quote'] as const) {
    resetSolanaChartHistoryState()
    const f = gt({ side, rows: () => rows(300, 400) })
    const r = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side, timeframe: '5m' }, f.fetchJson, opts)
    assert.equal(r.result.ok, true, JSON.stringify(r.result))
    if (!r.result.ok) return
    assert.equal(r.result.intervalSec, 300)
    assert.equal(r.result.points.length, 400)
    assert.match(f.urls[0], new RegExp(`/networks/solana/pools/${POOL}$`), 'side proof from the exact-case pool record')
    assert.match(f.urls[1], new RegExp(`/networks/solana/pools/${POOL}/ohlcv/minute\\?aggregate=5&limit=1000&currency=usd&token=${side}$`))
    assert.ok(r.providerCalls <= 2)
    for (let i = 1; i < r.result.points.length; i++) assert.ok(Date.parse(r.result.points[i].timestamp) > Date.parse(r.result.points[i - 1].timestamp), 'ascending')
  }
})

test('solana 1M: genuine minute/1 rows accepted; a provider answering in 5-minute buckets is NOT shown as 1M', async () => {
  resetSolanaChartHistoryState()
  const ok = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '1m' }, gt({ side: 'base', rows: () => rows(60, 500) }).fetchJson, opts)
  assert.equal(ok.result.ok, true)
  assert.equal(ok.result.ok && ok.result.intervalSec, 60)
  // 1M requested, 5-minute buckets returned (aggregate ignored): unproven => not shown, precise reason.
  resetSolanaChartHistoryState()
  const coarse = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '1m' }, gt({ side: 'base', rows: () => rows(300, 50) }).fetchJson, opts)
  assert.deepEqual(!coarse.result.ok && [coarse.result.code, coarse.result.message], ['provider_interval_unsupported', 'the candle provider did not return genuine candles at this interval for this pool'])
  // Misaligned rows (not on a minute boundary) and a provider 400 are also unsupported.
  resetSolanaChartHistoryState()
  const misaligned = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '1m' }, gt({ side: 'base', rows: () => rows(60, 20).map((r) => [Number(r[0]) + 7, ...r.slice(1)]) }).fetchJson, opts)
  assert.equal(!misaligned.result.ok && misaligned.result.code, 'provider_interval_unsupported')
  resetSolanaChartHistoryState()
  const rejected = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '1m' }, gt({ side: 'base', status: 400 }).fetchJson, opts)
  assert.equal(!rejected.result.ok && rejected.result.code, 'provider_interval_unsupported')
  // Interval proof is pure and exact: gaps (missing buckets) are fine, never filled.
  const iso = (s: number) => ({ timestamp: new Date(s * 1000).toISOString() })
  assert.equal(isGenuineIntervalSeries([iso(NOW - 600), iso(NOW - 300), iso(NOW - 60)], 60), true, 'genuine minutes with a gap')
  assert.equal(isGenuineIntervalSeries(Array.from({ length: GENUINE_INTERVAL_MIN_PROOF_ROWS }, (_, i) => iso(NOW - 900 * (i + 1))).reverse(), 300), false, 'all on 15M boundaries => not proven 5M')
  assert.deepEqual([SOLANA_INTRADAY_REQUEST['5m'].aggregate, SOLANA_INTRADAY_REQUEST['1m'].aggregate], [5, 1])
})

test('solana intraday identity: exact-case mint/pool, wrong claimed side, case-twin, meta naming the other side', async () => {
  resetSolanaChartHistoryState()
  const lower = await loadSolanaPoolIntraday({ mint: MINT_LOWER_TWIN, pool: POOL, side: 'base', timeframe: '5m' }, gt({ side: 'base', rows: () => rows(300, 10) }).fetchJson, opts)
  assert.equal(!lower.result.ok && lower.result.code, 'token_side_unresolved', 'the pool names MINT, not its lowercase twin')
  resetSolanaChartHistoryState()
  const wrongSide = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '5m' }, gt({ side: 'quote', rows: () => rows(300, 10) }).fetchJson, opts)
  assert.equal(!wrongSide.result.ok && wrongSide.result.code, 'token_side_unresolved')
  resetSolanaChartHistoryState()
  const meta = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '5m' }, gt({ side: 'base', rows: () => rows(300, 10), meta: { base: { address: SOL }, quote: { address: MINT } } }).fetchJson, opts)
  assert.equal(!meta.result.ok && meta.result.code, 'token_identity_unverified')
  const bad = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '15m' }, gt({}).fetchJson, opts)
  assert.equal(!bad.result.ok && bad.result.code, 'invalid_request', '15M is the scan\'s own series — never this lane')
  // Exact-case cache keys: a different-case pool is a different key (never case-folded onto POOL).
  resetSolanaChartHistoryState()
  const f = gt({ side: 'base', rows: () => rows(300, 10) })
  await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '5m' }, f.fetchJson, opts)
  const other = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL_LOWER, side: 'base', timeframe: '5m' }, f.fetchJson, opts)
  assert.equal(other.cacheHit, false)
  assert.ok(f.urls.some((u) => u.includes(`/pools/${POOL_LOWER}`)))
})

test('solana intraday cache: hit = zero provider calls; keyed by exact mint + pool + timeframe; identical requests share one read', async () => {
  resetSolanaChartHistoryState()
  const f = gt({ side: 'base', rows: (u) => rows(u.includes('aggregate=1&') ? 60 : 300, 30) })
  const a = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '5m' }, f.fetchJson, opts)
  const b = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '5m' }, f.fetchJson, opts)
  assert.deepEqual([a.cacheHit, b.cacheHit, b.providerCalls], [false, true, 0])
  const one = await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '1m' }, f.fetchJson, opts)
  assert.deepEqual([one.cacheHit, one.providerCalls], [false, 1], '1M is its own key; the side proof is reused')
  resetSolanaChartHistoryState()
  const g = gt({ side: 'base', rows: () => rows(300, 30) })
  await Promise.all([1, 2].map(() => loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: '5m' }, g.fetchJson, opts)))
  assert.equal(g.urls.length, 2, 'one pool read + one OHLCV read for two identical concurrent requests')
})

test('solana initial OHLCV: deterministic rows (sorted, deduped, invalid dropped — never rewritten), truthful debug, meta side check', async () => {
  const urls: string[] = []
  const t = NOW - 900
  const list = [
    [t, 1.2, 1.3, 1.1, 1.25, 9], // newest
    [t, 1.2, 1.3, 1.1, 1.25, 9], // duplicate timestamp
    [t - 900, 1, 0.5, 2, 1, 1], // high < low: invalid, dropped (not repaired)
    [t - 1800, 1.0, 1.1, 0.9, 1.05, 4],
    [t - 2700, 0.9, 1.0, 0.85, 0.95, 3],
  ]
  const fetchImpl = (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } }, meta: { base: { address: MINT }, quote: { address: SOL } } }), { status: 200 }) }) as typeof fetch
  const r = await fetchSolanaOhlcv(POOL, fetchImpl, 'base', 1.2, MINT, { now: () => NOW * 1000 })
  assert.equal(r.success, true, String(r.errorReason))
  assert.deepEqual(r.candles.map((c) => Date.parse(c.timestamp) / 1000), [t - 2700, t - 1800, t], 'ascending, deduped, invalid row dropped')
  assert.deepEqual(r.candles[2], { timestamp: new Date(t * 1000).toISOString(), open: 1.2, high: 1.3, low: 1.1, close: 1.25, volume: 9 }, 'provider values untouched')
  const d = r.debug!
  assert.deepEqual([d.poolAddress, d.tokenSide, d.request, d.rowsReturned, d.rowsNormalized, d.rowsDropped, d.source], [POOL, 'base', { resolution: 'minute', aggregate: 15, limit: 672 }, 5, 3, 2, 'geckoterminal_pool_ohlcv'])
  assert.deepEqual([d.oldestSec, d.newestSec, d.coveredSec, d.latestCandleAgeSec], [t - 2700, t, 2700 + 900, 900])
  assert.equal(r.coverage!.returnedRows, 3, 'coverage counts the rows actually returned')
  assert.match(urls[0], new RegExp(`/pools/${POOL}/ohlcv/minute\\?aggregate=15&limit=672&currency=usd&token=base$`), 'pool OHLCV — never token-level / all pools')
  // Response meta naming the mint on the OTHER side: rejected.
  const flipped = (async () => new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } }, meta: { base: { address: SOL }, quote: { address: MINT } } }), { status: 200 })) as unknown as typeof fetch
  const bad = await fetchSolanaOhlcv(POOL, flipped, 'base', 1.2, MINT)
  assert.deepEqual([bad.success, bad.errorReason], [false, 'token_identity_unverified'])
  // Chart pool vs primary pool disclosed in debug by the merge.
  const merge = read('lib/server/solana/providerMerge.ts')
  assert.match(merge, /ohlcv\.debug = \{ \.\.\.ohlcv\.debug, primaryPoolAddress: poolAddress, chartPoolRule: market\.data\?\.chartPoolRule \?\? null \}/)
})

test('latest-close freshness: stale newest candle and live-price drift are measured, never "fixed"', () => {
  const live = 2
  // 15M chart, newest bucket 5h before the live price: stale. Close 10% under live: drifted.
  const stale = auditLatestClose({ lastCandle: { t: (NOW - 5 * 3600) * 1000, close: 1.8 }, livePriceUsd: live, livePriceAtMs: NOW * 1000, supply: null, basis: null, verifiedMarketCapUsd: null, intervalSec: 900, livePriceSource: 'dexscreener' })
  assert.deepEqual([stale.stale, stale.drifted, stale.candleAgeSec, stale.livePriceSource], [true, true, 5 * 3600, 'dexscreener'])
  assert.ok(Math.abs(stale.closeVsLive! + 0.1) < 1e-12)
  // A fresh candle within 3 buckets / 1h and within 5%: nothing flagged.
  const fresh = auditLatestClose({ lastCandle: { t: (NOW - 1800) * 1000, close: 1.95 }, livePriceUsd: live, livePriceAtMs: NOW * 1000, supply: null, basis: null, verifiedMarketCapUsd: null, intervalSec: 900 })
  assert.deepEqual([fresh.stale, fresh.drifted], [false, false])
  assert.equal(LATEST_CANDLE_STALE_MIN_SEC, 3600)
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /intervalSec: scanSet\.nativeSec, livePriceSource \}\)/)
  assert.match(panel, /data-latest-candle-stale/)
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /livePriceUsd=\{sr\.marketData\?\.priceUsd \?\? null\}\n\s*livePriceSource="dexscreener"/)
})

test('solana history: rows that are all invalid are a schema error, never "end of history"', async () => {
  resetSolanaChartHistoryState()
  const f = gt({ side: 'base', rows: () => [[NOW - 7200, 0, 0, 0, 0, 0], [NOW - 10_800, -1, 1, 1, 1, 1]] })
  const r = await loadSolanaPoolHistory({ mint: MINT, pool: POOL, side: 'base', before: NOW }, f.fetchJson, opts)
  assert.deepEqual(!r.result.ok && [r.result.code, r.result.hasMore], ['provider_schema_invalid', true])
})

test('wiring: Solana 5M/1M lane runs before EVM/V4 paths; panel gets exact-case loaders; labels follow the real interval', () => {
  const route = read('app/api/token/chart-candles/route.ts')
  const sol = route.indexOf("if (url.searchParams.get('chain') === 'solana' && (url.searchParams.get('timeframe') === '5m' || url.searchParams.get('timeframe') === '1m'))")
  assert.ok(sol > 0 && sol < route.indexOf("if (tfParam === '1m' && !isV4Pool)") && sol < route.indexOf('const { result } = await loadOnDemandCandles('))
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /loadFiveMinute=\{makeSolanaIntradayLoader\(sr\.mintAddress, sr\.ohlcv\.poolAddress, sr\.ohlcv\.tokenSide, '5m'\)\}/)
  assert.match(page, /loadOneMinute=\{makeSolanaIntradayLoader\(sr\.mintAddress, sr\.ohlcv\.poolAddress, sr\.ohlcv\.tokenSide, '1m'\)\}/)
  const loader = page.slice(page.indexOf('function makeSolanaIntradayLoader'), page.indexOf('function solanaChartUnavailableText'))
  assert.doesNotMatch(loader, /toLowerCase/)
  assert.match(loader, /new URLSearchParams\(\{ chain: 'solana', token: mint, pool, side: tokenSide, timeframe \}\)/)
  assert.match(page, /sourceDebug=\{sr\.ohlcv\.debug \?\? null\}/)
  assert.match(page, /Most active pair \(by 24h volume\)/)
  // The chip label is the active key; the drawn interval is the matching lane's interval.
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const intervalSec = oneActive \? ONE_MIN_SEC : fiveActive \? FIVE_MIN_SEC : activeTf/)
  assert.match(panel, /const fiveLoadable = !nativeFive\.available && loadFiveMinute != null && \(tfSet\.nativeSec \?\? 0\) > FIVE_MIN_SEC/)
  assert.doesNotMatch(read('lib/server/solanaChartHistory.ts'), /toLowerCase\(/, 'no case-folding anywhere in the Solana lanes')
})

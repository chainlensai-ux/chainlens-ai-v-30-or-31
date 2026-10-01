// Solana Token Scanner chart parity: exact-case pool + proven side end to end, deterministic provider
// rows (never rewritten), truthful debug/coverage, on-demand 5M / 1M ONLY when the provider proves the
// interval for the same exact pool, latest-close freshness, and history ends only on evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchSolanaOhlcv } from '../lib/server/solanaProviders.ts'
import {
  GENUINE_INTERVAL_MIN_PROOF_ROWS, SOLANA_INTRADAY_REQUEST, classifyIntervalSeries, isGenuineIntervalSeries, loadSolanaPoolHistory, loadSolanaPoolIntraday,
  resetSolanaChartHistoryState,
} from '../lib/server/solanaChartHistory.ts'
import { auditLatestClose, auditVisibleSeries, LATEST_CANDLE_STALE_MIN_SEC } from '../lib/chartMarketCap.ts'

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

test('solana 1M/5M interval proof: requested-grid rows accepted (incl. sparse ones on a coarser grid); off-grid or HTTP-unsupported rejected', async () => {
  const run = async (tf: '1m' | '5m', f: ReturnType<typeof gt>) => { resetSolanaChartHistoryState(); return (await loadSolanaPoolIntraday({ mint: MINT, pool: POOL, side: 'base', timeframe: tf }, f.fetchJson, opts)).result }
  // Dense genuine 1M.
  const dense = await run('1m', gt({ side: 'base', rows: () => rows(60, 500) }))
  assert.deepEqual(dense.ok && [dense.intervalSec, dense.points.length, dense.intervalEvidence], [60, 500, 'genuine'])
  // Genuine SPARSE 1M that only traded at :00, :05, :10 … — accepted (flagged ambiguous in debug, never rejected).
  const sparse1 = await run('1m', gt({ side: 'base', rows: () => rows(300, 50) }))
  assert.deepEqual(sparse1.ok && [sparse1.intervalSec, sparse1.points.length, sparse1.intervalEvidence], [60, 50, 'ambiguous_coarser_grid'])
  // Genuine SPARSE 5M only at :00, :15, :30 … — accepted.
  const sparse5 = await run('5m', gt({ side: 'base', rows: () => rows(900, 40) }))
  assert.deepEqual(sparse5.ok && [sparse5.intervalSec, sparse5.points.length, sparse5.intervalEvidence], [300, 40, 'ambiguous_coarser_grid'])
  // Missing buckets stay missing: exactly the provider's rows, nothing invented.
  assert.ok(sparse1.ok && sparse1.points.every((p, i, a) => i === 0 || Date.parse(p.timestamp) - Date.parse(a[i - 1].timestamp) === 300_000))
  // Off-grid rows: rejected for 1M (7s past the minute) and 5M (on minutes but not on 5-minute boundaries).
  const off1 = await run('1m', gt({ side: 'base', rows: () => rows(60, 20).map((r) => [Number(r[0]) + 7, ...r.slice(1)]) }))
  assert.deepEqual(!off1.ok && [off1.code, off1.message], ['provider_interval_unsupported', 'the candle provider did not return genuine candles at this interval for this pool'])
  const off5 = await run('5m', gt({ side: 'base', rows: () => rows(300, 20).map((r) => [Number(r[0]) + 60, ...r.slice(1)]) }))
  assert.equal(!off5.ok && off5.code, 'provider_interval_unsupported')
  // HTTP 400 / 422 for the requested aggregate: unsupported.
  for (const status of [400, 422]) {
    const bad = await run('1m', gt({ side: 'base', status }))
    assert.equal(!bad.ok && bad.code, 'provider_interval_unsupported', String(status))
  }
  // Pure classification.
  const iso = (sec: number) => ({ timestamp: new Date(sec * 1000).toISOString() })
  assert.equal(classifyIntervalSeries([iso(NOW - 600), iso(NOW - 300), iso(NOW - 60)], 60), 'genuine', 'genuine minutes with a gap')
  assert.equal(classifyIntervalSeries([iso(NOW - 60), iso(NOW - 120)], 60), 'invalid', 'not ascending')
  assert.equal(classifyIntervalSeries(Array.from({ length: GENUINE_INTERVAL_MIN_PROOF_ROWS }, (_, i) => iso(NOW - 900 * (GENUINE_INTERVAL_MIN_PROOF_ROWS - i))), 300), 'ambiguous_coarser_grid')
  assert.equal(isGenuineIntervalSeries(Array.from({ length: GENUINE_INTERVAL_MIN_PROOF_ROWS }, (_, i) => iso(NOW - 900 * (GENUINE_INTERVAL_MIN_PROOF_ROWS - i))), 300), true, 'ambiguous is still a valid series')
  assert.deepEqual([SOLANA_INTRADAY_REQUEST['5m'].aggregate, SOLANA_INTRADAY_REQUEST['1m'].aggregate], [5, 1])
  assert.match(read('app/api/token/chart-candles/route.ts'), /intervalEvidence: s\.intervalEvidence/)
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

test('latest-close audit follows the DISPLAYED series: stale 15M scan + fresh 1M => no stale warning while 1M is selected', () => {
  const H = 3_600_000
  const at = NOW * 1000
  const live = 2
  const c = (t: number, close: number) => ({ t, close })
  // The scan's 15M series ended 5h ago; the on-demand 1M series has a candle 1 minute ago; 5M 4 min ago.
  const scan15 = [c(at - 6 * H, 1.5), c(at - 5 * H, 1.6)]
  const one = [c(at - 3 * 60_000, 1.98), c(at - 60_000, 2.01)]
  const five = [c(at - 9 * 60_000, 1.97), c(at - 4 * 60_000, 1.99)]
  const hour = [c(at - 3 * H, 1.9), c(at - H, 1.96)]
  const base = { livePriceUsd: live, livePriceAtMs: at, supply: null, basis: null, verifiedMarketCapUsd: null, livePriceSource: 'dexscreener' }
  const a15 = auditVisibleSeries({ ...base, priceSeries: scan15, intervalSec: 900 })
  assert.deepEqual([a15.stale, a15.drifted, a15.lastCloseUsd], [true, true, 1.6], '15M view: its own stale, drifted newest close')
  const a1 = auditVisibleSeries({ ...base, priceSeries: one, intervalSec: 60 })
  assert.deepEqual([a1.stale, a1.drifted, a1.lastCloseUsd, a1.candleAgeSec], [false, false, 2.01, 60], '1M view: the fresh 1M close, no stale warning')
  const a5 = auditVisibleSeries({ ...base, priceSeries: five, intervalSec: 300 })
  assert.deepEqual([a5.stale, a5.lastCloseUsd, a5.candleAgeSec], [false, 1.99, 240], '5M view audits the 5M newest close')
  const a1h = auditVisibleSeries({ ...base, priceSeries: hour, intervalSec: 3600 })
  assert.deepEqual([a1h.stale, a1h.lastCloseUsd], [false, 1.96], '1H view audits the selected (real/aggregated) series')
  // MCAP mode: the audit takes the PRICE close; MCAP close = PRICE close x supply (never a scaled close as "price").
  const mcap = auditVisibleSeries({ ...base, priceSeries: one, intervalSec: 60, supply: 1e9, basis: 'inferred_current_mc', verifiedMarketCapUsd: 2e9 })
  assert.equal(mcap.lastCloseUsd, 2.01)
  assert.ok(Math.abs(mcap.mcapClose! - 2.01e9) < 1)
  // Wiring: the panel audits priceSeries (PRICE, pre-MCAP) at the displayed interval, after it is resolved.
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const latestAudit = auditVisibleSeries\(\{ priceSeries, intervalSec, livePriceUsd, livePriceAtMs: referenceTimeMs,/)
  assert.ok(panel.indexOf('const intervalSec = oneActive ? ONE_MIN_SEC') < panel.indexOf('const latestAudit = auditVisibleSeries('))
  assert.ok(panel.indexOf('const priceSeries: ChartCandle[]') < panel.indexOf('const latestAudit = auditVisibleSeries('))
  assert.doesNotMatch(panel, /scanNewest|lastCandle: normalized/, 'never the scan series when another timeframe is shown')
})

// Market chart load: the automatic history batch stops once the default view reads as a chart (it used to wait
// for a second sequential provider request it did not need), and loaded history survives leaving and reopening
// the Market tab (it used to be re-requested on every remount).
//   npx tsx --test tests/chart-market-load.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildChartTimeframes, normalizeChartCandles, type ChartCandle } from '../lib/priceChartCandles.ts'
import { assessTimeframeSet, autoHistoryReadable, planAutoHistory, READABLE_MIN_CANDLES, resolveCoverageWindow, selectPresentationTimeframe } from '../lib/chartQuality.ts'
import { HISTORY_TARGET_SPAN_SEC, historyCutoffMs, loadHistoryBatch, withHistory, type HistoryWindowResult } from '../lib/chartHistory.ts'
import { __resetChartHistoryStoreForTest, readChartHistory, subscribeChartHistory, writeChartHistory } from '../lib/chartHistoryStore.ts'

const H1 = 3_600
const M15 = 900
const END = Math.floor(Date.UTC(2026, 9, 29, 12) / 1000)
const candle = (tSec: number, p = 1) => ({ timestamp: new Date(tSec * 1000).toISOString(), open: p, high: p * 1.01, low: p * 0.99, close: p * 1.002, volume: 100 })
// Hourly provider history ending strictly before `beforeSec` (what /api/token/chart-candles returns).
const hourlyBefore = (beforeSec: number, count: number) => Array.from({ length: count }, (_, i) => candle(Math.floor(beforeSec / H1) * H1 - (count - i) * H1, 1 + i / 1000))

test('a thin scan (6 x 15M) plans the 1D view, and ONE 1000-candle hourly window already makes it readable', () => {
  const scan = normalizeChartCandles(Array.from({ length: 6 }, (_, i) => candle(END - (5 - i) * M15)))
  const set = buildChartTimeframes(scan, M15)
  // The scan asked the provider for 7 days of 15M candles and got only 6 (the panel judges against that window).
  const window = resolveCoverageWindow({ requestEndSec: END, requestedStartSec: END - 7 * 86_400, requestedLimit: 672, returnedRows: 6, oldestSec: END - 5 * M15, newestSec: END, windowProven: true })
  const opts = { coverageFor: () => window }
  const quality = assessTimeframeSet(set, opts)
  const sel = selectPresentationTimeframe(quality)
  const plan = planAutoHistory({ defaultKey: sel.key, defaultQuality: sel.key ? quality[sel.key] ?? null : null, historyEnabled: true, hasMore: true })
  assert.equal(plan.load, true)
  assert.equal(plan.key, '1D')
  assert.ok(HISTORY_TARGET_SPAN_SEC['1D'] > 1000 * H1, 'the 1D target alone would ask for a second request')
  const cutoffMs = historyCutoffMs(scan, H1)!
  const merged = normalizeChartCandles(hourlyBefore(cutoffMs / 1000, 1000))
  const withOne = assessTimeframeSet(withHistory(set, merged, cutoffMs, H1), opts)
  assert.ok((withOne['1D']?.candleCount ?? 0) >= READABLE_MIN_CANDLES)
  assert.equal(autoHistoryReadable(withOne['1D']), true)
})

test('loadHistoryBatch: stopWhen ends the batch after the first response that satisfies it; more stays loadable', async () => {
  const calls: number[] = []
  const load = async (before: number): Promise<HistoryWindowResult> => {
    calls.push(before)
    const points = hourlyBefore(before, 1000)
    return { ok: true, points, hasMore: true, nextBeforeSec: Date.parse(points[0].timestamp) / 1000, endReason: null }
  }
  const start = { candles: [] as ChartCandle[], nextBeforeSec: null, hasMore: true }
  const cutoffMs = END * 1000
  const base = { start, cutoffMs, newestMs: cutoffMs, maxRequests: 2, targetSpanSec: HISTORY_TARGET_SPAN_SEC['1D'], load, intervalSec: H1 }

  const without = await loadHistoryBatch(base)
  assert.equal(without.requests, 2, 'previously: two sequential provider requests before the chart settled')

  calls.length = 0
  const early = await loadHistoryBatch({ ...base, stopWhen: (c) => c.length >= 24 * READABLE_MIN_CANDLES })
  assert.equal(early.requests, 1)
  assert.equal(calls.length, 1)
  assert.equal(early.hasMore, true, 'older history is still loadable on demand')
  assert.equal(early.candles.length, 1000)

  calls.length = 0
  const notYet = await loadHistoryBatch({ ...base, stopWhen: () => false })
  assert.equal(notYet.requests, 2, 'an unreadable view still loads the whole bounded batch')
})

test('autoHistoryReadable needs a presentation-usable view with enough genuine candles', () => {
  assert.equal(autoHistoryReadable(null), false)
  assert.equal(autoHistoryReadable({ quality: 'good', candleCount: READABLE_MIN_CANDLES - 1 } as never), false)
  assert.equal(autoHistoryReadable({ quality: 'good', candleCount: READABLE_MIN_CANDLES } as never), true)
})

test('chart history store: per-identity entries, new snapshots on write, notifications, bounded size', () => {
  __resetChartHistoryStoreForTest()
  const idle = { status: 'idle' as const, candles: [] as number[] }
  let notified = 0
  const unsubscribe = subscribeChartHistory(() => { notified++ })
  assert.equal(readChartHistory('scan-a'), undefined)
  writeChartHistory('scan-a', idle, { autoStarted: true })
  const first = readChartHistory<typeof idle, number>('scan-a')
  assert.deepEqual(first, { hist: idle, auto: null, autoStarted: true })
  writeChartHistory('scan-a', idle, { hist: { status: 'idle', candles: [1, 2] }, auto: [1, 2] })
  const second = readChartHistory<typeof idle, number>('scan-a')
  assert.notEqual(second, first, 'a write replaces the snapshot object')
  assert.deepEqual(second, { hist: { status: 'idle', candles: [1, 2] }, auto: [1, 2], autoStarted: true })
  assert.equal(readChartHistory('scan-b'), undefined, 'another scan never sees this history')
  assert.equal(notified, 2)
  for (let i = 0; i < 30; i++) writeChartHistory(`scan-${i}`, idle, {})
  assert.equal(readChartHistory('scan-a'), undefined, 'oldest entries are evicted beyond the cap')
  unsubscribe()
  writeChartHistory('scan-z', idle, {})
  assert.equal(notified, 32)
  __resetChartHistoryStoreForTest()
})

test('panel wiring: history comes from the session store, the auto batch passes its stop rule, remounts do not re-request', () => {
  const panel = readFileSync(new URL('../app/terminal/token-scanner/PriceChartPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /useSyncExternalStore\(subscribeChartHistory, \(\) => readChartHistory<HistoryState, ChartCandle>\(dataId\)/)
  assert.doesNotMatch(panel, /useState<\{ source: string; state: HistoryState \}/, 'history is not component state (it reset on every remount)')
  assert.match(panel, /readChartHistory<HistoryState, ChartCandle>\(dataId\)\?\.hist\.status === 'loading'/, 'an in-flight request is not sent again')
  assert.match(panel, /autoHistoryReadable\(assessTimeframeSet\(withHistory\(scanSet, merged, cutoffMs, historySec\)/)
  assert.match(panel, /if \(readChartHistory\(dataId\)\?\.autoStarted/)
})

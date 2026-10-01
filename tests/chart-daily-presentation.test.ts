// 1D presentation fixes (lib/priceChartCandles.ts formatChartTime + lib/chartHistory.ts
// loadHistoryBatch + PriceChartPanel wiring). Candle math is unchanged: these tests pin the UTC
// daily labels, the single-update history batch, and that the batch merges exactly what the
// previous one-by-one loop merged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aggregateCandles, buildChartTimeframes, chartTimeIsUtc, formatChartTime, normalizeChartCandles, timeTickIndices, type ChartCandle } from '../lib/priceChartCandles.ts'
import { HISTORY_MAX_REQUESTS_PER_ACTION, historyCutoffMs, loadHistoryBatch, mergeHistoryCandles, withHistory, type HistoryWindowResult } from '../lib/chartHistory.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const H = 3_600_000
const DAY = 86_400_000
const SEP29 = Date.UTC(2026, 8, 29)

function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ
  process.env.TZ = tz
  try { return fn() } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev }
}
const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Pacific/Pago_Pago', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Asia/Kolkata']

// ── UTC daily labels ─────────────────────────────────────────────────────────────────────────────
test('the Sep 29 UTC daily candle is labelled Sep 29 in every browser timezone (axis + readout)', () => {
  for (const tz of ZONES) {
    withTz(tz, () => {
      assert.match(formatChartTime(SEP29, 86_400, 'axis'), /Sep\s29$/, `${tz} axis`)
      assert.match(formatChartTime(SEP29, 86_400, 'readout'), /Sep\s29,\s2026$/, `${tz} readout`)
    })
  }
  withTz('America/New_York', () => assert.match(new Date(SEP29).toLocaleDateString([], { month: 'short', day: 'numeric' }), /Sep\s28/, 'the previous local formatting read Sep 28 here'))
})

test('intraday labels keep the viewer\'s local clock exactly as before', () => {
  const t = Date.UTC(2026, 8, 29, 14, 0)
  for (const tz of ZONES) {
    withTz(tz, () => {
      const d = new Date(t)
      assert.equal(formatChartTime(t, 3600, 'readout'), d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }))
      const midnight = d.getHours() === 0 && d.getMinutes() === 0
      assert.equal(formatChartTime(t, 900, 'axis'), midnight ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
    })
  }
  assert.deepEqual([chartTimeIsUtc(86_400), chartTimeIsUtc(14_400), chartTimeIsUtc(null)], [true, false, false])
})

test('daily tick placement uses the same UTC basis: every UTC day is a boundary in every timezone', () => {
  const days: ChartCandle[] = Array.from({ length: 10 }, (_, i) => ({ t: SEP29 - (9 - i) * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1 }))
  const expected = timeTickIndices(days, 1, 0)
  for (const tz of ZONES) withTz(tz, () => assert.deepEqual(timeTickIndices(days, 1, chartTimeIsUtc(86_400) ? 0 : new Date(days[9].t).getTimezoneOffset()), expected, tz))
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const tzOffset = chartTimeIsUtc\(intervalSec\) \? 0 : new Date\(data\[n - 1\]\.t\)\.getTimezoneOffset\(\)/)
  assert.match(panel, /const fmtTime = formatChartTime/)
})

test('partial current UTC day: the live daily candle starts at 00:00 UTC, labelled with today, built from today\'s real candles only', () => {
  const now = Date.UTC(2026, 8, 29, 14, 37)
  const five = normalizeChartCandles(Array.from({ length: 288 }, (_, i) => { const t = now - (now % 300_000) - (287 - i) * 300_000; return { timestamp: t, open: 1 + i / 1000, high: 1.01 + i / 1000, low: 0.99 + i / 1000, close: 1 + i / 1000, volume: 2 } }))
  const d1 = buildChartTimeframes(five, 300).timeframes.find((t) => t.key === '1D')!
  const today = d1.candles[d1.candles.length - 1]
  assert.equal(today.t, SEP29)
  const todays = five.filter((c) => c.t >= SEP29)
  assert.deepEqual([today.open, today.close, today.volume], [todays[0].open, todays[todays.length - 1].close, todays.length * 2])
  withTz('America/Los_Angeles', () => assert.match(formatChartTime(today.t, 86_400, 'readout'), /Sep\s29,\s2026/))
})

// ── One visible update per history batch ─────────────────────────────────────────────────────────
const hourly = (fromMs: number, toMs: number, px: number): Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> => {
  const out = []
  for (let t = fromMs; t < toMs; t += H) out.push({ timestamp: t, open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 10 })
  return out
}

test('3 chained history responses: same requests and cursors as before, merged into ONE outcome equal to the one-by-one merge', async () => {
  const now = Date.UTC(2026, 8, 29, 14, 37)
  const scan = normalizeChartCandles(Array.from({ length: 288 }, (_, i) => ({ timestamp: now - (now % 300_000) - (287 - i) * 300_000, open: 1, high: 1.01, low: 0.99, close: 1, volume: 5 })))
  const cutoff = historyCutoffMs(scan)!
  const cutoffSec = cutoff / 1000
  // Window k covers 7 days before its cursor; the first also carries an overlap at/after the cursor.
  const windows: HistoryWindowResult[] = [
    { ok: true, points: [...hourly(cutoff - 7 * DAY, cutoff, 0.9), ...hourly(cutoff, cutoff + 2 * H, 99)], hasMore: true, nextBeforeSec: cutoffSec - 7 * 86_400 },
    { ok: true, points: hourly(cutoff - 14 * DAY, cutoff - 7 * DAY, 0.8), hasMore: true, nextBeforeSec: cutoffSec - 14 * 86_400 },
    { ok: true, points: hourly(cutoff - 21 * DAY, cutoff - 14 * DAY, 0.7), hasMore: true, nextBeforeSec: cutoffSec - 21 * 86_400 },
  ]
  const cursors: number[] = []
  const out = await loadHistoryBatch({
    start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: scan[scan.length - 1].t,
    maxRequests: HISTORY_MAX_REQUESTS_PER_ACTION, targetSpanSec: 60 * 86_400,
    load: async (before) => { cursors.push(before); return windows[cursors.length - 1] },
  })
  assert.deepEqual(cursors, [cutoffSec, cutoffSec - 7 * 86_400, cutoffSec - 14 * 86_400], 'contiguous cursors, no repeated window')
  assert.equal(out.requests, 3, 'provider requests unchanged: 3 per action')
  // The previous loop, one response at a time:
  let seq: ChartCandle[] = []
  for (const w of windows) if (w.ok) seq = mergeHistoryCandles(seq, normalizeChartCandles(w.points), cutoff)
  assert.deepEqual(out.candles, seq)
  assert.equal(new Set(out.candles.map((c) => c.t)).size, out.candles.length, 'no duplicate timestamps')
  assert.ok(out.candles.every((c, i) => i === 0 || c.t > out.candles[i - 1].t), 'ascending')
  assert.ok(out.candles.every((c) => c.t < cutoff), 'the overlap past the cursor never overrides newer scan evidence')
  assert.deepEqual([out.hasMore, out.nextBeforeSec, out.failedMessage], [true, cutoffSec - 21 * 86_400, null])
  // And the 1D series built from it is identical to the math-verified merge.
  const d1 = withHistory(buildChartTimeframes(scan, 300), out.candles, cutoff).timeframes.find((t) => t.key === '1D')!
  const expected = aggregateCandles([...seq, ...aggregateCandles(scan.filter((c) => c.t >= cutoff), 3600)], 86_400)
  assert.deepEqual(d1.candles, expected)
  assert.equal(d1.candles[d1.candles.length - 1].t, SEP29)
})

test('batch stops at the target span, at end-of-history, and on failure keeps what already merged (still one outcome)', async () => {
  const cutoff = Date.UTC(2026, 8, 28, 15)
  const base = { start: { candles: [], nextBeforeSec: null, hasMore: true }, cutoffMs: cutoff, newestMs: cutoff + 23 * H, maxRequests: 3 }
  let calls = 0
  const oneWeek = async (before: number): Promise<HistoryWindowResult> => { calls++; return { ok: true, points: hourly(before * 1000 - 7 * DAY, before * 1000, 1), hasMore: true, nextBeforeSec: before - 7 * 86_400 } }
  await loadHistoryBatch({ ...base, targetSpanSec: 3 * 86_400, load: oneWeek })
  assert.equal(calls, 1, '1H target (3 days) reached after one week-long window')
  let n = 0
  const failSecond = async (before: number): Promise<HistoryWindowResult> => (++n === 1 ? { ok: true, points: hourly(before * 1000 - DAY, before * 1000, 1), hasMore: true, nextBeforeSec: before - 86_400 } : { ok: false, message: 'RPC busy' })
  const f = await loadHistoryBatch({ ...base, targetSpanSec: null, load: failSecond })
  assert.deepEqual([f.candles.length, f.failedMessage, n], [24, 'RPC busy', 2])
  const end = await loadHistoryBatch({ ...base, targetSpanSec: null, load: async () => ({ ok: true, points: [], hasMore: false, nextBeforeSec: null }) })
  assert.deepEqual([end.requests, end.hasMore], [1, false])
})

test('panel: exactly two history state writes per batch (loading, then the merged result) — no per-response re-layout', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  const fn = panel.slice(panel.indexOf('const requestHistory = async'), panel.indexOf('const loadOlderAtLeftEdge'))
  assert.equal((fn.match(/setHistRaw\(/g) ?? []).length, 2)
  assert.match(fn, /await loadHistoryBatch\(\{ start: hist, cutoffMs, newestMs, maxRequests, targetSpanSec, load: loadHistory \}\)/)
  assert.doesNotMatch(fn, /for \(/, 'no response loop inside the component')
})

test('panel: 1D shorter than a useful daily chart while its first history batch loads keeps the current chart; viewport logic unchanged', () => {
  const panel = read('app/terminal/token-scanner/PriceChartPanel.tsx')
  assert.match(panel, /const deferDaily = picked === '1D' && hist\.status === 'loading' && dailyDefer != null && dailyDefer\.source === dataId && dailyCandleCount < DAILY_FIRST_BATCH_MIN_CANDLES/)
  assert.match(panel, /const shownPick = deferDaily \? dailyDefer!\.fallback : picked/)
  assert.match(panel, /tfSet\.timeframes\.find\(\(tf\) => tf\.key === shownPick && tf\.available\)/)
  assert.match(panel, /setDailyDefer\(chip\.key === '1D' && \(willLoad \|\| hist\.status === 'loading'\) \? \{ source: dataId, fallback: activeKey \} : null\)/)
  assert.match(panel, /\|\| \(chip\.key === '1D' && deferDaily\)/, 'the 1D chip shows it is loading')
  assert.match(panel, /'Loading older candles…'/)
  // Viewport: keyed by timeframe + newest candle; prepended history shifts the view once.
  assert.match(panel, /const seriesKey = `\$\{activeKey \?\? 'native'\}:\$\{series\[series\.length - 1\]\?\.t \?\? 0\}`/)
  // ... and to this scan's DATA IDENTITY (not the array object), so a new scan never inherits a previous
  // token's view while an equivalent re-render keeps it; prepended history shifts it (resolveChartViewport).
  assert.match(panel, /const \{ view \} = resolveChartViewport\(viewRaw, \{ identity: dataId, seriesKey, total \}, restView\)/)
  assert.match(panel, /setViewRaw\(\{ identity: dataId, seriesKey, view: next, total \}\)/)
})

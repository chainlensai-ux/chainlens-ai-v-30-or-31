// TEMPORARY candle-resolution diagnostics (lib/evmChartCandles.ts buildEvmChartDebugInfo) +
// gating in app/api/token/route.ts and the panel wiring in the Token Scanner page. Pure
// presentational re-shaping of data the ladder already produced — asserts zero provider-call
// impact (nothing here calls a fetcher), no secrets in the output, and correct stage mapping for
// every scenario the task called out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildEvmChartDebugInfo, summarizeCandleFailure, type CandleAttempt } from '../lib/evmChartCandles.ts'

const POOL = '0x1111111111111111111111111111111111111111'
const ALT_POOL = '0x2222222222222222222222222222222222222222'
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01'

function base(overrides: Partial<Parameters<typeof buildEvmChartDebugInfo>[0]> = {}) {
  return buildEvmChartDebugInfo({
    chain: 'base',
    network: 'base',
    scannedToken: TOKEN,
    candleFailure: null,
    selectedPoolAddress: null,
    tokenSide: null,
    rateLimited: false,
    usedEstimatedTrend: false,
    source: null,
    finalCandleCount: 0,
    ...overrides,
  })
}

test('primary pool success: real source + row count, every later stage marked skipped', () => {
  const attempts: CandleAttempt[] = [
    { route: 'pool', poolAddress: POOL, side: 'base', timeframe: '24h', httpStatus: 200, rows: 672, validRows: 672, code: 'ok' },
  ]
  const d = base({
    candleFailure: { code: 'provider_empty', message: 'unused when ok', attempts }, // ladder only sets candleFailure on a genuine failure path; still fine to feed attempts through here
    selectedPoolAddress: POOL,
    tokenSide: 'base',
    source: 'pool_ohlcv',
    finalCandleCount: 672,
  })
  const primary = d.attempts.find((a) => a.stage === 'primary_pool_15m')!
  assert.equal(primary.status, 'ok')
  assert.equal(primary.pool, POOL)
  assert.equal(primary.interval, '15m')
  assert.equal(primary.httpStatus, 200)
  assert.equal(primary.rowsReturned, 672)
  assert.equal(primary.reason, null)
  for (const stage of ['primary_pool_1h', 'primary_pool_1d', 'alternate_pool', 'swap_rebuild', 'estimated_trend']) {
    const a = d.attempts.find((x) => x.stage === stage)!
    assert.equal(a.status, 'skipped', stage)
  }
  assert.equal(d.finalSource, 'primary_pool_15m')
  assert.equal(d.finalCandleCount, 672)
  assert.equal(d.selectedPool, POOL)
  assert.equal(d.tokenSide, 'base')
  assert.equal(d.fallbackReason, null)
  assert.equal(d.requestedInterval, '15m')
  assert.equal(d.requestedLimit, 672)
})

test('429 on the first request: provider_rate_limited reported, everything after it skipped', () => {
  const attempts: CandleAttempt[] = [
    { route: 'pool', poolAddress: POOL, side: 'base', timeframe: '24h', httpStatus: 429, rows: 0, validRows: 0, code: 'provider_rate_limited' },
  ]
  const summary = summarizeCandleFailure(attempts, false)
  const d = base({ candleFailure: summary, rateLimited: true, usedEstimatedTrend: false })
  const primary = d.attempts.find((a) => a.stage === 'primary_pool_15m')!
  assert.equal(primary.status, 'provider_rate_limited')
  assert.equal(primary.httpStatus, 429)
  assert.equal(primary.rowsReturned, 0)
  assert.match(primary.reason ?? '', /rate-limiting/i)
  for (const stage of ['primary_pool_1h', 'primary_pool_1d', 'swap_rebuild']) {
    assert.equal(d.attempts.find((a) => a.stage === stage)!.status, 'skipped', stage)
  }
  assert.equal(d.rateLimited, true)
  assert.equal(d.finalSource, 'none')
  assert.equal(d.fallbackReason, 'provider_rate_limited')
})

test('unknown token side: token_side_unresolved reported, no pool/side leaked', () => {
  const attempts: CandleAttempt[] = [
    { route: 'pool', poolAddress: POOL, side: null, timeframe: null, httpStatus: null, rows: 0, validRows: 0, code: 'token_side_unresolved' },
  ]
  const summary = summarizeCandleFailure(attempts, false)
  const d = base({ candleFailure: summary, tokenSide: null })
  // token_side_unresolved carries no timeframe, so it cannot be attributed to a specific rung stage
  // (the ladder never even chose which interval to ask for) — it surfaces via fallbackReason instead.
  assert.equal(d.fallbackReason, 'token_side_unresolved')
  assert.equal(d.tokenSide, null)
  for (const a of d.attempts) if (a.stage.startsWith('primary_pool')) assert.equal(a.status, 'skipped')
})

test('alternate pool fallback reports the correct stage', () => {
  const attempts: CandleAttempt[] = [
    { route: 'pool', poolAddress: POOL, side: 'base', timeframe: '24h', httpStatus: 200, rows: 0, validRows: 0, code: 'provider_empty' },
    { route: 'alternate_pool', poolAddress: ALT_POOL, side: 'quote', timeframe: '24h', httpStatus: 200, rows: 50, validRows: 50, code: 'ok' },
  ]
  const d = base({
    candleFailure: { code: 'provider_empty', message: 'x', attempts },
    selectedPoolAddress: ALT_POOL,
    tokenSide: 'quote',
    source: 'pool_ohlcv',
    finalCandleCount: 50,
  })
  const alt = d.attempts.find((a) => a.stage === 'alternate_pool')!
  assert.equal(alt.status, 'ok')
  assert.equal(alt.pool, ALT_POOL)
  assert.equal(alt.rowsReturned, 50)
  assert.equal(d.finalSource, 'alternate_pool')
  const primary = d.attempts.find((a) => a.stage === 'primary_pool_15m')!
  assert.equal(primary.status, 'provider_empty')
  assert.equal(primary.pool, POOL)
})

test('swap rebuild fallback reports its stage and row count', () => {
  const attempts: CandleAttempt[] = [
    { route: 'pool', poolAddress: POOL, side: 'base', timeframe: '24h', httpStatus: 404, rows: 0, validRows: 0, code: 'pool_not_indexed' },
    { route: 'swaps', poolAddress: POOL, side: null, timeframe: null, httpStatus: 200, rows: 40, validRows: 12, code: 'ok' },
  ]
  const d = base({ candleFailure: { code: 'pool_not_indexed', message: 'x', attempts }, source: 'trade_reconstructed', finalCandleCount: 12 })
  const swap = d.attempts.find((a) => a.stage === 'swap_rebuild')!
  assert.equal(swap.status, 'ok')
  assert.equal(swap.rowsReturned, 12)
  assert.equal(d.finalSource, 'swap_rebuild')
})

test('estimated trend: exact fallback reason surfaced, marked ok with the live candle count', () => {
  const attempts: CandleAttempt[] = [
    { route: 'pool', poolAddress: POOL, side: 'base', timeframe: '24h', httpStatus: 429, rows: 0, validRows: 0, code: 'provider_rate_limited' },
  ]
  const summary = summarizeCandleFailure(attempts, false)
  const d = base({ candleFailure: summary, rateLimited: true, usedEstimatedTrend: true, source: 'synthetic_price_estimate', finalCandleCount: 2 })
  const est = d.attempts.find((a) => a.stage === 'estimated_trend')!
  assert.equal(est.status, 'ok')
  assert.equal(est.rowsReturned, 2)
  assert.match(est.reason ?? '', /rate-limiting/i)
  assert.equal(d.finalSource, 'estimated_trend')
  assert.equal(d.fallbackReason, 'provider_rate_limited')
})

test('no pools at all: pool_not_indexed, every stage skipped except estimated_trend if used', () => {
  const summary = summarizeCandleFailure([], true)
  const d = base({ candleFailure: summary })
  for (const stage of ['primary_pool_15m', 'primary_pool_1h', 'primary_pool_1d', 'alternate_pool', 'swap_rebuild', 'estimated_trend']) {
    assert.equal(d.attempts.find((a) => a.stage === stage)!.status, 'skipped')
  }
  assert.equal(d.fallbackReason, 'pool_not_indexed')
})

test('never carries anything resembling a secret, key, header, or raw provider body', () => {
  const attempts: CandleAttempt[] = [
    { route: 'pool', poolAddress: POOL, side: 'base', timeframe: '24h', httpStatus: 429, rows: 0, validRows: 0, code: 'provider_rate_limited' },
  ]
  const d = base({ candleFailure: summarizeCandleFailure(attempts, false), rateLimited: true, usedEstimatedTrend: true, source: 'synthetic_price_estimate', finalCandleCount: 2 })
  const json = JSON.stringify(d).toLowerCase()
  for (const forbidden of ['api_key', 'apikey', 'authorization', 'bearer', 'x-cg-', 'secret', 'ohlcv_list', 'password', 'token=']) {
    assert.doesNotMatch(json, new RegExp(forbidden), forbidden)
  }
  // Only genuinely public/structural fields appear.
  assert.deepEqual(Object.keys(d).sort(), ['attempts', 'chain', 'fallbackReason', 'finalCandleCount', 'finalSource', 'network', 'rateLimited', 'requestedInterval', 'requestedLimit', 'scannedToken', 'selectedPool', 'source', 'tokenSide'].sort())
})

// ── Gating + wiring (static): server enforcement, zero provider-call delta, panel visibility ────
const route = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')

test('server: chartDebug requires debug=true AND (admin header OR admin session email OR authenticated-on-Preview) — reuses existing mechanisms, no new secret', () => {
  assert.match(route, /const chartDebugPreviewRelaxed = process\.env\.VERCEL_ENV === 'preview' && Boolean\(outcomeUser\?\.userId\)/)
  assert.match(route, /const chartDebugAuthorized = debugRequested === true && \(isAdminOverride\(req\) \|\| isAdminEmail\(outcomeUser\.email\) \|\| chartDebugPreviewRelaxed\)/)
  assert.match(route, /getAdminEmails\(\)/, 'reuses the ADMIN_EMAILS convention already used by app/api/admin/*')
  assert.doesNotMatch(route, /CHART_DEBUG_SECRET|NEW_ADMIN_KEY/i, 'no new secret introduced')
  assert.match(route, /\.\.\.\(chartDebug \? \{ chartDebug \} : \{\}\)/, 'absent entirely when not authorized')
})

test('server: preview relaxation only ever compares against VERCEL_ENV === \'preview\' (never true in Production) and still requires an authenticated user', () => {
  const gateBlock = route.slice(route.indexOf('const chartDebugPreviewRelaxed'), route.indexOf('const isClarkFastMode'))
  assert.match(gateBlock, /VERCEL_ENV === 'preview'/)
  assert.doesNotMatch(gateBlock, /VERCEL_ENV\s*!==\s*'production'/, 'must not treat "not production" as preview — only the exact preview value')
  assert.match(gateBlock, /outcomeUser\?\.userId/, 'still requires the already-verified authenticated session')
})

test('server: chartDebug is built from the ladder\'s own already-computed result — no new fetch call', () => {
  const fn = route.slice(route.indexOf('const chartDebug: ChartDebugInfo'), route.indexOf('const pairCreatedAt = String(mainPoolAttr.pool_created_at'))
  assert.doesNotMatch(fn, /await fetch|fetchGeckoTerminal|fetchImpl/i)
  assert.match(fn, /candleFailure: chartCandleFailure/)
})

test('client: reuses the existing debugHolder-style ?param -> body-flag convention; no new route', () => {
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\.get\('debug'\) === '1'/)
  assert.match(page, /\.\.\.\(wantsChartDebug \? \{ debug: true \} : \{\}\)/)
  assert.doesNotMatch(page, /fetch\(['"`]\/api\/debug/i, 'no new standalone debug route added for this')
})

test('client: panel renders only when result.chartDebug is present, never unwraps it unsafely', () => {
  assert.match(page, /\{result\.chartDebug && <ChartDebugPanel debug=\{result\.chartDebug\} \/>\}/)
})

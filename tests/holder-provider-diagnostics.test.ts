// Per-provider holder DEBUG diagnostics (lib/holderProviderDiagnostics.ts + route/page wiring):
// GoldRush (primary) and Moralis (fallback) each report attempt, status category, timeout, rows,
// provider total and usable rows — without secrets, raw bodies, extra calls, or any change to the
// public holder result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describeHolderProvider, formatHolderProviderDiagnostic, isTimeoutError } from '../lib/holderProviderDiagnostics.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const rows = (n: number, key: 'address' | 'owner_address') => Array.from({ length: n }, (_, i) => ({ [key]: '0x' + (i + 1).toString(16).padStart(40, '0'), balance: String(1000 - i) }))

test('GoldRush timeout + Moralis success: the timeout is named, and Moralis shows its rows, total and usable rows', () => {
  const goldrush = { __status: 'error', __reason: 'provider_error', __statusCode: undefined, __endpointPath: '/v1/base-mainnet/tokens/0x/token_holders_v2/', __chainUsed: 'base-mainnet', __hasApiKey: true, __timedOut: true }
  const moralis = { result: rows(100, 'owner_address'), total: 812_345, __httpStatus: 200 }
  const g = describeHolderProvider('goldrush', goldrush, { usableRows: 0, consulted: true })
  const m = describeHolderProvider('moralis', moralis, { usableRows: 98, consulted: true })
  assert.deepEqual(
    [g.attempted, g.statusCategory, g.timedOut, g.httpStatus, g.rowsReturned, g.usableRows, g.reason],
    [true, 'timeout', true, null, 0, 0, 'timeout'],
  )
  assert.deepEqual(
    [m.attempted, m.consulted, m.statusCategory, m.httpStatus, m.timedOut, m.rowsReturned, m.providerTotal, m.usableRows, m.reason],
    [true, true, 'ok', 200, false, 100, 812_345, 98, 'ok'],
  )
  assert.equal(formatHolderProviderDiagnostic(g), 'timeout · attempted · timed out · rows 0 · usable 0 · total — · consulted')
})

test('GoldRush success: Moralis was fetched but not consulted by the resolver', () => {
  const goldrush = { data: { items: rows(100, 'address'), pagination: { total_count: 640_001 } }, __statusCode: 200, __chainUsed: 'base-mainnet', __hasApiKey: true }
  const moralis = { result: rows(100, 'owner_address'), __httpStatus: 200 }
  const g = describeHolderProvider('goldrush', goldrush, { usableRows: 100, consulted: true })
  const m = describeHolderProvider('moralis', moralis, { usableRows: null, consulted: false })
  assert.deepEqual([g.statusCategory, g.httpStatus, g.rowsReturned, g.providerTotal, g.usableRows, g.reason], ['ok', 200, 100, 640_001, 100, 'ok'])
  assert.deepEqual([m.attempted, m.consulted, m.usableRows, m.reason], [true, false, null, 'rows_returned_not_consulted'])
})

test('both fail: each provider keeps its own category (HTTP 4xx / 5xx / network / empty / not configured)', () => {
  const cases: Array<[Parameters<typeof describeHolderProvider>, string, string]> = [
    [['goldrush', { __status: 'error', __reason: 'provider_error', __statusCode: 503 }, { usableRows: 0, consulted: true }], 'http_5xx', 'http_503'],
    [['goldrush', { __status: 'error', __reason: 'bad_request_check_endpoint_params', __statusCode: 400 }, { usableRows: 0, consulted: true }], 'http_4xx', 'http_400'],
    [['moralis', { __status: 'error', __httpStatus: 401 }, { usableRows: 0, consulted: true }], 'http_4xx', 'http_401'],
    [['moralis', { __status: 'error', __httpStatus: 429 }, { usableRows: 0, consulted: true }], 'http_4xx', 'http_429'],
    [['moralis', { __status: 'error', __timedOut: false }, { usableRows: 0, consulted: true }], 'network_error', 'network_error'],
    [['moralis', { __status: 'error', __timedOut: true }, { usableRows: 0, consulted: true }], 'timeout', 'timeout'],
    [['goldrush', { data: { items: [] }, __statusCode: 200 }, { usableRows: 0, consulted: true }], 'empty', 'no_rows_returned'],
    [['moralis', { result: rows(3, 'owner_address'), __httpStatus: 200 }, { usableRows: 0, consulted: true }], 'ok', 'no_usable_rows_after_normalization'],
    [['moralis', { __status: 'not_configured' }, { usableRows: null, consulted: false }], 'not_configured', 'not_configured'],
    [['goldrush', { __status: 'not_configured', __reason: 'missing_api_key' }, { usableRows: null, consulted: false }], 'not_configured', 'missing_api_key'],
  ]
  for (const [args, category, reason] of cases) {
    const d = describeHolderProvider(...args)
    assert.deepEqual([d.statusCategory, d.reason], [category, reason], JSON.stringify(args[1]))
    assert.equal(d.attempted, category !== 'not_configured')
  }
})

test('timeouts are recognised from the real AbortSignal.timeout error', async () => {
  const err = await fetch('http://127.0.0.1:9/', { signal: AbortSignal.timeout(1) }).then(() => null, (e: unknown) => e)
  // Either the timeout fires first (TimeoutError) or the connection is refused (TypeError) — only the former is a timeout.
  const name = (err as { name?: string } | null)?.name
  assert.equal(isTimeoutError(err), name === 'TimeoutError' || name === 'AbortError')
  assert.equal(isTimeoutError(new DOMException('t', 'TimeoutError')), true)
  assert.equal(isTimeoutError(new TypeError('fetch failed')), false)
})

test('no secrets or raw bodies: only safe fields, whatever the raw response carried', () => {
  const raw = { __status: 'error', __statusCode: 401, __reason: 'Invalid API key sk-live-SECRET', error_message: 'Invalid API key sk-live-SECRET', headers: { Authorization: 'Bearer SECRET' } }
  const d = describeHolderProvider('goldrush', raw, { usableRows: 0, consulted: true })
  assert.deepEqual(Object.keys(d).sort(), ['attempted', 'consulted', 'httpStatus', 'provider', 'providerTotal', 'reason', 'rowsReturned', 'statusCategory', 'timedOut', 'usableRows'])
  assert.doesNotMatch(JSON.stringify(d) + formatHolderProviderDiagnostic(d), /SECRET|Bearer|Invalid API key/)
})

test('wiring: zero extra calls, no failed-response body kept, public holder reason unchanged, debug-only output', () => {
  const route = read('app/api/token/route.ts')
  assert.equal((route.match(/deep-index\.moralis\.io\/api\/v2\.2\/erc20\/\$\{contract\}\/owners/g) ?? []).length, 1, 'one Moralis owners request, as before')
  assert.equal((route.match(/fetchTokenHolders\(chain, contract\)/g) ?? []).length, 1, 'one GoldRush holders request, as before')
  assert.match(route, /if \(!res\.ok\) return \{ __status: 'error', __httpStatus: res\.status \}/, 'a failed Moralis body is never read')
  assert.match(route, /catch \(err\) \{ return \{ __status: 'error', __timedOut: isTimeoutError\(err\) \} \}/)
  assert.match(route, /__status: 'error', __reason: lastReason, __statusCode: statusCode, __endpointPath: endpointPath, __chainUsed: chainSlug, __hasApiKey: true, __timedOut: sawTimeout && statusCode == null \}/, 'GoldRush __reason (public) is unchanged; __timedOut is added alongside')
  assert.match(route, /AbortSignal\.timeout\(8000\)/, 'timeouts unchanged')
  const dbg = route.slice(route.indexOf('debugHolderStatus: {'), route.indexOf('debugHolderStatus: {') + 2500)
  assert.match(dbg, /providers: \{\s*goldrush: describeHolderProvider\('goldrush', holdersRaw,/)
  assert.match(dbg, /moralis: describeHolderProvider\('moralis', moralisHoldersRaw,/)
  assert.match(route.slice(route.indexOf('debugHolderStatus: {') - 200, route.indexOf('debugHolderStatus: {')), /debugMode === true && debugHolder === true/, 'only in the existing gated holder debug output')
  assert.doesNotMatch(read('lib/holderProviderDiagnostics.ts'), /\bfetch\(|process\.env/)
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /\(\['goldrush','moralis'\] as const\)\.map\(\(p\): \[string,string\] => \[p, formatHolderProviderDiagnostic\(d\.providers\?\.\[p\]\)\]\)/)
})

// Early Buyers request failures: every failed response becomes a plain message with its code and the server's
// request id, a non-JSON timeout or gateway page never surfaces as a JSON parse error, and no failure is turned
// into an empty "no buyers" result.
//   npx tsx --test tests/early-buyers-request-failure.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { earlyBuyersRequestFailure } from '../app/terminal/token-scanner/earlyBuyersView.ts'

test('known route codes map to plain messages and keep the code and request id', () => {
  const f = earlyBuyersRequestFailure(429, JSON.stringify({ error: 'quota_store_unavailable' }), 'req-1')
  assert.equal(f.code, 'quota_store_unavailable')
  assert.equal(f.requestId, 'req-1')
  assert.match(f.message, /cannot check usage limits/)
  assert.match(earlyBuyersRequestFailure(429, '{"error":"token_in_progress"}', null).message, /still running/)
  assert.match(earlyBuyersRequestFailure(429, '{"error":"user_quota"}', null).message, /today’s Early Buyers analyses/)
  assert.match(earlyBuyersRequestFailure(401, '{"error":"unauthorized","message":"x"}', null).message, /Sign in again/)
  assert.match(earlyBuyersRequestFailure(500, '{"error":"early_buyers_failed"}', 'req-2').message, /failed while analysing/)
})

test('a platform timeout or gateway page (not JSON) is a clear timeout/unavailable message, not a parse error', () => {
  const timeout = earlyBuyersRequestFailure(504, '<!DOCTYPE html><html>An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT</html>', null)
  assert.equal(timeout.code, null)
  assert.match(timeout.message, /timed out/)
  assert.doesNotMatch(timeout.message, /JSON|Unexpected token/)
  assert.match(earlyBuyersRequestFailure(502, 'Bad Gateway', null).message, /unavailable right now \(HTTP 502\)/)
  assert.match(earlyBuyersRequestFailure(500, '', null).message, /HTTP 500/)
})

test('unknown or unsafe codes are not echoed as the message', () => {
  const f = earlyBuyersRequestFailure(500, JSON.stringify({ error: 'https://rpc.example/v2/SECRETKEY failed' }), null)
  assert.equal(f.code, null, 'only short snake_case codes are kept')
  assert.doesNotMatch(f.message, /SECRETKEY/)
  assert.equal(earlyBuyersRequestFailure(418, '{"error":"some_new_code"}', null).code, 'some_new_code')
})

test('panel: reads the body as text, keeps the request id, and renders only real intel', () => {
  const panel = readFileSync(new URL('../app/terminal/token-scanner/EarlyBuyersPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /response\.headers\.get\('x-early-buyers-request-id'\)/)
  assert.match(panel, /await response\.text\(\)/)
  assert.doesNotMatch(panel, /await response\.json\(\)/, 'a non-JSON body must not throw a parse error into the UI')
  assert.match(panel, /setError\(earlyBuyersRequestFailure\(/)
  assert.match(panel, /\{intel && <EarlyBuyersReport intel=\{intel\}/, 'a failure never renders a report')
})

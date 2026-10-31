// Whale Alerts feed rules + UI: only priced alerts of $250+ reach the feed AND the counters, the
// Value Range filter is gone, failed historical prices are retried within minutes, a cold feed has a
// pricing time budget, and each row leads with action / token / wallet / time / USD.
//   npx tsx --test tests/whale-alerts-feed-rules.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FEED_MIN_USD, feedValueReason, routineChurnReason, rowSymbols, tradeUsdValue } from '../lib/server/whaleFeedCuration'

test('feed value rule: unpriced is excluded, below $250 is excluded, $250+ is shown', () => {
  assert.equal(FEED_MIN_USD, 250)
  assert.equal(feedValueReason(null), 'unpriced')
  assert.equal(feedValueReason(undefined), 'unpriced')
  assert.equal(feedValueReason(0), 'unpriced')
  assert.equal(feedValueReason(Number.NaN), 'unpriced')
  assert.equal(feedValueReason(249.99), 'below_min')
  assert.equal(feedValueReason(250), null)
  assert.equal(feedValueReason(1_000_000), null)
})

test('a swap is judged on its one-side value: $200 paid for a token is below the floor even if legs add to $400', () => {
  const legs = [{ side: 'sell', token_symbol: 'USDC', amount_usd: 200 }, { side: 'buy', token_symbol: 'PEPE', amount_usd: 200 }]
  assert.equal(feedValueReason(tradeUsdValue(legs)), 'below_min')
  // An unpriced token received with nothing priced is excluded, never shown as "USD unavailable".
  assert.equal(feedValueReason(tradeUsdValue([{ side: 'buy', token_symbol: 'CLAUDE', amount_usd: null }])), 'unpriced')
  // Routine churn stays hidden whatever the value.
  assert.equal(routineChurnReason(rowSymbols('USDC'), 50_000), 'stablecoin_only')
})

const feed = readFileSync(new URL('../app/api/whale-alerts/route.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')

test('feed and counters apply the same value rule', () => {
  assert.match(feed, /const valued = curated\.filter\(row => \{\n\s+const reason = feedValueReason\(row\.amount_usd/)
  assert.match(feed, /filterRoutingOnlySwaps\(valued\)/)
  assert.match(feed, /if \(routineChurnReason\(symbols, usd\) \|\| feedValueReason\(usd\)\) continue/)
  assert.match(feed, /hiddenAsUnpriced,\n\s+hiddenBelowMinUsd,/)
})

test('pricing speed: failed historical lookups retry in 5 minutes, cold loads stop starting lookups after 8s', () => {
  assert.match(feed, /const HISTORICAL_FAILURE_RETRY_MS = 5 \* 60_000/)
  assert.match(feed, /quote\.priceUsd == null && historicalWhalePriceCache\.get\(key\)\?\.promise === promise/)
  assert.match(feed, /while \(cursor < rows\.length && Date\.now\(\) < deadline\)/)
})

test('UI: no Value Range filter, no "USD unavailable" row copy, row leads with action, token, wallet, time and USD', () => {
  assert.doesNotMatch(page, /Value range|RANGE_OPTIONS|setValueRange|p\.set\('valueRange'/)
  assert.doesNotMatch(page, /Show unpriced activity|Broaden filters/)
  const rowStart = page.indexOf('alerts.map((alert, i) => {')
  assert.doesNotMatch(page.slice(rowStart, page.indexOf('{/* load more */}')), /USD unavailable/)
  const row = page.slice(page.indexOf('// ROW LAYOUT:'), page.indexOf('{/* load more */}'))
  const order = ['{chipLabel}', '>{tok}<', '{walletName}', '{timeAgo(alert.occurred_at)}', '{amtShow}']
  const at = order.map(token => row.indexOf(token))
  assert.ok(at.every(i => i > 0), `row renders ${order.join(', ')}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in priority order')
  assert.match(page, /\]\.slice\(0, 3\)/, 'at most three context tags')
})

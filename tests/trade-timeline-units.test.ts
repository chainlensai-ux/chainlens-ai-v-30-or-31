// Trade-timeline USD units: a lot funded with WETH carries its cost in WETH units, but the price looked
// up is the TRADED token's — so the value must be the traded token's quantity × its price, never the
// WETH amount × the traded token's price (live: realized PnL read -$17,788 instead of +$4,110).
//   npx tsx --test tests/trade-timeline-units.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { nonUsdValueFromQuantity } from '../lib/engines/tradeTimelineEngineV2'

test('non-USD cost/proceeds = traded-token quantity × traded-token price', () => {
  // Bought 1,000,000 PEPE for 2 WETH; PEPE at $0.0000045 → $4.50, not 2 × $0.0000045.
  assert.equal(nonUsdValueFromQuantity(1_000_000, 0.0000045), 4.5)
  assert.equal(nonUsdValueFromQuantity(1_000_000, null), null, 'no price → no value, never guessed')
  assert.equal(nonUsdValueFromQuantity(Number.NaN, 1), null)
})

test('every non-USD lookup passes the traded quantity, not the quote amount', () => {
  const src = readFileSync(new URL('../lib/engines/tradeTimelineEngineV2.ts', import.meta.url), 'utf8')
  assert.match(src, /lot\.timestamp, lot\.amount\)/)
  assert.equal((src.match(/closed\.amountClosed\),/g) ?? []).length, 2, 'cost and proceeds of a close')
  assert.doesNotMatch(src, /amount \* priceResult\.priceUsd/)
})

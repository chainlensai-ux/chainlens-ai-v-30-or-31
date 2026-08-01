// TESTS — lib/token/scoring: CORTEX v2 severe-tax cap.
//
// BUG FIX REGRESSION, DISCLOSED: calculateCortexScoreV2's "Very high tax flag" cap previously only
// considered buyTax/sellTax, so a token with a punitive transferTax (buy/sell free, but expensive to
// move — a known rug pattern) never triggered it, even though riskScore.ts's own severe-flag check
// already treats transferTax > 10% as critical. Fixed by including transferTax in the same max().

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateCortexScoreV2 } from './scoring'

// A token with clean buy/sell tax and strong other-category evidence, so the score would be high
// were it not for the severe-tax cap.
function cleanBuySellHighTransferTaxInput(transferTax: number) {
  return {
    honeypot: { isHoneypot: false, buyTax: 0, sellTax: 0, transferTax },
    holderDistribution: { top1: 5, top10: 20, top20: 30, holderCount: 5000 },
    liquidity: { usd: 500_000 },
    security: { simulation: { buyTax: 0, sellTax: 0 }, contractFlags: { mint: 'not_detected', proxy: 'not_detected' } },
    lpControl: { status: 'burned' },
  }
}

test('BUG FIX: a high transferTax alone triggers the severe-tax cap, even with 0% buy/sell tax', () => {
  const result = calculateCortexScoreV2(cleanBuySellHighTransferTaxInput(30))
  assert.ok(result.score != null, 'expected a real score, not Open Check')
  assert.ok(result.score! <= 35, `expected the severe-tax cap (<=35) to apply, got ${result.score}`)
  assert.equal(result.capReason, 'Very high tax flag capped score.')
})

test('a low transferTax does not trigger the severe-tax cap', () => {
  const result = calculateCortexScoreV2(cleanBuySellHighTransferTaxInput(2))
  assert.notEqual(result.capReason, 'Very high tax flag capped score.')
})

test('the cap still triggers on buyTax/sellTax alone, unaffected by this fix', () => {
  const input = {
    honeypot: { isHoneypot: false, buyTax: 25, sellTax: 0, transferTax: 0 },
    holderDistribution: { top1: 5, top10: 20, top20: 30, holderCount: 5000 },
    liquidity: { usd: 500_000 },
    security: { simulation: { buyTax: 25, sellTax: 0 }, contractFlags: { mint: 'not_detected', proxy: 'not_detected' } },
    lpControl: { status: 'burned' },
  }
  const result = calculateCortexScoreV2(input)
  assert.equal(result.capReason, 'Very high tax flag capped score.')
})

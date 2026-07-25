// Tests for WalletProfileHeader.tsx's selectChainBreakdown() — real production evidence this
// closes: hero total showed $3,365.81 (correct, from portfolioV2.totalValueUsd), but the chain
// allocation bar right below it showed BASE $337.90 (98%) + ETH $7.30 (2%) — summing to only
// $345.20, because it read the stale, disconnected V1 `portfolio.chainValueBreakdown` instead of
// the canonical `chainValueUsd` the hero total is built from. Uses node:test. Run with:
//   npx tsx --test app/frontend/components/WalletProfileHeader.selectChainBreakdown.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectChainBreakdown } from './WalletProfileHeader'

describe('selectChainBreakdown — canonical chain-allocation bar (confirmed regression fix)', () => {
  it('percentages are computed against the REAL total, not a separately-summed chain subtotal — matches the real production figures', () => {
    const result = selectChainBreakdown({ 8453: 3358.51, 1: 7.30 }, 3365.81, [])
    assert.equal(result.length, 2)
    const base = result.find((r) => r.chain === 'base')
    const eth = result.find((r) => r.chain === 'eth')
    assert.equal(base?.valueUsd, 3358.51)
    assert.ok(Math.abs((base?.percent ?? 0) - 99.78) < 0.1, 'Base percent must reflect its true share of the REAL total, never a stale/disconnected subtotal')
    assert.equal(eth?.valueUsd, 7.30)
  })

  it('the sum of every row\'s valueUsd must equal the real total when chainValueUsd is the canonical, complete source', () => {
    const total = 3365.81
    const result = selectChainBreakdown({ 8453: 3358.51, 1: 7.30 }, total, [])
    const sum = result.reduce((s, r) => s + r.valueUsd, 0)
    assert.ok(Math.abs(sum - total) < 0.01, 'chain rows must sum to the same real total the hero figure shows — the confirmed bug produced $345.20 against a real $3,365.81 total')
  })

  it('falls back to the old V1 chainValueBreakdown only when chainValueUsd is genuinely absent', () => {
    const v1 = [{ chain: 'base', valueUsd: 100, percent: 100 }]
    const result = selectChainBreakdown(undefined, 100, v1)
    assert.deepEqual(result, v1)
  })

  it('a chain with zero value is excluded from the canonical breakdown (never a fabricated zero-width bar)', () => {
    const result = selectChainBreakdown({ 8453: 100, 1: 0 }, 100, [])
    assert.equal(result.length, 1)
    assert.equal(result[0].chain, 'base')
  })

  it('rows are sorted by value descending', () => {
    const result = selectChainBreakdown({ 1: 10, 8453: 3000, 42161: 50 }, 3060, [])
    assert.deepEqual(result.map((r) => r.chain), ['base', 'arbitrum', 'eth'])
  })
})

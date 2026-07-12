// tests/pnl/unrealizedPnlEngine.verify.ts — self-test for lib/engines/unrealizedPnlEngine.ts.
//
// Uses computeUnrealizedPnl's injectable `fetchPriceAtTime` seam (added alongside this test —
// same additive-testing-seam convention as priceLotsForWallet.ts's `priceFn`) so every branch can
// be exercised deterministically, with no live network call.
//
// SCOPE LIMITATIONS, DISCLOSED (both confirmed by reading the real code, not assumed):
//
// 1. "huge price (1e12) -> clamped + missing_evidence" is not testable as a single case: a
//    CURRENT price of 1e12 fails the sanity guard ($0 < price <= $1e6) immediately and returns
//    integrity 'missing_evidence' — it never reaches the clamp step at all (clamping only applies
//    to the COMPUTED unrealizedPnlUsd of an already-'ok' token, not to a raw price). A token can't
//    be both clamped and missing_evidence in this design; those are two different, non-overlapping
//    failure/success paths. Tested separately below: one case with an out-of-range current price
//    (-> missing_evidence), and one case with valid prices whose resulting PnL is itself extreme
//    (-> clamped, integrity 'ok').
//
// 2. "circuit breaker triggered -> auto-reset + retry" is not implemented as a 5th test case:
//    lib/engines/unrealizedPnlEngine.ts has no circuit breaker, no KV dependency, and no retry
//    logic of any kind (confirmed by grep — its only dependency is getPriceAtTime ->
//    lib/providers/{goldrush,coingecko,onchainDex}.ts, none of which touch KV). The real circuit
//    breaker lives in lib/server/cache/tokenCache.ts, a completely separate module this engine
//    never calls. Fabricating a fake "circuit breaker" behavior inside this file's test would
//    test something that doesn't exist in the code under test.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeUnrealizedPnl, type Holding, type GetPriceAtTimeFn } from '@/lib/engines/unrealizedPnlEngine'
import type { PricingAtTimeResult } from '@/lib/engines/pricingAtTimeEngine'

const NOW = 1_700_000_000 // fixed unix seconds, arbitrary but deterministic
const ACQUIRED_AT = NOW - 86_400

function holding(overrides: Partial<Holding>): Holding {
  return {
    tokenAddress: '0xtoken',
    chain: 'base',
    amount: 10,
    currentPriceUsd: 5,
    currentValueUsd: 50,
    acquiredAtTimestamp: ACQUIRED_AT,
    ...overrides,
  }
}

function priceResult(priceUsd: number | null): PricingAtTimeResult {
  return {
    priceUsd,
    source: priceUsd != null ? 'goldrush' : null,
    confidence: priceUsd != null ? 'high' : 'none',
    evidence: priceUsd != null ? [{ provider: 'goldrush', priceUsd, timestamp: ACQUIRED_AT }] : [],
  }
}

describe('computeUnrealizedPnl — valid price', () => {
  it('computes real, non-null unrealizedPnlUsd and integrity "ok"', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(2) // bought at $2, now $5
    const result = await computeUnrealizedPnl(
      { chain: 'base', walletAddress: '0xwallet', holdings: [holding({ tokenAddress: '0xvalid', currentPriceUsd: 5, currentValueUsd: 50 })] },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'ok')
    assert.equal(token.costBasisUsd, 20) // 10 * $2
    assert.equal(token.unrealizedPnlUsd, 30) // $50 - $20
    assert.equal(result.totalUnrealizedPnlUsd, 30)
    assert.deepEqual(result.excludedFromPnl, [])
  })
})

describe('computeUnrealizedPnl — invalid current price (<= 0)', () => {
  it('marks integrity "missing_evidence", nulls costBasis/unrealizedPnl, excludes from total', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(2)
    const result = await computeUnrealizedPnl(
      { chain: 'base', walletAddress: '0xwallet', holdings: [holding({ tokenAddress: '0xzero', currentPriceUsd: 0, currentValueUsd: 0 })] },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'missing_evidence')
    assert.equal(token.costBasisUsd, null)
    assert.equal(token.unrealizedPnlUsd, null)
    assert.equal(result.totalUnrealizedPnlUsd, 0)
    assert.deepEqual(result.excludedFromPnl, ['0xzero'])
  })
})

describe('computeUnrealizedPnl — current price out of range (> 1e6)', () => {
  it('marks integrity "missing_evidence" (never reaches the clamp step — see file header)', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(2)
    const result = await computeUnrealizedPnl(
      { chain: 'base', walletAddress: '0xwallet', holdings: [holding({ tokenAddress: '0xhuge', currentPriceUsd: 1e12, currentValueUsd: 1e13 })] },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'missing_evidence')
    assert.equal(token.unrealizedPnlUsd, null)
    assert.ok(result.excludedFromPnl.includes('0xhuge'))
  })
})

describe('computeUnrealizedPnl — genuinely extreme PnL from valid prices (clamp)', () => {
  it('clamps to +-1e9 while keeping integrity "ok"', async () => {
    // Valid, in-range prices whose resulting PnL is itself extreme: amount large enough that
    // (currentValueUsd - costBasisUsd) exceeds 1e9.
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(0.0001) // bought near-zero
    const result = await computeUnrealizedPnl(
      {
        chain: 'base',
        walletAddress: '0xwallet',
        holdings: [holding({ tokenAddress: '0xextreme', amount: 1_000_000_000, currentPriceUsd: 5, currentValueUsd: 5_000_000_000 })],
      },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'ok')
    assert.equal(token.unrealizedPnlUsd, 1e9) // clamped, not the raw ~$5B
    assert.equal(result.totalUnrealizedPnlUsd, 1e9)
    assert.deepEqual(result.excludedFromPnl, [])
  })
})

describe('computeUnrealizedPnl — missing historical price', () => {
  it('marks integrity "missing_cost_basis", never fabricates cost basis = 0', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(null)
    const result = await computeUnrealizedPnl(
      { chain: 'base', walletAddress: '0xwallet', holdings: [holding({ tokenAddress: '0xmissing' })] },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'missing_cost_basis')
    assert.equal(token.costBasisUsd, null)
    assert.equal(token.unrealizedPnlUsd, null)
    assert.ok(result.excludedFromPnl.includes('0xmissing'))
  })
})

describe('computeUnrealizedPnl — total/exclusion aggregation across mixed tokens', () => {
  it('never treats a null unrealizedPnlUsd as 0 in a way that could double-count or miscount', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async (req) => {
      if (req.tokenAddress === '0xvalid') return priceResult(2)
      return priceResult(null)
    }
    const result = await computeUnrealizedPnl(
      {
        chain: 'base',
        walletAddress: '0xwallet',
        holdings: [
          holding({ tokenAddress: '0xvalid', currentPriceUsd: 5, currentValueUsd: 50 }),
          holding({ tokenAddress: '0xmissing1' }),
          holding({ tokenAddress: '0xmissing2' }),
        ],
      },
      fetchPriceAtTime,
    )
    assert.equal(result.totalUnrealizedPnlUsd, 30) // only the one 'ok' token contributes
    assert.deepEqual(result.excludedFromPnl.sort(), ['0xmissing1', '0xmissing2'])
  })
})

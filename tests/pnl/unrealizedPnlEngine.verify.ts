// tests/pnl/unrealizedPnlEngine.verify.ts — self-test for lib/engines/unrealizedPnlEngine.ts.
//
// Uses computeUnrealizedPnl's injectable `fetchPriceAtTime` seam (GetPriceAtTimeFn — the real
// getPriceAtTime/PricingAtTimeResult contract, not a narrower invented one) so every branch can be
// exercised deterministically, with no live network call.
//
// KV / CIRCUIT-BREAKER SCOPE, EXPLICITLY DISCLOSED (do not remove this note): lib/engines/
// unrealizedPnlEngine.ts has NO circuit breaker, NO KV dependency, and NO retry logic of any kind
// — confirmed by reading its actual imports: its only price path is getPriceAtTime() ->
// lib/providers/{goldrush,coingecko,onchainDex}.ts, none of which import KV, a circuit breaker, or
// providerFetchWindow. `circuit_breaker_open`, `kv_disabled_for_request`, and
// `kv_skip_large_payload` are real log strings, but they belong to lib/server/cache/tokenCache.ts
// and lib/server/cache/v2StageCache.ts — a completely separate module this engine never calls.
// There is therefore no "circuit breaker triggered -> auto-reset + retry" test case here: writing
// one would test behavior that does not exist in the code under test.
//
// PRICE-CLAMP-AT-1E9 CONTRADICTION, DISCLOSED: a later task asked to keep the existing ($0, $1e6]
// sanity guard (reject anything outside it as missing_evidence) AND ALSO clamp a price ">1e9 but
// still passing the sanity guard" to 1e9. Those two requirements are mutually exclusive — nothing
// >1e9 can ever pass a (0, 1e6] guard, so that clamp branch is structurally unreachable and was not
// implemented (no fake/dead code, and no test for an input that cannot exist under the guard this
// file also verifies). The engine still has a real, tested clamp — on the COMPUTED
// unrealizedPnlUsd, not on the raw price — covered by the "Clamp behavior test" below.
//
// CASE NUMBERING NOTE: an earlier task's "Case 5" meant "mixed portfolio" (kept below, still
// covered) — a later task separately defined "Case 5" as "empty token set." Both are real, useful,
// non-conflicting scenarios; kept both, with descriptive (not renumbered) names to avoid confusion.

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

describe('Case 1 — normal, sane prices', () => {
  it('produces a finite, non-negative cost basis, a finite/reasonable PnL, and integritySummary "ok"', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(2) // bought at $2, now $5
    const result = await computeUnrealizedPnl(
      { chain: 'base', walletAddress: '0xwallet', holdings: [holding({ tokenAddress: '0xvalid', currentPriceUsd: 5, currentValueUsd: 50 })] },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'ok')
    assert.equal(token.costBasisUsd, 20) // 10 * $2
    assert.ok(token.costBasisUsd != null && Number.isFinite(token.costBasisUsd) && token.costBasisUsd >= 0)
    assert.ok(token.currentValueUsd > 0 && token.currentValueUsd <= 1e6 * holding({}).amount)
    assert.equal(token.unrealizedPnlUsd, 30) // $50 - $20
    assert.ok(token.unrealizedPnlUsd != null && Number.isFinite(token.unrealizedPnlUsd))
    assert.equal(result.totalUnrealizedPnlUsd, 30)
    assert.deepEqual(result.excludedFromPnl, [])
    assert.equal(result.integritySummary, 'ok')
    assert.deepEqual(result.integrityCounts, { ok: 1, partial: 0, failed: 0, missing_cost_basis: 0, missing_evidence: 0 })
    assert.equal(result.integrityCounts.failed, 0) // never a per-token 'failed' — see engine's own field comment
    assert.equal(result.integrityCounts.missing_cost_basis, 0)
    assert.equal(result.integrityCounts.missing_evidence, 0)
    // AUDIT FIX assertions: walletAddress/chain/anyUnrealizedPnlClamped/anyUnreasonablePnL are now
    // genuinely returned (not just logged) — asserted directly against the return value.
    assert.equal(result.walletAddress, '0xwallet')
    assert.equal(result.chain, 'base')
    assert.equal(result.anyUnrealizedPnlClamped, false)
    assert.equal(result.anyUnreasonablePnL, false)
  })
})

describe('Case 2 — corrupted cost basis (negative amount -> negative cost basis)', () => {
  it('marks integrity "missing_cost_basis" instead of fabricating a negative/NaN PnL, integritySummary "partial" or "failed"', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(2)
    const result = await computeUnrealizedPnl(
      {
        chain: 'base',
        walletAddress: '0xwallet',
        holdings: [holding({ tokenAddress: '0xnegative', amount: -10, currentPriceUsd: 5, currentValueUsd: -50 })],
      },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'missing_cost_basis')
    assert.equal(token.costBasisUsd, null)
    assert.equal(token.unrealizedPnlUsd, null)
    assert.ok(result.excludedFromPnl.includes('0xnegative'))
    assert.ok(result.integritySummary === 'partial' || result.integritySummary === 'failed')
    // Only one token in this wallet and it failed -> deterministically 'failed' here, not just
    // "one of the two allowed values" by luck.
    assert.equal(result.integritySummary, 'failed')
    assert.equal(result.walletAddress, '0xwallet')
    assert.equal(result.chain, 'base')
    // No 'ok' tokens at all here -> neither aggregate flag can be true (both derive from okTokens).
    assert.equal(result.anyUnrealizedPnlClamped, false)
    assert.equal(result.anyUnreasonablePnL, false)
  })
})

describe('Case 3 — absurd current price (1e20) -> missing_evidence, never "clamped and ok"', () => {
  it('rejects the price via the sanity guard rather than clamping it', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(2)
    const result = await computeUnrealizedPnl(
      { chain: 'base', walletAddress: '0xwallet', holdings: [holding({ tokenAddress: '0xabsurd', currentPriceUsd: 1e20, currentValueUsd: 1e21 })] },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'missing_evidence')
    assert.equal(token.unrealizedPnlUsd, null)
    assert.ok(result.excludedFromPnl.includes('0xabsurd'))
    assert.equal(result.integritySummary, 'failed') // only token in this wallet, and it failed
    assert.equal(result.walletAddress, '0xwallet')
    assert.equal(result.chain, 'base')
    assert.equal(result.anyUnrealizedPnlClamped, false)
    assert.equal(result.anyUnreasonablePnL, false)
  })
})

describe('Case 4 — explosion-style unrealized PnL via injected price', () => {
  it('flags unrealizedPnlWithinReasonableRangeOfCostBasis as false (via integritySummary) even though the token itself is integrity "ok"', async () => {
    // Valid, in-range prices (both pass the ($0, $1e6] sanity guard) whose resulting PnL is
    // itself extreme relative to its own tiny cost basis — the "-3.8e34"-style bug class this
    // task described, reproduced with real numbers rather than asserted by fiat.
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(1e-10) // bought at a near-zero historical price
    const result = await computeUnrealizedPnl(
      {
        chain: 'base',
        walletAddress: '0xwallet',
        holdings: [holding({ tokenAddress: '0xexplosion', amount: 1e9, currentPriceUsd: 1e6, currentValueUsd: 1e15 })],
      },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'ok') // real cost basis WAS found — this isn't a missing-evidence case
    assert.equal(token.unrealizedPnlUsd, 1e9) // clamped from the raw ~1e15
    // costBasisUsd here is 1e9 * 1e-10 = 0.1 -> reasonableness threshold = max(0.1, 1) * 1e6 = 1e6,
    // and the clamped PnL (1e9) still exceeds it -> not "reasonable" even post-clamp.
    assert.ok(token.costBasisUsd != null && token.costBasisUsd < 1)
    assert.equal(result.integritySummary, 'failed') // integrity 'ok' alone isn't enough for 'ok' overall
    // integrityCounts.ok still counts this token (evidence-based classification is unchanged);
    // integrityCounts.partial captures the "ok but unreasonable" distinction instead.
    assert.equal(result.integrityCounts.ok, 1)
    assert.equal(result.integrityCounts.partial, 1)
    assert.equal(result.integrityCounts.failed, 0)
    assert.equal(result.walletAddress, '0xwallet')
    assert.equal(result.chain, 'base')
    // The one 'ok' token's PnL was both clamped (raw ~1e15 -> 1e9) AND unreasonable relative to
    // its own tiny cost basis — both flags real and true here, not fabricated.
    assert.equal(result.anyUnrealizedPnlClamped, true)
    assert.equal(result.anyUnreasonablePnL, true)
  })
})

describe('Case 5 — mixed portfolio (normal + missing_cost_basis + missing_evidence + implausible)', () => {
  it('produces integritySummary "partial" with counts reflecting the exact mix', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async (req) => {
      if (req.tokenAddress === '0xnormal') return priceResult(2)
      if (req.tokenAddress === '0xmissingcost') return priceResult(null)
      if (req.tokenAddress === '0ximplausible') return priceResult(1e-10)
      return priceResult(2)
    }
    const result = await computeUnrealizedPnl(
      {
        chain: 'base',
        walletAddress: '0xwallet',
        holdings: [
          holding({ tokenAddress: '0xnormal', currentPriceUsd: 5, currentValueUsd: 50 }),
          holding({ tokenAddress: '0xmissingcost' }),
          holding({ tokenAddress: '0xmissingevidence', currentPriceUsd: 1e20, currentValueUsd: 1e21 }),
          holding({ tokenAddress: '0ximplausible', amount: 1e9, currentPriceUsd: 1e6, currentValueUsd: 1e15 }),
        ],
      },
      fetchPriceAtTime,
    )
    assert.equal(result.integritySummary, 'partial')
    // 0xnormal AND 0ximplausible are both evidence-'ok' (ok: 2) — 0ximplausible just also fails
    // the reasonableness check (partial: 1, counted alongside, not instead of, ok).
    assert.deepEqual(result.integrityCounts, { ok: 2, partial: 1, failed: 0, missing_cost_basis: 1, missing_evidence: 1 })
    // 0xnormal contributes 30; 0ximplausible is integrity 'ok' too, so its CLAMPED 1e9 is summed
    // into the total as well (integrity, not reasonableness, gates totalUnrealizedPnlUsd).
    assert.equal(result.totalUnrealizedPnlUsd, 30 + 1e9)
    assert.ok(result.excludedFromPnl.includes('0xmissingcost'))
    assert.ok(result.excludedFromPnl.includes('0xmissingevidence'))
    assert.ok(!result.excludedFromPnl.includes('0xnormal'))
    assert.equal(result.walletAddress, '0xwallet')
    assert.equal(result.chain, 'base')
    // 0ximplausible is the one 'ok' token whose PnL was clamped and unreasonable; 0xnormal is
    // 'ok', not clamped, reasonable — the aggregate flags are true because at least one qualifies.
    assert.equal(result.anyUnrealizedPnlClamped, true)
    assert.equal(result.anyUnreasonablePnL, true)
  })
})

describe('Clamp behavior test (separate from missing_evidence)', () => {
  it('clamps a genuinely extreme but sanity-guard-passing PnL to +-1e9 while integrity stays "ok" and integritySummary stays "ok"', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(0.0001) // bought near-zero
    const result = await computeUnrealizedPnl(
      {
        chain: 'base',
        walletAddress: '0xwallet',
        holdings: [holding({ tokenAddress: '0xclamped', amount: 1_000_000_000, currentPriceUsd: 5, currentValueUsd: 5_000_000_000 })],
      },
      fetchPriceAtTime,
    )
    const token = result.tokens[0]
    assert.equal(token.integrity, 'ok')
    assert.equal(token.unrealizedPnlUsd, 1e9) // clamped, not the raw ~$5B
    assert.equal(result.totalUnrealizedPnlUsd, 1e9)
    assert.deepEqual(result.excludedFromPnl, [])
    // Here costBasisUsd = 1e9 * 0.0001 = $100,000 -> threshold = 1e11, clamped 1e9 is within it ->
    // genuinely "reasonable" (unlike Case 4's tiny cost basis) -> integritySummary really is 'ok'.
    assert.equal(result.integritySummary, 'ok')
    assert.equal(result.integrityCounts.partial, 0)
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
    assert.equal(result.integritySummary, 'partial') // one ok, two failed
  })
})

describe('Empty token set', () => {
  it('returns integritySummary "ok" and tokensProcessed 0 for an empty holdings list', async () => {
    const fetchPriceAtTime: GetPriceAtTimeFn = async () => priceResult(2)
    const result = await computeUnrealizedPnl(
      { chain: 'base', walletAddress: '0xwallet', holdings: [] },
      fetchPriceAtTime,
    )
    assert.equal(result.integritySummary, 'ok') // vacuously true — nothing failed
    assert.equal(result.tokensProcessed, 0)
    assert.equal(result.tokens.length, 0)
    assert.equal(result.totalUnrealizedPnlUsd, 0)
    assert.deepEqual(result.excludedFromPnl, [])
    assert.deepEqual(result.integrityCounts, { ok: 0, partial: 0, failed: 0, missing_cost_basis: 0, missing_evidence: 0 })
  })
})

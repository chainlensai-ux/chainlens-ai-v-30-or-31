// PERF-SPRINT TASK, DISCLOSED: static source checks for the historical-pricing-engine changes in
// this task — same "read the real source, assert on it directly" convention already used for
// src/pipeline/scanPerformance.staticCheck.test.ts, applied here because priceLotsForWallet.ts's
// own real dependency graph (structural FIFO pre-pass, accepted-evidence KV, the completion-yield
// scheduler) is too large to stand up a full fixture for in a quick regression test — the existing
// src/pipeline/priceLotsForWallet.*.test.ts family already covers correctness at that depth; this
// file only locks in the mechanism of the NEW changes so a future edit can't silently regress them.
// Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.historicalPricingPerf.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./priceLotsForWallet.ts', import.meta.url)), 'utf8')

// PERF-GUARDRAILS FOLLOW-UP TASK, DISCLOSED ("Performance optimizations must be performance-only
// ... Do NOT accept any optimization that changes realized PnL ... outputs must be identical"): the
// dust-lot quantity-floor skip that USED to live here was reverted — even a lot filtered at a tiny
// quantity guarantees a null cost basis/proceeds where previously it got a real pricing attempt
// (which could resolve to a real, if tiny, non-null number). That is a genuine output difference,
// not a bug fix, so it failed this codebase's "identical outputs only" bar. This regression test
// proves the skip stays gone — every buy/sell requirement must reach toPriceableEntry unfiltered.
describe('no dust-lot quantity filtering (perf-guardrails: reverted — outputs must be identical, not "close enough")', () => {
  it('buys/sells are mapped to pricing requirements directly — no quantity-based .filter() before toPriceableEntry', () => {
    assert.match(src, /let buyRequirementEntries = buys\.map\(\(e\) => toPriceableEntry\(e, rankForEvent\(e\)\)\)/, 'every buy must become a pricing requirement — no filtering by amount/quantity')
    assert.match(src, /let sellRequirementEntries = \[\.\.\.sells\.map\(\(e\) => toPriceableEntry\(e, rankForEvent\(e\)\)\), \.\.\.nativeQuoteEntries\]/, 'every sell must become a pricing requirement — no filtering by amount/quantity')
    assert.doesNotMatch(src, /DUST_LOT_AMOUNT_FLOOR/, 'the reverted dust-floor constant must not reappear')
    assert.doesNotMatch(src, /isNotDustLot/, 'the reverted dust filter predicate must not reappear')
  })
})

describe('historicalPricingPerformanceSummary (perf-sprint: "Add diagnostics: elapsed time, unique requests, duplicates eliminated, cache hit rate, provider calls avoided, time saved")', () => {
  it('is built from real, already-measured deltas — snapshot before this call, snapshot after, never a cumulative cross-request total', () => {
    assert.match(src, /const providerCostAuditBefore = getWalletProviderCostAudit\(\)/, 'must snapshot the shared ledger BEFORE this call\'s own work runs')
    assert.match(src, /const providerCostAuditAfter = getWalletProviderCostAudit\(\)/, 'must snapshot again right before building the summary')
    assert.match(src, /providerCostAuditAfter\.cache\.requestHits - providerCostAuditBefore\.cache\.requestHits/, 'duplicateRequestsEliminated must be a real delta, not a raw cumulative read')
  })

  it('elapsedMs is measured with performance.now() around this entire function call, not a guessed constant', () => {
    assert.match(src, /const historicalPricingStartedAtMs = performance\.now\(\)/, 'must capture a real start timestamp at function entry')
    assert.match(src, /elapsedMs: Math\.round\(performance\.now\(\) - historicalPricingStartedAtMs\)/, 'elapsedMs must be a real measured delta')
  })

  it('estimatedTimeSavedMs is explicitly labeled/derived as an estimate from this scan\'s own real average GoldRush call latency, never a hardcoded constant', () => {
    assert.match(src, /const goldrushLatencyStats = getGoldrushLiveCallLatencyStats\(\)/, 'must read the real, measured latency stats')
    assert.match(src, /estimatedTimeSavedMs: goldrushLatencyStats\.avgMs !== null\s*\n\s*\? Math\.round\(duplicateRequestsEliminated \* goldrushLatencyStats\.avgMs\)\s*\n\s*: null,/, 'must derive the estimate from real duplicatesEliminated x real avg latency, and honestly null when no live call was ever timed this scan')
  })

  it('is actually attached to the function\'s returned WalletPriceLookups, not just logged', () => {
    assert.match(src, /historicalPricingPerformanceSummary,\s*\n\s*\}\s*\n\}/, 'historicalPricingPerformanceSummary must be the last field of the returned object')
  })
})

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

describe('dust-lot skip (perf-sprint: "Skip historical pricing for immaterial dust lots that cannot change realized PnL")', () => {
  it('filters buys/sells by a tiny, universal quantity floor BEFORE toPriceableEntry — never a price-dependent/value-based check', () => {
    assert.match(src, /const DUST_LOT_AMOUNT_FLOOR = 1e-9/, 'the dust floor constant must exist and be a tiny, universal quantity (not a USD-value threshold — no price exists yet at this stage)')
    assert.match(src, /buys\.filter\(isNotDustLot\)\.map\(\(e\) => toPriceableEntry/, 'buys must be filtered by the dust check before becoming pricing requirements')
    assert.match(src, /sells\.filter\(isNotDustLot\)\.map\(\(e\) => toPriceableEntry/, 'sells must be filtered by the dust check before becoming pricing requirements')
  })

  it('nativeQuoteEntries are never passed through the dust filter — they price a DIFFERENT requirement, not their own quantity', () => {
    assert.match(src, /sellRequirementEntries = \[\.\.\.sells\.filter\(isNotDustLot\)\.map\(\(e\) => toPriceableEntry\(e, rankForEvent\(e\)\)\), \.\.\.nativeQuoteEntries\]/, 'nativeQuoteEntries must be spread in AFTER filtering, untouched by isNotDustLot')
  })

  it('dustLotsSkippedForPricing is a real counter, incremented exactly where a lot is filtered, and surfaced in the performance summary', () => {
    assert.match(src, /dustLotsSkippedForPricing \+= 1/, 'the counter must be incremented at the real filter point')
    assert.match(src, /dustLotsSkippedForPricing,\n\s*estimatedTimeSavedMs/, 'the real counter must be attached to the returned summary, not just tracked locally')
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

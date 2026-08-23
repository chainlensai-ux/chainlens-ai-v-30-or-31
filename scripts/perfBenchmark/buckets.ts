// MODULE — perfBenchmark/buckets: maps this pipeline's REAL, already-measured per-stage timings
// (src/pipeline/index.ts's own ScanPerformanceSummary.stages, plus priceLotsForWallet.ts's own
// HistoricalPricingPerformanceSummary) onto the four buckets a human-readable performance report
// wants to see: Provider fetch, Pricing, Merge, Recovery. PURE — no I/O, no network, just real
// numbers already computed elsewhere, regrouped.
//
// MAPPING, DISCLOSED (this is an interpretation of user-facing bucket names onto this pipeline's
// own internal stage vocabulary — never assume it maps 1:1, spelled out here so it can be audited
// and corrected if this pipeline's own stage names ever change):
//   Provider fetch -> 'providerFetchWindow' (the per-chain raw transaction/event history pull —
//                     this pipeline's own comment calls it "the single most expensive real network
//                     call in the whole pipeline").
//   Recovery       -> 'recoveryPolicy' (deep-scan-only historical backfill).
//   Pricing        -> 'priceLotsForWallet' + 'pricingAtTime' (the two historical/at-time USD
//                     pricing stages this pipeline's scanTimer marks).
//   Merge          -> 'fifoEngine' (buy/sell event merge + FIFO lot matching — the closest real
//                     analog to "merge" in this pipeline's own vocabulary; there is no stage
//                     literally named "merge").
//   Other          -> every remaining marked stage (e.g. 'dustSuppression', 'receiptDecoding' when
//                     it ran synchronously) — bucketed separately, NEVER silently dropped, so a
//                     report's bucket totals always reconcile exactly to the real total.
//
// A stage this scan never reached (e.g. recoveryPolicy on a 'normal' scan) is simply absent from
// the input `stages` array — its bucket total is honestly 0, never fabricated.

export type ScanStageTiming = { name: string; ms: number }

export type BenchmarkBuckets = {
  providerFetch: number
  pricing: number
  merge: number
  recovery: number
  other: number
  totalMs: number
}

const BUCKET_STAGE_NAMES = {
  providerFetch: ['providerFetchWindow'],
  pricing: ['priceLotsForWallet', 'pricingAtTime'],
  merge: ['fifoEngine'],
  recovery: ['recoveryPolicy'],
} as const

export function bucketizeStages(stages: readonly ScanStageTiming[]): BenchmarkBuckets {
  const buckets: BenchmarkBuckets = { providerFetch: 0, pricing: 0, merge: 0, recovery: 0, other: 0, totalMs: 0 }
  for (const stage of stages) {
    buckets.totalMs += stage.ms
    if ((BUCKET_STAGE_NAMES.providerFetch as readonly string[]).includes(stage.name)) buckets.providerFetch += stage.ms
    else if ((BUCKET_STAGE_NAMES.pricing as readonly string[]).includes(stage.name)) buckets.pricing += stage.ms
    else if ((BUCKET_STAGE_NAMES.merge as readonly string[]).includes(stage.name)) buckets.merge += stage.ms
    else if ((BUCKET_STAGE_NAMES.recovery as readonly string[]).includes(stage.name)) buckets.recovery += stage.ms
    else buckets.other += stage.ms
  }
  return buckets
}

// Sums per-bucket ms across multiple wallets' own bucketized results (e.g. a representative wallet
// set run one at a time) — real addition, no averaging/weighting that could obscure which wallet
// contributed what.
export function sumBuckets(perWallet: readonly BenchmarkBuckets[]): BenchmarkBuckets {
  const total: BenchmarkBuckets = { providerFetch: 0, pricing: 0, merge: 0, recovery: 0, other: 0, totalMs: 0 }
  for (const b of perWallet) {
    total.providerFetch += b.providerFetch
    total.pricing += b.pricing
    total.merge += b.merge
    total.recovery += b.recovery
    total.other += b.other
    total.totalMs += b.totalMs
  }
  return total
}

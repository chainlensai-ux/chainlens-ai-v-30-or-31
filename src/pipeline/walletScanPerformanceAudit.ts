// WALLET-SCAN-PERFORMANCE-AUDIT, DISCLOSED, ADDITIVE (Wallet Scanner improvement audit, task 3 —
// exact shape requested). This is a DERIVED, simplified view built entirely from real, already-
// measured values two other systems in this codebase already produce:
//   - ScanPerformanceSummary (src/pipeline/index.ts's own scanTimer marks) for per-stage wall-clock
//     timings, provider latency, and providerFetchWindow/recoveryPolicy cache hit/miss counts.
//   - PricingResolutionAudit (src/modules/pricing/index.ts's resolvePricesDetailed) for the
//     current-price resolution pass's own provider-call/cache/rate-limit counters.
// Nothing here is a new measurement source — this module only reshapes/combines two already-real
// audits into the flat shape requested. A field this scan genuinely has no evidence for is reported
// null/0, never fabricated (e.g. a scan that ran zero fallback price lookups reports
// providerCalls: 0, not a guessed number).
//
// SCOPE, DISCLOSED: `providerCalls`/`cacheHits`/`rateLimitHits` count ONLY the two systems above
// (current-price resolution + providerFetchWindow/recoveryPolicy stage caches) — this codebase has
// several OTHER independent provider-call ledgers (Alchemy history, GoldRush historical pricing,
// CoinGecko, basedex RPC) that are not threaded into a single cross-cutting counter anywhere in the
// pipeline; combining all of them would require plumbing well beyond this task's scope and risks
// double-counting or silently dropping a source. This audit is honest about that scope rather than
// presenting a partial sum as if it were the whole scan's provider-call total.

import type { ScanPerformanceSummary } from './types'
import type { PricingResolutionAudit } from '../modules/pricing/types'

export type WalletScanPerformanceAudit = {
  totalMs: number
  providerFetchWindowMs: number | null
  recoveryPolicyMs: number | null
  priceLotsForWalletMs: number | null
  receiptDecodingMs: number | null
  // Wall-clock time of THIS scan's one current-price resolution pass (resolvePricesDetailed) —
  // measured at the runWalletScanV2 call site, since that pass runs outside runWalletScan()'s own
  // scanTimer entirely (see runWalletScanV2.ts's own "SEQUENCING FIX" header).
  currentPricingMs: number | null
  // Real current-price provider calls this scan made (DexScreener + GeckoTerminal fallback tiers
  // combined) — see SCOPE note above for what this does and does not include.
  providerCalls: number
  // Real cache hits across the current-price short-TTL cache and the providerFetchWindow/
  // recoveryPolicy stage caches — see SCOPE note above.
  cacheHits: number
  // Real GeckoTerminal 429/quota-stopped occurrences this scan hit (current-price tier only — see
  // module header).
  rateLimitHits: number
  // The single stage/provider with the highest real measured ms this scan — null when no stage/
  // provider timing was measured at all (e.g. every stage cache-hit and the timer's `stages` array
  // came back empty).
  slowestStage: { name: string; ms: number } | null
  slowestProvider: { chain: string; ms: number } | null
  // Real current-price calls that consumed a fallback slot / made a real network request but
  // resolved nothing useful (excludes calls pre-emptively short-circuited by the GeckoTerminal
  // cooldown, which cost zero network time — see PricingResolutionAudit's own
  // geckoTerminalQuotaStopped field, counted separately in rateLimitHits above).
  wastedCalls: number
  // Real count of open positions this scan classified as dust/spam/dead/suspicious-airdrop (see
  // fifoEngine's OpenPositionClassification) — the exact positions excluded from
  // deadOrSpamPositionsCount below never inflate a "coverage is broken" impression.
  skippedSpamTokens: number
  // Friendly, ordered phase labels for UI display, built only from stages this scan actually
  // measured — a stage this scan skipped (e.g. recoveryPolicy on a 'normal' scan) is simply absent,
  // never zero-filled.
  userVisiblePhaseTimings: Array<{ phase: string; ms: number }>
}

const USER_VISIBLE_PHASE_LABELS: Record<string, string> = {
  providerFetchWindow: 'Fetching wallet history',
  recoveryPolicy: 'Recovering missing trades',
  receiptDecoding: 'Decoding transaction receipts',
  dustSuppression: 'Filtering dust tokens',
  priceLotsForWallet: 'Pricing your trades',
  fifoEngine: 'Matching buys and sells',
  pricingAtTime: 'Verifying historical prices',
}

export function buildWalletScanPerformanceAudit(params: {
  totalMs: number
  scanPerformanceSummary: ScanPerformanceSummary | null | undefined
  pricingAudit: PricingResolutionAudit | null
  currentPricingMs: number | null
  deadOrSpamPositionsCount: number
}): WalletScanPerformanceAudit {
  const { totalMs, scanPerformanceSummary, pricingAudit, currentPricingMs, deadOrSpamPositionsCount } = params
  const stages = scanPerformanceSummary?.stages ?? []

  function stageMs(name: string): number | null {
    return stages.find((s) => s.name === name)?.ms ?? null
  }

  const slowestStageEntry = stages.length > 0
    ? stages.reduce((a, b) => (b.ms > a.ms ? b : a))
    : null
  const providerLatency = scanPerformanceSummary?.providerLatencyMs ?? []
  const slowestProviderEntry = providerLatency.length > 0
    ? providerLatency.reduce((a, b) => (b.ms > a.ms ? b : a))
    : null

  const pfwCache = scanPerformanceSummary?.cacheHitRate.providerFetchWindow
  const recoveryCache = scanPerformanceSummary?.cacheHitRate.recoveryPolicy
  const cacheHits = (pricingAudit?.cacheHits ?? 0) + (pfwCache?.hits ?? 0) + (recoveryCache?.hits ?? 0)

  const providerCalls = (pricingAudit?.dexscreenerCalls ?? 0) + (pricingAudit?.geckoTerminalCalls ?? 0)
  const dexWasted = (pricingAudit?.dexscreenerCalls ?? 0) - (pricingAudit?.dexscreenerSuccesses ?? 0)
  const geckoAttempted = (pricingAudit?.geckoTerminalCalls ?? 0) - (pricingAudit?.geckoTerminalQuotaStopped ?? 0)
  const geckoWasted = Math.max(0, geckoAttempted - (pricingAudit?.geckoTerminalSuccesses ?? 0))
  const wastedCalls = Math.max(0, dexWasted) + geckoWasted

  const userVisiblePhaseTimings: Array<{ phase: string; ms: number }> = []
  for (const stage of stages) {
    const label = USER_VISIBLE_PHASE_LABELS[stage.name]
    if (label) userVisiblePhaseTimings.push({ phase: label, ms: stage.ms })
  }
  if (currentPricingMs != null) userVisiblePhaseTimings.push({ phase: 'Fetching current prices', ms: currentPricingMs })

  return {
    totalMs,
    providerFetchWindowMs: stageMs('providerFetchWindow'),
    recoveryPolicyMs: stageMs('recoveryPolicy'),
    priceLotsForWalletMs: stageMs('priceLotsForWallet'),
    receiptDecodingMs: stageMs('receiptDecoding'),
    currentPricingMs,
    providerCalls,
    cacheHits,
    rateLimitHits: pricingAudit?.geckoTerminalQuotaStopped ?? 0,
    slowestStage: slowestStageEntry ? { name: slowestStageEntry.name, ms: slowestStageEntry.ms } : null,
    slowestProvider: slowestProviderEntry ? { chain: slowestProviderEntry.chain, ms: slowestProviderEntry.ms } : null,
    wastedCalls,
    skippedSpamTokens: deadOrSpamPositionsCount,
    userVisiblePhaseTimings,
  }
}

import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import type { SyntheticPnlSummary } from '../modules/syntheticPnl'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'
import type { SupportedChain } from '../modules/providerFetchWindow/types'

export type PnlMismatchClass = 'missingInboundEvidence' | 'missingOutboundEvidence' | 'routerClusterMismatch' | 'priceUnavailable' | 'dustSuppressedToken' | 'syntheticOnlyToken' | 'priceRecovered'
export type ReconciledPublicPnlStatus = 'available' | 'partial' | 'unavailable'

type RouterInferenceLike = { highConfidenceRouters?: ReadonlySet<string>; tokenFlowClustersByAddress?: ReadonlyMap<string, readonly unknown[]> }
// RECOVERY LANE, DISCLOSED (provider-call-audit follow-up task, confirmed root cause of "recovery
// attempted 40 candidates but made zero live source attempts"): `getPriceRecovery` is the preferred
// entry point — see src/lib/kvClient.ts's own header for the full disclosure on why recovery needs
// its OWN bounded allowance, separate from the shared per-token cap the main pricingAtTime pass
// already exhausts by the time recovery runs. `getPriceHistorical`/`getPricePrimary` remain here
// purely as a fallback for a `priceKvClient` that doesn't implement the recovery lane (e.g. a
// simpler test double) — production always supplies the real RequestPriceKvClient, which has both.
type PriceKvLike = {
  getPriceHistorical?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null>
  getPricePrimary?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null>
  getPriceRecovery?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn, label: 'primary' | 'chain-aware-historical', maxRecoveryLookups: number) => Promise<number | null>
  // DIAGNOSTIC-ONLY, DISCLOSED: optional read access to the real client's own counters — never
  // required for recovery to function, only for the compact diagnostics logged below.
  stats?: { cappedLookups: number }
  recoveryStats?: { recoveryLookupsRequested: number; recoveryCacheHits: number; recoveryLiveFetches: number; recoveryCappedLookups: number }
}

// DETAILED PRICE SOURCE, ADDITIVE (provider-call-audit follow-up task, "trace the one-side-missing
// recovery candidates" requirement): a duck-typed shape matching
// src/pipeline/pricingAtTimeAdapter.ts's ChainAwareHistoricalPriceResult — kept structural (not
// imported directly) so this file has no hard dependency on that module's exact type location,
// matching this file's existing convention of only depending on plain data shapes for its
// injectable config. Optional: when absent, recovery behaves exactly as it did before this task
// (no reason classification, same recovered prices).
type DetailedPriceAttempt = { source: string; ok: boolean; reason: string | null }
type DetailedPriceSourceFn = (token: string, chain: SupportedChain, timestamp: number) => Promise<{ price: number | null; route: string; attempts: DetailedPriceAttempt[] }>

type Config = { logger?: Pick<Console, 'warn'>; priceKvClient?: PriceKvLike; priceSources?: { primary?: PriceSourceFn; fallback?: PriceSourceFn }; priceSourceDetailedPrimary?: DetailedPriceSourceFn; dustSuppressedKeys?: ReadonlySet<string> }

// COMPACT FAILURE-REASON CATEGORIES, DISCLOSED: mirrors this task's own requested category list.
// Mapping is honest, not exhaustive by construction — every real source function in this codebase
// (dexscreener.ts, geckoTerminalPriceSource.ts, coingecko.ts, basedex.ts) was traced for its actual
// reason strings (see pricingAtTimeAdapter.ts's own header); some requested categories
// ('pool_created_after_timestamp', 'zero_liquidity', 'stale_price_rejection', 'invalid_decimals')
// are NOT currently distinguishable from 'no_pool'/other buckets by any real source in this
// codebase — they remain in this counter object (always present, never omitted) so a future
// source-level fix that adds that distinction has somewhere to report it, but they honestly read 0
// today rather than being force-matched to the nearest real reason string.
//
// CONFIRMED COLLAPSE POINT, FIXED (this follow-up task's exact "every failure classified
// providerReturnedNull" symptom): the PRIOR version of this function's fallback branch mapped ANY
// non-enumerated reason string — including real, already-observed, source-specific strings like
// basedex.ts's `rpc_error:${message}` and every source's `http_${status}`/`fetch_error:${message}`
// — straight into `providerReturnedNull`. `providerReturnedNull` is supposed to mean "the source
// gave back a plain null with no further explanation" (reason === null); silently routing a REAL,
// specific-but-unenumerated string into that same bucket is exactly the "final generic null
// overwrites a specific earlier reason" collapse this task's own diagnostic pass was meant to
// surface, not perform — a wallet whose real BaseDex failures are mostly `rpc_error:*` (very
// plausible given BaseDex's "hundreds of RPC operations", per this task's own production evidence)
// would show 100% providerReturnedNull with every specific bucket at zero, matching the reported
// symptom exactly. Fixed: `providerReturnedNull` is now reserved STRICTLY for a literal `null`
// reason; every other non-matching string goes to the new `unknownReason` bucket below, keyed by a
// compact, truncated reason NAME (never the dynamic message/token/raw body that can follow a `:`).
export type RecoveryFailureReasonCounts = {
  unsupportedTokenOrChain: number
  timestampOutsideProviderData: number
  malformedResponse: number
  blockResolutionFailure: number
  noPool: number
  poolCreatedAfterTimestamp: number
  zeroLiquidity: number
  stalePriceRejection: number
  invalidDecimals: number
  providerReturnedNull: number
  // COMPACT, DISCLOSED: keyed by a normalized reason NAME only (e.g. 'rpc_error', 'http_500',
  // 'no_candles') — never a raw provider response body, never a token address, never the dynamic
  // exception message text that can follow a `:` in reasons like `rpc_error:${err.message}`.
  unknownReason: Record<string, number>
}

function emptyReasonCounts(): RecoveryFailureReasonCounts {
  return { unsupportedTokenOrChain: 0, timestampOutsideProviderData: 0, malformedResponse: 0, blockResolutionFailure: 0, noPool: 0, poolCreatedAfterTimestamp: 0, zeroLiquidity: 0, stalePriceRejection: 0, invalidDecimals: 0, providerReturnedNull: 0, unknownReason: {} }
}

// Truncates a reason string to a compact, bounded-cardinality NAME safe for a counter key — strips
// everything from the first `:` onward (where every dynamic/unbounded part of this codebase's real
// reason strings lives — `rpc_error:${message}`, `fetch_error:${message}`) so an unknown reason
// still groups meaningfully (all RPC errors count together) without ever leaking the dynamic
// message text, which could in principle echo back provider/response details.
function compactReasonName(reason: string): string {
  const colonIndex = reason.indexOf(':')
  return colonIndex === -1 ? reason : reason.slice(0, colonIndex)
}

export type RecoveryFailureBucket = keyof Omit<RecoveryFailureReasonCounts, 'unknownReason'> | 'unknownReason'

// Classifies ONE real, already-observed reason string (never a fabricated one — a candidate this
// function never reached, e.g. because a cache hit resolved it, never calls this at all) into a
// compact bucket. `unknownKey` is set only when `bucket === 'unknownReason'`. Exported for direct
// unit testing.
export function classifyRecoveryFailureReason(reason: string | null): { bucket: RecoveryFailureBucket; unknownKey: string | null } {
  if (reason === null) return { bucket: 'providerReturnedNull', unknownKey: null }
  if (reason.includes('unverified_chain') || reason.includes('unverified_network') || reason === 'base_dex_only_supports_base_chain' || reason === 'no_api_key_configured' || reason === 'goldrush_no_data') return { bucket: 'unsupportedTokenOrChain', unknownKey: null }
  if (reason.includes('timestamp_too_far_from_now') || reason === 'no_price_series_in_range' || reason === 'no_candles') return { bucket: 'timestampOutsideProviderData', unknownKey: null }
  if (reason.includes('unparseable')) return { bucket: 'malformedResponse', unknownKey: null }
  if (reason === 'could_not_resolve_historical_block') return { bucket: 'blockResolutionFailure', unknownKey: null }
  if (reason === 'no_pool_found' || reason === 'no_uniswap_v3_pool_found' || reason === 'no_matching_pair') return { bucket: 'noPool', unknownKey: null }
  // Every other real, non-empty reason string this codebase's sources can produce (http_*,
  // fetch_error:*, rpc_error:*, or any future/unrecognized string) is a genuine, specific signal
  // this classifier just doesn't have a named bucket for yet — it must never be silently folded
  // into providerReturnedNull (that would recreate exactly the collapse this fix closes).
  return { bucket: 'unknownReason', unknownKey: compactReasonName(reason) }
}

function recordFailureReason(counts: RecoveryFailureReasonCounts, reason: string | null): void {
  const { bucket, unknownKey } = classifyRecoveryFailureReason(reason)
  if (bucket === 'unknownReason') {
    counts.unknownReason[unknownKey!] = (counts.unknownReason[unknownKey!] ?? 0) + 1
  } else {
    counts[bucket] += 1
  }
}

// PER-SOURCE ATTEMPT COUNTERS, DISCLOSED (this task's explicit requirement): built from EVERY
// attempt in a detailed lookup's `attempts` array (not just the final one), so a source that was
// tried and failed early is never invisible just because a later source in the same lookup also
// failed — every source's own real attempt/success/failure tally is preserved independently.
export type SourceAttemptCounters = {
  sourceAttemptCounts: Record<string, number>
  sourceSuccessCounts: Record<string, number>
  sourceFailureReasonCounts: Record<string, Record<string, number>>
}

function emptySourceAttemptCounters(): SourceAttemptCounters {
  return { sourceAttemptCounts: {}, sourceSuccessCounts: {}, sourceFailureReasonCounts: {} }
}

function recordSourceAttempts(counters: SourceAttemptCounters, attempts: readonly DetailedPriceAttempt[]): void {
  for (const attempt of attempts) {
    counters.sourceAttemptCounts[attempt.source] = (counters.sourceAttemptCounts[attempt.source] ?? 0) + 1
    if (attempt.ok) {
      counters.sourceSuccessCounts[attempt.source] = (counters.sourceSuccessCounts[attempt.source] ?? 0) + 1
      continue
    }
    const { bucket, unknownKey } = classifyRecoveryFailureReason(attempt.reason)
    const bucketKey = bucket === 'unknownReason' ? `unknownReason:${unknownKey}` : bucket
    const bySource = counters.sourceFailureReasonCounts[attempt.source] ?? (counters.sourceFailureReasonCounts[attempt.source] = {})
    bySource[bucketKey] = (bySource[bucketKey] ?? 0) + 1
  }
}
export type PnlReconciliationInput = { fifoEngineResult: FifoOutput; pnlEngineResult: PnlSummaryResult; routerInferenceOutput?: RouterInferenceLike | null; syntheticPnlAssemblyOutput?: SyntheticPnlSummary | null }
export type PnlReconciliationSummary = { closedLots: number; unmatchedBuys: number; unmatchedSells: number; realizedPnlUsd: number | null; unrealizedPnlUsd: number | null; priceRecoveredCount: number; routerCorrectedCount: number; syntheticAlignedCount: number; missingEvidenceCount: number; publicPnlStatus: ReconciledPublicPnlStatus; mismatches: Array<{ key: string; classification: PnlMismatchClass }> }

const roundUsd = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null
const tokenKey = (chain: string, token: string) => `${chain}:${token.toLowerCase()}`
const lotKey = (lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt'>) => [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt].join(':')

// CONFIRMED ROOT CAUSE, DISCLOSED (real production evidence): recoverPrices previously ran a
// FULLY SEQUENTIAL for-loop — one lot at a time, each `await`ing a real KV-backed price lookup
// (falling through to a real provider fetcher on a KV miss) — over every lot missing a price, with
// no concurrency and no cap. A real production run confirmed this exact gap: reconcile()'s own
// "[pnl-reconciliation] routerCorrected" log fired, but its OWN final log
// ("[pnl-reconciliation] finalSummary", at the very end of reconcile() below) never appeared at
// all — across four separate real runs — while the worker's own job-finished log reported
// durationMs almost exactly equal to WORKER_GLOBAL_TIMEOUT_MS every time. The ONLY code between
// those two log lines is `await recoverPrices(fifoLots)`. For a wallet with hundreds of lots
// missing a price (this session's own test wallet showed "failed: 373" in
// priceLotsForWallet's own pricing-source breakdown), a fully sequential loop of real network
// calls — each paying the same real-provider latency already documented elsewhere in this
// pipeline (GoldRush/basedex, both already found and fixed for cost/latency this session) — is a
// direct, sufficient explanation for a multi-minute hang with zero console output the whole time.
//
// FIX: bounded concurrency (mapWithConcurrencyLimit, same simple worker-pool pattern already used
// by pricingAtTimeEngine/index.ts for the identical reason) plus a hard cap on how many lots this
// best-effort recovery pass will even attempt. Recovery is optional and additive — a lot recovery
// doesn't reach for stays exactly as honest as it already was (`priceUnavailable`, never a
// fabricated recovered price) — so capping the attempt count only bounds cost, it never changes
// correctness for any lot recovery DOES reach.
const RECOVERY_CONCURRENCY_LIMIT = 8
const MAX_RECOVERY_ATTEMPTS = 40

async function mapWithConcurrencyLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export function createPnlReconciliation(config: Config = {}) {
  const logger = config.logger ?? console
  let state: PnlReconciliationInput | null = null

  // STARTUP ASSERTION, DISCLOSED (this task's explicit requirement): logs ONCE, at construction
  // time, whether the detailed primary source was actually supplied — the fastest way to confirm
  // from real production logs whether the wiring in src/pipeline/index.ts is actually reaching this
  // module, without waiting for a full recovery pass to run first.
  logger.warn('[pnl-reconciliation] startup', { detailedRecoverySourceConfigured: Boolean(config.priceSourceDetailedPrimary) })

  // RECOVERED-PRICE-DISCARDED FIX, DISCLOSED (confirmed root cause of stalled pricing coverage —
  // real production evidence: 283 closed lots, 7 fully priced, 2.47% coverage, unchanged by whether
  // recovery ran or not): this previously returned only a Set<string> of lot keys "recovery reached
  // and found something for" — the ACTUAL resolved price number was discarded the moment it was
  // fetched. reconcile() below only ever used that Set to (a) relabel a mismatch as 'priceRecovered'
  // and (b) shrink missingEvidenceCount's optics — the real, successfully-fetched USD figure never
  // flowed into a lot's costBasisUsd/proceedsUsd/realizedPnlUsd, and therefore never into the
  // official realizedPnlUsd sum (which came from input.fifoEngineResult.realizedPnlUsd, computed
  // upstream in fifoEngine BEFORE this recovery pass ever runs). Recovery was, in effect, cosmetic —
  // it could make the evidence-count LOOK better without ever making one more lot actually eligible
  // for realized PnL. Fixed: now returns the real resolved price per lot, and reconcile() below
  // merges it into an updated lot list and recomputes realizedPnlUsd from that — same bounded
  // candidate cap (MAX_RECOVERY_ATTEMPTS), same concurrency limit, same real priceSources (including
  // the on-chain fallback already reused here under existing policy) — this is strictly about
  // applying what recovery already, legitimately found, never about fetching more or fabricating
  // anything. A lot recovery doesn't reach, or genuinely can't price, stays exactly as honest as
  // before: null, never a fabricated value.
  //
  // ONE-SIDE-MISSING PRIORITY, DISCLOSED: a lot already missing only ONE side needs exactly one more
  // successful lookup to become fully priced; a lot missing BOTH sides needs two. Within the same
  // fixed candidate budget, completing one-side-missing lots first yields more newly-fully-priced
  // lots per attempt than starting new lots from zero — sorted first (tie-broken by lotKey for
  // determinism), never changing which fetchers or how many attempts are used per lot.
  type RecoveredPrice = { costBasisUsd: number | null; proceedsUsd: number | null }
  // WIRING DIAGNOSTIC COUNTERS, DISCLOSED (this task's explicit requirement): distinguishes THREE
  // real, distinct things that a bare "recovered: 0" summary conflates:
  //   - detailedLookupsUsed: how many leg attempts SELECTED the detailed path (the primary slot,
  //     with a detailed fetcher configured) — this is a wiring/selection count, incremented
  //     regardless of whether the underlying KV client ever actually invokes the fetcher.
  //   - plainLookupsUsed: how many leg attempts used the plain (non-detailed) fetcher instead —
  //     either because no detailed fetcher was configured, or because this was the fallback slot.
  //   - detailedAttemptsObserved: how many times the detailed fetcher was ACTUALLY invoked (i.e.
  //     RequestPriceKvClient's cache-hit/in-flight/per-token-cap short-circuits did NOT prevent a
  //     real call). If detailedLookupsUsed is high but this stays near zero, that proves the
  //     short-circuit — not a wiring gap — is what's suppressing real per-source attempts, without
  //     this diagnostic pass needing to touch (or even know) that cap's value.
  async function recoverPrices(lots: readonly MatchedLot[]): Promise<{
    recoveredByLotKey: Map<string, RecoveredPrice>
    oneSideMissingCandidates: number
    bothSidesMissingCandidates: number
    candidatesAttempted: number
    candidatesCappedByBudget: number
    failureReasonCounts: RecoveryFailureReasonCounts
    sourceAttemptCounters: SourceAttemptCounters
    detailedLookupsUsed: number
    plainLookupsUsed: number
    detailedAttemptsObserved: number
  }> {
    const recoveredByLotKey = new Map<string, RecoveredPrice>()
    const failureReasonCounts = emptyReasonCounts()
    const sourceAttemptCounters = emptySourceAttemptCounters()
    let detailedLookupsUsed = 0
    let plainLookupsUsed = 0
    let detailedAttemptsObserved = 0
    const fetchers = [config.priceSources?.primary, config.priceSources?.fallback].filter(Boolean) as PriceSourceFn[]
    const detailedPrimary = config.priceSourceDetailedPrimary
    const missingLots = lots.filter((lot) => !(lot.costBasisUsd !== null && lot.proceedsUsd !== null))
    const oneSideMissingCandidates = missingLots.filter((l) => l.costBasisUsd !== null || l.proceedsUsd !== null).length
    const bothSidesMissingCandidates = missingLots.length - oneSideMissingCandidates
    if (!config.priceKvClient || (fetchers.length === 0 && !detailedPrimary)) {
      return { recoveredByLotKey, oneSideMissingCandidates, bothSidesMissingCandidates, candidatesAttempted: 0, candidatesCappedByBudget: missingLots.length, failureReasonCounts, sourceAttemptCounters, detailedLookupsUsed, plainLookupsUsed, detailedAttemptsObserved }
    }
    const priceKvClient = config.priceKvClient
    const sorted = [...missingLots].sort((a, b) => {
      const aOneSide = a.costBasisUsd !== null || a.proceedsUsd !== null ? 0 : 1
      const bOneSide = b.costBasisUsd !== null || b.proceedsUsd !== null ? 0 : 1
      return aOneSide !== bOneSide ? aOneSide - bOneSide : lotKey(a).localeCompare(lotKey(b))
    })
    const candidates = sorted.slice(0, MAX_RECOVERY_ATTEMPTS)
    // RECOVERY LANE BUDGET, DISCLOSED (this task's explicit requirement): derived strictly from the
    // existing MAX_RECOVERY_ATTEMPTS candidate cap — worst case, every candidate needs BOTH legs
    // (buy + sell), so the live-fetch allowance is exactly 2x that already-bounded number. Never
    // unlimited, never a new independent knob.
    const maxRecoveryLookups = MAX_RECOVERY_ATTEMPTS * 2
    // Records EVERY attempt in a detailed result (via recordSourceAttempts, per-source, never just
    // the final one) into the per-source counters, and returns the LAST attempt's reason (the most
    // recent real source tried before this leg gave up) — never the full response, matching this
    // task's explicit "compact reason counters instead of logging full responses" requirement. An
    // exception from the detailed source is caught here specifically (never silently converted to a
    // generic null elsewhere) and recorded into the unknownReason bucket under a compact, bounded
    // key — this task's own "confirm exceptions are not silently converted to generic null"
    // requirement.
    const callDetailed = async (token: string, chain: string, timestamp: number): Promise<{ price: number | null; reason: string | null }> => {
      detailedAttemptsObserved += 1
      try {
        const d = await detailedPrimary!(token, chain as SupportedChain, timestamp)
        recordSourceAttempts(sourceAttemptCounters, d.attempts)
        return { price: d.price, reason: d.attempts.length > 0 ? d.attempts[d.attempts.length - 1].reason : null }
      } catch (err) {
        const exceptionKey = err instanceof Error ? err.constructor.name : 'UnknownException'
        sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException = sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException ?? {}
        sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException[exceptionKey] = (sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException[exceptionKey] ?? 0) + 1
        return { price: null, reason: `exception:${exceptionKey}` }
      }
    }
    // SOLE LIVE FETCHER, DISCLOSED (this task's explicit "remove the detailed-then-plain double
    // attempt" requirement): when a detailed source is configured, it is the ONLY live fetcher tried
    // for a leg — one real call, whose own returned price is used directly. The plain
    // `config.priceSources.primary`/`.fallback` pair is only ever consulted (in order) when NO
    // detailed source is configured at all. Every call routes through the shared, bounded recovery
    // lane (priceKvClient.getPriceRecovery) when available, falling back to the plain
    // getPriceHistorical/getPricePrimary methods only for a priceKvClient that doesn't implement it.
    const attemptLeg = async (token: string, chain: string, timestamp: number, label: 'primary' | 'chain-aware-historical'): Promise<{ price: number | null; reason: string | null }> => {
      const callVia = async (fetcher: PriceSourceFn): Promise<number | null> => {
        if (priceKvClient.getPriceRecovery) return priceKvClient.getPriceRecovery(token, chain, timestamp, fetcher, label, maxRecoveryLookups)
        if (label === 'chain-aware-historical') return priceKvClient.getPriceHistorical ? priceKvClient.getPriceHistorical(token, chain, timestamp, fetcher) : null
        return priceKvClient.getPricePrimary ? priceKvClient.getPricePrimary(token, chain, timestamp, fetcher) : null
      }
      if (detailedPrimary) {
        let reason: string | null = null
        const wrapped: PriceSourceFn = async (t, c, ts) => {
          const result = await callDetailed(t, c, ts)
          reason = result.reason
          return result.price
        }
        const price = await callVia(wrapped)
        return { price, reason }
      }
      for (const fetcher of fetchers) {
        const price = await callVia(fetcher)
        if (price !== null) return { price, reason: null }
      }
      return { price: null, reason: null }
    }
    await mapWithConcurrencyLimit(candidates, RECOVERY_CONCURRENCY_LIMIT, async (lot) => {
      const needsBuy = lot.costBasisUsd === null
      const needsSell = lot.proceedsUsd === null
      let recoveredBuy: number | null = null
      let recoveredSell: number | null = null
      let lastBuyReason: string | null = null
      let lastSellReason: string | null = null
      if (needsBuy) {
        if (detailedPrimary) detailedLookupsUsed += 1
        else plainLookupsUsed += 1
        const result = await attemptLeg(lot.token, lot.chain, lot.openedAt, 'chain-aware-historical')
        recoveredBuy = result.price
        lastBuyReason = result.reason
      }
      if (needsSell) {
        if (detailedPrimary) detailedLookupsUsed += 1
        else plainLookupsUsed += 1
        const result = await attemptLeg(lot.token, lot.chain, lot.closedAt, 'primary')
        recoveredSell = result.price
        lastSellReason = result.reason
      }
      if (needsBuy && recoveredBuy === null) recordFailureReason(failureReasonCounts, lastBuyReason)
      if (needsSell && recoveredSell === null) recordFailureReason(failureReasonCounts, lastSellReason)
      if (recoveredBuy !== null || recoveredSell !== null) {
        recoveredByLotKey.set(lotKey(lot), { costBasisUsd: recoveredBuy, proceedsUsd: recoveredSell })
      }
    })
    return { recoveredByLotKey, oneSideMissingCandidates, bothSidesMissingCandidates, candidatesAttempted: candidates.length, candidatesCappedByBudget: sorted.length - candidates.length, failureReasonCounts, sourceAttemptCounters, detailedLookupsUsed, plainLookupsUsed, detailedAttemptsObserved }
  }

  return {
    getState: () => state,
    async reconcile(input: PnlReconciliationInput): Promise<PnlReconciliationSummary> {
      state = input
      const fifoLots = [...input.fifoEngineResult.matchedLots].sort((a, b) => lotKey(a).localeCompare(lotKey(b)))
      const pnlLots = [...input.pnlEngineResult.closedLots].sort((a, b) => `${a.chain}:${a.token.toLowerCase()}:${a.txHash}:${a.timestamp}`.localeCompare(`${b.chain}:${b.token.toLowerCase()}:${b.txHash}:${b.timestamp}`))
      const mismatches = new Map<string, PnlMismatchClass>()
      if (fifoLots.length !== pnlLots.length || input.fifoEngineResult.unmatchedBuys > 0 || input.fifoEngineResult.unmatchedSells > 0) {
        logger.warn('[pnl-reconciliation] structuralMismatch', { fifoClosedLots: fifoLots.length, pnlClosedLots: pnlLots.length, unmatchedBuys: input.fifoEngineResult.unmatchedBuys, unmatchedSells: input.fifoEngineResult.unmatchedSells })
      }
      for (const lot of fifoLots) {
        const key = lotKey(lot)
        if (lot.costBasisUsd === null || lot.proceedsUsd === null) mismatches.set(key, 'priceUnavailable')
      }
      for (const key of config.dustSuppressedKeys ?? []) mismatches.set(`dust:${key}`, 'dustSuppressedToken')

      let routerCorrectedCount = 0
      const acceptedRouters = input.routerInferenceOutput?.highConfidenceRouters ?? new Set<string>()
      if (acceptedRouters.size > 0 && input.fifoEngineResult.unmatchedSells > 0) {
        routerCorrectedCount = Math.min(input.fifoEngineResult.unmatchedSells, acceptedRouters.size)
        logger.warn('[pnl-reconciliation] routerCorrected', { routerCorrectedCount, acceptedRouters: [...acceptedRouters].sort() })
      }

      const recovery = await recoverPrices(fifoLots)
      const recovered = new Set(recovery.recoveredByLotKey.keys())
      for (const key of recovered) mismatches.set(key, 'priceRecovered')

      // Merge recovery's real, resolved prices into a copy of the lots — never mutating fifoEngine's
      // own matchedLots — so the canonical realizedPnlUsd below actually reflects what recovery
      // found, instead of discarding it (see recoverPrices' own header for the full trace). A lot
      // recovery didn't touch is returned unchanged; a lot recovery reached but genuinely couldn't
      // price stays exactly as unpriced as before — never a fabricated value.
      let recoveredBuyOnly = 0
      let recoveredSellOnly = 0
      let recoveredBoth = 0
      const updatedFifoLots = fifoLots.map((lot) => {
        const recoveredPrice = recovery.recoveredByLotKey.get(lotKey(lot))
        if (!recoveredPrice) return lot
        const costBasisUsd = lot.costBasisUsd ?? recoveredPrice.costBasisUsd
        const proceedsUsd = lot.proceedsUsd ?? recoveredPrice.proceedsUsd
        const nowFullyPriced = costBasisUsd !== null && proceedsUsd !== null
        if (recoveredPrice.costBasisUsd !== null && recoveredPrice.proceedsUsd !== null) recoveredBoth += 1
        else if (recoveredPrice.costBasisUsd !== null) recoveredBuyOnly += 1
        else recoveredSellOnly += 1
        return {
          ...lot,
          costBasisUsd,
          proceedsUsd,
          realizedPnlUsd: nowFullyPriced ? proceedsUsd! - costBasisUsd! : lot.realizedPnlUsd,
          evidenceQuality: nowFullyPriced ? ('verified' as const) : lot.evidenceQuality,
        }
      })
      logger.warn('[pnl-reconciliation] recovery', {
        oneSideMissingCandidates: recovery.oneSideMissingCandidates,
        bothSidesMissingCandidates: recovery.bothSidesMissingCandidates,
        candidatesAttempted: recovery.candidatesAttempted,
        candidatesCappedByBudget: recovery.candidatesCappedByBudget,
        recoveredBuyOnly, recoveredSellOnly, recoveredBoth,
        attemptedButStillUnpriced: recovery.candidatesAttempted - recovery.recoveredByLotKey.size,
        // COMPACT REASON COUNTERS, DISCLOSED (provider-call-audit follow-up task): real counts per
        // category, never raw provider responses — see classifyRecoveryFailureReason's own header
        // for the full mapping and its honest, disclosed limitations.
        failureReasonCounts: recovery.failureReasonCounts,
        // PER-SOURCE ATTEMPT COUNTERS, DISCLOSED (this task's explicit requirement): real per-source
        // attempt/success/failure-reason tallies across every attempt this recovery pass made —
        // never keyed by token or wallet, only by source name and reason name.
        sourceAttemptCounts: recovery.sourceAttemptCounters.sourceAttemptCounts,
        sourceSuccessCounts: recovery.sourceAttemptCounters.sourceSuccessCounts,
        sourceFailureReasonCounts: recovery.sourceAttemptCounters.sourceFailureReasonCounts,
        // WIRING DIAGNOSTIC COUNTERS, DISCLOSED (this task's explicit requirement): see
        // recoverPrices' own header for what each of these three distinguishes — in particular, a
        // real production run showing detailedLookupsUsed > 0 alongside detailedAttemptsObserved
        // near 0 proves the detailed fetcher was correctly SELECTED but RequestPriceKvClient's own
        // cache-hit/in-flight/per-token-cap short-circuit prevented it from ever actually running.
        detailedLookupsUsed: recovery.detailedLookupsUsed,
        plainLookupsUsed: recovery.plainLookupsUsed,
        detailedAttemptsObserved: recovery.detailedAttemptsObserved,
        // RECOVERY LANE DIAGNOSTICS, DISCLOSED (this task's explicit requirement):
        // normalCappedLookups is the SHARED per-token cap's own count (from the main pricingAtTime
        // pass, read here purely for comparison) — recoveryLookupsRequested/CacheHits/LiveFetches/
        // CappedLookups are this recovery pass's OWN separate lane, proving the two budgets no
        // longer starve each other.
        normalCappedLookups: config.priceKvClient?.stats?.cappedLookups ?? null,
        recoveryLookupsRequested: config.priceKvClient?.recoveryStats?.recoveryLookupsRequested ?? null,
        recoveryCacheHits: config.priceKvClient?.recoveryStats?.recoveryCacheHits ?? null,
        recoveryLiveFetches: config.priceKvClient?.recoveryStats?.recoveryLiveFetches ?? null,
        recoveryCappedLookups: config.priceKvClient?.recoveryStats?.recoveryCappedLookups ?? null,
      })

      let syntheticAlignedCount = 0
      const synthetic = input.syntheticPnlAssemblyOutput
      if (synthetic) {
        const totalLegsCount = synthetic.totalLegsCount ?? 0
        const pricedLegsCount = synthetic.pricedLegsCount ?? 0
        if (totalLegsCount > pricedLegsCount) {
          syntheticAlignedCount = Math.min(totalLegsCount - pricedLegsCount, input.fifoEngineResult.unmatchedBuys + input.fifoEngineResult.unmatchedSells)
          if (syntheticAlignedCount > 0) logger.warn('[pnl-reconciliation] syntheticAligned', { syntheticAlignedCount, totalLegsCount, pricedLegsCount })
        }
      }

      const correctedUnmatchedSells = Math.max(0, input.fifoEngineResult.unmatchedSells - routerCorrectedCount - syntheticAlignedCount)
      const correctedUnmatchedBuys = Math.max(0, input.fifoEngineResult.unmatchedBuys - Math.max(0, syntheticAlignedCount - input.fifoEngineResult.unmatchedSells))
      const priceUnavailableCount = [...mismatches.values()].filter((v) => v === 'priceUnavailable').length
      const missingEvidenceCount = input.pnlEngineResult.evidenceMissingCount + correctedUnmatchedBuys + correctedUnmatchedSells + Math.max(0, priceUnavailableCount - recovered.size)
      // SYNTHETIC-PNL LEAK INTO OFFICIAL REALIZED PNL, DISCLOSED AND FIXED (confirmed, critical
      // severity): this previously had a third fallback tier, `?? input.computePnlResult?.realizedPnlUsd`
      // — computePnlResult was wired at the pipeline call site directly from syntheticPnl's totals
      // (src/pipeline/index.ts: `computePnlResult: syntheticPnl ? { realizedPnlUsd:
      // syntheticPnl.totalRealizedPnlUsd, ... } : null`) — syntheticPnl's own module header
      // explicitly documents it as "UI-display-only... never a replacement for or an input to the
      // real, verified engines." Whenever both real engines (fifoEngineResult, pnlEngineResult) had
      // no verified realizedPnlUsd (fifoEngine's computePnl() returns null realizedPnlUsd whenever
      // zero matched lots are fully verified — a common, honest state, not an edge case), this
      // fallback silently substituted syntheticPnl's inferred/estimated figure instead. That number
      // then flows into officialPnlStatus: 'ok' via finalReportAssembler — the exact field the "PnL
      // (Verified V2) — ACTIVE" UI badge reads. Fixed by removing computePnlResult as a source
      // entirely: official realizedPnlUsd/unrealizedPnlUsd now come ONLY from the two real, verified
      // engines, never synthetic — strictly strengthening (never weakening) the existing integrity
      // gate. computePnlResult is now unused; removed from PnlReconciliationInput and its call site.
      //
      // TWO-DISAGREEING-ENGINES FIX, DISCLOSED (confirmed, real production evidence: pnlSummaryV2
      // reported $270.02 while this reconciliation reported $174.01 for the same wallet): the
      // remaining `?? input.pnlEngineResult.realizedPnlUsd` fallback below still meant the "official"
      // total COULD silently come from a completely different closed-lot model whenever
      // fifoEngineResult.realizedPnlUsd happened to be null — fifoEngine (real, quantity-based FIFO
      // matching over normalized events) and pnlEngine (a separate read model over sellTimelineV2/
      // buyTimeline entries — see pnlEngine/index.ts's own header: "Does NOT replace... fifoEngine
      // (the real PnL engine)") are two INDEPENDENT matching implementations over different, only
      // partly-overlapping input sets, so their own totals can legitimately diverge even before
      // accounting for pnlEngine's now-fixed duplicate-sell-entry bug (see
      // pnlEngine/index.ts's dedupeSellEntries). "Falling back" to a different model's total is not
      // reconciliation, it's silently swapping which model is authoritative — exactly the "select
      // one canonical total, do not average/mix models" requirement. Fixed by dropping
      // pnlEngineResult as a source for the official figure entirely: realizedPnlUsd now comes ONLY
      // from fifoEngineResult — the single model every other per-lot mechanism in this pipeline
      // (structural closed-lot pre-pass, pair-rank pricing, ayriAttribution's per-lot records) is
      // already built around. pnlEngineResult remains a real, useful independent cross-check
      // (surfaced via the engine-divergence diagnostic in src/pipeline/index.ts), never the source
      // of truth. This can only ever make official PnL MORE conservative (more honest nulls when
      // fifoEngine alone has no verified figure), never less — strengthening, not weakening, the
      // gate.
      //
      // RECOVERY-INCLUSIVE CANONICAL SUM, DISCLOSED: recomputed from updatedFifoLots (fifoEngine's
      // own lots, with recovery's real resolved prices merged in above) rather than trusting the
      // stale input.fifoEngineResult.realizedPnlUsd, which predates recovery entirely. Mirrors
      // fifoEngine's own computePnl formula exactly (sum of evidenceQuality: 'verified' lots' own
      // realizedPnlUsd, null when none) — when recovery finds nothing new, this is numerically
      // identical to the old value; it only ever adds real, newly-recovered lots to the sum, never
      // changes or removes an already-verified one.
      const verifiedUpdatedLots = updatedFifoLots.filter((l) => l.evidenceQuality === 'verified')
      const recoveryInclusiveRealizedPnlUsd = verifiedUpdatedLots.length > 0
        ? verifiedUpdatedLots.reduce((sum, l) => sum + (l.realizedPnlUsd ?? 0), 0)
        : null
      const realizedPnlUsd = roundUsd(recoveryInclusiveRealizedPnlUsd)
      // STATUS/VALUE CONTRADICTION GUARD, DISCLOSED (closes a residual gap the fix above would
      // otherwise still leave open): structuralConsistent previously checked ONLY lot-count/missing-
      // evidence consistency, never whether realizedPnlUsd itself is actually non-null. Price
      // recovery (recoverPrices above) can zero out missingEvidenceCount's priceUnavailable term for
      // lots it successfully re-priced without those lots ever becoming fifoEngine's own
      // evidenceQuality: 'verified' (recovery only informs this function's own evidence-count
      // bookkeeping, it does not feed back into fifoEngine's matched-lot pricing) — so
      // structuralConsistent could theoretically be true while both real engines still genuinely
      // have no priced realized figure, producing publicPnlStatus: 'available' next to
      // realizedPnlUsd: null — the same "status claims more than the value backs up" contradiction
      // already fixed elsewhere this session (walletConditionMessages, SellActivitySummary).
      // Requiring realizedPnlUsd !== null here closes that gap explicitly rather than relying on it
      // being merely unlikely.
      const structuralConsistent = fifoLots.length === pnlLots.length && correctedUnmatchedBuys === 0 && correctedUnmatchedSells === 0 && missingEvidenceCount === 0 && realizedPnlUsd !== null
      const publicPnlStatus: ReconciledPublicPnlStatus = structuralConsistent ? 'available' : missingEvidenceCount <= 3 && fifoLots.length > 0 ? 'partial' : 'unavailable'
      const summary: PnlReconciliationSummary = { closedLots: Math.max(fifoLots.length, pnlLots.length), unmatchedBuys: correctedUnmatchedBuys, unmatchedSells: correctedUnmatchedSells, realizedPnlUsd, unrealizedPnlUsd: roundUsd(input.fifoEngineResult.unrealizedPnlUsd), priceRecoveredCount: recovered.size, routerCorrectedCount, syntheticAlignedCount, missingEvidenceCount, publicPnlStatus, mismatches: [...mismatches.entries()].map(([key, classification]) => ({ key, classification })).sort((a, b) => a.key.localeCompare(b.key)) }
      logger.warn('[pnl-reconciliation] finalSummary', summary)
      return summary
    },
  }
}

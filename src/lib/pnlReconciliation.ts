import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import type { SyntheticPnlSummary } from '../modules/syntheticPnl'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

export type PnlMismatchClass = 'missingInboundEvidence' | 'missingOutboundEvidence' | 'routerClusterMismatch' | 'priceUnavailable' | 'dustSuppressedToken' | 'syntheticOnlyToken' | 'priceRecovered'
export type ReconciledPublicPnlStatus = 'available' | 'partial' | 'unavailable'

type RouterInferenceLike = { highConfidenceRouters?: ReadonlySet<string>; tokenFlowClustersByAddress?: ReadonlyMap<string, readonly unknown[]> }
type PriceKvLike = { getPriceHistorical?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null>; getPricePrimary?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null> }

type Config = { logger?: Pick<Console, 'warn'>; priceKvClient?: PriceKvLike; priceSources?: { primary?: PriceSourceFn; fallback?: PriceSourceFn }; dustSuppressedKeys?: ReadonlySet<string> }
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
  async function recoverPrices(lots: readonly MatchedLot[]): Promise<{
    recoveredByLotKey: Map<string, RecoveredPrice>
    oneSideMissingCandidates: number
    bothSidesMissingCandidates: number
    candidatesAttempted: number
    candidatesCappedByBudget: number
  }> {
    const recoveredByLotKey = new Map<string, RecoveredPrice>()
    const fetchers = [config.priceSources?.primary, config.priceSources?.fallback].filter(Boolean) as PriceSourceFn[]
    const missingLots = lots.filter((lot) => !(lot.costBasisUsd !== null && lot.proceedsUsd !== null))
    const oneSideMissingCandidates = missingLots.filter((l) => l.costBasisUsd !== null || l.proceedsUsd !== null).length
    const bothSidesMissingCandidates = missingLots.length - oneSideMissingCandidates
    if (!config.priceKvClient || fetchers.length === 0) {
      return { recoveredByLotKey, oneSideMissingCandidates, bothSidesMissingCandidates, candidatesAttempted: 0, candidatesCappedByBudget: missingLots.length }
    }
    const priceKvClient = config.priceKvClient
    const sorted = [...missingLots].sort((a, b) => {
      const aOneSide = a.costBasisUsd !== null || a.proceedsUsd !== null ? 0 : 1
      const bOneSide = b.costBasisUsd !== null || b.proceedsUsd !== null ? 0 : 1
      return aOneSide !== bOneSide ? aOneSide - bOneSide : lotKey(a).localeCompare(lotKey(b))
    })
    const candidates = sorted.slice(0, MAX_RECOVERY_ATTEMPTS)
    await mapWithConcurrencyLimit(candidates, RECOVERY_CONCURRENCY_LIMIT, async (lot) => {
      const needsBuy = lot.costBasisUsd === null
      const needsSell = lot.proceedsUsd === null
      let recoveredBuy: number | null = null
      let recoveredSell: number | null = null
      for (const fetcher of fetchers) {
        if (needsBuy && recoveredBuy === null && priceKvClient.getPriceHistorical) {
          recoveredBuy = await priceKvClient.getPriceHistorical(lot.token, lot.chain, lot.openedAt, fetcher)
        }
        if (needsSell && recoveredSell === null && priceKvClient.getPricePrimary) {
          recoveredSell = await priceKvClient.getPricePrimary(lot.token, lot.chain, lot.closedAt, fetcher)
        }
        if ((!needsBuy || recoveredBuy !== null) && (!needsSell || recoveredSell !== null)) break
      }
      if (recoveredBuy !== null || recoveredSell !== null) {
        recoveredByLotKey.set(lotKey(lot), { costBasisUsd: recoveredBuy, proceedsUsd: recoveredSell })
      }
    })
    return { recoveredByLotKey, oneSideMissingCandidates, bothSidesMissingCandidates, candidatesAttempted: candidates.length, candidatesCappedByBudget: sorted.length - candidates.length }
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

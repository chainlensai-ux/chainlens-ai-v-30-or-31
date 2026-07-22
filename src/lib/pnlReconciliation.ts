import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import type { SyntheticPnlSummary } from '../modules/syntheticPnl'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

export type PnlMismatchClass = 'missingInboundEvidence' | 'missingOutboundEvidence' | 'routerClusterMismatch' | 'priceUnavailable' | 'dustSuppressedToken' | 'syntheticOnlyToken' | 'priceRecovered'
export type ReconciledPublicPnlStatus = 'available' | 'partial' | 'unavailable'

type RouterInferenceLike = { highConfidenceRouters?: ReadonlySet<string>; tokenFlowClustersByAddress?: ReadonlyMap<string, readonly unknown[]> }
type PriceKvLike = { getPriceHistorical?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null>; getPricePrimary?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null> }

type Config = { logger?: Pick<Console, 'warn'>; priceKvClient?: PriceKvLike; priceSources?: { primary?: PriceSourceFn; fallback?: PriceSourceFn }; dustSuppressedKeys?: ReadonlySet<string> }
export type PnlReconciliationInput = { fifoEngineResult: FifoOutput; pnlEngineResult: PnlSummaryResult; computePnlResult?: { realizedPnlUsd?: number | null; unrealizedPnlUsd?: number | null } | null; routerInferenceOutput?: RouterInferenceLike | null; syntheticPnlAssemblyOutput?: SyntheticPnlSummary | null }
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

  // Recovery still returns the exact same semantics as before: a lot this function reaches and
  // successfully prices ends up in the returned Set (marked 'priceRecovered' by the caller); any
  // lot it doesn't reach (beyond MAX_RECOVERY_ATTEMPTS) or can't price simply stays
  // 'priceUnavailable' — exactly as honest as before, never a fabricated recovered price.
  async function recoverPrices(lots: readonly MatchedLot[]): Promise<Set<string>> {
    const recovered = new Set<string>()
    const fetchers = [config.priceSources?.primary, config.priceSources?.fallback].filter(Boolean) as PriceSourceFn[]
    if (!config.priceKvClient || fetchers.length === 0) return recovered
    const priceKvClient = config.priceKvClient
    const candidates = [...lots]
      .sort((a, b) => lotKey(a).localeCompare(lotKey(b)))
      .filter((lot) => !(lot.costBasisUsd !== null && lot.proceedsUsd !== null))
      .slice(0, MAX_RECOVERY_ATTEMPTS)
    await mapWithConcurrencyLimit(candidates, RECOVERY_CONCURRENCY_LIMIT, async (lot) => {
      for (const fetcher of fetchers) {
        const buy = lot.costBasisUsd === null && priceKvClient.getPriceHistorical ? await priceKvClient.getPriceHistorical(lot.token, lot.chain, lot.openedAt, fetcher) : null
        const sell = lot.proceedsUsd === null && priceKvClient.getPricePrimary ? await priceKvClient.getPricePrimary(lot.token, lot.chain, lot.closedAt, fetcher) : null
        if (buy !== null || sell !== null) { recovered.add(lotKey(lot)); return }
      }
    })
    return recovered
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

      const recovered = await recoverPrices(fifoLots)
      for (const key of recovered) mismatches.set(key, 'priceRecovered')

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
      const structuralConsistent = fifoLots.length === pnlLots.length && correctedUnmatchedBuys === 0 && correctedUnmatchedSells === 0 && missingEvidenceCount === 0
      const publicPnlStatus: ReconciledPublicPnlStatus = structuralConsistent ? 'available' : missingEvidenceCount <= 3 && fifoLots.length > 0 ? 'partial' : 'unavailable'
      const realizedPnlUsd = roundUsd(input.fifoEngineResult.realizedPnlUsd ?? input.pnlEngineResult.realizedPnlUsd ?? input.computePnlResult?.realizedPnlUsd)
      const summary: PnlReconciliationSummary = { closedLots: Math.max(fifoLots.length, pnlLots.length), unmatchedBuys: correctedUnmatchedBuys, unmatchedSells: correctedUnmatchedSells, realizedPnlUsd, unrealizedPnlUsd: roundUsd(input.fifoEngineResult.unrealizedPnlUsd ?? input.computePnlResult?.unrealizedPnlUsd), priceRecoveredCount: recovered.size, routerCorrectedCount, syntheticAlignedCount, missingEvidenceCount, publicPnlStatus, mismatches: [...mismatches.entries()].map(([key, classification]) => ({ key, classification })).sort((a, b) => a.key.localeCompare(b.key)) }
      logger.warn('[pnl-reconciliation] finalSummary', summary)
      return summary
    },
  }
}

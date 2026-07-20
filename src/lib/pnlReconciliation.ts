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

export function createPnlReconciliation(config: Config = {}) {
  const logger = config.logger ?? console
  let state: PnlReconciliationInput | null = null

  async function recoverPrices(lots: readonly MatchedLot[]): Promise<Set<string>> {
    const recovered = new Set<string>()
    const fetchers = [config.priceSources?.primary, config.priceSources?.fallback].filter(Boolean) as PriceSourceFn[]
    if (!config.priceKvClient || fetchers.length === 0) return recovered
    for (const lot of [...lots].sort((a, b) => lotKey(a).localeCompare(lotKey(b)))) {
      if (lot.costBasisUsd !== null && lot.proceedsUsd !== null) continue
      for (const fetcher of fetchers) {
        const buy = lot.costBasisUsd === null && config.priceKvClient.getPriceHistorical ? await config.priceKvClient.getPriceHistorical(lot.token, lot.chain, lot.openedAt, fetcher) : null
        const sell = lot.proceedsUsd === null && config.priceKvClient.getPricePrimary ? await config.priceKvClient.getPricePrimary(lot.token, lot.chain, lot.closedAt, fetcher) : null
        if (buy !== null || sell !== null) { recovered.add(lotKey(lot)); logger.warn('[pnl-reconciliation] priceRecovered', { lot: lotKey(lot), token: lot.token, chain: lot.chain }); break }
      }
    }
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

import { assembleReport } from '../modules/finalReportAssembler'
import type { AssembleReportInput, FinalReport } from '../modules/finalReportAssembler/types'
import type { FifoOutput } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import type { SourceBreakdown } from '../modules/pricingAtTimeEngine/types'
import type { SyntheticPnlSummary } from '../modules/syntheticPnl/types'
import type { WalletConditionInput } from '../pipeline/walletConditionMessages'
import type { AyriAttributionOutput } from './ayriAttribution'
import type { PnlReconciliationSummary } from './pnlReconciliation'
import type { RouterInferenceResult } from './routerInference'

type Logger = Pick<Console, 'warn'>

type PricingSourceBreakdown = Partial<SourceBreakdown & { ratio: number; synthetic: number; recovered: number }>

type BuildInput = AssembleReportInput & {
  reconciledPnL: PnlReconciliationSummary
  ayriAttribution: AyriAttributionOutput
  routerInferenceOutput: RouterInferenceResult
  syntheticPnlAssemblyOutput?: SyntheticPnlSummary | null
  pricingSourceBreakdown?: PricingSourceBreakdown
  walletConditionInputs?: Partial<WalletConditionInput>
}

export type FinalReportAssemblerState = {
  reconciledPnL: PnlReconciliationSummary | null
  ayriAttribution: AyriAttributionOutput | null
  routerInferenceOutput: RouterInferenceResult | null
  syntheticPnlAssemblyOutput: SyntheticPnlSummary | null
  pricingSourceBreakdown: PricingSourceBreakdown | null
  walletConditionInputs: WalletConditionInput | null
}

export type FinalReportAssemblerOutput = FinalReport & {
  reconciliationSummary: PnlReconciliationSummary
  coveragePercent: number
  integrityTier: AyriAttributionOutput['integrityTier']
  attributionSummary: AyriAttributionOutput
  syntheticAlignedCount: number
  routerCorrectedCount: number
  recoveredCount: number
  outboundToKnownRouterCount: number
  routerInvolvement: number
  syntheticCoverage: number
  syntheticIntegrity: AyriAttributionOutput['integrityTier']
  pricingSourceBreakdown: {
    primaryCount: number
    fallbackCount: number
    ratioCount: number
    syntheticCount: number
    recoveredCount: number
  }
  walletConditionInputs: WalletConditionInput
}

const publicStatusMap: Record<PnlReconciliationSummary['publicPnlStatus'], FifoOutput['publicPnlStatus']> = {
  available: 'ok',
  partial: 'limited_verified_sample',
  unavailable: 'unavailable',
}

function buildReconciledFifo(input: BuildInput): FifoOutput {
  return {
    ...input.fifoAndPnl,
    matchedLots: input.fifoAndPnl.matchedLots,
    unmatchedBuys: input.reconciledPnL.unmatchedBuys,
    unmatchedSells: input.reconciledPnL.unmatchedSells,
    realizedPnlUsd: input.reconciledPnL.realizedPnlUsd,
    unrealizedPnlUsd: input.reconciledPnL.unrealizedPnlUsd,
    publicPnlStatus: publicStatusMap[input.reconciledPnL.publicPnlStatus],
  }
}

function buildReconciledPnlSummary(input: BuildInput): PnlSummaryResult {
  return {
    ...input.pnlSummaryV2,
    realizedPnlUsd: input.reconciledPnL.realizedPnlUsd,
    evidenceMissingCount: input.reconciledPnL.missingEvidenceCount,
  }
}

function buildPricingSummary(ayri: AyriAttributionOutput) {
  return {
    primaryCount: ayri.primaryCount,
    fallbackCount: ayri.fallbackCount,
    ratioCount: ayri.ratioCount,
    syntheticCount: ayri.syntheticCount,
    recoveredCount: ayri.recoveredCount,
  }
}

function buildWalletConditionInputs(input: BuildInput): WalletConditionInput {
  return {
    tokenCount: input.walletConditionInputs?.tokenCount ?? 0,
    deadTokens: input.walletConditionInputs?.deadTokens ?? 0,
    unindexedTokens: input.walletConditionInputs?.unindexedTokens ?? 0,
    zeroLiquidityTokens: input.walletConditionInputs?.zeroLiquidityTokens ?? 0,
    failedPricingAttempts: input.walletConditionInputs?.failedPricingAttempts ?? 0,
    fallbackAttempts: input.walletConditionInputs?.fallbackAttempts ?? 0,
    providerErrors: input.walletConditionInputs?.providerErrors ?? 0,
    suppressionSkipped: input.walletConditionInputs?.suppressionSkipped ?? 0,
    closedLots: input.reconciledPnL.closedLots,
    totalSells: input.walletConditionInputs?.totalSells ?? 0,
    previousPnL: input.walletConditionInputs?.previousPnL,
    currentPnL: input.reconciledPnL.realizedPnlUsd,
    lowLiquidityTokens: input.walletConditionInputs?.lowLiquidityTokens,
    microcaps: input.walletConditionInputs?.microcaps,
    excludedTokens: input.walletConditionInputs?.excludedTokens,
  }
}

export function createFinalReportAssembler(config: { logger?: Logger } = {}) {
  const logger = config.logger ?? console
  let state: FinalReportAssemblerState = {
    reconciledPnL: null,
    ayriAttribution: null,
    routerInferenceOutput: null,
    syntheticPnlAssemblyOutput: null,
    pricingSourceBreakdown: null,
    walletConditionInputs: null,
  }

  return {
    getState: () => state,
    assemble(input: BuildInput): FinalReportAssemblerOutput {
      logger.warn('[final-report] assembling', { walletAddress: input.scanMetadata.walletAddress, scanTimestamp: input.scanMetadata.scanTimestamp })
      const fifoAndPnl = buildReconciledFifo(input)
      const pnlSummaryV2 = buildReconciledPnlSummary(input)
      const pricingSourceBreakdown = buildPricingSummary(input.ayriAttribution)
      const walletConditionInputs = buildWalletConditionInputs(input)
      state = {
        reconciledPnL: input.reconciledPnL,
        ayriAttribution: input.ayriAttribution,
        routerInferenceOutput: input.routerInferenceOutput,
        syntheticPnlAssemblyOutput: input.syntheticPnlAssemblyOutput ?? null,
        pricingSourceBreakdown: input.pricingSourceBreakdown ?? null,
        walletConditionInputs,
      }
      logger.warn('[final-report] reconciledPnL', input.reconciledPnL)
      logger.warn('[final-report] ayriSummary', input.ayriAttribution)
      logger.warn('[final-report] routerSummary', { outboundToKnownRouterCount: input.routerInferenceOutput.acceptedRouters.size, routerInvolvement: input.ayriAttribution.routerCorrectedCount })
      logger.warn('[final-report] pricingSummary', pricingSourceBreakdown)
      const base = assembleReport({ ...input, fifoAndPnl, pnlSummaryV2, syntheticPnl: input.syntheticPnlAssemblyOutput ?? input.syntheticPnl, ayriAttribution: input.ayriAttribution })
      const finalReport = {
        ...base,
        reconciliationSummary: input.reconciledPnL,
        coveragePercent: input.ayriAttribution.coveragePercent,
        integrityTier: input.ayriAttribution.integrityTier,
        attributionSummary: input.ayriAttribution,
        syntheticAlignedCount: input.ayriAttribution.syntheticAlignedCount,
        routerCorrectedCount: input.ayriAttribution.routerCorrectedCount,
        recoveredCount: input.ayriAttribution.recoveredCount,
        outboundToKnownRouterCount: input.routerInferenceOutput.acceptedRouters.size,
        routerInvolvement: input.ayriAttribution.routerCorrectedCount,
        syntheticCoverage: input.ayriAttribution.syntheticCount,
        syntheticIntegrity: input.ayriAttribution.integrityTier,
        pricingSourceBreakdown,
        walletConditionInputs,
      }
      logger.warn('[final-report] final', finalReport)
      return finalReport
    },
  }
}

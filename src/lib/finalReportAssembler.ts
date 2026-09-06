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
  // RENAMED, DISCLOSED (holdings/PnL-confidence audit task): mirrors
  // AyriAttributionSummary.attributionCoveragePercent's own rename — see that field's header in
  // ayriAttribution.ts for the full reasoning. Every consumer of the old top-level `coveragePercent`
  // name updated alongside this rename.
  attributionCoveragePercent: number
  // ADDED, DISCLOSED (this task's explicit "expose separately" requirement): passed through
  // unchanged from ayriAttribution's own output — see that module's own field-level disclosures.
  historicalPricingCoveragePercent: number
  verifiedPricingCoveragePercent: number
  fullyPricedLots: number
  totalLots: number
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
  // The sell-entry rows remain useful diagnostics, but their independently derived aggregate is
  // not an official second PnL engine. Preserve that aggregate under an explicit diagnostic name
  // and make every public realized-PnL headline resolve to reconciled canonical FIFO.
  return {
    ...input.pnlSummaryV2,
    diagnosticRealizedPnlUsd: input.pnlSummaryV2.realizedPnlUsd,
    diagnosticOnly: true,
    realizedPnlUsd: input.reconciledPnL.realizedPnlUsd,
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
  const audit = input.reconciledPnL.publicPnlGateAudit
  const verified = audit?.verifiedClosedLots
    ?? input.walletConditionInputs?.verifiedClosedLots
    ?? input.walletConditionInputs?.closedLots
    ?? 0
  const structural = audit?.structuralClosedLots
    ?? input.walletConditionInputs?.structuralClosedLots
    ?? input.walletConditionInputs?.totalSells
    ?? 0
  return {
    tokenCount: input.walletConditionInputs?.tokenCount ?? 0,
    deadTokens: input.walletConditionInputs?.deadTokens ?? 0,
    unindexedTokens: input.walletConditionInputs?.unindexedTokens ?? 0,
    zeroLiquidityTokens: input.walletConditionInputs?.zeroLiquidityTokens ?? 0,
    failedPricingAttempts: input.walletConditionInputs?.failedPricingAttempts ?? 0,
    fallbackAttempts: input.walletConditionInputs?.fallbackAttempts ?? 0,
    providerErrors: input.walletConditionInputs?.providerErrors ?? 0,
    suppressionSkipped: input.walletConditionInputs?.suppressionSkipped ?? 0,
    // Wallet PnL publish Item 4: never mix reconciledPnL.closedLots (structural) with
    // sell-timeline totalSells — that inverted pair is the live "586 of 184 (318%)" bug.
    closedLots: verified,
    totalSells: structural,
    verifiedClosedLots: verified,
    structuralClosedLots: structural,
    previousPnL: input.walletConditionInputs?.previousPnL,
    currentPnL: input.reconciledPnL.realizedPnlUsd,
    lowLiquidityTokens: input.walletConditionInputs?.lowLiquidityTokens,
    microcaps: input.walletConditionInputs?.microcaps,
    excludedTokens: input.walletConditionInputs?.excludedTokens,
    publicPnlStatus: input.walletConditionInputs?.publicPnlStatus,
    rateLimitDetected: input.walletConditionInputs?.rateLimitDetected,
    transactionHistoryPartial: input.walletConditionInputs?.transactionHistoryPartial,
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
        attributionCoveragePercent: input.ayriAttribution.attributionCoveragePercent,
        historicalPricingCoveragePercent: input.ayriAttribution.historicalPricingCoveragePercent,
        verifiedPricingCoveragePercent: input.ayriAttribution.verifiedPricingCoveragePercent,
        fullyPricedLots: input.ayriAttribution.fullyPricedLots,
        totalLots: input.ayriAttribution.totalLots,
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

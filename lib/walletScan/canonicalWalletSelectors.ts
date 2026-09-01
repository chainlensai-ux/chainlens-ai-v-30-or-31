// CANONICAL WALLET SELECTORS, DISCLOSED (Clark /wallet = Wallet Scanner result task).
//
// This is the ONE server-safe module Clark, the wallet-scan orchestrator, CORTEX, and the Wallet
// Scanner UI all read for:
//   - merged portfolio total (computeMergedTotalValueUsd lives in mergedWalletView.ts and is
//     re-exported here after that file dropped its 'use client' import),
//   - Base/ETH PnL lane status,
//   - Robinhood PnL lane status (Phase 3 fail-closed),
//   - Robinhood display identity (ROBINHOOD_CHAIN_META).
//
// No network calls. No new FIFO/PnL computation. Selectors are pure re-derivations of fields the
// Wallet Scanner page already has. Moving them out of 'use client' files is the only way Clark's
// server route can call the SAME functions the UI uses without bundling React into /api/clark.

import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import type { PublicPnlStatus, UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'
import type { PnlReconciliationSummary } from '@/src/lib/pnlReconciliation'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'

// Wallet Scanner page (app/terminal/wallet-scanner/page.tsx handleScan) always requests these EVM
// chains plus Robinhood via the sidecar — never Arbitrum unless a caller explicitly asks for it.
export const WALLET_SCANNER_EVM_CHAINS = ['base', 'eth'] as const

export const ROBINHOOD_CHAIN_META = { chainSlug: 'robinhood' as const, chainId: 4663, label: 'Robinhood Chain' }
export const ROBINHOOD_PNL_PHASE3_SOURCE = 'robinhood_sidecar_phase3' as const
export const ROBINHOOD_PNL_NOT_VERIFIED_REASON = 'Requires verified Robinhood swaps + both-leg price evidence.'

export type RobinhoodPnlVerificationAudit = {
  wallet: string
  chainId: number
  source: 'robinhood_sidecar_phase3'
  status: 'disabled' | 'partial' | 'verified'
  realizedPnlUsd: number | null
  verifiedSwapCount: number
  decodedSwapCount: number
  swapsFedToFifo: number
  fifoClosedLots: number
  priceEvidenceBothLegsCount: number
  missingPriceEvidenceCount: number
  blockscoutFallbackUsed: boolean
  goldrushUsed: boolean
  alchemyRpcUsed: boolean
  pnlEnabledReason: string | null
  pnlDisabledReason: string | null
  rejectedReasonIfNotVerified: string | null
}

export type RobinhoodWalletScanResponse = {
  ok: boolean
  wallet: string
  chainSlug: 'robinhood'
  chainId: number
  holdings: {
    status: 'ok' | 'partial' | 'unavailable' | 'not_configured'
    native: { symbol: string; uiBalance: number | null; priceUsd: number | null; valueUsd: number | null } | null
    holdings: Array<{ address: string; symbol: string | null; name: string | null; uiBalance: number | null; priceUsd: number | null; valueUsd: number | null; priceSource: string | null }>
    portfolioTotalUsd: number | null
    unpricedTokenCount: number
    reason: string | null
  }
  activity: {
    status: 'ok' | 'partial' | 'unavailable' | 'not_configured'
    items: Array<{ txHash: string; blockTimestamp: string | null; kind: 'native_transfer' | 'token_transfer'; direction: 'incoming' | 'outgoing'; counterparty: string | null; tokenSymbol: string | null }>
    skippedSwapLogs: number
    verifiedSwapCount: number
    blockscoutEvidence: {
      blockscoutAttempted: boolean
      blockscoutSucceeded: boolean
      blockscoutFallbackUsed: boolean
      blockscoutStatus: 'ok' | 'unavailable' | 'not_configured' | 'rate_limited' | 'not_attempted'
      blockscoutError: string | null
      blockscoutVerifiedSwap: boolean
    }
    reason: string | null
  }
  pnl: {
    status: 'disabled' | 'partial' | 'verified'
    message: string
    realizedPnlUsd: number | null
    matchedLotsCount: number
    verifiedSwapCount: number
    reason: string | null
  }
  robinhoodWalletScannerAudit: Record<string, unknown>
  robinhoodPnlVerificationAudit?: RobinhoodPnlVerificationAudit | null
}

export type RobinhoodPnlLaneStatus = 'verified' | 'not_verified' | 'unavailable'

export function selectRobinhoodPnlLaneStatus(robinhoodResult: RobinhoodWalletScanResponse | null | undefined): RobinhoodPnlLaneStatus {
  if (!robinhoodResult || !robinhoodResult.ok) return 'unavailable'
  const pnl = robinhoodResult.pnl
  const audit = robinhoodResult.robinhoodPnlVerificationAudit
  if (!audit || audit.source !== ROBINHOOD_PNL_PHASE3_SOURCE || audit.chainId !== 4663) return 'not_verified'
  if (
    pnl.status === 'verified'
    && audit.status === 'verified'
    && pnl.realizedPnlUsd != null
    && audit.realizedPnlUsd != null
    && pnl.verifiedSwapCount > 0
    && audit.verifiedSwapCount > 0
    && audit.swapsFedToFifo > 0
    && audit.fifoClosedLots > 0
    && audit.priceEvidenceBothLegsCount > 0
  ) return 'verified'
  return 'not_verified'
}

export type RobinhoodPnlCompactProof = {
  source: 'Robinhood Phase 3 sidecar'
  verifiedSwapCount: number
  fifoClosedLots: number
  priceEvidenceBothLegs: true
}

export function robinhoodCompactProof(robinhoodResult: RobinhoodWalletScanResponse | null | undefined): RobinhoodPnlCompactProof | null {
  if (selectRobinhoodPnlLaneStatus(robinhoodResult) !== 'verified') return null
  const audit = robinhoodResult?.robinhoodPnlVerificationAudit
  if (!audit) return null
  return {
    source: 'Robinhood Phase 3 sidecar',
    verifiedSwapCount: audit.verifiedSwapCount,
    fifoClosedLots: audit.fifoClosedLots,
    priceEvidenceBothLegs: true,
  }
}

// ── EVM lane (byte-for-byte the PnlStatusCard classification, without the React card) ──────────

const GUARDRAIL_ABS_LIMIT = 1e9

type DisplayedUnrealizedPnl = {
  value: number | null
  reconciliationStatus: UnrealizedReconciliationSummary['reconciliationStatus'] | null
  coveragePercent: number | null
}

function selectDisplayedUnrealizedPnl(
  unrealizedReconciliation: UnrealizedReconciliationSummary | null | undefined,
): DisplayedUnrealizedPnl {
  if (!unrealizedReconciliation) {
    return { value: null, reconciliationStatus: null, coveragePercent: null }
  }
  return {
    value: unrealizedReconciliation.officialUnrealizedPnlUsd,
    reconciliationStatus: unrealizedReconciliation.reconciliationStatus,
    coveragePercent: unrealizedReconciliation.unrealizedCoveragePercent,
  }
}

function isUnreliableMagnitude(pnlV2: PnlV2, totalCostBasisUsd: number, displayedUnrealizedPnlUsd: number | null): boolean {
  const magnitudes = [
    pnlV2.realizedPnlUsd,
    totalCostBasisUsd,
    ...pnlV2.chainBreakdown.map((c) => c.realizedPnlUsd),
  ]
  if (displayedUnrealizedPnlUsd != null) magnitudes.push(displayedUnrealizedPnlUsd)
  return magnitudes.some((v) => Math.abs(v) > GUARDRAIL_ABS_LIMIT)
}

function isStablePnl(params: {
  realizedPnlUsd: number | null | undefined
  unrealizedPnlUsd: number | null | undefined
  evidenceMissingCount?: number
  publicPnlStatus?: PublicPnlStatus | null
}): boolean {
  if ((params.evidenceMissingCount ?? 0) > 0) return false
  if (!Number.isFinite(params.realizedPnlUsd)) return false
  if (!Number.isFinite(params.unrealizedPnlUsd)) return false
  if (params.publicPnlStatus === 'unavailable') return false
  return true
}

function selectVerifiedPnlData(
  pnlV2: PnlV2 | null | undefined,
  publicPnlStatus?: PublicPnlStatus | null,
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null,
): { unreliable: boolean; stable: boolean } {
  const displayedUnrealized = selectDisplayedUnrealizedPnl(unrealizedReconciliation)
  if (!pnlV2) {
    return { unreliable: false, stable: false }
  }
  const totalCostBasisUsd = pnlV2.costBasis.reduce((sum, c) => sum + c.totalCostUsd, 0)
  const unrealizedPnlUsd = displayedUnrealized.value
  return {
    unreliable: isUnreliableMagnitude(pnlV2, totalCostBasisUsd, unrealizedPnlUsd),
    stable: isStablePnl({ realizedPnlUsd: pnlV2.realizedPnlUsd, unrealizedPnlUsd, publicPnlStatus }),
  }
}

export function resolveEffectivePublicPnlStatus(
  publicPnlStatus: PublicPnlStatus | null | undefined,
  reconciliationSummary: PnlReconciliationSummary | null | undefined,
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null,
): PublicPnlStatus | null {
  const status = publicPnlStatus ?? null
  if (status !== 'unavailable') return status
  const manifestGenuinelyApplied = canonicalSampleManifestAudit?.manifestApplied === true
    && canonicalSampleManifestAudit?.canonicalSampleEvidenceUnavailable !== true
  if (manifestGenuinelyApplied && reconciliationSummary?.publicPnlStatus === 'partial') {
    return 'limited_verified_sample'
  }
  return status
}

export type EvmPnlLaneStatus = 'verified' | 'partial' | 'unavailable'
export function selectEvmPnlLaneStatus(params: {
  pnlV2: PnlV2 | null | undefined
  publicPnlStatus?: PublicPnlStatus | null
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
  reconciliationSummary?: PnlReconciliationSummary | null
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
}): EvmPnlLaneStatus {
  if (params.pnlV2 == null) return 'unavailable'
  const effectivePublicPnlStatus = resolveEffectivePublicPnlStatus(params.publicPnlStatus, params.reconciliationSummary, params.canonicalSampleManifestAudit)
  if (effectivePublicPnlStatus === 'limited_verified_sample') return 'partial'
  const pnl = selectVerifiedPnlData(params.pnlV2, effectivePublicPnlStatus, params.unrealizedReconciliation)
  return (pnl.unreliable || !pnl.stable) ? 'partial' : 'verified'
}

export function chainDisplayLabel(chain: string): string {
  const c = String(chain ?? '').toLowerCase()
  if (c === 'eth' || c === 'ethereum') return 'ETH'
  if (c === 'base') return 'Base'
  if (c === 'robinhood') return 'Robinhood'
  if (c === 'arbitrum') return 'Arbitrum'
  if (c === 'bnb' || c === 'bsc') return 'BNB'
  return chain
}

export function toRobinhoodWalletScanResponse(
  wallet: string,
  rh: {
    holdings: RobinhoodWalletScanResponse['holdings']
    activity: RobinhoodWalletScanResponse['activity']
    pnl: { status: 'disabled' | 'partial' | 'verified'; realizedPnlUsd: number | null; matchedLotsCount: number; verifiedSwapCount: number; reason: string | null }
    audit: Record<string, unknown> & { chainId?: number }
    pnlVerificationAudit: RobinhoodPnlVerificationAudit
  },
): RobinhoodWalletScanResponse {
  return {
    ok: true,
    wallet,
    chainSlug: 'robinhood',
    chainId: typeof rh.audit.chainId === 'number' ? rh.audit.chainId : ROBINHOOD_CHAIN_META.chainId,
    holdings: rh.holdings,
    activity: rh.activity,
    pnl: {
      status: rh.pnl.status,
      message: rh.pnl.reason ?? rh.pnl.status,
      realizedPnlUsd: rh.pnl.realizedPnlUsd,
      matchedLotsCount: rh.pnl.matchedLotsCount,
      verifiedSwapCount: rh.pnl.verifiedSwapCount,
      reason: rh.pnl.reason,
    },
    robinhoodWalletScannerAudit: rh.audit,
    robinhoodPnlVerificationAudit: rh.pnlVerificationAudit,
  }
}

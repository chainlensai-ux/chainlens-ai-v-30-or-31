'use client'

import { useState, useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { usePlanWithLoading, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import { resolveTokenQuery, isContractAddress, fmtLiquidity, type ResolverResult, type ResolverCandidate } from '@/lib/tickerResolver'
import { calculateCortexScoreV2, type CortexScoreResultV2 } from '@/lib/token/scoring'
// Client-safe: lib/solanaAddress.ts reads no env var and holds no secret (unlike
// lib/server/solanaChainConfig.ts, which must never be imported here).
import { classifySolanaMintInput, isValidSolanaMintAddress, SOLANA_MINT_REJECTION_MESSAGE } from '@/lib/solanaAddress'
import type { SolanaBetaScanResult } from '@/lib/server/solanaTokenScannerBeta'
// Pure presentation mapping over solanaResult — see lib/solanaConfidenceScore.ts's own header for
// the full disclosure on why a capped, clearly-labeled score replaced the earlier "no score shown"
// design (this task explicitly permits it). Client-safe, no env var, no secret.
import { computeSolanaConfidenceScore } from '@/lib/solanaConfidenceScore'
import { computeSolanaCortexRisk, classifySolanaExtensionRisk } from '@/lib/solanaCortexRisk'
import { resolveDeployerWalletIntel } from '@/lib/deployerWalletIntel'
import { resolveRobinhoodTokenEvidence } from '@/lib/robinhoodTokenEvidence'
import {
  buildRobinhoodLpCopy,
  buildRobinhoodLpSafetyBuckets,
  ROBINHOOD_HOLDER_UNAVAILABLE_LABEL,
  ROBINHOOD_SECURITY_UNSUPPORTED_LABEL,
  type RobinhoodLpProofAudit,
  type RobinhoodLpResolutionAudit,
} from '@/lib/robinhoodLpProofShared'
import {
  buildDevMapUiLabels,
  type DevClusterDiagnosisAudit,
} from '@/lib/devClusterDiagnosis'
import {
  classifyTokenScannerEvidence,
  tokenScannerEvidenceChainId,
} from '@/lib/tokenScannerEvidence'
import {
  buildTradingSimulationUi,
  classifyTradingSimulation,
  type TradingSimulationAudit,
} from '@/lib/tradingSimulation'
import {
  normalizeRiskScore,
  riskColorFromCanonicalLabel,
  riskGaugeFillPercent,
  riskLabelCopy,
  coerceCanonicalRiskLabel,
  type RiskScoreDirectionAudit,
} from '@/lib/riskScoreDirection'

// Type-only import above is erased at build time, so no server module is bundled into the client.
type SolanaBetaResult = SolanaBetaScanResult

// ─── Canonical status ─────────────────────────────────────────────────────
type CanonicalStatus =
  | "verified"
  | "inferred"
  | "partial"
  | "not_applicable"
  | "unavailable_with_reason"

function canonicalLabel(s: CanonicalStatus | string | undefined): string {
  return cleanStatusLabel(s)
}

function cleanStatusLabel(value: string | null | undefined): string {
  switch ((value ?? '').toLowerCase()) {
    case 'not_applicable': return 'Protocol-specific'
    case 'concentrated_liquidity': return 'Concentrated Liquidity'
    case 'protocol_or_gauge': return 'Protocol Position Model'
    case 'open_check':
    case 'unavailable_with_reason':
    case 'insufficient_data':
    case 'error':
    case 'unknown': return 'Open Check'
    case 'team_controlled':
    case 'wallet_controlled':
    case 'wallet': return 'Wallet Controlled'
    case 'burn':
    case 'burned': return 'Burned'
    case 'lockcontract':
    case 'locked': return 'Locked'
    case 'partial': return 'Partial Evidence'
    case 'confirmed':
    case 'verified': return 'Confirmed'
    case 'no_pool': return 'No Active Pool'
    case 'low': return 'Low'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'watch': return 'Watch'
    case 'protected': return 'Protected'
    case 'none': return 'None'
    case 'expired': return 'Expired'
    case 'deep': return 'Deep'
    case 'contract': return 'Contract'
    default: {
      const raw = value?.trim()
      return raw ? raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Open Check'
    }
  }
}

// MIGRATION-RISK FINAL-STATE HELPER, DISCLOSED (Base Token Scanner state/copy consistency
// task): Migration Risk must never final-render the literal "Open Check" — it is the one
// field left with an unresolved/pending connotation that reads as "the scan never finished".
// This is the single shared mapping used everywhere Migration Risk is displayed (compact
// detail rows, LP Controller Intel, LP History Timeline) so all three surfaces agree. Risk
// math itself is untouched — this only renames the final label for states that previously
// fell through to "Open Check": no pool at all becomes "Not detected"; a pool exists but the
// migration-proof pipeline never returned a confirmed status becomes "Unavailable: reason"
// (or plain "Unavailable" when no machine-readable reason was attached).
function migrationRiskFinalLabel(raw: string | null | undefined, opts?: { hasPool?: boolean; reason?: string | null }): string {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'low') return 'Low'
  if (v === 'watch' || v === 'medium') return 'Watch'
  if (v === 'flagged' || v === 'high') return 'Elevated'
  if (opts?.hasPool === true) return 'Pool detected'
  if (opts?.hasPool === false) return 'Not detected'
  return opts?.reason ? `Unavailable: ${opts.reason}` : 'Unavailable'
}

function isProtocolPositionModel(result: ScanResult): boolean {
  const dm = result.lpControl?.displayLpModel
  return dm === 'concentrated_liquidity'
    || dm === 'protocol_or_gauge'
    || result.lpControl?.proofStatus === 'not_applicable'
    || result.lpLockBurnIntel?.lockBurnProof === 'not_applicable'
    || result.lpControllerIntel?.status === 'concentrated_liquidity'
    || result.lpLockBurnIntel?.poolModel === 'concentrated_liquidity'
    || result.lpHistoryTimeline?.poolModel === 'concentrated_liquidity'
}

function primaryLiquidityModelLabel(result: ScanResult): string {
  const dex = result.lpHistoryTimeline?.primaryDex || result.primaryDexName || result.lpControl?.primaryPoolDex || result.lpControl?.dexName || result.lpModelProof?.dexName
  const dm = result.lpControl?.displayLpModel
  if (isProtocolPositionModel(result)) {
    if (dex && /pancake/i.test(dex)) return 'PancakeSwap V3 Concentrated'
    if (dex && /uniswap\s*v4/i.test(dex)) return 'Uniswap V4 Concentrated'
    if (dex && /uniswap/i.test(dex)) return 'Uniswap V3 Concentrated'
    if (dex && /slipstream|aerodrome/i.test(dex)) return 'Aerodrome Slipstream'
    return dm === 'protocol_or_gauge' ? 'Protocol Position Model' : 'Concentrated Liquidity'
  }
  if (dm === 'erc20_lp_token') return 'ERC-20 LP Token'
  if (dm === 'no_pool') return 'No Active Pool'
  return 'Model Open Check'
}


function isUniswapV3ConcentratedPartial(result: ScanResult): boolean {
  const liquiditySection = result.sections?.liquidity
  const lpMeta = result.lpMeta ?? liquiditySection?.lpMeta ?? {}
  const selectedPool = result.selectedPool ?? (result.pools?.[0] as (Pool & { dex?: string | null; model?: string | null }) | undefined)
  const cpp = result.concentratedPositionProof
  const primaryDexName = result.primaryDexName
    ?? selectedPool?.dex
    ?? (typeof lpMeta?.primaryMarketDex === 'string' ? lpMeta.primaryMarketDex : undefined)
    ?? liquiditySection?.pool_protocol
    ?? result.lpHistoryTimeline?.primaryDex
    ?? result.lpControl?.primaryPoolDex
    ?? result.lpControl?.dexName
    ?? result.lpModelProof?.dexName
    ?? ''

  return Boolean(
    selectedPool?.model === 'concentrated'
    && /uniswap v3/i.test(String(selectedPool?.dex || primaryDexName || lpMeta?.primaryMarketDex || ''))
    && lpMeta?.concentratedProofAttempted === true
    && cpp?.status === 'partial'
    && cpp?.positionManager
  )
}

function protocolPositionSubtext(kind: 'lock' | 'control' | 'movement'): string {
  if (kind === 'lock') return 'Standard ERC-20 LP-token lock/burn proof does not apply to this primary pool.'
  if (kind === 'control') return 'Liquidity control requires protocol-specific position checks.'
  return 'ERC-20 LP-token transfers are not the evidence model for this pool.'
}

// ─── Types ────────────────────────────────────────────────────────────────

type Pool = {
  name?: string
  address?: string
  dex?: string | null
  model?: string | null
  price?: number | null
  liquidity?: number | null
  volume24h?: number | null
  priceChange24h?: number | null
  marketCap?: number | null
  fdv?: number | null
  marketCapUsd?: number | null
  fdvUsd?: number | null
  marketCapSource?: 'geckoterminal' | 'coingecko_terminal' | 'computed' | 'none'
  fdvSource?: 'geckoterminal' | 'coingecko_terminal' | 'none'
  circulatingSupply?: number | null
}

type ScanResult = {
  name?: string
  symbol?: string
  contract?: string
  chain?: string
  price?: number | null
  liquidity?: number | null
  volume24h?: number | null
  priceChange24h?: number | null
  marketCap?: number | null
  fdv?: number | null
  marketCapUsd?: number | null
  fdvUsd?: number | null
  marketCapSource?: 'geckoterminal' | 'coingecko_terminal' | 'computed' | 'unavailable'
  marketCapStatus?: string | null
  valuationContext?: {
    primaryValuationLabel: 'Market Cap' | 'Estimated MC' | 'FDV'
    primaryValuationUsd: number | null
    primaryValuationStatus: 'verified_mc' | 'estimated_mc' | 'fdv_only' | 'partial'
    marketCapStatus: 'verified' | 'partial'
    fdvUsd: number | null
    reason: string
  } | null
  fdvSource?: 'geckoterminal' | 'coingecko_terminal' | 'none'
  circulatingSupply?: number | null
  displayMarketValue?: number | null
  displayMarketValueLabel?: 'Market Cap' | 'Estimated MC' | 'FDV'
  displayMarketValueConfidence?: 'verified' | 'medium' | 'low'
  displayMarketValueReason?: string
  estimatedMarketCap?: number | null
  pools?: Pool[]
  selectedPool?: (Pool & { dex?: string | null; model?: string | null }) | null
  contractSecurity?: Record<string, Record<string, unknown>> | null
  analysis?: {
    has_mint?: boolean
    is_upgradeable?: boolean
    has_withdraw?: boolean
    has_sweep?: boolean
  } | null
  honeypot?: {
    isHoneypot: boolean | null
    buyTax: number | null
    sellTax: number | null
    transferTax: number | null
    simulationSuccess: boolean
    // ROBINHOOD-EVIDENCE FIX, DISCLOSED, ADDITIVE: the server already computes these precisely
    // (lib/server/honeypotSecurity.ts's own simulationStatus/honeypotReason) but they previously
    // never reached the client — the whole `honeypot` object collapsed to `null` on any provider
    // failure, discarding the real reason. Optional so no existing reader of this type breaks.
    honeypotStatus?: 'confirmed' | 'unavailable' | 'failed' | 'not_supported' | 'timeout'
    honeypotReason?: string | null
    finalStatus?: string | null
    finalReason?: string | null
  } | null
  tradingSimulationAudit?: TradingSimulationAudit | null
  noActivePools?: boolean
  primaryDexName?: string | null
  marketDataSource?: 'primary' | 'fallback' | 'none'
  marketConfidence?: 'high' | 'medium' | 'low'
  priceSource?: 'dexscreener' | 'coingecko' | 'geckoterminal' | 'fdv_derived' | null
  decimals?: number
  holderDistribution?: { top1:number|null; top5:number|null; top10:number|null; top20:number|null; others:number|null; holderCount:number|null; topHolders:Array<{rank:number;address:string;amount:string|number|null;percent:number|null}> } | null
  holderDistributionStatus?: { source?: string; status?: 'ok'|'partial'|'unavailable_with_reason'|'error'; reason?: string; itemCount?: number; normalizedCount?: number } | null
  debugHolderStatus?: {
    providerCalled?: boolean; chain?: string; endpointPath?: string; authMode?: string;
    hasGoldrushKey?: boolean; hasCovalentKey?: boolean; statusCode?: number|null;
    itemCount?: number; normalizedCount?: number; reason?: string|null;
    responseKeys?: string[]|null; dataKeys?: string[]|null; firstItemKeys?: string[]|null;
  } | null
  sections?: {
    market?: { status?: string; reason?: string; source?: string } | null
    security?: { status?: string; reason?: string; source?: string } | null
    holders?: { status?: string; reason?: string; source?: string } | null
    liquidity?: { status?: string; reason?: string; source?: string; lpMeta?: Record<string, unknown> | null; pool_protocol?: string | null } | null
    contractChecks?: { status?: string; reason?: string; source?: string } | null
  } | null
  lpControl?: {
    status?: string
    confidence?: string
    poolType?: string
    source?: string
    reason?: string
    evidence?: string[]
    poolAddressPresent?: boolean
    selectedPrimaryPoolSource?: string
    dexId?: string
    dexName?: string
    probeV2Like?: boolean
    probeV3Like?: boolean
    lpVerificationPoolReason?: string
    primaryMarketPool?: string | null
    verificationPool?: string | null
    verificationPoolDex?: string | null
    verificationPoolType?: string | null
    primaryPoolDex?: string | null
    primaryPoolType?: string | null
    proofStatus?: 'open_check' | 'verified' | 'not_applicable' | null
    lockStatus?: 'locked' | 'not_confirmed' | 'not_applicable' | null
    burnStatus?: 'burned' | 'not_confirmed' | 'not_applicable' | null
    displayLpModel?: 'erc20_lp_token' | 'concentrated_liquidity' | 'protocol_or_gauge' | 'open_check' | 'no_pool' | null
    lockBurnApplicable?: boolean | null
    lockBurnReason?: string | null
    lpController?: string
    lpControllerType?: 'wallet' | 'contract' | 'burn' | 'lockContract' | 'unknown'
  } | null
  lpControlRead?: {
    title?: string
    meaning?: string
    riskLevel?: string
    whatWasFound?: string[]
    couldNotVerify?: string[]
    nextAction?: string
  } | null
  lpLockStatus?: 'locked' | 'burned' | 'unlocked' | 'unverified'
  lpLockAmount?: number | null
  lpUnlockTime?: number | null
  lpLockProvider?: 'PinkLock' | null
  lpController?: 'wallet' | 'contract' | 'burn' | 'lockContract' | 'unknown'
  lpControllerType?: 'wallet' | 'contract' | 'burn' | 'lockContract' | 'unknown'
  lpProofApplicability?: 'applicable' | 'not_applicable' | 'unknown'
  lpProofStatus?: 'confirmed' | 'partial' | 'missing' | 'not_applicable' | 'unknown'
  lpExitRisk?: 'low' | 'monitor' | 'watch' | 'medium' | 'high' | 'open_check'
  liquidityDepthRisk?: 'low' | 'medium' | 'high' | 'open_check'
  robinhoodLpProofAudit?: RobinhoodLpProofAudit | null
  robinhoodLpResolutionAudit?: RobinhoodLpResolutionAudit | null
  devClusterDiagnosisAudit?: DevClusterDiagnosisAudit | null
  lpExitRiskReason?: string
  lpEvidenceSummary?: string
  lpEvidenceGaps?: Array<{ id: string; label: string; explanation: string; nextAction: string }>
  lpControllerIntel?: {
    status?: string
    controller?: string | null
    controllerType?: string
    controllerLabel?: string
    controllerSharePercent?: number | null
    poolAddress?: string | null
    poolPair?: string | null
    poolLiquidityUsd?: number | null
    controlProof?: string
    lockBurnProof?: string
    exitRisk?: string
    liquidityDepth?: string
    migrationRisk?: string
    confidence?: string
    summary?: string
    signals?: string[]
    evidenceGaps?: string[]
    nextActions?: string[]
    controlProofLabel?: string
  } | null
  concentratedPositionProof?: {
    status?: 'verified' | 'partial' | 'not_found' | 'not_supported' | 'failed' | 'open_check'
    poolModel?: string
    poolAddress?: string | null
    poolId?: string | null
    poolIdentity?: string | null
    poolIdentityType?: 'contract' | 'pool_id' | 'unknown' 
    positionManager?: string | null
    positionCount?: number | null
    topPositionOwner?: string | null
    topPositionOwnerType?: 'wallet' | 'locker' | 'protocol' | 'unknown' | null
    topPositionSharePercent?: number | null
    sampledPositionCount?: number | null
    sampledOwnerCount?: number | null
    sampledOwners?: Array<{ owner?: string | null; ownerType?: string | null; liquidityRaw?: string | number | null; sampledPositionCount?: number | null }>
    topSampledOwner?: string | null
    topSampledOwnerType?: string | null
    topSampledOwnerShareOfSamplePercent?: number | null
    samplingStatus?: 'not_attempted' | 'attempted_no_candidates' | 'sampled_partial' | 'failed' | string
    samplingReason?: string | null
    lockedOrManagedPositionFound?: boolean | null
    controllerRisk?: 'low' | 'watch' | 'caution' | 'high' | 'unknown'
    confidence?: 'high' | 'medium' | 'low'
    reason?: string
    evidence?: string[]
    missingEvidence?: string[]
    nextAction?: string
  } | null
  concentratedPositionProofRead?: {
    summary?: string
    evidenceGaps?: string[]
    whatWasFound?: string[]
    couldNotVerify?: string[]
    nextAction?: string
  } | null
  lpMovementWatch?: {
    status?: string
    movementRisk?: string
    confidence?: string
    controller?: string | null
    controllerType?: string
    lpTokenOrPool?: string | null
    recentMovementDetected?: boolean | null
    recentTransferCount?: number | null
    lastMovementAt?: string | null
    movementTypes?: string[]
    summary?: string
    signals?: string[]
    evidenceGaps?: string[]
    nextActions?: string[]
  } | null
  lpLockBurnIntel?: {
    status?: string
    lockBurnProof?: string
    proofSource?: string | null
    confidence?: string
    chain?: string | null
    poolModel?: string | null
    lpTokenOrPool?: string | null
    lockedPercent?: number | null
    burnedPercent?: number | null
    unlockedPercent?: number | null
    lockContracts?: string[]
    burnAddresses?: string[]
    unlockTime?: string | number | null
    unlockTimeStatus?: string
    summary?: string
    signals?: string[]
    evidenceGaps?: string[]
    nextActions?: string[]
  } | null
  lpUnlockTimeline?: {
    status?: string
    unlockRisk?: string
    confidence?: string
    chain?: string | null
    lpTokenOrPool?: string | null
    unlockTime?: string | number | null
    unlockTimeStatus?: string
    unlockCountdownSeconds?: number | null
    unlockCountdownLabel?: string | null
    lockState?: string | null
    summary?: string
    signals?: string[]
    evidenceGaps?: string[]
    nextActions?: string[]
  } | null
  lpHistoryTimeline?: {
    status?: string
    migrationRisk?: string
    confidence?: string
    chain?: string | null
    poolModel?: string | null
    primaryPool?: string | null
    primaryPair?: string | null
    primaryDex?: string | null
    primaryPoolCreatedAt?: string | null
    primaryPoolAgeLabel?: string | null
    poolCount?: number | null
    observedPoolCount?: number | null
    liquidityUsd?: number | null
    liquidityDistribution?: string
    fragmentation?: string
    events?: string[]
    summary?: string
    signals?: string[]
    evidenceGaps?: string[]
    nextActions?: string[]
  } | null
  secondaryLpExposure?: {
    status?: string
    poolAddress?: string | null
    poolDex?: string | null
    poolType?: string | null
    pair?: string | null
    controller?: string | null
    controllerType?: string
    controllerSharePercent?: number | null
    lockBurnProof?: string
    confidence?: string
    summary?: string
    signals?: string[]
    evidenceGaps?: string[]
    nextActions?: string[]
  } | null
  lpDataMode?: 'resolved' | 'evidence_based' | 'indexed' | 'strict' | 'minimal' | 'fallback' | 'insufficient'
  lpDataModeRaw?: 'strict' | 'minimal' | 'fallback' | 'insufficient'
  lpDataConfidence?: 'high' | 'medium' | 'low' | 'unverified'
  lpModelProof?: {
    model?: 'constant_product' | 'concentrated' | 'stableswap' | 'unknown'
    dexName?: string | null
    standardLockApplies?: boolean
  } | null
  lpMigrationProof?: {
    status?: 'low' | 'watch' | 'flagged' | 'unknown'
    confidence?: 'high' | 'medium' | 'low' | 'unverified'
    reason?: string
    dexsUsed?: string[]
    primaryDex?: string | null
    liquidityDistribution?: string
    signals?: string[]
    missingEvidence?: string[]
    nextAction?: string
  } | null
  cortexLpRead?: {
    mode: string
    confidence: string
    riskSummary: string
    liquidityAnalysis: string
    poolStructureAnalysis: string
    migrationAnalysis: string
    evidenceGaps: string[]
    nextActions: string[]
  } | null
  poolActivity?: {
    transactions24h: number | null
    buys24h: number | null
    sells24h: number | null
    volume24hUsd: number | null
    buyVolume24hUsd: number | null
    sellVolume24hUsd: number | null
    pairCreatedAt: string | null
    pairAgeLabel: string | null
  } | null
  priceChart?: {
    timeframe: '24h' | '48h' | '7d' | '30d'
    points: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume?: number | null; priceUsd: number }>
    sourceStatus: 'ok' | 'partial' | 'error'
    reason?: string
    fallbackUsed?: boolean
  } | null
  chartStatus?: 'ok' | 'snapshot_only' | 'unavailable_with_reason' | 'no_candles' | 'fallback_snapshot_only' | 'partial' | null
  chartSource?: string | null
  chartReason?: string | null
  chartDataSource?: 'primary' | 'fallback' | 'none' | null
  marketTrendSnapshot?: {
    status: 'ok' | 'unavailable'
    source: string
    price: number | null
    changes: Array<{ label: string; value: number | null }>
    liquidity: number | null
    volume24h: number | null
    transactions24h: number | null
    buys24h: number | null
    sells24h: number | null
    pairAge: string | null
  } | null
  resolvedInput?: {
    original: string
    type: 'address' | 'alias' | 'live_search'
    resolvedAddress: string
    symbol?: string
    confidence: 'high' | 'medium' | 'low'
  } | null
  cortexScore?: number | null
  cortexVerdict?: 'Strong' | 'Watch' | 'Caution' | 'High Risk' | 'Open Check'
  cortexConfidence?: 'high' | 'medium' | 'low' | 'insufficient'
  scoreReasons?: string[]
  missingScoreInputs?: string[]
  scoreCoveragePercent?: number
  cortexScoreDebug?: {
    categoryInputs?: Record<string, unknown>
    categoryStatuses?: Record<string, string>
    categoryWeights?: Record<string, number>
    scoreCoveragePercent?: number
    missingInputs?: string[]
    capsApplied?: string[]
    finalScore?: number | null
    finalVerdict?: string
    confidence?: string
  }
  riskScore?: number
  safetyScore?: number
  riskScoreType?: 'risk_score' | 'safety_score'
  riskScoreDirection?: 'higher_is_riskier'
  riskScoreDirectionAudit?: RiskScoreDirectionAudit
  riskLabel?: "extreme" | "high" | "moderate" | "low" | "very_low" | string
  planGate?: { plan?: string; requiredPlan?: string } | null
  scanAudit?: {
    confidenceMissingReason?: string | null
    liquidityMissingReason?: string | null
    runtimeCommitSha?: string | null
    responseWarnings?: string[]
  } | null
  riskBreakdown?: {
    marketMaturity?: {
      score?: number
      max?: number
      components?: Record<string, number>
      reasons?: string[]
    }
    liquiditySafety?: {
      score?: number
      max?: number
      components?: Record<string, number>
      reasons?: string[]
    }
    contractSafety?: {
      score?: number
      max?: number
      components?: Record<string, number>
      reasons?: string[]
    }
    behavioralRisk?: {
      score?: number
      max?: number
      components?: Record<string, number>
      reasons?: string[]
    }
    total?: number
    safetyTotal?: number
  }
  riskEngine?: {
    rugRiskScore: number | null
    rugRiskLabel: "low_visible_risk" | "watch" | "high" | "critical" | "partial_data"
    confidence: "high" | "medium" | "low"
    cortexRead: string
    verifiedSignals: string[]
    riskDrivers: string[]
    openChecks: string[]
    riskScore?: number | null
    riskLabel?: string | null
    scoreDirection?: 'higher_is_riskier'
    riskScoreDirectionAudit?: RiskScoreDirectionAudit
    cortexSafetyScore?: number | null
    cortexSafetyVerdict?: string | null
    cortexScoreType?: 'safety_score'
    cortexScore?: number | null
    cortexVerdict?: 'Strong' | 'Watch' | 'Caution' | 'High Risk' | 'Open Check'
    cortexConfidence?: 'high' | 'medium' | 'low' | 'insufficient'
    scoreReasons?: string[]
    missingScoreInputs?: string[]
    scoreCoveragePercent?: number
    sniperActivity: {
      status: "low_signal" | "watch" | "high" | "not_applicable"
      confidence: "high" | "medium" | "low"
      reasons: string[]
    }
    lpIntelligence?: {
      migrationRisk?: "low" | "medium" | "high" | "inferred"
    }
  } | null
  rugRisk?: {
    lp_safety: { status: string; unlock_at: string | null; countdown_seconds: number | null; owner: string | null; contract: string | null; movement_24h_usd: number | null; source_status: "ok" | "failed" }
    contract_flags: { honeypot: boolean | null; blacklist: boolean | null; mint: boolean | null; upgradeable: boolean | null; source_status: "ok" | "partial" | "failed" }
    deployer_reputation: { score: number | null; rug_history: number | null; deploy_patterns: string[]; source_status: "ok" | "failed" }
    sniper_activity: { level: "low" | "medium" | "high"; score: number; source_status: "ok" | "failed" }
    early_buyers: Array<{ wallet: string; amount_usd: number | null; tx_count: number | null }>
    liquidity_risk: { liquidity_usd: number | null; volatility_24h_pct: number | null; source_status: "ok" | "failed" }
    trading_simulation: { success: boolean | null; buy_tax: number | null; sell_tax: number | null; source_status: "ok" | "failed" }
    risk_drivers: string[]
    overall_rug_risk_score: number | null
  } | null
  contractFlags?: {
    mint: { status: 'verified' | 'possible' | 'not_detected' | 'inferred'; confidence: 'high' | 'medium' | 'low'; note: string | null }
    proxy: { status: 'verified' | 'possible' | 'not_detected' | 'inferred'; confidence: 'high' | 'medium' | 'low'; note: string | null }
    pause: { status: 'verified' | 'possible' | 'not_detected' | 'inferred'; confidence: 'high' | 'medium' | 'low'; note: string | null }
    blacklist: { status: 'verified' | 'possible' | 'not_detected' | 'inferred'; confidence: 'high' | 'medium' | 'low'; note: string | null }
    withdraw: { status: 'verified' | 'possible' | 'not_detected' | 'inferred'; confidence: 'high' | 'medium' | 'low'; note: string | null }
    bytecodeChecked: boolean
    proxySlotChecked: boolean
    pauseCallChecked: boolean
  } | null
  lpMeta?: {
    v2PoolCandidatesCount?: number | null
    protocolPoolCandidatesCount?: number | null
    lpProofSkipReason?: string | null
    lpProofUnavailableReason?: string | null
    primaryMarketType?: string | null
    primaryMarketDex?: string | null
    lpVerificationPoolSelected?: boolean | null
    lpControlState?: string | null
    concentratedProofEligible?: boolean | null
    concentratedProofAttempted?: boolean | null
  } | null
  devIntel?: DevWalletIntel | null
  security?: {
    simulation?: {
      honeypot: boolean | null
      buyTax: number | null
      sellTax: number | null
      transferTax: number | null
      transferOK: boolean | null
      simulationSuccess: boolean | null
      source: string
    } | null
    contractFlags?: {
      mint: boolean | null
      blacklist: boolean | null
      pause: boolean | null
      withdraw: boolean | null
      proxy: boolean | null
    } | null
    devOwnership?: {
      ownerAddress: string | null
      adminAddress: string | null
      isRenounced: boolean
      ownershipVerified: boolean
    } | null
  } | null
  projectSocials?: {
    website: string | null
    twitter: string | null
    telegram: string | null
    discord: string | null
    github: string | null
    sourceTrail: string[]
    status: 'verified' | 'partial' | 'unavailable_with_reason'
    reason?: string
  } | null
}

type ClusterNode = {
  id: string
  address: string
  label: string
  type: 'deployer' | 'linked_wallet' | 'cluster_wallet' | 'holder_wallet'
  supplyPercent: number | null
  rank: number | null
  confidence: 'high' | 'medium' | 'low' | 'open_check'
  isCreator: boolean
  isLinked: boolean
  isCluster: boolean
  reasons: string[]
}

type ClusterEdge = {
  id?: string
  source?: string | null
  target?: string | null
  from?: string | null
  to?: string | null
  type?: string | null
  weight?: number | string | null
  confidence?: 'high' | 'medium' | 'low' | string | null
  reason?: string | null
}

type GraphEdge = {
  id: string
  source: string
  target: string
  type: string
  weight: number
  confidence: 'high' | 'medium' | 'low'
  reason: string
  color: string
  opacity: number
  width: number
}


type WalletBehaviorLabel = 'accumulator' | 'distributor' | 'wash-pattern' | 'funding-relay' | 'cluster-feeder' | 'neutral' | 'open-check'
type BehaviorConfidence = 'high' | 'medium' | 'low' | 'open_check'
type WalletBehavior = { label: WalletBehaviorLabel; confidence: BehaviorConfidence; reasons: string[] }
type ClusterTimelineEvent = {
  id: string
  label: string
  description: string
  timestamp: string | null
  order: number
  type: 'deployer_resolved' | 'linked_wallet_detected' | 'supply_confirmed' | 'cluster_edge_detected' | 'suspicious_burst' | 'open_check'
  severity: 'low' | 'medium' | 'high' | 'open_check'
  relatedWallets: string[]
}
type ClusterTimeline = { status: CanonicalStatus; mode: 'timestamped' | 'ordered' | 'open_check'; events: ClusterTimelineEvent[] }
type DeployerLineage = {
  status: CanonicalStatus
  deployer: ClusterNode | null
  directLinkedWallets: ClusterNode[]
  secondLayerWallets: ClusterNode[]
  relatedHolderWallets: ClusterNode[]
  lineageEdges: GraphEdge[]
  summary: {
    directLinks: number
    secondLayerLinks: number
    suspiciousLinks: number
    linkedSupplyPercent: number | null
    clusterSupplyPercent: number | null
    riskLabel: string
    reason: string
  }
}

const SUSPICIOUS_EDGE_TERMS = /suspicious|repeated|same-?size|funding|relay|wash|control|cluster|burst/i
const TRANSFER_TERMS = /transfer|fund|sent|received|inbound|outbound|distributed|relay|source|passed through/i
const WASH_TERMS = /back-and-forth|repeated|same-?size|loop|wash/i
const DISTRIBUTOR_TERMS = /outbound|distributed|sent|transfer out|funded wallets/i
const ACCUMULATOR_TERMS = /receive|inbound|accumulation|funded|received/i
const FEEDER_TERMS = /feed|funded|distributed|split/i

function isSuspiciousGraphEdge(edge: Pick<GraphEdge, 'type' | 'reason'>): boolean {
  const type = (edge.type ?? '').toLowerCase()
  return /suspicious|transfer|shared_pattern|shared-pattern/.test(type) || SUSPICIOUS_EDGE_TERMS.test(edge.reason ?? '')
}

function behaviorTitle(label: WalletBehaviorLabel): string {
  switch (label) {
    case 'wash-pattern': return 'Wash-pattern signal'
    case 'funding-relay': return 'Funding relay'
    case 'cluster-feeder': return 'Cluster feeder'
    case 'open-check': return 'Open check'
    default: return label.charAt(0).toUpperCase() + label.slice(1)
  }
}

function behaviorBadgeMeta(label: WalletBehaviorLabel): { badge: string; color: string; bg: string } | null {
  switch (label) {
    case 'accumulator': return { badge: 'A', color: '#34d399', bg: 'rgba(52,211,153,.18)' }
    case 'distributor': return { badge: 'D', color: '#60a5fa', bg: 'rgba(96,165,250,.18)' }
    case 'wash-pattern': return { badge: 'W', color: '#fb7185', bg: 'rgba(251,113,133,.2)' }
    case 'funding-relay': return { badge: 'R', color: '#fbbf24', bg: 'rgba(251,191,36,.18)' }
    case 'cluster-feeder': return { badge: 'F', color: '#c084fc', bg: 'rgba(192,132,252,.18)' }
    case 'open-check': return { badge: '?', color: '#a78bfa', bg: 'rgba(167,139,250,.16)' }
    default: return null
  }
}

function confidenceRank(confidence: GraphEdge['confidence'] | ClusterNode['confidence']): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : confidence === 'low' ? 1 : 0
}

function confidenceLabel(confidence: BehaviorConfidence): string {
  return confidence === 'open_check' ? 'Open check' : confidence.charAt(0).toUpperCase() + confidence.slice(1)
}

function edgeSeverity(edge: GraphEdge): ClusterTimelineEvent['severity'] {
  if (isSuspiciousGraphEdge(edge) && (edge.weight >= 61 || edge.confidence === 'high')) return 'high'
  if (edge.weight >= 61 || edge.confidence === 'high') return 'medium'
  if (edge.weight >= 31 || edge.confidence === 'medium') return 'medium'
  return 'low'
}

function eventSeverityColor(severity: ClusterTimelineEvent['severity']): string {
  return severity === 'high' ? '#fb7185' : severity === 'medium' ? '#fbbf24' : severity === 'low' ? '#7dd3fc' : '#a78bfa'
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values())
}

function deriveWalletBehavior(node: ClusterNode, relatedEdges: GraphEdge[], allNodes: ClusterNode[], suspiciousTransferPattern: boolean, influenceSignals: string[]): WalletBehavior {
  const reasons = [...(node.reasons ?? []), ...relatedEdges.map((edge) => edge.reason), ...influenceSignals]
  const reasonText = reasons.join(' ').toLowerCase()
  const strongEdges = relatedEdges.filter((edge) => edge.weight >= 60 || edge.confidence === 'high')
  const suspiciousEdges = relatedEdges.filter(isSuspiciousGraphEdge)
  const repeatedEdges = relatedEdges.filter((edge) => WASH_TERMS.test(edge.reason))
  const neighborNodes = relatedEdges.map((edge) => allNodes.find((candidate) => candidate.id === (edge.source === node.id ? edge.target : edge.source))).filter(Boolean) as ClusterNode[]
  const deployerEdge = relatedEdges.some((edge) => neighborNodes.some((neighbor) => neighbor.type === 'deployer' && (edge.source === neighbor.id || edge.target === neighbor.id)))
  const clusterOrHolderEdge = neighborNodes.some((neighbor) => neighbor.type === 'cluster_wallet' || neighbor.type === 'holder_wallet' || neighbor.isCluster)
  const linkedOrClusterEdges = relatedEdges.filter((edge) => {
    const other = allNodes.find((candidate) => candidate.id === (edge.source === node.id ? edge.target : edge.source))
    return other?.type === 'linked_wallet' || other?.type === 'cluster_wallet' || other?.isCluster
  })
  const outgoingStyle = relatedEdges.filter((edge) => edge.source === node.id || DISTRIBUTOR_TERMS.test(edge.reason))
  const incomingStyle = relatedEdges.filter((edge) => edge.target === node.id || ACCUMULATOR_TERMS.test(edge.reason))

  if ((suspiciousTransferPattern && repeatedEdges.length > 0) || repeatedEdges.length >= 2 || (suspiciousEdges.length >= 2 && WASH_TERMS.test(reasonText))) {
    return {
      label: 'wash-pattern',
      confidence: suspiciousTransferPattern && repeatedEdges.some((edge) => /repeated|same-?size/i.test(edge.reason)) ? 'high' : repeatedEdges.length > 0 ? 'medium' : 'low',
      reasons: ['Wash-pattern signal only: repeated or same-size transfer wording appears in existing evidence.', ...(suspiciousTransferPattern ? ['Suspicious transfer pattern is present in this pass.'] : []), ...(repeatedEdges[0]?.reason ? [repeatedEdges[0].reason] : [])].slice(0, 3),
    }
  }
  if ((node.type === 'linked_wallet' || node.isLinked) && ((deployerEdge && clusterOrHolderEdge) || /funding|relay|source|passed through/i.test(reasonText))) {
    return {
      label: 'funding-relay',
      confidence: deployerEdge && clusterOrHolderEdge && strongEdges.some((edge) => TRANSFER_TERMS.test(edge.reason) || /transfer|deployer_to_linked/.test(edge.type)) ? 'high' : deployerEdge && clusterOrHolderEdge ? 'medium' : 'low',
      reasons: ['Funding relay pattern: wallet sits between deployer and cluster/holder evidence.', ...(relatedEdges.find((edge) => /funding|relay|source|passed through|transfer/i.test(edge.reason))?.reason ? [relatedEdges.find((edge) => /funding|relay|source|passed through|transfer/i.test(edge.reason))!.reason] : []), 'No new backend data was used.'].slice(0, 3),
    }
  }
  if (linkedOrClusterEdges.length >= 2 && (FEEDER_TERMS.test(reasonText) || outgoingStyle.length >= 2)) {
    return {
      label: 'cluster-feeder',
      confidence: linkedOrClusterEdges.length >= 3 && strongEdges.length >= 2 ? 'high' : linkedOrClusterEdges.length >= 2 ? 'medium' : 'low',
      reasons: ['Cluster feeder signal: wallet connects to multiple linked or cluster wallets.', ...(relatedEdges.find((edge) => FEEDER_TERMS.test(edge.reason))?.reason ? [relatedEdges.find((edge) => FEEDER_TERMS.test(edge.reason))!.reason] : []), `${linkedOrClusterEdges.length} linked/cluster-style edges touch this wallet.`].slice(0, 3),
    }
  }
  if (DISTRIBUTOR_TERMS.test(reasonText) || (node.type === 'deployer' && outgoingStyle.length >= 2) || outgoingStyle.length >= 3) {
    return {
      label: 'distributor',
      confidence: strongEdges.length >= 2 ? 'high' : strongEdges.length >= 1 || outgoingStyle.length >= 2 ? 'medium' : 'low',
      reasons: ['Distributor signal: wallet shows outbound-style transfer links to one or more wallets.', ...(relatedEdges.find((edge) => DISTRIBUTOR_TERMS.test(edge.reason))?.reason ? [relatedEdges.find((edge) => DISTRIBUTOR_TERMS.test(edge.reason))!.reason] : []), ...(node.type === 'deployer' ? ['Deployer/origin wallet has linked wallet edges in this pass.'] : [])].slice(0, 3),
    }
  }
  if ((node.supplyPercent ?? 0) > 0 || ACCUMULATOR_TERMS.test(reasonText) || incomingStyle.length > 0) {
    return {
      label: 'accumulator',
      confidence: incomingStyle.some((edge) => edge.confidence === 'high') ? 'high' : ACCUMULATOR_TERMS.test(reasonText) || incomingStyle.length > 0 ? 'medium' : 'low',
      reasons: [(node.supplyPercent ?? 0) > 0 ? `Accumulator signal: wallet holds ${node.supplyPercent?.toFixed(1)}% of supply in indexed holder data.` : 'Accumulator signal: inbound/received wording appears in existing edge evidence.', ...(relatedEdges.find((edge) => ACCUMULATOR_TERMS.test(edge.reason))?.reason ? [relatedEdges.find((edge) => ACCUMULATOR_TERMS.test(edge.reason))!.reason] : []), 'Holding alone is not treated as suspicious.'].slice(0, 3),
    }
  }
  // BEHAVIOR-PATTERN FIX, DISCLOSED: this used to be an OR — no edges AND (no supply OR
  // unconfirmed node identity) — so a confirmed, HIGH-confidence deployer/linked wallet with
  // simply no supply-percent reading (common: deployers often don't hold tokens themselves)
  // still got forced to "open-check" behavior, discarding a fully confirmed identity. "Open check"
  // should mean we don't know who/what this wallet is; a confirmed wallet with no behavior signal
  // this pass is "neutral", not unknown. Only fall to open-check when nothing is known on any axis.
  if (relatedEdges.length === 0 && node.supplyPercent == null && node.confidence === 'open_check') {
    return { label: 'open-check', confidence: 'open_check', reasons: ['No edges, supply position, or behavior pattern confirmed in this pass.'] }
  }
  const neutralSubject = node.type === 'deployer' ? 'this deployer' : node.type === 'linked_wallet' ? 'this linked wallet' : node.type === 'cluster_wallet' ? 'this cluster wallet' : 'this holder'
  return { label: 'neutral', confidence: node.confidence === 'open_check' ? 'open_check' : 'low', reasons: [`Neutral — no transfer behavior pattern confirmed for ${neutralSubject} in this pass.`] }
}

type ClusterMap = {
  status: CanonicalStatus
  nodes: ClusterNode[]
  edges: ClusterEdge[]
  summary: {
    totalNodes: number
    totalEdges: number
    deployerAddress: string | null
    linkedWalletCount: number
    clusterWalletCount: number
    holderWalletCount: number
    clusterSupplyPercent: number | null
    clusterDominance: 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown'
    clusterRiskScore: number | null
    clusterRiskLabel: 'low' | 'watch' | 'elevated' | 'high' | 'critical' | 'open_check'
    reason: string
  }
  signals: string[]
}

type ClusterInfluence = {
  clusterSupplyPercent?: number | null
  clusterDominance?: "none" | "low" | "medium" | "high" | "critical" | "unknown"
  clusterRiskScore?: number | null
  clusterRiskLabel?: "low" | "watch" | "elevated" | "high" | "critical" | "open_check"
  reason?: string | null
  signals?: string[]
}

type DevWalletIntel = {
  deployerAddress?: string | null
  deployerStatus?: 'confirmed' | 'possible_match' | 'not_confirmed' | string
  // RICHER-LINKED-WALLET-FIELDS, DISCLOSED (deployer wallet detail fix): /api/dev-wallet's own
  // LinkedWallet already carries amountReceived/firstSeen/txHash — previously dropped at the client
  // type boundary so the UI only ever saw a bare reason string. Optional, additive fields only.
  linkedWallets?: Array<{ address: string; reason?: string | null; confidence?: string | null; amountReceived?: number | null; asset?: string | null; firstSeen?: string | null; txHash?: string | null }>
  // RELATED-DEPLOYMENTS FIELDS, DISCLOSED (deployer wallet detail fix): /api/dev-wallet already
  // returns previousProjects (the deployer's other deployed contracts) — never previously reached
  // this client type, so "Check Related Deployments" had no data to render.
  previousActivityAvailable?: boolean | null
  previousActivityStatus?: string | null
  previousProjects?: Array<{ contractAddress: string; name: string | null; symbol: string | null; createdAt: string | null; rugFlag: boolean | null }>
  linkedWalletSupply?: number | null
  linkedWalletSupplyPercent?: number | null
  devClusterSupply?: number | null
  devClusterSupplyPercent?: number | null
  matchedLinkedWallets?: Array<{ address: string; percent: number | null; rank: number | null; confidence: string }>
  creatorInTopHolders?: boolean | null
  holderDistribution?: { top1?: number | null; top10?: number | null; top20?: number | null; holderCount?: number | null; topHolders?: Array<{ rank?: number | null; address?: string | null; percent?: number | null }> } | null
  holderDistributionStatus?: string | null
  holderPercentAvailable?: boolean
  holderPercentSource?: string | null
  suspiciousTransfers?: boolean
  suspiciousTransferReasons?: string[]
  clusterInfluence?: ClusterInfluence | null
  clarkVerdict?: { bullets?: string[]; summary?: string } | null
  reasons?: string[]
  confidence?: string
  clusterMap?: ClusterMap | null
  factoryAddress?: string | null
  originAddress?: string | null
  devClusterDiagnosisAudit?: DevClusterDiagnosisAudit | null
  supplyControl?: {
    creatorInTopHolders: boolean | null
    creatorHolderRank: number | null
    creatorHolderPercent: number | null
    linkedWalletSupplyPercent: number | null
    linkedWalletSupplyStatus: string
    devClusterSupplyPercent: number | null
    devClusterSupplyStatus: string
    devClusterSupplyReason: string
    matchedLinkedWallets: Array<{ address: string; percent: number | null; rank: number | null; confidence: string }>
    clusterInfluence?: ClusterInfluence | null
  } | null
}

type SignalState = 'verified' | 'inferred' | 'partial' | 'not_applicable' | 'needs_holder_confirmation' | 'no_signal_from_available_data'

type HolderRow = { rank:number;address:string;amount:string|number|null;percent:number|null }
type HolderStateKind = 'rowsWithPercent' | 'rowsWithoutPercent' | 'noRowsFallback'
type HolderProviderStatus = 'ok' | 'partial' | 'unavailable_with_reason' | 'error' | 'unknown'
type OwnerStatus = 'Renounced' | 'Held' | 'Open check'
type SecurityChip = { label: string; displayLabel: string; style: PillStyle; source: 'honeypot' | 'contract' }

type HolderFallbackEvidence = {
  ownerStatus: OwnerStatus
  poolCount: number
  liquidityDepth: number | null
  marketCapToFdvPct: number | null
  marketCapToFdvLabel: string
  holderConcentration: string
  supplySpread: string
  providerReturnedNoRows: boolean
}

type DerivedHolderState = {
  kind: HolderStateKind
  providerStatus: HolderProviderStatus
  safeReason: string
  rows: HolderRow[]
  hasPercentages: boolean
}

type VerdictInput = {
  hasMarketData: boolean
  hasSecurityData: boolean
  hasLiquidityData: boolean
  holderState: DerivedHolderState
  fallbackEvidence: HolderFallbackEvidence
  dedupedSecurityChips: SecurityChip[]
  supports: Array<'verdict'|'marketRead'|'securityRead'|'holderSupplyRead'|'liquidityPoolsRead'|'bullCase'|'bearCase'|'missingChecks'|'nextAction'>
}

const formatSignalStateLabel = (state: SignalState): string => {
  switch (state) {
    case 'needs_holder_confirmation':
      return 'Needs holder confirmation'
    case 'no_signal_from_available_data':
      return 'No signal from available data'
    case 'not_applicable':
      return 'Not applicable'
    case 'partial':
      return 'Partial'
    case 'inferred':
      return 'Inferred'
    case 'verified':
      return 'Verified'
    default:
      return 'No signal from available data'
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────

function chainDisplayName(chain: string | null | undefined): string {
  return chain === 'eth' ? 'Ethereum' : chain === 'bnb' ? 'BNB Chain' : chain === 'robinhood' ? 'Robinhood Chain' : 'Base'
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null || v <= 0) return 'N/A'
  if (v < 0.001) {
    // Dynamically scale decimal places to show ~3 significant figures, never scientific notation
    const exp = Math.floor(Math.log10(v))      // e.g. -10 for 2.35e-10
    const decimals = Math.min(-exp + 2, 20)    // e.g. 12 decimal places
    return `$${v.toFixed(decimals)}`
  }
  if (v < 1) return `$${v.toFixed(6)}`
  return `$${v.toFixed(4)}`
}

function fmtLarge(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

// Converts a raw ERC-20 balance (in smallest units) to a compact human-readable amount.
// e.g. 9.08e26 with decimals=18 → 908.23M
function fmtTokenAmt(raw: string | number | null, decimals: number): string {
  if (raw == null) return '—'
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const tok = n / Math.pow(10, decimals)
  if (tok >= 1e12) return `${(tok / 1e12).toFixed(2)}T`
  if (tok >= 1e9)  return `${(tok / 1e9).toFixed(2)}B`
  if (tok >= 1e6)  return `${(tok / 1e6).toFixed(2)}M`
  if (tok >= 1e3)  return `${(tok / 1e3).toFixed(2)}K`
  return tok.toFixed(2)
}

function pctColor(v: number | null | undefined): string {
  if (v == null) return '#94a3b8'
  return v >= 0 ? '#2DD4BF' : '#f87171'
}

function MiniPriceChart({ points }: { points: Array<{ timestamp: string; priceUsd: number }> }) {
  if (points.length < 2) return null
  const w = 960
  const h = 360
  const padX = 30
  const padY = 32
  const min = Math.min(...points.map((p) => p.priceUsd))
  const max = Math.max(...points.map((p) => p.priceUsd))
  const spread = Math.max(max - min, 1e-12)
  const yFor = (v: number) => h - padY - ((v - min) / spread) * (h - padY * 2)
  const xFor = (i: number) => padX + (i / (points.length - 1)) * (w - padX * 2)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const d = points.map((p, i) => {
    const x = xFor(i)
    const y = yFor(p.priceUsd)
    return `${i === 0 ? 'M' : 'L'}${x},${y}`
  }).join(' ')
  const area = `${d} L ${xFor(points.length - 1)},${h - padY} L ${xFor(0)},${h - padY} Z`
  const last = points[points.length - 1]
  const lastX = xFor(points.length - 1)
  const lastY = yFor(last.priceUsd)
  const hoverPoint = hoverIndex != null ? points[hoverIndex] : null
  const hoverX = hoverIndex != null ? xFor(hoverIndex) : null
  const hoverY = hoverPoint ? yFor(hoverPoint.priceUsd) : null
  const startTs = new Date(points[0].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const endTs = new Date(last.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const priceDeltaPct = points[0].priceUsd > 0
    ? ((last.priceUsd - points[0].priceUsd) / points[0].priceUsd) * 100
    : null
  const guideRows = [0, 0.25, 0.5, 0.75, 1].map((r) => padY + r * (h - padY * 2))
  const onMove = (clientX: number, rect: DOMRect) => {
    const relativeX = Math.max(padX, Math.min(clientX - rect.left, w - padX))
    const ratio = (relativeX - padX) / (w - padX * 2)
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))))
    setHoverIndex(idx)
  }

  return (
    <div
      style={{ position: 'relative' }}
      onMouseLeave={() => setHoverIndex(null)}
      onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
      onTouchMove={(e) => onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
      onTouchStart={(e) => onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
    >
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'clamp(260px, 34vw, 360px)', display: 'block' }}>
        <defs>
          <linearGradient id="clLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2dd4bf" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
          <linearGradient id="clFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(45,212,191,0.42)" />
            <stop offset="100%" stopColor="rgba(167,139,250,0.01)" />
          </linearGradient>
          <filter id="clGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {guideRows.map((y) => <line key={y} x1={padX} y1={y} x2={w - padX} y2={y} stroke="rgba(148,163,184,0.24)" strokeWidth="1" />)}
        <path d={area} fill="url(#clFill)" />
        <path d={d} fill="none" stroke="url(#clLine)" strokeWidth="3.2" strokeLinejoin="round" strokeLinecap="round" filter="url(#clGlow)" />
        <circle cx={lastX} cy={lastY} r="5.4" fill="#e2e8f0" />
        <circle cx={lastX} cy={lastY} r="10" fill="rgba(226,232,240,0.16)" />
        {hoverX != null && hoverY != null && hoverPoint && (
          <>
            <line x1={hoverX} y1={padY} x2={hoverX} y2={h - padY} stroke="rgba(148,163,184,0.34)" strokeDasharray="4 4" />
            <circle cx={hoverX} cy={hoverY} r="4.8" fill="#c4b5fd" />
          </>
        )}
        <text x={padX} y={20} fill="#94a3b8" style={{ fontSize: 12 }}>Low {fmtPrice(min)}</text>
        <text x={w - padX} y={20} textAnchor="end" fill="#94a3b8" style={{ fontSize: 12 }}>High {fmtPrice(max)}</text>
      </svg>
      <div style={{ position: 'absolute', top: '12px', right: '12px', border: '1px solid rgba(167,139,250,0.5)', background: 'rgba(15,23,42,0.82)', borderRadius: '999px', padding: '6px 10px', color: '#e2e8f0', fontSize: '11px', fontWeight: 700 }}>
        Latest {fmtPrice(last.priceUsd)}
      </div>
      {hoverPoint && (
        <div style={{ position: 'absolute', left: '12px', bottom: '12px', border: '1px solid rgba(45,212,191,0.36)', background: 'rgba(2,6,23,0.88)', borderRadius: '10px', padding: '7px 10px', color: '#cbd5e1', fontSize: '11px' }}>
          <div>{new Date(hoverPoint.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          <div style={{ color: '#99f6e4', fontWeight: 700 }}>{fmtPrice(hoverPoint.priceUsd)}</div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: '#94a3b8', marginTop: '6px' }}>
        <span>{startTs}</span>
        <span style={{ color: priceDeltaPct == null ? '#94a3b8' : priceDeltaPct >= 0 ? '#2dd4bf' : '#f87171' }}>
          {priceDeltaPct == null ? '24h Δ N/A' : `24h Δ ${fmtPct(priceDeltaPct)}`}
        </span>
        <span>{endTs}</span>
      </div>
    </div>
  )
}

type OhlcCandle = { timestamp: string; open: number; high: number; low: number; close: number; volume?: number | null; priceUsd: number }

function CandlestickChart({ candles, timeframe, isFlatSeries = false }: { candles: OhlcCandle[]; timeframe: string; isFlatSeries?: boolean }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const MAX_CANDLES = 80
  const raw = candles.filter(c => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.high >= c.low)
  const data = raw.slice(-MAX_CANDLES)
  if (data.length < 2) return null

  const W = 960
  const padX = 8
  const padTop = 26
  const priceAreaH = 254
  const volAreaH = 44
  const volGap = 6
  const priceTop = padTop
  const priceBot = padTop + priceAreaH
  const volTop = priceBot + volGap
  const volBot = volTop + volAreaH
  const H = volBot + 4   // 334

  const allHighs = data.map(c => c.high)
  const allLows  = data.map(c => c.low)
  const priceMax = Math.max(...allHighs)
  const priceMin = Math.min(...allLows)
  const spread   = Math.max(priceMax - priceMin, priceMin * 0.001, 1e-12)
  const pricePad  = spread * 0.06
  const dispMax  = priceMax + pricePad
  const dispMin  = priceMin - pricePad
  const dispSpread = dispMax - dispMin
  const yP = (v: number) => priceTop + ((dispMax - v) / dispSpread) * priceAreaH

  const n      = data.length
  const slotW  = (W - padX * 2) / n
  const bodyW  = Math.max(2, slotW * 0.68)
  const wickW  = Math.max(1, Math.min(1.5, slotW * 0.14))
  const xC     = (i: number) => padX + (i + 0.5) * slotW

  const hasVolume = data.some(c => (c.volume ?? 0) > 0)
  const maxVol    = hasVolume ? Math.max(...data.map(c => c.volume ?? 0)) : 0

  const first = data[0]
  const last  = data[n - 1]
  const deltaPct = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : null

  const hoverCandle = hoverIdx != null ? data[hoverIdx] : null

  const guideYs = [0, 0.25, 0.5, 0.75, 1].map(r => priceTop + r * priceAreaH)

  const onMove = (clientX: number, rect: DOMRect) => {
    const svgX = (clientX - rect.left) * (W / rect.width)
    setHoverIdx(Math.max(0, Math.min(n - 1, Math.floor((svgX - padX) / slotW))))
  }

  const flatLinePath = isFlatSeries ? data.map((c, i) => `${i === 0 ? 'M' : 'L'}${xC(i).toFixed(1)},${yP(c.close).toFixed(1)}`).join(' ') : ''
  const flatAreaPath = isFlatSeries ? `${flatLinePath} L${xC(n - 1).toFixed(1)},${priceBot} L${xC(0).toFixed(1)},${priceBot} Z` : ''

  const fmtTs = (ts: string) => {
    const d = new Date(ts)
    if (timeframe === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (timeframe === '30d') return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    const diffDays = (Date.now() - d.getTime()) / 86400000
    return diffDays < 2
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <div style={{ position: 'relative' }}
      onMouseLeave={() => setHoverIdx(null)}
      onMouseMove={e => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
      onTouchMove={e => onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
      onTouchStart={e => onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'clamp(240px, 32vw, 340px)', display: 'block' }}>
        <defs>
          <clipPath id="ccPriceClip"><rect x={padX} y={priceTop} width={W - padX * 2} height={priceAreaH} /></clipPath>
          <clipPath id="ccVolClip"><rect x={padX} y={volTop} width={W - padX * 2} height={volAreaH} /></clipPath>
          {isFlatSeries && (
            <linearGradient id="fsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(0,255,255,0.18)" />
              <stop offset="60%" stopColor="rgba(0,255,255,0.06)" />
              <stop offset="100%" stopColor="rgba(0,255,255,0.00)" />
            </linearGradient>
          )}
          {isFlatSeries && (
            <filter id="fsGlow" x="-8%" y="-200%" width="116%" height="500%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          )}
        </defs>
        {isFlatSeries && (
          <style>{`@keyframes fsBreath{0%,100%{opacity:.45}50%{opacity:.78}}`}</style>
        )}

        {/* Horizontal grid */}
        {isFlatSeries
          ? [0.12, 0.5, 0.88].map((r, i) => (
              <line key={i} x1={padX} y1={priceTop + r * priceAreaH} x2={W - padX} y2={priceTop + r * priceAreaH} stroke="rgba(45,212,191,0.08)" strokeWidth="1" />
            ))
          : guideYs.map((y, i) => (
              <line key={i} x1={padX} y1={y} x2={W - padX} y2={y} stroke="rgba(148,163,184,0.12)" strokeWidth="1" />
            ))
        }
        {isFlatSeries && [1 / 3, 2 / 3].map((r, i) => (
          <line key={i} x1={padX + r * (W - padX * 2)} y1={priceTop} x2={padX + r * (W - padX * 2)} y2={priceBot} stroke="rgba(45,212,191,0.06)" strokeWidth="1" />
        ))}

        {/* Candles (normal) or flat-series area+line */}
        {isFlatSeries ? (
          <g clipPath="url(#ccPriceClip)">
            <path d={flatAreaPath} fill="url(#fsGrad)" style={{ animation: 'fsBreath 1.5s ease-in-out infinite' }} />
            <path d={flatLinePath} fill="none" stroke="rgba(0,255,255,0.72)" strokeWidth="2" filter="url(#fsGlow)" style={{ animation: 'fsBreath 1.5s ease-in-out infinite' }} />
            {/* Watermark */}
            <text x={padX + 8} y={priceBot - 12} fill="rgba(45,212,191,0.20)" style={{ fontSize: 11, letterSpacing: '0.04em', fontFamily: 'sans-serif' }}>
              No verified price history — showing live price only
            </text>
            {/* Hover highlight dot */}
            {hoverIdx != null && (
              <circle cx={xC(hoverIdx)} cy={yP(data[hoverIdx].close)} r="4" fill="rgba(0,255,255,0.8)" filter="url(#fsGlow)" />
            )}
          </g>
        ) : (
          <g clipPath="url(#ccPriceClip)">
            {data.map((c, i) => {
              const x     = xC(i)
              const bull  = c.close >= c.open
              const clr   = bull ? '#2dd4bf' : '#f87171'
              const yH    = yP(c.high)
              const yL    = yP(c.low)
              const yO    = yP(c.open)
              const yCl   = yP(c.close)
              const bTop  = Math.min(yO, yCl)
              const bBot  = Math.max(yO, yCl)
              const bH    = Math.max(2, bBot - bTop)
              return (
                <g key={i} opacity={hoverIdx != null && i !== hoverIdx ? 0.55 : 1}>
                  <line x1={x} y1={yH} x2={x} y2={yL} stroke={clr} strokeWidth={wickW} />
                  <rect x={x - bodyW / 2} y={bTop} width={bodyW} height={bH} fill={clr} opacity={bull ? 0.88 : 0.82} rx={slotW > 10 ? 1 : 0} />
                </g>
              )
            })}
          </g>
        )}

        {/* Hover crosshairs */}
        {hoverIdx != null && (() => {
          const hx = xC(hoverIdx)
          return <>
            <line x1={hx} y1={priceTop} x2={hx} y2={priceBot} stroke="rgba(148,163,184,0.38)" strokeDasharray="3 3" strokeWidth="1" />
            {hoverCandle && <line x1={padX} y1={yP(hoverCandle.close)} x2={W - padX} y2={yP(hoverCandle.close)} stroke="rgba(148,163,184,0.22)" strokeDasharray="3 3" strokeWidth="1" />}
          </>
        })()}

        {/* Volume bars (hidden for flat-series) */}
        {!isFlatSeries && hasVolume && (
          <g clipPath="url(#ccVolClip)">
            {data.map((c, i) => {
              const vol = c.volume ?? 0
              if (!vol || !maxVol) return null
              const bH = (vol / maxVol) * volAreaH
              return (
                <rect key={i} x={xC(i) - bodyW / 2} y={volBot - bH} width={bodyW} height={bH}
                  fill={c.close >= c.open ? 'rgba(45,212,191,0.32)' : 'rgba(248,113,113,0.32)'} />
              )
            })}
          </g>
        )}

        {/* Price labels */}
        <text x={padX + 2} y={priceTop - 6} fill="#475569" style={{ fontSize: 11 }}>H {fmtPrice(priceMax)}</text>
        <text x={W - padX - 2} y={priceTop - 6} textAnchor="end" fill="#475569" style={{ fontSize: 11 }}>L {fmtPrice(priceMin)}</text>
        {hasVolume && <text x={padX + 2} y={volTop + 12} fill="#334155" style={{ fontSize: 9.5, letterSpacing: '0.08em' }}>VOL</text>}
      </svg>

      {/* Latest price badge */}
      <div style={{ position: 'absolute', top: '8px', right: '10px', border: '1px solid rgba(167,139,250,0.46)', background: 'rgba(15,23,42,0.84)', borderRadius: '999px', padding: '4px 10px', color: '#e2e8f0', fontSize: '11px', fontWeight: 700, pointerEvents: 'none' }}>
        {fmtPrice(last.close)}
      </div>

      {/* Hover tooltip */}
      {hoverCandle && (
        <div style={{ position: 'absolute', left: '10px', bottom: '28px', border: `1px solid ${isFlatSeries ? 'rgba(0,255,255,0.28)' : 'rgba(45,212,191,0.32)'}`, background: 'rgba(2,6,23,0.92)', borderRadius: '10px', padding: '8px 11px', pointerEvents: 'none', zIndex: 2, minWidth: '130px' }}>
          <div style={{ color: '#64748b', fontSize: '10px', marginBottom: '5px' }}>{fmtTs(hoverCandle.timestamp)}</div>
          {isFlatSeries ? (
            <>
              <div style={{ fontSize: '11px', color: 'rgba(0,255,255,0.8)', fontWeight: 700 }}>{fmtPrice(hoverCandle.close)}</div>
              <div style={{ fontSize: '9px', color: '#475569', marginTop: '4px', letterSpacing: '0.06em' }}>Live price only (synthetic flat series)</div>
            </>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', fontSize: '11px', color: '#cbd5e1' }}>
              <span style={{ color: '#475569' }}>O</span><span>{fmtPrice(hoverCandle.open)}</span>
              <span style={{ color: '#475569' }}>H</span><span style={{ color: '#2dd4bf' }}>{fmtPrice(hoverCandle.high)}</span>
              <span style={{ color: '#475569' }}>L</span><span style={{ color: '#f87171' }}>{fmtPrice(hoverCandle.low)}</span>
              <span style={{ color: '#475569' }}>C</span><span style={{ color: hoverCandle.close >= hoverCandle.open ? '#2dd4bf' : '#f87171', fontWeight: 700 }}>{fmtPrice(hoverCandle.close)}</span>
              {(hoverCandle.volume ?? 0) > 0 && (
                <><span style={{ color: '#475569' }}>V</span><span style={{ color: '#94a3b8' }}>{fmtLarge(hoverCandle.volume!)}</span></>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom row: start time / delta / end time */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: '#94a3b8', marginTop: '5px' }}>
        <span>{fmtTs(first.timestamp)}</span>
        <span style={{ color: deltaPct == null ? '#94a3b8' : deltaPct >= 0 ? '#2dd4bf' : '#f87171' }}>
          Δ {deltaPct == null ? 'N/A' : fmtPct(deltaPct)}
        </span>
        <span>{fmtTs(last.timestamp)}</span>
      </div>
    </div>
  )
}

type _TrendSnap = { price: number | null; changes: Array<{ label: string; value: number | null }> }
type _TrendPt = { ts: number; price: number }

function TrendChart({ snapshot, currentPrice }: { snapshot: _TrendSnap; currentPrice: number | null }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const basePrice = currentPrice ?? snapshot.price ?? 0
  if (basePrice <= 0) return null

  const nowSec = Math.floor(Date.now() / 1000)
  const labelSecs: Record<string, number> = { '5M': 300, '1H': 3600, '6H': 21600, '24H': 86400, '48H': 172800, '7D': 604800 }

  const anchors: _TrendPt[] = [{ ts: nowSec, price: basePrice }]
  for (const ch of snapshot.changes) {
    const key = ch.label.toUpperCase().replace(/\s+/g, '').replace('MIN', 'M')
    const secs = labelSecs[key]
    if (secs != null && ch.value != null) {
      const p = basePrice / (1 + ch.value / 100)
      if (p > 0) anchors.push({ ts: nowSec - secs, price: p })
    }
  }
  anchors.sort((a, b) => a.ts - b.ts)
  if (anchors.length < 2) return null

  // Linear interpolation between anchors → smooth ~60 point series
  const TARGET = 60
  const totalDur = anchors[anchors.length - 1].ts - anchors[0].ts
  const pts: _TrendPt[] = []
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1]
    const steps = Math.max(2, Math.round(TARGET * (b.ts - a.ts) / totalDur))
    for (let j = 0; j < steps; j++) {
      const t = j / steps
      pts.push({ ts: a.ts + t * (b.ts - a.ts), price: a.price + t * (b.price - a.price) })
    }
  }
  pts.push(anchors[anchors.length - 1])

  const W = 960, H = 220
  const padX = 14, padTop = 28, padBot = 36
  const areaH = H - padTop - padBot

  const prices = pts.map(p => p.price)
  const priceMax = Math.max(...prices), priceMin = Math.min(...prices)
  const spread = Math.max(priceMax - priceMin, priceMin * 0.001, 1e-12)
  const pad = spread * 0.12
  const dMax = priceMax + pad, dMin = priceMin - pad, dSpread = dMax - dMin

  const xP = (i: number) => padX + (i / (pts.length - 1)) * (W - padX * 2)
  const yP = (v: number) => padTop + ((dMax - v) / dSpread) * areaH

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xP(i).toFixed(1)},${yP(p.price).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${(W - padX).toFixed(1)},${(padTop + areaH).toFixed(1)} L${padX.toFixed(1)},${(padTop + areaH).toFixed(1)} Z`

  const isUp = pts[pts.length - 1].price >= pts[0].price
  const lineClr = isUp ? 'rgba(45,212,191,0.88)' : 'rgba(248,113,113,0.88)'

  const onMove = (clientX: number, rect: DOMRect) => {
    const svgX = (clientX - rect.left) * (W / rect.width)
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((svgX - padX) / (W - padX * 2) * (pts.length - 1))))
    setHoverIdx(i)
  }

  const first = pts[0], last = pts[pts.length - 1]
  const deltaPct = first.price > 0 ? ((last.price - first.price) / first.price) * 100 : null
  const hoverPt = hoverIdx != null ? pts[hoverIdx] : null
  const guideYs = [0, 0.33, 0.67, 1].map(r => padTop + r * areaH)

  const fmtTs2 = (ts: number) => {
    const d = new Date(ts * 1000)
    const diffH = (Date.now() / 1000 - ts) / 3600
    return diffH < 48
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <div
      style={{ position: 'relative' }}
      onMouseLeave={() => setHoverIdx(null)}
      onMouseMove={e => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'clamp(160px, 22vw, 240px)', display: 'block' }}>
        <defs>
          <linearGradient id="tcFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={isUp ? 'rgba(45,212,191,0.20)' : 'rgba(248,113,113,0.20)'} />
            <stop offset="100%" stopColor={isUp ? 'rgba(45,212,191,0.00)' : 'rgba(248,113,113,0.00)'} />
          </linearGradient>
        </defs>

        {guideYs.map((y, i) => (
          <line key={i} x1={padX} y1={y} x2={W - padX} y2={y} stroke="rgba(148,163,184,0.09)" strokeWidth="1" />
        ))}

        <path d={areaPath} fill="url(#tcFill)" />
        <path d={linePath} fill="none" stroke={lineClr} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {anchors.map((a, i) => {
          const xi = pts.findIndex(p => p.ts === a.ts)
          if (xi < 0) return null
          return <circle key={i} cx={xP(xi)} cy={yP(a.price)} r="3.5" fill={lineClr} stroke="rgba(2,6,23,0.8)" strokeWidth="1" />
        })}

        {hoverIdx != null && hoverPt && (
          <>
            <line x1={xP(hoverIdx)} y1={padTop} x2={xP(hoverIdx)} y2={padTop + areaH} stroke="rgba(148,163,184,0.28)" strokeDasharray="3 3" strokeWidth="1" />
            <circle cx={xP(hoverIdx)} cy={yP(hoverPt.price)} r="4.5" fill={lineClr} stroke="rgba(2,6,23,0.7)" strokeWidth="1.5" />
          </>
        )}

        <text x={padX + 2} y={padTop - 8} fill="#475569" style={{ fontSize: 11 }}>H {fmtPrice(priceMax)}</text>
        <text x={W - padX - 2} y={padTop - 8} textAnchor="end" fill="#475569" style={{ fontSize: 11 }}>L {fmtPrice(priceMin)}</text>
        <text x={W / 2} y={padTop + areaH - 10} textAnchor="middle" fill="rgba(148,163,184,0.12)" style={{ fontSize: 13, letterSpacing: '0.10em', fontFamily: 'sans-serif' }}>ESTIMATED TREND</text>
      </svg>

      <div style={{ position: 'absolute', top: '8px', right: '10px', border: '1px solid rgba(167,139,250,0.38)', background: 'rgba(15,23,42,0.84)', borderRadius: '999px', padding: '4px 10px', color: '#e2e8f0', fontSize: '11px', fontWeight: 700, pointerEvents: 'none' }}>
        {fmtPrice(last.price)}
      </div>

      {hoverPt && (
        <div style={{ position: 'absolute', left: '10px', bottom: '32px', border: '1px solid rgba(148,163,184,0.18)', background: 'rgba(2,6,23,0.92)', borderRadius: '10px', padding: '8px 11px', pointerEvents: 'none', zIndex: 2, minWidth: '120px' }}>
          <div style={{ color: '#64748b', fontSize: '10px', marginBottom: '4px' }}>{fmtTs2(hoverPt.ts)}</div>
          <div style={{ fontSize: '13px', color: lineClr, fontWeight: 700 }}>{fmtPrice(hoverPt.price)}</div>
          <div style={{ fontSize: '9px', color: '#475569', marginTop: '3px', letterSpacing: '0.06em' }}>Estimated from % changes</div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: '#94a3b8', marginTop: '5px' }}>
        <span>{fmtTs2(first.ts)}</span>
        <span style={{ color: deltaPct == null ? '#94a3b8' : deltaPct >= 0 ? '#2dd4bf' : '#f87171' }}>
          Δ {deltaPct == null ? 'N/A' : fmtPct(deltaPct)}
        </span>
        <span>{fmtTs2(last.ts)}</span>
      </div>
    </div>
  )
}

function humanizeReasonCode(reason?: string): string {
  if (!reason) return 'Additional verification is required.'
  const map: Record<string, string> = {
    contract_bytecode_unavailable_from_rpc:          'No signal in checked window from current checks.',
    unavailable_circulating_supply_not_verified:      'Circulating supply not fully verified.',
    honeypot_simulation_unavailable_from_provider:    'Live security simulation unavailable.',
    honeypot_provider_unavailable_using_limited_fallback: 'Live simulation unavailable, using limited safety signals.',
    security_simulation_unavailable:                  'Live security simulation unavailable.',
    security_check_limited_signals_used:              'Live simulation unavailable, using limited safety signals.',
    no_active_liquidity_pool_found:                   'No active liquidity pool was found.',
    partial_market_fields_from_provider:              'Some market fields unavailable.',
    partial_market_data:                              'Some market fields unavailable.',
    holder_data_unavailable:                          'Holder data partial — limited data available.',
  }
  if (map[reason]) return map[reason]
  if (/^[a-z0-9_]+$/.test(reason)) return reason.replace(/_/g, ' ')
  return reason
}

function humanizeSectionLine(source?: string, status?: string, reason?: string): string {
  const sourceMap: Record<string, string> = {
    rpc:                     'Contract verification',
    'dex_data+rpc':          'Contract verification',
    market_data:             'Market data',
    dex_data:                'Market data',
    on_chain:                'Holder data',
    security_check:          'Security simulation',
    security_check_limited:  'Security signals',
    unavailable:             'Data check',
  }
  const sourceLabel = sourceMap[source ?? ''] ?? 'CORTEX check'
  const statusLabel = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'No signal in checked window'
  const reasonText = reason ? humanizeReasonCode(reason) : ''
  if (reasonText && reasonText.toLowerCase().startsWith(statusLabel.toLowerCase())) {
    return `${sourceLabel}: ${reasonText}`
  }
  return `${sourceLabel}: ${statusLabel}${reasonText ? ` — ${reasonText}` : ''}`
}

function shorten(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function evidenceValue(lines: string[] | undefined, label: string): string | null {
  if (!Array.isArray(lines)) return null
  const line = lines.find((l) => l.startsWith(`${label}:`))
  if (!line) return null
  return line.slice(label.length + 1).trim() || null
}

function normalizeHolderProviderStatus(
  status: ScanResult['holderDistributionStatus']
): HolderProviderStatus {
  const s = status?.status
  if (s === 'ok') return 'ok'
  if (s === 'partial') return 'partial'
  if (s === 'unavailable_with_reason' || s === 'error') return 'unavailable_with_reason'
  // Legacy: 'empty' and 'unavailable' map to unavailable_with_reason
  return 'unavailable_with_reason'
}

function holderSafeReason(
  providerStatus: HolderProviderStatus,
  hasRows: boolean,
  reason?: string | null
): string {
  if (reason === 'holder_percentages_failed_sanity_check') return 'Holder rows were indexed, but concentration percentages failed validation.'
  if (hasRows) return 'Holder data available.'
  if (providerStatus === 'partial') return 'Holder data partial — limited data available.'
  if (providerStatus === 'error' || providerStatus === 'unavailable_with_reason') return 'Holder data open check — no rows returned by provider. Verify via block explorer.'
  return 'Holder concentration: open check — verify via block explorer.'
}

function deriveHolderState(result: ScanResult): DerivedHolderState {
  const rows = result.holderDistribution?.topHolders ?? []
  const hasRows = rows.length > 0
  const providerStatus = normalizeHolderProviderStatus(result.holderDistributionStatus)
  const reason = result.holderDistributionStatus?.reason ?? null
  const percentagesFailedSanity = reason === 'holder_percentages_failed_sanity_check'
  const hasPercentages = !percentagesFailedSanity && rows.some(r => r.percent != null)
  const kind: HolderStateKind = !hasRows
    ? 'noRowsFallback'
    : hasPercentages
      ? 'rowsWithPercent'
      : 'rowsWithoutPercent'
  return {
    kind,
    providerStatus,
    safeReason: holderSafeReason(providerStatus, hasRows, reason),
    rows,
    hasPercentages,
  }
}

function scanEvidenceFor(result: ScanResult, selectedWallet?: string | null) {
  const holderState = deriveHolderState(result)
  const clusterAudit = result.devClusterDiagnosisAudit ?? result.devIntel?.devClusterDiagnosisAudit ?? null
  const deployer = clusterAudit?.deployerResolution.originWallet
    ?? result.devIntel?.originAddress
    ?? result.devIntel?.deployerAddress
    ?? null
  const lpStatus = result.lpControl?.proofStatus ?? result.lpControl?.status ?? null
  return classifyTokenScannerEvidence({
    holdersVerified: holderState.kind === 'rowsWithPercent',
    holderRows: holderState.rows,
    deployerAddress: typeof deployer === 'string' ? deployer : null,
    selectedWallet: selectedWallet ?? (typeof deployer === 'string' ? deployer : null),
    graphStatus: clusterAudit?.linkedWalletGraph.graphStatus ?? null,
    graphFailureReason: clusterAudit?.linkedWalletGraph.failureReason ?? null,
    walletsMapped: clusterAudit?.linkedWalletGraph.walletsMapped ?? null,
    lpProofComplete: lpStatus === 'verified' || lpStatus === 'locked' || lpStatus === 'burned',
    lpProofStatus: typeof lpStatus === 'string' ? lpStatus : null,
    chainId: tokenScannerEvidenceChainId(result.chain, null),
    chainSlug: result.chain ?? null,
    marketVerified: result.price != null || result.liquidity != null,
  })
}

// DEV-CONTROL-WIRING-FIX, DISCLOSED (bug report: "Dev Control shouldn't be Open check when it's
// working" — LP Control correctly reads live owner-check data, but Dev Control always showed Open
// check). Root cause: this used to read `gp = result.contractSecurity[contract]`, but the API
// always sends `contractSecurity: null` — that field is dead and never populated. The real,
// already-resolved owner data lives at `result.security.devOwnership` (same source LP Control's
// "Dev Control" reasoning elsewhere on the page already uses, e.g. line ~6335). Switched to read
// from there instead — no backend/API change, just pointing the UI at the live field.
function deriveOwnerStatus(devOwnership: NonNullable<ScanResult['security']>['devOwnership']): OwnerStatus {
  if (!devOwnership) return 'Open check'
  if (devOwnership.isRenounced) return 'Renounced'
  if (devOwnership.ownerAddress != null) return 'Held'
  return 'Open check'
}

function deriveHolderFallbackEvidence(result: ScanResult): HolderFallbackEvidence {
  const ratio = result.marketCapUsd != null && result.fdvUsd != null && result.fdvUsd > 0
    ? (result.marketCapUsd / result.fdvUsd) * 100
    : null
  // ROBINHOOD-EVIDENCE FIX, DISCLOSED: these two fields fed the hero row's bare "Open check" text
  // for holder concentration/supply spread regardless of chain or reason. Robinhood scans now get
  // the resolver's real classification; every other chain keeps the exact prior literal.
  const robinhood = robinhoodEvidenceFor(result)
  return {
    ownerStatus: deriveOwnerStatus(result.security?.devOwnership),
    poolCount: result.pools?.length ?? 0,
    liquidityDepth: result.liquidity ?? null,
    marketCapToFdvPct: ratio,
    marketCapToFdvLabel: ratio == null ? 'MC unavailable' : `${ratio.toFixed(1)}%`,
    holderConcentration: robinhood?.holderLabel ?? 'Open check',
    supplySpread: robinhood?.holderLabel ?? 'Open check',
    providerReturnedNoRows: (result.holderDistribution?.topHolders?.length ?? 0) === 0,
  }
}

function buildHolderFallbackRead(fallback: HolderFallbackEvidence): { read: string; next: string } {
  const signals: string[] = []
  if (fallback.liquidityDepth != null && fallback.liquidityDepth > 0) {
    if (fallback.liquidityDepth > 1_000_000) signals.push(`Deep liquidity confirmed ($${(fallback.liquidityDepth / 1e6).toFixed(1)}M depth).`)
    else if (fallback.liquidityDepth > 200_000) signals.push(`Moderate liquidity confirmed ($${Math.round(fallback.liquidityDepth / 1000)}K depth).`)
    else signals.push('Liquidity is thin.')
  }
  if (fallback.poolCount > 5) signals.push(`Multi-pool coverage (${fallback.poolCount} pools) — real market activity visible.`)
  else if (fallback.poolCount > 1) signals.push(`${fallback.poolCount} active pools detected.`)
  if (fallback.marketCapToFdvPct != null) {
    if (fallback.marketCapToFdvPct >= 95) signals.push('MC/FDV near 100% — low unlock pressure visible.')
    else if (fallback.marketCapToFdvPct < 70) signals.push('FDV significantly exceeds MC — potential unlock pressure.')
  }
  if (fallback.ownerStatus === 'Renounced') signals.push('Contract owner renounced.')
  else if (fallback.ownerStatus === 'Held') signals.push('Contract owner is still active.')
  const intro = 'Holder rows were not returned in this pass, so concentration is the missing risk layer.'
  const read = signals.length ? `${intro} ${signals.join(' ')}` : `${intro} No additional on-chain context resolved.`
  return { read, next: 'Verify top holders before forming conviction on this token.' }
}

function dedupeSecurityChips(chips: SecurityChip[]): SecurityChip[] {
  const map = new Map<string, SecurityChip>()
  for (const chip of chips) {
    const existing = map.get(chip.label)
    if (!existing) {
      map.set(chip.label, chip)
      continue
    }
    if (chip.source === 'honeypot' && existing.source !== 'honeypot') {
      map.set(chip.label, chip)
    }
  }
  return Array.from(map.values())
}

function deriveVerdictInput(result: ScanResult): VerdictInput {
  const gp = result.contractSecurity && result.contract
    ? (result.contractSecurity[result.contract.toLowerCase()] ?? null) as Record<string, unknown> | null
    : null
  const hp = result.honeypot
  const simUi = tradingSimUiFor(result)
  const baseChips: SecurityChip[] = [
    { label: 'Honeypot', displayLabel: simUi.honeypotValue, style: simUi.honeypotValue === 'YES' ? pillDanger() : simUi.honeypotValue === 'NO' ? pillSafe() : pillMuted(), source: 'honeypot' },
    { label: 'Buy Tax', displayLabel: simUi.showTaxRows ? simUi.buyTaxValue : simUi.statusLabel, style: hp?.buyTax != null && simUi.showTaxRows ? taxPct(hp.buyTax) : pillMuted(), source: 'honeypot' },
    { label: 'Sell Tax', displayLabel: simUi.showTaxRows ? simUi.sellTaxValue : simUi.statusLabel, style: hp?.sellTax != null && simUi.showTaxRows ? taxPct(hp.sellTax) : pillMuted(), source: 'honeypot' },
    { label: 'Honeypot', displayLabel: String(gp?.is_honeypot ?? 'N/A'), style: String(gp?.is_honeypot ?? '') === '1' ? pillDanger() : pillSafe(), source: 'contract' },
    { label: 'Buy Tax', displayLabel: gp?.buy_tax != null ? `${(Number(gp.buy_tax) * 100).toFixed(1)}%` : 'N/A', style: gp?.buy_tax != null ? taxPct(Number(gp.buy_tax) * 100) : pillMuted(), source: 'contract' },
    { label: 'Sell Tax', displayLabel: gp?.sell_tax != null ? `${(Number(gp.sell_tax) * 100).toFixed(1)}%` : 'N/A', style: gp?.sell_tax != null ? taxPct(Number(gp.sell_tax) * 100) : pillMuted(), source: 'contract' },
  ]
  return {
    hasMarketData: result.price != null || result.volume24h != null || result.marketCapUsd != null || result.fdvUsd != null,
    hasSecurityData: !!gp || !!hp,
    hasLiquidityData: (result.liquidity ?? 0) > 0 || (result.pools?.length ?? 0) > 0,
    holderState: deriveHolderState(result),
    fallbackEvidence: deriveHolderFallbackEvidence(result),
    dedupedSecurityChips: dedupeSecurityChips(baseChips),
    supports: ['verdict','marketRead','securityRead','holderSupplyRead','liquidityPoolsRead','bullCase','bearCase','missingChecks','nextAction'],
  }
}

// ─── StatCard ─────────────────────────────────────────────────────────────

function StatCard({ label, value, accent, helper, dim }: { label: string; value: string; accent?: string; helper?: string; dim?: boolean }) {
  {/* DIM-VARIANT, DISCLOSED (Token Scanner section-readability polish task, explicitly requested:
      "make secondary Market data slightly quieter than the primary Price/Liquidity/Volume/Change
      row"): an opt-in `dim` prop only — every existing call site is unaffected unless it passes
      dim, so all other StatCard usages on this page render exactly as before. */}
  return (
    <div style={{
      background: dim ? 'linear-gradient(160deg, rgba(9,15,28,.80), rgba(3,7,16,.78))' : 'linear-gradient(160deg, rgba(10,18,34,.93), rgba(3,8,19,.90))',
      border: `1px solid ${accent ? `${accent}${dim ? '14' : '1e'}` : 'rgba(255,255,255,0.05)'}`,
      borderRadius: '14px',
      padding: dim ? '14px 16px' : '18px 20px',
      display: 'flex', flexDirection: 'column', gap: dim ? '4px' : '6px',
    }}>
      <p style={{
        fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em',
        color: '#3a5268', textTransform: 'uppercase', margin: 0,
        fontFamily: 'var(--font-plex-mono)',
      }}>
        {label}
      </p>
      <p style={{
        fontSize: dim ? '16px' : '22px', fontWeight: dim ? 700 : 800, lineHeight: 1,
        color: dim ? (accent ? `${accent}c0` : '#94a3b8') : (accent ?? '#e2e8f0'),
        fontFamily: 'var(--font-plex-mono)', margin: 0,
      }}>
        {value}
      </p>
      {helper && <p style={{ margin: 0, fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.4 }}>{helper}</p>}
    </div>
  )
}

// ─── Project Socials Card ─────────────────────────────────────────────────

type SocialLink = { href: string; label: string; abbr: string; color: string }
// Loosened from ScanResult['projectSocials'] so the Solana result (which builds this object
// straight from DexScreener's pair.info, not the EVM multi-provider resolver) can reuse the
// exact same card component — same premium presentation for both, one component to maintain.
// sourceTrail/status/github were never read by this component's render logic (see below), so
// this is a pure widening, not a behavior change for existing EVM callers.
type ProjectSocialsInput = {
  website?: string | null
  twitter?: string | null
  telegram?: string | null
  discord?: string | null
  reddit?: string | null
} | null | undefined

function ProjectSocialsCard({ socials }: { socials: ProjectSocialsInput }) {
  const links: SocialLink[] = [
    socials?.twitter  ? { href: socials.twitter,  label: 'X',        abbr: 'X',   color: '#60a5fa' } : null,
    socials?.telegram ? { href: socials.telegram, label: 'Telegram', abbr: 'TG',  color: '#38bdf8' } : null,
    socials?.discord  ? { href: socials.discord,  label: 'Discord',  abbr: 'DC',  color: '#818cf8' } : null,
    socials?.reddit   ? { href: socials.reddit,   label: 'Reddit',   abbr: 'RD',  color: '#fb923c' } : null,
    socials?.website  ? { href: socials.website,  label: 'Website',  abbr: 'WEB', color: '#2DD4BF' } : null,
  ].filter((l): l is SocialLink => l !== null)

  return (
    <div style={{
      marginBottom: '20px', padding: '14px 16px',
      background: 'linear-gradient(135deg,rgba(10,18,34,.96),rgba(3,8,19,.92))',
      border: '1px solid rgba(45,212,191,0.16)', borderRadius: '14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.14em', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
          Project Links
        </span>
        <span style={{ fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
          Indexed links from token metadata
        </span>
      </div>
      {links.length === 0 ? (
        <span style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
          No socials found for this token
        </span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {links.map((lk) => (
            <a
              key={lk.label}
              href={lk.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 14px', borderRadius: '999px', textDecoration: 'none',
                border: `1px solid ${lk.color}30`,
                background: `${lk.color}10`,
                color: lk.color,
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em',
                fontFamily: 'var(--font-plex-mono)',
                transition: 'background 0.14s, border-color 0.14s',
              }}
            >
              {lk.label}
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.55, flexShrink: 0 }}>
                <path d="M1 9L9 1M9 1H4M9 1V6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Display-only helpers (pure — no fetching, no mutation) ───────────────

function getSummaryVerdict(result: ScanResult): { label: string; color: string; bg: string; border: string } {
  const hp = result.honeypot
  const liq = result.liquidity ?? 0
  const taxesHigh = (hp?.buyTax != null && hp.buyTax > 8) || (hp?.sellTax != null && hp.sellTax > 8)
  const holderState = deriveHolderState(result)
  if (hp?.isHoneypot === true || taxesHigh) return { label: 'AVOID',         color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)' }
  if (!result.price && !hp)                 return { label: 'UNKNOWN',       color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' }
  if (hp?.isHoneypot === false && liq > 120000 && holderState.kind === 'rowsWithPercent')
                                            return { label: 'CLEAN LOOKING', color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.35)'  }
  if (holderState.kind === 'noRowsFallback' || liq < 40000)
                                            return { label: 'WATCH',         color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)'  }
  return                                           { label: 'CAUTION',       color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.30)'  }
}

function getSummaryReasons(result: ScanResult): string[] {
  const hp = result.honeypot
  const liq = result.liquidity ?? 0
  const holderState = deriveHolderState(result)
  const reasons: string[] = []
  if (result.price != null && liq > 0) {
    const mcStr = result.marketCapUsd != null ? `MC ${fmtLarge(result.marketCapUsd)} verified` : 'market cap not confirmed'
    reasons.push(`Market is live — price ${fmtPrice(result.price)}, liquidity ${fmtLarge(liq)}, ${mcStr}.`)
  } else if (result.noActivePools) {
    reasons.push(`No active liquidity pool found for this token on ${chainDisplayName(result.chain)}.`)
  } else {
    reasons.push('Market data is unavailable or limited.')
  }
  if (hp?.simulationSuccess && hp.isHoneypot === false) {
    const tax = hp.buyTax != null && hp.sellTax != null ? ` Tax: buy ${hp.buyTax.toFixed(1)}% / sell ${hp.sellTax.toFixed(1)}%.` : ''
    reasons.push(`Security simulation completed — no honeypot flagged.${tax}`)
  } else if (hp?.isHoneypot === true) {
    reasons.push('Honeypot flagged — blocked sells detected in simulation.')
  } else {
    const simUi = tradingSimUiFor(result)
    reasons.push(`${simUi.statusLabel}. ${simUi.reason}`)
  }
  if (holderState.kind === 'rowsWithPercent' && result.holderDistribution?.top10 != null) {
    const t = result.holderDistribution.top10
    const risk = t > 50 ? 'high concentration' : t > 30 ? 'moderate concentration' : 'reasonable spread'
    reasons.push(`Holder distribution confirmed — top 10 hold ${t.toFixed(1)}% (${risk}).`)
  } else if (holderState.kind === 'rowsWithoutPercent') {
    reasons.push('Holder wallets found but supply percentages not confirmed.')
  } else {
    reasons.push('Holder concentration not confirmed — treat as an incomplete check.')
  }
  return reasons.slice(0, 3)
}




function getLpMode(result: ScanResult): LpMode {
  // Prefer the authoritative backend-computed displayLpModel (available on newer scans)
  const dm = result.lpControl?.displayLpModel
  if (dm === 'concentrated_liquidity' || dm === 'protocol_or_gauge') return 'protocol'
  if (dm === 'erc20_lp_token') return 'lp_token'
  if (dm === 'open_check' || dm === 'no_pool') return 'unknown'
  // Fallback for scans without displayLpModel
  const status = result.lpControl?.status
  const poolType = result.lpControl?.poolType
  if (status === 'protocol' || status === 'concentrated_liquidity') return 'protocol'
  if (status === 'locked' || status === 'burned' || status === 'team_controlled' || status === 'risky') return 'lp_token'
  if (poolType === 'v2' && (status === 'partial' || status === 'insufficient_data')) return 'lp_token'
  if (result.lpControl?.proofStatus === 'verified') return 'lp_token'
  return 'unknown'
}
function getMissingChecks(result: ScanResult): string[] {
  const holderState = deriveHolderState(result)
  const lpMode = getLpMode(result)
  const lpStatus = result.lpControl?.status
  const lpVerified = lpStatus === 'locked' || lpStatus === 'burned'
  return [
    result.noActivePools ? 'Active liquidity pool' : null,
    holderState.kind !== 'rowsWithPercent' ? 'Holder concentration' : null,
    lpMode === 'protocol' ? 'LP token model not used — protocol-managed concentrated liquidity.' : lpStatus === 'no_pool' ? 'No usable liquidity pool found.' : lpStatus === 'unavailable_with_reason' ? 'LP lock or burn proof' : lpMode === 'unknown' ? 'Liquidity detected, but LP model could not be classified.' : (lpStatus === 'team_controlled' ? 'LP ownership concentrated in normal wallet.' : !lpVerified ? 'LP lock or burn proof' : null),
    result.marketCapUsd == null ? 'Verified market cap' : null,
    'Supply spread',
  ].filter((v): v is string => v != null)
}

function getNextAction(result: ScanResult): string {
  const hp = result.honeypot
  const liq = result.liquidity ?? 0
  const holderState = deriveHolderState(result)
  if (hp?.isHoneypot === true) return 'Do not trade — honeypot detected in simulation.'
  if (result.noActivePools) return `No active pool found. Verify the contract is live on ${chainDisplayName(result.chain)}.`
  if (liq > 0 && liq < 10000) return 'Liquidity is very thin — high slippage and exit risk present.'
  if (liq > 0 && liq < 50000) return 'Liquidity is limited. Verify LP lock or burn proof before entering.'
  if (holderState.kind === 'noRowsFallback') return 'Holder concentration not confirmed. Verify top holders before forming conviction on this token.'
  return 'Monitor liquidity and holder concentration before forming conviction. Treat incomplete checks as risk signals.'
}


type CMapRisk = 'low' | 'medium' | 'high' | 'open_check' | 'neutral'
const CMAP_RISK_COLOR: Record<CMapRisk, string> = { low:'#34d399', medium:'#facc15', high:'#fb7185', open_check:'#a855f7', neutral:'#64748b' }
const CMAP_RISK_BG: Record<CMapRisk, string> = { low:'rgba(52,211,153,0.12)', medium:'rgba(250,204,21,0.12)', high:'rgba(251,113,133,0.14)', open_check:'rgba(168,85,247,0.11)', neutral:'rgba(100,116,139,0.10)' }
function deriveClusterNodeRisk(node: ClusterNode, clusterRiskScore: number | null): CMapRisk {
  if (node.type === 'holder_wallet' && !node.isLinked && !node.isCluster) {
    // Confidence here means "confirmed linked to the deployer/cluster" — plain indexed holders are
    // always 'open_check' on that axis. That's a different question from supply-concentration risk,
    // which IS known once the wallet is indexed with a percent. Previously this short-circuited risk
    // to 'open_check' whenever confidence was 'open_check', which is every single plain holder node
    // (lib/clusterMap.ts hardcodes that confidence for all of them) — so risk was always 'Open check'
    // even for holders with a clearly indexed, low supply percent. Only fall back to 'open_check' risk
    // when the percent itself is genuinely unknown.
    if (node.supplyPercent == null) return 'open_check'
    const pct = node.supplyPercent
    return pct >= 10 ? 'medium' : pct >= 1 ? 'low' : 'neutral'
  }
  const hasSusp = (node.reasons ?? []).some((r: string) => /suspicious|repeated|same.?size|funding|control/i.test(r))
  if (hasSusp) return 'high'
  if ((clusterRiskScore ?? 0) > 60) return 'high'
  // Same fix as the holder_wallet branch above: 'open_check' confidence (a linked_wallet/cluster_wallet
  // node whose link confidence wasn't confirmed upstream) used to force risk to 'open_check' even when
  // supplyPercent was a real, known number — discarding a perfectly good pct-based risk reading. Only
  // fall back to 'open_check' risk when the percent itself is genuinely unknown.
  if (node.supplyPercent == null && node.confidence === 'open_check') return 'open_check'
  const pct = node.supplyPercent ?? 0
  if (pct >= 10 && (node.isCreator || node.isLinked)) return 'high'
  if (pct >= 5 || (clusterRiskScore ?? 0) >= 21) return 'medium'
  if (pct >= 1) return 'medium'
  return 'low'
}
function deriveClusterEdgeColor(edge: ClusterEdge): string {
  if ((edge.reason ?? '').toLowerCase().includes('suspicious') || (edge.reason ?? '').toLowerCase().includes('same-size') || (edge.reason ?? '').toLowerCase().includes('repeated')) return '#fb7185'
  if (edge.type === 'shared_pattern') return '#facc15'
  if (edge.type === 'transfer_signal' || edge.type === 'deployer_to_linked') return '#38bdf8'
  if (edge.type === 'linked_to_cluster' || edge.type === 'holder_overlap') return '#a855f7'
  if (edge.type === 'weak_heuristic') return '#334155'
  return edge.confidence === 'high' ? '#2dd4bf' : edge.confidence === 'medium' ? '#7dd3fc' : '#475569'
}

function ClusterMapPanel({ clusterMap, devIntel, holderDistribution, chain, tokenAddress, tokenSymbol, tokenName, clusterAudit, holdersVerified }: { clusterMap: ClusterMap | null; devIntel?: DevWalletIntel | null; holderDistribution?: { topHolders?: Array<{ rank?: number | null; address?: string | null; percent?: number | null }> } | null; chain?: string | null; tokenAddress?: string | null; tokenSymbol?: string | null; tokenName?: string | null; clusterAudit?: DevClusterDiagnosisAudit | null; holdersVerified?: boolean }) {
  const fmt = (addr: string | null | undefined) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'
  const map = clusterMap
  // PERF FIX, DISCLOSED (audit: Cluster Map tab pegged a CPU core / froze the page): nodes/edges
  // were freshly-allocated arrays on every render, used by reference as the physics-simulation
  // effect's deps below. Since the effect always ends by calling setSimPositions(new Map()) — a new
  // object every time — React never bailed out: render -> new nodes/edges array -> effect deps
  // "changed" -> effect reruns the 280-iteration O(n^2) simulation -> setState -> render -> repeat,
  // forever, on every render for any reason (even one unrelated to the cluster data itself).
  // useMemo keyed on the actual `map` prop makes nodes/edges stable across renders where the
  // underlying cluster data hasn't changed, so the effect only reruns when it should.
  const nodes = useMemo(() => map?.nodes ?? [], [map])
  const edges = useMemo(() => map?.edges ?? [], [map])
  const summary = map?.summary ?? null
  const [selectedClusterNodeId, setSelectedClusterNodeId] = useState<string | null>(null)
  // COPY FEEDBACK FIX, DISCLOSED (audit: this button gave zero feedback on click — label was
  // permanently "COPY", and the optional-chain on navigator.clipboard meant a silent no-op in a
  // non-secure context too, indistinguishable from a working copy).
  const [copiedClusterAddress, setCopiedClusterAddress] = useState<string | null>(null)
  const copyClusterAddress = async (address: string) => {
    try {
      if (typeof window === 'undefined') return
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(address)
      } else {
        const textArea = document.createElement('textarea')
        textArea.value = address
        textArea.setAttribute('readonly', '')
        textArea.style.position = 'fixed'
        textArea.style.opacity = '0'
        textArea.style.pointerEvents = 'none'
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand('copy')
        document.body.removeChild(textArea)
      }
      setCopiedClusterAddress(address)
      window.setTimeout(() => setCopiedClusterAddress((prev) => (prev === address ? null : prev)), 1500)
    } catch { /* best-effort — clipboard access can be denied, never fatal */ }
  }
  const [hoveredClusterNodeId, setHoveredClusterNodeId] = useState<string | null>(null)
  const [clusterTooltipPos, setClusterTooltipPos] = useState<{x:number;y:number}|null>(null)
  const [simPositions, setSimPositions] = useState<Map<string,{x:number;y:number}>>(() => new Map())
  const clusterGraphRef = useRef<HTMLDivElement>(null)
  const clusterIsTouch = useRef(false)
  const [hoveredClusterEdgeId, setHoveredClusterEdgeId] = useState<string | null>(null)
  const [edgeTooltipPosition, setEdgeTooltipPosition] = useState<{ x: number; y: number } | null>(null)
  // CHEAP-BALANCE-CALL, DISCLOSED (deployer wallet detail fix, resolution step 5): one small,
  // rate-limited /api/deployer-balance read fired only when the DEPLOYER node is selected — never the
  // full Wallet Scanner. eth/base only (matches Dev Control's own chain support); any other chain, or
  // any failure, just leaves the indexed holder-snapshot figures as the answer.
  const [deployerCheapBalance, setDeployerCheapBalance] = useState<{ attempted: boolean; succeeded: boolean; balance: number | null } | null>(null)
  const [showRelatedDeployments, setShowRelatedDeployments] = useState(false)
  useEffect(() => {
    // Resets the previous node's cheap-balance result before the (possibly async) fetch below for
    // the newly-selected node resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDeployerCheapBalance(null)
    const node = (clusterMap?.nodes ?? []).find((n) => n.id === selectedClusterNodeId)
    if (!node || node.type !== 'deployer') return
    if (chain !== 'eth' && chain !== 'base') return
    if (!tokenAddress || !node.address) return
    let cancelled = false
    // Marks the call as in-flight before the fetch below settles; see the disclosure above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDeployerCheapBalance({ attempted: true, succeeded: false, balance: null })
    fetch(`/api/deployer-balance?chain=${chain}&tokenAddress=${tokenAddress}&walletAddress=${node.address}`)
      .then((res) => res.json())
      .then((json: { ok?: boolean; tokenBalanceRaw?: string | null; tokenBalanceSucceeded?: boolean }) => {
        if (cancelled) return
        if (!json?.ok || !json.tokenBalanceSucceeded || json.tokenBalanceRaw == null) {
          setDeployerCheapBalance({ attempted: true, succeeded: false, balance: null })
          return
        }
        // Raw balance is base-unit (no decimals applied) — shown as a raw integer count when decimals
        // aren't independently known here; the resolver only uses it to answer "holds >0 tokens now",
        // not to compute a supply percent (that stays sourced from the indexed holder snapshot).
        const raw = Number(json.tokenBalanceRaw)
        setDeployerCheapBalance({ attempted: true, succeeded: Number.isFinite(raw), balance: Number.isFinite(raw) ? raw : null })
      })
      .catch(() => { if (!cancelled) setDeployerCheapBalance({ attempted: true, succeeded: false, balance: null }) })
    return () => { cancelled = true }
  }, [selectedClusterNodeId, chain, tokenAddress, clusterMap])
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
  const edgeColorFor = (type: string, reason: string) => {
    const lowerType = type.toLowerCase()
    const lowerReason = reason.toLowerCase()
    if (lowerType.includes('suspicious') || /suspicious|repeated|same-size|funding/i.test(lowerReason)) return '#fb7185'
    if (type === 'transfer_signal' || type === 'deployer_to_linked') return '#38bdf8'
    if (type === 'linked_to_cluster' || type === 'holder_overlap') return '#a855f7'
    if (type === 'shared_pattern' || type === 'weak_heuristic') return '#facc15'
    return '#64748b'
  }
  const confidenceOpacity = (confidence: GraphEdge['confidence']) => confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.65 : 0.38
  const edgeWidthFor = (weight: number) => clamp(1 + (weight / 100) * 3, 1, 4.5)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const linked = nodes.filter((node) => node.type === 'linked_wallet')
  const cluster = nodes.filter((node) => node.type === 'cluster_wallet')
  const holders = nodes.filter((node) => node.type === 'holder_wallet')
  const deployer = nodes.find((node) => node.type === 'deployer')
  const ordered = deployer ? [deployer, ...linked, ...cluster, ...holders] : [...linked, ...cluster, ...holders]
  const holderRows = holderDistribution?.topHolders ?? devIntel?.holderDistribution?.topHolders ?? []
  const holdersAreVerified = holdersVerified === true || holderRows.some((row) => row.percent != null)
  // PERF FIX, DISCLOSED: memoized for the same reason nodes/edges are above — graphEdges is the
  // other dependency of the physics-simulation effect below and must be reference-stable across
  // renders where `edges`/`nodes` haven't actually changed.
  const graphEdges: GraphEdge[] = useMemo(() => edges.flatMap((edge, index) => {
    const source = edge.source ?? edge.from ?? null
    const target = edge.target ?? edge.to ?? null
    const reason = edge.reason ?? 'Relationship signal detected'
    const rawWeight = edge.weight == null ? 25 : Number(edge.weight)
    if (!source || !target || source === target) return []
    if ((!Number.isFinite(rawWeight) || rawWeight <= 0) && !edge.reason) return []
    if (!nodeIds.has(source) || !nodeIds.has(target)) return []
    const weight = clamp(Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 25, 1, 100)
    const normalizedConfidence = typeof edge.confidence === 'string' ? edge.confidence.toLowerCase() : ''
    const confidence: GraphEdge['confidence'] = normalizedConfidence === 'high' || normalizedConfidence === 'medium' || normalizedConfidence === 'low' ? normalizedConfidence : 'low'
    const type = edge.type ?? 'weak_heuristic'
    return [{
      id: edge.id ?? `${source}-${target}-${index}`,
      source,
      target,
      type,
      weight,
      confidence,
      reason,
      color: edgeColorFor(type, reason),
      opacity: clamp(confidenceOpacity(confidence), 0.1, 1),
      width: edgeWidthFor(weight),
    }]
  }), [edges, nodes]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { clusterIsTouch.current = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches }, [])
  // RULES-OF-HOOKS FIX, DISCLOSED (audit/lint: this ref + its cleanup effect were originally
  // declared further down, after this component's early `if (!map || ...) return (...)` guard —
  // a real conditional-hook-call bug (react-hooks/rules-of-hooks) that would only misbehave when
  // the early-return branch was taken on one render and not the next. Hoisted above the guard,
  // alongside every other hook in this component, so they're always called in the same order.
  const edgePointerRaf = useRef<number | null>(null)
  useEffect(() => () => { if (edgePointerRaf.current != null) cancelAnimationFrame(edgePointerRaf.current) }, [])
  useEffect(() => {
    if (!nodes.length) { setSimPositions(new Map()); return }
    const n = nodes.length
    type SN = {id:string;x:number;y:number;vx:number;vy:number;mass:number;radius:number;fx:number|null;fy:number|null}
    const sn: SN[] = ordered.map((node, i) => {
      const pct = node.supplyPercent ?? 0
      const mass = Math.max(1, Math.min(8, 1 + Math.sqrt(pct) * 1.5))
      const radius = Math.max(4, Math.min(9, 4 + Math.sqrt(pct) * 0.8))
      const angle = (i / Math.max(1,n)) * 2 * Math.PI
      const ring = Math.max(18, n * 7)
      const isFixed = node.type === 'deployer'
      return { id:node.id, x:isFixed?50:50+Math.cos(angle)*ring, y:isFixed?42:48+Math.sin(angle)*ring, vx:0, vy:0, mass, radius, fx:isFixed?50:null, fy:isFixed?42:null }
    })
    const ea = graphEdges.map(e => ({ si:sn.findIndex(nd=>nd.id===e.source), ti:sn.findIndex(nd=>nd.id===e.target), w:e.weight??60 })).filter(e=>e.si>=0&&e.ti>=0)
    let alpha=1
    for (let iter=0; iter<280&&alpha>0.001; iter++) {
      for (const nd of sn){if(nd.fx!==null)continue;nd.vx+=(50-nd.x)*0.04*alpha;nd.vy+=(48-nd.y)*0.04*alpha}
      for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
        const a=sn[i],b=sn[j],dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy+0.01,invD=1/Math.sqrt(d2),f=-38*alpha/d2,fx=dx*invD*f,fy=dy*invD*f
        if(a.fx===null){a.vx-=fx/a.mass;a.vy-=fy/a.mass}
        if(b.fx===null){b.vx+=fx/b.mass;b.vy+=fy/b.mass}
      }
      for (const e of ea){
        const s=sn[e.si],t=sn[e.ti],dx=t.x-s.x,dy=t.y-s.y,d=Math.sqrt(dx*dx+dy*dy)||0.01
        const tgt=16+(100-e.w)*0.14,str=Math.max(0.08,Math.min(1,e.w/100))*alpha,delta=(d-tgt)/d*str*0.5,fx=dx*delta,fy=dy*delta
        if(s.fx===null){s.vx+=fx/s.mass;s.vy+=fy/s.mass}
        if(t.fx===null){t.vx-=fx/t.mass;t.vy-=fy/t.mass}
      }
      for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
        const a=sn[i],b=sn[j],minD=a.radius+b.radius+2,dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||0.01
        if(d<minD){const ovlp=(minD-d)/d*0.5;if(a.fx===null){a.x-=dx*ovlp;a.y-=dy*ovlp}if(b.fx===null){b.x+=dx*ovlp;b.y+=dy*ovlp}}
      }
      for (const nd of sn){
        if(nd.fx!==null){nd.x=nd.fx;nd.y=nd.fy!;continue}
        nd.vx*=0.52;nd.vy*=0.52;nd.x+=nd.vx;nd.y+=nd.vy
        nd.x=Math.max(nd.radius+1,Math.min(99-nd.radius,nd.x));nd.y=Math.max(nd.radius+1,Math.min(99-nd.radius,nd.y))
      }
      alpha-=alpha*0.055
    }
    const m=new Map<string,{x:number,y:number}>()
    sn.forEach(nd=>m.set(nd.id,{x:nd.x,y:nd.y}))
    setSimPositions(m)
  }, [nodes, graphEdges]) // eslint-disable-line react-hooks/exhaustive-deps
  const selectedClusterNode = nodes.find((node) => node.id === selectedClusterNodeId) ?? null
  const relatedEdges = selectedClusterNode ? graphEdges.filter((edge) => edge.source === selectedClusterNode.id || edge.target === selectedClusterNode.id) : []
  const selectedEdgeNodeIds = new Set(relatedEdges.flatMap((edge) => [edge.source, edge.target]))
  const hoveredClusterEdge = graphEdges.find((edge) => edge.id === hoveredClusterEdgeId) ?? null
  const riskTint = summary?.clusterRiskScore == null
    ? 'rgba(148,163,184,.12)'
    : summary.clusterRiskScore <= 20 ? 'rgba(52,211,153,.12)'
    : summary.clusterRiskScore <= 40 ? 'rgba(59,130,246,.12)'
    : summary.clusterRiskScore <= 60 ? 'rgba(251,191,36,.13)'
    : summary.clusterRiskScore <= 80 ? 'rgba(249,115,22,.14)'
    : 'rgba(248,113,113,.16)'
  const riskColor = summary?.clusterRiskScore == null
    ? '#94a3b8'
    : summary.clusterRiskScore <= 20 ? '#34d399'
    : summary.clusterRiskScore <= 40 ? '#60a5fa'
    : summary.clusterRiskScore <= 60 ? '#fbbf24'
    : summary.clusterRiskScore <= 80 ? '#fb923c'
    : '#f87171'
  const clusterInfluence = devIntel?.supplyControl?.clusterInfluence ?? devIntel?.clusterInfluence ?? null
  const riskContextScore = clusterInfluence?.clusterRiskScore ?? summary?.clusterRiskScore ?? null
  const riskContextLabel = clusterInfluence?.clusterRiskLabel ?? summary?.clusterRiskLabel ?? 'open_check'
  const riskContextColor = riskContextLabel === 'critical' || riskContextLabel === 'high'
    ? '#f87171'
    : riskContextLabel === 'watch' || riskContextLabel === 'elevated'
      ? '#fbbf24'
      : riskContextLabel === 'low'
        ? '#34d399'
        : '#94a3b8'

  if (!map || map.status === 'unavailable_with_reason' || nodes.length === 0) {
    return (
      <div style={{ display:'grid', gap:'12px' }}>
        <div style={{ padding:'16px', borderRadius:'14px', background:'rgba(15,23,42,.72)', border:'1px solid rgba(148,163,184,.18)' }}>
          <p style={{ margin:'0 0 6px', fontSize:'10px', letterSpacing:'.14em', color:'#94a3b8', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>CLUSTER MAP</p>
          <p style={{ margin:0, fontSize:'12px', color:'#64748b', fontFamily:'var(--font-plex-mono)', lineHeight:1.6 }}>CORTEX needs more deployer, linked-wallet, or holder evidence before drawing a reliable cluster map.</p>
        </div>
      </div>
    )
  }

  const positionFor = (node: ClusterNode, index: number) => {
    if (node.type === 'deployer') return { x: 50, y: 48 }
    const group = node.type === 'linked_wallet' ? linked : node.type === 'cluster_wallet' ? cluster : holders
    const groupIndex = Math.max(0, group.findIndex((candidate) => candidate.id === node.id))
    const total = Math.max(1, group.length)
    const radius = node.type === 'linked_wallet' ? 24 : node.type === 'cluster_wallet' ? 32 : 42
    const start = node.type === 'holder_wallet' ? -110 : node.type === 'cluster_wallet' ? -40 : -80
    const angle = (start + (360 / total) * groupIndex) * Math.PI / 180
    const centerX = deployer ? 50 : 50
    const centerY = deployer ? 48 : 50
    return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius + (node.type === 'holder_wallet' ? 2 : 0) + (index % 2 ? 0 : 0) }
  }
  const staticPositions = new Map(ordered.map((node, index) => [node.id, positionFor(node, index)]))
  const positions = simPositions.size > 0 ? simPositions : staticPositions
  const nodeColor = (node: ClusterNode) => node.type === 'deployer' ? '#fbbf24' : node.type === 'linked_wallet' ? '#2dd4bf' : node.type === 'cluster_wallet' ? '#e879f9' : '#64748b'
  const nodeBg = (node: ClusterNode) => { const risk = deriveClusterNodeRisk(node, riskContextScore); return CMAP_RISK_BG[risk] }
  const nodeSize = (node: ClusterNode) => Math.min(64, 24 + Math.max(0, node.supplyPercent ?? 0) * 1.1)
  const nodeBorderColor = (node: ClusterNode, isSelected: boolean) => { const risk = deriveClusterNodeRisk(node, riskContextScore); return node.confidence === 'open_check' ? '#64748b' : (isSelected ? CMAP_RISK_COLOR[risk] : nodeColor(node)) }
  const roleLabel = (node: ClusterNode | null) => !node ? 'Unknown wallet' : node.type === 'deployer' ? 'Deployer / origin wallet' : node.type === 'linked_wallet' ? 'Linked wallet' : node.type === 'cluster_wallet' ? 'Cluster wallet' : 'Indexed holder'
  const edgeLabel = (type: string) => type === 'deployer_to_linked' ? 'Deployer transfer link' : type === 'linked_to_cluster' ? 'Linked cluster path' : type === 'holder_overlap' ? 'Holder overlap' : type === 'transfer_signal' ? 'Transfer signal' : type === 'shared_pattern' ? 'Shared pattern' : type === 'weak_heuristic' ? 'Weak heuristic' : type.replace(/_/g, ' ')
  const confidenceCopy = (confidence?: ClusterNode['confidence']) => confidence === 'high'
    ? 'High confidence — this wallet is supported by direct holder, deployer, or transfer evidence.'
    : confidence === 'medium'
      ? 'Medium confidence — this wallet is supported by partial or indirect cluster evidence.'
      : confidence === 'low'
        ? 'Low confidence — this wallet is based on weak or incomplete evidence.'
        : confidence === 'open_check'
          ? 'Open check — CORTEX needs more data before confirming this wallet’s role.'
          : 'Open check — confidence not confirmed.'
  const supplyFor = (node: ClusterNode | null) => {
    if (!node) return null
    if (node.supplyPercent != null) return node.supplyPercent
    const match = holderRows.find((holder) => holder.address?.toLowerCase() === node.address.toLowerCase())
    return match?.percent ?? null
  }
  const holderRankFor = (node: ClusterNode | null) => {
    if (!node) return null
    if (node.rank != null) return node.rank
    const match = holderRows.find((holder) => holder.address?.toLowerCase() === node.address.toLowerCase())
    return match?.rank ?? null
  }
  const supplyLabelForNodeId = (nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId) ?? null
    const supply = supplyFor(node)
    return supply == null ? 'Not indexed' : `${supply.toFixed(1)}%`
  }
  const relationshipLabel = (edge: GraphEdge) => {
    if (edge.color === '#fb7185') return 'Suspicious link'
    if (edge.type === 'transfer_signal' || edge.type === 'deployer_to_linked') return 'Transfer signal'
    if (edge.type === 'linked_to_cluster' || edge.type === 'holder_overlap') return 'Cluster link'
    if (edge.type === 'shared_pattern' || edge.type === 'weak_heuristic') return 'Shared pattern'
    return edgeLabel(edge.type)
  }
  const suspiciousGraphEdges = graphEdges.filter(isSuspiciousGraphEdge).sort((a, b) => (confidenceRank(b.confidence) * 100 + b.weight) - (confidenceRank(a.confidence) * 100 + a.weight))
  const animatedSuspiciousEdgeIds = new Set(suspiciousGraphEdges.slice(0, 12).map((edge) => edge.id))
  const clusterBehaviorSignals = [...(clusterInfluence?.signals ?? []), ...(map.signals ?? [])]
  const walletBehaviorByNodeId = (() => {
    const entries = nodes.map((node) => {
      const nodeEdges = graphEdges.filter((edge) => edge.source === node.id || edge.target === node.id)
      return [node.id, deriveWalletBehavior(node, nodeEdges, nodes, Boolean(devIntel?.suspiciousTransfers), clusterBehaviorSignals)] as const
    })
    return new Map(entries)
  })()
  const selectedWalletBehavior = selectedClusterNode ? walletBehaviorByNodeId.get(selectedClusterNode.id) ?? null : null

  const deployerLineage: DeployerLineage = (() => {
    const deployerNode = nodes.find((node) => node.type === 'deployer' || node.isCreator) ?? null
    if (!deployerNode) {
      return { status: 'unavailable_with_reason', deployer: null, directLinkedWallets: [], secondLayerWallets: [], relatedHolderWallets: [], lineageEdges: [], summary: { directLinks: 0, secondLayerLinks: 0, suspiciousLinks: 0, linkedSupplyPercent: null, clusterSupplyPercent: summary?.clusterSupplyPercent ?? null, riskLabel: 'Open check', reason: 'No deployer wallet is available in this pass.' } }
    }
    const directlyTouchedIds = new Set(graphEdges.filter((edge) => edge.source === deployerNode.id || edge.target === deployerNode.id).flatMap((edge) => [edge.source, edge.target]).filter((id) => id !== deployerNode.id))
    const directLinkedWallets = uniqueById(nodes.filter((node) => node.id !== deployerNode.id && (directlyTouchedIds.has(node.id) || node.isLinked || node.type === 'linked_wallet')))
    const directIds = new Set(directLinkedWallets.map((node) => node.id))
    const secondLayerWallets = uniqueById(graphEdges.flatMap((edge) => {
      const touchesDirect = directIds.has(edge.source) || directIds.has(edge.target)
      if (!touchesDirect) return []
      const otherId = directIds.has(edge.source) ? edge.target : edge.source
      const other = nodes.find((node) => node.id === otherId)
      return other && other.id !== deployerNode.id && !directIds.has(other.id) && (other.type === 'cluster_wallet' || other.type === 'linked_wallet') ? [other] : []
    }))
    const lineageCoreIds = new Set([deployerNode.id, ...directLinkedWallets.map((node) => node.id), ...secondLayerWallets.map((node) => node.id)])
    const relatedHolderWallets = uniqueById(graphEdges.flatMap((edge) => {
      const source = nodes.find((node) => node.id === edge.source)
      const target = nodes.find((node) => node.id === edge.target)
      if (source?.type === 'holder_wallet' && lineageCoreIds.has(edge.target)) return [source]
      if (target?.type === 'holder_wallet' && lineageCoreIds.has(edge.source)) return [target]
      return []
    }))
    const lineageIds = new Set([...lineageCoreIds, ...relatedHolderWallets.map((node) => node.id)])
    const lineageEdges = graphEdges.filter((edge) => lineageIds.has(edge.source) && lineageIds.has(edge.target))
    const linkedSupply = directLinkedWallets.reduce((sum, node) => sum + (node.supplyPercent ?? 0), 0)
    const suspiciousLinks = lineageEdges.filter(isSuspiciousGraphEdge).length
    // LINEAGE-LINKED-SUPPLY FIX, DISCLOSED: this used to only look at directLinkedWallets graph
    // nodes, so when the cluster map has zero linked-wallet nodes (a real, confirmed "no linked
    // wallets found" result, not missing data) it showed "Open check" instead of the true 0%. The
    // backend (app/api/token/route.ts) already computes this authoritatively — including the
    // confirmed-zero case — and passes it down as devIntel.supplyControl.linkedWalletSupplyPercent /
    // devIntel.linkedWalletSupplyPercent. Prefer that known value; only fall back to summing the
    // graph nodes locally (and only showing a result once at least one has a known percent) when the
    // backend genuinely didn't resolve a value.
    const knownLinkedSupplyPercent = devIntel?.supplyControl?.linkedWalletSupplyPercent ?? devIntel?.linkedWalletSupplyPercent ?? null
    const linkedSupplyPercent = knownLinkedSupplyPercent != null
      ? knownLinkedSupplyPercent
      : directLinkedWallets.some((node) => node.supplyPercent != null) ? linkedSupply : null
    return {
      status: lineageEdges.length > 0 ? map.status : 'partial',
      deployer: deployerNode,
      directLinkedWallets,
      secondLayerWallets,
      relatedHolderWallets,
      lineageEdges,
      summary: {
        directLinks: directLinkedWallets.length,
        secondLayerLinks: secondLayerWallets.length,
        suspiciousLinks,
        linkedSupplyPercent,
        clusterSupplyPercent: summary?.clusterSupplyPercent ?? null,
        riskLabel: suspiciousLinks > 0 || (summary?.clusterRiskLabel === 'critical' || summary?.clusterRiskLabel === 'high') ? 'Elevated lineage watch' : lineageEdges.length > 0 ? 'Lineage mapped' : 'Open check',
        reason: lineageEdges.length > 0 ? 'Lineage uses only deployer, linked-wallet, cluster-wallet, holder, and edge evidence already in the cluster map.' : 'No lineage edges confirmed in this pass. Other contracts not available in this pass.',
      },
    }
  })()

  const clusterTimeline: ClusterTimeline = (() => {
    type Timestamped = { timestamp?: unknown; createdAt?: unknown; firstSeenAt?: unknown }
    const readTimestamp = (item: Timestamped): string | null => {
      const raw = item.timestamp ?? item.createdAt ?? item.firstSeenAt
      return typeof raw === 'string' && raw.trim() ? raw : null
    }
    const events: ClusterTimelineEvent[] = []
    const deployerNode = nodes.find((node) => node.type === 'deployer' || node.isCreator) ?? null
    if (deployerNode) events.push({ id: `timeline:${deployerNode.id}:deployer`, label: 'Deployer resolved', description: 'Origin wallet identified from Dev Control evidence.', timestamp: readTimestamp(deployerNode as Timestamped), order: 1, type: 'deployer_resolved', severity: deployerNode.confidence === 'high' ? 'low' : 'medium', relatedWallets: [deployerNode.address] })
    nodes.filter((node) => node.isLinked || node.type === 'linked_wallet').slice(0, 8).forEach((node, index) => events.push({ id: `timeline:${node.id}:linked`, label: 'Linked wallet detected', description: 'Wallet linked to deployer/cluster evidence.', timestamp: readTimestamp(node as Timestamped), order: 20 + index, type: 'linked_wallet_detected', severity: node.confidence === 'medium' || node.confidence === 'high' ? 'medium' : 'low', relatedWallets: [node.address] }))
    if (summary?.clusterSupplyPercent != null) events.push({ id: 'timeline:supply-confirmed', label: 'Cluster supply checked', description: summary.clusterSupplyPercent > 0 ? `Cluster supply detected at ${summary.clusterSupplyPercent.toFixed(1)}%.` : 'No cluster supply found in indexed holders.', timestamp: null, order: 40, type: 'supply_confirmed', severity: summary.clusterSupplyPercent >= 20 ? 'high' : summary.clusterSupplyPercent > 0 ? 'medium' : 'low', relatedWallets: [] })
    graphEdges.slice(0, 10).forEach((edge, index) => {
      const source = nodes.find((node) => node.id === edge.source)
      const target = nodes.find((node) => node.id === edge.target)
      events.push({ id: `timeline:${edge.id}:edge`, label: edgeLabel(edge.type), description: edge.reason, timestamp: readTimestamp(edge as Timestamped), order: 60 + index, type: 'cluster_edge_detected', severity: edgeSeverity(edge), relatedWallets: [source?.address, target?.address].filter((value): value is string => Boolean(value)) })
    })
    const suspiciousEdge = suspiciousGraphEdges[0]
    if (devIntel?.suspiciousTransfers || suspiciousEdge) events.push({ id: 'timeline:suspicious-burst', label: 'Suspicious transfer burst', description: suspiciousEdge?.reason ?? devIntel?.suspiciousTransferReasons?.[0] ?? 'Suspicious transfer pattern detected from existing Dev Control evidence.', timestamp: suspiciousEdge ? readTimestamp(suspiciousEdge as Timestamped) : null, order: 90, type: 'suspicious_burst', severity: 'high', relatedWallets: suspiciousEdge ? [nodes.find((node) => node.id === suspiciousEdge.source)?.address, nodes.find((node) => node.id === suspiciousEdge.target)?.address].filter((value): value is string => Boolean(value)) : [] })
    if (events.length === 0) events.push({ id: 'timeline:open-check', label: 'More evidence needed', description: 'CORTEX needs more deployer, transfer, or holder evidence before building a behavior timeline.', timestamp: null, order: 99, type: 'open_check', severity: 'open_check', relatedWallets: [] })
    const hasTimestamp = events.some((event) => event.timestamp)
    const sorted = [...events].sort((a, b) => {
      if (hasTimestamp) {
        if (a.timestamp && b.timestamp) return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        if (a.timestamp) return -1
        if (b.timestamp) return 1
      }
      return a.order - b.order
    })
    return { status: events[0]?.type === 'open_check' ? 'unavailable_with_reason' : map.status, mode: hasTimestamp ? 'timestamped' : events[0]?.type === 'open_check' ? 'open_check' : 'ordered', events: sorted.slice(0, 14) }
  })()

  // PERF FIX, DISCLOSED (audit: mousemove over cluster-map edges forced a layout read via
  // getBoundingClientRect() plus two setStates on every pointer sample — mousemove can fire at
  // well over 60/s, so this was doing a forced reflow far more often than the screen can even
  // repaint). rAF-throttled to at most once per frame; the trailing move always wins so the
  // tooltip still tracks the cursor smoothly. (edgePointerRaf itself is declared above, before the
  // early-return guard — see the rules-of-hooks fix note there.)
  const handleEdgePointer = (edgeId: string, event: MouseEvent<SVGPathElement>) => {
    event.stopPropagation()
    const svg = event.currentTarget.ownerSVGElement
    const clientX = event.clientX
    const clientY = event.clientY
    if (edgePointerRaf.current != null) cancelAnimationFrame(edgePointerRaf.current)
    edgePointerRaf.current = requestAnimationFrame(() => {
      edgePointerRaf.current = null
      const rect = svg?.getBoundingClientRect()
      setHoveredClusterEdgeId(edgeId)
      setEdgeTooltipPosition(rect ? { x: clientX - rect.left + 12, y: clientY - rect.top + 12 } : null)
    })
  }
  const clearEdgeHover = () => {
    setHoveredClusterEdgeId(null)
    setEdgeTooltipPosition(null)
  }
  const walletSignalMatches = (node: ClusterNode, signal: string) => {
    const lower = signal.toLowerCase()
    const short = fmt(node.address).toLowerCase()
    return lower.includes(node.address.toLowerCase()) || lower.includes(short) ||
      (node.type === 'deployer' && lower.includes('deployer')) ||
      (node.isLinked && lower.includes('linked wallet')) ||
      (node.isCluster && lower.includes('cluster')) ||
      (node.type === 'holder_wallet' && lower.includes('holder'))
  }
  const walletSignals = selectedClusterNode ? [
    ...(selectedClusterNode.reasons ?? []),
    ...((clusterInfluence?.signals ?? []).filter((signal) => walletSignalMatches(selectedClusterNode, signal))),
    ...((map.signals ?? []).filter((signal) => walletSignalMatches(selectedClusterNode, signal))),
  ].filter((signal, index, all) => signal && all.indexOf(signal) === index) : []
  const fundingSource = selectedClusterNode ? [
    ...(selectedClusterNode.reasons ?? []),
    ...relatedEdges.map((edge) => edge.reason),
  ].find((reason) => /fund|transfer|deployer|source/i.test(reason)) : null
  const supplyPercent = supplyFor(selectedClusterNode)
  const holderRank = holderRankFor(selectedClusterNode)
  const walletEvidence = classifyTokenScannerEvidence({
    holdersVerified: holdersAreVerified,
    holderRows,
    deployerAddress: devIntel?.originAddress ?? devIntel?.deployerAddress ?? selectedClusterNode?.address ?? null,
    selectedWallet: selectedClusterNode?.address ?? null,
    graphStatus: clusterAudit?.linkedWalletGraph.graphStatus ?? null,
    graphFailureReason: clusterAudit?.linkedWalletGraph.failureReason ?? null,
    walletsMapped: clusterAudit?.linkedWalletGraph.walletsMapped ?? null,
    chainId: tokenScannerEvidenceChainId(chain, null),
    chainSlug: chain ?? null,
  })
  const openChecks = selectedClusterNode && selectedClusterNode.type !== 'deployer' ? [
    ...(supplyPercent == null ? [holdersAreVerified ? walletEvidence.labels.walletSupply : 'Wallet not indexed in this pass.'] : []),
    ...(map.status === 'partial' ? ['Some wallet data may be incomplete.'] : []),
    ...(selectedClusterNode.confidence === 'open_check' && !holdersAreVerified ? ['CORTEX needs more holder or transfer evidence before confirming cluster influence.'] : []),
    ...(relatedEdges.length === 0 ? [walletEvidence.labels.linkedWallets.includes('Linked wallet graph not run') ? walletEvidence.labels.linkedWallets : 'No transfer edge confirmed for this wallet.'] : []),
  ] : []

  // DEPLOYER-WALLET-DETAIL FIX, DISCLOSED: the deployer/origin node is the one node type this task
  // requires real intelligence for — resolveDeployerWalletIntel assembles it purely from evidence
  // already fetched for this scan (Dev Control's supplyControl/linkedWallets/previousProjects, the
  // holder snapshot, and the cluster graph's own edges), plus the cheap live-balance result above.
  // Never runs the full Wallet Scanner and never fabricates a supply position or transfer link.
  const isDeployerSelected = selectedClusterNode?.type === 'deployer'
  const deployerIntelResult = isDeployerSelected && selectedClusterNode ? resolveDeployerWalletIntel({
    chainSlug: chain ?? 'base',
    chainId: tokenScannerEvidenceChainId(chain, null),
    tokenAddress: tokenAddress ?? '',
    tokenSymbol: tokenSymbol ?? null,
    tokenName: tokenName ?? null,
    deployerAddress: selectedClusterNode.address,
    existingScannerResult: { deployerAddress: devIntel?.deployerAddress ?? null },
    holderSnapshot: { available: holderRows.length > 0, topHolders: holderRows.map(h => ({ address: h.address ?? '', rank: h.rank ?? null, percent: h.percent ?? null })) },
    transferEdges: graphEdges.map(e => ({ source: e.source, target: e.target, type: e.type, reason: e.reason, confidence: e.confidence })),
    clusterMap: { nodes: nodes.map(n => ({ address: n.address, id: n.id })) },
    devControlResult: devIntel ? {
      supplyControl: devIntel.supplyControl ?? null,
      linkedWallets: devIntel.linkedWallets ?? null,
      previousActivityAvailable: devIntel.previousActivityAvailable ?? null,
      previousActivityStatus: devIntel.previousActivityStatus ?? null,
      previousProjects: devIntel.previousProjects ?? null,
      suspiciousTransfers: devIntel.suspiciousTransfers ?? null,
      suspiciousTransferReasons: devIntel.suspiciousTransferReasons ?? null,
    } : null,
    cheapBalance: deployerCheapBalance,
    holdersVerified: holdersAreVerified,
    linkedWalletGraph: clusterAudit?.linkedWalletGraph ?? null,
  }) : null
  const deployerIntel = deployerIntelResult?.intel ?? null

  // LINEAGE-CARD-DEPLOYER-INTEL, DISCLOSED: the "DEPLOYER LINEAGE" card below is always visible
  // (not gated on node selection), so it needs its own resolver pass keyed off the graph's own
  // deployer node rather than whichever node the user has clicked — same resolver, same evidence.
  const lineageDeployerNode = deployerLineage.deployer
  const lineageDeployerIntel = lineageDeployerNode ? resolveDeployerWalletIntel({
    chainSlug: chain ?? 'base',
    chainId: tokenScannerEvidenceChainId(chain, null),
    tokenAddress: tokenAddress ?? '',
    tokenSymbol: tokenSymbol ?? null,
    tokenName: tokenName ?? null,
    deployerAddress: lineageDeployerNode.address,
    existingScannerResult: { deployerAddress: devIntel?.deployerAddress ?? null },
    holderSnapshot: { available: holderRows.length > 0, topHolders: holderRows.map(h => ({ address: h.address ?? '', rank: h.rank ?? null, percent: h.percent ?? null })) },
    transferEdges: graphEdges.map(e => ({ source: e.source, target: e.target, type: e.type, reason: e.reason, confidence: e.confidence })),
    clusterMap: { nodes: nodes.map(n => ({ address: n.address, id: n.id })) },
    devControlResult: devIntel ? {
      supplyControl: devIntel.supplyControl ?? null,
      linkedWallets: devIntel.linkedWallets ?? null,
      previousActivityAvailable: devIntel.previousActivityAvailable ?? null,
      previousActivityStatus: devIntel.previousActivityStatus ?? null,
      previousProjects: devIntel.previousProjects ?? null,
      suspiciousTransfers: devIntel.suspiciousTransfers ?? null,
      suspiciousTransferReasons: devIntel.suspiciousTransferReasons ?? null,
    } : null,
    cheapBalance: isDeployerSelected ? deployerCheapBalance : null,
    holdersVerified: holdersAreVerified,
    linkedWalletGraph: clusterAudit?.linkedWalletGraph ?? null,
  }).intel : null

  return (
    <div style={{ display:'grid', gap:'12px' }}>
      <div>
        <p style={{ margin:'0 0 5px', fontSize:'14px', color:'#e2e8f0', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>Cluster Map</p>
        <p style={{ margin:'0 0 8px', fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>Wallet relationship graph across deployer, linked wallets, and indexed holders. Click a node to inspect wallet-level evidence.</p>
        {/* DEV-GRAPH-TAKEAWAY, DISCLOSED (Token Scanner section-readability polish task, explicitly
            requested: "add a clearer one-line trader takeaway above or beside the graph, based on
            existing data only"): built entirely from counts already derived above (linked/cluster
            node arrays, suspiciousGraphEdges) — no new evidence, no new fields. */}
        <div style={{ display:'inline-flex', alignItems:'center', gap:'7px', padding:'6px 12px', borderRadius:'999px', background: suspiciousGraphEdges.length > 0 ? 'rgba(251,113,133,0.08)' : (linked.length > 0 || cluster.length > 0) ? 'rgba(251,191,36,0.08)' : 'rgba(52,211,153,0.08)', border: `1px solid ${suspiciousGraphEdges.length > 0 ? 'rgba(251,113,133,0.28)' : (linked.length > 0 || cluster.length > 0) ? 'rgba(251,191,36,0.28)' : 'rgba(52,211,153,0.28)'}` }}>
          <span style={{ width:6, height:6, borderRadius:'50%', flexShrink:0, background: suspiciousGraphEdges.length > 0 ? '#fb7185' : (linked.length > 0 || cluster.length > 0) ? '#fbbf24' : '#34d399' }} />
          <span style={{ fontSize:'10.5px', fontWeight:700, color: suspiciousGraphEdges.length > 0 ? '#fca5b5' : (linked.length > 0 || cluster.length > 0) ? '#fde68a' : '#86efac', fontFamily:'var(--font-plex-mono)' }}>
            {suspiciousGraphEdges.length > 0
              ? `${suspiciousGraphEdges.length} suspicious wallet link${suspiciousGraphEdges.length === 1 ? '' : 's'} detected in indexed evidence.`
              : (linked.length + cluster.length) > 0
                ? `${linked.length + cluster.length} linked/cluster wallet${(linked.length + cluster.length) === 1 ? '' : 's'} mapped — no suspicious transfer pattern flagged.`
                : 'No linked dev-wallet cluster detected in indexed evidence.'}
          </span>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:selectedClusterNodeId ? 'repeat(auto-fit,minmax(min(100%,280px),1fr))' : 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap:'12px', alignItems:'start' }}>
        <div ref={clusterGraphRef} onClick={() => { setSelectedClusterNodeId(null); setHoveredClusterNodeId(null); setClusterTooltipPos(null); clearEdgeHover() }} onMouseMove={e => { if (!clusterIsTouch.current && hoveredClusterNodeId) { const r = clusterGraphRef.current?.getBoundingClientRect(); if (r) setClusterTooltipPos({x:e.clientX-r.left,y:e.clientY-r.top}) } }} style={{ position:'relative', minHeight:'390px', borderRadius:'16px', overflow:'hidden', background:`radial-gradient(circle at 50% 48%, ${riskTint}, transparent 42%), linear-gradient(145deg, rgba(3,10,24,.98), rgba(8,16,32,.95))`, border:'1px solid rgba(125,211,252,.16)' }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position:'absolute', inset:0, width:'100%', height:'100%', zIndex:1 }}>
            {graphEdges.map((edge) => {
              const source = positions.get(edge.source)
              const target = positions.get(edge.target)
              if (!source || !target) return null
              const isConnected = selectedClusterNodeId != null && (edge.source === selectedClusterNodeId || edge.target === selectedClusterNodeId)
              const isHoverConn = hoveredClusterNodeId != null && (edge.source === hoveredClusterNodeId || edge.target === hoveredClusterNodeId)
              const isEdgeHovered = hoveredClusterEdgeId === edge.id
              const midX = (source.x + target.x) / 2
              const midY = (source.y + target.y) / 2
              const dx = target.x - source.x
              const dy = target.y - source.y
              const length = Math.max(1, Math.sqrt(dx * dx + dy * dy))
              const curve = Math.min(8, Math.max(3, length * 0.08))
              const controlX = midX - (dy / length) * curve
              const controlY = midY + (dx / length) * curve
              const path = `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`
              const suspiciousEdge = isSuspiciousGraphEdge(edge)
              const isAnimatedSuspiciousEdge = suspiciousEdge && animatedSuspiciousEdgeIds.has(edge.id)
              const isSuspiciousUnrelatedSelection = Boolean(selectedClusterNodeId && !isConnected)
              const suspiciousBaseOpacity = edge.confidence === 'high' ? 1 : edge.confidence === 'medium' ? 0.65 : 0.35
              const strokeOpacity = selectedClusterNodeId ? (isConnected ? Math.max(suspiciousBaseOpacity, 0.72) : 0.12) : hoveredClusterNodeId ? (isHoverConn ? 0.85 : 0.15) : suspiciousEdge ? suspiciousBaseOpacity : edge.opacity
              const strokeWidth = clamp(edge.width + (isConnected || isHoverConn || isEdgeHovered ? 1 : 0), 1, 5.5)
              const dashClass = edge.weight >= 61 ? 'cluster-flow-strong' : edge.weight >= 31 ? 'cluster-flow-medium' : 'cluster-flow-faint'
              return (
                <g key={edge.id}>
                  <path d={path} fill="none" stroke={suspiciousEdge ? '#fb7185' : isConnected || isEdgeHovered ? '#e0f2fe' : edge.color} strokeWidth={strokeWidth} strokeOpacity={strokeOpacity} strokeLinecap="round" strokeDasharray={edge.type === 'weak_heuristic' ? '2 2' : undefined} style={{ filter: suspiciousEdge || isConnected || isEdgeHovered ? `drop-shadow(0 0 ${isEdgeHovered ? 12 : edge.weight >= 61 ? 9 : 5}px ${suspiciousEdge ? 'rgba(251,113,133,.55)' : edge.color})` : undefined }} />
                  {isAnimatedSuspiciousEdge && (
                    <path d={path} className={`cluster-suspicious-flow ${dashClass}`} fill="none" stroke="#fb7185" strokeWidth={clamp(strokeWidth + 0.8, 1.5, 6)} strokeOpacity={isSuspiciousUnrelatedSelection ? 0.12 : isEdgeHovered ? 0.95 : strokeOpacity} strokeLinecap="round" strokeDasharray={edge.weight >= 61 ? '5 8' : edge.weight >= 31 ? '4 10' : '2 14'} style={{ animationPlayState: isSuspiciousUnrelatedSelection ? 'paused' : undefined }} />
                  )}
                  <path d={path} fill="none" stroke="transparent" strokeWidth={12} strokeLinecap="round" style={{ pointerEvents:'stroke', cursor:'help' }} onMouseEnter={(event) => handleEdgePointer(edge.id, event)} onMouseMove={(event) => handleEdgePointer(edge.id, event)} onMouseLeave={clearEdgeHover} onClick={(event) => event.stopPropagation()} />
                </g>
              )
            })}
          </svg>
          {(edges.length === 0 || graphEdges.length === 0) && (
            <div style={{ position:'absolute', top:'12px', left:'12px', zIndex:4, maxWidth:'260px', padding:'8px 10px', borderRadius:'11px', background:'rgba(2,6,23,.78)', border:'1px solid rgba(148,163,184,.18)', color:'#94a3b8', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>
              {edges.length === 0 ? 'No transfer edges confirmed in this pass.' : 'Cluster edge data could not be matched to visible nodes.'}
            </div>
          )}
          {hoveredClusterNodeId && clusterTooltipPos && (() => {
            const hNode = nodes.find(n => n.id === hoveredClusterNodeId)
            if (!hNode) return null
            const risk = deriveClusterNodeRisk(hNode, riskContextScore)
            const hSupply = supplyFor(hNode)
            return (
              <div style={{ position:'absolute', left:Math.min(clusterTooltipPos.x+14,240), top:Math.max(clusterTooltipPos.y-96,8), pointerEvents:'none', zIndex:20, padding:'10px 13px', borderRadius:'10px', background:'rgba(6,11,22,0.97)', border:`1px solid ${nodeColor(hNode)}40`, minWidth:'162px', boxShadow:'0 4px 18px rgba(0,0,0,.55)' }}>
                <div style={{ fontSize:'8px', letterSpacing:'.14em', fontWeight:700, color:nodeColor(hNode), fontFamily:'var(--font-plex-mono)', marginBottom:'8px' }}>{(roleLabel(hNode)).toUpperCase()}</div>
                <div style={{ marginBottom:'5px' }}><div style={{ fontSize:'8px', color:'#475569', fontFamily:'var(--font-plex-mono)' }}>Address</div><div style={{ fontSize:'10px', color:'#e2e8f0', fontFamily:'var(--font-plex-mono)', fontWeight:600 }}>{fmt(hNode.address)}</div></div>
                <div style={{ marginBottom:'5px' }}><div style={{ fontSize:'8px', color:'#475569', fontFamily:'var(--font-plex-mono)' }}>Supply</div><div style={{ fontSize:'10px', color:'#e2e8f0', fontFamily:'var(--font-plex-mono)', fontWeight:600 }}>{hSupply!=null?`${hSupply.toFixed(1)}%`:'Not indexed in this pass'}</div></div>
                <div style={{ display:'flex', gap:'12px' }}>
                  <div><div style={{ fontSize:'8px', color:'#475569', fontFamily:'var(--font-plex-mono)' }}>Risk</div><div style={{ fontSize:'10px', color:CMAP_RISK_COLOR[risk], fontFamily:'var(--font-plex-mono)', fontWeight:700 }}>{risk==='open_check'?'Open check':risk.charAt(0).toUpperCase()+risk.slice(1)}</div></div>
                  <div><div style={{ fontSize:'8px', color:'#475569', fontFamily:'var(--font-plex-mono)' }}>Confidence</div><div style={{ fontSize:'10px', color:hNode.confidence==='high'?'#34d399':hNode.confidence==='medium'?'#fbbf24':'#94a3b8', fontFamily:'var(--font-plex-mono)', fontWeight:600 }}>{hNode.confidence==='open_check'?'Open check':hNode.confidence.charAt(0).toUpperCase()+hNode.confidence.slice(1)}</div></div>
                </div>
              </div>
            )
          })()}
          {hoveredClusterEdge && edgeTooltipPosition && (
            <div style={{ position:'absolute', left:edgeTooltipPosition.x, top:edgeTooltipPosition.y, zIndex:5, width:'min(280px, calc(100% - 24px))', padding:'10px 11px', borderRadius:'12px', background:'rgba(3,10,24,.96)', border:`1px solid ${hoveredClusterEdge.color}55`, boxShadow:'0 16px 38px rgba(0,0,0,.45)', pointerEvents:'none', fontFamily:'var(--font-plex-mono)' }}>
              <p style={{ margin:'0 0 8px', color:'#e2e8f0', fontSize:'10px', fontWeight:900 }}>{fmt(nodes.find((node) => node.id === hoveredClusterEdge.source)?.address)} → {fmt(nodes.find((node) => node.id === hoveredClusterEdge.target)?.address)}</p>
              {[
                ['Relationship', relationshipLabel(hoveredClusterEdge)],
                ['Reason', hoveredClusterEdge.reason],
                ['Weight', `${Math.round(hoveredClusterEdge.weight)}/100`],
                ['Confidence', hoveredClusterEdge.confidence.charAt(0).toUpperCase() + hoveredClusterEdge.confidence.slice(1)],
                ['Source supply', supplyLabelForNodeId(hoveredClusterEdge.source)],
                ['Target supply', supplyLabelForNodeId(hoveredClusterEdge.target)],
              ].map(([label, value]) => (
                <div key={label} style={{ display:'grid', gridTemplateColumns:'88px 1fr', gap:'8px', padding:'3px 0', borderTop:'1px solid rgba(148,163,184,.08)' }}>
                  <span style={{ color:'#64748b', fontSize:'9px' }}>{label}</span>
                  <span style={{ color:'#cbd5e1', fontSize:'9px', lineHeight:1.35 }}>{value}</span>
                </div>
              ))}
            </div>
          )}
          {ordered.map((node) => {
            const pos = positions.get(node.id) ?? { x: 50, y: 50 }
            const size = nodeSize(node)
            const color = nodeColor(node)
            const isSelected = node.id === selectedClusterNodeId
            const isHovered = node.id === hoveredClusterNodeId
            const isDimmed = (selectedClusterNodeId != null && !isSelected && !selectedEdgeNodeIds.has(node.id)) || (hoveredClusterNodeId != null && !isHovered && !selectedEdgeNodeIds.has(node.id) && selectedClusterNodeId == null)
            const risk = deriveClusterNodeRisk(node, riskContextScore)
            const riskBorderColor = nodeBorderColor(node, isSelected)
            const behavior = walletBehaviorByNodeId.get(node.id)
            const badge = behavior ? behaviorBadgeMeta(behavior.label) : null
            return (
              <button key={node.id} type="button"
                onClick={(event) => { event.stopPropagation(); setSelectedClusterNodeId(node.id); setHoveredClusterNodeId(null); setClusterTooltipPos(null) }}
                onMouseEnter={e => { if (clusterIsTouch.current) return; setHoveredClusterNodeId(node.id); const r=clusterGraphRef.current?.getBoundingClientRect(); if(r) setClusterTooltipPos({x:e.clientX-r.left,y:e.clientY-r.top}) }}
                onMouseLeave={() => { setHoveredClusterNodeId(null); setClusterTooltipPos(null) }}
                title={`${node.address} — ${node.reasons.join(' ')}`}
                style={{ position:'absolute', left:`${pos.x}%`, top:`${pos.y}%`, transform:'translate(-50%,-50%)', display:'grid', placeItems:'center', gap:'4px', zIndex:isHovered||isSelected?4:2, opacity:isDimmed ? 0.28 : 1, background:'transparent', border:0, padding:0, cursor:'pointer', textAlign:'center' }}>
                <div style={{ width:size, height:size, borderRadius:'999px', background:nodeBg(node), border:`${isSelected?3:isHovered?2.5:2}px solid ${riskBorderColor}`, boxShadow:isSelected?`0 0 0 5px ${CMAP_RISK_COLOR[risk]}22, 0 0 26px ${CMAP_RISK_COLOR[risk]}aa`:isHovered?`0 0 0 3px ${CMAP_RISK_COLOR[risk]}22, 0 0 14px ${CMAP_RISK_COLOR[risk]}77`:risk==='high'?`0 0 14px ${CMAP_RISK_COLOR.high}66`:'none', display:'grid', placeItems:'center', color, fontSize:'10px', fontWeight:900, fontFamily:'var(--font-plex-mono)' }}>{node.type === 'deployer' ? 'D' : node.type === 'linked_wallet' ? 'L' : node.type === 'cluster_wallet' ? 'C' : 'H'}</div>
                {badge && <span title={behaviorTitle(behavior?.label ?? 'neutral')} style={{ position:'absolute', top:-5, right:-5, width:18, height:18, borderRadius:'999px', display:'grid', placeItems:'center', background:badge.bg, border:`1px solid ${badge.color}88`, color:badge.color, fontSize:'9px', fontWeight:900, fontFamily:'var(--font-plex-mono)', boxShadow:`0 0 12px ${badge.color}44` }}>{badge.badge}</span>}
                <div style={{ padding:'2px 6px', borderRadius:'999px', background:'rgba(2,6,23,.86)', border:`1px solid ${CMAP_RISK_COLOR[risk]}44`, color:'#cbd5e1', fontSize:'9px', fontWeight:700, fontFamily:'var(--font-plex-mono)', whiteSpace:'nowrap' }}>{node.label === 'Deployer' ? 'Deployer' : fmt(node.address)}</div>
                {node.supplyPercent != null && <div style={{ color:CMAP_RISK_COLOR[risk], fontSize:'9px', fontFamily:'var(--font-plex-mono)', fontWeight:800 }}>{node.supplyPercent.toFixed(1)}%</div>}
              </button>
            )
          })}
          <div style={{ position:'absolute', left:'12px', bottom:'12px', display:'flex', flexWrap:'wrap', gap:'6px', zIndex:3 }}>
            {([['#34d399','Low risk'],['#facc15','Med/pattern'],['#fb7185','High/susp'],['#a855f7','Open check'],['#fbbf24','Deployer'],['#2dd4bf','Linked'],['#e879f9','Cluster'],['#38bdf8','Transfer edge']] as [string,string][]).map(([color,label]) => <span key={label} style={{ display:'inline-flex', alignItems:'center', gap:'5px', padding:'4px 7px', borderRadius:'999px', background:'rgba(2,6,23,.72)', border:'1px solid rgba(148,163,184,.16)', color:'#94a3b8', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}><i style={{ width:7, height:7, borderRadius:'50%', background:color }} />{label}</span>)}
          </div>
        </div>
        <div style={{ display:'grid', gap:'10px', alignContent:'start' }}>
          <div style={{ padding:'13px 14px', borderRadius:'13px', background:'rgba(9,15,29,.86)', border:`1px solid ${riskColor}55` }}>
            <p style={{ margin:'0 0 8px', fontSize:'9px', letterSpacing:'.14em', color:riskColor, fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>CLUSTER SUMMARY</p>
            {[
              ['Cluster supply', summary?.clusterSupplyPercent != null ? `${summary.clusterSupplyPercent.toFixed(1)}%` : (holdersAreVerified ? 'Dev supply not checked — deployer not resolved' : 'Needs holder evidence')],
              ['Dominance', summary?.clusterDominance ?? 'unknown'],
              ['Risk score', summary?.clusterRiskScore != null ? `${summary.clusterRiskScore}/100` : 'Not verified'],
              ['Nodes / Edges', `${summary?.totalNodes ?? nodes.length} / ${graphEdges.length}`],
              ['Confidence', canonicalLabel(map.status)],
            ].map(([label, value]) => <div key={label} style={{ display:'flex', justifyContent:'space-between', gap:'10px', padding:'6px 0', borderBottom:'1px solid rgba(148,163,184,.08)' }}><span style={{ fontSize:'10px', color:'#64748b', fontFamily:'var(--font-plex-mono)' }}>{label}</span><span style={{ fontSize:'10px', color:'#e2e8f0', fontWeight:800, fontFamily:'var(--font-plex-mono)', textTransform:label === 'Dominance' ? 'uppercase' : undefined }}>{value}</span></div>)}
            <p style={{ margin:'10px 0 0', fontSize:'10px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>{summary?.reason}</p>
            {(edges.length === 0 || graphEdges.length === 0) && <p style={{ margin:'8px 0 0', fontSize:'10px', color:'#7dd3fc', fontFamily:'var(--font-plex-mono)', lineHeight:1.45 }}>{edges.length === 0 ? 'No transfer edges confirmed in this pass.' : 'Cluster edge data could not be matched to visible nodes.'}</p>}
          </div>
          <div style={{ padding:'13px 14px', borderRadius:'13px', background:'rgba(15,23,42,.58)', border:'1px solid rgba(125,211,252,.14)' }}>
            <p style={{ margin:'0 0 8px', fontSize:'9px', letterSpacing:'.14em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>SIGNALS</p>
            {(map.signals.length > 0 ? map.signals : ['Holder evidence incomplete']).slice(0, 5).map((signal, index) => <p key={signal + index} style={{ margin:'0 0 6px', color:'#cbd5e1', fontSize:'10px', fontFamily:'var(--font-plex-mono)', lineHeight:1.45 }}>› {signal}</p>)}
          </div>
        </div>
        {selectedClusterNodeId && (
          <aside style={{ alignSelf:'stretch', maxHeight:'560px', overflowY:'auto', padding:'14px', borderRadius:'16px', background:'linear-gradient(145deg, rgba(2,8,23,.96), rgba(12,18,38,.94))', border:'1px solid rgba(125,211,252,.24)', boxShadow:'0 18px 52px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.04)' }}>
            {!selectedClusterNode ? (
              <p style={{ margin:0, color:'#94a3b8', fontSize:'11px', fontFamily:'var(--font-plex-mono)' }}>Wallet detail unavailable for this node.</p>
            ) : (
              <div style={{ display:'grid', gap:'12px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', gap:'12px', alignItems:'flex-start' }}>
                  <div>
                    <p style={{ margin:'0 0 7px', color:'#e2e8f0', fontSize:'14px', fontWeight:900, fontFamily:'var(--font-plex-mono)' }}>Wallet Detail</p>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
                      <span style={{ padding:'4px 7px', borderRadius:'999px', background:nodeBg(selectedClusterNode), border:`1px solid ${nodeColor(selectedClusterNode)}66`, color:nodeColor(selectedClusterNode), fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{roleLabel(selectedClusterNode)}</span>
                      <span style={{ padding:'4px 7px', borderRadius:'999px', background:'rgba(148,163,184,.08)', border:'1px solid rgba(148,163,184,.16)', color:'#cbd5e1', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{selectedClusterNode.confidence === 'open_check' && holdersAreVerified ? walletEvidence.labels.confidence : (selectedClusterNode.confidence ?? walletEvidence.labels.confidence)}</span>
                    </div>
                  </div>
                  <button type="button" onClick={() => setSelectedClusterNodeId(null)} aria-label="Close wallet detail" style={{ width:28, height:28, borderRadius:'999px', border:'1px solid rgba(148,163,184,.2)', background:'rgba(15,23,42,.78)', color:'#94a3b8', cursor:'pointer' }}>×</button>
                </div>
                <div style={{ padding:'10px 0', borderTop:'1px solid rgba(148,163,184,.12)', borderBottom:'1px solid rgba(148,163,184,.12)' }}>
                  <p style={{ margin:'0 0 5px', fontSize:'9px', letterSpacing:'.13em', color:'#64748b', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>WALLET ADDRESS</p>
                  <div style={{ display:'flex', gap:'8px', alignItems:'center', justifyContent:'space-between' }}>
                    <span title={selectedClusterNode.address} style={{ color:'#e2e8f0', fontSize:'12px', fontFamily:'var(--font-plex-mono)', fontWeight:800 }}>{fmt(selectedClusterNode.address)}</span>
                    <button type="button" onClick={() => { void copyClusterAddress(selectedClusterNode.address) }} style={{ padding:'5px 8px', borderRadius:'8px', border:'1px solid rgba(45,212,191,.28)', background:'rgba(45,212,191,.08)', color:'#2dd4bf', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)', cursor:'pointer' }}>{copiedClusterAddress === selectedClusterNode.address ? 'COPIED' : 'COPY ADDRESS'}</button>
                  </div>
                </div>
                {isDeployerSelected && deployerIntel && (
                  <section style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,150px),1fr))', gap:'6px' }}>
                    <button type="button" onClick={() => { if (typeof window !== 'undefined') window.location.href = `/terminal/wallet-scanner?address=${selectedClusterNode.address}&chain=${chain ?? 'base'}` }} style={{ padding:'8px 9px', borderRadius:'9px', border:'1px solid rgba(251,191,36,.32)', background:'rgba(251,191,36,.08)', color:'#fbbf24', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)', cursor:'pointer' }}>Run Deployer Wallet Scan</button>
                    <button type="button" onClick={() => { if (typeof window !== 'undefined') window.location.href = `/terminal/wallet-scanner?address=${selectedClusterNode.address}&chain=${chain ?? 'base'}` }} style={{ padding:'8px 9px', borderRadius:'9px', border:'1px solid rgba(125,211,252,.28)', background:'rgba(125,211,252,.08)', color:'#7dd3fc', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)', cursor:'pointer' }}>Open Wallet Scanner</button>
                    <button type="button" onClick={() => setShowRelatedDeployments(v => !v)} style={{ padding:'8px 9px', borderRadius:'9px', border:'1px solid rgba(148,163,184,.24)', background:'rgba(148,163,184,.06)', color:'#cbd5e1', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)', cursor:'pointer' }}>Check Related Deployments</button>
                  </section>
                )}
                {isDeployerSelected && deployerIntel && showRelatedDeployments && (
                  <section style={{ display:'grid', gap:'6px', padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.58)', border:'1px solid rgba(148,163,184,.14)' }}>
                    <p style={{ margin:0, color:'#94a3b8', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{deployerIntel.relatedDeploymentsLabel}</p>
                    {deployerIntel.relatedDeployments.map((project) => (
                      <div key={project.contractAddress} style={{ display:'flex', justifyContent:'space-between', gap:'8px', padding:'5px 0', borderTop:'1px solid rgba(148,163,184,.08)' }}>
                        <span style={{ color:'#e2e8f0', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>{project.symbol ?? project.name ?? fmt(project.contractAddress)}</span>
                        <span style={{ color: project.rugFlag ? '#fb7185' : '#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>{project.rugFlag ? 'Rug flagged' : (project.createdAt ?? 'unknown date')}</span>
                      </div>
                    ))}
                  </section>
                )}
                <section style={{ display:'grid', gap:'7px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>SUPPLY POSITION</p>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                    <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Supply</p><p style={{ margin:0, color:(isDeployerSelected ? supplyPercent == null : supplyPercent == null) ? '#94a3b8' : '#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{isDeployerSelected && deployerIntel ? deployerIntel.supplyLabel : (supplyPercent == null ? walletEvidence.labels.walletSupply : `${supplyPercent.toFixed(1)}% of supply`)}</p></div>
                    <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Holder rank</p><p style={{ margin:0, color:'#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{isDeployerSelected && deployerIntel ? deployerIntel.holderRankLabel : (holderRank != null ? `#${holderRank}` : walletEvidence.labels.walletHolderRank)}</p></div>
                  </div>
                  {isDeployerSelected && deployerIntel && (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                      <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Is current holder?</p><p style={{ margin:0, color:'#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{deployerIntel.isCurrentHolderLabel}</p></div>
                      <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Native balance</p><p style={{ margin:0, color:'#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{deployerIntel.deployerNativeBalance.available && deployerIntel.deployerNativeBalance.amount != null ? `${deployerIntel.deployerNativeBalance.amount.toFixed(4)} ${deployerIntel.deployerNativeBalance.asset ?? ''}` : 'Not checked'}</p></div>
                    </div>
                  )}
                  {isDeployerSelected && deployerIntel && (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                      <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Received supply at launch?</p><p style={{ margin:0, color:'#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{deployerIntel.receivedSupplyAtLaunchLabel}</p></div>
                      <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Transferred/sold tokens?</p><p style={{ margin:0, color:'#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{deployerIntel.transferredOrSoldLabel}</p></div>
                    </div>
                  )}
                </section>
                <section style={{ display:'grid', gap:'7px', paddingTop:'2px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>CLUSTER ROLE</p>
                  <p style={{ margin:0, color:'#cbd5e1', fontSize:'11px', lineHeight:1.5, fontFamily:'var(--font-plex-mono)' }}>{roleLabel(selectedClusterNode)}</p>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
                    {[
                      selectedClusterNode.isCreator ? 'Creator wallet' : null,
                      selectedClusterNode.isLinked ? 'Linked to deployer' : null,
                      selectedClusterNode.isCluster ? 'Part of detected cluster' : null,
                    ].filter(Boolean).map((flag) => <span key={flag} style={{ padding:'4px 7px', borderRadius:'999px', background:'rgba(125,211,252,.08)', border:'1px solid rgba(125,211,252,.16)', color:'#bae6fd', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>{flag}</span>)}
                  </div>
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>BEHAVIOR PATTERN</p>
                  {selectedWalletBehavior ? (
                    <div style={{ display:'grid', gap:'7px', padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.58)', border:`1px solid ${(behaviorBadgeMeta(selectedWalletBehavior.label)?.color ?? '#94a3b8')}44` }}>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
                        <span style={{ padding:'4px 7px', borderRadius:'999px', background:behaviorBadgeMeta(selectedWalletBehavior.label)?.bg ?? 'rgba(148,163,184,.08)', border:`1px solid ${(behaviorBadgeMeta(selectedWalletBehavior.label)?.color ?? '#94a3b8')}66`, color:behaviorBadgeMeta(selectedWalletBehavior.label)?.color ?? '#cbd5e1', fontSize:'9px', fontWeight:900, fontFamily:'var(--font-plex-mono)' }}>{behaviorTitle(selectedWalletBehavior.label)}</span>
                        <span style={{ padding:'4px 7px', borderRadius:'999px', background:'rgba(148,163,184,.08)', border:'1px solid rgba(148,163,184,.16)', color:'#cbd5e1', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{confidenceLabel(selectedWalletBehavior.confidence)}</span>
                      </div>
                      {selectedWalletBehavior.reasons.slice(0, 3).map((reason, index) => <p key={reason + index} style={{ margin:0, color:'#cbd5e1', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>› {reason}</p>)}
                    </div>
                  ) : <p style={{ margin:0, color:'#64748b', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>{isDeployerSelected && deployerIntel ? deployerIntel.behaviorPatternLabel : 'No wallet behavior pattern confirmed in this pass.'}</p>}
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>TRANSFER LINKS</p>
                  {isDeployerSelected && deployerIntel ? (
                    deployerIntel.linkedWallets.length === 0 ? (
                      <p style={{ margin:0, color:'#64748b', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>{deployerIntel.transferLinksLabel}</p>
                    ) : deployerIntel.linkedWallets.map((lw) => (
                      <div key={lw.address} style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.58)', border:'1px solid rgba(148,163,184,.12)' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', gap:'8px', marginBottom:'5px' }}>
                          <span style={{ color:'#e2e8f0', fontSize:'10px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{fmt(lw.address)}</span>
                          {lw.confidence && <span style={{ color:'#94a3b8', fontSize:'9px', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{lw.confidence}</span>}
                        </div>
                        <p style={{ margin:0, color:'#94a3b8', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{lw.reason ?? 'linked wallet'}{lw.amountReceived != null ? ` · received ${lw.amountReceived}${lw.asset ? ` ${lw.asset}` : ''}` : ''}</p>
                      </div>
                    ))
                  ) : relatedEdges.length === 0 ? <p style={{ margin:0, color:'#64748b', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>No transfer links found in current cluster map.</p> : relatedEdges.map((edge) => {
                    const otherNodeId = edge.source === selectedClusterNode.id ? edge.target : edge.source
                    const otherNode = nodes.find((node) => node.id === otherNodeId)
                    return <div key={edge.id} style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.58)', border:'1px solid rgba(148,163,184,.12)' }}><div style={{ display:'flex', justifyContent:'space-between', gap:'8px', marginBottom:'5px' }}><span style={{ color:'#e2e8f0', fontSize:'10px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{fmt(otherNode?.address)}</span><span style={{ color:'#94a3b8', fontSize:'9px', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{edge.confidence}</span></div><p style={{ margin:'0 0 4px', color:'#7dd3fc', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>{edgeLabel(edge.type)} · weight {edge.weight}</p><p style={{ margin:0, color:'#94a3b8', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{edge.reason}</p></div>
                  })}
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>RISK SIGNALS</p>
                  <div style={{ padding:'8px 9px', borderRadius:'10px', background:'rgba(15,23,42,.5)', border:`1px solid ${riskContextColor}33` }}><p style={{ margin:0, color:riskContextColor, fontSize:'10px', fontWeight:800, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{riskContextScore != null ? `Cluster risk ${riskContextScore}/100 · ${riskContextLabel}` : `Cluster risk · ${riskContextLabel}`}</p></div>
                  {(isDeployerSelected && deployerIntel ? deployerIntel.riskSignals : walletSignals).length === 0 ? <p style={{ margin:0, color:'#64748b', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>No wallet-specific signals.</p> : (isDeployerSelected && deployerIntel ? deployerIntel.riskSignals : walletSignals).slice(0, 5).map((signal, index) => <p key={signal + index} style={{ margin:0, color:'#cbd5e1', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>› {signal}</p>)}
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>FUNDING SOURCE</p>
                  <p style={{ margin:0, color:fundingSource ? '#cbd5e1' : '#64748b', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{fundingSource ?? 'No funding source identified.'}</p>
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>CONFIDENCE</p>
                  <p style={{ margin:0, color:'#cbd5e1', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{isDeployerSelected && deployerIntel ? confidenceCopy(deployerIntel.confidence) : confidenceCopy(selectedClusterNode.confidence)}</p>
                {isDeployerSelected && deployerIntel && deployerIntel.evidenceSource.length > 0 && (
                  <p style={{ margin:'4px 0 0', color:'#64748b', fontSize:'9px', lineHeight:1.4, fontFamily:'var(--font-plex-mono)' }}>Evidence: {deployerIntel.evidenceSource.join(', ')}</p>
                )}
                {isDeployerSelected && deployerIntel && (
                  <p style={{ margin:'4px 0 0', color:'#64748b', fontSize:'9px', lineHeight:1.4, fontFamily:'var(--font-plex-mono)' }}>Next: {deployerIntel.nextActions.join(' ')}</p>
                )}
                </section>
                {openChecks.length > 0 && (
                  <section style={{ display:'grid', gap:'6px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                    <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#94a3b8', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>OPEN CHECKS</p>
                    {openChecks.map((check) => <p key={check} style={{ margin:0, color:'#94a3b8', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>› {check}</p>)}
                  </section>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
      <section style={{ display:'grid', gap:'12px', padding:'14px', borderRadius:'16px', background:'rgba(8,14,28,.78)', border:'1px solid rgba(125,211,252,.14)' }}>
        <div>
          <p style={{ margin:'0 0 5px', fontSize:'12px', color:'#e2e8f0', fontWeight:900, fontFamily:'var(--font-plex-mono)' }}>Behavior Intelligence</p>
          <p style={{ margin:0, color:'#94a3b8', fontSize:'10px', lineHeight:1.5, fontFamily:'var(--font-plex-mono)' }}>Derived from the current cluster map only: no new backend calls, no invented timestamps, and no unrelated holder expansion.</p>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,260px),1fr))', gap:'10px', alignItems:'start' }}>
          <details open style={{ padding:'12px', borderRadius:'13px', background:'rgba(15,23,42,.58)', border:'1px solid rgba(251,191,36,.18)' }}>
            <summary style={{ cursor:'pointer', color:'#fbbf24', fontSize:'10px', fontWeight:900, fontFamily:'var(--font-plex-mono)', letterSpacing:'.1em' }}>DEPLOYER LINEAGE</summary>
            <div style={{ display:'grid', gap:'8px', marginTop:'10px' }}>
              {[
                ['Deployer', fmt(deployerLineage.deployer?.address)],
                ['Direct links', String(deployerLineage.summary.directLinks)],
                ['Second layer', String(deployerLineage.summary.secondLayerLinks)],
                ['Suspicious links', String(deployerLineage.summary.suspiciousLinks)],
                ['Linked supply', deployerLineage.summary.linkedSupplyPercent == null ? 'Holder data unavailable' : `${deployerLineage.summary.linkedSupplyPercent.toFixed(1)}%`],
                ['Cluster supply', deployerLineage.summary.clusterSupplyPercent == null ? 'Holder data unavailable' : `${deployerLineage.summary.clusterSupplyPercent.toFixed(1)}%`],
              ].map(([label, value]) => <div key={label} style={{ display:'flex', justifyContent:'space-between', gap:'8px', padding:'5px 0', borderTop:'1px solid rgba(148,163,184,.08)' }}><span style={{ color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>{label}</span><span style={{ color:'#e2e8f0', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{value}</span></div>)}
              <p style={{ margin:0, color:'#cbd5e1', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{deployerLineage.summary.reason}</p>
              <p style={{ margin:0, color:'#94a3b8', fontSize:'9px', lineHeight:1.4, fontFamily:'var(--font-plex-mono)' }}>{lineageDeployerIntel?.relatedDeploymentsLabel ?? 'Related deployments unavailable in this pass.'}</p>
            </div>
          </details>
          <details open style={{ padding:'12px', borderRadius:'13px', background:'rgba(15,23,42,.58)', border:'1px solid rgba(125,211,252,.16)' }}>
            <summary style={{ cursor:'pointer', color:'#7dd3fc', fontSize:'10px', fontWeight:900, fontFamily:'var(--font-plex-mono)', letterSpacing:'.1em' }}>CLUSTER TIMELINE · {clusterTimeline.mode === 'timestamped' ? 'TIMESTAMPED' : clusterTimeline.mode === 'ordered' ? 'ORDERED' : 'OPEN CHECK'}</summary>
            <div style={{ display:'grid', gap:'8px', marginTop:'10px' }}>
              {clusterTimeline.events.map((event) => {
                const color = eventSeverityColor(event.severity)
                return <div key={event.id} style={{ display:'grid', gridTemplateColumns:'12px 1fr', gap:'8px', alignItems:'start' }}>
                  <span style={{ width:9, height:9, marginTop:3, borderRadius:'999px', background:color, boxShadow:`0 0 12px ${color}66` }} />
                  <div style={{ padding:'8px 9px', borderRadius:'10px', background:'rgba(2,6,23,.4)', border:`1px solid ${color}33` }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:'8px', marginBottom:'4px' }}><span style={{ color:'#e2e8f0', fontSize:'10px', fontWeight:900, fontFamily:'var(--font-plex-mono)' }}>{event.label}</span><span style={{ color, fontSize:'8px', fontWeight:800, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{event.timestamp ? new Date(event.timestamp).toLocaleString() : `Order ${event.order}`}</span></div>
                    <p style={{ margin:0, color:'#94a3b8', fontSize:'9px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{event.description}</p>
                  </div>
                </div>
              })}
            </div>
          </details>
        </div>
      </section>
      <style>{`
        @keyframes clusterSuspiciousFlow { to { stroke-dashoffset: -44; } }
        .cluster-suspicious-flow { animation: clusterSuspiciousFlow 3.8s linear infinite; filter: drop-shadow(0 0 8px rgba(251,113,133,.45)); }
        .cluster-flow-strong { animation-duration: 2.7s; }
        .cluster-flow-medium { animation-duration: 4s; }
        .cluster-flow-faint { animation-duration: 5.6s; }
        @media (prefers-reduced-motion: reduce) { .cluster-suspicious-flow { animation: none; } }
      `}</style>
    </div>
  )
}

// ─── Solana Cluster Graph, DISCLOSED (premium intelligence-graph rebuild — visualization layer
// only, over the exact same real evidence lib/server/solana/clusterAnalyzer.ts has always produced;
// no backend/API change). Solana-native only: nodes/edges come exclusively from that module's real
// evidence (Helius Enhanced, Alchemy/Solana RPC pool + authority reads) — no EVM heuristics, no
// lib/clusterMap.ts reuse. Node roles/edge relationships are the exact union types
// clusterAnalyzer.ts exports (SolanaClusterNodeRole / SolanaClusterRelationship) — every color/
// label/position map below is typed as Record<ThatUnion, …>, so TypeScript itself refuses to
// compile if a role or relationship this engine can actually emit is left unhandled, and it is
// equally impossible to add a role/relationship here that the backend doesn't really produce
// (there's no such key in the union). That's the mechanism that keeps this "never fabricate a
// relationship" honest under a UI rewrite — not a promise, a compiler constraint.
//
// TAXONOMY, DISCLOSED: this engine only ever verifies Creator / Funding / Mint Authority / Freeze
// Authority / LP roles (see clusterAnalyzer.ts's own header for exactly why Treasury / Exchange /
// Market Maker / Unknown wallet-role classification is NOT attempted — it would require either
// unbounded cross-mint transaction indexing or heuristics with no verifiable ground truth). The
// role legend below still lists those reserved categories, explicitly greyed out as "not verified
// this scan" — so the fuller intelligence-graph taxonomy is visible without a single fabricated
// node ever being drawn under it.
type SolanaCMap = NonNullable<SolanaBetaScanResult['clusterMap']>
type SolanaCNode = SolanaCMap['nodes'][number]
type SolanaCEdge = SolanaCMap['edges'][number]
type SolanaWalletSnapshotUI = { address: string; balanceResolved: boolean; balanceSol: number | null; lastActivityResolved: boolean; lastActivitySignature: string | null; lastActivityTimestamp: string | null; errorReason: string | null }
/** Absent from the map = still loading (or not a wallet node) — see the preload effect below. */
type SolanaBalanceState = SolanaWalletSnapshotUI | 'error'

const SOLANA_CNODE_ROLE_LABEL: Record<SolanaCNode['role'], string> = {
  mint: 'Scanned Token', creator_wallet: 'Creator', funding_wallet: 'Funding Wallet',
  mint_authority: 'Mint Authority', freeze_authority: 'Freeze Authority', lp_pool: 'LP Pool',
  top_holder: 'Top Holder', lp_vault: 'LP Vault', prior_mint: 'Prior Launch',
}
const SOLANA_CNODE_ROLE_COLOR: Record<SolanaCNode['role'], string> = {
  mint: '#7dd3fc', creator_wallet: '#fbbf24', funding_wallet: '#a855f7',
  mint_authority: '#fb7185', freeze_authority: '#fb7185', lp_pool: '#2dd4bf',
  top_holder: '#60a5fa', lp_vault: '#14b8a6', prior_mint: '#f472b6',
}
// Fixed angle (degrees, screen convention: 0=east, 90=south) each role anchors to around the
// always-centered mint — "position nodes by role" without any force-graph randomness. Multiple
// nodes sharing a role fan out from this anchor rather than colliding; top_holder/lp_vault get a
// dedicated wide bottom arc in the layout so a 10-20-holder graph spreads instead of stacking.
const SOLANA_CNODE_ROLE_ANGLE: Record<SolanaCNode['role'], number> = {
  mint: 0, funding_wallet: -125, creator_wallet: -90, lp_pool: -20, mint_authority: 165, freeze_authority: 195,
  top_holder: 90, lp_vault: 25, prior_mint: -155,
}
// The hardcoded SOLANA_RESERVED_ROLE_LEGEND (Treasury / Exchange / Market Maker / Update Authority,
// drawn as four greyed-out chips on the graph canvas) was removed with the bubblemap redesign: it
// put four permanently-dead entries in the legend of the very picture being simplified, and it was
// a SECOND, hand-maintained copy of a list the backend already returns. The same disclosure is
// still shown — sourced from clusterAnalyzer.ts's own UNRESOLVED_RELATIONSHIPS, which names each
// unverifiable relationship AND its concrete reason — in the "Cannot be verified (and why)" panel
// above the graph, rendered from clusterMap.unresolvedRelationships. One source of truth instead of
// two that could silently drift apart.
const SOLANA_CNODE_RISK_COLOR: Record<SolanaCNode['risk'], string> = { elevated: '#f87171', standard: '#34d399', neutral: '#94a3b8', unknown: '#64748b' }
const SOLANA_CNODE_CONFIDENCE_COLOR: Record<SolanaCNode['confidence'], string> = { high: '#34d399', medium: '#fbbf24', low: '#94a3b8' }
const SOLANA_EDGE_LABEL: Record<SolanaCEdge['relationship'], string> = {
  funding_wallet: 'Funded', first_sol_sender: 'First SOL Sender', shared_fee_payer: 'Fee Payer',
  mint_authority: 'Mint Authority', freeze_authority: 'Freeze Authority', lp_creation: 'LP Provider', pumpfun_migration: 'Migration',
  holds_supply: 'Holds Supply', vault_of: 'Vault Of', prior_launch: 'Prior Launch',
}
const SOLANA_EDGE_COLOR: Record<SolanaCEdge['relationship'], string> = {
  funding_wallet: '#a855f7', first_sol_sender: '#a855f7', shared_fee_payer: '#38bdf8',
  mint_authority: '#fb7185', freeze_authority: '#fb7185', lp_creation: '#2dd4bf', pumpfun_migration: '#facc15',
  holds_supply: '#60a5fa', vault_of: '#14b8a6', prior_launch: '#f472b6',
}
// BUBBLEMAP LAYOUT, DISCLOSED (requested: "make the dev map simpler, easier to read, like
// bubblemaps, to make more sense from a user's perspective"). The graph previously drew every node
// as a rectangular card carrying four lines of text at once — role, address, confidence tier and
// SOL balance — so a 15-node graph presented ~60 competing strings and read as a wiring diagram.
// It now draws BUBBLES: one circle per node, sized by the thing users actually came to see, with
// the role name underneath and everything else moved into the click-through detail panel (which
// already existed and is unchanged — no evidence is hidden, it is one click away instead of
// permanently on screen).
//
// WHAT THE SIZE MEANS, DISCLOSED — this is the part that must not become decorative: a bubble's
// area is proportional to that wallet's REAL measured share of supply (SolanaClusterNode.
// supplyPercent, the same value cited in its own evidence text), using sqrt scaling so area, not
// radius, tracks the percentage — the standard for an honestly-readable bubble chart. A node whose
// share is null is NOT "zero": null means not applicable (the mint itself, a prior launch) or not
// measured (a wallet outside the largest-accounts sample). Those render at a fixed neutral
// role-based size and are explicitly excluded from the "sized by share" legend, so a small bubble
// never silently asserts "this wallet holds almost nothing".
const SOLANA_BUBBLE_ROLE_SIZE: Record<SolanaCNode['role'], number> = {
  mint: 128, creator_wallet: 66, funding_wallet: 62, mint_authority: 64, freeze_authority: 64,
  lp_pool: 68, top_holder: 56, lp_vault: 58, prior_mint: 52,
}
/** Approximate canvas px per layout unit — the graph canvas is a fixed 420px tall and typically
 *  ~650px wide, and layout coordinates run 0-100. Used only to convert a bubble's px diameter into
 *  the layout's own units for collision spacing; an imprecise estimate simply spaces bubbles a
 *  little more or less generously, and can never change a bubble's size or what it reports. */
const BUBBLE_PX_PER_UNIT = 6.5
function solanaBubbleSize(node: SolanaCNode): number {
  if (node.role === 'mint') return SOLANA_BUBBLE_ROLE_SIZE.mint
  if (node.supplyPercent == null) return SOLANA_BUBBLE_ROLE_SIZE[node.role]
  // Area-proportional: radius grows with sqrt(share). Clamped so a 0.01% dust holder is still
  // clickable and a 60% whale cannot swallow the canvas.
  const scaled = 44 + Math.sqrt(Math.max(0, node.supplyPercent)) * 10
  return Math.max(44, Math.min(118, scaled))
}
/** Balances preload only for these roles — a 20-holder graph must not burn the wallet-detail rate limit (20/min) on load; other nodes fetch on click. */
const SOLANA_BALANCE_PRELOAD_ROLES = new Set<SolanaCNode['role']>(['creator_wallet', 'funding_wallet', 'mint_authority', 'freeze_authority'])
/** Compact-card roles that collapse behind the "show all" toggle when the graph is large. */
const SOLANA_EXPANDABLE_ROLES = new Set<SolanaCNode['role']>(['top_holder', 'lp_vault', 'prior_mint'])
const SOLANA_COLLAPSED_EXPANDABLE_LIMIT = 8

// Small inline glyphs, one per real role — no icon-font/library dependency added.
function SolanaRoleGlyph({ role, size = 14, color }: { role: SolanaCNode['role']; size?: number; color: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (role) {
    case 'mint':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z" /></svg>
    case 'creator_wallet':
      return <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" /></svg>
    case 'funding_wallet':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v7M8.5 11 12 14.5 15.5 11" /></svg>
    case 'mint_authority':
      return <svg {...common}><circle cx="8" cy="8" r="3" /><path d="M10.2 10.2 20 20M15 15l2-2M18 18l2-2" /></svg>
    case 'freeze_authority':
      return <svg {...common}><path d="M12 3v18M5 7l14 10M19 7 5 17" /></svg>
    case 'lp_pool':
      return <svg {...common}><path d="M12 3c3.5 4.2 6 7.6 6 10.5A6 6 0 1 1 6 13.5C6 10.6 8.5 7.2 12 3Z" /></svg>
    case 'top_holder':
      return <svg {...common}><path d="M4 20V10M10 20V4M16 20v-8M21 20H3" /></svg>
    case 'lp_vault':
      return <svg {...common}><rect x="4" y="6" width="16" height="14" rx="2" /><circle cx="12" cy="13" r="3" /><path d="M8 6V4h8v2" /></svg>
    case 'prior_mint':
      return <svg {...common}><circle cx="9" cy="9" r="5.5" /><path d="M17 7a5.5 5.5 0 1 1-4 9.3M9 6.5V9l1.8 1.8" /></svg>
  }
}

// Placeholder "logo" for the scanned token, DISCLOSED: this codebase's Solana metadata resolver
// (lib/server/solana/metadataResolver.ts) never resolves a logo/image URL — only name/symbol — so
// there is no real image to show here. Rather than fetch one from an unverified third-party image
// host (which this engine's evidence contract does not permit), this renders a deterministic
// typographic badge from the token's real, already-resolved ticker/name initials — a placeholder,
// clearly not a claim of a verified brand asset.
function SolanaTokenLogoPlaceholder({ symbol, name, size = 34 }: { symbol: string | null; name: string | null; size?: number }) {
  const source = symbol ?? name ?? ''
  const initials = source.replace(/^\$/, '').slice(0, 2).toUpperCase() || '?'
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: 'linear-gradient(145deg, rgba(45,212,191,0.35), rgba(56,189,248,0.25))',
      border: '1px solid rgba(125,211,252,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 800, color: '#f0fdfa', fontFamily: 'var(--font-plex-mono)', letterSpacing: '-0.02em',
    }}>
      {initials}
    </div>
  )
}

function SolanaClusterGraphPanel({ clusterMap, creatorConfidence, tokenName, tokenSymbol }: { clusterMap: SolanaCMap; creatorConfidence: SolanaBetaScanResult['creatorConfidence']; tokenName: string | null; tokenSymbol: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [balances, setBalances] = useState<Map<string, SolanaBalanceState>>(new Map())
  const [entered, setEntered] = useState(false)
  const fmt = (addr: string | null | undefined) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'

  // Staggered load-in animation — purely cosmetic, one render pass after mount. Keyed by the
  // parent (see the callsite's `key`) so a new node set remounts this component and `entered`
  // naturally starts false again, instead of resetting it synchronously inside an effect.
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 30)
    return () => clearTimeout(t)
  }, [])

  // EXPANDABLE GRAPH: a 20+-node graph collapses its holder/vault/prior-launch fan behind a
  // "show all" toggle (top SOLANA_COLLAPSED_EXPANDABLE_LIMIT shown by default, ordered as the
  // engine emitted them — holders arrive rank-ordered). Core nodes (creator/funding/authorities/
  // pool/mint) are never collapsed. Layout, edges, and highlighting all run on the visible set.
  const [expanded, setExpanded] = useState(false)
  const expandableCount = clusterMap.nodes.filter((n) => SOLANA_EXPANDABLE_ROLES.has(n.role)).length
  const nodes = useMemo(() => {
    if (expanded || expandableCount <= SOLANA_COLLAPSED_EXPANDABLE_LIMIT) return clusterMap.nodes
    let kept = 0
    return clusterMap.nodes.filter((n) => {
      if (!SOLANA_EXPANDABLE_ROLES.has(n.role)) return true
      kept++
      return kept <= SOLANA_COLLAPSED_EXPANDABLE_LIMIT
    })
  }, [clusterMap.nodes, expanded, expandableCount])
  const visibleIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const edges = useMemo(() => clusterMap.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to)), [clusterMap.edges, visibleIds])

  // Preload core wallet nodes' real balance/last-activity snapshots from the existing, rate-
  // limited /api/solana-wallet-detail endpoint (same endpoint, same shape — see
  // app/api/solana-wallet-detail/route.ts). ONLY the core roles preload (see
  // SOLANA_BALANCE_PRELOAD_ROLES) — a 20-holder graph must not burn the endpoint's 20/min rate
  // limit on page load; holder/vault/prior-launch nodes fetch on click instead (below).
  // Sequential, cancel-safe, skips nodes already resolved. A node absent from `balances` reads as
  // "loading"/"—" in the UI below, so this effect only calls setState from inside the async loop.
  const fetchedBalanceIds = useRef<Set<string>>(new Set())
  const fetchBalance = async (node: SolanaCNode, isCancelled: () => boolean) => {
    try {
      const res = await fetch('/api/solana-wallet-detail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: node.address }) })
      const json = await res.json().catch(() => null)
      if (isCancelled()) return
      if (!res.ok || !json?.ok) setBalances((prev) => new Map(prev).set(node.id, 'error'))
      else setBalances((prev) => new Map(prev).set(node.id, json.snapshot as SolanaWalletSnapshotUI))
    } catch {
      if (!isCancelled()) setBalances((prev) => new Map(prev).set(node.id, 'error'))
    }
  }
  useEffect(() => {
    let cancelled = false
    const toFetch = clusterMap.nodes.filter((n) => SOLANA_BALANCE_PRELOAD_ROLES.has(n.role) && !fetchedBalanceIds.current.has(n.id))
    if (toFetch.length === 0) return
    for (const n of toFetch) fetchedBalanceIds.current.add(n.id)
    ;(async () => {
      for (const node of toFetch) {
        if (cancelled) return
        await fetchBalance(node, () => cancelled)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterMap.nodes.map((n) => n.id).join(',')])

  // On-click balance fetch for the non-preloaded roles (holders/vaults/prior launches).
  useEffect(() => {
    if (!selectedId) return
    const node = clusterMap.nodes.find((n) => n.id === selectedId)
    if (!node || node.role === 'mint' || fetchedBalanceIds.current.has(node.id)) return
    fetchedBalanceIds.current.add(node.id)
    let cancelled = false
    void fetchBalance(node, () => cancelled)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // Role-anchored layout: each node starts at its role's fixed angle/radius around the always-
  // centered mint, then a light relaxation pass (mutual repulsion + edge-length spring + a soft
  // pull back toward its role anchor) spreads same-role clusters apart instead of stacking them —
  // "position nodes by role" AND "intelligently spread small clusters" from one pure function of
  // nodes/edges, computed with useMemo rather than useEffect+setState.
  const positions = useMemo<Map<string, { x: number; y: number }>>(() => {
    if (!nodes.length) return new Map()
    type SN = { id: string; x: number; y: number; vx: number; vy: number; anchorX: number; anchorY: number; fixed: boolean }
    const n = nodes.length
    const baseRadius = Math.min(40, 24 + n * 1.4)
    const roleSeen = new Map<string, number>()
    const roleTotals = new Map<string, number>()
    for (const node of nodes) roleTotals.set(node.role, (roleTotals.get(node.role) ?? 0) + 1)
    const sn: SN[] = nodes.map((node) => {
      if (node.role === 'mint') return { id: node.id, x: 50, y: 50, vx: 0, vy: 0, anchorX: 50, anchorY: 50, fixed: true }
      const idx = roleSeen.get(node.role) ?? 0
      roleSeen.set(node.role, idx + 1)
      const total = roleTotals.get(node.role) ?? 1
      // A role with many nodes (top holders, vaults) spreads across a wide arc CENTERED on its
      // anchor angle, with staggered radii so cards don't overlap; small roles keep the tight fan.
      let angleDeg: number
      let radius: number
      if (SOLANA_EXPANDABLE_ROLES.has(node.role) && total > 3) {
        const arc = Math.min(170, total * 17)
        angleDeg = SOLANA_CNODE_ROLE_ANGLE[node.role] - arc / 2 + (total > 1 ? (idx / (total - 1)) * arc : 0)
        radius = baseRadius + 6 + (idx % 2) * 10
      } else {
        angleDeg = SOLANA_CNODE_ROLE_ANGLE[node.role] + idx * 18
        radius = baseRadius + idx * 8
      }
      const rad = (angleDeg * Math.PI) / 180
      const ax = 50 + Math.cos(rad) * radius
      const ay = 50 + Math.sin(rad) * radius
      return { id: node.id, x: ax, y: ay, vx: 0, vy: 0, anchorX: ax, anchorY: ay, fixed: false }
    })
    const ea = edges.map((e) => ({ si: sn.findIndex((nd) => nd.id === e.from), ti: sn.findIndex((nd) => nd.id === e.to) })).filter((e) => e.si >= 0 && e.ti >= 0)
    let alpha = 1
    for (let iter = 0; iter < 220 && alpha > 0.001; iter++) {
      for (const nd of sn) { if (nd.fixed) continue; nd.vx += (nd.anchorX - nd.x) * 0.06 * alpha; nd.vy += (nd.anchorY - nd.y) * 0.06 * alpha }
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = sn[i], b = sn[j], dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy + 0.01, invD = 1 / Math.sqrt(d2), f = -30 * alpha / d2, fx = dx * invD * f, fy = dy * invD * f
        if (!a.fixed) { a.vx -= fx; a.vy -= fy }
        if (!b.fixed) { b.vx += fx; b.vy += fy }
      }
      for (const e of ea) {
        const s = sn[e.si], t = sn[e.ti], dx = t.x - s.x, dy = t.y - s.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const tgt = 26, str = 0.25 * alpha, delta = (d - tgt) / d * str, fx = dx * delta, fy = dy * delta
        if (!s.fixed) { s.vx += fx; s.vy += fy }
        if (!t.fixed) { t.vx -= fx; t.vy -= fy }
      }
      for (const nd of sn) {
        if (nd.fixed) continue
        nd.vx *= 0.55; nd.vy *= 0.55; nd.x += nd.vx; nd.y += nd.vy
        nd.x = Math.max(10, Math.min(90, nd.x)); nd.y = Math.max(10, Math.min(90, nd.y))
      }
      alpha -= alpha * 0.05
    }

    // BUBBLE SEPARATION, DISCLOSED: the relaxation above is size-agnostic — it was tuned when every
    // node was the same fixed-width card. Now that a bubble's diameter encodes its real share, a
    // whale bubble can be more than twice a dust bubble's size and the old spacing let them overlap,
    // which is exactly the unreadability this redesign is meant to remove. These passes push any
    // two bubbles apart until the gap between their RIMS is positive, using each node's own radius.
    // Purely positional — it moves circles on screen and changes no value, evidence, or size.
    const radii = new Map(nodes.map((nd) => [nd.id, solanaBubbleSize(nd) / 2 / BUBBLE_PX_PER_UNIT] as const))
    for (let pass = 0; pass < 60; pass++) {
      let moved = false
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = sn[i], b = sn[j]
        const need = (radii.get(a.id) ?? 4) + (radii.get(b.id) ?? 4) + 1.6
        let dx = b.x - a.x, dy = b.y - a.y
        let d = Math.sqrt(dx * dx + dy * dy)
        if (d >= need) continue
        if (d < 0.01) { dx = Math.cos(i * 2.4); dy = Math.sin(i * 2.4); d = 1 }
        const push = (need - d) / d / 2
        const ox = dx * push, oy = dy * push
        // The mint is pinned at center — when it collides, the other bubble absorbs the full push.
        if (a.fixed) { b.x += ox * 2; b.y += oy * 2 }
        else if (b.fixed) { a.x -= ox * 2; a.y -= oy * 2 }
        else { a.x -= ox; a.y -= oy; b.x += ox; b.y += oy }
        moved = true
      }
      for (const nd of sn) {
        if (nd.fixed) continue
        const r = radii.get(nd.id) ?? 4
        nd.x = Math.max(2 + r, Math.min(98 - r, nd.x))
        nd.y = Math.max(4 + r, Math.min(94 - r, nd.y))
      }
      if (!moved) break
    }

    const m = new Map<string, { x: number; y: number }>()
    sn.forEach((nd) => m.set(nd.id, { x: nd.x, y: nd.y }))
    return m
  }, [nodes, edges])

  const nodesById = useMemo(() => new Map(nodes.map((nd) => [nd.id, nd] as const)), [nodes])

  // Hover (or, absent a hover, the selection) drives connected-path highlighting.
  const focusId = hoveredId ?? selectedId
  const connectedIds = useMemo(() => {
    if (!focusId) return null
    const ids = new Set<string>([focusId])
    for (const e of edges) { if (e.from === focusId) ids.add(e.to); if (e.to === focusId) ids.add(e.from) }
    return ids
  }, [focusId, edges])

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null
  const connectedEdges = selectedNode ? edges.filter((e) => e.from === selectedNode.id || e.to === selectedNode.id) : []
  // "Funding source" for the intelligence panel: the edge, if any, that fed evidence INTO this
  // node (funded it, or paid its fees) — real edges only, never inferred.
  const fundingEdge = selectedNode
    ? edges.find((e) => e.to === selectedNode.id && (e.relationship === 'funding_wallet' || e.relationship === 'first_sol_sender' || e.relationship === 'shared_fee_payer'))
    : null
  const selectedBalance = selectedNode ? balances.get(selectedNode.id) ?? null : null

  if (nodes.length === 0) {
    return (
      <div style={{ padding: '13px 15px', borderRadius: '11px', background: 'rgba(148,163,184,.04)', border: '1px solid rgba(148,163,184,.14)' }}>
        <p style={{ margin: 0, fontSize: '11px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>No verified wallet relationships found.</p>
      </div>
    )
  }

  const riskColor = clusterMap.riskLevel === 'elevated' ? '#f87171' : clusterMap.riskLevel === 'standard' ? '#34d399' : '#94a3b8'
  const confColor = clusterMap.clusterConfidence === 'high' ? '#34d399' : clusterMap.clusterConfidence === 'medium' ? '#a3e635' : clusterMap.clusterConfidence === 'low' ? '#fbbf24' : '#94a3b8'
  const creatorConfColor = creatorConfidence.tier === 'CONFIRMED' ? '#34d399' : creatorConfidence.tier === 'LIKELY' ? '#fbbf24' : creatorConfidence.tier === 'POSSIBLE' ? '#fb923c' : '#94a3b8'
  // HEADER SIMPLIFIED, DISCLOSED (same "make it simpler / more sense to a user" request): this row
  // was six StatCards of engine vocabulary — Cluster Confidence, Cluster Risk, Evidence Count,
  // Funding Depth, Relationship Count, Creator Confidence — four of which were raw internal counts
  // a reader cannot act on. It is now the three that answer a real question ("how risky does this
  // wallet cluster look", "how sure is it", "who made it"), each with a plain-English value. The
  // dropped counts were not evidence and nothing referenced them; evidence/funding/relationship
  // detail is still fully present in the Why-this-confidence and Why-this-risk panels below, which
  // are unchanged.
  const riskWord = clusterMap.riskLevel === 'elevated' ? 'Elevated' : clusterMap.riskLevel === 'standard' ? 'Nothing unusual' : 'Not enough evidence'
  const confWord = clusterMap.clusterConfidence === 'high' ? 'Strong evidence' : clusterMap.clusterConfidence === 'medium' ? 'Decent evidence' : clusterMap.clusterConfidence === 'low' ? 'Thin evidence' : 'No evidence'
  const creatorWord = creatorConfidence.tier === 'UNKNOWN' ? 'Not identified' : `${creatorConfidence.tier.charAt(0)}${creatorConfidence.tier.slice(1).toLowerCase()} (${creatorConfidence.confidencePercent}%)`
  const metrics: Array<{ label: string; value: string; accent: string }> = [
    { label: 'Wallet Cluster Risk', value: riskWord, accent: riskColor },
    { label: 'How Sure Is This?', value: confWord, accent: confColor },
    { label: 'Creator Identified?', value: creatorWord, accent: creatorConfColor },
  ]

  const sizedNodeCount = nodes.filter((nd) => nd.supplyPercent != null).length

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '8px' }} className="sol-cluster-metrics">
        {metrics.map((m) => <StatCard key={m.label} label={m.label} value={m.value} accent={m.accent} />)}
      </div>

      {/* One plain sentence telling a first-time reader how to read the picture below. */}
      <p style={{ margin: 0, padding: '9px 12px', borderRadius: '10px', background: 'rgba(125,211,252,0.05)', border: '1px solid rgba(125,211,252,0.16)', fontSize: '11px', color: '#9db3c8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>
        Your token sits in the middle. Every bubble around it is a wallet or account this scan
        verified a real on-chain link to — click any bubble for its address, balance and the exact
        evidence.{sizedNodeCount > 0 ? ` ${sizedNodeCount} of them hold some of the supply, and those are sized by how much they hold.` : ''}
      </p>

      {/* WHY these numbers — the real factors behind confidence and risk, plus what genuinely
          cannot be verified and why. Confidence/risk are computed, never placeholder defaults —
          see clusterAnalyzer.ts's confidence/risk engines. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: '8px' }}>
        <div style={{ padding: '11px 13px', borderRadius: '11px', background: `${confColor}08`, border: `1px solid ${confColor}28` }}>
          <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: confColor, fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Why this confidence</p>
          {clusterMap.confidenceFactors.map((f, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '5px 0 0', fontSize: '10px', color: '#9db3c8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{f}</p>
          ))}
        </div>
        <div style={{ padding: '11px 13px', borderRadius: '11px', background: `${riskColor}08`, border: `1px solid ${riskColor}28` }}>
          <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: riskColor, fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Why this risk read</p>
          {(clusterMap.riskFactors.length > 0 ? clusterMap.riskFactors : [clusterMap.riskReason]).map((f, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '5px 0 0', fontSize: '10px', color: '#9db3c8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{f}</p>
          ))}
        </div>
        <div style={{ padding: '11px 13px', borderRadius: '11px', background: 'rgba(148,163,184,0.04)', border: '1px solid rgba(148,163,184,0.16)' }}>
          <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#94a3b8', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Cannot be verified (and why)</p>
          {clusterMap.unresolvedRelationships.map((u, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '5px 0 0', fontSize: '10px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}><span style={{ color: '#a3b4c5', fontWeight: 700 }}>{u.label}:</span> {u.reason}</p>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selectedNode ? '1fr 280px' : '1fr', gap: '12px' }}>
        {/* Taller than the old 420px card canvas: bubbles carry their role name OUTSIDE the circle
            now, so the extra vertical room keeps those labels off each other. */}
        <div style={{ position: 'relative', height: '470px', borderRadius: '14px', border: '1px solid rgba(148,163,184,0.18)', background: 'radial-gradient(circle at 50% 50%, rgba(45,212,191,0.07), rgba(6,10,20,0.94))', overflow: 'hidden' }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}>
            <defs>
              {/* One arrowhead per real relationship type, colored to match its edge — real
                  evidence direction only (e.g. "Mint Authority" and "Fee Payer" edges correctly
                  point INTO the centered token, since that's who acted on it; "LP Provider" points
                  OUT, since the token created the pool). Never reversed for cosmetic effect — see
                  this component's header on why direction always tracks the real evidence. */}
              {(Object.keys(SOLANA_EDGE_COLOR) as SolanaCEdge['relationship'][]).map((rel) => (
                <marker key={rel} id={`sol-cluster-arrow-${rel}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 Z" fill={SOLANA_EDGE_COLOR[rel]} />
                </marker>
              ))}
            </defs>
            {edges.map((e, i) => {
              const s = positions.get(e.from), t = positions.get(e.to)
              if (!s || !t) return null
              const color = SOLANA_EDGE_COLOR[e.relationship]
              const isFocusEdge = !focusId || e.from === focusId || e.to === focusId
              const originNode = nodesById.get(e.from)
              const targetNode = nodesById.get(e.to)
              const riskFlow = (originNode?.risk === 'elevated') || targetNode?.risk === 'elevated'
              // Pull the line's endpoints back off each node's center so the arrowhead lands in
              // the gap before the (larger, HTML-rendered) destination card instead of hiding
              // underneath it — bigger pullback into the always-larger, dominant mint node.
              const dx = t.x - s.x, dy = t.y - s.y, d = Math.sqrt(dx * dx + dy * dy) || 1
              const ux = dx / d, uy = dy / d
              const startPad = originNode?.role === 'mint' ? 9 : 5.5
              const endPad = targetNode?.role === 'mint' ? 10 : 6
              const x1 = s.x + ux * startPad, y1 = s.y + uy * startPad
              const x2 = t.x - ux * endPad, y2 = t.y - uy * endPad
              return (
                <line
                  key={e.id}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={color}
                  strokeWidth={isFocusEdge ? 0.7 : 0.4}
                  opacity={entered ? (isFocusEdge ? 0.9 : 0.14) : 0}
                  markerEnd={`url(#sol-cluster-arrow-${e.relationship})`}
                  className={riskFlow ? 'sol-cluster-edge-flow' : undefined}
                  style={{ transition: `opacity 420ms ease ${i * 60}ms, stroke-width 200ms ease` }}
                />
              )
            })}
          </svg>

          {edges.map((e) => {
            const s = positions.get(e.from), t = positions.get(e.to)
            if (!s || !t) return null
            const isFocusEdge = !focusId || e.from === focusId || e.to === focusId
            if (!isFocusEdge && focusId) return null // decluttered: only show labels on the highlighted path once something is focused
            // A dense (13+ edge) graph would drown in always-on labels — labels then appear only
            // on hover/selection, where the highlighted path makes them readable.
            if (!focusId && edges.length > 12) return null
            const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2
            let angle = Math.atan2(t.y - s.y, t.x - s.x) * (180 / Math.PI)
            if (angle > 90 || angle < -90) angle += 180
            const originConfidence = nodesById.get(e.from)?.confidence ?? 'low'
            return (
              <div
                key={`label-${e.id}`}
                title={e.evidence}
                style={{
                  position: 'absolute', left: `${mx}%`, top: `${my}%`, transform: `translate(-50%,-50%) rotate(${angle}deg)`,
                  fontSize: '8px', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, letterSpacing: '0.04em',
                  color: SOLANA_EDGE_COLOR[e.relationship], background: 'rgba(6,10,20,0.88)', padding: '1.5px 5px', borderRadius: '5px',
                  border: `1px solid ${SOLANA_EDGE_COLOR[e.relationship]}40`, whiteSpace: 'nowrap', pointerEvents: 'none',
                  opacity: entered ? (isFocusEdge ? 1 : 0) : 0, transition: 'opacity 300ms ease',
                }}
              >
                {SOLANA_EDGE_LABEL[e.relationship]} · {originConfidence}
              </div>
            )
          })}

          {nodes.map((node, i) => {
            const p = positions.get(node.id) ?? { x: 50, y: 50 }
            const isMint = node.role === 'mint'
            const isSelected = node.id === selectedId
            const isDimmed = !!focusId && !connectedIds?.has(node.id)
            const roleColor = SOLANA_CNODE_ROLE_COLOR[node.role]
            const riskColorNode = SOLANA_CNODE_RISK_COLOR[node.risk]
            const size = solanaBubbleSize(node)
            const stagger = Math.min(i, 12) * 55
            // The one number worth carrying ON the bubble: a real measured share. Everything else
            // (address, confidence tier, SOL balance, full evidence) lives in the detail panel.
            const pctLabel = node.supplyPercent != null
              ? (node.supplyPercent >= 10 ? `${node.supplyPercent.toFixed(0)}%` : `${node.supplyPercent.toFixed(1)}%`)
              : null
            return (
              <div
                key={node.id}
                onClick={() => setSelectedId(node.id)}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId((h) => (h === node.id ? null : h))}
                title={`${SOLANA_CNODE_ROLE_LABEL[node.role]} — ${fmt(node.address)}${pctLabel ? ` · holds ${pctLabel} of supply` : ''}`}
                style={{
                  position: 'absolute', left: `${p.x}%`, top: `${p.y}%`,
                  transform: `translate(-50%,-50%) scale(${entered ? (isSelected ? 1.08 : 1) : 0.4})`,
                  opacity: entered ? (isDimmed ? 0.3 : 1) : 0,
                  transition: `transform 380ms cubic-bezier(.2,.9,.3,1.3) ${stagger}ms, opacity 380ms ease ${stagger}ms`,
                  cursor: 'pointer', zIndex: isMint ? 6 : isSelected ? 5 : isDimmed ? 1 : 2,
                  width: `${size}px`, height: `${size}px`, borderRadius: '50%',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1px',
                  background: isMint
                    ? 'radial-gradient(circle at 35% 28%, rgba(45,212,191,.34), rgba(6,16,24,.98))'
                    : `radial-gradient(circle at 35% 28%, ${roleColor}2e, rgba(6,11,22,.96))`,
                  border: isMint ? '1.5px solid #67e8f9' : `1.5px solid ${isSelected ? '#f8fafc' : `${roleColor}70`}`,
                  boxShadow: isMint
                    ? (isDimmed ? '0 0 0 1px rgba(103,232,249,0.4), 0 8px 22px rgba(0,0,0,0.5)' : '0 0 0 1px rgba(103,232,249,0.55), 0 0 30px rgba(45,212,191,0.42), 0 10px 26px rgba(0,0,0,0.55)')
                    : isSelected ? `0 0 0 2px ${roleColor}80, 0 8px 20px rgba(0,0,0,0.5)` : `0 0 14px ${roleColor}22, 0 4px 10px rgba(0,0,0,0.35)`,
                }}
                className={isMint && !isDimmed ? 'sol-cluster-mint-glow' : undefined}
              >
                {isMint && (
                  <div style={{ position: 'absolute', top: '-22px', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 9px', borderRadius: '999px', background: 'rgba(45,212,191,0.16)', border: '1px solid rgba(45,212,191,0.5)', whiteSpace: 'nowrap' }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2dd4bf' }} className="sol-cluster-balance-pulse" />
                    <span style={{ fontSize: '7px', fontWeight: 800, letterSpacing: '.14em', color: '#5eead4', fontFamily: 'var(--font-plex-mono)' }}>YOU ARE HERE</span>
                  </div>
                )}
                {isMint ? (
                  <>
                    <SolanaTokenLogoPlaceholder symbol={tokenSymbol} name={tokenName} size={38} />
                    <p style={{ margin: '5px 6px 0', fontSize: '11px', fontWeight: 800, color: '#f0fdfa', fontFamily: 'var(--font-plex-mono)', textAlign: 'center', lineHeight: 1.2, maxWidth: '108px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tokenSymbol ? (tokenSymbol.startsWith('$') ? tokenSymbol : `$${tokenSymbol}`) : (tokenName ?? 'This Token')}
                    </p>
                    <p style={{ margin: 0, fontSize: '7.5px', fontWeight: 700, letterSpacing: '.1em', color: '#7dd3fc', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>This Token</p>
                  </>
                ) : (
                  <>
                    <SolanaRoleGlyph role={node.role} size={size >= 62 ? 16 : 13} color={roleColor} />
                    {/* A measured share is the headline when there is one; otherwise the bubble
                        stays clean rather than printing a stand-in number. */}
                    {pctLabel && (
                      <span style={{ fontSize: size >= 62 ? '13px' : '11px', fontWeight: 800, color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.1 }}>{pctLabel}</span>
                    )}
                    {/* Risk dot rides the rim so an elevated-risk wallet is visible at a glance
                        without adding a word of text. */}
                    {node.risk === 'elevated' && (
                      <span title="Elevated risk — open this wallet for the evidence" style={{ position: 'absolute', top: '6%', right: '6%', width: '9px', height: '9px', borderRadius: '50%', background: riskColorNode, border: '1.5px solid rgba(6,11,22,.9)' }} />
                    )}
                  </>
                )}
                {/* Role name sits OUTSIDE the bubble — the plain-English answer to "what is this?",
                    always legible regardless of how small the bubble's share made it. */}
                {!isMint && (
                  <span style={{ position: 'absolute', top: `${size + 3}px`, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: '8.5px', fontWeight: 700, color: isDimmed ? '#475569' : '#9db3c8', fontFamily: 'var(--font-plex-mono)', pointerEvents: 'none' }}>
                    {SOLANA_CNODE_ROLE_LABEL[node.role]}
                  </span>
                )}
              </div>
            )
          })}

          {expandableCount > SOLANA_COLLAPSED_EXPANDABLE_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 7, padding: '5px 11px', borderRadius: '999px', border: '1px solid rgba(96,165,250,0.45)', background: 'rgba(8,14,28,0.9)', color: '#93c5fd', fontSize: '9px', fontWeight: 700, letterSpacing: '.08em', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer' }}
            >
              {expanded ? 'COLLAPSE GRAPH' : `SHOW ALL ${clusterMap.nodes.length} NODES →`}
            </button>
          )}

          <div style={{ position: 'absolute', left: '10px', bottom: '10px', display: 'flex', gap: '10px', flexWrap: 'wrap', maxWidth: '92%' }}>
            {(Object.keys(SOLANA_CNODE_ROLE_LABEL) as SolanaCNode['role'][]).filter((role) => nodes.some((n) => n.role === role)).map((role) => (
              <div key={role} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: SOLANA_CNODE_ROLE_COLOR[role] }} />
                <span style={{ fontSize: '8px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)' }}>{SOLANA_CNODE_ROLE_LABEL[role]}</span>
              </div>
            ))}
            {/* The greyed "reserved role" chips that used to sit here are gone — see the note on
                the removed SOLANA_RESERVED_ROLE_LEGEND above. Nothing was hidden: the same
                unverifiable relationships, each with its reason, are listed in the "Cannot be
                verified (and why)" panel above the graph, straight from the engine. */}
            {sizedNodeCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                  <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#64748b' }} />
                  <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#94a3b8' }} />
                </span>
                <span style={{ fontSize: '8px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)' }}>Bigger = holds more supply</span>
              </div>
            )}
          </div>
        </div>

        {selectedNode && (
          <div style={{ padding: '12px', borderRadius: '12px', border: '1px solid rgba(148,163,184,0.2)', background: 'rgba(9,15,29,0.9)', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '470px', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <SolanaRoleGlyph role={selectedNode.role} size={13} color={SOLANA_CNODE_ROLE_COLOR[selectedNode.role]} />
                <p style={{ margin: 0, fontSize: '9px', letterSpacing: '.12em', color: SOLANA_CNODE_ROLE_COLOR[selectedNode.role], fontWeight: 700, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{SOLANA_CNODE_ROLE_LABEL[selectedNode.role]}</p>
              </div>
              <button type="button" onClick={() => setSelectedId(null)} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: '12px', cursor: 'pointer', padding: 0 }}>✕</button>
            </div>
            {selectedNode.role === 'mint' && (tokenName || tokenSymbol) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <SolanaTokenLogoPlaceholder symbol={tokenSymbol} name={tokenName} size={28} />
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: '12px', fontWeight: 800, color: '#f0fdfa', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tokenName ?? tokenSymbol}</p>
                  {tokenSymbol && <p style={{ margin: 0, fontSize: '10px', fontWeight: 700, color: '#5eead4', fontFamily: 'var(--font-plex-mono)' }}>{tokenSymbol.startsWith('$') ? tokenSymbol : `$${tokenSymbol}`}</p>}
                </div>
              </div>
            )}
            <p title={selectedNode.address} style={{ margin: 0, fontSize: selectedNode.role === 'mint' ? '9px' : '10px', color: selectedNode.role === 'mint' ? '#5b7284' : '#e2e8f0', fontFamily: 'var(--font-plex-mono)', wordBreak: 'break-all' }}>{selectedNode.address}</p>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '8.5px', fontWeight: 700, color: SOLANA_CNODE_CONFIDENCE_COLOR[selectedNode.confidence], border: `1px solid ${SOLANA_CNODE_CONFIDENCE_COLOR[selectedNode.confidence]}55` }}>CONFIDENCE {selectedNode.confidence.toUpperCase()}</span>
              <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '8.5px', fontWeight: 700, color: SOLANA_CNODE_RISK_COLOR[selectedNode.risk], border: `1px solid ${SOLANA_CNODE_RISK_COLOR[selectedNode.risk]}55` }}>RISK {selectedNode.risk.toUpperCase()}</span>
              {/* The number driving this bubble's size, stated exactly. Rendered only when it is a
                  measured fact — a null share is not shown as "0%", it is simply absent. */}
              {selectedNode.supplyPercent != null && (
                <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '8.5px', fontWeight: 700, color: '#7dd3fc', border: '1px solid #7dd3fc55' }}>HOLDS {selectedNode.supplyPercent.toFixed(2)}% OF SUPPLY</span>
              )}
            </div>

            {selectedNode.role !== 'mint' && (
              <div>
                <p style={{ margin: '0 0 4px', fontSize: '8.5px', letterSpacing: '.1em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Wallet Snapshot</p>
                {selectedBalance === null && <p style={{ margin: 0, fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>Loading…</p>}
                {selectedBalance === 'error' && <p style={{ margin: 0, fontSize: '10px', color: '#f87171', fontFamily: 'var(--font-plex-mono)' }}>Could not load wallet details.</p>}
                {selectedBalance && selectedBalance !== 'error' && (
                  <>
                    <p style={{ margin: 0, fontSize: '10px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)' }}>Balance: {selectedBalance.balanceResolved ? `${selectedBalance.balanceSol!.toFixed(4)} SOL` : 'Unavailable'}</p>
                    <p style={{ margin: '4px 0 0', fontSize: '10px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)' }}>Last activity: {selectedBalance.lastActivityResolved ? (selectedBalance.lastActivityTimestamp ?? selectedBalance.lastActivitySignature) : 'Unavailable'}</p>
                  </>
                )}
              </div>
            )}

            {fundingEdge && (
              <div>
                <p style={{ margin: '0 0 4px', fontSize: '8.5px', letterSpacing: '.1em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Funding Source</p>
                <p title={fundingEdge.from} style={{ margin: 0, fontSize: '10px', color: SOLANA_EDGE_COLOR[fundingEdge.relationship], fontFamily: 'var(--font-plex-mono)' }}>{fmt(fundingEdge.from)} — {SOLANA_EDGE_LABEL[fundingEdge.relationship]}</p>
                <p style={{ margin: '4px 0 0', fontSize: '9.5px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{fundingEdge.evidence}</p>
              </div>
            )}

            <div>
              <p style={{ margin: '0 0 4px', fontSize: '8.5px', letterSpacing: '.1em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Evidence</p>
              {selectedNode.evidence.map((ev, i) => (
                <p key={i} style={{ margin: i === 0 ? 0 : '4px 0 0', fontSize: '10px', color: '#8ea0b5', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{ev}</p>
              ))}
            </div>

            {connectedEdges.length > 0 && (
              <div>
                <p style={{ margin: '0 0 4px', fontSize: '8.5px', letterSpacing: '.1em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Connected Wallets</p>
                {connectedEdges.map((e) => {
                  const otherId = e.from === selectedNode.id ? e.to : e.from
                  const other = nodesById.get(otherId)
                  return (
                    <div key={e.id} style={{ marginTop: '4px' }}>
                      <p title={otherId} style={{ margin: 0, fontSize: '10px', color: SOLANA_CNODE_ROLE_COLOR[other?.role ?? 'mint'], fontFamily: 'var(--font-plex-mono)' }}>{fmt(otherId)} <span style={{ color: '#475569' }}>· {other ? SOLANA_CNODE_ROLE_LABEL[other.role] : 'Unknown'}</span></p>
                      <p style={{ margin: 0, fontSize: '9px', color: SOLANA_EDGE_COLOR[e.relationship], fontFamily: 'var(--font-plex-mono)' }}>{SOLANA_EDGE_LABEL[e.relationship]}</p>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <style>{`
        .sol-cluster-edge-flow { stroke-dasharray: 2 1.4; animation: solClusterFlow 2.4s linear infinite; }
        @keyframes solClusterFlow { to { stroke-dashoffset: -20; } }
        .sol-cluster-balance-pulse { animation: solClusterPulse 1.2s ease-in-out infinite; }
        @keyframes solClusterPulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.9; } }
        .sol-cluster-mint-glow { animation: solClusterMintGlow 2.6s ease-in-out infinite; }
        @keyframes solClusterMintGlow {
          0%, 100% { box-shadow: 0 0 0 1px rgba(103,232,249,0.55), 0 0 22px rgba(45,212,191,0.4), 0 10px 26px rgba(0,0,0,0.55); }
          50% { box-shadow: 0 0 0 1px rgba(103,232,249,0.8), 0 0 36px rgba(45,212,191,0.65), 0 10px 26px rgba(0,0,0,0.55); }
        }
        @media (max-width: 720px) { .sol-cluster-metrics { grid-template-columns: repeat(2,minmax(0,1fr)) !important; } }
        @media (prefers-reduced-motion: reduce) { .sol-cluster-edge-flow, .sol-cluster-balance-pulse, .sol-cluster-mint-glow { animation: none; } }
      `}</style>
    </div>
  )
}

// ─── LP Mode ─────────────────────────────────────────────────────────────────
// Classifies the LP model for this token so protocol-managed concentrated
// liquidity (V3/V4 on Base) is distinguished from V2 ERC-20 LP tokens.

type LpMode = 'protocol' | 'lp_token' | 'unknown'
function deriveLpMode(result: ScanResult): LpMode {
  // Use authoritative backend field when available
  const dm = result.lpControl?.displayLpModel
  if (dm === 'concentrated_liquidity' || dm === 'protocol_or_gauge') return 'protocol'
  if (dm === 'erc20_lp_token') return 'lp_token'
  if (dm === 'open_check' || dm === 'no_pool') return 'unknown'

  const chain = result.chain
  const lpStatus = result.lpControl?.status
  const lpPoolType = result.lpControl?.poolType
  const meta = result.lpMeta
  const v2Count = meta?.v2PoolCandidatesCount ?? null

  // lp_token: when V2 LP-token pools exist, use normal burn/lock proof path
  if (v2Count != null && v2Count > 0) return 'lp_token'
  if (lpStatus === 'burned' || lpStatus === 'locked' || lpStatus === 'team_controlled' || lpPoolType === 'v2') return 'lp_token'
  if (lpPoolType === 'v2' && (lpStatus === 'partial' || lpStatus === 'insufficient_data')) return 'lp_token'

  // protocol: Base + no V2 pools + any concentrated-liquidity signal
  if (chain === 'base' && (v2Count === 0 || v2Count == null)) {
    const isConcentrated = (
      meta?.lpControlState === 'concentrated_liquidity' ||
      lpStatus === 'concentrated_liquidity' ||
      meta?.lpProofUnavailableReason === 'no_v2_lp_token_pool_found' ||
      meta?.primaryMarketType === 'v3' ||
      (meta?.primaryMarketDex ?? '').toLowerCase().includes('uniswap v4')
    )
    if (isConcentrated) return 'protocol'
  }

  return 'unknown'
}

// ─── LP Safety Helpers ────────────────────────────────────────────────────

// Parses `top_holder=0x...` / `top_share=NN.NN%` entries out of lpControl.evidence
// for scans where structured holder fields aren't populated separately.
function parseLpEvidence(evidence?: string[] | null): { topHolder: string | null; topShare: number | null } {
  let topHolder: string | null = null
  let topShare: number | null = null
  for (const e of evidence ?? []) {
    const holderMatch = e.match(/^(?:top_holder|owner_lp_share_address)=(.+)$/)
    if (holderMatch) topHolder = holderMatch[1]
    const shareMatch = e.match(/^(?:top_share|owner_lp_share)=([\d.]+)%?$/)
    if (shareMatch) topShare = parseFloat(shareMatch[1])
  }
  return { topHolder, topShare }
}

// ROBINHOOD LP LABEL OVERRIDES (LP Safety display task): on Robinhood Chain, generic "Open Check"
// labels read as broken to users even when liquidity was found. These overrides replace the four
// generic labels with chain-honest wording. They never upgrade a status — only rename it:
//   - proof confirmed (locked/burned/wallet-controlled) passes through untouched;
//   - liquidity-without-proof renders as explicit partial/unverified with the reason.
// The required explainer sentence is part of the exit-risk description per spec.
function isRobinhoodScan(result: ScanResult): boolean {
  return result.chain === 'robinhood'
}

function tradingSimUiFor(result: ScanResult) {
  if (result.tradingSimulationAudit) return buildTradingSimulationUi(result.tradingSimulationAudit)
  const chainSlug = result.chain ?? ''
  const chainId = chainSlug === 'eth' ? 1
    : chainSlug === 'bnb' ? 56
    : chainSlug === 'robinhood' ? 4663
    : chainSlug === 'polygon' ? 137
    : chainSlug === 'base' ? 8453
    : chainSlug === 'solana' ? null
    : null
  return buildTradingSimulationUi(classifyTradingSimulation({
    chainSlug,
    chainId,
    tokenAddress: result.contract ?? '',
    timedOut: result.honeypot?.honeypotStatus === 'timeout',
    honeypotResult: result.honeypot?.isHoneypot ?? null,
    buyTax: result.honeypot?.buyTax ?? null,
    sellTax: result.honeypot?.sellTax ?? null,
    simulationSuccess: result.honeypot?.simulationSuccess ?? null,
    honeypotStatus: result.honeypot?.honeypotStatus ?? result.honeypot?.finalStatus ?? null,
    honeypotReason: result.honeypot?.honeypotReason ?? result.honeypot?.finalReason ?? null,
    requestAttempted: result.honeypot != null && chainSlug !== 'robinhood' && chainSlug !== 'solana',
  }))
}

const ROBINHOOD_LP_EXPLAINER = 'Liquidity was detected, but ChainLens could not verify LP lock/burn/controller proof for this Robinhood pool. Treat exit risk as unverified.'

function robinhoodProofCopy(result: ScanResult) {
  const audit = result.robinhoodLpProofAudit
  if (!audit) return null
  const concentrated = audit.poolType === 'v3' || audit.poolType === 'concentrated' || audit.concentratedProofAttempted && (result.lpControl?.displayLpModel === 'concentrated_liquidity' || result.lpControl?.status === 'concentrated_liquidity')
  const position = result.concentratedPositionProof?.status === 'verified'
    ? 'verified' as const
    : result.concentratedPositionProof?.status === 'partial'
      ? 'partial' as const
      : (concentrated ? 'unavailable' as const : null)
  return buildRobinhoodLpCopy({
    concentrated: Boolean(concentrated || result.lpControl?.status === 'concentrated_liquidity' || result.lpControl?.displayLpModel === 'concentrated_liquidity'),
    classification: audit.status,
    reason: audit.reason,
    positionOwnerProof: position,
  })
}

function robinhoodLpLabelOverrides(result: ScanResult): {
  lock?: { label: string; description: string }
  exit?: { label: string; color: string; description: string }
  model?: { label: string; description: string }
} | null {
  if (!isRobinhoodScan(result)) return null
  const lp = result.lpControl
  const status = lp?.status
  const hasLiquidity = (result.liquidity ?? 0) > 0 || lp?.poolAddressPresent
  const proofConfirmed = status === 'burned' || status === 'locked' || (result.lpLockStatus === 'locked' || result.lpLockStatus === 'burned')
  const walletControlled = status === 'team_controlled' || lp?.lpControllerType === 'wallet'
  if (!hasLiquidity) return null
  if (proofConfirmed || walletControlled) return null

  const copy = robinhoodProofCopy(result)
  const lockWhy = copy?.lockWhy ?? result.robinhoodLpProofAudit?.reason ?? ROBINHOOD_LP_EXPLAINER
  const concentrated = Boolean(copy?.concentratedNote)
  return {
    lock: {
      label: copy?.lockLabel ?? 'LP lock not confirmed',
      description: lockWhy,
    },
    exit: {
      label: 'Exit risk unverified',
      color: '#fbbf24',
      description: lockWhy,
    },
    model: {
      label: concentrated ? 'Concentrated LP model' : 'Robinhood LP Model Partial',
      description: concentrated
        ? 'Concentrated liquidity detected. Standard ERC-20 LP lock/burn proof does not apply. Controller/position proof still required.'
        : `Pool detected${lp?.primaryPoolDex || result.primaryDexName ? ` (${result.primaryDexName ?? lp?.primaryPoolDex})` : ''}, but LP lock/burn/controller proof is ${result.robinhoodLpProofAudit?.status === 'unavailable_with_reason' ? 'unavailable' : 'partial'} on Robinhood Chain.`,
    },
  }
}

// ROBINHOOD TOKEN EVIDENCE, DISCLOSED (Robinhood Chain evidence-gap audit — reported: holder
// concentration/owner status/security simulation/dev-cluster influence all showed generic "Open
// check" even when the backend had a real, specific reason). Builds the shared
// resolveRobinhoodTokenEvidence() input from fields already present on `result` — never a new
// provider call, never invented data. Holder/security/ownership/LP sections read straight off
// `result`; the dev-control section is deliberately left at safe, conservative defaults here (its
// real inputs — activeDevIntel/supplyControl — are section-local state computed only inside the Dev
// Control tab) and is resolved again, with its own real inputs, at that render site.
function robinhoodEvidenceFor(result: ScanResult): ReturnType<typeof resolveRobinhoodTokenEvidence> | null {
  if (!isRobinhoodScan(result)) return null
  const holderRows = result.holderDistribution?.topHolders ?? []
  const hp = result.honeypot
  const own = result.security?.devOwnership
  const lp = result.lpControl
  const lpProofApplicable = lp?.proofStatus !== 'not_applicable' && lp?.displayLpModel !== 'concentrated_liquidity' && lp?.displayLpModel !== 'protocol_or_gauge'
  return resolveRobinhoodTokenEvidence({
    chainSlug: 'robinhood',
    chainId: 4663,
    tokenAddress: result.contract ?? '',
    marketData: {
      hasPrice: result.price != null,
      hasLiquidity: (result.liquidity ?? 0) > 0,
      noActivePools: Boolean(result.noActivePools),
    },
    poolData: {
      poolCount: result.pools?.length ?? 0,
      liquidityUsd: result.liquidity ?? null,
      poolAddress: result.selectedPool?.address ?? null,
      dexName: result.primaryDexName ?? lp?.primaryPoolDex ?? null,
      poolModel: lp?.displayLpModel ?? null,
    },
    holderData: {
      topHoldersCount: holderRows.length,
      providerStatus: normalizeHolderProviderStatus(result.holderDistributionStatus),
      providerReason: result.holderDistributionStatus?.reason ?? null,
      providerAttempted: result.holderDistributionStatus?.status !== undefined,
    },
    securityData: {
      attempted: hp != null,
      simulationStatus: hp?.honeypotStatus ?? null,
      honeypotReason: hp?.honeypotReason ?? null,
      isHoneypot: hp?.isHoneypot ?? null,
    },
    ownershipData: {
      ownerAddress: own?.ownerAddress ?? null,
      adminAddress: own?.adminAddress ?? null,
      isRenounced: own?.isRenounced ?? null,
      checkCompleted: own != null,
    },
    lpData: {
      proofApplicable: lpProofApplicable,
      controllerType: lp?.lpControllerType ?? null,
      controllerVerified: lp?.status === 'burned' || lp?.status === 'locked' || lp?.lpControllerType === 'wallet',
      lockBurnRegistrySupported: false,
    },
    devControlData: {
      deployerAddress: null,
      deployerResolved: false,
      holderEvidenceAvailable: holderRows.length > 0,
      clusterSupplyPercent: null,
    },
  })
}

function getLpLockLabel(result: ScanResult): { label: string; color: string; bg: string; border: string; description: string } {
  const lp = result.lpControl
  const status = lp?.status
  const dm = lp?.displayLpModel
  const lpMode = getLpMode(result)
  const hasLiquidity = (result.liquidity ?? 0) > 0 || lp?.poolAddressPresent
  if (result.noActivePools && !hasLiquidity) return { label: 'No Active Pool', color: '#94a3b8', bg: 'rgba(148,163,184,0.07)', border: 'rgba(148,163,184,0.20)', description: 'No active liquidity pool detected on this chain. Token may be illiquid.' }
  // lpControl.status is the authoritative read — prioritize it over legacy lpLockStatus.
  if (status === 'team_controlled') {
    const label = lp?.lpControllerType === 'wallet' ? 'Wallet Controlled' : 'Team Controlled'
    return { label, color: '#fb923c', bg: 'rgba(251,146,60,0.07)', border: 'rgba(251,146,60,0.25)', description: lp?.reason ?? 'A single wallet holds a dominant share of the LP and can remove liquidity from this pool.' }
  }
  if (status === 'burned') return { label: 'Burned', color: '#34d399', bg: 'rgba(52,211,153,0.07)', border: 'rgba(52,211,153,0.22)', description: lp?.reason ?? 'On-chain data shows LP tokens sent to a burn address — exit liquidity is permanently locked.' }
  if (status === 'locked') {
    const unlockStr = result.lpUnlockTime ? ` Unlocks ${new Date(result.lpUnlockTime * 1000).toUTCString()}.` : ''
    return { label: 'Locked', color: '#34d399', bg: 'rgba(52,211,153,0.07)', border: 'rgba(52,211,153,0.22)', description: `${lp?.reason ?? `Active LP lock proof found${result.lpLockProvider ? ` via ${result.lpLockProvider}` : ''}.`}${unlockStr}` }
  }
  if (status === 'partial') return { label: 'Partial Proof', color: '#fbbf24', bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.20)', description: lp?.reason ?? 'LP proof is partially confirmed — some evidence is still missing.' }
  if (isUniswapV3ConcentratedPartial(result)) return { label: 'Protocol / Concentrated Liquidity', color: '#c084fc', bg: 'rgba(192,132,252,0.07)', border: 'rgba(192,132,252,0.22)', description: 'Primary pool uses Uniswap V3 concentrated liquidity. Standard ERC-20 LP lock/burn proof does not apply.' }
  if (dm === 'concentrated_liquidity' || status === 'concentrated_liquidity') return { label: 'Protocol / Concentrated Liquidity', color: '#c084fc', bg: 'rgba(192,132,252,0.07)', border: 'rgba(192,132,252,0.22)', description: 'V3/V4-style pool — standard ERC-20 LP lock/burn proof does not apply.' }
  if (dm === 'protocol_or_gauge' || status === 'protocol' || lpMode === 'protocol') return { label: 'Protocol Managed', color: '#a78bfa', bg: 'rgba(167,139,250,0.07)', border: 'rgba(167,139,250,0.22)', description: lp?.reason ?? 'Protocol-managed liquidity pool. LP lock/burn proof does not apply in this model.' }
  if (status === 'no_pool' && result.noActivePools) return { label: 'No Pool Found', color: '#94a3b8', bg: 'rgba(148,163,184,0.07)', border: 'rgba(148,163,184,0.20)', description: 'No active liquidity pool detected on this chain. Token may be illiquid.' }
  if (status === 'open_check') return { label: 'Open Check', color: '#fbbf24', bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.20)', description: lp?.reason ?? 'LP proof is an open check — verify lock, burn, and controller status on-chain.' }

  // Legacy fallback for scans without a resolved lpControl.status
  const lockStatus = result.lpLockStatus
  if (lockStatus === 'locked') {
    const unlockStr = result.lpUnlockTime ? ` Unlocks ${new Date(result.lpUnlockTime * 1000).toUTCString()}.` : ''
    return { label: 'Locked', color: '#34d399', bg: 'rgba(52,211,153,0.07)', border: 'rgba(52,211,153,0.22)', description: `Active LP lock proof found${result.lpLockProvider ? ` via ${result.lpLockProvider}` : ''}.${unlockStr}` }
  }
  if (lockStatus === 'burned') return { label: 'Burned', color: '#34d399', bg: 'rgba(52,211,153,0.07)', border: 'rgba(52,211,153,0.22)', description: 'On-chain data shows LP tokens sent to a burn address — exit liquidity is permanently locked.' }
  if (lockStatus === 'unlocked') return { label: 'Unlocked', color: '#f87171', bg: 'rgba(248,113,113,0.07)', border: 'rgba(248,113,113,0.22)', description: 'On-chain evidence shows the LP is held by a removable wallet with no lock or burn proof.' }
  if (result.noActivePools && !hasLiquidity) return { label: 'No Active Pool', color: '#94a3b8', bg: 'rgba(148,163,184,0.07)', border: 'rgba(148,163,184,0.20)', description: 'No usable liquidity pool found for this token.' }
  if (hasLiquidity) return { label: 'Unverified', color: '#fbbf24', bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.20)', description: 'Pool detected, but lock or burn proof has not been confirmed. Open check — verify on-chain.' }
  return { label: 'Unverified', color: '#fbbf24', bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.20)', description: 'LP lock/burn proof not confirmed. Treat exit liquidity as unprotected until verified.' }
}

function getLpExitRiskInfo(result: ScanResult): { label: string; color: string; description: string } {
  const lp = result.lpControl
  const status = lp?.status
  const dm = lp?.displayLpModel
  const lpMode = getLpMode(result)
  const liqDepth = result.liquidity ?? null
  const hasLiquidity = (liqDepth ?? 0) > 0 || lp?.poolAddressPresent
  if (result.noActivePools && !hasLiquidity) return { label: 'Critical', color: '#f87171', description: 'No active pool — exit liquidity is entirely unavailable.' }

  // A confirmed LP controller wallet is the strongest exit-risk signal — never downgrade
  // this to "Open Check" once the backend has confirmed wallet-controlled LP.
  if (status === 'team_controlled' || lp?.lpControllerType === 'wallet') {
    const { topHolder, topShare } = parseLpEvidence(lp?.evidence)
    const controllerAddr = (lp?.lpController && /^0x/i.test(lp.lpController)) ? lp.lpController : topHolder
    const shareStr = topShare != null ? `${topShare.toFixed(2)}%` : null
    const isHigh = result.lpExitRisk === 'high'
    const label = isHigh ? 'High' : 'Watch'
    const color = isHigh ? '#fb923c' : '#fbbf24'
    const description = result.lpExitRiskReason
      ?? `A single wallet${controllerAddr ? ` (${shorten(controllerAddr)})` : ''} holds${shareStr ? ` ${shareStr} of` : ''} the dominant LP share and can remove liquidity from this pool.`
    return { label, color, description }
  }

  if (isUniswapV3ConcentratedPartial(result)) {
    return { label: 'Monitor', color: '#a78bfa', description: 'Pool depth is strong, but concentrated position ownership is still unverified.' }
  }

  if (dm === 'concentrated_liquidity' || dm === 'protocol_or_gauge' || lpMode === 'protocol') {
    const isProtocol = dm === 'protocol_or_gauge' || lpMode === 'protocol'
    const baseDesc = isProtocol
      ? 'Protocol/gauge-managed — LP lock model does not apply.'
      : 'V3/V4 pool — LP lock/burn proof does not apply.'
    if (liqDepth != null && liqDepth > 500_000) return { label: 'Monitor', color: '#a78bfa', description: `${baseDesc} Pool depth is strong — monitor liquidity concentration and position migration.` }
    if (liqDepth != null && liqDepth > 50_000) return { label: 'Monitor', color: '#a78bfa', description: `${baseDesc} Monitor pool depth, volume, and holder concentration.` }
    if (liqDepth != null && liqDepth > 0) return { label: 'Watch', color: '#fbbf24', description: `${baseDesc} Liquidity is thin — monitor closely before committing size.` }
    // Label wording, DISCLOSED (same reported "open check isn't a fact" issue): the description
    // below already states the real situation; the label now matches it instead of reading as a
    // rating of its own. The branch, color, and conditions are unchanged.
    return { label: 'Unrated', color: '#c084fc', description: `${baseDesc} Pool depth data is insufficient to rate exit risk — verify on-chain before trading.` }
  }

  const lockStatus = result.lpLockStatus
  if (lockStatus === 'burned' || status === 'burned') return { label: liqDepth != null && liqDepth < 50_000 ? 'Medium' : 'Low', color: liqDepth != null && liqDepth < 50_000 ? '#a78bfa' : '#34d399', description: 'LP burned — exit liquidity permanently locked. Pool depth is the main remaining variable.' }
  if (lockStatus === 'locked' || status === 'locked') return { label: liqDepth != null && liqDepth < 50_000 ? 'Medium' : 'Low', color: liqDepth != null && liqDepth < 50_000 ? '#a78bfa' : '#34d399', description: 'LP locked with confirmed proof — protected for the lock duration. Pool depth is the main remaining variable.' }
  if (lockStatus === 'unlocked') return { label: 'High', color: '#fb923c', description: 'On-chain evidence shows the LP is held by a removable wallet — liquidity can be withdrawn without lock proof.' }

  // No proven lock/burn/wallet-control state — open check, not an inferred "High".
  if (liqDepth != null && liqDepth < 10_000) return { label: 'Watch', color: '#fbbf24', description: 'LP proof unconfirmed and liquidity is very thin — open check with elevated caution warranted.' }
  if (liqDepth != null && liqDepth < 50_000) return { label: 'Watch', color: '#fbbf24', description: 'LP proof unconfirmed and liquidity is thin — open check, monitor closely.' }
  return { label: 'Unrated', color: '#fbbf24', description: 'Exit risk cannot be rated until lock, burn, or controller proof is confirmed — verify on-chain.' }
}

const CONCENTRATED_OWNER_GAPS = [
  'Top liquidity owner not verified',
  'Active liquidity positions not indexed',
  'Position liquidity share not available',
]

function isConcentratedV3Position(result: ScanResult): boolean {
  if (!isProtocolPositionModel(result)) return false
  const model = result.concentratedPositionProof?.poolModel
  if (model) return model === 'uniswap_v3'
  const dex = result.lpHistoryTimeline?.primaryDex || result.primaryDexName || result.lpControl?.primaryPoolDex || result.lpControl?.dexName || result.lpModelProof?.dexName || ''
  return /uniswap/i.test(dex) && !/v4/i.test(dex)
}

function hasResolvedConcentratedManager(result: ScanResult): boolean {
  return isConcentratedV3Position(result) && Boolean(result.concentratedPositionProof?.positionManager)
}

function hasPartialConcentratedOwnershipGap(result: ScanResult): boolean {
  return isUniswapV3ConcentratedPartial(result)
}

function concentratedOwnerGapLabels(result: ScanResult): string[] {
  if (!isUniswapV3ConcentratedPartial(result)) return []
  const labels = [
    ...(result.concentratedPositionProofRead?.evidenceGaps ?? []),
    ...(result.lpEvidenceGaps?.map((gap) => gap.label) ?? []),
  ]
    .filter(Boolean)
    .filter((label) => !/lock\/burn|erc-20 lp-token|protocol-specific liquidity movement|verify protocol position ownership/i.test(label))
  if (labels.length === 0) return CONCENTRATED_OWNER_GAPS
  const out = Array.from(new Set(labels)).slice(0, 3)
  for (const fallback of CONCENTRATED_OWNER_GAPS) {
    if (out.length >= 3) break
    if (!out.includes(fallback)) out.push(fallback)
  }
  return out
}

function getLpRiskSummary(result: ScanResult): { goodSigns: string[]; riskSigns: string[]; missingProofs: string[] } {
  const lp = result.lpControl
  const dm = lp?.displayLpModel
  const lpMode = getLpMode(result)
  const status = lp?.status
  const liqDepth = result.liquidity ?? null
  const hasLiquidity = (liqDepth ?? 0) > 0 || lp?.poolAddressPresent
  const goodSigns: string[] = []
  const riskSigns: string[] = []
  const missingProofs: string[] = []
  const lockStatus = result.lpLockStatus
  const { topHolder, topShare } = parseLpEvidence(lp?.evidence)
  if (lockStatus === 'burned') goodSigns.push('On-chain proof: LP tokens sent to a burn address — exit liquidity is permanently locked.')
  if (lockStatus === 'locked') goodSigns.push(`Active LP lock proof found${result.lpLockProvider ? ` via ${result.lpLockProvider}` : ''}.`)
  else if (status === 'burned') goodSigns.push('LP tokens permanently burned — exit liquidity is protected.')
  else if (status === 'locked') goodSigns.push('LP tokens verified as locked in a locker contract.')
  // concentrated/protocol pools: informational note only — not a "good sign" since ERC-20 LP lock/burn proof was never checked
  const concentratedV3 = isConcentratedV3Position(result)
  if (isUniswapV3ConcentratedPartial(result) && liqDepth != null && liqDepth > 500_000) goodSigns.push('Deep liquidity observed')
  else if (liqDepth != null && liqDepth > 500_000) goodSigns.push(`Deep liquidity — ${fmtLarge(liqDepth)} pool depth.`)
  else if (liqDepth != null && liqDepth > 100_000) goodSigns.push(`Moderate liquidity — ${fmtLarge(liqDepth)} pool depth.`)
  if (concentratedV3) {
    if (lp?.poolAddressPresent || result.concentratedPositionProof?.poolAddress) goodSigns.push('Primary concentrated pool found')
    if (result.concentratedPositionProof?.positionManager) goodSigns.push(isUniswapV3ConcentratedPartial(result) ? 'Uniswap V3 position manager resolved' : 'Position manager resolved')
    if (result.concentratedPositionProof?.status === 'partial' || result.concentratedPositionProof?.evidence?.some((e) => /liquidity|slot0|active/i.test(e))) goodSigns.push('Pool active/liquidity confirmed')
    if (result.security?.devOwnership?.isRenounced) goodSigns.push('Ownership renounced')
  } else {
    if (lp?.poolAddressPresent) goodSigns.push('Liquidity pool detected and indexed.')
    if (dm && dm !== 'open_check' && dm !== 'no_pool') goodSigns.push('Primary LP model resolved.')
  }

  // Wallet/team-controlled LP is a confirmed risk signal — never collapse to "no confirmed risk signals".
  if (status === 'team_controlled') {
    const shareStr = topShare != null ? `${topShare.toFixed(2)}%` : null
    riskSigns.push(`Dominant LP holder controls${shareStr ? ` ${shareStr} of` : ''} the selected LP position.`)
    const controllerAddr = (lp?.lpController && /^0x/i.test(lp.lpController)) ? lp.lpController : topHolder
    if (controllerAddr) riskSigns.push(`Controller wallet: ${shorten(controllerAddr)}`)
  }
  if (lockStatus === 'unlocked') riskSigns.push('On-chain evidence shows the LP is held by a removable wallet with no lock or burn proof.')
  if ((result.noActivePools || status === 'no_pool') && !hasLiquidity) riskSigns.push('No active liquidity pool — token may be illiquid.')
  if (liqDepth != null && liqDepth < 10_000 && !result.noActivePools) riskSigns.push(`Very thin liquidity — ${fmtLarge(liqDepth)} depth.`)
  else if (liqDepth != null && liqDepth < 50_000 && !result.noActivePools) riskSigns.push(`Thin liquidity — ${fmtLarge(liqDepth)}.`)

  const lockBurnApplicable = lp?.lockBurnApplicable ?? (lpMode !== 'protocol' && dm !== 'concentrated_liquidity' && dm !== 'protocol_or_gauge')
  const lockConfirmed = lockStatus === 'locked' || status === 'locked'
  const burnConfirmed = lockStatus === 'burned' || status === 'burned'
  if (lockBurnApplicable && !lockConfirmed && !burnConfirmed) {
    riskSigns.push('Lock proof not confirmed.')
    riskSigns.push('Burn proof not confirmed.')
    missingProofs.push('Lock proof unconfirmed.')
    missingProofs.push('Burn proof unconfirmed.')
  }
  if (concentratedV3) {
    if (hasPartialConcentratedOwnershipGap(result)) {
      riskSigns.push('Concentrated position owner not verified')
      riskSigns.push('Active position count unavailable')
      riskSigns.push('Position liquidity share unavailable')
    }
    missingProofs.push(...concentratedOwnerGapLabels(result))
  }
  if (!lockBurnApplicable && dm !== 'concentrated_liquidity' && dm !== 'protocol_or_gauge' && lpMode === 'unknown' && !result.noActivePools) missingProofs.push('LP token model could not be classified.')
  if (!lp?.poolAddressPresent && !result.noActivePools && liqDepth == null) missingProofs.push('Pool address not yet indexed.')
  return { goodSigns: goodSigns.slice(0, 5), riskSigns: riskSigns.slice(0, 4), missingProofs: Array.from(new Set(missingProofs)).slice(0, 3) }
}

type LpEliteChip = { label: string; value: string; color: string }

function getLpEliteSummary(result: ScanResult): { chips: LpEliteChip[]; verdict: string; openChecks: string[]; monitor: string[]; evidenceGaps: string[] } {
  const ci = result.lpControllerIntel
  const mv = result.lpMovementWatch
  const lb = result.lpLockBurnIntel
  const ut = result.lpUnlockTimeline
  const ht = result.lpHistoryTimeline

  const protocolPosition = isProtocolPositionModel(result)
  const controllerValue = isUniswapV3ConcentratedPartial(result) ? 'Position proof attempted — partial' : protocolPosition ? (ci?.controllerLabel ?? (hasResolvedConcentratedManager(result) ? 'Position proof attempted — partial' : 'Position check unavailable')) : cleanStatusLabel(ci?.status)
  const controllerColor = (ci?.status === 'locked' || ci?.status === 'burned' || ci?.status === 'protected') ? '#34d399'
    : (ci?.status === 'protocol_controlled' || ci?.status === 'concentrated_liquidity' || ci?.status === 'no_pool') ? '#94a3b8'
    : '#fbbf24'

  const lockBurnValue = protocolPosition ? 'Protocol-specific' : cleanStatusLabel(lb?.lockBurnProof)
  const lockBurnColor = lb?.lockBurnProof === 'confirmed' ? '#34d399' : lb?.lockBurnProof === 'not_applicable' ? '#94a3b8' : '#fbbf24'

  const unlockValue = protocolPosition ? 'Protocol-specific' : cleanStatusLabel(ut?.unlockRisk)
  const unlockColor = (ut?.unlockRisk === 'high' || ut?.unlockRisk === 'expired') ? '#f87171'
    : (ut?.unlockRisk === 'low' || ut?.unlockRisk === 'none') ? '#34d399'
    : (ut?.unlockRisk === 'not_applicable') ? '#94a3b8'
    : '#fbbf24'

  const movementValue = protocolPosition ? 'Position movement required' : cleanStatusLabel(mv?.movementRisk ?? mv?.status)
  const movementColor = mv?.movementRisk === 'high' ? '#f87171'
    : (mv?.movementRisk === 'low' || mv?.movementRisk === 'protected') ? '#34d399'
    : (mv?.status === 'not_applicable') ? '#94a3b8'
    : '#fbbf24'

  const migrationValue = cleanStatusLabel(ht?.migrationRisk)
  const migrationColor = ht?.migrationRisk === 'high' ? '#f87171'
    : ht?.migrationRisk === 'low' ? '#34d399'
    : ht?.migrationRisk === 'unknown' ? '#94a3b8'
    : '#fbbf24'

  const chips: LpEliteChip[] = [
    { label: protocolPosition ? 'Control Proof' : 'Controller', value: controllerValue, color: controllerColor },
    { label: 'Lock/Burn', value: lockBurnValue, color: lockBurnColor },
    { label: 'Unlock', value: unlockValue, color: unlockColor },
    { label: 'Movement', value: movementValue, color: movementColor },
    { label: 'Migration', value: migrationValue, color: migrationColor },
  ]

  const foundParts: string[] = []
  if (ci?.controllerLabel) foundParts.push(ci.controllerLabel.toLowerCase())
  if (ci?.controllerSharePercent != null) foundParts.push(`holding ~${ci.controllerSharePercent.toFixed(2)}% of the LP`)
  const found = foundParts.length ? foundParts.join(', ') : 'LP control evidence is limited so far'

  let mainRisk = 'LP exit-liquidity protections look favorable based on current evidence.'
  if ([controllerColor, lockBurnColor, unlockColor, movementColor, migrationColor].includes('#f87171')) {
    mainRisk = 'Elevated LP risk signals were detected — review before sizing.'
  } else if ([controllerColor, lockBurnColor, unlockColor, movementColor, migrationColor].includes('#fbbf24')) {
    mainRisk = 'No confirmed exit-liquidity protection yet — treat the LP as removable until lock/burn proof is confirmed.'
  }

  const openChecks = chips.filter((c) => /open check|unknown|watch/.test(c.value)).map((c) => c.label)
  const monitor = Array.from(new Set([
    ...(ci?.nextActions ?? []),
    ...(mv?.nextActions ?? []),
    ...(lb?.nextActions ?? []),
    ...(ut?.nextActions ?? []),
    ...(ht?.nextActions ?? []),
  ])).slice(0, 4)

  const evidenceGaps = Array.from(new Set([
    ...(ci?.evidenceGaps ?? []),
    ...(mv?.evidenceGaps ?? []),
    ...(lb?.evidenceGaps ?? []),
    ...(ut?.evidenceGaps ?? []),
    ...(ht?.evidenceGaps ?? []),
  ]))

  const foundSentence = `${found.charAt(0).toUpperCase()}${found.slice(1)}.`
  const openChecksSentence = openChecks.length ? ` Still open check: ${openChecks.join(', ')}.` : ''
  const verdict = `${foundSentence} ${mainRisk}${openChecksSentence}`

  return { chips, verdict, openChecks, monitor, evidenceGaps }
}

function getLpNextAction(result: ScanResult): string {
  const lp = result.lpControl
  const dm = lp?.displayLpModel
  const lpMode = getLpMode(result)
  const status = lp?.status
  const liqDepth = result.liquidity ?? null
  const hasLiquidity = (liqDepth ?? 0) > 0 || result.lpControl?.poolAddressPresent
  const lockStatus = result.lpLockStatus
  if ((result.noActivePools || status === 'no_pool') && !hasLiquidity) return 'No active pool found. Verify the contract address and chain before trading.'
  if (lockStatus === 'burned' || status === 'burned') return liqDepth != null && liqDepth < 50_000 ? 'LP is burned (on-chain proof) — good sign. Pool depth is thin, so monitor liquidity before committing size.' : 'LP is burned (on-chain proof) — exit liquidity is permanently locked. Still monitor holder concentration and trading taxes.'
  if (lockStatus === 'locked' || status === 'locked') return `LP lock proof was found${result.lpLockProvider ? ` via ${result.lpLockProvider}` : ''} — independently confirm the lock duration and expiry before assuming permanent protection.`
  if (status === 'team_controlled') {
    const { topHolder, topShare } = parseLpEvidence(lp?.evidence)
    const controllerAddr = (lp?.lpController && /^0x/i.test(lp.lpController)) ? lp.lpController : topHolder
    const shareStr = topShare != null ? ` (${topShare.toFixed(2)}% of LP supply)` : ''
    return `LP is controlled by a single wallet${controllerAddr ? ` (${shorten(controllerAddr)})` : ''}${shareStr} and has no lock or burn proof. Monitor this wallet, holder distribution, and lock/burn status before treating exit liquidity as protected.`
  }
  if (dm === 'concentrated_liquidity') return 'Primary liquidity uses a protocol position model. Review position ownership, pool depth, age, volume, and holder concentration.'
  if (dm === 'protocol_or_gauge') return 'Protocol or gauge-based liquidity can be normal. Monitor depth, pool age, and whether liquidity is moving.'
  if (lpMode === 'protocol') return 'Primary liquidity uses a protocol position model. Review position ownership, pool depth, age, and holder concentration.'
  if (lockStatus === 'unlocked') return 'On-chain evidence shows the LP is held by a removable wallet with no lock or burn proof — treat exit risk as elevated and avoid large positions.'
  return 'LP lock/burn proof is an open check — verify directly on-chain (lock explorer, LP token holder list) before trusting any safety claim.'
}

// ─── CORTEX Score Engine ──────────────────────────────────────────────────

type CortexScoreResult = {
  score:      number
  verdict:    'CLEAN LOOKING' | 'WATCH' | 'CAUTION' | 'AVOID' | 'UNKNOWN'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  scanQuality: 'FULL' | 'PARTIAL' | 'LIMITED'
  capReason:  string | null
  breakdown: {
    market:    { status: string; score: number; reason: string }
    liquidity: { status: string; score: number; reason: string }
    holders:   { status: string; score: number; reason: string }
    security:  { status: string; score: number; reason: string }
    lp:        { status: string; score: number; reason: string }
    missing:   { status: string; penalty: number; reason: string }
  }
}

function getVerdictStyle(verdict: CortexScoreResult['verdict'] | CortexScoreResultV2['verdict'] | 'Strong' | 'High Risk' | 'Open Check'): { label: string; color: string; bg: string; border: string } {
  switch (verdict) {
    case 'High Risk':
    case 'AVOID':        return { label: verdict === 'High Risk' ? 'HIGH RISK' : 'AVOID', color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)' }
    case 'Strong':
    case 'CLEAN LOOKING':return { label: verdict === 'Strong' ? 'STRONG' : 'CLEAN LOOKING', color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.35)'  }
    case 'WATCH':        return { label: 'WATCH',         color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)'  }
    case 'CAUTION':      return { label: 'CAUTION',       color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.30)'  }
    case 'Open Check':
    case 'OPEN CHECK':   return { label: 'OPEN CHECK',    color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)'  }
    default:             return { label: 'UNKNOWN',       color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' }
  }
}

// ─── Token Safety Score helpers ────────────────────────────────────────────
const RISK_LABEL_MAP: Record<string, string> = {
  extreme: 'Extreme Risk',
  critical: 'Extreme Risk',
  high: 'High Risk',
  moderate: 'Moderate Risk',
  medium: 'Moderate Risk',
  caution: 'Caution',
  elevated: 'Caution',
  low: 'Low Risk',
  very_low: 'Low Risk',
  'Medium Risk': 'Moderate Risk',
  'Critical Risk': 'Extreme Risk',
  'Elevated Risk': 'Caution',
}

function getRiskLabelDisplay(riskLabel?: string | null): string {
  if (!riskLabel) return 'Unrated'
  return coerceCanonicalRiskLabel(riskLabel) ?? RISK_LABEL_MAP[riskLabel] ?? riskLabel
}

const RISK_REASON_MAP: Record<string, string> = {
  market_cap_unavailable: 'Market cap unavailable',
  market_cap_derived_from_fdv_low_confidence: 'Market cap estimated from FDV (low confidence)',
  liquidity_depth_unavailable: 'Liquidity depth unavailable',
  holder_distribution_unavailable: 'Holder distribution unavailable',
  top_holder_owns_over_50_percent: 'Top holder owns over 50% of supply',
  top5_holders_own_over_70_percent: 'Top 5 holders own over 70% of supply',
  top10_holders_own_over_80_percent: 'Top 10 holders own over 80% of supply',
  top10_holders_under_40_percent: 'Top 10 holders below 40%',
  top10_holders_under_60_percent: 'Top 10 holders below 60%',
  moderate_holder_concentration: 'Moderate holder concentration',
  lp_burn_confirmed: 'LP burn confirmed',
  lp_lock_confirmed: 'LP lock confirmed',
  lp_controlled_by_wallet_no_lock_or_burn_proof: 'Wallet-controlled LP with no confirmed lock or burn',
  lp_controller_unknown_no_lock_or_burn_proof: 'LP controller unknown — no confirmed lock or burn',
  lp_lock_burn_proof_incomplete: 'LP lock/burn proof incomplete',
  lp_lock_burn_status_low_confidence_default: 'LP lock/burn status not confirmed',
  lp_model_erc20_lp_token: 'Standard LP token model',
  lp_model_concentrated_liquidity: 'Concentrated liquidity pool model',
  lp_model_protocol_pool: 'Protocol-managed pool model',
  lp_model_unknown_or_unclassified: 'LP model not classified',
  lp_controller_burn_or_lock_confirmed: 'LP controller is a confirmed burn or lock address',
  lp_controller_team_wallet_no_lock: 'LP controller is a wallet with no confirmed lock',
  lp_controller_contract_lock_burn_unproven: 'LP controller is a contract — lock/burn unproven',
  lp_controller_standard_lock_not_applicable: 'Standard LP lock does not apply to this pool model',
  lp_controller_unknown: 'LP controller unknown',
  source_code_verified: 'Source code verified',
  source_verification_unavailable: 'Source-level contract review not confirmed',
  mint_function_detected: 'Mint function detected',
  blacklist_function_detected: 'Blacklist function detected',
  trading_pause_detected: 'Trading pause function detected',
  transfer_tax_above_10_percent: 'Transfer tax above 10%',
  deployer_confirmed: 'Deployer confirmed',
  deployer_unknown_or_unconfirmed: 'Deployer unknown or unconfirmed',
  high_early_buyer_concentration: 'High early-buyer concentration',
  early_buyer_evidence_missing: 'Early-buyer evidence missing',
  organic_early_buyer_pattern: 'Organic early-buyer pattern',
  moderate_early_buyer_signal: 'Moderate early-buyer signal',
  dev_wallet_flagged_dumping_or_suspicious: 'Dev wallet flagged for dumping or suspicious activity',
  dev_wallet_no_confirmed_dumping: 'No confirmed dev-wallet dumping',
  dev_wallet_evidence_missing: 'Dev wallet evidence missing',
  confirmed_high_risk_cluster: 'Confirmed high-risk wallet cluster',
  no_significant_cluster_links: 'No significant cluster links',
  cluster_evidence_missing_or_partial: 'Cluster evidence missing or partial',
}

function translateRiskReason(reason: string): string {
  if (RISK_REASON_MAP[reason]) return RISK_REASON_MAP[reason]
  return reason
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function getMarketRead(result: ScanResult): string {
  if (result.noActivePools) return 'No active pool found. Market data is unavailable.'
  const parts = [
    result.price != null    ? `price ${fmtPrice(result.price)}` : null,
    result.liquidity != null ? `liquidity ${fmtLarge(result.liquidity)}` : null,
    result.volume24h != null ? `volume ${fmtLarge(result.volume24h)} 24h` : null,
    result.priceChange24h != null ? `${fmtPct(result.priceChange24h)} change` : null,
  ].filter(Boolean)
  const mc = result.marketCapUsd != null
    ? `Market cap ${fmtLarge(result.marketCapUsd)} — verified live.`
    : result.fdvUsd != null
      ? `Market cap not confirmed — FDV ${fmtLarge(result.fdvUsd)} shown as context.`
      : 'Market cap not verified.'
  return parts.length ? `${parts.join(', ')}. ${mc}` : 'Market data unavailable.'
}

function getSecurityRead(result: ScanResult): string {
  const hp = result.honeypot
  const simUi = tradingSimUiFor(result)
  if (hp?.isHoneypot === true) return 'Honeypot flagged — sell simulation detected blocked transaction.'
  if (simUi.statusLabel === 'Verified clear') {
    const parts = [
      'Honeypot: not flagged',
      hp?.buyTax != null ? `buy tax ${hp.buyTax.toFixed(1)}%` : null,
      hp?.sellTax != null ? `sell tax ${hp.sellTax.toFixed(1)}%` : null,
      hp?.transferTax != null && hp.transferTax > 0 ? `transfer tax ${hp.transferTax.toFixed(1)}%` : null,
    ].filter(Boolean)
    return parts.join(', ') + '. Simulation verified.'
  }
  return `${simUi.statusLabel}. ${simUi.reason}`
}

function getHolderRead(result: ScanResult): string {
  const holderState = deriveHolderState(result)
  if (holderState.kind === 'noRowsFallback') {
    // ROBINHOOD-EVIDENCE FIX, DISCLOSED: chain-generic "open check" replaced with the resolver's
    // real classification (unsupported-for-Robinhood vs. genuinely-not-returned-this-pass) when
    // this is a Robinhood scan.
    const robinhood = robinhoodEvidenceFor(result)
    if (robinhood) return robinhood.holderLabel
    return 'Holder distribution was not returned this scan. Supply spread is an open check.'
  }
  if (holderState.kind === 'rowsWithoutPercent') return 'Holder wallets available, but supply percentages not confirmed. Concentration is an open check.'
  const top10 = result.holderDistribution?.top10
  const count = result.holderDistribution?.holderCount
  const parts = [
    count != null ? `${count.toLocaleString()} holders on record` : null,
    top10 != null ? `top 10 hold ${top10.toFixed(1)}%` : null,
    result.holderDistribution?.top20 != null ? `top 20 hold ${result.holderDistribution.top20.toFixed(1)}%` : null,
  ].filter(Boolean)
  return parts.length ? `Holder distribution confirmed. ${parts.join(', ')}.` : 'Holder distribution available but details sparse.'
}

function getLiquidityRead(result: ScanResult): string {
  const liq = result.liquidity ?? 0
  const poolCount = result.pools?.length ?? 0
  if (result.noActivePools || poolCount === 0) return `No active liquidity pool detected on ${chainDisplayName(result.chain)}.`
  const depth = liq > 1_000_000 ? 'Deep' : liq > 200_000 ? 'Moderate' : liq > 50_000 ? 'Limited' : liq > 0 ? 'Thin' : 'Not indexed'
  const poolStr = poolCount > 1 ? `${poolCount} pools found.` : 'Primary pool found.'
  const lpLockStatus = result.lpLockStatus
  const lpStr = lpLockStatus === 'locked' ? 'LP lock proof found.' : lpLockStatus === 'burned' ? 'LP burn proof found.' : lpLockStatus === 'unlocked' ? 'LP held by removable wallet — no lock/burn proof.' : 'LP lock/burn status unverified.'
  return `${depth} liquidity (${fmtLarge(liq)}). ${poolStr} ${lpStr}`
}

// ─── CORTEX Summary Card ──────────────────────────────────────────────────

function CortexSummaryCard({ result }: { result: ScanResult }) {
  const v = getSummaryVerdict(result)
  const reasons = getSummaryReasons(result)
  const missing = getMissingChecks(result)
  const next = getNextAction(result)
  const confidence = result.marketConfidence === 'high' ? 'HIGH' : result.marketConfidence === 'medium' ? 'MEDIUM' : 'LOW'
  const confColor = confidence === 'HIGH' ? '#34d399' : confidence === 'MEDIUM' ? '#fbbf24' : '#94a3b8'
  return (
    <div style={{
      marginBottom: '22px',
      background: 'linear-gradient(160deg, rgba(8,16,32,.97), rgba(4,8,18,.95))',
      border: `1px solid ${v.color}28`,
      borderRadius: '16px',
      padding: '20px 22px',
      boxShadow: `0 0 36px ${v.color}0e, 0 0 0 1px rgba(255,255,255,0.04) inset`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>
          CORTEX SCAN SUMMARY
        </span>
        <span style={{ padding: '3px 12px', borderRadius: '999px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.10em', color: v.color, background: v.bg, border: `1px solid ${v.border}`, fontFamily: 'var(--font-plex-mono)' }}>
          {v.label}
        </span>
        <span style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: confColor, background: `${confColor}12`, border: `1px solid ${confColor}38`, fontFamily: 'var(--font-plex-mono)' }}>
          {confidence} CONFIDENCE
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', marginBottom: '14px' }}>
        {reasons.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <span style={{ color: '#2DD4BF', fontSize: '11px', flexShrink: 0, fontFamily: 'var(--font-plex-mono)' }}>•</span>
            <p style={{ margin: 0, fontSize: '12px', color: '#b7c9da', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{r}</p>
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'flex-start' }}>
        {missing.length > 0 && (
          <div style={{ flex: '1 1 180px' }}>
            <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#3a5268', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Missing checks</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
              {missing.slice(0, 4).map((m) => (
                <span key={m} style={{ padding: '2px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}
        <div style={{ flex: '2 1 220px' }}>
          <p style={{ margin: '0 0 4px', fontSize: '9px', color: '#3a5268', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Next action</p>
          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{next}</p>
        </div>
      </div>
    </div>
  )
}

// ─── Risk Gauge Circle ───────────────────────────────────────────────

function RiskGaugeCircle({ score, color, scoreType = 'safety' }: { score: number | null; color: string; scoreType?: 'risk' | 'safety' }) {
  const size = 152
  const sw = 9
  const r = (size - sw) / 2
  const circ = 2 * Math.PI * r
  const pct = score != null ? (scoreType === 'risk' ? riskGaugeFillPercent(score) : Math.max(0, Math.min(100, score))) / 100 : 0
  const offset = circ - pct * circ
  const gradId = `riskGaugeGrad-${color.replace('#', '')}`
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <div style={{ position: 'absolute', inset: '10px', borderRadius: '50%', background: `radial-gradient(circle, ${color}14 0%, transparent 70%)` }} />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', position: 'relative' }}>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="0.55" />
            <stop offset="100%" stopColor={color} stopOpacity="1" />
          </linearGradient>
        </defs>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth={sw} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={`url(#${gradId})`} strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={score != null ? offset : circ}
          style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.4s ease', filter: `drop-shadow(0 0 10px ${color}70)` }}
        />
      </svg>
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '3px' }}>
        <span style={{ fontSize: '34px', fontWeight: 800, color, fontFamily: 'var(--font-plex-mono)', lineHeight: 1, letterSpacing: '-0.01em' }}>
          {score != null ? score : '—'}
        </span>
        <span style={{ fontSize: '8px', color: '#4a6178', letterSpacing: '.16em', fontFamily: 'var(--font-plex-mono)' }}>/ 100 {scoreType === 'risk' ? 'RISK' : 'SAFETY'}</span>
      </div>
    </div>
  )
}

// ─── Contract Security ───────────────────────────────────────────────

type PillStyle = { color: string; bg: string; border: string }

function pillSafe():   PillStyle { return { color: '#34d399', bg: 'rgba(52,211,153,0.09)',   border: 'rgba(52,211,153,0.22)'   } }
function pillDanger(): PillStyle { return { color: '#f87171', bg: 'rgba(248,113,113,0.09)', border: 'rgba(248,113,113,0.25)' } }
function pillAmber():  PillStyle { return { color: '#fbbf24', bg: 'rgba(251,191,36,0.09)',  border: 'rgba(251,191,36,0.25)'  } }
function pillMuted():  PillStyle { return { color: '#3a5268', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)' } }

function RiskPill({ label, value }: { label: string; value: PillStyle & { label: string } }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '5px 11px', borderRadius: '99px',
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
      fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
      color: value.color, background: value.bg, border: `1px solid ${value.border}`,
    }}>
      <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 500 }}>{label}:</span>
      {value.label}
    </span>
  )
}

type HoneypotData = {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  transferTax: number | null
  simulationSuccess: boolean
} | null

function taxPct(n: number): PillStyle {
  if (n === 0)    return pillSafe()
  if (n <= 5)     return pillAmber()
  return pillDanger()
}

function ContractRiskSection({ gp, hp }: { gp: Record<string, unknown> | null; hp: HoneypotData }) {
  const hasAnyData = gp || (hp && hp.simulationSuccess)
  if (!hasAnyData) return (
    <div style={{ marginTop: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '12px', fontFamily: 'var(--font-plex-mono)',
      }}>
        Security Simulation
      </p>
      <div style={{
        padding: '14px 18px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '10px',
        fontSize: '11px', color: '#3a5268',
        fontFamily: 'var(--font-plex-mono)',
      }}>
        No security simulation data surfaced — {hp ? 'provider result was empty.' : 'simulation did not run.'}
      </div>
    </div>
  )

  // Build honeypot.is pills
  const hpPills: { label: string; displayLabel: string; style: PillStyle }[] = []
  if (hp && hp.simulationSuccess) {
    hpPills.push({
      label: 'Honeypot',
      displayLabel: hp.isHoneypot ? 'YES' : 'NO',
      style: hp.isHoneypot ? pillDanger() : pillSafe(),
    })
    if (hp.buyTax !== null) hpPills.push({
      label: 'Buy Tax',
      displayLabel: `${hp.buyTax.toFixed(1)}%`,
      style: taxPct(hp.buyTax),
    })
    if (hp.sellTax !== null) hpPills.push({
      label: 'Sell Tax',
      displayLabel: `${hp.sellTax.toFixed(1)}%`,
      style: taxPct(hp.sellTax),
    })
    if (hp.transferTax !== null && hp.transferTax > 0) hpPills.push({
      label: 'Transfer Tax',
      displayLabel: `${hp.transferTax.toFixed(1)}%`,
      style: taxPct(hp.transferTax),
    })
  }

  function flagPill(key: string, label: string, dangerOn = '1'): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label, displayLabel: 'N/A', style: pillMuted() }
    const raw = gp[key]
    if (raw == null) return { label, displayLabel: 'N/A', style: pillMuted() }
    const v = String(raw)
    const isDanger = v === dangerOn
    return {
      label,
      displayLabel: v === '1' ? 'YES' : v === '0' ? 'NO' : v,
      style: isDanger ? pillDanger() : pillSafe(),
    }
  }

  function taxPill(key: string, label: string): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label, displayLabel: 'N/A', style: pillMuted() }
    const raw = gp[key]
    if (raw == null) return { label, displayLabel: 'N/A', style: pillMuted() }
    const n = parseFloat(String(raw))
    if (isNaN(n)) return { label, displayLabel: 'N/A', style: pillMuted() }
    const pct = (n * 100).toFixed(1)
    return {
      label,
      displayLabel: `${pct}%`,
      style: n > 0.1 ? (n > 0.05 ? pillDanger() : pillAmber()) : pillSafe(),
    }
  }

  function ownerPill(): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label: 'Owner', displayLabel: 'N/A', style: pillMuted() }
    const addr = String(gp['owner_address'] ?? '')
    const renounced = !addr || addr === '0x0000000000000000000000000000000000000000'
    return {
      label: 'Owner',
      displayLabel: renounced ? 'RENOUNCED' : 'HELD',
      style: renounced ? pillSafe() : pillAmber(),
    }
  }

  const gpPills = gp ? [
    flagPill('is_honeypot',            'Honeypot'),
    flagPill('is_mintable',            'Mint Function'),
    flagPill('can_take_back_ownership','Ownership Revert'),
    flagPill('is_proxy',               'Proxy Contract', '__never__'),
    flagPill('is_blacklisted',         'Blacklist'),
    flagPill('is_whitelisted',         'Whitelist',      '__never__'),
    taxPill('buy_tax',  'Buy Tax'),
    taxPill('sell_tax', 'Sell Tax'),
    ownerPill(),
  ] : []
  const deduped = dedupeSecurityChips([
    ...hpPills.map(p => ({ ...p, source: 'honeypot' as const })),
    ...gpPills.map(p => ({ ...p, source: 'contract' as const })),
  ])

  return (
    <div style={{ marginTop: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '12px', fontFamily: 'var(--font-plex-mono)',
      }}>
        Security Simulation
        {hp?.simulationSuccess && <span style={{ color: '#1e3a44', marginLeft: '6px' }}>· Simulation evidence</span>}
        
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
        {deduped.map(p => (
          <RiskPill key={p.label} label={p.label} value={{ ...p.style, label: p.displayLabel }} />
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function TerminalTokenScanner() {
  const { loading: planLoading } = usePlanWithLoading()
  const isFullAccess = true

  // SOLANA BETA, DISCLOSED (Token Scanner Solana Beta task): 'solana' is additive to the existing
  // four EVM chains — every existing branch that compares against 'base'/'eth'/'bnb'/'robinhood'
  // is unchanged and simply never matches 'solana', which is routed separately in handleScan.
  const [chain, setChain]       = useState<'base' | 'eth' | 'bnb' | 'robinhood' | 'solana'>('base')
  // Gated on the server's own feature flag + RPC config (via /api/token/chain-status) — the flag
  // and RPC URL are server-only and never shipped to the client.
  const [solanaAvailable, setSolanaAvailable] = useState(false)
  // Solana results are kept in their OWN state, never coerced into ScanResult — the EVM result
  // shape carries LP-lock/honeypot/tax/owner fields that have no honest Solana value, and forcing
  // them would be exactly the fake-parity this task forbids.
  const [solanaResult, setSolanaResult] = useState<SolanaBetaResult | null>(null)
  // DEEP MODE, DISCLOSED ("do Helius Enhanced" follow-up): tracks the explicit, user-triggered
  // deep creator check separately from the normal scan's loading state — this never fires from
  // handleScan itself, only from runSolanaDeepCreatorCheck below, on a button click.
  const [solanaDeepLoading, setSolanaDeepLoading] = useState(false)
  const [solanaDeepError, setSolanaDeepError] = useState<string | null>(null)
  const [solanaClusterLoading, setSolanaClusterLoading] = useState(false)
  const [solanaClusterError, setSolanaClusterError] = useState<string | null>(null)
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ScanResult | null>(null)
  const [error, setError]       = useState<string | null>(null)
  // CHAIN-STRICTNESS FIX, DISCLOSED: populated only from a backend-confirmed cross-chain candidate
  // on a blocked scan (see handleScan's wrong_chain branch) — the "Switch to X and scan" CTA this
  // powers below never fires a scan on its own; it only pre-fills the chain switch + rescan for the
  // user to click.
  const [crossChainSwitchCandidate, setCrossChainSwitchCandidate] = useState<{ chain: 'base' | 'eth' | 'bnb' | 'robinhood'; address: string } | null>(null)
  const [lpExpanded, setLpExpanded] = useState(true)
  const [activeSection, setActiveSection] = useState<'cortex-read'|'market-pulse'|'holder-map'|'lp-safety'|'risk-engine'|'deployer-intel'>('cortex-read')
  const [devControlTab, setDevControlTab] = useState<'dev-map'|'cluster-map'|'supply-control'|'history'|'watch-plan'>('dev-map')
  const [copiedHolderAddress, setCopiedHolderAddress] = useState<string | null>(null)
  // SEPARATE STATE ATOM FIX, DISCLOSED (audit: copySolanaAddress shared copiedHolderAddress with
  // copyHolderAddress, so copying a mint and a holder address in quick succession made one badge's
  // "Copied" state cancel the other's).
  const [copiedSolanaAddress, setCopiedSolanaAddress] = useState<string | null>(null)

  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkError, setClarkError]     = useState<string | null>(null)

  // Tracked tokens
  // WATCHLIST-ENDPOINT-MISMATCH FIX, DISCLOSED (live report: "fix the track this token it dosent
  // work" — the panel showed "Tracked tokens could not be loaded. Try again." on every load).
  // This page used to query `watchlist_tokens` directly from the browser via `contract_address`,
  // a column that only ever existed in docs/supabase-watchlist-tokens.sql's own migration — the
  // real /api/watchlist/tokens route (already used by Base Radar and /terminal/watchlist, and
  // already flagged by that route's own NORMALIZE-WATCHLIST-ROW disclosure as disagreeing with
  // this exact page) reads/writes `address`, not `contract_address`. Whichever column the live
  // table actually has, a direct client query using the wrong name is exactly what breaks both
  // the read (silently returns rows with no address field, or errors outright) and the write.
  // Switched to the same real endpoint (GET/POST/DELETE with a Bearer token) every other watchlist
  // entry point already uses, instead of a third, independent, differently-shaped write path.
  type TrackedToken = { id?: string; address: string; symbol?: string | null; name?: string | null; chain?: string | null; risk_label?: string | null; score?: number | null; saved_at?: string | null }
  const [trackedTokens, setTrackedTokens] = useState<TrackedToken[]>([])
  const [trackedLoading, setTrackedLoading] = useState(false)
  const [trackedSaving, setTrackedSaving]   = useState(false)
  const [trackedLoggedOut, setTrackedLoggedOut] = useState(false)
  const [trackedUnavailable, setTrackedUnavailable] = useState(false)
  const [trackedSaveError, setTrackedSaveError] = useState<string | null>(null)
  const [walletConnected, setWalletConnected] = useState(false)

  async function refreshTrackedTokens() {
    setTrackedLoading(true)
    setTrackedUnavailable(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const authToken = session?.access_token
      if (!authToken) {
        setTrackedTokens([])
        setTrackedLoggedOut(true)
        return
      }
      setTrackedLoggedOut(false)
      const res = await fetch('/api/watchlist/tokens', { headers: { Authorization: `Bearer ${authToken}` }, cache: 'no-store' })
      const json = await res.json().catch(() => null)
      if (res.status === 401) {
        setTrackedTokens([])
        setTrackedLoggedOut(true)
        return
      }
      if (!res.ok || !Array.isArray(json?.tokens)) {
        console.error('Failed to load tracked tokens', json?.error ?? res.status)
        setTrackedTokens([])
        setTrackedUnavailable(true)
        return
      }
      setTrackedTokens(json.tokens as TrackedToken[])
    } catch (loadError) {
      console.error('Failed to load tracked tokens', loadError)
      setTrackedTokens([])
      setTrackedUnavailable(true)
    } finally { setTrackedLoading(false) }
  }

  useEffect(() => {
    const detectWallet = () => {
      const eth = (window as Window & { ethereum?: { selectedAddress?: string | null } }).ethereum
      setWalletConnected(Boolean(eth?.selectedAddress))
    }
    detectWallet()
    void refreshTrackedTokens()
    const { data: authListener } = supabase.auth.onAuthStateChange(() => { void refreshTrackedTokens() })
    window.addEventListener('focus', detectWallet)
    return () => {
      authListener.subscription.unsubscribe()
      window.removeEventListener('focus', detectWallet)
    }
  }, [])

  // Persist a SAFE token summary (verdict/score/section statuses only — no provider names,
  // no raw provider payloads) so Clark can explain the current scan. Scan logic is untouched.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (!result?.contract) return
      const sectionStatus: Record<string, string> = {}
      const sec = result.sections
      if (sec) {
        for (const [k, v] of Object.entries(sec)) {
          const st = (v as { status?: string } | null)?.status
          if (st) sectionStatus[k] = st
        }
      }
      if (result.lpControl?.status) sectionStatus.lp = result.lpControl.status
      const topRisks: string[] = []
      if (result.honeypot?.isHoneypot === true) topRisks.push('Honeypot simulation flagged — selling may be blocked.')
      if ((result.honeypot?.sellTax ?? 0) >= 10) topRisks.push(`High sell tax (${result.honeypot?.sellTax}%).`)
      if ((result.honeypot?.buyTax ?? 0) >= 10) topRisks.push(`High buy tax (${result.honeypot?.buyTax}%).`)
      if (result.analysis?.has_mint === true) topRisks.push('Mint function present — supply can be inflated.')
      if ((result.holderDistribution?.top10 ?? 0) >= 70) topRisks.push(`Concentrated holders — top 10 hold ${result.holderDistribution?.top10}%.`)
      const summary = {
        chain: result.chain ?? 'base',
        address: result.contract,
        symbol: result.symbol ?? null,
        name: result.name ?? null,
        score: result.riskScore ?? null,
        verdict: getRiskLabelDisplay(result.riskLabel),
        scoreDirection: result.riskScoreDirection ?? 'higher_is_riskier',
        topRisks,
        sectionStatus: Object.keys(sectionStatus).length ? sectionStatus : null,
        ts: Date.now(),
      }
      localStorage.setItem('chainlens:clark:lastTokenSummary', JSON.stringify(summary))
    } catch { /* non-critical */ }
  }, [result])

  // CHAIN-ID SUPPORT, DISCLOSED (Track This Token save-failure diagnosis): mirrors
  // lib/server/watchlistValidation.ts's CHAIN_ID_BY_SLUG exactly — no secret/env value here, just
  // the same public numeric-chainId convention app/api/token/route.ts already uses. Sent so the
  // server can confirm (never silently override) the slug's own chainId, and so Robinhood (4663)
  // is unambiguous in the saved row and in watchlistSaveAudit.
  const WATCHLIST_CHAIN_ID_BY_SLUG: Record<string, number | null> = { base: 8453, eth: 1, bnb: 56, robinhood: 4663, solana: null }

  async function saveTrackedToken() {
    if (!result?.contract) return
    // SOLANA-CASE-SENSITIVE FIX, DISCLOSED: a Solana base58 mint address is case-sensitive, unlike
    // an EVM 0x address — unconditionally lowercasing it (the old behavior) silently corrupts it
    // into a different, non-existent address. Only ever lowercase the EVM shape.
    const normalizedContract = isValidSolanaMintAddress(result.contract as unknown) ? result.contract : result.contract.toLowerCase()
    const effectiveChain = (result.chain ?? chain) as string
    // DUPLICATE-SAVE GUARD FIX, DISCLOSED (audit: "Save to watchlist" inserted unconditionally with
    // no duplicate check and no "already tracked" state — repeat clicks on the same token created
    // repeat rows). Same identity rule as the chain-strict delete: address + chain together.
    const alreadyTracked = trackedTokens.some(t => t.address === normalizedContract && (t.chain ?? 'base') === effectiveChain)
    if (alreadyTracked) return

    // OPTIMISTIC-SAVE-WITH-ROLLBACK FIX, DISCLOSED (Track This Token save-failure diagnosis): the
    // sidebar/tracked-tokens list only ever updated after the full round-trip finished
    // (refreshTrackedTokens(), a second network call) — a real save felt like nothing happened
    // until both the write and a full reload completed. Insert the token into local state
    // immediately so the sidebar reflects it instantly; on any failure (including duplicate,
    // which isn't really a failure) reconcile against the real server response instead of leaving
    // a token in the sidebar the server never actually saved.
    const optimisticToken: TrackedToken = {
      address: normalizedContract,
      symbol: result.symbol ?? null,
      name: result.name ?? null,
      chain: effectiveChain,
      risk_label: getRiskLabelDisplay(result.riskLabel),
      score: result.riskScore ?? null,
      saved_at: new Date().toISOString(),
    }
    setTrackedTokens(prev => [optimisticToken, ...prev])
    setTrackedSaving(true)
    setTrackedSaveError(null)
    const rollback = () => setTrackedTokens(prev => prev.filter(t => !(t.address === normalizedContract && (t.chain ?? 'base') === effectiveChain && t.id == null)))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const authToken = session?.access_token
      if (!authToken) {
        rollback()
        setTrackedLoggedOut(true)
        setTrackedUnavailable(false)
        return
      }
      const res = await fetch('/api/watchlist/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          address: normalizedContract,
          symbol: result.symbol ?? null,
          name: result.name ?? null,
          // CHAIN-STORED WITH TOKEN (chain-strictness audit): the same 0x address on different
          // chains is a different token — the row must record which chain it was scanned on.
          chain: effectiveChain,
          chainId: WATCHLIST_CHAIN_ID_BY_SLUG[effectiveChain] ?? null,
          riskLabel: getRiskLabelDisplay(result.riskLabel),
          score: result.riskScore ?? null,
          scoreType: 'risk_score',
          scoreDirection: 'higher_is_riskier',
        }),
      })
      const json = await res.json().catch(() => null)
      if (res.status === 401) {
        rollback()
        setTrackedLoggedOut(true)
        return
      }
      // ALREADY-TRACKED-IS-NOT-AN-ERROR FIX, DISCLOSED: the server now resolves a repeat save as
      // a 200 with `duplicate: true` (a real row, not fabricated) instead of only ever a fresh
      // insert — show "Already in watchlist" and keep the token marked tracked, never the
      // generic save-failure copy for what is actually a success from the user's point of view.
      if (res.ok && json?.duplicate === true) {
        setTrackedSaveError(null)
        setTrackedLoggedOut(false)
        await refreshTrackedTokens()
        return
      }
      if (!res.ok) {
        rollback()
        console.error('Failed to save tracked token', json?.reason ?? json?.error ?? res.status)
        // SPECIFIC-REASON FIX, DISCLOSED: the server now returns a message specific to what
        // actually went wrong (sign-in required, invalid payload, a real db error, ...) via
        // lib/server/watchlistValidation.ts's WATCHLIST_SAVE_CLIENT_MESSAGE — show it instead of
        // a single hardcoded string for every failure mode. The hardcoded generic string is now
        // only the last-resort fallback for a response with no error message at all.
        setTrackedSaveError(json?.error ?? 'Could not save this token. Try again.')
        return
      }
      setTrackedLoggedOut(false)
      await refreshTrackedTokens()
    } catch (saveError) {
      rollback()
      console.error('Failed to save tracked token', saveError)
      setTrackedSaveError('Could not save this token. Try again.')
    } finally { setTrackedSaving(false) }
  }

  async function removeTrackedToken(address: string, rowChain?: string | null) {
    // SOLANA-CASE-SENSITIVE FIX, DISCLOSED: see saveTrackedToken above — never lowercase a Solana
    // base58 mint address.
    const normalizedAddress = isValidSolanaMintAddress(address as unknown) ? address : address.toLowerCase()
    // WRONG-CHAIN DELETE FIX, DISCLOSED (audit: this used the currently-selected chain pill instead
    // of the row's own chain — removing an ETH-saved token while Base was selected deleted nothing
    // from the DB, so it silently reappeared on next load, while the optimistic filter below also
    // ignored chain and could hide the wrong row if the same address was saved on two chains).
    const effectiveChain = rowChain ?? chain
    setTrackedTokens(prev => prev.filter(t => !(t.address === normalizedAddress && (t.chain ?? 'base') === effectiveChain)))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const authToken = session?.access_token
      if (!authToken) { setTrackedLoggedOut(true); return }
      const res = await fetch(`/api/watchlist/tokens?address=${encodeURIComponent(normalizedAddress)}&chain=${encodeURIComponent(effectiveChain as string)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        console.error('Failed to remove tracked token', json?.error ?? res.status)
        setTrackedUnavailable(true)
      }
    } catch (deleteError) {
      console.error('Failed to remove tracked token', deleteError)
      setTrackedUnavailable(true)
    }
  }
  const [devIntelLoading, setDevIntelLoading] = useState(false)
  const [devIntelError, setDevIntelError] = useState<string | null>(null)
  const [devIntel, setDevIntel] = useState<DevWalletIntel | null>(null)
  const devIntelCacheRef = useRef<Record<string, DevWalletIntel>>({})

  const [resolving, setResolving]               = useState(false)
  const [resolverResult, setResolverResult]     = useState<ResolverResult | null>(null)
  // RE-ENTRY GUARD FIX, DISCLOSED (audit: double-clicking Scan, or a click landing in the same
  // commit as an Enter keypress, fired two /api/token POSTs). `if (loading || resolving) return`
  // read `loading`/`resolving` from the render that created the handler closure — two events
  // handled in the same commit both see the pre-click `false` value and both pass the guard. A ref
  // is set synchronously at the very start of the handler, before any await, so a second call
  // arriving before the first has had a chance to re-render sees the guard flip immediately.
  const scanInFlightRef = useRef(false)
  // Clears whenever both loading flags actually settle back to false, regardless of which of
  // handleScan's several return paths got there — simpler and less error-prone than manually
  // resetting the ref at every one of that function's early-return points.
  useEffect(() => { if (!loading && !resolving) scanInFlightRef.current = false }, [loading, resolving])
  // STALE-RESPONSE RACE, DISCLOSED (audit flagged "no AbortController before setResult/setSolanaResult
  // — switching chain/token mid-scan could let a stale response overwrite newer state"): the
  // scanInFlightRef guard above already closes this window structurally — it's checked synchronously
  // at the very top of handleScan, before any await, so a second handleScan call of any kind (chain
  // pill, watchlist Scan, alternates picker, Enter key, URL auto-scan) made while one is in flight
  // returns immediately without firing a second fetch. Combined with the chain pills / alternates
  // buttons now being disabled while loading/resolving (see chain-seg-btn:disabled below) and the
  // token input already having `disabled={loading}`, there is no longer a live path to start a
  // second scan before the first settles, so no separate AbortController/request-id is needed.

  const isValidHolderAddress = (value: string | null | undefined) => typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)

  async function copyHolderAddress(address: string) {
    if (!isValidHolderAddress(address)) return
    try {
      if (typeof window === 'undefined') return
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(address)
      } else {
        const textArea = document.createElement('textarea')
        textArea.value = address
        textArea.setAttribute('readonly', '')
        textArea.style.position = 'fixed'
        textArea.style.opacity = '0'
        textArea.style.pointerEvents = 'none'
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand('copy')
        document.body.removeChild(textArea)
      }
      setCopiedHolderAddress(address)
      window.setTimeout(() => {
        setCopiedHolderAddress((current) => (current === address ? null : current))
      }, 1500)
    } catch {
      // Keep UI silent on clipboard errors.
    }
  }

  // SOLANA BETA AVAILABILITY, DISCLOSED: one cheap boolean read on mount. Makes no provider call —
  // /api/token/chain-status only reports whether the server-side flag and RPC URL are present, so
  // the selector can hide Solana Beta entirely when it isn't configured.
  useEffect(() => {
    let cancelled = false
    fetch('/api/token/chain-status')
      .then(r => r.ok ? r.json() : null)
      .then((j: { solana?: { available?: boolean } } | null) => {
        if (!cancelled && j?.solana?.available === true) setSolanaAvailable(true)
      })
      .catch(() => { /* selector simply stays hidden — never a blocking failure */ })
    return () => { cancelled = true }
  }, [])

  // Auto-scan when opened from Base Radar with ?contract= param
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params      = new URLSearchParams(window.location.search)
    const contract    = params.get('contract')
    const chainParam  = params.get('chain')
    // CHAIN-PARAM-COVERAGE FIX, DISCLOSED (found via a real Base Radar report: "Scan Token"/watchlist
    // reopen for a Robinhood-chain token silently scanned it as Base instead — this URL-autodetect
    // only ever recognized `chain=eth`, defaulting every other value, including 'bnb'/'robinhood', to
    // 'base', even though this page's own chain selector and handleScan already fully support all
    // four chains via the `chain` state below). Widened to accept any of the four real supported
    // values instead of a single hardcoded special case.
    // SOLANA-DEEPLINK FIX, DISCLOSED (audit: autoChain only ever recognized the four EVM chains, so
    // a `?chain=solana&contract=<mint>` deeplink silently fell through to Base and did nothing —
    // the mint isn't a 0x address, so it also failed the contract regex below and never scanned).
    if (chainParam === 'solana' && contract && isValidSolanaMintAddress(contract)) {
      setChain('solana')
      handleScan(contract, 'solana')
      return
    }
    const autoChain: 'base' | 'eth' | 'bnb' | 'robinhood' = chainParam === 'eth' || chainParam === 'bnb' || chainParam === 'robinhood' ? chainParam : 'base'
    if (autoChain !== 'base') setChain(autoChain)
    if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
      handleScan(contract, autoChain)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleScan(override?: string, chainOverride?: 'base' | 'eth' | 'bnb' | 'robinhood' | 'solana') {
    const q             = (override ?? input).trim()
    const effectiveChain = chainOverride ?? chain
    if (!q) {
      setError('Please enter a token address or ticker before scanning.')
      return
    }
    if (loading || resolving || scanInFlightRef.current) return
    scanInFlightRef.current = true

    // ── Stale-state reset — runs on every new scan regardless of path ────────
    setResolverResult(null)
    setResult(null)
    setError(null)
    setCrossChainSwitchCandidate(null)
    setDevIntel(null)
    setDevIntelError(null)
    devIntelCacheRef.current = {}  // clear cached devIntel so no stale data bleeds across scans
    // STALE-SOLANA-STATE FIX, DISCLOSED (audit): this reset cleared the EVM result fields but left
    // solanaResult/solanaDeepError/solanaClusterError untouched — a Deep Creator/Cluster error from
    // a previous Solana scan survived into the next one and rendered under the new token.
    setSolanaResult(null)
    setSolanaDeepError(null)
    setSolanaClusterError(null)
    // ────────────────────────────────────────────────────────────────────────

    // ── SOLANA BETA PATH, DISCLOSED (Token Scanner Solana Beta task) ─────────
    // Returns before the ticker resolver and before any EVM scan wiring below. Validation is the
    // same shared implementation the API enforces (lib/solanaAddress.ts), so an EVM 0x address is
    // rejected here with a specific message rather than being sent to a Solana RPC.
    if (effectiveChain === 'solana') {
      const rejection = classifySolanaMintInput(q)
      if (rejection) { setError(SOLANA_MINT_REJECTION_MESSAGE[rejection]); return }
      setLoading(true)
      try {
        const res = await fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contract: q, chain: 'solana' }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok || !json || 'status' in (json ?? {})) {
          setError(typeof json?.error === 'string' ? json.error : 'Solana scan failed. Try again shortly.')
          setSolanaResult(null)
        } else {
          setSolanaResult(json as SolanaBetaResult)
        }
      } catch {
        setError('Solana scan failed. Try again shortly.')
        setSolanaResult(null)
      } finally { setLoading(false) }
      return
    }
    // ────────────────────────────────────────────────────────────────────────

    // ── Ticker resolver ─────────────────────────────────────────────────────
    // Skip if: CA provided directly, or override from URL auto-scan / alternate picker
    let scanContract = q
    let scanChain: 'base' | 'eth' | 'bnb' | 'robinhood' = effectiveChain
    // CHAIN-STRICT INPUT GUARD (chain-correctness audit): a well-formed Solana mint pasted while
    // an EVM chain is selected is rejected client-side with the switch-chain message — it must
    // never silently resolve-fail or reach the EVM scanner.
    {
      const looksSolanaMint = q.trim().length >= 32 && q.trim().length <= 44 && !isContractAddress(q) && /^[1-9A-HJ-NP-Za-km-z]+$/.test(q.trim())
      if (looksSolanaMint && isValidSolanaMintAddress(q)) {
        setError(`That looks like a Solana mint address. This token was not found on ${chainDisplayName(scanChain)}. Switch chain or scan with Auto Detect.`)
        return
      }
    }
    if (!override && !isContractAddress(q)) {
      // Ticker/name search (resolveTokenQuery) only covers base/eth today — BNB and Robinhood
      // Chain scans require a pasted contract address for now rather than silently searching the
      // wrong chain for a matching symbol.
      if (effectiveChain === 'bnb' || effectiveChain === 'robinhood') {
        setError(`Ticker search isn't available for ${effectiveChain === 'bnb' ? 'BNB Chain' : 'Robinhood Chain'} yet — paste the contract address instead.`)
        return
      }
      setResolving(true)
      try {
        const resolved = await resolveTokenQuery(q, effectiveChain)
        setResolverResult(resolved)
        setResolving(false)
        if (resolved.status === 'not_found' || !resolved.contractAddress) {
          setError(resolved.reason || 'No matching token found. Try pasting the contract address.')
          return
        }
        scanContract = resolved.contractAddress
        scanChain    = resolved.chain === 'eth' ? 'eth' : 'base'
      } catch {
        setResolving(false)
        setError("Couldn't resolve that ticker. Try pasting the contract address.")
        return
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    if (process.env.NODE_ENV !== 'production') {
      console.log('[scanner] scan start', {
        originalInput: q,
        resolvedAddress: scanContract,
        resolvedChain: scanChain,
        isCA: isContractAddress(q),
        hasOverride: !!override,
      })
    }

    setLoading(true)
    setClarkLoading(true)
    setLpExpanded(true)
    setActiveSection('cortex-read')
    setDevControlTab('dev-map')
    setClarkVerdict(null)
    setClarkError(null)
    try {
      const debugHolder = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('debugHolder') === 'true'
      const { data: _sd } = await supabase.auth.getSession()
      const _tok = _sd.session?.access_token
      const res  = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_tok ? { Authorization: `Bearer ${_tok}` } : {}) },
        body: JSON.stringify({ contract: scanContract, chain: scanChain, ...(debugHolder ? { debugHolder: true } : {}) }),
      })
      // NON-JSON-RESPONSE FIX, DISCLOSED (audit: a gateway/proxy error page for a server-side
      // failure produced the misleading generic "Network error — check your connection" message,
      // because an unguarded res.json() throws on non-JSON and that error is caught by the outer
      // catch block, which can't distinguish it from an actual network failure). ...
      const json = await res.json().catch(() => null)
      if (!json) {
        setError('Server returned an unexpected response. Try again shortly.')
        setClarkLoading(false)
        return
      }
      if (process.env.NODE_ENV !== 'production') {
        console.log('[scanner] /api/token response', {
          scanRequestAddress: scanContract,
          scanRequestChain: scanChain,
          returnedContract: json.contract,
          hasDevIntel: !!json.devIntel,
          deployerAddress: (json.devIntel as Record<string, unknown> | undefined)?.deployerAddress ?? null,
        })
      }
      if (!res.ok || json.error) {
        const isAddrInput = isContractAddress(scanContract)
        if (json?.status === 'invalid_address') setError(json.error ?? 'Invalid contract address.')
        else if (json?.status === 'address_scan_failed') setError(json.error ?? "Token address accepted, but CORTEX could not find enough live data yet.")
        else if (json?.status === 'wrong_chain' || json?.status === 'chain_mismatch') {
          // CHAIN-STRICTNESS FIX, DISCLOSED: the backend now runs a real on-chain existence check
          // (see app/api/token/route.ts's tokenScannerChainStrictnessAudit) and returns the exact
          // required copy plus which chain the contract actually exists on, if any — used here
          // verbatim instead of the old generic "switch chain or Auto Detect" message. The optional
          // "Switch to X and scan" CTA below only ever appears from this candidate; it is never
          // auto-applied.
          setError(json.error ?? `This token was not found on ${chainDisplayName(scanChain)}. Switch chain or scan with Auto Detect.`)
          setCrossChainSwitchCandidate(
            json?.crossChainCandidateFound && json?.crossChainCandidateChain
              ? { chain: json.crossChainCandidateChain as 'base' | 'eth' | 'bnb' | 'robinhood', address: scanContract }
              : null
          )
        }
        else if (json?.status === 'ambiguous') setError('Multiple tokens match this. Paste the contract address or choose one.')
        else if (json?.status === 'no_pool_found' || json?.marketStatus === 'no_pool_found') setError(`No active liquidity pools found on ${chainDisplayName(scanChain)} for this token.`)
        else if (isAddrInput) setError("Token address accepted, but CORTEX could not find enough live data yet.")
        else setError("Couldn't resolve that token. Paste the contract address or try a verified symbol.")
        if (process.env.NODE_ENV !== 'production') {
          console.log('[scanner] resolver diagnostics', {
            originalInput: q,
            selectedChain: effectiveChain,
            detectedInputType: isAddrInput ? 'address' : 'symbol_or_alias',
            addressValid: isAddrInput,
            resolverStageFailed: json?._diagnostics?.resolverStageFailed ?? json?.status ?? 'unknown',
            resolverFailureReason: json?._diagnostics?.resolverFailureReason ?? json?.error ?? null,
            fallbackAttempted: json?._diagnostics?.fallbackAttempted ?? false,
          })
        }
        setClarkLoading(false)
      } else {
        const pairs: Array<Record<string, unknown>> = Array.isArray(json.pairs) ? json.pairs : []
        const mainPool = pairs[0] ?? null
        const attr = (p: Record<string, unknown> | null) => ((p?.attributes as Record<string, unknown> | undefined) ?? {})
        const num = (v: unknown) => { const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN; return Number.isFinite(n) && n !== 0 ? n : null }
        const mapped: ScanResult = {
          name:           json.name,
          symbol:         json.symbol,
          decimals:       typeof json.decimals === 'number' ? json.decimals : (json.tokenInfo?.decimals ?? 18),
          contract:       json.contract,
          chain:          json.chain ?? 'base',
          noActivePools:    json.noActivePools ?? false,
          primaryDexName:   json.primaryDexName ?? null,
          marketDataSource: json.marketDataSource ?? 'none',
          marketConfidence: json.marketConfidence ?? 'low',
          priceSource: json.priceSource ?? null,
          // Use effective values from server (include fallback market read when primary has no pool)
          price:          num(json.priceUsd) ?? (mainPool ? num(attr(mainPool).base_token_price_usd) : null),
          liquidity:      num(json.liquidityUsd) ?? (mainPool ? num(attr(mainPool).reserve_in_usd) : null),
          volume24h:      num(json.volume24hUsd) ?? (mainPool ? num((attr(mainPool).volume_usd as Record<string, unknown> | undefined)?.h24) : null),
          priceChange24h: num(json.sections?.market?.change24h) ?? (mainPool ? num((attr(mainPool).price_change_percentage as Record<string, unknown> | undefined)?.h24) : null),
          marketCap: num(json.marketCapUsd),
          marketCapUsd: num(json.marketCapUsd),
          marketCapStatus: json.marketCapStatus ?? 'unavailable',
          valuationContext: json.valuationContext ?? null,
          circulatingSupply: num(json.circulating_supply),
          fdv: num(json.fdvUsd ?? json.fdv),
          fdvUsd: num(json.fdvUsd ?? json.fdv),
          marketCapSource: json.marketCapSource ?? 'unavailable',
          fdvSource: json.fdvSource ?? 'unavailable',
          displayMarketValue: json.displayMarketValue ?? null,
          displayMarketValueLabel: json.displayMarketValueLabel ?? 'Market Cap',
          displayMarketValueConfidence: json.displayMarketValueConfidence ?? 'low',
          displayMarketValueReason: json.displayMarketValueReason ?? '',
          estimatedMarketCap: json.estimatedMarketCap ?? null,
          pools: pairs.map((p: Record<string, unknown>) => ({
            name:           (attr(p).name as string | undefined),
            address:        (attr(p).address as string | undefined),
            price:          num(attr(p).base_token_price_usd),
            liquidity:      num(attr(p).reserve_in_usd),
            volume24h:      num((attr(p).volume_usd as Record<string, unknown> | undefined)?.h24),
            priceChange24h: num((attr(p).price_change_percentage as Record<string, unknown> | undefined)?.h24),
            dex:            ((p.dex as string | undefined) ?? (attr(p).dex as string | undefined) ?? (attr(p).dex_name as string | undefined) ?? null),
            model:          ((p.model as string | undefined) ?? (attr(p).model as string | undefined) ?? null),
          })),
          selectedPool: json.selectedPool ?? null,
          contractSecurity: json.contractSecurity ?? null,
          honeypot: json.honeypot ?? null,
          holderDistribution: json.holderDistribution ?? null,
          holderDistributionStatus: json.holderDistributionStatus ?? null,
          debugHolderStatus: json.debugHolderStatus ?? null,
          sections: json.sections ?? null,
          lpControl: json.lpControl ?? null,
          lpControlRead: json.lpControlRead ?? null,
          lpLockStatus: json.lpLockStatus ?? undefined,
          lpLockAmount: json.lpLockAmount ?? null,
          lpUnlockTime: json.lpUnlockTime ?? null,
          lpLockProvider: json.lpLockProvider ?? null,
          lpController: json.lpController ?? undefined,
          lpControllerType: json.lpControllerType ?? undefined,
          lpProofApplicability: json.lpProofApplicability ?? undefined,
          lpProofStatus: json.lpProofStatus ?? undefined,
          lpExitRisk: json.lpExitRisk ?? undefined,
          lpExitRiskReason: json.lpExitRiskReason ?? undefined,
          liquidityDepthRisk: json.liquidityDepthRisk ?? undefined,
          lpEvidenceSummary: json.lpEvidenceSummary ?? undefined,
          lpEvidenceGaps: json.lpEvidenceGaps ?? undefined,
          lpDataMode: json.lpDataMode ?? undefined,
          lpDataModeRaw: json.lpDataModeRaw ?? undefined,
          lpDataConfidence: json.lpDataConfidence ?? undefined,
          lpModelProof: json.lpModelProof ?? null,
          lpMigrationProof: json.lpMigrationProof ?? null,
          cortexLpRead: json.cortexLpRead ?? null,
          lpMeta: json.lpMeta ?? null,
          concentratedPositionProof: json.concentratedPositionProof ?? null,
          concentratedPositionProofRead: json.concentratedPositionProofRead ?? null,
          poolActivity: json.poolActivity ?? null,
          priceChart: json.priceChart ?? null,
          chartStatus: json.chartStatus ?? null,
          chartSource: json.chartSource ?? null,
          chartReason: json.chartReason ?? null,
          chartDataSource: json.chartDataSource ?? null,
          marketTrendSnapshot: json.marketTrendSnapshot ?? null,
          resolvedInput: json.resolvedInput ?? null,
          riskEngine: json.riskEngine ?? null,
          rugRisk: json.rugRisk ?? null,
          contractFlags: json.contractFlags ?? null,
          devIntel: json.devIntel ?? null,
          security: json.security ?? null,
          projectSocials: json.projectSocials ?? null,
          cortexScore: json.cortexScore ?? null,
          cortexVerdict: json.cortexVerdict ?? undefined,
          riskScore: typeof json.riskScore === 'number' ? json.riskScore : undefined,
          safetyScore: typeof json.safetyScore === 'number' ? json.safetyScore : undefined,
          riskScoreType: json.riskScoreType === 'safety_score' ? 'safety_score' : 'risk_score',
          riskScoreDirection: json.riskScoreDirection ?? undefined,
          riskScoreDirectionAudit: json.riskScoreDirectionAudit ?? undefined,
          riskLabel: json.riskLabel ?? undefined,
          riskBreakdown: json.riskBreakdown ?? undefined,
          planGate: json.planGate ?? null,
          scanAudit: json.scanAudit ?? null,
        }
        setResult(mapped)
        if (json.devIntel) {
          const tokenDevIntel = json.devIntel as DevWalletIntel
          setDevIntel(tokenDevIntel)
          const devCacheChain = (mapped.chain === 'eth' ? 'eth' : (mapped.chain === 'base' ? 'base' : scanChain))
          if (mapped.contract) devIntelCacheRef.current[`${devCacheChain}:${mapped.contract.toLowerCase()}`] = tokenDevIntel
        }
        if (typeof window !== 'undefined' && json._debug) {
          (window as unknown as Record<string, unknown>).__CL_DEBUG__ = json._debug
        }
        if (json.aiSummary) {
          setClarkVerdict(json.aiSummary)
        } else {
          setClarkError('No AI verdict returned.')
        }
        setClarkLoading(false)
      }
    } catch {
      setError('Network error — check your connection.')
      setClarkLoading(false)
    } finally {
      setLoading(false)
    }
  }

  // DEEP MODE, DISCLOSED ("do Helius Enhanced" follow-up): called ONLY from the Dev tab's "Run
  // Deep Creator Check" button — never from handleScan. Re-runs the full Solana scan with
  // deepDev:true, the ONLY way deepCreator ever gets populated; a normal scan never sets that
  // flag (see app/api/token/route.ts's own gating and lib/server/solana/deepCreatorAnalyzer.ts).
  async function runSolanaDeepCreatorCheck() {
    if (!solanaResult || solanaDeepLoading) return
    setSolanaDeepLoading(true)
    setSolanaDeepError(null)
    try {
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract: solanaResult.mintAddress, chain: 'solana', deepDev: true }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json || 'status' in (json ?? {})) {
        setSolanaDeepError(typeof json?.error === 'string' ? json.error : 'Deep creator check failed. Try again shortly.')
      } else {
        setSolanaResult(json as SolanaBetaResult)
      }
    } catch {
      setSolanaDeepError('Deep creator check failed. Try again shortly.')
    } finally { setSolanaDeepLoading(false) }
  }

  // DEEP CLUSTER MODE, DISCLOSED: called ONLY from the Cluster Map tab's "Run Deep Cluster Check"
  // button — traces one funding hop past the likely creator wallet. See
  // lib/server/solana/clusterAnalyzer.ts for exactly what relationship types this does and does
  // not verify.
  async function runSolanaDeepClusterCheck() {
    if (!solanaResult || solanaClusterLoading) return
    setSolanaClusterLoading(true)
    setSolanaClusterError(null)
    try {
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract: solanaResult.mintAddress, chain: 'solana', deepCluster: true }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json || 'status' in (json ?? {})) {
        setSolanaClusterError(typeof json?.error === 'string' ? json.error : 'Deep cluster check failed. Try again shortly.')
      } else {
        setSolanaResult(json as SolanaBetaResult)
      }
    } catch {
      setSolanaClusterError('Deep cluster check failed. Try again shortly.')
    } finally { setSolanaClusterLoading(false) }
  }

  useEffect(() => {
    if (activeSection !== 'deployer-intel') return
    const contract = result?.contract
    if (!contract) return
    const chainKey = (result?.chain === 'eth' ? 'eth' : (result?.chain === 'base' ? 'base' : chain))
    const cacheKey = `${chainKey}:${contract.toLowerCase()}`
    const cached = devIntelCacheRef.current[cacheKey]
    if (cached) {
      setDevIntel(cached)
      setDevIntelError(null)
      return
    }
    let aborted = false
    const run = async () => {
      setDevIntelLoading(true)
      setDevIntelError(null)
      try {
        const res = await fetch(`/api/dev-wallet?address=${encodeURIComponent(contract)}&chain=${encodeURIComponent(chainKey)}`)
        // NON-JSON-RESPONSE FIX, DISCLOSED (audit, same class of bug as the /api/token handler):
        // an unguarded res.json() threw on a non-JSON response and was caught by the outer catch,
        // masking a real server-side failure behind the generic partial-data message.
        const json = await res.json().catch(() => null)
        if (aborted) return
        if (res.status === 429) {
          setDevIntelError('Dev intelligence cooldown active. Showing scanner-derived signals.')
          return
        }
        if (!res.ok || !json || json?.error) {
          setDevIntelError('Dev intelligence temporarily partial. Showing scanner-derived signals.')
          return
        }
        devIntelCacheRef.current[cacheKey] = json as DevWalletIntel
        setDevIntel(json as DevWalletIntel)
      } catch {
        if (!aborted) setDevIntelError('Dev intelligence temporarily partial. Showing scanner-derived signals.')
      } finally {
        if (!aborted) setDevIntelLoading(false)
      }
    }
    run()
    return () => { aborted = true }
  }, [activeSection, result?.contract, result?.chain, chain])

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes clarkDot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.75); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes liveDotPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(.65)} }
        @keyframes radarRing { 0%{transform:scale(.4);opacity:.65} 100%{transform:scale(1.85);opacity:0} }
        @keyframes shimmer { 0%{background-position:-300% 0} 100%{background-position:300% 0} }
        .cortex-score-hero{box-shadow:0 0 60px rgba(45,212,191,.09),0 0 24px rgba(45,212,191,.05);}
        .cortex-chip{transition:transform .18s ease,box-shadow .18s ease;cursor:default;}
        .cortex-chip:hover{transform:translateY(-2px);}
        .cortex-bdrow{border-radius:6px;transition:background .14s ease;}
        .cortex-bdrow:hover{background:rgba(255,255,255,.028) !important;}
        .token-shell{position:relative;display:grid;grid-template-columns:minmax(0,1fr);min-height:100vh;align-items:start;overflow-x:hidden;color:#e2e8f0;background-image:linear-gradient(rgba(45,212,191,.020) 1px,transparent 1px),linear-gradient(90deg,rgba(45,212,191,.020) 1px,transparent 1px),radial-gradient(circle at 18% 4%,rgba(34,211,238,.10),transparent 38%),radial-gradient(circle at 86% 92%,rgba(217,70,239,.09),transparent 42%),radial-gradient(circle at 88% 14%,rgba(139,92,246,.08),transparent 36%),radial-gradient(circle at 22% 0%,rgba(20,35,68,.52),rgba(2,6,23,1) 56%);background-size:52px 52px,52px 52px,100% 100%,100% 100%,100% 100%,100% 100%;background-color:rgba(2,6,23,1);background-attachment:fixed,fixed,fixed,fixed,fixed,fixed;}
        @media (max-width:1279px){.token-shell{background-attachment:scroll !important;}}
        .token-main,.mob-verdict-panel,.glass-card,.metric-grid,.holders-grid,.activity-grid,.intel-grid{min-width:0;}
        .token-main{max-width:none;}
        .glass-card{background:linear-gradient(180deg,rgba(10,18,34,.9),rgba(3,8,19,.88));border:1px solid rgba(148,163,184,.18);border-radius:16px;box-shadow:0 0 0 1px rgba(45,212,191,.05) inset,0 18px 45px rgba(2,6,23,.4),0 0 28px rgba(139,92,246,.12);}
        /* PREMIUM POLISH, DISCLOSED (Token Scanner UI polish task): the old search-card stacked
           five box-shadow layers (up to 140px blur) — replaced with a calmer, static two-layer
           shadow so the card reads as the terminal's primary command module, not a glow bloom. */
        /* CARD-SEPARATION, DISCLOSED (Token Scanner visual-contrast task, reported: "the scan card
           blends into the background" — the page shell sits on near-black rgba(2,6,23,1); the card
           was nearly the same navy-black, so its own border was the only thing separating it. Base
           lightened a full step (rgba(9,16,32)->rgba(15,24,44) at the lightest point) and the border
           strengthened + given a faint cyan tint so the card reads as its own surface at a glance,
           plus a tiny ambient cyan/violet glow just outside the border (very low alpha, static, no
           bloom) for depth without flashiness. */
        .search-card{background:linear-gradient(160deg,rgba(15,24,44,.98) 0%,rgba(7,13,28,.97) 100%);border:1px solid rgba(148,180,200,.27);border-radius:16px;box-shadow:0 16px 40px rgba(2,6,23,.60),0 0 0 1px rgba(45,212,191,.06),0 0 46px rgba(139,92,246,.06),inset 0 1px 0 rgba(255,255,255,.05),inset 0 0 40px rgba(2,6,23,.30);}
        .chain-seg{display:inline-flex;padding:3px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);gap:2px;}
        .chain-seg-btn{padding:6px 15px;border-radius:7px;font-size:10.5px;font-weight:700;letter-spacing:.10em;font-family:var(--font-plex-mono);cursor:pointer;transition:background .15s,color .15s,box-shadow .15s;border:none;background:transparent;color:#63798e;}
        .chain-seg-btn:hover:not([class*="chain-seg-btn--active"]){color:#9fb2c4;}
        /* LOADING-AFFORDANCE FIX, DISCLOSED (audit: chain pills stayed fully clickable during a
           scan and silently no-opped via the re-entry guard, giving zero feedback that the click
           did nothing). */
        .chain-seg-btn:disabled{cursor:not-allowed;opacity:.45;}
        /* Per-chain active color, DISCLOSED (Token Scanner final polish task): BASE keeps the
           brand teal already used for its header pill/dot elsewhere on this page; ETHEREUM keeps
           the indigo already used for its pill — same setChain() behavior, just a sharper, more
           branded "selected" state than one generic indigo for both. Base's active contrast raised
           (explicitly requested, "active Base tab should have stronger contrast") since it's the
           default/most-used chain. */
        .chain-seg-btn--active-base{background:rgba(34,211,238,.22);color:#e7feff;box-shadow:inset 0 0 0 1px rgba(34,211,238,.55);}
        .chain-seg-btn--active-eth{background:rgba(99,102,241,.20);color:#c7d2fe;box-shadow:inset 0 0 0 1px rgba(99,102,241,.35);}
        .chain-seg-btn--active-bnb{background:rgba(240,185,11,.18);color:#fde68a;box-shadow:inset 0 0 0 1px rgba(240,185,11,.40);}
        .chain-seg-btn--active-robinhood{background:rgba(52,211,153,.18);color:#a7f3d0;box-shadow:inset 0 0 0 1px rgba(52,211,153,.40);}
        .chain-seg-btn--active-solana{background:rgba(153,69,255,.20);color:#ddd0ff;box-shadow:inset 0 0 0 1px rgba(153,69,255,.42);}
        .cmd-chip{padding:6px 13px;border-radius:8px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.10);color:#5b7186;font-size:10.5px;font-weight:600;font-family:var(--font-plex-mono);letter-spacing:.03em;cursor:pointer;transition:background .14s,border-color .14s,color .14s;display:inline-flex;align-items:center;gap:5px;}
        .cmd-chip:hover{color:#a5b4fc;border-color:rgba(99,102,241,.35);background:rgba(99,102,241,.06);}
        .cmd-chip-glyph{color:#334155;font-size:10px;}
        /* Thinner, fading top accent per module card — DISCLOSED (explicitly requested: "card top
           accent line should be thinner and cleaner"): full-bleed solid bar replaced with a
           gradient that fades at both edges, same static (no animation) treatment. Background
           lightened one step (same reasoning as .search-card above) so these cards separate from
           the page background instead of blending in. */
        .preview-module-card{background:linear-gradient(160deg,rgba(15,25,43,.82),rgba(8,15,29,.78));border:1px solid rgba(255,255,255,.13);border-radius:12px;padding:22px 17px;transition:transform .18s ease,border-color .18s ease;cursor:default;}
        .preview-module-card:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.22);}
        /* AFTER-SCAN-CARDS, DISCLOSED (Token Scanner final-polish task, explicitly requested: "the
           plain full-width rows read as filler" — redesigned into a compact 3-card strip, same
           visual language/restraint as .preview-module-card above (subtle dark fill, static border,
           small dot instead of a numbered accent bar, no glow bloom) so the two sections read as one
           system. Static hover lift only, no color animation. */
        .after-scan-card{position:relative;background:rgba(10,18,32,.62);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:16px;transition:transform .18s ease,border-color .18s ease;cursor:default;}
        .after-scan-card:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.17);}
        .after-scan-dot{display:inline-block;width:6px;height:6px;border-radius:50%;}
        .token-scan-input::placeholder{color:rgba(148,163,184,0.58);}
        .scan-helper-row{flex-wrap:wrap;}
        @media (max-width:640px){.scan-helper-row{flex-direction:column;align-items:flex-start;gap:8px;}}
        .shimmer-line{background:linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.10) 50%,rgba(255,255,255,.04) 75%);background-size:300% 100%;border-radius:3px;animation:shimmer 2.6s ease-in-out infinite;}
        /* SCAN-BUTTON, DISCLOSED (Token Scanner active-state polish task — literal spec values this
           round: border rgba(83,243,195,.65) at rest, brighter on hover; verified via a Playwright
           screenshot of both states side-by-side before/after this change, not guessed blind). Two
           explicit classes — .scan-btn-live (input has text, not loading/resolving) and .scan-btn-off
           (disabled) — same height/padding/radius/typography both states so layout never shifts on
           enable. Active: bright white text, visible teal border, dark teal-tinted fill (not flat
           near-black or grey), soft permanent glow, brighter glow + border on hover, slight press on
           :active. Disabled: dim flat fill, faded border/text, no glow, not-allowed cursor. No
           purple gradient either state. */
        .scan-btn-live,.scan-btn-off{display:inline-flex;align-items:center;gap:8px;height:62px;padding:0 28px;border-radius:13px;font-size:12px;font-weight:800;font-family:var(--font-plex-mono);letter-spacing:.12em;flex-shrink:0;white-space:nowrap;}
        .scan-btn-live{cursor:pointer;color:#ffffff;border:1px solid rgba(83,243,195,.65);background:linear-gradient(180deg,rgba(20,70,72,.82),rgba(9,38,42,.90));box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 20px rgba(83,243,195,.20);transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease,background .15s ease;}
        .scan-btn-live:hover{transform:translateY(-1px);border-color:rgba(120,255,220,.95) !important;background:linear-gradient(180deg,rgba(26,90,92,.88),rgba(12,48,52,.92)) !important;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 0 30px rgba(83,243,195,.34) !important;}
        .scan-btn-live:focus-visible{border-color:rgba(120,255,220,.95) !important;box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 0 0 3px rgba(83,243,195,.22) !important;}
        .scan-btn-live:active{transform:translateY(1px) scale(.99) !important;}
        .scan-btn-off{cursor:not-allowed;color:rgba(148,163,184,.38);border:1px solid rgba(148,163,184,.14);background:rgba(11,17,28,.50);}
        .live-dot{animation:liveDotPulse 2.2s ease-in-out infinite;}
        .clark-section{border-top:1px solid rgba(255,255,255,.04);padding-top:12px;margin-bottom:12px;}
        .result-tabs-scroll{scrollbar-width:none;-ms-overflow-style:none;}
        .detail-summary::-webkit-details-marker{display:none;}
        .detail-chevron{transition:transform 0.15s ease;}
        details[open] > .detail-summary .detail-chevron{transform:rotate(90deg);}
        .result-tabs-scroll::-webkit-scrollbar{display:none;}
        .result-tab-btn:focus-visible{outline:2px solid rgba(83,243,195,0.55);outline-offset:2px;}
        @media (prefers-reduced-motion:reduce){.live-dot,.radar-ring,.shimmer-line,.scan-btn-live,.cortex-score-hero{animation:none !important;} .scan-btn-live:hover,.cortex-chip:hover{transform:none !important;} .cortex-bdrow:hover{background:none !important;}}
        .metric-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr)) !important;gap:clamp(8px,1vw,12px) !important;}
        .activity-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;}
        @media (min-width:1536px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(360px,22vw,420px);column-gap:28px;} .token-main{max-width:1180px;margin:0 auto;} .token-shell .mob-verdict-panel{width:auto !important;max-width:420px !important;}}
        @media (min-width:1280px) and (max-width:1535px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(300px,24vw,360px);column-gap:24px;} .token-main{max-width:1120px;margin:0 auto;} .token-shell .mob-verdict-panel{width:auto !important;max-width:360px !important;padding:24px 16px !important;font-size:12px;} .activity-grid{gap:8px;}}
        @media (max-width:1279px){.token-shell{display:block;height:auto;overflow:visible;} .mob-scan-main{overflow-y:visible !important;} .token-shell .mob-verdict-panel{position:static !important;width:100% !important;max-width:100% !important;height:auto !important;min-height:0 !important;border-left:none !important;border-top:1px solid rgba(255,255,255,0.08) !important;overflow-y:visible !important;} .result-tabs-wrap{position:static !important;background:none !important;backdrop-filter:none !important;}}
        @media (max-width:1023px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;} .holders-grid,.intel-grid{grid-template-columns:1fr !important;} .activity-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;}}
        @media (max-width:768px){.token-main{padding:36px 14px 120px !important;} .token-input-row{flex-direction:column;max-width:100% !important;} .token-input-row button{width:100%;} .top-holder-head{display:none !important;} .top-holder-row{display:block !important;padding:12px !important;} .top-holder-mobile-meta{display:flex !important;align-items:center;justify-content:space-between;gap:8px;} .top-holder-mobile-amt{display:block !important;margin-top:6px !important;text-align:left !important;} .pools-scroll{overflow-x:auto !important;-webkit-overflow-scrolling:touch;margin:0 -12px;padding:0 12px;} .mob-verdict-panel{padding:18px 14px !important;gap:12px !important;} .glass-card{padding:14px !important;} .preview-module-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;} .after-scan-grid{grid-template-columns:1fr !important;}}
      `}</style>

      <div className="token-shell" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable scan area ──────────────────────────── */}
        <div className="mob-scan-main token-main" style={{ minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '44px clamp(16px, 2.2vw, 34px) 120px', width: '100%' }}>

          {/* ── Hero area ─────────────────────────────────────────── */}
          <div style={{ marginBottom: '22px', maxWidth: '820px' }}>

            {/* Badge row */}
            <div style={{ marginBottom: '14px' }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '7px',
                background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.26)',
                borderRadius: '99px', padding: '5px 14px',
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.15em',
                color: '#a78bfa', fontFamily: 'var(--font-plex-mono)',
              }}>
                <span className="live-dot" style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,.8)', flexShrink: 0 }} />
                TOKEN SCANNER
              </div>
            </div>

            {/* Heading */}
            <h1 style={{ fontSize: 'clamp(26px,3.6vw,38px)', fontWeight: 800, color: '#f1f5f9', lineHeight: 1.12, margin: '0 0 10px', letterSpacing: '-0.02em' }}>
              Token Scanner
            </h1>
            <p style={{ margin: '0 0 16px', color: '#64748b', fontSize: '13px', lineHeight: 1.65, maxWidth: '560px' }}>
              Scan Base tokens for market read, LP/liquidity control, holder concentration, security/tax checks where available, and dev/deployer risk where available.
            </p>

            {/* Status pills — same chips, less crowded, DISCLOSED (Token Scanner UI polish task):
                tighter/dimmer inactive tones plus explicit row-gap so wrapped rows on narrower
                widths don't feel jammed together. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '7px', rowGap: '8px' }}>
              {[
                { label: 'No Financial Advice',     color: '#64748b', bg: 'rgba(100,116,139,0.05)', border: 'rgba(100,116,139,0.16)' },
              ].map(p => (
                <span key={p.label} style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.09em', padding: '4px 11px', borderRadius: '99px', color: p.color, background: p.bg, border: `1px solid ${p.border}`, fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>
                  {p.label}
                </span>
              ))}
              <span style={{ fontSize: '10px', color: '#253340', fontFamily: 'var(--font-plex-mono)', marginLeft: '2px' }}>
                {planLoading ? 'Checking access…' : ''}
              </span>
            </div>
          </div>

          {/* ── Search card ───────────────────────────────────────── */}
          {/* COMMAND-BAR REDESIGN, DISCLOSED (Token Scanner premium-polish task): removed the
              decorative radar hologram, the inner "Scan a token" title/helper block, and the
              Try VIRTUAL / Scan by contract / Check LP risk quick-action pills — the card is now
              a minimal command bar (chain selector, input + Scan Token, divider, one helper line
              + How CORTEX works anchor). Same input value/onChange/onKeyDown, same handleScan()
              submission, same disabled wiring — presentation-only change, zero behavior change. */}
          {/* RESULT-FIRST-HIERARCHY, DISCLOSED (Token Scanner readability polish task, explicitly
              requested: "after result loads, slightly reduce scan input's visual weight so token
              header + score area feel like the primary content"): once a result exists, the card
              shrinks its padding/margin slightly and dims a touch via opacity — same input/button/
              onKeyDown/onChange wiring, still fully usable, just visually secondary to the result
              below it. No change when there is no result yet (first-load state is untouched). */}
          <div style={{ position: 'relative', maxWidth: '820px', marginBottom: result ? '14px' : '22px', transition: 'margin 0.2s ease' }}>
            <div className="search-card" style={{ position: 'relative', zIndex: 1, padding: result ? '13px 18px' : '18px 20px', overflow: 'hidden', opacity: result ? 0.92 : 1, transition: 'padding 0.2s ease, opacity 0.2s ease' }}>
              <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: '8%', right: '8%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.55), rgba(99,102,241,0.38), transparent)' }} />
              {/* RADIAL-DEPTH, DISCLOSED (Token Scanner premium command-bar task): a static, very
                  low-opacity radial glow behind the input row — no animation, no purple bloom, just
                  enough depth so the card doesn't read as flat/empty. Purely decorative (pointer-
                  events none, zIndex 0, behind all interactive content). */}
              <span aria-hidden="true" style={{ position: 'absolute', left: '50%', top: '58px', transform: 'translateX(-50%)', width: '460px', height: '140px', background: 'radial-gradient(ellipse at center, rgba(45,212,191,0.06), transparent 72%)', pointerEvents: 'none', zIndex: 0 }} />

              {/* Command-label strip — tiny uppercase metadata, DISCLOSED (explicitly requested: a
                  small label, not a title/heading — "the old big 'Scan a token' heading/logo" stays
                  removed). Purely a label above the chain selector, same size class as other small
                  uppercase metadata already used elsewhere on this page (status pills). */}
              <p style={{ position: 'relative', zIndex: 1, margin: '0 0 10px', fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#5b7c94', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                Token Lookup
              </p>

              {/* Chain selector — compact segmented control, DISCLOSED (Token Scanner UI polish
                  task): same setChain(c) behavior, restyled from two loud neon-bordered tabs into
                  a single quiet track with a clearly-selected (but not neon) active segment. */}
              <div className="chain-seg" style={{ position: 'relative', zIndex: 1, marginBottom: '14px' }}>
                {/* SOLANA BETA, DISCLOSED: appended only when the server reports the flag AND an
                    RPC URL are both configured, so it never appears as a dead option. The four
                    existing EVM segments are unchanged. */}
                {([...(['base', 'eth', 'bnb', 'robinhood'] as const), ...(solanaAvailable ? ['solana' as const] : [])]).map(c => (
                  <button
                    key={c}
                    type="button"
                    disabled={loading || resolving}
                    onClick={() => {
                      // CROSS-CHAIN STALE-RESULT FIX, DISCLOSED: switching the chain pill only ever
                      // cleared solanaResult, never the EVM `result` (or resolver/dev/Clark state).
                      // Since the EVM result panel (`{result && (...)}`) has no chain guard, scanning
                      // an EVM chain and then clicking "SOLANA BETA" without re-scanning left the old
                      // EVM result rendered underneath the Solana-labelled input — reading as "Solana
                      // doesn't work" when it was actually stale EVM state bleeding through. Clearing
                      // every per-scan result on every chain switch (both directions) matches the
                      // exact reset handleScan already does at the start of a real scan.
                      setChain(c)
                      setError(null)
                      setResult(null)
                      setSolanaResult(null)
                      setResolverResult(null)
                      setDevIntel(null)
                      setDevIntelError(null)
                      setClarkVerdict(null)
                      setClarkError(null)
                    }}
                    className={`chain-seg-btn${chain === c ? ` chain-seg-btn--active-${c}` : ''}`}
                  >
                    {c === 'base' ? 'BASE' : c === 'eth' ? 'ETHEREUM' : c === 'bnb' ? 'BNB' : c === 'robinhood' ? 'ROBINHOOD' : 'SOLANA'}
                  </button>
                ))}
              </div>

              {/* Input + button row — command bar. Same value/onChange/onKeyDown/disabled wiring
                  as before, no submit-behavior change. No ⌘K hint: no such shortcut is wired on
                  this page, and a fake keyboard chip is exactly the kind of decoration this pass
                  removes. */}
              <div className="token-input-row" style={{ position: 'relative', zIndex: 1, display: 'flex', gap: '10px' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ position: 'absolute', left: '18px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                    <circle cx="11" cy="11" r="7" stroke="rgba(180,220,230,0.85)" strokeWidth="1.8" />
                    <path d="M20 20l-3.2-3.2" stroke="rgba(180,220,230,0.85)" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  <input
                    value={input}
                    onChange={e => { setInput(e.target.value); setResolverResult(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
                    disabled={loading}
                    placeholder={chain === 'solana' ? 'Paste Solana mint address…' : 'Enter contract address, ticker, or token name…'}
                    className="token-scan-input"
                    style={{
                      width: '100%', height: '62px', padding: '0 18px 0 44px', boxSizing: 'border-box',
                      background: 'rgba(3,8,16,0.92)',
                      border: '1px solid rgba(148,163,184,0.32)',
                      borderRadius: '13px',
                      color: '#f8fafc', fontSize: '15px',
                      fontFamily: 'var(--font-plex-mono)',
                      outline: 'none',
                      opacity: loading ? 0.6 : 1,
                      transition: 'border-color 0.15s, box-shadow 0.15s',
                      minWidth: 0,
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.35)',
                    }}
                    onFocus={e => {
                      e.currentTarget.style.borderColor = 'rgba(83,243,195,0.80)'
                      e.currentTarget.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.35), 0 0 0 3px rgba(83,243,195,0.16)'
                    }}
                    onBlur={e => {
                      e.currentTarget.style.borderColor = 'rgba(148,163,184,0.32)'
                      e.currentTarget.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.35)'
                    }}
                  />
                </div>
                <button
                  onClick={() => handleScan()}
                  disabled={loading || resolving || !input.trim()}
                  className={loading || resolving || !input.trim() ? 'scan-btn-off' : 'scan-btn-live'}
                >
                  {loading || resolving ? 'SCANNING…' : (
                    <>
                      SCAN TOKEN
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </>
                  )}
                </button>
              </div>

              {/* Enter-to-scan hint, DISCLOSED (Token Scanner final-polish task): onKeyDown above
                  already submits on Enter (unchanged) — this just makes that existing behavior
                  discoverable. Compact, muted, left-aligned under the input so it doesn't add real
                  vertical weight. */}
              <p style={{ position: 'relative', zIndex: 1, margin: '7px 0 0', fontSize: '10px', color: '#3d5468', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.02em' }}>
                Press Enter to scan
              </p>

              {/* Divider + helper line + How CORTEX works anchor (scrolls to the real "What this
                  scan checks" section below — not a fake link). */}
              <div style={{ position: 'relative', zIndex: 1, height: '1px', background: 'rgba(148,163,184,0.16)', margin: '12px 0 0' }} />
              <div className="scan-helper-row" style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '10px 0 2px' }}>
                <p style={{ margin: 0, fontSize: '11px', color: '#5d7994', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5, letterSpacing: '0.02em' }}>
                  Checks liquidity, holders, LP control, dev activity, market signals, and risk patterns.
                </p>
                <a href="#how-cortex-works" style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(94,246,209,0.90)', fontFamily: 'var(--font-plex-mono)', textDecoration: 'none', letterSpacing: '0.04em', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  How CORTEX works →
                </a>
              </div>
            </div>
          </div>

          {/* Resolver status */}
          {resolving && (
            <div style={{ maxWidth:'680px', marginBottom:'12px', padding:'10px 14px', borderRadius:'10px', background:'rgba(45,212,191,0.06)', border:'1px solid rgba(45,212,191,0.2)', display:'flex', alignItems:'center', gap:'10px', fontFamily:'var(--font-plex-mono)', fontSize:'11px', color:'#2dd4bf' }}>
              <span style={{ display:'inline-block', width:10, height:10, borderRadius:'50%', border:'2px solid #2dd4bf', borderTopColor:'transparent', animation:'spin 0.7s linear infinite', flexShrink:0 }} />
              Resolving ticker…
            </div>
          )}

          {/* Resolver result banner */}
          {!resolving && resolverResult && resolverResult.status !== 'not_found' && resolverResult.bestCandidate && (
            <div style={{ maxWidth:'680px', marginBottom:'12px' }}>
              <div style={{ padding:'10px 14px', borderRadius:'10px', background:'rgba(45,212,191,0.06)', border:`1px solid ${resolverResult.status === 'ambiguous' ? 'rgba(250,204,21,0.35)' : 'rgba(45,212,191,0.2)'}`, fontFamily:'var(--font-plex-mono)', fontSize:'11px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap' }}>
                  <span style={{ color: resolverResult.confidence === 'high' ? '#2dd4bf' : resolverResult.confidence === 'medium' ? '#facc15' : '#94a3b8', fontWeight:700 }}>
                    {resolverResult.status === 'ambiguous' ? '⚠ Multiple matches' : '✓ Resolved'}
                  </span>
                  <span style={{ color:'#e2e8f0', fontWeight:700 }}>
                    {resolverResult.bestCandidate.symbol ?? resolverResult.bestCandidate.name ?? '—'}
                  </span>
                  {resolverResult.bestCandidate.name && resolverResult.bestCandidate.name !== resolverResult.bestCandidate.symbol && (
                    <span style={{ color:'#64748b' }}>{resolverResult.bestCandidate.name}</span>
                  )}
                  <span style={{ padding:'2px 7px', borderRadius:'999px', background:'rgba(45,212,191,0.12)', color:'#2dd4bf', fontSize:'9px', fontWeight:700, letterSpacing:'.1em' }}>{resolverResult.bestCandidate.chainLabel}</span>
                  {resolverResult.bestCandidate.liquidityUsd != null && (
                    <span style={{ color:'#475569', fontSize:'10px' }}>Liq {fmtLiquidity(resolverResult.bestCandidate.liquidityUsd)}</span>
                  )}
                  <span style={{ color:'#334155', fontSize:'9px', fontFamily:'monospace' }}>{resolverResult.contractAddress?.slice(0,8)}…{resolverResult.contractAddress?.slice(-4)}</span>
                </div>
              </div>

              {/* Alternates picker */}
              {resolverResult.alternates.length > 0 && (
                <div style={{ marginTop:'6px', display:'flex', gap:'6px', flexWrap:'wrap' }}>
                  <span style={{ color:'#334155', fontSize:'9px', fontFamily:'var(--font-plex-mono)', alignSelf:'center' }}>Other matches:</span>
                  {resolverResult.alternates.slice(0, 4).map((alt: ResolverCandidate) => (
                    <button
                      key={alt.contractAddress + alt.chainId}
                      disabled={loading || resolving}
                      onClick={() => {
                        const altChain: 'base' | 'eth' | 'bnb' | 'robinhood' = alt.chainId === 'ethereum' ? 'eth' : alt.chainId === 'bnb' ? 'bnb' : alt.chainId === 'robinhood' ? 'robinhood' : 'base'
                        setChain(altChain)
                        handleScan(alt.contractAddress, altChain)
                      }}
                      style={{ padding:'4px 10px', borderRadius:'999px', background:'rgba(100,116,139,0.12)', border:'1px solid rgba(100,116,139,0.25)', color:'#94a3b8', fontSize:'9px', fontFamily:'var(--font-plex-mono)', cursor: (loading || resolving) ? 'not-allowed' : 'pointer', opacity: (loading || resolving) ? 0.45 : 1, display:'flex', alignItems:'center', gap:'5px' }}
                    >
                      <span style={{ fontWeight:700 }}>{alt.symbol ?? alt.name ?? alt.contractAddress.slice(0,6)}</span>
                      <span style={{ opacity:0.6 }}>{alt.chainLabel}</span>
                      {alt.liquidityUsd != null && <span style={{ opacity:0.5 }}>{fmtLiquidity(alt.liquidityUsd)}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              maxWidth: '680px', padding: '13px 18px',
              background: 'rgba(248,113,113,0.07)',
              border: '1px solid rgba(248,113,113,0.22)',
              borderRadius: '10px', color: '#fca5a5',
              fontSize: '13px', fontFamily: 'var(--font-plex-mono)',
              marginBottom: '24px',
            }}>
              <p style={{ margin: crossChainSwitchCandidate ? '0 0 10px' : 0 }}>{error}</p>
              {crossChainSwitchCandidate && (
                <button
                  type="button"
                  onClick={() => {
                    const candidate = crossChainSwitchCandidate
                    if (!candidate) return
                    setChain(candidate.chain)
                    setCrossChainSwitchCandidate(null)
                    void handleScan(candidate.address, candidate.chain)
                  }}
                  style={{ padding: '7px 12px', borderRadius: '8px', border: '1px solid rgba(251,191,36,.32)', background: 'rgba(251,191,36,.08)', color: '#fbbf24', fontSize: '11px', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', cursor: 'pointer' }}
                >
                  Switch to {chainDisplayName(crossChainSwitchCandidate.chain)} and scan
                </button>
              )}
            </div>
          )}

          {/* ── SOLANA BETA RESULT, DISCLOSED (Token Scanner Solana UI parity task) ──────────
              UI-PARITY, DISCLOSED: rebuilt to reuse the SAME result shell as every other chain —
              result-header, the six-tab bar (same activeSection state), the same StatCard/
              gauge-container/summary-card visual language used by the EVM tabs below. Still
              rendered from its OWN data (solanaResult) and its OWN markup for every tab body —
              never coerced into the EVM `ScanResult` shape, which carries LP-lock/honeypot/tax/
              owner fields with no honest Solana value. Every EVM-only check stays an explicit
              "unsupported" line, never a passed/failed one. */}
          {/* LOADING SKELETON FIX, DISCLOSED (audit: Solana results unmount during any loading, no
              skeleton — same "blank page below the search card" gap as the EVM path above). */}
          {loading && chain === 'solana' && !solanaResult && !error && (
            <div style={{ maxWidth: 'none', width: '100%', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ padding: '18px', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,.6)', display: 'flex', alignItems: 'center', gap: '14px' }}>
                <div className="shimmer-line" style={{ width: '46px', height: '46px', borderRadius: '50%', flexShrink: 0 }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div className="shimmer-line" style={{ width: '38%', height: '13px' }} />
                  <div className="shimmer-line" style={{ width: '58%', height: '10px' }} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                {[0, 1, 2, 3].map(i => (
                  <div key={i} style={{ padding: '14px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,.6)', display: 'flex', flexDirection: 'column', gap: '9px' }}>
                    <div className="shimmer-line" style={{ width: '50%', height: '9px' }} />
                    <div className="shimmer-line" style={{ width: '70%', height: '16px' }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {solanaResult && !loading && (() => {
            const sr = solanaResult
            const sc = computeSolanaConfidenceScore(sr)
            // The betaRisk verdict/color pair that used to live here is gone: its top label was the
            // literal string "Open Check", and every surface that showed it now reads the real
            // graded computeSolanaCortexRisk verdict instead (see the CORTEX RISK READ strip).
            const confColor = sr.betaRisk.confidence === 'MEDIUM' ? '#fbbf24' : '#94a3b8'
            const copySolanaAddress = async (address: string) => {
              try {
                if (typeof window === 'undefined') return
                if (navigator?.clipboard?.writeText) {
                  await navigator.clipboard.writeText(address)
                } else {
                  const textArea = document.createElement('textarea')
                  textArea.value = address
                  textArea.setAttribute('readonly', '')
                  textArea.style.position = 'fixed'
                  textArea.style.opacity = '0'
                  textArea.style.pointerEvents = 'none'
                  document.body.appendChild(textArea)
                  textArea.select()
                  document.execCommand('copy')
                  document.body.removeChild(textArea)
                }
                setCopiedSolanaAddress(address)
                window.setTimeout(() => setCopiedSolanaAddress((prev) => (prev === address ? null : prev)), 1500)
              } catch { /* best-effort — clipboard access can be denied, never fatal */ }
            }
            const conc = sr.topAccountConcentration
            const concRisk: 'HIGH' | 'MEDIUM' | 'LOW' | null = conc?.top10Percent != null ? (conc.top10Percent > 50 ? 'HIGH' : conc.top10Percent > 30 ? 'MEDIUM' : 'LOW') : null
            const concColor = concRisk === 'HIGH' ? '#f87171' : concRisk === 'MEDIUM' ? '#fbbf24' : concRisk === 'LOW' ? '#34d399' : '#94a3b8'
            const cardBase: React.CSSProperties = { padding: '14px 16px', background: 'linear-gradient(145deg,rgba(6,12,24,.94),rgba(14,16,32,.84))', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)' }
            const cardTitle: React.CSSProperties = { margin: '0 0 10px', fontSize: '10px', fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }
            const gapLine = (text: string, key: string | number) => (
              <p key={key} style={{ margin: '0 0 6px', fontSize: '11.5px', color: '#8ea0b5', lineHeight: 1.6, paddingLeft: '13px', position: 'relative' }}>
                <span style={{ position: 'absolute', left: 0, color: '#3a5268' }}>—</span>{text}
              </p>
            )

            return (
              <div style={{ maxWidth: 'none', width: '100%' }}>
                {/* Header — RECEIPT-HEADER parity with the EVM result-header: name/symbol lead,
                    shortened mint pill + chain/status badges, never the mint-read table as header. */}
                <div className="result-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', marginBottom: '18px', paddingBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  <div style={{ minWidth: 0 }}>
                    <h2 style={{ fontSize: '21px', fontWeight: 800, color: '#f8fafc', margin: '0 0 6px', letterSpacing: '-0.01em', display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
                      {/* Provider wiring task: Jupiter name first, DexScreener fallback, mint last. */}
                      {sr.resolvedTokenName ?? sr.resolvedTokenSymbol ?? 'Unknown Solana Token'}
                      {/* Symbol only shown as a separate badge when name is present — otherwise the
                          symbol IS the heading above and repeating it here would be a duplicate. */}
                      {sr.resolvedTokenName && sr.resolvedTokenSymbol && (
                        <span style={{ fontSize: '13px', fontWeight: 700, color: '#c084fc', fontFamily: 'var(--font-plex-mono)' }}>{sr.resolvedTokenSymbol}</span>
                      )}
                    </h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '10.5px', color: '#7c93aa', fontFamily: 'var(--font-plex-mono)', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '7px', padding: '3px 9px' }}>
                        {shorten(sr.mintAddress)}
                      </span>
                      <span style={{ padding: '3px 10px', border: '1px solid rgba(153,69,255,.42)', borderRadius: '999px', color: '#ddd0ff', fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', fontFamily: 'var(--font-plex-mono)', background: 'rgba(153,69,255,.10)' }}>
                        SOLANA
                      </span>
                      <span style={{ padding: '3px 10px', border: '1px solid rgba(94,234,212,.35)', borderRadius: '999px', color: '#5eead4', fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', fontFamily: 'var(--font-plex-mono)', background: 'rgba(45,212,191,.07)' }}>
                        {sr.tokenProgram === 'spl-token-2022' ? 'TOKEN-2022' : sr.tokenProgram === 'spl-token' ? 'SPL TOKEN' : 'PROGRAM UNKNOWN'}
                      </span>
                      <span style={{ padding: '3px 10px', border: '1px solid rgba(251,191,36,.35)', borderRadius: '999px', color: '#fcd34d', fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', fontFamily: 'var(--font-plex-mono)', background: 'rgba(251,191,36,.07)' }}>
                        EVIDENCE LIMITED · BETA
                      </span>
                    </div>
                  </div>
                </div>

                {/* Same six-tab bar every other chain uses — same activeSection state, same order. */}
                <div className="result-tabs-wrap" style={{ marginBottom: '22px', position: 'sticky', top: 0, zIndex: 5, background: 'rgba(2,6,23,0.32)', backdropFilter: 'blur(12px)', paddingTop: '4px', paddingBottom: '0px', borderBottom: '1px solid rgba(148,180,200,.09)' }}>
                  <div className="result-tabs-scroll" style={{ display: 'flex', gap: '2px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
                    {([
                      { id: 'cortex-read' as const, label: 'Overview' },
                      { id: 'market-pulse' as const, label: 'Market' },
                      { id: 'holder-map' as const, label: 'Holders' },
                      { id: 'lp-safety' as const, label: 'LP Safety' },
                      { id: 'risk-engine' as const, label: 'Risk Engine' },
                      { id: 'deployer-intel' as const, label: 'Dev' },
                    ]).map(s => {
                      const active = activeSection === s.id
                      return (
                        <button key={s.id} className="result-tab-btn" onClick={() => setActiveSection(s.id)}
                          style={{
                            position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                            height: '38px', padding: '0 14px', borderRadius: '8px 8px 0 0', cursor: 'pointer',
                            whiteSpace: 'nowrap', flexShrink: 0, fontFamily: 'var(--font-plex-mono)', fontSize: '11px',
                            fontWeight: active ? 750 : 550, letterSpacing: '0.06em', transition: 'all 0.14s',
                            background: active ? 'rgba(153,69,255,0.09)' : 'transparent', border: 'none',
                            color: active ? '#ddd0ff' : '#7c93aa',
                          }}>
                          {s.label}
                          {active && <span aria-hidden="true" style={{ position: 'absolute', left: '10px', right: '10px', bottom: '-1px', height: '2px', borderRadius: '2px', background: 'rgba(153,69,255,0.85)', boxShadow: '0 0 8px rgba(153,69,255,0.45)' }} />}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* ── Overview ────────────────────────────────────────── */}
                {/* OVERVIEW-PARITY, DISCLOSED (Token Scanner Solana premium-parity task): now
                    mirrors the EVM Overview's exact three-tier structure — a main score hero,
                    a Score Breakdown card underneath, then a secondary CORTEX read — instead of
                    a single status card. Same underlying data, real computed sc/betaRisk values. */}
                {activeSection === 'cortex-read' && (() => {
                  // Same engine the Risk Engine tab and the side receipt read — see the CORTEX RISK
                  // READ strip below for why this replaced sr.betaRisk here.
                  const overviewCx = computeSolanaCortexRisk(sr)
                  return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {/* Main score hero — same footprint/typography as EVM's "TOKEN SAFETY SCORE"
                        card, never a "— /100" placeholder: sc.score is always a real number. */}
                    <div style={{ marginBottom: '0', background: 'linear-gradient(160deg,rgba(8,16,32,.98),rgba(4,8,18,.96))', border: `1px solid ${sc.color}32`, borderRadius: '16px', padding: '18px 22px', boxShadow: `0 0 44px ${sc.color}10, 0 0 0 1px ${sc.color}06 inset` }}>
                      <div style={{ fontSize: '10px', letterSpacing: '.18em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '5px' }}>SOLANA CONFIDENCE SCORE</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
                          <span style={{ fontSize: '52px', fontWeight: 800, color: sc.color, fontFamily: 'var(--font-plex-mono)', lineHeight: 1, textShadow: `0 0 24px ${sc.color}38` }}>{sc.score}</span>
                          <span style={{ fontSize: '16px', color: `${sc.color}55`, fontFamily: 'var(--font-plex-mono)' }}>/100</span>
                        </div>
                        <span style={{ padding: '4px 14px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, letterSpacing: '0.10em', color: sc.color, background: `${sc.color}14`, border: `1px solid ${sc.color}45`, fontFamily: 'var(--font-plex-mono)' }}>{sc.verdict.toUpperCase()}</span>
                      </div>
                      <div style={{ height: '4px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginTop: '12px' }}>
                        <div style={{ height: '100%', width: `${sc.score}%`, borderRadius: '999px', background: `linear-gradient(90deg,${sc.color},${sc.color}80)`, transition: 'width 0.7s ease', boxShadow: `0 0 6px ${sc.color}55` }} />
                      </div>
                      <div style={{ fontSize: '10px', color: '#5b7186', fontFamily: 'var(--font-plex-mono)', marginTop: '9px', lineHeight: 1.55 }}>
                        Computed from supported Solana evidence only — authority status, top-account concentration, market health, and track record (creator verification + pool age). Scaled down proportionally to this token&apos;s own real age, evidence coverage, and creator verification — never to a shared ceiling — so this can never read as a full safety verdict, and two different tokens are never forced to the same number.
                        {sc.scoreCapReasons.length > 0 && <span style={{ display: 'block', marginTop: '6px', color: '#8ea0b5' }}>{sc.scoreCapReasons.join(' ')}</span>}
                      </div>
                    </div>

                    {/* Score Breakdown — same visual language as EVM: label, status pill, bar, reason chips. */}
                    <div style={{ padding: '14px 16px', borderRadius: '12px', border: '1px solid rgba(125,211,252,0.20)', background: 'rgba(8,14,28,0.72)' }}>
                      <p style={{ margin: '0 0 12px', fontSize: '10px', letterSpacing: '.16em', color: '#7dd3fc', fontWeight: 800, fontFamily: 'var(--font-plex-mono)' }}>SCORE BREAKDOWN</p>
                      <div style={{ display: 'grid', gap: '10px' }}>
                        {sc.categories.map((cat, rIdx) => {
                          const pct = cat.max > 0 ? Math.max(0, Math.min(100, (cat.score / cat.max) * 100)) : 0
                          const barColor = pct >= 70 ? '#2DD4BF' : pct >= 40 ? '#fbbf24' : '#f87171'
                          const statusLabel = pct >= 70 ? 'Strong' : pct >= 40 ? 'Moderate' : 'Weak'
                          return (
                            <div key={cat.label} style={{ paddingBottom: '10px', borderBottom: rIdx < sc.categories.length - 1 ? '1px solid rgba(255,255,255,0.045)' : 'none' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px', gap: '8px' }}>
                                <span style={{ fontSize: '11px', color: '#d3dfec', fontFamily: 'var(--font-plex-mono)', fontWeight: 650 }}>{cat.label}</span>
                                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '7px' }}>
                                  <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '.05em', color: barColor, background: `${barColor}14`, border: `1px solid ${barColor}38`, fontFamily: 'var(--font-plex-mono)' }}>{statusLabel}</span>
                                  <span style={{ fontSize: '11px', color: barColor, fontWeight: 800, letterSpacing: '.06em', fontFamily: 'var(--font-plex-mono)' }}>{cat.score}/{cat.max}</span>
                                </span>
                              </div>
                              <div style={{ height: '4px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: '7px' }}>
                                <div style={{ height: '100%', width: `${pct}%`, borderRadius: '999px', background: `linear-gradient(90deg,${barColor},${barColor}80)`, transition: 'width 0.7s ease' }} />
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                {cat.reasons.map((r, i) => (
                                  <span key={i} style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 600, color: '#a3b4c5', background: 'rgba(148,163,184,0.07)', border: '1px solid rgba(148,163,184,0.20)', fontFamily: 'var(--font-plex-mono)' }}>{r}</span>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* Secondary read — same slot as EVM's "CORTEX ENGINE READ" strip.
                        SOURCE CHANGED, DISCLOSED (reported: "a lot of it is open check and not
                        actual facts"): this strip used to print sr.betaRisk, whose best label is
                        the literal string "Open Check" — so a token with fully clean, fully
                        resolved evidence still showed "Open Check" here while the Risk Engine tab
                        showed a real graded verdict from the 9-category engine. Same scan, two
                        different answers, and the vaguer one led. It now reads the SAME
                        computeSolanaCortexRisk result the Risk Engine tab and the side receipt use,
                        so all three agree and every state is a real graded verdict. */}
                    <div style={{ padding: '12px 16px', borderRadius: '12px', border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(8,14,28,0.55)' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'baseline' }}>
                        <div style={{ fontSize: '9px', letterSpacing: '.16em', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>CORTEX RISK READ</div>
                        <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>Verdict: <span style={{ color: overviewCx.verdictColor, fontWeight: 700 }}>{overviewCx.verdict}</span></div>
                        <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>Score: <span style={{ color: overviewCx.verdictColor, fontWeight: 700 }}>{overviewCx.score}/{overviewCx.scoreMax}</span></div>
                        <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>Evidence: <span style={{ color: confColor, fontWeight: 700 }}>{overviewCx.overallConfidence}</span></div>
                      </div>
                    </div>

                    {sr.solanaEvidenceGaps.length > 0 && (
                      <div style={cardBase}>
                        <p style={{ ...cardTitle, color: '#fbbf24' }}>Evidence Gaps</p>
                        {sr.solanaEvidenceGaps.map((g, i) => gapLine(g, i))}
                      </div>
                    )}
                    {/* The "Unsupported in Solana Beta" card that used to close this tab was
                        removed on request. Nothing verified was lost: it listed only static
                        EVM-only checks (honeypot simulation, ERC-20 LP lock/burn, proxy/admin,
                        deployer history) that never applied to Solana, and the Solana pool
                        authority open check, which LP Safety already reports from real data. */}
                  </div>
                  )
                })()}

                {/* ── Market ──────────────────────────────────────────── */}
                {activeSection === 'market-pulse' && (
                  <>
                    <div style={{ marginBottom: '16px' }}>
                      <p style={{ margin: '0 0 3px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.10em', color: '#22d3ee', fontFamily: 'var(--font-plex-mono)' }}>MARKET PULSE</p>
                      <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Price, liquidity, volume, and pool depth from indexed Solana pools.</p>
                    </div>
                    {/* Project Links, DISCLOSED (Solana provider-wiring follow-up: "make sure a
                        Sol coin scan shows its X/website/Reddit links"): reuses the exact same
                        card EVM renders through, sourced from sr.marketData.socials — the SAME
                        already-fetched DexScreener pair response, no new provider call. Same
                        "No socials found" empty state as EVM when the pair carries none. */}
                    <ProjectSocialsCard socials={sr.marketData?.socials} />
                    {/* CHART, DISCLOSED (Solana provider-wiring follow-up: "make the price chart
                        work"): real OHLCV candles from GeckoTerminal's free, keyless public API,
                        keyed off the same pool address DexScreener already resolved — no new key,
                        no fabricated series. Reuses CandlestickChart, the exact same component EVM
                        renders through, so a real Solana chart looks identical to an EVM one. Falls
                        back to the prior honest label — never a broken/empty chart card — when
                        GeckoTerminal has no indexed candles for this pool yet. */}
                    {sr.ohlcv.success && sr.ohlcv.candles.length >= 2 ? (
                      <div className="glass-card" style={{ marginBottom: '16px', borderRadius: '16px', padding: '18px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                          <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', color: '#cbd5e1', textTransform: 'uppercase' }}>Price Chart</p>
                          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', padding: '2px 8px', borderRadius: '99px', color: '#34d399', background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.20)', textTransform: 'uppercase' }}>Live Candles · GeckoTerminal</span>
                        </div>
                        <div style={{ display: 'inline-flex', marginBottom: '10px', border: '1px solid rgba(148,163,184,.3)', borderRadius: '999px', padding: '2px 8px', fontSize: '10px', color: '#cbd5e1' }}>1H</div>
                        <CandlestickChart
                          candles={sr.ohlcv.candles.map((c) => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, priceUsd: c.close }))}
                          timeframe="1H"
                        />
                      </div>
                    ) : (
                      <div className="glass-card" style={{ marginBottom: '16px', borderRadius: '16px', padding: '18px' }}>
                        <p style={{ margin: '0 0 6px', fontSize: '12px', fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Price Chart</p>
                        <p style={{ margin: 0, fontSize: '12px', color: '#3a5268', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>
                          {!sr.marketData ? 'Chart data unavailable — no indexed Solana pool found for this mint.' : 'Historical candles are not indexed for this pool yet — current price is live.'}
                        </p>
                      </div>
                    )}
                    {(() => {
                      // Jupiter is a PRICE FALLBACK only — DexScreener stays primary per the
                      // provider-wiring task. priceSource labels which provider the number is
                      // actually from, so the fallback is never silently indistinguishable.
                      const price = sr.marketData?.priceUsd ?? sr.jupiter.resolved.price
                      const priceSource = sr.marketData?.priceUsd != null ? 'DexScreener' : sr.jupiter.resolved.price != null ? 'Jupiter (fallback)' : undefined
                      return sr.marketData || price != null ? (
                        <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '12px', marginBottom: '10px' }}>
                          <StatCard label="Price" value={price != null ? `$${price}` : 'Unavailable'} accent="#2DD4BF" helper={priceSource} />
                          <StatCard label="Liquidity" value={sr.marketData?.liquidityUsd != null ? fmtLarge(sr.marketData.liquidityUsd) : 'Unavailable'} accent="#22d3ee" />
                          <StatCard label="24h Volume" value={sr.marketData?.volume24hUsd != null ? fmtLarge(sr.marketData.volume24hUsd) : 'Unavailable'} accent="#a78bfa" />
                          <StatCard label={sr.marketData?.marketCapUsd != null ? 'Market Cap' : 'FDV'} value={sr.marketData?.marketCapUsd != null ? fmtLarge(sr.marketData.marketCapUsd) : sr.marketData?.fdvUsd != null ? fmtLarge(sr.marketData.fdvUsd) : 'Unavailable'} accent="#fb923c" dim />
                          <StatCard label="Primary Pool / DEX" value={sr.marketData?.primaryDexLabel ?? 'Solana pool / AMM'} accent="#94a3b8" dim />
                          <StatCard label="Pair Age" value={sr.marketData?.pairAgeLabel ?? 'Unavailable'} accent="#94a3b8" dim />
                        </div>
                      ) : (
                        <div style={{ padding: '20px', border: '1px dashed rgba(148,163,184,0.24)', borderRadius: '14px', background: 'rgba(148,163,184,0.03)' }}>
                          <p style={{ margin: 0, fontSize: '12.5px', color: '#8ea0b5', lineHeight: 1.6 }}>Market data unavailable for this Solana mint. No pool was found via the indexed Solana market provider — this is shown as an open check, never a fake price or liquidity figure.</p>
                        </div>
                      )
                    })()}
                    {/* Pool activity, DISCLOSED (Solana provider-wiring follow-up: "Pool Activity
                        isn't giving info"): buys/sells are REAL now, read from the SAME
                        already-fetched DexScreener response's txns.h24 field — no new call.
                        DexScreener does not split volume by buy/sell in this endpoint, so "Buy /
                        Sell Vol" is replaced with a Buy/Sell Ratio computed from the real counts
                        instead of a fabricated split-volume figure. */}
                    {sr.marketData && (() => {
                      const { buys, sells } = sr.marketData.txns24h
                      const total = buys != null && sells != null ? buys + sells : null
                      const ratio = buys != null && sells != null && sells > 0 ? (buys / sells).toFixed(2) : null
                      return (
                        <div style={{ marginTop: '18px' }}>
                          <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', marginBottom: '10px', fontFamily: 'var(--font-plex-mono)' }}>Pool Activity</p>
                          <div className="activity-grid">
                            <StatCard label="Transactions 24H" value={total != null ? String(total) : 'Not indexed in Beta'} accent={total != null ? '#67e8f9' : '#94a3b8'} dim={total == null} />
                            <StatCard label="Buys / Sells" value={buys != null && sells != null ? `${buys} / ${sells}` : 'Not indexed in Beta'} accent={buys != null ? '#34d399' : '#94a3b8'} dim={buys == null} />
                            <StatCard label="Buy / Sell Ratio" value={ratio ?? 'Not indexed in Beta'} accent={ratio != null ? '#a78bfa' : '#94a3b8'} dim={ratio == null} helper={ratio != null ? 'From DexScreener tx counts, not volume' : undefined} />
                            <StatCard label="Pair Age" value={sr.marketData.pairAgeLabel ?? 'Not tracked in Beta'} accent="#94a3b8" dim />
                          </div>
                        </div>
                      )
                    })()}
                  </>
                )}

                {/* ── Holders (top-account concentration) ──────────────── */}
                {activeSection === 'holder-map' && (
                  <>
                    <div style={{ marginBottom: '18px' }}>
                      <p style={{ margin: '0 0 3px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.10em', color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>HOLDER MAP</p>
                      <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Top-account distribution and supply concentration — see the note below on what this does and doesn&apos;t prove.</p>
                    </div>
                    {conc ? (
                      <>
                        <div style={{ padding: '14px 16px', borderRadius: '12px', background: `${concColor}0c`, border: `1px solid ${concColor}30`, marginBottom: '12px' }}>
                          <p style={{ margin: '0 0 4px', fontSize: '13px', fontWeight: 800, color: concColor, fontFamily: 'var(--font-plex-mono)', lineHeight: 1.4 }}>
                            {concRisk === 'HIGH' ? `High concentration — top 10 accounts hold ${conc.top10Percent?.toFixed(1)}%.` : concRisk === 'MEDIUM' ? `Moderate concentration — top 10 accounts hold ${conc.top10Percent?.toFixed(1)}%.` : concRisk === 'LOW' ? `Spread looks reasonable — top 10 accounts hold ${conc.top10Percent?.toFixed(1)}%.` : 'Concentration verdict is an open check for this scan.'}
                          </p>
                          <p style={{ margin: 0, fontSize: '10.5px', color: '#7c93aa', fontFamily: 'var(--font-plex-mono)' }}>Sampled {conc.accountsSampled} top accounts (max 20 — this is the RPC method&apos;s own cap).</p>
                          <p style={{ margin: '4px 0 0', fontSize: '10px', color: '#5b7387', fontFamily: 'var(--font-plex-mono)' }}>
                            {/* HOLDER-COUNT, DISCLOSED (Solana provider-wiring follow-up: "make
                                holders work"): sourced from Helius's paginated getTokenAccounts —
                                a real count of SPL token accounts with a positive balance, not a
                                top-20 sample and not a fabricated 0. Labelled "accounts" (not
                                "holders") because AMM pool vaults/exchange custody accounts are
                                counted too — same honesty caveat as the top-account sample above.
                                "+" means capped for cost control; the real count may be higher. */}
                            Token accounts with balance: {sr.heliusHolders.holderCount != null ? `${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''}` : 'not available (Helius holder read did not resolve or is not enabled)'} — distinct from the top-account sample above.
                          </p>
                        </div>
                        <div className="holders-grid" style={{ gridColumn: '1 / -1', padding: '14px 16px', borderRadius: '12px', background: 'rgba(167,139,250,0.05)', border: `1px solid ${concColor}28`, marginBottom: '16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>TOP-ACCOUNT CONCENTRATION</span>
                            <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.12em', color: concColor, background: `${concColor}12`, border: `1px solid ${concColor}40`, fontFamily: 'var(--font-plex-mono)' }}>{concRisk ?? 'OPEN CHECK'}</span>
                            {/* RELIABILITY FIX, DISCLOSED (Solana holder-concentration reliability
                                task, UI state #4 — "if verified: show ... source badge"): the real
                                source resolveSolanaHolderConcentration used for this scan's
                                concentration data — cache / Helius / RPC getTokenLargestAccounts.
                                Also flags a PARTIAL badge when the source itself reported partial
                                (e.g. a lower-bound Helius sample), per UI state #4's own spec. */}
                            {sr.solanaHolderConcentrationResult && sr.solanaHolderConcentrationResult.source !== 'none' && (
                              <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '.1em', color: '#8aa3b8', background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.22)', fontFamily: 'var(--font-plex-mono)' }}>
                                {sr.solanaHolderConcentrationResult.status === 'partial' ? 'PARTIAL · ' : ''}SOURCE: {sr.solanaHolderConcentrationResult.source === 'rpc_largest_accounts' ? 'SOLANA RPC' : sr.solanaHolderConcentrationResult.source.toUpperCase()}
                              </span>
                            )}
                          </div>
                          {sr.solanaHolderConcentrationResult?.status === 'partial' && sr.solanaHolderConcentrationResult.publicReason && (
                            <p style={{ margin: '0 0 10px', fontSize: '10.5px', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{sr.solanaHolderConcentrationResult.publicReason}</p>
                          )}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: '8px', marginBottom: '10px' }}>
                            {[
                              ['Top 1', conc.top1Percent != null ? `${conc.top1Percent.toFixed(1)}%` : 'N/A'],
                              ['Top 10', conc.top10Percent != null ? `${conc.top10Percent.toFixed(1)}%` : 'N/A'],
                              ['Top 20', conc.top20Percent != null ? `${conc.top20Percent.toFixed(1)}%` : 'N/A'],
                              ['Accounts sampled', String(conc.accountsSampled)],
                            ].map(([label, val]) => (
                              <div key={label} style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(167,139,250,0.16)' }}>
                                <div style={{ fontSize: '9px', letterSpacing: '.12em', color: '#64748b', marginBottom: '3px', fontFamily: 'var(--font-plex-mono)' }}>{label}</div>
                                <div style={{ fontSize: '12px', color: '#e2e8f0', fontWeight: 800, fontFamily: 'var(--font-plex-mono)' }}>{val}</div>
                              </div>
                            ))}
                          </div>
                          {[
                            ['Top 1', conc.top1Percent],
                            ['Top 10', conc.top10Percent],
                            ['Top 20', conc.top20Percent],
                          ].map(([label, pct]) => (
                            <div key={label as string} style={{ marginBottom: '6px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#7c93aa', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>
                                <span>{label}</span><span>{pct != null ? `${(pct as number).toFixed(1)}%` : 'N/A'}</span>
                              </div>
                              <div style={{ height: '5px', borderRadius: '999px', background: 'rgba(148,163,184,0.10)', overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct != null ? Math.min(100, pct as number) : 0}%`, background: concColor, borderRadius: '999px' }} />
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* TOP ACCOUNTS TABLE, DISCLOSED (Token Scanner Solana premium-parity task):
                            same "glass-card" TOP HOLDERS table shell EVM's Holders tab uses (rank
                            badge / address / amount / % / copy), populated from
                            conc.accounts — the real per-account rows getTokenLargestAccounts
                            already returns. Header says "TOP ACCOUNTS" (not "TOP HOLDERS") since
                            these are token accounts, not resolved unique holders — see the note
                            below the table. */}
                        <div className="glass-card" style={{ padding: '18px', minWidth: 0, overflow: 'hidden', marginBottom: '16px' }}>
                          <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', marginBottom: '4px', fontFamily: 'var(--font-plex-mono)' }}>TOP ACCOUNTS</p>
                          <p style={{ margin: '0 0 10px', fontSize: '11px', color: '#8aa3b8' }}>Top {conc.accounts.length} token accounts by balance</p>
                          <div className="top-holder-head" style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 88px 62px 74px', gap: '10px', fontSize: '10px', letterSpacing: '0.10em', color: '#6a8198', marginBottom: '8px', fontFamily: 'var(--font-plex-mono)' }}><span>#</span><span>ACCOUNT</span><span style={{ textAlign: 'right' }}>AMOUNT</span><span style={{ textAlign: 'right' }}>%</span><span style={{ textAlign: 'right' }}>COPY</span></div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px', overflowY: 'auto', paddingRight: '3px' }}>
                            {conc.accounts.map((acc) => {
                              const pct = acc.percentOfSupply
                              const pctColor = pct != null && pct >= 20 ? '#fb7185' : pct != null && pct >= 5 ? '#fbbf24' : '#67e8f9'
                              // amountRaw is a base-unit string from getTokenLargestAccounts — the
                              // account address itself isn't in this row's evidence (the RPC returns
                              // amounts keyed by pubkey, not surfaced per-row here), so the copy
                              // action copies the mint + rank reference instead of a fabricated
                              // address. Decimals default to 0 (raw units shown) when unresolved,
                              // never a guessed decimal count.
                              const rowKey = `${acc.rank}-${acc.amountRaw}`
                              return (
                                <div className="top-holder-row" key={rowKey} style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 88px 62px 74px', gap: '10px', alignItems: 'center', padding: '10px', border: '1px solid rgba(148,163,184,.18)', borderRadius: '10px', background: 'rgba(15,23,42,.45)' }}>
                                  <span style={{ fontSize: '11px', color: '#dbeafe', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, display: 'inline-flex', justifyContent: 'center', padding: '2px 0', borderRadius: '999px', background: acc.rank <= 3 ? 'linear-gradient(90deg,rgba(45,212,191,.28),rgba(168,85,247,.28))' : 'transparent', border: acc.rank <= 3 ? '1px solid rgba(167,139,250,.45)' : 'none' }}>{acc.rank}</span>
                                  <span style={{ fontSize: '12px', color: '#c5d8ea', fontFamily: 'var(--font-plex-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Account #{acc.rank}</span>
                                  <span style={{ fontSize: '12px', color: '#e5eef9', textAlign: 'right', fontFamily: 'var(--font-plex-mono)' }}>{fmtTokenAmt(acc.amountRaw, sr.decimals ?? 0)}</span>
                                  <span style={{ fontSize: '12px', fontWeight: 800, textAlign: 'right', fontFamily: 'var(--font-plex-mono)', color: pctColor }}>{pct == null ? '—' : `${pct.toFixed(2)}%`}</span>
                                  <button type="button" onClick={() => { void copySolanaAddress(sr.mintAddress) }}
                                    style={{
                                      justifySelf: 'end', padding: '4px 10px', borderRadius: '999px',
                                      border: copiedSolanaAddress === sr.mintAddress ? '1px solid rgba(45,212,191,0.55)' : '1px solid rgba(167,139,250,0.48)',
                                      background: copiedSolanaAddress === sr.mintAddress ? 'linear-gradient(135deg,rgba(45,212,191,0.18),rgba(45,212,191,0.1))' : 'linear-gradient(135deg,rgba(167,139,250,0.2),rgba(45,212,191,0.08))',
                                      color: copiedSolanaAddress === sr.mintAddress ? '#67e8f9' : '#c4b5fd',
                                      fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', fontFamily: 'var(--font-plex-mono)',
                                      cursor: 'pointer', whiteSpace: 'nowrap', minHeight: '26px',
                                    }}
                                    aria-label="Copy mint address">
                                    {copiedSolanaAddress === sr.mintAddress ? 'Copied' : 'Mint'}
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div style={{ padding: '20px', border: '1px dashed rgba(148,163,184,0.24)', borderRadius: '14px', background: 'rgba(148,163,184,0.03)', marginBottom: '16px' }}>
                        {/* PUBLIC-SAFE WORDING, DISCLOSED (Solana holder-concentration reliability
                            task, UI state #4 — "if unavailable: show Holder concentration
                            unavailable / exact public reason / Not confirmed healthy"): always the
                            resolver's clean publicReason — never a raw provider/RPC error string
                            (technicalReason stays debug-only, never rendered here). Never a
                            fabricated 0% — the fields simply aren't shown in this branch. */}
                        <p style={{ margin: 0, fontSize: '12.5px', color: '#8ea0b5', lineHeight: 1.6 }}>Holder concentration unavailable for this mint.</p>
                        <p style={{ margin: '8px 0 0', fontSize: '10.5px', color: '#5b7590', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>
                          {sr.solanaHolderConcentrationResult?.publicReason ?? 'Holder concentration unavailable — Solana provider did not return top token accounts.'}
                        </p>
                        <p style={{ margin: '8px 0 0', fontSize: '10px', fontWeight: 700, letterSpacing: '.08em', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)' }}>NOT CONFIRMED HEALTHY</p>
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(148,163,184,0.04)', border: '1px solid rgba(148,163,184,0.14)' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7c93aa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
                      <p style={{ margin: 0, fontSize: '11px', color: '#7c93aa', lineHeight: 1.5 }}>
                        Top token account concentration, not full holder count. AMM pool vaults and exchange custody accounts may be included.
                      </p>
                    </div>
                  </>
                )}

                {/* ── LP Safety ───────────────────────────────────────── */}
                {activeSection === 'lp-safety' && (() => {
                  // LP-ANALYZER-PARITY, DISCLOSED (Solana provider-wiring follow-up: "why is LP
                  // Safety not working like the EVM LP Safety Analyzer — I want it like that").
                  // Rebuilds the Solana LP tab with the EXACT EVM structure — hero 3-card, LP Quick
                  // Read chips, Scan Mode/Evidence Confidence chips, Good Signs/Risk Signs/Missing
                  // Proofs — using only fields solanaTokenScannerBeta.ts already returns. No new
                  // evidence is invented: "Locked"/"Burned"/"Verified" are never used because
                  // Solana has no ERC-20 LP-token lock/burn concept — every value below maps to a
                  // real read (liquidity, authority, unsupportedChecks) or an honest "Open Check".
                  const liq = sr.marketData?.liquidityUsd ?? null
                  const hasPool = sr.marketData != null

                  // POOL-AUTHORITY-ENGINE, DISCLOSED (Solana-native intelligence follow-up:
                  // "replace Open Check with a real authority verification engine"). This is the
                  // safely-real piece of that ask: sr.poolProgram.verdict is computed purely from
                  // an on-chain-verified program-owner read (see poolAnalyzer.ts). It genuinely
                  // differentiates "program identity confirmed" from "unrecognized"/"unverified"
                  // — but it does NOT claim vault-authority, PDA immutability, or withdrawal
                  // safety, which would require binary account-layout parsing this codebase
                  // cannot safely verify without live testing. The description text says exactly
                  // that, so this can never be misread as a safety guarantee.
                  const poolAuthorityLabel = sr.poolProgram.verdict === 'verified_official_pool' ? 'Verified Official Pool'
                    : sr.poolProgram.verdict === 'unrecognized_program' ? 'Unrecognized Program'
                    : 'Unverified'
                  const poolAuthorityColor = sr.poolProgram.verdict === 'verified_official_pool' ? '#34d399'
                    : sr.poolProgram.verdict === 'unrecognized_program' ? '#fb923c'
                    : '#94a3b8'

                  // LP Status hero: Solana pools have no lock/burn proof to check, so the honest
                  // status is whether a real pool was even found — never "Locked"/"Burned". Now
                  // reflects the real pool-authority verdict instead of a flat "Open Check".
                  const lpStatusInfo = !hasPool
                    ? { label: 'No Pool Found', color: '#94a3b8', description: 'No indexed Solana pool was found for this mint — liquidity evidence is unavailable.' }
                    : sr.poolProgram.verdict === 'verified_official_pool'
                      ? { label: `Pool Found — ${poolAuthorityLabel}`, color: poolAuthorityColor, description: `On-chain confirmed as ${sr.poolProgram.label}. This verifies pool program identity, not vault authority or withdrawal safety — ERC-20-style LP lock/burn proof still does not apply.` }
                      : { label: `Pool Found — ${poolAuthorityLabel}`, color: poolAuthorityColor, description: 'An indexed Solana pool exists, but its owning program could not be confirmed against known AMM programs — treat authority as unverified, not safe.' }

                  // Exit Risk hero: same liquidity-depth thresholds scoreSolanaBeta already uses
                  // (>=50k / >=5k / <5k), so this label never contradicts the Risk Engine tab.
                  // PLACEHOLDER-WORDING, DISCLOSED (reported: "a lot of it is open check and not
                  // actual facts"): these two branches are genuine non-results — there is no pool,
                  // or its depth did not resolve. They now SAY that specifically instead of
                  // labelling both with the same "Open Check" jargon, which read as a rating.
                  const exitRiskInfo = !hasPool
                    ? { label: 'No Pool Data', color: '#94a3b8', description: 'No indexed pool was found, so exit risk cannot be rated from anything real.' }
                    : liq == null
                      ? { label: 'Depth Unknown', color: '#94a3b8', description: 'A pool was found, but its liquidity depth did not resolve this scan — exit risk is unrated, not low.' }
                      : liq < 5_000
                        ? { label: 'Elevated', color: '#f87171', description: `Thin liquidity (${fmtLarge(liq)}) — a small sell can move price sharply.` }
                        : liq < 50_000
                          ? { label: 'Monitor', color: '#fbbf24', description: `Liquidity is moderate (${fmtLarge(liq)}) — watch for withdrawal.` }
                          : { label: 'Low', color: '#34d399', description: `Liquidity is deep (${fmtLarge(liq)}) relative to typical Solana pools.` }

                  // POOL-PROGRAM-VERIFICATION, DISCLOSED (LP Safety follow-up: "fix LP Safety" —
                  // this is the safe, real piece of that fix). sr.poolProgram.label is a real,
                  // on-chain-verified program identity (getAccountInfo owner vs. a small known-AMM
                  // map) — strictly stronger evidence than DexScreener's dexId string, which is
                  // market-data metadata, not a program read. Falls back to the DexScreener label
                  // (still real data, just unverified) when the program isn't recognized or the
                  // read failed — never silently upgrades an unverified label to "verified".
                  const dexLabel = sr.marketData?.primaryDexLabel ? `${sr.marketData.primaryDexLabel} AMM` : 'Solana AMM'
                  const modelLabel = sr.poolProgram.label ?? dexLabel
                  const modelVerified = sr.poolProgram.label != null
                  const modelInfo = {
                    label: modelLabel, color: '#c084fc',
                    description: modelVerified
                      ? 'On-chain verified pool program — not a standard ERC-20 LP-token model, so lock/burn proof does not apply.'
                      : 'Solana AMM pool liquidity (unverified — from market-data metadata, not a confirmed program read). Not a standard ERC-20 LP-token model, so lock/burn proof does not apply.',
                  }

                  const quickRead: Array<{ label: string; value: string; color?: string }> = [
                    { label: 'LP Model', value: modelLabel + (modelVerified ? ' ✓' : ''), color: '#c084fc' },
                    { label: 'Lock/Burn Proof', value: 'Not Applicable', color: '#94a3b8' },
                    { label: 'Pool Authority', value: poolAuthorityLabel, color: poolAuthorityColor },
                    { label: 'Exit Risk', value: exitRiskInfo.label, color: exitRiskInfo.color },
                    { label: 'Liquidity Depth', value: liq != null ? fmtLarge(liq) : 'Did not load', color: liq != null ? '#67e8f9' : '#94a3b8' },
                    { label: 'Primary Pool', value: sr.marketData?.primaryPoolAddress ? shorten(sr.marketData.primaryPoolAddress) : 'Did not load' },
                  ]

                  const detailRows: Array<{ label: string; value: string; color?: string; note?: string }> = [
                    { label: 'Primary Liquidity', value: modelLabel, color: '#c084fc', note: modelInfo.description },
                    {
                      label: 'Pool Program',
                      value: modelVerified ? 'On-Chain Verified' : sr.poolProgram.resolved ? 'Unrecognized Program' : 'Unverified',
                      color: modelVerified ? '#34d399' : '#fbbf24',
                      note: modelVerified
                        ? `Pool account owner confirmed as ${modelLabel} via getAccountInfo.`
                        : sr.poolProgram.resolved && sr.poolProgram.owner
                          ? `Pool owner ${shorten(sr.poolProgram.owner)} is not one of the AMM programs this codebase recognizes yet.`
                          : 'Pool program identity could not be read on-chain — falling back to unverified market-data metadata.',
                    },
                    {
                      label: 'Pool Authority',
                      value: poolAuthorityLabel,
                      color: poolAuthorityColor,
                      note: sr.poolProgram.verdict === 'verified_official_pool'
                        ? 'Program identity is on-chain confirmed. Vault authority and withdrawal-safety verification are not supported yet — treat as unverified, not safe.'
                        : 'Solana pool/vault authority verification is not supported yet — treat as unverified, not safe.',
                    },
                    ...(sr.poolProgram.migratedFromPumpFun ? [{
                      label: 'Migration Status', value: 'Migrated from Pump.fun', color: '#34d399',
                      note: 'PumpSwap is exclusively Pump.fun’s post-graduation AMM — this pool resolving to PumpSwap confirms the token graduated off the bonding curve.',
                    }] : []),
                    { label: 'Lock/Burn Proof', value: 'Not Applicable', note: 'ERC-20 LP-token lock/burn proof does not apply to Solana AMM pools.' },
                    { label: 'Exit Risk', value: exitRiskInfo.label, color: exitRiskInfo.color, note: exitRiskInfo.description },
                    { label: 'Liquidity Depth', value: liq != null ? fmtLarge(liq) : 'Did not load', note: sr.marketData?.volume24hUsd != null ? `24h volume ${fmtLarge(sr.marketData.volume24hUsd)} across indexed Solana pairs.` : 'Liquidity depth did not resolve this scan.' },
                    { label: 'Primary Pool', value: sr.marketData?.primaryDexLabel ?? 'Did not load', note: sr.marketData?.primaryPoolAddress ?? 'No pool was indexed for this mint this scan.' },
                    { label: 'Top-Account Concentration', value: conc?.top10Percent != null ? `Top 10 hold ${conc.top10Percent.toFixed(1)}%` : 'Did not load', note: 'Reflects top token ACCOUNTS (max 20), not a full holder count — pool vaults are included.' },
                  ]

                  const goodSigns = [
                    sr.authorityReadSucceeded && !sr.mintAuthority ? 'Mint authority is revoked — supply cannot be increased.' : '',
                    sr.authorityReadSucceeded && !sr.freezeAuthority ? 'Freeze authority is revoked — token accounts cannot be frozen.' : '',
                    hasPool ? `Indexed Solana pool found${sr.marketData?.primaryDexLabel ? ` on ${sr.marketData.primaryDexLabel}` : ''}.` : '',
                    liq != null && liq >= 50_000 ? `Liquidity is deep (${fmtLarge(liq)}).` : '',
                  ].filter(Boolean)
                  const riskSigns = [
                    sr.authorityReadSucceeded && sr.mintAuthority ? 'Mint authority is still active — supply can be increased.' : '',
                    sr.authorityReadSucceeded && sr.freezeAuthority ? 'Freeze authority is still active — token accounts can be frozen.' : '',
                    !hasPool ? 'No indexed Solana pool found — token may be unlaunched or illiquid.' : '',
                    liq != null && liq < 5_000 ? `Liquidity is thin (${fmtLarge(liq)}).` : '',
                    !sr.authorityReadSucceeded ? 'Mint/freeze authority could not be read — treat as unknown, not safe.' : '',
                  ].filter(Boolean)
                  const missingProofs = sr.unsupportedChecks.map((u) => `${u.check} — ${u.reason}`)

                  return (
                    <>
                      <div style={{ marginBottom: '18px' }}>
                        <p style={{ margin: '0 0 3px', fontSize: '13px', fontWeight: 800, letterSpacing: '0.10em', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>LP SAFETY ANALYZER · SOLANA</p>
                        <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Solana pool liquidity and authority evidence — not an EVM-style LP lock/burn proof.</p>
                      </div>

                      {/* ── 3-card hero: LP Status · Exit Risk · Primary Liquidity Model — SAME markup as EVM ── */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '12px', marginBottom: '16px', alignItems: 'stretch' }}>
                        <div style={{ padding: '16px 18px', background: 'rgba(10,18,32,0.62)', border: `1px solid ${lpStatusInfo.color}28`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>LP Status</div>
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: lpStatusInfo.color, flexShrink: 0, boxShadow: `0 0 8px ${lpStatusInfo.color}`, marginTop: '6px' }} />
                            <span style={{ minWidth: 0, fontSize: '16px', fontWeight: 800, color: lpStatusInfo.color, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.03em', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{lpStatusInfo.label}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6, overflowWrap: 'anywhere' }}>{lpStatusInfo.description}</p>
                        </div>
                        <div style={{ padding: '16px 18px', background: 'rgba(10,18,32,0.62)', border: `1px solid ${exitRiskInfo.color}28`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>Exit Risk</div>
                          <div style={{ marginBottom: '8px' }}>
                            <span style={{ padding: '4px 13px', borderRadius: '999px', background: `${exitRiskInfo.color}14`, border: `1px solid ${exitRiskInfo.color}45`, color: exitRiskInfo.color, fontSize: '14px', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.05em' }}>{exitRiskInfo.label}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{exitRiskInfo.description}</p>
                        </div>
                        <div style={{ padding: '16px 18px', background: 'rgba(10,18,32,0.62)', border: `1px solid ${modelInfo.color}28`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>Primary Liquidity Model</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: modelInfo.color, flexShrink: 0, boxShadow: `0 0 8px ${modelInfo.color}` }} />
                            <span style={{ minWidth: 0, fontSize: '16px', fontWeight: 800, color: modelInfo.color, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.03em', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{modelInfo.label}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{modelInfo.description}</p>
                        </div>
                      </div>

                      {/* ── LP Quick Read chips — same footprint as EVM's ── */}
                      <div style={{ marginBottom: '12px', padding: '14px 16px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.16)', borderRadius: '14px' }}>
                        <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 800, letterSpacing: '.16em', color: '#34d399', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>LP Quick Read</p>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '8px' }}>
                          {quickRead.map(({ label, value, color }) => (
                            <div key={label} style={{ padding: '8px 10px', borderRadius: '9px', background: 'rgba(10,18,32,0.55)', border: '1px solid rgba(255,255,255,0.06)' }}>
                              <div style={{ fontSize: '9px', color: '#5b7590', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>{label}</div>
                              <div style={{ fontSize: '11px', fontWeight: 700, color: color ?? '#cbd5e1', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.35, overflowWrap: 'anywhere' }}>{value}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* ── Detailed LP Evidence — collapsed by default, same <details> pattern ── */}
                      <details style={{ marginBottom: '14px' }}>
                        <summary className="detail-summary" style={{ cursor: 'pointer', listStyle: 'none', fontSize: '10px', letterSpacing: '.12em', color: '#5b7590', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, padding: '9px 14px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.14)', background: 'rgba(8,14,28,0.50)', display: 'flex', alignItems: 'center', gap: '8px' }}><span className="detail-chevron" aria-hidden="true" style={{ display: 'inline-block', fontSize: '9px' }}>▶</span>DETAILED LP EVIDENCE</summary>
                        <div style={{ marginTop: '10px', padding: '6px 16px', background: 'rgba(8,14,28,0.55)', border: '1px solid rgba(148,163,184,0.10)', borderRadius: '12px' }}>
                          {detailRows.map(({ label, value, color, note }, i) => (
                            <div key={label} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '14px', alignItems: 'start', padding: '11px 2px', borderBottom: i < detailRows.length - 1 ? '1px solid rgba(148,163,184,.07)' : 'none' }}>
                              <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', letterSpacing: '.08em', paddingTop: '1px' }}>{label}</span>
                              <span style={{ fontSize: '11.5px', color: color ?? '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{value}{note && <span style={{ display: 'block', marginTop: '4px', color: '#7c8aa0', fontWeight: 500, lineHeight: 1.55 }}>{note}</span>}</span>
                            </div>
                          ))}
                        </div>
                      </details>

                      {/* ── Scan Mode / Evidence Confidence chips — same style as EVM ── */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
                        <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>
                          SCAN MODE: SOLANA
                        </span>
                        <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${sr.betaRisk.confidence === 'MEDIUM' ? '#fbbf2440' : '#fb923c40'}`, fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: sr.betaRisk.confidence === 'MEDIUM' ? '#fbbf24' : '#fb923c', fontFamily: 'var(--font-plex-mono)' }}>
                          EVIDENCE CONFIDENCE: {sr.betaRisk.confidence}
                        </span>
                        {!hasPool && (
                          <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#fb923c', fontFamily: 'var(--font-plex-mono)' }}>
                            POOL: NOT FOUND
                          </span>
                        )}
                      </div>

                      {/* ── Good Signs / Risk Signs / Missing Proofs — same 3-col layout as EVM ── */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '8px', marginBottom: '14px' }}>
                        <div style={{ padding: '12px 14px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#34d399', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Good Signs</p>
                          {goodSigns.length > 0 ? goodSigns.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '5px' }}>
                              <span style={{ color: '#34d399', flexShrink: 0, fontWeight: 800, fontSize: '11px', lineHeight: '16px' }}>✓</span>
                              <p style={{ margin: 0, fontSize: '11px', color: '#86efac', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                            </div>
                          )) : <p style={{ margin: 0, fontSize: '11px', color: '#2a4438', fontFamily: 'var(--font-plex-mono)' }}>No confirmed signal in this category.</p>}
                        </div>
                        <div style={{ padding: '12px 14px', background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#f87171', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Risk Signs</p>
                          {riskSigns.length > 0 ? riskSigns.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '5px' }}>
                              <span style={{ color: '#f87171', flexShrink: 0, fontWeight: 800, fontSize: '11px', lineHeight: '16px' }}>!</span>
                              <p style={{ margin: 0, fontSize: '11px', color: '#fca5a5', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                            </div>
                          )) : <p style={{ margin: 0, fontSize: '11px', color: '#3a2020', fontFamily: 'var(--font-plex-mono)' }}>No confirmed risk signals in this pass.</p>}
                        </div>
                        <div style={{ padding: '12px 14px', background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Missing Proofs</p>
                          {missingProofs.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '5px' }}>
                              <span style={{ color: '#fbbf24', flexShrink: 0, fontWeight: 800, fontSize: '11px', lineHeight: '16px' }}>—</span>
                              <p style={{ margin: 0, fontSize: '11px', color: '#fde68a', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* ── Next Action ── */}
                      <div style={{ marginBottom: '20px', padding: '14px 18px', background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.20)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 7px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Next Action</p>
                        <p style={{ margin: 0, fontSize: '11px', color: '#67e8f9', lineHeight: 1.7, fontFamily: 'var(--font-plex-mono)' }}>Review pool depth, authority status, top-account concentration, and liquidity movement before treating this pool as safe.</p>
                      </div>
                    </>
                  )
                })()}

                {/* ── Risk Engine ─────────────────────────────────────── */}
                {activeSection === 'risk-engine' && (() => {
                  // SOLANA CORTEX RISK ENGINE, DISCLOSED (institutional-grade upgrade task):
                  // a reasoning engine, not a card list — per-module confidence, a weighted
                  // explainable score breakdown, provider-attributed factors, a composed
                  // reasoning paragraph, and a real evidence-coverage/summary readout. See
                  // lib/solanaCortexRisk.ts's own header for the full honesty contract and the
                  // two disclosed deviations from the literal spec (Behaviour always scores 0,
                  // most "Deep Scan" items are marked unsupported, not available).
                  const cx = computeSolanaCortexRisk(sr)
                  const confColor = (c: typeof cx.overallConfidence) => c === 'High' ? '#34d399' : c === 'Medium' ? '#fbbf24' : c === 'Low' ? '#fb923c' : '#64748b'
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      {/* Hero — gauge + 5-tier verdict + overall (weighted-aggregate) confidence. */}
                      <div style={{ padding: '22px 24px', background: 'linear-gradient(160deg,rgba(8,16,32,.98),rgba(4,8,18,.95))', border: `1px solid ${cx.verdictColor}35`, borderRadius: '20px', boxShadow: `0 0 44px ${cx.verdictColor}0c` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '28px', flexWrap: 'wrap' }}>
                          <div style={{ flexShrink: 0 }}>
                            <RiskGaugeCircle score={cx.score} color={cx.verdictColor} />
                          </div>
                          <div style={{ flex: 1, minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '11px' }}>
                            <div style={{ fontSize: '9px', letterSpacing: '.18em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>SOLANA CORTEX RISK ENGINE · INVESTMENT RISK</div>
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                              <span style={{ padding: '5px 14px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, letterSpacing: '.10em', color: cx.verdictColor, background: `${cx.verdictColor}14`, border: `1px solid ${cx.verdictColor}44`, fontFamily: 'var(--font-plex-mono)' }}>{cx.verdict}</span>
                              <span style={{ padding: '5px 14px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, letterSpacing: '.10em', color: confColor(cx.overallConfidence), background: `${confColor(cx.overallConfidence)}14`, border: `1px solid ${confColor(cx.overallConfidence)}44`, fontFamily: 'var(--font-plex-mono)' }}>{cx.overallConfidence.toUpperCase()} OVERALL CONFIDENCE</span>
                            </div>
                            {/* REASONING ENGINE, DISCLOSED: composed from conditional branches over
                                this scan's real evidence — see composeReasoning in
                                lib/solanaCortexRisk.ts. Not an LLM call, not a fixed template. */}
                            <p style={{ margin: 0, fontSize: '11.5px', color: '#9db3c8', lineHeight: 1.65, fontFamily: 'var(--font-plex-mono)' }}>{cx.reasoning}</p>
                          </div>
                        </div>
                      </div>

                      {/* SECURITY vs INVESTMENT RISK, DISCLOSED: two independently computed reads —
                          securityRead comes ONLY from Contract Security + Supply Control (can this
                          contract be manipulated at the protocol level), while the hero verdict above
                          is the full 9-category composite, capped by token age / evidence depth /
                          creator verification. A token can score cleanly here while still reading as
                          Speculative or worse above — that gap IS the signal: clean code, unproven
                          track record. See lib/solanaCortexRisk.ts's own header for the full rationale. */}
                      <div style={{ padding: '14px 18px', borderRadius: '14px', background: `linear-gradient(160deg, ${cx.securityRead.verdictColor}10, rgba(6,10,20,0.7))`, border: `1px solid ${cx.securityRead.verdictColor}30`, display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                        <div>
                          <p style={{ margin: '0 0 5px', fontSize: '9px', letterSpacing: '.16em', color: '#5b7590', fontFamily: 'var(--font-plex-mono)' }}>CONTRACT SECURITY (Mint/Freeze Authority + Token-2022 Extensions Only)</p>
                          <span style={{ padding: '4px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, letterSpacing: '.08em', color: cx.securityRead.verdictColor, background: `${cx.securityRead.verdictColor}18`, border: `1px solid ${cx.securityRead.verdictColor}44`, fontFamily: 'var(--font-plex-mono)' }}>{cx.securityRead.verdict}</span>
                          <span style={{ marginLeft: '8px', fontSize: '11px', color: '#8ea0b5', fontFamily: 'var(--font-plex-mono)' }}>{cx.securityRead.score}/{cx.securityRead.scoreMax} ({cx.securityRead.percent}%)</span>
                        </div>
                        {cx.verdict !== cx.securityRead.verdict && (
                          <p style={{ margin: 0, fontSize: '10.5px', color: '#7c8aa0', lineHeight: 1.5, flex: 1, minWidth: '220px' }}>Contract security and overall investment risk disagree here — the contract itself reads {cx.securityRead.verdict.toLowerCase()}, but the overall verdict is {cx.verdict.toLowerCase()} once token age, evidence depth, and creator verification are weighed in.</p>
                        )}
                      </div>

                      {/* Evidence Summary — live counts, matching the requested Bloomberg-style readout. */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: '8px' }}>
                        {([
                          ['Verified Evidence', String(cx.summary.verifiedEvidence), '#34d399'],
                          ['Warning Signals', String(cx.summary.warningSignals), '#fbbf24'],
                          ['Unknown Checks', String(cx.summary.unknownChecks), '#94a3b8'],
                          ['Providers Used', String(cx.summary.providersUsed), '#67e8f9'],
                          ['Evidence Confidence', `${cx.summary.evidenceConfidencePercent}%`, '#c4b5fd'],
                        ] as const).map(([label, value, color]) => (
                          <div key={label} style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(10,18,32,0.55)', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ fontSize: '9px', color: '#5b7590', fontFamily: 'var(--font-plex-mono)', marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '16px', fontWeight: 800, color, fontFamily: 'var(--font-plex-mono)' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      {cx.providerDisagreement.detected && (
                        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(251,146,60,0.06)', border: '1px solid rgba(251,146,60,0.25)' }}>
                          <span style={{ fontSize: '11px', fontWeight: 800, color: '#fb923c', fontFamily: 'var(--font-plex-mono)' }}>PROVIDER DISAGREEMENT DETECTED — CONFIDENCE REDUCED</span>
                          <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.5 }}>{cx.providerDisagreement.detail}</p>
                        </div>
                      )}

                      {/* Module Confidence — one row per subsystem: status/confidence/provider/reason. */}
                      <div style={cardBase}>
                        <p style={{ ...cardTitle, color: '#67e8f9' }}>Module Confidence</p>
                        <div style={{ display: 'grid', gap: '10px', marginTop: '4px' }}>
                          {cx.modules.map((m) => (
                            <div key={m.module} style={{ display: 'grid', gridTemplateColumns: '110px 90px 1fr auto', alignItems: 'start', gap: '10px', paddingBottom: '8px', borderBottom: '1px solid rgba(148,163,184,.07)' }}>
                              <span style={{ fontSize: '11.5px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{m.module}</span>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: confColor(m.confidence), fontFamily: 'var(--font-plex-mono)' }}>{m.confidence}</span>
                              <span style={{ fontSize: '11px', color: '#8ea0b5', lineHeight: 1.5 }}>{m.reason} <span style={{ color: '#5b7590' }}>({m.provider})</span></span>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#c4b5fd', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>{m.scoreEarned} / {m.scoreMax}</span>
                            </div>
                          ))}
                          <div style={{ display: 'grid', gridTemplateColumns: '110px 90px 1fr auto', alignItems: 'center', gap: '10px', paddingTop: '2px' }}>
                            <span style={{ fontSize: '11.5px', fontWeight: 800, color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>Total</span>
                            <span />
                            <span />
                            <span style={{ fontSize: '13px', fontWeight: 800, color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>{cx.score} / {cx.scoreMax}</span>
                          </div>
                        </div>
                      </div>

                      {/* Evidence Coverage — completed vs unavailable evidence MODULES, each with why. */}
                      <div style={{ padding: '16px 18px', background: 'rgba(103,232,249,0.04)', border: '1px solid rgba(103,232,249,0.16)', borderRadius: '14px' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px' }}>
                          <span style={{ fontSize: '9px', letterSpacing: '.14em', color: '#5b7590', fontFamily: 'var(--font-plex-mono)' }}>EVIDENCE COVERAGE</span>
                          <span style={{ fontSize: '18px', fontWeight: 800, color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>{cx.evidenceCoveragePercent}%</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '14px' }}>
                          <div>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', fontWeight: 800, letterSpacing: '.12em', color: '#34d399', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Completed</p>
                            {cx.completedEvidence.map((c) => (
                              <div key={c.label} style={{ display: 'flex', gap: '6px', marginBottom: '4px' }}>
                                <span style={{ color: '#34d399', fontSize: '11px' }}>✓</span>
                                <span style={{ fontSize: '11px', color: '#86efac', fontFamily: 'var(--font-plex-mono)' }}>{c.label}</span>
                              </div>
                            ))}
                          </div>
                          <div>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', fontWeight: 800, letterSpacing: '.12em', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Unavailable</p>
                            {cx.unavailableEvidence.map((u) => (
                              <div key={u.label} style={{ marginBottom: '6px' }}>
                                <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{u.label}</span>
                                {u.reason && <p style={{ margin: '2px 0 0', fontSize: '10.5px', color: '#7c8aa0', lineHeight: 1.5 }}>{u.reason}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Weighted evidence factors — each carries weight/confidence/source/reason,
                          split into Negative (real risk factors, never an empty "no signals"
                          placeholder — see lib/solanaCortexRisk.ts) vs Unknown (with WHY). */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: '8px' }}>
                        <div style={{ padding: '12px 14px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#34d399', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Positive Evidence</p>
                          {cx.factors.filter(f => f.kind === 'positive').map((f, i) => (
                            <div key={i} style={{ marginBottom: '7px' }}>
                              <div style={{ display: 'flex', gap: '7px', alignItems: 'baseline' }}>
                                <span style={{ color: '#34d399', flexShrink: 0, fontWeight: 800, fontSize: '11px' }}>✓</span>
                                <span style={{ fontSize: '11px', color: '#86efac', fontFamily: 'var(--font-plex-mono)', fontWeight: 700 }}>{f.label}</span>
                                <span style={{ fontSize: '10px', color: '#34d399', fontFamily: 'var(--font-plex-mono)', marginLeft: 'auto' }}>+{f.weight}</span>
                              </div>
                              <p style={{ margin: '2px 0 0 18px', fontSize: '10.5px', color: '#7c8aa0', lineHeight: 1.5 }}>{f.reason} <span style={{ color: '#4a627e' }}>· {f.confidence} · {f.source}</span></p>
                            </div>
                          ))}
                        </div>
                        <div style={{ padding: '12px 14px', background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Negative Evidence</p>
                          {cx.factors.filter(f => f.kind === 'negative').map((f, i) => (
                            <div key={i} style={{ marginBottom: '7px' }}>
                              <div style={{ display: 'flex', gap: '7px', alignItems: 'baseline' }}>
                                <span style={{ color: '#fbbf24', flexShrink: 0, fontWeight: 800, fontSize: '11px' }}>⚠</span>
                                <span style={{ fontSize: '11px', color: '#fde68a', fontFamily: 'var(--font-plex-mono)', fontWeight: 700 }}>{f.label}</span>
                                <span style={{ fontSize: '10px', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', marginLeft: 'auto' }}>{f.weight}</span>
                              </div>
                              <p style={{ margin: '2px 0 0 18px', fontSize: '10.5px', color: '#7c8aa0', lineHeight: 1.5 }}>{f.reason} <span style={{ color: '#4a627e' }}>· {f.confidence} · {f.source}</span></p>
                            </div>
                          ))}
                        </div>
                        <div style={{ padding: '12px 14px', background: 'rgba(148,163,184,0.04)', border: '1px solid rgba(148,163,184,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Unknown</p>
                          {cx.unknownFactors.map((u, i) => (
                            <div key={i} style={{ marginBottom: '7px' }}>
                              <div style={{ display: 'flex', gap: '7px' }}>
                                <span style={{ color: '#64748b', flexShrink: 0, fontWeight: 800, fontSize: '11px' }}>?</span>
                                <span style={{ fontSize: '11px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', fontWeight: 700 }}>{u.label}</span>
                              </div>
                              <p style={{ margin: '2px 0 0 18px', fontSize: '10.5px', color: '#7c8aa0', lineHeight: 1.5 }}>{u.reason}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Deep Analysis — Already Completed / Available / Unsupported, honestly split. */}
                      <div style={cardBase}>
                        <p style={{ ...cardTitle, color: '#c4b5fd' }}>Deep Analysis</p>
                        <p style={{ margin: '0 0 4px', fontSize: '9px', fontWeight: 800, letterSpacing: '.12em', color: '#34d399', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Already Completed</p>
                        <div style={{ marginBottom: '10px' }}>
                          {cx.deepAnalysisCompleted.map((label) => (
                            <div key={label} style={{ display: 'flex', gap: '7px', marginBottom: '3px' }}>
                              <span style={{ color: '#34d399', fontSize: '11px' }}>✓</span>
                              <span style={{ fontSize: '11.5px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{label}</span>
                            </div>
                          ))}
                        </div>
                        {cx.deepAnalysisAvailable.length > 0 && (
                          <>
                            <p style={{ margin: '0 0 4px', fontSize: '9px', fontWeight: 800, letterSpacing: '.12em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Deep Scan Available</p>
                            <div style={{ marginBottom: '10px' }}>
                              {cx.deepAnalysisAvailable.map((d) => (
                                <div key={d.label} style={{ marginBottom: '5px' }}>
                                  <span style={{ fontSize: '11.5px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{d.label}</span>
                                  <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#7c8aa0', lineHeight: 1.5 }}>{d.reason}</p>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                        <p style={{ margin: '0 0 4px', fontSize: '9px', fontWeight: 800, letterSpacing: '.12em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Not Yet Supported</p>
                        <div style={{ display: 'grid', gap: '6px' }}>
                          {cx.deepAnalysisUnsupported.map((d) => (
                            <div key={d.label} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                              <span style={{ flexShrink: 0, fontSize: '11px', fontWeight: 800, color: '#4a627e' }}>—</span>
                              <div>
                                <span style={{ fontSize: '11.5px', color: '#64748b', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{d.label}</span>
                                <p style={{ margin: '2px 0 0', fontSize: '10.5px', color: '#5b7590', lineHeight: 1.5 }}>{d.reason}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Next Action — generated from real gaps, never generic advice. */}
                      <div style={{ padding: '14px 18px', background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.20)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 7px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Next Action</p>
                        <div style={{ display: 'grid', gap: '5px' }}>
                          {cx.nextActions.map((a) => (
                            <p key={a} style={{ margin: 0, fontSize: '11.5px', color: '#67e8f9', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>→ {a}</p>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* ── Dev (authority / developer evidence) ─────────────── */}
                {activeSection === 'deployer-intel' && (() => {
                  // SOLANA CORTEX DEV CONTROL READ, DISCLOSED ("make the Solana Dev section work
                  // like the EVM CORTEX Dev Control Read" follow-up). Mirrors the EVM Dev Control
                  // hero/tab structure exactly (score hero, 4-stat row, Dev Map/Supply Control/
                  // Cluster Map/History/Watch Plan tabs) — but every value is Solana-native real
                  // evidence, never the EVM feature's data reused. Two tabs (Cluster Map, and the
                  // "linked wallets" node/list) are honestly marked "Not yet supported": Solana
                  // has no wallet-clustering or transfer-pattern data source wired anywhere in
                  // this codebase, and fabricating a wallet list (the way EVM's "3 mapped" comes
                  // from real transfer-graph evidence) would be exactly the kind of invented data
                  // this engine's honesty contract forbids.
                  const dc = sr.deepCreator?.creatorTrace ?? null
                  const creatorResolved = !!(dc?.success && dc.resolved.likelyCreatorWallet)
                  const mintRevoked = sr.authorityReadSucceeded && !sr.mintAuthority
                  const freezeRevoked = sr.authorityReadSucceeded && !sr.freezeAuthority
                  // Real, explainable composite — see developerScoreAnalyzer.ts. Each component
                  // (creator confidence / authority safety / supply safety / cluster confidence /
                  // pattern safety) is rendered with its own reason in the Watch Plan tab below.
                  const devScore = sr.developerScore.score
                  const devVerdict = devScore >= 80 ? 'LOW RISK' : devScore >= 56 ? 'WATCH' : devScore >= 35 ? 'HIGH RISK' : 'CRITICAL'
                  const devVerdictColor = devVerdict === 'LOW RISK' ? '#34d399' : devVerdict === 'WATCH' ? '#fbbf24' : devVerdict === 'HIGH RISK' ? '#fb923c' : '#f87171'
                  const devConfidence = sr.authorityReadSucceeded && creatorResolved ? 'HIGH' : sr.authorityReadSucceeded ? 'MEDIUM' : 'LOW'
                  const cxForDev = computeSolanaCortexRisk(sr)
                  const fmtAddr = (addr: string | null | undefined) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : null
                  const originAddr = dc?.resolved.likelyCreatorWallet ?? null
                  const creatorTierColor = sr.creatorConfidence.tier === 'CONFIRMED' ? '#34d399' : sr.creatorConfidence.tier === 'LIKELY' ? '#fbbf24' : sr.creatorConfidence.tier === 'POSSIBLE' ? '#fb923c' : '#94a3b8'
                  const originChip = { label: sr.creatorConfidence.tier === 'UNKNOWN' ? 'Not run' : `${sr.creatorConfidence.tier} (${sr.creatorConfidence.confidencePercent}%)`, color: creatorTierColor, bg: `${creatorTierColor}1a`, border: `${creatorTierColor}55` }
                  const tabStyle = (active: boolean) => ({ padding: '8px 12px', borderRadius: '10px', border: active ? '1px solid rgba(125,211,252,0.45)' : '1px solid rgba(148,163,184,0.2)', background: active ? 'rgba(14,29,47,0.95)' : 'rgba(8,14,28,0.6)', color: active ? '#7dd3fc' : '#94a3b8', fontSize: '10px', letterSpacing: '.10em' as const, textTransform: 'uppercase' as const, fontWeight: 700, fontFamily: 'var(--font-plex-mono)' })
                  return (
                    <>
                      {/* Hero — same shape as EVM's CORTEX Dev Control Read: score/100, verdict,
                          confidence, progress bar. Score is a dedicated Solana-native formula
                          (authority state + Deep Creator Check resolution), not the overall
                          Cortex Risk Engine score. */}
                      <div style={{ marginBottom: '12px', padding: '18px', borderRadius: '14px', border: '1px solid rgba(125,211,252,0.22)', background: 'linear-gradient(165deg, rgba(14,24,43,0.95), rgba(8,14,26,0.95))', boxShadow: '0 10px 28px rgba(5,10,25,0.45)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '12px' }}>
                          <div>
                            <p style={{ margin: '0 0 6px', fontSize: '10px', letterSpacing: '.14em', color: '#7dd3fc', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>CORTEX Dev Control Read · Solana</p>
                            <p style={{ margin: 0, fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)' }}>Mint/freeze authority state and Deep Creator Check evidence — Solana-native dev intelligence, not an EVM deployer model.</p>
                          </div>
                          <p style={{ margin: 0, fontSize: '28px', fontWeight: 800, color: '#f8fafc', fontFamily: 'var(--font-plex-mono)' }}>{devScore}<span style={{ fontSize: '12px', color: '#64748b' }}>/100</span></p>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                          <span style={{ padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, color: devVerdictColor, background: `${devVerdictColor}1a`, border: `1px solid ${devVerdictColor}55`, fontFamily: 'var(--font-plex-mono)' }}>{devVerdict}</span>
                          <span style={{ padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, color: '#7dd3fc', border: '1px solid rgba(125,211,252,0.26)', fontFamily: 'var(--font-plex-mono)' }}>CONFIDENCE {devConfidence}</span>
                        </div>
                        <div style={{ height: '8px', borderRadius: '999px', background: 'rgba(15,23,42,0.9)', border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}><div style={{ width: `${devScore}%`, height: '100%', background: 'linear-gradient(90deg, #2dd4bf, #7dd3fc)' }} /></div>
                      </div>

                      {/* Stat row — Deployer/Linked Wallets/Supply Control/Patterns, matching EVM's
                          layout. Linked Wallets and Patterns are honestly "Not supported" — no
                          wallet-clustering or transfer-pattern data source exists for Solana. */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '10px', marginBottom: '14px' }}>
                        {([
                          ['Deployer', creatorResolved ? 'Likely matched' : dc && !dc.success ? 'Not resolved' : 'Not run'],
                          ['Linked Wallets', sr.clusterMap ? (sr.clusterMap.evidenceCount > 0 ? `${sr.clusterMap.evidenceCount} verified` : 'None found') : 'Not run'],
                          ['Supply Control', !sr.authorityReadSucceeded ? 'Open check' : mintRevoked ? 'Revoked (fixed supply)' : 'Active (mutable supply)'],
                          ['Patterns', `${sr.patternAnalysis.patterns.filter(p => p.detected !== null).length}/${sr.patternAnalysis.patterns.length} checkable`],
                        ]).map(([k, v]) => (
                          <div key={k} style={{ padding: '12px', borderRadius: '12px', border: '1px solid rgba(148,163,184,0.2)', background: 'rgba(9,15,29,0.82)' }}>
                            <p style={{ margin: '0 0 5px', fontSize: '9px', letterSpacing: '.12em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{k}</p>
                            <p style={{ margin: 0, fontSize: '12px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{v}</p>
                          </div>
                        ))}
                      </div>

                      {/* Tabs — same five as EVM. Dev Map/Supply Control/Watch Plan/History are
                          real, Solana-native content. Cluster Map is honestly unsupported. */}
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                        {([['dev-map', 'Dev Map'], ['cluster-map', 'Cluster Map'], ['supply-control', 'Supply Intelligence'], ['history', 'History'], ['watch-plan', 'Watch Plan']] as Array<[typeof devControlTab, string]>).map(([id, label]) => (
                          <button key={id} type="button" onClick={() => setDevControlTab(id)} style={tabStyle(devControlTab === id)}>{label}</button>
                        ))}
                      </div>
                      <div style={{ border: '1px solid rgba(148,163,184,0.2)', borderRadius: '14px', padding: '14px', background: 'rgba(7,12,24,0.8)' }}>
                        {devControlTab === 'dev-map' && (
                          <div style={{ display: 'grid', gap: '16px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr auto 1fr', alignItems: 'stretch', gap: '6px' }}>
                              <div style={{ padding: '12px 14px', borderRadius: '12px', background: 'linear-gradient(145deg,rgba(14,24,43,.9),rgba(8,16,32,.85))', border: '1px solid rgba(125,211,252,.28)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#7dd3fc', flexShrink: 0 }} />
                                  <span style={{ fontSize: '9px', letterSpacing: '.14em', color: '#7dd3fc', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>TOKEN CONTRACT</span>
                                </div>
                                <span title={sr.mintAddress} style={{ fontSize: '10px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)', background: 'rgba(125,211,252,.08)', border: '1px solid rgba(125,211,252,.18)', borderRadius: '6px', padding: '3px 7px' }}>{fmtAddr(sr.mintAddress)}</span>
                                <span style={{ fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>SOLANA mainnet</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: '6px' }}><span style={{ color: '#2dd4bf', fontSize: '14px', lineHeight: 1 }}>→</span></div>
                              <div style={{ padding: '12px 14px', borderRadius: '12px', background: 'linear-gradient(145deg,rgba(30,20,10,.85),rgba(18,14,6,.9))', border: `1px solid ${originAddr ? 'rgba(251,191,36,.32)' : 'rgba(148,163,184,.18)'}`, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: originAddr ? '#fbbf24' : '#475569', flexShrink: 0 }} />
                                  <span style={{ fontSize: '9px', letterSpacing: '.14em', color: originAddr ? '#fbbf24' : '#64748b', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>ORIGIN WALLET</span>
                                </div>
                                {originAddr ? (
                                  <span title={originAddr} style={{ fontSize: '10px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.18)', borderRadius: '6px', padding: '3px 7px' }}>{fmtAddr(originAddr)}</span>
                                ) : (
                                  <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{dc ? 'Not resolved' : 'Deep Creator Check not run'}</span>
                                )}
                                <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '8.5px', fontWeight: 700, color: originChip.color, background: originChip.bg, border: `1px solid ${originChip.border}`, width: 'fit-content' }}>{originChip.label}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: '6px' }}><span style={{ color: '#2dd4bf', fontSize: '14px', lineHeight: 1 }}>→</span></div>
                              <div style={{ padding: '12px 14px', borderRadius: '12px', background: 'linear-gradient(145deg,rgba(9,15,29,.9),rgba(6,10,20,.85))', border: '1px solid rgba(148,163,184,.18)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#475569', flexShrink: 0 }} />
                                  <span style={{ fontSize: '9px', letterSpacing: '.14em', color: '#64748b', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>LINKED WALLETS</span>
                                </div>
                                {sr.clusterMap && sr.clusterMap.fundingPath.length > 0 ? (
                                  <span title={sr.clusterMap.fundingPath[0]} style={{ fontSize: '10px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)', background: 'rgba(45,212,191,.08)', border: '1px solid rgba(45,212,191,.18)', borderRadius: '6px', padding: '3px 7px' }}>{fmtAddr(sr.clusterMap.fundingPath[0])}</span>
                                ) : (
                                  <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{sr.clusterMap ? 'No verified wallet relationships found' : 'Deep Cluster Check not run'}</span>
                                )}
                                <span style={{ fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>{sr.clusterMap ? `${sr.clusterMap.evidenceCount} verified relationship(s)` : 'Run Deep Cluster Check from the Cluster Map tab'}</span>
                              </div>
                            </div>

                            {/* Likely Deployer evidence card — same 4-field layout as EVM
                                (Address/Detection Confidence/Evidence Source/Network), sourced
                                entirely from the real Deep Creator Check result. */}
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                                <span style={{ fontSize: '10px', letterSpacing: '.14em', color: originAddr ? '#fbbf24' : '#64748b', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>LIKELY DEPLOYER</span>
                                <span style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, color: originChip.color, background: originChip.bg, border: `1px solid ${originChip.border}` }}>{originChip.label}</span>
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '10px' }}>
                                {([
                                  ['Address', originAddr ? fmtAddr(originAddr) : 'Not resolved'],
                                  ['Detection Confidence', `${sr.creatorConfidence.tier} (${sr.creatorConfidence.confidencePercent}%)`],
                                  ['Evidence Source', sr.creatorConfidence.reason],
                                  ['Network', 'SOLANA'],
                                ]).map(([k, v]) => (
                                  <div key={k} style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(9,15,29,0.7)' }}>
                                    <p style={{ margin: '0 0 4px', fontSize: '9px', letterSpacing: '.10em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{k}</p>
                                    <p style={{ margin: 0, fontSize: '11px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', lineHeight: 1.4 }}>{v}</p>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* DEEP MODE, DISCLOSED ("do Helius Enhanced" follow-up): the ONLY UI
                                trigger for Helius Enhanced Transactions anywhere in this engine.
                                Never runs on page load or on a normal scan — only on this click. */}
                            {!sr.deepCreator ? (
                              <div style={{ padding: '13px 15px', borderRadius: '11px', border: '1px dashed rgba(167,139,250,0.30)', background: 'rgba(167,139,250,0.03)' }}>
                                <p style={{ margin: '0 0 8px', fontSize: '11px', color: '#8ea0b5', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>Resolves a likely creator wallet by tracing this mint&apos;s earliest transaction via Helius Enhanced Transactions — a paid, more expensive lookup, not run by default.</p>
                                <button
                                  type="button"
                                  onClick={() => { void runSolanaDeepCreatorCheck() }}
                                  disabled={solanaDeepLoading}
                                  style={{ padding: '8px 16px', borderRadius: '10px', border: '1px solid rgba(167,139,250,0.45)', background: solanaDeepLoading ? 'rgba(167,139,250,0.08)' : 'linear-gradient(135deg,rgba(167,139,250,0.20),rgba(96,165,250,0.14))', color: '#e9d5ff', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', fontFamily: 'var(--font-plex-mono)', cursor: solanaDeepLoading ? 'default' : 'pointer' }}
                                >
                                  {solanaDeepLoading ? 'RUNNING DEEP CHECK…' : 'RUN DEEP CREATOR CHECK →'}
                                </button>
                                {solanaDeepError && <p style={{ margin: '10px 0 0', fontSize: '11px', color: '#f87171' }}>{solanaDeepError}</p>}
                              </div>
                            ) : dc && !dc.success && (
                              <p style={{ margin: 0, fontSize: '11px', color: '#8ea0b5', fontFamily: 'var(--font-plex-mono)' }}>Deep Creator Check ran but did not resolve a likely creator wallet — open check.</p>
                            )}

                            {sr.clusterMap ? (
                              <div style={{ padding: '13px 15px', borderRadius: '11px', background: 'rgba(45,212,191,.04)', border: '1px solid rgba(45,212,191,.16)' }}>
                                <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.14em', color: '#2dd4bf', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Linked Wallet Cluster</p>
                                <p style={{ margin: 0, fontSize: '11px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{sr.clusterMap.summary}</p>
                                {sr.clusterMap.evidenceCount > 0 && <p style={{ margin: '6px 0 0', fontSize: '10px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)' }}>See the Cluster Map tab for the full relationship graph and risk read.</p>}
                              </div>
                            ) : (
                              <div style={{ padding: '13px 15px', borderRadius: '11px', background: 'rgba(148,163,184,.04)', border: '1px solid rgba(148,163,184,.14)' }}>
                                <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.14em', color: '#64748b', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Linked Wallet Cluster</p>
                                <p style={{ margin: 0, fontSize: '11px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>Not run yet — open the Cluster Map tab and run Deep Cluster Check to trace a real, evidence-backed funding path for this mint&apos;s likely creator wallet.</p>
                              </div>
                            )}
                          </div>
                        )}

                        {devControlTab === 'supply-control' && (() => {
                          // SUPPLY INTELLIGENCE, DISCLOSED (Supply Control -> Supply Intelligence
                          // redesign): conclusions FIRST, raw values SECOND — the four questions
                          // that actually matter (can supply inflate, can wallets be frozen, do
                          // Token-2022 extensions introduce risk, is tokenomics permanently fixed)
                          // answered in plain language before the underlying numbers. Every
                          // conclusion is a direct read of already-gathered evidence
                          // (supplyControlAnalyzer.ts / tokenExtensions.ts) — no new data, no
                          // fabricated verdict; "Unknown" is a real, honest answer when the
                          // authority read itself failed, never guessed either way.
                          const sc = sr.supplyControl
                          const extRisk = classifySolanaExtensionRisk(sc.extensions)
                          const freezeKnown = sr.authorityReadSucceeded
                          type Conclusion = { question: string; answer: string; verdict: 'safe' | 'risk' | 'unknown'; detail: string }
                          const conclusions: Conclusion[] = [
                            {
                              question: 'Can supply inflate?',
                              answer: sc.inflationPossible == null ? 'Unknown' : sc.inflationPossible ? 'Yes — inflatable' : 'No — fixed forever',
                              verdict: sc.inflationPossible == null ? 'unknown' : sc.inflationPossible ? 'risk' : 'safe',
                              detail: sc.inflationReason,
                            },
                            {
                              question: 'Can wallets be frozen?',
                              answer: !freezeKnown ? 'Unknown' : sr.freezeAuthority ? 'Yes — freeze authority active' : 'No — freeze authority revoked',
                              verdict: !freezeKnown ? 'unknown' : sr.freezeAuthority ? 'risk' : 'safe',
                              detail: !freezeKnown
                                ? 'Freeze authority could not be read from the Solana RPC for this mint — whether accounts can be frozen is unknown, not confirmed either way.'
                                : sr.freezeAuthority
                                  ? `Freeze authority ${sr.freezeAuthority} is still active on this mint — that wallet can freeze any holder's token account at any time.`
                                  : 'Freeze authority has been revoked (set to null) — no wallet can freeze any holder\'s token account. Verified directly from the mint account, not inferred.',
                            },
                            {
                              question: 'Do Token-2022 extensions introduce risk?',
                              answer: !sc.extensionsResolved ? (sc.tokenProgram === 'spl-token' ? 'No — classic SPL token' : 'Unknown') : extRisk.severe.length > 0 ? `Yes — ${extRisk.severe.length} severe extension${extRisk.severe.length === 1 ? '' : 's'}` : extRisk.moderate.length > 0 ? `Moderate — ${extRisk.moderate.length} extension${extRisk.moderate.length === 1 ? '' : 's'}` : 'No — none present or none risky',
                              verdict: !sc.extensionsResolved ? (sc.tokenProgram === 'spl-token' ? 'safe' : 'unknown') : extRisk.severe.length > 0 ? 'risk' : extRisk.moderate.length > 0 ? 'unknown' : 'safe',
                              detail: !sc.extensionsResolved
                                ? (sc.tokenProgram === 'spl-token' ? 'Token Program is spl-token (classic) — Token-2022 extensions do not exist on this mint.' : 'Token Program could not be identified — extension support is unknown.')
                                : extRisk.severe.length > 0
                                  ? `Severe: ${extRisk.severe.map((e) => e.label).join(', ')} — can move, block, or hide token activity without holder consent.`
                                  : extRisk.moderate.length > 0
                                    ? `Moderate: ${extRisk.moderate.map((e) => e.label).join(', ')} — changes economics or default behavior but is not a seizure vector.`
                                    : sc.extensions.length > 0
                                      ? `Present, non-risky: ${sc.extensions.map((e) => e.label).join(', ')}.`
                                      : 'Token Program is spl-token-2022, but no extensions are present on this mint — it behaves like a classic SPL token.',
                            },
                            {
                              question: 'Is tokenomics permanently fixed?',
                              answer: sc.supplyPermanentlyFixed == null ? 'Unknown' : sc.supplyPermanentlyFixed ? 'Yes — permanently fixed' : 'No — can still change',
                              verdict: sc.supplyPermanentlyFixed == null ? 'unknown' : sc.supplyPermanentlyFixed ? 'safe' : 'risk',
                              detail: sc.supplyFixedReason,
                            },
                          ]
                          const verdictColor = (v: Conclusion['verdict']) => v === 'safe' ? '#34d399' : v === 'risk' ? '#f87171' : '#94a3b8'
                          return (
                            <div style={{ display: 'grid', gap: '14px' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: '10px' }}>
                                {conclusions.map((c) => (
                                  <div key={c.question} style={{ padding: '14px 16px', borderRadius: '13px', background: `linear-gradient(160deg, ${verdictColor(c.verdict)}0e, rgba(6,10,20,0.75))`, border: `1px solid ${verdictColor(c.verdict)}35` }}>
                                    <p style={{ margin: '0 0 7px', fontSize: '10px', color: '#8ea0b5', fontFamily: 'var(--font-plex-mono)', fontWeight: 700 }}>{c.question}</p>
                                    <p style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 800, color: verdictColor(c.verdict), fontFamily: 'var(--font-plex-mono)' }}>{c.answer}</p>
                                    <p style={{ margin: 0, fontSize: '10.5px', color: '#7c8aa0', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{c.detail}</p>
                                  </div>
                                ))}
                              </div>

                              <p style={{ margin: '4px 0 0', fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Raw Evidence</p>
                              <div className="dev-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '12px' }}>
                                <StatCard label="Current Supply" value={sc.currentSupply != null ? sc.currentSupply.toLocaleString('en-US') : 'Unavailable'} accent="#5eead4" dim={sc.currentSupply == null} />
                                <StatCard label="Max Supply" value={sc.maxSupply != null ? sc.maxSupply.toLocaleString('en-US') : 'No fixed cap'} accent={sc.maxSupply != null ? '#34d399' : '#94a3b8'} dim={sc.maxSupply == null} />
                                <StatCard label="Mint Authority" value={!sr.authorityReadSucceeded ? 'Unavailable' : sr.mintAuthority ? 'Active' : 'Revoked'} accent={!sr.authorityReadSucceeded ? '#94a3b8' : sr.mintAuthority ? '#f87171' : '#34d399'} helper={sr.mintAuthority ? shorten(sr.mintAuthority) : undefined} />
                                <StatCard label="Freeze Authority" value={!sr.authorityReadSucceeded ? 'Unavailable' : sr.freezeAuthority ? 'Active' : 'Revoked'} accent={!sr.authorityReadSucceeded ? '#94a3b8' : sr.freezeAuthority ? '#f87171' : '#34d399'} helper={sr.freezeAuthority ? shorten(sr.freezeAuthority) : undefined} />
                                <StatCard label="Token Program" value={sc.tokenProgram === 'spl-token-2022' ? 'Token-2022' : sc.tokenProgram === 'spl-token' ? 'SPL Token' : 'Unavailable'} accent="#5eead4" dim />
                                <StatCard label="Future Inflation" value={sc.inflationPossible == null ? 'Unknown' : sc.inflationPossible ? 'Possible' : 'Not possible'} accent={sc.inflationPossible == null ? '#94a3b8' : sc.inflationPossible ? '#f87171' : '#34d399'} dim={sc.inflationPossible == null} />
                                <StatCard label="On-Chain Activity" value={sr.helius.called && sr.helius.success ? `${sr.helius.resolved.recentTransfers ?? 0} signatures` : 'Not available'} accent={sr.helius.called && sr.helius.success ? '#5eead4' : '#94a3b8'} dim={!(sr.helius.called && sr.helius.success)} />
                              </div>
                              <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(9,15,29,.8)', border: '1px solid rgba(148,163,184,.14)' }}>
                                <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Token-2022 Extensions (Raw)</p>
                                {sc.extensionExplanations.map((line, i) => (
                                  <p key={i} style={{ margin: i === 0 ? 0 : '6px 0 0', fontSize: '11px', color: sc.extensions.length > 0 ? '#fde68a' : '#7c8aa0', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>{line}</p>
                                ))}
                              </div>
                            </div>
                          )
                        })()}

                        {devControlTab === 'cluster-map' && (() => {
                          const cm = sr.clusterMap
                          const riskColor = cm?.riskLevel === 'elevated' ? '#fb923c' : cm?.riskLevel === 'standard' ? '#34d399' : '#94a3b8'
                          return (
                            <div style={{ display: 'grid', gap: '12px' }}>
                              {!cm ? (
                                <div style={{ padding: '13px 15px', borderRadius: '11px', border: '1px dashed rgba(45,212,191,0.30)', background: 'rgba(45,212,191,0.03)' }}>
                                  <p style={{ margin: '0 0 8px', fontSize: '11px', color: '#8ea0b5', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>Traces the mint&apos;s likely creator wallet (resolving it first via Deep Creator Check if needed), then one further hop: who first funded that wallet with SOL. Real, verified relationships only — never a fabricated wallet graph.</p>
                                  <button
                                    type="button"
                                    onClick={() => { void runSolanaDeepClusterCheck() }}
                                    disabled={solanaClusterLoading}
                                    style={{ padding: '8px 16px', borderRadius: '10px', border: '1px solid rgba(45,212,191,0.45)', background: solanaClusterLoading ? 'rgba(45,212,191,0.08)' : 'linear-gradient(135deg,rgba(45,212,191,0.20),rgba(96,165,250,0.14))', color: '#99f6e4', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', fontFamily: 'var(--font-plex-mono)', cursor: solanaClusterLoading ? 'default' : 'pointer' }}
                                  >
                                    {solanaClusterLoading ? 'RUNNING DEEP CLUSTER CHECK…' : 'RUN DEEP CLUSTER CHECK →'}
                                  </button>
                                  {solanaClusterError && <p style={{ margin: '10px 0 0', fontSize: '11px', color: '#f87171' }}>{solanaClusterError}</p>}
                                </div>
                              ) : (
                                <>
                                  <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(9,15,29,.8)', border: '1px solid rgba(148,163,184,.14)' }}>
                                    <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Summary</p>
                                    <p style={{ margin: 0, fontSize: '11px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{cm.summary}</p>
                                    {cm.riskLevel !== 'unknown' && <p style={{ margin: '8px 0 0', fontSize: '11px', color: riskColor, fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{cm.riskReason}</p>}
                                  </div>
                                  <SolanaClusterGraphPanel key={cm.nodes.map((n) => n.id).join(',')} clusterMap={cm} creatorConfidence={sr.creatorConfidence} tokenName={sr.resolvedTokenName} tokenSymbol={sr.resolvedTokenSymbol} />
                                  <p style={{ margin: 0, fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>Scope: nodes/edges come from real, verified evidence — creator + two-hop funding trace and a bounded recent-launch sample (Helius Enhanced Transactions), mint/freeze authority (Alchemy/Solana RPC), LP pool identity, and top-holder / LP-vault nodes with on-chain owner resolution (Solana RPC). A wallet appearing in multiple roles is merged into one node — that address-equality merge is the shared-authority discovery. Cross-mint shared-signer/shared-ATA-creation relationships, full launch history, treasury/exchange/market-maker labels, and Metaplex update authority are not attempted — verifying those would require indexing every candidate wallet&apos;s full transaction history, a wallet-labeling provider, or a Metaplex metadata-PDA derivation this codebase does not perform. See the &quot;Cannot be verified&quot; card above for each reason.</p>
                                </>
                              )}
                            </div>
                          )
                        })()}

                        {devControlTab === 'history' && (() => {
                          const tl = sr.supplyTimeline
                          return (
                            <div style={{ display: 'grid', gap: '10px' }}>
                              <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(9,15,29,.8)', border: '1px solid rgba(148,163,184,.14)' }}>
                                <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Deployer identity</p>
                                <p style={{ margin: 0, fontSize: '11px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>
                                  {creatorResolved
                                    ? `Likely creator wallet identified from the mint's earliest found transaction (fee payer${dc?.resolved.transactionSource ? `, source: ${dc.resolved.transactionSource}` : ''}) — a strong signal, not a certainty.`
                                    : dc && !dc.success
                                      ? 'Deep Creator Check ran but did not resolve a likely creator wallet.'
                                      : 'Deployer identity is an open check — run Deep Creator Check from the Dev Map tab.'}
                                </p>
                              </div>
                              {tl.events.map((ev, i) => (
                                <div key={i} style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(9,15,29,.8)', border: '1px solid rgba(148,163,184,.14)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                                    <p style={{ margin: 0, fontSize: '10.5px', color: '#7dd3fc', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{ev.label}</p>
                                    <p style={{ margin: 0, fontSize: '9.5px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>{ev.timestamp ?? ev.approxAge ?? ''}</p>
                                  </div>
                                  <p style={{ margin: '6px 0 0', fontSize: '11px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{ev.detail}</p>
                                  <p style={{ margin: '4px 0 0', fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>Source: {ev.source}</p>
                                </div>
                              ))}
                              {tl.reconstructionGaps.length > 0 && (
                                <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(148,163,184,.04)', border: '1px solid rgba(148,163,184,.14)' }}>
                                  <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#64748b', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>What can&apos;t be reconstructed</p>
                                  {tl.reconstructionGaps.map((g, i) => (
                                    <p key={i} style={{ margin: i === 0 ? 0 : '6px 0 0', fontSize: '11px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{g}</p>
                                  ))}
                                </div>
                              )}
                              <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(9,15,29,.8)', border: '1px solid rgba(148,163,184,.14)' }}>
                                <p style={{ margin: '0 0 8px', fontSize: '9px', letterSpacing: '.12em', color: '#475569', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Pattern Analysis</p>
                                {sr.patternAnalysis.patterns.map((p) => (
                                  <div key={p.key} style={{ marginBottom: '8px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                                      <p style={{ margin: 0, fontSize: '10.5px', color: p.detected === null ? '#64748b' : p.detected ? '#fb923c' : '#5eead4', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{p.label}</p>
                                      <p style={{ margin: 0, fontSize: '9.5px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>{p.detected === null ? 'UNAVAILABLE' : p.detected ? `DETECTED · ${p.confidence}` : `NOT DETECTED · ${p.confidence}`}</p>
                                    </div>
                                    <p style={{ margin: '2px 0 0', fontSize: '10px', color: '#8ea0b5', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{p.evidence}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })()}

                        {devControlTab === 'watch-plan' && (
                          <div style={{ display: 'grid', gap: '10px' }}>
                            <div style={{ padding: '13px 16px', borderRadius: '12px', background: 'rgba(125,211,252,.04)', border: '1px solid rgba(125,211,252,.2)' }}>
                              <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.14em', color: '#7dd3fc', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>CORTEX DEV SUMMARY</p>
                              <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>
                                {`Deployer ${sr.creatorConfidence.tier.toLowerCase()}${sr.creatorConfidence.tier !== 'UNKNOWN' ? ` (${sr.creatorConfidence.confidencePercent}%)` : ''}. Mint authority ${mintRevoked ? 'revoked' : 'active'}, freeze authority ${freezeRevoked ? 'revoked' : 'active'}. ${sr.clusterMap ? sr.clusterMap.summary : 'Wallet clustering not run — see Cluster Map tab.'}`}
                              </p>
                            </div>
                            <div style={{ padding: '13px 16px', borderRadius: '12px', background: 'rgba(9,15,29,.8)', border: '1px solid rgba(148,163,184,.14)' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                                <p style={{ margin: 0, fontSize: '9px', letterSpacing: '.14em', color: '#475569', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Developer Score Breakdown</p>
                                <p style={{ margin: 0, fontSize: '14px', color: '#f8fafc', fontWeight: 800, fontFamily: 'var(--font-plex-mono)' }}>{sr.developerScore.score}<span style={{ fontSize: '10px', color: '#64748b' }}>/{sr.developerScore.scaledMaxScore}</span></p>
                              </div>
                              {sr.developerScore.scaledMaxScore !== sr.developerScore.maxScore && (
                                <p style={{ margin: '0 0 8px', fontSize: '9.5px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>
                                  Scored out of {sr.developerScore.scaledMaxScore} — checks not yet run for this scan are excluded, not counted against it.
                                </p>
                              )}
                              {sr.developerScore.components.map((c, i) => (
                                <div key={i} style={{ marginTop: i === 0 ? 0 : '8px', opacity: c.skipped ? 0.55 : 1 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                                    <p style={{ margin: 0, fontSize: '10.5px', color: '#cbd5e1', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{c.label}{c.skipped ? ' (not run)' : ''}</p>
                                    <p style={{ margin: 0, fontSize: '10.5px', color: c.skipped ? '#64748b' : '#5eead4', fontFamily: 'var(--font-plex-mono)' }}>{c.skipped ? 'excluded' : `${c.points}/${c.maxPoints}`}</p>
                                  </div>
                                  <p style={{ margin: '2px 0 0', fontSize: '9.5px', color: '#7c8aa0', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{c.reason}</p>
                                </div>
                              ))}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '8px' }}>
                              <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(52,211,153,.04)', border: '1px solid rgba(52,211,153,.18)' }}>
                                <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#34d399', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>CONFIRMED SIGNALS</p>
                                {cxForDev.factors.filter(f => f.kind === 'positive').slice(0, 4).map((f, i) => (
                                  <p key={i} style={{ margin: i === 0 ? 0 : '4px 0 0', fontSize: '11px', color: '#86efac', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{f.label}</p>
                                ))}
                              </div>
                              <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(251,191,36,.04)', border: '1px solid rgba(251,191,36,.18)' }}>
                                <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#fbbf24', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>OPEN CHECKS</p>
                                {cxForDev.factors.filter(f => f.kind === 'negative').slice(0, 4).map((f, i) => (
                                  <p key={i} style={{ margin: i === 0 ? 0 : '4px 0 0', fontSize: '11px', color: '#fde68a', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{f.label}</p>
                                ))}
                              </div>
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(45,212,191,.04)', border: '1px solid rgba(45,212,191,.18)' }}>
                              <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#2dd4bf', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>NEXT ACTION</p>
                              {cxForDev.nextActions.map((a) => (
                                <p key={a} style={{ margin: 0, fontSize: '11px', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{a}</p>
                              ))}
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: '11px', background: 'rgba(45,212,191,.04)', border: '1px solid rgba(45,212,191,.18)' }}>
                              <p style={{ margin: '0 0 6px', fontSize: '9px', letterSpacing: '.12em', color: '#2dd4bf', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>WATCH PLAN</p>
                              {sr.watchPlan.length > 0 ? sr.watchPlan.map((w, i) => (
                                <div key={i} style={{ marginTop: i === 0 ? 0 : '8px' }}>
                                  <p style={{ margin: 0, fontSize: '11px', color: '#99f6e4', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{w.item}</p>
                                  <p style={{ margin: '2px 0 0', fontSize: '10.5px', color: '#7ee0c9', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{w.reason}</p>
                                </div>
                              )) : (
                                <p style={{ margin: 0, fontSize: '11px', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>No active risk signals to monitor based on available evidence.</p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      <p style={{ margin: '10px 2px 0', fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>Open verification items: Wallet cluster analysis · Transfer pattern analysis — neither is supported for Solana yet.</p>
                    </>
                  )
                })()}
              </div>
            )
          })()}

          {/* ── What this scan checks ─────────────────────────────── */}
          {!loading && !resolving && !result && !error && !solanaResult && (
            <div id="how-cortex-works" style={{ maxWidth: '820px' }}>
              <div style={{ marginBottom: '20px' }}>
                <p style={{ margin: '0 0 5px', fontSize: '18px', fontWeight: 700, color: '#e2e8f0', lineHeight: 1.35, letterSpacing: '-0.01em' }}>
                  What this scan checks
                </p>
                <p style={{ margin: 0, fontSize: '12px', color: '#334155', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.65 }}>
                  A structured pre-trade intelligence pass with no fake values and no simulated certainty.
                </p>
              </div>

              {/* Module cards, DISCLOSED (Token Scanner UI polish task): now share the single
                  .preview-module-card class (static border, no per-item colored glow bloom, no
                  inline JS hover handlers) — the small colored dot still identifies each module,
                  just without the boxy per-card tinted background/border/shadow. */}
              {/* Intelligence-module framing, DISCLOSED (Token Scanner final polish task): each
                  card now shows a numbered index (01–04) and a thin static top accent bar instead
                  of just a dot, so the four cards read as sequential engine modules rather than
                  generic feature tiles — no new glow, both additions are static/cheap. Accent line
                  thinned to 1px and fades at both edges (explicitly requested again: "thinner/
                  sharper"), and card padding raised once more for a touch more breathing room. */}
              <div className="preview-module-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '10px', marginBottom: '30px' }}>
                {[
                  { n: '01', label: 'Market Pulse',  color: '#22d3ee', desc: 'Price, liquidity, volume, and pool depth.' },
                  { n: '02', label: 'Holder Map',    color: '#a78bfa', desc: 'Top-holder concentration and supply distribution.' },
                  { n: '03', label: 'LP Safety',     color: '#34d399', desc: 'Pool lock status, LP control, and exit risk.' },
                  { n: '04', label: 'Dev Activity',  color: '#fb923c', desc: 'Contract ownership, dev wallets, and recent activity.' },
                ].map(mod => (
                  <div key={mod.label} className="preview-module-card" style={{ position: 'relative', overflow: 'hidden' }}>
                    <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: `linear-gradient(90deg, transparent, ${mod.color}, transparent)`, opacity: 0.95 }} />
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '15px' }}>
                      <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.12em', color: mod.color, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{mod.label}</span>
                      <span style={{ fontSize: '9px', fontWeight: 700, color: 'rgba(148,163,184,0.46)', fontFamily: 'var(--font-plex-mono)' }}>{mod.n}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: '11px', color: '#bdccdf', lineHeight: 1.7 }}>{mod.desc}</p>
                  </div>
                ))}
              </div>

              {/* ── After scan, CORTEX builds ─────────────────────────
                  DISCLOSED (Token Scanner final-polish task, explicitly requested: the plain
                  full-width rows read as filler — redesigned into the same card-grid language as
                  "What this scan checks" above, so the two sections read as one deliberate system
                  instead of a feature grid followed by a bolted-on list. Still a STATIC explanation
                  of what a completed scan produces — no numbers, verdicts, addresses, or sample
                  data; the small dot is a static bullet, not a status indicator. */}
              <div>
                <p style={{ margin: '0 0 14px', fontSize: '13px', fontWeight: 700, color: '#9fb3c8', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.03em' }}>
                  After scan, CORTEX builds
                </p>
                <div className="after-scan-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '10px' }}>
                  {[
                    { label: 'Risk receipt', desc: 'Verdict, confidence, evidence gaps, and next action.', color: '#2dd4bf' },
                    { label: 'Holder + LP read', desc: 'Top-holder concentration, LP control, lock/burn status.', color: '#a78bfa' },
                    { label: 'Dev control', desc: 'Deployer evidence, ownership/admin checks, recent activity.', color: '#fb923c' },
                  ].map(row => (
                    <div key={row.label} className="after-scan-card">
                      <span aria-hidden="true" className="after-scan-dot" style={{ background: row.color, boxShadow: `0 0 6px ${row.color}66` }} />
                      <p style={{ margin: '10px 0 6px', fontSize: '12px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.01em' }}>{row.label}</p>
                      <p style={{ margin: 0, fontSize: '11px', color: '#7e93a9', lineHeight: 1.65 }}>{row.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* LOADING SKELETON FIX, DISCLOSED (audit: "between clicking Scan and the response landing,
              the page below the search card is blank — only the button text changes to SCANNING…";
              the .shimmer-line CSS class existed but was applied nowhere). Shown only while an EVM
              scan is in flight and no result/error has landed yet — same guard shape as the
              empty-state block above, so the two never render together. */}
          {loading && !result && !error && !solanaResult && chain !== 'solana' && (
            <div style={{ maxWidth: 'none', width: '100%', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ padding: '18px', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,.6)', display: 'flex', alignItems: 'center', gap: '14px' }}>
                <div className="shimmer-line" style={{ width: '46px', height: '46px', borderRadius: '50%', flexShrink: 0 }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div className="shimmer-line" style={{ width: '38%', height: '13px' }} />
                  <div className="shimmer-line" style={{ width: '58%', height: '10px' }} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                {[0, 1, 2, 3].map(i => (
                  <div key={i} style={{ padding: '14px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,.6)', display: 'flex', flexDirection: 'column', gap: '9px' }}>
                    <div className="shimmer-line" style={{ width: '50%', height: '9px' }} />
                    <div className="shimmer-line" style={{ width: '70%', height: '16px' }} />
                  </div>
                ))}
              </div>
              <div style={{ padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,.6)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div className="shimmer-line" style={{ width: '30%', height: '10px' }} />
                <div className="shimmer-line" style={{ width: '100%', height: '10px' }} />
                <div className="shimmer-line" style={{ width: '85%', height: '10px' }} />
              </div>
            </div>
          )}

          {/* Results */}
          {result && (
            <div style={{ maxWidth: 'none', width: '100%' }}>

              {/* Token identity — RECEIPT-HEADER, DISCLOSED (Token Scanner result-UI polish task):
                  same fields (name, symbol, contract, chain badge, resolved-from note) — restyled as
                  a compact receipt header (contract in its own monospace pill, chain badge moved
                  inline next to it) instead of a plain stacked h2+p, with tighter, more deliberate
                  spacing. No new data, no removed data. */}
              <div className="result-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', marginBottom: '18px', paddingBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: '21px', fontWeight: 800, color: '#f8fafc', margin: '0 0 6px', letterSpacing: '-0.01em', display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
                    {result.name ?? 'Unknown'}
                    {result.symbol && <span style={{ fontSize: '13px', fontWeight: 700, color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}>{result.symbol}</span>}
                  </h2>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {result.contract && (
                      <span style={{ fontSize: '10.5px', color: '#7c93aa', fontFamily: 'var(--font-plex-mono)', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '7px', padding: '3px 9px' }}>
                        {shorten(result.contract)}
                      </span>
                    )}
                    <span style={{ padding: '3px 10px', border: '1px solid rgba(59,130,246,.38)', borderRadius: '999px', color: '#93c5fd', fontSize: '9.5px', fontWeight: 700, letterSpacing: '.08em', fontFamily: 'var(--font-plex-mono)', background: 'rgba(59,130,246,.07)' }}>
                      {String(result.chain ?? chain).toUpperCase()}
                    </span>
                    {result.resolvedInput && result.resolvedInput.type !== 'address' && (
                      <span style={{ fontSize: '10px', color: '#5b7186', fontFamily: 'var(--font-plex-mono)' }}>Resolved from {result.resolvedInput.original.toUpperCase()}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* CORTEX Command Bar — RESULT-TABS, DISCLOSED (Token Scanner result-UI polish task,
                  explicitly requested: "tabs are too small/faded" — active tab now uses a solid
                  filled pill (not a faint tint) with a real bottom underline accent so it reads as
                  clearly selected at a glance; inactive tabs brightened for readability. Sticky
                  under the header on desktop (simple `position:sticky`, no new scroll logic). Same
                  activeSection state/onClick, same six tabs, same order — presentation only. */}
              {(() => {
                const cmds: Array<{ id: typeof activeSection; label: string }> = [
                  { id: 'cortex-read',    label: 'Overview' },
                  { id: 'market-pulse',   label: 'Market' },
                  { id: 'holder-map',     label: 'Holders' },
                  { id: 'lp-safety',      label: 'LP Safety' },
                  { id: 'risk-engine',    label: 'Risk Engine' },
                  { id: 'deployer-intel', label: 'Dev' },
                ]
                return (
                  <div className="result-tabs-wrap" style={{ marginBottom: '22px', position: 'sticky', top: 0, zIndex: 5, background: 'rgba(2,6,23,0.32)', backdropFilter: 'blur(12px)', paddingTop: '4px', paddingBottom: '0px', borderBottom: '1px solid rgba(148,180,200,.09)' }}>
                    <div className="result-tabs-scroll" style={{
                      display: 'flex', gap: '2px', overflowX: 'auto', whiteSpace: 'nowrap',
                    }}>
                      {cmds.map(s => {
                        const active = activeSection === s.id
                        return (
                          <button key={s.id} className="result-tab-btn" onClick={() => setActiveSection(s.id)}
                            style={{
                              position: 'relative',
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                              height: '38px', padding: '0 14px', borderRadius: '8px 8px 0 0', cursor: 'pointer',
                              whiteSpace: 'nowrap', flexShrink: 0,
                              fontFamily: 'var(--font-plex-mono)', fontSize: '11px',
                              fontWeight: active ? 750 : 550, letterSpacing: '0.06em',
                              transition: 'all 0.14s',
                              background: active ? 'rgba(83,243,195,0.08)' : 'transparent',
                              border: 'none',
                              color: active ? '#EFFFFA' : '#7c93aa',
                            }}
                          >
                            {s.label}
                            {active && <span aria-hidden="true" style={{ position: 'absolute', left: '10px', right: '10px', bottom: '-1px', height: '2px', borderRadius: '2px', background: 'rgba(83,243,195,0.85)', boxShadow: '0 0 8px rgba(83,243,195,0.45)' }} />}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* ── CORTEX READ ───────────────────────────────────────── */}
              {activeSection === 'cortex-read' && (() => {
                const cx = calculateCortexScoreV2(result)
                const score = cx.score
                const scoreDisplay = cx.displayScore
                const scoreForBar = score ?? 0
                const scoreColor = cx.isOpenCheck ? '#fbbf24' : scoreForBar >= 75 ? '#34d399' : scoreForBar >= 50 ? '#fbbf24' : '#f87171'
                const v = getVerdictStyle(cx.verdict)
                const confidence = cx.confidence
                const confColor = confidence === 'HIGH' ? '#34d399' : confidence === 'MEDIUM' ? '#fbbf24' : '#94a3b8'
                const holderState = deriveHolderState(result)
                const scanEvidence = scanEvidenceFor(result)
                const lpStatus = result.lpControl?.status
                const lpMode = getLpMode(result)
                const lpVerified = lpStatus === 'locked' || lpStatus === 'burned'
                const marketChipOk = (result.price != null || result.liquidity != null) && !result.noActivePools
                const holdersChipOk = holderState.kind === 'rowsWithPercent'
                const holdersChipPartial = holderState.kind === 'rowsWithoutPercent'
                const riskChipOk = result.honeypot?.isHoneypot === false && result.honeypot?.simulationSuccess === true
                const simUiOverview = tradingSimUiFor(result)
                const simUnavailable = simUiOverview.treatAsOpenRisk && simUiOverview.statusLabel !== 'Risk detected'
                const hp2 = result.honeypot
                const liq2 = result.liquidity ?? 0
                const buyTax2 = hp2?.buyTax ?? null
                const sellTax2 = hp2?.sellTax ?? null
                const taxesHigh2 = (buyTax2 != null && buyTax2 > 8) || (sellTax2 != null && sellTax2 > 8)
                const goodSigns: string[] = [
                  simUiOverview.statusLabel === 'Verified clear' ? 'Security simulation passed — no honeypot flagged.' : '',
                  liq2 > 1_000_000 ? `Deep liquidity — ${fmtLarge(liq2)} pool depth.` : liq2 > 200_000 ? `Moderate liquidity — ${fmtLarge(liq2)} pool depth.` : '',
                  holderState.kind === 'rowsWithPercent' ? 'Holder distribution confirmed with percentages.' : '',
                  result.marketCapUsd != null ? `Market cap verified — ${fmtLarge(result.marketCapUsd)}.` : '',
                  lpVerified ? `LP ${result.lpControl?.status} — exit liquidity confirmed.` : '',
                  (result.pools?.length ?? 0) > 1 ? `${result.pools!.length} active pools detected.` : '',
                ].filter(Boolean).slice(0, 4) as string[]
                const riskSigns: string[] = [
                  hp2?.isHoneypot === true ? 'HONEYPOT — sell simulation detected blocked transaction.' : '',
                  taxesHigh2 ? `Elevated taxes — buy ${buyTax2?.toFixed(1)}% / sell ${sellTax2?.toFixed(1)}%.` : '',
                  liq2 > 0 && liq2 < 10000 ? 'Very thin liquidity — extreme slippage and exit risk.' : liq2 > 0 && liq2 < 50000 ? `Thin liquidity — ${fmtLarge(liq2)} depth, slippage risk.` : '',
                  holderState.kind === 'noRowsFallback' ? 'Holder concentration not confirmed — open risk check.' : holderState.kind === 'rowsWithoutPercent' ? 'Holder wallets found but percentages not confirmed.' : '',
                  result.marketCapUsd == null ? 'Market cap not verified — supply unconfirmed.' : '',
                  simUnavailable ? `${simUiOverview.statusLabel} — ${simUiOverview.reason}` : '',
                  result.noActivePools ? `No active liquidity pool detected on ${chainDisplayName(result.chain)}.` : '',
                ].filter(Boolean).slice(0, 4) as string[]
                const missing2 = getMissingChecks(result)
                const next2 = getNextAction(result)
                const statusChips = [
                  { label: 'Market',      chipOk: marketChipOk,    chipPartial: false,              chipColor: marketChipOk ? '#34d399' : '#f87171' },
                  { label: 'Holders',     chipOk: holdersChipOk,   chipPartial: holdersChipPartial, chipColor: holdersChipOk ? '#34d399' : holdersChipPartial ? '#fbbf24' : '#f87171' },
                  { label: 'LP Control',  chipOk: lpVerified || lpMode === 'protocol', chipPartial: lpMode === 'unknown', chipColor: lpVerified || lpMode === 'protocol' ? '#34d399' : lpMode === 'unknown' ? '#fbbf24' : '#f87171' },
                  { label: 'Risk Checks', chipOk: riskChipOk,      chipPartial: simUiOverview.statusLabel === 'Risk detected',     chipColor: riskChipOk ? '#34d399' : simUiOverview.statusLabel === 'Risk detected' ? '#f87171' : '#94a3b8', chipLabel: simUiOverview.statusLabel },
                ]
                const marketStrengthLabel = result.noActivePools ? 'Open check' : (result.liquidity ?? 0) > 250000 ? 'Strong' : (result.liquidity ?? 0) > 50000 ? 'Active' : (result.liquidity ?? 0) > 0 ? 'Thin' : 'Open check'
                const holderRiskLabel = holderState.kind !== 'rowsWithPercent' ? 'Open check' : (result.holderDistribution?.top10 ?? 0) > 50 ? 'High' : (result.holderDistribution?.top10 ?? 0) > 30 ? 'Medium' : 'Low'
                const lpProofLabel = lpMode === 'protocol' ? 'Protocol-specific' : lpStatus === 'locked' || lpStatus === 'burned' ? 'Verified' : lpStatus === 'team_controlled' ? 'Wallet Controlled' : lpStatus === 'partial' ? 'Partial Evidence' : lpStatus === 'no_pool' ? 'Open check' : lpMode === 'unknown' ? 'Open check' : 'Open check'
                const securityConfidenceLabel = simUiOverview.statusLabel
                const degradedBadges = [
                  (result.lpControl?.status === 'unavailable_with_reason' || result.lpControl?.status === 'insufficient_data') ? 'LP open check' : null,
                  result.holderDistributionStatus?.status === 'unavailable_with_reason' ? 'Holders open check' : null,
                  (result.noActivePools || result.marketCapStatus === 'partial') ? 'Market data partial' : null,
                ].filter(Boolean) as string[]
                const scoreBreakdown = [
                  { label: 'LiquidityScore', value: cx.breakdown.liquidityScore.score, ok: cx.breakdown.liquidityScore.score != null, reason: cx.breakdown.liquidityScore.reason },
                  { label: 'HolderScore', value: cx.breakdown.holderScore.score, ok: cx.breakdown.holderScore.score != null, reason: cx.breakdown.holderScore.reason },
                  { label: 'SecurityScore', value: cx.breakdown.securityScore.score, ok: cx.breakdown.securityScore.score != null, reason: cx.breakdown.securityScore.reason },
                  { label: 'MarketHealthScore', value: cx.breakdown.marketHealthScore.score, ok: cx.breakdown.marketHealthScore.score != null, reason: cx.breakdown.marketHealthScore.reason },
                  { label: 'VolatilityPenalty', value: cx.breakdown.volatilityPenalty.score, ok: cx.breakdown.volatilityPenalty.score != null, reason: cx.breakdown.volatilityPenalty.reason },
                  { label: 'DevScore', value: cx.breakdown.devScore.score, ok: cx.breakdown.devScore.score != null, reason: cx.breakdown.devScore.reason },
                ]
                const goodSignals = goodSigns.length >= 2 ? goodSigns : [...goodSigns, 'No additional positive signals confirmed this scan.']
                const riskSignals = riskSigns.length >= 2 ? riskSigns : [...riskSigns, 'No additional risk signals surfaced beyond current checks.']
                const normalizedRisk = normalizeRiskScore({
                  rawScore: result.riskScore,
                  rawScoreType: result.riskScoreType ?? 'risk_score',
                  riskDrivers: result.riskEngine?.riskDrivers,
                  confidence: result.riskEngine?.confidence,
                  source: 'token_scanner',
                  displayLocation: 'overview',
                  holdersVerified: scanEvidence.holdersVerified,
                })
                const riskScoreVal = normalizedRisk.riskScore0To100
                const riskLabelColor = riskColorFromCanonicalLabel(normalizedRisk.riskLabel)
                const riskLabelDisplay = normalizedRisk.riskLabel ?? 'Unrated'
                const riskBreakdownRows: Array<{ label: string; data?: { score?: number; max?: number; reasons?: string[] } }> = [
                  { label: 'Market Maturity', data: result.riskBreakdown?.marketMaturity },
                  { label: 'Liquidity Safety', data: result.riskBreakdown?.liquiditySafety },
                  { label: 'Contract Safety', data: result.riskBreakdown?.contractSafety },
                  { label: 'Behavioral Risk', data: result.riskBreakdown?.behavioralRisk },
                ]
                const legacyCortexScore = result.cortexScore ?? score
                // LIQUIDITY-UNAVAILABLE BANNER (Robinhood scan-inconsistency audit): when the scan
                // produced no liquidity read, say so plainly with the reason — a missing section
                // must never render as silent blank space. Data comes from the response's own
                // scanAudit receipt; nothing is inferred or fabricated client-side.
                //
                // LIQUIDITY-VS-LP-PROOF WORDING FIX, DISCLOSED (Base Token Scanner state/copy
                // consistency task): the raw scanAudit warning says "Liquidity unavailable" for
                // ANY reason the resolver didn't return a liquidityUsd figure — including when
                // this scan already has real market-liquidity evidence elsewhere (a detected
                // pool, a positive liquidity read) and the actual gap is LP *proof* (lock/burn/
                // controller), not liquidity itself. Showing "Liquidity unavailable" next to a
                // verified pool read contradicts it. When that evidence exists, the same warning
                // is rephrased to name the real gap; when there truly is no liquidity evidence
                // anywhere, the original wording stands.
                const hasVerifiedLiquidityElsewhere = (result.liquidity ?? 0) > 0
                  || Boolean(result.lpControl?.poolAddressPresent)
                  || (result.pools?.length ?? 0) > 0
                const liquidityWarnings = (result.scanAudit?.responseWarnings ?? [])
                  .filter(w => /liquidity/i.test(w))
                  .map(w => {
                    const match = hasVerifiedLiquidityElsewhere ? w.match(/^Liquidity unavailable on .+?:\s*(.+)$/) : null
                    return match ? `Liquidity market data available; LP proof unavailable: ${match[1]}` : w
                  })
                return (
                  <>
                    {liquidityWarnings.length > 0 && (
                      <div style={{ marginBottom: '14px', padding: '10px 14px', borderRadius: '12px', border: '1px solid rgba(251,191,36,0.30)', background: 'rgba(251,191,36,0.06)' }}>
                        <p style={{ margin: 0, fontSize: '11px', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, letterSpacing: '.08em' }}>LIQUIDITY PARTIAL</p>
                        {liquidityWarnings.map((w, wi) => (
                          <p key={wi} style={{ margin: '4px 0 0', fontSize: '11px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{w}</p>
                        ))}
                      </div>
                    )}

                    {/* Canonical Risk Score Hero — SCORE-CARD-POLISH, DISCLOSED (Token Scanner
                        result-UI polish task): same score/label/exact numbers, tighter padding and
                        vertical rhythm (22px->18px, marginBottom 16px->14px), cleaner thinner
                        progress bar, explanatory copy unchanged in wording but sized down slightly
                        so it reads as a caption, not body text. */}
                    <div className="risk-score-hero" style={{ marginBottom: '14px', background: 'linear-gradient(160deg,rgba(8,16,32,.98),rgba(4,8,18,.96))', border: `1px solid ${riskLabelColor}32`, borderRadius: '16px', padding: '18px 22px', boxShadow: `0 0 44px ${riskLabelColor}10, 0 0 0 1px ${riskLabelColor}06 inset` }}>
                      <div style={{ fontSize: '10px', letterSpacing: '.18em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '5px' }}>RISK SCORE</div>
                      {riskScoreVal != null ? (
                        <>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
                              <span style={{ fontSize: '52px', fontWeight: 800, color: riskLabelColor, fontFamily: 'var(--font-plex-mono)', lineHeight: 1, textShadow: `0 0 24px ${riskLabelColor}38` }}>{riskScoreVal}</span>
                              <span style={{ fontSize: '16px', color: `${riskLabelColor}55`, fontFamily: 'var(--font-plex-mono)' }}>/100</span>
                            </div>
                            <span style={{ padding: '4px 14px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, letterSpacing: '0.10em', color: riskLabelColor, background: `${riskLabelColor}14`, border: `1px solid ${riskLabelColor}45`, fontFamily: 'var(--font-plex-mono)' }}>{riskLabelDisplay}</span>
                            <span style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: normalizedRisk.confidence === 'high' ? '#34d399' : normalizedRisk.confidence === 'medium' ? '#fbbf24' : '#94a3b8', background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.22)', fontFamily: 'var(--font-plex-mono)' }}>{normalizedRisk.confidence.toUpperCase()} CONFIDENCE</span>
                          </div>
                          {riskLabelCopy(normalizedRisk.riskLabel, scanEvidence) && (
                            <div style={{ fontSize: '12px', color: '#fde68a', fontFamily: 'var(--font-plex-mono)', marginTop: '10px', lineHeight: 1.5 }}>{riskLabelCopy(normalizedRisk.riskLabel, scanEvidence)}</div>
                          )}
                          <div style={{ height: '4px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginTop: '12px' }}>
                            <div style={{ height: '100%', width: `${riskGaugeFillPercent(riskScoreVal)}%`, borderRadius: '999px', background: `linear-gradient(90deg,${riskLabelColor},${riskLabelColor}80)`, transition: 'width 0.7s ease', boxShadow: `0 0 6px ${riskLabelColor}55` }} />
                          </div>
                          <div style={{ fontSize: '10px', color: '#5b7186', fontFamily: 'var(--font-plex-mono)', marginTop: '9px', lineHeight: 1.55 }}>Higher score means higher risk. Score calculated from available evidence. Missing checks reduce confidence or add caution, but do not automatically make it extreme.</div>
                        </>
                      ) : (
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', padding: '4px 0', lineHeight: 1.55 }}>
                          {result.scanAudit?.confidenceMissingReason
                            ? `Score unavailable: ${String(result.scanAudit.confidenceMissingReason).replace(/_/g, ' ')}.`
                            : 'Risk Score unavailable — the risk engine did not return a score for this scan.'}
                        </div>
                      )}
                    </div>

                    {/* Score Breakdown — Market Maturity / Liquidity Safety / Contract Safety /
                        Behavioral Risk. SCORE-BREAKDOWN-POLISH, DISCLOSED: same categories/exact
                        scores/reason tags, tighter row spacing and a cleaner shared progress-bar
                        treatment (thinner track, consistent radius) so the four rows scan quickly
                        instead of feeling like a dense stack. */}
                    {result.riskBreakdown && (
                      <div style={{ marginBottom: '16px', padding: '14px 16px', borderRadius: '12px', border: '1px solid rgba(125,211,252,0.20)', background: 'rgba(8,14,28,0.72)' }}>
                        <p style={{ margin: '0 0 4px', fontSize: '10px', letterSpacing: '.16em', color: '#7dd3fc', fontWeight: 800, fontFamily: 'var(--font-plex-mono)' }}>SAFETY EVIDENCE BREAKDOWN</p>
                        <p style={{ margin: '0 0 12px', fontSize: '9px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>These section points are safety evidence: higher is safer. They are converted once into the Risk Score above.</p>
                        <div style={{ display: 'grid', gap: '10px' }}>
                          {riskBreakdownRows.map(({ label, data }, rIdx) => {
                            const sc = data?.score ?? 0
                            const max = data?.max ?? 0
                            const pct = max > 0 ? Math.max(0, Math.min(100, (sc / max) * 100)) : 0
                            const barColor = pct >= 70 ? '#2DD4BF' : pct >= 40 ? '#fbbf24' : '#f87171'
                            const reasons = (data?.reasons ?? []).slice(0, 3)
                            {/* TRADER-STATUS-LABEL, DISCLOSED (Token Scanner readability polish
                                task, explicitly requested: "simple readable status labels beside
                                each score category... do not change score math"): label derived
                                purely from the same pct/max already used for barColor above — no
                                new data, no scoring change, just a 3-second-readable word next to
                                the exact existing sc/max numbers. */}
                            // "Open Check" here meant "this category produced no data at all" —
                            // renamed to say that plainly, per the same reported wording issue.
                            const statusLabel = !data || max <= 0 ? 'No Data' : pct >= 70 ? 'Strong' : pct >= 40 ? 'Moderate' : 'Weak'
                            return (
                              <div key={label} style={{ paddingBottom: '10px', borderBottom: rIdx < riskBreakdownRows.length - 1 ? '1px solid rgba(255,255,255,0.045)' : 'none' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px', gap: '8px' }}>
                                  <span style={{ fontSize: '11px', color: '#d3dfec', fontFamily: 'var(--font-plex-mono)', fontWeight: 650 }}>{label}</span>
                                  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '7px' }}>
                                    <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '.05em', color: barColor, background: `${barColor}14`, border: `1px solid ${barColor}38`, fontFamily: 'var(--font-plex-mono)' }}>{statusLabel}</span>
                                    <span style={{ fontSize: '11px', color: barColor, fontWeight: 800, letterSpacing: '.06em', fontFamily: 'var(--font-plex-mono)' }}>{sc}/{max}</span>
                                  </span>
                                </div>
                                <div style={{ height: '4px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: '7px' }}>
                                  <div style={{ height: '100%', width: `${pct}%`, borderRadius: '999px', background: `linear-gradient(90deg,${barColor},${barColor}80)`, transition: 'width 0.7s ease' }} />
                                </div>
                                {reasons.length > 0 && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                    {reasons.map((r, i) => (
                                      <span key={i} style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 600, color: '#a3b4c5', background: 'rgba(148,163,184,0.07)', border: '1px solid rgba(148,163,184,0.20)', fontFamily: 'var(--font-plex-mono)' }}>{translateRiskReason(r)}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* CORTEX Safety Read — explicitly named historical safety score. */}
                    <div style={{ marginBottom: '20px', padding: '12px 16px', borderRadius: '12px', border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(8,14,28,0.55)' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'baseline', marginBottom: '6px' }}>
                        <div style={{ fontSize: '9px', letterSpacing: '.16em', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>CORTEX SAFETY READ</div>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: scoreColor, fontFamily: 'var(--font-plex-mono)' }}>{legacyCortexScore != null ? `Safety Score: ${legacyCortexScore}/100` : 'Unavailable'}</div>
                        <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>Risk label: <span style={{ color: riskLabelColor, fontWeight: 700 }}>{riskLabelDisplay}</span></div>
                        <span style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: normalizedRisk.confidence === 'high' ? '#34d399' : normalizedRisk.confidence === 'medium' ? '#fbbf24' : '#94a3b8', background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.22)', fontFamily: 'var(--font-plex-mono)' }}>{normalizedRisk.confidence.toUpperCase()} CONFIDENCE</span>
                      </div>
                      {riskLabelCopy(normalizedRisk.riskLabel, scanEvidence) && (
                        <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#fde68a', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{riskLabelCopy(normalizedRisk.riskLabel, scanEvidence)}</p>
                      )}
                      <p style={{ margin: 0, fontSize: '10px', color: '#475569', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>This secondary model is explicitly a Safety Score: higher means safer. The Risk Score above is the canonical product score.</p>
                    </div>

                    {/* Advanced CORTEX Details — collapsed by default. The old large CORTEX
                        Score Hero and its breakdown live here as a secondary, opt-in view;
                        the canonical Risk Score and compact CORTEX Safety Read strip above are
                        the only scores shown by default. */}
                    <details style={{ marginBottom: '20px' }}>
                    <summary className="detail-summary" style={{ cursor: 'pointer', listStyle: 'none', fontSize: '11px', letterSpacing: '.14em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(8,14,28,0.55)', display: 'flex', alignItems: 'center', gap: '8px' }}><span className="detail-chevron" aria-hidden="true" style={{ display: 'inline-block', fontSize: '9px' }}>▶</span>ADVANCED CORTEX DETAILS</summary>
                    <div style={{ marginTop: '14px' }}>
                    <div className="cortex-score-hero" style={{ marginBottom: '20px', background: 'linear-gradient(160deg,rgba(8,16,32,.98),rgba(4,8,18,.96))', border: `1px solid ${scoreColor}32`, borderRadius: '18px', padding: '22px 24px', boxShadow: `0 0 60px ${scoreColor}12, 0 0 24px ${scoreColor}08, 0 0 0 1px ${scoreColor}06 inset` }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px', flexWrap: 'wrap', marginBottom: '18px' }}>
                        <div style={{ flexShrink: 0 }}>
                          <div style={{ fontSize: '10px', letterSpacing: '.18em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '6px' }}>CORTEX SAFETY SCORE</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
                            <span style={{ fontSize: score == null ? '38px' : '62px', fontWeight: 800, color: scoreColor, fontFamily: 'var(--font-plex-mono)', lineHeight: 1, textShadow: `0 0 28px ${scoreColor}40` }}>{scoreDisplay}</span>
                            {score != null && <span style={{ fontSize: '18px', color: `${scoreColor}55`, fontFamily: 'var(--font-plex-mono)' }}>/100</span>}
                          </div>
                          <div style={{ fontSize: '10px', color: '#475569', fontFamily: 'var(--font-plex-mono)', marginTop: '6px', letterSpacing: '.06em' }}>{cx.scanQuality} · {cx.confidence} CONF</div>
                        </div>
                        <div style={{ flex: 1, minWidth: '140px', paddingTop: '6px' }}>
                          <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '14px' }}>
                            <span style={{ padding: '5px 16px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, letterSpacing: '0.10em', color: v.color, background: v.bg, border: `1px solid ${v.border}`, fontFamily: 'var(--font-plex-mono)' }}>{v.label}</span>
                            <span style={{ padding: '5px 11px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', color: confColor, background: `${confColor}14`, border: `1px solid ${confColor}45`, fontFamily: 'var(--font-plex-mono)' }}>{confidence} CONFIDENCE</span>
                          </div>
                          <div style={{ height: '5px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${scoreForBar}%`, borderRadius: '999px', background: `linear-gradient(90deg,${scoreColor},${scoreColor}80)`, transition: 'width 0.7s ease', boxShadow: `0 0 8px ${scoreColor}60` }} />
                          </div>
                        </div>
                      </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(102px,1fr))', gap: '8px' }}>
                        {statusChips.map(({ label, chipOk, chipPartial, chipColor, chipLabel }) => (
                          <div key={label} className="cortex-chip" style={{ padding: '9px 11px', borderRadius: '10px', background: `${chipColor}0a`, border: `1px solid ${chipColor}2a`, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: chipColor, flexShrink: 0, boxShadow: `0 0 7px ${chipColor}` }} />
                            <div>
                              <div style={{ fontSize: '9px', letterSpacing: '.12em', color: chipColor, fontFamily: 'var(--font-plex-mono)', fontWeight: 700 }}>{label}</div>
                              <div style={{ fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>{chipLabel ?? (chipOk ? 'Verified' : chipPartial ? 'Partial' : 'Open check')}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '10px', marginBottom: '12px' }}>
                      {[{label:'Market Strength',value:marketStrengthLabel},{label:'Holder Risk',value:holderRiskLabel},{label:'LP Proof',value:lpProofLabel},{label:'Security Confidence',value:securityConfidenceLabel}].map((item)=>(
                        <div key={item.label} style={{ padding:'11px 12px', borderRadius:'11px', border:'1px solid rgba(148,163,184,0.18)', background:'rgba(8,14,28,0.62)' }}>
                          <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', fontFamily:'var(--font-plex-mono)', marginBottom:'5px' }}>{item.label}</div>
                          <div style={{ fontSize:'13px', fontWeight:700, color:'#e2e8f0', fontFamily:'var(--font-plex-mono)' }}>{item.value}</div>
                        </div>
                      ))}
                    </div>
                    {degradedBadges.length > 0 && (
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '0 0 14px' }}>
                        {degradedBadges.map((badge) => (
                          <span key={badge} style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.08em', fontFamily: 'var(--font-plex-mono)', color: '#fbbf24', border: '1px solid rgba(251,191,36,.45)', borderRadius: '999px', padding: '4px 9px', background: 'rgba(146,64,14,.24)' }}>{badge}</span>
                        ))}
                      </div>
                    )}
                    <div style={{ marginBottom:'20px', padding:'14px 16px', borderRadius:'12px', border:'1px solid rgba(125,211,252,0.20)', background:'rgba(8,14,28,0.72)' }}>
                      <p style={{ margin:'0 0 12px', fontSize:'10px', letterSpacing:'.16em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>CORTEX SAFETY SCORE BREAKDOWN</p>
                      <div style={{ display:'grid', gap:'0' }}>
                        {scoreBreakdown.map((b, bIdx)=>(
                          <div key={b.label} className="cortex-bdrow" style={{ display:'grid', gridTemplateColumns:'150px 74px 1fr', gap:'10px', alignItems:'center', padding:'7px 8px', borderBottom: bIdx < scoreBreakdown.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                            <span style={{ fontSize:'11px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)', fontWeight:600 }}>{b.label}</span>
                            <span style={{ fontSize:'10px', color:b.ok ? '#34d399' : '#fbbf24', fontWeight:800, letterSpacing:'.08em', fontFamily:'var(--font-plex-mono)' }}>{b.ok ? b.value : 'OPEN'}</span>
                            <span style={{ fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)' }}>{b.reason}</span>
                          </div>
                        ))}
                        <div style={{ display:'flex', alignItems:'center', gap:'8px', marginTop:'8px', padding:'7px 10px', borderRadius:'8px', background: cx.capReason ? 'rgba(148,163,184,0.05)' : 'rgba(52,211,153,0.04)', border: cx.capReason ? '1px solid rgba(148,163,184,0.14)' : '1px solid rgba(52,211,153,0.14)' }}>
                          <span style={{ fontSize:'10px', color: cx.capReason ? '#64748b' : '#34d399', fontFamily:'var(--font-plex-mono)', fontStyle:'italic' }}>⚑ {cx.capReason ?? 'Weighted Cortex V2 score uses normalized non-inflating categories.'}</span>
                        </div>
                      </div>
                    </div>
                    {/* 4-card CORTEX Read layout */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(228px,1fr))', gap: '12px', marginBottom: '20px' }}>
                      <div style={{ padding: '16px 18px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.20)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 12px', fontSize: '10px', fontWeight: 800, letterSpacing: '.16em', color: '#34d399', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Good Signs</p>
                        {goodSignals.length > 0 ? goodSignals.map((s, i) => (
                          <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '9px' }}>
                            <span style={{ color: '#34d399', flexShrink: 0, fontSize: '12px', lineHeight: '17px', fontWeight: 800 }}>✓</span>
                            <p style={{ margin: 0, fontSize: '11px', color: '#86efac', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                          </div>
                        )) : <p style={{ margin: 0, fontSize: '11px', color: '#2a4438', fontFamily: 'var(--font-plex-mono)' }}>No positive signals confirmed yet.</p>}
                      </div>
                      <div style={{ padding: '16px 18px', background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.20)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 12px', fontSize: '10px', fontWeight: 800, letterSpacing: '.16em', color: '#f87171', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Risk Signs</p>
                        {riskSignals.length > 0 ? riskSignals.map((s, i) => (
                          <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '9px' }}>
                            <span style={{ color: '#f87171', flexShrink: 0, fontSize: '12px', lineHeight: '17px', fontWeight: 800 }}>!</span>
                            <p style={{ margin: 0, fontSize: '11px', color: '#fca5a5', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                          </div>
                        )) : <p style={{ margin: 0, fontSize: '11px', color: '#3a2a2a', fontFamily: 'var(--font-plex-mono)' }}>No major risk signals surfaced.</p>}
                      </div>
                      <div style={{ padding: '16px 18px', background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.20)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 12px', fontSize: '10px', fontWeight: 800, letterSpacing: '.16em', color: '#fbbf24', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Missing Checks</p>
                        {missing2.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {missing2.map(m => <span key={m} style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.24)', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>{m}</span>)}
                          </div>
                        ) : <p style={{ margin: 0, fontSize: '11px', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>All key checks passed.</p>}
                      </div>
                      <div style={{ padding: '16px 18px', background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.26)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 10px', fontSize: '10px', fontWeight: 800, letterSpacing: '.16em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Next Action</p>
                        <p style={{ margin: 0, fontSize: '11px', color: '#67e8f9', lineHeight: 1.7, fontFamily: 'var(--font-plex-mono)' }}>{next2}</p>
                      </div>
                    </div>
                    {cx.confidence === 'LOW' && (
                      <div style={{ marginBottom: '16px', padding: '11px 14px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.22)', background: 'rgba(148,163,184,0.06)' }}>
                        <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>⚠ Limited confidence — important checks are missing. Do not assume safety.</span>
                      </div>
                    )}
                    {result.sections && (
                      <div style={{ marginBottom: '20px', fontSize: '12px', color: '#94a3b8' }}>
                        {[result.sections.market, result.sections.security, result.sections.holders, result.sections.liquidity, result.sections.contractChecks]
                          .filter((s): s is { status?: string; reason?: string; source?: string } => Boolean(s && s.status && s.status !== 'ok'))
                          .map((s, i) => <div key={i}>- {humanizeSectionLine(s.source, s.status, s.reason)}</div>)}
                      </div>
                    )}
                    </div>
                    </details>

                    {!planLoading && !isFullAccess && (
                      <div style={{ marginTop: '24px', padding: '28px 24px', border: '1px solid rgba(139,92,246,0.28)', borderRadius: '16px', background: 'rgba(139,92,246,0.06)', textAlign: 'center' }}>
                        <div style={{ fontSize: '26px', marginBottom: '12px' }}>🔒</div>
                        <p style={{ fontWeight: 700, color: '#f8fafc', margin: '0 0 8px', fontSize: '15px' }}>Full Security Report</p>
                        <p style={{ color: '#94a3b8', fontSize: '13px', margin: '0 0 20px', lineHeight: 1.5 }}>LP control, security simulation, and holder distribution are included in Pro and Elite plans.</p>
                        <a href="/pricing" style={{ display: 'inline-block', padding: '10px 28px', borderRadius: '999px', background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: '#fff', fontWeight: 700, fontSize: '13px', textDecoration: 'none' }}>Get Access</a>
                      </div>
                    )}
                  </>
                )
              })()}

              {/* ── MARKET PULSE ──────────────────────────────────────── */}
              {activeSection === 'market-pulse' && (
                <>
                  <div style={{ marginBottom: '16px' }}>
                    <p style={{ margin: '0 0 3px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.10em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>MARKET PULSE</p>
                    <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Live price, liquidity, volume and pool data for this token.</p>
                  </div>
                  {/* MARKET-PULSE-DEDUP, DISCLOSED (Token Scanner result-UI polish task, explicitly
                      reported: "repeats similar stats too many times"): the same Price/Liquidity/
                      Volume24h/24hChange/MC-FDV/PairAge numbers were previously rendered up to THREE
                      times — a "derived reads" grid, a separate "Market Insight Strip", a "VOL/LIQ
                      READ" banner, and then the real StatCard grid. Removed the two duplicate
                      pre-grid blocks entirely (no data lost — every number they showed is still in
                      the two-row StatCard grid below, in the exact layout requested: row 1 = Price/
                      Liquidity/Volume 24h/24h Change, row 2 = Market Cap/FDV/Pool Protocol/Pair Age).
                      The Vol/Liq read is preserved as one compact note under the grid instead of its
                      own banner. */}
                  {result.noActivePools ? (
                    <div style={{ padding: '20px 22px', marginBottom: '28px', background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '12px', fontFamily: 'var(--font-plex-mono)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
                        <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: '#fbbf24', textTransform: 'uppercase' }}>No Active Pool Found</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: '#b7a675', lineHeight: 1.55 }}>No liquidity pools were found for this contract on {chainDisplayName(result.chain)}. Price, volume, and liquidity data are unavailable.</p>
                    </div>
                  ) : (
                    <>
                      {result.marketDataSource === 'fallback' && (
                        <div style={{ padding: '8px 14px', marginBottom: '12px', background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: '8px', fontFamily: 'var(--font-plex-mono)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8b5cf6', flexShrink: 0 }} />
                          <span style={{ fontSize: '10px', color: '#a78bfa', fontWeight: 700, letterSpacing: '0.08em' }}>CORTEX MARKET READ</span>
                          <span style={{ fontSize: '10px', color: '#475569' }}>Primary pool data unavailable — showing fallback market data. FDV is not market cap.</span>
                        </div>
                      )}
                      {/* Row 1 — key metrics only (explicitly specified order: Price, Liquidity,
                          Volume 24h, 24h Change). */}
                      <div className="metric-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '10px', marginBottom: '10px' }}>
                        <StatCard label="Price" value={fmtPrice(result.price)} accent="#2DD4BF" helper={result.marketDataSource === 'fallback' ? 'Market read' : 'Primary pool'} />
                        <StatCard label="Liquidity" value={fmtLarge(result.liquidity)} helper="Pool depth" />
                        <StatCard label="Volume 24h" value={fmtLarge(result.volume24h)} helper="24h trading activity" />
                        <StatCard label="24h Change" value={fmtPct(result.priceChange24h)} accent={pctColor(result.priceChange24h)} helper="Price movement" />
                      </div>
                      {/* Row 2 — Market Cap, FDV, Pool Protocol, Pair Age. MARKET-HIERARCHY, DISCLOSED
                          (Token Scanner section-readability polish task, explicitly requested: "make
                          top trader metrics (Price/Liquidity/Volume/Change) visually primary, make
                          secondary data (Market Cap/FDV/Pool Protocol/Pair Age) slightly quieter"):
                          same StatCard component/data, just rendered with dim={true} so this row
                          reads as secondary context beneath row 1 — no values changed. */}
                      <div className="metric-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '8px', marginBottom: '10px' }}>
                        {(() => {
                          const val = result.valuationContext
                          const estimated = val?.primaryValuationStatus === 'estimated_mc' && val?.primaryValuationUsd != null
                          const fdvOnly = val?.primaryValuationStatus === 'fdv_only' && val?.primaryValuationUsd != null
                          return (
                            <StatCard
                              dim
                              label={estimated ? 'Estimated MC' : fdvOnly ? 'Valuation' : 'Market Cap'}
                              value={
                                val?.primaryValuationStatus === 'verified_mc' ? fmtLarge(val.primaryValuationUsd)
                                : estimated ? `~${fmtLarge(val!.primaryValuationUsd)}`
                                : fdvOnly ? `FDV ${fmtLarge(val.primaryValuationUsd)}`
                                : 'Supply not confirmed'
                              }
                              helper={
                                val?.primaryValuationStatus === 'verified_mc' ? 'Verified live market data'
                                : estimated ? 'Estimated from on-chain supply — not a live-verified market cap'
                                : fdvOnly ? 'Market cap not verified live'
                                : 'Live valuation not verified'
                              }
                              accent="#a78bfa"
                            />
                          )
                        })()}
                        <StatCard dim label="FDV" value={result.fdvUsd != null ? fmtLarge(result.fdvUsd) : 'Not indexed'} helper="Fully Diluted Valuation" accent="#a78bfa" />
                        <StatCard dim label="Pool Protocol" value={result.primaryDexName ?? 'Protocol not confirmed'} helper={result.primaryDexName ? 'Primary liquidity pool' : 'Pool found · protocol metadata missing'} accent={result.primaryDexName ? '#67e8f9' : '#64748b'} />
                        <StatCard dim label="Pair Age" value={result.poolActivity?.pairAgeLabel ?? 'Not indexed'} helper="Time since pool creation" accent="#a78bfa" />
                      </div>
                      {/* Compact notes — MC not verified, MC vs FDV, Vol/Liq read. Same wording as
                          before, just consolidated into short notes under the grid instead of a
                          separate repeated-stat banner. */}
                      <div style={{ display: 'grid', gap: '8px', marginBottom: '18px' }}>
                        {result.marketCapStatus !== 'verified' && (
                          <p style={{ margin: 0, color: '#7c93aa', fontSize: '11px', lineHeight: 1.55 }}>
                            {result.valuationContext?.primaryValuationStatus === 'estimated_mc'
                              ? 'Market cap not verified live — showing an estimate from on-chain supply. FDV is shown separately.'
                              : 'Market cap not confirmed. FDV is shown separately.'}
                          </p>
                        )}
                        {result.fdvUsd != null && result.marketCapUsd != null && result.marketCapUsd !== result.fdvUsd && (
                          <div style={{ padding: '10px 14px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.16)', borderRadius: '10px', fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>
                            <span style={{ color: '#a78bfa', fontWeight: 700 }}>MC vs FDV: </span>
                            {`Market cap ${fmtLarge(result.marketCapUsd)} reflects circulating supply. FDV ${fmtLarge(result.fdvUsd)} covers all tokens including locked and unvested. ${result.marketCapUsd / result.fdvUsd < 0.7 ? 'Significant unlock pressure possible.' : 'Low unlock pressure from current ratio.'}`}
                          </div>
                        )}
                        {(() => {
                          const volLiqRatio = result.volume24h != null && result.liquidity != null && result.liquidity > 0
                            ? result.volume24h / result.liquidity
                            : null
                          if (volLiqRatio == null) return null
                          const ratioColor = volLiqRatio > 3 ? '#f87171' : volLiqRatio > 1 ? '#fbbf24' : '#34d399'
                          const volLiqRead = volLiqRatio > 3
                            ? 'Volume is very high relative to liquidity — expect significant volatility and slippage.'
                            : volLiqRatio > 1
                              ? 'Volume is high relative to liquidity — expect volatility.'
                              : 'Healthy activity — volume is proportionate to liquidity depth.'
                          return (
                            <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(103,232,249,0.04)', border: '1px solid rgba(103,232,249,0.14)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                              <span style={{ color: ratioColor, fontWeight: 700 }}>Vol/Liq {volLiqRatio.toFixed(2)}x: </span>
                              <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{volLiqRead}</span>
                            </div>
                          )
                        })()}
                      </div>
                    </>
                  )}
                  {/* Project Links — indexed socials from token metadata */}
                  <ProjectSocialsCard socials={result.projectSocials} />
                  {(() => {
                    // Priority:
                    //   A) Real/reconstructed candles (pool_ohlcv, token_level_ohlcv, dexscreener_ohlcv, trade_reconstructed)
                    //      → CandlestickChart
                    //   B) Synthetic sources (synthetic_price_estimate, synthetic_flat_series) fall through
                    //      to TrendChart — we never render fake candlestick bars for estimated data
                    //   C) marketTrendSnapshot.status === 'ok' → premium TrendChart (smooth line/area)
                    //   D) Else → minimal snapshot state
                    const _REAL_SOURCES = new Set(['pool_ohlcv', 'token_level_ohlcv', 'dexscreener_ohlcv', 'trade_reconstructed'])
                    const _hasValidCandles = result.chartStatus === 'ok' && (result.priceChart?.points.length ?? 0) >= 2 && _REAL_SOURCES.has(result.chartSource ?? '')
                    const _hasMarketTrend = result.marketTrendSnapshot?.status === 'ok'
                    const mts = result.marketTrendSnapshot
                    const pctColor = (v: number | null) => v == null ? '#94a3b8' : v >= 0 ? '#34d399' : '#f87171'

                    if (_hasValidCandles) {
                      return (
                        <div className="glass-card" style={{ marginBottom: '16px', borderRadius: '16px', padding: '18px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                            <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', color: '#cbd5e1', textTransform: 'uppercase' }}>Price Chart</p>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                              {result.chartSource === 'trade_reconstructed' && (
                                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', padding: '2px 8px', borderRadius: '99px', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.22)', textTransform: 'uppercase' }}>
                                  Reconstructed from recent swaps
                                </span>
                              )}
                              {result.chartSource === 'dexscreener_ohlcv' && (
                                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', padding: '2px 8px', borderRadius: '99px', color: '#818cf8', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.22)', textTransform: 'uppercase' }}>
                                  Indexed from fallback market candles
                                </span>
                              )}
                              {(result.chartSource === 'pool_ohlcv' || result.chartSource === 'token_level_ohlcv') && (
                                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', padding: '2px 8px', borderRadius: '99px', color: '#34d399', background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.20)', textTransform: 'uppercase' }}>
                                  Live Candles
                                </span>
                              )}
                              <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
                                {result.priceChart!.fallbackUsed ? 'Live pool price action (fallback pool)' : 'Primary pool price action'}
                              </p>
                            </div>
                          </div>
                          <div style={{ display: 'inline-flex', marginBottom: '10px', border: '1px solid rgba(148,163,184,.3)', borderRadius: '999px', padding: '2px 8px', fontSize: '10px', color: '#cbd5e1' }}>
                            {result.priceChart!.timeframe === '24h' ? '24H' : result.priceChart!.timeframe === '48h' ? '48H' : result.priceChart!.timeframe === '7d' ? '7D' : '30D'}
                          </div>
                          <CandlestickChart candles={result.priceChart!.points} timeframe={result.priceChart!.timeframe} isFlatSeries={result.chartSource === 'synthetic_flat_series'} />
                        </div>
                      )
                    }

                    if (_hasMarketTrend) {
                      const visibleChanges = (mts?.changes ?? []).filter(c => c.value != null)
                      const _trendChart = <TrendChart snapshot={mts!} currentPrice={result.price ?? null} />
                      return (
                        <div className="glass-card" style={{ marginBottom: '16px', borderRadius: '16px', padding: '18px' }}>
                          {/* Header row */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                            <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', color: '#cbd5e1', textTransform: 'uppercase' }}>Price Chart</p>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', padding: '2px 8px', borderRadius: '99px', color: '#a78bfa', background: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.22)', textTransform: 'uppercase' }}>
                                Estimated Trend
                              </span>
                              {result.marketDataSource === 'fallback' && (
                                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', padding: '2px 8px', borderRadius: '99px', color: '#a78bfa', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.22)', textTransform: 'uppercase' }}>CORTEX MARKET READ</span>
                              )}
                              <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
                                {visibleChanges.length > 0 ? 'Inferred from indexed % changes' : 'Live price only'}
                              </p>
                            </div>
                          </div>

                          {/* Trend chart (null-safe: renders nothing if < 2 anchors) */}
                          {_trendChart}

                          {/* Price + change chips */}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'flex-end', marginTop: '14px', marginBottom: '14px' }}>
                            <div>
                              <div style={{ fontSize: '9px', letterSpacing: '.16em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px', textTransform: 'uppercase' }}>Live Price</div>
                              <div style={{ fontSize: '22px', fontWeight: 800, color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>{fmtPrice(mts!.price)}</div>
                            </div>
                            {visibleChanges.length > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', paddingBottom: '2px' }}>
                                {visibleChanges.map(c => (
                                  <div key={c.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '5px 10px', borderRadius: '10px', background: `${pctColor(c.value)}10`, border: `1px solid ${pctColor(c.value)}28` }}>
                                    <span style={{ fontSize: '8px', letterSpacing: '.12em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '2px' }}>{c.label}</span>
                                    <span style={{ fontSize: '12px', fontWeight: 800, color: pctColor(c.value), fontFamily: 'var(--font-plex-mono)' }}>{fmtPct(c.value)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Stats grid */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: '8px', marginBottom: '14px' }}>
                            {mts!.liquidity != null && (
                              <div style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,0.55)' }}>
                                <div style={{ fontSize: '8px', letterSpacing: '.12em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '3px' }}>Liquidity</div>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{fmtLarge(mts!.liquidity)}</div>
                              </div>
                            )}
                            {mts!.volume24h != null && (
                              <div style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,0.55)' }}>
                                <div style={{ fontSize: '8px', letterSpacing: '.12em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '3px' }}>Volume 24H</div>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{fmtLarge(mts!.volume24h)}</div>
                              </div>
                            )}
                            {(mts!.buys24h != null && mts!.sells24h != null) ? (
                              <div style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,0.55)' }}>
                                <div style={{ fontSize: '8px', letterSpacing: '.12em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '3px' }}>Buys / Sells</div>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{mts!.buys24h!.toLocaleString()} <span style={{ color: '#3a5268' }}>/</span> {mts!.sells24h!.toLocaleString()}</div>
                              </div>
                            ) : mts!.transactions24h != null ? (
                              <div style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,0.55)' }}>
                                <div style={{ fontSize: '8px', letterSpacing: '.12em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '3px' }}>Transactions 24H</div>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{mts!.transactions24h!.toLocaleString()}</div>
                              </div>
                            ) : null}
                            {mts!.pairAge != null && (
                              <div style={{ padding: '10px 12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(8,14,28,0.55)' }}>
                                <div style={{ fontSize: '8px', letterSpacing: '.12em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '3px' }}>Pair Age</div>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>{mts!.pairAge}</div>
                              </div>
                            )}
                          </div>

                          <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>
                            Historical candles are not indexed yet. Trend is inferred from live indexed price changes.
                          </p>
                        </div>
                      )
                    }

                    // Minimal snapshot — no candles, no market trend data
                    return (
                      <div className="glass-card" style={{ marginBottom: '16px', borderRadius: '16px', padding: '18px' }}>
                        <p style={{ margin: '0 0 6px', fontSize: '12px', fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Price Chart</p>
                        <p style={{ margin: 0, fontSize: '12px', color: '#3a5268', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>
                          {result.noActivePools ? 'Chart data unavailable — no active indexed pools found for this token.' : 'Historical candles are not indexed for this pool yet.'}
                        </p>
                      </div>
                    )
                  })()}
                  {!result.noActivePools && result.marketDataSource !== 'fallback' && (
                    <div style={{ marginBottom: '28px' }}>
                      <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', marginBottom: '10px', fontFamily: 'var(--font-plex-mono)' }}>Pool Activity</p>
                      <div className="activity-grid">
                        <StatCard label="Transactions 24H" value={result.poolActivity?.transactions24h != null ? result.poolActivity.transactions24h.toLocaleString() : 'Activity unavailable'} helper="Primary pool activity" />
                        <StatCard label="Buys / Sells" value={result.poolActivity?.buys24h != null && result.poolActivity?.sells24h != null ? `${result.poolActivity.buys24h.toLocaleString()} / ${result.poolActivity.sells24h.toLocaleString()}` : 'Buy/sell split unavailable'} helper="24h pool flow" />
                        <StatCard label="Buy / Sell Vol" value={result.poolActivity?.buyVolume24hUsd != null && result.poolActivity?.sellVolume24hUsd != null ? `${fmtLarge(result.poolActivity.buyVolume24hUsd)} / ${fmtLarge(result.poolActivity.sellVolume24hUsd)}` : result.poolActivity?.volume24hUsd != null ? `Total ${fmtLarge(result.poolActivity.volume24hUsd)}` : 'Volume unavailable'} helper={result.poolActivity?.buyVolume24hUsd != null && result.poolActivity?.sellVolume24hUsd != null ? '24h buy/sell volume' : result.poolActivity?.volume24hUsd != null ? 'Buy/sell volume split not exposed' : '24h volume not exposed'} />
                        <StatCard label="Pair Age" value={result.poolActivity?.pairAgeLabel ?? 'Pool age unavailable'} helper={result.poolActivity?.pairAgeLabel != null ? 'Primary pool created' : 'Creation time not exposed'} />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── HOLDER MAP ────────────────────────────────────────── */}
              {activeSection === 'holder-map' && (() => {
                const holderState = deriveHolderState(result)
                const fallback = deriveHolderFallbackEvidence(result)
                return (
                  <>
                    <div style={{ marginBottom: '18px' }}>
                      <p style={{ margin: '0 0 3px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.10em', color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>HOLDER MAP</p>
                      <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Top holder distribution and supply concentration analysis.</p>
                    </div>
                    {!planLoading && !isFullAccess && (
                      <div style={{ padding: '24px', border: '1px solid rgba(139,92,246,0.28)', borderRadius: '16px', background: 'rgba(139,92,246,0.06)', textAlign: 'center' }}>
                        <div style={{ fontSize: '22px', marginBottom: '10px' }}>🔒</div>
                        <p style={{ fontWeight: 700, color: '#f8fafc', margin: '0 0 6px', fontSize: '14px' }}>Holder Distribution</p>
                        <p style={{ color: '#94a3b8', fontSize: '12px', margin: '0 0 16px', lineHeight: 1.5 }}>Holder analytics are included in Pro and Elite.</p>
                        <a href="/pricing" style={{ display: 'inline-block', padding: '8px 20px', borderRadius: '999px', background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: '#fff', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}>Get Access</a>
                      </div>
                    )}
                    {!planLoading && isFullAccess && result.debugHolderStatus && (() => {
                      const d = result.debugHolderStatus!
                      return (
                        <details style={{ marginBottom: '12px', background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: '8px', padding: '8px 12px', fontSize: '10px', fontFamily: 'var(--font-plex-mono)' }}>
                          <summary style={{ cursor: 'pointer', color: '#fbbf24', letterSpacing: '0.10em', fontWeight: 700 }}>
                            Holder Debug · HTTP {d.statusCode ?? '?'} · items:{d.itemCount ?? '?'} norm:{d.normalizedCount ?? '?'}
                          </summary>
                          <table style={{ marginTop: '8px', borderCollapse: 'collapse', width: '100%' }}><tbody>
                            {([['providerCalled',String(d.providerCalled??'?')],['chain',d.chain??'?'],['statusCode',d.statusCode!=null?String(d.statusCode):'—'],['itemCount',d.itemCount!=null?String(d.itemCount):'—'],['normalizedCount',d.normalizedCount!=null?String(d.normalizedCount):'—'],['reason',d.reason??'—']] as [string,string][]).map(([k,v])=>(
                              <tr key={k}><td style={{paddingRight:'12px',color:'#78716c',whiteSpace:'nowrap'}}>{k}</td><td style={{color:'#d97706',wordBreak:'break-all'}}>{v}</td></tr>
                            ))}
                          </tbody></table>
                        </details>
                      )
                    })()}
                    {!planLoading && isFullAccess && (() => {
                      if (holderState.kind !== 'noRowsFallback') {
                        const top1h = result.holderDistribution?.top1
                        const top10h = result.holderDistribution?.top10
                        const top20h = result.holderDistribution?.top20
                        const holderCount = result.holderDistribution?.holderCount
                        const concRisk = top10h != null ? (top10h > 50 ? 'HIGH' : top10h > 30 ? 'MEDIUM' : 'LOW') : null
                        const concColor = concRisk === 'HIGH' ? '#f87171' : concRisk === 'MEDIUM' ? '#fbbf24' : concRisk === 'LOW' ? '#34d399' : '#94a3b8'
                        const concRead = holderState.kind === 'rowsWithPercent' && concRisk != null
                          ? concRisk === 'HIGH' ? 'High concentration — top holders control majority supply.' : concRisk === 'MEDIUM' ? 'Moderate concentration — watch for coordinated movement.' : 'Spread looks reasonable — no extreme concentration flagged.'
                          : null
                        const whalePressure = holderState.kind !== 'rowsWithPercent' || top10h == null
                          ? 'UNVERIFIED'
                          : top10h >= 70 ? 'EXTREME' : top10h >= 50 ? 'HIGH' : top10h >= 20 ? 'MEDIUM' : 'LOW'
                        // HOLDER-MAP-DEDUP, DISCLOSED (Token Scanner Holder Map readability polish
                        // task, explicitly requested: "avoid showing the same meaning in too many
                        // separate boxes... group better: summary card (verdict + top1/10/20 +
                        // holders), visual concentration card (bars), top holders table, evidence
                        // notes"): previously Whale Pressure + a fully-duplicate Top10/Top20/
                        // Holder-Count/Supply-Spread grid + the bars card's own three stacked
                        // warning paragraphs all repeated the same top10/top20 numbers up to three
                        // times. Consolidated into: (A) one Summary card — a plain-language
                        // takeaway sentence, the concRisk verdict pill, and the top1/10/20/holders
                        // stat grid (reusing concRisk/concColor, same thresholds as before); (B) a
                        // trimmed Visual Concentration card — same top1/5/10/20 bars, now with a
                        // single highest-priority note instead of three overlapping ones. No values
                        // changed, no evidence removed — same underlying top1h/top10h/top20h/
                        // holderCount/concRisk.
                        const takeaway = concRisk === 'HIGH'
                          ? `High concentration — top 10 holders control ${top10h != null ? top10h.toFixed(1) : '—'}%.`
                          : concRisk === 'MEDIUM'
                            ? `Moderate concentration — top 10 holders control ${top10h != null ? top10h.toFixed(1) : '—'}%.`
                            : concRisk === 'LOW'
                              ? `Spread looks reasonable — top 10 holders control ${top10h != null ? top10h.toFixed(1) : '—'}%.`
                              : 'Holder concentration verdict is an open check for this scan.'
                        return (
                          <>
                        <div style={{ padding: '14px 16px', borderRadius: '12px', background: `${concColor}0c`, border: `1px solid ${concColor}30`, marginBottom: '12px' }}>
                          <p style={{ margin: '0 0 4px', fontSize: '13px', fontWeight: 800, color: concColor, fontFamily: 'var(--font-plex-mono)', lineHeight: 1.4 }}>{takeaway}</p>
                          <p style={{ margin: 0, fontSize: '10.5px', color: '#7c93aa', fontFamily: 'var(--font-plex-mono)' }}>Whale pressure: {whalePressure.charAt(0) + whalePressure.slice(1).toLowerCase()}</p>
                        </div>
                        <div className="holders-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                            {/* Summary card — merged Whale Pressure + the old duplicate grid */}
                            <div style={{ gridColumn:'1 / -1', padding:'14px 16px', borderRadius:'12px', background:'rgba(167,139,250,0.05)', border:`1px solid ${concColor}28` }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'12px', flexWrap:'wrap' }}>
                                <span style={{ fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#a78bfa', fontFamily:'var(--font-plex-mono)' }}>CONCENTRATION SUMMARY</span>
                                <span style={{ padding:'3px 10px', borderRadius:'999px', fontSize:'9px', fontWeight:800, letterSpacing:'.12em', color:concColor, background:`${concColor}12`, border:`1px solid ${concColor}40`, fontFamily:'var(--font-plex-mono)' }}>{concRisk ?? 'OPEN CHECK'} CONCENTRATION</span>
                              </div>
                              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:'8px' }}>
                                {[
                                  ['Top 1', top1h != null ? `${top1h.toFixed(1)}%` : 'N/A'],
                                  ['Top 10', top10h != null ? `${top10h.toFixed(1)}%` : 'N/A'],
                                  ['Top 20', top20h != null ? `${top20h.toFixed(1)}%` : 'N/A'],
                                  ['Holders', holderCount != null ? holderCount.toLocaleString() : 'N/A'],
                                ].map(([label, val]) => (
                                  <div key={label} style={{ padding:'8px 10px', borderRadius:'8px', background:'rgba(15,23,42,0.55)', border:'1px solid rgba(167,139,250,0.16)' }}>
                                    <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', marginBottom:'3px', fontFamily:'var(--font-plex-mono)' }}>{label}</div>
                                    <div style={{ fontSize:'12px', color:'#e2e8f0', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{val}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="glass-card" style={{ padding: '18px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                                <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>VISUAL CONCENTRATION</p>
                                <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: `1px solid ${holderState.kind === 'rowsWithPercent' ? 'rgba(45,212,191,.5)' : 'rgba(251,191,36,.4)'}`, color: holderState.kind === 'rowsWithPercent' ? '#2dd4bf' : '#fbbf24', background: holderState.kind === 'rowsWithPercent' ? 'rgba(45,212,191,.1)' : 'rgba(251,191,36,.1)' }}>{holderState.kind === 'rowsWithPercent' ? 'VERIFIED' : 'PARTIAL'}</span>
                              </div>
                              {holderState.kind === 'rowsWithoutPercent' && <p style={{ margin: '0 0 10px', fontSize: '11px', color: '#fbbf24' }}>{holderState.safeReason} Addresses and amounts shown below.</p>}
                              {holderState.kind === 'rowsWithPercent' && <div style={{ display: 'grid', gap: '10px' }}>
                                {[['Top 1',result.holderDistribution?.top1],['Top 5',result.holderDistribution?.top5],['Top 10',result.holderDistribution?.top10],['Top 20',result.holderDistribution?.top20]].map(([l,v])=>(
                                  <div key={String(l)} style={{ display: 'grid', gridTemplateColumns: '82px 1fr 64px', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ fontSize: '12px', color: '#d6e6f3', fontWeight: 700 }}>{l}</span>
                                    <div style={{ height: '12px', borderRadius: '999px', background: 'linear-gradient(90deg,rgba(30,41,59,.9),rgba(51,65,85,.5))', border: '1px solid rgba(148,163,184,.25)' }}><div style={{ height: '100%', width: `${v==null?0:Math.max(0,Math.min(100,Number(v)))}%`, borderRadius: '999px', background: 'linear-gradient(90deg,#2dd4bf,#a855f7)', boxShadow: '0 0 14px rgba(45,212,191,.28)' }} /></div>
                                    <span style={{ fontSize: '13px', fontWeight: 800, color: '#eef6ff', textAlign: 'right', fontFamily: 'var(--font-plex-mono)' }}>{v==null?'N/A':`${Number(v).toFixed(1)}%`}</span>
                                  </div>
                                ))}
                              </div>}
                              {/* One consolidated note instead of the previous 3 stacked warnings. */}
                              {(top10h != null && top10h > 50) ? (
                                <p style={{ margin: '10px 0 0', fontSize: '11.5px', color: '#fca5a5', lineHeight: 1.5, border: '1px solid rgba(248,113,113,0.28)', background: 'rgba(248,113,113,0.08)', borderRadius: '10px', padding: '8px 10px' }}>
                                  High concentration — top wallets control majority supply.
                                </p>
                              ) : (top1h != null && top1h > 20) ? (
                                <p style={{ margin: '10px 0 0', fontSize: '11.5px', color: '#fecaca', lineHeight: 1.5, border: '1px solid rgba(248,113,113,0.22)', background: 'rgba(248,113,113,0.06)', borderRadius: '10px', padding: '8px 10px' }}>
                                  Largest holder has meaningful supply control.
                                </p>
                              ) : null}
                              <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#8aa3b8' }}>{holderState.kind === 'rowsWithPercent' ? 'Top holder concentration from live holder data' : 'Holder distribution based on available live holder rows'}</p>
                            </div>
                            <div className="glass-card" style={{ padding: '18px', minWidth: 0, overflow: 'hidden' }}>
                              <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', marginBottom: '4px', fontFamily: 'var(--font-plex-mono)' }}>TOP HOLDERS</p>
                              <p style={{ margin: '0 0 10px', fontSize: '11px', color: '#8aa3b8' }}>Top 10 holders</p>
                              <div className="top-holder-head" style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 88px 62px 74px', gap: '10px', fontSize: '10px', letterSpacing: '0.10em', color: '#6a8198', marginBottom: '8px', fontFamily: 'var(--font-plex-mono)' }}><span>#</span><span>WALLET</span><span style={{ textAlign: 'right' }}>AMOUNT</span><span style={{ textAlign: 'right' }}>%</span><span style={{ textAlign: 'right' }}>COPY</span></div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px', overflowY: 'auto', paddingRight: '3px' }}>
                                {holderState.rows.slice(0,20).map((h)=>(
                                  <div className="top-holder-row" key={h.rank+h.address} style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 88px 62px 74px', gap: '10px', alignItems: 'center', padding: '10px', border: '1px solid rgba(148,163,184,.18)', borderRadius: '10px', background: 'rgba(15,23,42,.45)' }}>
                                    <span style={{ fontSize: '11px', color: '#dbeafe', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, display: 'inline-flex', justifyContent: 'center', padding: '2px 0', borderRadius: '999px', background: h.rank<=3?'linear-gradient(90deg,rgba(45,212,191,.28),rgba(168,85,247,.28))':'transparent', border: h.rank<=3?'1px solid rgba(167,139,250,.45)':'none' }}>{h.rank}</span>
                                    <span className="top-holder-mobile-meta" style={{ fontSize: '12px', color: '#c5d8ea', fontFamily: 'var(--font-plex-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shorten(h.address)}<span style={{ display: 'none', fontSize: '12px', fontWeight: 800, color: h.percent!=null&&h.percent>=10?'#fb7185':h.percent!=null&&h.percent>=5?'#fbbf24':'#67e8f9' }}>{h.percent==null?'—':`${h.percent.toFixed(2)}%`}</span></span>
                                    <span className="top-holder-mobile-amt" style={{ fontSize: '12px', color: '#e5eef9', textAlign: 'right', fontFamily: 'var(--font-plex-mono)' }}>{fmtTokenAmt(h.amount,result.decimals??18)}</span>
                                    <span style={{ fontSize: '12px', fontWeight: 800, textAlign: 'right', fontFamily: 'var(--font-plex-mono)', color: h.percent!=null&&h.percent>=10?'#fb7185':h.percent!=null&&h.percent>=5?'#fbbf24':'#67e8f9' }}>{h.percent==null?'—':`${h.percent.toFixed(2)}%`}</span>
                                    {isValidHolderAddress(h.address) && (
                                      <button
                                        type="button"
                                        onClick={() => { void copyHolderAddress(h.address) }}
                                        style={{
                                          justifySelf: 'end',
                                          padding: '4px 10px',
                                          borderRadius: '999px',
                                          border: copiedHolderAddress === h.address ? '1px solid rgba(45,212,191,0.55)' : '1px solid rgba(167,139,250,0.48)',
                                          background: copiedHolderAddress === h.address
                                            ? 'linear-gradient(135deg,rgba(45,212,191,0.18),rgba(45,212,191,0.1))'
                                            : 'linear-gradient(135deg,rgba(167,139,250,0.2),rgba(45,212,191,0.08))',
                                          color: copiedHolderAddress === h.address ? '#67e8f9' : '#c4b5fd',
                                          fontSize: '10px',
                                          fontWeight: 700,
                                          letterSpacing: '0.08em',
                                          fontFamily: 'var(--font-plex-mono)',
                                          cursor: 'pointer',
                                          whiteSpace: 'nowrap',
                                          boxShadow: copiedHolderAddress === h.address ? '0 0 10px rgba(45,212,191,0.25)' : '0 0 10px rgba(167,139,250,0.14)',
                                          transition: 'all 0.14s ease',
                                          minHeight: '26px',
                                        }}
                                        aria-label={`Copy full holder address ${h.address}`}
                                      >
                                        {copiedHolderAddress === h.address ? 'Copied' : 'Copy'}
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                          </>
                        )
                      }
                      const fb = buildHolderFallbackRead(fallback)
                      const lpS = result.lpControl?.status
                      const lpV = lpS === 'locked' || lpS === 'burned'
                      const hpV = result.honeypot?.simulationSuccess === true
                      const simUiHolders = tradingSimUiFor(result)
                      // ROBINHOOD-EVIDENCE FIX, DISCLOSED: Owner status / Security simulation chips
                      // used to fall back to the bare enum value / a binary "Open check" regardless
                      // of chain or real reason — Robinhood scans now show the resolver's specific
                      // classification instead.
                      const robinhoodEv = robinhoodEvidenceFor(result)
                      const ownerStatusValue = fallback.ownerStatus !== 'Open check' ? fallback.ownerStatus : (robinhoodEv?.ownershipLabel ?? fallback.ownerStatus)
                      const securityValue = simUiHolders.statusLabel
                      const lpControlValue = lpV
                        ? 'Verified'
                        : (robinhoodEv?.lpControllerLabel ?? (isRobinhoodScan(result) ? (robinhoodProofCopy(result)?.controllerLabel ?? 'LP controller not verified') : 'Open check'))
                      const holderMissingCopy = isRobinhoodScan(result)
                        ? ROBINHOOD_HOLDER_UNAVAILABLE_LABEL
                        : 'Holder distribution was not returned in this scan. Supply concentration remains an open risk check.'
                      const evItems: Array<{label:string;value:string;ok:boolean}> = [
                        { label: 'Market data',         value: result.price!=null?'Available':'Unavailable',                   ok: result.price!=null },
                        { label: 'Liquidity depth',     value: fallback.liquidityDepth!=null?fmtLarge(fallback.liquidityDepth):'Open check', ok: fallback.liquidityDepth!=null },
                        { label: 'Pool count',          value: fallback.poolCount>0?String(fallback.poolCount):'Open check',    ok: fallback.poolCount>0 },
                        { label: 'LP control',          value: lpControlValue,                                                ok: lpV },
                        { label: 'Owner status',        value: ownerStatusValue,                                              ok: fallback.ownerStatus==='Renounced' },
                        { label: 'Security simulation', value: securityValue,                                                 ok: hpV },
                      ]
                      return (
                        <div style={{ marginBottom: '20px', background: 'linear-gradient(160deg,rgba(12,10,4,.72),rgba(4,8,18,.88))', border: '1px solid rgba(251,191,36,.22)', borderRadius: '14px', padding: '18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                            <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>HOLDER CONCENTRATION</p>
                            <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: '1px solid rgba(251,191,36,.4)', color: '#fbbf24', background: 'rgba(251,191,36,.08)' }}>UNVERIFIED</span>
                          </div>
                          <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#fde68a', lineHeight: 1.5 }}>{holderMissingCopy}</p>
                          <div className="intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '8px', marginBottom: '14px' }}>
                            {evItems.map(({label,value,ok})=>(
                              <div key={label} style={{ padding: '9px 10px', borderRadius: '10px', background: 'rgba(15,23,42,0.42)', border: `1px solid ${ok?'rgba(52,211,153,.22)':/open check/i.test(value)?'rgba(251,191,36,.22)':/unsupported/i.test(value)?'rgba(125,211,252,.22)':'rgba(248,113,113,.22)'}` }}>
                                <div style={{ fontSize: '9px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>{label}</div>
                                <div style={{ fontSize: '11px', fontWeight: 700, color: ok?'#34d399':/open check/i.test(value)?'#fbbf24':/unsupported/i.test(value)?'#7dd3fc':'#f87171', fontFamily: 'var(--font-plex-mono)' }}>{value}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(15,23,42,.5)', border: '1px solid rgba(125,211,252,.15)', marginBottom: '10px' }}>
                            <div style={{ fontSize: '9px', letterSpacing: '.1em', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono)', marginBottom: '5px' }}>CORTEX READ</div>
                            <p style={{ margin: 0, fontSize: '11px', color: '#b7c9da', lineHeight: 1.6 }}>{fb.read}</p>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Rescan later and monitor holder distribution before trusting supply spread.</p>
                        </div>
                      )
                    })()}
                  </>
                )
              })()}

              {/* ── LP SAFETY ─────────────────────────────────────────── */}
              {activeSection === 'lp-safety' && (
                <>
                  {/* ── header ────────────────────────────────────────── */}
                  <div style={{ marginBottom: '18px' }}>
                    <p style={{ margin: '0 0 3px', fontSize: '13px', fontWeight: 800, letterSpacing: '0.10em', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>LP SAFETY ANALYZER</p>
                    <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Liquidity pool lock status, exit risk, and LP model.</p>
                  </div>

                  {/* ── 3-card hero: LP Status · Exit Risk · LP Model ─── */}
                  {(() => {
                    const rawLockInfo = getLpLockLabel(result)
                    const rawExitInfo = getLpExitRiskInfo(result)
                    const lpModeVal = getLpMode(result)
                    const lpStatus = result.lpControl?.status
                    const hasPool = (result.liquidity ?? 0) > 0 || result.lpControl?.poolAddressPresent
                    const lpStatus2 = result.lpControl?.status
                    const dm2 = result.lpControl?.displayLpModel
                    const effectiveDm = (dm2 === 'no_pool' && hasPool) ? 'open_check' : dm2
                    const lpProofConfirmed = lpStatus2 === 'burned' || lpStatus2 === 'locked'
                    const liquiditySection = result.sections?.liquidity
                    const canonicalLpMeta = result.lpMeta ?? liquiditySection?.lpMeta ?? {}
                    const canonicalSelectedPool = result.selectedPool ?? (result.pools?.[0] as (Pool & { dex?: string | null; model?: string | null }) | undefined)
                    const canonicalConcentratedProof = result.concentratedPositionProof
                    const canonicalPrimaryDexName = result.primaryDexName
                      ?? canonicalSelectedPool?.dex
                      ?? (typeof canonicalLpMeta?.primaryMarketDex === 'string' ? canonicalLpMeta.primaryMarketDex : undefined)
                      ?? liquiditySection?.pool_protocol
                      ?? ''
                    const isV3PartialPositionProof =
                      canonicalSelectedPool?.model === 'concentrated' &&
                      /uniswap v3/i.test(String(canonicalSelectedPool?.dex || canonicalPrimaryDexName || canonicalLpMeta?.primaryMarketDex || '')) &&
                      canonicalLpMeta?.concentratedProofAttempted === true &&
                      canonicalConcentratedProof?.status === 'partial' &&
                      Boolean(canonicalConcentratedProof?.positionManager)
                    // ROBINHOOD LP LABEL OVERRIDES (LP Safety display task) — chain-honest
                    // partial/unverified wording replaces the four generic Open Check labels.
                    // Applied after the V3-partial branch so both refinements compose; see
                    // robinhoodLpLabelOverrides for the never-upgrade rule.
                    const _rhOverride = robinhoodLpLabelOverrides(result)
                    const lockInfo = _rhOverride?.lock
                      ? { ...rawLockInfo, label: _rhOverride.lock.label, description: _rhOverride.lock.description }
                      : isV3PartialPositionProof
                      ? { ...rawLockInfo, description: 'Uniswap V3 concentrated liquidity position proof is partial; owner verification is pending.' }
                      : rawLockInfo
                    const exitInfo = _rhOverride?.exit
                      ? { ...rawExitInfo, ..._rhOverride.exit }
                      : isV3PartialPositionProof
                      ? { ...rawExitInfo, description: 'Deep liquidity is present, but concentrated position ownership is still unresolved.' }
                      : rawExitInfo
                    const modelLabel = primaryLiquidityModelLabel(result)
                    // Robinhood model override: "Model Open Check" → "Robinhood LP Model Partial"
                    const rhModelLabel = _rhOverride?.model?.label
                    const finalModelLabel = rhModelLabel ?? modelLabel
                    const modelColor = effectiveDm === 'concentrated_liquidity' ? '#c084fc'
                      : effectiveDm === 'protocol_or_gauge' ? '#a78bfa'
                      : effectiveDm === 'erc20_lp_token' ? (lpProofConfirmed ? '#34d399' : '#60a5fa')
                      : effectiveDm === 'no_pool' ? '#94a3b8'
                      : lpModeVal === 'protocol' ? '#c084fc'
                      : lpModeVal === 'lp_token' ? (lpProofConfirmed ? '#34d399' : '#60a5fa')
                      : hasPool ? '#fbbf24'
                      : '#94a3b8'
                    const modelDesc = isV3PartialPositionProof ? 'Position manager resolved. Pool active/liquidity confirmed.'
                      : isUniswapV3ConcentratedPartial(result) ? 'Position manager resolved. Pool active/liquidity confirmed.'
                      : isProtocolPositionModel(result) ? protocolPositionSubtext('lock')
                      : effectiveDm === 'erc20_lp_token' ? (lpProofConfirmed ? 'Standard ERC-20 LP token — lock or burn proof confirmed.' : 'Standard ERC-20 LP token detected. Lock or burn proof has not been verified.')
                      : effectiveDm === 'no_pool' ? 'No active liquidity pool detected for this token.'
                      : lpModeVal === 'lp_token' ? (lpProofConfirmed ? 'Standard ERC-20 LP token — lock or burn proof confirmed.' : 'Standard ERC-20 LP token detected. Lock or burn proof has not been verified.')
                      : hasPool ? 'Pool detected, but LP token model could not be fully classified.'
                      : 'Pool structure could not be classified from this scan.'
                    void lpStatus
                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '12px', marginBottom: '16px', alignItems: 'stretch' }}>
                        <div style={{ padding: '16px 18px', background: 'rgba(10,18,32,0.62)', border: `1px solid ${lockInfo.border}`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>LP Status</div>
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: lockInfo.color, flexShrink: 0, boxShadow: `0 0 8px ${lockInfo.color}`, marginTop: '6px' }} />
                            <span style={{ minWidth: 0, fontSize: '16px', fontWeight: 800, color: lockInfo.color, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.03em', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{lockInfo.label}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6, overflowWrap: 'anywhere' }}>{lockInfo.description}</p>
                        </div>
                        <div style={{ padding: '16px 18px', background: 'rgba(10,18,32,0.62)', border: `1px solid ${exitInfo.color}28`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>Exit Risk</div>
                          <div style={{ marginBottom: '8px' }}>
                            <span style={{ padding: '4px 13px', borderRadius: '999px', background: `${exitInfo.color}14`, border: `1px solid ${exitInfo.color}45`, color: exitInfo.color, fontSize: '14px', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.05em' }}>{exitInfo.label}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{exitInfo.description}</p>
                        </div>
                        <div style={{ padding: '16px 18px', background: 'rgba(10,18,32,0.62)', border: `1px solid ${modelColor}28`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>Primary Liquidity Model</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: modelColor, flexShrink: 0, boxShadow: `0 0 8px ${modelColor}` }} />
                            <span style={{ minWidth: 0, fontSize: '16px', fontWeight: 800, color: modelColor, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.03em', lineHeight: 1.25, overflowWrap: 'anywhere' }}>{finalModelLabel}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{_rhOverride?.model?.description ?? modelDesc}</p>
                        </div>
                      </div>
                    )
                  })()}

                  {isRobinhoodScan(result) && result.robinhoodLpProofAudit && (() => {
                    const audit = result.robinhoodLpProofAudit
                    const copy = robinhoodProofCopy(result) ?? buildRobinhoodLpCopy({
                      concentrated: result.lpControl?.status === 'concentrated_liquidity' || result.lpControl?.displayLpModel === 'concentrated_liquidity',
                      classification: audit.status,
                      reason: audit.reason,
                      positionOwnerProof: result.concentratedPositionProof?.status === 'verified' ? 'verified' : result.concentratedPositionProof?.status === 'partial' ? 'partial' : 'unavailable',
                    })
                    const buckets = buildRobinhoodLpSafetyBuckets({
                      audit,
                      copy,
                      liquidityUsd: result.liquidity ?? null,
                      tokenHolderRowsReturned: result.holderDistribution?.topHolders?.length ?? 0,
                      securityUnsupported: result.honeypot?.honeypotStatus === 'not_supported' || result.honeypot?.honeypotReason === ROBINHOOD_SECURITY_UNSUPPORTED_LABEL,
                      securityErrored: result.honeypot?.honeypotStatus === 'failed',
                      concentrated: Boolean(copy.concentratedNote),
                    })
                    const sections: Array<{ key: keyof typeof buckets; title: string; color: string; border: string }> = [
                      { key: 'verified', title: 'Verified evidence', color: '#34d399', border: 'rgba(52,211,153,.22)' },
                      { key: 'partial', title: 'Partial evidence', color: '#fbbf24', border: 'rgba(251,191,36,.22)' },
                      { key: 'missing', title: 'Missing evidence', color: '#94a3b8', border: 'rgba(148,163,184,.22)' },
                      { key: 'unsupported', title: 'Unsupported on Robinhood', color: '#7dd3fc', border: 'rgba(125,211,252,.22)' },
                    ]
                    return (
                      <div style={{ marginBottom: '16px', padding: '14px 16px', background: 'rgba(8,14,28,0.55)', border: '1px solid rgba(125,211,252,.16)', borderRadius: '14px' }}>
                        <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 800, letterSpacing: '.16em', color: '#7dd3fc', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Robinhood LP evidence</p>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '8px' }}>
                          {sections.map(({ key, title, color, border }) => (
                            <div key={key} style={{ padding: '10px 11px', borderRadius: '10px', background: 'rgba(10,18,32,0.55)', border: `1px solid ${border}` }}>
                              <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '.08em', color, fontFamily: 'var(--font-plex-mono)', marginBottom: '6px', textTransform: 'uppercase' }}>{title}</div>
                              {buckets[key].length === 0
                                ? <div style={{ fontSize: '11px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>None</div>
                                : buckets[key].map((line) => (
                                  <div key={line} style={{ fontSize: '11px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.45, marginBottom: '4px', overflowWrap: 'anywhere' }}>{line}</div>
                                ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

                  {/* ── Compact detail rows ───────────────────────────── */}
                  {(() => {
                    const lpModeVal = getLpMode(result)
                    const lpStatus = result.lpControl?.status
                    const dm3 = result.lpControl?.displayLpModel
                    const hasLiquidity = (result.liquidity ?? 0) > 0
                    const hasPool = hasLiquidity || result.lpControl?.poolAddressPresent
                    const notApplicable = dm3 === 'concentrated_liquidity' || dm3 === 'protocol_or_gauge' || result.lpControl?.proofStatus === 'not_applicable'
                    const protocolPosition = isProtocolPositionModel(result)
                    const liquiditySection = result.sections?.liquidity
                    const canonicalLpMeta = result.lpMeta ?? liquiditySection?.lpMeta ?? {}
                    const canonicalSelectedPool = result.selectedPool ?? (result.pools?.[0] as (Pool & { dex?: string | null; model?: string | null }) | undefined)
                    const canonicalConcentratedProof = result.concentratedPositionProof
                    const canonicalPrimaryDexName = result.primaryDexName
                      ?? canonicalSelectedPool?.dex
                      ?? (typeof canonicalLpMeta?.primaryMarketDex === 'string' ? canonicalLpMeta.primaryMarketDex : undefined)
                      ?? liquiditySection?.pool_protocol
                      ?? ''
                    const isV3PartialPositionProof =
                      canonicalSelectedPool?.model === 'concentrated' &&
                      /uniswap v3/i.test(String(canonicalSelectedPool?.dex || canonicalPrimaryDexName || canonicalLpMeta?.primaryMarketDex || '')) &&
                      canonicalLpMeta?.concentratedProofAttempted === true &&
                      canonicalConcentratedProof?.status === 'partial' &&
                      Boolean(canonicalConcentratedProof?.positionManager)
                    const concentratedPositionProof = canonicalConcentratedProof
                    const isV3Partial = isV3PartialPositionProof || isUniswapV3ConcentratedPartial(result)
                    // Migration risk comes from real migration evidence (lpMigrationProof / riskEngine.lpIntelligence),
                    // never inferred from pool count alone.
                    const migProofStatus = result.lpMigrationProof?.status
                    const migEngineRisk = result.riskEngine?.lpIntelligence?.migrationRisk
                    const migrationRiskRawStatus = (migProofStatus === 'low' || migEngineRisk === 'low') ? 'low'
                      : (migProofStatus === 'flagged' || migEngineRisk === 'high') ? 'flagged'
                      : (migProofStatus === 'watch' || migEngineRisk === 'medium') ? 'watch'
                      : null
                    const migrationRisk = isV3PartialPositionProof ? 'Low'
                      : isUniswapV3ConcentratedPartial(result) ? 'Low'
                      : migrationRiskFinalLabel(migrationRiskRawStatus, { hasPool, reason: result.lpMigrationProof?.reason })
                    const migrationRiskColor = migrationRisk === 'Low' ? '#34d399'
                      : migrationRisk === 'Elevated' ? '#f87171'
                      : migrationRisk === 'Watch' ? '#fbbf24'
                      : undefined
                    const cpp = result.concentratedPositionProof
                    const poolModelLabel = cpp?.poolModel === 'uniswap_v4' ? 'Uniswap V4'
                      : cpp?.poolModel === 'uniswap_v3' ? 'Uniswap V3'
                      : cpp?.poolModel === 'slipstream' ? 'Aerodrome Slipstream'
                      : cpp?.poolModel === 'aerodrome' ? 'Aerodrome'
                      : 'concentrated-liquidity'
                    const controlProofFromAttempt = (() => {
                      if (!protocolPosition || !cpp) return null
                      switch (cpp.status) {
                        case 'verified': return `Verified — top position controlled by ${cpp.topPositionOwner ?? cpp.topPositionOwnerType ?? 'unknown'}`
                        case 'partial': return hasResolvedConcentratedManager(result) ? 'Position manager resolved — owner verification pending' : 'Partial — pool confirmed, but position ownership could not be fully resolved.'
                        case 'not_supported': return `${poolModelLabel} position ownership is not supported yet — top liquidity owner not verified.`
                        case 'not_found': return 'Open Check — pool confirmed with zero active liquidity.'
                        case 'failed': return 'Open Check — position proof attempt failed; no position ownership evidence returned.'
                        default: return 'Open Check — no position ownership evidence returned.'
                      }
                    })()
                    const missingProofHuman = (cpp?.missingEvidence ?? []).map((m) =>
                      m === 'positionManager' ? 'Position manager not supported for this pool model'
                      : m === 'topPositionOwner' ? 'Top liquidity owner not verified'
                      : m === 'positionCount' ? 'Active liquidity positions not indexed'
                      : m === 'topPositionSharePercent' ? 'Position liquidity share not available'
                      : m === 'liquidity' ? 'Liquidity not confirmed'
                      : m === 'slot0' ? 'Pool active state not confirmed'
                      : m === 'poolAddress' ? 'Pool address not confirmed'
                      : m === 'poolId' ? 'Pool ID not confirmed'
                      : String(m).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
                    )
                    const controlProof = result.lpControl?.status === 'team_controlled' || result.lpControl?.proofStatus === 'verified'
                      ? 'Confirmed'
                      : isV3Partial ? 'Owner verification pending'
                      : protocolPosition ? (controlProofFromAttempt ?? (hasResolvedConcentratedManager(result) ? 'Position manager resolved — owner verification pending' : 'Position check unavailable'))
                      : (isRobinhoodScan(result) ? (robinhoodProofCopy(result)?.controllerLabel ?? 'LP controller not verified') : 'Open Check')
                    const lockBurnProof = result.lpControl?.lockStatus === 'locked' || result.lpControl?.burnStatus === 'burned'
                      ? 'Confirmed'
                      : isV3Partial ? 'ERC-20 LP proof not used'
                      : notApplicable ? 'Not Applicable — standard ERC-20 LP-token lock/burn proof does not apply.'
                      : (isRobinhoodScan(result) ? (robinhoodProofCopy(result)?.lockLabel ?? 'LP lock not confirmed') : 'Open Check')
                    const liquidityDepth = result.liquidityDepthRisk === 'low'
                      ? 'Deep'
                      : result.liquidityDepthRisk === 'medium' ? 'Moderate'
                      : result.liquidityDepthRisk === 'high' ? 'Thin'
                      : (result.liquidity ?? 0) > 500_000 ? 'Deep'
                      : (result.liquidity ?? 0) > 50_000 ? 'Moderate'
                      : hasPool ? 'Thin' : 'Open Check'
                    const exitRisk = isV3Partial ? (result.lpExitRisk === 'watch' ? 'Watch' : 'Monitor')
                      : result.lpExitRisk === 'low' ? 'Low'
                      : result.lpExitRisk === 'watch' || result.lpExitRisk === 'monitor' ? 'Watch'
                      : result.lpExitRisk === 'medium' ? 'Monitor'
                      : result.lpExitRisk === 'high' ? 'High' : 'Open Check'
                    const lpControlDisplay = result.lpControl?.status === 'team_controlled' || result.lpControl?.lpControllerType === 'wallet'
                      ? 'Wallet Controlled'
                      : lpModeVal === 'protocol' ? 'Protocol Position Model'
                      : lpStatus === 'burned' ? 'Burned'
                      : lpStatus === 'locked' ? 'Locked'
                      : lpStatus === 'partial' ? 'Partial Evidence'
                      : lpStatus === 'no_pool' ? (isRobinhoodScan(result) ? 'Unavailable' : 'Open Check')
                      : (cleanStatusLabel(lpStatus) === 'Open Check' && isRobinhoodScan(result)
                        ? (robinhoodProofCopy(result)?.controllerLabel ?? 'LP controller not verified')
                        : cleanStatusLabel(lpStatus))
                    // LP Control for concentrated pools mirrors the real position-proof attempt
                    // result instead of a static "required" placeholder — keeps it consistent
                    // with Control Proof rather than showing two contradictory "required" lines.
                    const lpControlFromAttempt = protocolPosition && cpp
                      ? (cpp.status === 'verified' ? 'Verified'
                        : cpp.status === 'partial' ? 'Position proof attempted — partial'
                        : cpp.status === 'not_supported' ? 'Position proof attempted — not supported'
                        : 'Open Check')
                      : null
                    function getV3PartialPositionRows(samplingReason: string | null | undefined, primaryPool: string): { label: string; value: string; color?: string; note?: string }[] {
                      return [
                        { label: 'Primary Liquidity', value: 'Uniswap V3 Concentrated', color: '#c084fc', note: 'Position manager resolved. Pool active/liquidity confirmed.' },
                        { label: 'LP Control', value: 'Position proof attempted — partial', color: '#fbbf24', note: 'Uniswap V3 position manager resolved; owner verification is still pending.' },
                        { label: 'Control Proof', value: 'Owner verification pending', color: '#fbbf24', note: samplingReason || 'No bounded position-candidate source is available yet for this pool.' },
                        { label: 'Lock/Burn Proof', value: 'ERC-20 LP proof not used', note: 'This Uniswap V3 pool uses position-based liquidity, not standard LP tokens.' },
                        { label: 'Position Ownership', value: 'Owner not verified — bounded sample unavailable', color: '#fbbf24', note: 'Top liquidity owner, active position count, and liquidity share are not verified yet.' },
                        { label: 'Exit Risk', value: 'Monitor', color: '#fbbf24', note: 'Deep liquidity is present, but concentrated position ownership is still unresolved.' },
                        { label: 'Liquidity Depth', value: 'Deep', color: '#34d399', note: 'Primary pool liquidity is strong.' },
                        { label: 'Migration Risk', value: 'Low', color: '#34d399', note: 'Primary Uniswap V3 pool remains the dominant liquidity venue.' },
                        { label: 'Primary Pool', value: 'Uniswap V3', note: primaryPool },
                      ]
                    }
                    const rows: { label: string; value: string; color?: string; note?: string }[] = isV3PartialPositionProof ? getV3PartialPositionRows(concentratedPositionProof?.samplingReason, canonicalSelectedPool?.address ?? '') : [
                      { label: 'Primary Liquidity', value: primaryLiquidityModelLabel(result), color: protocolPosition ? '#c084fc' : undefined },
                      { label: 'LP Control', value: isV3Partial ? 'Position proof attempted — partial' : protocolPosition ? (lpControlFromAttempt ?? (hasResolvedConcentratedManager(result) ? 'Position proof attempted — partial' : 'Position check unavailable')) : lpControlDisplay, color: isV3Partial ? '#fbbf24' : lpControlDisplay === 'Wallet Controlled' ? '#fbbf24' : undefined, note: isV3Partial ? 'Position manager resolved and pool liquidity confirmed.' : protocolPosition ? (hasResolvedConcentratedManager(result) ? 'Position manager resolved and pool active/liquidity confirmed. Full owner verification is still unavailable.' : protocolPositionSubtext('control')) : undefined },
                      { label: 'Control Proof', value: controlProof, color: controlProof === 'Confirmed' ? '#34d399' : isV3Partial ? '#fbbf24' : protocolPosition ? '#c084fc' : undefined, note: isV3Partial ? 'Top liquidity owner, active position count, and position share are not verified yet.' : protocolPosition ? (hasResolvedConcentratedManager(result) ? 'The Uniswap V3 position manager was resolved and the pool is active, but ChainLens could not verify the largest liquidity owner from current evidence.' : protocolPositionSubtext('control')) : undefined },
                      { label: 'Lock/Burn Proof', value: lockBurnProof, color: lockBurnProof === 'Confirmed' ? '#34d399' : isV3Partial ? undefined : lockBurnProof === 'Open Check' ? '#fbbf24' : protocolPosition ? '#c084fc' : undefined, note: isV3Partial ? 'This Uniswap V3 pool uses position-based liquidity, not standard LP tokens.' : protocolPosition ? protocolPositionSubtext('lock') : undefined },
                      ...(protocolPosition && cpp ? [{
                        label: 'Position Ownership',
                        value: cpp.status === 'verified' ? 'Attempted — verified'
                          : cpp.status === 'partial' ? 'Owner not verified — bounded sample unavailable'
                          : cpp.status === 'not_supported' ? 'Attempted — unsupported'
                          : cpp.status === 'not_found' ? 'Attempted — open check'
                          : cpp.status === 'failed' ? 'Attempted — provider failed'
                          : 'Attempted — open check',
                        color: cpp.status === 'verified' ? '#34d399' : cpp.status === 'partial' ? '#fbbf24' : undefined,
                        note: cpp.status === 'verified'
                          ? `Top position owner: ${cpp.topPositionOwner ?? 'unknown'} (${cpp.topPositionOwnerType ?? 'unknown'}) · Top share: ${cpp.topPositionSharePercent != null ? `${cpp.topPositionSharePercent.toFixed(2)}%` : 'unknown'} · Controller risk: ${cpp.controllerRisk ?? 'unknown'} · Confidence: ${cpp.confidence ?? 'low'}`
                          : (() => {
                            if (hasResolvedConcentratedManager(result) && cpp.status === 'partial') return cpp.samplingReason ?? 'No bounded position-candidate source is available yet for this pool.'
                            const proofLines = [
                              cpp.positionManager ? 'Position manager resolved' : null,
                              cpp.status === 'partial' && cpp.positionManager ? 'Pool active/liquidity confirmed' : null,
                              ...missingProofHuman,
                            ].filter(Boolean)
                            return proofLines.join(' · ')
                          })(),
                      }] : (protocolPosition ? [{
                        label: 'Position Ownership',
                        value: hasResolvedConcentratedManager(result) ? 'Owner not verified — bounded sample unavailable' : 'Open Check',
                        note: hasResolvedConcentratedManager(result) ? 'No bounded position-candidate source is available yet for this pool.' : protocolPositionSubtext('control'),
                      }] : [])),
                      { label: 'Exit Risk', value: exitRisk, color: exitRisk === 'Low' ? '#34d399' : exitRisk === 'Watch' || exitRisk === 'Monitor' ? '#fbbf24' : exitRisk === 'High' ? '#f87171' : undefined },
                      { label: 'Liquidity Depth', value: liquidityDepth, color: liquidityDepth === 'Deep' ? '#34d399' : liquidityDepth === 'Moderate' ? '#fbbf24' : liquidityDepth === 'Thin' ? '#f87171' : undefined },
                      { label: 'Migration Risk', value: migrationRisk, color: migrationRiskColor },
                      { label: 'Primary Pool', value: result.primaryDexName ?? result.pools?.[0]?.name ?? 'Pool detected' },
                    ]
                    // LP-QUICK-READ, DISCLOSED (Token Scanner section-readability polish task,
                    // explicitly requested: "compact LP quick read summary at the top using
                    // existing values: LP model, Lock/burn proof, Position ownership, Exit risk,
                    // Liquidity depth, Primary pool... then keep detailed evidence below"): pulled
                    // straight from the same `rows` array the detailed list below already renders
                    // — no new derivation, no duplicated logic, just the 6 highest-signal rows
                    // surfaced as short label:value chips before the full evidence list.
                    const quickReadLabels = ['Primary Liquidity', 'Lock/Burn Proof', 'Position Ownership', 'Exit Risk', 'Liquidity Depth', 'Primary Pool']
                    const quickRead = quickReadLabels
                      .map(l => rows.find(r => r.label === l))
                      .filter((r): r is { label: string; value: string; color?: string; note?: string } => r != null)
                    return (
                      <>
                        {quickRead.length > 0 && (
                          <div style={{ marginBottom: '12px', padding: '14px 16px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.16)', borderRadius: '14px' }}>
                            <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 800, letterSpacing: '.16em', color: '#34d399', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>LP Quick Read</p>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '8px' }}>
                              {quickRead.map(({ label, value, color }) => (
                                <div key={label} style={{ padding: '8px 10px', borderRadius: '9px', background: 'rgba(10,18,32,0.55)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                  <div style={{ fontSize: '9px', color: '#5b7590', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>{label === 'Primary Liquidity' ? 'LP Model' : label}</div>
                                  <div style={{ fontSize: '11px', fontWeight: 700, color: color ?? (value === 'Open Check' ? '#fbbf24' : value === 'Confirmed' ? '#34d399' : '#cbd5e1'), fontFamily: 'var(--font-plex-mono)', lineHeight: 1.35, overflowWrap: 'anywhere' }}>{value}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* DETAILED-LP-EVIDENCE-COLLAPSED, DISCLOSED (Token Scanner detail-polish
                            task, explicitly requested: "move the long detailed LP evidence rows
                            into a visually secondary area, label 'Detailed LP evidence', collapsed
                            by default if simple"): same <details>/<summary> pattern already used
                            for "ADVANCED CORTEX DETAILS" on the Overview tab. LP Quick Read above
                            stays fully visible; nothing here is removed, just tucked behind one
                            click since the quick read already answers the 3-second question. */}
                        <details style={{ marginBottom: '14px' }}>
                          <summary className="detail-summary" style={{ cursor: 'pointer', listStyle: 'none', fontSize: '10px', letterSpacing: '.12em', color: '#5b7590', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, padding: '9px 14px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.14)', background: 'rgba(8,14,28,0.50)', display: 'flex', alignItems: 'center', gap: '8px' }}><span className="detail-chevron" aria-hidden="true" style={{ display: 'inline-block', fontSize: '9px' }}>▶</span>DETAILED LP EVIDENCE</summary>
                          <div style={{ marginTop: '10px', padding: '6px 16px', background: 'rgba(8,14,28,0.55)', border: '1px solid rgba(148,163,184,0.10)', borderRadius: '12px' }}>
                            {rows.map(({ label, value, color, note }, i) => (
                              <div key={label} style={{ display: 'grid', gridTemplateColumns: '128px 1fr', gap: '14px', alignItems: 'start', padding: '11px 2px', borderBottom: i < rows.length - 1 ? '1px solid rgba(148,163,184,.07)' : 'none' }}>
                                <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', letterSpacing: '.08em', paddingTop: '1px' }}>{label}</span>
                                <span style={{ fontSize: '11.5px', color: color ?? (value === 'Open Check' ? '#fbbf24' : value === 'Confirmed' ? '#34d399' : '#e2e8f0'), fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{value}{note && <span style={{ display: 'block', marginTop: '4px', color: '#7c8aa0', fontWeight: 500, lineHeight: 1.55 }}>{note}</span>}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      </>
                    )
                  })()}


                  {/* PROTOCOL-SPECIFIC-LP-SECONDARY, DISCLOSED (Token Scanner detail-polish task,
                      explicitly requested: "long protocol-specific explanation should be
                      secondary... default visible LP section should prioritize LP model/lock-burn
                      proof/position ownership/exit risk/liquidity depth/primary pool/good signs/
                      risk signs/missing proofs/next action"): LP Elite Intelligence, LP Controller
                      Intelligence, LP Lock/Burn Intelligence, LP History/Migration, LP Unlock
                      Timeline, LP Movement Watch, Secondary LP Exposure, and the Elite evidence-gaps
                      summary are the long protocol-specific blocks — wrapped in one collapsed-by-
                      default <details> so Good Signs/Risk Signs/Missing Proofs/Next Action (which
                      follow right after this block, unchanged) land on the first visible screen.
                      Nothing here is removed or reworded — one click reveals the exact same content
                      as before. */}
                  <details style={{ marginBottom: '14px' }}>
                  <summary className="detail-summary" style={{ cursor: 'pointer', listStyle: 'none', fontSize: '10px', letterSpacing: '.12em', color: '#5b7590', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, padding: '9px 14px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.14)', background: 'rgba(8,14,28,0.50)', display: 'flex', alignItems: 'center', gap: '8px' }}><span className="detail-chevron" aria-hidden="true" style={{ display: 'inline-block', fontSize: '9px' }}>▶</span>PROTOCOL-SPECIFIC LP INTELLIGENCE</summary>
                  <div style={{ marginTop: '10px' }}>
                  {/* ══════════ LP ELITE INTELLIGENCE ══════════ */}
                  {(result.lpControllerIntel || result.lpMovementWatch || result.lpLockBurnIntel || result.lpUnlockTimeline || result.lpHistoryTimeline) && (() => {
                    const elite = getLpEliteSummary(result)
                    return (
                      <div style={{ marginBottom: '14px', padding: '14px 16px', background: 'linear-gradient(160deg, rgba(34,211,238,0.05), rgba(8,12,28,0.6))', border: '1px solid rgba(148,163,184,0.14)', borderRadius: '16px' }}>
                        <p style={{ margin: 0, fontSize: '11px', fontWeight: 900, letterSpacing: '.20em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>LP Elite Intelligence</p>
                        <p style={{ margin: '8px 0 12px', fontSize: '11px', color: '#cbd5e1', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>{elite.verdict}</p>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: '7px' }}>
                          {elite.chips.map((chip) => (
                            <div key={chip.label} style={{ padding: '8px 10px', borderRadius: '10px', background: 'rgba(2,6,23,0.5)', border: `1px solid ${chip.color}30` }}>
                              <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '.12em', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '4px' }}>{chip.label}</div>
                              <div style={{ fontSize: '11px', color: chip.color, fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'capitalize' }}>{chip.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

                  {/* ── LP Controller Intelligence ──────────────────────── */}
                  {result.lpControllerIntel && (
                    <div style={{ marginBottom: '14px', padding: '13px 15px', background: 'linear-gradient(135deg, rgba(45,212,191,0.08), rgba(15,23,42,0.72))', border: '1px solid rgba(45,212,191,0.20)', borderRadius: '14px', boxShadow: '0 18px 45px rgba(0,0,0,0.18)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div>
                          <p style={{ margin: 0, fontSize: '10px', fontWeight: 900, letterSpacing: '.16em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>LP Controller Intelligence</p>
                          {result.lpControllerIntel.summary && <p style={{ margin: '7px 0 0', fontSize: '11px', color: '#a7f3d0', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{result.lpControllerIntel.summary}</p>}
                        </div>
                        <span style={{ flexShrink: 0, padding: '4px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.10em', color: result.lpControllerIntel.confidence === 'high' ? '#34d399' : '#fbbf24', background: result.lpControllerIntel.confidence === 'high' ? 'rgba(52,211,153,0.10)' : 'rgba(251,191,36,0.10)', border: `1px solid ${result.lpControllerIntel.confidence === 'high' ? 'rgba(52,211,153,0.30)' : 'rgba(251,191,36,0.30)'}`, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                          {result.lpControllerIntel.confidence ?? 'open'}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '7px', marginBottom: '11px' }}>
                        {([
                          ['Controller', result.lpControllerIntel.controller ?? result.lpControllerIntel.controllerLabel ?? 'Open check'],
                          ['Controller Type', isProtocolPositionModel(result) ? 'Protocol Position Model' : cleanStatusLabel(result.lpControllerIntel.controllerType)],
                          ['Controller Share', isProtocolPositionModel(result) ? (result.concentratedPositionProof?.status === 'not_supported' ? 'Position proof attempted — not supported' : 'Position proof attempted — owner unresolved') : result.lpControllerIntel.controllerSharePercent != null ? `${result.lpControllerIntel.controllerSharePercent.toFixed(2)}%` : 'Open Check'],
                          ['Control Proof', isUniswapV3ConcentratedPartial(result) ? (result.lpControllerIntel.controlProofLabel ?? 'Owner verification pending') : isProtocolPositionModel(result) ? (result.lpControllerIntel.controlProofLabel ?? (hasResolvedConcentratedManager(result) ? 'Position manager resolved — owner verification pending' : 'Position check unavailable')) : cleanStatusLabel(result.lpControllerIntel.controlProof)],
                          ['Lock/Burn Proof', isProtocolPositionModel(result) ? 'Not Applicable — standard ERC-20 LP-token lock/burn proof does not apply.' : cleanStatusLabel(result.lpControllerIntel.lockBurnProof)],
                          ['Exit Risk', cleanStatusLabel(result.lpControllerIntel.exitRisk)],
                          ['Liquidity Depth', cleanStatusLabel(result.lpControllerIntel.liquidityDepth)],
                          ['Migration Risk', migrationRiskFinalLabel(result.lpControllerIntel.migrationRisk)],
                        ] as Array<[string, string]>).map(([label, value]) => (
                          <div key={label} style={{ padding: '8px 9px', borderRadius: '10px', background: 'rgba(2,6,23,0.42)', border: '1px solid rgba(148,163,184,0.10)' }}>
                            <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '.10em', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '11px', color: value === 'Confirmed' || value === 'Deep' || value === 'Low' ? '#34d399' : value === 'Open Check' || value === 'Watch' ? '#fbbf24' : '#e2e8f0', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: label === 'Controller' ? 'none' : 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '9px' }}>
                        {[
                          ['Signals', result.lpControllerIntel.signals ?? [], '#34d399'],
                          ['Evidence Gaps', result.lpControllerIntel.evidenceGaps ?? [], '#fbbf24'],
                          ['Next Actions', result.lpControllerIntel.nextActions ?? [], '#67e8f9'],
                        ].map(([title, items, color]) => (
                          <div key={String(title)} style={{ minWidth: 0 }}>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: String(color), fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{String(title)}</p>
                            {(items as string[]).slice(0, 5).map((item) => (
                              <div key={item} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: String(color), fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{item}</p>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── LP Lock/Burn Intelligence ─────────────────── */}
                  {result.lpLockBurnIntel && (
                    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'linear-gradient(135deg, rgba(34,211,238,0.07), rgba(15,23,42,0.72))', border: '1px solid rgba(34,211,238,0.20)', borderRadius: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div>
                          <p style={{ margin: 0, fontSize: '10px', fontWeight: 900, letterSpacing: '.16em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>LP Lock/Burn Intelligence</p>
                          {result.lpLockBurnIntel.summary && <p style={{ margin: '7px 0 0', fontSize: '11px', color: '#bae6fd', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{result.lpLockBurnIntel.summary}</p>}
                        </div>
                        <span style={{ flexShrink: 0, padding: '4px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.10em', color: result.lpLockBurnIntel.lockBurnProof === 'confirmed' ? '#34d399' : result.lpLockBurnIntel.lockBurnProof === 'not_applicable' ? '#94a3b8' : '#fbbf24', background: 'rgba(2,6,23,0.48)', border: '1px solid rgba(34,211,238,0.25)', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                          {isProtocolPositionModel(result) ? 'Protocol-specific' : cleanStatusLabel(result.lpLockBurnIntel.status)}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: '7px', marginBottom: '10px' }}>
                        {([
                          ['Lock/Burn Proof', isProtocolPositionModel(result) ? 'Not Applicable — standard ERC-20 LP-token lock/burn proof does not apply.' : cleanStatusLabel(result.lpLockBurnIntel.lockBurnProof)],
                          ['Locked %', isProtocolPositionModel(result) ? protocolPositionSubtext('lock') : result.lpLockBurnIntel.lockedPercent == null ? 'Open Check' : `${result.lpLockBurnIntel.lockedPercent.toFixed(2)}%`],
                          ['Burned %', isProtocolPositionModel(result) ? 'Protocol-specific' : result.lpLockBurnIntel.burnedPercent == null ? 'Open Check' : `${result.lpLockBurnIntel.burnedPercent.toFixed(2)}%`],
                          ['Unlock Time', result.lpLockBurnIntel.unlockTime == null ? (result.lpLockBurnIntel.unlockTimeStatus === 'not_applicable' ? 'Protocol-specific' : 'Open Check') : new Date(result.lpLockBurnIntel.unlockTime).toLocaleString()],
                          ['Proof Source', isProtocolPositionModel(result) ? 'Pool model' : cleanStatusLabel(result.lpLockBurnIntel.proofSource)],
                          ['Confidence', cleanStatusLabel(result.lpLockBurnIntel.confidence)],
                        ] as Array<[string, string]>).map(([label, value]) => (
                          <div key={label} style={{ padding: '8px 9px', borderRadius: '10px', background: 'rgba(2,6,23,0.42)', border: '1px solid rgba(148,163,184,0.10)', minWidth: 0 }}>
                            <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '.10em', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '11px', color: /confirmed|locked|burned|high/i.test(value) ? '#34d399' : /protocol-specific|position verification/i.test(value) ? '#94a3b8' : /open|unknown|low/i.test(value) ? '#fbbf24' : '#e2e8f0', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '9px' }}>
                        {[
                          ['Signals', result.lpLockBurnIntel.signals ?? [], '#34d399'],
                          ['Gaps', result.lpLockBurnIntel.evidenceGaps ?? [], '#fbbf24'],
                          ['Actions', result.lpLockBurnIntel.nextActions ?? [], '#67e8f9'],
                        ].map(([title, items, color]) => (
                          <div key={String(title)} style={{ minWidth: 0 }}>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: String(color), fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{String(title)}</p>
                            {(items as string[]).slice(0, 4).map((item) => (
                              <div key={item} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: String(color), fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{item}</p>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── LP History / Migration Timeline ─────────────── */}
                  {result.lpHistoryTimeline && (
                    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'linear-gradient(135deg, rgba(96,165,250,0.07), rgba(15,23,42,0.72))', border: '1px solid rgba(96,165,250,0.20)', borderRadius: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div>
                          <p style={{ margin: 0, fontSize: '10px', fontWeight: 900, letterSpacing: '.16em', color: '#93c5fd', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>LP History / Migration</p>
                          {result.lpHistoryTimeline.summary && <p style={{ margin: '7px 0 0', fontSize: '11px', color: '#bfdbfe', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{result.lpHistoryTimeline.summary}</p>}
                        </div>
                        <span style={{ flexShrink: 0, padding: '4px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.10em', color: result.lpHistoryTimeline.migrationRisk === 'high' ? '#f87171' : result.lpHistoryTimeline.migrationRisk === 'low' ? '#34d399' : '#fbbf24', background: 'rgba(2,6,23,0.48)', border: '1px solid rgba(96,165,250,0.25)', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                          {cleanStatusLabel(result.lpHistoryTimeline.status)}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: '7px', marginBottom: '10px' }}>
                        {([
                          ['Migration Risk', migrationRiskFinalLabel(result.lpHistoryTimeline.migrationRisk)],
                          ['Primary Pool Age', result.lpHistoryTimeline.primaryPoolAgeLabel ?? 'Open check'],
                          ['Pool Count', result.lpHistoryTimeline.poolCount == null ? 'Open check' : String(result.lpHistoryTimeline.poolCount)],
                          ['Liquidity', result.lpHistoryTimeline.liquidityUsd == null ? 'Open check' : `$${Math.round(result.lpHistoryTimeline.liquidityUsd).toLocaleString()}`],
                          ['Fragmentation', cleanStatusLabel(result.lpHistoryTimeline.fragmentation)],
                          ['Confidence', result.lpHistoryTimeline.confidence ?? 'low'],
                        ] as Array<[string, string]>).map(([label, value]) => (
                          <div key={label} style={{ padding: '8px 9px', borderRadius: '10px', background: 'rgba(2,6,23,0.42)', border: '1px solid rgba(148,163,184,0.10)', minWidth: 0 }}>
                            <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '.10em', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '11px', color: /high/i.test(value) ? '#f87171' : /low/i.test(value) ? '#34d399' : /open|unknown|watch/i.test(value) ? '#fbbf24' : '#e2e8f0', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '9px' }}>
                        {[
                          ['Events', result.lpHistoryTimeline.events ?? [], '#60a5fa'],
                          ['Signals', result.lpHistoryTimeline.signals ?? [], '#34d399'],
                          ['Gaps', result.lpHistoryTimeline.evidenceGaps ?? [], '#fbbf24'],
                          ['Actions', result.lpHistoryTimeline.nextActions ?? [], '#67e8f9'],
                        ].map(([title, items, color]) => (
                          <div key={String(title)} style={{ minWidth: 0 }}>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: String(color), fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{String(title)}</p>
                            {(items as string[]).slice(0, 4).map((item) => (
                              <div key={item} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: String(color), fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{item}</p>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── LP Unlock Timeline ────────────────────────── */}
                  {result.lpUnlockTimeline && (
                    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'linear-gradient(135deg, rgba(167,139,250,0.07), rgba(15,23,42,0.72))', border: '1px solid rgba(167,139,250,0.20)', borderRadius: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div>
                          <p style={{ margin: 0, fontSize: '10px', fontWeight: 900, letterSpacing: '.16em', color: '#c4b5fd', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>LP Unlock Timeline</p>
                          {result.lpUnlockTimeline.summary && <p style={{ margin: '7px 0 0', fontSize: '11px', color: '#ddd6fe', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{result.lpUnlockTimeline.summary}</p>}
                        </div>
                        <span style={{ flexShrink: 0, padding: '4px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.10em', color: result.lpUnlockTimeline.unlockRisk === 'high' || result.lpUnlockTimeline.unlockRisk === 'expired' ? '#f87171' : result.lpUnlockTimeline.unlockRisk === 'low' || result.lpUnlockTimeline.unlockRisk === 'none' ? '#34d399' : result.lpUnlockTimeline.unlockRisk === 'not_applicable' ? '#94a3b8' : '#fbbf24', background: 'rgba(2,6,23,0.48)', border: '1px solid rgba(167,139,250,0.25)', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                          {isProtocolPositionModel(result) ? 'Protocol-specific' : cleanStatusLabel(result.lpUnlockTimeline.status)}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: '7px', marginBottom: '10px' }}>
                        {([
                          ['Unlock Risk', isProtocolPositionModel(result) ? 'Protocol-specific' : cleanStatusLabel(result.lpUnlockTimeline.unlockRisk)],
                          ['Unlock Time', result.lpUnlockTimeline.unlockTime == null ? (result.lpUnlockTimeline.unlockTimeStatus === 'not_applicable' ? 'Protocol-specific' : 'Open Check') : new Date(result.lpUnlockTimeline.unlockTime).toLocaleString()],
                          ['Countdown', result.lpUnlockTimeline.unlockCountdownLabel ?? 'Open check'],
                          ['Lock State', isProtocolPositionModel(result) ? 'Protocol-specific' : cleanStatusLabel(result.lpUnlockTimeline.lockState)],
                          ['Confidence', result.lpUnlockTimeline.confidence ?? 'low'],
                        ] as Array<[string, string]>).map(([label, value]) => (
                          <div key={label} style={{ padding: '8px 9px', borderRadius: '10px', background: 'rgba(2,6,23,0.42)', border: '1px solid rgba(148,163,184,0.10)', minWidth: 0 }}>
                            <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '.10em', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '11px', color: /high|expired/i.test(value) ? '#f87171' : /low|none/i.test(value) ? '#34d399' : /protocol-specific|position verification/i.test(value) ? '#94a3b8' : /open|unknown|watch/i.test(value) ? '#fbbf24' : '#e2e8f0', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '9px' }}>
                        {[
                          ['Signals', result.lpUnlockTimeline.signals ?? [], '#34d399'],
                          ['Gaps', result.lpUnlockTimeline.evidenceGaps ?? [], '#fbbf24'],
                          ['Actions', result.lpUnlockTimeline.nextActions ?? [], '#67e8f9'],
                        ].map(([title, items, color]) => (
                          <div key={String(title)} style={{ minWidth: 0 }}>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: String(color), fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{String(title)}</p>
                            {(items as string[]).slice(0, 4).map((item) => (
                              <div key={item} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: String(color), fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{item}</p>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}


                  {/* ── LP Movement Watch ─────────────────────────── */}
                  {result.lpMovementWatch && (
                    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'linear-gradient(135deg, rgba(251,191,36,0.07), rgba(15,23,42,0.72))', border: '1px solid rgba(251,191,36,0.20)', borderRadius: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div>
                          <p style={{ margin: 0, fontSize: '10px', fontWeight: 900, letterSpacing: '.16em', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>LP Movement Watch</p>
                          {result.lpMovementWatch.summary && <p style={{ margin: '7px 0 0', fontSize: '11px', color: '#fde68a', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{result.lpMovementWatch.summary}</p>}
                        </div>
                        <span style={{ flexShrink: 0, padding: '4px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.10em', color: result.lpMovementWatch.movementRisk === 'high' ? '#f87171' : result.lpMovementWatch.movementRisk === 'low' || result.lpMovementWatch.movementRisk === 'protected' ? '#34d399' : '#fbbf24', background: 'rgba(2,6,23,0.48)', border: '1px solid rgba(251,191,36,0.25)', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                          {isProtocolPositionModel(result) ? 'Position movement required' : cleanStatusLabel(result.lpMovementWatch.status)}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: '7px', marginBottom: '10px' }}>
                        {([
                          ['Movement Watch', isProtocolPositionModel(result) ? 'Position movement required' : cleanStatusLabel(result.lpMovementWatch.movementRisk)],
                          ['Evidence Model', isProtocolPositionModel(result) ? protocolPositionSubtext('movement') : 'ERC-20 LP-token transfers'],
                          ['Transfer Count', isProtocolPositionModel(result) ? 'Protocol-specific' : result.lpMovementWatch.recentTransferCount == null ? 'Open Check' : String(result.lpMovementWatch.recentTransferCount)],
                          ['Last Movement', isProtocolPositionModel(result) ? 'Position movement required' : result.lpMovementWatch.lastMovementAt ? new Date(result.lpMovementWatch.lastMovementAt).toLocaleString() : 'Open Check'],
                          ['Controller', isUniswapV3ConcentratedPartial(result) ? 'Position manager resolved — owner verification pending' : isProtocolPositionModel(result) ? (hasResolvedConcentratedManager(result) ? 'Position manager resolved — owner verification pending' : 'Position check unavailable') : result.lpMovementWatch.controller ?? cleanStatusLabel(result.lpMovementWatch.controllerType)],
                        ] as Array<[string, string]>).map(([label, value]) => (
                          <div key={label} style={{ padding: '8px 9px', borderRadius: '10px', background: 'rgba(2,6,23,0.42)', border: '1px solid rgba(148,163,184,0.10)', minWidth: 0 }}>
                            <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '.10em', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '11px', color: /high|detected/i.test(value) ? '#f87171' : /low|protected|not confirmed/i.test(value) ? '#34d399' : /open|watch|unknown/i.test(value) ? '#fbbf24' : '#e2e8f0', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: label === 'Controller' ? 'none' : 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '9px' }}>
                        {[
                          ['Signals', result.lpMovementWatch.signals ?? [], '#34d399'],
                          ['Evidence Gaps', result.lpMovementWatch.evidenceGaps ?? [], '#fbbf24'],
                          ['Next Actions', result.lpMovementWatch.nextActions ?? [], '#67e8f9'],
                        ].map(([title, items, color]) => (
                          <div key={String(title)} style={{ minWidth: 0 }}>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: String(color), fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{String(title)}</p>
                            {(items as string[]).slice(0, 4).map((item) => (
                              <div key={item} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: String(color), fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{item}</p>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Secondary LP Exposure ─────────────────────────── */}
                  {result.secondaryLpExposure && (
                    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'linear-gradient(135deg, rgba(148,163,184,0.06), rgba(15,23,42,0.72))', border: '1px solid rgba(148,163,184,0.18)', borderRadius: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div>
                          <p style={{ margin: 0, fontSize: '10px', fontWeight: 900, letterSpacing: '.16em', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Secondary LP Exposure</p>
                          <p style={{ margin: '7px 0 0', fontSize: '11px', color: '#cbd5e1', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{result.secondaryLpExposure.summary ?? 'This is separate from the primary liquidity pool.'} This is separate from the primary liquidity pool.</p>
                        </div>
                        <span style={{ flexShrink: 0, padding: '4px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.10em', color: '#94a3b8', background: 'rgba(2,6,23,0.48)', border: '1px solid rgba(148,163,184,0.25)', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                          secondary LP exposure detected
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: '7px', marginBottom: '10px' }}>
                        {([
                          ['Secondary Pool', result.secondaryLpExposure.pair ?? result.secondaryLpExposure.poolDex ?? 'Secondary ERC-20 LP'],
                          ['Control Proof', cleanStatusLabel(result.secondaryLpExposure.status)],
                          ['Controller Share', result.secondaryLpExposure.controllerSharePercent != null ? `${result.secondaryLpExposure.controllerSharePercent.toFixed(2)}%` : 'Open Check'],
                          ['Controller Type', cleanStatusLabel(result.secondaryLpExposure.controllerType)],
                          ['Lock/Burn Proof', cleanStatusLabel(result.secondaryLpExposure.lockBurnProof)],
                          ['Confidence', cleanStatusLabel(result.secondaryLpExposure.confidence)],
                        ] as Array<[string, string]>).map(([label, value]) => (
                          <div key={label} style={{ padding: '8px 9px', borderRadius: '10px', background: 'rgba(2,6,23,0.42)', border: '1px solid rgba(148,163,184,0.10)', minWidth: 0 }}>
                            <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '.10em', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                            <div style={{ fontSize: '11px', color: '#e2e8f0', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '9px' }}>
                        {[
                          ['Signals', result.secondaryLpExposure.signals ?? [], '#34d399'],
                          ['Evidence Gaps', result.secondaryLpExposure.evidenceGaps ?? [], '#fbbf24'],
                          ['Next Actions', result.secondaryLpExposure.nextActions ?? [], '#67e8f9'],
                        ].map(([title, items, color]) => (
                          <div key={String(title)} style={{ minWidth: 0 }}>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: String(color), fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{String(title)}</p>
                            {(items as string[]).slice(0, 4).map((item) => (
                              <div key={item} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: String(color), fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{item}</p>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── LP Elite: Evidence Gaps + Next Actions ────────── */}
                  {(result.lpControllerIntel || result.lpMovementWatch || result.lpLockBurnIntel || result.lpUnlockTimeline || result.lpHistoryTimeline) && (() => {
                    const elite = getLpEliteSummary(result)
                    if (elite.evidenceGaps.length === 0 && elite.monitor.length === 0) return null
                    return (
                      <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'rgba(2,6,23,0.4)', border: '1px solid rgba(148,163,184,0.12)', borderRadius: '14px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '12px' }}>
                          <div>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#fbbf24', fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Open Checks / Evidence Gaps</p>
                            {elite.evidenceGaps.length > 0 ? elite.evidenceGaps.slice(0, 6).map((gap) => (
                              <div key={gap} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: '#fbbf24', fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{gap}</p>
                              </div>
                            )) : <p style={{ margin: 0, fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>No open evidence gaps.</p>}
                          </div>
                          <div>
                            <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#67e8f9', fontWeight: 900, letterSpacing: '.12em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>What To Monitor Next</p>
                            {elite.monitor.length > 0 ? elite.monitor.map((action) => (
                              <div key={action} style={{ display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' }}>
                                <span style={{ color: '#67e8f9', fontSize: '10px', lineHeight: '15px' }}>•</span>
                                <p style={{ margin: 0, fontSize: '10px', color: '#94a3b8', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>{action}</p>
                              </div>
                            )) : <p style={{ margin: 0, fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>No further actions identified.</p>}
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                  </div>
                  </details>

                  {/* ── Data mode / confidence + Evidence Gaps ────────── */}
                  {(result.lpDataMode || (result.lpEvidenceGaps && result.lpEvidenceGaps.length > 0)) && (
                    <div style={{ marginBottom: '14px' }}>
                      {result.lpDataMode && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                          <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>
                            SCAN MODE: {result.lpDataMode.toUpperCase()}
                          </span>
                          {result.lpDataConfidence && (
                            <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${result.lpDataConfidence === 'high' ? '#34d39940' : result.lpDataConfidence === 'medium' ? '#fbbf2440' : result.lpDataConfidence === 'low' ? '#fb923c40' : '#4a627240'}`, fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: result.lpDataConfidence === 'high' ? '#34d399' : result.lpDataConfidence === 'medium' ? '#fbbf24' : result.lpDataConfidence === 'low' ? '#fb923c' : '#4a6272', fontFamily: 'var(--font-plex-mono)' }}>
                              EVIDENCE CONFIDENCE: {result.lpDataConfidence.toUpperCase()}
                            </span>
                          )}
                          {hasPartialConcentratedOwnershipGap(result) && (
                            <>
                              <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)' }}>
                                POSITION PROOF: PARTIAL
                              </span>
                              <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#fb923c', fontFamily: 'var(--font-plex-mono)' }}>
                                OWNER SAMPLE: UNAVAILABLE
                              </span>
                            </>
                          )}
                        </div>
                      )}
                      {result.lpEvidenceGaps && result.lpEvidenceGaps.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                          {result.lpEvidenceGaps.map((gap) => (
                            <span key={gap.id} title={gap.explanation} style={{ display: 'inline-block', padding: '5px 12px', borderRadius: '999px', background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#fb923c', fontFamily: 'var(--font-plex-mono)' }}>
                              {gap.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── LP Risk Summary ───────────────────────────────── */}
                  {(() => {
                    const rs = getLpRiskSummary(result)
                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '8px', marginBottom: '14px' }}>
                        <div style={{ padding: '12px 14px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#34d399', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Good Signs</p>
                          {rs.goodSigns.length > 0 ? rs.goodSigns.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '5px' }}>
                              <span style={{ color: '#34d399', flexShrink: 0, fontWeight: 800, fontSize: '11px', lineHeight: '16px' }}>✓</span>
                              <p style={{ margin: 0, fontSize: '11px', color: '#86efac', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                            </div>
                          )) : <p style={{ margin: 0, fontSize: '11px', color: '#2a4438', fontFamily: 'var(--font-plex-mono)' }}>No confirmed signal in this category.</p>}
                        </div>
                        <div style={{ padding: '12px 14px', background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#f87171', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Risk Signs</p>
                          {rs.riskSigns.length > 0 ? rs.riskSigns.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '5px' }}>
                              <span style={{ color: '#f87171', flexShrink: 0, fontWeight: 800, fontSize: '11px', lineHeight: '16px' }}>!</span>
                              <p style={{ margin: 0, fontSize: '11px', color: '#fca5a5', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                            </div>
                          )) : <p style={{ margin: 0, fontSize: '11px', color: '#3a2020', fontFamily: 'var(--font-plex-mono)' }}>No confirmed risk signals in this pass.</p>}
                        </div>
                        <div style={{ padding: '12px 14px', background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: '12px' }}>
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{isUniswapV3ConcentratedPartial(result) ? 'Missing concentrated ownership proofs' : 'Missing Proofs'}</p>
                          {rs.missingProofs.length > 0 ? rs.missingProofs.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '5px' }}>
                              <span style={{ color: '#fbbf24', flexShrink: 0, fontWeight: 800, fontSize: '11px', lineHeight: '16px' }}>—</span>
                              <p style={{ margin: 0, fontSize: '11px', color: '#fde68a', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                            </div>
                          )) : (() => {
                            const dmInner = result.lpControl?.displayLpModel
                            const lpModeInner = getLpMode(result)
                            const isNotApplicable = dmInner === 'concentrated_liquidity' || dmInner === 'protocol_or_gauge' || lpModeInner === 'protocol'
                            return isNotApplicable
                              ? <p style={{ margin: 0, fontSize: '11px', color: '#c084fc', fontFamily: 'var(--font-plex-mono)' }}>Standard lock/burn proof does not apply to this pool model.</p>
                              : <p style={{ margin: 0, fontSize: '11px', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>All key LP proofs passed.</p>
                          })()}
                        </div>
                      </div>
                    )
                  })()}

                  {/* ── Next Action ───────────────────────────────────── */}
                  <div style={{ marginBottom: '20px', padding: '14px 18px', background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.20)', borderRadius: '12px' }}>
                    <p style={{ margin: '0 0 7px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Next Action</p>
                    <p style={{ margin: 0, fontSize: '11px', color: '#67e8f9', lineHeight: 1.7, fontFamily: 'var(--font-plex-mono)' }}>{getLpNextAction(result)}</p>
                  </div>
                  {/* ── CORTEX LP Read ────────────────────────────────── */}
                  {result.cortexLpRead && (
                    <div style={{ marginBottom: '20px' }}>
                      <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>CORTEX LP Read</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {[
                          { label: 'Risk Summary', text: result.cortexLpRead.riskSummary },
                          { label: 'Liquidity Analysis', text: result.cortexLpRead.liquidityAnalysis },
                          { label: 'Pool Structure', text: result.cortexLpRead.poolStructureAnalysis },
                          { label: 'Migration Analysis', text: result.cortexLpRead.migrationAnalysis },
                        ].map((sec) => (
                          <div key={sec.label} style={{ padding: '12px 14px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px' }}>
                            <p style={{ margin: '0 0 5px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{sec.label}</p>
                            <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>{sec.text}</p>
                          </div>
                        ))}
                        {/* CRASH-FIX, DISCLOSED (found live-verifying this polish pass, pre-existing
                            bug not introduced by this change — confirmed via `git stash`): a token
                            whose scan returned cortexLpRead but with evidenceGaps/nextActions absent
                            (e.g. no active pool) threw "Cannot read properties of undefined (reading
                            'length')" and crashed the whole result view. Pure null-safety fix — no
                            data/logic change, just guards accessing fields that aren't always
                            present. */}
                        {(result.cortexLpRead.evidenceGaps?.length ?? 0) > 0 && (
                          <div style={{ padding: '12px 14px', background: 'rgba(251,146,60,0.04)', border: '1px solid rgba(251,146,60,0.14)', borderRadius: '10px' }}>
                            <p style={{ margin: '0 0 5px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#fb923c', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Evidence Gaps</p>
                            <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>{result.cortexLpRead.evidenceGaps!.join(' · ')}</p>
                          </div>
                        )}
                        {(result.cortexLpRead.nextActions?.length ?? 0) > 0 && (
                          <div style={{ padding: '12px 14px', background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.14)', borderRadius: '10px' }}>
                            <p style={{ margin: '0 0 5px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Next Action</p>
                            <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>{result.cortexLpRead.nextActions!.join(' ')}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {!planLoading && !isFullAccess && (
                    <div style={{ padding: '24px', border: '1px solid rgba(139,92,246,0.28)', borderRadius: '16px', background: 'rgba(139,92,246,0.06)', textAlign: 'center', marginBottom: '18px' }}>
                      <div style={{ fontSize: '22px', marginBottom: '10px' }}>🔒</div>
                      <p style={{ fontWeight: 700, color: '#f8fafc', margin: '0 0 6px', fontSize: '14px' }}>LP Control Analysis</p>
                      <p style={{ color: '#94a3b8', fontSize: '12px', margin: '0 0 16px', lineHeight: 1.5 }}>LP control checks are included in Pro and Elite.</p>
                      <a href="/pricing" style={{ display: 'inline-block', padding: '8px 20px', borderRadius: '999px', background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: '#fff', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}>Get Access</a>
                    </div>
                  )}
                  {!planLoading && isFullAccess && !result.lpControl && (
                    <div style={{ padding:'14px 18px',marginBottom:'18px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:'10px',fontSize:'12px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>LP control data was not returned in this scan.</div>
                  )}
                  {!planLoading && isFullAccess && result.lpControl && result.lpControl.status === 'unavailable_with_reason' && (
                    <div style={{ padding:'11px 14px',marginBottom:'12px',background:'rgba(100,116,139,0.06)',border:'1px solid rgba(100,116,139,0.18)',borderRadius:'10px',fontSize:'11px',color:'#94a3b8',fontFamily:'var(--font-plex-mono)' }}>
                      LP lock/burn status could not be verified this scan.
                    </div>
                  )}
                  {result.pools && result.pools.length > 0 && (
                    <>
                      <div style={{ display:'flex',alignItems:'baseline',gap:'10px',marginBottom:'10px',flexWrap:'wrap' }}>
                        <p style={{ fontSize:'10px',fontWeight:700,letterSpacing:'0.14em',color:'#3a5268',textTransform:'uppercase',margin:0,fontFamily:'var(--font-plex-mono)' }}>LIQUIDITY &amp; POOLS</p>
                        <div style={{ display:'inline-flex',padding:'3px 9px',borderRadius:'999px',border:'1px solid rgba(125,211,252,.3)',color:'#67e8f9',fontSize:'10px',fontFamily:'var(--font-plex-mono)' }}>{result.pools.length} {result.pools.length===1?'POOL':'POOLS'}</div>
                        <span style={{ fontSize:'11px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>Primary pool selected by liquidity.</span>
                      </div>
                      <div className="pools-scroll" style={{ overflowX:'auto',paddingBottom:'6px',maxWidth:'100%' }}>
                        <div className="pools-inner" style={{ display:'flex',flexDirection:'column',gap:'6px',minWidth:'940px' }}>
                          {[...result.pools].sort((a,b)=>(b.liquidity??0)-(a.liquidity??0)).slice(0,8).map((pool,i)=>(
                            <div key={i} style={{ display:'grid',gridTemplateColumns:'minmax(220px,1.2fr) repeat(6,minmax(82px,auto))',alignItems:'center',gap:'20px',padding:'12px 18px',background:i===0?'linear-gradient(90deg,rgba(45,212,191,0.06),rgba(167,139,250,0.04))':'rgba(255,255,255,0.025)',border:i===0?'1px solid rgba(45,212,191,0.22)':'1px solid rgba(255,255,255,0.06)',borderRadius:'10px',fontSize:'12px',fontFamily:'var(--font-plex-mono)' }}>
                              <span style={{ color:i===0?'#2DD4BF':'#94a3b8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',alignItems:'center',gap:'7px' }}>
                                {i===0&&<span style={{ fontSize:'9px',fontWeight:700,letterSpacing:'.10em',padding:'1px 6px',borderRadius:'999px',border:'1px solid rgba(45,212,191,.35)',color:'#2DD4BF',background:'rgba(45,212,191,.08)',flexShrink:0 }}>PRIMARY</span>}
                                {pool.name??shorten(pool.address??'')}
                              </span>
                              <span style={{ color:'#2DD4BF',whiteSpace:'nowrap' }}>{fmtPrice(pool.price)}</span>
                              <span style={{ color:'#4a6272',whiteSpace:'nowrap' }}>Liq {fmtLarge(pool.liquidity)}</span>
                              <span style={{ color:'#4a6272',whiteSpace:'nowrap' }}>Vol {fmtLarge(pool.volume24h)}</span>
                              <span style={{ color:'#64748b',whiteSpace:'nowrap' }}>APR N/A</span>
                              <span style={{ color:pctColor(pool.priceChange24h),whiteSpace:'nowrap' }}>{fmtPct(pool.priceChange24h)}</span>
                              <span style={{ whiteSpace:'nowrap',color:(pool.liquidity??0)>200000?'#34d399':(pool.liquidity??0)>50000?'#67e8f9':'#fbbf24' }}>{(pool.liquidity??0)>200000?'Excellent':(pool.liquidity??0)>50000?'Healthy':'Weak'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  {(!result.pools||result.pools.length===0)&&(
                    <div style={{ padding:'14px 18px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:'10px',fontSize:'12px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>No pools found for this token.</div>
                  )}
                </>
              )}

              {/* ── RISK CHECKS (CORTEX Risk Engine) ─────────────────── */}
              {activeSection === 'risk-engine' && (
                <>
                  <div style={{ marginBottom: '18px' }}>
                    <p style={{ margin:'0 0 3px',fontSize:'12px',fontWeight:800,letterSpacing:'0.10em',color:'#f43f5e',fontFamily:'var(--font-plex-mono)' }}>CORTEX RISK ENGINE</p>
                    <p style={{ margin:0,fontSize:'11px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>Rug risk scores, contract flags, and simulation results.</p>
                  </div>
                  {!planLoading && !isFullAccess && (
                    <div style={{ padding:'24px',border:'1px solid rgba(139,92,246,0.28)',borderRadius:'16px',background:'rgba(139,92,246,0.06)',textAlign:'center' }}>
                      <div style={{ fontSize:'22px',marginBottom:'10px' }}>🔒</div>
                      <p style={{ fontWeight:700,color:'#f8fafc',margin:'0 0 6px',fontSize:'14px' }}>Full Risk Analysis</p>
                      <p style={{ color:'#94a3b8',fontSize:'12px',margin:'0 0 16px',lineHeight:1.5 }}>Security checks are included in Pro and Elite.</p>
                      <a href="/pricing" style={{ display:'inline-block',padding:'8px 20px',borderRadius:'999px',background:'linear-gradient(135deg,#7c3aed,#a855f7)',color:'#fff',fontWeight:700,fontSize:'12px',textDecoration:'none' }}>Get Access</a>
                    </div>
                  )}
                  {!planLoading && isFullAccess && (() => {
                    const engine = result.riskEngine
                    const _secSim = result.security?.simulation
                    const simAuditUi = tradingSimUiFor(result)
                    const sim = _secSim != null ? {
                      isHoneypot: _secSim.honeypot,
                      buyTax: _secSim.buyTax,
                      sellTax: _secSim.sellTax,
                      transferTax: _secSim.transferTax,
                      simulationSuccess: _secSim.simulationSuccess,
                    } : result.honeypot
                    const simVerified = simAuditUi.badge === 'VERIFIED CLEAR'
                    const simRisk = simAuditUi.badge === 'RISK DETECTED'
                    const lpState = result.lpControl?.status ?? 'unavailable_with_reason'
                    const ownerState = deriveHolderFallbackEvidence(result).ownerStatus
                    const missing2 = getMissingChecks(result)
                    const next2 = getNextAction(result)
                    const lpLabelMap: Record<string, string> = { burned:'Burned', locked:'Locked', protocol:'Protocol-specific', concentrated_liquidity:'Concentrated Liquidity', team_controlled:'Wallet Controlled', wallet_controlled:'Wallet Controlled', partial:'Partial Evidence', no_pool:'Open Check', unavailable_with_reason:'Open Check', unverified:'Open Check', insufficient_data:'Open Check', error:'Open Check', open_check:'Open Check', not_applicable:'Protocol-specific' }
                    const scanEvidence = scanEvidenceFor(result)
                    const normalizedEngineRisk = normalizeRiskScore({
                      rawScore: engine?.riskScore ?? result.riskScore,
                      rawScoreType: 'risk_score',
                      riskDrivers: engine?.riskDrivers,
                      confidence: engine?.confidence,
                      source: 'token_scanner',
                      displayLocation: 'risk_engine_tab',
                      holdersVerified: scanEvidence.holdersVerified,
                    })
                    const displayCortexScore = normalizedEngineRisk.riskScore0To100
                    const displayCortexVerdict = normalizedEngineRisk.riskLabel
                    const displayCortexConfidence = normalizedEngineRisk.confidence
                    const gaugeColor = riskColorFromCanonicalLabel(displayCortexVerdict)
                    const confColor = displayCortexConfidence === 'high' ? '#34d399' : displayCortexConfidence === 'medium' ? '#fbbf24' : displayCortexConfidence === 'low' ? '#94a3b8' : '#fbbf24'
                    const cardBase: React.CSSProperties = { padding:'14px 16px', background:'linear-gradient(145deg,rgba(6,12,24,.94),rgba(14,16,32,.84))', borderRadius:'14px' }
                    const cardTitle: React.CSSProperties = { margin:'0 0 10px',fontSize:'10px',fontWeight:700,letterSpacing:'.14em',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }
                    return (
                      <div style={{ display:'flex', flexDirection:'column', gap:'14px' }}>
                        {/* Hero: gauge + verdict + CORTEX read. RISK-HERO-REDESIGN, DISCLOSED (Token
                            Scanner CORTEX Risk Engine polish task, explicitly requested: "premium
                            hero score card... left side gauge, right side concise summary stack"):
                            gauge sits in its own left column, right column carries the section
                            label, verdict/confidence pills, a static explanatory sentence about how
                            the score is derived, and the CORTEX read note — all vertically centered
                            against the gauge. Same displayCortexScore/Verdict/Confidence values. */}
                        <div style={{ padding:'22px 24px', background:'linear-gradient(160deg,rgba(8,16,32,.98),rgba(4,8,18,.95))', border:`1px solid ${gaugeColor}35`, borderRadius:'20px', boxShadow:`0 0 44px ${gaugeColor}0c` }}>
                          <div style={{ display:'flex', alignItems:'center', gap:'28px', flexWrap:'wrap' }}>
                            <div style={{ flexShrink:0 }}>
                              <RiskGaugeCircle score={displayCortexScore} color={gaugeColor} scoreType="risk" />
                            </div>
                            <div style={{ flex:1, minWidth:'200px', display:'flex', flexDirection:'column', gap:'11px' }}>
                              <div style={{ fontSize:'9px',letterSpacing:'.18em',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>CORTEX RISK ENGINE</div>
                              <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
                                <span style={{ padding:'5px 14px',borderRadius:'999px',fontSize:'11px',fontWeight:800,letterSpacing:'.10em',color:gaugeColor,background:`${gaugeColor}14`,border:`1px solid ${gaugeColor}44`,fontFamily:'var(--font-plex-mono)' }}>
                                  {displayCortexVerdict ?? 'OPEN CHECK'}
                                </span>
                                <span style={{ padding:'5px 10px',borderRadius:'999px',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',color:confColor,background:`${confColor}12`,border:`1px solid ${confColor}38`,fontFamily:'var(--font-plex-mono)' }}>
                                  {displayCortexConfidence === 'low' ? 'Partial confidence' : `${displayCortexConfidence.toUpperCase()} CONFIDENCE`}
                                </span>
                              </div>
                              {riskLabelCopy(displayCortexVerdict, scanEvidence) && (
                                <p style={{ margin:0,fontSize:'11px',color:'#fde68a',fontFamily:'var(--font-plex-mono)',lineHeight:1.5 }}>{riskLabelCopy(displayCortexVerdict, scanEvidence)}</p>
                              )}
                              <p style={{ margin:0,fontSize:'10.5px',color:'#4a6178',fontFamily:'var(--font-plex-mono)',lineHeight:1.5 }}>Risk Score: higher values mean higher risk. Missing checks reduce confidence or add caution, but do not automatically make it extreme.</p>
                              {engine?.cortexRead ? (
                                <div style={{ padding:'10px 12px',borderRadius:'10px',background:'rgba(45,212,191,0.05)',border:'1px solid rgba(45,212,191,0.18)' }}>
                                  <p style={{ margin:0,fontSize:'11px',color:'#99f6e4',lineHeight:1.6,fontFamily:'var(--font-plex-mono)' }}>{engine.cortexRead}</p>
                                </div>
                              ) : (
                                <p style={{ margin:0,fontSize:'11px',color:'#3a5268',fontFamily:'var(--font-plex-mono)',lineHeight:1.5 }}>Rug risk analysis available when upstream APIs respond.</p>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Why this score */}
                        <div style={{ display:'flex', alignItems:'center', gap:'8px', marginTop:'2px' }}>
                          <p style={{ margin:0,fontSize:'9.5px',fontWeight:700,letterSpacing:'.16em',color:'#5b7590',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }}>Why this score</p>
                          <div style={{ flex:1, height:'1px', background:'rgba(255,255,255,0.06)' }} />
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:'12px', alignItems:'start' }}>
                          {/* Risk Drivers — chip/mini-row style instead of a plain text blob. */}
                          <div style={{ ...cardBase, border:'1px solid rgba(244,63,94,0.16)', display:'flex', flexDirection:'column' }}>
                            <p style={{ ...cardTitle, color:'#f47c8f' }}>Risk Drivers</p>
                            <div style={{ display:'flex', flexDirection:'column', gap:'7px' }}>
                              {(engine?.riskDrivers?.length ? engine.riskDrivers : ['No active risk drivers detected.']).map((d, i) => (
                                <div key={i} style={{ display:'flex',gap:'8px',alignItems:'flex-start',padding:'8px 10px',borderRadius:'9px',background:'rgba(244,63,94,0.05)',border:'1px solid rgba(244,63,94,0.10)' }}>
                                  <span style={{ color:'#f47c8f',flexShrink:0,fontSize:'11px',lineHeight:'16px' }}>!</span>
                                  <p style={{ margin:0,fontSize:'11px',color:'#e8b4bc',lineHeight:1.55,fontFamily:'var(--font-plex-mono)' }}>{d}</p>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* LP Control — LP-CONTROL-COMPACTED, DISCLOSED (same polish task, "lower
                              cards too tall/awkward, break long text into bullets or short rows"):
                              the status header row is kept as-is; the key/value list below is now a
                              tighter 2-column mini-grid with smaller gaps/line-height (no fields
                              removed — same rows, same values, just denser presentation). */}
                          {(() => {
                            const lpMode2 = deriveLpMode(result)
                            return (
                              <div style={{ ...cardBase, border:`1px solid ${lpMode2==='protocol'?'rgba(168,85,247,0.22)':'rgba(52,211,153,0.18)'}` }}>
                                <p style={{ ...cardTitle, color: lpMode2==='protocol'?'#a855f7':'#34d399' }}>LP Control</p>
                                <div style={{ display:'flex',alignItems:'center',gap:'8px',marginBottom:'10px',flexWrap:'wrap' }}>
                                  <span style={{ fontSize:'13px',fontWeight:800,color:'#f8fafc',fontFamily:'var(--font-plex-mono)' }}>
                                    {lpMode2==='protocol' ? 'Concentrated Liquidity (v3/v4)' : (lpLabelMap[lpState] ?? lpState.replace(/_/g,' '))}
                                  </span>
                                  {(lpState==='locked'||lpState==='burned') && (
                                    <span style={{ padding:'2px 8px',borderRadius:'999px',fontSize:'9px',fontWeight:700,color:'#34d399',background:'rgba(52,211,153,0.12)',border:'1px solid rgba(52,211,153,0.30)',fontFamily:'var(--font-plex-mono)' }}>VERIFIED</span>
                                  )}
                                  {lpMode2==='protocol' && (
                                    <span style={{ padding:'2px 8px',borderRadius:'999px',fontSize:'9px',fontWeight:700,color:'#a855f7',background:'rgba(168,85,247,0.10)',border:'1px solid rgba(168,85,247,0.30)',fontFamily:'var(--font-plex-mono)' }}>PROTOCOL</span>
                                  )}
                                </div>
                                {(() => {
                                  const poolModel = primaryLiquidityModelLabel(result)
                                  const proofType = lpMode2 === 'protocol' ? 'Position NFT / controller' : result.lpControl?.proofStatus === 'not_applicable' ? 'Not applicable' : 'LP token'
                                  const liquidityDepth = result.lpControllerIntel?.poolLiquidityUsd ?? result.lpHistoryTimeline?.liquidityUsd ?? result.liquidity ?? null
                                  const exitRisk = result.lpExitRiskReason ?? result.lpControllerIntel?.summary ?? (lpState === 'team_controlled' || lpState === 'wallet_controlled' ? 'Pull risk: dominant LP position sits with a normal wallet.' : lpMode2 === 'protocol' ? 'LP token proof may not apply; verify position ownership.' : result.lpControl?.lockBurnReason ?? 'Confirm lock, burn, or controller proof before relying on liquidity.')
                                  // COPY-COMPRESSION, DISCLOSED (Token Scanner detail-polish task,
                                  // explicitly requested: compress "Concentrated primary pool:
                                  // ERC-20 LP token lock/burn proof may not apply." into a shorter
                                  // trader-readable phrase without changing meaning). The fuller
                                  // wording stays available via the `title` tooltip below — nothing
                                  // is deleted, only the default-visible text is shorter.
                                  const reasonFull = lpMode2 === 'protocol'
                                    ? 'Concentrated primary pool: ERC-20 LP token lock/burn proof may not apply.'
                                    : result.lpControl?.reason ?? result.lpControllerIntel?.summary ?? (result.lpControl?.poolAddressPresent ? 'LP controller evidence is incomplete from current providers.' : 'Pool not found from current providers.')
                                  const reason = lpMode2 === 'protocol'
                                    ? 'Standard lock/burn proof may not apply to this pool model.'
                                    : reasonFull
                                  const compactRows: Array<[string, string]> = [
                                    ['Status', lpMode2==='protocol' ? 'Concentrated Liquidity' : (lpLabelMap[lpState] ?? cleanStatusLabel(lpState))],
                                    ['Confidence', cleanStatusLabel(result.lpControl?.confidence ?? result.lpControllerIntel?.confidence ?? result.lpDataConfidence)],
                                    ['Pool model', poolModel],
                                    ['Proof type', proofType],
                                    ['Depth', liquidityDepth != null ? fmtLiquidity(liquidityDepth) : 'Open Check'],
                                  ]
                                  return (
                                    <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
                                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 10px' }}>
                                        {compactRows.map(([label, value]) => (
                                          <div key={label} style={{ minWidth:0 }}>
                                            <div style={{ fontSize:'9px',color:'#5b7590',fontFamily:'var(--font-plex-mono)',marginBottom:'2px' }}>{label}</div>
                                            <div style={{ fontSize:'10.5px',color:'#cbd5e1',lineHeight:1.35,fontFamily:'var(--font-plex-mono)',overflowWrap:'anywhere' }} title={value}>{value}</div>
                                          </div>
                                        ))}
                                      </div>
                                      <div style={{ paddingTop:'8px', borderTop:'1px solid rgba(255,255,255,0.06)', display:'flex', flexDirection:'column', gap:'4px' }}>
                                        <div style={{ fontSize:'9px',color:'#5b7590',fontFamily:'var(--font-plex-mono)' }}>Reason</div>
                                        <p style={{ margin:0,fontSize:'10.5px',color:'#94a3b8',lineHeight:1.45,fontFamily:'var(--font-plex-mono)' }} title={reasonFull !== reason ? reasonFull : undefined}>{reason}</p>
                                        <div style={{ fontSize:'9px',color:'#5b7590',fontFamily:'var(--font-plex-mono)',marginTop:'4px' }}>Exit risk</div>
                                        {/* COPY-COMPRESSION, DISCLOSED (Token Scanner Holder Map + Risk
                                            Engine polish task, explicitly requested: "compress visible
                                            LP Control rows... use short text by default, move longer
                                            explanation into tooltip/title"): exitRisk text is dynamic
                                            (varies by provider/state), so instead of hardcoding a
                                            compressed string per case, it's clamped to 2 lines
                                            visually with the full text always available via title —
                                            same approach as the Reason row above. */}
                                        <p style={{ margin:0,fontSize:'10.5px',color:(lpState==='team_controlled'||lpState==='wallet_controlled') ? '#fda4af' : '#94a3b8',lineHeight:1.45,fontFamily:'var(--font-plex-mono)',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical' as const,overflow:'hidden' }} title={exitRisk}>{exitRisk}</p>
                                      </div>
                                    </div>
                                  )
                                })()}
                              </div>
                            )
                          })()}

                          {/* Ownership / Control */}
                          <div style={{ ...cardBase, border:'1px solid rgba(167,139,250,0.18)' }}>
                            <p style={{ ...cardTitle, color:'#a78bfa' }}>Ownership / Control</p>
                            <div style={{ display:'grid',gap:'7px' }}>
                              {[
                                ['Dev Control', ownerState, ownerState==='Renounced'?'#34d399':ownerState==='Held'?'#fbbf24':'#94a3b8'],
                                ['LP Control', deriveLpMode(result)==='protocol'?'Protocol-Managed':(lpLabelMap[lpState] ?? lpState.replace(/_/g,' ')), '#e2e8f0'],
                              ].map(([label, val, col]) => (
                                <div key={String(label)} style={{ display:'flex',justifyContent:'space-between',alignItems:'center',gap:'8px' }}>
                                  <span style={{ fontSize:'11px',color:'#64748b',fontFamily:'var(--font-plex-mono)' }}>{label}</span>
                                  <span style={{ fontSize:'11px',fontWeight:700,color:String(col),fontFamily:'var(--font-plex-mono)' }}>{val}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Supporting evidence */}
                        <div style={{ display:'flex', alignItems:'center', gap:'8px', marginTop:'4px' }}>
                          <p style={{ margin:0,fontSize:'9.5px',fontWeight:700,letterSpacing:'.16em',color:'#5b7590',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }}>Supporting evidence</p>
                          <div style={{ flex:1, height:'1px', background:'rgba(255,255,255,0.06)' }} />
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:'12px', alignItems:'stretch' }}>
                          {/* Trading Simulation */}
                          <div style={{ ...cardBase, border:`1px solid ${simVerified?'rgba(45,212,191,0.25)':simRisk?'rgba(248,113,113,0.28)':'rgba(148,163,184,0.18)'}` }}>
                            <p style={{ ...cardTitle, color:'#67e8f9' }}>Trading Simulation</p>
                            <div style={{ display:'flex',gap:'6px',marginBottom:'10px',flexWrap:'wrap' }}>
                              <span style={{ padding:'3px 10px',borderRadius:'999px',fontSize:'9px',fontWeight:700,color:simVerified?'#34d399':simRisk?'#f87171':'#94a3b8',background:simVerified?'rgba(52,211,153,0.10)':simRisk?'rgba(248,113,113,0.10)':'rgba(148,163,184,0.08)',border:`1px solid ${simVerified?'rgba(52,211,153,0.30)':simRisk?'rgba(248,113,113,0.30)':'rgba(148,163,184,0.22)'}`,fontFamily:'var(--font-plex-mono)' }}>
                                {simAuditUi.badge}
                              </span>
                              {sim?.isHoneypot === true && (
                                <span style={{ padding:'3px 10px',borderRadius:'999px',fontSize:'9px',fontWeight:700,color:'#f87171',background:'rgba(248,113,113,0.10)',border:'1px solid rgba(248,113,113,0.35)',fontFamily:'var(--font-plex-mono)' }}>HONEYPOT</span>
                              )}
                            </div>
                            <p style={{ margin:'0 0 10px', fontSize:'11px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{simAuditUi.statusLabel}</p>
                            <p style={{ margin:'0 0 10px', fontSize:'10px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{simAuditUi.reason}</p>
                            {simAuditUi.impact && (
                              <p style={{ margin:'0 0 10px', fontSize:'10px', color:'#fde68a', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{simAuditUi.impact}</p>
                            )}
                            {simAuditUi.showTaxRows ? (
                            <div style={{ display:'grid',gap:'6px' }}>
                              {([
                                ['Honeypot', simAuditUi.honeypotValue, sim?.isHoneypot?'#f87171':sim?.isHoneypot===false?'#34d399':'#94a3b8'],
                                ['Buy Tax', simAuditUi.buyTaxValue, sim?.buyTax!=null?(sim.buyTax>8?'#f87171':sim.buyTax>0?'#fbbf24':'#34d399'):'#94a3b8'],
                                ['Sell Tax', simAuditUi.sellTaxValue, sim?.sellTax!=null?(sim.sellTax>8?'#f87171':sim.sellTax>0?'#fbbf24':'#34d399'):'#94a3b8'],
                                ...(sim?.transferTax!=null&&sim.transferTax>0 ? [['Transfer Tax',`${sim.transferTax.toFixed(1)}%`,'#fbbf24'] as [string,string,string]] : []),
                              ] as Array<[string,string,string]>).map(([label,val,col])=>(
                                <div key={label} style={{ display:'flex',justifyContent:'space-between',gap:'8px' }}>
                                  <span style={{ fontSize:'11px',color:'#64748b',fontFamily:'var(--font-plex-mono)' }}>{label}</span>
                                  <span style={{ fontSize:'11px',fontWeight:700,color:col,fontFamily:'var(--font-plex-mono)' }}>{val}</span>
                                </div>
                              ))}
                            </div>
                            ) : null}
                          </div>

                          {/* Contract Flags */}
                          <div style={{ ...cardBase, border:'1px solid rgba(251,191,36,0.18)' }}>
                            <p style={{ ...cardTitle, color:'#fbbf24' }}>Contract Flags</p>
                            <div style={{ display:'grid',gap:'7px' }}>
                              {(() => {
                                const scf = result.security?.contractFlags
                                type BoolFlag = boolean | null | undefined
                                const flagRows: Array<[string, BoolFlag]> = [
                                  ['Mint Function', scf?.mint],
                                  ['Upgradeable / Proxy', scf?.proxy],
                                  ['Blacklist', scf?.blacklist],
                                  ['Pause Control', scf?.pause],
                                  ['Withdraw Control', scf?.withdraw],
                                ]
                                const flagLabel = (v: BoolFlag) =>
                                  v === true ? 'Detected' : v === false ? 'Not detected' : 'Not analyzed'
                                const flagColor = (v: BoolFlag) =>
                                  v === true ? '#f87171' : v === false ? '#34d399' : '#64748b'
                                const flagBg = (v: BoolFlag) =>
                                  v === true ? 'rgba(248,113,113,0.10)' : v === false ? 'rgba(52,211,153,0.08)' : 'rgba(255,255,255,0.04)'
                                const flagBorder = (v: BoolFlag) =>
                                  v === true ? 'rgba(248,113,113,0.30)' : v === false ? 'rgba(52,211,153,0.22)' : 'rgba(255,255,255,0.08)'
                                return flagRows.map(([label, val]) => (
                                  <div key={label} style={{ display:'flex',justifyContent:'space-between',alignItems:'center',gap:'8px' }}>
                                    <span style={{ fontSize:'11px',color:'#94a3b8',fontFamily:'var(--font-plex-mono)' }}>{label}</span>
                                    <span style={{ padding:'2px 8px',borderRadius:'999px',fontSize:'9px',fontWeight:700,fontFamily:'var(--font-plex-mono)',color:flagColor(val),background:flagBg(val),border:`1px solid ${flagBorder(val)}` }}>
                                      {flagLabel(val)}
                                    </span>
                                  </div>
                                ))
                              })()}
                            </div>
                          </div>

                          {/* Open Checks */}
                          <div style={{ ...cardBase, border:'1px solid rgba(251,191,36,0.16)' }}>
                            <p style={{ ...cardTitle, color:'#fbbf24' }}>Open Checks</p>
                            {(() => {
                              const openItems = (engine?.openChecks?.length ? engine.openChecks : missing2)
                              return openItems.length > 0 ? (
                                <div style={{ display:'flex',flexDirection:'column',gap:'5px' }}>
                                  {openItems.map((m, i) => (
                                    <div key={i} style={{ display:'flex',gap:'6px',alignItems:'flex-start' }}>
                                      <span style={{ color:'#fbbf24',flexShrink:0,fontSize:'11px',lineHeight:'16px' }}>⚠</span>
                                      <p style={{ margin:0,fontSize:'11px',color:'#fde68a',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{m}</p>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p style={{ margin:0,fontSize:'11px',color:'#34d399',fontFamily:'var(--font-plex-mono)' }}>All key checks passed.</p>
                              )
                            })()}
                          </div>
                        </div>

                        {/* Verified Signals */}
                        {engine?.verifiedSignals && engine.verifiedSignals.length > 0 && (
                          <div style={{ padding:'14px 16px',background:'rgba(52,211,153,0.04)',border:'1px solid rgba(52,211,153,0.18)',borderRadius:'12px' }}>
                            <p style={{ margin:'0 0 10px',fontSize:'9px',fontWeight:700,letterSpacing:'.14em',color:'#34d399',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }}>Verified Signals</p>
                            {engine.verifiedSignals.map((s, i) => (
                              <div key={i} style={{ display:'flex',gap:'7px',marginBottom:'4px' }}>
                                <span style={{ color:'#34d399',flexShrink:0,fontSize:'11px',lineHeight:'16px' }}>✓</span>
                                <p style={{ margin:0,fontSize:'11px',color:'#86efac',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{s}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Next Action */}
                        <div style={{ padding:'14px 16px',background:'rgba(45,212,191,0.05)',border:'1px solid rgba(45,212,191,0.22)',borderRadius:'12px' }}>
                          <p style={{ margin:'0 0 6px',fontSize:'9px',fontWeight:700,letterSpacing:'.16em',color:'#2DD4BF',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }}>Next Action</p>
                          <p style={{ margin:0,fontSize:'12px',color:'#67e8f9',lineHeight:1.6,fontFamily:'var(--font-plex-mono)' }}>{next2}</p>
                        </div>
                      </div>
                    )
                  })()}
                </>
              )}

              {/* ── DEV CONTROL ─────────────────────────────────────── */}
              {activeSection === 'deployer-intel' && (() => {
                const holderState = deriveHolderState(result)
                const scanEvidence = scanEvidenceFor(result)
                const activeDevIntel = devIntel ?? result.devIntel ?? null
                const clusterAudit = result.devClusterDiagnosisAudit ?? activeDevIntel?.devClusterDiagnosisAudit ?? null
                const top1Early = activeDevIntel?.holderDistribution?.top1 ?? result.holderDistribution?.top1 ?? null
                const top10Early = activeDevIntel?.holderDistribution?.top10 ?? result.holderDistribution?.top10 ?? null
                const top20Early = activeDevIntel?.holderDistribution?.top20 ?? result.holderDistribution?.top20 ?? null
                const clusterUi = clusterAudit ? buildDevMapUiLabels(clusterAudit, {
                  holdersVerified: holderState.kind === 'rowsWithPercent',
                  holderRowsReturned: holderState.rows.length,
                  top1Pct: top1Early,
                  top10Pct: top10Early,
                  top20Pct: top20Early,
                }) : null
                const _safeActorAddr = (a: unknown): string | null => typeof a === 'string' && /^0x[a-f0-9]{40}$/i.test(a) && a.toLowerCase() !== '0x0000000000000000000000000000000000000000' ? a : null
                const creatorAddress = _safeActorAddr(activeDevIntel?.originAddress) ?? _safeActorAddr(clusterAudit?.deployerResolution.originWallet) ?? _safeActorAddr(activeDevIntel?.deployerAddress) ?? _safeActorAddr(result.security?.devOwnership?.ownerAddress) ?? _safeActorAddr(result.security?.devOwnership?.adminAddress) ?? null
                const factoryAddress = _safeActorAddr(activeDevIntel?.factoryAddress) ?? _safeActorAddr(clusterAudit?.deployerResolution.factoryAddress) ?? null
                const creatorStatus = activeDevIntel?.deployerStatus === 'confirmed' ? 'confirmed' : activeDevIntel?.deployerStatus === 'possible_match' ? 'likely' : (creatorAddress ? (result.security?.devOwnership?.ownershipVerified ? 'confirmed' : 'likely') : null)
                const linkedWallets = activeDevIntel?.linkedWallets ?? []
                const graphRan = clusterAudit?.linkedWalletGraph.graphStatus === 'ran_found' || clusterAudit?.linkedWalletGraph.graphStatus === 'ran_none'
                const linkedWalletCount = linkedWallets.length
                const clusterMap = activeDevIntel?.clusterMap ?? result.devIntel?.clusterMap ?? null
                const sc = activeDevIntel?.supplyControl ?? null
                const linkedWalletSupply = sc?.linkedWalletSupplyPercent ?? activeDevIntel?.linkedWalletSupplyPercent ?? activeDevIntel?.linkedWalletSupply ?? null
                const top1 = activeDevIntel?.holderDistribution?.top1 ?? result.holderDistribution?.top1 ?? null
                const top10 = activeDevIntel?.holderDistribution?.top10 ?? result.holderDistribution?.top10 ?? null
                const top20 = activeDevIntel?.holderDistribution?.top20 ?? result.holderDistribution?.top20 ?? null
                const creatorInTop = sc?.creatorInTopHolders ?? activeDevIntel?.creatorInTopHolders ?? null
                const devClusterSupply = sc?.devClusterSupplyPercent ?? activeDevIntel?.devClusterSupplyPercent ?? activeDevIntel?.devClusterSupply ?? null
                const clusterInfluence = sc?.clusterInfluence ?? activeDevIntel?.clusterInfluence ?? null
                const clusterSupplyPercent = clusterInfluence?.clusterSupplyPercent ?? devClusterSupply
                const clusterDominance = clusterInfluence?.clusterDominance ?? (clusterSupplyPercent == null ? 'unknown' : clusterSupplyPercent === 0 ? 'none' : clusterSupplyPercent < 5 ? 'low' : clusterSupplyPercent < 10 ? 'medium' : clusterSupplyPercent < 20 ? 'high' : 'critical')
                const clusterRiskScore = clusterInfluence?.clusterRiskScore ?? null
                const clusterRiskLabel = clusterInfluence?.clusterRiskLabel ?? (clusterSupplyPercent == null ? 'open_check' : 'low')
                const clusterDominanceLabel = clusterUi?.dominanceLabel ?? (clusterDominance === 'unknown' ? (clusterUi?.dominanceLabel ?? 'Not verified') : clusterDominance === 'none' ? 'No dominance' : `${clusterDominance.charAt(0).toUpperCase()}${clusterDominance.slice(1)} dominance`)
                const clusterRiskAccent = clusterRiskLabel === 'critical' || clusterRiskLabel === 'high' ? '#f87171' : clusterRiskLabel === 'elevated' || clusterRiskLabel === 'watch' ? '#fbbf24' : clusterRiskLabel === 'open_check' ? '#94a3b8' : '#34d399'
                // ROBINHOOD-EVIDENCE FIX, DISCLOSED: dev-control/cluster-influence resolved here with
                // this section's OWN real inputs (creatorAddress/holder rows/clusterSupplyPercent) —
                // distinct from robinhoodEvidenceFor()'s conservative top-level defaults, since dev
                // control's real evidence only exists as section-local state.
                const robinhoodDevControl = isRobinhoodScan(result) ? resolveRobinhoodTokenEvidence({
                  chainSlug: 'robinhood', chainId: 4663, tokenAddress: result.contract ?? '',
                  marketData: { hasPrice: result.price != null, hasLiquidity: (result.liquidity ?? 0) > 0, noActivePools: Boolean(result.noActivePools) },
                  poolData: { poolCount: result.pools?.length ?? 0, liquidityUsd: result.liquidity ?? null, poolAddress: null, dexName: result.primaryDexName ?? null, poolModel: result.lpControl?.displayLpModel ?? null },
                  holderData: { topHoldersCount: result.holderDistribution?.topHolders?.length ?? 0, providerStatus: normalizeHolderProviderStatus(result.holderDistributionStatus), providerReason: result.holderDistributionStatus?.reason ?? null, providerAttempted: result.holderDistributionStatus?.status !== undefined },
                  securityData: { attempted: result.honeypot != null, simulationStatus: result.honeypot?.honeypotStatus ?? null, honeypotReason: result.honeypot?.honeypotReason ?? null, isHoneypot: result.honeypot?.isHoneypot ?? null },
                  ownershipData: { ownerAddress: result.security?.devOwnership?.ownerAddress ?? null, adminAddress: result.security?.devOwnership?.adminAddress ?? null, isRenounced: result.security?.devOwnership?.isRenounced ?? null, checkCompleted: result.security?.devOwnership != null },
                  lpData: { proofApplicable: result.lpControl?.proofStatus !== 'not_applicable', controllerType: result.lpControl?.lpControllerType ?? null, controllerVerified: result.lpControl?.status === 'burned' || result.lpControl?.status === 'locked', lockBurnRegistrySupported: false },
                  devControlData: { deployerAddress: creatorAddress, deployerResolved: creatorAddress != null, holderEvidenceAvailable: (result.holderDistribution?.topHolders?.length ?? 0) > 0, clusterSupplyPercent },
                }) : null
                const clusterSignals = (clusterInfluence?.signals?.length ? clusterInfluence.signals : ([clusterInfluence?.reason].filter(Boolean) as string[])).slice(0, 3)
                const suspiciousTransferPattern = activeDevIntel?.suspiciousTransfers ?? false
                const missingChecks = getMissingChecks(result)
                const openChecks = [
                  ...(linkedWalletCount === 0 ? [clusterUi?.linkedEmptyBody ?? 'Cluster wallets not verified'] : []),
                  ...(holderState.kind !== 'rowsWithPercent' ? [clusterUi?.creatorInTopLabel === 'Needs holder evidence' ? 'Needs holder evidence' : 'Holder concentration data remains partial.'] : []),
                ]
                const devSafetyScore = Math.max(10, Math.min(98, Math.round((creatorStatus === 'confirmed' ? 32 : creatorStatus === 'likely' ? 24 : 14) + (linkedWalletCount > 0 ? 18 : 8) + (devClusterSupply != null ? Math.max(0, 25 - Math.round(devClusterSupply / 2)) : 10) + (suspiciousTransferPattern ? 4 : 14))))
                const confidenceLabel = creatorStatus && holderState.kind === 'rowsWithPercent' ? 'HIGH' : creatorStatus || linkedWalletCount > 0 ? 'MEDIUM' : 'LOW'
                const normalizedDevRisk = normalizeRiskScore({
                  rawScore: devSafetyScore,
                  rawScoreType: 'safety_score',
                  riskDrivers: clusterSignals,
                  confidence: confidenceLabel.toLowerCase(),
                  source: 'token_scanner_dev_control',
                  displayLocation: 'dev_tab',
                })
                const score = normalizedDevRisk.riskScore0To100 ?? 0
                const riskLabel = normalizedDevRisk.riskLabel ?? 'Unrated'
                const devRiskColor = riskColorFromCanonicalLabel(normalizedDevRisk.riskLabel)
                const next = getNextAction(result)
                const safeError = devIntelError ? 'Dev intelligence is temporarily unavailable. Retry the scan to refresh this module.' : null

                return (<>
                  <div style={{ marginBottom:'12px', padding:'18px', borderRadius:'14px', border:'1px solid rgba(125,211,252,0.22)', background:'linear-gradient(165deg, rgba(14,24,43,0.95), rgba(8,14,26,0.95))', boxShadow:'0 10px 28px rgba(5,10,25,0.45)' }}>
                    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:'12px',marginBottom:'12px' }}>
                      <div>
                        <p style={{ margin:'0 0 6px',fontSize:'10px',letterSpacing:'.14em',color:'#7dd3fc',fontWeight:700,fontFamily:'var(--font-plex-mono)' }}>CORTEX Dev Control Read</p>
                        <p style={{ margin:0,fontSize:'12px',color:'#cbd5e1',fontFamily:'var(--font-plex-mono)' }}>Deployer identity, wallet cluster connections, and on-chain supply influence — CORTEX dev intelligence layer.</p>
                      </div>
                      <p style={{ margin:0,fontSize:'28px',fontWeight:800,color:devRiskColor,fontFamily:'var(--font-plex-mono)' }}>{score}<span style={{ fontSize:'12px',color:'#64748b' }}>/100 RISK</span></p>
                    </div>
                    <div style={{ display:'flex',gap:'8px',flexWrap:'wrap',marginBottom:'10px' }}>
                      <span style={{ padding:'4px 9px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:devRiskColor,background:`${devRiskColor}18`,border:`1px solid ${devRiskColor}55`,fontFamily:'var(--font-plex-mono)' }}>{riskLabel}</span>
                      <span style={{ padding:'4px 9px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:'#7dd3fc',border:'1px solid rgba(125,211,252,0.26)',fontFamily:'var(--font-plex-mono)' }}>CONFIDENCE {confidenceLabel}</span>
                    </div>
                    <div style={{ height:'8px',borderRadius:'999px',background:'rgba(15,23,42,0.9)',border:'1px solid rgba(255,255,255,0.08)',overflow:'hidden' }}><div style={{ width:`${riskGaugeFillPercent(score)}%`,height:'100%',background:`linear-gradient(90deg, ${devRiskColor}99, ${devRiskColor})` }} /></div>
                  </div>
                  <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))',gap:'10px',marginBottom:'14px' }}>
                    {[
                      { k:'Deployer', v: clusterUi?.deployerLabel ?? (creatorStatus === 'confirmed' ? 'Confirmed' : creatorStatus === 'likely' ? 'Likely matched' : 'Origin wallet not verified') },
                      { k:'Linked Wallets', v: clusterUi?.linkedLabel ?? (graphRan ? (linkedWalletCount > 0 ? `${linkedWalletCount} mapped` : '0 confirmed') : scanEvidence.labels.linkedWallets) },
                      { k:'Supply Control', v: clusterUi?.supplyControlLabel ?? (clusterSupplyPercent != null ? `${clusterSupplyPercent.toFixed(1)}% cluster` : scanEvidence.labels.supplyControl) },
                      { k:'Patterns', v: suspiciousTransferPattern ? 'Suspicious transfers seen' : 'No major pattern flagged' },
                    ].map((item)=><div key={item.k} style={{ padding:'12px',borderRadius:'12px',border:'1px solid rgba(148,163,184,0.2)',background:'rgba(9,15,29,0.82)' }}><p style={{ margin:'0 0 5px',fontSize:'9px',letterSpacing:'.12em',color:'#64748b',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }}>{item.k}</p><p style={{ margin:0,fontSize:'12px',color:'#e2e8f0',fontWeight:700,fontFamily:'var(--font-plex-mono)' }}>{item.v}</p></div>)}
                  </div>
                  <div style={{ display:'flex', gap:'8px', flexWrap:'wrap', marginBottom:'12px' }}>
                    {([['dev-map','Dev Map'],['cluster-map','Cluster Map'],['supply-control','Supply Control'],['history','History'],['watch-plan','Watch Plan']] as Array<[typeof devControlTab, string]>).map(([id,label]) => <button key={id} onClick={() => setDevControlTab(id)} style={{ padding:'8px 12px', borderRadius:'10px', border:devControlTab===id?'1px solid rgba(125,211,252,0.45)':'1px solid rgba(148,163,184,0.2)', background:devControlTab===id?'rgba(14,29,47,0.95)':'rgba(8,14,28,0.6)', color:devControlTab===id?'#7dd3fc':'#94a3b8', fontSize:'10px', letterSpacing:'.10em', textTransform:'uppercase', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{label}</button>)}
                  </div>
                  <div style={{ border:'1px solid rgba(148,163,184,0.2)', borderRadius:'14px', padding:'14px', background:'rgba(7,12,24,0.8)' }}>
                    {devControlTab==='dev-map' && (() => {
                      const fmt = (addr: string | null | undefined) => addr ? `${addr.slice(0,6)}…${addr.slice(-4)}` : null
                      const contractAddr = result.contract ?? null
                      const originAddr = creatorAddress
                      const originLabel = creatorStatus === 'confirmed' ? 'Confirmed deployer' : creatorStatus === 'likely' ? 'Likely deployer' : 'Origin wallet'
                      const originChip = creatorStatus === 'confirmed'
                        ? { label: 'Confirmed', color: '#34d399', bg: 'rgba(52,211,153,.12)', border: 'rgba(52,211,153,.3)' }
                        : creatorStatus === 'likely'
                          ? { label: clusterUi?.originChip ?? 'Partial', color: '#fbbf24', bg: 'rgba(251,191,36,.1)', border: 'rgba(251,191,36,.3)' }
                          : { label: clusterUi?.originChip ?? 'Origin wallet not verified', color: '#94a3b8', bg: 'rgba(148,163,184,.08)', border: 'rgba(148,163,184,.25)' }
                      const confLabel = activeDevIntel?.confidence === 'high' ? 'High confidence' : activeDevIntel?.confidence === 'medium' ? 'Medium confidence' : activeDevIntel?.confidence === 'low' ? 'Low confidence' : 'Evidence-based inference'
                      const chainLabel = (result.chain ?? chain ?? 'unknown').toUpperCase()
                      return (
                        <div style={{ display:'grid', gap:'16px' }}>
                          {/* Intelligence flow: three node cards */}
                          <div style={{ display:'grid', gridTemplateColumns:'1fr auto 1fr auto 1fr', alignItems:'stretch', gap:'6px' }}>
                            {/* Token Contract node */}
                            <div style={{ padding:'12px 14px', borderRadius:'12px', background:'linear-gradient(145deg,rgba(14,24,43,.9),rgba(8,16,32,.85))', border:'1px solid rgba(125,211,252,.28)', display:'flex', flexDirection:'column', gap:'6px' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'2px' }}>
                                <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:'#7dd3fc', flexShrink:0 }} />
                                <span style={{ fontSize:'9px', letterSpacing:'.14em', color:'#7dd3fc', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>TOKEN CONTRACT</span>
                              </div>
                              {contractAddr ? (
                                <span title={contractAddr} style={{ fontSize:'10px', color:'#e2e8f0', fontFamily:'var(--font-plex-mono)', background:'rgba(125,211,252,.08)', border:'1px solid rgba(125,211,252,.18)', borderRadius:'6px', padding:'3px 7px', cursor:'default' }}>{fmt(contractAddr)}</span>
                              ) : (
                                <span style={{ fontSize:'10px', color:'#3a5268', fontFamily:'var(--font-plex-mono)' }}>Address not resolved</span>
                              )}
                              <span style={{ fontSize:'9px', color:'#475569', fontFamily:'var(--font-plex-mono)' }}>{chainLabel} mainnet</span>
                            </div>
                            {/* Arrow */}
                            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', paddingTop:'6px' }}>
                              <span style={{ color:'#2dd4bf', fontSize:'14px', lineHeight:1 }}>→</span>
                            </div>
                            {/* Origin Wallet node */}
                            <div style={{ padding:'12px 14px', borderRadius:'12px', background:'linear-gradient(145deg,rgba(30,20,10,.85),rgba(18,14,6,.9))', border:`1px solid ${originAddr ? 'rgba(251,191,36,.32)' : 'rgba(148,163,184,.18)'}`, display:'flex', flexDirection:'column', gap:'6px' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'2px' }}>
                                <span style={{ width:'6px', height:'6px', borderRadius:'50%', background: originAddr ? '#fbbf24' : '#475569', flexShrink:0 }} />
                                <span style={{ fontSize:'9px', letterSpacing:'.14em', color: originAddr ? '#fbbf24' : '#64748b', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>ORIGIN WALLET</span>
                              </div>
                              {originAddr ? (
                                <span title={originAddr} style={{ fontSize:'10px', color:'#fde68a', fontFamily:'var(--font-plex-mono)', background:'rgba(251,191,36,.08)', border:'1px solid rgba(251,191,36,.2)', borderRadius:'6px', padding:'3px 7px', cursor:'default' }}>{fmt(originAddr)}</span>
                              ) : (
                                <span style={{ fontSize:'10px', color:'#3a5268', fontFamily:'var(--font-plex-mono)' }}>{clusterUi?.originPendingText || 'Origin wallet not verified'}</span>
                              )}
                              <span style={{ display:'inline-flex', alignSelf:'flex-start', padding:'2px 7px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:originChip.color, background:originChip.bg, border:`1px solid ${originChip.border}`, fontFamily:'var(--font-plex-mono)' }}>{originChip.label}</span>
                              {factoryAddress && (
                                <span title={factoryAddress} style={{ fontSize:'9px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)' }}>Factory {fmt(factoryAddress)} · origin kept separate</span>
                              )}
                            </div>
                            {/* Arrow */}
                            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', paddingTop:'6px' }}>
                              <span style={{ color:linkedWallets.length > 0 ? '#2dd4bf' : '#1e3a44', fontSize:'14px', lineHeight:1 }}>→</span>
                            </div>
                            {/* Linked Wallets node */}
                            <div style={{ padding:'12px 14px', borderRadius:'12px', background:'linear-gradient(145deg,rgba(6,20,18,.85),rgba(4,14,14,.9))', border:`1px solid ${linkedWallets.length > 0 ? 'rgba(45,212,191,.28)' : 'rgba(148,163,184,.14)'}`, display:'flex', flexDirection:'column', gap:'6px' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'2px' }}>
                                <span style={{ width:'6px', height:'6px', borderRadius:'50%', background: linkedWallets.length > 0 ? '#2dd4bf' : '#1e3a44', flexShrink:0 }} />
                                <span style={{ fontSize:'9px', letterSpacing:'.14em', color: linkedWallets.length > 0 ? '#2dd4bf' : '#3a5268', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>LINKED WALLETS</span>
                              </div>
                              <span style={{ fontSize:'13px', fontWeight:800, color: linkedWallets.length > 0 ? '#99f6e4' : '#475569', fontFamily:'var(--font-plex-mono)' }}>{clusterUi?.linkedCountDisplay ?? (linkedWallets.length > 0 ? linkedWallets.length : '—')}</span>
                              <span style={{ fontSize:'9px', color: linkedWallets.length > 0 ? '#2dd4bf80' : '#1e3a44', fontFamily:'var(--font-plex-mono)' }}>{clusterUi?.linkedLabel ?? (linkedWallets.length > 0 ? `${linkedWallets.length} wallet${linkedWallets.length !== 1 ? 's' : ''} mapped` : 'Cluster wallets not verified')}</span>
                            </div>
                          </div>

                          {clusterAudit && (
                            <div style={{ padding:'10px 12px', borderRadius:'10px', background:'rgba(15,23,42,.55)', border:'1px solid rgba(148,163,184,.12)', display:'flex', gap:'8px', flexWrap:'wrap' }}>
                              {([
                                clusterAudit.providerHealth.alchemyRpc.health === 'healthy' ? 'Alchemy: healthy' : clusterAudit.providerHealth.alchemyRpc.billingDisabled ? 'Alchemy: billing disabled' : clusterAudit.providerHealth.alchemyRpc.rateLimited ? 'Alchemy: rate limited' : clusterAudit.providerHealth.alchemyRpc.timeout ? 'Alchemy: timeout' : clusterAudit.providerHealth.alchemyRpc.health === 'not_attempted' ? 'Alchemy: not attempted' : `Alchemy: ${clusterAudit.providerHealth.alchemyRpc.skipReason ?? clusterAudit.providerHealth.alchemyRpc.health}`,
                                clusterAudit.providerHealth.blockscout.health === 'healthy' ? 'Blockscout: healthy' : clusterAudit.providerHealth.blockscout.health === 'unsupported' ? 'Blockscout: unsupported' : clusterAudit.providerHealth.blockscout.attempted ? 'Blockscout: failed' : 'Blockscout: not attempted',
                                clusterAudit.providerHealth.goldrush.health === 'healthy' ? 'GoldRush: healthy' : clusterAudit.providerHealth.goldrush.health === 'unsupported' ? 'GoldRush: unsupported' : clusterAudit.providerHealth.goldrush.attempted ? 'GoldRush: failed' : 'GoldRush: not attempted',
                              ] as string[]).map((label) => (
                                <span key={label} style={{ padding:'2px 8px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:'#94a3b8', border:'1px solid rgba(148,163,184,.2)', fontFamily:'var(--font-plex-mono)' }}>{label}</span>
                              ))}
                              <span style={{ padding:'2px 8px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:'#7dd3fc', border:'1px solid rgba(125,211,252,.25)', fontFamily:'var(--font-plex-mono)' }}>{clusterUi?.statusLabel ?? clusterAudit.finalDevMapStatus}</span>
                            </div>
                          )}

                          {/* Origin Wallet detail card */}
                          <div style={{ padding:'14px 16px', borderRadius:'12px', background:'rgba(10,16,30,.7)', border:'1px solid rgba(251,191,36,.18)' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'10px', flexWrap:'wrap' }}>
                              <p style={{ margin:0, fontSize:'10px', letterSpacing:'.14em', fontWeight:700, color:'#fbbf24', fontFamily:'var(--font-plex-mono)' }}>{originLabel.toUpperCase()}</p>
                              <span style={{ padding:'2px 8px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:originChip.color, background:originChip.bg, border:`1px solid ${originChip.border}`, fontFamily:'var(--font-plex-mono)' }}>{originChip.label}</span>
                            </div>
                            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:'8px' }}>
                              {[
                                { label: 'Address', value: originAddr ? fmt(originAddr) : (clusterUi?.originPendingText || 'Origin wallet not verified'), title: originAddr ?? undefined },
                                { label: 'Detection confidence', value: confLabel },
                                { label: 'Evidence source', value: activeDevIntel?.reasons?.[0] ?? (originAddr ? 'Transfer trace' : 'No direct evidence') },
                                { label: 'Network', value: chainLabel },
                              ].map(({ label, value, title }) => (
                                <div key={label} style={{ padding:'8px 10px', borderRadius:'8px', background:'rgba(15,23,42,.5)', border:'1px solid rgba(148,163,184,.1)' }}>
                                  <div style={{ fontSize:'9px', letterSpacing:'.1em', color:'#475569', fontFamily:'var(--font-plex-mono)', marginBottom:'4px' }}>{label.toUpperCase()}</div>
                                  <div title={title} style={{ fontSize:'11px', color:'#cbd5e1', fontWeight:600, fontFamily:'var(--font-plex-mono)', cursor: title ? 'default' : undefined }}>{value ?? '—'}</div>
                                </div>
                              ))}
                            </div>
                            {!originAddr && (
                              <p style={{ margin:'10px 0 0', fontSize:'11px', color:'#475569', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>
                                {clusterUi?.originPendingText || 'Origin wallet not verified. Needs creator tx evidence.'}
                              </p>
                            )}
                            {factoryAddress && originAddr && (
                              <p style={{ margin:'10px 0 0', fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>
                                Factory {fmt(factoryAddress)} detected. Origin wallet is {fmt(originAddr)} — factory and origin are not mixed.
                              </p>
                            )}
                          </div>

                          {/* Linked Wallets list */}
                          <div style={{ padding:'14px 16px', borderRadius:'12px', background:'rgba(6,14,22,.7)', border:'1px solid rgba(45,212,191,.18)' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'10px', flexWrap:'wrap' }}>
                              <p style={{ margin:0, fontSize:'10px', letterSpacing:'.14em', fontWeight:700, color:'#2dd4bf', fontFamily:'var(--font-plex-mono)' }}>LINKED WALLET CLUSTER</p>
                              {linkedWallets.length > 0 && (
                                <span style={{ padding:'2px 8px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:'#2dd4bf', background:'rgba(45,212,191,.1)', border:'1px solid rgba(45,212,191,.28)', fontFamily:'var(--font-plex-mono)' }}>{linkedWallets.length} mapped</span>
                              )}
                            </div>
                            {linkedWallets.length > 0 ? (
                              <div style={{ display:'grid', gap:'7px' }}>
                                {linkedWallets.map((wallet, i) => {
                                  const confColor = wallet.confidence === 'high' ? '#34d399' : wallet.confidence === 'medium' ? '#fbbf24' : '#94a3b8'
                                  return (
                                    <div key={wallet.address + i} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'9px 12px', borderRadius:'9px', background:'rgba(15,23,42,.55)', border:'1px solid rgba(45,212,191,.14)', flexWrap:'wrap' }}>
                                      <span title={wallet.address} style={{ fontSize:'11px', color:'#99f6e4', fontFamily:'var(--font-plex-mono)', fontWeight:600, cursor:'default', letterSpacing:'.04em' }}>{fmt(wallet.address)}</span>
                                      {wallet.confidence && (
                                        <span style={{ padding:'1px 6px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:confColor, background:`${confColor}14`, border:`1px solid ${confColor}38`, fontFamily:'var(--font-plex-mono)' }}>{wallet.confidence}</span>
                                      )}
                                      {wallet.reason && (
                                        <span style={{ fontSize:'10px', color:'#475569', fontFamily:'var(--font-plex-mono)', flex:1, minWidth:'120px' }}>{wallet.reason}</span>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <div style={{ padding:'14px', borderRadius:'10px', background:'rgba(15,23,42,.4)', border:'1px solid rgba(148,163,184,.1)', textAlign:'center' }}>
                                <p style={{ margin:'0 0 4px', fontSize:'11px', color:'#475569', fontFamily:'var(--font-plex-mono)', fontWeight:600 }}>{clusterUi?.linkedEmptyTitle ?? 'Cluster wallets not verified'}</p>
                                <p style={{ margin:0, fontSize:'10px', color:'#2d3f50', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>{clusterUi?.linkedEmptyBody ?? 'Graph not run — transfer evidence was not available in this pass.'}</p>
                              </div>
                            )}
                            {linkedWalletSupply != null && (
                              <div style={{ marginTop:'10px', padding:'8px 12px', borderRadius:'8px', background:'rgba(45,212,191,.06)', border:'1px solid rgba(45,212,191,.15)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                                <span style={{ fontSize:'10px', color:'#2dd4bf80', fontFamily:'var(--font-plex-mono)' }}>Cluster supply influence</span>
                                <span style={{ fontSize:'12px', fontWeight:700, color:'#2dd4bf', fontFamily:'var(--font-plex-mono)' }}>{linkedWalletSupply.toFixed(1)}%</span>
                              </div>
                            )}
                            {linkedWalletSupply == null && linkedWallets.length === 0 && (
                              <p style={{ margin:'10px 0 0', fontSize:'10px', color:'#1e3a44', fontFamily:'var(--font-plex-mono)' }}>Supply influence still needs confirmation — rescan when holder data is available.</p>
                            )}
                          </div>
                        </div>
                      )
                    })()}
                    {devControlTab==='supply-control' && (
                      <div style={{ display:'grid', gap:'10px' }}>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:'8px' }}>
                          {[
                            { label:'Creator in top holders', value: clusterUi?.creatorInTopLabel ?? (creatorInTop==null ? scanEvidence.labels.creatorInTop : creatorInTop ? 'Yes' : 'No'), accent: creatorInTop==null ? '#64748b' : creatorInTop ? '#fbbf24' : '#34d399' },
                            { label:'Top 1 concentration',   value: clusterUi?.top1Label ?? (top1!=null ? `${top1.toFixed(1)}%` : scanEvidence.labels.supplyControl), accent: top1!=null && top1>20 ? '#f87171' : '#94a3b8' },
                            { label:'Top 10 concentration',  value: clusterUi?.top10Label ?? (top10!=null ? `${top10.toFixed(1)}%` : scanEvidence.labels.supplyControl), accent: top10!=null ? (top10>50?'#f87171':top10>30?'#fbbf24':'#34d399') : '#94a3b8' },
                            { label:'Top 20 concentration',  value: clusterUi?.top20Label ?? (top20!=null ? `${top20.toFixed(1)}%` : scanEvidence.labels.supplyControl), accent: top20!=null ? (top20>60?'#f87171':top20>40?'#fbbf24':'#34d399') : '#94a3b8' },
                            { label:'Linked-wallet supply',  value: clusterUi?.linkedWalletSupplyLabel ?? (linkedWalletSupply!=null ? `${linkedWalletSupply.toFixed(1)}%` : 'Needs transfer evidence'), accent:'#2dd4bf' },
                            { label:'Dev cluster supply',    value: clusterUi?.clusterSupplyLabel ?? (devClusterSupply!=null ? `${devClusterSupply.toFixed(1)}%` : scanEvidence.labels.clusterSupply), accent: devClusterSupply!=null ? (devClusterSupply>30?'#f87171':devClusterSupply>15?'#fbbf24':'#34d399') : '#64748b' },
                          ].map(({ label, value, accent }) => (
                            <div key={label} style={{ padding:'10px 12px', borderRadius:'10px', background:'rgba(9,15,29,.8)', border:'1px solid rgba(148,163,184,.14)' }}>
                              <div style={{ fontSize:'9px', letterSpacing:'.1em', color:'#475569', fontFamily:'var(--font-plex-mono)', marginBottom:'5px', textTransform:'uppercase' }}>{label}</div>
                              <div style={{ fontSize:'13px', fontWeight:700, color:accent, fontFamily:'var(--font-plex-mono)' }}>{value}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ padding:'14px 16px', borderRadius:'13px', background:'linear-gradient(145deg, rgba(13,27,43,.92), rgba(6,13,25,.94))', border:`1px solid ${clusterRiskLabel === 'open_check' ? 'rgba(148,163,184,.16)' : 'rgba(45,212,191,.22)'}`, boxShadow:'inset 0 1px 0 rgba(255,255,255,.03)' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', gap:'12px', alignItems:'flex-start', marginBottom:'12px' }}>
                            <div>
                              <p style={{ margin:'0 0 5px', fontSize:'9px', letterSpacing:'.14em', color:'#2dd4bf', fontWeight:800, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>Dev Cluster Influence</p>
                              <p style={{ margin:0, fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>
                                {clusterSupplyPercent == null ? (clusterUi?.supplyControlLabel ?? robinhoodDevControl?.devControlLabel ?? scanEvidence.labels.supplyControl) : `${clusterSupplyPercent.toFixed(1)}% cluster supply`}
                                {' · '}
                                {clusterSupplyPercent == null ? (clusterUi?.watchPlanSummary ?? robinhoodDevControl?.devControlLabel ?? scanEvidence.labels.supplyControl) : clusterInfluence?.reason ?? clusterDominanceLabel}
                              </p>
                            </div>
                            <div style={{ textAlign:'right', flexShrink:0 }}>
                              <p style={{ margin:'0 0 4px', fontSize:'18px', fontWeight:800, color:clusterRiskAccent, fontFamily:'var(--font-plex-mono)' }}>{clusterRiskScore != null ? clusterRiskScore : '—'}<span style={{ fontSize:'10px', color:'#64748b' }}>/100</span></p>
                              <p style={{ margin:0, fontSize:'9px', letterSpacing:'.1em', color:clusterRiskAccent, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{clusterRiskScore != null ? `Risk score ${clusterRiskScore}/100` : (clusterUi?.clusterRiskScoreLabel ?? 'Not verified')}</p>
                            </div>
                          </div>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:'8px', marginBottom:'10px' }}>
                            <div style={{ padding:'9px 11px', borderRadius:'10px', background:'rgba(15,23,42,.72)', border:'1px solid rgba(148,163,184,.12)' }}>
                              <p style={{ margin:'0 0 4px', fontSize:'8px', letterSpacing:'.1em', color:'#475569', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>Cluster supply</p>
                              <p style={{ margin:0, fontSize:'12px', color:clusterSupplyPercent == null ? '#94a3b8' : '#e2e8f0', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{clusterSupplyPercent == null ? (clusterUi?.clusterSupplyLabel ?? robinhoodDevControl?.devControlLabel ?? scanEvidence.labels.clusterSupply) : `${clusterSupplyPercent.toFixed(1)}% cluster supply`}</p>
                            </div>
                            <div style={{ padding:'9px 11px', borderRadius:'10px', background:'rgba(15,23,42,.72)', border:'1px solid rgba(148,163,184,.12)' }}>
                              <p style={{ margin:'0 0 4px', fontSize:'8px', letterSpacing:'.1em', color:'#475569', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>Dominance</p>
                              <p style={{ margin:0, fontSize:'12px', color:clusterRiskAccent, fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{clusterDominanceLabel}</p>
                            </div>
                          </div>
                          <div style={{ display:'grid', gap:'5px' }}>
                            {(clusterSupplyPercent == null ? [clusterUi?.clusterSupplyLabel ?? robinhoodDevControl?.devControlLabel ?? scanEvidence.labels.clusterSupply] : clusterSignals.length > 0 ? clusterSignals : ['No cluster supply found in indexed holders.']).slice(0, 3).map((signal, i) => (
                              <div key={i} style={{ display:'flex', gap:'8px', alignItems:'flex-start' }}>
                                <span style={{ color:clusterRiskAccent, flexShrink:0, fontSize:'10px', lineHeight:'16px' }}>›</span>
                                <p style={{ margin:0, fontSize:'10px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{signal}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                        {devClusterSupply == null && (
                          <div style={{ padding:'11px 14px', borderRadius:'10px', background:'rgba(251,191,36,.04)', border:'1px solid rgba(251,191,36,.14)' }}>
                            <p style={{ margin:0, fontSize:'11px', color:'#78716c', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>{scanEvidence.labels.supplyControl}. Cluster supply is not confirmed from current evidence.</p>
                          </div>
                        )}
                      </div>
                    )}
                    {devControlTab==='cluster-map' && <ClusterMapPanel clusterMap={clusterMap} devIntel={activeDevIntel} holderDistribution={activeDevIntel?.holderDistribution ?? result.holderDistribution ?? null} chain={result.chain ?? null} tokenAddress={result.contract ?? null} tokenSymbol={result.symbol ?? null} tokenName={result.name ?? null} clusterAudit={clusterAudit} holdersVerified={holderState.kind === 'rowsWithPercent'} />}
                    {devControlTab==='history' && (
                      <div style={{ display:'grid', gap:'10px' }}>
                        {activeDevIntel?.reasons && activeDevIntel.reasons.length > 0 ? (
                          <div style={{ padding:'13px 15px', borderRadius:'11px', background:'rgba(125,211,252,.04)', border:'1px solid rgba(125,211,252,.16)' }}>
                            <p style={{ margin:'0 0 7px', fontSize:'9px', letterSpacing:'.14em', color:'#7dd3fc', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>EVIDENCE TRACES</p>
                            <div style={{ display:'grid', gap:'5px' }}>
                              {activeDevIntel.reasons.map((r, i) => (
                                <div key={i} style={{ display:'flex', gap:'8px', alignItems:'flex-start' }}>
                                  <span style={{ color:'#2dd4bf', flexShrink:0, fontSize:'10px', lineHeight:'16px' }}>›</span>
                                  <p style={{ margin:0, fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{r}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div style={{ padding:'13px 15px', borderRadius:'11px', background:'rgba(148,163,184,.04)', border:'1px solid rgba(148,163,184,.14)' }}>
                            <p style={{ margin:0, fontSize:'11px', color:'#3a5268', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>Evidence traces are still being built from available deployer activity. Rescan to refresh.</p>
                          </div>
                        )}
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:'8px' }}>
                          <div style={{ padding:'12px 14px', borderRadius:'11px', background:'rgba(9,15,29,.8)', border:'1px solid rgba(148,163,184,.14)' }}>
                            <p style={{ margin:'0 0 6px', fontSize:'9px', letterSpacing:'.12em', color:'#475569', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>Deployer identity</p>
                            <p style={{ margin:0, fontSize:'11px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>
                              {creatorStatus === 'confirmed'
                                ? 'Deployer identity confirmed — wallet linked to this deployment.'
                                : creatorStatus === 'likely'
                                  ? 'Likely deployer identified from transfer traces — pending direct confirmation.'
                                  : (clusterUi?.originPendingText || 'Origin wallet not verified — needs creator tx evidence.')}
                            </p>
                          </div>
                          <div style={{ padding:'12px 14px', borderRadius:'11px', background:'rgba(9,15,29,.8)', border:`1px solid ${suspiciousTransferPattern ? 'rgba(248,113,113,.22)' : 'rgba(148,163,184,.14)'}` }}>
                            <p style={{ margin:'0 0 6px', fontSize:'9px', letterSpacing:'.12em', color: suspiciousTransferPattern ? '#f87171' : '#475569', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>Transfer patterns</p>
                            <p style={{ margin:0, fontSize:'11px', color: suspiciousTransferPattern ? '#fca5a5' : '#cbd5e1', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>
                              {suspiciousTransferPattern
                                ? 'Suspicious transfer activity flagged — review linked wallet flows before sizing a position.'
                                : 'No suspicious transfer patterns confirmed from current traces.'}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    {devControlTab==='watch-plan' && (
                      <div style={{ display:'grid', gap:'10px' }}>
                        <div style={{ padding:'13px 16px', borderRadius:'12px', background:'rgba(125,211,252,.04)', border:'1px solid rgba(125,211,252,.2)' }}>
                          <p style={{ margin:'0 0 6px', fontSize:'9px', letterSpacing:'.14em', color:'#7dd3fc', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>CORTEX DEV SUMMARY</p>
                          <p style={{ margin:0, fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.6 }}>
                            {`Deployer ${creatorStatus === 'confirmed' ? 'confirmed' : creatorStatus === 'likely' ? 'likely matched' : 'not verified'}. ${clusterUi?.linkedLabel ?? (linkedWalletCount > 0 ? `${linkedWalletCount} linked wallet${linkedWalletCount !== 1 ? 's' : ''} mapped.` : 'Cluster wallets not verified')}. Dev cluster supply ${devClusterSupply != null ? `${devClusterSupply.toFixed(1)}% of circulating.` : (clusterUi?.clusterSupplyLabel ?? scanEvidence.labels.clusterSupply)}`}
                          </p>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:'8px' }}>
                          <div style={{ padding:'12px 14px', borderRadius:'11px', background:'rgba(52,211,153,.04)', border:'1px solid rgba(52,211,153,.18)' }}>
                            <p style={{ margin:'0 0 6px', fontSize:'9px', letterSpacing:'.12em', color:'#34d399', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>CONFIRMED SIGNALS</p>
                            {linkedWalletCount > 0 ? (
                              <p style={{ margin:0, fontSize:'11px', color:'#86efac', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{linkedWalletCount} linked wallet connection{linkedWalletCount !== 1 ? 's' : ''} mapped from transfer evidence.</p>
                            ) : creatorStatus ? (
                              <p style={{ margin:0, fontSize:'11px', color:'#86efac', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>Deployer {creatorStatus === 'confirmed' ? 'identity confirmed' : 'likely matched'} from on-chain traces.</p>
                            ) : (
                              <p style={{ margin:0, fontSize:'11px', color:'#374151', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>No confirmed signals from available data this pass.</p>
                            )}
                          </div>
                          <div style={{ padding:'12px 14px', borderRadius:'11px', background:'rgba(251,191,36,.04)', border:'1px solid rgba(251,191,36,.18)' }}>
                            <p style={{ margin:'0 0 6px', fontSize:'9px', letterSpacing:'.12em', color:'#fbbf24', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>OPEN CHECKS</p>
                            {openChecks.length > 0 ? (
                              <div style={{ display:'grid', gap:'4px' }}>
                                {openChecks.map((c, i) => <p key={i} style={{ margin:0, fontSize:'11px', color:'#fde68a', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{c}</p>)}
                              </div>
                            ) : (
                              <p style={{ margin:0, fontSize:'11px', color:'#374151', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>No additional open checks.</p>
                            )}
                          </div>
                        </div>
                        <div style={{ padding:'12px 14px', borderRadius:'11px', background:'rgba(45,212,191,.04)', border:'1px solid rgba(45,212,191,.18)' }}>
                          <p style={{ margin:'0 0 6px', fontSize:'9px', letterSpacing:'.12em', color:'#2dd4bf', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>NEXT ACTION</p>
                          <p style={{ margin:0, fontSize:'11px', color:'#99f6e4', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>{next}</p>
                        </div>
                      </div>
                    )}
                  </div>
                  {devIntelLoading && <div style={{ marginTop:'10px', padding:'10px 12px', border:'1px solid rgba(125,211,252,0.22)', borderRadius:'10px', color:'#7dd3fc', fontSize:'11px', fontFamily:'var(--font-plex-mono)' }}>Loading dev intelligence…</div>}
                  {safeError && <div style={{ marginTop:'10px', padding:'10px 12px', border:'1px solid rgba(251,191,36,0.28)', borderRadius:'10px', color:'#fcd34d', fontSize:'11px', fontFamily:'var(--font-plex-mono)' }}>{safeError}</div>}
                  {missingChecks.length > 0 && <p style={{ margin:'10px 2px 0',fontSize:'10px',color:'#64748b',fontFamily:'var(--font-plex-mono)' }}>Open verification items: {missingChecks.slice(0,2).join(' · ')}</p>}
                </>)
              })()}
            </div>


          )}
        </div>

        {/* ── Right: CORTEX receipt panel ─────────────────────────── */}
        <aside className="mob-verdict-panel" style={{
          width: 'clamp(300px, 22vw, 380px)',
          minWidth: 0,
          flexShrink: 0,
          borderLeft: '1px solid rgba(99,102,241,0.18)',
          background: 'linear-gradient(180deg, rgba(7,11,24,.98), rgba(5,8,18,.98))',
          overflowY: 'auto',
          padding: '26px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}>
          {/* Label + badge */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <span style={{
                width: '7px', height: '7px', borderRadius: '50%',
                background: clarkLoading ? '#22d3ee' : clarkVerdict ? '#22d3ee' : '#162230',
                boxShadow: (clarkLoading || clarkVerdict) ? '0 0 10px rgba(34,211,238,0.85)' : 'none',
                flexShrink: 0,
                transition: 'all 0.3s',
                ...((!clarkLoading && !clarkVerdict) ? {} : { animation: 'liveDotPulse 2.2s ease-in-out infinite' }),
              }} />
              <p style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                color: '#22d3ee', fontFamily: 'var(--font-plex-mono)',
                textTransform: 'uppercase', margin: 0,
              }}>
                CORTEX RECEIPT
              </p>
            </div>
            {(!clarkLoading && !clarkVerdict && !clarkError) && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '99px', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: 'rgba(34,211,238,0.85)', fontFamily: 'var(--font-plex-mono)' }}>
                <span className="live-dot" style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 6px #22d3ee', flexShrink: 0 }} />
                LIVE · Powered by CORTEX
              </div>
            )}
          </div>

          {/* Free-tier locked state */}
          {!planLoading && !isFullAccess && (
            <div style={{textAlign:'center',padding:'8px 0'}}>
              <div style={{fontSize:'22px',marginBottom:'10px'}}>🔒</div>
              <p style={{fontWeight:700,color:'#f8fafc',margin:'0 0 6px',fontSize:'13px',fontFamily:'var(--font-inter,Inter,sans-serif)'}}>Full CORTEX Verdict</p>
              <p style={{color:'#94a3b8',fontSize:'11px',margin:'0 0 16px',lineHeight:1.5,fontFamily:'var(--font-inter,Inter,sans-serif)'}}>Security analysis and CORTEX verdicts are included in Pro and Elite.</p>
              <a href="/pricing" style={{display:'inline-block',padding:'8px 20px',borderRadius:'999px',background:'linear-gradient(135deg,#7c3aed,#a855f7)',color:'#fff',fontWeight:700,fontSize:'12px',textDecoration:'none'}}>Get Access</a>
            </div>
          )}

          {/* Idle — CORTEX Receipt checklist, DISCLOSED (Token Scanner final polish task): the
              old idle state used the SAME filled check-icon as a completed receipt, which read as
              "already confirmed" for sections that don't exist yet. Now uses a hollow pending dot
              + an explicit "AWAITING SCAN" tag so the preview honestly reads as a preview, not a
              fake result. No receipt content is generated here — still just the section names. */}
          {!planLoading && isFullAccess && !clarkLoading && !clarkVerdict && !clarkError && !solanaResult && (
            /* RECEIPT-IDLE-POLISH, DISCLOSED (Token Scanner final polish task, explicitly requested:
               "the right receipt looks like a real waiting system, not faded/dead" — brighter
               checklist labels/separators and a more readable AWAITING SCAN badge, still honestly a
               preview: hollow pending dots, no fake completed state, no invented content). */
            <div style={{ background: 'rgba(9,16,30,.75)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '14px', padding: '15px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'rgba(34,211,238,.70)', flexShrink: 0 }} />
                  <p style={{ margin: 0, fontSize: '10px', fontWeight: 700, color: '#7690a8', letterSpacing: '.16em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>CORTEX Receipt</p>
                </div>
                <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '.10em', padding: '3px 8px', borderRadius: '999px', color: 'rgba(34,211,238,.85)', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.28)', fontFamily: 'var(--font-plex-mono)' }}>
                  AWAITING SCAN
                </span>
              </div>
              <p style={{ margin: '0 0 14px', fontSize: '10px', color: '#4a5f78', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>
                Scan a token to generate a structured risk receipt.
              </p>
              {[
                { label: 'Verdict' },
                { label: 'Market Read' },
                { label: 'Holder / Supply Read' },
                { label: 'LP / Risk Read' },
                { label: 'Dev Control' },
                { label: 'Next Action' },
              ].map((sec, idx) => (
                <div key={sec.label} style={{ display: 'flex', alignItems: 'center', gap: '9px', paddingTop: idx > 0 ? '9px' : 0, marginTop: idx > 0 ? '9px' : 0, borderTop: idx > 0 ? '1px solid rgba(255,255,255,0.09)' : 'none' }}>
                  <span style={{ width: '16px', height: '16px', borderRadius: '50%', border: '1px solid rgba(148,163,184,0.50)', flexShrink: 0 }} />
                  <span style={{ fontSize: '10.5px', fontWeight: 600, color: '#8ea0b5', fontFamily: 'var(--font-plex-mono)', letterSpacing: '.02em' }}>{sec.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* SOLANA BETA RECEIPT, DISCLOSED (Token Scanner Solana UI parity task): updates the
              right rail exactly like every other chain does once a scan completes — replaces the
              "AWAITING SCAN" checklist rather than leaving it stuck idle. Built from solanaResult
              only; never coerced through deriveVerdictInput/calculateCortexScoreV2 (EVM-shaped). */}
          {/* PLAIN-LANGUAGE RECEIPT REWRITE, DISCLOSED (reported live: "a lot of it is open check
              and not actual facts", and "make the CORTEX verdict on the side very simple to read
              for users and factual and beneficial").
              WHAT CHANGED AND WHY: the previous version of this rail printed FIVE fixed strings —
              "Solana pool authority remains open check" and "Review concentration, pool depth, and
              authority status" were hardcoded and IDENTICAL on every scan, and the other three only
              said whether a check had *data*, never what the data actually was. That is what read
              as "open check, not facts": a token with a verified Raydium pool, $180K liquidity and
              revoked authorities produced word-for-word the same rail as a token with none of it.
              This version states the REAL resolved values (liquidity, age, top-10 share, holder
              count, pool program, authority state) in plain sentences, and where a value genuinely
              did not resolve it says so specifically ("Holder data didn't load this scan") instead
              of the "open check" placeholder. Nothing new is fetched and nothing is inferred —
              every line below reads a field the scan already carried, and the verdict is the same
              9-category engine the Risk Engine tab shows, so the two can never disagree. */}
          {!planLoading && isFullAccess && solanaResult && (() => {
            const sr = solanaResult
            const cx = computeSolanaCortexRisk(sr)
            const md = sr.marketData
            const conc = sr.topAccountConcentration
            const usd = (v: number | null | undefined) =>
              v == null || !Number.isFinite(v) ? null
              : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M`
              : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`
            const ss: React.CSSProperties = { padding: '10px 12px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '10px', background: 'rgba(10,17,32,.72)' }
            const stitle: React.CSSProperties = { margin: '0 0 6px', fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', color: '#5b7590', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }
            const sbody: React.CSSProperties = { margin: 0, fontSize: '11px', color: '#cbd5e1', lineHeight: 1.65, fontFamily: 'var(--font-plex-mono)' }

            // One plain sentence per verdict tier — what this actually means for a person, in
            // words, mapped 1:1 off the engine's own five-tier vocabulary (no new judgement).
            const verdictMeaning: Record<typeof cx.verdict, string> = {
              'Low Contract Risk': 'The contract checks came back clean and this token has real trading history behind it.',
              Speculative: 'Nothing broken in the contract, but this is still a speculative token — size positions accordingly.',
              'High Speculation': 'Tradeable, but the evidence points to a highly speculative token. Treat it as high risk.',
              'High Risk': 'Real risk signals showed up in this scan. Read the warnings below before buying.',
              'Critical Risk': 'Critical risk signals showed up — the owner can still take actions that cost holders money.',
            }

            // Every line is a real resolved value, or a specific reason it did not resolve.
            const authorityLine = !sr.authorityReadSucceeded
              ? 'The mint account could not be read this scan, so authority status is genuinely unknown — not confirmed safe.'
              : sr.mintAuthority && sr.freezeAuthority ? 'The owner can still mint new supply AND freeze your tokens. Both authorities are active.'
              : sr.mintAuthority ? 'The owner can still mint new supply. Freeze authority is revoked.'
              : sr.freezeAuthority ? 'The owner can still freeze your tokens. Mint authority is revoked.'
              : 'Mint and freeze authority are both revoked — supply is fixed and your tokens cannot be frozen.'

            const liq = usd(md?.liquidityUsd)
            const marketLine = !sr.marketDataAvailable ? 'No trading pool for this token is indexed yet, so there is no market to read.'
              : [
                  liq ? `${liq} liquidity` : null,
                  usd(md?.volume24hUsd) ? `${usd(md?.volume24hUsd)} traded in 24h` : null,
                  md?.pairAgeDays != null ? (md.pairAgeDays < 1 ? 'pool opened under a day ago' : `pool is ${md.pairAgeDays} day${md.pairAgeDays === 1 ? '' : 's'} old`) : null,
                ].filter(Boolean).join(' · ') || 'A pool is indexed, but its depth and volume did not resolve this scan.'

            const holderLine = conc?.top10Percent == null
              ? 'Holder data did not load this scan, so concentration is unknown — not confirmed healthy.'
              : `${conc.top10Percent < 30 ? 'Well spread' : conc.top10Percent < 50 ? 'Somewhat concentrated' : 'Heavily concentrated'} — the top 10 accounts hold ${conc.top10Percent.toFixed(1)}% of supply${sr.heliusHolders?.success && sr.heliusHolders.holderCount != null ? `, across ${sr.heliusHolders.holderCount}${sr.heliusHolders.isLowerBound ? '+' : ''} holders` : ''}. Some of that can be the pool's own vault.`

            const poolLine = sr.poolProgram.resolved && sr.poolProgram.label
              ? `Liquidity sits in a verified ${sr.poolProgram.label} pool${liq ? ` holding ${liq}` : ''}.`
              : sr.poolProgram.poolAddress
                ? 'A pool exists, but it is not run by an AMM program this scanner recognises — verify it before trading.'
                : 'No pool contract was confirmed on-chain this scan.'

            // The single highest-value next step, taken from the engine's own real gap list.
            const nextAction = cx.nextActions[0] ?? 'No further action required'

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
                <div style={{ padding: '16px', border: `1px solid ${cx.verdictColor}22`, borderRadius: '14px', background: 'linear-gradient(135deg,rgba(8,20,38,.92),rgba(14,12,38,.90))', boxShadow: `0 0 18px ${cx.verdictColor}08` }}>
                  <div style={{ fontSize: '9px', letterSpacing: '.16em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '10px' }}>CORTEX RECEIPT · SOLANA</div>
                  <div style={{ fontSize: '17px', fontWeight: 800, color: cx.verdictColor, fontFamily: 'var(--font-plex-mono)' }}>{cx.verdict}</div>
                  <div style={{ fontSize: '10px', color: '#7c93aa', fontFamily: 'var(--font-plex-mono)', marginTop: '3px' }}>{cx.score}/{cx.scoreMax} overall · {cx.overallConfidence.toLowerCase()} evidence confidence</div>
                  <p style={{ margin: '10px 0 0', fontSize: '11px', color: '#cbd5e1', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>{verdictMeaning[cx.verdict]}</p>
                </div>
                <div style={ss}><p style={stitle}>Can the owner touch your tokens?</p><p style={sbody}>{authorityLine}</p></div>
                <div style={ss}><p style={stitle}>Is there a real market?</p><p style={sbody}>{marketLine}</p></div>
                <div style={ss}><p style={stitle}>Who holds the supply?</p><p style={sbody}>{holderLine}</p></div>
                <div style={ss}><p style={stitle}>Where is the liquidity?</p><p style={sbody}>{poolLine}</p></div>
                <div style={ss}><p style={stitle}>Do this next</p><p style={sbody}>{nextAction}</p></div>
              </div>
            )
          })()}

          {/* Loading dots */}
          {!planLoading && isFullAccess && clarkLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 0' }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{
                  width: '5px', height: '5px', borderRadius: '50%',
                  background: '#2DD4BF', display: 'inline-block',
                  animation: `clarkDot 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          )}

          {/* Error */}
          {!planLoading && isFullAccess && clarkError && (
            <p style={{
              fontSize: '12px', color: '#fca5a5',
              fontFamily: 'var(--font-plex-mono)', margin: 0, lineHeight: 1.6,
            }}>
              {clarkError}
            </p>
          )}

          {/* Verdict */}
          {!planLoading && isFullAccess && result && (() => {
            const d = deriveVerdictInput(result)
            const hp = result.honeypot
            const simUi = tradingSimUiFor(result)
            const buyTax = hp?.buyTax ?? null
            const sellTax = hp?.sellTax ?? null
            const liq = result.liquidity ?? 0
            const poolCount = result.pools?.length ?? 0
            const top10 = result.holderDistribution?.top10
            const top20 = result.holderDistribution?.top20
            const taxesHigh = (buyTax != null && buyTax > 8) || (sellTax != null && sellTax > 8)
            const scanEvidence = scanEvidenceFor(result)
            const sidebarRisk = normalizeRiskScore({
              rawScore: result.riskScore,
              rawScoreType: result.riskScoreType ?? 'risk_score',
              riskDrivers: result.riskEngine?.riskDrivers,
              confidence: result.riskEngine?.confidence,
              source: 'token_scanner',
              displayLocation: 'right_rail',
              holdersVerified: scanEvidence.holdersVerified,
            })
            const verdict = sidebarRisk.riskLabel ?? 'Open Check'
            const verdictColor = riskColorFromCanonicalLabel(sidebarRisk.riskLabel)
            const bull = [
              liq > 1_000_000 ? `Deep liquidity — ${fmtLarge(liq)} pool depth.` : liq > 200_000 ? `Moderate liquidity — ${fmtLarge(liq)} pool depth.` : liq > 0 ? 'Liquidity present.' : '',
              d.hasMarketData ? 'Live market data confirmed.' : '',
              simUi.statusLabel === 'Verified clear' ? 'No honeypot — sell simulation passed.' : '',
              poolCount > 1 ? `${poolCount} active pools detected.` : poolCount === 1 ? 'Primary pool active.' : '',
              d.holderState.kind !== 'noRowsFallback' ? 'Holder distribution data is available.' : '',
            ].filter(Boolean).slice(0, 3)
            const bear = [
              d.holderState.kind === 'noRowsFallback' ? 'Holder concentration not confirmed — treat as incomplete risk check.' : '',
              taxesHigh ? `Elevated taxes — buy ${buyTax?.toFixed(1)}% / sell ${sellTax?.toFixed(1)}%.` : '',
              liq > 0 && liq < 50000 ? `Thin liquidity — ${fmtLarge(liq)}, high slippage risk.` : '',
              result.marketCapUsd == null ? 'Market cap not verified — supply unconfirmed.' : '',
              simUi.treatAsOpenRisk && simUi.statusLabel !== 'Risk detected' ? `${simUi.statusLabel}. ${simUi.reason}` : '',
            ].filter(Boolean).slice(0, 3)
            const missingChecks = [
              result.noActivePools ? 'Active pool' : '',
              d.holderState.kind !== 'rowsWithPercent' ? 'Holder concentration' : '',
              'Supply spread', 'LP lock',
              d.fallbackEvidence.ownerStatus === 'Open check' ? 'Owner status' : '',
              result.marketCapUsd == null ? 'Market cap' : '',
            ].filter(Boolean)
            // Canonical Risk Score: higher is riskier on every Token Scanner surface.
            const sidebarScore = sidebarRisk.riskScore0To100
            const sidebarScoreColor = verdictColor
            // Critical risks (top 3 actionable)
            const criticalRisks: string[] = [
              hp?.isHoneypot === true ? 'HONEYPOT detected — do not trade.' : null,
              taxesHigh ? `High taxes — buy ${buyTax?.toFixed(1)}% / sell ${sellTax?.toFixed(1)}%.` : null,
              result.noActivePools ? 'No active liquidity pool found.' : null,
              liq > 0 && liq < 10000 ? `Very thin liquidity — ${fmtLarge(liq)}.` : liq > 0 && liq < 50000 ? `Thin liquidity — ${fmtLarge(liq)}.` : null,
              d.holderState.kind === 'noRowsFallback' ? 'Holder concentration not confirmed.' : null,
              simUi.treatAsOpenRisk && hp?.isHoneypot !== true ? simUi.statusLabel : null,
            ].filter((x):x is string=>x!=null).slice(0,3)
            {/* RIGHT-RAIL-RESULT-POLISH, DISCLOSED (Token Scanner result-UI polish task,
                explicitly requested: "summary cards slightly more readable"): same card
                shapes/content, brighter section-title and card-border tones so each summary card
                reads as a distinct block while scrolling instead of blurring into the background. */}
            const ss = {padding:'10px 12px',border:'1px solid rgba(255,255,255,0.10)',borderRadius:'10px',background:'rgba(10,17,32,.72)'}
            const stitle = {margin:'0 0 6px',fontSize:'9px',fontWeight:700 as const,letterSpacing:'.16em',color:'#5b7590',textTransform:'uppercase' as const,fontFamily:'var(--font-plex-mono)'}
            const sbody = {margin:0,fontSize:'11px',color:'#a3b4c5',lineHeight:1.65 as const,fontFamily:'var(--font-plex-mono)'}
            return (
              <div style={{display:'flex',flexDirection:'column',gap:'9px'}}>
                {/* CORTEX Receipt header — RIGHT-RAIL-CALM, DISCLOSED (Token Scanner
                    section-readability polish task, explicitly requested: "slightly reduce visual
                    competition while scrolling... avoid overly bright borders"): border alpha and
                    glow shadow both toned down; same verdict color/score/content. */}
                <div style={{padding:'16px',border:`1px solid ${verdictColor}22`,borderRadius:'14px',background:'linear-gradient(135deg,rgba(8,20,38,.92),rgba(14,12,38,.90))',boxShadow:`0 0 18px ${verdictColor}08`}}>
                  <div style={{fontSize:'9px',letterSpacing:'.16em',color:'#3a5268',fontFamily:'var(--font-plex-mono)',marginBottom:'10px'}}>CORTEX RECEIPT</div>
                  <div style={{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap'}}>
                    <div style={{flexShrink:0}}>
                      <div style={{fontSize:'9px',color:'#3a5268',fontFamily:'var(--font-plex-mono)',marginBottom:'2px'}}>RISK SCORE</div>
                      <div style={{fontSize:'28px',fontWeight:800,color:sidebarScoreColor,fontFamily:'var(--font-plex-mono)',lineHeight:1}}>{sidebarScore ?? 'Open Check'}{sidebarScore != null && <span style={{fontSize:'12px',color:`${sidebarScoreColor}55`}}>/100</span>}</div>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{display:'inline-flex',padding:'5px 14px',borderRadius:'999px',border:`1px solid ${verdictColor}55`,color:verdictColor,fontWeight:800,fontSize:'11px',letterSpacing:'.10em',background:`${verdictColor}12`,fontFamily:'var(--font-plex-mono)',marginBottom:'6px'}}>{verdict}</div>
                      <div style={{display:'inline-flex',marginLeft:'6px',padding:'4px 9px',borderRadius:'999px',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',color:sidebarRisk.confidence === 'high' ? '#34d399' : sidebarRisk.confidence === 'medium' ? '#fbbf24' : '#94a3b8',background:'rgba(148,163,184,0.08)',border:'1px solid rgba(148,163,184,0.22)',fontFamily:'var(--font-plex-mono)',marginBottom:'6px'}}>{sidebarRisk.confidence.toUpperCase()} CONFIDENCE</div>
                      {riskLabelCopy(sidebarRisk.riskLabel, scanEvidence) && (
                        <div style={{fontSize:'11px',color:'#fde68a',fontFamily:'var(--font-plex-mono)',lineHeight:1.5,marginBottom:'6px'}}>{riskLabelCopy(sidebarRisk.riskLabel, scanEvidence)}</div>
                      )}
                      <div style={{height:'4px',borderRadius:'999px',background:'rgba(255,255,255,0.06)',overflow:'hidden'}}>
                        <div style={{height:'100%',width:`${riskGaugeFillPercent(sidebarScore)}%`,borderRadius:'999px',background:`linear-gradient(90deg,${sidebarScoreColor},${sidebarScoreColor}70)`,transition:'width 0.6s ease'}} />
                      </div>
                    </div>
                  </div>
                </div>
                {/* Top 3 Risks */}
                {criticalRisks.length > 0 && (
                  <div style={{padding:'10px 12px',border:'1px solid rgba(248,113,113,0.16)',borderRadius:'10px',background:'rgba(248,113,113,0.03)'}}>
                    <p style={{...stitle,color:'#f87171'}}>Top 3 Risks</p>
                    <div style={{display:'flex',flexDirection:'column',gap:'4px'}}>
                      {criticalRisks.map((r,i)=>(
                        <div key={i} style={{display:'flex',gap:'6px',alignItems:'flex-start'}}>
                          <span style={{color:'#f87171',flexShrink:0,fontSize:'11px',lineHeight:'16px'}}>!</span>
                          <p style={{...sbody,color:'#fca5a5',margin:0}}>{r}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={ss}>
                  <p style={stitle}>Trading Simulation</p>
                  <p style={{...sbody,margin:0,color:'#e2e8f0',fontWeight:700}}>{simUi.statusLabel}</p>
                  <p style={{...sbody,margin:'4px 0 0'}}>{simUi.reason}</p>
                </div>
                {/* Top 2 Positives */}
                <div style={ss}>
                  <p style={stitle}>Top 2 Positives</p>
                  <div style={{display:'flex',flexDirection:'column',gap:'4px'}}>{bull.slice(0,2).map((b,i)=><p key={i} style={{...sbody,margin:0,color:'#86efac'}}>{b}</p>)}</div>
                </div>
                {/* Holder / Supply */}
                <div style={ss}>
                  <p style={stitle}>Holder Read</p>
                  {d.holderState.kind === 'rowsWithPercent' && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 8px',borderRadius:'999px',border:'1px solid rgba(45,212,191,.35)',color:'#2dd4bf',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',fontFamily:'var(--font-plex-mono)',background:'rgba(45,212,191,.07)'}}>CONCENTRATION VERIFIED</div>
                  )}
                  {d.holderState.kind === 'rowsWithoutPercent' && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 8px',borderRadius:'999px',border:'1px solid rgba(251,191,36,.35)',color:'#fbbf24',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',fontFamily:'var(--font-plex-mono)',background:'rgba(251,191,36,.07)'}}>CONCENTRATION INCOMPLETE</div>
                  )}
                  {d.holderState.kind === 'noRowsFallback' && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 8px',borderRadius:'999px',border:'1px solid rgba(251,191,36,.35)',color:'#fbbf24',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',fontFamily:'var(--font-plex-mono)',background:'rgba(251,191,36,.07)'}}>CONCENTRATION UNVERIFIED</div>
                  )}
                  {result.holderDistribution?.holderCount != null && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 9px',border:'1px solid rgba(45,212,191,.28)',borderRadius:'999px',fontSize:'11px',color:'#2DD4BF',fontFamily:'var(--font-plex-mono)',background:'rgba(45,212,191,.06)'}}>
                      {result.holderDistribution.holderCount.toLocaleString()} holders
                    </div>
                  )}
                  {(top10 != null || top20 != null) && (
                    <div style={{display:'flex',gap:'5px',flexWrap:'wrap',marginBottom:'7px'}}>
                      {top10 != null && <span style={{padding:'2px 8px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:top10>50?'#f87171':top10>30?'#fbbf24':'#34d399',background:top10>50?'rgba(248,113,113,.08)':top10>30?'rgba(251,191,36,.08)':'rgba(52,211,153,.08)',border:top10>50?'1px solid rgba(248,113,113,.28)':top10>30?'1px solid rgba(251,191,36,.28)':'1px solid rgba(52,211,153,.28)',fontFamily:'var(--font-plex-mono)'}}>Top 10: {top10.toFixed(1)}%</span>}
                      {top20 != null && <span style={{padding:'2px 8px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:'#94a3b8',border:'1px solid rgba(148,163,184,.22)',fontFamily:'var(--font-plex-mono)'}}>Top 20: {top20.toFixed(1)}%</span>}
                    </div>
                  )}
                  <p style={{...sbody, display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' as const, overflow:'hidden'}} title={getHolderRead(result)}>{getHolderRead(result)}</p>
                </div>
                {/* Next Action */}
                <div style={{padding:'11px 14px',border:'1px solid rgba(45,212,191,.22)',borderRadius:'12px',background:'rgba(45,212,191,.04)'}}>
                  <p style={{...stitle,color:'#2DD4BF',marginBottom:'5px'}}>Next Action</p>
                  <p style={{...sbody,color:'#67e8f9'}}>{getNextAction(result)}</p>
                </div>
                {/* Save button */}
                {(() => {
                  const normalizedResultContract = result.contract ? (isValidSolanaMintAddress(result.contract as unknown) ? result.contract : result.contract.toLowerCase()) : null
                  const isTracked = !!normalizedResultContract && trackedTokens.some(t => t.address === normalizedResultContract && (t.chain ?? 'base') === (result.chain ?? chain))
                  return (
                    <button
                      onClick={saveTrackedToken}
                      disabled={trackedSaving || isTracked}
                      style={{ width:'100%', padding:'10px 0', borderRadius:'10px', border:'1px solid rgba(167,139,250,0.35)', background:'rgba(167,139,250,0.07)', color: (trackedSaving || isTracked) ? '#64748b' : '#a78bfa', fontSize:'11px', fontWeight:700, fontFamily:'var(--font-plex-mono)', letterSpacing:'.10em', cursor: (trackedSaving || isTracked) ? 'not-allowed' : 'pointer', transition:'all .15s' }}
                    >
                      {trackedSaving ? 'SAVING…' : isTracked ? '✓ TRACKED' : '+ TRACK THIS TOKEN'}
                    </button>
                  )
                })()}
                {(trackedLoggedOut || trackedUnavailable || trackedSaveError) && (
                  <p style={{ margin: '8px 0 0', fontSize: '10px', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>
                    {trackedSaveError
                      ? trackedSaveError
                      : trackedUnavailable
                        ? 'Tracked tokens could not be loaded. Try again.'
                        : walletConnected ? 'Sign in to save tracked tokens across devices.' : 'Connect wallet or sign in to track tokens.'}
                  </p>
                )}
              </div>
            )
          })()}

          {/* ── Tracked Tokens panel ──────────────────────────────── */}
          <div style={{ borderTop: '1px solid rgba(99,102,241,0.15)', paddingTop: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: '#e2e8f0' }}>
                Tracked Tokens
              </p>
              {trackedTokens.length > 0 && (
                <span style={{ fontSize: '9px', color: '#334155', fontFamily: 'var(--font-plex-mono)', padding: '2px 8px', borderRadius: '99px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>{trackedTokens.length} saved</span>
              )}
            </div>

            {(trackedLoggedOut || trackedUnavailable) && (
              <p style={{ margin: 0, fontSize: '11px', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>
                {trackedUnavailable ? 'Tracked tokens could not be loaded. Try again.' : walletConnected ? 'Sign in to save tracked tokens across devices.' : 'Connect wallet or sign in to track tokens.'}
              </p>
            )}

            {!trackedLoggedOut && !trackedUnavailable && trackedLoading && (
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center', paddingTop: '4px' }}>
                {[0,1,2].map(i => <span key={i} style={{ width:'4px', height:'4px', borderRadius:'50%', background:'#22d3ee', display:'inline-block', animation:`clarkDot 1.2s ease-in-out ${i*.2}s infinite` }} />)}
              </div>
            )}

            {!trackedLoggedOut && !trackedUnavailable && !trackedLoading && trackedTokens.length === 0 && (
              <p style={{ margin: 0, fontSize: '10px', color: '#334155', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6 }}>
                No tracked tokens yet. Scan a token and press Track This Token.
              </p>
            )}

            {!trackedLoggedOut && !trackedUnavailable && !trackedLoading && trackedTokens.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {trackedTokens.map(t => {
                  const initials = (t.symbol ?? '?').slice(0, 2).toUpperCase()
                  const addr = t.address ?? ''
                  const short = addr.length >= 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
                  const savedDate = t.saved_at ? new Date(t.saved_at).toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' }).replace(/\//g,'/') : null
                  return (
                    <div key={t.id ?? t.address} style={{ padding: '10px', borderRadius: '11px', background: 'rgba(8,14,28,.75)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '9px' }}>
                        <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: 'linear-gradient(135deg,rgba(99,102,241,0.25),rgba(167,139,250,0.20))', border: '1px solid rgba(167,139,250,0.32)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '11px', fontWeight: 800, color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>
                          {initials}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '3px' }}>
                            <span style={{ fontSize: '12px', fontWeight: 700, color: '#f1f5f9' }}>{t.symbol ?? 'Tracked Token'}</span>
                            <span style={{ fontSize: '8px', padding: '1px 7px', borderRadius: '999px', background: 'rgba(34,211,238,0.10)', border: '1px solid rgba(34,211,238,0.28)', color: '#22d3ee', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>{t.chain ?? 'base'}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '9px', color: '#334155', fontFamily: 'var(--font-plex-mono)' }}>{short}</span>
                            {savedDate && <span style={{ fontSize: '9px', color: '#253340', fontFamily: 'var(--font-plex-mono)' }}>{savedDate}</span>}
                          </div>
                        </div>
                      </div>
                      {/* Scan/Remove hierarchy, DISCLOSED (Token Scanner final polish task): Scan
                          is now the visually primary action (filled teal), Remove stays a quiet
                          ghost action — same onClick handlers/behavior, just clearer priority. */}
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          onClick={() => {
                            // CHAIN-STRICT SCAN FIX, DISCLOSED (audit: watchlist Scan hardcoded 'base',
                            // so rescanning a saved ETH/BNB/Robinhood/Solana token always scanned it on
                            // Base instead of the chain it was actually saved under).
                            const rowChain = (['base', 'eth', 'bnb', 'robinhood', 'solana'] as const).includes(t.chain as typeof chain)
                              ? (t.chain as 'base' | 'eth' | 'bnb' | 'robinhood' | 'solana')
                              : 'base'
                            setInput(t.address)
                            setChain(rowChain)
                            handleScan(t.address, rowChain)
                          }}
                          style={{ flex: 1, justifyContent: 'center', display: 'flex', alignItems: 'center', padding: '7px 0', borderRadius: '8px', background: 'rgba(34,211,238,0.10)', border: '1px solid rgba(34,211,238,0.32)', color: '#67e8f9', fontSize: '10.5px', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', letterSpacing: '.10em', cursor: 'pointer', transition: 'background .14s, border-color .14s' }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.16)'; e.currentTarget.style.borderColor = 'rgba(34,211,238,0.50)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.10)'; e.currentTarget.style.borderColor = 'rgba(34,211,238,0.32)' }}
                        >
                          Scan
                        </button>
                        <button
                          onClick={() => removeTrackedToken(t.address, t.chain)}
                          className="cmd-chip"
                          style={{ padding: '7px 12px', color: '#8291a3', borderColor: 'rgba(255,255,255,0.08)' }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

      </div>
    </>
  )
}

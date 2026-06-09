'use client'

import { useState, useEffect, useRef, type MouseEvent } from 'react'
import { usePlanWithLoading, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import { resolveTokenQuery, isContractAddress, fmtLiquidity, type ResolverResult, type ResolverCandidate } from '@/lib/tickerResolver'
import { calculateCortexScoreV2, type CortexScoreResultV2 } from '@/lib/token/scoring'

// ─── Canonical status ─────────────────────────────────────────────────────
type CanonicalStatus =
  | "verified"
  | "inferred"
  | "partial"
  | "not_applicable"
  | "unavailable_with_reason"

function canonicalLabel(s: CanonicalStatus | string | undefined): string {
  switch (s) {
    case 'verified':              return 'Verified'
    case 'inferred':              return 'Inferred'
    case 'partial':               return 'Partial'
    case 'not_applicable':        return 'Not applicable'
    case 'unavailable_with_reason': return 'Open check'
    default:                      return 'Open check'
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

type Pool = {
  name?: string
  address?: string
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
    primaryValuationLabel: 'Market Cap' | 'FDV'
    primaryValuationUsd: number | null
    primaryValuationStatus: 'verified_mc' | 'fdv_only' | 'partial'
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
  } | null
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
    liquidity?: { status?: string; reason?: string; source?: string } | null
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
  lpEvidenceGaps?: Array<{ id: string; label: string; explanation: string; nextAction: string }>
  lpDataMode?: 'strict' | 'minimal' | 'fallback' | 'insufficient'
  lpDataConfidence?: 'high' | 'medium' | 'low' | 'unverified'
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
  riskEngine?: {
    rugRiskScore: number | null
    rugRiskLabel: "low_visible_risk" | "watch" | "high" | "critical" | "partial_data"
    confidence: "high" | "medium" | "low"
    cortexRead: string
    verifiedSignals: string[]
    riskDrivers: string[]
    openChecks: string[]
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
    proofStatus?: string | null
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
  if (relatedEdges.length === 0 && (node.supplyPercent == null || node.confidence === 'open_check')) {
    return { label: 'open-check', confidence: 'open_check', reasons: ['No edges, supply position, or behavior pattern confirmed in this pass.'] }
  }
  return { label: 'neutral', confidence: node.confidence === 'open_check' ? 'open_check' : 'low', reasons: ['Neutral holder — no transfer behavior confirmed in this pass.'] }
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
  linkedWallets?: Array<{ address: string; reason?: string | null; confidence?: string | null }>
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
  holderConcentration: 'Open check'
  supplySpread: 'Open check'
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

function deriveOwnerStatus(gp: Record<string, unknown> | null): OwnerStatus {
  const owner = gp?.owner_address
  if (owner == null) return 'Open check'
  const addr = String(owner)
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return 'Renounced'
  return 'Held'
}

function deriveHolderFallbackEvidence(result: ScanResult): HolderFallbackEvidence {
  const gp = result.contractSecurity && result.contract
    ? (result.contractSecurity[result.contract.toLowerCase()] ?? null) as Record<string, unknown> | null
    : null
  const ratio = result.marketCapUsd != null && result.fdvUsd != null && result.fdvUsd > 0
    ? (result.marketCapUsd / result.fdvUsd) * 100
    : null
  return {
    ownerStatus: deriveOwnerStatus(gp),
    poolCount: result.pools?.length ?? 0,
    liquidityDepth: result.liquidity ?? null,
    marketCapToFdvPct: ratio,
    marketCapToFdvLabel: ratio == null ? 'MC unavailable' : `${ratio.toFixed(1)}%`,
    holderConcentration: 'Open check',
    supplySpread: 'Open check',
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
  const baseChips: SecurityChip[] = [
    { label: 'Honeypot', displayLabel: hp?.isHoneypot === null ? 'Open check' : hp?.isHoneypot ? 'YES' : 'NO', style: hp?.isHoneypot ? pillDanger() : pillSafe(), source: 'honeypot' },
    { label: 'Buy Tax', displayLabel: hp?.buyTax == null ? 'N/A' : (!hp.simulationSuccess && hp.buyTax === 0) ? 'Open check' : `${hp.buyTax.toFixed(1)}%`, style: hp?.buyTax == null ? pillMuted() : (!hp.simulationSuccess && hp.buyTax === 0) ? pillMuted() : taxPct(hp.buyTax), source: 'honeypot' },
    { label: 'Sell Tax', displayLabel: hp?.sellTax == null ? 'N/A' : (!hp.simulationSuccess && hp.sellTax === 0) ? 'Open check' : `${hp.sellTax.toFixed(1)}%`, style: hp?.sellTax == null ? pillMuted() : (!hp.simulationSuccess && hp.sellTax === 0) ? pillMuted() : taxPct(hp.sellTax), source: 'honeypot' },
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

function StatCard({ label, value, accent, helper }: { label: string; value: string; accent?: string; helper?: string }) {
  return (
    <div style={{
      background: 'linear-gradient(160deg, rgba(10,18,34,.93), rgba(3,8,19,.90))',
      border: `1px solid ${accent ? `${accent}1e` : 'rgba(255,255,255,0.07)'}`,
      borderRadius: '14px',
      padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: '6px',
    }}>
      <p style={{
        fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em',
        color: '#3a5268', textTransform: 'uppercase', margin: 0,
        fontFamily: 'var(--font-plex-mono)',
      }}>
        {label}
      </p>
      <p style={{
        fontSize: '22px', fontWeight: 800, lineHeight: 1,
        color: accent ?? '#e2e8f0',
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

function ProjectSocialsCard({ socials }: { socials: ScanResult['projectSocials'] }) {
  const links: SocialLink[] = [
    socials?.twitter  ? { href: socials.twitter,  label: 'X',        abbr: 'X',   color: '#60a5fa' } : null,
    socials?.telegram ? { href: socials.telegram, label: 'Telegram', abbr: 'TG',  color: '#38bdf8' } : null,
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
    reasons.push(`No active liquidity pool found for this token on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.`)
  } else {
    reasons.push('Market data is unavailable or limited.')
  }
  if (hp?.simulationSuccess && hp.isHoneypot === false) {
    const tax = hp.buyTax != null && hp.sellTax != null ? ` Tax: buy ${hp.buyTax.toFixed(1)}% / sell ${hp.sellTax.toFixed(1)}%.` : ''
    reasons.push(`Security simulation completed — no honeypot flagged.${tax}`)
  } else if (hp?.isHoneypot === true) {
    reasons.push('Honeypot flagged — blocked sells detected in simulation.')
  } else {
    reasons.push('Security simulation unavailable — treat as an open check.')
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
  if (result.noActivePools) return `No active pool found. Verify the contract is live on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.`
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
    const pct = node.supplyPercent ?? 0
    if (node.confidence === 'open_check') return 'open_check'
    return pct >= 10 ? 'medium' : pct >= 1 ? 'low' : 'neutral'
  }
  const hasSusp = (node.reasons ?? []).some((r: string) => /suspicious|repeated|same.?size|funding|control/i.test(r))
  if (hasSusp) return 'high'
  if ((clusterRiskScore ?? 0) > 60) return 'high'
  const pct = node.supplyPercent ?? 0
  if (pct >= 10 && (node.isCreator || node.isLinked)) return 'high'
  if (pct >= 5 || (clusterRiskScore ?? 0) >= 21) return 'medium'
  if (node.confidence === 'open_check') return 'open_check'
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

function ClusterMapPanel({ clusterMap, devIntel, holderDistribution }: { clusterMap: ClusterMap | null; devIntel?: DevWalletIntel | null; holderDistribution?: { topHolders?: Array<{ rank?: number | null; address?: string | null; percent?: number | null }> } | null }) {
  const fmt = (addr: string | null | undefined) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'
  const map = clusterMap
  const nodes = map?.nodes ?? []
  const edges = map?.edges ?? []
  const summary = map?.summary ?? null
  const [selectedClusterNodeId, setSelectedClusterNodeId] = useState<string | null>(null)
  const [hoveredClusterNodeId, setHoveredClusterNodeId] = useState<string | null>(null)
  const [clusterTooltipPos, setClusterTooltipPos] = useState<{x:number;y:number}|null>(null)
  const [simPositions, setSimPositions] = useState<Map<string,{x:number;y:number}>>(() => new Map())
  const clusterGraphRef = useRef<HTMLDivElement>(null)
  const clusterIsTouch = useRef(false)
  const [hoveredClusterEdgeId, setHoveredClusterEdgeId] = useState<string | null>(null)
  const [edgeTooltipPosition, setEdgeTooltipPosition] = useState<{ x: number; y: number } | null>(null)
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
  const graphEdges: GraphEdge[] = edges.flatMap((edge, index) => {
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
  })
  useEffect(() => { clusterIsTouch.current = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches }, [])
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
        linkedSupplyPercent: directLinkedWallets.some((node) => node.supplyPercent != null) ? linkedSupply : null,
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

  const handleEdgePointer = (edgeId: string, event: MouseEvent<SVGPathElement>) => {
    event.stopPropagation()
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    setHoveredClusterEdgeId(edgeId)
    setEdgeTooltipPosition(rect ? { x: event.clientX - rect.left + 12, y: event.clientY - rect.top + 12 } : null)
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
  const openChecks = selectedClusterNode ? [
    ...(supplyPercent == null ? ['Wallet not indexed in this pass.'] : []),
    ...(map.status === 'partial' ? ['Some wallet data may be incomplete.'] : []),
    ...(selectedClusterNode.confidence === 'open_check' ? ['CORTEX needs more holder or transfer evidence before confirming cluster influence.'] : []),
    ...(relatedEdges.length === 0 ? ['No transfer edge confirmed for this wallet.'] : []),
  ] : []

  return (
    <div style={{ display:'grid', gap:'12px' }}>
      <div>
        <p style={{ margin:'0 0 5px', fontSize:'14px', color:'#e2e8f0', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>Cluster Map</p>
        <p style={{ margin:0, fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>Wallet relationship graph across deployer, linked wallets, and indexed holders. Click a node to inspect wallet-level evidence.</p>
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
              ['Cluster supply', summary?.clusterSupplyPercent != null ? `${summary.clusterSupplyPercent.toFixed(1)}%` : 'Open check'],
              ['Dominance', summary?.clusterDominance ?? 'unknown'],
              ['Risk score', summary?.clusterRiskScore != null ? `${summary.clusterRiskScore}/100` : 'Open check'],
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
                      <span style={{ padding:'4px 7px', borderRadius:'999px', background:'rgba(148,163,184,.08)', border:'1px solid rgba(148,163,184,.16)', color:'#cbd5e1', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{selectedClusterNode.confidence ?? 'open_check'}</span>
                    </div>
                  </div>
                  <button type="button" onClick={() => setSelectedClusterNodeId(null)} aria-label="Close wallet detail" style={{ width:28, height:28, borderRadius:'999px', border:'1px solid rgba(148,163,184,.2)', background:'rgba(15,23,42,.78)', color:'#94a3b8', cursor:'pointer' }}>×</button>
                </div>
                <div style={{ padding:'10px 0', borderTop:'1px solid rgba(148,163,184,.12)', borderBottom:'1px solid rgba(148,163,184,.12)' }}>
                  <p style={{ margin:'0 0 5px', fontSize:'9px', letterSpacing:'.13em', color:'#64748b', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>WALLET ADDRESS</p>
                  <div style={{ display:'flex', gap:'8px', alignItems:'center', justifyContent:'space-between' }}>
                    <span title={selectedClusterNode.address} style={{ color:'#e2e8f0', fontSize:'12px', fontFamily:'var(--font-plex-mono)', fontWeight:800 }}>{fmt(selectedClusterNode.address)}</span>
                    <button type="button" onClick={() => { void navigator.clipboard?.writeText(selectedClusterNode.address) }} style={{ padding:'5px 8px', borderRadius:'8px', border:'1px solid rgba(45,212,191,.28)', background:'rgba(45,212,191,.08)', color:'#2dd4bf', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)', cursor:'pointer' }}>COPY</button>
                  </div>
                </div>
                <section style={{ display:'grid', gap:'7px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>SUPPLY POSITION</p>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                    <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Supply</p><p style={{ margin:0, color:supplyPercent == null ? '#94a3b8' : '#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{supplyPercent == null ? 'Not indexed in this pass' : `${supplyPercent.toFixed(1)}% of supply`}</p></div>
                    <div style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.62)', border:'1px solid rgba(148,163,184,.12)' }}><p style={{ margin:'0 0 4px', color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>Holder rank</p><p style={{ margin:0, color:'#e2e8f0', fontSize:'12px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{holderRank != null ? `#${holderRank}` : 'Open check'}</p></div>
                  </div>
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
                  ) : <p style={{ margin:0, color:'#64748b', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>No wallet behavior pattern confirmed in this pass.</p>}
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>TRANSFER LINKS</p>
                  {relatedEdges.length === 0 ? <p style={{ margin:0, color:'#64748b', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>No transfer links found in this pass.</p> : relatedEdges.map((edge) => {
                    const otherNodeId = edge.source === selectedClusterNode.id ? edge.target : edge.source
                    const otherNode = nodes.find((node) => node.id === otherNodeId)
                    return <div key={edge.id} style={{ padding:'9px', borderRadius:'10px', background:'rgba(15,23,42,.58)', border:'1px solid rgba(148,163,184,.12)' }}><div style={{ display:'flex', justifyContent:'space-between', gap:'8px', marginBottom:'5px' }}><span style={{ color:'#e2e8f0', fontSize:'10px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{fmt(otherNode?.address)}</span><span style={{ color:'#94a3b8', fontSize:'9px', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{edge.confidence}</span></div><p style={{ margin:'0 0 4px', color:'#7dd3fc', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>{edgeLabel(edge.type)} · weight {edge.weight}</p><p style={{ margin:0, color:'#94a3b8', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{edge.reason}</p></div>
                  })}
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>RISK SIGNALS</p>
                  <div style={{ padding:'8px 9px', borderRadius:'10px', background:'rgba(15,23,42,.5)', border:`1px solid ${riskContextColor}33` }}><p style={{ margin:0, color:riskContextColor, fontSize:'10px', fontWeight:800, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{riskContextScore != null ? `Cluster risk ${riskContextScore}/100 · ${riskContextLabel}` : `Cluster risk · ${riskContextLabel}`}</p></div>
                  {walletSignals.length === 0 ? <p style={{ margin:0, color:'#64748b', fontSize:'10px', fontFamily:'var(--font-plex-mono)' }}>No wallet-specific signals.</p> : walletSignals.slice(0, 5).map((signal, index) => <p key={signal + index} style={{ margin:0, color:'#cbd5e1', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>› {signal}</p>)}
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>FUNDING SOURCE</p>
                  <p style={{ margin:0, color:fundingSource ? '#cbd5e1' : '#64748b', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{fundingSource ?? 'No funding source identified.'}</p>
                </section>
                <section style={{ display:'grid', gap:'7px', borderTop:'1px solid rgba(148,163,184,.1)', paddingTop:'10px' }}>
                  <p style={{ margin:0, fontSize:'9px', letterSpacing:'.13em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>CONFIDENCE</p>
                  <p style={{ margin:0, color:'#cbd5e1', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{confidenceCopy(selectedClusterNode.confidence)}</p>
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
                ['Linked supply', deployerLineage.summary.linkedSupplyPercent == null ? 'Open check' : `${deployerLineage.summary.linkedSupplyPercent.toFixed(1)}%`],
                ['Cluster supply', deployerLineage.summary.clusterSupplyPercent == null ? 'Open check' : `${deployerLineage.summary.clusterSupplyPercent.toFixed(1)}%`],
              ].map(([label, value]) => <div key={label} style={{ display:'flex', justifyContent:'space-between', gap:'8px', padding:'5px 0', borderTop:'1px solid rgba(148,163,184,.08)' }}><span style={{ color:'#64748b', fontSize:'9px', fontFamily:'var(--font-plex-mono)' }}>{label}</span><span style={{ color:'#e2e8f0', fontSize:'9px', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{value}</span></div>)}
              <p style={{ margin:0, color:'#cbd5e1', fontSize:'10px', lineHeight:1.45, fontFamily:'var(--font-plex-mono)' }}>{deployerLineage.summary.reason}</p>
              <p style={{ margin:0, color:'#94a3b8', fontSize:'9px', lineHeight:1.4, fontFamily:'var(--font-plex-mono)' }}>Other contracts not available in this pass.</p>
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
      meta?.proofStatus === 'concentrated_liquidity' ||
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

function getLpLockLabel(result: ScanResult): { label: string; color: string; bg: string; border: string; description: string } {
  const dm = result.lpControl?.displayLpModel
  const lpMode = getLpMode(result)
  const hasLiquidity = (result.liquidity ?? 0) > 0 || result.lpControl?.poolAddressPresent
  if (result.noActivePools && !hasLiquidity) return { label: 'No Active Pool', color: '#94a3b8', bg: 'rgba(148,163,184,0.07)', border: 'rgba(148,163,184,0.20)', description: 'No active liquidity pool detected on this chain. Token may be illiquid.' }
  if (dm === 'concentrated_liquidity') return { label: 'Concentrated', color: '#c084fc', bg: 'rgba(192,132,252,0.07)', border: 'rgba(192,132,252,0.22)', description: 'V3/V4-style pool — standard ERC-20 LP lock/burn proof does not apply.' }
  if (dm === 'protocol_or_gauge') return { label: 'Protocol / Gauge', color: '#a78bfa', bg: 'rgba(167,139,250,0.07)', border: 'rgba(167,139,250,0.22)', description: 'Protocol-managed liquidity pool. LP lock/burn proof does not apply in this model.' }
  if (lpMode === 'protocol') return { label: 'Protocol-Owned', color: '#c084fc', bg: 'rgba(192,132,252,0.07)', border: 'rgba(192,132,252,0.22)', description: 'Protocol-managed concentrated liquidity. Standard LP lock/burn proof does not apply.' }

  // Real LP proof (PinkLock + on-chain burn scan) takes priority over legacy inference.
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
  const dm = result.lpControl?.displayLpModel
  const lpMode = getLpMode(result)
  const liqDepth = result.liquidity ?? null
  const hasLiquidity = (liqDepth ?? 0) > 0 || result.lpControl?.poolAddressPresent
  if (result.noActivePools && !hasLiquidity) return { label: 'Critical', color: '#f87171', description: 'No active pool — exit liquidity is entirely unavailable.' }
  if (dm === 'concentrated_liquidity') return { label: 'Open Check', color: '#c084fc', description: 'V3/V4 pool — LP lock/burn proof does not apply. Assess pool depth and age.' }
  if (dm === 'protocol_or_gauge') return { label: 'Open Check', color: '#a78bfa', description: 'Protocol/gauge-managed — LP lock model does not apply. Monitor pool depth and activity.' }
  if (lpMode === 'protocol') return { label: 'Open Check', color: '#c084fc', description: 'Protocol-managed liquidity. LP lock model does not apply — assess pool depth and age.' }

  const lockStatus = result.lpLockStatus
  if (lockStatus === 'burned') return { label: liqDepth != null && liqDepth < 50_000 ? 'Medium' : 'Low', color: liqDepth != null && liqDepth < 50_000 ? '#a78bfa' : '#34d399', description: 'LP burned — exit liquidity permanently locked. Pool depth is the main remaining variable.' }
  if (lockStatus === 'locked') return { label: liqDepth != null && liqDepth < 50_000 ? 'Medium' : 'Low', color: liqDepth != null && liqDepth < 50_000 ? '#a78bfa' : '#34d399', description: 'LP locked with confirmed proof — protected for the lock duration. Pool depth is the main remaining variable.' }
  if (lockStatus === 'unlocked') return { label: 'High', color: '#fb923c', description: 'On-chain evidence shows the LP is held by a removable wallet — liquidity can be withdrawn without lock proof.' }

  // No proven lock/burn/wallet-control state — open check, not an inferred "High".
  if (liqDepth != null && liqDepth < 10_000) return { label: 'Watch', color: '#fbbf24', description: 'LP proof unconfirmed and liquidity is very thin — open check with elevated caution warranted.' }
  if (liqDepth != null && liqDepth < 50_000) return { label: 'Watch', color: '#fbbf24', description: 'LP proof unconfirmed and liquidity is thin — open check, monitor closely.' }
  return { label: 'Open Check', color: '#fbbf24', description: 'Exit risk cannot be rated until lock, burn, or controller proof is confirmed — verify on-chain.' }
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
  if (lockStatus === 'burned') goodSigns.push('On-chain proof: LP tokens sent to a burn address — exit liquidity is permanently locked.')
  if (lockStatus === 'locked') goodSigns.push(`Active LP lock proof found${result.lpLockProvider ? ` via ${result.lpLockProvider}` : ''}.`)
  else if (status === 'burned') goodSigns.push('LP tokens permanently burned — exit liquidity is protected.')
  else if (status === 'locked') goodSigns.push('LP tokens verified as locked in a locker contract.')
  if (dm === 'concentrated_liquidity') goodSigns.push('Concentrated liquidity — standard V3/V4 pool model.')
  else if (dm === 'protocol_or_gauge') goodSigns.push('Protocol/gauge liquidity — standard for this pool model.')
  else if (lpMode === 'protocol') goodSigns.push('Protocol-owned liquidity is standard for this pool model.')
  if (liqDepth != null && liqDepth > 500_000) goodSigns.push(`Deep liquidity — ${fmtLarge(liqDepth)} pool depth.`)
  else if (liqDepth != null && liqDepth > 100_000) goodSigns.push(`Moderate liquidity — ${fmtLarge(liqDepth)} pool depth.`)
  if (lp?.poolAddressPresent) goodSigns.push('Liquidity pool detected and indexed.')
  if (lockStatus === 'unlocked') riskSigns.push('On-chain evidence shows the LP is held by a removable wallet with no lock or burn proof.')
  if ((result.noActivePools || status === 'no_pool') && !hasLiquidity) riskSigns.push('No active liquidity pool — token may be illiquid.')
  if (liqDepth != null && liqDepth < 10_000 && !result.noActivePools) riskSigns.push(`Very thin liquidity — ${fmtLarge(liqDepth)} depth.`)
  else if (liqDepth != null && liqDepth < 50_000 && !result.noActivePools) riskSigns.push(`Thin liquidity — ${fmtLarge(liqDepth)}.`)
  const lockBurnApplicable = lp?.lockBurnApplicable ?? (lpMode !== 'protocol' && dm !== 'concentrated_liquidity' && dm !== 'protocol_or_gauge')
  if (lockBurnApplicable && lockStatus !== 'burned' && lockStatus !== 'locked' && status !== 'burned' && status !== 'locked') missingProofs.push('LP lock or burn proof not confirmed.')
  if (!lockBurnApplicable && dm !== 'concentrated_liquidity' && dm !== 'protocol_or_gauge' && lpMode === 'unknown' && !result.noActivePools) missingProofs.push('LP token model could not be classified.')
  if (!lp?.poolAddressPresent && !result.noActivePools && liqDepth == null) missingProofs.push('Pool address not yet indexed.')
  return { goodSigns: goodSigns.slice(0, 3), riskSigns: riskSigns.slice(0, 3), missingProofs: missingProofs.slice(0, 3) }
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
  if (lockStatus === 'burned') return liqDepth != null && liqDepth < 50_000 ? 'LP is burned (on-chain proof) — good sign. Pool depth is thin, so monitor liquidity before committing size.' : 'LP is burned (on-chain proof) — exit liquidity is permanently locked. Still monitor holder concentration and trading taxes.'
  if (lockStatus === 'locked') return `LP lock proof was found${result.lpLockProvider ? ` via ${result.lpLockProvider}` : ''} — independently confirm the lock duration and expiry before assuming permanent protection.`
  if (dm === 'concentrated_liquidity') return 'V3/V4-style liquidity does not use standard LP lock/burn proof. Monitor pool depth, age, volume, and holder concentration.'
  if (dm === 'protocol_or_gauge') return 'Protocol or gauge-based liquidity can be normal. Monitor depth, pool age, and whether liquidity is moving.'
  if (lpMode === 'protocol') return 'V3/V4-style pools do not use standard ERC-20 LP lock/burn proof. Monitor pool depth, age, and holder concentration.'
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

function calculateCortexScore(result: ScanResult): CortexScoreResult {
  const hp         = result.honeypot
  const liq        = result.liquidity ?? 0
  const holderState = deriveHolderState(result)
  const lpStatus   = result.lpControl?.status
  const lpMode = getLpMode(result)
  const top1       = result.holderDistribution?.top1  ?? null
  const top10      = result.holderDistribution?.top10 ?? null
  const top20      = result.holderDistribution?.top20 ?? null
  const buyTax     = hp?.buyTax  ?? 0
  const sellTax    = hp?.sellTax ?? 0
  const taxHigh    = buyTax > 8 || sellTax > 8

  let pts = 50

  // ── Market ──────────────────────────────────────────────────────────────
  let marketPts = 0, marketStatus = 'unavailable', marketReason = 'No market data available.'
  if (result.noActivePools) {
    marketPts = -15; marketReason = 'No active pool — price and market data unavailable.'
  } else {
    if (result.price     != null) marketPts += 10
    if (result.liquidity != null) marketPts += 8
    if (result.volume24h != null) marketPts += 6
    if (result.marketCapUsd != null) {
      marketPts += 6; marketStatus = 'ok'; marketReason = 'Live price, liquidity, and verified market cap available.'
    } else {
      marketPts -= 8; marketStatus = 'partial'; marketReason = 'Market data present but market cap not confirmed.'
    }
    if (result.price == null && result.liquidity == null) {
      marketStatus = 'unavailable'; marketReason = 'No price or liquidity data returned.'
    }
  }
  pts += marketPts

  // ── Liquidity ────────────────────────────────────────────────────────────
  let liqPts = 0, liqStatus = 'unavailable', liqReason = 'Liquidity unavailable.'
  if (liq >= 100_000)      { liqPts = 12;  liqStatus = 'ok';          liqReason = `Deep liquidity — ${fmtLarge(liq)}.` }
  else if (liq >= 25_000)  { liqPts = 8;   liqStatus = 'ok';          liqReason = `Moderate liquidity — ${fmtLarge(liq)}.` }
  else if (liq >= 5_000)   { liqPts = 4;   liqStatus = 'partial';     liqReason = `Thin liquidity — ${fmtLarge(liq)}.` }
  else if (liq > 0)        { liqPts = -10; liqStatus = 'unavailable'; liqReason = `Very thin liquidity — ${fmtLarge(liq)}.` }
  else                     { liqPts = -10; liqStatus = 'unavailable'; liqReason = 'No liquidity data available.' }
  pts += liqPts

  // ── Holders ──────────────────────────────────────────────────────────────
  let holderPts = 0, holderStatus = 'unavailable', holderReason = 'Holder concentration not confirmed.'
  if (holderState.kind === 'rowsWithPercent') {
    holderPts = 10; holderStatus = 'ok'; holderReason = 'Holder percentages verified.'
    if (top10 != null && top10 > 50) {
      holderPts -= 15; holderReason = `Top 10 hold ${top10.toFixed(1)}% — high concentration.`
    } else if (top20 != null && top20 > 60) {
      holderPts -= 5; holderReason = `Top 20 hold ${top20.toFixed(1)}% — elevated concentration.`
    }
    if (top1 != null && top1 > 20) {
      holderPts -= 8; holderReason += ` Single wallet holds ${top1.toFixed(1)}%.`
    }
  } else if (holderState.kind === 'rowsWithoutPercent') {
    holderPts = 5; holderStatus = 'partial'; holderReason = 'Holder wallets found — percentages unconfirmed.'
  } else {
    holderPts = -12; holderReason = 'Holder concentration not confirmed — open risk.'
  }
  pts += holderPts

  // ── Security ─────────────────────────────────────────────────────────────
  let secPts = 0, secStatus = 'unavailable', secReason = 'Security simulation unavailable.'
  if (hp?.isHoneypot === true) {
    secPts = -20; secStatus = 'critical'; secReason = 'HONEYPOT — sell simulation detected blocked transaction.'
  } else if (hp?.simulationSuccess === true && hp?.isHoneypot === false) {
    if (taxHigh) {
      secPts = -12; secStatus = 'risk'; secReason = `Simulation passed but taxes are high — buy ${buyTax.toFixed(1)}% / sell ${sellTax.toFixed(1)}%.`
    } else {
      secPts = 12; secStatus = 'ok'; secReason = 'Simulation passed — no honeypot, taxes within normal range.'
    }
  } else if (hp != null) {
    secPts = 6; secStatus = 'partial'; secReason = 'Partial security data available — simulation incomplete.'
  } else {
    secPts = -12; secStatus = 'unavailable'; secReason = 'No security simulation data this scan.'
  }
  pts += secPts

  // ── LP Control ───────────────────────────────────────────────────────────
  let lpPts = 0, lpStatusLabel = 'unavailable', lpReason = 'No LP lock or burn proof confirmed.'
  if (lpStatus === 'locked' || lpStatus === 'burned') {
    lpPts = 10; lpStatusLabel = 'ok'; lpReason = `LP ${lpStatus} — exit liquidity confirmed.`
  } else if (lpMode === 'protocol') {
    lpPts = 10; lpStatusLabel = 'ok'; lpReason = 'Concentrated Liquidity (v3/v4) — LP token model is not used.'
  } else if (result.lpControl?.poolAddressPresent) {
    lpPts = -10; lpStatusLabel = 'partial'; lpReason = 'LP ownership could not be verified this scan.'
  } else if (lpStatus === 'risky') {
    lpPts = -20; lpStatusLabel = 'critical'; lpReason = 'LP flagged risky.'
  } else {
    lpPts = -12; lpReason = 'LP lock or burn proof not confirmed.'
  }
  pts += lpPts

  // ── Missing checks penalty ───────────────────────────────────────────────
  const missingItems = [
    holderState.kind !== 'rowsWithPercent'                              ? 'holder concentration'  : null,
    lpMode === 'protocol'                                                ? null                    : lpStatus === 'unavailable_with_reason' ? 'LP proof' : lpMode === 'unknown' ? 'LP model classification' : (lpStatus !== 'locked' && lpStatus !== 'burned' ? 'LP proof' : null),
    result.marketCapUsd == null                                         ? 'market cap'            : null,
    !hp?.simulationSuccess                                              ? 'security simulation'   : null,
    result.contractSecurity == null                                               ? 'owner status'          : null,
  ].filter((v): v is string => v != null)
  const missingPenalty = Math.min(missingItems.length * 4, 18)
  pts -= missingPenalty
  const missingStatus = missingItems.length === 0 ? 'ok' : missingItems.length <= 2 ? 'partial' : 'unavailable'
  const missingReason = missingItems.length === 0
    ? 'No open checks.'
    : `${missingItems.length} checks missing: ${missingItems.join(', ')}.`

  // ── Score caps ───────────────────────────────────────────────────────────
  // Applied after base calculation. Prevent incomplete scans from appearing
  // fully verified. Each cap sets a maximum; the lowest applicable cap wins.
  const lpVerified2   = lpStatus === 'locked' || lpStatus === 'burned'
  const simVerified2  = hp?.simulationSuccess === true && hp?.isHoneypot === false
  const holdersVerif2 = holderState.kind === 'rowsWithPercent'
  const mcVerified2   = result.marketCapUsd != null
  const mc            = result.marketCapUsd ?? null
  const highHolderConc = top10 != null && top10 > 50
  // allMajorVerified: every important check has a positive result
  const allMajorVerified =
    lpVerified2 && simVerified2 && holdersVerif2 && mcVerified2 &&
    liq >= 25_000 && !highHolderConc && missingItems.length === 0

  let cap = 100
  let capReason: string | null = null

  const setCapIfLower = (newCap: number, reason: string) => {
    if (newCap < cap) { cap = newCap; capReason = reason }
  }

  // No data
  if (!result.price && !result.liquidity && !hp) {
    setCapIfLower(35, 'Insufficient data — score capped.')
  }
  // No active pool / no liquidity
  if (result.noActivePools || liq === 0) {
    setCapIfLower(40, 'No active pool detected — score capped.')
  }
  // Security simulation unavailable or tax sim not run
  if (!hp?.simulationSuccess) {
    setCapIfLower(80, 'Score capped by incomplete security/LP checks.')
  }
  // LP lock/burn proof unverified
  if (!lpVerified2) {
    setCapIfLower(72, 'Score capped by missing LP ownership proof.')
  }
  // Both security AND LP unverified → tighter cap
  if (!simVerified2 && !lpVerified2) {
    setCapIfLower(76, 'Score capped by incomplete LP/security checks.')
  }
  // Holder concentration unavailable
  if (holderState.kind === 'noRowsFallback') {
    setCapIfLower(75, 'Score capped — holder data not confirmed.')
  }
  // Holder concentration partial (rows present, percentages missing)
  if (holderState.kind === 'rowsWithoutPercent') {
    setCapIfLower(82, 'Score capped by partial holder data.')
  }
  // High holder concentration
  if (highHolderConc) {
    setCapIfLower(72, 'Score capped by high holder concentration.')
  }
  // Elevated top20 concentration
  if (top20 != null && top20 > 60 && !highHolderConc) {
    setCapIfLower(78, 'Score capped by elevated holder concentration.')
  }
  // Market cap unverified (but some market data exists)
  if (!mcVerified2 && (result.price != null || result.liquidity != null)) {
    setCapIfLower(82, 'Score capped — market cap not confirmed.')
  }
  // Low market cap — microcap tokens need all checks verified to score high
  if (mc != null && mc < 1_000_000 && !allMajorVerified) {
    setCapIfLower(72, 'Score capped by low-cap / incomplete verification.')
  } else if (mc != null && mc < 5_000_000 && !allMajorVerified) {
    setCapIfLower(78, 'Score capped by low-cap / incomplete verification.')
  }
  // 2+ major checks missing
  if (missingItems.length >= 3) {
    setCapIfLower(68, 'Score capped by 3+ incomplete checks.')
  } else if (missingItems.length >= 2) {
    setCapIfLower(76, 'Score capped by incomplete checks.')
  }
  // 95–100 only if everything is genuinely verified
  if (!allMajorVerified) {
    setCapIfLower(94, capReason ?? 'Score capped by incomplete verification.')
  }
  if (liq > 0 && liq < 25_000) {
    setCapIfLower(62, 'Score capped by low liquidity depth.')
  }

  // ── Clamp ────────────────────────────────────────────────────────────────
  const score = Math.min(cap, Math.max(0, Math.round(pts)))
  // Clear capReason if the raw score was already below the cap (cap didn't bite)
  const effectiveCapReason = Math.round(pts) > cap ? capReason : null

  // ── Verdict ──────────────────────────────────────────────────────────────
  const noData = !result.price && !result.liquidity && !hp
  let verdict: CortexScoreResult['verdict']
  if (noData) {
    verdict = 'UNKNOWN'
  } else if (hp?.isHoneypot === true || taxHigh || score < 40) {
    verdict = 'AVOID'
  } else if (
    score >= 82 &&
    liq >= 25_000 &&
    holdersVerif2 &&
    simVerified2 &&
    !taxHigh &&
    !highHolderConc &&
    lpVerified2 &&
    missingItems.length === 0
  ) {
    verdict = 'CLEAN LOOKING'
  } else if (score >= 65 && !highHolderConc && (lpVerified2 || simVerified2)) {
    verdict = 'WATCH'
  } else {
    verdict = 'CAUTION'
  }

  // ── Confidence ───────────────────────────────────────────────────────────
  const hasMarket    = result.price != null || result.liquidity != null
  const hasLiquidity = result.liquidity != null
  const hasHolders   = holderState.kind === 'rowsWithPercent'
  const hasHoldersPt = holderState.kind === 'rowsWithoutPercent'
  const hasSecurity  = hp?.simulationSuccess === true

  let confidence: CortexScoreResult['confidence']
  if (hasMarket && hasLiquidity && hasHolders && hasSecurity) {
    confidence = 'HIGH'
  } else if (hasMarket && hasLiquidity && (hasHolders || hasHoldersPt || hasSecurity)) {
    confidence = 'MEDIUM'
  } else {
    confidence = 'LOW'
  }

  // ── Scan quality ─────────────────────────────────────────────────────────
  const dataCount = [hasMarket, hasHolders || hasHoldersPt, hasSecurity, hasLiquidity].filter(Boolean).length
  const scanQuality: CortexScoreResult['scanQuality'] = dataCount >= 4 ? 'FULL' : dataCount >= 2 ? 'PARTIAL' : 'LIMITED'

  return {
    score,
    verdict,
    confidence,
    scanQuality,
    capReason: effectiveCapReason,
    breakdown: {
      market:    { status: marketStatus,  score: marketPts,    reason: marketReason },
      liquidity: { status: liqStatus,     score: liqPts,       reason: liqReason },
      holders:   { status: holderStatus,  score: holderPts,    reason: holderReason },
      security:  { status: secStatus,     score: secPts,       reason: secReason },
      lp:        { status: lpStatusLabel, score: lpPts,        reason: lpReason },
      missing:   { status: missingStatus, penalty: -missingPenalty, reason: missingReason },
    },
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
  if (hp?.isHoneypot === true) return 'Honeypot flagged — sell simulation detected blocked transaction.'
  if (!hp?.simulationSuccess) return 'Security simulation did not complete — status is an open check this pass.'
  const parts = [
    'Honeypot: not flagged',
    hp.buyTax != null ? `buy tax ${hp.buyTax.toFixed(1)}%` : null,
    hp.sellTax != null ? `sell tax ${hp.sellTax.toFixed(1)}%` : null,
    hp.transferTax != null && hp.transferTax > 0 ? `transfer tax ${hp.transferTax.toFixed(1)}%` : null,
  ].filter(Boolean)
  return parts.join(', ') + '. Simulation verified.'
}

function getHolderRead(result: ScanResult): string {
  const holderState = deriveHolderState(result)
  if (holderState.kind === 'noRowsFallback') return 'Holder distribution was not returned this scan. Supply spread is an open check.'
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
  if (result.noActivePools || poolCount === 0) return `No active liquidity pool detected on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.`
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

function RiskGaugeCircle({ score, color }: { score: number | null; color: string }) {
  const size = 130
  const sw = 10
  const r = (size - sw) / 2
  const circ = 2 * Math.PI * r
  const pct = score != null ? Math.max(0, Math.min(100, score)) / 100 : 0
  const offset = circ - pct * circ
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={sw} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={score != null ? offset : circ}
          style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.4s ease', filter: `drop-shadow(0 0 8px ${color}80)` }}
        />
      </svg>
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px' }}>
        <span style={{ fontSize: '28px', fontWeight: 800, color, fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>
          {score != null ? score : '—'}
        </span>
        <span style={{ fontSize: '8px', color: '#3a5268', letterSpacing: '.14em', fontFamily: 'var(--font-plex-mono)' }}>RUG RISK</span>
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
        No security simulation data surfaced — status is an open check.
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
        {hp?.simulationSuccess && <span style={{ color: '#1e3a44', marginLeft: '6px' }}>· Honeypot.is</span>}
        
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

  const [chain, setChain]       = useState<'base' | 'eth'>('base')
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ScanResult | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [lpExpanded, setLpExpanded] = useState(true)
  const [activeSection, setActiveSection] = useState<'cortex-read'|'market-pulse'|'holder-map'|'lp-safety'|'risk-engine'|'deployer-intel'>('cortex-read')
  const [devControlTab, setDevControlTab] = useState<'dev-map'|'cluster-map'|'supply-control'|'history'|'watch-plan'>('dev-map')
  const [copiedHolderAddress, setCopiedHolderAddress] = useState<string | null>(null)

  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkError, setClarkError]     = useState<string | null>(null)
  const [devIntelLoading, setDevIntelLoading] = useState(false)
  const [devIntelError, setDevIntelError] = useState<string | null>(null)
  const [devIntel, setDevIntel] = useState<DevWalletIntel | null>(null)
  const devIntelCacheRef = useRef<Record<string, DevWalletIntel>>({})

  const [resolving, setResolving]               = useState(false)
  const [resolverResult, setResolverResult]     = useState<ResolverResult | null>(null)

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

  // Auto-scan when opened from Base Radar with ?contract= param
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params      = new URLSearchParams(window.location.search)
    const contract    = params.get('contract')
    const chainParam  = params.get('chain')
    const autoChain   = chainParam === 'eth' ? 'eth' : 'base'
    if (chainParam === 'eth') setChain('eth')
    if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
      handleScan(contract, autoChain)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleScan(override?: string, chainOverride?: 'base' | 'eth') {
    const q             = (override ?? input).trim()
    const effectiveChain = chainOverride ?? chain
    if (!q) {
      setError('Please enter a token address or ticker before scanning.')
      return
    }
    if (loading || resolving) return

    // ── Stale-state reset — runs on every new scan regardless of path ────────
    setResolverResult(null)
    setResult(null)
    setError(null)
    setDevIntel(null)
    setDevIntelError(null)
    devIntelCacheRef.current = {}  // clear cached devIntel so no stale data bleeds across scans
    // ────────────────────────────────────────────────────────────────────────

    // ── Ticker resolver ─────────────────────────────────────────────────────
    // Skip if: CA provided directly, or override from URL auto-scan / alternate picker
    let scanContract = q
    let scanChain: 'base' | 'eth' = effectiveChain
    if (!override && !isContractAddress(q)) {
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
        scanChain    = (resolved.chain === 'eth' ? 'eth' : 'base') as 'base' | 'eth'
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
      const json = await res.json()
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
        if (json?.status === 'invalid_address') setError(json.error ?? 'Invalid address format. Expected 0x followed by 40 hex characters.')
        else if (json?.status === 'wrong_chain' || json?.status === 'chain_mismatch') setError(`Token not found on ${scanChain === 'eth' ? 'Ethereum' : 'Base'}. Try switching chains.`)
        else if (json?.status === 'ambiguous') setError('Multiple tokens match this. Paste the contract address or choose one.')
        else if (json?.status === 'no_pool_found' || json?.marketStatus === 'no_pool_found') setError(`No active liquidity pools found on ${scanChain === 'eth' ? 'Ethereum' : 'Base'} for this token.`)
        else setError("Couldn't resolve that token. Paste the contract address or try a verified symbol.")
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
          })),
          contractSecurity: json.contractSecurity ?? null,
          honeypot: json.honeypot ?? null,
          holderDistribution: json.holderDistribution ?? null,
          holderDistributionStatus: json.holderDistributionStatus ?? null,
          debugHolderStatus: json.debugHolderStatus ?? null,
          sections: json.sections ?? null,
          lpControl: json.lpControl ?? null,
          lpMeta: json.lpMeta ?? null,
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
        const json = await res.json()
        if (aborted) return
        if (res.status === 429) {
          setDevIntelError('Dev intelligence cooldown active. Showing scanner-derived signals.')
          return
        }
        if (!res.ok || json?.error) {
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
        @keyframes scanBtnGlow { 0%,100%{box-shadow:0 0 0 rgba(45,212,191,0)} 50%{box-shadow:0 0 24px rgba(45,212,191,.30),0 0 42px rgba(139,92,246,.16)} }
        @keyframes cortexHeroBreath { 0%,100%{box-shadow:0 0 60px rgba(45,212,191,.08),0 0 24px rgba(45,212,191,.05)} 50%{box-shadow:0 0 80px rgba(45,212,191,.14),0 0 36px rgba(45,212,191,.08)} }
        .cortex-score-hero{animation:cortexHeroBreath 5s ease-in-out infinite;}
        .cortex-chip{transition:transform .18s ease,box-shadow .18s ease;cursor:default;}
        .cortex-chip:hover{transform:translateY(-2px);}
        .cortex-bdrow{border-radius:6px;transition:background .14s ease;}
        .cortex-bdrow:hover{background:rgba(255,255,255,.028) !important;}
        .token-shell{display:grid;grid-template-columns:minmax(0,1fr);height:100%;overflow-x:hidden;color:#e2e8f0;background-image:linear-gradient(rgba(45,212,191,.020) 1px,transparent 1px),linear-gradient(90deg,rgba(45,212,191,.020) 1px,transparent 1px),radial-gradient(circle at 22% 0%,rgba(20,35,68,.52),rgba(2,6,23,1) 56%);background-size:52px 52px,52px 52px,100% 100%;background-color:rgba(2,6,23,1);}
        .token-main,.mob-verdict-panel,.glass-card,.metric-grid,.holders-grid,.activity-grid,.intel-grid{min-width:0;}
        .token-main{max-width:none;}
        .glass-card{background:linear-gradient(180deg,rgba(10,18,34,.9),rgba(3,8,19,.88));border:1px solid rgba(148,163,184,.18);border-radius:16px;box-shadow:0 0 0 1px rgba(45,212,191,.05) inset,0 18px 45px rgba(2,6,23,.4),0 0 28px rgba(139,92,246,.12);}
        .search-card{background:linear-gradient(160deg,rgba(12,22,40,.97) 0%,rgba(5,10,22,.95) 100%);border:1px solid rgba(45,212,191,.18);border-radius:18px;box-shadow:0 0 0 1px rgba(45,212,191,.07) inset,0 28px 60px rgba(2,6,23,.60),0 0 48px rgba(45,212,191,.08),0 0 80px rgba(139,92,246,.04);}
        .chain-tab-active{background:rgba(45,212,191,.11) !important;border:1px solid rgba(45,212,191,.50) !important;color:#2DD4BF !important;box-shadow:0 0 16px rgba(45,212,191,.20),inset 0 1px 0 rgba(45,212,191,.12) !important;}
        .chain-tab-inactive{background:rgba(255,255,255,.025) !important;border:1px solid rgba(255,255,255,.08) !important;color:#4b6070 !important;}
        .chain-tab-inactive:hover{background:rgba(255,255,255,.04) !important;border-color:rgba(255,255,255,.16) !important;color:#64748b !important;}
        .preview-module-card{background:linear-gradient(160deg,rgba(8,15,28,.75),rgba(5,10,20,.70));border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:16px;transition:transform .20s ease,border-color .20s ease,box-shadow .20s ease;cursor:default;}
        .preview-module-card:hover{transform:translateY(-3px);border-color:rgba(45,212,191,.20);box-shadow:0 10px 32px rgba(2,6,23,.55),0 0 16px rgba(45,212,191,.06);}
        .shimmer-line{background:linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.10) 50%,rgba(255,255,255,.04) 75%);background-size:300% 100%;border-radius:3px;animation:shimmer 2.6s ease-in-out infinite;}
        .scan-btn-live{transition:all .18s ease !important;}
        .scan-btn-live:hover{transform:translateY(-1px);animation:scanBtnGlow 1.6s ease-in-out infinite;}
        .live-dot{animation:liveDotPulse 2.2s ease-in-out infinite;}
        .clark-section{border-top:1px solid rgba(255,255,255,.04);padding-top:12px;margin-bottom:12px;}
        @media (prefers-reduced-motion:reduce){.live-dot,.radar-ring,.shimmer-line,.scan-btn-live,.cortex-score-hero{animation:none !important;} .scan-btn-live:hover,.cortex-chip:hover{transform:none !important;} .cortex-bdrow:hover{background:none !important;}}
        .metric-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr)) !important;gap:clamp(8px,1vw,12px) !important;}
        .activity-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;}
        @media (min-width:1536px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(360px,22vw,420px);} .token-main{max-width:1260px;margin:0 auto;}}
        @media (min-width:1280px) and (max-width:1535px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(320px,24vw,360px);} .token-main{max-width:1120px;margin:0 auto;} .mob-verdict-panel{padding:24px 16px;font-size:12px;} .activity-grid{gap:8px;}}
        @media (max-width:1279px){.token-shell{display:block;height:auto;overflow:visible;} .mob-scan-main{overflow-y:visible !important;} .token-shell .mob-verdict-panel{position:static !important;width:100% !important;max-width:100% !important;height:auto !important;min-height:0 !important;border-left:none !important;border-top:1px solid rgba(255,255,255,0.08) !important;overflow-y:visible !important;}}
        @media (max-width:1023px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;} .holders-grid,.intel-grid{grid-template-columns:1fr !important;} .activity-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;}}
        @media (max-width:768px){.token-main{padding:36px 14px 120px !important;} .token-input-row{flex-direction:column;max-width:100% !important;} .token-input-row button{width:100%;} .top-holder-head{display:none !important;} .top-holder-row{display:block !important;padding:12px !important;} .top-holder-mobile-meta{display:flex !important;align-items:center;justify-content:space-between;gap:8px;} .top-holder-mobile-amt{display:block !important;margin-top:6px !important;text-align:left !important;} .pools-scroll{overflow-x:auto !important;-webkit-overflow-scrolling:touch;margin:0 -12px;padding:0 12px;} .mob-verdict-panel{padding:18px 14px !important;gap:12px !important;} .glass-card{padding:14px !important;} .preview-module-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;}}
      `}</style>

      <div className="token-shell" style={{ color: '#e2e8f0' }}>

        {/* ── Left: scrollable scan area ──────────────────────────── */}
        <div className="mob-scan-main token-main" style={{ minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '44px clamp(16px, 2.2vw, 34px) 120px', width: '100%' }}>

          {/* ── Hero area ─────────────────────────────────────────── */}
          <div style={{ marginBottom: '28px', maxWidth: '820px' }}>

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
            <p style={{ margin: '0 0 14px', color: '#64748b', fontSize: '13px', lineHeight: 1.65, maxWidth: '560px' }}>
              {chain === 'eth'
                ? 'Scan Ethereum tokens for liquidity, contract risk, taxes, pool depth, and Clark AI verdicts.'
                : 'Scan Base tokens for liquidity, contract risk, taxes, pool depth, and Clark AI verdicts.'}
            </p>

            {/* Status pills */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '7px' }}>
              {[
                { label: 'BASE',           color: '#2DD4BF', bg: 'rgba(45,212,191,0.07)',  border: 'rgba(45,212,191,0.22)' },
                { label: 'ETH',            color: '#818cf8', bg: 'rgba(129,140,248,0.07)', border: 'rgba(129,140,248,0.22)' },
                { label: 'LIVE CORTEX',    color: '#34d399', bg: 'rgba(52,211,153,0.07)',  border: 'rgba(52,211,153,0.20)' },
                { label: 'REAL DATA ONLY', color: '#475569', bg: 'rgba(71,85,105,0.07)',   border: 'rgba(71,85,105,0.18)' },
              ].map(p => (
                <span key={p.label} style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.11em', padding: '3px 10px', borderRadius: '99px', color: p.color, background: p.bg, border: `1px solid ${p.border}`, fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>
                  {p.label}
                </span>
              ))}
              <span style={{ fontSize: '10px', color: '#253340', fontFamily: 'var(--font-plex-mono)', marginLeft: '2px' }}>
                {planLoading ? 'Checking access…' : ''}
              </span>
            </div>
          </div>

          {/* ── Search card with hologram ─────────────────────────── */}
          <div style={{ position: 'relative', maxWidth: '820px', marginBottom: '32px' }}>

            {/* Decorative radar hologram (behind card) */}
            <div style={{ position: 'absolute', left: '50%', top: '-32px', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 0, width: '260px', height: '88px', overflow: 'hidden', opacity: 0.48 }} aria-hidden="true">
              <svg width="260" height="88" viewBox="0 0 260 88" fill="none">
                <circle cx="130" cy="44" r="4.5" fill="#2DD4BF" className="live-dot" />
                <circle cx="130" cy="44" r="3" fill="rgba(139,92,246,0.55)" />
                {([0, 0.5, 1.0] as const).map((delay, i) => (
                  <circle key={i} cx="130" cy="44" r={16 + i * 16} stroke="#2DD4BF" strokeWidth="0.5" className="radar-ring"
                    style={{ animation: `radarRing 2.6s ${delay}s ease-out infinite`, transformOrigin: '130px 44px' }} />
                ))}
                <circle cx="130" cy="44" r={64} stroke="rgba(139,92,246,0.22)" strokeWidth="0.5" className="radar-ring"
                  style={{ animation: 'radarRing 2.6s 1.0s ease-out infinite', transformOrigin: '130px 44px' }} />
              </svg>
            </div>

            {/* Premium search card */}
            <div className="search-card" style={{ position: 'relative', zIndex: 1, padding: '22px 22px 18px' }}>

              {/* Chain tabs */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '18px' }}>
                {(['base', 'eth'] as const).map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChain(c)}
                    className={chain === c ? 'chain-tab-active' : 'chain-tab-inactive'}
                    style={{
                      padding: '9px 22px', borderRadius: '10px',
                      fontSize: '11px', fontWeight: 700, letterSpacing: '.13em',
                      fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
                      transition: 'all 0.15s', flexShrink: 0,
                    }}
                  >
                    {c === 'base' ? 'BASE' : 'ETHEREUM'}
                  </button>
                ))}
              </div>

              {/* Input + button row */}
              <div className="token-input-row" style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                <input
                  value={input}
                  onChange={e => { setInput(e.target.value); setResolverResult(null) }}
                  onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
                  disabled={loading}
                  placeholder={chain === 'eth' ? 'Paste Ethereum contract, symbol, or token name' : 'Paste Base contract, symbol, or token name'}
                  style={{
                    flex: 1, padding: '14px 18px',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: '12px',
                    color: '#e2e8f0', fontSize: '15px',
                    fontFamily: 'var(--font-plex-mono)',
                    outline: 'none',
                    opacity: loading ? 0.6 : 1,
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                    minWidth: 0,
                  }}
                  onFocus={e => {
                    e.currentTarget.style.borderColor = 'rgba(45,212,191,0.55)'
                    e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.08)'
                  }}
                  onBlur={e => {
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                />
                <button
                  onClick={() => handleScan()}
                  disabled={loading || resolving || !input.trim()}
                  className={loading || resolving || !input.trim() ? '' : 'scan-btn-live'}
                  style={{
                    padding: '14px 32px', borderRadius: '12px', border: 'none',
                    background: loading || resolving || !input.trim()
                      ? 'rgba(45,212,191,0.09)'
                      : 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 100%)',
                    color: loading || resolving || !input.trim() ? 'rgba(255,255,255,0.20)' : '#04040a',
                    fontSize: '12px', fontWeight: 800,
                    fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.12em',
                    cursor: loading || resolving || !input.trim() ? 'not-allowed' : 'pointer',
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    boxShadow: loading || resolving || !input.trim() ? 'none' : '0 2px 16px rgba(45,212,191,0.22)',
                  }}
                >
                  {resolving ? 'RESOLVING…' : loading ? 'SCANNING…' : 'SCAN TOKEN'}
                </button>
              </div>

              {/* Helper text */}
              <p style={{ margin: 0, fontSize: '11px', color: '#2a3d4d', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5, letterSpacing: '0.02em' }}>
                Paste a contract, ticker, or token name to start a scan.
              </p>
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
                      onClick={() => {
                        const altChain: 'base' | 'eth' = alt.chainId === 'ethereum' ? 'eth' : alt.chainId === 'base' ? 'base' : 'base'
                        setChain(altChain)
                        handleScan(alt.contractAddress, altChain)
                      }}
                      style={{ padding:'4px 10px', borderRadius:'999px', background:'rgba(100,116,139,0.12)', border:'1px solid rgba(100,116,139,0.25)', color:'#94a3b8', fontSize:'9px', fontFamily:'var(--font-plex-mono)', cursor:'pointer', display:'flex', alignItems:'center', gap:'5px' }}
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
              {error}
            </div>
          )}

          {/* ── Premium empty state / module preview ─────────────── */}
          {!loading && !resolving && !result && !error && (
            <div style={{ maxWidth: '820px' }}>

              {/* Headline */}
              <div style={{ marginBottom: '20px' }}>
                <p style={{ margin: '0 0 7px', fontSize: '14px', fontWeight: 700, color: '#94a3b8', lineHeight: 1.45, letterSpacing: '-0.005em' }}>
                  Run a scan to generate a full token intelligence report.
                </p>
                <p style={{ margin: 0, fontSize: '11px', color: '#253340', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.65 }}>
                  CORTEX will build Market Pulse, Holder Map, LP Safety, Dev Control, Cluster Map, and Risk context.
                </p>
              </div>

              {/* Module preview grid */}
              <div className="preview-module-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '12px', marginBottom: '28px' }}>
                {[
                  { label: 'Market Pulse',  dot: '#2DD4BF', desc: 'Price, liquidity, volume, and pool depth.' },
                  { label: 'Holder Map',    dot: '#a78bfa', desc: 'Top holder concentration and distribution.' },
                  { label: 'LP Safety',     dot: '#34d399', desc: 'Pool lock status and liquidity risk.' },
                  { label: 'Dev Control',   dot: '#fbbf24', desc: 'Deployer wallet and contract ownership.' },
                  { label: 'Cluster Map',   dot: '#67e8f9', desc: 'Wallet clustering and coordination signals.' },
                  { label: 'CORTEX Risk',   dot: '#f87171', desc: 'Aggregated rug risk and open checks.' },
                ].map(mod => (
                  <div key={mod.label} className="preview-module-card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '9px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: mod.dot, flexShrink: 0, opacity: 0.65, boxShadow: `0 0 6px ${mod.dot}44` }} />
                      <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', color: '#4b6070', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{mod.label}</span>
                    </div>
                    <p style={{ margin: '0 0 12px', fontSize: '11px', color: '#2a3d4d', lineHeight: 1.55 }}>{mod.desc}</p>
                    {/* Skeleton placeholder lines */}
                    <div className="shimmer-line" style={{ height: '5px', width: '72%', marginBottom: '6px' }} />
                    <div className="shimmer-line" style={{ height: '5px', width: '48%' }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Results */}
          {result && (
            <div style={{ maxWidth: 'none', width: '100%' }}>

              {/* Token identity — always visible */}
              <div style={{ marginBottom: '20px' }}>
                <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', margin: '0 0 4px' }}>
                  {result.name ?? 'Unknown'}
                  {result.symbol && <span style={{ marginLeft: '10px', fontSize: '14px', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}>{result.symbol}</span>}
                </h2>
                {result.contract && (
                  <p style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    {shorten(result.contract)}{` · ${String(result.chain ?? 'Base').toUpperCase()}`}
                    <span style={{ marginLeft: '8px', padding: '2px 8px', border: '1px solid rgba(59,130,246,.35)', borderRadius: '999px', color: '#93c5fd' }}>{String(result.chain ?? chain).toUpperCase()}</span>
                  </p>
                )}
                {result.resolvedInput && result.resolvedInput.type !== 'address' && (
                  <p style={{ margin: '6px 0 0', color: '#94a3b8', fontSize: '11px' }}>Resolved from {result.resolvedInput.original.toUpperCase()}.</p>
                )}
              </div>

              {/* CORTEX Command Bar */}
              {(() => {
                const cmds: Array<{ id: typeof activeSection; label: string; dot: string }> = [
                  { id: 'cortex-read',  label: 'CORTEX Read',  dot: '#2DD4BF' },
                  { id: 'market-pulse', label: 'Market Pulse',  dot: '#67e8f9' },
                  { id: 'holder-map',   label: 'Holder Map',    dot: '#a78bfa' },
                  { id: 'lp-safety',    label: 'LP Safety Analyzer', dot: '#34d399' },
                  { id: 'risk-engine',  label: 'CORTEX Risk Engine', dot: '#f87171' },
                  { id: 'deployer-intel', label: 'Dev Control', dot: '#fbbf24' },
                ]
                return (
                  <div style={{ display: 'flex', gap: '3px', marginBottom: '22px', overflowX: 'auto', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {cmds.map(s => {
                      const active = activeSection === s.id
                      return (
                        <button key={s.id} onClick={() => setActiveSection(s.id)}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '6px',
                            padding: '6px 13px', borderRadius: '8px', cursor: 'pointer',
                            whiteSpace: 'nowrap', flexShrink: 0,
                            fontFamily: 'var(--font-plex-mono)', fontSize: '10px',
                            fontWeight: active ? 800 : 600, letterSpacing: '0.11em',
                            transition: 'all 0.14s',
                            background: active ? `linear-gradient(135deg,${s.dot}16,rgba(139,92,246,0.10))` : 'transparent',
                            border: active ? `1px solid ${s.dot}40` : '1px solid transparent',
                            color: active ? s.dot : '#3a5268',
                            boxShadow: active ? `0 0 14px ${s.dot}14` : 'none',
                          }}
                        >
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0, background: active ? s.dot : '#1e3a44', boxShadow: active ? `0 0 6px ${s.dot}` : 'none' }} />
                          {s.label}
                        </button>
                      )
                    })}
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
                const lpStatus = result.lpControl?.status
                const lpMode = getLpMode(result)
                const lpVerified = lpStatus === 'locked' || lpStatus === 'burned'
                const marketChipOk = (result.price != null || result.liquidity != null) && !result.noActivePools
                const holdersChipOk = holderState.kind === 'rowsWithPercent'
                const holdersChipPartial = holderState.kind === 'rowsWithoutPercent'
                const riskChipOk = result.honeypot?.isHoneypot === false && result.honeypot?.simulationSuccess === true
                const simUnavailable = !result.honeypot?.simulationSuccess
                const hp2 = result.honeypot
                const liq2 = result.liquidity ?? 0
                const buyTax2 = hp2?.buyTax ?? null
                const sellTax2 = hp2?.sellTax ?? null
                const taxesHigh2 = (buyTax2 != null && buyTax2 > 8) || (sellTax2 != null && sellTax2 > 8)
                const goodSigns: string[] = [
                  (hp2?.isHoneypot === false && hp2?.simulationSuccess) ? 'Security simulation passed — no honeypot flagged.' : '',
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
                  !hp2?.simulationSuccess ? 'Tax simulation unavailable — status is an open check.' : '',
                  result.noActivePools ? `No active liquidity pool detected on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.` : '',
                ].filter(Boolean).slice(0, 4) as string[]
                const missing2 = getMissingChecks(result)
                const next2 = getNextAction(result)
                const statusChips = [
                  { label: 'Market',      chipOk: marketChipOk,    chipPartial: false,              chipColor: marketChipOk ? '#34d399' : '#f87171' },
                  { label: 'Holders',     chipOk: holdersChipOk,   chipPartial: holdersChipPartial, chipColor: holdersChipOk ? '#34d399' : holdersChipPartial ? '#fbbf24' : '#f87171' },
                  { label: 'LP Control',  chipOk: lpVerified || lpMode === 'protocol', chipPartial: lpMode === 'unknown', chipColor: lpVerified || lpMode === 'protocol' ? '#34d399' : lpMode === 'unknown' ? '#fbbf24' : '#f87171' },
                  { label: 'Risk Checks', chipOk: riskChipOk,      chipPartial: simUnavailable,     chipColor: riskChipOk ? '#34d399' : simUnavailable ? '#94a3b8' : '#f87171' },
                ]
                const marketStrengthLabel = result.noActivePools ? 'Open check' : (result.liquidity ?? 0) > 250000 ? 'Strong' : (result.liquidity ?? 0) > 50000 ? 'Active' : (result.liquidity ?? 0) > 0 ? 'Thin' : 'Open check'
                const holderRiskLabel = holderState.kind !== 'rowsWithPercent' ? 'Open check' : (result.holderDistribution?.top10 ?? 0) > 50 ? 'High' : (result.holderDistribution?.top10 ?? 0) > 30 ? 'Medium' : 'Low'
                const lpProofLabel = lpMode === 'protocol' ? 'Not applicable' : lpStatus === 'locked' || lpStatus === 'burned' ? 'Verified' : lpStatus === 'team_controlled' ? 'Team controlled' : lpStatus === 'partial' ? 'Partial' : lpStatus === 'no_pool' ? 'Open check' : lpMode === 'unknown' ? 'Open check' : 'Open check'
                const securityConfidenceLabel = result.honeypot?.simulationSuccess ? (result.honeypot?.isHoneypot === false ? 'Verified' : 'Partial') : 'Open check'
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
                return (
                  <>
                    {/* CORTEX Score Hero */}
                    <div className="cortex-score-hero" style={{ marginBottom: '20px', background: 'linear-gradient(160deg,rgba(8,16,32,.98),rgba(4,8,18,.96))', border: `1px solid ${scoreColor}32`, borderRadius: '18px', padding: '22px 24px', boxShadow: `0 0 60px ${scoreColor}12, 0 0 24px ${scoreColor}08, 0 0 0 1px ${scoreColor}06 inset` }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px', flexWrap: 'wrap', marginBottom: '18px' }}>
                        <div style={{ flexShrink: 0 }}>
                          <div style={{ fontSize: '10px', letterSpacing: '.18em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '6px' }}>CORTEX SCORE</div>
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
                        {statusChips.map(({ label, chipOk, chipPartial, chipColor }) => (
                          <div key={label} className="cortex-chip" style={{ padding: '9px 11px', borderRadius: '10px', background: `${chipColor}0a`, border: `1px solid ${chipColor}2a`, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: chipColor, flexShrink: 0, boxShadow: `0 0 7px ${chipColor}` }} />
                            <div>
                              <div style={{ fontSize: '9px', letterSpacing: '.12em', color: chipColor, fontFamily: 'var(--font-plex-mono)', fontWeight: 700 }}>{label}</div>
                              <div style={{ fontSize: '9px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>{chipOk ? 'Verified' : chipPartial ? 'Partial' : 'Open check'}</div>
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
                      <p style={{ margin:'0 0 12px', fontSize:'10px', letterSpacing:'.16em', color:'#7dd3fc', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>CORTEX SCORE BREAKDOWN</p>
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
                  <div style={{ marginBottom: '18px' }}>
                    <p style={{ margin: '0 0 3px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.10em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>MARKET PULSE</p>
                    <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Live price, liquidity, volume and pool data for this token.</p>
                  </div>
                  <div style={{ marginBottom: '16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: '9px' }}>
                    {(() => {
                      const marketStrength = result.noActivePools ? 'Not indexed' : (result.liquidity ?? 0) > 250000 ? 'Strong' : (result.liquidity ?? 0) > 50000 ? 'Active' : (result.liquidity ?? 0) > 0 ? 'Thin' : 'Not indexed'
                      const volRead = result.priceChange24h == null ? 'Not indexed' : Math.abs(result.priceChange24h) > 20 ? 'High volatility' : Math.abs(result.priceChange24h) > 8 ? 'Moderate volatility' : 'Controlled volatility'
                      const activityRead = result.volume24h != null && result.liquidity != null && result.liquidity > 0 ? `${((result.volume24h / result.liquidity) * 100).toFixed(0)}% vol/liquidity` : 'Not indexed'
                      const mcfdvRead = result.marketCapUsd != null && result.fdvUsd != null && result.fdvUsd > 0 ? `${((result.marketCapUsd / result.fdvUsd) * 100).toFixed(0)}% MC/FDV` : 'Not indexed'
                      const items = [
                        ['Market strength', marketStrength],
                        ['Liquidity depth', result.liquidity != null ? fmtLarge(result.liquidity) : 'Not indexed'],
                        ['24h activity', activityRead],
                        ['Volatility read', volRead],
                        ['MC vs FDV read', mcfdvRead],
                      ] as Array<[string,string]>
                      return items.map(([label, value]) => (
                        <div key={label} style={{ padding:'11px 12px', borderRadius:'10px', border:'1px solid rgba(103,232,249,0.16)', background:'rgba(8,14,28,0.62)' }}>
                          <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', fontFamily:'var(--font-plex-mono)', marginBottom:'4px' }}>{label}</div>
                          <div style={{ fontSize:'12px', color:'#e2e8f0', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{value}</div>
                        </div>
                      ))
                    })()}
                  </div>
                  {/* Market Insight Strip */}
                  {!result.noActivePools && (result.price != null || result.liquidity != null) && (
                    <div style={{ marginBottom: '20px', padding: '14px 18px', background: 'linear-gradient(135deg,rgba(103,232,249,0.05),rgba(45,212,191,0.03))', border: '1px solid rgba(103,232,249,0.18)', borderRadius: '14px', display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'center' }}>
                      <div style={{ flexShrink: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.16em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>LIVE PRICE</div>
                          {result.chartSource === 'synthetic_flat_series' && (
                            <svg width="32" height="16" viewBox="0 0 32 16" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                              <defs>
                                <filter id="spkGlow" x="-20%" y="-100%" width="140%" height="300%">
                                  <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="b" />
                                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                                </filter>
                              </defs>
                              <line x1="2" y1="8" x2="30" y2="8" stroke="rgba(0,255,255,0.65)" strokeWidth="1.5" filter="url(#spkGlow)" />
                              <circle cx="30" cy="8" r="2" fill="rgba(0,255,255,0.8)" filter="url(#spkGlow)" />
                            </svg>
                          )}
                          {result.priceSource === 'fdv_derived' && (
                            <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.08em', padding: '1px 6px', borderRadius: '99px', color: '#94a3b8', background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.22)', textTransform: 'uppercase' }}>Estimated from FDV</span>
                          )}
                          {result.priceSource === 'coingecko' && (
                            <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.08em', padding: '1px 6px', borderRadius: '99px', color: '#94a3b8', background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.22)', textTransform: 'uppercase' }}>CoinGecko</span>
                          )}
                          {result.priceSource === 'dexscreener' && (
                            <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.08em', padding: '1px 6px', borderRadius: '99px', color: '#94a3b8', background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.22)', textTransform: 'uppercase' }}>DexScreener</span>
                          )}
                          {result.price != null && result.priceSource == null && (
                            <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.08em', padding: '1px 6px', borderRadius: '99px', color: '#94a3b8', background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.22)', textTransform: 'uppercase' }}>Unverified price</span>
                          )}
                        </div>
                        <div style={{ fontSize: '22px', fontWeight: 800, color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>{fmtPrice(result.price)}</div>
                      </div>
                      <div style={{ width: '1px', height: '32px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', flex: 1 }}>
                        {result.priceChange24h != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>24H MOVE</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: result.priceChange24h >= 0 ? '#34d399' : '#f87171', fontFamily: 'var(--font-plex-mono)' }}>{fmtPct(result.priceChange24h)}</div>
                          </div>
                        )}
                        {result.liquidity != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>LIQUIDITY</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{fmtLarge(result.liquidity)}</div>
                          </div>
                        )}
                        {result.volume24h != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>VOLUME 24H</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{fmtLarge(result.volume24h)}</div>
                          </div>
                        )}
                        {result.poolActivity?.pairAgeLabel != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>PAIR AGE</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>{result.poolActivity.pairAgeLabel}</div>
                          </div>
                        )}
                        {result.marketCapUsd != null && result.fdvUsd != null && result.fdvUsd > 0 && result.marketCapUsd !== result.fdvUsd && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>MC / FDV</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>{`${((result.marketCapUsd / result.fdvUsd) * 100).toFixed(0)}%`}</div>
                          </div>
                        )}
                        {(() => {
                          const volLiqRatio = result.volume24h != null && result.liquidity != null && result.liquidity > 0
                            ? result.volume24h / result.liquidity
                            : null
                          if (volLiqRatio == null) return null
                          const ratioColor = volLiqRatio > 3 ? '#f87171' : volLiqRatio > 1 ? '#fbbf24' : '#34d399'
                          return (
                            <div>
                              <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>VOL / LIQ</div>
                              <div style={{ fontSize: '14px', fontWeight: 700, color: ratioColor, fontFamily: 'var(--font-plex-mono)' }}>{volLiqRatio.toFixed(2)}x</div>
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )}
                  {(() => {
                    const volLiqRatio = result.volume24h != null && result.liquidity != null && result.liquidity > 0
                      ? result.volume24h / result.liquidity
                      : null
                    const volLiqRead = volLiqRatio == null
                      ? 'Volume/liquidity ratio unavailable.'
                      : volLiqRatio > 3
                        ? 'Volume is very high relative to liquidity — expect significant volatility and slippage.'
                        : volLiqRatio > 1
                          ? 'Volume is high relative to liquidity — expect volatility.'
                          : 'Healthy activity — volume is proportionate to liquidity depth.'
                    if (!result.noActivePools && (result.volume24h != null || result.liquidity != null)) {
                      return (
                        <div style={{ marginBottom: '16px', padding: '11px 14px', borderRadius: '10px', background: 'rgba(103,232,249,0.04)', border: '1px solid rgba(103,232,249,0.14)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, flexShrink: 0 }}>VOL/LIQ READ</span>
                          <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{volLiqRead}</span>
                          {volLiqRatio != null && <span style={{ marginLeft: 'auto', fontSize: '12px', fontWeight: 800, color: volLiqRatio > 3 ? '#f87171' : volLiqRatio > 1 ? '#fbbf24' : '#34d399', fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}>{volLiqRatio.toFixed(2)}x</span>}
                        </div>
                      )
                    }
                    return null
                  })()}
                  {result.noActivePools ? (
                    <div style={{ padding: '20px 22px', marginBottom: '28px', background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '12px', fontFamily: 'var(--font-plex-mono)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
                        <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: '#fbbf24', textTransform: 'uppercase' }}>No Active Pool Found</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: '#b7a675', lineHeight: 1.55 }}>No liquidity pools were found for this contract on {result.chain === 'eth' ? 'Ethereum' : 'Base'}. Price, volume, and liquidity data are unavailable.</p>
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
                      <div className="metric-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '10px', marginBottom: '28px' }}>
                        <StatCard label="Price" value={fmtPrice(result.price)} accent="#2DD4BF" helper={result.marketDataSource === 'fallback' ? 'Market read' : 'Primary pool'} />
                        <StatCard label="Liquidity" value={fmtLarge(result.liquidity)} helper="Pool depth" />
                        <StatCard label="Volume 24h" value={fmtLarge(result.volume24h)} helper="24h trading activity" />
                        <StatCard label="24h Change" value={fmtPct(result.priceChange24h)} accent={pctColor(result.priceChange24h)} helper="Price movement" />
                        {(() => {
                          const val = result.valuationContext
                          const fdvOnly = val?.primaryValuationStatus === 'fdv_only' && val?.primaryValuationUsd != null
                          return (
                            <StatCard
                              label={fdvOnly ? 'Valuation' : 'Market Cap'}
                              value={val?.primaryValuationStatus === 'verified_mc' ? fmtLarge(val.primaryValuationUsd) : fdvOnly ? `FDV ${fmtLarge(val.primaryValuationUsd)}` : 'Supply not confirmed'}
                              helper={val?.primaryValuationStatus === 'verified_mc' ? 'Verified live market data' : fdvOnly ? 'Market cap not verified live' : 'Live valuation not verified'}
                              accent="#a78bfa"
                            />
                          )
                        })()}
                        <StatCard label="FDV" value={result.fdvUsd != null ? fmtLarge(result.fdvUsd) : 'Not indexed'} helper="Fully Diluted Valuation" accent="#a78bfa" />
                        <StatCard label="Pool Protocol" value={result.primaryDexName ?? 'Protocol not confirmed'} helper={result.primaryDexName ? 'Primary liquidity pool' : 'Pool found · protocol metadata missing'} accent={result.primaryDexName ? '#67e8f9' : '#64748b'} />
                      </div>
                    </>
                  )}
                  {result.marketCapStatus !== 'verified' && !result.noActivePools && (
                    <p style={{ marginTop: '-14px', marginBottom: '16px', color: '#94a3b8', fontSize: '12px' }}>Market cap not confirmed. FDV is shown separately.</p>
                  )}
                  {result.fdvUsd != null && result.marketCapUsd != null && result.marketCapUsd !== result.fdvUsd && (
                    <div style={{ marginBottom: '16px', padding: '10px 14px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.16)', borderRadius: '10px', fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>
                      <span style={{ color: '#a78bfa', fontWeight: 700 }}>MC vs FDV: </span>
                      {`Market cap ${fmtLarge(result.marketCapUsd)} reflects circulating supply. FDV ${fmtLarge(result.fdvUsd)} covers all tokens including locked and unvested. ${result.marketCapUsd / result.fdvUsd < 0.7 ? 'Significant unlock pressure possible.' : 'Low unlock pressure from current ratio.'}`}
                    </div>
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
                        <div className="glass-card" style={{ marginBottom: '22px', borderRadius: '16px', padding: '16px' }}>
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
                        <div className="glass-card" style={{ marginBottom: '22px', borderRadius: '16px', padding: '16px' }}>
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
                      <div className="glass-card" style={{ marginBottom: '22px', borderRadius: '16px', padding: '16px' }}>
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
                        const whalePressureColor = whalePressure === 'EXTREME' ? '#f87171' : whalePressure === 'HIGH' ? '#fb923c' : whalePressure === 'MEDIUM' ? '#fbbf24' : whalePressure === 'LOW' ? '#34d399' : '#94a3b8'
                        return (
                          <div className="holders-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                            {/* Whale Pressure Card */}
                            <div style={{ gridColumn:'1 / -1', marginBottom:'4px', padding:'14px 16px', borderRadius:'12px', background:'rgba(167,139,250,0.05)', border:`1px solid ${whalePressureColor}28` }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'12px', flexWrap:'wrap' }}>
                                <span style={{ fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#a78bfa', fontFamily:'var(--font-plex-mono)' }}>WHALE PRESSURE</span>
                                <span style={{ padding:'3px 10px', borderRadius:'999px', fontSize:'9px', fontWeight:800, letterSpacing:'.12em', color:whalePressureColor, background:`${whalePressureColor}12`, border:`1px solid ${whalePressureColor}40`, fontFamily:'var(--font-plex-mono)' }}>{whalePressure}</span>
                              </div>
                              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:'8px', marginBottom: (top10h != null && top10h > 50) || (top20h != null && top20h > 50) ? '10px' : '0' }}>
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
                              {top10h != null && top10h > 50 && (
                                <div style={{ display:'flex', gap:'6px', alignItems:'flex-start', padding:'7px 10px', borderRadius:'8px', background:'rgba(248,113,113,0.06)', border:'1px solid rgba(248,113,113,0.18)' }}>
                                  <span style={{ color:'#f87171', fontSize:'11px', flexShrink:0 }}>!</span>
                                  <span style={{ fontSize:'11px', color:'#fca5a5', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>Top wallets control majority supply.</span>
                                </div>
                              )}
                              {top20h != null && top20h > 50 && !(top10h != null && top10h > 50) && (
                                <div style={{ display:'flex', gap:'6px', alignItems:'flex-start', padding:'7px 10px', borderRadius:'8px', background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.18)' }}>
                                  <span style={{ color:'#fbbf24', fontSize:'11px', flexShrink:0 }}>!</span>
                                  <span style={{ fontSize:'11px', color:'#fde68a', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>Watch for coordinated holder movement.</span>
                                </div>
                              )}
                            </div>
                            <div style={{ gridColumn:'1 / -1', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))', gap:'8px' }}>
                              {[
                                ['Holder Risk', concRisk ?? 'Open check'],
                                ['Top 10 Control', top10h != null ? `${top10h.toFixed(1)}%` : 'Open check'],
                                ['Top 20 Control', top20h != null ? `${top20h.toFixed(1)}%` : 'Open check'],
                                ['Holder Count', holderCount != null ? holderCount.toLocaleString() : 'Open check'],
                                ['Supply Spread', concRead ?? 'Open check'],
                              ].map(([label,val])=>(
                                <div key={label} style={{ padding:'10px 11px', borderRadius:'10px', border:'1px solid rgba(167,139,250,0.22)', background:'rgba(15,23,42,0.55)' }}>
                                  <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', marginBottom:'4px', fontFamily:'var(--font-plex-mono)' }}>{label}</div>
                                  <div style={{ fontSize:'11px', color:'#e2e8f0', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{val}</div>
                                </div>
                              ))}
                            </div>
                            <div className="glass-card" style={{ padding: '18px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                                <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>HOLDER CONCENTRATION</p>
                                <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: `1px solid ${holderState.kind === 'rowsWithPercent' ? 'rgba(45,212,191,.5)' : 'rgba(251,191,36,.4)'}`, color: holderState.kind === 'rowsWithPercent' ? '#2dd4bf' : '#fbbf24', background: holderState.kind === 'rowsWithPercent' ? 'rgba(45,212,191,.1)' : 'rgba(251,191,36,.1)' }}>{holderState.kind === 'rowsWithPercent' ? 'VERIFIED' : 'PARTIAL'}</span>
                                {concRisk != null && <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: `1px solid ${concColor}44`, color: concColor, background: `${concColor}10` }}>{concRisk} CONC</span>}
                              </div>
                              {result.holderDistribution?.holderCount != null && <div style={{ margin: '0 0 12px', fontSize: '13px', color: '#67e8f9', border: '1px solid rgba(45,212,191,.3)', background: 'rgba(6,78,59,.16)', padding: '8px 10px', borderRadius: '10px', display: 'inline-flex', gap: '8px' }}><span style={{ color: '#99f6e4' }}>Holder count</span><strong style={{ fontFamily: 'var(--font-plex-mono)', color: '#e6fffa' }}>{result.holderDistribution.holderCount.toLocaleString()}</strong></div>}
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
                              {(top10h != null && top10h > 50) && (
                                <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#fca5a5', lineHeight: 1.5, border: '1px solid rgba(248,113,113,0.28)', background: 'rgba(248,113,113,0.08)', borderRadius: '10px', padding: '8px 10px' }}>
                                  High concentration — top wallets control majority supply.
                                </p>
                              )}
                              {(top1h != null && top1h > 20) && (
                                <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#fecaca', lineHeight: 1.5, border: '1px solid rgba(248,113,113,0.22)', background: 'rgba(248,113,113,0.06)', borderRadius: '10px', padding: '8px 10px' }}>
                                  Largest holder has meaningful supply control.
                                </p>
                              )}
                              {holderState.kind === 'rowsWithPercent' && top10h != null && <p style={{ margin: '10px 0 0', fontSize: '11px', color: concColor, lineHeight: 1.5 }}>{`Top 10 controls ${top10h.toFixed(1)}%. Monitor concentration before trusting supply distribution.`}</p>}
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
                        )
                      }
                      const fb = buildHolderFallbackRead(fallback)
                      const lpS = result.lpControl?.status
                      const lpV = lpS === 'locked' || lpS === 'burned'
                      const hpV = result.honeypot?.simulationSuccess === true
                      const evItems: Array<{label:string;value:string;ok:boolean}> = [
                        { label: 'Market data',         value: result.price!=null?'Available':'Unavailable',                   ok: result.price!=null },
                        { label: 'Liquidity depth',     value: fallback.liquidityDepth!=null?fmtLarge(fallback.liquidityDepth):'Open check', ok: fallback.liquidityDepth!=null },
                        { label: 'Pool count',          value: fallback.poolCount>0?String(fallback.poolCount):'Open check',    ok: fallback.poolCount>0 },
                        { label: 'LP control',          value: lpV?'Verified':'Open check',                                   ok: lpV },
                        { label: 'Owner status',        value: fallback.ownerStatus,                                           ok: fallback.ownerStatus==='Renounced' },
                        { label: 'Security simulation', value: hpV?'Verified':'Open check',                                   ok: hpV },
                      ]
                      return (
                        <div style={{ marginBottom: '20px', background: 'linear-gradient(160deg,rgba(12,10,4,.72),rgba(4,8,18,.88))', border: '1px solid rgba(251,191,36,.22)', borderRadius: '14px', padding: '18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                            <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>HOLDER CONCENTRATION</p>
                            <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: '1px solid rgba(251,191,36,.4)', color: '#fbbf24', background: 'rgba(251,191,36,.08)' }}>UNVERIFIED</span>
                          </div>
                          <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#fde68a', lineHeight: 1.5 }}>Holder distribution was not returned in this scan. Supply concentration remains an open risk check.</p>
                          <div className="intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '8px', marginBottom: '14px' }}>
                            {evItems.map(({label,value,ok})=>(
                              <div key={label} style={{ padding: '9px 10px', borderRadius: '10px', background: 'rgba(15,23,42,0.42)', border: `1px solid ${ok?'rgba(52,211,153,.22)':value==='Open check'?'rgba(251,191,36,.22)':'rgba(248,113,113,.22)'}` }}>
                                <div style={{ fontSize: '9px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>{label}</div>
                                <div style={{ fontSize: '11px', fontWeight: 700, color: ok?'#34d399':value==='Open check'?'#fbbf24':'#f87171', fontFamily: 'var(--font-plex-mono)' }}>{value}</div>
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
                    const lockInfo = getLpLockLabel(result)
                    const exitInfo = getLpExitRiskInfo(result)
                    const lpModeVal = getLpMode(result)
                    const lpStatus = result.lpControl?.status
                    const hasPool = (result.liquidity ?? 0) > 0 || result.lpControl?.poolAddressPresent
                    const lpStatus2 = result.lpControl?.status
                    const dm2 = result.lpControl?.displayLpModel
                    const effectiveDm = (dm2 === 'no_pool' && hasPool) ? 'open_check' : dm2
                    const lpProofConfirmed = lpStatus2 === 'burned' || lpStatus2 === 'locked'
                    const modelLabel = effectiveDm === 'concentrated_liquidity' ? 'Concentrated Liquidity'
                      : effectiveDm === 'protocol_or_gauge' ? 'Protocol / Gauge Pool'
                      : effectiveDm === 'erc20_lp_token' ? 'ERC-20 LP Token'
                      : effectiveDm === 'no_pool' ? 'No Active Pool'
                      : lpModeVal === 'protocol' ? 'Concentrated'
                      : lpModeVal === 'lp_token' ? 'ERC-20 LP Token'
                      : hasPool ? 'Model Open Check'
                      : 'Unverified'
                    const modelColor = effectiveDm === 'concentrated_liquidity' ? '#c084fc'
                      : effectiveDm === 'protocol_or_gauge' ? '#a78bfa'
                      : effectiveDm === 'erc20_lp_token' ? (lpProofConfirmed ? '#34d399' : '#60a5fa')
                      : effectiveDm === 'no_pool' ? '#94a3b8'
                      : lpModeVal === 'protocol' ? '#c084fc'
                      : lpModeVal === 'lp_token' ? (lpProofConfirmed ? '#34d399' : '#60a5fa')
                      : hasPool ? '#fbbf24'
                      : '#94a3b8'
                    const modelDesc = effectiveDm === 'concentrated_liquidity' ? 'V3/V4-style pool detected. Standard ERC-20 LP lock/burn proof does not apply.'
                      : effectiveDm === 'protocol_or_gauge' ? 'Protocol-managed liquidity model detected. Monitor pool depth, emissions/gauge context, and holder concentration.'
                      : effectiveDm === 'erc20_lp_token' ? (lpProofConfirmed ? 'Standard ERC-20 LP token — lock or burn proof confirmed.' : 'Standard ERC-20 LP token detected. Lock or burn proof has not been verified.')
                      : effectiveDm === 'no_pool' ? 'No active liquidity pool detected for this token.'
                      : lpModeVal === 'protocol' ? 'V3/V4-style pool — no ERC-20 LP tokens. Lock/burn proof does not apply.'
                      : lpModeVal === 'lp_token' ? (lpProofConfirmed ? 'Standard ERC-20 LP token — lock or burn proof confirmed.' : 'Standard ERC-20 LP token detected. Lock or burn proof has not been verified.')
                      : hasPool ? 'Pool detected, but LP token model could not be fully classified.'
                      : 'Pool structure could not be classified from this scan.'
                    void lpStatus
                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: '10px', marginBottom: '14px' }}>
                        <div style={{ padding: '15px 17px', background: lockInfo.bg, border: `1px solid ${lockInfo.border}`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>LP Status</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: lockInfo.color, flexShrink: 0, boxShadow: `0 0 8px ${lockInfo.color}` }} />
                            <span style={{ fontSize: '16px', fontWeight: 800, color: lockInfo.color, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.03em' }}>{lockInfo.label}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{lockInfo.description}</p>
                        </div>
                        <div style={{ padding: '15px 17px', background: `${exitInfo.color}08`, border: `1px solid ${exitInfo.color}28`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>Exit Risk</div>
                          <div style={{ marginBottom: '8px' }}>
                            <span style={{ padding: '4px 13px', borderRadius: '999px', background: `${exitInfo.color}14`, border: `1px solid ${exitInfo.color}45`, color: exitInfo.color, fontSize: '14px', fontWeight: 800, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.05em' }}>{exitInfo.label}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{exitInfo.description}</p>
                        </div>
                        <div style={{ padding: '15px 17px', background: `${modelColor}08`, border: `1px solid ${modelColor}28`, borderRadius: '14px' }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.15em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px', fontWeight: 700, textTransform: 'uppercase' }}>LP Model</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: modelColor, flexShrink: 0, boxShadow: `0 0 8px ${modelColor}` }} />
                            <span style={{ fontSize: '16px', fontWeight: 800, color: modelColor, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.03em' }}>{modelLabel}</span>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{modelDesc}</p>
                        </div>
                      </div>
                    )
                  })()}

                  {/* ── Compact detail rows ───────────────────────────── */}
                  {(() => {
                    const lpModeVal = getLpMode(result)
                    const lpStatus = result.lpControl?.status
                    const dm3 = result.lpControl?.displayLpModel
                    const poolCount = result.pools?.length ?? 0
                    const hasLiquidity = (result.liquidity ?? 0) > 0
                    const hasPool = hasLiquidity || result.lpControl?.poolAddressPresent
                    const notApplicable = dm3 === 'concentrated_liquidity' || dm3 === 'protocol_or_gauge' || result.lpControl?.proofStatus === 'not_applicable'
                    const lpProofVal = notApplicable ? 'Not applicable'
                      : lpStatus === 'burned' || lpStatus === 'locked' ? 'Confirmed'
                      : 'Open Check'
                    const migrationRisk = poolCount > 1 && lpStatus === 'team_controlled' ? 'Elevated' : poolCount > 1 ? 'Monitor' : poolCount === 1 ? 'Not flagged' : hasPool ? 'Pool detected' : 'Open Check'
                    const rows: { label: string; value: string }[] = [
                      { label: 'Liquidity', value: result.liquidity != null ? `$${fmtLarge(result.liquidity)}` : 'Open Check' },
                      { label: 'Primary Pool', value: result.primaryDexName ?? result.pools?.[0]?.name ?? 'Open Check' },
                      { label: 'Pool Count', value: poolCount > 0 ? `${poolCount} pool${poolCount > 1 ? 's' : ''}` : hasPool ? 'Pool detected' : 'Open Check' },
                      { label: 'LP Proof', value: lpProofVal },
                      { label: 'Migration Risk', value: migrationRisk },
                    ]
                    return (
                      <div style={{ marginBottom: '14px', padding: '10px 14px', background: 'rgba(8,14,28,0.55)', border: '1px solid rgba(148,163,184,0.10)', borderRadius: '12px' }}>
                        {rows.map(({ label, value }, i) => (
                          <div key={label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '12px', alignItems: 'center', padding: '7px 4px', borderBottom: i < rows.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                            <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', letterSpacing: '.08em' }}>{label}</span>
                            <span style={{ fontSize: '11px', color: value === 'Open Check' ? '#fbbf24' : value === 'Not applicable' ? '#64748b' : value === 'Confirmed' ? '#34d399' : '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{value}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })()}

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
                          <p style={{ margin: '0 0 8px', fontSize: '9px', fontWeight: 800, letterSpacing: '.15em', color: '#fbbf24', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Missing Proofs</p>
                          {rs.missingProofs.length > 0 ? rs.missingProofs.map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '5px' }}>
                              <span style={{ color: '#fbbf24', flexShrink: 0, fontWeight: 800, fontSize: '11px', lineHeight: '16px' }}>—</span>
                              <p style={{ margin: 0, fontSize: '11px', color: '#fde68a', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                            </div>
                          )) : <p style={{ margin: 0, fontSize: '11px', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>All key LP proofs passed.</p>}
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
                        {result.cortexLpRead.evidenceGaps.length > 0 && (
                          <div style={{ padding: '12px 14px', background: 'rgba(251,146,60,0.04)', border: '1px solid rgba(251,146,60,0.14)', borderRadius: '10px' }}>
                            <p style={{ margin: '0 0 5px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#fb923c', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Evidence Gaps</p>
                            <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>{result.cortexLpRead.evidenceGaps.join(' · ')}</p>
                          </div>
                        )}
                        <div style={{ padding: '12px 14px', background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.14)', borderRadius: '10px' }}>
                          <p style={{ margin: '0 0 5px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Next Action</p>
                          <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.6, color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>{result.cortexLpRead.nextActions.join(' ')}</p>
                        </div>
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
                    const sim = _secSim != null ? {
                      isHoneypot: _secSim.honeypot,
                      buyTax: _secSim.buyTax,
                      sellTax: _secSim.sellTax,
                      transferTax: _secSim.transferTax,
                      simulationSuccess: _secSim.simulationSuccess,
                    } : result.honeypot
                    const simVerified = sim?.simulationSuccess === true
                    const simUnavailable = sim == null
                    const lpState = result.lpControl?.status ?? 'unavailable_with_reason'
                    const ownerState = deriveHolderFallbackEvidence(result).ownerStatus
                    const missing2 = getMissingChecks(result)
                    const next2 = getNextAction(result)
                    const rugLabelMap: Record<string, string> = { low_visible_risk:'Low visible risk', watch:'Watch', high:'High', critical:'Critical', partial_data:'Open check', unavailable_with_reason:'Open check', unverified:'Open check' }
                    const lpLabelMap: Record<string, string> = { burned:'Burned', locked:'Locked', protocol:'Not applicable', concentrated_liquidity:'Not applicable', team_controlled:'Team controlled', partial:'Partial', no_pool:'Open check', unavailable_with_reason:'Open check', unverified:'Open check', insufficient_data:'Open check', error:'Open check' }
                    const displayCortexScore = result.cortexScore ?? engine?.cortexScore ?? (engine?.rugRiskScore != null ? Math.max(0, 100 - engine.rugRiskScore) : null)
                    const displayCortexVerdict = result.cortexVerdict ?? engine?.cortexVerdict ?? null
                    const displayCortexConfidence = result.cortexConfidence ?? engine?.cortexConfidence ?? (engine?.confidence ?? 'low')
                    const gaugeColor = displayCortexScore == null ? '#94a3b8' : displayCortexScore >= 85 ? '#34d399' : displayCortexScore >= 70 ? '#fbbf24' : displayCortexScore >= 50 ? '#f59e0b' : '#f43f5e'
                    const confColor = displayCortexConfidence === 'high' ? '#34d399' : displayCortexConfidence === 'medium' ? '#fbbf24' : displayCortexConfidence === 'low' ? '#94a3b8' : '#fbbf24'
                    const cardBase: React.CSSProperties = { padding:'14px 16px', background:'linear-gradient(145deg,rgba(6,12,24,.94),rgba(14,16,32,.84))', borderRadius:'14px' }
                    const cardTitle: React.CSSProperties = { margin:'0 0 10px',fontSize:'10px',fontWeight:700,letterSpacing:'.14em',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }
                    return (
                      <div style={{ display:'flex', flexDirection:'column', gap:'14px' }}>
                        {/* Hero: gauge + verdict + CORTEX read */}
                        <div style={{ padding:'20px 22px', background:'linear-gradient(160deg,rgba(8,16,32,.98),rgba(4,8,18,.95))', border:`1px solid ${gaugeColor}35`, borderRadius:'18px', boxShadow:`0 0 44px ${gaugeColor}0c` }}>
                          <div style={{ display:'flex', alignItems:'flex-start', gap:'22px', flexWrap:'wrap', marginBottom: engine?.cortexRead ? '16px' : '0' }}>
                            <div style={{ flexShrink:0 }}>
                              <RiskGaugeCircle score={displayCortexScore} color={gaugeColor} />
                            </div>
                            <div style={{ flex:1, minWidth:'160px', paddingTop:'4px' }}>
                              <div style={{ fontSize:'9px',letterSpacing:'.18em',color:'#3a5268',fontFamily:'var(--font-plex-mono)',marginBottom:'8px' }}>CORTEX RISK ENGINE</div>
                              <div style={{ display:'flex', gap:'8px', flexWrap:'wrap', marginBottom:'12px' }}>
                                <span style={{ padding:'5px 14px',borderRadius:'999px',fontSize:'11px',fontWeight:800,letterSpacing:'.10em',color:gaugeColor,background:`${gaugeColor}14`,border:`1px solid ${gaugeColor}44`,fontFamily:'var(--font-plex-mono)' }}>
                                  {displayCortexVerdict ?? (rugLabelMap[engine?.rugRiskLabel ?? 'unavailable_with_reason'] ?? 'OPEN CHECK')}
                                </span>
                                <span style={{ padding:'5px 10px',borderRadius:'999px',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',color:confColor,background:`${confColor}12`,border:`1px solid ${confColor}38`,fontFamily:'var(--font-plex-mono)' }}>
                                  {displayCortexConfidence === 'insufficient' ? 'Insufficient confidence' : displayCortexConfidence === 'low' ? 'Partial confidence' : `${displayCortexConfidence.toUpperCase()} CONFIDENCE`}
                                </span>
                              </div>
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

                        {/* Cards grid */}
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:'12px' }}>
                          {/* Risk Drivers */}
                          <div style={{ ...cardBase, border:'1px solid rgba(244,63,94,0.22)' }}>
                            <p style={{ ...cardTitle, color:'#f43f5e' }}>Risk Drivers</p>
                            {(engine?.riskDrivers?.length ? engine.riskDrivers : ['No active risk drivers detected.']).map((d, i) => (
                              <div key={i} style={{ display:'flex',gap:'7px',marginBottom:'5px',alignItems:'flex-start' }}>
                                <span style={{ color:'#f43f5e',flexShrink:0,fontSize:'11px',lineHeight:'16px' }}>!</span>
                                <p style={{ margin:0,fontSize:'11px',color:'#fda4af',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{d}</p>
                              </div>
                            ))}
                          </div>

                          {/* LP Control */}
                          {(() => {
                            const lpMode2 = deriveLpMode(result)
                            return (
                              <div style={{ ...cardBase, border:`1px solid ${lpMode2==='protocol'?'rgba(168,85,247,0.22)':'rgba(52,211,153,0.18)'}` }}>
                                <p style={{ ...cardTitle, color: lpMode2==='protocol'?'#a855f7':'#34d399' }}>LP Control</p>
                                <div style={{ display:'flex',alignItems:'center',gap:'8px',marginBottom:'8px',flexWrap:'wrap' }}>
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
                                {lpMode2==='protocol'
                                  ? <p style={{ margin:0,fontSize:'11px',color:'#c4b5fd',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>This token uses concentrated liquidity. No ERC-20 LP token exists, so traditional burn/lock proof does not apply.</p>
                                  : result.lpControl?.reason && <p style={{ margin:0,fontSize:'11px',color:'#94a3b8',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{result.lpControl.reason}</p>
                                }
                                {result.lpControl?.confidence && <p style={{ margin:'5px 0 0',fontSize:'10px',color:'#64748b',fontFamily:'var(--font-plex-mono)' }}>Confidence: {result.lpControl.confidence}</p>}
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

                          {/* Trading Simulation */}
                          <div style={{ ...cardBase, border:`1px solid ${simVerified?'rgba(45,212,191,0.25)':simUnavailable?'rgba(100,116,139,0.18)':'rgba(251,191,36,0.20)'}` }}>
                            <p style={{ ...cardTitle, color:'#67e8f9' }}>Trading Simulation</p>
                            <div style={{ display:'flex',gap:'6px',marginBottom:'10px',flexWrap:'wrap' }}>
                              <span style={{ padding:'3px 10px',borderRadius:'999px',fontSize:'9px',fontWeight:700,color:simVerified?'#34d399':simUnavailable?'#94a3b8':'#fbbf24',background:simVerified?'rgba(52,211,153,0.10)':simUnavailable?'rgba(148,163,184,0.08)':'rgba(251,191,36,0.10)',border:`1px solid ${simVerified?'rgba(52,211,153,0.30)':simUnavailable?'rgba(148,163,184,0.22)':'rgba(251,191,36,0.30)'}`,fontFamily:'var(--font-plex-mono)' }}>
                                {simVerified?'VERIFIED':simUnavailable?'UNVERIFIED':'PARTIAL'}
                              </span>
                              {sim?.isHoneypot === true && (
                                <span style={{ padding:'3px 10px',borderRadius:'999px',fontSize:'9px',fontWeight:700,color:'#f87171',background:'rgba(248,113,113,0.10)',border:'1px solid rgba(248,113,113,0.35)',fontFamily:'var(--font-plex-mono)' }}>HONEYPOT</span>
                              )}
                            </div>
                            <div style={{ display:'grid',gap:'6px' }}>
                              {([
                                ['Honeypot', sim?.isHoneypot==null?'Open check':sim.isHoneypot?'YES':'NO', sim?.isHoneypot?'#f87171':sim?.isHoneypot===false?'#34d399':'#94a3b8'],
                                ['Buy Tax', sim?.buyTax!=null?`${sim.buyTax.toFixed(1)}%`:'Open check', sim?.buyTax!=null?(sim.buyTax>8?'#f87171':sim.buyTax>0?'#fbbf24':'#34d399'):'#94a3b8'],
                                ['Sell Tax', sim?.sellTax!=null?`${sim.sellTax.toFixed(1)}%`:'Open check', sim?.sellTax!=null?(sim.sellTax>8?'#f87171':sim.sellTax>0?'#fbbf24':'#34d399'):'#94a3b8'],
                                ...(sim?.transferTax!=null&&sim.transferTax>0 ? [['Transfer Tax',`${sim.transferTax.toFixed(1)}%`,'#fbbf24'] as [string,string,string]] : []),
                              ] as Array<[string,string,string]>).map(([label,val,col])=>(
                                <div key={label} style={{ display:'flex',justifyContent:'space-between',gap:'8px' }}>
                                  <span style={{ fontSize:'11px',color:'#64748b',fontFamily:'var(--font-plex-mono)' }}>{label}</span>
                                  <span style={{ fontSize:'11px',fontWeight:700,color:col,fontFamily:'var(--font-plex-mono)' }}>{val}</span>
                                </div>
                              ))}
                            </div>
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
                const activeDevIntel = devIntel ?? result.devIntel ?? null
                const _safeActorAddr = (a: unknown): string | null => typeof a === 'string' && /^0x[a-f0-9]{40}$/i.test(a) && a.toLowerCase() !== '0x0000000000000000000000000000000000000000' ? a : null
                const creatorAddress = _safeActorAddr(activeDevIntel?.deployerAddress) ?? _safeActorAddr(result.security?.devOwnership?.ownerAddress) ?? _safeActorAddr(result.security?.devOwnership?.adminAddress) ?? null
                const creatorStatus = activeDevIntel?.deployerStatus === 'confirmed' ? 'confirmed' : activeDevIntel?.deployerStatus === 'possible_match' ? 'likely' : (creatorAddress ? (result.security?.devOwnership?.ownershipVerified ? 'confirmed' : 'likely') : null)
                const linkedWallets = activeDevIntel?.linkedWallets ?? []
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
                const clusterDominanceLabel = clusterDominance === 'unknown' ? 'Open check' : clusterDominance === 'none' ? 'No dominance' : `${clusterDominance.charAt(0).toUpperCase()}${clusterDominance.slice(1)} dominance`
                const clusterRiskAccent = clusterRiskLabel === 'critical' || clusterRiskLabel === 'high' ? '#f87171' : clusterRiskLabel === 'elevated' || clusterRiskLabel === 'watch' ? '#fbbf24' : clusterRiskLabel === 'open_check' ? '#94a3b8' : '#34d399'
                const clusterSignals = (clusterInfluence?.signals?.length ? clusterInfluence.signals : ([clusterInfluence?.reason].filter(Boolean) as string[])).slice(0, 3)
                const suspiciousTransferPattern = activeDevIntel?.suspiciousTransfers ?? false
                const missingChecks = getMissingChecks(result)
                const openChecks = [
                  ...(linkedWalletCount === 0 ? ['Linked wallet cluster still limited from available transfer evidence.'] : []),
                  ...(holderState.kind !== 'rowsWithPercent' ? ['Holder concentration data remains partial.'] : []),
                ]
                const score = Math.max(10, Math.min(98, Math.round((creatorStatus === 'confirmed' ? 32 : creatorStatus === 'likely' ? 24 : 14) + (linkedWalletCount > 0 ? 18 : 8) + (devClusterSupply != null ? Math.max(0, 25 - Math.round(devClusterSupply / 2)) : 10) + (suspiciousTransferPattern ? 4 : 14))))
                const riskLabel = score >= 76 ? 'LOW RISK' : score >= 56 ? 'WATCH' : score >= 35 ? 'HIGH RISK' : 'CRITICAL'
                const confidenceLabel = creatorStatus && holderState.kind === 'rowsWithPercent' ? 'HIGH' : creatorStatus || linkedWalletCount > 0 ? 'MEDIUM' : 'LOW'
                const next = getNextAction(result)
                const safeError = devIntelError ? 'Dev intelligence is temporarily unavailable. Retry the scan to refresh this module.' : null

                return (<>
                  <div style={{ marginBottom:'12px', padding:'18px', borderRadius:'14px', border:'1px solid rgba(125,211,252,0.22)', background:'linear-gradient(165deg, rgba(14,24,43,0.95), rgba(8,14,26,0.95))', boxShadow:'0 10px 28px rgba(5,10,25,0.45)' }}>
                    <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:'12px',marginBottom:'12px' }}>
                      <div>
                        <p style={{ margin:'0 0 6px',fontSize:'10px',letterSpacing:'.14em',color:'#7dd3fc',fontWeight:700,fontFamily:'var(--font-plex-mono)' }}>CORTEX Dev Control Read</p>
                        <p style={{ margin:0,fontSize:'12px',color:'#cbd5e1',fontFamily:'var(--font-plex-mono)' }}>Deployer identity, wallet cluster connections, and on-chain supply influence — CORTEX dev intelligence layer.</p>
                      </div>
                      <p style={{ margin:0,fontSize:'28px',fontWeight:800,color:'#f8fafc',fontFamily:'var(--font-plex-mono)' }}>{score}<span style={{ fontSize:'12px',color:'#64748b' }}>/100</span></p>
                    </div>
                    <div style={{ display:'flex',gap:'8px',flexWrap:'wrap',marginBottom:'10px' }}>
                      <span style={{ padding:'4px 9px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:riskLabel.includes('LOW') ? '#34d399' : riskLabel==='WATCH' ? '#fbbf24' : '#f87171',background:riskLabel.includes('LOW')?'rgba(52,211,153,.1)':riskLabel==='WATCH'?'rgba(251,191,36,.1)':'rgba(248,113,113,.1)',border:riskLabel.includes('LOW')?'1px solid rgba(52,211,153,.35)':riskLabel==='WATCH'?'1px solid rgba(251,191,36,.35)':'1px solid rgba(248,113,113,.35)',fontFamily:'var(--font-plex-mono)' }}>{riskLabel}</span>
                      <span style={{ padding:'4px 9px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:'#7dd3fc',border:'1px solid rgba(125,211,252,0.26)',fontFamily:'var(--font-plex-mono)' }}>CONFIDENCE {confidenceLabel}</span>
                    </div>
                    <div style={{ height:'8px',borderRadius:'999px',background:'rgba(15,23,42,0.9)',border:'1px solid rgba(255,255,255,0.08)',overflow:'hidden' }}><div style={{ width:`${score}%`,height:'100%',background:'linear-gradient(90deg, #2dd4bf, #7dd3fc)' }} /></div>
                  </div>
                  <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))',gap:'10px',marginBottom:'14px' }}>
                    {[
                      { k:'Deployer', v: creatorStatus === 'confirmed' ? 'Confirmed' : creatorStatus === 'likely' ? 'Likely matched' : 'Limited signal' },
                      { k:'Linked Wallets', v: `${linkedWalletCount} mapped` },
                      { k:'Supply Control', v: clusterSupplyPercent != null ? `${clusterSupplyPercent.toFixed(1)}% cluster` : 'Open check' },
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
                      const originChip = creatorStatus === 'confirmed' ? { label: 'Confirmed', color: '#34d399', bg: 'rgba(52,211,153,.12)', border: 'rgba(52,211,153,.3)' } : creatorStatus === 'likely' ? { label: 'Likely matched', color: '#fbbf24', bg: 'rgba(251,191,36,.1)', border: 'rgba(251,191,36,.3)' } : { label: 'Open check', color: '#94a3b8', bg: 'rgba(148,163,184,.08)', border: 'rgba(148,163,184,.25)' }
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
                                <span style={{ fontSize:'10px', color:'#3a5268', fontFamily:'var(--font-plex-mono)' }}>Pending confirmation</span>
                              )}
                              <span style={{ display:'inline-flex', alignSelf:'flex-start', padding:'2px 7px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:originChip.color, background:originChip.bg, border:`1px solid ${originChip.border}`, fontFamily:'var(--font-plex-mono)' }}>{originChip.label}</span>
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
                              <span style={{ fontSize:'13px', fontWeight:800, color: linkedWallets.length > 0 ? '#99f6e4' : '#475569', fontFamily:'var(--font-plex-mono)' }}>{linkedWallets.length > 0 ? linkedWallets.length : '—'}</span>
                              <span style={{ fontSize:'9px', color: linkedWallets.length > 0 ? '#2dd4bf80' : '#1e3a44', fontFamily:'var(--font-plex-mono)' }}>{linkedWallets.length > 0 ? `${linkedWallets.length} wallet${linkedWallets.length !== 1 ? 's' : ''} mapped` : 'Not confirmed yet'}</span>
                            </div>
                          </div>

                          {/* Origin Wallet detail card */}
                          <div style={{ padding:'14px 16px', borderRadius:'12px', background:'rgba(10,16,30,.7)', border:'1px solid rgba(251,191,36,.18)' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'10px', flexWrap:'wrap' }}>
                              <p style={{ margin:0, fontSize:'10px', letterSpacing:'.14em', fontWeight:700, color:'#fbbf24', fontFamily:'var(--font-plex-mono)' }}>{originLabel.toUpperCase()}</p>
                              <span style={{ padding:'2px 8px', borderRadius:'999px', fontSize:'9px', fontWeight:700, color:originChip.color, background:originChip.bg, border:`1px solid ${originChip.border}`, fontFamily:'var(--font-plex-mono)' }}>{originChip.label}</span>
                            </div>
                            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:'8px' }}>
                              {[
                                { label: 'Address', value: originAddr ? fmt(originAddr) : 'Not confirmed', title: originAddr ?? undefined },
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
                                Origin wallet has not been confirmed in this pass. CORTEX needs additional transfer evidence to resolve the deployer identity.
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
                                <p style={{ margin:'0 0 4px', fontSize:'11px', color:'#475569', fontFamily:'var(--font-plex-mono)', fontWeight:600 }}>No linked wallets confirmed in this pass</p>
                                <p style={{ margin:0, fontSize:'10px', color:'#2d3f50', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>CORTEX needs more transfer evidence to confirm wallet cluster connections.</p>
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
                            { label:'Creator in top holders', value: creatorInTop==null ? 'Open check' : creatorInTop ? 'Yes' : 'No', accent: creatorInTop==null ? '#64748b' : creatorInTop ? '#fbbf24' : '#34d399' },
                            { label:'Top 1 concentration',   value: top1!=null ? `${top1.toFixed(1)}%` : '—', accent: top1!=null && top1>20 ? '#f87171' : '#94a3b8' },
                            { label:'Top 10 concentration',  value: top10!=null ? `${top10.toFixed(1)}%` : '—', accent: top10!=null ? (top10>50?'#f87171':top10>30?'#fbbf24':'#34d399') : '#94a3b8' },
                            { label:'Top 20 concentration',  value: top20!=null ? `${top20.toFixed(1)}%` : '—', accent: top20!=null ? (top20>60?'#f87171':top20>40?'#fbbf24':'#34d399') : '#94a3b8' },
                            { label:'Linked-wallet supply',  value: linkedWalletSupply!=null ? `${linkedWalletSupply.toFixed(1)}%` : '—', accent:'#2dd4bf' },
                            { label:'Dev cluster supply',    value: devClusterSupply!=null ? `${devClusterSupply.toFixed(1)}%` : 'Pending', accent: devClusterSupply!=null ? (devClusterSupply>30?'#f87171':devClusterSupply>15?'#fbbf24':'#34d399') : '#64748b' },
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
                                {clusterSupplyPercent == null ? 'Open check' : `${clusterSupplyPercent.toFixed(1)}% cluster supply`}
                                {' · '}
                                {clusterSupplyPercent == null ? 'CORTEX needs more holder evidence before confirming cluster influence.' : clusterInfluence?.reason ?? clusterDominanceLabel}
                              </p>
                            </div>
                            <div style={{ textAlign:'right', flexShrink:0 }}>
                              <p style={{ margin:'0 0 4px', fontSize:'18px', fontWeight:800, color:clusterRiskAccent, fontFamily:'var(--font-plex-mono)' }}>{clusterRiskScore != null ? clusterRiskScore : '—'}<span style={{ fontSize:'10px', color:'#64748b' }}>/100</span></p>
                              <p style={{ margin:0, fontSize:'9px', letterSpacing:'.1em', color:clusterRiskAccent, fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>{clusterRiskScore != null ? `Risk score ${clusterRiskScore}/100` : 'Open check'}</p>
                            </div>
                          </div>
                          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:'8px', marginBottom:'10px' }}>
                            <div style={{ padding:'9px 11px', borderRadius:'10px', background:'rgba(15,23,42,.72)', border:'1px solid rgba(148,163,184,.12)' }}>
                              <p style={{ margin:'0 0 4px', fontSize:'8px', letterSpacing:'.1em', color:'#475569', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>Cluster supply</p>
                              <p style={{ margin:0, fontSize:'12px', color:clusterSupplyPercent == null ? '#94a3b8' : '#e2e8f0', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{clusterSupplyPercent == null ? 'Open check' : `${clusterSupplyPercent.toFixed(1)}% cluster supply`}</p>
                            </div>
                            <div style={{ padding:'9px 11px', borderRadius:'10px', background:'rgba(15,23,42,.72)', border:'1px solid rgba(148,163,184,.12)' }}>
                              <p style={{ margin:'0 0 4px', fontSize:'8px', letterSpacing:'.1em', color:'#475569', fontFamily:'var(--font-plex-mono)', textTransform:'uppercase' }}>Dominance</p>
                              <p style={{ margin:0, fontSize:'12px', color:clusterRiskAccent, fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{clusterDominanceLabel}</p>
                            </div>
                          </div>
                          <div style={{ display:'grid', gap:'5px' }}>
                            {(clusterSupplyPercent == null ? ['CORTEX needs more holder evidence before confirming cluster influence.'] : clusterSignals.length > 0 ? clusterSignals : ['No cluster supply found in indexed holders.']).slice(0, 3).map((signal, i) => (
                              <div key={i} style={{ display:'flex', gap:'8px', alignItems:'flex-start' }}>
                                <span style={{ color:clusterRiskAccent, flexShrink:0, fontSize:'10px', lineHeight:'16px' }}>›</span>
                                <p style={{ margin:0, fontSize:'10px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>{signal}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                        {devClusterSupply == null && (
                          <div style={{ padding:'11px 14px', borderRadius:'10px', background:'rgba(251,191,36,.04)', border:'1px solid rgba(251,191,36,.14)' }}>
                            <p style={{ margin:0, fontSize:'11px', color:'#78716c', fontFamily:'var(--font-plex-mono)', lineHeight:1.55 }}>Supply influence still needs confirmation. CORTEX needs more holder evidence before confirming cluster control.</p>
                          </div>
                        )}
                      </div>
                    )}
                    {devControlTab==='cluster-map' && <ClusterMapPanel clusterMap={clusterMap} devIntel={activeDevIntel} holderDistribution={activeDevIntel?.holderDistribution ?? result.holderDistribution ?? null} />}
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
                                  : 'Deployer identity is an open check — limited transfer evidence available.'}
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
                            {`Deployer ${creatorStatus === 'confirmed' ? 'confirmed' : creatorStatus === 'likely' ? 'likely matched' : 'open check'}. ${linkedWalletCount > 0 ? `${linkedWalletCount} linked wallet${linkedWalletCount !== 1 ? 's' : ''} mapped.` : 'No linked wallets confirmed.'} Dev cluster supply ${devClusterSupply != null ? `${devClusterSupply.toFixed(1)}% of circulating.` : 'pending confirmation.'}`}
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

        {/* ── Right: Clark verdict panel (288px) ─────────────────── */}
        <aside className="mob-verdict-panel" style={{
          width: 'clamp(320px, 24vw, 400px)',
          minWidth: 0,
          flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: 'linear-gradient(180deg, rgba(6,10,20,.96), rgba(4,8,18,.96))',
          overflowY: 'auto',
          padding: '28px 20px',
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
                background: clarkLoading ? '#2DD4BF' : clarkVerdict ? '#2DD4BF' : '#162230',
                boxShadow: (clarkLoading || clarkVerdict) ? '0 0 10px rgba(45,212,191,0.85)' : 'none',
                flexShrink: 0,
                transition: 'all 0.3s',
                ...((!clarkLoading && !clarkVerdict) ? {} : { animation: 'liveDotPulse 2.2s ease-in-out infinite' }),
              }} />
              <p style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
                color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
                textTransform: 'uppercase', margin: 0,
              }}>
                Clark AI Verdict
              </p>
            </div>
            {(!clarkLoading && !clarkVerdict && !clarkError) && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '99px', background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.20)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: 'rgba(45,212,191,0.75)', fontFamily: 'var(--font-plex-mono)' }}>
                <span className="live-dot" style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#34d399', boxShadow: '0 0 5px #34d399', flexShrink: 0 }} />
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

          {/* Idle — premium placeholder */}
          {!planLoading && isFullAccess && !clarkLoading && !clarkVerdict && !clarkError && (
            <div>
              <p style={{ margin: '0 0 18px', fontSize: '11px', color: '#253340', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.65 }}>
                Scan a token to generate a structured CORTEX verdict.
              </p>
              {[
                { label: 'Verdict',              dot: '#94a3b8', w1: '55%', w2: '35%' },
                { label: 'Market Read',          dot: '#2DD4BF', w1: '80%', w2: '60%' },
                { label: 'Holder / Supply Read', dot: '#a78bfa', w1: '70%', w2: '45%' },
                { label: 'LP / Risk Read',       dot: '#34d399', w1: '65%', w2: '50%' },
                { label: 'Dev Control',          dot: '#fbbf24', w1: '75%', w2: '40%' },
                { label: 'Next Action',          dot: '#f87171', w1: '60%', w2: '55%' },
              ].map((sec, idx) => (
                <div key={sec.label} className={idx > 0 ? 'clark-section' : ''} style={{ marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '7px' }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: sec.dot, flexShrink: 0, opacity: 0.55 }} />
                    <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#253340', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{sec.label}</span>
                  </div>
                  <div className="shimmer-line" style={{ height: '5px', width: sec.w1, marginBottom: '5px' }} />
                  <div className="shimmer-line" style={{ height: '5px', width: sec.w2 }} />
                </div>
              ))}
            </div>
          )}

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
            const buyTax = hp?.buyTax ?? null
            const sellTax = hp?.sellTax ?? null
            const liq = result.liquidity ?? 0
            const poolCount = result.pools?.length ?? 0
            const top10 = result.holderDistribution?.top10
            const top20 = result.holderDistribution?.top20
            const taxesHigh = (buyTax != null && buyTax > 8) || (sellTax != null && sellTax > 8)
            const scx = calculateCortexScoreV2(result)
            const verdict = result.cortexVerdict ?? scx.cortexVerdict
            const verdictColor = verdict === 'High Risk' ? '#f87171' : verdict === 'Strong' ? '#2DD4BF' : verdict === 'Watch' ? '#fbbf24' : verdict === 'Caution' ? '#f59e0b' : '#94a3b8'
            const bull = [
              liq > 1_000_000 ? `Deep liquidity — ${fmtLarge(liq)} pool depth.` : liq > 200_000 ? `Moderate liquidity — ${fmtLarge(liq)} pool depth.` : liq > 0 ? 'Liquidity present.' : '',
              d.hasMarketData ? 'Live market data confirmed.' : '',
              hp?.isHoneypot === false && hp?.simulationSuccess ? 'No honeypot — sell simulation passed.' : '',
              poolCount > 1 ? `${poolCount} active pools detected.` : poolCount === 1 ? 'Primary pool active.' : '',
              d.holderState.kind !== 'noRowsFallback' ? 'Holder distribution data is available.' : '',
            ].filter(Boolean).slice(0, 3)
            const bear = [
              d.holderState.kind === 'noRowsFallback' ? 'Holder concentration not confirmed — treat as incomplete risk check.' : '',
              taxesHigh ? `Elevated taxes — buy ${buyTax?.toFixed(1)}% / sell ${sellTax?.toFixed(1)}%.` : '',
              liq > 0 && liq < 50000 ? `Thin liquidity — ${fmtLarge(liq)}, high slippage risk.` : '',
              result.marketCapUsd == null ? 'Market cap not verified — supply unconfirmed.' : '',
              hp?.simulationSuccess === false ? 'Security simulation did not complete.' : '',
            ].filter(Boolean).slice(0, 3)
            const missingChecks = [
              result.noActivePools ? 'Active pool' : '',
              d.holderState.kind !== 'rowsWithPercent' ? 'Holder concentration' : '',
              'Supply spread', 'LP lock',
              d.fallbackEvidence.ownerStatus === 'Open check' ? 'Owner status' : '',
              result.marketCapUsd == null ? 'Market cap' : '',
            ].filter(Boolean)
            // Score from data-driven engine
            const sidebarScore = result.cortexScore ?? scx.cortexScore
            const sidebarScoreColor = sidebarScore == null ? '#94a3b8' : sidebarScore >= 85 ? '#34d399' : sidebarScore >= 70 ? '#fbbf24' : sidebarScore >= 50 ? '#f59e0b' : '#f87171'
            // Critical risks (top 3 actionable)
            const criticalRisks: string[] = [
              hp?.isHoneypot === true ? 'HONEYPOT detected — do not trade.' : null,
              taxesHigh ? `High taxes — buy ${buyTax?.toFixed(1)}% / sell ${sellTax?.toFixed(1)}%.` : null,
              result.noActivePools ? 'No active liquidity pool found.' : null,
              liq > 0 && liq < 10000 ? `Very thin liquidity — ${fmtLarge(liq)}.` : liq > 0 && liq < 50000 ? `Thin liquidity — ${fmtLarge(liq)}.` : null,
              d.holderState.kind === 'noRowsFallback' ? 'Holder concentration not confirmed.' : null,
              !hp?.simulationSuccess ? 'Tax simulation unavailable.' : null,
            ].filter((x):x is string=>x!=null).slice(0,3)
            const ss = {padding:'10px 12px',border:'1px solid rgba(255,255,255,0.07)',borderRadius:'10px',background:'rgba(8,14,28,.65)'}
            const stitle = {margin:'0 0 6px',fontSize:'9px',fontWeight:700 as const,letterSpacing:'.16em',color:'#3a5268',textTransform:'uppercase' as const,fontFamily:'var(--font-plex-mono)'}
            const sbody = {margin:0,fontSize:'11px',color:'#94a3b8',lineHeight:1.65 as const,fontFamily:'var(--font-plex-mono)'}
            return (
              <div style={{display:'flex',flexDirection:'column',gap:'9px'}}>
                {/* CORTEX Receipt header */}
                <div style={{padding:'16px',border:`1px solid ${verdictColor}30`,borderRadius:'14px',background:'linear-gradient(135deg,rgba(8,20,38,.92),rgba(14,12,38,.90))',boxShadow:`0 0 28px ${verdictColor}0e`}}>
                  <div style={{fontSize:'9px',letterSpacing:'.16em',color:'#3a5268',fontFamily:'var(--font-plex-mono)',marginBottom:'10px'}}>CORTEX RECEIPT</div>
                  <div style={{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap'}}>
                    <div style={{flexShrink:0}}>
                      <div style={{fontSize:'9px',color:'#3a5268',fontFamily:'var(--font-plex-mono)',marginBottom:'2px'}}>SCORE</div>
                      <div style={{fontSize:'28px',fontWeight:800,color:sidebarScoreColor,fontFamily:'var(--font-plex-mono)',lineHeight:1}}>{sidebarScore ?? 'Open Check'}{sidebarScore != null && <span style={{fontSize:'12px',color:`${sidebarScoreColor}55`}}>/100</span>}</div>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{display:'inline-flex',padding:'5px 14px',borderRadius:'999px',border:`1px solid ${verdictColor}55`,color:verdictColor,fontWeight:800,fontSize:'11px',letterSpacing:'.10em',background:`${verdictColor}12`,fontFamily:'var(--font-plex-mono)',marginBottom:'6px'}}>{verdict}</div>
                      <div style={{height:'4px',borderRadius:'999px',background:'rgba(255,255,255,0.06)',overflow:'hidden'}}>
                        <div style={{height:'100%',width:`${sidebarScore ?? 0}%`,borderRadius:'999px',background:`linear-gradient(90deg,${sidebarScoreColor},${sidebarScoreColor}70)`,transition:'width 0.6s ease'}} />
                      </div>
                    </div>
                  </div>
                </div>
                {/* Top 3 Risks */}
                {criticalRisks.length > 0 && (
                  <div style={{padding:'10px 12px',border:'1px solid rgba(248,113,113,0.22)',borderRadius:'10px',background:'rgba(248,113,113,0.04)'}}>
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
                  <p style={sbody}>{getHolderRead(result)}</p>
                </div>
                {/* Next Action */}
                <div style={{padding:'11px 14px',border:'1px solid rgba(45,212,191,.32)',borderRadius:'12px',background:'rgba(45,212,191,.05)'}}>
                  <p style={{...stitle,color:'#2DD4BF',marginBottom:'5px'}}>Next Action</p>
                  <p style={{...sbody,color:'#67e8f9'}}>{getNextAction(result)}</p>
                </div>
              </div>
            )
          })()}
        </aside>

      </div>
    </>
  )
}

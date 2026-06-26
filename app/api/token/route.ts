/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetchHoneypotSecurity } from "@/lib/server/honeypotSecurity";
import { calculateTokenRiskScore } from "@/lib/server/riskScore";
import { sanitizePublicTokenResponse } from "@/lib/server/tokenPublicResponse";
import { buildLpControllerIntel, resolveLpControllerIdentity } from "@/lib/server/lpControllerIntel";
import { buildLpMovementWatch } from "@/lib/server/lpMovementWatch";
import { buildLpLockBurnIntel, LP_LOCK_BURN_REGISTRY } from "@/lib/server/lpLockBurnIntel";
import { buildLpUnlockTimeline } from "@/lib/server/lpUnlockTimeline";
import { buildLpHistoryTimeline } from "@/lib/server/lpHistoryTimeline";
import { buildSecondaryLpExposure } from "@/lib/server/secondaryLpExposure";
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { type CanonicalStatus, toCanonical } from '@/lib/canonicalStatus'
import { buildClusterMap } from '@/lib/clusterMap'
import {
  resolveLpProof,
  buildEvidenceGaps as buildLpEvidenceGaps,
  deriveDataModeAndConfidence as deriveLpDataModeAndConfidence,
  publicLpDataMode,
  buildCortexLpRead as buildSharedCortexLpRead,
  classifyPoolModel,
  classifyPoolByRpc,
  computeLpExitRisk,
  attemptConcentratedPositionProof,
  buildConcentratedPositionProofRead,
  buildCanonicalPoolIdentity,
  reconcileCanonicalPoolIdentity,
  type ProofApplicability,
  type ConcentratedPositionProof,
  type CanonicalPoolIdentity,
} from '@/lib/server/lpProof'
import {
  computeDisplayLpModel,
  reconcileSecondaryLpSignal,
  type LpPoolCandidate,
} from '@/lib/server/lpIntelligence'
import { calculateCortexScoreV2 } from '@/lib/token/scoring'
import { getRadarValuationBasis, resolveBaseRadarMarketCap } from '@/lib/baseRadarValuation'

// Local LP model/migration proof helper — pure function derived from GeckoTerminal pool data,
// delegating to the shared classifyPoolModel() so Token Scanner and Liquidity Safety agree
// on Aerodrome V2 vs Aerodrome Slipstream (concentrated) classification.
// Derives lpModelProof from the CANONICAL primary pool's dex id — the same pool
// (lpPool/lpDexId) that drives lpControl, so lpModelProof.model and
// lpControl.poolType / lpProofApplicability never describe different pools.
function _deriveLpModelProof(dexId: string | null): {
  model: 'constant_product' | 'concentrated' | 'stableswap' | 'unknown'
  dexName: string | null
  standardLockApplies: boolean
} {
  const cls = classifyPoolModel(dexId)
  const model: 'constant_product' | 'concentrated' | 'stableswap' | 'unknown' =
    cls.poolModel === 'aerodrome_v2' ? 'constant_product' : cls.poolModel
  return { model, dexName: dexId, standardLockApplies: cls.standardLockApplies }
}

function _deriveMigrationProof(pools: Array<{ attributes: { reserve_in_usd?: string | number | null }; relationships?: { dex?: { data?: { id: string } } } }>, totalLiq: number | null, primaryPoolSelected: boolean, canonicalPrimaryDex?: string | null, selectedPoolCreatedAt?: string | null): {
  status: 'low' | 'watch' | 'flagged' | 'unknown'
  confidence: 'high' | 'medium' | 'low' | 'unverified'
  reason: string
  dexsUsed: string[]
  primaryDex: string | null
  liquidityDistribution: string
  signals: string[]
  missingEvidence: string[]
  nextAction: string
} {
  const dexsUsed = Array.from(new Set(pools.map((p) => p.relationships?.dex?.data?.id).filter((d): d is string => !!d)))
  // Prefer the canonical primary pool's DEX (the one already selected by the LP control
  // pipeline) over the raw first pool — they can disagree when the LP-verification pool
  // isn't the first pool returned by the pools endpoint.
  const primaryDex = canonicalPrimaryDex ?? pools[0]?.relationships?.dex?.data?.id ?? null
  const toN = (v: string | number | null | undefined): number | null => { if (v == null) return null; const n = typeof v === 'number' ? v : parseFloat(v as string); return isNaN(n) ? null : n }
  const liquidities = pools.map((p) => toN(p.attributes.reserve_in_usd) ?? 0)
  const topShare = totalLiq && totalLiq > 0 ? (liquidities[0] ?? 0) / totalLiq : null
  const signals: string[] = []
  let status: 'low' | 'watch' | 'flagged' | 'unknown' = 'unknown'
  let confidence: 'high' | 'medium' | 'low' | 'unverified' = 'unverified'
  let reason = 'Not enough pool data to assess migration risk.'
  let liquidityDistribution = 'unknown'
  // A "meaningful primary pool" exists when the top pool holds a real, non-trivial share of
  // observed liquidity. Many ecosystem pools across several DEXs is NORMAL for established
  // tokens and is not, on its own, evidence of migration.
  const hasMeaningfulPrimary = (liquidities[0] ?? 0) > 0 && topShare != null && topShare >= 0.2
  // A primary/verification pool was actually selected by the LP pipeline (e.g. VIRTUAL: many
  // ecosystem pools, but a clear primary pool was chosen and deep liquidity confirmed) — never
  // say "no clear primary pool" in that case, even if its share of TOTAL liquidity is < 20%.
  const hasSelectedPrimary = hasMeaningfulPrimary || primaryPoolSelected
  if (pools.length > 0 && topShare != null) {
    liquidityDistribution = topShare >= 0.7 ? 'concentrated in primary pool' : topShare >= 0.4 ? 'moderately distributed' : 'spread thinly across pools'
    if (dexsUsed.length > 1) signals.push(`Liquidity is split across ${dexsUsed.length} different DEXs.`)
    if (pools.length > 1 && topShare < 0.4) signals.push('No single pool holds a clear majority of liquidity.')
    if (pools.length === 1) signals.push('All observed liquidity sits in a single pool.')
    // Migration "watch"/"high" requires stronger evidence (recent liquidity movement, a primary-pool
    // liquidity drop, or a new pool gaining dominance). Historical movement is not available here, so
    // pool count / DEX spread alone never escalates to a migration warning — it is recorded as a gap.
    if (dexsUsed.length === 1 && topShare >= 0.7) { status = 'low'; confidence = 'medium'; reason = 'Liquidity is concentrated in a single DEX and primary pool — no migration signal observed.' }
    else if (hasSelectedPrimary) { status = 'low'; confidence = 'low'; reason = 'Liquidity is distributed across multiple pools. A primary pool is present, so pool count alone is not enough evidence of migration risk. Historical liquidity movement is unavailable.' }
    else { status = 'unknown'; confidence = 'unverified'; reason = 'Liquidity is spread across multiple pools with no clear primary pool. Historical liquidity movement is unavailable, so migration risk cannot be confirmed from current evidence.' }
  }
  const missingEvidence: string[] = []
  if (!selectedPoolCreatedAt) missingEvidence.push('pool_creation_date_unavailable')
  missingEvidence.push('historical_liquidity_movement_unavailable')
  return { status, confidence, reason, dexsUsed, primaryDex, liquidityDistribution, signals, missingEvidence, nextAction: 'Confirm pool creation dates and historical liquidity moves on a block explorer before drawing migration conclusions.' }
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

type ChainKey = "eth" | "base" | "polygon" | "bnb";
function getAlchemyRpcUrl(chain: ChainKey): string | null {
  if (chain === "eth") {
    const explicitEth = process.env.ETH_RPC_URL
    if (explicitEth && /^https?:\/\//.test(explicitEth)) return explicitEth
    const key = process.env.ALCHEMY_ETHEREUM_KEY
    if (key) return `https://eth-mainnet.g.alchemy.com/v2/${key}`
  }
  if (chain === "base") {
    const explicitBase = process.env.BASE_RPC_URL
    if (explicitBase && /^https?:\/\//.test(explicitBase)) return explicitBase
    const explicit = process.env.ALCHEMY_BASE_RPC_URL
    if (explicit && /^https?:\/\//.test(explicit)) return explicit
    const key = process.env.ALCHEMY_BASE_KEY
    if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
    return "https://mainnet.base.org"
  }
  const keyMap: Record<Exclude<ChainKey, "base" | "eth">, string | undefined> = {
    polygon: process.env.ALCHEMY_POLYGON_KEY,
    bnb: process.env.ALCHEMY_BNB_KEY,
  }
  const domainMap: Record<Exclude<ChainKey, "base" | "eth">, string> = {
    polygon: "polygon-mainnet",
    bnb: "bnb-mainnet",
  }
  const key = keyMap[chain as Exclude<ChainKey, "base" | "eth">]
  return key ? `https://${domainMap[chain as Exclude<ChainKey, "base" | "eth">]}.g.alchemy.com/v2/${key}` : null
}

const COVALENT_BASE_URL = 'https://api.covalenthq.com/v1'
const CREATOR_LOOKUP_BASE_URL = 'https://api.etherscan.io/v2/api'
const COVALENT_CHAIN_SLUG: Record<Extract<ChainKey, 'eth' | 'base'>, string> = {
  eth: 'eth-mainnet',
  base: 'base-mainnet',
}
const CREATOR_LOOKUP_CHAIN_ID: Record<Extract<ChainKey, 'eth' | 'base'>, string> = {
  eth: '1',
  base: '8453',
}


const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'
const COMMON_INFRA_EXCLUSIONS = new Set([
  ZERO_ADDRESS,
  DEAD_ADDRESS,
  '0x0000000000000000000000000000000000000001',
])
const BASE_INFRA_EXCLUSIONS = new Set([
  '0x4200000000000000000000000000000000000006',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
  '0x2626664c2603336e57b271c5c0b26f421741e481',
  '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
  '0x420dd381b31aef6683db6b902084cb0ffece40da',
])
const ETH_INFRA_EXCLUSIONS = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  '0xe592427a0aece92de3edee1f18e0157c05861564',
  '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
  '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  '0x000000000022d473030f116ddee9f6b43ac78ba3',
])

function chainInfraExclusions(chain: ChainKey): Set<string> {
  return new Set([
    ...COMMON_INFRA_EXCLUSIONS,
    ...(chain === 'eth' ? ETH_INFRA_EXCLUSIONS : BASE_INFRA_EXCLUSIONS),
  ])
}

function normalizeEvidenceAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null
}

function isRejectedEvidenceAddress(value: string | null | undefined, tokenContract?: string | null): boolean {
  const normalized = normalizeEvidenceAddress(value)
  if (!normalized) return true
  const tokenLow = normalizeEvidenceAddress(tokenContract ?? null)
  return normalized === tokenLow || COMMON_INFRA_EXCLUSIONS.has(normalized) || ETH_INFRA_EXCLUSIONS.has(normalized) || BASE_INFRA_EXCLUSIONS.has(normalized)
}

function isValidOriginCandidate(value: string | null | undefined, tokenContract: string): value is string {
  return !isRejectedEvidenceAddress(value, tokenContract)
}


interface AlchemyTransfer {
  blockNum: string
  hash: string
  from: string
  to: string | null
  value: number | null
  asset: string | null
  category: string
  metadata?: { blockTimestamp?: string }
  rawContract?: { address?: string | null; value?: string | null; decimal?: string | null }
}

interface LinkedWallet {
  address: string
  amountReceived: number | null
  asset: string | null
  txHash: string | null
  firstSeen: string | null
  confidence?: 'high' | 'medium' | 'low'
  reason?: string
  overlapTopHolderRank?: number | null
  overlapTopHolderPercent?: number | null
}

interface LinkedWalletDiag {
  attempted: boolean
  ok: boolean
  tokenTransfersFound: number
  ethTransfersFound: number
  totalCandidates: number
  reason: string
}

type TokenOriginCandidate = {
  address: string | null
  confidence: 'high' | 'medium' | 'low'
  deployerStatus: 'confirmed' | 'possible_match' | 'not_confirmed'
  methodUsed: string
  creationTxHash: string | null
  reason: string
}

type TokenOriginDiscoveryDiag = {
  optional_creation_lookup: {
    attempted: boolean
    ok: boolean
    reason: string
    httpStatus?: number | null
    candidateAddress?: string | null
    txHashPresent?: boolean
    confidence?: 'high' | 'medium' | 'low'
  }
  contract_transaction_history: {
    attempted: boolean
    ok: boolean
    reason: string
    httpStatus?: number | null
    itemCount?: number
    candidateAddress?: string | null
    txHashPresent?: boolean
    confidence?: 'high' | 'medium' | 'low'
  }
  initial_token_flow_signal: {
    attempted: boolean
    ok: boolean
    reason: string
    tokenTransfersFound?: number
    candidateAddress?: string | null
    confidence?: 'high' | 'medium' | 'low'
  }
  rpc_fallback: {
    attempted: boolean
    ok: boolean
    reason: string
    candidateAddress?: string | null
    confidence?: 'high' | 'medium' | 'low'
  }
  selected_origin_candidate: {
    methodUsed: string
    address: string | null
    confidence: 'high' | 'medium' | 'low'
    deployerStatus: 'confirmed' | 'possible_match' | 'not_confirmed'
  }
}

type CovalentTxItem = {
  successful?: boolean
  from_address?: string | null
  to_address?: string | null
  tx_hash?: string | null
}

async function checkRpcHealth(chain: ChainKey): Promise<{ ok: boolean; providerUrl: string | null; reason: string | null }> {
  const providerUrl = getAlchemyRpcUrl(chain)
  if (!providerUrl) return { ok: false, providerUrl: null, reason: "missing_rpc_url" }
  try {
    const res = await fetch(providerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { ok: false, providerUrl, reason: `http_${res.status}` }
    const json = await res.json()
    return typeof json?.result === "string"
      ? { ok: true, providerUrl, reason: null }
      : { ok: false, providerUrl, reason: "invalid_blocknumber_response" }
  } catch {
    return { ok: false, providerUrl, reason: "rpc_health_timeout_or_network_error" }
  }
}

const TOKEN_CACHE_TTL_MS = 3 * 60 * 1000
const TOKEN_RATE_WINDOW_MS = 60 * 1000
const TOKEN_RATE_BY_PLAN: Record<string, number> = { free: 12, pro: 40, elite: 120 }
// Token scanner caching intentionally disabled for full provider-run scans.
const tokenRateMap = new Map<string, { count: number; resetAt: number }>()
const BASE_TOKEN_ALIAS_MAP: Record<string, { address: string; symbol: string }> = {
  WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
  ETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC' },
  USDBC: { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC' },
  AERO: { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO' },
  BRETT: { address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT' },
  VIRTUAL: { address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', symbol: 'VIRTUAL' },
  DEGEN: { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN' },
  TOSHI: { address: '0xAC1bd2486aAf3B5C0B7b8f6e7DfeF5C0a05D0D89', symbol: 'TOSHI' },
  MORPHO: { address: '0xBAa5BDeA6D371052a6BDeB0eD79B147C43aABF84', symbol: 'MORPHO' },
  CBBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC' },
  CBETH: { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', symbol: 'cbETH' },
}

function getClientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}
async function getPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}
async function checkRate(req: Request): Promise<boolean> {
  const ip = getClientIp(req)
  const plan = await getPlan(req)
  const key = `${plan}:${ip}`
  const now = Date.now()
  const cur = tokenRateMap.get(key)
  const limit = TOKEN_RATE_BY_PLAN[plan]
  if (!cur || cur.resetAt <= now) { tokenRateMap.set(key, { count: 1, resetAt: now + TOKEN_RATE_WINDOW_MS }); return true }
  if (cur.count >= limit) return false
  cur.count += 1
  return true
}

type HolderDistribution = {
  top1: number | null
  top5: number | null
  top10: number | null
  top20: number | null
  others: number | null
  holderCount: number | null
  topHolders: Array<{ rank: number; address: string; amount: string | number | null; percent: number | null }>
}
type HolderDistributionStatus = {
  status: "ok" | "partial" | "unavailable_with_reason" | "inferred" | "error"
  reason: string
  itemCount: number
  normalizedCount: number
  percentSource: "provider" | "calculated" | "reconstructed" | "inferred"
}

type EvidenceConfidence = "high" | "medium" | "low"
type NormalizedTransfer = {
  txHash: string
  blockNumber: number | null
  timestamp: number | null
  from: string
  to: string
  amountRaw: string | null
  amountFormatted?: number | null
  tokenAddress: string
  isBuy?: boolean
  isSell?: boolean
  source?: string
  confidence?: EvidenceConfidence
}
type TransferResolverResult = {
  transfers: NormalizedTransfer[]
  insufficientEvidence: boolean
  sourceTrail: string[]
  reason?: string
  fallbackUsed?: string
  confidence: EvidenceConfidence
}
type NormalizedHolderRow = {
  address: string
  balanceRaw: string | null
  balanceFormatted?: number | null
  pctOfSupply?: number | null
  isContract?: boolean
  source?: string
  confidence?: EvidenceConfidence
}
type HolderResolverResult = {
  holders: NormalizedHolderRow[]
  insufficientEvidence: boolean
  sourceTrail: string[]
  reason?: string
  fallbackUsed?: string
  confidence: EvidenceConfidence
}

function buildInsufficientEvidenceBlock(reason: string, fallbackUsed?: string) {
  return {
    insufficientEvidence: true,
    reason,
    fallbackUsed: fallbackUsed ?? "none",
    confidence: "low" as const,
  }
}

type ClusterInfluence = {
  clusterSupplyPercent: number | null
  clusterDominance: "none" | "low" | "medium" | "high" | "critical" | "unknown"
  clusterRiskScore: number | null
  clusterRiskLabel: "low" | "watch" | "elevated" | "high" | "critical" | "open_check"
  reason: string
  signals: string[]
}

type SupplyControl = {
  creatorInTopHolders: boolean | null
  creatorHolderRank: number | null
  creatorHolderPercent: number | null
  linkedWalletSupplyPercent: number | null
  linkedWalletSupplyStatus: CanonicalStatus
  devClusterSupplyPercent: number | null
  devClusterSupplyStatus: CanonicalStatus
  devClusterSupplyReason: string
  matchedLinkedWallets: Array<{
    address: string
    percent: number | null
    rank: number | null
    confidence: string
  }>
  clusterInfluence: ClusterInfluence
  insufficientEvidence?: boolean
  reason?: string
  fallbackUsed?: string
  confidence?: EvidenceConfidence
}
type RiskEngine = {
  rugRiskScore: number | null
  rugRiskLabel: "low_visible_risk" | "watch" | "high" | "critical" | "partial_data"
  confidence: "high" | "medium" | "low"
  cortexRead: string
  verifiedSignals: string[]
  riskDrivers: string[]
  openChecks: string[]
  dataFillScore: number
  lpRisk: {
    status: "not_applicable" | "verified" | "partial" | "inferred"
    confidence: "high" | "medium" | "low"
  }
  sniperActivity: {
    status: "low_signal" | "watch" | "high" | "not_applicable"
    confidence: "high" | "medium" | "low"
    reasons: string[]
  }
  trendIntelligence: {
    stage: "launch" | "accumulation" | "ignition" | "peak" | "distribution" | "decay" | "dormant" | "inferred"
    confidence: "high" | "medium" | "low"
    volatility: "extreme" | "high" | "moderate" | "low" | "inferred"
    liquidityDecay: "stable" | "declining" | "critical" | "inferred"
    note: string
  }
  smartMoney: {
    signal: "accumulation" | "distribution" | "neutral" | "inferred"
    confidence: "high" | "medium" | "low"
    rotation: "inflow" | "outflow" | "neutral" | "inferred"
    conviction: "high" | "moderate" | "low" | "inferred"
    clusterBehavior: "coordinated" | "dispersed" | "inferred"
    note: string
  }
  deployerProfile: {
    status: "verified" | "inferred" | "partial" | "not_applicable"
    deployer: string | null
    method: string
    rugHistory: number | null
    clusterRisk: "clean" | "flagged" | "inferred"
    deployPattern: "eoa" | "factory" | "proxy" | "inferred"
    note: string
  }
  holderIntelligence: {
    status: "verified" | "inferred" | "partial" | "not_applicable"
    concentration: "high" | "moderate" | "low" | "inferred"
    churn: "high" | "moderate" | "low" | "inferred"
    velocity: "accumulating" | "distributing" | "stable" | "inferred"
    earlyBuyerConcentration: "high" | "moderate" | "low" | "inferred"
    whaleConcentration: "high" | "moderate" | "low" | "inferred"
    note: string
  }
  lpIntelligence: {
    status: "verified" | "inferred" | "partial" | "not_applicable"
    lockTime: string | null
    lockTimeSeconds: number | null
    migrationRisk: "low" | "medium" | "high" | "inferred"
    mintAuthority: "active" | "renounced" | "not_applicable" | "inferred"
    depth: "deep" | "moderate" | "shallow" | "none" | "inferred"
    volatility: "high" | "moderate" | "low" | "inferred"
    liquidityDecay: "stable" | "declining" | "critical" | "inferred"
    poolType: string
    note: string
  }
  clarkInterpretation: {
    summary: string
    riskDrivers: string[]
    openChecks: string[]
    nextActions: string[]
    chainContext: string
    confidence: "high" | "medium" | "low"
  }
}

type RugRiskReport = {
  lp_safety: {
    status: "locked" | "unlocked" | "team_controlled" | "protocol" | "concentrated_liquidity" | "partial" | "open_check"
    unlock_at: string | null
    countdown_seconds: number | null
    owner: string | null
    contract: string | null
    movement_24h_usd: number | null
    source_status: "ok" | "partial"
    /** Set only for "open_check" — explains that liquidity exists but the LP control path is unverified. */
    note?: string | null
    /** "unknown" when the LP controller has not been proven (open_check/concentrated/protocol). */
    controller?: string | null
  }
  contract_flags: {
    honeypot: boolean | null
    blacklist: boolean | null
    mint: boolean | null
    upgradeable: boolean | null
    source_status: "ok" | "partial"
  }
  deployer_reputation: {
    score: number | null
    rug_history: number | null
    deploy_patterns: string[]
    source_status: "ok" | "partial"
  }
  sniper_activity: { level: "low" | "medium" | "high"; score: number; source_status: "ok" | "partial" }
  early_buyers: Array<{ wallet: string; amount_usd: number | null; tx_count: number | null }>
  liquidity_risk: { liquidity_usd: number | null; volatility_24h_pct: number | null; source_status: "ok" | "partial" }
  trading_simulation: { success: boolean | null; buy_tax: number | null; sell_tax: number | null; source_status: "ok" | "partial" }
  risk_drivers: string[]
  overall_rug_risk_score: number | null
}

function toNum(v: unknown): number | null {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function pickNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = toNum(v)
    if (n != null) return n
  }
  return null
}

function normalizeHolderPercent(v: unknown): number | null {
  const n = toNum(v)
  if (n == null || n < 0 || n > 100) return null
  if (n > 0 && n <= 1) return n * 100
  return n
}

type HolderSanityResult = {
  sane: boolean
  failedReason: string | null
  top1: number | null
  top5: number | null
  top10: number | null
  top20: number | null
}

function holderPercentTotals(rows: Array<{ percent?: number | null }>): Pick<HolderSanityResult, 'top1' | 'top5' | 'top10' | 'top20'> {
  const sum = (n: number) => rows.slice(0, n).reduce((acc, row) => acc + (typeof row.percent === 'number' && Number.isFinite(row.percent) ? row.percent : 0), 0)
  return {
    top1: rows.length > 0 ? sum(1) : null,
    top5: rows.length > 0 ? sum(5) : null,
    top10: rows.length > 0 ? sum(10) : null,
    top20: rows.length > 0 ? sum(20) : null,
  }
}

function validateHolderPercentSanity(rows: Array<{ percent?: number | null }>): HolderSanityResult {
  const percentRows = rows.filter((row) => typeof row.percent === 'number' && Number.isFinite(row.percent))
  const totals = holderPercentTotals(rows)
  const epsilon = 0.0001
  if (percentRows.length === 0) return { sane: true, failedReason: null, ...totals }
  if (percentRows.some((row) => (row.percent ?? 0) < 0 || (row.percent ?? 0) > 100 + epsilon)) {
    return { sane: false, failedReason: 'holder_percent_over_100', ...totals }
  }
  if ((totals.top5 ?? 0) > 100 + epsilon) return { sane: false, failedReason: 'top5_over_100', ...totals }
  if ((totals.top10 ?? 0) > 100 + epsilon) return { sane: false, failedReason: 'top10_over_100', ...totals }
  if ((totals.top20 ?? 0) > 100 + epsilon) return { sane: false, failedReason: 'top20_over_100', ...totals }
  const nearWholeSupplyRows = percentRows.filter((row) => (row.percent ?? 0) >= 99).length
  if (nearWholeSupplyRows > 1) return { sane: false, failedReason: 'duplicate_near_100_percent_rows', ...totals }
  const hugeRows = percentRows.filter((row) => (row.percent ?? 0) >= 50).length
  if (hugeRows > 2) return { sane: false, failedReason: 'multiple_huge_holder_percentages', ...totals }
  return { sane: true, failedReason: null, ...totals }
}

function clearHolderPercentages(rows: Array<{ percent?: number | null }>) {
  for (const row of rows) row.percent = null
}

function deriveHolderPercentagesFromSupply(rows: Array<{ address: string; percent: number | null }>, rawBalanceByAddress: Map<string, unknown>, totalSupplyBig: bigint): number {
  let derivedCount = 0
  if (totalSupplyBig <= BigInt(0)) return derivedCount
  for (const holder of rows) {
    const rawBal = rawBalanceByAddress.get(holder.address.toLowerCase())
    if (rawBal == null) continue
    const rawStr = String(rawBal)
    if (rawStr === '' || rawStr.includes('.') || /[eE]/.test(rawStr)) continue
    try {
      const balBig = BigInt(rawStr)
      if (balBig < BigInt(0)) continue
      const pct = Number(balBig * BigInt(1_000_000) / totalSupplyBig) / 10_000
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
        holder.percent = pct
        derivedCount += 1
      }
    } catch {}
  }
  if (derivedCount > 0) rows.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
  return derivedCount
}

function getClusterInfluenceDominance(clusterSupplyPercent: number | null): ClusterInfluence["clusterDominance"] {
  if (clusterSupplyPercent == null) return "unknown"
  if (clusterSupplyPercent === 0) return "none"
  if (clusterSupplyPercent < 5) return "low"
  if (clusterSupplyPercent < 10) return "medium"
  if (clusterSupplyPercent < 20) return "high"
  return "critical"
}

function getClusterInfluenceBaseScore(clusterSupplyPercent: number): number {
  if (clusterSupplyPercent === 0) return 5
  if (clusterSupplyPercent <= 1) return 15
  if (clusterSupplyPercent < 5) return 30
  if (clusterSupplyPercent < 10) return 50
  if (clusterSupplyPercent < 20) return 70
  return 90
}

function getClusterInfluenceRiskLabel(score: number): ClusterInfluence["clusterRiskLabel"] {
  if (score >= 85) return "critical"
  if (score >= 65) return "high"
  if (score >= 45) return "elevated"
  if (score >= 25) return "watch"
  return "low"
}

function buildClusterInfluence(params: {
  clusterSupplyPercent: number | null
  creatorInTopHolders: boolean | null
  matchedLinkedWallets: SupplyControl["matchedLinkedWallets"]
  suspiciousTransfers: boolean
  holderEvidenceAvailable: boolean
  holderEvidencePartial: boolean
}): ClusterInfluence {
  const {
    clusterSupplyPercent,
    creatorInTopHolders,
    matchedLinkedWallets,
    suspiciousTransfers,
    holderEvidenceAvailable,
    holderEvidencePartial,
  } = params

  if (!holderEvidenceAvailable || clusterSupplyPercent == null) {
    return {
      clusterSupplyPercent: null,
      clusterDominance: "unknown",
      clusterRiskScore: null,
      clusterRiskLabel: "open_check",
      reason: "CORTEX needs more holder evidence before confirming cluster influence.",
      signals: [
        "Holder evidence is not complete enough to confirm cluster influence.",
        "Open check until indexed holder percentages are available.",
      ],
    }
  }

  let score = getClusterInfluenceBaseScore(clusterSupplyPercent)
  const signals: string[] = [
    clusterSupplyPercent === 0
      ? "No cluster supply found in indexed holders."
      : `${clusterSupplyPercent.toFixed(1)}% cluster supply found in indexed holders.`,
  ]

  if (creatorInTopHolders === true) {
    score += 5
    signals.push("Creator wallet appears in indexed top holders.")
  } else if (creatorInTopHolders === false) {
    signals.push("Creator wallet was not found in indexed top holders.")
  }

  if (matchedLinkedWallets.length >= 2) {
    score += 5
    signals.push(`${matchedLinkedWallets.length} linked wallets matched indexed holder rows.`)
  } else if (matchedLinkedWallets.length === 1) {
    signals.push("1 linked wallet matched indexed holder rows.")
  }

  if (suspiciousTransfers) {
    score += 10
    signals.push("Suspicious transfer pattern is present in dev intelligence.")
  }

  if (holderEvidencePartial) {
    score = Math.max(getClusterInfluenceBaseScore(0), score - 10)
    signals.push("Holder evidence is partial, so scoring is conservatively reduced.")
  }

  const clusterRiskScore = Math.max(0, Math.min(100, Math.round(score)))
  const clusterDominance = getClusterInfluenceDominance(clusterSupplyPercent)
  const dominanceText = clusterDominance === "none" ? "No" : `${clusterDominance.charAt(0).toUpperCase()}${clusterDominance.slice(1)}`

  return {
    clusterSupplyPercent,
    clusterDominance,
    clusterRiskScore,
    clusterRiskLabel: getClusterInfluenceRiskLabel(clusterRiskScore),
    reason: clusterSupplyPercent === 0
      ? "No cluster supply found in indexed holders."
      : `${dominanceText} cluster dominance from indexed holder evidence.`,
    signals: signals.slice(0, 4),
  }
}

// Safely parses an `eth_call` result hex string to a BigInt. Returns null for
// empty/invalid results (e.g. "0x" from a revert or non-standard contract),
// which would otherwise throw a SyntaxError from BigInt("0x").
function hexToBigInt(hex: string | null | undefined): bigint | null {
  if (!hex || hex === '0x' || hex === '0x0') return hex === '0x0' ? BigInt(0) : null
  try { return BigInt(hex) } catch { return null }
}

// BigInt-safe percentage: avoids float precision loss on 18-decimal ERC-20 balances.
// Returns e.g. 5.23 for 5.23%. Uses BigInt() constructor (not literals) for ES2017 compat.

const LP_HOLDER_BALANCE_FIELDS = ['balance', 'token_balance', 'balance_wei', 'token_balance_wei', 'balance_raw', 'raw_balance', 'amount', 'balance_raw_integer', 'balanceRaw', 'balance_raw_quote'] as const
const LP_HOLDER_PERCENT_FIELDS = ['percentage', 'percent', 'ownership_percentage', 'balancePercent', 'ownershipPercent', 'percent_of_supply', 'share', 'supply_percentage', 'percentage_relative_to_total_supply'] as const

function lpHolderBalanceRaw(holder: Record<string, unknown>): unknown {
  for (const field of LP_HOLDER_BALANCE_FIELDS) {
    if (holder[field] != null) return holder[field]
  }
  return null
}

// debug-only: identifies which of LP_HOLDER_BALANCE_FIELDS/LP_HOLDER_PERCENT_FIELDS supplied
// the value lpHolderBalanceRaw()/the direct-percentage lookup actually used, for _debug.lpResolution.
function lpHolderFieldUsed(holder: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    if (holder[field] != null) return field
  }
  return null
}

// debug-only: pulls a `<prefix>=NN.NN%` value out of lpControl.evidence, for _debug.lpResolution.
function _extractEvidencePctDebug(ev: string[], prefix: string): number | null {
  const line = ev.find((e) => e.startsWith(`${prefix}=`))
  if (!line) return null
  return parseFloat(line.split('=')[1]?.replace('%', '') ?? '') || null
}

function bigIntPct(balanceRaw: unknown, supplyRaw: unknown): number | null {
  try {
    if (balanceRaw == null || supplyRaw == null) return null
    const b = BigInt(String(balanceRaw).split('.')[0])
    const s = BigInt(String(supplyRaw).split('.')[0])
    if (s === BigInt(0)) return null
    return Number(b * BigInt(1000000) / s) / 10000
  } catch { return null }
}

function withTimeout(ms = 5000): AbortSignal {
  return AbortSignal.timeout(ms)
}

async function rpcCall(chain: ChainKey, method: string, params: unknown[]): Promise<string | null> {
  try {
    const rpcUrl = getAlchemyRpcUrl(chain);
    if (!rpcUrl) return null;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: withTimeout(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.result === "string" ? json.result : null;
  } catch { return null; }
}



async function rpcTokenString(chain: ChainKey, contract: string, selector: string): Promise<string | null> {
  const hex = await rpcCall(chain, 'eth_call', [{ to: contract, data: selector }, 'latest'])
  if (!hex || hex === '0x') return null
  try {
    const body = hex.startsWith('0x') ? hex.slice(2) : hex
    if (body.length >= 128) {
      // ABI-encoded dynamic string: offset(32) + length(32) + data
      const strLen = parseInt(body.slice(64, 128), 16)
      if (strLen > 0 && strLen <= 256) {
        const strHex = body.slice(128, 128 + strLen * 2)
        const text = Buffer.from(strHex, 'hex').toString('utf8').replace(/\u0000/g, '').trim()
        if (text) return text
      }
      // Fallback: trim trailing nulls from blob
      const strHex = body.slice(128).replace(/00+$/, '')
      const text = Buffer.from(strHex, 'hex').toString('utf8').replace(/\u0000/g, '').trim()
      if (text) return text
    }
    if (body.length === 64) {
      // bytes32-encoded name (MKR-style): fixed 32-byte value, trim null bytes
      const text = Buffer.from(body, 'hex').toString('utf8').replace(/\u0000/g, '').trim()
      if (text) return text
    }
  } catch {}
  return null
}
function pad32HexAddress(address: string): string {
  return `000000000000000000000000${address.toLowerCase().replace(/^0x/, "")}`;
}

// ------------------------------
// Fetch helpers
// ------------------------------
async function fetchOnchainSupply(chain: ChainKey, contract: string): Promise<{
  totalSupply: bigint | null; burnedZero: bigint | null; burnedDead: bigint | null
}> {
  const rpcUrl = getAlchemyRpcUrl(chain)
  if (!rpcUrl) return { totalSupply: null, burnedZero: null, burnedDead: null }
  const ZERO = '0x0000000000000000000000000000000000000000'
  const DEAD = '0x000000000000000000000000000000000000dEaD'
  const paddedZero = ZERO.slice(2).padStart(64, '0')
  const paddedDead = DEAD.slice(2).padStart(64, '0')
  try {
    const [tsRes, bzRes, bdRes] = await Promise.all([
      fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data: '0x18160ddd' }, 'latest'] }),
        signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: contract, data: '0x70a08231' + paddedZero }, 'latest'] }),
        signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: contract, data: '0x70a08231' + paddedDead }, 'latest'] }),
        signal: AbortSignal.timeout(5000) }).then(r => r.json()),
    ])
    const parseBig = (res: any): bigint | null => {
      const hex = res?.result
      if (!hex || hex === '0x' || hex === '0x0') return null
      try { return BigInt(hex) } catch { return null }
    }
    return { totalSupply: parseBig(tsRes), burnedZero: parseBig(bzRes), burnedDead: parseBig(bdRes) }
  } catch { return { totalSupply: null, burnedZero: null, burnedDead: null } }
}

async function fetchBytecode(chain: ChainKey, contract: string): Promise<string | null> {
  try {
    const rpcUrl = getAlchemyRpcUrl(chain);
    if (!rpcUrl) return null;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [contract, "latest"],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return json?.result || null;
  } catch {
    return null;
  }
}


async function rpcJson(chain: ChainKey, method: string, params: unknown[], timeoutMs = 6000): Promise<any | null> {
  const rpcUrl = getAlchemyRpcUrl(chain)
  if (!rpcUrl) return null
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.result ?? null
  } catch {
    return null
  }
}

async function getTokenAssetTransfers(chain: ChainKey, params: Record<string, unknown>): Promise<AlchemyTransfer[]> {
  const transfers: AlchemyTransfer[] = []
  let pageKey: string | undefined
  for (let page = 0; page < 3; page++) {
    try {
      const pageParams = pageKey ? { ...params, pageKey } : params
      const result = await rpcJson(chain, 'alchemy_getAssetTransfers', [pageParams], 8000) as { transfers?: AlchemyTransfer[]; pageKey?: string } | null
      transfers.push(...(result?.transfers ?? []))
      if (transfers.length >= 300) return transfers.slice(0, 300)
      pageKey = typeof result?.pageKey === 'string' && result.pageKey ? result.pageKey : undefined
      if (!pageKey) break
    } catch {
      break
    }
  }
  return transfers
}

function parseBlockNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return null
  const raw = value.trim()
  const parsed = raw.startsWith('0x') ? parseInt(raw, 16) : Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function parseTransferTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 2_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  if (typeof value !== 'string' || !value) return null
  const asNumber = Number(value)
  if (Number.isFinite(asNumber)) return asNumber > 2_000_000_000 ? Math.floor(asNumber / 1000) : Math.floor(asNumber)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

function isUsableEvidenceAddress(chain: ChainKey, value: string | null | undefined, tokenContract: string): value is string {
  const normalized = normalizeEvidenceAddress(value)
  if (!normalized) return false
  return normalized !== normalizeEvidenceAddress(tokenContract) && !chainInfraExclusions(chain).has(normalized)
}

function normalizeAlchemyTransferRow(chain: ChainKey, tokenAddress: string, row: AlchemyTransfer, source = 'alchemy_asset_transfers'): NormalizedTransfer | null {
  const from = normalizeEvidenceAddress(row.from)
  const to = normalizeEvidenceAddress(row.to ?? null)
  const token = normalizeEvidenceAddress(row.rawContract?.address ?? tokenAddress)
  if (!row.hash || !token || token !== normalizeEvidenceAddress(tokenAddress)) return null
  if (!isUsableEvidenceAddress(chain, from, tokenAddress) || !isUsableEvidenceAddress(chain, to, tokenAddress)) return null
  const normalizedToken = token
  return {
    txHash: row.hash,
    blockNumber: parseBlockNumber(row.blockNum),
    timestamp: parseTransferTimestamp(row.metadata?.blockTimestamp),
    from,
    to,
    amountRaw: row.rawContract?.value ?? (row.value != null ? String(row.value) : null),
    amountFormatted: row.value ?? null,
    tokenAddress: normalizedToken,
    source,
    confidence: 'high',
  }
}

function normalizeMoralisTransferRow(chain: ChainKey, tokenAddress: string, row: Record<string, unknown>): NormalizedTransfer | null {
  const from = normalizeEvidenceAddress(String(row.from_address ?? row.from ?? ''))
  const to = normalizeEvidenceAddress(String(row.to_address ?? row.to ?? ''))
  const token = normalizeEvidenceAddress(String(row.address ?? row.token_address ?? row.contract_address ?? tokenAddress))
  const hash = String(row.transaction_hash ?? row.tx_hash ?? row.hash ?? '')
  if (!hash || !token || token !== normalizeEvidenceAddress(tokenAddress)) return null
  if (!isUsableEvidenceAddress(chain, from, tokenAddress) || !isUsableEvidenceAddress(chain, to, tokenAddress)) return null
  const normalizedToken = token
  return {
    txHash: hash,
    blockNumber: parseBlockNumber(row.block_number),
    timestamp: parseTransferTimestamp(row.block_timestamp),
    from,
    to,
    amountRaw: row.value != null ? String(row.value) : (row.value_decimal != null ? String(row.value_decimal) : null),
    amountFormatted: toNum(row.value_decimal),
    tokenAddress: normalizedToken,
    source: 'moralis_token_transfers',
    confidence: 'medium',
  }
}

function finalizeTransfers(transfers: NormalizedTransfer[], limit: number): NormalizedTransfer[] {
  const seen = new Set<string>()
  return transfers
    .filter((t) => {
      const key = [t.txHash.toLowerCase(), t.from, t.to, t.tokenAddress, t.amountRaw ?? ''].join(':')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (a.blockNumber ?? Number.MAX_SAFE_INTEGER) - (b.blockNumber ?? Number.MAX_SAFE_INTEGER) || (a.timestamp ?? Number.MAX_SAFE_INTEGER) - (b.timestamp ?? Number.MAX_SAFE_INTEGER))
    .slice(0, Math.max(1, limit))
}

async function resolveTokenTransfers(params: {
  chain: ChainKey
  chainId: number
  tokenAddress: string
  deployerAddress?: string | null
  holderAddresses?: string[]
  limit?: number
  providerTransfersRaw?: any
}): Promise<TransferResolverResult> {
  const limit = params.limit ?? 200
  const sourceTrail: string[] = []
  let fallbackUsed = 'none'

  if (Array.isArray(params.providerTransfersRaw?.result)) {
    fallbackUsed = 'moralis_token_transfers'
    sourceTrail.push('moralis_token_transfers:attempted')
    const transfers = finalizeTransfers(
      (params.providerTransfersRaw.result as Record<string, unknown>[]).map((row) => normalizeMoralisTransferRow(params.chain, params.tokenAddress, row)).filter(Boolean) as NormalizedTransfer[],
      limit,
    )
    if (transfers.length > 0) return { transfers, insufficientEvidence: false, sourceTrail: [...sourceTrail, 'moralis_token_transfers:succeeded'], fallbackUsed, confidence: 'medium' }
    sourceTrail.push('moralis_token_transfers:no_usable_wallet_rows')
  } else if (params.providerTransfersRaw?.__status === 'not_configured') {
    sourceTrail.push('moralis_token_transfers:not_configured')
  }

  fallbackUsed = 'alchemy_asset_transfers'
  sourceTrail.push('alchemy_asset_transfers:attempted')
  const alchemyRows = await getTokenAssetTransfers(params.chain, {
    fromBlock: '0x0',
    toBlock: 'latest',
    category: ['erc20'],
    contractAddresses: [params.tokenAddress],
    order: 'asc',
    maxCount: `0x${Math.min(Math.max(limit, 50), 300).toString(16)}`,
    withMetadata: true,
  })
  const alchemyTransfers = finalizeTransfers(
    alchemyRows.map((row) => normalizeAlchemyTransferRow(params.chain, params.tokenAddress, row)).filter(Boolean) as NormalizedTransfer[],
    limit,
  )
  if (alchemyTransfers.length > 0) return { transfers: alchemyTransfers, insufficientEvidence: false, sourceTrail: [...sourceTrail, 'alchemy_asset_transfers:succeeded'], fallbackUsed, confidence: 'high' }
  sourceTrail.push('alchemy_asset_transfers:no_usable_wallet_rows')

  return {
    transfers: [],
    sourceTrail,
    ...buildInsufficientEvidenceBlock('No usable transfer evidence found for this token in this pass.', fallbackUsed),
  }
}

function holderRowsFromProvider(raw: any, source: string): NormalizedHolderRow[] {
  const items: any[] = Array.isArray(raw?.data?.items) ? raw.data.items
    : Array.isArray(raw?.data?.data?.items) ? raw.data.data.items
    : Array.isArray(raw?.items) ? raw.items
    : Array.isArray(raw?.holders) ? raw.holders
    : Array.isArray(raw?.token_holders) ? raw.token_holders
    : Array.isArray(raw?.result) ? raw.result
    : []
  return items.map((h: any) => {
    const address = normalizeEvidenceAddress(h.address ?? h.holder_address ?? h.wallet_address ?? h.wallet ?? h.owner_address ?? h.contract_address ?? null)
    if (!address) return null
    const balanceRaw = h.balance ?? h.token_balance ?? h.amount ?? null
    const pct = normalizeHolderPercent(h.percentage) ?? normalizeHolderPercent(h.percent) ?? normalizeHolderPercent(h.balancePercent) ?? normalizeHolderPercent(h.ownershipPercent) ?? normalizeHolderPercent(h.ownership_percentage) ?? normalizeHolderPercent(h.percent_of_supply) ?? normalizeHolderPercent(h.share) ?? normalizeHolderPercent(h.supply_percentage) ?? normalizeHolderPercent(h.percentage_relative_to_total_supply)
    return {
      address,
      balanceRaw: balanceRaw != null ? String(balanceRaw) : null,
      balanceFormatted: toNum(balanceRaw) ?? toNum(h.balance_quote) ?? null,
      pctOfSupply: pct,
      source,
      confidence: pct != null ? 'high' as const : 'medium' as const,
    }
  }).filter(Boolean) as NormalizedHolderRow[]
}

function finalizeHolders(chain: ChainKey, tokenAddress: string, rows: NormalizedHolderRow[], limit: number): NormalizedHolderRow[] {
  const merged = new Map<string, NormalizedHolderRow>()
  for (const row of rows) {
    if (!isUsableEvidenceAddress(chain, row.address, tokenAddress)) continue
    const prev = merged.get(row.address)
    if (!prev) { merged.set(row.address, row); continue }
    merged.set(row.address, {
      ...prev,
      balanceRaw: prev.balanceRaw ?? row.balanceRaw,
      balanceFormatted: prev.balanceFormatted ?? row.balanceFormatted,
      pctOfSupply: prev.pctOfSupply ?? row.pctOfSupply,
      confidence: prev.confidence === 'high' || row.confidence !== 'high' ? prev.confidence : row.confidence,
    })
  }
  return [...merged.values()]
    .sort((a, b) => (b.pctOfSupply ?? -1) - (a.pctOfSupply ?? -1) || (b.balanceFormatted ?? -1) - (a.balanceFormatted ?? -1))
    .slice(0, Math.max(1, limit))
}

async function resolveTokenHolders(params: {
  chain: ChainKey
  chainId: number
  tokenAddress: string
  totalSupply?: string | bigint | null
  limit?: number
  providerHoldersRaw?: any
  marketProviderHoldersRaw?: any
}): Promise<HolderResolverResult> {
  const sourceTrail: string[] = []
  const limit = params.limit ?? 200
  let fallbackUsed = 'none'

  if (params.providerHoldersRaw && params.providerHoldersRaw.__status !== 'not_configured') {
    fallbackUsed = 'goldrush_token_holders'
    sourceTrail.push('goldrush_token_holders:attempted')
    const holders = finalizeHolders(params.chain, params.tokenAddress, holderRowsFromProvider(params.providerHoldersRaw, 'goldrush_token_holders'), limit)
    if (holders.length > 0) return { holders, insufficientEvidence: false, sourceTrail: [...sourceTrail, 'goldrush_token_holders:succeeded'], fallbackUsed, confidence: holders.some((h) => h.pctOfSupply != null) ? 'high' : 'medium' }
    sourceTrail.push('goldrush_token_holders:no_usable_holder_rows')
  } else {
    sourceTrail.push('goldrush_token_holders:not_configured')
  }

  if (params.marketProviderHoldersRaw && params.marketProviderHoldersRaw.__status !== 'not_configured') {
    fallbackUsed = 'moralis_token_owners'
    sourceTrail.push('moralis_token_owners:attempted')
    const holders = finalizeHolders(params.chain, params.tokenAddress, holderRowsFromProvider(params.marketProviderHoldersRaw, 'moralis_token_owners'), limit)
    if (holders.length > 0) return { holders, insufficientEvidence: false, sourceTrail: [...sourceTrail, 'moralis_token_owners:succeeded'], fallbackUsed, confidence: holders.some((h) => h.pctOfSupply != null) ? 'medium' : 'low' }
    sourceTrail.push('moralis_token_owners:no_usable_holder_rows')
  } else {
    sourceTrail.push('moralis_token_owners:not_configured')
  }

  return {
    holders: [],
    sourceTrail,
    ...buildInsufficientEvidenceBlock('No usable holder evidence found for this token in this pass.', fallbackUsed),
  }
}

async function discoverTokenOrigin(chain: ChainKey, contract: string): Promise<{
  candidate: TokenOriginCandidate
  diag: TokenOriginDiscoveryDiag
}> {
  const diag: TokenOriginDiscoveryDiag = {
    optional_creation_lookup: { attempted: false, ok: false, reason: 'skipped' },
    contract_transaction_history: { attempted: false, ok: false, reason: 'skipped' },
    initial_token_flow_signal: { attempted: false, ok: false, reason: 'skipped' },
    rpc_fallback: { attempted: false, ok: false, reason: 'skipped' },
    selected_origin_candidate: { methodUsed: 'unknown', address: null, confidence: 'low', deployerStatus: 'not_confirmed' },
  }

  function finalize(candidate: TokenOriginCandidate): { candidate: TokenOriginCandidate; diag: TokenOriginDiscoveryDiag } {
    diag.selected_origin_candidate = {
      methodUsed: candidate.methodUsed,
      address: candidate.address,
      confidence: candidate.confidence,
      deployerStatus: candidate.deployerStatus,
    }
    return { candidate, diag }
  }

  if (chain === 'eth' || chain === 'base') {
    const scanKey = chain === 'eth'
      ? process.env.ETHERSCAN_API_KEY
      : (process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY)
    if (scanKey) {
      diag.optional_creation_lookup.attempted = true
      try {
        const scanUrl = chain === 'eth'
          ? `${CREATOR_LOOKUP_BASE_URL}?chainid=${CREATOR_LOOKUP_CHAIN_ID.eth}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${scanKey}`
          : `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${scanKey}`
        const scanRes = await fetch(scanUrl, { cache: 'no-store', signal: AbortSignal.timeout(6000) })
        diag.optional_creation_lookup.httpStatus = scanRes.status
        if (scanRes.ok) {
          const scanJson = await scanRes.json() as { status?: string; result?: Array<{ contractCreator?: string; txHash?: string }> }
          const r = scanJson?.result?.[0]
          if (scanJson.status === '1' && r?.contractCreator) {
            const creator = normalizeEvidenceAddress(r.contractCreator)
            if (isValidOriginCandidate(creator, contract)) {
              diag.optional_creation_lookup.ok = true
              diag.optional_creation_lookup.reason = 'contract_creation_record'
              diag.optional_creation_lookup.candidateAddress = creator
              diag.optional_creation_lookup.txHashPresent = Boolean(r.txHash)
              diag.optional_creation_lookup.confidence = 'high'
              return finalize({ address: creator, confidence: 'high', deployerStatus: 'confirmed', methodUsed: 'transaction_creation_record', creationTxHash: r.txHash ?? null, reason: 'Creation record from indexed transactions' })
            }
            diag.optional_creation_lookup.reason = 'rejected_infra_or_zero_candidate'
            diag.optional_creation_lookup.candidateAddress = creator
          } else {
            diag.optional_creation_lookup.reason = scanJson.status === '0' ? 'api_no_result' : 'unexpected_shape'
          }
        } else {
          diag.optional_creation_lookup.reason = `http_${scanRes.status}`
        }
      } catch (e) {
        diag.optional_creation_lookup.reason = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'fetch_error'
      }
    }
  }

  const covalentChain = chain === 'eth' || chain === 'base' ? COVALENT_CHAIN_SLUG[chain] : null
  const covalentKey = process.env.COVALENT_API_KEY
  if (covalentChain && covalentKey) {
    diag.contract_transaction_history.attempted = true
    try {
      const txRes = await fetch(
        `${COVALENT_BASE_URL}/${covalentChain}/address/${contract}/transactions_v2/?key=${covalentKey}&page-size=5&block-signed-at-asc=true&no-logs=true`,
        { cache: 'no-store', signal: AbortSignal.timeout(10000) },
      )
      diag.contract_transaction_history.httpStatus = txRes.status
      if (txRes.ok) {
        const txJson = await txRes.json() as { data?: { items?: CovalentTxItem[] } }
        const txItems = txJson?.data?.items ?? []
        diag.contract_transaction_history.itemCount = txItems.length
        const creationTx = txItems.find(t => t.successful && (t.to_address === null || t.to_address === ''))
        if (creationTx?.from_address && isValidOriginCandidate(creationTx.from_address, contract)) {
          const creator = creationTx.from_address.toLowerCase()
          diag.contract_transaction_history.ok = true
          diag.contract_transaction_history.reason = 'creation_tx_found'
          diag.contract_transaction_history.candidateAddress = creator
          diag.contract_transaction_history.txHashPresent = Boolean(creationTx.tx_hash)
          diag.contract_transaction_history.confidence = 'high'
          return finalize({ address: creator, confidence: 'high', deployerStatus: 'confirmed', methodUsed: 'creation_transaction_history', creationTxHash: creationTx.tx_hash ?? null, reason: 'Creation transaction from indexed contract history' })
        }
        const earliestExternal = txItems.find(t => t.successful && t.from_address && isValidOriginCandidate(t.from_address, contract))
        if (earliestExternal?.from_address) {
          const creator = earliestExternal.from_address.toLowerCase()
          diag.contract_transaction_history.ok = true
          diag.contract_transaction_history.reason = 'earliest_contract_activity'
          diag.contract_transaction_history.candidateAddress = creator
          diag.contract_transaction_history.txHashPresent = Boolean(earliestExternal.tx_hash)
          diag.contract_transaction_history.confidence = 'medium'
          return finalize({ address: creator, confidence: 'medium', deployerStatus: 'possible_match', methodUsed: 'earliest_contract_activity', creationTxHash: earliestExternal.tx_hash ?? null, reason: 'Earliest indexed contract activity; not confirmed creator' })
        }
        diag.contract_transaction_history.reason = 'no_creation_or_external_sender'
      } else {
        diag.contract_transaction_history.reason = `http_${txRes.status}`
      }
    } catch (e) {
      diag.contract_transaction_history.reason = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'fetch_error'
    }
  }

  diag.initial_token_flow_signal.attempted = true
  const mintTransfers = await getTokenAssetTransfers(chain, {
    fromBlock: '0x0', toBlock: 'latest',
    fromAddress: ZERO_ADDRESS,
    category: ['erc20'], contractAddresses: [contract],
    order: 'asc', maxCount: '0x32', withMetadata: true,
  })
  diag.initial_token_flow_signal.tokenTransfersFound = mintTransfers.length
  const firstMint = mintTransfers.find(t => t.to && isValidOriginCandidate(t.to, contract))
  if (firstMint?.to) {
    const addr = firstMint.to.toLowerCase()
    diag.initial_token_flow_signal.ok = true
    diag.initial_token_flow_signal.reason = 'mint_recipient_found'
    diag.initial_token_flow_signal.candidateAddress = addr
    diag.initial_token_flow_signal.confidence = 'medium'
    return finalize({ address: addr, confidence: 'medium', deployerStatus: 'possible_match', methodUsed: 'initial_mint_recipient', creationTxHash: firstMint.hash ?? null, reason: 'Initial mint recipient; likely deployer/distribution wallet, not confirmed creator' })
  }
  diag.initial_token_flow_signal.reason = 'no_mint_transfers'

  diag.rpc_fallback.attempted = true
  const earliestErc20 = await getTokenAssetTransfers(chain, {
    fromBlock: '0x0', toBlock: 'latest',
    category: ['erc20'], contractAddresses: [contract],
    order: 'asc', maxCount: '0x32', withMetadata: true,
  })
  const firstErc20 = earliestErc20.find(t => isValidOriginCandidate(t.from, contract) || isValidOriginCandidate(t.to, contract))
  if (firstErc20) {
    const addr = (isValidOriginCandidate(firstErc20.from, contract) ? firstErc20.from : firstErc20.to) ?? null
    if (isValidOriginCandidate(addr, contract)) {
      const normalized = addr.toLowerCase()
      diag.rpc_fallback.ok = true
      diag.rpc_fallback.reason = 'earliest_erc20_transfer'
      diag.rpc_fallback.candidateAddress = normalized
      diag.rpc_fallback.confidence = 'low'
      return finalize({ address: normalized, confidence: 'low', deployerStatus: 'possible_match', methodUsed: 'earliest_transfer', creationTxHash: null, reason: 'Earliest ERC-20 transfer participant; not confirmed creator' })
    }
  }

  const incomingExt = await getTokenAssetTransfers(chain, {
    fromBlock: '0x0', toBlock: 'latest', toAddress: contract,
    category: ['external'], order: 'asc', maxCount: '0x5', withMetadata: true,
  })
  const firstExt = incomingExt.find(t => t.from && isValidOriginCandidate(t.from, contract))
  if (firstExt?.from) {
    const normalized = firstExt.from.toLowerCase()
    diag.rpc_fallback.ok = true
    diag.rpc_fallback.reason = 'first_incoming_external'
    diag.rpc_fallback.candidateAddress = normalized
    diag.rpc_fallback.confidence = 'low'
    return finalize({ address: normalized, confidence: 'low', deployerStatus: 'possible_match', methodUsed: 'earliest_external_activity', creationTxHash: null, reason: 'First external transfer to contract; not confirmed creator' })
  }

  diag.rpc_fallback.reason = 'no_transfers_found'
  return finalize({ address: null, confidence: 'low', deployerStatus: 'not_confirmed', methodUsed: 'unknown', creationTxHash: null, reason: 'No origin candidate found from available sources' })
}

async function findTokenLinkedWallets(
  chain: ChainKey,
  deployer: string,
  tokenContract: string,
): Promise<{
  wallets: LinkedWallet[]
  status: 'ok' | 'none_found' | 'limited_check' | 'skipped'
  diag: LinkedWalletDiag
}> {
  const deployerLow = deployer.toLowerCase()
  const tokenLow = tokenContract.toLowerCase()
  const excluded = new Set([...chainInfraExclusions(chain), deployerLow, tokenLow])
  const diag: LinkedWalletDiag = {
    attempted: true,
    ok: false,
    tokenTransfersFound: 0,
    ethTransfersFound: 0,
    totalCandidates: 0,
    reason: '',
  }
  if (!getAlchemyRpcUrl(chain)) {
    diag.reason = 'rpc_not_configured'
    return { wallets: [], status: 'limited_check', diag }
  }

  const [tokenTransfers, ethTransfers] = await Promise.all([
    getTokenAssetTransfers(chain, {
      fromBlock: '0x0', toBlock: 'latest',
      fromAddress: deployer,
      category: ['erc20'],
      contractAddresses: [tokenContract],
      order: 'asc',
      maxCount: '0x64',
      withMetadata: true,
    }),
    getTokenAssetTransfers(chain, {
      fromBlock: '0x0', toBlock: 'latest',
      fromAddress: deployer,
      category: ['external'],
      order: 'asc',
      maxCount: '0x64',
      withMetadata: true,
    }),
  ])

  diag.tokenTransfersFound = tokenTransfers.length
  diag.ethTransfersFound = ethTransfers.length
  const walletMap = new Map<string, LinkedWallet>()

  for (const t of tokenTransfers) {
    const to = t.to?.toLowerCase()
    if (!to || excluded.has(to) || !normalizeEvidenceAddress(to)) continue
    const existing = walletMap.get(to)
    if (!existing) {
      walletMap.set(to, {
        address: to,
        amountReceived: t.value,
        asset: t.asset,
        txHash: t.hash,
        firstSeen: t.metadata?.blockTimestamp ?? null,
        confidence: 'medium',
        reason: 'token_supply_transfer',
      })
    } else {
      existing.amountReceived = (existing.amountReceived ?? 0) + (t.value ?? 0)
      const existingTs = existing.firstSeen ? new Date(existing.firstSeen).getTime() : Infinity
      const nextTs = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : Infinity
      if (nextTs < existingTs) {
        existing.firstSeen = t.metadata?.blockTimestamp ?? existing.firstSeen
        existing.txHash = t.hash ?? existing.txHash
      }
    }
  }

  for (const t of ethTransfers) {
    const to = t.to?.toLowerCase()
    if (!to || excluded.has(to) || !normalizeEvidenceAddress(to)) continue
    if (!walletMap.has(to)) {
      walletMap.set(to, {
        address: to,
        amountReceived: t.value,
        asset: 'ETH',
        txHash: t.hash,
        firstSeen: t.metadata?.blockTimestamp ?? null,
        confidence: 'low',
        reason: 'eth_funding_transfer',
      })
    }
  }

  diag.totalCandidates = walletMap.size
  const wallets = [...walletMap.values()].slice(0, 20)
  if (tokenTransfers.length === 0 && ethTransfers.length === 0) {
    diag.reason = 'no_transfers_found'
    return { wallets: [], status: 'limited_check', diag }
  }
  diag.ok = true
  diag.reason = wallets.length > 0 ? 'wallets_found' : 'transfers_checked_none_qualify'
  return { wallets, status: wallets.length > 0 ? 'ok' : 'none_found', diag }
}

async function fetchGoldRush(chain: ChainKey, contract: string): Promise<any> {
  try {
    const _grBase = (process.env.GOLDRUSH_BASE_URL ?? 'https://api.covalenthq.com').replace(/\/$/, '')
    const res = await fetch(
      `${_grBase}/v1/${chain}/tokens/${contract}/?key=${process.env.COVALENT_API_KEY}`,
      { signal: AbortSignal.timeout(5000) }
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// GoldRush Contract Intel — calls Covalent security endpoint for mint/blacklist/pause/proxy flags.
// Falls back to null if API key is missing, chain not supported, or endpoint returns no data.
// Bytecode signature scan is the fallback when this returns null.
async function fetchGoldRushContractIntel(chain: ChainKey, contract: string): Promise<{
  mint: boolean | null
  blacklist: boolean | null
  pause: boolean | null
  withdraw: boolean | null
  proxy: boolean | null
  upgradeable: boolean | null
  source: 'goldrush'
  raw: Record<string, unknown>
} | null> {
  try {
    const CHAIN_SLUG_MAP: Record<ChainKey, string> = {
      eth: 'eth-mainnet',
      base: 'base-mainnet',
      polygon: 'matic-mainnet',
      bnb: 'bsc-mainnet',
    }
    const chainSlug = CHAIN_SLUG_MAP[chain] ?? 'eth-mainnet'
    const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
    if (!apiKey) return null
    const _grBase = (process.env.GOLDRUSH_BASE_URL ?? 'https://api.covalenthq.com').replace(/\/$/, '')
    const res = await fetch(
      `${_grBase}/v1/${chainSlug}/tokens/${contract}/security/`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }
    )
    if (!res.ok) return null
    const json = await res.json()
    const items = (json?.data?.items ?? json?.data) ?? null
    const item = (Array.isArray(items) ? items[0] : items) as Record<string, unknown> | null
    if (!item || typeof item !== 'object') return null
    return {
      mint: item.is_mintable != null ? Boolean(item.is_mintable) : (item.has_mint != null ? Boolean(item.has_mint) : null),
      blacklist: item.is_blacklisted != null ? Boolean(item.is_blacklisted) : (item.has_blacklist != null ? Boolean(item.has_blacklist) : null),
      pause: item.is_pausable != null ? Boolean(item.is_pausable) : (item.has_pause != null ? Boolean(item.has_pause) : null),
      withdraw: item.has_withdraw != null ? Boolean(item.has_withdraw) : (item.is_withdrawal_risk != null ? Boolean(item.is_withdrawal_risk) : null),
      proxy: item.is_proxy != null ? Boolean(item.is_proxy) : (item.is_upgradeable != null ? Boolean(item.is_upgradeable) : null),
      upgradeable: item.is_upgradeable != null ? Boolean(item.is_upgradeable) : (item.is_proxy != null ? Boolean(item.is_proxy) : null),
      source: 'goldrush',
      raw: item,
    }
  } catch {
    return null
  }
}

async function fetchGeckoTerminal(contract: string, chain: ChainKey): Promise<any> {
  try {
    const networkMap: Record<ChainKey, string> = {
      eth:     'eth',
      base:    'base',
      polygon: 'polygon_pos',
      bnb:     'bsc',
    };
    const network = networkMap[chain] ?? 'base';
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/tokens/${contract}/pools?page=1&include=base_token%2Cquote_token`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
        signal: withTimeout(),
      }
    );
    if (!res.ok) {
      console.error('GeckoTerminal pools error:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("Error fetching GeckoTerminal pools:", err);
    return null;
  }
}

async function fetchGeckoTerminalToken(contract: string, chain: ChainKey): Promise<any> {
  try {
    const networkMap: Record<ChainKey, string> = {
      eth:     'eth',
      base:    'base',
      polygon: 'polygon_pos',
      bnb:     'bsc',
    };
    const network = networkMap[chain] ?? 'base';
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/tokens/${contract}`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
        signal: withTimeout(),
      }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Error fetching GeckoTerminal token info:", err);
    return null;
  }
}

async function fetchGeckoTerminalPoolOhlcv(poolAddress: string, chain: ChainKey, timeframe: { resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }, tokenPosition: 'base' | 'quote' = 'base'): Promise<{ json: any | null; httpStatus: number | null }> {
  try {
    const networkMap: Record<ChainKey, string> = {
      eth: 'eth',
      base: 'base',
      polygon: 'polygon_pos',
      bnb: 'bsc',
    }
    const network = networkMap[chain] ?? 'base'
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe.resolution}?aggregate=${timeframe.aggregate}&limit=${timeframe.limit}&currency=usd&token=${tokenPosition}`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
        signal: withTimeout(5000),
      }
    )
    return { json: res.ok ? await res.json() : null, httpStatus: res.status }
  } catch { return { json: null, httpStatus: null } }
}

// Token-level OHLCV — aggregates across all pools for the token.
// More reliable than pool-level for CL/V3 pools where individual pool OHLCV is not indexed.
async function fetchGeckoTerminalTokenOhlcv(tokenAddress: string, chain: ChainKey, timeframe: { resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }): Promise<{ json: any | null; httpStatus: number | null }> {
  try {
    const networkMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon_pos', bnb: 'bsc' }
    const network = networkMap[chain] ?? 'base'
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/tokens/${tokenAddress}/ohlcv/${timeframe.resolution}?aggregate=${timeframe.aggregate}&limit=${timeframe.limit}&currency=usd`,
      {
        headers: { Accept: 'application/json;version=20230302' },
        cache: 'no-store',
        signal: withTimeout(5000),
      }
    )
    return { json: res.ok ? await res.json() : null, httpStatus: res.status }
  } catch { return { json: null, httpStatus: null } }
}

// Determines whether the scanned token is the 'base' or 'quote' token in a GeckoTerminal pool.
// Uses the pool's relationship data (populated when pools are fetched with ?include=base_token,quote_token).
// Returns null when relationship data is absent so callers can safely try both sides.
function resolveTokenPositionInPool(
  pool: Record<string, unknown>,
  tokenAddress: string,
  networkId: string,
): 'base' | 'quote' | null {
  const rel = (pool.relationships ?? {}) as Record<string, unknown>
  const baseData = ((rel.base_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  const quoteData = ((rel.quote_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  const baseId = String(baseData?.id ?? '').toLowerCase()
  const quoteId = String(quoteData?.id ?? '').toLowerCase()
  const tokenNorm = tokenAddress.toLowerCase()
  const expectedId = `${networkId}_${tokenNorm}`
  if (baseId === expectedId || baseId.endsWith(`_${tokenNorm}`)) return 'base'
  if (quoteId === expectedId || quoteId.endsWith(`_${tokenNorm}`)) return 'quote'
  return null
}

function extractGeckoTerminalPoolAddress(pool: Record<string, unknown> | null | undefined): string | null {
  const attrs = (pool?.attributes ?? {}) as Record<string, unknown>
  const attrAddress = typeof attrs.address === 'string' ? attrs.address.trim().toLowerCase() : ''
  if (/^0x[a-f0-9]{40}$/.test(attrAddress)) return attrAddress
  const idAddress = String(pool?.id ?? '').match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() ?? null
  return idAddress && /^0x[a-f0-9]{40}$/.test(idAddress) ? idAddress : null
}

function poolTokenRelationshipDebug(pool: Record<string, unknown>, tokenAddress: string, networkId: string) {
  const rel = (pool.relationships ?? {}) as Record<string, unknown>
  const baseData = ((rel.base_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  const quoteData = ((rel.quote_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  return {
    poolId: String(pool.id ?? ''),
    poolAddress: extractGeckoTerminalPoolAddress(pool),
    baseTokenId: String(baseData?.id ?? '') || null,
    quoteTokenId: String(quoteData?.id ?? '') || null,
    tokenPosition: resolveTokenPositionInPool(pool, tokenAddress, networkId),
  }
}

// Fetches recent trades for a pool — last-resort candle source when indexed OHLCV is unavailable.
async function fetchGeckoTerminalPoolTrades(poolAddress: string, chain: ChainKey): Promise<{ json: any | null; httpStatus: number | null }> {
  try {
    const networkMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon_pos', bnb: 'bsc' }
    const network = networkMap[chain] ?? 'base'
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/pools/${poolAddress}/trades?trade_volume_in_usd_greater_than=0`,
      { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: withTimeout(5000) }
    )
    return { json: res.ok ? await res.json() : null, httpStatus: res.status }
  } catch { return { json: null, httpStatus: null } }
}

// Reconstructs OHLCV candles from raw GeckoTerminal trade events.
// Only uses real trade prices — no generated or interpolated values.
// Requires >= 3 valid priced trades spanning >= 2 time buckets; returns empty candles otherwise.
type ChartPoint = { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number }

function incrementReason(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

function normalizeOhlcvRows(list: unknown): { rawPointCount: number; validPointCount: number; rejectedReason?: string; points: ChartPoint[] } {
  if (!Array.isArray(list)) return { rawPointCount: 0, validPointCount: 0, rejectedReason: 'ohlcv_list_missing', points: [] }
  let invalidRows = 0
  const points = list.map((row: unknown) => {
    const arr = Array.isArray(row) ? row : null
    const tsNum = toNum(arr?.[0])
    const close = toNum(arr?.[4])
    if (tsNum == null || close == null || close <= 0) { invalidRows += 1; return null }
    const ms = tsNum > 1e12 ? tsNum : tsNum * 1000
    const rawOpen = toNum(arr?.[1]) ?? close
    const rawHigh = toNum(arr?.[2]) ?? close
    const rawLow  = toNum(arr?.[3]) ?? close
    const open   = rawOpen > 0 ? rawOpen : close
    const high   = Math.max(rawHigh > 0 ? rawHigh : close, open, close)
    const low    = Math.min(rawLow  > 0 ? rawLow  : close, open, close)
    const volume = toNum(arr?.[5]) ?? null
    return { timestamp: new Date(ms).toISOString(), open, high, low, close, volume, priceUsd: close }
  }).filter((point: ChartPoint | null): point is ChartPoint => point != null)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return {
    rawPointCount: list.length,
    validPointCount: points.length,
    rejectedReason: points.length >= 2 ? undefined : (invalidRows > 0 ? 'invalid_or_non_positive_ohlcv_rows' : 'insufficient_points'),
    points,
  }
}

function reconstructCandlesFromTrades(
  trades: unknown[],
  currentPriceUsd: number | null,
): { candles: ChartPoint[]; rawTradeCount: number; validTradePriceCount: number; rejectedTradeReasons: Record<string, number> } {
  const rejectedTradeReasons: Record<string, number> = {}
  if (!Array.isArray(trades) || trades.length < 3) {
    if (!Array.isArray(trades) || trades.length === 0) incrementReason(rejectedTradeReasons, 'no_trades_returned')
    else incrementReason(rejectedTradeReasons, 'fewer_than_three_trades')
    return { candles: [], rawTradeCount: Array.isArray(trades) ? trades.length : 0, validTradePriceCount: 0, rejectedTradeReasons }
  }
  type TradePoint = { tsMs: number; price: number; volUsd: number | null }
  const points: TradePoint[] = []
  for (const trade of trades) {
    const attrs = ((trade as Record<string, unknown>)?.attributes) as Record<string, unknown> | undefined
    if (!attrs) { incrementReason(rejectedTradeReasons, 'missing_trade_attributes'); continue }
    const tsRaw = attrs.block_timestamp ?? attrs.timestamp
    const tsMs: number | null = tsRaw == null ? null
      : typeof tsRaw === 'number' ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000)
      : !isNaN(Date.parse(String(tsRaw))) ? new Date(String(tsRaw)).getTime()
      : null
    if (!tsMs || isNaN(tsMs)) { incrementReason(rejectedTradeReasons, 'missing_trade_timestamp'); continue }
    const candidates = [
      toNum(attrs.price_in_usd),
      toNum(attrs.price_from_in_usd),
      toNum(attrs.price_to_in_usd),
      toNum(attrs.base_token_price_usd),
      toNum(attrs.quote_token_price_usd),
    ].filter((candidate): candidate is number => candidate != null && candidate > 0)
    if (candidates.length === 0) { incrementReason(rejectedTradeReasons, 'missing_positive_trade_price'); continue }
    let price = candidates[0]
    if (currentPriceUsd != null && currentPriceUsd > 0) {
      // Keep only obviously impossible unit mismatches out. Tiny tokens can vary by many orders
      // across provider price fields, so prefer nearest real positive price instead of rejecting
      // the whole trade on a tight 0.05x–20x band.
      const eligible = candidates.filter(candidate => candidate >= currentPriceUsd * 1e-9 && candidate <= currentPriceUsd * 1e9)
      if (eligible.length === 0) { incrementReason(rejectedTradeReasons, 'trade_price_extreme_outlier'); continue }
      price = eligible.reduce((best, candidate) => Math.abs(Math.log(candidate / currentPriceUsd)) < Math.abs(Math.log(best / currentPriceUsd)) ? candidate : best, eligible[0])
    }
    points.push({ tsMs, price, volUsd: toNum(attrs.volume_in_usd) ?? null })
  }
  if (points.length < 3) {
    incrementReason(rejectedTradeReasons, 'fewer_than_three_valid_trade_prices')
    return { candles: [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
  }
  points.sort((a, b) => a.tsMs - b.tsMs)
  const spanMs = points[points.length - 1].tsMs - points[0].tsMs
  if (spanMs < 60000) {
    incrementReason(rejectedTradeReasons, 'trade_span_under_one_minute')
    return { candles: [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
  }
  const bucketMs = Math.max(60000, Math.ceil(spanMs / 20))
  const buckets = new Map<number, TradePoint[]>()
  for (const pt of points) {
    const key = Math.floor(pt.tsMs / bucketMs) * bucketMs
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(pt)
  }
  if (buckets.size < 2) {
    incrementReason(rejectedTradeReasons, 'fewer_than_two_trade_buckets')
    return { candles: [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
  }
  const candles = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, pts]) => {
      const prices = pts.map(p => p.price)
      const open = pts[0].price
      const close = pts[pts.length - 1].price
      const high = Math.max(...prices)
      const low = Math.min(...prices)
      const volSum = pts.reduce((s, p) => s + (p.volUsd ?? 0), 0)
      return { timestamp: new Date(bucketStart).toISOString(), open, high, low, close, volume: volSum > 0 ? volSum : null, priceUsd: close }
    })
  if (candles.length < 2) incrementReason(rejectedTradeReasons, 'fewer_than_two_reconstructed_candles')
  return { candles: candles.length >= 2 ? candles : [], rawTradeCount: trades.length, validTradePriceCount: points.length, rejectedTradeReasons }
}


type ProjectSocialsResult = {
  website: string | null
  twitter: string | null
  telegram: string | null
  discord: string | null
  github: string | null
  sourceTrail: string[]
  status: 'verified' | 'partial' | 'unavailable_with_reason'
  reason?: string
}

function _isValidSocialUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.trim()) return false
  try { const u = new URL(raw.trim()); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}
function _toTwitterUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const h = raw.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitter\.com\//i, '').replace(/^https?:\/\/(www\.)?x\.com\//i, '').split(/[/?#]/)[0]
  return h ? `https://x.com/${h}` : null
}
function _toTelegramUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const v = raw.trim()
  if (_isValidSocialUrl(v) && /t\.me\//i.test(v)) return v
  const h = v.replace(/^@/, '').replace(/^https?:\/\/(www\.)?t\.me\//i, '').split(/[/?#]/)[0]
  return h ? `https://t.me/${h}` : null
}

function extractProjectSocials(
  gtToken: Record<string, unknown> | null | undefined,
  coingeckoRaw: Record<string, unknown> | null | undefined,
  gmgnItem: Record<string, unknown> | null | undefined,
  dsFb: DexFallbackResult | null | undefined,
): ProjectSocialsResult & { _foundKeys: string[]; _rejectedCount: number } {
  let website: string | null = null
  let twitter: string | null = null
  let telegram: string | null = null
  let discord: string | null = null
  let github: string | null = null
  const sourceTrail: string[] = []
  const _foundKeys: string[] = []
  let _rejectedCount = 0

  const tryUrl = (raw: unknown, field: string): string | null => {
    if (!_isValidSocialUrl(raw)) { if (raw) _rejectedCount++; return null }
    _foundKeys.push(field)
    return (raw as string).trim()
  }

  // GeckoTerminal — gtToken is already gtTokenInfo.data.attributes (flat object)
  const gtAttr = gtToken  // NOT gtToken.attributes — caller passes the attributes directly
  if (gtAttr) {
    const websites = gtAttr.websites as unknown[] | null | undefined
    const w0 = Array.isArray(websites) ? websites[0] : null
    if (!website) website = tryUrl(w0, 'gt.websites[0]')
    if (!twitter) { const t = _toTwitterUrl(gtAttr.twitter_handle); if (t) { twitter = t; _foundKeys.push('gt.twitter_handle') } }
    if (!telegram) { const t = _toTelegramUrl(gtAttr.telegram_handle); if (t) { telegram = t; _foundKeys.push('gt.telegram_handle') } }
    if (!discord) discord = tryUrl(gtAttr.discord_url, 'gt.discord_url')
    if (_foundKeys.some(k => k.startsWith('gt.'))) sourceTrail.push('geckoterminal')
  }

  // CoinGecko
  const cgLinks = (coingeckoRaw?.links) as Record<string, unknown> | null | undefined
  if (cgLinks) {
    if (!website) {
      const hp = cgLinks.homepage as unknown[] | null | undefined
      const hp0 = Array.isArray(hp) ? hp[0] : null
      website = tryUrl(hp0, 'cg.homepage[0]')
    }
    if (!twitter) { const t = _toTwitterUrl(cgLinks.twitter_screen_name); if (t) { twitter = t; _foundKeys.push('cg.twitter_screen_name') } }
    if (!telegram) { const t = _toTelegramUrl(cgLinks.telegram_channel_identifier); if (t) { telegram = t; _foundKeys.push('cg.telegram_channel_identifier') } }
    if (!discord) {
      const chat = cgLinks.chat_url as unknown[] | null | undefined
      const chat0 = Array.isArray(chat) ? chat[0] : null
      if (!discord && typeof chat0 === 'string' && /discord/i.test(chat0)) discord = tryUrl(chat0, 'cg.chat_url[discord]')
    }
    if (!github) {
      const repos = (cgLinks.repos_url as Record<string, unknown> | null | undefined)?.github as unknown[] | null | undefined
      const g0 = Array.isArray(repos) ? repos[0] : null
      github = tryUrl(g0, 'cg.repos_url.github[0]')
    }
    if (_foundKeys.some(k => k.startsWith('cg.'))) sourceTrail.push('coingecko')
  }

  // GMGN
  if (gmgnItem) {
    if (!website) website = tryUrl(gmgnItem.website, 'gmgn.website')
    if (!twitter) { const t = _toTwitterUrl(gmgnItem.twitter); if (t) { twitter = t; _foundKeys.push('gmgn.twitter') } }
    if (!telegram) { const t = _toTelegramUrl(gmgnItem.telegram); if (t) { telegram = t; _foundKeys.push('gmgn.telegram') } }
    if (!discord) discord = tryUrl(gmgnItem.discord, 'gmgn.discord')
    if (!github) github = tryUrl(gmgnItem.github, 'gmgn.github')
    if (_foundKeys.some(k => k.startsWith('gmgn.'))) sourceTrail.push('gmgn')
  }

  // DexScreener fallback — pair.info.websites[] and pair.info.socials[]
  const dsInfo = dsFb?.info
  if (dsInfo) {
    if (!website && Array.isArray(dsInfo.websites)) {
      for (const w of dsInfo.websites) {
        const url = w.url
        if (typeof url === 'string' && url.trim() && _isValidSocialUrl(url) && !/dexscreener\.com/i.test(url)) {
          website = url.trim()
          _foundKeys.push('ds.info.websites[]')
          break
        }
      }
    }
    if (Array.isArray(dsInfo.socials)) {
      for (const s of dsInfo.socials) {
        const type = String(s.type ?? '').toLowerCase()
        if (!twitter && (type === 'twitter' || type === 'x')) {
          const t = _toTwitterUrl(s.url)
          if (t) { twitter = t; _foundKeys.push('ds.info.socials[twitter]') }
        } else if (!telegram && type === 'telegram') {
          const t = _toTelegramUrl(s.url)
          if (t) { telegram = t; _foundKeys.push('ds.info.socials[telegram]') }
        }
      }
    }
    if (_foundKeys.some(k => k.startsWith('ds.'))) sourceTrail.push('dexscreener')
  }

  const found = [website, twitter, telegram, discord, github].filter(Boolean).length
  const status: ProjectSocialsResult['status'] = found === 0 ? 'unavailable_with_reason' : found >= 2 ? 'verified' : 'partial'
  const reason = found === 0 ? 'No social links found in any metadata provider' : undefined

  return { website, twitter, telegram, discord, github, sourceTrail, status, reason, _foundKeys, _rejectedCount }
}

const CHAIN_ID_MAP: Record<ChainKey, number> = { eth: 1, base: 8453, polygon: 137, bnb: 56 };

// Chain-aware LP lock/burn registry is centralized in lib/server/lpLockBurnIntel.ts.
// Only verified locker contracts belong in the registry; empty chain lists intentionally
// produce open_check instead of unlocked/safe claims.
const LOCKER_REGISTRY: Partial<Record<ChainKey, string[]>> = LP_LOCK_BURN_REGISTRY.lockersByChain;

// Resolves honeypot + tax simulation for a given chain and token address.
// Wraps fetchHoneypotSecurity and returns the canonical simulation object or null on failure.
async function resolveSimulation(chain: string, address: string): Promise<{
  honeypot: boolean | null;
  honeypotStatus: "confirmed" | "unavailable" | "failed" | "not_supported" | "timeout";
  honeypotReason: string | null;
  buyTax: number | null;
  sellTax: number | null;
  transferTax: number | null;
  transferOK: boolean | null;
  simulationSuccess: boolean | null;
  source: string;
} | null> {
  try {
    const r = await fetchHoneypotSecurity(address, CHAIN_ID_MAP[chain as ChainKey])
    if (!r.ok) return null
    return {
      honeypot: r.honeypot,
      honeypotStatus: r.simulationStatus,
      honeypotReason: r.honeypotReason,
      buyTax: r.buyTax,
      sellTax: r.sellTax,
      transferTax: r.transferTax,
      transferOK: r.simulationSuccess,
      simulationSuccess: r.simulationSuccess,
      source: 'honeypot_is',
    }
  } catch {
    return null
  }
}

// Public-safe labels for internal data-source/method identifiers. The normal /api/token
// response must never name third-party providers (GoldRush, Moralis, Dexscreener, etc.) —
// only when debug=1/true is requested does the raw provider identifier pass through, for
// private diagnostics.
const PUBLIC_SOURCE_LABELS: Record<string, string> = {
  goldrush_token_holders: 'Holder evidence',
  moralis_token_owners: 'Holder evidence',
  moralis_token_transfers: 'Transfer evidence',
  moralis_transfer_fallback: 'Transfer inference',
  rpc_selector: 'On-chain verification',
  dexscreener: 'Market data',
  geckoterminal: 'Market data',
  coingecko_terminal: 'Market data',
  coingecko: 'Market data',
  fdv_derived: 'Derived market data',
  honeypot_is: 'Simulation evidence',
}
function publicSourceLabel<T extends string | null | undefined>(value: T, debugMode: boolean): T | string {
  if (value == null) return value
  if (debugMode) return value
  return PUBLIC_SOURCE_LABELS[value] ?? value
}

// Resolves contract flags from ABI scan (GoldRush Contract Intel) with bytecode fallback.
// Returns boolean|null per flag: true = detected, false = not detected, null = not analyzed.
function resolveContractFlags(
  grResult: { mint: boolean | null; blacklist: boolean | null; pause: boolean | null; withdraw: boolean | null; proxy: boolean | null; upgradeable: boolean | null } | null,
  cortexFlags: { mint: { status: string }; blacklist: { status: string }; pause: { status: string }; withdraw: { status: string }; proxy: { status: string } },
): { mint: boolean | null; blacklist: boolean | null; pause: boolean | null; withdraw: boolean | null; proxy: boolean | null } {
  const resolve = (grVal: boolean | null | undefined, cortexStatus: string): boolean | null =>
    grVal != null ? grVal :
    cortexStatus === 'verified' ? true :
    cortexStatus === 'not_detected' ? false : null
  return {
    mint: resolve(grResult?.mint, cortexFlags.mint.status),
    blacklist: resolve(grResult?.blacklist, cortexFlags.blacklist.status),
    pause: resolve(grResult?.pause, cortexFlags.pause.status),
    withdraw: resolve(grResult?.withdraw, cortexFlags.withdraw.status),
    proxy: resolve(grResult?.proxy ?? grResult?.upgradeable, cortexFlags.proxy.status),
  }
}

// ─── Secondary market data fallback ──────────────────────────────────────────
// Server-side only. Called once when the primary market source has no pool.
// Any failure (non-200, non-JSON, timeout, wrong chain) silently returns null.

interface DexFallbackResult {
  priceUsd: number | null
  liquidityUsd: number | null
  volume24h: number | null
  priceChange24h: number | null
  fdv: number | null
  pairAddress: string | null
  dexId: string | null
  pairUrl: string | null
  baseToken: { address: string; symbol: string; name: string } | null
  quoteToken: { address: string; symbol: string; name: string } | null
  pairCreatedAt: string | null
  info: {
    websites: Array<{ label?: string; url?: string }> | null
    socials: Array<{ type?: string; url?: string }> | null
  } | null
}

const _dexFbCache = new Map<string, { data: DexFallbackResult | null; ts: number }>()

interface _ChartCacheSlot {
  priceChart: { timeframe: '24h'|'48h'|'7d'|'30d'; points: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number }>; sourceStatus: 'ok'|'partial'|'error'; reason?: string; fallbackUsed?: boolean }
  chartUsedTradeReconstruction: boolean
  chartUsedTokenLevelOhlcv: boolean
  chartUsedDexScreener: boolean
  chartUsedSyntheticCandles: boolean
  chartUsedFlatSynthetic: boolean
  dexScreenerChartAttempted: boolean
  dexScreenerChartSuccess: boolean
  chartTradeReconstructionAttempted: boolean
  chartTokenLevelAttempted: boolean
  poolOhlcvAttempts: Array<{ poolId: string; poolAddress: string; tokenPosition: 'base'|'quote'; timeframe: string; httpStatus?: number; rawPointCount: number; validPointCount: number; rejectedReason?: string }>
  tokenOhlcvAttempts: Array<{ timeframe: string; httpStatus?: number; rawPointCount: number; validPointCount: number; rejectedReason?: string }>
  rawTradeCount: number
  validTradePriceCount: number
  chartReconstructedCandleCount: number
  tradePoolsAttempted: string[]
  rejectedTradeReasons: Record<string, number>
  chartAttemptedTimeframes: string[]
  chartAttemptedPools: Array<{ address: string; name: string | null; liquidityUsd: number | null }>
  chartSelectedPoolForChart: { address: string; name: string | null } | null
  chartFailureReason: string | null
  totalChartHttpCalls: number
  rateLimited: boolean
  rateLimitedAt: string | null
  skippedDueToRateLimit: number
}
const _chartOhlcvCache = new Map<string, { v: _ChartCacheSlot; ts: number; ttl: number }>()

async function fetchDexScreenerFallback(tokenAddress: string, chain: ChainKey = 'base'): Promise<DexFallbackResult | null> {
  const dexChainIdMap: Record<ChainKey, string> = {
    eth: 'ethereum',
    base: 'base',
    polygon: 'polygon',
    bnb: 'bsc',
  }
  const dexChainId = dexChainIdMap[chain] ?? 'base'
  const key = `${chain}:${tokenAddress.toLowerCase()}`
  const cached = _dexFbCache.get(key)
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.data
  const miss = (data: DexFallbackResult | null) => {
    _dexFbCache.set(key, { data, ts: Date.now() })
    return data
  }

  try {
    const _dsBase = (process.env.DEXSCREENER_BASE_URL ?? 'https://api.dexscreener.com').replace(/\/$/, '')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    let res: Response
    try {
      res = await fetch(
        `${_dsBase}/token-pairs/v1/${dexChainId}/${tokenAddress}`,
        { signal: ctrl.signal, cache: 'no-store' }
      )
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) return miss(null)
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return miss(null)

    const json: unknown = await res.json().catch(() => null)
    if (!json) return miss(null)

    const raw = json as Record<string, unknown>
    const pairs: unknown[] = Array.isArray(json) ? json
      : Array.isArray(raw.pairs) ? raw.pairs as unknown[]
      : []

    const addrLower = tokenAddress.toLowerCase()
    const basePairs = pairs.filter((p) => {
      const pair = p as Record<string, unknown>
      const bt = pair.baseToken as Record<string, unknown> | null
      const qt = pair.quoteToken as Record<string, unknown> | null
      return (
        pair.chainId === dexChainId &&
        (String(bt?.address ?? '').toLowerCase() === addrLower ||
         String(qt?.address ?? '').toLowerCase() === addrLower)
      )
    })

    if (basePairs.length === 0) return miss(null)

    // Highest liquidity.usd among pairs that include this token
    const best = basePairs.reduce<Record<string, unknown>>((acc, p) => {
      const pair = p as Record<string, unknown>
      const liqP = Number((pair.liquidity as Record<string, unknown> | null)?.usd ?? 0)
      const liqA = Number((acc.liquidity as Record<string, unknown> | null)?.usd ?? 0)
      return liqP > liqA ? pair : acc
    }, basePairs[0] as Record<string, unknown>)

    const liq = best.liquidity as Record<string, unknown> | null
    const vol = best.volume as Record<string, unknown> | null
    const pc = best.priceChange as Record<string, unknown> | null
    const bt = best.baseToken as Record<string, unknown> | null
    const qt = best.quoteToken as Record<string, unknown> | null

    // info may be absent on the highest-liquidity pair — scan all matching pairs for social data
    const infoSource = (basePairs as Record<string, unknown>[]).find(p => {
      const info = p.info as Record<string, unknown> | null | undefined
      return info != null && (Array.isArray(info.websites) || Array.isArray(info.socials))
    }) ?? best
    const rawInfo = infoSource.info as Record<string, unknown> | null | undefined
    const rawWebsites = Array.isArray(rawInfo?.websites) ? rawInfo!.websites as Array<Record<string, unknown>> : null
    const rawSocials  = Array.isArray(rawInfo?.socials)  ? rawInfo!.socials  as Array<Record<string, unknown>> : null
    return miss({
      priceUsd:     best.priceUsd != null ? Number(best.priceUsd) : null,
      liquidityUsd: liq?.usd != null ? Number(liq.usd) : null,
      volume24h:    vol?.h24 != null ? Number(vol.h24) : null,
      priceChange24h: pc?.h24 != null ? Number(pc.h24) : null,
      fdv:          best.fdv != null ? Number(best.fdv) : null,
      pairAddress:  best.pairAddress != null ? String(best.pairAddress) : null,
      dexId:        best.dexId != null ? String(best.dexId) : null,
      pairUrl:      best.url != null ? String(best.url) : null,
      baseToken:    bt != null ? { address: String(bt.address ?? ''), symbol: String(bt.symbol ?? ''), name: String(bt.name ?? '') } : null,
      quoteToken:   qt != null ? { address: String(qt.address ?? ''), symbol: String(qt.symbol ?? ''), name: String(qt.name ?? '') } : null,
      pairCreatedAt: best.pairCreatedAt != null ? String(best.pairCreatedAt) : null,
      info: rawInfo != null ? {
        websites: rawWebsites ? rawWebsites.map(w => ({ label: w.label != null ? String(w.label) : undefined, url: w.url != null ? String(w.url) : undefined })) : null,
        socials:  rawSocials  ? rawSocials.map(s  => ({ type:  s.type  != null ? String(s.type)  : undefined, url: s.url  != null ? String(s.url)  : undefined })) : null,
      } : null,
    })
  } catch {
    return miss(null)
  }
}

// Attempts to fetch OHLCV candle data from DexScreener for a known pair address.
// DexScreener's current public API does not expose historical OHLCV through documented endpoints.
// This function checks the single-pair endpoint for any chart/ohlcv fields that may appear in
// future API versions, and returns null cleanly if none are found. The trade reconstruction
// fallback runs immediately after if this returns null.
async function fetchCoinGeckoToken(chain: ChainKey, contract: string): Promise<any> {
  try {
    const platform = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : chain
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${contract}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) })
    return res.ok ? await res.json() : null
  } catch { return null }
}

async function fetchMoralisHolders(chain: ChainKey, contract: string): Promise<any> {
  try {
    const chainMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon', bnb: 'bsc' }
    const key = process.env.MORALIS_API_KEY
    if (!key) return { __status: 'not_configured' }
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2/erc20/${contract}/owners?chain=${chainMap[chain]}&limit=100`, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    return res.ok ? await res.json() : { __status: 'error' }
  } catch { return { __status: 'error' } }
}

async function fetchMoralisTransfers(chain: ChainKey, contract: string): Promise<any> {
  try {
    const chainMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon', bnb: 'bsc' }
    const key = process.env.MORALIS_API_KEY
    if (!key) return { __status: 'not_configured' }
    // order=ASC fetches the EARLIEST transfers — required to find the initial mint (from=0x0)
    // which identifies the original deployer. Default DESC (latest) misses creation-era events
    // for established tokens that were deployed months or years ago.
    const res = await fetch(`https://deep-index.moralis.io/api/v2.2/erc20/${contract}/transfers?chain=${chainMap[chain]}&limit=50&order=ASC`, {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    return res.ok ? await res.json() : { __status: 'error' }
  } catch { return { __status: 'error' } }
}

function safeHolderReason(reason: string | null | undefined): string {
  const r = String(reason ?? '').toLowerCase().trim()
  if (!r) return 'holder_data_not_indexed'
  if (r.includes('missing_api_key')) return 'holder_provider_not_configured'
  if (r.includes('timeout')) return 'holder_provider_timeout'
  if (r.includes('bad_request')) return 'holder_query_rejected'
  if (r.includes('provider_error') || r.includes('provider_unavailable')) return 'holder_provider_error'
  if (r.includes('no_percentages')) return 'holder_rows_without_percentages'
  if (r.includes('no_rows')) return 'no_holder_rows_returned'
  if (r.includes('derived_from_supply')) return 'holder_percentages_derived_from_supply'
  if (r.includes('api_error') || r.includes('error')) return 'holder_provider_error'
  return reason ?? 'holder_data_not_indexed'
}


async function fetchGMGN(contract: string): Promise<any> {
  try {
    const res = await fetch(`https://api.gmgn.ai/token/${contract}`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchTokenMetadata(chain: ChainKey, contract: string): Promise<any> {
  try {
    const res = await fetch(
      `https://api.covalenthq.com/v1/${chain}/address/0x0000000000000000000000000000000000000000/balances_v2/?key=${process.env.COVALENT_API_KEY}&contract-address=${contract}`,
      { signal: AbortSignal.timeout(5000) }
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}


const TOKEN_HOLDERS_CACHE_TTL_MS = 45_000
const tokenHoldersCache = new Map<string, { exp: number; data: any }>()
const tokenHoldersInFlight = new Map<string, Promise<any>>()

async function fetchTokenHolders(_chain: ChainKey, contract: string): Promise<any> {
  const cacheKey = `${_chain}:${contract.toLowerCase()}`
  const cached = tokenHoldersCache.get(cacheKey)
  if (cached && cached.exp > Date.now()) return cached.data
  const inFlight = tokenHoldersInFlight.get(cacheKey)
  if (inFlight) return inFlight
  const p = fetchTokenHoldersUncached(_chain, contract).then((data) => {
    tokenHoldersCache.set(cacheKey, { exp: Date.now() + TOKEN_HOLDERS_CACHE_TTL_MS, data })
    tokenHoldersInFlight.delete(cacheKey)
    return data
  }).catch((err) => {
    tokenHoldersInFlight.delete(cacheKey)
    throw err
  })
  tokenHoldersInFlight.set(cacheKey, p)
  return p
}

async function fetchTokenHoldersUncached(_chain: ChainKey, contract: string): Promise<any> {
  const CHAIN_SLUG_MAP: Record<ChainKey, string> = {
    eth: 'eth-mainnet',
    base: 'base-mainnet',
    polygon: 'matic-mainnet',
    bnb: 'bsc-mainnet',
  }
  const chainSlug = CHAIN_SLUG_MAP[_chain] ?? 'base-mainnet'
  const endpointPath = `/v1/${chainSlug}/tokens/${contract}/token_holders_v2/`
  let statusCode: number | undefined
  try {
    // Use GOLDRUSH_API_KEY first (matches proxy/test routes); fall back to COVALENT_API_KEY
    const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
    if (!apiKey) {
      console.warn('[holder-debug] contract', contract, 'chain', chainSlug, 'result: missing API key')
      return { __status: 'not_configured', __reason: 'missing_api_key', __endpointPath: endpointPath, __chainUsed: chainSlug, __hasApiKey: false }
    }
    // page-size max accepted by Covalent: 100. Values above that (e.g. 200) return HTTP 400.
    const _grBase = (process.env.GOLDRUSH_BASE_URL ?? 'https://api.covalenthq.com').replace(/\/$/, '')
    const url = `${_grBase}${endpointPath}?page-number=0&page-size=100`
    console.log('[holder-debug] contract', contract, 'chain', chainSlug, 'path', endpointPath, 'params page-number=0&page-size=100')
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    statusCode = res.status
    if (!res.ok) {
      // Try to parse JSON error body for a safe reason; fall back to text snippet
      let safeReason = statusCode === 400 ? 'bad_request_check_endpoint_params' : 'provider_error'
      try {
        const errJson = await res.json()
        if (errJson?.error_message) safeReason = errJson.error_message
        console.warn('[holder-debug] non-ok', statusCode, 'error_message:', errJson?.error_message ?? '(none)', 'error_code:', errJson?.error_code ?? '(none)')
      } catch {
        const errText = await res.text().catch(() => '').then(t => t.slice(0, 200))
        console.warn('[holder-debug] non-ok', statusCode, errText)
      }
      return { __status: 'error', __reason: safeReason, __statusCode: statusCode, __endpointPath: endpointPath, __chainUsed: chainSlug, __hasApiKey: true }
    }
    const json = await res.json()
    const topKeys = Object.keys(json ?? {})
    const itemCount = json?.data?.items?.length ?? 0
    console.log('[holder-debug] statusCode', statusCode, 'responseKeys', topKeys, 'data.items.length', itemCount)
    if (json?.error) {
      console.warn('[holder-debug] API-level error:', json?.error_message)
      return { __status: 'error', __reason: json?.error_message ?? 'api_error', __statusCode: statusCode, __endpointPath: endpointPath, __responseKeys: topKeys, __chainUsed: chainSlug, __hasApiKey: true }
    }
    return { ...json, __endpointPath: endpointPath, __statusCode: statusCode, __responseKeys: topKeys, __chainUsed: chainSlug, __hasApiKey: true }
  } catch (err) {
    console.error('[holder-debug] exception', err)
    return { __status: 'error', __reason: 'provider_error', __statusCode: statusCode, __endpointPath: endpointPath, __chainUsed: chainSlug, __hasApiKey: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY) }
  }
}

type LpControlResult = {
  status: "burned" | "locked" | "protocol" | "team_controlled" | "concentrated_liquidity" | "partial" | "no_pool" | "open_check" | "insufficient_data" | "error";
  confidence: "high" | "medium" | "low";
  poolType: "v2" | "v3" | "aerodrome" | "concentrated" | "unknown";
  source: string;
  reason: string;
  evidence: string[];
  poolAddressPresent?: boolean;
  selectedPrimaryPoolSource?: string;
  dexId?: string;
  dexName?: string;
  probeV2Like?: boolean;
  probeV3Like?: boolean;
  lpVerificationPoolReason?: string;
  // Normalized split-pool fields — always set after LP resolution
  primaryMarketPool?: string | null;
  primaryMarketPoolId?: string | null;
  verificationPool?: string | null;
  verificationPoolDex?: string | null;
  verificationPoolType?: string | null;
  // Primary pool identity (for display — based on the market pool, not proof pool)
  primaryPoolDex?: string | null;
  primaryPoolType?: string | null;
  // Normalized proof status fields — always set after LP resolution
  proofStatus?: "open_check" | "verified" | "not_applicable" | null;
  lockStatus?: "locked" | "not_confirmed" | "not_applicable" | null;
  burnStatus?: "burned" | "not_confirmed" | "not_applicable" | null;
  // Authoritative LP model for the UI — derived from PRIMARY pool type, not verification pool
  displayLpModel?: "erc20_lp_token" | "concentrated_liquidity" | "protocol_or_gauge" | "open_check" | "no_pool" | null;
  lockBurnApplicable?: boolean;
  lockBurnReason?: string | null;
  // Shared three-way proof-applicability classification — single source of truth for
  // both Token Scanner and Liquidity Safety. "applicable": ERC-20 LP lock/burn proof
  // can run; "not_applicable": pool model has no ERC-20 LP token (concentrated/no_pool);
  // "unknown": pool model could not be classified.
  proofApplicability?: "applicable" | "not_applicable" | "unknown";
  // Secondary V2/Aerodrome ERC-20 LP pool signal — populated only when the PRIMARY pool
  // is concentrated/protocol liquidity AND a separate ERC-20 LP pool was found. Never
  // overrides `status`/`proofApplicability` above (selection rule 3/4).
  secondaryLpControlSignals?: {
    status: LpControlResult["status"];
    confidence: LpControlResult["confidence"];
    poolAddress: string | null;
    poolDex: string | null;
    poolType: string | null;
    pair?: string | null;
    reason: string;
    evidence: string[];
  } | null;
};
type LpDiagnostics = {
  attempted: boolean;
  chain: ChainKey;
  poolCount: number;
  primaryPoolAddress: string | null;
  primaryDex: string | null;
  poolType: string;
  lpTokenFound: boolean;
  lpTokenAddress: string | null;
  lpTokenTotalSupplyFound: boolean;
  burnBalanceFound: boolean;
  lockerBalanceFound: boolean;
  teamBalanceFound: boolean;
  lpState: LpControlResult["status"];
  confidence: LpControlResult["confidence"];
  reason: string;
  goldrushAttempted: boolean;
  goldrushItemCount: number;
  goldrushPctDerived: boolean;
  rpcFallbackAttempted: boolean;
  // Extended diagnostic fields
  goldrushStatus: string | null;
  rpcAttempted: boolean;
  totalSupplyChecked: boolean;
  burnAddressesChecked: boolean;
  lockerAddressesChecked: boolean;
  ownerTeamBalanceChecked: boolean;
  burnPercent: number | null;
  lockedPercent: number | null;
  teamPercent: number | null;
  failureReason: string | null;
  dexscreenerPoolSynthesized: boolean;
  poolDetected: boolean;
  poolSource: string;
  primaryPoolSelected: boolean;
  selectedPoolAddress: string | null;
  selectedPoolDex: string | null;
  selectedPoolType: string | null;
  selectedPoolLiquidityUsd: number | null;
  // Split-pool diagnostic fields (market vs verification)
  primaryMarketSelected: boolean;
  primaryMarketPoolAddress: string | null;
  primaryMarketPoolId: string | null;
  primaryMarketPoolAddressType: "contract" | "pool_id" | "unknown";
  primaryMarketDex: string | null;
  primaryMarketType: string | null;
  primaryMarketLiquidityUsd: number | null;
  lpVerificationPoolSelected: boolean;
  lpVerificationPoolAddress: string | null;
  lpVerificationDex: string | null;
  lpVerificationType: string | null;
  lpVerificationLiquidityUsd: number | null;
  v2PoolCandidatesCount: number;
  protocolPoolCandidatesCount: number;
  lpProofAttempted: boolean;
  holderProofAttempted: boolean;
  holderRawItemCount: number;
  lpProofSkipReason: string | null;
  // Chain-aware locker registry diagnostics
  lockerRegistryChain: string;
  lockerAddressesCheckedCount: number;
  lockerRegistryEmpty: boolean;
  rpcConfigured: boolean;
  rpcSkippedReason: string | null;
  // Selection rule 6: documents which strategy chose the canonical primary pool
  // (lpPool) used for lpControl/lpModelProof — currently always the
  // highest-liquidity pool among canonical market pools.
  selectedPrimaryPoolStrategy: 'highest_liquidity_canonical_market_pool';
  // Pool-candidate audit fields — explain exactly why a fallback pool was or wasn't
  // promoted into a usable LP-verification candidate, instead of a generic no-pool reason.
  selectedPoolPresent: boolean;
  marketPoolPresent: boolean;
  poolCandidateRejectionReason: string | null;
  poolModelStatus: "confirmed" | "partial" | "unknown";
};

function humanizeConcentratedMissingEvidence(key: string): string {
  switch (key) {
    case "positionManager": return "Position manager not resolved";
    case "topPositionOwner": return "Top position owner not resolved";
    case "positionCount": return "Position count unavailable";
    default: return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

type LpControlRead = {
  title: string;
  meaning: string;
  riskLevel: string;
  whatWasFound: string[];
  couldNotVerify: string[];
  nextAction: string;
};

function computeLpControlRead(lp: LpControlResult, pairName?: string | null, controllerAddress?: string | null, positionProof?: ConcentratedPositionProof | null): LpControlRead {
  const pair = pairName ? `Pair: ${pairName}` : null;
  const poolLine = pair ? ["Verification pool found", pair] : lp.poolAddressPresent ? ["Verification pool found"] : [];
  switch (lp.status) {
    case "burned":
      return {
        title: "LP tokens burned",
        meaning: "The LP tokens for this pool have been sent to a burn/dead address. Liquidity cannot be removed by a team wallet.",
        riskLevel: "Low",
        whatWasFound: [...poolLine, "Dominant LP share in burn/dead address"],
        couldNotVerify: [],
        nextAction: "Burn status confirmed. Standard rug-via-LP-removal risk is significantly reduced.",
      };
    case "locked":
      return {
        title: "LP tokens locked",
        meaning: "The majority of LP tokens are held by a known locker contract. Liquidity is constrained by the lock terms.",
        riskLevel: "Low — verify lock expiry",
        whatWasFound: [...poolLine, "Dominant LP share in known locker"],
        couldNotVerify: ["Lock expiry date", "Specific lock terms"],
        nextAction: "Check the locker contract for expiry date and unlock conditions.",
      };
    case "team_controlled":
      return {
        title: "LP controlled by wallet",
        meaning: "A single wallet holds dominant LP share and can remove liquidity at any time.",
        riskLevel: "High",
        whatWasFound: [...poolLine, controllerAddress ? `Single wallet (${controllerAddress}) holds dominant LP share` : "Single wallet holds dominant LP share"],
        couldNotVerify: [],
        nextAction: "Liquidity removal risk exists. Treat with caution until LP is locked or burned.",
      };
    case "protocol":
      if (lp.poolType === "aerodrome") {
        return {
          title: "Protocol liquidity — requires protocol-specific verification",
          meaning: "Liquidity is in an Aerodrome/Velodrome protocol pool. LP positions cannot be verified using the standard V2 LP-holder method.",
          riskLevel: "Not assessable via V2 method",
          whatWasFound: [...poolLine, "Pool type: Aerodrome/Velodrome"],
          couldNotVerify: ["LP holder distribution (V2 method N/A)", "Lock or burn status via standard ERC-20 check"],
          nextAction: "Verify LP lock via Aerodrome protocol — check veNFT positions or protocol lock features.",
        };
      }
      return {
        title: "Protocol liquidity — requires protocol-specific verification",
        meaning: `Liquidity is in a ${positionProof ? concentratedPoolDisplayLabel(positionProof.poolModel) : "concentrated-liquidity"} pool. LP positions are NFTs, not standard ERC-20 tokens — V2 holder checks do not apply.`,
        riskLevel: "Not assessable via V2 method",
        whatWasFound: [...poolLine, `Pool type: ${positionProof ? concentratedPoolDisplayLabel(positionProof.poolModel) : "concentrated liquidity"}`],
        couldNotVerify: ["LP token holder distribution (V2 method N/A)", "Lock or burn status via standard ERC-20 check"],
        nextAction: "Check LP positions on-chain via the protocol-specific position manager or explorer.",
      };
    case "concentrated_liquidity": {
      const couldNotVerify = positionProof
        ? (positionProof.status === "verified" ? [] : positionProof.missingEvidence.length ? positionProof.missingEvidence.map(humanizeConcentratedMissingEvidence) : ["Position ownership not resolved"])
        : ["Position proof not attempted"];
      return {
        title: "Concentrated liquidity — protocol-specific position checks",
        meaning: "Standard ERC-20 LP-token lock/burn proof does not apply to the primary concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.",
        riskLevel: "Caution",
        whatWasFound: [
          "Primary concentrated pool found",
          "Primary market pool selected",
          "Pool structure reviewed",
          ...(positionProof ? [`Position proof attempted — ${positionProof.status === "not_supported" ? "not supported" : positionProof.status.replace(/_/g, " ")}`] : []),
          ...(lp.secondaryLpControlSignals ? ["Secondary ERC-20 LP exposure detected"] : []),
        ],
        couldNotVerify,
        nextAction: positionProof?.nextAction ?? "Monitor liquidity movement through protocol-specific position checks.",
      };
    }
    case "partial":
      return {
        title: "Partial LP proof",
        meaning: "Pool detected, lock/burn proof not fully confirmed.",
        riskLevel: "Medium",
        whatWasFound: [...poolLine, "Some LP checks returned usable data"],
        couldNotVerify: ["Complete lock/burn/team LP proof"],
        nextAction: "Treat LP control as partial until more holder or RPC evidence is available.",
      };
    case "open_check":
      return {
        title: "Liquidity detected — pool model not yet confirmed",
        meaning: "Market evidence shows active liquidity, but the pool model and LP control path could not be confirmed from current on-chain evidence.",
        riskLevel: "Open Check",
        whatWasFound: [...poolLine, "Liquidity detected from market evidence"],
        couldNotVerify: ["Pool model (V2 / concentrated)", "LP lock/burn proof", "LP control path"],
        nextAction: "Re-scan to confirm the pool model on-chain before relying on LP lock/burn proof.",
      };
    case "no_pool":
    case "insufficient_data":
      return {
        title: "Insufficient LP verification data",
        meaning: lp.status === "no_pool" ? "No usable liquidity pool address was found for LP verification." : "LP ownership could not be verified this scan.",
        riskLevel: "Unknown",
        whatWasFound: lp.status === "no_pool" ? [] : [...poolLine, "Pool check attempted"],
        couldNotVerify: ["Burn proof", "Locker proof", "Dominant owner verification"],
        nextAction: lp.status === "no_pool" ? "Confirm token has an active pool with a usable on-chain pair address." : "Rescan and verify with additional on-chain LP ownership data.",
      };
    default: // unverified, error
      if (!lp.poolAddressPresent) {
        return {
          title: "Pool detected, lock/burn proof not confirmed",
          meaning: "Pool detected, lock/burn proof not confirmed.",
          riskLevel: "Unknown",
          whatWasFound: [],
          couldNotVerify: ["LP token distribution", "Lock or burn status", "Liquidity pool existence"],
          nextAction: "Confirm the token is actively traded. No pool means no on-chain liquidity depth to exit through.",
        };
      }
      if (lp.poolType === "v2") {
        return {
          title: "LP check inconclusive",
          meaning: "A V2 pool was found and checked, but holder data did not show a dominant burn, locker, or single-wallet pattern.",
          riskLevel: "Medium",
          whatWasFound: [...poolLine, "V2 LP holder check attempted"],
          couldNotVerify: ["Dominant lock or burn address", "Single-wallet LP concentration"],
          nextAction: "LP control unconfirmed. Monitor for large LP removal transactions.",
        };
      }
      return {
        title: "LP Control: Unverified",
        meaning: "Liquidity exists, but LP lock/control could not be proven from current checks.",
        riskLevel: "Medium — needs verification",
        whatWasFound: [...poolLine, "Major quote pool selected", "Alchemy RPC checks attempted"],
        couldNotVerify: ["LP token holder distribution", "Lock or burn status", "Standard V2/V3 LP interface"],
        nextAction: "LP control inferred — locker, burn-address, or protocol-specific proof not yet confirmed.",
      };
  }
}

function normalizeDexLabel(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.toLowerCase().replace(/[-_\s]+/g, '_')
  const map: Record<string, string> = {
    uniswap_v4:           'Uniswap V4',
    uniswapv4:            'Uniswap V4',
    uniswap_v3:           'Uniswap V3',
    uniswapv3:            'Uniswap V3',
    uniswap_v2:           'Uniswap V2',
    uniswapv2:            'Uniswap V2',
    uniswap:              'Uniswap',
    aerodrome_slipstream: 'Aerodrome Slipstream',
    aerodrome:            'Aerodrome',
    baseswap_v2:          'BaseSwap',
    baseswap:             'BaseSwap',
    pancakeswap_v3:       'PancakeSwap V3',
    pancakeswap_v2:       'PancakeSwap V2',
    pancakeswap:          'PancakeSwap',
    sushiswap_v3:         'SushiSwap V3',
    sushiswap_v2:         'SushiSwap V2',
    sushiswap:            'SushiSwap',
    alienbase:            'AlienBase',
    swapbased:            'SwapBased',
  }
  if (map[s]) return map[s]
  // Partial prefix match for network-specific variants (e.g. "uniswap-v4-base", "aerodrome-base")
  if (s.startsWith('uniswap_v4')) return 'Uniswap V4'
  if (s.startsWith('uniswap_v3')) return 'Uniswap V3'
  if (s.startsWith('uniswap_v2')) return 'Uniswap V2'
  if (s.startsWith('aerodrome')) return 'Aerodrome'
  if (s.startsWith('pancakeswap_v3')) return 'PancakeSwap V3'
  if (s.startsWith('pancakeswap')) return 'PancakeSwap'
  if (s.startsWith('sushiswap_v3')) return 'SushiSwap V3'
  if (s.startsWith('sushiswap')) return 'SushiSwap'
  if (s.startsWith('baseswap')) return 'BaseSwap'
  return null
}

function normalizePairCreatedAtValue(value: unknown): string | null {
  if (value == null || value === '') return null
  const raw = typeof value === 'string' ? value.trim() : value
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    const ms = n > 10_000_000_000 ? n : n * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof raw === 'string') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function computePairAge(createdAt: string): string | null {
  try {
    const normalized = normalizePairCreatedAtValue(createdAt) ?? createdAt
    const ms = Date.now() - new Date(normalized).getTime()
    if (isNaN(ms) || ms < 0) return null
    const mins  = Math.floor(ms / 60000)
    const hours = Math.floor(ms / 3600000)
    const days  = Math.floor(ms / 86400000)
    if (mins  < 60) return `${mins}m`
    if (hours < 48) return `${hours}h`
    if (days  < 60) return `${days}d`
    return `${Math.floor(days / 30)}mo`
  } catch { return null }
}

function extractPoolDex(pool: Record<string, unknown> | null, included: unknown[]): { dexId: string; dexName: string } {
  if (!pool) return { dexId: "", dexName: "" };
  const a = (pool.attributes ?? {}) as Record<string, unknown>;
  const rel = (pool.relationships ?? {}) as Record<string, unknown>;
  const attrDexId = String(a.dex_id ?? a.dex ?? "").toLowerCase().trim();
  const attrDexName = String(a.dex_name ?? "").toLowerCase().trim();
  const relDexData = ((rel.dex as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined);
  const relDexId = String(relDexData?.id ?? "").toLowerCase().trim();
  const lookupId = relDexId || attrDexId;
  let incDexName = "";
  if (lookupId && included.length) {
    const dexObj = included.find((x) => String((x as Record<string, unknown>).id ?? "").toLowerCase() === lookupId) as Record<string, unknown> | undefined;
    if (dexObj) incDexName = String(((dexObj.attributes ?? {}) as Record<string, unknown>).name ?? "").toLowerCase().trim();
  }
  return { dexId: attrDexId || relDexId, dexName: attrDexName || incDexName || attrDexId || relDexId };
}

// Resolves a pool's identifier to either a real 20-byte contract address, or — for
// Uniswap V4 / PoolManager-based pools — a bytes32 pool ID. GeckoTerminal pool ids look
// like "<network>_<hex>"; for V2/V3 the hex part is a 40-char (20-byte) pool contract
// address, but for V4 it's a 64-char (32-byte) pool ID that is NOT a contract address.
// Never truncate a 64-char pool ID into a fake 40-char address.
function extractPoolAddressOrId(rawId: unknown, attrAddress: unknown): { address: string | null; poolId: string | null; poolAddressType: "contract" | "pool_id" | "unknown" } {
  const addrRaw = String(attrAddress ?? '').trim().toLowerCase()
  if (/^0x[a-f0-9]{40}$/.test(addrRaw)) {
    return { address: addrRaw, poolId: null, poolAddressType: "contract" }
  }
  const idRaw = String(rawId ?? '')
  const idx = idRaw.indexOf('_')
  const idHex = (idx === -1 ? idRaw : idRaw.slice(idx + 1)).trim().toLowerCase()
  if (/^0x[a-f0-9]{40}$/.test(idHex)) {
    return { address: idHex, poolId: null, poolAddressType: "contract" }
  }
  if (/^0x[a-f0-9]{64}$/.test(idHex)) {
    return { address: null, poolId: idHex, poolAddressType: "pool_id" }
  }
  return { address: null, poolId: null, poolAddressType: "unknown" }
}

function normalizePool(pool: Record<string, unknown> | null, includedTokenById: Map<string, Record<string, unknown>>): NormalizedPool {
  const attrs = (pool?.attributes ?? {}) as Record<string, unknown>;
  const rel = (pool?.relationships ?? {}) as Record<string, unknown>;
  const baseId = String((((rel.base_token as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id) ?? "").trim();
  const quoteId = String((((rel.quote_token as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id) ?? "").trim();
  const baseInc = baseId ? (includedTokenById.get(baseId) ?? {}) : {};
  const quoteInc = quoteId ? (includedTokenById.get(quoteId) ?? {}) : {};
  const baseTokenAddress = String((baseInc as Record<string, unknown>).address ?? "").trim().toLowerCase() || null;
  const quoteTokenAddress = String((quoteInc as Record<string, unknown>).address ?? "").trim().toLowerCase() || null;
  const baseTokenSymbol = String((baseInc as Record<string, unknown>).symbol ?? "").trim() || null;
  const quoteTokenSymbol = String((quoteInc as Record<string, unknown>).symbol ?? "").trim() || null;
  const { address, poolId, poolAddressType } = extractPoolAddressOrId(pool?.id, attrs.address)
  const { dexId, dexName } = extractPoolDex(pool, []);
  return {
    address,
    poolId,
    poolAddressType,
    pairName: String(attrs.name ?? attrs.pool_name ?? attrs.pair_name ?? "").trim() || null,
    liquidityUsd: pickNum(attrs.reserve_in_usd, attrs.liquidity_usd, attrs.reserve_usd) ?? 0,
    dexId: dexId || null,
    dexName: dexName || null,
    baseTokenSymbol,
    quoteTokenSymbol,
    baseTokenAddress,
    quoteTokenAddress,
    poolType: detectPoolType(pool, dexId || undefined),
    hasLpToken: (() => {
      const pt = detectPoolType(pool, dexId || undefined)
      // "aerodrome" now means Aerodrome V2 (volatile/stable) — pool contract IS the ERC-20 LP token.
      if (pt === 'v2' || pt === 'aerodrome') return true
      if (pt === 'v3' || pt === 'concentrated') return false
      return null
    })(),
    hasDexMeta: Boolean(dexId || dexName),
    isValidAddress: Boolean(address && /^0x[a-f0-9]{40}$/.test(address)),
    raw: pool,
  };
}

type NormalizedPool = {
  address?: string | null;
  poolId?: string | null;
  poolAddressType?: "contract" | "pool_id" | "unknown";
  pairName?: string | null;
  liquidityUsd: number;
  dexId?: string | null;
  dexName?: string | null;
  baseTokenSymbol?: string | null;
  quoteTokenSymbol?: string | null;
  baseTokenAddress?: string | null;
  quoteTokenAddress?: string | null;
  poolType: "v2" | "v3" | "aerodrome" | "concentrated" | "unknown";
  // true = confirmed ERC20 LP token (V2-style, can probe burn/lock)
  // false = no ERC20 LP token (V3/CL NFT positions, proof not applicable)
  // null = unknown (needs RPC probe)
  hasLpToken: boolean | null;
  hasDexMeta: boolean;
  isValidAddress: boolean;
  containsScannedToken?: boolean;
  isPreferredQuote?: boolean;
  lpScore?: number;
  selectionReason?: string;
  raw?: unknown;
};

function selectLpVerificationPool(pools: NormalizedPool[], tokenAddress: string): { pool: NormalizedPool | null; reason: string; candidates: NormalizedPool[] } {
  const tokenLc = tokenAddress.toLowerCase();
  const quoteRank: Record<string, number> = {
    WETH: 1,
    USDC: 2,
    USDBC: 3,
    CBBTC: 4,
    DAI: 5,
    USDT: 6,
  };
  let best: { pool: NormalizedPool; score: number; reason: string } | null = null;
  for (const p of pools) {
    const includesToken = p.baseTokenAddress === tokenLc || p.quoteTokenAddress === tokenLc;
    const otherSymbol = p.baseTokenAddress === tokenLc ? p.quoteTokenSymbol : p.baseTokenSymbol;
    const quotePriority = otherSymbol ? quoteRank[otherSymbol.toUpperCase()] ?? null : null;
    const hasPreferredQuote = quotePriority != null;
    const v2LikeMeta = p.poolType === "v2";
    let score = 0;
    if (includesToken) score += 300;
    else score -= 1000;
    if (hasPreferredQuote) score += 500 - (quotePriority! * 50);
    if (v2LikeMeta) score += 20;
    if (p.poolType === "unknown") score -= 5;
    if (p.hasDexMeta) score += 15;
    if (!hasPreferredQuote) score -= 250;
    if (!p.isValidAddress) score -= 150;
    score += Math.min(30, Math.log10(Math.max(1, p.liquidityUsd + 1)) * 6);
    const reason = includesToken
      ? (hasPreferredQuote
          ? `selected quote-priority pool (${otherSymbol}, rank ${quotePriority}) for LP verification`
          : "no preferred quote pair found; selected best token-including fallback pool")
      : "excluded: pool does not include scanned token";
    if (!best || score > best.score) best = { pool: p, score, reason };
    p.containsScannedToken = includesToken;
    p.isPreferredQuote = hasPreferredQuote;
    p.lpScore = score;
    p.selectionReason = reason;
  }
  return best ? { pool: best.pool, reason: best.reason, candidates: pools } : { pool: null, reason: "no_pool_candidates", candidates: pools };
}

// Human-facing pool-model label for evidence/UI strings. Prefers the concrete model resolved
// by attemptConcentratedPositionProof (which also uses pool-ID shape as a signal) over raw
// dexId/poolType string matching, so Uniswap V4 is never displayed/labeled as "v3".
function concentratedPoolDisplayLabel(poolModel: string | null | undefined, dexText?: string | null): string {
  if (poolModel === "uniswap_v4") return "Uniswap V4 concentrated";
  if (poolModel === "uniswap_v3") return "Uniswap V3 concentrated";
  if (poolModel === "slipstream") return "Aerodrome Slipstream concentrated";
  if (poolModel === "aerodrome") return "Aerodrome concentrated";
  const d = (dexText ?? "").toLowerCase();
  if (/uniswap.*v4/.test(d)) return "Uniswap V4 concentrated";
  if (/uniswap.*v3/.test(d)) return "Uniswap V3 concentrated";
  return "concentrated";
}

function detectPoolType(pool: Record<string, unknown> | null, dexIdHint?: string): LpControlResult["poolType"] {
  const a = (pool?.attributes ?? {}) as Record<string, unknown>;
  const rel = (pool?.relationships ?? {}) as Record<string, unknown>;
  // Correctly extract the dex id from the relationships object (avoids "[object Object]" stringification)
  const relDexId = String(
    ((rel.dex as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id ?? ''
  ).toLowerCase().trim()
  const candidates = [
    dexIdHint,
    relDexId,
    a.dex_id, a.dex, a.dex_name, a.name, a.pool_name, a.pair_name, a.pool_type,
    pool?.id,
  ].map((v) => String(v ?? '').toLowerCase()).filter(Boolean);
  const text = candidates.join(' | ');
  // Fast-path: use startsWith on the most reliable id signals first.
  // This correctly handles network-suffixed variants like "uniswap_v2_eth" or "uniswap_v3_base".
  // Aerodrome/Velodrome Slipstream (concentrated-liquidity) pools are NOT ERC-20 LP tokens —
  // distinguish them from Aerodrome V2 (volatile/stable) pools, which ARE ERC-20 LP tokens.
  const isAerodromeFamily = (s: string) => /aerodrome|velodrome/.test(s)
  const isConcentratedMarker = (s: string) => /slipstream|concentrated|algebra|\bcl\b|[-_]cl[-_]?|[-_]cl$/.test(s)
  // CLMM / Infinity CLMM (e.g. PancakeSwap Infinity CLMM, any future "*-clmm-*" naming) and
  // Uniswap V3/V4 are concentrated-liquidity models — LP positions are NFTs, never ERC-20 V2
  // LP tokens, so they must never fall through to the generic "^pancakeswap|^sushiswap" → v2 default.
  const isConcentratedDex = (s: string) => /clmm|infinity[-_]?clmm|slipstream|concentrated/.test(s)
  const idSignals = [dexIdHint ?? '', relDexId, String(a.dex_id ?? a.dex ?? '').toLowerCase().trim()]
  for (const s of idSignals) {
    if (!s) continue
    if (isAerodromeFamily(s) && isConcentratedMarker(s)) return "concentrated"
    if (isAerodromeFamily(s)) return "aerodrome"
    if (isConcentratedDex(s)) return "concentrated"
    if (/^uniswap_v4|^uniswap-v4/.test(s)) return "concentrated"
    if (/^uniswap_v3|^uniswap-v3|^pancakeswap_v3|^pancakeswap-v3|^sushiswap_v3|^sushiswap-v3|^algebra/.test(s)) return "v3"
    if (/^uniswap_v2|^uniswap-v2|^pancakeswap_v2|^pancakeswap-v2|^sushiswap_v2|^sushiswap-v2|^baseswap|^alienbase|^swapbased|^shibaswap/.test(s)) return "v2"
    if (/^pancakeswap_v3|^pancakeswap-v3|^sushiswap_v3|^sushiswap-v3/.test(s)) return "v3"
    if (/^sushiswap|^pancakeswap/.test(s)) return "v2"  // unversioned: default to v2
  }
  const has = (re: RegExp) => re.test(text);
  if (has(/\baerodrome\b|\bvelodrome\b/) && has(/slipstream|concentrated|\bcl\b/)) return "concentrated";
  if (has(/\baerodrome\b|\bvelodrome\b/)) return "aerodrome";
  if (has(/clmm|infinity[-_]?clmm/)) return "concentrated";
  if (has(/\bslipstream\b/)) return "concentrated";
  if (has(/\bconcentrated\b|\bcl pool\b|\balgebra\b/)) return "concentrated";
  // Use (?:_|-) instead of \b after version number to match "uniswap_v3_eth" etc.
  if (has(/uniswap(?:[_-]?v)?3(?:[_-]|$)|\bpancakeswap(?:[_-]?v)?3(?:[_-]|$)|(?:^| )v3(?:[_-]|$)/)) return "v3";
  if (has(/uniswap(?:[_-]?v)?2(?:[_-]|$)|sushiswap(?:[_-]?v)?2(?:[_-]|$)|pancakeswap(?:[_-]?v)?2(?:[_-]|$)|\bbaseswap\b|\balienbase\b|\bswapbased\b|\bshiba(?:swap)?\b|constant[-_ ]?product|(?:^| )v2(?:[_-]|$)/)) return "v2";
  return "unknown";
}

async function probePoolTypeViaRpc(chain: ChainKey, poolAddr: string): Promise<{ v2Like: boolean; v3Like: boolean; probeSummary: string }> {
  const call = (data: string) => rpcCall(chain, "eth_call", [{ to: poolAddr, data }, "latest"]).catch(() => null);
  const ok = (x: string | null) => Boolean(x && x !== "0x" && x.length > 10);
  const [t0, t1, res, sup, s0, liq] = await Promise.all([
    call("0x0dfe1681"), // token0()
    call("0xd21220a7"), // token1()
    call("0x0902f1ac"), // getReserves()
    call("0x18160ddd"), // totalSupply()
    call("0x3850c7bd"), // slot0()
    call("0x1a686502"), // liquidity()
  ]);
  const v2Like = ok(t0) && ok(t1) && ok(res) && ok(sup);
  const v3Like = ok(t0) && ok(t1) && ok(s0) && ok(liq) && !ok(res);
  return {
    v2Like,
    v3Like,
    probeSummary: `t0=${ok(t0)},t1=${ok(t1)},res=${ok(res)},sup=${ok(sup)},slot0=${ok(s0)},liq=${ok(liq)}`,
  };
}

// ------------------------------
// Contract analysis
// ------------------------------
function analyzeContract(bytecode: string | null): any {
  const suspicious: string[] = [];

  if (!bytecode || bytecode === "0x") {
    return {
      ownerStatus: "Deployer inferred — RPC owner check deferred",
      liquidityStatus: "LP status inferred — lock/burn check requires pool address",
      honeypot: "Trading simulation deferred — verify tax and sell path before transacting",
      suspiciousFunctions: suspicious,
    };
  }

  if (bytecode.includes("selfdestruct") || bytecode.includes("suicide")) {
    suspicious.push("selfdestruct");
  }

  return {
    ownerStatus: "Deployer inferred — RPC owner check deferred",
    liquidityStatus: "LP status inferred — lock/burn check requires pool address",
    honeypot: "Trading simulation deferred — verify tax and sell path before transacting",
    suspiciousFunctions: suspicious,
  };
}

// ------------------------------
// CORTEX Contract Flag Scanner — bytecode + RPC, no external APIs required
// ------------------------------
type ContractFlagStatus = 'verified' | 'possible' | 'not_detected' | 'inferred' | 'partial'
type ContractFlagEntry = { status: ContractFlagStatus; confidence: 'high' | 'medium' | 'low'; note: string | null }
type CortexContractFlagsResult = {
  mint: ContractFlagEntry
  proxy: ContractFlagEntry
  pause: ContractFlagEntry
  blacklist: ContractFlagEntry
  withdraw: ContractFlagEntry
  bytecodeChecked: boolean
  proxySlotChecked: boolean
  pauseCallChecked: boolean
}

// ------------------------------
// CORTEX Risk Engine v1
// Derives risk score from existing scan data only. No external calls.
// ------------------------------
type RiskEngineResult = {
  rugRiskScore: number | null;
  rugRiskLevel: 'low' | 'medium' | 'high' | 'critical' | 'partial_data';
  confidence: 'high' | 'medium' | 'low';
  drivers: string[];
  missingChecks: string[];
  sniperActivity: {
    status: 'low_signal' | 'watch' | 'high' | 'not_applicable';
    confidence: 'high' | 'medium' | 'low';
    reasons: string[];
  };
}

function computeRiskEngine(input: {
  marketCapVerified: boolean;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  holderStatus: string;
  top1: number | null;
  top5: number | null;
  top10: number | null;
  top20: number | null;
  lpStatus: string;
  lpConfidence: string;
  isHoneypot: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  simulationSuccess: boolean | null;
  pairCreatedAt: string | null;
  holderCount: number | null;
  buys24h: number | null;
  sells24h: number | null;
}): RiskEngineResult {
  let score = 0;
  const drivers: string[] = [];
  const missingChecks: string[] = [];
  let confirmedDataPoints = 0;

  // ── Market cap ─────────────────────────────────────────────────────────────
  if (!input.marketCapVerified) {
    score += 8;
    missingChecks.push('Market cap not indexed — circulating supply not confirmed');
  } else {
    confirmedDataPoints++;
  }

  // ── Liquidity depth ────────────────────────────────────────────────────────
  if (input.liquidityUsd == null) {
    score += 5;
    missingChecks.push('Liquidity depth not indexed — pool depth not confirmed');
  } else if (input.liquidityUsd < 25_000) {
    score += 18;
    const liqFmt = input.liquidityUsd < 1_000 ? `<$1K` : `$${(input.liquidityUsd / 1_000).toFixed(1)}K`;
    drivers.push(`Very thin liquidity — ${liqFmt} pool depth`);
    confirmedDataPoints++;
  } else if (input.liquidityUsd < 100_000) {
    score += 10;
    drivers.push(`Thin liquidity — $${(input.liquidityUsd / 1_000).toFixed(0)}K pool depth`);
    confirmedDataPoints++;
  } else {
    confirmedDataPoints++;
  }

  // ── Volume ─────────────────────────────────────────────────────────────────
  if (input.volume24hUsd == null) {
    score += 6;
    missingChecks.push('24h volume not indexed');
  } else if (input.volume24hUsd < 1_000) {
    score += 6;
    drivers.push('Very low 24h trading volume');
    confirmedDataPoints++;
  } else {
    confirmedDataPoints++;
  }

  // ── Holder Map ─────────────────────────────────────────────────────────────
  const holderUnavailable = input.holderStatus === 'inferred' || input.holderStatus === 'empty' || input.holderStatus === 'error';
  const holderPartial = input.holderStatus === 'partial';
  if (holderUnavailable) {
    score += 15;
    missingChecks.push('Holder Map not indexed — concentration risk inferred, not confirmed');
  } else if (holderPartial) {
    score += 8;
    missingChecks.push('Holder Map partial — concentration estimate incomplete');
    confirmedDataPoints++;
  } else if (input.holderStatus === 'ok') {
    confirmedDataPoints++;
    if (input.top10 != null && input.top10 > 50) {
      score += 20;
      drivers.push(`High holder concentration — top 10 wallets hold ${input.top10.toFixed(1)}%`);
    }
    if (input.top20 != null && input.top20 > 60 && !(input.top10 != null && input.top10 > 50)) {
      score += 15;
      drivers.push(`Concentrated ownership — top 20 wallets hold ${input.top20.toFixed(1)}%`);
    }
    if (input.top1 != null && input.top1 > 15) {
      score += 12;
      drivers.push(`Single wallet dominance — top holder owns ${input.top1.toFixed(1)}%`);
    }
  }

  // ── LP Control ─────────────────────────────────────────────────────────────
  const lpSafe = input.lpStatus === 'burned' || input.lpStatus === 'locked';
  const lpTeam = input.lpStatus === 'team_controlled';
  const lpUnverified = input.lpStatus === 'partial' || input.lpStatus === 'no_pool' || input.lpStatus === 'insufficient_data' || input.lpStatus === 'error';
  const lpProtocol = input.lpStatus === 'protocol' || input.lpStatus === 'concentrated_liquidity';

  if (lpTeam) {
    score += 25;
    missingChecks.push('LP lock or burn proof not confirmed — controller unverified');
    confirmedDataPoints++;
  } else if (lpUnverified) {
    score += 15;
    missingChecks.push('LP Control inferred — lock or burn proof not confirmed');
  } else if (lpSafe) {
    if (input.lpConfidence === 'high') score -= 10;
    confirmedDataPoints++;
  } else if (lpProtocol) {
    missingChecks.push('LP Control uses protocol liquidity — requires protocol-specific verification');
    confirmedDataPoints++;
  }

  // ── Risk Checks (honeypot / tax) ───────────────────────────────────────────
  if (input.isHoneypot === true) {
    score += 30;
    drivers.push('Honeypot detected — sell simulation blocked');
    confirmedDataPoints++;
  } else if (input.isHoneypot === false) {
    confirmedDataPoints++;
  }
  if (input.simulationSuccess === false) {
    missingChecks.push('Risk Checks simulation not performed — tax and honeypot status inferred');
  }

  const maxTax = Math.max(input.buyTax ?? 0, input.sellTax ?? 0);
  if (maxTax >= 20) {
    score += 20;
    drivers.push(`Very high taxes — buy ${input.buyTax?.toFixed(1) ?? '?'}% / sell ${input.sellTax?.toFixed(1) ?? '?'}%`);
  } else if (maxTax >= 10) {
    score += 10;
    drivers.push(`Elevated taxes — buy ${input.buyTax?.toFixed(1) ?? '?'}% / sell ${input.sellTax?.toFixed(1) ?? '?'}%`);
  }

  // ── Missing checks penalty ─────────────────────────────────────────────────
  score += Math.min(missingChecks.length * 5, 20);

  // ── Clamp ──────────────────────────────────────────────────────────────────
  score = Math.min(100, Math.max(0, Math.round(score)));

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidence: 'high' | 'medium' | 'low' =
    confirmedDataPoints >= 4 ? 'high' :
    confirmedDataPoints >= 2 ? 'medium' : 'low';

  // ── Level ─────────────────────────────────────────────────────────────────
  let rugRiskScore: number | null = score;
  let rugRiskLevel: RiskEngineResult['rugRiskLevel'];
  const coreDataMissing = input.liquidityUsd == null && holderUnavailable && input.simulationSuccess == null && lpUnverified;
  if (confirmedDataPoints === 0 || (confidence === 'low' && coreDataMissing)) {
    rugRiskLevel = 'partial_data';
    rugRiskScore = 50; // conservative baseline when blind
  } else if (score <= 30) {
    rugRiskLevel = 'low';
  } else if (score <= 60) {
    rugRiskLevel = 'medium';
  } else if (score <= 80) {
    rugRiskLevel = 'high';
  } else {
    rugRiskLevel = 'critical';
  }

  // ── Sniper Activity V1 ───────────────────────────────────────────────────
  const sniperReasons: string[] = [];
  let sniperSignalCount = 0;
  let pairAgeMs: number | null = null;
  if (input.pairCreatedAt) {
    try { pairAgeMs = Date.now() - new Date(input.pairCreatedAt).getTime() } catch {}
  }
  const pairAgeHours = pairAgeMs != null ? pairAgeMs / 3_600_000 : null;
  const pairAgeDays = pairAgeMs != null ? pairAgeMs / 86_400_000 : null;

  if (pairAgeHours != null && pairAgeHours < 24) {
    sniperReasons.push(`Pool is very new — launched ${pairAgeHours < 1 ? '<1h' : `~${Math.floor(pairAgeHours)}h`} ago`);
    sniperSignalCount += 2;
  } else if (pairAgeDays != null && pairAgeDays < 7) {
    sniperReasons.push(`Pool launched ${Math.floor(pairAgeDays)}d ago — early phase`);
    sniperSignalCount++;
  }
  if (input.top1 != null && input.top1 > 20 && pairAgeDays != null && pairAgeDays < 14) {
    sniperReasons.push(`Top wallet holds ${input.top1.toFixed(1)}% — early accumulation pattern`);
    sniperSignalCount++;
  }
  if (input.top5 != null && input.top5 > 40 && pairAgeDays != null && pairAgeDays < 14) {
    sniperReasons.push(`Top 5 wallets hold ${input.top5.toFixed(1)}% — concentrated early ownership`);
    sniperSignalCount++;
  }
  if (input.holderCount != null && input.holderCount < 50 && pairAgeDays != null && pairAgeDays < 7) {
    sniperReasons.push(`Very few holders (${input.holderCount}) — entry is highly concentrated`);
    sniperSignalCount++;
  }
  if (input.buys24h != null && input.buys24h > 500 && pairAgeHours != null && pairAgeHours < 6) {
    sniperReasons.push(`${input.buys24h} buys in first hours — abnormal early buy pressure`);
    sniperSignalCount++;
  }

  let sniperStatus: RiskEngineResult['sniperActivity']['status'];
  let sniperConfidence: RiskEngineResult['sniperActivity']['confidence'];
  if (pairAgeHours == null && input.holderStatus !== 'ok') {
    sniperStatus = 'not_applicable';
    sniperConfidence = 'low';
    if (sniperReasons.length === 0) sniperReasons.push('Early wallet activity check deferred — pool age and holder data not yet indexed; verify on-chain directly.');
  } else if (sniperSignalCount >= 3) {
    sniperStatus = 'high';
    sniperConfidence = 'high';
  } else if (sniperSignalCount >= 1) {
    sniperStatus = 'watch';
    sniperConfidence = 'medium';
  } else {
    sniperStatus = 'low_signal';
    sniperConfidence = pairAgeHours != null ? 'medium' : 'low';
    if (sniperReasons.length === 0) sniperReasons.push('No strong early wallet concentration signals detected this scan');
  }

  return {
    rugRiskScore,
    rugRiskLevel,
    confidence,
    drivers: drivers.slice(0, 5),
    missingChecks: missingChecks.slice(0, 6),
    sniperActivity: { status: sniperStatus, confidence: sniperConfidence, reasons: sniperReasons.slice(0, 4) },
  };
}

function _buildDeterministicSummary(
  chainName: string,
  noActivePools: boolean,
  hpResult: { ok: boolean | null; honeypot?: boolean | null; buyTax?: number | null; sellTax?: number | null; simulationSuccess?: boolean | null },
  analysis: { suspiciousFunctions: string[] },
  holderDataComplete: boolean,
  holderCount: number | null,
  top10Pct: number | null,
  ownerStatus: string,
  lpPoolType: string | null | undefined,
  lpControlStatus?: string | null
): string {
  const confirmed: string[] = []
  const risks: string[] = []
  const inferred: string[] = []

  if (noActivePools) {
    risks.push(`no active trading pools found on ${chainName} — token is illiquid or inactive`)
  }
  if (hpResult.ok) {
    if (hpResult.honeypot) {
      risks.push('honeypot simulation triggered — sell transactions blocked')
    } else {
      const taxNote = (hpResult.buyTax != null && hpResult.sellTax != null)
        ? `buy tax ${hpResult.buyTax}%, sell tax ${hpResult.sellTax}%`
        : null
      confirmed.push(`Trading simulation passed${taxNote ? ` (${taxNote})` : ''}.`)
    }
  } else {
    inferred.push('trading simulation not confirmed — verify buy/sell path and tax behavior before relying on this scan')
  }
  if (analysis.suspiciousFunctions.length > 0) {
    risks.push(`bytecode contains suspicious selectors: ${analysis.suspiciousFunctions.slice(0, 3).join(', ')}`)
  }
  if (holderDataComplete && top10Pct != null) {
    const countNote = holderCount != null ? ` across ${holderCount.toLocaleString()} holders` : ''
    if (top10Pct > 70) risks.push(`top-10 holder concentration is very high (${top10Pct.toFixed(1)}%${countNote}) — strong centralization risk`)
    else if (top10Pct > 50) risks.push(`top-10 holder concentration is elevated (${top10Pct.toFixed(1)}%${countNote}) — monitor for large dump risk`)
    else confirmed.push(`Holder distribution verified: top-10 at ${top10Pct.toFixed(1)}%${countNote}.`)
  } else {
    inferred.push('holder concentration inferred as moderate-to-high — cross-check top wallets before sizing a position')
  }
  if (ownerStatus === 'renounced') {
    confirmed.push('Ownership is renounced — verified zero address.')
  } else if (ownerStatus === 'held') {
    risks.push('contract ownership is active — owner retains admin control')
  } else {
    inferred.push('ownership status is an open check — not verified on-chain')
  }
  if (lpControlStatus === 'team_controlled') {
    risks.push('LP is team-controlled — liquidity can be removed at any time without warning')
  } else if (lpControlStatus === 'burned') {
    confirmed.push('LP is burned — liquidity is permanently locked.')
  } else if (lpControlStatus === 'locked') {
    confirmed.push('LP is locked via a time-lock contract.')
  } else if (!lpPoolType || lpPoolType === 'unknown') {
    inferred.push('LP lock status inferred as partial — assume exit liquidity risk until burn or locker address is confirmed')
  }

  const summary: string[] = []
  if (risks.length > 0) summary.push(`Risk flags on ${chainName}: ${risks.join('; ')}.`)
  if (confirmed.length > 0) summary.push(...confirmed)
  if (inferred.length > 0) summary.push(`Inferred from context: ${inferred.join('; ')}.`)
  if (summary.length === 0) summary.push(`No confirmed risk signals on ${chainName}. All modules operating on inferred values — cross-check on-chain before interacting.`)
  return summary.join(' ')
}

// ------------------------------
// POST handler
// ------------------------------
export async function POST(req: Request) {
  if (!(await checkRate(req))) return NextResponse.json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })

  // Hoisted outside the main try block so the fatal-error handler can still
  // report accurate resolver diagnostics for address-based scans.
  let _diagOriginalInput = ''
  let _diagIsAddressInput = false
  let _diagSelectedChain: ChainKey = 'base'
  let _diagDebugMode = false
  let _diagResolvedAddress: string | null = null
  // Coarse stage tracker so a fatal error mid-pipeline can report exactly
  // where it happened (debug-only, never shown in public UI).
  let _scanStage = 'init'
  let _diagMarketAttempted = false
  let _diagPoolAttempted = false
  let _diagFallbackAttempted = false
  let _diagPoolCount = 0
  let _diagMetadataResolved = false

  try {
    const _t0 = Date.now()

    const body = await req.json();
    const { contract: contractInput, debugHolder, debug: debugMode, forceDexFallback: _forceDexFallback, mode: scanMode } = body;
    const isClarkFastMode = scanMode === 'clark_fast';
    const rawChain = String(body.chain ?? 'base').toLowerCase()
    if (rawChain !== 'base' && rawChain !== 'eth') {
      return NextResponse.json({ error: 'Unsupported chain. Use chain=base or chain=eth.' }, { status: 400 })
    }
    let chain: ChainKey = rawChain as ChainKey
    const forceDexFallback = debugMode === true && _forceDexFallback === true
    const originalInput = String(contractInput ?? '').trim()
    const normalizedInput = originalInput.toUpperCase()
    const isAddressInput = /^0x[a-fA-F0-9]{40}$/.test(originalInput)
    _diagOriginalInput = originalInput
    _diagIsAddressInput = isAddressInput
    _diagSelectedChain = chain
    _diagDebugMode = debugMode === true
    const aliasHit = !isAddressInput && chain === 'base' ? BASE_TOKEN_ALIAS_MAP[normalizedInput] : null
    const resolvedAddress = isAddressInput ? originalInput : (aliasHit?.address ?? null)
    const resolvedInput = resolvedAddress ? {
      original: originalInput,
      type: (isAddressInput ? 'address' : 'alias') as 'address' | 'alias' | 'live_search',
      resolvedAddress,
      requestedChain: rawChain as ChainKey,
      symbol: aliasHit?.symbol,
      confidence: (isAddressInput ? 'high' : 'high') as 'high' | 'medium' | 'low',
    } : null
    const cacheKey = JSON.stringify({ contract: String(resolvedAddress ?? '').toLowerCase(), chain, _cv: 10, noCache: true })

    // Detect near-valid hex strings (0x prefix but wrong char count) and return a helpful error
    if (!resolvedAddress && /^0x[a-fA-F0-9]+$/i.test(originalInput) && originalInput.length !== 42) {
      return NextResponse.json({
        status: 'invalid_address',
        error: 'Invalid contract address.',
        ...(debugMode === true ? {
          _diagnostics: {
            originalInput,
            selectedChain: chain,
            detectedInputType: 'address_like',
            addressValid: false,
            resolverStageFailed: 'address_format_check',
            resolverFailureReason: `expected 0x + 40 hex chars, got ${originalInput.length - 2}`,
            fallbackAttempted: false,
          },
        } : {}),
      }, { status: 400 })
    }

    if (!resolvedAddress) {
      return NextResponse.json({
        status: 'not_found',
        error: "Couldn't resolve that token. Paste the contract address or try a verified symbol.",
        ...(debugMode === true ? {
          _diagnostics: {
            resolverInput: originalInput, resolverType: 'none', resolverCandidatesCount: 0, resolverSelectedAddress: null, resolverReason: 'not_in_alias_map',
            originalInput,
            selectedChain: chain,
            detectedInputType: isAddressInput ? 'address' : 'symbol_or_alias',
            addressValid: isAddressInput,
            resolverStageFailed: 'alias_lookup',
            resolverFailureReason: 'not_in_alias_map',
            fallbackAttempted: false,
          },
          _debug: {
            resolverStatus: 'not_found',
            resolverDiagnostics: { original: originalInput, type: 'none', resolvedAddress: null, confidence: 'none', reason: 'not_in_alias_map' },
            normalizedPools: [],
            lpDiagnostics: { poolDetected: false, primaryMarketSelected: false, lpVerificationPoolSelected: false, v2PoolCandidatesCount: 0, protocolPoolCandidatesCount: 0, proofStatus: 'no_pool', lpProofSkipReason: null, lpProofAttempted: false },
          },
        } : {}),
      }, { status: 404 })
    }
    const contract = resolvedAddress
    _diagResolvedAddress = contract
    _scanStage = 'chain_detection'
    // Chain auto-detection for address inputs: if selected chain has no pools,
    // try the opposite chain before continuing full scan.
    // The result is cached in `_earlyGtData` and reused for the main pools fetch below
    // instead of being requested a second time — GeckoTerminal's public API is rate-limited,
    // and re-requesting the same contract+chain pools twice per scan was silently starving
    // well-known/high-traffic tokens of pool data whenever the second request got rate-limited
    // (fetchGeckoTerminal swallows non-2xx responses and returns null, which downstream reads
    // as "no pools" — the token then reports name: Unknown / poolCount: 0 / noActivePools: true).
    let _earlyGtData: any = null
    if (isAddressInput) {
      _diagPoolAttempted = true
      const selectedPools = await fetchGeckoTerminal(contract, chain)
      const selectedCount = Array.isArray(selectedPools?.data) ? selectedPools.data.length : 0
      _diagPoolCount = selectedCount
      _earlyGtData = selectedPools
      if (selectedCount === 0) {
        const altChain: ChainKey = chain === 'eth' ? 'base' : 'eth'
        const altPools = await fetchGeckoTerminal(contract, altChain)
        const altCount = Array.isArray(altPools?.data) ? altPools.data.length : 0
        if (altCount > 0) {
          chain = altChain
          _diagPoolCount = altCount
          _earlyGtData = altPools
        }
      }
    }
    _diagSelectedChain = chain
    if (resolvedInput) {
      resolvedInput.requestedChain = chain
    }

    // ── Clark fast mode: lightweight, cache-friendly evidence pass ──
    // Skips slow holders/deep-LP/dev-enrichment providers used by the full
    // Token Scanner pipeline below. Does not alter normal scan behavior —
    // this branch only runs when mode === 'clark_fast' is explicitly sent.
    if (isClarkFastMode) {
      const _fastT0 = Date.now()
      const [gtDataFast, gtTokenInfoFast, simResultFast] = await Promise.all([
        fetchGeckoTerminal(contract, chain).catch(() => null),
        fetchGeckoTerminalToken(contract, chain).catch(() => null),
        resolveSimulation(chain, contract).catch(() => null),
      ])
      const poolsFast: any[] = Array.isArray(gtDataFast?.data) ? gtDataFast.data : []
      const mainPoolFast = [...poolsFast].sort((a, b) => {
        const liqDiff = parseFloat(b.attributes?.reserve_in_usd || "0") - parseFloat(a.attributes?.reserve_in_usd || "0")
        if (liqDiff !== 0) return liqDiff
        return String(a.id ?? "").localeCompare(String(b.id ?? ""))
      })[0]
      const poolAttrFast = mainPoolFast?.attributes ?? {}
      const gtTokenFast = gtTokenInfoFast?.data?.attributes ?? null
      const priceUsdFast = pickNum(poolAttrFast.base_token_price_usd, gtTokenFast?.price_usd, gtTokenFast?.price)
      const liquidityUsdFast = pickNum(poolAttrFast.reserve_in_usd, poolAttrFast.liquidity_usd, poolAttrFast.reserve_usd)
      const volume24hUsdFast = pickNum((poolAttrFast.volume_usd as Record<string, unknown> | undefined)?.h24)
      const marketCapUsdFast = pickNum(gtTokenFast?.market_cap_usd, gtTokenFast?.market_cap, gtTokenFast?.marketCap)
      const nameFast = (gtTokenFast?.name as string | undefined) ?? aliasHit?.symbol ?? null
      const symbolFast = (gtTokenFast?.symbol as string | undefined) ?? aliasHit?.symbol ?? null
      const hasMarketFast = priceUsdFast != null || liquidityUsdFast != null
      const fastPayload: Record<string, unknown> = {
        status: hasMarketFast ? 'ok' : 'no_pool_data',
        mode: 'clark_fast',
        contract,
        chain,
        name: nameFast,
        symbol: symbolFast,
        priceUsd: priceUsdFast,
        liquidityUsd: liquidityUsdFast,
        volume24hUsd: volume24hUsdFast,
        marketCapUsd: marketCapUsdFast,
        security: {
          simulation: {
            honeypot: simResultFast?.honeypot ?? null,
            buyTax: simResultFast?.buyTax ?? null,
            sellTax: simResultFast?.sellTax ?? null,
            transferTax: simResultFast?.transferTax ?? null,
            simulationSuccess: simResultFast?.simulationSuccess ?? null,
          },
        },
        lpControl: { status: 'open_check', reason: 'LP lock/burn proof not run in Clark fast mode — open full Token Scanner for full LP verification.', confidence: 'open_check', poolType: null },
        holderDistribution: null,
        sections: {
          market: { status: hasMarketFast ? 'ok' : 'unavailable', reason: hasMarketFast ? null : 'No active pool data found in fast mode.' },
          security: { status: simResultFast ? 'ok' : 'pending', reason: simResultFast ? null : 'Security simulation unavailable in fast mode.' },
          holders: { status: 'open_check', reason: 'Holder scan not run in Clark fast mode.' },
          liquidity: { status: 'open_check', reason: 'Full LP proof not run in Clark fast mode.' },
        },
      }
      if (debugMode === true || process.env.NODE_ENV !== 'production') {
        ;(fastPayload as any).tokenRouteDebug = {
          routeReached: true,
          mode: 'clark_fast',
          method: 'POST',
          contract,
          chain,
          stagesStarted: ['market', 'security'],
          stagesCompleted: [hasMarketFast ? 'market' : null, simResultFast ? 'security' : null].filter(Boolean),
          stagesSkipped: ['holders', 'lp', 'dev_enrichment'],
          totalMs: Date.now() - _fastT0,
        }
      }
      return NextResponse.json(fastPayload, { status: 200 })
    }

    console.log("Incoming scan request:", contract);

    // ETH + BASE are the only chains with full provider support.
    // GoldRush, Moralis, Alchemy RPC, and DexScreener are gated to these chains.
    const SUPPORTED_FULL_SCAN_CHAINS: ChainKey[] = ['eth', 'base']
    const isFullScanChain = SUPPORTED_FULL_SCAN_CHAINS.includes(chain)
    const rpcHealth = isFullScanChain ? await checkRpcHealth(chain) : { ok: false, providerUrl: null, reason: 'chain_not_supported' as string | null }
    const alchemyConfigured = isFullScanChain && rpcHealth.ok
    const goldrushEnabled = isFullScanChain && Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY)
    const moralisEnabled = isFullScanChain && Boolean(process.env.MORALIS_API_KEY)
    const ownerSelectors = ['0x8da5cb5b', '0x893d20e8', '0xf851a440', '0x245a7bfc', '0x5c60da1b']
    let rpcCallsAttempted = 0
    let rpcCallsSucceeded = 0
    let rpcCallsFailed = 0
    const rpcCheckDiagnostics: Array<{ checkName: string; method: string; attempted: boolean; succeeded: boolean; critical: boolean; failureStage: string | null; safeReasonCode: string | null; durationMs: number | null }> = []
    const countedRpcCall = async (method: string, params: unknown[], checkName = "rpcCheck", critical = false) => {
      const t0 = Date.now()
      rpcCallsAttempted += 1
      const out = await rpcCall(chain, method, params)
      if (out) {
        rpcCallsSucceeded += 1
      } else {
        rpcCallsFailed += 1
      }
      if (debugMode) {
        rpcCheckDiagnostics.push({
          checkName,
          method,
          attempted: true,
          succeeded: Boolean(out),
          critical,
          failureStage: out ? null : 'rpc_call',
          safeReasonCode: out
            ? null
            : (!alchemyConfigured
              ? 'missing_env'
              : (checkName === 'ownerCheck' ? 'owner_not_exposed' : 'invalid_contract_response')),
          durationMs: Date.now() - t0,
        })
      }
      return out
    }

    _scanStage = 'phase1_provider_fetch'
    _diagMarketAttempted = true
    const bytecodePromise = (async () => {
      const t0 = Date.now()
      const out = await fetchBytecode(chain, contract)
      if (debugMode) {
        rpcCheckDiagnostics.push({
          checkName: 'bytecodeCheck',
          method: 'eth_getCode',
          attempted: alchemyConfigured,
          succeeded: Boolean(out),
          critical: true,
          failureStage: out ? null : (alchemyConfigured ? 'rpc_call' : 'preflight'),
          safeReasonCode: out ? null : (alchemyConfigured ? 'rpc_failed' : 'missing_env'),
          durationMs: Date.now() - t0,
        })
      }
      return out
    })()
    const [bytecode, goldrush, holdersRaw, gtData, gtTokenInfo, gmgn, metadata, _simResult, coingeckoRaw, moralisHoldersRaw, moralisTransfersRaw, dexFbEarly, grContractIntel] = await Promise.all([
      bytecodePromise,
      // GoldRush: ETH + BASE only (metadata token info)
      isFullScanChain ? fetchGoldRush(chain, contract) : Promise.resolve(null),
      // GoldRush holders: ETH + BASE only (LP Safety + holder distribution)
      goldrushEnabled ? fetchTokenHolders(chain, contract) : Promise.resolve({ __status: 'not_configured', __reason: 'chain_not_supported' }),
      _earlyGtData != null ? Promise.resolve(_earlyGtData) : fetchGeckoTerminal(contract, chain),
      fetchGeckoTerminalToken(contract, chain),
      fetchGMGN(contract),
      fetchTokenMetadata(chain, contract),
      // resolveSimulation: wraps fetchHoneypotSecurity — null on provider failure
      resolveSimulation(chain, contract),
      fetchCoinGeckoToken(chain, contract),
      // Moralis: ETH + BASE only (full holder list)
      moralisEnabled ? fetchMoralisHolders(chain, contract) : Promise.resolve({ __status: 'not_configured', __reason: 'chain_not_supported' }),
      moralisEnabled ? fetchMoralisTransfers(chain, contract) : Promise.resolve({ __status: 'not_configured', __reason: 'chain_not_supported' }),
      isFullScanChain ? fetchDexScreenerFallback(contract, chain) : Promise.resolve(null),
      // GoldRush Contract Intel: ETH + BASE only — ABI scan for mint, blacklist, pause, withdraw, proxy
      goldrushEnabled ? fetchGoldRushContractIntel(chain, contract) : Promise.resolve(null),
    ]);
    // Compatibility wrapper: adapts resolveSimulation result to hpResult shape used throughout
    const hpResult = {
      ok: _simResult != null,
      honeypot: _simResult?.honeypot ?? null,
      honeypotStatus: _simResult?.honeypotStatus ?? 'unavailable' as const,
      honeypotReason: _simResult?.honeypotReason ?? null,
      buyTax: _simResult?.buyTax ?? null,
      sellTax: _simResult?.sellTax ?? null,
      transferTax: _simResult?.transferTax ?? null,
      simulationSuccess: _simResult?.simulationSuccess ?? null,
      honeypotProvider: _simResult != null ? 'ok' as const : 'partial' as const,
    };
    const alchemyMandatoryReads = await Promise.all([
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[0] }, 'latest'], 'ownerCheck.owner', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[1] }, 'latest'], 'ownerCheck.getOwner', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[2] }, 'latest'], 'ownerCheck.admin', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[3] }, 'latest'], 'ownerCheck.proxyAdmin', false),
      countedRpcCall('eth_call', [{ to: contract, data: ownerSelectors[4] }, 'latest'], 'ownerCheck.implementation', false),
      countedRpcCall('eth_call', [{ to: contract, data: '0x18160ddd' }, 'latest'], 'totalSupplyCheck.mandatory', true),
    ])
    if (process.env.NODE_ENV === 'development') console.log('[token-timing] phase1Ms', Date.now() - _t0)
    _diagMetadataResolved = Boolean(metadata) || Boolean(goldrush) || Boolean(gtTokenInfo)
    _diagFallbackAttempted = Boolean(dexFbEarly)
    _scanStage = 'phase1_analysis'

    const analysis = analyzeContract(bytecode);

    // GeckoTerminal /tokens/{contract}/pools returns pools for this token directly
    const gtAllPools: any[] = Array.isArray(gtData?.data) ? gtData.data : [];
    const gtIncluded: unknown[] = Array.isArray(gtData?.included) ? gtData.included : [];

    // Sort by liquidity descending — market primary is deepest pool. Tie-break on pool id so
    // primary-pool selection is deterministic regardless of the order the provider returns
    // pools in (avoids score/category drift across identical-evidence scans).
    const matchingPools = [...gtAllPools].sort((a, b) => {
      const liqDiff = parseFloat(b.attributes?.reserve_in_usd || "0") - parseFloat(a.attributes?.reserve_in_usd || "0")
      if (liqDiff !== 0) return liqDiff
      return String(a.id ?? "").localeCompare(String(b.id ?? ""))
    });

    const mainPool = matchingPools[0] ?? null;
    const includedTokenById = new Map<string, Record<string, unknown>>();
    for (const inc of gtIncluded as Array<Record<string, unknown>>) {
      if (inc?.type !== "token") continue;
      const id = String(inc.id ?? "");
      const attrs = (inc.attributes ?? {}) as Record<string, unknown>;
      if (id) includedTokenById.set(id, attrs);
    }
    const normalizedPools = matchingPools.map((p) => normalizePool(p, includedTokenById));
    // When GeckoTerminal has no pool data, synthesize a pool from DexScreener pair address
    // so LP verification (burn/lock/team checks) can still be attempted.
    let _dsFbPoolSynthesized = false
    // Pool detected from market fallback, but pool contract address not verified — set when the
    // fallback pair identifier exists but isn't a standard 20-byte EVM contract address (e.g. a
    // Uniswap V3/V4 64-char pool ID). Surfaced to callers instead of silently dropping the pool.
    let _dsFbPoolCandidateRejectionReason: string | null = null
    const _dsFbPairIdRaw = typeof dexFbEarly?.pairAddress === 'string' ? dexFbEarly.pairAddress.trim().toLowerCase() : null
    const _dsFbPairIsContractAddress = Boolean(_dsFbPairIdRaw && /^0x[a-f0-9]{40}$/.test(_dsFbPairIdRaw))
    const _dsFbPairIsPoolId = Boolean(_dsFbPairIdRaw && !_dsFbPairIsContractAddress && /^0x[a-f0-9]{64}$/.test(_dsFbPairIdRaw))
    if (normalizedPools.length === 0 && _dsFbPairIdRaw && (_dsFbPairIsContractAddress || _dsFbPairIsPoolId)) {
      const _dsFbDexId = dexFbEarly!.dexId ?? null
      let _dsFbType = detectPoolType(null, _dsFbDexId ?? undefined)
      // A 64-char fallback pair identifier is a bytes32 pool ID (Uniswap V3/V4 style), never a
      // contract address — it has no ERC-20 LP token, so the pool model is concentrated unless
      // dex metadata says otherwise.
      if (_dsFbPairIsPoolId && _dsFbType === 'unknown') _dsFbType = 'concentrated'
      normalizedPools.push({
        address: _dsFbPairIsContractAddress ? _dsFbPairIdRaw : null,
        poolId: _dsFbPairIsPoolId ? _dsFbPairIdRaw : null,
        poolAddressType: _dsFbPairIsContractAddress ? 'contract' : (_dsFbPairIsPoolId ? 'pool_id' : 'unknown'),
        pairName: [dexFbEarly!.baseToken?.symbol, dexFbEarly!.quoteToken?.symbol].filter(Boolean).join('/') || null,
        liquidityUsd: dexFbEarly!.liquidityUsd ?? 0,
        dexId: _dsFbDexId,
        dexName: normalizeDexLabel(_dsFbDexId) || null,
        baseTokenSymbol: dexFbEarly!.baseToken?.symbol ?? null,
        quoteTokenSymbol: dexFbEarly!.quoteToken?.symbol ?? null,
        baseTokenAddress: dexFbEarly!.baseToken?.address?.toLowerCase() ?? null,
        quoteTokenAddress: dexFbEarly!.quoteToken?.address?.toLowerCase() ?? null,
        poolType: _dsFbType,
        hasLpToken: (() => {
          // "aerodrome" now means Aerodrome V2 (volatile/stable) — ERC-20 LP token confirmed.
          if (_dsFbType === 'v2' || _dsFbType === 'aerodrome') return true
          if (_dsFbType === 'v3' || _dsFbType === 'concentrated') return false
          // On Base, DexScreener may label V2 pools as unknown/v3 — detect by dexId
          if (chain === 'base' && _dsFbDexId) {
            const dxLc = _dsFbDexId.toLowerCase()
            if (/v2|baseswap|alienbase|swapbased|sushiswap|shibaswap/.test(dxLc) && !/v3|v4|concentrated|slipstream|aerodrome/.test(dxLc)) return true
          }
          return null
        })(),
        hasDexMeta: Boolean(_dsFbDexId),
        isValidAddress: _dsFbPairIsContractAddress,
      })
      _dsFbPoolSynthesized = true
      if (!_dsFbPairIsContractAddress) {
        _dsFbPoolCandidateRejectionReason = "Pool detected from market fallback, but pool contract address not verified."
      }
    }
    // Market-fallback liquidity evidence: the secondary market read proved liquidity/volume
    // exists for this token even if no canonical on-chain pool could be selected. When this is
    // true the token is NEVER reported as no_pool — at worst the pool model is an open check.
    const _fallbackLiquidityDetected = Boolean(
      dexFbEarly && ((dexFbEarly.liquidityUsd ?? 0) > 0 || (dexFbEarly.volume24h ?? 0) > 0 ||
        (typeof dexFbEarly.pairAddress === 'string' && /^0x[a-f0-9]{40}$/i.test(dexFbEarly.pairAddress)))
    )
    // RPC-classify a synthesized fallback pool whose model is still unknown, using the existing
    // Base/ETH RPC path (no new providers). Confirms V2/ERC-20 LP vs concentrated so the model is
    // not left as a generic open check when on-chain data can resolve it.
    let _fallbackRpcModel: 'v2' | 'concentrated' | 'unknown' | null = null
    if (_dsFbPoolSynthesized && (chain === 'eth' || chain === 'base')) {
      const _synthPool = normalizedPools[0]
      if (_synthPool && _synthPool.poolType === 'unknown' && _synthPool.address && /^0x[a-f0-9]{40}$/.test(_synthPool.address)) {
        const _rpcCls = await classifyPoolByRpc(chain, _synthPool.address)
        _fallbackRpcModel = _rpcCls.poolType
        if (_rpcCls.poolType !== 'unknown') {
          _synthPool.poolType = _rpcCls.poolType
          _synthPool.hasLpToken = _rpcCls.hasLpToken
        } else if (_synthPool.hasLpToken == null) {
          _synthPool.hasLpToken = _rpcCls.hasLpToken
        }
      }
    }
    const selectedLpPool = selectLpVerificationPool(normalizedPools, String(contract));
    // Use normalizedPools (post-DS-fallback-synthesis) so noActivePools is false
    // when a DexScreener fallback pool was successfully synthesized. Fallback liquidity
    // evidence alone (even without a usable pair address) also clears noActivePools.
    const noActivePools = normalizedPools.length === 0 && !_fallbackLiquidityDetected;
    const mainPoolAttr = (mainPool?.attributes ?? {}) as Record<string, unknown>;
    const { address: primaryPoolAddress, poolId: primaryMarketPoolId, poolAddressType: primaryMarketPoolAddressType } = extractPoolAddressOrId(mainPool?.id, mainPoolAttr.address)
    // Canonical primary pool for both Liquidity&Pools and LP Control:
    // use the highest-liquidity normalized pool first (same ordering as matchingPools/mainPool),
    // then fall back to LP verification selector if needed.
    const canonicalPrimaryPool = normalizedPools[0] ?? null
    const canonicalPrimaryUsable = Boolean(
      canonicalPrimaryPool &&
      (canonicalPrimaryPool.isValidAddress || canonicalPrimaryPool.poolId) &&
      (canonicalPrimaryPool.liquidityUsd ?? 0) > 0
    )
    const lpPool = canonicalPrimaryUsable ? canonicalPrimaryPool : selectedLpPool.pool;
    let lpPoolType: NormalizedPool['poolType'] | "unknown" = lpPool?.poolType ?? "unknown";
    // Canonical pool identity (cross-scan stability): a pool address previously classified
    // concentrated (from richer primary-market/RPC evidence) must never be downgraded to
    // constant_product just because a later scan only has generic fallback market data for
    // the same address. mergeCanonicalPoolIdentity() never lets a less-specific read win —
    // see lib/server/lpProof.ts. This never adds a provider call: it only reconciles data
    // already resolved above.
    const _canonicalPoolAddressForIdentity = lpPool?.address ?? primaryPoolAddress ?? null
    const canonicalPoolIdentity = _canonicalPoolAddressForIdentity
      ? reconcileCanonicalPoolIdentity(buildCanonicalPoolIdentity({
          poolAddress: _canonicalPoolAddressForIdentity,
          poolId: lpPool?.poolId ?? primaryMarketPoolId ?? null,
          pair: lpPool?.pairName ?? null,
          dexId: lpPool?.dexId ?? null,
          dexName: lpPool?.dexName ?? null,
          source: canonicalPrimaryUsable ? "primary_market" : "fallback_market",
          rpcConfirmedModel: lpPoolType === "v2" ? "v2" : (lpPoolType === "v3" || lpPoolType === "concentrated") ? "concentrated" : null,
        }))
      : null
    if (canonicalPoolIdentity?.model === "concentrated" && lpPoolType !== "v3" && lpPoolType !== "concentrated") {
      lpPoolType = "concentrated"
    }
    // Canonical LP proof target: the PRIMARY/highest-liquidity pool (lpPool) is the single
    // source of truth for whether standard ERC-20 LP lock/burn proof applies (selection
    // rules 1/2). If it's concentrated/CLMM/V3, standard proof never applies to it —
    // any V2/Aerodrome pool found elsewhere is at most a SECONDARY signal (rule 3/4).
    const _primaryConcentrated = lpPoolType === "v3" || lpPoolType === "concentrated";
    // lpVerifyPool: the pool used for burn/lock/team-controller LP-holder proof of the
    // PRIMARY market pool (lpPool). It must describe the SAME token pair as lpPool — a
    // different-pair V2/Aerodrome pool (e.g. GAME/VIRTUAL or TIBBIR/VIRTUAL when scanning
    // VIRTUAL) must never become the verification pool for THIS token's primary
    // lpControl/lpControllerIntel/riskBreakdown.liquiditySafety, even if it has higher
    // liquidity than lpPool (selection rules 1-3). If lpPool itself is a V2/Aerodrome/
    // constant-product pool with a valid address, verify it directly.
    const _isV2Verifiable = (p: NormalizedPool) =>
      (p.poolType === 'v2' || p.poolType === 'unknown' || p.poolType === 'aerodrome' || p.hasLpToken === true) &&
      p.isValidAddress && Boolean(p.address)
    // Same-pair check: does this pool cover the same two tokens as the canonical primary
    // pool (lpPool), regardless of base/quote ordering?
    const _samePairAsPrimary = (p: NormalizedPool): boolean => {
      if (!lpPool) return false
      const a = [lpPool.baseTokenAddress, lpPool.quoteTokenAddress].filter(Boolean) as string[]
      const b = [p.baseTokenAddress, p.quoteTokenAddress].filter(Boolean) as string[]
      if (a.length === 0 || b.length === 0 || a.length !== b.length) return false
      return a.every((addr) => b.includes(addr)) && b.every((addr) => a.includes(addr))
    }
    const lpVerifyPool = (lpPool && _isV2Verifiable(lpPool))
      ? lpPool
      : normalizedPools.find((p) => _isV2Verifiable(p) && _samePairAsPrimary(p)) ?? null
    const lpVerifyPoolAddress = lpVerifyPool?.address ?? null
    const lpVerifyPoolType: NormalizedPool['poolType'] = lpVerifyPool?.poolType ?? 'unknown'
    const lpVerifyPoolPresent = Boolean(lpVerifyPoolAddress && /^0x[a-f0-9]{40}$/.test(lpVerifyPoolAddress))
    const _v2PoolCandidates = normalizedPools.filter(_isV2Verifiable)
    const _protocolPoolCandidates = normalizedPools.filter(p => p.poolType === 'v3' || p.poolType === 'concentrated')
    // Different-pair V2/Aerodrome pools (e.g. GAME/VIRTUAL, TIBBIR/VIRTUAL, AIXBT/VIRTUAL) —
    // analyzed only as secondaryLpControlSignals/secondaryLpExposure below (rule 4), never
    // promoted into lpVerifyPool/lpControl for the primary pool (rule 5).
    const secondaryPoolCandidates = normalizedPools.filter((p) =>
      _isV2Verifiable(p) && p.address !== lpVerifyPoolAddress && !_samePairAsPrimary(p))
    const _secondaryPoolAddress = secondaryPoolCandidates[0]?.address ?? null
    const dexId = String(mainPoolAttr.dex_id ?? mainPoolAttr.dex ?? "").trim() || null;
    const dexName = String(mainPoolAttr.dex_name ?? "").trim() || null;
    // Primary pool DEX display name — exhaustive field search across attributes + relationships
    const _extractedDexId = (() => {
      if (!mainPool) return null
      const mp = mainPool as Record<string, unknown>
      const a = (mp.attributes ?? {}) as Record<string, unknown>
      const rel = (mp.relationships ?? {}) as Record<string, unknown>
      // Pool-level and attribute-level fields
      for (const v of [
        mp.dex, mp.dex_id, mp.dexId, mp.exchange, mp.protocol,
        a.dex, a.dex_id, a.dexId, a.exchange, a.protocol,
      ]) {
        if (v && typeof v === 'string' && v.trim()) return v.trim()
      }
      // relationships.dex.data.id (standard JSON:API format)
      const dexRelData = ((rel.dex as Record<string, unknown>)?.data) as Record<string, unknown> | undefined
      if (dexRelData?.id && typeof dexRelData.id === 'string') return String(dexRelData.id).trim()
      // relationships.dexes.data[0].id
      const dexesArr = ((rel.dexes as Record<string, unknown>)?.data) as Array<Record<string, unknown>> | undefined
      if (Array.isArray(dexesArr) && dexesArr[0]?.id) return String(dexesArr[0].id).trim()
      // Hint from pool name or ID
      const nameHint = String(a.name ?? a.pool_name ?? mp.id ?? '').toLowerCase()
      if (/uniswap[\s\-_v]*4/i.test(nameHint)) return 'uniswap-v4'
      if (/uniswap[\s\-_v]*3/i.test(nameHint)) return 'uniswap-v3'
      if (/uniswap[\s\-_v]*2/i.test(nameHint)) return 'uniswap-v2'
      if (/aerodrome/i.test(nameHint)) return 'aerodrome'
      if (/baseswap/i.test(nameHint)) return 'baseswap'
      if (/pancakeswap/i.test(nameHint)) return 'pancakeswap'
      return dexId || dexName || null
    })()
    const primaryDexName = normalizeDexLabel(_extractedDexId) ?? normalizeDexLabel(dexFbEarly?.dexId ?? null)
    const pairName = String(mainPoolAttr.name ?? mainPoolAttr.pool_name ?? mainPoolAttr.pair_name ?? "").trim() || null;
    const selectedPrimaryPoolSource = String(mainPoolAttr.address ?? "").trim() ? "attributes.address" : (String(mainPool?.id ?? "").trim() ? "pool.id_normalized" : "none");
    const poolAddressPresent = Boolean(primaryPoolAddress && /^0x[a-f0-9]{40}$/.test(primaryPoolAddress));
    // Early signals needed for phase 2 setup (computed before full field resolution)
    const _gtEarly = gtTokenInfo?.data?.attributes ?? null
    const _poolAttrEarly = (mainPool?.attributes ?? {}) as Record<string, unknown>
    const _priceEarly = pickNum(_poolAttrEarly.base_token_price_usd, _gtEarly?.price_usd, _gtEarly?.price)
    const _mcEarly = toNum(_gtEarly?.market_cap_usd)
    const _decEarly: number = typeof _gtEarly?.decimals === 'number' ? _gtEarly.decimals : 18
    const _liqEarly = pickNum(mainPool?.attributes?.reserve_in_usd)
    const hasSecurityData = Boolean(hpResult.ok)
    // lpPoolAddress is the market display pool address (used for display/evidence)
    const lpPoolAddress = lpPool?.address ?? null
    // When the canonical pool identity (cross-scan merge) established this address as
    // concentrated but the raw dex id string lacks a concentrated marker (e.g. a fallback
    // scan only saw a generic "aerodrome" string), prefer the canonical protocol variant so
    // lpModelProof/classifyPoolModel downstream agree with the upgraded lpPoolType above.
    const lpDexId = (canonicalPoolIdentity?.model === "concentrated" && lpPool?.dexId == null)
      ? (canonicalPoolIdentity.protocolVariant ?? "concentrated").toLowerCase().replace(/\s+/g, "-")
      : lpPool?.dexId ?? null
    const lpDexName = canonicalPoolIdentity?.protocolVariant ?? lpPool?.dexName ?? null
    // Computed early so the "Normalize split-pool and proof-status fields" block below can use
    // standardLockApplies to keep displayLpModel/proofApplicability consistent with lpModelProof.
    const lpModelProof = _deriveLpModelProof(lpDexId)
    const lpPoolAddressPresent = Boolean(lpPoolAddress && /^0x[a-f0-9]{40}$/.test(lpPoolAddress))
    // For LP proof logic, use lpVerifyPool (V2/unknown) if available, else fall back to lpPool
    const _lpProofAddress = lpVerifyPoolPresent ? lpVerifyPoolAddress : lpPoolAddress
    const _lpProofType = lpVerifyPoolPresent ? lpVerifyPoolType : lpPoolType
    const _lpProofPresent = lpVerifyPoolPresent || lpPoolAddressPresent || Boolean(lpPool?.poolId)
    // Log LP pool selection so production scans self-document the fix
    if (process.env.NODE_ENV === 'development' || process.env.LP_DEBUG === '1') {
      console.log('[lp-pool-select]', JSON.stringify({
        contract, chain,
        gtPoolCount: matchingPools.length,
        mainPoolId: mainPool?.id ?? null,
        mainPoolAttrAddress: (mainPool?.attributes as Record<string,unknown>)?.address ?? null,
        normalizedPoolCount: normalizedPools.length,
        lpPoolAddress, lpPoolType, lpPoolAddressPresent,
        lpVerifyPoolAddress, lpVerifyPoolType, lpVerifyPoolPresent,
        dexscreenerPoolSynthesized: _dsFbPoolSynthesized,
      }))
    }
    // 'aerodrome' poolType now means Aerodrome V2 (volatile/stable) — confirmed ERC-20 LP token,
    // so holder-based lock/burn proof can run just like a standard V2 pool. 'unknown' still
    // attempts the fetch so the RPC probe below can classify it.
    const needsLpHolderFetch = Boolean(_lpProofPresent && (_lpProofType === 'v2' || _lpProofType === 'unknown' || _lpProofType === 'aerodrome'))
    // Always run AI: the prompt handles missing data gracefully and prevents the fallback "insufficient data" message
    const needsAI = true
    const needsOnchainMc = _mcEarly == null && _priceEarly != null

    // ── Phase 1 data extraction for AI summary prompt ──────────────────────────
    // Extract early holder concentration estimate from raw GoldRush data
    const _holderItemsEarly: any[] = holdersRaw?.data?.items ?? holdersRaw?.data?.data?.items ?? holdersRaw?.items ?? []
    const _top1Early = _holderItemsEarly[0]?.percentage ?? _holderItemsEarly[0]?.percent ?? null
    const _top10EarlyPct = _holderItemsEarly.slice(0, 10).reduce((s: number, h: any) => {
      const p = parseFloat(h?.percentage ?? h?.percent ?? 0)
      return s + (Number.isFinite(p) ? p : 0)
    }, 0)
    // Extract early owner status from RPC mandatory reads
    const _ownerHexEarly = alchemyMandatoryReads[0] ?? alchemyMandatoryReads[1] ?? alchemyMandatoryReads[2] ?? null
    const _ownerEarlyAddr = _ownerHexEarly && _ownerHexEarly.length >= 42 ? `0x${_ownerHexEarly.slice(-40).toLowerCase()}` : null
    const _isRenouncedEarly = _ownerEarlyAddr === '0x0000000000000000000000000000000000000000'
    const _ownerStatusEarly = _isRenouncedEarly ? 'renounced' : (_ownerEarlyAddr ? 'held' : 'inferred_active')
    // Build rich AI summary prompt with all Phase 1 signals
    const _aiPrompt = [
      `You are a concise onchain risk analyst. Summarize this ${chain === 'eth' ? 'Ethereum' : 'Base'} token risk in 3-4 sentences. Be specific about detected risks. Plain text only, no markdown, no disclaimers.`,
      `CONTRACT: ${contract} | CHAIN: ${chain === 'eth' ? 'Ethereum' : 'Base'}`,
      `MARKET: price=${_priceEarly != null ? `$${_priceEarly}` : 'unknown'} liquidity=${_liqEarly != null ? `$${(_liqEarly / 1000).toFixed(0)}K` : 'unknown'} pools=${matchingPools.length}`,
      hpResult.ok
        ? `SIMULATION: honeypot=${hpResult.honeypot} buyTax=${hpResult.buyTax ?? '?'}% sellTax=${hpResult.sellTax ?? '?'}%`
        : `SIMULATION: not_performed`,
      analysis.suspiciousFunctions.length > 0
        ? `BYTECODE_FLAGS: ${analysis.suspiciousFunctions.join(', ')}`
        : `BYTECODE: no suspicious functions`,
      grContractIntel?.mint ? `CONTRACT_FLAGS: mint=detected` : null,
      grContractIntel?.blacklist ? `CONTRACT_FLAGS: blacklist=detected` : null,
      (grContractIntel?.proxy || grContractIntel?.upgradeable) ? `CONTRACT_FLAGS: upgradeable=detected` : null,
      grContractIntel?.pause ? `CONTRACT_FLAGS: pause=detected` : null,
      _top10EarlyPct > 0 ? `HOLDERS: top1=${_top1Early != null ? _top1Early.toFixed(1) + '%' : '?'} top10=${_top10EarlyPct.toFixed(1)}% count=${_holderItemsEarly.length > 0 ? _holderItemsEarly.length + '+' : 'unknown'}` : `HOLDERS: not_indexed`,
      `OWNERSHIP: ${_ownerStatusEarly}`,
      `LP_POOL_TYPE: ${_lpProofType ?? lpPoolType ?? 'unknown'}`,
      noActivePools ? 'NO_ACTIVE_POOLS: true — high risk of illiquidity' : null,
      'Lead with the most critical risk. If a key check is not indexed, note it briefly. Be direct.',
    ].filter(Boolean).join('\n')

    // Phase 2: LP holder fetch + AI summary + onchain supply + secondary-pool LP holder fetch
    // (for a different-pair V2/Aerodrome pool, e.g. GAME/VIRTUAL — informational
    // secondaryLpControlSignals/secondaryLpExposure only, see rules 4/5) all in parallel
    _scanStage = 'phase2_lp_holder_fetch'
    const _t2 = Date.now()
    const _needsSecondaryLpHolderFetch = Boolean(needsLpHolderFetch && _secondaryPoolAddress && /^0x[a-f0-9]{40}$/.test(_secondaryPoolAddress))
    const [_lpHoldersSettled, _aiSettled, _onchainSettled, _secondaryLpHoldersSettled] = await Promise.allSettled([
      needsLpHolderFetch
        ? Promise.race([
            fetchTokenHolders(chain, _lpProofAddress!),
            new Promise<Record<string, unknown>>(r =>
              setTimeout(() => r({ __status: 'error', __reason: 'lp_holder_timeout' }), 7000)
            ),
          ])
        : Promise.resolve(null),
      needsAI
        ? Promise.race([
            anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: _aiPrompt }] }),
            new Promise<null>(r => setTimeout(() => r(null), 18000)),
          ])
        : Promise.resolve(null),
      needsOnchainMc ? fetchOnchainSupply(chain, contract) : Promise.resolve(null),
      _needsSecondaryLpHolderFetch
        ? Promise.race([
            fetchTokenHolders(chain, _secondaryPoolAddress!),
            new Promise<Record<string, unknown>>(r =>
              setTimeout(() => r({ __status: 'error', __reason: 'lp_holder_timeout' }), 7000)
            ),
          ])
        : Promise.resolve(null),
    ])
    if (process.env.NODE_ENV === 'development') console.log('[token-timing] phase2Ms', Date.now() - _t2, 'needsLP', needsLpHolderFetch, 'needsAI', needsAI, 'needsOnchain', needsOnchainMc)
    const _secondaryLpHoldersForControl = (_secondaryLpHoldersSettled.status === 'fulfilled' ? _secondaryLpHoldersSettled.value : null) as any

    // Early owner fetch for LP team-wallet check — runs after phase2 to not block parallel work.
    // Only needed when pool is V2-like (burn/locker checks will use it). Fast single RPC call.
    const _ownerHexForLp = (_lpProofPresent && (_lpProofType === 'v2' || _lpProofType === 'unknown' || _lpProofType === 'aerodrome'))
      ? await rpcCall(chain, 'eth_call', [{ to: contract, data: '0x8da5cb5b' }, 'latest']).catch(() => null)
      : null
    const ownerAddrEarlyForLp = _ownerHexForLp && _ownerHexForLp.length >= 42 ? `0x${_ownerHexForLp.slice(-40)}`.toLowerCase() : null

    // LP control using pre-fetched LP holder data (no sequential blocking)
    const _lpHoldersForControl = (_lpHoldersSettled.status === 'fulfilled' ? _lpHoldersSettled.value : { __status: 'error', __reason: 'lp_fetch_failed' }) as any
    // _lpAddrSnippet and lpPair refer to the V2 verification pool (for LP proof evidence)
    const _lpAddrSnippet = _lpProofAddress ? `${_lpProofAddress.slice(0, 10)}…${_lpProofAddress.slice(-4)}` : "none";
    const lpVerifyPoolObj = lpVerifyPoolPresent ? lpVerifyPool : lpPool
    const lpPair = lpVerifyPoolObj?.pairName ?? `${lpVerifyPoolObj?.baseTokenSymbol ?? "?"}/${lpVerifyPoolObj?.quoteTokenSymbol ?? "?"}`;
    // _primaryPair always describes the PRIMARY/canonical pool's pair (e.g. "MFERGPT / WETH"
    // on Uniswap V4), even when a different secondary V2/Aerodrome pool (lpPair, above) was
    // used for LP-holder lock/burn proof — selectedPool fields shown to LP-intel builders
    // must never mix the primary pool's dex/model with a secondary pool's pair label.
    const _primaryPair = lpPool?.pairName
      ?? (lpPool?.baseTokenSymbol || lpPool?.quoteTokenSymbol ? `${lpPool?.baseTokenSymbol ?? "?"}/${lpPool?.quoteTokenSymbol ?? "?"}` : null)
      ?? lpPair
    const marketPair = pairName ?? "unknown";
    const lpReason = lpVerifyPoolPresent && lpVerifyPool !== lpPool
      ? `V2 proof pool selected (${lpVerifyPool?.dexId ?? lpVerifyPool?.dexName ?? 'unknown dex'}) — highest-liquidity V2 pool for burn/lock verification`
      : canonicalPrimaryUsable
        ? "using canonical primary highest-liquidity pool for LP verification"
        : (
            selectedLpPool.reason.includes("no preferred quote pair")
              ? "No WETH/USDC/USDbC/cbBTC verification pool found from provider; using best available pool."
              : selectedLpPool.reason
          );
    const _lpBaseDiagnostics = [
      ...(lpVerifyPoolPresent ? [`V2 proof pool: ${lpPair} (${_lpProofType})`] : (lpPool ? [`Market pool: ${marketPair} (${lpPoolType})`] : [])),
      `Pool type: ${_lpProofType}`,
      `DEX metadata: ${lpVerifyPoolObj?.hasDexMeta ? (lpVerifyPoolObj.dexId ?? lpVerifyPoolObj.dexName ?? "available") : "not_indexed"}`,
    ];
    const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
    const KNOWN_LOCKERS = new Set<string>(LOCKER_REGISTRY[chain as ChainKey] ?? []);
    const _lockerRegistryEmpty = KNOWN_LOCKERS.size === 0;
    const _rpcConfigured = Boolean(getAlchemyRpcUrl(chain as ChainKey));
    const _rpcSkippedReason: string | null = _rpcConfigured ? null
      : chain === 'base' ? 'missing_base_rpc_env'
      : chain === 'eth' ? 'missing_eth_rpc_env'
      : 'missing_rpc_env';
    const confidenceFor = (pct: number): "high" | "medium" | "low" => pct >= 80 ? "high" : pct >= 50 ? "medium" : "low";
    let lpDiagnostics: LpDiagnostics = {
      attempted: _lpProofPresent,
      chain,
      poolCount: matchingPools.length,
      primaryPoolAddress,
      primaryDex: primaryDexName ?? lpDexName ?? lpDexId ?? null,
      poolType: _lpProofType,
      lpTokenFound: _lpProofPresent,
      lpTokenAddress: _lpProofAddress,
      lpTokenTotalSupplyFound: false,
      burnBalanceFound: false,
      lockerBalanceFound: false,
      teamBalanceFound: false,
      lpState: "partial",
      confidence: "low",
      reason: "LP control requires holder-level LP token verification.",
      goldrushAttempted: needsLpHolderFetch,
      goldrushItemCount: 0,
      goldrushPctDerived: false,
      rpcFallbackAttempted: false,
      goldrushStatus: null,
      rpcAttempted: false,
      totalSupplyChecked: false,
      burnAddressesChecked: false,
      lockerAddressesChecked: false,
      ownerTeamBalanceChecked: false,
      burnPercent: null,
      lockedPercent: null,
      teamPercent: null,
      failureReason: null,
      dexscreenerPoolSynthesized: _dsFbPoolSynthesized,
      poolDetected: normalizedPools.length > 0,
      poolSource: _dsFbPoolSynthesized ? 'dexscreener_synthesized' : (matchingPools.length > 0 ? 'geckoterminal' : 'none'),
      primaryPoolSelected: Boolean((lpPoolAddressPresent || lpPool?.poolId) && (lpPool?.liquidityUsd ?? 0) > 0),
      selectedPoolAddress: _lpProofAddress,
      selectedPoolDex: lpVerifyPool?.dexId ?? lpVerifyPool?.dexName ?? lpPool?.dexId ?? lpPool?.dexName ?? null,
      selectedPoolType: _lpProofType,
      selectedPoolLiquidityUsd: lpVerifyPool?.liquidityUsd ?? lpPool?.liquidityUsd ?? null,
      // Split-pool diagnostics
      primaryMarketSelected: Boolean(lpPoolAddressPresent || lpPool?.poolId),
      primaryMarketPoolAddress: lpPoolAddress,
      primaryMarketPoolId: primaryMarketPoolId ?? lpPool?.poolId ?? null,
      primaryMarketPoolAddressType: primaryMarketPoolAddressType ?? lpPool?.poolAddressType ?? "unknown",
      primaryMarketDex: primaryDexName ?? normalizeDexLabel(lpPool?.dexId ?? lpPool?.dexName ?? null),
      primaryMarketType: lpPoolType,
      primaryMarketLiquidityUsd: lpPool?.liquidityUsd ?? null,
      lpVerificationPoolSelected: lpVerifyPoolPresent,
      lpVerificationPoolAddress: lpVerifyPoolAddress,
      lpVerificationDex: lpVerifyPool?.dexId ?? lpVerifyPool?.dexName ?? null,
      lpVerificationType: lpVerifyPoolPresent ? lpVerifyPoolType : null,
      lpVerificationLiquidityUsd: lpVerifyPool?.liquidityUsd ?? null,
      v2PoolCandidatesCount: _v2PoolCandidates.length,
      protocolPoolCandidatesCount: _protocolPoolCandidates.length,
      lpProofAttempted: needsLpHolderFetch,
      holderProofAttempted: needsLpHolderFetch,
      holderRawItemCount: 0,
      lpProofSkipReason: null,
      lockerRegistryChain: chain,
      lockerAddressesCheckedCount: KNOWN_LOCKERS.size,
      lockerRegistryEmpty: _lockerRegistryEmpty,
      rpcConfigured: _rpcConfigured,
      rpcSkippedReason: _rpcSkippedReason,
      selectedPrimaryPoolStrategy: 'highest_liquidity_canonical_market_pool',
      selectedPoolPresent: Boolean(mainPool) || _dsFbPoolSynthesized,
      marketPoolPresent: Boolean(mainPool) || Boolean(dexFbEarly?.pairAddress),
      poolCandidateRejectionReason: _dsFbPoolCandidateRejectionReason,
      poolModelStatus: lpPoolType === 'unknown'
        ? (normalizedPools.length > 0 ? 'partial' : 'unknown')
        : 'confirmed',
    };
    let lpControl: LpControlResult = {
      status: "partial",
      confidence: "low",
      poolType: _lpProofType,
      source: "dex_data",
      reason: "LP control requires holder-level LP token verification.",
      evidence: _lpBaseDiagnostics,
      poolAddressPresent: Boolean(_lpProofAddress),
      dexId: dexId || undefined,
      dexName: dexName || undefined,
      lpVerificationPoolReason: lpReason,
    };
    let concentratedPositionProof: ConcentratedPositionProof | null = null
    let _lpGrPctDerived = false
    let _lpRpcFallbackRan = false
    let _lpGrItemCount = 0
    // debug-only (?debug=true): captures each step of LP-holder controller resolution so
    // _debug.lpResolution can show whether a dominant holder was found/derived/accepted or
    // overwritten by the burn/locker fallback — see _debug.lpResolution assembly below.
    const _lpResolutionDebug: Record<string, unknown> = {
      lpHolderCheckAttempted: false,
      lpHolderFetchAttempted: needsLpHolderFetch,
      lpHolderFetchSkippedReason: needsLpHolderFetch ? null : 'pool_model_not_v2_or_unknown',
    }
    // Classifies LP-holder evidence for a SECONDARY (different-pair) V2/Aerodrome pool —
    // informational only (secondaryLpControlSignals/secondaryLpExposure); never affects the
    // primary lpControl/lpControllerIntel/riskBreakdown.liquiditySafety computed below.
    const _classifySecondaryLpHolders = async (
      items: Array<Record<string, unknown>>,
      poolAddress: string
    ): Promise<{ status: "burned" | "locked" | "team_controlled" | "partial"; confidence: "high" | "low"; reason: string; evidence: string[] } | null> => {
      if (items.length === 0) return null
      const grSupply = items.find((i) => i?.total_supply != null)?.total_supply
      let supplyStr = grSupply != null ? String(grSupply) : null
      const hasDirectPct = items.some((h) => {
        const p = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? toNum(h.balancePercent) ?? toNum(h.ownershipPercent) ?? toNum(h.percent_of_supply) ?? toNum(h.share) ?? toNum(h.supply_percentage) ?? toNum(h.percentage_relative_to_total_supply)
        return p != null && p > 0
      })
      if (supplyStr == null && !hasDirectPct) {
        const hex = await countedRpcCall("eth_call", [{ to: poolAddress, data: "0x18160ddd" }, "latest"], "secondaryLpHolderCheck.totalSupply", false)
        const big = hexToBigInt(hex)
        if (big != null && big > BigInt(0)) supplyStr = big.toString()
      }
      const top = items.slice(0, 5).map((h) => {
        const directPctRaw = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? toNum(h.balancePercent) ?? toNum(h.ownershipPercent) ?? toNum(h.percent_of_supply) ?? toNum(h.share) ?? toNum(h.supply_percentage) ?? toNum(h.percentage_relative_to_total_supply)
        const directPct = (directPctRaw != null && directPctRaw > 0) ? directPctRaw : null
        let derivedPct: number | null = null
        if (directPct == null && supplyStr != null) derivedPct = bigIntPct(lpHolderBalanceRaw(h), supplyStr)
        return { address: String(h.address ?? h.holder_address ?? h.wallet_address ?? "").toLowerCase(), pct: directPct ?? derivedPct ?? 0 }
      }).filter((x) => /^0x[a-f0-9]{40}$/.test(x.address))
      const topHolder = top[0] ?? null
      const burnPct = top.filter((x) => DEAD.has(x.address)).reduce((a, b) => a + (b.pct ?? 0), 0)
      const lockerPct = top.filter((x) => KNOWN_LOCKERS.has(x.address)).reduce((a, b) => a + (b.pct ?? 0), 0)
      const _secConfidence = (pct: number): "high" | "low" => pct >= 80 ? "high" : "low"
      if (burnPct >= 50) return { status: 'burned', confidence: _secConfidence(burnPct), reason: 'Dominant LP share in this secondary pool appears in burn/dead addresses.', evidence: [`burn_share=${burnPct.toFixed(2)}%`] }
      if (lockerPct >= 50) return { status: 'locked', confidence: _secConfidence(lockerPct), reason: 'Dominant LP share in this secondary pool appears in known lockers.', evidence: [`locker_share=${lockerPct.toFixed(2)}%`] }
      if (topHolder && (topHolder.pct ?? 0) > 0 && !DEAD.has(topHolder.address) && !KNOWN_LOCKERS.has(topHolder.address)) {
        return {
          status: (topHolder.pct ?? 0) >= 80 ? 'team_controlled' : 'partial',
          confidence: (topHolder.pct ?? 0) >= 80 ? 'high' : 'low',
          reason: "Secondary pool LP-holder evidence — informational only, does not affect this token's primary LP verdict.",
          evidence: [`top_holder=${topHolder.address}`, `top_share=${(topHolder.pct ?? 0).toFixed(2)}%`],
        }
      }
      return { status: 'partial', confidence: 'low', reason: 'Secondary pool LP-holder check inconclusive.', evidence: [`top_rows=${top.length}`] }
    }
    _scanStage = 'lp_control_evaluation'
    if (!_lpProofPresent) {
      if (_fallbackLiquidityDetected) {
        // Market-fallback evidence proves liquidity exists, but no usable pool address could be
        // selected/probed for LP-holder verification → pool detected, model is an open check.
        lpControl = { ...lpControl, status: "open_check", confidence: "low", reason: "Pool detected from market fallback; pool model requires RPC confirmation." };
      } else {
        // No pool at all — not even a market pool with a usable address
        lpControl = { ...lpControl, status: "no_pool", reason: "No pool address found from provider for LP-holder verification." };
      }
    } else if (!lpVerifyPoolPresent && _primaryConcentrated) {
      // Market pool exists but is V3/concentrated, and no V2/Aerodrome-V2 pool found anywhere →
      // attempt a real position/controller proof instead of stopping at "required".
      concentratedPositionProof = await attemptConcentratedPositionProof(
        chain as "eth" | "base", primaryPoolAddress, primaryMarketPoolId ?? lpPool?.poolId ?? null,
        primaryMarketPoolAddressType ?? lpPool?.poolAddressType ?? "unknown", lpDexId ?? lpDexName ?? null,
      )
      lpControl = {
        status: "concentrated_liquidity",
        confidence: "medium",
        poolType: lpPoolType,
        source: "dex_data",
        reason: `Position proof attempted — ${concentratedPositionProof.status === "not_supported" ? "not supported by current provider path" : concentratedPositionProof.reason}`,
        evidence: [
          `Market pool: ${marketPair} (${concentratedPoolDisplayLabel(concentratedPositionProof.poolModel, lpDexId ?? lpDexName)})`,
          `pool=${primaryPoolAddress ?? primaryMarketPoolId ?? lpPool?.poolId ?? "unknown"}`,
          `dex=${lpDexId ?? lpDexName ?? "unknown"}`, `poolModel=${concentratedPositionProof.poolModel}`,
          ...concentratedPositionProof.evidence,
        ],
      };
    } else if (lpVerifyPoolPresent && lpVerifyPool?.hasLpToken === false) {
      // LP verification pool has no ERC20 LP token (V3/CL NFT, incl. Aerodrome Slipstream) — burn/lock
      // proof not applicable; attempt a real position/controller proof instead of stopping at "required".
      concentratedPositionProof = await attemptConcentratedPositionProof(
        chain as "eth" | "base", lpVerifyPoolAddress, lpVerifyPool?.poolId ?? null,
        lpVerifyPool?.poolAddressType ?? "unknown", lpDexId ?? lpDexName ?? null,
      )
      lpControl = {
        status: 'concentrated_liquidity',
        confidence: 'medium',
        poolType: _lpProofType,
        source: 'dex_data',
        reason: `Position proof attempted — ${concentratedPositionProof.status === "not_supported" ? "not supported by current provider path" : concentratedPositionProof.reason}`,
        evidence: [
          `Market pool: ${marketPair} (${concentratedPoolDisplayLabel(concentratedPositionProof.poolModel, lpDexId ?? lpDexName)})`,
          `pool=${_lpAddrSnippet}`, `dex=${lpDexId ?? lpDexName ?? 'unknown'}`, `hasLpToken=false`, `poolModel=${concentratedPositionProof.poolModel}`,
          ...concentratedPositionProof.evidence,
        ],
      };
    } else if (_lpProofType === "unknown") {
      // Step 1: try GoldRush LP holder proof (same as v2 path) using pre-fetched data
      const _unknownLpItems = Array.isArray(_lpHoldersForControl?.data?.items) ? _lpHoldersForControl.data.items as Array<Record<string, unknown>> : [];
      _lpGrItemCount = _unknownLpItems.length
      const _grStatus = _lpHoldersForControl?.__status ?? (_unknownLpItems.length > 0 ? 'ok' : 'empty')
      const _unknownLpSupply = _unknownLpItems.find((i: Record<string, unknown>) => i?.total_supply != null)?.total_supply
      let _unknownLpSupplyStr = _unknownLpSupply != null ? String(_unknownLpSupply) : null
      const _unknownItemsHaveDirectPct = _unknownLpItems.some((h: Record<string, unknown>) => {
        const p = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? toNum(h.balancePercent) ?? toNum(h.ownershipPercent) ?? toNum(h.percent_of_supply) ?? toNum(h.share) ?? toNum(h.supply_percentage) ?? toNum(h.percentage_relative_to_total_supply)
        return p != null && p > 0
      })
      if (_unknownLpSupplyStr == null && !_unknownItemsHaveDirectPct && _unknownLpItems.length > 0) {
        const _lpTotalSupplyHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
        const _lpTotalSupplyBigInt = hexToBigInt(_lpTotalSupplyHex);
        if (_lpTotalSupplyBigInt != null && _lpTotalSupplyBigInt > BigInt(0)) {
          _unknownLpSupplyStr = _lpTotalSupplyBigInt.toString()
        }
      }
      const unknownTop = _unknownLpItems.slice(0, 5).map((h: Record<string, unknown>) => {
        const directPctRaw = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? toNum(h.balancePercent) ?? toNum(h.ownershipPercent) ?? toNum(h.percent_of_supply) ?? toNum(h.share) ?? toNum(h.supply_percentage) ?? toNum(h.percentage_relative_to_total_supply)
        const directPct = (directPctRaw != null && directPctRaw > 0) ? directPctRaw : null
        let derivedPct: number | null = null
        if (directPct == null && _unknownLpSupplyStr != null) {
          derivedPct = bigIntPct(lpHolderBalanceRaw(h), _unknownLpSupplyStr)
          if (derivedPct != null) _lpGrPctDerived = true
        }
        return {
          address: String(h.address ?? h.holder_address ?? h.wallet_address ?? "").toLowerCase(),
          pct: directPct ?? derivedPct ?? 0,
        }
      }).filter((x: { address: string; pct: number }) => /^0x[a-f0-9]{40}$/.test(x.address))
      const unknownTopHolder = unknownTop[0] ?? null
      const unknownBurnPct = unknownTop.filter((x: { address: string; pct: number }) => DEAD.has(x.address)).reduce((a: number, b: { pct: number }) => a + (b.pct ?? 0), 0)
      const unknownLockerPct = unknownTop.filter((x: { address: string; pct: number }) => KNOWN_LOCKERS.has(x.address)).reduce((a: number, b: { pct: number }) => a + (b.pct ?? 0), 0)
      const grProvedUnknown = unknownTop.some((x: { pct: number }) => (x.pct ?? 0) > 0)
      if (grProvedUnknown) {
        // GoldRush returned usable holder data — classify from it
        if (unknownBurnPct >= 50) {
          lpControl = { status: "burned", confidence: confidenceFor(unknownBurnPct), poolType: "unknown", source: "Market + holder evidence", reason: "Dominant LP share appears in burn/dead addresses, but the pool model is not fully classified.", evidence: [`burn_share=${unknownBurnPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        } else if (unknownLockerPct >= 50) {
          lpControl = { status: "locked", confidence: confidenceFor(unknownLockerPct), poolType: "unknown", source: "Market + holder evidence", reason: "Dominant LP share appears in known lockers, but the pool model is not fully classified.", evidence: [`locker_share=${unknownLockerPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        } else if (unknownTopHolder && (unknownTopHolder.pct ?? 0) >= 80 && !DEAD.has(unknownTopHolder.address) && !KNOWN_LOCKERS.has(unknownTopHolder.address)) {
          lpControl = { status: "team_controlled", confidence: "high", poolType: "unknown", source: "Market + holder evidence", reason: "Single normal wallet holds dominant LP share, but the pool model is not fully classified.", evidence: [`top_holder=${unknownTopHolder.address}`, `top_share=${(unknownTopHolder.pct ?? 0).toFixed(2)}%`], poolAddressPresent: true, dexId: dexId || undefined };
        } else {
          const partialEv2 = [
            unknownBurnPct > 0.5 ? `burn_share=${unknownBurnPct.toFixed(2)}%` : null,
            unknownLockerPct > 0.5 ? `locker_share=${unknownLockerPct.toFixed(2)}%` : null,
          ].filter(Boolean) as string[]
          // Surface dominant-holder evidence even below the 80% "team_controlled"
          // threshold so LP-controller intel doesn't fall back to "unknown".
          if (unknownTopHolder && (unknownTopHolder.pct ?? 0) > 0 && !DEAD.has(unknownTopHolder.address) && !KNOWN_LOCKERS.has(unknownTopHolder.address)) {
            partialEv2.push(`top_holder=${unknownTopHolder.address}`, `top_share=${(unknownTopHolder.pct ?? 0).toFixed(2)}%`)
          }
          lpControl = { status: partialEv2.length ? "partial" : "partial", confidence: "low", poolType: "unknown", source: "Market + holder evidence", reason: "LP holder check inconclusive — no dominant burn/lock pattern and pool model is not fully classified.", evidence: [`top_rows=${unknownTop.length}`, ...partialEv2, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        }
      } else {
        // Step 2: GoldRush failed or empty — probe pool via RPC to classify
        _lpRpcFallbackRan = true
        const probe = await probePoolTypeViaRpc(chain, _lpProofAddress!);
        if (probe.v2Like) {
          const totalSupplyHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
          const totalSupplyBigInt = hexToBigInt(totalSupplyHex);
          const totalSupply = totalSupplyBigInt != null ? Number(totalSupplyBigInt) : null;
          if (!totalSupply || totalSupply <= 0) {
            lpControl = { status: "partial", confidence: "low", poolType: "v2", source: "dex_data+rpc", reason: "Pool probed as V2-like but RPC totalSupply read returned no data.", evidence: [`Verification pool: ${lpPair}`, "RPC probe: V2-like interface detected"], poolAddressPresent: true, probeV2Like: true, probeV3Like: false, dexId: dexId || undefined };
          } else {
            const readPct = async (addr: string) => {
              const data = `0x70a08231${pad32HexAddress(addr)}`;
              const balHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data }, "latest"], "lpControlCheck.balanceOf", false);
              const balBigInt = hexToBigInt(balHex);
              if (balBigInt == null) return 0;
              return (Number(balBigInt) / totalSupply) * 100;
            };
            const _ownerForLpProbe = ownerAddrEarlyForLp && !DEAD.has(ownerAddrEarlyForLp) && !KNOWN_LOCKERS.has(ownerAddrEarlyForLp) ? ownerAddrEarlyForLp : null
            const [burn0, burnDead, _lockerPcts, _ownerLpPctProbe] = await Promise.all([
              readPct("0x0000000000000000000000000000000000000000"),
              readPct("0x000000000000000000000000000000000000dEaD"),
              Promise.all([...KNOWN_LOCKERS].map(readPct)),
              _ownerForLpProbe ? readPct(_ownerForLpProbe) : Promise.resolve(0),
            ]);
            const burnShare = burn0 + burnDead;
            const lockerShare = _lockerPcts.reduce((a: number, b: number) => a + b, 0);
            const teamShareProbe = _ownerLpPctProbe ?? 0;
            const base = { poolType: "v2" as const, source: "dex_data+rpc", poolAddressPresent: true, probeV2Like: true, probeV3Like: false, dexId: dexId || undefined };
            if (burnShare >= 50) {
              lpControl = { ...base, status: "burned", confidence: confidenceFor(burnShare), reason: "Dominant LP share appears in burn/dead balances via RPC.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
            } else if (lockerShare >= 50) {
              lpControl = { ...base, status: "locked", confidence: confidenceFor(lockerShare), reason: "Dominant LP share appears in known locker balances via RPC.", evidence: [`locker_share=${lockerShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
            } else if (teamShareProbe >= 80) {
              lpControl = { ...base, status: "team_controlled", confidence: "high", reason: `Owner wallet holds ${teamShareProbe.toFixed(2)}% of LP supply (RPC verified).`, evidence: [`owner_lp_share=${teamShareProbe.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
            } else {
              lpControl = { ...base, status: (burnShare > 0 || lockerShare > 0) ? "partial" : "partial", confidence: "low", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`, ...(teamShareProbe > 0 ? [`owner_lp_share=${teamShareProbe.toFixed(2)}%`] : []), `pool=${_lpAddrSnippet}`] };
            }
          }
        } else if (probe.v3Like) {
          lpControl = { status: "concentrated_liquidity", confidence: "medium", poolType: "v3", source: "dex_data+rpc", reason: "LP lock proof is not applicable to this pool type.", evidence: [`Verification pool: ${lpPair}`, "RPC probe: concentrated-liquidity interface detected"], poolAddressPresent: true, probeV2Like: false, probeV3Like: true, dexId: dexId || undefined };
        } else {
          lpControl = { status: "partial", confidence: "low", poolType: "unknown", source: "dex_data+rpc", reason: alchemyConfigured ? "Verification pool found, but current RPC checks did not confirm a standard V2/V3 LP interface." : "LP holder data not indexed and RPC probe did not confirm a standard V2/V3 interface.", evidence: [`Verification pool: ${lpPair}`, "Pool type: unknown", `DEX metadata: ${lpPool?.hasDexMeta ? (lpPool.dexId ?? lpPool.dexName ?? "available") : "not_indexed"}`, `GoldRush: ${_grStatus}`, alchemyConfigured ? `RPC probe: ${probe.probeSummary}` : "RPC probe: not_configured (Alchemy not configured)"], poolAddressPresent: true, probeV2Like: false, probeV3Like: false, dexId: dexId || undefined };
        }
      }
    } else {
      // V2 — run GoldRush LP holder check
      const lpItems = Array.isArray(_lpHoldersForControl?.data?.items) ? _lpHoldersForControl.data.items as Array<Record<string, unknown>> : [];
      _lpGrItemCount = lpItems.length
      const _lpGrTotalSupply = lpItems.find(i => i?.total_supply != null)?.total_supply
      let _lpGrSupplyStr = _lpGrTotalSupply != null ? String(_lpGrTotalSupply) : null
      // GoldRush LP-holder rows sometimes report percentage/percent/ownership_percentage as a
      // placeholder 0 for every row instead of leaving the field absent. Only treat a direct
      // percentage as usable when it is a positive value — a row of all-zero "direct"
      // percentages must not block the RPC totalSupply-derived fallback below.
      const _lpItemsHaveDirectPct = lpItems.some((h) => {
        const p = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? toNum(h.balancePercent) ?? toNum(h.ownershipPercent) ?? toNum(h.percent_of_supply) ?? toNum(h.share) ?? toNum(h.supply_percentage) ?? toNum(h.percentage_relative_to_total_supply)
        return p != null && p > 0
      })
      // GoldRush LP-holder rows sometimes omit total_supply — fall back to an RPC totalSupply
      // read (same eth_call used by the RPC-fallback path below) so balance percentages can
      // still be derived. Without this, every holder's pct collapses to 0, the dominant LP
      // holder's address/share is discarded, and the scan falls through to the RPC-only
      // burn/locker/owner probe, which cannot discover an arbitrary dominant wallet.
      if (_lpGrSupplyStr == null && !_lpItemsHaveDirectPct && lpItems.length > 0) {
        const _lpTotalSupplyHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
        const _lpTotalSupplyBigInt = hexToBigInt(_lpTotalSupplyHex);
        if (_lpTotalSupplyBigInt != null && _lpTotalSupplyBigInt > BigInt(0)) {
          _lpGrSupplyStr = _lpTotalSupplyBigInt.toString()
        }
      }
      const top = lpItems.slice(0, 5).map((h) => {
        const directPctRaw = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage) ?? toNum(h.balancePercent) ?? toNum(h.ownershipPercent) ?? toNum(h.percent_of_supply) ?? toNum(h.share) ?? toNum(h.supply_percentage) ?? toNum(h.percentage_relative_to_total_supply)
        const directPct = (directPctRaw != null && directPctRaw > 0) ? directPctRaw : null
        let derivedPct: number | null = null
        if (directPct == null && _lpGrSupplyStr != null) {
          derivedPct = bigIntPct(lpHolderBalanceRaw(h), _lpGrSupplyStr)
          if (derivedPct != null) _lpGrPctDerived = true
        }
        return {
          address: String(h.address ?? h.holder_address ?? h.wallet_address ?? "").toLowerCase(),
          pct: directPct ?? derivedPct ?? 0,
        }
      }).filter((x) => /^0x[a-f0-9]{40}$/.test(x.address));
      const topHolder = top[0] ?? null;
      const burnPct = top.filter((x) => DEAD.has(x.address)).reduce((a, b) => a + (b.pct ?? 0), 0);
      const lockerPct = top.filter((x) => KNOWN_LOCKERS.has(x.address)).reduce((a, b) => a + (b.pct ?? 0), 0);
      // debug-only (?debug=true) — see _debug.lpResolution assembly near response_assembly.
      {
        const _rawTopRow = lpItems[0] ?? null
        const _rawBalanceField = _rawTopRow ? lpHolderFieldUsed(_rawTopRow, LP_HOLDER_BALANCE_FIELDS) : null
        const _rawPercentField = _rawTopRow ? lpHolderFieldUsed(_rawTopRow, LP_HOLDER_PERCENT_FIELDS) : null
        const _rawPercentValue = _rawPercentField ? toNum(_rawTopRow![_rawPercentField]) : null
        const _directPctRejected = _rawPercentField != null && !(_rawPercentValue != null && _rawPercentValue > 0)
        Object.assign(_lpResolutionDebug, {
          lpHolderCheckAttempted: true,
          lpHolderFetchStatus: _lpHoldersForControl?.__status ?? (lpItems.length > 0 ? 'ok' : 'empty'),
          lpHolderFetchSkippedReason: null,
          lpHolderRowCount: lpItems.length,
          rawTopHolderAddress: _rawTopRow ? String(_rawTopRow.address ?? _rawTopRow.holder_address ?? _rawTopRow.wallet_address ?? null) : null,
          rawTopHolderKnownFields: _rawTopRow ? Object.keys(_rawTopRow) : [],
          rawTopHolderBalanceValue: _rawBalanceField ? _rawTopRow![_rawBalanceField] : null,
          rawTopHolderBalanceFieldUsed: _rawBalanceField,
          rawTopHolderPercentValue: _rawPercentValue,
          rawTopHolderPercentFieldUsed: _rawPercentField,
          directPctConsideredValid: _rawPercentField != null && !_directPctRejected,
          directPctRejectedReason: _directPctRejected
            ? (_rawPercentValue === 0 ? 'percent_field_zero_placeholder' : 'percent_field_not_positive')
            : (_rawPercentField == null ? 'no_percent_field_present' : null),
          totalSupplyFetchAttempted: _lpGrSupplyStr == null ? false : (_lpGrTotalSupply == null),
          totalSupplyFetchStatus: _lpGrTotalSupply != null ? 'skipped_supply_present_in_holder_rows' : (_lpGrSupplyStr != null ? 'ok' : (lpItems.length > 0 ? 'error' : 'skipped')),
          totalSupplyRaw: _lpGrSupplyStr,
          derivedTopSharePercent: topHolder?.pct ?? null,
          derivedTopShareStatus: !_lpGrPctDerived ? (topHolder?.pct ? 'unavailable_used_direct_pct' : 'unavailable') : (topHolder ? 'ok' : 'unavailable'),
          derivedTopShareRejectedReason: _lpGrPctDerived ? null : (_lpGrSupplyStr == null ? 'no_total_supply_available' : null),
          dominantHolderCandidateAddress: topHolder?.address ?? null,
          dominantHolderCandidateShare: topHolder?.pct ?? null,
        })
      }
      if (burnPct >= 50) {
        lpControl = { status: "burned", confidence: confidenceFor(burnPct), poolType: _lpProofType, source: "Market + holder evidence", reason: "Dominant LP share appears in burn/dead addresses.", evidence: [`burn_share=${burnPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
      } else if (lockerPct >= 50) {
        lpControl = { status: "locked", confidence: confidenceFor(lockerPct), poolType: _lpProofType, source: "Market + holder evidence", reason: "Dominant LP share appears in known lockers.", evidence: [`locker_share=${lockerPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
      } else if (topHolder && (topHolder.pct ?? 0) >= 80 && !DEAD.has(topHolder.address) && !KNOWN_LOCKERS.has(topHolder.address)) {
        lpControl = { status: "team_controlled", confidence: "high", poolType: _lpProofType, source: "Market + holder evidence", reason: "Single normal wallet holds dominant LP share.", evidence: [`top_holder=${topHolder.address}`, `top_share=${(topHolder.pct ?? 0).toFixed(2)}%`] };
      } else if (lpItems.length === 0 || !top.some((x) => (x.pct ?? 0) > 0)) {
        // Alchemy RPC fallback when GoldRush holder percentages are unavailable
        _lpRpcFallbackRan = true
        const totalSupplyHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
        const totalSupplyBigInt = hexToBigInt(totalSupplyHex);
        const totalSupply = totalSupplyBigInt != null ? Number(totalSupplyBigInt) : null;
        if (!totalSupply || totalSupply <= 0) {
          lpControl = { status: "partial", confidence: "low", poolType: _lpProofType, source: "dex_data+rpc", reason: "LP holder percentages not indexed; RPC totalSupply read returned no data.", evidence: [`pool=${_lpAddrSnippet}`] };
        } else {
          const readPct = async (addr: string) => {
            const data = `0x70a08231${pad32HexAddress(addr)}`;
            const balHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data }, "latest"], "lpControlCheck.balanceOf", false);
            const balBigInt = hexToBigInt(balHex);
            if (balBigInt == null) return 0;
            return (Number(balBigInt) / totalSupply) * 100;
          };
          const _ownerForLpFallback = ownerAddrEarlyForLp && !DEAD.has(ownerAddrEarlyForLp) && !KNOWN_LOCKERS.has(ownerAddrEarlyForLp) ? ownerAddrEarlyForLp : null
          const [burn0, burnDead, _lockerPcts, _ownerLpPctFallback] = await Promise.all([
            readPct("0x0000000000000000000000000000000000000000"),
            readPct("0x000000000000000000000000000000000000dEaD"),
            Promise.all([...KNOWN_LOCKERS].map(readPct)),
            _ownerForLpFallback ? readPct(_ownerForLpFallback) : Promise.resolve(0),
          ]);
          const burnShare = burn0 + burnDead;
          const lockerShare = _lockerPcts.reduce((a: number, b: number) => a + b, 0);
          const teamShareFallback = _ownerLpPctFallback ?? 0;
          if (burnShare >= 50) {
            lpControl = { status: "burned", confidence: confidenceFor(burnShare), poolType: _lpProofType, source: "dex_data+rpc", reason: "Dominant LP share appears in burn/dead balances via RPC.", evidence: [`burn_share=${burnShare.toFixed(2)}%`] };
          } else if (lockerShare >= 50) {
            lpControl = { status: "locked", confidence: confidenceFor(lockerShare), poolType: _lpProofType, source: "dex_data+rpc", reason: "Dominant LP share appears in known locker balances via RPC.", evidence: [`locker_share=${lockerShare.toFixed(2)}%`] };
          } else if (teamShareFallback >= 80) {
            lpControl = { status: "team_controlled", confidence: "high", poolType: _lpProofType, source: "dex_data+rpc", reason: `Owner wallet holds ${teamShareFallback.toFixed(2)}% of LP supply (RPC verified).`, evidence: [`owner_lp_share=${teamShareFallback.toFixed(2)}%`] };
          } else {
            lpControl = { status: (burnShare > 0 || lockerShare > 0) ? "partial" : "partial", confidence: "low", poolType: _lpProofType, source: "dex_data+rpc", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`, ...(teamShareFallback > 0 ? [`owner_lp_share=${teamShareFallback.toFixed(2)}%`] : [])] };
          }
        }
      } else {
        const partialEv = [
          burnPct > 0.5 ? `burn_share=${burnPct.toFixed(2)}%` : null,
          lockerPct > 0.5 ? `locker_share=${lockerPct.toFixed(2)}%` : null,
        ].filter(Boolean) as string[]
        // Even when the dominant LP holder doesn't cross the 80% "team_controlled"
        // threshold, surface the holder/share evidence so downstream LP-controller
        // intel can reuse it instead of reporting the controller as "unknown".
        if (topHolder && (topHolder.pct ?? 0) > 0 && !DEAD.has(topHolder.address) && !KNOWN_LOCKERS.has(topHolder.address)) {
          partialEv.push(`top_holder=${topHolder.address}`, `top_share=${(topHolder.pct ?? 0).toFixed(2)}%`)
        }
        const partialReason = partialEv.length
          ? `LP holder check inconclusive — no dominant burn/lock pattern. ${partialEv.join(', ')}.`
          : "LP checks ran but could not prove burned/locked/team-controlled state."
        lpControl = { status: partialEv.length ? "partial" : "partial", confidence: "low", poolType: _lpProofType, source: "Market + holder evidence", reason: partialReason, evidence: [`top_rows=${top.length}`, ...partialEv] };
      }
      // debug-only (?debug=true) — see _debug.lpResolution assembly near response_assembly.
      {
        const _dominantAccepted = lpControl.status === 'team_controlled' || lpControl.evidence.some((e) => e.startsWith('top_holder=') || e.startsWith('owner_lp_share='))
        Object.assign(_lpResolutionDebug, {
          dominantHolderAccepted: _dominantAccepted,
          dominantHolderRejectedReason: _dominantAccepted ? null : (topHolder == null ? 'no_holder_rows' : (topHolder.pct ?? 0) <= 0 ? 'top_holder_pct_zero' : 'below_team_controlled_threshold'),
          dominantHolderControllerType: _dominantAccepted ? (DEAD.has(topHolder?.address ?? '') ? 'burn' : KNOWN_LOCKERS.has(topHolder?.address ?? '') ? 'lockContract' : 'wallet') : null,
          fallbackBurnLockerRan: _lpRpcFallbackRan,
          fallbackBurnShare: _lpRpcFallbackRan ? _extractEvidencePctDebug(lpControl.evidence ?? [], 'burn_share') : (burnPct || null),
          fallbackLockerShare: _lpRpcFallbackRan ? _extractEvidencePctDebug(lpControl.evidence ?? [], 'locker_share') : (lockerPct || null),
          fallbackOverwroteDominantHolder: _lpRpcFallbackRan && topHolder != null && (topHolder.pct ?? 0) > 0 && !_dominantAccepted,
          finalLpControlBeforeFallback: !_lpRpcFallbackRan ? { status: lpControl.status, evidence: lpControl.evidence } : null,
          finalLpControlAfterFallback: { status: lpControl.status, evidence: lpControl.evidence },
        })
      }
    }

    // Safety net: every branch above that finds a concentrated/V3-style primary pool should
    // already call attemptConcentratedPositionProof, but the RPC-probe fallback inside the
    // "_lpProofType === unknown" branch (v3Like sub-case) can resolve lpControl to
    // concentrated_liquidity without running the proof attempt. Never leave
    // concentratedPositionProof null when the primary pool is concentrated — attempt it here
    // using only the pool identity already resolved above (no new provider calls).
    if (_primaryConcentrated && !concentratedPositionProof) {
      concentratedPositionProof = await attemptConcentratedPositionProof(
        chain as "eth" | "base",
        primaryPoolAddress ?? lpVerifyPoolAddress ?? null,
        primaryMarketPoolId ?? lpPool?.poolId ?? lpVerifyPool?.poolId ?? null,
        primaryMarketPoolAddressType ?? lpPool?.poolAddressType ?? lpVerifyPool?.poolAddressType ?? "unknown",
        lpDexId ?? lpDexName ?? null,
      )
      lpControl = {
        ...lpControl,
        status: "concentrated_liquidity",
        poolType: lpControl.poolType ?? lpPoolType,
        reason: `Position proof attempted — ${concentratedPositionProof.status === "not_supported" ? "not supported by current provider path" : concentratedPositionProof.reason}`,
      };
    }

    // Selection rules 3/4 (shared with Liquidity Safety via lib/server/lpIntelligence):
    // when the PRIMARY pool is concentrated/CLMM but a SEPARATE V2/Aerodrome ERC-20 LP
    // pool was checked above, demote that result to a secondary signal and report the
    // canonical (primary-pool) status as concentrated_liquidity. This prevents a
    // secondary V2 pool from making the whole token "team_controlled" while
    // lpModelProof/cortexLpRead describe the primary pool as concentrated.
    {
      const _verifyPoolCandidate: LpPoolCandidate | null = lpVerifyPool ? {
        address: lpVerifyPoolAddress,
        liquidityUsd: lpVerifyPool.liquidityUsd ?? 0,
        dexId: lpVerifyPool.dexId ?? null,
        dexName: lpVerifyPool.dexName ?? null,
        poolType: lpVerifyPoolType,
        hasLpToken: lpVerifyPool.hasLpToken ?? null,
        hasDexMeta: lpVerifyPool.hasDexMeta ?? false,
        isValidAddress: lpVerifyPool.isValidAddress ?? Boolean(lpVerifyPoolAddress),
      } : null
      const { lpControl: _reconciled } = reconcileSecondaryLpSignal(lpControl, {
        primaryConcentrated: _primaryConcentrated,
        verifyPool: _verifyPoolCandidate,
        primaryPoolAddress,
        primaryPoolType: lpPoolType,
        primaryDexId: lpDexId ?? lpDexName ?? "unknown",
        primaryMarketPoolId: primaryMarketPoolId ?? lpPool?.poolId ?? null,
        marketPairLabel: marketPair,
      })
      lpControl = _reconciled
    }
    // Different-pair secondary V2/Aerodrome pools (rule 4/5, e.g. GAME/VIRTUAL when scanning
    // VIRTUAL) — classified ONLY as secondaryLpControlSignals/secondaryLpExposure below.
    // secondaryPoolPromotedToPrimary is always false: this never replaces lpControl.status.
    const secondaryPoolPromotedToPrimary = false
    if (!lpControl.secondaryLpControlSignals && _secondaryPoolAddress && secondaryPoolCandidates[0]) {
      const _secItems = Array.isArray(_secondaryLpHoldersForControl?.data?.items) ? _secondaryLpHoldersForControl.data.items as Array<Record<string, unknown>> : []
      const _secClassification = await _classifySecondaryLpHolders(_secItems, _secondaryPoolAddress)
      if (_secClassification) {
        const _secPool = secondaryPoolCandidates[0]
        const _secPair = _secPool.pairName ?? `${_secPool.baseTokenSymbol ?? "?"}/${_secPool.quoteTokenSymbol ?? "?"}`
        lpControl.secondaryLpControlSignals = {
          status: _secClassification.status,
          confidence: _secClassification.confidence,
          poolAddress: _secPool.address ?? null,
          poolDex: _secPool.dexId ?? _secPool.dexName ?? null,
          poolType: _secPool.poolType,
          pair: _secPair,
          reason: _secClassification.reason,
          evidence: _secClassification.evidence,
        }
      }
    }
    const _extractEvidencePct = (ev: string[], prefix: string): number | null => {
      const line = ev.find(e => e.startsWith(`${prefix}=`))
      if (!line) return null
      return parseFloat(line.split('=')[1]?.replace('%', '') ?? '') || null
    }
    const _lpEv = lpControl.evidence ?? []
    const _extractedBurnPct = _extractEvidencePct(_lpEv, 'burn_share')
    const _extractedLockerPct = _extractEvidencePct(_lpEv, 'locker_share')
    const _extractedTeamPct = _extractEvidencePct(_lpEv, 'owner_lp_share') ?? _extractEvidencePct(_lpEv, 'top_share')
    const _lpFailureReason = lpControl.status === "partial"
      ? (_lpGrItemCount === 0 && !_lpRpcFallbackRan ? 'goldrush_no_rows'
        : _lpGrItemCount === 0 && _lpRpcFallbackRan ? 'rpc_balance_checks_failed'
        : _lpGrItemCount > 0 ? 'no_burn_or_locker_balance'
        : 'unknown')
      : null
    lpDiagnostics = {
      ...lpDiagnostics,
      lpTokenTotalSupplyFound: _lpEv.some((e) => /totalSupply|burn_share|locker_share|top_rows|top_share/i.test(e)),
      burnBalanceFound: _lpEv.some((e) => /burn_share=/i.test(e)),
      lockerBalanceFound: _lpEv.some((e) => /locker_share=/i.test(e)),
      teamBalanceFound: lpControl.status === "team_controlled",
      lpState: lpControl.status,
      confidence: lpControl.confidence,
      reason: lpControl.reason,
      goldrushItemCount: _lpGrItemCount,
      goldrushPctDerived: _lpGrPctDerived,
      rpcFallbackAttempted: _lpRpcFallbackRan,
      goldrushStatus: needsLpHolderFetch ? (_lpGrItemCount > 0 ? 'ok' : (_lpHoldersForControl?.__reason ?? 'empty')) : 'not_attempted',
      rpcAttempted: _lpRpcFallbackRan || _lpProofType === 'unknown',
      totalSupplyChecked: _lpEv.some((e) => /totalSupply|burn_share|locker_share|top_rows|top_share/i.test(e)),
      burnAddressesChecked: _lpEv.some((e) => /burn_share=/i.test(e)) || _lpRpcFallbackRan,
      lockerAddressesChecked: _lpEv.some((e) => /locker_share=/i.test(e)) || _lpRpcFallbackRan,
      ownerTeamBalanceChecked: lpControl.status === "team_controlled" || _lpEv.some((e) => /owner_lp_share=/i.test(e)),
      burnPercent: _extractedBurnPct,
      lockedPercent: _extractedLockerPct,
      teamPercent: _extractedTeamPct,
      failureReason: _lpFailureReason,
      dexscreenerPoolSynthesized: _dsFbPoolSynthesized,
      holderRawItemCount: _lpGrItemCount,
      lpProofAttempted: needsLpHolderFetch,
      holderProofAttempted: needsLpHolderFetch,
      lpProofSkipReason: (() => {
        const s = lpControl.status
        if (s === 'concentrated_liquidity' || s === 'protocol') {
          return _v2PoolCandidates.length === 0 ? 'no_v2_lp_token_pool_found' : 'protocol_specific_liquidity'
        }
        return null
      })(),
    };

    // LP Safety debug flags — track proof quality for this scan
    const lpSafetyAttempted = needsLpHolderFetch
    const lpSafetyUsable = lpControl.status === 'burned' || lpControl.status === 'locked' || lpControl.status === 'team_controlled'
    // LP ownership/control is only "verified" when burn, lock, or proof status itself is
    // actually confirmed. Controller/dominance detection (lpSafetyUsable, lpControl.status,
    // team_controlled, canonicalStatus, "controller found") is a SEPARATE concept from
    // ownership-proof verification and must never promote ownership to "verified" — a
    // dominant wallet controller with no real lock/burn proof is an open check, not verified.
    const lpOwnershipVerified = lpControl.lockStatus === 'locked'
      || lpControl.burnStatus === 'burned'
      || lpControl.proofStatus === 'verified'
    // Partial LP-holder evidence (e.g. a single holder's LP share) proves *something* was
    // found, but never proves safe control on its own — keep it distinct from "verified".
    const lpOwnershipHolderEvidenceFound = !lpOwnershipVerified && (
      lpControl.status === 'partial'
      || (Array.isArray(lpControl.evidence) && lpControl.evidence.some((e) => /^(top_share|owner_lp_share|locker_share|burn_share|top_holder)=/i.test(e)))
    )
    // Standard ERC-20 LP lock/burn proof vs concentrated-position proof are distinct attempts —
    // expose both so "lpSafetyAttempted=false" never reads as "no LP proof was attempted at all"
    // when a concentrated-position proof was in fact attempted (e.g. Uniswap V4 pools).
    const standardLpProofAttempted = lpSafetyAttempted
    const standardLpProofStatus: string = lpControl.status === 'concentrated_liquidity'
      ? 'not_applicable'
      : (lpOwnershipVerified ? 'verified' : (lpOwnershipHolderEvidenceFound ? 'partial' : 'open_check'))
    const concentratedPositionProofAttempted = Boolean(concentratedPositionProof)
    const concentratedPositionProofStatus: string = concentratedPositionProof?.status ?? 'not_applicable'
    // Canonical public read for concentrated primary pools — never left null when the primary
    // pool is concentrated, even before a real position-owner indexer is wired in (Part 1/4).
    const concentratedPositionProofRead = (_primaryConcentrated && concentratedPositionProof)
      ? buildConcentratedPositionProofRead(concentratedPositionProof, {
          protocol: lpDexId ?? lpDexName ?? null,
          poolPair: marketPair ?? null,
        })
      : null

    // TEMPORARY DEBUG (pool-selection / concentrated-proof audit) — exposes the exact pool
    // model/dex selected for THIS scan and why concentrated-position proof was or wasn't
    // attempted, without changing any scoring/proof logic. _primaryConcentrated is the single
    // gate that decides eligibility (set from the canonical highest-liquidity pool's poolType,
    // before lpVerifyPool substitution or any later reconciliation runs).
    const _concentratedProofSkipReason: string | null = concentratedPositionProofAttempted
      ? null
      : !_primaryConcentrated
        ? `primary_pool_not_concentrated (lpPoolType=${lpPoolType}, highest-liquidity pool was classified as "${lpPoolType}", not v3/concentrated)`
        : lpVerifyPoolPresent
          ? `verify_pool_substituted_as_erc20 (lpVerifyPoolType=${lpVerifyPoolType}, hasLpToken=${lpVerifyPool?.hasLpToken}, address=${lpVerifyPoolAddress})`
          : 'unknown'

    // Ensure poolAddressPresent is always correct on the final object — some inner branches
    // replace lpControl wholesale without setting this field (e.g., GoldRush/RPC paths).
    lpControl.poolAddressPresent = _lpProofPresent;

    // Normalize split-pool and proof-status fields so frontend never needs to derive them.
    // These are always set regardless of which LP branch ran. Uses the shared
    // computeDisplayLpModel() (lib/server/lpIntelligence) so Token Scanner and
    // Liquidity Safety never disagree on whether standard ERC-20 LP lock/burn proof
    // applies to the canonical primary pool.
    {
      const _isVerified = lpControl.status === 'burned' || lpControl.status === 'locked'

      // ERC-20 LP proof confirmation (Aerodrome): only treat an Aerodrome pool as a confirmed
      // ERC-20 LP token when the holder/RPC proof path actually verified ERC-20 LP behavior —
      // never from the DEX id alone. Definitive control outcomes (burned/locked/team_controlled)
      // and RPC-confirmed V2-like probes prove the pool exposes an ERC-20 LP token; a "partial"
      // result that only reflects "no data"/"not indexed" does not.
      const _lpSource = typeof lpControl.source === 'string' ? lpControl.source : ''
      const _erc20LpProofConfirmed =
        lpControl.status === 'burned' || lpControl.status === 'locked' || lpControl.status === 'team_controlled' ||
        lpControl.probeV2Like === true ||
        (lpControl.status === 'partial' && /holder evidence/i.test(_lpSource))
      // Only gate Aerodrome pools (V2 pools' contract IS the LP token, so address presence is
      // sufficient evidence). For non-Aerodrome pools, leave undefined to preserve prior behavior.
      const _aerodromeLpConfirmed = (lpPoolType === 'aerodrome' || _lpProofType === 'aerodrome')
        ? _erc20LpProofConfirmed
        : undefined

      const _display = computeDisplayLpModel({
        noActivePools,
        proofPresent: _lpProofPresent,
        primaryPoolType: lpPoolType,
        primaryDexId: lpDexId,
        verifyPoolType: _lpProofType,
        controlStatusConcentrated: lpControl.status === 'concentrated_liquidity',
        marketLiquidityDetected: _fallbackLiquidityDetected,
        aerodromeLpConfirmed: _aerodromeLpConfirmed,
        modelProofStandardLockApplies: lpModelProof.standardLockApplies,
      })
      const _displayLpModel = _display.displayLpModel
      const _notApplicable = _displayLpModel === 'concentrated_liquidity' || _displayLpModel === 'no_pool'

      // Shared proof-applicability classification (problem 1/2/7): erc20_lp_token → applicable;
      // concentrated/no_pool → not_applicable; open_check (model not classified) → unknown.
      lpControl.proofApplicability = _display.proofApplicability

      lpControl.primaryMarketPool = lpDiagnostics.primaryMarketPoolAddress ?? null
      lpControl.primaryMarketPoolId = lpDiagnostics.primaryMarketPoolId ?? null
      // When the primary pool is concentrated/protocol liquidity (no standard ERC-20 LP
      // proof applies), but a separate V2/Aerodrome pool was checked and produced LP-holder
      // evidence (e.g. a dominant LP holder), surface that as a SEPARATE secondary signal —
      // it must never overwrite or be confused with the primary pool's lpControllerIntel/
      // lpLockBurnIntel/lpMovementWatch, which describe the primary (concentrated) pool model.
      // reconcileSecondaryLpSignal() above already derives secondaryLpControlSignals from the
      // SECONDARY pool's own pre-reconciliation holder evidence/status. This fallback branch
      // covers the case where a secondary verify pool exists but no holder-proof check ran
      // against it in this codepath — its status must come from the SECONDARY pool's own
      // model (_lpProofType), never copied from lpControl.status (which by this point is the
      // PRIMARY pool's reconciled "concentrated_liquidity" status). Copying it produced the
      // impossible combination status="concentrated_liquidity" + poolType="unknown".
      if (!lpControl.secondaryLpControlSignals && _notApplicable && lpVerifyPoolPresent && lpVerifyPoolAddress && lpPool !== lpVerifyPool) {
        const _secondaryModelConcentrated = _lpProofType === 'v3' || _lpProofType === 'concentrated'
        const _secondaryModelKnownErc20 = _lpProofType === 'v2' || _lpProofType === 'aerodrome'
        lpControl.secondaryLpControlSignals = {
          status: _secondaryModelConcentrated ? 'concentrated_liquidity' : 'open_check',
          confidence: 'low',
          poolAddress: lpVerifyPoolAddress,
          poolDex: lpDiagnostics.lpVerificationDex ?? null,
          poolType: _lpProofType,
          reason: _secondaryModelConcentrated
            ? "Secondary LP pool detected; pool model is concentrated liquidity, but no position-control proof has run against it in this codepath."
            : _secondaryModelKnownErc20
              ? "Secondary LP pool detected and pool model confirmed as a standard ERC-20 LP token, but lock/burn/controller proof has not been run against it in this codepath."
              : "Secondary LP pool detected, but pool model/control proof could not be confirmed.",
          evidence: [`Secondary pool: ${lpVerifyPoolAddress}`, `Secondary pool model: ${_lpProofType}`],
        }
      }
      // For concentrated/no-pool models there is no ERC-20 LP verification pool — report
      // these as null rather than surfacing a CLMM/V3 pool that was only used to confirm
      // "no LP token here", which would otherwise look like a (misleading) V2 proof source.
      lpControl.verificationPool = _notApplicable ? null : (lpDiagnostics.lpVerificationPoolAddress ?? null)
      lpControl.verificationPoolDex = _notApplicable ? null : (lpDiagnostics.lpVerificationDex ?? null)
      lpControl.verificationPoolType = _notApplicable ? null : (lpDiagnostics.lpVerificationType ?? null)
      lpControl.primaryPoolDex = lpDiagnostics.primaryMarketDex ?? null
      lpControl.primaryPoolType = lpPoolType
      lpControl.displayLpModel = _displayLpModel
      lpControl.lockBurnApplicable = _display.lockBurnApplicable
      lpControl.lockBurnReason = _display.lockBurnReason
      lpControl.proofStatus = _notApplicable ? 'not_applicable' : _isVerified ? 'verified' : 'open_check'
      lpControl.lockStatus = _notApplicable ? 'not_applicable' : lpControl.status === 'locked' ? 'locked' : 'not_confirmed'
      lpControl.burnStatus = _notApplicable ? 'not_applicable' : lpControl.status === 'burned' ? 'burned' : 'not_confirmed'
    }

    // For concentrated primary pools, standard ERC-20 LP verification does not apply to the
    // primary pool — any V2/Aerodrome pool reported here is SECONDARY exposure, not the
    // primary LP verification pool, so the public evidence labels must say so explicitly.
    const _concentratedPrimary = lpControl.proofApplicability === 'not_applicable' || lpControl.displayLpModel === 'concentrated_liquidity'
    const _primaryPoolLabel = _concentratedPrimary
      ? concentratedPoolDisplayLabel(concentratedPositionProof?.poolModel, lpDexId ?? lpDexName)
      : lpPoolType
    const _primaryMarketPoolLine = lpPoolAddress
      ? `Primary market pool: ${lpPoolAddress} (${_primaryPoolLabel})`
      : lpControl.primaryMarketPoolId
        ? `Primary market pool ID: ${lpControl.primaryMarketPoolId} (${_primaryPoolLabel})`
        : `Primary market pool: none (${_primaryPoolLabel})`

    lpControl.evidence = [
      ...(lpControl.evidence ?? []),
      `Market primary pair: ${marketPair}`,
      _primaryMarketPoolLine,
      _concentratedPrimary ? `Secondary ERC-20 LP exposure pair: ${lpPair}` : `LP verification pair: ${lpPair}`,
      _concentratedPrimary ? `Secondary ERC-20 LP exposure pool: ${_lpProofAddress ?? 'none'} (${_lpProofType})` : `LP verification pool: ${_lpProofAddress ?? 'none'} (${_lpProofType})`,
      lpVerifyPoolPresent && lpPool !== lpVerifyPool ? (_concentratedPrimary ? `Secondary pool differs from primary concentrated pool` : `V2 proof pool differs from market pool`) : '',
      _concentratedPrimary ? `Secondary exposure reason: ${lpReason}` : `LP verification reason: ${lpReason}`,
      `lpHolderCheckAttempted=${needsLpHolderFetch}`,
    ].filter(Boolean);

    // AI summary from parallel phase 2
    const _chainName = chain === 'eth' ? 'Ethereum' : 'Base'
    const _aiResult = _aiSettled.status === 'fulfilled' ? _aiSettled.value : null
    // Extract AI text early; aiSummary is computed later (after holder data resolves) to avoid stale holder wording
    let _aiTextEarly: string | null = null
    if (_aiResult && typeof _aiResult === 'object' && 'content' in _aiResult) {
      const _aiContent = (_aiResult as { content: Array<{type: string; text?: string}> }).content
      const _aiText = _aiContent?.[0]
      if (_aiText?.type === 'text' && _aiText.text) _aiTextEarly = _aiText.text
    }

    // ------------------------------
    // Resolve core token fields
    // ------------------------------
    const metaItem = metadata?.data?.items?.[0];
    const goldItem = goldrush?.data?.items?.[0];
    const gmgnItem = gmgn?.data;

    // GeckoTerminal direct token info (most reliable for name/symbol)
    const gtToken = gtTokenInfo?.data?.attributes ?? null;

    // Included token entries from the pools response (with ?include=base_token,quote_token)
    // (gtIncluded extracted earlier for pool type detection)
    const matchingTokenEntry = (gtIncluded as any[]).find((i: any) =>
      i.type === 'token' && i.attributes?.address?.toLowerCase() === contract.toLowerCase()
    );

    const resolvedName =
      gtToken?.name ||
      matchingTokenEntry?.attributes?.name ||
      metaItem?.contract_name ||
      goldItem?.contract_name ||
      gmgnItem?.name ||
      "Unknown";

    const resolvedSymbol =
      gtToken?.symbol ||
      matchingTokenEntry?.attributes?.symbol ||
      metaItem?.contract_ticker_symbol ||
      goldItem?.contract_ticker_symbol ||
      gmgnItem?.symbol ||
      "?";

    const rpcName = await rpcTokenString(chain, contract, '0x06fdde03')
    const rpcSymbol = await rpcTokenString(chain, contract, '0x95d89b41')

    // Upgrade name/symbol with RPC fallback when all API sources returned nothing.
    // CORTEX wording should use the same normalized identity as the final response.
    const finalResolvedName = (resolvedName && resolvedName !== 'Unknown') ? resolvedName : (rpcName ?? 'Unknown')
    const finalResolvedSymbol = (resolvedSymbol && resolvedSymbol !== '?') ? resolvedSymbol : (rpcSymbol ?? '?')

    const resolvedDecimals =
      gtToken?.decimals ||
      metaItem?.contract_decimals ||
      goldItem?.contract_decimals ||
      gmgnItem?.decimals ||
      18;

    
    // Moralis holder fallback — normalise to common shape so downstream code is unaware of source
    const _moralisHolderItems: any[] = Array.isArray(moralisHoldersRaw?.result)
      ? (moralisHoldersRaw.result as any[]).map((h: any) => ({
          address: h.owner_address ?? h.wallet_address ?? '',
          percentage: h.percentage_relative_to_total_supply ?? null,
          balance: h.balance ?? null,
        })).filter((h: any) => h.address)
      : []
    const holderResolverResult = await resolveTokenHolders({
      chain,
      chainId: CHAIN_ID_MAP[chain],
      tokenAddress: contract,
      limit: 200,
      providerHoldersRaw: holdersRaw,
      marketProviderHoldersRaw: moralisHoldersRaw,
    })
    const holderItems: any[] = holderResolverResult.holders.length > 0
      ? holderResolverResult.holders.map((h) => ({
          address: h.address,
          percentage: h.pctOfSupply ?? null,
          balance: h.balanceRaw,
          source: h.source,
        }))
      : []
    const _holderSource: 'goldrush' | 'moralis' | 'none' = holderResolverResult.holders.some((h) => h.source === 'goldrush_token_holders')
      ? 'goldrush'
      : holderResolverResult.holders.some((h) => h.source === 'moralis_token_owners')
        ? 'moralis'
        : 'none'
    console.log('[holders] items length', holderItems.length, 'source', _holderSource)

    const holderCount = holdersRaw?.data?.pagination?.total_count ?? holdersRaw?.pagination?.total_count ?? moralisHoldersRaw?.total ?? null
    const holderPctFromProvider: boolean[] = []
    const rawBalanceByAddress = new Map<string, unknown>()
    const topHolders = holderItems.slice(0, 200).map((h: any, i: number) => {
      const address = h.address || h.holder_address || h.wallet_address || h.wallet || h.owner_address || h.contract_address || ''
      const balanceRaw = h.balance ?? h.token_balance ?? h.amount ?? null
      const amount = toNum(balanceRaw) ?? toNum(h.balance_quote) ?? null
      const pctRaw = normalizeHolderPercent(h.percentage) ?? normalizeHolderPercent(h.percent) ?? normalizeHolderPercent(h.balancePercent) ?? normalizeHolderPercent(h.ownershipPercent) ?? normalizeHolderPercent(h.ownership_percentage) ?? normalizeHolderPercent(h.percent_of_supply) ?? normalizeHolderPercent(h.share) ?? normalizeHolderPercent(h.supply_percentage)
      const percent = pctRaw
      holderPctFromProvider.push(percent != null)
      if (address && balanceRaw != null) rawBalanceByAddress.set(address.toLowerCase(), balanceRaw)
      return { rank: i + 1, address, amount, percent }
    }).filter((h: any) => h.address)

    let percentRows = topHolders.filter((h: any) => h.percent != null)
    let hasPct = percentRows.length > 0
    const anyProviderPct = holderPctFromProvider.some(Boolean)
    let percentSource: 'provider' | 'calculated' | 'reconstructed' | 'inferred' = hasPct ? (anyProviderPct ? 'provider' : 'calculated') : 'inferred'
    const providerSanity = validateHolderPercentSanity(topHolders)
    const holderSanityDebug: {
      providerTop1: number | null
      providerTop5: number | null
      providerTop10: number | null
      providerTop20: number | null
      failedReason: string | null
      reconstructionAttempted: boolean
      reconstructionSucceeded: boolean
      finalPercentSource: 'provider' | 'calculated' | 'reconstructed' | 'inferred'
    } = {
      providerTop1: providerSanity.top1,
      providerTop5: providerSanity.top5,
      providerTop10: providerSanity.top10,
      providerTop20: providerSanity.top20,
      failedReason: providerSanity.sane ? null : 'holder_percentages_failed_sanity_check',
      reconstructionAttempted: false,
      reconstructionSucceeded: false,
      finalPercentSource: percentSource,
    }
    const holderProviderPercentFailedSanity = hasPct && !providerSanity.sane
    if (holderProviderPercentFailedSanity) {
      clearHolderPercentages(topHolders)
      hasPct = false
      percentSource = 'inferred'
      percentRows = []
    }
    console.log('[holders] normalized length', topHolders.length, '[holders] percent available', hasPct, '[holders] pct source', percentSource, '[holders] sanity', providerSanity.failedReason ?? 'ok')
    const sum = (n: number) => topHolders.slice(0, n).reduce((acc: number, h: any) => acc + (h.percent ?? 0), 0)
    let top1 = hasPct ? sum(1) : null
    let top5 = hasPct ? sum(5) : null
    let top10 = hasPct ? sum(10) : null
    let top20 = hasPct ? sum(20) : null

    // ── Holder percentage sanity check ────────────────────────────────────
    // Cumulative percentages must never exceed 100. If they do the provider
    // mixed fraction-encoded values (≤1) with true percentages, causing
    // normalizeHolderPercent to inflate them (0.67 → 67).
    const _providerTop1  = top1
    const _providerTop5  = top5
    const _providerTop10 = top10
    const _providerTop20 = top20
    const _sanityThreshold = 100
    const _holderSanityFailed = hasPct && (
      (top20 != null && top20 > _sanityThreshold) ||
      (top10 != null && top10 > _sanityThreshold) ||
      (top5  != null && top5  > _sanityThreshold)
    )
    let _holderSanityFailedReason: string | null = null
    let _holderSanityReconstructionAttempted = false
    let _holderSanityReconstructionSucceeded = false

    if (_holderSanityFailed) {
      _holderSanityFailedReason = top20 != null && top20 > _sanityThreshold
        ? `top20_exceeds_100pct:${top20.toFixed(2)}`
        : top10 != null && top10 > _sanityThreshold
          ? `top10_exceeds_100pct:${top10.toFixed(2)}`
          : `top5_exceeds_100pct:${(top5 ?? 0).toFixed(2)}`
      // Null out all provider percentages — they are corrupted
      for (const holder of topHolders as Array<{ percent: number | null }>) {
        holder.percent = null
      }
      hasPct = false
      percentSource = 'inferred'
      top1 = null; top5 = null; top10 = null; top20 = null
      _holderSanityReconstructionAttempted = true
    }

    // Fallback percent derivation: provider returned holder rows with raw balances but no percentage
    // field, or provider percentages failed sanity validation. Try real totalSupply() first.
    let _holderPctDerived = false
    let _holderPctDerivedFromSummedRows = false
    let _holderPctTotalSupplySource: string | null = null
    if (!hasPct && topHolders.length > 0 && rawBalanceByAddress.size > 0) {
      const _onchainVal = _onchainSettled.status === 'fulfilled'
        ? (_onchainSettled.value as Awaited<ReturnType<typeof fetchOnchainSupply>> | null)
        : null
      let totalSupplyBig: bigint | null = _onchainVal?.totalSupply ?? null
      if (totalSupplyBig != null && totalSupplyBig > BigInt(0)) {
        _holderPctTotalSupplySource = 'rpc_onchain'
      } else {
        const tsHex = alchemyMandatoryReads[5]
        if (tsHex && tsHex !== '0x' && tsHex !== '0x0') {
          try { totalSupplyBig = BigInt(tsHex); _holderPctTotalSupplySource = 'rpc_phase1' } catch {}
        }
      }
      if (!holderProviderPercentFailedSanity && (totalSupplyBig == null || totalSupplyBig <= BigInt(0)) && rawBalanceByAddress.size > 0) {
        let sumBig = BigInt(0)
        for (const rawBal of rawBalanceByAddress.values()) {
          try { sumBig += BigInt(String(rawBal)) } catch {}
        }
        if (sumBig > BigInt(0)) {
          totalSupplyBig = sumBig
          _holderPctDerivedFromSummedRows = true
          _holderPctTotalSupplySource = 'summed_returned_rows'
        }
      }
      if (totalSupplyBig != null && totalSupplyBig > BigInt(0)) {
        holderSanityDebug.reconstructionAttempted = holderProviderPercentFailedSanity || _holderPctTotalSupplySource !== 'summed_returned_rows'
        const derivedCount = deriveHolderPercentagesFromSupply(topHolders as Array<{ address: string; percent: number | null }>, rawBalanceByAddress, totalSupplyBig)
        if (derivedCount > 0) {
          const reconstructedSanity = validateHolderPercentSanity(topHolders)
          if (reconstructedSanity.sane) {
            hasPct = true
            percentSource = holderProviderPercentFailedSanity ? 'reconstructed' : 'calculated'
            top1 = sum(1); top5 = sum(5); top10 = sum(10); top20 = sum(20)
            _holderPctDerived = true
            holderSanityDebug.reconstructionSucceeded = holderProviderPercentFailedSanity
          } else {
            clearHolderPercentages(topHolders)
            hasPct = false
            percentSource = 'inferred'
            top1 = null; top5 = null; top10 = null; top20 = null
          }
        }
      }
    }

    // Record whether sanity-triggered reconstruction succeeded
    if (_holderSanityReconstructionAttempted) {
      _holderSanityReconstructionSucceeded = hasPct && _holderPctDerived
    }

    const normalizedTop = topHolders.slice(0, 200)
    holderSanityDebug.finalPercentSource = percentSource
    let holderDistribution: HolderDistribution = normalizedTop.length
      ? { top1, top5, top10, top20, others: hasPct && top20 != null ? Math.max(0, 100 - top20) : null, holderCount, topHolders: normalizedTop }
      : { top1: null, top5: null, top10: null, top20: null, others: null, holderCount: holderCount ?? null, topHolders: [] }
    let holderDistributionStatus: HolderDistributionStatus = normalizedTop.length > 0
      ? (hasPct
          ? {
              status: percentSource === 'reconstructed' || _holderPctDerivedFromSummedRows ? 'partial' : 'ok',
              reason: percentSource === 'reconstructed'
                ? 'holder_percentages_reconstructed_from_total_supply'
                : _holderPctDerived
                ? (_holderPctDerivedFromSummedRows ? 'percentages_estimated_from_returned_rows' : 'percentages_derived_from_rpc_supply')
                : 'holder_percentages_verified',
              itemCount: holderItems.length, normalizedCount: normalizedTop.length, percentSource,
            }
          : {
              status: 'partial',
              reason: holderProviderPercentFailedSanity ? 'holder_percentages_failed_sanity_check' : 'no_percentages',
              itemCount: holderItems.length, normalizedCount: normalizedTop.length, percentSource,
            })
      : {
          // No holder rows returned — use unavailable_with_reason, not partial (partial requires real evidence)
          status: (holdersRaw?.__status === 'error' ? 'error' : 'unavailable_with_reason') as HolderDistributionStatus['status'],
          reason: (holderResolverResult.reason ?? holdersRaw?.__reason ?? (holdersRaw?.__status === 'not_configured' ? 'api_key_missing' : 'no_holder_rows_returned')),
          itemCount: holderItems.length,
          normalizedCount: 0,
          percentSource,
        }
    let holderDerivationAttempted = false
    let holderDerivationSucceeded = false
    let holderDerivationFailureReason: string | null = null
    // Holder enrichment — derived signals for risk scoring
    const holderDataComplete = holderDistributionStatus.status === 'ok'
    const _whalePressureTop1 = top1 ?? null
    const _whalePressureTop5 = top5 ?? null
    // Use 'inferred' as default — never 'unverified'
    const whalePressure: 'high' | 'medium' | 'low' | 'inferred' =
      _whalePressureTop1 == null && _whalePressureTop5 == null ? 'inferred'
      : (_whalePressureTop1 != null && _whalePressureTop1 > 15) ? 'high'
      : (_whalePressureTop5 != null && _whalePressureTop5 > 40) ? 'high'
      : (_whalePressureTop5 != null && _whalePressureTop5 > 25) ? 'medium'
      : 'low'
    const holderRisk: 'high' | 'medium' | 'low' | 'inferred' =
      top10 == null ? 'inferred'
      : top10 > 70 ? 'high'
      : top10 > 50 ? 'high'
      : top10 > 35 ? 'medium'
      : 'low'
    const supplySpread: 'elevated' | 'normal' | 'inferred' =
      top10 == null ? 'inferred' : top10 > 35 ? 'elevated' : 'normal'

    const poolAttr = mainPool?.attributes ?? {}
    // True market cap priority:
    // 1) GeckoTerminal token endpoint attributes.market_cap_usd
    // 2) explicit market cap fields from token metadata responses (never FDV fields)
    const tokenEndpointMarketCap = pickNum(
      gtToken?.market_cap_usd,
      gtToken?.market_cap,
      gtTokenInfo?.data?.attributes?.market_cap_usd,
      gtTokenInfo?.data?.attributes?.market_cap,
      gtToken?.marketCap,
      gtToken?.market_cap_in_usd,
      goldItem?.market_cap,
      metaItem?.market_cap
    )
    const selectedPoolMarketCapUsd = pickNum(poolAttr.market_cap_usd, poolAttr.market_cap)
    const marketCapDiagnosticsResolved = resolveBaseRadarMarketCap({
      geckoPool: mainPool ? { attributes: poolAttr as Record<string, unknown> } : null,
      geckoIncludedToken: gtTokenInfo?.data?.attributes ?? gtToken ?? null,
      normalized: {
        marketCapUsd: pickNum(gtToken?.marketCap, gtToken?.market_cap_usd, goldItem?.market_cap, metaItem?.market_cap),
        marketCap: pickNum(gtToken?.market_cap, gtToken?.market_cap_in_usd),
      },
    })
    const marketCapFromGt = (tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0)
      ? tokenEndpointMarketCap
      : (selectedPoolMarketCapUsd != null && selectedPoolMarketCapUsd > 0 ? selectedPoolMarketCapUsd : null)
    const poolEndpointMarketCapPresent = toNum(poolAttr.market_cap_usd) != null;
    const circulatingSupply = pickNum(gtToken?.circulating_supply, goldItem?.circulating_supply, gmgnItem?.circulating_supply)
    const tokenPrice = pickNum(poolAttr.base_token_price_usd, gtToken?.price_usd, gtToken?.price)
    const marketCapSource = marketCapFromGt != null
      ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'geckoterminal' : 'coingecko_terminal')
      : 'none'
    const fdv = pickNum(gtToken?.fdv_usd, gtToken?.fdv, gtToken?.fully_diluted_valuation, poolAttr.fdv_usd, poolAttr.fdv, mainPool?.fdv_usd, goldItem?.fully_diluted_value, gmgnItem?.fdv)
    const fdvSource = fdv != null ? 'geckoterminal' : 'none'
    const marketCapValuationBasis = getRadarValuationBasis({
      marketCapUsd: marketCapDiagnosticsResolved.marketCapUsd,
      marketCapStatus: marketCapDiagnosticsResolved.marketCapStatus,
      fdvUsd: fdv,
      liquidityUsd: pickNum(mainPool?.attributes?.reserve_in_usd),
    })
    const priceUsd = tokenPrice
    // Tier B: onchain estimated MC — uses result from parallel phase 2 (no extra await)
    let estimatedMarketCap: number | null = null
    let estimatedMarketCapConfidence: 'medium' | 'low' = 'low'
    let estimatedMarketCapReason = ''
    if (marketCapFromGt == null && priceUsd != null) {
      const onchain = _onchainSettled.status === 'fulfilled' ? _onchainSettled.value as Awaited<ReturnType<typeof fetchOnchainSupply>> | null : null
      if (onchain?.totalSupply != null) {
        const decimalsNum = typeof resolvedDecimals === 'number' ? resolvedDecimals : (Number(resolvedDecimals) || _decEarly)
        const divisor = BigInt(10) ** BigInt(decimalsNum)
        const burned = (onchain.burnedZero ?? BigInt(0)) + (onchain.burnedDead ?? BigInt(0))
        const circulatingRaw = onchain.totalSupply - burned
        const circulatingHuman = Number(circulatingRaw) / Number(divisor)
        if (circulatingHuman > 0) {
          estimatedMarketCap = priceUsd * circulatingHuman
          estimatedMarketCapConfidence = (onchain.burnedZero != null || onchain.burnedDead != null) ? 'medium' : 'low'
          estimatedMarketCapReason = `Estimated from price × on-chain total supply${burned > BigInt(0) ? ' minus burn balances' : ''}. Circulating supply not fully verified.`
        }
      }
    }

    let displayMarketValue: number | null
    let displayMarketValueLabel: 'Market Cap' | 'Estimated MC' | 'FDV'
    let displayMarketValueConfidence: 'verified' | 'medium' | 'low'
    let displayMarketValueReason: string

    if (marketCapFromGt != null) {
      displayMarketValue = marketCapFromGt
      displayMarketValueLabel = 'Market Cap'
      displayMarketValueConfidence = 'verified'
      displayMarketValueReason = 'Verified market cap from live token market data.'
    } else if (fdv != null) {
      displayMarketValue = fdv
      displayMarketValueLabel = 'FDV'
      displayMarketValueConfidence = 'low'
      displayMarketValueReason = 'Market cap not yet confirmed; showing FDV because circulating supply is not verified.'
    } else {
      displayMarketValue = null
      displayMarketValueLabel = 'Market Cap'
      displayMarketValueConfidence = 'low'
      displayMarketValueReason = 'Market value not indexed — price or supply data not returned by active providers.'
    }

    const liquidityUsd = pickNum(mainPool?.attributes?.reserve_in_usd)
    const volume24hUsd = pickNum((mainPool?.attributes?.volume_usd as Record<string, unknown> | undefined)?.h24)
    // Pool activity — extracted from primary pool attributes, no extra API calls
    const _txns = mainPoolAttr.transactions as Record<string, unknown> | null | undefined
    const _txnsH24Any = _txns?.h24
    const _txnsH24Obj = _txnsH24Any && typeof _txnsH24Any === 'object' ? _txnsH24Any as Record<string, unknown> : null
    const _txnsH24Total = _txnsH24Any && typeof _txnsH24Any !== 'object' ? toNum(_txnsH24Any) : null
    const buys24h: number | null = _txnsH24Obj != null ? (toNum(_txnsH24Obj.buys) ?? toNum(_txnsH24Obj.buy) ?? null) : null
    const sells24h: number | null = _txnsH24Obj != null ? (toNum(_txnsH24Obj.sells) ?? toNum(_txnsH24Obj.sell) ?? null) : null
    const transactions24h: number | null = buys24h != null && sells24h != null ? buys24h + sells24h : (_txnsH24Total ?? null)
    const _volH24 = (mainPoolAttr.volume_usd as Record<string, unknown> | undefined)?.h24
    const _volH24Obj = typeof _volH24 === 'object' && _volH24 !== null ? _volH24 as Record<string, unknown> : null
    const splitCandidates: Array<{ key: string; value: unknown; side: 'buy'|'sell'|'total' }> = [
      { key: 'attributes.volume_usd.h24.buy', value: _volH24Obj?.buy, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sell', value: _volH24Obj?.sell, side: 'sell' },
      { key: 'attributes.volume_usd.h24.buys', value: _volH24Obj?.buys, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sells', value: _volH24Obj?.sells, side: 'sell' },
      { key: 'attributes.volume_usd.h24.buy_volume', value: _volH24Obj?.buy_volume, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sell_volume', value: _volH24Obj?.sell_volume, side: 'sell' },
      { key: 'attributes.volume_usd.h24.buy_volume_usd', value: _volH24Obj?.buy_volume_usd, side: 'buy' },
      { key: 'attributes.volume_usd.h24.sell_volume_usd', value: _volH24Obj?.sell_volume_usd, side: 'sell' },
      { key: 'attributes.buy_volume_usd.h24', value: (mainPoolAttr.buy_volume_usd as Record<string, unknown> | undefined)?.h24, side: 'buy' },
      { key: 'attributes.sell_volume_usd.h24', value: (mainPoolAttr.sell_volume_usd as Record<string, unknown> | undefined)?.h24, side: 'sell' },
      { key: 'attributes.volume_buy_usd.h24', value: (mainPoolAttr.volume_buy_usd as Record<string, unknown> | undefined)?.h24, side: 'buy' },
      { key: 'attributes.volume_sell_usd.h24', value: (mainPoolAttr.volume_sell_usd as Record<string, unknown> | undefined)?.h24, side: 'sell' },
      { key: 'attributes.buyVolumeUsd.h24', value: (mainPoolAttr.buyVolumeUsd as Record<string, unknown> | undefined)?.h24, side: 'buy' },
      { key: 'attributes.sellVolumeUsd.h24', value: (mainPoolAttr.sellVolumeUsd as Record<string, unknown> | undefined)?.h24, side: 'sell' },
      { key: 'attributes.buy_volume_usd_24h', value: mainPoolAttr.buy_volume_usd_24h, side: 'buy' },
      { key: 'attributes.sell_volume_usd_24h', value: mainPoolAttr.sell_volume_usd_24h, side: 'sell' },
      { key: 'attributes.volume_usd.h24.total', value: _volH24Obj?.total, side: 'total' },
      { key: 'attributes.volume_usd.h24', value: typeof _volH24 === 'object' ? null : _volH24, side: 'total' },
      { key: 'selectedPoolVolume24h', value: volume24hUsd, side: 'total' },
    ]
    const pickFrom = (side: 'buy'|'sell'|'total') => {
      for (const c of splitCandidates) {
        if (c.side !== side) continue
        const n = toNum(c.value)
        if (n != null) return { value: n, key: c.key }
      }
      return { value: null as number | null, key: null as string | null }
    }
    const buyPick = pickFrom('buy')
    const sellPick = pickFrom('sell')
    const totalPick = pickFrom('total')
    const buyVolume24hUsd: number | null = buyPick.value
    const sellVolume24hUsd: number | null = sellPick.value
    const resolvedVolume24hUsd: number | null = totalPick.value ?? volume24hUsd

    // Secondary market read — fires once, server-side, when primary has no pool/price/liquidity.
    // In debug-only mode, forceDexFallback=true skips primary market values and calls the
    // fallback directly so it can be verified from production without altering normal scans.
    const _primaryHasMarket = priceUsd != null || liquidityUsd != null
    const _fallbackNeeded = true
    let _dexFb: DexFallbackResult | null = null
    let marketDataSource: 'primary' | 'fallback' | 'none' = (_primaryHasMarket && !forceDexFallback) ? 'primary' : 'none'
    let marketConfidence: 'high' | 'medium' | 'low' = (_primaryHasMarket && !forceDexFallback) ? 'high' : 'low'
    _dexFb = dexFbEarly  // already fetched in phase 1 (cache hit if called again)
    if (_dexFb != null && (!_primaryHasMarket || forceDexFallback)) {
      marketDataSource = 'fallback'
      marketConfidence = 'medium'
    }

    if (debugMode) {
      console.log('[dex-fallback-debug]',
        'primaryMarketAvailable:', _primaryHasMarket,
        'forceDexFallback:', forceDexFallback,
        'fallbackAttempted:', _fallbackNeeded,
        'fallbackUsable:', _dexFb != null,
        'contract:', contract,
      )
    }

    // Effective market values:
    // - Normal scan: price priority DS > CG > GT pool > FDV-derived (last resort only)
    // - forceDexFallback (debug only): fallback values override primary
    const _cgMarketData = (coingeckoRaw as Record<string, unknown> | null | undefined)?.market_data as Record<string, unknown> | null | undefined
    const _geckoPrice = pickNum((_cgMarketData?.current_price as Record<string, unknown> | null | undefined)?.usd) ?? null
    const _efdv = forceDexFallback ? (_dexFb?.fdv ?? null) : (fdv ?? _dexFb?.fdv ?? null)
    // FDV-derived price: approximate price = FDV ÷ total supply in token units.
    // Only fires when no real price source (DS, CG, GT) is available.
    const _gtSupplyForFdv = pickNum(gtToken?.total_supply) ?? pickNum(gtToken?.circulating_supply) ?? circulatingSupply
    const _fdvDerivedPrice = (_efdv != null && _gtSupplyForFdv != null && _gtSupplyForFdv > 0 && priceUsd == null && (_dexFb?.priceUsd ?? null) == null && _geckoPrice == null)
      ? _efdv / _gtSupplyForFdv
      : null
    const _ep   = forceDexFallback ? (_dexFb?.priceUsd ?? null) : (_dexFb?.priceUsd ?? _geckoPrice ?? priceUsd ?? _fdvDerivedPrice ?? null)
    const _el   = forceDexFallback ? (_dexFb?.liquidityUsd ?? null)   : (liquidityUsd ?? _dexFb?.liquidityUsd ?? null)
    const _ev   = forceDexFallback ? (_dexFb?.volume24h ?? null)      : (resolvedVolume24hUsd ?? _dexFb?.volume24h ?? null)
    const _priceSource: 'dexscreener' | 'coingecko' | 'geckoterminal' | 'fdv_derived' | null =
      forceDexFallback ? (_dexFb?.priceUsd != null ? 'dexscreener' : null) :
      _dexFb?.priceUsd != null ? 'dexscreener' :
      _geckoPrice != null ? 'coingecko' :
      priceUsd != null ? 'geckoterminal' :
      _fdvDerivedPrice != null ? 'fdv_derived' :
      null
    // If fallback has FDV and primary displayMarketValue is null, show fallback FDV
    if (_dexFb?.fdv != null && displayMarketValue == null) {
      displayMarketValue = _dexFb.fdv
      displayMarketValueLabel = 'FDV'
      displayMarketValueConfidence = 'low'
      displayMarketValueReason = 'Market cap not indexed; FDV from fallback market read. Not verified as circulating market cap.'
    }

    const buySellVolumeSplitAvailable = buyVolume24hUsd != null && sellVolume24hUsd != null
    const buySellVolumeReason = buySellVolumeSplitAvailable ? 'split_exposed' : (resolvedVolume24hUsd != null ? 'only_total_exposed' : 'volume_not_exposed')
    const _chartNetworkIdMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon_pos', bnb: 'bsc' }
    const _chartNetworkId = _chartNetworkIdMap[chain] ?? 'base'
    const chartPoolCandidates = [mainPool, ...matchingPools.filter((p) => p !== mainPool)]
      .map((p) => {
        if (!p) return null
        const address = extractGeckoTerminalPoolAddress(p as Record<string, unknown>)
        if (!address) return null
        return {
          pool: p,
          poolId: String(p.id ?? ''),
          address,
          name: typeof p.attributes.name === 'string' ? p.attributes.name : null,
          dex: typeof p.attributes.dex_id === 'string' ? p.attributes.dex_id : null,
          poolType: detectPoolType(p, typeof p.attributes.dex_id === 'string' ? p.attributes.dex_id : undefined),
          liquidityUsd: toNum(p.attributes.reserve_in_usd),
          volume24hUsd: toNum((p.attributes.volume_usd as Record<string, unknown> | undefined)?.h24),
        }
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null)
      .sort((a, b) => ((b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)) || ((b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1)))
    const primaryAddr = extractGeckoTerminalPoolAddress(mainPool as Record<string, unknown> | null)?.toLowerCase() ?? ''
    chartPoolCandidates.sort((a, b) => {
      if (a.address.toLowerCase() === primaryAddr) return -1
      if (b.address.toLowerCase() === primaryAddr) return 1
      return 0
    })
    const uniqueChartPools = chartPoolCandidates.filter((c, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === c.address.toLowerCase()) === i)
    const tokenPositionForEachPool = uniqueChartPools.map((candidate) => poolTokenRelationshipDebug(candidate.pool as Record<string, unknown>, contract.toLowerCase(), _chartNetworkId))

    // Cache check — keyed by chain + token + primary pool
    const _chartCacheKey = `${chain}:${contract.toLowerCase()}:${primaryAddr || 'no_pool'}`
    const _chartCachedEntryRaw = _chartOhlcvCache.get(_chartCacheKey)
    const _chartCacheHit = _chartCachedEntryRaw != null && Date.now() - _chartCachedEntryRaw.ts < _chartCachedEntryRaw.ttl

    // Mutable chart pipeline state (populated from cache or fresh fetch)
    let priceChart: { timeframe: '24h'|'48h'|'7d'|'30d'; points: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number }>; sourceStatus: 'ok'|'partial'|'error'; reason?: string; fallbackUsed?: boolean } = {
      timeframe: '24h',
      points: [],
      sourceStatus: 'partial',
      reason: 'primary_pool_missing',
    }
    let chartAttemptedPools: Array<{ address: string; name: string | null; liquidityUsd: number | null }> = []
    let poolOhlcvAttempts: Array<{ poolId: string; poolAddress: string; tokenPosition: 'base' | 'quote'; timeframe: string; httpStatus?: number; rawPointCount: number; validPointCount: number; rejectedReason?: string }> = []
    let tokenOhlcvAttempts: Array<{ timeframe: string; httpStatus?: number; rawPointCount: number; validPointCount: number; rejectedReason?: string }> = []
    let tradePoolsAttempted: string[] = []
    let rejectedTradeReasons: Record<string, number> = {}
    let rawTradeCount = 0
    let validTradePriceCount = 0
    let chartFailureReason: string | null = null
    let chartSelectedPoolForChart: { address: string; name: string | null } | null = null
    let chartUsedTokenLevelOhlcv = false
    let chartTokenLevelAttempted = false
    let chartUsedDexScreener = false
    let dexScreenerChartAttempted = false
    let dexScreenerChartSuccess = false
    let chartUsedTradeReconstruction = false
    let chartTradeReconstructionAttempted = false
    let chartReconstructedCandleCount = 0
    let chartUsedSyntheticCandles = false
    let chartUsedFlatSynthetic = false
    let chartAttemptedTimeframes: string[] = []
    let _totalChartHttpCalls = 0
    let _ohlcvRateLimited = false
    let _ohlcvRateLimitedAt: string | null = null
    let _skippedDueToRateLimit = 0

    if (_chartCacheHit && _chartCachedEntryRaw) {
      const cv = _chartCachedEntryRaw.v
      priceChart = { ...cv.priceChart }
      chartAttemptedPools = [...cv.chartAttemptedPools]
      poolOhlcvAttempts = [...cv.poolOhlcvAttempts]
      tokenOhlcvAttempts = [...cv.tokenOhlcvAttempts]
      tradePoolsAttempted = [...cv.tradePoolsAttempted]
      rejectedTradeReasons = { ...cv.rejectedTradeReasons }
      rawTradeCount = cv.rawTradeCount
      validTradePriceCount = cv.validTradePriceCount
      chartReconstructedCandleCount = cv.chartReconstructedCandleCount
      chartSelectedPoolForChart = cv.chartSelectedPoolForChart
      chartFailureReason = cv.chartFailureReason
      chartUsedTradeReconstruction = cv.chartUsedTradeReconstruction
      chartUsedTokenLevelOhlcv = cv.chartUsedTokenLevelOhlcv
      chartUsedDexScreener = cv.chartUsedDexScreener
      chartUsedSyntheticCandles = cv.chartUsedSyntheticCandles
      chartUsedFlatSynthetic = cv.chartUsedFlatSynthetic
      dexScreenerChartAttempted = cv.dexScreenerChartAttempted
      dexScreenerChartSuccess = cv.dexScreenerChartSuccess
      chartTradeReconstructionAttempted = cv.chartTradeReconstructionAttempted
      chartTokenLevelAttempted = cv.chartTokenLevelAttempted
      chartAttemptedTimeframes = [...cv.chartAttemptedTimeframes]
      _totalChartHttpCalls = cv.totalChartHttpCalls
      _ohlcvRateLimited = cv.rateLimited
      _ohlcvRateLimitedAt = cv.rateLimitedAt
      _skippedDueToRateLimit = cv.skippedDueToRateLimit
    } else {
      const _MAX_OHLCV_CALLS = 10
      const _primaryTimeframes: Array<{ key: '24h'|'48h'|'7d'|'30d'; resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }> = [
        { key: '24h', resolution: 'minute', aggregate: 15, limit: 96 },
        { key: '48h', resolution: 'hour', aggregate: 1, limit: 48 },
        { key: '7d', resolution: 'day', aggregate: 1, limit: 7 },
      ]

      // Phase 1: primary pool, up to 3 timeframes (stop on first success or 429)
      if (uniqueChartPools.length > 0) {
        const candidate = uniqueChartPools[0]
        const resolvedTokenPos = resolveTokenPositionInPool(candidate.pool as Record<string, unknown>, contract.toLowerCase(), _chartNetworkId)
        const tokenPositions: Array<'base' | 'quote'> = resolvedTokenPos ? [resolvedTokenPos] : ['base', 'quote']
        chartAttemptedPools.push({ address: candidate.address, name: candidate.name, liquidityUsd: candidate.liquidityUsd })
        phase1: for (const tokenPos of tokenPositions) {
          for (const tf of _primaryTimeframes) {
            if (_totalChartHttpCalls >= _MAX_OHLCV_CALLS || _ohlcvRateLimited) { _skippedDueToRateLimit++; break phase1 }
            chartAttemptedTimeframes.push(`${tf.key}:${tf.resolution}/${tf.aggregate}x${tf.limit}:${tokenPos}`)
            _totalChartHttpCalls++
            const chartRaw = await fetchGeckoTerminalPoolOhlcv(candidate.address, chain, tf, tokenPos)
            if (chartRaw.httpStatus === 429) {
              _ohlcvRateLimited = true
              _ohlcvRateLimitedAt = tf.key
              poolOhlcvAttempts.push({ poolId: candidate.poolId, poolAddress: candidate.address, tokenPosition: tokenPos, timeframe: tf.key, httpStatus: 429, rawPointCount: 0, validPointCount: 0, rejectedReason: 'rate_limited' })
              break phase1
            }
            const normalized = normalizeOhlcvRows(chartRaw.json?.data?.attributes?.ohlcv_list)
            poolOhlcvAttempts.push({ poolId: candidate.poolId, poolAddress: candidate.address, tokenPosition: tokenPos, timeframe: tf.key, ...(chartRaw.httpStatus != null ? { httpStatus: chartRaw.httpStatus } : {}), rawPointCount: normalized.rawPointCount, validPointCount: normalized.validPointCount, ...(normalized.rejectedReason ? { rejectedReason: normalized.rejectedReason } : {}) })
            if (normalized.points.length >= 2) {
              priceChart = { timeframe: tf.key, points: normalized.points, sourceStatus: 'ok' }
              chartSelectedPoolForChart = { address: candidate.address, name: candidate.name }
              chartFailureReason = null
              break phase1
            }
            chartFailureReason = normalized.rejectedReason ?? 'insufficient_points'
          }
          if (priceChart.sourceStatus === 'ok') break
        }
      } else {
        chartFailureReason = 'primary_pool_missing'
      }

      // Phase 2: token-level OHLCV, up to 3 timeframes (stop on first success or 429)
      if (priceChart.sourceStatus !== 'ok' && !_ohlcvRateLimited) {
        chartTokenLevelAttempted = true
        for (const tf of _primaryTimeframes) {
          if (_totalChartHttpCalls >= _MAX_OHLCV_CALLS || _ohlcvRateLimited) { _skippedDueToRateLimit++; break }
          chartAttemptedTimeframes.push(`token_level:${tf.key}:${tf.resolution}/${tf.aggregate}x${tf.limit}`)
          _totalChartHttpCalls++
          const chartRaw = await fetchGeckoTerminalTokenOhlcv(contract, chain, tf)
          if (chartRaw.httpStatus === 429) {
            _ohlcvRateLimited = true
            _ohlcvRateLimitedAt = tf.key
            tokenOhlcvAttempts.push({ timeframe: tf.key, httpStatus: 429, rawPointCount: 0, validPointCount: 0, rejectedReason: 'rate_limited' })
            break
          }
          const normalized = normalizeOhlcvRows(chartRaw.json?.data?.attributes?.ohlcv_list)
          tokenOhlcvAttempts.push({ timeframe: tf.key, ...(chartRaw.httpStatus != null ? { httpStatus: chartRaw.httpStatus } : {}), rawPointCount: normalized.rawPointCount, validPointCount: normalized.validPointCount, ...(normalized.rejectedReason ? { rejectedReason: normalized.rejectedReason } : {}) })
          if (normalized.points.length >= 2) {
            priceChart = { timeframe: tf.key, points: normalized.points, sourceStatus: 'ok' }
            chartFailureReason = null
            chartUsedTokenLevelOhlcv = true
            break
          }
          chartFailureReason = normalized.rejectedReason ? `token_${normalized.rejectedReason}` : 'token_ohlcv_insufficient_points'
        }
      }

      // Phase 3: up to 2 alternate pools, 24h only (stop on first success or 429)
      if (priceChart.sourceStatus !== 'ok' && !_ohlcvRateLimited && uniqueChartPools.length > 1) {
        const _altTf = _primaryTimeframes[0]
        for (const candidate of uniqueChartPools.slice(1, 3)) {
          if (_totalChartHttpCalls >= _MAX_OHLCV_CALLS || _ohlcvRateLimited) { _skippedDueToRateLimit++; break }
          const resolvedTokenPos = resolveTokenPositionInPool(candidate.pool as Record<string, unknown>, contract.toLowerCase(), _chartNetworkId)
          const tokenPositions: Array<'base' | 'quote'> = resolvedTokenPos ? [resolvedTokenPos] : ['base', 'quote']
          chartAttemptedPools.push({ address: candidate.address, name: candidate.name, liquidityUsd: candidate.liquidityUsd })
          let _altPoolSuccess = false
          phase3: for (const tokenPos of tokenPositions) {
            if (_totalChartHttpCalls >= _MAX_OHLCV_CALLS || _ohlcvRateLimited) { _skippedDueToRateLimit++; break phase3 }
            chartAttemptedTimeframes.push(`${_altTf.key}:${_altTf.resolution}/${_altTf.aggregate}x${_altTf.limit}:${tokenPos}`)
            _totalChartHttpCalls++
            const chartRaw = await fetchGeckoTerminalPoolOhlcv(candidate.address, chain, _altTf, tokenPos)
            if (chartRaw.httpStatus === 429) {
              _ohlcvRateLimited = true
              _ohlcvRateLimitedAt = _altTf.key
              poolOhlcvAttempts.push({ poolId: candidate.poolId, poolAddress: candidate.address, tokenPosition: tokenPos, timeframe: _altTf.key, httpStatus: 429, rawPointCount: 0, validPointCount: 0, rejectedReason: 'rate_limited' })
              break phase3
            }
            const normalized = normalizeOhlcvRows(chartRaw.json?.data?.attributes?.ohlcv_list)
            poolOhlcvAttempts.push({ poolId: candidate.poolId, poolAddress: candidate.address, tokenPosition: tokenPos, timeframe: _altTf.key, ...(chartRaw.httpStatus != null ? { httpStatus: chartRaw.httpStatus } : {}), rawPointCount: normalized.rawPointCount, validPointCount: normalized.validPointCount, ...(normalized.rejectedReason ? { rejectedReason: normalized.rejectedReason } : {}) })
            if (normalized.points.length >= 2) {
              priceChart = { timeframe: _altTf.key, points: normalized.points, sourceStatus: 'ok' }
              chartSelectedPoolForChart = { address: candidate.address, name: candidate.name }
              chartFailureReason = null
              _altPoolSuccess = true
              break phase3
            }
            chartFailureReason = normalized.rejectedReason ?? 'insufficient_points'
          }
          if (_altPoolSuccess || priceChart.sourceStatus === 'ok') break
        }
      }

      // Phase 4: DexScreener OHLCV — gated off. The DexScreener pairs endpoint does not
      // currently return chart/candle data, so this phase would only waste a request.
      // Diagnostics are preserved as a placeholder for forward-compatibility.
      if (priceChart.sourceStatus !== 'ok' && _dexFb?.pairAddress) {
        dexScreenerChartAttempted = false
      }

      // Phase 5: trade reconstruction, max 2 pools
      if (priceChart.sourceStatus !== 'ok') {
        chartTradeReconstructionAttempted = true
        for (const poolCandidate of uniqueChartPools.slice(0, 2)) {
          chartAttemptedTimeframes.push(`trade_recon:${poolCandidate.address.slice(0, 10)}`)
          tradePoolsAttempted.push(poolCandidate.address)
          const tradesRaw = await fetchGeckoTerminalPoolTrades(poolCandidate.address, chain)
          const tradesArr: unknown[] = Array.isArray(tradesRaw.json?.data) ? tradesRaw.json.data : []
          const reconstructed = reconstructCandlesFromTrades(tradesArr, priceUsd)
          rawTradeCount = Math.max(rawTradeCount, reconstructed.rawTradeCount)
          validTradePriceCount = Math.max(validTradePriceCount, reconstructed.validTradePriceCount)
          for (const [reason, count] of Object.entries(reconstructed.rejectedTradeReasons)) {
            rejectedTradeReasons[reason] = (rejectedTradeReasons[reason] ?? 0) + count
          }
          if (reconstructed.candles.length >= 2) {
            chartReconstructedCandleCount = reconstructed.candles.length
            priceChart = { timeframe: '24h', points: reconstructed.candles, sourceStatus: 'ok' }
            chartFailureReason = null
            chartUsedTradeReconstruction = true
            break
          }
        }
        if (!chartUsedTradeReconstruction) {
          chartFailureReason = chartFailureReason ?? 'trade_reconstruction_insufficient'
        }
      }

      // Phase 6: Synthetic micro-candles — final fallback that always fires when a live price exists.
      // Uses real indexed % changes (h24/h6/h1/m5) to back-calculate historical anchor prices.
      // When no % changes are available, falls back to a flat 24h series at the current price.
      // No randomness, no fabricated spread. Each candle spans two adjacent anchors only.
      const _synthLivePrice = _ep ?? priceUsd
      if (priceChart.sourceStatus !== 'ok' && _synthLivePrice != null && _synthLivePrice > 0) {
        const _pcPctSynth = mainPoolAttr.price_change_percentage as Record<string, unknown> | null | undefined
        const _synthH24 = pickNum(_pcPctSynth?.h24) ?? _dexFb?.priceChange24h ?? null
        const _synthH6  = pickNum(_pcPctSynth?.h6)  ?? null
        const _synthH1  = pickNum(_pcPctSynth?.h1)  ?? null
        const _synthM5  = pickNum(_pcPctSynth?.m5)  ?? null
        const _synthUsedPctChanges = _synthH24 != null || _synthH6 != null || _synthH1 != null || _synthM5 != null
        const _nowSec = Math.floor(Date.now() / 1000)
        const _synthAnchors: Array<{ ts: number; price: number }> = [{ ts: _nowSec, price: _synthLivePrice }]
        if (_synthH24 != null) _synthAnchors.push({ ts: _nowSec - 86400, price: _synthLivePrice / (1 + _synthH24 / 100) })
        if (_synthH6  != null) _synthAnchors.push({ ts: _nowSec - 21600, price: _synthLivePrice / (1 + _synthH6  / 100) })
        if (_synthH1  != null) _synthAnchors.push({ ts: _nowSec -  3600, price: _synthLivePrice / (1 + _synthH1  / 100) })
        if (_synthM5  != null) _synthAnchors.push({ ts: _nowSec -   300, price: _synthLivePrice / (1 + _synthM5  / 100) })
        _synthAnchors.sort((a, b) => a.ts - b.ts)
        const _validAnchors = _synthAnchors.filter((p) => p.price > 0)
        // Guarantee at least 2 anchors: if only current price is known, prepend a flat 24h-ago
        // anchor at the same price. Result is a zero-change flat line — honest with no history.
        if (_validAnchors.length < 2) _validAnchors.unshift({ ts: _nowSec - 86400, price: _synthLivePrice })
        if (_validAnchors.length >= 2) {
          const _synthPoints = _validAnchors.map((p, i, arr) => {
            const prevPrice = i > 0 ? arr[i - 1].price : p.price
            const price = p.price
            return {
              timestamp: new Date(p.ts * 1000).toISOString(),
              open: prevPrice,
              high: Math.max(prevPrice, price),
              low: Math.min(prevPrice, price),
              close: price,
              volume: null as number | null,
              priceUsd: price,
            }
          })
          priceChart = { timeframe: '24h', points: _synthPoints, sourceStatus: 'ok' }
          chartFailureReason = null
          chartUsedSyntheticCandles = true
          chartUsedFlatSynthetic = !_synthUsedPctChanges
        }
      }

      // Finalize priceChart if still not ok
      const _anyChartAttempted = chartAttemptedPools.length > 0 || chartTokenLevelAttempted || dexScreenerChartAttempted || chartTradeReconstructionAttempted
      if (priceChart.sourceStatus !== 'ok' && _anyChartAttempted) {
        priceChart = { timeframe: '24h', points: [], sourceStatus: 'partial', reason: _ohlcvRateLimited ? 'chart_provider_rate_limited' : (chartFailureReason ?? 'all_chart_sources_empty') }
      }

      // Store result in cache (TTL: 90s if rate-limited, 5min if real candles ok, 60s otherwise)
      const _chartTtl = _ohlcvRateLimited ? 90000 : (priceChart.sourceStatus === 'ok' && !chartUsedSyntheticCandles ? 300000 : 60000)
      _chartOhlcvCache.set(_chartCacheKey, {
        v: {
          priceChart: { ...priceChart },
          chartUsedTradeReconstruction,
          chartUsedTokenLevelOhlcv,
          chartUsedDexScreener,
          chartUsedSyntheticCandles,
          chartUsedFlatSynthetic,
          dexScreenerChartAttempted,
          dexScreenerChartSuccess,
          chartTradeReconstructionAttempted,
          chartTokenLevelAttempted,
          poolOhlcvAttempts: [...poolOhlcvAttempts],
          tokenOhlcvAttempts: [...tokenOhlcvAttempts],
          rawTradeCount,
          validTradePriceCount,
          chartReconstructedCandleCount,
          tradePoolsAttempted: [...tradePoolsAttempted],
          rejectedTradeReasons: { ...rejectedTradeReasons },
          chartAttemptedTimeframes: [...chartAttemptedTimeframes],
          chartAttemptedPools: [...chartAttemptedPools],
          chartSelectedPoolForChart,
          chartFailureReason,
          totalChartHttpCalls: _totalChartHttpCalls,
          rateLimited: _ohlcvRateLimited,
          rateLimitedAt: _ohlcvRateLimitedAt,
          skippedDueToRateLimit: _skippedDueToRateLimit,
        },
        ts: Date.now(),
        ttl: _chartTtl,
      })
    }

    const chartAttempted = chartAttemptedPools.length > 0 || chartUsedTokenLevelOhlcv || dexScreenerChartAttempted || chartTradeReconstructionAttempted
    const chartFallbackUsed = (chartSelectedPoolForChart != null && chartSelectedPoolForChart.address.toLowerCase() !== primaryAddr) || chartUsedTokenLevelOhlcv || chartUsedDexScreener || chartUsedTradeReconstruction
    if (priceChart.sourceStatus === 'ok') priceChart.fallbackUsed = chartFallbackUsed
    const chartStatus: 'ok' | 'snapshot_only' | 'unavailable_with_reason' =
      priceChart.sourceStatus === 'ok' ? 'ok' :
      noActivePools ? 'unavailable_with_reason' :
      'snapshot_only'
    const chartSource: string | null =
      chartStatus !== 'ok' ? null :
      chartUsedTradeReconstruction ? 'trade_reconstructed' :
      chartUsedDexScreener ? 'dexscreener_ohlcv' :
      chartUsedTokenLevelOhlcv ? 'token_level_ohlcv' :
      chartUsedSyntheticCandles ? (chartUsedFlatSynthetic ? 'synthetic_flat_series' : 'synthetic_price_estimate') :
      'pool_ohlcv'
    const chartReason: string | null =
      chartStatus === 'ok'
        ? (chartUsedTradeReconstruction ? 'trade_reconstructed_from_recent_swaps'
           : chartUsedDexScreener ? 'dexscreener_ohlcv_used'
           : chartUsedTokenLevelOhlcv ? 'token_level_ohlcv_used'
           : chartUsedFlatSynthetic ? 'synthetic_flat_series_no_history'
           : chartUsedSyntheticCandles ? 'synthetic_from_indexed_changes'
           : chartFallbackUsed ? 'alternate_pool_used'
           : null)
        : (_ohlcvRateLimited ? 'chart_provider_rate_limited' : (chartFailureReason ?? 'all_chart_sources_empty'))
    const chartDataSource: 'primary' | 'fallback' | 'none' =
      priceChart.sourceStatus === 'ok' ? (chartFallbackUsed ? 'fallback' : 'primary') :
      marketDataSource === 'fallback' ? 'fallback' :
      'none'
    const pairCreatedAt = String(mainPoolAttr.pool_created_at ?? '').trim() || null
    const pairAgeLabel = pairCreatedAt ? computePairAge(pairCreatedAt) : null
    const poolCount = matchingPools.length
    const observedPoolPresent = Boolean(lpDiagnostics.poolDetected || lpDiagnostics.primaryMarketPoolAddress || lpDiagnostics.lpVerificationPoolAddress)
    const observedPoolCount: number | null = poolCount > 0 ? poolCount : (observedPoolPresent ? null : 0)
    // Fallback-market normalization: when the primary pool read has no usable pair timestamp
    // or pool count but the secondary market read confirms a single usable pool address with
    // liquidity, surface that evidence instead of leaving LP context as null/unknown.
    const fallbackPairIdentityPresent = Boolean(_dexFb?.pairAddress && /^0x[a-f0-9]{40}$/i.test(_dexFb.pairAddress))
    const fallbackPoolEvidencePresent = Boolean(_fallbackLiquidityDetected && fallbackPairIdentityPresent)
    const normalizedPairCreatedAt = normalizePairCreatedAtValue(pairCreatedAt) ?? normalizePairCreatedAtValue(_dexFb?.pairCreatedAt)
    const normalizedObservedPoolCount: number | null = poolCount > 0
      ? poolCount
      : (observedPoolPresent || fallbackPoolEvidencePresent ? 1 : 0)
    const normalizedPairAgeLabel = pairAgeLabel ?? (normalizedPairCreatedAt ? computePairAge(normalizedPairCreatedAt) : null)
    const poolCountStatus: 'confirmed' | 'inferred_from_primary_pool' | 'unknown' = poolCount > 0 || fallbackPoolEvidencePresent
      ? 'confirmed'
      : observedPoolPresent
        ? 'inferred_from_primary_pool'
        : 'unknown'

    // marketTrendSnapshot — real market change fields, never fake candles.
    // Built from indexed pool price_change_percentage and existing market fields.
    // Returned whenever OHLCV candles are unavailable so the UI can render a
    // useful chart-area panel instead of a blank placeholder.
    const _pcPct = mainPoolAttr.price_change_percentage as Record<string, unknown> | null | undefined
    const _mtsChanges = [
      { label: '5m',  value: pickNum(_pcPct?.m5)  ?? null },
      { label: '1h',  value: pickNum(_pcPct?.h1)  ?? null },
      { label: '6h',  value: pickNum(_pcPct?.h6)  ?? null },
      { label: '24h', value: pickNum(_pcPct?.h24) ?? _dexFb?.priceChange24h ?? null },
    ] as Array<{ label: string; value: number | null }>
    const marketTrendSnapshot = {
      status: (_ep != null || _el != null || _mtsChanges.some(c => c.value != null)) ? 'ok' as const : 'unavailable' as const,
      source: 'market_change_fields' as const,
      price: _ep ?? null,
      changes: _mtsChanges,
      liquidity: _el ?? null,
      volume24h: _ev ?? null,
      transactions24h: transactions24h ?? null,
      buys24h: buys24h ?? null,
      sells24h: sells24h ?? null,
      pairAge: pairAgeLabel ?? null,
    }
    if (process.env.NODE_ENV === "development") {
      console.log('[gt-market] contract', contract, '[gt-market] token status', gtTokenInfo ? 'ok' : 'empty', '[gt-market] pools count', matchingPools.length, '[gt-market] tokenEndpointMarketCapPresent', tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0, '[gt-market] poolEndpointMarketCapPresent', poolEndpointMarketCapPresent, '[gt-market] marketCap available', marketCapFromGt != null, '[gt-market] fdv available', fdv != null)
    }
    // Security fallbacks are disabled: risk layer uses active scan providers only.
    const gpHasData = false
    const gpHoneypot: null = null
    const gpMint = null
    const gpUpgradeable = null
    const gpBlacklist = null

    // Final JSON response
    const marketStatus: "ok" | "fallback_ok" | "partial" | "no_pool_found" | "error" =
      (_ep != null && _el != null && _ev != null && marketDataSource === 'primary') ? "ok" :
      (_ep != null && _el != null && marketDataSource === 'fallback') ? "fallback_ok" :
      (_ep != null || _el != null || _ev != null || _efdv != null) ? "partial" :
      "no_pool_found";
    const marketReason = marketStatus === "ok" ? null
      : marketStatus === "fallback_ok" ? "market_data_from_secondary_source"
      : marketCapFromGt == null ? "market_cap_not_resolved_supply_not_verified"
      : "partial_market_fields_from_provider";
    // Declare early so securityStatus and later flag resolution can both use it
    const _simImpliedClean = hpResult.ok === true && hpResult.honeypot === false && hpResult.simulationSuccess === true
    const securityStatus: "ok" | "partial" | "inferred" | "error" =
      hpResult.ok ? "ok" : _simImpliedClean ? "partial" : "inferred";
    const simulationOpenReason = hpResult.ok
      ? null
      : !fallbackPoolEvidencePresent && !observedPoolPresent
        ? 'insufficient route/pool evidence'
        : !(_dexFb?.pairAddress || lpPoolAddress)
          ? 'missing pair address'
          : lpModelProof.model === 'concentrated'
            ? 'unsupported pool model'
            : 'timeout'
    const securityReason = hpResult.ok ? null : _simImpliedClean ? "simulation_implied_clean" : simulationOpenReason;
    const holdersStatus: CanonicalStatus =
      holderDistributionStatus.status === 'ok' ? 'verified' :
      holderDistributionStatus.status === 'partial' ? 'partial' :
      holderDistributionStatus.status === 'unavailable_with_reason' ? 'unavailable_with_reason' :
      holderDistributionStatus.status === 'error' ? 'unavailable_with_reason' :
      'inferred';
    const holdersRawStatus = holderDistributionStatus.status
    const holdersReason = holdersStatus === "verified" ? null : safeHolderReason(holderDistributionStatus?.reason ?? "holder_data_not_indexed_for_chain");
    const liquidityStatus: "ok" | "partial" | "inferred" | "error" =
      mainPool ? "ok" : (_dexFb?.liquidityUsd != null ? "partial" : (matchingPools.length > 0 ? "partial" : "inferred"));
    const liquidityReason = mainPool ? null : (_dexFb?.liquidityUsd != null ? "liquidity_from_fallback_market_read" : "no_active_liquidity_pool_found");
    const ownerCall = _ownerHexForLp ?? alchemyMandatoryReads[0] ?? alchemyMandatoryReads[1] ?? alchemyMandatoryReads[2] ?? alchemyMandatoryReads[3] ?? await countedRpcCall('eth_call', [{ to: contract, data: '0x8da5cb5b' }, 'latest'], 'ownerCheck', false)
    let ownerAddr = ownerCall && ownerCall.length >= 42 ? `0x${ownerCall.slice(-40)}`.toLowerCase() : null
    // Deployer fallback: extract from Moralis mint transfer when RPC selectors all return null OR when
    // owner() returned zero (renounced). A mint event (from=0x0) points to the initial recipient —
    // the deployer's distribution wallet. When renounced (ownerAddr=zero), we still want Dev Control
    // to identify the original deployer; we do NOT overwrite ownerAddr so isRenounced stays correct.
    let _ownerFromTransfer: string | null = null
    if ((!ownerAddr || ownerAddr === '0x0000000000000000000000000000000000000000') && Array.isArray(moralisTransfersRaw?.result) && (moralisTransfersRaw.result as any[]).length > 0) {
      const _ZERO = '0x0000000000000000000000000000000000000000'
      const _mints = (moralisTransfersRaw.result as any[]).filter((t: any) =>
        typeof t.from_address === 'string' && t.from_address.toLowerCase() === _ZERO &&
        typeof t.to_address === 'string' && /^0x[a-f0-9]{40}$/i.test(t.to_address) && t.to_address.toLowerCase() !== _ZERO
      )
      if (_mints.length > 0) {
        const _earliest = _mints.sort((a: any, b: any) => parseInt(a.block_number ?? '0') - parseInt(b.block_number ?? '0'))[0]
        _ownerFromTransfer = _earliest.to_address?.toLowerCase() ?? null
        if (!ownerAddr) ownerAddr = _ownerFromTransfer // only set ownerAddr when truly null; zero stays zero to preserve isRenounced
      }
    }
    // Ownership / control derivation — RPC-sourced admin and proxy implementation
    const _adminHex = alchemyMandatoryReads[2] ?? alchemyMandatoryReads[3] ?? null
    const adminAddr = _adminHex && _adminHex.length >= 42 && _adminHex !== '0x' ? `0x${_adminHex.slice(-40)}`.toLowerCase() : null
    const _implHex = alchemyMandatoryReads[4] ?? null
    const _ZERO_ADDR = '0x0000000000000000000000000000000000000000'
    const proxyImplAddr = _implHex && _implHex.length >= 42 && _implHex !== '0x' ? `0x${_implHex.slice(-40)}`.toLowerCase() : null
    // Only mark renounced/verified when RPC was attempted (alchemyConfigured).
    // ownerAddr === zero means owner()/getOwner()/admin() explicitly returned the zero
    // address (confirmed renounced) — distinct from ownerAddr === null, which means no
    // owner-style selector returned usable data (status unknown, NOT renounced).
    const rpcOwnershipAttempted = alchemyConfigured
    const _ownerConfirmedZero = ownerAddr === _ZERO_ADDR
    const _ownerConfirmedActive = Boolean((ownerAddr && ownerAddr !== _ZERO_ADDR) || adminAddr)
    // ownershipVerified: RPC gave a definitive answer — either a confirmed zero (renounced)
    // or a confirmed active owner/admin address.
    const ownershipVerified = rpcOwnershipAttempted && (_ownerConfirmedZero || _ownerConfirmedActive)
    // isRenounced requires BOTH ownershipVerified AND a confirmed zero owner address —
    // never inferred from a missing/unresolved owner() call.
    const isRenounced = ownershipVerified && _ownerConfirmedZero
    // Canonical ownership status — single source of truth for aiSummary, riskEngine,
    // sections.ownership, and CORTEX/Clark text. 'open_check' (not 'inferred_active')
    // when ownership was never verified, so wording never implies an unverified active owner.
    const _ownershipStatusFinal: 'renounced' | 'held' | 'open_check' = isRenounced ? 'renounced' : (ownershipVerified ? 'held' : 'open_check')
    // Canonical owner address for display: shows the confirmed zero address when renounced
    // is verified (proof of renouncement), null only when ownership is an open check.
    const _ownerAddressForDisplay = _ownerConfirmedZero ? _ZERO_ADDR : (ownerAddr ?? null)
    // devOwnership-facing status/label: an RPC-verified active owner/admin address must be
    // reported as such ("active_owner"), never as "open_check" / "Ownership not verified" —
    // that wording is reserved for when ownership evidence was never resolved.
    const ownershipStatus: 'renounced' | 'active_owner' | 'open_check' = isRenounced
      ? 'renounced'
      : (ownershipVerified && _ownerConfirmedActive) ? 'active_owner' : 'open_check'
    const ownershipLabel = isRenounced
      ? 'Ownership renounced / verified zero address'
      : (ownershipVerified && _ownerConfirmedActive) ? 'Active owner/admin verified' : 'Ownership not verified'
    const rpcSupply = await countedRpcCall('eth_call', [{ to: contract, data: '0x18160ddd' }, 'latest'], 'totalSupplyCheck', true)
    const rpcDecimalsHex = await countedRpcCall('eth_call', [{ to: contract, data: '0x313ce567' }, 'latest'], 'decimalsCheck', true)

    // CORTEX Contract Flag Scanner — bytecode selector scan + 2 RPC probes
    const _hasBytecode = Boolean(bytecode && bytecode !== '0x' && bytecode.length > 10)
    const _bytecodeLc = _hasBytecode ? bytecode!.toLowerCase() : ''
    // PUSH4 opcode (0x63) followed by 4-byte selector in deployed bytecode
    const _selPresent = (sel4: string) => _hasBytecode && _bytecodeLc.includes('63' + sel4)
    const _cortexMintSel = _selPresent('40c10f19') || _selPresent('a0712d68')    // mint(address,uint256) | mint(uint256)
    const _cortexProxySel = _selPresent('3659cfe6') || _selPresent('4f1ef286') || _selPresent('52d1902d') // upgradeTo | upgradeToAndCall | proxiableUUID
    const _cortexPauseSel = _selPresent('8456cb59') || _selPresent('3f4ba83a')   // pause() | unpause()
    const _cortexWithdrawSel = _selPresent('3ccfd60b') || _selPresent('2e1a7d4d') // withdraw() | withdraw(uint256)
    const _cortexBlacklistStr = _hasBytecode && _bytecodeLc.includes('626c61636b6c697374') // ascii "blacklist"
    const _EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
    const _EIP1967_ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000'
    const [_proxySlotHex, _pausedCallHex] = await Promise.all([
      _hasBytecode ? countedRpcCall('eth_getStorageAt', [contract, _EIP1967_IMPL, 'latest'], 'proxySlotCheck', false) : Promise.resolve(null),
      _hasBytecode ? countedRpcCall('eth_call', [{ to: contract, data: '0x5c975abb' }, 'latest'], 'pausedCheck', false) : Promise.resolve(null),
    ])
    const _isVerifiedProxy = Boolean(
      _proxySlotHex && _proxySlotHex !== '0x' && _proxySlotHex !== _EIP1967_ZERO &&
      _proxySlotHex.replace(/^0x0+/, '').length > 0
    )
    const _pauseFunctionExists = Boolean(_pausedCallHex && _pausedCallHex !== '0x')

    // Contract flag resolution: GoldRush Contract Intel is primary source.
    // ABI/bytecode selector scan (PUSH4 opcode pattern) is fallback when GoldRush returns null.
    // RPC probes (EIP-1967 proxy slot, paused() call) supplement both sources.
    // Simulation fallback: when no bytecode AND no GoldRush AND simulation confirmed trading works,
    // upgrade 'unavailable' to 'not_detected' with low confidence — trading implies no active trap.
    const _grCI = grContractIntel  // GoldRush Contract Intel result
    const _grCIUsable = _grCI != null
    // _simImpliedClean declared above securityStatus to avoid temporal dead zone
    // Valid flag statuses never include "unverified", "not_checked", or "unavailable"
    type FlagStatus = { status: 'verified' | 'possible' | 'not_detected' | 'inferred' | 'partial'; confidence: 'high' | 'medium' | 'low'; note: string }
    // Infer whether a flag is present from chain context + simulation when direct sources fail
    const _inferFlagAbsent = (flagName: string): FlagStatus => {
      if (_simImpliedClean) return {
        status: 'inferred', confidence: 'low',
        note: `Simulation passed cleanly — ${flagName} inferred absent. Direct bytecode or on-chain verification not available.`,
      }
      // Structural inference: most ERC20 tokens do not have these functions
      return {
        status: 'inferred', confidence: 'low',
        note: `No bytecode, indexed contract data, or simulation available. ${flagName} inferred absent based on standard ERC20 pattern — manual on-chain check recommended.`,
      }
    }
    const _resolveFlag = (
      grValue: boolean | null | undefined,
      bytecodeSel: boolean,
      bytecodeNote: string,
      rpcConfirm?: boolean,
    ): FlagStatus => {
      if (rpcConfirm) return { status: 'verified', confidence: 'high', note: 'RPC call confirmed' }
      if (grValue === true) return { status: 'verified', confidence: 'high', note: 'Indexed contract intel confirmed' }
      if (grValue === false) return { status: 'not_detected', confidence: 'high', note: 'Indexed contract intel: not present' }
      // Indexed contract intel returned null — fall back to ABI/bytecode signature scan
      if (!_hasBytecode) return _inferFlagAbsent(bytecodeNote.split(' ')[0])
      if (bytecodeSel) return { status: 'verified', confidence: 'high', note: bytecodeNote }
      return { status: 'not_detected', confidence: 'medium', note: `ABI signature scan: not detected (indexed fallback)` }
    }
    const cortexContractFlags: CortexContractFlagsResult = {
      mint: _resolveFlag(_grCI?.mint, _cortexMintSel, 'Mint selector in ABI/bytecode (40c10f19 or a0712d68)'),
      proxy: (() => {
        if (_isVerifiedProxy) return { status: 'verified' as const, confidence: 'high' as const, note: 'EIP-1967 implementation slot is non-zero (RPC confirmed)' }
        if (_grCI?.proxy === true || _grCI?.upgradeable === true) return { status: 'verified' as const, confidence: 'high' as const, note: 'Indexed contract intel: proxy/upgradeable confirmed' }
        if (_grCI?.proxy === false && _grCI?.upgradeable === false) return { status: 'not_detected' as const, confidence: 'high' as const, note: 'Indexed contract intel: not proxy' }
        if (!_hasBytecode) return _inferFlagAbsent('Proxy/upgradeable') as { status: 'verified' | 'possible' | 'not_detected' | 'inferred' | 'partial'; confidence: 'high' | 'medium' | 'low'; note: string }
        if (_cortexProxySel) return { status: 'possible' as const, confidence: 'medium' as const, note: 'Upgrade selector in ABI/bytecode; EIP-1967 slot not confirmed' }
        return { status: 'not_detected' as const, confidence: 'medium' as const, note: 'ABI signature scan: no proxy selector or EIP-1967 slot (indexed fallback)' }
      })(),
      pause: (() => {
        if (_pauseFunctionExists) return { status: 'verified' as const, confidence: 'high' as const, note: 'paused() RPC call responded' }
        return _resolveFlag(_grCI?.pause, _cortexPauseSel, 'Pause selector in ABI/bytecode (8456cb59 or 3f4ba83a)')
      })(),
      blacklist: _resolveFlag(_grCI?.blacklist, _cortexBlacklistStr, 'Blacklist string pattern in ABI/bytecode'),
      withdraw: _resolveFlag(_grCI?.withdraw, _cortexWithdrawSel, 'Withdraw selector in ABI/bytecode (3ccfd60b or 2e1a7d4d)'),
      bytecodeChecked: _hasBytecode,
      proxySlotChecked: _proxySlotHex != null,
      pauseCallChecked: _pausedCallHex != null,
    }

    const riskVerifiedSignals: string[] = []
    const riskDrivers: string[] = []
    const openChecks: string[] = []
    let riskScore = 35
    const lpState = lpControl.status
    const top10Pct = holderDistribution.top10
    const top20Pct = holderDistribution.top20
    // Always use deterministic summary when holder data is complete — AI prompt is built before
    // holder data resolves so AI text can contain stale "holders not indexed" wording.
    // Fall back to AI text only when holder data is incomplete.
    const _deterministicSummary = _buildDeterministicSummary(_chainName, noActivePools, hpResult, analysis, holderDataComplete, holderCount ?? null, top10Pct ?? null, _ownershipStatusFinal, lpPoolType ?? lpVerifyPoolType, lpControl.status)
    const aiSummary: string = holderDataComplete ? _deterministicSummary : (_aiTextEarly ?? _deterministicSummary)

    if (marketCapFromGt != null) riskVerifiedSignals.push('Market data verified: market cap is available.')
    else if (fdv != null) {
      riskVerifiedSignals.push('Market data partial: FDV is available.')
      riskScore += 10
    } else {
      riskScore += 15
    }
    if (liquidityUsd != null) riskVerifiedSignals.push(`Liquidity depth detected (${Math.round(liquidityUsd).toLocaleString()} USD).`)
    if (holderDataComplete && top10Pct != null) {
      riskVerifiedSignals.push(`Holder Map verified with Top 10 concentration at ${top10Pct.toFixed(1)}%.`)
      if (top10Pct > 70) { riskDrivers.push('Holder concentration is very high (Top 10 > 70%).'); riskScore += 30 }
      else if (top10Pct > 50) { riskDrivers.push('Holder concentration is elevated (Top 10 > 50%).'); riskScore += 20 }
      else if (top10Pct > 35) { riskDrivers.push('Holder concentration is moderate (Top 10 > 35%).'); riskScore += 10 }
      else riskScore -= 5
    } else if (!holderDataComplete && holderDistributionStatus.status === 'partial') {
      riskVerifiedSignals.push('Holder Map rows were returned but concentration percentages are partial.')
      riskScore += 8
    } else {
      riskScore += 15
    }
    // lpProofStatus: never "unverified" — use "partial" or "inferred" instead
    // team_controlled = LP holder identity confirmed, but lock/burn proof is NOT verified → 'partial'
    const lpProofStatus: 'not_applicable' | 'verified' | 'partial' | 'inferred' =
      (lpState === 'protocol' || lpState === 'concentrated_liquidity') ? 'not_applicable' :
      (lpState === 'burned' || lpState === 'locked') ? 'verified' :
      (lpState === 'team_controlled') ? 'partial' :
      (lpState === 'partial') ? 'partial' : 'inferred'
    if (lpState === 'burned' || lpState === 'locked') { riskVerifiedSignals.push(`LP Control shows ${lpState}.`); riskScore -= 12 }
    else if (lpState === 'protocol' || lpState === 'concentrated_liquidity') { riskVerifiedSignals.push('LP Control indicates protocol-managed liquidity structure.'); riskScore += 3 }
    else if (lpState === 'team_controlled') { riskDrivers.push('LP Control indicates a dominant team wallet can control liquidity.'); riskScore += 28 }
    else if (lpProofStatus === 'inferred') { openChecks.push('LP lock/burn not confirmed — liquidity exit risk should be assumed.'); riskScore += 10 }
    else { riskScore += 5 }

    const riskOwnerStatus = _ownershipStatusFinal
    if (riskOwnerStatus === 'renounced') { riskVerifiedSignals.push('Dev Control: ownership appears renounced.'); riskScore -= 6 }
    else if (riskOwnerStatus === 'held') { riskDrivers.push('Dev Control: ownership is held by a wallet.'); riskScore += 10 }
    // open_check: ownership source not found — treat as potentially active (conservative)
    else if (rpcOwnershipAttempted && !ownerAddr && !adminAddr && !proxyImplAddr) { openChecks.push('Dev Control: ownership not resolved — treat as potentially active (conservative).') }
    if (proxyImplAddr && !isRenounced) { riskDrivers.push('Proxy contract with active owner — upgrade risk present.'); riskScore += 5 }

    const tradingSimConfigured = isFullScanChain
    if (hpResult.ok) {
      riskVerifiedSignals.push('Trading simulation returned tax and transfer signals.')
      if (hpResult.honeypot === true) { riskDrivers.push('Trading simulation indicates a blocked or trapped sell path.'); riskScore += 45 }
      if ((hpResult.buyTax ?? 0) > 12 || (hpResult.sellTax ?? 0) > 12) { riskDrivers.push('Trading taxes are high (>12%).'); riskScore += 20 }
      else if ((hpResult.buyTax ?? 0) > 7 || (hpResult.sellTax ?? 0) > 7) { riskDrivers.push('Trading taxes are elevated (>7%).'); riskScore += 10 }
    } else if (tradingSimConfigured) {
      openChecks.push('Trading simulation result pending — tax rates and honeypot status require direct chain verification.')
      riskScore += 8
    }

    if (cortexContractFlags.mint.status === 'verified') { riskDrivers.push('Contract can mint supply.'); riskScore += 12 }
    else if (cortexContractFlags.mint.status === 'possible') { riskDrivers.push('Contract may have mint capability (low-confidence signal).'); riskScore += 5 }
    if (cortexContractFlags.proxy.status === 'verified') { riskDrivers.push('Contract is upgradeable (proxy confirmed).'); riskScore += 10 }
    else if (cortexContractFlags.proxy.status === 'possible') { riskDrivers.push('Contract may be upgradeable (partial signal).'); riskScore += 5 }
    if (cortexContractFlags.withdraw.status === 'verified') { riskDrivers.push('Contract includes withdraw/sweep style controls.'); riskScore += 10 }
    // Whale pressure and supply spread signals
    if (whalePressure === 'high') { riskDrivers.push('Whale pressure is high: top holder or top-5 hold a dominant share.'); riskScore += 8 }
    else if (whalePressure === 'medium') { riskDrivers.push('Whale pressure is medium: notable top-holder concentration.'); riskScore += 4 }
    if (supplySpread === 'elevated') riskDrivers.push('Supply spread elevated: Top 10 hold more than 35% of supply.')
    // Holder completeness — reframe as next action, not empty gap
    if (!holderDataComplete) {
      const holderItemCount = holderDistributionStatus.itemCount ?? 0
      if (holderDistributionStatus.status === 'unavailable_with_reason' || holderItemCount === 0) {
        openChecks.push('Holder concentration: not indexed in this pass — verify via block explorer before sizing a position.')
      } else {
        openChecks.push('Holder concentration: partial data available — cross-check top wallets before sizing a position.')
      }
    }

    const majorMissingCount = [
      marketCapFromGt == null,
      holderDistributionStatus.status !== 'ok',
      !(lpState === 'burned' || lpState === 'locked' || lpState === 'protocol' || lpState === 'concentrated_liquidity' || lpState === 'team_controlled'),
      !hpResult.ok,
    ].filter(Boolean).length
    // Only withhold a score when ALL core providers returned null — i.e. zero usable data.
    // If any provider returned data, compute the score with missing-data penalties in riskScore.
    const anyProviderData = [
      marketCapFromGt != null || fdv != null || liquidityUsd != null,
      holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial',
      lpControl.status !== 'error' && lpControl.status !== 'insufficient_data' && lpControl.status !== 'partial',
      hpResult.ok,
      Boolean(bytecode && bytecode !== '0x'),
    ].some(Boolean)
    const sufficientCoreData = [
      marketCapFromGt != null || fdv != null,
      liquidityUsd != null,
      holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial',
      lpControl.status !== 'error' && lpControl.status !== 'insufficient_data',
    ].filter(Boolean).length >= 3
    // Always emit a score — use inference penalties when blind (never null unless truly zero providers responded)
    // When all providers return null, still score at 50 with low confidence (unknown = risk)
    const rugRiskScore: number | null = anyProviderData ? Math.max(0, Math.min(100, Math.round(riskScore))) : 50
    let rugRiskLabel: RiskEngine["rugRiskLabel"] = 'partial_data'
    if (rugRiskScore >= 85) rugRiskLabel = 'critical'
    else if (rugRiskScore >= 65) rugRiskLabel = 'high'
    else if (rugRiskScore >= 40) rugRiskLabel = 'watch'
    else if (rugRiskScore < 40) rugRiskLabel = majorMissingCount >= 2 ? 'watch' : 'low_visible_risk'
    if (!anyProviderData) rugRiskLabel = 'partial_data'
    const riskConfidence: RiskEngine["confidence"] = majorMissingCount >= 3 ? 'low' : majorMissingCount >= 2 ? 'medium' : 'high'

    // ── Sniper Activity — multi-signal (pool age + volume pressure + holder concentration) ──
    const _pairAgeMs = pairCreatedAt ? (() => { try { return Date.now() - new Date(pairCreatedAt).getTime() } catch { return null } })() : null
    const _pairAgeHrs = _pairAgeMs != null ? _pairAgeMs / 3_600_000 : null
    const _pairAgeDays = _pairAgeMs != null ? _pairAgeMs / 86_400_000 : null
    const _buyPressure = buys24h != null && sells24h != null && sells24h > 0 ? buys24h / sells24h : null
    const sniperReasons: string[] = []
    let sniperSigCount = 0
    if (_pairAgeHrs != null && _pairAgeHrs < 24) { sniperReasons.push(`Pool launched ${_pairAgeHrs < 1 ? '<1h' : `~${Math.floor(_pairAgeHrs)}h`} ago — very new`); sniperSigCount += 2 }
    else if (_pairAgeDays != null && _pairAgeDays < 7) { sniperReasons.push(`Pool launched ~${Math.floor(_pairAgeDays)}d ago — early phase`); sniperSigCount++ }
    if (transactions24h != null && transactions24h > 800 && _pairAgeHrs != null && _pairAgeHrs < 24) { sniperReasons.push(`${transactions24h} transactions in <24h — abnormal early volume`); sniperSigCount++ }
    if (_buyPressure != null && _buyPressure > 3 && _pairAgeDays != null && _pairAgeDays < 7) { sniperReasons.push(`Buy/sell ratio ${_buyPressure.toFixed(1)}x — concentrated buying pressure`); sniperSigCount++ }
    if (holderDistribution.top1 != null && holderDistribution.top1 > 20 && _pairAgeDays != null && _pairAgeDays < 14) { sniperReasons.push(`Top wallet holds ${holderDistribution.top1.toFixed(1)}% — early accumulation`); sniperSigCount++ }
    if (holderDistribution.top5 != null && holderDistribution.top5 > 40 && _pairAgeDays != null && _pairAgeDays < 14) { sniperReasons.push(`Top 5 wallets hold ${holderDistribution.top5.toFixed(1)}% — concentrated early ownership`); sniperSigCount++ }
    if (holderCount != null && holderCount < 50 && _pairAgeDays != null && _pairAgeDays < 7) { sniperReasons.push(`Only ${holderCount} holders — highly concentrated entry`); sniperSigCount++ }
    const _sniperDataAvailable = _pairAgeHrs != null || transactions24h != null
    // "not_applicable" replaces "not_assessed" — always return a meaningful status
    const sniperStatus: RiskEngine["sniperActivity"]["status"] = !_sniperDataAvailable ? 'not_applicable' : sniperSigCount >= 3 ? 'high' : sniperSigCount >= 1 ? 'watch' : 'low_signal'
    if (!_sniperDataAvailable) sniperReasons.push('Pool age and tx data not yet indexed — early-entry pattern check deferred to on-chain lookup.')
    else if (sniperReasons.length === 0) sniperReasons.push(_pairAgeHrs != null ? `Pool age confirmed. No abnormal early-entry signals detected.` : 'No abnormal transaction patterns detected in available data.')
    const sniperActivity: RiskEngine["sniperActivity"] = {
      status: sniperStatus,
      confidence: !_sniperDataAvailable ? 'low' : sniperSigCount >= 2 ? 'high' : 'medium',
      reasons: sniperReasons,
    }

    // ── Trend Intelligence — always produces a stage, volatility, and liquidityDecay ──
    const trendIntelligence: RiskEngine["trendIntelligence"] = (() => {
      const _vol = volume24hUsd ?? 0
      const _liq = liquidityUsd ?? 0
      const _volToLiq = _liq > 0 ? _vol / _liq : null
      const _priceChange = pickNum((poolAttr.price_change_percentage as Record<string, unknown> | undefined)?.h24) ?? _dexFb?.priceChange24h ?? null
      // Volatility from price change
      const volatility: RiskEngine["trendIntelligence"]["volatility"] = _priceChange == null
        ? 'inferred'
        : Math.abs(_priceChange) > 50 ? 'extreme'
        : Math.abs(_priceChange) > 20 ? 'high'
        : Math.abs(_priceChange) > 8 ? 'moderate'
        : 'low'
      // Liquidity decay: infer from vol/liq ratio and pool age
      const liquidityDecay: RiskEngine["trendIntelligence"]["liquidityDecay"] = noActivePools
        ? 'critical'
        : _volToLiq == null ? 'inferred'
        : (_volToLiq < 0.02 && _pairAgeDays != null && _pairAgeDays > 14) ? 'declining'
        : _volToLiq < 0.001 ? 'critical'
        : 'stable'
      if (_pairAgeDays == null && liquidityUsd == null && volume24hUsd == null) {
        return { stage: 'inferred', confidence: 'low', volatility, liquidityDecay, note: noActivePools ? 'No active pools — token is dormant or delisted.' : 'No pool age, liquidity, or volume data — trend stage inferred as inactive or pre-launch.' }
      }
      if (noActivePools) return { stage: 'dormant', confidence: 'high', volatility, liquidityDecay: 'critical', note: 'No active trading pools — token is dormant or delisted.' }
      if (_pairAgeDays != null && _pairAgeDays < 1) return { stage: 'launch', confidence: 'high', volatility, liquidityDecay, note: `Pool is <1 day old — launch phase with high sniper/bot exposure.` }
      if (_pairAgeDays != null && _pairAgeDays < 7 && _volToLiq != null && _volToLiq > 0.5) return { stage: 'ignition', confidence: 'medium', volatility, liquidityDecay, note: `Volume/liquidity ratio ${_volToLiq.toFixed(2)}x in first week — ignition phase momentum.` }
      if (_pairAgeDays != null && _pairAgeDays < 30 && _volToLiq != null && _volToLiq < 0.1) return { stage: 'accumulation', confidence: 'medium', volatility, liquidityDecay, note: `Low volume relative to liquidity in early phase — accumulation pattern.` }
      if (_volToLiq != null && _volToLiq > 2) return { stage: 'peak', confidence: 'medium', volatility, liquidityDecay, note: `Very high volume/liquidity ratio (${_volToLiq.toFixed(2)}x) — potential peak or distribution phase.` }
      if (_volToLiq != null && _volToLiq > 0.5) return { stage: 'distribution', confidence: 'medium', volatility, liquidityDecay, note: `High volume/liquidity ratio (${_volToLiq.toFixed(2)}x) in mature token — possible distribution or exit phase.` }
      if (_volToLiq != null && _volToLiq < 0.05 && _pairAgeDays != null && _pairAgeDays > 30) return { stage: 'decay', confidence: 'medium', volatility, liquidityDecay, note: `Low volume relative to liquidity in mature token — decay or dormant pattern.` }
      return { stage: 'inferred', confidence: 'low', volatility, liquidityDecay, note: `Mixed signals — stage inferred from partial data. Pool age: ${_pairAgeDays != null ? `${Math.floor(_pairAgeDays)}d` : 'unknown'}, vol/liq: ${_volToLiq != null ? `${_volToLiq.toFixed(2)}x` : 'partial'}.` }
    })()

    // ── Smart Money Intelligence — derive accumulation/distribution signal ──
    const smartMoney: RiskEngine["smartMoney"] = (() => {
      const _noSignal = _buyPressure == null && holderDistribution.top1 == null && volume24hUsd == null
      // Rotation: inflow when strong buys, outflow when strong sells
      const rotation: RiskEngine["smartMoney"]["rotation"] = _buyPressure == null ? 'inferred'
        : _buyPressure > 1.5 ? 'inflow' : _buyPressure < 0.7 ? 'outflow' : 'neutral'
      // Conviction: high when top holder is very concentrated + early
      const conviction: RiskEngine["smartMoney"]["conviction"] = holderDistribution.top1 == null ? 'inferred'
        : holderDistribution.top1 > 20 ? 'high' : holderDistribution.top1 > 8 ? 'moderate' : 'low'
      // Cluster behavior: coordinated if top1 >> top10 average, else dispersed
      const top10avg = holderDistribution.top10 != null && holderDistribution.top1 != null
        ? (holderDistribution.top10 - holderDistribution.top1) / 9 : null
      const clusterBehavior: RiskEngine["smartMoney"]["clusterBehavior"] = top10avg == null ? 'inferred'
        : holderDistribution.top1 != null && top10avg > 0 && (holderDistribution.top1 / top10avg) > 5 ? 'coordinated' : 'dispersed'
      if (_noSignal) {
        return { signal: 'inferred', confidence: 'low', rotation, conviction, clusterBehavior, note: 'Buy/sell ratio and holder data not indexed — smart money position inferred as neutral (no conviction signal either direction).' }
      }
      if (_buyPressure != null && _buyPressure > 2.5) return { signal: 'accumulation', confidence: 'medium', rotation, conviction, clusterBehavior, note: `Buy/sell ratio ${_buyPressure.toFixed(1)}x — net accumulation pressure detected.` }
      if (_buyPressure != null && _buyPressure < 0.5) return { signal: 'distribution', confidence: 'medium', rotation, conviction, clusterBehavior, note: `Buy/sell ratio ${_buyPressure.toFixed(1)}x — net selling pressure detected.` }
      if (holderDistribution.top1 != null && holderDistribution.top1 > 15 && _pairAgeDays != null && _pairAgeDays < 14) return { signal: 'accumulation', confidence: 'low', rotation, conviction, clusterBehavior, note: `Top wallet holds ${holderDistribution.top1.toFixed(1)}% in early phase — possible concentrated accumulation.` }
      return { signal: 'neutral', confidence: 'medium', rotation, conviction, clusterBehavior, note: `No dominant buy or sell pressure detected in available signals.` }
    })()

    // ── Deployer Profile — always produces a value with rug history inference ──
    // `deployer` and `method`/`note` are reconciled later (once devIntel.deployerAddress
    // is resolved) so the deployer/origin wallet is never confused with the (possibly
    // renounced/zero) owner address. This placeholder only fixes deployPattern early.
    const deployerProfile: RiskEngine["deployerProfile"] = (() => {
      const _isProxy = cortexContractFlags.proxy.status === 'verified' || cortexContractFlags.proxy.status === 'possible'
      const _deployPattern: RiskEngine["deployerProfile"]["deployPattern"] = _isProxy ? 'proxy'
        : proxyImplAddr ? 'proxy'
        : chain === 'base' && !ownerAddr ? 'factory'
        : ownerAddr ? 'eoa'
        : 'inferred'
      return { status: 'inferred', deployer: null, method: 'inference', rugHistory: null, clusterRisk: 'inferred', deployPattern: _deployPattern, note: 'Deployer/origin wallet resolution pending.' }
    })()

    // ── Holder Intelligence — concentration, churn, velocity, early buyer, whale ──
    const holderIntelligence: RiskEngine["holderIntelligence"] = (() => {
      // Velocity: infer from buy pressure and pair age
      const velocity: RiskEngine["holderIntelligence"]["velocity"] = _buyPressure == null && _pairAgeDays == null ? 'inferred'
        : _buyPressure != null && _buyPressure > 1.5 ? 'accumulating'
        : _buyPressure != null && _buyPressure < 0.7 ? 'distributing'
        : 'stable'
      // Churn: infer from volume and pool age
      const churn: RiskEngine["holderIntelligence"]["churn"] = transactions24h == null && _pairAgeDays == null ? 'inferred'
        : (_pairAgeDays != null && _pairAgeDays < 3 && transactions24h != null && transactions24h > 200) ? 'high'
        : (transactions24h != null && transactions24h > 50) ? 'moderate'
        : 'low'
      // Early buyer concentration from pair age + top holder data
      const earlyBuyerConcentration: RiskEngine["holderIntelligence"]["earlyBuyerConcentration"] = holderDistribution.top1 == null ? 'inferred'
        : (_pairAgeDays != null && _pairAgeDays < 7 && holderDistribution.top1 > 10) ? 'high'
        : (_pairAgeDays != null && _pairAgeDays < 30 && holderDistribution.top10 != null && holderDistribution.top10 > 40) ? 'moderate'
        : 'low'
      // Whale concentration
      const whaleConcentration: RiskEngine["holderIntelligence"]["whaleConcentration"] = holderDistribution.top1 == null ? 'inferred'
        : holderDistribution.top1 > 15 ? 'high'
        : holderDistribution.top5 != null && holderDistribution.top5 > 30 ? 'high'
        : holderDistribution.top10 != null && holderDistribution.top10 > 50 ? 'moderate'
        : 'low'
      if (holderDataComplete && holderDistribution.top10 != null) {
        const _conc = holderDistribution.top10 > 70 ? 'high' as const : holderDistribution.top10 > 40 ? 'moderate' as const : 'low' as const
        return { status: 'verified', concentration: _conc, churn, velocity, earlyBuyerConcentration, whaleConcentration, note: `Top 10 hold ${holderDistribution.top10.toFixed(1)}% of supply. ${_conc === 'high' ? 'Very high concentration — dump risk elevated.' : _conc === 'moderate' ? 'Moderate concentration — monitor top wallets.' : 'Distribution is healthy across holders.'}` }
      }
      if (holderDistributionStatus.status === 'partial' && holderItems.length > 0) {
        return { status: 'partial', concentration: 'inferred', churn, velocity, earlyBuyerConcentration, whaleConcentration, note: `${holderItems.length} holder rows returned but percentages are partial. Concentration direction inferred.` }
      }
      if (holderCount != null && holderCount < 100) {
        return { status: 'inferred', concentration: 'high', churn, velocity, earlyBuyerConcentration, whaleConcentration, note: `Only ${holderCount} total holders — inferred high concentration regardless of individual wallet data.` }
      }
      if (liquidityUsd != null && liquidityUsd < 10_000) {
        return { status: 'inferred', concentration: 'high', churn, velocity, earlyBuyerConcentration, whaleConcentration, note: `Very low liquidity ($${Math.round(liquidityUsd).toLocaleString()}) implies limited token distribution — concentration likely high.` }
      }
      const _chainDefault = chain === 'base' ? 'Base' : 'Ethereum'
      return { status: 'inferred', concentration: 'inferred', churn, velocity, earlyBuyerConcentration, whaleConcentration, note: `Holder data not indexed on ${_chainDefault}. Concentration inferred as moderate-to-high — verify via block explorer.` }
    })()

    // ── Migration proof — derived early so LP Intelligence's migrationRisk can reflect
    // real migration evidence instead of conflating it with LP-control status. ──
    const lpMigrationProof = _deriveMigrationProof(gtAllPools, liquidityUsd, Boolean(lpPool), lpControl.primaryPoolDex ?? null, pairCreatedAt)

    // ── LP Intelligence — lock time, migration risk, mint authority, depth, volatility ──
    const lpIntelligence: RiskEngine["lpIntelligence"] = (() => {
      const _lpStatus = lpControl.status
      if (_lpStatus === 'no_pool' || noActivePools) {
        return { status: 'not_applicable', lockTime: null, lockTimeSeconds: null, migrationRisk: 'inferred', mintAuthority: 'not_applicable', depth: 'none', volatility: 'inferred', liquidityDecay: 'critical', poolType: lpPoolType ?? 'none', note: 'No active LP pool found — LP intelligence not applicable.' }
      }
      // No lock-duration provider is wired up — lock time is always unverified.
      const _lockSecs: number | null = null
      const _lockTimeLabel: string | null = null
      // Migration risk reflects real migration evidence (lpMigrationProof), not LP-control
      // status alone — a team-controlled LP with deep liquidity and a selected primary pool
      // is an exit-risk concern, not necessarily a migration-risk one.
      const migrationRisk: RiskEngine["lpIntelligence"]["migrationRisk"] = lpMigrationProof.status === 'flagged' ? 'high'
        : lpMigrationProof.status === 'watch' ? 'medium'
        : lpMigrationProof.status === 'low' ? 'low'
        : 'inferred'
      // Mint authority: active = mint bytecode detected; renounced = ownership provably renounced;
      // not_applicable = mint bytecode not detected (no authority to yield); inferred = unknown.
      const mintAuthority: RiskEngine["lpIntelligence"]["mintAuthority"] = cortexContractFlags.mint.status === 'verified' ? 'active'
        : isRenounced ? 'renounced'
        : cortexContractFlags.mint.status === 'not_detected' ? 'not_applicable'
        : 'inferred'
      // Depth from liquidity
      const depth: RiskEngine["lpIntelligence"]["depth"] = liquidityUsd == null ? 'inferred'
        : liquidityUsd > 500_000 ? 'deep'
        : liquidityUsd > 50_000 ? 'moderate'
        : liquidityUsd > 1_000 ? 'shallow'
        : 'none'
      // Volatility from price change
      const _priceChangePct = pickNum((poolAttr.price_change_percentage as Record<string, unknown> | undefined)?.h24) ?? _dexFb?.priceChange24h ?? null
      const volatility: RiskEngine["lpIntelligence"]["volatility"] = _priceChangePct == null ? 'inferred'
        : Math.abs(_priceChangePct) > 30 ? 'high'
        : Math.abs(_priceChangePct) > 10 ? 'moderate'
        : 'low'
      // Liquidity decay
      const _volToLiq2 = liquidityUsd != null && liquidityUsd > 0 && volume24hUsd != null ? volume24hUsd / liquidityUsd : null
      const liquidityDecay: RiskEngine["lpIntelligence"]["liquidityDecay"] = _volToLiq2 == null ? 'inferred'
        : _volToLiq2 < 0.01 && _pairAgeDays != null && _pairAgeDays > 14 ? 'declining'
        : _volToLiq2 < 0.001 ? 'critical'
        : 'stable'
      const _statusLevel: RiskEngine["lpIntelligence"]["status"] = (_lpStatus === 'burned' || _lpStatus === 'locked') ? 'verified'
        : (_lpStatus === 'team_controlled' || _lpStatus === 'protocol' || _lpStatus === 'concentrated_liquidity') ? 'partial'
        : 'inferred'
      const _dexForTypeLabel = String(lpDexName ?? lpDexId ?? '').toLowerCase()
      const _typeLabel = lpPoolType === 'v2' ? 'V2 AMM' : (lpPoolType === 'v3' || lpPoolType === 'concentrated') ? (
          concentratedPositionProof?.poolModel === 'uniswap_v4' || _dexForTypeLabel.includes('uniswap v4') || _dexForTypeLabel.includes('uniswap_v4') ? 'Uniswap V4 Concentrated Liquidity'
          : concentratedPositionProof?.poolModel === 'uniswap_v3' || _dexForTypeLabel.includes('uniswap') ? 'Uniswap V3 Concentrated Liquidity'
          : 'Concentrated Liquidity'
        ) : (lpPoolType ?? 'unknown')
      return {
        status: _statusLevel,
        lockTime: _lockTimeLabel,
        lockTimeSeconds: _lockSecs,
        migrationRisk,
        mintAuthority,
        depth,
        volatility,
        liquidityDecay,
        poolType: _typeLabel,
        note: `${lpControl.proofApplicability === 'not_applicable'
          ? 'Standard ERC-20 LP lock/burn proof does not apply to this concentrated-liquidity pool. Liquidity control requires protocol-specific position checks'
          : `LP ${_lpStatus === 'burned' ? 'is burned — permanent lock' : _lpStatus === 'locked' ? `is locked (${_lockTimeLabel ?? 'duration unknown'})` : _lpStatus === 'team_controlled' ? 'is team-controlled — exit risk active' : _lpStatus === 'protocol' ? 'is protocol-owned — follows protocol governance' : 'control status inferred — lock or burn proof not confirmed'}`
        }. Depth: ${depth}. Migration risk: ${migrationRisk}.`
      }
    })()

    // ── Clark Interpretation — 3-phase contextual summary with risk drivers, open checks, next actions ──
    const clarkInterpretation: RiskEngine["clarkInterpretation"] = (() => {
      const _chain = chain === 'eth' ? 'Ethereum' : 'Base'
      const _selectedPoolDexForCtx = String(lpDexName ?? lpDexId ?? '').toLowerCase()
      const _selectedPoolIsConcentratedForCtx = lpPoolType === 'v3' || lpPoolType === 'concentrated' || _selectedPoolDexForCtx.includes('uniswap v4') || _selectedPoolDexForCtx.includes('uniswap_v4') || _selectedPoolDexForCtx.includes('uniswap v3') || _selectedPoolDexForCtx.includes('uniswap_v3')
      const _chainCtx = chain === 'base'
        ? `On Base: check for CL pool (Aerodrome/Uniswap v3) and proxy-pattern contracts. Factory deployers are common. LP migration via concentrated liquidity positions is possible.`
        : _selectedPoolIsConcentratedForCtx
          ? `On Ethereum: this token’s primary pool is concentrated liquidity, so standard ERC-20 LP lock/burn proof does not apply. Position/controller proof is the relevant verification path.`
          : `On Ethereum: standard v2 LP patterns apply. Renounce events and Ownable/Pausable are common risk markers. Check Etherscan for deployer history.`
      // Build next actions from open checks + data gaps
      const nextActions: string[] = []
      if (!holderDataComplete) nextActions.push(`Verify holder concentration via ${chain === 'eth' ? 'Etherscan token holders' : 'Basescan'}.`)
      if (!hpResult.ok) nextActions.push('Run a manual trade simulation to confirm buy/sell taxes and honeypot status.')
      if (deployerProfile.deployer == null) nextActions.push(`Trace deployer wallet via ${chain === 'eth' ? 'Etherscan contract creation' : 'Basescan'} before taking a position.`)
      if (lpControl.proofApplicability === 'not_applicable') {
        nextActions.push('Standard ERC-20 LP lock/burn proof does not apply to the primary concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.')
      } else if (lpIntelligence.migrationRisk === 'high' || lpIntelligence.migrationRisk === 'inferred') {
        nextActions.push('Verify LP lock status — team-controlled liquidity can be removed at any time.')
      }
      if (cortexContractFlags.mint.status === 'inferred') nextActions.push('Confirm mint function absence via contract source code or bytecode audit.')
      if (lpIntelligence.depth === 'shallow' || lpIntelligence.depth === 'none') nextActions.push('Caution: shallow liquidity — large trades will face significant slippage.')
      if (nextActions.length === 0) nextActions.push('All major checks passed — continue monitoring for holder changes and LP movements.')
      // Converts a full risk-driver sentence (e.g. "Holder concentration is very high (Top 10 >
      // 70%).") into a short noun phrase suitable for "Major risk drivers present: a, b, and c."
      // Falls back to a generic cleanup (strip trailing period, lowercase first letter) for any
      // driver not covered by the mapping below.
      const _shortDriverPhrase = (driver: string): string => {
        const phraseMap: Array<[RegExp, string]> = [
          [/^Holder concentration is very high/i, 'very high holder concentration'],
          [/^Holder concentration is elevated/i, 'elevated holder concentration'],
          [/^Holder concentration is moderate/i, 'moderate holder concentration'],
          [/^Dev Control: ownership is held by a wallet/i, 'active ownership'],
          [/^Proxy contract with active owner/i, 'an upgradeable proxy with an active owner'],
          [/^LP Control indicates a dominant team wallet/i, 'dominant LP wallet control'],
          [/^Trading simulation indicates a blocked or trapped sell path/i, 'a blocked or trapped sell path'],
          [/^Trading taxes are high/i, 'high trading taxes'],
          [/^Trading taxes are elevated/i, 'elevated trading taxes'],
          [/^Contract can mint supply/i, 'active mint authority'],
          [/^Contract may have mint capability/i, 'possible mint capability'],
          [/^Contract is upgradeable \(proxy confirmed\)/i, 'a confirmed upgradeable proxy'],
          [/^Contract may be upgradeable/i, 'a possible upgradeable proxy'],
          [/^Contract includes withdraw\/sweep style controls/i, 'withdraw/sweep-style contract controls'],
          [/^Whale pressure is high/i, 'deployer/top-holder supply control'],
          [/^Whale pressure is medium/i, 'notable top-holder concentration'],
          [/^Supply spread elevated/i, 'elevated supply concentration among top holders'],
        ]
        for (const [pattern, phrase] of phraseMap) {
          if (pattern.test(driver)) return phrase
        }
        const stripped = driver.replace(/\.$/, '')
        return stripped.charAt(0).toLowerCase() + stripped.slice(1)
      }
      const _joinDriverPhrases = (phrases: string[]): string => {
        if (phrases.length === 0) return ''
        if (phrases.length === 1) return phrases[0]
        if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`
        return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`
      }
      // Summary sentence
      // Evidence-based wording only — never assert scam/rug certainty or give financial
      // advice ("avoid exposure", "guaranteed", "safe"). Cite the actual risk drivers and
      // point to open checks instead.
      const _riskSuffix = rugRiskLabel === 'critical' ? `Major risk drivers present: ${riskDrivers.length > 0 ? _joinDriverPhrases(riskDrivers.slice(0, 3).map(_shortDriverPhrase)) : 'multiple high-risk signals'}. Verify open checks before relying on this scan.` : rugRiskLabel === 'high' ? 'High risk flags present — verify before any position.' : rugRiskLabel === 'watch' ? 'Watch-level signals — monitor closely.' : rugRiskLabel === 'partial_data' ? 'Partial data scan — score is conservative baseline pending full verification.' : 'Low visible risk across verified checks.'
      const _topDriver = (riskDrivers.length > 0 && rugRiskLabel !== 'critical') ? ` Primary risk: ${riskDrivers[0]}` : ''
      // Use "Rug-risk pressure" label to avoid confusion with CORTEX Score (different scale/direction)
      const summary = `${_chain} token. Rug-risk pressure: ${rugRiskScore}/100. ${_riskSuffix}${_topDriver}`
      return {
        summary,
        riskDrivers: [...riskDrivers],
        openChecks: [...openChecks],
        nextActions,
        chainContext: _chainCtx,
        confidence: riskConfidence,
      }
    })()

    // ── Real LP proof: PinkLock lock-proof lookup + minimal on-chain burn/holder
    // scan, shared with the standalone Liquidity Safety route. No fabricated
    // lock/burn/controller status — unknowns are reported as "unverified". ──
    // Compute applicability first so we skip ERC-20 proof calls for concentrated
    // pools where no LP token exists. Unknown pool model still attempts proof.
    // Single shared classification (problem 1/2): "applicable" only when lpControl confirmed
    // an ERC-20 LP token (V2 or Aerodrome V2). Never "applicable" for concentrated/no_pool/unclassified.
    // When fallback liquidity is detected but no verification pool could be probed, the model is
    // an open check ("unknown"), NOT "not_available" — there IS a pool, we just couldn't confirm
    // its model. This keeps CORTEX from wrongly saying standard LP proof "does not apply".
    const lpProofApplicability: ProofApplicability = noActivePools
      ? 'not_available'
      : (!_lpProofPresent && _fallbackLiquidityDetected)
      ? 'unknown'
      : (lpControl.proofApplicability ?? 'unknown')
    const _proofApplicableEarly = lpProofApplicability === 'applicable'
    let lpProof: { lpLockStatus: 'locked' | 'burned' | 'unlocked' | 'unverified'; lpLockAmount: number | null; lpUnlockTime: number | null; lpLockProvider: 'PinkLock' | null; lpController: 'wallet' | 'contract' | 'burn' | 'lockContract' | 'unknown'; reasonCode?: string }
    let _lpProofSkipReason: string | null = null
    if (!_proofApplicableEarly) {
      lpProof = { lpLockStatus: 'unverified', lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null, lpController: 'unknown', reasonCode: 'proofNotApplicable' }
      // Keep "pool model unknown" (proof may apply once confirmed) and "confirmed
      // concentrated/protocol pool" (proof genuinely does not apply) as separate reasons —
      // the latter wording must never be shown for an unverified/open-check pool model.
      _lpProofSkipReason = lpProofApplicability === 'unknown'
        ? 'LP proof skipped because the pool model is unknown. Standard lock/burn proof only applies after an ERC-20 LP token is confirmed.'
        : lpProofApplicability === 'not_applicable'
          ? 'Standard ERC-20 LP lock/burn proof does not apply to this concentrated-liquidity pool.'
          : `LP proof skipped: no pool address available for LP proof (status ${lpControl.status}).`
    } else if (chain === 'eth' || chain === 'base') {
      lpProof = await resolveLpProof(chain, _lpProofAddress)
    } else {
      lpProof = { lpLockStatus: 'unverified', lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null, lpController: 'unknown', reasonCode: 'proofNotApplicable' }
    }
    const { lpLockStatus, lpLockAmount, lpUnlockTime, lpLockProvider, lpController: _lpControllerFromProof } = lpProof
    // Synthesize lpControllerType/lpControllerAddress from lpControl evidence when the
    // proof scan returned 'unknown'. lpControl independently detects who holds the LP
    // tokens (team wallet, burn address, etc.) and should be the authoritative source
    // for controller identity when proof has no data — including a dominant LP holder
    // surfaced via top_share/owner_lp_share evidence even when lpControl.status stops
    // short of the strict 80% "team_controlled" threshold (e.g. a "partial" result from
    // a flaky holder-data fetch). See resolveLpControllerIdentity for the shared logic.
    const { lpControllerType, lpControllerAddress, lpController } = resolveLpControllerIdentity({
      status: lpControl.status,
      evidence: lpControl.evidence,
      lpControllerFromProof: _lpControllerFromProof,
      ownerAddr,
    })
    // LP controller has not been proven for open-check (model unverified) or
    // concentrated/protocol (NFT position, not an ERC-20 LP token) pools — never report
    // the token owner/deployer as the LP owner/controller in these cases.
    const _lpControllerUnproven = lpControl.status === "open_check" || lpControl.status === "concentrated_liquidity" || lpControl.status === "protocol"
    if (_lpProofSkipReason) lpDiagnostics.lpProofSkipReason = _lpProofSkipReason

    // proofApplicability: shared classification — "not_applicable"/"not_available" suppress
    // lock/burn/controller gaps; "unknown" emits a pool-model-uncertainty gap instead.
    // includeTokenGaps: false — token scanner has its own security section for tax/honeypot/renounce
    // Pool age: prefer the GeckoTerminal pool's pool_created_at, falling back to the
    // DexScreener fallback's pairCreatedAt — when either is known, never emit
    // POOL_AGE_UNKNOWN (a POOL_AGE_VERY_NEW watch item is emitted instead if <24h old).
    const _poolAgeMsForGaps = _pairAgeMs ?? (dexFbEarly?.pairCreatedAt ? (() => { try { return Date.now() - new Date(dexFbEarly.pairCreatedAt as string).getTime() } catch { return null } })() : null)
    const lpEvidenceGaps = buildLpEvidenceGaps({
      lpLockStatus,
      lpController: lpControllerType,
      proofApplicability: lpProofApplicability,
      controllerProofAttempted: _proofApplicableEarly,
      includeTokenGaps: false,
      poolAgeMs: _poolAgeMsForGaps,
    })
    if (concentratedPositionProof && ['not_supported', 'partial', 'failed', 'open_check'].includes(concentratedPositionProof.status)) {
      for (const label of ['Position manager not resolved', 'Top position owner not resolved', 'Position count unavailable']) {
        if (!lpEvidenceGaps.some((gap) => gap.label === label)) {
          lpEvidenceGaps.push({
            id: label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''),
            label,
            explanation: 'Concentrated-liquidity position proof was attempted but this ownership field was not resolved by the current provider path.',
            nextAction: 'Verify position ownership in the protocol position manager or a subgraph-backed explorer.',
          })
        }
      }
    }

    const _hasUsablePoolData = !noActivePools && (liquidityUsd != null && liquidityUsd > 0)
    const { lp_data_mode: lpDataMode, lp_data_confidence: _lpDataConfRaw } = deriveLpDataModeAndConfidence(
      _hasUsablePoolData,
      lpLockStatus
    )
    // Upgrade confidence from 'low' to 'medium' when LP control status is confirmed (not unknown/no_pool).
    // Pool/control evidence can be high-confidence even when lock/burn proof is unverified.
    const _lpControlKnown = lpControl.status !== 'no_pool' && lpControl.status !== 'error' && lpControl.status !== 'insufficient_data'
    const lpDataConfidence = (_lpDataConfRaw === 'low' && _lpControlKnown) ? 'medium' : _lpDataConfRaw
    // Public-facing lp_data_mode: never label resolved pool + LP-holder evidence as "fallback".
    const lpDataModePublic = publicLpDataMode(lpDataMode, _hasUsablePoolData, lpOwnershipVerified)

    const lpModelForCortex = lpModelProof
    const migrationSummaryForCortex = lpMigrationProof.reason + (noActivePools ? ' No active pools were detected for this token.' : '')

    // "Established token" heuristic (problem 5): high liquidity, broad holder base, and a
    // verified market cap together indicate a mature/established token, so wallet-controlled
    // LP is described as a liquidity-control signal rather than implied rug risk.
    const isEstablishedToken = (liquidityUsd != null && liquidityUsd >= 500_000)
      && (holderCount != null && holderCount >= 1000)
      && (marketCapFromGt != null && marketCapFromGt > 0)

    // ── Structured exit risk fields (problem 6): liquidityDepthRisk separated from
    // exitControlRisk via the shared computeLpExitRisk helper, used identically by
    // Liquidity Safety so the two routes never disagree. Computed before cortexLpRead so the
    // CORTEX LP read can describe liquidity depth and LP control as separate risk dimensions.
    // Use the effective (fallback-aware) liquidity for LP exit-risk, cortexLpRead, and the
    // public selectedPool/LP-intel views so a fallback-only liquidity read still informs LP
    // context. The Token Safety Score itself keeps using the primary-only `liquidityUsd`.
    const _liqForRisk = _el
    const lpProofStatusNew: 'confirmed' | 'partial' | 'missing' | 'not_applicable' | 'unknown' =
      (lpProofApplicability === 'not_applicable' || lpProofApplicability === 'not_available') ? 'not_applicable' :
      (lpLockStatus === 'locked' || lpLockStatus === 'burned') ? 'confirmed' :
      lpLockStatus === 'unlocked' ? 'partial' :
      noActivePools ? 'unknown' : 'missing'
    const _lpExitRiskResult = computeLpExitRisk({
      proofApplicability: lpProofApplicability,
      lpLockStatus,
      lpController: lpControllerType,
      liquidityUsd: _liqForRisk,
      poolModel: lpModelProof.model === 'concentrated' && lpDexId && /aerodrome|velodrome/i.test(lpDexId) ? 'concentrated' : lpModelProof.model,
      // Fallback liquidity counts as a pool for exit-risk purposes — there IS liquidity, the
      // model is just unconfirmed (open check), so don't fall through to "no active pool".
      hasPool: !noActivePools && (_lpProofPresent || _fallbackLiquidityDetected),
      secondaryLpSignal: lpControl.secondaryLpControlSignals
        ? { status: lpControl.secondaryLpControlSignals.status, poolDex: lpControl.secondaryLpControlSignals.poolDex }
        : null,
      lpControllerAddress,
      isEstablishedToken,
      concentratedPoolModel: concentratedPositionProof?.poolModel ?? null,
      positionOwnershipUnresolved: Boolean(concentratedPositionProof && concentratedPositionProof.status !== 'verified'),
      concentratedControllerRisk: (concentratedPositionProof?.status === 'verified' || concentratedPositionProof?.status === 'partial')
        ? (concentratedPositionProof?.controllerRisk ?? null)
        : null,
    })
    const lpExitRisk = _lpExitRiskResult.lpExitRisk
    const liquidityDepthRisk = _lpExitRiskResult.liquidityDepthRisk

    const cortexLpRead = buildSharedCortexLpRead({
      name: finalResolvedName !== 'Unknown' ? finalResolvedName : (finalResolvedSymbol !== '?' ? finalResolvedSymbol : 'This token'),
      symbol: finalResolvedSymbol,
      totalLiq: _el,
      fragments: Array.isArray(gtAllPools) ? gtAllPools.length : (liquidityUsd != null ? 1 : 0),
      observedPoolPresent,
      riskTier: rugRiskLabel,
      liquidityDepthRisk,
      lpModel: lpModelForCortex,
      migrationSummary: migrationSummaryForCortex,
      mode: lpDataMode,
      confidence: lpDataConfidence,
      gaps: lpEvidenceGaps,
      lpLockStatus,
      lpLockProvider,
      lpUnlockTime,
      secondaryLpSignal: lpControl.secondaryLpControlSignals
        ? { status: lpControl.secondaryLpControlSignals.status, poolDex: lpControl.secondaryLpControlSignals.poolDex }
        : null,
      lpController: lpControllerType,
      lpControllerAddress,
      isEstablishedToken,
      proofApplicability: lpProofApplicability,
      fallbackLiquidityDetected: _fallbackLiquidityDetected,
      contractSignals: {
        ownershipStatus: _ownershipStatusFinal === 'open_check' ? 'unknown' : _ownershipStatusFinal,
        mintDetected: cortexContractFlags.mint.status === 'verified' ? true
          : cortexContractFlags.mint.status === 'not_detected' ? false
          : null,
        simulationVerified: Boolean(hpResult.ok && hpResult.simulationSuccess),
        buyTax: hpResult.ok ? (hpResult.buyTax ?? null) : null,
        sellTax: hpResult.ok ? (hpResult.sellTax ?? null) : null,
      },
    })
    // For the fallback "pool detected, model unverified" case, use the task-specified evidence
    // wording instead of the generic open-check reason.
    const lpExitRiskReason = (!_lpProofPresent && _fallbackLiquidityDetected && lpProofApplicability === 'unknown')
      ? 'Liquidity was detected, but ChainLens could not verify the pool model or LP control path from current evidence.'
      : _lpExitRiskResult.lpExitRiskReason
    const lpEvidenceSummary = [
      `Pool model: ${lpModelProof.model}`,
      `Liquidity: ${_liqForRisk != null ? '$' + _liqForRisk.toLocaleString(undefined, {maximumFractionDigits:0}) : 'unknown'}`,
      `Proof applicability: ${lpProofApplicability}`,
      `Proof status: ${lpProofStatusNew}`,
      `Migration: ${lpMigrationProof.status}`,
    ].join(' | ')
    const lpControllerIntel = buildLpControllerIntel({
      lpControl: { ...lpControl, lpController, lpControllerType, proofApplicability: lpProofApplicability },
      lpControlRead: computeLpControlRead(lpControl, String(lpPool?.pairName ?? ""), lpControllerAddress, concentratedPositionProof),
      selectedPool: {
        pair: _primaryPair ?? ([ _dexFb?.baseToken?.symbol, _dexFb?.quoteToken?.symbol ].filter(Boolean).join('/') || null),
        address: lpPoolAddress ?? _dexFb?.pairAddress ?? null,
        poolId: primaryMarketPoolId ?? lpPool?.poolId ?? null,
        model: lpModelProof.model,
        liquidityUsd: _el,
      },
      lpExitRisk,
      liquidityDepthRisk,
      lpMigrationProof,
      lpEvidenceGaps,
      lpMeta: { teamPercent: lpDiagnostics.teamPercent },
      lpDataMode: lpDataModePublic,
      concentratedPositionProof,
    })
    const lpMovementWatch = buildLpMovementWatch({
      chain,
      lpControllerIntel,
      lpControl: { ...lpControl, lpController, lpControllerType, proofApplicability: lpProofApplicability },
      selectedPool: {
        pair: _primaryPair ?? ([ _dexFb?.baseToken?.symbol, _dexFb?.quoteToken?.symbol ].filter(Boolean).join('/') || null),
        address: lpPoolAddress ?? _dexFb?.pairAddress ?? null,
        poolId: primaryMarketPoolId ?? lpPool?.poolId ?? null,
        model: lpModelProof.model,
        liquidityUsd: _el,
      },
      lpMeta: { teamPercent: lpDiagnostics.teamPercent, lpToken: lpDiagnostics.lpTokenAddress },
    })
    const lpLockBurnIntel = buildLpLockBurnIntel({
      chain,
      lpControl: { ...lpControl, lpController, lpControllerType, proofApplicability: lpProofApplicability },
      lpControllerIntel: lpControllerIntel as unknown as Record<string, unknown>,
      selectedPool: {
        pair: _primaryPair ?? ([ _dexFb?.baseToken?.symbol, _dexFb?.quoteToken?.symbol ].filter(Boolean).join('/') || null),
        address: lpPoolAddress ?? _dexFb?.pairAddress ?? null,
        poolId: primaryMarketPoolId ?? lpPool?.poolId ?? null,
        model: lpModelProof.model,
        liquidityUsd: _el,
      },
      lpMeta: {
        teamPercent: lpDiagnostics.teamPercent,
        lpToken: lpDiagnostics.lpTokenAddress,
        primaryMarketType: lpDiagnostics.primaryMarketType,
        displayLpModel: lpControl.displayLpModel,
        lpControlState: lpDiagnostics.lpState ?? null,
      },
    })
    const lpUnlockTimeline = buildLpUnlockTimeline({
      chain,
      lpLockBurnIntel,
    })
    const lpHistoryTimeline = buildLpHistoryTimeline({
      chain,
      poolModel: lpModelProof.model,
      marketDataSource,
      selectedPool: {
        pair: _primaryPair ?? ([ _dexFb?.baseToken?.symbol, _dexFb?.quoteToken?.symbol ].filter(Boolean).join('/') || null),
        address: lpPoolAddress ?? _dexFb?.pairAddress ?? null,
        dex: lpControl.primaryPoolDex ?? primaryDexName ?? null,
        liquidityUsd: _el,
        createdAt: normalizedPairCreatedAt,
      },
      lpControl: {
        primaryMarketPool: lpControl.primaryMarketPool ?? null,
        primaryMarketPoolId: lpControl.primaryMarketPoolId ?? null,
      },
      primaryPoolAgeLabel: normalizedPairAgeLabel,
      poolCount: normalizedObservedPoolCount,
      observedPoolCount: normalizedObservedPoolCount,
      liquidityUsd: _el,
      lpMigrationProof,
    })

    // Separate secondary V2/ERC-20 LP exposure signal — never merged into the primary
    // pool's lpControllerIntel/lpMovementWatch/lpLockBurnIntel/lpUnlockTimeline/lpHistoryTimeline above.
    const secondaryLpExposure = buildSecondaryLpExposure({
      secondarySignals: lpControl.secondaryLpControlSignals
        ? { ...lpControl.secondaryLpControlSignals, pair: lpControl.secondaryLpControlSignals.pair ?? lpPair ?? null }
        : null,
      primaryDex: lpControl.primaryPoolDex ?? primaryDexName ?? null,
      primaryPair: _primaryPair ?? null,
      primaryPoolModel: lpModelProof.model,
    })

    // ── Data Fill Score: 0-100. Inferred values count at half weight ──
    const _fillMarket = (liquidityUsd != null || marketCapFromGt != null || fdv != null) ? 20 : 0
    const _fillHolder = holderDistributionStatus.status === 'ok' ? 20 : holderDistributionStatus.status === 'partial' ? 12 : holderIntelligence.status === 'inferred' ? 5 : 0
    const _fillLp = (lpState === 'burned' || lpState === 'locked' || lpState === 'team_controlled' || lpState === 'protocol' || lpState === 'concentrated_liquidity') ? 20 : lpState === 'partial' ? 10 : lpProofStatus === 'inferred' ? 5 : 0
    const _fillSim = hpResult.ok ? 20 : _simImpliedClean ? 10 : 0
    const _fillContract = (cortexContractFlags.bytecodeChecked || _grCI != null) ? 20 : cortexContractFlags.mint.status === 'inferred' ? 5 : 0
    const dataFillScore = _fillMarket + _fillHolder + _fillLp + _fillSim + _fillContract

    const riskEngine: RiskEngine = {
      rugRiskScore,
      rugRiskLabel,
      confidence: riskConfidence,
      cortexRead: rugRiskLabel === 'partial_data'
        ? `CORTEX scan returned partial data — ${majorMissingCount} modules operating on inference. Score reflects conservative risk baseline (${rugRiskScore}/100). Increase coverage for a verified verdict.`
        : rugRiskLabel === 'critical'
          ? `CORTEX flags critical risk. Multiple rug vectors confirmed: ${riskDrivers.slice(0, 2).join('; ') || 'see risk drivers'}.`
          : rugRiskLabel === 'high'
            ? `CORTEX flags high risk. Key concerns: ${riskDrivers.slice(0, 2).join('; ') || 'see risk drivers'}. Cross-check before exposure.`
            : rugRiskLabel === 'watch'
              ? `CORTEX shows watch conditions. ${openChecks.length > 0 ? `Next: ${openChecks[0]}` : 'Active risk signals present — monitor closely'}.`
              : `CORTEX shows low visible risk across verified checks. ${openChecks.length > 0 ? `${openChecks.length} check(s) require follow-up.` : 'All major checks passed.'}`,
      verifiedSignals: riskVerifiedSignals,
      riskDrivers,
      openChecks,
      dataFillScore,
      lpRisk: {
        status: lpProofStatus,
        confidence: lpProofStatus === 'not_applicable' ? 'medium' :
                    lpProofStatus === 'verified' ? 'high' :
                    lpProofStatus === 'partial' ? 'medium' : 'low',
      },
      sniperActivity,
      trendIntelligence,
      smartMoney,
      deployerProfile,
      holderIntelligence,
      lpIntelligence,
      clarkInterpretation,
    }
    // No lock-duration provider is wired up — never fabricate an unlock timestamp/countdown.
    const lpUnlockAt: string | null = null
    const lpCountdownSeconds: number | null = null
    const rugRisk: RugRiskReport = {
      lp_safety: {
        status: lpControl.status === "burned" || lpControl.status === "locked"
          ? "locked"
          : lpControl.status === "team_controlled"
            ? "team_controlled"
            : lpControl.status === "protocol"
              ? "protocol"
              : lpControl.status === "concentrated_liquidity"
                ? "concentrated_liquidity"
                : lpControl.status === "partial"
                  ? "partial"
                  // "open_check": liquidity was detected but the pool model/LP control path is
                  // unverified — never reported as "unlocked" (that would imply a confirmed
                  // ERC-20 LP token with no lock/burn proof, which has not been checked here).
                  : lpControl.status === "open_check"
                    ? "open_check"
                    : "unlocked",
        unlock_at: lpUnlockAt,
        countdown_seconds: lpCountdownSeconds,
        // Owner/controller of the LP — never the TOKEN contract owner/deployer. Only populated
        // when an LP controller wallet is actually verified (lpControllerAddress); null for
        // "open_check"/concentrated/protocol pools or when LP control is otherwise unproven.
        // Token-ownership renouncement is reported separately via security.devOwnership /
        // sections.ownership / CORTEX contract wording, never copied into the LP owner field.
        owner: lpControllerAddress ?? null,
        contract: primaryPoolAddress ?? null,
        movement_24h_usd: _ev ?? null,
        source_status: (lpControl.status === "error" || lpControl.status === "insufficient_data" || _lpControllerUnproven) ? "partial" : "ok",
        controller: _lpControllerUnproven ? "unknown" : (lpControllerAddress ?? null),
        note: lpControl.status === "open_check"
          ? "Market liquidity was detected, but the pool model and LP control path could not be verified from current evidence."
          : _lpControllerUnproven
            ? "LP controller is not proven for this concentrated-liquidity model."
            : null,
      },
      contract_flags: {
        honeypot: hpResult.ok ? hpResult.honeypot : null,
        // Use inferred flags when direct source not available: null → inferred from context
        blacklist: cortexContractFlags.blacklist.status === 'verified' ? true : (cortexContractFlags.blacklist.status === 'not_detected' || cortexContractFlags.blacklist.status === 'inferred') ? false : null,
        mint: cortexContractFlags.mint.status === 'verified' ? true : (cortexContractFlags.mint.status === 'not_detected' || cortexContractFlags.mint.status === 'inferred') ? false : null,
        upgradeable: cortexContractFlags.proxy.status === 'verified' ? true : (cortexContractFlags.proxy.status === 'not_detected' || cortexContractFlags.proxy.status === 'inferred') ? false : null,
        source_status: cortexContractFlags.bytecodeChecked ? "ok" : (hpResult.ok || gpHasData || _simImpliedClean) ? "partial" : "partial",
      },
      deployer_reputation: {
        score: ownerAddr && ownerAddr !== '0x0000000000000000000000000000000000000000' ? (rugRiskScore != null ? Math.max(0, 100 - rugRiskScore) : 50) : null,
        rug_history: null,
        deploy_patterns: ownerAddr ? [`owner_wallet=${ownerAddr}`] : [`inferred: no deployer wallet resolved — factory or anonymous deployment assumed`],
        source_status: ownerAddr ? "ok" : "partial",
      },
      sniper_activity: {
        level: sniperStatus === "high" ? "high" : sniperStatus === "watch" ? "medium" : "low",
        score: sniperStatus === "high" ? 85 : sniperStatus === "watch" ? 55 : 25,
        source_status: transactions24h == null ? "partial" : "ok",
      },
      early_buyers: [],
      liquidity_risk: {
        liquidity_usd: _el ?? null,
        volatility_24h_pct: _dexFb?.priceChange24h ?? pickNum((poolAttr.price_change_percentage as Record<string, unknown> | undefined)?.h24),
        source_status: (_el != null) ? "ok" : "partial",
      },
      trading_simulation: {
        success: hpResult.ok ? hpResult.simulationSuccess : null,
        buy_tax: hpResult.ok ? hpResult.buyTax : null,
        sell_tax: hpResult.ok ? hpResult.sellTax : null,
        source_status: hpResult.ok ? "ok" : "partial",
      },
      risk_drivers: riskDrivers,
      overall_rug_risk_score: rugRiskScore,
    }

    // Derive holder percentages when provider rows have raw balances but no percent fields.
    // bigIntPct(balance, supply) divides in the same raw unit so decimals cancel — no normalization needed.
    // Guard: both values must be raw integer strings (no decimal point, no scientific notation).
    // Prefer RPC totalSupply; fall back to provider-supplied total_supply when RPC is unavailable (e.g. ETH without Alchemy key).
    const _holderProviderSupply = holderItems.find((h: any) => h?.total_supply != null)?.total_supply
    // Compute sum of raw balances as last-resort supply estimate when both RPC and provider supply are unavailable
    let _summedBalanceSupply: string | null = null
    if (!rpcSupply && _holderProviderSupply == null && rawBalanceByAddress.size > 0) {
      try {
        let sum = BigInt(0)
        for (const bal of rawBalanceByAddress.values()) {
          const s = String(bal)
          if (s && !s.includes('.') && !/[eE]/.test(s)) sum += BigInt(s)
        }
        if (sum > BigInt(0)) _summedBalanceSupply = '0x' + sum.toString(16)
      } catch { /* ignore */ }
    }
    const _derivationSupply: string | null = (rpcSupply && rpcSupply !== '0x' && rpcSupply !== '0x0')
      ? rpcSupply
      : (_holderProviderSupply != null ? String(_holderProviderSupply) : _summedBalanceSupply)
    const _derivationSupplySource: 'rpc' | 'provider' | 'summed' | null = (rpcSupply && rpcSupply !== '0x' && rpcSupply !== '0x0') ? 'rpc' : (_holderProviderSupply != null ? 'provider' : (_summedBalanceSupply ? 'summed' : null))
    if (!hasPct && normalizedTop.length > 0 && _derivationSupply != null && (!holderProviderPercentFailedSanity || _derivationSupplySource !== 'summed')) {
      holderDerivationAttempted = true
      holderSanityDebug.reconstructionAttempted = holderSanityDebug.reconstructionAttempted || holderProviderPercentFailedSanity
      let totalSupplyBig: bigint | null = null
      try { totalSupplyBig = String(_derivationSupply).startsWith('0x') ? BigInt(String(_derivationSupply)) : BigInt(String(_derivationSupply)) } catch {}
      const derivedCount = totalSupplyBig != null
        ? deriveHolderPercentagesFromSupply(normalizedTop as Array<{ address: string; percent: number | null }>, rawBalanceByAddress, totalSupplyBig)
        : 0
      if (derivedCount > 0) {
        const reconstructedSanity = validateHolderPercentSanity(normalizedTop)
        if (reconstructedSanity.sane) {
          holderDerivationSucceeded = true
          holderSanityDebug.reconstructionSucceeded = holderSanityDebug.reconstructionSucceeded || holderProviderPercentFailedSanity
          hasPct = true
          percentSource = holderProviderPercentFailedSanity ? 'reconstructed' : 'calculated'
          top1 = sum(1); top5 = sum(5); top10 = sum(10); top20 = sum(20)
          holderDistribution = {
            top1, top5, top10, top20,
            others: top20 != null ? Math.max(0, 100 - top20) : null,
            holderCount,
            topHolders: normalizedTop,
          }
          holderDistributionStatus = {
            status: holderProviderPercentFailedSanity ? 'partial' : 'ok',
            reason: holderProviderPercentFailedSanity
              ? 'holder_percentages_reconstructed_from_total_supply'
              : _derivationSupplySource === 'provider'
              ? 'holder_percentages_derived_from_provider_supply'
              : _derivationSupplySource === 'summed'
              ? 'holder_percentages_derived_from_summed_balances'
              : 'holder_percentages_derived_from_rpc_supply',
            itemCount: holderItems.length,
            normalizedCount: normalizedTop.length,
            percentSource,
          }
        } else {
          clearHolderPercentages(normalizedTop)
          hasPct = false
          percentSource = 'inferred'
          top1 = null; top5 = null; top10 = null; top20 = null
          holderDistribution = { ...holderDistribution, top1, top5, top10, top20, others: null, topHolders: normalizedTop }
          holderDistributionStatus = {
            status: 'partial',
            reason: 'holder_percentages_failed_sanity_check',
            itemCount: holderItems.length,
            normalizedCount: normalizedTop.length,
            percentSource,
          }
        }
      } else {
        holderDerivationFailureReason = normalizedTop.length > 0
          ? 'raw_balance_missing_or_float_format'
          : 'no_holder_rows'
      }
    }
    holderSanityDebug.finalPercentSource = percentSource


    const ethOriginDiscovery = chain === 'eth' ? await discoverTokenOrigin(chain, contract) : null

    const roundSupplyPct = (value: number): number => Math.round(value * 100) / 100
    const normalizeActorAddress = (value: string | null | undefined): string | null => {
      if (typeof value !== 'string') return null
      const trimmed = value.trim().toLowerCase()
      return /^0x[a-f0-9]{40}$/.test(trimmed) && trimmed !== _ZERO_ADDR && trimmed !== DEAD_ADDRESS ? trimmed : null
    }
    const ethOriginCandidate = normalizeActorAddress(ethOriginDiscovery?.candidate.address ?? null)
    // For Base: prefer ownerAddr (current owner/control wallet); fall back to _ownerFromTransfer
    // (initial mint recipient) when ownerAddr is null or zero (renounced).
    const deployerAddress = chain === 'eth' ? ethOriginCandidate : (normalizeActorAddress(ownerAddr) ?? normalizeActorAddress(_ownerFromTransfer))
    const ethLinkedWalletResult = chain === 'eth' && deployerAddress
      ? await findTokenLinkedWallets(chain, deployerAddress, contract)
      : null
    const linkedWallets: LinkedWallet[] = chain === 'eth'
      ? (ethLinkedWalletResult?.wallets ?? [])
      : [adminAddr]
        .map(normalizeActorAddress)
        .filter((address): address is string => Boolean(address && address !== deployerAddress))
        .filter((address, index, arr) => arr.indexOf(address) === index)
        .map((address) => ({ address, amountReceived: null, asset: null, txHash: null, firstSeen: null, reason: 'admin_or_proxy_control_wallet', confidence: 'medium' as const }))
    const ethOrigin = ethOriginDiscovery?.candidate ?? null
    const devDeployerStatus = chain === 'eth'
      ? (deployerAddress ? (ethOrigin?.deployerStatus ?? 'possible_match') : 'not_confirmed')
      : (deployerAddress ? 'confirmed' : 'not_confirmed')
    const devDeployerConfidence = chain === 'eth'
      ? (deployerAddress ? (ethOrigin?.confidence ?? 'medium') : 'low')
      : (deployerAddress ? 'high' : 'low')
    const devMethodUsed = chain === 'eth'
      ? (ethOrigin?.methodUsed ?? 'unknown')
      : (deployerAddress ? (_ownerFromTransfer ? 'moralis_transfer_fallback' : 'rpc_selector') : 'unknown')
    const devCreationTxHash = chain === 'eth' ? (ethOrigin?.creationTxHash ?? null) : null
    const devOriginReason = chain === 'eth'
      ? (ethOrigin?.reason ?? 'No ETH origin candidate found from Token Scanner checks')
      : (deployerAddress ? (_ownerFromTransfer ? 'Deployer inferred from earliest mint transfer recipient.' : 'Deployer resolved from ownership/control checks.') : 'Deployer not resolved from token scan data.')

    // Reconcile deployerProfile with the resolved deployer/origin wallet (devIntel.deployerAddress).
    // The zero address only ever represents a renounced *owner* — it must never appear as
    // `deployer`. When no deployer/origin wallet is resolved, report null/inferred (open check).
    if (deployerAddress) {
      const _deployerMethod = devMethodUsed === 'unknown' ? 'inference' : devMethodUsed
      riskEngine.deployerProfile = {
        ...riskEngine.deployerProfile,
        status: 'verified',
        deployer: deployerAddress,
        method: publicSourceLabel(_deployerMethod, debugMode),
        rugHistory: 0,
        clusterRisk: isRenounced ? 'clean' : riskEngine.deployerProfile.clusterRisk,
        note: `Deployer/origin wallet identified via ${_deployerMethod === 'rpc_selector' ? 'on-chain owner() call' : _deployerMethod === 'moralis_transfer_fallback' ? 'on-chain mint transfer event' : 'on-chain origin discovery'}.${isRenounced ? ' Current owner is separately confirmed renounced (zero address) — this address is the deployer/origin wallet, not the current owner.' : ''} Rug history lookup requires manual on-chain/explorer cross-reference.`,
      }
    } else if (isRenounced) {
      riskEngine.deployerProfile = {
        ...riskEngine.deployerProfile,
        status: 'inferred',
        deployer: null,
        method: 'inference',
        rugHistory: null,
        note: 'Ownership renounced — zero address confirmed as current owner. Deployer/origin wallet not resolved from RPC or transfer events.',
      }
    }
    // Reconcile rugRisk.deployer_reputation with the same resolved deployer/origin wallet —
    // never report the (possibly renounced/zero) owner address as the deployer wallet.
    rugRisk.deployer_reputation = {
      score: deployerAddress ? (rugRiskScore != null ? Math.max(0, 100 - rugRiskScore) : 50) : null,
      rug_history: null,
      deploy_patterns: deployerAddress ? [`deployer_wallet=${deployerAddress}`] : [`inferred: no deployer wallet resolved — factory or anonymous deployment assumed`],
      source_status: deployerAddress ? "ok" : "partial",
    }
    const linkedAddressSet = new Set(linkedWallets.map((wallet) => wallet.address))
    const holderRows = holderDistribution.topHolders ?? []
    const transferResolverResult = await resolveTokenTransfers({
      chain,
      chainId: CHAIN_ID_MAP[chain],
      tokenAddress: contract,
      deployerAddress,
      holderAddresses: holderRows.map((holder) => holder.address).filter(Boolean),
      limit: 200,
      providerTransfersRaw: moralisTransfersRaw,
    })
    const holderRowsHaveUsablePercents = holderRows.some((h) => typeof h.percent === 'number' && Number.isFinite(h.percent))
    const holderRowsConfirmed = holderRowsHaveUsablePercents
    const supplyRowsArePartial = holderDistributionStatus.status === 'partial' || (holderDistributionStatus.percentSource === 'calculated' || holderDistributionStatus.percentSource === 'reconstructed')
    let creatorHolderRank: number | null = null
    let creatorHolderPercent: number | null = null
    let linkedWalletSupplyAccumulator = 0
    const matchedLinkedWallets: SupplyControl['matchedLinkedWallets'] = []
    const matchedActorAddresses = new Set<string>()

    if (holderRowsHaveUsablePercents) {
      for (const holder of holderRows) {
        const address = normalizeActorAddress(holder.address)
        const percent = typeof holder.percent === 'number' && Number.isFinite(holder.percent) ? holder.percent : null
        if (!address || percent == null) continue
        if (deployerAddress && address === deployerAddress && !matchedActorAddresses.has(address)) {
          creatorHolderRank = holder.rank ?? null
          creatorHolderPercent = percent
          matchedActorAddresses.add(address)
          continue
        }
        if (linkedAddressSet.has(address) && !matchedActorAddresses.has(address)) {
          linkedWalletSupplyAccumulator += percent
          matchedLinkedWallets.push({
            address,
            percent: roundSupplyPct(percent),
            rank: holder.rank ?? null,
            confidence: linkedWallets.find((wallet) => wallet.address === address)?.confidence ?? 'medium',
          })
          matchedActorAddresses.add(address)
        }
      }
    }

    const linkedWalletSupplyPercent = holderRowsConfirmed ? roundSupplyPct(linkedWalletSupplyAccumulator) : null
    const devClusterSupplyPercent = (deployerAddress || linkedWallets.length > 0) && holderRowsConfirmed
      ? roundSupplyPct((creatorHolderPercent ?? 0) + linkedWalletSupplyAccumulator)
      : null
    const creatorInTopHolders = deployerAddress && holderRowsConfirmed ? creatorHolderPercent != null : null
    const linkedWalletSupplyStatus: CanonicalStatus = linkedWallets.length === 0
      ? 'not_applicable'
      : !holderRowsConfirmed
        ? 'unavailable_with_reason'
        : matchedLinkedWallets.length > 0
          ? 'verified'
          : supplyRowsArePartial
            ? 'partial'
            : 'verified'
    const devClusterSupplyStatus: CanonicalStatus = !(deployerAddress || linkedWallets.length > 0)
      ? 'unavailable_with_reason'
      : !holderRowsConfirmed
        ? 'unavailable_with_reason'
        : matchedActorAddresses.size > 0
          ? 'verified'
          : supplyRowsArePartial
            ? 'partial'
            : 'verified'
    const devClusterSupplyReason = !(deployerAddress || linkedWallets.length > 0)
      ? 'no_deployer_or_linked_wallets'
      : !holderRowsConfirmed
        ? 'no_usable_holder_rows_or_percents'
        : matchedActorAddresses.size === 0
          ? 'creator_and_linked_wallets_checked_against_available_holder_rows_no_supply_found'
          : 'matched_holder_rows_with_percent_values'
    const clusterInfluence = buildClusterInfluence({
      clusterSupplyPercent: devClusterSupplyPercent,
      creatorInTopHolders,
      matchedLinkedWallets,
      suspiciousTransfers: false,
      holderEvidenceAvailable: holderRowsConfirmed,
      holderEvidencePartial: supplyRowsArePartial,
    })
    const supplyControl: SupplyControl = {
      creatorInTopHolders,
      creatorHolderRank,
      creatorHolderPercent: creatorHolderPercent != null ? roundSupplyPct(creatorHolderPercent) : null,
      linkedWalletSupplyPercent,
      linkedWalletSupplyStatus,
      devClusterSupplyPercent,
      devClusterSupplyStatus,
      devClusterSupplyReason,
      matchedLinkedWallets,
      clusterInfluence,
      ...(holderResolverResult.insufficientEvidence || (!deployerAddress && linkedWallets.length === 0) ? {
        insufficientEvidence: true,
        reason: !deployerAddress && linkedWallets.length === 0
          ? 'Supply control open check: no deployer or linked-wallet actors were resolved in this pass.'
          : (holderResolverResult.reason ?? 'Holder evidence unavailable in this pass.'),
        fallbackUsed: holderResolverResult.fallbackUsed ?? 'none',
        confidence: 'low' as const,
      } : {}),
    }
    const clusterMap = buildClusterMap({
      deployerAddress,
      deployerStatus: devDeployerStatus,
      linkedWallets,
      matchedLinkedWallets,
      supplyControl,
      holderDistribution,
      suspiciousTransfers: false,
      suspiciousTransferReasons: [],
      holderRowsAvailable: holderRowsConfirmed,
    })
    if (clusterMap.summary.clusterSupplyPercent != null && clusterMap.summary.clusterSupplyPercent >= 20) {
      const driver = `Dev cluster supply is elevated at ${clusterMap.summary.clusterSupplyPercent.toFixed(1)}% from matched holder evidence.`
      if (!riskEngine.riskDrivers.includes(driver)) riskEngine.riskDrivers.push(driver)
      if (!riskEngine.clarkInterpretation.riskDrivers.includes(driver)) riskEngine.clarkInterpretation.riskDrivers.push(driver)
    }
    if (supplyControl.creatorInTopHolders) {
      const driver = 'Deployer appears in top-holder rows.'
      if (!riskEngine.riskDrivers.includes(driver)) riskEngine.riskDrivers.push(driver)
      if (!riskEngine.clarkInterpretation.riskDrivers.includes(driver)) riskEngine.clarkInterpretation.riskDrivers.push(driver)
    }
    if (supplyControl.linkedWalletSupplyPercent != null && supplyControl.linkedWalletSupplyPercent > 0) {
      const driver = `Linked wallet supply found (${supplyControl.linkedWalletSupplyPercent.toFixed(1)}%).`
      if (!riskEngine.riskDrivers.includes(driver)) riskEngine.riskDrivers.push(driver)
      if (!riskEngine.clarkInterpretation.riskDrivers.includes(driver)) riskEngine.clarkInterpretation.riskDrivers.push(driver)
    }
    if (clusterMap.edges.length === 0) {
      const openCheck = 'Cluster Map: no cluster edges confirmed from current transfer and holder evidence.'
      if (!riskEngine.openChecks.includes(openCheck)) riskEngine.openChecks.push(openCheck)
      if (!riskEngine.clarkInterpretation.openChecks.includes(openCheck)) riskEngine.clarkInterpretation.openChecks.push(openCheck)
    }
    if (!holderRowsConfirmed) {
      const openCheck = 'Cluster Map: holder rows are missing or partial, so cluster supply is not confirmed.'
      if (!riskEngine.openChecks.includes(openCheck)) riskEngine.openChecks.push(openCheck)
      if (!riskEngine.clarkInterpretation.openChecks.includes(openCheck)) riskEngine.clarkInterpretation.openChecks.push(openCheck)
    }
    for (const action of ['Monitor linked wallets for new receives or sells.', 'Rescan after holder index updates to compare cluster supply.', 'Watch for large transfers involving confirmed cluster wallets.']) {
      if (!riskEngine.clarkInterpretation.nextActions.includes(action)) riskEngine.clarkInterpretation.nextActions.push(action)
    }
    const devIntel = {
      deployerAddress,
      deployerStatus: devDeployerStatus,
      deployerConfidence: devDeployerConfidence,
      methodUsed: publicSourceLabel(devMethodUsed, debugMode),
      creationTxHash: devCreationTxHash,
      linkedWallets,
      creatorInTopHolders,
      linkedWalletSupply: linkedWalletSupplyPercent,
      linkedWalletSupplyPercent,
      devClusterSupply: devClusterSupplyPercent,
      devClusterSupplyPercent,
      matchedLinkedWallets,
      holderDistribution: { top1: holderDistribution.top1, top10: holderDistribution.top10, top20: holderDistribution.top20, topHolders: holderDistribution.topHolders },
      holderDistributionStatus: holderDistributionStatus.status,
      holderPercentAvailable: holderRowsHaveUsablePercents,
      holderPercentSource: holderDistributionStatus.percentSource,
      suspiciousTransfers: false,
      suspiciousTransferReasons: [],
      transferEvidence: {
        transferCount: transferResolverResult.transfers.length,
        insufficientEvidence: transferResolverResult.insufficientEvidence,
        reason: transferResolverResult.reason ?? null,
        fallbackUsed: publicSourceLabel(transferResolverResult.fallbackUsed, debugMode) ?? null,
        confidence: transferResolverResult.confidence,
      },
      holderEvidence: {
        holderCount: holderResolverResult.holders.length,
        insufficientEvidence: holderResolverResult.insufficientEvidence,
        reason: holderResolverResult.reason ?? null,
        fallbackUsed: publicSourceLabel(holderResolverResult.fallbackUsed, debugMode) ?? null,
        confidence: holderResolverResult.confidence,
      },
      insufficientEvidence: holderResolverResult.insufficientEvidence && transferResolverResult.insufficientEvidence,
      reason: holderResolverResult.insufficientEvidence && transferResolverResult.insufficientEvidence
        ? 'Dev Control open check: holder and transfer evidence were unavailable in this pass.'
        : devOriginReason,
      clusterInfluence,
      reasons: [devOriginReason],
      confidence: deployerAddress && holderRowsHaveUsablePercents ? 'high' : deployerAddress || holderRowsHaveUsablePercents ? 'medium' : 'low',
      supplyControl,
      clusterMap,
    }

    const bytecodeStatus = bytecode && bytecode !== '0x' ? 'ok' : 'inferred'
    const ownerStatus = ownerAddr ? 'ok' : 'inferred'
    // mint/proxy status: always 'ok' now since we always return inferred/not_detected/verified
    const mintStatus = (cortexContractFlags.mint.status === 'verified' || cortexContractFlags.mint.status === 'not_detected') ? 'ok' : 'inferred'
    const proxyStatus = (cortexContractFlags.proxy.status === 'verified' || cortexContractFlags.proxy.status === 'not_detected') ? 'ok' : 'inferred'
    const transferControlStatus = hpResult.ok ? 'partial' : 'inferred'
    const contractChecksStatus: "ok" | "partial" | "inferred" | "error" =
      cortexContractFlags.bytecodeChecked ? 'partial' : (bytecodeStatus === 'ok' ? 'partial' : 'inferred')
    const contractChecksReason = contractChecksStatus === 'inferred'
      ? 'Contract flags inferred from simulation and chain context — direct bytecode verification not available.'
      : 'Contract bytecode, supply, owner, and CORTEX flag scan reviewed.'

    const { _foundKeys: _psFoundKeys, _rejectedCount: _psRejectedCount, ...projectSocials } =
      extractProjectSocials(gtToken, coingeckoRaw, gmgnItem, _dexFb)

    // Resolve the public-facing "analysis" copy from actual resolved evidence instead of the
    // static analyzeContract() placeholders — avoids contradicting verified ownership,
    // simulation, and LP-proof state in the rest of the response.
    const resolvedAnalysis = {
      ...analysis,
      ownerStatus: _ownershipStatusFinal === 'renounced'
        ? 'Ownership verified renounced — contract owner is the zero address.'
        : _ownershipStatusFinal === 'held'
          ? 'Ownership verified — contract owner is an active, non-renounced address.'
          : analysis.ownerStatus,
      honeypot: hpResult.ok
        ? (hpResult.honeypot
          ? 'Trading simulation flagged this token as a honeypot — sell transactions blocked.'
          : `Trading simulation passed${(hpResult.buyTax != null && hpResult.sellTax != null) ? ` with ${hpResult.buyTax}% buy / ${hpResult.sellTax}% sell tax` : ''}.`)
        : analysis.honeypot,
      liquidityStatus: lpLockStatus === 'locked'
        ? 'LP is locked via a time-lock contract.'
        : lpLockStatus === 'burned'
          ? 'LP is burned — liquidity is permanently locked.'
          : lpProofApplicability === 'not_applicable'
            ? 'Concentrated liquidity detected — standard ERC-20 LP lock/burn proof does not apply to the primary concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.'
            : lpPoolAddressPresent && lpProofApplicability === 'applicable'
              ? (lpControllerType === 'wallet'
                ? 'LP controller is wallet-controlled — lock/burn proof is not confirmed.'
                : 'LP pool identified — lock/burn proof is not confirmed for the selected pool.')
              : analysis.liquidityStatus,
    }

    _scanStage = 'response_assembly'
    const responsePayload = {
      chain,
      contract,
      resolvedInput,

      // Core token fields
      name: finalResolvedName,
      symbol: finalResolvedSymbol,
      decimals: resolvedDecimals,

      // Pool state — reflects both primary and fallback market reads
      noActivePools: noActivePools,

      // Market source flags
      marketDataSource,
      marketConfidence,
      marketStatus,

      // Temporary debug — traces the resolver → metadata → GeckoTerminal → DexScreener →
      // normalizePools() → selectedPool pipeline for diagnosing market-discovery regressions.
      // Safe to remove once the upstream regression class is confirmed fixed.
      _marketDebug: {
        resolverWorked: Boolean(resolvedAddress),
        resolvedAddress,
        requestedChain: rawChain,
        metadataResolved: _diagMetadataResolved,
        metadataName: finalResolvedName,
        metadataSymbol: finalResolvedSymbol,
        geckoAttempted: true,
        geckoSucceeded: gtData != null,
        geckoPoolCount: gtAllPools.length,
        geckoError: gtData == null ? 'no_data_or_request_failed' : null,
        dexAttempted: isFullScanChain,
        dexSucceeded: _dexFb != null,
        dexPairCount: _dexFb != null ? 1 : 0,
        dexError: (isFullScanChain && _dexFb == null) ? 'no_data_or_request_failed' : null,
        normalizedPoolCount: normalizedPools.length,
        selectedPoolAddress: lpPoolAddress,
        selectedPoolDex: lpDexName,
        selectedPoolType: lpPoolType,
        noActivePoolsReason: noActivePools
          ? (gtAllPools.length === 0 && _dexFb == null ? 'no_pools_from_any_provider' : 'no_usable_pool_selected')
          : null,
      },

      // Extra data
      ...(debugMode ? { holders: goldrush?.holders || null } : {}),
      // Public response caps the holder list to a small UI-safe count — full 100+ holder
      // arrays are debug-only.
      holderDistribution: debugMode ? holderDistribution : { ...holderDistribution, topHolders: (holderDistribution.topHolders ?? []).slice(0, 10) },
      holderDistributionStatus,
      holderStatus: holdersStatus,
      holderResolver: {
        ...(debugMode ? { holders: holderResolverResult.holders.map((h) => ({ ...h, source: publicSourceLabel(h.source, debugMode) })) } : { holderCount: holderResolverResult.holders.length }),
        insufficientEvidence: holderResolverResult.insufficientEvidence,
        reason: holderResolverResult.reason ?? null,
        fallbackUsed: publicSourceLabel(holderResolverResult.fallbackUsed, debugMode) ?? null,
        confidence: holderResolverResult.confidence,
      },
      transferResolver: {
        ...(debugMode ? { transfers: transferResolverResult.transfers.map((t) => ({ ...t, source: publicSourceLabel(t.source, debugMode) })) } : { transferCount: transferResolverResult.transfers.length }),
        insufficientEvidence: transferResolverResult.insufficientEvidence,
        reason: transferResolverResult.reason ?? null,
        fallbackUsed: publicSourceLabel(transferResolverResult.fallbackUsed, debugMode) ?? null,
        confidence: transferResolverResult.confidence,
      },
      suspiciousFlows: {
        ...(debugMode ? { transfers: transferResolverResult.transfers.map((t) => ({ ...t, source: publicSourceLabel(t.source, debugMode) })) } : { transferCount: transferResolverResult.transfers.length }),
        insufficientEvidence: transferResolverResult.insufficientEvidence,
        reason: transferResolverResult.insufficientEvidence ? (transferResolverResult.reason ?? 'Transfer evidence unavailable in this pass.') : 'Transfer evidence available from resolver.',
        fallbackUsed: publicSourceLabel(transferResolverResult.fallbackUsed ?? 'none', debugMode),
        confidence: transferResolverResult.confidence,
      },
      earlyBuyers: {
        wallets: [],
        insufficientEvidence: transferResolverResult.insufficientEvidence,
        reason: transferResolverResult.insufficientEvidence ? (transferResolverResult.reason ?? 'Transfer evidence unavailable in this pass.') : 'Early-buyer labelling is not derived without trade records containing real wallet addresses.',
        fallbackUsed: publicSourceLabel(transferResolverResult.fallbackUsed ?? 'none', debugMode),
        confidence: transferResolverResult.insufficientEvidence ? 'low' : 'medium',
      },
      devIntel,
      deployerAddress,
      deployerStatus: devDeployerStatus,
      deployerConfidence: devDeployerConfidence,
      methodUsed: publicSourceLabel(devMethodUsed, debugMode),
      creationTxHash: devCreationTxHash,
      linkedWallets,
      supplyControl,
      linkedWalletSupplyPercent,
      devClusterSupplyPercent,
      matchedLinkedWallets,
      creatorInTopHolders,
      ...(debugMode === true && debugHolder === true ? {
        debugHolderStatus: {
          providerCalled: holdersRaw?.__status !== 'not_configured',
          chain: chain === 'eth' ? 'eth-mainnet' : 'base-mainnet',
          endpointPath: holdersRaw?.__endpointPath ?? `/v1/${chain === 'eth' ? 'eth-mainnet' : 'base-mainnet'}/tokens/${contract}/token_holders_v2/`,
          authMode: 'bearer',
          holderKeyConfigured: Boolean(process.env.GOLDRUSH_API_KEY),
          holderAltKeyConfigured: Boolean(process.env.COVALENT_API_KEY),
          statusCode: holdersRaw?.__statusCode ?? null,
          itemCount: holderItems.length,
          normalizedCount: normalizedTop.length,
          reason: holderDistributionStatus?.reason ?? holderDistributionStatus?.status ?? null,
          responseKeys: holdersRaw?.__responseKeys ?? null,
          dataKeys: holdersRaw?.data ? Object.keys(holdersRaw.data) : null,
          firstItemKeys: holderItems[0] ? Object.keys(holderItems[0]) : null,
        }
      } : {}),
      // Normalized top-level market fields
      priceUsd: _ep,
      priceSource: publicSourceLabel(_priceSource, debugMode),
      liquidityUsd: _el,
      volume24hUsd: _ev,
      poolCount: normalizedObservedPoolCount,
      observedPoolPresent: observedPoolPresent || fallbackPoolEvidencePresent,
      observedPoolCount: normalizedObservedPoolCount,
      poolCountStatus,
      primaryDexName,
      // Legacy pool-level field kept for frontend pair display
      liquidity: mainPool?.attributes?.reserve_in_usd ?? _dexFb?.liquidityUsd ?? null,
      market_cap: marketCapFromGt,
      marketCapUsd: marketCapFromGt,
      marketCapStatus: marketCapFromGt != null ? 'verified' : (_efdv != null ? 'inferred' : 'partial'),
      marketCapSource: publicSourceLabel(marketCapSource, debugMode),
      marketCapReason: marketCapFromGt != null
        ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'Verified live market data' : 'Verified live pool market data')
        : _efdv != null ? 'FDV used as market cap proxy — circulating supply not confirmed'
        : 'Market cap not resolved — pool data or token endpoint did not return supply',
      ...(debugMode ? { marketCapDiagnostics: {
        selectedMarketCapUsd: marketCapDiagnosticsResolved.marketCapUsd,
        selectedMarketCapStatus: marketCapDiagnosticsResolved.marketCapStatus,
        selectedMarketCapFieldPath: marketCapDiagnosticsResolved.marketCapFieldPath,
        selectedValuationBasis: marketCapValuationBasis.basis,
        fdvUsd: _efdv,
        rawCandidates: marketCapDiagnosticsResolved.rawCandidates,
        resolverReason: marketCapDiagnosticsResolved.reason,
      } } : {}),
      circulating_supply: circulatingSupply,
      fdv: _efdv,
      fdvUsd: _efdv,
      fdvSource: publicSourceLabel(_efdv != null ? (fdv != null ? fdvSource : 'fallback') : 'partial', debugMode),
      displayMarketValue,
      displayMarketValueLabel,
      displayMarketValueConfidence,
      displayMarketValueReason,
      valuationContext: {
        primaryValuationLabel: marketCapFromGt != null ? 'Market Cap' : (_efdv != null ? 'FDV' : 'Market Cap'),
        primaryValuationUsd: marketCapFromGt ?? _efdv ?? null,
        primaryValuationStatus: marketCapFromGt != null ? 'verified_mc' : (_efdv != null ? 'fdv_only' : 'partial'),
        marketCapStatus: marketCapFromGt != null ? 'verified' : 'partial',
        fdvUsd: _efdv ?? null,
        reason: marketCapFromGt != null ? 'Verified live market data' : (_efdv != null ? 'Market cap not verified live; FDV used as valuation context.' : 'No live valuation context was verified.'),
      },
      estimatedMarketCap: null,
      estimatedMarketCapConfidence: null,
      estimatedMarketCapReason: marketCapFromGt != null ? 'Verified live market data' : 'Circulating supply not verified by live market data',

      poolActivity: {
        transactions24h,
        buys24h,
        sells24h,
        volume24hUsd: _ev,
        buyVolume24hUsd,
        sellVolume24hUsd,
        pairCreatedAt: normalizedPairCreatedAt ?? pairCreatedAt ?? _dexFb?.pairCreatedAt ?? null,
        pairAgeLabel: normalizedPairAgeLabel,
      },
      priceChart,
      chartStatus,
      chartSource,
      chartReason,
      chartDataSource,
      marketTrendSnapshot,

      // Public/default response carries only a trimmed view of the selected/main pool —
      // full raw pool dumps, the GeckoTerminal raw payload, and GMGN raw data are
      // diagnostics-only and only included when debug=true.
      pairs: debugMode ? matchingPools : (mainPool ? [{
        attributes: {
          name: (mainPool.attributes as Record<string, unknown> | undefined)?.name ?? null,
          address: (mainPool.attributes as Record<string, unknown> | undefined)?.address ?? null,
          base_token_price_usd: (mainPool.attributes as Record<string, unknown> | undefined)?.base_token_price_usd ?? null,
          reserve_in_usd: (mainPool.attributes as Record<string, unknown> | undefined)?.reserve_in_usd ?? null,
          volume_usd: (mainPool.attributes as Record<string, unknown> | undefined)?.volume_usd ?? null,
          price_change_percentage: (mainPool.attributes as Record<string, unknown> | undefined)?.price_change_percentage ?? null,
          pool_created_at: (mainPool.attributes as Record<string, unknown> | undefined)?.pool_created_at ?? null,
        },
      }] : []),
      // Selected canonical LP-verification pool — the single pool ChainLens used for LP
      // control/proof analysis, summarized for public display.
      selectedPool: {
        pair: _primaryPair ?? ([ _dexFb?.baseToken?.symbol, _dexFb?.quoteToken?.symbol ].filter(Boolean).join('/') || null),
        address: lpPoolAddress ?? _dexFb?.pairAddress ?? null,
        dex: lpControl.primaryPoolDex ?? primaryDexName ?? _dexFb?.dexId ?? null,
        model: lpModelProof.model,
        liquidityUsd: _el,
        createdAt: normalizedPairCreatedAt,
      },
      ...(debugMode ? {
        gtPools: matchingPools,
        gtRaw: gtData || null,
        gmgn: gmgn?.data || null,
      } : {}),

      contractSecurity: null,

      security: {
        // resolveSimulation result — null when simulation provider is unavailable
        simulation: _simResult ? { ..._simResult, source: publicSourceLabel(_simResult.source, debugMode) } : _simResult,
        simulationStatus: hpResult.ok ? 'ok' : 'open_check',
        simulationReason: hpResult.ok ? null : simulationOpenReason,
        // Tax confirmation is independent of honeypot confirmation — 0%/0% tax never implies
        // the honeypot simulation itself succeeded or returned a verdict.
        tax: {
          buyTax: hpResult.ok ? hpResult.buyTax : null,
          sellTax: hpResult.ok ? hpResult.sellTax : null,
          status: hpResult.ok && (hpResult.buyTax != null || hpResult.sellTax != null) ? 'confirmed' : 'unavailable',
        },
        // resolveContractFlags: ABI scan with bytecode fallback
        contractFlags: resolveContractFlags(grContractIntel, cortexContractFlags),
        devOwnership: {
          // Confirmed-zero address is shown (proof of renouncement); null only means
          // ownership was never verified — never conflate "renounced" with "unknown".
          ownerAddress: _ownerAddressForDisplay,
          adminAddress: adminAddr ?? null,
          isRenounced,
          ownershipVerified,
          ownershipStatus,
          ownershipLabel,
        },
        ...(debugMode === true ? {
          securityDebug: {
            providerAttempted: true,
            mappedHoneypotValue: hpResult.ok ? hpResult.honeypot : null,
            taxMapped: hpResult.ok && (hpResult.buyTax != null || hpResult.sellTax != null),
            simulationStatus: hpResult.ok ? hpResult.honeypotStatus : 'unavailable',
            simulationReason: hpResult.ok ? hpResult.honeypotReason : simulationOpenReason,
          },
        } : {}),
      },

      // Internal diagnostics
      _diagnostics: {
        marketPrimaryPair: marketPair,
        lpVerificationPair: lpPair,
        lpVerificationPoolAddress: lpPoolAddress,
        lpVerificationPoolReason: lpReason,
        ...((process.env.NODE_ENV !== 'production' || debugHolder === true) ? {
          lpPoolCandidates: selectedLpPool.candidates.slice(0, 10).map((c) => ({
            pair: c.pairName ?? `${c.baseTokenSymbol ?? "?"}/${c.quoteTokenSymbol ?? "?"}`,
            poolAddress: c.address ? `${c.address.slice(0, 10)}…${c.address.slice(-4)}` : "none",
            liquidityUsd: c.liquidityUsd,
            dexId: c.dexId,
            dexName: c.dexName,
            quoteSymbol: c.quoteTokenAddress === String(contract).toLowerCase() ? c.baseTokenSymbol : c.quoteTokenSymbol,
            quoteAddress: (() => {
              const qa = c.quoteTokenAddress === String(contract).toLowerCase() ? c.baseTokenAddress : c.quoteTokenAddress;
              return qa ? `${qa.slice(0, 10)}…${qa.slice(-4)}` : "none";
            })(),
            containsScannedToken: c.containsScannedToken ?? false,
            isPreferredQuote: c.isPreferredQuote ?? false,
            poolType: c.poolType,
            lpScore: c.lpScore ?? null,
            selectionReason: c.selectionReason ?? null,
          })),
        } : {}),
        alchemy: {
          configured: alchemyConfigured,
          lpProbeAttempted: Boolean(lpPoolAddress && (lpPoolType === "unknown" || lpPoolType === "v2")),
          lpProbeReason: !lpPoolAddress ? "no_pool_address" : (!alchemyConfigured ? "alchemy_not_configured" : (lpPoolType === "unknown" ? "unknown_pool_type_probe" : (lpPoolType === "v2" ? "v2_fallback_checks" : "not_needed"))),
          rpcCallsAttempted,
          rpcCallsSucceeded,
          rpcCallsFailed,
          contractChecksAttempted: true,
        },
        providerUsed: { market: 'market_layer', holders: 'holders_layer', security: hpResult.ok ? 'risk_layer' : 'inferred', contractChecks: 'risk_layer', liquidity: 'lp_layer' },
        marketFallback: { attempted: !_primaryHasMarket, found: _dexFb != null, pairAddress: _dexFb?.pairAddress ?? null, dexId: _dexFb?.dexId ?? null },
        tokenMarketFieldsPresent: {
          priceUsd: _ep != null,
          liquidityUsd: _el != null,
          volume24hUsd: _ev != null,
          marketCapUsd: marketCapFromGt != null,
          tokenEndpointMarketCapPresent: tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0,
          poolEndpointMarketCapPresent,
          fdvUsd: _efdv != null,
          poolCount: poolCount > 0,
        },
        missingReasons: [
          _ep == null ? 'priceUsd: no pool price' : '',
          _el == null ? 'liquidityUsd: no pool reserve' : '',
          _ev == null ? 'volume24hUsd: no pool volume' : '',
          marketCapFromGt == null ? 'marketCapUsd: not in GT token response' : '',
          _efdv == null ? 'fdvUsd: not in GT token or pool response' : '',
        ].filter(Boolean),
        ...((debugMode === true || debugHolder === true) ? { debug: (() => {
          const mp = mainPool as Record<string, unknown> | null
          const mpAttr = (mp?.attributes ?? {}) as Record<string, unknown>
          const mpRel = (mp?.relationships ?? {}) as Record<string, unknown>
          const mpRelDex = ((mpRel.dex as Record<string, unknown>)?.data) as Record<string, unknown> | undefined
          const mpRelDexes = ((mpRel.dexes as Record<string, unknown>)?.data) as Array<Record<string, unknown>> | undefined
          const gtTokenAttr = gtTokenInfo?.data?.attributes ?? null
          return {
            resolverInput: originalInput,
            resolverType: resolvedInput?.type ?? 'none',
            resolverCandidatesCount: resolvedInput ? 1 : 0,
            resolverSelectedAddress: resolvedInput?.resolvedAddress ?? null,
            resolverReason: resolvedInput ? (resolvedInput.type === 'alias' ? 'canonical_alias' : 'direct_address') : 'not_resolved',
            // A) Token identity
            inputContract: contract,
            normalizedContract: String(contract).toLowerCase(),
            chain,
            tokenName: resolvedName,
            tokenSymbol: resolvedSymbol,
            tokenDecimals: resolvedDecimals,
            // B) Price diagnostics
            rawPriceUsd: priceUsd,
            priceIsScientificRisk: priceUsd != null && priceUsd < 0.000001,
            priceSourceField: priceUsd === pickNum(mpAttr.base_token_price_usd) ? 'pool.attributes.base_token_price_usd'
              : priceUsd === pickNum(gtTokenAttr?.price_usd) ? 'gtToken.attributes.price_usd'
              : priceUsd === pickNum(gtTokenAttr?.price) ? 'gtToken.attributes.price'
              : 'unknown',
            rawPoolBaseTokenPriceUsd: mpAttr.base_token_price_usd ?? null,
            rawGtTokenPriceUsd: gtTokenAttr?.price_usd ?? null,
            // C) Market cap diagnostics
            rawMarketCapUsd: marketCapFromGt,
            rawEstimatedMarketCap: estimatedMarketCap,
            rawFdvUsd: fdv,
            circulatingSupply,
            marketCapStatus: marketCapFromGt != null ? 'verified' : 'partial',
            marketCapReason: marketCapFromGt != null
              ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'Verified live market data' : 'Verified live pool market data')
              : 'Circulating supply not verified by live market data',
            marketCapFinalSource: marketCapFromGt != null
              ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'token_endpoint' : 'selected_pool')
              : 'none',
            estimatedMarketCapDebugOnly: estimatedMarketCap,
            gtTokenMarketCapUsd: gtTokenAttr?.market_cap_usd ?? null,
            selectedPoolMarketCapUsd: selectedPoolMarketCapUsd,
            gtTokenFdvUsd: gtTokenAttr?.fdv_usd ?? null,
            // D) Pool diagnostics
            totalPoolsReturned: matchingPools.length,
            selectedPoolIndex: 0,
            selectedPoolId: mp?.id ?? null,
            selectedPoolAddress: extractGeckoTerminalPoolAddress(mp as Record<string, unknown> | null),
            selectedPoolName: mpAttr.name ?? null,
            selectedPoolLiquidityUsd: mpAttr.reserve_in_usd ?? null,
            selectedPoolVolume24h: (mpAttr.volume_usd as Record<string, unknown> | undefined)?.h24 ?? null,
            selectedPoolCreatedAt: mpAttr.pool_created_at ?? null,
            // E) DEX/protocol diagnostics
            dexNameFinal: primaryDexName,
            dexExtractedRawId: _extractedDexId,
            dexRawCandidates: {
              'pool.dex': (mp as Record<string, unknown>)?.dex ?? null,
              'pool.dex_id': (mp as Record<string, unknown>)?.dex_id ?? null,
              'attributes.dex': mpAttr.dex ?? null,
              'attributes.dex_id': mpAttr.dex_id ?? null,
              'attributes.dexId': (mpAttr as Record<string, unknown>).dexId ?? null,
              'attributes.exchange': mpAttr.exchange ?? null,
              'attributes.protocol': mpAttr.protocol ?? null,
              'attributes.name': mpAttr.name ?? null,
              'attributes.pool_name': mpAttr.pool_name ?? null,
              'relationships.dex.data.id': mpRelDex?.id ?? null,
              'relationships.dex.data.type': mpRelDex?.type ?? null,
              'relationships.dexes.data[0].id': mpRelDexes?.[0]?.id ?? null,
            },
            poolTopLevelKeys: mp ? Object.keys(mp) : [],
            poolAttributeKeys: Object.keys(mpAttr),
            poolRelationshipKeys: Object.keys(mpRel),
            whyDexNotConfirmed: primaryDexName ? null
              : _extractedDexId ? `normalizeDexLabel("${_extractedDexId}") returned null — add to map`
              : 'No dex id found in any checked field',
            // F) First 3 pool summaries
            first3Pools: matchingPools.slice(0, 3).map((p) => {
              const pa = (p?.attributes ?? {}) as Record<string, unknown>
              const pr = (p?.relationships ?? {}) as Record<string, unknown>
              const prd = ((pr.dex as Record<string, unknown>)?.data) as Record<string, unknown> | undefined
              return {
                id: p.id ?? null,
                name: pa.name ?? null,
                liquidityUsd: pa.reserve_in_usd ?? null,
                dex_id_attr: pa.dex_id ?? null,
                dex_rel_id: prd?.id ?? null,
              }
            }),
            // G) UI mapping summary
            uiMapping: {
              priceCard: priceUsd != null ? (priceUsd < 0.000001 ? `SCIENTIFIC RISK: ${priceUsd}` : String(priceUsd)) : 'N/A',
              dexCard: primaryDexName ?? 'DEX not indexed',
              marketCapCard: marketCapFromGt != null ? `$${marketCapFromGt}` : (estimatedMarketCap != null && estimatedMarketCapConfidence !== 'low' ? `~$${estimatedMarketCap}` : 'MC: inferred'),
              fdvCard: fdv != null ? `$${fdv}` : 'FDV: inferred',
            },
            // H) Pool activity diagnostics
            transactionRawShape: mainPoolAttr.transactions ?? null,
            volumeRawShape: mainPoolAttr.volume_usd ?? null,
            volumeSplitCandidateFields: splitCandidates.map((c) => c.key),
            buyVolumeFoundFrom: buyPick.key,
            sellVolumeFoundFrom: sellPick.key,
            volumeTotalFoundFrom: totalPick.key,
            buySellVolumeSplitAvailable,
            buySellVolumeReason,
            chartAttempted,
            chartPointCount: priceChart.points.length,
            chartAttemptedPools,
            chartAttemptedTimeframes,
            chartSelectedPoolForChart,
            chartFallbackUsed,
            chartUsedTokenLevelOhlcv,
            chartTokenLevelAttempted,
            chartTimeframe: priceChart.timeframe,
            chartSelectedPoolId: mp?.id ?? null,
            chartSelectedPoolAddress: extractGeckoTerminalPoolAddress(mp as Record<string, unknown> | null),
            chartFailureReason,
            chartFirstTimestamp: priceChart.points[0]?.timestamp ?? null,
            chartLastTimestamp: priceChart.points[priceChart.points.length - 1]?.timestamp ?? null,
            chartDebug: {
              chain,
              networkId: _chartNetworkId,
              tokenAddress: contract.toLowerCase(),
              selectedPoolId: mp?.id ?? null,
              selectedPoolAddress: extractGeckoTerminalPoolAddress(mp as Record<string, unknown> | null),
              selectedPoolDex: primaryDexName,
              selectedPoolType: lpPoolType,
              tokenPositionForEachPool,
              poolsAttempted: chartAttemptedPools,
              poolOhlcvAttempts,
              tokenOhlcvAttempts,
              tradeReconstructionAttempted: chartTradeReconstructionAttempted,
              tradePoolsAttempted,
              rawTradeCount,
              validTradePriceCount,
              rejectedTradeReasons,
              reconstructedCandleCount: chartReconstructedCandleCount,
              finalChartStatus: chartStatus,
              finalChartSource: chartSource,
              finalChartReason: chartReason,
              timeframesAttempted: chartAttemptedTimeframes,
              poolLevelSuccess: chartSelectedPoolForChart !== null && !chartUsedTokenLevelOhlcv && !chartUsedTradeReconstruction,
              tokenLevelAttempted: chartTokenLevelAttempted,
              tokenLevelSuccess: chartUsedTokenLevelOhlcv,
              tradeReconstructionSuccess: chartUsedTradeReconstruction,
              syntheticCandlesUsed: chartUsedSyntheticCandles,
              syntheticFlatSeries: chartUsedFlatSynthetic,
              totalChartHttpCalls: _totalChartHttpCalls,
              rateLimited: _ohlcvRateLimited,
              rateLimitedAt: _ohlcvRateLimitedAt,
              cacheHit: _chartCacheHit,
              skippedDueToRateLimit: _skippedDueToRateLimit,
            },
            poolActivityExtractionReason: {
              transactions24hSource: _txnsH24Obj != null ? 'transactions.h24 (object)' : _txnsH24Total != null ? 'transactions.h24 (scalar)' : 'not_indexed',
              buys24hFound: buys24h != null,
              sells24hFound: sells24h != null,
              transactions24hResult: transactions24h,
              buyVolumeFound: buyVolume24hUsd != null,
              sellVolumeFound: sellVolume24hUsd != null,
              pairCreatedAtFound: pairCreatedAt != null,
              pairAgeLabelResult: pairAgeLabel,
            },
          }
        })() } : {}),
      },

      // Security simulation — Honeypot.is is the preferred provider.
      // GoPlus is an optional low-confidence fallback only; not a core provider.
      honeypot: hpResult.ok ? {
        isHoneypot:        hpResult.honeypot,
        honeypotStatus:    hpResult.honeypotStatus,
        honeypotReason:    hpResult.honeypotReason,
        buyTax:            hpResult.buyTax,
        sellTax:           hpResult.sellTax,
        transferTax:       hpResult.transferTax,
        simulationSuccess: hpResult.simulationSuccess,
      } : gpHoneypot,
      securityDiagnostics: {
        honeypotProvider: hpResult.ok ? "ok" : hpResult.honeypotProvider,
        honeypotSource:   hpResult.ok ? "risk_layer" : "inferred",
        honeypotChecked:  true,
      },

      // Contract analysis
      analysis: resolvedAnalysis,
      lpControl: { ...lpControl, canonicalStatus: toCanonical(lpControl.status), rawLpState: lpControl.status, rawState: lpControl.status, lpController, lpControllerType, positionProofStatus: concentratedPositionProof?.status ?? null, positionProofReason: concentratedPositionProof?.reason ?? null },
      lpStatus: (lpControl.status === 'error' || lpControl.status === 'insufficient_data') ? 'partial' : lpControl.status,
      lpControlRead: computeLpControlRead(lpControl, String(lpPool?.pairName ?? ""), lpControllerAddress, concentratedPositionProof),
      lpLockStatus,
      lpLockAmount,
      lpUnlockTime,
      lpLockProvider,
      lpController,
      lpControllerType,
      lpEvidenceGaps,
      lpDataMode: lpDataModePublic,
      lpDataModeRaw: lpDataMode,
      lpDataConfidence,
      cortexLpRead,
      lpModelProof,
      lpMigrationProof,
      lpProofApplicability,
      lpProofStatus: lpProofStatusNew,
      lpExitRisk,
      lpExitRiskReason,
      liquidityDepthRisk,
      lpEvidenceSummary,
      lpControllerIntel,
      concentratedPositionProof,
      concentratedPositionProofRead,
      lpMovementWatch,
      lpLockBurnIntel,
      lpUnlockTimeline,
      lpHistoryTimeline,
      ...(secondaryLpExposure ? { secondaryLpExposure } : {}),
      lpMeta: {
        v2PoolCandidatesCount: lpDiagnostics.v2PoolCandidatesCount,
        protocolPoolCandidatesCount: lpDiagnostics.protocolPoolCandidatesCount,
        lpProofSkipReason: lpDiagnostics.lpProofSkipReason,
        primaryMarketType: lpDiagnostics.primaryMarketType,
        primaryMarketDex: lpDiagnostics.primaryMarketDex,
        lpVerificationPoolSelected: lpDiagnostics.lpVerificationPoolSelected,
        lpControlState: lpDiagnostics.lpState ?? null,
        selectedPrimaryPoolStrategy: lpDiagnostics.selectedPrimaryPoolStrategy,
        // Base LP-locker registry coverage (problem 5): the registry is intentionally
        // empty for Base until verified locker addresses are confirmed on-chain, so
        // "locked" can never fire for Base V2 pools via holder-balance detection.
        // This is reported explicitly rather than fabricating locker entries.
        lockerRegistryStatus: lpDiagnostics.lockerRegistryEmpty ? 'empty' : 'configured',
        lockerDetectionAvailable: !lpDiagnostics.lockerRegistryEmpty,
        lockProofCoverage: (chain === 'base' && lpDiagnostics.lockerRegistryEmpty) ? 'limited' : 'standard',
        lockerRegistryReason: (chain === 'base' && lpDiagnostics.lockerRegistryEmpty)
          ? 'No verified Base locker registry is configured yet.'
          : null,
        // TEMPORARY DEBUG fields (concentrated-ownership-proof pipeline audit) — remove once
        // the pool-selection root cause investigation is closed out.
        selectedPoolModel: lpPoolType,
        selectedPoolDex: lpDexId ?? lpDexName ?? primaryDexName ?? null,
        concentratedProofEligible: _primaryConcentrated,
        concentratedProofAttempted: concentratedPositionProofAttempted,
        concentratedProofSkipReason: _concentratedProofSkipReason,
      },

      // AI summary from Cortex Engine
      aiSummary,

      // CORTEX Risk Engine v1 — pure derivation, no extra API calls
      riskEngine,
      rugRisk,
      contractFlags: cortexContractFlags,

      // Token info object for frontend panels
      tokenInfo: {
        name: finalResolvedName,
        symbol: finalResolvedSymbol,
        decimals: resolvedDecimals,
      },

      // Indexed project links — sourced from existing metadata only (GT / CoinGecko / GMGN)
      projectSocials,

      sections: {
        market: {
          status: marketStatus,
          reason: marketReason,
          source: 'market_data',
          price: _ep,
          liquidity: _el,
          volume24h: _ev,
          change24h: _dexFb?.priceChange24h ?? pickNum((poolAttr.price_change_percentage as Record<string, unknown> | undefined)?.h24),
          marketCap: marketCapFromGt,
          fdv: _efdv,
          marketCapStatus: marketCapFromGt != null ? 'verified' : (_efdv != null ? 'inferred' : 'partial'),
          mcVsFdvStatus: marketCapFromGt != null ? 'verified' : (fdv != null ? 'fdv_only' : 'partial'),
        },
        security: {
          status: toCanonical(securityStatus),
          rawStatus: securityStatus,
          reason: securityReason,
          simulationReason: hpResult.ok ? null : simulationOpenReason,
          source: hpResult.ok ? "risk_layer" : "inferred",
          honeypot: hpResult.ok ? hpResult.honeypot : null,
          honeypotStatus: hpResult.ok ? hpResult.honeypotStatus : 'unavailable',
          honeypotReason: hpResult.ok ? hpResult.honeypotReason : simulationOpenReason,
          buyTax: hpResult.ok ? hpResult.buyTax : null,
          sellTax: hpResult.ok ? hpResult.sellTax : null,
          simulationSuccess: hpResult.ok ? hpResult.simulationSuccess : null,
        },
        holders: {
          status: holdersStatus,
          rawStatus: holdersRawStatus,
          reason: holdersReason,
          source: "holders_layer",
          holderCount: holderCount ?? null,
          top1, top5, top10, top20,
          whale_pressure: whalePressure,
          holder_risk: holderRisk,
          supply_spread: supplySpread,
          holderDataComplete,
        },
        liquidity: (() => {
          // Fallback inheritance: when GeckoTerminal's pools array is empty but fallback
          // market data already proved liquidity exists (liquidityUsd>0 / a synthesized
          // pool / pair address present), the liquidity section must not collapse to
          // "no pools" — it should report the fallback-sourced pool as a partial read
          // instead of contradicting lpControl/lpControllerIntel elsewhere in the response.
          const _hasFallbackPoolEvidence = matchingPools.length === 0 && Boolean(_fallbackLiquidityDetected || lpPool)
          const _liquiditySectionPoolCount = matchingPools.length > 0 ? matchingPools.length : (_hasFallbackPoolEvidence ? 1 : 0)
          return {
          status: _hasFallbackPoolEvidence ? 'partial' : toCanonical(liquidityStatus),
          rawStatus: _hasFallbackPoolEvidence ? 'partial' : liquidityStatus,
          reason: _hasFallbackPoolEvidence ? 'liquidity_from_fallback_market_read' : liquidityReason,
          source: "lp_layer",
          poolCount: _liquiditySectionPoolCount,
          primaryPair: mainPool?.attributes?.name ?? (_hasFallbackPoolEvidence ? (_primaryPair ?? null) : null),
          liquidityDepth: liquidityUsd,
          pool_age: pairCreatedAt ?? _dexFb?.pairCreatedAt ?? null,
          pool_protocol: primaryDexName ?? normalizeDexLabel(lpDexName ?? lpPool?.dexName ?? null),
          pool_fragmentation: matchingPools.length > 2 ? 'fragmented' : matchingPools.length === 2 ? 'split' : matchingPools.length === 1 ? 'single' : (_liquiditySectionPoolCount === 1 ? 'single_pool' : 'none'),
          lpSafetyAttempted,
          lpSafetyUsable,
          lpOwnershipVerified,
          standardLpProofAttempted,
          standardLpProofStatus,
          concentratedPositionProofAttempted,
          concentratedPositionProofStatus,
          lpLockBurnProofStatus: lpProofStatus,
          // Ownership status split: ERC-20 LP token ownership (lock/burn/holder proof) is a
          // different ownership model from concentrated-position ownership, and conflating
          // them previously made "lpOwnershipStatus: not_applicable" the only ownership signal
          // shown for concentrated pools even when a real position proof (partial/open_check/
          // verified) existed. Both are now exposed; old fields are kept for compatibility.
          erc20LpOwnershipStatus: (lpState === 'protocol' || lpState === 'concentrated_liquidity')
            ? 'not_applicable'
            : (lpOwnershipVerified ? 'verified' : (lpOwnershipHolderEvidenceFound ? 'partial' : 'open_check')),
          erc20LockBurnProofStatus: standardLpProofStatus,
          positionOwnershipStatus: lpState === 'concentrated_liquidity'
            ? (concentratedPositionProof?.ownershipStatus
                ?? (concentratedPositionProofStatus === 'verified' ? 'verified' : concentratedPositionProofStatus === 'partial' ? 'partial' : 'open_check'))
            : null,
          positionProofStatus: lpState === 'concentrated_liquidity' ? (concentratedPositionProof?.status ?? 'open_check') : null,
          positionProofConfidence: lpState === 'concentrated_liquidity' ? (concentratedPositionProof?.confidence ?? null) : null,
          lpOwnershipStatus: lpState === 'concentrated_liquidity'
            ? (concentratedPositionProofStatus === 'verified' ? 'position_verified' : concentratedPositionProofStatus === 'partial' ? 'position_proof_partial' : 'position_open_check')
            : ((lpState === 'protocol') ? 'erc20_not_applicable' : (lpOwnershipVerified ? 'verified' : (lpOwnershipHolderEvidenceFound ? 'partial' : 'open_check'))),
          lpControl: {
            ...lpControl,
            canonicalStatus: toCanonical(lpControl.status),
            rawLpState: lpControl.status,
            rawState: lpControl.status,
            lpController,
            lpControllerType,
            positionProofStatus: concentratedPositionProof?.status ?? null,
            positionProofReason: concentratedPositionProof?.reason ?? null,
          },
          lpControlRead: computeLpControlRead(lpControl, String(lpPool?.pairName ?? ""), lpControllerAddress, concentratedPositionProof),
          lpMeta: {
            v2PoolCandidatesCount: lpDiagnostics.v2PoolCandidatesCount,
            protocolPoolCandidatesCount: lpDiagnostics.protocolPoolCandidatesCount,
            lpProofSkipReason: lpDiagnostics.lpProofSkipReason,
            primaryMarketType: lpDiagnostics.primaryMarketType,
            primaryMarketDex: lpDiagnostics.primaryMarketDex,
            lpVerificationPoolSelected: lpDiagnostics.lpVerificationPoolSelected,
            lpControlState: lpDiagnostics.lpState ?? null,
            selectedPrimaryPoolStrategy: lpDiagnostics.selectedPrimaryPoolStrategy,
          },
          }
        })(),
        ownership: {
          status: ownershipVerified ? 'verified' : (isRenounced ? 'verified' : (ownerAddr ? 'partial' : 'inferred')),
          is_renounced: isRenounced,
          owner_address: ownerAddr,
          admin_address: adminAddr,
          proxy_implementation: proxyImplAddr,
          ownership_verified: ownershipVerified,
        },
        contractChecks: {
          status: contractChecksStatus,
          reason: contractChecksReason,
          source: "risk_layer",
          bytecodeStatus,
          ownerStatus,
          mintStatus,
          proxyStatus,
          transferControlStatus,
          owner: ownerAddr ?? null,
          totalSupply: rpcSupply ?? null,
          decimalsRpc: rpcDecimalsHex ?? null,
          nameFallback: rpcName ?? null,
          symbolFallback: rpcSymbol ?? null,
        },
        contract_flags: {
          status: cortexContractFlags.bytecodeChecked ? 'verified' : (_grCI != null ? 'partial' : 'inferred'),
          mint: cortexContractFlags.mint,
          proxy: cortexContractFlags.proxy,
          pause: cortexContractFlags.pause,
          blacklist: cortexContractFlags.blacklist,
          withdraw: cortexContractFlags.withdraw,
          bytecodeChecked: cortexContractFlags.bytecodeChecked,
          proxySlotChecked: cortexContractFlags.proxySlotChecked,
          pauseCallChecked: cortexContractFlags.pauseCallChecked,
        },
      },
    }
    const cortexScoreResult = calculateCortexScoreV2(responsePayload)
    const cortexLegacyRead = cortexScoreResult.cortexConfidence === 'insufficient'
      ? 'CORTEX needs more evidence across core categories before calculating a score.'
      : `Score calculated from available evidence. Missing checks reduce confidence. Coverage ${cortexScoreResult.scoreCoveragePercent}%.`
    // cortexScore/cortexVerdict/cortexConfidence/scoreCoveragePercent are
    // derived purely from already-public scan evidence (no provider names),
    // and the CORTEX RISK ENGINE UI reads them directly — they must always
    // be present so a token with severe evidence shows a real score/verdict
    // instead of falling back to "Open Check". Only cortexScoreDebug (raw
    // category inputs/statuses) stays debug-only.
    ;(responsePayload as any).cortexScore = cortexScoreResult.cortexScore
    ;(responsePayload as any).cortexVerdict = cortexScoreResult.cortexVerdict
    ;(responsePayload as any).cortexConfidence = cortexScoreResult.cortexConfidence
    ;(responsePayload as any).scoreReasons = cortexScoreResult.scoreReasons
    ;(responsePayload as any).missingScoreInputs = cortexScoreResult.missingScoreInputs
    ;(responsePayload as any).scoreCoveragePercent = cortexScoreResult.scoreCoveragePercent
    ;(responsePayload as any).riskEngine = {
      ...(responsePayload as any).riskEngine,
      cortexRead: cortexLegacyRead,
      cortexScore: cortexScoreResult.cortexScore,
      cortexVerdict: cortexScoreResult.cortexVerdict,
      cortexConfidence: cortexScoreResult.cortexConfidence,
      scoreReasons: cortexScoreResult.scoreReasons,
      missingScoreInputs: cortexScoreResult.missingScoreInputs,
      scoreCoveragePercent: cortexScoreResult.scoreCoveragePercent,
    }
    if (debugMode) {
      ;(responsePayload as any).cortexScoreDebug = cortexScoreResult.cortexScoreDebug
      ;(responsePayload as any).riskEngine = {
        ...(responsePayload as any).riskEngine,
        cortexScoreDebug: cortexScoreResult.cortexScoreDebug,
      }
    }

    const tokenRiskScoreResult = calculateTokenRiskScore({
      marketCapUsd: marketCapFromGt,
      fdvUsd: _efdv,
      displayMarketValue,
      displayMarketValueLabel,
      displayMarketValueConfidence,
      valuationContext: (responsePayload as any).valuationContext,
      liquidityUsd,
      holderDistribution,
      lpControl: {
        status: lpControl.status,
        displayLpModel: lpControl.displayLpModel,
        lockStatus: lpControl.lockStatus,
        burnStatus: lpControl.burnStatus,
        proofStatus: lpControl.proofStatus,
        lpController,
        lpControllerType,
      },
      lpLockStatus,
      lpProofApplicability,
      lpProofStatus: lpProofStatusNew,
      lpModelProof,
      lpMigrationProof,
      contractFlags: {
        mint: cortexContractFlags.mint,
        blacklist: cortexContractFlags.blacklist,
        pause: cortexContractFlags.pause,
      },
      honeypot: hpResult.ok ? {
        buyTax: hpResult.buyTax,
        sellTax: hpResult.sellTax,
        transferTax: hpResult.transferTax,
      } : null,
      deployerProfile: riskEngine.deployerProfile,
      sniperActivity: riskEngine.sniperActivity,
      holderIntelligence: riskEngine.holderIntelligence,
      supplyControl,
    })
    ;(responsePayload as any).riskScore = tokenRiskScoreResult.riskScore
    ;(responsePayload as any).riskLabel = tokenRiskScoreResult.riskLabel
    ;(responsePayload as any).riskBreakdown = tokenRiskScoreResult.riskBreakdown

    if (process.env.NODE_ENV === 'development') {
      const _totalMs = Date.now() - _t0
      console.log('[token-timing] totalMs', _totalMs, 'contract', contract)
      console.log('[alchemy-diag] route=/api/token configured=', alchemyConfigured, 'lpProbeAttempted=', Boolean(lpPoolAddress && (lpPoolType === "unknown" || lpPoolType === "v2")), 'rpcAttempted=', rpcCallsAttempted, 'rpcSucceeded=', rpcCallsSucceeded, 'rpcFailed=', rpcCallsFailed, 'totalMs=', _totalMs)
      ;(responsePayload as any)._timing = { totalMs: _totalMs }
    }
    if (debugMode) {
      const skippedChecks: string[] = []
      if (!alchemyConfigured) skippedChecks.push('rpc_checks_missing_configuration')
      if (holdersStatus !== 'verified') skippedChecks.push('holder_verification_incomplete')
      if (lpControl.status === 'insufficient_data' || lpControl.status === 'error' || lpControl.status === 'partial' || lpControl.status === 'no_pool') skippedChecks.push('lp_proof_incomplete')
      if (!hpResult.ok) skippedChecks.push('trading_simulation_incomplete')
      const chainReasons = [
        holdersReason ? `holders:${holdersReason}` : null,
        lpControl.reason ? `lp:${lpControl.reason}` : null,
        securityReason ? `security:${securityReason}` : null,
      ].filter(Boolean) as string[]
      ;(responsePayload as any)._debug = {
        routeName: '/api/token',
        cacheHit: false,
        resolverStatus: resolvedInput?.type ?? 'address',
        resolverDiagnostics: {
          original: originalInput,
          type: resolvedInput?.type ?? 'address',
          resolvedAddress: contract,
          symbol: resolvedInput?.symbol ?? null,
          confidence: resolvedInput?.confidence ?? 'high',
        },
        normalizedPools: normalizedPools.map(p => ({
          address: p.address,
          pairName: p.pairName,
          liquidityUsd: p.liquidityUsd,
          dexId: p.dexId,
          poolType: p.poolType,
          hasLpToken: p.hasLpToken,
          isValidAddress: p.isValidAddress,
        })),
        goldrushUsage: {
          endpointName: `token_holders_v2`,
          feature: 'token-scanner',
          trigger: 'scan_button',
          attempted: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
          cacheHit: false,
          deduped: false,
          statusCode: holdersRaw?.__statusCode ?? null,
          durationMs: null,
          failureStage: holdersRaw?.__status === 'error' ? (holdersRaw?.__reason ?? 'unknown') : null,
          reason: holderDistributionStatus.reason ?? holderDistributionStatus.status ?? null,
        },
        alchemyConfigured,
        alchemyCallsAttempted: rpcCallsAttempted,
        alchemyCallsSucceeded: rpcCallsSucceeded,
        alchemyCallsFailed: rpcCallsFailed,
        rpcMethodsUsed: rpcCallsAttempted > 0 ? ['eth_call'] : [],
        skippedReason: rpcCallsAttempted > 0 ? null : (alchemyConfigured ? 'no_rpc_path_needed' : 'alchemy_not_configured'),
        rpc: {
          chain,
          rpcConfigured: Boolean(rpcHealth.providerUrl),
          rpcAttempted: rpcCallsAttempted > 0 || isFullScanChain,
          rpcSkippedReason: isFullScanChain ? (alchemyConfigured ? null : (rpcHealth.reason ?? 'rpc_health_failed')) : 'chain_not_supported',
          providerUrl: rpcHealth.providerUrl,
          healthOk: rpcHealth.ok,
        },
        fallbackUsed: rpcCallsSucceeded < rpcCallsAttempted,
        requestDurationMs: Date.now() - _t0,
        checks: rpcCheckDiagnostics,
        transferResolverDebug: {
          sourceTrail: transferResolverResult.sourceTrail,
          sourcesAttempted: transferResolverResult.sourceTrail.filter((entry) => entry.endsWith(':attempted')).map((entry) => entry.replace(':attempted', '')),
          sourcesSucceeded: transferResolverResult.sourceTrail.filter((entry) => entry.endsWith(':succeeded')).map((entry) => entry.replace(':succeeded', '')),
          transferCount: transferResolverResult.transfers.length,
          insufficientEvidence: transferResolverResult.insufficientEvidence,
          reason: transferResolverResult.reason ?? null,
        },
        holderResolverDebug: {
          sourceTrail: holderResolverResult.sourceTrail,
          sourcesAttempted: holderResolverResult.sourceTrail.filter((entry) => entry.endsWith(':attempted')).map((entry) => entry.replace(':attempted', '')),
          sourcesSucceeded: holderResolverResult.sourceTrail.filter((entry) => entry.endsWith(':succeeded')).map((entry) => entry.replace(':succeeded', '')),
          holderCount: holderResolverResult.holders.length,
          holdersWithPercent: holderResolverResult.holders.filter((holder) => holder.pctOfSupply != null).length,
          insufficientEvidence: holderResolverResult.insufficientEvidence,
          reason: holderResolverResult.reason ?? null,
        },
        holderSanityDebug,
        devIntelDiagnostics: {
          originDiscovery: ethOriginDiscovery?.diag ?? null,
          linkedWallets: ethLinkedWalletResult?.diag ?? null,
          linkedWalletsStatus: ethLinkedWalletResult?.status ?? (chain === 'eth' && !deployerAddress ? 'skipped' : null),
          deployerStatus: devDeployerStatus,
          methodUsed: devMethodUsed,
          originReason: devOriginReason,
          supplyControlReason: devClusterSupplyReason,
          // Dev Control canonical deployer tracing
          devControlDeployerAddress: deployerAddress,
          devControlDeployerSource: devMethodUsed,
          devIntelDeployerAddress: deployerAddress,
          clusterMapDeployerNodePresent: clusterMap.nodes.some((n) => n.type === 'deployer'),
          supplyControlActorChecked: Boolean(deployerAddress || linkedWallets.length > 0),
          holderRowsCount: holderRows.length,
          holderRowsWithPercent: holderRows.filter((h) => typeof h.percent === 'number' && Number.isFinite(h.percent)).length,
          holderRowsUsable: holderRowsConfirmed,
          deployerMatchedHolder: creatorHolderPercent != null,
          linkedWalletsChecked: linkedWallets.length,
          devClusterSupplyPercent,
          lineageHasDeployer: clusterMap.summary.deployerAddress !== null,
        },
        dexFallbackTest: forceDexFallback ? {
          forced: true,
          primaryMarketAvailable: _primaryHasMarket,
          fallbackAttempted: _fallbackNeeded,
          fallbackUsable: _dexFb != null,
          fallbackPairAddress: _dexFb?.pairAddress ?? null,
          fallbackDexId: _dexFb?.dexId ?? null,
          effectivePriceUsd: _ep,
          effectiveLiquidityUsd: _el,
          effectiveVolume24h: _ev,
          effectiveFdv: _efdv,
          marketDataSource,
          marketConfidence,
          marketStatus,
        } : null,
        holderDiagnostics: {
          attempted: holdersRaw?.__status !== 'not_configured',
          chainUsed: holdersRaw?.__chainUsed ?? (chain === 'eth' ? 'eth-mainnet' : chain === 'base' ? 'base-mainnet' : chain),
          endpointTemplate: holdersRaw?.__endpointPath ?? undefined,
          hasApiKey: holdersRaw?.__hasApiKey ?? Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
          statusCode: holdersRaw?.__statusCode ?? undefined,
          fetchFailed: holdersRaw?.__status === 'error',
          failureStage: holderDistributionStatus.status === 'ok' ? undefined : (holderDistributionStatus.reason ?? holdersRaw?.__status ?? 'unknown'),
          rawItemCount: holderItems.length,
          rawTopLevelKeys: holdersRaw ? Object.keys(holdersRaw) : undefined,
          normalizedCount: normalizedTop.length,
          firstItemKeys: holderItems[0] ? Object.keys(holderItems[0]) : undefined,
          reason: holderDistributionStatus.reason,
          percentSource,
          holderDataSource: _holderSource,
          moralisFallbackUsed: _holderSource === 'moralis',
          moralisHolderCount: _moralisHolderItems.length,
          totalSupplyAvailable: Boolean(rpcSupply && rpcSupply !== '0x' && rpcSupply !== '0x0'),
          providerTotalSupplyAvailable: _holderProviderSupply != null,
          derivationSupplySource: _derivationSupplySource,
          decimalsAvailable: resolvedDecimals != null,
          derivationAttempted: holderDerivationAttempted,
          derivationSucceeded: holderDerivationSucceeded,
          derivationFailureReason: holderDerivationFailureReason,
        },
        chartDebug: {
          poolOhlcvAttempts,
          tokenOhlcvAttempts,
          dexScreenerChartAttempted,
          dexScreenerChartSuccess,
          rawTradeCount,
          validTradePriceCount,
          reconstructedCandleCount: chartReconstructedCandleCount,
          finalChartStatus: chartStatus,
          finalChartSource: chartSource,
          finalChartReason: chartReason,
          frontendExpectedRender: (chartStatus === 'ok' && priceChart.points.length >= 2)
            ? 'candles' as const
            : (marketTrendSnapshot.status === 'ok' ? 'market_trend' as const : 'snapshot' as const),
          syntheticCandlesUsed: chartUsedSyntheticCandles,
          totalChartHttpCalls: _totalChartHttpCalls,
          rateLimited: _ohlcvRateLimited,
          rateLimitedAt: _ohlcvRateLimitedAt,
          cacheHit: _chartCacheHit,
          skippedDueToRateLimit: _skippedDueToRateLimit,
        },
        lpDiagnostics: {
          chain: lpDiagnostics.chain,
          poolDetected: lpDiagnostics.poolDetected,
          // LP model decision — how the backend classified the LP type and proof path
          lpModelDecision: {
            primaryMarketDex: lpControl.primaryPoolDex ?? lpDiagnostics.primaryMarketDex,
            primaryMarketType: lpControl.primaryPoolType ?? lpDiagnostics.primaryMarketType,
            verificationPoolDex: lpControl.verificationPoolDex ?? lpDiagnostics.lpVerificationDex,
            verificationPoolType: lpControl.verificationPoolType ?? lpDiagnostics.lpVerificationType,
            lpToken: lpDiagnostics.lpTokenAddress,
            poolAddressPresent: lpDiagnostics.poolDetected,
            displayLpModel: lpControl.displayLpModel ?? null,
            lockBurnApplicable: lpControl.lockBurnApplicable ?? null,
            lockBurnReason: lpControl.lockBurnReason ?? null,
            proofStatus: lpControl.proofStatus ?? null,
            lockStatus: lpControl.lockStatus ?? null,
            burnStatus: lpControl.burnStatus ?? null,
            reason: lpControl.reason,
          },
          // Primary market pool (display/Liquidity UI)
          primaryMarketSelected: lpDiagnostics.primaryMarketSelected,
          primaryMarketPoolAddress: lpDiagnostics.primaryMarketPoolAddress,
          primaryMarketPoolId: lpDiagnostics.primaryMarketPoolId,
          primaryMarketPoolAddressType: lpDiagnostics.primaryMarketPoolAddressType,
          primaryMarketDex: lpDiagnostics.primaryMarketDex,
          primaryMarketType: lpDiagnostics.primaryMarketType,
          primaryMarketLiquidityUsd: lpDiagnostics.primaryMarketLiquidityUsd,
          // LP verification pool (V2 burn/lock proof)
          lpVerificationPoolSelected: lpDiagnostics.lpVerificationPoolSelected,
          lpVerificationPoolAddress: lpDiagnostics.lpVerificationPoolAddress,
          lpVerificationDex: lpDiagnostics.lpVerificationDex,
          lpVerificationType: lpDiagnostics.lpVerificationType,
          lpVerificationLiquidityUsd: lpDiagnostics.lpVerificationLiquidityUsd,
          v2PoolCandidatesCount: lpDiagnostics.v2PoolCandidatesCount,
          protocolPoolCandidatesCount: lpDiagnostics.protocolPoolCandidatesCount,
          // Legacy fields (kept for compatibility)
          primaryPoolSelected: lpDiagnostics.primaryPoolSelected,
          poolSource: lpDiagnostics.poolSource,
          poolCount: lpDiagnostics.poolCount,
          observedPoolPresent,
          observedPoolCount,
          poolCountStatus,
          selectedPoolAddress: lpDiagnostics.selectedPoolAddress,
          selectedPoolDex: lpDiagnostics.selectedPoolDex,
          selectedPoolType: lpDiagnostics.selectedPoolType,
          selectedPoolLiquidityUsd: lpDiagnostics.selectedPoolLiquidityUsd,
          lpToken: lpDiagnostics.lpTokenAddress,
          lpProofAttempted: lpDiagnostics.lpProofAttempted,
          holderProofAttempted: lpDiagnostics.holderProofAttempted,
          holderRawItemCount: lpDiagnostics.holderRawItemCount,
          lockerRegistryChain: lpDiagnostics.lockerRegistryChain,
          lockerAddressesCheckedCount: lpDiagnostics.lockerAddressesCheckedCount,
          lockerRegistryEmpty: lpDiagnostics.lockerRegistryEmpty,
          rpcConfigured: lpDiagnostics.rpcConfigured,
          rpcSkippedReason: lpDiagnostics.rpcSkippedReason,
          selectedPrimaryPoolStrategy: lpDiagnostics.selectedPrimaryPoolStrategy,
          // Debug-only raw GeckoTerminal pool ordering (problem 6) — never exposed publicly.
          gtRawFirstPool: gtAllPools[0] ?? null,
          rpcAttempted: lpDiagnostics.rpcAttempted,
          totalSupplyChecked: lpDiagnostics.totalSupplyChecked,
          burnAddressesChecked: lpDiagnostics.burnAddressesChecked,
          lockerAddressesChecked: lpDiagnostics.lockerAddressesChecked,
          ownerTeamBalanceChecked: lpDiagnostics.ownerTeamBalanceChecked,
          burnPercent: lpDiagnostics.burnPercent,
          lockedPercent: lpDiagnostics.lockedPercent,
          teamPercent: lpDiagnostics.teamPercent,
          proofStatus: lpDiagnostics.lpState,
          lpProofSkipReason: lpDiagnostics.lpProofSkipReason,
          failureReason: lpDiagnostics.failureReason,
          dexscreenerPoolSynthesized: lpDiagnostics.dexscreenerPoolSynthesized,
          lpSafetyAttempted,
          lpSafetyUsable,
          lpOwnershipVerified,
          standardLpProofAttempted,
          standardLpProofStatus,
          concentratedPositionProofAttempted,
          concentratedPositionProofStatus,
          reason: lpDiagnostics.reason,
          _full: lpDiagnostics,
        },
        // Debug-only step-by-step trace of LP-holder controller resolution (see
        // _lpResolutionDebug capture inside the V2/Aerodrome LP-holder branch above) — lets
        // ?debug=true scans distinguish: deployment/cache staleness vs. the LP holder fetch
        // not running vs. unrecognized raw holder fields vs. totalSupply derivation failing
        // vs. the burn/locker-only fallback overwriting a real dominant-holder result.
        lpResolution: {
          deployment: {
            deployedCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? null,
            vercelEnv: process.env.VERCEL_ENV ?? null,
            nodeEnv: process.env.NODE_ENV ?? null,
            debugEnabled: true,
          },
          cache: {
            tokenCacheHit: false,
            tokenCacheKey: `${chain}:${contract}`,
            lpCacheHit: false,
            lpCacheKey: null,
            cachedLpControlUsed: false,
            cacheAgeMs: null,
          },
          selectedPool: {
            selectedPoolAddress: lpPoolAddress ?? null,
            selectedPoolPair: _primaryPair ?? null,
            selectedPoolDex: primaryDexName ?? normalizeDexLabel(lpPool?.dexId ?? lpPool?.dexName ?? null) ?? null,
            selectedPoolModel: lpModelProof.model,
            verificationPoolAddress: lpVerifyPoolAddress ?? null,
            verificationPoolDex: lpVerifyPool?.dexId ?? lpVerifyPool?.dexName ?? null,
            verificationPoolType: lpVerifyPoolPresent ? lpVerifyPoolType : null,
            selectedPrimaryPoolStrategy: lpDiagnostics.selectedPrimaryPoolStrategy,
            // Cross-pair LP-verification-pool fix debug fields (see _samePairAsPrimary /
            // secondaryPoolCandidates above): proves the primary lpControl is verified
            // against the canonical primary pool, not a different-pair secondary pool.
            primaryMarketPoolAddress: lpPoolAddress ?? null,
            primaryMarketPair: _primaryPair ?? null,
            lpVerificationPoolAddress: lpVerifyPoolAddress ?? null,
            lpVerificationPair: lpVerifyPool
              ? (lpVerifyPool.pairName ?? `${lpVerifyPool.baseTokenSymbol ?? "?"}/${lpVerifyPool.quoteTokenSymbol ?? "?"}`)
              : null,
            lpVerificationIsPrimaryPool: Boolean(lpVerifyPool && lpPool && lpVerifyPool === lpPool),
            secondaryPoolProofsCount: secondaryPoolCandidates.length,
            secondaryPoolPromotedToPrimary,
          },
          holderFetch: _lpResolutionDebug,
          finalReconciliation: {
            finalLpControlStatus: lpControl.status,
            finalLpController: lpController,
            finalLpControllerType: lpControllerType,
            finalLpControllerIntelStatus: lpControllerIntel.status,
            finalControllerSharePercent: lpControllerIntel.controllerSharePercent ?? null,
            finalLiquiditySafetyReasons: tokenRiskScoreResult.riskBreakdown.liquiditySafety.reasons,
          },
        },
        contractFlagDiagnostics: {
          bytecodeChecked: cortexContractFlags.bytecodeChecked,
          proxySlotChecked: cortexContractFlags.proxySlotChecked,
          pauseCallChecked: cortexContractFlags.pauseCallChecked,
          goldrushContractIntelAttempted: goldrushEnabled,
          goldrushContractIntelUsable: _grCIUsable,
          goldrushContractIntelRaw: _grCI?.raw ?? null,
          abiSignatureScanUsed: _hasBytecode,
          rawSelectors: {
            mintSel: _cortexMintSel,
            proxySel: _cortexProxySel,
            pauseSel: _cortexPauseSel,
            withdrawSel: _cortexWithdrawSel,
            blacklistStr: _cortexBlacklistStr,
          },
          proxySlotRaw: _proxySlotHex ?? null,
          pausedCallRaw: _pausedCallHex ?? null,
          isVerifiedProxy: _isVerifiedProxy,
          pauseFunctionExists: _pauseFunctionExists,
          flags: {
            mint: cortexContractFlags.mint,
            proxy: cortexContractFlags.proxy,
            pause: cortexContractFlags.pause,
            blacklist: cortexContractFlags.blacklist,
            withdraw: cortexContractFlags.withdraw,
          },
        },
        chainDiagnostics: {
          requestedChain: rawChain,
          resolvedChain: chain,
          isFullScanChain,
          supportedFullScanChains: SUPPORTED_FULL_SCAN_CHAINS,
          goldrushEnabled,
          moralisEnabled,
          alchemyEnabled: alchemyConfigured,
          marketNetwork: chain,
          holderChainUsed: holdersRaw?.__chainUsed ?? (chain === 'eth' ? 'eth-mainnet' : 'base-mainnet'),
          rpcChainUsed: chain,
          lpChainUsed: chain,
          contractFlagChainUsed: chain,
          securityChainUsed: chain,
          chainParity: {
            market_layer: (marketCapFromGt != null || fdv != null || liquidityUsd != null) ? 'populated' : 'empty',
            holders_layer: holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial' ? 'populated' : 'empty',
            lp_layer: lpDiagnostics.poolDetected ? 'populated' : 'empty',
            contract_flags: cortexContractFlags.bytecodeChecked ? 'populated' : 'empty',
            risk_engine: anyProviderData ? 'populated' : 'empty',
          },
          skippedChecks,
          reasons: chainReasons,
        },
        providerFlow: {
          requestedChain: rawChain,
          deepScan: true,
          coingeckoAttempted: true,
          dexScreenerAttempted: true,
          moralisAttempted: true,
          goldrushAttempted: true,
          alchemyAttempted: true,
          coingeckoUsable: Boolean(coingeckoRaw),
          dexScreenerUsable: Boolean(gtData || _dexFb),
          moralisUsable: Boolean((moralisHoldersRaw && moralisHoldersRaw.__status !== 'error') || (moralisTransfersRaw && moralisTransfersRaw.__status !== 'error')),
          goldrushUsable: Boolean(goldrush || holdersRaw),
          alchemyUsable: alchemyConfigured && rpcCallsSucceeded > 0,
          cacheHits: 0,
          dedupedCalls: 0,
          providerCallCounts: { coingecko: 1, dexScreener: 1, moralis: 2, goldrush: 2, alchemy: rpcCallsAttempted },
          // Layer-level breakdown
          marketFlow: {
            geckoterminalAttempted: true,
            geckoterminalUsable: Boolean(gtData?.data),
            dexscreenerAttempted: true,
            dexscreenerUsable: Boolean(_dexFb),
            coingeckoAttempted: true,
            coingeckoUsable: Boolean(coingeckoRaw),
            effectiveSource: marketDataSource,
          },
          holderFlow: {
            goldrushAttempted: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY),
            goldrushUsable: holderDistributionStatus.status === 'ok' || holderDistributionStatus.status === 'partial',
            goldrushStatus: holdersRaw?.__status ?? 'unknown',
            moralisAttempted: Boolean(process.env.MORALIS_API_KEY),
            moralisUsable: Boolean(moralisHoldersRaw && moralisHoldersRaw.__status !== 'error' && moralisHoldersRaw.__status !== 'not_configured'),
            holderDataComplete,
            holderCount: holderCount ?? null,
            top10Pct: top10 ?? null,
            supplySpread,
            holderRisk,
            whalePressure,
          },
          lpFlow: {
            poolDetected: lpDiagnostics.poolDetected,
            poolSource: lpDiagnostics.poolSource,
            poolCount: lpDiagnostics.poolCount,
          observedPoolPresent,
          observedPoolCount,
          poolCountStatus,
            goldrushLpAttempted: lpSafetyAttempted,
            goldrushLpUsable: lpSafetyUsable,
            rpcLpAttempted: lpDiagnostics.rpcAttempted,
            lpSafetyAttempted,
            lpSafetyUsable,
            lpOwnershipVerified,
            standardLpProofAttempted,
            standardLpProofStatus,
            concentratedPositionProofAttempted,
            concentratedPositionProofStatus,
            proofStatus: lpDiagnostics.lpState,
          },
          contractFlow: {
            goldrushContractIntelAttempted: goldrushEnabled,
            goldrushContractIntelUsable: _grCIUsable,
            abiSignatureScanUsed: _hasBytecode,
            rpcProbesUsed: cortexContractFlags.proxySlotChecked || cortexContractFlags.pauseCallChecked,
            bytecodeAvailable: _hasBytecode,
            honeypotAttempted: true,
            honeypotUsable: hpResult.ok,
            mintDetected: cortexContractFlags.mint.status === 'verified' || cortexContractFlags.mint.status === 'possible',
            blacklistDetected: cortexContractFlags.blacklist.status === 'verified',
            pauseDetected: cortexContractFlags.pause.status === 'verified',
            proxyDetected: cortexContractFlags.proxy.status === 'verified' || cortexContractFlags.proxy.status === 'possible',
            withdrawDetected: cortexContractFlags.withdraw.status === 'verified',
          },
          ownershipFlow: {
            rpcAttempted: alchemyConfigured,
            ownerFound: Boolean(ownerAddr),
            ownerSource: _ownerFromTransfer ? 'moralis_transfer_fallback' : (ownerAddr ? 'rpc_selector' : 'none'),
            adminFound: Boolean(adminAddr),
            proxyImplFound: Boolean(proxyImplAddr),
            is_renounced: isRenounced,
            ownership_verified: ownershipVerified,
            owner_address: ownerAddr,
            admin_address: adminAddr,
          },
          projectSocialsDebug: {
            status: projectSocials.status,
            sourceTrail: projectSocials.sourceTrail,
            foundTwitter: projectSocials.twitter != null,
            foundTelegram: projectSocials.telegram != null,
            foundWebsite: projectSocials.website != null,
            foundKeys: _psFoundKeys,
            rejectedLinks: _psRejectedCount,
            reason: projectSocials.reason ?? null,
            // GeckoTerminal raw presence
            gtTokenPresent: Boolean(gtToken),
            gtTokenHasWebsites: Array.isArray(gtToken?.websites),
            gtTokenHasTelegramHandle: Boolean(gtToken?.telegram_handle),
            gtTokenHasTwitterHandle: Boolean(gtToken?.twitter_handle),
            // CoinGecko / GMGN
            coingeckoUsable: Boolean(coingeckoRaw),
            gmgnUsable: Boolean(gmgnItem),
            // DexScreener raw presence
            dexObjectPresent: Boolean(_dexFb),
            dexInfoPresent: Boolean(_dexFb?.info),
            dexInfoKeys: _dexFb?.info != null ? Object.keys(_dexFb.info) : [],
            dexWebsitesRaw: _dexFb?.info?.websites ?? [],
            dexSocialsRaw: _dexFb?.info?.socials ?? [],
            dexWebsitesCount: _dexFb?.info?.websites?.length ?? 0,
            dexSocialsCount: _dexFb?.info?.socials?.length ?? 0,
          },
          riskFlow: {
            rugRiskScore: riskEngine.rugRiskScore,
            rugRiskLabel: riskEngine.rugRiskLabel,
            confidence: riskEngine.confidence,
            majorMissingCount,
            sufficientCoreData,
            verifiedSignalCount: riskEngine.verifiedSignals.length,
            riskDriverCount: riskEngine.riskDrivers.length,
            openCheckCount: riskEngine.openChecks.length,
          },
        },
      }
    } else {
      delete (responsePayload as any)._diagnostics
    }
    if (debugMode === true || process.env.NODE_ENV !== 'production') {
      ;(responsePayload as any)._tokenRouteDebug = {
        routeReached: true,
        chain,
        address: contract,
        stagesCompleted: [_scanStage],
        totalMs: Date.now() - _t0,
      }
      // Hard proof receipt (Clark Pack 1 audit, Task 2): coarse per-stage status,
      // read-only from values the pipeline already computed above — no scoring/
      // provider/risk logic is touched here.
      ;(responsePayload as any).tokenRouteDebug = {
        routeReached: true,
        method: 'POST',
        contract,
        chain,
        authPassed: true,
        cookieForwarded: Boolean(req.headers.get('cookie')),
        authorizationForwarded: Boolean(req.headers.get('authorization')),
        stagesStarted: ['market', 'security', 'holders', 'lp'],
        stagesCompleted: [
          marketStatus ? 'market' : null,
          securityStatus ? 'security' : null,
          holdersStatus ? 'holders' : null,
          liquidityStatus ? 'lp' : null,
        ].filter(Boolean),
        marketDataAttempted: _diagMarketAttempted || _diagPoolAttempted,
        marketDataStatus: marketStatus,
        poolDataFound: _diagPoolCount > 0,
        securityAttempted: true,
        securityStatus,
        holdersAttempted: true,
        holdersStatus,
        lpAttempted: true,
        lpStatus: liquidityStatus,
        publicResponseKeys: Object.keys(responsePayload as Record<string, unknown>),
        totalMs: Date.now() - _t0,
      }
    }
    return NextResponse.json(sanitizePublicTokenResponse(responsePayload as Record<string, any>, debugMode === true))
  } catch (err) {
    console.error("Fatal backend error:", err);
    const _failureReason = err instanceof Error ? err.message : 'unknown_error'
    if (_diagIsAddressInput) {
      // The input was a valid contract address — accept it rather than telling
      // the user the address itself couldn't be resolved. The scan pipeline
      // failed partway through; surface an open-check / no-data state instead.
      return NextResponse.json({
        status: 'address_scan_failed',
        marketStatus: 'no_data',
        contract: _diagOriginalInput,
        chain: _diagSelectedChain,
        resolvedInput: {
          original: _diagOriginalInput,
          type: 'address',
          resolvedAddress: _diagOriginalInput,
          requestedChain: _diagSelectedChain,
          confidence: 'high',
        },
        error: "Token address accepted, but CORTEX could not find enough live data yet.",
        ..._diagDebugMode ? {
          _diagnostics: {
            input: _diagOriginalInput,
            originalInput: _diagOriginalInput,
            chain: _diagSelectedChain,
            selectedChain: _diagSelectedChain,
            resolvedAddress: _diagResolvedAddress,
            detectedInputType: 'address',
            addressValid: true,
            scanStageFailed: _scanStage,
            resolverStageFailed: 'scan_pipeline',
            resolverFailureReason: _failureReason,
            exactErrorMessage: _failureReason,
            marketAttempted: _diagMarketAttempted,
            poolAttempted: _diagPoolAttempted,
            poolCount: _diagPoolCount,
            metadataResolved: _diagMetadataResolved,
            fallbackAttempted: _diagFallbackAttempted,
          },
        } : {},
      }, { status: 200 });
    }
    return NextResponse.json(
      {
        error: "Internal server error",
        ..._diagDebugMode ? {
          _diagnostics: {
            input: _diagOriginalInput,
            originalInput: _diagOriginalInput,
            chain: _diagSelectedChain,
            selectedChain: _diagSelectedChain,
            resolvedAddress: _diagResolvedAddress,
            detectedInputType: _diagIsAddressInput ? 'address' : 'symbol_or_alias',
            addressValid: _diagIsAddressInput,
            scanStageFailed: _scanStage,
            resolverStageFailed: 'scan_pipeline',
            resolverFailureReason: _failureReason,
            exactErrorMessage: _failureReason,
            marketAttempted: _diagMarketAttempted,
            poolAttempted: _diagPoolAttempted,
            poolCount: _diagPoolCount,
            metadataResolved: _diagMetadataResolved,
            fallbackAttempted: _diagFallbackAttempted,
          },
        } : {},
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const rawInput =
    url.searchParams.get('input') ??
    url.searchParams.get('address') ??
    url.searchParams.get('contract') ??
    url.searchParams.get('token') ??
    url.searchParams.get('q') ??
    url.searchParams.get('symbol') ??
    ''
  const contractInput = rawInput.trim()
  const chain = (url.searchParams.get('chain') ?? '').trim().toLowerCase() || 'base'
  const debugParam = url.searchParams.get('debug')
  const debugMode = debugParam === 'true' || debugParam === '1'

  if (!contractInput) {
    return NextResponse.json({ error: 'Invalid or missing address parameter.' }, { status: 400 })
  }

  const mockReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ contract: contractInput, chain, debug: debugMode }),
  })
  const scanRes = await POST(mockReq)
  const scan = await scanRes.json().catch(() => null) as Record<string, any> | null
  if (!scanRes.ok || scan?.error) {
    return NextResponse.json({
      error: scan?.error ?? 'Token metadata unavailable.',
      ...(debugMode ? {
        _diagnostics: { resolverInput: contractInput, ...(scan?._diagnostics ?? {}) },
        _debug: { resolverDiagnostics: { original: contractInput }, ...(scan?._debug ?? {}) },
      } : {}),
    }, { status: scanRes.ok ? 502 : scanRes.status })
  }
  if (!scan) return NextResponse.json(null)

  const contract = scan.contract ?? contractInput
  const socials = (scan.projectSocials && typeof scan.projectSocials === 'object') ? scan.projectSocials as Record<string, unknown> : {}
  const explorerBase = chain === 'eth' || chain === 'ethereum' ? 'https://etherscan.io' : 'https://basescan.org'
  const gtNetwork = chain === 'eth' || chain === 'ethereum' ? 'eth' : 'base'
  const normalizedChain = chain === 'ethereum' ? 'eth' : chain
  const links = {
    dexscreener: `https://dexscreener.com/${normalizedChain === 'eth' ? 'ethereum' : normalizedChain}/${contract}`,
    geckoterminal: `https://www.geckoterminal.com/${gtNetwork}/tokens/${contract}`,
    explorer: `${explorerBase}/token/${contract}`,
  }

  const metadata = {
    name: scan.name ?? scan.tokenInfo?.name ?? null,
    symbol: scan.symbol ?? scan.tokenInfo?.symbol ?? null,
    decimals: scan.decimals ?? scan.tokenInfo?.decimals ?? null,
    website: socials.website ?? null,
    twitter: socials.twitter ?? null,
    telegram: socials.telegram ?? null,
    links,
    deployer: scan.deployerAddress ?? scan.devIntel?.deployerAddress ?? null,
    deployerAddress: scan.deployerAddress ?? scan.devIntel?.deployerAddress ?? null,
    creationTx: scan.creationTxHash ?? scan.devIntel?.creationTxHash ?? null,
    creationTxHash: scan.creationTxHash ?? scan.devIntel?.creationTxHash ?? null,
    creationTime: scan.poolActivity?.pairCreatedAt ?? null,
    chain: scan.chain ?? normalizedChain,
    projectSocials: {
      ...socials,
      website: socials.website ?? null,
      twitter: socials.twitter ?? null,
      telegram: socials.telegram ?? null,
    },
    holderDistribution: scan.holderDistribution ?? null,
    holderResolver: scan.holderResolver ?? null,
    priceChart: scan.priceChart ?? null,
    sections: scan.sections ?? null,
    ...(debugMode ? {
      _diagnostics: { resolverInput: contractInput, ...(scan._diagnostics ?? {}) },
      _debug: { resolverDiagnostics: { original: contractInput }, ...(scan._debug ?? {}) },
    } : {}),
  }

  if (metadata.name == null && metadata.symbol == null && metadata.decimals == null && metadata.website == null && metadata.twitter == null && metadata.telegram == null) {
    return NextResponse.json(null)
  }

  return NextResponse.json(metadata)
}

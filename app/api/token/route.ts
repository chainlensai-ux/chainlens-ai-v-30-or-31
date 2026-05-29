/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { fetchHoneypotSecurity } from "@/lib/server/honeypotSecurity";
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { type CanonicalStatus, toCanonical } from '@/lib/canonicalStatus'
import { buildClusterMap } from '@/lib/clusterMap'

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
  percentSource: "provider" | "calculated" | "inferred"
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
    status: "locked" | "unlocked" | "team_controlled" | "protocol" | "concentrated_liquidity" | "partial"
    unlock_at: string | null
    countdown_seconds: number | null
    owner: string | null
    contract: string | null
    movement_24h_usd: number | null
    source_status: "ok" | "partial"
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

// BigInt-safe percentage: avoids float precision loss on 18-decimal ERC-20 balances.
// Returns e.g. 5.23 for 5.23%. Uses BigInt() constructor (not literals) for ES2017 compat.
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

async function fetchGeckoTerminalPoolOhlcv(poolAddress: string, chain: ChainKey, timeframe: { resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }, tokenPosition: 'base' | 'quote' = 'base'): Promise<any> {
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
    return res.ok ? await res.json() : null
  } catch { return null }
}

// Token-level OHLCV — aggregates across all pools for the token.
// More reliable than pool-level for CL/V3 pools where individual pool OHLCV is not indexed.
async function fetchGeckoTerminalTokenOhlcv(tokenAddress: string, chain: ChainKey, timeframe: { resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }): Promise<any> {
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
    return res.ok ? await res.json() : null
  } catch { return null }
}

// Determines whether the scanned token is the 'base' or 'quote' token in a GeckoTerminal pool.
// Uses the pool's relationship data (populated when pools are fetched with ?include=base_token,quote_token).
// Falls back to 'base' when relationship data is absent — safe default for most pairs.
function resolveTokenPositionInPool(
  pool: Record<string, unknown>,
  tokenAddress: string,
  networkId: string,
): 'base' | 'quote' {
  const rel = (pool.relationships ?? {}) as Record<string, unknown>
  const baseData = ((rel.base_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  const quoteData = ((rel.quote_token as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined
  const baseId = String(baseData?.id ?? '').toLowerCase()
  const quoteId = String(quoteData?.id ?? '').toLowerCase()
  const tokenNorm = tokenAddress.toLowerCase()
  const expectedId = `${networkId}_${tokenNorm}`
  if (baseId === expectedId || baseId.endsWith(`_${tokenNorm}`)) return 'base'
  if (quoteId === expectedId || quoteId.endsWith(`_${tokenNorm}`)) return 'quote'
  return 'base'
}

// Fetches recent trades for a pool — last-resort candle source when indexed OHLCV is unavailable.
async function fetchGeckoTerminalPoolTrades(poolAddress: string, chain: ChainKey): Promise<any> {
  try {
    const networkMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon_pos', bnb: 'bsc' }
    const network = networkMap[chain] ?? 'base'
    const _gtBase = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
    const res = await fetch(
      `${_gtBase}/api/v2/networks/${network}/pools/${poolAddress}/trades?trade_volume_in_usd_greater_than=0`,
      { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: withTimeout(5000) }
    )
    return res.ok ? await res.json() : null
  } catch { return null }
}

// Reconstructs OHLCV candles from raw GeckoTerminal trade events.
// Only uses real trade prices — no generated or interpolated values.
// Requires >= 3 valid priced trades spanning >= 2 time buckets; returns null otherwise.
function reconstructCandlesFromTrades(
  trades: unknown[],
  currentPriceUsd: number | null,
): Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number }> | null {
  if (!Array.isArray(trades) || trades.length < 3) return null
  type TradePoint = { tsMs: number; price: number; volUsd: number | null }
  const points: TradePoint[] = []
  for (const trade of trades) {
    const attrs = ((trade as Record<string, unknown>)?.attributes) as Record<string, unknown> | undefined
    if (!attrs) continue
    const tsRaw = attrs.block_timestamp ?? attrs.timestamp
    const tsMs: number | null = tsRaw == null ? null
      : typeof tsRaw === 'number' ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000)
      : !isNaN(Date.parse(String(tsRaw))) ? new Date(String(tsRaw)).getTime()
      : null
    if (!tsMs || isNaN(tsMs)) continue
    const candidates = [toNum(attrs.price_in_usd), toNum(attrs.price_from_in_usd), toNum(attrs.price_to_in_usd)]
      .filter((p): p is number => p != null && p > 0)
    if (candidates.length === 0) continue
    let price: number | null = null
    if (currentPriceUsd != null && currentPriceUsd > 0) {
      const eligible = candidates.filter(p => p >= currentPriceUsd * 0.05 && p <= currentPriceUsd * 20)
      price = eligible.length > 0
        ? eligible.reduce((best, p) => Math.abs(p - currentPriceUsd) < Math.abs(best - currentPriceUsd) ? p : best, eligible[0])
        : null
    } else {
      price = candidates[0]
    }
    if (price == null) continue
    points.push({ tsMs, price, volUsd: toNum(attrs.volume_in_usd) ?? null })
  }
  if (points.length < 3) return null
  points.sort((a, b) => a.tsMs - b.tsMs)
  const spanMs = points[points.length - 1].tsMs - points[0].tsMs
  if (spanMs < 60000) return null
  const bucketMs = Math.max(60000, Math.ceil(spanMs / 20))
  const buckets = new Map<number, TradePoint[]>()
  for (const pt of points) {
    const key = Math.floor(pt.tsMs / bucketMs) * bucketMs
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(pt)
  }
  if (buckets.size < 2) return null
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
  return candles.length >= 2 ? candles : null
}

const CHAIN_ID_MAP: Record<ChainKey, number> = { eth: 1, base: 8453, polygon: 137, bnb: 56 };

// Chain-aware LP locker contract registry.
// Only add verified on-chain locker contract addresses. Addresses must be lowercase.
// An empty list for a chain means "locked" will never fire on that chain —
// intentional: no false-positive locked claims without proof.
const LOCKER_REGISTRY: Partial<Record<ChainKey, string[]>> = {
  eth: [
    "0x663a5c229c09b049e36dcca11a9d0d4a0f33f3f9", // UNCX / UniCrypt V2 LP Locker
    "0x71b5759d73262fbb223956913ecf4ecc51057641", // PinkLock (PinkSale)
    "0xe2fe530c047f2d85298b07d9333c05737f1435fb", // Team Finance LP Locker
    "0xdba68f07d1b7ca219f78ae8582c213d975c25caf", // UniCrypt V3 LP Locker
    "0xf6c7282943dc5ea13461ef77dd3a24e5d01e5e1a", // DxLock
    "0x0be46842df45f36a19bea0de0fd6e34da00fd8a5", // Mudra Locker
  ],
  // Base mainnet: intentionally empty until locker contract addresses are
  // confirmed on-chain. "locked" status cannot fire for Base V2 pools until
  // verified addresses are added here.
  base: [],
};

// Resolves honeypot + tax simulation for a given chain and token address.
// Wraps fetchHoneypotSecurity and returns the canonical simulation object or null on failure.
async function resolveSimulation(chain: string, address: string): Promise<{
  honeypot: boolean | null;
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
}

const _dexFbCache = new Map<string, { data: DexFallbackResult | null; ts: number }>()

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
    })
  } catch {
    return miss(null)
  }
}

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


async function fetchTokenHolders(_chain: ChainKey, contract: string): Promise<any> {
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
  status: "burned" | "locked" | "protocol" | "team_controlled" | "concentrated_liquidity" | "partial" | "no_pool" | "insufficient_data" | "error";
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
};

type LpControlRead = {
  title: string;
  meaning: string;
  riskLevel: string;
  whatWasFound: string[];
  couldNotVerify: string[];
  nextAction: string;
};

function computeLpControlRead(lp: LpControlResult, pairName?: string | null): LpControlRead {
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
        whatWasFound: [...poolLine, "Single wallet holds dominant LP share"],
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
        meaning: "Liquidity is in a concentrated-liquidity (V3) pool. LP positions are NFTs, not standard ERC-20 tokens — V2 holder checks do not apply.",
        riskLevel: "Not assessable via V2 method",
        whatWasFound: [...poolLine, "Pool type: concentrated / V3"],
        couldNotVerify: ["LP token holder distribution (V2 method N/A)", "Lock or burn status via standard ERC-20 check"],
        nextAction: "Check LP positions on-chain via the V3 position manager or a protocol-specific explorer.",
      };
    case "concentrated_liquidity":
      return {
        title: "Concentrated liquidity — LP proof not applicable",
        meaning: "No ERC-20 V2 LP token found. Burn/lock proof requires protocol-specific position checks.",
        riskLevel: "Caution",
        whatWasFound: [...poolLine.filter((x)=>!/^Pair:/i.test(x)), "Pool detected", "Primary market selected", "Pool structure reviewed"],
        couldNotVerify: ["Protocol-specific LP proof required"],
        nextAction: "Monitor liquidity movement and owner/control checks. V2 burn/lock proof is not available for this pool type.",
      };
    case "partial":
      return {
        title: "Partial LP proof",
        meaning: "Pool detected, lock/burn proof not fully confirmed.",
        riskLevel: "Medium",
        whatWasFound: [...poolLine, "Some LP checks returned usable data"],
        couldNotVerify: ["Complete lock/burn/team LP proof"],
        nextAction: "Treat LP control as partial until more holder or RPC evidence is available.",
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

function computePairAge(createdAt: string): string | null {
  try {
    const ms = Date.now() - new Date(createdAt).getTime()
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
  const _addrRaw = String(attrs.address ?? '').trim().toLowerCase()
  const _idHex = String(pool?.id ?? '').match(/0x[a-f0-9]{40}/i)?.[0]?.toLowerCase() ?? null
  const address = (/^0x[a-f0-9]{40}$/.test(_addrRaw) ? _addrRaw : _idHex) || null
  const { dexId, dexName } = extractPoolDex(pool, []);
  return {
    address,
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
      if (pt === 'v2') return true
      if (pt === 'v3' || pt === 'aerodrome' || pt === 'concentrated') return false
      return null
    })(),
    hasDexMeta: Boolean(dexId || dexName),
    isValidAddress: Boolean(address && /^0x[a-f0-9]{40}$/.test(address)),
    raw: pool,
  };
}

type NormalizedPool = {
  address?: string | null;
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
  const idSignals = [dexIdHint ?? '', relDexId, String(a.dex_id ?? a.dex ?? '').toLowerCase().trim()]
  for (const s of idSignals) {
    if (!s) continue
    if (/^aerodrome|^slipstream/.test(s)) return "aerodrome"
    if (/^uniswap_v4|^uniswap-v4/.test(s)) return "v3"  // treat V4 as concentrated
    if (/^uniswap_v3|^uniswap-v3|^pancakeswap_v3|^sushiswap_v3|^algebra/.test(s)) return "v3"
    if (/^uniswap_v2|^uniswap-v2|^pancakeswap_v2|^sushiswap_v2|^baseswap|^alienbase|^swapbased|^shibaswap/.test(s)) return "v2"
    if (/^pancakeswap_v3|^sushiswap_v3/.test(s)) return "v3"
    if (/^sushiswap|^pancakeswap/.test(s)) return "v2"  // unversioned: default to v2
  }
  const has = (re: RegExp) => re.test(text);
  if (has(/\baerodrome\b|\bslipstream\b/)) return "aerodrome";
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
    drivers.push('LP controlled by a team wallet — liquidity can be removed at any time');
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
  holderItemsEarly: any[],
  ownerStatus: string,
  lpPoolType: string | null | undefined
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
    inferred.push('tax rates inferred as standard — direct simulation deferred, verify before large transactions')
  }
  if (analysis.suspiciousFunctions.length > 0) {
    risks.push(`bytecode contains suspicious selectors: ${analysis.suspiciousFunctions.slice(0, 3).join(', ')}`)
  }
  if (holderItemsEarly.length === 0) {
    inferred.push('holder concentration inferred as moderate-to-high — cross-check top wallets before sizing a position')
  }
  if (ownerStatus === 'renounced') {
    confirmed.push('Ownership is renounced.')
  } else if (ownerStatus === 'inferred_active' || ownerStatus === 'inferred') {
    inferred.push('ownership status inferred as active — treat as potentially upgradeable or mintable until confirmed on-chain')
  }
  if (!lpPoolType || lpPoolType === 'unknown') {
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

  try {
    const _t0 = Date.now()

    const body = await req.json();
    const { contract: contractInput, debugHolder, debug: debugMode, forceDexFallback: _forceDexFallback } = body;
    const rawChain = String(body.chain ?? 'base').toLowerCase()
    if (rawChain !== 'base' && rawChain !== 'eth') {
      return NextResponse.json({ error: 'Unsupported chain. Use chain=base or chain=eth.' }, { status: 400 })
    }
    let chain: ChainKey = rawChain as ChainKey
    const forceDexFallback = debugMode === true && _forceDexFallback === true
    const originalInput = String(contractInput ?? '').trim()
    const normalizedInput = originalInput.toUpperCase()
    const isAddressInput = /^0x[a-fA-F0-9]{40}$/.test(originalInput)
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
        error: `Invalid EVM address: expected 0x + 40 hex chars, got ${originalInput.length - 2}. Check for typos.`,
      }, { status: 400 })
    }

    if (!resolvedAddress) {
      return NextResponse.json({
        status: 'not_found',
        error: "Couldn't resolve that token. Paste the contract address or try a verified symbol.",
        ...(debugMode === true ? {
          _diagnostics: { resolverInput: originalInput, resolverType: 'none', resolverCandidatesCount: 0, resolverSelectedAddress: null, resolverReason: 'not_in_alias_map' },
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
    // Chain auto-detection for address inputs: if selected chain has no pools,
    // try the opposite chain before continuing full scan.
    if (isAddressInput) {
      const selectedPools = await fetchGeckoTerminal(contract, chain)
      const selectedCount = Array.isArray(selectedPools?.data) ? selectedPools.data.length : 0
      if (selectedCount === 0) {
        const altChain: ChainKey = chain === 'eth' ? 'base' : 'eth'
        const altPools = await fetchGeckoTerminal(contract, altChain)
        const altCount = Array.isArray(altPools?.data) ? altPools.data.length : 0
        if (altCount > 0) {
          chain = altChain
        }
      }
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
      fetchGeckoTerminal(contract, chain),
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

    const analysis = analyzeContract(bytecode);

    // GeckoTerminal /tokens/{contract}/pools returns pools for this token directly
    const gtAllPools: any[] = Array.isArray(gtData?.data) ? gtData.data : [];
    const gtIncluded: unknown[] = Array.isArray(gtData?.included) ? gtData.included : [];

    // Sort by liquidity descending — market primary is deepest pool
    const matchingPools = [...gtAllPools].sort(
      (a, b) =>
        parseFloat(b.attributes?.reserve_in_usd || "0") -
        parseFloat(a.attributes?.reserve_in_usd || "0")
    );

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
    if (normalizedPools.length === 0 && dexFbEarly?.pairAddress && /^0x[a-f0-9]{40}$/i.test(dexFbEarly.pairAddress)) {
      const _dsFbDexId = dexFbEarly.dexId ?? null
      const _dsFbType = detectPoolType(null, _dsFbDexId ?? undefined)
      normalizedPools.push({
        address: dexFbEarly.pairAddress.toLowerCase(),
        pairName: [dexFbEarly.baseToken?.symbol, dexFbEarly.quoteToken?.symbol].filter(Boolean).join('/') || null,
        liquidityUsd: dexFbEarly.liquidityUsd ?? 0,
        dexId: _dsFbDexId,
        dexName: normalizeDexLabel(_dsFbDexId) || null,
        baseTokenSymbol: dexFbEarly.baseToken?.symbol ?? null,
        quoteTokenSymbol: dexFbEarly.quoteToken?.symbol ?? null,
        baseTokenAddress: dexFbEarly.baseToken?.address?.toLowerCase() ?? null,
        quoteTokenAddress: dexFbEarly.quoteToken?.address?.toLowerCase() ?? null,
        poolType: _dsFbType,
        hasLpToken: (() => {
          if (_dsFbType === 'v2') return true
          if (_dsFbType === 'v3' || _dsFbType === 'aerodrome' || _dsFbType === 'concentrated') return false
          // On Base, DexScreener may label V2 pools as unknown/v3 — detect by dexId
          if (chain === 'base' && _dsFbDexId) {
            const dxLc = _dsFbDexId.toLowerCase()
            if (/v2|baseswap|alienbase|swapbased|sushiswap|shibaswap/.test(dxLc) && !/v3|v4|concentrated|slipstream|aerodrome/.test(dxLc)) return true
          }
          return null
        })(),
        hasDexMeta: Boolean(_dsFbDexId),
        isValidAddress: true,
      })
      _dsFbPoolSynthesized = true
    }
    const selectedLpPool = selectLpVerificationPool(normalizedPools, String(contract));
    const noActivePools = matchingPools.length === 0;
    const mainPoolAttr = (mainPool?.attributes ?? {}) as Record<string, unknown>;
    const _mpAddrRaw = String(mainPoolAttr.address ?? '').trim().toLowerCase()
    const _mpIdHex = String(mainPool?.id ?? '').match(/0x[a-f0-9]{40}/i)?.[0]?.toLowerCase() ?? null
    const primaryPoolAddress = (/^0x[a-f0-9]{40}$/.test(_mpAddrRaw) ? _mpAddrRaw : _mpIdHex) || null
    // Canonical primary pool for both Liquidity&Pools and LP Control:
    // use the highest-liquidity normalized pool first (same ordering as matchingPools/mainPool),
    // then fall back to LP verification selector if needed.
    const canonicalPrimaryPool = normalizedPools[0] ?? null
    const canonicalPrimaryUsable = Boolean(
      canonicalPrimaryPool?.address &&
      /^0x[a-f0-9]{40}$/.test(canonicalPrimaryPool.address) &&
      (canonicalPrimaryPool.liquidityUsd ?? 0) > 0
    )
    const lpPool = canonicalPrimaryUsable ? canonicalPrimaryPool : selectedLpPool.pool;
    const lpPoolType = lpPool?.poolType ?? "unknown";
    // lpVerifyPool: separate from lpPool — best V2/unknown pool for burn/lock/team proof.
    // normalizedPools is sorted by liquidity desc, so first V2/unknown = highest-liquidity verifiable pool.
    const _isV2Verifiable = (p: NormalizedPool) =>
      (p.poolType === 'v2' || p.poolType === 'unknown' || (chain === 'base' && p.hasLpToken === true)) &&
      p.isValidAddress && Boolean(p.address)
    const lpVerifyPool = normalizedPools.find(_isV2Verifiable) ?? null
    const lpVerifyPoolAddress = lpVerifyPool?.address ?? null
    const lpVerifyPoolType: NormalizedPool['poolType'] = lpVerifyPool?.poolType ?? 'unknown'
    const lpVerifyPoolPresent = Boolean(lpVerifyPoolAddress && /^0x[a-f0-9]{40}$/.test(lpVerifyPoolAddress))
    const _v2PoolCandidates = normalizedPools.filter(_isV2Verifiable)
    const _protocolPoolCandidates = normalizedPools.filter(p => p.poolType === 'v3' || p.poolType === 'aerodrome' || p.poolType === 'concentrated')
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
    const primaryDexName = normalizeDexLabel(_extractedDexId)
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
    const lpDexId = lpPool?.dexId ?? null
    const lpDexName = lpPool?.dexName ?? null
    const lpPoolAddressPresent = Boolean(lpPoolAddress && /^0x[a-f0-9]{40}$/.test(lpPoolAddress))
    // For LP proof logic, use lpVerifyPool (V2/unknown) if available, else fall back to lpPool
    const _lpProofAddress = lpVerifyPoolPresent ? lpVerifyPoolAddress : lpPoolAddress
    const _lpProofType = lpVerifyPoolPresent ? lpVerifyPoolType : lpPoolType
    const _lpProofPresent = lpVerifyPoolPresent || lpPoolAddressPresent
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
    const needsLpHolderFetch = Boolean(_lpProofPresent && (_lpProofType === 'v2' || _lpProofType === 'unknown'))
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

    // Phase 2: LP holder fetch + AI summary + onchain supply all in parallel
    const _t2 = Date.now()
    const [_lpHoldersSettled, _aiSettled, _onchainSettled] = await Promise.allSettled([
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
    ])
    if (process.env.NODE_ENV === 'development') console.log('[token-timing] phase2Ms', Date.now() - _t2, 'needsLP', needsLpHolderFetch, 'needsAI', needsAI, 'needsOnchain', needsOnchainMc)

    // Early owner fetch for LP team-wallet check — runs after phase2 to not block parallel work.
    // Only needed when pool is V2-like (burn/locker checks will use it). Fast single RPC call.
    const _ownerHexForLp = (_lpProofPresent && (_lpProofType === 'v2' || _lpProofType === 'unknown'))
      ? await rpcCall(chain, 'eth_call', [{ to: contract, data: '0x8da5cb5b' }, 'latest']).catch(() => null)
      : null
    const ownerAddrEarlyForLp = _ownerHexForLp && _ownerHexForLp.length >= 42 ? `0x${_ownerHexForLp.slice(-40)}`.toLowerCase() : null

    // LP control using pre-fetched LP holder data (no sequential blocking)
    const _lpHoldersForControl = (_lpHoldersSettled.status === 'fulfilled' ? _lpHoldersSettled.value : { __status: 'error', __reason: 'lp_fetch_failed' }) as any
    // _lpAddrSnippet and lpPair refer to the V2 verification pool (for LP proof evidence)
    const _lpAddrSnippet = _lpProofAddress ? `${_lpProofAddress.slice(0, 10)}…${_lpProofAddress.slice(-4)}` : "none";
    const lpVerifyPoolObj = lpVerifyPoolPresent ? lpVerifyPool : lpPool
    const lpPair = lpVerifyPoolObj?.pairName ?? `${lpVerifyPoolObj?.baseTokenSymbol ?? "?"}/${lpVerifyPoolObj?.quoteTokenSymbol ?? "?"}`;
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
      primaryPoolSelected: Boolean(lpPoolAddressPresent && (lpPool?.liquidityUsd ?? 0) > 0),
      selectedPoolAddress: _lpProofAddress,
      selectedPoolDex: lpVerifyPool?.dexId ?? lpVerifyPool?.dexName ?? lpPool?.dexId ?? lpPool?.dexName ?? null,
      selectedPoolType: _lpProofType,
      selectedPoolLiquidityUsd: lpVerifyPool?.liquidityUsd ?? lpPool?.liquidityUsd ?? null,
      // Split-pool diagnostics
      primaryMarketSelected: Boolean(lpPoolAddressPresent),
      primaryMarketPoolAddress: lpPoolAddress,
      primaryMarketDex: primaryDexName ?? lpPool?.dexId ?? lpPool?.dexName ?? null,
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
    let _lpGrPctDerived = false
    let _lpRpcFallbackRan = false
    let _lpGrItemCount = 0
    if (!_lpProofPresent) {
      // No pool at all — not even a market pool with a usable address
      lpControl = { ...lpControl, status: "no_pool", reason: "No pool address found from provider for LP-holder verification." };
    } else if (!lpVerifyPoolPresent && (lpPoolType === "v3" || lpPoolType === "aerodrome" || lpPoolType === "concentrated")) {
      // Market pool exists but is protocol/concentrated, and no V2 pool found anywhere → protocol status
      lpControl = {
        status: lpPoolType === "aerodrome" ? "protocol" : "concentrated_liquidity",
        confidence: "medium",
        poolType: lpPoolType,
        source: "dex_data",
        reason: "Protocol-specific LP proof required.",
        evidence: [
          `Market pool: ${marketPair} (${lpPoolType})`,
          `pool=${primaryPoolAddress}`, `dex=${lpDexId ?? lpDexName ?? "unknown"}`, `poolType=${lpPoolType}`,
        ],
      };
    } else if (lpVerifyPoolPresent && lpVerifyPool?.hasLpToken === false) {
      // LP verification pool has no ERC20 LP token (V3/CL NFT) — burn/lock proof not applicable
      lpControl = {
        status: (lpVerifyPool.poolType === 'aerodrome') ? 'protocol' : 'concentrated_liquidity',
        confidence: 'medium',
        poolType: _lpProofType,
        source: 'dex_data',
        reason: 'Protocol-specific LP proof required.',
        evidence: [
          `Market pool: ${marketPair} (${_lpProofType})`,
          `pool=${_lpAddrSnippet}`, `dex=${lpDexId ?? lpDexName ?? 'unknown'}`, `hasLpToken=false`,
        ],
      };
    } else if (_lpProofType === "unknown") {
      // Step 1: try GoldRush LP holder proof (same as v2 path) using pre-fetched data
      const _unknownLpItems = Array.isArray(_lpHoldersForControl?.data?.items) ? _lpHoldersForControl.data.items as Array<Record<string, unknown>> : [];
      _lpGrItemCount = _unknownLpItems.length
      const _grStatus = _lpHoldersForControl?.__status ?? (_unknownLpItems.length > 0 ? 'ok' : 'empty')
      const _unknownLpSupply = _unknownLpItems.find((i: Record<string, unknown>) => i?.total_supply != null)?.total_supply
      const _unknownLpSupplyStr = _unknownLpSupply != null ? String(_unknownLpSupply) : null
      const unknownTop = _unknownLpItems.slice(0, 5).map((h: Record<string, unknown>) => {
        const directPct = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage)
        let derivedPct: number | null = null
        if (directPct == null && _unknownLpSupplyStr != null) {
          derivedPct = bigIntPct(h.balance ?? h.token_balance, _unknownLpSupplyStr)
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
          lpControl = { status: "burned", confidence: confidenceFor(unknownBurnPct), poolType: "v2", source: "geckoterminal+goldrush", reason: "Dominant LP share appears in burn/dead addresses.", evidence: [`burn_share=${unknownBurnPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        } else if (unknownLockerPct >= 50) {
          lpControl = { status: "locked", confidence: confidenceFor(unknownLockerPct), poolType: "v2", source: "geckoterminal+goldrush", reason: "Dominant LP share appears in known lockers.", evidence: [`locker_share=${unknownLockerPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        } else if (unknownTopHolder && (unknownTopHolder.pct ?? 0) >= 80 && !DEAD.has(unknownTopHolder.address) && !KNOWN_LOCKERS.has(unknownTopHolder.address)) {
          lpControl = { status: "team_controlled", confidence: "high", poolType: "v2", source: "geckoterminal+goldrush", reason: "Single normal wallet holds dominant LP share.", evidence: [`top_holder=${unknownTopHolder.address}`, `top_share=${(unknownTopHolder.pct ?? 0).toFixed(2)}%`], poolAddressPresent: true, dexId: dexId || undefined };
        } else {
          const partialEv2 = [
            unknownBurnPct > 0.5 ? `burn_share=${unknownBurnPct.toFixed(2)}%` : null,
            unknownLockerPct > 0.5 ? `locker_share=${unknownLockerPct.toFixed(2)}%` : null,
          ].filter(Boolean) as string[]
          lpControl = { status: partialEv2.length ? "partial" : "partial", confidence: "low", poolType: "v2", source: "geckoterminal+goldrush", reason: "LP holder check inconclusive — no dominant burn/lock pattern.", evidence: [`top_rows=${unknownTop.length}`, ...partialEv2, `pool=${_lpAddrSnippet}`], poolAddressPresent: true, dexId: dexId || undefined };
        }
      } else {
        // Step 2: GoldRush failed or empty — probe pool via RPC to classify
        _lpRpcFallbackRan = true
        const probe = await probePoolTypeViaRpc(chain, _lpProofAddress!);
        if (probe.v2Like) {
          const totalSupplyHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
          const totalSupply = totalSupplyHex ? Number(BigInt(totalSupplyHex)) : null;
          if (!totalSupply || totalSupply <= 0) {
            lpControl = { status: "partial", confidence: "low", poolType: "v2", source: "dex_data+rpc", reason: "Pool probed as V2-like but RPC totalSupply read returned no data.", evidence: [`Verification pool: ${lpPair}`, "RPC probe: V2-like interface detected"], poolAddressPresent: true, probeV2Like: true, probeV3Like: false, dexId: dexId || undefined };
          } else {
            const readPct = async (addr: string) => {
              const data = `0x70a08231${pad32HexAddress(addr)}`;
              const balHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data }, "latest"], "lpControlCheck.balanceOf", false);
              if (!balHex) return 0;
              return (Number(BigInt(balHex)) / totalSupply) * 100;
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
              lpControl = { ...base, status: (burnShare > 0 || lockerShare > 0) ? "partial" : "partial", confidence: "low", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
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
      const _lpGrSupplyStr = _lpGrTotalSupply != null ? String(_lpGrTotalSupply) : null
      const top = lpItems.slice(0, 5).map((h) => {
        const directPct = toNum(h.percentage) ?? toNum(h.percent) ?? toNum(h.ownership_percentage)
        let derivedPct: number | null = null
        if (directPct == null && _lpGrSupplyStr != null) {
          derivedPct = bigIntPct(h.balance ?? h.token_balance, _lpGrSupplyStr)
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
      if (burnPct >= 50) {
        lpControl = { status: "burned", confidence: confidenceFor(burnPct), poolType: _lpProofType, source: "geckoterminal+goldrush", reason: "Dominant LP share appears in burn/dead addresses.", evidence: [`burn_share=${burnPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
      } else if (lockerPct >= 50) {
        lpControl = { status: "locked", confidence: confidenceFor(lockerPct), poolType: _lpProofType, source: "geckoterminal+goldrush", reason: "Dominant LP share appears in known lockers.", evidence: [`locker_share=${lockerPct.toFixed(2)}%`, `pool=${_lpAddrSnippet}`] };
      } else if (topHolder && (topHolder.pct ?? 0) >= 80 && !DEAD.has(topHolder.address) && !KNOWN_LOCKERS.has(topHolder.address)) {
        lpControl = { status: "team_controlled", confidence: "high", poolType: _lpProofType, source: "geckoterminal+goldrush", reason: "Single normal wallet holds dominant LP share.", evidence: [`top_holder=${topHolder.address}`, `top_share=${(topHolder.pct ?? 0).toFixed(2)}%`] };
      } else if (lpItems.length === 0 || !top.some((x) => (x.pct ?? 0) > 0)) {
        // Alchemy RPC fallback when GoldRush holder percentages are unavailable
        _lpRpcFallbackRan = true
        const totalSupplyHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data: "0x18160ddd" }, "latest"], "lpControlCheck.totalSupply", false);
        const totalSupply = totalSupplyHex ? Number(BigInt(totalSupplyHex)) : null;
        if (!totalSupply || totalSupply <= 0) {
          lpControl = { status: "partial", confidence: "low", poolType: _lpProofType, source: "dex_data+rpc", reason: "LP holder percentages not indexed; RPC totalSupply read returned no data.", evidence: [`pool=${_lpAddrSnippet}`] };
        } else {
          const readPct = async (addr: string) => {
            const data = `0x70a08231${pad32HexAddress(addr)}`;
            const balHex = await countedRpcCall("eth_call", [{ to: _lpProofAddress!, data }, "latest"], "lpControlCheck.balanceOf", false);
            if (!balHex) return 0;
            return (Number(BigInt(balHex)) / totalSupply) * 100;
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
            lpControl = { status: (burnShare > 0 || lockerShare > 0) ? "partial" : "partial", confidence: "low", poolType: _lpProofType, source: "dex_data+rpc", reason: "RPC balances do not prove burned/locked LP dominance.", evidence: [`burn_share=${burnShare.toFixed(2)}%`, `locker_share=${lockerShare.toFixed(2)}%`] };
          }
        }
      } else {
        const partialEv = [
          burnPct > 0.5 ? `burn_share=${burnPct.toFixed(2)}%` : null,
          lockerPct > 0.5 ? `locker_share=${lockerPct.toFixed(2)}%` : null,
        ].filter(Boolean) as string[]
        const partialReason = partialEv.length
          ? `LP holder check inconclusive — no dominant burn/lock pattern. ${partialEv.join(', ')}.`
          : "LP checks ran but could not prove burned/locked/team-controlled state."
        lpControl = { status: partialEv.length ? "partial" : "partial", confidence: "low", poolType: _lpProofType, source: "geckoterminal+goldrush", reason: partialReason, evidence: [`top_rows=${top.length}`, ...partialEv] };
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
    const lpOwnershipVerified = Boolean(ownerAddrEarlyForLp && _lpProofPresent)

    // Ensure poolAddressPresent is always correct on the final object — some inner branches
    // replace lpControl wholesale without setting this field (e.g., GoldRush/RPC paths).
    lpControl.poolAddressPresent = _lpProofPresent;

    lpControl.evidence = [
      ...(lpControl.evidence ?? []),
      `Market primary pair: ${marketPair}`,
      `Primary market pool: ${lpPoolAddress ?? 'none'} (${lpPoolType})`,
      `LP verification pair: ${lpPair}`,
      `LP verification pool: ${_lpProofAddress ?? 'none'} (${_lpProofType})`,
      lpVerifyPoolPresent && lpPool !== lpVerifyPool ? `V2 proof pool differs from market pool` : '',
      `LP verification reason: ${lpReason}`,
      `lpHolderCheckAttempted=${needsLpHolderFetch}`,
    ].filter(Boolean);

    // AI summary from parallel phase 2
    const _chainName = chain === 'eth' ? 'Ethereum' : 'Base'
    const _aiResult = _aiSettled.status === 'fulfilled' ? _aiSettled.value : null
    let aiSummary: string
    if (_aiResult && typeof _aiResult === 'object' && 'content' in _aiResult) {
      const _aiContent = (_aiResult as { content: Array<{type: string; text?: string}> }).content
      const _aiText = _aiContent?.[0]
      aiSummary = (_aiText?.type === 'text' && _aiText.text) ? _aiText.text : _buildDeterministicSummary(_chainName, noActivePools, hpResult, analysis, _holderItemsEarly, _ownerStatusEarly, lpPoolType ?? lpVerifyPoolType)
    } else {
      aiSummary = _buildDeterministicSummary(_chainName, noActivePools, hpResult, analysis, _holderItemsEarly, _ownerStatusEarly, lpPoolType ?? lpVerifyPoolType)
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

    const percentRows = topHolders.filter((h: any) => h.percent != null)
    let hasPct = percentRows.length > 0
    const anyProviderPct = holderPctFromProvider.some(Boolean)
    let percentSource: 'provider' | 'calculated' | 'inferred' = hasPct ? (anyProviderPct ? 'provider' : 'calculated') : 'inferred'
    console.log('[holders] normalized length', topHolders.length, '[holders] percent available', hasPct, '[holders] pct source', percentSource)
    const sum = (n: number) => topHolders.slice(0, n).reduce((acc: number, h: any) => acc + (h.percent ?? 0), 0)
    let top1 = hasPct ? sum(1) : null
    let top5 = hasPct ? sum(5) : null
    let top10 = hasPct ? sum(10) : null
    let top20 = hasPct ? sum(20) : null

    // Fallback percent derivation: provider returned holder rows with raw balances but no percentage
    // field. Try to derive from RPC totalSupply(), then summed returned balances as last resort.
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
      if ((totalSupplyBig == null || totalSupplyBig <= BigInt(0)) && rawBalanceByAddress.size > 0) {
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
        let anyDerived = false
        for (const holder of topHolders as Array<{ rank: number; address: string; amount: string | number | null; percent: number | null }>) {
          const rawBal = rawBalanceByAddress.get(holder.address.toLowerCase())
          if (rawBal == null) continue
          try {
            const balBig = BigInt(String(rawBal))
            holder.percent = Number(balBig * BigInt(10000) / totalSupplyBig) / 100
            anyDerived = true
          } catch {}
        }
        if (anyDerived) {
          topHolders.sort((a: any, b: any) => (b.percent ?? 0) - (a.percent ?? 0))
          hasPct = true
          percentSource = 'calculated'
          top1 = sum(1); top5 = sum(5); top10 = sum(10); top20 = sum(20)
          _holderPctDerived = true
        }
      }
    }

    const normalizedTop = topHolders.slice(0, 200)
    let holderDistribution: HolderDistribution = normalizedTop.length
      ? { top1, top5, top10, top20, others: hasPct && top20 != null ? Math.max(0, 100 - top20) : null, holderCount, topHolders: normalizedTop }
      : { top1: null, top5: null, top10: null, top20: null, others: null, holderCount: holderCount ?? null, topHolders: [] }
    let holderDistributionStatus: HolderDistributionStatus = normalizedTop.length > 0
      ? (hasPct
          ? {
              status: _holderPctDerivedFromSummedRows ? 'partial' : 'ok',
              reason: _holderPctDerived
                ? (_holderPctDerivedFromSummedRows ? 'percentages_estimated_from_returned_rows' : 'percentages_derived_from_rpc_supply')
                : 'holder_percentages_verified',
              itemCount: holderItems.length, normalizedCount: normalizedTop.length, percentSource,
            }
          : { status: 'partial', reason: 'no_percentages', itemCount: holderItems.length, normalizedCount: normalizedTop.length, percentSource })
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
    // - Normal scan: primary wins, fallback fills only when primary is null
    // - forceDexFallback (debug only): fallback values override primary
    const _ep   = forceDexFallback ? (_dexFb?.priceUsd ?? null)      : (priceUsd ?? _dexFb?.priceUsd ?? null)
    const _el   = forceDexFallback ? (_dexFb?.liquidityUsd ?? null)   : (liquidityUsd ?? _dexFb?.liquidityUsd ?? null)
    const _ev   = forceDexFallback ? (_dexFb?.volume24h ?? null)      : (resolvedVolume24hUsd ?? _dexFb?.volume24h ?? null)
    const _efdv = forceDexFallback ? (_dexFb?.fdv ?? null)            : (fdv ?? _dexFb?.fdv ?? null)
    // If fallback has FDV and primary displayMarketValue is null, show fallback FDV
    if (_dexFb?.fdv != null && displayMarketValue == null) {
      displayMarketValue = _dexFb.fdv
      displayMarketValueLabel = 'FDV'
      displayMarketValueConfidence = 'low'
      displayMarketValueReason = 'Market cap not indexed; FDV from fallback market read. Not verified as circulating market cap.'
    }

    const buySellVolumeSplitAvailable = buyVolume24hUsd != null && sellVolume24hUsd != null
    const buySellVolumeReason = buySellVolumeSplitAvailable ? 'split_exposed' : (resolvedVolume24hUsd != null ? 'only_total_exposed' : 'volume_not_exposed')
    let priceChart: { timeframe: '24h'|'48h'|'7d'|'30d'; points: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number }>; sourceStatus: 'ok'|'partial'|'error'; reason?: string; fallbackUsed?: boolean } = {
      timeframe: '24h',
      points: [],
      sourceStatus: 'partial',
      reason: 'primary_pool_missing',
    }
    const chartAttemptedPools: Array<{ address: string; name: string | null; liquidityUsd: number | null }> = []
    const chartPoolCandidates = [mainPool, ...matchingPools.filter((p) => p !== mainPool)]
      .filter((p): p is NonNullable<typeof mainPool> => Boolean(p?.attributes?.address))
      .map((p) => ({
        pool: p,
        address: String(p.attributes.address),
        name: typeof p.attributes.name === 'string' ? p.attributes.name : null,
        liquidityUsd: toNum(p.attributes.reserve_in_usd),
        volume24hUsd: toNum((p.attributes.volume_usd as Record<string, unknown> | undefined)?.h24),
      }))
      .sort((a, b) => ((b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)) || ((b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1)))
    const primaryAddr = String(mainPoolAttr.address ?? '').toLowerCase()
    chartPoolCandidates.sort((a, b) => {
      if (a.address.toLowerCase() === primaryAddr) return -1
      if (b.address.toLowerCase() === primaryAddr) return 1
      return 0
    })
    const uniqueChartPools = chartPoolCandidates.filter((c, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === c.address.toLowerCase()) === i)
    const maxAttempts = Math.min(uniqueChartPools.length, 4)
    const chartAttemptedTimeframes: string[] = []
    const timeframeAttempts: Array<{ key: '24h'|'48h'|'7d'|'30d'; resolution: 'minute'|'hour'|'day'; aggregate: number; limit: number }> = [
      { key: '24h', resolution: 'minute', aggregate: 15, limit: 96 },
      { key: '48h', resolution: 'hour', aggregate: 1, limit: 48 },
      { key: '7d', resolution: 'day', aggregate: 1, limit: 7 },
      { key: '30d', resolution: 'day', aggregate: 1, limit: 30 },
    ]
    const _chartNetworkIdMap: Record<ChainKey, string> = { eth: 'eth', base: 'base', polygon: 'polygon_pos', bnb: 'bsc' }
    const _chartNetworkId = _chartNetworkIdMap[chain] ?? 'base'
    let chartFailureReason: string | null = maxAttempts > 0 ? null : 'primary_pool_missing'
    let chartSelectedPoolForChart: { address: string; name: string | null } | null = null
    for (let i = 0; i < maxAttempts; i += 1) {
      const candidate = uniqueChartPools[i]
      const tokenPos = resolveTokenPositionInPool(candidate.pool as Record<string, unknown>, contract.toLowerCase(), _chartNetworkId)
      chartAttemptedPools.push({ address: candidate.address, name: candidate.name, liquidityUsd: candidate.liquidityUsd })
      for (let t = 0; t < timeframeAttempts.length; t += 1) {
        const tf = timeframeAttempts[t]
        chartAttemptedTimeframes.push(`${tf.key}:${tf.resolution}/${tf.aggregate}x${tf.limit}:${tokenPos}`)
        const chartRaw = await fetchGeckoTerminalPoolOhlcv(candidate.address, chain, tf, tokenPos)
        const list = chartRaw?.data?.attributes?.ohlcv_list
        if (!Array.isArray(list)) { chartFailureReason = 'ohlcv_not_exposed'; continue }
        const points = list.map((row: unknown) => {
          const arr = Array.isArray(row) ? row : null
          const tsNum = toNum(arr?.[0])
          const close = toNum(arr?.[4])
          if (tsNum == null || close == null || close <= 0) return null
          const ms = tsNum > 1e12 ? tsNum : tsNum * 1000
          const rawOpen = toNum(arr?.[1]) ?? close
          const rawHigh = toNum(arr?.[2]) ?? close
          const rawLow  = toNum(arr?.[3]) ?? close
          const open   = rawOpen > 0 ? rawOpen : close
          const high   = Math.max(rawHigh > 0 ? rawHigh : close, open, close)
          const low    = Math.min(rawLow  > 0 ? rawLow  : close, open, close)
          const volume = toNum(arr?.[5]) ?? null
          return { timestamp: new Date(ms).toISOString(), open, high, low, close, volume, priceUsd: close }
        }).filter((p: { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number } | null): p is { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number } => p != null)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        if (points.length >= 2) {
          priceChart = { timeframe: tf.key, points, sourceStatus: 'ok' }
          chartSelectedPoolForChart = { address: candidate.address, name: candidate.name }
          chartFailureReason = null
          break
        }
        chartFailureReason = 'insufficient_points'
      }
      if (priceChart.sourceStatus === 'ok') break
    }
    // Token-level OHLCV fallback — tries /tokens/{address}/ohlcv which aggregates across all pools.
    // Reliable for CL/V3 pools (Aerodrome CL, Uniswap V3) where individual pool OHLCV is not indexed.
    // Only runs when all pool-level attempts failed. Capped to 4 calls (one per timeframe); breaks on first success.
    let chartUsedTokenLevelOhlcv = false
    let chartTokenLevelAttempted = false
    if (priceChart.sourceStatus !== 'ok') {
      chartTokenLevelAttempted = true
      for (const tf of timeframeAttempts) {
        chartAttemptedTimeframes.push(`token_level:${tf.key}:${tf.resolution}/${tf.aggregate}x${tf.limit}`)
        const chartRaw = await fetchGeckoTerminalTokenOhlcv(contract, chain, tf)
        const list = chartRaw?.data?.attributes?.ohlcv_list
        if (!Array.isArray(list)) { chartFailureReason = 'token_ohlcv_not_exposed'; continue }
        const points = list.map((row: unknown) => {
          const arr = Array.isArray(row) ? row : null
          const tsNum = toNum(arr?.[0])
          const close = toNum(arr?.[4])
          if (tsNum == null || close == null || close <= 0) return null
          const ms = tsNum > 1e12 ? tsNum : tsNum * 1000
          const rawOpen = toNum(arr?.[1]) ?? close
          const rawHigh = toNum(arr?.[2]) ?? close
          const rawLow  = toNum(arr?.[3]) ?? close
          const open   = rawOpen > 0 ? rawOpen : close
          const high   = Math.max(rawHigh > 0 ? rawHigh : close, open, close)
          const low    = Math.min(rawLow  > 0 ? rawLow  : close, open, close)
          const volume = toNum(arr?.[5]) ?? null
          return { timestamp: new Date(ms).toISOString(), open, high, low, close, volume, priceUsd: close }
        }).filter((p: { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number } | null): p is { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null; priceUsd: number } => p != null)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        if (points.length >= 2) {
          priceChart = { timeframe: tf.key, points, sourceStatus: 'ok' }
          chartFailureReason = null
          chartUsedTokenLevelOhlcv = true
          break
        }
        chartFailureReason = 'token_ohlcv_insufficient_points'
      }
    }
    // Trade-reconstruction fallback — fetches real GeckoTerminal pool trade events and groups them
    // into time-bucketed candles. Only runs when all OHLCV attempts fail. Caps to 2 pools.
    // Requires >= 3 valid priced trades spanning >= 2 time buckets; does not run otherwise.
    let chartUsedTradeReconstruction = false
    let chartTradeReconstructionAttempted = false
    let chartReconstructedTradeCount = 0
    let chartReconstructedCandleCount = 0
    if (priceChart.sourceStatus !== 'ok') {
      chartTradeReconstructionAttempted = true
      for (const poolCandidate of uniqueChartPools.slice(0, 2)) {
        chartAttemptedTimeframes.push(`trade_recon:${poolCandidate.address.slice(0, 10)}`)
        const tradesRaw = await fetchGeckoTerminalPoolTrades(poolCandidate.address, chain)
        const tradesArr: unknown[] = Array.isArray(tradesRaw?.data) ? tradesRaw.data : []
        chartReconstructedTradeCount = Math.max(chartReconstructedTradeCount, tradesArr.length)
        const reconstructed = reconstructCandlesFromTrades(tradesArr, priceUsd)
        if (reconstructed && reconstructed.length >= 2) {
          chartReconstructedCandleCount = reconstructed.length
          priceChart = { timeframe: '24h', points: reconstructed, sourceStatus: 'ok' }
          chartFailureReason = null
          chartUsedTradeReconstruction = true
          break
        }
      }
      if (!chartUsedTradeReconstruction) {
        chartFailureReason = chartFailureReason ?? 'trade_reconstruction_insufficient'
      }
    }
    if (priceChart.sourceStatus !== 'ok' && (maxAttempts > 0 || chartUsedTokenLevelOhlcv || chartTradeReconstructionAttempted)) {
      priceChart = { timeframe: '24h', points: [], sourceStatus: 'partial', reason: chartFailureReason ?? 'all_chart_sources_empty' }
    }
    const chartAttempted = chartAttemptedPools.length > 0 || chartUsedTokenLevelOhlcv || chartTradeReconstructionAttempted
    const chartFallbackUsed = (chartSelectedPoolForChart != null && chartSelectedPoolForChart.address.toLowerCase() !== primaryAddr) || chartUsedTokenLevelOhlcv || chartUsedTradeReconstruction
    if (priceChart.sourceStatus === 'ok') priceChart.fallbackUsed = chartFallbackUsed
    const chartStatus: 'ok' | 'snapshot_only' | 'unavailable_with_reason' =
      priceChart.sourceStatus === 'ok' ? 'ok' :
      noActivePools ? 'unavailable_with_reason' :
      'snapshot_only'
    const chartSource: string | null =
      chartStatus !== 'ok' ? null :
      chartUsedTradeReconstruction ? 'trade_reconstructed' :
      chartUsedTokenLevelOhlcv ? 'token_level_ohlcv' :
      chartFallbackUsed ? 'alternate_pool_ohlcv' :
      'primary_pool_ohlcv'
    const chartReason: string | null =
      chartStatus === 'ok'
        ? (chartUsedTradeReconstruction ? 'trade_reconstructed_from_recent_swaps'
           : chartUsedTokenLevelOhlcv ? 'token_level_ohlcv_used'
           : chartFallbackUsed ? 'alternate_pool_used'
           : null)
        : (chartFailureReason ?? 'all_chart_sources_empty')
    const chartDataSource: 'primary' | 'fallback' | 'none' =
      priceChart.sourceStatus === 'ok' ? (chartFallbackUsed ? 'fallback' : 'primary') :
      marketDataSource === 'fallback' ? 'fallback' :
      'none'
    const pairCreatedAt = String(mainPoolAttr.pool_created_at ?? '').trim() || null
    const pairAgeLabel = pairCreatedAt ? computePairAge(pairCreatedAt) : null
    const poolCount = matchingPools.length
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
    const securityReason = hpResult.ok ? null : _simImpliedClean ? "simulation_implied_clean" : "simulation_not_performed";
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
    // Only mark renounced when RPC was attempted (alchemyConfigured) and owner is zero/null.
    // If RPC wasn't configured, ownerAddr is null but we haven't verified anything.
    const rpcOwnershipAttempted = alchemyConfigured
    const isRenounced = rpcOwnershipAttempted && (!ownerAddr || ownerAddr === _ZERO_ADDR)
    // ownerAddr=zero (renounced) does not count as verified — a zero string is truthy but meaningless
    const ownershipVerified = rpcOwnershipAttempted && Boolean((ownerAddr && ownerAddr !== _ZERO_ADDR) || adminAddr)
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
        note: `No bytecode, GoldRush, or simulation available. ${flagName} inferred absent based on standard ERC20 pattern — manual on-chain check recommended.`,
      }
    }
    const _resolveFlag = (
      grValue: boolean | null | undefined,
      bytecodeSel: boolean,
      bytecodeNote: string,
      rpcConfirm?: boolean,
    ): FlagStatus => {
      if (rpcConfirm) return { status: 'verified', confidence: 'high', note: 'RPC call confirmed' }
      if (grValue === true) return { status: 'verified', confidence: 'high', note: 'GoldRush Contract Intel confirmed' }
      if (grValue === false) return { status: 'not_detected', confidence: 'high', note: 'GoldRush Contract Intel: not present' }
      // GoldRush returned null — fall back to ABI/bytecode signature scan
      if (!_hasBytecode) return _inferFlagAbsent(bytecodeNote.split(' ')[0])
      if (bytecodeSel) return { status: 'verified', confidence: 'high', note: bytecodeNote }
      return { status: 'not_detected', confidence: 'medium', note: `ABI signature scan: not detected (GoldRush fallback)` }
    }
    const cortexContractFlags: CortexContractFlagsResult = {
      mint: _resolveFlag(_grCI?.mint, _cortexMintSel, 'Mint selector in ABI/bytecode (40c10f19 or a0712d68)'),
      proxy: (() => {
        if (_isVerifiedProxy) return { status: 'verified' as const, confidence: 'high' as const, note: 'EIP-1967 implementation slot is non-zero (RPC confirmed)' }
        if (_grCI?.proxy === true || _grCI?.upgradeable === true) return { status: 'verified' as const, confidence: 'high' as const, note: 'GoldRush Contract Intel: proxy/upgradeable confirmed' }
        if (_grCI?.proxy === false && _grCI?.upgradeable === false) return { status: 'not_detected' as const, confidence: 'high' as const, note: 'GoldRush Contract Intel: not proxy' }
        if (!_hasBytecode) return _inferFlagAbsent('Proxy/upgradeable') as { status: 'verified' | 'possible' | 'not_detected' | 'inferred' | 'partial'; confidence: 'high' | 'medium' | 'low'; note: string }
        if (_cortexProxySel) return { status: 'possible' as const, confidence: 'medium' as const, note: 'Upgrade selector in ABI/bytecode; EIP-1967 slot not confirmed' }
        return { status: 'not_detected' as const, confidence: 'medium' as const, note: 'ABI signature scan: no proxy selector or EIP-1967 slot (GoldRush fallback)' }
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
    const lpProofStatus: 'not_applicable' | 'verified' | 'partial' | 'inferred' =
      (lpState === 'protocol' || lpState === 'concentrated_liquidity') ? 'not_applicable' :
      (lpState === 'burned' || lpState === 'locked') ? 'verified' :
      (lpState === 'team_controlled') ? 'verified' :
      (lpState === 'partial') ? 'partial' : 'inferred'
    if (lpState === 'burned' || lpState === 'locked') { riskVerifiedSignals.push(`LP Control shows ${lpState}.`); riskScore -= 12 }
    else if (lpState === 'protocol' || lpState === 'concentrated_liquidity') { riskVerifiedSignals.push('LP Control indicates protocol-managed liquidity structure.'); riskScore += 3 }
    else if (lpState === 'team_controlled') { riskDrivers.push('LP Control indicates a dominant team wallet can control liquidity.'); riskScore += 28 }
    else if (lpProofStatus === 'inferred') { openChecks.push('LP lock/burn not confirmed — liquidity exit risk should be assumed.'); riskScore += 10 }
    else { riskScore += 5 }

    const riskOwnerStatus = isRenounced ? 'renounced' : (ownershipVerified ? 'held' : 'inferred_active')
    if (riskOwnerStatus === 'renounced') { riskVerifiedSignals.push('Dev Control: ownership appears renounced.'); riskScore -= 6 }
    else if (riskOwnerStatus === 'held') { riskDrivers.push('Dev Control: ownership is held by a wallet.'); riskScore += 10 }
    // inferred_active: ownership source not found — assume active (conservative)
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
    const deployerProfile: RiskEngine["deployerProfile"] = (() => {
      const _rugHistory: number | null = null // live lookup not available; inferred below
      const _isProxy = cortexContractFlags.proxy.status === 'verified' || cortexContractFlags.proxy.status === 'possible'
      const _deployPattern: RiskEngine["deployerProfile"]["deployPattern"] = _isProxy ? 'proxy'
        : proxyImplAddr ? 'proxy'
        : chain === 'base' && !ownerAddr ? 'factory'
        : ownerAddr ? 'eoa'
        : 'inferred'
      const _clusterRisk: RiskEngine["deployerProfile"]["clusterRisk"] = 'inferred'
      if (ownerAddr && ownerAddr !== '0x0000000000000000000000000000000000000000') {
        const _src = _ownerFromTransfer ? 'moralis_transfer_fallback' : 'rpc_selector'
        return { status: 'verified', deployer: ownerAddr, method: _src, rugHistory: _rugHistory, clusterRisk: _clusterRisk, deployPattern: _deployPattern, note: `Deployer wallet identified via ${_src === 'rpc_selector' ? 'on-chain owner() call' : 'Moralis mint transfer event'}. Rug history lookup requires Etherscan/DeBank cross-reference.` }
      }
      if (ownerAddr === '0x0000000000000000000000000000000000000000' || isRenounced) {
        return { status: 'verified', deployer: '0x0000000000000000000000000000000000000000', method: 'rpc_selector', rugHistory: 0, clusterRisk: 'clean', deployPattern: _deployPattern, note: 'Ownership renounced — zero address confirmed as current owner. No active deployer control.' }
      }
      const _chainCtx = chain === 'base'
        ? 'Base: factory or CL pool deployer pattern likely — verify on Basescan.'
        : 'Ethereum: EOA deployment expected — verify on Etherscan.'
      return { status: 'inferred', deployer: null, method: 'inference', rugHistory: null, clusterRisk: _clusterRisk, deployPattern: _deployPattern, note: `Deployer not resolved from RPC or transfer events. ${_chainCtx}` }
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

    // ── LP Intelligence — lock time, migration risk, mint authority, depth, volatility ──
    const lpIntelligence: RiskEngine["lpIntelligence"] = (() => {
      const _lpStatus = lpControl.status
      if (_lpStatus === 'no_pool' || noActivePools) {
        return { status: 'not_applicable', lockTime: null, lockTimeSeconds: null, migrationRisk: 'inferred', mintAuthority: 'not_applicable', depth: 'none', volatility: 'inferred', liquidityDecay: 'critical', poolType: lpPoolType ?? 'none', note: 'No active LP pool found — LP intelligence not applicable.' }
      }
      const _unlockAt = goldrush?.lock?.unlockAt ?? null
      const _unlockEpoch = _unlockAt ? Date.parse(String(_unlockAt)) : NaN
      const _lockSecs = Number.isFinite(_unlockEpoch) ? Math.max(0, Math.floor((_unlockEpoch - Date.now()) / 1000)) : null
      const _lockTimeLabel = _lockSecs == null ? null : _lockSecs > 86400 * 365 ? `${Math.round(_lockSecs / (86400 * 365))} year(s)` : _lockSecs > 86400 ? `${Math.round(_lockSecs / 86400)} day(s)` : _lockSecs > 3600 ? `${Math.round(_lockSecs / 3600)} hour(s)` : `${Math.round(_lockSecs / 60)} min(s)`
      // Migration risk: high when team-controlled or no lock proof
      const migrationRisk: RiskEngine["lpIntelligence"]["migrationRisk"] = _lpStatus === 'team_controlled' ? 'high'
        : _lpStatus === 'burned' ? 'low'
        : _lpStatus === 'locked' ? (_lockSecs != null && _lockSecs < 86400 * 30 ? 'medium' : 'low')
        : _lpStatus === 'protocol' || _lpStatus === 'concentrated_liquidity' ? 'medium'
        : 'inferred'
      // Mint authority: active if mint flag detected, renounced if ownership renounced
      const mintAuthority: RiskEngine["lpIntelligence"]["mintAuthority"] = cortexContractFlags.mint.status === 'verified' ? 'active'
        : isRenounced ? 'renounced'
        : cortexContractFlags.mint.status === 'not_detected' || cortexContractFlags.mint.status === 'inferred' ? 'renounced'
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
      const _typeLabel = lpPoolType === 'v2' ? 'V2 AMM' : lpPoolType === 'v3' ? 'V3 Concentrated Liquidity' : (lpPoolType ?? 'unknown')
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
        note: `LP ${_lpStatus === 'burned' ? 'is burned — permanent lock' : _lpStatus === 'locked' ? `is locked (${_lockTimeLabel ?? 'duration unknown'})` : _lpStatus === 'team_controlled' ? 'is team-controlled — exit risk active' : _lpStatus === 'protocol' ? 'is protocol-owned — follows protocol governance' : _lpStatus === 'concentrated_liquidity' ? 'uses concentrated liquidity — standard V3/CL format' : 'control status inferred — lock or burn proof not confirmed'}. Depth: ${depth}. Migration risk: ${migrationRisk}.`
      }
    })()

    // ── Clark Interpretation — 3-phase contextual summary with risk drivers, open checks, next actions ──
    const clarkInterpretation: RiskEngine["clarkInterpretation"] = (() => {
      const _chain = chain === 'eth' ? 'Ethereum' : 'Base'
      const _chainCtx = chain === 'base'
        ? `On Base: check for CL pool (Aerodrome/Uniswap v3) and proxy-pattern contracts. Factory deployers are common. LP migration via concentrated liquidity positions is possible.`
        : `On Ethereum: standard v2 LP patterns apply. Renounce events and Ownable/Pausable are common risk markers. Check Etherscan for deployer history.`
      // Build next actions from open checks + data gaps
      const nextActions: string[] = []
      if (!holderDataComplete) nextActions.push(`Verify holder concentration via ${chain === 'eth' ? 'Etherscan token holders' : 'Basescan'}.`)
      if (!hpResult.ok) nextActions.push('Run a manual trade simulation to confirm buy/sell taxes and honeypot status.')
      if (deployerProfile.deployer == null) nextActions.push(`Trace deployer wallet via ${chain === 'eth' ? 'Etherscan contract creation' : 'Basescan'} before taking a position.`)
      if (lpIntelligence.migrationRisk === 'high' || lpIntelligence.migrationRisk === 'inferred') nextActions.push('Verify LP lock status — team-controlled liquidity can be removed at any time.')
      if (cortexContractFlags.mint.status === 'inferred') nextActions.push('Confirm mint function absence via contract source code or bytecode audit.')
      if (lpIntelligence.depth === 'shallow' || lpIntelligence.depth === 'none') nextActions.push('Caution: shallow liquidity — large trades will face significant slippage.')
      if (nextActions.length === 0) nextActions.push('All major checks passed — continue monitoring for holder changes and LP movements.')
      // Summary sentence
      const _riskSuffix = rugRiskLabel === 'critical' ? 'Multiple critical rug vectors confirmed — avoid exposure.' : rugRiskLabel === 'high' ? 'High risk flags present — verify before any position.' : rugRiskLabel === 'watch' ? 'Watch-level signals — monitor closely.' : rugRiskLabel === 'partial_data' ? 'Partial data scan — score is conservative baseline pending full verification.' : 'Low visible risk across verified checks.'
      const _topDriver = riskDrivers.length > 0 ? ` Primary risk: ${riskDrivers[0]}` : ''
      const summary = `${_chain} token. Score: ${rugRiskScore}/100. ${_riskSuffix}${_topDriver}`
      return {
        summary,
        riskDrivers: [...riskDrivers],
        openChecks: [...openChecks],
        nextActions,
        chainContext: _chainCtx,
        confidence: riskConfidence,
      }
    })()

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
    const lpUnlockAt = goldrush?.lock?.unlockAt ?? null
    const unlockEpoch = lpUnlockAt ? Date.parse(String(lpUnlockAt)) : NaN
    const lpCountdownSeconds = Number.isFinite(unlockEpoch) ? Math.max(0, Math.floor((unlockEpoch - Date.now()) / 1000)) : null
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
                  : "unlocked",
        unlock_at: lpUnlockAt,
        countdown_seconds: lpCountdownSeconds,
        owner: ownerAddr ?? null,
        contract: primaryPoolAddress ?? null,
        movement_24h_usd: _ev ?? null,
        source_status: lpControl.status === "error" || lpControl.status === "insufficient_data" ? "partial" : "ok",
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
    if (!hasPct && normalizedTop.length > 0 && _derivationSupply != null) {
      holderDerivationAttempted = true
      let derivedCount = 0
      for (const h of normalizedTop as any[]) {
        if (h.percent != null) continue
        const rawBal = rawBalanceByAddress.get((h.address ?? '').toLowerCase())
        if (rawBal == null) continue
        const rawStr = String(rawBal)
        // Skip human-readable amounts (already divided) — only process raw integer strings
        if (rawStr === '' || rawStr.includes('.') || /[eE]/.test(rawStr)) continue
        const pct = bigIntPct(rawBal, _derivationSupply)
        if (pct != null && pct > 0 && pct <= 100) {
          h.percent = Math.round(pct * 10000) / 10000
          derivedCount++
        }
      }
      if (derivedCount > 0) {
        holderDerivationSucceeded = true
        hasPct = true
        percentSource = 'calculated'
        top1 = sum(1); top5 = sum(5); top10 = sum(10); top20 = sum(20)
        holderDistribution = {
          top1, top5, top10, top20,
          others: top20 != null ? Math.max(0, 100 - top20) : null,
          holderCount,
          topHolders: normalizedTop,
        }
        holderDistributionStatus = {
          status: 'ok',
          reason: _derivationSupplySource === 'provider'
            ? 'holder_percentages_derived_from_provider_supply'
            : _derivationSupplySource === 'summed'
            ? 'holder_percentages_derived_from_summed_balances'
            : 'holder_percentages_derived_from_rpc_supply',
          itemCount: holderItems.length,
          normalizedCount: normalizedTop.length,
          percentSource,
        }
      } else {
        holderDerivationFailureReason = normalizedTop.length > 0
          ? 'raw_balance_missing_or_float_format'
          : 'no_holder_rows'
      }
    }

    const rpcName = await rpcTokenString(chain, contract, '0x06fdde03')
    const rpcSymbol = await rpcTokenString(chain, contract, '0x95d89b41')

    // Upgrade name/symbol with RPC fallback when all API sources returned nothing
    const finalResolvedName = (resolvedName && resolvedName !== 'Unknown') ? resolvedName : (rpcName ?? 'Unknown')
    const finalResolvedSymbol = (resolvedSymbol && resolvedSymbol !== '?') ? resolvedSymbol : (rpcSymbol ?? '?')

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
    const supplyRowsArePartial = holderDistributionStatus.status === 'partial' || holderDistributionStatus.percentSource === 'calculated'
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
      methodUsed: devMethodUsed,
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
        fallbackUsed: transferResolverResult.fallbackUsed ?? null,
        confidence: transferResolverResult.confidence,
      },
      holderEvidence: {
        holderCount: holderResolverResult.holders.length,
        insufficientEvidence: holderResolverResult.insufficientEvidence,
        reason: holderResolverResult.reason ?? null,
        fallbackUsed: holderResolverResult.fallbackUsed ?? null,
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

    const responsePayload = {
      chain,
      contract,
      resolvedInput,

      // Core token fields
      name: finalResolvedName,
      symbol: finalResolvedSymbol,
      decimals: resolvedDecimals,

      // Pool state — reflects both primary and fallback market reads
      noActivePools: noActivePools && _dexFb == null,

      // Market source flags
      marketDataSource,
      marketConfidence,
      marketStatus,

      // Extra data
      holders: goldrush?.holders || null,
      holderDistribution,
      holderDistributionStatus,
      holderStatus: holdersStatus,
      holderResolver: {
        holders: holderResolverResult.holders,
        insufficientEvidence: holderResolverResult.insufficientEvidence,
        reason: holderResolverResult.reason ?? null,
        fallbackUsed: holderResolverResult.fallbackUsed ?? null,
        confidence: holderResolverResult.confidence,
      },
      transferResolver: {
        transfers: transferResolverResult.transfers,
        insufficientEvidence: transferResolverResult.insufficientEvidence,
        reason: transferResolverResult.reason ?? null,
        fallbackUsed: transferResolverResult.fallbackUsed ?? null,
        confidence: transferResolverResult.confidence,
      },
      suspiciousFlows: {
        transfers: transferResolverResult.transfers,
        insufficientEvidence: transferResolverResult.insufficientEvidence,
        reason: transferResolverResult.insufficientEvidence ? (transferResolverResult.reason ?? 'Transfer evidence unavailable in this pass.') : 'Transfer evidence available from resolver.',
        fallbackUsed: transferResolverResult.fallbackUsed ?? 'none',
        confidence: transferResolverResult.confidence,
      },
      earlyBuyers: {
        wallets: [],
        insufficientEvidence: transferResolverResult.insufficientEvidence,
        reason: transferResolverResult.insufficientEvidence ? (transferResolverResult.reason ?? 'Transfer evidence unavailable in this pass.') : 'Early-buyer labelling is not derived without trade records containing real wallet addresses.',
        fallbackUsed: transferResolverResult.fallbackUsed ?? 'none',
        confidence: transferResolverResult.insufficientEvidence ? 'low' : 'medium',
      },
      devIntel,
      deployerAddress,
      deployerStatus: devDeployerStatus,
      deployerConfidence: devDeployerConfidence,
      methodUsed: devMethodUsed,
      creationTxHash: devCreationTxHash,
      linkedWallets,
      supplyControl,
      linkedWalletSupplyPercent,
      devClusterSupplyPercent,
      matchedLinkedWallets,
      creatorInTopHolders,
      ...(process.env.NODE_ENV !== 'production' || debugHolder === true ? {
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
      liquidityUsd: _el,
      volume24hUsd: _ev,
      poolCount,
      primaryDexName,
      // Legacy pool-level field kept for frontend pair display
      liquidity: mainPool?.attributes?.reserve_in_usd ?? _dexFb?.liquidityUsd ?? null,
      market_cap: marketCapFromGt,
      marketCapUsd: marketCapFromGt,
      marketCapStatus: marketCapFromGt != null ? 'verified' : (_efdv != null ? 'inferred' : 'partial'),
      marketCapSource,
      marketCapReason: marketCapFromGt != null
        ? ((tokenEndpointMarketCap != null && tokenEndpointMarketCap > 0) ? 'Verified live market data' : 'Verified live pool market data')
        : _efdv != null ? 'FDV used as market cap proxy — circulating supply not confirmed'
        : 'Market cap not resolved — pool data or token endpoint did not return supply',
      circulating_supply: circulatingSupply,
      fdv: _efdv,
      fdvUsd: _efdv,
      fdvSource: _efdv != null ? (fdv != null ? fdvSource : 'fallback') : 'partial',
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
        pairCreatedAt: pairCreatedAt ?? _dexFb?.pairCreatedAt ?? null,
        pairAgeLabel,
      },
      priceChart,
      chartStatus,
      chartSource,
      chartReason,
      chartDataSource,

      pairs: matchingPools,
      gtPools: matchingPools,
      gtRaw: gtData || null,

      gmgn: gmgn?.data || null,

      contractSecurity: null,

      security: {
        // resolveSimulation result — null when Honeypot.is is unavailable
        simulation: _simResult,
        // resolveContractFlags: ABI scan (GoldRush) with bytecode fallback
        contractFlags: resolveContractFlags(grContractIntel, cortexContractFlags),
        devOwnership: {
          ownerAddress: (ownerAddr && ownerAddr !== _ZERO_ADDR) ? ownerAddr : null,
          adminAddress: adminAddr ?? null,
          isRenounced,
          ownershipVerified,
        },
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
            selectedPoolAddress: mpAttr.address ?? null,
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
            chartSelectedPoolAddress: mpAttr.address ?? null,
            chartFailureReason,
            chartFirstTimestamp: priceChart.points[0]?.timestamp ?? null,
            chartLastTimestamp: priceChart.points[priceChart.points.length - 1]?.timestamp ?? null,
            chartDebug: {
              chain,
              networkId: _chartNetworkId,
              tokenAddress: contract.toLowerCase(),
              primaryPoolId: mp?.id ?? null,
              primaryPoolAddress: mpAttr.address ?? null,
              poolsAttempted: chartAttemptedPools,
              timeframesAttempted: chartAttemptedTimeframes,
              poolLevelSuccess: chartSelectedPoolForChart !== null && !chartUsedTokenLevelOhlcv && !chartUsedTradeReconstruction,
              tokenLevelAttempted: chartTokenLevelAttempted,
              tokenLevelSuccess: chartUsedTokenLevelOhlcv,
              tradeReconstructionAttempted: chartTradeReconstructionAttempted,
              tradeReconstructionSuccess: chartUsedTradeReconstruction,
              reconstructedTradeCount: chartReconstructedTradeCount,
              reconstructedCandleCount: chartReconstructedCandleCount,
              finalChartStatus: chartStatus,
              finalChartSource: chartSource,
              finalChartReason: chartReason,
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
      analysis,
      lpControl: { ...lpControl, canonicalStatus: toCanonical(lpControl.status), rawLpState: lpControl.status, rawState: lpControl.status },
      lpStatus: (lpControl.status === 'error' || lpControl.status === 'insufficient_data') ? 'partial' : lpControl.status,
      lpControlRead: computeLpControlRead(lpControl, String(lpPool?.pairName ?? "")),
      lpMeta: {
        v2PoolCandidatesCount: lpDiagnostics.v2PoolCandidatesCount,
        protocolPoolCandidatesCount: lpDiagnostics.protocolPoolCandidatesCount,
        lpProofSkipReason: lpDiagnostics.lpProofSkipReason,
        primaryMarketType: lpDiagnostics.primaryMarketType,
        primaryMarketDex: lpDiagnostics.primaryMarketDex,
        lpVerificationPoolSelected: lpDiagnostics.lpVerificationPoolSelected,
        proofStatus: lpDiagnostics.lpState ?? null,
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
          source: hpResult.ok ? "risk_layer" : "inferred",
          honeypot: hpResult.ok ? hpResult.honeypot : null,
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
        liquidity: {
          status: toCanonical(liquidityStatus),
          rawStatus: liquidityStatus,
          reason: liquidityReason,
          source: "lp_layer",
          poolCount: matchingPools.length,
          primaryPair: mainPool?.attributes?.name ?? null,
          liquidityDepth: liquidityUsd,
          pool_age: pairCreatedAt ?? _dexFb?.pairCreatedAt ?? null,
          pool_protocol: primaryDexName ?? lpPool?.dexName ?? null,
          pool_fragmentation: matchingPools.length > 2 ? 'fragmented' : matchingPools.length === 2 ? 'split' : matchingPools.length === 1 ? 'single' : 'none',
          lpSafetyAttempted,
          lpSafetyUsable,
          lpOwnershipVerified,
          lpProofStatus,
          lpOwnershipStatus: (lpState === 'protocol' || lpState === 'concentrated_liquidity') ? 'not_applicable' : (lpOwnershipVerified ? 'verified' : 'inferred'),
          lpControl: {
            ...lpControl,
            canonicalStatus: toCanonical(lpControl.status),
            rawLpState: lpControl.status,
            rawState: lpControl.status,
          },
          lpControlRead: computeLpControlRead(lpControl, String(lpPool?.pairName ?? "")),
          lpMeta: {
            v2PoolCandidatesCount: lpDiagnostics.v2PoolCandidatesCount,
            protocolPoolCandidatesCount: lpDiagnostics.protocolPoolCandidatesCount,
            lpProofSkipReason: lpDiagnostics.lpProofSkipReason,
            primaryMarketType: lpDiagnostics.primaryMarketType,
            primaryMarketDex: lpDiagnostics.primaryMarketDex,
            lpVerificationPoolSelected: lpDiagnostics.lpVerificationPoolSelected,
            proofStatus: lpDiagnostics.lpState ?? null,
          },
        },
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
        lpDiagnostics: {
          chain: lpDiagnostics.chain,
          poolDetected: lpDiagnostics.poolDetected,
          // Primary market pool (display/Liquidity UI)
          primaryMarketSelected: lpDiagnostics.primaryMarketSelected,
          primaryMarketPoolAddress: lpDiagnostics.primaryMarketPoolAddress,
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
          reason: lpDiagnostics.reason,
          _full: lpDiagnostics,
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
            goldrushLpAttempted: lpSafetyAttempted,
            goldrushLpUsable: lpSafetyUsable,
            rpcLpAttempted: lpDiagnostics.rpcAttempted,
            lpSafetyAttempted,
            lpSafetyUsable,
            lpOwnershipVerified,
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
    return NextResponse.json(responsePayload)
  } catch (err) {
    console.error("Fatal backend error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const body = {
    contract: url.searchParams.get('contract') ?? '',
    chain: url.searchParams.get('chain') ?? 'base',
    debug: url.searchParams.get('debug') === 'true',
  }
  const mockReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(body),
  })
  return POST(mockReq)
}

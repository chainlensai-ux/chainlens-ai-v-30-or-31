import { NextResponse } from 'next/server'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { type CanonicalStatus, toCanonical } from '@/lib/canonicalStatus'
import { buildClusterMap } from '@/lib/clusterMap'
import { logRpcCall } from '@/lib/server/rpcDebug'
import { auditGlobalAlchemyCall } from '@/lib/server/globalRpcAudit'

const COVALENT_BASE_URL = 'https://api.covalenthq.com/v1'
function resolveBaseRpcUrl(): string | null {
  const explicit = process.env.ALCHEMY_BASE_RPC_URL || process.env.BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY || process.env.ALCHEMY_API_KEY
  if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
  return null
}


type SupportedChain = 'base' | 'eth'

type ChainConfig = { chain: SupportedChain; chainLabel: 'Base' | 'Ethereum'; chainId: '8453' | '1'; covalentChain: 'base-mainnet' | 'eth-mainnet'; explorerHost: string; rpcUrl: string | null }

function resolveEthRpcUrl(): string | null {
  const explicit = process.env.ALCHEMY_ETH_RPC_URL || process.env.ETH_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_ETHEREUM_KEY || process.env.ALCHEMY_ETH_KEY || process.env.ALCHEMY_API_KEY
  if (key) return `https://eth-mainnet.g.alchemy.com/v2/${key}`
  return null
}

function getChainConfig(chain: SupportedChain): ChainConfig {
  return chain === 'eth'
    ? { chain: 'eth', chainLabel: 'Ethereum', chainId: '1', covalentChain: 'eth-mainnet', explorerHost: 'etherscan.io', rpcUrl: resolveEthRpcUrl() }
    : { chain: 'base', chainLabel: 'Base', chainId: '8453', covalentChain: 'base-mainnet', explorerHost: 'basescan.org', rpcUrl: resolveBaseRpcUrl() }
}
let activeChainConfig: ChainConfig = getChainConfig('base')
const CREATOR_LOOKUP_BASE_URL = 'https://api.etherscan.io/v2/api'
const CREATOR_LOOKUP_CHAIN_ID = () => activeChainConfig.chainId
const CREATOR_LOOKUP_TIMEOUT_MS = 3000
const CREATOR_LOOKUP_RPS_LIMIT = 2
const CREATOR_LOOKUP_WINDOW_MS = 1000
const CREATOR_CACHE_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CREATOR_CACHE_NOT_FOUND_TTL_MS = 12 * 60 * 60 * 1000
const CREATOR_CACHE_ERROR_TTL_MS = 10 * 60 * 1000
const DEV_CACHE_TTL_MS = 3 * 60 * 1000
const META_CACHE_TTL_MS = 60 * 60 * 1000
const devCache = new Map<string, { exp: number; payload: unknown }>()
const metaCache = new Map<string, { exp: number; data: { name: string | null; symbol: string | null; decimals: number | null } }>()
const devRate = new Map<string, { count: number; resetAt: number; lastAt: number }>()
const creatorLookupCache = new Map<string, {
  exp: number
  data: {
    address: string | null
    confidence: 'high' | 'medium' | 'low'
    methodUsed: 'contract_creation_lookup' | 'unknown'
    creationTxHash: string | null
    reason?: string
  }
}>()
const creatorLookupInFlight = new Map<string, Promise<{
  address: string | null
  confidence: 'high' | 'medium' | 'low'
  methodUsed: 'contract_creation_lookup' | 'unknown'
  creationTxHash: string | null
  reason?: string
  httpStatus?: number | null
  localRateLimited?: boolean
  cacheHit?: boolean
  attempted: boolean
  ok: boolean
}>>()
const creatorLookupRateWindow: number[] = []
const DEV_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 4, pro: 15, elite: 30 }
const DEV_COOLDOWN_MS: Record<'free' | 'pro' | 'elite', number> = { free: 25_000, pro: 8_000, elite: 4_000 }

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'

// Known burn wallets, DEX routers, WETH, and pool factories excluded from
// deployer/linked-wallet evidence. Keep chain-specific infra separate so ETH
// checks do not inherit Base-only assumptions.
const COMMON_INFRA_EXCLUSIONS = new Set([
  ZERO_ADDRESS,
  DEAD_ADDRESS,
  '0x0000000000000000000000000000000000000001',
])
const BASE_INFRA_EXCLUSIONS = new Set([
  '0x4200000000000000000000000000000000000006', // WETH Base
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', // Uniswap Universal Router
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap SwapRouter02
  '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', // Uniswap V3 Position Manager Base
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', // Aerodrome Router
  '0x420dd381b31aef6683db6b902084cb0ffece40da', // Aerodrome Factory
])
const ETH_INFRA_EXCLUSIONS = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH Ethereum
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 Router02
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', // Uniswap Universal Router
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uniswap SwapRouter02
  '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 SwapRouter
  '0xc36442b4a4522e871399cd717abdd847ab11fe88', // Uniswap V3 Position Manager
  '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', // Uniswap V2 Factory
  '0x1f98431c8ad98523631ae4a59f267346ea31f984', // Uniswap V3 Factory
  '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
])

function chainInfraExclusions(): Set<string> {
  return new Set([
    ...COMMON_INFRA_EXCLUSIONS,
    ...(activeChainConfig.chain === 'eth' ? ETH_INFRA_EXCLUSIONS : BASE_INFRA_EXCLUSIONS),
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
  return normalized === tokenLow || chainInfraExclusions().has(normalized)
}

function isValidOriginCandidate(value: string | null | undefined, tokenContract: string): value is string {
  return !isRejectedEvidenceAddress(value, tokenContract)
}

interface PlanResolution {
  rawPlan: 'free' | 'pro' | 'elite'
  effectivePlan: 'free' | 'pro' | 'elite'
  trialActive: boolean
  trialEndsAt: string | null
  isProOrElite: boolean
  gateDecision: 'allow' | 'deny'
  authSource: 'bearer' | 'none'
  plan: 'free' | 'pro' | 'elite'
  hasBearer: boolean
  userPresent: boolean
  userId: string | null
  settingsRowFound: boolean
  planSource: 'user_settings' | 'fallback'
}

async function resolveServerPlan(req: Request): Promise<PlanResolution> {
  const auth = req.headers.get('authorization') ?? ''
  const hasBearer = auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim().length > 0
  if (!hasBearer) return {
    rawPlan: 'free', effectivePlan: 'free', trialActive: false, trialEndsAt: null,
    isProOrElite: false, gateDecision: 'deny', authSource: 'none', plan: 'free',
    hasBearer: false, userPresent: false, userId: null, settingsRowFound: false, planSource: 'fallback',
  }
  const token = auth.slice(7).trim()
  try {
    const result = await getCurrentUserPlanFromBearerToken(token)
    const isProOrElite = result.plan === 'pro' || result.plan === 'elite'
    return {
      rawPlan: result.rawPlan, effectivePlan: result.plan, trialActive: result.trialActive,
      trialEndsAt: result.trialEndsAt, isProOrElite, gateDecision: isProOrElite ? 'allow' : 'deny',
      authSource: 'bearer', plan: result.plan, hasBearer: true,
      userPresent: result.userId !== null, userId: result.userId ?? null,
      settingsRowFound: result.settingsRowFound,
      planSource: result.settingsRowFound ? 'user_settings' : 'fallback',
    }
  } catch {
    return {
      rawPlan: 'free', effectivePlan: 'free', trialActive: false, trialEndsAt: null,
      isProOrElite: false, gateDecision: 'deny', authSource: 'bearer', plan: 'free',
      hasBearer: true, userPresent: false, userId: null, settingsRowFound: false, planSource: 'fallback',
    }
  }
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
  rawContract?: { address?: string | null }
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

interface MatchedHolder {
  address: string
  supplyPct: number
  isDeployer: boolean
  isLinked: boolean
}
interface HolderRowInput {
  address?: string
  percent?: number | null
  amount?: string | number | null
  balance?: string | number | null
}
interface HolderPercentDerivationResult {
  holderDistribution: {
    top1: number | null
    top10: number | null
    top20: number | null
    holderCount: number | null
    topHolders: Array<{ address: string; percent: number | null }>
  } | null
  holderDistributionStatus: 'ok' | 'partial' | 'unavailable_with_reason'
  holderStatusReason?: string
  holderPercentAvailable: boolean
  holderPercentSource: string | null
  debug: Record<string, unknown>
}

interface PreviousProject {
  contractAddress: string
  name: string | null
  symbol: string | null
  createdAt: string | null
  rugFlag: boolean | null
  rugReason: string | null
}

interface ClarkVerdict {
  label: 'TRUSTWORTHY' | 'WATCH' | 'AVOID' | 'UNKNOWN' | 'SCAN DEEPER'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  keySignals: string[]
  risks: string[]
  nextAction: string
}

interface VerdictSignalInput {
  deployerAddress: string | null
  deployerConfidence: 'high' | 'medium' | 'low'
  linkedWallets: LinkedWallet[]
  suspiciousTransfers: boolean
  holderDataAvailable: boolean
  supplyControlled: number | null
  securityDataAvailable: boolean
  liquidityDataAvailable: boolean
  honeypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  lpLocked: boolean | null
  lpLockDataAvailable: boolean
  lpHolderConcentration: number | null
  lpHolderDataAvailable: boolean
}

// ─── Origin Discovery ──────────────────────────────────────────────────────

interface OriginDiagModule {
  attempted: boolean
  ok: boolean
  reason: string
  httpStatus?: number
  candidateAddress?: string | null
  txHashPresent?: boolean
  itemCount?: number
  confidence?: string
}

interface OriginDiscoveryDiag {
  optional_creation_lookup: OriginDiagModule
  contract_transaction_history: OriginDiagModule
  initial_token_flow_signal: OriginDiagModule
  rpc_fallback: OriginDiagModule
  selected_origin_candidate: {
    methodUsed: string
    address: string | null
    confidence: string
    deployerStatus: string
  }
}

interface OriginCandidate {
  address: string | null
  confidence: 'high' | 'medium' | 'low'
  deployerStatus: 'confirmed' | 'possible_match' | 'not_confirmed'
  methodUsed: string
  creationTxHash: string | null
  reason: string
}

type CovalentTxItem = {
  tx_hash: string
  block_height: number
  block_signed_at: string
  successful: boolean
  from_address: string
  to_address: string | null
}

async function alchemyRpc(method: string, params: unknown[]): Promise<unknown> {
  if (!activeChainConfig.rpcUrl) throw new Error('rpc_not_configured')
  logRpcCall({ route: '/api/dev-wallet', chain: activeChainConfig.chain, method })
  // Only audit as an Alchemy call when the resolved URL actually is one — resolveBaseRpcUrl/
  // resolveEthRpcUrl can also return an explicit ALCHEMY_*_RPC_URL/*_RPC_URL override pointed at a
  // non-Alchemy provider.
  if (activeChainConfig.rpcUrl.includes('g.alchemy.com')) {
    auditGlobalAlchemyCall(method, { chain: activeChainConfig.chain, route: '/api/dev-wallet', params })
  }
  const res = await fetch(activeChainConfig.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Alchemy RPC ${res.status}`)
  const json = await res.json() as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(`Alchemy: ${json.error.message}`)
  return json.result
}
function decodeHexStringResult(hex: string): string | null {
  if (!hex || hex === '0x') return null
  try {
    const clean = hex.slice(2)
    if (clean.length >= 128) {
      const len = parseInt(clean.slice(64, 128), 16)
      const data = clean.slice(128, 128 + len * 2)
      const str = Buffer.from(data, 'hex').toString('utf8').replace(/\0/g, '').trim()
      return str || null
    }
    const str = Buffer.from(clean, 'hex').toString('utf8').replace(/\0/g, '').trim()
    return str || null
  } catch { return null }
}
async function fetchTokenMetadata(contract: string, marketData?: Record<string, unknown> | null): Promise<{ name: string | null; symbol: string | null; decimals: number | null; diag: Record<string, unknown> }> {
  const key = `${activeChainConfig.chain}:${contract}`
  const cached = metaCache.get(key)
  if (cached && cached.exp > Date.now()) return { ...cached.data, diag: { chain: activeChainConfig.chain, attempted: true, nameFound: Boolean(cached.data.name), symbolFound: Boolean(cached.data.symbol), source: 'cache', cacheHit: true, reason: 'ok' } }
  const sectionMeta = (marketData?.sections as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined
  let name =
    (typeof marketData?.name === 'string' ? marketData.name : null) ??
    (typeof sectionMeta?.name === 'string' ? sectionMeta.name : null)
  let symbol =
    (typeof marketData?.symbol === 'string' ? marketData.symbol : null) ??
    (typeof sectionMeta?.symbol === 'string' ? sectionMeta.symbol : null)
  let decimals: number | null = null
  const providersCalled: string[] = []
  const providersFailed: string[] = []
  let source = name || symbol ? 'token_api' : 'rpc'
  if (name || symbol) providersCalled.push('token_api')
  if (activeChainConfig.chain === 'base') {
    providersCalled.push('dexscreener')
    try {
      const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${contract}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        const json = await res.json() as Array<Record<string, unknown>>
        const pair = Array.isArray(json) ? json.find((p) => {
          const bt = (p.baseToken as Record<string, unknown> | undefined)?.address
          const qt = (p.quoteToken as Record<string, unknown> | undefined)?.address
          const c = contract.toLowerCase()
          return String(bt ?? '').toLowerCase() === c || String(qt ?? '').toLowerCase() === c
        }) : null
        const bt = pair?.baseToken as Record<string, unknown> | undefined
        if (!name && typeof bt?.name === 'string' && bt.name.trim()) name = bt.name.trim()
        if (!symbol && typeof bt?.symbol === 'string' && bt.symbol.trim()) symbol = bt.symbol.trim()
        if ((name || symbol) && source === 'rpc') source = 'dexscreener'
      } else providersFailed.push(`dexscreener_http_${res.status}`)
    } catch {
      providersFailed.push('dexscreener_error')
    }
    if (!name || !symbol) {
      providersCalled.push('basescan')
      const scanKey = process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY
      if (scanKey) {
        try {
          const scanRes = await fetch(`https://api.basescan.org/api?module=token&action=tokeninfo&contractaddress=${contract}&apikey=${scanKey}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
          if (scanRes.ok) {
            const scanJson = await scanRes.json() as { result?: Array<Record<string, unknown>> }
            const t = scanJson?.result?.[0]
            if (!name && typeof t?.tokenName === 'string' && t.tokenName.trim()) name = t.tokenName.trim()
            if (!symbol && typeof t?.symbol === 'string' && t.symbol.trim()) symbol = t.symbol.trim()
            if ((name || symbol) && source === 'rpc') source = 'basescan'
          } else providersFailed.push(`basescan_http_${scanRes.status}`)
        } catch {
          providersFailed.push('basescan_error')
        }
      } else providersFailed.push('basescan_missing_key')
    }
  }
  try {
    const [n, s, d] = await Promise.all([
      alchemyRpc('eth_call', [{ to: contract, data: '0x06fdde03' }, 'latest']) as Promise<string>,
      alchemyRpc('eth_call', [{ to: contract, data: '0x95d89b41' }, 'latest']) as Promise<string>,
      alchemyRpc('eth_call', [{ to: contract, data: '0x313ce567' }, 'latest']) as Promise<string>,
    ])
    name = name ?? decodeHexStringResult(n)
    symbol = symbol ?? decodeHexStringResult(s)
    if (d && d !== '0x') decimals = parseInt(d, 16)
  } catch {}
  if (!name || !symbol) {
    providersCalled.push('goldrush_metadata')
    const grKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
    if (grKey) {
      try {
        logRpcCall({ route: '/api/dev-wallet', chain: activeChainConfig.covalentChain, method: 'goldrush_balances_v2' })
        const grRes = await fetch(`https://api.covalenthq.com/v1/${activeChainConfig.covalentChain}/address/0x0000000000000000000000000000000000000000/balances_v2/?contract-address=${contract}`, {
          headers: { Authorization: `Bearer ${grKey}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(6000),
        })
        if (grRes.ok) {
          const grJson = await grRes.json() as { data?: { items?: Array<Record<string, unknown>> } }
          const first = grJson?.data?.items?.[0]
          if (!name && typeof first?.contract_name === 'string' && first.contract_name.trim()) name = first.contract_name.trim()
          if (!symbol && typeof first?.contract_ticker_symbol === 'string' && first.contract_ticker_symbol.trim()) symbol = first.contract_ticker_symbol.trim()
          if ((name || symbol) && source === 'rpc') source = 'goldrush'
        } else providersFailed.push(`goldrush_http_${grRes.status}`)
      } catch {
        providersFailed.push('goldrush_error')
      }
    } else providersFailed.push('goldrush_missing_key')
  }
  const out = { name, symbol, decimals }
  metaCache.set(key, { exp: Date.now() + META_CACHE_TTL_MS, data: out })
  return { ...out, diag: { chain: activeChainConfig.chain, attempted: true, nameFound: Boolean(name), symbolFound: Boolean(symbol), source, cacheHit: false, reason: 'ok', metadataSource: source, providersCalled, providersFailed, finalResolvedName: name, finalResolvedSymbol: symbol } }
}

async function getAssetTransfers(params: Record<string, unknown>): Promise<AlchemyTransfer[]> {
  if (!activeChainConfig.rpcUrl) return []
  const transfers: AlchemyTransfer[] = []
  let pageKey: string | undefined
  for (let page = 0; page < 3; page++) {
    try {
      const pageParams = pageKey ? { ...params, pageKey } : params
      const result = await alchemyRpc('alchemy_getAssetTransfers', [pageParams]) as { transfers?: AlchemyTransfer[]; pageKey?: string }
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

async function getContractAddressFromTx(txHash: string): Promise<string | null> {
  try {
    const result = await alchemyRpc('eth_getTransactionReceipt', [txHash]) as { contractAddress?: string | null } | null
    const addr = result?.contractAddress ?? ''
    return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr.toLowerCase() : null
  } catch {
    return null
  }
}

async function discoverOrigin(contract: string): Promise<{
  candidate: OriginCandidate
  diag: OriginDiscoveryDiag
}> {
  const diag: OriginDiscoveryDiag = {
    optional_creation_lookup: { attempted: false, ok: false, reason: 'skipped' },
    contract_transaction_history: { attempted: false, ok: false, reason: 'skipped' },
    initial_token_flow_signal: { attempted: false, ok: false, reason: 'skipped' },
    rpc_fallback: { attempted: false, ok: false, reason: 'skipped' },
    selected_origin_candidate: { methodUsed: 'unknown', address: null, confidence: 'low', deployerStatus: 'not_confirmed' },
  }
  const ZERO = ZERO_ADDRESS

  function finalize(c: OriginCandidate): { candidate: OriginCandidate; diag: OriginDiscoveryDiag } {
    diag.selected_origin_candidate = { methodUsed: c.methodUsed, address: c.address, confidence: c.confidence, deployerStatus: c.deployerStatus }
    return { candidate: c, diag }
  }

  // 1. Optional paid creation lookup (Basescan for Base, Etherscan v2 for ETH)
  const scanKey = activeChainConfig.chain === 'eth'
    ? process.env.ETHERSCAN_API_KEY
    : (process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY)
  if (scanKey) {
    diag.optional_creation_lookup.attempted = true
    try {
      const scanUrl = activeChainConfig.chain === 'eth'
        ? `${CREATOR_LOOKUP_BASE_URL}?chainid=${CREATOR_LOOKUP_CHAIN_ID()}&module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${scanKey}`
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

  // 2. GoldRush/Covalent contract transaction history (ascending sort = earliest first)
  const covalentKey = process.env.COVALENT_API_KEY
  if (covalentKey) {
    diag.contract_transaction_history.attempted = true
    try {
      logRpcCall({ route: '/api/dev-wallet', chain: activeChainConfig.covalentChain, method: 'goldrush_contract_transactions_v2' })
      const txRes = await fetch(
        `${COVALENT_BASE_URL}/${activeChainConfig.covalentChain}/address/${contract}/transactions_v2/?page-size=5&block-signed-at-asc=true&no-logs=true`,
        { headers: { Authorization: `Bearer ${covalentKey}` }, cache: 'no-store', signal: AbortSignal.timeout(10000) }
      )
      diag.contract_transaction_history.httpStatus = txRes.status
      if (txRes.ok) {
        const txJson = await txRes.json() as { data?: { items?: CovalentTxItem[] } }
        const txItems = txJson?.data?.items ?? []
        diag.contract_transaction_history.itemCount = txItems.length

        // Contract creation tx: to_address is null or empty string
        const creationTx = txItems.find(t => t.successful && (t.to_address === null || t.to_address === ''))
        if (creationTx?.from_address && isValidOriginCandidate(creationTx.from_address, contract)) {
          const creator = creationTx.from_address.toLowerCase()
          diag.contract_transaction_history.ok = true
          diag.contract_transaction_history.reason = 'creation_tx_found'
          diag.contract_transaction_history.candidateAddress = creator
          diag.contract_transaction_history.txHashPresent = true
          diag.contract_transaction_history.confidence = 'high'
          return finalize({ address: creator, confidence: 'high', deployerStatus: 'confirmed', methodUsed: 'transaction_creation_record', creationTxHash: creationTx.tx_hash, reason: 'Contract deployment transaction identified in indexed history' })
        }

        // Earliest successful tx from a valid external sender
        const earliestTx = txItems.find(
          t => t.successful && t.from_address && isValidOriginCandidate(t.from_address, contract)
        )
        if (earliestTx?.from_address) {
          const origin = earliestTx.from_address.toLowerCase()
          diag.contract_transaction_history.ok = true
          diag.contract_transaction_history.reason = 'earliest_contract_activity'
          diag.contract_transaction_history.candidateAddress = origin
          diag.contract_transaction_history.txHashPresent = true
          diag.contract_transaction_history.confidence = 'medium'
          return finalize({ address: origin, confidence: 'medium', deployerStatus: 'possible_match', methodUsed: 'earliest_contract_activity', creationTxHash: earliestTx.tx_hash, reason: 'Earliest indexed contract activity; not confirmed creator' })
        }
        diag.contract_transaction_history.reason = txItems.length === 0 ? 'no_items' : 'no_valid_candidate'
      } else {
        diag.contract_transaction_history.reason = `http_${txRes.status}`
      }
    } catch (e) {
      diag.contract_transaction_history.reason = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'fetch_error'
    }
  }

  // 3. Initial token flow: first mint from zero address (ERC-20 Transfer from 0x0)
  diag.initial_token_flow_signal.attempted = true
  const mintTransfers = await getAssetTransfers({
    fromBlock: '0x0', toBlock: 'latest',
    category: ['erc20'], contractAddresses: [contract],
    fromAddress: ZERO, order: 'asc', maxCount: '0x64', withMetadata: true,
  })
  const firstMint = mintTransfers.find(t => t.to && isValidOriginCandidate(t.to, contract))
  if (firstMint?.to) {
    diag.initial_token_flow_signal.ok = true
    diag.initial_token_flow_signal.reason = 'first_mint_recipient'
    diag.initial_token_flow_signal.candidateAddress = firstMint.to.toLowerCase()
    diag.initial_token_flow_signal.confidence = 'medium'
    return finalize({ address: firstMint.to.toLowerCase(), confidence: 'medium', deployerStatus: 'possible_match', methodUsed: 'initial_token_flow_signal', creationTxHash: firstMint.hash ?? null, reason: 'First mint recipient from token transfer events; not confirmed creator' })
  }
  diag.initial_token_flow_signal.reason = 'no_mint_transfers'

  // 4. RPC fallback: earliest ERC-20 transfer participant, then first incoming ETH
  diag.rpc_fallback.attempted = true
  const earliestErc20 = await getAssetTransfers({
    fromBlock: '0x0', toBlock: 'latest',
    category: ['erc20'], contractAddresses: [contract],
    order: 'asc', maxCount: '0x32', withMetadata: true,
  })
  const firstErc20 = earliestErc20.find(t => isValidOriginCandidate(t.from, contract) || isValidOriginCandidate(t.to, contract))
  if (firstErc20) {
    const addr = (isValidOriginCandidate(firstErc20.from, contract) ? firstErc20.from : firstErc20.to) ?? null
    if (isValidOriginCandidate(addr, contract)) {
      diag.rpc_fallback.ok = true
      diag.rpc_fallback.reason = 'earliest_erc20_transfer'
      diag.rpc_fallback.candidateAddress = addr.toLowerCase()
      diag.rpc_fallback.confidence = 'low'
      return finalize({ address: addr.toLowerCase(), confidence: 'low', deployerStatus: 'possible_match', methodUsed: 'earliest_transfer', creationTxHash: null, reason: 'Earliest ERC-20 transfer participant; not confirmed creator' })
    }
  }

  const incomingExt = await getAssetTransfers({
    fromBlock: '0x0', toBlock: 'latest', toAddress: contract,
    category: ['external'], order: 'asc', maxCount: '0x5', withMetadata: true,
  })
  const firstExt = incomingExt.find(t => t.from && isValidOriginCandidate(t.from, contract))
  if (firstExt?.from) {
    diag.rpc_fallback.ok = true
    diag.rpc_fallback.reason = 'first_incoming_external'
    diag.rpc_fallback.candidateAddress = firstExt.from.toLowerCase()
    diag.rpc_fallback.confidence = 'low'
    return finalize({ address: firstExt.from.toLowerCase(), confidence: 'low', deployerStatus: 'possible_match', methodUsed: 'earliest_external_activity', creationTxHash: null, reason: 'First external ETH transfer to contract; not confirmed creator' })
  }

  diag.rpc_fallback.reason = 'no_transfers_found'
  return finalize({ address: null, confidence: 'low', deployerStatus: 'not_confirmed', methodUsed: 'unknown', creationTxHash: null, reason: 'No origin candidate found from any available source' })
}

async function findLinkedWallets(
  deployer: string,
  tokenContract: string,
): Promise<{
  wallets: LinkedWallet[]
  status: 'ok' | 'none_found' | 'limited_check' | 'skipped'
  diag: LinkedWalletDiag
}> {
  const deployerLow = deployer.toLowerCase()
  const tokenLow = tokenContract.toLowerCase()
  const excluded = new Set([...chainInfraExclusions(), deployerLow, tokenLow])

  const diag: LinkedWalletDiag = {
    attempted: true, ok: false,
    tokenTransfersFound: 0, ethTransfersFound: 0,
    totalCandidates: 0, reason: '',
  }
  if (!activeChainConfig.rpcUrl) {
    diag.reason = 'rpc_not_configured'
    return { wallets: [], status: 'limited_check', diag }
  }

  // Run both queries concurrently: token-specific supply transfers + ETH funding transfers
  const [tokenTransfers, ethTransfers] = await Promise.all([
    // Query 1: specific-token ERC-20 transfers from deployer (supply distribution)
    getAssetTransfers({
      fromBlock: '0x0', toBlock: 'latest',
      fromAddress: deployer,
      category: ['erc20'],
      contractAddresses: [tokenContract],
      order: 'asc',
      maxCount: '0x64',
      withMetadata: true,
    }),
    // Query 2: external ETH transfers from deployer (wallet funding)
    getAssetTransfers({
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

  // Token supply transfers → medium confidence (upgraded to high after top-holder overlap check)
  for (const t of tokenTransfers) {
    const to = t.to?.toLowerCase()
    if (!to || excluded.has(to) || !normalizeEvidenceAddress(to)) continue
    if (!walletMap.has(to)) {
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
      const w = walletMap.get(to)!
      w.amountReceived = (w.amountReceived ?? 0) + (t.value ?? 0)
      const existingTs = w.firstSeen ? new Date(w.firstSeen).getTime() : Infinity
      const nextTs = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : Infinity
      if (nextTs < existingTs) {
        w.firstSeen = t.metadata?.blockTimestamp ?? w.firstSeen
        w.txHash = t.hash ?? w.txHash
      }
    }
  }

  // ETH funding transfers → low confidence (only added if not already found via token)
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
    // Already in map from token transfer → keep higher-confidence entry
  }

  diag.totalCandidates = walletMap.size
  const wallets = [...walletMap.values()].slice(0, 20)

  if (tokenTransfers.length === 0 && ethTransfers.length === 0) {
    diag.reason = 'no_transfers_found'
    return { wallets: [], status: 'limited_check', diag }
  }

  diag.ok = true
  diag.reason = wallets.length > 0 ? 'wallets_found' : 'transfers_checked_none_qualify'
  return {
    wallets,
    status: wallets.length > 0 ? 'ok' : 'none_found',
    diag,
  }
}

async function getSupplyData(
  contract: string,
  deployer: string | null,
  linkedWallets: LinkedWallet[],
  preloadedTopHolders?: Array<{ address?: string; percent?: number | null }>,
  scannerDataProvided?: boolean,
): Promise<{
  holderDataAvailable: boolean
  supplyControlled: number | null
  matchedHolderWallets: MatchedHolder[]
  holderStats?: { top1: number | null; top10: number | null; top20: number | null; holderCount: number | null; creatorInTopHolders: boolean; linkedWalletSupply: number | null; devClusterSupply: number | null }
  diag?: Record<string, unknown>
}> {
  const linkedSet = new Set(linkedWallets.map(w => w.address.toLowerCase()))

  // When scanner explicitly provided holder data (even an empty array), use it directly
  // and skip the GoldRush API fallback to avoid redundant calls that also fail without a key.
  if (scannerDataProvided || (preloadedTopHolders && preloadedTopHolders.length > 0)) {
    const holders = preloadedTopHolders ?? []
    if (!deployer && linkedSet.size === 0) {
      return { holderDataAvailable: holders.length > 0, supplyControlled: null, matchedHolderWallets: [], holderStats: { top1: null, top10: null, top20: null, holderCount: holders.length, creatorInTopHolders: false, linkedWalletSupply: null, devClusterSupply: null } }
    }
    const matched: MatchedHolder[] = []
    let controlled = 0
    for (const h of holders) {
      const addr = (h.address ?? '').toLowerCase()
      if (!addr) continue
      const isDeployer = deployer ? addr === deployer.toLowerCase() : false
      const isLinked = linkedSet.has(addr)
      if (!isDeployer && !isLinked) continue
      const pct = typeof h.percent === 'number' ? h.percent : 0
      controlled += pct
      matched.push({ address: addr, supplyPct: pct, isDeployer, isLinked })
    }
    const top = holders.map(h => (typeof h.percent === 'number' ? h.percent : 0))
    const actorsChecked = Boolean(deployer || linkedSet.size > 0)
    const roundedControlled = Math.round(controlled * 100) / 100
    return {
      holderDataAvailable: holders.length > 0,
      supplyControlled: actorsChecked && holders.length > 0 ? roundedControlled : null,
      matchedHolderWallets: matched.sort((a, b) => b.supplyPct - a.supplyPct),
      holderStats: {
        top1: top[0] ?? null, top10: top.slice(0, 10).reduce((a, b) => a + b, 0) || null, top20: top.slice(0, 20).reduce((a, b) => a + b, 0) || null,
        holderCount: holders.length, creatorInTopHolders: matched.some(m => m.isDeployer), linkedWalletSupply: actorsChecked && holders.length > 0 ? matched.filter(m => m.isLinked).reduce((a, b) => a + b.supplyPct, 0) : null, devClusterSupply: actorsChecked && holders.length > 0 ? roundedControlled : null,
      },
    }
  }

  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  if (!apiKey) {
    return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [], diag: { provider: 'goldrush', chainUsed: activeChainConfig.covalentChain, attempted: false, hasApiKey: false, holderRowsCount: 0, percentAvailable: false, creatorRowFound: false, linkedWalletComputed: false, devClusterComputed: false, reason: 'missing_api_key' } }
  }

  try {
    logRpcCall({ route: '/api/dev-wallet', chain: activeChainConfig.covalentChain, method: 'goldrush_token_holders_v2' })
    const res = await fetch(
      `${COVALENT_BASE_URL}/${activeChainConfig.covalentChain}/tokens/${contract}/token_holders_v2/?page-size=50`,
      { cache: 'no-store', signal: AbortSignal.timeout(9000), headers: { Authorization: `Bearer ${apiKey}` } }
    )
    if (!res.ok) return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [], diag: { provider: 'goldrush', chainUsed: activeChainConfig.covalentChain, attempted: true, hasApiKey: true, statusCode: res.status, holderRowsCount: 0, percentAvailable: false, creatorRowFound: false, linkedWalletComputed: false, devClusterComputed: false, reason: 'http_error' } }

    const json = await res.json() as {
      data?: {
        items?: Array<{ address: string; balance: string; total_supply?: string }>
      }
    }

    const items = json?.data?.items ?? []
    if (items.length === 0) return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [], diag: { provider: 'goldrush', chainUsed: activeChainConfig.covalentChain, attempted: true, hasApiKey: true, statusCode: res.status, holderRowsCount: 0, rawItemCount: 0, percentAvailable: false, creatorRowFound: false, linkedWalletComputed: false, devClusterComputed: false, reason: 'no_items' } }

    const totalSupplyRaw = items[0]?.total_supply ?? '0'
    const totalSupply = BigInt(totalSupplyRaw === '' ? '0' : totalSupplyRaw)

    const matched: MatchedHolder[] = []
    let controlled = 0

    for (const item of items) {
      const addr = (item.address ?? '').toLowerCase()
      const isDeployer = deployer ? addr === deployer.toLowerCase() : false
      const isLinked = linkedSet.has(addr)
      if (!isDeployer && !isLinked) continue

      let pct = 0
      if (totalSupply > BigInt(0)) {
        const bal = BigInt(item.balance ?? '0')
        pct = Number((bal * BigInt(10000)) / totalSupply) / 100
      }

      controlled += pct
      matched.push({ address: addr, supplyPct: pct, isDeployer, isLinked })
    }

    const pcts = items.map(item => totalSupply > BigInt(0) ? Number((BigInt(item.balance ?? '0') * BigInt(10000)) / totalSupply) / 100 : 0)
    return {
      holderDataAvailable: true,
      supplyControlled: Math.round(controlled * 100) / 100,
      matchedHolderWallets: matched.sort((a, b) => b.supplyPct - a.supplyPct),
      holderStats: {
        top1: pcts[0] ?? null, top10: pcts.slice(0, 10).reduce((a, b) => a + b, 0), top20: pcts.slice(0, 20).reduce((a, b) => a + b, 0), holderCount: items.length,
        creatorInTopHolders: matched.some(m => m.isDeployer), linkedWalletSupply: matched.filter(m => m.isLinked).reduce((a, b) => a + b.supplyPct, 0), devClusterSupply: Math.round(controlled * 100) / 100,
      },
      diag: { provider: 'goldrush', chainUsed: activeChainConfig.covalentChain, attempted: true, hasApiKey: true, statusCode: res.status, holderRowsCount: items.length, rawItemCount: items.length, normalizedCount: items.length, percentAvailable: totalSupply > BigInt(0), creatorRowFound: matched.some(m => m.isDeployer), linkedWalletComputed: true, devClusterComputed: true, percentSource: 'derived_from_total_supply', derivationAttempted: true, derivationSucceeded: totalSupply > BigInt(0), reason: 'ok' },
    }
  } catch {
    return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [], diag: { provider: 'goldrush', chainUsed: activeChainConfig.covalentChain, attempted: true, hasApiKey: Boolean(process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY), holderRowsCount: 0, percentAvailable: false, creatorRowFound: false, linkedWalletComputed: false, devClusterComputed: false, reason: 'fetch_error' } }
  }
}

async function getPreviousActivity(deployer: string | null, excludeContract?: string): Promise<{
  previousActivityAvailable: boolean
  previousProjects: PreviousProject[]
  previousActivityStatus: 'ok' | 'none_found' | 'limited_check' | 'skipped'
  warning: string | null
}> {
  if (!deployer) {
    return { previousActivityAvailable: false, previousProjects: [], previousActivityStatus: 'skipped', warning: null }
  }
  const excludeLow = excludeContract?.toLowerCase() ?? ''

  // Covalent-first: scan wallet tx history for contract deployment transactions
  const covalentKey = process.env.COVALENT_API_KEY
  if (covalentKey) {
    try {
      logRpcCall({ route: '/api/dev-wallet', chain: activeChainConfig.covalentChain, method: 'goldrush_deployer_transactions_v2' })
      const res = await fetch(
        `${COVALENT_BASE_URL}/${activeChainConfig.covalentChain}/address/${deployer}/transactions_v2/?page-size=100&block-signed-at-asc=false&no-logs=true`,
        { headers: { Authorization: `Bearer ${covalentKey}` }, cache: 'no-store', signal: AbortSignal.timeout(10000) }
      )
      if (res.ok) {
        const json = await res.json() as { data?: { items?: CovalentTxItem[] } }
        const txItems = json?.data?.items ?? []
        // Deployment txs: to_address is null/empty and tx was successful
        const deploymentTxs = txItems.filter(t => t.successful && (t.to_address === null || t.to_address === ''))
        if (deploymentTxs.length === 0) {
          return { previousActivityAvailable: true, previousProjects: [], previousActivityStatus: 'none_found', warning: null }
        }
        const contractAddresses = await Promise.all(
          deploymentTxs.slice(0, 8).map(t => getContractAddressFromTx(t.tx_hash))
        )
        const projects: PreviousProject[] = contractAddresses
          .map((addr, i): PreviousProject | null =>
            addr && addr !== excludeLow ? {
              contractAddress: addr,
              name: null,
              symbol: null,
              createdAt: deploymentTxs[i]?.block_signed_at ?? null,
              rugFlag: null,
              rugReason: null,
            } : null
          )
          .filter((p): p is PreviousProject => p !== null)
        return {
          previousActivityAvailable: true,
          previousProjects: projects,
          previousActivityStatus: projects.length > 0 ? 'ok' : 'none_found',
          warning: null,
        }
      }
    } catch {
      // Fall through to Alchemy fallback
    }
  }

  // Alchemy fallback: ERC-20 interactions as a limited signal (not true deployments)
  const transfers = await getAssetTransfers({
    fromBlock: '0x0',
    toBlock: 'latest',
    fromAddress: deployer,
    category: ['erc20', 'external'],
    order: 'desc',
    maxCount: '0x64',
    withMetadata: true,
  })

  if (transfers.length === 0) {
    return { previousActivityAvailable: false, previousProjects: [], previousActivityStatus: 'limited_check', warning: null }
  }

  const byContract = new Map<string, PreviousProject>()
  for (const t of transfers) {
    const contractAddress = t.rawContract?.address?.toLowerCase()
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') continue
    if (contractAddress === excludeLow) continue
    if (byContract.has(contractAddress)) continue
    byContract.set(contractAddress, {
      contractAddress,
      name: null,
      symbol: t.asset,
      createdAt: t.metadata?.blockTimestamp ?? null,
      rugFlag: null,
      rugReason: null,
    })
  }

  return {
    previousActivityAvailable: byContract.size > 0,
    previousProjects: [...byContract.values()].slice(0, 10),
    previousActivityStatus: 'limited_check',
    warning: null,
  }
}

function toBigIntSafe(value: unknown): bigint | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s || s.includes('.') || /[eE]/.test(s)) return null
  try { return BigInt(s) } catch { return null }
}

async function deriveHolderPercentages(contract: string, holderRows: HolderRowInput[] | null | undefined, scannerTop: { top1?: number | null; top10?: number | null; top20?: number | null } | null | undefined): Promise<HolderPercentDerivationResult> {
  const rows = Array.isArray(holderRows) ? holderRows : []
  const holderRowsCount = rows.length
  const holderRowsHaveBalances = rows.some(r => toBigIntSafe(r.balance ?? r.amount) != null)
  const scannerHasTop = typeof scannerTop?.top1 === 'number' || typeof scannerTop?.top10 === 'number' || typeof scannerTop?.top20 === 'number'
  if (holderRowsCount === 0) return { holderDistribution: null, holderDistributionStatus: 'unavailable_with_reason', holderPercentAvailable: false, holderPercentSource: null, holderStatusReason: 'no_holder_rows_returned', debug: { holderRowsCount, holderRowsHaveBalances, tokenDecimalsResolved: null, totalSupplyResolved: false, totalSupplySource: null, percentDerivationAttempted: false, percentDerivationReason: 'no_holder_rows', top1: null, top10: null, top20: null } }
  if (scannerHasTop) return {
    holderDistribution: { top1: scannerTop?.top1 ?? null, top10: scannerTop?.top10 ?? null, top20: scannerTop?.top20 ?? null, holderCount: holderRowsCount, topHolders: rows.map(r => ({ address: String(r.address ?? '').toLowerCase(), percent: typeof r.percent === 'number' ? r.percent : null })) },
    holderDistributionStatus: 'ok',
    holderPercentAvailable: true,
    holderPercentSource: 'token_scanner_precalculated',
    debug: { holderRowsCount, holderRowsHaveBalances, tokenDecimalsResolved: null, totalSupplyResolved: true, totalSupplySource: 'token_scanner_precalculated', percentDerivationAttempted: false, percentDerivationReason: 'scanner_top_values_present', top1: scannerTop?.top1 ?? null, top10: scannerTop?.top10 ?? null, top20: scannerTop?.top20 ?? null },
  }
  let totalSupply: bigint | null = null
  let totalSupplySource: string | null = null
  let tokenDecimalsResolved: number | null = null
  try {
    const [supplyHex, decHex] = await Promise.all([
      alchemyRpc('eth_call', [{ to: contract, data: '0x18160ddd' }, 'latest']) as Promise<string>,
      alchemyRpc('eth_call', [{ to: contract, data: '0x313ce567' }, 'latest']) as Promise<string>,
    ])
    if (typeof supplyHex === 'string' && /^0x[0-9a-fA-F]+$/.test(supplyHex) && supplyHex !== '0x' && supplyHex !== '0x0') totalSupply = BigInt(supplyHex)
    if (typeof decHex === 'string' && /^0x[0-9a-fA-F]+$/.test(decHex)) tokenDecimalsResolved = Number.parseInt(decHex, 16)
    if (totalSupply && totalSupply > BigInt(0)) totalSupplySource = 'rpc_totalSupply'
  } catch { /* ignore */ }
  if (!totalSupply || totalSupply <= BigInt(0)) {
    const providerSupply = rows.map(r => toBigIntSafe((r as Record<string, unknown>).total_supply)).find(v => v != null) ?? null
    if (providerSupply && providerSupply > BigInt(0)) { totalSupply = providerSupply; totalSupplySource = 'provider_total_supply' }
  }
  if (!totalSupply || totalSupply <= BigInt(0)) {
    let sum = BigInt(0)
    for (const r of rows) { const b = toBigIntSafe(r.balance ?? r.amount); if (b != null) sum += b }
    if (sum > BigInt(0)) { totalSupply = sum; totalSupplySource = 'summed_returned_rows' }
  }
  const percentDerivationAttempted = true
  if (!totalSupply || totalSupply <= BigInt(0)) return { holderDistribution: null, holderDistributionStatus: 'partial', holderPercentAvailable: false, holderPercentSource: null, debug: { holderRowsCount, holderRowsHaveBalances, tokenDecimalsResolved, totalSupplyResolved: false, totalSupplySource, percentDerivationAttempted, percentDerivationReason: 'total_supply_unresolved', top1: null, top10: null, top20: null } }
  const ranked = rows.map(r => {
    const bal = toBigIntSafe(r.balance ?? r.amount) ?? BigInt(0)
    const pct = Number((bal * BigInt(1000000)) / totalSupply) / 10000
    return { address: String(r.address ?? '').toLowerCase(), percent: Number.isFinite(pct) ? pct : null }
  })
  const sorted = ranked.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
  const sum = (n: number) => sorted.slice(0, n).reduce((acc, h) => acc + (h.percent ?? 0), 0)
  const top1 = sorted[0]?.percent ?? null
  const top10 = sum(10)
  const top20 = sum(20)
  const partial = totalSupplySource === 'summed_returned_rows'
  return {
    holderDistribution: { top1, top10, top20, holderCount: holderRowsCount, topHolders: sorted },
    holderDistributionStatus: partial ? 'partial' : 'ok',
    holderPercentAvailable: true,
    holderPercentSource: totalSupplySource,
    debug: { holderRowsCount, holderRowsHaveBalances, tokenDecimalsResolved, totalSupplyResolved: true, totalSupplySource, percentDerivationAttempted, percentDerivationReason: 'derived_from_balances_and_supply', top1, top10, top20 },
  }
}

function detectSuspiciousTransfers(
  linkedWallets: LinkedWallet[],
  supplyControlled: number | null,
  matchedHolderWallets: MatchedHolder[],
): { suspiciousTransfers: boolean; suspiciousTransferReasons: string[] } {
  const reasons: string[] = []

  const tokenWallets = linkedWallets.filter(w => w.reason === 'token_supply_transfer')
  const ethWallets = linkedWallets.filter(w => w.reason === 'eth_funding_transfer')

  if (tokenWallets.length >= 3) {
    reasons.push(`Creator sent tokens to ${tokenWallets.length} wallets in checked window`)
  } else if (ethWallets.length >= 3) {
    reasons.push(`Creator sent ETH to ${ethWallets.length} wallets around launch`)
  }

  // Overlap: linked wallets also appearing in top-holder set
  const holderOverlap = matchedHolderWallets.filter(h => h.isLinked)
  if (holderOverlap.length >= 2) {
    reasons.push(`${holderOverlap.length} creator-linked wallets appear in top-holder set`)
  }

  // Same-size transfers — clear coordination signal
  const numericAmounts = linkedWallets.map(w => w.amountReceived).filter((v): v is number => typeof v === 'number')
  if (numericAmounts.length >= 3) {
    const rounded = numericAmounts.map(v => Number(v.toFixed(6)))
    const counts = new Map<number, number>()
    for (const n of rounded) counts.set(n, (counts.get(n) ?? 0) + 1)
    const maxGroup = Math.max(...counts.values())
    if (maxGroup >= 3) reasons.push('Repeated same-size transfers detected')
  }

  // Close timing (within 2 hours)
  const times = linkedWallets
    .map(w => (w.firstSeen ? new Date(w.firstSeen).getTime() : null))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
  if (times.length >= 3 && (times[times.length - 1] - times[0]) <= 2 * 60 * 60 * 1000) {
    reasons.push('Funded wallets close together in time')
  }

  if (supplyControlled !== null && supplyControlled >= 20) {
    reasons.push(`Deployer cluster controls ~${supplyControlled.toFixed(1)}% of visible holder supply`)
  }

  return { suspiciousTransfers: reasons.length > 0, suspiciousTransferReasons: reasons }
}

function computeRiskLabel(input: VerdictSignalInput): ClarkVerdict['label'] {
  const verifiedCriticalRisk =
    (input.suspiciousTransfers && input.linkedWallets.length >= 5) ||
    (input.holderDataAvailable && input.supplyControlled !== null && input.supplyControlled >= 50) ||
    (input.honeypot === true && input.securityDataAvailable) ||
    (((input.buyTax ?? 0) > 15 || (input.sellTax ?? 0) > 15) && input.securityDataAvailable) ||
    (input.lpLockDataAvailable && input.lpLocked === false) ||
    (input.lpHolderDataAvailable && input.lpHolderConcentration !== null && input.lpHolderConcentration >= 80)

  if (verifiedCriticalRisk) return 'AVOID'

  const hasUsefulSignal =
    Boolean(input.deployerAddress) ||
    input.linkedWallets.length > 0 ||
    input.holderDataAvailable ||
    input.liquidityDataAvailable ||
    input.securityDataAvailable

  if (!hasUsefulSignal) {
    return 'UNKNOWN'
  }

  if (
    input.deployerAddress &&
    input.deployerConfidence === 'high' &&
    !input.suspiciousTransfers &&
    input.holderDataAvailable &&
    input.supplyControlled !== null &&
    input.supplyControlled < 20 &&
    input.liquidityDataAvailable &&
    input.securityDataAvailable
  ) {
    return 'TRUSTWORTHY'
  }

  return 'WATCH'
}

function sanitizeClarkText(
  lines: string[],
  data: { holderDataAvailable: boolean; supplyControlled: number | null; liquidityDataAvailable: boolean; securityDataAvailable: boolean }
): string[] {
  let cleaned = [...lines]

  if (!data.holderDataAvailable || data.supplyControlled === null) {
    cleaned = cleaned.map(line => {
      const lower = line.toLowerCase()
      const hasPercent = /\b\d+(\.\d+)?%/.test(line)
      const holderConcentrationClaim =
        lower.includes('holder') ||
        lower.includes('supply concentration') ||
        lower.includes('top holder') ||
        lower.includes('deployer holds') ||
        lower.includes('controls')

      if (lower.includes('100%') && lower.includes('supply')) {
        return 'Supply control unconfirmed — holder distribution needs deeper review.'
      }
      if ((lower.includes('creator') || lower.includes('deployer')) && lower.includes('holds') && lower.includes('%')) {
        return 'Supply control unconfirmed — holder distribution needs deeper review.'
      }
      if (hasPercent && holderConcentrationClaim) {
        return 'Supply control unconfirmed — holder distribution needs deeper review.'
      }
      return line
    })
  }

  if (!data.liquidityDataAvailable) {
    cleaned = cleaned.map(line => {
      const lower = line.toLowerCase()
      if (
        lower.includes('no dex liquidity') ||
        lower.includes('no active pool') ||
        lower.includes('no lp lock') ||
        lower.includes('lp not locked')
      ) {
        return 'Liquidity and LP lock status require deeper review.'
      }
      return line
    })
  }

  if (!data.securityDataAvailable) {
    cleaned = cleaned.map(line => {
      const lower = line.toLowerCase()
      if (
        lower.includes('honeypot') ||
        lower.includes('sell tax') ||
        lower.includes('buy tax') ||
        lower.includes('transfer tax') ||
        lower.includes('blacklist')
      ) {
        return 'Security signals need a dedicated scan for confirmation.'
      }
      return line
    })
  }

  return cleaned
}

function defaultNextAction(label: ClarkVerdict['label']): string {
  if (label === 'WATCH') return 'Watch only; verify holder distribution, LP control, and linked-wallet behavior before trusting it.'
  if (label === 'AVOID') return 'Avoid until the critical risk is resolved or verified safe.'
  if (label === 'UNKNOWN') return 'Not enough verified data to make a strong call.'
  if (label === 'SCAN DEEPER') return 'Review linked-wallet behavior and rerun the scan with fuller data.'
  return 'Monitor regularly and keep validating new wallet activity.'
}

const BAD_CLARK_PATTERNS = [
  /need\s+a?\s*(token\s+)?(symbol|contract|address)/i,
  /provide\s+a?\s*(token|contract|address)/i,
  /paste\s+(the\s+)?(token|contract|address)/i,
  /which\s+(token|contract|address)/i,
  /what\s+(token|contract|address)/i,
  /share\s+(the\s+)?(token|contract|address)/i,
  /could\s+you\s+(share|provide|paste|send)/i,
  /please\s+(share|provide|paste|send)\s+(me\s+)?(the\s+)?(token|contract)/i,
  /can\s+you\s+(share|provide|paste|send)/i,
  /contract\s+first/i,
  /let\s+me\s+know\s+(the|which)\s+(token|contract)/i,
  /tell\s+me\s+(the|which)\s+(token|contract)/i,
]

function isBadClarkResponse(text: string): boolean {
  return BAD_CLARK_PATTERNS.some(p => p.test(text))
}

interface ClarkFallbackData {
  contractAddress: string
  deployerAddress: string | null
  deployerStatus?: string
  deployerConfidence: 'high' | 'medium' | 'low'
  linkedWallets: LinkedWallet[]
  supplyControlled: number | null
  holderDataAvailable: boolean
  liquidityDataAvailable: boolean
  securityDataAvailable: boolean
  suspiciousTransfers: boolean
  suspiciousTransferReasons: string[]
  honeypot?: boolean | null
  buyTax?: number | null
  sellTax?: number | null
  lpLocked?: boolean | null
  lpHolderConcentration?: number | null
  tokenName?: string | null
  tokenSymbol?: string | null
  holderTop10?: number | null
  holderTop1?: number | null
  holderCount?: number | null
  lpControlStatus?: string | null
  liquidityUsd?: number | null
  previousProjects: PreviousProject[]
}

function buildDeterministicFallbackVerdict(data: ClarkFallbackData): { verdict: ClarkVerdict; clarkError: null } {
  const label = computeRiskLabel({
    deployerAddress: data.deployerAddress,
    deployerConfidence: data.deployerConfidence,
    linkedWallets: data.linkedWallets,
    suspiciousTransfers: data.suspiciousTransfers,
    holderDataAvailable: data.holderDataAvailable,
    supplyControlled: data.supplyControlled,
    securityDataAvailable: data.securityDataAvailable,
    liquidityDataAvailable: data.liquidityDataAvailable,
    honeypot: data.honeypot ?? null,
    buyTax: data.buyTax ?? null,
    sellTax: data.sellTax ?? null,
    lpLocked: data.lpLocked ?? null,
    lpLockDataAvailable: data.lpLocked !== null && data.lpLocked !== undefined,
    lpHolderConcentration: data.lpHolderConcentration ?? null,
    lpHolderDataAvailable: data.lpHolderConcentration !== null && data.lpHolderConcentration !== undefined,
  })

  const tokenLabel = data.tokenName && data.tokenSymbol
    ? `${data.tokenName} (${data.tokenSymbol})`
    : data.tokenName ?? data.tokenSymbol ?? data.contractAddress

  const keySignals: string[] = [
    data.deployerAddress
      ? (data.deployerStatus === 'confirmed'
          ? 'Creator wallet confirmed from transaction records'
          : 'Likely origin wallet identified — not confirmed creator')
      : 'No creator link confirmed from current checks',
    data.linkedWallets.length > 0
      ? `${data.linkedWallets.length} linked wallet(s) found`
      : 'No linked-wallet cluster confirmed',
    data.holderDataAvailable
      ? 'Holder distribution available for review'
      : 'Holder distribution needs deeper confirmation',
    data.liquidityDataAvailable
      ? 'Liquidity data available for review'
      : 'Liquidity control needs deeper review',
  ]

  const r2 = (v: number) => parseFloat(v.toFixed(2))

  const top10r = data.holderTop10 != null ? r2(data.holderTop10) : null
  const top1r  = data.holderTop1  != null ? r2(data.holderTop1)  : null

  const risks: string[] = [
    !data.deployerAddress ? 'Creator link not confirmed — origin of token is unverified' : '',
    data.suspiciousTransfers ? 'Suspicious transfer pattern observed' : '',
    ...data.suspiciousTransferReasons.slice(0, 2),
    top10r != null && top10r >= 70
      ? `Very high holder concentration — top 10 hold ${top10r}% — significant concentration risk`
      : top10r != null && top10r >= 50
        ? `High holder concentration — top 10 hold ${top10r}%`
        : '',
    top1r != null && top1r >= 20
      ? `Top wallet holds ${top1r}% of supply`
      : '',
    data.lpLocked === false ? 'LP appears team-controlled' : '',
  ].filter(Boolean)

  const limitedContext = !data.holderDataAvailable && !data.liquidityDataAvailable && !data.securityDataAvailable
  const creatorLine = data.deployerStatus === 'confirmed'
    ? 'Creator wallet confirmed.'
    : data.deployerAddress
      ? 'Likely origin wallet identified.'
      : 'Creator wallet not confirmed.'
  const holderLine = data.holderDataAvailable
    ? 'Holder distribution is available for review.'
    : 'Holder distribution needs deeper confirmation.'
  const liqLine = data.liquidityDataAvailable
    ? 'Liquidity data is available for review.'
    : 'Liquidity control needs deeper review.'

  const summary = limitedContext
    ? `${tokenLabel} scanned on Base. ${creatorLine} Market and security context is limited in this release view.`
    : `${tokenLabel} scanned on Base. ${creatorLine} ${holderLine} ${liqLine}`

  return {
    verdict: {
      label,
      confidence: 'medium',
      summary,
      keySignals,
      risks: risks.length > 0 ? risks : ['No elevated risk signals from available data'],
      nextAction: defaultNextAction(label),
    },
    clarkError: null,
  }
}

async function getClarkVerdict(origin: string, data: {
  contractAddress: string
  deployerAddress: string | null
  deployerStatus?: string
  deployerConfidence: 'high' | 'medium' | 'low'
  methodUsed: string
  linkedWallets: LinkedWallet[]
  supplyControlled: number | null
  holderDataAvailable: boolean
  liquidityDataAvailable: boolean
  securityDataAvailable: boolean
  previousActivityAvailable: boolean
  previousProjects: PreviousProject[]
  suspiciousTransfers: boolean
  suspiciousTransferReasons: string[]
  warnings: string[]
  honeypot?: boolean | null
  buyTax?: number | null
  sellTax?: number | null
  lpLocked?: boolean | null
  lpHolderConcentration?: number | null
  tokenName?: string | null
  tokenSymbol?: string | null
  holderTop10?: number | null
  holderTop1?: number | null
  holderCount?: number | null
  lpControlStatus?: string | null
  liquidityUsd?: number | null
  supplyControlStatus?: string | null
  linkedWalletsStatus?: string | null
  previousActivityStatus?: string | null
  matchedHolderCount?: number
}): Promise<{ verdict: ClarkVerdict | null; clarkError: string | null }> {
  const normalizeLabel = (value: unknown): ClarkVerdict['label'] | null => {
    const v = String(value ?? '').trim().toUpperCase().replace(/_/g, ' ')
    if (v === 'TRUSTWORTHY' || v === 'WATCH' || v === 'AVOID' || v === 'UNKNOWN' || v === 'SCAN DEEPER') return v as ClarkVerdict['label']
    if (v === 'HIGH RISK') return 'AVOID'
    if (v === 'LOW CONFIDENCE') return 'UNKNOWN'
    if (v === 'SCAN DEEPER') return 'SCAN DEEPER'
    if (v === 'SCANDEEPER' || v === 'SCAN DEEPER') return 'SCAN DEEPER'
    return null
  }
  const normalizeConfidence = (value: unknown): ClarkVerdict['confidence'] => {
    const v = String(value ?? '').trim().toLowerCase()
    if (v === 'high') return 'high'
    if (v === 'low') return 'low'
    return 'medium'
  }
  const parseFallbackLabelFromText = (text: string): ClarkVerdict['label'] | null => {
    const m = text.match(/\bVerdict:\s*(AVOID|WATCH|SCAN DEEPER|TRUSTWORTHY|UNKNOWN)\b/i)
    return m ? normalizeLabel(m[1]) : null
  }
  const parseFallbackConfidenceFromText = (text: string): ClarkVerdict['confidence'] => {
    const m = text.match(/\bConfidence:\s*(Low|Medium|High)\b/i)
    return m ? normalizeConfidence(m[1]) : normalizeConfidence(data.deployerConfidence)
  }

  const prompt =
    `MODE: dev-wallet\n` +
    `Analyze this ${activeChainConfig.chainLabel} token scan and return JSON only.\n` +
    `Use only the fields below. Keep response short and professional.\n` +
    (data.deployerStatus === 'confirmed'
      ? `Creator wallet is confirmed from on-chain records. State this clearly.\n`
      : `Use wording: "likely deployer/owner wallet". Do not claim confirmed deployer unless confidence is high.\n`) +
    `Do not infer supply concentration from missing holder data.\n` +
    `If holder data is unavailable, explicitly state supply control cannot be confirmed and do not mention holder percentages.\n` +
    `Do not infer LP lock status or DEX liquidity from missing liquidity data.\n` +
    `If security scan data is unavailable, do not infer honeypot status or tax values.\n` +
    `Output label must be exactly one of: TRUSTWORTHY, WATCH, AVOID, UNKNOWN.\n` +
    `Do not return TRUSTWORTHY if top-10 holder concentration is >= 50% or creator is unconfirmed.\n` +
    `If top-10 concentration >= 70%, risks must include a concentration warning and label must be CAUTION or AVOID.\n` +
    `If top-10 concentration >= 50%, risks must include a concentration warning.\n` +
    `If top-1 holder >= 20%, risks must include a top wallet concentration warning.\n` +
    `Address: ${data.contractAddress}\n` +
    `Token: ${data.tokenName ?? 'unknown'} (${data.tokenSymbol ?? 'unknown'})\n` +
    `Creator status: ${data.deployerStatus ?? 'not_confirmed'}\n` +
    `Creator/origin address: ${data.deployerAddress ?? 'none'}\n` +
    `Confidence: ${data.deployerConfidence}\n` +
    `Method: ${data.methodUsed}\n` +
    `Linked wallets: ${data.linkedWallets.length}\n` +
    `Linked wallets status: ${data.linkedWalletsStatus ?? 'unknown'}\n` +
    `Holder data available: ${data.holderDataAvailable}\n` +
    `Holder count: ${data.holderCount != null ? data.holderCount : 'unknown'}\n` +
    `Top 10 holder concentration: ${data.holderTop10 != null ? `${parseFloat(data.holderTop10.toFixed(2))}%` : 'unknown'}\n` +
    `Supply controlled by deployer cluster: ${data.supplyControlled ?? 'unknown'}\n` +
    `Supply control status: ${data.supplyControlStatus ?? 'unknown'}\n` +
    `Matched holder wallets (deployer cluster in top holders): ${data.matchedHolderCount ?? 0}\n` +
    `Previous activity status: ${data.previousActivityStatus ?? 'unknown'}\n` +
    `Liquidity data available: ${data.liquidityDataAvailable}\n` +
    `Liquidity USD: ${data.liquidityUsd != null ? data.liquidityUsd : 'unknown'}\n` +
    `LP control status: ${data.lpControlStatus ?? 'unknown'}\n` +
    `Security data available: ${data.securityDataAvailable}\n` +
    `Previous activity available: ${data.previousActivityAvailable}\n` +
    `Previous activity contracts: ${data.previousProjects.map(p => p.contractAddress).slice(0, 8).join(', ') || 'none'}\n` +
    `Suspicious transfers: ${data.suspiciousTransfers}\n` +
    `Suspicious reasons: ${data.suspiciousTransferReasons.join('; ') || 'none'}\n` +
    `Honeypot: ${data.honeypot ?? 'unknown'}\n` +
    `Buy tax: ${data.buyTax != null ? `${parseFloat(data.buyTax.toFixed(2))}%` : 'unknown'}\n` +
    `Sell tax: ${data.sellTax != null ? `${parseFloat(data.sellTax.toFixed(2))}%` : 'unknown'}\n` +
    `LP locked: ${data.lpLocked ?? 'unknown'}\n` +
    `LP holder concentration: ${data.lpHolderConcentration != null ? `${parseFloat(data.lpHolderConcentration.toFixed(2))}%` : 'unknown'}\n` +
    `Unavailable data: ${data.warnings.join('; ') || 'none'}\n` +
    `Return ONLY JSON with keys label, confidence, summary, keySignals, risks, nextAction.`

  try {
    const res = await fetch(`${origin}/api/clark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feature: 'clark-ai',
        mode: 'dev-wallet',
        chain: activeChainConfig.chain,
      chainLabel: activeChainConfig.chainLabel,
        message: prompt,
        prompt,
        context: {
          contractAddress: data.contractAddress,
          deployerAddress: data.deployerAddress,
          deployerConfidence: data.deployerConfidence,
          linkedWallets: data.linkedWallets,
          suspiciousTransfers: data.suspiciousTransfers,
          suspiciousTransferReasons: data.suspiciousTransferReasons,
          holderDataAvailable: data.holderDataAvailable,
          supplyControlled: data.supplyControlled,
          previousProjects: data.previousProjects,
          warnings: data.warnings,
          computedVerdict: computeRiskLabel({
            deployerAddress: data.deployerAddress,
            deployerConfidence: data.deployerConfidence,
            linkedWallets: data.linkedWallets,
            suspiciousTransfers: data.suspiciousTransfers,
            holderDataAvailable: data.holderDataAvailable,
            supplyControlled: data.supplyControlled,
            securityDataAvailable: data.securityDataAvailable,
            liquidityDataAvailable: data.liquidityDataAvailable,
            honeypot: data.honeypot ?? null,
            buyTax: data.buyTax ?? null,
            sellTax: data.sellTax ?? null,
            lpLocked: data.lpLocked ?? null,
            lpLockDataAvailable: data.lpLocked !== null && data.lpLocked !== undefined,
            lpHolderConcentration: data.lpHolderConcentration ?? null,
            lpHolderDataAvailable: data.lpHolderConcentration !== null && data.lpHolderConcentration !== undefined,
          }),
        },
      }),
      cache: 'no-store',
    })

    if (!res.ok) return buildDeterministicFallbackVerdict(data)
    const payload = await res.json() as { data?: Record<string, unknown> } | string
    const bodyData = typeof payload === 'string' ? null : (payload?.data ?? null)
    const text =
      (typeof bodyData?.reply === 'string' ? bodyData.reply : null) ??
      (typeof bodyData?.response === 'string' ? bodyData.response : null) ??
      (typeof bodyData?.message === 'string' ? bodyData.message : null) ??
      (typeof bodyData?.text === 'string' ? bodyData.text : null) ??
      (typeof payload === 'string' ? payload : '')

    if (text && isBadClarkResponse(text)) {
      return buildDeterministicFallbackVerdict(data)
    }

    const computedLabel = computeRiskLabel({
      deployerAddress: data.deployerAddress,
      deployerConfidence: data.deployerConfidence,
      linkedWallets: data.linkedWallets,
      suspiciousTransfers: data.suspiciousTransfers,
      holderDataAvailable: data.holderDataAvailable,
      supplyControlled: data.supplyControlled,
      securityDataAvailable: data.securityDataAvailable,
      liquidityDataAvailable: data.liquidityDataAvailable,
      honeypot: data.honeypot ?? null,
      buyTax: data.buyTax ?? null,
      sellTax: data.sellTax ?? null,
      lpLocked: data.lpLocked ?? null,
      lpLockDataAvailable: data.lpLocked !== null && data.lpLocked !== undefined,
      lpHolderConcentration: data.lpHolderConcentration ?? null,
      lpHolderDataAvailable: data.lpHolderConcentration !== null && data.lpHolderConcentration !== undefined,
    })
    const labelFromField = normalizeLabel(bodyData?.verdict)
    const confidenceFromField = normalizeConfidence(bodyData?.confidence)
    const labelFromText = parseFallbackLabelFromText(text)
    const confidenceFromText = parseFallbackConfidenceFromText(text)
    const finalLabel = labelFromField ?? labelFromText ?? computedLabel
    const finalConfidence = confidenceFromField ?? confidenceFromText

    let parsed: Partial<ClarkVerdict> = {}
    const jsonMatch = text.match(/\{[\s\S]+\}/)
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]) as Partial<ClarkVerdict> } catch {}
    }
    const keySignals = sanitizeClarkText(
      Array.isArray(parsed.keySignals) ? parsed.keySignals.map(String) : [],
      {
        holderDataAvailable: data.holderDataAvailable,
        supplyControlled: data.supplyControlled,
        liquidityDataAvailable: data.liquidityDataAvailable,
        securityDataAvailable: data.securityDataAvailable,
      }
    )
    const risks = sanitizeClarkText(
      Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      {
        holderDataAvailable: data.holderDataAvailable,
        supplyControlled: data.supplyControlled,
        liquidityDataAvailable: data.liquidityDataAvailable,
        securityDataAvailable: data.securityDataAvailable,
      }
    )

    const fallbackSignals = sanitizeClarkText([
      data.deployerAddress ? 'Likely creator/deployer wallet identified' : 'No creator link confirmed from current checks',
      data.linkedWallets.length > 0 ? `${data.linkedWallets.length} linked wallet(s) found` : 'No linked wallets in checked window',
      data.suspiciousTransfers ? 'Suspicious transfer pattern observed' : 'No suspicious transfer pattern detected',
    ], data)
    const fallbackRisks = sanitizeClarkText([
      data.holderDataAvailable ? 'Holder distribution available for review' : 'Holder distribution needs deeper confirmation',
      data.liquidityDataAvailable ? 'Liquidity data available for review' : 'Liquidity control needs deeper review',
      ...data.suspiciousTransferReasons.slice(0, 2),
    ], data)

    let summary = sanitizeClarkText([typeof parsed.summary === 'string' ? parsed.summary : 'Analysis unavailable.'], {
      holderDataAvailable: data.holderDataAvailable,
      supplyControlled: data.supplyControlled,
      liquidityDataAvailable: data.liquidityDataAvailable,
      securityDataAvailable: data.securityDataAvailable,
    })[0]
    if (text && (!summary || summary === 'Analysis unavailable.')) {
      const clean = text.replace(/\s+/g, ' ').trim()
      summary = clean.length > 220 ? `${clean.slice(0, 217)}...` : clean
    }
    if ((!data.holderDataAvailable || data.supplyControlled === null) && !summary.includes('Supply control unconfirmed') && !summary.includes('holder distribution')) {
      summary = `${summary} Supply control unconfirmed — holder distribution needs deeper review.`
    }
    if (!data.liquidityDataAvailable && !summary.includes('Liquidity and LP lock') && !summary.includes('liquidity')) {
      summary = `${summary} Liquidity and LP lock status require deeper review.`
    }
    if (!data.securityDataAvailable && !summary.includes('Security signals') && !summary.includes('security')) {
      summary = `${summary} Security signals need a dedicated scan for confirmation.`
    }
    const readOnly = summary.match(/Read:\s*([\s\S]*?)(?:\n(?:Key signals|Risks|Next action)\s*:|$)/i)?.[1]?.trim()
    if (readOnly) summary = readOnly
    const sanitizedKeySignals = sanitizeClarkText(
      Array.isArray(parsed.keySignals) ? parsed.keySignals.map(String) : fallbackSignals,
      data
    )
    const sanitizedRisks = sanitizeClarkText(
      Array.isArray(parsed.risks) ? parsed.risks.map(String) : fallbackRisks,
      data
    )

    if (!text && !labelFromField && !labelFromText) {
      return { verdict: null, clarkError: 'Clark returned unparseable response' }
    }

    return {
      verdict: {
        label: finalLabel,
        confidence: finalConfidence,
        summary,
        keySignals: sanitizedKeySignals.length > 0 ? sanitizedKeySignals : fallbackSignals,
        risks: sanitizedRisks.length > 0 ? sanitizedRisks : fallbackRisks,
        nextAction: typeof parsed.nextAction === 'string' && parsed.nextAction.trim().length > 0
          ? parsed.nextAction
          : defaultNextAction(finalLabel),
      },
      clarkError: null,
    }
  } catch {
    return buildDeterministicFallbackVerdict(data)
  }
}


interface TokenEvidenceResult {
  data: Record<string, unknown> | null
  attempted: boolean
  ok: boolean
  httpStatus: number | null
  reason: string
}

async function fetchTokenEvidence(origin: string, contractAddress: string, chain: string, authHeader?: string): Promise<TokenEvidenceResult> {
  const result: TokenEvidenceResult = { data: null, attempted: true, ok: false, httpStatus: null, reason: '' }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-user-plan': 'pro' }
    if (authHeader) headers['Authorization'] = authHeader
    const res = await fetch(`${origin}/api/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contract: contractAddress, chain }),
      cache: 'no-store',
      signal: AbortSignal.timeout(14000),
    })
    result.httpStatus = res.status
    if (!res.ok) { result.reason = `http_${res.status}`; return result }
    const json = await res.json() as Record<string, unknown>
    result.data = json
    result.ok = true
    result.reason = 'ok'
    return result
  } catch (e) {
    result.reason = e instanceof Error
      ? (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'fetch_error')
      : 'unknown'
    return result
  }
}

export async function POST(req: Request) {
  const warnings: string[] = []

  try {
    const startedAt = Date.now()
    const debug = new URL(req.url).searchParams.get('debug') === 'true'

    // ── 1. Parse + validate input BEFORE rate limiting so invalid requests never consume quota ──
    const body = await req.json() as { contractAddress?: string; chain?: string }
    const { contractAddress } = body
    const normalizedChain = body.chain === 'eth' ? 'eth' : body.chain === 'base' || body.chain == null ? 'base' : null
    if (!normalizedChain) return NextResponse.json({ error: 'Unsupported chain. Use base or eth.' }, { status: 400 })
    if (!contractAddress || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
      return NextResponse.json(
        { error: 'Invalid contract address — must be a valid EVM address (0x + 40 hex chars)' },
        { status: 400 }
      )
    }
    activeChainConfig = getChainConfig(normalizedChain)

    // ── 2. Resolve plan (needed for rate-limit tier) ──
    const planRes = await resolveServerPlan(req)
    const { plan } = planRes

    // ── 3. Rate limit — key by userId when authenticated, else by IP (per-plan tier) ──
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const rateLimitKeyType: 'user' | 'ip' = planRes.userId ? 'user' : 'ip'
    // Hash userId to avoid storing PII in memory key; use first 16 hex chars of a simple hash
    const rateIdentity = planRes.userId
      ? `u:${planRes.userId.replace(/-/g, '').slice(0, 16)}`
      : `i:${ip}`
    const rateKey = `dw:${plan}:${rateIdentity}`
    const now = Date.now()
    const rr = devRate.get(rateKey)
    if (!rr || rr.resetAt <= now) {
      devRate.set(rateKey, { count: 1, resetAt: now + 60_000, lastAt: now })
    } else if (now - rr.lastAt < DEV_COOLDOWN_MS[plan]) {
      const retryAfterSeconds = Math.ceil((rr.lastAt + DEV_COOLDOWN_MS[plan] - now) / 1000)
      return NextResponse.json({
        error: 'Cooldown active. Please retry shortly.',
        rateLimited: true,
        retryAfterSeconds,
        cooldownKeyType: rateLimitKeyType,
        ...(debug ? { _debug: { rateLimitChecked: true, rateLimitKeyType, retryAfterSeconds, invalidRequestSkippedRateLimit: false, userPresent: planRes.userPresent, hasBearer: planRes.hasBearer } } : {}),
      }, { status: 429 })
    } else if (rr.count >= DEV_RATE_LIMIT[plan]) {
      const retryAfterSeconds = Math.ceil((rr.resetAt - now) / 1000)
      return NextResponse.json({
        error: 'Rate limit reached. Try again shortly.',
        rateLimited: true,
        retryAfterSeconds,
        cooldownKeyType: rateLimitKeyType,
        ...(debug ? { _debug: { rateLimitChecked: true, rateLimitKeyType, retryAfterSeconds, invalidRequestSkippedRateLimit: false, userPresent: planRes.userPresent, hasBearer: planRes.hasBearer } } : {}),
      }, { status: 429 })
    } else {
      rr.count += 1; rr.lastAt = now
    }

    const normalizedAddress = contractAddress.toLowerCase()
    const cacheKey = `${activeChainConfig.chain}:${normalizedAddress}`
    const cached = devCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) {
      const cp: unknown = typeof cached.payload === 'object' && cached.payload ? { ...(cached.payload as Record<string, unknown>) } : cached.payload
      if (debug && cp && typeof cp === 'object') (cp as Record<string, unknown>)._debug = { routeName: '/api/dev-wallet', cacheHit: true, requestDurationMs: Date.now() - startedAt }
      return NextResponse.json(cp)
    }

    let bytecode: string | null = null
    let rpcStatus: 'ok' | 'partial' | 'unavailable' = 'ok'
    const providerUsed = activeChainConfig.rpcUrl ? 'configured' : 'none'
    try {
      bytecode = await alchemyRpc('eth_getCode', [normalizedAddress, 'latest']) as string
    } catch {
      rpcStatus = 'unavailable'
    }

    if (bytecode === '0x') {
      return NextResponse.json(
        { error: `No contract found at this address on ${activeChainConfig.chainLabel} mainnet` },
        { status: 400 }
      )
    }

    const origin = new URL(req.url).origin
    const reqAuthHeader = req.headers.get('authorization') ?? undefined
    const debugMode = debug
    const tokenEvidenceResult = await fetchTokenEvidence(origin, normalizedAddress, activeChainConfig.chain, reqAuthHeader)
    const tokenEvidence = tokenEvidenceResult.data

    const sections = (tokenEvidence?.sections as Record<string, unknown> | undefined) ?? {}
    const market = (sections.market as Record<string, unknown> | undefined) ?? {}
    const holderDistributionRaw = tokenEvidence?.holderDistribution as {
      top1?: number | null
      top5?: number | null
      top10?: number | null
      top20?: number | null
      holderCount?: number | null
      topHolders?: Array<{ address?: string; percent?: number | null }>
    } | null | undefined
    const holderStatusRaw = (tokenEvidence?.holderDistributionStatus as Record<string, unknown> | null | undefined) ?? null
    const tokenHolderStatus = typeof holderStatusRaw?.status === 'string' ? holderStatusRaw.status : null
    const tokenHolderReason = typeof holderStatusRaw?.reason === 'string' ? holderStatusRaw.reason : null
    const tokenHolderPercentSource = typeof holderStatusRaw?.percentSource === 'string' ? holderStatusRaw.percentSource : null
    const usableHolders = tokenHolderStatus === 'ok' || tokenHolderStatus === 'partial'
    const liqEv = (sections.liquidity as Record<string, unknown> | undefined) ?? {}
    const secEv = (sections.security as Record<string, unknown> | undefined) ?? {}
    const liquidityDataAvailable = typeof liqEv.liquidityDepth === 'number' || typeof tokenEvidence?.liquidityUsd === 'number'
    // holderDataFromToken is true whenever scanner returned usable holder status (ok|partial)
    const holderDataFromToken = usableHolders
    const securityDataAvailable = typeof secEv.honeypot === 'boolean' || secEv.status === 'ok' || secEv.status === 'partial' || Object.keys(secEv).length > 0
    if (!tokenEvidence) warnings.push('Market and security context limited in this release view.')

    let deployerAddress: string | null = null
    let deployerConfidence: 'high'|'medium'|'low' = 'low'
    let deployerStatus: 'confirmed' | 'possible_match' | 'not_confirmed' = 'not_confirmed'
    let methodUsed = 'unknown'
    let creationTxHash: string | null = null
    let originReason: string = 'No origin candidate found'
    let originDiag: OriginDiscoveryDiag | null = null
    try {
      const { candidate, diag: od } = await discoverOrigin(normalizedAddress)
      deployerAddress = candidate.address
      deployerConfidence = candidate.confidence
      deployerStatus = candidate.deployerStatus
      methodUsed = candidate.methodUsed
      creationTxHash = candidate.creationTxHash
      originReason = candidate.reason
      originDiag = od
    } catch {
      rpcStatus = rpcStatus === 'ok' ? 'partial' : rpcStatus
      warnings.push('Creator trace not returned from current check.')
    }

    if (!deployerAddress) {
      warnings.push('Creator link not confirmed from current checks.')
    } else {
      // Purge any stale creator-not-confirmed strings that accumulated before discoverOrigin resolved
      const CREATOR_NOT_CONFIRMED_RE = /creator.*not confirmed|no creator.*link|creator link not/i
      for (let i = warnings.length - 1; i >= 0; i--) {
        if (CREATOR_NOT_CONFIRMED_RE.test(warnings[i])) warnings.splice(i, 1)
      }
    }

    let linkedWallets: LinkedWallet[] = []
    let linkedWalletsCheckStatus: 'ok' | 'none_found' | 'limited_check' | 'skipped' = 'skipped'
    let linkedWalletsDiag: LinkedWalletDiag = { attempted: false, ok: false, tokenTransfersFound: 0, ethTransfersFound: 0, totalCandidates: 0, reason: 'no_deployer' }
    if (deployerAddress) {
      const lwResult = await findLinkedWallets(deployerAddress, normalizedAddress)
      linkedWallets = lwResult.wallets
      linkedWalletsCheckStatus = lwResult.status
      linkedWalletsDiag = lwResult.diag
    }

    // Pass scannerDataProvided=true when the scanner returned usable holder status so
    // getSupplyData skips the redundant GoldRush API call (which also fails without a key).
    const { holderDataAvailable: holderDataFromCovalent, supplyControlled, matchedHolderWallets, holderStats, diag: holderDiag } =
      await getSupplyData(normalizedAddress, deployerAddress, linkedWallets, holderDistributionRaw?.topHolders, usableHolders)
    const holderDataAvailable = holderDataFromToken || holderDataFromCovalent
    if (!holderDataAvailable) {
      warnings.push('Holder distribution needs deeper confirmation.')
    }

    // Upgrade confidence for linked wallets that appear in top holders
    if (holderDistributionRaw?.topHolders && holderDistributionRaw.topHolders.length > 0) {
      const holderRankMap = new Map(
        holderDistributionRaw.topHolders.map((h, idx) => [
          (h.address ?? '').toLowerCase(),
          { rank: idx + 1, percent: typeof h.percent === 'number' ? h.percent : 0 },
        ])
      )
      for (const w of linkedWallets) {
        const hi = holderRankMap.get(w.address)
        if (hi) {
          w.confidence = 'high'
          w.overlapTopHolderRank = hi.rank
          w.overlapTopHolderPercent = hi.percent
        }
      }
    }

    const { previousActivityAvailable, previousProjects, previousActivityStatus, warning: activityWarning } =
      await getPreviousActivity(deployerAddress, normalizedAddress)
    if (activityWarning) warnings.push(activityWarning)

    const meta = await fetchTokenMetadata(normalizedAddress, tokenEvidence)
    // Prefer scanner top-level name/symbol fields (set by our hardened rpcTokenString + fallback chain)
    const scannerName = typeof tokenEvidence?.name === 'string' && tokenEvidence.name.trim() && tokenEvidence.name !== 'Unknown' ? tokenEvidence.name.trim() : null
    const scannerSymbol = typeof tokenEvidence?.symbol === 'string' && tokenEvidence.symbol.trim() && tokenEvidence.symbol !== '?' ? tokenEvidence.symbol.trim() : null
    const tokenName = scannerName ?? meta.name
    const tokenSymbol = scannerSymbol ?? meta.symbol
    const tokenNameResolved = Boolean(tokenName && tokenName.trim().length > 0)
    const tokenSymbolResolved = Boolean(tokenSymbol && tokenSymbol.trim().length > 0)
    const tokenScannerMetadataUsed = Boolean(
      (typeof tokenEvidence?.name === 'string' && tokenEvidence.name.trim()) ||
      (typeof (sections.metadata as Record<string, unknown> | undefined)?.name === 'string' && String((sections.metadata as Record<string, unknown>).name).trim()) ||
      (typeof tokenEvidence?.symbol === 'string' && tokenEvidence.symbol.trim()) ||
      (typeof (sections.metadata as Record<string, unknown> | undefined)?.symbol === 'string' && String((sections.metadata as Record<string, unknown>).symbol).trim())
    )
    const holderPercentDerived = await deriveHolderPercentages(normalizedAddress, holderDistributionRaw?.topHolders, { top1: holderDistributionRaw?.top1, top10: holderDistributionRaw?.top10, top20: holderDistributionRaw?.top20 })

    // Compute supply control from holder rows with real percent values only. If the
    // scanner could not expose rows but the holder fallback confirmed no actor
    // matches, preserve that confirmed zero instead of treating 0 as pending.
    const derivedHolderRows = holderPercentDerived.holderDistribution?.topHolders ?? []
    const rawHolderRows = holderDistributionRaw?.topHolders ?? []
    const supplyRowsSource = derivedHolderRows.some(h => typeof h.percent === 'number' && Number.isFinite(h.percent))
      ? derivedHolderRows
      : rawHolderRows.some(h => typeof h.percent === 'number' && Number.isFinite(h.percent))
        ? rawHolderRows.map(h => ({ address: String(h.address ?? '').toLowerCase(), percent: typeof h.percent === 'number' ? h.percent : null }))
        : []
    const holderRowsChecked = supplyRowsSource.length > 0 ? supplyRowsSource.length : (holderStats?.holderCount ?? 0)
    const holderRowsHaveUsablePercents = supplyRowsSource.some(h => typeof h.percent === 'number' && Number.isFinite(h.percent))
    const holderRowsConfirmed = holderRowsHaveUsablePercents || (holderRowsChecked > 0 && supplyControlled !== null)
    const deployerLower = deployerAddress?.toLowerCase() ?? null
    const linkedAddrSet = new Set(linkedWallets.map(w => w.address.toLowerCase()))
    let scLinkedPct = 0
    let scClusterPct = 0
    let scCreatorInTop = false
    let scCreatorRank: number | null = null
    let scCreatorPct: number | null = null
    let scDeployerMatched = false
    const scMatchedLinked: Array<{ address: string; rank: number; percent: number }> = []
    const scSeen = new Set<string>()
    const roundSupplyPct = (value: number): number => Math.round(value * 100) / 100

    if (holderRowsHaveUsablePercents) {
      for (let i = 0; i < supplyRowsSource.length; i++) {
        const h = supplyRowsSource[i]
        const addr = (h.address ?? '').toLowerCase()
        const pct = typeof h.percent === 'number' && Number.isFinite(h.percent) ? h.percent : null
        if (!addr || pct === null || scSeen.has(addr)) continue
        const isDep = deployerLower ? addr === deployerLower : false
        const isLnk = linkedAddrSet.has(addr)
        if (isDep) {
          scCreatorInTop = true
          scCreatorRank = i + 1
          scCreatorPct = pct
          scDeployerMatched = true
          scSeen.add(addr)
        }
        if (isLnk && !isDep) {
          scLinkedPct += pct
          scMatchedLinked.push({ address: addr, rank: i + 1, percent: pct })
          scSeen.add(addr)
        }
      }
      scClusterPct = (scCreatorPct ?? 0) + scLinkedPct
    } else if (holderRowsConfirmed && supplyControlled !== null) {
      scDeployerMatched = matchedHolderWallets.some(h => h.isDeployer)
      scCreatorInTop = scDeployerMatched
      const deployerPctSum = matchedHolderWallets.filter(h => h.isDeployer).reduce((sum, h) => sum + h.supplyPct, 0)
      scCreatorPct = scDeployerMatched ? deployerPctSum : null
      scLinkedPct = matchedHolderWallets.filter(h => h.isLinked).reduce((sum, h) => sum + h.supplyPct, 0)
      scClusterPct = supplyControlled
      for (const h of matchedHolderWallets.filter(h => h.isLinked)) {
        scMatchedLinked.push({ address: h.address, rank: 0, percent: h.supplyPct })
      }
    }

    const scHasActors = Boolean(deployerLower || linkedAddrSet.size > 0)
    const scHasData = holderRowsConfirmed
    const supplyRowsArePartial = holderPercentDerived.holderDistributionStatus === 'partial' || holderPercentDerived.holderPercentSource === 'token_scanner_precalculated'
    const linkedWalletSupplyPercent = linkedAddrSet.size > 0 && scHasData ? roundSupplyPct(scLinkedPct) : null
    const devClusterSupplyPercent = scHasActors && scHasData ? roundSupplyPct((scCreatorPct ?? 0) + scLinkedPct) : null
    const scLinkedStatus: CanonicalStatus =
      linkedAddrSet.size === 0 ? 'not_applicable'
      : !scHasData ? 'unavailable_with_reason'
      : scMatchedLinked.length > 0 ? 'verified'
      : supplyRowsArePartial ? 'partial'
      : 'verified'
    const scClusterStatus: CanonicalStatus =
      !scHasActors ? 'unavailable_with_reason'
      : !scHasData ? 'unavailable_with_reason'
      : scSeen.size > 0 || matchedHolderWallets.length > 0 ? 'verified'
      : supplyRowsArePartial ? 'partial'
      : 'verified'
    const supplyControlReason = !scHasActors
      ? 'no_deployer_or_linked_wallets'
      : !scHasData
        ? 'no_usable_holder_rows_or_percents'
        : scMatchedLinked.length === 0 && linkedAddrSet.size > 0 && !scDeployerMatched
          ? 'linked_wallets_and_creator_checked_against_available_holder_rows_no_supply_found'
          : scMatchedLinked.length === 0 && linkedAddrSet.size > 0
            ? 'linked_wallets_checked_against_available_holder_rows_no_supply_found'
            : 'matched_holder_rows_with_percent_values'
    const supplyControlDebug = {
      holderRowsChecked,
      linkedWalletsChecked: linkedAddrSet.size,
      linkedWalletsMatched: scMatchedLinked.length,
      deployerChecked: Boolean(deployerLower && scHasData),
      deployerMatched: scDeployerMatched,
      creatorPercentFound: scCreatorPct !== null ? roundSupplyPct(scCreatorPct) : null,
      linkedPercentSum: linkedWalletSupplyPercent,
      clusterPercentComputed: devClusterSupplyPercent,
      reason: supplyControlReason,
    }
    const supplyControl = {
      creatorInTopHolders: scCreatorInTop,
      creatorHolderRank: scCreatorRank,
      creatorHolderPercent: scCreatorPct !== null ? roundSupplyPct(scCreatorPct) : null,
      linkedWalletSupplyPercent,
      linkedWalletSupplyStatus: scLinkedStatus,
      devClusterSupplyPercent,
      devClusterSupplyStatus: scClusterStatus,
      devClusterSupplyReason: scClusterStatus === 'unavailable_with_reason' ? supplyControlReason : null,
      matchedLinkedWallets: scMatchedLinked,
    }

    const holderTop10 = holderPercentDerived.holderDistribution?.top10 ?? (holderStats?.top10 ?? null)
    const holderTop1  = holderPercentDerived.holderDistribution?.top1 ?? (holderStats?.top1 ?? null)
    const holderTop20 = holderPercentDerived.holderDistribution?.top20 ?? (holderStats?.top20 ?? null)
    const holderCount = holderPercentDerived.holderDistribution?.holderCount ?? (holderStats?.holderCount ?? null)
    const secHoneypot: boolean | null = typeof secEv.honeypot === 'boolean' ? secEv.honeypot : null
    const secBuyTax: number | null = typeof secEv.buyTax === 'number' ? secEv.buyTax : null
    const secSellTax: number | null = typeof secEv.sellTax === 'number' ? secEv.sellTax : null
    const lpControlObj = liqEv.lpControl as Record<string, unknown> | null | undefined
    const lpControlStatus = typeof lpControlObj?.status === 'string' ? lpControlObj.status : null
    const liqLpLocked: boolean | null = lpControlStatus === 'burned' || lpControlStatus === 'locked' ? true : lpControlStatus === 'team_controlled' ? false : null
    const liqHolderConcentration: number | null = typeof liqEv.lpHolderConcentration === 'number' ? liqEv.lpHolderConcentration : null
    const liquidityUsd: number | null = typeof liqEv.liquidityDepth === 'number' ? (liqEv.liquidityDepth as number) : (typeof tokenEvidence?.liquidityUsd === 'number' ? (tokenEvidence.liquidityUsd as number) : null)

    const supplyControlStatus: 'ok' | 'partial' | 'needs_confirmed_creator' | 'not_in_top_holders' =
      !deployerAddress && linkedWallets.length === 0
        ? 'needs_confirmed_creator'
        : deployerAddress && holderDataAvailable && supplyControlled === 0 && matchedHolderWallets.length === 0
          ? 'not_in_top_holders'
          : (supplyControlled !== null && supplyControlled > 0 ? 'ok' : 'partial')

    const { suspiciousTransfers, suspiciousTransferReasons } =
      detectSuspiciousTransfers(linkedWallets, supplyControlled, matchedHolderWallets)

    const clusterMap = buildClusterMap({
      deployerAddress,
      deployerStatus,
      linkedWallets,
      matchedLinkedWallets: supplyControl.matchedLinkedWallets,
      supplyControl,
      holderDistribution: holderPercentDerived.holderDistribution ?? holderDistributionRaw ?? null,
      topHolders: holderPercentDerived.holderDistribution?.topHolders ?? holderDistributionRaw?.topHolders ?? [],
      suspiciousTransfers,
      suspiciousTransferReasons,
      holderRowsAvailable: holderDataAvailable,
      lpLockBurnConfirmed: liqLpLocked,
      simulationStatus: secHoneypot === false ? 'ok' : secHoneypot === true ? 'risk' : null,
    })

    const { verdict: clarkVerdict, clarkError } = await getClarkVerdict(origin, {
      contractAddress: normalizedAddress,
      deployerAddress,
      deployerStatus,
      deployerConfidence,
      methodUsed,
      linkedWallets,
      supplyControlled,
      holderDataAvailable,
      liquidityDataAvailable,
      securityDataAvailable,
      previousActivityAvailable,
      previousProjects,
      suspiciousTransfers,
      suspiciousTransferReasons,
      warnings,
      honeypot: secHoneypot,
      buyTax: secBuyTax,
      sellTax: secSellTax,
      lpLocked: liqLpLocked,
      lpHolderConcentration: liqHolderConcentration,
      tokenName,
      tokenSymbol,
      holderTop10,
      holderTop1,
      holderCount,
      lpControlStatus,
      liquidityUsd,
      supplyControlStatus,
      linkedWalletsStatus: linkedWalletsCheckStatus,
      previousActivityStatus,
      matchedHolderCount: matchedHolderWallets.length,
    })

    const moduleDiags = [
      { name: 'contract_bytecode_check', ok: rpcStatus !== 'unavailable', detail: rpcStatus },
      { name: 'creator_heuristics', ok: deployerAddress !== null, detail: methodUsed },
      { name: 'origin_discovery', ok: deployerAddress !== null, detail: methodUsed || 'unknown' },
      { name: 'linked_wallet_heuristics', ok: linkedWallets.length > 0, detail: `count=${linkedWallets.length}` },
      { name: 'token_evidence_call', ok: tokenEvidenceResult.ok, detail: tokenEvidenceResult.reason, httpStatus: tokenEvidenceResult.httpStatus },
      { name: 'holder_evidence', ok: holderDataAvailable, detail: holderDataFromToken ? `top10=${holderTop10 != null ? parseFloat(holderTop10.toFixed(2)) : '?'}% count=${holderCount}` : (holderDataAvailable ? `controlled=${supplyControlled}%` : 'not_returned') },
      { name: 'liquidity_evidence', ok: liquidityDataAvailable, detail: lpControlStatus ? `lpControl=${lpControlStatus}` : (liquidityDataAvailable ? 'present' : 'not_returned') },
      { name: 'previous_activity', ok: previousActivityAvailable, detail: previousActivityAvailable ? `projects=${previousProjects.length}` : 'not_returned' },
      { name: 'clark_input_summary', ok: clarkVerdict !== null, detail: clarkVerdict ? `${clarkVerdict.label} (${clarkVerdict.confidence})` : (clarkError ?? 'failed') },
    ]

    const devIntel = {
      deployerAddress,
      deployerStatus,
      linkedWallets,
      creatorInTopHolders: supplyControl.creatorInTopHolders || (holderStats?.creatorInTopHolders ?? false),
      linkedWalletSupply: supplyControl.linkedWalletSupplyPercent ?? holderStats?.linkedWalletSupply ?? null,
      linkedWalletSupplyPercent: supplyControl.linkedWalletSupplyPercent ?? holderStats?.linkedWalletSupply ?? null,
      devClusterSupply: supplyControl.devClusterSupplyPercent ?? holderStats?.devClusterSupply ?? supplyControlled ?? null,
      devClusterSupplyPercent: supplyControl.devClusterSupplyPercent ?? holderStats?.devClusterSupply ?? supplyControlled ?? null,
      matchedLinkedWallets: supplyControl.matchedLinkedWallets,
      holderDistribution: holderPercentDerived.holderDistribution ?? holderDistributionRaw ?? null,
      holderDistributionStatus: holderPercentDerived.holderDistributionStatus ?? tokenHolderStatus ?? 'partial',
      holderPercentAvailable: holderPercentDerived.holderPercentAvailable,
      holderPercentSource: holderPercentDerived.holderPercentSource,
      suspiciousTransfers,
      suspiciousTransferReasons,
      reasons: [originReason, ...warnings].filter((reason): reason is string => Boolean(reason)),
      confidence: (tokenEvidence || holderDataAvailable) ? 'medium' : 'low',
      supplyControl,
      clusterMap,
    }

    const responsePayload = {
      contractAddress: normalizedAddress,
      chain: activeChainConfig.chain,
      chainLabel: activeChainConfig.chainLabel,
      name: tokenName ?? null,
      symbol: tokenSymbol ?? null,
      devIntel,
      deployerAddress,
      deployerConfidence,
      methodUsed,
      linkedWallets,
      holderDistribution: holderPercentDerived.holderDistribution ?? holderDistributionRaw ?? null,
      holderDistributionStatus: holderPercentDerived.holderDistributionStatus ?? tokenHolderStatus ?? 'partial',
      holderPercentAvailable: holderPercentDerived.holderPercentAvailable,
      holderPercentSource: holderPercentDerived.holderPercentSource,
      topHolders: holderPercentDerived.holderDistribution?.topHolders ?? holderDistributionRaw?.topHolders ?? [],
      top1: holderTop1 ?? null,
      top10: holderTop10 ?? null,
      top20: holderTop20 ?? null,
      holderCount: holderCount ?? null,
      creatorInTopHolders: supplyControl.creatorInTopHolders || (holderStats?.creatorInTopHolders ?? false),
      linkedWalletSupply: supplyControl.linkedWalletSupplyPercent ?? holderStats?.linkedWalletSupply ?? null,
      devClusterSupply: supplyControl.devClusterSupplyPercent ?? holderStats?.devClusterSupply ?? supplyControlled ?? null,
      supplyControl,
      clusterMap,
      liquidity: liquidityUsd ?? null,
      volume24h: typeof market.volume24h === 'number' ? (market.volume24h as number) : null,
      matchedHolderWallets,
      previousActivityAvailable,
      previousActivityStatus,
      previousProjects,
      suspiciousTransfers,
      suspiciousTransferReasons,
      clarkVerdict,
      tokenStatus: tokenEvidence ? 'ok' : (bytecode && bytecode !== '0x' ? 'partial' : 'limited_check'),
      marketStatus: tokenEvidence && market && Object.keys(market).length ? 'ok' : 'partial',
      deployerStatus,
      creationTxHash,
      originReason,
      supplyControlStatus,
      linkedWalletsStatus: linkedWalletsCheckStatus,
      liquidityStatus: liquidityDataAvailable ? 'ok' : 'partial',
      lpControlStatus: lpControlStatus ? 'ok' : 'partial',
      lpControl: {
        status: toCanonical(lpControlStatus) as CanonicalStatus,
        rawState: lpControlStatus ?? 'unknown',
        rawLpState: lpControlStatus ?? 'unknown',
        reason: (lpControlObj as Record<string, unknown> | null)?.reason as string | null ?? null,
      },
      verdict: (suspiciousTransfers || (holderTop10 != null && holderTop10 > 50) || liqLpLocked === false || secHoneypot === true)
        ? 'CAUTION'
        : (tokenEvidence || holderDataAvailable || liquidityDataAvailable || Boolean(bytecode && bytecode !== '0x'))
          ? 'WATCH'
          : 'UNKNOWN',
      confidence: (tokenEvidence || holderDataAvailable) ? 'medium' : 'low',
      reasons: [
        !deployerAddress && (tokenEvidence || holderDataAvailable || liquidityDataAvailable) ? 'Creator not confirmed from current checks; token evidence still indicates watchlist-level signal.' : '',
        deployerAddress && !holderDataAvailable ? 'Origin wallet was likely found, but holder distribution could not confirm supply control.' : '',
        holderTop10 != null && holderTop10 >= 70 ? `Very high holder concentration — top 10 hold ${parseFloat(holderTop10.toFixed(2))}%.` : holderTop10 != null && holderTop10 >= 50 ? `High holder concentration — top 10 hold ${parseFloat(holderTop10.toFixed(2))}%.` : '',
        liqLpLocked === false ? 'LP appears team-controlled.' : '',
      ].filter(Boolean),
      warnings,
      ...(debugMode ? {
        _diagnostics: {
          modules: moduleDiags,
          rpcConfigured: Boolean(activeChainConfig.rpcUrl),
          rpcStatus,
          providerUsed,
          tokenEvidenceDiag: { attempted: tokenEvidenceResult.attempted, ok: tokenEvidenceResult.ok, httpStatus: tokenEvidenceResult.httpStatus, reason: tokenEvidenceResult.reason },
          metadataSource: (meta.diag?.metadataSource as string | undefined) ?? (meta.diag?.source as string | undefined) ?? 'unknown',
          tokenNameResolved,
          tokenSymbolResolved,
          tokenScannerMetadataUsed,
          holderSource: holderDataFromToken ? 'token_scanner_holder_distribution' : (holderDataFromCovalent ? 'covalent_fallback' : 'none'),
          holderRowsCount: holderDistributionRaw?.topHolders?.length ?? holderStats?.holderCount ?? 0,
          holderPercentAvailable: holderPercentDerived.holderPercentAvailable,
          holderDistributionStatus: holderPercentDerived.holderDistributionStatus ?? tokenHolderStatus ?? (holderDataAvailable ? ((holderTop10 != null || holderTop1 != null || holderTop20 != null) ? 'ok' : 'partial') : 'unavailable_with_reason'),
          holderPercentSource: holderPercentDerived.holderPercentSource,
          holderPercentDebug: holderPercentDerived.debug,
          supplyControlDebug,
          creatorLookupAttempted: Boolean(originDiag && originDiag.optional_creation_lookup?.attempted),
          creatorStatus: deployerStatus,
          supplySurfaceState: supplyControlStatus,
          origin_discovery: originDiag ?? { skipped: true },
          post_deployer_intelligence: {
            linked_wallets: {
              attempted: linkedWalletsDiag.attempted,
              ok: linkedWalletsDiag.ok,
              status: linkedWalletsCheckStatus,
              itemCount: linkedWallets.length,
              tokenTransfersFound: linkedWalletsDiag.tokenTransfersFound,
              ethTransfersFound: linkedWalletsDiag.ethTransfersFound,
              totalCandidates: linkedWalletsDiag.totalCandidates,
              firstItemKeys: linkedWallets.slice(0, 2).map(w => ({
                address: w.address, confidence: w.confidence, reason: w.reason,
                overlapRank: w.overlapTopHolderRank ?? null,
              })),
              reason: linkedWalletsDiag.reason,
            },
            transfer_analysis: {
              attempted: deployerAddress !== null,
              ok: true,
              suspicious: suspiciousTransfers,
              reasonCount: suspiciousTransferReasons.length,
              reasons: suspiciousTransferReasons,
            },
            previous_activity: {
              attempted: deployerAddress !== null,
              ok: previousActivityAvailable,
              status: previousActivityStatus,
              itemCount: previousProjects.length,
              firstItemKeys: previousProjects.slice(0, 2).map(p => ({
                contractAddress: p.contractAddress, createdAt: p.createdAt,
              })),
              reason: previousActivityStatus,
            },
            supply_control: {
              attempted: holderDataAvailable,
              ok: supplyControlled !== null,
              status: supplyControlStatus,
              matchedCount: matchedHolderWallets.length,
              percent: supplyControlled,
              deployerInTopHolders: matchedHolderWallets.some(h => h.isDeployer),
              linkedWalletsInTopHolders: matchedHolderWallets.filter(h => h.isLinked).length,
              reason: supplyControlStatus,
            },
          },
          metadataDiagnostics: meta.diag,
          holderDiagnostics: holderDiag ?? { chainUsed: activeChainConfig.covalentChain, attempted: false, reason: 'no_holder_diag' },
          holderLookupAttempted: Boolean(holderDataFromToken || holderDiag?.attempted),
          holderStatus: holderDataAvailable ? ((holderTop10 != null || holderTop1 != null || holderTop20 != null) ? 'ok' : 'partial') : 'open_check',
          topHolderRows: holderDistributionRaw?.topHolders?.length ?? holderStats?.holderCount ?? 0,
          topPercentAvailable: holderTop1 != null || holderTop10 != null || holderTop20 != null,
        },
      } : {}),
      fetchedAt: new Date().toISOString(),
    }
    if (debug) {
      ;(responsePayload as Record<string, unknown>)._debug = {
        hasBearer: planRes.hasBearer,
        userPresent: planRes.userPresent,
        settingsRowFound: planRes.settingsRowFound,
        routeName: '/api/dev-wallet',
        cacheHit: false,
        alchemyConfigured: Boolean(activeChainConfig.rpcUrl),
        alchemyCallsAttempted: 1,
        alchemyCallsSucceeded: rpcStatus === 'ok' ? 1 : 0,
        alchemyCallsFailed: rpcStatus === 'unavailable' ? 1 : 0,
        rpcMethodsUsed: ['eth_getCode', 'alchemy_getAssetTransfers', 'eth_getTransactionReceipt'],
        skippedReason: activeChainConfig.rpcUrl ? null : 'rpc_not_configured',
        fallbackUsed: tokenEvidenceResult.ok === false || linkedWalletsCheckStatus !== 'ok',
        requestDurationMs: Date.now() - startedAt,
        rawPlan: planRes.rawPlan,
        effectivePlan: planRes.effectivePlan,
        trialActive: planRes.trialActive,
        trialEndsAt: planRes.trialEndsAt,
        gateDecision: planRes.gateDecision,
        holderRowsCount: holderDistributionRaw?.topHolders?.length ?? 0,
        holderRowsHaveBalances: (holderDistributionRaw?.topHolders?.length ?? 0) > 0,
        totalSupplyResolved: holderTop1 != null || holderTop10 != null,
        totalSupplySource: tokenHolderPercentSource,
        percentDerivationAttempted: tokenHolderStatus !== null,
        percentDerivationReason: typeof holderStatusRaw?.reason === 'string' ? holderStatusRaw.reason : null,
        top1: holderTop1 ?? null,
        top10: holderTop10 ?? null,
        top20: holderTop20 ?? null,
      }
    }
    devCache.set(cacheKey, { exp: Date.now() + DEV_CACHE_TTL_MS, payload: responsePayload })
    return NextResponse.json(responsePayload)
  } catch (err) {
    console.error('[dev-wallet] fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// GET handler: reads contractAddress/address and chain from query params and delegates to POST.
// Supports: GET /api/dev-wallet?address=0x...&chain=base
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const contractAddress = url.searchParams.get('contractAddress') || url.searchParams.get('address') || ''
  const chain = url.searchParams.get('chain') || 'base'
  const syntheticReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify({ contractAddress, chain }),
  })
  return POST(syntheticReq)
}

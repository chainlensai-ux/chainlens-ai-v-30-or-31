// TOKEN SCANNER DEV MAP / CLUSTER DIAGNOSIS — SHARED, DISCLOSED.
//
// Pure classification for Token Scanner Dev Map + Cluster Wallets.
// No network. Missing holders are NEVER treated as 0%. Factory is NEVER the origin wallet.
// "0 mapped" is only valid after the linked-wallet graph actually ran.

import {
  classifyTokenScannerEvidence,
  DEV_SUPPLY_DEPLOYER_UNRESOLVED,
  linkedWalletGraphLabel,
  NOT_IN_INDEXED_HOLDER_ROWS,
} from './tokenScannerEvidence'

export const DEV_CLUSTER_CHAIN_IDS = {
  eth: 1,
  base: 8453,
  bnb: 56,
  polygon: 137,
  robinhood: 4663,
} as const

export type DevClusterChainSlug = keyof typeof DEV_CLUSTER_CHAIN_IDS

export type DevMapStatus =
  | 'verified'
  | 'partial'
  | 'not_verified'
  | 'unavailable_with_reason'
  | 'not_applicable'

export type DevClusterConfidence = 'high' | 'medium' | 'low'

export type LinkedWalletGraphStatus =
  | 'ran_found'
  | 'ran_none'
  | 'not_run'
  | 'unavailable'

export interface AlchemyRpcHealth {
  attempted: boolean
  ok: boolean
  errorCode: string | null
  errorMessage: string | null
  rateLimited: boolean
  billingDisabled: boolean
  timeout: boolean
  skipped: boolean
  skipReason: string | null
  health: 'healthy' | 'billing_disabled' | 'rate_limited' | 'timeout' | 'chain_not_supported' | 'invalid_param' | 'failed' | 'not_attempted'
}

export interface ProviderRowsHealth {
  attempted: boolean
  ok: boolean
  rowsReturned: number
  errorMessage: string | null
  health: 'healthy' | 'failed' | 'unsupported' | 'not_attempted'
}

export interface DevClusterCacheHealth {
  hit: boolean
  key: string
  chainMatched: boolean
}

export interface DeployerResolutionAudit {
  attempted: boolean
  sourcesTried: string[]
  contractCreatorFound: boolean
  creationTxHash: string | null
  factoryDetected: boolean
  factoryAddress: string | null
  deployerAddress: string | null
  originWallet: string | null
  confidence: DevClusterConfidence
  failureReason: string | null
}

export interface HolderResolutionAudit {
  attempted: boolean
  sourcesTried: string[]
  holderRowsReturned: number
  top1Pct: number | null
  top10Pct: number | null
  top20Pct: number | null
  creatorInTopHolders: boolean | null
  holdersSource: 'goldrush' | 'alchemy' | 'blockscout' | 'transfer_derived' | 'existing' | 'none'
  failureReason: string | null
}

export interface LinkedWalletGraphAudit {
  attempted: boolean
  fundingGraphAttempted: boolean
  tokenTransferGraphAttempted: boolean
  firstReceiversChecked: number
  deployerFundersChecked: number
  repeatedWalletsChecked: number
  walletsMapped: number | null
  linkedWalletSupplyPct: number | null
  confidence: DevClusterConfidence
  graphStatus: LinkedWalletGraphStatus
  failureReason: string | null
  linkedWalletsSource: 'goldrush' | 'alchemy' | 'blockscout' | 'existing' | 'none'
}

export interface DevClusterDiagnosisAudit {
  chainId: number
  chainSlug: string
  tokenAddress: string
  providerHealth: {
    alchemyRpc: AlchemyRpcHealth
    blockscout: ProviderRowsHealth
    goldrush: ProviderRowsHealth
    supabaseCache: DevClusterCacheHealth
  }
  deployerResolution: DeployerResolutionAudit
  holderResolution: HolderResolutionAudit
  linkedWalletGraph: LinkedWalletGraphAudit
  finalDevMapStatus: DevMapStatus
  finalClusterStatus: DevMapStatus
  finalReason: string
}

export interface DevClusterTransfer {
  from: string | null
  to: string | null
  amountRaw?: string | number | null
  txHash?: string | null
  timestamp?: string | number | null
  asset?: string | null
  category?: 'erc20' | 'external' | string | null
}

export interface DevClusterHolderRow {
  address: string
  percent: number | null
  balanceRaw?: string | null
  rank?: number | null
}

export interface DevClusterLinkedWallet {
  address: string
  reason: string
  confidence: DevClusterConfidence
  amountReceived?: number | null
  asset?: string | null
  txHash?: string | null
  firstSeen?: string | null
}

export interface DevMapUiLabels {
  deployerLabel: string
  deployerChip: string
  linkedLabel: string
  linkedCountDisplay: string
  supplyControlLabel: string
  creatorInTopLabel: string
  top1Label: string
  top10Label: string
  top20Label: string
  linkedWalletSupplyLabel: string
  clusterSupplyLabel: string
  dominanceLabel: string
  originChip: string
  originPendingText: string
  linkedEmptyTitle: string
  linkedEmptyBody: string
  clusterRiskScoreLabel: string
  watchPlanSummary: string
  statusLabel: string
}

const ZERO = '0x0000000000000000000000000000000000000000'
const DEAD = '0x000000000000000000000000000000000000dead'

export function normalizeDevClusterAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const n = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(n) ? n : null
}

export function isUsableDevClusterWallet(address: string | null | undefined, tokenAddress: string): address is string {
  const n = normalizeDevClusterAddress(address)
  const token = normalizeDevClusterAddress(tokenAddress)
  if (!n || !token) return false
  if (n === ZERO || n === DEAD) return false
  if (n === token) return false
  return true
}

export function buildDevClusterCacheKey(chainId: number, tokenAddress: string): string {
  return `devCluster:${chainId}:${String(tokenAddress).toLowerCase()}`
}

export function isDevClusterCacheHitValid(
  cached: { chainId: number; tokenAddress: string },
  selected: { chainId: number; tokenAddress: string },
): boolean {
  const cachedAddr = normalizeDevClusterAddress(cached.tokenAddress)
  const selectedAddr = normalizeDevClusterAddress(selected.tokenAddress)
  return cached.chainId === selected.chainId && cachedAddr != null && cachedAddr === selectedAddr
}

export function emptyAlchemyRpcHealth(): AlchemyRpcHealth {
  return {
    attempted: false,
    ok: false,
    errorCode: null,
    errorMessage: null,
    rateLimited: false,
    billingDisabled: false,
    timeout: false,
    skipped: false,
    skipReason: null,
    health: 'not_attempted',
  }
}

export function emptyProviderRowsHealth(): ProviderRowsHealth {
  return {
    attempted: false,
    ok: false,
    rowsReturned: 0,
    errorMessage: null,
    health: 'not_attempted',
  }
}

export function emptyDevClusterDiagnosisAudit(chainId: number, chainSlug: string, tokenAddress: string): DevClusterDiagnosisAudit {
  return {
    chainId,
    chainSlug,
    tokenAddress: String(tokenAddress).toLowerCase(),
    providerHealth: {
      alchemyRpc: emptyAlchemyRpcHealth(),
      blockscout: emptyProviderRowsHealth(),
      goldrush: emptyProviderRowsHealth(),
      supabaseCache: { hit: false, key: buildDevClusterCacheKey(chainId, tokenAddress), chainMatched: true },
    },
    deployerResolution: {
      attempted: false,
      sourcesTried: [],
      contractCreatorFound: false,
      creationTxHash: null,
      factoryDetected: false,
      factoryAddress: null,
      deployerAddress: null,
      originWallet: null,
      confidence: 'low',
      failureReason: 'not_attempted',
    },
    holderResolution: {
      attempted: false,
      sourcesTried: [],
      holderRowsReturned: 0,
      top1Pct: null,
      top10Pct: null,
      top20Pct: null,
      creatorInTopHolders: null,
      holdersSource: 'none',
      failureReason: 'not_attempted',
    },
    linkedWalletGraph: {
      attempted: false,
      fundingGraphAttempted: false,
      tokenTransferGraphAttempted: false,
      firstReceiversChecked: 0,
      deployerFundersChecked: 0,
      repeatedWalletsChecked: 0,
      walletsMapped: null,
      linkedWalletSupplyPct: null,
      confidence: 'low',
      graphStatus: 'not_run',
      failureReason: 'not_attempted',
      linkedWalletsSource: 'none',
    },
    finalDevMapStatus: 'unavailable_with_reason',
    finalClusterStatus: 'unavailable_with_reason',
    finalReason: 'Waiting on provider',
  }
}

export interface AlchemyErrorInput {
  httpStatus?: number | null
  jsonError?: { code?: unknown; message?: unknown } | string | null
  message?: string | null
  timedOut?: boolean
}

function errorText(input: AlchemyErrorInput): string {
  if (typeof input.jsonError === 'string') return input.jsonError
  if (input.jsonError && typeof input.jsonError === 'object') {
    const msg = input.jsonError.message
    if (typeof msg === 'string') return msg
  }
  return typeof input.message === 'string' ? input.message : ''
}

function errorCodeOf(input: AlchemyErrorInput): string | null {
  if (input.jsonError && typeof input.jsonError === 'object' && input.jsonError.code != null) {
    return String(input.jsonError.code)
  }
  if (input.httpStatus != null) return String(input.httpStatus)
  return null
}

// Alchemy 400 / invalid-param / chain-not-supported must skip, never retry, never land as graph-ran.
export function classifyAlchemyRpcError(input: AlchemyErrorInput): AlchemyRpcHealth {
  const text = errorText(input).toLowerCase()
  const code = errorCodeOf(input)
  const http = input.httpStatus ?? null
  const base: AlchemyRpcHealth = {
    attempted: true,
    ok: false,
    errorCode: code,
    errorMessage: errorText(input) || (http != null ? `http_${http}` : null),
    rateLimited: false,
    billingDisabled: false,
    timeout: false,
    skipped: false,
    skipReason: null,
    health: 'failed',
  }

  if (input.timedOut || /timeout|timed out|aborted|abort/.test(text)) {
    return { ...base, timeout: true, skipped: true, skipReason: 'timeout', health: 'timeout', errorCode: code ?? 'timeout' }
  }
  if (http === 429 || /429|rate limit|too many requests|over rate/.test(text)) {
    return { ...base, rateLimited: true, skipped: true, skipReason: 'rate_limited', health: 'rate_limited', errorCode: code ?? '429' }
  }
  if (
    http === 402 ||
    /billing|payment required|monthly capacity|compute units|exceeded the|quota|disabled/.test(text)
  ) {
    return { ...base, billingDisabled: true, skipped: true, skipReason: 'billing_disabled', health: 'billing_disabled', errorCode: code ?? '402' }
  }
  const invalidParam =
    http === 400 ||
    code === '-32602' ||
    code === '-32600' ||
    /invalid.?param|invalid argument|parse error/.test(text)
  const chainUnsupported =
    /chain[- ]?not[- ]?supported|unsupported chain|method not found|does not exist\/is not available/.test(text) ||
    code === '-32601'
  if (chainUnsupported) {
    return {
      ...base,
      skipped: true,
      skipReason: 'chain_not_supported',
      health: 'chain_not_supported',
      errorCode: code ?? 'chain_not_supported',
    }
  }
  if (invalidParam) {
    return {
      ...base,
      skipped: true,
      skipReason: 'invalid_param',
      health: 'invalid_param',
      errorCode: code ?? '400',
    }
  }
  return base
}

export function alchemyShouldSkipAndNotRetry(health: AlchemyRpcHealth): boolean {
  return health.skipped === true
}

export function separateFactoryAndOrigin(input: {
  creatorAddress: string | null | undefined
  creatorIsContract?: boolean | null
  creationTxFrom?: string | null
  tokenAddress: string
}): { factoryAddress: string | null; originAddress: string | null; factoryDetected: boolean } {
  const token = input.tokenAddress
  const creator = isUsableDevClusterWallet(input.creatorAddress ?? null, token) ? normalizeDevClusterAddress(input.creatorAddress) : null
  const txFrom = isUsableDevClusterWallet(input.creationTxFrom ?? null, token) ? normalizeDevClusterAddress(input.creationTxFrom) : null

  if (!creator) {
    return { factoryAddress: null, originAddress: txFrom, factoryDetected: false }
  }
  if (input.creatorIsContract === true) {
    const origin = txFrom && txFrom !== creator ? txFrom : null
    return { factoryAddress: creator, originAddress: origin, factoryDetected: true }
  }
  return { factoryAddress: null, originAddress: creator, factoryDetected: false }
}

function parseAmount(value: string | number | null | undefined): bigint | null {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    try { return BigInt(Math.trunc(value)) } catch { return null }
  }
  const raw = String(value).trim()
  if (!raw) return null
  try {
    if (raw.startsWith('0x')) return BigInt(raw)
    if (/^\d+$/.test(raw)) return BigInt(raw)
    const asNum = Number(raw)
    if (Number.isFinite(asNum) && asNum >= 0) return BigInt(Math.trunc(asNum))
  } catch { /* ignore */ }
  return null
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100
}

export interface TransferDerivedConcentration {
  top1Pct: number | null
  top10Pct: number | null
  top20Pct: number | null
  rows: DevClusterHolderRow[]
  partial: true
  source: 'transfer_derived'
  observedWallets: number
}

// Reconstruct concentration from transfers. Partial by definition. Never fake 0% from missing rows.
export function deriveHolderConcentrationFromTransfers(
  transfers: DevClusterTransfer[],
  tokenAddress: string,
  totalSupplyRaw?: string | number | null,
): TransferDerivedConcentration | null {
  const nets = new Map<string, bigint>()
  for (const t of transfers) {
    const from = normalizeDevClusterAddress(t.from)
    const to = normalizeDevClusterAddress(t.to)
    const amount = parseAmount(t.amountRaw ?? null) ?? BigInt(1)
    if (isUsableDevClusterWallet(to, tokenAddress)) {
      nets.set(to, (nets.get(to) ?? BigInt(0)) + amount)
    }
    if (isUsableDevClusterWallet(from, tokenAddress)) {
      nets.set(from, (nets.get(from) ?? BigInt(0)) - amount)
    }
  }

  const positive = [...nets.entries()]
    .filter(([, v]) => v > BigInt(0))
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))

  if (positive.length === 0) return null

  const supply = parseAmount(totalSupplyRaw ?? null)
  const observed = positive.reduce((acc, [, v]) => acc + v, BigInt(0))
  const denom = supply && supply > BigInt(0) ? supply : observed
  if (denom <= BigInt(0)) return null

  const pctOf = (n: bigint) => roundPct(Number((n * BigInt(10000)) / denom) / 100)
  const rows: DevClusterHolderRow[] = positive.slice(0, 20).map(([address, net], i) => ({
    address,
    percent: pctOf(net),
    balanceRaw: net.toString(),
    rank: i + 1,
  }))

  const sumN = (n: number) => {
    const slice = positive.slice(0, n)
    if (slice.length === 0) return null
    const total = slice.reduce((acc, [, v]) => acc + v, BigInt(0))
    return pctOf(total)
  }

  return {
    top1Pct: sumN(1),
    top10Pct: sumN(10),
    top20Pct: sumN(20),
    rows,
    partial: true,
    source: 'transfer_derived',
    observedWallets: positive.length,
  }
}

export function creatorInTopHoldersFromRows(
  holders: DevClusterHolderRow[],
  originAddress: string | null,
): boolean | null {
  if (!originAddress || holders.length === 0) return null
  const origin = normalizeDevClusterAddress(originAddress)
  if (!origin) return null
  return holders.some((h) => normalizeDevClusterAddress(h.address) === origin)
}

export function clusterSupplyFromHolders(
  holders: DevClusterHolderRow[],
  originAddress: string | null,
  linkedWallets: Array<{ address: string }>,
): number | null {
  if (holders.length === 0 || holders.every((h) => h.percent == null)) return null
  const actors = new Set<string>()
  const origin = normalizeDevClusterAddress(originAddress)
  if (origin) actors.add(origin)
  for (const w of linkedWallets) {
    const a = normalizeDevClusterAddress(w.address)
    if (a) actors.add(a)
  }
  if (actors.size === 0) return null
  let sum = 0
  let matched = false
  for (const h of holders) {
    const a = normalizeDevClusterAddress(h.address)
    if (!a || !actors.has(a) || h.percent == null || !Number.isFinite(h.percent)) continue
    sum += h.percent
    matched = true
  }
  if (!matched) return null
  return roundPct(sum)
}

export function linkedWalletsFromTransfers(input: {
  transfers: DevClusterTransfer[]
  originAddress: string | null
  tokenAddress: string
  topHolderAddresses?: string[]
}): { wallets: DevClusterLinkedWallet[]; firstReceiversChecked: number; deployerFundersChecked: number; repeatedWalletsChecked: number } {
  const origin = normalizeDevClusterAddress(input.originAddress)
  const excluded = new Set<string>()
  const token = normalizeDevClusterAddress(input.tokenAddress)
  if (token) excluded.add(token)
  excluded.add(ZERO)
  excluded.add(DEAD)
  if (origin) excluded.add(origin)

  const counts = new Map<string, { tokenFromOrigin: number; fundedByOrigin: number; fundedOrigin: number; txHash: string | null; firstSeen: string | number | null; amount: number }>()
  const bump = (addr: string, field: 'tokenFromOrigin' | 'fundedByOrigin' | 'fundedOrigin', t: DevClusterTransfer) => {
    const n = normalizeDevClusterAddress(addr)
    if (!n || excluded.has(n)) return
    const cur = counts.get(n) ?? { tokenFromOrigin: 0, fundedByOrigin: 0, fundedOrigin: 0, txHash: null, firstSeen: null, amount: 0 }
    cur[field] += 1
    if (!cur.txHash && t.txHash) cur.txHash = t.txHash
    if (cur.firstSeen == null && t.timestamp != null) cur.firstSeen = t.timestamp
    const amt = typeof t.amountRaw === 'number' ? t.amountRaw : Number(t.amountRaw)
    if (Number.isFinite(amt)) cur.amount += amt
    counts.set(n, cur)
  }

  let firstReceiversChecked = 0
  let deployerFundersChecked = 0
  for (const t of input.transfers) {
    const from = normalizeDevClusterAddress(t.from)
    const to = normalizeDevClusterAddress(t.to)
    const isExternal = t.category === 'external' || (t.asset != null && t.asset !== 'erc20' && String(t.asset).toUpperCase() === 'ETH')
    if (origin && from === origin && to) {
      if (isExternal) bump(to, 'fundedByOrigin', t)
      else {
        bump(to, 'tokenFromOrigin', t)
        firstReceiversChecked += 1
      }
    }
    if (origin && to === origin && from) {
      deployerFundersChecked += 1
      bump(from, 'fundedOrigin', t)
    }
  }

  const holderSet = new Set((input.topHolderAddresses ?? []).map((a) => normalizeDevClusterAddress(a)).filter(Boolean) as string[])
  const wallets: DevClusterLinkedWallet[] = []
  let repeatedWalletsChecked = 0
  for (const [address, rec] of counts) {
    const interactions = rec.tokenFromOrigin + rec.fundedByOrigin + rec.fundedOrigin
    if (interactions >= 2) repeatedWalletsChecked += 1
    const inHolders = holderSet.has(address)
    if (rec.tokenFromOrigin === 0 && rec.fundedByOrigin === 0 && rec.fundedOrigin === 0 && !inHolders) continue
    const reason = rec.tokenFromOrigin > 0
      ? 'first_token_receiver_from_origin'
      : rec.fundedByOrigin > 0
        ? 'funded_by_origin'
        : rec.fundedOrigin > 0
          ? 'origin_funder'
          : 'top_holder_direct_transfer'
    const confidence: DevClusterConfidence = rec.tokenFromOrigin > 0 && (inHolders || interactions >= 2)
      ? 'high'
      : rec.tokenFromOrigin > 0 || rec.fundedByOrigin > 0
        ? 'medium'
        : 'low'
    wallets.push({
      address,
      reason,
      confidence,
      amountReceived: rec.amount || null,
      asset: rec.tokenFromOrigin > 0 ? 'token' : 'native',
      txHash: rec.txHash,
      firstSeen: rec.firstSeen != null ? String(rec.firstSeen) : null,
    })
  }
  wallets.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 }
    return rank[a.confidence] - rank[b.confidence]
  })
  return {
    wallets: wallets.slice(0, 20),
    firstReceiversChecked,
    deployerFundersChecked,
    repeatedWalletsChecked,
  }
}

export function dominanceFromClusterSupply(pct: number | null): 'none' | 'low' | 'medium' | 'high' | 'critical' | 'unknown' {
  if (pct == null || !Number.isFinite(pct)) return 'unknown'
  if (pct === 0) return 'none'
  if (pct < 5) return 'low'
  if (pct < 10) return 'medium'
  if (pct < 20) return 'high'
  return 'critical'
}

export function classifyDevMapStatus(input: {
  originAddress: string | null
  factoryDetected: boolean
  originConfidence: DevClusterConfidence
  holdersAttempted: boolean
  holderRows: number
  graphStatus: LinkedWalletGraphStatus
}): DevMapStatus {
  if (input.originAddress && input.originConfidence === 'high') return 'verified'
  if (input.originAddress) return 'partial'
  if (!input.holdersAttempted && input.graphStatus === 'not_run') return 'unavailable_with_reason'
  return 'not_verified'
}

export function classifyClusterStatus(input: {
  graphStatus: LinkedWalletGraphStatus
  walletsMapped: number | null
  clusterSupplyPercent: number | null
  holderRows: number
}): DevMapStatus {
  if (input.graphStatus === 'not_run' || input.graphStatus === 'unavailable') return 'unavailable_with_reason'
  if (input.graphStatus === 'ran_none') return 'verified'
  if (input.graphStatus === 'ran_found' && (input.clusterSupplyPercent != null || input.walletsMapped != null)) {
    return input.clusterSupplyPercent != null ? 'verified' : 'partial'
  }
  if (input.holderRows === 0) return 'unavailable_with_reason'
  return 'not_verified'
}

function statusLabel(status: DevMapStatus, reason?: string | null): string {
  switch (status) {
    case 'verified': return 'Verified'
    case 'partial': return 'Partial'
    case 'not_verified': return reason ? `Not verified: ${reason}` : 'Not verified'
    case 'unavailable_with_reason': return reason ? `Unavailable: ${reason}` : 'Unavailable'
    case 'not_applicable': return 'Not applicable'
  }
}

export function linkedWalletDisplayLabel(graph: LinkedWalletGraphAudit): string {
  return linkedWalletGraphLabel(graph.graphStatus, graph.failureReason, graph.walletsMapped)
}

export interface DevMapHolderOverlay {
  holdersVerified?: boolean
  holderRowsReturned?: number
  top1Pct?: number | null
  top10Pct?: number | null
  top20Pct?: number | null
}

export function buildDevMapUiLabels(audit: DevClusterDiagnosisAudit, overlay?: DevMapHolderOverlay): DevMapUiLabels {
  const d = audit.deployerResolution
  const h = audit.holderResolution
  const g = audit.linkedWalletGraph
  const originVerified = Boolean(d.originWallet) && d.confidence === 'high' && d.contractCreatorFound
  const originPartial = Boolean(d.originWallet) && !originVerified
  const holdersVerified = overlay?.holdersVerified === true
    || ((overlay?.holderRowsReturned ?? h.holderRowsReturned) > 0 && (
      (overlay?.top1Pct ?? h.top1Pct) != null
      || (overlay?.top10Pct ?? h.top10Pct) != null
      || (overlay?.top20Pct ?? h.top20Pct) != null
    ))
  const holderRowsReturned = overlay?.holderRowsReturned ?? h.holderRowsReturned
  const top1Pct = overlay?.top1Pct ?? h.top1Pct
  const top10Pct = overlay?.top10Pct ?? h.top10Pct
  const top20Pct = overlay?.top20Pct ?? h.top20Pct

  const evidence = classifyTokenScannerEvidence({
    holdersVerified,
    holderRows: [],
    deployerAddress: d.originWallet,
    graphStatus: g.graphStatus,
    graphFailureReason: g.failureReason,
    walletsMapped: g.walletsMapped,
    chainId: audit.chainId,
    chainSlug: audit.chainSlug,
  })

  const deployerLabel = originVerified
    ? 'Confirmed'
    : originPartial
      ? `Partial: ${d.sourcesTried[d.sourcesTried.length - 1] ?? 'creation evidence'}`
      : d.failureReason
        ? (d.failureReason.includes('Waiting') ? `Waiting for holder/deployer evidence: ${d.failureReason}` : 'Origin wallet not verified')
        : 'Origin wallet not verified'

  const deployerChip = originVerified ? 'Confirmed' : originPartial ? 'Partial' : 'Origin wallet not verified'

  const needsHolders = !holdersVerified && holderRowsReturned === 0
  const needsCreator = !d.originWallet
  const evidenceGap = needsHolders
    ? 'Needs holder evidence'
    : needsCreator
      ? (holdersVerified ? DEV_SUPPLY_DEPLOYER_UNRESOLVED : 'Needs creator tx evidence')
      : g.graphStatus === 'not_run' || g.graphStatus === 'unavailable'
        ? evidence.labels.linkedWallets
        : null

  const supplyControlLabel = h.top1Pct != null || audit.linkedWalletGraph.linkedWalletSupplyPct != null || (g.walletsMapped != null && d.originWallet && !needsHolders)
    ? (audit.linkedWalletGraph.linkedWalletSupplyPct != null
      ? `${audit.linkedWalletGraph.linkedWalletSupplyPct.toFixed(1)}% cluster`
      : clusterSupplyLabelFromAudit(audit, holdersVerified))
    : evidenceGap ?? evidence.labels.supplyControl

  const creatorInTopLabel = h.creatorInTopHolders == null
    ? (needsHolders ? 'Needs holder evidence' : needsCreator ? (holdersVerified ? DEV_SUPPLY_DEPLOYER_UNRESOLVED : 'Needs creator tx evidence') : 'Not verified')
    : h.creatorInTopHolders ? 'Yes' : 'No'

  const pctOrDash = (v: number | null, missing: string) => v != null ? `${v.toFixed(1)}%` : missing
  const holderMissing = needsHolders ? 'Needs holder evidence' : (needsCreator && holdersVerified ? DEV_SUPPLY_DEPLOYER_UNRESOLVED : 'Not verified')
  const clusterSupply = audit.linkedWalletGraph.linkedWalletSupplyPct
  const dominance = dominanceFromClusterSupply(clusterSupply)
  const dominanceLabel = dominance === 'unknown'
    ? (evidenceGap ?? 'Not verified')
    : dominance === 'none'
      ? 'No dominance'
      : `${dominance.charAt(0).toUpperCase()}${dominance.slice(1)} dominance`

  const linkedLabel = evidence.labels.linkedWallets
  const graphNotRun = g.graphStatus === 'not_run' || g.graphStatus === 'unavailable'

  return {
    deployerLabel,
    deployerChip,
    linkedLabel,
    linkedCountDisplay: g.graphStatus === 'ran_found' && (g.walletsMapped ?? 0) > 0
      ? String(g.walletsMapped)
      : g.graphStatus === 'ran_none'
        ? '0'
        : '—',
    supplyControlLabel,
    creatorInTopLabel,
    top1Label: pctOrDash(top1Pct, holderMissing),
    top10Label: pctOrDash(top10Pct, holderMissing),
    top20Label: pctOrDash(top20Pct, holderMissing),
    linkedWalletSupplyLabel: pctOrDash(g.linkedWalletSupplyPct, graphNotRun ? linkedLabel : holderMissing),
    clusterSupplyLabel: pctOrDash(clusterSupply, evidenceGap ?? evidence.labels.clusterSupply),
    dominanceLabel,
    originChip: deployerChip,
    originPendingText: d.originWallet
      ? ''
      : (d.failureReason ? `Origin wallet not verified. ${d.failureReason}` : 'Origin wallet not verified'),
    linkedEmptyTitle: evidence.labels.linkedWalletsEmptyTitle,
    linkedEmptyBody: evidence.labels.linkedWalletsEmptyBody,
    clusterRiskScoreLabel: clusterSupply == null ? (evidenceGap ?? 'Not verified') : '—',
    watchPlanSummary: [
      originVerified ? 'Deployer confirmed' : originPartial ? 'Deployer partial' : 'Origin wallet not verified',
      linkedLabel,
      clusterSupply != null ? `Dev cluster supply ${clusterSupply.toFixed(1)}%` : (evidenceGap ?? evidence.labels.clusterSupply),
    ].join('. ') + '.',
    statusLabel: statusLabel(audit.finalDevMapStatus, audit.finalReason),
  }
}

function clusterSupplyLabelFromAudit(audit: DevClusterDiagnosisAudit, holdersVerified = false): string {
  const pct = audit.linkedWalletGraph.linkedWalletSupplyPct
  if (pct != null) return `${pct.toFixed(1)}% cluster`
  if (audit.holderResolution.holderRowsReturned === 0 && !holdersVerified) return 'Needs holder evidence'
  if (!audit.deployerResolution.originWallet) return holdersVerified ? DEV_SUPPLY_DEPLOYER_UNRESOLVED : 'Needs creator tx evidence'
  return holdersVerified ? NOT_IN_INDEXED_HOLDER_ROWS : 'Not verified'
}

export function finalizeDevClusterStatuses(audit: DevClusterDiagnosisAudit): Pick<DevClusterDiagnosisAudit, 'finalDevMapStatus' | 'finalClusterStatus' | 'finalReason'> {
  const d = audit.deployerResolution
  const h = audit.holderResolution
  const g = audit.linkedWalletGraph
  const alchemy = audit.providerHealth.alchemyRpc

  const finalDevMapStatus = classifyDevMapStatus({
    originAddress: d.originWallet,
    factoryDetected: d.factoryDetected,
    originConfidence: d.confidence,
    holdersAttempted: h.attempted,
    holderRows: h.holderRowsReturned,
    graphStatus: g.graphStatus,
  })
  const finalClusterStatus = classifyClusterStatus({
    graphStatus: g.graphStatus,
    walletsMapped: g.walletsMapped,
    clusterSupplyPercent: g.linkedWalletSupplyPct,
    holderRows: h.holderRowsReturned,
  })

  let finalReason: string
  if (d.originWallet && g.graphStatus === 'ran_found') {
    finalReason = d.factoryDetected
      ? 'Factory and origin separated from creation evidence; linked wallets mapped from transfers.'
      : 'Origin wallet and linked-wallet graph resolved from provider evidence.'
  } else if (d.originWallet && g.graphStatus === 'ran_none') {
    finalReason = 'Origin wallet resolved. Graph ran and found no qualifying linked wallets.'
  } else if (g.graphStatus === 'not_run' || g.graphStatus === 'unavailable') {
    if (alchemy.billingDisabled) finalReason = 'Alchemy billing disabled'
    else if (alchemy.rateLimited) finalReason = 'Alchemy rate limited'
    else if (alchemy.timeout) finalReason = 'Alchemy timeout'
    else if (alchemy.skipReason === 'chain_not_supported') finalReason = 'Alchemy chain not supported'
    else if (alchemy.skipReason === 'invalid_param') finalReason = 'Alchemy invalid param — skipped'
    else if (h.holderRowsReturned === 0) finalReason = 'Needs holder evidence'
    else if (!d.originWallet) finalReason = 'Needs creator tx evidence'
    else finalReason = g.failureReason ?? 'Needs transfer evidence'
  } else if (!d.originWallet) {
    finalReason = d.failureReason ?? 'Origin wallet not verified'
  } else if (h.holderRowsReturned === 0) {
    finalReason = 'Needs holder evidence'
  } else {
    finalReason = 'Partial evidence from available providers'
  }

  return { finalDevMapStatus, finalClusterStatus, finalReason }
}

export function providerHealthLabel(kind: 'alchemy' | 'blockscout' | 'goldrush', health: AlchemyRpcHealth | ProviderRowsHealth): string {
  if (kind === 'alchemy') {
    const a = health as AlchemyRpcHealth
    switch (a.health) {
      case 'healthy': return 'Alchemy: healthy'
      case 'billing_disabled': return 'Alchemy: billing disabled'
      case 'rate_limited': return 'Alchemy: rate limited'
      case 'timeout': return 'Alchemy: timeout'
      case 'chain_not_supported': return 'Alchemy: chain not supported'
      case 'invalid_param': return 'Alchemy: invalid param — skipped'
      case 'not_attempted': return 'Alchemy: not attempted'
      default: return a.errorMessage ? `Alchemy: failed (${a.errorMessage})` : 'Alchemy: failed'
    }
  }
  const p = health as ProviderRowsHealth
  const name = kind === 'blockscout' ? 'Blockscout' : 'GoldRush'
  switch (p.health) {
    case 'healthy': return `${name}: healthy`
    case 'unsupported': return `${name}: unsupported`
    case 'not_attempted': return `${name}: not attempted`
    default: return p.errorMessage ? `${name}: failed (${p.errorMessage})` : `${name}: failed`
  }
}

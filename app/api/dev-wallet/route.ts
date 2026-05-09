import { NextResponse } from 'next/server'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

const COVALENT_BASE_URL = 'https://api.covalenthq.com/v1'
function resolveBaseRpcUrl(): string | null {
  const explicit = process.env.ALCHEMY_BASE_RPC_URL || process.env.BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY || process.env.ALCHEMY_API_KEY
  if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
  return null
}

const ALCHEMY_BASE_URL = resolveBaseRpcUrl()
const DEV_CACHE_TTL_MS = 3 * 60 * 1000
const devCache = new Map<string, { exp: number; payload: unknown }>()
const devRate = new Map<string, { count: number; resetAt: number; lastAt: number }>()
const DEV_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 4, pro: 15, elite: 30 }
const DEV_COOLDOWN_MS: Record<'free' | 'pro' | 'elite', number> = { free: 25_000, pro: 8_000, elite: 4_000 }

interface PlanResolution {
  plan: 'free' | 'pro' | 'elite'
  hasBearer: boolean
  userPresent: boolean
  settingsRowFound: boolean
  planSource: 'user_settings' | 'fallback'
}

async function resolveServerPlan(req: Request): Promise<PlanResolution> {
  const auth = req.headers.get('authorization') ?? ''
  const hasBearer = auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim().length > 0
  if (!hasBearer) return { plan: 'free', hasBearer: false, userPresent: false, settingsRowFound: false, planSource: 'fallback' }
  const token = auth.slice(7).trim()
  try {
    const result = await getCurrentUserPlanFromBearerToken(token)
    return {
      plan: result.plan,
      hasBearer: true,
      userPresent: result.userId !== null,
      settingsRowFound: result.settingsRowFound,
      planSource: result.settingsRowFound ? 'user_settings' : 'fallback',
    }
  } catch {
    return { plan: 'free', hasBearer: true, userPresent: false, settingsRowFound: false, planSource: 'fallback' }
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
  confidence?: 'medium' | 'low'
  reason?: string
}

interface MatchedHolder {
  address: string
  supplyPct: number
  isDeployer: boolean
  isLinked: boolean
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
  if (!ALCHEMY_BASE_URL) throw new Error('rpc_not_configured')
  const res = await fetch(ALCHEMY_BASE_URL, {
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

async function getAssetTransfers(params: Record<string, unknown>): Promise<AlchemyTransfer[]> {
  try {
    const result = await alchemyRpc('alchemy_getAssetTransfers', [params]) as { transfers?: AlchemyTransfer[] }
    return result?.transfers ?? []
  } catch {
    return []
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
  const ZERO = '0x0000000000000000000000000000000000000000'

  function finalize(c: OriginCandidate): { candidate: OriginCandidate; diag: OriginDiscoveryDiag } {
    diag.selected_origin_candidate = { methodUsed: c.methodUsed, address: c.address, confidence: c.confidence, deployerStatus: c.deployerStatus }
    return { candidate: c, diag }
  }

  // 1. Optional paid creation lookup (Basescan/Etherscan key optional)
  const scanKey = process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY
  if (scanKey) {
    diag.optional_creation_lookup.attempted = true
    try {
      const scanRes = await fetch(
        `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${contract}&apikey=${scanKey}`,
        { cache: 'no-store', signal: AbortSignal.timeout(6000) }
      )
      diag.optional_creation_lookup.httpStatus = scanRes.status
      if (scanRes.ok) {
        const scanJson = await scanRes.json() as { status?: string; result?: Array<{ contractCreator?: string; txHash?: string }> }
        const r = scanJson?.result?.[0]
        if (scanJson.status === '1' && r?.contractCreator) {
          const creator = r.contractCreator.toLowerCase()
          diag.optional_creation_lookup.ok = true
          diag.optional_creation_lookup.reason = 'contract_creation_record'
          diag.optional_creation_lookup.candidateAddress = creator
          diag.optional_creation_lookup.txHashPresent = Boolean(r.txHash)
          diag.optional_creation_lookup.confidence = 'high'
          return finalize({ address: creator, confidence: 'high', deployerStatus: 'confirmed', methodUsed: 'transaction_creation_record', creationTxHash: r.txHash ?? null, reason: 'Creation record from indexed transactions' })
        }
        diag.optional_creation_lookup.reason = scanJson.status === '0' ? 'api_no_result' : 'unexpected_shape'
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
      const txRes = await fetch(
        `${COVALENT_BASE_URL}/base-mainnet/address/${contract}/transactions_v2/?key=${covalentKey}&page-size=5&block-signed-at-asc=true&no-logs=true`,
        { cache: 'no-store', signal: AbortSignal.timeout(10000) }
      )
      diag.contract_transaction_history.httpStatus = txRes.status
      if (txRes.ok) {
        const txJson = await txRes.json() as { data?: { items?: CovalentTxItem[] } }
        const txItems = txJson?.data?.items ?? []
        diag.contract_transaction_history.itemCount = txItems.length

        // Contract creation tx: to_address is null or empty string
        const creationTx = txItems.find(t => t.successful && (t.to_address === null || t.to_address === ''))
        if (creationTx?.from_address) {
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
          t => t.successful && t.from_address && t.from_address.toLowerCase() !== contract.toLowerCase() && t.from_address.toLowerCase() !== ZERO
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
  const firstMint = mintTransfers.find(t => t.to && t.to !== ZERO)
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
  const firstErc20 = earliestErc20.find(t => t.from || t.to)
  if (firstErc20) {
    const addr = (firstErc20.from && firstErc20.from !== ZERO ? firstErc20.from : firstErc20.to) ?? null
    if (addr) {
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
  const firstExt = incomingExt.find(t => t.from && t.from !== ZERO)
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

async function findLinkedWallets(deployer: string, excludeContract: string): Promise<LinkedWallet[]> {
  const EXCLUDED = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
    deployer.toLowerCase(),
    excludeContract.toLowerCase(),
  ])

  const transfers = await getAssetTransfers({
    fromBlock: '0x0',
    toBlock: 'latest',
    fromAddress: deployer,
    category: ['external', 'erc20'],
    order: 'desc',
    maxCount: '0x64',
    withMetadata: true,
  })

  const walletMap = new Map<string, LinkedWallet>()
  for (const t of transfers) {
    const to = t.to?.toLowerCase()
    if (!to || EXCLUDED.has(to)) continue

    if (!walletMap.has(to)) {
      walletMap.set(to, {
        address: to,
        amountReceived: t.value,
        asset: t.asset,
        txHash: t.hash,
        firstSeen: t.metadata?.blockTimestamp ?? null,
        confidence: 'medium',
        reason: 'outgoing_transfer_from_origin_wallet',
      })
      continue
    }

    const existing = walletMap.get(to)!
    existing.amountReceived = (existing.amountReceived ?? 0) + (t.value ?? 0)
    const existingTime = existing.firstSeen ? new Date(existing.firstSeen).getTime() : Number.POSITIVE_INFINITY
    const nextTime = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : Number.POSITIVE_INFINITY
    if (nextTime < existingTime) {
      existing.firstSeen = t.metadata?.blockTimestamp ?? existing.firstSeen
      existing.txHash = t.hash ?? existing.txHash
      existing.asset = existing.asset ?? t.asset
    }
  }

  return [...walletMap.values()].slice(0, 20)
}

async function getSupplyData(
  contract: string,
  deployer: string | null,
  linkedWallets: LinkedWallet[],
  preloadedTopHolders?: Array<{ address?: string; percent?: number | null }>,
): Promise<{
  holderDataAvailable: boolean
  supplyControlled: number | null
  matchedHolderWallets: MatchedHolder[]
}> {
  const linkedSet = new Set(linkedWallets.map(w => w.address.toLowerCase()))

  if (preloadedTopHolders && preloadedTopHolders.length > 0) {
    if (!deployer && linkedSet.size === 0) {
      return { holderDataAvailable: true, supplyControlled: null, matchedHolderWallets: [] }
    }
    const matched: MatchedHolder[] = []
    let controlled = 0
    for (const h of preloadedTopHolders) {
      const addr = (h.address ?? '').toLowerCase()
      if (!addr) continue
      const isDeployer = deployer ? addr === deployer.toLowerCase() : false
      const isLinked = linkedSet.has(addr)
      if (!isDeployer && !isLinked) continue
      const pct = typeof h.percent === 'number' ? h.percent : 0
      controlled += pct
      matched.push({ address: addr, supplyPct: pct, isDeployer, isLinked })
    }
    return {
      holderDataAvailable: true,
      supplyControlled: Math.round(controlled * 100) / 100,
      matchedHolderWallets: matched.sort((a, b) => b.supplyPct - a.supplyPct),
    }
  }

  const apiKey = process.env.COVALENT_API_KEY
  if (!apiKey) {
    return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }
  }

  try {
    const res = await fetch(
      `${COVALENT_BASE_URL}/base-mainnet/tokens/${contract}/token_holders_v2/?page-size=50&key=${apiKey}`,
      { cache: 'no-store', signal: AbortSignal.timeout(9000) }
    )
    if (!res.ok) return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }

    const json = await res.json() as {
      data?: {
        items?: Array<{ address: string; balance: string; total_supply?: string }>
      }
    }

    const items = json?.data?.items ?? []
    if (items.length === 0) return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }

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

    return {
      holderDataAvailable: true,
      supplyControlled: Math.round(controlled * 100) / 100,
      matchedHolderWallets: matched.sort((a, b) => b.supplyPct - a.supplyPct),
    }
  } catch {
    return { holderDataAvailable: false, supplyControlled: null, matchedHolderWallets: [] }
  }
}

async function getPreviousActivity(deployer: string | null): Promise<{
  previousActivityAvailable: boolean
  previousProjects: PreviousProject[]
  warning: string | null
}> {
  if (!deployer) {
    return { previousActivityAvailable: false, previousProjects: [], warning: null }
  }

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
    return {
      previousActivityAvailable: false,
      previousProjects: [],
      warning: 'Previous activity not available in current check.',
    }
  }

  const byContract = new Map<string, PreviousProject>()
  for (const t of transfers) {
    const contractAddress = t.rawContract?.address?.toLowerCase()
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') continue
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
    previousActivityAvailable: true,
    previousProjects: [...byContract.values()].slice(0, 10),
    warning: null,
  }
}

function detectSuspiciousTransfers(
  linkedWallets: LinkedWallet[],
  supplyControlled: number | null,
): { suspiciousTransfers: boolean; suspiciousTransferReasons: string[] } {
  const reasons: string[] = []

  if (linkedWallets.length >= 5) {
    reasons.push(`Likely deployer funded ${linkedWallets.length} wallets`)
  }

  const numericAmounts = linkedWallets.map(w => w.amountReceived).filter((v): v is number => typeof v === 'number')
  if (numericAmounts.length >= 3) {
    const rounded = numericAmounts.map(v => Number(v.toFixed(6)))
    const counts = new Map<number, number>()
    for (const n of rounded) counts.set(n, (counts.get(n) ?? 0) + 1)
    const maxGroup = Math.max(...counts.values())
    if (maxGroup >= 3) reasons.push('Multiple linked wallets received very similar transfer amounts')
  }

  const times = linkedWallets
    .map(w => (w.firstSeen ? new Date(w.firstSeen).getTime() : null))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
  if (times.length >= 3 && (times[times.length - 1] - times[0]) <= 2 * 60 * 60 * 1000) {
    reasons.push('Linked wallets were funded close together in time')
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

  const risks: string[] = [
    !data.deployerAddress ? 'Creator link not confirmed — origin of token is unverified' : '',
    data.suspiciousTransfers ? 'Suspicious transfer pattern observed' : '',
    ...data.suspiciousTransferReasons.slice(0, 2),
    data.holderTop10 != null && data.holderTop10 > 50
      ? `High holder concentration — top 10 hold ${data.holderTop10}%`
      : '',
    data.lpLocked === false ? 'LP appears team-controlled' : '',
  ].filter(Boolean)

  const holderLine = data.holderDataAvailable
    ? 'Holder distribution is available for review.'
    : 'Holder distribution needs deeper confirmation.'
  const liqLine = data.liquidityDataAvailable
    ? 'Liquidity data is available for review.'
    : 'Liquidity control needs deeper review.'

  const summary = `${tokenLabel} scanned on Base. ${holderLine} ${liqLine}`

  return {
    verdict: {
      label,
      confidence: 'medium',
      summary,
      keySignals,
      risks: risks.length > 0 ? risks : ['No confirmed risk signals from current checks'],
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
  holderCount?: number | null
  lpControlStatus?: string | null
  liquidityUsd?: number | null
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
    `Analyze this Base token scan and return JSON only.\n` +
    `Use only the fields below. Keep response short and professional.\n` +
    `Use wording: "likely deployer/owner wallet". Do not claim confirmed deployer unless confidence is high.\n` +
    `Do not infer supply concentration from missing holder data.\n` +
    `If holder data is unavailable, explicitly state supply control cannot be confirmed and do not mention holder percentages.\n` +
    `Do not infer LP lock status or DEX liquidity from missing liquidity data.\n` +
    `If security scan data is unavailable, do not infer honeypot status or tax values.\n` +
    `Output label must be exactly one of: TRUSTWORTHY, WATCH, AVOID, UNKNOWN.\n` +
    `Address: ${data.contractAddress}\n` +
    `Token: ${data.tokenName ?? 'unknown'} (${data.tokenSymbol ?? 'unknown'})\n` +
    `Creator status: ${data.deployerStatus ?? 'not_confirmed'}\n` +
    `Creator/origin address: ${data.deployerAddress ?? 'none'}\n` +
    `Confidence: ${data.deployerConfidence}\n` +
    `Method: ${data.methodUsed}\n` +
    `Linked wallets: ${data.linkedWallets.length}\n` +
    `Holder data available: ${data.holderDataAvailable}\n` +
    `Holder count: ${data.holderCount != null ? data.holderCount : 'unknown'}\n` +
    `Top 10 holder concentration: ${data.holderTop10 != null ? `${data.holderTop10}%` : 'unknown'}\n` +
    `Supply controlled by deployer cluster: ${data.supplyControlled ?? 'unknown'}\n` +
    `Liquidity data available: ${data.liquidityDataAvailable}\n` +
    `Liquidity USD: ${data.liquidityUsd != null ? data.liquidityUsd : 'unknown'}\n` +
    `LP control status: ${data.lpControlStatus ?? 'unknown'}\n` +
    `Security data available: ${data.securityDataAvailable}\n` +
    `Previous activity available: ${data.previousActivityAvailable}\n` +
    `Previous activity contracts: ${data.previousProjects.map(p => p.contractAddress).slice(0, 8).join(', ') || 'none'}\n` +
    `Suspicious transfers: ${data.suspiciousTransfers}\n` +
    `Suspicious reasons: ${data.suspiciousTransferReasons.join('; ') || 'none'}\n` +
    `Honeypot: ${data.honeypot ?? 'unknown'}\n` +
    `Buy tax: ${data.buyTax != null ? `${data.buyTax}%` : 'unknown'}\n` +
    `Sell tax: ${data.sellTax != null ? `${data.sellTax}%` : 'unknown'}\n` +
    `LP locked: ${data.lpLocked ?? 'unknown'}\n` +
    `LP holder concentration: ${data.lpHolderConcentration != null ? `${data.lpHolderConcentration}%` : 'unknown'}\n` +
    `Unavailable data: ${data.warnings.join('; ') || 'none'}\n` +
    `Return ONLY JSON with keys label, confidence, summary, keySignals, risks, nextAction.`

  try {
    const res = await fetch(`${origin}/api/clark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feature: 'clark-ai',
        mode: 'dev-wallet',
        chain: 'base',
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

async function fetchTokenEvidence(origin: string, contractAddress: string, authHeader?: string): Promise<TokenEvidenceResult> {
  const result: TokenEvidenceResult = { data: null, attempted: true, ok: false, httpStatus: null, reason: '' }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-user-plan': 'pro' }
    if (authHeader) headers['Authorization'] = authHeader
    const res = await fetch(`${origin}/api/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contract: contractAddress }),
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
    const planRes = await resolveServerPlan(req)
    const { plan } = planRes
    if (plan === 'free') return NextResponse.json({
      error: 'Dev Wallet Detector is included in Pro and Elite.',
      rateLimited: false,
      _diagnostics: {
        planGate: {
          route: '/api/dev-wallet',
          verifiedPlan: plan,
          hasBearer: planRes.hasBearer,
          userPresent: planRes.userPresent,
          settingsRowFound: planRes.settingsRowFound,
          planSource: planRes.planSource,
          requiredPlan: 'pro',
        },
      },
    }, { status: 403 })
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const now = Date.now()
    const rateKey = `${ip}:${plan}`
    const rr = devRate.get(rateKey)
    if (!rr || rr.resetAt <= now) devRate.set(rateKey, { count: 1, resetAt: now + 60_000, lastAt: now })
    else if (now - rr.lastAt < DEV_COOLDOWN_MS[plan]) return NextResponse.json({ error: 'Cooldown active. Please retry shortly.', rateLimited: true }, { status: 429 })
    else if (rr.count >= DEV_RATE_LIMIT[plan]) return NextResponse.json({ error: 'Rate limit reached. Try again shortly.', rateLimited: true }, { status: 429 })
    else { rr.count += 1; rr.lastAt = now }
    const body = await req.json() as { contractAddress?: string }
    const { contractAddress } = body

    if (!contractAddress || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
      return NextResponse.json(
        { error: 'Invalid contract address — must be a valid EVM address (0x + 40 hex chars)' },
        { status: 400 }
      )
    }

    const normalizedAddress = contractAddress.toLowerCase()
    const cached = devCache.get(normalizedAddress)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)

    let bytecode: string | null = null
    let rpcStatus: 'ok' | 'partial' | 'unavailable' = 'ok'
    const providerUsed = ALCHEMY_BASE_URL ? 'alchemy' : 'none'
    try {
      bytecode = await alchemyRpc('eth_getCode', [normalizedAddress, 'latest']) as string
    } catch {
      rpcStatus = 'unavailable'
      warnings.push('Creator link not confirmed from current checks.')
    }

    if (bytecode === '0x') {
      return NextResponse.json(
        { error: 'No contract found at this address on Base mainnet' },
        { status: 400 }
      )
    }

    const origin = new URL(req.url).origin
    const reqAuthHeader = req.headers.get('authorization') ?? undefined
    const debugMode = process.env.NODE_ENV === 'development' || new URL(req.url).searchParams.get('debug') === 'true'
    const tokenEvidenceResult = await fetchTokenEvidence(origin, normalizedAddress, reqAuthHeader)
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
    const liqEv = (sections.liquidity as Record<string, unknown> | undefined) ?? {}
    const secEv = (sections.security as Record<string, unknown> | undefined) ?? {}
    const liquidityDataAvailable = typeof liqEv.liquidityDepth === 'number' || typeof tokenEvidence?.liquidityUsd === 'number'
    const holderDataFromToken = holderDistributionRaw != null
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
    }

    let linkedWallets: LinkedWallet[] = []
    if (deployerAddress) {
      linkedWallets = await findLinkedWallets(deployerAddress, normalizedAddress)
    }

    const { holderDataAvailable: holderDataFromCovalent, supplyControlled, matchedHolderWallets } =
      await getSupplyData(normalizedAddress, deployerAddress, linkedWallets, holderDistributionRaw?.topHolders)
    const holderDataAvailable = holderDataFromToken || holderDataFromCovalent
    if (!holderDataAvailable) {
      warnings.push('Holder distribution needs deeper confirmation.')
    }

    const { previousActivityAvailable, previousProjects, warning: activityWarning } =
      await getPreviousActivity(deployerAddress)
    if (activityWarning) warnings.push(activityWarning)

    const previousDeploymentsAvailable = false

    const tokenName = typeof tokenEvidence?.name === 'string' ? tokenEvidence.name : null
    const tokenSymbol = typeof tokenEvidence?.symbol === 'string' ? tokenEvidence.symbol : null
    const holderTop10 = typeof holderDistributionRaw?.top10 === 'number' ? holderDistributionRaw.top10 : null
    const holderCount = typeof holderDistributionRaw?.holderCount === 'number' ? holderDistributionRaw.holderCount : null
    const secHoneypot: boolean | null = typeof secEv.honeypot === 'boolean' ? secEv.honeypot : null
    const secBuyTax: number | null = typeof secEv.buyTax === 'number' ? secEv.buyTax : null
    const secSellTax: number | null = typeof secEv.sellTax === 'number' ? secEv.sellTax : null
    const lpControlObj = liqEv.lpControl as Record<string, unknown> | null | undefined
    const lpControlStatus = typeof lpControlObj?.status === 'string' ? lpControlObj.status : null
    const liqLpLocked: boolean | null = lpControlStatus === 'burned' || lpControlStatus === 'locked' ? true : lpControlStatus === 'team_controlled' ? false : null
    const liqHolderConcentration: number | null = typeof liqEv.lpHolderConcentration === 'number' ? liqEv.lpHolderConcentration : null
    const liquidityUsd: number | null = typeof liqEv.liquidityDepth === 'number' ? (liqEv.liquidityDepth as number) : (typeof tokenEvidence?.liquidityUsd === 'number' ? (tokenEvidence.liquidityUsd as number) : null)

    const supplyControlStatus: 'ok' | 'partial' | 'needs_confirmed_creator' =
      !deployerAddress && linkedWallets.length === 0
        ? 'needs_confirmed_creator'
        : (supplyControlled !== null && supplyControlled > 0 ? 'ok' : 'partial')

    const { suspiciousTransfers, suspiciousTransferReasons } =
      detectSuspiciousTransfers(linkedWallets, supplyControlled)

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
      holderCount,
      lpControlStatus,
      liquidityUsd,
    })

    const moduleDiags = [
      { name: 'contract_bytecode_check', ok: rpcStatus !== 'unavailable', detail: rpcStatus },
      { name: 'creator_heuristics', ok: deployerAddress !== null, detail: methodUsed },
      { name: 'linked_wallet_heuristics', ok: linkedWallets.length > 0, detail: `count=${linkedWallets.length}` },
      { name: 'token_evidence_call', ok: tokenEvidenceResult.ok, detail: tokenEvidenceResult.reason, httpStatus: tokenEvidenceResult.httpStatus },
      { name: 'holder_evidence', ok: holderDataAvailable, detail: holderDataFromToken ? `top10=${holderTop10}% count=${holderCount}` : (holderDataAvailable ? `controlled=${supplyControlled}%` : 'not_returned') },
      { name: 'liquidity_evidence', ok: liquidityDataAvailable, detail: lpControlStatus ? `lpControl=${lpControlStatus}` : (liquidityDataAvailable ? 'present' : 'not_returned') },
      { name: 'previous_activity', ok: previousActivityAvailable, detail: previousActivityAvailable ? `projects=${previousProjects.length}` : 'not_returned' },
      { name: 'clark_input_summary', ok: clarkVerdict !== null, detail: clarkVerdict ? `${clarkVerdict.label} (${clarkVerdict.confidence})` : (clarkError ?? 'failed') },
    ]

    const responsePayload = {
      contractAddress: normalizedAddress,
      chain: 'base',
      deployerAddress,
      deployerConfidence,
      methodUsed,
      linkedWallets,
      holderDataAvailable,
      supplyControlled,
      matchedHolderWallets,
      previousActivityAvailable,
      previousDeploymentsAvailable,
      previousProjects,
      suspiciousTransfers,
      suspiciousTransferReasons,
      clarkVerdict,
      tokenEvidence: tokenEvidence ? {
        name: tokenName, symbol: tokenSymbol,
        price: market.price ?? null,
        volume24h: market.volume24h ?? null,
        liquidity: liqEv.liquidityDepth ?? tokenEvidence.liquidityUsd ?? market.liquidity ?? null,
        fdv: market.fdv ?? null,
        marketValue: market.marketCap ?? market.fdv ?? null,
        top1: holderDistributionRaw?.top1 ?? null,
        top10: holderTop10,
        top20: holderDistributionRaw?.top20 ?? null,
        holderCount,
        lpControl: liqEv.lpControl ?? null,
        lpControlStatus,
        security: secEv ?? null,
      } : null,
      tokenStatus: tokenEvidence ? 'ok' : (bytecode && bytecode !== '0x' ? 'partial' : 'limited_check'),
      marketStatus: tokenEvidence && market && Object.keys(market).length ? 'ok' : 'partial',
      deployerStatus,
      creationTxHash,
      originReason,
      supplyControlStatus,
      linkedWalletsStatus: linkedWallets.length ? 'ok' : (deployerAddress ? 'partial' : 'skipped'),
      holderStatus: holderDataAvailable ? 'ok' : 'partial',
      liquidityStatus: liquidityDataAvailable ? 'ok' : 'partial',
      lpControlStatus: lpControlStatus ? 'ok' : 'partial',
      verdict: (suspiciousTransfers || (holderTop10 != null && holderTop10 > 50) || liqLpLocked === false || secHoneypot === true)
        ? 'CAUTION'
        : (tokenEvidence || holderDataAvailable || liquidityDataAvailable || Boolean(bytecode && bytecode !== '0x'))
          ? 'WATCH'
          : 'UNKNOWN',
      confidence: (tokenEvidence || holderDataAvailable) ? 'medium' : 'low',
      reasons: [
        !deployerAddress && (tokenEvidence || holderDataAvailable || liquidityDataAvailable) ? 'Creator link not confirmed; token evidence still indicates watchlist-level signal.' : '',
        holderTop10 != null && holderTop10 > 50 ? `High holder concentration (top10 = ${holderTop10}%).` : '',
        liqLpLocked === false ? 'LP appears team-controlled.' : '',
      ].filter(Boolean),
      warnings,
      ...(debugMode ? {
        _diagnostics: {
          modules: moduleDiags,
          rpcConfigured: Boolean(ALCHEMY_BASE_URL),
          rpcStatus,
          providerUsed,
          tokenEvidenceDiag: { attempted: tokenEvidenceResult.attempted, ok: tokenEvidenceResult.ok, httpStatus: tokenEvidenceResult.httpStatus, reason: tokenEvidenceResult.reason },
          origin_discovery: originDiag ?? { skipped: true },
        },
      } : {}),
      fetchedAt: new Date().toISOString(),
    }
    devCache.set(normalizedAddress, { exp: Date.now() + DEV_CACHE_TTL_MS, payload: responsePayload })
    return NextResponse.json(responsePayload)
  } catch (err) {
    console.error('[dev-wallet] fatal:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

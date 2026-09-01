// ROBINHOOD TOKEN SCANNER LP PROOF — SERVER, DISCLOSED.
//
// Token Scanner-only Robinhood (chainId 4663) proof path. Isolated from Wallet Scanner's
// lib/server/robinhoodBlockscoutEvidence.ts (that module is PnL/swap-log scoped and gated on
// BLOCKSCOUT_API_KEY). Token holder/LP-holder reads here use Blockscout's public REST API,
// which this codebase already hits without a key from deployerResolver.ts.
//
// Hard rules:
//   - never fake lock/burn
//   - never reuse Base/ETH locker registry or PinkLock
//   - missing holder rows are not 0%
//   - Base/ETH cached LP data cannot populate this proof (pool must be chainId 4663)

import { fetchOnchainTotalSupply } from './lpProof'
import { getRobinhoodRpcUrl, ROBINHOOD_CHAIN_EXPLORER_URL, ROBINHOOD_CHAIN_ID } from './robinhoodChainConfig'
import {
  ROBINHOOD_BURN_ADDRESSES,
  buildRobinhoodLpCopy,
  classifyRobinhoodLpHolders,
  emptyRobinhoodLpProofAudit,
  emptyRobinhoodLpResolutionAudit,
  isConcentratedRobinhoodPoolType,
  mapRobinhoodClassificationToLpControl,
  normalizeRobinhoodAddress,
  selectedRobinhoodPoolChainOk,
  type RobinhoodLpClassification,
  type RobinhoodLpCopy,
  type RobinhoodLpHolderRow,
  type RobinhoodLpProofAudit,
  type RobinhoodLpResolutionAudit,
} from '../robinhoodLpProofShared'

export type { RobinhoodLpProofAudit, RobinhoodLpResolutionAudit, RobinhoodLpClassification, RobinhoodLpCopy }

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

const BLOCKSCOUT_TIMEOUT_MS = 7_000
const BLOCKSCOUT_HOLDERS_PATH = (hash: string) => `/api/v2/tokens/${hash}/holders?items_count=50`
const BLOCKSCOUT_TOKEN_PATH = (hash: string) => `/api/v2/tokens/${hash}`
const BLOCKSCOUT_TRANSFERS_PATH = (hash: string) => `/api/v2/tokens/${hash}/transfers?items_count=50`

export interface RobinhoodBlockscoutHolderFetch {
  rows: RobinhoodLpHolderRow[]
  totalSupplyRaw: string | null
  tokenType: string | null
  attempted: boolean
  used: boolean
  error: string | null
  source: 'holders' | 'transfers' | 'none'
}

export interface ResolveRobinhoodLpProofInput {
  tokenAddress: string
  poolAddress: string | null
  pairAddress: string | null
  lpTokenAddress: string | null
  dex: string | null
  poolType: string | null
  liquidityUsd: number | null
  createdAt: string | null
  poolChainHint: unknown
  concentrated: boolean
  positionManagerDetected?: boolean
  concentratedProofAttempted?: boolean
  positionOwnerProof?: 'verified' | 'partial' | 'unavailable' | null
  existingHolderRows?: RobinhoodLpHolderRow[]
  existingTotalSupplyRaw?: string | null
  fetchImpl?: FetchImpl
  skipNetwork?: boolean
}

export interface RobinhoodLpProofResult {
  classification: RobinhoodLpClassification
  reason: string
  copy: RobinhoodLpCopy
  resolutionAudit: RobinhoodLpResolutionAudit
  proofAudit: RobinhoodLpProofAudit
  lpHolderRows: RobinhoodLpHolderRow[]
  tokenHolderRows: RobinhoodLpHolderRow[]
  lpControlOverlay: ReturnType<typeof mapRobinhoodClassificationToLpControl> | null
}

function blockscoutBase(): string {
  return ROBINHOOD_CHAIN_EXPLORER_URL.replace(/\/$/, '')
}

function withApiKey(url: string): string {
  const key = process.env.BLOCKSCOUT_API_KEY
  if (!key) return url
  return `${url}${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}`
}

async function blockscoutGet(path: string, fetchImpl: FetchImpl): Promise<{ ok: boolean; status: number; json: unknown; error: string | null }> {
  try {
    const res = await fetchImpl(withApiKey(`${blockscoutBase()}${path}`), {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(BLOCKSCOUT_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, status: res.status, json: null, error: `http_${res.status}` }
    const json = await res.json().catch(() => null)
    if (json == null) return { ok: false, status: res.status, json: null, error: 'invalid_json' }
    return { ok: true, status: res.status, json, error: null }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, status: 0, json: null, error: timedOut ? 'timeout' : 'network_error' }
  }
}

function parseBlockscoutHolderItems(json: unknown, totalSupplyRaw: string | null): RobinhoodLpHolderRow[] {
  const items = Array.isArray((json as { items?: unknown[] } | null)?.items)
    ? (json as { items: unknown[] }).items
    : []
  const rows: RobinhoodLpHolderRow[] = []
  for (const item of items) {
    const rec = item as Record<string, unknown>
    const addrObj = rec.address
    const hash = typeof addrObj === 'string'
      ? addrObj
      : (addrObj && typeof addrObj === 'object' ? String((addrObj as Record<string, unknown>).hash ?? '') : '')
    const address = normalizeRobinhoodAddress(hash)
    if (!address) continue
    const value = rec.value ?? rec.balance ?? rec.token_balance ?? rec.amount
    const balanceRaw = value != null ? String(value) : null
    const isContract = addrObj && typeof addrObj === 'object'
      ? (typeof (addrObj as Record<string, unknown>).is_contract === 'boolean' ? (addrObj as Record<string, unknown>).is_contract as boolean : null)
      : null
    let pct: number | null = null
    if (typeof rec.percentage === 'number') pct = rec.percentage
    else if (typeof rec.percent === 'number') pct = rec.percent
    rows.push({ address, balanceRaw, pct, isContract })
  }
  if (totalSupplyRaw) {
    for (const row of rows) {
      if (row.pct == null && row.balanceRaw != null) {
        try {
          const bal = BigInt(row.balanceRaw)
          const supply = BigInt(totalSupplyRaw)
          if (supply > BigInt(0)) row.pct = Number((bal * BigInt(10_000)) / supply) / 100
        } catch { /* leave pct null */ }
      }
    }
  }
  return rows
}

function parseBlockscoutTokenMeta(json: unknown): { totalSupplyRaw: string | null; tokenType: string | null } {
  if (!json || typeof json !== 'object') return { totalSupplyRaw: null, tokenType: null }
  const rec = json as Record<string, unknown>
  const totalSupplyRaw = rec.total_supply != null ? String(rec.total_supply) : (rec.totalSupply != null ? String(rec.totalSupply) : null)
  const tokenType = typeof rec.type === 'string' ? rec.type : null
  return { totalSupplyRaw, tokenType }
}

function parseBlockscoutTransferAddresses(json: unknown): string[] {
  const items = Array.isArray((json as { items?: unknown[] } | null)?.items)
    ? (json as { items: unknown[] }).items
    : []
  const seen = new Set<string>()
  for (const item of items) {
    const rec = item as Record<string, unknown>
    for (const key of ['from', 'to'] as const) {
      const side = rec[key]
      const hash = typeof side === 'string'
        ? side
        : (side && typeof side === 'object' ? String((side as Record<string, unknown>).hash ?? '') : '')
      const address = normalizeRobinhoodAddress(hash)
      if (address) seen.add(address)
    }
  }
  return [...seen]
}

async function robinhoodRpcCall(method: string, params: unknown[]): Promise<string | null> {
  const rpcUrl = getRobinhoodRpcUrl()
  if (!rpcUrl) return null
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const json = await res.json() as { result?: unknown }
    return typeof json?.result === 'string' ? json.result : null
  } catch {
    return null
  }
}

function padAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

async function rpcBalanceOf(token: string, holder: string): Promise<bigint | null> {
  const hex = await robinhoodRpcCall('eth_call', [{ to: token, data: `0x70a08231${padAddress(holder)}` }, 'latest'])
  if (!hex || hex === '0x') return null
  try { return BigInt(hex) } catch { return null }
}

async function rpcIsContract(address: string): Promise<boolean | null> {
  const code = await robinhoodRpcCall('eth_getCode', [address, 'latest'])
  if (code == null) return null
  return typeof code === 'string' && code !== '0x' && code.length > 2
}

export function blockscoutHoldersToProviderShape(fetchResult: RobinhoodBlockscoutHolderFetch): Record<string, unknown> {
  return {
    items: fetchResult.rows.map((row) => ({
      address: row.address,
      balance: row.balanceRaw,
      percentage: row.pct,
      total_supply: fetchResult.totalSupplyRaw,
      is_contract: row.isContract,
    })),
    __status: fetchResult.rows.length > 0 ? 'ok' : (fetchResult.error ? 'error' : 'empty'),
    __reason: fetchResult.error,
    __source: 'blockscout_token_holders',
    __chainUsed: 'robinhood',
  }
}

export async function fetchRobinhoodBlockscoutHolders(
  tokenAddress: string,
  fetchImpl: FetchImpl = fetch,
): Promise<RobinhoodBlockscoutHolderFetch> {
  const hash = normalizeRobinhoodAddress(tokenAddress)
  if (!hash) {
    return { rows: [], totalSupplyRaw: null, tokenType: null, attempted: false, used: false, error: 'invalid_address', source: 'none' }
  }

  const meta = await blockscoutGet(BLOCKSCOUT_TOKEN_PATH(hash), fetchImpl)
  const parsedMeta = parseBlockscoutTokenMeta(meta.json)
  let totalSupplyRaw = parsedMeta.totalSupplyRaw

  const holders = await blockscoutGet(BLOCKSCOUT_HOLDERS_PATH(hash), fetchImpl)
  const holderRows = holders.ok ? parseBlockscoutHolderItems(holders.json, totalSupplyRaw) : []
  if (holderRows.length > 0) {
    return {
      rows: holderRows,
      totalSupplyRaw,
      tokenType: parsedMeta.tokenType,
      attempted: true,
      used: true,
      error: null,
      source: 'holders',
    }
  }

  const transfers = await blockscoutGet(BLOCKSCOUT_TRANSFERS_PATH(hash), fetchImpl)
  const transferAddresses = transfers.ok ? parseBlockscoutTransferAddresses(transfers.json) : []
  if (transferAddresses.length === 0) {
    return {
      rows: [],
      totalSupplyRaw,
      tokenType: parsedMeta.tokenType,
      attempted: true,
      used: holders.ok || transfers.ok,
      error: holders.error ?? transfers.error ?? 'no_holder_rows',
      source: 'none',
    }
  }

  if (!totalSupplyRaw) {
    const supply = await fetchOnchainTotalSupply('robinhood', hash)
    if (supply != null && supply > BigInt(0)) totalSupplyRaw = supply.toString()
  }

  const probeAddresses = [...new Set([...ROBINHOOD_BURN_ADDRESSES, ...transferAddresses])].slice(0, 20)
  const rows: RobinhoodLpHolderRow[] = []
  for (const address of probeAddresses) {
    const bal = await rpcBalanceOf(hash, address)
    if (bal == null || bal <= BigInt(0)) continue
    const isContract = BURN_ADDRESSES_SET.has(address) ? false : await rpcIsContract(address)
    const pct = totalSupplyRaw
      ? Number((bal * BigInt(10_000)) / BigInt(totalSupplyRaw)) / 100
      : null
    rows.push({ address, balanceRaw: bal.toString(), pct, isContract })
  }
  rows.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))

  return {
    rows,
    totalSupplyRaw,
    tokenType: parsedMeta.tokenType,
    attempted: true,
    used: true,
    error: rows.length === 0 ? 'transfers_fallback_no_balances' : null,
    source: 'transfers',
  }
}

const BURN_ADDRESSES_SET = new Set<string>(ROBINHOOD_BURN_ADDRESSES)

async function enrichContractFlags(rows: RobinhoodLpHolderRow[]): Promise<RobinhoodLpHolderRow[]> {
  const unknown = rows.filter((row) => row.isContract == null && !BURN_ADDRESSES_SET.has(row.address)).slice(0, 8)
  if (unknown.length === 0) return rows
  const flags = await Promise.all(unknown.map(async (row) => [row.address, await rpcIsContract(row.address)] as const))
  const map = new Map(flags)
  return rows.map((row) => (map.has(row.address) ? { ...row, isContract: map.get(row.address) ?? row.isContract } : row))
}

export async function resolveRobinhoodLpProof(input: ResolveRobinhoodLpProofInput): Promise<RobinhoodLpProofResult> {
  const tokenAddress = (normalizeRobinhoodAddress(input.tokenAddress) ?? input.tokenAddress).toLowerCase()
  const poolAddress = normalizeRobinhoodAddress(input.poolAddress)
  const pairAddress = normalizeRobinhoodAddress(input.pairAddress) ?? poolAddress
  const lpTokenAddress = normalizeRobinhoodAddress(input.lpTokenAddress) ?? poolAddress
  const concentrated = input.concentrated || isConcentratedRobinhoodPoolType(input.poolType)
  const chainOk = selectedRobinhoodPoolChainOk(input.poolChainHint)
  const fetchImpl = input.fetchImpl ?? fetch

  const resolutionAudit: RobinhoodLpResolutionAudit = {
    ...emptyRobinhoodLpResolutionAudit(tokenAddress),
    poolAddress,
    pairAddress,
    lpTokenAddress,
    dex: input.dex,
    poolType: input.poolType,
    liquidityUsd: input.liquidityUsd,
    createdAt: input.createdAt,
    selectedPoolChainOk: chainOk,
    rejectedReason: chainOk
      ? null
      : (input.poolChainHint == null
        ? 'selected_pool_chain_unconfirmed'
        : 'selected_pool_rejected_wrong_chain'),
  }

  const proofAudit: RobinhoodLpProofAudit = {
    ...emptyRobinhoodLpProofAudit(tokenAddress),
    selectedPoolAddress: poolAddress,
    selectedPoolChainOk: chainOk,
    poolType: input.poolType,
    lpTokenAddress,
    lpTokenResolved: Boolean(lpTokenAddress),
    positionManagerDetected: Boolean(input.positionManagerDetected),
    concentratedProofAttempted: Boolean(input.concentratedProofAttempted) || concentrated,
  }

  if (!chainOk) {
    proofAudit.status = 'unavailable_with_reason'
    proofAudit.reason = resolutionAudit.rejectedReason === 'selected_pool_rejected_wrong_chain'
      ? 'Selected pool is not chainId 4663 — Base/ETH LP data cannot populate Robinhood LP proof.'
      : 'Selected Robinhood pool chainId could not be confirmed as 4663.'
    const copy = buildRobinhoodLpCopy({ concentrated, classification: proofAudit.status, reason: proofAudit.reason, positionOwnerProof: input.positionOwnerProof ?? (concentrated ? 'unavailable' : null) })
    return {
      classification: proofAudit.status,
      reason: proofAudit.reason,
      copy,
      resolutionAudit,
      proofAudit,
      lpHolderRows: [],
      tokenHolderRows: [],
      lpControlOverlay: null,
    }
  }

  if (concentrated) {
    const classified = classifyRobinhoodLpHolders({
      concentrated: true,
      holderRows: [],
      totalSupplyRaw: null,
      holderFetchAttempted: false,
    })
    proofAudit.status = classified.classification
    proofAudit.reason = classified.reason
    const copy = buildRobinhoodLpCopy({
      concentrated: true,
      classification: classified.classification,
      reason: classified.reason,
      positionOwnerProof: input.positionOwnerProof ?? 'unavailable',
    })
    return {
      classification: classified.classification,
      reason: classified.reason,
      copy,
      resolutionAudit,
      proofAudit,
      lpHolderRows: [],
      tokenHolderRows: [],
      lpControlOverlay: null,
    }
  }

  if (!lpTokenAddress) {
    proofAudit.status = 'unavailable_with_reason'
    proofAudit.reason = 'LP token address was not resolved for this Robinhood pool. LP lock not confirmed.'
    const copy = buildRobinhoodLpCopy({ concentrated: false, classification: proofAudit.status, reason: proofAudit.reason })
    return {
      classification: proofAudit.status,
      reason: proofAudit.reason,
      copy,
      resolutionAudit,
      proofAudit,
      lpHolderRows: [],
      tokenHolderRows: [],
      lpControlOverlay: mapRobinhoodClassificationToLpControl(proofAudit.status, proofAudit.reason, [`pool=${poolAddress ?? 'none'}`]),
    }
  }

  let rows = (input.existingHolderRows ?? []).filter((row) => {
    if (row.pct != null && Number.isFinite(row.pct) && row.pct > 0) return true
    if (row.balanceRaw == null) return false
    const raw = String(row.balanceRaw).trim()
    return raw !== '' && raw !== '0' && raw !== '0x0'
  })
  let totalSupplyRaw = input.existingTotalSupplyRaw ?? null
  let blockscoutUsed = false
  let holderRowsAttempted = rows.length > 0
  let holderFetchError: string | null = null

  if (!input.skipNetwork && rows.length === 0) {
    const fetched = await fetchRobinhoodBlockscoutHolders(lpTokenAddress, fetchImpl)
    holderRowsAttempted = fetched.attempted
    blockscoutUsed = fetched.used
    holderFetchError = fetched.rows.length === 0 ? (fetched.error ?? 'no_holder_rows') : null
    rows = fetched.rows
    if (!totalSupplyRaw) totalSupplyRaw = fetched.totalSupplyRaw
  }

  if (!totalSupplyRaw && !input.skipNetwork) {
    const supply = await fetchOnchainTotalSupply('robinhood', lpTokenAddress)
    if (supply != null && supply > BigInt(0)) totalSupplyRaw = supply.toString()
  }

  if (rows.length > 0 && !input.skipNetwork) {
    rows = await enrichContractFlags(rows)
  }

  const classified = classifyRobinhoodLpHolders({
    concentrated: false,
    holderRows: rows,
    totalSupplyRaw,
    holderFetchAttempted: holderRowsAttempted,
    holderFetchError,
  })

  proofAudit.holderRowsAttempted = holderRowsAttempted
  proofAudit.holderRowsReturned = rows.length
  proofAudit.blockscoutUsed = blockscoutUsed
  proofAudit.totalSupplyRead = totalSupplyRaw != null
  proofAudit.burnAddressSharePct = classified.burnSharePct
  proofAudit.lockerDetected = classified.lockerDetected
  proofAudit.controllerAddress = classified.controllerAddress
  proofAudit.controllerSharePct = classified.controllerSharePct
  proofAudit.status = classified.classification
  proofAudit.reason = classified.reason

  const evidence = [
    `pool=${poolAddress ?? 'none'}`,
    `lpToken=${lpTokenAddress}`,
    `holder_rows=${rows.length}`,
    `holder_source=${blockscoutUsed ? 'blockscout' : (rows.length > 0 ? 'existing' : 'none')}`,
    classified.burnSharePct != null ? `burn_share=${classified.burnSharePct.toFixed(2)}%` : null,
    classified.controllerAddress ? `top_holder=${classified.controllerAddress}` : null,
    classified.controllerSharePct != null ? `top_share=${classified.controllerSharePct.toFixed(2)}%` : null,
    'chainId=4663',
  ].filter((line): line is string => Boolean(line))

  const copy = buildRobinhoodLpCopy({
    concentrated: false,
    classification: classified.classification,
    reason: classified.reason,
  })

  return {
    classification: classified.classification,
    reason: classified.reason,
    copy,
    resolutionAudit,
    proofAudit,
    lpHolderRows: rows,
    tokenHolderRows: [],
    lpControlOverlay: mapRobinhoodClassificationToLpControl(classified.classification, classified.reason, evidence),
  }
}

export function assertRobinhoodChainId(chainId: number): asserts chainId is 4663 {
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(`Robinhood LP proof only accepts chainId ${ROBINHOOD_CHAIN_ID}, got ${chainId}`)
  }
}

// ROBINHOOD TOKEN SCANNER LP PROOF — SHARED, DISCLOSED.
//
// Pure classification + copy for Robinhood Chain (chainId 4663) Token Scanner LP/holder proof.
// No network, no env, no Base/ETH locker registry, no PinkLock/Unicrypt assumption.
// Missing holder rows are NEVER treated as 0% burn/lock. A lock is NEVER marked verified
// unless a Robinhood-chain locker is actually proven (there is no Robinhood locker registry
// in this codebase today, so verified_locked is unreachable from classification alone).

export const ROBINHOOD_LP_CHAIN_ID = 4663
export const ROBINHOOD_LP_CHAIN_SLUG = 'robinhood'

export const ROBINHOOD_BURN_ADDRESSES = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
] as const

export const ROBINHOOD_VERIFIED_BURN_PCT = 99
export const ROBINHOOD_WALLET_CONTROL_PCT = 80

export const ROBINHOOD_HOLDER_UNAVAILABLE_LABEL =
  'Holder distribution unavailable — Robinhood provider did not return holder rows.'
export const ROBINHOOD_SECURITY_UNSUPPORTED_LABEL = 'Security simulation unsupported on Robinhood'
export const ROBINHOOD_LP_LOCK_NOT_CONFIRMED_LABEL = 'LP lock not confirmed'
export const ROBINHOOD_LP_CONTROLLER_NOT_VERIFIED_LABEL = 'LP controller not verified'
export const ROBINHOOD_CONCENTRATED_MODEL_LABEL = 'Concentrated LP model'
export const ROBINHOOD_CONCENTRATED_LOCK_LABEL =
  'Lock/burn proof not applicable to ERC-20 LP tokens'
export const ROBINHOOD_SECURITY_PROVIDER_ERROR_LABEL = 'Security provider returned an error'

export type RobinhoodLpClassification =
  | 'verified_burned'
  | 'verified_locked'
  | 'wallet_controlled'
  | 'contract_controlled_unverified'
  | 'partial_evidence'
  | 'unavailable_with_reason'

export interface RobinhoodLpHolderRow {
  address: string
  balanceRaw: string | null
  pct: number | null
  isContract: boolean | null
}

export interface RobinhoodLpResolutionAudit {
  chainId: 4663
  tokenAddress: string
  poolAddress: string | null
  pairAddress: string | null
  lpTokenAddress: string | null
  dex: string | null
  poolType: string | null
  liquidityUsd: number | null
  createdAt: string | null
  selectedPoolChainOk: boolean
  rejectedReason: string | null
}

export interface RobinhoodLpProofAudit {
  chainId: 4663
  tokenAddress: string
  selectedPoolAddress: string | null
  selectedPoolChainOk: boolean
  poolType: string | null
  lpTokenAddress: string | null
  lpTokenResolved: boolean
  holderRowsAttempted: boolean
  holderRowsReturned: number
  blockscoutUsed: boolean
  totalSupplyRead: boolean
  burnAddressSharePct: number | null
  lockerDetected: boolean
  controllerAddress: string | null
  controllerSharePct: number | null
  positionManagerDetected: boolean
  concentratedProofAttempted: boolean
  status: RobinhoodLpClassification
  reason: string
}

export interface RobinhoodLpClassificationResult {
  classification: RobinhoodLpClassification
  reason: string
  burnSharePct: number | null
  lockSharePct: number | null
  controllerAddress: string | null
  controllerSharePct: number | null
  controllerKind: 'burn' | 'wallet' | 'contract' | 'unknown'
  lockerDetected: boolean
}

export interface RobinhoodLpCopy {
  lockLabel: string
  lockWhy: string
  controllerLabel: string
  concentratedNote: string | null
  positionOwnerProof: 'verified' | 'partial' | 'unavailable' | null
}

export interface RobinhoodLpSafetyBuckets {
  verified: string[]
  partial: string[]
  missing: string[]
  unsupported: string[]
}

const BURN_SET = new Set<string>(ROBINHOOD_BURN_ADDRESSES)

function isHexAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^0x[a-f0-9]{40}$/.test(value)
}

export function normalizeRobinhoodAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const n = value.trim().toLowerCase()
  return isHexAddress(n) ? n : null
}

export function isRobinhoodBurnAddress(address: string | null | undefined): boolean {
  const n = normalizeRobinhoodAddress(address)
  return n != null && BURN_SET.has(n)
}

// Fail closed: only 4663 / "robinhood" count as this chain. Base (8453), ETH (1), BNB (56)
// and any other slug are rejected so cached or provider-leaked pools cannot populate proof.
export function selectedRobinhoodPoolChainOk(poolChainHint: unknown): boolean {
  if (poolChainHint == null) return false
  if (typeof poolChainHint === 'number') return poolChainHint === ROBINHOOD_LP_CHAIN_ID
  if (typeof poolChainHint !== 'string') return false
  const raw = poolChainHint.trim().toLowerCase()
  if (!raw) return false
  if (raw === 'robinhood' || raw === 'robinhood-chain' || raw === 'robinhoodchain') return true
  if (raw === String(ROBINHOOD_LP_CHAIN_ID)) return true
  const prefix = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : raw
  if (prefix === 'robinhood' || prefix === String(ROBINHOOD_LP_CHAIN_ID)) return true
  if (prefix === 'base' || prefix === 'ethereum' || prefix === 'eth' || prefix === 'bsc' || prefix === 'bnb') return false
  const asNum = Number(prefix)
  if (Number.isFinite(asNum) && asNum !== ROBINHOOD_LP_CHAIN_ID) return false
  return false
}

export function emptyRobinhoodLpResolutionAudit(tokenAddress: string): RobinhoodLpResolutionAudit {
  return {
    chainId: ROBINHOOD_LP_CHAIN_ID,
    tokenAddress: tokenAddress.toLowerCase(),
    poolAddress: null,
    pairAddress: null,
    lpTokenAddress: null,
    dex: null,
    poolType: null,
    liquidityUsd: null,
    createdAt: null,
    selectedPoolChainOk: false,
    rejectedReason: 'no_pool_resolved',
  }
}

export function emptyRobinhoodLpProofAudit(tokenAddress: string): RobinhoodLpProofAudit {
  return {
    chainId: ROBINHOOD_LP_CHAIN_ID,
    tokenAddress: tokenAddress.toLowerCase(),
    selectedPoolAddress: null,
    selectedPoolChainOk: false,
    poolType: null,
    lpTokenAddress: null,
    lpTokenResolved: false,
    holderRowsAttempted: false,
    holderRowsReturned: 0,
    blockscoutUsed: false,
    totalSupplyRead: false,
    burnAddressSharePct: null,
    lockerDetected: false,
    controllerAddress: null,
    controllerSharePct: null,
    positionManagerDetected: false,
    concentratedProofAttempted: false,
    status: 'unavailable_with_reason',
    reason: 'Robinhood LP proof was not attempted.',
  }
}

export function isConcentratedRobinhoodPoolType(poolType: string | null | undefined): boolean {
  const t = (poolType ?? '').toLowerCase()
  return t === 'v3' || t === 'v4' || t === 'concentrated' || t === 'concentrated_liquidity' || t === 'clmm' || t === 'slipstream'
}

function derivePct(balanceRaw: string | null, totalSupplyRaw: string | null): number | null {
  if (balanceRaw == null || totalSupplyRaw == null) return null
  try {
    const bal = BigInt(balanceRaw)
    const supply = BigInt(totalSupplyRaw)
    if (supply <= BigInt(0)) return null
    return Number((bal * BigInt(10_000)) / supply) / 100
  } catch {
    return null
  }
}

export function classifyRobinhoodLpHolders(params: {
  concentrated: boolean
  holderRows: RobinhoodLpHolderRow[]
  totalSupplyRaw: string | null
  holderFetchAttempted: boolean
  holderFetchError?: string | null
}): RobinhoodLpClassificationResult {
  if (params.concentrated) {
    return {
      classification: 'unavailable_with_reason',
      reason: 'Concentrated liquidity detected — standard ERC-20 LP-token lock/burn proof does not apply. Controller/position proof still required.',
      burnSharePct: null,
      lockSharePct: null,
      controllerAddress: null,
      controllerSharePct: null,
      controllerKind: 'unknown',
      lockerDetected: false,
    }
  }

  if (!params.holderFetchAttempted) {
    return {
      classification: 'unavailable_with_reason',
      reason: 'LP holder proof was not attempted for this Robinhood pool.',
      burnSharePct: null,
      lockSharePct: null,
      controllerAddress: null,
      controllerSharePct: null,
      controllerKind: 'unknown',
      lockerDetected: false,
    }
  }

  if (params.holderFetchError) {
    return {
      classification: 'unavailable_with_reason',
      reason: `LP holder rows unavailable — ${params.holderFetchError}.`,
      burnSharePct: null,
      lockSharePct: null,
      controllerAddress: null,
      controllerSharePct: null,
      controllerKind: 'unknown',
      lockerDetected: false,
    }
  }

  const rows = params.holderRows
    .map((row) => {
      const address = normalizeRobinhoodAddress(row.address)
      if (!address) return null
      const pct = (row.pct != null && Number.isFinite(row.pct) && row.pct > 0)
        ? row.pct
        : derivePct(row.balanceRaw, params.totalSupplyRaw)
      return {
        address,
        balanceRaw: row.balanceRaw,
        pct: pct != null && Number.isFinite(pct) ? pct : null,
        isContract: row.isContract,
      }
    })
    .filter((row): row is RobinhoodLpHolderRow & { address: string } => row != null)

  if (rows.length === 0) {
    // Missing rows are a gap, never a 0% burn/lock claim.
    return {
      classification: 'unavailable_with_reason',
      reason: 'LP lock not confirmed — Robinhood provider did not return LP token holder rows.',
      burnSharePct: null,
      lockSharePct: null,
      controllerAddress: null,
      controllerSharePct: null,
      controllerKind: 'unknown',
      lockerDetected: false,
    }
  }

  const usable = rows.filter((row) => row.pct != null && row.pct > 0)
  if (usable.length === 0) {
    return {
      classification: 'partial_evidence',
      reason: 'LP holder rows returned but share percentages could not be computed (totalSupply unread or balances missing). LP lock not confirmed.',
      burnSharePct: null,
      lockSharePct: null,
      controllerAddress: null,
      controllerSharePct: null,
      controllerKind: 'unknown',
      lockerDetected: false,
    }
  }

  const burnSharePct = usable
    .filter((row) => isRobinhoodBurnAddress(row.address))
    .reduce((sum, row) => sum + (row.pct ?? 0), 0)

  const ranked = [...usable].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
  const top = ranked[0] ?? null
  const topIsBurn = top != null && isRobinhoodBurnAddress(top.address)
  const topIsContract = Boolean(top?.isContract) && !topIsBurn
  const topIsWallet = top != null && !topIsBurn && top.isContract === false
  const topPct = top?.pct ?? 0

  // verified_locked is intentionally unreachable here: this codebase has no Robinhood locker
  // registry, and Base/ETH locker addresses must never be reused.
  const lockerDetected = false
  const lockSharePct = 0

  if (burnSharePct >= ROBINHOOD_VERIFIED_BURN_PCT) {
    const burnAddr = usable.find((row) => isRobinhoodBurnAddress(row.address))?.address ?? ROBINHOOD_BURN_ADDRESSES[1]
    return {
      classification: 'verified_burned',
      reason: `On-chain LP holder rows show ${burnSharePct.toFixed(2)}% of LP supply at burn/dead addresses.`,
      burnSharePct,
      lockSharePct,
      controllerAddress: burnAddr,
      controllerSharePct: burnSharePct,
      controllerKind: 'burn',
      lockerDetected,
    }
  }

  if (top && topIsWallet && topPct >= ROBINHOOD_WALLET_CONTROL_PCT) {
    return {
      classification: 'wallet_controlled',
      reason: `Dominant LP wallet ${top.address} holds ${topPct.toFixed(2)}% of LP supply — liquidity can be removed.`,
      burnSharePct: burnSharePct > 0 ? burnSharePct : 0,
      lockSharePct,
      controllerAddress: top.address,
      controllerSharePct: topPct,
      controllerKind: 'wallet',
      lockerDetected,
    }
  }

  if (top && topIsContract && topPct >= ROBINHOOD_WALLET_CONTROL_PCT) {
    return {
      classification: 'contract_controlled_unverified',
      reason: `Dominant LP holder is a contract (${top.address}, ${topPct.toFixed(2)}%) — not a verified Robinhood locker. LP lock not confirmed.`,
      burnSharePct: burnSharePct > 0 ? burnSharePct : 0,
      lockSharePct,
      controllerAddress: top.address,
      controllerSharePct: topPct,
      controllerKind: 'contract',
      lockerDetected,
    }
  }

  if (top && top.isContract == null && topPct >= ROBINHOOD_WALLET_CONTROL_PCT && !topIsBurn) {
    return {
      classification: 'partial_evidence',
      reason: `Dominant LP holder ${top.address} holds ${topPct.toFixed(2)}%, but contract-vs-wallet proof did not resolve. LP controller not verified.`,
      burnSharePct: burnSharePct > 0 ? burnSharePct : 0,
      lockSharePct,
      controllerAddress: top.address,
      controllerSharePct: topPct,
      controllerKind: 'unknown',
      lockerDetected,
    }
  }

  const parts: string[] = []
  if (burnSharePct > 0) parts.push(`burn share ${burnSharePct.toFixed(2)}% (below ${ROBINHOOD_VERIFIED_BURN_PCT}% verified-burn threshold)`)
  if (top && !topIsBurn) parts.push(`top holder ${top.address} at ${topPct.toFixed(2)}%`)
  return {
    classification: 'partial_evidence',
    reason: `LP holder rows returned but no dominant burn/lock/controller pattern was proven${parts.length ? ` (${parts.join('; ')})` : ''}. LP lock not confirmed.`,
    burnSharePct: burnSharePct > 0 ? burnSharePct : 0,
    lockSharePct,
    controllerAddress: top && !topIsBurn ? top.address : null,
    controllerSharePct: top && !topIsBurn ? topPct : null,
    controllerKind: topIsWallet ? 'wallet' : topIsContract ? 'contract' : 'unknown',
    lockerDetected,
  }
}

export function buildRobinhoodLpCopy(params: {
  concentrated: boolean
  classification: RobinhoodLpClassification
  reason: string
  positionOwnerProof?: 'verified' | 'partial' | 'unavailable' | null
}): RobinhoodLpCopy {
  if (params.concentrated) {
    const position = params.positionOwnerProof ?? 'unavailable'
    return {
      lockLabel: ROBINHOOD_CONCENTRATED_LOCK_LABEL,
      lockWhy: 'Standard LP-token lock/burn proof does not apply to this concentrated pool.',
      controllerLabel: `Position owner proof: ${position}`,
      concentratedNote: ROBINHOOD_CONCENTRATED_MODEL_LABEL,
      positionOwnerProof: position,
    }
  }

  if (params.classification === 'verified_burned') {
    return {
      lockLabel: 'LP burned',
      lockWhy: params.reason,
      controllerLabel: 'LP controller verified (burn address)',
      concentratedNote: null,
      positionOwnerProof: null,
    }
  }
  if (params.classification === 'verified_locked') {
    return {
      lockLabel: 'LP locked',
      lockWhy: params.reason,
      controllerLabel: 'LP controller verified (lock contract)',
      concentratedNote: null,
      positionOwnerProof: null,
    }
  }
  if (params.classification === 'wallet_controlled') {
    return {
      lockLabel: `${ROBINHOOD_LP_LOCK_NOT_CONFIRMED_LABEL} — LP is wallet-controlled`,
      lockWhy: params.reason,
      controllerLabel: 'LP controller verified (wallet)',
      concentratedNote: null,
      positionOwnerProof: null,
    }
  }
  if (params.classification === 'contract_controlled_unverified') {
    return {
      lockLabel: `${ROBINHOOD_LP_LOCK_NOT_CONFIRMED_LABEL} — dominant holder is an unverified contract`,
      lockWhy: params.reason,
      controllerLabel: ROBINHOOD_LP_CONTROLLER_NOT_VERIFIED_LABEL,
      concentratedNote: null,
      positionOwnerProof: null,
    }
  }
  if (params.classification === 'partial_evidence') {
    return {
      lockLabel: `${ROBINHOOD_LP_LOCK_NOT_CONFIRMED_LABEL} — ${params.reason}`,
      lockWhy: params.reason,
      controllerLabel: ROBINHOOD_LP_CONTROLLER_NOT_VERIFIED_LABEL,
      concentratedNote: null,
      positionOwnerProof: null,
    }
  }
  return {
    lockLabel: `${ROBINHOOD_LP_LOCK_NOT_CONFIRMED_LABEL} — ${params.reason}`,
    lockWhy: params.reason,
    controllerLabel: ROBINHOOD_LP_CONTROLLER_NOT_VERIFIED_LABEL,
    concentratedNote: null,
    positionOwnerProof: null,
  }
}

export function confirmedRobinhoodLpControlStatus(status: string | null | undefined): boolean {
  return status === 'burned' || status === 'locked' || status === 'team_controlled' || status === 'wallet_controlled'
}

export function mapRobinhoodClassificationToLpControl(classification: RobinhoodLpClassification, reason: string, evidence: string[]): {
  status: 'burned' | 'locked' | 'team_controlled' | 'partial'
  confidence: 'high' | 'medium' | 'low'
  reason: string
  evidence: string[]
  lpControllerType: 'burn' | 'lockContract' | 'wallet' | 'contract' | 'unknown'
} {
  if (classification === 'verified_burned') {
    return { status: 'burned', confidence: 'high', reason, evidence, lpControllerType: 'burn' }
  }
  if (classification === 'verified_locked') {
    return { status: 'locked', confidence: 'high', reason, evidence, lpControllerType: 'lockContract' }
  }
  if (classification === 'wallet_controlled') {
    return { status: 'team_controlled', confidence: 'high', reason, evidence, lpControllerType: 'wallet' }
  }
  if (classification === 'contract_controlled_unverified') {
    return { status: 'partial', confidence: 'medium', reason, evidence, lpControllerType: 'contract' }
  }
  return { status: 'partial', confidence: 'low', reason, evidence, lpControllerType: 'unknown' }
}

export function buildRobinhoodLpSafetyBuckets(params: {
  audit: RobinhoodLpProofAudit
  copy: RobinhoodLpCopy
  liquidityUsd: number | null
  tokenHolderRowsReturned: number
  securityUnsupported: boolean
  securityErrored: boolean
  concentrated: boolean
}): RobinhoodLpSafetyBuckets {
  const verified: string[] = []
  const partial: string[] = []
  const missing: string[] = []
  const unsupported: string[] = []

  if ((params.liquidityUsd ?? 0) > 0) {
    verified.push(`Liquidity detected${params.audit.selectedPoolAddress ? ` at ${params.audit.selectedPoolAddress}` : ''}.`)
  }
  if (params.audit.selectedPoolChainOk) {
    verified.push('Selected pool confirmed on Robinhood Chain (chainId 4663).')
  }

  if (params.audit.status === 'verified_burned') verified.push(params.audit.reason)
  else if (params.audit.status === 'verified_locked') verified.push(params.audit.reason)
  else if (params.audit.status === 'wallet_controlled') verified.push(params.audit.reason)
  else if (params.audit.status === 'contract_controlled_unverified') partial.push(params.audit.reason)
  else if (params.audit.status === 'partial_evidence') partial.push(params.audit.reason)
  else missing.push(params.audit.reason)

  if (params.concentrated) {
    unsupported.push(ROBINHOOD_CONCENTRATED_MODEL_LABEL)
    unsupported.push(ROBINHOOD_CONCENTRATED_LOCK_LABEL)
    if (params.copy.positionOwnerProof === 'verified') verified.push('Position owner proof: verified')
    else if (params.copy.positionOwnerProof === 'partial') partial.push('Position owner proof: partial')
    else missing.push('Position owner proof: unavailable')
  }

  if (params.tokenHolderRowsReturned > 0) {
    verified.push(`Holder distribution verified — ${params.tokenHolderRowsReturned} holder row${params.tokenHolderRowsReturned === 1 ? '' : 's'} indexed.`)
  } else {
    missing.push(ROBINHOOD_HOLDER_UNAVAILABLE_LABEL)
  }

  if (params.securityUnsupported) unsupported.push(ROBINHOOD_SECURITY_UNSUPPORTED_LABEL)
  else if (params.securityErrored) missing.push(ROBINHOOD_SECURITY_PROVIDER_ERROR_LABEL)

  if (!params.audit.selectedPoolChainOk) {
    missing.push(params.audit.reason || 'Selected pool could not be confirmed as chainId 4663.')
  }

  return { verified, partial, missing, unsupported }
}

export function usesErc20LpLockBurnWording(copy: RobinhoodLpCopy): boolean {
  const blob = `${copy.lockLabel} ${copy.lockWhy} ${copy.controllerLabel} ${copy.concentratedNote ?? ''}`
  if (copy.concentratedNote) return /lp tokens (burned|locked)|unicrypt|pinklock|pink lock/i.test(blob)
  return false
}

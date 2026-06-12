import type { LpControllerIntel } from './lpControllerIntel'

export type LpMovementWatchStatus =
  | 'open_check'
  | 'quiet'
  | 'movement_detected'
  | 'protected_movement'
  | 'watch'
  | 'high'
  | 'not_applicable'
  | 'pool_model_not_supported'

export type LpMovementRisk = 'unknown' | 'low' | 'watch' | 'high' | 'protected' | 'not_applicable'

export interface LpMovementWatchInput {
  chain?: string | null
  lpControllerIntel?: LpControllerIntel | null
  lpControl?: Record<string, unknown> | null
  selectedPool?: Record<string, unknown> | null
  lpMeta?: Record<string, unknown> | null
  lpTransferEvidence?: unknown
}

export interface LpMovementWatch {
  status: LpMovementWatchStatus
  movementRisk: LpMovementRisk
  confidence: string
  controller: string | null
  controllerType: string
  lpTokenOrPool: string | null
  recentMovementDetected: boolean | null
  recentTransferCount: number | null
  lastMovementAt: string | null
  movementTypes: string[]
  summary: string
  signals: string[]
  evidenceGaps: string[]
  nextActions: string[]
}

type MovementTransfer = {
  from: string | null
  to: string | null
  timestamp: number | null
  hash: string | null
  type: string | null
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEAD_ADDRESSES = new Set([
  ZERO_ADDRESS,
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
])

// Small cross-chain list only. This is used only to classify already-provided
// transfer evidence; it never triggers an additional provider scan.
const KNOWN_SAFE_TARGETS_BY_CHAIN: Record<string, Set<string>> = {
  eth: new Set([
    '0x71b5759d73262fbb223956913ecf4ecc51057641', // Unicrypt locker
  ]),
  base: new Set<string>(),
  bnb: new Set<string>(),
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeAddress(value: unknown): string | null {
  const raw = asString(value)?.toLowerCase() ?? null
  return raw && /^0x[a-f0-9]{40}$/.test(raw) ? raw : null
}

function normalizeChain(value: unknown): string {
  const raw = asString(value)?.toLowerCase() ?? ''
  if (raw === 'ethereum' || raw === 'eth' || raw === 'mainnet' || raw === '1') return 'eth'
  if (raw === 'binance' || raw === 'bsc' || raw === 'bnb' || raw === '56') return 'bnb'
  if (raw === 'base' || raw === '8453') return 'base'
  return raw || 'unknown'
}

function isUnsupportedPoolModel(lpControl: Record<string, unknown>, selectedPool: Record<string, unknown>, lpMeta: Record<string, unknown>): 'not_applicable' | 'pool_model_not_supported' | null {
  const status = asString(lpControl.status)?.toLowerCase() ?? null
  const display = asString(lpControl.displayLpModel)?.toLowerCase() ?? null
  const poolModel = asString(selectedPool.model)?.toLowerCase() ?? null
  const metaModel = asString(lpMeta.displayLpModel)?.toLowerCase() ?? asString(lpMeta.primaryMarketType)?.toLowerCase() ?? null
  const applicability = asString(lpControl.proofApplicability)?.toLowerCase() ?? null
  if (
    status === 'concentrated_liquidity' ||
    status === 'protocol' ||
    status === 'protocol_managed' ||
    display === 'concentrated_liquidity' ||
    display === 'protocol_or_gauge' ||
    poolModel === 'concentrated' ||
    poolModel === 'concentrated_liquidity' ||
    poolModel === 'stableswap' ||
    poolModel === 'protocol_or_gauge' ||
    metaModel === 'concentrated' ||
    metaModel === 'concentrated_liquidity' ||
    metaModel === 'stableswap' ||
    applicability === 'not_applicable'
  ) {
    return status === 'protocol' || status === 'protocol_managed' || display === 'protocol_or_gauge' || poolModel === 'protocol_or_gauge'
      ? 'pool_model_not_supported'
      : 'not_applicable'
  }
  return null
}

function collectEvidenceRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of ['transfers', 'lpTransfers', 'recentTransfers', 'events', 'items', 'result']) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

function extractTransfer(row: unknown): MovementTransfer | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const from = normalizeAddress(record.from ?? record.from_address ?? record.fromAddress)
  const to = normalizeAddress(record.to ?? record.to_address ?? record.toAddress)
  if (!from && !to) return null
  const rawTs = record.timestamp ?? record.blockTimestamp ?? record.block_timestamp ?? record.time
  let timestamp: number | null = null
  if (typeof rawTs === 'number' && Number.isFinite(rawTs)) timestamp = rawTs > 2_000_000_000 ? Math.floor(rawTs / 1000) : Math.floor(rawTs)
  else if (typeof rawTs === 'string' && rawTs.trim()) {
    const asNum = Number(rawTs)
    if (Number.isFinite(asNum)) timestamp = asNum > 2_000_000_000 ? Math.floor(asNum / 1000) : Math.floor(asNum)
    else {
      const parsed = Date.parse(rawTs)
      if (Number.isFinite(parsed)) timestamp = Math.floor(parsed / 1000)
    }
  }
  return {
    from,
    to,
    timestamp,
    hash: asString(record.hash ?? record.txHash ?? record.transaction_hash),
    type: asString(record.type ?? record.eventType ?? record.method),
  }
}

function isSafeTarget(chain: string, address: string | null, controllerType: string): boolean {
  if (!address) return false
  if (DEAD_ADDRESSES.has(address)) return true
  if (controllerType === 'lock_contract' || controllerType === 'burn') return true
  return KNOWN_SAFE_TARGETS_BY_CHAIN[chain]?.has(address) ?? false
}

function formatMovementTime(timestamp: number | null): string | null {
  if (timestamp == null) return null
  const date = new Date(timestamp * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) list.push(value)
}

export function buildLpMovementWatch(input: LpMovementWatchInput): LpMovementWatch {
  const lpControl = input.lpControl ?? {}
  const selectedPool = input.selectedPool ?? {}
  const lpMeta = input.lpMeta ?? {}
  const chain = normalizeChain(input.chain)
  const controller = normalizeAddress(input.lpControllerIntel?.controller) ?? normalizeAddress(lpControl.lpController)
  const controllerType = input.lpControllerIntel?.controllerType ?? asString(lpControl.lpControllerType) ?? 'unknown'
  const lpTokenOrPool = normalizeAddress(selectedPool.address) ?? normalizeAddress(lpControl.verificationPool) ?? normalizeAddress(lpControl.primaryMarketPool) ?? normalizeAddress(lpMeta.lpToken)
  const unsupported = isUnsupportedPoolModel(lpControl, selectedPool, lpMeta)

  if (unsupported) {
    const standardMessage = unsupported === 'not_applicable'
      ? 'This pool uses a concentrated-liquidity model, so ERC-20 LP-token transfer movement is not applicable in this scan.'
      : 'This pool model is protocol-specific, so ERC-20 LP-token transfer movement is not supported by this scan.'
    return {
      status: unsupported,
      movementRisk: 'not_applicable',
      confidence: 'medium',
      controller,
      controllerType,
      lpTokenOrPool,
      recentMovementDetected: null,
      recentTransferCount: null,
      lastMovementAt: null,
      movementTypes: [],
      summary: standardMessage,
      signals: ['standard ERC-20 LP transfer model not applicable'],
      evidenceGaps: ['protocol-specific liquidity movement requires model-specific position evidence'],
      nextActions: ['review protocol-specific liquidity positions', 'monitor pool liquidity and position changes', 'rescan after liquidity changes'],
    }
  }

  const evidenceRows = collectEvidenceRows(input.lpTransferEvidence)
    .concat(collectEvidenceRows((lpControl as Record<string, unknown>).lpTransferEvidence))
    .concat(collectEvidenceRows((lpControl as Record<string, unknown>).lpTransfers))
  const transfers = evidenceRows.map(extractTransfer).filter(Boolean) as MovementTransfer[]
  const signals: string[] = []
  const evidenceGaps: string[] = []
  const nextActions = ['monitor controller wallet', 'verify LP token transfers', 'rescan after liquidity changes']

  if (controller) signals.push('LP controller is known')
  if (lpTokenOrPool) signals.push('LP token or pool address is known')

  if (transfers.length === 0) {
    evidenceGaps.push('recent LP-controller transfer history not confirmed')
    return {
      status: 'open_check',
      movementRisk: 'unknown',
      confidence: 'low',
      controller,
      controllerType,
      lpTokenOrPool,
      recentMovementDetected: null,
      recentTransferCount: null,
      lastMovementAt: null,
      movementTypes: [],
      summary: controller
        ? 'LP controller is known, but recent LP movement evidence was not confirmed in this scan.'
        : 'LP controller movement could not be assessed because controller and recent LP transfer evidence were not confirmed in this scan.',
      signals,
      evidenceGaps,
      nextActions,
    }
  }

  const controllerTransfers = controller
    ? transfers.filter((transfer) => transfer.from === controller || transfer.to === controller)
    : transfers
  const lastMovementAt = formatMovementTime(
    controllerTransfers.reduce<number | null>((max, transfer) => {
      if (transfer.timestamp == null) return max
      return max == null || transfer.timestamp > max ? transfer.timestamp : max
    }, null),
  )

  if (controllerTransfers.length === 0) {
    signals.push('LP transfer evidence was available, but no controller-side transfer was found')
    return {
      status: 'quiet',
      movementRisk: 'low',
      confidence: 'medium',
      controller,
      controllerType,
      lpTokenOrPool,
      recentMovementDetected: false,
      recentTransferCount: 0,
      lastMovementAt: null,
      movementTypes: [],
      summary: 'LP transfer evidence was available, and no recent controller-side LP movement was confirmed in this scan.',
      signals,
      evidenceGaps,
      nextActions,
    }
  }

  const movementTypes: string[] = []
  let protectedMovement = false
  let watchMovement = false
  let highMovement = false
  for (const transfer of controllerTransfers) {
    pushUnique(movementTypes, 'lp_transfer')
    const outbound = controller && transfer.from === controller
    const target = outbound ? transfer.to : transfer.from
    const method = `${transfer.type ?? ''}`.toLowerCase()
    if (lpTokenOrPool && outbound && transfer.to === lpTokenOrPool) {
      highMovement = true
      pushUnique(movementTypes, 'liquidity_removal_like')
    } else if (/remove|burn|withdraw/i.test(method)) {
      highMovement = true
      pushUnique(movementTypes, 'liquidity_removal_like')
    } else if (outbound && isSafeTarget(chain, target, controllerType)) {
      protectedMovement = true
      pushUnique(movementTypes, 'protected_target')
    } else if (outbound) {
      watchMovement = true
      pushUnique(movementTypes, 'controller_outbound_transfer')
    } else {
      pushUnique(movementTypes, 'controller_inbound_transfer')
    }
  }

  const status: LpMovementWatchStatus = highMovement ? 'high'
    : watchMovement ? 'watch'
    : protectedMovement ? 'protected_movement'
    : 'movement_detected'
  const movementRisk: LpMovementRisk = highMovement ? 'high'
    : watchMovement ? 'watch'
    : protectedMovement ? 'protected'
    : 'watch'
  signals.push(`${controllerTransfers.length} controller-side LP transfer${controllerTransfers.length === 1 ? '' : 's'} found in existing evidence`)
  if (protectedMovement) signals.push('LP movement went to a burn or known protection target')
  if (watchMovement) signals.push('LP movement went to a normal wallet or unknown contract')
  if (highMovement) signals.push('LP movement resembles liquidity removal or withdrawal')

  return {
    status,
    movementRisk,
    confidence: 'medium',
    controller,
    controllerType,
    lpTokenOrPool,
    recentMovementDetected: true,
    recentTransferCount: controllerTransfers.length,
    lastMovementAt,
    movementTypes,
    summary: highMovement
      ? 'Recent LP movement by the controller resembles liquidity removal or withdrawal and should be reviewed.'
      : watchMovement
        ? 'Recent controller-side LP movement was found to a normal wallet or unknown contract; continue monitoring.'
        : protectedMovement
          ? 'Recent controller-side LP movement was found, and the target appears to be a burn or protection destination.'
          : 'Recent controller-side LP movement was found in existing transfer evidence.',
    signals,
    evidenceGaps,
    nextActions,
  }
}

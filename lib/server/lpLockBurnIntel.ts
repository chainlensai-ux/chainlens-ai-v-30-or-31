export type LpLockBurnIntelStatus = 'locked' | 'burned' | 'open_check' | 'not_applicable' | 'no_pool'
export type LpLockBurnProof = 'confirmed' | 'open_check' | 'not_applicable'
export type LpLockBurnChain = 'base' | 'eth' | 'bnb' | string

export interface LpLockBurnIntelInput {
  chain?: LpLockBurnChain | null
  lpControl?: Record<string, unknown> | null
  lpControllerIntel?: Record<string, unknown> | null
  selectedPool?: Record<string, unknown> | null
  lpMeta?: Record<string, unknown> | null
}

export interface LpLockBurnIntel {
  status: LpLockBurnIntelStatus
  lockBurnProof: LpLockBurnProof
  proofSource: string | null
  confidence: string
  chain: string | null
  poolModel: string | null
  lpTokenOrPool: string | null
  lockedPercent: number | null
  burnedPercent: number | null
  unlockedPercent: number | null
  lockContracts: string[]
  burnAddresses: string[]
  unlockTime: string | number | null
  unlockTimeStatus: string
  summary: string
  signals: string[]
  evidenceGaps: string[]
  nextActions: string[]
}

export const LP_LOCK_BURN_REGISTRY = {
  burnAddresses: [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
  ],
  lockersByChain: {
    base: [],
    eth: [
      '0x663a5c229c09b049e36dcca11a9d0d4a0f33f3f9',
      '0x71b5759d73262fbb223956913ecf4ecc51057641',
      '0xe2fe530c047f2d85298b07d9333c05737f1435fb',
      '0xdba68f07d1b7ca219f78ae8582c213d975c25caf',
      '0xf6c7282943dc5ea13461ef77dd3a24e5d01e5e1a',
      '0x0be46842df45f36a19bea0de0fd6e34da00fd8a5',
    ],
    bnb: [],
  } satisfies Record<'base' | 'eth' | 'bnb', string[]>,
} as const

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeAddress(value: unknown): string | null {
  const s = asString(value)?.toLowerCase() ?? null
  return s && /^0x[a-f0-9]{40}$/.test(s) ? s : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/[$,%]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function roundPercent(value: number | null): number | null {
  return value == null ? null : Math.round(value * 100) / 100
}

function evidencePercent(evidence: unknown, keys: string[]): number | null {
  if (!Array.isArray(evidence)) return null
  for (const key of keys) {
    const line = evidence.find((item) => typeof item === 'string' && item.toLowerCase().startsWith(`${key.toLowerCase()}=`))
    if (typeof line === 'string') {
      const pct = asNumber(line.split('=').slice(1).join('='))
      if (pct != null) return pct
    }
  }
  return null
}

function normalizePoolModel(value: string | null): string | null {
  if (!value) return null
  if (value === 'constant_product') return 'erc20_lp_token'
  if (value === 'v2' || value === 'aerodrome') return 'erc20_lp_token'
  if (value === 'v3' || value === 'concentrated' || value === 'concentrated_liquidity') return 'concentrated_liquidity'
  if (value === 'protocol' || value === 'protocol_managed' || value === 'protocol_or_gauge') return 'protocol_pool'
  return value
}

function isNotApplicable(lpControl: Record<string, unknown>, selectedPool: Record<string, unknown>, lpMeta: Record<string, unknown>): boolean {
  const values = [
    asString(lpControl.status),
    asString(lpControl.displayLpModel),
    asString(lpControl.proofApplicability),
    asString(selectedPool.model),
    asString(lpMeta.primaryMarketType),
    asString(lpMeta.displayLpModel),
    asString(lpMeta.lpControlState),
  ].map((v) => v?.toLowerCase())
  return values.some((v) => v === 'not_applicable' || v === 'concentrated_liquidity' || v === 'concentrated' || v === 'v3' || v === 'protocol' || v === 'protocol_managed' || v === 'protocol_or_gauge')
}

export function buildLpLockBurnIntel(input: LpLockBurnIntelInput): LpLockBurnIntel {
  const chain = asString(input.chain)?.toLowerCase() ?? null
  const lpControl = input.lpControl ?? {}
  const lpControllerIntel = input.lpControllerIntel ?? {}
  const selectedPool = input.selectedPool ?? {}
  const lpMeta = input.lpMeta ?? {}
  const registryChain = (chain === 'base' || chain === 'eth' || chain === 'bnb') ? chain : null
  const registryLockers = registryChain ? [...LP_LOCK_BURN_REGISTRY.lockersByChain[registryChain]] : []
  const burnAddresses = [...LP_LOCK_BURN_REGISTRY.burnAddresses]
  const controller = normalizeAddress(lpControl.lpController) ?? normalizeAddress(lpControllerIntel.controller)
  const selectedPoolAddress = normalizeAddress(selectedPool.address)
  const lpTokenOrPool = selectedPoolAddress ?? normalizeAddress(lpControl.verificationPool) ?? normalizeAddress(lpControl.primaryMarketPool) ?? normalizeAddress(lpMeta.lpToken)
  const statusRaw = asString(lpControl.status)?.toLowerCase() ?? null
  const poolModel = normalizePoolModel(asString(lpControl.displayLpModel) ?? asString(selectedPool.model) ?? asString(lpMeta.primaryMarketType))
  const rawUnlockTime = lpControl.lpUnlockTime ?? lpControl.unlockTime ?? null
  const unlockTime = (typeof rawUnlockTime === 'string' || typeof rawUnlockTime === 'number') ? rawUnlockTime : null
  const evidence = lpControl.evidence
  const burnPctEvidence = evidencePercent(evidence, ['burn_share', 'burned_share'])
  const lockPctEvidence = evidencePercent(evidence, ['locker_share', 'locked_share'])
  const lockerRegistryEmpty = registryLockers.length === 0

  if (!lpTokenOrPool && statusRaw === 'no_pool') {
    return {
      status: 'no_pool', lockBurnProof: 'open_check', proofSource: null, confidence: 'low', chain, poolModel,
      lpTokenOrPool: null, lockedPercent: null, burnedPercent: null, unlockedPercent: null,
      lockContracts: registryLockers, burnAddresses, unlockTime: null, unlockTimeStatus: 'not_available',
      summary: 'No active LP token or pool was confirmed for ERC20 lock/burn verification.',
      signals: [], evidenceGaps: ['LP token or pool not confirmed'], nextActions: ['verify active pool', 'rescan after liquidity appears'],
    }
  }

  if (isNotApplicable(lpControl, selectedPool, lpMeta)) {
    return {
      status: 'not_applicable', lockBurnProof: 'not_applicable', proofSource: 'pool_model', confidence: asString(lpControl.confidence) ?? 'medium', chain, poolModel: poolModel ?? 'concentrated_liquidity',
      lpTokenOrPool, lockedPercent: null, burnedPercent: null, unlockedPercent: null,
      lockContracts: [], burnAddresses: [], unlockTime: null, unlockTimeStatus: 'not_applicable',
      summary: 'ERC20 LP lock/burn proof does not apply to concentrated or protocol-managed pools; positions require protocol-specific verification.',
      signals: ['pool model does not expose standard ERC20 LP lock/burn proof'],
      evidenceGaps: ['protocol-specific LP position ownership not verified by ERC20 holder proof'],
      nextActions: ['verify protocol position ownership', 'monitor pool liquidity changes', 'rescan after pool model changes'],
    }
  }

  const confidence = asString(lpControl.confidence) ?? asString(lpControllerIntel.confidence) ?? 'low'
  const lockConfirmed = statusRaw === 'locked' && controller != null && registryLockers.includes(controller) && lockPctEvidence != null && lockPctEvidence >= 50
  const burnConfirmed = statusRaw === 'burned' && burnPctEvidence != null && burnPctEvidence >= 50

  if (burnConfirmed) {
    const burnedPercent = roundPercent(burnPctEvidence)
    const unlockedPercent = burnedPercent == null ? null : roundPercent(Math.max(0, 100 - burnedPercent))
    return {
      status: 'burned', lockBurnProof: 'confirmed', proofSource: 'lp_holder_evidence', confidence, chain, poolModel,
      lpTokenOrPool, lockedPercent: null, burnedPercent, unlockedPercent,
      lockContracts: [], burnAddresses, unlockTime: null, unlockTimeStatus: 'not_applicable',
      summary: 'LP holder evidence confirms dominant LP supply at burn/dead addresses.',
      signals: ['burn/dead address dominance confirmed'], evidenceGaps: [], nextActions: ['monitor LP holder distribution', 'rescan after liquidity changes'],
    }
  }

  if (lockConfirmed) {
    const lockedPercent = roundPercent(lockPctEvidence)
    const unlockedPercent = lockedPercent == null ? null : roundPercent(Math.max(0, 100 - lockedPercent))
    return {
      status: 'locked', lockBurnProof: 'confirmed', proofSource: 'lp_holder_evidence', confidence, chain, poolModel,
      lpTokenOrPool, lockedPercent, burnedPercent: null, unlockedPercent,
      lockContracts: controller ? [controller] : [], burnAddresses, unlockTime, unlockTimeStatus: unlockTime == null ? 'unknown' : 'known',
      summary: 'LP holder/controller evidence confirms dominant LP supply in a verified locker contract.',
      signals: ['verified locker registry match confirmed'], evidenceGaps: unlockTime == null ? ['unlock time not confirmed'] : [], nextActions: ['verify lock terms', 'monitor unlock schedule', 'rescan after liquidity changes'],
    }
  }

  const controllerKnown = Boolean(controller) || statusRaw === 'team_controlled' || asString(lpControllerIntel.controlProof) === 'confirmed'
  const signals = [
    controllerKnown ? 'LP controller is known from existing controller evidence' : null,
    lpTokenOrPool ? 'selected LP token or pool is available for targeted verification' : null,
  ].filter(Boolean) as string[]
  const evidenceGaps = [
    lockerRegistryEmpty ? `no verified ${chain ?? 'chain'} locker registry match` : 'no verified locker match',
    'burn proof not confirmed',
    !lpTokenOrPool ? 'LP token or pool not confirmed' : null,
  ].filter(Boolean) as string[]

  return {
    status: 'open_check', lockBurnProof: 'open_check', proofSource: controllerKnown ? 'controller_evidence' : null, confidence, chain, poolModel,
    lpTokenOrPool, lockedPercent: null, burnedPercent: null, unlockedPercent: null,
    lockContracts: registryLockers, burnAddresses, unlockTime: null, unlockTimeStatus: 'unknown',
    summary: controllerKnown
      ? 'LP controller is known, but active lock/burn proof is not confirmed.'
      : 'Active LP lock/burn proof is not confirmed from current evidence.',
    signals,
    evidenceGaps,
    nextActions: ['verify LP holders', 'verify locker', 'monitor/rescan'],
  }
}

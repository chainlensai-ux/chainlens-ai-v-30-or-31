export type LpUnlockTimelineStatus = 'locked' | 'burned' | 'not_confirmed' | 'open_check' | 'unavailable_with_reason' | 'not_applicable'
export type LpUnlockRisk = 'low' | 'watch' | 'high' | 'expired' | 'unknown' | 'none' | 'not_applicable'
export type LpUnlockTimeStatus = 'known' | 'unknown' | 'not_applicable'

export interface LpUnlockTimelineInput {
  chain?: string | null
  lpLockBurnIntel?: {
    status?: string | null
    lockBurnProof?: string | null
    confidence?: string | null
    chain?: string | null
    lpTokenOrPool?: string | null
    unlockTime?: string | number | null
    unlockTimeStatus?: string | null
  } | null
}

export interface LpUnlockTimeline {
  status: LpUnlockTimelineStatus
  unlockRisk: LpUnlockRisk
  confidence: string
  chain: string | null
  lpTokenOrPool: string | null
  unlockTime: string | number | null
  unlockTimeStatus: LpUnlockTimeStatus
  unlockCountdownSeconds: number | null
  unlockCountdownLabel: string | null
  lockState: string | null
  summary: string
  signals: string[]
  evidenceGaps: string[]
  nextActions: string[]
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// LP lock contracts report unlock times as either an ISO date string or a unix
// timestamp; timestamps below 1e12 are assumed to be seconds, not milliseconds.
function parseUnlockTimeMs(value: string | number): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value < 1e12 ? value * 1000 : value
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatCountdownLabel(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  if (days > 0) return `${days}d ${hours}h`
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  return `${hours}h ${minutes}m`
}

export function buildLpUnlockTimeline(input: LpUnlockTimelineInput): LpUnlockTimeline {
  const intel = input.lpLockBurnIntel ?? {}
  const chain = asString(input.chain) ?? asString(intel.chain) ?? null
  const lpTokenOrPool = asString(intel.lpTokenOrPool)
  const confidence = asString(intel.confidence) ?? 'low'
  const lockBurnProof = asString(intel.lockBurnProof)?.toLowerCase() ?? null
  const lockState = asString(intel.status)?.toLowerCase() ?? null
  const unlockTimeRaw = (typeof intel.unlockTime === 'string' || typeof intel.unlockTime === 'number') ? intel.unlockTime : null

  if (lockBurnProof === 'not_applicable') {
    return {
      status: 'not_applicable', unlockRisk: 'not_applicable', confidence, chain, lpTokenOrPool,
      unlockTime: null, unlockTimeStatus: 'not_applicable', unlockCountdownSeconds: null, unlockCountdownLabel: null,
      lockState,
      summary: 'ERC20 LP unlock timeline does not apply to concentrated or protocol-managed pools.',
      signals: ['pool model does not expose a standard ERC20 LP unlock timeline'],
      evidenceGaps: ['protocol-specific LP position unlock terms not verified'],
      nextActions: ['verify protocol position terms', 'monitor pool liquidity changes'],
    }
  }

  if (lockState === 'burned') {
    return {
      status: 'burned', unlockRisk: 'none', confidence, chain, lpTokenOrPool,
      unlockTime: null, unlockTimeStatus: 'not_applicable', unlockCountdownSeconds: null, unlockCountdownLabel: null,
      lockState,
      summary: 'LP supply is held at burn/dead addresses, so there is no unlock event to track.',
      signals: ['burned LP has no unlock schedule'],
      evidenceGaps: [],
      nextActions: ['monitor LP holder distribution', 'rescan after liquidity changes'],
    }
  }

  const unlockMs = unlockTimeRaw != null ? parseUnlockTimeMs(unlockTimeRaw) : null

  if (lockBurnProof !== 'confirmed' || unlockMs == null) {
    const unresolvedStatus: LpUnlockTimelineStatus = lockBurnProof === 'not_confirmed'
      ? 'not_confirmed'
      : lockBurnProof === 'unavailable_with_reason'
        ? 'unavailable_with_reason'
        : 'open_check'
    return {
      status: unresolvedStatus, unlockRisk: 'unknown', confidence, chain, lpTokenOrPool,
      unlockTime: null, unlockTimeStatus: 'unknown', unlockCountdownSeconds: null, unlockCountdownLabel: null,
      lockState: lockBurnProof === 'not_confirmed' ? 'not_confirmed' : lockState,
      summary: lockBurnProof === 'confirmed'
        ? 'LP lock is confirmed, but no confirmed LP unlock time is available for this LP.'
        : lockBurnProof === 'not_confirmed'
          ? 'LP lock/burn proof was checked and is not confirmed, so no verified LP unlock timeline is available.'
          : lockBurnProof === 'unavailable_with_reason'
            ? 'LP lock/burn proof could not be checked from current RPC evidence, so no verified LP unlock timeline is available.'
            : 'No confirmed LP unlock time is available because the LP lock/burn proof is unresolved.',
      signals: lockBurnProof === 'not_confirmed' ? ['LP lock proof not confirmed'] : [],
      evidenceGaps: ['confirmed LP unlock time not available'],
      nextActions: ['verify lock terms', 'monitor unlock schedule', 'rescan after liquidity changes'],
    }
  }

  const diffSeconds = (unlockMs - Date.now()) / 1000
  const thirtyDays = 30 * 86400
  const sevenDays = 7 * 86400

  if (diffSeconds <= 0) {
    return {
      status: 'locked', unlockRisk: 'expired', confidence, chain, lpTokenOrPool,
      unlockTime: unlockTimeRaw, unlockTimeStatus: 'known', unlockCountdownSeconds: 0, unlockCountdownLabel: formatCountdownLabel(0),
      lockState,
      summary: 'The confirmed LP lock has reached its unlock time and may already be unlocked.',
      signals: ['LP lock unlock time has passed'],
      evidenceGaps: ['post-unlock LP holder movement not confirmed'],
      nextActions: ['verify LP holders after unlock', 'monitor LP movement', 'rescan after liquidity changes'],
    }
  }

  const unlockRisk: LpUnlockRisk = diffSeconds > thirtyDays ? 'low' : diffSeconds >= sevenDays ? 'watch' : 'high'
  const summary = unlockRisk === 'low'
    ? 'The confirmed LP lock unlocks more than 30 days from now.'
    : unlockRisk === 'watch'
      ? 'The confirmed LP lock unlocks within the next 7-30 days.'
      : 'The confirmed LP lock unlocks within the next 7 days.'

  return {
    status: 'locked', unlockRisk, confidence, chain, lpTokenOrPool,
    unlockTime: unlockTimeRaw, unlockTimeStatus: 'known', unlockCountdownSeconds: Math.round(diffSeconds), unlockCountdownLabel: formatCountdownLabel(diffSeconds),
    lockState,
    summary,
    signals: ['confirmed LP unlock time available'],
    evidenceGaps: [],
    nextActions: unlockRisk === 'high'
      ? ['monitor LP holders closely ahead of unlock', 'verify lock terms', 'rescan after liquidity changes']
      : ['monitor unlock schedule', 'rescan after liquidity changes'],
  }
}

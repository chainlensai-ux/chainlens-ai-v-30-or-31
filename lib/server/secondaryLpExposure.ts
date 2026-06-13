export type SecondaryLpExposureStatus =
  | 'wallet_controlled'
  | 'locked'
  | 'burned'
  | 'watch'
  | 'open_check'

export type SecondaryLpExposureLockBurnProof = 'confirmed' | 'open_check'

export interface SecondaryLpControlSignals {
  status?: string | null
  confidence?: string | null
  poolAddress?: string | null
  poolDex?: string | null
  poolType?: string | null
  pair?: string | null
  reason?: string | null
  evidence?: string[] | null
}

export interface SecondaryLpExposureInput {
  secondarySignals?: SecondaryLpControlSignals | null
  primaryDex?: string | null
  primaryPair?: string | null
  primaryPoolModel?: string | null
}

export interface SecondaryLpExposure {
  status: SecondaryLpExposureStatus
  poolAddress: string
  poolDex: string | null
  poolType: string | null
  pair: string | null
  controller: string | null
  controllerType: string
  controllerSharePercent: number | null
  lockBurnProof: SecondaryLpExposureLockBurnProof
  confidence: string
  summary: string
  signals: string[]
  evidenceGaps: string[]
  nextActions: string[]
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function extractSharePercent(evidence: string[]): number | null {
  for (const key of ['top_share', 'owner_lp_share', 'locker_share', 'burn_share']) {
    const line = evidence.find((item) => item.toLowerCase().startsWith(`${key}=`))
    if (line) {
      const value = Number(line.split('=').slice(1).join('=').replace('%', ''))
      if (Number.isFinite(value)) return Math.round(value * 100) / 100
    }
  }
  return null
}

function mapStatus(status: string | null, sharePercent: number | null): SecondaryLpExposureStatus {
  if (status === 'burned') return 'burned'
  if (status === 'locked') return 'locked'
  if (status === 'team_controlled') return 'wallet_controlled'
  if (sharePercent != null && sharePercent >= 50) return 'watch'
  return 'open_check'
}

// Builds a SEPARATE, secondary signal for a V2/ERC-20 LP pool that exists alongside a
// concentrated/protocol-managed PRIMARY pool. This must never be merged into or override
// lpControllerIntel/lpLockBurnIntel/lpMovementWatch/lpUnlockTimeline, which describe the
// primary pool model only — secondary exposure is reported here, independently.
export function buildSecondaryLpExposure(input: SecondaryLpExposureInput): SecondaryLpExposure | null {
  const secondary = input.secondarySignals
  const poolAddress = asString(secondary?.poolAddress)
  if (!secondary || !poolAddress) return null

  const evidence = Array.isArray(secondary.evidence) ? secondary.evidence : []
  const statusRaw = asString(secondary.status)
  const sharePercent = extractSharePercent(evidence)
  const status = mapStatus(statusRaw, sharePercent)

  // Mirrors resolveLpControllerIdentity() in lpControllerIntel.ts for this secondary
  // pool's own evidence — a dominant top_holder/owner_lp_share here is a wallet controller.
  const controllerType = statusRaw === 'team_controlled' ? 'wallet'
    : statusRaw === 'burned' ? 'burn'
    : statusRaw === 'locked' ? 'lockContract'
    : (sharePercent != null && sharePercent >= 50) ? 'wallet'
    : 'unknown'
  const controller = controllerType === 'wallet'
    ? (() => {
        const topHolderEv = evidence.find((e) => e.startsWith('top_holder='))
        const addr = topHolderEv?.split('=')[1]?.toLowerCase()
        return addr && /^0x[a-f0-9]{40}$/.test(addr) ? addr : null
      })()
    : null

  const lockBurnProof: SecondaryLpExposureLockBurnProof = (status === 'locked' || status === 'burned') ? 'confirmed' : 'open_check'
  const confidence = asString(secondary.confidence) ?? 'low'

  const primaryDexLabel = asString(input.primaryDex)
  const primaryModelLabel = input.primaryPoolModel === 'concentrated' ? 'concentrated liquidity'
    : input.primaryPoolModel === 'protocol_or_gauge' ? 'protocol-managed liquidity'
    : 'concentrated liquidity'

  const signals: string[] = ['secondary LP pool detected separate from the primary pool']
  if (status === 'wallet_controlled' || status === 'watch') signals.push('secondary LP pool appears wallet-controlled')
  if (status === 'locked') signals.push('secondary LP pool shows lock evidence')
  if (status === 'burned') signals.push('secondary LP pool shows burn evidence')
  if (sharePercent != null && sharePercent >= 50) signals.push('a single holder controls a dominant share of the secondary LP')

  const evidenceGaps: string[] = ['standard ERC-20 LP lock/burn proof for this secondary pool is not part of the primary pool assessment']
  if (lockBurnProof === 'open_check') evidenceGaps.push('secondary LP lock/burn proof not confirmed')

  const nextActions = ['monitor the secondary LP pool separately from the primary pool', 'rescan after liquidity changes']

  const sharePhrase = sharePercent != null ? ` (about ${sharePercent}% of this secondary pool's LP supply)` : ''
  const summary = `Primary liquidity uses ${primaryDexLabel ? `${primaryDexLabel} ` : ''}${primaryModelLabel}${input.primaryPair ? ` (${input.primaryPair})` : ''}. A secondary ERC-20 LP pool also exists${sharePhrase} and appears ${status === 'burned' ? 'burned' : status === 'locked' ? 'locked' : 'wallet-controlled'}; this is secondary LP exposure, not primary liquidity, and should be monitored separately.`

  return {
    status,
    poolAddress,
    poolDex: asString(secondary.poolDex),
    poolType: asString(secondary.poolType),
    pair: asString(secondary.pair),
    controller,
    controllerType,
    controllerSharePercent: sharePercent,
    lockBurnProof,
    confidence,
    summary,
    signals,
    evidenceGaps,
    nextActions,
  }
}

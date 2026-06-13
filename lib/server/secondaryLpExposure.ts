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

function mapStatus(status: string | null, sharePercent: number | null, controller: string | null): SecondaryLpExposureStatus {
  if (status === 'burned') return 'burned'
  if (status === 'locked') return 'locked'
  if (controller && (status === 'team_controlled' || (sharePercent != null && sharePercent >= 80))) return 'wallet_controlled'
  if (controller && sharePercent != null && sharePercent >= 50) return 'watch'
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

  // Mirrors resolveLpControllerIdentity() in lpControllerIntel.ts for this secondary
  // pool's own evidence — a dominant top_holder/owner_lp_share here is a wallet controller.
  // Do not infer wallet control from a percentage alone: without a holder address, the
  // secondary exposure remains an open check and public copy must not say it appears
  // wallet-controlled.
  const evidenceController = (() => {
    const topHolderEv = evidence.find((e) => e.toLowerCase().startsWith('top_holder='))
    const addr = topHolderEv?.split('=').slice(1).join('=').trim().toLowerCase()
    return addr && /^0x[a-f0-9]{40}$/.test(addr) ? addr : null
  })()
  const status = mapStatus(statusRaw, sharePercent, evidenceController)
  const controllerType = statusRaw === 'burned' ? 'burn'
    : statusRaw === 'locked' ? 'lockContract'
    : (status === 'wallet_controlled' || status === 'watch') ? 'wallet'
    : 'unknown'
  const controller = controllerType === 'wallet' ? evidenceController : null

  const lockBurnProof: SecondaryLpExposureLockBurnProof = (status === 'locked' || status === 'burned') ? 'confirmed' : 'open_check'
  const confidence = asString(secondary.confidence) ?? 'low'

  const primaryDexLabel = asString(input.primaryDex)
  const primaryPairLabel = asString(input.primaryPair)
  const secondaryPairLabel = asString(secondary.pair)
  const isConcentratedPrimary = input.primaryPoolModel === 'concentrated'

  const signals: string[] = ['secondary LP pool detected separate from the primary pool']
  if (status === 'wallet_controlled' || status === 'watch') signals.push('secondary LP pool appears wallet-controlled')
  if (status === 'locked') signals.push('secondary LP pool shows lock evidence')
  if (status === 'burned') signals.push('secondary LP pool shows burn evidence')
  if (sharePercent != null && sharePercent >= 50) signals.push('a single holder controls a dominant share of the secondary LP')

  const evidenceGaps: string[] = ['standard ERC-20 LP lock/burn proof for this secondary pool is not part of the primary pool assessment']
  if (lockBurnProof === 'open_check') evidenceGaps.push('secondary LP lock/burn proof not confirmed')

  const nextActions = ['monitor the secondary LP pool separately from the primary pool', 'rescan after liquidity changes']

  const sharePhrase = sharePercent != null ? ` (about ${sharePercent}% of this secondary pool's LP supply)` : ''
  // Only say "appears wallet-controlled"/"burned"/"locked" when the status reflects confirmed
  // or dominant-holder evidence; an open_check secondary pool must not claim wallet control.
  const statusPhrase = status === 'burned' ? 'appears burned'
    : status === 'locked' ? 'appears locked'
    : status === 'wallet_controlled' ? 'appears wallet-controlled'
    : status === 'watch' ? 'shows a dominant LP holder approaching wallet control'
    : 'has control proof that is an open check (not confirmed wallet-controlled)'
  const lockBurnSentence = lockBurnProof === 'open_check'
    ? ' Lock/burn proof remains open until confirmed from LP holder evidence.'
    : ''
  const secondaryPairPhrase = secondaryPairLabel ? ` (${secondaryPairLabel})` : (sharePhrase || '')
  const summary = isConcentratedPrimary
    ? `Secondary ERC-20 LP exposure detected. Primary liquidity uses ${primaryDexLabel ? `${primaryDexLabel} ` : ''}concentrated liquidity${primaryPairLabel ? ` (${primaryPairLabel})` : ''}. A secondary ERC-20 LP pool also exists${secondaryPairPhrase} and ${statusPhrase}; this is secondary LP exposure, not primary liquidity, and should be monitored separately.${lockBurnSentence}`
    : `Secondary ERC-20 LP exposure detected. Primary liquidity uses the selected${primaryPairLabel ? ` ${primaryPairLabel}` : ''}${primaryDexLabel ? ` ${primaryDexLabel}` : ''} LP pool. A secondary ERC-20 LP pool also exists${secondaryPairPhrase} and ${statusPhrase}; this is secondary LP exposure, not a replacement for the primary LP verdict.${lockBurnSentence}`

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

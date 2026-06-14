// Structured "Evidence Gap" entries for Base Radar — replaces lazy duplicate
// "is an open check" strings with facts-first entries that say what was
// checked, what was found, and (only when nothing was found) why.

import type { RadarValuationBasis } from './baseRadarValuation'

export type RadarEvidenceStatus = 'verified' | 'checked_not_found' | 'risk_fact' | 'open_check'

export interface RadarEvidenceEntry {
  status: RadarEvidenceStatus
  label: string
  known: string[]
  missing?: string[]
  reason?: string
  nextAction?: string
}

function shortenAddress(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

/**
 * Item 1 — valuation. Returns null when a verified market cap is available
 * (no gap to report). FDV fallback is a single "checked, not found" item,
 * never a duplicate of a separate "FDV-only" open check.
 */
export function getRadarValuationEvidence(valuation: { basis: RadarValuationBasis }): RadarEvidenceEntry | null {
  if (valuation.basis === 'verified_market_cap') return null
  if (valuation.basis === 'fdv_fallback') {
    return {
      status: 'checked_not_found',
      label: 'Verified market cap not returned; FDV is shown as fallback valuation.',
      known: ['FDV available'],
      missing: ['verified market cap'],
    }
  }
  return {
    status: 'open_check',
    label: 'Market valuation open check — no verified market cap or valid FDV available.',
    known: [],
    missing: ['market cap', 'FDV'],
    reason: 'No verified market cap or valid FDV available.',
    nextAction: 'Re-check market data once liquidity/pricing evidence is available.',
  }
}

export interface RadarSimulationEvidenceInput {
  status?: 'passed' | 'open_check' | null
  reason?: string | null
}

/**
 * Simulation evidence. Returns null when the simulation passed (no gap to
 * report). Otherwise surfaces the specific reason simulation did not
 * complete plus the resulting tax/honeypot uncertainty — never a lazy
 * "remains open check" string.
 */
export function getRadarSimulationEvidence(input: RadarSimulationEvidenceInput): RadarEvidenceEntry | null {
  if (input.status === 'passed') return null
  const reason = input.reason ?? 'insufficient route/pool evidence'
  const reasonLabel = reason === 'timeout'
    ? 'Buy/sell simulation timed out'
    : reason === 'missing pair address'
    ? 'Buy/sell simulation could not run — missing pair address'
    : reason === 'unsupported pool model'
    ? 'Buy/sell simulation could not run — unsupported pool model'
    : 'Buy/sell simulation could not run — insufficient route/pool evidence'
  return {
    status: 'open_check',
    label: `${reasonLabel}, so tax and honeypot status are not confirmed.`,
    known: [],
    missing: ['buy/sell tax', 'honeypot status'],
    reason,
  }
}

export interface RadarAgeEvidenceInput {
  ageMinutes?: number | null
}

const VERY_NEW_MAX_AGE_MINUTES = 15

/**
 * Age evidence. A token under 15 minutes old is a verified risk fact (very
 * new), not an open check. Returns null when the token is older than the
 * very-new threshold or age is unknown.
 */
export function getRadarAgeEvidence(input: RadarAgeEvidenceInput): RadarEvidenceEntry | null {
  const ageMinutes = input.ageMinutes
  if (typeof ageMinutes !== 'number' || !Number.isFinite(ageMinutes) || ageMinutes < 0) return null
  if (ageMinutes >= VERY_NEW_MAX_AGE_MINUTES) return null
  return {
    status: 'risk_fact',
    label: `Token is very new — pool age is ${Math.floor(ageMinutes)} minute${Math.floor(ageMinutes) === 1 ? '' : 's'} (under ${VERY_NEW_MAX_AGE_MINUTES}m).`,
    known: [`ageMinutes=${Math.floor(ageMinutes)}`],
  }
}

export interface RadarLpPositionEvidenceInput {
  isConcentrated: boolean
  poolId?: string | null
  dex?: string | null
  liquidityUsd?: number | null
  fmtUSD: (value: number) => string
}

/**
 * LP position evidence for concentrated-liquidity pools. Surfaces the pool
 * ID/dex/liquidity facts alongside "Position verification required" rather
 * than a generic open check, since standard ERC-20 LP lock/burn proof does
 * not apply to this pool model.
 */
export function getRadarLpPositionEvidence(input: RadarLpPositionEvidenceInput): RadarEvidenceEntry | null {
  if (!input.isConcentrated) return null
  const known: string[] = []
  if (input.poolId) known.push(`pool=${input.poolId}`)
  if (input.dex) known.push(`dex=${input.dex}`)
  if (typeof input.liquidityUsd === 'number' && Number.isFinite(input.liquidityUsd)) {
    known.push(`liquidity=${input.fmtUSD(input.liquidityUsd)}`)
  }
  const facts = [
    input.dex ? `dex ${input.dex}` : null,
    input.poolId ? `pool ${shortenAddress(input.poolId)}` : null,
    typeof input.liquidityUsd === 'number' && Number.isFinite(input.liquidityUsd) ? `liquidity ${input.fmtUSD(input.liquidityUsd)}` : null,
  ].filter((part): part is string => Boolean(part))
  return {
    status: 'open_check',
    label: `Position verification required${facts.length ? ` — ${facts.join(', ')}` : ''}.`,
    known,
    reason: 'concentrated-liquidity position ownership/range has not been independently verified',
  }
}

export interface RadarSocialsEvidenceInput {
  website?: string | null
  twitter?: string | null
  telegram?: string | null
  status?: string | null
  reason?: string | null
}

/**
 * Item 2 — socials. Attempts to surface real links from already-fetched
 * project/pair metadata before falling back to "checked, none found" or
 * "open check — <reason>".
 */
export function getRadarSocialsEvidence(input: RadarSocialsEvidenceInput): RadarEvidenceEntry {
  const links: string[] = []
  if (input.website) links.push(`Website: ${input.website}`)
  if (input.twitter) links.push(`Twitter: ${input.twitter}`)
  if (input.telegram) links.push(`Telegram: ${input.telegram}`)

  if (links.length > 0) {
    return {
      status: 'verified',
      label: `Social links found — ${links.join(', ')}.`,
      known: links,
    }
  }

  if (input.status === 'unavailable_with_reason' || input.status === 'partial') {
    return {
      status: 'checked_not_found',
      label: 'Social links checked — none found in current token/pair metadata.',
      known: [],
      missing: ['website', 'twitter', 'telegram'],
    }
  }

  return {
    status: 'open_check',
    label: `Social links open check — ${input.reason ?? 'social metadata was not collected for this scan'}.`,
    known: [],
    reason: input.reason ?? 'social metadata was not collected for this scan',
  }
}

export interface RadarOwnershipEvidenceInput {
  ownerAddress?: string | null
  adminAddress?: string | null
  isRenounced?: boolean | null
  ownershipVerified?: boolean | null
  ownershipStatus?: string | null
}

/**
 * Item 3 — ownership. Active (non-renounced) ownership is a verified risk
 * fact, not an open check — returns null for renounced/open-check states so
 * callers don't add a redundant evidence-gap entry for those.
 */
export function getRadarOwnershipEvidence(devOwnership: RadarOwnershipEvidenceInput | null | undefined): RadarEvidenceEntry | null {
  if (!devOwnership || devOwnership.ownershipStatus !== 'active_owner') return null
  const addr = devOwnership.ownerAddress ?? devOwnership.adminAddress ?? null
  return {
    status: 'risk_fact',
    label: `Ownership/admin is active${addr ? `: ${shortenAddress(addr)}` : ''}.`,
    known: [
      `ownershipVerified=${devOwnership.ownershipVerified === true}`,
      'renounced=false',
      ...(addr ? [`owner/admin=${addr}`] : []),
    ],
  }
}

export interface RadarPastLaunchesInput {
  deployerAddress?: string | null
  pastLaunches?: {
    status?: string | null
    count?: number | null
    sample?: string[] | null
    reason?: string | null
  } | null
}

/**
 * Item 4 — deployer past launches. Attempts the check from already-computed
 * deployer/cluster evidence when a deployer address is known.
 */
export function getRadarPastLaunchesEvidence(input: RadarPastLaunchesInput): RadarEvidenceEntry {
  if (!input.deployerAddress) {
    return {
      status: 'open_check',
      label: 'Past launches open check — deployer identity is not resolved.',
      known: [],
      reason: 'deployer identity is an open check',
      nextAction: 'Resolve the deployer/origin wallet to enable a past-launch lookup.',
    }
  }
  const pl = input.pastLaunches
  if (!pl || pl.status === 'open_check') {
    const reason = pl?.reason ?? 'past-launch history could not be retrieved from current evidence'
    return {
      status: 'open_check',
      label: `Past launches open check — ${reason}.`,
      known: [`deployer=${input.deployerAddress}`],
      reason,
    }
  }
  if (pl.count != null && pl.count > 0) {
    return {
      status: 'verified',
      label: `Past launches checked — ${pl.count} linked wallet${pl.count === 1 ? '' : 's'}/contract${pl.count === 1 ? '' : 's'} found in current evidence.`,
      known: [`deployer=${input.deployerAddress}`, ...(pl.sample ?? []).map((s) => `linked=${s}`)],
    }
  }
  return {
    status: 'checked_not_found',
    label: 'Past launches checked — none found in current evidence.',
    known: [`deployer=${input.deployerAddress}`],
  }
}

export interface RadarRugHistoryInput {
  deployerAddress?: string | null
  rugHistory?: {
    verified?: boolean | null
    count?: number | null
    reason?: string | null
  } | null
}

/**
 * Item 5 — rug history. Attempts the check from already-computed
 * deployer/cluster evidence when a deployer address is known.
 */
export function getRadarRugHistoryEvidence(input: RadarRugHistoryInput): RadarEvidenceEntry {
  if (!input.deployerAddress) {
    return {
      status: 'open_check',
      label: 'Rug history open check — deployer identity is not resolved.',
      known: [],
      reason: 'deployer identity is an open check',
      nextAction: 'Resolve the deployer/origin wallet to enable a rug-history cross-reference.',
    }
  }
  const rh = input.rugHistory
  if (!rh || rh.verified == null) {
    const reason = rh?.reason ?? 'rug-history cross-reference could not be completed from current evidence'
    return {
      status: 'open_check',
      label: `Rug history open check — ${reason}.`,
      known: [`deployer=${input.deployerAddress}`],
      reason,
    }
  }
  if (rh.verified === true) {
    return {
      status: 'risk_fact',
      label: `Rug history flagged — ${rh.count != null ? rh.count : 'a'} linked wallet/cluster pattern${rh.count === 1 ? '' : 's'} found in current evidence.`,
      known: [`deployer=${input.deployerAddress}`, 'rugHistoryVerified=true'],
    }
  }
  return {
    status: 'checked_not_found',
    label: 'Rug history checked — no confirmed prior rug pattern found in current evidence.',
    known: [`deployer=${input.deployerAddress}`, 'rugHistoryVerified=false'],
  }
}

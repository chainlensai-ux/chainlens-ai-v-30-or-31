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

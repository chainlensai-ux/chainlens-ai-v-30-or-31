// lib/radarTrackEvidence.ts — the Base Radar evidence a Track receipt freezes (Radar → Track).
//
// Track only stores server-signed evidence (see lib/server/tokenOutcomeReceipt.ts). Radar evidence is
// therefore built and HMAC-signed by /api/radar for the signed-in user, sent back verbatim on Track, and
// verified by /api/token-outcomes. This module is the pure, isomorphic half: which fields are frozen and
// their canonical byte order for the signature.
//
// SCORE SEMANTICS: the Radar score is higher-is-STRONGER (an opportunity/evidence score), the opposite
// direction of Token Scanner's higher-is-riskier Risk Score. It is frozen as radar evidence and never as
// a Track risk score.

import { validPriceOrNull, numberOrNull } from './tokenOutcomes'
import { buildRadarFeedDisplayModel, getRadarMomentum, resolveRadarCardStatus } from './baseRadarFeedStatus'

export type RadarTrackChain = 'base' | 'robinhood'
/** A signed receipt is honoured for 30 minutes; Radar refreshes every 2 minutes while visible. */
export const RADAR_TRACK_RECEIPT_MAX_AGE_MS = 30 * 60_000
/** Never freeze market values older than this as a "click-time" baseline. */
export const RADAR_TRACK_EVIDENCE_MAX_AGE_MS = 60 * 60_000
const MAX_EVIDENCE_GAPS = 12

export type RadarTrackEvidence = {
  v: 1
  source: 'base_radar'
  chain: RadarTrackChain
  tokenAddress: string
  name: string
  symbol: string
  priceUsd: number | null
  /** Provider market cap only when Radar marked it verified. Never FDV. */
  marketCapUsd: number | null
  marketCapStatus: 'verified' | 'unavailable'
  fdvUsd: number | null
  valuationBasis: string
  liquidityUsd: number | null
  volume24hUsd: number | null
  ageMinutes: number | null
  pairCreatedAt: string | null
  radarScore: number
  radarScoreDirection: 'higher_is_stronger'
  radarLabel: string
  radarStatus: string
  riskLevel: string | null
  simulationStatus: string
  holderVerified: boolean | null
  evidenceGaps: string[]
  radarFetchedAt: string
}

export type RadarTrackReceipt = { v: 1; signedAt: string; evidence: RadarTrackEvidence; sig: string }

export function radarTrackScanId(chain: RadarTrackChain, tokenAddress: string): string {
  return `base_radar:${chain}:${tokenAddress.toLowerCase()}`
}
/** Client/server key for "is this chain + token already tracked". EVM only (Radar chains are EVM). */
export function trackedTokenKey(chain: string, tokenAddress: string): string {
  return `${chain}:${chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase()}`
}

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Build the frozen evidence from one /api/radar token exactly as the card scores and labels it. */
export function buildRadarTrackEvidence(token: Record<string, unknown>, chain: string, fetchedAt: string): RadarTrackEvidence | null {
  if (chain !== 'base' && chain !== 'robinhood') return null
  const address = str(token.contract ?? token.tokenAddress, 64)
  if (!/^0x[\da-fA-F]{40}$/.test(address)) return null
  const fetchedMs = Date.parse(fetchedAt)
  if (!Number.isFinite(fetchedMs)) return null
  const liquidityUsd = numberOrNull(token.liquidityUsd)
  const volume24hUsd = numberOrNull(token.volume24h)
  const feedToken = { ...token, liquidityUsd: liquidityUsd ?? 0, volume24h: volume24hUsd ?? 0, ageMinutes: numberOrNull(token.ageMinutes) ?? 0 } as Parameters<typeof buildRadarFeedDisplayModel>[0]
  let displayModel: ReturnType<typeof buildRadarFeedDisplayModel>
  try { displayModel = buildRadarFeedDisplayModel(feedToken) } catch { return null }
  const momentum = getRadarMomentum(feedToken.volume24h, feedToken.liquidityUsd).level
  const marketCapVerified = token.marketCapStatus === 'verified'
  return {
    v: 1,
    source: 'base_radar',
    chain,
    tokenAddress: address.toLowerCase(),
    name: str(token.name),
    symbol: str(token.symbol, 40),
    priceUsd: validPriceOrNull(token.priceUsd),
    marketCapUsd: marketCapVerified ? validPriceOrNull(token.marketCapUsd) : null,
    marketCapStatus: marketCapVerified ? 'verified' : 'unavailable',
    fdvUsd: validPriceOrNull(token.fdvUsd),
    valuationBasis: str(token.valuationBasis, 40) || 'unavailable',
    liquidityUsd,
    volume24hUsd,
    ageMinutes: numberOrNull(token.ageMinutes),
    pairCreatedAt: typeof token.pairCreatedAt === 'string' ? token.pairCreatedAt.slice(0, 40) : null,
    radarScore: displayModel.score,
    radarScoreDirection: 'higher_is_stronger',
    radarLabel: String(displayModel.riskLabel),
    radarStatus: resolveRadarCardStatus(feedToken, displayModel, momentum),
    riskLevel: typeof token.riskLevel === 'string' ? token.riskLevel.slice(0, 20) : null,
    simulationStatus: str(token.simulationStatus, 20) || 'open_check',
    holderVerified: typeof token.holderVerified === 'boolean' ? token.holderVerified : null,
    evidenceGaps: Array.isArray(token.evidenceGaps) ? token.evidenceGaps.filter((g): g is string => typeof g === 'string').slice(0, MAX_EVIDENCE_GAPS).map(g => g.slice(0, 160)) : [],
    radarFetchedAt: new Date(fetchedMs).toISOString(),
  }
}

/** Fixed field order → the exact bytes that are signed. Unknown keys never enter the signature. */
export function canonicalRadarTrackEvidence(e: RadarTrackEvidence): string {
  return JSON.stringify([
    e.v, e.source, e.chain, e.tokenAddress, e.name, e.symbol, e.priceUsd, e.marketCapUsd, e.marketCapStatus,
    e.fdvUsd, e.valuationBasis, e.liquidityUsd, e.volume24hUsd, e.ageMinutes, e.pairCreatedAt, e.radarScore,
    e.radarScoreDirection, e.radarLabel, e.radarStatus, e.riskLevel, e.simulationStatus, e.holderVerified,
    e.evidenceGaps, e.radarFetchedAt,
  ])
}

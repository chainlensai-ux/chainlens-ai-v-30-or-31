// lib/server/radarTrackReceipt.ts — sign and verify Base Radar → Track receipts. Server-only.
//
// /api/radar signs each token's frozen evidence for the signed-in user (never stored in the shared Radar
// payload cache, exactly like Token Scanner's outcome receipts). Track sends the receipt back verbatim;
// this verifies the HMAC, the user, the age and the identity, then builds the canonical Track snapshot.
// No provider call happens on either side.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { outcomeSigningSecret } from './tokenOutcomeReceipt'
import { freezeableBaselinePriceUsd, type ScanSnapshot } from '../tokenOutcomes'
import {
  RADAR_TRACK_EVIDENCE_MAX_AGE_MS, RADAR_TRACK_RECEIPT_MAX_AGE_MS, buildRadarTrackEvidence, canonicalRadarTrackEvidence,
  radarTrackScanId, type RadarTrackEvidence, type RadarTrackReceipt,
} from '../radarTrackEvidence'

const MAX_CLOCK_SKEW_MS = 60_000

function mac(key: string, userId: string, signedAt: string, evidence: RadarTrackEvidence): Buffer {
  return createHmac('sha256', key).update(`radar-track:v1|${userId}|${signedAt}|${canonicalRadarTrackEvidence(evidence)}`).digest()
}

export function signRadarTrackEvidence(evidence: RadarTrackEvidence, userId: string, now = Date.now()): RadarTrackReceipt | null {
  const key = outcomeSigningSecret()
  if (!key || !userId) return null
  const signedAt = new Date(now).toISOString()
  return { v: 1, signedAt, evidence, sig: mac(key, userId, signedAt, evidence).toString('base64url') }
}

/**
 * Per-user receipts on a Radar response. Never throws and never blocks the feed: when signing is not
 * configured or a token cannot be represented, that token simply carries `trackReceipt: null`.
 */
export function attachRadarTrackReceipts<T extends { tokens?: unknown; fetchedAt?: unknown }>(payload: T, userId: string | null, chain: string, now = Date.now()): T {
  if (!userId || !Array.isArray(payload.tokens) || !outcomeSigningSecret()) return payload
  const fetchedAt = typeof payload.fetchedAt === 'string' ? payload.fetchedAt : new Date(now).toISOString()
  try {
    return {
      ...payload,
      tokens: payload.tokens.map(token => {
        if (!token || typeof token !== 'object') return token
        const evidence = buildRadarTrackEvidence(token as Record<string, unknown>, chain, fetchedAt)
        return { ...token, trackReceipt: evidence ? signRadarTrackEvidence(evidence, userId, now) : null }
      }),
    }
  } catch {
    return payload
  }
}

export type RadarTrackVerifyResult =
  | { ok: true; snapshot: ScanSnapshot; evidence: RadarTrackEvidence }
  | { ok: false; code: 'invalid' | 'expired' | 'unconfigured'; error: string }

const fail = (code: 'invalid' | 'expired' | 'unconfigured', error: string): RadarTrackVerifyResult => ({ ok: false, code, error })
const finiteOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v))

function evidenceShapeOk(e: RadarTrackEvidence): boolean {
  return e.v === 1 && e.source === 'base_radar' && (e.chain === 'base' || e.chain === 'robinhood')
    && /^0x[\da-f]{40}$/.test(e.tokenAddress)
    && typeof e.name === 'string' && typeof e.symbol === 'string'
    && [e.priceUsd, e.marketCapUsd, e.fdvUsd, e.liquidityUsd, e.volume24hUsd, e.ageMinutes].every(finiteOrNull)
    && typeof e.radarScore === 'number' && Number.isFinite(e.radarScore) && e.radarScore >= 0 && e.radarScore <= 100
    && e.radarScoreDirection === 'higher_is_stronger'
    && typeof e.radarLabel === 'string' && typeof e.radarStatus === 'string'
    && Array.isArray(e.evidenceGaps) && e.evidenceGaps.every(g => typeof g === 'string')
    && typeof e.radarFetchedAt === 'string' && Number.isFinite(Date.parse(e.radarFetchedAt))
}

export function verifyRadarTrackReceipt(receipt: unknown, userId: string, now = Date.now()): RadarTrackVerifyResult {
  const key = outcomeSigningSecret()
  if (!key) return fail('unconfigured', 'Track signing is not configured.')
  if (!receipt || typeof receipt !== 'object') return fail('invalid', 'Radar evidence is missing. Refresh Radar and track again.')
  const r = receipt as Partial<RadarTrackReceipt>
  if (r.v !== 1 || typeof r.signedAt !== 'string' || typeof r.sig !== 'string' || !r.evidence || typeof r.evidence !== 'object') {
    return fail('invalid', 'Radar evidence is invalid. Refresh Radar and track again.')
  }
  const evidence = r.evidence as RadarTrackEvidence
  if (!evidenceShapeOk(evidence)) return fail('invalid', 'Radar evidence is invalid. Refresh Radar and track again.')
  let supplied: Buffer
  try { supplied = Buffer.from(r.sig, 'base64url') } catch { return fail('invalid', 'Radar evidence is invalid. Refresh Radar and track again.') }
  const expected = mac(key, userId, r.signedAt, evidence)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return fail('invalid', 'Radar evidence could not be verified. Refresh Radar and track again.')
  }
  const signedMs = Date.parse(r.signedAt)
  const fetchedMs = Date.parse(evidence.radarFetchedAt)
  if (!Number.isFinite(signedMs) || signedMs - now > MAX_CLOCK_SKEW_MS || fetchedMs - now > MAX_CLOCK_SKEW_MS) {
    return fail('invalid', 'Radar evidence is invalid. Refresh Radar and track again.')
  }
  if (now - signedMs > RADAR_TRACK_RECEIPT_MAX_AGE_MS || now - fetchedMs > RADAR_TRACK_EVIDENCE_MAX_AGE_MS) {
    return fail('expired', 'Radar evidence is out of date. Refresh Radar and track again.')
  }
  return { ok: true, evidence, snapshot: snapshotFromRadarEvidence(evidence, userId) }
}

/** The canonical Track snapshot for a Radar receipt. Same frozen-baseline rules as Token Scanner receipts. */
export function snapshotFromRadarEvidence(e: RadarTrackEvidence, userId: string): ScanSnapshot {
  return JSON.parse(JSON.stringify({
    snapshotVersion: 2, riskScoreDirection: 'none', source: 'base_radar',
    userId, chain: e.chain, tokenAddress: e.tokenAddress,
    tokenSymbol: e.symbol, tokenName: e.name,
    // Deterministic per chain + token: repeated Track clicks resolve to the same receipt (idempotent).
    scanId: radarTrackScanId(e.chain, e.tokenAddress),
    scannedAt: new Date(Date.parse(e.radarFetchedAt)).toISOString(),
    baselinePriceUsd: freezeableBaselinePriceUsd({ priceUsd: e.priceUsd, marketCapUsd: e.marketCapUsd, chain: e.chain, tokenAddress: e.tokenAddress }),
    baselineLiquidityUsd: e.liquidityUsd,
    baselineMarketCapUsd: e.marketCapUsd,
    baselineRiskScore: null,
    baselineVerdict: `Radar ${e.radarLabel} · ${e.radarScore}/100`,
    baselineConfidence: null,
    baselineRiskReasons: e.evidenceGaps.length ? { radarEvidenceGaps: e.evidenceGaps } : null,
    baselineSecuritySignals: { simulationStatus: e.simulationStatus, riskLevel: e.riskLevel },
    baselineLpSignals: null,
    baselineHolderSignals: { holderVerified: e.holderVerified },
    baselineDevSignals: null,
    baselineOwnershipSignals: null,
    baselineMarketQualitySignals: { fdvUsd: e.fdvUsd, volume24hUsd: e.volume24hUsd, valuationBasis: e.valuationBasis, marketCapStatus: e.marketCapStatus, ageMinutes: e.ageMinutes, pairCreatedAt: e.pairCreatedAt },
    radarScore: e.radarScore, radarLabel: e.radarLabel, radarStatus: e.radarStatus,
    radarEvidence: e,
  })) as ScanSnapshot
}

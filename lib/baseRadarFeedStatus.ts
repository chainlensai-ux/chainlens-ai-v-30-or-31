// lib/baseRadarFeedStatus.ts — the Base Radar card's feed-level display model, momentum and status,
// moved verbatim out of app/terminal/base-radar/page.tsx so the server can sign exactly the score and
// status a card shows (Radar → Track receipts). Pure and isomorphic; no logic changed in the move.

import { getRadarFeedStatusFromScore } from './baseRadarFeedScoring'
import { buildBaseRadarDisplayModel, type BaseRadarDisplayModel } from './baseRadarDisplayModel'

export type RadarCardStatus = 'HOT' | 'WATCH' | 'EARLY' | 'UNVERIFIED' | 'RISKY' | 'DEAD'
export type RadarMomentumLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'

type RadarFeedToken = {
  liquidityUsd: number
  volume24h: number
  ageMinutes: number
  simulationStatus?: string | null
  holderVerified?: boolean
  honeypot?: object | null
}

export function getRadarMomentum(volume24hUsd: number, liquidityUsd: number): { level: RadarMomentumLevel; ratio: number } {
  if (!liquidityUsd || !volume24hUsd || volume24hUsd <= 0) return { level: 'NONE', ratio: 0 }
  const ratio = volume24hUsd / liquidityUsd
  if (ratio >= 0.5) return { level: 'HIGH', ratio }
  if (ratio >= 0.15) return { level: 'MEDIUM', ratio }
  return { level: 'LOW', ratio }
}

function getStatus(token: RadarFeedToken, score: number, momentum: RadarMomentumLevel): RadarCardStatus {
  const hasEnoughMarketData = Number.isFinite(token.liquidityUsd) && Number.isFinite(token.volume24h) && token.liquidityUsd > 0
  // HOLDER-EVIDENCE-CAPS-STATUS: a candidate never reaches HOT/EARLY/WATCH purely because everything
  // else looks good if holder evidence is missing.
  const insufficientData = !hasEnoughMarketData || token.simulationStatus !== 'passed' || token.holderVerified === false

  if (insufficientData) return 'UNVERIFIED'
  if (token.volume24h <= 0 && token.ageMinutes > 30) return 'DEAD'
  if (score >= 80 && (momentum === 'HIGH' || momentum === 'MEDIUM')) return 'HOT'
  if (token.ageMinutes <= 30 && score >= 50) return 'EARLY'
  if (score >= 60) return 'WATCH'
  if (score < 40) return 'RISKY'
  return 'WATCH'
}

/** The feed card's display model: same evidence path the drawer uses, from the feed's own simulation result. */
export function buildRadarFeedDisplayModel(token: RadarFeedToken): BaseRadarDisplayModel {
  return buildBaseRadarDisplayModel(token as unknown as Record<string, unknown>, {
    security: { honeypot: token.honeypot ? { ...token.honeypot, simulationSuccess: token.simulationStatus === 'passed' } : null },
  })
}

/**
 * Card status. Holder-unverified caps at UNVERIFIED on every branch; a pending simulation uses the pure
 * score → status mapping; a passed simulation uses the momentum-aware status.
 */
export function resolveRadarCardStatus(token: RadarFeedToken, displayModel: Pick<BaseRadarDisplayModel, 'score' | 'simulation'>, momentum: RadarMomentumLevel): RadarCardStatus {
  return token.holderVerified === false
    ? 'UNVERIFIED'
    : displayModel.simulation.status !== 'passed' ? getRadarFeedStatusFromScore(displayModel.score) : getStatus(token, displayModel.score, momentum)
}

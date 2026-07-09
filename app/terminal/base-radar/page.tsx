'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import ProjectOverviewDrawer from './ProjectOverviewDrawer'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import { getRadarFeedStatusFromScore } from '@/lib/baseRadarFeedScoring'
import { buildBaseRadarDisplayModel, type BaseRadarDisplayModel } from '@/lib/baseRadarDisplayModel'
import { useDrawerPreload } from '@/lib/useDrawerPreload'

interface HoneypotResult {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  simulationSuccess: boolean
}

interface RadarToken {
  name: string
  symbol: string
  contract: string
  ageMinutes: number
  liquidityUsd: number
  volume24h: number
  honeypot: HoneypotResult | null
  clarkVerdict: string | null
  fdvUsd?: number | null
  marketCapUsd?: number | null
  marketCapStatus?: string | null
  valuationBasis?: 'verified_market_cap' | 'fdv_fallback' | 'unavailable'
  valuationUsd?: number | null
  valuationLabel?: string | null
  valuationSublabel?: string | null
  valuationVerified?: boolean
  valuationReason?: string | null
  valuationCortexLine?: string | null
  evidenceGaps?: string[]
  simulationStatus?: 'passed' | 'open_check'
  simulationReason?: string | null
  simulationLabel?: string | null
  simulationCortexLine?: string | null
}

interface RadarStats {
  totalNewTokens: number
  averageLiquidity: number
}

interface RadarData {
  tokens: RadarToken[]
  stats: RadarStats
  fetchedAt: string
  // Real fields the API always returns (app/api/radar/route.ts) but this interface previously
  // didn't declare — forced an inline `as { limitedLiveFeed?: boolean }` cast at the one call site
  // that read it instead of being properly typed.
  limitedLiveFeed?: boolean
  mode?: 'shallow' | 'full'
}

type RadarStatus = 'HOT' | 'WATCH' | 'EARLY' | 'UNVERIFIED' | 'RISKY' | 'DEAD'
type MomentumLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
type RadarFilter = 'TRENDING' | 'NEW' | 'VOLUME' | 'LIQUIDITY' | 'RISK_WATCH' | 'WATCHLIST'
type SortMode = 'NEWEST' | 'HIGHEST_SCORE' | 'HIGHEST_LIQUIDITY' | 'HIGHEST_VOLUME' | 'HIGHEST_MOMENTUM'

type QualityLevel = 'Weak' | 'OK' | 'Strong' | 'None' | 'Low' | 'Medium' | 'High' | 'Fresh' | 'New' | 'Older' | 'Clean' | 'Unknown' | 'Verified' | 'Security Unknown'

interface LaunchQuality {
  liquidity: QualityLevel
  volume: QualityLevel
  age: QualityLevel
  taxes: QualityLevel
  security: QualityLevel
}

interface TokenIntel extends RadarToken {
  radarScore: number
  status: RadarStatus
  momentum: MomentumLevel
  momentumRatio: number
  flags: string[]
  clarkSignal: string
  suspiciousBranding: boolean
  launchQuality: LaunchQuality
  displayModel: BaseRadarDisplayModel
}


type DrawerSimulationPayload = {
  simulationStatus: 'passed' | 'open_check'
  simulationReason?: string | null
  simulationLabel?: string | null
  simulationCortexLine?: string | null
  buySellSimulation?: {
    buyTax?: number | null
    sellTax?: number | null
    isHoneypot?: boolean | null
    simulationSuccess?: boolean | null
  } | null
  riskFlags?: string[]
}

interface RadarSummary {
  newPools: number
  worthWatching: number
  highMomentum: number
  unverified: number
  averageLiquidity: number
  highestLiquidityToken: string
  highestLiquidityValue: string
  highestVolumeToken: string
  highestVolumeValue: string
  newestToken: string
  newestValue: string
  hottestToken: string
  hottestValue: string
  hasSecurityData: boolean
}

const SUSPICIOUS_BRANDING_WORDS = ['inu', 'elon', 'musk', 'ai', '1000x', 'moon', 'doge', 'pepe', 'pump', 'safe']

const STATUS_COLOR: Record<RadarStatus, string> = {
  HOT: '#22d3ee',
  WATCH: '#2DD4BF',
  EARLY: '#60a5fa',
  UNVERIFIED: '#94a3b8',
  RISKY: '#fbbf24',
  DEAD: '#f87171',
}

const STATUS_BG: Record<RadarStatus, string> = {
  HOT: 'rgba(34,211,238,0.11)',
  WATCH: 'rgba(45,212,191,0.10)',
  EARLY: 'rgba(96,165,250,0.12)',
  UNVERIFIED: 'rgba(148,163,184,0.12)',
  RISKY: 'rgba(251,191,36,0.12)',
  DEAD: 'rgba(248,113,113,0.12)',
}

const STATUS_BORDER: Record<RadarStatus, string> = {
  HOT: 'rgba(34,211,238,0.30)',
  WATCH: 'rgba(45,212,191,0.25)',
  EARLY: 'rgba(96,165,250,0.28)',
  UNVERIFIED: 'rgba(148,163,184,0.30)',
  RISKY: 'rgba(251,191,36,0.28)',
  DEAD: 'rgba(248,113,113,0.30)',
}

const FILTER_CHIPS: Array<{ key: RadarFilter; label: string }> = [
  { key: 'TRENDING', label: 'Trending' },
  { key: 'NEW', label: 'New' },
  { key: 'VOLUME', label: 'Volume' },
  { key: 'LIQUIDITY', label: 'Liquidity' },
  { key: 'RISK_WATCH', label: 'Risk Watch' },
  { key: 'WATCHLIST', label: 'Watchlist Candidates' },
]

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: 'NEWEST', label: 'Newest' },
  { key: 'HIGHEST_SCORE', label: 'Highest Score' },
  { key: 'HIGHEST_LIQUIDITY', label: 'Highest Liquidity' },
  { key: 'HIGHEST_VOLUME', label: 'Highest Volume' },
  { key: 'HIGHEST_MOMENTUM', label: 'Highest Momentum' },
]

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return 'Open check'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function fmtAge(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return 'Open check'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function shortAddr(addr: string): string {
  if (!addr) return 'Open check'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function safeText(value: string | null | undefined, fallback = 'Open check'): string {
  return value && value.trim().length > 0 ? value : fallback
}


function cleanIdentityPart(value: string | null | undefined): string {
  const cleaned = safeText(value, '')
    .replace(/call\s*↳\s*by\s*@?[\w.-]+/ig, ' ')
    .replace(/\b\d+\s*(?:s|m|h|d)\s*ago\b/ig, ' ')
    .replace(/@[\w.-]+/g, ' ')
    .replace(/0x[a-fA-F0-9]{6,}/g, ' ')
    .replace(/[·•|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned
}

function getTokenIdentity(token: RadarToken): { primary: string; symbol: string; context: string } {
  const rawName = cleanIdentityPart(token.name)
  const rawSymbol = cleanIdentityPart(token.symbol).replace(/^\$+/, '')
  const symbol = rawSymbol || 'TOKEN'
  const nameWithoutDuplicate = rawName.replace(new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), '').replace(/\s+/g, ' ').trim()
  const primary = nameWithoutDuplicate && nameWithoutDuplicate.toLowerCase() !== symbol.toLowerCase() ? nameWithoutDuplicate : symbol
  const context = token.ageMinutes <= 30 ? `Fresh call · ${fmtAge(token.ageMinutes)}` : `Radar call · ${fmtAge(token.ageMinutes)}`

  return { primary, symbol, context }
}

function getOverviewTokenTitle(token: TokenIntel | undefined): string {
  if (!token) return 'Open check'
  const identity = getTokenIdentity(token)
  return identity.symbol && identity.symbol !== identity.primary ? `${identity.primary} / ${identity.symbol}` : identity.primary
}

function hasSuspiciousBranding(name: string, symbol: string): boolean {
  const text = `${name} ${symbol}`.toLowerCase()
  return SUSPICIOUS_BRANDING_WORDS.some(word => text.includes(word))
}

function getMomentum(volume24hUsd: number, liquidityUsd: number): { level: MomentumLevel; ratio: number } {
  if (!liquidityUsd || !volume24hUsd || volume24hUsd <= 0) return { level: 'NONE', ratio: 0 }
  const ratio = volume24hUsd / liquidityUsd
  if (ratio >= 0.5) return { level: 'HIGH', ratio }
  if (ratio >= 0.15) return { level: 'MEDIUM', ratio }
  return { level: 'LOW', ratio }
}

function getBaseRadarScore(token: RadarToken): number {
  const liquidityUsd = Number.isFinite(token.liquidityUsd) ? token.liquidityUsd : 0
  const volume24hUsd = Number.isFinite(token.volume24h) ? token.volume24h : 0
  const poolAgeMinutes = Number.isFinite(token.ageMinutes) ? token.ageMinutes : 0
  const buyTax = token.honeypot?.buyTax ?? 0
  const sellTax = token.honeypot?.sellTax ?? 0
  const suspiciousBranding = hasSuspiciousBranding(token.name, token.symbol)

  let score = 50

  if (liquidityUsd >= 10_000) score += 20
  if (liquidityUsd >= 30_000) score += 10
  if (liquidityUsd < 2_000) score -= 20

  if (volume24hUsd >= 5_000) score += 15
  if (volume24hUsd >= 20_000) score += 10
  if (volume24hUsd <= 0) score -= 15

  if (poolAgeMinutes <= 120) score += 10
  if (poolAgeMinutes <= 5 && volume24hUsd <= 0) score -= 10

  if (buyTax === 0 && sellTax === 0) score += 10
  if (buyTax > 5 || sellTax > 5) score -= 15
  if (buyTax > 15 || sellTax > 15) score -= 25

  if (suspiciousBranding) score -= 10

  return Math.max(0, Math.min(100, score))
}

function getStatus(token: RadarToken, score: number, momentum: MomentumLevel): RadarStatus {
  const hasEnoughMarketData = Number.isFinite(token.liquidityUsd) && Number.isFinite(token.volume24h) && token.liquidityUsd > 0
  const insufficientData = !hasEnoughMarketData || token.simulationStatus !== 'passed'

  if (insufficientData) return 'UNVERIFIED'
  if (token.volume24h <= 0 && token.ageMinutes > 30) return 'DEAD'
  if (score >= 80 && (momentum === 'HIGH' || momentum === 'MEDIUM')) return 'HOT'
  if (token.ageMinutes <= 30 && score >= 50) return 'EARLY'
  if (score >= 60) return 'WATCH'
  if (score < 40) return 'RISKY'
  return 'WATCH'
}

function getCortexSignal(status: RadarStatus): string {
  const map: Record<RadarStatus, string> = {
    HOT: 'Strong early activity relative to liquidity. Worth watching closely, but still verify before entry.',
    WATCH: 'Fresh Base pool with some traction. Monitor liquidity and volume before making a move.',
    EARLY: 'Very new pool. Not enough history yet, but early activity is visible.',
    UNVERIFIED: 'Not enough verified market data yet. Treat as unconfirmed, not automatically reliable.',
    RISKY: 'Weak liquidity, poor activity, or tax/branding flags detected. Approach carefully.',
    DEAD: 'No meaningful trading activity detected yet. Likely inactive or too early.',
  }
  return map[status]
}

function getFlags(token: RadarToken, status: RadarStatus, momentum: MomentumLevel, suspiciousBranding: boolean): string[] {
  const flags: string[] = []
  if (momentum === 'HIGH') flags.push('Momentum')
  if (token.ageMinutes <= 30) flags.push('New Pool')
  if (token.volume24h >= 5_000) flags.push('Volume Spike')
  if (token.liquidityUsd >= 30_000) flags.push('Liquidity Watch')
  if (token.liquidityUsd < 2_000) flags.push('Tax check pending')
  if (token.simulationStatus === 'open_check') flags.push('Simulation pending')
  if (token.simulationStatus === 'passed') flags.push('Simulation checked')
  if (suspiciousBranding) flags.push('CORTEX Watch')
  if (status === 'UNVERIFIED') flags.push('Pending Evidence')
  if (status === 'RISKY') flags.push('High Risk')

  return flags
}

function getLaunchQuality(token: RadarToken): LaunchQuality {
  const liquidity = token.liquidityUsd >= 20_000 ? 'Strong' : token.liquidityUsd >= 5_000 ? 'OK' : 'Weak'

  let volume: QualityLevel = 'None'
  if (token.volume24h > 20_000) volume = 'High'
  else if (token.volume24h >= 5_000) volume = 'Medium'
  else if (token.volume24h > 0) volume = 'Low'

  const age = token.ageMinutes <= 30 ? 'Fresh' : token.ageMinutes <= 120 ? 'New' : 'Older'

  let taxes: QualityLevel = 'Unknown'
  if (token.simulationStatus === 'passed') {
    const buyTax = token.honeypot?.buyTax ?? 0
    const sellTax = token.honeypot?.sellTax ?? 0
    taxes = buyTax > 5 || sellTax > 5 ? 'High' : 'Clean'
  }

  const security: QualityLevel = token.simulationStatus === 'passed' ? 'Verified' : 'Security Unknown'

  return { liquidity, volume, age, taxes, security }
}

function enrichToken(token: RadarToken): TokenIntel {
  const suspiciousBranding = hasSuspiciousBranding(token.name, token.symbol)
  const { level: momentum, ratio: momentumRatio } = getMomentum(token.volume24h, token.liquidityUsd)
  // TOKEN-SAVER: the feed list only carries the evidence the /api/radar scan already
  // produced (simulation/honeypot result). LP lock/burn, dev-wallet, and holder evidence
  // require the deep per-token scan from /api/base-radar/enrichment (fetched on-demand in
  // the drawer) — never fabricate it here. Passing this real, already-computed evidence
  // explicitly (instead of omitting it) keeps the scoring engine on the same evidence path
  // the drawer uses, so the scoring logs and caps reflect what is actually known per token.
  let displayModel: BaseRadarDisplayModel
  try {
    displayModel = buildBaseRadarDisplayModel(token, {
      security: { honeypot: token.honeypot ? { ...token.honeypot, simulationSuccess: token.simulationStatus === 'passed' } : null },
    })
  } catch (err) {
    console.error('[base-radar] scoring failed for', token.contract, err)
    displayModel = {
      score: 49,
      riskLabel: 'MODERATE',
      whyOnRadar: 'Open check: evidence could not be scored.',
      valuation: { label: 'Valuation', valueUsd: null, status: 'open_check', sublabel: 'Open check', warning: null },
      simulation: { status: 'open_check', reason: null, label: 'Simulation pending', cortexLine: 'Buy/sell simulation remains open check.', buyTax: null, sellTax: null },
      evidenceGaps: ['Scoring error — evidence unavailable'],
      signalChips: ['Valuation Open Check', 'Simulation Pending', 'MODERATE'],
      marketSnapshot: { liquidityUsd: null, volume24hUsd: null, fdvUsd: null, marketCapUsd: null, marketCapStatus: null, valuationBasis: 'unavailable' },
    }
  }
  const radarScore = displayModel.score
  const status = displayModel.simulation.status !== 'passed' ? getRadarFeedStatusFromScore(radarScore) : getStatus(token, radarScore, momentum)

  return {
    ...token,
    suspiciousBranding,
    momentum,
    momentumRatio,
    radarScore,
    status,
    flags: getFlags(token, status, momentum, suspiciousBranding),
    clarkSignal: getCortexSignal(status),
    launchQuality: getLaunchQuality(token),
    displayModel,
  }
}

function qualityColor(level: QualityLevel): string {
  if (['Strong', 'High', 'Clean', 'Verified', 'Fresh'].includes(level)) return '#2DD4BF'
  if (['OK', 'Medium', 'New'].includes(level)) return '#60a5fa'
  if (['Unknown', 'Low'].includes(level)) return '#94a3b8'
  return '#fbbf24'
}

function getStageLabel(token: TokenIntel): string {
  if (token.status === 'HOT') return 'Trending'
  if (token.ageMinutes <= 15) return 'New Pool'
  if (token.status === 'EARLY') return 'Early'
  return 'Watch'
}

function getSignalInsight(token: TokenIntel): string {
  const needsScan = token.simulationStatus !== 'passed'
  const activeLiquidity = token.liquidityUsd >= 10_000
  const highVolume = token.volume24h >= 5_000
  const fresh = token.ageMinutes <= 30

  if (token.momentum === 'HIGH' && activeLiquidity) return `Volume is rising while liquidity remains active. ${needsScan ? 'Needs Token Scanner confirmation before trusting risk.' : 'Risk checks are visible, but keep monitoring holders and liquidity.'}`
  if (fresh && token.momentum !== 'NONE') return `Fresh momentum detected${activeLiquidity ? ' with active liquidity' : ''}. ${needsScan ? 'Holder and liquidity safety still need deeper scan.' : 'Still a watchlist candidate, not a confirmed safe token.'}`
  if (highVolume) return `High activity token with ${needsScan ? 'risk checks still open' : 'simulation checks visible'}. Review liquidity and holder context before acting.`
  if (token.status === 'RISKY' || token.status === 'UNVERIFIED') return `${needsScan ? 'Needs scan' : 'Open check'}: activity is visible, but unresolved risk signals keep this in watch mode.`
  if (activeLiquidity) return `Liquidity remains active with developing activity. Watchlist candidate, not a confirmed safe token.`
  return token.displayModel.whyOnRadar || 'Open check: radar placement comes from current liquidity, volume, and evidence signals.'
}

function getOpportunityLabel(token: TokenIntel, index: number): string {
  if (index === 0) return 'Top Opportunity'
  if (token.momentum === 'HIGH') return 'High Momentum'
  if (token.ageMinutes <= 30 && token.liquidityUsd >= 10_000) return 'Fresh Liquidity'
  if (token.status === 'RISKY' || token.status === 'UNVERIFIED' || token.simulationStatus !== 'passed') return 'Risk Watch'
  return 'Needs Token Scan'
}

function simulationStatusLabel(token: RadarToken): string {
  if (token.simulationStatus === 'passed') return token.simulationLabel ?? 'Tax check clear'
  if (token.simulationReason === 'timeout_after_retry' || token.simulationReason === 'timeout') return 'Tax check timed out'
  if (token.simulationReason === 'unsupported_pool_model') return 'Simulation unsupported'
  if (token.simulationReason === 'missing_pair_address') return 'Pair route missing'
  if (token.simulationReason === 'insufficient_route') return 'Route evidence missing'
  if (token.simulationReason === 'provider_unavailable') return 'Simulation temporarily unavailable'
  if (token.simulationReason === 'not_attempted_low_confidence_pair') return 'Simulation pending'
  return 'Simulation pending'
}

function getTaxLabel(token: TokenIntel): string {
  if (token.simulationLabel) return token.simulationLabel
  if (!token.honeypot?.simulationSuccess) return simulationStatusLabel(token)
  const buyTax = token.honeypot.buyTax ?? 0
  const sellTax = token.honeypot.sellTax ?? 0
  return `B ${buyTax.toFixed(1)}% / S ${sellTax.toFixed(1)}%`
}

function getValuationCardMetric(token: TokenIntel): { label: string; value: string; sublabel?: string | null; accent?: string } {
  const valuation = token.displayModel.valuation
  return { label: valuation.label, value: valuation.valueUsd != null ? fmtUSD(valuation.valueUsd) : 'Open check', sublabel: valuation.sublabel, accent: valuation.status === 'verified' ? '#99f6e4' : valuation.status === 'fdv_fallback' ? '#fde68a' : undefined }
}

function getPriorityAccent(token: TokenIntel): { color: string; background: string; border: string; glow: string } {
  if (token.status === 'RISKY' || token.status === 'DEAD' || token.flags.includes('High Risk')) return { color: '#f87171', background: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.34)', glow: 'rgba(248,113,113,0.14)' }
  if (token.flags.some(flag => flag.includes('Pending Evidence') || flag === 'Simulation pending')) return { color: '#fbbf24', background: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.34)', glow: 'rgba(251,191,36,0.14)' }
  if (token.momentum === 'HIGH' || token.volume24h >= 5_000) return { color: '#2DD4BF', background: 'rgba(45,212,191,0.13)', border: 'rgba(45,212,191,0.36)', glow: 'rgba(45,212,191,0.16)' }
  if (token.radarScore >= 75) return { color: '#22d3ee', background: 'rgba(34,211,238,0.12)', border: 'rgba(34,211,238,0.34)', glow: 'rgba(34,211,238,0.15)' }
  return { color: STATUS_COLOR[token.status], background: STATUS_BG[token.status], border: STATUS_BORDER[token.status], glow: STATUS_BG[token.status] }
}

function getBadgeStyle(flag: string): { color: string; background: string; border: string } {
  if (['Momentum', 'Volume Spike', 'Simulation confirmed', 'Simulation checked'].includes(flag)) return { color: '#99f6e4', background: 'rgba(45,212,191,0.13)', border: 'rgba(45,212,191,0.30)' }
  if (['Tax check pending', 'Simulation pending', 'Pending Evidence', 'Liquidity Watch'].includes(flag)) return { color: '#fde68a', background: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.28)' }
  if (['High Risk', 'CORTEX Watch'].includes(flag)) return { color: '#fecaca', background: 'rgba(248,113,113,0.11)', border: 'rgba(248,113,113,0.28)' }
  return { color: '#bfdbfe', background: 'rgba(96,165,250,0.13)', border: 'rgba(96,165,250,0.30)' }
}

function TokenCard({
  token,
  index,
  onScan,
  onAskCortex,
  onOpenOverview,
  onTrackToggle,
  onPreload,
  tracking,
}: {
  token: TokenIntel
  index: number
  onScan: () => void
  onAskCortex: () => void
  onOpenOverview: () => void
  onTrackToggle: () => void
  onPreload: () => void
  tracking: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const { preload, registerPreloadTarget, state: preloadState } = useDrawerPreload(token.contract, { liquidityUsd: token.liquidityUsd })
  const priorityAccent = getPriorityAccent(token)
  const statusColor = priorityAccent.color
  const statusBg = priorityAccent.background
  const statusBorder = priorityAccent.border
  const identity = getTokenIdentity(token)
  const avatarText = (identity.symbol || identity.primary || '?').slice(0, 2).toUpperCase()
  const highSignal = token.radarScore >= 75 || index < 3
  const opportunityLabel = getOpportunityLabel(token, index)
  const stageLabel = getStageLabel(token)
  const insight = getSignalInsight(token)
  const valuationDisplay = getValuationCardMetric(token)
  const metrics = [
    { label: 'Liquidity', value: fmtUSD(token.liquidityUsd), accent: token.liquidityUsd >= 30_000 ? '#99f6e4' : undefined },
    { label: '24h Volume', value: fmtUSD(token.volume24h), accent: token.volume24h >= 5_000 ? '#99f6e4' : undefined },
    valuationDisplay,
    { label: 'Age', value: fmtAge(token.ageMinutes), accent: token.ageMinutes <= 30 ? '#bfdbfe' : undefined },
    { label: 'Momentum', value: token.momentum === 'NONE' ? 'Open check' : token.momentum, accent: token.momentum === 'HIGH' ? '#99f6e4' : undefined },
    { label: 'Tax Check', value: getTaxLabel(token), accent: token.simulationStatus === 'passed' ? '#99f6e4' : '#fde68a' },
  ]

  return (
    <div
      className='opportunity-card'
      onClick={onOpenOverview}
      ref={registerPreloadTarget}
      onMouseEnter={() => { setHovered(true); preload(); onPreload() }}
      onFocus={() => { preload(); onPreload() }}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered
          ? `linear-gradient(135deg, rgba(15,23,42,0.96), rgba(6,13,24,0.92)), radial-gradient(circle at 0% 0%, ${statusBg}, transparent 38%)`
          : `linear-gradient(135deg, rgba(8,13,24,0.94), rgba(4,9,18,0.90)), radial-gradient(circle at 0% 0%, ${statusBg}, transparent 36%)`,
        border: `1px solid ${hovered || highSignal ? statusBorder : 'rgba(148,163,184,0.13)'}`,
        borderRadius: '18px',
        padding: '12px 13px',
        cursor: 'pointer',
        transition: 'transform 0.18s ease, background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease',
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: highSignal ? `0 16px 48px rgba(0,0,0,0.26), 0 0 30px ${priorityAccent.glow}` : '0 14px 36px rgba(0,0,0,0.22)',
        animation: 'radarSlideIn 0.35s ease both',
        animationDelay: `${index * 45}ms`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', inset: '0 auto 0 0', width: highSignal ? '5px' : '4px', background: `linear-gradient(180deg, ${statusColor}, transparent)`, opacity: highSignal ? 0.95 : 0.65 }} />

      <div className='token-card-header' style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <div style={{ width: '38px', height: '38px', borderRadius: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 900, color: '#f8fafc', background: `linear-gradient(135deg, ${statusBg}, rgba(168,85,247,0.20))`, border: `1px solid ${statusBorder}`, boxShadow: `0 0 22px ${statusBg}`, fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}>
            {avatarText}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '7px', minWidth: 0 }}>
              <span style={{ fontSize: '16px', fontWeight: 850, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{identity.primary}</span>
              <span style={{ fontSize: '11px', fontWeight: 800, color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>{identity.symbol}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
              <MiniPill label={`#${index + 1}`} color={index < 3 ? '#99f6e4' : '#94a3b8'} background={index < 3 ? 'rgba(45,212,191,0.13)' : 'rgba(255,255,255,0.06)'} border={index < 3 ? 'rgba(45,212,191,0.30)' : 'rgba(255,255,255,0.10)'} />
              <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>{shortAddr(token.contract)}</span>
              <MiniPill label={identity.context} />
              <MiniPill label={opportunityLabel} color={statusColor} background={statusBg} border={statusBorder} />
              <MiniPill label={stageLabel} color={statusColor} background={statusBg} border={statusBorder} />
              {preloadState === 'cached' ? <MiniPill label='Drawer Cached' color='#99f6e4' background='rgba(45,212,191,0.11)' border='rgba(45,212,191,0.25)' /> : null}
            </div>
          </div>
        </div>

        <div style={{ minWidth: '86px', borderRadius: '16px', padding: '7px 9px', textAlign: 'center', background: `linear-gradient(180deg, ${statusBg}, rgba(255,255,255,0.035))`, border: `1px solid ${statusBorder}`, boxShadow: highSignal ? `0 0 22px ${statusBg}` : 'none' }}>
          <p style={{ margin: '0 0 2px', fontSize: '8px', color: '#94a3b8', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', fontWeight: 800 }}>Radar Status</p>
          <p style={{ margin: 0, color: statusColor, fontSize: '25px', lineHeight: 1, fontWeight: 900, fontFamily: 'var(--font-plex-mono)' }}>{token.radarScore}</p>
          <p style={{ margin: '3px 0 0', color: statusColor, fontSize: '8px', fontWeight: 900, fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em' }}>{token.status}</p>
        </div>
      </div>

      <div style={{ borderRadius: '14px', padding: '9px 11px', marginBottom: '10px', border: `1px solid ${statusBorder}`, background: `linear-gradient(90deg, ${statusBg}, rgba(255,255,255,0.025))` }}>
        <p style={{ margin: '0 0 4px', fontSize: '9px', color: statusColor, letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 900, fontFamily: 'var(--font-plex-mono)' }}>Why on radar</p>
        <p style={{ margin: 0, color: '#dbeafe', fontSize: '12px', lineHeight: 1.45, fontWeight: 650 }}>{insight}</p>
      </div>

      <div className='token-card-metrics' style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '7px', marginBottom: '9px' }}>
        {metrics.map(metric => <Metric key={metric.label} {...metric} />)}
      </div>

      {token.flags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
          {token.flags.map(flag => {
            const badge = getBadgeStyle(flag)
            return <span key={flag} style={{ padding: '4px 8px', borderRadius: '99px', fontSize: '9px', fontWeight: 850, letterSpacing: '0.07em', color: badge.color, background: badge.background, border: `1px solid ${badge.border}`, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{flag}</span>
          })}
        </div>
      )}

      <div className='token-card-actions' style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '9px', borderTop: '1px solid rgba(148,163,184,0.12)' }}>
        <ActionButton label='Scan Token' variant='primary' onClick={onScan} />
        <ActionButton label='Ask CORTEX' variant='secondary' hint='Analyze with CORTEX' onClick={onAskCortex} />
        <ActionButton label={tracking ? 'Watching' : 'Add to Watchlist'} variant='ghost' active={tracking} onClick={onTrackToggle} />
      </div>
    </div>
  )
}

function MiniPill({ label, color = '#94a3b8', background = 'rgba(255,255,255,0.06)', border = 'rgba(255,255,255,0.10)' }: { label: string; color?: string; background?: string; border?: string }) {
  return <span style={{ padding: '3px 7px', borderRadius: '99px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', color, background, border: `1px solid ${border}`, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{label}</span>
}

function ActionButton({
  label,
  onClick,
  disabled,
  active,
  hint,
  variant = 'secondary',
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  hint?: string
  variant?: 'primary' | 'secondary' | 'ghost'
}) {
  const isPrimary = variant === 'primary'
  const isGhost = variant === 'ghost'
  const border = active ? 'rgba(45,212,191,0.38)' : isPrimary ? 'rgba(45,212,191,0.46)' : isGhost ? 'rgba(148,163,184,0.16)' : 'rgba(96,165,250,0.22)'
  const background = active ? 'rgba(45,212,191,0.16)' : isPrimary ? 'linear-gradient(135deg, rgba(45,212,191,0.22), rgba(34,211,238,0.14))' : isGhost ? 'rgba(15,23,42,0.38)' : 'rgba(15,23,42,0.72)'
  const color = disabled ? '#475569' : active ? '#2DD4BF' : isPrimary ? '#dffcf6' : isGhost ? '#94a3b8' : '#cbd5e1'

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onClick()
      }}
      title={hint}
      disabled={disabled}
      style={{
        flex: 1,
        minHeight: '34px',
        padding: '8px 11px',
        borderRadius: '11px',
        fontSize: '10px',
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        border: `1px solid ${border}`,
        background,
        color,
        fontFamily: 'var(--font-plex-mono)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: isPrimary ? '0 0 22px rgba(45,212,191,0.12), inset 0 1px 0 rgba(255,255,255,0.08)' : active ? '0 0 18px rgba(45,212,191,0.10)' : 'none',
      }}
    >
      {label}
    </button>
  )
}

function Metric({ label, value, accent, sublabel }: { label: string; value: string; accent?: string; sublabel?: string | null }) {
  return (
    <div style={{ border: '1px solid rgba(148,163,184,0.12)', borderRadius: '12px', padding: '9px 10px', background: 'rgba(255,255,255,0.035)', minWidth: 0 }}>
      <p style={{ fontSize: '8px', fontWeight: 800, letterSpacing: '0.12em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </p>
      <p style={{ fontSize: '13px', fontWeight: 850, color: accent ?? '#e2e8f0', margin: 0, fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </p>
      {sublabel && (
        <p style={{ fontSize: '9px', fontWeight: 700, color: '#64748b', margin: '3px 0 0', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {sublabel}
        </p>
      )}
    </div>
  )
}

function OverviewMetric({ label, value, caption, accent = '#99f6e4' }: { label: string; value: string; caption: string; accent?: string }) {
  return (
    <div className="radar-overview-card" style={{
      background: 'linear-gradient(180deg, rgba(8,13,24,0.82), rgba(10,18,32,0.58))',
      border: '1px solid rgba(148, 163, 184, 0.14)',
      borderRadius: '16px',
      padding: '12px 13px',
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 18px 45px rgba(0,0,0,0.22)`,
      minWidth: 0,
    }}>
      <p style={{ margin: '0 0 7px', fontSize: '9px', color: '#64748b', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{label}</p>
      <p title={value} style={{ margin: 0, fontSize: '15px', color: accent, fontWeight: 850, letterSpacing: '-0.02em', whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.12 }}>{value}</p>
      <p style={{ margin: '6px 0 0', fontSize: '10px', color: '#64748b', lineHeight: 1.25, fontFamily: 'var(--font-plex-mono)' }}>{caption}</p>
    </div>
  )
}

function PulseStrip({ summary }: { summary: RadarSummary }) {
  const items = [
    { label: 'Tokens Tracked', value: String(summary.newPools), caption: 'Current Base results', accent: '#e2e8f0' },
    { label: 'Strongest Mover', value: summary.hottestToken, caption: summary.hottestValue, accent: '#22d3ee' },
    { label: 'Highest Volume', value: summary.highestVolumeToken, caption: summary.highestVolumeValue, accent: '#99f6e4' },
    { label: 'Newest Pool', value: summary.newestToken, caption: summary.newestValue, accent: '#60a5fa' },
    { label: 'Liquidity Leader', value: summary.highestLiquidityToken, caption: summary.highestLiquidityValue, accent: '#c4b5fd' },
    { label: 'Evidence Gaps', value: String(summary.unverified), caption: 'Needs more evidence', accent: '#fbbf24' },
  ]

  return (
    <div className="radar-overview-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '10px', marginBottom: '14px' }}>
      {items.map((item) => (
        <OverviewMetric key={item.label} {...item} />
      ))}
    </div>
  )
}

function CortexRadarPanel({ summary, topTokens, onRescan }: { summary: RadarSummary; topTokens: TokenIntel[]; onRescan: () => void }) {
  const signals = [
    summary.highMomentum > 0 ? `${summary.highMomentum} momentum signal${summary.highMomentum === 1 ? '' : 's'} in the current Base feed.` : 'Momentum is still forming across the visible feed.',
    summary.worthWatching > 0 ? `${summary.worthWatching} token${summary.worthWatching === 1 ? '' : 's'} have enough traction to watch.` : 'No strong watch cluster yet; keep radar open.',
    topTokens[0] ? `${topTokens[0].symbol} is leading the current radar score.` : 'Open check: no lead token yet.',
    summary.averageLiquidity > 0 ? `Average visible liquidity is ${fmtUSD(summary.averageLiquidity)}.` : 'Liquidity evidence is still an open check.',
  ]
  const warnings = [
    summary.unverified > 0 ? `${summary.unverified} checks need more evidence.` : 'No open verification cluster in the current results.',
    summary.hasSecurityData ? 'Simulation is confirmed for some tokens; unresolved tokens are capped until checks complete.' : 'Simulation checks need more evidence.',
    'Use Token Scanner before acting on any radar signal.',
  ]

  return (
    <div style={{ background: 'linear-gradient(180deg, rgba(6,11,22,0.92), rgba(12,20,36,0.76))', border: '1px solid rgba(45,212,191,0.18)', borderRadius: '18px', padding: '16px', boxShadow: '0 24px 70px rgba(0,0,0,0.28), 0 0 45px rgba(45,212,191,0.08)' }}>
      <p style={{ margin: '0 0 4px', color: '#99f6e4', fontSize: '11px', fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>CORTEX Radar Read</p>
      <p style={{ margin: '0 0 14px', color: '#94a3b8', fontSize: '12px', lineHeight: 1.45 }}>Live interpretation of the visible Base Radar feed. Not financial advice.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
        {signals.slice(0, 4).map(signal => (
          <div key={signal} style={{ display: 'flex', gap: '8px', color: '#cbd5e1', fontSize: '11px', lineHeight: 1.4 }}>
            <span style={{ color: '#22d3ee' }}>✦</span>
            <span>{signal}</span>
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {warnings.slice(0, 3).map(warning => (
          <div key={warning} style={{ display: 'flex', gap: '8px', color: '#fbbf24', fontSize: '11px', lineHeight: 1.4 }}>
            <span>◇</span>
            <span>{warning}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' }}>
        <Link href="/terminal/token-scanner" style={{ textDecoration: 'none', padding: '7px 10px', borderRadius: '10px', border: '1px solid rgba(45,212,191,0.30)', background: 'rgba(45,212,191,0.12)', color: '#99f6e4', fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Open Token Scanner</Link>
        <button onClick={onRescan} style={{ padding: '7px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: '#cbd5e1', fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', cursor: 'pointer' }}>Rescan</button>
      </div>
    </div>
  )
}

function StatsPanel({ summary, fetchedAt, loading, showUpsell }: { summary: RadarSummary; fetchedAt: string | null; loading: boolean; showUpsell: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '14px' }}>
        <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 12px' }}>
          Radar Stats
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '10px' }}>
          <div style={{
            width: '88px',
            height: '88px',
            borderRadius: '50%',
            border: '1px solid rgba(45,212,191,0.30)',
            background: 'radial-gradient(circle at center, rgba(45,212,191,0.16), rgba(15,23,42,0.3) 65%)',
            boxShadow: '0 0 20px rgba(45,212,191,0.18)',
            position: 'relative',
          }}>
            <div style={{ position: 'absolute', inset: '14px', borderRadius: '50%', border: '1px dashed rgba(168,85,247,0.30)' }} />
            <div style={{ position: 'absolute', left: '50%', top: '50%', width: '4px', height: '4px', borderRadius: '50%', background: '#99f6e4', transform: 'translate(-50%, -50%)' }} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <Stat label='New pools / tokens' value={String(summary.newPools)} loading={loading} />
          <Stat label='Worth watching' value={String(summary.worthWatching)} loading={loading} />
          <Stat label='High momentum' value={String(summary.highMomentum)} loading={loading} />
          <Stat label='Unverified' value={String(summary.unverified)} loading={loading} />
          <Stat label='Avg liquidity' value={fmtUSD(summary.averageLiquidity)} loading={loading} />
        </div>
      </div>

      {fetchedAt && (
        <p style={{ fontSize: '10px', color: '#3a5268', textAlign: 'center', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
          Updated {new Date(fetchedAt).toLocaleTimeString()}
        </p>
      )}

      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '14px' }}>
        <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 10px' }}>
          Evidence
        </p>
        {[
          'Market Data',
          summary.hasSecurityData ? 'Simulation Evidence' : 'CORTEX Evidence',
        ].map(src => (
          <div key={src} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '11px', color: '#64748b', marginBottom: '6px', fontFamily: 'var(--font-plex-mono)' }}>
            <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', flexShrink: 0 }} />
            {src}
          </div>
        ))}
      </div>

      {showUpsell && <div style={{
        background: 'linear-gradient(180deg, rgba(168,85,247,0.10), rgba(45,212,191,0.08))',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '12px 13px',
      }}>
        <p style={{ margin: 0, fontSize: '11px', lineHeight: 1.35, color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>
          Upgrade to Pro
        </p>
        <p style={{ margin: '8px 0 10px', fontSize: '10px', color: '#cbd5e1', lineHeight: 1.4 }}>
          Unlock advanced filters, alerts, and AI insights.
        </p>
        <Link href='/pricing' style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6px 10px',
          borderRadius: '8px',
          border: '1px solid rgba(45,212,191,0.35)',
          background: 'rgba(45,212,191,0.14)',
          color: '#99f6e4',
          textDecoration: 'none',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          fontFamily: 'var(--font-plex-mono)',
          textTransform: 'uppercase',
        }}>
          Upgrade Now
        </Link>
      </div>}
    </div>
  )
}

function Stat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div>
      <p style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.12em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 4px' }}>
        {label}
      </p>
      <p style={{ fontSize: '16px', fontWeight: 700, color: loading ? '#3a5268' : '#e2e8f0', fontFamily: 'var(--font-plex-mono)', margin: 0, transition: 'color 0.3s' }}>
        {value}
      </p>
    </div>
  )
}

function StagedRadarLoading() {
  const stages = ['Loading radar feed…', 'Ranking opportunities…', 'Checking momentum…', 'Preparing risk context…', 'Finalizing Base Radar…']
  return (
    <div style={{ borderRadius: '14px', border: '1px solid rgba(45,212,191,0.18)', background: 'rgba(45,212,191,0.06)', padding: '14px 16px', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {stages.map((stage, i) => (
        <span key={stage} style={{ padding: '5px 8px', borderRadius: '99px', border: '1px solid rgba(45,212,191,0.18)', background: i === 0 ? 'rgba(45,212,191,0.12)' : 'rgba(255,255,255,0.03)', color: i === 0 ? '#99f6e4' : '#64748b' }}>{stage}</span>
      ))}
    </div>
  )
}

function EmptyFeed({ limited }: { limited: boolean }) {
  return (
    <div style={{ textAlign: 'center', padding: '42px 20px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', border: '1px solid rgba(148,163,184,0.12)', borderRadius: '16px', background: 'rgba(255,255,255,0.025)' }}>
      <div style={{ fontSize: '30px', marginBottom: '12px', opacity: 0.45 }}>◈</div>
      <p style={{ fontSize: '14px', fontWeight: 800, margin: '0 0 8px', color: '#cbd5e1' }}>No strong radar candidates right now.</p>
      <p style={{ fontSize: '12px', fontWeight: 600, margin: 0, lineHeight: 1.45 }}>
        {limited ? 'Live feed is limited. Try refreshing, changing filters, or scanning a token directly.' : 'Try refreshing, changing filters, or scanning a token directly.'}
      </p>
    </div>
  )
}

function LowActivityPanel() {
  return (
    <div style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', padding: '14px 16px', fontFamily: 'var(--font-plex-mono)', marginTop: '10px' }}>
      <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
        Radar is quiet right now. New Base pools will appear here as Market Data detects them.
      </p>
    </div>
  )
}

export default function BaseRadarPage() {
  const { plan, loading: planLoading, elitePass } = usePlanWithLoading()
  const router = useRouter()
  const [data, setData] = useState<RadarData | null>(null)
  const hasRadarDataRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(120)
  const [refreshKey, setRefreshKey] = useState(0)
  // OVERLAPPING-FETCH FIX, DISCLOSED (Base Radar speed audit): fetchData() previously had no
  // AbortController and no in-flight guard. Two independent triggers — the 120s interval poll and
  // handleManualRefresh — could both call fetchData() concurrently (e.g. a manual refresh right as
  // the interval tick fires), and since neither cancelled the other, whichever response happened to
  // arrive LAST won via setData(), even if it was the stale (earlier-started) request. Also: the
  // interval kept polling every 120s regardless of tab visibility, running the backend's full
  // multi-token scoring pipeline for a tab nobody was looking at. fetchInFlightRef guards against
  // overlapping requests; abortControllerRef lets a superseded request actually cancel its network
  // call instead of just being ignored client-side.
  const fetchInFlightRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const [activeFilter, setActiveFilter] = useState<RadarFilter>('TRENDING')
  const [sortMode, setSortMode] = useState<SortMode>('NEWEST')
  const [trackedContracts, setTrackedContracts] = useState<Record<string, boolean>>({})
  const [selectedToken, setSelectedToken] = useState<TokenIntel | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const effectivePlan = elitePass.active ? 'elite' : plan
  const showUpsell = effectivePlan === 'free'

  const fetchData = useCallback(async () => {
    // Cancel any still-in-flight request (e.g. manual refresh firing while the interval-driven
    // fetch hasn't resolved yet) before starting a new one — the old request's response, once it
    // arrives, is aborted rather than allowed to race the new one and potentially overwrite it with
    // stale data.
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    fetchInFlightRef.current = true

    setLoading(true)
    setError(null)
    try {
      const { data: _sd } = await supabase.auth.getSession()
      const _tok = _sd.session?.access_token
      const res = await fetch('/api/radar', { cache: 'no-store', signal: controller.signal, headers: _tok ? { Authorization: `Bearer ${_tok}` } : {} })
      const json = await res.json()
      if (!res.ok || json.error) {
        setError(hasRadarDataRef.current ? 'Radar refresh failed. Showing last available read.' : 'Radar refresh failed. Try refreshing or scanning a token directly.')
      } else {
        hasRadarDataRef.current = true
        setData(json as RadarData)
      }
    } catch (err) {
      // AbortError means this request was superseded by a newer one (or the component unmounted) —
      // the newer request already owns loading/error state, so this one must not touch it.
      if (err instanceof Error && err.name === 'AbortError') return
      setError(hasRadarDataRef.current ? 'Radar refresh failed. Showing last available read.' : 'Radar refresh failed. Try refreshing or scanning a token directly.')
    } finally {
      if (abortControllerRef.current === controller) {
        fetchInFlightRef.current = false
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!planLoading && canAccessFeature(effectivePlan, 'base-radar')) {
      queueMicrotask(() => {
        void fetchData()
      })
    }
  }, [effectivePlan, fetchData, planLoading])

  // UNMOUNT-ABORT FIX, DISCLOSED (Base Radar speed audit): without this, navigating away mid-fetch
  // left the network request running to completion server-side (the backend still did the full
  // multi-token scoring work for a response nobody would ever read) and left setData/setLoading
  // calls pending against an unmounted component.
  useEffect(() => {
    return () => { abortControllerRef.current?.abort() }
  }, [])

  // VISIBILITY-PAUSE FIX, DISCLOSED (Base Radar speed audit): previously the countdown interval
  // kept ticking and triggering a full /api/radar refetch (the backend's multi-source fetch +
  // per-token scoring pipeline) every 120s regardless of whether the tab was visible — a
  // backgrounded/hidden tab still consumed a full radar cycle's worth of backend compute every 2
  // minutes for nobody to see. The countdown effect below simply skips decrementing while hidden
  // (freezing the countdown, not resetting it), so no separate "catch up" logic is needed here —
  // the countdown naturally resumes and fires on schedule once the tab is visible again.
  const isHiddenRef = useRef(false)
  useEffect(() => {
    function handleVisibilityChange() { isHiddenRef.current = document.hidden }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      if (isHiddenRef.current) return
      setCountdown(c => {
        if (c <= 1) {
          setRefreshKey(k => k + 1)
          return 120
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (refreshKey > 0 && canAccessFeature(effectivePlan, 'base-radar')) {
      queueMicrotask(() => {
        void fetchData()
        setCountdown(120)
      })
    }
  }, [effectivePlan, refreshKey, fetchData])

  function handleManualRefresh() {
    // Repeated rapid clicks no longer each open a new network request — fetchData() itself would
    // correctly abort-and-supersede them, but skipping outright avoids the redundant backend work
    // that abort-after-the-fact can't prevent (the server has already started scoring by the time
    // an abort signal reaches it).
    if (fetchInFlightRef.current) return
    setCountdown(120)
    fetchData()
  }

  function openToken(contract: string) {
    router.push(`/terminal/token-scanner?contract=${contract}`)
  }

  const handleDrawerSimulationUpdate = useCallback((address: string, payload: DrawerSimulationPayload) => {
    const normalizedAddress = address.toLowerCase()
    const mergeTokenEvidence = (token: RadarToken): RadarToken => {
      if (token.contract.toLowerCase() !== normalizedAddress) return token
      const buyTax = payload.buySellSimulation?.buyTax ?? null
      const sellTax = payload.buySellSimulation?.sellTax ?? null
      return {
        ...token,
        honeypot: {
          isHoneypot: payload.buySellSimulation?.isHoneypot ?? token.honeypot?.isHoneypot ?? null,
          buyTax,
          sellTax,
          simulationSuccess: payload.simulationStatus === 'passed' ? true : payload.buySellSimulation?.simulationSuccess ?? false,
        },
        simulationStatus: payload.simulationStatus,
        simulationReason: payload.simulationReason ?? null,
        simulationLabel: payload.simulationStatus === 'passed' && buyTax != null && sellTax != null
          ? `Simulation checked — B ${buyTax.toFixed(1)}% / S ${sellTax.toFixed(1)}%`
          : payload.simulationLabel ?? 'Simulation checked — inconclusive',
        simulationCortexLine: payload.simulationCortexLine ?? token.simulationCortexLine ?? null,
        evidenceGaps: payload.simulationStatus === 'passed'
          ? (token.evidenceGaps ?? []).filter((gap) => !/simulation|honeypot\/tax|buy\/sell/i.test(gap))
          : Array.from(new Set([...(token.evidenceGaps ?? []), 'Simulation checked but inconclusive'])),
      }
    }

    setData((prev) => prev ? { ...prev, tokens: prev.tokens.map((token) => enrichToken(mergeTokenEvidence(token))) } : prev)
    setSelectedToken((prev) => {
      if (!prev || prev.contract.toLowerCase() !== normalizedAddress) return prev
      return enrichToken(mergeTokenEvidence(prev))
    })
  }, [])

  function openProjectOverview(token: TokenIntel) {
    setSelectedToken(token)
    setDrawerOpen(true)
  }

  function preloadProjectOverview(token: TokenIntel) {
    setSelectedToken(prev => prev?.contract === token.contract ? prev : token)
  }

  function toggleTrack(contract: string) {
    setTrackedContracts(prev => ({ ...prev, [contract]: !prev[contract] }))
  }

  function askCortex(token: TokenIntel) {
    const buyTax = token.honeypot?.buyTax
    const sellTax = token.honeypot?.sellTax
    const security = token.simulationStatus === 'passed' ? 'Verified' : 'Unknown'
    const prompt = [
      '[mode: base-radar]',
      'Analyze this Base Radar token and give me a clear verdict: WATCH, PASS, or SCAN DEEPER.',
      `Token: ${token.name} (${token.symbol})`,
      `Contract: ${token.contract}`,
      `Radar Score: ${token.radarScore}`,
      `Status: ${token.status}`,
      `Liquidity: ${fmtUSD(token.liquidityUsd)}`,
      `Volume 24h: ${fmtUSD(token.volume24h)}`,
      `Market Cap: ${token.valuationBasis === 'verified_market_cap' ? fmtUSD(token.marketCapUsd ?? token.valuationUsd ?? 0) : 'Unverified'}`,
      `FDV: ${token.fdvUsd ? fmtUSD(token.fdvUsd) : 'Open check'}`,
      `Valuation: ${token.valuationBasis === 'verified_market_cap' ? 'Verified market cap' : token.valuationBasis === 'fdv_fallback' ? 'FDV fallback' : 'Unavailable'}`,
      ...(token.valuationCortexLine ? [`Note: ${token.valuationCortexLine}`] : []),
      `Momentum: ${token.momentum}`,
      `Buy Tax: ${token.simulationStatus === 'passed' && buyTax !== null && buyTax !== undefined ? `${buyTax.toFixed(1)}%` : 'Unknown'}`,
      `Sell Tax: ${token.simulationStatus === 'passed' && sellTax !== null && sellTax !== undefined ? `${sellTax.toFixed(1)}%` : 'Unknown'}`,
      `Simulation: ${token.simulationCortexLine ?? 'Buy/sell simulation status unavailable.'}`,
      `Security: ${security}`,
      `Flags: ${token.flags.length > 0 ? token.flags.join(', ') : 'None'}`,
      `CORTEX Signal: ${token.clarkVerdict ?? token.clarkSignal}`,
    ].join('\n')

    router.push(`/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}`)
  }

  const tokens = useMemo(() => data?.tokens ?? [], [data?.tokens])

  const intelTokens = useMemo(() => tokens.map(enrichToken), [tokens])

  const summary = useMemo<RadarSummary>(() => {
    const worthWatching = intelTokens.filter(token => token.status === 'HOT' || token.status === 'WATCH' || token.status === 'EARLY').length
    const highMomentum = intelTokens.filter(token => token.momentum === 'HIGH').length
    const unverified = intelTokens.filter(token => token.status === 'UNVERIFIED').length
    const averageLiquidity = intelTokens.length > 0 ? Math.round(intelTokens.reduce((sum, token) => sum + token.liquidityUsd, 0) / intelTokens.length) : 0
    const highestLiquidity = [...intelTokens].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
    const highestVolume = [...intelTokens].sort((a, b) => b.volume24h - a.volume24h)[0]
    const newest = [...intelTokens].sort((a, b) => a.ageMinutes - b.ageMinutes)[0]
    const hottest = [...intelTokens].sort((a, b) => b.radarScore - a.radarScore)[0]
    const hasSecurityData = intelTokens.some(token => token.simulationStatus === 'passed')

    return {
      newPools: intelTokens.length,
      worthWatching,
      highMomentum,
      unverified,
      averageLiquidity,
      highestLiquidityToken: getOverviewTokenTitle(highestLiquidity),
      highestLiquidityValue: highestLiquidity ? `${fmtUSD(highestLiquidity.liquidityUsd)} liquidity` : 'Needs data',
      highestVolumeToken: getOverviewTokenTitle(highestVolume),
      highestVolumeValue: highestVolume ? `${fmtUSD(highestVolume.volume24h)} volume` : 'Needs data',
      newestToken: getOverviewTokenTitle(newest),
      newestValue: newest ? `${fmtAge(newest.ageMinutes)} old` : 'Needs data',
      hottestToken: getOverviewTokenTitle(hottest),
      hottestValue: hottest ? `Score ${hottest.radarScore}` : 'Needs data',
      hasSecurityData,
    }
  }, [intelTokens])

  const filteredAndSortedTokens = useMemo(() => {
    const filtered = intelTokens.filter(token => {
      if (activeFilter === 'TRENDING') return token.status === 'HOT' || token.momentum === 'HIGH' || token.volume24h >= 5_000
      if (activeFilter === 'NEW') return token.ageMinutes <= 120 || token.status === 'EARLY'
      if (activeFilter === 'VOLUME') return token.volume24h >= 5_000 || token.momentum !== 'NONE'
      if (activeFilter === 'LIQUIDITY') return token.liquidityUsd >= 10_000
      if (activeFilter === 'RISK_WATCH') return token.status === 'RISKY' || token.status === 'UNVERIFIED' || token.simulationStatus !== 'passed'
      if (activeFilter === 'WATCHLIST') return token.radarScore >= 60 && token.status !== 'DEAD' && token.status !== 'RISKY'
      return true
    })

    const sorted = [...filtered]

    if (sortMode === 'NEWEST') sorted.sort((a, b) => a.ageMinutes - b.ageMinutes)
    if (sortMode === 'HIGHEST_SCORE') sorted.sort((a, b) => b.radarScore - a.radarScore)
    if (sortMode === 'HIGHEST_LIQUIDITY') sorted.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    if (sortMode === 'HIGHEST_VOLUME') sorted.sort((a, b) => b.volume24h - a.volume24h)
    if (sortMode === 'HIGHEST_MOMENTUM') sorted.sort((a, b) => b.momentumRatio - a.momentumRatio)

    return sorted
  }, [activeFilter, intelTokens, sortMode])

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!canAccessFeature(effectivePlan, 'base-radar')) return <LockedPanel feature="base-radar" />

  return (
    <>
      <style>{`
        @keyframes radarSlideIn {
          from { opacity: 0; transform: translateY(-10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(236,72,153,0.6); }
          50%       { opacity: 0.6; box-shadow: 0 0 0 5px rgba(236,72,153,0); }
        }
        @keyframes radarSpin {
          0%   { transform: rotate(0deg);   }
          100% { transform: rotate(360deg); }
        }
        @media (max-width: 768px) {
          .radar-main { padding: 18px 12px 120px !important; overflow-x: hidden !important; }
          .opportunity-card { border-radius: 16px !important; padding: 12px !important; }
          .radar-grid { grid-template-columns: 1fr !important; }
          .radar-stats { position: static !important; }
          .radar-controls { flex-direction: column !important; align-items: flex-start !important; }
          .radar-controls > div { width: 100%; justify-content: space-between; flex-wrap: wrap; }
          .radar-overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .radar-overview-card { padding: 12px !important; }
          .token-card-header { flex-direction: column !important; }
          .token-card-header span { max-width: 100%; }
          .token-card-header > div:last-child { width: 100%; }
          .token-card-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .token-card-actions { flex-direction: column !important; align-items: stretch !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .opportunity-card, .radar-mini-chart-svg *, .radar-main * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
        }
      `}</style>

      <div className="radar-main" style={{ minHeight: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '28px 32px 120px', color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)', background: 'radial-gradient(circle at 18% 0%, rgba(34,211,238,0.11), transparent 34%), radial-gradient(circle at 88% 12%, rgba(168,85,247,0.10), transparent 30%), #030712' }}>
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#f8fafc', margin: 0, letterSpacing: '-0.01em' }}>Base Radar</h1>

            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '99px', background: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.30)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#ec4899', fontFamily: 'var(--font-plex-mono)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ec4899', animation: 'livePulse 1.8s ease-in-out infinite', flexShrink: 0 }} />
              LIVE
            </span>
          </div>

          <p style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 12px', maxWidth: '720px', lineHeight: 1.45 }}>
            Live market discovery for Base tokens
          </p>
          <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 12px', maxWidth: '760px', lineHeight: 1.45, fontFamily: 'var(--font-plex-mono)' }}>
            Default feed filters out pools under $15K valuation and shallow liquidity. When verified market cap is unavailable, FDV is used only as a fallback and clearly labeled.
          </p>

          <div className="radar-pulse-wrap">
            <PulseStrip summary={summary} />
          </div>

          <div className="radar-controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{loading && tokens.length > 0 ? 'Refreshing radar…' : `Refresh in ${countdown}s`}</span>
              <button
                onClick={handleManualRefresh}
                disabled={loading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 12px', borderRadius: '8px', background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.20)', color: loading ? '#3a5268' : '#2DD4BF', fontSize: '10px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-plex-mono)' }}
              >
                <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round' style={{ animation: loading ? 'radarSpin 0.8s linear infinite' : 'none' }}>
                  <path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' />
                  <path d='M21 3v5h-5' />
                  <path d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' />
                  <path d='M8 16H3v5' />
                </svg>
                {loading ? (tokens.length > 0 ? 'Refreshing…' : 'Loading…') : 'Refresh'}
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em' }}>Sort</span>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '8px',
                  color: '#cbd5e1',
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  padding: '5px 9px',
                  textTransform: 'uppercase',
                  fontFamily: 'var(--font-plex-mono)',
                }}
              >
                {SORT_OPTIONS.map(opt => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
            {FILTER_CHIPS.map(chip => {
              const active = chip.key === activeFilter
              return (
                <button
                  key={chip.key}
                  onClick={() => setActiveFilter(chip.key)}
                  style={{
                    padding: '5px 9px',
                    borderRadius: '99px',
                    fontSize: '9px',
                    fontWeight: 700,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    border: `1px solid ${active ? 'rgba(45,212,191,0.35)' : 'rgba(255,255,255,0.10)'}`,
                    background: active ? 'rgba(45,212,191,0.12)' : 'rgba(255,255,255,0.03)',
                    color: active ? '#2DD4BF' : '#94a3b8',
                    fontFamily: 'var(--font-plex-mono)',
                    cursor: 'pointer',
                  }}
                >
                  {chip.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="radar-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: '18px', alignItems: 'start' }}>
          <div>
            <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 10px' }}>
              Live Feed {filteredAndSortedTokens.length > 0 && `— ${filteredAndSortedTokens.length} token${filteredAndSortedTokens.length !== 1 ? 's' : ''}`}
            </p>

            {error && (
              <div style={{ padding: '12px 14px', borderRadius: '10px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.20)', color: '#f87171', fontSize: '12px', marginBottom: '12px', fontFamily: 'var(--font-plex-mono)' }}>
                {error}
              </div>
            )}

            {loading && tokens.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <StagedRadarLoading />
                {[...Array(4)].map((_, i) => (
                  <div key={i} style={{ height: '120px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', animation: 'radarSlideIn 0.3s ease both', animationDelay: `${i * 80}ms` }} />
                ))}
              </div>
            )}

            {!loading && tokens.length === 0 && !error && <EmptyFeed limited={Boolean(data?.limitedLiveFeed)} />}

            {!loading && tokens.length > 0 && Boolean(data?.limitedLiveFeed) && (
              <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.20)', color: '#fbbf24', fontSize: '11px', marginBottom: '12px', fontFamily: 'var(--font-plex-mono)' }}>
                Radar data partial — some metrics unavailable. Showing {tokens.length} result{tokens.length === 1 ? '' : 's'}.
              </div>
            )}

            {!loading && tokens.length > 0 && filteredAndSortedTokens.length === 0 && (
              <div style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', padding: '16px', fontFamily: 'var(--font-plex-mono)', fontSize: '12px', color: '#64748b' }}>
                No pools match the current filter.
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {filteredAndSortedTokens.map((token, i) => (
                <TokenCard
                  key={token.contract}
                  token={token}
                  index={i}
                  onScan={() => openToken(token.contract)}
                  onAskCortex={() => askCortex(token)}
                  onOpenOverview={() => openProjectOverview(token)}
                  onTrackToggle={() => toggleTrack(token.contract)}
                  onPreload={() => preloadProjectOverview(token)}
                  tracking={Boolean(trackedContracts[token.contract])}
                />
              ))}
            </div>

            {!loading && filteredAndSortedTokens.length <= 2 && !error && <LowActivityPanel />}
          </div>

          <div className="radar-stats" style={{ position: 'sticky', top: '0' }}>
            <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 10px' }}>
              CORTEX Panel
            </p>
            <CortexRadarPanel summary={summary} topTokens={filteredAndSortedTokens} onRescan={handleManualRefresh} />
            <div style={{ height: '12px' }} />
            <StatsPanel summary={summary} fetchedAt={data?.fetchedAt ?? null} loading={loading} showUpsell={showUpsell} />
          </div>
        </div>
      </div>

      <ProjectOverviewDrawer
        token={selectedToken}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSimulationUpdate={handleDrawerSimulationUpdate}
      />
    </>
  )
}

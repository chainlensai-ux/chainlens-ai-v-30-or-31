'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import ProjectOverviewDrawer, { EXPLORER } from './ProjectOverviewDrawer'
import { usePlanWithLoading, LockedPanel, canAccessFeature, PlanGateSkeleton } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import { getRadarFeedStatusFromScore } from '@/lib/baseRadarFeedScoring'
import { buildBaseRadarDisplayModel, type BaseRadarDisplayModel } from '@/lib/baseRadarDisplayModel'
import { useDrawerPreload } from '@/lib/useDrawerPreload'
import { radarErrorMessage, radarHasVisibleFeed, radarTimeoutMessage, radarVisibleErrorFromPayload, radarStatTileMode, type RadarStatTileMode } from '@/lib/radarFeedStatus'

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
  // ESTABLISHED-CLASSIFICATION / HOLDER-EVIDENCE-HONESTY, DISCLOSED: isEstablished labels a
  // candidate above the $2M early-range ceiling (displayed, never hidden, for being above it).
  // holderVerified is false when this candidate's holder count couldn't be confirmed this cycle —
  // shown, but never implying a passed holder check. See getFlags for how these surface as badges.
  isEstablished?: boolean
  holderVerified?: boolean
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
  page?: number
  hasMore?: boolean
  // MAIN-FEED-QUALITY-GATE, DISCLOSED: count of candidates the backend's deterministic $80K-$2M
  // valuation band / 30-holder gate hid from this response (app/api/radar/route.ts's
  // hiddenLowEvidenceCount) — not the pre-existing liquidity/dead-volume filters. Optional/undefined on
  // any cached payload from before this field existed.
  hiddenLowEvidenceCount?: number
  // GATE-REASON-BREAKDOWN, DISCLOSED (requested: CORTEX panel should separate low valuation / low
  // holders / missing holder count / concentration unavailable instead of one combined number).
  // hiddenConcentrationUnavailable is informational only — concentration is never a hide reason
  // (see baseRadarCandidateGateAudit in app/api/radar/route.ts), it just counts displayed
  // candidates carrying that evidence gap.
  hiddenLowValuation?: number
  hiddenBelow80k?: number
  hiddenLowHolders?: number
  // $2M-IS-A-CLASSIFICATION-NOT-AN-EXCLUSION, DISCLOSED: hiddenHolderUnavailable is no longer a
  // hide reason either — a holder-unavailable candidate is displayed, labeled unverified (see
  // holderVerified on RadarToken) — this count is kept purely informational.
  hiddenHolderUnavailable?: number
  hiddenConcentrationUnavailable?: number
  aboveEarlyRangeCount?: number
  establishedDisplayedCount?: number
  holderProviderUnavailableCount?: number
  // DISCOVERY-DEPTH AUDIT, DISCLOSED: whether the holder-check budget was exhausted before the
  // checked pool ran out — distinguishes "checked everything, nothing passed" from "ran out of
  // budget before finishing" for the empty-state message (see EmptyFeed).
  holderCheckBudgetExhausted?: boolean
  holderProviderReachable?: boolean
  // FAILED-SOURCE-VS-GENUINELY-EMPTY, DISCLOSED: whether one or more GeckoTerminal discovery pages
  // failed this cycle (rate-limit/timeout/5xx, even after the backend's own retry) rather than the
  // raw pool genuinely being thin — see EmptyFeed's own header for the live capture that surfaced
  // this gap. discoveryDegradedSignificant (majority-or-more pages failed) is what actually drives
  // the empty-state message — a single failed page out of 18 shouldn't get blamed for an outcome
  // the deterministic gate caused; discoveryDegraded/sourcesFailedCount stay available for anyone
  // reading the raw payload/audit even when the failure wasn't significant enough to explain 0.
  discoveryDegraded?: boolean
  discoveryDegradedSignificant?: boolean
  sourcesFailedCount?: number
  baseRadarSourceAudit?: { sourcesAttempted?: number }
  baseRadarCandidateGateAudit?: { rawCandidatesFetched?: number }
  // TRUTHFUL EMPTY STATE, DISCLOSED (same fix already shipped for Pump Alerts, brought over here:
  // this route already computes finalState server-side — app/api/radar/route.ts's baseRadarFinalState
  // — but nothing in this file ever read it, so a total provider outage (every source failed) and
  // an honest "the gate found nothing this cycle" result both rendered through the same generic
  // EmptyFeed copy driven only by discoveryDegradedSignificant's ≥50%-failed threshold. A single-
  // source-configured deployment failing its one source is a real outage that never crosses that
  // 50% bar under the wrong denominator math, so it could still read as "just quiet" instead of
  // "providers are down." finalState is the same authoritative source EmptyFeed's other props are
  // already computed from, just not previously threaded through to it.
  finalState?: 'ok' | 'providerUnavailable' | 'allFilteredOut' | 'noRawCandidates'
  // BASE-RADAR-LOAD-AUDIT, DISCLOSED (required exact shape — see app/api/radar/route.ts's
  // baseRadarLoadAudit): userVisibleError is the literal error string EmptyFeed now renders instead
  // of a vague generic message; the rest of the shape is carried for completeness/future debugging
  // even though this page currently only reads userVisibleError/chainSlug/chainId from it.
  baseRadarLoadAudit?: {
    chainSlug?: string
    chainId?: number
    providerErrors?: { source: string; status: number | null; errorName: string | null; errorMessage: string | null }[]
    userVisibleError?: string | null
  }
  // LAST-GOOD-CACHE VISIBILITY, DISCLOSED: set only when this response is a re-served prior
  // successful payload because every live source failed this cycle (see the SERVE-STALE-ON-TOTAL-
  // FAILURE fallback in app/api/radar/route.ts) — lets the UI show a subtle "showing cached
  // results" note instead of presenting aging data as this cycle's fresh live fetch.
  servedFromStaleCache?: boolean
}

type RadarStatus = 'HOT' | 'WATCH' | 'EARLY' | 'UNVERIFIED' | 'RISKY' | 'DEAD'
type MomentumLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
type RadarFilter = 'TRENDING' | 'NEW' | 'VOLUME' | 'LIQUIDITY' | 'RISK_WATCH' | 'WATCHLIST'
type SortMode = 'NEWEST' | 'HIGHEST_SCORE' | 'HIGHEST_LIQUIDITY' | 'HIGHEST_VOLUME' | 'HIGHEST_MOMENTUM'

// CHAIN SELECTOR, DISCLOSED: both chains now run the same real feed — the original "UI/state only,
// no provider calls exist for Robinhood yet" scaffold (and its RobinhoodBetaState placeholder) is
// gone. 'robinhood' drives the identical discovery/gate/daily-pool pipeline as 'base', just pointed
// at GeckoTerminal's 'robinhood' network; see the ROBINHOOD-CHAIN-SUPPORT header comment in
// app/api/radar/route.ts. Robinhood remains gated behind isRobinhoodChainAvailable() on BOTH the
// selector and the API route.
type RadarChain = 'base' | 'robinhood'

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
  // CHAIN-ON-TOKEN, DISCLOSED (Robinhood Radar UI polish task): the raw RadarToken payload from
  // /api/radar doesn't carry a per-token chain field — chain is a page-level selection, not part of
  // each token record. Threaded through explicitly at enrichToken() time (which chain the feed was
  // fetched for) so per-token display logic (flags/status label/copy) can branch on it without
  // guessing or inventing a value.
  chain: RadarChain
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
  hiddenLowEvidenceCount: number
  hiddenLowValuation: number
  hiddenBelow80k: number
  hiddenLowHolders: number
  hiddenHolderUnavailable: number
  hiddenConcentrationUnavailable: number
}

// Real row shape from /api/watchlist/tokens (Supabase `watchlist_tokens` table) — same endpoint
// /terminal/watchlist and ClarkRadar already use, see the WATCHLIST disclosure below.
interface WatchlistTokenRow {
  address: string
  symbol: string | null
  name: string | null
  chain: string | null
  risk_label: string | null
  score: number | null
  score_type?: 'radar_score' | 'risk_score' | 'safety_score' | null
  score_direction?: 'higher_is_riskier' | 'higher_is_safer' | null
  saved_at?: string
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

// FILTER SIMPLIFICATION, DISCLOSED (Base Radar filter simplification task): FILTER_CHIPS/the
// underlying per-mode logic in filteredAndSortedTokens below are UNCHANGED and still fully wired —
// nothing was deleted. Only the main-view UI changed: NEW is now the one always-visible primary
// mode; VOLUME/LIQUIDITY are dropped from the visible chip row entirely since Sort already covers
// "order by volume/liquidity" (see SORT_OPTIONS) without needing a separate narrowing filter for
// them; TRENDING/RISK_WATCH/WATCHLIST move into the "Advanced Filters" popover (ADVANCED_FILTER_
// CHIPS) instead of sitting in the main row as equal-weight pills.
const FILTER_CHIPS: Array<{ key: RadarFilter; label: string }> = [
  { key: 'TRENDING', label: 'Trending' },
  { key: 'NEW', label: 'New' },
  { key: 'VOLUME', label: 'Volume' },
  { key: 'LIQUIDITY', label: 'Liquidity' },
  { key: 'RISK_WATCH', label: 'Risk Watch' },
  { key: 'WATCHLIST', label: 'Watchlist Candidates' },
]

const ADVANCED_FILTER_KEYS: RadarFilter[] = ['TRENDING', 'RISK_WATCH', 'WATCHLIST']
const ADVANCED_FILTER_CHIPS = FILTER_CHIPS.filter(chip => ADVANCED_FILTER_KEYS.includes(chip.key))

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: 'NEWEST', label: 'Newest' },
  { key: 'HIGHEST_SCORE', label: 'Strongest' },
  { key: 'HIGHEST_LIQUIDITY', label: 'Highest Liquidity' },
  { key: 'HIGHEST_VOLUME', label: 'Highest Volume' },
  { key: 'HIGHEST_MOMENTUM', label: 'Highest Momentum' },
]

// SPECIFIC-ERROR-MESSAGE FIX, DISCLOSED: radarErrorMessage / timeout / payload-aware copy live in
// lib/radarFeedStatus.ts so empty-feed "last available read" lies can be unit-tested. This page
// imports those helpers — do not reintroduce a local copy that ignores chain-switch clears.

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

// UNAVAILABLE-VS-OPEN-CHECK FIX, DISCLOSED (required fix: "Header should show 'Unavailable' for
// failed strongest mover/newest pool, not Open Check" — 'Open check' honestly means "we checked and
// genuinely found nothing to report," which is misleading when the real reason there's no candidate
// is that discovery providers failed this cycle, not that the market was quiet).
function getOverviewTokenTitle(token: TokenIntel | undefined, providersFailed = false): string {
  if (!token) return providersFailed ? 'Unavailable' : 'Open check'
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
  // HOLDER-EVIDENCE-CAPS-STATUS, DISCLOSED (explicitly requested: "Score should be capped or status
  // should remain unverified/watch" when holder count couldn't be confirmed). A candidate never
  // reaches HOT/EARLY/WATCH purely because everything else looks good if holder evidence is missing.
  const insufficientData = !hasEnoughMarketData || token.simulationStatus !== 'passed' || token.holderVerified === false

  if (insufficientData) return 'UNVERIFIED'
  if (token.volume24h <= 0 && token.ageMinutes > 30) return 'DEAD'
  if (score >= 80 && (momentum === 'HIGH' || momentum === 'MEDIUM')) return 'HOT'
  if (token.ageMinutes <= 30 && score >= 50) return 'EARLY'
  if (score >= 60) return 'WATCH'
  if (score < 40) return 'RISKY'
  return 'WATCH'
}

// STATUS-DISPLAY-LABEL, DISCLOSED (Robinhood Radar UI polish task, explicitly requested: "score
// label like Watch / Unverified / Coverage Limited... never show SAFE if safety checks are
// missing"): the underlying RadarStatus value (used everywhere else — filters, sorting, the
// existing STATUS_COLOR/BG/BORDER maps) is completely unchanged; this only maps the ON-CARD text
// label. For Robinhood, 'UNVERIFIED' displays as 'Coverage Limited' — same honest meaning (safety
// checks aren't confirmed), worded as a chain-coverage fact instead of a generic warning. RISKY/
// DEAD keep their real, unchanged label on every chain — a genuine risk signal must never be
// softened just because the chain also lacks simulation coverage.
function getStatusDisplayLabel(token: TokenIntel): string {
  if (token.chain === 'robinhood' && token.status === 'UNVERIFIED') return 'COVERAGE LIMITED'
  return token.status
}

function getCortexSignal(status: RadarStatus): string {
  const map: Record<RadarStatus, string> = {
    HOT: 'Strong early activity relative to liquidity. Worth watching closely, but still verify before entry.',
    WATCH: 'Fresh pool with some traction. Monitor liquidity and volume before making a move.',
    EARLY: 'Very new pool. Not enough history yet, but early activity is visible.',
    UNVERIFIED: 'Not enough verified market data yet. Treat as unconfirmed, not automatically reliable.',
    RISKY: 'Weak liquidity, poor activity, or tax/branding flags detected. Approach carefully.',
    DEAD: 'No meaningful trading activity detected yet. Likely inactive or too early.',
  }
  return map[status]
}

function getFlags(token: RadarToken, status: RadarStatus, momentum: MomentumLevel, suspiciousBranding: boolean, chain: RadarChain): string[] {
  const flags: string[] = []
  const isRobinhood = chain === 'robinhood'
  if (momentum === 'HIGH') flags.push('Momentum')
  if (token.ageMinutes <= 30) flags.push('New Pool')
  if (token.volume24h >= 5_000) flags.push('Volume Spike')
  // FLAG-MEANING BUG, DISCLOSED (full Base Radar audit): this was 'Liquidity Watch', styled amber/
  // warning in getBadgeStyle below (grouped with genuine caution flags like 'Tax check pending' and
  // 'Simulation pending') — but the trigger here is $30K+ liquidity, a POSITIVE signal, and
  // ProjectOverviewDrawer.tsx uses the exact same label 'Liquidity Watch' to mean the opposite
  // (liquidity BELOW the safety threshold). A token with strong liquidity was getting a warning-
  // colored badge that told users the opposite of what was actually true. Renamed to a distinct,
  // correctly-positive label so it can't collide with the drawer's real caution flag.
  if (token.liquidityUsd >= 30_000) flags.push('Liquidity Strong')
  // ROBINHOOD-COVERAGE-TERMINOLOGY, DISCLOSED (explicitly requested: Robinhood Radar UI polish —
  // "lots of yellow/orange pending evidence / simulation pending / unverified" made the feed look
  // broken, when the real reason is a genuine, honest chain-coverage limitation, not a failure).
  // On Robinhood, honeypot/tax simulation isn't provider-supported at all yet — 'Tax check
  // pending'/'Simulation pending' (worded like a temporary in-progress check) is replaced with
  // 'Safety Sim Unavailable' (a calmer, accurate "this chain doesn't have this coverage yet" chip,
  // styled neutral blue below, never green/"safe"). Base's wording/coloring is completely
  // unchanged — this only branches for token.chain === 'robinhood'.
  if (isRobinhood) {
    if (token.simulationStatus !== 'passed') flags.push('Safety Sim Unavailable')
    else flags.push('Simulation checked')
  } else {
    if (token.liquidityUsd < 2_000) flags.push('Tax check pending')
    if (token.simulationStatus === 'open_check') flags.push('Simulation pending')
    if (token.simulationStatus === 'passed') flags.push('Simulation checked')
  }
  if (suspiciousBranding) flags.push('CORTEX Watch')
  // Same coverage-terminology reasoning as above: on Robinhood, 'UNVERIFIED' status is virtually
  // always driven by the missing safety simulation, not a genuine "we don't have evidence yet"
  // gap — 'Coverage Limited' says that honestly without reading as a warning.
  if (status === 'UNVERIFIED') flags.push(isRobinhood ? 'Coverage Limited' : 'Pending Evidence')
  if (status === 'RISKY') flags.push('High Risk')
  // ESTABLISHED-CLASSIFICATION / HOLDER-EVIDENCE-HONESTY, DISCLOSED (explicitly requested: label
  // above-$2M candidates as "Established" instead of hiding them; UI must say holder proof is
  // unavailable this cycle instead of implying a passed holder check).
  if (token.isEstablished) flags.push('Established')
  if (token.holderVerified === false) flags.push('Holder Unverified')
  // NOT-RE-VERIFIED-VISIBILITY, DISCLOSED (found in a full Base Radar audit): a daily-pool token
  // that this cycle's discovery didn't rediscover is re-emitted with its last known-good liquidity/
  // volume/market-cap and an explicit 'Shown from earlier today — not re-verified this refresh'
  // evidence gap — but the feed cards never render evidenceGaps at all, so that honesty marker was
  // invisible on the card itself and the numbers read as freshly-confirmed. Surfaced as a real
  // badge so a carried-over row is visibly distinguishable from a live-verified one.
  if ((token.evidenceGaps ?? []).some(gap => gap.startsWith('Shown from earlier today'))) flags.push('Not Re-verified')

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

function enrichToken(token: RadarToken, chain: RadarChain): TokenIntel {
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
  // HOLDER-EVIDENCE-CAPS-STATUS-EVERY-BRANCH FIX, DISCLOSED (found during a full filter audit):
  // getStatus already caps status at UNVERIFIED when holderVerified is false, but that only runs on
  // the `simulation.status === 'passed'` branch. The far more common case — simulation still
  // pending — used getRadarFeedStatusFromScore instead, a pure score->status function with zero
  // awareness of holderVerified (confirmed: not referenced anywhere in lib/baseRadarFeedScoring.ts).
  // That let a holder-unverified token reach HOT/WATCH purely on liquidity/volume score and pass
  // the Watchlist tab's radarScore>=60 filter — exactly the "silently promoted as verified" outcome
  // the backend's own scoreRisk() was built to prevent server-side. Applied uniformly here instead
  // of duplicating the check into both status functions.
  const status = token.holderVerified === false
    ? 'UNVERIFIED'
    : displayModel.simulation.status !== 'passed' ? getRadarFeedStatusFromScore(radarScore) : getStatus(token, radarScore, momentum)

  return {
    ...token,
    chain,
    suspiciousBranding,
    momentum,
    momentumRatio,
    radarScore,
    status,
    flags: getFlags(token, status, momentum, suspiciousBranding, chain),
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

function getSignalInsight(token: TokenIntel): string {
  const needsScan = token.simulationStatus !== 'passed'
  const activeLiquidity = token.liquidityUsd >= 10_000
  const highVolume = token.volume24h >= 5_000
  const fresh = token.ageMinutes <= 30

  // ROBINHOOD-CARD-COPY, DISCLOSED (Robinhood Radar UI polish task, explicitly requested copy):
  // on Robinhood, `needsScan` is virtually always true (safety simulation isn't provider-supported
  // on this chain yet) — the generic "Needs Token Scanner confirmation before trusting risk" reads
  // like every single card failed a check. Chain-specific copy instead frames it as what it
  // honestly is: real market signal, with a known, named chain-coverage limitation — never implying
  // the token itself is unsafe or that the app is broken.
  if (token.chain === 'robinhood') {
    if (token.momentum === 'HIGH' || activeLiquidity || highVolume) return 'Market momentum detected. Some safety checks are unavailable on Robinhood Chain — scan token for deeper evidence.'
    if (fresh) return 'Live market signal found. Safety coverage is limited on Robinhood Chain — scan token for deeper evidence.'
    return token.displayModel.whyOnRadar || 'Live market signal found. Safety coverage is limited on Robinhood Chain.'
  }

  if (token.momentum === 'HIGH' && activeLiquidity) return `Volume is rising while liquidity remains active. ${needsScan ? 'Needs Token Scanner confirmation before trusting risk.' : 'Risk checks are visible, but keep monitoring holders and liquidity.'}`
  if (fresh && token.momentum !== 'NONE') return `Fresh momentum detected${activeLiquidity ? ' with active liquidity' : ''}. ${needsScan ? 'Holder and liquidity safety still need deeper scan.' : 'Still a watchlist candidate, not a confirmed safe token.'}`
  if (highVolume) return `High activity token with ${needsScan ? 'risk checks still open' : 'simulation checks visible'}. Review liquidity and holder context before acting.`
  if (token.status === 'RISKY' || token.status === 'UNVERIFIED') return `${needsScan ? 'Needs scan' : 'Open check'}: activity is visible, but unresolved risk signals keep this in watch mode.`
  if (activeLiquidity) return `Liquidity remains active with developing activity. Watchlist candidate, not a confirmed safe token.`
  return token.displayModel.whyOnRadar || 'Open check: radar placement comes from current liquidity, volume, and evidence signals.'
}

function getValuationCardMetric(token: TokenIntel): { label: string; value: string; sublabel?: string | null; accent?: string } {
  const valuation = token.displayModel.valuation
  return { label: valuation.label, value: valuation.valueUsd != null ? fmtUSD(valuation.valueUsd) : 'Open check', sublabel: valuation.sublabel, accent: valuation.status === 'verified' ? '#99f6e4' : valuation.status === 'fdv_fallback' ? '#fde68a' : undefined }
}

// PROFESSIONAL SIMPLIFICATION PASS, DISCLOSED (Base Radar professional simplification task):
// getPriorityAccent's semantic meaning is unchanged (same risk/momentum/score priority order,
// same colors) — only `glow` is no longer consumed by the redesigned card below (no more box-
// shadow glow), kept in the return type so nothing else calling this needs to change.
function getPriorityAccent(token: TokenIntel): { color: string; background: string; border: string; glow: string } {
  if (token.status === 'RISKY' || token.status === 'DEAD' || token.flags.includes('High Risk')) return { color: '#f87171', background: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.34)', glow: 'rgba(248,113,113,0.14)' }
  if (token.flags.some(flag => flag.includes('Pending Evidence') || flag === 'Simulation pending')) return { color: '#fbbf24', background: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.34)', glow: 'rgba(251,191,36,0.14)' }
  if (token.momentum === 'HIGH' || token.volume24h >= 5_000) return { color: '#2DD4BF', background: 'rgba(45,212,191,0.13)', border: 'rgba(45,212,191,0.36)', glow: 'rgba(45,212,191,0.16)' }
  if (token.radarScore >= 75) return { color: '#22d3ee', background: 'rgba(34,211,238,0.12)', border: 'rgba(34,211,238,0.34)', glow: 'rgba(34,211,238,0.15)' }
  return { color: STATUS_COLOR[token.status], background: STATUS_BG[token.status], border: STATUS_BORDER[token.status], glow: STATUS_BG[token.status] }
}

// MICRO-POLISH, DISCLOSED (Base Radar final micro-polish task #3 — "slightly calm red/yellow tag
// intensity, maintain caution meaning"): only the amber/red colors are dimmed a touch (lower
// background/border opacity, slightly muted text tone) — which tags count as caution/risk, and
// which flags exist at all, are completely unchanged.
// COVERAGE-CHIP-STYLING, DISCLOSED (Robinhood Radar UI polish task): 'Safety Sim Unavailable' and
// 'Coverage Limited' get their own neutral blue/slate treatment — distinct from both the green
// "confirmed good" bucket and the amber "in-progress/caution" bucket, since neither is a warning
// (nothing bad was found) nor a pass (nothing was confirmed safe either). Never green/"safe".
function getBadgeStyle(flag: string): { color: string; background: string; border: string } {
  if (['Momentum', 'Volume Spike', 'Simulation confirmed', 'Simulation checked', 'Liquidity Strong', 'Market Data Live'].includes(flag)) return { color: '#99f6e4', background: 'rgba(45,212,191,0.13)', border: 'rgba(45,212,191,0.30)' }
  if (['Safety Sim Unavailable', 'Coverage Limited', 'Chain Beta', 'Needs Token Scanner', 'Provider Degraded'].includes(flag)) return { color: '#93c5fd', background: 'rgba(96,165,250,0.09)', border: 'rgba(96,165,250,0.24)' }
  if (['Tax check pending', 'Simulation pending', 'Pending Evidence', 'Holder Unverified', 'Not Re-verified'].includes(flag)) return { color: '#e8cd8f', background: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.20)' }
  if (['High Risk', 'CORTEX Watch', 'Risk Detected'].includes(flag)) return { color: '#f2b8b8', background: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.20)' }
  return { color: '#bfdbfe', background: 'rgba(96,165,250,0.13)', border: 'rgba(96,165,250,0.30)' }
}

// FLAG PRIORITY, DISCLOSED (task #4 — "show max 2-3 most important tags; hide extra tags behind
// '+N'"): token.flags itself (getFlags above) is unchanged — same set, same meaning, same order
// they're computed in. This only decides which 2 are worth surface-level attention (risk/caution
// flags first, since those matter most to see before clicking in) versus quieter "+N" overflow.
const FLAG_PRIORITY = ['High Risk', 'Risk Detected', 'Pending Evidence', 'Coverage Limited', 'Holder Unverified', 'Not Re-verified', 'Tax check pending', 'Simulation pending', 'Safety Sim Unavailable', 'CORTEX Watch', 'Momentum', 'Volume Spike', 'Liquidity Strong', 'Market Data Live', 'Simulation checked', 'New Pool', 'Established']
function prioritizedFlags(flags: string[]): string[] {
  return [...flags].sort((a, b) => FLAG_PRIORITY.indexOf(a) - FLAG_PRIORITY.indexOf(b))
}

// COMPACT CARD REDESIGN, DISCLOSED (task #4/#5/#6): same data, same click behavior (Scan Token,
// Ask CORTEX, Add to Watchlist, open drawer, preload) — condensed to a 3-row layout (identity +
// score/status; inline liquidity/volume/market cap/momentum; one-line reason + tags + actions)
// instead of the previous avatar-header/boxed-metrics-grid/bordered-reason-box/badge-wall stack.
// No nested metric boxes, no separate "Why on radar" bordered box, no opportunity/stage pills —
// token.status already conveys what those redundantly restated.
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
  const { preload, registerPreloadTarget } = useDrawerPreload(token.contract, { liquidityUsd: token.liquidityUsd })
  const accent = getPriorityAccent(token)
  const identity = getTokenIdentity(token)
  const avatarText = (identity.symbol || identity.primary || '?').slice(0, 2).toUpperCase()
  const insight = getSignalInsight(token)
  const valuationDisplay = getValuationCardMetric(token)
  const orderedFlags = prioritizedFlags(token.flags)
  const visibleFlags = orderedFlags.slice(0, 2)
  const extraFlagCount = orderedFlags.length - visibleFlags.length

  return (
    <div
      className='opportunity-card'
      onClick={onOpenOverview}
      ref={registerPreloadTarget}
      onMouseEnter={() => { preload(); onPreload() }}
      onFocus={() => { preload(); onPreload() }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        background: 'rgba(255,255,255,0.025)',
        borderTop: '1px solid rgba(255,255,255,0.09)',
        borderRight: '1px solid rgba(255,255,255,0.09)',
        borderBottom: '1px solid rgba(255,255,255,0.09)',
        borderLeft: `3px solid ${accent.color}`,
        borderRadius: '10px',
        padding: '13px 15px',
        cursor: 'pointer',
      }}
    >
      {/* MICRO-POLISH, DISCLOSED (task #1/#2 — breathing room, rank/avatar/name alignment, score
          feeling integrated rather than a detached block): avatar centers against the FULL two-line
          name block (unchanged), and the score/status block now sits against a subtle left divider
          instead of floating with only whitespace separating it — same score/status values, just a
          visual connection to the row it belongs to. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
        <div style={{ width: '30px', height: '30px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10.5px', fontWeight: 800, color: '#e2e8f0', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)', fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}>
          {avatarText}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 }}>
            <span style={{ fontSize: '13.5px', fontWeight: 800, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{identity.primary}</span>
            <span style={{ fontSize: '10.5px', fontWeight: 700, color: '#64748b', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>{identity.symbol}</span>
          </div>
          <p style={{ margin: '3px 0 0', fontSize: '9.5px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            #{index + 1} · {shortAddr(token.contract)} · {fmtAge(token.ageMinutes)}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '11px', flexShrink: 0 }}>
          <div style={{ width: '1px', alignSelf: 'stretch', background: 'rgba(255,255,255,0.09)' }} />
          <div style={{ textAlign: 'right' }}>
            <p style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: accent.color, fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>{token.radarScore}</p>
            <p style={{ margin: '2px 0 0', fontSize: '8.5px', fontWeight: 800, color: accent.color, letterSpacing: '0.08em', fontFamily: 'var(--font-plex-mono)' }}>{getStatusDisplayLabel(token)}</p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px', fontSize: '11px', color: '#7c93a8', fontFamily: 'var(--font-plex-mono)' }}>
        <span>LIQ <b style={{ color: '#e2e8f0', fontWeight: 700 }}>{fmtUSD(token.liquidityUsd)}</b></span>
        <span>VOL <b style={{ color: '#e2e8f0', fontWeight: 700 }}>{fmtUSD(token.volume24h)}</b></span>
        <span>{valuationDisplay.label.toUpperCase()} <b style={{ color: '#e2e8f0', fontWeight: 700 }}>{valuationDisplay.value}</b></span>
        <span>MOM <b style={{ color: token.momentum === 'HIGH' ? '#99f6e4' : '#e2e8f0', fontWeight: 700 }}>{token.momentum === 'NONE' ? 'Open check' : token.momentum}</b></span>
      </div>

      <p style={{ margin: 0, fontSize: '11.5px', color: '#a3b4c4', lineHeight: 1.5 }}>{insight}</p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', minWidth: 0 }}>
          {visibleFlags.map(flag => {
            const badge = getBadgeStyle(flag)
            return <span key={flag} style={{ padding: '3px 7px', borderRadius: '99px', fontSize: '8.5px', fontWeight: 800, letterSpacing: '0.05em', color: badge.color, background: badge.background, border: `1px solid ${badge.border}`, fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{flag}</span>
          })}
          {extraFlagCount > 0 && <span style={{ fontSize: '9.5px', color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>+{extraFlagCount} more</span>}
        </div>
        <div className='token-card-actions' style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          <ActionButton label='Scan Token' variant='primary' onClick={onScan} />
          <ActionButton label='Ask CORTEX' variant='secondary' hint='Analyze with CORTEX' onClick={onAskCortex} />
          <ActionButton label={tracking ? 'Watching' : 'Watchlist'} variant='ghost' active={tracking} onClick={onTrackToggle} />
        </div>
      </div>
    </div>
  )
}

// SMALLER/CALMER ACTIONS, DISCLOSED (task #6 — "make actions smaller and cleaner"): same three
// actions, same click behavior (stopPropagation so the card's own onClick doesn't also fire),
// same primary/secondary/ghost hierarchy — just smaller footprint and no glow.
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
  const border = active ? 'rgba(45,212,191,0.35)' : isPrimary ? 'rgba(45,212,191,0.40)' : isGhost ? 'rgba(148,163,184,0.14)' : 'rgba(96,165,250,0.20)'
  const background = active ? 'rgba(45,212,191,0.14)' : isPrimary ? 'rgba(45,212,191,0.16)' : isGhost ? 'transparent' : 'rgba(255,255,255,0.03)'
  const color = disabled ? '#475569' : active ? '#2DD4BF' : isPrimary ? '#5eead4' : isGhost ? '#94a3b8' : '#cbd5e1'

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onClick()
      }}
      title={hint}
      disabled={disabled}
      style={{
        minHeight: '27px',
        padding: '5px 9px',
        borderRadius: '8px',
        fontSize: '9px',
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        border: `1px solid ${border}`,
        background,
        color,
        fontFamily: 'var(--font-plex-mono)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

// COMPACT SUMMARY STRIP, DISCLOSED (task #2 — replace the 6 large bordered stat cards with a
// single calmer strip showing only Tokens Tracked / Strongest Mover / Newest Pool / Evidence Gaps;
// Highest Volume and Liquidity Leader are dropped from this glanceable strip per the task's own
// list — both remain fully visible per-token in the feed below, nothing is lost, just not repeated
// at the top). One shared border/background instead of 6 separately glowing/blurred cards.
function StripStat({ label, value, caption, accent = '#e2e8f0' }: { label: string; value: string; caption: string; accent?: string }) {
  return (
    <div className="radar-strip-item">
      <p style={{ margin: '0 0 4px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.13em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{label}</p>
      <p title={value} style={{ margin: 0, fontSize: '13.5px', color: accent, fontWeight: 800, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</p>
      <p style={{ margin: '3px 0 0', fontSize: '10px', color: '#64748b', lineHeight: 1.25, fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{caption}</p>
    </div>
  )
}

// LOADING-READS-AS-EMPTY FIX, DISCLOSED: tileMode is checking while loading with no payload,
// unavailable when the fetch failed and nothing is on screen (never leave Checking… stuck after
// a failed refresh), and ready whenever this chain's data is present so background refreshes
// keep the last real numbers.
function PulseStrip({ summary, tileMode, chain }: { summary: RadarSummary; tileMode: RadarStatTileMode; chain: RadarChain }) {
  const isRobinhood = chain === 'robinhood'
  const placeholder = (caption: string) => [
    { label: 'Tokens Tracked', value: '–', caption, accent: '#3a5268' },
    { label: 'Strongest Mover', value: '–', caption, accent: '#3a5268' },
    { label: 'Newest Pool', value: '–', caption, accent: '#3a5268' },
    { label: 'Evidence Gaps', value: '–', caption, accent: '#3a5268' },
  ]
  const items = tileMode === 'checking'
    ? placeholder('Checking…')
    : tileMode === 'unavailable'
    ? placeholder('Unavailable')
    : [
      // CHAIN-AWARE-CAPTION FIX, DISCLOSED (found while polishing Robinhood Radar): this caption
      // read "Current Base results" unconditionally, even while viewing Robinhood Chain — a real,
      // pre-existing labeling bug, not something this task introduced.
      { label: 'Tokens Tracked', value: String(summary.newPools), caption: `Current ${isRobinhood ? 'Robinhood Chain' : 'Base'} results`, accent: '#e2e8f0' },
      { label: 'Strongest Mover', value: summary.hottestToken, caption: summary.hottestValue, accent: '#2DD4BF' },
      { label: 'Newest Pool', value: summary.newestToken, caption: summary.newestValue, accent: '#60a5fa' },
      // ROBINHOOD-COVERAGE-STRIP, DISCLOSED (Robinhood Radar UI polish task): same underlying count
      // (summary.unverified), relabeled + recolored calm blue on Robinhood — most of that count is
      // driven by the known chain-coverage gap (missing safety simulation), not open evidence work.
      isRobinhood
        ? { label: 'Coverage Limited', value: String(summary.unverified), caption: 'Safety sim unavailable', accent: '#22d3ee' }
        : { label: 'Evidence Gaps', value: String(summary.unverified), caption: 'Needs more evidence', accent: '#fbbf24' },
    ]

  return (
    <div className="radar-strip">
      {items.map((item) => (
        <StripStat key={item.label} {...item} />
      ))}
    </div>
  )
}

// QUICK-PREVIEW-PANEL, DISCLOSED (Radar token detail UX polish task, explicitly requested: "the
// side panel should be a quick preview, not the full intelligence report... cramped and less
// impressive because the report is too large for the panel width"). Replaces the OLD behavior of
// clicking a card immediately opening the full ProjectOverviewDrawer (narrow, but crammed with
// every section) — this now opens first: a short, skimmable summary built entirely from data
// already resolved client-side in TokenIntel (score/status/flags/liquidity/volume/valuation/
// clarkSignal) with zero new fetches, zero new evidence, zero changed values. "Open Full Report"
// hands off to the exact same ProjectOverviewDrawer used before, just rendered in mode="full"
// (see that file's own disclosure) instead of skipping straight to it.
function QuickPreviewPanel({
  token,
  chain,
  open,
  tracking,
  onTrackToggle,
  onScan,
  onOpenFullReport,
  onClose,
}: {
  token: TokenIntel
  chain: RadarChain
  open: boolean
  tracking: boolean
  onTrackToggle: () => void
  onScan: () => void
  onOpenFullReport: () => void
  onClose: () => void
}) {
  const accent = getPriorityAccent(token)
  const valuationDisplay = getValuationCardMetric(token)
  const isRobinhood = chain === 'robinhood'
  // Same positive/risk flag vocabulary already established for feed cards (getBadgeStyle/
  // FLAG_PRIORITY) — "top risk"/"top positive" just pick the single highest-priority match from
  // token.flags instead of showing all of them, since this panel is meant to be skimmed in
  // seconds, not read section by section (that's what Open Full Report is for).
  const riskFlag = token.flags.find(f => ['High Risk', 'Risk Detected', 'CORTEX Watch'].includes(f))
  const positiveFlag = token.flags.find(f => ['Momentum', 'Volume Spike', 'Liquidity Strong', 'Simulation checked', 'Market Data Live', 'Established'].includes(f))
  const nextAction = token.simulationStatus !== 'passed'
    ? (isRobinhood ? 'Safety simulation unavailable on Robinhood Chain — open the full report for liquidity/holder evidence.' : 'Scan Token for full safety evidence before trusting this signal.')
    : 'Review LP and holder evidence in the full report before acting.'
  const explorer = EXPLORER[chain]

  // WHOLE-PAGE-UNCLICKABLE FIX, DISCLOSED (reported: "cant scroll or anything even click buttons
  // cant click on the token"): this component previously always mounted its fixed, full-viewport
  // backdrop <div> whenever a token was selected — including merely HOVERING a card, since
  // preloadProjectOverview sets selectedToken on hover, not just on click — relying purely on
  // pointerEvents:'none' to make it inert while closed. Something in that always-mounted-but-
  // toggled-inert approach was leaving an invisible, full-page click-blocking layer in place even
  // though nothing was visibly open (matches the report exactly: the feed rendered normally, but
  // nothing on the page responded to clicks or scroll). Hardened by simply not rendering the
  // backdrop/panel DOM at all unless actually open — trades the panel's slide-out close animation
  // (now closes instantly) for a guarantee that a closed preview can never intercept a single
  // pointer event on the rest of the page.
  if (!open) return null

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.55)', backdropFilter: 'blur(3px)', zIndex: 70 }} />
      <aside role="dialog" aria-modal="true" aria-label={`${token.name} quick preview`} style={{
        position: 'fixed', top: 0, right: 0, height: '100dvh', width: 'min(360px, 100vw)',
        transform: open ? 'translateX(0)' : 'translateX(105%)', transition: 'transform 0.16s cubic-bezier(.22,1,.36,1)',
        zIndex: 80, background: 'linear-gradient(180deg, #07111f, #020617 58%)',
        borderLeft: `1px solid ${accent.color}2e`, boxShadow: '-20px 0 52px rgba(0,0,0,0.4)',
        color: '#e2e8f0', overflowY: 'auto', padding: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '14px' }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{token.name}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
              <span style={{ fontSize: '10.5px', fontWeight: 700, color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>{token.symbol}</span>
              <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '8.5px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: isRobinhood ? '#d7fe04' : '#5eead4', background: isRobinhood ? 'rgba(215,254,4,0.10)' : 'rgba(45,212,191,0.10)', border: `1px solid ${isRobinhood ? 'rgba(215,254,4,0.30)' : 'rgba(45,212,191,0.30)'}`, fontFamily: 'var(--font-plex-mono)' }}>{isRobinhood ? 'Robinhood' : 'Base'}</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close preview" style={{ all: 'unset', cursor: 'pointer', color: '#64748b', fontSize: '18px', lineHeight: 1, padding: '2px', flexShrink: 0 }}>×</button>
        </div>

        {/* Score + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '12px', background: `${accent.color}0f`, border: `1px solid ${accent.color}30`, marginBottom: '10px' }}>
          <p style={{ margin: 0, fontSize: '26px', fontWeight: 800, color: accent.color, fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>{token.radarScore}</p>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em', color: accent.color, fontFamily: 'var(--font-plex-mono)' }}>{getStatusDisplayLabel(token)}</p>
            <p style={{ margin: '2px 0 0', fontSize: '9.5px', color: '#5b7186', fontFamily: 'var(--font-plex-mono)' }}>#{shortAddr(token.contract)} · {fmtAge(token.ageMinutes)}</p>
          </div>
        </div>

        {/* Top risk / top positive — 1-2 line summaries, not full evidence sections */}
        <div style={{ display: 'grid', gap: '7px', marginBottom: '10px' }}>
          <div style={{ padding: '9px 11px', borderRadius: '10px', background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.16)' }}>
            <p style={{ margin: '0 0 2px', fontSize: '8.5px', fontWeight: 800, letterSpacing: '0.10em', color: '#f2b8b8', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Top Risk</p>
            <p style={{ margin: 0, fontSize: '11px', color: '#e2e8f0', lineHeight: 1.4 }}>{riskFlag ?? 'No confirmed risk signal this cycle.'}</p>
          </div>
          <div style={{ padding: '9px 11px', borderRadius: '10px', background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.16)' }}>
            <p style={{ margin: '0 0 2px', fontSize: '8.5px', fontWeight: 800, letterSpacing: '0.10em', color: '#99f6e4', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Top Positive</p>
            <p style={{ margin: 0, fontSize: '11px', color: '#e2e8f0', lineHeight: 1.4 }}>{positiveFlag ?? 'No standout positive signal yet.'}</p>
          </div>
        </div>

        {/* Market snapshot — one compact row, not the full Market Snapshot section */}
        <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: '10px' }}>
          <p style={{ margin: '0 0 6px', fontSize: '8.5px', fontWeight: 800, letterSpacing: '0.10em', color: '#5b7186', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Market Snapshot</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px', fontSize: '10.5px', color: '#7c93a8', fontFamily: 'var(--font-plex-mono)' }}>
            <span>LIQ <b style={{ color: '#e2e8f0', fontWeight: 700 }}>{fmtUSD(token.liquidityUsd)}</b></span>
            <span>VOL <b style={{ color: '#e2e8f0', fontWeight: 700 }}>{fmtUSD(token.volume24h)}</b></span>
            <span>{valuationDisplay.label.toUpperCase()} <b style={{ color: '#e2e8f0', fontWeight: 700 }}>{valuationDisplay.value}</b></span>
          </div>
        </div>

        {/* Next action — one line, same spirit as the feed card's insight text */}
        <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(34,211,238,0.05)', border: '1px solid rgba(34,211,238,0.18)', marginBottom: '14px' }}>
          <p style={{ margin: '0 0 3px', fontSize: '8.5px', fontWeight: 800, letterSpacing: '0.10em', color: '#7dd3fc', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Next Action</p>
          <p style={{ margin: 0, fontSize: '11px', color: '#a5f3fc', lineHeight: 1.4 }}>{nextAction}</p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
          <ActionButton label="Scan Token" variant="primary" onClick={onScan} />
          <a href={explorer} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', minHeight: '27px', padding: '5px 9px', borderRadius: '8px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', border: '1px solid rgba(96,165,250,0.20)', background: 'rgba(255,255,255,0.03)', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', display: 'inline-flex', alignItems: 'center' }}>Open Explorer</a>
          <ActionButton label={tracking ? 'Watching' : 'Watchlist'} variant="ghost" active={tracking} onClick={onTrackToggle} />
        </div>

        <button
          onClick={onOpenFullReport}
          style={{ width: '100%', padding: '11px', borderRadius: '10px', border: '1px solid rgba(45,212,191,0.30)', background: 'rgba(45,212,191,0.10)', color: '#5eead4', fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer' }}
        >
          Open Full Report →
        </button>
      </aside>
    </>
  )
}

function CortexRadarPanel({ summary, topTokens, onRescan, chain }: { summary: RadarSummary; topTokens: TokenIntel[]; onRescan: () => void; chain: RadarChain }) {
  const isRobinhood = chain === 'robinhood'
  const signals = [
    summary.highMomentum > 0 ? `${summary.highMomentum} momentum signal${summary.highMomentum === 1 ? '' : 's'} in the current feed.` : 'Momentum is still forming across the visible feed.',
    summary.worthWatching > 0 ? `${summary.worthWatching} token${summary.worthWatching === 1 ? '' : 's'} have enough traction to watch.` : 'No strong watch cluster yet; keep radar open.',
    topTokens[0] ? `${topTokens[0].symbol} is leading the current radar score.` : 'Open check: no lead token yet.',
    summary.averageLiquidity > 0 ? `Average visible liquidity is ${fmtUSD(summary.averageLiquidity)}.` : 'Liquidity evidence is still an open check.',
  ]
  // MAIN-FEED-QUALITY-GATE, DISCLOSED (requested: stricter main-feed gate — $80K minimum valuation,
  // 30 minimum holders — explained on the CORTEX panel, count shown only when the gate actually hid
  // something this cycle so the panel doesn't add a permanently-noisy line for an empty case).
  // Wording updated (requested: clarify that holder COUNT and holder CONCENTRATION are different —
  // a passing 30+ holder count does not mean top1/10/20 concentration was checked) and the hidden-
  // count line now names all three real hide reasons (low valuation, low holders, missing holder
  // count) instead of the earlier two-reason phrasing.
  // GATE-REASON-BREAKDOWN, DISCLOSED (requested: separate low valuation / low holders / missing
  // holder count instead of one combined number, and make explicit that concentration gaps never
  // remove a candidate that already passed the real 30-holder count gate).
  // $2M-IS-A-CLASSIFICATION-NOT-AN-EXCLUSION, DISCLOSED (explicit product change, superseding the
  // earlier "Base Radar deterministic valuation band only" $80K-$2M reset: a live audit showed the
  // $2M ceiling zeroing out the one candidate that had cleared $80K before holders were ever
  // checked. $2M no longer hides anything — it's a label). hideReasonParts now only lists REAL
  // exclusion reasons (below $80K, a real resolved holder count under 30) — above-$2M and holder-
  // unavailable are no longer hide reasons, so they're removed from this list; a candidate in
  // either state is still displayed, just labeled Established / holder-unverified respectively.
  // THRESHOLD UPDATE $80K/$2M/30 -> $50K/$4M/60 -> $50K/$5M/30, DISCLOSED (explicitly requested,
  // holder minimum lowered back to 30 after the 60-holder bar was found to be systematically
  // filtering out the variety being asked for). Field names (hiddenBelow80k etc.) are unchanged on
  // the backend/frontend data shape — only the displayed numbers moved, to avoid an unnecessary
  // rename ripple across both files.
  const hideReasonParts = [
    summary.hiddenBelow80k > 0 ? `${summary.hiddenBelow80k} below $50K valuation` : null,
    summary.hiddenLowHolders > 0 ? `${summary.hiddenLowHolders} below 30 holders` : null,
  ].filter((p): p is string => p != null)
  const gateExplainer = hideReasonParts.length > 0
    ? `New Radar requires $50K+ valuation and real liquidity. Tokens above the early range are labelled Established instead of hidden — ${hideReasonParts.join(', ')}.`
    : 'New Radar requires $50K+ valuation and real liquidity. Tokens above the early range are labelled Established instead of hidden.'
  const concentrationNote = 'Concentration gaps do not remove candidates that pass holder count.'
  // ROBINHOOD-CORTEX-PANEL, DISCLOSED (Robinhood Radar UI polish task, explicitly requested: "make
  // the right panel explain the situation clearly... instead of making it sound like 11 failures").
  // Same underlying facts as the Base warnings list (evidence-gap count, gate explainer, "use Token
  // Scanner") — reframed as a chain-coverage explanation with its own calmer bullet color, not
  // reusing the amber "warning" styling below (nothing failed; this chain genuinely doesn't have
  // simulation coverage yet, a fact, not a caution).
  const robinhoodNotes = [
    'Market discovery active.',
    'Liquidity data detected.',
    'Safety simulation unavailable for Robinhood Chain.',
    'Use Token Scanner for deeper checks.',
  ]
  const warnings = [
    summary.unverified > 0 ? `${summary.unverified} checks need more evidence.` : 'No open verification cluster in the current results.',
    summary.hasSecurityData ? 'Simulation is confirmed for some tokens; unresolved tokens are capped until checks complete.' : 'Simulation checks need more evidence.',
    gateExplainer,
    concentrationNote,
    'Use Token Scanner before acting on any radar signal.',
  ]

  // MICRO-POLISH, DISCLOSED (task #4 — "reduce yellow warning intensity slightly, improve bullet
  // spacing/readability, keep warning content unchanged"): warning text/dots dimmed one more notch
  // (#c9a86a -> #a89268) and given more breathing room (gap/line-height up slightly) — the warning
  // strings themselves, and the signals above them, are byte-for-byte unchanged.
  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '13px' }}>
      <p style={{ margin: '0 0 3px', color: '#5eead4', fontSize: '10px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>CORTEX Radar Read</p>
      <p style={{ margin: '0 0 11px', color: '#64748b', fontSize: '10.5px', lineHeight: 1.4 }}>
        {isRobinhood
          ? `${summary.newPools} token${summary.newPools === 1 ? '' : 's'} found. Market/liquidity data is live. Some safety simulations are unavailable for Robinhood Chain.`
          : 'Live interpretation of the visible feed. Not financial advice.'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', marginBottom: '12px' }}>
        {signals.slice(0, 4).map(signal => (
          <div key={signal} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', color: '#94a3b8', fontSize: '10.5px', lineHeight: 1.5 }}>
            <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#2DD4BF', flexShrink: 0, marginTop: '6px' }} />
            <span>{signal}</span>
          </div>
        ))}
      </div>
      {isRobinhood && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '10px', marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
          {robinhoodNotes.map(note => (
            <div key={note} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', color: '#7dd3fc', fontSize: '10.5px', lineHeight: 1.5 }}>
              <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#22d3ee', flexShrink: 0, marginTop: '6px' }} />
              <span>{note}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
        {warnings.slice(0, 5).map(warning => (
          <div key={warning} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', color: '#a89268', fontSize: '10.5px', lineHeight: 1.5 }}>
            <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#a89268', flexShrink: 0, marginTop: '6px' }} />
            <span>{warning}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '12px' }}>
        <Link href="/terminal/token-scanner" style={{ textDecoration: 'none', padding: '6px 9px', borderRadius: '8px', border: '1px solid rgba(45,212,191,0.24)', background: 'rgba(45,212,191,0.08)', color: '#5eead4', fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.06em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>Open Token Scanner</Link>
        <button onClick={onRescan} style={{ padding: '6px 9px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.10)', background: 'transparent', color: '#94a3b8', fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.06em', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase', cursor: 'pointer' }}>Rescan</button>
      </div>
    </div>
  )
}

// WATCHLIST PANEL, DISCLOSED (requested: "fully functional" watchlist on the CORTEX panel): reads
// the real watchlistTokens state (backed by /api/watchlist/tokens — see the WATCHLIST disclosure on
// that state in BaseRadarPage). Clicking a saved token opens its live drawer if it's in the current
// feed, otherwise routes to Token Scanner for a direct lookup (never fabricates feed data for a
// token that isn't currently on radar). Remove calls the same real DELETE endpoint.
function WatchlistPanel({ tokens, loading, onOpen, onRemove }: { tokens: WatchlistTokenRow[]; loading: boolean; onOpen: (address: string) => void; onRemove: (address: string) => void }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '13px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <p style={{ margin: 0, color: '#94a3b8', fontSize: '10px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Watchlist</p>
        {tokens.length > 0 && <span style={{ fontSize: '10px', color: '#5b7186', fontFamily: 'var(--font-plex-mono)' }}>{tokens.length}</span>}
      </div>

      {loading ? (
        <p style={{ margin: 0, fontSize: '10.5px', color: '#5b7186' }}>Loading…</p>
      ) : tokens.length === 0 ? (
        <p style={{ margin: 0, fontSize: '10.5px', color: '#5b7186', lineHeight: 1.5 }}>
          No tokens watched yet. Click Watchlist on any token below to save it here.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '6px' }}>
          {tokens.slice(0, 8).map(t => (
            <div key={t.address} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <button
                onClick={() => onOpen(t.address)}
                style={{ all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: '6px' }}
              >
                <span style={{ fontSize: '11px', fontWeight: 800, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.symbol || shortAddr(t.address)}
                </span>
                {t.score != null && <span style={{ fontSize: '9.5px', color: '#5eead4', fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}>{t.score}</span>}
              </button>
              <button
                onClick={() => onRemove(t.address)}
                aria-label={`Remove ${t.symbol ?? shortAddr(t.address)} from watchlist`}
                style={{ all: 'unset', cursor: 'pointer', color: '#64748b', fontSize: '13px', lineHeight: 1, padding: '2px', flexShrink: 0 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {tokens.length > 0 && (
        <Link href="/terminal/watchlist" style={{ display: 'inline-block', marginTop: '10px', fontSize: '9.5px', color: '#5eead4', fontFamily: 'var(--font-plex-mono)', textDecoration: 'none', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          View Full Watchlist →
        </Link>
      )}
    </div>
  )
}

function StatsPanel({ summary, fetchedAt, loading, showUpsell }: { summary: RadarSummary; fetchedAt: string | null; loading: boolean; showUpsell: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* DECORATIVE RING REMOVED, DISCLOSED (task #7/#8 — "calmer", "less neon"): the spinning-
          look dashed ring + glow here carried no data, purely decorative "cyber-noise" per the
          task's own framing. Stat list below is unchanged. */}
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '13px' }}>
        <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 10px' }}>
          Radar Stats
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
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

// EMPTY-STATE-REASON, DISCLOSED (requested: a more useful empty message than a generic "try
// refreshing" — differentiate "checked everything, nothing passed the gate" from "ran out of
// holder-check budget before finishing the checked pool"). Sourced from the same audit fields the
// backend already computes (app/api/radar/route.ts's baseRadarCandidateGateAudit) — this never
// re-derives a reason, it only picks which of the two real outcomes actually happened.
// DISCOVERY-DEGRADED DISTINCTION, DISCLOSED (found during a full-pipeline audit: a live capture
// showed raw candidates drop from ~200-360 to 72 in one cycle, several GeckoTerminal source pages
// failing under this route's 18-way concurrent burst — rate-limit/timeout, not real end-of-data —
// with no way to tell that apart from "the market genuinely has nothing right now" in the UI). A
// degraded-discovery empty cycle now says so explicitly instead of implying nothing is out there.
// SIGNIFICANT-DEGRADATION WORDING, DISCLOSED (explicitly requested: "Only show degraded empty
// state if all/most source pages fail" + exact wording "Radar source degraded — X/Y pages
// loaded."). Only fires when discoveryDegradedSignificant (majority-or-more pages failed) — a
// single failed page out of 18 combined with a legitimate 0-token gate result no longer gets
// mislabeled as a source outage.
function EmptyFeed({ limited, holderCheckBudgetExhausted, discoveryDegradedSignificant, sourcesFailedCount, pagesAttempted, rawCandidatesRecovered, finalState, userVisibleError }: { limited: boolean; holderCheckBudgetExhausted: boolean; discoveryDegradedSignificant: boolean; sourcesFailedCount: number; pagesAttempted: number; rawCandidatesRecovered: number; finalState?: 'ok' | 'providerUnavailable' | 'allFilteredOut' | 'noRawCandidates'; userVisibleError?: string | null }) {
  const pagesLoaded = Math.max(0, pagesAttempted - sourcesFailedCount)
  // TRUTHFUL EMPTY STATE, DISCLOSED (same fix as Pump Alerts): finalState is authoritative — it is
  // computed server-side from the exact same counters (sourcesSucceeded/rawTotalBeforeDedupe/
  // tokens.length) this component's other props already come from, so it can never disagree with
  // them. Checked first so a real provider outage or a genuinely empty raw pool is never described
  // as "no candidates passed the gate" — a message that reads as an honest quiet market, not a
  // problem, when the real story is "the providers never returned anything to filter."
  // EXACT-ERROR FIX, DISCLOSED (required fix: "If all fail, show exact provider error, not vague
  // 'Open check'/'Providers failed'"): userVisibleError comes straight from the backend's
  // baseRadarLoadAudit.userVisibleError, which names the actual failing source and its real error
  // message/status — the vague generic sentence is now only a fallback for the (should-be-rare)
  // case the backend didn't send one.
  const headline = finalState === 'providerUnavailable'
    ? (userVisibleError ?? 'Providers failed — could not reach discovery sources for this chain.')
    : finalState === 'noRawCandidates'
      ? 'No candidates found — providers returned zero pools this cycle.'
      : discoveryDegradedSignificant
        ? `Radar source degraded — ${pagesLoaded}/${pagesAttempted} pages loaded${rawCandidatesRecovered > 0 ? ` (${rawCandidatesRecovered} raw candidates recovered from the loaded pages, none cleared the gate)` : ' (no candidates recovered)'}. Try refresh.`
        : holderCheckBudgetExhausted
          ? 'Holder-check budget reached for this cycle.'
          : 'No candidates passed the $50K+ valuation / real liquidity gate in this cycle.'
  return (
    <div style={{ textAlign: 'center', padding: '42px 20px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', border: '1px solid rgba(148,163,184,0.12)', borderRadius: '16px', background: 'rgba(255,255,255,0.025)' }}>
      <div style={{ fontSize: '30px', marginBottom: '12px', opacity: 0.45 }}>◈</div>
      <p style={{ fontSize: '14px', fontWeight: 800, margin: '0 0 8px', color: '#cbd5e1' }}>
        {finalState === 'providerUnavailable' || finalState === 'noRawCandidates' ? 'Radar could not load this cycle.' : 'No strong radar candidates right now.'}
      </p>
      <p style={{ fontSize: '12px', fontWeight: 600, margin: 0, lineHeight: 1.45 }}>{headline}</p>
      {finalState === 'providerUnavailable' || finalState === 'noRawCandidates'
        ? <p style={{ fontSize: '11px', fontWeight: 600, margin: '6px 0 0', lineHeight: 1.4, color: '#3a5268' }}>This is a provider issue, not a filtering result — try refreshing shortly.</p>
        : limited ? <p style={{ fontSize: '11px', fontWeight: 600, margin: '6px 0 0', lineHeight: 1.4, color: '#3a5268' }}>Live feed is limited right now.</p> : null}
    </div>
  )
}

function LowActivityPanel() {
  return (
    <div style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', padding: '14px 16px', fontFamily: 'var(--font-plex-mono)', marginTop: '10px' }}>
      <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
        Radar is quiet right now. New pools will appear here as Market Data detects them.
      </p>
    </div>
  )
}

const RADAR_CHAINS: Array<{ key: RadarChain; label: string }> = [
  { key: 'base', label: 'Base' },
  { key: 'robinhood', label: 'Robinhood' },
]

// CHAIN SELECTOR, DISCLOSED: compact segmented control, Base selected by default. BOTH Base and
// Robinhood pills always render (hard reload previously flashed Base-only until chain-status
// hydrated). Robinhood is disabled — never omitted — until ENABLE_ROBINHOOD_CHAIN=true AND
// ALCHEMY_ROBINHOOD_RPC_URL is confirmed via /api/base-radar/chain-status (that route never
// returns the RPC URL). Uses /logos/base.png and a small inline SVG feather for Robinhood.
function ChainSelector({ value, onChange, robinhoodAvailable }: { value: RadarChain; onChange: (chain: RadarChain) => void; robinhoodAvailable: boolean }) {
  // Always render BASE + ROBINHOOD on first paint. Hiding Robinhood behind a client-only
  // availability flag (false until /api/base-radar/chain-status hydrates) dropped the second
  // pill on hard reload. Gate by disabling, never by omitting.
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', padding: '3px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {RADAR_CHAINS.map(chain => {
        const active = chain.key === value
        const disabled = chain.key === 'robinhood' && !robinhoodAvailable
        return (
          <button
            key={chain.key}
            type="button"
            disabled={disabled}
            onClick={() => { if (!disabled) onChange(chain.key) }}
            aria-pressed={active}
            aria-disabled={disabled}
            title={disabled ? 'Robinhood Chain is not available yet' : undefined}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '5px 11px', borderRadius: '8px', border: 'none',
              background: active ? 'rgba(45,212,191,0.14)' : 'transparent',
              color: active ? '#5eead4' : '#94a3b8',
              fontSize: '10px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
              fontFamily: 'var(--font-plex-mono)', cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.45 : 1,
            }}
          >
            {chain.key === 'base' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/logos/base.png" alt="" width={14} height={14} style={{ borderRadius: '50%', display: 'block' }} />
            ) : (
              // ROBINHOOD ICON, DISCLOSED (requested: show an actual Robinhood mark, not an "RH"
              // text badge): hand-drawn inline SVG approximating Robinhood's public feather
              // wordmark on their brand lime-green — not an external/fetched asset (no network
              // request, no new file), just a small vector shape drawn to match, sized to sit
              // alongside the Base icon at the same 14px badge size.
              <span style={{ width: '14px', height: '14px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#d7fe04', flexShrink: 0, overflow: 'hidden' }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                  <path d="M20.5 2.2c-5.4.2-10.8 2.9-13 8.6-1.1 2.9-3.3 8.6-3.3 8.6l2.7-1c1.9-6 4.6-9.4 8.6-11.6 2.6-1.4 5-2.3 5-4.6z" fill="#0a0a05" />
                  <path d="M13.6 6.4L5.6 21" stroke="#d7fe04" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </span>
            )}
            {chain.label}
          </button>
        )
      })}
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
  // NO-AUTO-RETRY-ON-COLD-OUTAGE, DISCLOSED (reported live: "it just started working but 30
  // seconds ago it came with nothing, I had to keep refreshing"). A cycle that lands on a genuine
  // provider outage (finalState 'providerUnavailable' — GeckoTerminal AND its DexScreener fallback
  // both failed this cycle, with no last-good cache to serve) was previously left on-screen for
  // the FULL 120s poll interval with no automatic recovery — the only way back was a manual Refresh
  // click, exactly what was reported. A quiet, honestly-empty market (finalState 'allFilteredOut'/
  // 'noRawCandidates' — providers answered, nothing qualified) is NOT retried here: that is a real
  // result, not a failure, and retrying it would just hammer the backend for the same answer.
  // Bounded to 2 auto-retries (8s, then 20s) so a real, longer outage still falls through to the
  // normal 120s poll instead of retrying forever.
  const autoRetryCountRef = useRef(0)
  const autoRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // fetchData can't call itself directly from inside its own useCallback initializer (the retry
  // timeout needs to fire a LATER fetchData call, not close over a stale one) — same ref-sync
  // pattern already used for effectiveRadarChainRef below.
  const fetchDataRef = useRef<() => void>(() => {})
  // NEW-RADAR DEFAULT, DISCLOSED (Base Radar filter simplification task): default mode changed
  // from TRENDING to NEW — "fresh Base opportunities first" is now the page's default identity
  // instead of a generic screener landing on whichever tab happened to be first. Filter logic
  // itself (below) is unchanged; only which mode is selected on load.
  const [activeFilter, setActiveFilter] = useState<RadarFilter>('NEW')
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('NEWEST')
  // WATCHLIST, DISCLOSED (requested: "fully functional" watchlist on the CORTEX panel): the
  // previous "Add to Watchlist" button on each card only toggled local component state — it never
  // called the real, already-existing /api/watchlist/tokens endpoint (GET/POST/DELETE, the same one
  // the standalone /terminal/watchlist page and ClarkRadar's handleWatchMover already use), so
  // nothing actually persisted and a saved token forgot it was saved on the next page load. Now
  // backed by that same real endpoint — watchlistTokens is the source of truth for both this panel
  // and every card's "Watching" state, loaded once on mount and kept in sync with each toggle.
  const [watchlistTokens, setWatchlistTokens] = useState<WatchlistTokenRow[]>([])
  const [watchlistLoading, setWatchlistLoading] = useState(true)
  const loadWatchlist = useCallback(async () => {
    setWatchlistLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) { setWatchlistTokens([]); return }
      const res = await fetch('/api/watchlist/tokens', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      const json = await res.json().catch(() => null)
      if (res.ok && Array.isArray(json?.tokens)) setWatchlistTokens(json.tokens)
    } catch {
      // Best-effort — leave whatever was already loaded (or empty) rather than erroring the page.
    } finally {
      setWatchlistLoading(false)
    }
  }, [])
  useEffect(() => {
    queueMicrotask(() => { void loadWatchlist() })
  }, [loadWatchlist])
  const [selectedToken, setSelectedToken] = useState<TokenIntel | null>(null)
  // QUICK-PREVIEW / FULL-REPORT, DISCLOSED (Radar token detail UX polish task): `drawerOpen` now
  // controls the compact QuickPreviewPanel (opened first, on every card click — same trigger as
  // before) instead of jumping straight to the full ProjectOverviewDrawer. `fullReportOpen` is the
  // new, separate step reached only via the preview's "Open Full Report" button.
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [fullReportOpen, setFullReportOpen] = useState(false)
  // CHAIN SELECTOR STATE, DISCLOSED (originally a Robinhood scaffold task — Robinhood now has the
  // same real discovery/gate pipeline as Base, see the ROBINHOOD-CHAIN-SUPPORT header comment in
  // app/api/radar/route.ts). fetchData()/loadOnePage read effectiveRadarChainRef.current so they
  // always request the currently-selected chain's own data; REFETCH-ON-CHAIN-SWITCH below clears
  // stale data and reloads whenever the effective chain actually changes.
  const [selectedRadarChain, setSelectedRadarChain] = useState<RadarChain>('base')
  // ROBINHOOD AVAILABILITY, DISCLOSED (env verification + feature flag wiring task): defaults to
  // false (fails closed) until /api/base-radar/chain-status confirms ENABLE_ROBINHOOD_CHAIN=true
  // AND ALCHEMY_ROBINHOOD_RPC_URL is configured server-side — that route never returns the RPC URL
  // itself, only booleans. No RPC/provider call happens here or in that route; this only checks
  // config presence.
  const [robinhoodAvailable, setRobinhoodAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/base-radar/chain-status?selectedChain=${selectedRadarChain}`, { cache: 'no-store' })
      .then(res => res.json())
      .then(json => { if (!cancelled) setRobinhoodAvailable(Boolean(json?.robinhood?.available)) })
      .catch(() => { if (!cancelled) setRobinhoodAvailable(false) })
    return () => { cancelled = true }
  }, [selectedRadarChain])
  // DEFENSIVE FALLBACK, DISCLOSED: derived in render (not an effect-triggered setState, which
  // causes cascading renders) — if Robinhood is somehow selected while it isn't actually available
  // (e.g. the availability check above hasn't resolved yet, or the flag flips off between checks),
  // every render branch below reads `effectiveRadarChain` instead of the raw selection, so nothing
  // Robinhood-labeled is ever shown unless backed by a confirmed-available config. The ChainSelector
  // itself only ever offers Robinhood as a choice when robinhoodAvailable is already true, so this
  // is a belt-and-suspenders fallback, not the primary guard.
  const effectiveRadarChain: RadarChain = selectedRadarChain === 'robinhood' && !robinhoodAvailable ? 'base' : selectedRadarChain
  // CHAIN-REF-FOR-STABLE-CALLBACKS, DISCLOSED (Robinhood-chain live-feed support): fetchData/
  // loadOnePage below are useCallback with an empty/stable dependency array (existing pattern, kept
  // deliberately stable so effects that depend on their identity don't refire every render) — a
  // plain reactive reference to effectiveRadarChain inside them would close over a stale value from
  // whenever the callback was first created. Same pattern already used for hasRadarDataRef/
  // abortControllerRef in this file: keep a ref in sync via a tiny effect, read `.current` inside
  // the stable callbacks so they always see the actual current chain selection.
  const effectiveRadarChainRef = useRef<RadarChain>(effectiveRadarChain)
  useEffect(() => { effectiveRadarChainRef.current = effectiveRadarChain }, [effectiveRadarChain])

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
    // HANG-GUARD FIX, DISCLOSED (reported: "Refreshing radar…" stuck for 5+ minutes with no error).
    // This fetch had no client-side timeout at all — only the manual-abort AbortController used to
    // cancel a superseded request — so a slow/hung backend response (or a dropped connection the
    // browser doesn't surface as a network error) could leave `loading` true indefinitely with no
    // way for the user to know anything had gone wrong short of reloading the page.
    // 25s -> 55s, DISCLOSED (Robinhood Chain radar "refresh failed" bug fix): the original 25s was
    // sized off "the backend's own slowest SINGLE external call is bounded to 12s" — a real bound,
    // but not the relevant one; a cold-cache request makes many such calls (GeckoTerminal across
    // several sources/pages, then a per-token GoldRush holder-count call for every candidate, which
    // tries TWO sequential URL candidates for Robinhood specifically — see CHAIN_PATHS in
    // lib/server/goldrushHolderCount.ts), so total wall-clock time is not bounded by that one number.
    // Confirmed via vercel.json: app/api/base-radar/cron/route.ts, which triggers this exact same
    // /api/radar pipeline server-side, was already given a 60s maxDuration — proving the pipeline
    // itself was already known to sometimes need close to a minute, while this client-side abort was
    // still cutting it off at 25s and every real user hit was racing (and often losing to) that
    // budget the platform itself considered too short. app/api/radar/route.ts now also carries an
    // explicit 60s maxDuration (it previously had none, silently falling back to the platform
    // default of far less than 60s); 55s here stays under that with headroom for response overhead.
    const timeoutId = setTimeout(() => controller.abort(), 55_000)

    setLoading(true)
    setError(null)
    try {
      const { data: _sd } = await supabase.auth.getSession()
      const _tok = _sd.session?.access_token
      const res = await fetch(`/api/radar?chain=${effectiveRadarChainRef.current}`, { cache: 'no-store', signal: controller.signal, headers: _tok ? { Authorization: `Bearer ${_tok}` } : {} })
      const json = await res.json().catch(() => null)
      if (!json || !res.ok || json.error) {
        setError(radarVisibleErrorFromPayload(json, res.status, hasRadarDataRef.current))
      } else {
        hasRadarDataRef.current = radarHasVisibleFeed(json)
        setData(json as RadarData)
        const rd = json as RadarData
        if (rd.finalState === 'providerUnavailable' && rd.tokens.length === 0 && autoRetryCountRef.current < 2) {
          const delayMs = autoRetryCountRef.current === 0 ? 8_000 : 20_000
          autoRetryCountRef.current += 1
          if (autoRetryTimeoutRef.current) clearTimeout(autoRetryTimeoutRef.current)
          autoRetryTimeoutRef.current = setTimeout(() => { fetchDataRef.current() }, delayMs)
        } else {
          // A real result (tokens present) or an honest empty-after-filtering state resets the
          // counter, so a LATER genuine outage still gets its own fresh pair of auto-retries.
          autoRetryCountRef.current = 0
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Two different reasons this fires: (a) a newer fetchData() call superseded this one — by
        // the time that happens, abortControllerRef.current already points at the newer controller,
        // so it no longer owns loading/error state and must not touch it; (b) our own timeoutId
        // above fired because nothing superseded this request — it just took too long. Only (b)
        // should surface an error, and the abortControllerRef.current check below distinguishes them.
        if (abortControllerRef.current === controller) {
          setError(radarTimeoutMessage(hasRadarDataRef.current))
        }
        return
      }
      setError(radarErrorMessage(0, hasRadarDataRef.current))
    } finally {
      clearTimeout(timeoutId)
      if (abortControllerRef.current === controller) {
        fetchInFlightRef.current = false
        setLoading(false)
      }
    }
  }, [])
  useEffect(() => { fetchDataRef.current = () => { void fetchData() } }, [fetchData])

  // LOAD MORE, DISCLOSED (requested: a way to pull in more radar candidates beyond the initial
  // feed): fetches the next GeckoTerminal page window (see /api/radar's own `page` param comment)
  // and appends any tokens not already shown — existing tokens/order/scores are untouched, this
  // only grows the list. Uses its own loading flag so it doesn't fight the main refresh spinner.
  const [loadingMore, setLoadingMore] = useState(false)
  // LOAD-MORE-EXHAUSTED, DISCLOSED (requested: Load More should load/consider more qualified
  // candidates, not just reveal already-computed results, and should say so honestly when a fresh
  // page genuinely has nothing new that clears the gate). handleLoadMore already fetches a real new
  // GeckoTerminal page window (?page=N — a different raw pool, not a re-reveal of the same one), so
  // the fetch side of this was already correct; this only adds the missing honest message for the
  // case where that fresh page came back with zero tokens this feed doesn't already have.
  const [loadMoreExhausted, setLoadMoreExhausted] = useState(false)
  // LOAD-ONE-PAGE, DISCLOSED: extracted so handleLoadMore (one click, one page) and handleLoadAll
  // (below — automatically clicks through every remaining page) share the exact same fetch/merge/
  // dedupe logic instead of drifting apart. Returns what actually happened so a calling loop can
  // decide whether to continue — state itself is read back via the return value, not by racing
  // React's own (batched, async) state updates.
  const loadOnePage = useCallback(async (page: number): Promise<{ ok: boolean; addedCount: number; hasMore: boolean; degraded: boolean }> => {
    try {
      const { data: _sd } = await supabase.auth.getSession()
      const _tok = _sd.session?.access_token
      const res = await fetch(`/api/radar?page=${page}&chain=${effectiveRadarChainRef.current}`, { cache: 'no-store', headers: _tok ? { Authorization: `Bearer ${_tok}` } : {} })
      const json = await res.json()
      if (!res.ok || json.error) return { ok: false, addedCount: 0, hasMore: false, degraded: false }
      let addedCount = 0
      let hasMore = false
      setData(prev => {
        if (!prev) return json as RadarData
        const seen = new Set(prev.tokens.map(t => t.contract.toLowerCase()))
        const newTokens = (json.tokens as RadarToken[]).filter(t => !seen.has(t.contract.toLowerCase()))
        addedCount = newTokens.length
        hasMore = json.hasMore ?? false
        return { ...prev, tokens: [...prev.tokens, ...newTokens], page: json.page ?? page, hasMore }
      })
      // DEGRADED-PAGE FIX, DISCLOSED (reported: "load more" appears not to work). A page can come
      // back HTTP 200 with zero new tokens for two very different reasons — it genuinely reached the
      // end of what qualifies (real exhaustion), or GeckoTerminal rate-limited every source for this
      // page (json.discoveryDegraded, already computed server-side from sourcesFailedCount). Both
      // used to render the same "no more candidates" copy, which reads as broken when it was
      // actually a rate-limit hit that a retry a bit later would very likely clear.
      return { ok: true, addedCount, hasMore, degraded: addedCount === 0 && json.discoveryDegraded === true }
    } catch {
      // Best-effort — a failed page fetch leaves the existing feed exactly as it was.
      return { ok: false, addedCount: 0, hasMore: false, degraded: false }
    }
  }, [])
  const [loadMoreRateLimited, setLoadMoreRateLimited] = useState(false)
  // LOAD-MORE-COOLDOWN FIX, DISCLOSED (reported: rate-limit throttling suddenly appearing that
  // "never really happens" specifically when clicking Load/Load More — dug into it and found the
  // real gap: the main Refresh button re-requests the SAME page/cache key, so rapid re-clicks
  // mostly just hit the server-side cache (RADAR_FULL_CACHE_TTL_MS) and never re-hit GeckoTerminal
  // at all. Load More is structurally different — every click targets the NEXT page (?page=N+1), a
  // cache key that has never been fetched before, so it is NEVER a cache hit. The only thing that
  // was ever standing between a user and back-to-back fresh GeckoTerminal bursts was `disabled={
  // loadingMore}`, which just prevents a concurrent double-click — it does nothing to stop clicking
  // again the moment the previous click resolves (which can be under a second on a cache/backoff
  // skip). This route's own LOAD_ALL_PAGE_DELAY_MS was raised to 120s after being live-reproduced
  // as the one cadence that actually recovers reliably — Load More had zero enforced cadence at
  // all, the exact gap Load All's fix was built around. Adds a real client-side cooldown so a human
  // clicking Load More repeatedly can't do what Load All's own fix exists to prevent.
  const LOAD_MORE_COOLDOWN_MS = 60_000
  const [loadMoreCooldownUntil, setLoadMoreCooldownUntil] = useState(0)
  const [loadMoreCooldownRemaining, setLoadMoreCooldownRemaining] = useState(0)
  useEffect(() => {
    if (loadMoreCooldownUntil <= Date.now()) { setLoadMoreCooldownRemaining(0); return }
    const tick = () => setLoadMoreCooldownRemaining(Math.max(0, Math.ceil((loadMoreCooldownUntil - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [loadMoreCooldownUntil])
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || Date.now() < loadMoreCooldownUntil) return
    setLoadingMore(true)
    setLoadMoreCooldownUntil(Date.now() + LOAD_MORE_COOLDOWN_MS)
    try {
      const result = await loadOnePage((data?.page ?? 1) + 1)
      setLoadMoreExhausted(result.ok && result.addedCount === 0 && !result.degraded)
      setLoadMoreRateLimited(result.ok && result.degraded)
    } finally {
      setLoadingMore(false)
    }
  }, [data?.page, loadingMore, loadMoreCooldownUntil, loadOnePage])

  // FIND-NEW-TOKENS, DISCLOSED (explicitly requested: "a button at the bottom to find new tokens
  // cause a lot are the same tokens from days ago" — the default mixed discovery interleaves
  // new_pools with trending_pools/pools-by-volume, and the latter two structurally keep resurfacing
  // the same established, already-active pools). Hits /api/radar with freshOnly=1 — restricts that
  // one request to ONLY the new_pools source, server-side (see app/api/radar/route.ts) — and appends
  // whatever isn't already shown. Deliberately does NOT touch data.page/hasMore (Load More's own
  // pagination cursor); this is an independent, explicit "give me the freshest pools right now"
  // action, not part of the regular page-by-page flow.
  const [findingNew, setFindingNew] = useState(false)
  const [findNewExhausted, setFindNewExhausted] = useState(false)
  const handleFindNewTokens = useCallback(async () => {
    if (findingNew) return
    setFindingNew(true)
    setFindNewExhausted(false)
    try {
      const { data: _sd } = await supabase.auth.getSession()
      const _tok = _sd.session?.access_token
      const res = await fetch(`/api/radar?page=1&freshOnly=1&chain=${effectiveRadarChainRef.current}`, { cache: 'no-store', headers: _tok ? { Authorization: `Bearer ${_tok}` } : {} })
      const json = await res.json()
      if (!res.ok || json.error) { setFindNewExhausted(true); return }
      let addedCount = 0
      setData(prev => {
        if (!prev) return json as RadarData
        const seen = new Set(prev.tokens.map(t => t.contract.toLowerCase()))
        const newTokens = (json.tokens as RadarToken[]).filter(t => !seen.has(t.contract.toLowerCase()))
        addedCount = newTokens.length
        return { ...prev, tokens: [...newTokens, ...prev.tokens] }
      })
      setFindNewExhausted(addedCount === 0)
    } catch {
      setFindNewExhausted(true)
    } finally {
      setFindingNew(false)
    }
  }, [findingNew])
  // LOAD-ALL, DISCLOSED (requested: "check it all and get it from one load instead of going on
  // each page" — one control that automatically clicks through every remaining page instead of the
  // user doing it by hand). Deliberately NOT one giant server-side request: this route has no
  // extended maxDuration configured (see vercel.json — only /api/scan* routes get one) and a single
  // page already takes several real seconds (paced GeckoTerminal discovery waves + DexScreener
  // rescue calls + holder checks + honeypot simulations); firing 5 pages' worth of upstream requests
  // inside one server call would very likely blow the default function timeout and return nothing —
  // worse than today. Looping client-side instead keeps every individual request inside its normal,
  // already-safe budget and lets each one use the existing rate-limit backoff/pacing exactly as
  // designed — this only automates clicking Load More repeatedly, with a real pause between clicks
  // so it doesn't fire pages back-to-back faster than a human would (which is exactly the pattern
  // this session's rate-limit fixes exist to avoid).
  // DELAY-TOO-SHORT FIX, DISCLOSED (live-reproduced immediately after shipping: a real capture
  // showed pages 2, 3, and 5 ALL coming back sourcesFailedCount 8/8 — a full GeckoTerminal lockout —
  // with only page 4 partially recovering. The original 2.5s inter-page delay was nowhere near this
  // route's real recovery window; each page already fires up to 8 GeckoTerminal requests on its own
  // (the same burst a single refresh uses), so five pages 2.5s apart is a much bigger, faster burst
  // than anything this session's other rate-limit fixes were tuned against. Raised to align with the
  // one empirically-safe cadence this session has actually observed recovering reliably: the
  // frontend's own 120s auto-refresh interval (RADAR_FULL_CACHE_TTL_MS's poll-interval comment). Full
  // Load All now realistically takes ~2 minutes for 4 additional pages, not seconds — slower, but it
  // should actually recover between pages instead of guaranteeing its own lockout.
  const [loadingAll, setLoadingAll] = useState(false)
  const [loadAllProgress, setLoadAllProgress] = useState<{ page: number; totalAdded: number } | null>(null)
  // DELAY-DIDN'T-MATCH-ITS-OWN-EVIDENCE FIX, DISCLOSED (reported: "load more" still not pulling in
  // new tokens, stuck on "waiting for rate limit"). The comment above already documents that 30s
  // was live-reproduced as NOT enough — pages 2, 3, and 5 still came back 8/8 GeckoTerminal
  // failures at that cadence — and that the one cadence actually observed recovering reliably is
  // the frontend's own 120s auto-refresh interval. The constant itself was left at 30_000 despite
  // that conclusion, so every Load All run was still using the exact cadence already proven to
  // fail. Corrected to match the cadence the investigation actually validated.
  const LOAD_ALL_PAGE_DELAY_MS = 120_000
  const handleLoadAll = useCallback(async () => {
    // Shares Load More's cooldown for its own first page — same underlying loadOnePage burst, so a
    // Load More click immediately followed by Load All would otherwise fire two fresh bursts
    // back-to-back with no gap at all (Load All's own 120s pacing only applies BETWEEN its pages,
    // not before the first one).
    if (loadingAll || loadingMore || Date.now() < loadMoreCooldownUntil) return
    setLoadingAll(true)
    setLoadMoreCooldownUntil(Date.now() + LOAD_MORE_COOLDOWN_MS)
    setLoadMoreExhausted(false)
    setLoadMoreRateLimited(false)
    let totalAdded = 0
    let anyDegraded = false
    try {
      let page = data?.page ?? 1
      let hasMore = data?.hasMore ?? false
      while (hasMore) {
        page += 1
        setLoadAllProgress({ page, totalAdded })
        const result = await loadOnePage(page)
        if (!result.ok) break
        totalAdded += result.addedCount
        anyDegraded = anyDegraded || result.degraded
        hasMore = result.hasMore
        if (hasMore) await new Promise(resolve => setTimeout(resolve, LOAD_ALL_PAGE_DELAY_MS))
      }
      setLoadMoreExhausted(totalAdded === 0 && !anyDegraded)
      setLoadMoreRateLimited(totalAdded === 0 && anyDegraded)
    } finally {
      setLoadingAll(false)
      setLoadAllProgress(null)
    }
  }, [data?.page, data?.hasMore, loadingAll, loadingMore, loadMoreCooldownUntil, loadOnePage])

  // REDUNDANT-REFETCH-ON-TAB-REFOCUS FIX, DISCLOSED (reported: switching to another tab for a
  // while, then back to Base Radar, clears the feed and it doesn't come back). Root cause:
  // Supabase's client automatically re-checks the session when a tab regains focus after being
  // backgrounded (a routine, benign event, not a real plan/access change) — usePlanWithLoading's
  // onAuthStateChange handler sets `loading=true` for the duration of that re-check regardless of
  // whether the resolved plan actually changes (lib/usePlan.tsx). Since planLoading was a dependency
  // of this effect, EVERY tab-refocus silently fired a brand-new /api/radar fetch, not because
  // anything was stale, but purely as a side effect of the auth blip — and since default New Radar
  // now enforces a real, sometimes-thin deterministic $80K-$2M/30-holder band, that surprise extra
  // fetch had a real chance of landing on a momentarily-empty cycle and replacing whatever was
  // already showing with nothing. Now only fires on the actual transition INTO having access
  // (mount, login, or a real plan upgrade) — tracked via hasFetchedInitialRef — not on every benign
  // loading blip while access was already granted the whole time. The existing 120s interval poll
  // and manual Refresh button remain the only intended ways to get a fresh fetch after that.
  // SELF-CAUGHT REGRESSION, DISCLOSED (found during a full-pipeline audit of this exact fix, same
  // session): the first version reset hasFetchedInitialRef to false on ANY `!hasAccess`, but
  // hasAccess is `!planLoading && canAccessFeature(...)` — so the instant planLoading blips true
  // (the benign auth re-check this fix exists to ignore), hasAccess goes false too, the ref got
  // reset, and the moment planLoading resolved back to false a beat later this effect re-entered
  // the "just gained access" branch and fired fetchData() again — reproducing the exact bug this
  // fix claimed to solve. Fixed by not touching the ref at all while planLoading is still
  // unresolved (an in-progress check is never "lost access") — only a SETTLED state (planLoading
  // false) with access genuinely denied resets the ref, so a real plan downgrade/upgrade cycle
  // still refetches correctly, but a momentary loading blip while access never actually changed
  // does nothing.
  const hasFetchedInitialRef = useRef(false)
  useEffect(() => {
    if (planLoading) return
    const hasAccess = canAccessFeature(effectivePlan, 'base-radar')
    if (hasAccess) {
      if (!hasFetchedInitialRef.current) {
        hasFetchedInitialRef.current = true
        queueMicrotask(() => {
          void fetchData()
        })
      }
    } else {
      hasFetchedInitialRef.current = false
    }
  }, [effectivePlan, fetchData, planLoading])

  // REFETCH-ON-CHAIN-SWITCH, DISCLOSED (Robinhood-chain live-feed support): now that Robinhood has a
  // real backend pipeline (not the old placeholder), switching chains must load that chain's actual
  // data instead of leaving the previous chain's tokens on screen mislabeled under the new tab.
  // Clears `data` immediately on a real switch (never show Base tokens under a "Robinhood" heading,
  // even for a moment) and fires a fresh fetchData() for the newly-selected chain. Skipped on the
  // very first mount (hasFetchedInitialRef above already covers that fetch) via the prevChainRef
  // guard, so this never double-fetches alongside the initial-load effect.
  const prevChainRef = useRef<RadarChain | null>(null)
  useEffect(() => {
    if (prevChainRef.current === null) { prevChainRef.current = effectiveRadarChain; return }
    if (prevChainRef.current === effectiveRadarChain) return
    prevChainRef.current = effectiveRadarChain
    setData(null)
    setError(null)
    setLoading(true)
    hasRadarDataRef.current = false
    abortControllerRef.current?.abort()
    setLoadMoreExhausted(false)
    if (autoRetryTimeoutRef.current) clearTimeout(autoRetryTimeoutRef.current)
    autoRetryCountRef.current = 0
    void fetchData()
  }, [effectiveRadarChain, fetchData])

  // UNMOUNT-ABORT FIX, DISCLOSED (Base Radar speed audit): without this, navigating away mid-fetch
  // left the network request running to completion server-side (the backend still did the full
  // multi-token scoring work for a response nobody would ever read) and left setData/setLoading
  // calls pending against an unmounted component.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      if (autoRetryTimeoutRef.current) clearTimeout(autoRetryTimeoutRef.current)
    }
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
    if (autoRetryTimeoutRef.current) clearTimeout(autoRetryTimeoutRef.current)
    autoRetryCountRef.current = 0
    fetchData()
  }

  // CHAIN-AWARE-SCAN-LINK FIX, DISCLOSED (reported: "Scan Token"/watchlist working for Base but not
  // Robinhood): this never passed a chain param at all, so Token Scanner's own URL-autodetect logic
  // (see that page's chainParam handling) fell back to its default, Base — silently scanning a
  // Robinhood-chain token against the wrong network. Passes the real active chain now; still omits
  // the param entirely for Base so existing bookmarked/shared Base links are byte-for-byte unchanged.
  function openToken(contract: string, chain: RadarChain = effectiveRadarChainRef.current) {
    const chainQuery = chain === 'base' ? '' : `&chain=${chain}`
    router.push(`/terminal/token-scanner?contract=${contract}${chainQuery}`)
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

    setData((prev) => prev ? { ...prev, tokens: prev.tokens.map((token) => enrichToken(mergeTokenEvidence(token), effectiveRadarChainRef.current)) } : prev)
    setSelectedToken((prev) => {
      if (!prev || prev.contract.toLowerCase() !== normalizedAddress) return prev
      return enrichToken(mergeTokenEvidence(prev), effectiveRadarChainRef.current)
    })
  }, [])

  function openProjectOverview(token: TokenIntel) {
    setSelectedToken(token)
    setDrawerOpen(true)
  }

  function preloadProjectOverview(token: TokenIntel) {
    setSelectedToken(prev => prev?.contract === token.contract ? prev : token)
  }

  // NULL-SAFE-WATCHLIST-CHECK FIX, DISCLOSED: this crashed the entire page (reported: "This page
  // couldn't load", console TypeError "Cannot read properties of undefined (reading
  // 'toLowerCase')" on this exact line) whenever any row in watchlistTokens had no `address` — a
  // real, reachable case given how that data is populated (see the API route's own fix). Guarding
  // here too so a malformed/inconsistent row can never crash the whole page again, independent of
  // whether the API-level fix covers every future write path.
  function isWatched(contract: string): boolean {
    if (!contract) return false
    return watchlistTokens.some(w => typeof w?.address === 'string' && w.address.toLowerCase() === contract.toLowerCase())
  }

  // PERSISTED TOGGLE, DISCLOSED: optimistic local update first (instant UI feedback, same feel as
  // before), then the real POST/DELETE against /api/watchlist/tokens — the exact same endpoint and
  // payload shape /terminal/watchlist's own save flow and ClarkRadar's handleWatchMover already use.
  // Requires a signed-in session (same as every other watchlist entry point in this app); with no
  // session the toggle still updates the visible state for this tab but has nothing to persist.
  // WATCHLIST-CHAIN, DISCLOSED (found in a full Base Radar audit): both the optimistic row and the
  // persisted POST body hardcoded chain: 'base', so saving a Robinhood token wrote it to the
  // watchlist as a Base token — a wrong-chain record that would later resolve the contract against
  // the wrong network entirely. Uses the real active chain now.
  async function toggleTrack(token: { contract: string; symbol: string; name: string; status: string; radarScore: number }) {
    const address = token.contract.toLowerCase()
    const wasWatched = isWatched(address)
    const tokenChain = effectiveRadarChainRef.current
    // ROLLBACK SNAPSHOT, DISCLOSED (button-responsiveness task's "optimistic state rolls back on
    // failure" requirement): the optimistic update below used to be treated as final regardless of
    // whether the real save actually succeeded ("the next loadWatchlist() will reconcile" — true,
    // but leaves a wrong-looking watchlist star until the user's next visit). Captured before the
    // optimistic update so a genuine failure (no session, non-ok response, network error) can revert
    // the button to its real, pre-click state immediately instead of waiting on a future page load.
    const previousTokens = watchlistTokens
    setWatchlistTokens(prev => wasWatched
      ? prev.filter(w => typeof w?.address !== 'string' || w.address.toLowerCase() !== address)
      : [{ address, symbol: token.symbol, name: token.name, chain: tokenChain, risk_label: token.status, score: token.radarScore, score_type: 'radar_score', score_direction: null }, ...prev])

    const { data: { session } } = await supabase.auth.getSession()
    const authToken = session?.access_token
    if (!authToken) {
      setWatchlistTokens(previousTokens)
      return
    }

    try {
      const res = wasWatched
        ? await fetch(`/api/watchlist/tokens?address=${encodeURIComponent(address)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${authToken}` },
          })
        : await fetch('/api/watchlist/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ address, symbol: token.symbol, name: token.name, chain: tokenChain, riskLabel: token.status, score: token.radarScore, scoreType: 'radar_score' }),
          })
      if (!res.ok) setWatchlistTokens(previousTokens)
    } catch {
      // ROLLBACK ON FAILURE, DISCLOSED: a real network/fetch error means the change never actually
      // persisted — revert the optimistic UI rather than leaving a watchlist star that lies.
      setWatchlistTokens(previousTokens)
    }
  }

  function removeFromWatchlist(address: string) {
    const previousTokens = watchlistTokens
    setWatchlistTokens(prev => prev.filter(w => typeof w?.address !== 'string' || w.address.toLowerCase() !== address.toLowerCase()))
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const authToken = session?.access_token
      if (!authToken) { setWatchlistTokens(previousTokens); return }
      try {
        const res = await fetch(`/api/watchlist/tokens?address=${encodeURIComponent(address)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } })
        if (!res.ok) setWatchlistTokens(previousTokens)
      } catch {
        // ROLLBACK ON FAILURE, DISCLOSED: same as toggleTrack above — a real failure reverts the
        // optimistic removal instead of leaving state that doesn't match the server.
        setWatchlistTokens(previousTokens)
      }
    })()
  }

  function askCortex(token: TokenIntel) {
    const buyTax = token.honeypot?.buyTax
    const sellTax = token.honeypot?.sellTax
    const security = token.simulationStatus === 'passed' ? 'Verified' : 'Unknown'
    // CORTEX-PROMPT-CHAIN, DISCLOSED (found in a full Base Radar audit): this prompt asserted "this
    // Base Radar token" and never stated the chain, so a Robinhood contract was handed to the AI
    // labeled as Base — the model would reason (and could look up) against the wrong network
    // entirely. States the real chain explicitly now.
    const chainName = effectiveRadarChainRef.current === 'robinhood' ? 'Robinhood Chain' : 'Base'
    const prompt = [
      '[mode: base-radar]',
      `Analyze this ${chainName} radar token and give me a clear verdict: WATCH, PASS, or SCAN DEEPER.`,
      `Chain: ${chainName}`,
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

  const intelTokens = useMemo(() => tokens.map(t => enrichToken(t, effectiveRadarChain)), [tokens, effectiveRadarChain])

  function openWatchlistToken(address: string) {
    const found = intelTokens.find(t => t.contract.toLowerCase() === address.toLowerCase())
    if (found) { openProjectOverview(found); return }
    // Not in the currently-loaded feed (e.g. saved on a different chain, or from an earlier
    // session) — use the chain it was actually saved under, same fix as openToken above, so this
    // never silently re-scans a Robinhood-saved token as Base.
    const savedRow = watchlistTokens.find(w => typeof w?.address === 'string' && w.address.toLowerCase() === address.toLowerCase())
    const savedChain: RadarChain = savedRow?.chain === 'robinhood' ? 'robinhood' : 'base'
    openToken(address, savedChain)
  }

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
    const providersFailed = data?.finalState === 'providerUnavailable'

    return {
      newPools: intelTokens.length,
      worthWatching,
      highMomentum,
      unverified,
      averageLiquidity,
      highestLiquidityToken: getOverviewTokenTitle(highestLiquidity, providersFailed),
      highestLiquidityValue: highestLiquidity ? `${fmtUSD(highestLiquidity.liquidityUsd)} liquidity` : (providersFailed ? 'Unavailable' : 'Needs data'),
      highestVolumeToken: getOverviewTokenTitle(highestVolume, providersFailed),
      highestVolumeValue: highestVolume ? `${fmtUSD(highestVolume.volume24h)} volume` : (providersFailed ? 'Unavailable' : 'Needs data'),
      newestToken: getOverviewTokenTitle(newest, providersFailed),
      newestValue: newest ? `${fmtAge(newest.ageMinutes)} old` : (providersFailed ? 'Unavailable' : 'Needs data'),
      hottestToken: getOverviewTokenTitle(hottest, providersFailed),
      hottestValue: hottest ? `Score ${hottest.radarScore}` : (providersFailed ? 'Unavailable' : 'Needs data'),
      hasSecurityData,
      hiddenLowEvidenceCount: data?.hiddenLowEvidenceCount ?? 0,
      hiddenLowValuation: data?.hiddenLowValuation ?? 0,
      hiddenBelow80k: data?.hiddenBelow80k ?? 0,
      hiddenLowHolders: data?.hiddenLowHolders ?? 0,
      hiddenHolderUnavailable: data?.hiddenHolderUnavailable ?? 0,
      hiddenConcentrationUnavailable: data?.hiddenConcentrationUnavailable ?? 0,
    }
  }, [intelTokens, data?.hiddenLowEvidenceCount, data?.hiddenLowValuation, data?.hiddenBelow80k, data?.hiddenLowHolders, data?.hiddenHolderUnavailable, data?.hiddenConcentrationUnavailable, data?.finalState])

  const filteredAndSortedTokens = useMemo(() => {
    const filtered = intelTokens.filter(token => {
      if (activeFilter === 'TRENDING') return token.status === 'HOT' || token.momentum === 'HIGH' || token.volume24h >= 5_000
      // NEW-WINDOW WIDENED 7 -> 15 -> 20 DAYS, DISCLOSED (history: feed staying thin was verified to
      // be a genuine age-window constraint, not a discovery-depth bug — pools weren't getting enough
      // real time to organically reach 60 holders + the valuation band before aging out of
      // consideration). The backend's own outer cutoff (app/api/radar/route.ts's POOL_AGE_WINDOW_MS)
      // is 20 days; this frontend NEW-tab filter must match it or a candidate the backend legitimately
      // includes would still be invisible on the default tab.
      if (activeFilter === 'NEW') return token.ageMinutes <= 20 * 24 * 60 || token.status === 'EARLY'
      if (activeFilter === 'VOLUME') return token.volume24h >= 5_000 || token.momentum !== 'NONE'
      if (activeFilter === 'LIQUIDITY') return token.liquidityUsd >= 10_000
      if (activeFilter === 'RISK_WATCH') return token.status === 'RISKY' || token.status === 'UNVERIFIED' || token.simulationStatus !== 'passed'
      if (activeFilter === 'WATCHLIST') return token.radarScore >= 60 && token.status !== 'DEAD' && token.status !== 'RISKY'
      return true
    })

    // TRENDING-EMPTY FALLBACK FIX, DISCLOSED (reported: TRENDING tab — the default landing tab —
    // shows "No pools match the current filter" even though the feed has real tracked tokens). Root
    // cause: TRENDING requires HOT status (which itself requires a *passed* honeypot simulation —
    // often still pending on brand-new pools), HIGH momentum, or $5K+ volume — a genuinely high bar
    // that a small/early feed can legitimately clear zero of, even though every other tab
    // (NEW/VOLUME/LIQUIDITY) shows real tokens. Rather than loosen the bar (which would make
    // "trending" mean less when a real hot token does appear), fall back to the best-momentum
    // tokens the feed actually has whenever the strict filter comes up empty but tokens exist —
    // same underlying data, just never a hard wall when there's something real to show.
    const effectiveFiltered = activeFilter === 'TRENDING' && filtered.length === 0 && intelTokens.length > 0
      ? [...intelTokens].sort((a, b) => (b.momentumRatio ?? 0) - (a.momentumRatio ?? 0) || b.volume24h - a.volume24h).slice(0, 5)
      : filtered

    const sorted = [...effectiveFiltered]

    if (sortMode === 'NEWEST') sorted.sort((a, b) => a.ageMinutes - b.ageMinutes)
    if (sortMode === 'HIGHEST_SCORE') sorted.sort((a, b) => b.radarScore - a.radarScore)
    if (sortMode === 'HIGHEST_LIQUIDITY') sorted.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    if (sortMode === 'HIGHEST_VOLUME') sorted.sort((a, b) => b.volume24h - a.volume24h)
    if (sortMode === 'HIGHEST_MOMENTUM') sorted.sort((a, b) => b.momentumRatio - a.momentumRatio)

    return sorted
  }, [activeFilter, intelTokens, sortMode])

  // SKELETON, NOT A TEXT WALL, DISCLOSED (performance + UX optimization task): this was a
  // full-screen "Loading plan access…" wall that ALSO rendered into the SSR HTML, so it flashed on
  // every single load even for a user whose plan was already cached. PlanGateSkeleton mirrors the
  // page's real rhythm so nothing jumps when content replaces it, and the shared account store now
  // only reports loading:true when there is genuinely no cached plan to trust.
  if (planLoading) return <PlanGateSkeleton />
  if (!canAccessFeature(effectivePlan, 'base-radar')) return <LockedPanel feature="base-radar" />

  return (
    <>
      {/* STYLE CLEANUP, DISCLOSED (task #8 — "avoid animated box-shadow/filter/blur", "reduce heavy
          borders/glows"): removed the decorative-only keyframes/rules that had no informational
          value (card hover shine sweep, stat-tile hover shine sweep, staggered per-card entrance
          delays, per-card backdrop-blur). Kept: the small LIVE-dot pulse (a standard, low-weight
          "live" indicator convention) and the refresh-button spin (functional loading feedback). */}
      <style>{`
        @keyframes livePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(236,72,153,0.6); }
          50%       { opacity: 0.6; box-shadow: 0 0 0 5px rgba(236,72,153,0); }
        }
        @keyframes radarSpin {
          0%   { transform: rotate(0deg);   }
          100% { transform: rotate(360deg); }
        }

        /* Smooth momentum + custom scrollbar on the scroll container */
        .radar-main { scroll-behavior: smooth; }
        .radar-main::-webkit-scrollbar { width: 10px; height: 10px; }
        .radar-main::-webkit-scrollbar-track { background: transparent; }
        .radar-main::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.16); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
        .radar-main::-webkit-scrollbar-thumb:hover { background: rgba(45,212,191,0.34); background-clip: padding-box; }

        /* Accessible focus rings on all interactive controls */
        .radar-main button:focus-visible, .radar-main select:focus-visible {
          outline: 2px solid rgba(45,212,191,0.55); outline-offset: 2px; border-radius: 8px;
        }

        /* Feed cards — flat, simple hover lift only (no shine sweep, no blur, no glow) */
        .opportunity-card { transition: border-color 0.15s ease, transform 0.15s ease; }
        .opportunity-card:hover { border-color: rgba(255,255,255,0.16); transform: translateY(-1px); }
        .opportunity-card:active { transform: translateY(0); }

        /* Compact summary strip */
        .radar-strip { display: flex; flex-wrap: wrap; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; background: rgba(255,255,255,0.02); margin-bottom: 12px; overflow: hidden; }
        .radar-strip-item { flex: 1 1 150px; padding: 9px 15px; min-width: 0; }
        .radar-strip-item:not(:first-child) { border-left: 1px solid rgba(255,255,255,0.07); }

        /* Filter chips — simple hover feedback, no glow */
        .radar-chip { transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease; }

        /* Buttons — subtle brightness on hover, no lift/glow */
        .radar-main button { transition: filter 0.15s ease, background 0.15s ease, border-color 0.15s ease; }
        .token-card-actions button:hover:not(:disabled),
        .radar-controls button:hover:not(:disabled) { filter: brightness(1.10); }

        @media (max-width: 768px) {
          .radar-main { padding: 18px 12px 120px !important; overflow-x: hidden !important; }
          .opportunity-card { padding: 10px !important; }
          .radar-grid { grid-template-columns: 1fr !important; }
          .radar-stats { position: static !important; }
          .radar-controls { flex-direction: column !important; align-items: flex-start !important; }
          .radar-controls > div { width: 100%; justify-content: space-between; flex-wrap: wrap; }
          .radar-strip-item { flex: 1 1 45% !important; }
          .radar-strip-item:nth-child(odd) { border-left: none !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .radar-main, .opportunity-card, .radar-mini-chart-svg *, .radar-main *,
          .radar-main *::before, .radar-main *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
        }
      `}</style>

      <div className="radar-main" style={{ minHeight: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '28px 32px 120px', color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)', background: 'radial-gradient(1100px 520px at 16% -6%, rgba(34,211,238,0.13), transparent 46%), radial-gradient(900px 480px at 90% 6%, rgba(168,85,247,0.12), transparent 44%), radial-gradient(700px 500px at 62% 108%, rgba(45,212,191,0.07), transparent 50%), #05070f' }}>
        {/* HEADER TIGHTENED, DISCLOSED (task #1): same title/LIVE badge/copy/refresh/sort — the
            gradient title no longer animates (static gradient text, calmer per task #8's "less
            neon"), and vertical spacing is tighter throughout. */}
        <div style={{ marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '5px' }}>
            <h1 style={{ fontSize: '23px', fontWeight: 800, margin: 0, letterSpacing: '-0.02em', backgroundImage: 'linear-gradient(92deg, #f8fafc, #a5f3fc 38%, #c4b5fd 68%, #f8fafc)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent', color: 'transparent' }}>
              {effectiveRadarChain === 'base' ? 'Base Radar' : 'Robinhood Chain Radar'}
            </h1>

            {/* CHAIN-AWARE LIVE BADGE, DISCLOSED: Robinhood now has the same real discovery/gate
                pipeline as Base (just pointed at GeckoTerminal's 'robinhood' network instead of
                'base') — both chains get the same honest "LIVE" badge. */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '99px', background: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.30)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#ec4899', fontFamily: 'var(--font-plex-mono)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ec4899', animation: 'livePulse 1.8s ease-in-out infinite', flexShrink: 0 }} />
              LIVE
            </span>

            <div style={{ marginLeft: 'auto' }}>
              <ChainSelector value={selectedRadarChain} onChange={setSelectedRadarChain} robinhoodAvailable={robinhoodAvailable} />
            </div>
          </div>

          {/* CHAIN-AWARE-COPY, DISCLOSED: same live-feed pipeline now runs for both chains — only the
              opportunity-source wording changes, everything else (gate description, thresholds) is
              identical since both chains run through the exact same gate logic. */}
          <p style={{ fontSize: '12.5px', color: '#94a3b8', margin: '0 0 3px', maxWidth: '720px', lineHeight: 1.4 }}>
            Live feed — new {effectiveRadarChain === 'base' ? 'Base' : 'Robinhood Chain'} opportunities
          </p>
          <p style={{ fontSize: '11px', color: '#5b7186', margin: '0 0 8px', maxWidth: '720px', lineHeight: 1.4 }}>
            Fresh pools and early momentum signals
          </p>
          <p style={{ fontSize: '11px', color: '#5b7186', margin: '0 0 10px', maxWidth: '760px', lineHeight: 1.4, fontFamily: 'var(--font-plex-mono)' }}>
            New Radar requires $50K+ valuation and real liquidity. Tokens above the early range are labelled Established instead of hidden. When verified market cap is unavailable, FDV is used only as a fallback and clearly labeled.
          </p>

          {/* ROBINHOOD-COVERAGE-BANNER, DISCLOSED (Robinhood Radar UI polish task, explicitly
              requested copy + tone: "compact, premium, not scary, blue/cyan information tone"):
              only renders on Robinhood — Base's header is completely unchanged. States the real,
              honest chain-coverage gap once, clearly, so individual cards don't have to re-explain
              it via yellow/orange chip spam. */}
          {effectiveRadarChain === 'robinhood' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', padding: '9px 13px', marginBottom: '10px', maxWidth: '760px', borderRadius: '10px', background: 'rgba(34,211,238,0.06)', border: '1px solid rgba(34,211,238,0.22)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22d3ee', flexShrink: 0, marginTop: '4px' }} />
              <p style={{ margin: 0, fontSize: '11px', color: '#a5f3fc', lineHeight: 1.5, fontFamily: 'var(--font-plex-mono)' }}>
                <span style={{ fontWeight: 800, letterSpacing: '0.04em' }}>ROBINHOOD CHAIN — BETA · </span>
                Market/liquidity discovery is live. Tax/honeypot simulation may be unavailable until provider support improves.
              </p>
            </div>
          )}

          <PulseStrip summary={summary} tileMode={radarStatTileMode({ loading, hasData: data !== null, error })} chain={effectiveRadarChain} />

          <>
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

          {/* SIMPLIFIED MODE ROW, DISCLOSED (Base Radar filter simplification task): the previous
              6-pill row (Trending/New/Volume/Liquidity/Risk Watch/Watchlist Candidates, all equal
              weight) is replaced by one primary "NEW RADAR" chip plus a single "Advanced Filters"
              popover holding the 3 non-default modes (Trending, Risk Watch, Watchlist Candidates).
              Volume/Liquidity are dropped as separate filter chips — Sort already covers "order by
              volume/liquidity" above, so a redundant narrowing filter for the same axis just added
              noise. setActiveFilter/RadarFilter/the filtering logic itself are untouched. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginTop: '10px', position: 'relative' }}>
            <button
              className="radar-chip"
              onClick={() => setActiveFilter('NEW')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 12px', borderRadius: '99px',
                fontSize: '9px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
                border: `1px solid ${activeFilter === 'NEW' ? 'rgba(45,212,191,0.45)' : 'rgba(255,255,255,0.10)'}`,
                background: activeFilter === 'NEW' ? 'rgba(45,212,191,0.16)' : 'rgba(255,255,255,0.03)',
                color: activeFilter === 'NEW' ? '#2DD4BF' : '#94a3b8',
                fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
              }}
            >
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: activeFilter === 'NEW' ? '#2DD4BF' : '#64748b', flexShrink: 0 }} />
              New Radar
            </button>

            {activeFilter !== 'NEW' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 10px', borderRadius: '99px', border: '1px solid rgba(168,85,247,0.35)', background: 'rgba(168,85,247,0.12)', color: '#c4b5fd', fontSize: '9px', fontWeight: 750, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>
                {FILTER_CHIPS.find(c => c.key === activeFilter)?.label}
                <button
                  onClick={() => setActiveFilter('NEW')}
                  aria-label="Clear advanced filter"
                  style={{ all: 'unset', cursor: 'pointer', color: '#c4b5fd', fontSize: '11px', lineHeight: 1, display: 'inline-flex' }}
                >×</button>
              </span>
            )}

            <div style={{ position: 'relative' }}>
              <button
                className="radar-chip"
                onClick={() => setAdvancedFiltersOpen(v => !v)}
                aria-expanded={advancedFiltersOpen}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px',
                  padding: '6px 10px', borderRadius: '99px',
                  fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
                  border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)',
                  color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
                }}
              >
                Advanced Filters
                <span aria-hidden style={{ fontSize: '8px', transform: advancedFiltersOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</span>
              </button>
              {advancedFiltersOpen && (
                <>
                  <div onClick={() => setAdvancedFiltersOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40, minWidth: '190px', padding: '6px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(6,10,20,0.98)', backdropFilter: 'blur(12px)', boxShadow: '0 18px 44px rgba(0,0,0,0.44)', display: 'grid', gap: '3px' }}>
                    {ADVANCED_FILTER_CHIPS.map(chip => (
                      <button
                        key={chip.key}
                        onClick={() => { setActiveFilter(chip.key); setAdvancedFiltersOpen(false) }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                          padding: '7px 9px', borderRadius: '8px', border: 'none', textAlign: 'left',
                          background: chip.key === activeFilter ? 'rgba(45,212,191,0.12)' : 'transparent',
                          color: chip.key === activeFilter ? '#2DD4BF' : '#cbd5e1',
                          fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.02em',
                          fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
                        }}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          </>
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

            {!loading && tokens.length === 0 && !error && <EmptyFeed limited={Boolean(data?.limitedLiveFeed)} holderCheckBudgetExhausted={Boolean(data?.holderCheckBudgetExhausted)} discoveryDegradedSignificant={Boolean(data?.discoveryDegradedSignificant)} sourcesFailedCount={data?.sourcesFailedCount ?? 0} pagesAttempted={data?.baseRadarSourceAudit?.sourcesAttempted ?? 0} rawCandidatesRecovered={data?.baseRadarCandidateGateAudit?.rawCandidatesFetched ?? 0} finalState={data?.finalState} userVisibleError={data?.baseRadarLoadAudit?.userVisibleError} />}

            {!loading && tokens.length > 0 && Boolean(data?.limitedLiveFeed) && (
              <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.20)', color: '#fbbf24', fontSize: '11px', marginBottom: '12px', fontFamily: 'var(--font-plex-mono)' }}>
                Radar data partial — some metrics unavailable. Showing {filteredAndSortedTokens.length} result{filteredAndSortedTokens.length === 1 ? '' : 's'}.
              </div>
            )}

            {!loading && tokens.length > 0 && filteredAndSortedTokens.length === 0 && (
              <div style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', padding: '16px', fontFamily: 'var(--font-plex-mono)', fontSize: '12px', color: '#64748b' }}>
                No pools match the current filter.
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {filteredAndSortedTokens.map((token, i) => (
                <TokenCard
                  key={token.contract}
                  token={token}
                  index={i}
                  onScan={() => openToken(token.contract)}
                  onAskCortex={() => askCortex(token)}
                  onOpenOverview={() => openProjectOverview(token)}
                  onTrackToggle={() => void toggleTrack(token)}
                  onPreload={() => preloadProjectOverview(token)}
                  tracking={isWatched(token.contract)}
                />
              ))}
            </div>

            {!loading && filteredAndSortedTokens.length <= 2 && !error && <LowActivityPanel />}

            {!loading && tokens.length > 0 && data?.hasMore && (
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button
                  onClick={() => { setLoadMoreExhausted(false); setLoadMoreRateLimited(false); void handleLoadMore() }}
                  disabled={loadingMore || loadingAll || loadMoreCooldownRemaining > 0}
                  title={loadMoreCooldownRemaining > 0 ? 'Each Load More click fetches a brand-new page from GeckoTerminal — this short pause stops rapid re-clicks from tripping its rate limit.' : undefined}
                  style={{
                    flex: 1, padding: '11px', borderRadius: '10px',
                    border: '1px solid rgba(45,212,191,0.24)', background: (loadingMore || loadingAll || loadMoreCooldownRemaining > 0) ? 'rgba(45,212,191,0.04)' : 'rgba(45,212,191,0.07)',
                    color: (loadingMore || loadingAll || loadMoreCooldownRemaining > 0) ? 'rgba(153,246,228,0.5)' : '#99f6e4', fontSize: '11px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)',
                    cursor: (loadingMore || loadingAll || loadMoreCooldownRemaining > 0) ? 'not-allowed' : 'pointer', transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {loadingMore ? 'Loading…' : loadMoreCooldownRemaining > 0 ? `Wait ${loadMoreCooldownRemaining}s` : 'Load More'}
                </button>
                <button
                  onClick={() => void handleLoadAll()}
                  disabled={loadingMore || loadingAll || loadMoreCooldownRemaining > 0}
                  title={loadMoreCooldownRemaining > 0 ? 'Each Load More click fetches a brand-new page from GeckoTerminal — this short pause stops rapid re-clicks from tripping its rate limit.' : "Automatically loads every remaining page, 2 minutes apart so each page gets a real chance to clear GeckoTerminal's rate limit."}
                  style={{
                    flex: 1, padding: '11px', borderRadius: '10px',
                    border: '1px solid rgba(45,212,191,0.24)', background: (loadingMore || loadingAll || loadMoreCooldownRemaining > 0) ? 'rgba(45,212,191,0.04)' : 'rgba(45,212,191,0.07)',
                    color: (loadingMore || loadingAll || loadMoreCooldownRemaining > 0) ? 'rgba(153,246,228,0.5)' : '#99f6e4', fontSize: '11px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)',
                    cursor: (loadingMore || loadingAll || loadMoreCooldownRemaining > 0) ? 'not-allowed' : 'pointer', transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {loadingAll ? (loadAllProgress ? `Page ${loadAllProgress.page}/5 — waiting for rate limit…` : 'Loading…') : loadMoreCooldownRemaining > 0 ? `Wait ${loadMoreCooldownRemaining}s` : 'Load All (~8 min)'}
                </button>
              </div>
            )}
            {!loading && !loadingMore && !loadingAll && loadMoreExhausted && (
              <p style={{ margin: '8px 0 0', fontSize: '10.5px', color: '#64748b', textAlign: 'center', fontFamily: 'var(--font-plex-mono)' }}>
                No more candidates passed the $50K+ valuation / real liquidity gate in this cycle.
              </p>
            )}
            {!loading && !loadingMore && !loadingAll && loadMoreRateLimited && (
              <p style={{ margin: '8px 0 0', fontSize: '10.5px', color: '#f59e0b', textAlign: 'center', fontFamily: 'var(--font-plex-mono)' }}>
                GeckoTerminal rate-limited this page — not exhausted, just throttled. Wait about 2 minutes and try Load More again.
              </p>
            )}

            {/* FIND-NEW-TOKENS BUTTON, DISCLOSED (explicitly requested: "a button at the bottom to
                find new tokens cause a lot are the same tokens from days ago") — always visible
                once the feed has loaded at least once, independent of Load More's hasMore state,
                since it queries a distinct source (new_pools only, see handleFindNewTokens above)
                rather than paginating deeper into the same mixed discovery. */}
            {!loading && tokens.length > 0 && (
              <div style={{ marginTop: '10px' }}>
                <button
                  onClick={() => void handleFindNewTokens()}
                  disabled={findingNew}
                  style={{
                    width: '100%', padding: '11px', borderRadius: '10px',
                    border: '1px solid rgba(167,139,250,0.28)', background: findingNew ? 'rgba(167,139,250,0.05)' : 'rgba(167,139,250,0.08)',
                    color: findingNew ? 'rgba(196,181,253,0.5)' : '#c4b5fd', fontSize: '11px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)',
                    cursor: findingNew ? 'not-allowed' : 'pointer', transition: 'background 0.15s, color 0.15s',
                  }}
                  title="Checks only the freshest new-pool listings — skips trending/volume sources, which tend to resurface the same established tokens."
                >
                  {findingNew ? 'Finding New Tokens…' : '+ Find New Tokens'}
                </button>
                {findNewExhausted && (
                  <p style={{ margin: '8px 0 0', fontSize: '10.5px', color: '#64748b', textAlign: 'center', fontFamily: 'var(--font-plex-mono)' }}>
                    No new tokens beyond what&apos;s already shown cleared the gate this check.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="radar-stats" style={{ position: 'sticky', top: '0' }}>
            <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 10px' }}>
              CORTEX Panel
            </p>
            <CortexRadarPanel summary={summary} topTokens={filteredAndSortedTokens} onRescan={handleManualRefresh} chain={effectiveRadarChain} />
            <div style={{ height: '12px' }} />
            <WatchlistPanel tokens={watchlistTokens} loading={watchlistLoading} onOpen={openWatchlistToken} onRemove={removeFromWatchlist} />
            <div style={{ height: '12px' }} />
            <StatsPanel summary={summary} fetchedAt={data?.fetchedAt ?? null} loading={loading} showUpsell={showUpsell} />
          </div>
        </div>
      </div>

      {/* QUICK-PREVIEW-THEN-FULL-REPORT, DISCLOSED (Radar token detail UX polish task): the
          preview renders whenever a token is selected and the full report isn't open — clicking
          "Open Full Report" swaps to the real ProjectOverviewDrawer (mode="full") with the exact
          same data; closing the full report returns straight to the feed (matches the explicit
          "close/back returns to feed" acceptance criterion) rather than back to the preview. */}
      {selectedToken && (
        <QuickPreviewPanel
          token={selectedToken}
          chain={effectiveRadarChain}
          open={drawerOpen && !fullReportOpen}
          tracking={isWatched(selectedToken.contract)}
          onTrackToggle={() => void toggleTrack(selectedToken)}
          onScan={() => openToken(selectedToken.contract, effectiveRadarChain)}
          onOpenFullReport={() => setFullReportOpen(true)}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      <ProjectOverviewDrawer
        token={selectedToken}
        open={fullReportOpen}
        mode="full"
        // CHAIN-PROP-NEVER-PASSED, DISCLOSED (bug hunt, self-caught while wiring Robinhood chain
        // support into the drawer): this prop was never actually passed here — it silently defaulted
        // to 'base' every time regardless of which tab was active, so opening the drawer for a
        // Robinhood token would request /api/base-radar/enrichment?...&chain=base, quietly looking up
        // the WRONG chain's contract instead of erroring or working correctly.
        chain={effectiveRadarChain}
        onClose={() => { setFullReportOpen(false); setDrawerOpen(false) }}
        onSimulationUpdate={handleDrawerSimulationUpdate}
        tracking={selectedToken ? isWatched(selectedToken.contract) : false}
        onTrackToggle={selectedToken ? () => void toggleTrack(selectedToken) : undefined}
      />
    </>
  )
}

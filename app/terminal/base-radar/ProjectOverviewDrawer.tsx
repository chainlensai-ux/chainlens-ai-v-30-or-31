'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { assessBaseRadarSeverity, creatorTopHolderDisplay, normalizePairCreatedAt, ageLabelFromIso, extractLpControllerSharePercent, getBaseRadarDetailSeverityCap, getScoreSeverityLabel } from '@/lib/baseRadarSeverity'
import { getRadarDrawerValuation, getRadarValuationCardDisplay, DEFAULT_RADAR_MIN_LIQUIDITY_USD } from '@/lib/baseRadarValuation'
import { getRadarValuationEvidence, getRadarSocialsEvidence, getRadarOwnershipEvidence, getRadarPastLaunchesEvidence, getRadarRugHistoryEvidence, getRadarSimulationEvidence, getRadarAgeEvidence, getRadarLpPositionEvidence, type RadarEvidenceEntry } from '@/lib/baseRadarEvidence'
import { buildBaseRadarDisplayModel } from '@/lib/baseRadarDisplayModel'
import { buildRadarSignals, buildWhyItMatters, buildRadarTimeline, buildNextFiveMinuteRead } from '@/lib/baseRadarSignals'
import WhyItMattersBox from './WhyItMattersBox'
import TimelineMiniChart from './TimelineMiniChart'
import SignalsSidebar from './SignalsSidebar'
import NextFiveMinuteCard from './NextFiveMinuteCard'

// ROBINHOOD-CHAIN-SUPPORT, DISCLOSED (explicitly confirmed: "yes the token scanner works with
// robinhood"). Explorer URL is real and verified — robinhoodchain.blockscout.com, the official
// Blockscout-powered explorer for Robinhood Chain (chain id 4663) — not guessed.
type ChainKey = 'base' | 'eth' | 'robinhood'

type RadarDrawerToken = {
  name: string
  symbol: string
  contract: string
  ageMinutes: number
  liquidityUsd: number
  volume24h: number
  fdvUsd?: number | null
  marketCapUsd?: number | null
  marketCapStatus?: string | null
  valuationBasis?: 'verified_market_cap' | 'fdv_fallback' | 'unavailable'
  valuationUsd?: number | null
  valuationLabel?: string | null
  valuationVerified?: boolean
  valuationReason?: string | null
  valuationCortexLine?: string | null
  evidenceGaps?: string[]
  radarScore: number
  momentum: string
  flags: string[]
  status: string
  clarkSignal?: string | null
  clarkVerdict?: string | null
  simulationStatus?: 'passed' | 'open_check'
  simulationReason?: string | null
  simulationLabel?: string | null
  simulationCortexLine?: string | null
}

type DrawerSimulationPayload = {
  simulationStatus: 'passed' | 'open_check'
  simulationReason?: string | null
  simulationLabel?: string | null
  simulationCortexLine?: string | null
  buySellSimulation?: {
    buyTax?: number | null
    sellTax?: number | null
    slippage?: number | null
    failureRate?: number | null
    isHoneypot?: boolean | null
    simulationSuccess?: boolean | null
    providerStatus?: string | null
  } | null
  riskFlags?: string[]
  security?: { honeypot?: { isHoneypot?: boolean | null; buyTax?: number | null; sellTax?: number | null; simulationSuccess?: boolean | null; failureReason?: string | null } | null; openChecks?: string[] } | null
}

type DrawerProps = {
  token: RadarDrawerToken | null
  open: boolean
  chain?: ChainKey
  onClose: () => void
  onSimulationUpdate?: (address: string, payload: DrawerSimulationPayload) => void
  // ACTION BAR, DISCLOSED (task #3 — "Add Watchlist if existing action exists"): optional pass-
  // through to the SAME toggleTrack()/trackedContracts state the feed's TokenCard "Add to
  // Watchlist" button already uses (app/terminal/base-radar/page.tsx) — no new watchlist logic, just
  // exposing the existing toggle inside the drawer's action bar too. Omitted entirely if the caller
  // doesn't pass them (watchlist.tsx below re-uses this same drawer without tracking wired up).
  tracking?: boolean
  onTrackToggle?: () => void
  // FULL-REPORT-MODE, DISCLOSED (Radar token detail UX polish task, explicitly requested: "Open
  // Full Report... wide readable cards, no cramped narrow text blocks" instead of the existing
  // narrow right-docked panel): 'side' (default, unchanged) keeps every existing caller — this
  // component's own watchlist.tsx usage included — byte-for-byte identical. 'full' only changes
  // this file's OUTER <aside> positioning/size below (a centered, wide modal instead of a
  // right-docked strip); every section/query/render inside the aside is completely untouched, so
  // the "full report" is the exact same real data/evidence this drawer has always shown, just given
  // room to breathe instead of a new report built from scratch.
  mode?: 'side' | 'full'
}

type ApiState<T> = { data?: T; isLoading: boolean; error?: unknown }

type DrawerEnrichmentPayload = {
  name?: string | null
  symbol?: string | null
  market?: {
    liquidityUsd?: number | null
    volume24hUsd?: number | null
    fdvUsd?: number | null
    marketCapUsd?: number | null
    marketCapStatus?: string | null
    marketStatus?: string | null
    marketConfidence?: string | null
    poolCount?: number | null
    observedPoolPresent?: boolean | null
    observedPoolCount?: number | null
    poolCountStatus?: "confirmed" | "inferred_from_primary_pool" | "unknown" | string | null
    poolActivity?: { pairCreatedAt?: string | number | null } | null
  } | null
  lp?: {
    lpLockStatus?: string | null
    lpLockAmount?: number | null
    lpUnlockTime?: string | number | null
    lpController?: string | null
    lpProofStatus?: string | null
    lpProofApplicability?: string | null
    lpControl?: { status?: string | null; confidence?: string | null; reason?: string | null; evidence?: string[] | null } | null
    lpDataMode?: string | null
    lpDataConfidence?: string | null
    lpExitRisk?: string | null
    lpExitRiskReason?: string | null
    liquidityDepthRisk?: string | null
    displayLpModel?: string | null
    lockBurnApplicable?: boolean | null
    lpEvidenceSummary?: string | null
    lockBurnReason?: string | null
    secondaryLpControlSignals?: { status?: string | null; poolDex?: string | null; reason?: string | null } | null
    cortexLpRead?: { liquidityAnalysis?: string | null } | null
    primaryMarketPool?: string | null
    lpModelProof?: { model?: string | null; dexName?: string | null; standardLockApplies?: boolean | null } | null
    lpProofDisplay?: {
      proofLabel?: string | null
      lockStatus?: string | null
      lockAmount?: string | null
      unlockTime?: string | null
      burnProof?: string | null
      controller?: string | null
      exitRisk?: string | null
    } | null
  } | null
  holders?: {
    top1?: number | null
    top10?: number | null
    top20?: number | null
    holderCount?: number | null
    holderCountCapped?: boolean
    holderEvidence?: {
      holderCountStatus: 'exact' | 'minimum' | 'unavailable'
      holderCountExact?: number
      holderCountMinimum?: number
      holderCountDisplay: string
      holderGatePassed: boolean
      holderVerified: boolean
      concentrationStatus: 'resolved' | 'unavailable'
      concentrationProvider?: string | null
      topHolderBalancesResolved?: boolean
      top1Percent?: number
      top10Percent?: number
      top20Percent?: number
      evidenceGaps: string[]
    } | null
    status?: string | null
    reason?: string | null
    confidence?: string | null
    topHolders?: HolderRow[]
    concentration?: string | null
    creatorInTopHolders?: boolean | null
    creatorHolderPercent?: number | null
  } | null
  deployer?: {
    deployerAddress?: string | null
    deployerStatus?: string | null
    deployerConfidence?: string | null
    methodLabel?: string | null
    creationTxHash?: string | null
    pastLaunches?: {
      status?: 'checked' | 'open_check' | string | null
      count?: number | null
      sample?: string[] | null
      reason?: string | null
    } | null
    rugHistory?: {
      verified?: boolean | null
      count?: number | null
      reason?: string | null
    } | null
    clusterEvidence?: {
      confirmed?: boolean | null
      edgeCount?: number | null
      nodeCount?: number | null
      devClusterSupplyPercent?: number | null
      linkedWalletSupplyPercent?: number | null
      matchedLinkedWallets?: number | null
      reason?: string | null
    } | null
    supplyControl?: { status?: string | null; reason?: string | null; linkedWalletSupplyPercent?: number | null } | null
    linkedWallets?: unknown[]
    creatorInTopHolders?: boolean | null
    creatorHolderPercent?: number | null
    reason?: string | null
  } | null
  security?: {
    honeypot?: { isHoneypot?: boolean | null; buyTax?: number | null; sellTax?: number | null; simulationSuccess?: boolean | null } | null
    contractFlags?: Record<string, unknown> | null
    devOwnership?: {
      ownerAddress?: string | null
      adminAddress?: string | null
      isRenounced?: boolean | null
      ownershipVerified?: boolean | null
      ownershipStatus?: 'renounced' | 'active_owner' | 'open_check' | string | null
      ownershipLabel?: string | null
    } | null
    riskDrivers?: string[]
    openChecks?: string[]
  } | null
  socials?: {
    website?: string | null
    twitter?: string | null
    telegram?: string | null
    status?: string | null
    reason?: string | null
  } | null
  priceChart?: { points?: ChartPoint[]; timeframe?: string | null } | null
  status?: string | null
  error?: string | null
  diagnostics?: Record<string, unknown>
}

type HolderRow = { rank?: number | null; address?: string | null; percent?: number | null; pctOfSupply?: number | null; isContract?: boolean | null; walletType?: string | null }
type ChartPoint = { timestamp: number | string; price?: number | null; close?: number | null; value?: number | null }

const CHAIN_LABEL: Record<ChainKey, string> = {
  base: 'Base',
  eth: 'ETH',
  robinhood: 'Robinhood',
}

export const EXPLORER: Record<ChainKey, string> = {
  base: 'https://basescan.org',
  eth: 'https://etherscan.io',
  // Verified via web search, not guessed: official Blockscout-powered explorer for Robinhood Chain.
  robinhood: 'https://robinhoodchain.blockscout.com',
}

// GeckoTerminal confirmed to index Robinhood as network slug 'robinhood' (same session, verified
// live via geckoterminal.com/robinhood/pools and DexScreener's own chainId:"robinhood" data).
const GT_NETWORK: Record<ChainKey, string> = {
  base: 'base',
  eth: 'eth',
  robinhood: 'robinhood',
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : `Request failed (${res.status})`)
  return json as T
}

function fmtUSD(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'N/A'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function fmtAge(minutes: number): string {
  if (!Number.isFinite(minutes)) return 'N/A'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function shortAddr(addr: string | null | undefined): string {
  if (!addr) return 'N/A'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function asLink(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null
}

function percent(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? 'N/A' : `${v.toFixed(1)}%`
}

function getHolderPercent(holder: HolderRow): number | null {
  const value = holder.percent ?? holder.pctOfSupply ?? null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function evidenceLabel(value: string | null | undefined, fallback = 'Open Check'): string {
  if (!value) return fallback
  return publicStatus(value)
}

function publicStatus(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function controllerLabel(controller: string | null | undefined, lpStatus: string | null): string {
  if (lpStatus === 'team_controlled') return controller ? `Wallet controlled · ${shortAddr(controller)}` : 'Wallet controlled'
  if (lpStatus === 'burned') return 'Burn controlled'
  if (lpStatus === 'locked') return controller ? `Lock controlled · ${shortAddr(controller)}` : 'Lock controlled'
  if (lpStatus === 'protocol' || lpStatus === 'concentrated_liquidity') return 'Protocol / pool controlled'
  return controller ? shortAddr(controller) : 'Open Check'
}

function hasVerifiedLock(lockStatus: string | null | undefined): boolean {
  return lockStatus === 'locked' || lockStatus === 'burned'
}

function lockStatusLabel(status: string | null | undefined, proofStatus: string | null | undefined, applicability?: string | null): string {
  if (applicability === 'not_applicable') return 'Not applicable'
  if (status === 'locked') return 'Locked'
  if (status === 'burned') return 'Burned'
  if (status === 'unlocked' || status === 'unverified' || proofStatus === 'missing' || proofStatus === 'partial') return 'No verified lock'
  return 'Open Check'
}

function proofLabel(status: string | null | undefined, applicability: string | null | undefined): string {
  if (applicability === 'not_applicable') return 'Not applicable for this pool model'
  if (status === 'confirmed') return 'Confirmed lock/burn proof'
  if (status === 'partial') return 'No verified lock/burn proof'
  if (status === 'missing') return 'No verified lock/burn proof'
  if (applicability === 'unknown') return 'Open Check · proof model unavailable'
  return 'Open Check'
}

function lockAmountLabel(amount: number | null | undefined, lockStatus: string | null | undefined, proofStatus: string | null | undefined, applicability?: string | null): string {
  if (applicability === 'not_applicable') return 'Not applicable to this pool model'
  if (amount != null && Number.isFinite(amount)) return String(amount)
  if (!hasVerifiedLock(lockStatus) && (lockStatus || proofStatus === 'missing' || proofStatus === 'partial')) return 'No verified lock'
  return 'Open Check'
}

function unlockTimeLabel(value: string | number | null | undefined, lockStatus?: string | null, proofStatus?: string | null, applicability?: string | null): string {
  if (applicability === 'not_applicable') return 'Not applicable to this pool model'
  if (!hasVerifiedLock(lockStatus) && (lockStatus || proofStatus === 'missing' || proofStatus === 'partial')) return 'Not applicable until lock is verified'
  if (value == null) return 'Open Check'
  const millis = typeof value === 'number' ? (value > 10_000_000_000 ? value : value * 1000) : Date.parse(value)
  return Number.isFinite(millis) ? new Date(millis).toUTCString() : 'Open Check'
}

const LP_EXIT_RISK_LABELS: Record<string, string> = {
  low: 'Low exit risk',
  monitor: 'Monitor',
  watch: 'Watch',
  medium: 'Medium exit risk',
  high: 'High exit risk',
  open_check: 'Open Check',
}

function lpRiskLabel(lpStatus: string | null, controller: string | null | undefined, lockStatus: string | null | undefined, providedReason?: string | null, exitRisk?: string | null): string {
  if (lpStatus === 'team_controlled' && controller && !hasVerifiedLock(lockStatus)) {
    return 'High exit risk — Single wallet controls the detected LP position. No verified lock or burn proof was found.'
  }
  if (exitRisk && providedReason) {
    const prefix = LP_EXIT_RISK_LABELS[exitRisk] ?? publicStatus(exitRisk)
    return providedReason.toLowerCase().startsWith(prefix.toLowerCase()) ? providedReason : `${prefix} — ${providedReason}`
  }
  if (providedReason && !(/open check/i.test(providedReason) && lpStatus === 'team_controlled' && controller)) return providedReason
  if (lpStatus === 'team_controlled') return 'High exit risk — LP appears wallet controlled and no verified lock or burn proof was found.'
  if (lockStatus === 'locked' || lockStatus === 'burned') return 'Lower exit-liquidity risk from current LP proof.'
  if (lpStatus === 'concentrated_liquidity') return 'Monitor — standard LP token lock proof may not apply; check position controls.'
  return 'Open Check — LP lock, burn, and controller evidence are not confirmed.'
}

function publicMethodLabel(method: string | null | undefined): string {
  if (!method) return 'Open Check'
  const normalized = method.toLowerCase()
  if (normalized.includes('creation')) return 'Contract creation evidence'
  if (normalized.includes('initial')) return 'Initial supply-flow evidence'
  if (normalized.includes('activity')) return 'Earliest contract-activity evidence'
  return 'On-chain evidence'
}

function clusterEvidenceLabel(cluster: NonNullable<DrawerEnrichmentPayload['deployer']>['clusterEvidence']): string {
  if (!cluster?.confirmed) return cluster?.reason ?? 'No confirmed cluster links in current evidence'
  const supply = percent(cluster.devClusterSupplyPercent ?? null)
  return `Confirmed evidence · ${supply}`
}

function holderStatus(status: string | null | undefined, confidence: string | null | undefined, reason: string | null | undefined): string {
  if (status === 'ok') return confidence ? `Verified · ${confidence}` : 'Verified'
  if (status === 'partial') return confidence ? `Limited Evidence · ${confidence}` : 'Limited Evidence'
  if (reason) return 'Limited Evidence'
  return 'Open Check'
}

function concentrationRiskLabel(top10: number | null | undefined, top20: number | null | undefined, fallback: string | null | undefined): string {
  const hasTop10 = top10 != null && Number.isFinite(top10)
  const hasTop20 = top20 != null && Number.isFinite(top20)
  if (hasTop10 || hasTop20) {
    if ((hasTop10 && top10 >= 80) || (hasTop20 && top20 >= 90)) return 'Extreme'
    if (hasTop10 && top10 >= 60) return 'High'
    if (hasTop10 && top10 >= 40) return 'Medium'
    return 'Lower'
  }
  return fallback ? publicStatus(fallback) : 'Open Check'
}

function lpDataModeLabel(mode: string | null | undefined, confidence: string | null | undefined): string {
  return `${mode ? publicStatus(mode) : 'Fallback'} · ${confidence ?? 'limited'}`
}

const DISPLAY_LP_MODEL_LABELS: Record<string, string> = {
  erc20_lp_token: 'Standard ERC-20 LP token',
  concentrated_liquidity: 'Concentrated liquidity position',
  protocol_or_gauge: 'Protocol / gauge-controlled liquidity',
  open_check: 'Open Check',
  no_pool: 'No pool detected',
}

function displayLpModelLabel(model: string | null | undefined): string {
  if (!model) return 'Open Check'
  return DISPLAY_LP_MODEL_LABELS[model] ?? publicStatus(model)
}

// REPORT-SHELL POLISH, DISCLOSED (Base Radar drawer premium polish task): calmer, thinner border
// and a flat background instead of the previous heavy gradient + 50px drop shadow repeated on
// every single card — with a dozen-plus sections stacked in one drawer, that shadow/gradient
// repetition was the biggest driver of the "stacked cards" feel the task asked to fix. Content and
// props are unchanged; only the card chrome is lighter.
function Section({ title, state, children, tone = 'default' }: { title: string; state?: ApiState<unknown>; children: React.ReactNode; tone?: 'default' | 'risk' | 'mint' | 'purple' | 'amber' }) {
  const loading = state?.isLoading
  const accent = tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : tone === 'purple' ? '#a78bfa' : '#2dd4bf'
  return (
    <section style={{ border: `1px solid ${tone === 'default' ? 'rgba(148,163,184,0.10)' : `${accent}28`}`, background: 'rgba(15,23,42,0.40)', borderRadius: '16px', padding: '16px', marginBottom: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px' }}>
        <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}><span style={{ color: accent }}>◆</span> {title}</h3>
        {state?.error ? <span style={{ color: '#fbbf24', fontSize: '9px', fontFamily: 'var(--font-plex-mono)' }}>Limited</span> : null}
      </div>
      {loading ? <SkeletonRows /> : children}
    </section>
  )
}

// ACCORDION, DISCLOSED (task #7 — grouped/collapsible lower sections): a lighter-weight sibling of
// Section for the deeper-evidence sections below the fold. Uses a top divider instead of its own
// bordered box (further reducing border repetition across the report) and is driven entirely by
// the `open`/`onToggle` props the drawer passes in — see the drawer's own `sectionOpen()`/
// `toggleSection()` helpers for how each section's default (open vs. collapsed) is decided. Content
// is always reachable via the toggle; nothing here is ever permanently hidden.
function CollapsibleSection({ id, title, tone = 'default', open, onToggle, state, badge, children }: { id: string; title: string; tone?: 'default' | 'risk' | 'mint' | 'amber' | 'purple'; open: boolean; onToggle: (id: string) => void; state?: ApiState<unknown>; badge?: React.ReactNode; children: React.ReactNode }) {
  const accent = tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : tone === 'purple' ? '#a78bfa' : tone === 'mint' ? '#2dd4bf' : '#64748b'
  return (
    <section style={{ borderTop: '1px solid rgba(148,163,184,0.10)', paddingTop: '14px', marginTop: '14px' }}>
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '10px' }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ color: accent, fontSize: '12px', flexShrink: 0 }}>◆</span>
          <span style={{ color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', fontWeight: 800 }}>{title}</span>
          {badge}
          {state?.error ? <span style={{ color: '#fbbf24', fontSize: '9px', fontFamily: 'var(--font-plex-mono)' }}>Limited</span> : null}
        </span>
        <span aria-hidden style={{ color: '#64748b', fontSize: '11px', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</span>
      </button>
      {open ? <div style={{ marginTop: '12px' }}>{state?.isLoading ? <SkeletonRows /> : children}</div> : null}
    </section>
  )
}

// WARNING-EMPHASIS FIX, DISCLOSED (task #6 — "emphasize important warnings, not every card
// equally"): every metric card used to get the same colored-gradient-border treatment regardless of
// tone, so a routine "Age" card looked exactly as visually loud as a genuine liquidity warning.
// Only risk/amber (warning) cards now keep a colored border + tint; mint/neutral/purple cards drop
// to the same calm slate card so real warnings actually stand out. Values/labels/sublabels unchanged.
function MetricCard({ label, value, sublabel, chip, tone = 'mint' }: { label: string; value: React.ReactNode; sublabel?: React.ReactNode; chip?: string; tone?: 'mint' | 'amber' | 'risk' | 'neutral' | 'purple' }) {
  const color = tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : tone === 'purple' ? '#a78bfa' : tone === 'neutral' ? '#94a3b8' : '#2dd4bf'
  const isWarning = tone === 'risk' || tone === 'amber'
  return <div style={{ minWidth: 0, border: isWarning ? `1px solid ${color}40` : '1px solid rgba(148,163,184,0.12)', background: isWarning ? `linear-gradient(180deg, ${color}12, rgba(15,23,42,0.58))` : 'rgba(15,23,42,0.42)', borderRadius: '14px', padding: '12px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 8 }}><span style={{ color: '#94a3b8', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 800 }}>{label}</span>{chip ? <Chip label={chip} tone={tone} /> : null}</div>
    <div style={{ color: isWarning ? color : '#f8fafc', fontSize: 22, lineHeight: 1, fontWeight: 850, letterSpacing: '-.03em', overflowWrap: 'anywhere' }}>{value}</div>
    {sublabel ? <div style={{ marginTop: 7, color: '#94a3b8', fontSize: 11, lineHeight: 1.35 }}>{sublabel}</div> : null}
  </div>
}

function Chip({ label, tone = 'neutral' }: { label: React.ReactNode; tone?: 'mint' | 'amber' | 'risk' | 'neutral' | 'purple' }) {
  const color = tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : tone === 'purple' ? '#a78bfa' : tone === 'mint' ? '#2dd4bf' : '#94a3b8'
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 999, border: `1px solid ${color}33`, background: `${color}12`, color, fontSize: 9, fontWeight: 850, letterSpacing: '.08em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}><span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />{label}</span>
}

function ProofTile({ label, value, tone = 'neutral' }: { label: string; value: React.ReactNode; tone?: 'mint' | 'amber' | 'risk' | 'neutral' | 'purple' }) {
  return <div style={{ border: '1px solid rgba(148,163,184,.12)', background: 'rgba(2,6,23,.42)', borderRadius: 13, padding: 10 }}><div style={{ color: '#64748b', fontSize: 10, marginBottom: 5 }}>{label}</div><div style={{ color: tone === 'risk' ? '#fecaca' : tone === 'amber' ? '#fde68a' : '#e2e8f0', fontSize: 12, fontWeight: 750, lineHeight: 1.3 }}>{value}</div></div>
}

function MiniBar({ label, value, tone = 'mint' }: { label: string; value: number | null | undefined; tone?: 'mint' | 'amber' | 'risk' }) {
  const n = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value))
  const color = tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : '#2dd4bf'
  return <div><div style={{ display: 'flex', justifyContent: 'space-between', color: '#cbd5e1', fontSize: 11, marginBottom: 6 }}><span>{label}</span><span style={{ fontFamily: 'var(--font-plex-mono)', color }}>{value == null ? 'N/A' : `${value.toFixed(1)}%`}</span></div><div style={{ height: 8, borderRadius: 999, background: 'rgba(148,163,184,.12)', overflow: 'hidden' }}><div style={{ width: `${n}%`, height: '100%', background: `linear-gradient(90deg, ${color}, ${tone === 'risk' ? '#a78bfa' : '#99f6e4'})`, borderRadius: 999 }} /></div></div>
}

function SkeletonRows() {
  return (
    <div style={{ display: 'grid', gap: '8px' }}>
      {[0, 1, 2].map((i) => <div key={i} style={{ height: '18px', borderRadius: '8px', background: 'linear-gradient(90deg, rgba(255,255,255,0.04), rgba(45,212,191,0.07), rgba(255,255,255,0.04))' }} />)}
    </div>
  )
}

function DataRow({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ color: '#64748b', fontSize: '11px' }}>{label}</span>
      <span style={{ color: '#e2e8f0', fontSize: '11px', textAlign: 'right', fontFamily: mono ? 'var(--font-plex-mono)' : undefined }}>{value}</span>
    </div>
  )
}


function MiniChart({ points }: { points: ChartPoint[] }) {
  const values = points.map((p) => Number(p.close ?? p.price ?? p.value)).filter(Number.isFinite)
  const stats = useMemo(() => {
    if (values.length === 0) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const current = values[values.length - 1]
    const spread = max - min
    const coords = values.map((v, i) => {
      const x = 14 + (i / Math.max(values.length - 1, 1)) * 292
      const y = spread === 0 ? 58 : 88 - ((v - min) / spread) * 64
      return { x, y }
    })
    const line = coords.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ')
    const area = `${line} L306 104 L14 104 Z`
    return { min, max, current, line, area, flat: spread === 0 }
  }, [values])

  if (values.length < 4 || !stats) {
    return <div style={{ minHeight: 112, borderRadius: 16, border: '1px solid rgba(148,163,184,.12)', background: 'linear-gradient(180deg, rgba(15,23,42,.72), rgba(2,6,23,.55))', display: 'grid', placeItems: 'center', padding: 16 }}><p style={{ color: '#94a3b8', fontSize: 12, margin: 0, textAlign: 'center' }}>Limited chart history — pool is very new.</p></div>
  }

  return (
    <div style={{ borderRadius: 16, border: '1px solid rgba(45,212,191,0.14)', background: 'linear-gradient(180deg, rgba(15,23,42,0.78), rgba(2,6,23,0.56))', padding: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8, color: '#94a3b8', fontSize: 10, fontFamily: 'var(--font-plex-mono)' }}>
        <span>Min {fmtUSD(stats.min)}</span><span style={{ color: '#99f6e4' }}>Now {fmtUSD(stats.current)}</span><span>Max {fmtUSD(stats.max)}</span>
      </div>
      <svg viewBox="0 0 320 112" width="100%" height="150" role="img" aria-label="Token mini chart" className="radar-mini-chart-svg" style={{ display: 'block', maxHeight: 150 }}>
        <defs>
          <linearGradient id="radarChartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.20" /><stop offset="100%" stopColor="#2DD4BF" stopOpacity="0.02" /></linearGradient>
          <filter id="radarChartGlow"><feGaussianBlur stdDeviation="2.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {[24, 48, 72, 96].map((y) => <line key={y} x1="12" x2="308" y1={y} y2={y} stroke="rgba(148,163,184,.10)" strokeWidth="1" />)}
        <path d={stats.area} fill="url(#radarChartFill)" stroke="none" />
        <path d={stats.line} fill="none" stroke="#2DD4BF" strokeWidth={stats.flat ? 2 : 2.4} strokeLinecap="round" strokeLinejoin="round" filter="url(#radarChartGlow)" />
        <circle cx="306" cy={stats.line.match(/ ([0-9.]+)$/)?.[1] ?? 58} r="3.5" fill="#99f6e4" />
      </svg>
      {stats.flat ? <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 11 }}>Flat price action in the available window.</p> : null}
    </div>
  )
}

export default function ProjectOverviewDrawer({ token, open, chain = 'base', onClose, onSimulationUpdate, tracking, onTrackToggle, mode = 'side' }: DrawerProps) {
  const isFull = mode === 'full'
  const address = token?.contract ?? ''
  const enabled = open && Boolean(address)
  const query = address ? `contract=${encodeURIComponent(address)}&chain=${chain}` : ''
  const simulationQuery = address ? `address=${encodeURIComponent(address)}&chain=${chain}&liquidityUsd=${encodeURIComponent(String(token?.liquidityUsd ?? ''))}` : ''

  const simulation = useQuery({
    queryKey: ['base-radar-drawer-simulation', chain, address, token?.liquidityUsd ?? null],
    queryFn: () => fetchJson<DrawerSimulationPayload>(`/api/radar/simulation?${simulationQuery}`),
    enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (address && simulation.data) onSimulationUpdate?.(address, simulation.data)
  }, [address, onSimulationUpdate, simulation.data])

  const enrichment = useQuery({
    queryKey: ['base-radar-drawer-enrichment', chain, address],
    queryFn: () => fetchJson<DrawerEnrichmentPayload>(`/api/base-radar/enrichment?${query}`),
    enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  })

  const enrichmentState: ApiState<unknown> = { data: enrichment.data, isLoading: enrichment.isLoading, error: enrichment.error }
  const enriched = useMemo(() => {
    if (!enrichment.data && !simulation.data?.security) return enrichment.data
    return {
      ...(enrichment.data ?? {}),
      security: {
        ...(enrichment.data?.security ?? {}),
        ...(simulation.data?.security ?? {}),
        honeypot: simulation.data?.security?.honeypot ?? enrichment.data?.security?.honeypot,
        openChecks: simulation.data?.simulationStatus === 'passed' ? [] : (enrichment.data?.security?.openChecks ?? simulation.data?.security?.openChecks),
      },
    } as DrawerEnrichmentPayload
  }, [enrichment.data, simulation.data])
  const socials = enriched?.socials ?? {}
  const dexScreener = address ? `https://dexscreener.com/${chain}/${address}` : null
  const geckoTerminal = address ? `https://www.geckoterminal.com/${GT_NETWORK[chain]}/tokens/${address}` : null
  const explorer = address ? `${EXPLORER[chain]}/token/${address}` : null
  const socialLinks = [asLink(socials.website), asLink(socials.twitter), asLink(socials.telegram), dexScreener, geckoTerminal, explorer].filter((link): link is string => Boolean(link))
  const chartPoints = enriched?.priceChart?.points ?? []
  const lp = enriched?.lp
  const market = enriched?.market
  const concentration = enriched?.holders ?? {}
  const topHolders = enriched?.holders?.topHolders ?? []
  const deployer = enriched?.deployer
  const security = enriched?.security

  const lpProofDisplay = lp?.lpProofDisplay ?? null
  const lpControlStatus = lp?.lpControl?.status ?? null
  const lpControllerLabel = lpProofDisplay?.controller ?? controllerLabel(lp?.lpController, lpControlStatus)
  const lpLockStatusLabel = lpProofDisplay?.lockStatus ?? lockStatusLabel(lp?.lpLockStatus, lp?.lpProofStatus, lp?.lpProofApplicability)
  const lpProofLabel = lpProofDisplay?.proofLabel ?? proofLabel(lp?.lpProofStatus, lp?.lpProofApplicability)
  const lpRiskLabelValue = lpProofDisplay?.exitRisk ?? lpRiskLabel(lpControlStatus, lp?.lpController, lp?.lpLockStatus, lp?.lpExitRiskReason, lp?.lpExitRisk)
  const concentrationRisk = concentrationRiskLabel(concentration.top10, concentration.top20, concentration.concentration)
  const clusterLabel = clusterEvidenceLabel(deployer?.clusterEvidence)
  const deployerMethod = publicMethodLabel(deployer?.methodLabel)
  const holderStatusLabel = holderStatus(concentration.status, concentration.confidence, concentration.reason)
  const ownershipLabel = security?.devOwnership?.ownershipLabel ?? (security?.devOwnership?.ownershipVerified === true && security.devOwnership.isRenounced === true ? 'Renounced ownership' : security?.devOwnership?.ownershipVerified === true && (security.devOwnership.ownerAddress || security.devOwnership.adminAddress) ? 'Active owner/admin verified' : 'Open Check / Not verified')

  const normalizedPairCreatedAt = normalizePairCreatedAt(market?.poolActivity?.pairCreatedAt ?? null)
  const pairAgeLabel = ageLabelFromIso(normalizedPairCreatedAt)
  const poolAgeMinutes = Number.isFinite(token?.ageMinutes) ? token!.ageMinutes : null
  const hasSocials = Boolean(asLink(socials.website) || asLink(socials.twitter) || asLink(socials.telegram))

  const lockBurnConfirmed = hasVerifiedLock(lp?.lpLockStatus) || lp?.lpProofApplicability === 'not_applicable'
  const liquidityUsd = market?.liquidityUsd ?? token?.liquidityUsd ?? null
  const creatorHolderPercent = concentration.creatorHolderPercent ?? deployer?.creatorHolderPercent ?? null
  const devClusterSupplyPercent = deployer?.clusterEvidence?.devClusterSupplyPercent ?? null
  const lpControllerSharePercent = extractLpControllerSharePercent(lp?.lpControl?.evidence ?? null)
  const activeOwner = (security?.devOwnership?.ownershipStatus ?? null) === 'active_owner'

  const displayModel = token ? buildBaseRadarDisplayModel(token, enriched) : null

  const severity = assessBaseRadarSeverity({
    baseScore: token?.radarScore ?? 0,
    lpControlStatus: lpControlStatus,
    lpController: lp?.lpController ?? null,
    lockBurnConfirmed,
    lpControlEvidence: lp?.lpControl?.evidence ?? null,
    top1: concentration.top1 ?? null,
    top10: concentration.top10 ?? null,
    top20: concentration.top20 ?? null,
    holderCount: concentration.holderCount ?? null,
    ownershipStatus: security?.devOwnership?.ownershipStatus ?? null,
    hasSocials,
    poolAgeMinutes,
    marketCapUsd: market?.marketCapUsd ?? null,
    fdvUsd: market?.fdvUsd ?? token?.fdvUsd ?? null,
    simulationStatus: displayModel?.simulation.status ?? token?.simulationStatus ?? null,
    lpModelUnknown: (lp?.displayLpModel ?? null) === 'unknown',
    liquidityUsd,
    creatorHolderPercent,
    devClusterSupplyPercent,
  })

  const detailSeverity = getBaseRadarDetailSeverityCap({
    liquidityUsd,
    holderCount: concentration.holderCount ?? null,
    top1: concentration.top1 ?? null,
    top10: concentration.top10 ?? null,
    top20: concentration.top20 ?? null,
    creatorHolderPercent,
    devClusterSupplyPercent,
    lpControllerSharePercent,
    lockBurnConfirmed,
    activeOwner,
  })

  const effectiveScore = displayModel?.score ?? (detailSeverity.cap != null ? Math.min(severity.effectiveScore, detailSeverity.cap) : severity.effectiveScore)
  const severityLabel = displayModel?.riskLabel ?? getScoreSeverityLabel(effectiveScore)

  const marketValuation = getRadarDrawerValuation({
    enrichmentMarketCapUsd: market?.marketCapUsd ?? null,
    enrichmentMarketCapStatus: market?.marketCapStatus ?? null,
    feedMarketCapUsd: token?.marketCapUsd ?? null,
    feedMarketCapStatus: token?.marketCapStatus ?? null,
    fdvUsd: market?.fdvUsd ?? token?.fdvUsd ?? null,
    liquidityUsd,
  })
  const marketValuationCard = displayModel
    ? { label: displayModel.valuation.label === 'Market Cap' ? 'Market cap' : displayModel.valuation.label, value: displayModel.valuation.valueUsd != null ? fmtUSD(displayModel.valuation.valueUsd) : 'Open check', sublabel: displayModel.valuation.sublabel }
    : getRadarValuationCardDisplay(marketValuation, fmtUSD)
  const excludedFromFeed = liquidityUsd != null && liquidityUsd < DEFAULT_RADAR_MIN_LIQUIDITY_USD

  const poolDistributionLine = lp?.cortexLpRead?.liquidityAnalysis ?? (market?.observedPoolPresent
    ? (market?.poolCountStatus === 'confirmed' && market?.observedPoolCount != null
      ? `Observed liquidity is ${fmtUSD(market?.liquidityUsd ?? token?.liquidityUsd)} across ${market.observedPoolCount} tracked pool${market.observedPoolCount === 1 ? '' : 's'}.`
      : 'A primary liquidity pool was detected, but full pool distribution is not fully indexed.')
    : 'No active liquidity pool was confirmed from current evidence.')

  const secondaryLpSignal = lp?.secondaryLpControlSignals
  const secondaryLpLine = secondaryLpSignal?.status === 'team_controlled'
    ? ` A secondary pool${secondaryLpSignal.poolDex ? ` (${secondaryLpSignal.poolDex})` : ''} shows wallet-controlled LP exposure and may carry separate exit risk.`
    : ''

  const lpCortexLine = (lp?.lpProofApplicability === 'not_applicable'
    ? (lp?.lockBurnReason ?? 'The primary pool uses a concentrated-liquidity model, so standard ERC-20 LP lock/burn proof does not apply.')
    : lpControlStatus === 'team_controlled' && lp?.lpController && !hasVerifiedLock(lp?.lpLockStatus)
    ? 'LP holder evidence indicates a single wallet controls the LP position, and no verified lock or burn proof was found.'
    : `LP control is ${lpControlStatus ? publicStatus(lpControlStatus) : 'Open Check'}; ${lpRiskLabelValue}`) + secondaryLpLine
  const holderCortexLine = concentration.top10 != null && Number.isFinite(concentration.top10)
    ? `${concentrationRisk === 'Extreme' ? 'Holder concentration is extreme' : `Holder concentration is ${concentrationRisk.toLowerCase()}`}, with the top 10 holders controlling ${concentration.top10 >= 95 ? 'nearly all indexed supply' : `about ${percent(concentration.top10)} of indexed supply`}.`
    : `Top holder concentration is ${percent(concentration.top10)} for top 10 holders; holder evidence is ${holderStatusLabel}.`
  const cortexRead = [
    severity.cortexSevereLine,
    `${poolDistributionLine} Momentum is ${(token?.momentum ?? 'unknown').toLowerCase()} and radar score is ${effectiveScore}.`,
    token?.valuationCortexLine ?? null,
    lpCortexLine,
    holderCortexLine,
    displayModel?.simulation.cortexLine ?? token?.simulationCortexLine ?? null,
    deployer?.deployerAddress ? `Deployer ${shortAddr(deployer.deployerAddress)} is ${publicStatus(deployer.deployerStatus ?? 'reviewed')} at ${deployer.deployerConfidence ?? 'open-check'} confidence.` : 'Deployer is Open Check in the current evidence.',
    token?.flags?.length ? `Risk context: ${token.flags.join(', ')}.` : 'Risk context: no radar flags on this card.',
  ].filter((line): line is string => Boolean(line))

  // Structured, evidence-first entries (lib/baseRadarEvidence.ts) — one clean item
  // per category (valuation, socials, ownership, deployer past launches, rug
  // history). risk_fact entries are surfaced separately, not as generic open checks.
  const valuationEvidence = getRadarValuationEvidence(marketValuation)
  const socialsEvidence = getRadarSocialsEvidence({
    website: typeof socials.website === 'string' ? socials.website : null,
    twitter: typeof socials.twitter === 'string' ? socials.twitter : null,
    telegram: typeof socials.telegram === 'string' ? socials.telegram : null,
    status: socials.status ?? null,
    reason: socials.reason ?? null,
  })
  const ownershipEvidence = getRadarOwnershipEvidence(security?.devOwnership ?? null)
  const pastLaunchesEvidence = getRadarPastLaunchesEvidence({
    deployerAddress: deployer?.deployerAddress ?? null,
    pastLaunches: deployer?.pastLaunches ?? null,
  })
  const rugHistoryEvidence = getRadarRugHistoryEvidence({
    deployerAddress: deployer?.deployerAddress ?? null,
    rugHistory: deployer?.rugHistory ?? null,
  })
  const simulationEvidence = getRadarSimulationEvidence({
    status: displayModel?.simulation.status ?? token?.simulationStatus ?? null,
    reason: displayModel?.simulation.reason ?? token?.simulationReason ?? null,
  })
  const ageEvidence = getRadarAgeEvidence({ ageMinutes: poolAgeMinutes })
  const lpPositionEvidence = getRadarLpPositionEvidence({
    isConcentrated: lp?.displayLpModel === 'concentrated_liquidity',
    poolId: lp?.primaryMarketPool ?? null,
    dex: lp?.lpModelProof?.dexName ?? null,
    liquidityUsd,
    fmtUSD,
  })

  const structuredEvidence: RadarEvidenceEntry[] = [
    ...(valuationEvidence ? [valuationEvidence] : []),
    socialsEvidence,
    pastLaunchesEvidence,
    rugHistoryEvidence,
    ...(ownershipEvidence ? [ownershipEvidence] : []),
    ...(simulationEvidence ? [simulationEvidence] : []),
    ...(ageEvidence ? [ageEvidence] : []),
    ...(lpPositionEvidence ? [lpPositionEvidence] : []),
  ]
  const riskFacts = structuredEvidence.filter((e) => e.status === 'risk_fact').map((e) => e.label)
  const evidenceGaps: string[] = [
    ...structuredEvidence.filter((e) => e.status !== 'risk_fact').map((e) => e.label),
    ...severity.evidenceGaps,
    ...(token?.evidenceGaps ?? []),
  ]
  if (lp?.lpProofApplicability === 'applicable' && (lp?.lpProofStatus === 'missing' || lp?.lpProofStatus === 'partial')) {
    evidenceGaps.push('No verified lock/burn proof found for the primary LP position.')
  }
  if (lp?.lpProofApplicability === 'unknown') {
    evidenceGaps.push('LP proof model could not be determined from current evidence.')
  }
  if (secondaryLpSignal?.status === 'team_controlled') {
    evidenceGaps.push('Secondary LP exposure detected — a secondary pool shows wallet-controlled liquidity.')
  }
  if (holderStatusLabel.startsWith('Open Check') || holderStatusLabel.startsWith('Limited')) {
    evidenceGaps.push('Holder distribution evidence is limited or unverified.')
  }
  if (!deployer?.deployerAddress) {
    evidenceGaps.push('Deployer identity is Open Check.')
  }
  if (security?.openChecks?.length) {
    for (const item of security.openChecks) evidenceGaps.push(typeof item === 'string' ? item : String(item))
  }
  if ((market?.marketConfidence ?? '').toLowerCase().includes('open')) {
    evidenceGaps.push('Market evidence confidence is Open Check.')
  }
  const dedupedEvidenceGaps = Array.from(new Set(evidenceGaps))
  const dedupedRiskFacts = Array.from(new Set(riskFacts))

  const watchNext: string[] = [...severity.watchNext]
  if (concentrationRisk === 'High' || concentrationRisk === 'Extreme') {
    watchNext.push('Watch top-holder wallets for large transfers given current concentration.')
  }
  if (token?.flags?.length) {
    watchNext.push(`Monitor radar flags: ${token.flags.join(', ')}.`)
  }
  if (!watchNext.length) {
    watchNext.push('No specific watch items from current evidence — continue monitoring liquidity and holder activity.')
  }
  const dedupedWatchNext = Array.from(new Set(watchNext))


  const projectLinks = [
    { label: 'Website', href: asLink(socials.website) },
    { label: 'X', href: asLink(socials.twitter) },
    { label: 'Telegram', href: asLink(socials.telegram) },
  ].filter((item): item is { label: string; href: string } => Boolean(item.href))
  const marketSignals = Array.from(new Set([pairAgeLabel ? 'New Pool' : null, token?.momentum ? `${publicStatus(token.momentum)} Momentum` : null, marketValuation.basis === 'verified_market_cap' ? 'Market Cap Verified' : marketValuation.basis === 'fdv_fallback' ? 'FDV Fallback' : 'Valuation Open Check'].filter(Boolean) as string[])).slice(0, 5)
  const riskSignals = Array.from(new Set([excludedFromFeed ? 'Liquidity Watch' : null, concentrationRisk === 'Extreme' ? 'Extreme Holder Control' : concentrationRisk === 'High' ? 'High Holder Control' : null, !hasVerifiedLock(lp?.lpLockStatus) && lp?.lpProofApplicability !== 'not_applicable' ? 'No Lock Detected' : null, displayModel?.simulation.status === 'passed' ? 'Simulation Checked' : simulation.data ? 'Simulation Checked Inconclusive' : displayModel?.simulation.status === 'open_check' ? 'Simulation Pending' : null, ...severity.evidenceTags].filter(Boolean) as string[])).slice(0, 6)
  const controlSignals = Array.from(new Set([activeOwner ? 'Active Owner/Admin' : ownershipLabel, lpControlStatus ? publicStatus(lpControlStatus) : 'LP Control Open Check', deployer?.clusterEvidence?.confirmed ? 'Cluster Evidence' : 'Cluster Open Check'].filter(Boolean) as string[])).slice(0, 5)
  const cortexFound = [severity.cortexSevereLine, poolDistributionLine, holderCortexLine].filter(Boolean).slice(0, 3)
  const cortexMainRisk = activeOwner ? 'Active owner/admin remains the primary control risk.' : concentrationRisk === 'Extreme' ? 'Extreme holder concentration is the primary risk driver.' : lpRiskLabelValue
  const cortexWatch = dedupedWatchNext.slice(0, 3)
  const valuationTone = marketValuation.basis === 'verified_market_cap' ? 'mint' : marketValuation.basis === 'fdv_fallback' ? 'amber' : 'neutral'
  const holderTone = concentrationRisk === 'Extreme' || concentrationRisk === 'High' ? 'risk' : concentrationRisk === 'Medium' ? 'amber' : 'mint'
  const holderSectionTone = holderTone === 'amber' ? 'purple' : holderTone
  const lpTone = !hasVerifiedLock(lp?.lpLockStatus) && lp?.lpProofApplicability !== 'not_applicable' ? 'risk' : 'mint'

  const radarSignals = useMemo(
    () => buildRadarSignals(token, enriched),
    [token, enriched]
  )
  const whyItMatters = useMemo(
    () => buildWhyItMatters(token, enriched),
    [token, enriched]
  )
  const radarTimeline = useMemo(
    () => buildRadarTimeline(token, enriched),
    [token, enriched]
  )
  const nextFiveMinuteRead = useMemo(
    () => buildNextFiveMinuteRead(token, enriched),
    [token, enriched]
  )

  async function copyText(value: string) {
    await navigator.clipboard?.writeText(value)
  }

  // ACCORDION STATE, DISCLOSED — REVISED per direct user feedback on the first pass: every lower
  // section now defaults OPEN (the report reads top-to-bottom with nothing hidden behind a click),
  // and the section header/chevron only exists so a user who wants to tidy the view can manually
  // collapse a section they don't care about — collapsing is opt-in, never the default. Only
  // explicit user collapses are stored; resets whenever the drawer is pointed at a different token
  // so a previous token's manual collapse never carries over.
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, boolean>>({})
  const overrideAddressRef = useRef(address)
  useEffect(() => {
    if (overrideAddressRef.current !== address) {
      overrideAddressRef.current = address
      setSectionOverrides({})
    }
  }, [address])
  function isSectionOpen(id: string): boolean {
    return sectionOverrides[id] ?? true
  }
  function toggleSection(id: string) {
    setSectionOverrides(prev => ({ ...prev, [id]: !isSectionOpen(id) }))
  }

  // VERDICT-TONE FIX, DISCLOSED (task #8 — "use red only for true danger"): the previous verdict
  // badge compared severityLabel against literal strings 'High Risk'/'Critical', which this label
  // never actually equals (its real values are 'VERY LOW'/'LOW'/'MODERATE'/'WATCHLIST'/'STRONGER' —
  // see getScoreSeverityLabel/baseRadarFeedScoring's riskLabel), so the badge always fell through to
  // the same hardcoded red styling regardless of the real label. Purely a display mapping over the
  // same already-computed severityLabel — the label itself, and the score it's derived from, are
  // untouched.
  const verdictTone: 'mint' | 'amber' | 'risk' = severityLabel === 'STRONGER' || severityLabel === 'WATCHLIST' ? 'mint' : severityLabel === 'MODERATE' ? 'amber' : 'risk'
  const verdictColor = verdictTone === 'mint' ? '#2dd4bf' : verdictTone === 'amber' ? '#fbbf24' : '#fb7185'
  // EVIDENCE-QUALITY CHIP, DISCLOSED (task #4 — "confidence/evidence quality" in the verdict
  // module): a presentational bucketing of the count of already-computed, real open-evidence items
  // (dedupedEvidenceGaps) — the same list the Evidence Gaps section lists individually. No new
  // evidence is invented; this only labels how many gaps already exist.
  const evidenceQualityLabel = dedupedEvidenceGaps.length === 0 ? 'Full Evidence' : dedupedEvidenceGaps.length <= 2 ? 'Mostly Verified' : 'Limited Evidence'
  const evidenceQualityTone: 'mint' | 'amber' | 'risk' = dedupedEvidenceGaps.length === 0 ? 'mint' : dedupedEvidenceGaps.length <= 2 ? 'amber' : 'risk'

  // WHOLE-PAGE-UNCLICKABLE FIX, DISCLOSED (reported: "still cant scroll down and click buttons and
  // cant click on it no panel opens up nothing" — persisted even after the sibling fix in
  // QuickPreviewPanel, app/terminal/base-radar/page.tsx). Root cause here: this component's `token`
  // prop is now passed unconditionally at the page level (`<ProjectOverviewDrawer token=
  // {selectedToken} ... />`, no longer wrapped in a `{selectedToken && ...}` guard), and
  // selectedToken is set on plain HOVER (preloadProjectOverview), not just on click — so `token`
  // becomes truthy, and this component starts rendering its fixed, full-viewport backdrop <div>
  // below, the moment a user hovers ANY card, regardless of whether `open` (drawerOpen/
  // fullReportOpen) is actually true. That backdrop relied purely on pointerEvents: open ? 'auto' :
  // 'none' to stay inert while closed — same latent class of bug as the QuickPreviewPanel fix, just
  // in this component instead. Not rendering anything at all unless BOTH a token exists AND it's
  // actually open removes the backdrop DOM node entirely while closed, the same structural
  // guarantee applied there.
  if (!token || !open) return null

  return (
    <div aria-hidden={!open}>
      <style>{`@media (max-width: 640px) { .radar-drawer { width: 100vw !important; height: 100dvh !important; max-height: 100dvh !important; top: 0 !important; left: 0 !important; transform: ${open ? 'translateX(0)' : 'translateX(105%)'} !important; border-radius: 0 !important; padding: 12px !important; border-left: 0 !important; border: 0 !important; } .radar-drawer-header { margin: -12px -12px 12px !important; padding: 10px 12px !important; } .radar-mini-chart-svg { height: 120px !important; max-height: 120px !important; } .holder-row-list > div { grid-template-columns: 34px minmax(0,1fr) auto !important; overflow-wrap: anywhere; } } @media (prefers-reduced-motion: reduce) { .radar-drawer, .radar-drawer * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }`}</style>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: open ? (isFull ? 'rgba(2,6,23,0.78)' : 'rgba(2,6,23,0.68)') : 'transparent', backdropFilter: open ? 'blur(4px)' : 'none', pointerEvents: open ? 'auto' : 'none', transition: 'background 0.2s, backdrop-filter 0.2s', zIndex: 70 }} />
      {/* FULL-REPORT-MODE, DISCLOSED: see the DrawerProps.mode comment above — only this element's
          own style object branches on mode; everything rendered inside (all children below) is
          identical in both modes. 'full' centers a wide (max 1120px), tall, rounded modal instead
          of docking a narrow strip to the right edge — same open/close transform-based animation
          approach, just animating a vertical lift instead of a horizontal slide-in so it reads as
          "opening a report" rather than "a panel sliding over." */}
      <aside className="radar-drawer" role="dialog" aria-modal="true" aria-label="Project overview" style={isFull ? {
        position: 'fixed', top: '4vh', left: '50%', height: 'min(92vh, 940px)', width: 'min(1120px, 94vw)',
        transform: open ? 'translate(-50%, 0)' : 'translate(-50%, 24px)', opacity: open ? 1 : 0,
        transition: 'transform 0.18s cubic-bezier(.22,1,.36,1), opacity 0.18s ease',
        zIndex: 80, background: 'radial-gradient(circle at 20% 0%, rgba(45,212,191,.09), transparent 32%), radial-gradient(circle at 90% 16%, rgba(168,85,247,.07), transparent 28%), linear-gradient(180deg, #07111f, #020617 58%)',
        border: '1px solid rgba(45,212,191,0.18)', borderRadius: '20px', boxShadow: '0 40px 100px rgba(0,0,0,0.55)',
        color: '#e2e8f0', overflowY: 'auto', padding: '24px 28px', overflowX: 'hidden',
      } : { position: 'fixed', top: 0, right: 0, height: '100dvh', width: 'min(640px, 100vw)', transform: open ? 'translateX(0)' : 'translateX(105%)', transition: 'transform 0.16s cubic-bezier(.22,1,.36,1)', zIndex: 80, background: 'radial-gradient(circle at 20% 0%, rgba(45,212,191,.09), transparent 32%), radial-gradient(circle at 90% 16%, rgba(168,85,247,.07), transparent 28%), linear-gradient(180deg, #07111f, #020617 58%)', borderLeft: '1px solid rgba(45,212,191,0.16)', boxShadow: '-24px 0 64px rgba(0,0,0,0.44)', color: '#e2e8f0', overflowY: 'auto', padding: '18px', overflowX: 'hidden' }}>
        {/* STICKY SUMMARY HEADER, DISCLOSED (task #2): same identity chips (chain/age), same Radar
            score, same verdict label, same truncated CA as before — regrouped into one calmer
            report letterhead instead of two visually separate rows, and the close button is now a
            plain small ghost circle inline with the title instead of a large boxed control set apart
            from it. */}
        <header className="radar-drawer-header" style={{ position: 'sticky', top: 0, zIndex: 3, margin: '-18px -18px 14px', padding: '16px 18px 14px', background: 'rgba(2,6,23,0.90)', backdropFilter: 'blur(18px)', borderBottom: '1px solid rgba(148,163,184,0.12)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: '0 0 4px', color: '#5b7186', fontSize: 9, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>CORTEX Intelligence Receipt</p>
              <h2 style={{ margin: 0, fontSize: 19, color: '#f8fafc', letterSpacing: '-.03em', overflowWrap: 'anywhere', lineHeight: 1.25 }}>{token.name} <span style={{ color: '#94a3b8', fontWeight: 500 }}>/{token.symbol}</span></h2>
            </div>
            <button onClick={onClose} aria-label="Close project overview" style={{ flex: '0 0 auto', border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)', color: '#94a3b8', borderRadius: 999, width: 28, height: 28, cursor: 'pointer', fontSize: 15, lineHeight: 1, display: 'grid', placeItems: 'center' }}>×</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
            {/* CHAIN-LABEL, DISCLOSED (found in a full Base Radar audit): this was a two-way
                `base ? 'Base' : 'ETH'` check, so every Robinhood token was labeled "ETH" — actively
                misidentifying which chain a contract lives on, the single most misleading thing this
                header can get wrong. Driven off the real chain key now. */}
            <Chip label={CHAIN_LABEL[chain]} tone="mint" />
            <Chip label={fmtAge(token.ageMinutes)} tone="neutral" />
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, background: 'rgba(45,212,191,.08)', border: '1px solid rgba(45,212,191,.22)' }}>
              <span style={{ color: '#5eead4', fontSize: 9, fontWeight: 900, letterSpacing: '.10em', textTransform: 'uppercase' }}>Radar</span>
              <span style={{ color: '#fff', fontSize: 14, fontWeight: 900 }}>{effectiveScore}</span>
              <span style={{ color: '#4b6273', fontSize: 10 }}>/100</span>
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, background: `${verdictColor}14`, border: `1px solid ${verdictColor}38`, color: verdictColor, fontSize: 10, fontWeight: 850, letterSpacing: '.06em' }}>{publicStatus(severityLabel)}</span>
            <span title={token.contract} style={{ color: '#5b7186', fontSize: 10.5, fontFamily: 'var(--font-plex-mono)', marginLeft: 'auto' }}>{shortAddr(token.contract)}</span>
          </div>
          {/* DEEP-SCAN-REMOVED, DISCLOSED (explicitly requested: "get rid of that deep scan button
              on the base radar panel for robinhood and base"). Copy CA is now the primary/filled
              action since it's the most common next step once a candidate's evidence is reviewed
              here — Open Explorer and Watchlist remain secondary, unchanged otherwise. */}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 12 }}>
            <button onClick={() => copyText(token.contract)} style={primaryButtonStyle}>Copy CA</button>
            <a href={explorer ?? '#'} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>Open Explorer</a>
            {onTrackToggle ? <button onClick={onTrackToggle} style={tracking ? activeButtonStyle : buttonStyle}>{tracking ? 'Watching' : 'Add Watchlist'}</button> : null}
          </div>
        </header>

        {/* VERDICT MODULE, DISCLOSED (task #4): headline verdict line (unchanged text, same
            severity.cortexSevereLine), primary risk driver tile (unchanged, same cortexMainRisk),
            plus a new "Evidence Coverage" chip that only re-labels the already-computed
            dedupedEvidenceGaps count — see evidenceQualityLabel's own comment above — and the same
            top status tags, just capped/spaced more like a receipt line than a paragraph block. */}
        <Section title="CORTEX Verdict" tone={verdictTone}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <Chip label={`Evidence: ${evidenceQualityLabel}`} tone={evidenceQualityTone} />
            {[...marketSignals, ...riskSignals].slice(0, 2).map((x) => <Chip key={x} label={x} tone={/risk|lock|holder|timeout|watch/i.test(x) ? 'risk' : 'mint'} />)}
          </div>
          <p style={{ margin: '0 0 12px', color: '#f1f5f9', fontSize: 14.5, lineHeight: 1.5, fontWeight: 650 }}>{severity.cortexSevereLine}</p>
          <ProofTile label="Primary risk driver" value={cortexMainRisk} tone={/High|risk|Active|Extreme|No verified/i.test(cortexMainRisk) ? 'risk' : 'neutral'} />
        </Section>

        {/* WHY IT MATTERS, DISCLOSED (task #5): same WhyItMattersBox component, same sentence
            content — only its own internal bullet styling changed (subtle dot per line instead of
            default list markers), see WhyItMattersBox.tsx. */}
        <WhyItMattersBox sentences={whyItMatters} />

        {/* MARKET SNAPSHOT, DISCLOSED (task #6): same six metrics, same values — MetricCard itself
            now only visually emphasizes risk/amber (warning) cards, see that component's own
            comment. */}
        <Section title="Market Snapshot" tone="mint">
          {excludedFromFeed && <div style={{ marginBottom: 10 }}><Chip label="Below default liquidity threshold" tone="risk" /></div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <MetricCard label="Liquidity" value={fmtUSD(liquidityUsd)} sublabel={excludedFromFeed ? 'Below $5K feed threshold' : 'Primary observed depth'} chip={excludedFromFeed ? 'Watch' : 'Depth'} tone={excludedFromFeed ? 'risk' : 'mint'} />
            <MetricCard label={displayModel?.valuation.label ?? (marketValuationCard.label === 'FDV' ? 'FDV' : marketValuation.basis === 'unavailable' ? 'Valuation' : 'Market Cap')} value={marketValuationCard.value} sublabel={displayModel?.valuation.sublabel ?? (marketValuation.basis === 'verified_market_cap' ? 'Verified' : marketValuation.basis === 'fdv_fallback' ? 'Market cap unavailable' : 'Open check')} chip={displayModel?.valuation.status === 'verified' ? 'Verified' : displayModel?.valuation.status === 'fdv_fallback' ? 'Fallback' : marketValuation.basis === 'verified_market_cap' ? 'Verified' : marketValuation.basis === 'fdv_fallback' ? 'Fallback' : 'Open'} tone={valuationTone} />
            <MetricCard label="24h Volume" value={fmtUSD(market?.volume24hUsd ?? token.volume24h)} sublabel="Recent market activity" chip="24h" tone="purple" />
            <MetricCard label="Age" value={pairAgeLabel ?? fmtAge(token.ageMinutes)} sublabel="Pool age evidence" chip="Launch" tone="neutral" />
            <MetricCard label="Momentum" value={publicStatus(token.momentum)} sublabel={`Radar ${effectiveScore}/100`} chip={token.status} tone="mint" />
            <MetricCard label="Market Evidence" value={market?.marketConfidence ? publicStatus(market.marketConfidence) : 'Open Check'} sublabel={marketValuationCard.sublabel} chip={market?.marketStatus ? publicStatus(market.marketStatus) : 'Evidence'} tone={market?.marketConfidence?.toLowerCase().includes('open') ? 'amber' : 'mint'} />
          </div>
        </Section>

        <Section title="Signal Stack" tone="purple">
          {[['Market Signals', marketSignals, 'mint'], ['Risk Signals', riskSignals, 'risk'], ['Control Signals', controlSignals, 'amber']].map(([title, items, tone]) => <div key={title as string} style={{ marginBottom: 11 }}><p style={{ margin: '0 0 7px', color: '#94a3b8', fontSize: 10, letterSpacing: '.11em', textTransform: 'uppercase', fontWeight: 850 }}>{title as string}</p><div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{(items as string[]).map((x) => <Chip key={x} label={x} tone={tone as 'mint' | 'amber' | 'risk'} />)}</div></div>)}
        </Section>

        {/* LOWER SECTIONS — GROUPED ACCORDIONS, DISCLOSED (task #7): each wraps the exact same
            content/props as before (same components, same computed values) — only the container
            changed from a standalone bordered card to a collapsible group within one continuous
            report. Open/collapsed state per section: see sectionDefaults/isSectionOpen above. */}
        <CollapsibleSection id="momentum" title="Momentum & Timeline" tone="purple" open={isSectionOpen('momentum')} onToggle={toggleSection}>
          <div style={{ display: 'grid', gap: 12 }}>
            <TimelineMiniChart timeline={radarTimeline} />
            <SignalsSidebar signals={radarSignals} />
          </div>
        </CollapsibleSection>

        <CollapsibleSection id="lp" title={lp?.lpProofApplicability === 'not_applicable' ? 'Liquidity / LP Position Control' : 'Liquidity / LP Control'} tone={lpTone} open={isSectionOpen('lp')} onToggle={toggleSection} state={enrichmentState}>
          <div style={{ marginBottom: 12 }}><Chip label={lp?.lpProofApplicability === 'not_applicable' ? 'Position verification required' : lpProofLabel} tone={lpTone} /></div>
          <p style={{ margin: '0 0 12px', color: lpTone === 'risk' ? '#fecaca' : '#cbd5e1', fontSize: 13, lineHeight: 1.5 }}>{lp?.lpProofApplicability === 'not_applicable' ? 'Standard LP token lock proof may not apply. Position owner and control route require verification.' : lpRiskLabelValue}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10 }}>
            <ProofTile label="Pool model" value={displayLpModelLabel(lp?.displayLpModel)} tone="purple" />
            <ProofTile label="Lock proof" value={lpLockStatusLabel} tone={lpTone} />
            <ProofTile label="Burn proof" value={lpProofDisplay?.burnProof ?? (hasVerifiedLock(lp?.lpLockStatus) ? 'Not required' : 'No burn proof')} tone={lpTone} />
            <ProofTile label="Controller" value={lpControllerLabel} tone={lpTone} />
          </div>
          {secondaryLpSignal?.status === 'team_controlled' ? <div style={{ marginTop: 10 }}><ProofTile label="Secondary exposure" value={`Wallet-controlled secondary pool${secondaryLpSignal.poolDex ? ` · ${secondaryLpSignal.poolDex}` : ''}`} tone="risk" /></div> : null}
          <a href={`/terminal/liquidity?address=${token.contract}&chain=${chain}`} style={{ ...buttonStyle, display: 'inline-flex', marginTop: 12, textDecoration: 'none' }}>Open full LP Safety</a>
        </CollapsibleSection>

        <CollapsibleSection id="holders" title="Holders" tone={holderSectionTone} open={isSectionOpen('holders')} onToggle={toggleSection} state={enrichmentState}>
          {/* HOLDER-COUNT-VS-CONCENTRATION, DISCLOSED (reported: a token can show "Holders: 100" —
              real, resolved holder count — right next to a chip reading "Open Check concentration",
              which reads as if holder evidence overall is missing when only the top1/10/20 supply-
              share breakdown couldn't be resolved. These are two different pieces of evidence:
              holder COUNT (used for the radar quality gate) and holder CONCENTRATION (top1/10/20,
              a separate, heavier computation that can legitimately be unavailable even when the
              count is known). The chip and caption below now say so explicitly instead of using the
              same "Open Check" wording for both cases. */}
          {/* HOLDER-EVIDENCE-CLARITY, DISCLOSED (reported: the drawer showed "Holder count verified —
              100+ holders" next to "Concentration unavailable" — self-contradictory, since a minimum
              count ("at least 100") is not the same evidence as an exact, fully verified count, and
              neither implies anything about top-holder concentration. holderEvidence (server-computed,
              see lib/baseRadarHolderEvidence.ts) is now the single source of truth for both facts,
              kept fully separate — the copy below never calls a minimum count "verified", and
              concentration only ever shows real resolved numbers, never inferred from the count. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip label={concentration.holderEvidence?.concentrationStatus === 'unavailable' ? 'Concentration unavailable' : `${concentrationRisk} concentration`} tone={holderTone} />
              {/* RESOLVED-BADGE, DISCLOSED (explicitly directed: "If concentrationStatus === 'resolved':
                  show badge 'CONCENTRATION RESOLVED'... remove 'Concentration unavailable'"). Shown
                  alongside (not instead of) the risk-level chip above, which stays more informative
                  once real numbers exist — this badge is the explicit "this is real, resolved data"
                  signal the risk label alone doesn't state outright. */}
              {concentration.holderEvidence?.concentrationStatus === 'resolved' ? (
                <Chip label="CONCENTRATION RESOLVED" tone="mint" />
              ) : null}
            </div>
              <span style={{ color: '#94a3b8', fontSize: 12 }}>Holders: <strong style={{ color: '#e2e8f0' }}>{concentration.holderEvidence?.holderCountDisplay ?? (concentration.holderCount == null ? 'Open Check' : `${concentration.holderCount}${concentration.holderCountCapped ? '+' : ''}`)}</strong></span><span style={{ color: '#94a3b8', fontSize: 12 }}>{creatorTopHolderDisplay(concentration.creatorInTopHolders, concentration.creatorHolderPercent)}</span></div>
          {concentration.holderEvidence?.holderCountStatus === 'minimum' ? (
            <p style={{ margin: '0 0 4px', color: '#fbbf24', fontSize: 12, lineHeight: 1.5, fontWeight: 650 }}>Partial holder evidence — holder count is a confirmed minimum, not an exact verified total.</p>
          ) : null}
          {concentration.holderEvidence ? (
            <p style={{ margin: '0 0 12px', color: '#94a3b8', fontSize: 12, lineHeight: 1.5 }}>
              {concentration.holderEvidence.holderCountStatus === 'exact'
                ? `Holder count verified — ${concentration.holderEvidence.holderCountDisplay} holders.`
                : concentration.holderEvidence.holderCountStatus === 'minimum'
                  ? `Holder count minimum confirmed — at least ${concentration.holderEvidence.holderCountDisplay.replace('+', '')} holders. This provider confirmed a floor, not the exact total.`
                  : 'Holder count is an open check — no provider returned a usable count.'}
              {' '}
              {concentration.holderEvidence.concentrationStatus === 'unavailable'
                ? 'The provider confirmed a holder count, but did not return the holder balance list needed for Top 1/10/20 concentration. Open Token Scanner for a deeper check.'
                : concentration.holderEvidence.concentrationProvider === 'goldrush'
                  ? 'Top holder balances resolved via GoldRush/Covalent snapshot.'
                  : 'Top 1/10/20 supply concentration below is resolved from real indexed holder balances.'}
            </p>
          ) : null}
          <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}><MiniBar label="Top 1" value={concentration.top1} tone={holderTone === 'risk' ? 'risk' : 'mint'} /><MiniBar label="Top 10" value={concentration.top10} tone={holderTone === 'risk' ? 'risk' : 'amber'} /><MiniBar label="Top 20" value={concentration.top20} tone={holderTone === 'risk' ? 'risk' : 'amber'} /></div>
          <div className="holder-row-list" style={{ display: 'grid', gap: 7 }}>{topHolders.slice(0, 8).map((h, idx) => <div key={`${h.address}-${idx}`} style={{ display: 'grid', gridTemplateColumns: '38px minmax(0,1fr) auto', gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 12, border: '1px solid rgba(148,163,184,.10)', background: 'rgba(2,6,23,.38)' }}><span style={{ color: '#64748b', fontSize: 11, fontFamily: 'var(--font-plex-mono)' }}>#{h.rank ?? idx + 1}</span><span style={{ color: '#e2e8f0', fontSize: 12, fontFamily: 'var(--font-plex-mono)' }}>{shortAddr(h.address)}</span><span style={{ color: '#99f6e4', fontSize: 12, fontFamily: 'var(--font-plex-mono)', fontWeight: 850 }}>{percent(getHolderPercent(h))}</span></div>)}</div>
        </CollapsibleSection>

        <CollapsibleSection id="dev" title="Dev / Deployer" tone={activeOwner ? 'risk' : 'default'} open={isSectionOpen('dev')} onToggle={toggleSection} state={enrichmentState}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10 }}>
            <ProofTile label="Deployer identity" value={`${shortAddr(deployer?.deployerAddress)} · ${deployerMethod}`} />
            <ProofTile label="Ownership/admin" value={ownershipLabel} tone={activeOwner ? 'risk' : 'mint'} />
            <ProofTile label="Past launches" value={pastLaunchesEvidence.status === 'verified' || pastLaunchesEvidence.status === 'checked_not_found' ? `${deployer?.pastLaunches?.count ?? 0} found` : 'Open Check'} />
            <ProofTile label="Rug history" value={rugHistoryEvidence.status === 'risk_fact' ? 'Flagged' : rugHistoryEvidence.status === 'checked_not_found' ? 'None found' : 'Open Check'} tone={rugHistoryEvidence.status === 'risk_fact' ? 'risk' : 'mint'} />
          </div>
          {(() => {
            const clusterSupplyValue = deployer?.clusterEvidence?.devClusterSupplyPercent ?? deployer?.clusterEvidence?.linkedWalletSupplyPercent ?? deployer?.supplyControl?.linkedWalletSupplyPercent ?? null
            return (
              <div style={{ marginTop: 12 }}>
                <MiniBar label="Cluster supply control" value={clusterSupplyValue} tone={(deployer?.clusterEvidence?.devClusterSupplyPercent ?? 0) > 30 ? 'risk' : 'mint'} />
                {/* CLUSTER-N/A-CLARITY, DISCLOSED (reported: a bare "N/A" here next to an already-
                    resolved deployer identity read as broken rather than as a real result). No
                    percentage is fabricated when Token Scanner's cluster analysis didn't return one —
                    but a bare N/A doesn't distinguish "this was checked and found nothing" from "this
                    was never checked at all". clusterEvidence.reason (server-computed, real) makes
                    that explicit instead. */}
                {clusterSupplyValue == null ? (
                  <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 11, lineHeight: 1.5 }}>
                    {deployer?.clusterEvidence?.reason ?? 'No linked-wallet cluster supply percentage was resolved for this token.'}
                  </p>
                ) : null}
              </div>
            )
          })()}
        </CollapsibleSection>

        <CollapsibleSection id="socials" title="Socials & Chart" open={isSectionOpen('socials')} onToggle={toggleSection} state={enrichmentState}>
          {projectLinks.length ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10, marginBottom: 12 }}>{projectLinks.map((link) => <a key={link.label} href={link.href} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', color: '#e2e8f0', padding: 12, borderRadius: 14, border: '1px solid rgba(45,212,191,.20)', background: 'rgba(45,212,191,.07)', fontWeight: 800 }}>{link.label} ↗</a>)}</div> : <div style={{ padding: 14, borderRadius: 15, border: '1px solid rgba(148,163,184,.12)', background: 'rgba(15,23,42,.52)', marginBottom: 12 }}><p style={{ margin: '0 0 5px', color: '#e2e8f0', fontWeight: 750 }}>No public project links found in current metadata.</p><p style={{ margin: 0, color: '#94a3b8', fontSize: 12 }}>CORTEX will keep this as a social-evidence gap.</p></div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}><a href={dexScreener ?? '#'} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>Market chart</a><a href={geckoTerminal ?? '#'} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>Pool explorer</a></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 10 }}><div style={{ display: 'flex', gap: 6 }}>{['1h', '6h', '24h'].map((tf) => <Chip key={tf} label={tf} tone={tf === (enriched?.priceChart?.timeframe ?? '24h') ? 'mint' : 'neutral'} />)}</div>{chartPoints.length < 4 ? <Chip label="Low data" tone="amber" /> : null}</div>
          <MiniChart points={chartPoints} />
        </CollapsibleSection>

        <CollapsibleSection id="cortexRead" title="CORTEX Deep Read" tone="purple" open={isSectionOpen('cortexRead')} onToggle={toggleSection}>
          {[['What CORTEX found', cortexFound], ['Main risk', [cortexMainRisk]], ['Watch next', cortexWatch]].map(([title, lines]) => <div key={title as string} style={{ marginBottom: 12 }}><p style={{ margin: '0 0 7px', color: '#a78bfa', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 850 }}>{title as string}</p><ul style={{ margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 12, lineHeight: 1.6 }}>{(lines as string[]).slice(0, title === 'What CORTEX found' ? 3 : 2).map((line) => <li key={line}>{line}</li>)}</ul></div>)}
        </CollapsibleSection>

        <CollapsibleSection
          id="riskFlags"
          title="Risk Flags & Watch Next"
          tone={dedupedRiskFacts.length ? 'risk' : 'default'}
          open={isSectionOpen('riskFlags')}
          onToggle={toggleSection}
          badge={dedupedRiskFacts.length ? <Chip label={`${dedupedRiskFacts.length} Risk Fact${dedupedRiskFacts.length === 1 ? '' : 's'}`} tone="risk" /> : undefined}
        >
          {[['Risk Facts', dedupedRiskFacts.length ? dedupedRiskFacts : ['No high-confidence risk facts from current structured checks.'], 'risk'], ['Open Checks', dedupedEvidenceGaps.length ? dedupedEvidenceGaps.slice(0, 6) : ['No open evidence gaps from current checks.'], 'amber'], ['Watch Next', dedupedWatchNext.slice(0, 5), 'mint']].map(([title, items, tone]) => <div key={title as string} style={{ marginBottom: 10 }}><p style={{ margin: '0 0 8px', color: tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : '#2dd4bf', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 900 }}>{title as string}</p><div style={{ display: 'grid', gap: 8 }}>{(items as string[]).map((line) => <div key={line} style={{ display: 'grid', gridTemplateColumns: '14px 1fr', gap: 8, padding: 10, borderRadius: 13, border: '1px solid rgba(148,163,184,.11)', background: 'rgba(15,23,42,.48)' }}><span style={{ marginTop: 4, width: 7, height: 7, borderRadius: 999, background: tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : '#2dd4bf' }} /><span style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>{line}</span></div>)}</div></div>)}
        </CollapsibleSection>

        {/* NEXT ACTION, DISCLOSED (task #7 — "Next action" group): kept as a small, always-visible
            card rather than folded into an accordion — it's a single short, actionable read, not a
            text wall, and the goal is an "action-oriented" receipt so the next-step read stays in
            view by default. Same NextFiveMinuteCard component/content as before. */}
        <div style={{ marginTop: '14px' }}>
          <NextFiveMinuteCard prediction={nextFiveMinuteRead} />
        </div>
      </aside>
    </div>
  )
}

// ACTION-BAR HIERARCHY, DISCLOSED (task #3 — "make primary action visually clear"): buttonStyle is
// now the calm secondary/ghost treatment (used for Copy CA, Open Explorer, Watchlist, and the
// existing Market chart/Pool explorer/Open full LP Safety links); primaryButtonStyle is the one
// filled action (Deep Scan); activeButtonStyle is only for a toggled-on state (Watchlist already
// added). None of these change what a button does — only how the same actions are visually ranked.
const buttonStyle: React.CSSProperties = {
  border: '1px solid rgba(148,163,184,0.16)',
  background: 'rgba(255,255,255,0.03)',
  color: '#99f6e4',
  borderRadius: '10px',
  padding: '7px 11px',
  cursor: 'pointer',
  fontSize: '10px',
  fontWeight: 800,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  fontFamily: 'var(--font-plex-mono)',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  border: '1px solid rgba(45,212,191,0.55)',
  background: 'linear-gradient(135deg, rgba(45,212,191,0.90), rgba(20,184,166,0.90))',
  color: '#02110f',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
}

const activeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  border: '1px solid rgba(45,212,191,0.40)',
  background: 'rgba(45,212,191,0.14)',
  color: '#5eead4',
}

const tagStyle: React.CSSProperties = {
  padding: '3px 8px',
  borderRadius: '999px',
  border: '1px solid rgba(148,163,184,0.18)',
  background: 'rgba(148,163,184,0.08)',
  color: '#cbd5e1',
  fontSize: '9px',
  fontFamily: 'var(--font-plex-mono)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
}

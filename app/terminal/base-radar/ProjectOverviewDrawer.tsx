'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { assessBaseRadarSeverity, creatorTopHolderDisplay, normalizePairCreatedAt, ageLabelFromIso, extractLpControllerSharePercent, getBaseRadarDetailSeverityCap, getScoreSeverityLabel } from '@/lib/baseRadarSeverity'
import { getRadarValuationBasis, getRadarValuationCardDisplay, DEFAULT_RADAR_MIN_LIQUIDITY_USD } from '@/lib/baseRadarValuation'
import { buildBaseRadarDisplayModel } from '@/lib/baseRadarDisplayModel'
import { getRadarValuationEvidence, getRadarSocialsEvidence, getRadarOwnershipEvidence, getRadarPastLaunchesEvidence, getRadarRugHistoryEvidence, type RadarEvidenceEntry } from '@/lib/baseRadarEvidence'

type ChainKey = 'base' | 'eth'

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
  simulationLabel?: string | null
  simulationCortexLine?: string | null
}

type DrawerProps = {
  token: RadarDrawerToken | null
  open: boolean
  chain?: ChainKey
  onClose: () => void
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

const EXPLORER: Record<ChainKey, string> = {
  base: 'https://basescan.org',
  eth: 'https://etherscan.io',
}

const GT_NETWORK: Record<ChainKey, string> = {
  base: 'base',
  eth: 'eth',
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

function Section({ title, state, children, tone = 'default' }: { title: string; state?: ApiState<unknown>; children: React.ReactNode; tone?: 'default' | 'risk' | 'mint' | 'purple' }) {
  const loading = state?.isLoading
  const accent = tone === 'risk' ? '#fb7185' : tone === 'purple' ? '#a78bfa' : '#2dd4bf'
  return (
    <section style={{ border: `1px solid ${tone === 'default' ? 'rgba(148,163,184,0.12)' : `${accent}33`}`, background: 'linear-gradient(180deg, rgba(15,23,42,0.72), rgba(2,6,23,0.58))', borderRadius: '18px', padding: '15px', marginBottom: '12px', boxShadow: '0 18px 50px rgba(0,0,0,0.20)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px' }}>
        <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}><span style={{ color: accent }}>◆</span> {title}</h3>
        {state?.error ? <span style={{ color: '#fbbf24', fontSize: '9px', fontFamily: 'var(--font-plex-mono)' }}>Limited</span> : null}
      </div>
      {loading ? <SkeletonRows /> : children}
    </section>
  )
}

function MetricCard({ label, value, sublabel, chip, tone = 'mint' }: { label: string; value: React.ReactNode; sublabel?: React.ReactNode; chip?: string; tone?: 'mint' | 'amber' | 'risk' | 'neutral' | 'purple' }) {
  const color = tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : tone === 'purple' ? '#a78bfa' : tone === 'neutral' ? '#94a3b8' : '#2dd4bf'
  return <div style={{ minWidth: 0, border: `1px solid ${color}26`, background: `linear-gradient(180deg, ${color}10, rgba(15,23,42,0.72))`, borderRadius: '16px', padding: '12px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 8 }}><span style={{ color: '#94a3b8', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 800 }}>{label}</span>{chip ? <Chip label={chip} tone={tone} /> : null}</div>
    <div style={{ color: '#f8fafc', fontSize: 22, lineHeight: 1, fontWeight: 850, letterSpacing: '-.03em', overflowWrap: 'anywhere' }}>{value}</div>
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

export default function ProjectOverviewDrawer({ token, open, chain = 'base', onClose }: DrawerProps) {
  const address = token?.contract ?? ''
  const enabled = open && Boolean(address)
  const query = address ? `contract=${encodeURIComponent(address)}&chain=${chain}` : ''

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
  const enriched = enrichment.data
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
  const securityTax = security?.honeypot?.simulationSuccess
    ? `${percent(security.honeypot.buyTax)} buy · ${percent(security.honeypot.sellTax)} sell`
    : (token?.simulationLabel ?? 'Open Check')
  const ownershipLabel = security?.devOwnership?.ownershipLabel ?? (security?.devOwnership?.ownershipVerified === true && security.devOwnership.isRenounced === true ? 'Renounced ownership' : security?.devOwnership?.ownershipVerified === true && (security.devOwnership.ownerAddress || security.devOwnership.adminAddress) ? 'Active owner/admin verified' : 'Open Check / Not verified')

  const normalizedPairCreatedAt = normalizePairCreatedAt(market?.poolActivity?.pairCreatedAt ?? null)
  const pairAgeLabel = ageLabelFromIso(normalizedPairCreatedAt)
  const poolAgeMinutes = normalizedPairCreatedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(normalizedPairCreatedAt).getTime()) / 60_000))
    : (Number.isFinite(token?.ageMinutes) ? token!.ageMinutes : null)
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
    simulationStatus: token?.simulationStatus ?? null,
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

  const marketValuation = getRadarValuationBasis({
    marketCapUsd: displayModel?.marketSnapshot.marketCapUsd ?? null,
    marketCapStatus: displayModel?.marketSnapshot.marketCapStatus ?? null,
    fdvUsd: displayModel?.marketSnapshot.fdvUsd ?? null,
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

  const structuredEvidence: RadarEvidenceEntry[] = [
    ...(valuationEvidence ? [valuationEvidence] : []),
    socialsEvidence,
    pastLaunchesEvidence,
    rugHistoryEvidence,
    ...(ownershipEvidence ? [ownershipEvidence] : []),
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
  const riskSignals = Array.from(new Set([excludedFromFeed ? 'Liquidity Watch' : null, concentrationRisk === 'Extreme' ? 'Extreme Holder Control' : concentrationRisk === 'High' ? 'High Holder Control' : null, !hasVerifiedLock(lp?.lpLockStatus) && lp?.lpProofApplicability !== 'not_applicable' ? 'No Lock Detected' : null, displayModel?.simulation.status === 'passed' ? 'Simulation Clear' : displayModel?.simulation.status === 'open_check' ? 'Simulation Pending' : null, ...severity.evidenceTags].filter(Boolean) as string[])).slice(0, 6)
  const controlSignals = Array.from(new Set([activeOwner ? 'Active Owner/Admin' : ownershipLabel, lpControlStatus ? publicStatus(lpControlStatus) : 'LP Control Open Check', deployer?.clusterEvidence?.confirmed ? 'Cluster Evidence' : 'Cluster Open Check'].filter(Boolean) as string[])).slice(0, 5)
  const cortexFound = [severity.cortexSevereLine, poolDistributionLine, holderCortexLine].filter(Boolean).slice(0, 3)
  const cortexMainRisk = activeOwner ? 'Active owner/admin remains the primary control risk.' : concentrationRisk === 'Extreme' ? 'Extreme holder concentration is the primary risk driver.' : lpRiskLabelValue
  const cortexWatch = dedupedWatchNext.slice(0, 3)
  const valuationTone = marketValuation.basis === 'verified_market_cap' ? 'mint' : marketValuation.basis === 'fdv_fallback' ? 'amber' : 'neutral'
  const holderTone = concentrationRisk === 'Extreme' || concentrationRisk === 'High' ? 'risk' : concentrationRisk === 'Medium' ? 'amber' : 'mint'
  const holderSectionTone = holderTone === 'amber' ? 'purple' : holderTone
  const lpTone = !hasVerifiedLock(lp?.lpLockStatus) && lp?.lpProofApplicability !== 'not_applicable' ? 'risk' : 'mint'

  async function copyText(value: string) {
    await navigator.clipboard?.writeText(value)
  }

  if (!token) return null

  return (
    <div aria-hidden={!open}>
      <style>{`@media (max-width: 640px) { .radar-drawer { width: 100vw !important; padding: 12px !important; border-left: 0 !important; } .radar-drawer-header { margin: -12px -12px 12px !important; padding: 10px 12px !important; } .radar-mini-chart-svg { height: 120px !important; max-height: 120px !important; } .holder-row-list > div { grid-template-columns: 34px minmax(0,1fr) auto !important; overflow-wrap: anywhere; } }`}</style>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: open ? 'rgba(2,6,23,0.68)' : 'transparent', backdropFilter: open ? 'blur(4px)' : 'none', pointerEvents: open ? 'auto' : 'none', transition: 'background 0.2s, backdrop-filter 0.2s', zIndex: 70 }} />
      <aside className="radar-drawer" role="dialog" aria-modal="true" aria-label="Project overview" style={{ position: 'fixed', top: 0, right: 0, height: '100dvh', width: 'min(640px, 100vw)', transform: open ? 'translateX(0)' : 'translateX(105%)', transition: 'transform 0.28s cubic-bezier(.22,1,.36,1)', zIndex: 80, background: 'radial-gradient(circle at 20% 0%, rgba(45,212,191,.13), transparent 32%), radial-gradient(circle at 90% 16%, rgba(168,85,247,.12), transparent 28%), linear-gradient(180deg, #07111f, #020617 58%)', borderLeft: '1px solid rgba(45,212,191,0.20)', boxShadow: '-32px 0 100px rgba(0,0,0,0.52)', color: '#e2e8f0', overflowY: 'auto', padding: '18px', overflowX: 'hidden' }}>
        <header className="radar-drawer-header" style={{ position: 'sticky', top: 0, zIndex: 3, margin: '-18px -18px 14px', padding: '14px 18px', background: 'rgba(2,6,23,0.88)', backdropFilter: 'blur(18px)', borderBottom: '1px solid rgba(148,163,184,0.12)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 20, color: '#f8fafc', letterSpacing: '-.03em', overflowWrap: 'anywhere' }}>{token.name} <span style={{ color: '#94a3b8' }}>/{token.symbol}</span></h2>
                <Chip label={chain === 'base' ? 'Base' : 'ETH'} tone="mint" />
                <Chip label={fmtAge(token.ageMinutes)} tone="neutral" />
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                <div style={{ padding: '9px 12px', borderRadius: 14, background: 'linear-gradient(135deg, rgba(45,212,191,.18), rgba(15,23,42,.62))', border: '1px solid rgba(45,212,191,.28)' }}><span style={{ color: '#99f6e4', fontSize: 10, fontWeight: 900, letterSpacing: '.12em', textTransform: 'uppercase' }}>Radar</span><span style={{ marginLeft: 8, color: '#fff', fontSize: 18, fontWeight: 900 }}>{effectiveScore}</span><span style={{ color: '#64748b', fontSize: 11 }}>/100</span></div>
                <div style={{ padding: '9px 12px', borderRadius: 14, background: 'linear-gradient(135deg, rgba(251,113,133,.16), rgba(15,23,42,.62))', border: '1px solid rgba(251,113,133,.25)', color: '#fecaca', fontSize: 12, fontWeight: 850 }}>{severityLabel}</div>
                <span title={token.contract} style={{ color: '#94a3b8', fontSize: 11, fontFamily: 'var(--font-plex-mono)' }}>{shortAddr(token.contract)}</span>
              </div>
            </div>
            <button onClick={onClose} aria-label="Close project overview" style={{ flex: '0 0 auto', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: '#cbd5e1', borderRadius: 12, width: 36, height: 36, cursor: 'pointer', fontSize: 20 }}>×</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button onClick={() => copyText(token.contract)} style={buttonStyle}>Copy CA</button>
            <a href={explorer ?? '#'} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>Open Explorer</a>
            <a href={`/terminal/token-scanner?contract=${token.contract}`} style={{ ...buttonStyle, textDecoration: 'none' }}>Deep Scan</a>
          </div>
        </header>

        <Section title="CORTEX Verdict" tone={severityLabel === 'High Risk' || severityLabel === 'Critical' ? 'risk' : 'mint'}>
          <p style={{ margin: '0 0 12px', color: '#e2e8f0', fontSize: 14, lineHeight: 1.5, fontWeight: 650 }}>{severity.cortexSevereLine}</p>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>{[...marketSignals, ...riskSignals].slice(0, 3).map((x) => <Chip key={x} label={x} tone={/risk|lock|holder|timeout|watch/i.test(x) ? 'risk' : 'mint'} />)}</div>
          <ProofTile label="Primary risk driver" value={cortexMainRisk} tone={/High|risk|Active|Extreme|No verified/i.test(cortexMainRisk) ? 'risk' : 'neutral'} />
        </Section>

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

        <Section title="Socials" state={enrichmentState}>
          {projectLinks.length ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>{projectLinks.map((link) => <a key={link.label} href={link.href} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', color: '#e2e8f0', padding: 12, borderRadius: 14, border: '1px solid rgba(45,212,191,.20)', background: 'rgba(45,212,191,.07)', fontWeight: 800 }}>{link.label} ↗</a>)}</div> : <div style={{ padding: 14, borderRadius: 15, border: '1px solid rgba(148,163,184,.12)', background: 'rgba(15,23,42,.52)' }}><p style={{ margin: '0 0 5px', color: '#e2e8f0', fontWeight: 750 }}>No public project links found in current metadata.</p><p style={{ margin: 0, color: '#94a3b8', fontSize: 12 }}>CORTEX will keep this as a social-evidence gap.</p></div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}><a href={dexScreener ?? '#'} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>Market chart</a><a href={geckoTerminal ?? '#'} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>Pool explorer</a></div>
        </Section>

        <Section title={lp?.lpProofApplicability === 'not_applicable' ? 'LP Position Control' : 'LP Control'} state={enrichmentState} tone={lpTone}>
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
        </Section>

        <Section title="Deployer / Ownership" state={enrichmentState} tone={activeOwner ? 'risk' : 'default'}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10 }}>
            <ProofTile label="Deployer identity" value={`${shortAddr(deployer?.deployerAddress)} · ${deployerMethod}`} />
            <ProofTile label="Ownership/admin" value={ownershipLabel} tone={activeOwner ? 'risk' : 'mint'} />
            <ProofTile label="Past launches" value={pastLaunchesEvidence.status === 'verified' || pastLaunchesEvidence.status === 'checked_not_found' ? `${deployer?.pastLaunches?.count ?? 0} found` : 'Open Check'} />
            <ProofTile label="Rug history" value={rugHistoryEvidence.status === 'risk_fact' ? 'Flagged' : rugHistoryEvidence.status === 'checked_not_found' ? 'None found' : 'Open Check'} tone={rugHistoryEvidence.status === 'risk_fact' ? 'risk' : 'mint'} />
          </div>
          <div style={{ marginTop: 12 }}><MiniBar label="Cluster supply control" value={deployer?.clusterEvidence?.devClusterSupplyPercent ?? deployer?.clusterEvidence?.linkedWalletSupplyPercent ?? deployer?.supplyControl?.linkedWalletSupplyPercent ?? null} tone={(deployer?.clusterEvidence?.devClusterSupplyPercent ?? 0) > 30 ? 'risk' : 'mint'} /></div>
        </Section>

        <Section title="Holder Distribution" state={enrichmentState} tone={holderSectionTone}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}><Chip label={`${concentrationRisk} concentration`} tone={holderTone} /><span style={{ color: '#94a3b8', fontSize: 12 }}>Holders: <strong style={{ color: '#e2e8f0' }}>{concentration.holderCount == null ? 'Open Check' : concentration.holderCount}</strong></span><span style={{ color: '#94a3b8', fontSize: 12 }}>{creatorTopHolderDisplay(concentration.creatorInTopHolders, concentration.creatorHolderPercent)}</span></div>
          <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}><MiniBar label="Top 1" value={concentration.top1} tone={holderTone === 'risk' ? 'risk' : 'mint'} /><MiniBar label="Top 10" value={concentration.top10} tone={holderTone === 'risk' ? 'risk' : 'amber'} /><MiniBar label="Top 20" value={concentration.top20} tone={holderTone === 'risk' ? 'risk' : 'amber'} /></div>
          <div className="holder-row-list" style={{ display: 'grid', gap: 7 }}>{topHolders.slice(0, 8).map((h, idx) => <div key={`${h.address}-${idx}`} style={{ display: 'grid', gridTemplateColumns: '38px minmax(0,1fr) auto', gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 12, border: '1px solid rgba(148,163,184,.10)', background: 'rgba(2,6,23,.38)' }}><span style={{ color: '#64748b', fontSize: 11, fontFamily: 'var(--font-plex-mono)' }}>#{h.rank ?? idx + 1}</span><span style={{ color: '#e2e8f0', fontSize: 12, fontFamily: 'var(--font-plex-mono)' }}>{shortAddr(h.address)}</span><span style={{ color: '#99f6e4', fontSize: 12, fontFamily: 'var(--font-plex-mono)', fontWeight: 850 }}>{percent(getHolderPercent(h))}</span></div>)}</div>
        </Section>

        <Section title="Mini Chart" state={enrichmentState}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 10 }}><div style={{ display: 'flex', gap: 6 }}>{['1h', '6h', '24h'].map((tf) => <Chip key={tf} label={tf} tone={tf === (enriched?.priceChart?.timeframe ?? '24h') ? 'mint' : 'neutral'} />)}</div>{chartPoints.length < 4 ? <Chip label="Low data" tone="amber" /> : null}</div>
          <MiniChart points={chartPoints} />
        </Section>

        <Section title="CORTEX Read" tone="purple">
          {[['What CORTEX found', cortexFound], ['Main risk', [cortexMainRisk]], ['Watch next', cortexWatch]].map(([title, lines]) => <div key={title as string} style={{ marginBottom: 12 }}><p style={{ margin: '0 0 7px', color: '#a78bfa', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 850 }}>{title as string}</p><ul style={{ margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 12, lineHeight: 1.6 }}>{(lines as string[]).slice(0, title === 'What CORTEX found' ? 3 : 2).map((line) => <li key={line}>{line}</li>)}</ul></div>)}
        </Section>

        <Section title="Evidence Gaps / Watch Next" tone="risk">
          {[['Risk Facts', dedupedRiskFacts.length ? dedupedRiskFacts : ['No high-confidence risk facts from current structured checks.'], 'risk'], ['Open Checks', dedupedEvidenceGaps.length ? dedupedEvidenceGaps.slice(0, 6) : ['No open evidence gaps from current checks.'], 'amber'], ['Watch Next', dedupedWatchNext.slice(0, 5), 'mint']].map(([title, items, tone]) => <div key={title as string} style={{ marginBottom: 10 }}><p style={{ margin: '0 0 8px', color: tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : '#2dd4bf', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 900 }}>{title as string}</p><div style={{ display: 'grid', gap: 8 }}>{(items as string[]).map((line) => <div key={line} style={{ display: 'grid', gridTemplateColumns: '14px 1fr', gap: 8, padding: 10, borderRadius: 13, border: '1px solid rgba(148,163,184,.11)', background: 'rgba(15,23,42,.48)' }}><span style={{ marginTop: 4, width: 7, height: 7, borderRadius: 999, background: tone === 'risk' ? '#fb7185' : tone === 'amber' ? '#fbbf24' : '#2dd4bf' }} /><span style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.45 }}>{line}</span></div>)}</div></div>)}
        </Section>
      </aside>
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  border: '1px solid rgba(45,212,191,0.28)',
  background: 'rgba(45,212,191,0.10)',
  color: '#99f6e4',
  borderRadius: '10px',
  padding: '7px 10px',
  cursor: 'pointer',
  fontSize: '10px',
  fontWeight: 800,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  fontFamily: 'var(--font-plex-mono)',
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

'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

type ChainKey = 'base' | 'eth'

type RadarDrawerToken = {
  name: string
  symbol: string
  contract: string
  ageMinutes: number
  liquidityUsd: number
  volume24h: number
  fdvUsd?: number | null
  radarScore: number
  momentum: string
  flags: string[]
  status: string
  clarkSignal?: string | null
  clarkVerdict?: string | null
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
    marketStatus?: string | null
    marketConfidence?: string | null
    poolCount?: number | null
    observedPoolPresent?: boolean | null
    observedPoolCount?: number | null
    poolCountStatus?: "confirmed" | "inferred_from_primary_pool" | "unknown" | string | null
  } | null
  lp?: {
    lpLockStatus?: string | null
    lpLockAmount?: number | null
    lpUnlockTime?: string | number | null
    lpController?: string | null
    lpProofStatus?: string | null
    lpProofApplicability?: string | null
    lpControl?: { status?: string | null; confidence?: string | null; reason?: string | null } | null
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
    pastLaunches?: number | null
    rugHistoryVerified?: boolean | null
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
  socials?: Record<string, unknown> | null
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

function precisePercent(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'N/A'
  const abs = Math.abs(v)
  if (abs > 0 && abs < 0.01) return `${v.toFixed(4)}%`
  if (abs > 0 && abs < 0.1) return `${v.toFixed(3)}%`
  return `${v.toFixed(1)}%`
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
  if (applicability === 'not_applicable') return 'Not applicable'
  if (amount != null && Number.isFinite(amount)) return String(amount)
  if (!hasVerifiedLock(lockStatus) && (lockStatus || proofStatus === 'missing' || proofStatus === 'partial')) return 'No verified lock'
  return 'Open Check'
}

function unlockTimeLabel(value: string | number | null | undefined, lockStatus?: string | null, proofStatus?: string | null, applicability?: string | null): string {
  if (applicability === 'not_applicable') return 'Not applicable'
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

function creatorTopHolderLabel(inTopHolders: boolean | null | undefined, creatorPercent: number | null | undefined): string {
  if (inTopHolders === true) return creatorPercent != null && Number.isFinite(creatorPercent) ? `Yes · ${precisePercent(creatorPercent)}` : 'Yes'
  if (inTopHolders === false) return 'No'
  return 'Open Check'
}

function lpDataModeLabel(mode: string | null | undefined, confidence: string | null | undefined): string {
  return `${mode ? publicStatus(mode) : 'Fallback'} · ${confidence ?? 'limited'}`
}

function Section({ title, state, children }: { title: string; state?: ApiState<unknown>; children: React.ReactNode }) {
  const loading = state?.isLoading
  return (
    <section style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
        <h3 style={{ margin: 0, color: '#f8fafc', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{title}</h3>
        {state?.error ? <span style={{ color: '#fbbf24', fontSize: '9px', fontFamily: 'var(--font-plex-mono)' }}>Limited</span> : null}
      </div>
      {loading ? <SkeletonRows /> : children}
    </section>
  )
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

function DrawerLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return <span style={{ color: '#475569' }}>{label}: unavailable</span>
  return <a href={href} target="_blank" rel="noreferrer" style={{ color: '#67e8f9', textDecoration: 'none' }}>{label}</a>
}

function MiniChart({ points }: { points: ChartPoint[] }) {
  const values = points.map((p) => Number(p.close ?? p.price ?? p.value)).filter(Number.isFinite)
  const path = useMemo(() => {
    if (values.length < 2) return ''
    const min = Math.min(...values)
    const max = Math.max(...values)
    const spread = max - min || 1
    return values.map((v, i) => {
      const x = (i / (values.length - 1)) * 320
      const y = 86 - ((v - min) / spread) * 70
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    }).join(' ')
  }, [values])

  if (!path) return <p style={{ color: '#64748b', fontSize: '11px', margin: 0 }}>OHLCV chart data is unavailable for this token right now.</p>

  return (
    <svg viewBox="0 0 320 96" width="100%" height="110" role="img" aria-label="Token mini chart" style={{ borderRadius: '12px', background: 'rgba(15,23,42,0.65)', border: '1px solid rgba(45,212,191,0.12)' }}>
      <path d={path} fill="none" stroke="#2DD4BF" strokeWidth="2" />
      <path d={`${path} L320 96 L0 96 Z`} fill="rgba(45,212,191,0.08)" stroke="none" />
    </svg>
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

  const lpControlStatus = lp?.lpControl?.status ?? null
  const lpControllerLabel = controllerLabel(lp?.lpController, lpControlStatus)
  const lpLockStatusLabel = lockStatusLabel(lp?.lpLockStatus, lp?.lpProofStatus, lp?.lpProofApplicability)
  const lpProofLabel = proofLabel(lp?.lpProofStatus, lp?.lpProofApplicability)
  const lpRiskLabelValue = lpRiskLabel(lpControlStatus, lp?.lpController, lp?.lpLockStatus, lp?.lpExitRiskReason, lp?.lpExitRisk)
  const concentrationRisk = concentrationRiskLabel(concentration.top10, concentration.top20, concentration.concentration)
  const clusterLabel = clusterEvidenceLabel(deployer?.clusterEvidence)
  const deployerMethod = publicMethodLabel(deployer?.methodLabel)
  const holderStatusLabel = holderStatus(concentration.status, concentration.confidence, concentration.reason)
  const securityTax = security?.honeypot?.simulationSuccess ? `${percent(security.honeypot.buyTax)} buy · ${percent(security.honeypot.sellTax)} sell` : 'Open Check'
  const ownershipLabel = security?.devOwnership?.ownershipLabel ?? (security?.devOwnership?.ownershipVerified === true && security.devOwnership.isRenounced === true ? 'Renounced ownership' : security?.devOwnership?.ownershipVerified === true && (security.devOwnership.ownerAddress || security.devOwnership.adminAddress) ? 'Active owner/admin verified' : 'Open Check / Not verified')

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
    `${poolDistributionLine} Momentum is ${(token?.momentum ?? 'unknown').toLowerCase()} and radar score is ${token?.radarScore ?? 'N/A'}.`,
    lpCortexLine,
    holderCortexLine,
    deployer?.deployerAddress ? `Deployer ${shortAddr(deployer.deployerAddress)} is ${publicStatus(deployer.deployerStatus ?? 'reviewed')} at ${deployer.deployerConfidence ?? 'open-check'} confidence.` : 'Deployer is Open Check in the current evidence.',
    token?.flags?.length ? `Risk context: ${token.flags.join(', ')}.` : 'Risk context: no radar flags on this card.',
  ]

  async function copyText(value: string) {
    await navigator.clipboard?.writeText(value)
  }

  if (!token) return null

  return (
    <div aria-hidden={!open}>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: open ? 'rgba(2,6,23,0.58)' : 'transparent', backdropFilter: open ? 'blur(3px)' : 'none', pointerEvents: open ? 'auto' : 'none', transition: 'background 0.2s, backdrop-filter 0.2s', zIndex: 70 }} />
      <aside role="dialog" aria-modal="true" aria-label="Project overview" style={{ position: 'fixed', top: 0, right: 0, height: '100dvh', width: 'min(560px, 100vw)', transform: open ? 'translateX(0)' : 'translateX(105%)', transition: 'transform 0.28s cubic-bezier(.22,1,.36,1)', zIndex: 80, background: 'linear-gradient(180deg, rgba(15,23,42,0.98), rgba(2,6,23,0.98))', borderLeft: '1px solid rgba(45,212,191,0.18)', boxShadow: '-28px 0 80px rgba(0,0,0,0.42)', color: '#e2e8f0', overflowY: 'auto', padding: '18px' }}>
        <header style={{ position: 'sticky', top: 0, zIndex: 1, margin: '-18px -18px 14px', padding: '18px', background: 'rgba(2,6,23,0.92)', backdropFilter: 'blur(16px)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: '20px', color: '#f8fafc' }}>{token.name} <span style={{ color: '#64748b' }}>({token.symbol})</span></h2>
                <span style={{ padding: '3px 8px', borderRadius: '999px', background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.24)', color: '#99f6e4', fontSize: '10px', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>{chain === 'base' ? 'Base' : 'ETH'}</span>
              </div>
              <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: '11px', fontFamily: 'var(--font-plex-mono)' }}>{shortAddr(token.contract)}</p>
            </div>
            <button onClick={onClose} aria-label="Close project overview" style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: '#cbd5e1', borderRadius: '10px', width: '34px', height: '34px', cursor: 'pointer' }}>×</button>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
            <button onClick={() => copyText(token.contract)} style={buttonStyle}>Copy CA</button>
            <a href={`/terminal/token-scanner?contract=${token.contract}`} style={{ ...buttonStyle, textDecoration: 'none' }}>Open in Token Scanner</a>
          </div>
        </header>

        <Section title="Quick Stats">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0 12px' }}>
            <DataRow label="Liquidity" value={fmtUSD(market?.liquidityUsd ?? token.liquidityUsd)} />
            <DataRow label="Volume 24h" value={fmtUSD(market?.volume24hUsd ?? token.volume24h)} />
            <DataRow label="FDV" value={fmtUSD(market?.fdvUsd ?? token.fdvUsd ?? null)} />
            <DataRow label="Score" value={`${token.radarScore}/100`} />
            <DataRow label="Momentum" value={token.momentum} />
            <DataRow label="Age" value={fmtAge(token.ageMinutes)} />
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>{(token.flags.length ? token.flags : ['No radar tags']).map((flag) => <span key={flag} style={tagStyle}>{flag}</span>)}</div>
        </Section>

        <Section title="Socials" state={enrichmentState}>
          <div style={{ display: 'grid', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-plex-mono)' }}>
            <DrawerLink href={asLink(socials.website)} label="Website" />
            <DrawerLink href={asLink(socials.twitter)} label="Twitter" />
            <DrawerLink href={asLink(socials.telegram)} label="Telegram" />
            <DrawerLink href={dexScreener} label="Market chart" />
            <DrawerLink href={geckoTerminal} label="Pool explorer" />
            <DrawerLink href={explorer} label="Block explorer" />
            <button onClick={() => copyText(socialLinks.join('\n'))} disabled={socialLinks.length === 0} style={{ ...buttonStyle, width: 'fit-content', opacity: socialLinks.length ? 1 : 0.45 }}>Copy all links</button>
          </div>
        </Section>

        <Section title="LP Safety Snapshot" state={enrichmentState}>
          <DataRow label="Lock status" value={lpLockStatusLabel} />
          <DataRow label="LP proof" value={lpProofLabel} />
          <DataRow label="Controller" value={lpControllerLabel} />
          <DataRow label="Control" value={`${lpControlStatus ? publicStatus(lpControlStatus) : 'Open Check'} · ${lp?.lpControl?.confidence ?? lp?.lpDataConfidence ?? 'open-check'}`} />
          <DataRow label="Lock amount" value={lockAmountLabel(lp?.lpLockAmount, lp?.lpLockStatus, lp?.lpProofStatus, lp?.lpProofApplicability)} />
          <DataRow label="Unlock time" value={unlockTimeLabel(lp?.lpUnlockTime, lp?.lpLockStatus, lp?.lpProofStatus, lp?.lpProofApplicability)} />
          <DataRow label="Data mode" value={lpDataModeLabel(lp?.lpDataMode, lp?.lpDataConfidence)} />
          <DataRow label="Risk" value={lpRiskLabelValue} mono={false} />
          <a href={`/terminal/liquidity?address=${token.contract}&chain=${chain}`} style={{ ...buttonStyle, display: 'inline-flex', marginTop: '10px', textDecoration: 'none' }}>Open full LP Safety</a>
        </Section>

        <Section title="Deployer Intelligence" state={enrichmentState}>
          <DataRow label="Deployer" value={shortAddr(deployer?.deployerAddress)} />
          <DataRow label="Status" value={`${deployer?.deployerStatus ? publicStatus(deployer.deployerStatus) : 'Open Check'} · ${deployer?.deployerConfidence ?? 'limited'}`} />
          <DataRow label="Method" value={deployerMethod} />
          <DataRow label="Past launches" value={deployer?.pastLaunches == null ? 'Open Check' : String(deployer.pastLaunches)} />
          <DataRow label="Rug history" value={deployer?.rugHistoryVerified === true ? 'Verified rug history' : deployer?.rugHistoryVerified === false ? 'No verified rug flags' : 'Open Check'} />
          <DataRow label="Cluster detection" value={clusterLabel} />
          <DataRow label="Linked wallet supply" value={percent(deployer?.clusterEvidence?.linkedWalletSupplyPercent ?? deployer?.supplyControl?.linkedWalletSupplyPercent ?? null)} />
          <DataRow label="Creator in top holders" value={creatorTopHolderLabel(deployer?.creatorInTopHolders, deployer?.creatorHolderPercent)} />
          <DataRow label="Ownership" value={ownershipLabel} mono={false} />
        </Section>

        <Section title="Holder Distribution" state={enrichmentState}>
          <DataRow label="Top 1 / 10 / 20" value={`${percent(concentration.top1)} / ${percent(concentration.top10)} / ${percent(concentration.top20)}`} />
          <DataRow label="Holder count" value={concentration.holderCount == null ? 'Open Check' : String(concentration.holderCount)} />
          <DataRow label="Evidence status" value={holderStatusLabel} />
          <DataRow label="Concentration risk" value={concentrationRisk === 'Open Check' ? concentrationRisk : `${concentrationRisk} concentration`} />
          <DataRow label="Creator in top holders" value={creatorTopHolderLabel(concentration.creatorInTopHolders, concentration.creatorHolderPercent)} />
          <DataRow label="Trading taxes" value={securityTax} />
          <div style={{ marginTop: '8px', display: 'grid', gap: '6px' }}>{topHolders.slice(0, 5).map((h, idx) => <DataRow key={`${h.address}-${idx}`} label={`#${h.rank ?? idx + 1}`} value={`${shortAddr(h.address)} · ${percent(getHolderPercent(h))}`} />)}</div>
        </Section>

        <Section title="Mini Chart" state={enrichmentState}>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>{['1h', '6h', '24h'].map((tf) => <span key={tf} style={tagStyle}>{tf}</span>)}</div>
          <MiniChart points={chartPoints} />
        </Section>

        <Section title="CORTEX Radar Read">
          <ul style={{ margin: 0, paddingLeft: '18px', color: '#cbd5e1', fontSize: '12px', lineHeight: 1.55 }}>
            {cortexRead.map((line) => <li key={line}>{line}</li>)}
          </ul>
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

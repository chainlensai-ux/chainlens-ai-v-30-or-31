'use client'

import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'

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

type TokenMetadata = {
  name?: string | null
  symbol?: string | null
  projectSocials?: Record<string, unknown> | null
  priceChart?: { points?: ChartPoint[]; timeframe?: string | null } | null
  holderDistribution?: HolderDistribution | null
  holderResolver?: { holders?: HolderRow[]; confidence?: string | null; reason?: string | null } | null
  sections?: { holders?: Record<string, unknown>; liquidity?: Record<string, unknown> } | null
}

type LiquiditySafetyPayload = {
  ok?: boolean
  data?: {
    lpLockStatus?: string | null
    lpLockAmount?: number | null
    lpUnlockTime?: number | null
    lpController?: string | null
    lp_data_mode?: string | null
    lp_data_confidence?: string | null
  }
  error?: string
}

type WalletScannerPayload = {
  deployerAddress?: string | null
  previousProjects?: Array<{ contractAddress?: string | null; symbol?: string | null; rugFlag?: boolean | null; rugReason?: string | null; createdAt?: string | null }>
  suspiciousTransfers?: boolean | null
  suspiciousTransferReasons?: string[]
  clarkVerdict?: { label?: string | null; confidence?: string | null; summary?: string | null } | null
  clusterMap?: unknown
  devClusterSupply?: number | null
  linkedWallets?: Array<unknown>
  supplyControlStatus?: string | null
}

type HolderRow = { rank?: number | null; address?: string | null; percent?: number | null; pctOfSupply?: number | null; isContract?: boolean | null; walletType?: string | null }
type HolderDistribution = { topHolders?: HolderRow[]; top1?: number | null; top10?: number | null; top20?: number | null; holderCount?: number | null }
type HoldersPayload = { topHolders?: HolderRow[]; concentration?: { top1?: number | null; top10?: number | null; top20?: number | null; holderCount?: number | null; status?: string | null }; contractCount?: number; eoaCount?: number; smartWallets?: number; snipers?: number; status?: string | null; reason?: string | null }
type ChartPoint = { timestamp: number | string; price?: number | null; close?: number | null; value?: number | null }
type OhlcvPayload = { points?: ChartPoint[]; timeframe?: string | null; source?: string | null; status?: string | null; reason?: string | null }

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
  const query = address ? `address=${encodeURIComponent(address)}&chain=${chain}` : ''
  const contractQuery = address ? `contract=${encodeURIComponent(address)}&chain=${chain}` : ''

  const [tokenMeta, lpSafety, walletIntel, holders, ohlcv] = useQueries({
    queries: [
      { queryKey: ['project-overview-token', chain, address], queryFn: () => fetchJson<TokenMetadata>(`/api/token?${contractQuery}`), enabled, staleTime: 60_000 },
      { queryKey: ['project-overview-lp', chain, address], queryFn: () => fetchJson<LiquiditySafetyPayload>(`/api/liquidity-safety?${query}`), enabled, staleTime: 60_000, retry: false },
      { queryKey: ['project-overview-wallet', chain, address], queryFn: () => fetchJson<WalletScannerPayload>(`/api/wallet-scanner?${query}`), enabled, staleTime: 60_000, retry: false },
      { queryKey: ['project-overview-holders', chain, address], queryFn: () => fetchJson<HoldersPayload>(`/api/holders?${query}`), enabled, staleTime: 60_000, retry: false },
      { queryKey: ['project-overview-ohlcv', chain, address], queryFn: () => fetchJson<OhlcvPayload>(`/api/ohlcv?${query}`), enabled, staleTime: 60_000, retry: false },
    ],
  })

  const socials = tokenMeta.data?.projectSocials ?? {}
  const dexScreener = address ? `https://dexscreener.com/${chain}/${address}` : null
  const geckoTerminal = address ? `https://www.geckoterminal.com/${GT_NETWORK[chain]}/tokens/${address}` : null
  const explorer = address ? `${EXPLORER[chain]}/token/${address}` : null
  const socialLinks = [asLink(socials.website), asLink(socials.twitter), asLink(socials.telegram), dexScreener, geckoTerminal, explorer].filter((link): link is string => Boolean(link))
  const chartPoints = ohlcv.data?.points ?? tokenMeta.data?.priceChart?.points ?? []
  const lp = lpSafety.data?.data
  const concentration = holders.data?.concentration ?? tokenMeta.data?.holderDistribution ?? {}
  const topHolders = holders.data?.topHolders ?? tokenMeta.data?.holderDistribution?.topHolders ?? tokenMeta.data?.holderResolver?.holders ?? []

  const cortexRead = [
    `Liquidity is ${fmtUSD(token?.liquidityUsd)} with ${token?.momentum ?? 'unknown'} momentum and a radar score of ${token?.radarScore ?? 'N/A'}.`,
    `LP status is ${lp?.lpLockStatus ?? 'unverified'} at ${lp?.lp_data_confidence ?? 'unverified'} confidence; unverified fields are intentionally not inferred.`,
    walletIntel.data?.deployerAddress ? `Deployer ${shortAddr(walletIntel.data.deployerAddress)} has ${walletIntel.data.previousProjects?.length ?? 0} indexed prior launch(es).` : 'Deployer is not confirmed by the current wallet scanner pass.',
    `Top holder concentration is ${percent(concentration.top10)} for top 10 holders; contract/EOA and sniper labels depend on indexed holder coverage.`,
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
            <DataRow label="Liquidity" value={fmtUSD(token.liquidityUsd)} />
            <DataRow label="Volume 24h" value={fmtUSD(token.volume24h)} />
            <DataRow label="FDV" value={fmtUSD(token.fdvUsd ?? null)} />
            <DataRow label="Score" value={`${token.radarScore}/100`} />
            <DataRow label="Momentum" value={token.momentum} />
            <DataRow label="Age" value={fmtAge(token.ageMinutes)} />
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>{(token.flags.length ? token.flags : ['No radar tags']).map((flag) => <span key={flag} style={tagStyle}>{flag}</span>)}</div>
        </Section>

        <Section title="Socials" state={tokenMeta as ApiState<unknown>}>
          <div style={{ display: 'grid', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-plex-mono)' }}>
            <DrawerLink href={asLink(socials.website)} label="Website" />
            <DrawerLink href={asLink(socials.twitter)} label="Twitter" />
            <DrawerLink href={asLink(socials.telegram)} label="Telegram" />
            <DrawerLink href={dexScreener} label="DexScreener" />
            <DrawerLink href={geckoTerminal} label="GeckoTerminal" />
            <DrawerLink href={explorer} label={chain === 'base' ? 'BaseScan' : 'Etherscan'} />
            <button onClick={() => copyText(socialLinks.join('\n'))} disabled={socialLinks.length === 0} style={{ ...buttonStyle, width: 'fit-content', opacity: socialLinks.length ? 1 : 0.45 }}>Copy all links</button>
          </div>
        </Section>

        <Section title="LP Safety Snapshot" state={lpSafety as ApiState<unknown>}>
          <DataRow label="Lock status" value={lp?.lpLockStatus ?? 'Unverified'} />
          <DataRow label="Lock amount" value={lp?.lpLockAmount == null ? 'N/A' : String(lp.lpLockAmount)} />
          <DataRow label="Unlock time" value={lp?.lpUnlockTime ? new Date(lp.lpUnlockTime * 1000).toUTCString() : 'N/A'} />
          <DataRow label="Controller" value={lp?.lpController ?? 'Unknown'} />
          <DataRow label="Data mode" value={`${lp?.lp_data_mode ?? 'unknown'} · ${lp?.lp_data_confidence ?? 'unverified'}`} />
          <a href={`/terminal/liquidity?address=${token.contract}&chain=${chain}`} style={{ ...buttonStyle, display: 'inline-flex', marginTop: '10px', textDecoration: 'none' }}>Open full LP Safety</a>
        </Section>

        <Section title="Deployer Intelligence" state={walletIntel as ApiState<unknown>}>
          <DataRow label="Deployer" value={shortAddr(walletIntel.data?.deployerAddress)} />
          <DataRow label="Past launches" value={String(walletIntel.data?.previousProjects?.length ?? 0)} />
          <DataRow label="Rug history" value={(walletIntel.data?.previousProjects ?? []).some((p) => p.rugFlag) ? 'Flagged' : 'No verified rug flags'} />
          <DataRow label="Profit history" value="Unavailable in current scanner payload" />
          <DataRow label="Cluster detection" value={walletIntel.data?.clusterMap ? `Detected · ${percent(walletIntel.data.devClusterSupply ?? null)}` : 'Not confirmed'} />
        </Section>

        <Section title="Holder Distribution" state={holders as ApiState<unknown>}>
          <DataRow label="Top 1 / 10 / 20" value={`${percent(concentration.top1)} / ${percent(concentration.top10)} / ${percent(concentration.top20)}`} />
          <DataRow label="Holder count" value={String(concentration.holderCount ?? topHolders.length ?? 'N/A')} />
          <DataRow label="Contract vs EOA" value={`${holders.data?.contractCount ?? 0} contracts · ${holders.data?.eoaCount ?? 0} EOAs`} />
          <DataRow label="Smart wallets" value={String(holders.data?.smartWallets ?? 0)} />
          <DataRow label="Snipers" value={String(holders.data?.snipers ?? 0)} />
          <div style={{ marginTop: '8px', display: 'grid', gap: '6px' }}>{topHolders.slice(0, 5).map((h, idx) => <DataRow key={`${h.address}-${idx}`} label={`#${h.rank ?? idx + 1}`} value={`${shortAddr(h.address)} · ${percent(getHolderPercent(h))}`} />)}</div>
        </Section>

        <Section title="Mini Chart" state={ohlcv as ApiState<unknown>}>
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

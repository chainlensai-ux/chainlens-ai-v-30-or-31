'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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
}

interface RadarStats {
  totalNewTokens: number
  averageLiquidity: number
}

interface RadarData {
  tokens: RadarToken[]
  stats: RadarStats
  fetchedAt: string
}

type RadarStatus = 'HOT' | 'WATCH' | 'EARLY' | 'UNVERIFIED' | 'RISKY' | 'DEAD'
type MomentumLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
type RadarFilter = 'ALL' | RadarStatus
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
}

interface RadarSummary {
  newPools: number
  worthWatching: number
  highMomentum: number
  unverified: number
  averageLiquidity: number
  highestLiquidityToken: string
  hottestToken: string
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
  { key: 'ALL', label: 'All' },
  { key: 'HOT', label: 'Hot' },
  { key: 'WATCH', label: 'Watch' },
  { key: 'EARLY', label: 'Early' },
  { key: 'RISKY', label: 'Risky' },
  { key: 'UNVERIFIED', label: 'Unverified' },
]

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: 'NEWEST', label: 'Newest' },
  { key: 'HIGHEST_SCORE', label: 'Highest Score' },
  { key: 'HIGHEST_LIQUIDITY', label: 'Highest Liquidity' },
  { key: 'HIGHEST_VOLUME', label: 'Highest Volume' },
  { key: 'HIGHEST_MOMENTUM', label: 'Highest Momentum' },
]

function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
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
  const insufficientData = !hasEnoughMarketData || !token.honeypot?.simulationSuccess

  if (insufficientData) return 'UNVERIFIED'
  if (token.volume24h <= 0 && token.ageMinutes > 30) return 'DEAD'
  if (score >= 80 && (momentum === 'HIGH' || momentum === 'MEDIUM')) return 'HOT'
  if (token.ageMinutes <= 30 && score >= 50) return 'EARLY'
  if (score >= 60) return 'WATCH'
  if (score < 40) return 'RISKY'
  return 'WATCH'
}

function applyScoreTrustCaps(token: RadarToken, score: number, status: RadarStatus, momentum: MomentumLevel): number {
  let capped = score
  const hasSecurity = Boolean(token.honeypot?.simulationSuccess)

  if (!hasSecurity) capped = Math.min(capped, 75)
  if (status === 'UNVERIFIED') capped = Math.min(capped, 65)
  if (token.volume24h <= 0) capped = Math.min(capped, 55)
  if (token.liquidityUsd < 2_000) capped = Math.min(capped, 60)

  const premiumEligible = token.liquidityUsd >= 30_000
    && token.volume24h >= 10_000
    && (momentum === 'HIGH' || momentum === 'MEDIUM')
    && status !== 'UNVERIFIED'

  if (!premiumEligible && capped >= 90) capped = 89

  return Math.max(0, Math.min(100, Math.round(capped)))
}

function getClarkSignal(status: RadarStatus): string {
  const map: Record<RadarStatus, string> = {
    HOT: 'Strong early activity relative to liquidity. Worth watching closely, but still verify before entry.',
    WATCH: 'Fresh Base pool with some traction. Monitor liquidity and volume before making a move.',
    EARLY: 'Very new pool. Not enough history yet, but early activity is visible.',
    UNVERIFIED: 'Not enough verified market data yet. Treat as unconfirmed, not automatically safe.',
    RISKY: 'Weak liquidity, poor activity, or tax/branding flags detected. Approach carefully.',
    DEAD: 'No meaningful trading activity detected yet. Likely inactive or too early.',
  }
  return map[status]
}

function getFlags(token: RadarToken, status: RadarStatus, momentum: MomentumLevel, suspiciousBranding: boolean): string[] {
  const flags: string[] = []
  const buyTax = token.honeypot?.buyTax ?? 0
  const sellTax = token.honeypot?.sellTax ?? 0

  if (token.liquidityUsd < 2_000) flags.push('Low liquidity')
  if (token.liquidityUsd >= 30_000) flags.push('High liquidity')
  if (token.volume24h <= 0) flags.push('No volume')
  if (momentum === 'HIGH') flags.push('High momentum')
  if (token.ageMinutes <= 30) flags.push('Very new')
  if (buyTax > 5 || sellTax > 5) flags.push('High tax')
  if (buyTax === 0 && sellTax === 0 && token.honeypot?.simulationSuccess) flags.push('Clean tax')
  if (suspiciousBranding) flags.push('Suspicious branding')
  if (status === 'UNVERIFIED') flags.push('Unverified')

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
  if (token.honeypot?.simulationSuccess) {
    const buyTax = token.honeypot.buyTax ?? 0
    const sellTax = token.honeypot.sellTax ?? 0
    taxes = buyTax > 5 || sellTax > 5 ? 'High' : 'Clean'
  }

  const security: QualityLevel = token.honeypot?.simulationSuccess ? 'Verified' : 'Security Unknown'

  return { liquidity, volume, age, taxes, security }
}

function enrichToken(token: RadarToken): TokenIntel {
  const suspiciousBranding = hasSuspiciousBranding(token.name, token.symbol)
  const { level: momentum, ratio: momentumRatio } = getMomentum(token.volume24h, token.liquidityUsd)
  const baseScore = getBaseRadarScore(token)
  const baseStatus = getStatus(token, baseScore, momentum)
  const radarScore = applyScoreTrustCaps(token, baseScore, baseStatus, momentum)
  const status = getStatus(token, radarScore, momentum)

  return {
    ...token,
    suspiciousBranding,
    momentum,
    momentumRatio,
    radarScore,
    status,
    flags: getFlags(token, status, momentum, suspiciousBranding),
    clarkSignal: getClarkSignal(status),
    launchQuality: getLaunchQuality(token),
  }
}

function qualityColor(level: QualityLevel): string {
  if (['Strong', 'High', 'Clean', 'Verified', 'Fresh'].includes(level)) return '#2DD4BF'
  if (['OK', 'Medium', 'New'].includes(level)) return '#60a5fa'
  if (['Unknown', 'Low'].includes(level)) return '#94a3b8'
  return '#fbbf24'
}

function TokenCard({
  token,
  index,
  onScan,
  onAskClark,
  onTrackToggle,
  tracking,
}: {
  token: TokenIntel
  index: number
  onScan: () => void
  onAskClark: () => void
  onTrackToggle: () => void
  tracking: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const statusColor = STATUS_COLOR[token.status]
  const statusBg = STATUS_BG[token.status]
  const statusBorder = STATUS_BORDER[token.status]

  const buyTax = token.honeypot?.buyTax
  const sellTax = token.honeypot?.sellTax
  const securityVerified = token.honeypot?.simulationSuccess
  const avatarText = (token.symbol || token.name || '?').slice(0, 2).toUpperCase()

  return (
    <div
      onClick={onScan}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${hovered ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)'}`,
        borderRadius: '14px',
        padding: '12px',
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s',
        animation: 'radarSlideIn 0.35s ease both',
        animationDelay: `${index * 45}ms`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '2px',
          background: statusColor,
          opacity: 0.65,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
          <div style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '10px',
            fontWeight: 700,
            color: '#e2e8f0',
            background: 'linear-gradient(135deg, rgba(45,212,191,0.25), rgba(168,85,247,0.22))',
            border: '1px solid rgba(255,255,255,0.16)',
            fontFamily: 'var(--font-plex-mono)',
            flexShrink: 0,
          }}>
            {avatarText}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {token.name}
              </span>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>{token.symbol}</span>
            </div>
            <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{shortAddr(token.contract)}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          <span style={{ padding: '3px 8px', borderRadius: '99px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', color: '#94a3b8', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: 'var(--font-plex-mono)' }}>
            {fmtAge(token.ageMinutes)}
          </span>
          <span style={{ padding: '3px 8px', borderRadius: '99px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: statusColor, background: statusBg, border: `1px solid ${statusBorder}`, fontFamily: 'var(--font-plex-mono)' }}>
            {token.status}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '8px', marginBottom: '7px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '8px' }}>
          <Metric label='Score' value={String(token.radarScore)} accent={token.radarScore >= 80 ? '#22d3ee' : '#e2e8f0'} />
          <Metric label='Liquidity' value={fmtUSD(token.liquidityUsd)} />
          <Metric label='Vol 24h' value={fmtUSD(token.volume24h)} />
          <Metric label='FDV' value={token.fdvUsd ? fmtUSD(token.fdvUsd) : 'N/A'} />
          <Metric label='Momentum' value={token.momentum} />
          <Metric label='Tax' value={securityVerified ? `B ${buyTax?.toFixed(1) ?? '0'} / S ${sellTax?.toFixed(1) ?? '0'}%` : 'Unknown'} />
        </div>
        <div style={{
          borderRadius: '10px',
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'linear-gradient(180deg, rgba(45,212,191,0.06), rgba(168,85,247,0.04))',
          padding: '5px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}>
          <svg viewBox='0 0 110 32' width='100%' height='24' aria-hidden='true'>
            <path d='M2 22 L18 19 L33 21 L46 14 L62 16 L78 9 L93 13 L108 8' stroke='rgba(45,212,191,0.8)' strokeWidth='1.5' fill='none' />
          </svg>
          <span style={{ fontSize: '8px', color: '#475569', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em' }}>
            Sparkline
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '5px', marginBottom: '7px' }}>
        {(
          [
            ['Liquidity', token.launchQuality.liquidity],
            ['Volume', token.launchQuality.volume],
            ['Age', token.launchQuality.age],
            ['Taxes', token.launchQuality.taxes],
            ['Security', token.launchQuality.security],
          ] as Array<[string, QualityLevel]>
        ).map(([label, value]) => (
          <div key={label} style={{ border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '5px 6px', background: 'rgba(255,255,255,0.02)' }}>
            <p style={{ margin: '0 0 2px', fontSize: '8px', letterSpacing: '0.10em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{label}</p>
            <p style={{ margin: 0, fontSize: '10px', fontWeight: 700, color: qualityColor(value), fontFamily: 'var(--font-plex-mono)' }}>{value}</p>
          </div>
        ))}
      </div>

      {token.flags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' }}>
          {token.flags.map(flag => (
            <span key={flag} style={{ padding: '2px 7px', borderRadius: '99px', fontSize: '8px', fontWeight: 700, letterSpacing: '0.08em', color: '#cbd5e1', background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.20)', fontFamily: 'var(--font-plex-mono)' }}>
              {flag}
            </span>
          ))}
        </div>
      )}

      <p style={{ fontSize: '10px', color: '#64748b', margin: '0 0 7px', lineHeight: 1.35, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '7px', fontStyle: 'italic' }}>
        “{token.clarkVerdict ?? token.clarkSignal}”
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <ActionButton label='Scan' onClick={onScan} />
        <ActionButton label='Ask Clark' hint='Analyze with Clark' onClick={onAskClark} />
        <ActionButton label={tracking ? 'Tracking' : 'Track'} active={tracking} onClick={onTrackToggle} />
      </div>
    </div>
  )
}

function ActionButton({
  label,
  onClick,
  disabled,
  active,
  hint,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  hint?: string
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onClick()
      }}
      title={hint}
      disabled={disabled}
      style={{
        padding: '4px 10px',
        borderRadius: '8px',
        fontSize: '9px',
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        border: `1px solid ${active ? 'rgba(45,212,191,0.35)' : 'rgba(255,255,255,0.12)'}`,
        background: active ? 'rgba(45,212,191,0.14)' : 'rgba(255,255,255,0.03)',
        color: disabled ? '#475569' : active ? '#2DD4BF' : '#cbd5e1',
        fontFamily: 'var(--font-plex-mono)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.12em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 2px' }}>
        {label}
      </p>
      <p style={{ fontSize: '11px', fontWeight: 700, color: accent ?? '#e2e8f0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>
        {value}
      </p>
    </div>
  )
}

function PulseStrip({ summary }: { summary: RadarSummary }) {
  const items = [
    { label: 'New Pools', value: String(summary.newPools), icon: '◈', glow: 'rgba(45,212,191,0.24)' },
    { label: 'Worth Watching', value: String(summary.worthWatching), icon: '◎', glow: 'rgba(56,189,248,0.22)' },
    { label: 'High Momentum', value: String(summary.highMomentum), icon: '↗', glow: 'rgba(139,92,246,0.22)' },
    { label: 'Unverified', value: String(summary.unverified), icon: '◌', glow: 'rgba(244,114,182,0.20)' },
    { label: 'Avg Liquidity', value: fmtUSD(summary.averageLiquidity), icon: '$', glow: 'rgba(45,212,191,0.24)' },
    { label: 'Highest Liquidity', value: summary.highestLiquidityToken, icon: '◉', glow: 'rgba(168,85,247,0.22)' },
    { label: 'Hottest Score', value: summary.hottestToken, icon: '✦', glow: 'rgba(236,72,153,0.22)' },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '8px', marginBottom: '14px' }}>
      {items.map((item) => (
        <div key={item.label} style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: '10px',
          padding: '10px',
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.03), 0 0 22px ${item.glow}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <span style={{
              width: '16px',
              height: '16px',
              borderRadius: '5px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.10)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '9px',
              color: '#99f6e4',
              fontFamily: 'var(--font-plex-mono)',
            }}>{item.icon}</span>
            <p style={{ margin: 0, fontSize: '8px', color: '#3a5268', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{item.label}</p>
          </div>
          <p style={{ margin: 0, fontSize: '11px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{item.value}</p>
        </div>
      ))}
    </div>
  )
}

function StatsPanel({ summary, fetchedAt, loading }: { summary: RadarSummary; fetchedAt: string | null; loading: boolean }) {
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
          Data Sources
        </p>
        {[
          'GeckoTerminal / CoinGecko Terminal',
          summary.hasSecurityData ? 'Honeypot.is (security)' : 'ChainLens Radar Engine',
        ].map(src => (
          <div key={src} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '11px', color: '#64748b', marginBottom: '6px', fontFamily: 'var(--font-plex-mono)' }}>
            <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', flexShrink: 0 }} />
            {src}
          </div>
        ))}
      </div>

      <div style={{
        background: 'linear-gradient(180deg, rgba(168,85,247,0.10), rgba(45,212,191,0.08))',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '12px',
        padding: '14px',
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
      </div>
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

function EmptyFeed() {
  return (
    <div style={{ textAlign: 'center', padding: '42px 20px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
      <div style={{ fontSize: '30px', marginBottom: '12px', opacity: 0.4 }}>◈</div>
      <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px' }}>
        No new Base pools detected right now. Radar will refresh shortly.
      </p>
    </div>
  )
}

function LowActivityPanel() {
  return (
    <div style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', padding: '14px 16px', fontFamily: 'var(--font-plex-mono)', marginTop: '10px' }}>
      <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
        Radar is quiet right now. New Base pools will appear here as CoinGecko Terminal detects them.
      </p>
    </div>
  )
}

export default function BaseRadarPage() {
  const router = useRouter()
  const [data, setData] = useState<RadarData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(60)
  const [refreshKey, setRefreshKey] = useState(0)
  const [activeFilter, setActiveFilter] = useState<RadarFilter>('ALL')
  const [sortMode, setSortMode] = useState<SortMode>('NEWEST')
  const [trackedContracts, setTrackedContracts] = useState<Record<string, boolean>>({})

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/radar', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || json.error) {
        setError('Base Radar data source unavailable. Try refresh.')
      } else {
        setData(json as RadarData)
      }
    } catch {
      setError('Base Radar data source unavailable. Try refresh.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          setRefreshKey(k => k + 1)
          return 60
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (refreshKey > 0) {
      fetchData()
      setCountdown(60)
    }
  }, [refreshKey, fetchData])

  function handleManualRefresh() {
    setCountdown(60)
    fetchData()
  }

  function openToken(contract: string) {
    router.push(`/terminal/token-scanner?contract=${contract}`)
  }

  function toggleTrack(contract: string) {
    setTrackedContracts(prev => ({ ...prev, [contract]: !prev[contract] }))
  }

  function askClark(token: TokenIntel) {
    const buyTax = token.honeypot?.buyTax
    const sellTax = token.honeypot?.sellTax
    const security = token.honeypot?.simulationSuccess ? 'Verified' : 'Unknown'
    const prompt = [
      'Analyze this Base Radar token and give me a clear verdict: WATCH, AVOID, or SCAN DEEPER.',
      `Token: ${token.name} (${token.symbol})`,
      `Contract: ${token.contract}`,
      `Radar Score: ${token.radarScore}`,
      `Status: ${token.status}`,
      `Liquidity: ${fmtUSD(token.liquidityUsd)}`,
      `Volume 24h: ${fmtUSD(token.volume24h)}`,
      `FDV: ${token.fdvUsd ? fmtUSD(token.fdvUsd) : 'N/A'}`,
      `Momentum: ${token.momentum}`,
      `Buy Tax: ${buyTax !== null && buyTax !== undefined ? `${buyTax.toFixed(1)}%` : 'Unknown'}`,
      `Sell Tax: ${sellTax !== null && sellTax !== undefined ? `${sellTax.toFixed(1)}%` : 'Unknown'}`,
      `Security: ${security}`,
      `Flags: ${token.flags.length > 0 ? token.flags.join(', ') : 'None'}`,
      `Clark Signal: ${token.clarkVerdict ?? token.clarkSignal}`,
    ].join('\n')

    router.push(`/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}`)
  }

  const tokens = data?.tokens ?? []

  const intelTokens = useMemo(() => tokens.map(enrichToken), [tokens])

  const summary = useMemo<RadarSummary>(() => {
    const worthWatching = intelTokens.filter(token => token.status === 'HOT' || token.status === 'WATCH' || token.status === 'EARLY').length
    const highMomentum = intelTokens.filter(token => token.momentum === 'HIGH').length
    const unverified = intelTokens.filter(token => token.status === 'UNVERIFIED').length
    const averageLiquidity = intelTokens.length > 0 ? Math.round(intelTokens.reduce((sum, token) => sum + token.liquidityUsd, 0) / intelTokens.length) : 0
    const highestLiquidity = [...intelTokens].sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
    const hottest = [...intelTokens].sort((a, b) => b.radarScore - a.radarScore)[0]
    const hasSecurityData = intelTokens.some(token => token.honeypot?.simulationSuccess)

    return {
      newPools: intelTokens.length,
      worthWatching,
      highMomentum,
      unverified,
      averageLiquidity,
      highestLiquidityToken: highestLiquidity ? `${highestLiquidity.symbol} ${fmtUSD(highestLiquidity.liquidityUsd)}` : 'N/A',
      hottestToken: hottest ? `${hottest.symbol} (${hottest.radarScore})` : 'N/A',
      hasSecurityData,
    }
  }, [intelTokens])

  const filteredAndSortedTokens = useMemo(() => {
    const filtered = activeFilter === 'ALL'
      ? intelTokens
      : intelTokens.filter(token => token.status === activeFilter)

    const sorted = [...filtered]

    if (sortMode === 'NEWEST') sorted.sort((a, b) => a.ageMinutes - b.ageMinutes)
    if (sortMode === 'HIGHEST_SCORE') sorted.sort((a, b) => b.radarScore - a.radarScore)
    if (sortMode === 'HIGHEST_LIQUIDITY') sorted.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    if (sortMode === 'HIGHEST_VOLUME') sorted.sort((a, b) => b.volume24h - a.volume24h)
    if (sortMode === 'HIGHEST_MOMENTUM') sorted.sort((a, b) => b.momentumRatio - a.momentumRatio)

    return sorted
  }, [activeFilter, intelTokens, sortMode])

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
          .radar-main { padding: 18px 12px 120px !important; }
          .radar-grid { grid-template-columns: 1fr !important; }
          .radar-stats { position: static !important; }
        }
      `}</style>

      <div className="radar-main" style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '28px 32px 120px', color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#f8fafc', margin: 0, letterSpacing: '-0.01em' }}>Base Radar</h1>

            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '99px', background: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.30)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#ec4899', fontFamily: 'var(--font-plex-mono)' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ec4899', animation: 'livePulse 1.8s ease-in-out infinite', flexShrink: 0 }} />
              LIVE
            </span>
          </div>

          <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 12px' }}>
            Base launch command center — dense signals for new pools, momentum, and risk context.
          </p>

          <PulseStrip summary={summary} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Refresh in {countdown}s</span>
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
                {loading ? 'Scanning…' : 'Refresh'}
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
                {[...Array(4)].map((_, i) => (
                  <div key={i} style={{ height: '120px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', animation: 'radarSlideIn 0.3s ease both', animationDelay: `${i * 80}ms` }} />
                ))}
              </div>
            )}

            {!loading && tokens.length === 0 && !error && <EmptyFeed />}

            {!loading && tokens.length > 0 && filteredAndSortedTokens.length === 0 && (
              <div style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', padding: '16px', fontFamily: 'var(--font-plex-mono)', fontSize: '12px', color: '#64748b' }}>
                No pools match the current filter.
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {filteredAndSortedTokens.map((token, i) => (
                <TokenCard
                  key={`${token.contract}-${refreshKey}`}
                  token={token}
                  index={i}
                  onScan={() => openToken(token.contract)}
                  onAskClark={() => askClark(token)}
                  onTrackToggle={() => toggleTrack(token.contract)}
                  tracking={Boolean(trackedContracts[token.contract])}
                />
              ))}
            </div>

            {!loading && filteredAndSortedTokens.length <= 2 && !error && <LowActivityPanel />}
          </div>

          <div className="radar-stats" style={{ position: 'sticky', top: '0' }}>
            <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 10px' }}>
              Radar Stats
            </p>
            <StatsPanel summary={summary} fetchedAt={data?.fetchedAt ?? null} loading={loading} />
          </div>
        </div>
      </div>
    </>
  )
}

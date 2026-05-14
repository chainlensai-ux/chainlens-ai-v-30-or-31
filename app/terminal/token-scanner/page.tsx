'use client'

import { useState, useEffect } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────

type Pool = {
  name?: string
  address?: string
  price?: number | null
  liquidity?: number | null
  volume24h?: number | null
  priceChange24h?: number | null
  marketCap?: number | null
  fdv?: number | null
  marketCapUsd?: number | null
  fdvUsd?: number | null
  marketCapSource?: 'geckoterminal' | 'coingecko_terminal' | 'computed' | 'unavailable'
  fdvSource?: 'geckoterminal' | 'coingecko_terminal' | 'unavailable'
  circulatingSupply?: number | null
}

type ScanResult = {
  name?: string
  symbol?: string
  contract?: string
  chain?: string
  price?: number | null
  liquidity?: number | null
  volume24h?: number | null
  priceChange24h?: number | null
  marketCap?: number | null
  fdv?: number | null
  marketCapUsd?: number | null
  fdvUsd?: number | null
  marketCapSource?: 'geckoterminal' | 'coingecko_terminal' | 'computed' | 'unavailable'
  marketCapStatus?: string | null
  valuationContext?: {
    primaryValuationLabel: 'Market Cap' | 'FDV'
    primaryValuationUsd: number | null
    primaryValuationStatus: 'verified_mc' | 'fdv_only' | 'unavailable'
    marketCapStatus: 'verified' | 'unverified'
    fdvUsd: number | null
    reason: string
  } | null
  fdvSource?: 'geckoterminal' | 'coingecko_terminal' | 'unavailable'
  circulatingSupply?: number | null
  displayMarketValue?: number | null
  displayMarketValueLabel?: 'Market Cap' | 'Estimated MC' | 'FDV'
  displayMarketValueConfidence?: 'verified' | 'medium' | 'low'
  displayMarketValueReason?: string
  estimatedMarketCap?: number | null
  pools?: Pool[]
  goplus?: Record<string, Record<string, unknown>> | null
  honeypot?: {
    isHoneypot: boolean | null
    buyTax: number | null
    sellTax: number | null
    transferTax: number | null
    simulationSuccess: boolean
  } | null
  noActivePools?: boolean
  primaryDexName?: string | null
  decimals?: number
  holderDistribution?: { top1:number|null; top5:number|null; top10:number|null; top20:number|null; others:number|null; holderCount:number|null; topHolders:Array<{rank:number;address:string;amount:string|number|null;percent:number|null}> } | null
  holderDistributionStatus?: { source?: string; status?: 'ok'|'empty'|'unavailable'|'error'; reason?: string; itemCount?: number; normalizedCount?: number } | null
  debugHolderStatus?: {
    providerCalled?: boolean; chain?: string; endpointPath?: string; authMode?: string;
    hasGoldrushKey?: boolean; hasCovalentKey?: boolean; statusCode?: number|null;
    itemCount?: number; normalizedCount?: number; reason?: string|null;
    responseKeys?: string[]|null; dataKeys?: string[]|null; firstItemKeys?: string[]|null;
  } | null
  sections?: {
    market?: { status?: string; reason?: string; source?: string } | null
    security?: { status?: string; reason?: string; source?: string } | null
    holders?: { status?: string; reason?: string; source?: string } | null
    liquidity?: { status?: string; reason?: string; source?: string } | null
    contractChecks?: { status?: string; reason?: string; source?: string } | null
  } | null
  lpControl?: {
    status?: string
    confidence?: string
    poolType?: string
    source?: string
    reason?: string
    evidence?: string[]
    poolAddressPresent?: boolean
    selectedPrimaryPoolSource?: string
    dexId?: string
    dexName?: string
    probeV2Like?: boolean
    probeV3Like?: boolean
    lpVerificationPoolReason?: string
  } | null
  lpControlRead?: {
    title?: string
    meaning?: string
    riskLevel?: string
    whatWasFound?: string[]
    couldNotVerify?: string[]
    nextAction?: string
  } | null
  poolActivity?: {
    transactions24h: number | null
    buys24h: number | null
    sells24h: number | null
    volume24hUsd: number | null
    buyVolume24hUsd: number | null
    sellVolume24hUsd: number | null
    pairCreatedAt: string | null
    pairAgeLabel: string | null
  } | null
  priceChart?: {
    timeframe: '24h' | '48h' | '7d'
    points: Array<{ timestamp: string; priceUsd: number }>
    sourceStatus: 'ok' | 'unavailable' | 'error'
    reason?: string
    fallbackUsed?: boolean
  } | null
  resolvedInput?: {
    original: string
    type: 'address' | 'alias' | 'live_search'
    resolvedAddress: string
    symbol?: string
    confidence: 'high' | 'medium' | 'low'
  } | null
}

type HolderRow = { rank:number;address:string;amount:string|number|null;percent:number|null }
type HolderStateKind = 'rowsWithPercent' | 'rowsWithoutPercent' | 'noRowsFallback'
type HolderProviderStatus = 'ok' | 'empty' | 'unavailable' | 'error' | 'unknown'
type OwnerStatus = 'Renounced' | 'Held' | 'Unverified'
type SecurityChip = { label: string; displayLabel: string; style: PillStyle; source: 'honeypot' | 'contract' }

type HolderFallbackEvidence = {
  ownerStatus: OwnerStatus
  poolCount: number
  liquidityDepth: number | null
  marketCapToFdvPct: number | null
  marketCapToFdvLabel: string
  holderConcentration: 'Unverified'
  supplySpread: 'Unverified'
  providerReturnedNoRows: boolean
}

type DerivedHolderState = {
  kind: HolderStateKind
  providerStatus: HolderProviderStatus
  safeReason: string
  rows: HolderRow[]
  hasPercentages: boolean
}

type VerdictInput = {
  hasMarketData: boolean
  hasSecurityData: boolean
  hasLiquidityData: boolean
  holderState: DerivedHolderState
  fallbackEvidence: HolderFallbackEvidence
  dedupedSecurityChips: SecurityChip[]
  supports: Array<'verdict'|'marketRead'|'securityRead'|'holderSupplyRead'|'liquidityPoolsRead'|'bullCase'|'bearCase'|'missingChecks'|'nextAction'>
}

// ─── Formatters ───────────────────────────────────────────────────────────

function fmtPrice(v: number | null | undefined): string {
  if (v == null || v <= 0) return 'N/A'
  if (v < 0.001) {
    // Dynamically scale decimal places to show ~3 significant figures, never scientific notation
    const exp = Math.floor(Math.log10(v))      // e.g. -10 for 2.35e-10
    const decimals = Math.min(-exp + 2, 20)    // e.g. 12 decimal places
    return `$${v.toFixed(decimals)}`
  }
  if (v < 1) return `$${v.toFixed(6)}`
  return `$${v.toFixed(4)}`
}

function fmtLarge(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

// Converts a raw ERC-20 balance (in smallest units) to a compact human-readable amount.
// e.g. 9.08e26 with decimals=18 → 908.23M
function fmtTokenAmt(raw: string | number | null, decimals: number): string {
  if (raw == null) return '—'
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const tok = n / Math.pow(10, decimals)
  if (tok >= 1e12) return `${(tok / 1e12).toFixed(2)}T`
  if (tok >= 1e9)  return `${(tok / 1e9).toFixed(2)}B`
  if (tok >= 1e6)  return `${(tok / 1e6).toFixed(2)}M`
  if (tok >= 1e3)  return `${(tok / 1e3).toFixed(2)}K`
  return tok.toFixed(2)
}

function pctColor(v: number | null | undefined): string {
  if (v == null) return '#94a3b8'
  return v >= 0 ? '#2DD4BF' : '#f87171'
}

function MiniPriceChart({ points }: { points: Array<{ timestamp: string; priceUsd: number }> }) {
  if (points.length < 2) return null
  const w = 960
  const h = 360
  const padX = 30
  const padY = 32
  const min = Math.min(...points.map((p) => p.priceUsd))
  const max = Math.max(...points.map((p) => p.priceUsd))
  const spread = Math.max(max - min, 1e-12)
  const yFor = (v: number) => h - padY - ((v - min) / spread) * (h - padY * 2)
  const xFor = (i: number) => padX + (i / (points.length - 1)) * (w - padX * 2)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const d = points.map((p, i) => {
    const x = xFor(i)
    const y = yFor(p.priceUsd)
    return `${i === 0 ? 'M' : 'L'}${x},${y}`
  }).join(' ')
  const area = `${d} L ${xFor(points.length - 1)},${h - padY} L ${xFor(0)},${h - padY} Z`
  const last = points[points.length - 1]
  const lastX = xFor(points.length - 1)
  const lastY = yFor(last.priceUsd)
  const hoverPoint = hoverIndex != null ? points[hoverIndex] : null
  const hoverX = hoverIndex != null ? xFor(hoverIndex) : null
  const hoverY = hoverPoint ? yFor(hoverPoint.priceUsd) : null
  const startTs = new Date(points[0].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const endTs = new Date(last.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const priceDeltaPct = points[0].priceUsd > 0
    ? ((last.priceUsd - points[0].priceUsd) / points[0].priceUsd) * 100
    : null
  const guideRows = [0, 0.25, 0.5, 0.75, 1].map((r) => padY + r * (h - padY * 2))
  const onMove = (clientX: number, rect: DOMRect) => {
    const relativeX = Math.max(padX, Math.min(clientX - rect.left, w - padX))
    const ratio = (relativeX - padX) / (w - padX * 2)
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))))
    setHoverIndex(idx)
  }

  return (
    <div
      style={{ position: 'relative' }}
      onMouseLeave={() => setHoverIndex(null)}
      onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
      onTouchMove={(e) => onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
      onTouchStart={(e) => onMove(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
    >
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'clamp(260px, 34vw, 360px)', display: 'block' }}>
        <defs>
          <linearGradient id="clLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2dd4bf" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
          <linearGradient id="clFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(45,212,191,0.42)" />
            <stop offset="100%" stopColor="rgba(167,139,250,0.01)" />
          </linearGradient>
          <filter id="clGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {guideRows.map((y) => <line key={y} x1={padX} y1={y} x2={w - padX} y2={y} stroke="rgba(148,163,184,0.24)" strokeWidth="1" />)}
        <path d={area} fill="url(#clFill)" />
        <path d={d} fill="none" stroke="url(#clLine)" strokeWidth="3.2" strokeLinejoin="round" strokeLinecap="round" filter="url(#clGlow)" />
        <circle cx={lastX} cy={lastY} r="5.4" fill="#e2e8f0" />
        <circle cx={lastX} cy={lastY} r="10" fill="rgba(226,232,240,0.16)" />
        {hoverX != null && hoverY != null && hoverPoint && (
          <>
            <line x1={hoverX} y1={padY} x2={hoverX} y2={h - padY} stroke="rgba(148,163,184,0.34)" strokeDasharray="4 4" />
            <circle cx={hoverX} cy={hoverY} r="4.8" fill="#c4b5fd" />
          </>
        )}
        <text x={padX} y={20} fill="#94a3b8" style={{ fontSize: 12 }}>Low {fmtPrice(min)}</text>
        <text x={w - padX} y={20} textAnchor="end" fill="#94a3b8" style={{ fontSize: 12 }}>High {fmtPrice(max)}</text>
      </svg>
      <div style={{ position: 'absolute', top: '12px', right: '12px', border: '1px solid rgba(167,139,250,0.5)', background: 'rgba(15,23,42,0.82)', borderRadius: '999px', padding: '6px 10px', color: '#e2e8f0', fontSize: '11px', fontWeight: 700 }}>
        Latest {fmtPrice(last.priceUsd)}
      </div>
      {hoverPoint && (
        <div style={{ position: 'absolute', left: '12px', bottom: '12px', border: '1px solid rgba(45,212,191,0.36)', background: 'rgba(2,6,23,0.88)', borderRadius: '10px', padding: '7px 10px', color: '#cbd5e1', fontSize: '11px' }}>
          <div>{new Date(hoverPoint.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          <div style={{ color: '#99f6e4', fontWeight: 700 }}>{fmtPrice(hoverPoint.priceUsd)}</div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: '#94a3b8', marginTop: '6px' }}>
        <span>{startTs}</span>
        <span style={{ color: priceDeltaPct == null ? '#94a3b8' : priceDeltaPct >= 0 ? '#2dd4bf' : '#f87171' }}>
          {priceDeltaPct == null ? '24h Δ N/A' : `24h Δ ${fmtPct(priceDeltaPct)}`}
        </span>
        <span>{endTs}</span>
      </div>
    </div>
  )
}

function humanizeReasonCode(reason?: string): string {
  if (!reason) return 'Additional verification is required.'
  const map: Record<string, string> = {
    contract_bytecode_unavailable_from_rpc:          'No signal in checked window from current checks.',
    unavailable_circulating_supply_not_verified:      'Circulating supply not fully verified.',
    honeypot_simulation_unavailable_from_provider:    'Live security simulation unavailable.',
    honeypot_provider_unavailable_using_limited_fallback: 'Live simulation unavailable, using limited safety signals.',
    security_simulation_unavailable:                  'Live security simulation unavailable.',
    security_check_limited_signals_used:              'Live simulation unavailable, using limited safety signals.',
    no_active_liquidity_pool_found:                   'No active liquidity pool was found.',
    partial_market_fields_from_provider:              'Some market fields unavailable.',
    partial_market_data:                              'Some market fields unavailable.',
    holder_data_unavailable:                          'Holder data unavailable for this scan.',
  }
  if (map[reason]) return map[reason]
  if (/^[a-z0-9_]+$/.test(reason)) return reason.replace(/_/g, ' ')
  return reason
}

function humanizeSectionLine(source?: string, status?: string, reason?: string): string {
  const sourceMap: Record<string, string> = {
    base_rpc:                  'Contract verification',
    alchemy_rpc:               'Contract verification',
    geckoterminal:             'Market data',
    goldrush:                  'Holder data',
    honeypot:                  'Security simulation',
    'honeypot.is':             'Security simulation',
    goplus_limited_fallback:   'Security signals',
    goplus_optional_fallback:  'Security signals',
    unavailable:               'Data check',
  }
  const sourceLabel = sourceMap[source ?? ''] ?? 'CORTEX check'
  const statusLabel = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'No signal in checked window'
  const reasonText = reason ? humanizeReasonCode(reason) : ''
  if (reasonText && reasonText.toLowerCase().startsWith(statusLabel.toLowerCase())) {
    return `${sourceLabel}: ${reasonText}`
  }
  return `${sourceLabel}: ${statusLabel}${reasonText ? ` — ${reasonText}` : ''}`
}

function shorten(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function evidenceValue(lines: string[] | undefined, label: string): string | null {
  if (!Array.isArray(lines)) return null
  const line = lines.find((l) => l.startsWith(`${label}:`))
  if (!line) return null
  return line.slice(label.length + 1).trim() || null
}

function normalizeHolderProviderStatus(
  status: ScanResult['holderDistributionStatus']
): HolderProviderStatus {
  const s = status?.status
  if (s === 'ok' || s === 'empty' || s === 'unavailable' || s === 'error') return s
  return 'unknown'
}

function holderSafeReason(
  providerStatus: HolderProviderStatus,
  hasRows: boolean
): string {
  if (hasRows) return 'Holder data available.'
  if (providerStatus === 'unavailable') return 'Holder data unavailable for this scan.'
  if (providerStatus === 'error') return 'Holder data returned no usable rows.'
  if (providerStatus === 'empty') return 'Holder data unavailable for this token.'
  return 'Holder concentration currently unverified.'
}

function deriveHolderState(result: ScanResult): DerivedHolderState {
  const rows = result.holderDistribution?.topHolders ?? []
  const hasRows = rows.length > 0
  const hasPercentages = rows.some(r => r.percent != null)
  const providerStatus = normalizeHolderProviderStatus(result.holderDistributionStatus)
  const kind: HolderStateKind = !hasRows
    ? 'noRowsFallback'
    : hasPercentages
      ? 'rowsWithPercent'
      : 'rowsWithoutPercent'
  return {
    kind,
    providerStatus,
    safeReason: holderSafeReason(providerStatus, hasRows),
    rows,
    hasPercentages,
  }
}

function deriveOwnerStatus(gp: Record<string, unknown> | null): OwnerStatus {
  const owner = gp?.owner_address
  if (owner == null) return 'Unverified'
  const addr = String(owner)
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return 'Renounced'
  return 'Held'
}

function deriveHolderFallbackEvidence(result: ScanResult): HolderFallbackEvidence {
  const gp = result.goplus && result.contract
    ? (result.goplus[result.contract.toLowerCase()] ?? null) as Record<string, unknown> | null
    : null
  const ratio = result.marketCapUsd != null && result.fdvUsd != null && result.fdvUsd > 0
    ? (result.marketCapUsd / result.fdvUsd) * 100
    : null
  return {
    ownerStatus: deriveOwnerStatus(gp),
    poolCount: result.pools?.length ?? 0,
    liquidityDepth: result.liquidity ?? null,
    marketCapToFdvPct: ratio,
    marketCapToFdvLabel: ratio == null ? 'MC unavailable' : `${ratio.toFixed(1)}%`,
    holderConcentration: 'Unverified',
    supplySpread: 'Unverified',
    providerReturnedNoRows: (result.holderDistribution?.topHolders?.length ?? 0) === 0,
  }
}

function dedupeSecurityChips(chips: SecurityChip[]): SecurityChip[] {
  const map = new Map<string, SecurityChip>()
  for (const chip of chips) {
    const existing = map.get(chip.label)
    if (!existing) {
      map.set(chip.label, chip)
      continue
    }
    if (chip.source === 'honeypot' && existing.source !== 'honeypot') {
      map.set(chip.label, chip)
    }
  }
  return Array.from(map.values())
}

function deriveVerdictInput(result: ScanResult): VerdictInput {
  const gp = result.goplus && result.contract
    ? (result.goplus[result.contract.toLowerCase()] ?? null) as Record<string, unknown> | null
    : null
  const hp = result.honeypot
  const baseChips: SecurityChip[] = [
    { label: 'Honeypot', displayLabel: hp?.isHoneypot === null ? 'Unverified' : hp?.isHoneypot ? 'YES' : 'NO', style: hp?.isHoneypot ? pillDanger() : pillSafe(), source: 'honeypot' },
    { label: 'Buy Tax', displayLabel: hp?.buyTax == null ? 'N/A' : `${hp.buyTax.toFixed(1)}%`, style: hp?.buyTax == null ? pillMuted() : taxPct(hp.buyTax), source: 'honeypot' },
    { label: 'Sell Tax', displayLabel: hp?.sellTax == null ? 'N/A' : `${hp.sellTax.toFixed(1)}%`, style: hp?.sellTax == null ? pillMuted() : taxPct(hp.sellTax), source: 'honeypot' },
    { label: 'Honeypot', displayLabel: String(gp?.is_honeypot ?? 'N/A'), style: String(gp?.is_honeypot ?? '') === '1' ? pillDanger() : pillSafe(), source: 'contract' },
    { label: 'Buy Tax', displayLabel: gp?.buy_tax != null ? `${(Number(gp.buy_tax) * 100).toFixed(1)}%` : 'N/A', style: gp?.buy_tax != null ? taxPct(Number(gp.buy_tax) * 100) : pillMuted(), source: 'contract' },
    { label: 'Sell Tax', displayLabel: gp?.sell_tax != null ? `${(Number(gp.sell_tax) * 100).toFixed(1)}%` : 'N/A', style: gp?.sell_tax != null ? taxPct(Number(gp.sell_tax) * 100) : pillMuted(), source: 'contract' },
  ]
  return {
    hasMarketData: result.price != null || result.volume24h != null || result.marketCapUsd != null || result.fdvUsd != null,
    hasSecurityData: !!gp || !!hp,
    hasLiquidityData: (result.liquidity ?? 0) > 0 || (result.pools?.length ?? 0) > 0,
    holderState: deriveHolderState(result),
    fallbackEvidence: deriveHolderFallbackEvidence(result),
    dedupedSecurityChips: dedupeSecurityChips(baseChips),
    supports: ['verdict','marketRead','securityRead','holderSupplyRead','liquidityPoolsRead','bullCase','bearCase','missingChecks','nextAction'],
  }
}

// ─── StatCard ─────────────────────────────────────────────────────────────

function StatCard({ label, value, accent, helper }: { label: string; value: string; accent?: string; helper?: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      padding: '16px 20px',
    }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '10px', fontFamily: 'var(--font-plex-mono)',
      }}>
        {label}
      </p>
      <p style={{
        fontSize: '20px', fontWeight: 700,
        color: accent ?? '#e2e8f0',
        fontFamily: 'var(--font-plex-mono)',
        margin: 0,
      }}>
        {value}
      </p>
      {helper && <p style={{ margin: '8px 0 0', fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>{helper}</p>}
    </div>
  )
}

// ─── Contract Security ───────────────────────────────────────────────

type PillStyle = { color: string; bg: string; border: string }

function pillSafe():   PillStyle { return { color: '#34d399', bg: 'rgba(52,211,153,0.09)',   border: 'rgba(52,211,153,0.22)'   } }
function pillDanger(): PillStyle { return { color: '#f87171', bg: 'rgba(248,113,113,0.09)', border: 'rgba(248,113,113,0.25)' } }
function pillAmber():  PillStyle { return { color: '#fbbf24', bg: 'rgba(251,191,36,0.09)',  border: 'rgba(251,191,36,0.25)'  } }
function pillMuted():  PillStyle { return { color: '#3a5268', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.07)' } }

function RiskPill({ label, value }: { label: string; value: PillStyle & { label: string } }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '5px 11px', borderRadius: '99px',
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em',
      fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
      color: value.color, background: value.bg, border: `1px solid ${value.border}`,
    }}>
      <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 500 }}>{label}:</span>
      {value.label}
    </span>
  )
}

type HoneypotData = {
  isHoneypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  transferTax: number | null
  simulationSuccess: boolean
} | null

function taxPct(n: number): PillStyle {
  if (n === 0)    return pillSafe()
  if (n <= 5)     return pillAmber()
  return pillDanger()
}

function ContractRiskSection({ gp, hp }: { gp: Record<string, unknown> | null; hp: HoneypotData }) {
  const hasAnyData = gp || (hp && hp.simulationSuccess)
  if (!hasAnyData) return (
    <div style={{ marginTop: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '12px', fontFamily: 'var(--font-plex-mono)',
      }}>
        Security Simulation
      </p>
      <div style={{
        padding: '14px 18px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '10px',
        fontSize: '11px', color: '#3a5268',
        fontFamily: 'var(--font-plex-mono)',
      }}>
        No security simulation data surfaced — status is unverified.
      </div>
    </div>
  )

  // Build honeypot.is pills
  const hpPills: { label: string; displayLabel: string; style: PillStyle }[] = []
  if (hp && hp.simulationSuccess) {
    hpPills.push({
      label: 'Honeypot',
      displayLabel: hp.isHoneypot ? 'YES' : 'NO',
      style: hp.isHoneypot ? pillDanger() : pillSafe(),
    })
    if (hp.buyTax !== null) hpPills.push({
      label: 'Buy Tax',
      displayLabel: `${hp.buyTax.toFixed(1)}%`,
      style: taxPct(hp.buyTax),
    })
    if (hp.sellTax !== null) hpPills.push({
      label: 'Sell Tax',
      displayLabel: `${hp.sellTax.toFixed(1)}%`,
      style: taxPct(hp.sellTax),
    })
    if (hp.transferTax !== null && hp.transferTax > 0) hpPills.push({
      label: 'Transfer Tax',
      displayLabel: `${hp.transferTax.toFixed(1)}%`,
      style: taxPct(hp.transferTax),
    })
  }

  function flagPill(key: string, label: string, dangerOn = '1'): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label, displayLabel: 'N/A', style: pillMuted() }
    const raw = gp[key]
    if (raw == null) return { label, displayLabel: 'N/A', style: pillMuted() }
    const v = String(raw)
    const isDanger = v === dangerOn
    return {
      label,
      displayLabel: v === '1' ? 'YES' : v === '0' ? 'NO' : v,
      style: isDanger ? pillDanger() : pillSafe(),
    }
  }

  function taxPill(key: string, label: string): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label, displayLabel: 'N/A', style: pillMuted() }
    const raw = gp[key]
    if (raw == null) return { label, displayLabel: 'N/A', style: pillMuted() }
    const n = parseFloat(String(raw))
    if (isNaN(n)) return { label, displayLabel: 'N/A', style: pillMuted() }
    const pct = (n * 100).toFixed(1)
    return {
      label,
      displayLabel: `${pct}%`,
      style: n > 0.1 ? (n > 0.05 ? pillDanger() : pillAmber()) : pillSafe(),
    }
  }

  function ownerPill(): { label: string; displayLabel: string; style: PillStyle } {
    if (!gp) return { label: 'Owner', displayLabel: 'N/A', style: pillMuted() }
    const addr = String(gp['owner_address'] ?? '')
    const renounced = !addr || addr === '0x0000000000000000000000000000000000000000'
    return {
      label: 'Owner',
      displayLabel: renounced ? 'RENOUNCED' : 'HELD',
      style: renounced ? pillSafe() : pillAmber(),
    }
  }

  const gpPills = gp ? [
    flagPill('is_honeypot',            'Honeypot'),
    flagPill('is_mintable',            'Mint Function'),
    flagPill('can_take_back_ownership','Ownership Revert'),
    flagPill('is_proxy',               'Proxy Contract', '__never__'),
    flagPill('is_blacklisted',         'Blacklist'),
    flagPill('is_whitelisted',         'Whitelist',      '__never__'),
    taxPill('buy_tax',  'Buy Tax'),
    taxPill('sell_tax', 'Sell Tax'),
    ownerPill(),
  ] : []
  const deduped = dedupeSecurityChips([
    ...hpPills.map(p => ({ ...p, source: 'honeypot' as const })),
    ...gpPills.map(p => ({ ...p, source: 'contract' as const })),
  ])

  return (
    <div style={{ marginTop: '28px' }}>
      <p style={{
        fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
        color: '#3a5268', textTransform: 'uppercase',
        marginBottom: '12px', fontFamily: 'var(--font-plex-mono)',
      }}>
        Security Simulation
        {hp?.simulationSuccess && <span style={{ color: '#1e3a44', marginLeft: '6px' }}>· Honeypot.is</span>}
        
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
        {deduped.map(p => (
          <RiskPill key={p.label} label={p.label} value={{ ...p.style, label: p.displayLabel }} />
        ))}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function TerminalTokenScanner() {
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ScanResult | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [lpExpanded, setLpExpanded] = useState(true)

  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkError, setClarkError]     = useState<string | null>(null)

  // Auto-scan when opened from Base Radar with ?contract= param
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params   = new URLSearchParams(window.location.search)
    const contract = params.get('contract')
    if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
      handleScan(contract)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleScan(override?: string) {
    const q = (override ?? input).trim()
    if (!q || loading) return
    setLoading(true)
    setClarkLoading(true)
    setError(null)
    setResult(null)
    setLpExpanded(true)
    setClarkVerdict(null)
    setClarkError(null)
    try {
      const debugHolder = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('debugHolder') === 'true'
      const res  = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract: q, ...(debugHolder ? { debugHolder: true } : {}) }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        if (json?.status === 'ambiguous') setError('Multiple Base tokens match this. Paste the contract address or choose one.')
        else setError("Couldn’t resolve that Base token. Paste the contract address or try a verified symbol.")
        setClarkLoading(false)
      } else {
        const pairs: Array<Record<string, unknown>> = Array.isArray(json.pairs) ? json.pairs : []
        const mainPool = pairs[0] ?? null
        const attr = (p: Record<string, unknown> | null) => ((p?.attributes as Record<string, unknown> | undefined) ?? {})
        const num = (v: unknown) => { const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN; return Number.isFinite(n) && n !== 0 ? n : null }
        const mapped: ScanResult = {
          name:           json.name,
          symbol:         json.symbol,
          decimals:       typeof json.decimals === 'number' ? json.decimals : (json.tokenInfo?.decimals ?? 18),
          contract:       json.contract,
          chain:          json.chain ?? 'base',
          noActivePools:  json.noActivePools ?? false,
          primaryDexName: json.primaryDexName ?? null,
          price:          mainPool ? num(attr(mainPool).base_token_price_usd) : null,
          liquidity:      mainPool ? num(attr(mainPool).reserve_in_usd) : null,
          volume24h:      mainPool ? num((attr(mainPool).volume_usd as Record<string, unknown> | undefined)?.h24) : null,
          priceChange24h: mainPool ? num((attr(mainPool).price_change_percentage as Record<string, unknown> | undefined)?.h24) : null,
          marketCap: num(json.marketCapUsd),
          marketCapUsd: num(json.marketCapUsd),
          marketCapStatus: json.marketCapStatus ?? 'unavailable',
          valuationContext: json.valuationContext ?? null,
          circulatingSupply: num(json.circulating_supply),
          fdv: num(json.fdvUsd ?? json.fdv),
          fdvUsd: num(json.fdvUsd ?? json.fdv),
          marketCapSource: json.marketCapSource ?? 'unavailable',
          fdvSource: json.fdvSource ?? 'unavailable',
          displayMarketValue: json.displayMarketValue ?? null,
          displayMarketValueLabel: json.displayMarketValueLabel ?? 'Market Cap',
          displayMarketValueConfidence: json.displayMarketValueConfidence ?? 'low',
          displayMarketValueReason: json.displayMarketValueReason ?? '',
          estimatedMarketCap: json.estimatedMarketCap ?? null,
          pools: pairs.map((p: Record<string, unknown>) => ({
            name:           (attr(p).name as string | undefined),
            address:        (attr(p).address as string | undefined),
            price:          num(attr(p).base_token_price_usd),
            liquidity:      num(attr(p).reserve_in_usd),
            volume24h:      num((attr(p).volume_usd as Record<string, unknown> | undefined)?.h24),
            priceChange24h: num((attr(p).price_change_percentage as Record<string, unknown> | undefined)?.h24),
          })),
          goplus:   json.goplus   ?? null,
          honeypot: json.honeypot ?? null,
          holderDistribution: json.holderDistribution ?? null,
          holderDistributionStatus: json.holderDistributionStatus ?? null,
          debugHolderStatus: json.debugHolderStatus ?? null,
          sections: json.sections ?? null,
          lpControl: json.lpControl ?? null,
          poolActivity: json.poolActivity ?? null,
          priceChart: json.priceChart ?? null,
          resolvedInput: json.resolvedInput ?? null,
        }
        setResult(mapped)
        if (json.aiSummary) {
          setClarkVerdict(json.aiSummary)
        } else {
          setClarkError('No AI verdict returned.')
        }
        setClarkLoading(false)
      }
    } catch {
      setError('Network error — check your connection.')
      setClarkLoading(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes clarkDot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.75); }
          40% { opacity: 1; transform: scale(1); }
        }
        .token-shell{display:grid;grid-template-columns:minmax(0,1fr);height:100%;overflow-x:hidden;color:#e2e8f0;background:radial-gradient(circle at 20% 0%, rgba(20,35,68,.45), rgba(2,6,23,1) 55%);} 
        .token-main,.mob-verdict-panel,.glass-card,.metric-grid,.holders-grid,.activity-grid,.intel-grid{min-width:0;}
        .token-main{max-width:none;}
        .glass-card{background:linear-gradient(180deg,rgba(10,18,34,.86),rgba(4,10,22,.82));border:1px solid rgba(148,163,184,.2);border-radius:14px;box-shadow:0 0 0 1px rgba(45,212,191,.06) inset,0 18px 45px rgba(2,6,23,.35);} 
        .metric-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr)) !important;gap:clamp(8px,1vw,12px) !important;}
        .activity-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;}
        @media (min-width:1536px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(360px,22vw,420px);} .token-main{max-width:1260px;margin:0 auto;}}
        @media (min-width:1280px) and (max-width:1535px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(320px,24vw,360px);} .token-main{max-width:1120px;margin:0 auto;} .mob-verdict-panel{padding:24px 16px;font-size:12px;} .activity-grid{gap:8px;}}
        @media (max-width:1279px){.token-shell{display:block;height:auto;overflow:visible;} .mob-scan-main{overflow-y:visible !important;} .token-shell .mob-verdict-panel{position:static !important;width:100% !important;max-width:100% !important;height:auto !important;min-height:0 !important;border-left:none !important;border-top:1px solid rgba(255,255,255,0.08) !important;overflow-y:visible !important;}}
        @media (max-width:1023px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;} .holders-grid,.intel-grid{grid-template-columns:1fr !important;} .activity-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;}}
        @media (max-width:768px){.token-main{padding:32px 14px 120px !important;} .token-input-row{flex-direction:column;max-width:100% !important;} .token-input-row button{width:100%;} .top-holder-head{display:none !important;} .top-holder-row{display:block !important;padding:10px 12px !important;} .top-holder-mobile-meta{display:flex !important;align-items:center;justify-content:space-between;gap:8px;} .top-holder-mobile-amt{display:block !important;margin-top:6px !important;text-align:left !important;} .pools-scroll{overflow-x:auto !important;-webkit-overflow-scrolling:touch;margin:0 -12px;padding:0 12px;}}
      `}</style>

      <div className="token-shell" style={{ color: '#e2e8f0', background: 'radial-gradient(circle at 20% 0%, rgba(20,35,68,.45), rgba(2,6,23,1) 55%)' }}>

        {/* ── Left: scrollable scan area ──────────────────────────── */}
        <div className="mob-scan-main token-main" style={{ minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '44px clamp(16px, 2.2vw, 34px) 120px', width: '100%' }}>

          {/* Header */}
          <div style={{ marginBottom: '32px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.25)',
              borderRadius: '99px', padding: '4px 12px', marginBottom: '16px',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
              color: '#a78bfa', fontFamily: 'var(--font-plex-mono)',
            }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,0.80)',
                flexShrink: 0,
              }} />
              TOKEN SCANNER
            </div>
            <h1 style={{ fontSize: '28px', fontWeight: 800, color: '#f8fafc', lineHeight: 1.2, margin: 0 }}>Token Scanner</h1><p style={{margin:'8px 0 0',color:'#94a3b8',fontSize:'13px'}}>Scan Base tokens for liquidity, contract risk, taxes, pool depth, and Clark AI verdicts.</p><p style={{margin:'6px 0 0',color:'#64748b',fontSize:'11px',fontFamily:'var(--font-plex-mono)'}}>Full scan access.</p>
          </div>

          {/* Input row */}
          <div className="token-input-row glass-card" style={{ display: 'flex', gap: '10px', maxWidth: '820px', marginBottom: '24px', padding: '10px' }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
              disabled={loading}
              placeholder="Paste Base contract, symbol, or token name"
              style={{
                flex: 1, padding: '12px 16px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: '10px',
                color: '#e2e8f0', fontSize: '14px',
                fontFamily: 'var(--font-plex-mono)',
                outline: 'none',
                opacity: loading ? 0.6 : 1,
                transition: 'border-color 0.15s',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)' }}
              onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)' }}
            />
            <button
              onClick={() => handleScan()}
              disabled={loading || !input.trim()}
              style={{
                padding: '12px 28px', borderRadius: '10px', border: 'none',
                background: loading || !input.trim()
                  ? 'rgba(45,212,191,0.12)'
                  : 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 100%)',
                color: loading || !input.trim() ? 'rgba(255,255,255,0.25)' : '#06060a',
                fontSize: '12px', fontWeight: 700,
                fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em',
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                flexShrink: 0, transition: 'all 0.15s',
              }}
            >
              {loading ? 'SCANNING…' : 'SCAN TOKEN'}
            </button>
          </div>

          {/* Error */}
          {error && (
            <div style={{
              maxWidth: '680px', padding: '13px 18px',
              background: 'rgba(248,113,113,0.07)',
              border: '1px solid rgba(248,113,113,0.22)',
              borderRadius: '10px', color: '#fca5a5',
              fontSize: '13px', fontFamily: 'var(--font-plex-mono)',
              marginBottom: '24px',
            }}>
              {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !result && !error && (
            <div style={{ maxWidth: '680px', padding: '48px 0', textAlign: 'center' }}>
              <p style={{
                fontFamily: 'var(--font-plex-mono)', fontSize: '12px',
                letterSpacing: '0.08em', color: '#1e2e38',
              }}>
                no token scanned yet
              </p>
            </div>
          )}

          {/* Results */}
          {result && (
            <div style={{ maxWidth: 'none', width: '100%' }}>

              {/* Token identity */}
              <div style={{ marginBottom: '24px' }}>
                <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', margin: '0 0 4px' }}>
                  {result.name ?? 'Unknown'}
                  {result.symbol && (
                    <span style={{
                      marginLeft: '10px', fontSize: '14px',
                      color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
                    }}>
                      {result.symbol}
                    </span>
                  )}
                </h2>
                {result.contract && (
                  <p style={{
                    fontSize: '11px', color: '#3a5268',
                    fontFamily: 'var(--font-plex-mono)', margin: 0,
                  }}>
                    {shorten(result.contract)}
                    {` · ${String(result.chain ?? 'Base').toUpperCase()}`}
                    <span style={{marginLeft:'8px',padding:'2px 8px',border:'1px solid rgba(59,130,246,.35)',borderRadius:'999px',color:'#93c5fd'}}>BASE</span>
                  </p>
                )}
                {result.resolvedInput && result.resolvedInput.type !== 'address' && (
                  <p style={{ margin: '6px 0 0', color: '#94a3b8', fontSize: '11px' }}>
                    Resolved from {result.resolvedInput.original.toUpperCase()}.
                  </p>
                )}
              </div>

              {/* Stat cards — or no-pools message */}
              {result.noActivePools ? (
                <div style={{
                  padding: '14px 18px', marginBottom: '28px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '10px',
                  fontSize: '12px', color: '#3a5268',
                  fontFamily: 'var(--font-plex-mono)',
                }}>
                  No active Base pools found for this contract.
                </div>
              ) : (
                <div className="metric-grid" style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: '10px', marginBottom: '28px',
                }}>
                  <StatCard label="Price"      value={fmtPrice(result.price)}         accent="#2DD4BF" />
                  <StatCard label="Liquidity"  value={fmtLarge(result.liquidity)} />
                  <StatCard label="Volume 24h" value={fmtLarge(result.volume24h)} />
                  <StatCard
                    label="24h Change"
                    value={fmtPct(result.priceChange24h)}
                    accent={pctColor(result.priceChange24h)}
                  />
                  {(() => {
                    const valuation = result.valuationContext
                    const showFdvContext = valuation?.primaryValuationStatus === 'fdv_only' && valuation?.primaryValuationUsd != null
                    const mcValue = valuation?.primaryValuationStatus === 'verified_mc'
                      ? fmtLarge(valuation.primaryValuationUsd)
                      : showFdvContext ? `FDV ${fmtLarge(valuation.primaryValuationUsd)}` : 'Supply not confirmed'
                    const mcHelper = valuation?.primaryValuationStatus === 'verified_mc'
                      ? 'Verified live market data'
                      : showFdvContext ? 'Market cap not verified live' : 'Live valuation not verified'
                    return (
                      <StatCard
                        label={valuation?.primaryValuationStatus === 'fdv_only' ? 'Valuation' : 'Market Cap'}
                        value={mcValue}
                        helper={mcHelper}
                        accent="#a78bfa"
                      />
                    )
                  })()}
                  <StatCard
                    label='FDV'
                    value={result.fdvUsd != null ? fmtLarge(result.fdvUsd) : 'Unverified'}
                    helper='Fully Diluted Valuation'
                    accent="#a78bfa"
                  />
                  <StatCard
                    label='Pool Protocol'
                    value={result.primaryDexName ?? 'Protocol not confirmed'}
                    helper={result.primaryDexName ? 'Primary liquidity pool' : 'Pool found · protocol metadata missing'}
                    accent={result.primaryDexName ? '#67e8f9' : '#64748b'}
                  />
                </div>
              )}
              {result.marketCapStatus !== 'verified' && (
                <p style={{ marginTop: '-14px', marginBottom: '20px', color: '#94a3b8', fontSize: '12px' }}>
                  FDV is available, but circulating supply was not verified live.
                </p>
              )}

              {/* Pool Activity */}
              {!result.noActivePools && (
                <div className="glass-card" style={{ marginBottom: '22px', borderRadius: '16px', padding: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline', marginBottom: '8px' }}>
                    <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', color: '#cbd5e1', textTransform: 'uppercase' }}>Price Chart</p>
                    <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>{result.priceChart?.fallbackUsed ? 'Live pool price action' : 'Primary pool price action'}</p>
                  </div>
                  {result.priceChart?.sourceStatus === 'ok' && result.priceChart.points.length >= 2 ? (
                    <>
                      <div style={{ display: 'inline-flex', marginBottom: '8px', border: '1px solid rgba(148,163,184,.3)', borderRadius: '999px', padding: '2px 8px', fontSize: '10px', color: '#cbd5e1' }}>
                        {result.priceChart.timeframe === '24h' ? '24H' : result.priceChart.timeframe === '48h' ? '48H' : '7D'}
                      </div>
                      <MiniPriceChart points={result.priceChart.points} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8', marginTop: '6px' }}>
                        <span>{new Date(result.priceChart.points[0].timestamp).toLocaleTimeString()}</span>
                        <span>Latest {fmtPrice(result.priceChart.points[result.priceChart.points.length - 1].priceUsd)}</span>
                      </div>
                    </>
                  ) : (
                    <StatCard label="Chart not available" value="Chart not available" helper="Live pool price history was not exposed for this token. Pool data and current price are still live." />
                  )}
                </div>
              )}
              {!result.noActivePools && (
                <div style={{ marginBottom: '28px' }}>
                  <p style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                    color: '#3a5268', textTransform: 'uppercase',
                    marginBottom: '10px', fontFamily: 'var(--font-plex-mono)',
                  }}>
                    Pool Activity
                  </p>
                  <div className="activity-grid">
                    <StatCard
                      label="Transactions 24H"
                      value={result.poolActivity?.transactions24h != null
                        ? result.poolActivity.transactions24h.toLocaleString()
                        : 'Activity unavailable'}
                      helper="Primary pool activity"
                    />
                    <StatCard
                      label="Buys / Sells"
                      value={result.poolActivity?.buys24h != null && result.poolActivity?.sells24h != null
                        ? `${result.poolActivity.buys24h.toLocaleString()} / ${result.poolActivity.sells24h.toLocaleString()}`
                        : 'Buy/sell split unavailable'}
                      helper="24h pool flow"
                    />
                    <StatCard
                      label="Buy / Sell Vol"
                      value={result.poolActivity?.buyVolume24hUsd != null && result.poolActivity?.sellVolume24hUsd != null
                        ? `${fmtLarge(result.poolActivity.buyVolume24hUsd)} / ${fmtLarge(result.poolActivity.sellVolume24hUsd)}`
                        : result.poolActivity?.volume24hUsd != null ? `Total ${fmtLarge(result.poolActivity.volume24hUsd)}` : 'Volume unavailable'}
                      helper={result.poolActivity?.buyVolume24hUsd != null && result.poolActivity?.sellVolume24hUsd != null
                        ? '24h buy/sell volume'
                        : result.poolActivity?.volume24hUsd != null ? 'Buy/sell volume split not exposed' : '24h volume not exposed'}
                    />
                    <StatCard
                      label="Pair Age"
                      value={result.poolActivity?.pairAgeLabel ?? 'Pool age unavailable'}
                      helper={result.poolActivity?.pairAgeLabel != null ? 'Primary pool created' : 'Creation time not exposed'}
                    />
                  </div>
                </div>
              )}

              {result.sections && (
                <div style={{ marginBottom: '20px', fontSize: '12px', color: '#94a3b8' }}>
                  {[result.sections.market, result.sections.security, result.sections.holders, result.sections.liquidity, result.sections.contractChecks]
                    .filter((s): s is { status?: string; reason?: string; source?: string } => Boolean(s && s.status && s.status !== 'ok'))
                    .map((s, i) => (
                      <div key={i}>- {humanizeSectionLine(s.source, s.status, s.reason)}</div>
                    ))}
                </div>
              )}
              {result.lpControl && (() => {
                const lp = result.lpControl
                const read = result.lpControlRead
                const statusColor: Record<string, string> = {
                  burned: '#34d399', locked: '#34d399', team_controlled: '#f87171',
                  unsupported: '#fbbf24', unverified: '#94a3b8', error: '#f87171',
                }
                const color = statusColor[lp.status ?? 'unverified'] ?? '#94a3b8'
                const statusLabelMap: Record<string, string> = {
                  burned: 'Burned',
                  locked: 'Locked',
                  team_controlled: 'Team controlled',
                  unsupported: 'Protocol liquidity',
                  unverified: 'Unverified',
                  error: 'Unverified',
                }
                const evidence = Array.isArray(lp.evidence) ? lp.evidence : []
                const verificationPool = evidenceValue(evidence, 'Verification pool') ?? read?.whatWasFound?.find((x) => /^Pair:/i.test(x))?.replace(/^Pair:\s*/i, '') ?? 'Unverified'
                const evidenceText = evidence.join(' ').toLowerCase()
                const fallbackChecked: string[] = []
                if (lp.poolAddressPresent || evidenceText.includes('verification pool')) fallbackChecked.push('Pool address found')
                if (verificationPool !== 'Unverified') fallbackChecked.push('Major quote verification pool selected')
                if (evidenceText.includes('alchemy') || evidenceText.includes('rpc') || evidenceText.includes('probe')) fallbackChecked.push('On-chain verification checks attempted')
                if (lp.status !== 'error' && lp.status !== 'unverified' ? true : lp.poolAddressPresent) fallbackChecked.push('Liquidity pool found')
                const checked = ((read?.whatWasFound ?? []).filter((x) => !/^Pair:/i.test(x)).length
                  ? (read?.whatWasFound ?? []).filter((x) => !/^Pair:/i.test(x))
                  : fallbackChecked).filter((v, i, arr) => arr.indexOf(v) === i)
                const unresolved = (read?.couldNotVerify?.length ? read.couldNotVerify : [
                  'LP lock or burn proof',
                  'LP holder distribution',
                  lp.status === 'unsupported' ? 'Protocol-specific LP proof' : 'Standard LP interface',
                ])
                const riskRead = read?.meaning ?? (
                  lp.status === 'unsupported'
                    ? 'Protocol liquidity detected — requires protocol-specific verification.'
                    : lp.poolAddressPresent
                      ? 'Liquidity exists, but LP lock/control could not be proven from current checks.'
                      : 'No active liquidity pool found.'
                )
                const nextAction = read?.nextAction ?? 'Treat LP control as unverified until locker, burn-address, or protocol-specific proof is found.'
                return (
                  <div style={{ marginBottom: '18px', border: '1px solid rgba(148,163,184,0.2)', borderRadius: '12px', overflow: 'hidden', fontSize: '12px', background: 'linear-gradient(180deg, rgba(15,23,42,0.72), rgba(2,6,23,0.62))', backdropFilter: 'blur(5px)' }}>
                    <button type="button" onClick={() => setLpExpanded((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '11px 14px', background: 'rgba(255,255,255,0.03)', border: 'none', borderBottom: lpExpanded ? '1px solid rgba(255,255,255,0.06)' : 'none', cursor: 'pointer', textAlign: 'left' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 6px ${color}` }} />
                      <span style={{ fontWeight: 700, color: '#f8fafc', fontSize: '12px' }}>LP Control: {statusLabelMap[lp.status ?? 'unverified'] ?? 'Unverified'}</span>
                      {read?.riskLevel && <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#94a3b8', letterSpacing: '0.05em' }}>{read.riskLevel}</span>}
                      <span style={{ fontSize: '10px', color: '#cbd5e1', letterSpacing: '0.06em' }}>Details {lpExpanded ? '▾' : '▸'}</span>
                    </button>
                    {lpExpanded && <div style={{ transition: 'all 160ms ease' }}>
                      <div style={{ padding: '9px 14px', color: '#dbeafe', lineHeight: 1.55 }}><span style={{ color: '#f8fafc', fontWeight: 600 }}>Risk read:</span> {riskRead}</div>
                      <div style={{ padding: '0 14px 8px' }}>
                        <div style={{ fontSize: '10px', color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Verification pool</div>
                        <div style={{ marginTop: '3px', color: '#f8fafc', fontWeight: 600 }}>{verificationPool}</div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '8px', padding: '6px 12px 8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ padding: '8px 10px', border: '1px solid rgba(52,211,153,0.16)', borderRadius: '10px', background: 'rgba(15,23,42,0.36)' }}>
                        <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '0.08em', marginBottom: '4px', textTransform: 'uppercase' }}>What was checked</div>
                        {checked.map((f, i) => <div key={i} style={{ color: '#e2e8f0', display: 'flex', gap: '6px' }}><span style={{ color: '#34d399' }}>✓</span>{f}</div>)}
                      </div>
                      <div style={{ padding: '8px 10px', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '10px', background: 'rgba(15,23,42,0.36)' }}>
                        <div style={{ fontSize: '10px', color: '#64748b', letterSpacing: '0.08em', marginBottom: '4px', textTransform: 'uppercase' }}>Could not verify</div>
                        {unresolved.map((f, i) => <div key={i} style={{ color: '#f8fafc', display: 'flex', gap: '6px' }}><span style={{ color: '#f59e0b' }}>✕</span>{f}</div>)}
                      </div>
                      </div>
                      <div style={{ padding: '8px 14px 12px', borderTop: '1px solid rgba(255,255,255,0.05)', color: '#cbd5e1' }}><span style={{ color: '#94a3b8' }}>Next action:</span> {nextAction}</div>
                    </div>}
                  </div>
                )
              })()}

              {/* Security Simulation */}
              <ContractRiskSection
                gp={result.goplus && result.contract
                  ? (result.goplus[result.contract.toLowerCase()] ?? null)
                  : null}
                hp={result.honeypot ?? null}
              />


              {/* Holder debug card — only rendered when API returns debugHolderStatus */}
              {result.debugHolderStatus && (() => {
                const d = result.debugHolderStatus!
                const rows: [string, string][] = [
                  ['providerCalled',  String(d.providerCalled ?? '?')],
                  ['chain',           d.chain ?? '?'],
                  ['endpointPath',    d.endpointPath ?? '?'],
                  ['authMode',        d.authMode ?? '?'],
                  ['hasGoldrushKey',  String(d.hasGoldrushKey ?? '?')],
                  ['hasCovalentKey',  String(d.hasCovalentKey ?? '?')],
                  ['statusCode',      d.statusCode != null ? String(d.statusCode) : '—'],
                  ['itemCount',       d.itemCount != null ? String(d.itemCount) : '—'],
                  ['normalizedCount', d.normalizedCount != null ? String(d.normalizedCount) : '—'],
                  ['reason',          d.reason ?? '—'],
                  ['responseKeys',    d.responseKeys?.join(', ') ?? '—'],
                  ['dataKeys',        d.dataKeys?.join(', ') ?? '—'],
                  ['firstItemKeys',   d.firstItemKeys?.join(', ') ?? '—'],
                ]
                return (
                  <details style={{
                    marginTop: '16px', marginBottom: '4px',
                    background: 'rgba(251,191,36,0.04)',
                    border: '1px solid rgba(251,191,36,0.18)',
                    borderRadius: '8px', padding: '8px 12px',
                    fontSize: '10px', fontFamily: 'var(--font-plex-mono)',
                  }}>
                    <summary style={{ cursor: 'pointer', color: '#fbbf24', letterSpacing: '0.10em', fontWeight: 700 }}>
                      Holder Debug · HTTP {d.statusCode ?? '?'} · items:{d.itemCount ?? '?'} norm:{d.normalizedCount ?? '?'}
                    </summary>
                    <table style={{ marginTop: '8px', borderCollapse: 'collapse', width: '100%' }}>
                      <tbody>
                        {rows.map(([k, v]) => (
                          <tr key={k}>
                            <td style={{ paddingRight: '12px', color: '#78716c', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
                            <td style={{ color: '#d97706', wordBreak: 'break-all' }}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )
              })()}

              {/* Holder analytics */}
              {(() => {
                const holderState = deriveHolderState(result)
                const fallback = deriveHolderFallbackEvidence(result)
                if (holderState.kind !== 'noRowsFallback') {
                  return (
                    <div className="holders-grid" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px',marginTop:'24px',marginBottom:'20px'}}>
                      <div className="glass-card" style={{padding:'18px'}}>
                        <p style={{fontSize:'12px',fontWeight:800,letterSpacing:'0.12em',color:'#8fb3d0',marginBottom:'12px',fontFamily:'var(--font-plex-mono)'}}>HOLDER CONCENTRATION</p>
                        {result.holderDistribution?.holderCount != null && <div style={{margin:'0 0 12px',fontSize:'13px',color:'#67e8f9',border:'1px solid rgba(45,212,191,.3)',background:'rgba(6,78,59,.16)',padding:'8px 10px',borderRadius:'10px',display:'inline-flex',gap:'8px'}}><span style={{color:'#99f6e4'}}>Holder count</span><strong style={{fontFamily:'var(--font-plex-mono)',color:'#e6fffa'}}>{result.holderDistribution.holderCount.toLocaleString()}</strong></div>}
                        {holderState.kind === 'rowsWithoutPercent' && (
                          <p style={{margin:'0 0 10px',fontSize:'11px',color:'#fbbf24'}}>Top holder wallets found, but supply percentages were not available for this scan.</p>
                        )}
                        <div style={{display:'grid',gap:'10px'}}>{[['Top 1',result.holderDistribution?.top1],['Top 5',result.holderDistribution?.top5],['Top 10',result.holderDistribution?.top10],['Top 20',result.holderDistribution?.top20]].map(([l,v]) => <div key={String(l)} style={{display:'grid',gridTemplateColumns:'82px 1fr 64px',alignItems:'center',gap:'10px'}}><span style={{fontSize:'12px',color:'#d6e6f3',fontWeight:700}}>{l}</span><div style={{height:'12px',borderRadius:'999px',background:'linear-gradient(90deg,rgba(30,41,59,.9),rgba(51,65,85,.5))',border:'1px solid rgba(148,163,184,.25)'}}><div style={{height:'100%',width:`${v == null ? 0 : Math.max(0,Math.min(100,Number(v)))}%`,borderRadius:'999px',background:'linear-gradient(90deg,#2dd4bf,#a855f7)',boxShadow:'0 0 14px rgba(45,212,191,.28)'}} /></div><span style={{fontSize:'13px',fontWeight:800,color:'#eef6ff',textAlign:'right',fontFamily:'var(--font-plex-mono)'}}>{v == null ? 'N/A' : `${Number(v).toFixed(1)}%`}</span></div>)}</div>
                        <p style={{margin:'12px 0 0',fontSize:'11px',color:'#8aa3b8'}}>{holderState.kind === 'rowsWithPercent' ? 'Top holder concentration from live holder data' : 'Holder distribution based on available live holder rows'}</p>
                      </div>
                      <div className="glass-card" style={{padding:'18px',minWidth:0,overflow:'hidden'}}>
                        <p style={{fontSize:'12px',fontWeight:800,letterSpacing:'0.12em',color:'#8fb3d0',marginBottom:'4px',fontFamily:'var(--font-plex-mono)'}}>TOP HOLDERS</p>
                        <p style={{margin:'0 0 10px',fontSize:'11px',color:'#8aa3b8'}}>Top 10 holders</p>
                        {/* Header */}
                        <div className="top-holder-head" style={{display:'grid',gridTemplateColumns:'36px minmax(0,1fr) 88px 62px',gap:'10px',fontSize:'10px',letterSpacing:'0.10em',color:'#6a8198',marginBottom:'8px',fontFamily:'var(--font-plex-mono)'}}>
                          <span>#</span><span>WALLET</span><span style={{textAlign:'right'}}>AMOUNT</span><span style={{textAlign:'right'}}>%</span>
                        </div>
                        {/* Rows */}
                        <div style={{display:'flex',flexDirection:'column',gap:'8px',maxHeight:'320px',overflowY:'auto',paddingRight:'3px'}}>
                          {holderState.rows.slice(0,20).map((h) => (
                            <div className="top-holder-row" key={h.rank+h.address} style={{display:'grid',gridTemplateColumns:'36px minmax(0,1fr) 88px 62px',gap:'10px',alignItems:'center',padding:'10px 10px',border:'1px solid rgba(148,163,184,.18)',borderRadius:'10px',background:'rgba(15,23,42,.45)',transition:'all .16s'}}>
                              <span style={{fontSize:'11px',color:'#dbeafe',fontFamily:'var(--font-plex-mono)',fontWeight:700,display:'inline-flex',justifyContent:'center',padding:'2px 0',borderRadius:'999px',background:h.rank<=3?'linear-gradient(90deg,rgba(45,212,191,.28),rgba(168,85,247,.28))':'transparent',border:h.rank<=3?'1px solid rgba(167,139,250,.45)':'none'}}>{h.rank}</span>
                              <span className="top-holder-mobile-meta" style={{fontSize:'12px',color:'#c5d8ea',fontFamily:'var(--font-plex-mono)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{shorten(h.address)}<span style={{display:'none',fontSize:'12px',fontWeight:800,color: h.percent != null && h.percent >= 10 ? '#fb7185' : h.percent != null && h.percent >= 5 ? '#fbbf24' : '#67e8f9'}}>{h.percent == null ? '—' : `${h.percent.toFixed(2)}%`}</span></span>
                              <span className="top-holder-mobile-amt" style={{fontSize:'12px',color:'#e5eef9',textAlign:'right',fontFamily:'var(--font-plex-mono)'}}>{fmtTokenAmt(h.amount, result.decimals ?? 18)}</span>
                              <span style={{fontSize:'12px',fontWeight:800,textAlign:'right',fontFamily:'var(--font-plex-mono)',color: h.percent != null && h.percent >= 10 ? '#fb7185' : h.percent != null && h.percent >= 5 ? '#fbbf24' : '#67e8f9'}}>{h.percent == null ? '—' : `${h.percent.toFixed(2)}%`}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                }
                return (
                  <div style={{marginTop:'24px',marginBottom:'20px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(148,163,184,.2)',borderRadius:'12px',padding:'16px'}}>
                    <p style={{fontSize:'10px',fontWeight:700,letterSpacing:'0.14em',color:'#3a5268',marginBottom:'8px',fontFamily:'var(--font-plex-mono)'}}>Holder Intelligence</p>
                    <p style={{margin:'0 0 8px',fontSize:'12px',color:'#cbd5e1',fontWeight:700}}>State: {holderSafeReason(normalizeHolderProviderStatus(result.holderDistributionStatus), false)}</p>
                    <div className="intel-grid" style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:'8px',marginBottom:'10px'}}>
                      {[
                        ['Owner status', fallback.ownerStatus],
                        ['Pool count', String(fallback.poolCount)],
                        ['Liquidity depth', fmtLarge(fallback.liquidityDepth)],
                        ['Market cap vs FDV', fallback.marketCapToFdvLabel],
                        ['Holder concentration', fallback.holderConcentration],
                        ['Supply spread', fallback.supplySpread],
                      ].map(([label,val]) => (
                        <div key={String(label)} style={{padding:'8px 10px',borderRadius:'10px',background:'rgba(15,23,42,0.42)',border:'1px solid rgba(148,163,184,.18)'}}>
                          <div style={{fontSize:'9px',color:'#64748b',fontFamily:'var(--font-plex-mono)'}}>{label}</div>
                          <div style={{fontSize:'11px',color:'#cbd5e1',marginTop:'4px'}}>{val}</div>
                        </div>
                      ))}
                    </div>
                    <p style={{margin:0,fontSize:'11px',color:'#94a3b8'}}>Holder data was unavailable for this token. This usually happens on new, thin, or low-coverage microcaps, so concentration should be treated as unverified.</p>
                  </div>
                )
              })()}

              {/* Pools */}
              {result.pools && result.pools.length > 0 && (
                <>
                  <p style={{
                    fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em',
                    color: '#3a5268', textTransform: 'uppercase',
                    marginBottom: '10px', fontFamily: 'var(--font-plex-mono)',
                  }}>
                    LIQUIDITY & POOLS
                  </p><div style={{display:'inline-flex',marginBottom:'10px',padding:'3px 9px',borderRadius:'999px',border:'1px solid rgba(125,211,252,.3)',color:'#67e8f9',fontSize:'10px',fontFamily:'var(--font-plex-mono)'}}>{result.pools.length} POOLS</div>
                  <div className="pools-scroll" style={{ overflowX: 'auto', paddingBottom: '6px', maxWidth: '100%' }}><div className="pools-inner" style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '940px' }}>
                    {[...result.pools].sort((a,b)=>(b.liquidity??0)-(a.liquidity??0)).slice(0,8).map((pool, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(220px,1.2fr) repeat(6, minmax(82px, auto))',
                          alignItems: 'center', gap: '20px',
                          padding: '12px 18px',
                          background: 'rgba(255,255,255,0.025)',
                          border: '1px solid rgba(255,255,255,0.06)',
                          borderRadius: '10px',
                          fontSize: '12px', fontFamily: 'var(--font-plex-mono)',
                        }}
                      >
                        <span style={{
                          color: '#94a3b8', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {pool.name ?? shorten(pool.address ?? '')}
                        </span>
                        <span style={{ color: '#2DD4BF', whiteSpace: 'nowrap' }}>
                          {fmtPrice(pool.price)}
                        </span>
                        <span style={{ color: '#4a6272', whiteSpace: 'nowrap' }}>
                          Liq {fmtLarge(pool.liquidity)}
                        </span>
                        <span style={{ color: '#4a6272', whiteSpace: 'nowrap' }}>
                          Vol {fmtLarge(pool.volume24h)}
                        </span>
                        <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>APR N/A</span><span style={{ color: pctColor(pool.priceChange24h), whiteSpace: 'nowrap' }}>{fmtPct(pool.priceChange24h)}</span><span style={{whiteSpace:'nowrap',color:(pool.liquidity??0)>200000?'#34d399':(pool.liquidity??0)>50000?'#67e8f9':'#fbbf24'}}>{(pool.liquidity??0)>200000?'Excellent':(pool.liquidity??0)>50000?'Healthy':'Weak'}</span>
                      </div>
                    ))}
                  </div></div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Right: Clark verdict panel (288px) ─────────────────── */}
        <aside className="mob-verdict-panel" style={{
          width: 'clamp(320px, 24vw, 400px)',
          minWidth: 0,
          flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          background: 'linear-gradient(180deg, rgba(6,10,20,.96), rgba(4,8,18,.96))',
          overflowY: 'auto',
          padding: '28px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}>
          {/* Label */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: clarkLoading ? '#2DD4BF' : clarkVerdict ? '#2DD4BF' : '#1e3a44',
              boxShadow: (clarkLoading || clarkVerdict) ? '0 0 8px rgba(45,212,191,0.8)' : 'none',
              flexShrink: 0,
              transition: 'all 0.3s',
            }} />
            <p style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
              color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
              textTransform: 'uppercase', margin: 0,
            }}>
              Clark AI Verdict
            </p>
          </div>

          {/* Idle */}
          {!clarkLoading && !clarkVerdict && !clarkError && (
            <p style={{
              fontSize: '11px', color: '#1e3a44',
              fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6,
            }}>
              Scan a Base token to generate a structured Clark verdict.
            </p>
          )}

          {/* Loading dots */}
          {clarkLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 0' }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{
                  width: '5px', height: '5px', borderRadius: '50%',
                  background: '#2DD4BF', display: 'inline-block',
                  animation: `clarkDot 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          )}

          {/* Error */}
          {clarkError && (
            <p style={{
              fontSize: '12px', color: '#fca5a5',
              fontFamily: 'var(--font-plex-mono)', margin: 0, lineHeight: 1.6,
            }}>
              {clarkError}
            </p>
          )}

          {/* Verdict */}
          {result && (() => {
            const d = deriveVerdictInput(result)
            const hp = result.honeypot
            const buyTax = hp?.buyTax ?? null
            const sellTax = hp?.sellTax ?? null
            const transferTax = hp?.transferTax ?? null
            const liq = result.liquidity ?? 0
            const poolCount = result.pools?.length ?? 0
            const holderRows = result.holderDistribution?.topHolders ?? []
            const top10 = result.holderDistribution?.top10
            const top20 = result.holderDistribution?.top20
            const mcFdv = d.fallbackEvidence.marketCapToFdvLabel
            const taxesHigh = (buyTax != null && buyTax > 8) || (sellTax != null && sellTax > 8)
            const hpBlocked = hp?.isHoneypot === true
            const verdict =
              hpBlocked || taxesHigh ? 'AVOID' :
              !d.hasMarketData && !d.hasSecurityData && !d.hasLiquidityData ? 'UNVERIFIED' :
              d.hasSecurityData && hp?.isHoneypot === false && liq > 120000 && d.holderState.kind === 'rowsWithPercent' ? 'CLEAN-LOOKING' :
              d.holderState.kind === 'noRowsFallback' || liq < 40000 ? 'WATCH' : 'CAUTION'
            const verdictColor = verdict === 'AVOID' ? '#f87171' : verdict === 'CLEAN-LOOKING' ? '#2DD4BF' : verdict === 'WATCH' ? '#fbbf24' : verdict === 'CAUTION' ? '#f59e0b' : '#94a3b8'
            const bull = [
              liq > 0 ? 'Liquidity exists.' : '',
              d.hasMarketData ? 'Market data is available.' : '',
              hp?.isHoneypot === false ? 'Honeypot simulation did not flag blocked sells.' : '',
              poolCount > 1 ? 'Multiple pools found.' : '',
              holderRows.length > 0 ? 'Holder rows were returned.' : '',
            ].filter(Boolean).slice(0, 3)
            const bear = [
              d.holderState.kind === 'noRowsFallback' ? 'Holder data unavailable.' : '',
              taxesHigh ? 'Taxes are elevated.' : '',
              liq > 0 && liq < 50000 ? 'Liquidity is thin.' : '',
              result.marketCapUsd == null ? 'Market cap unavailable.' : '',
              result.marketCapUsd == null && result.fdvUsd != null ? 'FDV-only context.' : '',
              hp?.simulationSuccess === false ? 'Honeypot/sell simulation unverified.' : '',
            ].filter(Boolean).slice(0, 3)
            const missingChecks = [
              d.holderState.kind !== 'rowsWithPercent' ? 'Holder concentration' : '',
              'Supply spread',
              'LP lock',
              d.fallbackEvidence.ownerStatus === 'Unverified' ? 'Owner status' : '',
              result.marketCapUsd == null ? 'Market cap' : '',
              'Contract verification',
            ].filter(Boolean)
            return (
              <div style={{display:'grid',gap:'10px'}}>
                <div style={{padding:'12px',border:'1px solid rgba(125,211,252,.2)',borderRadius:'12px',background:'rgba(10,20,32,.6)'}}>
                  <div style={{fontSize:'10px',letterSpacing:'.13em',color:'#94a3b8'}}>VERDICT</div>
                  <div style={{fontSize:'24px',fontWeight:800,color:verdictColor}}>{verdict}</div>
                </div>
                <div style={{padding:'12px',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'12px',fontSize:'12px',lineHeight:1.6,color:'#b7c9da',background:'rgba(15,23,42,.5)'}}>Market Read: <strong style={{color:'#e2e8f0'}}>Price {fmtPrice(result.price)}</strong>, 24H {fmtPct(result.priceChange24h)}, Volume {fmtLarge(result.volume24h)}, Liquidity {fmtLarge(result.liquidity)}, MC {result.marketCapUsd != null ? fmtLarge(result.marketCapUsd) : 'Not verified live'}, FDV {result.fdvUsd != null ? fmtLarge(result.fdvUsd) : 'Not verified live'}, {result.marketCapUsd == null && result.fdvUsd != null ? 'Market cap was not verified live; FDV is the safer valuation context.' : `MC/FDV ${mcFdv}`}</div>
                <div style={{padding:'10px',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'10px',fontSize:'11px',color:'#94a3b8'}}>Security Read: Honeypot {hp?.isHoneypot === false ? 'No' : hp?.isHoneypot === true ? 'Flagged' : 'Unverified'}, Buy Tax {buyTax != null ? `${buyTax.toFixed(1)}%` : 'N/A'}, Sell Tax {sellTax != null ? `${sellTax.toFixed(1)}%` : 'N/A'}, Transfer Risk {transferTax != null ? `${transferTax.toFixed(1)}%` : 'N/A'}, Simulation {hp?.simulationSuccess ? 'Verified' : 'Unverified'}</div>
                <div style={{padding:'10px',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'10px',fontSize:'11px',color:'#94a3b8'}}>Holder/Supply Read: {result.holderDistribution?.holderCount != null ? `holders ${result.holderDistribution.holderCount.toLocaleString()}, ` : ''}{top10 != null ? `top10 ${top10.toFixed(1)}%, ` : 'holder concentration unverified, '}{top20 != null ? `top20 ${top20.toFixed(1)}%` : 'top20 unavailable'}</div>
                <div style={{padding:'10px',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'10px',fontSize:'11px',color:'#94a3b8'}}>Liquidity/Pools Read: pools {poolCount}, primary pool {result.pools?.[0]?.name ?? 'Unverified'}, liquidity depth {fmtLarge(result.pools?.[0]?.liquidity ?? result.liquidity)}, {(liq > 0 && liq < 50000) ? 'liquidity thin.' : liq === 0 ? 'liquidity unverified.' : 'liquidity present.'}</div>
                <div style={{padding:'10px',border:'1px solid rgba(45,212,191,.2)',borderRadius:'10px',fontSize:'11px',color:'#99f6e4'}}>Bull Case: {bull.length ? bull.join(' ') : 'No strong positive cluster yet.'}</div>
                <div style={{padding:'10px',border:'1px solid rgba(248,113,113,.2)',borderRadius:'10px',fontSize:'11px',color:'#fca5a5'}}>Bear Case: {bear.length ? bear.join(' ') : 'No major bear signal surfaced yet.'}</div>
                <div style={{padding:'10px',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'10px',fontSize:'11px',color:'#94a3b8'}}>Missing Checks: {missingChecks.join(', ')}</div>
                <div style={{padding:'11px 12px',border:'1px solid rgba(45,212,191,.35)',borderRadius:'10px',background:'rgba(45,212,191,.07)',fontSize:'11px',color:'#67e8f9'}}>Next Action: Monitor liquidity and holder rows before trusting this. Check fresh scans after volume/liquidity changes. Do not treat this as copy-trade advice.</div>
              </div>
            )
          })()}
          <div style={{marginTop:'auto',paddingTop:'8px',borderTop:'1px solid rgba(148,163,184,.12)',fontSize:'10px',color:'#64748b',lineHeight:1.5,fontFamily:'var(--font-plex-mono)'}}>RPC: hidden<br/>We never render RPC URLs or API keys in the interface. Debug via server logs only.</div>
        </aside>

      </div>
    </>
  )
}

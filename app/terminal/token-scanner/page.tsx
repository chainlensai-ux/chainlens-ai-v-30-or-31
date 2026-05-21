'use client'

import { useState, useEffect } from 'react'
import { usePlanWithLoading, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

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
  contractSecurity?: Record<string, Record<string, unknown>> | null
  honeypot?: {
    isHoneypot: boolean | null
    buyTax: number | null
    sellTax: number | null
    transferTax: number | null
    simulationSuccess: boolean
  } | null
  noActivePools?: boolean
  primaryDexName?: string | null
  marketDataSource?: 'primary' | 'fallback' | 'none'
  marketConfidence?: 'high' | 'medium' | 'low'
  decimals?: number
  holderDistribution?: { top1:number|null; top5:number|null; top10:number|null; top20:number|null; others:number|null; holderCount:number|null; topHolders:Array<{rank:number;address:string;amount:string|number|null;percent:number|null}> } | null
  holderDistributionStatus?: { source?: string; status?: 'ok'|'partial'|'empty'|'unavailable'|'error'; reason?: string; itemCount?: number; normalizedCount?: number } | null
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
  chartStatus?: 'ok' | 'no_candles' | 'fallback_snapshot_only' | 'unavailable' | null
  chartDataSource?: 'primary' | 'fallback' | 'none' | null
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
type HolderProviderStatus = 'ok' | 'partial' | 'empty' | 'unavailable' | 'error' | 'unknown'
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
    rpc:                     'Contract verification',
    'dex_data+rpc':          'Contract verification',
    market_data:             'Market data',
    dex_data:                'Market data',
    on_chain:                'Holder data',
    security_check:          'Security simulation',
    security_check_limited:  'Security signals',
    unavailable:             'Data check',
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
  if (s === 'ok' || s === 'partial' || s === 'empty' || s === 'unavailable' || s === 'error') return s
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
  const gp = result.contractSecurity && result.contract
    ? (result.contractSecurity[result.contract.toLowerCase()] ?? null) as Record<string, unknown> | null
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

function buildHolderFallbackRead(fallback: HolderFallbackEvidence): { read: string; next: string } {
  const signals: string[] = []
  if (fallback.liquidityDepth != null && fallback.liquidityDepth > 0) {
    if (fallback.liquidityDepth > 1_000_000) signals.push(`Deep liquidity confirmed ($${(fallback.liquidityDepth / 1e6).toFixed(1)}M depth).`)
    else if (fallback.liquidityDepth > 200_000) signals.push(`Moderate liquidity confirmed ($${Math.round(fallback.liquidityDepth / 1000)}K depth).`)
    else signals.push('Liquidity is thin.')
  }
  if (fallback.poolCount > 5) signals.push(`Multi-pool coverage (${fallback.poolCount} pools) — real market activity visible.`)
  else if (fallback.poolCount > 1) signals.push(`${fallback.poolCount} active pools detected.`)
  if (fallback.marketCapToFdvPct != null) {
    if (fallback.marketCapToFdvPct >= 95) signals.push('MC/FDV near 100% — low unlock pressure visible.')
    else if (fallback.marketCapToFdvPct < 70) signals.push('FDV significantly exceeds MC — potential unlock pressure.')
  }
  if (fallback.ownerStatus === 'Renounced') signals.push('Contract owner renounced.')
  else if (fallback.ownerStatus === 'Held') signals.push('Contract owner is still active.')
  const intro = 'Holder rows were not returned in this pass, so concentration is the missing risk layer.'
  const read = signals.length ? `${intro} ${signals.join(' ')}` : `${intro} No additional on-chain context resolved.`
  return { read, next: 'Verify top holders before forming conviction on this token.' }
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
  const gp = result.contractSecurity && result.contract
    ? (result.contractSecurity[result.contract.toLowerCase()] ?? null) as Record<string, unknown> | null
    : null
  const hp = result.honeypot
  const baseChips: SecurityChip[] = [
    { label: 'Honeypot', displayLabel: hp?.isHoneypot === null ? 'Unverified' : hp?.isHoneypot ? 'YES' : 'NO', style: hp?.isHoneypot ? pillDanger() : pillSafe(), source: 'honeypot' },
    { label: 'Buy Tax', displayLabel: hp?.buyTax == null ? 'N/A' : (!hp.simulationSuccess && hp.buyTax === 0) ? 'Unverified' : `${hp.buyTax.toFixed(1)}%`, style: hp?.buyTax == null ? pillMuted() : (!hp.simulationSuccess && hp.buyTax === 0) ? pillMuted() : taxPct(hp.buyTax), source: 'honeypot' },
    { label: 'Sell Tax', displayLabel: hp?.sellTax == null ? 'N/A' : (!hp.simulationSuccess && hp.sellTax === 0) ? 'Unverified' : `${hp.sellTax.toFixed(1)}%`, style: hp?.sellTax == null ? pillMuted() : (!hp.simulationSuccess && hp.sellTax === 0) ? pillMuted() : taxPct(hp.sellTax), source: 'honeypot' },
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
      background: 'linear-gradient(160deg, rgba(10,18,34,.93), rgba(3,8,19,.90))',
      border: `1px solid ${accent ? `${accent}1e` : 'rgba(255,255,255,0.07)'}`,
      borderRadius: '14px',
      padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: '6px',
    }}>
      <p style={{
        fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em',
        color: '#3a5268', textTransform: 'uppercase', margin: 0,
        fontFamily: 'var(--font-plex-mono)',
      }}>
        {label}
      </p>
      <p style={{
        fontSize: '22px', fontWeight: 800, lineHeight: 1,
        color: accent ?? '#e2e8f0',
        fontFamily: 'var(--font-plex-mono)', margin: 0,
      }}>
        {value}
      </p>
      {helper && <p style={{ margin: 0, fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.4 }}>{helper}</p>}
    </div>
  )
}

// ─── Display-only helpers (pure — no fetching, no mutation) ───────────────

function getSummaryVerdict(result: ScanResult): { label: string; color: string; bg: string; border: string } {
  const hp = result.honeypot
  const liq = result.liquidity ?? 0
  const taxesHigh = (hp?.buyTax != null && hp.buyTax > 8) || (hp?.sellTax != null && hp.sellTax > 8)
  const holderState = deriveHolderState(result)
  if (hp?.isHoneypot === true || taxesHigh) return { label: 'AVOID',         color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)' }
  if (!result.price && !hp)                 return { label: 'UNKNOWN',       color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' }
  if (hp?.isHoneypot === false && liq > 120000 && holderState.kind === 'rowsWithPercent')
                                            return { label: 'CLEAN LOOKING', color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.35)'  }
  if (holderState.kind === 'noRowsFallback' || liq < 40000)
                                            return { label: 'WATCH',         color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)'  }
  return                                           { label: 'CAUTION',       color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.30)'  }
}

function getSummaryReasons(result: ScanResult): string[] {
  const hp = result.honeypot
  const liq = result.liquidity ?? 0
  const holderState = deriveHolderState(result)
  const reasons: string[] = []
  if (result.price != null && liq > 0) {
    const mcStr = result.marketCapUsd != null ? `MC ${fmtLarge(result.marketCapUsd)} verified` : 'market cap unverified'
    reasons.push(`Market is live — price ${fmtPrice(result.price)}, liquidity ${fmtLarge(liq)}, ${mcStr}.`)
  } else if (result.noActivePools) {
    reasons.push(`No active liquidity pool found for this token on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.`)
  } else {
    reasons.push('Market data is unavailable or limited.')
  }
  if (hp?.simulationSuccess && hp.isHoneypot === false) {
    const tax = hp.buyTax != null && hp.sellTax != null ? ` Tax: buy ${hp.buyTax.toFixed(1)}% / sell ${hp.sellTax.toFixed(1)}%.` : ''
    reasons.push(`Security simulation completed — no honeypot flagged.${tax}`)
  } else if (hp?.isHoneypot === true) {
    reasons.push('Honeypot flagged — blocked sells detected in simulation.')
  } else {
    reasons.push('Security simulation unavailable — treat status as unverified.')
  }
  if (holderState.kind === 'rowsWithPercent' && result.holderDistribution?.top10 != null) {
    const t = result.holderDistribution.top10
    const risk = t > 50 ? 'high concentration' : t > 30 ? 'moderate concentration' : 'reasonable spread'
    reasons.push(`Holder distribution confirmed — top 10 hold ${t.toFixed(1)}% (${risk}).`)
  } else if (holderState.kind === 'rowsWithoutPercent') {
    reasons.push('Holder wallets found but supply percentages not confirmed.')
  } else {
    reasons.push('Holder concentration not confirmed — treat as an incomplete check.')
  }
  return reasons.slice(0, 3)
}

function getMissingChecks(result: ScanResult): string[] {
  const holderState = deriveHolderState(result)
  const lpStatus = result.lpControl?.status
  const lpVerified = lpStatus === 'locked' || lpStatus === 'burned'
  return [
    result.noActivePools ? 'Active liquidity pool' : null,
    holderState.kind !== 'rowsWithPercent' ? 'Holder concentration' : null,
    !lpVerified ? 'LP lock or burn proof' : null,
    result.marketCapUsd == null ? 'Verified market cap' : null,
    'Supply spread',
  ].filter((v): v is string => v != null)
}

function getNextAction(result: ScanResult): string {
  const hp = result.honeypot
  const liq = result.liquidity ?? 0
  const holderState = deriveHolderState(result)
  if (hp?.isHoneypot === true) return 'Do not trade — honeypot detected in simulation.'
  if (result.noActivePools) return `No active pool found. Verify the contract is live on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.`
  if (liq > 0 && liq < 10000) return 'Liquidity is very thin — high slippage and exit risk present.'
  if (liq > 0 && liq < 50000) return 'Liquidity is limited. Verify LP lock or burn proof before entering.'
  if (holderState.kind === 'noRowsFallback') return 'Holder concentration not confirmed. Verify top holders before forming conviction on this token.'
  return 'Monitor liquidity and holder concentration before forming conviction. Treat incomplete checks as risk signals.'
}

// ─── CORTEX Score Engine ──────────────────────────────────────────────────

type CortexScoreResult = {
  score:      number
  verdict:    'CLEAN LOOKING' | 'WATCH' | 'CAUTION' | 'AVOID' | 'UNKNOWN'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  scanQuality: 'FULL' | 'PARTIAL' | 'LIMITED'
  capReason:  string | null
  breakdown: {
    market:    { status: string; score: number; reason: string }
    liquidity: { status: string; score: number; reason: string }
    holders:   { status: string; score: number; reason: string }
    security:  { status: string; score: number; reason: string }
    lp:        { status: string; score: number; reason: string }
    missing:   { status: string; penalty: number; reason: string }
  }
}

function calculateCortexScore(result: ScanResult): CortexScoreResult {
  const hp         = result.honeypot
  const liq        = result.liquidity ?? 0
  const holderState = deriveHolderState(result)
  const lpStatus   = result.lpControl?.status
  const top1       = result.holderDistribution?.top1  ?? null
  const top10      = result.holderDistribution?.top10 ?? null
  const top20      = result.holderDistribution?.top20 ?? null
  const buyTax     = hp?.buyTax  ?? 0
  const sellTax    = hp?.sellTax ?? 0
  const taxHigh    = buyTax > 8 || sellTax > 8

  let pts = 50

  // ── Market ──────────────────────────────────────────────────────────────
  let marketPts = 0, marketStatus = 'unavailable', marketReason = 'No market data available.'
  if (result.noActivePools) {
    marketPts = -15; marketReason = 'No active pool — price and market data unavailable.'
  } else {
    if (result.price     != null) marketPts += 10
    if (result.liquidity != null) marketPts += 8
    if (result.volume24h != null) marketPts += 6
    if (result.marketCapUsd != null) {
      marketPts += 6; marketStatus = 'ok'; marketReason = 'Live price, liquidity, and verified market cap available.'
    } else {
      marketPts -= 8; marketStatus = 'partial'; marketReason = 'Market data present but market cap unverified.'
    }
    if (result.price == null && result.liquidity == null) {
      marketStatus = 'unavailable'; marketReason = 'No price or liquidity data returned.'
    }
  }
  pts += marketPts

  // ── Liquidity ────────────────────────────────────────────────────────────
  let liqPts = 0, liqStatus = 'unavailable', liqReason = 'Liquidity unavailable.'
  if (liq >= 100_000)      { liqPts = 12;  liqStatus = 'ok';          liqReason = `Deep liquidity — ${fmtLarge(liq)}.` }
  else if (liq >= 25_000)  { liqPts = 8;   liqStatus = 'ok';          liqReason = `Moderate liquidity — ${fmtLarge(liq)}.` }
  else if (liq >= 5_000)   { liqPts = 4;   liqStatus = 'partial';     liqReason = `Thin liquidity — ${fmtLarge(liq)}.` }
  else if (liq > 0)        { liqPts = -10; liqStatus = 'unavailable'; liqReason = `Very thin liquidity — ${fmtLarge(liq)}.` }
  else                     { liqPts = -10; liqStatus = 'unavailable'; liqReason = 'No liquidity data available.' }
  pts += liqPts

  // ── Holders ──────────────────────────────────────────────────────────────
  let holderPts = 0, holderStatus = 'unavailable', holderReason = 'Holder concentration not confirmed.'
  if (holderState.kind === 'rowsWithPercent') {
    holderPts = 10; holderStatus = 'ok'; holderReason = 'Holder percentages verified.'
    if (top10 != null && top10 > 50) {
      holderPts -= 15; holderReason = `Top 10 hold ${top10.toFixed(1)}% — high concentration.`
    } else if (top20 != null && top20 > 60) {
      holderPts -= 5; holderReason = `Top 20 hold ${top20.toFixed(1)}% — elevated concentration.`
    }
    if (top1 != null && top1 > 20) {
      holderPts -= 8; holderReason += ` Single wallet holds ${top1.toFixed(1)}%.`
    }
  } else if (holderState.kind === 'rowsWithoutPercent') {
    holderPts = 5; holderStatus = 'partial'; holderReason = 'Holder wallets found — percentages unconfirmed.'
  } else {
    holderPts = -12; holderReason = 'Holder concentration not confirmed — open risk.'
  }
  pts += holderPts

  // ── Security ─────────────────────────────────────────────────────────────
  let secPts = 0, secStatus = 'unavailable', secReason = 'Security simulation unavailable.'
  if (hp?.isHoneypot === true) {
    secPts = -20; secStatus = 'critical'; secReason = 'HONEYPOT — sell simulation detected blocked transaction.'
  } else if (hp?.simulationSuccess === true && hp?.isHoneypot === false) {
    if (taxHigh) {
      secPts = -12; secStatus = 'risk'; secReason = `Simulation passed but taxes are high — buy ${buyTax.toFixed(1)}% / sell ${sellTax.toFixed(1)}%.`
    } else {
      secPts = 12; secStatus = 'ok'; secReason = 'Simulation passed — no honeypot, taxes within normal range.'
    }
  } else if (hp != null) {
    secPts = 6; secStatus = 'partial'; secReason = 'Partial security data available — simulation incomplete.'
  } else {
    secPts = -12; secStatus = 'unavailable'; secReason = 'No security simulation data this scan.'
  }
  pts += secPts

  // ── LP Control ───────────────────────────────────────────────────────────
  let lpPts = 0, lpStatusLabel = 'unavailable', lpReason = 'No LP lock or burn proof confirmed.'
  if (lpStatus === 'locked' || lpStatus === 'burned') {
    lpPts = 10; lpStatusLabel = 'ok'; lpReason = `LP ${lpStatus} — exit liquidity confirmed.`
  } else if (lpStatus === 'protocol') {
    lpPts = -6; lpStatusLabel = 'partial'; lpReason = 'Protocol-managed liquidity detected. Locker proof unavailable.'
  } else if (lpStatus === 'concentrated_liquidity') {
    lpPts = -8; lpStatusLabel = 'partial'; lpReason = 'Concentrated liquidity pool detected. Exit depth may shift rapidly.'
  } else if (result.lpControl?.poolAddressPresent) {
    lpPts = -10; lpStatusLabel = 'partial'; lpReason = 'LP ownership could not be verified this scan.'
  } else if (lpStatus === 'risky') {
    lpPts = -20; lpStatusLabel = 'critical'; lpReason = 'LP flagged risky.'
  } else {
    lpPts = -12; lpReason = 'LP lock or burn proof not confirmed.'
  }
  pts += lpPts

  // ── Missing checks penalty ───────────────────────────────────────────────
  const missingItems = [
    holderState.kind !== 'rowsWithPercent'                              ? 'holder concentration'  : null,
    lpStatus !== 'locked' && lpStatus !== 'burned'                      ? 'LP proof'              : null,
    result.marketCapUsd == null                                         ? 'market cap'            : null,
    !hp?.simulationSuccess                                              ? 'security simulation'   : null,
    result.contractSecurity == null                                               ? 'owner status'          : null,
  ].filter((v): v is string => v != null)
  const missingPenalty = Math.min(missingItems.length * 4, 18)
  pts -= missingPenalty
  const missingStatus = missingItems.length === 0 ? 'ok' : missingItems.length <= 2 ? 'partial' : 'unavailable'
  const missingReason = missingItems.length === 0
    ? 'No open checks.'
    : `${missingItems.length} checks missing: ${missingItems.join(', ')}.`

  // ── Score caps ───────────────────────────────────────────────────────────
  // Applied after base calculation. Prevent incomplete scans from appearing
  // fully verified. Each cap sets a maximum; the lowest applicable cap wins.
  const lpVerified2   = lpStatus === 'locked' || lpStatus === 'burned'
  const simVerified2  = hp?.simulationSuccess === true && hp?.isHoneypot === false
  const holdersVerif2 = holderState.kind === 'rowsWithPercent'
  const mcVerified2   = result.marketCapUsd != null
  const mc            = result.marketCapUsd ?? null
  const highHolderConc = top10 != null && top10 > 50
  // allMajorVerified: every important check has a positive result
  const allMajorVerified =
    lpVerified2 && simVerified2 && holdersVerif2 && mcVerified2 &&
    liq >= 25_000 && !highHolderConc && missingItems.length === 0

  let cap = 100
  let capReason: string | null = null

  const setCapIfLower = (newCap: number, reason: string) => {
    if (newCap < cap) { cap = newCap; capReason = reason }
  }

  // No data
  if (!result.price && !result.liquidity && !hp) {
    setCapIfLower(35, 'Insufficient data — score capped.')
  }
  // No active pool / no liquidity
  if (result.noActivePools || liq === 0) {
    setCapIfLower(40, 'No active pool detected — score capped.')
  }
  // Security simulation unavailable or tax sim not run
  if (!hp?.simulationSuccess) {
    setCapIfLower(80, 'Score capped by incomplete security/LP checks.')
  }
  // LP lock/burn proof unverified
  if (!lpVerified2) {
    setCapIfLower(72, 'Score capped by missing LP ownership proof.')
  }
  // Both security AND LP unverified → tighter cap
  if (!simVerified2 && !lpVerified2) {
    setCapIfLower(76, 'Score capped by incomplete LP/security checks.')
  }
  // Holder concentration unavailable
  if (holderState.kind === 'noRowsFallback') {
    setCapIfLower(75, 'Score capped by unverified holder data.')
  }
  // Holder concentration partial (rows present, percentages missing)
  if (holderState.kind === 'rowsWithoutPercent') {
    setCapIfLower(82, 'Score capped by partial holder data.')
  }
  // High holder concentration
  if (highHolderConc) {
    setCapIfLower(72, 'Score capped by high holder concentration.')
  }
  // Elevated top20 concentration
  if (top20 != null && top20 > 60 && !highHolderConc) {
    setCapIfLower(78, 'Score capped by elevated holder concentration.')
  }
  // Market cap unverified (but some market data exists)
  if (!mcVerified2 && (result.price != null || result.liquidity != null)) {
    setCapIfLower(82, 'Score capped by unverified market cap.')
  }
  // Low market cap — microcap tokens need all checks verified to score high
  if (mc != null && mc < 1_000_000 && !allMajorVerified) {
    setCapIfLower(72, 'Score capped by low-cap / incomplete verification.')
  } else if (mc != null && mc < 5_000_000 && !allMajorVerified) {
    setCapIfLower(78, 'Score capped by low-cap / incomplete verification.')
  }
  // 2+ major checks missing
  if (missingItems.length >= 3) {
    setCapIfLower(68, 'Score capped by 3+ incomplete checks.')
  } else if (missingItems.length >= 2) {
    setCapIfLower(76, 'Score capped by incomplete checks.')
  }
  // 95–100 only if everything is genuinely verified
  if (!allMajorVerified) {
    setCapIfLower(94, capReason ?? 'Score capped by incomplete verification.')
  }
  if (liq > 0 && liq < 25_000) {
    setCapIfLower(62, 'Score capped by low liquidity depth.')
  }

  // ── Clamp ────────────────────────────────────────────────────────────────
  const score = Math.min(cap, Math.max(0, Math.round(pts)))
  // Clear capReason if the raw score was already below the cap (cap didn't bite)
  const effectiveCapReason = Math.round(pts) > cap ? capReason : null

  // ── Verdict ──────────────────────────────────────────────────────────────
  const noData = !result.price && !result.liquidity && !hp
  let verdict: CortexScoreResult['verdict']
  if (noData) {
    verdict = 'UNKNOWN'
  } else if (hp?.isHoneypot === true || taxHigh || score < 40) {
    verdict = 'AVOID'
  } else if (
    score >= 82 &&
    liq >= 25_000 &&
    holdersVerif2 &&
    simVerified2 &&
    !taxHigh &&
    !highHolderConc &&
    lpVerified2 &&
    missingItems.length === 0
  ) {
    verdict = 'CLEAN LOOKING'
  } else if (score >= 65 && !highHolderConc && (lpVerified2 || simVerified2)) {
    verdict = 'WATCH'
  } else {
    verdict = 'CAUTION'
  }

  // ── Confidence ───────────────────────────────────────────────────────────
  const hasMarket    = result.price != null || result.liquidity != null
  const hasLiquidity = result.liquidity != null
  const hasHolders   = holderState.kind === 'rowsWithPercent'
  const hasHoldersPt = holderState.kind === 'rowsWithoutPercent'
  const hasSecurity  = hp?.simulationSuccess === true

  let confidence: CortexScoreResult['confidence']
  if (hasMarket && hasLiquidity && hasHolders && hasSecurity) {
    confidence = 'HIGH'
  } else if (hasMarket && hasLiquidity && (hasHolders || hasHoldersPt || hasSecurity)) {
    confidence = 'MEDIUM'
  } else {
    confidence = 'LOW'
  }

  // ── Scan quality ─────────────────────────────────────────────────────────
  const dataCount = [hasMarket, hasHolders || hasHoldersPt, hasSecurity, hasLiquidity].filter(Boolean).length
  const scanQuality: CortexScoreResult['scanQuality'] = dataCount >= 4 ? 'FULL' : dataCount >= 2 ? 'PARTIAL' : 'LIMITED'

  return {
    score,
    verdict,
    confidence,
    scanQuality,
    capReason: effectiveCapReason,
    breakdown: {
      market:    { status: marketStatus,  score: marketPts,    reason: marketReason },
      liquidity: { status: liqStatus,     score: liqPts,       reason: liqReason },
      holders:   { status: holderStatus,  score: holderPts,    reason: holderReason },
      security:  { status: secStatus,     score: secPts,       reason: secReason },
      lp:        { status: lpStatusLabel, score: lpPts,        reason: lpReason },
      missing:   { status: missingStatus, penalty: -missingPenalty, reason: missingReason },
    },
  }
}

function getVerdictStyle(verdict: CortexScoreResult['verdict']): { label: string; color: string; bg: string; border: string } {
  switch (verdict) {
    case 'AVOID':        return { label: 'AVOID',         color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)' }
    case 'CLEAN LOOKING':return { label: 'CLEAN LOOKING', color: '#2DD4BF', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.35)'  }
    case 'WATCH':        return { label: 'WATCH',         color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)'  }
    case 'CAUTION':      return { label: 'CAUTION',       color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.30)'  }
    default:             return { label: 'UNKNOWN',       color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' }
  }
}

function getMarketRead(result: ScanResult): string {
  if (result.noActivePools) return 'No active pool found. Market data is unavailable.'
  const parts = [
    result.price != null    ? `price ${fmtPrice(result.price)}` : null,
    result.liquidity != null ? `liquidity ${fmtLarge(result.liquidity)}` : null,
    result.volume24h != null ? `volume ${fmtLarge(result.volume24h)} 24h` : null,
    result.priceChange24h != null ? `${fmtPct(result.priceChange24h)} change` : null,
  ].filter(Boolean)
  const mc = result.marketCapUsd != null
    ? `Market cap ${fmtLarge(result.marketCapUsd)} — verified live.`
    : result.fdvUsd != null
      ? `Market cap unverified — FDV ${fmtLarge(result.fdvUsd)} shown as context.`
      : 'Market cap not verified.'
  return parts.length ? `${parts.join(', ')}. ${mc}` : 'Market data unavailable.'
}

function getSecurityRead(result: ScanResult): string {
  const hp = result.honeypot
  if (hp?.isHoneypot === true) return 'Honeypot flagged — sell simulation detected blocked transaction.'
  if (!hp?.simulationSuccess) return 'Security simulation did not complete — status is unverified in this pass.'
  const parts = [
    'Honeypot: not flagged',
    hp.buyTax != null ? `buy tax ${hp.buyTax.toFixed(1)}%` : null,
    hp.sellTax != null ? `sell tax ${hp.sellTax.toFixed(1)}%` : null,
    hp.transferTax != null && hp.transferTax > 0 ? `transfer tax ${hp.transferTax.toFixed(1)}%` : null,
  ].filter(Boolean)
  return parts.join(', ') + '. Simulation verified.'
}

function getHolderRead(result: ScanResult): string {
  const holderState = deriveHolderState(result)
  if (holderState.kind === 'noRowsFallback') return 'Holder distribution was not returned this scan. Treat supply spread as unverified.'
  if (holderState.kind === 'rowsWithoutPercent') return 'Holder wallets available, but supply percentages not confirmed. Treat concentration as partially unverified.'
  const top10 = result.holderDistribution?.top10
  const count = result.holderDistribution?.holderCount
  const parts = [
    count != null ? `${count.toLocaleString()} holders on record` : null,
    top10 != null ? `top 10 hold ${top10.toFixed(1)}%` : null,
    result.holderDistribution?.top20 != null ? `top 20 hold ${result.holderDistribution.top20.toFixed(1)}%` : null,
  ].filter(Boolean)
  return parts.length ? `Holder distribution confirmed. ${parts.join(', ')}.` : 'Holder distribution available but details sparse.'
}

function getLiquidityRead(result: ScanResult): string {
  const liq = result.liquidity ?? 0
  const poolCount = result.pools?.length ?? 0
  if (result.noActivePools || poolCount === 0) return `No active liquidity pool detected on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.`
  const depth = liq > 1_000_000 ? 'Deep' : liq > 200_000 ? 'Moderate' : liq > 50_000 ? 'Limited' : liq > 0 ? 'Thin' : 'Unverified'
  const poolStr = poolCount > 1 ? `${poolCount} pools found.` : 'Primary pool found.'
  const lpStatus = result.lpControl?.status
  const lpStr = lpStatus === 'burned' || lpStatus === 'locked' ? 'LP locked or burned.' : lpStatus === 'team_controlled' ? 'LP appears team-controlled.' : 'LP lock not confirmed.'
  return `${depth} liquidity (${fmtLarge(liq)}). ${poolStr} ${lpStr}`
}

// ─── CORTEX Summary Card ──────────────────────────────────────────────────

function CortexSummaryCard({ result }: { result: ScanResult }) {
  const v = getSummaryVerdict(result)
  const reasons = getSummaryReasons(result)
  const missing = getMissingChecks(result)
  const next = getNextAction(result)
  const confidence = result.marketConfidence === 'high' ? 'HIGH' : result.marketConfidence === 'medium' ? 'MEDIUM' : 'LOW'
  const confColor = confidence === 'HIGH' ? '#34d399' : confidence === 'MEDIUM' ? '#fbbf24' : '#94a3b8'
  return (
    <div style={{
      marginBottom: '22px',
      background: 'linear-gradient(160deg, rgba(8,16,32,.97), rgba(4,8,18,.95))',
      border: `1px solid ${v.color}28`,
      borderRadius: '16px',
      padding: '20px 22px',
      boxShadow: `0 0 36px ${v.color}0e, 0 0 0 1px rgba(255,255,255,0.04) inset`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>
          CORTEX SCAN SUMMARY
        </span>
        <span style={{ padding: '3px 12px', borderRadius: '999px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.10em', color: v.color, background: v.bg, border: `1px solid ${v.border}`, fontFamily: 'var(--font-plex-mono)' }}>
          {v.label}
        </span>
        <span style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: confColor, background: `${confColor}12`, border: `1px solid ${confColor}38`, fontFamily: 'var(--font-plex-mono)' }}>
          {confidence} CONFIDENCE
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', marginBottom: '14px' }}>
        {reasons.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <span style={{ color: '#2DD4BF', fontSize: '11px', flexShrink: 0, fontFamily: 'var(--font-plex-mono)' }}>•</span>
            <p style={{ margin: 0, fontSize: '12px', color: '#b7c9da', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{r}</p>
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'flex-start' }}>
        {missing.length > 0 && (
          <div style={{ flex: '1 1 180px' }}>
            <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#3a5268', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Missing checks</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
              {missing.slice(0, 4).map((m) => (
                <span key={m} style={{ padding: '2px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}
        <div style={{ flex: '2 1 220px' }}>
          <p style={{ margin: '0 0 4px', fontSize: '9px', color: '#3a5268', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Next action</p>
          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{next}</p>
        </div>
      </div>
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
  const { loading: planLoading } = usePlanWithLoading()
  const isFullAccess = true

  const [chain, setChain]       = useState<'base' | 'eth'>('base')
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ScanResult | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [lpExpanded, setLpExpanded] = useState(true)
  const [activeSection, setActiveSection] = useState<'cortex-read'|'market-pulse'|'holder-map'|'lp-control'|'risk-checks'|'watch-plan'>('cortex-read')

  const [clarkVerdict, setClarkVerdict] = useState<string | null>(null)
  const [clarkLoading, setClarkLoading] = useState(false)
  const [clarkError, setClarkError]     = useState<string | null>(null)

  // Auto-scan when opened from Base Radar with ?contract= param
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params      = new URLSearchParams(window.location.search)
    const contract    = params.get('contract')
    const chainParam  = params.get('chain')
    const autoChain   = chainParam === 'eth' ? 'eth' : 'base'
    if (chainParam === 'eth') setChain('eth')
    if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
      handleScan(contract, autoChain)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleScan(override?: string, chainOverride?: 'base' | 'eth') {
    const q             = (override ?? input).trim()
    const effectiveChain = chainOverride ?? chain
    if (!q || loading) return
    setLoading(true)
    setClarkLoading(true)
    setError(null)
    setResult(null)
    setLpExpanded(true)
    setActiveSection('cortex-read')
    setClarkVerdict(null)
    setClarkError(null)
    try {
      const debugHolder = typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('debugHolder') === 'true'
      const { data: _sd } = await supabase.auth.getSession()
      const _tok = _sd.session?.access_token
      const res  = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_tok ? { Authorization: `Bearer ${_tok}` } : {}) },
        body: JSON.stringify({ contract: q, chain: effectiveChain, ...(debugHolder ? { debugHolder: true } : {}) }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        if (json?.status === 'invalid_address') setError(json.error ?? 'Invalid address format. Expected 0x followed by 40 hex characters.')
        else if (json?.status === 'ambiguous') setError('Multiple tokens match this. Paste the contract address or choose one.')
        else setError("Couldn't resolve that token. Paste the contract address or try a verified symbol.")
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
          noActivePools:    json.noActivePools ?? false,
          primaryDexName:   json.primaryDexName ?? null,
          marketDataSource: json.marketDataSource ?? 'none',
          marketConfidence: json.marketConfidence ?? 'low',
          // Use effective values from server (include fallback market read when primary has no pool)
          price:          num(json.priceUsd) ?? (mainPool ? num(attr(mainPool).base_token_price_usd) : null),
          liquidity:      num(json.liquidityUsd) ?? (mainPool ? num(attr(mainPool).reserve_in_usd) : null),
          volume24h:      num(json.volume24hUsd) ?? (mainPool ? num((attr(mainPool).volume_usd as Record<string, unknown> | undefined)?.h24) : null),
          priceChange24h: num(json.sections?.market?.change24h) ?? (mainPool ? num((attr(mainPool).price_change_percentage as Record<string, unknown> | undefined)?.h24) : null),
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
          contractSecurity: json.contractSecurity ?? null,
          honeypot: json.honeypot ?? null,
          holderDistribution: json.holderDistribution ?? null,
          holderDistributionStatus: json.holderDistributionStatus ?? null,
          debugHolderStatus: json.debugHolderStatus ?? null,
          sections: json.sections ?? null,
          lpControl: json.lpControl ?? null,
          poolActivity: json.poolActivity ?? null,
          priceChart: json.priceChart ?? null,
          chartStatus: json.chartStatus ?? null,
          chartDataSource: json.chartDataSource ?? null,
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
        .glass-card{background:linear-gradient(180deg,rgba(10,18,34,.9),rgba(3,8,19,.88));border:1px solid rgba(148,163,184,.18);border-radius:16px;box-shadow:0 0 0 1px rgba(45,212,191,.05) inset,0 18px 45px rgba(2,6,23,.4),0 0 28px rgba(139,92,246,.12);} 
        .metric-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr)) !important;gap:clamp(8px,1vw,12px) !important;}
        .activity-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;}
        @media (min-width:1536px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(360px,22vw,420px);} .token-main{max-width:1260px;margin:0 auto;}}
        @media (min-width:1280px) and (max-width:1535px){.token-shell{grid-template-columns:minmax(0,1fr) clamp(320px,24vw,360px);} .token-main{max-width:1120px;margin:0 auto;} .mob-verdict-panel{padding:24px 16px;font-size:12px;} .activity-grid{gap:8px;}}
        @media (max-width:1279px){.token-shell{display:block;height:auto;overflow:visible;} .mob-scan-main{overflow-y:visible !important;} .token-shell .mob-verdict-panel{position:static !important;width:100% !important;max-width:100% !important;height:auto !important;min-height:0 !important;border-left:none !important;border-top:1px solid rgba(255,255,255,0.08) !important;overflow-y:visible !important;}}
        @media (max-width:1023px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;} .holders-grid,.intel-grid{grid-template-columns:1fr !important;} .activity-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;}}
        @media (max-width:768px){.token-main{padding:30px 14px 120px !important;} .token-input-row{flex-direction:column;max-width:100% !important;} .token-input-row button{width:100%;} .top-holder-head{display:none !important;} .top-holder-row{display:block !important;padding:12px !important;} .top-holder-mobile-meta{display:flex !important;align-items:center;justify-content:space-between;gap:8px;} .top-holder-mobile-amt{display:block !important;margin-top:6px !important;text-align:left !important;} .pools-scroll{overflow-x:auto !important;-webkit-overflow-scrolling:touch;margin:0 -12px;padding:0 12px;} .mob-verdict-panel{padding:18px 14px !important;gap:12px !important;} .glass-card{padding:14px !important;}}
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
            <h1 style={{ fontSize: '28px', fontWeight: 800, color: '#f8fafc', lineHeight: 1.2, margin: 0 }}>Token Scanner</h1><p style={{margin:'8px 0 0',color:'#94a3b8',fontSize:'13px'}}>{chain === 'eth' ? 'Scan Ethereum tokens for liquidity, contract risk, taxes, pool depth, and Clark AI verdicts.' : 'Scan Base tokens for liquidity, contract risk, taxes, pool depth, and Clark AI verdicts.'}</p><p style={{margin:'6px 0 0',color:'#64748b',fontSize:'11px',fontFamily:'var(--font-plex-mono)'}}>{planLoading ? 'Checking CORTEX access…' : 'Full scan access.'}</p>
          </div>

          {/* Chain selector */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
            {(['base', 'eth'] as const).map(c => (
              <button key={c} type="button" onClick={() => setChain(c)} style={{ padding: '5px 14px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, letterSpacing: '.1em', fontFamily: 'var(--font-plex-mono)', border: chain === c ? '1px solid rgba(45,212,191,.6)' : '1px solid rgba(255,255,255,0.10)', background: chain === c ? 'rgba(45,212,191,.12)' : 'transparent', color: chain === c ? '#2DD4BF' : '#64748b', cursor: 'pointer', transition: 'all 0.12s' }}>
                {c === 'base' ? 'BASE' : 'ETHEREUM'}
              </button>
            ))}
          </div>

          {/* Input row */}
          <div className="token-input-row glass-card" style={{ display: 'flex', gap: '10px', maxWidth: '820px', marginBottom: '24px', padding: '10px' }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleScan() }}
              disabled={loading}
              placeholder={chain === 'eth' ? 'Paste Ethereum contract address' : 'Paste Base contract, symbol, or token name'}
              style={{
                flex: 1, padding: '12px 16px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: '10px',
                color: '#e2e8f0', fontSize: '16px',
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

              {/* Token identity — always visible */}
              <div style={{ marginBottom: '20px' }}>
                <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', margin: '0 0 4px' }}>
                  {result.name ?? 'Unknown'}
                  {result.symbol && <span style={{ marginLeft: '10px', fontSize: '14px', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}>{result.symbol}</span>}
                </h2>
                {result.contract && (
                  <p style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
                    {shorten(result.contract)}{` · ${String(result.chain ?? 'Base').toUpperCase()}`}
                    <span style={{ marginLeft: '8px', padding: '2px 8px', border: '1px solid rgba(59,130,246,.35)', borderRadius: '999px', color: '#93c5fd' }}>{String(result.chain ?? chain).toUpperCase()}</span>
                  </p>
                )}
                {result.resolvedInput && result.resolvedInput.type !== 'address' && (
                  <p style={{ margin: '6px 0 0', color: '#94a3b8', fontSize: '11px' }}>Resolved from {result.resolvedInput.original.toUpperCase()}.</p>
                )}
              </div>

              {/* CORTEX Command Bar */}
              {(() => {
                const cmds: Array<{ id: typeof activeSection; label: string; dot: string }> = [
                  { id: 'cortex-read',  label: 'CORTEX Read',  dot: '#2DD4BF' },
                  { id: 'market-pulse', label: 'Market Pulse',  dot: '#67e8f9' },
                  { id: 'holder-map',   label: 'Holder Map',    dot: '#a78bfa' },
                  { id: 'lp-control',   label: 'LP Control',    dot: '#34d399' },
                  { id: 'risk-checks',  label: 'Risk Checks',   dot: '#f87171' },
                  { id: 'watch-plan',   label: 'Watch Plan',    dot: '#fbbf24' },
                ]
                return (
                  <div style={{ display: 'flex', gap: '3px', marginBottom: '22px', overflowX: 'auto', paddingBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {cmds.map(s => {
                      const active = activeSection === s.id
                      return (
                        <button key={s.id} onClick={() => setActiveSection(s.id)}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '6px',
                            padding: '6px 13px', borderRadius: '8px', cursor: 'pointer',
                            whiteSpace: 'nowrap', flexShrink: 0,
                            fontFamily: 'var(--font-plex-mono)', fontSize: '10px',
                            fontWeight: active ? 800 : 600, letterSpacing: '0.11em',
                            transition: 'all 0.14s',
                            background: active ? `linear-gradient(135deg,${s.dot}16,rgba(139,92,246,0.10))` : 'transparent',
                            border: active ? `1px solid ${s.dot}40` : '1px solid transparent',
                            color: active ? s.dot : '#3a5268',
                            boxShadow: active ? `0 0 14px ${s.dot}14` : 'none',
                          }}
                        >
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0, background: active ? s.dot : '#1e3a44', boxShadow: active ? `0 0 6px ${s.dot}` : 'none' }} />
                          {s.label}
                        </button>
                      )
                    })}
                  </div>
                )
              })()}

              {/* ── CORTEX READ ───────────────────────────────────────── */}
              {activeSection === 'cortex-read' && (() => {
                const cx = calculateCortexScore(result)
                const score = cx.score
                const scoreColor = score >= 75 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171'
                const v = getVerdictStyle(cx.verdict)
                const confidence = cx.confidence
                const confColor = confidence === 'HIGH' ? '#34d399' : confidence === 'MEDIUM' ? '#fbbf24' : '#94a3b8'
                const holderState = deriveHolderState(result)
                const lpStatus = result.lpControl?.status
                const lpVerified = lpStatus === 'locked' || lpStatus === 'burned'
                const marketChipOk = (result.price != null || result.liquidity != null) && !result.noActivePools
                const holdersChipOk = holderState.kind === 'rowsWithPercent'
                const holdersChipPartial = holderState.kind === 'rowsWithoutPercent'
                const riskChipOk = result.honeypot?.isHoneypot === false && result.honeypot?.simulationSuccess === true
                const simUnavailable = !result.honeypot?.simulationSuccess
                const hp2 = result.honeypot
                const liq2 = result.liquidity ?? 0
                const buyTax2 = hp2?.buyTax ?? null
                const sellTax2 = hp2?.sellTax ?? null
                const taxesHigh2 = (buyTax2 != null && buyTax2 > 8) || (sellTax2 != null && sellTax2 > 8)
                const goodSigns: string[] = [
                  (hp2?.isHoneypot === false && hp2?.simulationSuccess) ? 'Security simulation passed — no honeypot flagged.' : '',
                  liq2 > 1_000_000 ? `Deep liquidity — ${fmtLarge(liq2)} pool depth.` : liq2 > 200_000 ? `Moderate liquidity — ${fmtLarge(liq2)} pool depth.` : '',
                  holderState.kind === 'rowsWithPercent' ? 'Holder distribution confirmed with percentages.' : '',
                  result.marketCapUsd != null ? `Market cap verified — ${fmtLarge(result.marketCapUsd)}.` : '',
                  lpVerified ? `LP ${result.lpControl?.status} — exit liquidity confirmed.` : '',
                  (result.pools?.length ?? 0) > 1 ? `${result.pools!.length} active pools detected.` : '',
                ].filter(Boolean).slice(0, 4) as string[]
                const riskSigns: string[] = [
                  hp2?.isHoneypot === true ? 'HONEYPOT — sell simulation detected blocked transaction.' : '',
                  taxesHigh2 ? `Elevated taxes — buy ${buyTax2?.toFixed(1)}% / sell ${sellTax2?.toFixed(1)}%.` : '',
                  liq2 > 0 && liq2 < 10000 ? 'Very thin liquidity — extreme slippage and exit risk.' : liq2 > 0 && liq2 < 50000 ? `Thin liquidity — ${fmtLarge(liq2)} depth, slippage risk.` : '',
                  holderState.kind === 'noRowsFallback' ? 'Holder concentration not confirmed — open risk check.' : holderState.kind === 'rowsWithoutPercent' ? 'Holder wallets found but percentages not confirmed.' : '',
                  result.marketCapUsd == null ? 'Market cap not verified — supply unconfirmed.' : '',
                  !hp2?.simulationSuccess ? 'Tax simulation unavailable — status unverified.' : '',
                  result.noActivePools ? `No active liquidity pool detected on ${result.chain === 'eth' ? 'Ethereum' : 'Base'}.` : '',
                ].filter(Boolean).slice(0, 4) as string[]
                const missing2 = getMissingChecks(result)
                const next2 = getNextAction(result)
                const statusChips = [
                  { label: 'Market',      chipOk: marketChipOk,    chipPartial: false,              chipColor: marketChipOk ? '#34d399' : '#f87171' },
                  { label: 'Holders',     chipOk: holdersChipOk,   chipPartial: holdersChipPartial, chipColor: holdersChipOk ? '#34d399' : holdersChipPartial ? '#fbbf24' : '#f87171' },
                  { label: 'LP Control',  chipOk: lpVerified,      chipPartial: false,              chipColor: lpVerified ? '#34d399' : '#f87171' },
                  { label: 'Risk Checks', chipOk: riskChipOk,      chipPartial: simUnavailable,     chipColor: riskChipOk ? '#34d399' : simUnavailable ? '#94a3b8' : '#f87171' },
                ]
                const marketStrengthLabel = result.noActivePools ? 'Unverified' : (result.liquidity ?? 0) > 250000 ? 'Strong' : (result.liquidity ?? 0) > 50000 ? 'Active' : (result.liquidity ?? 0) > 0 ? 'Thin' : 'Unverified'
                const holderRiskLabel = holderState.kind !== 'rowsWithPercent' ? 'Unverified' : (result.holderDistribution?.top10 ?? 0) > 50 ? 'High' : (result.holderDistribution?.top10 ?? 0) > 30 ? 'Medium' : 'Low'
                const lpProofLabel = lpStatus === 'locked' || lpStatus === 'burned' ? 'Verified' : (lpStatus === 'protocol' || lpStatus === 'concentrated_liquidity') ? 'Protocol liquidity' : 'Unverified'
                const securityConfidenceLabel = result.honeypot?.simulationSuccess ? (result.honeypot?.isHoneypot === false ? 'Verified' : 'Partial') : 'Unverified'
                const scoreBreakdown = [
                  { label: 'Market', ok: marketChipOk, reason: result.noActivePools ? 'No active pool detected.' : 'Price and pool state available.' },
                  { label: 'Liquidity', ok: (result.liquidity ?? 0) > 1000, reason: (result.liquidity ?? 0) > 1000 ? `${fmtLarge(result.liquidity)} depth detected.` : 'Liquidity too thin or missing.' },
                  { label: 'Holders', ok: holderState.kind === 'rowsWithPercent', reason: holderState.kind === 'rowsWithPercent' ? 'Top holder percentages verified.' : 'Holder percentages unverified.' },
                  { label: 'Security', ok: riskChipOk, reason: riskChipOk ? 'Simulation passed with no honeypot flag.' : simUnavailable ? 'Simulation unavailable this pass.' : 'Security risk detected.' },
                  { label: 'LP Proof', ok: lpVerified, reason: lpVerified ? `LP ${lpStatus}.` : 'No lock/burn proof confirmed.' },
                  { label: 'Missing Checks', ok: missing2.length === 0, reason: missing2.length === 0 ? 'No open checks.' : `${missing2.length} open checks remain.` },
                ]
                const goodSignals = goodSigns.length >= 2 ? goodSigns : [...goodSigns, 'No additional positive signals confirmed this scan.']
                const riskSignals = riskSigns.length >= 2 ? riskSigns : [...riskSigns, 'No additional risk signals surfaced beyond current checks.']
                return (
                  <>
                    {/* CORTEX Score Hero */}
                    <div style={{ marginBottom: '20px', background: 'linear-gradient(160deg,rgba(8,16,32,.97),rgba(4,8,18,.95))', border: `1px solid ${scoreColor}28`, borderRadius: '18px', padding: '22px 24px', boxShadow: `0 0 44px ${scoreColor}0c` }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px', flexWrap: 'wrap', marginBottom: '16px' }}>
                        <div style={{ flexShrink: 0 }}>
                          <div style={{ fontSize: '9px', letterSpacing: '.18em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '6px' }}>CORTEX SCORE</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
                            <span style={{ fontSize: '52px', fontWeight: 800, color: scoreColor, fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>{score}</span>
                            <span style={{ fontSize: '16px', color: `${scoreColor}50`, fontFamily: 'var(--font-plex-mono)' }}>/100</span>
                          </div>
                          <div style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginTop: '5px' }}>{cx.scanQuality} · {cx.confidence} CONF</div>
                        </div>
                        <div style={{ flex: 1, minWidth: '140px', paddingTop: '6px' }}>
                          <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '14px' }}>
                            <span style={{ padding: '5px 16px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, letterSpacing: '0.10em', color: v.color, background: v.bg, border: `1px solid ${v.border}`, fontFamily: 'var(--font-plex-mono)' }}>{v.label}</span>
                            <span style={{ padding: '5px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em', color: confColor, background: `${confColor}12`, border: `1px solid ${confColor}38`, fontFamily: 'var(--font-plex-mono)' }}>{confidence} CONFIDENCE</span>
                          </div>
                          <div style={{ height: '5px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${score}%`, borderRadius: '999px', background: `linear-gradient(90deg,${scoreColor},${scoreColor}80)`, transition: 'width 0.7s ease' }} />
                          </div>
                        </div>
                      </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(102px,1fr))', gap: '8px' }}>
                        {statusChips.map(({ label, chipOk, chipPartial, chipColor }) => (
                          <div key={label} style={{ padding: '9px 11px', borderRadius: '10px', background: `${chipColor}08`, border: `1px solid ${chipColor}20`, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: chipColor, flexShrink: 0, boxShadow: `0 0 5px ${chipColor}` }} />
                            <div>
                              <div style={{ fontSize: '9px', letterSpacing: '.12em', color: chipColor, fontFamily: 'var(--font-plex-mono)', fontWeight: 700 }}>{label}</div>
                              <div style={{ fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{chipOk ? 'Verified' : chipPartial ? 'Partial' : 'Unverified'}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: '10px', marginBottom: '12px' }}>
                      {[{label:'Market Strength',value:marketStrengthLabel},{label:'Holder Risk',value:holderRiskLabel},{label:'LP Proof',value:lpProofLabel},{label:'Security Confidence',value:securityConfidenceLabel}].map((item)=>(
                        <div key={item.label} style={{ padding:'11px 12px', borderRadius:'11px', border:'1px solid rgba(148,163,184,0.18)', background:'rgba(8,14,28,0.62)' }}>
                          <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', fontFamily:'var(--font-plex-mono)', marginBottom:'5px' }}>{item.label}</div>
                          <div style={{ fontSize:'13px', fontWeight:700, color:'#e2e8f0', fontFamily:'var(--font-plex-mono)' }}>{item.value}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginBottom:'20px', padding:'14px 16px', borderRadius:'12px', border:'1px solid rgba(125,211,252,0.18)', background:'rgba(8,14,28,0.65)' }}>
                      <p style={{ margin:'0 0 10px', fontSize:'10px', letterSpacing:'.14em', color:'#7dd3fc', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>CORTEX SCORE BREAKDOWN</p>
                      <div style={{ display:'grid', gap:'7px' }}>
                        {scoreBreakdown.map((b)=>(
                          <div key={b.label} style={{ display:'grid', gridTemplateColumns:'120px 74px 1fr', gap:'10px', alignItems:'center' }}>
                            <span style={{ fontSize:'11px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)' }}>{b.label}</span>
                            <span style={{ fontSize:'10px', color:b.ok ? '#34d399' : '#fbbf24', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{b.ok ? 'PASS' : 'OPEN'}</span>
                            <span style={{ fontSize:'11px', color:'#94a3b8', fontFamily:'var(--font-plex-mono)' }}>{b.reason}</span>
                          </div>
                        ))}
                        <div style={{ display:'flex', alignItems:'center', gap:'8px', marginTop:'4px', padding:'7px 10px', borderRadius:'8px', background: cx.capReason ? 'rgba(148,163,184,0.05)' : 'rgba(52,211,153,0.04)', border: cx.capReason ? '1px solid rgba(148,163,184,0.14)' : '1px solid rgba(52,211,153,0.14)' }}>
                          <span style={{ fontSize:'10px', color: cx.capReason ? '#64748b' : '#34d399', fontFamily:'var(--font-plex-mono)', fontStyle:'italic' }}>⚑ {cx.capReason ?? 'No major score cap applied.'}</span>
                        </div>
                      </div>
                    </div>
                    {/* 4-card CORTEX Read layout */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(228px,1fr))', gap: '12px', marginBottom: '20px' }}>
                      <div style={{ padding: '16px', background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.18)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', color: '#34d399', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Good Signs</p>
                        {goodSignals.length > 0 ? goodSignals.map((s, i) => (
                          <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '6px' }}>
                            <span style={{ color: '#34d399', flexShrink: 0, fontSize: '11px', lineHeight: '16px' }}>✓</span>
                            <p style={{ margin: 0, fontSize: '11px', color: '#86efac', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                          </div>
                        )) : <p style={{ margin: 0, fontSize: '11px', color: '#1e3a44', fontFamily: 'var(--font-plex-mono)' }}>No positive signals confirmed yet.</p>}
                      </div>
                      <div style={{ padding: '16px', background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.18)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', color: '#f87171', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Risk Signs</p>
                        {riskSignals.length > 0 ? riskSignals.map((s, i) => (
                          <div key={i} style={{ display: 'flex', gap: '7px', marginBottom: '6px' }}>
                            <span style={{ color: '#f87171', flexShrink: 0, fontSize: '11px', lineHeight: '16px' }}>!</span>
                            <p style={{ margin: 0, fontSize: '11px', color: '#fca5a5', lineHeight: 1.55, fontFamily: 'var(--font-plex-mono)' }}>{s}</p>
                          </div>
                        )) : <p style={{ margin: 0, fontSize: '11px', color: '#1e3a44', fontFamily: 'var(--font-plex-mono)' }}>No major risk signals surfaced.</p>}
                      </div>
                      <div style={{ padding: '16px', background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', color: '#fbbf24', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Missing Checks</p>
                        {missing2.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                            {missing2.map(m => <span key={m} style={{ padding: '3px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 600, color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.22)', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>{m}</span>)}
                          </div>
                        ) : <p style={{ margin: 0, fontSize: '11px', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>All key checks passed.</p>}
                      </div>
                      <div style={{ padding: '16px', background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.22)', borderRadius: '12px' }}>
                        <p style={{ margin: '0 0 10px', fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', color: '#2DD4BF', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Next Action</p>
                        <p style={{ margin: 0, fontSize: '11px', color: '#67e8f9', lineHeight: 1.6, fontFamily: 'var(--font-plex-mono)' }}>{next2}</p>
                      </div>
                    </div>
                    {cx.confidence === 'LOW' && (
                      <div style={{ marginBottom: '16px', padding: '11px 14px', borderRadius: '10px', border: '1px solid rgba(148,163,184,0.22)', background: 'rgba(148,163,184,0.06)' }}>
                        <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>⚠ Limited confidence — important checks are missing. Do not assume safety.</span>
                      </div>
                    )}
                    {result.sections && (
                      <div style={{ marginBottom: '20px', fontSize: '12px', color: '#94a3b8' }}>
                        {[result.sections.market, result.sections.security, result.sections.holders, result.sections.liquidity, result.sections.contractChecks]
                          .filter((s): s is { status?: string; reason?: string; source?: string } => Boolean(s && s.status && s.status !== 'ok'))
                          .map((s, i) => <div key={i}>- {humanizeSectionLine(s.source, s.status, s.reason)}</div>)}
                      </div>
                    )}
                    {!planLoading && !isFullAccess && (
                      <div style={{ marginTop: '24px', padding: '28px 24px', border: '1px solid rgba(139,92,246,0.28)', borderRadius: '16px', background: 'rgba(139,92,246,0.06)', textAlign: 'center' }}>
                        <div style={{ fontSize: '26px', marginBottom: '12px' }}>🔒</div>
                        <p style={{ fontWeight: 700, color: '#f8fafc', margin: '0 0 8px', fontSize: '15px' }}>Full Security Report</p>
                        <p style={{ color: '#94a3b8', fontSize: '13px', margin: '0 0 20px', lineHeight: 1.5 }}>LP control, security simulation, and holder distribution are included in Pro and Elite plans.</p>
                        <a href="/pricing" style={{ display: 'inline-block', padding: '10px 28px', borderRadius: '999px', background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: '#fff', fontWeight: 700, fontSize: '13px', textDecoration: 'none' }}>Get Access</a>
                      </div>
                    )}
                  </>
                )
              })()}

              {/* ── MARKET PULSE ──────────────────────────────────────── */}
              {activeSection === 'market-pulse' && (
                <>
                  <div style={{ marginBottom: '18px' }}>
                    <p style={{ margin: '0 0 3px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.10em', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)' }}>MARKET PULSE</p>
                    <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Live price, liquidity, volume and pool data for this token.</p>
                  </div>
                  <div style={{ marginBottom: '16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: '9px' }}>
                    {(() => {
                      const marketStrength = result.noActivePools ? 'Unverified' : (result.liquidity ?? 0) > 250000 ? 'Strong' : (result.liquidity ?? 0) > 50000 ? 'Active' : (result.liquidity ?? 0) > 0 ? 'Thin' : 'Unverified'
                      const volRead = result.priceChange24h == null ? 'Unverified' : Math.abs(result.priceChange24h) > 20 ? 'High volatility' : Math.abs(result.priceChange24h) > 8 ? 'Moderate volatility' : 'Controlled volatility'
                      const activityRead = result.volume24h != null && result.liquidity != null && result.liquidity > 0 ? `${((result.volume24h / result.liquidity) * 100).toFixed(0)}% vol/liquidity` : 'Activity unverified'
                      const mcfdvRead = result.marketCapUsd != null && result.fdvUsd != null && result.fdvUsd > 0 ? `${((result.marketCapUsd / result.fdvUsd) * 100).toFixed(0)}% MC/FDV` : 'MC vs FDV unverified'
                      const items = [
                        ['Market strength', marketStrength],
                        ['Liquidity depth', result.liquidity != null ? fmtLarge(result.liquidity) : 'Unverified'],
                        ['24h activity', activityRead],
                        ['Volatility read', volRead],
                        ['MC vs FDV read', mcfdvRead],
                      ] as Array<[string,string]>
                      return items.map(([label, value]) => (
                        <div key={label} style={{ padding:'11px 12px', borderRadius:'10px', border:'1px solid rgba(103,232,249,0.16)', background:'rgba(8,14,28,0.62)' }}>
                          <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', fontFamily:'var(--font-plex-mono)', marginBottom:'4px' }}>{label}</div>
                          <div style={{ fontSize:'12px', color:'#e2e8f0', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{value}</div>
                        </div>
                      ))
                    })()}
                  </div>
                  {/* Market Insight Strip */}
                  {!result.noActivePools && (result.price != null || result.liquidity != null) && (
                    <div style={{ marginBottom: '20px', padding: '14px 18px', background: 'linear-gradient(135deg,rgba(103,232,249,0.05),rgba(45,212,191,0.03))', border: '1px solid rgba(103,232,249,0.18)', borderRadius: '14px', display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'center' }}>
                      <div style={{ flexShrink: 0 }}>
                        <div style={{ fontSize: '9px', letterSpacing: '.16em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>LIVE PRICE</div>
                        <div style={{ fontSize: '22px', fontWeight: 800, color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>{fmtPrice(result.price)}</div>
                      </div>
                      <div style={{ width: '1px', height: '32px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', flex: 1 }}>
                        {result.priceChange24h != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>24H MOVE</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: result.priceChange24h >= 0 ? '#34d399' : '#f87171', fontFamily: 'var(--font-plex-mono)' }}>{fmtPct(result.priceChange24h)}</div>
                          </div>
                        )}
                        {result.liquidity != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>LIQUIDITY</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{fmtLarge(result.liquidity)}</div>
                          </div>
                        )}
                        {result.volume24h != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>VOLUME 24H</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{fmtLarge(result.volume24h)}</div>
                          </div>
                        )}
                        {result.poolActivity?.pairAgeLabel != null && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>PAIR AGE</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>{result.poolActivity.pairAgeLabel}</div>
                          </div>
                        )}
                        {result.marketCapUsd != null && result.fdvUsd != null && result.fdvUsd > 0 && result.marketCapUsd !== result.fdvUsd && (
                          <div>
                            <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>MC / FDV</div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>{`${((result.marketCapUsd / result.fdvUsd) * 100).toFixed(0)}%`}</div>
                          </div>
                        )}
                        {(() => {
                          const volLiqRatio = result.volume24h != null && result.liquidity != null && result.liquidity > 0
                            ? result.volume24h / result.liquidity
                            : null
                          if (volLiqRatio == null) return null
                          const ratioColor = volLiqRatio > 3 ? '#f87171' : volLiqRatio > 1 ? '#fbbf24' : '#34d399'
                          return (
                            <div>
                              <div style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '2px' }}>VOL / LIQ</div>
                              <div style={{ fontSize: '14px', fontWeight: 700, color: ratioColor, fontFamily: 'var(--font-plex-mono)' }}>{volLiqRatio.toFixed(2)}x</div>
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )}
                  {(() => {
                    const volLiqRatio = result.volume24h != null && result.liquidity != null && result.liquidity > 0
                      ? result.volume24h / result.liquidity
                      : null
                    const volLiqRead = volLiqRatio == null
                      ? 'Volume/liquidity ratio unavailable.'
                      : volLiqRatio > 3
                        ? 'Volume is very high relative to liquidity — expect significant volatility and slippage.'
                        : volLiqRatio > 1
                          ? 'Volume is high relative to liquidity — expect volatility.'
                          : 'Healthy activity — volume is proportionate to liquidity depth.'
                    if (!result.noActivePools && (result.volume24h != null || result.liquidity != null)) {
                      return (
                        <div style={{ marginBottom: '16px', padding: '11px 14px', borderRadius: '10px', background: 'rgba(103,232,249,0.04)', border: '1px solid rgba(103,232,249,0.14)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '9px', letterSpacing: '.14em', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, flexShrink: 0 }}>VOL/LIQ READ</span>
                          <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5 }}>{volLiqRead}</span>
                          {volLiqRatio != null && <span style={{ marginLeft: 'auto', fontSize: '12px', fontWeight: 800, color: volLiqRatio > 3 ? '#f87171' : volLiqRatio > 1 ? '#fbbf24' : '#34d399', fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}>{volLiqRatio.toFixed(2)}x</span>}
                        </div>
                      )
                    }
                    return null
                  })()}
                  {result.noActivePools ? (
                    <div style={{ padding: '20px 22px', marginBottom: '28px', background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '12px', fontFamily: 'var(--font-plex-mono)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} />
                        <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: '#fbbf24', textTransform: 'uppercase' }}>No Active Pool Found</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '12px', color: '#b7a675', lineHeight: 1.55 }}>No liquidity pools were found for this contract on {result.chain === 'eth' ? 'Ethereum' : 'Base'}. Price, volume, and liquidity data are unavailable.</p>
                    </div>
                  ) : (
                    <>
                      {result.marketDataSource === 'fallback' && (
                        <div style={{ padding: '8px 14px', marginBottom: '12px', background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: '8px', fontFamily: 'var(--font-plex-mono)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8b5cf6', flexShrink: 0 }} />
                          <span style={{ fontSize: '10px', color: '#a78bfa', fontWeight: 700, letterSpacing: '0.08em' }}>CORTEX MARKET READ</span>
                          <span style={{ fontSize: '10px', color: '#475569' }}>Primary pool data unavailable — showing fallback market data. FDV is not market cap.</span>
                        </div>
                      )}
                      <div className="metric-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '10px', marginBottom: '28px' }}>
                        <StatCard label="Price" value={fmtPrice(result.price)} accent="#2DD4BF" helper={result.marketDataSource === 'fallback' ? 'Market read' : 'Primary pool'} />
                        <StatCard label="Liquidity" value={fmtLarge(result.liquidity)} helper="Pool depth" />
                        <StatCard label="Volume 24h" value={fmtLarge(result.volume24h)} helper="24h trading activity" />
                        <StatCard label="24h Change" value={fmtPct(result.priceChange24h)} accent={pctColor(result.priceChange24h)} helper="Price movement" />
                        {(() => {
                          const val = result.valuationContext
                          const fdvOnly = val?.primaryValuationStatus === 'fdv_only' && val?.primaryValuationUsd != null
                          return (
                            <StatCard
                              label={fdvOnly ? 'Valuation' : 'Market Cap'}
                              value={val?.primaryValuationStatus === 'verified_mc' ? fmtLarge(val.primaryValuationUsd) : fdvOnly ? `FDV ${fmtLarge(val.primaryValuationUsd)}` : 'Supply not confirmed'}
                              helper={val?.primaryValuationStatus === 'verified_mc' ? 'Verified live market data' : fdvOnly ? 'Market cap not verified live' : 'Live valuation not verified'}
                              accent="#a78bfa"
                            />
                          )
                        })()}
                        <StatCard label="FDV" value={result.fdvUsd != null ? fmtLarge(result.fdvUsd) : 'Unverified'} helper="Fully Diluted Valuation" accent="#a78bfa" />
                        <StatCard label="Pool Protocol" value={result.primaryDexName ?? 'Protocol not confirmed'} helper={result.primaryDexName ? 'Primary liquidity pool' : 'Pool found · protocol metadata missing'} accent={result.primaryDexName ? '#67e8f9' : '#64748b'} />
                      </div>
                    </>
                  )}
                  {result.marketCapStatus !== 'verified' && !result.noActivePools && (
                    <p style={{ marginTop: '-14px', marginBottom: '16px', color: '#94a3b8', fontSize: '12px' }}>Market cap unverified. FDV is shown separately.</p>
                  )}
                  {result.fdvUsd != null && result.marketCapUsd != null && result.marketCapUsd !== result.fdvUsd && (
                    <div style={{ marginBottom: '16px', padding: '10px 14px', background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.16)', borderRadius: '10px', fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>
                      <span style={{ color: '#a78bfa', fontWeight: 700 }}>MC vs FDV: </span>
                      {`Market cap ${fmtLarge(result.marketCapUsd)} reflects circulating supply. FDV ${fmtLarge(result.fdvUsd)} covers all tokens including locked and unvested. ${result.marketCapUsd / result.fdvUsd < 0.7 ? 'Significant unlock pressure possible.' : 'Low unlock pressure from current ratio.'}`}
                    </div>
                  )}
                  {result.chartStatus === 'ok' && result.priceChart && result.priceChart.points.length >= 2 && (
                    <div className="glass-card" style={{ marginBottom: '22px', borderRadius: '16px', padding: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline', marginBottom: '8px' }}>
                        <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '0.08em', color: '#cbd5e1', textTransform: 'uppercase' }}>Price Chart</p>
                        <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>{result.priceChart.fallbackUsed ? 'Live pool price action' : 'Primary pool price action'}</p>
                      </div>
                      <div style={{ display: 'inline-flex', marginBottom: '8px', border: '1px solid rgba(148,163,184,.3)', borderRadius: '999px', padding: '2px 8px', fontSize: '10px', color: '#cbd5e1' }}>
                        {result.priceChart.timeframe === '24h' ? '24H' : result.priceChart.timeframe === '48h' ? '48H' : '7D'}
                      </div>
                      <MiniPriceChart points={result.priceChart.points} />
                    </div>
                  )}
                  {result.chartStatus === 'no_candles' && (
                    <div className="glass-card" style={{ marginBottom: '22px', borderRadius: '16px', padding: '16px' }}>
                      <p style={{ margin: '0 0 6px', fontSize: '12px', fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase' }}>Price Chart</p>
                      <p style={{ margin: 0, fontSize: '12px', color: '#64748b', lineHeight: 1.6 }}>Historical candles are not available for this pool. Current price and market data are still live.</p>
                    </div>
                  )}
                  {result.chartStatus === 'fallback_snapshot_only' && (
                    <div className="glass-card" style={{ marginBottom: '22px', borderRadius: '16px', padding: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline', marginBottom: '12px' }}>
                        <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: '#2DD4BF', textTransform: 'uppercase' }}>Live Market Snapshot</p>
                        <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.10em', padding: '3px 9px', borderRadius: '99px', color: '#2DD4BF', background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.22)' }}>CORTEX MARKET READ</span>
                      </div>
                      <p style={{ margin: '0 0 14px', fontSize: '12px', color: '#64748b', lineHeight: 1.6 }}>Historical chart data is unavailable for this pool. Showing the latest live market snapshot instead.</p>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: '10px' }}>
                        <StatCard label="Price" value={fmtPrice(result.price)} />
                        <StatCard label="Liquidity" value={fmtLarge(result.liquidity)} />
                        <StatCard label="24H Volume" value={fmtLarge(result.volume24h)} />
                        <StatCard label="24H Change" value={fmtPct(result.priceChange24h)} accent={result.priceChange24h != null ? (result.priceChange24h >= 0 ? '#34d399' : '#f87171') : undefined} />
                        {result.poolActivity?.pairAgeLabel != null && <StatCard label="Pair Age" value={result.poolActivity.pairAgeLabel} />}
                        {result.fdv != null && <StatCard label="FDV" value={fmtLarge(result.fdv)} helper="Fully diluted valuation" />}
                      </div>
                    </div>
                  )}
                  {!result.noActivePools && result.marketDataSource !== 'fallback' && (
                    <div style={{ marginBottom: '28px' }}>
                      <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', marginBottom: '10px', fontFamily: 'var(--font-plex-mono)' }}>Pool Activity</p>
                      <div className="activity-grid">
                        <StatCard label="Transactions 24H" value={result.poolActivity?.transactions24h != null ? result.poolActivity.transactions24h.toLocaleString() : 'Activity unavailable'} helper="Primary pool activity" />
                        <StatCard label="Buys / Sells" value={result.poolActivity?.buys24h != null && result.poolActivity?.sells24h != null ? `${result.poolActivity.buys24h.toLocaleString()} / ${result.poolActivity.sells24h.toLocaleString()}` : 'Buy/sell split unavailable'} helper="24h pool flow" />
                        <StatCard label="Buy / Sell Vol" value={result.poolActivity?.buyVolume24hUsd != null && result.poolActivity?.sellVolume24hUsd != null ? `${fmtLarge(result.poolActivity.buyVolume24hUsd)} / ${fmtLarge(result.poolActivity.sellVolume24hUsd)}` : result.poolActivity?.volume24hUsd != null ? `Total ${fmtLarge(result.poolActivity.volume24hUsd)}` : 'Volume unavailable'} helper={result.poolActivity?.buyVolume24hUsd != null && result.poolActivity?.sellVolume24hUsd != null ? '24h buy/sell volume' : result.poolActivity?.volume24hUsd != null ? 'Buy/sell volume split not exposed' : '24h volume not exposed'} />
                        <StatCard label="Pair Age" value={result.poolActivity?.pairAgeLabel ?? 'Pool age unavailable'} helper={result.poolActivity?.pairAgeLabel != null ? 'Primary pool created' : 'Creation time not exposed'} />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── HOLDER MAP ────────────────────────────────────────── */}
              {activeSection === 'holder-map' && (() => {
                const holderState = deriveHolderState(result)
                const fallback = deriveHolderFallbackEvidence(result)
                return (
                  <>
                    <div style={{ marginBottom: '18px' }}>
                      <p style={{ margin: '0 0 3px', fontSize: '12px', fontWeight: 800, letterSpacing: '0.10em', color: '#a78bfa', fontFamily: 'var(--font-plex-mono)' }}>HOLDER MAP</p>
                      <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Top holder distribution and supply concentration analysis.</p>
                    </div>
                    {!planLoading && !isFullAccess && (
                      <div style={{ padding: '24px', border: '1px solid rgba(139,92,246,0.28)', borderRadius: '16px', background: 'rgba(139,92,246,0.06)', textAlign: 'center' }}>
                        <div style={{ fontSize: '22px', marginBottom: '10px' }}>🔒</div>
                        <p style={{ fontWeight: 700, color: '#f8fafc', margin: '0 0 6px', fontSize: '14px' }}>Holder Distribution</p>
                        <p style={{ color: '#94a3b8', fontSize: '12px', margin: '0 0 16px', lineHeight: 1.5 }}>Holder analytics are included in Pro and Elite.</p>
                        <a href="/pricing" style={{ display: 'inline-block', padding: '8px 20px', borderRadius: '999px', background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: '#fff', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}>Get Access</a>
                      </div>
                    )}
                    {!planLoading && isFullAccess && result.debugHolderStatus && (() => {
                      const d = result.debugHolderStatus!
                      return (
                        <details style={{ marginBottom: '12px', background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: '8px', padding: '8px 12px', fontSize: '10px', fontFamily: 'var(--font-plex-mono)' }}>
                          <summary style={{ cursor: 'pointer', color: '#fbbf24', letterSpacing: '0.10em', fontWeight: 700 }}>
                            Holder Debug · HTTP {d.statusCode ?? '?'} · items:{d.itemCount ?? '?'} norm:{d.normalizedCount ?? '?'}
                          </summary>
                          <table style={{ marginTop: '8px', borderCollapse: 'collapse', width: '100%' }}><tbody>
                            {([['providerCalled',String(d.providerCalled??'?')],['chain',d.chain??'?'],['statusCode',d.statusCode!=null?String(d.statusCode):'—'],['itemCount',d.itemCount!=null?String(d.itemCount):'—'],['normalizedCount',d.normalizedCount!=null?String(d.normalizedCount):'—'],['reason',d.reason??'—']] as [string,string][]).map(([k,v])=>(
                              <tr key={k}><td style={{paddingRight:'12px',color:'#78716c',whiteSpace:'nowrap'}}>{k}</td><td style={{color:'#d97706',wordBreak:'break-all'}}>{v}</td></tr>
                            ))}
                          </tbody></table>
                        </details>
                      )
                    })()}
                    {!planLoading && isFullAccess && (() => {
                      if (holderState.kind !== 'noRowsFallback') {
                        const top1h = result.holderDistribution?.top1
                        const top10h = result.holderDistribution?.top10
                        const top20h = result.holderDistribution?.top20
                        const holderCount = result.holderDistribution?.holderCount
                        const concRisk = top10h != null ? (top10h > 50 ? 'HIGH' : top10h > 30 ? 'MEDIUM' : 'LOW') : null
                        const concColor = concRisk === 'HIGH' ? '#f87171' : concRisk === 'MEDIUM' ? '#fbbf24' : concRisk === 'LOW' ? '#34d399' : '#94a3b8'
                        const concRead = holderState.kind === 'rowsWithPercent' && concRisk != null
                          ? concRisk === 'HIGH' ? 'High concentration — top holders control majority supply.' : concRisk === 'MEDIUM' ? 'Moderate concentration — watch for coordinated movement.' : 'Spread looks reasonable — no extreme concentration flagged.'
                          : null
                        const whalePressure = holderState.kind !== 'rowsWithPercent' || top10h == null
                          ? 'UNVERIFIED'
                          : top10h >= 70 ? 'EXTREME' : top10h >= 50 ? 'HIGH' : top10h >= 20 ? 'MEDIUM' : 'LOW'
                        const whalePressureColor = whalePressure === 'EXTREME' ? '#f87171' : whalePressure === 'HIGH' ? '#fb923c' : whalePressure === 'MEDIUM' ? '#fbbf24' : whalePressure === 'LOW' ? '#34d399' : '#94a3b8'
                        return (
                          <div className="holders-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                            {/* Whale Pressure Card */}
                            <div style={{ gridColumn:'1 / -1', marginBottom:'4px', padding:'14px 16px', borderRadius:'12px', background:'rgba(167,139,250,0.05)', border:`1px solid ${whalePressureColor}28` }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'12px', flexWrap:'wrap' }}>
                                <span style={{ fontSize:'9px', fontWeight:700, letterSpacing:'.16em', color:'#a78bfa', fontFamily:'var(--font-plex-mono)' }}>WHALE PRESSURE</span>
                                <span style={{ padding:'3px 10px', borderRadius:'999px', fontSize:'9px', fontWeight:800, letterSpacing:'.12em', color:whalePressureColor, background:`${whalePressureColor}12`, border:`1px solid ${whalePressureColor}40`, fontFamily:'var(--font-plex-mono)' }}>{whalePressure}</span>
                              </div>
                              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))', gap:'8px', marginBottom: (top10h != null && top10h > 50) || (top20h != null && top20h > 50) ? '10px' : '0' }}>
                                {[
                                  ['Top 1', top1h != null ? `${top1h.toFixed(1)}%` : 'N/A'],
                                  ['Top 10', top10h != null ? `${top10h.toFixed(1)}%` : 'N/A'],
                                  ['Top 20', top20h != null ? `${top20h.toFixed(1)}%` : 'N/A'],
                                  ['Holders', holderCount != null ? holderCount.toLocaleString() : 'N/A'],
                                ].map(([label, val]) => (
                                  <div key={label} style={{ padding:'8px 10px', borderRadius:'8px', background:'rgba(15,23,42,0.55)', border:'1px solid rgba(167,139,250,0.16)' }}>
                                    <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', marginBottom:'3px', fontFamily:'var(--font-plex-mono)' }}>{label}</div>
                                    <div style={{ fontSize:'12px', color:'#e2e8f0', fontWeight:800, fontFamily:'var(--font-plex-mono)' }}>{val}</div>
                                  </div>
                                ))}
                              </div>
                              {top10h != null && top10h > 50 && (
                                <div style={{ display:'flex', gap:'6px', alignItems:'flex-start', padding:'7px 10px', borderRadius:'8px', background:'rgba(248,113,113,0.06)', border:'1px solid rgba(248,113,113,0.18)' }}>
                                  <span style={{ color:'#f87171', fontSize:'11px', flexShrink:0 }}>!</span>
                                  <span style={{ fontSize:'11px', color:'#fca5a5', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>Top wallets control majority supply.</span>
                                </div>
                              )}
                              {top20h != null && top20h > 50 && !(top10h != null && top10h > 50) && (
                                <div style={{ display:'flex', gap:'6px', alignItems:'flex-start', padding:'7px 10px', borderRadius:'8px', background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.18)' }}>
                                  <span style={{ color:'#fbbf24', fontSize:'11px', flexShrink:0 }}>!</span>
                                  <span style={{ fontSize:'11px', color:'#fde68a', fontFamily:'var(--font-plex-mono)', lineHeight:1.5 }}>Watch for coordinated holder movement.</span>
                                </div>
                              )}
                            </div>
                            <div style={{ gridColumn:'1 / -1', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))', gap:'8px' }}>
                              {[
                                ['Holder Risk', concRisk ?? 'Unverified'],
                                ['Top 10 Control', top10h != null ? `${top10h.toFixed(1)}%` : 'Unverified'],
                                ['Top 20 Control', top20h != null ? `${top20h.toFixed(1)}%` : 'Unverified'],
                                ['Holder Count', holderCount != null ? holderCount.toLocaleString() : 'Unverified'],
                                ['Supply Spread', concRead ?? 'Supply spread unverified'],
                              ].map(([label,val])=>(
                                <div key={label} style={{ padding:'10px 11px', borderRadius:'10px', border:'1px solid rgba(167,139,250,0.22)', background:'rgba(15,23,42,0.55)' }}>
                                  <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', marginBottom:'4px', fontFamily:'var(--font-plex-mono)' }}>{label}</div>
                                  <div style={{ fontSize:'11px', color:'#e2e8f0', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{val}</div>
                                </div>
                              ))}
                            </div>
                            <div className="glass-card" style={{ padding: '18px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                                <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>HOLDER CONCENTRATION</p>
                                <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: `1px solid ${holderState.kind === 'rowsWithPercent' ? 'rgba(45,212,191,.5)' : 'rgba(251,191,36,.4)'}`, color: holderState.kind === 'rowsWithPercent' ? '#2dd4bf' : '#fbbf24', background: holderState.kind === 'rowsWithPercent' ? 'rgba(45,212,191,.1)' : 'rgba(251,191,36,.1)' }}>{holderState.kind === 'rowsWithPercent' ? 'VERIFIED' : 'PARTIAL'}</span>
                                {concRisk != null && <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: `1px solid ${concColor}44`, color: concColor, background: `${concColor}10` }}>{concRisk} CONC</span>}
                              </div>
                              {result.holderDistribution?.holderCount != null && <div style={{ margin: '0 0 12px', fontSize: '13px', color: '#67e8f9', border: '1px solid rgba(45,212,191,.3)', background: 'rgba(6,78,59,.16)', padding: '8px 10px', borderRadius: '10px', display: 'inline-flex', gap: '8px' }}><span style={{ color: '#99f6e4' }}>Holder count</span><strong style={{ fontFamily: 'var(--font-plex-mono)', color: '#e6fffa' }}>{result.holderDistribution.holderCount.toLocaleString()}</strong></div>}
                              {holderState.kind === 'rowsWithoutPercent' && <p style={{ margin: '0 0 10px', fontSize: '11px', color: '#fbbf24' }}>Holder rows found — concentration percentages unavailable. Addresses and amounts shown below.</p>}
                              {holderState.kind === 'rowsWithPercent' && <div style={{ display: 'grid', gap: '10px' }}>
                                {[['Top 1',result.holderDistribution?.top1],['Top 5',result.holderDistribution?.top5],['Top 10',result.holderDistribution?.top10],['Top 20',result.holderDistribution?.top20]].map(([l,v])=>(
                                  <div key={String(l)} style={{ display: 'grid', gridTemplateColumns: '82px 1fr 64px', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ fontSize: '12px', color: '#d6e6f3', fontWeight: 700 }}>{l}</span>
                                    <div style={{ height: '12px', borderRadius: '999px', background: 'linear-gradient(90deg,rgba(30,41,59,.9),rgba(51,65,85,.5))', border: '1px solid rgba(148,163,184,.25)' }}><div style={{ height: '100%', width: `${v==null?0:Math.max(0,Math.min(100,Number(v)))}%`, borderRadius: '999px', background: 'linear-gradient(90deg,#2dd4bf,#a855f7)', boxShadow: '0 0 14px rgba(45,212,191,.28)' }} /></div>
                                    <span style={{ fontSize: '13px', fontWeight: 800, color: '#eef6ff', textAlign: 'right', fontFamily: 'var(--font-plex-mono)' }}>{v==null?'N/A':`${Number(v).toFixed(1)}%`}</span>
                                  </div>
                                ))}
                              </div>}
                              {(top10h != null && top10h > 50) && (
                                <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#fca5a5', lineHeight: 1.5, border: '1px solid rgba(248,113,113,0.28)', background: 'rgba(248,113,113,0.08)', borderRadius: '10px', padding: '8px 10px' }}>
                                  High concentration — top wallets control majority supply.
                                </p>
                              )}
                              {(top1h != null && top1h > 20) && (
                                <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#fecaca', lineHeight: 1.5, border: '1px solid rgba(248,113,113,0.22)', background: 'rgba(248,113,113,0.06)', borderRadius: '10px', padding: '8px 10px' }}>
                                  Largest holder has meaningful supply control.
                                </p>
                              )}
                              {holderState.kind === 'rowsWithPercent' && top10h != null && <p style={{ margin: '10px 0 0', fontSize: '11px', color: concColor, lineHeight: 1.5 }}>{`Top 10 controls ${top10h.toFixed(1)}%. Monitor concentration before trusting supply distribution.`}</p>}
                              <p style={{ margin: '8px 0 0', fontSize: '11px', color: '#8aa3b8' }}>{holderState.kind === 'rowsWithPercent' ? 'Top holder concentration from live holder data' : 'Holder distribution based on available live holder rows'}</p>
                            </div>
                            <div className="glass-card" style={{ padding: '18px', minWidth: 0, overflow: 'hidden' }}>
                              <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', marginBottom: '4px', fontFamily: 'var(--font-plex-mono)' }}>TOP HOLDERS</p>
                              <p style={{ margin: '0 0 10px', fontSize: '11px', color: '#8aa3b8' }}>Top 10 holders</p>
                              <div className="top-holder-head" style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 88px 62px', gap: '10px', fontSize: '10px', letterSpacing: '0.10em', color: '#6a8198', marginBottom: '8px', fontFamily: 'var(--font-plex-mono)' }}><span>#</span><span>WALLET</span><span style={{ textAlign: 'right' }}>AMOUNT</span><span style={{ textAlign: 'right' }}>%</span></div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px', overflowY: 'auto', paddingRight: '3px' }}>
                                {holderState.rows.slice(0,20).map((h)=>(
                                  <div className="top-holder-row" key={h.rank+h.address} style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr) 88px 62px', gap: '10px', alignItems: 'center', padding: '10px', border: '1px solid rgba(148,163,184,.18)', borderRadius: '10px', background: 'rgba(15,23,42,.45)' }}>
                                    <span style={{ fontSize: '11px', color: '#dbeafe', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, display: 'inline-flex', justifyContent: 'center', padding: '2px 0', borderRadius: '999px', background: h.rank<=3?'linear-gradient(90deg,rgba(45,212,191,.28),rgba(168,85,247,.28))':'transparent', border: h.rank<=3?'1px solid rgba(167,139,250,.45)':'none' }}>{h.rank}</span>
                                    <span className="top-holder-mobile-meta" style={{ fontSize: '12px', color: '#c5d8ea', fontFamily: 'var(--font-plex-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shorten(h.address)}<span style={{ display: 'none', fontSize: '12px', fontWeight: 800, color: h.percent!=null&&h.percent>=10?'#fb7185':h.percent!=null&&h.percent>=5?'#fbbf24':'#67e8f9' }}>{h.percent==null?'—':`${h.percent.toFixed(2)}%`}</span></span>
                                    <span className="top-holder-mobile-amt" style={{ fontSize: '12px', color: '#e5eef9', textAlign: 'right', fontFamily: 'var(--font-plex-mono)' }}>{fmtTokenAmt(h.amount,result.decimals??18)}</span>
                                    <span style={{ fontSize: '12px', fontWeight: 800, textAlign: 'right', fontFamily: 'var(--font-plex-mono)', color: h.percent!=null&&h.percent>=10?'#fb7185':h.percent!=null&&h.percent>=5?'#fbbf24':'#67e8f9' }}>{h.percent==null?'—':`${h.percent.toFixed(2)}%`}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )
                      }
                      const fb = buildHolderFallbackRead(fallback)
                      const lpS = result.lpControl?.status
                      const lpV = lpS === 'locked' || lpS === 'burned'
                      const hpV = result.honeypot?.simulationSuccess === true
                      const evItems: Array<{label:string;value:string;ok:boolean}> = [
                        { label: 'Market data',         value: result.price!=null?'Available':'Unavailable',                   ok: result.price!=null },
                        { label: 'Liquidity depth',     value: fallback.liquidityDepth!=null?fmtLarge(fallback.liquidityDepth):'Unverified', ok: fallback.liquidityDepth!=null },
                        { label: 'Pool count',          value: fallback.poolCount>0?String(fallback.poolCount):'Unverified',    ok: fallback.poolCount>0 },
                        { label: 'LP control',          value: lpV?'Verified':'Unverified',                                   ok: lpV },
                        { label: 'Owner status',        value: fallback.ownerStatus,                                           ok: fallback.ownerStatus==='Renounced' },
                        { label: 'Security simulation', value: hpV?'Verified':'Unverified',                                   ok: hpV },
                      ]
                      return (
                        <div style={{ marginBottom: '20px', background: 'linear-gradient(160deg,rgba(12,10,4,.72),rgba(4,8,18,.88))', border: '1px solid rgba(251,191,36,.22)', borderRadius: '14px', padding: '18px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                            <p style={{ fontSize: '12px', fontWeight: 800, letterSpacing: '0.12em', color: '#8fb3d0', margin: 0, fontFamily: 'var(--font-plex-mono)' }}>HOLDER CONCENTRATION</p>
                            <span style={{ padding: '2px 7px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', fontFamily: 'var(--font-plex-mono)', border: '1px solid rgba(251,191,36,.4)', color: '#fbbf24', background: 'rgba(251,191,36,.08)' }}>UNVERIFIED</span>
                          </div>
                          <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#fde68a', lineHeight: 1.5 }}>Holder distribution was not returned in this scan. Supply concentration remains an open risk check.</p>
                          <div className="intel-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '8px', marginBottom: '14px' }}>
                            {evItems.map(({label,value,ok})=>(
                              <div key={label} style={{ padding: '9px 10px', borderRadius: '10px', background: 'rgba(15,23,42,0.42)', border: `1px solid ${ok?'rgba(52,211,153,.22)':value==='Unverified'?'rgba(251,191,36,.22)':'rgba(248,113,113,.22)'}` }}>
                                <div style={{ fontSize: '9px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '3px' }}>{label}</div>
                                <div style={{ fontSize: '11px', fontWeight: 700, color: ok?'#34d399':value==='Unverified'?'#fbbf24':'#f87171', fontFamily: 'var(--font-plex-mono)' }}>{value}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(15,23,42,.5)', border: '1px solid rgba(125,211,252,.15)', marginBottom: '10px' }}>
                            <div style={{ fontSize: '9px', letterSpacing: '.1em', color: '#7dd3fc', fontFamily: 'var(--font-plex-mono)', marginBottom: '5px' }}>CORTEX READ</div>
                            <p style={{ margin: 0, fontSize: '11px', color: '#b7c9da', lineHeight: 1.6 }}>{fb.read}</p>
                          </div>
                          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Rescan later and monitor holder distribution before trusting supply spread.</p>
                        </div>
                      )
                    })()}
                  </>
                )
              })()}

              {/* ── LP CONTROL ────────────────────────────────────────── */}
              {activeSection === 'lp-control' && (
                <>
                  <div style={{ marginBottom: '18px' }}>
                    <p style={{ margin: '0 0 3px', fontSize: '13px', fontWeight: 800, letterSpacing: '0.10em', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>LP CONTROL</p>
                    <p style={{ margin: 0, fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>Liquidity pool lock status, primary pool, and pool board.</p>
                  </div>
                  {/* Exit Risk Read card — always visible */}
                  {(() => {
                    const lpS = result.lpControl?.status
                    const lpVerifiedExit = lpS === 'locked' || lpS === 'burned'
                    const liqDepth = result.liquidity ?? null
                    const primaryPool = result.pools?.[0]?.name ?? result.primaryDexName ?? null
                    const exitRisk = result.noActivePools
                      ? 'CRITICAL'
                      : !lpVerifiedExit
                        ? liqDepth != null && liqDepth < 50_000 ? 'HIGH' : 'ELEVATED'
                        : liqDepth != null && liqDepth < 50_000 ? 'MEDIUM' : 'LOW'
                    const exitRiskColor = exitRisk === 'CRITICAL' ? '#f87171' : exitRisk === 'HIGH' ? '#fb923c' : exitRisk === 'ELEVATED' ? '#fbbf24' : exitRisk === 'MEDIUM' ? '#a78bfa' : '#34d399'
                    const exitRead = result.noActivePools
                      ? 'No active liquidity pool detected — exit risk cannot be assessed.'
                      : (!lpVerifiedExit && (lpS === 'protocol' || lpS === 'concentrated_liquidity'))
                        ? 'Protocol-managed liquidity detected. Lock/burn proof requires protocol-specific verification.'
                        : !lpVerifiedExit
                          ? 'Liquidity exists, but lock/burn proof is not confirmed. Treat exit liquidity as unprotected.'
                          : lpS === 'burned'
                            ? 'LP tokens burned — liquidity is permanently locked. Exit liquidity is protected.'
                            : 'LP locked — exit liquidity is protected for the lock duration.'
                    return (
                      <div style={{ marginBottom: '18px', padding: '14px 16px', borderRadius: '12px', background: `${exitRiskColor}08`, border: `1px solid ${exitRiskColor}28` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>EXIT RISK READ</span>
                          <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '.12em', color: exitRiskColor, background: `${exitRiskColor}14`, border: `1px solid ${exitRiskColor}40`, fontFamily: 'var(--font-plex-mono)' }}>{exitRisk}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: '8px', marginBottom: '10px' }}>
                          {[
                            ['LP Proof', lpVerifiedExit ? (lpS === 'burned' ? 'Burned' : 'Locked') : lpS === 'protocol' || lpS === 'concentrated_liquidity' ? 'Protocol LP' : 'Unverified'],
                            ['Liquidity Depth', liqDepth != null ? fmtLarge(liqDepth) : 'Unverified'],
                            ['Primary Pool', primaryPool ?? 'Unverified'],
                            ['Exit Risk', exitRisk],
                          ].map(([label, val]) => (
                            <div key={label} style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(52,211,153,0.12)' }}>
                              <div style={{ fontSize: '9px', letterSpacing: '.12em', color: '#64748b', marginBottom: '3px', fontFamily: 'var(--font-plex-mono)' }}>{label}</div>
                              <div style={{ fontSize: '11px', color: '#e2e8f0', fontWeight: 700, fontFamily: 'var(--font-plex-mono)' }}>{val}</div>
                            </div>
                          ))}
                        </div>
                        <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.55 }}>{exitRead}</p>
                      </div>
                    )
                  })()}
                  {!planLoading && !isFullAccess && (
                    <div style={{ padding: '24px', border: '1px solid rgba(139,92,246,0.28)', borderRadius: '16px', background: 'rgba(139,92,246,0.06)', textAlign: 'center', marginBottom: '18px' }}>
                      <div style={{ fontSize: '22px', marginBottom: '10px' }}>🔒</div>
                      <p style={{ fontWeight: 700, color: '#f8fafc', margin: '0 0 6px', fontSize: '14px' }}>LP Control Analysis</p>
                      <p style={{ color: '#94a3b8', fontSize: '12px', margin: '0 0 16px', lineHeight: 1.5 }}>LP control checks are included in Pro and Elite.</p>
                      <a href="/pricing" style={{ display: 'inline-block', padding: '8px 20px', borderRadius: '999px', background: 'linear-gradient(135deg,#7c3aed,#a855f7)', color: '#fff', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}>Get Access</a>
                    </div>
                  )}
                  {!planLoading && isFullAccess && result.lpControl && (() => {
                    const lp = result.lpControl
                    const read = result.lpControlRead
                    const lpIsVerified = lp.status === 'locked' || lp.status === 'burned'
                    const statusColor: Record<string,string> = { burned:'#34d399',locked:'#60a5fa',protocol:'#f59e0b',concentrated_liquidity:'#a855f7',team_controlled:'#f87171',unverified:'#94a3b8',insufficient_data:'#94a3b8',error:'#f87171' }
                    const color = statusColor[lp.status??'unverified']??'#94a3b8'
                    const statusLabelMap: Record<string,string> = { burned:'Burned',locked:'Locked',protocol:'Protocol',concentrated_liquidity:'Concentrated liquidity',team_controlled:'Team controlled',unverified:'Unverified',insufficient_data:'Insufficient data',error:'Unverified' }
                    const evidence = Array.isArray(lp.evidence)?lp.evidence:[]
                    const verificationPool = evidenceValue(evidence,'Verification pool')??read?.whatWasFound?.find((x)=>/^Pair:/i.test(x))?.replace(/^Pair:\s*/i,'')??'Unverified'
                    const evidenceText = evidence.join(' ').toLowerCase()
                    const fallbackChecked: string[] = []
                    if (lp.poolAddressPresent||evidenceText.includes('verification pool')) fallbackChecked.push('Pool detected')
                    if (verificationPool!=='Unverified') fallbackChecked.push('Primary market selected')
                    fallbackChecked.push('Liquidity scan completed')
                    if (lp.status!=='error'&&lp.status!=='unverified'?true:lp.poolAddressPresent) fallbackChecked.push('Pool structure reviewed')
                    const checked = ((read?.whatWasFound??[]).filter((x)=>!/^Pair:/i.test(x)).length?(read?.whatWasFound??[]).filter((x)=>!/^Pair:/i.test(x)):fallbackChecked).filter((v,i,arr)=>arr.indexOf(v)===i)
                    const unresolved = read?.couldNotVerify?.length?read.couldNotVerify:['Holder concentration unverified','Contract ownership unverified',lp.status==='protocol' || lp.status==='concentrated_liquidity'?'Protocol-specific LP proof':'LP lock or burn proof']
                    const riskRead = read?.meaning??(lp.status==='protocol' || lp.status==='concentrated_liquidity'?'Protocol liquidity detected — requires protocol-specific verification.':lp.poolAddressPresent?'Liquidity exists, but LP lock/control could not be proven from current checks.':'No active liquidity pool found.')
                    const nextAction = read?.nextAction??'Treat LP control as unverified until locker, burn-address, or protocol-specific proof is found.'
                    return (
                      <div style={{ marginBottom: '18px', border: '1px solid rgba(148,163,184,0.2)', borderRadius: '12px', overflow: 'hidden', fontSize: '12px', background: 'linear-gradient(180deg,rgba(15,23,42,0.72),rgba(2,6,23,0.62))', backdropFilter: 'blur(5px)' }}>
                        <div style={{ padding:'11px 12px', borderBottom:'1px solid rgba(255,255,255,0.06)', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:'8px' }}>
                          {[
                            ['Pool detected', lp.poolAddressPresent ? 'Yes' : 'No'],
                            ['Primary market selected', verificationPool !== 'Unverified' ? 'Yes' : 'No'],
                            ['LP lock/burn proof', lpIsVerified ? 'Verified' : 'Unverified'],
                            ['Protocol-specific proof', lp.status === 'protocol' || lp.status === 'concentrated_liquidity' ? 'Required' : 'N/A'],
                            ['Next action', nextAction],
                          ].map(([k,v])=>(
                            <div key={String(k)} style={{ padding:'8px 9px', border:'1px solid rgba(148,163,184,0.18)', borderRadius:'9px', background:'rgba(8,14,28,0.55)' }}>
                              <div style={{ fontSize:'9px', color:'#64748b', fontFamily:'var(--font-plex-mono)', marginBottom:'4px' }}>{k}</div>
                              <div style={{ fontSize:'11px', color:'#e2e8f0', fontFamily:'var(--font-plex-mono)' }}>{v}</div>
                            </div>
                          ))}
                        </div>
                        <button type="button" onClick={()=>setLpExpanded((v)=>!v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', background: 'rgba(255,255,255,0.03)', border: 'none', borderBottom: lpExpanded?'1px solid rgba(255,255,255,0.06)':'none', cursor: 'pointer', textAlign: 'left' }}>
                          <span style={{ width:7,height:7,borderRadius:'50%',background:color,flexShrink:0,boxShadow:`0 0 6px ${color}` }} />
                          <span style={{ fontWeight:700,color:'#f8fafc',fontSize:'13px' }}>LP Status: {statusLabelMap[lp.status??'unverified']??'Unverified'}</span>
                          {read?.riskLevel&&<span style={{ marginLeft:'auto',fontSize:'10px',color:'#94a3b8',letterSpacing:'0.05em' }}>{read.riskLevel}</span>}
                          <span style={{ fontSize:'10px',color:'#cbd5e1',letterSpacing:'0.06em' }}>Details {lpExpanded?'▾':'▸'}</span>
                        </button>
                        {lpExpanded&&(
                          <div style={{ transition:'all 160ms ease' }}>
                            <div style={{ padding:'9px 14px',color:'#dbeafe',lineHeight:1.55 }}><span style={{ color:'#f8fafc',fontWeight:600 }}>Risk read:</span> {riskRead}</div>
                            <div style={{ padding:'0 14px 8px' }}>
                              <div style={{ fontSize:'10px',color:'#94a3b8',letterSpacing:'0.08em',textTransform:'uppercase' }}>Verified checks</div>
                              <div style={{ marginTop:'3px',color:'#f8fafc',fontWeight:600 }}>{checked.join(' · ') || 'No verified checks returned'}</div>
                            </div>
                            <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:'8px',padding:'6px 12px 8px',borderTop:'1px solid rgba(255,255,255,0.05)' }}>
                              <div style={{ padding:'8px 10px',border:'1px solid rgba(52,211,153,0.16)',borderRadius:'10px',background:'rgba(15,23,42,0.36)' }}>
                                <div style={{ fontSize:'10px',color:'#64748b',letterSpacing:'0.08em',marginBottom:'4px',textTransform:'uppercase' }}>LP verification pool</div>
                                <div style={{ color:'#e2e8f0' }}>{verificationPool}</div>
                              </div>
                              <div style={{ padding:'8px 10px',border:'1px solid rgba(245,158,11,0.2)',borderRadius:'10px',background:'rgba(245,158,11,0.08)' }}>
                                <div style={{ fontSize:'10px',color:'#fbbf24',letterSpacing:'0.08em',marginBottom:'4px',textTransform:'uppercase' }}>Open checks</div>
                                <div style={{ fontSize:'11px',color:'#fde68a',marginBottom:'6px' }}>LP ownership could not be verified this scan.</div>
                                {unresolved.map((f,i)=><div key={i} style={{ color:'#f8fafc',display:'flex',gap:'6px' }}><span style={{ color:'#f59e0b' }}>✕</span>{f}</div>)}
                              </div>
                            </div>
                            <div style={{ padding:'10px 14px 12px',borderTop:'1px solid rgba(255,255,255,0.05)',color:'#cbd5e1' }}><span style={{ color:'#94a3b8' }}>Next action:</span> {nextAction}</div>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                  {!planLoading && isFullAccess && !result.lpControl && (
                    <div style={{ padding:'14px 18px',marginBottom:'18px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:'10px',fontSize:'12px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>LP control data was not returned in this scan.</div>
                  )}
                  {result.pools && result.pools.length > 0 && (
                    <>
                      <div style={{ display:'flex',alignItems:'baseline',gap:'10px',marginBottom:'10px',flexWrap:'wrap' }}>
                        <p style={{ fontSize:'10px',fontWeight:700,letterSpacing:'0.14em',color:'#3a5268',textTransform:'uppercase',margin:0,fontFamily:'var(--font-plex-mono)' }}>LIQUIDITY &amp; POOLS</p>
                        <div style={{ display:'inline-flex',padding:'3px 9px',borderRadius:'999px',border:'1px solid rgba(125,211,252,.3)',color:'#67e8f9',fontSize:'10px',fontFamily:'var(--font-plex-mono)' }}>{result.pools.length} {result.pools.length===1?'POOL':'POOLS'}</div>
                        <span style={{ fontSize:'11px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>Primary pool selected by liquidity.</span>
                      </div>
                      <div className="pools-scroll" style={{ overflowX:'auto',paddingBottom:'6px',maxWidth:'100%' }}>
                        <div className="pools-inner" style={{ display:'flex',flexDirection:'column',gap:'6px',minWidth:'940px' }}>
                          {[...result.pools].sort((a,b)=>(b.liquidity??0)-(a.liquidity??0)).slice(0,8).map((pool,i)=>(
                            <div key={i} style={{ display:'grid',gridTemplateColumns:'minmax(220px,1.2fr) repeat(6,minmax(82px,auto))',alignItems:'center',gap:'20px',padding:'12px 18px',background:i===0?'linear-gradient(90deg,rgba(45,212,191,0.06),rgba(167,139,250,0.04))':'rgba(255,255,255,0.025)',border:i===0?'1px solid rgba(45,212,191,0.22)':'1px solid rgba(255,255,255,0.06)',borderRadius:'10px',fontSize:'12px',fontFamily:'var(--font-plex-mono)' }}>
                              <span style={{ color:i===0?'#2DD4BF':'#94a3b8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',display:'flex',alignItems:'center',gap:'7px' }}>
                                {i===0&&<span style={{ fontSize:'9px',fontWeight:700,letterSpacing:'.10em',padding:'1px 6px',borderRadius:'999px',border:'1px solid rgba(45,212,191,.35)',color:'#2DD4BF',background:'rgba(45,212,191,.08)',flexShrink:0 }}>PRIMARY</span>}
                                {pool.name??shorten(pool.address??'')}
                              </span>
                              <span style={{ color:'#2DD4BF',whiteSpace:'nowrap' }}>{fmtPrice(pool.price)}</span>
                              <span style={{ color:'#4a6272',whiteSpace:'nowrap' }}>Liq {fmtLarge(pool.liquidity)}</span>
                              <span style={{ color:'#4a6272',whiteSpace:'nowrap' }}>Vol {fmtLarge(pool.volume24h)}</span>
                              <span style={{ color:'#64748b',whiteSpace:'nowrap' }}>APR N/A</span>
                              <span style={{ color:pctColor(pool.priceChange24h),whiteSpace:'nowrap' }}>{fmtPct(pool.priceChange24h)}</span>
                              <span style={{ whiteSpace:'nowrap',color:(pool.liquidity??0)>200000?'#34d399':(pool.liquidity??0)>50000?'#67e8f9':'#fbbf24' }}>{(pool.liquidity??0)>200000?'Excellent':(pool.liquidity??0)>50000?'Healthy':'Weak'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  {(!result.pools||result.pools.length===0)&&(
                    <div style={{ padding:'14px 18px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:'10px',fontSize:'12px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>No pools found for this token.</div>
                  )}
                </>
              )}

              {/* ── RISK CHECKS ───────────────────────────────────────── */}
              {activeSection === 'risk-checks' && (
                <>
                  <div style={{ marginBottom: '18px' }}>
                    <p style={{ margin:'0 0 3px',fontSize:'12px',fontWeight:800,letterSpacing:'0.10em',color:'#f87171',fontFamily:'var(--font-plex-mono)' }}>RISK CHECKS</p>
                    <p style={{ margin:0,fontSize:'11px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>Security simulation, contract flags, and ownership checks.</p>
                  </div>
                  {!planLoading && !isFullAccess && (
                    <div style={{ padding:'24px',border:'1px solid rgba(139,92,246,0.28)',borderRadius:'16px',background:'rgba(139,92,246,0.06)',textAlign:'center' }}>
                      <div style={{ fontSize:'22px',marginBottom:'10px' }}>🔒</div>
                      <p style={{ fontWeight:700,color:'#f8fafc',margin:'0 0 6px',fontSize:'14px' }}>Full Risk Analysis</p>
                      <p style={{ color:'#94a3b8',fontSize:'12px',margin:'0 0 16px',lineHeight:1.5 }}>Security checks are included in Pro and Elite.</p>
                      <a href="/pricing" style={{ display:'inline-block',padding:'8px 20px',borderRadius:'999px',background:'linear-gradient(135deg,#7c3aed,#a855f7)',color:'#fff',fontWeight:700,fontSize:'12px',textDecoration:'none' }}>Get Access</a>
                    </div>
                  )}
                  {!planLoading && isFullAccess && (() => {
                    const gp = result.contractSecurity&&result.contract?(result.contractSecurity[result.contract.toLowerCase()]??null) as Record<string,unknown>|null:null
                    const hp = result.honeypot
                    const simVerified = hp?.simulationSuccess===true
                    type RC = { label:string;value:string;style:PillStyle }
                    const simGroup: RC[] = simVerified&&hp ? [
                      { label:'Honeypot', value:hp.isHoneypot?'YES':'NO', style:hp.isHoneypot?pillDanger():pillSafe() },
                      ...(hp.buyTax!=null?[{ label:'Buy Tax', value:`${hp.buyTax.toFixed(1)}%`, style:taxPct(hp.buyTax) }]:[]),
                      ...(hp.sellTax!=null?[{ label:'Sell Tax', value:`${hp.sellTax.toFixed(1)}%`, style:taxPct(hp.sellTax) }]:[]),
                      ...(hp.transferTax!=null&&hp.transferTax>0?[{ label:'Transfer Tax', value:`${hp.transferTax.toFixed(1)}%`, style:taxPct(hp.transferTax) }]:[]),
                    ] : []
                    function gpFlag(key:string,label:string,dangerOn='1'):RC|null{if(!gp)return null;const raw=gp[key];if(raw==null)return null;const v=String(raw);return{label,value:v==='1'?'YES':v==='0'?'NO':v,style:v===dangerOn?pillDanger():pillSafe()}}
                    function gpTax(key:string,label:string):RC|null{if(!gp)return null;const raw=gp[key];if(raw==null)return null;const n=parseFloat(String(raw));if(isNaN(n))return null;return{label,value:`${(n*100).toFixed(1)}%`,style:taxPct(n*100)}}
                    const contractGroup:RC[]=[gpFlag('is_mintable','Mint Function'),gpFlag('can_take_back_ownership','Ownership Revert'),gpFlag('is_blacklisted','Blacklist'),gpFlag('is_whitelisted','Whitelist','__never__'),gpFlag('is_proxy','Proxy','__never__'),gpTax('buy_tax','Buy Tax'),gpTax('sell_tax','Sell Tax')].filter((x):x is RC=>x!=null)
                    const ownerAddr=gp?String(gp['owner_address']??''):''
                    const isRenounced=!ownerAddr||ownerAddr==='0x0000000000000000000000000000000000000000'
                    const ownerGroup:RC[]=gp?[{label:'Owner',value:isRenounced?'RENOUNCED':'HELD',style:isRenounced?pillSafe():pillAmber()}]:[]
                    const hasAny=gp||(hp&&hp.simulationSuccess)
                    if(!hasAny)return(
                      <div style={{ padding:'16px 18px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:'10px',fontSize:'12px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>No security simulation data surfaced for this scan. Tax simulation unavailable — status is unverified.</div>
                    )
                    const gs={marginBottom:'14px'}
                    const gt={margin:'0 0 8px',fontSize:'9px',fontWeight:700 as const,letterSpacing:'.16em',color:'#3a5268',textTransform:'uppercase' as const,fontFamily:'var(--font-plex-mono)'}
                    // Open risks: checks that could not be verified
                    const riskHolderState = deriveHolderState(result)
                    const riskLpStatus = result.lpControl?.status
                    const riskLpVerified = riskLpStatus === 'locked' || riskLpStatus === 'burned'
                    const openRisks: string[] = [
                      !simVerified ? 'Tax simulation unavailable — buy/sell tax unverified.' : null,
                      riskHolderState.kind!=='rowsWithPercent' ? 'Holder concentration not confirmed this scan.' : null,
                      !riskLpVerified ? 'LP lock or burn proof not confirmed.' : null,
                      result.marketCapUsd==null ? 'Circulating supply not confirmed — market cap unverified.' : null,
                    ].filter((x):x is string=>x!=null)
                    return(
                      <div>
                        <div style={{ marginBottom:'12px', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))', gap:'8px' }}>
                          {[
                            ['Simulation status', simVerified ? 'Verified' : 'Unverified'],
                            ['Tax verification', simVerified ? 'Verified from simulation' : 'Open check'],
                            ['Owner status', ownerGroup[0]?.value ?? 'Unverified'],
                            ['Contract flags', contractGroup.length > 0 ? `${contractGroup.length} checks surfaced` : 'Unverified'],
                            ['Open risks', openRisks.length > 0 ? `${openRisks.length} open` : 'None'],
                          ].map(([label,value])=>(
                            <div key={String(label)} style={{ padding:'10px 11px', border:'1px solid rgba(248,113,113,0.16)', borderRadius:'10px', background:'rgba(8,14,28,0.6)' }}>
                              <div style={{ fontSize:'9px', letterSpacing:'.12em', color:'#64748b', marginBottom:'4px', fontFamily:'var(--font-plex-mono)' }}>{label}</div>
                              <div style={{ fontSize:'11px', color:'#f1f5f9', fontWeight:700, fontFamily:'var(--font-plex-mono)' }}>{value}</div>
                            </div>
                          ))}
                        </div>
                        <div style={gs}>
                          <div style={{ padding:'14px 16px',background:'rgba(8,14,28,.65)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'12px' }}>
                            <div style={{ display:'flex',alignItems:'center',gap:'8px',marginBottom:'10px',flexWrap:'wrap' }}>
                              <p style={gt}>Trading Simulation</p>
                              <span style={{ padding:'2px 7px',borderRadius:'999px',fontSize:'9px',fontWeight:700,letterSpacing:'.1em',fontFamily:'var(--font-plex-mono)',border:simVerified?'1px solid rgba(52,211,153,.35)':'1px solid rgba(251,191,36,.35)',color:simVerified?'#34d399':'#fbbf24',background:simVerified?'rgba(52,211,153,.08)':'rgba(251,191,36,.08)' }}>{simVerified?'SIMULATION VERIFIED':'SIMULATION NOT RUN'}</span>
                            </div>
                            {simVerified&&simGroup.length>0?(
                              <div style={{ display:'flex',flexWrap:'wrap',gap:'7px' }}>{simGroup.map(c=><RiskPill key={c.label} label={c.label} value={{...c.style,label:c.value}} />)}</div>
                            ):(
                              <p style={{ margin:0,fontSize:'11px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>Tax simulation unavailable — honeypot and tax status could not be verified this pass.</p>
                            )}
                          </div>
                        </div>
                        {contractGroup.length>0&&(
                          <div style={gs}>
                            <div style={{ padding:'14px 16px',background:'rgba(8,14,28,.65)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'12px' }}>
                              <p style={gt}>Contract Flags</p>
                              <div style={{ display:'flex',flexWrap:'wrap',gap:'7px' }}>{contractGroup.map(c=><RiskPill key={c.label} label={c.label} value={{...c.style,label:c.value}} />)}</div>
                            </div>
                          </div>
                        )}
                        {ownerGroup.length>0&&(
                          <div style={gs}>
                            <div style={{ padding:'14px 16px',background:'rgba(8,14,28,.65)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'12px' }}>
                              <p style={gt}>Ownership</p>
                              <div style={{ display:'flex',flexWrap:'wrap',gap:'7px',marginBottom:ownerAddr&&!isRenounced?'8px':0 }}>{ownerGroup.map(c=><RiskPill key={c.label} label={c.label} value={{...c.style,label:c.value}} />)}</div>
                              {ownerAddr&&!isRenounced&&<p style={{ margin:0,fontSize:'10px',color:'#64748b',fontFamily:'var(--font-plex-mono)' }}>Owner: {shorten(ownerAddr)}</p>}
                            </div>
                          </div>
                        )}
                        {openRisks.length>0&&(
                          <div style={gs}>
                            <div style={{ padding:'14px 16px',background:'rgba(245,158,11,0.04)',border:'1px solid rgba(245,158,11,0.18)',borderRadius:'12px' }}>
                              <p style={{...gt,color:'#fbbf24'}}>Open Risks</p>
                              <p style={{ margin:'0 0 8px',fontSize:'10px',color:'#78716c',fontFamily:'var(--font-plex-mono)' }}>These checks could not be verified in this scan. LP ownership could not be verified this scan.</p>
                              <div style={{ display:'flex',flexDirection:'column',gap:'5px' }}>
                                {openRisks.map((r,i)=>(
                                  <div key={i} style={{ display:'flex',gap:'7px',alignItems:'flex-start' }}>
                                    <span style={{ color:'#fbbf24',flexShrink:0,fontSize:'11px',lineHeight:'16px' }}>·</span>
                                    <p style={{ margin:0,fontSize:'11px',color:'#fde68a',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{r}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </>
              )}

              {/* ── WATCH PLAN ────────────────────────────────────────── */}
              {activeSection === 'watch-plan' && (() => {
                const holderState = deriveHolderState(result)
                const lpStatus = result.lpControl?.status
                const lpVerified = lpStatus==='locked'||lpStatus==='burned'
                const missing = getMissingChecks(result)
                const next = getNextAction(result)
                const monitorItems = [
                  !lpVerified?{label:'LP Lock / Burn',detail:'Verify LP is locked or burned before assuming liquidity is safe.'}:null,
                  holderState.kind!=='rowsWithPercent'?{label:'Holder Concentration',detail:'Rescan or check holder data when available. Top holders not confirmed.'}:null,
                  result.marketCapUsd==null?{label:'Market Cap',detail:'Circulating supply not confirmed — FDV is not market cap.'}:null,
                  (result.liquidity??0)>0&&(result.liquidity??0)<100000?{label:'Thin Liquidity',detail:`${fmtLarge(result.liquidity)} pool depth — monitor for exit risk and slippage.`}:null,
                  result.honeypot?.isHoneypot!==false?{label:'Honeypot Status',detail:'Security simulation not completed or inconclusive.'}:null,
                ].filter((x):x is{label:string;detail:string}=>x!=null)
                const st={margin:'0 0 4px',fontSize:'9px',fontWeight:700 as const,letterSpacing:'.16em',textTransform:'uppercase' as const,fontFamily:'var(--font-plex-mono)'}
                // Build priority checklist
                const priorityItems: Array<{num:number;label:string;detail:string;urgent:boolean}> = [
                  ...(!lpVerified ? [{ num:1, label:'Verify LP Lock or Burn', detail:'Confirm liquidity is locked or burned before assuming exits are safe.', urgent:true }] : []),
                  ...(holderState.kind!=='rowsWithPercent' ? [{ num:lpVerified?1:2, label:'Confirm Holder Concentration', detail:'Top holders not confirmed. Check supply spread before forming conviction.', urgent:holderState.kind==='noRowsFallback' }] : []),
                  ...(result.marketCapUsd==null ? [{ num:(lpVerified?0:1)+(holderState.kind!=='rowsWithPercent'?1:0)+1, label:'Verify Market Cap', detail:'Circulating supply not confirmed — FDV is not equivalent to market cap.', urgent:false }] : []),
                  ...(!result.honeypot?.simulationSuccess ? [{ num:(lpVerified?0:1)+(holderState.kind!=='rowsWithPercent'?1:0)+(result.marketCapUsd==null?1:0)+1, label:'Check Security Simulation', detail:'Tax and honeypot status were not fully simulated this scan. Verify independently.', urgent:false }] : []),
                ].map((item,i)=>({...item,num:i+1}))
                return(
                  <>
                    <div style={{ marginBottom:'18px' }}>
                      <p style={{ margin:'0 0 3px',fontSize:'12px',fontWeight:800,letterSpacing:'0.10em',color:'#fbbf24',fontFamily:'var(--font-plex-mono)' }}>WATCH PLAN</p>
                      <p style={{ margin:0,fontSize:'11px',color:'#3a5268',fontFamily:'var(--font-plex-mono)' }}>Priority actions and signals to monitor before acting on this scan.</p>
                    </div>
                    {/* Next Action */}
                    <div style={{ marginBottom:'16px',padding:'16px 18px',background:'rgba(45,212,191,0.06)',border:'1px solid rgba(45,212,191,0.24)',borderRadius:'14px' }}>
                      <p style={{ ...st,color:'#2DD4BF' }}>Next Action</p>
                      <p style={{ margin:0,fontSize:'12px',color:'#67e8f9',lineHeight:1.65,fontFamily:'var(--font-plex-mono)' }}>{next}</p>
                    </div>
                    {/* Priority checklist */}
                    {priorityItems.length>0&&(
                      <div style={{ marginBottom:'18px' }}>
                        <p style={{ ...st,color:'#3a5268',margin:'0 0 10px' }}>Priority Track</p>
                        <div style={{ display:'flex',flexDirection:'column',gap:'8px' }}>
                          {priorityItems.map(item=>(
                            <div key={item.label} style={{ display:'flex',gap:'12px',padding:'12px 14px',background:'rgba(8,14,28,.72)',border:`1px solid ${item.urgent?'rgba(248,113,113,0.20)':'rgba(251,191,36,0.16)'}`,borderRadius:'12px',alignItems:'flex-start' }}>
                              <div style={{ width:'20px',height:'20px',borderRadius:'50%',background:item.urgent?'rgba(248,113,113,0.14)':'rgba(251,191,36,0.12)',border:`1px solid ${item.urgent?'rgba(248,113,113,0.35)':'rgba(251,191,36,0.30)'}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginTop:'1px' }}>
                                <span style={{ fontSize:'9px',fontWeight:800,color:item.urgent?'#f87171':'#fbbf24',fontFamily:'var(--font-plex-mono)' }}>{item.num}</span>
                              </div>
                              <div>
                                <p style={{ margin:'0 0 3px',fontSize:'11px',fontWeight:700,color:item.urgent?'#fca5a5':'#fde68a',fontFamily:'var(--font-plex-mono)' }}>{item.label}</p>
                                <p style={{ margin:0,fontSize:'11px',color:'#94a3b8',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{item.detail}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* CORTEX Watch Triggers */}
                    {(() => {
                      const cx2 = calculateCortexScore(result)
                      const lpVerifiedTrig = lpVerified
                      const holderVerifiedTrig = holderState.kind === 'rowsWithPercent'
                      const simVerifiedTrig = result.honeypot?.simulationSuccess === true && result.honeypot?.isHoneypot === false
                      const mcVerifiedTrig = result.marketCapUsd != null
                      const liq2 = result.liquidity ?? 0
                      const top10Trig = result.holderDistribution?.top10 ?? null
                      const triggers: Array<{label: string; detail: string; color: string}> = [
                        !lpVerifiedTrig ? { label: 'Verify LP Lock / Burn', detail: 'LP lock or burn proof missing. Confirm before trusting exit liquidity.', color: '#f87171' } : null,
                        !holderVerifiedTrig ? { label: 'Confirm Holder Distribution', detail: 'Rescan when holder data is indexed. Supply concentration is an open risk.', color: '#fbbf24' } : null,
                        !simVerifiedTrig ? { label: 'Check Security Simulation', detail: 'Honeypot and tax simulation incomplete. Verify on an independent checker.', color: '#fbbf24' } : null,
                        !mcVerifiedTrig ? { label: 'Confirm Market Cap', detail: 'Circulating supply not confirmed. FDV is not market cap — do not substitute.', color: '#a78bfa' } : null,
                        liq2 > 0 && liq2 < 100_000 ? { label: 'Monitor Liquidity Depth', detail: `${fmtLarge(liq2)} pool depth is thin. Watch for removal or rug conditions.`, color: '#fb923c' } : null,
                        top10Trig != null && top10Trig > 50 ? { label: 'Track Top Holder Movement', detail: `Top 10 hold ${top10Trig.toFixed(1)}% of supply. Large sells can collapse price rapidly.`, color: '#f87171' } : null,
                      ].filter((x): x is {label: string; detail: string; color: string} => x != null).slice(0, 3)
                      if (triggers.length === 0) return null
                      return (
                        <div style={{ marginBottom:'18px' }}>
                          <p style={{ ...st, color:'#fbbf24', margin:'0 0 10px' }}>CORTEX Watch Triggers</p>
                          <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
                            {triggers.map((trig, i) => (
                              <div key={i} style={{ display:'flex', gap:'12px', padding:'11px 14px', background:'rgba(8,14,28,.72)', border:`1px solid ${trig.color}22`, borderRadius:'10px', alignItems:'flex-start' }}>
                                <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:trig.color, flexShrink:0, marginTop:'4px', boxShadow:`0 0 6px ${trig.color}` }} />
                                <div>
                                  <p style={{ margin:'0 0 2px', fontSize:'11px', fontWeight:700, color:trig.color, fontFamily:'var(--font-plex-mono)' }}>{trig.label}</p>
                                  <p style={{ margin:0, fontSize:'11px', color:'#94a3b8', lineHeight:1.5, fontFamily:'var(--font-plex-mono)' }}>{trig.detail}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })()}
                    {/* Open checks */}
                    {missing.length>0&&(
                      <div style={{ marginBottom:'16px' }}>
                        <p style={{ ...st,color:'#3a5268',margin:'0 0 8px' }}>Open Checks</p>
                        <div style={{ display:'flex',flexWrap:'wrap',gap:'6px' }}>
                          {missing.map(m=>(
                            <span key={m} style={{ padding:'4px 11px',borderRadius:'999px',fontSize:'10px',fontWeight:600,color:'#fbbf24',background:'rgba(251,191,36,0.07)',border:'1px solid rgba(251,191,36,0.25)',fontFamily:'var(--font-plex-mono)',whiteSpace:'nowrap' }}>{m}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* What to monitor */}
                    {monitorItems.length>0&&(
                      <div style={{ marginBottom:'18px' }}>
                        <p style={{ ...st,color:'#3a5268',margin:'0 0 8px' }}>What to Monitor Next</p>
                        <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'8px' }}>
                          {monitorItems.map(item=>(
                            <div key={item.label} style={{ padding:'11px 14px',background:'rgba(8,14,28,.65)',border:'1px solid rgba(125,211,252,0.12)',borderRadius:'10px' }}>
                              <p style={{ margin:'0 0 3px',fontSize:'10px',fontWeight:700,color:'#7dd3fc',fontFamily:'var(--font-plex-mono)' }}>{item.label}</p>
                              <p style={{ margin:0,fontSize:'11px',color:'#64748b',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{item.detail}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Rescan triggers */}
                    <div style={{ marginBottom:'16px',padding:'14px 16px',background:'rgba(8,14,28,.65)',border:'1px solid rgba(125,211,252,0.16)',borderRadius:'12px' }}>
                      <p style={{ ...st,color:'#7dd3fc' }}>Rescan Triggers</p>
                      <div style={{ display:'flex',flexDirection:'column',gap:'5px',marginTop:'2px' }}>
                        {[
                          holderState.kind==='noRowsFallback'?'Holder indexing may catch up — rescan in a few minutes.':null,
                          'Rescan after significant liquidity changes or pool movement.',
                          'Rescan before entering a position to verify current market state.',
                          'Rescan if new pool creation or holder movement is reported.',
                        ].filter(Boolean).map((t,i)=>(
                          <div key={i} style={{ display:'flex',gap:'7px',alignItems:'flex-start' }}>
                            <span style={{ color:'#7dd3fc',fontSize:'11px',flexShrink:0,lineHeight:'16px' }}>·</span>
                            <p style={{ margin:0,fontSize:'11px',color:'#94a3b8',lineHeight:1.5,fontFamily:'var(--font-plex-mono)' }}>{t}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ padding:'18px',background:'rgba(255,255,255,0.02)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:'12px',textAlign:'center' }}>
                      <p style={{ margin:'0 0 6px',fontSize:'9px',fontWeight:700,letterSpacing:'.16em',color:'#1e3a44',textTransform:'uppercase',fontFamily:'var(--font-plex-mono)' }}>CORTEX Scan History</p>
                      <p style={{ margin:0,fontSize:'11px',color:'#1e3a44',fontFamily:'var(--font-plex-mono)' }}>CORTEX watch history will appear after repeated scans.</p>
                    </div>
                    <div style={{ marginTop:'10px', padding:'14px 16px', border:'1px dashed rgba(148,163,184,0.32)', borderRadius:'12px', background:'rgba(8,14,28,0.48)', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px', flexWrap:'wrap' }}>
                      <div>
                        <p style={{ margin:'0 0 3px', fontSize:'10px', color:'#94a3b8', letterSpacing:'.1em', fontFamily:'var(--font-plex-mono)' }}>COMING SOON</p>
                        <p style={{ margin:0, fontSize:'12px', color:'#cbd5e1', fontFamily:'var(--font-plex-mono)' }}>Save to Watchlist</p>
                      </div>
                      <button type="button" disabled style={{ padding:'8px 14px', borderRadius:'999px', border:'1px solid rgba(148,163,184,0.35)', background:'rgba(148,163,184,0.15)', color:'#94a3b8', fontWeight:700, fontFamily:'var(--font-plex-mono)', cursor:'not-allowed' }}>Save</button>
                    </div>
                  </>
                )
              })()}

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

          {/* Free-tier locked state */}
          {!planLoading && !isFullAccess && (
            <div style={{textAlign:'center',padding:'8px 0'}}>
              <div style={{fontSize:'22px',marginBottom:'10px'}}>🔒</div>
              <p style={{fontWeight:700,color:'#f8fafc',margin:'0 0 6px',fontSize:'13px',fontFamily:'var(--font-inter,Inter,sans-serif)'}}>Full CORTEX Verdict</p>
              <p style={{color:'#94a3b8',fontSize:'11px',margin:'0 0 16px',lineHeight:1.5,fontFamily:'var(--font-inter,Inter,sans-serif)'}}>Security analysis and CORTEX verdicts are included in Pro and Elite.</p>
              <a href="/pricing" style={{display:'inline-block',padding:'8px 20px',borderRadius:'999px',background:'linear-gradient(135deg,#7c3aed,#a855f7)',color:'#fff',fontWeight:700,fontSize:'12px',textDecoration:'none'}}>Get Access</a>
            </div>
          )}

          {/* Idle */}
          {!planLoading && isFullAccess && !clarkLoading && !clarkVerdict && !clarkError && (
            <p style={{
              fontSize: '11px', color: '#1e3a44',
              fontFamily: 'var(--font-plex-mono)', lineHeight: 1.6,
            }}>
              Scan a token to generate a structured Clark verdict.
            </p>
          )}

          {/* Loading dots */}
          {!planLoading && isFullAccess && clarkLoading && (
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
          {!planLoading && isFullAccess && clarkError && (
            <p style={{
              fontSize: '12px', color: '#fca5a5',
              fontFamily: 'var(--font-plex-mono)', margin: 0, lineHeight: 1.6,
            }}>
              {clarkError}
            </p>
          )}

          {/* Verdict */}
          {!planLoading && isFullAccess && result && (() => {
            const d = deriveVerdictInput(result)
            const hp = result.honeypot
            const buyTax = hp?.buyTax ?? null
            const sellTax = hp?.sellTax ?? null
            const liq = result.liquidity ?? 0
            const poolCount = result.pools?.length ?? 0
            const top10 = result.holderDistribution?.top10
            const top20 = result.holderDistribution?.top20
            const taxesHigh = (buyTax != null && buyTax > 8) || (sellTax != null && sellTax > 8)
            const scx = calculateCortexScore(result)
            const verdict = scx.verdict
            const verdictColor = verdict === 'AVOID' ? '#f87171' : verdict === 'CLEAN LOOKING' ? '#2DD4BF' : verdict === 'WATCH' ? '#fbbf24' : verdict === 'CAUTION' ? '#f59e0b' : '#94a3b8'
            const bull = [
              liq > 1_000_000 ? `Deep liquidity — ${fmtLarge(liq)} pool depth.` : liq > 200_000 ? `Moderate liquidity — ${fmtLarge(liq)} pool depth.` : liq > 0 ? 'Liquidity present.' : '',
              d.hasMarketData ? 'Live market data confirmed.' : '',
              hp?.isHoneypot === false && hp?.simulationSuccess ? 'No honeypot — sell simulation passed.' : '',
              poolCount > 1 ? `${poolCount} active pools detected.` : poolCount === 1 ? 'Primary pool active.' : '',
              d.holderState.kind !== 'noRowsFallback' ? 'Holder distribution data is available.' : '',
            ].filter(Boolean).slice(0, 3)
            const bear = [
              d.holderState.kind === 'noRowsFallback' ? 'Holder concentration not confirmed — treat as incomplete risk check.' : '',
              taxesHigh ? `Elevated taxes — buy ${buyTax?.toFixed(1)}% / sell ${sellTax?.toFixed(1)}%.` : '',
              liq > 0 && liq < 50000 ? `Thin liquidity — ${fmtLarge(liq)}, high slippage risk.` : '',
              result.marketCapUsd == null ? 'Market cap not verified — supply unconfirmed.' : '',
              hp?.simulationSuccess === false ? 'Security simulation did not complete.' : '',
            ].filter(Boolean).slice(0, 3)
            const missingChecks = [
              result.noActivePools ? 'Active pool' : '',
              d.holderState.kind !== 'rowsWithPercent' ? 'Holder concentration' : '',
              'Supply spread', 'LP lock',
              d.fallbackEvidence.ownerStatus === 'Unverified' ? 'Owner status' : '',
              result.marketCapUsd == null ? 'Market cap' : '',
            ].filter(Boolean)
            // Score from data-driven engine
            const sidebarScore = scx.score
            const sidebarScoreColor = sidebarScore >= 75 ? '#34d399' : sidebarScore >= 50 ? '#fbbf24' : '#f87171'
            // Critical risks (top 3 actionable)
            const criticalRisks: string[] = [
              hp?.isHoneypot === true ? 'HONEYPOT detected — do not trade.' : null,
              taxesHigh ? `High taxes — buy ${buyTax?.toFixed(1)}% / sell ${sellTax?.toFixed(1)}%.` : null,
              result.noActivePools ? 'No active liquidity pool found.' : null,
              liq > 0 && liq < 10000 ? `Very thin liquidity — ${fmtLarge(liq)}.` : liq > 0 && liq < 50000 ? `Thin liquidity — ${fmtLarge(liq)}.` : null,
              d.holderState.kind === 'noRowsFallback' ? 'Holder concentration unverified.' : null,
              !hp?.simulationSuccess ? 'Tax simulation unavailable.' : null,
            ].filter((x):x is string=>x!=null).slice(0,3)
            const ss = {padding:'10px 12px',border:'1px solid rgba(255,255,255,0.07)',borderRadius:'10px',background:'rgba(8,14,28,.65)'}
            const stitle = {margin:'0 0 6px',fontSize:'9px',fontWeight:700 as const,letterSpacing:'.16em',color:'#3a5268',textTransform:'uppercase' as const,fontFamily:'var(--font-plex-mono)'}
            const sbody = {margin:0,fontSize:'11px',color:'#94a3b8',lineHeight:1.65 as const,fontFamily:'var(--font-plex-mono)'}
            return (
              <div style={{display:'flex',flexDirection:'column',gap:'9px'}}>
                {/* CORTEX Receipt header */}
                <div style={{padding:'16px',border:`1px solid ${verdictColor}30`,borderRadius:'14px',background:'linear-gradient(135deg,rgba(8,20,38,.92),rgba(14,12,38,.90))',boxShadow:`0 0 28px ${verdictColor}0e`}}>
                  <div style={{fontSize:'9px',letterSpacing:'.16em',color:'#3a5268',fontFamily:'var(--font-plex-mono)',marginBottom:'10px'}}>CORTEX RECEIPT</div>
                  <div style={{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap'}}>
                    <div style={{flexShrink:0}}>
                      <div style={{fontSize:'9px',color:'#3a5268',fontFamily:'var(--font-plex-mono)',marginBottom:'2px'}}>SCORE</div>
                      <div style={{fontSize:'28px',fontWeight:800,color:sidebarScoreColor,fontFamily:'var(--font-plex-mono)',lineHeight:1}}>{sidebarScore}<span style={{fontSize:'12px',color:`${sidebarScoreColor}55`}}>/100</span></div>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{display:'inline-flex',padding:'5px 14px',borderRadius:'999px',border:`1px solid ${verdictColor}55`,color:verdictColor,fontWeight:800,fontSize:'11px',letterSpacing:'.10em',background:`${verdictColor}12`,fontFamily:'var(--font-plex-mono)',marginBottom:'6px'}}>{verdict}</div>
                      <div style={{height:'4px',borderRadius:'999px',background:'rgba(255,255,255,0.06)',overflow:'hidden'}}>
                        <div style={{height:'100%',width:`${sidebarScore}%`,borderRadius:'999px',background:`linear-gradient(90deg,${sidebarScoreColor},${sidebarScoreColor}70)`,transition:'width 0.6s ease'}} />
                      </div>
                    </div>
                  </div>
                </div>
                {/* Top 3 Risks */}
                {criticalRisks.length > 0 && (
                  <div style={{padding:'10px 12px',border:'1px solid rgba(248,113,113,0.22)',borderRadius:'10px',background:'rgba(248,113,113,0.04)'}}>
                    <p style={{...stitle,color:'#f87171'}}>Top 3 Risks</p>
                    <div style={{display:'flex',flexDirection:'column',gap:'4px'}}>
                      {criticalRisks.map((r,i)=>(
                        <div key={i} style={{display:'flex',gap:'6px',alignItems:'flex-start'}}>
                          <span style={{color:'#f87171',flexShrink:0,fontSize:'11px',lineHeight:'16px'}}>!</span>
                          <p style={{...sbody,color:'#fca5a5',margin:0}}>{r}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Top 2 Positives */}
                <div style={ss}>
                  <p style={stitle}>Top 2 Positives</p>
                  <div style={{display:'flex',flexDirection:'column',gap:'4px'}}>{bull.slice(0,2).map((b,i)=><p key={i} style={{...sbody,margin:0,color:'#86efac'}}>{b}</p>)}</div>
                </div>
                {/* Holder / Supply */}
                <div style={ss}>
                  <p style={stitle}>Holder Read</p>
                  {d.holderState.kind === 'rowsWithPercent' && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 8px',borderRadius:'999px',border:'1px solid rgba(45,212,191,.35)',color:'#2dd4bf',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',fontFamily:'var(--font-plex-mono)',background:'rgba(45,212,191,.07)'}}>CONCENTRATION VERIFIED</div>
                  )}
                  {d.holderState.kind === 'rowsWithoutPercent' && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 8px',borderRadius:'999px',border:'1px solid rgba(251,191,36,.35)',color:'#fbbf24',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',fontFamily:'var(--font-plex-mono)',background:'rgba(251,191,36,.07)'}}>CONCENTRATION INCOMPLETE</div>
                  )}
                  {d.holderState.kind === 'noRowsFallback' && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 8px',borderRadius:'999px',border:'1px solid rgba(251,191,36,.35)',color:'#fbbf24',fontSize:'9px',fontWeight:700,letterSpacing:'.10em',fontFamily:'var(--font-plex-mono)',background:'rgba(251,191,36,.07)'}}>CONCENTRATION UNVERIFIED</div>
                  )}
                  {result.holderDistribution?.holderCount != null && (
                    <div style={{display:'inline-flex',marginBottom:'7px',padding:'2px 9px',border:'1px solid rgba(45,212,191,.28)',borderRadius:'999px',fontSize:'11px',color:'#2DD4BF',fontFamily:'var(--font-plex-mono)',background:'rgba(45,212,191,.06)'}}>
                      {result.holderDistribution.holderCount.toLocaleString()} holders
                    </div>
                  )}
                  {(top10 != null || top20 != null) && (
                    <div style={{display:'flex',gap:'5px',flexWrap:'wrap',marginBottom:'7px'}}>
                      {top10 != null && <span style={{padding:'2px 8px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:top10>50?'#f87171':top10>30?'#fbbf24':'#34d399',background:top10>50?'rgba(248,113,113,.08)':top10>30?'rgba(251,191,36,.08)':'rgba(52,211,153,.08)',border:top10>50?'1px solid rgba(248,113,113,.28)':top10>30?'1px solid rgba(251,191,36,.28)':'1px solid rgba(52,211,153,.28)',fontFamily:'var(--font-plex-mono)'}}>Top 10: {top10.toFixed(1)}%</span>}
                      {top20 != null && <span style={{padding:'2px 8px',borderRadius:'999px',fontSize:'10px',fontWeight:700,color:'#94a3b8',border:'1px solid rgba(148,163,184,.22)',fontFamily:'var(--font-plex-mono)'}}>Top 20: {top20.toFixed(1)}%</span>}
                    </div>
                  )}
                  <p style={sbody}>{getHolderRead(result)}</p>
                </div>
                {/* Next Action */}
                <div style={{padding:'11px 14px',border:'1px solid rgba(45,212,191,.32)',borderRadius:'12px',background:'rgba(45,212,191,.05)'}}>
                  <p style={{...stitle,color:'#2DD4BF',marginBottom:'5px'}}>Next Action</p>
                  <p style={{...sbody,color:'#67e8f9'}}>{getNextAction(result)}</p>
                </div>
              </div>
            )
          })()}
        </aside>

      </div>
    </>
  )
}

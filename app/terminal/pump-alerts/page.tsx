'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

type PumpCategory = 'HIGH_MOMENTUM' | 'VOLUME_EXPANSION' | 'THIN_MOONSHOT' | 'WATCH'
type PumpRisk = 'HIGH' | 'MEDIUM' | 'LOW'

interface PumpAlert {
  symbol: string
  name: string
  contract: string
  // Narrowed from `string`: the handoff builds a Token Scanner `?chain=` param and a Clark chain
  // label off this, so an unconstrained string would let a typo route a token to the wrong network.
  chain: 'base' | 'eth' | 'robinhood'
  chainId: number
  pairAddress: string | null
  priceUsd: number | null
  change24h: number | null
  // LIVE MOMENTUM MODE, DISCLOSED (URGENT fix request): 6h/1h change from GeckoTerminal's own pool
  // data, shown when available so a live-momentum qualification is never a bare, unexplained badge.
  change6h: number | null
  change1h: number | null
  change14d: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  tokenAgeDays: number | null
  // EVIDENCE BADGE, DISCLOSED (ELIGIBILITY-MODEL fix): every card states HOW it qualified — 'exact'
  // means a real measured 14d change backs it; 'live_momentum' means exact 14d was unavailable (or
  // never attempted) but real, currently-observable 24h/6h/1h momentum + volume-relative-to-
  // liquidity evidence qualified it instead. Never rendered identically — a live-momentum card must
  // never be labelled "Exact 14d".
  evidenceSource?: 'geckoterminal_ohlcv' | 'coingecko_contract' | 'internal_snapshot' | 'live_momentum'
  evidenceGrade?: 'exact' | 'live_momentum'
  category: PumpCategory
  reason: string
  qualifyingReason: string
  riskLevel: PumpRisk
  tags: string[]
}

type FilterKey = 'ALL' | PumpCategory

// CANDIDATE-EVALUATION-DEPTH FIX, DISCLOSED (URGENT fix request): exact shape the backend now
// returns so an empty feed always answers "why" — how many raw candidates existed, how many were
// filtered as majors/stables/high-FDV, how many actually got evidence-checked, and whether
// evaluation stopped early because of a budget cap rather than genuinely running out of candidates.
interface PumpCandidateEvaluationAudit {
  rawCandidates: number
  categoryFiltered: number
  lowCapCandidates: number
  liquidityVolumeCandidates: number
  candidatesEvaluated: number
  candidatesSkippedBeforeOhlcv: number
  geckoAttempts: number
  geckoSuccesses: number
  dexFallbackAttempts: number
  dexFallbackSuccesses: number
  coinGeckoAttempts: number
  coinGeckoSuccesses: number
  internalSnapshotAttempts: number
  internalSnapshotSuccesses: number
  qualifiedExact7d: number
  qualifiedMomentumFallback: number
  rejectedAfterEvidenceCheck: number
  stoppedReason: 'targetReached' | 'allCandidatesExhausted' | 'budgetExhausted'
  finalRenderedCount: number
}

const CATEGORY_LABEL: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'High Momentum',
  VOLUME_EXPANSION: 'Vol Expansion',
  THIN_MOONSHOT: 'Thin Liquidity',
  WATCH: 'Watchlist',
}

const CATEGORY_COLOR: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: '#22d3ee',
  VOLUME_EXPANSION: '#a855f7',
  THIN_MOONSHOT: '#f97316',
  WATCH: '#2DD4BF',
}

const CATEGORY_BG: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'rgba(34,211,238,0.12)',
  VOLUME_EXPANSION: 'rgba(168,85,247,0.12)',
  THIN_MOONSHOT: 'rgba(249,115,22,0.12)',
  WATCH: 'rgba(45,212,191,0.10)',
}

const CATEGORY_BORDER: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'rgba(34,211,238,0.32)',
  VOLUME_EXPANSION: 'rgba(168,85,247,0.30)',
  THIN_MOONSHOT: 'rgba(249,115,22,0.30)',
  WATCH: 'rgba(45,212,191,0.26)',
}

const RISK_COLOR: Record<PumpRisk, string> = {
  HIGH: '#f87171',
  MEDIUM: '#fbbf24',
  LOW: '#4ade80',
}

const RISK_BG: Record<PumpRisk, string> = {
  HIGH: 'rgba(248,113,113,0.12)',
  MEDIUM: 'rgba(251,191,36,0.12)',
  LOW: 'rgba(74,222,128,0.10)',
}

const RISK_LABEL: Record<PumpRisk, string> = {
  HIGH: 'HIGH RISK',
  MEDIUM: 'WATCH RISK',
  LOW: 'LOWER RISK',
}

// CHAIN-VISIBILITY FIX, DISCLOSED (requested: "make the chain easy to see"). Chain used to be a
// small lowercase mono string buried in the metric grid's last cell, truncating on narrow cards
// ("robinho…") — the same information a viewer needs first, at a glance, to know where a contract
// lives. Gives each chain its own color and a short, non-truncating label so it reads as a proper
// badge instead of clipped text.
const CHAIN_LABEL: Record<'base' | 'eth' | 'robinhood', string> = {
  base: 'BASE',
  eth: 'ETH',
  robinhood: 'ROBINHOOD',
}

const CHAIN_COLOR: Record<'base' | 'eth' | 'robinhood', string> = {
  base: '#3b82f6',
  eth: '#a78bfa',
  robinhood: '#22c55e',
}

const CHAIN_BG: Record<'base' | 'eth' | 'robinhood', string> = {
  base: 'rgba(59,130,246,0.12)',
  eth: 'rgba(167,139,250,0.12)',
  robinhood: 'rgba(34,197,94,0.12)',
}

const CHAIN_BORDER: Record<'base' | 'eth' | 'robinhood', string> = {
  base: 'rgba(59,130,246,0.34)',
  eth: 'rgba(167,139,250,0.32)',
  robinhood: 'rgba(34,197,94,0.32)',
}

const FILTER_CHIPS: Array<{ key: FilterKey; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'HIGH_MOMENTUM', label: 'High Momentum' },
  { key: 'VOLUME_EXPANSION', label: 'Vol Expansion' },
  { key: 'WATCH', label: 'Watchlist' },
  { key: 'THIN_MOONSHOT', label: 'Thin Liquidity' },
]

function fmtUSD(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

function fmtPrice(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1) return `$${v.toFixed(4)}`
  if (v >= 0.0001) return `$${v.toFixed(6)}`
  // Tiny prices: show 4 significant figures in plain decimal (never scientific notation)
  const decimals = Math.min(-Math.floor(Math.log10(v)) + 3, 12)
  return `$${v.toFixed(decimals)}`
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}


function fdvTier(v: number | null): { color: string; bg: string; border: string; label: string; glow: string } {
  if (v == null) return { color: '#94a3b8', bg: 'linear-gradient(135deg, rgba(100,116,139,0.13), rgba(148,163,184,0.055))', border: 'rgba(148,163,184,0.18)', label: 'FDV open', glow: 'rgba(148,163,184,0.08)' }
  if (v < 500_000) return { color: '#4ade80', bg: 'linear-gradient(135deg, rgba(74,222,128,0.12), rgba(45,212,191,0.050))', border: 'rgba(74,222,128,0.28)', label: 'Low FDV', glow: 'rgba(74,222,128,0.12)' }
  if (v < 5_000_000) return { color: '#22d3ee', bg: 'linear-gradient(135deg, rgba(34,211,238,0.13), rgba(45,212,191,0.045))', border: 'rgba(34,211,238,0.28)', label: 'Mid FDV', glow: 'rgba(34,211,238,0.12)' }
  return { color: '#c084fc', bg: 'linear-gradient(135deg, rgba(192,132,252,0.13), rgba(168,85,247,0.050))', border: 'rgba(192,132,252,0.30)', label: 'High FDV', glow: 'rgba(192,132,252,0.13)' }
}

// CARD POLISH, DISCLOSED (requested: cards feel too wide/heavy, unclear hierarchy, no Market Cap).
// One compact metric cell for the grid — label above, value below, uniform sizing so the 10-metric
// grid (Price/24h/6h/1h/Vol/Liq/MCap/FDV/Age/Chain) stays aligned and scannable in ~5 seconds.
function GridMetric({ label, value, dim, strong, color }: { label: string; value: string; dim?: boolean; strong?: boolean; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      <span style={{ fontSize: '7.5px', fontWeight: 800, color: '#4a6178', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', lineHeight: 1 }}>
        {label}
      </span>
      <span style={{
        fontSize: strong ? '13px' : '11px', fontWeight: strong ? 900 : 700,
        color: dim ? '#4a6178' : (color ?? '#dce8f2'),
        fontFamily: 'var(--font-plex-mono)', lineHeight: 1.15,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {value}
      </span>
    </div>
  )
}

function AlertCard({ alert, onScan, onAskClark, onReport, onCopyCA, copied }: {
  alert: PumpAlert
  onScan: () => void
  onAskClark: () => void
  onReport: () => void
  onCopyCA: () => void
  copied: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const catColor = CATEGORY_COLOR[alert.category]
  const catBg = CATEGORY_BG[alert.category]
  const catBorder = CATEGORY_BORDER[alert.category]
  const riskColor = RISK_COLOR[alert.riskLevel]
  const riskBg = RISK_BG[alert.riskLevel]
  const change = alert.change24h ?? 0
  const changePositive = change >= 0
  const changeAbs = Math.abs(change)
  const changeColor = changePositive ? (changeAbs >= 50 ? '#22d3ee' : '#4ade80') : (changeAbs >= 25 ? '#fb7185' : '#f87171')
  const avatarText = (alert.symbol || '?').slice(0, 2).toUpperCase()
  const fdvStyle = fdvTier(alert.fdvUsd)
  const showWhaleIcon = alert.tags?.some(tag => /whale/i.test(tag))
  const showRiskIcon = alert.riskLevel === 'HIGH' || alert.riskLevel === 'MEDIUM'
  const identityColor = alert.riskLevel === 'HIGH' ? riskColor : alert.category === 'HIGH_MOMENTUM' ? catColor : alert.riskLevel === 'MEDIUM' ? '#c084fc' : '#2DD4BF'
  // MARKET CAP, DISCLOSED (requested: card must show Market Cap alongside FDV, never fabricated).
  // marketCapUsd is only ever a real value the backend measured (or null) — "MCap unavailable" is
  // shown verbatim rather than a fake $0 or silently reusing the FDV figure.
  const mcapText = alert.marketCapUsd != null ? fmtUSD(alert.marketCapUsd) : 'MCap unavailable'

  return (
    <div
      className="pump-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered
          ? `radial-gradient(circle at 12% 0%, ${catColor}12, transparent 30%), radial-gradient(circle at 92% 18%, rgba(168,85,247,0.060), transparent 36%), linear-gradient(135deg, rgba(255,255,255,0.065), rgba(255,255,255,0.026)), rgba(8,13,28,0.72)`
          : 'radial-gradient(circle at 12% 0%, rgba(45,212,191,0.045), transparent 28%), radial-gradient(circle at 92% 16%, rgba(168,85,247,0.035), transparent 34%), linear-gradient(135deg, rgba(255,255,255,0.040), rgba(255,255,255,0.016)), rgba(8,13,28,0.58)',
        border: `1px solid ${hovered ? `${catColor}38` : 'rgba(255,255,255,0.09)'}`,
        borderLeft: `2px solid ${identityColor}55`,
        ['--pump-identity-color' as string]: identityColor,
        ['--pump-accent-color' as string]: catColor,
        borderRadius: '16px',
        padding: '13px 14px',
        backdropFilter: 'blur(14px)',
        transition: 'background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease',
        boxShadow: hovered ? `0 14px 32px rgba(2,6,23,0.34), inset 0 1px 0 rgba(255,255,255,0.07), 0 0 26px ${catColor}16` : '0 8px 22px rgba(2,6,23,0.20), inset 0 1px 0 rgba(255,255,255,0.045)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        animation: 'pumpSlideIn 0.3s ease both',
        height: '100%',
      }}
    >
      {/* TOP: identity (left) + evidence/category/risk badges (right) — clearest info first. */}
      <div className="pump-card-top" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
          <div style={{
            width: '30px', height: '30px', borderRadius: '10px', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '9px', fontWeight: 800, color: catColor,
            background: `${catColor}1a`, border: `1px solid ${catColor}2e`,
            fontFamily: 'var(--font-plex-mono)',
          }}>
            {avatarText}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '14.5px', fontWeight: 900, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '150px' }}>
                {alert.name}
              </span>
              {alert.category === 'HIGH_MOMENTUM' && <span className="pump-flame" title='High momentum' style={{ filter: `drop-shadow(0 0 7px ${catColor}66)`, fontSize: '12px', lineHeight: 1 }}>🔥</span>}
              {showWhaleIcon && <span title='Whale activity' style={{ filter: 'drop-shadow(0 0 7px rgba(45,212,191,0.42))', fontSize: '12px', lineHeight: 1 }}>🐋</span>}
              {/* CHAIN-VISIBILITY FIX, DISCLOSED: a real colored badge instead of small lowercase text
                  buried in a subtitle — the chain is now the first thing a viewer can spot. */}
              <span title={`Chain: ${CHAIN_LABEL[alert.chain]}`} style={{
                display: 'inline-flex', alignItems: 'center', gap: '3px',
                padding: '2px 6px', borderRadius: '999px', fontSize: '7.5px', fontWeight: 900, letterSpacing: '0.04em',
                color: CHAIN_COLOR[alert.chain], background: CHAIN_BG[alert.chain], border: `1px solid ${CHAIN_BORDER[alert.chain]}`,
                fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
              }}>
                <span style={{ width: '5px', height: '5px', borderRadius: '999px', background: CHAIN_COLOR[alert.chain], flexShrink: 0 }} />
                {CHAIN_LABEL[alert.chain]}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', fontFamily: 'var(--font-plex-mono)' }}>
              <span style={{ color: '#9bb4ca', fontWeight: 850 }}>{alert.symbol}</span>
              <span style={{ color: '#2d3f52' }}>·</span>
              <span style={{ color: '#374a5c' }}>{shortAddr(alert.contract)}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'flex-end', flexShrink: 0, maxWidth: '46%' }}>
          {/* EVIDENCE BADGE, DISCLOSED (ELIGIBILITY-MODEL fix): states exactly how this card
              qualified. Exact sources get a calm teal "Exact 14d" chip; live-momentum cards get a
              distinct amber "Live Momentum" chip so a live-momentum qualification can never pass as
              confirmed 14d data. */}
          {alert.evidenceGrade === 'live_momentum' ? (
            <span className="pump-pill" title={alert.qualifyingReason} style={{
              padding: '4px 8px', borderRadius: '999px', fontSize: '7.5px', fontWeight: 800, letterSpacing: '0.06em',
              color: '#fbbf24', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.32)',
              fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
            }}>
              ◐ Live Momentum
            </span>
          ) : (
            <span className="pump-pill" title={alert.qualifyingReason} style={{
              padding: '4px 8px', borderRadius: '999px', fontSize: '7.5px', fontWeight: 800, letterSpacing: '0.06em',
              color: '#2DD4BF', background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.30)',
              fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
            }}>
              ✓ Exact 14d
            </span>
          )}
          <span className="pump-pill" style={{
            padding: '4px 8px', borderRadius: '999px', fontSize: '7.5px', fontWeight: 800, letterSpacing: '0.06em',
            color: catColor, background: catBg, border: `1px solid ${catBorder}`,
            fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
          }}>
            {alert.category === 'HIGH_MOMENTUM' ? '🔥 ' : ''}{CATEGORY_LABEL[alert.category]}
          </span>
          <span className="pump-pill" style={{
            padding: '4px 8px', borderRadius: '999px', fontSize: '7.5px', fontWeight: 800, letterSpacing: '0.06em',
            color: riskColor, background: riskBg, border: `1px solid ${riskColor}33`,
            fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
          }}>
            {showRiskIcon ? '△ ' : ''}{RISK_LABEL[alert.riskLevel]}
          </span>
          <span className="pump-pill" style={{
            padding: '4px 8px', borderRadius: '999px', fontSize: '7.5px', fontWeight: 800, letterSpacing: '0.06em',
            color: fdvStyle.color, background: fdvStyle.bg, border: `1px solid ${fdvStyle.border}`,
            fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
          }}>
            {fdvStyle.label}
          </span>
          {alert.tags?.map(tag => (
            <span key={tag} className="pump-pill" style={{
              padding: '4px 8px', borderRadius: '999px', fontSize: '7.5px', fontWeight: 800, letterSpacing: '0.06em',
              color: '#b7c7d8', background: 'rgba(45,212,191,0.06)', border: '1px solid rgba(45,212,191,0.16)',
              fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
            }}>
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* METRIC GRID, DISCLOSED: exact order requested — Price | 24h | 6h | 1h | Volume | Liquidity
          | Market Cap | FDV | Age | Chain. 24h is the strongest number on the card (largest, always
          colored by direction) even though its position in the grid is unchanged. */}
      <div
        className="pump-card-grid"
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', columnGap: '10px', rowGap: '9px',
          padding: '9px 10px', borderRadius: '12px', background: 'rgba(2,6,23,0.24)',
          border: '1px solid rgba(45,212,191,0.08)',
        }}
      >
        <GridMetric label="Price" value={fmtPrice(alert.priceUsd)} />
        <GridMetric
          label="24h"
          value={alert.change24h != null ? `${changePositive ? '▲' : '▼'}${changeAbs.toFixed(1)}%` : '—'}
          dim={alert.change24h == null}
          color={alert.change24h != null ? changeColor : undefined}
          strong
        />
        <GridMetric
          label="6h"
          value={alert.change6h != null ? `${alert.change6h >= 0 ? '+' : ''}${alert.change6h.toFixed(1)}%` : '—'}
          dim={alert.change6h == null}
          color={alert.change6h != null ? (alert.change6h >= 0 ? '#4ade80' : '#f87171') : undefined}
        />
        <GridMetric
          label="1h"
          value={alert.change1h != null ? `${alert.change1h >= 0 ? '+' : ''}${alert.change1h.toFixed(1)}%` : '—'}
          dim={alert.change1h == null}
          color={alert.change1h != null ? (alert.change1h >= 0 ? '#4ade80' : '#f87171') : undefined}
        />
        <GridMetric label="Volume" value={fmtUSD(alert.volume24hUsd)} dim={alert.volume24hUsd == null} />
        <GridMetric label="Liquidity" value={fmtUSD(alert.liquidityUsd)} dim={alert.liquidityUsd == null} />
        <GridMetric label="Market Cap" value={mcapText} dim={alert.marketCapUsd == null} />
        <GridMetric label="FDV" value={fmtUSD(alert.fdvUsd)} dim={alert.fdvUsd == null} />
        <GridMetric label="Age" value={alert.tokenAgeDays != null ? (alert.tokenAgeDays < 1 ? '<1d' : `${Math.round(alert.tokenAgeDays)}d`) : '—'} dim={alert.tokenAgeDays == null} />
        <GridMetric label="Chain" value={CHAIN_LABEL[alert.chain]} strong color={CHAIN_COLOR[alert.chain]} />
      </div>

      {/* Reason + qualifying evidence — single-line, truncated, full text on hover. */}
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: '10px', color: '#7690a6', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {showRiskIcon && <span style={{ color: riskColor }}>△ </span>}
          {alert.reason}
        </p>
        <p title={alert.qualifyingReason} style={{ margin: '2px 0 0', fontSize: '9px', color: '#3f7a6e', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-plex-mono)' }}>
          Qualifies: {alert.qualifyingReason}
        </p>
      </div>

      {/* ACTIONS, DISCLOSED: single compact row, bottom of card — same 4 actions/handlers as before,
          just no longer stacked in a tall right-hand rail. */}
      <div className="pump-card-actions" style={{ display: 'flex', gap: '5px', marginTop: 'auto' }}>
        <button
          onClick={onScan}
          className="pump-action-btn"
          style={{
            flex: 1, padding: '7px 6px', borderRadius: '9px', fontSize: '8px', fontWeight: 800,
            letterSpacing: '0.05em', textTransform: 'uppercase',
            border: '1px solid rgba(45,212,191,0.32)', background: 'rgba(45,212,191,0.09)',
            color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
            transition: 'background 0.16s ease, border-color 0.16s ease, transform 0.16s ease',
          }}
        >
          ⌕ Scan
        </button>
        <button
          onClick={onCopyCA}
          className="pump-action-btn"
          aria-label={`Copy contract address for ${alert.symbol}`}
          style={{
            flex: 1, padding: '7px 6px', borderRadius: '9px', fontSize: '8px', fontWeight: 800,
            letterSpacing: '0.05em', textTransform: 'uppercase',
            border: `1px solid ${copied ? 'rgba(74,222,128,0.42)' : 'rgba(45,212,191,0.28)'}`,
            background: copied ? 'rgba(74,222,128,0.12)' : 'rgba(255,255,255,0.04)',
            color: copied ? '#4ade80' : '#9bb4ca', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
            transition: 'background 0.16s ease, border-color 0.16s ease, transform 0.16s ease',
          }}
        >
          {copied ? '✓ Copied' : '⧉ Copy CA'}
        </button>
        <button
          onClick={onAskClark}
          className="pump-action-btn"
          style={{
            flex: 1, padding: '7px 6px', borderRadius: '9px', fontSize: '8px', fontWeight: 800,
            letterSpacing: '0.05em', textTransform: 'uppercase',
            border: '1px solid rgba(45,212,191,0.28)', background: 'linear-gradient(135deg, rgba(45,212,191,0.10), rgba(168,85,247,0.10))',
            color: '#c4b5fd', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
            transition: 'background 0.16s ease, border-color 0.16s ease, transform 0.16s ease',
          }}
        >
          ✦ Clark
        </button>
        <button
          onClick={onReport}
          className="pump-action-btn"
          style={{
            flex: 1, padding: '7px 6px', borderRadius: '9px', fontSize: '8px', fontWeight: 800,
            letterSpacing: '0.05em', textTransform: 'uppercase',
            border: '1px solid rgba(168,85,247,0.32)', background: 'rgba(168,85,247,0.09)',
            color: '#c084fc', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
            transition: 'background 0.16s ease, border-color 0.16s ease, transform 0.16s ease',
          }}
        >
          ◈ Report
        </button>
      </div>

      <div className="pump-clark-preview">
        <div className="pump-clark-intel" style={{ padding: '9px 10px', borderRadius: '12px', background: 'linear-gradient(135deg, rgba(45,212,191,0.075), rgba(168,85,247,0.080), rgba(34,211,238,0.040)), rgba(2,6,23,0.34)', border: '1px solid rgba(167,139,250,0.20)', color: '#a9bfd1', fontSize: '9.5px', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.02em' }}>
          <span style={{ color: '#c4b5fd', fontWeight: 900 }}>✦ Clark preview</span> · Momentum, liquidity, market cap/FDV, and risk notes are ready for an AI read.
        </div>
      </div>
    </div>
  )
}

function SummaryStrip({ alerts }: { alerts: PumpAlert[] }) {
  const highMomentum = alerts.filter(a => a.category === 'HIGH_MOMENTUM').length
  const volExp = alerts.filter(a => a.category === 'VOLUME_EXPANSION').length
  const thinLiq = alerts.filter(a => a.category === 'THIN_MOONSHOT').length
  const watch = alerts.filter(a => a.category === 'WATCH').length
  const highRisk = alerts.filter(a => a.riskLevel === 'HIGH').length

  const items = [
    { label: 'Total', value: String(alerts.length), glow: 'rgba(45,212,191,0.22)' },
    { label: 'High Momentum', value: String(highMomentum), glow: 'rgba(34,211,238,0.20)' },
    { label: 'Vol Expansion', value: String(volExp), glow: 'rgba(168,85,247,0.20)' },
    { label: 'Watchlist', value: String(watch), glow: 'rgba(45,212,191,0.16)' },
    { label: 'Thin Liquidity', value: String(thinLiq), glow: 'rgba(249,115,22,0.20)' },
    { label: 'High Risk', value: String(highRisk), glow: 'rgba(248,113,113,0.18)' },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '7px', marginBottom: '16px' }}>
      {items.map(item => (
        <div key={item.label} style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015))',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '9px',
          padding: '9px 10px',
          boxShadow: `0 0 16px ${item.glow}`,
        }}>
          <p style={{ margin: '0 0 3px', fontSize: '8px', color: '#3a5268', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>
            {item.label}
          </p>
          <p style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  )
}

export default function PumpAlertsPage() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const router = useRouter()
  const [alerts, setAlerts] = useState<PumpAlert[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  // `loading` is the first-paint skeleton only and never returns to true; `refreshing` drives the
  // non-blocking "refreshing" indicator so a background refresh never tears down a good feed.
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  // TRUTHFUL, SPECIFIC EMPTY STATE (URGENT fix request): finalState drives which of the real
  // empty-state messages renders; degradedNote fires when the scan succeeded but the primary 14d
  // provider failed and fallback evidence took over. candidateAudit backs the "why is this empty"
  // breakdown so a small/zero result is never presented as an undifferentiated "no pump signals".
  const [finalState, setFinalState] = useState<
    'providerUnavailable' | 'noRawCandidates' | 'noEligibleLowCapCandidates'
    | 'providerBudgetExhausted' | 'allCandidatesExhaustedNoMomentum' | 'providerDegradedPartial' | 'finalRendered' | null
  >(null)
  const [degradedNote, setDegradedNote] = useState<string | null>(null)
  const [candidateAudit, setCandidateAudit] = useState<PumpCandidateEvaluationAudit | null>(null)
  const [countdown, setCountdown] = useState(120)
  const [activeFilter, setActiveFilter] = useState<FilterKey>('ALL')
  const [refreshKey, setRefreshKey] = useState(0)
  // LOAD MORE, DISCLOSED (requested: initial render shows 8-10 alerts, Load More appends the next
  // 8-10 client-side — the backend has no cursor/page param, so this paginates over the already-
  // fetched `alerts` array without ever refetching). Reset only when the active filter changes, not
  // on every background refresh, so a user who's expanded the feed doesn't lose that on auto-refresh.
  const PAGE_SIZE = 10
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [loadMoreLoading, setLoadMoreLoading] = useState(false)
  const [loadMoreClicks, setLoadMoreClicks] = useState(0)
  const loadMoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // COPY-CA, DISCLOSED (requested: pump alerts cards had no way to grab the contract address).
  // Tracks which contract was just copied so its button shows "✓ Copied" briefly.
  const [copiedContract, setCopiedContract] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function copyCA(contract: string) {
    navigator.clipboard?.writeText(contract).then(
      () => {
        setCopiedContract(contract.toLowerCase())
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => setCopiedContract(null), 1600)
      },
      () => { /* clipboard unavailable — leave button state unchanged */ },
    )
  }

  // PUMP-CHAIN-SELECTOR, DISCLOSED (requested: load more Base <$20M, ETH <$50M, Robinhood <$20M
  // low caps). Which chains to scan — sent to /api/pump-alerts as ?chains=; default is all three
  // (the API silently drops Robinhood when its feature flag is off server-side).
  type PumpChainKey = 'base' | 'eth' | 'robinhood'
  const CHAIN_CHIPS: Array<{ key: PumpChainKey; label: string }> = [
    { key: 'base', label: 'Base' },
    { key: 'eth', label: 'ETH' },
    { key: 'robinhood', label: 'Robinhood' },
  ]
  const [activeChains, setActiveChains] = useState<Set<PumpChainKey>>(new Set(['base', 'eth', 'robinhood']))

  // NON-BLANKING REFRESH + HONEST FAILURES, DISCLOSED (full Radar/Pump audit): this previously
  // called setAlerts([]) on any error and replaced alerts with [] whenever a response had no
  // `alerts` key — so a single failed background refresh wiped a good feed to an empty state that
  // looked like "no pumps found" rather than "the request failed". It also discarded the route's
  // error/chainsFailed entirely, hiding provider outages. Now: last-good results are retained on
  // failure, and the real reason is surfaced instead of being swallowed.
  const fetchAlerts = useCallback(() => {
    setRefreshing(true)
    return (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token
        const qs = new URLSearchParams()
        if (chainParamRef.current.length > 0) qs.set('chains', chainParamRef.current.join(','))
        const res = await fetch(`/api/pump-alerts?${qs.toString()}`, {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        const json = await res.json()
        if (Array.isArray(json.alerts)) {
          setAlerts(json.alerts)
          setFetchedAt(json.fetchedAt ?? null)
          // A partial scan still returns real alerts — show them AND say which chains are missing.
          setFeedError(typeof json.error === 'string' ? json.error : null)
          setFinalState(typeof json.finalState === 'string' ? json.finalState : null)
          setCandidateAudit(json.pumpCandidateEvaluationAudit && typeof json.pumpCandidateEvaluationAudit === 'object' ? json.pumpCandidateEvaluationAudit : null)
          // Degraded-mode note from the evidence ladder: shown even when candidates rendered, so
          // live-momentum-qualified feeds are never mistaken for fully-exact-sourced ones.
          const audit14d = json.pump14dEvidenceAudit as { degradedMode?: boolean; degradedReason?: string | null; exact14dQualified?: number; fallbackMomentumQualified?: number } | undefined
          if (audit14d?.degradedMode) {
            const qualified = (audit14d.exact14dQualified ?? 0) + (audit14d.fallbackMomentumQualified ?? 0)
            setDegradedNote(
              audit14d.degradedReason
              ?? (qualified > 0
                ? 'GeckoTerminal OHLCV failed this cycle — some cards are qualified by live 24h/6h/1h momentum evidence instead.'
                : 'GeckoTerminal OHLCV failed this cycle and no live momentum evidence qualified a candidate either.'),
            )
          } else {
            setDegradedNote(null)
          }
        } else {
          // No usable payload: keep whatever is already on screen and explain why it didn't update.
          setFeedError(typeof json.error === 'string' ? json.error : 'Pump feed request failed. Showing last known results.')
        }
      } catch {
        setFeedError('Could not reach the pump feed. Showing last known results.')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    })()
  }, [])

  // Keep the latest chain selection readable inside the stable fetchAlerts callback without
  // re-creating it. Updated directly in event handlers (not via a sync effect), so the ref is
  // always current by the time fetchAlerts() is called.
  const chainParamRef = useRef<Array<PumpChainKey>>(['base', 'eth', 'robinhood'])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])

  useEffect(() => {
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { setRefreshKey(k => k + 1); return 120 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (refreshKey > 0) { fetchAlerts(); setCountdown(120) }
  }, [refreshKey, fetchAlerts])

  // CHAIN-STRICT HANDOFF, DISCLOSED (full Radar/Pump audit): these three handoffs all assumed Base.
  // openToken passed no chain at all and openReport hardcoded `chain: 'base'`, so once Pump Alerts
  // went multi-chain an ETH or Robinhood token was scanned and reported against the WRONG network
  // (Token Scanner's URL autodetect defaults to Base when no chain param is present). Base Radar's
  // equivalent handoff was already fixed in an earlier audit; this brings Pump Alerts in line with
  // it, including omitting the param for Base so existing Base links stay byte-for-byte identical.
  function openToken(alert: PumpAlert) {
    const chainQuery = alert.chain === 'base' ? '' : `&chain=${alert.chain}`
    router.push(`/terminal/token-scanner?contract=${alert.contract}${chainQuery}`)
  }

  function openReport(alert: PumpAlert) {
    const qs = new URLSearchParams({
      contract: alert.contract,
      chain: alert.chain,
      symbol: alert.symbol,
      name: alert.name,
      reason: alert.reason,
      riskLevel: alert.riskLevel,
      ...(alert.priceUsd != null ? { priceUsd: String(alert.priceUsd) } : {}),
      ...(alert.change24h != null ? { change24h: String(alert.change24h) } : {}),
      ...(alert.volume24hUsd != null ? { volume24hUsd: String(alert.volume24hUsd) } : {}),
      ...(alert.liquidityUsd != null ? { liquidityUsd: String(alert.liquidityUsd) } : {}),
      ...(alert.fdvUsd != null ? { fdvUsd: String(alert.fdvUsd) } : {}),
      ...(alert.change14d != null ? { change14d: String(alert.change14d) } : {}),
      ...(alert.marketCapUsd != null ? { marketCapUsd: String(alert.marketCapUsd) } : {}),
    })
    router.push(`/terminal/pump-alerts/report?${qs.toString()}`)
  }

  function openClark(alert: PumpAlert) {
    // The Chain line is load-bearing, not decoration: without it Clark reasoned about (and could
    // look up) a Robinhood/ETH contract as if it were on Base. Base Radar's prompt already states
    // its chain for exactly this reason.
    const chainName = alert.chain === 'robinhood' ? 'Robinhood Chain' : alert.chain === 'eth' ? 'Ethereum' : 'Base'
    const prompt = [
      '[mode: pump-alerts]',
      `Chain: ${chainName}`,
      `Token: ${alert.name} (${alert.symbol})`,
      `Contract: ${alert.contract}`,
      `Category: ${CATEGORY_LABEL[alert.category]}`,
      `14d Change: ${alert.change14d != null ? `+${alert.change14d.toFixed(1)}%` : 'N/A'}`,
      `24h Change: ${alert.change24h != null ? `${(alert.change24h >= 0 ? '+' : '')}${alert.change24h.toFixed(1)}%` : 'N/A'}`,
      `Volume 24h: ${fmtUSD(alert.volume24hUsd)}`,
      `Liquidity: ${fmtUSD(alert.liquidityUsd)}`,
      `FDV: ${fmtUSD(alert.fdvUsd ?? alert.marketCapUsd)}`,
      `Risk: ${RISK_LABEL[alert.riskLevel]}`,
      `Signal: ${alert.reason}`,
      `Qualified because: ${alert.qualifyingReason}`,
    ].join('\n')
    router.push(`/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}`)
  }

  const filtered = useMemo(() =>
    activeFilter === 'ALL' ? alerts : alerts.filter(a => a.category === activeFilter),
    [alerts, activeFilter],
  )

  // Reset pagination to the first page only when the filter actually changes — not on every
  // background refresh, so Load More progress survives an auto-refresh (requirement: "Refresh keeps
  // existing cards visible" / "Do not reset filters when loading more"). Adjusted during render
  // (React's documented pattern for state that must reset when a prop/value changes) rather than in
  // a useEffect, since setState-in-effect triggers an extra render pass and an eslint error.
  const [prevActiveFilterForReset, setPrevActiveFilterForReset] = useState(activeFilter)
  if (activeFilter !== prevActiveFilterForReset) {
    setPrevActiveFilterForReset(activeFilter)
    setVisibleCount(PAGE_SIZE)
  }

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const hasMore = visibleCount < filtered.length

  function handleLoadMore() {
    setLoadMoreClicks(c => c + 1)
    setLoadMoreLoading(true)
    if (loadMoreTimerRef.current) clearTimeout(loadMoreTimerRef.current)
    // Purely client-side — the alerts are already fetched, this only reveals more of them. The
    // brief delay is deliberate UI feedback (requirement: "button should have loading state"), not
    // a real fetch — no network call happens here.
    loadMoreTimerRef.current = setTimeout(() => {
      setVisibleCount(c => Math.min(filtered.length, c + PAGE_SIZE))
      setLoadMoreLoading(false)
    }, 180)
  }

  // UI AUDIT, DISCLOSED: exact shape requested — answers "what is actually on screen and why" for
  // the pagination/market-cap-availability layer, distinct from the backend's discovery-side audits.
  const pumpAlertsUiAudit = useMemo(() => ({
    totalAlertsFromApi: alerts.length,
    initialRenderedCount: Math.min(PAGE_SIZE, filtered.length),
    currentRenderedCount: visible.length,
    hasMore,
    marketCapAvailableCount: alerts.filter(a => a.marketCapUsd != null).length,
    marketCapMissingCount: alerts.filter(a => a.marketCapUsd == null).length,
    fdvAvailableCount: alerts.filter(a => a.fdvUsd != null).length,
    loadMoreClicks,
    activeFilter,
    activeChains: Array.from(activeChains),
  }), [alerts, filtered.length, visible.length, hasMore, loadMoreClicks, activeFilter, activeChains])

  useEffect(() => {
    console.debug('[pumpAlertsUiAudit]', pumpAlertsUiAudit)
  }, [pumpAlertsUiAudit])

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!canAccessFeature(plan, 'pump-alerts')) return <LockedPanel feature="pump-alerts" />

  return (
    <>
      <style>{`
        @keyframes pumpSlideIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(236,72,153,0.6); }
          50%       { opacity: 0.6; box-shadow: 0 0 0 5px rgba(236,72,153,0); }
        }
        @keyframes spinRefresh {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes tagPulse {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-1px) scale(1.035); }
        }
        @keyframes clarkIntelGlow {
          0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.055), 0 0 22px rgba(168,85,247,0.070), 0 0 34px rgba(45,212,191,0.045); }
          50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.065), 0 0 28px rgba(168,85,247,0.105), 0 0 44px rgba(34,211,238,0.060); }
        }
        @keyframes flameMomentumPulse {
          0%, 100% { transform: scale(1); opacity: 0.18; }
          50% { transform: scale(1.018); opacity: 0.28; }
        }
        .pump-card { position: relative; isolation: isolate; }
        .pump-card::before {
          content: '';
          position: absolute;
          inset: 10px auto 10px 0;
          width: 4px;
          border-radius: 0 999px 999px 0;
          background: linear-gradient(180deg, var(--pump-identity-color), rgba(168,85,247,0.72), rgba(34,211,238,0.46));
          box-shadow: 0 0 16px color-mix(in srgb, var(--pump-identity-color) 36%, transparent), 0 0 26px rgba(45,212,191,0.055);
          opacity: 0.86;
          z-index: 1;
        }
        .pump-card > * { position: relative; z-index: 2; }
        .pump-flame { position: relative; display: inline-flex; align-items: center; justify-content: center; }
        .pump-flame::before {
          content: '';
          position: absolute;
          inset: -4px;
          border-radius: 999px;
          background: radial-gradient(circle, rgba(34,211,238,0.16), rgba(168,85,247,0.055) 42%, transparent 70%);
          animation: flameMomentumPulse 3.8s ease-in-out infinite;
          z-index: -1;
        }
        .pump-pill { transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease; }
        .pump-pill:hover { animation: tagPulse 760ms ease-in-out; box-shadow: 0 0 16px rgba(45,212,191,0.10), 0 0 22px rgba(168,85,247,0.08); }
        .pump-action-btn:hover { transform: translateY(-2px) scale(1.045) !important; box-shadow: 0 0 18px rgba(45,212,191,0.20), 0 0 22px rgba(168,85,247,0.12) !important; }
        .pump-clark-preview { max-height: 0; opacity: 0; overflow: hidden; transform: translateY(-4px); transition: max-height 220ms ease, opacity 180ms ease, transform 180ms ease; }
        .pump-card:hover .pump-clark-preview { max-height: 74px; opacity: 1; transform: translateY(0); }
        .pump-card:hover .pump-clark-intel { animation: clarkIntelGlow 3.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .pump-card, .pump-pill, .pump-action-btn, .pump-clark-preview, .pump-card:hover .pump-clark-intel, .pump-flame::before { animation: none !important; transition: none !important; }
        }
        @media (max-width: 768px) {
          /* 60px top clears the fixed hamburger button (top:12 + height:36 + 12 buffer) */
          .pump-main        { padding: 60px 12px 120px !important; }
          /* target the actual grid div inside SummaryStrip */
          .pump-strip > div { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
          .pump-header-row  { padding-left: 0 !important; }
          /* MOBILE FIX, DISCLOSED (requested: "no horizontal overflow"): 340px minmax columns are too
             wide to fit a ~375-414px viewport once the page's own side padding is subtracted, so force
             a single column below the tablet breakpoint rather than letting auto-fill try to squeeze
             a second narrow column. */
          .pump-card-grid-container { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 640px) {
          /* Cards stack cleanly: identity/badges wrap onto their own lines, metric grid drops to 3
             columns so labels/values stay readable instead of being clipped, actions stay a full-width
             row of equal-width buttons. */
          .pump-card-top    { flex-wrap: wrap !important; row-gap: 8px !important; }
          .pump-card-top > div:last-child { max-width: 100% !important; justify-content: flex-start !important; }
          .pump-card-grid   { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
          .pump-card-actions { flex-wrap: wrap !important; }
        }
      `}</style>

      <div className="pump-main" style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '28px 32px 120px', color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>

        {/* Header */}
        <div style={{ marginBottom: '20px' }}>
          <div className="pump-header-row" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#f8fafc', margin: 0, letterSpacing: '-0.01em' }}>
              Pump Alerts
            </h1>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '4px 10px', borderRadius: '99px',
              background: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.30)',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#ec4899',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ec4899', animation: 'livePulse 1.8s ease-in-out infinite', flexShrink: 0 }} />
              LIVE
            </span>
          </div>
          <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px' }}>
            Ranked by momentum, volume, liquidity, and CORTEX quality filters. Not financial advice.
          </p>

          <div className="pump-strip">
            <SummaryStrip alerts={alerts} />
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
              Refresh in {countdown}s
            </span>
            <button
              onClick={() => { setCountdown(60); fetchAlerts() }}
              disabled={loading}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '5px 12px', borderRadius: '8px',
                background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.20)',
                color: loading ? '#3a5268' : '#2DD4BF',
                fontSize: '10px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'
                style={{ animation: loading ? 'spinRefresh 0.8s linear infinite' : 'none' }}>
                <path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' />
                <path d='M21 3v5h-5' />
                <path d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' />
                <path d='M8 16H3v5' />
              </svg>
              {loading ? 'Scanning…' : 'Refresh'}
            </button>
            {fetchedAt && (
              <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
                Updated {new Date(fetchedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Filter chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {FILTER_CHIPS.map(chip => {
              const active = chip.key === activeFilter
              const color = chip.key !== 'ALL' ? CATEGORY_COLOR[chip.key as PumpCategory] : '#2DD4BF'
              return (
                <button
                  key={chip.key}
                  onClick={() => setActiveFilter(chip.key)}
                  style={{
                    padding: '5px 11px', borderRadius: '99px', fontSize: '9px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', cursor: 'pointer',
                    border: `1px solid ${active ? `${color}55` : 'rgba(255,255,255,0.10)'}`,
                    background: active ? `${color}1c` : 'rgba(255,255,255,0.03)',
                    color: active ? color : '#94a3b8',
                    fontFamily: 'var(--font-plex-mono)',
                    boxShadow: active ? `0 0 12px ${color}18` : 'none',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  }}
                >
                  {chip.label}
                  {chip.key !== 'ALL' && (
                    <span style={{ marginLeft: '5px', opacity: 0.60 }}>
                      {alerts.filter(a => a.category === chip.key).length}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Chain selector, DISCLOSED: toggles which chains /api/pump-alerts scans. At least one
              chain must stay on — the API treats an empty set as "no enabled chains requested". */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', margin: '8px 0 4px' }}>
            <span style={{ fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em', textTransform: 'uppercase' }}>
              Chains
            </span>
            {CHAIN_CHIPS.map(chip => {
              const active = activeChains.has(chip.key)
              return (
                <button
                  key={chip.key}
                  onClick={() => {
                    const nextChains = (() => {
                      const next = new Set(activeChains)
                      if (next.has(chip.key)) {
                        if (next.size === 1) return null // keep at least one chain
                        next.delete(chip.key)
                      } else {
                        next.add(chip.key)
                      }
                      return Array.from(next)
                    })()
                    if (!nextChains) return
                    setActiveChains(new Set(nextChains))
                    chainParamRef.current = nextChains
                    setCountdown(120)
                    fetchAlerts()
                  }}
                  aria-pressed={active}
                  style={{
                    padding: '5px 11px', borderRadius: '99px', fontSize: '9px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(45,212,191,0.40)' : 'rgba(255,255,255,0.10)'}`,
                    background: active ? 'rgba(45,212,191,0.14)' : 'rgba(255,255,255,0.03)',
                    color: active ? '#2DD4BF' : '#94a3b8',
                    fontFamily: 'var(--font-plex-mono)',
                    boxShadow: active ? '0 0 12px rgba(45,212,191,0.16)' : 'none',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  }}
                >
                  {chip.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Feed */}
        <div>
          <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px' }}>
            Alerts {filtered.length > 0 && `— ${filtered.length}`}
          </p>

          {/* Provider/data failure — always visible, never silently swallowed. Rendered above the
              feed so a stale-but-shown list is never mistaken for a fresh complete one. */}
          {feedError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px', marginBottom: '10px', borderRadius: '10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.28)', fontFamily: 'var(--font-plex-mono)' }}>
              <span style={{ color: '#fbbf24', fontSize: '12px' }}>△</span>
              <span style={{ fontSize: '10.5px', color: '#fbbf24', lineHeight: 1.35 }}>{feedError}</span>
            </div>
          )}

          {/* DEGRADED MODE BANNER, DISCLOSED: distinct from feedError — this fires when the scan
              itself succeeded but the primary 14d provider failed and live-momentum evidence was
              used (or produced nothing). Shown even when cards rendered below it. */}
          {degradedNote && !feedError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px', marginBottom: '10px', borderRadius: '10px', background: 'rgba(251,191,36,0.06)', border: '1px dashed rgba(251,191,36,0.30)', fontFamily: 'var(--font-plex-mono)' }}>
              <span style={{ color: '#fbbf24', fontSize: '12px' }}>◐</span>
              <span style={{ fontSize: '10.5px', color: '#d4b106', lineHeight: 1.35 }}>
                {degradedNote} Cards labelled “Exact 14d” carry measured data; “Live Momentum” cards are qualified by real, currently-observable 24h/6h/1h momentum instead.
              </span>
            </div>
          )}

          {/* Background refresh indicator — the feed stays on screen underneath it. */}
          {refreshing && !loading && (
            <div style={{ fontSize: '9.5px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', marginBottom: '8px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Refreshing — showing last results
            </div>
          )}

          {/* Loading skeletons */}
          {loading && alerts.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
              {[...Array(7)].map((_, i) => (
                <div key={i} style={{ height: '66px', borderRadius: '10px', borderLeft: '3px solid rgba(45,212,191,0.18)', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', animation: 'pumpSlideIn 0.3s ease both', animationDelay: `${i * 55}ms` }} />
              ))}
            </div>
          )}

          {/* TRUTHFUL, SPECIFIC EMPTY STATE, DISCLOSED (URGENT fix request): 5 distinguishable empty
              reasons instead of a single undifferentiated "no pump signals" — and, whenever the
              backend sent one, the full candidate funnel breakdown so "why is this empty" never
              requires a second round-trip to ask. An outage never reads as "nothing pumped". */}
          {!loading && filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 20px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
              <div style={{ fontSize: '32px', marginBottom: '14px', opacity: 0.35 }}>{degradedNote || finalState === 'providerUnavailable' ? '◐' : '◈'}</div>
              <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 6px', color: '#64748b' }}>
                {activeFilter !== 'ALL' && activeFilter in CATEGORY_LABEL
                  ? `No ${CATEGORY_LABEL[activeFilter as PumpCategory]} signals right now.`
                  : degradedNote ? 'No pump signals could be verified this cycle.'
                  : finalState === 'providerUnavailable' ? 'Providers failed — could not reach GeckoTerminal for any requested chain.'
                  : finalState === 'noRawCandidates' ? 'No candidates found — providers returned zero pools for the requested chains.'
                  : finalState === 'noEligibleLowCapCandidates' ? 'No eligible low-cap candidates this cycle — everything found was a major, stable, wrapped asset, or over the FDV ceiling.'
                  : finalState === 'providerBudgetExhausted' ? 'Evaluation budget reached before enough candidates could be checked this cycle.'
                  : finalState === 'allCandidatesExhaustedNoMomentum' ? 'Checked every eligible candidate this cycle — none confirmed a real pump.'
                  : 'No fresh pump signals passed the quality filter.'}
              </p>
              <p style={{ fontSize: '11px', margin: '0 0 14px', color: '#3a5268' }}>
                {degradedNote
                  ? 'The primary 14-day provider failed and no live momentum evidence confirmed a real mover this cycle. Refresh shortly — live 24h/6h/1h momentum evidence is used automatically whenever exact evidence is unavailable.'
                  : finalState === 'providerUnavailable'
                    ? 'This is a provider issue, not a filtering result — try refreshing shortly.'
                    : finalState === 'providerBudgetExhausted'
                      ? 'There may be more real candidates the next refresh will reach — this cycle stopped early to stay within its evaluation budget, not because nothing else exists.'
                      : 'Try refreshing or widening the watchlist.'}
              </p>
              {/* CANDIDATE-FUNNEL BREAKDOWN, DISCLOSED: only shown for a real empty result (not a
                  category filter with 0 matches) and only when the backend actually sent one. */}
              {activeFilter === 'ALL' && candidateAudit && (
                <div style={{
                  display: 'inline-grid', gridTemplateColumns: 'repeat(3, minmax(120px, 1fr))', gap: '6px',
                  padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)', fontSize: '9.5px', textAlign: 'left',
                }}>
                  {[
                    ['Raw candidates', candidateAudit.rawCandidates],
                    ['Filtered: major/stable', candidateAudit.categoryFiltered],
                    ['Passed low-cap filter', candidateAudit.lowCapCandidates],
                    ['Passed liquidity/volume', candidateAudit.liquidityVolumeCandidates],
                    ['Evidence-checked', candidateAudit.candidatesEvaluated],
                    ['Skipped (OHLCV budget)', candidateAudit.candidatesSkippedBeforeOhlcv],
                    ['GeckoTerminal', `${candidateAudit.geckoSuccesses}/${candidateAudit.geckoAttempts}`],
                    ['DexScreener', `${candidateAudit.dexFallbackSuccesses}/${candidateAudit.dexFallbackAttempts}`],
                    ['CoinGecko', `${candidateAudit.coinGeckoSuccesses}/${candidateAudit.coinGeckoAttempts}`],
                    ['Snapshots', `${candidateAudit.internalSnapshotSuccesses}/${candidateAudit.internalSnapshotAttempts}`],
                    ['Qualified (exact)', candidateAudit.qualifiedExact7d],
                    ['Qualified (momentum)', candidateAudit.qualifiedMomentumFallback],
                  ].map(([label, value]) => (
                    <div key={label as string} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ color: '#3a5268', letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: '8px' }}>{label}</span>
                      <span style={{ color: '#7c94ab', fontWeight: 700 }}>{value}</span>
                    </div>
                  ))}
                  <div style={{ gridColumn: '1 / -1', marginTop: '4px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.06)', color: '#3a5268' }}>
                    Stopped: {candidateAudit.stoppedReason === 'targetReached' ? 'target reached'
                      : candidateAudit.stoppedReason === 'budgetExhausted' ? 'evaluation budget exhausted'
                      : 'all eligible candidates exhausted'}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Low-count notice */}
          {!loading && alerts.length > 0 && alerts.length < 10 && (
            <p style={{ fontSize: '9.5px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px', padding: '5px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              Limited fresh candidates right now — refresh shortly for more.
            </p>
          )}

          {/* CARD GRID, DISCLOSED (requested: cards feel too wide/heavy): a responsive grid instead
              of a single full-width column — cards narrow to a sensible width and multiple sit
              side-by-side on wide screens, collapsing to one column on mobile via the media query
              below. */}
          <div className="pump-card-grid-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '11px' }}>
            {visible.map((alert, i) => (
              <div key={alert.contract} style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                <AlertCard
                  alert={alert}
                  onScan={() => openToken(alert)}
                  onAskClark={() => openClark(alert)}
                  onReport={() => openReport(alert)}
                  onCopyCA={() => copyCA(alert.contract)}
                  copied={copiedContract === alert.contract.toLowerCase()}
                />
              </div>
            ))}
          </div>

          {/* LOAD MORE, DISCLOSED: purely client-side pagination over the already-fetched alerts —
              never a new network request. Hidden once every filtered alert is on screen. */}
          {filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginTop: '16px' }}>
              <p style={{ margin: 0, fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.04em' }}>
                Showing {visible.length} of {filtered.length}
              </p>
              {hasMore ? (
                <button
                  onClick={handleLoadMore}
                  disabled={loadMoreLoading}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '7px',
                    padding: '9px 20px', borderRadius: '999px',
                    background: 'rgba(45,212,191,0.09)', border: '1px solid rgba(45,212,191,0.28)',
                    color: loadMoreLoading ? '#3a5268' : '#2DD4BF',
                    fontSize: '10.5px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                    cursor: loadMoreLoading ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-plex-mono)',
                    transition: 'background 0.15s ease, border-color 0.15s ease',
                  }}
                >
                  {loadMoreLoading && (
                    <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round' style={{ animation: 'spinRefresh 0.8s linear infinite' }}>
                      <path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' />
                      <path d='M21 3v5h-5' />
                      <path d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' />
                      <path d='M8 16H3v5' />
                    </svg>
                  )}
                  {loadMoreLoading ? 'Loading…' : 'Load More'}
                </button>
              ) : (
                <p style={{ margin: 0, fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
                  All current pump candidates shown.
                </p>
              )}
            </div>
          )}

          {/* Disclaimer */}
          {filtered.length > 0 && (
            <p style={{ marginTop: '20px', fontSize: '10px', color: '#2d3f52', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '14px' }}>
              Pump Alerts surface tokens meeting momentum thresholds based on live CORTEX market data. This is not financial advice. Always verify independently before acting.
            </p>
          )}
        </div>
      </div>
    </>
  )
}

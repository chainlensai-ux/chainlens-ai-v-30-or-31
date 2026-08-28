'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export type PumpCategory = 'HIGH_MOMENTUM' | 'VOLUME_EXPANSION' | 'THIN_MOONSHOT' | 'WATCH'
export type PumpRisk = 'HIGH' | 'MEDIUM' | 'LOW'

export interface PumpAlert {
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
  // EVIDENCE BADGE, DISCLOSED: every card states HOW it qualified — 'exact' means a real measured
  // 7d/14d change backs it (this feed never fetches one — see route.ts's module header); 'live_momentum'
  // means real, currently-observable 24h/6h/1h momentum + volume-relative-to-liquidity evidence
  // qualified it instead. Never rendered identically — a live-momentum card must never be labelled
  // "Exact 7d".
  evidenceSource?: 'exact' | 'live_momentum'
  evidenceGrade?: 'exact' | 'live_momentum'
  category: PumpCategory
  reason: string
  qualifyingReason: string
  riskLevel: PumpRisk
  tags: string[]
  priceChange24hPct?: number | null
  priceChange6hPct?: number | null
  priceChange1hPct?: number | null
}

export type FilterKey = 'ALL' | PumpCategory

// LIVE-PUMP-DISCOVERY REWRITE, DISCLOSED ("STOP overcomplicating Pump Alerts... I want a live
// pump discovery feed"): the backend no longer runs a multi-tier exact-14d evidence ladder — one
// synchronous eligibility pass over live discovery data, so this audit is the simple rejection
// breakdown the new pipeline actually produces: "1 of X candidates qualified" plus exactly why the
// rest didn't (majors/stables, over cap, missing cap data, low liquidity, low volume, no momentum).
export interface PumpFeedAudit {
  rawCandidates: number
  qualified: number
  rejectedMajorStableWrapped: number
  rejectedOverCap: number
  rejectedCapDataMissing: number
  rejectedLowLiquidity: number
  rejectedLowVolume: number
  rejectedNoMomentum: number
}

export const CATEGORY_LABEL: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'High Momentum',
  VOLUME_EXPANSION: 'Vol Expansion',
  THIN_MOONSHOT: 'Thin Liquidity',
  WATCH: 'Watchlist',
}

export const CATEGORY_COLOR: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: '#22d3ee',
  VOLUME_EXPANSION: '#a855f7',
  THIN_MOONSHOT: '#f97316',
  WATCH: '#2DD4BF',
}

export const CATEGORY_BG: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'rgba(34,211,238,0.12)',
  VOLUME_EXPANSION: 'rgba(168,85,247,0.12)',
  THIN_MOONSHOT: 'rgba(249,115,22,0.12)',
  WATCH: 'rgba(45,212,191,0.10)',
}

export const CATEGORY_BORDER: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'rgba(34,211,238,0.32)',
  VOLUME_EXPANSION: 'rgba(168,85,247,0.30)',
  THIN_MOONSHOT: 'rgba(249,115,22,0.30)',
  WATCH: 'rgba(45,212,191,0.26)',
}

export const RISK_COLOR: Record<PumpRisk, string> = {
  HIGH: '#f87171',
  MEDIUM: '#fbbf24',
  LOW: '#4ade80',
}

export const RISK_BG: Record<PumpRisk, string> = {
  HIGH: 'rgba(248,113,113,0.12)',
  MEDIUM: 'rgba(251,191,36,0.12)',
  LOW: 'rgba(74,222,128,0.10)',
}

export const RISK_LABEL: Record<PumpRisk, string> = {
  HIGH: 'HIGH RISK',
  MEDIUM: 'WATCH RISK',
  LOW: 'LOWER RISK',
}

// CHAIN-VISIBILITY FIX, DISCLOSED (requested: "make the chain easy to see"). Chain used to be a
// small lowercase mono string buried in the metric grid's last cell, truncating on narrow cards
// ("robinho…") — the same information a viewer needs first, at a glance, to know where a contract
// lives. Gives each chain its own color and a short, non-truncating label so it reads as a proper
// badge instead of clipped text.
export const CHAIN_LABEL: Record<'base' | 'eth' | 'robinhood', string> = {
  base: 'BASE',
  eth: 'ETH',
  robinhood: 'ROBINHOOD',
}

export const CHAIN_COLOR: Record<'base' | 'eth' | 'robinhood', string> = {
  base: '#3b82f6',
  eth: '#a78bfa',
  robinhood: '#22c55e',
}

export const CHAIN_BG: Record<'base' | 'eth' | 'robinhood', string> = {
  base: 'rgba(59,130,246,0.12)',
  eth: 'rgba(167,139,250,0.12)',
  robinhood: 'rgba(34,197,94,0.12)',
}

export const CHAIN_BORDER: Record<'base' | 'eth' | 'robinhood', string> = {
  base: 'rgba(59,130,246,0.34)',
  eth: 'rgba(167,139,250,0.32)',
  robinhood: 'rgba(34,197,94,0.32)',
}

export const FILTER_CHIPS: Array<{ key: FilterKey; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'HIGH_MOMENTUM', label: 'High Momentum' },
  { key: 'VOLUME_EXPANSION', label: 'Vol Expansion' },
  { key: 'WATCH', label: 'Watchlist' },
  { key: 'THIN_MOONSHOT', label: 'Thin Liquidity' },
]

export function fmtUSD(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

export function fmtPrice(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1) return `$${v.toFixed(4)}`
  if (v >= 0.0001) return `$${v.toFixed(6)}`
  // Tiny prices: show 4 significant figures in plain decimal (never scientific notation)
  const decimals = Math.min(-Math.floor(Math.log10(v)) + 3, 12)
  return `$${v.toFixed(decimals)}`
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function fmtAge(days: number | null): string {
  if (days == null) return '—'
  if (days < 1) return `${(days * 24).toFixed(1)}h`
  return `${Math.round(days)}d`
}


export function fdvTier(v: number | null): { color: string; bg: string; border: string; label: string; glow: string } {
  if (v == null) return { color: '#94a3b8', bg: 'linear-gradient(135deg, rgba(100,116,139,0.13), rgba(148,163,184,0.055))', border: 'rgba(148,163,184,0.18)', label: 'FDV open', glow: 'rgba(148,163,184,0.08)' }
  if (v < 500_000) return { color: '#4ade80', bg: 'linear-gradient(135deg, rgba(74,222,128,0.12), rgba(45,212,191,0.050))', border: 'rgba(74,222,128,0.28)', label: 'Low FDV', glow: 'rgba(74,222,128,0.12)' }
  if (v < 5_000_000) return { color: '#22d3ee', bg: 'linear-gradient(135deg, rgba(34,211,238,0.13), rgba(45,212,191,0.045))', border: 'rgba(34,211,238,0.28)', label: 'Mid FDV', glow: 'rgba(34,211,238,0.12)' }
  return { color: '#c084fc', bg: 'linear-gradient(135deg, rgba(192,132,252,0.13), rgba(168,85,247,0.050))', border: 'rgba(192,132,252,0.30)', label: 'High FDV', glow: 'rgba(192,132,252,0.13)' }
}

// CARD POLISH, DISCLOSED (requested: cards feel too wide/heavy, unclear hierarchy, no Market Cap).
// One compact metric cell for the grid — label above, value below, uniform sizing so the 10-metric
// grid (Price/24h/6h/1h/Vol/Liq/MCap/FDV/Age/Chain) stays aligned and scannable in ~5 seconds.
export function GridMetric({ label, value, dim, strong, color }: { label: string; value: string; dim?: boolean; strong?: boolean; color?: string }) {
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

export function AlertCard({ alert, onScan, onAskClark, onReport, onCopyCA, onHoverPrefetch, copied }: {
  alert: PumpAlert
  onScan: () => void
  onAskClark: () => void
  onReport: () => void
  onCopyCA: () => void
  onHoverPrefetch: () => void
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
      onMouseEnter={() => { setHovered(true); onHoverPrefetch() }}
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
          {/* EVIDENCE BADGE, DISCLOSED: states exactly how this card qualified. This feed never
              fetches exact 7d/14d evidence (see route.ts's module header) — every card qualifies on
              live momentum, labelled honestly. The "Exact 7d" branch is kept for a future exact
              source; it never renders today. */}
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
              ✓ Exact 7d
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
        <GridMetric label="Age" value={fmtAge(alert.tokenAgeDays)} dim={alert.tokenAgeDays == null} />
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

export function SummaryStrip({ alerts }: { alerts: PumpAlert[] }) {
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

// INSTANT-REPORT-NAV FIX, DISCLOSED (reported live: "Clicking Report takes ~4 seconds before route
// changes"). Root cause: router.push() alone never prefetches a route's JS chunk the way a <Link>
// in the viewport does, so the first navigation to /terminal/pump-alerts/report paid the full
// fetch+compile cost synchronously in the browser before the URL/content changed. Fixed by (1)
// prefetching the route on card hover, so by click time the chunk is usually already warm, and (2)
// writing the full card payload to sessionStorage and calling router.push() synchronously — no
// await, nothing blocks navigation — so the report page can render real metrics from that seed the
// instant it mounts, instead of waiting on its own API call.
//
// Defined at module scope (not inside the component) rather than as inline closures: they call
// Date.now()/performance.now(), and the React Compiler's purity rule flags impure calls reachable
// from a component's render body even when, as here, they only ever execute inside an event handler
// — moving them out of the component avoids that false positive without disabling the rule.
export type PumpAlertsRouter = ReturnType<typeof useRouter>

export function reportSeedKey(chain: string, contract: string): string {
  return `pumpReportSeed:${chain}:${contract.toLowerCase()}`
}

export function reportUrlFor(alert: PumpAlert): string {
  const qs = new URLSearchParams({
    contract: alert.contract,
    chain: alert.chain,
    symbol: alert.symbol,
    name: alert.name,
    reason: alert.reason,
    riskLevel: alert.riskLevel,
    ...(alert.priceUsd != null ? { priceUsd: String(alert.priceUsd) } : {}),
    ...(alert.change24h != null ? { change24h: String(alert.change24h) } : {}),
    ...(alert.change6h != null ? { change6h: String(alert.change6h) } : {}),
    ...(alert.change1h != null ? { change1h: String(alert.change1h) } : {}),
    ...(alert.volume24hUsd != null ? { volume24hUsd: String(alert.volume24hUsd) } : {}),
    ...(alert.liquidityUsd != null ? { liquidityUsd: String(alert.liquidityUsd) } : {}),
    ...(alert.fdvUsd != null ? { fdvUsd: String(alert.fdvUsd) } : {}),
    ...(alert.change14d != null ? { change14d: String(alert.change14d) } : {}),
    ...(alert.marketCapUsd != null ? { marketCapUsd: String(alert.marketCapUsd) } : {}),
    ...(typeof alert.tokenAgeDays === 'number' ? { tokenAgeDays: String(alert.tokenAgeDays) } : {}),
    ...(alert.pairAddress ? { pairAddress: alert.pairAddress } : {}),
    ...(alert.evidenceGrade ? { evidenceGrade: alert.evidenceGrade } : {}),
  })
  return `/terminal/pump-alerts/report?${qs.toString()}`
}

export function prefetchReportForAlert(router: PumpAlertsRouter, prefetched: Set<string>, alert: PumpAlert) {
  const url = reportUrlFor(alert)
  if (prefetched.has(url)) return
  prefetched.add(url)
  try { router.prefetch(url) } catch { /* best-effort — a failed prefetch never blocks the click-time push */ }
}

export function openReportForAlert(router: PumpAlertsRouter, prefetched: Set<string>, alert: PumpAlert) {
  const clickStart = performance.now()
  const url = reportUrlFor(alert)
  const usedPrefetch = prefetched.has(url)
  let seedPayloadAvailable = false
  // PUMP-REPORT DATA-FLOW FIX, DISCLOSED (requested: "Report must seed from Pump Alert card payload
  // first"). The full card payload — everything the report's live-evidence scoring needs (24h/6h/1h
  // change, volume, liquidity, FDV, market cap, pool age, pair address, evidence mode) — is written
  // to sessionStorage keyed by chain+contract BEFORE router.push, so the report page can render real
  // metrics on its very first paint rather than a blank/generic skeleton.
  try {
    sessionStorage.setItem(reportSeedKey(alert.chain, alert.contract), JSON.stringify({
      symbol: alert.symbol, name: alert.name, contract: alert.contract, chain: alert.chain,
      priceUsd: alert.priceUsd, change24h: alert.change24h, change6h: alert.change6h, change1h: alert.change1h,
      volume24hUsd: alert.volume24hUsd, liquidityUsd: alert.liquidityUsd, fdvUsd: alert.fdvUsd,
      marketCapUsd: alert.marketCapUsd, tokenAgeDays: alert.tokenAgeDays, pairAddress: alert.pairAddress,
      evidenceGrade: alert.evidenceGrade ?? null, reason: alert.reason, riskLevel: alert.riskLevel,
      navStartedAt: Date.now(), usedPrefetch,
    }))
    seedPayloadAvailable = true
  } catch { /* sessionStorage unavailable (private mode, quota) — report page falls back to URL params */ }
  // Navigation must never wait on anything — no await above, router.push is the very next call.
  router.push(url)
  console.debug('[pumpReportNavigationAudit:click]', {
    tokenAddress: alert.contract, chainSlug: alert.chain,
    clickToRouterPushMs: performance.now() - clickStart,
    seedPayloadAvailable, blockedNavigation: false, usedPrefetch,
  })
}

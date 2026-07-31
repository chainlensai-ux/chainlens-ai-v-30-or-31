'use client'

// WalletPersonalityCard — premium, 3-zone Wallet Personality section for the Wallet Scanner V3
// layout. VISUAL REDESIGN ONLY, DISCLOSED: this file changes presentation only — every number,
// classification, and fallback state still comes from app/frontend/lib/walletPersonality.ts's
// deriveWalletPersonality (unchanged data logic, unchanged PnL safety, unchanged fallback
// behavior, no new provider calls). See that module's own header for the full data-grounding
// disclosure.
//
// ALWAYS RENDERS, DISCLOSED: this card never returns null and never blocks on
// report.finalSummary.financialStatus.officialPnlStatus — deriveWalletPersonality always returns a
// real, safe object (falling back to an honest "General User" / insufficient-evidence profile for
// a wallet with zero real transactions) so this card renders after every successful scan.
//
// NO FALSE ZEROS / NO FAKE PRECISION, DISCLOSED: every metric is rendered through fmtMetric/
// fmtPercent/RadarMeter below, which render `null` as "Unknown"/"Insufficient evidence" — never as
// a literal 0/0%/a fabricated bar length. Win rate is only ever shown when
// profitEvidence.evaluatedCount > 0, and the limited-sample win rate is always explicitly labeled
// "Not the wallet's official overall win rate."
import type { WalletPersonalitySourceReport, TradingStyle, RiskClass } from '@/app/frontend/lib/walletPersonality'
import { deriveWalletPersonality, fmtHoldingDays } from '@/app/frontend/lib/walletPersonality'
import { StatusBadge } from './StatusBadge'

export const WALLET_PERSONALITY_CARD_ID = 'wallet-personality-card'

export type WalletPersonalityCardProps = {
  report: WalletPersonalitySourceReport
}

// PALETTE, DISCLOSED — exactly the tokens this task specified, used deliberately (glow/depth/
// contrast, not borders on everything — only the hero glow and a handful of accent chips use full
// saturation).
const TEAL = '#53F3C3'
const PURPLE = '#B666F3'
const PINK = '#E053C2'
const WHITE = '#FFFFFF'
const SLATE = '#7A8A9E'
const BLUE_GLOW = '#1D3B5A'

function fmtMetric(v: number | null, suffix = ''): string {
  if (v == null || !Number.isFinite(v)) return 'Unknown'
  return `${Math.round(v).toLocaleString()}${suffix}`
}

function fmtPercent(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return 'Unknown'
  return `${v.toFixed(0)}%`
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'Unknown'
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return 'Unknown'
  }
}

function confidenceTone(confidence: 'high' | 'medium' | 'low'): 'success' | 'warning' | 'neutral' {
  if (confidence === 'high') return 'success'
  if (confidence === 'medium') return 'warning'
  return 'neutral'
}

const EVIDENCE_BASIS_LABEL: Record<string, string> = {
  behavior_verified: 'Behavior verified',
  behavior_only: 'Behavior only',
  behavior_plus_pnl: 'Behavior + PnL',
  limited_evidence: 'Limited evidence',
}

// EMBLEM, DISCLOSED: a deterministic icon+accent chosen purely from real classification fields
// already on WalletPersonalityData (trader style + automation + risk) — never a new data source,
// never randomized, so the same wallet always gets the same emblem.
function emblemFor(automation: TradingStyle, risk: RiskClass): { glyph: string; accent: string } {
  if (automation === 'Highly automated' || automation === 'Bot-like') return { glyph: '⚙', accent: PURPLE } // gear
  if (risk === 'High risk behavior') return { glyph: '⚡', accent: PINK } // bolt
  if (automation === 'Assisted trader') return { glyph: '◈', accent: TEAL } // diamond
  return { glyph: '◆', accent: TEAL } // solid diamond — default "manual" glyph
}

function CheckIcon({ color }: { color: string }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function WatchIcon({ color }: { color: string }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  )
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 11px', borderRadius: '999px',
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', fontSize: '11px',
  fontWeight: 600, color: 'rgba(226,232,240,0.85)',
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span style={chipStyle}>
      <span style={{ color: SLATE, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span>{value}</span>
    </span>
  )
}

// TRAIT HIGHLIGHT, DISCLOSED: 4 larger cards for the primary classification (Trading Style, Risk
// Profile, Automation, Holding Pattern) — a distinct accent color per category (never every card
// the same purple), soft top-border glow instead of a full outline for depth.
function TraitHighlight({ label, value, accent, icon }: { label: string; value: string; accent: string; icon: string }) {
  return (
    <div
      style={{
        flex: '1 1 190px', minWidth: '170px', padding: '14px 16px', borderRadius: '14px',
        background: `linear-gradient(160deg, ${accent}14, rgba(255,255,255,0.02))`,
        border: '1px solid rgba(255,255,255,0.06)', borderTop: `2px solid ${accent}66`,
        boxShadow: `0 6px 18px -8px ${accent}33`,
      }}
    >
      <div style={{ fontSize: '15px', marginBottom: '6px' }}>{icon}</div>
      <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: SLATE, marginBottom: '4px' }}>
        {label}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 800, color: WHITE }}>{value}</div>
    </div>
  )
}

const RADAR_AXES: Array<{ key: 'activity' | 'risk' | 'automation' | 'rotation' | 'conviction'; label: string; accent: string }> = [
  { key: 'activity', label: 'Activity', accent: TEAL },
  { key: 'risk', label: 'Risk', accent: PINK },
  { key: 'automation', label: 'Automation', accent: PURPLE },
  { key: 'rotation', label: 'Rotation', accent: TEAL },
  { key: 'conviction', label: 'Conviction', accent: PURPLE },
]

// TRAIT METER, DISCLOSED: a horizontal bar rendering a [0,1] normalized value — a `null` value
// (genuinely unknown signal) NEVER renders a bar at all, only the honest "Insufficient evidence"
// label, so nothing here implies a precision the underlying data doesn't have.
function TraitMeter({ label, value, accent }: { label: string; value: number | null; accent: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{ width: '78px', fontSize: '10px', fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>
        {label}
      </div>
      <div style={{ flex: 1, height: '7px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', position: 'relative' }}>
        {value != null && (
          <div style={{ width: `${Math.round(value * 100)}%`, height: '100%', borderRadius: '999px', background: `linear-gradient(90deg, ${accent}, ${accent}99)`, boxShadow: `0 0 8px ${accent}66` }} />
        )}
      </div>
      <div style={{ width: '80px', fontSize: '11px', fontWeight: 700, color: value == null ? SLATE : WHITE, textAlign: 'right', flexShrink: 0 }}>
        {value == null ? 'Insufficient evidence' : `${Math.round(value * 100)}%`}
      </div>
    </div>
  )
}

function Stat({ label, value, emphasized }: { label: string; value: string; emphasized?: boolean }) {
  return (
    <div style={{ minWidth: emphasized ? '128px' : '104px' }}>
      <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: SLATE }}>{label}</div>
      <div style={{ fontSize: emphasized ? '18px' : '13px', fontWeight: emphasized ? 900 : 700, color: emphasized ? WHITE : 'rgba(226,232,240,0.75)', marginTop: '3px' }}>
        {value}
      </div>
    </div>
  )
}

export function WalletPersonalityCard({ report }: WalletPersonalityCardProps) {
  const data = deriveWalletPersonality(report)
  const emblem = emblemFor(data.classification.automation, data.classification.risk)

  return (
    <section
      id={WALLET_PERSONALITY_CARD_ID}
      style={{
        width: '100%', position: 'relative', overflow: 'hidden', background: 'linear-gradient(180deg, #060a12, #05070d)',
        border: '1px solid rgba(255,255,255,0.07)', borderRadius: '18px',
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 28px -10px rgba(0,0,0,0.55)`,
        marginBottom: '16px', scrollMarginTop: '90px',
      }}
    >
      {/* ===== ZONE 1 — TOP HERO ===== */}
      <div style={{ position: 'relative', padding: '26px 26px 20px' }}>
        {/* Soft teal/purple/pink glow — HERO ONLY, disclosed: absolutely positioned behind this
            block's own content, never bleeding into the rest of the card below. */}
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
            background: `radial-gradient(60% 140% at 12% 20%, ${TEAL}22, transparent 60%),
                         radial-gradient(50% 120% at 55% -10%, ${PURPLE}1c, transparent 65%),
                         radial-gradient(45% 110% at 90% 40%, ${PINK}18, transparent 60%),
                         radial-gradient(80% 100% at 50% 100%, ${BLUE_GLOW}55, transparent 70%)`,
          }}
        />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
          {/* Emblem */}
          <div
            style={{
              width: '52px', height: '52px', borderRadius: '16px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '22px', background: `linear-gradient(145deg, ${emblem.accent}33, rgba(255,255,255,0.03))`,
              border: `1px solid ${emblem.accent}55`, boxShadow: `0 0 24px -4px ${emblem.accent}66`, color: emblem.accent,
            }}
          >
            {emblem.glyph}
          </div>

          <div style={{ flex: '1 1 260px', minWidth: '220px' }}>
            <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: SLATE, marginBottom: '5px' }}>
              Wallet Personality
            </div>
            <h2 style={{ margin: '0 0 4px', fontSize: '23px', fontWeight: 900, color: WHITE, fontFamily: 'var(--font-inter, Inter, sans-serif)', lineHeight: 1.15 }}>
              {data.title}
            </h2>
            <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'rgba(226,232,240,0.65)', marginBottom: '10px' }}>
              {data.subtitle}
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <StatusBadge label={`${data.confidence.toUpperCase()} CONFIDENCE`} tone={confidenceTone(data.confidence)} glow={data.confidence === 'high'} />
              <StatusBadge label={EVIDENCE_BASIS_LABEL[data.evidenceBasis]} tone="info" />
            </div>
          </div>
        </div>

        <p style={{ position: 'relative', zIndex: 1, fontSize: '13px', lineHeight: 1.6, color: 'rgba(226,232,240,0.80)', margin: '16px 0 0', maxWidth: '820px' }}>
          {data.summarySentence}
        </p>
      </div>

      <div style={{ padding: '0 26px 24px' }}>
        {data.insufficientEvidence ? (
          <div style={{ padding: '16px 18px', borderRadius: '14px', background: 'rgba(122,138,158,0.06)', border: '1px solid rgba(122,138,158,0.20)' }}>
            <div style={{ display: 'flex', gap: '22px', flexWrap: 'wrap' }}>
              <Stat label="Total Transactions" value={fmtMetric(data.metrics.totalTransactions)} emphasized />
              <Stat label="Active Chains" value={fmtMetric(data.metrics.activeChains)} />
              <Stat label="Wallet Age" value={data.metrics.walletAgeDays != null ? `${Math.floor(data.metrics.walletAgeDays)}d` : 'Unknown'} />
            </div>
          </div>
        ) : (
          <>
            {/* ===== ZONE 2 — PERSONALITY VISUAL (trait meters) ===== */}
            <div style={{ marginBottom: '22px', paddingTop: '2px' }}>
              <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: SLATE, marginBottom: '12px' }}>
                Personality Signal
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', maxWidth: '640px' }}>
                {RADAR_AXES.map(({ key, label, accent }) => (
                  <TraitMeter key={key} label={label} value={data.radar[key]} accent={accent} />
                ))}
              </div>
            </div>

            {/* ===== ZONE 3 — CORE TRAITS ===== */}
            <div style={{ marginBottom: '18px' }}>
              <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: SLATE, marginBottom: '10px' }}>
                Core Traits
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '12px' }}>
                <TraitHighlight label="Trading Style" value={data.traits.tradingStyle} accent={TEAL} icon="◈" />
                <TraitHighlight label="Risk Profile" value={data.traits.riskAppetite} accent={PINK} icon="⚡" />
                <TraitHighlight label="Automation" value={data.traits.automationLikelihood} accent={PURPLE} icon="⚙" />
                <TraitHighlight label="Holding Pattern" value={data.traits.holdingStyle} accent={TEAL} icon="⏳" />
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <Chip label="Chain" value={data.traits.chainPreference} />
                <Chip label="Concentration" value={data.traits.portfolioConcentration} />
                <Chip label="Activity" value={data.traits.activityLevel} />
                <Chip label="Rotation" value={data.traits.rotationBehavior} />
              </div>
            </div>

            {/* ===== METRICS — STAT STRIP ===== */}
            <div style={{ marginBottom: '20px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: SLATE, marginBottom: '12px' }}>
                Behavior Metrics
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 28px' }}>
                <Stat label="Transactions" value={fmtMetric(data.metrics.totalTransactions)} emphasized />
                <Stat label="Unique Tokens" value={fmtMetric(data.metrics.uniqueTokensTraded)} emphasized />
                <Stat label="Avg Holding Time" value={fmtHoldingDays(data.metrics.averageHoldingDays)} emphasized />
                <Stat label="Repeated-Router %" value={fmtPercent(data.metrics.repeatedRouterPercent)} emphasized />
                <Stat label="Wallet Age" value={data.metrics.walletAgeDays != null ? `${Math.floor(data.metrics.walletAgeDays)}d` : 'Unknown'} emphasized />
                <Stat label="Buys" value={fmtMetric(data.metrics.buys)} />
                <Stat label="Sells" value={fmtMetric(data.metrics.sells)} />
                <Stat label="Active Chains" value={fmtMetric(data.metrics.activeChains)} />
                <Stat label="Median Holding" value={fmtHoldingDays(data.metrics.medianHoldingDays)} />
                <Stat label="Last Active" value={fmtDate(data.metrics.lastActiveAt)} />
              </div>
            </div>

            {/* ===== STRENGTHS / WATCHOUTS ===== */}
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '20px' }}>
              <div
                style={{
                  flex: '1 1 260px', minWidth: '220px', padding: '14px 16px', borderRadius: '14px',
                  background: `linear-gradient(160deg, ${TEAL}0F, rgba(255,255,255,0.015))`, border: '1px solid rgba(83,243,195,0.18)',
                }}
              >
                <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: TEAL, marginBottom: '10px' }}>
                  Strengths
                </div>
                {data.strengths.length === 0 ? (
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'rgba(226,232,240,0.65)' }}>
                    <span style={{ marginTop: '1px' }}><CheckIcon color={SLATE} /></span>
                    No standout evidence-backed strengths yet.
                  </div>
                ) : (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '7px' }}>
                    {data.strengths.map((s) => (
                      <li key={s} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', color: 'rgba(226,232,240,0.92)' }}>
                        <span style={{ marginTop: '1px', flexShrink: 0 }}><CheckIcon color={TEAL} /></span>
                        {s}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div
                style={{
                  flex: '1 1 260px', minWidth: '220px', padding: '14px 16px', borderRadius: '14px',
                  background: `linear-gradient(160deg, ${PINK}0D, rgba(255,255,255,0.015))`, border: '1px solid rgba(251,191,36,0.16)',
                }}
              >
                <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: '#fbbf24', marginBottom: '10px' }}>
                  Watchouts
                </div>
                {data.watchouts.length === 0 ? (
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'rgba(226,232,240,0.65)' }}>
                    <span style={{ marginTop: '1px' }}><CheckIcon color={TEAL} /></span>
                    No major behavioral risks detected from available evidence.
                  </div>
                ) : (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '7px' }}>
                    {data.watchouts.map((w) => (
                      <li key={w} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', color: 'rgba(226,232,240,0.92)' }}>
                        <span style={{ marginTop: '1px', flexShrink: 0 }}><WatchIcon color="#fbbf24" /></span>
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}

        {/* ===== PROFIT EVIDENCE ===== */}
        <div
          style={{
            padding: '15px 17px', borderRadius: '14px',
            background: data.profitEvidence.kind === 'verified'
              ? `linear-gradient(160deg, ${TEAL}12, rgba(255,255,255,0.015))`
              : data.profitEvidence.kind === 'limited_sample'
                ? 'linear-gradient(160deg, rgba(251,191,36,0.10), rgba(255,255,255,0.015))'
                : 'rgba(122,138,158,0.05)',
            border: data.profitEvidence.kind === 'verified'
              ? '1px solid rgba(83,243,195,0.22)'
              : data.profitEvidence.kind === 'limited_sample'
                ? '1px solid rgba(251,191,36,0.24)'
                : '1px solid rgba(122,138,158,0.16)',
          }}
        >
          <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', color: SLATE, marginBottom: '10px' }}>
            Profit Evidence
          </div>

          {data.profitEvidence.kind === 'not_proven' ? (
            <p style={{ fontSize: '12.5px', margin: 0, fontWeight: 600, color: 'rgba(148,163,184,0.80)' }}>
              {data.profitEvidence.message}
            </p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '20px 26px', flexWrap: 'wrap', marginBottom: '8px' }}>
                <Stat
                  label={data.profitEvidence.kind === 'verified' ? 'Wins' : 'Wins (sample)'}
                  value={fmtMetric(data.profitEvidence.winCount)}
                  emphasized
                />
                <Stat
                  label={data.profitEvidence.kind === 'verified' ? 'Losses' : 'Losses (sample)'}
                  value={fmtMetric(data.profitEvidence.lossCount)}
                  emphasized
                />
                <Stat label="Fully Priced Trades" value={fmtMetric(data.profitEvidence.evaluatedCount)} emphasized />
                <Stat
                  label={data.profitEvidence.kind === 'verified' ? 'Verified Win Rate' : 'Sample Win Rate'}
                  value={fmtPercent(data.profitEvidence.winRatePercent)}
                  emphasized
                />
              </div>
              {data.profitEvidence.kind === 'limited_sample' && (
                <>
                  <StatusBadge label="Limited verified sample" tone="warning" />
                  <p style={{ fontSize: '11px', margin: '8px 0 0', color: '#fbbf24', fontWeight: 600 }}>
                    Not the wallet&apos;s official overall win rate.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

export default WalletPersonalityCard

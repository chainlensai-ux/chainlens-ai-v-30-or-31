'use client'

// WalletPersonalityCard — full-width Wallet Personality section for the Wallet Scanner V3 layout.
//
// ALWAYS RENDERS, DISCLOSED: this card never returns null and never blocks on
// report.finalSummary.financialStatus.officialPnlStatus — deriveWalletPersonality (app/frontend/
// lib/walletPersonality.ts) always returns a real, safe object (falling back to an honest
// "insufficient evidence" profile when a wallet has zero real transactions) so this card renders
// after every successful scan, per this task's own explicit requirement.
//
// NO FALSE ZEROS, DISCLOSED: every metric here is rendered through fmtMetric/fmtPercent below,
// which render `null` as "Unknown"/"Not enough data" — never as a literal 0 or 0%. Win rate in
// particular is only ever shown when deriveWalletPersonality's profitEvidence.evaluatedCount > 0.
import type { WalletPersonalitySourceReport } from '@/app/frontend/lib/walletPersonality'
import { deriveWalletPersonality, fmtHoldingDays } from '@/app/frontend/lib/walletPersonality'
import { StatusBadge } from './StatusBadge'

export const WALLET_PERSONALITY_CARD_ID = 'wallet-personality-card'

export type WalletPersonalityCardProps = {
  report: WalletPersonalitySourceReport
}

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

const traitCardStyle: React.CSSProperties = {
  padding: '11px 13px', borderRadius: '11px', background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.06)',
}
const traitLabelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase',
  color: 'rgba(148,163,184,0.55)', marginBottom: '4px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
}
const traitValueStyle: React.CSSProperties = { fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }

function Trait({ label, value }: { label: string; value: string }) {
  return (
    <div style={traitCardStyle}>
      <div style={traitLabelStyle}>{label}</div>
      <div style={traitValueStyle}>{value}</div>
    </div>
  )
}

const metricLabelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'rgba(148,163,184,0.50)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
}
const metricValueStyle: React.CSSProperties = { fontSize: '15px', fontWeight: 800, color: '#e2e8f0', marginTop: '3px' }

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: '120px' }}>
      <div style={metricLabelStyle}>{label}</div>
      <div style={metricValueStyle}>{value}</div>
    </div>
  )
}

export function WalletPersonalityCard({ report }: WalletPersonalityCardProps) {
  const data = deriveWalletPersonality(report)

  return (
    <section
      id={WALLET_PERSONALITY_CARD_ID}
      style={{
        width: '100%', background: 'rgba(6,10,18,0.95)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '16px', padding: '22px 24px', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 20px rgba(0,0,0,0.18)',
        marginBottom: '16px', scrollMarginTop: '90px',
      }}
    >
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.70)' }}>
          Wallet Personality
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 900, color: '#f1f5f9', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          {data.title}
        </h2>
        <StatusBadge label={`${data.confidence.toUpperCase()} CONFIDENCE`} tone={confidenceTone(data.confidence)} glow={data.confidence === 'high'} />
        <StatusBadge label={EVIDENCE_BASIS_LABEL[data.evidenceBasis]} tone="info" />
      </div>

      {/* SUMMARY */}
      <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(226,232,240,0.85)', margin: '0 0 18px', maxWidth: '880px' }}>
        {data.summarySentence}
      </p>

      {data.insufficientEvidence ? (
        <div style={{ padding: '14px 16px', borderRadius: '12px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.20)', marginBottom: '10px' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#fbbf24', marginBottom: '6px' }}>
            Insufficient evidence for a detailed personality
          </div>
          <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
            <Metric label="Total Transactions" value={fmtMetric(data.metrics.totalTransactions)} />
            <Metric label="Active Chains" value={fmtMetric(data.metrics.activeChains)} />
            <Metric label="Wallet Age" value={data.metrics.walletAgeDays != null ? `${Math.floor(data.metrics.walletAgeDays)}d` : 'Unknown'} />
          </div>
        </div>
      ) : (
        <>
          {/* PERSONALITY TRAITS */}
          <div style={{ marginBottom: '10px' }}>
            <div style={{ ...traitLabelStyle, marginBottom: '8px' }}>Personality Traits</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
              <Trait label="Trading Style" value={data.traits.tradingStyle} />
              <Trait label="Activity Level" value={data.traits.activityLevel} />
              <Trait label="Holding Style" value={data.traits.holdingStyle} />
              <Trait label="Rotation Behavior" value={data.traits.rotationBehavior} />
              <Trait label="Risk Appetite" value={data.traits.riskAppetite} />
              <Trait label="Automation Likelihood" value={data.traits.automationLikelihood} />
              <Trait label="Chain Preference" value={data.traits.chainPreference} />
              <Trait label="Portfolio Concentration" value={data.traits.portfolioConcentration} />
            </div>
          </div>

          {/* BEHAVIOR METRICS */}
          <div style={{ marginBottom: '16px', paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ ...traitLabelStyle, marginBottom: '10px' }}>Behavior Metrics</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 26px' }}>
              <Metric label="Total Transactions" value={fmtMetric(data.metrics.totalTransactions)} />
              <Metric label="Buys" value={fmtMetric(data.metrics.buys)} />
              <Metric label="Sells" value={fmtMetric(data.metrics.sells)} />
              <Metric label="Active Chains" value={fmtMetric(data.metrics.activeChains)} />
              <Metric label="Avg Holding Time" value={fmtHoldingDays(data.metrics.averageHoldingDays)} />
              <Metric label="Median Holding Time" value={fmtHoldingDays(data.metrics.medianHoldingDays)} />
              <Metric label="Unique Tokens Traded" value={fmtMetric(data.metrics.uniqueTokensTraded)} />
              <Metric label="Repeated-Router %" value={fmtPercent(data.metrics.repeatedRouterPercent)} />
              <Metric label="Wallet Age" value={data.metrics.walletAgeDays != null ? `${Math.floor(data.metrics.walletAgeDays)}d` : 'Unknown'} />
              <Metric label="Last Active" value={fmtDate(data.metrics.lastActiveAt)} />
            </div>
          </div>

          {/* CLASSIFICATION */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
            <StatusBadge label={data.classification.automation} tone="neutral" />
            <StatusBadge label={data.classification.holding} tone="neutral" />
            <StatusBadge label={data.classification.concentration} tone="neutral" />
            <StatusBadge
              label={data.classification.risk}
              tone={data.classification.risk === 'High risk behavior' ? 'danger' : data.classification.risk === 'Medium risk behavior' ? 'warning' : 'neutral'}
            />
          </div>

          {/* STRENGTHS / WATCHOUTS */}
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div style={{ flex: '1 1 260px', minWidth: '220px' }}>
              <div style={{ ...traitLabelStyle, marginBottom: '8px' }}>Strengths</div>
              {data.strengths.length === 0 ? (
                <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No evidence-backed strengths identified yet.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#4ade80' }}>
                  {data.strengths.map((s) => <li key={s} style={{ marginBottom: '4px' }}>{s}</li>)}
                </ul>
              )}
            </div>
            <div style={{ flex: '1 1 260px', minWidth: '220px' }}>
              <div style={{ ...traitLabelStyle, marginBottom: '8px' }}>Watchouts</div>
              {data.watchouts.length === 0 ? (
                <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No evidence-backed risks identified yet.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#fbbf24' }}>
                  {data.watchouts.map((w) => <li key={w} style={{ marginBottom: '4px' }}>{w}</li>)}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {/* PROFIT EVIDENCE */}
      <div style={{ paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ ...traitLabelStyle, marginBottom: '8px' }}>Profit Evidence</div>
        <p
          style={{
            fontSize: '12.5px', margin: 0, fontWeight: 600,
            color: data.profitEvidence.kind === 'verified' ? '#4ade80' : data.profitEvidence.kind === 'limited_sample' ? '#fbbf24' : 'rgba(148,163,184,0.70)',
          }}
        >
          {data.profitEvidence.message}
        </p>
      </div>
    </section>
  )
}

export default WalletPersonalityCard

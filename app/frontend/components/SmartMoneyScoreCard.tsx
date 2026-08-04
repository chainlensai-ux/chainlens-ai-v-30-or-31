'use client'

// Smart Money Score card — REBUILT, DISCLOSED (Smart Money Score audit/rebuild task). Renders
// nothing when report.smartMoneyScore itself is absent (older responses, or a worker path that
// doesn't compute this field) — never assumes it's present. Every number here is exactly what
// lib/engine/modules/smartMoney/computeSmartMoneyScore.ts produced — see that module's own header
// for the full audit trail of what changed and why (personality/activity/chain-count/wallet-age no
// longer materially influence the official score; unavailable PnL is null, never a fabricated
// midpoint or 0; an explicit not-yet-rated gate below the verified-evidence bar).
import { useState } from 'react'
import type { SmartMoneyScore, SmartMoneyPerformanceBreakdown } from '@/lib/engine/modules/smartMoney/types'
import { MIN_VERIFIED_TRADES_FOR_OFFICIAL, MIN_COVERAGE_PERCENT_FOR_OFFICIAL } from '@/lib/engine/modules/smartMoney/computeSmartMoneyScore'
import type { CanonicalSampleManifestAudit } from '@/src/lib/canonicalPnlSampleManifest'
import { WALLET_PERSONALITY_CARD_ID } from './WalletPersonalityCard'
import { StatusBadge } from './StatusBadge'

export type SmartMoneyScoreCardProps = {
  smartMoneyScore: SmartMoneyScore | null | undefined
  // FAIL-CLOSED SHARED STATE, DISCLOSED (canonical-manifest-fast-path follow-up task, issue #2 —
  // "Smart Money and PnL must use the same canonical count/status"). Optional, additive — omitted by
  // any caller that hasn't wired the same-scan canonical manifest audit into this card yet, in which
  // case behavior is completely unchanged. When supplied and
  // `canonicalSampleEvidenceUnavailable === true`, this card's own Verified Coverage figure is
  // overridden to "Unavailable" regardless of what `evidenceConfidence.verifiedCoveragePercent`
  // itself reports — the SAME canonical-sample-unavailable state PnlStatusCard's own
  // `canonicalSampleManifestAudit` prop gates its PnL display on.
  canonicalSampleManifestAudit?: CanonicalSampleManifestAudit | null
}

const BREAKDOWN_LABELS: Array<{ key: keyof SmartMoneyPerformanceBreakdown; label: string; weightPercent: number }> = [
  { key: 'verifiedProfitability', label: 'Verified Profitability', weightPercent: 30 },
  { key: 'verifiedWinQuality', label: 'Verified Win Quality', weightPercent: 20 },
  { key: 'timingQuality', label: 'Timing Quality', weightPercent: 15 },
  { key: 'riskAdjustedPerformance', label: 'Risk-Adjusted Performance', weightPercent: 15 },
  { key: 'consistency', label: 'Consistency', weightPercent: 10 },
  { key: 'behaviorQuality', label: 'Behavior Quality', weightPercent: 10 },
]

function scoreColor(score: number): string {
  if (score >= 70) return '#4ade80'
  if (score >= 40) return '#fbbf24'
  return '#f87171'
}

function confidenceTone(level: SmartMoneyScore['evidenceConfidence']['level']): 'success' | 'warning' | 'neutral' {
  if (level === 'high') return 'success'
  if (level === 'medium') return 'warning'
  return 'neutral'
}

function fmtBreakdownValue(v: number | null): string {
  return v == null ? 'No data' : `${v}`
}

export function SmartMoneyScoreCard({ smartMoneyScore, canonicalSampleManifestAudit }: SmartMoneyScoreCardProps) {
  const [expanded, setExpanded] = useState(false)
  if (!smartMoneyScore) return null

  const { status, officialScore, provisionalBehaviorScore, evidenceConfidence, breakdown, notes, reasonNotRated } = smartMoneyScore
  const isOfficial = status === 'official'
  const canonicalSampleUnavailable = canonicalSampleManifestAudit?.canonicalSampleEvidenceUnavailable === true
  const displayedVerifiedCoveragePercent = canonicalSampleUnavailable ? null : evidenceConfidence.verifiedCoveragePercent

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* HEADER: main score OR Not Yet Rated state, plus a separate Evidence Confidence badge. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.70)' }}>
          Smart Money Score
        </span>
        {isOfficial ? (
          <>
            <span style={{ fontSize: '22px', fontWeight: 900, color: scoreColor(officialScore ?? 0) }}>
              {officialScore}
            </span>
            <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>/ 100</span>
          </>
        ) : (
          <span style={{ fontSize: '15px', fontWeight: 800, color: '#fbbf24' }}>Not Yet Rated</span>
        )}
        <StatusBadge label={`${evidenceConfidence.level.toUpperCase()} EVIDENCE CONFIDENCE`} tone={confidenceTone(evidenceConfidence.level)} glow={evidenceConfidence.level === 'high'} />
      </div>

      {!isOfficial && (
        <p style={{ fontSize: '12px', color: 'rgba(226,232,240,0.75)', margin: 0, fontWeight: 600 }}>
          Not yet rated — insufficient verified performance evidence.
          {reasonNotRated ? ` ${reasonNotRated}` : ''}
        </p>
      )}

      {/* VERIFIED TRADES / COVERAGE, DISCLOSED: always shown, official or not — this is the real
          evidence backing (or currently withholding) the score, never hidden. Shows real threshold
          PROGRESS ("X / Y minimum met/not met"), not just a bare number, and an honest
          "Unavailable" (never a bare 0) when the canonical FIFO structural count itself wasn't
          available this scan — see computeSmartMoneyScore.ts's own totalMatchedLotCount header. */}
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)' }}>
            Verified Trades
          </div>
          <div style={{ fontSize: '14px', fontWeight: 800, color: evidenceConfidence.fullyPricedTradeCount >= MIN_VERIFIED_TRADES_FOR_OFFICIAL ? '#4ade80' : '#e2e8f0' }}>
            {evidenceConfidence.fullyPricedTradeCount} / {MIN_VERIFIED_TRADES_FOR_OFFICIAL} minimum
            <span style={{ fontSize: '10px', fontWeight: 700, marginLeft: '6px', color: evidenceConfidence.fullyPricedTradeCount >= MIN_VERIFIED_TRADES_FOR_OFFICIAL ? '#4ade80' : '#f87171' }}>
              {evidenceConfidence.fullyPricedTradeCount >= MIN_VERIFIED_TRADES_FOR_OFFICIAL ? 'met' : 'not met'}
            </span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)' }}>
            Verified Coverage
          </div>
          {displayedVerifiedCoveragePercent == null ? (
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'rgba(148,163,184,0.55)' }}>
              {canonicalSampleUnavailable ? 'Unavailable — canonical sample not currently verified' : 'Unavailable'}
            </div>
          ) : (
            <div style={{ fontSize: '14px', fontWeight: 800, color: displayedVerifiedCoveragePercent >= MIN_COVERAGE_PERCENT_FOR_OFFICIAL ? '#4ade80' : '#e2e8f0' }}>
              {displayedVerifiedCoveragePercent.toFixed(2)}% / {MIN_COVERAGE_PERCENT_FOR_OFFICIAL}% minimum
              <span style={{ fontSize: '10px', fontWeight: 700, marginLeft: '6px', color: displayedVerifiedCoveragePercent >= MIN_COVERAGE_PERCENT_FOR_OFFICIAL ? '#4ade80' : '#f87171' }}>
                {displayedVerifiedCoveragePercent >= MIN_COVERAGE_PERCENT_FOR_OFFICIAL ? 'met' : 'not met'}
              </span>
              {evidenceConfidence.totalMatchedLotCount != null && (
                <span style={{ display: 'block', fontSize: '10px', color: 'rgba(148,163,184,0.50)', fontWeight: 600 }}>
                  of {evidenceConfidence.totalMatchedLotCount} closed lots
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* PROVISIONAL BEHAVIOR READ, DISCLOSED: only ever shown when NOT officially rated, clearly
          labeled as provisional/behavior-only — never presented as, or near, the official score. */}
      {!isOfficial && provisionalBehaviorScore != null && (
        <div style={{ padding: '8px 10px', borderRadius: '10px', background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.20)' }}>
          <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#c4b5fd', marginBottom: '3px' }}>
            Provisional Behavior Read (not an official score)
          </div>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#c4b5fd' }}>{provisionalBehaviorScore} / 100</div>
        </div>
      )}

      {/* PERFORMANCE VS BEHAVIOR BREAKDOWN, DISCLOSED: shown for BOTH official and not-yet-rated
          states (a not-yet-rated wallet can still show what evidence exists — just not the
          weighted total). "No data" (never 0) for a category with no computable input. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
        {BREAKDOWN_LABELS.map(({ key, label, weightPercent }) => {
          const value = breakdown[key]
          const content = (
            <div style={{ fontSize: '11px' }}>
              <span style={{ color: '#64748b' }}>{label} ({weightPercent}%) — </span>
              <span style={{ fontWeight: 700, color: value == null ? 'rgba(148,163,184,0.55)' : scoreColor(value) }}>
                {fmtBreakdownValue(value)}
              </span>
            </div>
          )
          // PERSONALITY/BEHAVIOR LINK, DISCLOSED (preserves the prior task's "link to the Wallet
          // Personality card" behavior — the only remaining behavior-flavored category is
          // Behavior Quality, so that row is now the one made clickable).
          if (key === 'behaviorQuality') {
            return (
              <a
                key={key}
                href={`#${WALLET_PERSONALITY_CARD_ID}`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(WALLET_PERSONALITY_CARD_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                style={{ textDecoration: 'none', cursor: 'pointer' }}
                title="Jump to the full Wallet Personality card"
              >
                {content}
              </a>
            )
          }
          return <div key={key}>{content}</div>
        })}
      </div>

      {/* WHY THIS SCORE?, DISCLOSED: expandable panel explaining every contributing metric in
          plain language — never just raw numbers with no context. */}
      <div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: 'transparent', border: 'none', color: 'rgba(148,163,184,0.70)', fontSize: '11px', fontWeight: 700,
            cursor: 'pointer', padding: 0, textDecoration: 'underline', textUnderlineOffset: '2px',
          }}
        >
          {expanded ? 'Hide' : 'Why this score?'}
        </button>
        {expanded && (
          <div style={{ marginTop: '8px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: 'rgba(226,232,240,0.80)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <li>
                Verified Profitability: total realized PnL relative to cost basis across{' '}
                {evidenceConfidence.fullyPricedTradeCount} fully priced trade{evidenceConfidence.fullyPricedTradeCount === 1 ? '' : 's'} (one outlier trade is capped so it cannot dominate the result).
              </li>
              <li>Verified Win Quality: win rate combined with the average win-to-loss payoff ratio.</li>
              <li>Timing Quality: whether winning positions were held longer than losing ones (cutting losses faster than letting winners run).</li>
              <li>Risk-Adjusted Performance: average return relative to its own volatility across verified trades.</li>
              <li>Consistency: how spread out profitable weeks are — a single lucky week scores lower than steady, repeated wins over time.</li>
              <li>Behavior Quality: real accumulation/rotation/farming behavior signals — capped at 10% weight, never a substitute for verified performance.</li>
              <li>
                Evidence Confidence ({Math.round(evidenceConfidence.value * 100)}%, {evidenceConfidence.level}): based on verified trade count, verified coverage, and history length — independent of the score itself.
              </li>
              {evidenceConfidence.historyDays != null && (
                <li>Track record spans {Math.round(evidenceConfidence.historyDays)} day{Math.round(evidenceConfidence.historyDays) === 1 ? '' : 's'} of closed-lot history.</li>
              )}
            </ul>
          </div>
        )}
      </div>

      {notes.length > 0 && isOfficial && (
        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '11px', color: 'rgba(148,163,184,0.75)' }}>
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default SmartMoneyScoreCard

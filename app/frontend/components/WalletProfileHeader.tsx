// Wallet Profile Header — hero-style summary card shown above the V2 results (replaces the
// old plain FinalSummaryView text dump as the first thing a user sees after a scan).
//
// V2-SAFE GUARD: `report` is typed non-optional in the field-level helpers below, but every access
// still defensively falls back to a safe default — same convention as every other component in
// this directory.
//
// HONESTY NOTE: every value here is read directly from the V2 report or derived by pure arithmetic
// over it (e.g. first/last-seen from real timeline timestamps, chain percentages from
// portfolio.chainValueBreakdown). Nothing is invented:
//   - There is no "wallet tier" or wallet-quality score anywhere in this engine, so this header
//     does not render one. The Elite/plan badge in the page header above it reflects the signed-in
//     user's ChainLens plan, not a claim about the wallet being scanned.
//   - "Behavior classification" is a direct restatement of behaviorIntel.rotationStyle /
//     multiChainParticipation — never a fabricated label.
//   - A chain present in scanMetadata.chainsScanned but absent from portfolio.chainValueBreakdown
//     is shown as "no data" rather than silently omitted, so a HyperEVM scan doesn't look identical
//     to a HyperEVM chain that was never requested.

import type { FinalReport } from '@/src/modules/finalReportAssembler/types'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'
import type { Portfolio as EnginePortfolioV2 } from '@/lib/engine/modules/portfolio/types'
import type { SmartMoneyScore } from '@/lib/engine/modules/smartMoney/types'
import { ChainBadge } from './ChainBadge'
import { ConfidenceBadge } from './ConfidenceBadge'
import { PortfolioIntelligenceCard } from './PortfolioIntelligenceCard'
import { SmartMoneyScoreCard } from './SmartMoneyScoreCard'
import { fmtSignedUsd } from '@/app/frontend/lib/holdingsHeuristics'

// PORTFOLIO V2 MIGRATION, DISCLOSED: see app/terminal/wallet-scanner/page.tsx's own local
// WalletV2Report type (a separately-defined but structurally identical type — this file's own
// export isn't imported by that page today) for the full disclosure on why `portfolioV2` is
// currently always undefined in this app's real, live data flow. Only threaded through to
// PortfolioIntelligenceCard below — no other rendering in this file changes.
export type WalletV2Report = FinalReport & { holdings: TokenHolding[]; portfolio: PortfolioSummary; portfolioV2?: EnginePortfolioV2; smartMoneyScore?: SmartMoneyScore }

export type WalletProfileHeaderProps = {
  report: WalletV2Report | null | undefined
  loading: boolean
  isFullRecoveryAdmin: boolean
  onDeepScan: () => void
  onAdminAction: () => void
}

function fmtUsdFull(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function shortenAddress(address: string): string {
  if (address.length <= 18) return address
  return `${address.slice(0, 6)}…${address.slice(-6)}`
}

function fmtTimestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'Not available'
  return new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// PURE. Earliest/latest timestamp across every real timeline entry this report actually produced
// (buy/sell/distribution/bridge) — never a guess, and null (not "now"/"genesis") when there's
// nothing to derive it from.
function deriveActivityWindow(report: WalletV2Report): { firstSeenMs: number | null; lastActiveMs: number | null } {
  const timestamps: number[] = []

  const buyEntries = Array.isArray(report.timelines?.buyTimeline?.entries) ? report.timelines.buyTimeline.entries : []
  const sellEntries = Array.isArray(report.timelines?.sellTimeline?.entries) ? report.timelines.sellTimeline.entries : []
  const distEntries = Array.isArray(report.timelines?.distributionTimeline?.entries) ? report.timelines.distributionTimeline.entries : []
  const bridgeEntries = Array.isArray(report.bridgeTimeline) ? report.bridgeTimeline : []

  for (const e of buyEntries) if (Number.isFinite(e.timestamp)) timestamps.push(e.timestamp)
  for (const e of sellEntries) if (Number.isFinite(e.timestamp)) timestamps.push(e.timestamp)
  for (const e of distEntries) if (Number.isFinite(e.timestamp)) timestamps.push(e.timestamp)
  for (const e of bridgeEntries) {
    const ms = Date.parse(e.timestamp)
    if (Number.isFinite(ms)) timestamps.push(ms)
  }

  if (timestamps.length === 0) return { firstSeenMs: null, lastActiveMs: null }
  return { firstSeenMs: Math.min(...timestamps), lastActiveMs: Math.max(...timestamps) }
}

// PURE. Restates behaviorIntel.rotationStyle + multiChainParticipation as a short label — never a
// new classification, just plain-English phrasing of the two real fields.
function deriveBehaviorLabel(report: WalletV2Report): string {
  const rotationStyle = report.behaviorIntel?.rotationStyle?.value ?? 'unknown'
  const activeChains = Array.isArray(report.behaviorIntel?.multiChainParticipation?.activeChains)
    ? report.behaviorIntel.multiChainParticipation.activeChains
    : []

  const styleLabel: Record<string, string> = {
    accumulator: 'Accumulator',
    rotator: 'Rotator',
    distributor: 'Distributor',
    unknown: 'Unclassified',
  }
  const label = styleLabel[rotationStyle] ?? 'Unclassified'
  return activeChains.length > 1 ? `Multi-Chain ${label}` : label
}

function deriveRiskProfile(report: WalletV2Report): string {
  const rotationStyle = report.behaviorIntel?.rotationStyle?.value ?? 'unknown'
  const riskOnOff = report.behaviorIntel?.riskOnOff?.value ?? 'unknown'
  if (rotationStyle === 'unknown' && riskOnOff === 'unknown') return 'Not enough evidence yet'

  const rotationPart = rotationStyle === 'rotator' ? 'High Rotation' : rotationStyle === 'unknown' ? null : `${rotationStyle}`
  const riskPart = riskOnOff === 'risk_on' ? 'Risk-On' : riskOnOff === 'risk_off' ? 'Risk-Off' : null

  return [rotationPart, riskPart].filter(Boolean).join(' / ') || 'Not enough evidence yet'
}

function WalletOverview({ report }: { report: WalletV2Report }) {
  const address = report.scanMetadata?.walletAddress ?? ''
  const { firstSeenMs, lastActiveMs } = deriveActivityWindow(report)

  return (
    <div>
      <div className="wph-address" style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '0.01em', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', color: '#e2e8f0' }}>
        {address ? shortenAddress(address) : 'Unknown wallet'}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <span className="wph-badge" style={{ padding: '4px 11px', borderRadius: '999px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', background: 'rgba(45,212,191,0.10)', border: '1px solid rgba(45,212,191,0.30)', color: '#2DD4BF', boxShadow: '0 0 14px rgba(45,212,191,0.16)' }}>
          {deriveBehaviorLabel(report)}
        </span>
        <span className="wph-badge" style={{ padding: '4px 11px', borderRadius: '999px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.30)', color: '#fbbf24', boxShadow: '0 0 14px rgba(251,191,36,0.14)' }}>
          {deriveRiskProfile(report)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '24px', marginTop: '14px', flexWrap: 'wrap', fontSize: '11px', color: 'rgba(148,163,184,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        <span>First Seen — {fmtTimestamp(firstSeenMs)}</span>
        <span>Last Active — {fmtTimestamp(lastActiveMs)}</span>
      </div>
    </div>
  )
}

function PortfolioSnapshot({ report }: { report: WalletV2Report }) {
  const totalValueUsd = report.portfolio?.totalValueUsd ?? null
  const breakdown = Array.isArray(report.portfolio?.chainValueBreakdown) ? report.portfolio.chainValueBreakdown : []
  const chainsScanned = Array.isArray(report.scanMetadata?.chainsScanned) ? report.scanMetadata.chainsScanned : []
  const chainsWithoutData = chainsScanned.filter((c) => !breakdown.some((b) => b.chain === c))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <span className="wph-value" style={{ fontSize: '28px', fontWeight: 900, color: '#f1f5f9', fontFamily: 'var(--font-inter, Inter, sans-serif)', letterSpacing: '-0.02em' }}>
          {totalValueUsd != null ? fmtUsdFull(totalValueUsd) : 'Not available'}
        </span>
        <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(139,92,246,0.85)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', border: '1px solid rgba(139,92,246,0.35)', borderRadius: '999px', padding: '3px 9px' }}>
          {report.scanMetadata?.intel_window_days ?? '—'}-Day Intelligence Engine
        </span>
      </div>

      {breakdown.length === 0 && chainsWithoutData.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', marginTop: '10px' }}>No holdings data available for this scan.</p>
      ) : (
        <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {breakdown.map((entry) => (
            <div key={entry.chain} className="wph-chain-row" style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
              <span style={{ width: '96px' }}><ChainBadge chain={entry.chain} /></span>
              <span style={{ flex: 1, height: '6px', borderRadius: '999px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, entry.percent))}%`, background: 'linear-gradient(90deg, #2DD4BF, #22c5ae)', borderRadius: '999px' }} />
              </span>
              <span style={{ color: '#94a3b8', minWidth: '110px', textAlign: 'right' }}>{fmtUsdFull(entry.valueUsd)} ({entry.percent.toFixed(0)}%)</span>
            </div>
          ))}
          {chainsWithoutData.map((chain) => (
            <div key={chain} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', opacity: 0.55 }}>
              <span style={{ width: '84px', textTransform: 'capitalize', color: '#64748b', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{chain}</span>
              <span style={{ flex: 1, fontSize: '11px', color: '#64748b' }}>No verified provider yet — scanned, no holdings data</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Real fifoAndPnl.realizedPnlUsd/unrealizedPnlUsd (the actual FIFO engine) + real
// behaviorIntel.confidence — never a redefinition of what "confidence" means elsewhere in the
// report (see PnLTab.tsx's own note on this).
function PnlAndConfidenceRow({ report }: { report: WalletV2Report }) {
  const realized = report.fifoAndPnl?.realizedPnlUsd ?? null
  const unrealized = report.fifoAndPnl?.unrealizedPnlUsd ?? null
  const confidence = report.behaviorIntel?.confidence ?? 'low'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap', fontSize: '12px' }}>
      <span>
        <span style={{ color: '#64748b' }}>Realized PnL — </span>
        <span style={{ fontWeight: 700, color: realized == null ? 'rgba(148,163,184,0.55)' : realized >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(realized)}</span>
      </span>
      <span>
        <span style={{ color: '#64748b' }}>Unrealized PnL — </span>
        <span style={{ fontWeight: 700, color: unrealized == null ? 'rgba(148,163,184,0.55)' : unrealized >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(unrealized)}</span>
      </span>
      <ConfidenceBadge level={confidence} />
    </div>
  )
}

function BehaviorSummary({ report }: { report: WalletV2Report }) {
  const evaluation = Array.isArray(report.recoveryPolicy?.evaluation) ? report.recoveryPolicy.evaluation : []
  const triggeredCount = evaluation.filter((e) => e.recoveryTriggered).length
  const pagesUsed = report.recoveryPolicy?.totalPagesUsedThisWallet ?? 0
  const confidence = report.behaviorIntel?.confidence ?? 'low'
  const activeChains = Array.isArray(report.behaviorIntel?.multiChainParticipation?.activeChains)
    ? report.behaviorIntel.multiChainParticipation.activeChains
    : []
  const pnlHeadline = report.finalSummary?.financialStatus?.headline ?? 'PnL unavailable due to missing evidence.'

  const confidenceLabel: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>
      <div><span style={{ color: '#64748b' }}>Style: </span>{deriveBehaviorLabel(report)}</div>
      <div><span style={{ color: '#64748b' }}>PnL: </span>{pnlHeadline}</div>
      <div><span style={{ color: '#64748b' }}>Recovery: </span>{pagesUsed} page(s) used, {triggeredCount}/{evaluation.length} token(s) reconstructed</div>
      <div>
        <span style={{ color: '#64748b' }}>Confidence: </span>
        {confidenceLabel[confidence] ?? 'Low'}
        {activeChains.length > 0 ? ` (${activeChains.join(' + ')} evidence)` : ' (no chain met the active-intelligence gate this scan)'}
      </div>
    </div>
  )
}

function Actions({ loading, isFullRecoveryAdmin, onDeepScan, onAdminAction }: Pick<WalletProfileHeaderProps, 'loading' | 'isFullRecoveryAdmin' | 'onDeepScan' | 'onAdminAction'>) {
  return (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      {/* Run Deep Scan is the one action every user (not just admins) sees, so it stays the sole
          solid-filled primary CTA. Smart Recovery / Admin Full Recovery are admin-only and trigger
          the exact same Deep Scan (see their titles) — kept as subtle, low-contrast secondary
          actions rather than competing bright outlines, so they don't visually outrank the one
          action that actually matters to most users. */}
      <button
        type="button"
        onClick={onDeepScan}
        disabled={loading}
        style={{
          padding: '10px 18px', borderRadius: '10px', border: 'none',
          background: loading ? 'rgba(45,212,191,0.25)' : 'linear-gradient(135deg, #2DD4BF, #22c5ae)',
          color: '#03121e', fontSize: '11px', fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase', cursor: loading ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          boxShadow: loading ? 'none' : '0 0 20px rgba(45,212,191,0.25)',
        }}
      >
        Run Deep Scan
      </button>
      {isFullRecoveryAdmin && (
        <>
          <button
            type="button"
            onClick={onAdminAction}
            disabled={loading}
            title="V2 has no separate smart-recovery scan mode — this triggers the same Deep Scan."
            style={{
              padding: '9px 16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.10)',
              background: 'transparent', color: 'rgba(203,213,225,0.75)', fontSize: '11px', fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase', cursor: loading ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
            }}
          >
            Smart Recovery
          </button>
          <button
            type="button"
            onClick={onAdminAction}
            disabled={loading}
            title="V2 has no separate full-recovery scan mode — this triggers the same Deep Scan."
            style={{
              padding: '9px 16px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.10)',
              background: 'transparent', color: 'rgba(203,213,225,0.75)', fontSize: '11px', fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase', cursor: loading ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
            }}
          >
            Admin Full Recovery
          </button>
        </>
      )}
    </div>
  )
}

export function WalletProfileHeader({ report, loading, isFullRecoveryAdmin, onDeepScan, onAdminAction }: WalletProfileHeaderProps) {
  if (!report) return null

  return (
    <div className="wph-root ws-result-fade" style={{ background: 'linear-gradient(160deg, rgba(45,212,191,0.05), rgba(6,10,18,0.97))', border: '1px solid rgba(45,212,191,0.18)', borderRadius: '18px', padding: '24px 26px', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '20px', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 32px rgba(0,0,0,0.28)' }}>
      <WalletOverview report={report} />
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
      <PortfolioSnapshot report={report} />
      <PortfolioIntelligenceCard
        portfolio={report.portfolio}
        portfolioV2={report.portfolioV2}
        chainsScanned={report.scanMetadata?.chainsScanned}
        activeChain={report.behaviorIntel?.multiChainParticipation?.primaryChain}
      />
      {report.smartMoneyScore && (
        <>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
          <SmartMoneyScoreCard smartMoneyScore={report.smartMoneyScore} />
        </>
      )}
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
      <PnlAndConfidenceRow report={report} />
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
      <BehaviorSummary report={report} />
      <Actions loading={loading} isFullRecoveryAdmin={isFullRecoveryAdmin} onDeepScan={onDeepScan} onAdminAction={onAdminAction} />
    </div>
  )
}

export default WalletProfileHeader

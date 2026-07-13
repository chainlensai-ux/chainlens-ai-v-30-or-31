'use client'

// V2 SCANNER component — receives ONLY finalSummary from the new engine's report.
//
// VISUAL REDESIGN, DISCLOSED: purely presentational — same fields, same fallback strings, same
// data source (FinalSummary) as before. Restyled to match this page's other premium cards
// (RecoveryHealthCard/PnlStatusCard's icon+title+StatusBadge header, labeled rows, framer-motion
// fade-in) instead of plain unstyled <p> tags. No new data is invented: officialPnlStatus's tone
// mapping below only recolors the SAME real status string this component already received, and the
// riskOnOff icon only reflects the SAME real 'risk_on'/'risk_off' value already being displayed as
// text.
import { motion } from 'framer-motion'
import type { FinalSummary } from '@/src/modules/finalReportAssembler/types'
import type { SellTimelineResult } from '@/src/modules/sellTimeline/types'
import { StatusBadge, type StatusTone } from './StatusBadge'
import { HeartbeatIcon, TrendingUpIcon, TrendingDownIcon } from './Icons'

// SELL-ACTIVITY BADGE, ADDITIVE/DISCLOSED: derives "Active Seller"/"Distributor with Sell Activity"
// purely from real sellTimelineV2.totalSells (never fabricated, never a re-derivation of
// swapNormalizer's own classification — sellTimelineV2 already comes from the protected
// src/modules/sellTimeline module). This is a UI-only label alongside the existing, untouched
// walletPersonality string from finalSummary — it does not replace or alter that string.
const ACTIVE_SELLER_THRESHOLD = 5

function sellActivityLabel(totalSells: number): { label: string; tone: StatusTone } | null {
  if (totalSells <= 0) return null
  if (totalSells >= ACTIVE_SELLER_THRESHOLD) return { label: 'Active Seller', tone: 'warning' }
  return { label: 'Distributor with Sell Activity', tone: 'neutral' }
}

function pnlStatusTone(status: string): StatusTone {
  if (status === 'ok') return 'success'
  if (status === 'limited_verified_sample') return 'warning'
  return 'neutral'
}

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { duration: 0.22, delay: i * 0.05 } }),
}

function SummaryRow({ label, children, index }: { label: string; children: React.ReactNode; index: number }) {
  return (
    <motion.div
      custom={index}
      variants={rowVariants}
      initial="hidden"
      animate="visible"
      style={{
        display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap',
        padding: '10px 0', borderTop: index === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <span style={{
        fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: 'rgba(148,163,184,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
        minWidth: '78px', flexShrink: 0,
      }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', color: '#e2e8f0', lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {children}
      </span>
    </motion.div>
  )
}

export function FinalSummaryView({
  summary,
  sellTimeline,
}: {
  summary: FinalSummary | null | undefined
  // Optional, additive — omitting it simply skips the sell-activity badge (no fabricated default).
  sellTimeline?: SellTimelineResult | null
}) {
  const walletPersonality = summary?.walletPersonality ?? 'Insufficient data to classify wallet behavior.'
  const sellActivity = sellActivityLabel(sellTimeline?.totalSells ?? 0)
  const financialHeadline = summary?.financialStatus?.headline ?? 'PnL unavailable due to missing evidence.'
  const officialPnlStatus = summary?.financialStatus?.officialPnlStatus ?? 'unavailable'
  const rotationStyle = summary?.behavioralStatus?.rotationStyle ?? 'unknown'
  const riskOnOff = summary?.behavioralStatus?.riskOnOff ?? 'unknown'
  const chainParticipationSummary = summary?.chainParticipationSummary ?? 'No chain participation data available.'
  const recoverySummary = summary?.recoverySummary ?? 'No recovery attempted.'

  const riskIcon = riskOnOff === 'risk_on'
    ? <TrendingUpIcon size={13} color="#fbbf24" />
    : riskOnOff === 'risk_off'
      ? <TrendingDownIcon size={13} color="#38bdf8" />
      : null

  return (
    <section>
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}
      >
        <span style={{ color: '#2DD4BF', display: 'inline-flex' }}><HeartbeatIcon size={17} /></span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Wallet Personality
        </h3>
        <StatusBadge label={officialPnlStatus.replace(/_/g, ' ')} tone={pnlStatusTone(officialPnlStatus)} glow />
        {sellActivity && <StatusBadge label={sellActivity.label} tone={sellActivity.tone} />}
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.24, delay: 0.05 }}
        style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}
      >
        {walletPersonality}
      </motion.p>

      <div>
        <SummaryRow label="Financial" index={0}>
          {financialHeadline}
        </SummaryRow>
        <SummaryRow label="Behavior" index={1}>
          <span style={{ textTransform: 'capitalize' }}>{rotationStyle}</span>
          <span style={{ color: 'rgba(148,163,184,0.4)' }}>·</span>
          {riskIcon}
          <span>{riskOnOff.replace(/_/g, ' ')}</span>
        </SummaryRow>
        <SummaryRow label="Chains" index={2}>
          {chainParticipationSummary}
        </SummaryRow>
        <SummaryRow label="Recovery" index={3}>
          {recoverySummary}
        </SummaryRow>
      </div>
    </section>
  )
}

export default FinalSummaryView

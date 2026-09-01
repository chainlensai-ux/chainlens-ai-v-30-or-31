'use client'

// WALLET READ PANEL, DISCLOSED (Wallet Read / CORTEX sidebar redesign task): pure presentation over
// walletReadBuilder.ts's WalletReadV2 output — every string/number rendered here is already computed
// by that file (see its own header for the "same selectors as the main UI" disclosure). This
// component adds no data logic of its own beyond formatting/layout.
//
// DESIGN INTENT, DISCLOSED (this task's own explicit UI requirements): compact stat cards over long
// paragraphs, important numbers first, a real badge system for evidence state (verified/partial/
// missing color-coded but subtle — no loud red/green flashing), terminal-style monospace labels for
// data-dense rows. No chatbot framing ("Hi! Here's what I found...") anywhere.
import type { WalletReadV2 } from '@/app/frontend/lib/walletReadBuilder'

const MONO = 'var(--font-plex-mono, IBM Plex Mono, monospace)'
const SANS = 'var(--font-inter, Inter, sans-serif)'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.50)', marginBottom: '8px', fontFamily: MONO }}>
      {children}
    </div>
  )
}

const CONFIDENCE_TONE: Record<WalletReadV2['identity']['confidence'], { bg: string; border: string; color: string }> = {
  High: { bg: 'rgba(74,222,128,0.10)', border: 'rgba(74,222,128,0.30)', color: '#4ade80' },
  Medium: { bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.30)', color: '#fbbf24' },
  Low: { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', color: '#94a3b8' },
}

function ConfidenceBadge({ level }: { level: WalletReadV2['identity']['confidence'] }) {
  const tone = CONFIDENCE_TONE[level]
  return (
    <span style={{
      padding: '3px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
      background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color, fontFamily: MONO, whiteSpace: 'nowrap',
    }}>
      {level} confidence
    </span>
  )
}

const EVIDENCE_TONE: Record<'verified' | 'partial' | 'missing', { color: string; dot: string }> = {
  verified: { color: '#4ade80', dot: 'rgba(74,222,128,0.85)' },
  partial: { color: '#fbbf24', dot: 'rgba(251,191,36,0.85)' },
  missing: { color: '#94a3b8', dot: 'rgba(148,163,184,0.65)' },
}

function EvidenceGroup({ tone, title, items }: { tone: 'verified' | 'partial' | 'missing'; title: string; items: string[] }) {
  if (items.length === 0) return null
  const t = EVIDENCE_TONE[tone]
  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: t.dot, flexShrink: 0 }} />
        <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.color, fontFamily: MONO }}>{title}</span>
      </div>
      <div style={{ paddingLeft: '12px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        {items.map((item) => (
          <span key={item} style={{ fontSize: '11.5px', color: '#cbd5e1', lineHeight: 1.5 }}>{item}</span>
        ))}
      </div>
    </div>
  )
}

const LANE_TONE: Record<WalletReadV2['pnlLanes'][number]['status'], { color: string; bg: string; border: string }> = {
  verified: { color: '#4ade80', bg: 'rgba(74,222,128,0.08)', border: 'rgba(74,222,128,0.25)' },
  partial: { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)' },
  not_verified: { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)' },
  unavailable: { color: '#94a3b8', bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.20)' },
}

function PnlLaneRow({ lane }: { lane: WalletReadV2['pnlLanes'][number] }) {
  const tone = LANE_TONE[lane.status]
  return (
    <div style={{
      padding: '9px 10px', borderRadius: '10px', background: tone.bg, border: `1px solid ${tone.border}`,
      marginBottom: '6px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '3px' }}>
        <span style={{ fontSize: '11px', fontWeight: 800, color: '#e2e8f0', fontFamily: MONO }}>{lane.chainLabel}</span>
        <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: tone.color, fontFamily: MONO }}>{lane.statusLabel}</span>
      </div>
      <p style={{ margin: 0, fontSize: '10.5px', color: 'rgba(203,213,225,0.75)', lineHeight: 1.5 }}>{lane.detail}</p>
    </div>
  )
}

export function WalletReadPanel({ read }: { read: WalletReadV2 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* 1. IDENTITY */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
          <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)', fontFamily: MONO }}>{read.identity.shortAddress}</span>
          <ConfidenceBadge level={read.identity.confidence} />
        </div>
        <h2 style={{ margin: '2px 0 4px', fontSize: '17px', fontWeight: 900, color: '#f1f5f9', fontFamily: SANS, letterSpacing: '-0.01em' }}>
          {read.identity.personalityLabel}
        </h2>
        <span style={{ fontSize: '10px', color: 'rgba(148,163,184,0.50)', fontFamily: MONO }}>{read.identity.dataFreshness}</span>
      </div>

      {/* 2. HEADLINE */}
      <p style={{ margin: 0, fontSize: '12.5px', color: '#cbd5e1', lineHeight: 1.6 }}>{read.headline}</p>

      {/* 3. KEY SIGNALS — compact stat grid, numbers stand out first */}
      <div>
        <SectionLabel>Key Signals</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          {read.keySignals.map((sig) => (
            <div key={sig.label} style={{ padding: '8px 10px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: '9px', color: 'rgba(148,163,184,0.55)', marginBottom: '3px', fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{sig.label}</div>
              <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#e2e8f0' }}>{sig.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. WHY THIS LABEL */}
      {read.whyThisLabel.length > 0 && (
        <div>
          <SectionLabel>Why This Label</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {read.whyThisLabel.map((bullet) => (
              <div key={bullet} style={{ display: 'flex', gap: '7px', fontSize: '11.5px', color: '#cbd5e1', lineHeight: 1.5 }}>
                <span style={{ color: '#2DD4BF', flexShrink: 0 }}>▸</span>
                <span>{bullet}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5. RISK / EVIDENCE — verified / partial / missing, color-coded but subtle */}
      <div>
        <SectionLabel>Evidence</SectionLabel>
        <EvidenceGroup tone="verified" title="Verified" items={read.evidence.verified} />
        <EvidenceGroup tone="partial" title="Partial" items={read.evidence.partial} />
        <EvidenceGroup tone="missing" title="Missing" items={read.evidence.missing} />
      </div>

      {/* 6. PNL LANE SUMMARY — never merged */}
      <div>
        <SectionLabel>PnL Lanes</SectionLabel>
        {read.pnlLanes.map((lane) => <PnlLaneRow key={lane.chainLabel} lane={lane} />)}
      </div>

      {/* 7. NEXT ACTION */}
      <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.20)' }}>
        <div style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.75)', marginBottom: '4px', fontFamily: MONO }}>Next Action</div>
        <p style={{ margin: 0, fontSize: '12px', color: '#e2e8f0', lineHeight: 1.5 }}>{read.nextAction}</p>
      </div>
    </div>
  )
}

export default WalletReadPanel

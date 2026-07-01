// Shared confidence/evidence badge — used by PnLTab, SellTimelineV2View-adjacent UI. Renders
// exactly the confidence levels this codebase's modules actually produce ('high'|'medium'|'low')
// plus an honest "evidence missing" state — never a fabricated confidence level.
const CONFIDENCE_STYLE: Record<string, { bg: string; border: string; color: string }> = {
  high: { bg: 'rgba(45,212,191,0.10)', border: 'rgba(45,212,191,0.35)', color: '#2DD4BF' },
  medium: { bg: 'rgba(56,189,248,0.10)', border: 'rgba(56,189,248,0.35)', color: '#38bdf8' },
  low: { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', color: '#94a3b8' },
  unavailable: { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', color: '#94a3b8' },
  evidence_missing: { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.28)', color: '#fbbf24' },
}

export function ConfidenceBadge({ level, label }: { level: string; label?: string }) {
  const style = CONFIDENCE_STYLE[level] ?? CONFIDENCE_STYLE.low
  return (
    <span
      style={{
        padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800,
        letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap',
        background: style.bg, border: `1px solid ${style.border}`, color: style.color,
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
      }}
    >
      {label ?? level.replace('_', ' ')}
    </span>
  )
}

export default ConfidenceBadge

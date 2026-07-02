// Shared status pill — generic tone-based badge used across RecoveryHealthCard/PnlStatusCard/
// CoverageTimelineCard. Distinct from ConfidenceBadge (which renders this codebase's real
// high/medium/low confidence levels specifically) — StatusBadge takes a caller-supplied label and
// tone, so it never asserts a value that isn't real/derived by the caller.
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const TONE_STYLE: Record<StatusTone, { bg: string; border: string; color: string }> = {
  success: { bg: 'rgba(74,222,128,0.10)', border: 'rgba(74,222,128,0.32)', color: '#4ade80' },
  warning: { bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.32)', color: '#fbbf24' },
  danger: { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.32)', color: '#f87171' },
  info: { bg: 'rgba(56,189,248,0.10)', border: 'rgba(56,189,248,0.32)', color: '#38bdf8' },
  neutral: { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.28)', color: '#94a3b8' },
}

export function StatusBadge({ label, tone = 'neutral', glow = false }: { label: string; tone?: StatusTone; glow?: boolean }) {
  const style = TONE_STYLE[tone]
  return (
    <span
      style={{
        padding: '3px 11px', borderRadius: '999px', fontSize: '10px', fontWeight: 800,
        letterSpacing: '0.09em', textTransform: 'uppercase', whiteSpace: 'nowrap',
        background: style.bg, border: `1px solid ${style.border}`, color: style.color,
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
        boxShadow: glow ? `0 0 14px ${style.border}` : undefined,
      }}
    >
      {label}
    </span>
  )
}

export default StatusBadge

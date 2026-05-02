import type { CSSProperties } from 'react'

interface ClarkOrbProps {
  size?: number
  className?: string
  style?: CSSProperties
  thinking?: boolean
}

export default function ClarkOrb({ size = 24, className, style, thinking = false }: ClarkOrbProps) {
  const dot = Math.max(3, Math.round(size * 0.18))
  return (
    <span
      className={`${className ?? ''}${thinking ? ' clark-orb-thinking' : ''}`.trim()}
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '999px',
        background: 'radial-gradient(circle at 30% 30%, rgba(15,23,42,0.98) 0%, rgba(6,10,28,0.98) 100%)',
        border: '1px solid rgba(103,232,249,0.36)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 'inset 0 0 0 1px rgba(167,139,250,0.24), 0 0 14px rgba(139,92,246,0.22)',
        pointerEvents: 'none',
        ...style,
      }}
      aria-hidden="true"
    >
      <span style={{ position: 'absolute', inset: Math.max(3, Math.round(size * 0.18)), borderRadius: '999px', border: '1px solid rgba(167,139,250,0.24)' }} />
      <span style={{ width: dot, height: dot, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 7px rgba(34,211,238,0.80)' }} />
      <span style={{ width: dot, height: dot, borderRadius: '50%', background: '#c084fc', boxShadow: '0 0 7px rgba(192,132,252,0.78)', marginLeft: Math.max(2, Math.round(size * 0.1)) }} />
    </span>
  )
}

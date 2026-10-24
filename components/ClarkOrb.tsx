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
        background: 'radial-gradient(circle at 30% 30%, rgba(17,19,21,0.98) 0%, rgba(8,9,10,0.98) 100%)',
        border: '1px solid rgba(98,241,241,0.36)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 'inset 0 0 0 1px rgba(209,212,215,0.24), 0 0 14px rgba(209,212,215,0.22)',
        pointerEvents: 'none',
        ...style,
      }}
      aria-hidden="true"
    >
      <span style={{ position: 'absolute', inset: Math.max(3, Math.round(size * 0.18)), borderRadius: '999px', border: '1px solid rgba(209,212,215,0.24)' }} />
      <span style={{ width: dot, height: dot, borderRadius: '50%', background: '#1fd6dc', boxShadow: '0 0 7px rgba(31,214,220,0.80)' }} />
      <span style={{ width: dot, height: dot, borderRadius: '50%', background: '#e1e4e7', boxShadow: '0 0 7px rgba(225,228,231,0.78)', marginLeft: Math.max(2, Math.round(size * 0.1)) }} />
    </span>
  )
}

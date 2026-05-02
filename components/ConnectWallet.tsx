'use client'

import { useAccount, useConnect } from 'wagmi'

export default function ConnectWallet({ className }: { className?: string }) {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const handleConnect = () => {
    const connector = connectors.find(c => c.ready) ?? connectors[0]
    if (connector) connect({ connector })
  }

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '11px 28px',
    borderRadius: '10px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 700,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    fontFamily: 'inherit',
    transition: 'opacity 0.15s, box-shadow 0.15s, transform 0.15s',
    background: 'linear-gradient(90deg, #22d3ee 0%, #2DD4BF 50%, #0ea5e9 100%)',
    color: '#03111a',
    boxShadow: '0 0 28px rgba(34,211,238,0.45), 0 0 28px rgba(45,212,191,0.25)',
    whiteSpace: 'nowrap',
  }

  const connectedStyle: React.CSSProperties = {
    ...baseStyle,
    background: 'rgba(34,211,238,0.10)',
    color: '#22d3ee',
    border: '1px solid rgba(34,211,238,0.30)',
    boxShadow: '0 0 16px rgba(34,211,238,0.18)',
  }

  if (isConnected && address) {
    return (
      <button
        onClick={handleConnect}
        className={className}
        style={connectedStyle}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLButtonElement
          el.style.boxShadow = '0 0 28px rgba(34,211,238,0.35)'
          el.style.borderColor = 'rgba(34,211,238,0.55)'
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLButtonElement
          el.style.boxShadow = '0 0 16px rgba(34,211,238,0.18)'
          el.style.borderColor = 'rgba(34,211,238,0.30)'
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: '#4ade80', boxShadow: '0 0 6px #4ade80',
          flexShrink: 0,
        }} />
        {address.slice(0, 6)}…{address.slice(-4)}
      </button>
    )
  }

  return (
    <button
      onClick={handleConnect}
      className={className}
      style={baseStyle}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLButtonElement
        el.style.opacity = '0.90'
        el.style.transform = 'translateY(-1px)'
        el.style.boxShadow = '0 0 44px rgba(34,211,238,0.65), 0 0 44px rgba(45,212,191,0.40)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLButtonElement
        el.style.opacity = '1'
        el.style.transform = 'translateY(0)'
        el.style.boxShadow = '0 0 28px rgba(34,211,238,0.45), 0 0 28px rgba(45,212,191,0.25)'
      }}
    >
      Connect Wallet
    </button>
  )
}

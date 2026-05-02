'use client'

import { useState, useRef, useEffect } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'

export default function ConnectWallet({ className }: { className?: string }) {
  const { address, isConnected } = useAccount()
  const { connect, connectors }  = useConnect()
  const { disconnect }           = useDisconnect()
  const [open, setOpen]          = useState(false)
  const ref                      = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const handleConnect = () => {
    const connector = connectors.find(c => c.ready) ?? connectors[0]
    if (connector) connect({ connector })
  }

  const baseStyle: React.CSSProperties = {
    display: 'flex',
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
    width: '100%',
  }

  const connectedStyle: React.CSSProperties = {
    ...baseStyle,
    background: 'rgba(34,211,238,0.10)',
    color: '#22d3ee',
    border: '1px solid rgba(34,211,238,0.30)',
    boxShadow: '0 0 16px rgba(34,211,238,0.18)',
    padding: '9px 12px',
    justifyContent: 'space-between',
  }

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`
    return (
      <div ref={ref} className={className} style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={connectedStyle}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.boxShadow   = '0 0 28px rgba(34,211,238,0.35)'
            el.style.borderColor = 'rgba(34,211,238,0.55)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.boxShadow   = '0 0 16px rgba(34,211,238,0.18)'
            el.style.borderColor = 'rgba(34,211,238,0.30)'
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#4ade80', boxShadow: '0 0 6px #4ade80',
              flexShrink: 0,
            }} />
            {short}
          </span>
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{
              opacity: 0.55,
              transition: 'transform 0.15s',
              transform: open ? 'rotate(180deg)' : 'none',
              flexShrink: 0,
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {open && (
          <div style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            borderRadius: '10px',
            background: '#0d1020',
            border: '1px solid rgba(34,211,238,0.22)',
            boxShadow: '0 -8px 32px rgba(0,0,0,0.72), 0 0 16px rgba(34,211,238,0.06)',
            padding: '8px',
            zIndex: 100,
          }}>
            <div style={{
              padding: '6px 8px 8px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              marginBottom: '6px',
            }}>
              <p style={{
                fontSize: '9px', fontWeight: 700,
                letterSpacing: '0.14em', textTransform: 'uppercase',
                color: '#3d6478', fontFamily: 'var(--font-plex-mono)',
                marginBottom: '3px',
              }}>Connected Wallet</p>
              <p style={{ fontSize: '11px', color: '#5eead4', fontFamily: 'var(--font-plex-mono)' }}>
                {short}
              </p>
            </div>

            <button
              onClick={() => { disconnect(); setOpen(false) }}
              style={{
                width: '100%',
                padding: '7px 10px',
                borderRadius: '7px',
                background: 'rgba(239,68,68,0.07)',
                border: '1px solid rgba(239,68,68,0.16)',
                color: '#f87171',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'var(--font-inter)',
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                transition: 'background 0.12s, border-color 0.12s',
              }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLButtonElement
                el.style.background   = 'rgba(239,68,68,0.13)'
                el.style.borderColor  = 'rgba(239,68,68,0.28)'
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLButtonElement
                el.style.background   = 'rgba(239,68,68,0.07)'
                el.style.borderColor  = 'rgba(239,68,68,0.16)'
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Disconnect
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={handleConnect}
      className={className}
      style={baseStyle}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLButtonElement
        el.style.opacity   = '0.90'
        el.style.transform = 'translateY(-1px)'
        el.style.boxShadow = '0 0 44px rgba(34,211,238,0.65), 0 0 44px rgba(45,212,191,0.40)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLButtonElement
        el.style.opacity   = '1'
        el.style.transform = 'translateY(0)'
        el.style.boxShadow = '0 0 28px rgba(34,211,238,0.45), 0 0 28px rgba(45,212,191,0.25)'
      }}
    >
      Connect Wallet
    </button>
  )
}

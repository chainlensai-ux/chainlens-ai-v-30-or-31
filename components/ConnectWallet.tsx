'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { walletConnectEnabled } from '@/lib/wallet'

export default function ConnectWallet({ className }: { className?: string }) {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)
  const [unavailableMsg, setUnavailableMsg] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)


  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useEffect(() => {
    if (process.env.NODE_ENV === 'development' && !walletConnectEnabled) {
      console.warn('[wallet] WalletConnect unavailable: missing NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID')
    }
  }, [])

  useEffect(() => {
    if (!unavailableMsg) return
    const t = window.setTimeout(() => setUnavailableMsg(null), 3200)
    return () => window.clearTimeout(t)
  }, [unavailableMsg])

  const handleConnect = () => {
    if (!walletConnectEnabled) {
      setUnavailableMsg('Wallet connection unavailable right now.')
      return
    }
    const connector = connectors.find(c => c.ready) ?? connectors[0]
    if (connector) {
      connect(
        { connector },
        {
          onError: () => setUnavailableMsg('Wallet connection unavailable right now.'),
        }
      )
    }
    else setUnavailableMsg('Wallet connection unavailable right now.')
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
    const shortAddress = `${address.slice(0, 6)}…${address.slice(-4)}`

    return (
      <div ref={menuRef} className={className} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full"
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
        {shortAddress}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 'calc(100% + 8px)',
            borderRadius: '10px',
            border: '1px solid rgba(34,211,238,0.24)',
            background: 'rgba(5,12,24,0.96)',
            boxShadow: '0 12px 30px rgba(2,6,23,0.65), 0 0 20px rgba(34,211,238,0.10)',
            padding: '10px',
            zIndex: 40,
            backdropFilter: 'blur(10px)',
          }}
        >
          <div style={{ fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.88)', marginBottom: '5px' }}>
            Connected wallet
          </div>
          <div style={{ fontSize: '12px', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px' }}>
            {shortAddress}
          </div>
          <button
            type="button"
            onClick={() => {
              disconnect()
              setOpen(false)
            }}
            style={{
              width: '100%',
              borderRadius: '8px',
              border: '1px solid rgba(248,113,113,0.36)',
              background: 'rgba(248,113,113,0.10)',
              color: '#fca5a5',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '8px 10px',
              cursor: 'pointer',
            }}
          >
            Disconnect
          </button>
        </div>
      )}
      </div>
    )
  }

  return (
    <div className={className} style={{ position: 'relative' }}>
      <button
        onClick={handleConnect}
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
      {unavailableMsg && (
        <div style={{
          marginTop: '8px',
          borderRadius: '8px',
          border: '1px solid rgba(248,113,113,0.35)',
          background: 'rgba(127,29,29,0.25)',
          color: '#fecaca',
          fontSize: '11px',
          lineHeight: 1.4,
          padding: '7px 10px',
        }}>
          {unavailableMsg}
        </div>
      )}
    </div>
  )
}

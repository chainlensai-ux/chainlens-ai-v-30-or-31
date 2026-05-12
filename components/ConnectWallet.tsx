'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { useWeb3Modal } from '@web3modal/wagmi/react'
import { walletConnectEnabled } from '@/lib/wallet'

// ---------- connector display metadata ----------

const LABEL_MAP: Record<string, string> = {
  injected: 'MetaMask',
  metaMask: 'MetaMask',
  walletConnect: 'WalletConnect',
  walletConnectLegacy: 'WalletConnect',
  coinbaseWalletSDK: 'Coinbase Wallet',
  coinbaseWallet: 'Coinbase Wallet',
  safe: 'Safe',
}

const ICON_MAP: Record<string, string> = {
  injected: '🦊',
  metaMask: '🦊',
  walletConnect: '◈',
  walletConnectLegacy: '◈',
  coinbaseWalletSDK: '🔵',
  coinbaseWallet: '🔵',
  safe: '🔒',
}

const ALLOWED_CONNECTOR_IDS = new Set([
  'walletConnect', 'walletConnectLegacy', 'injected', 'metaMask', 'coinbaseWalletSDK', 'coinbaseWallet',
])

function connectorLabel(id: string, name: string) {
  return LABEL_MAP[id] ?? LABEL_MAP[name.toLowerCase().replace(/\s+/g, '')] ?? name
}
function connectorIcon(id: string) {
  return ICON_MAP[id] ?? '💼'
}
function isWalletConnect(id: string) {
  return /walletconnect/i.test(id)
}
function isMetaMaskConnector(id: string, name: string) {
  return /metamask/i.test(id) || /metamask/i.test(name)
}
function dedupeConnectors(all: ReturnType<typeof useConnect>['connectors']) {
  const seen = new Set<string>()
  return all.filter(c => {
    if (!ALLOWED_CONNECTOR_IDS.has(c.id)) return false
    const label = connectorLabel(c.id, c.name)
    if (seen.has(label)) return false
    seen.add(label)
    return true
  })
}


const CONNECTOR_PRIORITY: string[] = ['WalletConnect', 'MetaMask', 'Coinbase Wallet']

function visibleConnectors(connectors: ReturnType<typeof useConnect>['connectors']) {
  const firstByLabel = new Map<string, (typeof connectors)[number]>()
  for (const connector of connectors) {
    const label = connectorLabel(connector.id, connector.name)
    if (label === 'Phantom') continue
    if (!CONNECTOR_PRIORITY.includes(label)) continue
    if (!firstByLabel.has(label)) firstByLabel.set(label, connector)
  }
  return CONNECTOR_PRIORITY.map(label => firstByLabel.get(label)).filter(Boolean) as (typeof connectors)[number][]
}

// ---------- WCBridge: only mounts client-side, provides web3modal.open via ref ----------
// Separated so that useWeb3Modal() is never called during SSR (it throws before
// createWeb3Modal is initialised).

function WCBridge({ openRef }: { openRef: React.MutableRefObject<(() => void) | null> }) {
  const { open } = useWeb3Modal()
  openRef.current = open
  return null
}

// ---------- component ----------

export default function ConnectWallet({ className, onBeforeOpen }: { className?: string; onBeforeOpen?: () => void | Promise<void> }) {
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors: allConnectors } = useConnect()
  const connectors = dedupeConnectors(allConnectors)
  const filteredConnectors = visibleConnectors(connectors)
  const { disconnect } = useDisconnect()

  // web3modal.open is populated by WCBridge once it mounts (client-only)
  const openWeb3ModalRef = useRef<(() => void) | null>(null)
  const [mounted, setMounted] = useState(false)
  const [isMobileClient, setIsMobileClient] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [disconnectOpen, setDisconnectOpen] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (!mounted) return
    const ua = navigator.userAgent || ''
    const mobileUa = /android|iphone|ipad|ipod|mobile/i.test(ua)
    const touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
    setIsMobileClient(mobileUa || touch)
  }, [mounted])

  // close modal / menus on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setModalOpen(false)
      setDisconnectOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // close disconnect dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setDisconnectOpen(false)
    }
    if (disconnectOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [disconnectOpen])

  // close modal once connected
  useEffect(() => {
    if (isConnected && modalOpen) {
      setModalOpen(false)
      setConnecting(false)
      setSelected(null)
      setErrorMsg(null)
    }
  }, [isConnected, modalOpen])

  const openModal = useCallback(async () => {
    await onBeforeOpen?.()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    setSelected(null)
    setConnecting(false)
    setErrorMsg(null)
    setModalOpen(true)
  }, [onBeforeOpen])

  const closeModal = useCallback(() => {
    setModalOpen(false)
    setConnecting(false)
    setSelected(null)
    setErrorMsg(null)
  }, [])

  const handleConnector = useCallback(async (connector: (typeof connectors)[number]) => {
    if (!connector) return
    const connectorId = String(connector.id || '').toLowerCase()
    const isMetaMask = isMetaMaskConnector(connector.id, connector.name)
    const strictDesktopInjectedCheck =
      !isMobileClient &&
      isMetaMask

    if (strictDesktopInjectedCheck && typeof connector.getProvider === 'function') {
      const provider = await connector.getProvider().catch(() => null)
      if (!provider) {
        setSelected(connector.id)
        setErrorMsg('Wallet unavailable. Try another wallet.')
        setConnecting(false)
        return
      }
    }

    setSelected(connector.id)
    setErrorMsg(null)

    if (isWalletConnect(connector.id) && walletConnectEnabled && openWeb3ModalRef.current) {
      openWeb3ModalRef.current()
      closeModal()
      return
    }

    setConnecting(true)
    try {
      await connectAsync({ connector })
      // useEffect closes modal on isConnected change
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : ''
      const cancelled =
        msg.includes('rejected') ||
        msg.includes('cancelled') ||
        msg.includes('canceled') ||
        msg.includes('denied') ||
        msg.includes('user rejected')
      const unavailable =
        msg.includes('not found') ||
        msg.includes('not installed') ||
        msg.includes('unsupported') ||
        msg.includes('unavailable')

      if (isMetaMask && isMobileClient && unavailable && mounted) {
        const currentUrl = window.location.href.replace(/^https?:\/\//, '')
        setErrorMsg('Opening MetaMask...')
        setConnecting(false)
        window.location.href = `https://metamask.app.link/dapp/${currentUrl}`
        return
      }

      if (cancelled) setErrorMsg('Connection cancelled.')
      else if (unavailable) setErrorMsg('Wallet unavailable. Try another wallet.')
      else setErrorMsg('Connection failed. Please try again.')
      setConnecting(false)
    }
  }, [connectAsync, connectors, closeModal, isMobileClient, mounted])

  // ── shared button styles ──────────────────────────────────────────────────

  const baseStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    padding: '11px 28px', borderRadius: '10px', border: 'none', cursor: 'pointer',
    fontSize: '12px', fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase',
    fontFamily: 'inherit', transition: 'opacity 0.15s, box-shadow 0.15s, transform 0.15s',
    background: 'linear-gradient(90deg, #22d3ee 0%, #2DD4BF 50%, #0ea5e9 100%)',
    color: '#03111a',
    boxShadow: '0 0 28px rgba(34,211,238,0.45), 0 0 28px rgba(45,212,191,0.25)',
    whiteSpace: 'nowrap', width: '100%',
  }

  const connectedStyle: React.CSSProperties = {
    ...baseStyle,
    background: 'rgba(34,211,238,0.10)', color: '#22d3ee',
    border: '1px solid rgba(34,211,238,0.30)',
    boxShadow: '0 0 16px rgba(34,211,238,0.18)',
    padding: '9px 12px', justifyContent: 'space-between',
  }

  // ── connected state ───────────────────────────────────────────────────────

  if (isConnected && address) {
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`
    return (
      <div ref={menuRef} className={className} style={{ position: 'relative' }}>
        <button
          onClick={() => setDisconnectOpen(v => !v)}
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
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 6px #4ade80', flexShrink: 0 }} />
          {short}
        </button>
        {disconnectOpen && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 8px)',
            borderRadius: '10px', border: '1px solid rgba(34,211,238,0.24)',
            background: 'rgba(5,12,24,0.97)', backdropFilter: 'blur(10px)',
            boxShadow: '0 12px 30px rgba(2,6,23,0.65), 0 0 20px rgba(34,211,238,0.10)',
            padding: '10px', zIndex: 40,
          }}>
            <div style={{ fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.88)', marginBottom: '5px' }}>
              Connected wallet
            </div>
            <div style={{ fontSize: '12px', color: '#67e8f9', fontFamily: 'var(--font-plex-mono)', marginBottom: '9px' }}>
              {short}
            </div>
            <button
              type="button"
              onClick={() => { disconnect(); setDisconnectOpen(false) }}
              style={{
                width: '100%', borderRadius: '8px',
                border: '1px solid rgba(248,113,113,0.36)',
                background: 'rgba(248,113,113,0.10)', color: '#fca5a5',
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em',
                textTransform: 'uppercase', padding: '8px 10px', cursor: 'pointer',
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    )
  }

  // ── disconnected — trigger button + modal ─────────────────────────────────

  const modalJsx = (
        <div
          onClick={closeModal}
          style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            background: 'rgba(0,4,15,0.80)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          }}
        >
          <style>{`
            @media (max-width: 540px) {
              .cl-wallet-modal { flex-direction: column !important; max-height: 90vh; overflow-y: auto; }
              .cl-wallet-left { flex: 0 0 auto !important; border-right: none !important; border-bottom: 1px solid rgba(148,163,184,0.08) !important; }
              .cl-wallet-right { flex: 0 0 auto !important; min-height: 160px !important; }
            }
          `}</style>
          <div
            onClick={e => e.stopPropagation()}
            className="cl-wallet-modal"
            style={{
              position: 'relative',
              display: 'flex',
              width: '100%', maxWidth: '680px',
              background: 'linear-gradient(170deg, rgba(8,14,30,0.99) 0%, rgba(4,8,20,0.98) 100%)',
              border: '1px solid rgba(34,211,238,0.18)',
              borderRadius: '20px',
              boxShadow: '0 0 80px rgba(34,211,238,0.10), 0 40px 100px rgba(0,0,0,0.75), inset 0 0 40px rgba(34,211,238,0.03)',
              overflow: 'hidden',
              minHeight: '380px',
            }}
          >
            {/* close button */}
            <button
              onClick={closeModal}
              style={{
                position: 'absolute', top: '14px', right: '14px', zIndex: 1,
                width: '30px', height: '30px', borderRadius: '50%',
                border: '1px solid rgba(148,163,184,0.18)',
                background: 'rgba(148,163,184,0.06)', color: '#94a3b8',
                fontSize: '18px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                lineHeight: 1, fontFamily: 'inherit',
              }}
              aria-label="Close"
            >
              ×
            </button>

            {/* ── left column: wallet list ────────────────────────────── */}
            <div className="cl-wallet-left" style={{
              flex: '0 0 260px', padding: '32px 22px',
              borderRight: '1px solid rgba(148,163,184,0.08)',
            }}>
              <div style={{ marginBottom: '22px' }}>
                <div style={{ fontSize: '17px', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.01em', marginBottom: '5px' }}>
                  Connect a Wallet
                </div>
                <div style={{ fontSize: '12px', color: '#475569' }}>
                  Choose how you want to connect
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                {filteredConnectors.map(c => {
                  const label = connectorLabel(c.id, c.name)
                  const icon = connectorIcon(c.id)
                  const isWC = isWalletConnect(c.id)
                  const isActive = selected === c.id
                  return (
                    <button
                      key={c.id}
                      onClick={() => handleConnector(c)}
                      disabled={connecting}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '11px',
                        padding: '11px 13px', borderRadius: '12px', cursor: connecting ? 'not-allowed' : 'pointer',
                        border: isActive
                          ? '1px solid rgba(34,211,238,0.45)'
                          : '1px solid rgba(148,163,184,0.10)',
                        background: isActive
                          ? 'rgba(34,211,238,0.07)'
                          : 'rgba(15,23,42,0.50)',
                        color: isActive ? '#22d3ee' : '#cbd5e1',
                        fontSize: '13.5px', fontWeight: 600,
                        textAlign: 'left', width: '100%',
                        transition: 'border-color 0.15s, background 0.15s',
                        opacity: connecting && !isActive ? 0.45 : 1,
                      }}
                    >
                      <span style={{ fontSize: '19px', lineHeight: 1, flexShrink: 0 }}>{icon}</span>
                      <span style={{ flex: 1 }}>{label}</span>
                      {isWC && (
                        <span style={{
                          fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em',
                          color: '#67e8f9', border: '1px solid rgba(103,232,249,0.28)',
                          borderRadius: '4px', padding: '2px 5px',
                        }}>
                          QR
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                <div style={{ fontSize: '11px', color: '#334155', lineHeight: 1.5 }}>
                  By connecting, you agree to our Terms and acknowledge that on-chain activity is public.
                </div>
              </div>
            </div>

            {/* ── right column: status panel ──────────────────────────── */}
            <div className="cl-wallet-right" style={{
              flex: '1 1 260px', padding: '32px 24px',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              minHeight: '280px',
            }}>
              {!selected && !errorMsg && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{
                    width: '72px', height: '72px', borderRadius: '50%', margin: '0 auto 18px',
                    border: '1px solid rgba(34,211,238,0.15)',
                    background: 'radial-gradient(circle, rgba(34,211,238,0.06), transparent 70%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '28px',
                  }}>
                    🔐
                  </div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#64748b', marginBottom: '6px' }}>
                    No wallet selected
                  </div>
                  <div style={{ fontSize: '12px', color: '#334155' }}>
                    Pick a wallet on the left to start
                  </div>
                </div>
              )}

              {selected && connecting && !errorMsg && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{
                    width: '72px', height: '72px', borderRadius: '50%', margin: '0 auto 18px',
                    border: '2px solid rgba(34,211,238,0.30)',
                    borderTopColor: '#22d3ee',
                    animation: 'spin 0.9s linear infinite',
                    flexShrink: 0,
                  }} />
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', marginBottom: '8px' }}>
                    Connecting…
                  </div>
                  <div style={{ fontSize: '12.5px', color: '#64748b', maxWidth: '200px' }}>
                    {isWalletConnect(selected)
                      ? 'Scan the QR code in your wallet app'
                      : `Open ${connectorLabel(selected, selected)} to approve`}
                  </div>
                </div>
              )}

              {selected && !connecting && !errorMsg && !isWalletConnect(selected) && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '40px', marginBottom: '14px' }}>
                    {connectorIcon(selected)}
                  </div>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', marginBottom: '8px' }}>
                    Open {connectorLabel(selected, selected)}
                  </div>
                  <div style={{ fontSize: '12.5px', color: '#64748b', maxWidth: '200px' }}>
                    Your wallet will prompt you to approve the connection
                  </div>
                </div>
              )}

                {errorMsg && (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '28px', marginBottom: '14px' }}>⚠️</div>
                  <div style={{ fontSize: '13px', color: '#f87171', marginBottom: '16px', maxWidth: '220px', lineHeight: 1.5 }}>
                    {errorMsg}
                  </div>
                  <button
                    onClick={() => { setErrorMsg(null); setSelected(null); setConnecting(false) }}
                    style={{
                      padding: '8px 18px', borderRadius: '8px',
                      border: '1px solid rgba(34,211,238,0.30)',
                      background: 'rgba(34,211,238,0.06)', color: '#22d3ee',
                      fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
  )

  return (
    <>
      {/* WCBridge only renders client-side; keeps useWeb3Modal() out of SSR */}
      {mounted && walletConnectEnabled && <WCBridge openRef={openWeb3ModalRef} />}

      <button
        onClick={async (e) => {
          e.preventDefault()
          e.stopPropagation()
          await openModal()
        }}
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

      {/* ── modal rendered via portal so it escapes sidebar stacking context ── */}
      {mounted && modalOpen && createPortal(modalJsx, document.body)}
    </>
  )
}

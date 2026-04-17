'use client'

import ClarkChat from '@/components/ClarkChat'

interface HomeClarkPanelProps {
  open: boolean
  initialMessage: string | null
  onClose: () => void
}

export default function HomeClarkPanel({ open, initialMessage, onClose }: HomeClarkPanelProps) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        height: '100vh',
        width: open ? '380px' : '0',
        overflow: 'hidden',
        transition: 'width 320ms cubic-bezier(0.4, 0, 0.2, 1)',
        zIndex: 50,
        background: '#050816',
        borderLeft: open ? '1px solid rgba(123,92,255,0.18)' : 'none',
        boxShadow: open ? '-12px 0 40px rgba(0,0,0,0.50)' : 'none',
      }}
    >
      {/* Close button — sits over the terminal header's right side */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: '13px',
          right: '16px',
          zIndex: 20,
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.30)',
          cursor: 'pointer',
          fontSize: '20px',
          lineHeight: 1,
          padding: '2px 6px',
          fontFamily: 'var(--font-plex-mono)',
          transition: 'color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.80)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.30)' }}
        aria-label="Close panel"
      >
        ×
      </button>

      {/*
        Inner wrapper: fixed 380px width so ClarkChat never collapses during
        the outer width animation. overflowY lets the hero + screener sections
        scroll while the chat message area handles its own internal scroll.
      */}
      <div
        style={{
          width: '380px',
          height: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ClarkChat active={null} initialMessage={initialMessage} />
      </div>
    </div>
  )
}

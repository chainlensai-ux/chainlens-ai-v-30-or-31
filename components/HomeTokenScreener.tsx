'use client'

const TOKENS = [
  { sym: 'BRETT',   chain: 'Base',   price: '$0.142',    change: +24.7, vol: '$12.4M', color: '#3b82f6' },
  { sym: 'TOSHI',   chain: 'Base',   price: '$0.00089',  change: +18.3, vol: '$8.2M',  color: '#0ea5e9' },
  { sym: 'VIRTUAL', chain: 'Base',   price: '$2.89',     change: +12.1, vol: '$24.1M', color: '#8b5cf6' },
  { sym: 'AERO',    chain: 'Base',   price: '$1.47',     change: -3.2,  vol: '$6.8M',  color: '#2DD4BF' },
  { sym: 'BONK',    chain: 'Solana', price: '$0.000024', change: +8.9,  vol: '$15.3M', color: '#f97316' },
]

export default function HomeTokenScreener() {
  return (
    <section style={{ padding: '0 24px 96px' }}>
      <div
        style={{
          maxWidth: '960px',
          margin: '0 auto',
          background: 'linear-gradient(160deg, #0a0f1e 0%, #070b16 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          overflow: 'hidden',
          boxShadow: [
            '0 0 24px rgba(45,212,191,0.07)',
            '0 0 16px rgba(139,92,246,0.06)',
            '0 24px 64px rgba(0,0,0,0.55)',
          ].join(', '),
        }}
      >
        {/* Top accent line */}
        <div
          style={{
            height: '1px',
            background:
              'linear-gradient(90deg, transparent, rgba(45,212,191,0.35), rgba(139,92,246,0.35), transparent)',
          }}
        />

        {/* Header row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <span
            style={{
              fontSize: '14px',
              fontWeight: 700,
              color: '#f1f5f9',
              fontFamily: 'var(--font-inter)',
            }}
          >
            Token Screener
          </span>

          {/* Single active tab — Trending only */}
          <div
            style={{
              padding: '5px 14px',
              borderRadius: '8px',
              fontSize: '12px',
              fontFamily: 'var(--font-inter)',
              fontWeight: 600,
              background: 'rgba(45,212,191,0.10)',
              border: '1px solid rgba(45,212,191,0.28)',
              color: '#2DD4BF',
            }}
          >
            Trending
          </div>
        </div>

        {/* Column headers */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
            padding: '9px 24px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {['TOKEN', 'CHAIN', 'PRICE', '24H', 'VOLUME'].map((col) => (
            <span
              key={col}
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.12em',
                color: '#3e5c78',
                fontFamily: 'var(--font-plex-mono)',
                textTransform: 'uppercase',
              }}
            >
              {col}
            </span>
          ))}
        </div>

        {/* Rows */}
        {TOKENS.map((token, i) => (
          <div
            key={token.sym}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
              padding: '12px 24px',
              alignItems: 'center',
              borderBottom: i < TOKENS.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              cursor: 'pointer',
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.025)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            {/* Token */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '30px',
                  height: '30px',
                  borderRadius: '50%',
                  background: `${token.color}20`,
                  border: `1px solid ${token.color}38`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  fontWeight: 700,
                  fontFamily: 'var(--font-plex-mono)',
                  color: token.color,
                  flexShrink: 0,
                }}
              >
                {token.sym[0]}
              </div>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  color: '#e2e8f0',
                  fontFamily: 'var(--font-inter)',
                }}
              >
                {token.sym}
              </span>
            </div>

            {/* Chain */}
            <span
              style={{
                fontSize: '12px',
                color: '#4e6e88',
                fontFamily: 'var(--font-inter)',
              }}
            >
              {token.chain}
            </span>

            {/* Price */}
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#e2e8f0',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              {token.price}
            </span>

            {/* 24H */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {token.change > 0 ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M5 2L8.5 7H1.5L5 2Z" fill="#2DD4BF"/>
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M5 8L1.5 3H8.5L5 8Z" fill="#fb7185"/>
                </svg>
              )}
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  fontFamily: 'var(--font-plex-mono)',
                  color: token.change > 0 ? '#2DD4BF' : '#fb7185',
                }}
              >
                {token.change > 0 ? '+' : ''}{token.change}%
              </span>
            </div>

            {/* Volume */}
            <span
              style={{
                fontSize: '12px',
                color: '#7a90a8',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              {token.vol}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

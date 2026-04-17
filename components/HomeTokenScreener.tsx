'use client'

const COLS = ['TOKEN', 'CHAIN', 'PRICE', '24H', 'VOLUME']


export default function HomeTokenScreener() {
  return (
    <>
      <section style={{ padding: '0 0 64px' }}>
        <div
          style={{
            width: '100%',
            background: 'linear-gradient(160deg, #080d1c 0%, #060a14 100%)',
            border: '1px solid rgba(255,255,255,0.06)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            overflow: 'hidden',
            boxShadow: [
              '0 0 20px rgba(45,212,191,0.05)',
              '0 0 12px rgba(139,92,246,0.04)',
              '0 20px 56px rgba(0,0,0,0.50)',
            ].join(', '),
          }}
        >
          {/* Top accent line */}
          <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.28), rgba(139,92,246,0.28), transparent)' }} />

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9', fontFamily: 'var(--font-inter)' }}>
              Token Screener
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                fontSize: '9px', fontWeight: 700, color: '#ffffff',
                background: '#0052FF', borderRadius: '4px',
                padding: '2px 8px', fontFamily: 'var(--font-inter)',
                letterSpacing: '0.05em',
              }}>
                BASE
              </span>
              <div style={{
                padding: '4px 12px', borderRadius: '7px',
                fontSize: '11px', fontFamily: 'var(--font-inter)', fontWeight: 600,
                background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.22)',
                color: '#2DD4BF',
              }}>
                Trending
              </div>
            </div>
          </div>

          {/* Column headers */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', padding: '7px 20px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            {COLS.map(col => (
              <span key={col} style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', color: '#3e5c78', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                {col}
              </span>
            ))}
          </div>

          {/* Empty state */}
          <div style={{
            padding: '36px 20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
          }}>
            <span style={{
              fontSize: '11px',
              color: 'rgba(255,255,255,0.22)',
              fontFamily: 'var(--font-inter)',
              letterSpacing: '0.01em',
            }}>
              No tokens yet — live Base data will appear here
            </span>
          </div>

          {/* Footer */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 20px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 5px rgba(45,212,191,0.65)', flexShrink: 0 }} />
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.07em' }}>
              LIVE BASE DATA
            </span>
          </div>
        </div>
      </section>
    </>
  )
}

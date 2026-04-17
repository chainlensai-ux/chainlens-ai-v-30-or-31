'use client'

const COLS = ['TOKEN', 'CHAIN', 'PRICE', '24H', 'VOLUME']

const TOKENS = [
  { ticker: 'BRETT',  name: 'Brett',   abbr: 'BR', price: '$0.1247',   change: '+8.4%',  vol: '$2.1M',  pos: true  },
  { ticker: 'TOSHI',  name: 'Toshi',   abbr: 'TO', price: '$0.000041', change: '+12.3%', vol: '$890K',  pos: true  },
  { ticker: 'DEGEN',  name: 'Degen',   abbr: 'DG', price: '$0.01831',  change: '-3.2%',  vol: '$1.4M',  pos: false },
  { ticker: 'NORMIE', name: 'Normie',  abbr: 'NR', price: '$0.00891',  change: '+2.1%',  vol: '$320K',  pos: true  },
  { ticker: 'HIGHER', name: 'Higher',  abbr: 'HI', price: '$0.05234',  change: '+5.7%',  vol: '$740K',  pos: true  },
]

function TokenRow({ token, last }: { token: typeof TOKENS[number]; last: boolean }) {
  return (
    <div
      className="screener-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
        padding: '9px 20px',
        alignItems: 'center',
        borderBottom: !last ? '1px solid rgba(255,255,255,0.03)' : 'none',
        transition: 'background 0.12s',
      }}
    >
      {/* Token */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '26px', height: '26px', borderRadius: '50%',
          background: 'rgba(255,255,255,0.06)', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.38)', fontFamily: 'var(--font-plex-mono)' }}>
            {token.abbr}
          </span>
        </div>
        <div>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9', fontFamily: 'var(--font-inter)' }}>
            {token.ticker}
          </div>
          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', fontFamily: 'var(--font-inter)' }}>
            {token.name}
          </div>
        </div>
      </div>

      {/* Chain — Base highlighted */}
      <div>
        <span style={{
          fontSize: '9px', fontWeight: 700, color: '#ffffff',
          background: '#0052FF', borderRadius: '4px',
          padding: '2px 6px', fontFamily: 'var(--font-inter)',
          letterSpacing: '0.04em',
        }}>
          Base
        </span>
      </div>

      {/* Price */}
      <div style={{ fontSize: '11px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>
        {token.price}
      </div>

      {/* 24H */}
      <div style={{
        fontSize: '11px', fontWeight: 500,
        color: token.pos ? '#22c55e' : '#ef4444',
        fontFamily: 'var(--font-plex-mono)',
      }}>
        {token.change}
      </div>

      {/* Volume */}
      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-plex-mono)' }}>
        {token.vol}
      </div>
    </div>
  )
}

export default function HomeTokenScreener() {
  return (
    <>
      <style>{`
        .screener-row:hover {
          background: rgba(0,82,255,0.04);
          box-shadow: inset 0 0 20px rgba(45,212,191,0.03);
        }
      `}</style>
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

          {/* Token rows */}
          {TOKENS.map((t, i) => (
            <TokenRow key={t.ticker} token={t} last={i === TOKENS.length - 1} />
          ))}

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

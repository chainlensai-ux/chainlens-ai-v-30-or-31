'use client'

const COLS = ['TOKEN', 'CHAIN', 'PRICE', '24H', 'VOLUME']

function SkeletonRow({ index }: { index: number }) {
  const widths = [
    ['60%', '50%', '55%', '40%', '45%'],
    ['70%', '45%', '60%', '50%', '40%'],
    ['55%', '55%', '50%', '45%', '55%'],
    ['65%', '48%', '58%', '42%', '50%'],
    ['75%', '52%', '45%', '48%', '42%'],
  ][index]

  return (
    <div
      className="screener-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
        padding: '9px 20px',
        alignItems: 'center',
        borderBottom: index < 4 ? '1px solid rgba(255,255,255,0.03)' : 'none',
        transition: 'background 0.12s',
      }}
    >
      {/* Token cell — circle + bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div
          className="animate-pulse"
          style={{
            width: '26px',
            height: '26px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.05)',
            flexShrink: 0,
          }}
        />
        <div
          className="animate-pulse"
          style={{
            height: '9px',
            width: widths[0],
            borderRadius: '4px',
            background: 'rgba(255,255,255,0.05)',
          }}
        />
      </div>

      {/* Remaining cells */}
      {widths.slice(1).map((w, i) => (
        <div
          key={i}
          className="animate-pulse"
          style={{
            height: '9px',
            width: w,
            borderRadius: '4px',
            background: 'rgba(255,255,255,0.05)',
          }}
        />
      ))}
    </div>
  )
}

export default function HomeTokenScreener() {
  return (
    <>
      <style>{`
        .screener-row:hover {
          background: rgba(139,92,246,0.04);
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
          <div
            style={{
              height: '1px',
              background:
                'linear-gradient(90deg, transparent, rgba(45,212,191,0.28), rgba(139,92,246,0.28), transparent)',
            }}
          />

          {/* Header row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#f1f5f9',
                fontFamily: 'var(--font-inter)',
              }}
            >
              Token Screener
            </span>

            <div
              style={{
                padding: '4px 12px',
                borderRadius: '7px',
                fontSize: '11px',
                fontFamily: 'var(--font-inter)',
                fontWeight: 600,
                background: 'rgba(45,212,191,0.08)',
                border: '1px solid rgba(45,212,191,0.22)',
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
              padding: '7px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            {COLS.map((col) => (
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

          {/* Skeleton rows */}
          {[0, 1, 2, 3, 4].map((i) => (
            <SkeletonRow key={i} index={i} />
          ))}

          {/* Empty state overlay */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '8px',
              padding: '18px 20px 22px',
              borderTop: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '9px',
                background: 'linear-gradient(135deg, rgba(45,212,191,0.12), rgba(139,92,246,0.08))',
                border: '1px solid rgba(45,212,191,0.18)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 10px rgba(45,212,191,0.08)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                <path
                  d="M7 1.5L8.1 5.1H11.9L8.8 7.2L9.9 10.8L7 8.7L4.1 10.8L5.2 7.2L2.1 5.1H5.9L7 1.5Z"
                  fill="#2DD4BF"
                  fillOpacity="0.6"
                />
              </svg>
            </div>
            <p
              style={{
                fontSize: '11px',
                color: 'rgba(255,255,255,0.24)',
                fontFamily: 'var(--font-inter)',
                letterSpacing: '0.01em',
              }}
            >
              Live trending tokens will appear here…
            </p>
          </div>
        </div>
      </section>
    </>
  )
}

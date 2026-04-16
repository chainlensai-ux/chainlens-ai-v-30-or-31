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
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
        padding: '12px 24px',
        alignItems: 'center',
        borderBottom: index < 4 ? '1px solid rgba(255,255,255,0.04)' : 'none',
      }}
    >
      {/* Token cell — circle + bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div
          className="animate-pulse"
          style={{
            width: '30px',
            height: '30px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}
        />
        <div
          className="animate-pulse"
          style={{
            height: '10px',
            width: widths[0],
            borderRadius: '4px',
            background: 'rgba(255,255,255,0.06)',
          }}
        />
      </div>

      {/* Remaining cells */}
      {widths.slice(1).map((w, i) => (
        <div
          key={i}
          className="animate-pulse"
          style={{
            height: '10px',
            width: w,
            borderRadius: '4px',
            background: 'rgba(255,255,255,0.06)',
          }}
        />
      ))}
    </div>
  )
}

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
            gap: '10px',
            padding: '28px 24px 32px',
            borderTop: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, rgba(45,212,191,0.14), rgba(139,92,246,0.10))',
              border: '1px solid rgba(45,212,191,0.20)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 12px rgba(45,212,191,0.10)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 1.5L8.1 5.1H11.9L8.8 7.2L9.9 10.8L7 8.7L4.1 10.8L5.2 7.2L2.1 5.1H5.9L7 1.5Z"
                fill="#2DD4BF"
                fillOpacity="0.7"
              />
            </svg>
          </div>
          <p
            style={{
              fontSize: '12px',
              color: 'rgba(255,255,255,0.28)',
              fontFamily: 'var(--font-inter)',
              letterSpacing: '0.01em',
            }}
          >
            Live trending tokens will appear here…
          </p>
        </div>
      </div>
    </section>
  )
}

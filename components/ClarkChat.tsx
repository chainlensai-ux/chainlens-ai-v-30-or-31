'use client'

export default function ClarkChat({ active }: { active: string | null }) {
  return (
    <div
      className="flex-1 flex"
      style={{ padding: '32px' }}
    >
      <div
        className="flex-1 flex items-center justify-center rounded-2xl"
        style={{
          background: '#080c14',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <p
          style={{
            color: 'rgba(255,255,255,0.18)',
            fontFamily: 'var(--font-plex-mono)',
            fontSize: '11px',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
          }}
        >
          CENTER PANEL READY FOR REBUILD
        </p>
      </div>
    </div>
  )
}

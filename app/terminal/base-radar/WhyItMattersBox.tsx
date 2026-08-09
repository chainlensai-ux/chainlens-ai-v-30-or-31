'use client'

// EVIDENCE BULLETS, DISCLOSED (Base Radar drawer premium polish task #5): default list markers
// swapped for a subtle dot + more breathing room per line — content (the sentences prop) is
// completely unchanged, only how each line is presented.
export default function WhyItMattersBox({ sentences }: { sentences: string[] }) {
  return (
    <section style={{ border: '1px solid rgba(45,212,191,0.14)', background: 'rgba(45,212,191,0.03)', borderRadius: '14px', padding: '14px 15px', marginBottom: '14px' }}>
      <h3 style={{ margin: '0 0 10px', color: '#99f6e4', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Why It Matters</h3>
      <div style={{ display: 'grid', gap: '9px' }}>
        {sentences.map((sentence) => (
          <div key={sentence} style={{ display: 'grid', gridTemplateColumns: '6px 1fr', gap: '10px', alignItems: 'start' }}>
            <span aria-hidden style={{ marginTop: '6px', width: '6px', height: '6px', borderRadius: '999px', background: '#2dd4bf', flexShrink: 0 }} />
            <span style={{ color: '#cbd5e1', fontSize: '12px', lineHeight: 1.55 }}>{sentence}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

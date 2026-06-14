'use client'

export default function WhyItMattersBox({ sentences }: { sentences: string[] }) {
  return (
    <section style={{ border: '1px solid rgba(45,212,191,0.16)', background: 'rgba(45,212,191,0.04)', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
      <h3 style={{ margin: '0 0 8px', color: '#99f6e4', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Why It Matters</h3>
      <ul style={{ margin: 0, paddingLeft: '18px', color: '#cbd5e1', fontSize: '12px', lineHeight: 1.55 }}>
        {sentences.map((sentence) => <li key={sentence}>{sentence}</li>)}
      </ul>
    </section>
  )
}

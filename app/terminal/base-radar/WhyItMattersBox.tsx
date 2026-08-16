'use client'

// EVIDENCE BULLETS, DISCLOSED (Base Radar drawer premium polish task #5): default list markers
// swapped for a subtle dot + more breathing room per line — content (the sentences prop) is
// completely unchanged, only how each line is presented.
//
// INSIGHT-ROWS, DISCLOSED (Robinhood/Base Radar panel premium polish task #3 — "convert into
// tighter, more trader-friendly insight rows... bold the leading phrase of each insight"): purely
// a display split of the same already-generated sentence string — never rewrites, shortens, or
// adds to the underlying copy. Splits at the first natural break (an em dash, or a comma
// introducing a consequence clause like ", which"/", so") since every sentence this codebase
// generates for this box already follows a "claim — consequence" or "claim, consequence" shape;
// falls back to bolding the first few words when no such break is found early enough, rather than
// bolding an entire long sentence.
function splitLeadingPhrase(sentence: string): { lead: string; rest: string } {
  const breakPattern = /( — |, which | so | because )/
  const match = breakPattern.exec(sentence)
  if (match && match.index > 0 && match.index <= 90) {
    return { lead: sentence.slice(0, match.index), rest: sentence.slice(match.index) }
  }
  const words = sentence.split(' ')
  const lead = words.slice(0, 5).join(' ')
  return { lead, rest: sentence.slice(lead.length) }
}

export default function WhyItMattersBox({ sentences }: { sentences: string[] }) {
  return (
    <section style={{ border: '1px solid rgba(45,212,191,0.14)', background: 'rgba(45,212,191,0.03)', borderRadius: '14px', padding: '13px 15px', marginBottom: '9px' }}>
      <h3 style={{ margin: '0 0 11px', color: '#99f6e4', fontSize: '11px', letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>Why It Matters</h3>
      <div style={{ display: 'grid', gap: '7px' }}>
        {sentences.map((sentence) => {
          const { lead, rest } = splitLeadingPhrase(sentence)
          return (
            <div key={sentence} style={{ display: 'grid', gridTemplateColumns: '6px 1fr', gap: '10px', alignItems: 'start', padding: '7px 8px', borderRadius: 9, background: 'rgba(2,6,23,.28)' }}>
              <span aria-hidden style={{ marginTop: '6px', width: '6px', height: '6px', borderRadius: '999px', background: '#2dd4bf', flexShrink: 0 }} />
              <span style={{ color: '#cbd5e1', fontSize: '12px', lineHeight: 1.55 }}>
                <strong style={{ color: '#e2e8f0', fontWeight: 750 }}>{lead}</strong>{rest}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

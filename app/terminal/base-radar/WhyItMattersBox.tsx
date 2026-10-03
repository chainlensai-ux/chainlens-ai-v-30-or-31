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

// EMPHASIS (receipt polish, display only): a sentence that carries risk/caution language is marked as
// important — amber marker + brighter lead — so it stands out from routine explanation. The sentence
// text itself is never changed.
const IMPORTANT_RE = /\b(risk|unverified|not verified|no verified|open check|unavailable|concentrat|unlocked|no lock|warning|caution|honeypot|tax|thin|low liquidity|drain|rug|control)\b/i

export default function WhyItMattersBox({ sentences }: { sentences: string[] }) {
  return (
    <section style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.022), rgba(255,255,255,0.008))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.035)', borderRadius: '14px', padding: '16px 18px 10px', marginBottom: '12px' }}>
      <h3 style={{ margin: '0 0 8px', color: '#cbd5e1', fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', display: 'flex', alignItems: 'center', gap: '9px' }}>
        <span aria-hidden style={{ width: 3, height: 12, borderRadius: 2, background: '#2dd4bf', opacity: 0.85 }} />Why It Matters
      </h3>
      <div style={{ display: 'grid' }}>
        {sentences.map((sentence, index) => {
          const { lead, rest } = splitLeadingPhrase(sentence)
          const important = IMPORTANT_RE.test(sentence)
          return (
            <div key={sentence} className="receipt-why-row" style={{ display: 'grid', gridTemplateColumns: '14px 1fr', gap: '10px', alignItems: 'start', padding: '10px 8px', margin: '0 -8px', borderRadius: 8, borderTop: index === 0 ? 'none' : '1px solid rgba(255,255,255,0.045)' }}>
              <span aria-hidden style={{ marginTop: '5px', width: 14, height: 14, borderRadius: 4, display: 'grid', placeItems: 'center', background: important ? 'rgba(251,191,36,0.10)' : 'rgba(45,212,191,0.08)' }}>
                <span style={{ width: 5, height: 5, borderRadius: 999, background: important ? '#fbbf24' : '#2dd4bf', opacity: important ? 0.95 : 0.7 }} />
              </span>
              <span style={{ color: important ? '#b6c3d1' : '#8fa0b4', fontSize: '12.5px', lineHeight: 1.6 }}>
                <strong style={{ color: important ? '#f1f5f9' : '#d6dee8', fontWeight: important ? 650 : 600 }}>{lead}</strong>{rest}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

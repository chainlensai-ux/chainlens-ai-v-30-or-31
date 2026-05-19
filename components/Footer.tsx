import Link from 'next/link'

const FOOTER_LINKS = [
  { href: '/contact', label: 'Contact' },
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/refund', label: 'Refund Policy' },
]

export default function Footer() {
  return (
    <footer className="mt-32 py-10 text-center border-t border-white/10" style={{ fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
      <p className="text-white/50">© {new Date().getFullYear()} ChainLens AI — Built for Base</p>
      <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {FOOTER_LINKS.map((link, i) => (
          <>
            <Link key={link.href} href={link.href} style={{
              fontSize: '12px', color: 'rgba(45,212,191,0.65)',
              textDecoration: 'none', padding: '3px 10px',
              borderRadius: '999px',
              border: '1px solid rgba(45,212,191,0.18)',
              background: 'rgba(45,212,191,0.06)',
              transition: 'color 0.15s, border-color 0.15s',
              fontWeight: 600, letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
            }}>
              {link.label}
            </Link>
            {i < FOOTER_LINKS.length - 1 && (
              <span key={`dot-${i}`} style={{ color: 'rgba(255,255,255,0.12)', fontSize: '12px' }}>·</span>
            )}
          </>
        ))}
      </div>
      <div style={{ marginTop: '12px' }}>
        <a href="mailto:chainlensai@gmail.com" style={{
          fontSize: '12px', color: 'rgba(255,255,255,0.30)',
          textDecoration: 'none', transition: 'color 0.15s',
        }}>
          chainlensai@gmail.com
        </a>
      </div>
    </footer>
  )
}

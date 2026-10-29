import type { Metadata } from 'next'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import BrandMark from '@/components/BrandMark'

export const metadata: Metadata = {
  title: 'Contact ChainLens | Support Center',
  description: 'Get help with onboarding, account access, payments, bug reports, or product feedback from the ChainLens team.',
}

// Same contact channels, links and copy as before; restyled onto the site's dark navy / teal design language
// (the pricing / landing / terminal surfaces): site navbar, deep-navy lit background with a faint terminal grid,
// glass panels with a thin accent edge, and the ChainLens monogram footer.
const MAIL = 'chainlensai@gmail.com'
const TELEGRAM = 'https://t.me/chainlensaigroup'
const X_URL = 'https://x.com/chainlens_ai'

export default function ContactPage() {
  return (
    <>
      <style>{`
        .ct-page { min-height: 100dvh; background: #03060f; color: #e2e8f0; font-family: var(--font-inter, Inter, sans-serif); position: relative; overflow: hidden; }
        /* Lit navy backdrop: teal/cyan glow from the top, a cool blue wash low right, a faint terminal grid. */
        .ct-backdrop { position: absolute; inset: 0; pointer-events: none; z-index: 0;
          background:
            radial-gradient(ellipse 70% 45% at 50% -8%, rgba(45,212,191,0.16) 0%, rgba(34,211,238,0.06) 45%, transparent 75%),
            radial-gradient(ellipse 55% 40% at 92% 78%, rgba(56,120,248,0.10) 0%, transparent 70%),
            radial-gradient(ellipse 45% 35% at 6% 60%, rgba(129,140,248,0.06) 0%, transparent 70%),
            linear-gradient(180deg, #040915 0%, #03060f 55%, #02040b 100%);
        }
        .ct-grid { position: absolute; inset: 0; pointer-events: none; z-index: 0; opacity: 0.55;
          background-image: linear-gradient(rgba(56,189,248,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.05) 1px, transparent 1px);
          background-size: 56px 56px;
          -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, #000 0%, transparent 75%);
          mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, #000 0%, transparent 75%);
        }
        .ct-wrap { max-width: 1040px; margin: 0 auto; padding: 56px 24px 0; position: relative; z-index: 1; }

        .ct-chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px;
          background: rgba(45,212,191,0.07); border: 1px solid rgba(45,212,191,0.24);
          font-size: 10px; font-weight: 700; letter-spacing: 0.2em; color: rgba(94,234,212,0.9);
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace); box-shadow: 0 0 22px rgba(45,212,191,0.10); }
        .ct-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 8px #2dd4bf; }
        .ct-title { font-size: clamp(32px, 6vw, 56px); font-weight: 900; letter-spacing: -0.03em; line-height: 1.05; margin: 22px 0 16px;
          background: linear-gradient(120deg, #f1f5f9 0%, #a5f3fc 38%, #2dd4bf 68%, #60a5fa 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        .ct-lede { font-size: 17px; color: rgba(203,213,225,0.62); max-width: 540px; margin: 0 auto; line-height: 1.65; }
        .ct-meta { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
        .ct-meta span { font-size: 11px; color: rgba(148,163,184,0.75); border: 1px solid rgba(148,163,184,0.14); background: rgba(8,14,28,0.55);
          border-radius: 999px; padding: 5px 12px; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); letter-spacing: 0.04em; }

        /* Glass panel with a thin accent edge on top (colour per channel via --ct-accent). */
        .ct-panel { position: relative; overflow: hidden; border-radius: 18px; padding: 26px;
          background: linear-gradient(170deg, rgba(10,18,36,0.84), rgba(5,10,22,0.80));
          border: 1px solid rgba(96,165,250,0.12);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 40px rgba(0,0,0,0.35);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s; }
        .ct-panel::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px;
          background: linear-gradient(90deg, transparent 0%, var(--ct-accent, rgba(45,212,191,0.6)) 50%, transparent 100%); opacity: 0.8; }
        .ct-card { display: flex; flex-direction: column; gap: 16px; }
        .ct-card:hover { transform: translateY(-2px); border-color: rgba(45,212,191,0.28); box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 0 44px rgba(45,212,191,0.08), 0 16px 44px rgba(0,0,0,0.40); }
        .ct-icon { width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
          background: var(--ct-icon-bg); border: 1px solid var(--ct-icon-border); box-shadow: 0 0 18px var(--ct-icon-glow); }
        .ct-card-title { font-size: 15px; font-weight: 700; color: #f1f5f9; margin-bottom: 6px; }
        .ct-card-text { font-size: 13px; color: rgba(203,213,225,0.55); line-height: 1.6; }
        .ct-handle { font-size: 11px; font-family: var(--font-plex-mono, IBM Plex Mono, monospace); letter-spacing: 0.04em; overflow-wrap: anywhere; }

        .ct-cta { display: inline-flex; align-items: center; gap: 8px; padding: 11px 20px; border-radius: 999px; font-size: 12px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none; white-space: nowrap;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace); transition: box-shadow 0.15s, background 0.15s, border-color 0.15s; }
        .ct-cta:focus-visible { outline: 2px solid rgba(94,234,212,0.8); outline-offset: 2px; }
        .ct-cta-email { background: rgba(45,212,191,0.10); border: 1px solid rgba(45,212,191,0.32); color: #5eead4; }
        .ct-cta-email:hover { background: rgba(45,212,191,0.18); border-color: rgba(45,212,191,0.56); box-shadow: 0 0 22px rgba(45,212,191,0.24); }
        .ct-cta-telegram { background: rgba(56,189,248,0.10); border: 1px solid rgba(56,189,248,0.30); color: #7dd3fc; }
        .ct-cta-telegram:hover { background: rgba(56,189,248,0.18); border-color: rgba(56,189,248,0.54); box-shadow: 0 0 22px rgba(56,189,248,0.22); }
        .ct-cta-x { background: rgba(255,255,255,0.05); border: 1px solid rgba(226,232,240,0.18); color: rgba(241,245,249,0.85); }
        .ct-cta-x:hover { background: rgba(255,255,255,0.09); border-color: rgba(226,232,240,0.34); box-shadow: 0 0 22px rgba(148,163,184,0.12); }

        .ct-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 52px 0 14px; }
        .ct-bug-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 18px 0 20px; }
        .ct-bug-item { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 10px;
          background: rgba(9,16,34,0.62); border: 1px solid rgba(96,165,250,0.10); }
        .ct-bug-dot { width: 6px; height: 6px; border-radius: 50%; background: #818cf8; box-shadow: 0 0 6px rgba(129,140,248,0.7); flex-shrink: 0; margin-top: 5px; }
        .ct-bug-label { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(165,180,252,0.9);
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace); margin-bottom: 2px; }
        .ct-bug-desc { font-size: 12px; color: rgba(203,213,225,0.48); line-height: 1.55; }

        .ct-promise { display: flex; gap: 18px; align-items: flex-start; margin: 14px 0 0; }
        .ct-link-teal { color: #5eead4; text-decoration: none; }
        .ct-link-blue { color: #7dd3fc; text-decoration: none; }
        .ct-link-teal:hover, .ct-link-blue:hover { text-decoration: underline; }

        .ct-footer { position: relative; z-index: 1; margin-top: 72px; border-top: 1px solid rgba(96,165,250,0.10); background: rgba(2,5,13,0.78); }
        .ct-footer::before { content: ''; position: absolute; left: 0; right: 0; top: -1px; height: 1px;
          background: linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.45) 30%, rgba(96,165,250,0.35) 65%, transparent 100%); }
        .ct-footer-inner { max-width: 1040px; margin: 0 auto; padding: 28px 24px 36px; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .ct-footer-links { display: flex; gap: 22px; flex-wrap: wrap; }
        .ct-footer-link { font-size: 12px; color: rgba(148,163,184,0.62); text-decoration: none; letter-spacing: 0.06em;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace); transition: color 0.15s; }
        .ct-footer-link:hover { color: #e2e8f0; }

        @media (max-width: 900px) { .ct-grid-3 { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 600px) {
          .ct-wrap { padding-top: 36px; }
          .ct-grid-3 { grid-template-columns: 1fr; margin-top: 40px; }
          .ct-bug-grid { grid-template-columns: 1fr; }
          .ct-panel { padding: 22px 18px; }
          .ct-cta { width: 100%; justify-content: center; }
          .ct-cta-row { flex-direction: column; }
          .ct-footer-inner { flex-direction: column; align-items: flex-start; }
        }
        @media (prefers-reduced-motion: reduce) { .ct-card, .ct-card:hover { transition: none; transform: none; } }
      `}</style>

      <div className="ct-page">
        <div className="ct-backdrop" aria-hidden="true" />
        <div className="ct-grid" aria-hidden="true" />
        <Navbar />

        <main className="ct-wrap">
          {/* ── Hero ─────────────────────────────────────────── */}
          <header style={{ textAlign: 'center' }}>
            <span className="ct-chip"><span className="ct-chip-dot" aria-hidden="true" />SUPPORT CENTER</span>
            <h1 className="ct-title">Contact ChainLens</h1>
            <p className="ct-lede">Get help with onboarding, account access, payments, bug reports, or product feedback.</p>
            <div className="ct-meta">
              <span>Account &amp; billing</span>
              <span>Bug reports</span>
              <span>Product feedback</span>
            </div>
          </header>

          {/* ── Support channels ─────────────────────────────── */}
          <section className="ct-grid-3" aria-label="Contact channels">
            <div className="ct-panel ct-card" style={{ ['--ct-accent' as string]: 'rgba(45,212,191,0.7)' }}>
              <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(45,212,191,0.10)', ['--ct-icon-border' as string]: 'rgba(45,212,191,0.26)', ['--ct-icon-glow' as string]: 'rgba(45,212,191,0.14)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="#5eead4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="#5eead4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <h2 className="ct-card-title">Email Support</h2>
                <p className="ct-card-text" style={{ margin: 0 }}>For account, billing, onboarding, or general support.</p>
              </div>
              <div className="ct-handle" style={{ color: 'rgba(94,234,212,0.72)' }}>{MAIL}</div>
              <a href={`mailto:${MAIL}?subject=ChainLens%20Support`} className="ct-cta ct-cta-email" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Email ChainLens
              </a>
            </div>

            <div className="ct-panel ct-card" style={{ ['--ct-accent' as string]: 'rgba(56,189,248,0.7)' }}>
              <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(56,189,248,0.10)', ['--ct-icon-border' as string]: 'rgba(56,189,248,0.24)', ['--ct-icon-glow' as string]: 'rgba(56,189,248,0.14)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M22 2L11 13" stroke="#7dd3fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="#7dd3fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <h2 className="ct-card-title">Telegram Community</h2>
                <p className="ct-card-text" style={{ margin: 0 }}>Join the ChainLens community for quick questions, updates, and support.</p>
              </div>
              <div className="ct-handle" style={{ color: 'rgba(125,211,252,0.72)' }}>t.me/chainlensaigroup</div>
              <a href={TELEGRAM} target="_blank" rel="noopener noreferrer" className="ct-cta ct-cta-telegram" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Join Telegram
              </a>
            </div>

            <div className="ct-panel ct-card" style={{ ['--ct-accent' as string]: 'rgba(226,232,240,0.45)' }}>
              <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(255,255,255,0.05)', ['--ct-icon-border' as string]: 'rgba(226,232,240,0.16)', ['--ct-icon-glow' as string]: 'rgba(148,163,184,0.08)' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L2.127 2.25H8.08l4.261 5.632 5.903-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" fill="rgba(241,245,249,0.8)"/>
                </svg>
              </div>
              <div>
                <h2 className="ct-card-title">Follow on X</h2>
                <p className="ct-card-text" style={{ margin: 0 }}>Product updates, release notes, market posts, and platform announcements.</p>
              </div>
              <div className="ct-handle" style={{ color: 'rgba(203,213,225,0.55)' }}>@chainlens_ai</div>
              <a href={X_URL} target="_blank" rel="noopener noreferrer" className="ct-cta ct-cta-x" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L2.127 2.25H8.08l4.261 5.632 5.903-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" fill="currentColor"/>
                </svg>
                Follow @chainlens_ai
              </a>
            </div>
          </section>

          {/* ── Bug report ───────────────────────────────────── */}
          <section className="ct-panel" aria-labelledby="ct-bug-title" style={{ ['--ct-accent' as string]: 'rgba(129,140,248,0.65)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
              <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(129,140,248,0.10)', ['--ct-icon-border' as string]: 'rgba(129,140,248,0.26)', ['--ct-icon-glow' as string]: 'rgba(129,140,248,0.14)' }}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="#a5b4fc" strokeWidth="1.8"/>
                  <path d="M12 8v4M12 16h.01" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <h2 id="ct-bug-title" className="ct-card-title" style={{ fontSize: '16px', marginBottom: '4px' }}>Report a Bug</h2>
                <p className="ct-card-text" style={{ margin: 0 }}>Help us fix issues faster by including the details below when you reach out.</p>
              </div>
            </div>

            <div className="ct-bug-grid">
              {[
                ['Page or tool affected', 'Which page or tool had the issue (e.g. Token Scanner, Clark AI)'],
                ['What you clicked', 'The action you took before the issue appeared'],
                ['What went wrong', 'What you expected vs. what actually happened'],
                ['Expected result', 'What the correct outcome should have been'],
                ['Screenshot or recording', 'Attach a screenshot or screen recording if possible'],
                ['Token or wallet address', 'Paste the contract or wallet you were analyzing'],
                ['Device and browser', 'OS, device type, browser name and version'],
                ['Account email', 'Include if the issue is account-related'],
              ].map(([label, desc]) => (
                <div key={label} className="ct-bug-item">
                  <div className="ct-bug-dot" aria-hidden="true" />
                  <div>
                    <div className="ct-bug-label">{label}</div>
                    <div className="ct-bug-desc">{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="ct-cta-row" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <a href={`mailto:${MAIL}?subject=Bug%20Report%20%E2%80%94%20ChainLens`} className="ct-cta ct-cta-email">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Email Bug Report
              </a>
              <a href={TELEGRAM} target="_blank" rel="noopener noreferrer" className="ct-cta ct-cta-telegram">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Post in Telegram
              </a>
            </div>
          </section>

          {/* ── Support promise ──────────────────────────────── */}
          <section className="ct-panel ct-promise" style={{ ['--ct-accent' as string]: 'rgba(74,222,128,0.6)', background: 'linear-gradient(170deg, rgba(6,26,26,0.80), rgba(4,12,20,0.80))', borderColor: 'rgba(45,212,191,0.18)' }}>
            <div aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 10px rgba(74,222,128,0.85)', flexShrink: 0, marginTop: '6px' }} />
            <div>
              <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(94,234,212,0.82)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '10px' }}>
                Full Release Support
              </div>
              <p style={{ fontSize: '13px', color: 'rgba(203,213,225,0.62)', lineHeight: 1.72, margin: 0 }}>
                We review support messages, bug reports, and product feedback directly. For the fastest help, include screenshots, the page or tool name, and the token or wallet you were analyzing. You can also reach us on{' '}
                <a href={TELEGRAM} target="_blank" rel="noopener noreferrer" className="ct-link-blue">Telegram</a>
                {' '}or email{' '}
                <a href={`mailto:${MAIL}`} className="ct-link-teal">{MAIL}</a>.
              </p>
            </div>
          </section>
        </main>

        {/* ── Footer: same ChainLens monogram as the navbar and site footers ── */}
        <footer className="ct-footer">
          <div className="ct-footer-inner">
            <Link href="/" aria-label="ChainLens home" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none' }}>
              <BrandMark width={36} />
              <span style={{ fontSize: '15px', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.01em' }}>ChainLens AI</span>
            </Link>
            <nav className="ct-footer-links" aria-label="Footer">
              {([
                { href: '/', label: 'Home' },
                { href: '/pricing', label: 'Pricing' },
                { href: '/terminal', label: 'Terminal' },
                { href: '/affiliate', label: 'Affiliate' },
              ] as const).map((l) => (
                <Link key={l.href} href={l.href} className="ct-footer-link">{l.label}</Link>
              ))}
            </nav>
          </div>
        </footer>
      </div>
    </>
  )
}

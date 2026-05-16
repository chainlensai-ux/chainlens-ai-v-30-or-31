import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Contact ChainLens | Support Center',
  description: 'Get help with onboarding, account access, payments, bug reports, or product feedback from the ChainLens team.',
}

export default function ContactPage() {
  return (
    <>
      <style>{`
        .contact-card {
          background: rgba(8,12,28,0.72);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 20px;
          padding: 28px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          transition: border-color 0.22s, box-shadow 0.22s;
          position: relative;
          overflow: hidden;
        }
        .contact-card::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 20px;
          opacity: 0;
          transition: opacity 0.22s;
          pointer-events: none;
        }
        .contact-card:hover {
          border-color: rgba(45,212,191,0.22);
          box-shadow: 0 0 48px rgba(45,212,191,0.07), 0 8px 32px rgba(0,0,0,0.30);
        }
        .contact-card:hover::before { opacity: 1; }

        .contact-cta {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 11px 22px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          text-decoration: none;
          transition: box-shadow 0.15s, background 0.15s, border-color 0.15s;
          white-space: nowrap;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
        }
        .cta-email {
          background: rgba(45,212,191,0.10);
          border: 1px solid rgba(45,212,191,0.28);
          color: #2DD4BF;
        }
        .cta-email:hover {
          background: rgba(45,212,191,0.18);
          border-color: rgba(45,212,191,0.52);
          box-shadow: 0 0 22px rgba(45,212,191,0.22);
        }
        .cta-telegram {
          background: rgba(56,189,248,0.10);
          border: 1px solid rgba(56,189,248,0.26);
          color: #38bdf8;
        }
        .cta-telegram:hover {
          background: rgba(56,189,248,0.18);
          border-color: rgba(56,189,248,0.50);
          box-shadow: 0 0 22px rgba(56,189,248,0.20);
        }
        .cta-x {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.16);
          color: rgba(255,255,255,0.80);
        }
        .cta-x:hover {
          background: rgba(255,255,255,0.10);
          border-color: rgba(255,255,255,0.30);
          box-shadow: 0 0 22px rgba(255,255,255,0.08);
        }
        .cta-purple {
          background: rgba(139,92,246,0.10);
          border: 1px solid rgba(139,92,246,0.28);
          color: #a78bfa;
        }
        .cta-purple:hover {
          background: rgba(139,92,246,0.18);
          border-color: rgba(139,92,246,0.50);
          box-shadow: 0 0 22px rgba(139,92,246,0.22);
        }

        .bug-item {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 12px 14px;
          border-radius: 10px;
          background: rgba(15,20,40,0.50);
          border: 1px solid rgba(255,255,255,0.06);
          font-family: var(--font-inter, Inter, sans-serif);
        }
        .bug-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: rgba(139,92,246,0.70);
          flex-shrink: 0;
          margin-top: 5px;
        }
        .bug-label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: rgba(167,139,250,0.80);
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
          margin-bottom: 2px;
        }
        .bug-desc {
          font-size: 12px;
          color: rgba(255,255,255,0.42);
          line-height: 1.55;
        }

        .icon-box-teal {
          width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
          background: rgba(45,212,191,0.10);
          border: 1px solid rgba(45,212,191,0.22);
          display: flex; align-items: center; justify-content: center;
        }
        .icon-box-blue {
          width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
          background: rgba(56,189,248,0.10);
          border: 1px solid rgba(56,189,248,0.20);
          display: flex; align-items: center; justify-content: center;
        }
        .icon-box-white {
          width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.13);
          display: flex; align-items: center; justify-content: center;
        }
        .icon-box-purple {
          width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
          background: rgba(139,92,246,0.10);
          border: 1px solid rgba(139,92,246,0.22);
          display: flex; align-items: center; justify-content: center;
        }

        .contact-grid-3 {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 14px;
          margin-bottom: 14px;
        }
        .bug-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin: 16px 0 20px;
        }

        @media (max-width: 900px) {
          .contact-grid-3 { grid-template-columns: 1fr 1fr !important; }
        }
        .contact-footer-link {
          font-size: 12px; color: rgba(255,255,255,0.30);
          text-decoration: none; letter-spacing: 0.06em;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
          transition: color 0.15s;
        }
        .contact-footer-link:hover { color: rgba(255,255,255,0.60); }

        @media (max-width: 600px) {
          .contact-grid-3 { grid-template-columns: 1fr !important; }
          .bug-grid { grid-template-columns: 1fr !important; }
          .contact-cta { width: 100%; justify-content: center; }
          .cta-row { flex-direction: column !important; }
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #05060e 0%, #060810 60%, #04050b 100%)',
        color: '#e2e8f0',
        fontFamily: 'var(--font-inter, Inter, sans-serif)',
        position: 'relative',
        overflow: 'hidden',
      }}>

        {/* Ambient glow */}
        <div style={{
          position: 'absolute', top: '-120px', left: '50%', transform: 'translateX(-50%)',
          width: '700px', height: '400px', borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(45,212,191,0.07) 0%, rgba(139,92,246,0.05) 50%, transparent 75%)',
          pointerEvents: 'none',
        }} />

        <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '72px 24px 100px', position: 'relative' }}>

          {/* ── Hero ─────────────────────────────────────────── */}
          <div style={{ marginBottom: '60px', textAlign: 'center' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px',
              padding: '5px 14px', borderRadius: '999px',
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.20)',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
              color: 'rgba(45,212,191,0.82)',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              marginBottom: '24px',
            }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 7px #2DD4BF' }} />
              SUPPORT CENTER
            </div>

            <h1 style={{
              fontSize: 'clamp(30px, 6vw, 52px)',
              fontWeight: 900,
              letterSpacing: '-0.025em',
              lineHeight: 1.1,
              margin: '0 0 18px',
              background: 'linear-gradient(135deg, #f1f5f9 0%, #2DD4BF 50%, #8b5cf6 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              Contact ChainLens
            </h1>

            <p style={{
              fontSize: '17px',
              color: 'rgba(255,255,255,0.50)',
              maxWidth: '520px',
              margin: '0 auto',
              lineHeight: 1.65,
            }}>
              Get help with onboarding, account access, payments, bug reports, or product feedback.
            </p>
          </div>

          {/* ── Support cards ─────────────────────────────────── */}
          <div className="contact-grid-3">

            {/* Email Support */}
            <div className="contact-card">
              <div className="icon-box-teal">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="#2DD4BF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="#2DD4BF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', marginBottom: '6px' }}>Email Support</div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.6 }}>
                  For account, billing, onboarding, or general support.
                </div>
              </div>
              <div style={{
                fontSize: '11px', color: 'rgba(45,212,191,0.65)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.04em',
              }}>
                chainlensai@gmail.com
              </div>
              <a href="mailto:chainlensai@gmail.com" className="contact-cta cta-email" style={{ alignSelf: 'flex-start' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Email ChainLens
              </a>
            </div>

            {/* Telegram */}
            <div className="contact-card">
              <div className="icon-box-blue">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M22 2L11 13" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', marginBottom: '6px' }}>Telegram Community</div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.6 }}>
                  Join the ChainLens community for quick questions, updates, and support.
                </div>
              </div>
              <div style={{
                fontSize: '11px', color: 'rgba(56,189,248,0.65)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.04em',
              }}>
                t.me/chainlensaigroup
              </div>
              <a
                href="https://t.me/chainlensaigroup"
                target="_blank"
                rel="noopener noreferrer"
                className="contact-cta cta-telegram"
                style={{ alignSelf: 'flex-start' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Join Telegram
              </a>
            </div>

            {/* X / Twitter */}
            <div className="contact-card">
              <div className="icon-box-white">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L2.127 2.25H8.08l4.261 5.632 5.903-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" fill="rgba(255,255,255,0.75)"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', marginBottom: '6px' }}>Follow on X</div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.6 }}>
                  Product updates, release notes, market posts, and platform announcements.
                </div>
              </div>
              <div style={{
                fontSize: '11px', color: 'rgba(255,255,255,0.38)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.04em',
              }}>
                @chainlens_ai
              </div>
              <a
                href="https://x.com/chainlens_ai"
                target="_blank"
                rel="noopener noreferrer"
                className="contact-cta cta-x"
                style={{ alignSelf: 'flex-start' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L2.127 2.25H8.08l4.261 5.632 5.903-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" fill="currentColor"/>
                </svg>
                Follow @chainlens_ai
              </a>
            </div>
          </div>

          {/* ── Bug Report card (full width) ───────────────────── */}
          <div className="contact-card" style={{ marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
              <div className="icon-box-purple">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="#8b5cf6" strokeWidth="1.8"/>
                  <path d="M12 8v4M12 16h.01" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9', marginBottom: '4px' }}>Report a Bug</div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.40)', lineHeight: 1.55 }}>
                  Help us fix issues faster by including the details below when you reach out.
                </div>
              </div>
            </div>

            <div className="bug-grid">
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
                <div key={String(label)} className="bug-item">
                  <div className="bug-dot" />
                  <div>
                    <div className="bug-label">{label}</div>
                    <div className="bug-desc">{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="cta-row" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <a href="mailto:chainlensai@gmail.com?subject=Bug%20Report%20%E2%80%94%20ChainLens" className="contact-cta cta-email">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Email Bug Report
              </a>
              <a
                href="https://t.me/chainlensaigroup"
                target="_blank"
                rel="noopener noreferrer"
                className="contact-cta cta-telegram"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Post in Telegram
              </a>
            </div>
          </div>

          {/* ── Support promise card ──────────────────────────── */}
          <div style={{
            background: 'rgba(45,212,191,0.04)',
            border: '1px solid rgba(45,212,191,0.14)',
            borderRadius: '18px',
            padding: '26px 30px',
            display: 'flex',
            gap: '18px',
            alignItems: 'flex-start',
            marginBottom: '48px',
          }}>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: '#4ade80',
              boxShadow: '0 0 8px rgba(74,222,128,0.80)',
              flexShrink: 0,
              marginTop: '6px',
            }} />
            <div>
              <div style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em',
                textTransform: 'uppercase', color: 'rgba(45,212,191,0.72)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                marginBottom: '10px',
              }}>
                Full Release Support
              </div>
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.50)', lineHeight: 1.72, margin: 0 }}>
                We review support messages, bug reports, and product feedback directly. For the fastest help, include screenshots, the page or tool name, and the token or wallet you were analyzing. You can also reach us on{' '}
                <a
                  href="https://t.me/chainlensaigroup"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'rgba(56,189,248,0.75)', textDecoration: 'none' }}
                >
                  Telegram
                </a>
                {' '}or email{' '}
                <a
                  href="mailto:chainlensai@gmail.com"
                  style={{ color: 'rgba(45,212,191,0.75)', textDecoration: 'none' }}
                >
                  chainlensai@gmail.com
                </a>
                .
              </p>
            </div>
          </div>

          {/* ── Footer links ─────────────────────────────────── */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '24px', flexWrap: 'wrap',
          }}>
            {([
              { href: '/', label: 'Home' },
              { href: '/pricing', label: 'Pricing' },
              { href: '/terminal', label: 'Terminal' },
              { href: '/affiliate', label: 'Affiliate' },
            ] as const).map(l => (
              <Link key={l.href} href={l.href} className="contact-footer-link">
                {l.label}
              </Link>
            ))}
          </div>

        </div>
      </div>
    </>
  )
}

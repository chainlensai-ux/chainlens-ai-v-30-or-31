import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Contact ChainLens',
  description: 'Reach the ChainLens team for beta support, bug reports, onboarding help, or payment questions.',
}

export default function ContactPage() {
  return (
    <>
      <style>{`
        .contact-card {
          background: rgba(8,12,28,0.72);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 20px;
          padding: 32px;
          display: flex;
          flex-direction: column;
          gap: 18px;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .contact-card:hover {
          border-color: rgba(45,212,191,0.20);
          box-shadow: 0 0 40px rgba(45,212,191,0.06);
        }
        .contact-cta {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 24px;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          text-decoration: none;
          transition: box-shadow 0.15s, background 0.15s, border-color 0.15s;
        }
        .cta-email {
          background: rgba(45,212,191,0.12);
          border: 1px solid rgba(45,212,191,0.30);
          color: #2DD4BF;
        }
        .cta-email:hover {
          background: rgba(45,212,191,0.20);
          border-color: rgba(45,212,191,0.55);
          box-shadow: 0 0 24px rgba(45,212,191,0.22);
        }
        .cta-telegram {
          background: rgba(56,189,248,0.12);
          border: 1px solid rgba(56,189,248,0.28);
          color: #38bdf8;
        }
        .cta-telegram:hover {
          background: rgba(56,189,248,0.20);
          border-color: rgba(56,189,248,0.52);
          box-shadow: 0 0 24px rgba(56,189,248,0.20);
        }
        .bug-field {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 9px 0;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          font-size: 13px;
          color: rgba(255,255,255,0.65);
          font-family: var(--font-inter, Inter, sans-serif);
        }
        .bug-field:last-child { border-bottom: none; }
        .bug-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: rgba(45,212,191,0.70);
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
          min-width: 148px;
          padding-top: 1px;
          flex-shrink: 0;
        }
        @media (max-width: 640px) {
          .contact-grid { grid-template-columns: 1fr !important; }
          .bug-field { flex-direction: column; gap: 4px; }
          .bug-label { min-width: unset; }
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        background: '#06060a',
        color: '#e2e8f0',
        fontFamily: 'var(--font-inter, Inter, sans-serif)',
      }}>
        <div style={{ maxWidth: '840px', margin: '0 auto', padding: '72px 24px 96px' }}>

          {/* ── Hero ─────────────────────────────────────── */}
          <div style={{ marginBottom: '56px', textAlign: 'center' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px',
              padding: '5px 14px', borderRadius: '999px',
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.20)',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
              color: 'rgba(45,212,191,0.80)',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              marginBottom: '22px',
            }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 6px #2DD4BF' }} />
              BETA v3 SUPPORT
            </div>

            <h1 style={{
              fontSize: 'clamp(32px, 6vw, 52px)',
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
              color: 'rgba(255,255,255,0.55)',
              maxWidth: '520px',
              margin: '0 auto',
              lineHeight: 1.65,
            }}>
              Need help with Beta access, bug reports, onboarding, or payments?
              Reach the ChainLens team directly.
            </p>
          </div>

          {/* ── Support cards grid ───────────────────────── */}
          <div className="contact-grid" style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px',
            marginBottom: '16px',
          }}>

            {/* Email Support */}
            <div className="contact-card">
              <div style={{
                width: '44px', height: '44px', borderRadius: '12px',
                background: 'rgba(45,212,191,0.10)',
                border: '1px solid rgba(45,212,191,0.22)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="#2DD4BF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="#2DD4BF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              <div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9', marginBottom: '6px' }}>
                  Email Support
                </div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                  For Beta access, billing, onboarding questions, or anything else — email us directly.
                </div>
              </div>

              <div style={{
                fontSize: '12px', color: 'rgba(45,212,191,0.65)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.05em',
              }}>
                chainlensai@gmail.com
              </div>

              <a href="mailto:chainlensai@gmail.com" className="contact-cta cta-email" style={{ alignSelf: 'flex-start' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 6l-10 7L2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Email ChainLens
              </a>
            </div>

            {/* Telegram */}
            <div className="contact-card">
              <div style={{
                width: '44px', height: '44px', borderRadius: '12px',
                background: 'rgba(56,189,248,0.10)',
                border: '1px solid rgba(56,189,248,0.20)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M22 2L11 13" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              <div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9', marginBottom: '6px' }}>
                  Telegram Community
                </div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                  Join the ChainLens community. Ask questions, share feedback, and get support from the team and fellow testers.
                </div>
              </div>

              <div style={{
                fontSize: '12px', color: 'rgba(56,189,248,0.65)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.05em',
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
          </div>

          {/* ── Bug Reports card (full width) ─────────────── */}
          <div className="contact-card" style={{ marginBottom: '32px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div style={{
                width: '44px', height: '44px', borderRadius: '12px', flexShrink: 0,
                background: 'rgba(139,92,246,0.10)',
                border: '1px solid rgba(139,92,246,0.22)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#8b5cf6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="#8b5cf6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9', marginBottom: '4px' }}>
                  Bug Reports
                </div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.40)' }}>
                  Include the details below when reporting a bug via email or Telegram.
                </div>
              </div>
            </div>

            <div style={{ marginTop: '4px' }}>
              {[
                ['Page / Tool', 'Which page or tool had the issue (e.g. Token Scanner, Clark AI)'],
                ['What you clicked', 'Describe the action you took before the bug appeared'],
                ['What went wrong', 'What did you expect vs. what actually happened'],
                ['Screenshot or video', 'Attach a screenshot or screen recording if possible'],
                ['Token or wallet used', 'Paste the contract address or wallet you were analyzing'],
                ['Device', 'Desktop or mobile, OS (e.g. macOS 14, Android 14)'],
                ['Browser', 'Browser name and version (e.g. Chrome 124, Safari 17)'],
              ].map(([label, desc]) => (
                <div key={label} className="bug-field">
                  <span className="bug-label">{label}</span>
                  <span style={{ color: 'rgba(255,255,255,0.45)' }}>{desc}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <a href="mailto:chainlensai@gmail.com?subject=Bug%20Report%20—%20ChainLens%20Beta%20v3" className="contact-cta cta-email" style={{ alignSelf: 'flex-start' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
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
                style={{ alignSelf: 'flex-start' }}
              >
                Post in Telegram
              </a>
            </div>
          </div>

          {/* ── Trust / status note ───────────────────────── */}
          <div style={{
            background: 'rgba(45,212,191,0.04)',
            border: '1px solid rgba(45,212,191,0.12)',
            borderRadius: '16px',
            padding: '24px 28px',
            display: 'flex',
            gap: '16px',
            alignItems: 'flex-start',
          }}>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: '#4ade80',
              boxShadow: '0 0 8px rgba(74,222,128,0.80)',
              flexShrink: 0,
              marginTop: '5px',
            }} />
            <div>
              <div style={{
                fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em',
                textTransform: 'uppercase', color: 'rgba(45,212,191,0.70)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                marginBottom: '8px',
              }}>
                Beta Support
              </div>
              <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.50)', lineHeight: 1.70, margin: 0 }}>
                We are actively reviewing tester feedback during Beta v3. For fastest help, include
                screenshots, the wallet or token you were analyzing, your device, and browser version.
                You can also reach us on{' '}
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

          {/* ── Back link ────────────────────────────────── */}
          <div style={{ marginTop: '48px', textAlign: 'center' }}>
            <Link href="/" style={{
              fontSize: '13px', color: 'rgba(255,255,255,0.35)',
              textDecoration: 'none', letterSpacing: '0.06em',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              transition: 'color 0.15s',
            }}>
              ← Back to ChainLens
            </Link>
          </div>

        </div>
      </div>
    </>
  )
}

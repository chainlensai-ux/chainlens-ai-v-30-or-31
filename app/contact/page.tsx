import type { Metadata } from 'next'
import Link from 'next/link'
import Navbar from '@/components/Navbar'

export const metadata: Metadata = {
  title: 'Contact ChainLens | Support Center',
  description: 'Get help with onboarding, account access, payments, bug reports, or product feedback from the ChainLens team.',
}

const channels = [
  {
    title: 'Email Support',
    body: 'For account, billing, onboarding, or general support.',
    handle: 'chainlensai@gmail.com',
    href: 'mailto:chainlensai@gmail.com?subject=ChainLens%20Support',
    cta: 'Email ChainLens',
    external: false,
    icon: 'mail' as const,
  },
  {
    title: 'Telegram',
    body: 'Join the community for quick questions, updates, and support.',
    handle: 't.me/chainlensaigroup',
    href: 'https://t.me/chainlensaigroup',
    cta: 'Join Telegram',
    external: true,
    icon: 'send' as const,
  },
  {
    title: 'Follow on X',
    body: 'Product updates, release notes, and platform announcements.',
    handle: '@chainlens_ai',
    href: 'https://x.com/chainlens_ai',
    cta: 'Follow @chainlens_ai',
    external: true,
    icon: 'x' as const,
  },
]

const bugItems: [string, string][] = [
  ['Page or tool', 'Token Scanner, Clark AI, wallet scan, or whichever screen broke'],
  ['What you clicked', 'The action you took right before it happened'],
  ['What went wrong', 'What you expected versus what actually happened'],
  ['Expected result', 'What the correct outcome should have been'],
  ['Screenshot', 'A still or a short recording if you have one'],
  ['Token or wallet', 'The contract or address you were analyzing'],
  ['Device and browser', 'OS, device, browser name, and version'],
  ['Account email', 'Include this if the issue is tied to your account'],
]

function ChannelIcon({ kind }: { kind: 'mail' | 'send' | 'x' }) {
  if (kind === 'mail') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 6.5h16v11H4v-11Z" stroke="#99f6e4" strokeWidth="1.6" />
        <path d="M4 7.5 12 13l8-5.5" stroke="#2DD4BF" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'send') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M20.5 4.5 10.8 14.2" stroke="#2DD4BF" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M20.5 4.5 14 20l-3.2-5.8L4 10.8l16.5-6.3Z" stroke="#99f6e4" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L2.127 2.25H8.08l4.261 5.632 5.903-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" fill="#99f6e4" />
    </svg>
  )
}

export default function ContactPage() {
  return (
    <>
      <style>{`
        @keyframes contact-orb {
          0%,100% { transform: translate(0,0) scale(1); opacity: 0.85; }
          50% { transform: translate(24px,-18px) scale(1.06); opacity: 1; }
        }
        .contact-shell { min-height: 100vh; background: #07070f; color: #e2e8f0; position: relative; overflow-x: hidden; font-family: var(--font-inter, Inter, sans-serif); }
        .contact-grid {
          position: absolute; inset: 0; pointer-events: none; z-index: 0;
          background-image:
            linear-gradient(rgba(45,212,191,0.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(45,212,191,0.045) 1px, transparent 1px);
          background-size: 52px 52px;
          mask-image: radial-gradient(ellipse 90% 55% at 50% 0%, black 8%, transparent 78%);
          -webkit-mask-image: radial-gradient(ellipse 90% 55% at 50% 0%, black 8%, transparent 78%);
        }
        .contact-wrap { position: relative; z-index: 1; max-width: 1040px; margin: 0 auto; padding: 36px 24px 96px; }
        .contact-kicker {
          display: inline-flex; align-items: center; gap: 8px;
          background: rgba(45,212,191,0.08);
          border: 1px solid rgba(45,212,191,0.28);
          border-radius: 999px; padding: 6px 14px; margin-bottom: 22px;
          font-size: 10px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
          color: #5eead4;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
        }
        .contact-kicker i {
          width: 6px; height: 6px; border-radius: 50%; background: #2DD4BF;
          box-shadow: 0 0 10px #2DD4BF;
        }
        .contact-channels {
          display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 48px 0 18px;
        }
        .contact-card {
          position: relative; overflow: hidden;
          display: flex; flex-direction: column; gap: 14px;
          padding: 26px 24px 22px;
          border-radius: 22px;
          background:
            linear-gradient(180deg, rgba(45,212,191,0.09) 0%, rgba(8,14,18,0.72) 38%, rgba(7,10,16,0.88) 100%);
          border: 1px solid rgba(45,212,191,0.22);
          box-shadow: inset 0 1px 0 rgba(153,246,228,0.18), 0 18px 50px rgba(0,0,0,0.28);
          transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
        }
        .contact-card::before {
          content: '';
          position: absolute; left: 18px; right: 18px; top: 0; height: 1px;
          background: linear-gradient(90deg, transparent, #5eead4, transparent);
        }
        .contact-card:hover {
          transform: translateY(-3px);
          border-color: rgba(94,234,212,0.55);
          box-shadow: inset 0 1px 0 rgba(153,246,228,0.28), 0 0 40px rgba(45,212,191,0.16), 0 22px 50px rgba(0,0,0,0.35);
        }
        .contact-icon {
          width: 52px; height: 52px; border-radius: 16px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(45,212,191,0.12);
          border: 1px solid rgba(45,212,191,0.32);
          box-shadow: 0 0 24px rgba(45,212,191,0.18);
        }
        .contact-handle {
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
          font-size: 12px; letter-spacing: 0.02em; color: #5eead4;
        }
        .contact-cta {
          margin-top: auto; align-self: flex-start;
          display: inline-flex; align-items: center; gap: 8px;
          padding: 11px 16px; border-radius: 999px;
          text-decoration: none; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
          color: #042f2e;
          background: linear-gradient(180deg, #99f6e4 0%, #2DD4BF 100%);
          box-shadow: 0 0 0 1px rgba(153,246,228,0.4), 0 8px 24px rgba(45,212,191,0.22);
          transition: filter 0.15s ease, transform 0.15s ease;
        }
        .contact-cta:hover { filter: brightness(1.08); transform: translateY(-1px); }
        .contact-cta.ghost {
          color: #99f6e4;
          background: rgba(45,212,191,0.08);
          box-shadow: inset 0 0 0 1px rgba(45,212,191,0.35);
        }
        .contact-panel {
          margin-top: 18px; border-radius: 24px; padding: 28px;
          background: rgba(45,212,191,0.045);
          border: 1px solid rgba(45,212,191,0.20);
          box-shadow: inset 0 1px 0 rgba(153,246,228,0.12);
        }
        .contact-bugs {
          display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 18px 0 20px;
        }
        .contact-bug {
          display: flex; gap: 12px; align-items: flex-start;
          padding: 14px 14px 13px; border-radius: 14px;
          background: rgba(4,12,14,0.55);
          border: 1px solid rgba(45,212,191,0.12);
        }
        .contact-check {
          width: 18px; height: 18px; border-radius: 999px; flex-shrink: 0; margin-top: 1px;
          display: flex; align-items: center; justify-content: center;
          background: rgba(45,212,191,0.16);
          color: #5eead4; font-size: 11px; font-weight: 800;
        }
        .contact-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .contact-label {
          display: inline-flex; align-items: center; gap: 8px; margin-bottom: 12px;
          font-size: 10px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
          color: rgba(94,234,212,0.85);
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
        }
        .contact-label::before {
          content: ''; width: 18px; height: 1.5px;
          background: linear-gradient(90deg, #2DD4BF, transparent);
        }
        .contact-foot {
          display: flex; justify-content: center; gap: 22px; flex-wrap: wrap; margin-top: 36px;
        }
        .contact-foot a {
          color: rgba(153,246,228,0.55); text-decoration: none;
          font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
          font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
        }
        .contact-foot a:hover { color: #99f6e4; }
        @media (max-width: 860px) {
          .contact-channels { grid-template-columns: 1fr; }
          .contact-bugs { grid-template-columns: 1fr; }
          .contact-wrap { padding: 24px 16px 72px; }
          .contact-cta { width: 100%; justify-content: center; }
        }
      `}</style>

      <Navbar />

      <div className="contact-shell">
        <div className="contact-grid" />
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '680px', height: '680px', borderRadius: '50%',
          top: '-180px', left: '8%',
          background: 'radial-gradient(circle, rgba(45,212,191,0.22) 0%, transparent 68%)',
          filter: 'blur(40px)', animation: 'contact-orb 16s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '520px', height: '520px', borderRadius: '50%',
          top: '80px', right: '-80px',
          background: 'radial-gradient(circle, rgba(16,185,129,0.14) 0%, transparent 70%)',
          filter: 'blur(50px)',
        }} />

        <div className="contact-wrap">
          <div style={{ textAlign: 'center', paddingTop: '28px' }}>
            <div className="contact-kicker"><i /> Support center</div>
            <h1 style={{
              fontSize: 'clamp(40px, 6vw, 72px)', fontWeight: 800, letterSpacing: '-0.035em',
              lineHeight: 0.98, margin: '0 0 18px', color: '#fff',
            }}>
              Talk to the team.
              <br />
              <span style={{
                background: 'linear-gradient(90deg, #99f6e4 0%, #2DD4BF 45%, #34d399 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                We actually read it.
              </span>
            </h1>
            <p style={{
              fontSize: '16px', lineHeight: 1.7, color: 'rgba(226,232,240,0.62)',
              maxWidth: '520px', margin: '0 auto',
            }}>
              Onboarding, account access, payments, bug reports, or product feedback. Pick a channel and we will read it.
            </p>
          </div>

          <div className="contact-channels">
            {channels.map((channel) => (
              <article key={channel.title} className="contact-card">
                <div className="contact-icon"><ChannelIcon kind={channel.icon} /></div>
                <div>
                  <div style={{ fontSize: '18px', fontWeight: 750, color: '#f8fafc', letterSpacing: '-0.02em', marginBottom: '6px' }}>{channel.title}</div>
                  <div style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'rgba(226,232,240,0.58)' }}>{channel.body}</div>
                </div>
                <div className="contact-handle">{channel.handle}</div>
                <a
                  className="contact-cta"
                  href={channel.href}
                  {...(channel.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  {channel.cta}
                  <span aria-hidden>→</span>
                </a>
              </article>
            ))}
          </div>

          <section className="contact-panel">
            <div className="contact-label">Report a bug</div>
            <h2 style={{ margin: '0 0 6px', fontSize: '28px', letterSpacing: '-0.03em', color: '#fff' }}>
              The faster the details, the faster the fix.
            </h2>
            <p style={{ margin: 0, maxWidth: '640px', color: 'rgba(226,232,240,0.55)', fontSize: '14px', lineHeight: 1.65 }}>
              Include the items below when you email or post in Telegram. You do not need all of them, but the first four save a round trip.
            </p>
            <div className="contact-bugs">
              {bugItems.map(([label, desc]) => (
                <div key={label} className="contact-bug">
                  <div className="contact-check">✓</div>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: '#ecfeff', marginBottom: '3px' }}>{label}</div>
                    <div style={{ fontSize: '12.5px', lineHeight: 1.5, color: 'rgba(226,232,240,0.48)' }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="contact-row">
              <a className="contact-cta" href="mailto:chainlensai@gmail.com?subject=Bug%20Report%20%E2%80%94%20ChainLens">
                Email bug report <span aria-hidden>→</span>
              </a>
              <a className="contact-cta ghost" href="https://t.me/chainlensaigroup" target="_blank" rel="noopener noreferrer">
                Post in Telegram
              </a>
            </div>
          </section>

          <section className="contact-panel" style={{ marginTop: '16px' }}>
            <div className="contact-label">Full release support</div>
            <p style={{ margin: '0 0 10px', fontSize: '22px', fontWeight: 750, letterSpacing: '-0.03em', color: '#5eead4' }}>
              We read support, bugs, and product notes ourselves.
            </p>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.7, color: 'rgba(226,232,240,0.58)', maxWidth: '720px' }}>
              For the fastest help, include a screenshot, the page or tool name, and the token or wallet you were analyzing. Reach us on{' '}
              <a href="https://t.me/chainlensaigroup" target="_blank" rel="noopener noreferrer" style={{ color: '#99f6e4', textDecoration: 'none' }}>Telegram</a>
              {' '}or email{' '}
              <a href="mailto:chainlensai@gmail.com" style={{ color: '#99f6e4', textDecoration: 'none' }}>chainlensai@gmail.com</a>.
            </p>
          </section>

          <div className="contact-foot">
            {([
              ['/', 'Home'],
              ['/about', 'About'],
              ['/pricing', 'Pricing'],
              ['/terminal', 'Terminal'],
              ['/affiliate', 'Affiliate'],
            ] as const).map(([href, label]) => (
              <Link key={href} href={href}>{label}</Link>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

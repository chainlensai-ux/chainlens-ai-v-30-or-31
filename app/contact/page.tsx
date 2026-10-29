import type { Metadata } from 'next'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import BrandMark from '@/components/BrandMark'

export const metadata: Metadata = {
  title: 'Contact ChainLens | Support Center',
  description: 'Get help with onboarding, account access, payments, bug reports, or product feedback from the ChainLens team.',
}

// Same contact channels, links and copy as before, on the site's dark navy / teal design language. Email is the
// primary channel (account and billing); the topic chips jump to the matching section; the bug report is a
// numbered checklist; and the policy pages that answer common billing/data questions are linked. No claims beyond
// what the site already states (no response-time promises).
const MAIL = 'chainlensai@gmail.com'
const TELEGRAM = 'https://t.me/chainlensaigroup'
const X_URL = 'https://x.com/chainlens_ai'

const MailIcon = ({ size = 12, color = 'currentColor', width = 2 }: { size?: number; color?: string; width?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M22 6l-10 7L2 6" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const TelegramIcon = ({ size = 12, color = 'currentColor', width = 2.2 }: { size?: number; color?: string; width?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M22 2L11 13" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    <path d="M22 2L15 22 11 13 2 9l20-7z" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const XIcon = ({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L2.127 2.25H8.08l4.261 5.632 5.903-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" fill={color} />
  </svg>
)
const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const BUG_DETAILS: Array<[string, string]> = [
  ['Page or tool affected', 'Which page or tool had the issue (e.g. Token Scanner, Clark AI)'],
  ['What you clicked', 'The action you took before the issue appeared'],
  ['What went wrong', 'What you expected vs. what actually happened'],
  ['Expected result', 'What the correct outcome should have been'],
  ['Screenshot or recording', 'Attach a screenshot or screen recording if possible'],
  ['Token or wallet address', 'Paste the contract or wallet you were analyzing'],
  ['Device and browser', 'OS, device type, browser name and version'],
  ['Account email', 'Include if the issue is account-related'],
]

const HELP_LINKS = [
  { href: '/pricing', title: 'Plans & pricing', text: 'What each plan includes' },
  { href: '/refund', title: 'Refund Policy', text: 'Subscriptions and refunds' },
  { href: '/terms', title: 'Terms of Service', text: 'Using ChainLens AI' },
  { href: '/privacy', title: 'Privacy Policy', text: 'How your data is handled' },
] as const

export default function ContactPage() {
  return (
    <>
      <style>{`
        .ct-page { min-height: 100dvh; background: #03060f; color: #e2e8f0; font-family: var(--font-inter, Inter, sans-serif); position: relative; overflow: hidden; }
        /* Lit navy backdrop: teal/cyan glow from the top, a cool blue wash low right, a faint terminal grid. */
        .ct-backdrop { position: absolute; inset: 0; pointer-events: none; z-index: 0;
          background:
            radial-gradient(ellipse 70% 42% at 50% -6%, rgba(45,212,191,0.17) 0%, rgba(34,211,238,0.06) 45%, transparent 75%),
            radial-gradient(ellipse 55% 40% at 92% 70%, rgba(56,120,248,0.10) 0%, transparent 70%),
            radial-gradient(ellipse 45% 35% at 4% 48%, rgba(129,140,248,0.06) 0%, transparent 70%),
            linear-gradient(180deg, #040915 0%, #03060f 55%, #02040b 100%); }
        .ct-grid { position: absolute; inset: 0; pointer-events: none; z-index: 0; opacity: 0.55;
          background-image: linear-gradient(rgba(56,189,248,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.05) 1px, transparent 1px);
          background-size: 56px 56px;
          -webkit-mask-image: radial-gradient(ellipse 80% 55% at 50% 0%, #000 0%, transparent 75%);
          mask-image: radial-gradient(ellipse 80% 55% at 50% 0%, #000 0%, transparent 75%); }
        .ct-wrap { max-width: 1080px; margin: 0 auto; padding: 56px 24px 0; position: relative; z-index: 1; }
        .ct-mono { font-family: var(--font-plex-mono, IBM Plex Mono, monospace); }

        /* ── Hero ── */
        .ct-chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px;
          background: rgba(45,212,191,0.07); border: 1px solid rgba(45,212,191,0.24);
          font-size: 10px; font-weight: 700; letter-spacing: 0.2em; color: rgba(94,234,212,0.92); box-shadow: 0 0 22px rgba(45,212,191,0.10); }
        .ct-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 8px #2dd4bf; }
        .ct-title { font-size: clamp(34px, 6vw, 60px); font-weight: 900; letter-spacing: -0.035em; line-height: 1.04; margin: 22px 0 16px;
          background: linear-gradient(120deg, #f8fafc 0%, #a5f3fc 34%, #2dd4bf 66%, #60a5fa 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
          filter: drop-shadow(0 0 28px rgba(45,212,191,0.18)); }
        .ct-lede { font-size: 17px; color: rgba(203,213,225,0.64); max-width: 560px; margin: 0 auto; line-height: 1.65; }
        .ct-topics { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; margin-top: 26px; }
        .ct-topic { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: rgba(203,213,225,0.82); text-decoration: none;
          border: 1px solid rgba(96,165,250,0.18); background: rgba(8,14,28,0.65); border-radius: 999px; padding: 7px 14px;
          transition: border-color 0.15s, color 0.15s, background 0.15s; }
        .ct-topic:hover { border-color: rgba(45,212,191,0.5); color: #ccfbf1; background: rgba(45,212,191,0.08); }
        .ct-topic:focus-visible, .ct-cta:focus-visible, .ct-help:focus-visible { outline: 2px solid rgba(94,234,212,0.8); outline-offset: 2px; }
        .ct-topic-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dot); box-shadow: 0 0 6px var(--dot); }

        /* ── Glass panel with a thin accent edge on top (colour per section via --ct-accent) ── */
        .ct-panel { position: relative; overflow: hidden; border-radius: 18px; padding: 24px;
          background: linear-gradient(170deg, rgba(10,18,36,0.86), rgba(5,10,22,0.82));
          border: 1px solid rgba(96,165,250,0.12);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 40px rgba(0,0,0,0.35);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); scroll-margin-top: 110px; }
        .ct-panel::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px;
          background: linear-gradient(90deg, transparent 0%, var(--ct-accent, rgba(45,212,191,0.6)) 50%, transparent 100%); opacity: 0.85; }
        .ct-icon { width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
          background: var(--ct-icon-bg); border: 1px solid var(--ct-icon-border); box-shadow: 0 0 18px var(--ct-icon-glow); }
        .ct-h2 { font-size: 16px; font-weight: 700; color: #f1f5f9; margin: 0; letter-spacing: -0.01em; }
        .ct-text { font-size: 13px; color: rgba(203,213,225,0.58); line-height: 1.6; margin: 0; }
        .ct-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }

        /* ── Channel cards ── */
        .ct-channels { display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 14px; margin: 54px 0 14px; }
        .ct-card { display: flex; flex-direction: column; gap: 14px; transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s; }
        .ct-card:hover { transform: translateY(-2px); border-color: rgba(45,212,191,0.30); box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 0 44px rgba(45,212,191,0.08), 0 16px 44px rgba(0,0,0,0.40); }
        .ct-card--primary { border-color: rgba(45,212,191,0.34); background: linear-gradient(165deg, rgba(8,34,34,0.90), rgba(5,14,24,0.86));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 0 40px rgba(45,212,191,0.12), 0 14px 40px rgba(0,0,0,0.38); }
        .ct-card-head { display: flex; align-items: center; gap: 14px; }
        .ct-tag { margin-left: auto; align-self: flex-start; font-size: 9px; font-weight: 800; letter-spacing: 0.14em; padding: 3px 8px; border-radius: 999px;
          color: #042f2a; background: linear-gradient(135deg, #99f6e4, #2dd4bf); box-shadow: 0 0 12px rgba(45,212,191,0.4); white-space: nowrap; }
        .ct-best { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: rgba(203,213,225,0.78);
          padding: 10px 12px; border-radius: 10px; background: rgba(9,16,34,0.55); border: 1px solid rgba(96,165,250,0.10); }
        .ct-best b { font-weight: 700; color: var(--best, #5eead4); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; flex-shrink: 0; }
        .ct-handle { font-size: 11.5px; letter-spacing: 0.03em; overflow-wrap: anywhere; }

        .ct-cta { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 11px 18px; border-radius: 999px; font-size: 12px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none; white-space: nowrap;
          transition: box-shadow 0.15s, background 0.15s, border-color 0.15s, transform 0.15s; }
        .ct-card .ct-cta { margin-top: auto; width: 100%; }
        .ct-cta-primary { color: #042f2a; background: linear-gradient(135deg, #5eead4, #14b8a6); border: 1px solid rgba(153,246,228,0.6);
          box-shadow: 0 0 20px rgba(45,212,191,0.28), inset 0 1px 0 rgba(255,255,255,0.35); }
        .ct-cta-primary:hover { box-shadow: 0 0 30px rgba(45,212,191,0.45), inset 0 1px 0 rgba(255,255,255,0.4); transform: translateY(-1px); }
        .ct-cta-email { background: rgba(45,212,191,0.10); border: 1px solid rgba(45,212,191,0.32); color: #5eead4; }
        .ct-cta-email:hover { background: rgba(45,212,191,0.18); border-color: rgba(45,212,191,0.56); box-shadow: 0 0 22px rgba(45,212,191,0.24); }
        .ct-cta-telegram { background: rgba(56,189,248,0.10); border: 1px solid rgba(56,189,248,0.30); color: #7dd3fc; }
        .ct-cta-telegram:hover { background: rgba(56,189,248,0.18); border-color: rgba(56,189,248,0.54); box-shadow: 0 0 22px rgba(56,189,248,0.22); }
        .ct-cta-x { background: rgba(255,255,255,0.05); border: 1px solid rgba(226,232,240,0.18); color: rgba(241,245,249,0.88); }
        .ct-cta-x:hover { background: rgba(255,255,255,0.09); border-color: rgba(226,232,240,0.34); box-shadow: 0 0 22px rgba(148,163,184,0.12); }

        /* ── Bug report: intro + actions on the left, numbered checklist on the right ── */
        .ct-bug { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.6fr); gap: 28px; padding: 28px; }
        .ct-bug-intro { display: flex; flex-direction: column; gap: 14px; }
        .ct-bug-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
        .ct-bug-actions .ct-cta { width: 100%; }
        .ct-bug-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; counter-reset: bug; }
        .ct-bug-item { counter-increment: bug; display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 12px;
          background: rgba(9,16,34,0.62); border: 1px solid rgba(96,165,250,0.10); transition: border-color 0.15s; }
        .ct-bug-item:hover { border-color: rgba(129,140,248,0.30); }
        .ct-bug-item::before { content: counter(bug, decimal-leading-zero); flex-shrink: 0; font-family: var(--font-plex-mono, IBM Plex Mono, monospace);
          font-size: 11px; font-weight: 700; color: #a5b4fc; width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
          background: rgba(129,140,248,0.10); border: 1px solid rgba(129,140,248,0.24); }
        .ct-bug-label { font-size: 12.5px; font-weight: 700; color: #e2e8f0; margin-bottom: 2px; }
        .ct-bug-desc { font-size: 12px; color: rgba(203,213,225,0.50); line-height: 1.5; }

        /* ── Helpful links ── */
        .ct-help-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
        .ct-help { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 14px; text-decoration: none;
          background: rgba(8,14,28,0.70); border: 1px solid rgba(96,165,250,0.12); color: #e2e8f0; transition: border-color 0.15s, background 0.15s, transform 0.15s; }
        .ct-help:hover { border-color: rgba(45,212,191,0.38); background: rgba(10,22,32,0.85); transform: translateY(-1px); }
        .ct-help-title { font-size: 13px; font-weight: 700; }
        .ct-help-text { font-size: 11.5px; color: rgba(203,213,225,0.50); margin-top: 2px; }
        .ct-help-arrow { margin-left: auto; color: rgba(94,234,212,0.7); flex-shrink: 0; transition: transform 0.15s; }
        .ct-help:hover .ct-help-arrow { transform: translateX(2px); }

        .ct-promise { display: flex; gap: 16px; align-items: flex-start; margin: 14px 0 0; }
        .ct-link-teal { color: #5eead4; text-decoration: none; }
        .ct-link-blue { color: #7dd3fc; text-decoration: none; }
        .ct-link-teal:hover, .ct-link-blue:hover { text-decoration: underline; }

        .ct-footer { position: relative; z-index: 1; margin-top: 72px; border-top: 1px solid rgba(96,165,250,0.10); background: rgba(2,5,13,0.78); }
        .ct-footer::before { content: ''; position: absolute; left: 0; right: 0; top: -1px; height: 1px;
          background: linear-gradient(90deg, transparent 0%, rgba(45,212,191,0.45) 30%, rgba(96,165,250,0.35) 65%, transparent 100%); }
        .ct-footer-inner { max-width: 1080px; margin: 0 auto; padding: 28px 24px 36px; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .ct-footer-links { display: flex; gap: 22px; flex-wrap: wrap; }
        .ct-footer-link { font-size: 12px; color: rgba(148,163,184,0.62); text-decoration: none; letter-spacing: 0.06em; transition: color 0.15s; }
        .ct-footer-link:hover { color: #e2e8f0; }

        @media (max-width: 960px) {
          .ct-channels { grid-template-columns: 1fr 1fr; }
          .ct-channels > :first-child { grid-column: 1 / -1; }
          .ct-bug { grid-template-columns: 1fr; }
          .ct-bug-actions { flex-direction: row; flex-wrap: wrap; }
          .ct-bug-actions .ct-cta { width: auto; }
          .ct-help-row { grid-template-columns: 1fr 1fr; }
        }
        @media (max-width: 600px) {
          .ct-wrap { padding-top: 34px; }
          .ct-channels { grid-template-columns: 1fr; margin-top: 38px; }
          .ct-bug { padding: 22px 18px; }
          .ct-bug-list { grid-template-columns: 1fr; }
          .ct-bug-actions { flex-direction: column; }
          .ct-bug-actions .ct-cta { width: 100%; }
          .ct-panel { padding: 20px 18px; }
          .ct-help-row { grid-template-columns: 1fr; }
          .ct-footer-inner { flex-direction: column; align-items: flex-start; }
        }
        @media (prefers-reduced-motion: reduce) {
          .ct-card, .ct-card:hover, .ct-help, .ct-help:hover, .ct-cta-primary:hover { transition: none; transform: none; }
        }
      `}</style>

      <div className="ct-page">
        <div className="ct-backdrop" aria-hidden="true" />
        <div className="ct-grid" aria-hidden="true" />
        <Navbar />

        <main className="ct-wrap">
          {/* ── Hero ─────────────────────────────────────────── */}
          <header style={{ textAlign: 'center' }}>
            <span className="ct-chip ct-mono"><span className="ct-chip-dot" aria-hidden="true" />SUPPORT CENTER</span>
            <h1 className="ct-title">Contact ChainLens</h1>
            <p className="ct-lede">Get help with onboarding, account access, payments, bug reports, or product feedback.</p>
            <nav className="ct-topics" aria-label="Jump to a topic">
              <a href="#email" className="ct-topic" style={{ ['--dot' as string]: '#2dd4bf' }}><span className="ct-topic-dot" aria-hidden="true" />Account &amp; billing</a>
              <a href="#bug-report" className="ct-topic" style={{ ['--dot' as string]: '#818cf8' }}><span className="ct-topic-dot" aria-hidden="true" />Bug reports</a>
              <a href="#telegram" className="ct-topic" style={{ ['--dot' as string]: '#38bdf8' }}><span className="ct-topic-dot" aria-hidden="true" />Product feedback</a>
            </nav>
          </header>

          {/* ── Channels ─────────────────────────────────────── */}
          <section className="ct-channels" aria-label="Contact channels">
            <article id="email" className="ct-panel ct-card ct-card--primary" style={{ ['--ct-accent' as string]: 'rgba(45,212,191,0.85)' }}>
              <div className="ct-card-head">
                <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(45,212,191,0.12)', ['--ct-icon-border' as string]: 'rgba(45,212,191,0.34)', ['--ct-icon-glow' as string]: 'rgba(45,212,191,0.20)' }}>
                  <MailIcon size={20} color="#5eead4" width={1.8} />
                </div>
                <div>
                  <h2 className="ct-h2">Email Support</h2>
                  <div className="ct-handle ct-mono" style={{ color: 'rgba(94,234,212,0.78)', marginTop: 3 }}>{MAIL}</div>
                </div>
                <span className="ct-tag ct-mono">PRIMARY</span>
              </div>
              <p className="ct-text">For account, billing, onboarding, or general support.</p>
              <div className="ct-best"><b className="ct-mono">Best for</b>Account access, payments and subscriptions</div>
              <a href={`mailto:${MAIL}?subject=ChainLens%20Support`} className="ct-cta ct-cta-primary ct-mono"><MailIcon /> Email ChainLens</a>
            </article>

            <article id="telegram" className="ct-panel ct-card" style={{ ['--ct-accent' as string]: 'rgba(56,189,248,0.75)' }}>
              <div className="ct-card-head">
                <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(56,189,248,0.10)', ['--ct-icon-border' as string]: 'rgba(56,189,248,0.26)', ['--ct-icon-glow' as string]: 'rgba(56,189,248,0.14)' }}>
                  <TelegramIcon size={20} color="#7dd3fc" width={2} />
                </div>
                <div>
                  <h2 className="ct-h2">Telegram Community</h2>
                  <div className="ct-handle ct-mono" style={{ color: 'rgba(125,211,252,0.78)', marginTop: 3 }}>t.me/chainlensaigroup</div>
                </div>
              </div>
              <p className="ct-text">Join the ChainLens community for quick questions, updates, and support.</p>
              <div className="ct-best" style={{ ['--best' as string]: '#7dd3fc' }}><b className="ct-mono">Best for</b>Quick questions and product feedback</div>
              <a href={TELEGRAM} target="_blank" rel="noopener noreferrer" className="ct-cta ct-cta-telegram ct-mono"><TelegramIcon /> Join Telegram</a>
            </article>

            <article className="ct-panel ct-card" style={{ ['--ct-accent' as string]: 'rgba(226,232,240,0.45)' }}>
              <div className="ct-card-head">
                <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(255,255,255,0.05)', ['--ct-icon-border' as string]: 'rgba(226,232,240,0.16)', ['--ct-icon-glow' as string]: 'rgba(148,163,184,0.08)' }}>
                  <XIcon size={17} color="rgba(241,245,249,0.85)" />
                </div>
                <div>
                  <h2 className="ct-h2">Follow on X</h2>
                  <div className="ct-handle ct-mono" style={{ color: 'rgba(203,213,225,0.60)', marginTop: 3 }}>@chainlens_ai</div>
                </div>
              </div>
              <p className="ct-text">Product updates, release notes, market posts, and platform announcements.</p>
              <div className="ct-best" style={{ ['--best' as string]: '#e2e8f0' }}><b className="ct-mono">Best for</b>Release notes and announcements</div>
              <a href={X_URL} target="_blank" rel="noopener noreferrer" className="ct-cta ct-cta-x ct-mono"><XIcon /> Follow @chainlens_ai</a>
            </article>
          </section>

          {/* ── Bug report ───────────────────────────────────── */}
          <section id="bug-report" className="ct-panel ct-bug" aria-labelledby="ct-bug-title" style={{ ['--ct-accent' as string]: 'rgba(129,140,248,0.70)' }}>
            <div className="ct-bug-intro">
              <div className="ct-icon" style={{ ['--ct-icon-bg' as string]: 'rgba(129,140,248,0.10)', ['--ct-icon-border' as string]: 'rgba(129,140,248,0.28)', ['--ct-icon-glow' as string]: 'rgba(129,140,248,0.16)' }}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="#a5b4fc" strokeWidth="1.8" />
                  <path d="M12 8v4M12 16h.01" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <div className="ct-kicker ct-mono" style={{ color: 'rgba(165,180,252,0.85)', marginBottom: 8 }}>Found something broken?</div>
                <h2 id="ct-bug-title" className="ct-h2" style={{ fontSize: 20, marginBottom: 8 }}>Report a Bug</h2>
                <p className="ct-text">Help us fix issues faster by including these details when you reach out.</p>
              </div>
              <div className="ct-bug-actions">
                <a href={`mailto:${MAIL}?subject=Bug%20Report%20%E2%80%94%20ChainLens`} className="ct-cta ct-cta-email ct-mono"><MailIcon /> Email Bug Report</a>
                <a href={TELEGRAM} target="_blank" rel="noopener noreferrer" className="ct-cta ct-cta-telegram ct-mono"><TelegramIcon /> Post in Telegram</a>
              </div>
            </div>
            <ol className="ct-bug-list" aria-label="Details to include">
              {BUG_DETAILS.map(([label, desc]) => (
                <li key={label} className="ct-bug-item">
                  <div>
                    <div className="ct-bug-label">{label}</div>
                    <div className="ct-bug-desc">{desc}</div>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* ── Helpful pages ────────────────────────────────── */}
          <nav className="ct-help-row" aria-label="Helpful pages">
            {HELP_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="ct-help">
                <div>
                  <div className="ct-help-title">{l.title}</div>
                  <div className="ct-help-text">{l.text}</div>
                </div>
                <span className="ct-help-arrow"><Arrow /></span>
              </Link>
            ))}
          </nav>

          {/* ── Support promise ──────────────────────────────── */}
          <section className="ct-panel ct-promise" style={{ ['--ct-accent' as string]: 'rgba(74,222,128,0.6)', background: 'linear-gradient(170deg, rgba(6,26,26,0.82), rgba(4,12,20,0.82))', borderColor: 'rgba(45,212,191,0.18)' }}>
            <div aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 10px rgba(74,222,128,0.85)', flexShrink: 0, marginTop: '6px' }} />
            <div>
              <div className="ct-kicker ct-mono" style={{ color: 'rgba(94,234,212,0.85)', marginBottom: '10px' }}>Full Release Support</div>
              <p style={{ fontSize: '13px', color: 'rgba(203,213,225,0.64)', lineHeight: 1.72, margin: 0 }}>
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
                <Link key={l.href} href={l.href} className="ct-footer-link ct-mono">{l.label}</Link>
              ))}
            </nav>
          </div>
        </footer>
      </div>
    </>
  )
}

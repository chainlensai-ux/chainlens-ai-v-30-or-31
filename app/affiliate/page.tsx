'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Fraunces } from 'next/font/google'
import Navbar from '@/components/Navbar'
import AffiliateHubNav from '@/components/AffiliateHubNav'
import { buildAffiliateReferralLink } from '@/lib/affiliate/referral'

// LEDGER REDESIGN, DISCLOSED (requested: "the button to submit looks shit and ai slop... make it
// look clean and nice", followed by a three-direction pitch and the pick: "i like option A but
// make it chainlens themed colours"). This replaces the page's previous look — a diagonal teal→
// purple gradient hero, an arrow-glyph gradient CTA, and soft translucent rounded-16px "glass"
// cards, the exact cluster of choices that reads as templated — with a financial-statement
// register: a serif display face (Fraunces) for the thesis lines, hairline rules instead of glow,
// underline inputs instead of boxed pills, and ChainLens's own teal (#2DD4BF, already the site's
// established accent everywhere else — Navbar, terminal pages) as the ONLY accent, never blended
// into a gradient. Fraunces is loaded with next/font/google, scoped to this page only — the rest
// of the app was never touched.
//
// NAV, DISCLOSED (explicit instruction: "leave the current bar we have at the top... dont add
// that"): the pitch mockup included its own wordmark/nav row to show the identity in isolation.
// That row is intentionally absent here — this page renders the SAME <Navbar /> every other page
// uses, unchanged, exactly as it already did before this redesign.
//
// BACKGROUND SEAM, DISCLOSED (reported live, with a screenshot: "it feels imported into the page
// cause the background at the top of it... it just looks weird"). Root cause: Navbar renders as a
// floating pill directly against html/body's own background (globals.css sets
// "html, body { background: #07070f !important }"), while everything BELOW the navbar sits inside
// this page's own background div. The first version of this redesign gave that div a background
// of #0b0e13 — a near-black I invented for the Ledger palette that was subtly lighter/bluer than
// the real body color. The two tones met exactly at the navbar's lower edge, producing a visible
// horizontal seam — the effect the report described as looking "imported." Fixed by setting --ink
// to the SAME literal value body already uses, so the navbar's background and the page's
// background are pixel-identical and the seam is gone, not just less visible.
const fraunces = Fraunces({ subsets: ['latin'], weight: ['500', '600'], style: ['normal', 'italic'], variable: '--font-fraunces', display: 'swap' })

type FormState = {
  name: string
  email: string
  telegram: string
  x_handle: string
  audience_size: string
  audience_type: string
  promo_plan: string
  payout_wallet: string
  website: string
}

const initialForm: FormState = {
  name: '', email: '', telegram: '', x_handle: '', audience_size: '', audience_type: '', promo_plan: '', payout_wallet: '', website: '',
}

const faqs = [
  {
    q: 'How does the commission work?',
    a: 'You earn a recurring monthly commission for every paying user you refer, for as long as they stay subscribed. The full rate and structure are shared privately after your application is approved.',
  },
  {
    q: 'When and how do I get paid?',
    a: 'Payouts are processed manually, within 24–72 hours once the funds reach us — no monthly batching, no hold period. We pay in crypto to your on-chain wallet. Full payout instructions are provided after approval.',
  },
  {
    q: 'What audience size do I need?',
    a: "There is no hard minimum. We care more about audience quality and niche fit than raw follower count. A focused Telegram group of 500 Base traders outperforms a generic channel of 50k.",
  },
  {
    q: 'How long does review take?',
    a: 'We review every application manually. Most decisions are made within 24–72 hours. Incomplete or rushed applications take longer — take your time and be specific.',
  },
  {
    q: 'Can large creators get custom terms?',
    a: 'Yes. Serious partners with high-volume or premium audiences can discuss custom commission structures, early access, and co-marketing. Mention this in your application and we will follow up.',
  },
]

const WHO = [
  { label: 'Base KOLs', primary: true },
  { label: 'X / Twitter creators', primary: true },
  { label: 'Telegram community owners', primary: true },
  { label: 'Onchain analysts', primary: true },
  { label: 'Trading group operators', primary: false },
  { label: 'DeFi educators', primary: false },
  { label: 'Newsletter writers', primary: false },
  { label: 'TikTok / YouTube crypto creators', primary: false },
  { label: 'Discord community leaders', primary: false },
]

const BENEFITS = [
  { title: '20% recurring commission', body: 'Earn monthly on every referred subscription, not just the first sale. Genuine recurring income for as long as they stay subscribed.' },
  { title: 'Fast manual payouts', body: 'Commissions are paid within 24–72 hours of funds reaching us, in crypto. Full payout structure is shared privately once you are approved.' },
  { title: 'Founding partner access', body: 'Joining early means founding status. Top founding partners get first access to campaigns and new features.' },
  { title: 'A premium product to promote', body: 'Clark AI, CORTEX scoring, whale tracking, and a real token scanner. Genuine onchain utility that actually converts.' },
  { title: 'Custom terms for top creators', body: 'High-volume or premium-audience partners can negotiate custom commission structures and co-marketing.' },
  { title: 'Direct partner support', body: 'Approved partners get direct communication, not a ticket queue. A real conversation when you need one.' },
]

const TOOLS = [
  { label: 'Token Scanner', desc: 'Price, liquidity, LP control, holder concentration, security/tax checks, and dev/deployer risk.' },
  { label: 'Wallet Scanner', desc: 'Deep-dive any wallet: age, activity, PnL, and full history.' },
  { label: 'Whale Alerts', desc: 'Live alerts when major wallets move on Base.' },
  { label: 'Pump Alerts', desc: 'Early signals on emerging momentum tokens on Base.' },
  { label: 'Base Radar', desc: 'Live feed of new token launches across the Base chain.' },
  { label: 'Clark AI', desc: 'Conversational CORTEX intelligence for any onchain query.' },
]

const STEPS = [
  { n: '01', title: 'Apply', body: 'Tell us about your audience, platforms, and how you would promote ChainLens. Be specific, it helps your application.' },
  { n: '02', title: 'Get approved', body: 'We manually review every application for partner fit, to protect the brand and keep the program quality-first.' },
  { n: '03', title: 'Refer and earn', body: 'Approved partners receive referral details and earn recurring commissions from every qualified subscription they bring.' },
]

const FIELD_GROUPS: Array<{
  legend: string
  note?: string
  fields: Array<{ label: string; key: keyof FormState; required: boolean; type?: string; placeholder: string; span?: 2; maxLength: number }>
}> = [
  // maxLength values mirror the server's own MAX table in app/api/affiliate/apply/route.ts.
  // The server sanitizes by SLICING to those limits, so without a matching client cap anything
  // typed past them is silently discarded with no indication it was dropped.
  {
    legend: 'Who you are',
    fields: [
      { label: 'Full name', key: 'name', required: true, placeholder: 'Your name', maxLength: 100 },
      { label: 'Email address', key: 'email', required: true, type: 'email', placeholder: 'you@example.com', maxLength: 200 },
    ],
  },
  {
    legend: 'Where you create',
    fields: [
      { label: 'X / Twitter handle', key: 'x_handle', required: true, placeholder: '@yourhandle', maxLength: 100 },
      { label: 'Telegram (optional)', key: 'telegram', required: false, placeholder: '@yourusername', maxLength: 100 },
    ],
  },
  {
    legend: 'Your audience',
    fields: [
      { label: 'Audience size', key: 'audience_size', required: true, placeholder: 'e.g. 12,000 X followers', maxLength: 120 },
      { label: 'Audience type / niche', key: 'audience_type', required: true, placeholder: 'e.g. Base traders, DeFi analysts', maxLength: 160 },
    ],
  },
  {
    legend: 'Payout — crypto only',
    // CLARITY FIX, DISCLOSED (reported live: "it says optional on it make it clear we only pay
    // out in crypto"): the field itself stays optional — an applicant reasonably may not have a
    // wallet ready at application time and can add one after approval — but "optional" alone left
    // the payout METHOD ambiguous. This note states plainly that crypto is the only payout rail,
    // so nobody applies expecting a card/bank payout that was never going to happen.
    note: 'We pay commissions in crypto only (USDC on Base) — no bank transfers or PayPal payouts. You can leave this blank now and add your wallet after approval.',
    fields: [
      { label: 'Crypto payout wallet (optional)', key: 'payout_wallet', required: false, placeholder: '0x… — USDC on Base', span: 2, maxLength: 120 },
    ],
  },
]

export default function AffiliatePage() {
  const [form, setForm] = useState<FormState>(initialForm)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<{ message: string; referralCode: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openFaq, setOpenFaq] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  async function copyReferralLink(link: string) {
    try {
      if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard access can be denied — the link stays selectable on screen either way */ }
  }

  // Generic failure copy. Used for network errors and non-actionable server failures (5xx), where
  // the user can't fix anything by editing the form — so the only useful next step is retry or
  // email. Actionable validation errors (400/429) keep the server's specific message instead,
  // since replacing "Please enter a valid email" with this would hide what actually needs fixing.
  const SUBMIT_FAILED_MESSAGE = "We couldn't submit your application. Please try again or contact chainlensai@gmail.com."

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    // DOUBLE-SUBMIT GUARD, DISCLOSED (affiliate QA): the submit button is disabled while loading,
    // but a disabled submit button does not reliably block implicit form submission (Enter key in
    // a text input) across browsers. This state check is the actual guarantee — without it a fast
    // double Enter could file two applications, each burning a slot against the rate limit.
    if (loading) return
    setLoading(true)
    setSuccess(null)
    setError(null)
    try {
      const res = await fetch('/api/affiliate/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, audience_type: form.audience_type, promotion_plan: form.promo_plan }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const serverMessage = typeof data?.error === 'string' ? data.error : null
        const isActionable = res.status === 400 || res.status === 429
        setError(isActionable && serverMessage ? serverMessage : SUBMIT_FAILED_MESSAGE)
      } else {
        const code = typeof data?.referral_code === 'string' ? data.referral_code : ''
        setSuccess({ message: 'Application received. We manually review affiliate applications and will contact you by email.', referralCode: code })
        setForm(initialForm)
      }
    } catch {
      setError(SUBMIT_FAILED_MESSAGE)
    } finally {
      setLoading(false)
    }
  }

  // Clear a stale submission error as soon as the user edits any field — otherwise a "Please enter
  // a valid email" banner stays on screen after the email has already been corrected, which reads
  // as though the fix didn't register.
  function updateField(key: keyof FormState, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
    if (error) setError(null)
  }

  return (
    <>
      <style>{`
        /* ── Tokens, DISCLOSED: one accent only — ChainLens teal (#2DD4BF, the same value used in
           Navbar.tsx and every terminal page) — never blended into a gradient. Graphite-blue-biased
           neutrals (not pure grey) so the palette reads as chosen, not inherited. ── */
        :root {
          /* Matches html/body's own background (globals.css: "background: #07070f !important")
             exactly — see the BACKGROUND SEAM note below. */
          --ink: #07070f;
          --panel: #10141b;
          --line: rgba(226,232,240,.11);
          --line-strong: rgba(226,232,240,.18);
          --text: #e7e9ee;
          --muted: #8b93a3;
          --teal: #2DD4BF;
          --teal-soft: rgba(45,212,191,.11);
          --teal-text: #04241f;
        }

        .aff-page { background: var(--ink); }

        /* Panels are hairline-bordered and solid, never soft translucent glass — the register
           reads as a document, not a floating card. */
        .aff-surface { background: var(--panel); border: 1px solid var(--line); border-radius: 4px; }
        .aff-hair { border-top: 1px solid var(--line); }

        .aff-serif { font-family: var(--font-fraunces), Georgia, 'Iowan Old Style', serif; }

        .aff-eyebrow {
          font-family: var(--font-plex-mono,monospace); font-size: 11px; font-weight: 600;
          letter-spacing: .16em; margin: 0 0 14px; color: var(--teal); text-transform: uppercase;
          display: flex; align-items: center; gap: 10px;
        }
        .aff-eyebrow::before { content: ''; width: 16px; height: 1px; background: var(--teal); flex-shrink: 0; }
        .aff-eyebrow-center { justify-content: center; }
        .aff-eyebrow-center::before { display: none; }

        /* inputs — underline only, no boxed pill. The register's own convention: a line to write
           on, not a rounded field. */
        .aff-input {
          width: 100%; background: transparent; border: none; border-bottom: 1px solid var(--line-strong);
          border-radius: 0; padding: 9px 0; color: var(--text); font-size: 14px;
          outline: none; transition: border-color .15s; box-sizing: border-box;
        }
        .aff-input:focus { border-color: var(--teal); }
        .aff-input::placeholder { color: #454f5f; }
        .aff-label { display: grid; gap: 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
        .aff-label-req { color: var(--teal); margin-left: 3px; font-weight: 500; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; }

        /* who tags — rectangular, hairline, mono. Not full pills; matches the register's hard
           edges instead of the soft rounded-everywhere default. */
        .aff-who { border-radius: 3px; padding: 8px 14px; font-size: 12px; font-family: var(--font-plex-mono,monospace); white-space: nowrap; letter-spacing: .01em; }
        .aff-who-primary { border: 1px solid rgba(45,212,191,.35); background: var(--teal-soft); color: #7ce8d8; }
        .aff-who-standard { border: 1px solid var(--line); background: transparent; color: var(--muted); }

        .aff-faq-btn { width: 100%; background: none; border: none; cursor: pointer; padding: 22px 4px; display: flex; justify-content: space-between; align-items: center; gap: 20px; text-align: left; }

        .aff-btn-primary {
          display: inline-flex; align-items: center; gap: 9px; background: var(--teal); color: var(--teal-text);
          border: none; border-radius: 3px; padding: 14px 26px; font-weight: 700; font-size: 13px;
          letter-spacing: .04em; text-decoration: none; cursor: pointer;
          transition: transform .15s ease, filter .15s ease, box-shadow .15s ease;
        }
        .aff-btn-primary:not(:disabled):hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 6px 16px rgba(45,212,191,.22); }
        .aff-btn-primary:not(:disabled):active { transform: translateY(0); filter: brightness(.97); }
        .aff-btn-secondary { color: var(--muted); font-size: 13.5px; text-decoration: none; border-bottom: 1px solid var(--line-strong); padding-bottom: 2px; transition: color .15s, border-color .15s; }
        .aff-btn-secondary:hover { color: var(--text); border-color: var(--muted); }

        @media (prefers-reduced-motion: reduce) { .aff-btn-primary { transition: none; } .aff-btn-primary:hover { transform: none; } }

        /* ANCHOR OFFSET, DISCLOSED (affiliate QA): the navbar is position:sticky and occupies 80px
           (10px pad + 60px shell + 10px pad). Without scroll-margin-top the "Apply Now" and
           "How It Works" anchors scroll their target's heading directly underneath it, so the
           section looks like it starts mid-content. 96px = navbar height + breathing room. */
        #apply, #how-it-works { scroll-margin-top: 96px; }

        .aff-benefit-row + .aff-benefit-row,
        .aff-tool-row + .aff-tool-row { border-top: 1px solid var(--line); }

        .aff-ledger-line { display: flex; justify-content: space-between; padding: 11px 0; border-top: 1px solid var(--line); font-family: var(--font-plex-mono,monospace); font-size: 11.5px; }
        .aff-ledger-line span:first-child { color: var(--muted); }
        .aff-ledger-line span:last-child { color: var(--text); font-weight: 600; }

        @media (max-width:960px) {
          .aff-hero-grid, .aff-apply-grid { grid-template-columns: 1fr!important; }
          .aff-steps-grid { grid-template-columns: 1fr!important; gap: 0!important; }
          .aff-step-connector { display: none; }
        }
        @media (max-width:760px) {
          .aff-value-row { grid-template-columns: repeat(2,1fr)!important; }
          .aff-benefits-grid { grid-template-columns: 1fr!important; }
          .aff-tools-grid { grid-template-columns: 1fr!important; }
          .aff-form-cols { grid-template-columns: 1fr!important; }
        }
        @media (max-width:480px) {
          .aff-value-row { grid-template-columns: 1fr!important; }
        }
      `}</style>

      <Navbar />
      <AffiliateHubNav />

      <div className={`aff-page ${fraunces.variable}`} style={{ minHeight: '100vh', color: '#f8fafc', padding: '56px 20px 120px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>

          {/* ══ HERO ════════════════════════════════════════════════════════════ */}
          <section className="aff-hero-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: '64px', alignItems: 'center', marginBottom: '96px' }}>

            <div>
              <p className="aff-eyebrow">Founding Affiliate Program</p>

              <h1 className="aff-serif" style={{ margin: '0 0 24px', fontSize: 'clamp(36px,4.6vw,54px)', fontWeight: 500, lineHeight: 1.1, letterSpacing: '-.01em', color: '#f4f5f7' }}>
                Turn your audience into<br />
                <span className="aff-serif" style={{ fontStyle: 'italic', color: 'var(--teal)' }}>recurring revenue.</span>
              </h1>

              <p style={{ margin: '0 0 36px', color: '#94a3b8', fontSize: '16px', lineHeight: 1.75, maxWidth: '480px' }}>
                Partner with ChainLens AI and earn recurring monthly commissions by referring traders, token scanners, whale watchers, and Base-native communities to the CORTEX intelligence terminal.
              </p>

              <div style={{ display: 'flex', gap: '22px', flexWrap: 'wrap', alignItems: 'center' }}>
                <a href="#apply" className="aff-btn-primary">Apply now</a>
                <a href="#how-it-works" className="aff-btn-secondary">How it works</a>
              </div>
            </div>

            {/* Right — the "statement" panel: a ledger of what the program actually pays, not a
                floating glowing card. */}
            <div className="aff-surface" style={{ padding: '30px 28px' }}>
              <p style={{ margin: '0 0 6px', fontFamily: 'var(--font-plex-mono,monospace)', fontSize: '10px', letterSpacing: '.14em', color: 'var(--muted)', textTransform: 'uppercase' }}>Recurring commission</p>
              <div className="aff-serif" style={{ fontSize: '48px', fontWeight: 500, lineHeight: 1, letterSpacing: '-.02em', color: '#f4f5f7', marginBottom: '6px' }}>
                20<span style={{ color: 'var(--teal)' }}>%</span>
              </div>
              <p style={{ margin: '0 0 24px', fontSize: '12.5px', color: 'var(--muted)' }}>per referred subscription, every month</p>

              <div>
                {([
                  ['Payouts', '24–72h · manual · crypto'],
                  ['Approval', '24–72h manual review'],
                  ['Tracking', 'Referral / invite link'],
                  ['Custom terms', 'Available for top creators'],
                ] as [string, string][]).map(([k, v]) => (
                  <div className="aff-ledger-line" key={k}><span>{k}</span><span>{v}</span></div>
                ))}
              </div>

              <p style={{ margin: '22px 0 0', fontSize: '12px', color: '#526075', lineHeight: 1.65 }}>
                Full program terms and referral details are shared privately after approval.
              </p>
            </div>
          </section>

          {/* ══ VALUE STRIP ═════════════════════════════════════════════════════ */}
          <div className="aff-value-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0', marginBottom: '88px', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
            {([
              { value: '20%', label: 'Recurring commission' },
              { value: '24–72h', label: 'Manual crypto payouts' },
              { value: 'Manual', label: 'Every application reviewed' },
              { value: 'Native', label: 'Built for X, Telegram, Base' },
            ]).map(({ value, label }, i) => (
              <div key={label} style={{ padding: '22px 20px', borderLeft: i > 0 ? '1px solid var(--line)' : 'none' }}>
                <p className="aff-serif" style={{ margin: '0 0 3px', fontSize: '20px', fontWeight: 500, letterSpacing: '-.01em', color: '#f1f5f9' }}>{value}</p>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)', lineHeight: 1.5 }}>{label}</p>
              </div>
            ))}
          </div>

          {/* ══ WHAT PARTNERS GET ════════════════════════════════════════════════ */}
          <section style={{ marginBottom: '96px' }}>
            <div style={{ maxWidth: '620px', marginBottom: '48px' }}>
              <p className="aff-eyebrow">What partners get</p>
              <h2 className="aff-serif" style={{ margin: 0, fontSize: 'clamp(24px,2.8vw,32px)', fontWeight: 500, letterSpacing: '-.01em', color: '#f1f5f9' }}>Built to reward serious partners</h2>
            </div>
            <div className="aff-benefits-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', columnGap: '56px' }}>
              {BENEFITS.map(({ title, body }) => (
                <div key={title} className="aff-benefit-row" style={{ padding: '22px 0' }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 700, color: '#f1f5f9' }}>{title}</h3>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13.5px', lineHeight: 1.75, maxWidth: '420px' }}>{body}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ══ WHO SHOULD APPLY ════════════════════════════════════════════════ */}
          <section style={{ marginBottom: '96px' }}>
            <div style={{ textAlign: 'center', marginBottom: '32px' }}>
              <p className="aff-eyebrow aff-eyebrow-center">Who should apply</p>
              <h2 className="aff-serif" style={{ margin: '0 0 12px', fontSize: 'clamp(24px,2.8vw,32px)', fontWeight: 500, letterSpacing: '-.01em', color: '#f1f5f9' }}>Built for crypto creators with real attention</h2>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '14px', maxWidth: '480px', marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.7 }}>Quality over quantity. We prioritize engaged, niche communities over generic large followings.</p>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '9px', justifyContent: 'center', maxWidth: '760px', margin: '0 auto' }}>
              {WHO.map(({ label, primary }) => (
                <span key={label} className={`aff-who ${primary ? 'aff-who-primary' : 'aff-who-standard'}`}>{label}</span>
              ))}
            </div>
          </section>

          {/* ══ HOW IT WORKS ════════════════════════════════════════════════════ */}
          <section id="how-it-works" style={{ marginBottom: '96px' }}>
            <div style={{ textAlign: 'center', marginBottom: '52px' }}>
              <p className="aff-eyebrow aff-eyebrow-center">The process</p>
              <h2 className="aff-serif" style={{ margin: 0, fontSize: 'clamp(24px,2.8vw,32px)', fontWeight: 500, letterSpacing: '-.01em', color: '#f1f5f9' }}>Simple. Transparent. Manual.</h2>
            </div>
            <div className="aff-steps-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '8px' }}>
              {STEPS.map(({ n, title, body }, i) => (
                <div key={n} style={{ position: 'relative', padding: '0 24px' }}>
                  {i < STEPS.length - 1 && (
                    <div className="aff-step-connector" style={{ position: 'absolute', top: '19px', left: 'calc(50% + 44px)', right: 'calc(-50% + 44px)', height: '1px', background: 'var(--line)' }} />
                  )}
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '3px', border: '1px solid rgba(45,212,191,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontFamily: 'var(--font-plex-mono,monospace)', fontSize: '12.5px', fontWeight: 700, color: 'var(--teal)', background: 'var(--ink)', position: 'relative', zIndex: 1 }}>
                      {n}
                    </div>
                    <h3 style={{ margin: '0 0 10px', fontSize: '16.5px', fontWeight: 700, color: '#f1f5f9' }}>{title}</h3>
                    <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px', lineHeight: 1.75, maxWidth: '260px', marginLeft: 'auto', marginRight: 'auto' }}>{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ══ WHY PARTNERS PROMOTE ═══════════════════════════════════════════ */}
          <section style={{ marginBottom: '96px' }}>
            <div style={{ maxWidth: '620px', marginBottom: '40px' }}>
              <p className="aff-eyebrow">Why partners promote us</p>
              <h2 className="aff-serif" style={{ margin: '0 0 12px', fontSize: 'clamp(24px,2.8vw,32px)', fontWeight: 500, letterSpacing: '-.01em', color: '#f1f5f9' }}>Real tools. Real value. Easy to promote.</h2>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '14px', lineHeight: 1.7 }}>
                ChainLens gives your audience real utility, not another noisy call group, hype bot, or empty dashboard.
              </p>
            </div>
            <div className="aff-tools-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', columnGap: '40px' }}>
              {TOOLS.map(({ label, desc }) => (
                <div key={label} className="aff-tool-row" style={{ padding: '20px 0' }}>
                  <p style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700, color: '#f1f5f9' }}>{label}</p>
                  <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--muted)', lineHeight: 1.65 }}>{desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ══ APPLICATION FORM ════════════════════════════════════════════════ */}
          <section id="apply" className="aff-apply-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr .75fr', gap: '24px', marginBottom: '96px' }}>

            {/* Form card */}
            <div className="aff-surface" style={{ padding: '40px' }}>
              <p className="aff-eyebrow" style={{ marginBottom: '10px' }}>Partner application</p>
              <h2 className="aff-serif" style={{ margin: '0 0 10px', fontSize: 'clamp(21px,2.2vw,26px)', fontWeight: 500, letterSpacing: '-.01em', color: '#f1f5f9' }}>Apply to become a ChainLens affiliate</h2>
              <p style={{ margin: '0 0 32px', color: 'var(--muted)', fontSize: '14px', lineHeight: 1.7, maxWidth: '520px' }}>
                We review every application manually. Tell us who your audience is, where you create content, and why ChainLens fits your community.
              </p>

              {/* position:relative scopes the off-screen honeypot's absolute positioning to this
                  form instead of letting it resolve against the page/viewport. */}
              <form onSubmit={onSubmit} style={{ position: 'relative' }}>
                {/* Honeypot */}
                <input type="text" name="website" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: '-9999px', opacity: 0 }} aria-hidden="true" />

                {FIELD_GROUPS.map((group, gi) => (
                  <div key={group.legend} style={{ paddingTop: gi > 0 ? '22px' : 0, marginTop: gi > 0 ? '22px' : 0, borderTop: gi > 0 ? '1px solid var(--line)' : 'none' }}>
                    <p style={{ margin: '0 0 14px', fontSize: '10.5px', fontFamily: 'var(--font-plex-mono,monospace)', fontWeight: 600, letterSpacing: '.12em', color: 'var(--muted)', textTransform: 'uppercase' }}>{group.legend}</p>
                    {group.note && (
                      <p style={{ margin: '-4px 0 16px', fontSize: '12px', color: '#a5e8dc', lineHeight: 1.6, background: 'var(--teal-soft)', borderLeft: '2px solid var(--teal)', padding: '10px 14px' }}>
                        {group.note}
                      </p>
                    )}
                    <div className="aff-form-cols" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 24px' }}>
                      {group.fields.map(({ label, key, required, type, placeholder, span, maxLength }) => (
                        <label key={key} className="aff-label" style={span === 2 ? { gridColumn: '1 / -1' } : undefined}>
                          {label}{required && <span className="aff-label-req">Required</span>}
                          <input className="aff-input" type={type ?? 'text'} required={required} maxLength={maxLength} placeholder={placeholder} value={form[key]} onChange={e => updateField(key, e.target.value)} />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}

                <div style={{ paddingTop: '22px', marginTop: '22px', borderTop: '1px solid var(--line)' }}>
                  <p style={{ margin: '0 0 14px', fontSize: '10.5px', fontFamily: 'var(--font-plex-mono,monospace)', fontWeight: 600, letterSpacing: '.12em', color: 'var(--muted)', textTransform: 'uppercase' }}>Your plan</p>
                  <label className="aff-label">
                    How would you promote ChainLens?<span className="aff-label-req">Required</span>
                    <textarea className="aff-input" required rows={5} maxLength={1200} placeholder="Tell us your exact plan: content style, platform, audience fit, post frequency, etc." value={form.promo_plan} onChange={e => updateField('promo_plan', e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
                  </label>
                </div>

                {/* SUCCESS BOX, DISCLOSED (requested: "they should automatically get their own
                    referral link that they can copy and start sharing immediately"). One-click
                    copyable, built from the shared buildAffiliateReferralLink helper (single
                    source of truth for the origin), paired with a permanent route to
                    /affiliate/dashboard so the link is never lost again. */}
                {success && (
                  <div style={{ marginTop: '26px', padding: '18px 20px', borderRadius: '4px', background: 'var(--teal-soft)', border: '1px solid rgba(45,212,191,.28)' }}>
                    <p style={{ margin: '0 0 12px', color: '#a5e8dc', fontSize: '13px', lineHeight: 1.65 }}>{success.message}</p>
                    {success.referralCode && (
                      <>
                        <p style={{ margin: '0 0 7px', color: 'var(--muted)', fontSize: '10.5px', fontFamily: 'var(--font-plex-mono,monospace)', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase' }}>Your referral link</p>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch', flexWrap: 'wrap', marginBottom: '10px' }}>
                          <input
                            readOnly
                            value={buildAffiliateReferralLink(success.referralCode)}
                            onFocus={e => e.currentTarget.select()}
                            style={{ flex: '1 1 240px', minWidth: 0, background: 'var(--ink)', border: '1px solid var(--line-strong)', borderRadius: '3px', padding: '10px 12px', color: '#a5f3fc', fontSize: '12.5px', fontFamily: 'var(--font-plex-mono,monospace)', outline: 'none' }}
                          />
                          <button
                            type="button"
                            onClick={() => void copyReferralLink(buildAffiliateReferralLink(success.referralCode))}
                            style={{ flexShrink: 0, padding: '10px 18px', borderRadius: '3px', border: '1px solid rgba(45,212,191,.4)', background: copied ? 'rgba(45,212,191,.2)' : 'rgba(45,212,191,.1)', color: '#7ce8d8', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background .15s' }}
                          >
                            {copied ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                      </>
                    )}
                    <p style={{ margin: '0 0 10px', color: 'var(--muted)', fontSize: '12px', lineHeight: 1.65 }}>
                      This link is permanently yours and will not change. It starts tracking commissions once your application is approved.
                    </p>
                    <Link href="/affiliate/dashboard" style={{ color: '#7ce8d8', fontSize: '12px', fontWeight: 600, textDecoration: 'underline' }}>
                      Open your affiliate dashboard →
                    </Link>
                    <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: '11.5px', lineHeight: 1.6 }}>
                      Sign in with this same email any time to get your link back and track referrals and commissions.
                    </p>
                  </div>
                )}
                {error && (
                  <div style={{ marginTop: '26px', padding: '18px 20px', borderRadius: '4px', background: 'rgba(248,113,113,.05)', border: '1px solid rgba(248,113,113,.22)' }}>
                    <p style={{ margin: 0, color: '#fca5a5', fontSize: '13px', lineHeight: 1.65 }}>{error}</p>
                  </div>
                )}

                {/* SUBMIT BUTTON, DISCLOSED (reported live: "the button to submit looks shit and
                    ai slop", then extended into the Ledger redesign): solid ChainLens teal, sharp
                    3px radius, mono uppercase label — matches aff-btn-primary above rather than
                    inventing a second button style on the same page. */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginTop: '26px', paddingTop: '22px', borderTop: '1px solid var(--line)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-plex-mono,monospace)' }}>Manual review · decision by email</span>
                  <button type="submit" disabled={loading} className="aff-btn-primary" style={{ border: 0, fontSize: '13px', letterSpacing: '.04em', textTransform: 'uppercase', background: loading ? 'rgba(45,212,191,.25)' : 'var(--teal)', cursor: loading ? 'not-allowed' : 'pointer' }}>
                    {loading ? 'Submitting…' : 'Submit application'}
                  </button>
                </div>
              </form>
            </div>

            {/* Sidebar — one unified panel, sections split by hairlines */}
            <div className="aff-surface" style={{ padding: '0', alignSelf: 'start' }}>
              <div style={{ padding: '26px 24px' }}>
                <p className="aff-eyebrow" style={{ marginBottom: '12px' }}>Program notes</p>
                <ul style={{ margin: 0, paddingLeft: '16px', color: 'var(--muted)', fontSize: '13px', lineHeight: 2 }}>
                  <li>Commission details shared after approval.</li>
                  <li>Quality audiences prioritized over raw size.</li>
                  <li>No fake tracking or inflated guarantees.</li>
                  <li>Manual review, every application, every time.</li>
                </ul>
              </div>

              <div className="aff-hair" style={{ padding: '22px 24px' }}>
                <p className="aff-eyebrow" style={{ marginBottom: '12px' }}>Review timeline</p>
                {([['Apply', 'Immediately'], ['Under review', '0–24h'], ['Decision', 'Sent by email'], ['Onboarding', 'Day of approval']] as [string, string][]).map(([step, time], i) => (
                  <div key={step} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: i > 0 ? '1px solid var(--line)' : 'none' }}>
                    <span style={{ color: 'var(--muted)', fontSize: '12.5px' }}>{step}</span>
                    <span style={{ color: '#e2e8f0', fontSize: '12.5px', fontWeight: 600 }}>{time}</span>
                  </div>
                ))}
              </div>

              <div className="aff-hair" style={{ padding: '22px 24px' }}>
                <p className="aff-eyebrow" style={{ marginBottom: '10px' }}>Contact</p>
                <a href="mailto:chainlensai@gmail.com" style={{ color: '#7ce8d8', fontSize: '13px', fontWeight: 600, textDecoration: 'none', display: 'block', marginBottom: '10px' }}>chainlensai@gmail.com</a>
                <Link href="/pricing" style={{ color: 'var(--muted)', fontSize: '12.5px', textDecoration: 'none' }}>See what you&apos;re promoting → Pricing</Link>
              </div>
            </div>
          </section>

          {/* ══ FAQ ══════════════════════════════════════════════════════════════ */}
          <section style={{ maxWidth: '700px', margin: '0 auto 80px' }}>
            <div style={{ textAlign: 'center', marginBottom: '36px' }}>
              <p className="aff-eyebrow aff-eyebrow-center">FAQ</p>
              <h2 className="aff-serif" style={{ margin: 0, fontSize: 'clamp(22px,2.6vw,28px)', fontWeight: 500, letterSpacing: '-.01em', color: '#f1f5f9' }}>Common questions</h2>
            </div>
            <div>
              {faqs.map((item, i) => (
                <div key={i} style={{ borderTop: '1px solid var(--line)', borderBottom: i === faqs.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <button className="aff-faq-btn" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                    <span style={{ fontSize: '14.5px', fontWeight: 600, color: openFaq === i ? '#f1f5f9' : '#94a3b8', lineHeight: 1.5, transition: 'color .15s' }}>{item.q}</span>
                    <span style={{ color: openFaq === i ? 'var(--teal)' : '#3f4b5e', fontSize: '20px', flexShrink: 0, lineHeight: 1, transition: 'transform .2s,color .15s', display: 'block', transform: openFaq === i ? 'rotate(45deg)' : 'none' }}>+</span>
                  </button>
                  {openFaq === i && (
                    <div style={{ padding: '0 4px 24px' }}>
                      <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13.5px', lineHeight: 1.8, maxWidth: '560px' }}>{item.a}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* ══ FOOTER ══════════════════════════════════════════════════════════ */}
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: '32px', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '28px', flexWrap: 'wrap', marginBottom: '16px' }}>
              {([['Terminal', '/terminal'], ['Pricing', '/pricing'], ['Contact', '/contact']] as [string, string][]).map(([label, href]) => (
                <Link key={href} href={href} style={{ color: '#7ce8d8', fontSize: '13px', textDecoration: 'none', fontWeight: 600 }}>{label}</Link>
              ))}
              <a href="mailto:chainlensai@gmail.com" style={{ color: '#526075', fontSize: '13px', textDecoration: 'none' }}>chainlensai@gmail.com</a>
            </div>
            <p style={{ margin: 0, color: '#3f4b5e', fontSize: '11px', fontFamily: 'var(--font-plex-mono,monospace)', letterSpacing: '.06em' }}>
              © {new Date().getFullYear()} ChainLens AI. Base-native intelligence.
            </p>
          </div>

        </div>
      </div>
    </>
  )
}

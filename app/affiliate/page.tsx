'use client'

import { useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'

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
    a: 'You earn a recurring monthly commission for every paying user you refer, for as long as they stay subscribed. Commission rate and structure are shared in full after your application is approved.',
  },
  {
    q: 'When and how do I get paid?',
    a: 'Payouts are processed monthly after a 30-day hold period to account for refunds and chargebacks. We pay in crypto to your on-chain wallet address. You\'ll get full payout instructions once approved.',
  },
  {
    q: 'What audience size do I need?',
    a: 'There\'s no hard minimum. We care more about audience quality and niche fit than raw numbers. A focused Telegram group of 500 Base traders outperforms a generic channel of 50k. Show us your audience and tell us your plan.',
  },
  {
    q: 'How long does review take?',
    a: 'Most applications are reviewed within 24–72 hours. We read every application manually and look for genuine audience fit and honest promotion intent. Rushed or incomplete applications take longer.',
  },
]

export default function AffiliatePage() {
  const [form, setForm] = useState<FormState>(initialForm)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setSuccess(null)
    setError(null)
    try {
      const res = await fetch('/api/affiliate/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(typeof data?.error === 'string' ? data.error : 'Submission is temporarily unavailable. Please try again soon.')
      } else {
        setSuccess("Application received. We review every submission manually and will reach out within 72 hours.")
        setForm(initialForm)
      }
    } catch {
      setError('Submission is temporarily unavailable. Please try again soon.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        .aff-page {
          background:
            radial-gradient(ellipse 1200px 700px at 0% 0%, rgba(139,92,246,.12) 0%, transparent 55%),
            radial-gradient(ellipse 900px 600px at 100% 5%, rgba(45,212,191,.08) 0%, transparent 55%),
            radial-gradient(ellipse 600px 400px at 50% 100%, rgba(99,102,241,.07) 0%, transparent 60%),
            #05070d;
        }
        .aff-grid-col2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
        .aff-input { background:rgba(8,16,30,.75); border:1px solid rgba(148,163,184,.22); border-radius:10px; padding:12px 14px; color:#e2e8f0; font-size:14px; outline:none; transition:border-color .2s, box-shadow .2s; width:100%; }
        .aff-input:focus { border-color:rgba(45,212,191,.7) !important; box-shadow:0 0 0 3px rgba(45,212,191,.14); }
        .aff-benefit-card { background:linear-gradient(160deg,rgba(15,23,42,.7),rgba(7,11,20,.9)); border:1px solid rgba(148,163,184,.1); border-radius:16px; padding:24px; transition:transform .2s, box-shadow .2s; }
        .aff-benefit-card:hover { transform:translateY(-3px); box-shadow:0 14px 40px rgba(0,0,0,.4); }
        .aff-tag { display:inline-flex; align-items:center; gap:6px; padding:5px 13px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:.12em; font-family:var(--font-plex-mono); }
        .aff-who-chip { border:1px solid rgba(45,212,191,.28); background:rgba(45,212,191,.06); color:#67e8f9; border-radius:999px; padding:8px 14px; font-size:12px; font-family:var(--font-plex-mono); white-space:nowrap; }
        .aff-step-line { position:absolute; top:28px; left:calc(50% + 36px); right:calc(-50% + 36px); height:1px; background:linear-gradient(90deg,rgba(45,212,191,.4),rgba(139,92,246,.4)); }
        .aff-faq-item { border:1px solid rgba(148,163,184,.12); border-radius:14px; overflow:hidden; transition:border-color .2s; }
        .aff-faq-item:hover { border-color:rgba(148,163,184,.22); }
        @media (max-width:960px) { .aff-hero-grid, .aff-apply-grid { grid-template-columns:1fr !important; } .aff-steps-grid { grid-template-columns:1fr !important; } .aff-step-line { display:none; } }
        @media (max-width:700px) { .aff-benefits-grid, .aff-tools-grid { grid-template-columns:repeat(2,minmax(0,1fr)) !important; } .aff-grid-col2 { grid-template-columns:1fr !important; } }
        @media (max-width:480px) { .aff-benefits-grid, .aff-tools-grid { grid-template-columns:1fr !important; } }
      `}</style>

      <Navbar />

      <div className="aff-page" style={{ minHeight: '100vh', color: '#f8fafc', padding: '78px 16px 120px', position: 'relative', overflow: 'hidden' }}>

        {/* Grid overlay */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(99,102,241,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.04) 1px,transparent 1px)', backgroundSize: '52px 52px', maskImage: 'radial-gradient(circle at center, black 40%, transparent 85%)', pointerEvents: 'none' }} />

        <div style={{ maxWidth: 1120, margin: '0 auto', position: 'relative', zIndex: 1 }}>

          {/* ── HERO ─────────────────────────────────────────────────────────── */}
          <section className="aff-hero-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: '44px', alignItems: 'center', marginBottom: '88px', paddingTop: '12px' }}>

            <div>
              <div className="aff-tag" style={{ marginBottom: '26px', border: '1px solid rgba(45,212,191,.32)', background: 'rgba(45,212,191,.07)', color: '#2DD4BF' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,.9)', flexShrink: 0 }} />
                AFFILIATE PROGRAM — BETA
              </div>

              <h1 style={{ margin: '0 0 22px', fontSize: 'clamp(36px,5.2vw,62px)', fontWeight: 800, lineHeight: 1.04, letterSpacing: '-.025em' }}>
                Turn your audience<br />into{' '}
                <span style={{ background: 'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  recurring revenue.
                </span>
              </h1>

              <p style={{ margin: '0 0 36px', color: '#94a3b8', fontSize: '16px', lineHeight: 1.75, maxWidth: '520px' }}>
                Partner with ChainLens AI and get paid every month for every trader you bring to the most powerful Base intelligence terminal in crypto.
              </p>

              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '32px' }}>
                <a href="#apply" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '13px 28px', borderRadius: '10px', fontWeight: 700, fontSize: '14px', letterSpacing: '.04em', background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', color: '#06060a', textDecoration: 'none' }}>
                  Apply Now
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </a>
                <a href="#how-it-works" style={{ display: 'inline-flex', alignItems: 'center', padding: '13px 24px', borderRadius: '10px', fontWeight: 600, fontSize: '14px', border: '1px solid rgba(148,163,184,.24)', color: '#cbd5e1', background: 'rgba(255,255,255,.025)', textDecoration: 'none' }}>
                  How It Works
                </a>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['Recurring commissions', 'Crypto payouts', 'Base-native product', 'Quality-first'].map(chip => (
                  <span key={chip} style={{ border: '1px solid rgba(148,163,184,.2)', background: 'rgba(255,255,255,.03)', color: '#94a3b8', borderRadius: '999px', padding: '5px 11px', fontSize: '11px', fontFamily: 'var(--font-plex-mono)' }}>{chip}</span>
                ))}
              </div>
            </div>

            {/* Partner Snapshot card */}
            <div style={{ background: 'linear-gradient(160deg,rgba(15,23,42,.94),rgba(7,11,20,.98))', border: '1px solid rgba(45,212,191,.18)', borderRadius: '20px', padding: '28px 26px', boxShadow: '0 0 80px rgba(45,212,191,.06), inset 0 0 0 1px rgba(255,255,255,.04)' }}>
              <p style={{ margin: '0 0 20px', fontFamily: 'var(--font-plex-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '.18em', color: '#2DD4BF' }}>PARTNER SNAPSHOT</p>
              <div style={{ display: 'grid', gap: '9px', marginBottom: '20px' }}>
                {([
                  ['Status', 'Open — Beta'],
                  ['Review time', '24 – 72 hours'],
                  ['Best fit', 'Base & crypto creators'],
                  ['Tracking', 'Referral / invite link'],
                  ['Payouts', 'Monthly · Crypto wallet'],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '11px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,.06)', background: 'rgba(255,255,255,.025)' }}>
                    <span style={{ color: '#475569', fontSize: '12px', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>{k}</span>
                    <span style={{ color: '#e2e8f0', fontSize: '12px', fontWeight: 600, textAlign: 'right' }}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: '14px 16px', borderRadius: '12px', background: 'rgba(45,212,191,.05)', border: '1px solid rgba(45,212,191,.14)' }}>
                <p style={{ margin: 0, fontSize: '12px', color: '#67e8f9', lineHeight: 1.7 }}>
                  Commission rate and full program terms are shared privately with approved partners. We prioritize quality over volume.
                </p>
              </div>
            </div>
          </section>

          {/* ── OFFER ────────────────────────────────────────────────────────── */}
          <section style={{ marginBottom: '80px' }}>
            <div style={{ textAlign: 'center', marginBottom: '40px' }}>
              <p style={{ margin: '0 0 10px', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '.16em', color: '#8b5cf6' }}>WHAT YOU GET</p>
              <h2 style={{ margin: 0, fontSize: 'clamp(22px,3vw,36px)', fontWeight: 800, letterSpacing: '-.015em', color: '#f1f5f9' }}>A program built to reward serious partners</h2>
            </div>
            <div className="aff-benefits-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '14px' }}>
              {([
                { accent: '#2DD4BF', rgb: '45,212,191',  icon: '↻', title: 'Recurring Commission',   body: 'Earn every month your referred users stay subscribed — not just on the first sale. Real passive income.' },
                { accent: '#8b5cf6', rgb: '139,92,246',  icon: '📅', title: 'Monthly Payouts',        body: 'Commissions paid monthly to your crypto wallet address. No long lock-ups, no minimum thresholds.' },
                { accent: '#f59e0b', rgb: '245,158,11',  icon: '⬡', title: 'Crypto-Native Product',  body: 'Token scanner, wallet tools, Clark AI, and whale alerts — tools your audience will actually use daily.' },
                { accent: '#67e8f9', rgb: '103,232,249', icon: '✦', title: 'Custom Partner Deals',   body: 'Top partners get custom codes, early campaign access, and dedicated support as the program grows.' },
              ] as Array<{ accent: string; rgb: string; icon: string; title: string; body: string }>).map(({ accent, rgb, icon, title, body }) => (
                <article key={title} className="aff-benefit-card" style={{ borderTop: `2px solid ${accent}` }}>
                  <div style={{ width: '42px', height: '42px', borderRadius: '11px', background: `rgba(${rgb},.1)`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '18px', fontSize: '19px', color: accent }}>
                    {icon}
                  </div>
                  <h3 style={{ margin: '0 0 9px', fontSize: '15px', fontWeight: 700, color: '#f1f5f9' }}>{title}</h3>
                  <p style={{ margin: 0, color: '#64748b', fontSize: '13px', lineHeight: 1.7 }}>{body}</p>
                </article>
              ))}
            </div>
          </section>

          {/* ── WHO IT'S FOR ─────────────────────────────────────────────────── */}
          <section style={{ marginBottom: '80px' }}>
            <div style={{ textAlign: 'center', marginBottom: '32px' }}>
              <p style={{ margin: '0 0 10px', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '.16em', color: '#2DD4BF' }}>WHO SHOULD APPLY</p>
              <h2 style={{ margin: 0, fontSize: 'clamp(22px,3vw,36px)', fontWeight: 800, letterSpacing: '-.015em', color: '#f1f5f9' }}>Built for crypto creators of all sizes</h2>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center' }}>
              {['Base KOLs', 'Onchain analysts', 'Telegram community owners', 'Crypto newsletter writers', 'Trading group operators', 'X / Twitter creators', 'TikTok & YouTube crypto educators', 'Discord server admins'].map(item => (
                <span key={item} className="aff-who-chip">{item}</span>
              ))}
            </div>
          </section>

          {/* ── HOW IT WORKS ─────────────────────────────────────────────────── */}
          <section id="how-it-works" style={{ marginBottom: '80px' }}>
            <div style={{ textAlign: 'center', marginBottom: '40px' }}>
              <p style={{ margin: '0 0 10px', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '.16em', color: '#8b5cf6' }}>THE PROCESS</p>
              <h2 style={{ margin: 0, fontSize: 'clamp(22px,3vw,36px)', fontWeight: 800, letterSpacing: '-.015em', color: '#f1f5f9' }}>Simple. Transparent. Honest.</h2>
            </div>
            <div className="aff-steps-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '16px', position: 'relative' }}>
              {([
                { n: '01', accent: '#2DD4BF', title: 'Apply',               body: 'Fill out the form with your platform, audience size, and how you plan to promote ChainLens. Be specific — it helps.' },
                { n: '02', accent: '#8b5cf6', title: 'Get Approved',         body: 'We read every application manually and check for audience fit and promotion quality. Expect a reply within 24–72h.' },
                { n: '03', accent: '#67e8f9', title: 'Earn Recurring Commissions', body: 'Receive your referral link. Every qualified paying user you bring earns you a monthly commission for life.' },
              ] as Array<{ n: string; accent: string; title: string; body: string }>).map(({ n, accent, title, body }, i) => (
                <article key={n} style={{ background: 'rgba(255,255,255,.025)', border: '1px solid rgba(148,163,184,.1)', borderRadius: '16px', padding: '28px 24px', position: 'relative' }}>
                  {i < 2 && <div className="aff-step-line" />}
                  <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: `rgba(${accent === '#2DD4BF' ? '45,212,191' : accent === '#8b5cf6' ? '139,92,246' : '103,232,249'},.1)`, border: `1.5px solid ${accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px', fontFamily: 'var(--font-plex-mono)', fontSize: '14px', fontWeight: 700, color: accent }}>
                    {n}
                  </div>
                  <h3 style={{ margin: '0 0 10px', fontSize: '18px', fontWeight: 700, color: '#f1f5f9' }}>{title}</h3>
                  <p style={{ margin: 0, color: '#64748b', fontSize: '13px', lineHeight: 1.7 }}>{body}</p>
                </article>
              ))}
            </div>
          </section>

          {/* ── WHY PARTNERS PROMOTE ─────────────────────────────────────────── */}
          <section style={{ marginBottom: '80px' }}>
            <div style={{ textAlign: 'center', marginBottom: '40px' }}>
              <p style={{ margin: '0 0 10px', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '.16em', color: '#f59e0b' }}>WHY PARTNERS PROMOTE US</p>
              <h2 style={{ margin: 0, fontSize: 'clamp(22px,3vw,36px)', fontWeight: 800, letterSpacing: '-.015em', color: '#f1f5f9' }}>Real tools. Real value. Easy to sell.</h2>
            </div>
            <div className="aff-tools-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '12px' }}>
              {([
                { icon: '🔍', label: 'Token Scanner',       desc: 'Instant contract analysis with CORTEX AI scoring' },
                { icon: '🐋', label: 'Whale Tracker',       desc: 'Live alerts when big wallets move on Base' },
                { icon: '🤖', label: 'Clark AI',            desc: 'Conversational onchain intelligence assistant' },
                { icon: '📊', label: 'Bear Market Scorer',  desc: 'Portfolio risk scoring across market cycles' },
                { icon: '💹', label: 'Paper Trading',       desc: 'Practice trading without risking real capital' },
                { icon: '👛', label: 'Wallet Scanner',      desc: 'Deep-dive any wallet — age, activity, PnL' },
                { icon: '🔔', label: 'Smart Alerts',        desc: 'Customizable price + on-chain movement alerts' },
                { icon: '⚡', label: 'Real-Time Base Data', desc: 'Every block, every token, every wallet — live' },
              ]).map(({ icon, label, desc }) => (
                <div key={label} style={{ background: 'linear-gradient(160deg,rgba(15,23,42,.65),rgba(7,11,20,.85))', border: '1px solid rgba(148,163,184,.1)', borderRadius: '14px', padding: '18px 16px' }}>
                  <div style={{ fontSize: '22px', marginBottom: '10px' }}>{icon}</div>
                  <p style={{ margin: '0 0 5px', fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{label}</p>
                  <p style={{ margin: 0, fontSize: '11px', color: '#475569', lineHeight: 1.6 }}>{desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── APPLICATION FORM ─────────────────────────────────────────────── */}
          <section id="apply" className="aff-apply-grid" style={{ display: 'grid', gridTemplateColumns: '1.15fr .85fr', gap: '20px', marginBottom: '72px' }}>

            <div style={{ background: 'linear-gradient(160deg,rgba(15,23,42,.72),rgba(7,11,20,.9))', border: '1px solid rgba(148,163,184,.14)', borderRadius: '20px', padding: '36px 32px' }}>
              <p style={{ margin: '0 0 6px', fontFamily: 'var(--font-plex-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '.18em', color: '#2DD4BF' }}>PARTNER APPLICATION</p>
              <h2 style={{ margin: '0 0 10px', fontSize: 'clamp(20px,2.5vw,28px)', fontWeight: 800, letterSpacing: '-.015em', color: '#f1f5f9' }}>Apply to become a ChainLens affiliate</h2>
              <p style={{ margin: '0 0 28px', color: '#64748b', fontSize: '14px', lineHeight: 1.7 }}>Tell us about your audience and how you'd promote ChainLens. We read every application personally.</p>

              <form onSubmit={onSubmit}>
                {/* Honeypot — hidden from real users */}
                <input type="text" name="website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: '-9999px', opacity: 0 }} aria-hidden="true" />

                <div className="aff-grid-col2" style={{ marginBottom: '14px' }}>
                  {([
                    { label: 'Full Name', key: 'name', required: true, placeholder: 'Your name' },
                    { label: 'Email Address', key: 'email', required: true, type: 'email', placeholder: 'you@example.com' },
                    { label: 'X Handle', key: 'x_handle', required: true, placeholder: '@yourhandle' },
                    { label: 'Telegram (optional)', key: 'telegram', required: false, placeholder: '@yourusername' },
                    { label: 'Audience Size', key: 'audience_size', required: true, placeholder: 'e.g. 12,000 Twitter followers' },
                    { label: 'Audience Type / Niche', key: 'audience_type', required: true, placeholder: 'e.g. Base traders, DeFi analysts' },
                    { label: 'Payout Wallet (optional)', key: 'payout_wallet', required: false, placeholder: '0x…' },
                  ] as Array<{ label: string; key: string; required: boolean; type?: string; placeholder: string }>).map(({ label, key, required, type, placeholder }) => (
                    <label key={key} style={{ display: 'grid', gap: '7px', fontSize: '11px', fontWeight: 600, letterSpacing: '.08em', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>
                      {label}{required && <span style={{ color: '#f87171', marginLeft: '2px' }}>*</span>}
                      <input
                        className="aff-input"
                        type={type ?? 'text'}
                        required={required}
                        placeholder={placeholder}
                        value={form[key as keyof FormState]}
                        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>

                <label style={{ display: 'grid', gap: '7px', fontSize: '11px', fontWeight: 600, letterSpacing: '.08em', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '20px' }}>
                  How would you promote ChainLens?<span style={{ color: '#f87171', marginLeft: '2px' }}>*</span>
                  <textarea
                    className="aff-input"
                    required
                    rows={5}
                    placeholder="Tell us your exact plan — content style, platform, audience fit, post frequency, etc."
                    value={form.promo_plan}
                    onChange={(e) => setForm({ ...form, promo_plan: e.target.value })}
                    style={{ resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </label>

                {success && (
                  <div style={{ marginBottom: '18px', padding: '14px 16px', borderRadius: '10px', background: 'rgba(45,212,191,.06)', border: '1px solid rgba(45,212,191,.25)' }}>
                    <p style={{ margin: 0, color: '#2dd4bf', fontSize: '13px', lineHeight: 1.6 }}>{success}</p>
                  </div>
                )}
                {error && (
                  <div style={{ marginBottom: '18px', padding: '14px 16px', borderRadius: '10px', background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.25)' }}>
                    <p style={{ margin: 0, color: '#fca5a5', fontSize: '13px', lineHeight: 1.6 }}>{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  style={{ width: '100%', border: 0, borderRadius: '11px', padding: '14px 18px', fontWeight: 700, fontSize: '14px', letterSpacing: '.06em', background: loading ? 'rgba(45,212,191,.4)' : 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', color: '#06060a', cursor: loading ? 'not-allowed' : 'pointer', transition: 'opacity .2s' }}
                >
                  {loading ? 'Submitting…' : 'Submit Application →'}
                </button>
              </form>
            </div>

            {/* Right sidebar */}
            <div style={{ display: 'grid', gap: '14px', alignContent: 'start' }}>
              {/* Program notes */}
              <div style={{ background: 'linear-gradient(160deg,rgba(15,23,42,.7),rgba(7,11,20,.9))', border: '1px solid rgba(148,163,184,.12)', borderRadius: '16px', padding: '22px 20px' }}>
                <p style={{ margin: '0 0 14px', fontFamily: 'var(--font-plex-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '.16em', color: '#67e8f9' }}>PROGRAM NOTES</p>
                <ul style={{ margin: 0, paddingLeft: '18px', color: '#94a3b8', fontSize: '13px', lineHeight: 1.9 }}>
                  <li>Commission details are shared after approval.</li>
                  <li>We prioritise quality audiences over raw size.</li>
                  <li>Educational and honest content converts best.</li>
                  <li>No fake tracking claims or inflated guarantees.</li>
                  <li>Applications are reviewed manually, every time.</li>
                </ul>
              </div>
              {/* Review timeline */}
              <div style={{ background: 'linear-gradient(160deg,rgba(139,92,246,.06),rgba(7,11,20,.9))', border: '1px solid rgba(139,92,246,.2)', borderRadius: '16px', padding: '22px 20px' }}>
                <p style={{ margin: '0 0 14px', fontFamily: 'var(--font-plex-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '.16em', color: '#a78bfa' }}>REVIEW TIMELINE</p>
                {([['Applied', 'Immediately'], ['Under review', '0–24h'], ['Decision sent', '24–72h'], ['Onboarding', 'Same day as approval']] as [string, string][]).map(([step, time]) => (
                  <div key={step} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,.05)', fontSize: '12px' }}>
                    <span style={{ color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>{step}</span>
                    <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{time}</span>
                  </div>
                ))}
              </div>
              {/* Link to pricing */}
              <div style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.07)', borderRadius: '14px', padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#64748b', fontSize: '13px' }}>Want to see what you're selling?</span>
                <Link href="/pricing" style={{ color: '#67e8f9', fontSize: '13px', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap', marginLeft: '12px' }}>See Pricing →</Link>
              </div>
            </div>
          </section>

          {/* ── FAQ ──────────────────────────────────────────────────────────── */}
          <section style={{ marginBottom: '72px', maxWidth: '720px', margin: '0 auto 72px' }}>
            <div style={{ textAlign: 'center', marginBottom: '36px' }}>
              <p style={{ margin: '0 0 10px', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '.16em', color: '#8b5cf6' }}>FAQ</p>
              <h2 style={{ margin: 0, fontSize: 'clamp(22px,3vw,34px)', fontWeight: 800, letterSpacing: '-.015em', color: '#f1f5f9' }}>Common questions</h2>
            </div>
            <div style={{ display: 'grid', gap: '8px' }}>
              {faqs.map((item, i) => (
                <div key={i} className="aff-faq-item" style={{ background: 'rgba(255,255,255,.02)' }}>
                  <button
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                    style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', textAlign: 'left' }}
                  >
                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#e2e8f0', lineHeight: 1.5 }}>{item.q}</span>
                    <span style={{ color: '#475569', fontSize: '18px', flexShrink: 0, transition: 'transform .2s', transform: openFaq === i ? 'rotate(45deg)' : 'none' }}>+</span>
                  </button>
                  {openFaq === i && (
                    <div style={{ padding: '0 20px 18px' }}>
                      <p style={{ margin: 0, color: '#64748b', fontSize: '13px', lineHeight: 1.75 }}>{item.a}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* ── FOOTER NAV ───────────────────────────────────────────────────── */}
          <div style={{ textAlign: 'center', borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: '32px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '24px', flexWrap: 'wrap', marginBottom: '14px' }}>
              {[['Terminal', '/terminal'], ['Pricing', '/pricing'], ['Contact', '/contact']].map(([label, href]) => (
                <Link key={href} href={href} style={{ color: 'rgba(45,212,191,.65)', fontSize: '13px', textDecoration: 'none', fontWeight: 600 }}>{label}</Link>
              ))}
              <a href="mailto:chainlensai@gmail.com" style={{ color: 'rgba(255,255,255,.3)', fontSize: '13px', textDecoration: 'none' }}>chainlensai@gmail.com</a>
            </div>
            <p style={{ margin: 0, color: '#1e293b', fontSize: '11px', fontFamily: 'var(--font-plex-mono)' }}>© {new Date().getFullYear()} ChainLens AI</p>
          </div>

        </div>
      </div>
    </>
  )
}

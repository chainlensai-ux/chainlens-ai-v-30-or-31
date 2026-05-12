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
  promotion_plan: string
  wallet_address: string
  website: string
}

const initialForm: FormState = {
  name: '', email: '', telegram: '', x_handle: '', audience_size: '', audience_type: '', promotion_plan: '', wallet_address: '', website: '',
}

export default function AffiliatePage() {
  const [form, setForm] = useState<FormState>(initialForm)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        setError('Submission is temporarily unavailable. Please try again soon.')
      } else {
        setSuccess("Application sent. We’ll review it manually during beta.")
        setForm(initialForm)
      }
    } catch {
      setError('Submission is temporarily unavailable. Please try again soon.')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'rgba(8,16,30,0.75)',
    border: '1px solid rgba(148,163,184,0.28)',
    borderRadius: 12,
    padding: '12px 14px',
    color: '#e2e8f0',
    fontSize: 14,
    outline: 'none',
    transition: 'all 0.2s ease',
  }

  return (
    <>
      <style>{`
        .aff-page { background: radial-gradient(ellipse 1100px 700px at 8% 0%, rgba(139,92,246,.13) 0%, transparent 55%), radial-gradient(ellipse 900px 600px at 92% 8%, rgba(45,212,191,.09) 0%, transparent 55%), radial-gradient(ellipse 600px 400px at 50% 95%, rgba(99,102,241,.07) 0%, transparent 60%), #05070d; }
        .aff-grid { display:grid; gap:14px; grid-template-columns:repeat(2,minmax(0,1fr)); }
        .aff-card { background: linear-gradient(180deg, rgba(15,23,42,.68), rgba(7,11,20,.84)); border:1px solid rgba(148,163,184,.18); border-radius:16px; }
        .aff-pill { border:1px solid rgba(148,163,184,.24); background:rgba(255,255,255,.03); color:#cbd5e1; border-radius:999px; padding:6px 10px; font-size:11px; font-family:var(--font-plex-mono); }
        .aff-chip { border:1px solid rgba(45,212,191,.35); background:rgba(45,212,191,.08); color:#67e8f9; border-radius:999px; padding:6px 10px; font-size:11px; font-family:var(--font-plex-mono); }
        .aff-input:focus { border-color: rgba(45,212,191,.7) !important; box-shadow: 0 0 0 3px rgba(45,212,191,.18); }
        .aff-benefit-card { background: linear-gradient(160deg, rgba(15,23,42,.65), rgba(7,11,20,.85)); border-radius:16px; padding:24px; transition: transform .2s, box-shadow .2s; }
        .aff-benefit-card:hover { transform: translateY(-3px); box-shadow: 0 14px 40px rgba(0,0,0,.35); }
        .aff-step-card { background: rgba(255,255,255,.025); border:1px solid rgba(148,163,184,.1); border-radius:16px; padding:28px 24px; }
        @media (max-width: 960px) { .aff-hero, .aff-apply { grid-template-columns: 1fr !important; } }
        @media (max-width: 768px) { .aff-grid, .aff-benefits, .aff-steps, .aff-who { grid-template-columns: 1fr !important; } }
      `}</style>
      <Navbar />
      <div className="aff-page" style={{ minHeight: '100vh', color: '#f8fafc', padding: '78px 16px 120px', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(99,102,241,.05) 1px, transparent 1px),linear-gradient(90deg, rgba(99,102,241,.05) 1px, transparent 1px)', backgroundSize: '52px 52px', maskImage: 'radial-gradient(circle at center, black 40%, transparent 85%)', pointerEvents: 'none' }} />

        <div style={{ maxWidth: 1120, margin: '0 auto', position: 'relative', zIndex: 1 }}>
          <section className="aff-hero" style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: '40px', alignItems: 'center', marginBottom: '80px', paddingTop: '8px' }}>

            {/* Left: free-floating headline — no card wrapper */}
            <div>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px',
                padding: '5px 14px', borderRadius: '999px', marginBottom: '24px',
                border: '1px solid rgba(45,212,191,.3)', background: 'rgba(45,212,191,.07)',
                fontSize: '11px', fontWeight: 700, letterSpacing: '.14em',
                color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)',
              }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,.8)', flexShrink: 0 }} />
                AFFILIATE PROGRAM
              </div>

              <h1 style={{ margin: '0 0 20px', fontSize: 'clamp(34px,5vw,58px)', fontWeight: 800, lineHeight: 1.06, letterSpacing: '-.02em' }}>
                Earn{' '}
                <span style={{ background: 'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  recurring revenue
                </span>
                {' '}by bringing serious Base traders to ChainLens AI.
              </h1>

              <p style={{ margin: '0 0 32px', color: '#94a3b8', fontSize: '16px', lineHeight: 1.75, maxWidth: '500px' }}>
                Join the ChainLens partner network and get rewarded for introducing creators, KOLs, and onchain communities to a Base-native intelligence terminal.
              </p>

              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '28px' }}>
                <a href="#apply" style={{
                  display: 'inline-flex', alignItems: 'center', gap: '8px',
                  padding: '13px 28px', borderRadius: '10px',
                  fontWeight: 700, fontSize: '14px', letterSpacing: '.04em',
                  background: 'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 100%)',
                  color: '#06060a', textDecoration: 'none',
                }}>
                  Apply Now
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </a>
                <a href="#how-it-works" style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '13px 24px', borderRadius: '10px',
                  fontWeight: 600, fontSize: '14px',
                  border: '1px solid rgba(148,163,184,.25)', color: '#cbd5e1',
                  background: 'rgba(255,255,255,.03)', textDecoration: 'none',
                }}>
                  See How It Works
                </a>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {['Recurring commissions', 'Base-native product', 'Quality-first program', 'Fast review'].map(chip => (
                  <span key={chip} className="aff-pill">{chip}</span>
                ))}
              </div>
            </div>

            {/* Right: premium Partner Snapshot card */}
            <div style={{
              background: 'linear-gradient(160deg, rgba(15,23,42,.92) 0%, rgba(7,11,20,.98) 100%)',
              border: '1px solid rgba(45,212,191,.2)',
              borderRadius: '20px', padding: '28px',
              boxShadow: '0 0 60px rgba(45,212,191,.07), inset 0 0 0 1px rgba(255,255,255,.04)',
            }}>
              <p style={{ margin: '0 0 18px', fontFamily: 'var(--font-plex-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '.16em', color: '#2DD4BF' }}>PARTNER SNAPSHOT</p>
              <div style={{ display: 'grid', gap: '10px', marginBottom: '20px' }}>
                {([
                  ['Applications', 'Open now'],
                  ['Review time', '24–72h'],
                  ['Best for', 'Base & crypto creators'],
                  ['Tracking', 'Invite / referral based'],
                  ['Payouts', 'After approval & verification'],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
                    padding: '11px 14px', borderRadius: '10px',
                    border: '1px solid rgba(255,255,255,.07)', background: 'rgba(255,255,255,.025)',
                  }}>
                    <span style={{ color: '#64748b', fontSize: '12px', fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap' }}>{k}</span>
                    <span style={{ color: '#e2e8f0', fontSize: '12px', fontWeight: 600, textAlign: 'right' }}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: '14px', borderRadius: '12px', background: 'rgba(45,212,191,.06)', border: '1px solid rgba(45,212,191,.15)' }}>
                <p style={{ margin: 0, fontSize: '12px', color: '#67e8f9', lineHeight: 1.65 }}>
                  Commission structure and referral details are shared with approved partners. We prioritize quality over volume.
                </p>
              </div>
            </div>

          </section>

          <section id="benefits" style={{ marginBottom: '72px' }}>
            <div style={{ textAlign: 'center', marginBottom: '36px' }}>
              <p style={{ margin: '0 0 8px', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '.14em', color: '#8b5cf6' }}>WHY PARTNER WITH US</p>
              <h2 style={{ margin: 0, fontSize: 'clamp(22px,3vw,34px)', fontWeight: 800, letterSpacing: '-.01em', color: '#f1f5f9' }}>Built for serious crypto creators</h2>
            </div>
            <div className="aff-benefits" style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(4,minmax(0,1fr))' }}>
              {([
                { accent: '#2DD4BF', rgb: '45,212,191',  marker: '↻', title: 'Recurring Commissions',  body: 'Earn every month your referred users stay subscribed — not just on the initial sign-up.' },
                { accent: '#8b5cf6', rgb: '139,92,246',  marker: '⬡', title: 'Built for Base Traders',  body: 'Token scanner, wallet tools, alerts, and Clark AI — purpose-built for the chain your audience lives on.' },
                { accent: '#f59e0b', rgb: '245,158,11',  marker: '⚡', title: 'Real Onchain Utility',    body: 'Users scan contracts, track wallets, and get AI verdicts on every token. Real value that converts.' },
                { accent: '#67e8f9', rgb: '103,232,249', marker: '✦', title: 'Launch Partner Access',   body: 'Top affiliates get early campaigns, custom codes, and direct partner support as the program scales.' },
              ] as Array<{ accent: string; rgb: string; marker: string; title: string; body: string }>).map(({ accent, rgb, marker, title, body }) => (
                <article key={title} className="aff-benefit-card" style={{ borderTop: `2px solid ${accent}`, border: `1px solid rgba(148,163,184,.12)`, borderTopColor: accent }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: `rgba(${rgb},.1)`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px', fontSize: '18px', color: accent }}>
                    {marker}
                  </div>
                  <h3 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 700, color: '#f1f5f9' }}>{title}</h3>
                  <p style={{ margin: 0, color: '#64748b', fontSize: '13px', lineHeight: 1.65 }}>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <section id="how-it-works" style={{ marginBottom: '72px' }}>
            <div style={{ textAlign: 'center', marginBottom: '36px' }}>
              <p style={{ margin: '0 0 8px', fontFamily: 'var(--font-plex-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '.14em', color: '#8b5cf6' }}>THE PROCESS</p>
              <h2 style={{ margin: 0, fontSize: 'clamp(22px,3vw,34px)', fontWeight: 800, letterSpacing: '-.01em', color: '#f1f5f9' }}>Simple. Transparent. Honest.</h2>
            </div>
            <div className="aff-steps" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '16px' }}>
              {([
                { n: '01', accent: '#2DD4BF', title: 'Apply',            body: 'Tell us about your audience — size, platform, niche. Share your plan for promoting ChainLens honestly and clearly.' },
                { n: '02', accent: '#8b5cf6', title: 'Get approved',     body: 'We review your application for audience fit and promotion quality. Expect a response within 24–72 hours.' },
                { n: '03', accent: '#67e8f9', title: 'Earn from referrals', body: 'Receive your referral flow. Every qualified paid user you introduce earns you commission — recurring, every month.' },
              ] as Array<{ n: string; accent: string; title: string; body: string }>).map(({ n, accent, title, body }) => (
                <article key={n} className="aff-step-card">
                  <div style={{ fontSize: 'clamp(42px,5vw,58px)', fontWeight: 800, lineHeight: 1, marginBottom: '18px', background: `linear-gradient(135deg, ${accent}, rgba(255,255,255,.14))`, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontFamily: 'var(--font-plex-mono)' }}>
                    {n}
                  </div>
                  <h3 style={{ margin: '0 0 10px', fontSize: '18px', fontWeight: 700, color: '#f1f5f9' }}>{title}</h3>
                  <p style={{ margin: 0, color: '#64748b', fontSize: '13px', lineHeight: 1.7 }}>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <section style={{ marginBottom: 30 }}>
            <h2 style={{ margin: '0 0 10px', fontSize: 24 }}>Perfect for</h2>
            <div className="aff-who" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 }}>
              {['Base KOLs', 'Onchain analysts', 'Telegram community owners', 'Crypto newsletter writers', 'Trading group operators', 'TikTok/X creators'].map((item) => (
                <div key={item} className="aff-card" style={{ padding: '12px 14px', fontSize: 13, color: '#cbd5e1' }}>{item}</div>
              ))}
            </div>
          </section>

          <section id="apply" className="aff-apply" style={{ display: 'grid', gridTemplateColumns: '1.1fr .9fr', gap: 16 }}>
            <form onSubmit={onSubmit} className="aff-card" style={{ padding: 20 }}>
              <h2 style={{ margin: '0 0 8px', fontSize: 24 }}>Apply to become a ChainLens affiliate</h2>
              <p style={{ margin: '0 0 16px', color: '#94a3b8' }}>Tell us where your audience lives and how you'd promote ChainLens.</p>
              <input type="text" name="website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: '-9999px', opacity: 0 }} />
              <div className="aff-grid">
                {[
                  ['Name', 'name'], ['Email', 'email'], ['Telegram', 'telegram'], ['X handle', 'x_handle'], ['Audience size', 'audience_size'], ['Audience type / niche', 'audience_type'], ['Wallet address for payouts', 'wallet_address'],
                ].map(([label, key]) => (
                  <label key={key} style={{ display: 'grid', gap: 6, fontSize: 12, color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)' }}>
                    {label}
                    <input className="aff-input" required={key === 'name' || key === 'email'} type={key === 'email' ? 'email' : 'text'} value={form[key as keyof FormState]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} style={inputStyle} />
                  </label>
                ))}
                <label style={{ gridColumn: '1 / -1', display: 'grid', gap: 6, fontSize: 12, color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)' }}>
                  How would you promote ChainLens?
                  <textarea className="aff-input" rows={5} value={form.promotion_plan} onChange={(e) => setForm({ ...form, promotion_plan: e.target.value })} style={{ ...inputStyle, resize: 'vertical' }} />
                </label>
              </div>
              {success && <p style={{ marginTop: 14, color: '#2dd4bf', fontSize: 13 }}>{success}</p>}
              {error && <p style={{ marginTop: 14, color: '#fca5a5', fontSize: 13 }}>{error}</p>}
              <button type="submit" disabled={loading} style={{ marginTop: 16, border: 0, borderRadius: 12, padding: '12px 18px', fontWeight: 700, letterSpacing: '.08em', background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', color: '#07111e', cursor: loading ? 'not-allowed' : 'pointer' }}>{loading ? 'Submitting…' : 'Apply for Affiliate'}</button>
            </form>

            <div className="aff-card" style={{ padding: 20, alignSelf: 'start' }}>
              <p style={{ margin: '0 0 12px', fontFamily: 'var(--font-plex-mono)', fontSize: 11, letterSpacing: '.14em', color: '#67e8f9' }}>PROGRAM NOTES</p>
              <ul style={{ margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 13, lineHeight: 1.8 }}>
                <li>Commission details are shared after approval.</li>
                <li>Quality audience and clear promotion plans are prioritized.</li>
                <li>Best results come from educational content and honest demos.</li>
                <li>No fake tracking claims: referral tracking is invite/referral based.</li>
              </ul>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="aff-pill">Base-native</span>
                <span className="aff-pill">Crypto creators</span>
                <span className="aff-pill">Cortex-powered platform</span>
              </div>
              <Link href="/pricing" style={{ display: 'inline-block', marginTop: 14, color: '#67e8f9', textDecoration: 'none', fontWeight: 600 }}>See product tiers →</Link>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

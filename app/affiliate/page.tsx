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
      const json = await res.json()
      if (!res.ok) setError(json?.error || 'Couldn’t submit right now. Try again.')
      else {
        setSuccess('Application sent. We’ll review it and reach out.')
        setForm(initialForm)
      }
    } catch {
      setError('Couldn’t submit right now. Try again.')
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
        .aff-page { background: radial-gradient(1000px 600px at 12% 4%, rgba(34,211,238,.13), transparent 60%), radial-gradient(900px 540px at 90% 10%, rgba(139,92,246,.16), transparent 60%), #05070d; }
        .aff-grid { display:grid; gap:14px; grid-template-columns:repeat(2,minmax(0,1fr)); }
        .aff-card { background: linear-gradient(180deg, rgba(15,23,42,.68), rgba(7,11,20,.84)); border:1px solid rgba(148,163,184,.18); border-radius:16px; }
        .aff-pill { border:1px solid rgba(148,163,184,.24); background:rgba(255,255,255,.03); color:#cbd5e1; border-radius:999px; padding:6px 10px; font-size:11px; font-family:var(--font-plex-mono); }
        .aff-chip { border:1px solid rgba(45,212,191,.35); background:rgba(45,212,191,.08); color:#67e8f9; border-radius:999px; padding:6px 10px; font-size:11px; font-family:var(--font-plex-mono); }
        .aff-input:focus { border-color: rgba(45,212,191,.7) !important; box-shadow: 0 0 0 3px rgba(45,212,191,.18); }
        @media (max-width: 960px) { .aff-hero, .aff-apply { grid-template-columns: 1fr !important; } }
        @media (max-width: 768px) { .aff-grid, .aff-benefits, .aff-steps, .aff-who { grid-template-columns: 1fr !important; } }
      `}</style>
      <Navbar />
      <div className="aff-page" style={{ minHeight: '100vh', color: '#f8fafc', padding: '78px 16px 120px', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(99,102,241,.05) 1px, transparent 1px),linear-gradient(90deg, rgba(99,102,241,.05) 1px, transparent 1px)', backgroundSize: '52px 52px', maskImage: 'radial-gradient(circle at center, black 40%, transparent 85%)', pointerEvents: 'none' }} />

        <div style={{ maxWidth: 1120, margin: '0 auto', position: 'relative', zIndex: 1 }}>
          <section className="aff-hero" style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: 20, marginBottom: 30 }}>
            <div className="aff-card" style={{ padding: 26 }}>
              <div className="aff-chip" style={{ display: 'inline-flex', marginBottom: 14 }}>AFFILIATE PROGRAM</div>
              <h1 style={{ margin: '0 0 10px', fontSize: 'clamp(32px,5vw,56px)', lineHeight: 1.05 }}>
                Earn <span style={{ background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>recurring revenue</span> by bringing traders to ChainLens AI.
              </h1>
              <p style={{ margin: '0 0 20px', color: '#94a3b8', fontSize: 16, lineHeight: 1.7 }}>
                Join the ChainLens affiliate network and get rewarded for bringing Base traders, KOLs, and onchain communities into the terminal.
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <a href="#apply" style={{ padding: '11px 16px', borderRadius: 10, textDecoration: 'none', fontWeight: 700, background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', color: '#061018' }}>Apply Now</a>
                <a href="#benefits" style={{ padding: '11px 16px', borderRadius: 10, textDecoration: 'none', fontWeight: 700, border: '1px solid rgba(148,163,184,.3)', color: '#cbd5e1', background: 'rgba(255,255,255,.03)' }}>View Commission Details</a>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {['Recurring commissions', 'Base-native product', 'Real onchain utility', 'Fast approval'].map((chip) => <span className="aff-pill" key={chip}>{chip}</span>)}
              </div>
            </div>
            <div className="aff-card" style={{ padding: 20 }}>
              <p style={{ margin: '0 0 12px', fontFamily: 'var(--font-plex-mono)', fontSize: 11, color: '#67e8f9', letterSpacing: '.14em' }}>PARTNER SNAPSHOT</p>
              <div style={{ display: 'grid', gap: 10 }}>
                {[
                  ['Partner status', 'Applications open'],
                  ['Review time', '24–72h'],
                  ['Best for', 'Base/crypto creators'],
                  ['Payouts', 'Handled after approval'],
                  ['Tracking', 'Invite/referral based'],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(148,163,184,.2)', background: 'rgba(255,255,255,.02)' }}>
                    <span style={{ color: '#94a3b8', fontSize: 12 }}>{k}</span><span style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 600, textAlign: 'right' }}>{v}</span>
                  </div>
                ))}
                <p style={{ margin: '4px 0 0', fontSize: 11, color: '#94a3b8' }}>Commission details are shared after approval.</p>
              </div>
            </div>
          </section>

          <section id="benefits" style={{ marginBottom: 30 }}>
            <div className="aff-benefits" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(4,minmax(0,1fr))' }}>
              {[
                ['Recurring Commissions', 'Earn every month while referred users stay subscribed.'],
                ['Built for Base Traders', 'Promote a product made for scanners, wallets, alerts, and Clark AI.'],
                ['Creator-Friendly Tracking', 'Track your leads, referrals, and payouts as the program grows.'],
                ['Launch Partner Access', 'Top affiliates can get early campaigns, custom codes, and priority support.'],
              ].map(([title, body]) => (
                <article key={title} className="aff-card" style={{ padding: 16 }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>{title}</h3>
                  <p style={{ margin: 0, color: '#94a3b8', fontSize: 13, lineHeight: 1.6 }}>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="aff-steps" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12, marginBottom: 30 }}>
            {[
              ['01', 'Apply', 'Tell us about your audience and how you’ll promote ChainLens.'],
              ['02', 'Get approved', 'We review fit, audience quality, and promo plan.'],
              ['03', 'Start earning', 'Share your link/code and earn from qualified paid users.'],
            ].map(([step, title, body]) => (
              <article key={step} className="aff-card" style={{ padding: 16 }}>
                <p style={{ margin: '0 0 8px', fontFamily: 'var(--font-plex-mono)', color: '#67e8f9' }}>{step}</p>
                <h3 style={{ margin: '0 0 6px' }}>{title}</h3>
                <p style={{ margin: 0, color: '#94a3b8', fontSize: 13 }}>{body}</p>
              </article>
            ))}
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
              <p style={{ margin: '0 0 16px', color: '#94a3b8' }}>Tell us where your audience lives and how you’d promote ChainLens.</p>
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

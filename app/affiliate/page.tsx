'use client'

import { useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'

export default function AffiliatePage() {
  const [form, setForm] = useState({
    name: '',
    twitter: '',
    telegram: '',
    audience: '',
    why: '',
  })
  const [submitted, setSubmitted] = useState(false)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '10px',
    padding: '13px 16px',
    fontSize: '14px',
    color: '#f8fafc',
    outline: 'none',
    fontFamily: 'var(--font-inter, Inter, sans-serif)',
    transition: 'border-color 200ms, background 200ms',
    boxSizing: 'border-box',
  }

  return (
    <>
      <style>{`
        @keyframes aff-orb-teal {
          0%,100% { transform: translate(-50%,-50%) scale(1); opacity: 0.55; }
          50%      { transform: translate(-50%,-50%) scale(1.15); opacity: 0.80; }
        }
        @keyframes aff-orb-purple {
          0%,100% { transform: translate(50%,-30%) scale(1); opacity: 0.40; }
          50%      { transform: translate(50%,-30%) scale(1.20); opacity: 0.65; }
        }
        @keyframes aff-fade-up {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes aff-badge-pulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(45,212,191,0); }
          50%      { box-shadow: 0 0 0 6px rgba(45,212,191,0.10); }
        }
        .aff-section { animation: aff-fade-up 0.55s ease-out both; }
        .aff-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 28px 24px;
          transition: border-color 280ms, background 280ms, transform 280ms;
        }
        .aff-card:hover {
          border-color: rgba(45,212,191,0.35);
          background: rgba(45,212,191,0.04);
          transform: translateY(-4px);
        }
        .aff-input:focus {
          border-color: rgba(45,212,191,0.50) !important;
          background: rgba(45,212,191,0.04) !important;
        }
        .aff-step-card {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 32px 24px;
          position: relative;
          overflow: hidden;
          transition: border-color 280ms, background 280ms;
        }
        .aff-step-card:hover {
          border-color: rgba(45,212,191,0.25);
          background: rgba(45,212,191,0.03);
        }
        .aff-btn-teal {
          display: inline-flex; align-items: center; justify-content: center;
          padding: 13px 28px; border-radius: 10px; border: none; cursor: pointer;
          background: #2DD4BF;
          color: #04101a;
          font-size: 14px; font-weight: 800;
          letter-spacing: 0.06em; text-transform: uppercase;
          text-decoration: none;
          box-shadow: 0 0 24px rgba(45,212,191,0.40);
          transition: opacity 150ms, transform 150ms, box-shadow 150ms;
          font-family: var(--font-inter, Inter, sans-serif);
          white-space: nowrap;
        }
        .aff-btn-teal:hover {
          opacity: 0.88; transform: translateY(-2px);
          box-shadow: 0 0 36px rgba(45,212,191,0.60);
        }
        .aff-btn-outline {
          display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          padding: 13px 28px; border-radius: 10px; cursor: pointer;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.14);
          color: rgba(255,255,255,0.75);
          font-size: 14px; font-weight: 600;
          text-decoration: none;
          transition: border-color 150ms, color 150ms, background 150ms;
          font-family: var(--font-inter, Inter, sans-serif);
          white-space: nowrap;
        }
        .aff-btn-outline:hover {
          border-color: rgba(45,212,191,0.45);
          color: #2DD4BF;
          background: rgba(45,212,191,0.06);
        }
        @media (max-width: 767px) {
          .aff-cards-grid { grid-template-columns: 1fr 1fr !important; }
          .aff-steps-grid { grid-template-columns: 1fr !important; }
          .aff-hero-btns  { flex-direction: column; align-items: stretch; }
        }
        @media (max-width: 480px) {
          .aff-cards-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <Navbar />

      <div style={{ minHeight: '100vh', background: '#06060a', color: '#f8fafc', position: 'relative', overflow: 'hidden' }}>

        {/* Teal orb — top left */}
        <div style={{
          position: 'fixed', top: '30%', left: '0',
          width: '700px', height: '700px',
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(45,212,191,0.08) 0%, transparent 65%)',
          filter: 'blur(80px)', pointerEvents: 'none', zIndex: 0,
          animation: 'aff-orb-teal 9s ease-in-out infinite',
          transformOrigin: 'center center',
        }} />

        {/* Purple orb — top right */}
        <div style={{
          position: 'fixed', top: '10%', right: '0',
          width: '600px', height: '600px',
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(139,92,246,0.08) 0%, transparent 65%)',
          filter: 'blur(80px)', pointerEvents: 'none', zIndex: 0,
          animation: 'aff-orb-purple 12s ease-in-out infinite',
          transformOrigin: 'center center',
        }} />

        {/* Subtle grid */}
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: `
            linear-gradient(rgba(45,212,191,0.020) 1px, transparent 1px),
            linear-gradient(90deg, rgba(45,212,191,0.020) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }} />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: '860px', margin: '0 auto', padding: '80px 24px 120px' }}>

          {/* ── HERO ─────────────────────────────────────────────────────── */}
          <section className="aff-section" style={{ textAlign: 'center', marginBottom: '96px', animationDelay: '0s' }}>

            {/* Badge */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              padding: '6px 16px', borderRadius: '999px',
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.25)',
              marginBottom: '28px',
              animation: 'aff-badge-pulse 3s ease-in-out infinite',
            }}>
              <div style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.90)',
              }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.20em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>KOL Program</span>
            </div>

            <h1 style={{
              fontSize: 'clamp(32px, 5vw, 58px)', fontWeight: 900,
              letterSpacing: '-0.03em', lineHeight: 1.08,
              color: '#f8fafc', margin: '0 0 24px',
              textShadow: '0 0 60px rgba(45,212,191,0.18)',
            }}>
              Earn{' '}
              <span style={{
                background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>20% Recurring</span>
              <br />Commission
            </h1>

            <p style={{
              fontSize: 'clamp(15px, 2vw, 18px)', lineHeight: 1.75,
              color: 'rgba(255,255,255,0.52)', margin: '0 auto 40px',
              maxWidth: '620px',
            }}>
              Partner with ChainLens AI and earn 20% on every subscription your referral brings —
              every month, for as long as they stay subscribed. Not a one-time bonus.
            </p>

            <div className="aff-hero-btns" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px', flexWrap: 'wrap' }}>
              <a href="#apply" className="aff-btn-teal">Apply Now</a>
              <Link
                href="https://t.me/chainlensaigroup"
                target="_blank" rel="noopener noreferrer"
                className="aff-btn-outline"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.17 13.947l-2.965-.924c-.643-.204-.658-.643.136-.953l11.57-4.461c.537-.194 1.006.131.983.612z"/>
                </svg>
                Contact on Telegram
              </Link>
            </div>

          </section>

          {/* Divider */}
          <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.25), rgba(139,92,246,0.15), transparent)', marginBottom: '80px' }} />

          {/* ── HOW IT WORKS ─────────────────────────────────────────────── */}
          <section className="aff-section" style={{ marginBottom: '80px', animationDelay: '0.08s' }}>

            <div style={{ marginBottom: '40px' }}>
              <div style={{
                fontSize: '9px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                marginBottom: '12px',
              }}>How It Works</div>
              <h2 style={{
                fontSize: 'clamp(22px, 3vw, 32px)', fontWeight: 800,
                letterSpacing: '-0.02em', color: '#f1f5f9', margin: 0,
              }}>Three steps to start earning</h2>
            </div>

            <div className="aff-steps-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
              {[
                {
                  step: '01',
                  title: 'Apply',
                  body: 'Fill out the form below and tell us about your audience.',
                  color: '#2DD4BF',
                },
                {
                  step: '02',
                  title: 'Get Approved',
                  body: 'We review and send you a unique referral link within 48 hours.',
                  color: '#8b5cf6',
                },
                {
                  step: '03',
                  title: 'Start Earning',
                  body: 'Share your link, earn 20% on every payment — month after month.',
                  color: '#ec4899',
                },
              ].map((s) => (
                <div key={s.step} className="aff-step-card">
                  <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                    background: `linear-gradient(90deg, ${s.color}, transparent)`,
                    borderRadius: '16px 16px 0 0',
                  }} />
                  <div style={{
                    fontSize: '28px', fontWeight: 900, letterSpacing: '-0.04em',
                    color: s.color, opacity: 0.85,
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    marginBottom: '14px',
                    textShadow: `0 0 20px ${s.color}44`,
                  }}>{s.step}</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9', marginBottom: '8px' }}>{s.title}</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.48)', lineHeight: 1.65 }}>{s.body}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ── WHAT YOU GET ─────────────────────────────────────────────── */}
          <section className="aff-section" style={{ marginBottom: '80px', animationDelay: '0.14s' }}>

            <div style={{ marginBottom: '40px' }}>
              <div style={{
                fontSize: '9px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                marginBottom: '12px',
              }}>What You Get</div>
              <h2 style={{
                fontSize: 'clamp(22px, 3vw, 32px)', fontWeight: 800,
                letterSpacing: '-0.02em', color: '#f1f5f9', margin: 0,
              }}>Everything you need to earn</h2>
            </div>

            <div className="aff-cards-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              {[
                {
                  icon: (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                    </svg>
                  ),
                  title: 'Unique Referral Link',
                  body: 'Your own personal tracking link that works across all platforms and content.',
                  accent: '#2DD4BF',
                },
                {
                  icon: (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                    </svg>
                  ),
                  title: '20% Recurring Commission',
                  body: 'Every month, not just the first payment. Passive income that compounds as your referrals grow.',
                  accent: '#8b5cf6',
                },
                {
                  icon: (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                    </svg>
                  ),
                  title: 'Crypto Payouts',
                  body: 'Paid in USDC on Base. No wire transfers, no delays — on-chain, every month.',
                  accent: '#2DD4BF',
                },
                {
                  icon: (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
                    </svg>
                  ),
                  title: 'No Earnings Cap',
                  body: 'No limits, no ceiling. The more you refer, the more you earn — indefinitely.',
                  accent: '#ec4899',
                },
              ].map((c, i) => (
                <div key={i} className="aff-card">
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '12px',
                    background: `rgba(${c.accent === '#2DD4BF' ? '45,212,191' : c.accent === '#8b5cf6' ? '139,92,246' : '236,72,153'},0.10)`,
                    border: `1px solid rgba(${c.accent === '#2DD4BF' ? '45,212,191' : c.accent === '#8b5cf6' ? '139,92,246' : '236,72,153'},0.20)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: '16px',
                  }}>
                    {c.icon}
                  </div>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', marginBottom: '8px' }}>{c.title}</div>
                  <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.48)', lineHeight: 1.65 }}>{c.body}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ── WHO WE'RE LOOKING FOR ────────────────────────────────────── */}
          <section className="aff-section" style={{ marginBottom: '80px', animationDelay: '0.20s' }}>

            <div style={{ marginBottom: '36px' }}>
              <div style={{
                fontSize: '9px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                marginBottom: '12px',
              }}>Who We&apos;re Looking For</div>
              <h2 style={{
                fontSize: 'clamp(22px, 3vw, 32px)', fontWeight: 800,
                letterSpacing: '-0.02em', color: '#f1f5f9', margin: 0,
              }}>Built for Base ecosystem voices</h2>
            </div>

            <div style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: '16px',
              padding: '32px',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                {[
                  'Base ecosystem KOLs and influencers',
                  'Crypto content creators on X, YouTube, or TikTok',
                  'DeFi traders with engaged audiences',
                  'Builders and developers in the onchain space',
                ].map((item, i, arr) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: '14px',
                    padding: '16px 0',
                    borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  }}>
                    <div style={{
                      width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
                      background: 'rgba(45,212,191,0.12)',
                      border: '1px solid rgba(45,212,191,0.30)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <svg width="10" height="8" viewBox="0 0 12 10" fill="none">
                        <path d="M1 5l3.5 3.5L11 1" stroke="#2DD4BF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    <span style={{ fontSize: '15px', color: 'rgba(255,255,255,0.72)', fontWeight: 500 }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Divider */}
          <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.25), rgba(139,92,246,0.15), transparent)', marginBottom: '80px' }} />

          {/* ── APPLICATION FORM ─────────────────────────────────────────── */}
          <section id="apply" className="aff-section" style={{ animationDelay: '0.26s' }}>

            <div style={{ marginBottom: '40px' }}>
              <div style={{
                fontSize: '9px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                marginBottom: '12px',
              }}>Apply Now</div>
              <h2 style={{
                fontSize: 'clamp(22px, 3vw, 32px)', fontWeight: 800,
                letterSpacing: '-0.02em', color: '#f1f5f9', margin: '0 0 10px',
              }}>Join the program</h2>
              <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.42)', margin: 0 }}>
                We review all applications and respond within 48 hours.
              </p>
            </div>

            {submitted ? (
              <div style={{
                background: 'rgba(45,212,191,0.06)',
                border: '1px solid rgba(45,212,191,0.30)',
                borderRadius: '16px',
                padding: '48px 32px',
                textAlign: 'center',
              }}>
                <div style={{
                  width: '52px', height: '52px', borderRadius: '50%',
                  background: 'rgba(45,212,191,0.12)',
                  border: '1px solid rgba(45,212,191,0.35)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 20px',
                }}>
                  <svg width="22" height="18" viewBox="0 0 24 20" fill="none">
                    <path d="M2 10l7 7L22 2" stroke="#2DD4BF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#f1f5f9', marginBottom: '10px' }}>Application Received</div>
                <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.50)', maxWidth: '380px', margin: '0 auto' }}>
                  Thanks for applying. We&apos;ll review your application and get back to you within 48 hours via Telegram.
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '20px',
                padding: '40px',
                display: 'flex', flexDirection: 'column', gap: '20px',
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>
                      Name
                    </label>
                    <input
                      className="aff-input"
                      style={inputStyle}
                      type="text"
                      placeholder="Your name"
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>
                      Twitter / X Handle
                    </label>
                    <input
                      className="aff-input"
                      style={inputStyle}
                      type="text"
                      placeholder="@handle"
                      value={form.twitter}
                      onChange={e => setForm(f => ({ ...f, twitter: e.target.value }))}
                      required
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>
                      Telegram Handle
                    </label>
                    <input
                      className="aff-input"
                      style={inputStyle}
                      type="text"
                      placeholder="@handle"
                      value={form.telegram}
                      onChange={e => setForm(f => ({ ...f, telegram: e.target.value }))}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>
                      Audience Size
                    </label>
                    <select
                      className="aff-input"
                      style={{ ...inputStyle, cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none' }}
                      value={form.audience}
                      onChange={e => setForm(f => ({ ...f, audience: e.target.value }))}
                      required
                    >
                      <option value="" disabled>Select range</option>
                      <option value="under-1k">Under 1,000</option>
                      <option value="1k-10k">1,000 – 10,000</option>
                      <option value="10k-50k">10,000 – 50,000</option>
                      <option value="50k+">50,000+</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.38)', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginBottom: '8px' }}>
                    Why do you want to partner with ChainLens AI?
                  </label>
                  <textarea
                    className="aff-input"
                    style={{ ...inputStyle, minHeight: '120px', resize: 'vertical' }}
                    placeholder="Tell us about your audience and how you plan to promote ChainLens AI..."
                    value={form.why}
                    onChange={e => setForm(f => ({ ...f, why: e.target.value }))}
                    required
                  />
                </div>

                <div style={{ paddingTop: '4px' }}>
                  <button type="submit" className="aff-btn-teal" style={{ width: '100%', fontSize: '13px' }}>
                    Submit Application
                  </button>
                </div>
              </form>
            )}

          </section>

          {/* Back link */}
          <div style={{ marginTop: '64px', paddingTop: '32px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <Link href="/" style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.35)',
              textDecoration: 'none', transition: 'color 150ms',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = '#2DD4BF' }}
              onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.35)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
              Back to ChainLens AI
            </Link>
          </div>

        </div>
      </div>
    </>
  )
}

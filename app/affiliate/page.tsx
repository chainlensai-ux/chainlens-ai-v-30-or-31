'use client'

import { useState } from 'react'
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
  name: '',
  email: '',
  telegram: '',
  x_handle: '',
  audience_size: '',
  audience_type: '',
  promotion_plan: '',
  wallet_address: '',
  website: '',
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
      if (!res.ok) {
        setError(json?.error || 'Couldn’t submit right now. Try again.')
      } else {
        setSuccess('Application sent. We’ll review it and reach out.')
        setForm(initialForm)
      }
    } catch {
      setError('Couldn’t submit right now. Try again.')
    } finally {
      setLoading(false)
    }
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0',
    border: '1px solid rgba(148,163,184,0.22)', borderRadius: 12, padding: '12px 14px',
    fontSize: 14, outline: 'none', fontFamily: 'var(--font-inter, Inter, sans-serif)',
  }

  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .affiliate-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
      <Navbar />
      <div style={{ minHeight: '100vh', background: '#05070d', padding: '80px 16px 120px', color: '#f8fafc' }}>
        <div style={{ maxWidth: 840, margin: '0 auto' }}>
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', border: '1px solid rgba(45,212,191,.35)', background: 'rgba(45,212,191,.08)', borderRadius: 999, padding: '4px 12px', fontSize: 11, letterSpacing: '.15em', color: '#2dd4bf', fontFamily: 'var(--font-plex-mono)' }}>AFFILIATE PROGRAM</div>
            <h1 style={{ margin: '14px 0 8px', fontSize: 'clamp(30px,6vw,48px)', lineHeight: 1.1 }}>Partner with <span style={{ color: '#8b5cf6' }}>ChainLens AI</span></h1>
            <p style={{ margin: 0, color: '#94a3b8' }}>Apply to join our affiliate network and earn recurring commissions.</p>
          </div>

          <form onSubmit={onSubmit} style={{ background: 'linear-gradient(180deg, rgba(15,23,42,.72), rgba(9,12,20,.86))', border: '1px solid rgba(148,163,184,.2)', borderRadius: 18, padding: 22, boxShadow: '0 0 48px rgba(45,212,191,.08)' }}>
            <input type="text" name="website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: '-9999px', opacity: 0, height: 0, width: 0 }} />
            <div className="affiliate-grid" style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(2,minmax(0,1fr))' }}>
              {[
                ['Name', 'name'],
                ['Email', 'email'],
                ['Telegram', 'telegram'],
                ['X handle', 'x_handle'],
                ['Audience size', 'audience_size'],
                ['Audience type / niche', 'audience_type'],
                ['Wallet address for payouts', 'wallet_address'],
              ].map(([label, key]) => (
                <label key={key} style={{ display: 'grid', gap: 6, color: '#cbd5e1', fontSize: 12, fontFamily: 'var(--font-plex-mono)' }}>
                  {label}
                  <input
                    required={key === 'name' || key === 'email'}
                    type={key === 'email' ? 'email' : 'text'}
                    value={form[key as keyof FormState]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
              ))}
              <label style={{ display: 'grid', gap: 6, color: '#cbd5e1', fontSize: 12, gridColumn: '1 / -1', fontFamily: 'var(--font-plex-mono)' }}>
                How would you promote ChainLens?
                <textarea
                  value={form.promotion_plan}
                  onChange={(e) => setForm({ ...form, promotion_plan: e.target.value })}
                  rows={4}
                  style={{ ...fieldStyle, resize: 'vertical' }}
                />
              </label>
            </div>

            {success && <p style={{ marginTop: 14, color: '#2dd4bf', fontSize: 13 }}>{success}</p>}
            {error && <p style={{ marginTop: 14, color: '#fca5a5', fontSize: 13 }}>{error}</p>}

            <button type="submit" disabled={loading} style={{ marginTop: 16, padding: '12px 18px', border: 0, borderRadius: 10, fontWeight: 700, letterSpacing: '.08em', background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', color: '#05070d', cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Submitting…' : 'Apply for Affiliate'}
            </button>
          </form>
        </div>
      </div>
    </>
  )
}

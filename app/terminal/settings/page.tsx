'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

// ─── Helpers ──────────────────────────────────────────────────────────────

function Card({ children, danger = false }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div style={{
      background: '#080c14',
      border: `1px solid ${danger ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: '14px',
      padding: '24px',
    }}>
      {children}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em',
      textTransform: 'uppercase', color: 'rgba(45,212,191,0.70)',
      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
      marginBottom: '20px',
      display: 'flex', alignItems: 'center', gap: '8px',
    }}>
      <span style={{ display: 'inline-block', width: '14px', height: '1.5px', background: 'linear-gradient(90deg,#2DD4BF,#8b5cf6)' }} />
      {children}
    </h2>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: 'rgba(255,255,255,0.40)',
      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
      display: 'block', marginBottom: '7px',
    }}>
      {children}
    </span>
  )
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', padding: '9px 13px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.09)',
        borderRadius: '9px', color: '#e2e8f0',
        fontSize: '13px', fontFamily: 'var(--font-inter, Inter, sans-serif)',
        outline: 'none', boxSizing: 'border-box',
        transition: 'border-color 0.15s',
      }}
      onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.40)' }}
      onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)' }}
    />
  )
}

function Toggle({ on, onChange, color = '#2DD4BF' }: { on: boolean; onChange: () => void; color?: string }) {
  return (
    <button
      onClick={onChange}
      style={{
        width: '40px', height: '22px', borderRadius: '999px',
        background: on ? color : 'rgba(255,255,255,0.12)',
        border: 'none', cursor: 'pointer', position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
        boxShadow: on ? `0 0 10px ${color}55` : 'none',
      }}
    >
      <span style={{
        position: 'absolute', top: '3px',
        left: on ? '21px' : '3px',
        width: '16px', height: '16px', borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.2s',
        boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
      }} />
    </button>
  )
}

function Row({ label, sub, right }: { label: string; sub?: string; right: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <div>
        <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.80)', fontFamily: 'var(--font-inter, Inter, sans-serif)', fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-inter, Inter, sans-serif)', marginTop: '2px' }}>{sub}</div>}
      </div>
      {right}
    </div>
  )
}

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '3px 10px', borderRadius: '999px',
      background: connected ? 'rgba(45,212,191,0.10)' : 'rgba(255,255,255,0.06)',
      border: `1px solid ${connected ? 'rgba(45,212,191,0.25)' : 'rgba(255,255,255,0.10)'}`,
      fontSize: '10px', fontWeight: 600, letterSpacing: '0.10em',
      color: connected ? '#2DD4BF' : 'rgba(255,255,255,0.35)',
      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
    }}>
      <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: connected ? '#2DD4BF' : 'rgba(255,255,255,0.25)', boxShadow: connected ? '0 0 6px #2DD4BF' : 'none' }} />
      {connected ? 'CONNECTED' : 'NOT CONNECTED'}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter()
  const [displayName, setDisplayName] = useState('')
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  const [darkMode, setDarkMode] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user?.email ?? null)
    })
  }, [])

  const [notifWhale, setNotifWhale]   = useState(true)
  const [notifPump, setNotifPump]     = useState(true)
  const [notifRadar, setNotifRadar]   = useState(false)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  async function handleSignOut() {
    setSigningOut(true)
    await supabase.auth.signOut()
    router.replace('/')
  }

  const APIS = [
    { name: 'GeckoTerminal',  sub: 'Token & pool data',         connected: true  },
    { name: 'Base RPC',       sub: 'On-chain reads',            connected: true  },
    { name: 'CORTEX Engine',  sub: 'AI risk scoring',           connected: true  },
    { name: 'Whale Tracker',  sub: 'Smart money detection',     connected: false },
    { name: 'Clark AI',       sub: 'Conversational intelligence', connected: true },
  ]

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#06060a', color: '#e2e8f0' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '40px 32px 80px' }}>

        {/* Back button */}
        <Link href="/terminal" style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          color: 'rgba(255,255,255,0.35)', fontSize: '12px', fontWeight: 500,
          textDecoration: 'none', marginBottom: '24px',
          fontFamily: 'var(--font-inter, Inter, sans-serif)',
          transition: 'color 0.15s',
        }}
          onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.75)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.35)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </Link>

        {/* Page header */}
        <div style={{ marginBottom: '36px' }}>
          <h1 style={{
            fontSize: '22px', fontWeight: 800, letterSpacing: '-0.01em',
            color: '#f1f5f9', margin: '0 0 6px',
            fontFamily: 'var(--font-inter, Inter, sans-serif)',
          }}>Settings</h1>
          <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.35)', margin: 0, fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
            Manage your account, preferences, and integrations.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* ── Account ─────────────────────────────────── */}
          <Card>
            <SectionTitle>Account</SectionTitle>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px', marginBottom: '24px' }}>
              {/* Avatar placeholder */}
              <div style={{
                width: '64px', height: '64px', borderRadius: '50%', flexShrink: 0,
                background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '22px', fontWeight: 800, color: '#04101a',
                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                boxShadow: '0 0 20px rgba(45,212,191,0.25)',
                cursor: 'pointer',
                border: '2px solid rgba(45,212,191,0.20)',
              }}>
                {(displayName || userEmail || 'U')[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginBottom: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.06em' }}>
                  Click avatar to upload photo
                </div>
                <button style={{
                  padding: '5px 14px', borderRadius: '7px',
                  background: 'rgba(45,212,191,0.08)',
                  border: '1px solid rgba(45,212,191,0.20)',
                  color: '#2DD4BF', fontSize: '11px', fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                  letterSpacing: '0.05em',
                }}>Change Avatar</button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <Label>Display Name</Label>
                <Input value={displayName} onChange={setDisplayName} placeholder="Enter display name" />
              </div>
              <div>
                <Label>Email Address</Label>
                <div style={{
                  width: '100%', padding: '9px 13px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '9px', color: 'rgba(255,255,255,0.45)',
                  fontSize: '13px', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                  boxSizing: 'border-box',
                  userSelect: 'none',
                }}>
                  {userEmail ?? '—'}
                </div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '5px', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                  Email is managed by your sign-in provider.
                </div>
              </div>
            </div>

            <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button style={{
                padding: '9px 22px', borderRadius: '9px',
                background: 'rgba(45,212,191,0.12)',
                border: '1px solid rgba(45,212,191,0.25)',
                color: '#2DD4BF', fontSize: '12px', fontWeight: 700,
                cursor: 'pointer', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                letterSpacing: '0.08em', textTransform: 'uppercase',
                transition: 'background 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(45,212,191,0.20)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(45,212,191,0.12)' }}
              >Save Changes</button>

              <button
                onClick={handleSignOut}
                disabled={signingOut}
                style={{
                  padding: '9px 22px', borderRadius: '9px',
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: signingOut ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.55)',
                  fontSize: '12px', fontWeight: 600,
                  cursor: signingOut ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--font-inter, Inter, sans-serif)',
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  transition: 'border-color 0.15s, color 0.15s',
                  display: 'flex', alignItems: 'center', gap: '7px',
                }}
                onMouseEnter={e => { if (!signingOut) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.28)'; e.currentTarget.style.color = 'rgba(255,255,255,0.80)' } }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = signingOut ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.55)' }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {signingOut ? 'Signing out…' : 'Sign Out'}
              </button>
            </div>
          </Card>

          {/* ── Appearance ──────────────────────────────── */}
          <Card>
            <SectionTitle>Appearance</SectionTitle>
            <Row
              label="Dark Mode"
              sub="Always-on dark theme optimised for on-chain data"
              right={<Toggle on={darkMode} onChange={() => setDarkMode(v => !v)} />}
            />
            <div style={{ paddingTop: '4px' }} />
          </Card>

          {/* ── Notifications ───────────────────────────── */}
          <Card>
            <SectionTitle>Notifications</SectionTitle>
            <Row
              label="Whale Alerts"
              sub="Get notified when large wallets make moves"
              right={<Toggle on={notifWhale} onChange={() => setNotifWhale(v => !v)} />}
            />
            <Row
              label="Pump Alerts"
              sub="Detect unusual price and volume spikes"
              right={<Toggle on={notifPump} onChange={() => setNotifPump(v => !v)} />}
            />
            <Row
              label="Base Radar"
              sub="New token deployments and liquidity events"
              right={<Toggle on={notifRadar} onChange={() => setNotifRadar(v => !v)} />}
            />
            <div style={{ paddingTop: '4px' }} />
          </Card>

          {/* ── API ─────────────────────────────────────── */}
          <Card>
            <SectionTitle>API Connections</SectionTitle>
            {APIS.map((api, i) => (
              <Row
                key={api.name}
                label={api.name}
                sub={api.sub}
                right={<StatusBadge connected={api.connected} />}
              />
            ))}
            <div style={{ paddingTop: '4px' }} />
          </Card>

          {/* ── Danger Zone ─────────────────────────────── */}
          <Card danger>
            <SectionTitle>Danger Zone</SectionTitle>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
              <div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', fontFamily: 'var(--font-inter, Inter, sans-serif)', fontWeight: 500, marginBottom: '4px' }}>
                  Delete Account
                </div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
                  Permanently delete your account and all data. This cannot be undone.
                </div>
              </div>

              {!showDeleteConfirm ? (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  style={{
                    padding: '8px 18px', borderRadius: '9px', flexShrink: 0,
                    background: 'rgba(239,68,68,0.10)',
                    border: '1px solid rgba(239,68,68,0.30)',
                    color: '#ef4444', fontSize: '12px', fontWeight: 700,
                    cursor: 'pointer', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'rgba(239,68,68,0.18)'
                    e.currentTarget.style.borderColor = 'rgba(239,68,68,0.55)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'rgba(239,68,68,0.10)'
                    e.currentTarget.style.borderColor = 'rgba(239,68,68,0.30)'
                  }}
                >
                  Delete Account
                </button>
              ) : (
                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    style={{
                      padding: '8px 16px', borderRadius: '9px',
                      background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
                      color: 'rgba(255,255,255,0.50)', fontSize: '11px', fontWeight: 600,
                      cursor: 'pointer', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    }}
                  >Cancel</button>
                  <button
                    style={{
                      padding: '8px 16px', borderRadius: '9px',
                      background: '#ef4444', border: 'none',
                      color: '#fff', fontSize: '11px', fontWeight: 700,
                      cursor: 'pointer', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                      letterSpacing: '0.05em',
                    }}
                  >Confirm Delete</button>
                </div>
              )}
            </div>
          </Card>

        </div>
      </div>
    </div>
  )
}

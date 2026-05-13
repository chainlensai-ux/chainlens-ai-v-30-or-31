'use client'

import { useState, useEffect, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import type { UserSettingsUpdate } from '@/lib/supabase/userSettings'

const AVATAR_COLORS: Record<string, string> = {
  mint: 'linear-gradient(135deg, #2DD4BF 0%, #14b8a6 100%)',
  purple: 'linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%)',
  pink: 'linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)',
  blue: 'linear-gradient(135deg, #38bdf8 0%, #3b82f6 100%)',
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function Card({ children, danger = false }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div style={{
      background: 'var(--cl-card-bg)',
      border: `1px solid ${danger ? 'var(--cl-danger-border)' : 'var(--cl-card-border)'}`,
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
  const LOCAL_SETTINGS_KEY = 'chainlens_local_settings'
  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [avatarColor, setAvatarColor] = useState<'mint' | 'purple' | 'pink' | 'blue'>('mint')
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isAuthed, setIsAuthed] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveMessage, setSaveMessage] = useState<string>('')

  const [defaultChain, setDefaultChain] = useState<'base' | 'ethereum'>('base')
  const [clarkDetailLevel, setClarkDetailLevel] = useState<'concise' | 'normal' | 'detailed'>('normal')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const session = data.session
      setUserEmail(session?.user?.email ?? null)
      setAccessToken(session?.access_token ?? null)
      setIsAuthed(Boolean(session?.user))
      setAuthChecked(true)
    })
  }, [])

  const [notifWhale, setNotifWhale]   = useState(true)
  const [notifPump, setNotifPump]     = useState(true)
  const [notifRadar, setNotifRadar]   = useState(false)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [savedFiltersCount, setSavedFiltersCount] = useState(0)
  const [selectedTerminalTool, setSelectedTerminalTool] = useState<string | null>(null)
  const [onboardingCount, setOnboardingCount] = useState(0)

  function buildPayload(): UserSettingsUpdate {
    return {
      theme: 'dark',
      accent_color: 'mint',
      default_chain: defaultChain,
      clark_detail_level: clarkDetailLevel === 'concise' ? 'low' : clarkDetailLevel === 'detailed' ? 'high' : 'normal',
      display_name: displayName.trim() || null,
      avatar_url: avatarUrl.trim() || null,
      avatar_color: avatarColor,
      saved_layout: {
        selected_terminal_tool: 'settings',
      },
      saved_filters: {
        whale_alerts: notifWhale,
        pump_alerts: notifPump,
        base_radar_alerts: notifRadar,
      },
      onboarding_progress: {},
    }
  }

  function hydrateFromSettings(settings: Record<string, unknown>) {
    const chain = settings.default_chain
    if (chain === 'base' || chain === 'ethereum') {
      setDefaultChain(chain)
    }

    const detail = settings.clark_detail_level ?? settings.clarkDetailLevel
    if (detail === 'low' || detail === 'concise') setClarkDetailLevel('concise')
    if (detail === 'normal') setClarkDetailLevel('normal')
    if (detail === 'high' || detail === 'detailed') setClarkDetailLevel('detailed')

    if (typeof settings.display_name === 'string') setDisplayName(settings.display_name)
    if (typeof settings.avatar_url === 'string') setAvatarUrl(settings.avatar_url)
    if (settings.avatar_color === 'mint' || settings.avatar_color === 'purple' || settings.avatar_color === 'pink' || settings.avatar_color === 'blue') {
      setAvatarColor(settings.avatar_color)
    }

    const filters = settings.saved_filters
    if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
      const safeFilters = filters as Record<string, unknown>
      if (typeof safeFilters.whale_alerts === 'boolean') setNotifWhale(safeFilters.whale_alerts)
      if (typeof safeFilters.pump_alerts === 'boolean') setNotifPump(safeFilters.pump_alerts)
      if (typeof safeFilters.base_radar_alerts === 'boolean') setNotifRadar(safeFilters.base_radar_alerts)
      setSavedFiltersCount(Object.keys(safeFilters).length)
    } else {
      setSavedFiltersCount(0)
    }

    const layout = settings.saved_layout
    if (layout && typeof layout === 'object' && !Array.isArray(layout)) {
      const tool = (layout as Record<string, unknown>).selected_terminal_tool
      setSelectedTerminalTool(typeof tool === 'string' ? tool : null)
    } else {
      setSelectedTerminalTool(null)
    }

    const onboarding = settings.onboarding_progress
    if (onboarding && typeof onboarding === 'object' && !Array.isArray(onboarding)) {
      setOnboardingCount(Object.keys(onboarding as Record<string, unknown>).length)
    } else {
      setOnboardingCount(0)
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!authChecked) return

    if (!isAuthed || !accessToken) {
      const localRaw = window.localStorage.getItem(LOCAL_SETTINGS_KEY)
      if (localRaw) {
        try {
          const localSettings = JSON.parse(localRaw) as Record<string, unknown>
          queueMicrotask(() => hydrateFromSettings(localSettings))
        } catch {
          // Keep safe defaults when local settings are invalid.
        }
      }
      return
    }

    let canceled = false
    const loadRemote = async () => {
      try {
        const res = await fetch('/api/user-settings', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        })

        if (!res.ok) throw new Error('Failed to load settings')
        const data = await res.json() as { settings?: Record<string, unknown>; error?: string }
        if (canceled) return

        if (data.settings) {
          hydrateFromSettings(data.settings)
          setSaveMessage(data.error ? 'Loaded defaults (settings fetch had an issue).' : 'Loaded saved account settings.')
        }
      } catch {
        if (!canceled) setSaveMessage('Could not load account settings. Using local defaults.')
      }
    }

    loadRemote()
    return () => { canceled = true }
  }, [authChecked, isAuthed, accessToken])

  useEffect(() => {
    if (!authChecked) return
    const timer = window.setTimeout(() => {
      void handleSaveSettings()
    }, 450)

    return () => window.clearTimeout(timer)
    // Only appearance settings auto-save here to avoid noisy writes.
  }, [authChecked, defaultChain, clarkDetailLevel])

  async function handleSignOut() {
    setSigningOut(true)
    await supabase.auth.signOut()
    router.replace('/')
  }

  async function handleSaveSettings() {
    const payload = buildPayload()
    setSavingState('saving')
    setSaveMessage('Saving...')

    if (!isAuthed || !accessToken) {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify({ ...payload, defaultChain, clarkDetailLevel }))
      }
      setSavingState('saved')
      setSaveMessage('Saved locally.')
      return
    }

    try {
      const res = await fetch('/api/user-settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) throw new Error('Save failed')
      setSavingState('saved')
      setSaveMessage('Settings saved.')
    } catch {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify({ ...payload, defaultChain, clarkDetailLevel }))
      }
      setSavingState('saved')
      setSaveMessage('Saved locally.')
    }
  }

  async function handleSaveProfile() {
    setSavingState('saving')
    setSaveMessage('Saving profile...')

    const profilePayload: UserSettingsUpdate = {
      display_name: displayName.trim() || null,
      avatar_url: avatarUrl.trim() || null,
      avatar_color: avatarColor,
    }

    if (!isAuthed || !accessToken) {
      setSavingState('error')
      setSaveMessage('Sign in to save your profile and settings.')
      return
    }

    try {
      const res = await fetch('/api/user-settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(profilePayload),
      })

      if (!res.ok) throw new Error('Profile save failed')
      setSavingState('saved')
      setSaveMessage('Profile saved to your account.')
    } catch {
      setSavingState('error')
      setSaveMessage('Failed to save profile.')
    }
  }

  const APIS = [
    { name: 'GeckoTerminal',  sub: 'Token & pool data',         connected: true  },
    { name: 'Base RPC',       sub: 'On-chain reads',            connected: true  },
    { name: 'CORTEX Engine',  sub: 'AI risk scoring',           connected: true  },
    { name: 'Whale Tracker',  sub: 'Smart money detection',     connected: false },
    { name: 'Clark AI',       sub: 'Conversational intelligence', connected: true },
  ]

  return (
    <div style={({ height: '100%', overflowY: 'auto', background: '#06060a', color: '#e2e8f0', transition: 'background 0.2s ease, color 0.2s ease', ['--cl-card-bg' as string]: '#080c14', ['--cl-card-border' as string]: 'rgba(255,255,255,0.08)', ['--cl-danger-border' as string]: 'rgba(239,68,68,0.25)' } as CSSProperties)} >
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '40px 32px 80px' }}>

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
          {authChecked && (
            <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', margin: '8px 0 0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
              {isAuthed ? 'Signed in: changes persist to your ChainLens account.' : 'Sign in to save settings to your account. Logged-out changes are local only.'}
            </p>
          )}
          {saveMessage && (
            <p style={{ fontSize: '11px', margin: '6px 0 0', color: savingState === 'error' ? '#fca5a5' : 'rgba(45,212,191,0.80)', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
              {saveMessage}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* ── Account ─────────────────────────────────── */}
          <Card>
            <SectionTitle>Account</SectionTitle>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '20px', marginBottom: '24px' }}>
              {/* Avatar preview */}
              <div style={{
                width: '64px', height: '64px', borderRadius: '50%', flexShrink: 0,
                background: avatarUrl ? '#0f172a' : AVATAR_COLORS[avatarColor],
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '22px', fontWeight: 800, color: '#04101a',
                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                boxShadow: '0 0 20px rgba(45,212,191,0.25)',
                border: '2px solid rgba(45,212,191,0.20)',
                overflow: 'hidden',
              }}>
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="Avatar preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span>{(displayName || userEmail || 'U')[0].toUpperCase()}</span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.35)', marginBottom: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', letterSpacing: '0.06em' }}>
                  {isAuthed ? 'Signed in account profile' : 'Guest mode profile preview'}
                </div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.50)' }}>
                  Signed in as: {userEmail ?? 'Guest'}
                </div>
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
              <div>
                <Label>Avatar URL</Label>
                <Input value={avatarUrl} onChange={setAvatarUrl} placeholder="https://..." />
              </div>
              <div>
                <Label>Avatar Color</Label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {(['mint', 'purple', 'pink', 'blue'] as const).map(color => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setAvatarColor(color)}
                      style={{
                        width: '26px',
                        height: '26px',
                        borderRadius: '50%',
                        border: avatarColor === color ? '2px solid rgba(255,255,255,0.8)' : '1px solid rgba(255,255,255,0.20)',
                        background: AVATAR_COLORS[color],
                        cursor: 'pointer',
                      }}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button
                onClick={handleSaveProfile}
                style={{
                  padding: '9px 22px', borderRadius: '9px',
                  background: 'rgba(139,92,246,0.14)',
                  border: '1px solid rgba(139,92,246,0.30)',
                  color: '#c4b5fd', fontSize: '12px', fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'var(--font-inter, Inter, sans-serif)',
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}
              >
                Save Profile
              </button>
              <button
                onClick={handleSaveSettings}
                style={{
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
              >
                {savingState === 'saving' ? 'Saving…' : savingState === 'saved' ? 'Saved' : 'Save Changes'}
              </button>

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
            {!isAuthed && (
              <div style={{ marginTop: '10px', fontSize: '12px', color: 'rgba(255,255,255,0.48)' }}>
                Sign in to save your profile and settings.
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle>Saved Progress</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)' }}>Account status</div>
              <div style={{ fontSize: '12px', textAlign: 'right', color: isAuthed ? '#5eead4' : 'rgba(255,255,255,0.45)' }}>{isAuthed ? 'Signed in' : 'Guest'}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)' }}>Settings sync</div>
              <div style={{ fontSize: '12px', textAlign: 'right', color: isAuthed ? '#5eead4' : 'rgba(255,255,255,0.45)' }}>{isAuthed ? 'Enabled' : 'Local only'}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)' }}>Clark detail level</div>
              <div style={{ fontSize: '12px', textAlign: 'right' }}>{clarkDetailLevel}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)' }}>Default chain</div>
              <div style={{ fontSize: '12px', textAlign: 'right' }}>{defaultChain}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)' }}>Saved filters count</div>
              <div style={{ fontSize: '12px', textAlign: 'right' }}>{savedFiltersCount}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)' }}>Selected terminal tool</div>
              <div style={{ fontSize: '12px', textAlign: 'right' }}>{selectedTerminalTool ?? 'Not set'}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.72)' }}>Onboarding progress</div>
              <div style={{ fontSize: '12px', textAlign: 'right' }}>{onboardingCount > 0 ? `${onboardingCount} item(s)` : 'No saved progression yet.'}</div>
            </div>
          </Card>

          {/* ── Appearance ──────────────────────────────── */}
          <Card>
            <SectionTitle>Appearance</SectionTitle>
            <Row
              label="Default Chain"
              sub="Used as your account default for scanner context"
              right={(
                <select
                  value={defaultChain}
                  onChange={e => setDefaultChain(e.target.value as 'base' | 'ethereum')}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: '#e2e8f0',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    padding: '5px 8px',
                    fontSize: '12px',
                  }}
                >
                  <option value="base">Base</option>
                  <option value="ethereum">Ethereum</option>
                                  </select>
              )}
            />
            <Row
              label="Clark Detail Level"
              sub="How verbose Clark responses should be by default"
              right={(
                <select
                  value={clarkDetailLevel}
                  onChange={e => setClarkDetailLevel(e.target.value as 'concise' | 'normal' | 'detailed')}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: '#e2e8f0',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '8px',
                    padding: '5px 8px',
                    fontSize: '12px',
                  }}
                >
                  <option value="concise">Concise</option>
                  <option value="normal">Normal</option>
                  <option value="detailed">Detailed</option>
                </select>
              )}
            />
            <div style={{ paddingTop: '8px', fontSize: '11px', color: 'rgba(148,163,184,0.8)' }}>Base remains the primary live scan network during beta.</div>
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
            <div style={{ paddingTop: '8px', fontSize: '11px', color: 'rgba(148,163,184,0.8)' }}>Base remains the primary live scan network during beta.</div>
          </Card>

          {/* ── API ─────────────────────────────────────── */}
          <Card>
            <SectionTitle>API Connections</SectionTitle>
            {APIS.map((api) => (
              <Row
                key={api.name}
                label={api.name}
                sub={api.sub}
                right={<StatusBadge connected={api.connected} />}
              />
            ))}
            <div style={{ paddingTop: '8px', fontSize: '11px', color: 'rgba(148,163,184,0.8)' }}>Base remains the primary live scan network during beta.</div>
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

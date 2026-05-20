'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { canAccessFeature, type UserPlan } from '@/lib/planFeatures'

export { canAccessFeature }
const PLAN_CACHE_KEY = 'chainlens_cached_plan'
const PLAN_CACHE_MAX_AGE_MS = 1000 * 60 * 30
type CachedPlan = { plan: UserPlan; updatedAt: number; userId?: string | null; email?: string | null }

function resolvePlan(json: Record<string, unknown>): UserPlan {
  const p = json?.plan ?? json?.effectivePlan ?? (json?.settings as Record<string, unknown>)?.plan
  return p === 'pro' || p === 'elite' ? p : 'free'
}

export function usePlan(): UserPlan {
  const [plan, setPlan] = useState<UserPlan>('free')
  useEffect(() => {
    async function load(token: string | undefined) {
      if (!token) { setPlan('free'); return }
      try {
        const res = await fetch('/api/user-settings', { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const json = await res.json()
          setPlan(resolvePlan(json))
        }
      } catch { setPlan('free') }
    }
    supabase.auth.getSession().then(({ data }) => load(data.session?.access_token))
    const { data: l } = supabase.auth.onAuthStateChange((_e, session) => load(session?.access_token))
    return () => l.subscription.unsubscribe()
  }, [])
  return plan
}

/** Like usePlan but exposes loading state so pages can suppress the locked
 *  panel flash while the session/plan are still resolving. */
export function usePlanWithLoading(): { plan: UserPlan; loading: boolean; error: string | null; betaEliteActive: boolean } {
  const [plan, setPlan] = useState<UserPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [resolved, setResolved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [betaEliteActive, setBetaEliteActive] = useState(false)
  useEffect(() => {
    function readCachedPlan(userId?: string | null, email?: string | null): UserPlan | null {
      try {
        const raw = window.localStorage.getItem(PLAN_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as CachedPlan
        if (!parsed || (parsed.plan !== 'free' && parsed.plan !== 'pro' && parsed.plan !== 'elite')) return null
        if (Date.now() - Number(parsed.updatedAt ?? 0) > PLAN_CACHE_MAX_AGE_MS) return null
        if ((userId && parsed.userId && parsed.userId !== userId) || (email && parsed.email && parsed.email !== email)) return null
        return parsed.plan
      } catch { return null }
    }
    function writeCachedPlan(nextPlan: UserPlan, userId?: string | null, email?: string | null) {
      try { window.localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify({ plan: nextPlan, updatedAt: Date.now(), userId: userId ?? null, email: email ?? null } satisfies CachedPlan)) } catch {}
    }
    function clearCache() { try { window.localStorage.removeItem(PLAN_CACHE_KEY) } catch {} }
    async function load(session: { access_token?: string; user?: { id?: string; email?: string | null } } | null | undefined) {
      const token = session?.access_token
      const userId = session?.user?.id
      const email = session?.user?.email ?? null
      if (!token) { clearCache(); setPlan('free'); setBetaEliteActive(false); setError(null); setLoading(false); setResolved(true); return }
      const cached = readCachedPlan(userId, email)
      if (cached) setPlan(cached)
      try {
        const res = await fetch('/api/user-settings', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (res.ok) {
          const json = await res.json()
          const resolvedPlan = resolvePlan(json)
          setPlan(resolvedPlan)
          writeCachedPlan(resolvedPlan, userId, email)
          setBetaEliteActive(json?.betaEliteActive === true)
          setError(null)
        } else if (!cached) {
          setError('plan_fetch_failed')
        }
      } catch {
        if (!cached) setError('plan_fetch_failed')
      }
      if (!cached && plan == null) setPlan(null)
      setResolved(true)
      setLoading(false)
    }
    supabase.auth.getSession().then(({ data }) => load(data.session ? { access_token: data.session.access_token, user: { id: data.session.user.id, email: data.session.user.email } } : null))
    const { data: l } = supabase.auth.onAuthStateChange((_e, session) => {
      setLoading(true)
      setResolved(false)
      void load(session ? { access_token: session.access_token, user: { id: session.user.id, email: session.user.email } } : null)
    })
    return () => { l.subscription.unsubscribe() }
  }, [])
  return { plan: plan ?? 'free', loading: loading || !resolved, error, betaEliteActive }
}

const FEATURE_DISPLAY: Record<string, string> = {
  'wallet-scanner':   'Wallet Scanner',
  'dev-wallet':       'Dev Wallet Detector',
  'liquidity-safety': 'Liquidity Safety',
  'whale-alerts':     'Whale Alerts',
  'pump-alerts':      'Pump Alerts',
  'base-radar':       'Base Radar',
}

export function LockedPanel({ feature }: { feature: string }) {
  const name = FEATURE_DISPLAY[feature] ?? feature
  return (
    <div style={{
      display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center',
      minHeight: '80vh', padding: '60px 24px',
    }}>
      <div style={{ textAlign: 'center', maxWidth: '400px' }}>
        <div style={{
          width: '60px', height: '60px', borderRadius: '50%',
          background: 'rgba(139,92,246,0.12)',
          border: '1px solid rgba(139,92,246,0.32)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px', fontSize: '26px',
        }}>
          🔒
        </div>
        <h2 style={{
          fontSize: '20px', fontWeight: 700, color: '#f8fafc',
          margin: '0 0 10px',
          fontFamily: 'var(--font-inter, Inter, sans-serif)',
        }}>
          Pro or Elite required
        </h2>
        <p style={{
          fontSize: '14px', color: '#94a3b8', lineHeight: 1.6,
          margin: '0 0 28px',
          fontFamily: 'var(--font-inter, Inter, sans-serif)',
        }}>
          {name} is available on Pro and Elite plans. Sign in or upgrade to unlock live CORTEX intelligence for this tool.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
          href="/sign-in"
          style={{
            display: 'inline-block', padding: '11px 20px',
            borderRadius: '10px',
            background: 'linear-gradient(98deg, #0ea5e9, #6366f1)',
            color: '#fff', fontWeight: 700, fontSize: '13px',
            textDecoration: 'none',
            fontFamily: 'var(--font-inter, Inter, sans-serif)',
            boxShadow: '0 8px 24px rgba(59,130,246,0.35)',
            letterSpacing: '0.02em',
          }}
        >
          Sign In
        </a>
          <a
          href="/pricing"
          style={{
            display: 'inline-block', padding: '11px 20px',
            borderRadius: '10px',
            background: 'linear-gradient(98deg, #7c3aed, #a855f7, #ec4899)',
            color: '#fff', fontWeight: 700, fontSize: '13px',
            textDecoration: 'none',
            fontFamily: 'var(--font-inter, Inter, sans-serif)',
            boxShadow: '0 8px 24px rgba(168,85,247,0.40)',
            letterSpacing: '0.02em',
          }}
        >
          Get Access
        </a>
        </div>
      </div>
    </div>
  )
}

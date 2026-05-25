'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { canAccessFeature, type UserPlan } from '@/lib/planFeatures'

export { canAccessFeature }
export const PLAN_CACHE_KEY = 'chainlens_cached_plan'
export const PLAN_CACHE_MAX_AGE_MS = 1000 * 60 * 30
type CachedPlan = { plan: UserPlan; updatedAt: number; userId?: string | null; emailHash?: string | null; v: 2 }
export type PlanStatus = 'loading' | 'free' | 'pro' | 'elite' | 'unknown'

function hashEmail(email?: string | null): string | null {
  if (!email) return null
  let h = 0
  const normalized = email.trim().toLowerCase()
  for (let i = 0; i < normalized.length; i++) h = (Math.imul(31, h) + normalized.charCodeAt(i)) | 0
  return `e${Math.abs(h)}`
}

export function readCachedPlan(userId?: string | null, email?: string | null): UserPlan | null {
  try {
    const raw = window.localStorage.getItem(PLAN_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedPlan
    if (!parsed || (parsed.plan !== 'free' && parsed.plan !== 'pro' && parsed.plan !== 'elite')) return null
    if (Date.now() - Number(parsed.updatedAt ?? 0) > PLAN_CACHE_MAX_AGE_MS) return null
    if (userId && parsed.userId && parsed.userId !== userId) return null
    const emailHashed = hashEmail(email)
    if (emailHashed && parsed.emailHash && parsed.emailHash !== emailHashed) return null
    return parsed.plan
  } catch { return null }
}

export function writeCachedPlan(nextPlan: UserPlan, userId?: string | null, email?: string | null) {
  try { window.localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify({ plan: nextPlan, updatedAt: Date.now(), userId: userId ?? null, emailHash: hashEmail(email), v: 2 } satisfies CachedPlan)) } catch {}
}

export function clearPlanCache() { try { window.localStorage.removeItem(PLAN_CACHE_KEY) } catch {} }

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
export type ElitePassState = {
  active: boolean
  expiresAt: string | null
  remaining: { days: number; hours: number; minutes: number } | null
  unlocks: string[]
}

const ELITE_UNLOCKS = ['token-scanner-full', 'wallet-scanner', 'dev-wallet', 'whale-alerts', 'pump-alerts', 'base-radar', 'clark-ai-full', 'liquidity-safety', 'portfolio', 'auto-verdicts', 'advanced-whale-alerts', 'priority-cortex', 'early-access']

function computeRemaining(expiresAt: string | null): ElitePassState['remaining'] {
  if (!expiresAt) return null
  const diffMs = Date.parse(expiresAt) - Date.now()
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null
  const totalMinutes = Math.floor(diffMs / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  return { days, hours, minutes }
}

export function usePlanWithLoading(): { plan: UserPlan; loading: boolean; error: string | null; betaEliteActive: boolean; elitePass: ElitePassState } {
  const [plan, setPlan] = useState<UserPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [resolved, setResolved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [betaEliteActive, setBetaEliteActive] = useState(false)
  const [elitePass, setElitePass] = useState<ElitePassState>({ active: false, expiresAt: null, remaining: null, unlocks: [] })
  useEffect(() => {
    const timer = window.setInterval(() => {
      setElitePass((prev) => {
        if (!prev.active) return prev
        const nextRemaining = computeRemaining(prev.expiresAt)
        if (!nextRemaining) return { active: false, expiresAt: prev.expiresAt, remaining: null, unlocks: [] }
        return { ...prev, remaining: nextRemaining }
      })
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    async function load(session: { access_token?: string; user?: { id?: string; email?: string | null } } | null | undefined) {
      const token = session?.access_token
      const userId = session?.user?.id
      const email = session?.user?.email ?? null
      if (!token) { clearPlanCache(); setPlan('free'); setBetaEliteActive(false); setElitePass({ active: false, expiresAt: null, remaining: null, unlocks: [] }); setError(null); setLoading(false); setResolved(true); return }
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
          const trialActive = json?.trialActive === true
          const trialEndsAt = typeof json?.settings?.trial_ends_at === 'string' ? json.settings.trial_ends_at : null
          const remaining = trialActive ? computeRemaining(trialEndsAt) : null
          setElitePass({
            active: trialActive && Boolean(remaining),
            expiresAt: trialEndsAt,
            remaining,
            unlocks: trialActive && remaining ? ELITE_UNLOCKS : [],
          })
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
  return { plan: plan ?? 'free', loading: loading || !resolved, error, betaEliteActive, elitePass }
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

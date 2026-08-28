'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { canAccessFeature, type UserPlan } from '@/lib/planFeatures'
import ClaimTrialButton from '@/components/ClaimTrialButton'

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

type PlanListener = (p: UserPlan | null, meta: { loading: boolean; source: 'cache' | 'network' | 'signed_out' | 'error' | 'init' }) => void

const sharedPlanState: {
  plan: UserPlan | null
  loading: boolean
  loadedOnce: boolean
  listeners: Set<PlanListener>
  inFlight: Promise<void> | null
  lastFetchedAt: number
} = {
  plan: null,
  loading: false,
  loadedOnce: false,
  listeners: new Set(),
  inFlight: null,
  lastFetchedAt: 0,
}

function notifyPlanListeners(source: Parameters<PlanListener>[1]['source']) {
  for (const l of sharedPlanState.listeners) l(sharedPlanState.plan, { loading: sharedPlanState.loading, source })
}

/** Read the last verified cached plan without touching the network. */
export function peekCachedPlan(): UserPlan | null {
  try {
    const raw = window.localStorage.getItem(PLAN_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedPlan
    if (!parsed || (parsed.plan !== 'free' && parsed.plan !== 'pro' && parsed.plan !== 'elite')) return null
    if (Date.now() - Number(parsed.updatedAt ?? 0) > PLAN_CACHE_MAX_AGE_MS) return null
    return parsed.plan
  } catch { return null }
}


const GET_SESSION_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      const err = new Error(message)
      err.name = 'TimeoutError'
      reject(err)
    }, ms)
    promise.then(
      (v) => { window.clearTimeout(t); resolve(v) },
      (e) => { window.clearTimeout(t); reject(e) },
    )
  })
}

export function ensurePlanLoaded(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (sharedPlanState.loadedOnce && Date.now() - sharedPlanState.lastFetchedAt < PLAN_CACHE_MAX_AGE_MS && !sharedPlanState.loading) {
    return Promise.resolve()
  }
  if (sharedPlanState.inFlight) return sharedPlanState.inFlight

  sharedPlanState.loading = true
  notifyPlanListeners('init')
  sharedPlanState.inFlight = (async () => {
    try {
      const { data } = await withTimeout(supabase.auth.getSession(), GET_SESSION_TIMEOUT_MS, 'getSession_timeout')
      const session = data.session
      const token = session?.access_token
      if (!token) {
        clearPlanCache()
        sharedPlanState.plan = 'free'
        sharedPlanState.lastFetchedAt = Date.now()
        notifyPlanListeners('signed_out')
        return
      }
      const userId = session.user.id
      const email = session.user.email ?? null
      const res = await fetch('/api/user-settings', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      })
      if (res.ok) {
        const json = await res.json() as Record<string, unknown>
        const p = json?.effectivePlan ?? json?.plan ?? (json?.settings as Record<string, unknown>)?.plan
        const resolvedPlan: UserPlan = p === 'pro' || p === 'elite' ? p : 'free'
        sharedPlanState.plan = resolvedPlan
        sharedPlanState.lastFetchedAt = Date.now()
        writeCachedPlan(resolvedPlan, userId, email)
        notifyPlanListeners('network')
      } else {
        notifyPlanListeners('error')
      }
    } catch {
      notifyPlanListeners('error')
    } finally {
      sharedPlanState.loading = false
      sharedPlanState.loadedOnce = true
      sharedPlanState.inFlight = null
    }
  })()
  return sharedPlanState.inFlight
}

export function subscribeToSharedPlan(
  listener: PlanListener,
): () => void {
  const cached = peekCachedPlan()
  listener(cached, { loading: sharedPlanState.loading || !sharedPlanState.loadedOnce, source: cached ? 'cache' : 'init' })
  sharedPlanState.listeners.add(listener)
  void ensurePlanLoaded()
  return () => { sharedPlanState.listeners.delete(listener) }
}

function resolvePlan(json: Record<string, unknown>): UserPlan {
  const p = json?.effectivePlan ?? json?.plan ?? (json?.settings as Record<string, unknown>)?.plan
  return p === 'pro' || p === 'elite' ? p : 'free'
}

export function usePlan(): UserPlan {
  const [plan, setPlan] = useState<UserPlan | null>(null)
  useEffect(() => {
    return subscribeToSharedPlan((p) => { if (p != null) setPlan(p) })
  }, [])
  return (plan ?? peekCachedPlan()) as UserPlan
}

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
  // Pump Alerts hang fix: if a verified plan is already cached (FeatureBar shows Elite),
  // do not start in loading=true. The page was blocking on /api/user-settings forever.
  const [plan, setPlan] = useState<UserPlan | null>(() => peekCachedPlan())
  const [loading, setLoading] = useState(() => peekCachedPlan() == null)
  const [resolved, setResolved] = useState(() => peekCachedPlan() != null)
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
      if (cached) {
        setPlan(cached)
        setLoading(false)
        setResolved(true)
      }
      try {
        const res = await fetch('/api/user-settings', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(8_000) })
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
      setResolved(true)
      setLoading(false)
    }
    let cancelled = false
    const safety = window.setTimeout(() => {
      if (cancelled) return
      // Hard wall-clock: never leave "Loading plan access…" up forever.
      setLoading(false)
      setResolved(true)
      setPlan((prev) => {
        if (prev) return prev
        const cached = peekCachedPlan()
        if (cached) return cached
        setError((e) => e ?? 'plan_fetch_failed')
        return 'free'
      })
    }, GET_SESSION_TIMEOUT_MS)
    withTimeout(supabase.auth.getSession(), GET_SESSION_TIMEOUT_MS, 'getSession_timeout')
      .then(({ data }) => {
        if (cancelled) return
        return load(data.session ? { access_token: data.session.access_token, user: { id: data.session.user.id, email: data.session.user.email } } : null)
      })
      .catch(() => {
        if (cancelled) return
        const cached = peekCachedPlan()
        if (cached) {
          setPlan(cached)
          setError(null)
        } else {
          setPlan('free')
          setError('plan_fetch_failed')
        }
        setLoading(false)
        setResolved(true)
      })
    const { data: l } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED / INITIAL_SESSION must not flip Pump Alerts back to
      // "Loading plan access…" when a cached plan is already visible.
      const hasCache = Boolean(peekCachedPlan() || (session?.user && readCachedPlan(session.user.id, session.user.email ?? null)))
      if (event === 'TOKEN_REFRESHED' || (event === 'INITIAL_SESSION' && hasCache)) {
        void load(session ? { access_token: session.access_token, user: { id: session.user.id, email: session.user.email } } : null)
        return
      }
      if (event === 'SIGNED_OUT' || !hasCache) {
        setLoading(true)
        setResolved(false)
      }
      void load(session ? { access_token: session.access_token, user: { id: session.user.id, email: session.user.email } } : null)
    })
    return () => { cancelled = true; window.clearTimeout(safety); l.subscription.unsubscribe() }
  }, [])
  return { plan: plan ?? peekCachedPlan() ?? ('free' as UserPlan), loading: loading || !resolved, error, betaEliteActive, elitePass }
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
          margin: '0 0 20px',
          fontFamily: 'var(--font-inter, Inter, sans-serif)',
        }}>
          {name} is available on Pro and Elite plans.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <ClaimTrialButton onClaimed={() => window.location.reload()} />
          <a
          href="/pricing"
          style={{
            fontSize: '12.5px', color: '#94a3b8', textDecoration: 'underline',
            fontFamily: 'var(--font-inter, Inter, sans-serif)',
          }}
        >
          Or view Pro / Elite pricing
        </a>
        </div>
      </div>
    </div>
  )
}

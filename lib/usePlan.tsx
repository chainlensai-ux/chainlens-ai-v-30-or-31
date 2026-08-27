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

// ── SHARED PLAN STORE (smoothness/perceived-performance audit) ──────────────
// One module-level source of truth for plan state. Every consumer (Navbar, FeatureBar,
// usePlan, pricing, settings) subscribes to this instead of each firing its own
// /api/user-settings request. In-flight requests are singleflighted: N components mounting
// at once produce exactly ONE network call, and all receive the same resolved value.
// Display-only cache rules: cached plans are shown instantly on mount; a component with no
// valid cache shows 'unknown' (neutral), NEVER 'free' — 'free' is only ever set from a
// confirmed backend response or an explicitly signed-out session.
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

/**
 * Ensure the shared plan is fetched (singleflight). If a fetch is already running or a fresh
 * one completed recently (30s — matching the cache max age), resolves immediately without a
 * new request. Safe to call from any number of components simultaneously.
 */
export function ensurePlanLoaded(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  // Fresh enough — no refetch needed; background staleness is handled by cache expiry.
  if (sharedPlanState.loadedOnce && Date.now() - sharedPlanState.lastFetchedAt < PLAN_CACHE_MAX_AGE_MS && !sharedPlanState.loading) {
    return Promise.resolve()
  }
  if (sharedPlanState.inFlight) return sharedPlanState.inFlight

  sharedPlanState.loading = true
  notifyPlanListeners('init')
  sharedPlanState.inFlight = (async () => {
    try {
      const { data } = await supabase.auth.getSession()
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
      // Cached-verified-first: show it immediately (listeners already saw it via peek),
      // then confirm against the backend.
      const res = await fetch('/api/user-settings', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
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
        // Network/HTTP failure: keep whatever cached value was already visible; never
        // downgrade to Free on error.
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

/**
 * Subscribe a component to the shared plan state.
 * Returns the initial display value synchronously: cached verified plan if present,
 * otherwise null ('unknown') — never a guessed Free.
 */
export function subscribeToSharedPlan(
  listener: PlanListener,
): () => void {
  const cached = peekCachedPlan()
  listener(cached, { loading: sharedPlanState.loading || !sharedPlanState.loadedOnce, source: cached ? 'cache' : 'init' })
  sharedPlanState.listeners.add(listener)
  // Trigger/coalesce the shared fetch — deduped by singleflight.
  void ensurePlanLoaded()
  return () => { sharedPlanState.listeners.delete(listener) }
}

function resolvePlan(json: Record<string, unknown>): UserPlan {
  const p = json?.effectivePlan ?? json?.plan ?? (json?.settings as Record<string, unknown>)?.plan
  return p === 'pro' || p === 'elite' ? p : 'free'
}

export function usePlan(): UserPlan {
  // CACHED-FIRST, NEVER-GUESS-FREE (smoothness audit): initial value is the last verified
  // cached plan if present, otherwise 'free' is NOT assumed — null means unknown and the
  // shared store resolves it from one singleflight request shared across all consumers.
  const [plan, setPlan] = useState<UserPlan | null>(null)
  useEffect(() => {
    return subscribeToSharedPlan((p) => { if (p != null) setPlan(p) })
  }, [])
  // After the shared load completes with no cache ever having existed, an explicitly
  // confirmed free/signed-out value arrives from the store; until then stay neutral.
  return (plan ?? peekCachedPlan()) as UserPlan
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
  // CACHED-FIRST INIT (smoothness audit): start from the last verified cached plan instead of
  // null/'free', so an Elite user reloading sees Elite immediately. The shared store then
  // confirms in the background — no Free→Elite flicker, and one shared request across consumers.
  const [plan, setPlan] = useState<UserPlan | null>(() => peekCachedPlan())
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
        {/*
          TRIAL-PATH FIX, DISCLOSED (audit: "people have to make an account and they automatically
          go on free plan" — every locked feature page inside the app dead-ended into "Sign In"
          (nonsensical for a visitor who is already signed in and simply on the free plan — this
          panel renders purely off canAccessFeature(plan, feature), which is true for both an
          anonymous visitor and an authenticated free-plan account) and "Get Access" (a paid
          checkout link). The only path to the real 7-day Elite trial was a button on the
          logged-out marketing homepage — a signed-in free user landing here from inside the app,
          which is the far more common case post-signup, had no way to discover it at all.
          ClaimTrialButton already self-handles "not signed in" (redirects to /auth, now preserving
          the current page via `next=`, see that file's fix) so it works correctly for both an
          anonymous visitor and a signed-in free user without this component needing to know which
          one it's looking at.
        */}
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

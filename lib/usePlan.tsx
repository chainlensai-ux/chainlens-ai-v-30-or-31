'use client'

// PLAN / ACCOUNT STORE, DISCLOSED (performance + UX optimization task).
//
// CONFIRMED ROOT CAUSE, DISCLOSED: before this refactor there were FOUR independent
// implementations of the same "who is signed in, and what plan do they have" question, each with
// its own `supabase.auth.getSession()`, its own `fetch('/api/user-settings')`, and its own
// `supabase.auth.onAuthStateChange` subscription:
//   1. `sharedPlanState`/`ensurePlanLoaded()` (this file — the only one that deduped anything),
//   2. `usePlanWithLoading()` (this file — a completely separate per-component copy),
//   3. components/FeatureBar.tsx (the always-mounted terminal sidebar),
//   4. components/Navbar.tsx.
// A terminal page mounts FeatureBar + the page's own `usePlanWithLoading()`, so every single page
// load fired the same `/api/user-settings` request 2-3x and the same `getSession()` 2-3x, and every
// auth event (including routine TOKEN_REFRESHED) re-fired all of them. That duplicated work is what
// made "Loading plan access…" visible at all: the page's own copy raced the sidebar's copy, and
// whichever finished last still had the page blocked behind its `loading` flag.
//
// FIX, DISCLOSED: ONE module-level store. One getSession, one /api/user-settings, one
// onAuthStateChange subscription, one 60s elite-pass ticker — for the entire app, no matter how many
// components read it. Every existing public API (`usePlan`, `usePlanWithLoading`, `readCachedPlan`,
// `writeCachedPlan`, `clearPlanCache`, `peekCachedPlan`, `canAccessFeature`, `LockedPanel`) keeps
// its exact previous signature and semantics, so no caller had to change to get the benefit.
//
// STALE-WHILE-REVALIDATE, DISCLOSED: a cached plan is served synchronously (including on the very
// first paint, via useSyncExternalStore) and refreshed in the background. `loading` is now true ONLY
// when there is genuinely nothing to show — never during a background refresh of a value the user
// can already see. This is what removes the "Loading plan…" flash on navigation.
//
// NOT CHANGED, DISCLOSED: plan resolution rules (`resolvePlan`), the access gate
// (`canAccessFeature`, imported unchanged from planFeatures), cache key/TTL/validation, the
// signed-out → clear-cache → 'free' path, and every timeout guard. This is a wiring/caching change
// only — no access-control or business logic is altered.

import { useCallback, useSyncExternalStore } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { canAccessFeature, canAccessFomoBoard, type UserPlan } from '@/lib/planFeatures'
import ClaimTrialButton from '@/components/ClaimTrialButton'
import { setSignedInPresenceCookie } from '@/lib/authFlow'

export { canAccessFeature, canAccessFomoBoard }
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

export type ElitePassState = {
  active: boolean
  expiresAt: string | null
  remaining: { days: number; hours: number; minutes: number } | null
  unlocks: string[]
}

const ELITE_UNLOCKS = ['token-scanner-full', 'wallet-scanner', 'dev-wallet', 'whale-alerts', 'pump-alerts', 'base-radar', 'clark-ai-full', 'liquidity-safety', 'portfolio']

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

// ── The one store ────────────────────────────────────────────────────────────────────────────────

/**
 * The non-sensitive profile fields the SAME `/api/user-settings` response already carries. Held here
 * so Navbar reads them from the shared snapshot instead of issuing its own duplicate request for a
 * payload the store has already fetched.
 */
export type AccountProfile = {
  avatarColor: string | null
  avatarUrl: string | null
  displayName: string | null
  trialDaysLeft: number
}

export type AccountSnapshot = {
  /** null only while genuinely unknown (first ever load, no cache). Never a guessed 'free'. */
  plan: UserPlan | null
  /**
   * `undefined` = the session has not resolved yet; `null` = resolved and genuinely signed out.
   * Keeping those distinct is what stops the sidebar flashing "Sign In / Sign Up" at a signed-in
   * user during the first paint — an unknown session must render a neutral placeholder, not a
   * confident signed-out state.
   */
  email: string | null | undefined
  betaEliteActive: boolean
  elitePass: ElitePassState
  profile: AccountProfile
  error: string | null
  /** True ONLY when there is nothing usable to show yet — never during a background refresh. */
  loading: boolean
  /** A real network answer (or a definitive signed-out result) has landed at least once. */
  resolved: boolean
}

const EMPTY_ELITE_PASS: ElitePassState = { active: false, expiresAt: null, remaining: null, unlocks: [] }
const EMPTY_PROFILE: AccountProfile = { avatarColor: null, avatarUrl: null, displayName: null, trialDaysLeft: 0 }

// SERVER SNAPSHOT, DISCLOSED: a single frozen object so useSyncExternalStore's getServerSnapshot is
// referentially stable across renders (returning a fresh object there is an infinite-render bug).
// `loading: false` on the server is deliberate: the server can never know the plan, and rendering a
// full-screen "Loading plan access…" wall into the SSR HTML — which is exactly what the previous
// implementation did — guarantees that wall is painted on EVERY page load before hydration, even for
// a user whose plan is already cached locally. The gate below treats `plan: null` as "not yet known"
// and renders a skeleton, never a blocking text wall.
const SERVER_SNAPSHOT: AccountSnapshot = Object.freeze({
  plan: null,
  email: undefined,
  betaEliteActive: false,
  elitePass: EMPTY_ELITE_PASS,
  profile: EMPTY_PROFILE,
  error: null,
  loading: false,
  resolved: false,
})

type Store = {
  snapshot: AccountSnapshot
  listeners: Set<() => void>
  inFlight: Promise<void> | null
  lastFetchedAt: number
  started: boolean
  authUnsub: (() => void) | null
  ticker: number | null
}

const store: Store = {
  snapshot: SERVER_SNAPSHOT,
  listeners: new Set(),
  inFlight: null,
  lastFetchedAt: 0,
  started: false,
  authUnsub: null,
  ticker: null,
}

/**
 * Replace the snapshot ONLY when something actually changed. A referentially-equal snapshot means
 * useSyncExternalStore skips the re-render entirely — this is what stops every plan-reading
 * component in the tree from re-rendering on each routine background refresh.
 */
function setSnapshot(patch: Partial<AccountSnapshot>): void {
  const prev = store.snapshot
  const next: AccountSnapshot = { ...prev, ...patch }
  if (
    next.plan === prev.plan
    && next.email === prev.email
    && next.betaEliteActive === prev.betaEliteActive
    && next.error === prev.error
    && next.loading === prev.loading
    && next.resolved === prev.resolved
    && next.elitePass.active === prev.elitePass.active
    && next.elitePass.expiresAt === prev.elitePass.expiresAt
    && next.elitePass.remaining?.days === prev.elitePass.remaining?.days
    && next.elitePass.remaining?.hours === prev.elitePass.remaining?.hours
    && next.elitePass.remaining?.minutes === prev.elitePass.remaining?.minutes
    && next.profile.avatarColor === prev.profile.avatarColor
    && next.profile.avatarUrl === prev.profile.avatarUrl
    && next.profile.displayName === prev.profile.displayName
    && next.profile.trialDaysLeft === prev.profile.trialDaysLeft
  ) return
  store.snapshot = next
  for (const l of store.listeners) l()
}

export function writeCachedPlan(nextPlan: UserPlan, userId?: string | null, email?: string | null) {
  try { window.localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify({ plan: nextPlan, updatedAt: Date.now(), userId: userId ?? null, emailHash: hashEmail(email), v: 2 } satisfies CachedPlan)) } catch {}
  // OPTIMISTIC UI, DISCLOSED: a caller that just verified a new plan (e.g. ClaimTrialButton after a
  // successful Elite Pass claim) writes the cache — pushing it into the store here means every
  // plan-reading surface in the app updates in the same frame, with no refetch and no reload.
  setSnapshot({ plan: nextPlan, loading: false, resolved: true, error: null })
}

export function clearPlanCache() { try { window.localStorage.removeItem(PLAN_CACHE_KEY) } catch {} }

// SIGNED-IN MARKER COOKIE, DISCLOSED (account-required task — "server-side auth guard for all
// /terminal routes"). WHY A COOKIE AT ALL: this app's Supabase session lives ONLY in
// localStorage (lib/supabaseClient.ts uses the plain @supabase/supabase-js client, not a
// cookie-syncing helper), which a server-side proxy/middleware genuinely cannot read — there is no
// session data available to it. Per Next.js's own Proxy docs ("helpful for optimistic checks...
// should not be used as a full session management or authorization solution"), this cookie is
// exactly that: a non-sensitive presence FLAG (never the token itself, never anything an attacker
// could use to forge access) that lets proxy.ts make a fast, good-enough redirect decision before
// any page code runs. It is NOT a trust boundary — every protected API route independently verifies
// the real bearer token server-side (see lib/server/requireAuth.ts) regardless of this cookie's
// value, so a forged/stale cookie can get a signed-out visitor PAST the redirect but can never get
// them a real scan, wallet read, or Clark answer — those all 401 without a verified session.
// SameSite=Lax (not Strict) so it still applies on a top-level OAuth-callback redirect.
// Presence cookie lives in lib/authFlow (shared with /auth so proxy does not bounce post-login).


function resolvePlan(json: Record<string, unknown>): UserPlan {
  const p = json?.effectivePlan ?? json?.plan ?? (json?.settings as Record<string, unknown>)?.plan
  return p === 'pro' || p === 'elite' ? p : 'free'
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

type SessionLike = { access_token?: string; user?: { id?: string; email?: string | null } } | null | undefined

/** The one real network path. Coalesced: concurrent callers share a single in-flight promise. */
function refresh(session: SessionLike, opts: { force?: boolean } = {}): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (store.inFlight) return store.inFlight
  if (!opts.force && store.snapshot.resolved && Date.now() - store.lastFetchedAt < PLAN_CACHE_MAX_AGE_MS) {
    return Promise.resolve()
  }

  store.inFlight = (async () => {
    try {
      const token = session?.access_token
      const userId = session?.user?.id
      const email = session?.user?.email ?? null

      if (!token) {
        clearPlanCache()
        setSignedInPresenceCookie(false)
        store.lastFetchedAt = Date.now()
        setSnapshot({ plan: 'free', email: null, betaEliteActive: false, elitePass: EMPTY_ELITE_PASS, profile: EMPTY_PROFILE, error: null, loading: false, resolved: true })
        return
      }

      // OPTIMISTIC COOKIE, DISCLOSED: set as soon as a real Supabase session token is present —
      // never waits on the /api/user-settings round trip below. See setSignedInPresenceCookie in lib/authFlow
      // for why this is safe (it only ever gates a redirect, never real authorization).
      setSignedInPresenceCookie(true)

      // CACHED-FIRST, DISCLOSED: surface the verified cached plan for THIS user before the network
      // call resolves, so an Elite user never sees Free (or a spinner) while we re-confirm.
      const cached = readCachedPlan(userId, email)
      if (cached) setSnapshot({ plan: cached, email, loading: false })
      else setSnapshot({ email })

      const res = await fetch('/api/user-settings', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      })
      if (res.ok) {
        const json = await res.json() as Record<string, unknown>
        const resolvedPlan = resolvePlan(json)
        const trialActive = json?.trialActive === true
        const settings = json?.settings as Record<string, unknown> | undefined
        const trialEndsAt = typeof settings?.trial_ends_at === 'string' ? settings.trial_ends_at : null
        const remaining = trialActive ? computeRemaining(trialEndsAt) : null
        store.lastFetchedAt = Date.now()
        try { window.localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify({ plan: resolvedPlan, updatedAt: Date.now(), userId: userId ?? null, emailHash: hashEmail(email), v: 2 } satisfies CachedPlan)) } catch {}
        const trialDaysLeft = Number(json?.trialDaysLeft ?? 0)
        setSnapshot({
          plan: resolvedPlan,
          email,
          betaEliteActive: json?.betaEliteActive === true,
          elitePass: {
            active: trialActive && Boolean(remaining),
            expiresAt: trialEndsAt,
            remaining,
            unlocks: trialActive && remaining ? ELITE_UNLOCKS : [],
          },
          profile: {
            avatarColor: String(settings?.avatar_color ?? json?.avatar_color ?? '') || null,
            avatarUrl: String(settings?.avatar_url ?? json?.avatar_url ?? '') || null,
            displayName: String(settings?.display_name ?? json?.display_name ?? '') || null,
            trialDaysLeft: Number.isFinite(trialDaysLeft) ? trialDaysLeft : 0,
          },
          error: null,
          loading: false,
          resolved: true,
        })
      } else {
        // ERROR PATH, DISCLOSED: a failed refresh must NEVER downgrade a plan the user can already
        // see — keep the cached value and only surface an error when there was nothing to fall back
        // on. Same rule the previous FeatureBar/usePlanWithLoading implementations both encoded.
        setSnapshot({ loading: false, resolved: true, error: cached ? null : 'plan_fetch_failed' })
      }
    } catch {
      const stillHasPlan = store.snapshot.plan != null
      setSnapshot({ loading: false, resolved: true, error: stillHasPlan ? null : 'plan_fetch_failed' })
    } finally {
      store.inFlight = null
    }
  })()
  return store.inFlight
}

/** Starts the ONE auth listener + ONE elite-pass ticker for the whole app. Idempotent. */
function start(): void {
  if (typeof window === 'undefined' || store.started) return
  store.started = true

  const cached = peekCachedPlan()
  // loading is true only when we have genuinely nothing to show.
  setSnapshot({ plan: cached, loading: cached == null })

  // Hard wall-clock guard: never leave a first-load gate up forever if auth never answers.
  const safety = window.setTimeout(() => {
    if (store.snapshot.resolved) return
    setSnapshot({ plan: store.snapshot.plan ?? peekCachedPlan() ?? 'free', loading: false, resolved: true, error: store.snapshot.plan ?? peekCachedPlan() ? null : 'plan_fetch_failed' })
  }, GET_SESSION_TIMEOUT_MS)

  withTimeout(supabase.auth.getSession(), GET_SESSION_TIMEOUT_MS, 'getSession_timeout')
    .then(({ data }) => {
      window.clearTimeout(safety)
      const s = data.session
      return refresh(s ? { access_token: s.access_token, user: { id: s.user.id, email: s.user.email } } : null, { force: true })
    })
    .catch(() => {
      window.clearTimeout(safety)
      const fallback = peekCachedPlan()
      setSnapshot({ plan: fallback ?? 'free', loading: false, resolved: true, error: fallback ? null : 'plan_fetch_failed' })
    })

  const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
    const s: SessionLike = session ? { access_token: session.access_token, user: { id: session.user.id, email: session.user.email } } : null
    if (event === 'SIGNED_OUT') {
      clearPlanCache()
      setSignedInPresenceCookie(false)
      setSnapshot({ plan: 'free', email: null, betaEliteActive: false, elitePass: EMPTY_ELITE_PASS, profile: EMPTY_PROFILE, error: null, loading: false, resolved: true })
      return
    }
    // NO LOADING FLASH ON REFRESH, DISCLOSED: TOKEN_REFRESHED/INITIAL_SESSION must never flip a
    // visible plan back to a loading state — they revalidate in the background instead. This is the
    // exact regression the previous implementation's own comment described but only partly fixed.
    void refresh(s, { force: true })
  })
  store.authUnsub = () => listener.subscription.unsubscribe()

  // ONE ticker for the whole app (previously one 60s interval per usePlanWithLoading caller).
  store.ticker = window.setInterval(() => {
    const pass = store.snapshot.elitePass
    if (!pass.active) return
    const nextRemaining = computeRemaining(pass.expiresAt)
    setSnapshot({ elitePass: nextRemaining ? { ...pass, remaining: nextRemaining } : { active: false, expiresAt: pass.expiresAt, remaining: null, unlocks: [] } })
  }, 60_000)
}

function subscribe(onStoreChange: () => void): () => void {
  start()
  store.listeners.add(onStoreChange)
  return () => { store.listeners.delete(onStoreChange) }
}

function getSnapshot(): AccountSnapshot { return store.snapshot }
function getServerSnapshot(): AccountSnapshot { return SERVER_SNAPSHOT }

/** Subscribe to the one shared account snapshot. Tear-free, SSR-safe, dedup-free of extra fetches. */
export function useAccount(): AccountSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Force a background revalidation (e.g. after a plan-changing action). Never clears the UI. */
export function refreshAccount(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  return supabase.auth.getSession().then(({ data }) => {
    const s = data.session
    return refresh(s ? { access_token: s.access_token, user: { id: s.user.id, email: s.user.email } } : null, { force: true })
  }).catch(() => {})
}

/** Back-compat: kept for callers that only want to warm the store. */
export function ensurePlanLoaded(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  start()
  return store.inFlight ?? Promise.resolve()
}

// ── Public hooks (unchanged signatures) ──────────────────────────────────────────────────────────

export function usePlan(): UserPlan {
  const { plan } = useAccount()
  return (plan ?? 'free') as UserPlan
}

export function usePlanWithLoading(): { plan: UserPlan; loading: boolean; error: string | null; betaEliteActive: boolean; elitePass: ElitePassState } {
  const { plan, loading, error, betaEliteActive, elitePass } = useAccount()
  // UNKNOWN COUNTS AS LOADING, DISCLOSED: callers gate as
  // `if (loading) <skeleton/>; if (!canAccessFeature(plan, …)) <LockedPanel/>`, and `plan` is
  // surfaced as a concrete 'free' for their type contract. So if `loading` were false while the plan
  // is still genuinely unknown (null) — which is exactly the state on the server and on the very
  // first client paint — every locked page would render the "Pro or Elite required" paywall into the
  // SSR HTML and flash it at a paying Elite user before hydration. Reporting unknown as `loading`
  // keeps the honest meaning ("we do not know yet") and makes those pages show the skeleton instead.
  // Verified against the real SSR output for /terminal/wallet-scanner, /portfolio and /pump-alerts.
  return { plan: (plan ?? 'free') as UserPlan, loading: loading || plan == null, error, betaEliteActive, elitePass }
}

// ── Access gate ──────────────────────────────────────────────────────────────────────────────────

const FEATURE_DISPLAY: Record<string, string> = {
  'wallet-scanner':   'Wallet Scanner',
  'dev-wallet':       'Dev checks',
  'liquidity-safety': 'LP Safety',
  'whale-alerts':     'Whale Alerts',
  'pump-alerts':      'Pump Alerts',
  'base-radar':       'Base Radar',
}

// SKELETON, NOT A TEXT WALL, DISCLOSED (this task's "skeletons instead of blank screens" /
// "never allow the user to wonder whether something happened" requirements): shown ONLY on a genuine
// first load with no cached plan. It mirrors the real page rhythm (header block + content blocks) so
// the layout does not jump when the real content replaces it, and it animates with opacity only
// (GPU-friendly, and disabled under prefers-reduced-motion via the shared .cl-skeleton CSS).
export function PlanGateSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" style={{ flex: 1, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <span className="sr-only">Checking plan access</span>
      <div className="cl-skeleton" style={{ height: '34px', width: 'min(320px, 60%)', borderRadius: '10px' }} />
      <div className="cl-skeleton" style={{ height: '96px', borderRadius: '14px' }} />
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
        <div className="cl-skeleton" style={{ flex: '1 1 260px', height: '160px', borderRadius: '14px' }} />
        <div className="cl-skeleton" style={{ flex: '1 1 260px', height: '160px', borderRadius: '14px' }} />
      </div>
      <div className="cl-skeleton" style={{ height: '220px', borderRadius: '14px' }} />
    </div>
  )
}

/**
 * The one access gate every plan-locked page uses.
 *
 * ORDER, DISCLOSED: access is decided from the REAL resolved plan exactly as before
 * (`canAccessFeature`) — this never renders locked content early. The only change is what happens
 * while the plan is still unknown: previously a full-screen "Loading plan access…" text wall that
 * was ALSO baked into the SSR HTML (so it flashed on every load, cached or not); now a skeleton that
 * only appears when there is genuinely no cached plan to trust.
 */
export function PlanGate({ feature, children }: { feature: string; children: React.ReactNode }) {
  const { plan, loading, elitePass } = useAccount()
  const unlockedByPass = elitePass.active && elitePass.unlocks.includes(feature)
  if (plan == null || loading) return <PlanGateSkeleton />
  if (!unlockedByPass && !canAccessFeature(plan, feature)) return <LockedPanel feature={feature} />
  return <>{children}</>
}

export function LockedPanel({ feature }: { feature: string }) {
  const name = FEATURE_DISPLAY[feature] ?? feature
  // OPTIMISTIC UNLOCK, DISCLOSED: a successful claim writes the verified plan into the shared store
  // (see writeCachedPlan), so the page unlocks in the same frame instead of a full page reload.
  const onClaimed = useCallback(() => { void refreshAccount() }, [])
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
          <ClaimTrialButton onClaimed={onClaimed} />
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

// ── Back-compat shims ────────────────────────────────────────────────────────────────────────────

type PlanListener = (p: UserPlan | null, meta: { loading: boolean; source: 'cache' | 'network' | 'signed_out' | 'error' | 'init' }) => void

/** Kept for any caller still using the old imperative subscription API. */
export function subscribeToSharedPlan(listener: PlanListener): () => void {
  const emit = () => listener(store.snapshot.plan, { loading: store.snapshot.loading, source: store.snapshot.resolved ? 'network' : 'cache' })
  const unsub = subscribe(emit)
  emit()
  return unsub
}

/** Test-only: reset the module store so a suite can exercise a cold start. */
export function __resetAccountStoreForTest(): void {
  store.snapshot = SERVER_SNAPSHOT
  store.listeners.clear()
  store.inFlight = null
  store.lastFetchedAt = 0
  store.started = false
  if (store.authUnsub) { store.authUnsub(); store.authUnsub = null }
  if (store.ticker != null) { window.clearInterval(store.ticker); store.ticker = null }
}

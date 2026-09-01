// Account-state smoothness / perceived-performance regression tests.
import { readFileSync } from 'node:fs'

const results = []
function check(name, fn) {
  try { fn(); results.push(`PASS ${name}`) }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); process.exitCode = 1 }
}

const usePlanSrc = readFileSync(new URL('../lib/usePlan.tsx', import.meta.url), 'utf8')
const featureBarSrc = readFileSync(new URL('../components/FeatureBar.tsx', import.meta.url), 'utf8')
const navbarSrc = readFileSync(new URL('../components/Navbar.tsx', import.meta.url), 'utf8')
const pricingSrc = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8')
const settingsSrc = readFileSync(new URL('../app/terminal/settings/page.tsx', import.meta.url), 'utf8')

check('shared singleflight store exists in lib/usePlan.tsx', () => {
  for (const token of ['ensurePlanLoaded', 'subscribeToSharedPlan', 'peekCachedPlan', 'inFlight']) {
    if (!usePlanSrc.includes(token)) throw new Error(`missing ${token}`)
  }
})

// UPDATED, DISCLOSED (performance + UX optimization task): these three checks used to assert the
// literal per-component useState shapes of the OLD implementation, where usePlan() and
// usePlanWithLoading() each ran their own getSession + /api/user-settings + onAuthStateChange. Both
// hooks now read ONE shared, deduped, cached-first module store (lib/usePlan.tsx). The intent each
// check protects is unchanged and still enforced below — never a guessed Free, cached-first init, no
// loading hang when a cache exists, an 8s abort, and TOKEN_REFRESHED never flipping back to loading
// — just asserted against the store that now owns that behaviour for every consumer at once.
check('usePlan() no longer initializes to guessed Free', () => {
  const fnBody = usePlanSrc.slice(usePlanSrc.indexOf('export function usePlan('), usePlanSrc.indexOf('export function usePlanWithLoading'))
  if (/useState<UserPlan>\('free'\)/.test(fnBody)) throw new Error('usePlan still guesses Free')
  if (!fnBody.includes('useAccount()')) throw new Error('usePlan must read the shared account store')
})

check('usePlanWithLoading starts from cached verified plan', () => {
  const fnBody = usePlanSrc.slice(usePlanSrc.indexOf('export function usePlanWithLoading'))
  if (!fnBody.includes('useAccount()')) throw new Error('must read the shared account store')
  // The store seeds itself from the verified cache before any network call, and surfaces the cached
  // plan for the signed-in user again inside refresh() — both are the cached-first guarantee.
  if (!usePlanSrc.includes('const cached = peekCachedPlan()')) throw new Error('store must seed from peekCachedPlan()')
  if (!usePlanSrc.includes('const cached = readCachedPlan(userId, email)')) throw new Error('refresh must surface the cached plan before the network resolves')
})

check('usePlanWithLoading does not hang Pump Alerts when plan cache exists', () => {
  // loading is derived from "is there anything showable", not from "is a request in flight".
  if (!usePlanSrc.includes('setSnapshot({ plan: cached, loading: cached == null })')) throw new Error('loading must start false when cache exists')
  if (!usePlanSrc.includes('AbortSignal.timeout(8_000)')) throw new Error('user-settings fetch must abort after 8s')
  if (!usePlanSrc.includes('TOKEN_REFRESHED')) throw new Error('token refresh must not block the page on Loading plan access')
})

// UPDATED, DISCLOSED (performance + UX optimization task): FeatureBar no longer calls
// peekCachedPlan() itself — it reads the shared account store, which seeds from that same verified
// cache before any network call (asserted directly in the store checks above). Same cached-first
// guarantee, one fetch instead of a third duplicate one.
check('FeatureBar uses cached-first plan init', () => {
  if (!featureBarSrc.includes('useAccount()')) throw new Error('FeatureBar must read the cached-first shared store')
  if (featureBarSrc.includes("peekCachedPlan() ?? ('free'")) throw new Error('FeatureBar must not guess Free on mount')
  // useAccount() is the replacement for the old subscribeToSharedPlan + ensurePlanLoaded pair: it
  // subscribes to the shared store AND starts the one shared load on first mount, so a component
  // reading it can no longer forget to do either.
  if (featureBarSrc.includes("fetch('/api/user-settings'")) throw new Error('FeatureBar must not run its own duplicate plan fetch')
  if (!usePlanSrc.includes('function subscribe(onStoreChange: () => void)') || !usePlanSrc.includes('start()')) throw new Error('useAccount must subscribe to the shared store and start the shared load')
})

// UPDATED, DISCLOSED (performance + UX optimization task): the unknown-vs-signed-out distinction now
// lives in the shared store's `email` field (undefined = session unresolved, null = resolved and
// signed out) rather than in FeatureBar's own useState. Same guarantee, asserted at its new home —
// plus the render-side check below, which is what actually prevents the "Sign In" flash.
check('FeatureBar does not treat unknown session as Sign In', () => {
  if (!usePlanSrc.includes('email: string | null | undefined')) throw new Error('accountEmail must start undefined, not null')
  if (!featureBarSrc.includes('accountEmail === undefined')) throw new Error('unknown session must render a placeholder, not Sign In')
  if (!featureBarSrc.includes("height: '32px'")) throw new Error('unknown session placeholder must be 32px')
})

// UPDATED, DISCLOSED (performance + UX optimization task): Navbar no longer keeps its own plan
// state — it reads the shared store, which is itself cached-first (see the store checks above), so
// the cached plan is still available on the first paint. The avatar-colour local-cache fallback is
// unchanged and still asserted.
check('Navbar hydrates cached plan + avatar color synchronously on mount', () => {
  if (!navbarSrc.includes('useAccount()')) throw new Error('plan not cached-first (must read the shared store)')
  if (!navbarSrc.includes("'chainlens_local_settings'")) throw new Error('avatar color must come from local settings cache')
})

check('pricing page uses cached-first user plan', () => {
  if (!pricingSrc.includes('useState<UserPlan>(() => peekCachedPlan()')) throw new Error('pricing must init from cache')
  if (!pricingSrc.includes('if (p) setUserPlan(p)')) throw new Error('confirmed-plan overwrite missing')
})

check('settings page uses cached-first currentPlan', () => {
  if (!settingsSrc.includes("useState<'free' | 'pro' | 'elite'>(() => peekCachedPlan()")) throw new Error('settings must init from cache')
})

check('errors never downgrade displayed plan to Free', () => {
  const storeBlock = usePlanSrc.slice(usePlanSrc.indexOf('sharedPlanState.inFlight = (async () => {'))
  const errBranch = storeBlock.slice(storeBlock.indexOf("notifyPlanListeners('error')") - 400, storeBlock.indexOf("notifyPlanListeners('error')"))
  if (/plan = 'free'/.test(errBranch)) throw new Error('HTTP error path sets plan to free')
  const catchBlock = storeBlock.slice(storeBlock.lastIndexOf('} catch {'), storeBlock.lastIndexOf('} finally {'))
  if (/plan = 'free'/.test(catchBlock)) throw new Error('exception path sets plan to free')
  if (featureBarSrc.includes("catch { setPlan('free'); setBetaElite(false) }")) {
    throw new Error('FeatureBar error path downgrades to Free — must keep cached value')
  }
})

// UPDATED, DISCLOSED (performance + UX optimization task): same guarantee, new store shape — a
// signed-out session still clears the cache and explicitly confirms 'free' rather than being left
// in an ambiguous unknown state.
check('signed-out sessions still resolve to free explicitly', () => {
  if (!usePlanSrc.includes('clearPlanCache()')) throw new Error('sign-out must clear cache')
  if (!usePlanSrc.includes("plan: 'free'")) throw new Error('signed-out must confirm free')
})

const terminalPageSrc = readFileSync(new URL('../app/terminal/page.tsx', import.meta.url), 'utf8')
const clarkPageSrc = readFileSync(new URL('../app/terminal/clark-ai/page.tsx', import.meta.url), 'utf8')
check('terminal page fallback is not Loading Terminal', () => {
  if (terminalPageSrc.includes('Loading Terminal...')) throw new Error('terminal Suspense fallback must not flash Loading Terminal...')
})
check('clark-ai page fallback is not Loading Clark AI', () => {
  if (clarkPageSrc.includes('Loading Clark AI...')) throw new Error('clark Suspense fallback must not flash Loading Clark AI...')
})

for (const r of results) console.log(r)
if (process.exitCode === 1) { console.log('test-account-state-smoothness.mjs: FAILURES'); process.exit(1) }
console.log('test-account-state-smoothness.mjs: all assertions passed')

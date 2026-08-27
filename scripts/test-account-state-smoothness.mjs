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

check('usePlan() no longer initializes to guessed Free', () => {
  const fnBody = usePlanSrc.slice(usePlanSrc.indexOf('export function usePlan('), usePlanSrc.indexOf('export function usePlanWithLoading'))
  if (/useState<UserPlan>\('free'\)/.test(fnBody)) throw new Error('usePlan still guesses Free')
  if (!fnBody.includes('subscribeToSharedPlan')) throw new Error('usePlan must use shared store')
})

check('usePlanWithLoading starts from cached verified plan', () => {
  const fnBody = usePlanSrc.slice(usePlanSrc.indexOf('export function usePlanWithLoading'))
  if (!fnBody.includes('useState<UserPlan | null>(() => peekCachedPlan())')) throw new Error('must init from peekCachedPlan()')
  if (!fnBody.includes('plan ?? peekCachedPlan()')) throw new Error('return path must consult cache before free')
})

check('usePlanWithLoading does not hang Pump Alerts when plan cache exists', () => {
  const fnBody = usePlanSrc.slice(usePlanSrc.indexOf('export function usePlanWithLoading'))
  if (!fnBody.includes('useState(() => peekCachedPlan() == null)')) throw new Error('loading must start false when cache exists')
  if (!fnBody.includes('AbortSignal.timeout(8_000)')) throw new Error('user-settings fetch must abort after 8s')
  if (!fnBody.includes('TOKEN_REFRESHED')) throw new Error('token refresh must not block the page on Loading plan access')
})

check('FeatureBar uses cached-first plan init', () => {
  if (!featureBarSrc.includes('peekCachedPlan()')) throw new Error('FeatureBar must init from peekCachedPlan()')
  if (featureBarSrc.includes("peekCachedPlan() ?? ('free'")) throw new Error('FeatureBar must not guess Free on mount')
  if (!featureBarSrc.includes('subscribeToSharedPlan')) throw new Error('FeatureBar must use the shared plan store')
  if (!featureBarSrc.includes('ensurePlanLoaded')) throw new Error('FeatureBar must call ensurePlanLoaded')
})

check('FeatureBar does not treat unknown session as Sign In', () => {
  if (!featureBarSrc.includes('useState<string | null | undefined>(undefined)')) throw new Error('accountEmail must start undefined, not null')
  if (!featureBarSrc.includes('accountEmail === undefined')) throw new Error('unknown session must render a placeholder, not Sign In')
  if (!featureBarSrc.includes("height: '32px'")) throw new Error('unknown session placeholder must be 32px')
})

check('Navbar hydrates cached plan + avatar color synchronously on mount', () => {
  if (!navbarSrc.includes('useState<UserPlan | null>(() => peekCachedPlan())')) throw new Error('plan not cached-first')
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

check('signed-out sessions still resolve to free explicitly', () => {
  if (!usePlanSrc.includes('clearPlanCache()')) throw new Error('sign-out must clear cache')
  if (!usePlanSrc.includes("sharedPlanState.plan = 'free'")) throw new Error('signed-out must confirm free')
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

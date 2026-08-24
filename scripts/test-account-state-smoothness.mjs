// Account-state smoothness / perceived-performance regression tests.
// Verifies the no-wrong-state-first contract by source inspection of the exact
// files changed in this task:
//   1. No consumer initializes plan state to a guessed 'free'.
//   2. Shared singleflight plan store exists and is used (deduped fetches).
//   3. Navbar hydrates profile color from the local settings cache on mount.
//   4. Pricing renders static cards without gating the whole page on planReady.
//   5. Settings uses cached-first plan init (no Free→Elite flicker).
//   6. Errors never downgrade the displayed plan to Free.
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
  // Never returns a bare guessed free while unknown: falls back through cache first.
  if (!fnBody.includes("plan ?? peekCachedPlan()")) throw new Error('return path must consult cache before free')
})

check('FeatureBar uses cached-first plan init', () => {
  if (!featureBarSrc.includes("useState<UserPlan>(() => peekCachedPlan()")) throw new Error('FeatureBar still guesses Free on mount')
})

check('Navbar hydrates cached plan + avatar color synchronously on mount', () => {
  if (!navbarSrc.includes('useState<UserPlan | null>(() => peekCachedPlan())')) throw new Error('plan not cached-first')
  if (!navbarSrc.includes("'chainlens_local_settings'")) throw new Error('avatar color must come from local settings cache')
})

check('pricing page uses cached-first user plan', () => {
  if (!pricingSrc.includes("useState<UserPlan>(() => peekCachedPlan()")) throw new Error('pricing must init from cache')
  // Backend refresh only overwrites when it confirms a different plan:
  if (!pricingSrc.includes('if (p) setUserPlan(p)')) throw new Error('confirmed-plan overwrite missing')
})

check('settings page uses cached-first currentPlan', () => {
  if (!settingsSrc.includes("useState<'free' | 'pro' | 'elite'>(() => peekCachedPlan()")) throw new Error('settings must init from cache')
})

check('errors never downgrade displayed plan to Free', () => {
  // In the shared store, the HTTP-error and catch branches must only notify — never
  // overwrite sharedPlanState.plan with 'free'. (The signed-out branch MAY, since no
  // session is a confirmed state.)
  const storeBlock = usePlanSrc.slice(usePlanSrc.indexOf('sharedPlanState.inFlight = (async () => {'))
  const errBranch = storeBlock.slice(storeBlock.indexOf("notifyPlanListeners('error')") - 400, storeBlock.indexOf("notifyPlanListeners('error')"))
  if (/plan = 'free'/.test(errBranch)) throw new Error('HTTP error path sets plan to free')
  const catchBlock = storeBlock.slice(storeBlock.lastIndexOf("} catch {"), storeBlock.lastIndexOf("} finally {"))
  if (/plan = 'free'/.test(catchBlock)) throw new Error('exception path sets plan to free')
  // FeatureBar catch block: no silent downgrade either.
  if (featureBarSrc.includes("catch { setPlan('free'); setBetaElite(false) }")) {
    throw new Error('FeatureBar error path downgrades to Free — must keep cached value')
  }
})

check('signed-out sessions still resolve to free explicitly', () => {
  // Signed-out is a CONFIRMED state (no session) — allowed to show Free.
  if (!usePlanSrc.includes("clearPlanCache()")) throw new Error('sign-out must clear cache')
  if (!usePlanSrc.includes("sharedPlanState.plan = 'free'")) throw new Error('signed-out must confirm free')
})

for (const r of results) console.log(r)
if (process.exitCode === 1) { console.log('test-account-state-smoothness.mjs: FAILURES'); process.exit(1) }
console.log('test-account-state-smoothness.mjs: all assertions passed')

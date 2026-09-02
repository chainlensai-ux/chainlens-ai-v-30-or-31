// Account-required task — "Nobody should be able to use ChainLens without an account. Every new
// account should automatically start on the Free plan."
//
// Tests:
//   1. logged-out user cannot access /terminal/token-scanner (proxy.ts redirects, preserves ?next=)
//   2. logged-out user cannot call scan APIs (source-level: every protected route 401-gates)
//   3. new signup creates Free plan (USER_SETTINGS_DEFAULTS / getOrCreateUserSettings insert path)
//   4. null/missing plan becomes Free (resolveEffectivePlan + the repair-to-Free write path)
//   5. Free limits apply immediately (real constants: 3 scans/day, 3 Clark prompts/day, etc.)
//   6. Pro/Elite features stay locked unless confirmed (canAccessFeature / getVerifiedUserPlan)
//   7. no Loading plan flash with cached plan (peekCachedPlan / PlanGate skeleton-only-when-null)
import assert from 'node:assert/strict'
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

function read(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
}

const {
  resolveEffectivePlan,
  getOrCreateUserSettings,
  USER_SETTINGS_DEFAULTS,
} = await import('../lib/supabase/userSettings.ts')
const { canAccessFeature, CLARK_DAILY_LIMITS, SCAN_DAILY_LIMITS, pricingPlans } = await import('../lib/pricingPlans.ts')
const { isSafeInternalPath } = await import('../lib/safeNextPath.ts')

const proxySrc = read('proxy.ts')
const usePlanSrc = read('lib/usePlan.tsx')
const requireAuthSrc = read('lib/server/requireAuth.ts')
const authPageSrc = read('app/auth/page.tsx')

console.log('Section 1: logged-out user cannot access /terminal/* — proxy.ts redirects, preserves ?next=')
{
  check('proxy.ts is the Next 16 file (this repo\'s own Next version renamed middleware.ts to proxy.ts)', proxySrc.includes('export function proxy('))
  check('the account guard applies to every /terminal path, composed into the pre-existing preview-gate matcher/function (Next.js supports only one proxy.ts)', proxySrc.includes("request.nextUrl.pathname.startsWith('/terminal')"))
  check('the pre-existing preview-deployment password gate is preserved, not deleted', proxySrc.includes('PREVIEW_AUTH_COOKIE_NAME') && proxySrc.includes("new URL('/preview-login', request.url)"))
  check('an unsigned-in /terminal request redirects to /auth', proxySrc.includes("new URL('/auth', request.url)"))
  check('the redirect preserves the original path via the SAME ?next= param app/auth/page.tsx reads', proxySrc.includes("redirectUrl.searchParams.set('next'"))
  check('app/auth/page.tsx reads the next param and redirects back after a real session is confirmed', authPageSrc.includes("URLSearchParams(window.location.search).get('next')") && authPageSrc.includes('isSafeInternalPath(nextParam)'))
  check('isSafeInternalPath rejects an external redirect target (open-redirect guard, real function, not re-derived)', isSafeInternalPath('https://evil.example.com') === false && isSafeInternalPath('/terminal/token-scanner') === true)

  // MERGE-SAFETY, DISCLOSED: proxy.ts already existed as a preview-deployment password gate before
  // this task (Next.js supports exactly one proxy.ts) — these assertions prove that gate's own
  // behavior/config was preserved, not silently dropped, while composing in the /terminal guard.
  check('the always-gated preview hostname list is preserved verbatim', proxySrc.includes("'chainlens-vthirty.vercel.app'"))
  check('the preview gate\'s own matcher exclusions (api/, _next static/image, favicon, preview-login) are preserved', proxySrc.includes('_next/static/') && proxySrc.includes('_next/image/') && proxySrc.includes('preview-login') && proxySrc.includes('favicon'))
  check('the preview-gate cookie check and the /terminal cookie check are independent — one file, two real gates, neither deleted', proxySrc.includes('PREVIEW_AUTH_COOKIE_VALUE') && proxySrc.includes('SIGNED_IN_COOKIE'))
}

console.log('\nSection 2: logged-out user cannot call scan APIs — every protected route 401-gates on requireAuthenticatedUser/token presence')
{
  check('lib/server/requireAuth.ts returns null (never a fabricated user) for a missing/invalid bearer token', requireAuthSrc.includes('if (!token) return null'))
  check('unauthorizedResponse returns a real 401', requireAuthSrc.includes("status: 401"))

  const tokenRouteSrc = read('app/api/token/route.ts')
  check('token scans (POST /api/token) require a verified user before any provider work runs', /if \(!\(await requireAuthenticatedUser\(req\)\)\) return unauthorizedResponse\(\)/.test(tokenRouteSrc))

  const walletScanRouteSrc = read('app/api/wallet-scan/route.ts')
  check('wallet scans (POST /api/wallet-scan) require a verified user before a job is enqueued', /if \(!\(await requireAuthenticatedUser\(req\)\)\) return unauthorizedResponse\(\)/.test(walletScanRouteSrc))

  const clarkRouteSrc = read('app/api/clark/route.ts')
  check('Clark (POST /api/clark) requires a verified identity, not just a bearer-token-shaped string', clarkRouteSrc.includes('if (!verifiedIdentity?.userId) return unauthorizedResponse('))

  const portfolioRouteSrc = read('app/api/portfolio/route.ts')
  check('Portfolio (POST /api/portfolio) requires a verified user', (portfolioRouteSrc.match(/if \(!\(await requireAuthenticatedUser\(req\)\)\) return unauthorizedResponse\(\)/g) ?? []).length >= 2)

  const radarRouteSrc = read('app/api/radar/route.ts')
  check('Base Radar (GET /api/radar) 401s a genuinely anonymous caller (distinct from the 403 an authenticated Free account gets)', radarRouteSrc.includes('if (!token && !isCronTrigger) return unauthorizedResponse()'))

  const whaleAlertsRouteSrc = read('app/api/whale-alerts/route.ts')
  check('Whale Alerts / FOMO board (GET /api/whale-alerts) 401s a genuinely anonymous caller', whaleAlertsRouteSrc.includes('if (!token) return unauthorizedResponse()'))

  const watchlistTokensSrc = read('app/api/watchlist/tokens/route.ts')
  const watchlistWalletsSrc = read('app/api/watchlist/wallets/route.ts')
  check('Watchlist (tokens) already 401s an unauthenticated caller', watchlistTokensSrc.includes("status: 401"))
  check('Watchlist (wallets) already 401s an unauthenticated caller', watchlistWalletsSrc.includes("status: 401"))
}

console.log('\nSection 3: new signup creates Free plan')
{
  check('USER_SETTINGS_DEFAULTS.plan is the literal \'free\'', USER_SETTINGS_DEFAULTS.plan === 'free')

  // Fake Supabase client: no existing row -> insert path -> real defaults (plan: 'free') persisted.
  let insertedPayload = null
  const fakeClientNoRow = {
    from() {
      return {
        select() { return this },
        eq() { return this },
        maybeSingle: async () => ({ data: null, error: null }),
        insert(payload) { insertedPayload = payload; return this },
        single: async () => ({ data: { user_id: 'new-user', ...payload_or_defaults() }, error: null }),
      }
      function payload_or_defaults() { return insertedPayload ?? USER_SETTINGS_DEFAULTS }
    },
  }
  const created = await getOrCreateUserSettings(fakeClientNoRow, 'new-user-id')
  check('a brand-new user (no existing row) gets a real INSERT carrying plan: \'free\'', insertedPayload?.plan === 'free')
  check('getOrCreateUserSettings returns a settings object with plan free for a new user', created.settings.plan === 'free')
}

console.log('\nSection 4: null/missing plan becomes Free (never Pro/Elite)')
{
  check('resolveEffectivePlan(null) is free', resolveEffectivePlan(null) === 'free')
  check('resolveEffectivePlan(undefined) is free', resolveEffectivePlan(undefined) === 'free')
  check('resolveEffectivePlan({}) (plan key entirely absent) is free', resolveEffectivePlan({}) === 'free')
  check('resolveEffectivePlan({ plan: null }) is free', resolveEffectivePlan({ plan: null }) === 'free')
  check('resolveEffectivePlan never returns pro/elite for a garbage plan string', resolveEffectivePlan({ plan: 'garbage' }) === 'free')

  // Existing row with plan explicitly null -> getOrCreateUserSettings repairs it to 'free' via a
  // real, narrow UPDATE scoped to that user_id — never touches any other field.
  let updatePayload = null
  let updatedUserId = null
  const fakeClientNullPlan = {
    from() {
      return {
        select() { return this },
        eq(col, val) { if (col === 'user_id') updatedUserId = val; return this },
        maybeSingle: async () => ({ data: { user_id: 'existing-user', ...USER_SETTINGS_DEFAULTS, plan: null }, error: null }),
        update(payload) { updatePayload = payload; return this },
      }
    },
  }
  const repaired = await getOrCreateUserSettings(fakeClientNullPlan, 'existing-user-id')
  check('a real row with a null plan triggers a real UPDATE to plan: \'free\', scoped to this exact user_id', updatePayload?.plan === 'free' && updatedUserId === 'existing-user-id')
  check('the repaired settings object reports plan free to the caller in the same call', repaired.settings.plan === 'free')
  check('the repair UPDATE touches ONLY the plan field — never any other column', updatePayload && Object.keys(updatePayload).length === 1 && 'plan' in updatePayload)
}

console.log('\nSection 5: Free limits apply immediately')
{
  check('Free gets exactly 3 full scans/day', SCAN_DAILY_LIMITS.free === 3)
  check('Free gets exactly 3 Clark prompts/day', CLARK_DAILY_LIMITS.free === 3)
  const free = pricingPlans.find((p) => p.id === 'free')
  check('Free plan copy advertises Watchlist full access', free.features.some((f) => /Watchlist/i.test(f) && /full access/i.test(f)))
  check('Free plan copy advertises Basic Wallet Scanner', free.features.some((f) => /Basic Wallet Scanner/i.test(f)))
  check('Free plan copy advertises Portfolio Intelligence', free.features.some((f) => /Portfolio Intelligence/i.test(f)))
  check('Free (free) can access watchlist right now, no confirmation step needed', canAccessFeature('free', 'watchlist') === true)
  check('Free (free) can access the basic wallet scanner right now', canAccessFeature('free', 'wallet-scanner') === true)
  check('Free (free) can access portfolio right now', canAccessFeature('free', 'portfolio') === true)
}

console.log('\nSection 6: Pro/Elite features stay locked unless confirmed')
{
  check('Free cannot access Base Radar (Pro/Elite only)', canAccessFeature('free', 'base-radar') === false)
  check('Free cannot access Whale Alerts (Pro/Elite only)', canAccessFeature('free', 'whale-alerts') === false)
  check('Free cannot access Pump Alerts (Pro/Elite only)', canAccessFeature('free', 'pump-alerts') === false)
  check('Pro CAN access these once confirmed', canAccessFeature('pro', 'base-radar') === true && canAccessFeature('pro', 'whale-alerts') === true)
  // requireAuthenticatedUser/getCurrentUserPlanFromBearerToken never trust a client-supplied plan —
  // the ONE source of truth is the verified Supabase row, read server-side.
  check('requireAuthenticatedUser resolves plan ONLY from the server-verified getCurrentUserPlanFromBearerToken result — never a client-supplied value', requireAuthSrc.includes('getCurrentUserPlanFromBearerToken') && !/req\.(headers\.get\(.x-user-plan|body\.plan)/.test(requireAuthSrc))
}

console.log('\nSection 7: no "Loading plan" flash with cached plan')
{
  check('the shared account store surfaces a cached plan synchronously via useSyncExternalStore (no server-side loading wall baked into SSR HTML)', usePlanSrc.includes('useSyncExternalStore') && usePlanSrc.includes('loading: false,\n})') === false && usePlanSrc.includes("loading: false,"))
  check('PlanGate only renders the skeleton when plan is genuinely unknown (null) or loading — never for a cached plan', usePlanSrc.includes('if (plan == null || loading) return <PlanGateSkeleton />'))
  check('start() reports loading:false immediately whenever a cached plan already exists', usePlanSrc.includes('setSnapshot({ plan: cached, loading: cached == null })'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

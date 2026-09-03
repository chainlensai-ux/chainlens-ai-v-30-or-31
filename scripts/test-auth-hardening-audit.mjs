// Auth hardening audit — complements scripts/test-account-required-gating.mjs (which already
// covers /terminal gating, the original 4 guarded routes, Free-plan defaults, and null-plan
// repair). This file covers the NEW gaps closed by this task:
//   - previously-unauthenticated scan/history endpoints now 401-gate
//   - duplicate-account / email-normalization behavior on sign up and sign in
//   - forgot-password / reset-password flow correctness
//   - open-redirect protection (real function calls, not just source greps)
//   - FOMO/whale Elite-only gating
//   - RLS scoping for user_settings/watchlist and the legacy profiles table lockdown
//   - dead insecure auth code removed
import fs from 'node:fs'

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${label}`) }
}

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

// ── Section 1: newly-guarded scan/history/save endpoints ───────────────────────────────────
console.log('\nSection 1: previously-open scan/history endpoints now require sign-in')
{
  const guardRe = /if \(!\(await requireAuthenticatedUser\(req(?:uest)?\)\)\) return unauthorizedResponse\(\)/
  const routes = [
    '../app/api/scan/route.ts',
    '../app/api/scan-v2/route.ts',
    '../app/api/scan-v2/modules/behavior-intel/route.ts',
    '../app/api/scan-v2/modules/bridge-timeline/route.ts',
    '../app/api/scan-v2/modules/chain-selection/route.ts',
    '../app/api/scan-v2/modules/final-summary/route.ts',
    '../app/api/scan-v2/modules/holdings/route.ts',
    '../app/api/scan-v2/modules/metadata/route.ts',
    '../app/api/scan-v2/modules/portfolio/route.ts',
    '../app/api/scan-v2/modules/recovery-policy/route.ts',
    '../app/api/scan-v2/modules/timelines/route.ts',
    '../app/api/scan-v2/modules/window-coverage/route.ts',
    '../app/api/scan-v2/full-scan-job/start/route.ts',
    '../app/api/scan-v2/full-scan-job/status/route.ts',
    '../app/api/scan-v2/full-scan/legacy/route.ts',
    '../app/api/pnl/route.ts',
    '../app/api/transactions/route.ts',
    '../app/api/trade-ledger/route.ts',
    '../app/api/base-radar/route.ts',
    '../app/api/base-radar/enrichment/route.ts',
    '../app/api/whale-alerts/tracked-wallets/route.ts',
  ]
  for (const route of routes) {
    const src = read(route)
    check(`${route.replace('../app/api/', '/api/')} imports requireAuthenticatedUser + unauthorizedResponse`, src.includes("from '@/lib/server/requireAuth'") || src.includes('from "@/lib/server/requireAuth"'))
    check(`${route.replace('../app/api/', '/api/')} guards its handler before doing any real work`, guardRe.test(src))
  }

  // full-scan-edge stays deliberately import-free (its own header says "no imports, no shared
  // code, and no direct scanner work") — it must forward the caller's Authorization header to the
  // now-guarded upstream route instead of duplicating auth logic.
  const edgeSrc = read('../app/api/scan-v2/full-scan-edge/route.ts')
  check('full-scan-edge stays import-free (no requireAuth import, per its own isolation design)', !edgeSrc.includes("from '@/lib/server/requireAuth'"))
  check('full-scan-edge forwards the Authorization header to the guarded upstream route', edgeSrc.includes("req.headers.get('authorization')") && edgeSrc.includes("headers.set('authorization', authorization)"))
}

// ── Section 2: duplicate accounts / email normalization ────────────────────────────────────
console.log('\nSection 2: same email cannot create multiple accounts; casing does not bypass this')
{
  const signupSrc = read('../app/api/auth/signup/route.ts')
  const loginSrc = read('../app/api/auth/login/route.ts')
  const authPageSrc = read('../app/auth/page.tsx')

  check('signup route normalizes email (trim + lowercase) before calling supabase.auth.signUp', /email:\s*email\.trim\(\)\.toLowerCase\(\)/.test(signupSrc))
  check('login route normalizes email (trim + lowercase) before calling supabase.auth.signInWithPassword', /email:\s*email\.trim\(\)\.toLowerCase\(\)/.test(loginSrc))
  check('client-side auth form also normalizes email before submit (defense in depth)', (authPageSrc.match(/email\.trim\(\)\.toLowerCase\(\)/g) ?? []).length >= 1)

  // Anti-enumeration: an "already registered" signup response must be indistinguishable from a
  // fresh signup — otherwise an attacker could probe arbitrary emails to find existing accounts,
  // and a naive "just tell them" fix would violate "never reveal whether an email exists".
  check('signup route responds identically for an existing email as for a genuine new signup (no enumeration)', /already registered|already exists/.test(signupSrc) && /return NextResponse\.json\(\{ ok: true, requiresEmailVerification: true \}\)/.test(signupSrc))

  // Server-side normalization must not depend on the client having done it correctly — the route
  // itself must re-normalize whatever the client sent.
  check('signup route re-normalizes server-side rather than trusting the client-sent email verbatim', signupSrc.includes('email.trim().toLowerCase()'))
}

// ── Section 3: sign-in error messages never leak account existence ─────────────────────────
console.log('\nSection 3: sign-in errors stay generic — no password/email-exists leakage')
{
  const loginSrc = read('../app/api/auth/login/route.ts')
  check('a failed sign-in returns one generic message, not a Supabase-specific one that could distinguish wrong-password from no-such-account', loginSrc.includes("error: 'Invalid email or password.'"))
  check('login route never echoes a raw Supabase error message straight to the client', !/NextResponse\.json\(\{\s*error:\s*signInError\.message/.test(loginSrc))
}

// ── Section 4: forgot-password / reset-password flow ────────────────────────────────────────
console.log('\nSection 4: forgot-password sends a reset email; reset-password validates the link and handles expiry safely')
{
  const authPageSrc = read('../app/auth/page.tsx')
  const resetPageSrc = read('../app/reset-password/page.tsx')

  check('forgot-password calls supabase.auth.resetPasswordForEmail with a normalized email', /resetPasswordForEmail\(cleanEmail/.test(authPageSrc))
  check('forgot-password redirect target is built through authRedirectUrl (validated, not a raw string concat)', authPageSrc.includes('authRedirectUrl(window.location.origin'))
  check('forgot-password success message never confirms whether the account exists', /If this email has an account/.test(authPageSrc))

  check('reset-password page requires real recovery intent (URL param or forwarded marker) before ever showing the form', resetPageSrc.includes('hasRecoveryIntent(url)') && resetPageSrc.includes("sessionStorage.getItem('cl_password_recovery')"))
  check('reset-password page has a bounded timeout so an invalid/expired link cannot spin forever', /setTimeout\(\(\) => \{[\s\S]*?setStatus\('error'\)/.test(resetPageSrc) && /,\s*8000\)/.test(resetPageSrc))
  check('reset-password page shows a clean, actionable error for an invalid/expired link', /invalid or has expired/.test(resetPageSrc))
  check('reset-password page signs out the recovery session after a successful password change (cannot be replayed)', resetPageSrc.includes("signOut({ scope: 'local' })"))
  check('reset-password page enforces the same password policy as signup', /meetsPasswordPolicy|checkPasswordPolicy/.test(resetPageSrc))
}

// ── Section 5: open-redirect protection — real function calls, not source greps ────────────
console.log('\nSection 5: isSafeInternalPath rejects every open-redirect shape')
{
  const { isSafeInternalPath } = await import('../lib/safeNextPath.ts')
  check('rejects absolute external URL', isSafeInternalPath('https://evil.example.com/phish') === false)
  check('rejects protocol-relative URL', isSafeInternalPath('//evil.example.com') === false)
  check('rejects backslash-normalization bypass', isSafeInternalPath('/\\evil.example.com') === false)
  check('rejects empty string', isSafeInternalPath('') === false)
  check('rejects null/undefined', isSafeInternalPath(null) === false && isSafeInternalPath(undefined) === false)
  check('rejects a bare relative path with no leading slash', isSafeInternalPath('terminal/token-scanner') === false)
  check('accepts a genuine internal path', isSafeInternalPath('/terminal/token-scanner') === true)
  check('accepts an internal path with a query string', isSafeInternalPath('/terminal?tab=holdings') === true)

  // Every real consumer of a "next" param must route through this same validator.
  const authPageSrc = read('../app/auth/page.tsx')
  const callbackSrc = read('../app/auth/callback/page.tsx')
  check('app/auth/page.tsx validates next via isSafeInternalPath before redirecting', (authPageSrc.match(/isSafeInternalPath\(/g) ?? []).length >= 2)
  check('app/auth/callback/page.tsx validates next via isSafeInternalPath before redirecting', callbackSrc.includes('isSafeInternalPath('))
}

// ── Section 6: FOMO/whale Elite-only gating ─────────────────────────────────────────────────
console.log('\nSection 6: Free-plan/unauthenticated users cannot reach Elite-only FOMO data')
{
  const { canAccessFomoBoard } = await import('../lib/pricingPlans.ts')
  check('canAccessFomoBoard(null) — unauthenticated — is false', canAccessFomoBoard(null) === false)
  check("canAccessFomoBoard('free') is false", canAccessFomoBoard('free') === false)
  check("canAccessFomoBoard('pro') is false (Elite-only board)", canAccessFomoBoard('pro') === false)
  check("canAccessFomoBoard('elite') is true", canAccessFomoBoard('elite') === true)

  const leaderboardSrc = read('../app/api/fomo/leaderboard/route.ts')
  check('the FOMO leaderboard route resolves plan from a server-verified source, not a client-supplied value', leaderboardSrc.includes('getVerifiedUserPlan(request)'))
  check('the FOMO leaderboard route rejects when access.allowed is false, before returning any board data', /if \(!access\.allowed\) \{\s*return NextResponse\.json\(access\.body, \{ status: access\.status \}\)/.test(leaderboardSrc))
}

// ── Section 7: RLS scoping — user_settings, watchlist, and the legacy profiles lockdown ────
console.log('\nSection 7: RLS prevents reading/writing another user\'s data; plan can only change server-side')
{
  const rlsSrc = read('../docs/supabase-rls-security.sql')
  check('user_settings SELECT policy is scoped to auth.uid() = user_id', /for select\s*\n?\s*using \(auth\.uid\(\) = user_id\)/.test(rlsSrc))
  check('user_settings INSERT policy forces plan = \'free\' on first row (no self-elevated signup row)', /for insert[\s\S]*?and plan = 'free'/.test(rlsSrc))
  check('user_settings UPDATE policy blocks changing plan (self-upgrade prevented)', rlsSrc.includes('plan is not distinct from (') && rlsSrc.includes('select plan from public.user_settings where user_id = auth.uid()'))

  const watchlistTokensSrc = read('../docs/supabase-watchlist-tokens.sql')
  const watchlistWalletsSrc = read('../docs/supabase-watchlist-wallets.sql')
  check('watchlist_tokens rows are scoped to the owning user', watchlistTokensSrc.includes('auth.uid() = user_id'))
  check('watchlist_wallets rows are scoped to the owning user', watchlistWalletsSrc.includes('auth.uid() = user_id'))

  const legacyLockdownSrc = read('../docs/supabase-legacy-profiles-lockdown.sql')
  check('legacy profiles lockdown migration exists and is safe to re-run (guards on table existence)', legacyLockdownSrc.includes("to_regclass('public.profiles') is null"))
  check('legacy profiles lockdown drops the old unrestricted FOR ALL policy', legacyLockdownSrc.includes('drop policy if exists "profiles_own" on public.profiles'))
  check('legacy profiles lockdown UPDATE policy blocks changing plan directly', /plan is not distinct from \(select plan from public\.profiles where id = auth\.uid\(\) limit 1\)/.test(legacyLockdownSrc))
}

// ── Section 8: service-role key never reaches the client ───────────────────────────────────
console.log('\nSection 8: no service-role/secret key is ever assigned to a NEXT_PUBLIC_ variable')
{
  const clientSrc = read('../lib/supabaseClient.ts')
  check('the browser Supabase client only reads NEXT_PUBLIC_SUPABASE_URL/ANON_KEY', clientSrc.includes('NEXT_PUBLIC_SUPABASE_URL') && clientSrc.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY') && !clientSrc.includes('SERVICE_ROLE'))

  const userSettingsSrc = read('../lib/supabase/userSettings.ts')
  check('the service-role client reads SUPABASE_SERVICE_ROLE_KEY (never NEXT_PUBLIC_-prefixed)', userSettingsSrc.includes('process.env.SUPABASE_SERVICE_ROLE_KEY') && !userSettingsSrc.includes('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY') && !userSettingsSrc.includes('NEXT_PUBLIC_SERVICE_ROLE'))
}

// ── Section 9: dead, insecure auth code removed ─────────────────────────────────────────────
console.log('\nSection 9: the old unguarded AuthForm/lib/auth.ts (no normalization, no rate limit, raw error messages) is gone')
{
  check('components/AuthForm.tsx no longer exists', !fs.existsSync(new URL('../components/AuthForm.tsx', import.meta.url)))
  check('lib/auth.ts no longer exists', !fs.existsSync(new URL('../lib/auth.ts', import.meta.url)))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

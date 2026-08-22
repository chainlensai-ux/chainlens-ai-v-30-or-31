// TESTS — Login-time affiliate attribution.
//
// Feature, DISCLOSED: requested "if somebody logs in with that link it saves to their account so
// if they buy it 100 percent goes through." Before this, the ONLY place a referral got permanently
// attached to an account was inside /api/checkout/crypto, which only runs at the moment someone
// starts a purchase. If a visitor's cookie/localStorage was lost between signing up and eventually
// buying (cleared cookies, a different device, a different browser), the referral was gone even
// though they genuinely did follow the affiliate's link. This adds a second, earlier capture point
// — the moment a session exists at all, via SupabaseProvider (the one place every sign-in path in
// the app already funnels through) — POSTing to the new /api/affiliate/attribute endpoint.
//
// Static source checks, matching this codebase's established pattern for regression-testing logic
// embedded in Next.js route handlers and client providers (see
// scripts/test-robinhood-liquidity-safety-chain.mjs, scripts/test-affiliate-apply-rate-limit.mjs).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const route = readFileSync(new URL('../app/api/affiliate/attribute/route.ts', import.meta.url), 'utf8')
const provider = readFileSync(new URL('../app/providers/SupabaseProvider.tsx', import.meta.url), 'utf8')

// ─── 1. The route requires real authentication ──────────────────────────────────────────────────
check('a missing bearer token is rejected with 401', /if \(!token\) return NextResponse\.json\(\{ error: 'Sign in required\.' \}, \{ status: 401 \}\)/.test(route))
check('the token is verified against Supabase auth, not merely present', route.includes('anon.auth.getUser(token)'))
check('identity used for self-referral comes from the VERIFIED user object, not client input', /userData\.user\.email/.test(route))

// ─── 2. First-referral-wins is checked BEFORE ever looking at the incoming code ─────────────────
const alreadyAttrIdx = route.indexOf("reason: 'already_attributed'")
const affLookupIdx = route.indexOf("from('affiliates')")
check('an already-attributed account short-circuits before any affiliate lookup runs', alreadyAttrIdx !== -1 && affLookupIdx !== -1 && alreadyAttrIdx < affLookupIdx)
check('the already-attributed check reads the real stored value, not a guess', route.includes("existingSettings as { referred_by_affiliate_id"))

// ─── 3. Same business gates as /api/checkout/crypto's fresh-code resolution ────────────────────
check('only an APPROVED affiliate can be attached — a pending/rejected code is never stored', /aff\.status !== 'approved'/.test(route))
check('self-referral (an affiliate using their own code) is rejected', /selfReferral/.test(route) && /affEmail === userEmail/.test(route))
check('the code is validated for shape before any lookup', /isValidReferralCode\(rawRef\)/.test(route))

// ─── 4. NOT a plain upsert — the whole point of this design ─────────────────────────────────────
// A plain .upsert() has no WHERE clause on its DO UPDATE half, so it would unconditionally
// overwrite an already-attributed buyer's original affiliate — silently breaking first-referral-
// wins. This is the single most important property of this file.
check('no plain upsert is used anywhere in this route', !route.includes('.upsert('))
check('the fallback path is an INSERT (only succeeds when the row does not yet exist)', /from\('user_settings'\)\s*\.insert\(/.test(route))
check('a 23505 (row already existed — lost the create race) falls back to the SAME guarded update as everyone else', /insertError\?\.code === '23505'/.test(route))

// Every write to referred_by_affiliate_id via UPDATE must carry the IS NULL guard.
const updateBlocks = [...route.matchAll(/\.update\(\{\s*referred_by_affiliate_id:[\s\S]{0,200}?\.is\('referred_by_affiliate_id', null\)/g)]
check('every UPDATE that sets referred_by_affiliate_id is guarded by .is(\'referred_by_affiliate_id\', null)', updateBlocks.length >= 2)

// ─── 5. Never claims success it cannot confirm ───────────────────────────────────────────────────
check('a genuine insert failure (not the benign race) is reported as not attributed, never as success', /insertError && insertError\.code !== '23505'[\s\S]{0,400}attributed: false/.test(route))

// ─── 6. Rate limited like every other public POST endpoint in this codebase ─────────────────────
check('the endpoint is rate limited', route.includes('createRateLimiter'))

// ─── 7. Client wiring — SupabaseProvider is the single hook point ───────────────────────────────
check('SupabaseProvider resolves a pending referral code from URL, then localStorage, then cookie — same priority as pricing/page.tsx', /url \?\? stored \?\? cookie/.test(provider))
check('the attribute call only fires once a real session (access_token) exists', /session\?\.access_token/.test(provider))
check('the attribute call sends the bearer token, proving the server-side identity check is real', /Authorization: `Bearer \$\{session\.access_token\}`/.test(provider))
check('a fire-once guard exists so a token refresh does not re-POST repeatedly in the same tab', /attributedThisSession/.test(provider))
check('a failure to attribute is swallowed, never surfaced as a user-facing error — checkout time remains the fallback', /catch\(\(\) => \{[\s\S]{0,120}fallback/.test(provider))
check('the endpoint is called with the correct path', provider.includes("'/api/affiliate/attribute'"))

console.log(`test-affiliate-login-attribution.mjs: all ${passed} assertions passed`)

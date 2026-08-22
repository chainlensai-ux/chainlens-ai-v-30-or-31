// TESTS — full affiliate system audit fixes.
//
// Four real bugs found and fixed while auditing the whole pipeline end to end:
//
// 1. admin/data — the per-affiliate leaderboard (checkout count, revenue, conversion rate) was
//    grouped by crypto_payments.referral_code, a field only set when a code happened to be present
//    in that one specific checkout request. affiliate_id (the durable attribution, resolved from
//    user_settings.referred_by_affiliate_id) is what's actually correct — and what
//    pendingCommissionOwed/paidCommissionUsd already correctly used. Any payment attributed via the
//    durable path (a renewal weeks later, or login-time attribution with no cookie left by
//    purchase time) was invisible to the leaderboard while still correctly counting toward money
//    owed — an internally inconsistent dashboard.
//
// 2. admin/actions — every .update() destructured `count` to detect a stale click (id doesn't
//    exist, or already in a different state) via `count === 0`, but none of the four calls passed
//    `{ count: 'exact' }` to actually request it from Supabase — so `count` was always `null`, the
//    check could never fire, and every action always reported success even when it silently
//    matched zero rows.
//
// 3. affiliate/me — commission totals (earnedTotalUsd, earnedPaidUsd, earnedPendingUsd,
//    conversions) were computed by summing a query capped at .limit(100) that ALSO fed the
//    recent-conversions display list. A founding affiliate with more than 100 commissions ever
//    would see their own dashboard undercount what they've earned.
//
// 4. affiliate/me — affiliates.email carries no unique constraint, so the same person can have
//    multiple application rows (e.g. rejected once, reapplied and approved later). The lookup used
//    to take the OLDEST row, so a real approved application could be permanently hidden behind an
//    older rejected one.
//
// Plus one robustness fix: lib/affiliate/referral.ts's readReferralCodeFromCookie could throw on a
// malformed cookie value (browser-controlled, not guaranteed well-formed), and
// /api/checkout/crypto calls it OUTSIDE its own try/catch — a single bad cookie could 500 checkout.
//
// Static source checks, matching this codebase's established pattern for regression-testing logic
// embedded in Next.js route handlers (see scripts/test-robinhood-liquidity-safety-chain.mjs).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readReferralCodeFromCookie } from '../lib/affiliate/referral.ts'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const adminData = readFileSync(new URL('../app/api/admin/data/route.ts', import.meta.url), 'utf8')
const adminActions = readFileSync(new URL('../app/api/admin/actions/route.ts', import.meta.url), 'utf8')
const affiliateMe = readFileSync(new URL('../app/api/affiliate/me/route.ts', import.meta.url), 'utf8')

// ─── 1. Admin leaderboard keyed by affiliate_id, not referral_code ──────────────────────────────
check('the per-affiliate payments query selects affiliate_id', /select\('affiliate_id, amount_usd, status, user_email'\)/.test(adminData))
check('the per-affiliate payments query filters on affiliate_id, not referral_code', adminData.includes(".not('affiliate_id', 'is', null)"))
// Scoped to real code lines only — the disclosure comment above the fix quotes the old filter for
// context, so a whole-file match would fail on the documentation of the fix itself.
const adminDataCode = adminData.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
check('the old referral_code-based filter is gone from real code', !adminDataCode.includes(".not('referral_code', 'is', null)"))
check('the aggregation map is keyed by affiliate id (affStats), not the old codeStats', adminData.includes('affStats') && !adminData.includes('codeStats'))
check('the leaderboard looks up stats by the affiliate\'s own id', /const stats = affStats\[id\]/.test(adminData))

// ─── 2. Admin actions actually request count, so the stale-click guard can fire ─────────────────
const updateCalls = [...adminData.matchAll(/\.update\(/g)] // sanity: adminData shouldn't have update calls at all (that's actions' job)
check('admin/data has no mutating .update() calls (read-only route)', updateCalls.length === 0)
const actionUpdates = [...adminActions.matchAll(/\.update\(\{[^}]*\},\s*\{\s*count:\s*'exact'\s*\}\)/g)]
check('all four admin actions (approve/reject/mark-paid/mark-pending) now request { count: \'exact\' }', actionUpdates.length === 4)
check('no admin action update omits the count option', !/\.update\(\{[^}]*\}\)\s*\n\s*\.eq/.test(adminActions))

// ─── 3. Affiliate dashboard totals are not capped by the display-list limit ─────────────────────
check('a separate, high-ceiling query drives the earnings totals', /allCommissionsRes[\s\S]{0,250}limit\(20_000\)/.test(affiliateMe))
check('the recent-conversions display query is the ONLY one capped at 10', /recentRes[\s\S]{0,250}limit\(10\)/.test(affiliateMe))
check('totals are summed from the uncapped row set, not the display-limited one', /sum\(allCommissionRows\)/.test(affiliateMe))
check('conversions count comes from the uncapped row set', /conversions: allCommissionRows\.length/.test(affiliateMe))

// ─── 4. Affiliate lookup picks the row that matters, not just the oldest ────────────────────────
check('the lookup no longer silently takes only the single oldest row', !affiliateMe.includes(".order('created_at', { ascending: true })\n    .limit(1)"))
check('an approved application always wins when one exists, regardless of age', /rows\.find\(\(r\) => r\.status === 'approved'\)/.test(affiliateMe))
check('a pending application is preferred over a rejected one when no approved row exists', /rows\.find\(\(r\) => r\.status === 'pending'\)/.test(affiliateMe))
check('every row for the email is fetched (no artificial single-row limit) so the right one can be picked', !/\.ilike\('email', email\)\s*\n\s*\.order\([^)]*\)\s*\n\s*\.limit\(1\)/.test(affiliateMe))

// ─── 5. Cookie parsing can never crash a caller ──────────────────────────────────────────────────
check('a well-formed cookie still parses correctly', readReferralCodeFromCookie('chainlens_affiliate_ref=cl1a2b3c4d') === 'cl1a2b3c4d')
check('a malformed percent-encoding in the cookie value returns null instead of throwing', (() => {
  try {
    const result = readReferralCodeFromCookie('chainlens_affiliate_ref=%E0%A4%A')
    return result === null
  } catch {
    return false // if it throws, the fix did not work
  }
})())
check('a cookie with an unterminated percent sequence also degrades gracefully', (() => {
  try {
    return readReferralCodeFromCookie('other=1; chainlens_affiliate_ref=%; more=2') === null
  } catch {
    return false
  }
})())

console.log(`test-affiliate-system-audit.mjs: all ${passed} assertions passed`)

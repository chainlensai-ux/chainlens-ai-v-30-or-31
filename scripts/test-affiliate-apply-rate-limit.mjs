// TEST — affiliate apply rate limiting.
//
// Regression, DISCLOSED: reported live via a screenshot showing "Too many requests. Please try
// again later." blocking a legitimate applicant. Root cause: a single 3/hour limiter was checked
// BEFORE the request body was parsed or validated, so every attempt — including a typo, an empty
// required field, or a retried double-click — consumed one of only 3 slots per hour. Three ordinary
// mistakes and a real applicant was hard-locked out with no way to submit.
//
// Static source check, matching this codebase's established pattern for regression-testing logic
// embedded in Next.js route handlers (see scripts/test-robinhood-liquidity-safety-chain.mjs).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const route = readFileSync(new URL('../app/api/affiliate/apply/route.ts', import.meta.url), 'utf8')

check('two separate limiters exist — a loose anti-flood guard and a real submission cap', /rawLimiter = createRateLimiter/.test(route) && /validatedLimiter = createRateLimiter/.test(route))
check('the anti-flood guard is generous, since it exists only to stop scripted abuse, not a human', /rawLimiter = createRateLimiter\(\{ windowMs: 3_600_000, max: 20 \}\)/.test(route))

// The real bug: verify the validated cap is checked strictly AFTER validation succeeds, not before.
const rawCheckIdx = route.indexOf('rawLimiter.check(ip)')
const validationIdx = route.indexOf('validateAffiliateApplication(body)')
const validatedCheckIdx = route.indexOf('validatedLimiter.check(ip)')
check('the raw flood guard runs first, before any parsing', rawCheckIdx !== -1 && rawCheckIdx < validationIdx)
check('the real submission cap is checked AFTER validation succeeds — never before, so mistakes are free', validatedCheckIdx !== -1 && validatedCheckIdx > validationIdx)

// The insert (the actual DB write / real submission) must happen after the validated-limiter check,
// proving the cap gates real submissions and isn't just decorative.
const insertIdx = route.indexOf("supabase.from('affiliates').insert")
check('the validated cap is enforced before the database insert it is meant to protect', validatedCheckIdx < insertIdx)

console.log(`test-affiliate-apply-rate-limit.mjs: all ${passed} assertions passed`)

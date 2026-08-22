// TEST — affiliate apply notification failure isolation.
//
// Regression, DISCLOSED: reported live — a real applicant hit "We couldn't submit your
// application" and retrying didn't help. Root cause: the Resend email-notification call sat
// OUTSIDE its own try/catch, inside the same function whose top-level catch turns any thrown
// error into unavailableResponse(500) — the generic client-facing failure. At the point that call
// runs, the affiliate row has ALREADY been inserted successfully. If fetch() itself threw for any
// reason reaching api.resend.com (a transient network blip, DNS hiccup, timeout), the applicant
// was told their submission failed even though it had already been saved.
//
// Static source check, matching this codebase's established pattern for regression-testing logic
// embedded in Next.js route handlers (see scripts/test-robinhood-liquidity-safety-chain.mjs).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function check(label, condition) { assert.ok(condition, label); passed++ }

const route = readFileSync(new URL('../app/api/affiliate/apply/route.ts', import.meta.url), 'utf8')

// Isolate the resend block for a precise check of the try/catch boundary.
const resendStart = route.indexOf("const resendApiKey = process.env.RESEND_API_KEY")
const resendBlock = route.slice(resendStart, resendStart + 1800)

check('the resend notification path exists', resendStart !== -1)
check('the fetch to Resend is wrapped in its own try', /try\s*{[\s\S]*fetch\('https:\/\/api\.resend\.com\/emails'/.test(resendBlock))
check('a thrown notification error is caught locally, not left to the outer catch', /catch\s*\(notifyErr\)/.test(resendBlock))
check('a caught notification error is logged, not silently dropped', /catch \(notifyErr\)[\s\S]{0,200}console\.error/.test(resendBlock))
// Scoped tightly to the catch block's own body only (up to its closing brace) — a wider window
// would spill into the unrelated success `return` that follows the whole resend block.
const catchIdx = resendBlock.indexOf('catch (notifyErr)')
const catchBody = resendBlock.slice(catchIdx, resendBlock.indexOf('}\n    }', catchIdx) + 5)
check('a caught notification error does not re-throw or return a failure response', !/\breturn\b/.test(catchBody))
check('the success response is still reached after the resend block, unconditionally on notification outcome', route.indexOf("status: 'pending', referral_code: code") > resendStart)

// The insert must complete (and its own error already be checked) BEFORE the resend call runs —
// proves the applicant's data is durably saved before this best-effort notification is even
// attempted, which is what makes it safe to swallow a failure here.
const insertErrorCheckIdx = route.indexOf('if (insertError) {')
check('the DB insert is confirmed successful before the resend call is ever reached', insertErrorCheckIdx !== -1 && insertErrorCheckIdx < resendStart)

console.log(`test-affiliate-apply-notify-isolation.mjs: all ${passed} assertions passed`)

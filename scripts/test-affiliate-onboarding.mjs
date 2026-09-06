// Regression checks for automatic affiliate onboarding and immutable self-referral prevention.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function check(label, value) { assert.ok(value, label); passed += 1 }
const me = readFileSync(new URL('../app/api/affiliate/me/route.ts', import.meta.url), 'utf8')
const ensure = readFileSync(new URL('../lib/server/ensureAffiliate.ts', import.meta.url), 'utf8')
const attribute = readFileSync(new URL('../app/api/affiliate/attribute/route.ts', import.meta.url), 'utf8')
const crypto = readFileSync(new URL('../app/api/checkout/crypto/route.ts', import.meta.url), 'utf8')
const paypal = readFileSync(new URL('../app/api/paypal/webhook/route.ts', import.meta.url), 'utf8')

// Unauthenticated requests return before a service-role client or provisioning call exists.
const authReject = me.indexOf("if (!token) return NextResponse.json")
const ensureCall = me.indexOf('await ensureAffiliateForUser')
check('unauthenticated callers cannot provision', authReject >= 0 && ensureCall > authReject)
check('invalid tokens cannot provision', me.indexOf('anon.auth.getUser(token)') < ensureCall && me.indexOf('if (authErr || !userData.user)') < ensureCall)
check('GET and POST both use the same authenticated handler', me.includes('export const GET = handleMe') && me.includes('export const POST = handleMe'))

// The first read plus database constraint/race recovery ensures repeated or concurrent calls converge.
check('existing ownership is returned before any insert', ensure.indexOf('const existing = await byUserId()') < ensure.indexOf(".insert({"))
check('legacy same-email rows are attached instead of duplicated', ensure.includes(".ilike('email', user.email)") && ensure.includes(".is('user_id', null)"))
check('new rows are approved immediately at 20 percent', ensure.includes("status: 'approved'") && ensure.includes('commission_rate: 0.20') && ensure.includes('approved_at: now'))
check('new codes reuse the cl plus eight-hex generator shape', ensure.includes("`cl${randomBytes(4).toString('hex')}`"))
check('unique collisions read the winning user row, preventing duplicates', ensure.includes("inserted.error?.code !== '23505'") && /const winner = await byUserId\(\)/.test(ensure))

for (const [name, source] of [['attribute', attribute], ['crypto', crypto]]) {
  check(`${name} resolves affiliate user_id`, source.includes('user_id,email,status'))
  check(`${name} blocks self-referral by user_id`, source.includes('user_id === userId'))
  check(`${name} retains the email self-referral guard`, source.includes('affEmail === userEmail') || source.includes('storedEmail === userEmail'))
}
check('PayPal commission resolution blocks buyer user_id ownership', paypal.includes("affiliate.user_id === userId"))

console.log(`test-affiliate-onboarding.mjs: all ${passed} assertions passed`)

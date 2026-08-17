// Test for lib/server/affiliateValidation.ts — the server-side rules enforced by
// app/api/affiliate/apply/route.ts. Added during an affiliate end-to-end QA pass.
//
// Run: node scripts/test-affiliate-validation.mjs

import assert from 'node:assert'
import { validateAffiliateApplication, sanitizeAffiliateField, AFFILIATE_MAX } from '../lib/server/affiliateValidation.ts'

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed++
}

const VALID_WALLET = '0x1234567890abcdef1234567890ABCDEF12345678'

/** A complete, valid application. Individual tests override single fields from this base. */
function validPayload(overrides = {}) {
  return {
    name: 'Jane Partner',
    email: 'jane@example.com',
    x_handle: '@janepartner',
    audience_size: '12,000 X followers',
    audience_type: 'Base traders',
    promotion_plan: 'Weekly threads breaking down Base token scans for my trading group.',
    ...overrides,
  }
}

// ─── Happy path ───────────────────────────────────────────────────────────────
{
  const r = validateAffiliateApplication(validPayload())
  check('complete valid payload accepted', r.ok === true)
  check('email is lowercased', validateAffiliateApplication(validPayload({ email: 'Jane@Example.COM' })).fields.email === 'jane@example.com')
  check('fields are trimmed', validateAffiliateApplication(validPayload({ name: '  Jane Partner  ' })).fields.name === 'Jane Partner')
}

// ─── Required fields block submission ─────────────────────────────────────────
for (const field of ['name', 'email', 'x_handle', 'audience_size', 'audience_type', 'promotion_plan']) {
  const missing = validateAffiliateApplication(validPayload({ [field]: '' }))
  check(`missing ${field} rejected`, missing.ok === false && missing.status === 400)
  const whitespace = validateAffiliateApplication(validPayload({ [field]: '   ' }))
  check(`whitespace-only ${field} rejected`, whitespace.ok === false)
  const absent = validPayload()
  delete absent[field]
  check(`absent ${field} rejected`, validateAffiliateApplication(absent).ok === false)
}

// audience_type specifically — this was the confirmed client/server parity bug. The form marked it
// required but the server did not check it, so a direct POST stored a null audience_type.
{
  const r = validateAffiliateApplication(validPayload({ audience_type: '' }))
  check('audience_type (niche) enforced server-side, not just in the browser', r.ok === false && r.error === 'Missing required fields.')
}

// ─── Optional fields do not block ─────────────────────────────────────────────
{
  check('telegram omitted is fine', validateAffiliateApplication(validPayload()).ok === true)
  check('telegram empty is fine', validateAffiliateApplication(validPayload({ telegram: '' })).ok === true)
  check('payout_wallet omitted is fine', validateAffiliateApplication(validPayload()).ok === true)
  check('payout_wallet empty is fine', validateAffiliateApplication(validPayload({ payout_wallet: '' })).ok === true)
  check('valid payout_wallet accepted', validateAffiliateApplication(validPayload({ payout_wallet: VALID_WALLET })).ok === true)
}

// ─── Email format ─────────────────────────────────────────────────────────────
for (const bad of ['notanemail', 'missing@tld', '@example.com', 'spaces in@example.com', 'a@b']) {
  const r = validateAffiliateApplication(validPayload({ email: bad }))
  check(`invalid email rejected: ${bad}`, r.ok === false && r.error === 'Please enter a valid email.')
}

// ─── Payout wallet format (only when provided) ────────────────────────────────
for (const bad of ['not-a-wallet', '0x1234', '1234567890abcdef1234567890abcdef12345678', '0xZZZZ567890abcdef1234567890ABCDEF123456']) {
  const r = validateAffiliateApplication(validPayload({ payout_wallet: bad }))
  check(`malformed payout_wallet rejected: ${bad}`, r.ok === false && /payout wallet/i.test(r.error))
}

// ─── Honeypot ─────────────────────────────────────────────────────────────────
{
  const r = validateAffiliateApplication(validPayload({ website: 'http://spam.example' }))
  check('honeypot filled rejects submission', r.ok === false && r.error === 'Invalid submission.')
  check('honeypot empty passes', validateAffiliateApplication(validPayload({ website: '' })).ok === true)
}

// ─── Oversized payloads are capped, never stored raw ──────────────────────────
{
  const huge = 'x'.repeat(50_000)
  const r = validateAffiliateApplication(validPayload({ promotion_plan: huge }))
  check('oversized promotion_plan still accepted but truncated', r.ok === true)
  check('promotion_plan capped at server limit', r.fields.promotionPlan.length === AFFILIATE_MAX.promotion_plan)
  const rName = validateAffiliateApplication(validPayload({ name: huge }))
  check('oversized name capped at server limit', rName.fields.name.length === AFFILIATE_MAX.name)
}

// ─── Non-string / injection-shaped input is coerced safely ────────────────────
{
  check('non-string coerced to empty', sanitizeAffiliateField(12345, 100) === '')
  check('null coerced to empty', sanitizeAffiliateField(null, 100) === '')
  check('object coerced to empty', sanitizeAffiliateField({ a: 1 }, 100) === '')
  check('numeric name rejected as missing', validateAffiliateApplication(validPayload({ name: 12345 })).ok === false)
  // Script-shaped input is stored as inert text (React escapes on render, Resend sends text/plain).
  // The point here is that it does not bypass validation or crash the validator.
  const xss = validateAffiliateApplication(validPayload({ name: '<script>alert(1)</script>' }))
  check('script-shaped name handled as plain text without throwing', xss.ok === true && xss.fields.name === '<script>alert(1)</script>')
}

console.log(`test-affiliate-validation.mjs: all ${passed} assertions passed`)

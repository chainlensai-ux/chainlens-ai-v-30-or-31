// Shared input validation for the affiliate application endpoint (app/api/affiliate/apply).
// Extracted to one place following the same precedent as lib/server/watchlistValidation.ts: the
// route itself imports next/server and @supabase/supabase-js, so validation logic living inline
// there cannot be unit-tested without standing up a server. Keeping it pure and dependency-free
// here makes the rules directly testable (scripts/test-affiliate-validation.mjs) and keeps the
// client-side field caps and the server-side limits from drifting apart.

export const AFFILIATE_MAX = {
  name: 100,
  email: 200,
  telegram: 100,
  x_handle: 100,
  audience_size: 120,
  audience_type: 160,
  payout_wallet: 120,
  promotion_plan: 1200,
  website: 300,
} as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// EVM payout address format — the same rule watchlistValidation.ts enforces for address inputs
// elsewhere in the app. The form's placeholder is "0x…" and payouts are sent on-chain, so an
// unparseable payout_wallet is a real money-misdirection risk, not a cosmetic one.
const PAYOUT_WALLET_RE = /^0x[a-fA-F0-9]{40}$/

export type AffiliateApplicationInput = {
  name?: unknown
  email?: unknown
  telegram?: unknown
  x_handle?: unknown
  audience_size?: unknown
  audience_type?: unknown
  promotion_plan?: unknown
  payout_wallet?: unknown
  website?: unknown
}

export type AffiliateApplicationFields = {
  name: string
  email: string
  telegram: string
  xHandle: string
  audienceSize: string
  audienceType: string
  payoutWallet: string
  promotionPlan: string
}

export type AffiliateValidationResult =
  | { ok: true; fields: AffiliateApplicationFields }
  | { ok: false; status: 400; error: string }

/** Trim, coerce to string, and cap length. Non-strings become ''. */
export function sanitizeAffiliateField(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, max)
}

/**
 * Validates a raw affiliate application payload.
 *
 * Required: name, email, x_handle, audience_size, audience_type, promotion_plan.
 * Optional: telegram, payout_wallet (payout_wallet is format-checked only when non-empty).
 * The `website` field is a honeypot — any value means a bot filled a field humans can't see.
 */
export function validateAffiliateApplication(body: AffiliateApplicationInput): AffiliateValidationResult {
  const website = sanitizeAffiliateField(body.website, AFFILIATE_MAX.website)
  if (website) return { ok: false, status: 400, error: 'Invalid submission.' }

  const fields: AffiliateApplicationFields = {
    name: sanitizeAffiliateField(body.name, AFFILIATE_MAX.name),
    email: sanitizeAffiliateField(body.email, AFFILIATE_MAX.email).toLowerCase(),
    telegram: sanitizeAffiliateField(body.telegram, AFFILIATE_MAX.telegram),
    xHandle: sanitizeAffiliateField(body.x_handle, AFFILIATE_MAX.x_handle),
    audienceSize: sanitizeAffiliateField(body.audience_size, AFFILIATE_MAX.audience_size),
    audienceType: sanitizeAffiliateField(body.audience_type, AFFILIATE_MAX.audience_type),
    payoutWallet: sanitizeAffiliateField(body.payout_wallet, AFFILIATE_MAX.payout_wallet),
    promotionPlan: sanitizeAffiliateField(body.promotion_plan, AFFILIATE_MAX.promotion_plan),
  }

  // REQUIRED-FIELD PARITY, DISCLOSED (affiliate QA): audienceType is marked required in the form
  // but was previously NOT checked server-side, so a direct POST bypassing the browser's HTML
  // validation stored an application with a null audience_type — the field manual review most
  // depends on for partner fit. Client-side `required` is a UX hint, never an enforcement boundary.
  if (!fields.name || !fields.email || !fields.xHandle || !fields.audienceSize || !fields.audienceType || !fields.promotionPlan) {
    return { ok: false, status: 400, error: 'Missing required fields.' }
  }
  if (!EMAIL_RE.test(fields.email)) {
    return { ok: false, status: 400, error: 'Please enter a valid email.' }
  }
  // Optional field — only validated when actually provided, so leaving it blank never blocks.
  if (fields.payoutWallet && !PAYOUT_WALLET_RE.test(fields.payoutWallet)) {
    return { ok: false, status: 400, error: 'Payout wallet must be a valid 0x address, or left blank.' }
  }

  return { ok: true, fields }
}

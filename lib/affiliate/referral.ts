export const AFFILIATE_REF_KEY = 'chainlens_affiliate_ref'
const REF_CODE_RE = /^[a-z0-9_-]{3,64}$/

export function normalizeReferralCode(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidReferralCode(value: string): boolean {
  return REF_CODE_RE.test(normalizeReferralCode(value))
}

/**
 * The public site origin used to build a shareable referral link.
 *
 * Single source of truth, DISCLOSED: the affiliate success box previously hardcoded
 * "https://www.chainlensai.app/pricing?ref=" inline. Now that the link is built in three places
 * (apply success, the affiliate dashboard, and /api/affiliate/me) a second hardcoded copy would be
 * a real hazard — a drifted origin would hand ambassadors a link that silently attributes nothing.
 * NEXT_PUBLIC_SITE_URL overrides it where configured (preview deployments); the literal production
 * origin remains the fallback so behavior is unchanged wherever that variable is unset.
 */
export const AFFILIATE_SITE_ORIGIN =
  (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '') || 'https://www.chainlensai.app'

/**
 * Builds the full shareable link for a referral code. Points at /pricing — the page a referred
 * visitor needs to land on to convert — and AffiliateRefCapture (mounted app-wide in layout.tsx)
 * is what turns the ?ref= parameter into the 60-day attribution cookie.
 */
export function buildAffiliateReferralLink(code: string): string {
  return `${AFFILIATE_SITE_ORIGIN}/pricing?ref=${encodeURIComponent(normalizeReferralCode(code))}`
}

export function readReferralCodeFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|; )chainlens_affiliate_ref=([^;]+)/)
  if (!match) return null
  const decoded = decodeURIComponent(match[1])
  return isValidReferralCode(decoded) ? normalizeReferralCode(decoded) : null
}


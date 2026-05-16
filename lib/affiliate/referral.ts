export const AFFILIATE_REF_KEY = 'chainlens_affiliate_ref'
const REF_CODE_RE = /^[a-z0-9_-]{3,64}$/

export function normalizeReferralCode(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidReferralCode(value: string): boolean {
  return REF_CODE_RE.test(normalizeReferralCode(value))
}

export function readReferralCodeFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|; )chainlens_affiliate_ref=([^;]+)/)
  if (!match) return null
  const decoded = decodeURIComponent(match[1])
  return isValidReferralCode(decoded) ? normalizeReferralCode(decoded) : null
}


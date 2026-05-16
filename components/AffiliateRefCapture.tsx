'use client'

import { useEffect } from 'react'
import { AFFILIATE_REF_KEY, isValidReferralCode, normalizeReferralCode } from '@/lib/affiliate/referral'

const SIXTY_DAYS = 60 * 24 * 60 * 60

export default function AffiliateRefCapture() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ref = params.get('ref')
    if (!ref) return
    const code = normalizeReferralCode(ref)
    if (!isValidReferralCode(code)) return
    window.localStorage.setItem(AFFILIATE_REF_KEY, code)
    document.cookie = `${AFFILIATE_REF_KEY}=${encodeURIComponent(code)}; Max-Age=${SIXTY_DAYS}; Path=/; SameSite=Lax; Secure`
  }, [])

  return null
}

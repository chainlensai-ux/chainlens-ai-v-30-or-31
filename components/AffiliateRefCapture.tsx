'use client'

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { AFFILIATE_REF_KEY, isValidReferralCode, normalizeReferralCode } from '@/lib/affiliate/referral'

const SIXTY_DAYS = 60 * 24 * 60 * 60

export default function AffiliateRefCapture() {
  const searchParams = useSearchParams()

  useEffect(() => {
    const ref = searchParams.get('ref')
    if (!ref) return
    const code = normalizeReferralCode(ref)
    if (!isValidReferralCode(code)) return
    try { window.localStorage.setItem(AFFILIATE_REF_KEY, code) } catch {}
    document.cookie = `${AFFILIATE_REF_KEY}=${encodeURIComponent(code)}; Max-Age=${SIXTY_DAYS}; Path=/; SameSite=Lax; Secure`
  }, [searchParams])

  return null
}

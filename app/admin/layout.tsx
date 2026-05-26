'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

const ADMIN_EMAIL = 'chainlensai@gmail.com'

type UserSettingsResponse = {
  email?: string
  plan?: string
  effectivePlan?: string
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) {
          router.replace('/pricing')
          return
        }

        const res = await fetch('/api/user-settings', {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: 'no-store',
        })
        const json = (await res.json().catch(() => ({}))) as UserSettingsResponse
        const email = String(json.email ?? '').toLowerCase()
        const plan = String(json.effectivePlan ?? json.plan ?? '').toLowerCase()
        const isAdminEmail = email === ADMIN_EMAIL
        const adminAccessGranted = isAdminEmail || plan === 'elite'

        if (searchParams.get('debug') === 'true') {
          // eslint-disable-next-line no-console
          console.log({
            email,
            plan,
            effectivePlan: json.effectivePlan,
            isAdminEmail,
            adminAccessGranted,
          })
        }

        if (!adminAccessGranted) {
          router.replace('/pricing')
          return
        }

        if (!cancelled) setAllowed(true)
      } catch {
        router.replace('/pricing')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [router, searchParams])

  if (!allowed) return null

  return <>{children}</>
}

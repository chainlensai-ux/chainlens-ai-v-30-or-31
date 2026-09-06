'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

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

        // Use the same server-side ADMIN_EMAILS gate as every admin mutation/read API. Never ship
        // the allowlist to the browser and never infer admin privileges from a paid/trial plan.
        const res = await fetch('/api/admin/data', {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: 'no-store',
        })
        const email = String(session.user.email ?? '').toLowerCase()
        const adminAccessGranted = res.ok

        if (searchParams.get('debug') === 'true') {
          console.log({
            email,
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

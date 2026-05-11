'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

const ACCESS_KEY = 'chainlens_beta_access'

export default function BetaPage() {
  const router = useRouter()

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem(ACCESS_KEY, 'granted')
    router.replace('/')
  }, [router])

  return (
    <main style={{
      minHeight: '100vh', width: '100%',
      background: '#06060a',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        color: '#2DD4BF', fontSize: '13px',
        fontFamily: 'var(--font-inter, Inter, sans-serif)', opacity: 0.7,
      }}>
        Entering ChainLens…
      </div>
    </main>
  )
}

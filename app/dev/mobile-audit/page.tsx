'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

const VIEWPORTS = [360, 390, 430, 768, 1024, 1280, 1440, 1920]
const PAGES = [
  ['/', 'Landing'],
  ['/pricing', 'Pricing'],
  ['/auth', 'Auth'],
  ['/terminal', 'Terminal'],
  ['/terminal/token-scanner', 'Token Scanner'],
  ['/terminal/wallet-scanner', 'Wallet Scanner'],
  ['/terminal/portfolio', 'Portfolio'],
  ['/terminal/clark-ai', 'Clark AI'],
  ['/terminal/whale-alerts', 'Whale Alerts'],
  ['/terminal/base-radar', 'Base Radar'],
  ['/terminal/watchlist', 'Watchlist'],
  ['/terminal/settings', 'Settings'],
]

export default function MobileAuditPage() {
  const [width, setWidth] = useState(0)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const measure = () => {
      setWidth(window.innerWidth)
      const doc = document.documentElement
      setOverflow(doc.scrollWidth > doc.clientWidth + 1)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const nearest = useMemo(
    () => VIEWPORTS.reduce((best, v) => Math.abs(v - width) < Math.abs(best - width) ? v : best, VIEWPORTS[0]),
    [width],
  )

  return (
    <main style={{ minHeight: '100dvh', padding: '24px 16px 80px', color: '#e2e8f0', background: '#050816', overflowX: 'hidden' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>Mobile audit</h1>
      <p style={{ margin: '0 0 18px', color: '#94a3b8', fontSize: 13 }}>
        Viewport <strong style={{ color: '#f8fafc' }}>{width}px</strong> · nearest preset {nearest}px · overflow{' '}
        <strong style={{ color: overflow ? '#f87171' : '#5eead4' }}>{overflow ? 'YES' : 'none'}</strong>
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
        {VIEWPORTS.map((v) => (
          <span key={v} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', fontSize: 12, color: v === nearest ? '#5eead4' : '#94a3b8' }}>{v}px</span>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {PAGES.map(([href, label]) => (
          <Link key={href} href={href} style={{ display: 'block', padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', textDecoration: 'none', minHeight: 44 }}>
            {label} <span style={{ color: '#64748b', fontSize: 12 }}>{href}</span>
          </Link>
        ))}
      </div>
    </main>
  )
}

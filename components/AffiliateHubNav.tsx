'use client'

// AFFILIATE HUB NAV, DISCLOSED (requested: "make that page and option at the top so its like a hub
// u can always go to it"). Before this, /affiliate (apply) and /affiliate/dashboard (link + stats)
// had no way to move between each other except the one-time link inside the apply success box —
// land on either page any other way (a bookmark, a direct link, browser back) and there was no
// route back to the other one. This is a small, persistent tab strip rendered at the very top of
// both pages, right under the site Navbar, so an affiliate always has one click to "my application"
// or "my dashboard" regardless of which page they arrived on.
//
// Shared by both pages rather than duplicated so the two tabs can never drift out of sync with each
// other (a label change, an added third tab, only needs to happen once).

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/affiliate', label: 'Overview & Apply' },
  { href: '/affiliate/dashboard', label: 'My Dashboard' },
] as const

export default function AffiliateHubNav() {
  const pathname = usePathname()

  return (
    <div style={{ borderBottom: '1px solid rgba(226,232,240,.11)', background: '#07070f' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 20px', display: 'flex', alignItems: 'center', gap: '28px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-plex-mono,monospace)', fontSize: '10px', fontWeight: 600, letterSpacing: '.16em', color: '#3f4b5e', textTransform: 'uppercase', padding: '14px 0' }}>
          Affiliate Hub
        </span>
        <nav style={{ display: 'flex', gap: '22px' }}>
          {TABS.map((tab) => {
            const active = pathname === tab.href
            return (
              <Link
                key={tab.href}
                href={tab.href}
                style={{
                  padding: '14px 0',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: active ? '#f4f5f7' : '#7c8aa0',
                  textDecoration: 'none',
                  borderBottom: active ? '2px solid #2DD4BF' : '2px solid transparent',
                  transition: 'color .15s, border-color .15s',
                }}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </div>
  )
}

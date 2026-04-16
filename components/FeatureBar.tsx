'use client'

import Image from 'next/image'
import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

// ─── Icons ────────────────────────────────────────────────────────────────

function IcDashboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/>
    </svg>
  )
}
function IcPortfolio() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  )
}
function IcSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}
function IcClarkAI() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>
      <path d="M19 3v4m2-2h-4"/>
    </svg>
  )
}
function IcWalletScan() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}
function IcTokenScanner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}
function IcTokenScreener() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6"  x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6"  x2="3.01" y2="6"/>
      <line x1="3" y1="12" x2="3.01" y2="12"/>
      <line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  )
}
function IcWhaleAlerts() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}
function IcRadar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.64 17.36a9 9 0 1 1 12.72 0"/>
      <path d="M8.46 14.54a5 5 0 1 1 7.07 0"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  )
}
function IcMarkets() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  )
}
function IcExchangeFlow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    </svg>
  )
}
function IcPumpAlerts() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  )
}

// ─── Data ─────────────────────────────────────────────────────────────────

const MINT   = '#2DD4BF'
const PURPLE = '#8b5cf6'
const PINK   = '#ec4899'

type Item = { key: string; label: string; icon: ReactNode; accent?: string }

const MAIN_NAV: Item[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <IcDashboard />,    accent: MINT   },
  { key: 'portfolio', label: 'Portfolio', icon: <IcPortfolio />,    accent: MINT   },
  { key: 'settings',  label: 'Settings',  icon: <IcSettings />,     accent: MINT   },
]

const TOOLS: Item[] = [
  { key: 'clark-ai',       label: 'Clark AI',       icon: <IcClarkAI />,       accent: PURPLE },
  { key: 'wallet-scan',    label: 'Wallet Scan',    icon: <IcWalletScan />,    accent: MINT   },
  { key: 'token-scanner',  label: 'Token Scanner',  icon: <IcTokenScanner />,  accent: MINT   },
  { key: 'token-screener', label: 'Token Screener', icon: <IcTokenScreener />, accent: MINT   },
  { key: 'whale-alerts',   label: 'Whale Alerts',   icon: <IcWhaleAlerts />,   accent: PINK   },
  { key: 'radar',          label: 'Radar',          icon: <IcRadar />,         accent: MINT   },
  { key: 'markets',        label: 'Markets',        icon: <IcMarkets />,       accent: MINT   },
  { key: 'exchange-flow',  label: 'Exchange Flow',  icon: <IcExchangeFlow />,  accent: MINT   },
  { key: 'pump-alerts',    label: 'Pump Alerts',    icon: <IcPumpAlerts />,    accent: PINK   },
]

// ─── Section label ─────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        fontSize: '9px',
        fontWeight: 700,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: '#1e3040',
        fontFamily: 'var(--font-plex-mono)',
        padding: '16px 4px 6px',
      }}
    >
      {children}
    </p>
  )
}

// ─── NavItem ──────────────────────────────────────────────────────────────

function NavItem({ item, active, onSelect }: { item: Item; active: string | null; onSelect: (k: string) => void }) {
  const on     = active === item.key
  const accent = item.accent ?? MINT

  // Derive bg/glow based on accent colour
  const activeBg     = accent === PURPLE
    ? 'linear-gradient(90deg, rgba(139,92,246,0.18), rgba(139,92,246,0.06))'
    : accent === PINK
    ? 'linear-gradient(90deg, rgba(236,72,153,0.16), rgba(236,72,153,0.05))'
    : 'linear-gradient(90deg, rgba(45,212,191,0.15), rgba(45,212,191,0.04))'

  const activeGlow   = accent === PURPLE
    ? 'inset 0 1px 0 rgba(139,92,246,0.14)'
    : accent === PINK
    ? 'inset 0 1px 0 rgba(236,72,153,0.12)'
    : 'inset 0 1px 0 rgba(45,212,191,0.12)'

  return (
    <motion.button
      onClick={() => onSelect(item.key)}
      className="w-full flex items-center gap-3 transition-colors relative"
      style={{
        height: '40px',
        borderRadius: '10px',
        paddingLeft: on ? '11px' : '12px',
        paddingRight: '12px',
        background: on ? activeBg : 'transparent',
        borderLeft:   on ? `2.5px solid ${accent}` : '2.5px solid transparent',
        borderTop:    '1px solid transparent',
        borderRight:  '1px solid transparent',
        borderBottom: '1px solid transparent',
        boxShadow: on ? activeGlow : 'none',
        color: on ? accent : '#3d556e',
        fontSize: '13px',
        fontWeight: on ? 600 : 500,
        fontFamily: 'var(--font-inter)',
        cursor: 'pointer',
        textAlign: 'left',
      }}
      whileHover={!on ? { x: 2 } : {}}
      transition={{ duration: 0.1 }}
      onMouseEnter={e => {
        if (!on) {
          const el = e.currentTarget as HTMLButtonElement
          el.style.color      = '#94a3b8'
          el.style.background = 'rgba(255,255,255,0.04)'
        }
      }}
      onMouseLeave={e => {
        if (!on) {
          const el = e.currentTarget as HTMLButtonElement
          el.style.color      = '#3d556e'
          el.style.background = 'transparent'
        }
      }}
    >
      <span style={{ color: on ? accent : '#2d4a63', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        {item.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
    </motion.button>
  )
}

// ─── Component ────────────────────────────────────────────────────────────

interface Props {
  active?:   string | null
  onSelect?: (key: string) => void
}

export default function FeatureBar({ active = 'dashboard', onSelect = () => {} }: Props) {
  return (
    <aside
      className="h-screen shrink-0 flex flex-col"
      style={{
        width: '240px',
        background: '#06060a',
        borderRight: '1px solid rgba(255,255,255,0.08)',
      }}
    >

      {/* ── Branding ──────────────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-3"
        style={{
          padding: '24px 20px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        {/* Logo */}
        <div
          className="shrink-0 flex items-center justify-center"
          style={{
            width: '38px',
            height: '38px',
            borderRadius: '10px',
            background: 'rgba(45,212,191,0.09)',
            border: '1px solid rgba(45,212,191,0.2)',
            boxShadow: '0 0 16px rgba(45,212,191,0.18)',
          }}
        >
          <Image src="/cl-logo.png" alt="ChainLens" width={26} height={26} />
        </div>

        {/* Wordmark */}
        <span
          style={{
            fontSize: '17px',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            color: '#f1f5f9',
            fontFamily: 'var(--font-inter)',
          }}
        >
          Chain<span style={{ color: '#2DD4BF' }}>Lens</span>
        </span>
      </div>

      {/* ── Navigation ────────────────────────────────────────── */}
      <nav
        className="flex-1 overflow-y-auto flex flex-col"
        style={{ padding: '8px 12px', gap: 0 }}
      >
        {/* Main Nav */}
        <SectionLabel>Main</SectionLabel>
        <div className="flex flex-col" style={{ gap: '2px' }}>
          {MAIN_NAV.map(item => (
            <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
          ))}
        </div>

        {/* Tools */}
        <SectionLabel>Tools</SectionLabel>
        <div className="flex flex-col" style={{ gap: '2px' }}>
          {TOOLS.map(item => (
            <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
          ))}
        </div>
      </nav>

      {/* ── Bottom CTAs ───────────────────────────────────────── */}
      <div
        className="shrink-0 flex flex-col"
        style={{
          padding: '12px 12px 16px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          gap: '8px',
        }}
      >
        {/* Connect Wallet — full width, premium mint */}
        <button
          className="w-full transition-all active:scale-[0.98]"
          style={{
            height: '40px',
            borderRadius: '10px',
            background: 'linear-gradient(90deg, #2DD4BF 0%, #0d9488 100%)',
            color: '#031211',
            fontSize: '13px',
            fontWeight: 700,
            letterSpacing: '0.02em',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'var(--font-inter)',
            boxShadow: '0 0 24px rgba(45,212,191,0.3)',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.boxShadow = '0 0 36px rgba(45,212,191,0.48)'
            el.style.opacity   = '0.93'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.boxShadow = '0 0 24px rgba(45,212,191,0.3)'
            el.style.opacity   = '1'
          }}
        >
          Connect Wallet
        </button>

        {/* Sign In | Sign Up */}
        <div className="flex" style={{ gap: '6px' }}>
          <button
            className="flex-1 transition-all"
            style={{
              height: '34px',
              borderRadius: '8px',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.09)',
              color: '#4d6280',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-inter)',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.color       = '#94a3b8'
              el.style.borderColor = 'rgba(255,255,255,0.18)'
              el.style.background  = 'rgba(255,255,255,0.04)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.color       = '#4d6280'
              el.style.borderColor = 'rgba(255,255,255,0.09)'
              el.style.background  = 'transparent'
            }}
          >
            Sign In
          </button>
          <button
            className="flex-1 transition-all active:scale-[0.98]"
            style={{
              height: '34px',
              borderRadius: '8px',
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.22)',
              color: '#2DD4BF',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'var(--font-inter)',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.background  = 'rgba(45,212,191,0.15)'
              el.style.borderColor = 'rgba(45,212,191,0.38)'
              el.style.boxShadow   = '0 0 12px rgba(45,212,191,0.15)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.background  = 'rgba(45,212,191,0.08)'
              el.style.borderColor = 'rgba(45,212,191,0.22)'
              el.style.boxShadow   = 'none'
            }}
          >
            Sign Up
          </button>
        </div>
      </div>

    </aside>
  )
}

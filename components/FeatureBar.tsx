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
function IcWalletScanner() {
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
function IcDevWalletDetector() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
      <line x1="12" y1="4" x2="12" y2="20" strokeWidth="1.2" strokeDasharray="2 2"/>
    </svg>
  )
}
function IcLiquiditySafety() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="M12 8c0 0-2.5 2.5-2.5 4.5a2.5 2.5 0 0 0 5 0C14.5 10.5 12 8 12 8z"/>
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
const WHITE  = '#e2e8f0'
const SLATE  = '#94a3b8'

type Item = { key: string; label: string; icon: ReactNode; accent: string; iconColor: string }

const MAIN_NAV: Item[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <IcDashboard />,    accent: MINT,   iconColor: MINT   },
  { key: 'portfolio', label: 'Portfolio', icon: <IcPortfolio />,    accent: WHITE,  iconColor: WHITE  },
  { key: 'settings',  label: 'Settings',  icon: <IcSettings />,     accent: SLATE,  iconColor: SLATE  },
]

const TOOLS: Item[] = [
  { key: 'token-scanner',       label: 'Token Scanner',       icon: <IcTokenScanner />,       accent: MINT,   iconColor: MINT   },
  { key: 'wallet-scanner',      label: 'Wallet Scanner',      icon: <IcWalletScanner />,      accent: MINT,   iconColor: MINT   },
  { key: 'dev-wallet-detector', label: 'Dev Wallet Detector', icon: <IcDevWalletDetector />,  accent: PURPLE, iconColor: PURPLE },
  { key: 'liquidity-safety',    label: 'Liquidity Safety',    icon: <IcLiquiditySafety />,    accent: MINT,   iconColor: MINT   },
  { key: 'whale-alerts',        label: 'Whale Alerts',        icon: <IcWhaleAlerts />,        accent: PINK,   iconColor: PINK   },
  { key: 'pump-alerts',         label: 'Pump Alerts',         icon: <IcPumpAlerts />,         accent: PINK,   iconColor: PINK   },
  { key: 'base-radar',          label: 'Base Radar',          icon: <IcRadar />,              accent: PURPLE, iconColor: PURPLE },
  { key: 'clark-ai',            label: 'Clark AI',            icon: <IcClarkAI />,            accent: PURPLE, iconColor: PURPLE },
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
        color: '#3d6478',
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
  const on        = active === item.key
  const accent    = item.accent
  const iconColor = item.iconColor

  // Per-accent active backgrounds
  const activeBg =
    accent === PURPLE ? 'linear-gradient(90deg, rgba(139,92,246,0.22), rgba(139,92,246,0.06))'
    : accent === PINK ? 'linear-gradient(90deg, rgba(236,72,153,0.20), rgba(236,72,153,0.05))'
    : accent === WHITE ? 'linear-gradient(90deg, rgba(226,232,240,0.10), rgba(226,232,240,0.02))'
    : accent === SLATE ? 'linear-gradient(90deg, rgba(148,163,184,0.10), rgba(148,163,184,0.02))'
    : /* MINT */ 'linear-gradient(90deg, rgba(45,212,191,0.26), rgba(45,212,191,0.06))'

  // Per-accent active shadow (left glow + top inset shimmer)
  const activeGlow =
    accent === PURPLE ? `0 0 24px rgba(139,92,246,0.26), inset 0 1px 0 rgba(139,92,246,0.22)`
    : accent === PINK ? `0 0 22px rgba(236,72,153,0.22), inset 0 1px 0 rgba(236,72,153,0.20)`
    : accent === WHITE ? `inset 0 1px 0 rgba(226,232,240,0.16)`
    : accent === SLATE ? `inset 0 1px 0 rgba(148,163,184,0.14)`
    : /* MINT */ `0 0 36px rgba(45,212,191,0.42), 0 0 14px rgba(45,212,191,0.18), inset 0 1px 0 rgba(45,212,191,0.30)`

  // Idle icon colour — dim but readable version of each accent
  const idleIconColor =
    accent === PURPLE ? '#5a4492'
    : accent === PINK  ? '#7e3060'
    : accent === WHITE ? '#4e6880'
    : accent === SLATE ? '#445870'
    : /* MINT */ '#286060'

  return (
    <motion.button
      onClick={() => onSelect(item.key)}
      className="w-full flex items-center gap-3 relative"
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
        color: on ? accent : '#6a8da8',
        fontSize: '13px',
        fontWeight: on ? 600 : 500,
        fontFamily: 'var(--font-inter)',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'color 0.12s, background 0.12s, box-shadow 0.12s',
      }}
      whileHover={!on ? { x: 2 } : {}}
      transition={{ duration: 0.1 }}
      onMouseEnter={e => {
        if (!on) {
          const el = e.currentTarget as HTMLButtonElement
          el.style.color      = '#b0c4d8'
          el.style.background = 'rgba(255,255,255,0.05)'
          el.style.boxShadow  = 'inset 0 1px 0 rgba(255,255,255,0.05)'
        }
      }}
      onMouseLeave={e => {
        if (!on) {
          const el = e.currentTarget as HTMLButtonElement
          el.style.color      = '#6a8da8'
          el.style.background = 'transparent'
          el.style.boxShadow  = 'none'
        }
      }}
    >
      <span style={{
        color: on ? iconColor : idleIconColor,
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        transition: 'color 0.12s',
      }}>
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
          padding: '20px 20px 18px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        {/* Logo — unboxed, large, clean */}
        <Image
          src="/cl-logo.png"
          alt="ChainLens"
          width={48}
          height={48}
          style={{ display: 'block', flexShrink: 0 }}
        />

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
          Chain
          <span
            style={{
              background: 'linear-gradient(105deg, #2DD4BF 0%, #8b5cf6 55%, #ec4899 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Lens
          </span>
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
          className="w-full active:scale-[0.98]"
          style={{
            height: '40px',
            borderRadius: '10px',
            background: 'linear-gradient(90deg, #2DD4BF 0%, #0d9488 100%)',
            color: '#021a18',
            fontSize: '13px',
            fontWeight: 700,
            letterSpacing: '0.025em',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'var(--font-inter)',
            boxShadow: '0 0 28px rgba(45,212,191,0.35), 0 2px 8px rgba(0,0,0,0.4)',
            transition: 'box-shadow 0.15s, opacity 0.15s',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.boxShadow = '0 0 44px rgba(45,212,191,0.55), 0 2px 10px rgba(0,0,0,0.4)'
            el.style.opacity   = '0.94'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.boxShadow = '0 0 28px rgba(45,212,191,0.35), 0 2px 8px rgba(0,0,0,0.4)'
            el.style.opacity   = '1'
          }}
        >
          Connect Wallet
        </button>

        {/* Sign In | Sign Up */}
        <div className="flex" style={{ gap: '6px' }}>
          {/* Sign In — dark neutral ghost */}
          <button
            className="flex-1"
            style={{
              height: '34px',
              borderRadius: '8px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#5a7490',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-inter)',
              transition: 'color 0.12s, border-color 0.12s, background 0.12s',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.color       = '#94a3b8'
              el.style.borderColor = 'rgba(255,255,255,0.16)'
              el.style.background  = 'rgba(255,255,255,0.06)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.color       = '#5a7490'
              el.style.borderColor = 'rgba(255,255,255,0.08)'
              el.style.background  = 'rgba(255,255,255,0.03)'
            }}
          >
            Sign In
          </button>
          {/* Sign Up — purple tint */}
          <button
            className="flex-1 active:scale-[0.98]"
            style={{
              height: '34px',
              borderRadius: '8px',
              background: 'rgba(139,92,246,0.12)',
              border: '1px solid rgba(139,92,246,0.28)',
              color: '#a78bfa',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'var(--font-inter)',
              transition: 'background 0.12s, border-color 0.12s, box-shadow 0.12s',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.background  = 'rgba(139,92,246,0.22)'
              el.style.borderColor = 'rgba(139,92,246,0.48)'
              el.style.boxShadow   = '0 0 16px rgba(139,92,246,0.22)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLButtonElement
              el.style.background  = 'rgba(139,92,246,0.12)'
              el.style.borderColor = 'rgba(139,92,246,0.28)'
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

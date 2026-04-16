'use client'

import Image from 'next/image'
import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

// ─── Icons (16×16) ───────────────────────────────────────────────────────

function IcHome() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}
function IcWalletScanner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}
function IcTokenScanner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}
function IcDevWallet() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>
  )
}
function IcLiquidity() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
}
function IcWhaleAlerts() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}
function IcPumpAlerts() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  )
}
function IcBaseRadar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.64 17.36a9 9 0 1 1 12.72 0"/>
      <path d="M8.46 14.54a5 5 0 1 1 7.07 0"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  )
}
function IcClarkAI() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>
      <path d="M19 3v4m2-2h-4"/>
    </svg>
  )
}
function IcPortfolio() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  )
}
function IcSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
    </svg>
  )
}

// ─── Data ─────────────────────────────────────────────────────────────────

type Item = { key: string; label: string; icon: ReactNode }

const TOOLS: Item[] = [
  { key: 'wallet-scanner',    label: 'Wallet Scan',          icon: <IcWalletScanner /> },
  { key: 'token-scanner',     label: 'Token Scanner',        icon: <IcTokenScanner />  },
  { key: 'dev-wallet',        label: 'Dev Wallet Detector',  icon: <IcDevWallet />     },
  { key: 'liquidity-scanner', label: 'Liquidity Safety',     icon: <IcLiquidity />     },
  { key: 'whale-alerts',      label: 'Whale Alerts',         icon: <IcWhaleAlerts />   },
  { key: 'pump-alerts',       label: 'Pump Alerts',          icon: <IcPumpAlerts />    },
  { key: 'base-radar',        label: 'Base Radar',           icon: <IcBaseRadar />     },
  { key: 'clark-ai',          label: 'Clark AI',             icon: <IcClarkAI />       },
]

const SECONDARY: Item[] = [
  { key: 'portfolio', label: 'Portfolio', icon: <IcPortfolio /> },
  { key: 'settings',  label: 'Settings',  icon: <IcSettings />  },
]

// ─── NavItem ──────────────────────────────────────────────────────────────

interface NavItemProps {
  item:     Item
  active:   string | null
  onSelect: (key: string) => void
}

function NavItem({ item, active, onSelect }: NavItemProps) {
  const on = active === item.key

  return (
    <motion.button
      onClick={() => onSelect(item.key)}
      className="w-full flex items-center gap-3 px-3.5 text-[13px] font-medium transition-colors"
      style={{
        height: '44px',
        borderRadius: '12px',
        // Active: mint left indicator + tinted surface
        // Default: always-visible dark card with soft border
        borderTop:    on ? '1px solid rgba(45,212,191,0.18)' : '1px solid rgba(255,255,255,0.06)',
        borderRight:  on ? '1px solid rgba(45,212,191,0.18)' : '1px solid rgba(255,255,255,0.06)',
        borderBottom: on ? '1px solid rgba(45,212,191,0.18)' : '1px solid rgba(255,255,255,0.06)',
        borderLeft:   on ? '3px solid #2DD4BF'               : '1px solid rgba(255,255,255,0.06)',
        background:   on ? 'rgba(45,212,191,0.09)'           : 'rgba(255,255,255,0.04)',
        color:        on ? '#2DD4BF'                          : '#e2e8f0',
        boxShadow:    on ? '0 0 20px rgba(45,212,191,0.08)'  : 'none',
      }}
      whileHover={!on ? { y: -2 } : {}}
      transition={{ duration: 0.14 }}
      onMouseEnter={e => {
        if (!on) {
          const el = e.currentTarget as HTMLButtonElement
          el.style.borderColor = 'rgba(255,255,255,0.13)'
          el.style.background  = 'rgba(255,255,255,0.07)'
          el.style.boxShadow   = '0 4px 16px rgba(0,0,0,0.25)'
        }
      }}
      onMouseLeave={e => {
        if (!on) {
          const el = e.currentTarget as HTMLButtonElement
          el.style.borderColor = 'rgba(255,255,255,0.06)'
          el.style.background  = 'rgba(255,255,255,0.04)'
          el.style.boxShadow   = 'none'
        }
      }}
    >
      {/* Icon — always mint */}
      <span className="shrink-0" style={{ color: '#2DD4BF' }}>
        {item.icon}
      </span>
      {item.label}
    </motion.button>
  )
}

// ─── SectionLabel ─────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p
      className="px-1 pt-2 pb-1.5 text-[10px] font-bold uppercase tracking-[0.18em]"
      style={{ color: '#3d5268' }}
    >
      {children}
    </p>
  )
}

// ─── Component ────────────────────────────────────────────────────────────

interface Props {
  active?:   string | null
  onSelect?: (key: string) => void
}

export default function FeatureBar({ active = 'home', onSelect = () => {} }: Props) {
  return (
    <aside
      className="w-[250px] h-screen shrink-0 flex flex-col"
      style={{ background: '#07090f', borderRight: '1px solid rgba(255,255,255,0.07)' }}
    >

      {/* ── Branding ─────────────────────────────────────────────── */}
      <div
        className="relative px-5 pt-6 pb-5 shrink-0 overflow-hidden"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
      >
        {/* Ambient glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at 10% 60%, rgba(45,212,191,0.1) 0%, transparent 65%)',
          }}
        />
        <div className="relative flex items-center gap-3">
          <div
            className="shrink-0 rounded-xl p-1.5"
            style={{
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.2)',
              boxShadow: '0 0 16px rgba(45,212,191,0.12)',
            }}
          >
            <Image src="/cl-logo.png" alt="ChainLens AI" width={34} height={34} className="shrink-0" />
          </div>
          <div>
            <p
              className="text-[16px] font-extrabold leading-tight tracking-tight"
              style={{ color: '#f8fafc' }}
            >
              Chain<span style={{ color: '#2DD4BF' }}>Lens</span>
            </p>
            <p className="text-[10px] font-medium mt-0.5" style={{ color: '#3d5268' }}>
              Base Intelligence Terminal
            </p>
          </div>
        </div>
      </div>

      {/* ── Navigation ───────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-1.5">

        {/* Home */}
        <NavItem
          item={{ key: 'home', label: 'Home', icon: <IcHome /> }}
          active={active}
          onSelect={onSelect}
        />

        {/* Tools section */}
        <SectionLabel>Tools</SectionLabel>
        {TOOLS.map(item => (
          <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
        ))}

        {/* Divider */}
        <div className="my-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {/* Secondary */}
        {SECONDARY.map(item => (
          <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
        ))}

      </nav>

      {/* ── Bottom CTAs ──────────────────────────────────────────── */}
      <div
        className="shrink-0 px-3 py-4 flex flex-col gap-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}
      >

        {/* Connect Wallet */}
        <button
          className="w-full h-10 rounded-xl text-[13px] font-semibold transition-all"
          style={{
            color: '#2DD4BF',
            border: '1px solid rgba(45,212,191,0.4)',
            background: 'transparent',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background  = 'rgba(45,212,191,0.09)'
            el.style.borderColor = 'rgba(45,212,191,0.6)'
            el.style.boxShadow   = '0 0 22px rgba(45,212,191,0.18)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background  = 'transparent'
            el.style.borderColor = 'rgba(45,212,191,0.4)'
            el.style.boxShadow   = 'none'
          }}
        >
          Connect Wallet
        </button>

        {/* Sign In */}
        <button
          className="w-full h-10 rounded-xl text-[13px] font-medium transition-all"
          style={{
            color: '#94a3b8',
            border: '1px solid rgba(255,255,255,0.09)',
            background: 'rgba(255,255,255,0.03)',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color       = '#e2e8f0'
            el.style.background  = 'rgba(255,255,255,0.07)'
            el.style.borderColor = 'rgba(255,255,255,0.14)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color       = '#94a3b8'
            el.style.background  = 'rgba(255,255,255,0.03)'
            el.style.borderColor = 'rgba(255,255,255,0.09)'
          }}
        >
          Sign In
        </button>

        {/* Sign Up */}
        <button
          className="w-full h-10 rounded-xl text-[13px] font-bold transition-all active:scale-[0.98]"
          style={{
            background: 'linear-gradient(90deg, #2DD4BF 0%, #8B5CF6 100%)',
            color: '#ffffff',
            boxShadow: '0 0 24px rgba(45,212,191,0.22), 0 0 24px rgba(139,92,246,0.12)',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.opacity = '0.9'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.opacity = '1'
          }}
        >
          Sign Up — It&apos;s Free
        </button>

      </div>
    </aside>
  )
}

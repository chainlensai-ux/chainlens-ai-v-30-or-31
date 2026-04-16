'use client'

import Image from 'next/image'
import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

// ─── Icons (16×16, Lucide-style) ─────────────────────────────────────────

function IcHome() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}
function IcWalletScan() {
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
function IcTokenScreener() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6" strokeWidth="2.5"/>
      <line x1="3" y1="12" x2="3.01" y2="12" strokeWidth="2.5"/>
      <line x1="3" y1="18" x2="3.01" y2="18" strokeWidth="2.5"/>
    </svg>
  )
}
function IcGhostTrade() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>
    </svg>
  )
}
function IcTradeCoach() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 16v-4"/>
      <path d="M12 8h.01" strokeWidth="2.5"/>
    </svg>
  )
}
function IcPumpAlert() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  )
}
function IcPortfolioTracker() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>
      <path d="M22 12A10 10 0 0 0 12 2v10z"/>
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
function IcExchangeFlow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    </svg>
  )
}
function IcBearProof() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <polyline points="9 12 11 14 15 10"/>
    </svg>
  )
}
function IcSentimentPulse() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
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
  { key: 'wallet-scan',       label: 'Wallet Scan',       icon: <IcWalletScan />       },
  { key: 'token-scanner',     label: 'Token Scanner',     icon: <IcTokenScanner />     },
  { key: 'token-screener',    label: 'Token Screener',    icon: <IcTokenScreener />    },
  { key: 'ghost-trade',       label: 'GhostTrade',        icon: <IcGhostTrade />       },
  { key: 'trade-coach',       label: 'TradeCoach',        icon: <IcTradeCoach />       },
  { key: 'pump-alert',        label: 'PumpAlert',         icon: <IcPumpAlert />        },
  { key: 'portfolio-tracker', label: 'Portfolio Tracker', icon: <IcPortfolioTracker /> },
  { key: 'whale-alerts',      label: 'Whale Alerts',      icon: <IcWhaleAlerts />      },
  { key: 'exchange-flow',     label: 'Exchange Flow',     icon: <IcExchangeFlow />     },
  { key: 'bear-proof',        label: 'BearProof Score',   icon: <IcBearProof />        },
  { key: 'sentiment-pulse',   label: 'SentimentPulse',    icon: <IcSentimentPulse />   },
  { key: 'clark-ai',          label: 'Clark AI',          icon: <IcClarkAI />          },
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
      className="w-full flex items-center gap-3 py-[11px] px-3.5 rounded-xl text-[13px] font-medium border-l-2 transition-colors"
      style={
        on
          ? {
              background: 'rgba(45,212,191,0.1)',
              color: '#2DD4BF',
              borderLeftColor: '#2DD4BF',
              boxShadow: 'inset 0 0 0 1px rgba(45,212,191,0.1)',
            }
          : {
              color: '#e2e8f0',
              borderLeftColor: 'transparent',
            }
      }
      whileHover={!on ? { x: 2 } : {}}
      transition={{ duration: 0.12 }}
      onMouseEnter={e => {
        if (!on) {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)'
          ;(e.currentTarget as HTMLButtonElement).style.color = '#ffffff'
        }
      }}
      onMouseLeave={e => {
        if (!on) {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          ;(e.currentTarget as HTMLButtonElement).style.color = '#e2e8f0'
        }
      }}
    >
      <span style={{ color: on ? '#2DD4BF' : '#64748b', flexShrink: 0 }}>
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
      className="px-3.5 pt-1 pb-2 text-[10px] font-bold uppercase tracking-[0.16em]"
      style={{ color: '#475569' }}
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
      className="w-[260px] h-screen shrink-0 flex flex-col"
      style={{ background: '#080d17', borderRight: '1px solid rgba(255,255,255,0.07)' }}
    >

      {/* ── Branding ─────────────────────────────────────────────── */}
      <div
        className="relative px-5 pt-7 pb-6 shrink-0 overflow-hidden"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
      >
        {/* Ambient glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at 15% 50%, rgba(45,212,191,0.09) 0%, transparent 70%)',
          }}
        />
        <div className="relative flex items-center gap-3.5">
          <div
            className="shrink-0 rounded-2xl p-1.5"
            style={{
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.18)',
              boxShadow: '0 0 20px rgba(45,212,191,0.1)',
            }}
          >
            <Image src="/cl-logo.png" alt="ChainLens AI" width={36} height={36} className="shrink-0" />
          </div>
          <div>
            <p
              className="text-[17px] font-extrabold leading-tight tracking-tight"
              style={{ color: '#f8fafc' }}
            >
              Chain<span style={{ color: '#2DD4BF' }}>Lens</span>
              <span style={{ color: '#94a3b8', fontWeight: 600 }}> AI</span>
            </p>
            <p className="text-[10px] font-medium mt-0.5" style={{ color: '#475569' }}>
              Base Intelligence Terminal
            </p>
          </div>
        </div>
      </div>

      {/* ── Navigation ───────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-3.5 py-4 flex flex-col gap-1 scrollbar-none">

        {/* Home */}
        <NavItem
          item={{ key: 'home', label: 'Home', icon: <IcHome /> }}
          active={active}
          onSelect={onSelect}
        />

        {/* Divider */}
        <div className="h-px my-2" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {/* Tools section */}
        <SectionLabel>Tools</SectionLabel>
        {TOOLS.map(item => (
          <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
        ))}

        {/* Divider */}
        <div className="h-px my-2" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {/* Secondary */}
        {SECONDARY.map(item => (
          <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
        ))}

      </nav>

      {/* ── Bottom CTA ───────────────────────────────────────────── */}
      <div
        className="shrink-0 px-4 py-5 space-y-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}
      >

        {/* Connect Wallet */}
        <button
          className="w-full py-3 rounded-xl text-[13px] font-semibold transition-all"
          style={{
            color: '#2DD4BF',
            border: '1px solid rgba(45,212,191,0.45)',
            background: 'transparent',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background = 'rgba(45,212,191,0.1)'
            el.style.boxShadow = '0 0 20px rgba(45,212,191,0.15)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.background = 'transparent'
            el.style.boxShadow = 'none'
          }}
        >
          Connect Wallet
        </button>

        {/* Sign In */}
        <button
          className="w-full py-3 rounded-xl text-[13px] font-medium transition-all"
          style={{
            color: '#94a3b8',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'transparent',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color = '#e2e8f0'
            el.style.background = 'rgba(255,255,255,0.05)'
            el.style.borderColor = 'rgba(255,255,255,0.16)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color = '#94a3b8'
            el.style.background = 'transparent'
            el.style.borderColor = 'rgba(255,255,255,0.1)'
          }}
        >
          Sign In
        </button>

        {/* Sign Up */}
        <button
          className="w-full py-3 rounded-xl text-[13px] font-bold transition-all hover:opacity-90 active:scale-[0.98]"
          style={{
            background: 'linear-gradient(90deg, #2DD4BF 0%, #8B5CF6 100%)',
            color: '#ffffff',
            boxShadow: '0 0 28px rgba(45,212,191,0.25), 0 0 28px rgba(139,92,246,0.15)',
          }}
        >
          Sign Up — It&apos;s Free
        </button>

      </div>
    </aside>
  )
}

'use client'

import Image from 'next/image'
import Link from 'next/link'

// ─── Icons (18×18, Lucide-style) ─────────────────────────────────────────

function IcHome() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}
function IcTokenScanner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}
function IcWalletScanner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}
function IcDevWallet() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>
  )
}
function IcLiquidity() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
}
function IcWhaleAlerts() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}
function IcPumpAlerts() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  )
}
function IcBaseRadar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.64 17.36a9 9 0 1 1 12.72 0"/>
      <path d="M8.46 14.54a5 5 0 1 1 7.07 0"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  )
}
function IcClarkAI() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>
      <path d="M19 3v4m2-2h-4"/>
    </svg>
  )
}
function IcPortfolio() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  )
}
function IcSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
    </svg>
  )
}
function IcConnectWallet() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}

// ─── Data ─────────────────────────────────────────────────────────────────

type Item = { key: string; label: string; icon: React.ReactNode; href?: string }

const FEATURES: Item[] = [
  { key: 'token-scanner',     label: 'Token Scanner',       icon: <IcTokenScanner />,  href: '/terminal/token-scanner'  },
  { key: 'wallet-scanner',    label: 'Wallet Scanner',      icon: <IcWalletScanner />, href: '/terminal/wallet-scanner' },
  { key: 'dev-wallet',        label: 'Dev Wallet Detector', icon: <IcDevWallet />,     href: '/terminal/dev-wallet'     },
  { key: 'liquidity-scanner', label: 'Liquidity Safety',    icon: <IcLiquidity />,     href: '/terminal/liquidity'      },
  { key: 'whale-alerts',      label: 'Whale Alerts',        icon: <IcWhaleAlerts />,   href: '/terminal/whale-alerts'   },
  { key: 'pump-alerts',       label: 'Pump Alerts',         icon: <IcPumpAlerts />,    href: '/terminal/pump-alerts'    },
  { key: 'base-radar',        label: 'Base Radar',          icon: <IcBaseRadar />,     href: '/terminal/base-radar'     },
  { key: 'clark-ai',          label: 'Clark AI',            icon: <IcClarkAI />,       href: '/terminal/clark-ai'       },
]

const SECONDARY: Item[] = [
  { key: 'portfolio',      label: 'Portfolio',      icon: <IcPortfolio />     },
  { key: 'settings',       label: 'Settings',       icon: <IcSettings />      },
  { key: 'connect-wallet', label: 'Connect Wallet', icon: <IcConnectWallet /> },
]

// ─── NavItem ──────────────────────────────────────────────────────────────

interface NavItemProps {
  item:     Item
  active:   string | null
  onSelect: (key: string) => void
}

function NavItem({ item, active, onSelect }: NavItemProps) {
  const on = active === item.key

  const sharedClassName = "w-full flex items-center gap-3 py-3 px-3.5 rounded-xl text-[13px] font-medium transition-all duration-150 border-l-2"
  const activeStyle = {
    background: 'rgba(45,212,191,0.1)',
    color: '#2DD4BF',
    borderLeftColor: '#2DD4BF',
    boxShadow: 'inset 0 0 0 1px rgba(45,212,191,0.12)',
  }
  const inactiveStyle = { color: '#6d8299', borderLeftColor: 'transparent' }

  const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
    if (!on) {
      (e.currentTarget as HTMLElement).style.color = '#a0b4c8';
      (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
    }
  }
  const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
    if (!on) {
      (e.currentTarget as HTMLElement).style.color = '#6d8299';
      (e.currentTarget as HTMLElement).style.background = 'transparent';
    }
  }

  const inner = (
    <>
      <span style={{ color: on ? '#2DD4BF' : '#556880', flexShrink: 0 }}>
        {item.icon}
      </span>
      {item.label}
    </>
  )

  if (item.href) {
    return (
      <Link
        href={item.href}
        className={sharedClassName}
        style={on ? activeStyle : inactiveStyle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {inner}
      </Link>
    )
  }

  return (
    <button
      onClick={() => onSelect(item.key)}
      className={sharedClassName}
      style={on ? activeStyle : inactiveStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {inner}
    </button>
  )
}

// ─── SectionLabel ─────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3.5 pb-2 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: '#6d8a9e' }}>
      {children}
    </p>
  )
}

// ─── Component ────────────────────────────────────────────────────────────

interface Props {
  active?:   string | null
  onSelect?: (key: string) => void
}

export default function Sidebar({ active = 'home', onSelect = () => {} }: Props) {
  return (
    <aside
      className="w-[272px] h-dvh shrink-0 flex flex-col"
      style={{ background: '#080c14', borderRight: '1px solid rgba(255,255,255,0.08)' }}
    >

      {/* ── Branding ─────────────────────────────────────────────────── */}
      <div
        className="relative px-6 pt-9 pb-8 overflow-hidden"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        {/* Subtle mint glow behind logo */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at 20% 60%, rgba(45,212,191,0.07) 0%, transparent 65%)' }}
        />
        <div className="relative flex items-center gap-4">
          <div
            className="shrink-0 rounded-2xl p-1"
            style={{ background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.15)' }}
          >
            <Image
              src="/cl-logo.png"
              alt="ChainLens AI"
              width={40}
              height={40}
              className="shrink-0"
            />
          </div>
          <div>
            <p
              className="text-[19px] font-extrabold leading-tight tracking-tight"
              style={{ color: '#f8fafc' }}
            >
              Chain<span style={{ color: '#2DD4BF' }}>Lens</span>
              <span style={{ color: '#94a3b8', fontWeight: 600 }}> AI</span>
            </p>
            <p className="text-[11px] font-medium mt-1" style={{ color: '#7d96ae' }}>
              Base Intelligence Terminal
            </p>
          </div>
        </div>
      </div>

      {/* ── Navigation ───────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-4 py-7 flex flex-col gap-6">

        {/* Home */}
        <div>
          <NavItem
            item={{ key: 'home', label: 'Home', icon: <IcHome /> }}
            active={active}
            onSelect={onSelect}
          />
        </div>

        {/* Features */}
        <div>
          <SectionLabel>Tools</SectionLabel>
          <div className="space-y-1">
            {FEATURES.map(item => (
              <NavItem
                key={item.key}
                item={item}
                active={active}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="h-px" style={{ background: 'rgba(255,255,255,0.08)', margin: '0 -2px' }} />

        {/* Secondary */}
        <div className="space-y-1">
          {SECONDARY.map(item => (
            <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
          ))}
        </div>

      </nav>

      {/* ── Auth ─────────────────────────────────────────────────────── */}
      <div
        className="px-5 py-6 space-y-2.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
      >
        <button
          className="w-full py-3.5 rounded-xl text-[13px] font-bold tracking-tight transition-all duration-150 hover:opacity-90 active:scale-[0.98]"
          style={{
            background: '#2DD4BF',
            color: '#020d0a',
            boxShadow: '0 0 32px rgba(45,212,191,0.32), 0 1px 0 rgba(255,255,255,0.25) inset',
          }}
        >
          Sign Up — It&apos;s Free
        </button>
        <button
          className="w-full py-3.5 rounded-xl text-[13px] font-medium transition-all duration-150"
          style={{
            color: '#6d8299',
            border: '1px solid rgba(255,255,255,0.1)',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.color = '#a0b4c8';
            el.style.borderColor = 'rgba(255,255,255,0.18)';
            el.style.background = 'rgba(255,255,255,0.04)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.color = '#6d8299';
            el.style.borderColor = 'rgba(255,255,255,0.1)';
            el.style.background = 'transparent';
          }}
        >
          Sign In
        </button>
      </div>

    </aside>
  )
}

'use client'

import Image from 'next/image'

// ─── Icons (18×18, strokeWidth 1.5, Lucide-style) ─────────────────────────

function IcHome() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}
function IcTokenScanner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}
function IcWalletScanner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}
function IcDevWallet() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>
  )
}
function IcLiquidity() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
}
function IcWhaleAlerts() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}
function IcPumpAlerts() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  )
}
function IcBaseRadar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.64 17.36a9 9 0 1 1 12.72 0"/>
      <path d="M8.46 14.54a5 5 0 1 1 7.07 0"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  )
}
function IcClarkAI() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>
      <path d="M19 3v4m2-2h-4"/>
    </svg>
  )
}
function IcPortfolio() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  )
}
function IcSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
    </svg>
  )
}
function IcConnectWallet() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}

// ─── Data ─────────────────────────────────────────────────────────────────

type Item = { key: string; label: string; icon: React.ReactNode }

const FEATURES: Item[] = [
  { key: 'token-scanner',     label: 'Token Scanner',       icon: <IcTokenScanner />  },
  { key: 'wallet-scanner',    label: 'Wallet Scanner',      icon: <IcWalletScanner /> },
  { key: 'dev-wallet',        label: 'Dev Wallet Detector', icon: <IcDevWallet />     },
  { key: 'liquidity-scanner', label: 'Liquidity Safety',    icon: <IcLiquidity />     },
  { key: 'whale-alerts',      label: 'Whale Alerts',        icon: <IcWhaleAlerts />   },
  { key: 'pump-alerts',       label: 'Pump Alerts',         icon: <IcPumpAlerts />    },
  { key: 'base-radar',        label: 'Base Radar',          icon: <IcBaseRadar />     },
  { key: 'clark-ai',          label: 'Clark AI',            icon: <IcClarkAI />       },
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
  return (
    <button
      onClick={() => onSelect(item.key)}
      className={[
        'w-full flex items-center gap-3 py-2.5 px-3.5 rounded-xl',
        'text-[13px] font-medium border-l-2 transition-all duration-150',
        on
          ? 'bg-[#2DD4BF]/[0.1] text-[#2DD4BF] border-[#2DD4BF]'
          : 'text-[#64748b] border-transparent hover:text-[#94a3b8] hover:bg-white/[0.05]',
      ].join(' ')}
    >
      <span className={`shrink-0 ${on ? 'text-[#2DD4BF]' : 'text-[#475569]'}`}>
        {item.icon}
      </span>
      {item.label}
    </button>
  )
}

// ─── SectionLabel ─────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3.5 pb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#475569]">
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
    <aside className="w-[256px] h-screen shrink-0 flex flex-col bg-[#080c14] border-r border-white/[0.08]">

      {/* ── Branding ─────────────────────────────────────────────────── */}
      <div className="px-5 pt-8 pb-7 border-b border-white/[0.07]">
        <div className="flex items-center gap-3.5">
          <Image
            src="/cl-logo.png"
            alt="ChainLens AI"
            width={40}
            height={40}
            className="shrink-0"
          />
          <div>
            <p className="text-[18px] font-bold text-white leading-tight tracking-tight">
              Chain<span className="text-[#2DD4BF]">Lens</span>
              <span className="text-[#94a3b8] font-semibold"> AI</span>
            </p>
            <p className="text-[11px] text-[#64748b] mt-[3px] font-medium">
              Base Intelligence Terminal
            </p>
          </div>
        </div>
      </div>

      {/* ── Navigation ───────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-7">

        {/* Home */}
        <div>
          <NavItem
            item={{ key: 'home', label: 'Home', icon: <IcHome /> }}
            active={active}
            onSelect={onSelect}
          />
        </div>

        {/* Features */}
        <div className="space-y-1">
          <SectionLabel>Features</SectionLabel>
          {FEATURES.map(item => (
            <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
          ))}
        </div>

        {/* Divider */}
        <div className="h-px bg-white/[0.07] -mx-1" />

        {/* Secondary */}
        <div className="space-y-1">
          {SECONDARY.map(item => (
            <NavItem key={item.key} item={item} active={active} onSelect={onSelect} />
          ))}
        </div>

      </nav>

      {/* ── Auth ─────────────────────────────────────────────────────── */}
      <div className="px-5 py-6 space-y-2.5 border-t border-white/[0.07]">
        <button
          className="w-full py-3 rounded-xl bg-[#2DD4BF] text-[#06060a] text-[13px] font-bold tracking-tight hover:bg-[#25bfac] active:bg-[#1fa898] transition-all duration-150"
          style={{ boxShadow: '0 0 24px rgba(45,212,191,0.25)' }}
        >
          Sign Up — Free
        </button>
        <button className="w-full py-3 rounded-xl border border-white/[0.1] text-[#64748b] text-[13px] font-medium hover:text-[#94a3b8] hover:border-white/[0.18] hover:bg-white/[0.04] transition-all duration-150">
          Sign In
        </button>
      </div>

    </aside>
  )
}

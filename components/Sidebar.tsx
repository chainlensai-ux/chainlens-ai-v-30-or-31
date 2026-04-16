'use client'

import Image from 'next/image'

// ─── Icons (Lucide-style, 15×15, strokeWidth 1.75) ────────────────────────

const Icons = {
  home: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  tokenScanner: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  walletScanner: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  ),
  devWallet: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>
  ),
  liquidity: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  whaleAlerts: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  ),
  pumpAlerts: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  ),
  baseRadar: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.64 17.36a9 9 0 1 1 12.72 0"/>
      <path d="M8.46 14.54a5 5 0 1 1 7.07 0"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  ),
  clarkAI: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>
      <path d="M19 3v4m2-2h-4"/>
    </svg>
  ),
  portfolio: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
    </svg>
  ),
  connectWallet: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2"/>
      <path d="M16 3H8a2 2 0 0 0-2 2v2h12V5a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="14" r="2"/>
    </svg>
  ),
}

// ─── Nav data ──────────────────────────────────────────────────────────────

const FEATURES = [
  { key: 'token-scanner',     label: 'Token Scanner',       icon: Icons.tokenScanner  },
  { key: 'wallet-scanner',    label: 'Wallet Scanner',      icon: Icons.walletScanner },
  { key: 'dev-wallet',        label: 'Dev Wallet Detector', icon: Icons.devWallet     },
  { key: 'liquidity-scanner', label: 'Liquidity Safety',    icon: Icons.liquidity     },
  { key: 'whale-alerts',      label: 'Whale Alerts',        icon: Icons.whaleAlerts   },
  { key: 'pump-alerts',       label: 'Pump Alerts',         icon: Icons.pumpAlerts    },
  { key: 'base-radar',        label: 'Base Radar',          icon: Icons.baseRadar     },
  { key: 'clark-ai',          label: 'Clark AI',            icon: Icons.clarkAI       },
]

const SECONDARY = [
  { key: 'portfolio',       label: 'Portfolio',       icon: Icons.portfolio      },
  { key: 'settings',        label: 'Settings',        icon: Icons.settings       },
  { key: 'connect-wallet',  label: 'Connect Wallet',  icon: Icons.connectWallet  },
]

// ─── Primitives ────────────────────────────────────────────────────────────

interface NavItemProps {
  navKey:   string
  label:    string
  icon:     React.ReactNode
  active:   string | null
  onSelect: (key: string) => void
}

function NavItem({ navKey, label, icon, active, onSelect }: NavItemProps) {
  const isActive = active === navKey
  return (
    <button
      onClick={() => onSelect(navKey)}
      className={[
        'w-full flex items-center gap-3 px-3 py-[9px] rounded-lg text-left',
        'border-l-2 transition-all duration-150',
        isActive
          ? 'bg-[#2DD4BF]/[0.08] text-[#2DD4BF] border-[#2DD4BF]'
          : 'text-[#64748b] hover:text-[#94a3b8] hover:bg-white/[0.04] border-transparent',
      ].join(' ')}
    >
      <span className="shrink-0">{icon}</span>
      <span className="text-[13px] font-medium">{label}</span>
    </button>
  )
}

function Divider() {
  return <div className="my-2 h-px bg-white/[0.06]" />
}

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="px-3 pt-4 pb-1.5 text-[10px] font-semibold text-[#3d5066] uppercase tracking-[0.1em]">
      {label}
    </p>
  )
}

// ─── Component ─────────────────────────────────────────────────────────────

interface Props {
  active?:  string | null
  onSelect?: (key: string) => void
}

export default function Sidebar({ active = 'home', onSelect = () => {} }: Props) {
  return (
    <aside className="w-[240px] h-screen shrink-0 flex flex-col bg-[#080c14] border-r border-white/[0.08] overflow-hidden">

      {/* Logo */}
      <div className="px-5 pt-5 pb-4 shrink-0 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <Image
            src="/cl-logo.png"
            alt="ChainLens AI"
            width={28}
            height={28}
            className="shrink-0"
          />
          <div>
            <div className="text-[15px] font-bold text-white leading-tight tracking-tight">
              Chain<span className="text-[#2DD4BF]">Lens</span>
              <span className="font-semibold text-[#475569]"> AI</span>
            </div>
            <p className="text-[10px] text-[#3d5066] mt-0.5 font-medium">
              Base Intelligence Terminal
            </p>
          </div>
        </div>
      </div>

      {/* Scrollable nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">

        <NavItem
          navKey="home"
          label="Home"
          icon={Icons.home}
          active={active}
          onSelect={onSelect}
        />

        <SectionLabel label="Features" />

        {FEATURES.map(item => (
          <NavItem
            key={item.key}
            navKey={item.key}
            label={item.label}
            icon={item.icon}
            active={active}
            onSelect={onSelect}
          />
        ))}

        <Divider />

        {SECONDARY.map(item => (
          <NavItem
            key={item.key}
            navKey={item.key}
            label={item.label}
            icon={item.icon}
            active={active}
            onSelect={onSelect}
          />
        ))}

      </nav>

      {/* Auth */}
      <div className="px-4 py-4 border-t border-white/[0.06] space-y-2 shrink-0">
        <button className="w-full py-2.5 rounded-xl bg-[#2DD4BF] text-[#06060a] text-[13px] font-bold hover:bg-[#25bfac] active:bg-[#1fa898] transition-colors">
          Sign Up
        </button>
        <button className="w-full py-2.5 rounded-xl border border-white/[0.09] text-[#64748b] text-[13px] font-medium hover:text-[#94a3b8] hover:border-white/[0.15] hover:bg-white/[0.04] transition-colors">
          Sign In
        </button>
      </div>

    </aside>
  )
}

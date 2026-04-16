'use client'

import Image from 'next/image'

const NAV_GROUPS = [
  {
    label: 'Scanners',
    items: [
      { key: 'token-scanner',     label: 'Token Scanner' },
      { key: 'wallet-scanner',    label: 'Wallet Scanner' },
      { key: 'dev-wallet',        label: 'Dev Wallet' },
      { key: 'liquidity-scanner', label: 'Liquidity Safety' },
    ],
  },
  {
    label: 'Alerts',
    items: [
      { key: 'whale-alerts', label: 'Whale Alerts' },
      { key: 'pump-alerts',  label: 'Pump Alerts' },
    ],
  },
  {
    label: 'Radar & AI',
    items: [
      { key: 'base-radar', label: 'Base Radar' },
      { key: 'clark-ai',   label: 'Clark AI' },
    ],
  },
]

interface Props {
  active: string | null
  onSelect: (key: string) => void
}

interface NavItemProps {
  label: string
  isActive: boolean
  onClick: () => void
}

function NavItem({ label, isActive, onClick }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={[
        'w-full flex items-center pl-3.5 pr-2 py-2.5 rounded-xl text-left border-l-2 transition-all',
        isActive
          ? 'bg-[#2DD4BF]/[0.1] text-[#2DD4BF] border-[#2DD4BF]'
          : 'text-[#64748b] hover:text-[#94a3b8] hover:bg-white/[0.05] border-transparent',
      ].join(' ')}
    >
      <span className="text-[13px] font-semibold truncate">{label}</span>
    </button>
  )
}

export default function FeatureBar({ active, onSelect }: Props) {
  return (
    <aside className="w-[220px] shrink-0 h-screen flex flex-col bg-[#080c14] border-r border-white/[0.08] overflow-hidden">

      {/* Logo */}
      <div className="px-5 pt-5 pb-5 border-b border-white/[0.07] shrink-0">
        <div className="flex items-center gap-3">
          <Image
            src="/cl-logo.png"
            alt="ChainLens AI"
            width={28}
            height={28}
            className="shrink-0"
          />
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-white leading-tight tracking-tight">
              Chain<span className="text-[#2DD4BF]">Lens</span>
            </div>
            <div className="text-[10px] text-[#475569] mt-0.5 font-medium tracking-wide">AI Terminal</div>
          </div>
        </div>
      </div>

      {/* Home */}
      <div className="px-3 pt-4 pb-2 shrink-0">
        <button
          onClick={() => onSelect('home')}
          className={[
            'w-full flex items-center gap-2.5 pl-3.5 pr-2 py-2.5 rounded-xl transition-all border-l-2',
            active === 'home'
              ? 'bg-[#2DD4BF]/[0.1] text-[#2DD4BF] border-[#2DD4BF]'
              : 'text-[#64748b] hover:text-[#94a3b8] hover:bg-white/[0.05] border-transparent',
          ].join(' ')}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          <span className="text-[13px] font-semibold">Home</span>
        </button>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        {NAV_GROUPS.map(group => (
          <div key={group.label} className="mb-1">
            <div className="px-1 pt-5 pb-2">
              <span className="text-[10px] font-bold text-[#475569] uppercase tracking-[0.12em]">
                {group.label}
              </span>
            </div>
            <div className="space-y-0.5">
              {group.items.map(item => (
                <NavItem
                  key={item.key}
                  label={item.label}
                  isActive={active === item.key}
                  onClick={() => onSelect(item.key)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom actions */}
      <div className="px-3 py-5 border-t border-white/[0.07] space-y-2 shrink-0">
        <button className="w-full flex items-center gap-2.5 pl-3.5 pr-2 py-2.5 rounded-xl transition-all text-[#64748b] hover:text-[#94a3b8] hover:bg-white/[0.05]">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
          </svg>
          <span className="text-[13px] font-semibold">Settings</span>
        </button>
        <button
          className="w-full flex items-center justify-center px-3 py-2.5 rounded-xl bg-[#2DD4BF] text-[#06060a] font-bold hover:bg-[#25bfac] transition-colors"
          style={{ boxShadow: '0 0 20px rgba(45,212,191,0.2)' }}
        >
          <span className="text-[12px]">Connect Wallet</span>
        </button>
      </div>

    </aside>
  )
}

'use client'

import Image from 'next/image'

const NAV_GROUPS = [
  {
    label: 'Scanners',
    items: [
      { key: 'token-scanner',     label: 'Token Scanner'    },
      { key: 'wallet-scanner',    label: 'Wallet Scanner'   },
      { key: 'dev-wallet',        label: 'Dev Wallet'       },
      { key: 'liquidity-scanner', label: 'Liquidity Safety' },
    ],
  },
  {
    label: 'Alerts',
    items: [
      { key: 'whale-alerts', label: 'Whale Alerts' },
      { key: 'pump-alerts',  label: 'Pump Alerts'  },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { key: 'base-radar', label: 'Base Radar' },
      { key: 'clark-ai',   label: 'Clark AI'   },
    ],
  },
]

interface Props {
  active: string | null
  onSelect: (key: string) => void
}

function NavItem({ label, isActive, onClick }: { label: string; isActive: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center pl-3.5 pr-3 py-2.5 rounded-xl text-left border-l-2 transition-all"
      style={
        isActive
          ? { background: 'rgba(45,212,191,0.09)', color: '#2DD4BF', borderLeftColor: '#2DD4BF' }
          : { color: '#64748b', borderLeftColor: 'transparent' }
      }
      onMouseEnter={e => {
        if (!isActive) {
          (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
        }
      }}
      onMouseLeave={e => {
        if (!isActive) {
          (e.currentTarget as HTMLButtonElement).style.color = '#64748b';
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        }
      }}
    >
      <span className="text-[13px] font-semibold truncate">{label}</span>
    </button>
  )
}

export default function FeatureBar({ active, onSelect }: Props) {
  return (
    <aside
      className="w-[220px] shrink-0 h-screen flex flex-col overflow-hidden"
      style={{ background: '#080c14', borderRight: '1px solid rgba(255,255,255,0.07)' }}
    >

      {/* Logo */}
      <div
        className="px-5 pt-6 pb-5 shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
      >
        <div className="flex items-center gap-3">
          <Image
            src="/cl-logo.png"
            alt="ChainLens AI"
            width={30}
            height={30}
            className="shrink-0"
          />
          <div className="min-w-0">
            <div className="text-[15px] font-extrabold text-white leading-tight tracking-tight">
              Chain<span style={{ color: '#2DD4BF' }}>Lens</span>
            </div>
            <div className="text-[10px] font-medium mt-0.5" style={{ color: '#475569' }}>AI Terminal</div>
          </div>
        </div>
      </div>

      {/* Home */}
      <div className="px-3 pt-4 pb-1 shrink-0">
        <button
          onClick={() => onSelect('home')}
          className="w-full flex items-center gap-2.5 pl-3.5 pr-3 py-2.5 rounded-xl transition-all border-l-2"
          style={
            active === 'home'
              ? { background: 'rgba(45,212,191,0.09)', color: '#2DD4BF', borderLeftColor: '#2DD4BF' }
              : { color: '#64748b', borderLeftColor: 'transparent' }
          }
          onMouseEnter={e => {
            if (active !== 'home') {
              (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
            }
          }}
          onMouseLeave={e => {
            if (active !== 'home') {
              (e.currentTarget as HTMLButtonElement).style.color = '#64748b';
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }
          }}
        >
          <svg
            width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
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
          <div key={group.label} className="mt-5">
            <p
              className="px-1 pb-2 text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{ color: '#475569' }}
            >
              {group.label}
            </p>
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

      {/* Bottom */}
      <div
        className="px-3 py-4 space-y-2 shrink-0"
        style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}
      >
        <button
          className="w-full flex items-center gap-2.5 pl-3.5 pr-3 py-2.5 rounded-xl transition-all"
          style={{ color: '#64748b' }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.color = '#64748b';
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          <svg
            width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
            className="shrink-0"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
          </svg>
          <span className="text-[13px] font-semibold">Settings</span>
        </button>
        <button
          className="w-full flex items-center justify-center py-2.5 rounded-xl text-[12px] font-bold transition-all hover:opacity-90 active:opacity-75"
          style={{
            background: '#2DD4BF',
            color: '#04070f',
            boxShadow: '0 0 20px rgba(45,212,191,0.25)',
          }}
        >
          Connect Wallet
        </button>
      </div>

    </aside>
  )
}

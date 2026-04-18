'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'

const TERMINAL_TOOLS = [
  { icon: '🧪', name: 'Token Scanner',   href: '/terminal/token-scanner', tier: 'free'  },
  { icon: '💧', name: 'Liquidity Safety',href: '/terminal/liquidity',     tier: 'free'  },
  { icon: '🤖', name: 'Clark AI',        href: '/terminal?tab=clark',     tier: 'elite' },
  { icon: '👛', name: 'Wallet Scanner',  href: '/terminal?tab=wallet',    tier: 'pro'   },
  { icon: '🧬', name: 'Dev Wallets',     href: '/terminal?tab=devs',      tier: 'pro'   },
  { icon: '🐋', name: 'Whale Alerts',    href: '/terminal?tab=whales',    tier: 'pro'   },
  { icon: '🚨', name: 'Pump Alerts',     href: '/terminal?tab=pumps',     tier: 'pro'   },
  { icon: '📡', name: 'Base Radar',      href: '/terminal?tab=radar',     tier: 'pro'   },
]

const TIER_COLUMNS = [
  {
    tier: 'FREE',
    color: '#ec4899',
    bg: 'rgba(236,72,153,0.10)',
    border: 'rgba(236,72,153,0.20)',
    tools: [
      { icon: '🧪', name: 'Token Scanner',    href: '/terminal/token-scanner', note: 'Basic' },
      { icon: '💧', name: 'Liquidity Safety', href: '/terminal/liquidity',      note: 'Basic score' },
      { icon: '🤖', name: 'Clark AI',         href: '/terminal?tab=clark',      note: '3 prompts/day' },
    ],
  },
  {
    tier: 'PRO',
    color: '#2DD4BF',
    bg: 'rgba(45,212,191,0.08)',
    border: 'rgba(45,212,191,0.20)',
    tools: [
      { icon: '🧪', name: 'Token Scanner',    href: '/terminal/token-scanner', note: 'Full' },
      { icon: '💧', name: 'Liquidity Safety', href: '/terminal/liquidity',      note: 'Full analysis' },
      { icon: '👛', name: 'Wallet Scanner',   href: '/terminal?tab=wallet',     note: '' },
      { icon: '🧬', name: 'Dev Wallets',      href: '/terminal?tab=devs',       note: '' },
      { icon: '🐋', name: 'Whale Alerts',     href: '/terminal?tab=whales',     note: '' },
      { icon: '🚨', name: 'Pump Alerts',      href: '/terminal?tab=pumps',      note: '' },
      { icon: '📡', name: 'Base Radar',       href: '/terminal?tab=radar',      note: '' },
      { icon: '🤖', name: 'Clark AI',         href: '/terminal?tab=clark',      note: '50 prompts/day' },
    ],
  },
  {
    tier: 'ELITE',
    color: '#fbbf24',
    bg: 'rgba(251,191,36,0.08)',
    border: 'rgba(251,191,36,0.22)',
    tools: [
      { icon: '🤖', name: 'Clark AI',         href: '/terminal?tab=clark',      note: 'Unlimited' },
      { icon: '⚡', name: 'Auto Verdicts',     href: '/terminal?tab=clark',      note: 'Every scan' },
      { icon: '🧠', name: 'Smart Money',       href: '/terminal?tab=wallet',     note: 'Tracking' },
      { icon: '🐋', name: 'Whale Alerts',      href: '/terminal?tab=whales',     note: 'Advanced' },
      { icon: '🔮', name: 'Priority CORTEX',   href: '/terminal?tab=clark',      note: 'Full engine' },
      { icon: '🚀', name: 'Early Access',      href: '/app',                     note: 'New features' },
    ],
  },
]

export default function Navbar() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <style>{`
        @keyframes nav-teal-glow {
          0%,100% { opacity: 0.55; }
          50%      { opacity: 0.85; }
        }
        .nav-link {
          color: rgba(255,255,255,0.55);
          text-decoration: none;
          font-size: 13px;
          font-weight: 500;
          letter-spacing: 0.01em;
          transition: color 0.15s;
          padding: 6px 0;
          position: relative;
        }
        .nav-link:hover { color: #fff; }
        .nav-link::after {
          content: '';
          position: absolute;
          bottom: 0; left: 0; right: 0;
          height: 1px;
          background: linear-gradient(90deg, #2DD4BF, #8b5cf6);
          opacity: 0;
          transition: opacity 0.2s;
          border-radius: 1px;
        }
        .nav-link:hover::after { opacity: 1; }

        .tools-btn {
          background: none; border: none;
          color: rgba(255,255,255,0.55);
          cursor: pointer; font-size: 13px;
          font-weight: 500; font-family: inherit;
          display: flex; align-items: center; gap: 5px;
          padding: 6px 0; transition: color 0.15s;
          position: relative;
        }
        .tools-btn:hover { color: #fff; }
        .tools-btn.open   { color: #fff; }

        .tools-item {
          display: flex; align-items: center; justify-content: space-between;
          padding: 9px 12px; border-radius: 10px;
          text-decoration: none; color: rgba(255,255,255,0.70);
          font-size: 12px; font-weight: 600;
          transition: background 0.15s, color 0.15s, transform 0.15s;
          border: 1px solid transparent;
        }
        .tools-item:hover {
          background: rgba(45,212,191,0.07);
          border-color: rgba(45,212,191,0.14);
          color: #fff;
          transform: translateX(3px);
        }

        /* Dropdown slide animation */
        @keyframes tools-slide-in {
          from { opacity: 0; transform: translateY(-6px) scaleY(0.97); }
          to   { opacity: 1; transform: translateY(0)   scaleY(1); }
        }
        @keyframes tools-item-in {
          from { opacity: 0; transform: translateX(-6px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .tools-dropdown {
          transform-origin: top center;
          animation: tools-slide-in 0.18s cubic-bezier(0.22,1,0.36,1) both;
        }
        .tools-dropdown-item {
          opacity: 0;
          animation: tools-item-in 0.18s cubic-bezier(0.22,1,0.36,1) both;
        }

        .btn-signin {
          padding: 7px 16px;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          background: transparent;
          color: rgba(255,255,255,0.55);
          font-size: 12px; font-weight: 600;
          text-decoration: none;
          letter-spacing: 0.06em; text-transform: uppercase;
          transition: border-color 0.15s, color 0.15s;
        }
        .btn-signin:hover {
          border-color: rgba(255,255,255,0.28);
          color: #fff;
        }

        .btn-access {
          padding: 7px 16px; border-radius: 8px;
          background: rgba(139,92,246,0.15);
          border: 1px solid rgba(139,92,246,0.30);
          color: rgba(255,255,255,0.75);
          font-size: 12px; font-weight: 600;
          text-decoration: none;
          letter-spacing: 0.06em; text-transform: uppercase;
          transition: background 0.15s, color 0.15s, border-color 0.15s;
        }
        .btn-access:hover {
          background: rgba(139,92,246,0.28);
          border-color: rgba(139,92,246,0.55);
          color: #fff;
        }

        .btn-terminal {
          padding: 7px 18px; border-radius: 8px; border: none;
          background: linear-gradient(90deg, #2DD4BF 0%, #8b5cf6 100%);
          color: #04101a;
          font-size: 12px; font-weight: 800;
          text-decoration: none;
          letter-spacing: 0.08em; text-transform: uppercase;
          box-shadow: 0 0 18px rgba(45,212,191,0.35), 0 0 18px rgba(139,92,246,0.20);
          transition: opacity 0.15s, box-shadow 0.15s, transform 0.15s;
          white-space: nowrap;
        }
        .btn-terminal:hover {
          opacity: 0.90;
          transform: translateY(-1px);
          box-shadow: 0 0 28px rgba(45,212,191,0.55), 0 0 28px rgba(139,92,246,0.35);
        }
      `}</style>

      <nav style={{
        width: '100%',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        background: '#080c14',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        /* subtle teal glow peeking from under the bar */
        boxShadow: '0 1px 0 rgba(255,255,255,0.04), 0 4px 32px rgba(45,212,191,0.06)',
        overflow: 'visible',
      }}>

        {/* Very thin teal gradient line at the very top */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '1px',
          background: 'linear-gradient(90deg, transparent 0%, rgba(45,212,191,0.50) 30%, rgba(139,92,246,0.40) 65%, transparent 100%)',
          animation: 'nav-teal-glow 4s ease-in-out infinite',
        }} />

        <div style={{
          maxWidth: '1200px',
          margin: '0 auto',
          padding: '0 28px',
          height: '60px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '24px',
        }}>

          {/* ── Logo ───────────────────────────────────────── */}
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', flexShrink: 0 }}>
            <Image src="/cl-logo.png" alt="ChainLens AI" width={36} height={36} />
            <div>
              <div style={{ fontFamily: 'var(--font-inter, Inter, sans-serif)', fontWeight: 800, fontSize: '15px', lineHeight: 1.15 }}>
                <span style={{ color: '#f1f5f9' }}>Chain</span>
                <span style={{
                  background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 60%, #ec4899 100%)',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
                }}>Lens</span>
              </div>
              <div style={{
                fontSize: '8px', color: 'rgba(45,212,191,0.55)',
                letterSpacing: '0.18em', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                AI Intelligence
              </div>
            </div>
          </Link>

          {/* ── Nav links ──────────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>

            {/* Tools dropdown */}
            <div style={{ position: 'relative' }}>
              <button
                className={`tools-btn${open ? ' open' : ''}`}
                onClick={() => setOpen(o => !o)}
                onBlur={e => {
                  if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node))
                    setOpen(false)
                }}
              >
                Tools
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none"
                  style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>
                  <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {open && (
                <div
                  className="tools-dropdown"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 10px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: '#06060e',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '16px',
                    padding: '14px',
                    width: '580px',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: '10px',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.85), 0 0 0 0.5px rgba(45,212,191,0.06)',
                    zIndex: 200,
                  }}
                  onMouseDown={e => e.preventDefault()}
                >
                  {/* Gradient accent top */}
                  <div style={{
                    position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
                    background: 'linear-gradient(90deg, transparent, rgba(236,72,153,0.35), rgba(45,212,191,0.35), rgba(251,191,36,0.35), transparent)',
                    borderRadius: '1px',
                  }} />

                  {TIER_COLUMNS.map((col, ci) => (
                    <div
                      key={col.tier}
                      className="tools-dropdown-item"
                      style={{
                        display: 'flex', flexDirection: 'column', gap: '2px',
                        animationDelay: `${ci * 0.06}s`,
                      }}
                    >
                      {/* Column header */}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '6px 8px 8px',
                        borderBottom: `1px solid ${col.border}`,
                        marginBottom: '4px',
                      }}>
                        <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: col.color, boxShadow: `0 0 6px ${col.color}` }} />
                        <span style={{
                          fontSize: '9px', fontWeight: 800, letterSpacing: '0.18em',
                          color: col.color,
                          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                        }}>{col.tier}</span>
                      </div>

                      {/* Tools in this tier */}
                      {col.tools.map((t, ti) => (
                        <Link
                          key={`${col.tier}-${t.name}`}
                          href={t.href}
                          className="tools-item tools-dropdown-item"
                          onClick={() => setOpen(false)}
                          style={{
                            animationDelay: `${ci * 0.06 + ti * 0.03}s`,
                            padding: '7px 8px',
                            flexDirection: 'column',
                            alignItems: 'flex-start',
                            gap: '1px',
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                            <span style={{ fontSize: '12px', lineHeight: 1 }}>{t.icon}</span>
                            <span style={{ fontSize: '11px', fontWeight: 600, color: 'rgba(255,255,255,0.80)' }}>{t.name}</span>
                          </span>
                          {t.note && (
                            <span style={{
                              fontSize: '9px', color: col.color, opacity: 0.70,
                              paddingLeft: '19px',
                              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                              letterSpacing: '0.06em',
                            }}>{t.note}</span>
                          )}
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Link href="/terminal" className="nav-link">Terminal</Link>
            <Link href="/pricing"  className="nav-link">Pricing</Link>
            <Link href="/about"    className="nav-link">About</Link>
          </div>

          {/* ── Auth buttons ───────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <Link href="/auth"     className="btn-signin">Sign In</Link>
            <Link href="/app"      className="btn-access">Get Access</Link>
            <Link href="/terminal" className="btn-terminal">Enter Terminal</Link>
          </div>

        </div>
      </nav>
    </>
  )
}

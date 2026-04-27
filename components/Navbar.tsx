'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'

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
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <>
      <style>{`
        @keyframes nav-live-pulse {
          0%,100% { opacity: 1; box-shadow: 0 0 5px rgba(74,222,128,0.8); }
          50%      { opacity: 0.5; box-shadow: 0 0 2px rgba(74,222,128,0.3); }
        }
        @keyframes nav-shell-glow {
          0%,100% { box-shadow: 0 0 0 1px rgba(45,212,191,0.08), 0 8px 40px rgba(0,0,0,0.55), 0 0 60px rgba(45,212,191,0.03); }
          50%      { box-shadow: 0 0 0 1px rgba(45,212,191,0.16), 0 8px 40px rgba(0,0,0,0.55), 0 0 60px rgba(45,212,191,0.07); }
        }
        .nav-shell { animation: nav-shell-glow 5s ease-in-out infinite; }

        .nav-link {
          color: rgba(255,255,255,0.55);
          text-decoration: none;
          font-size: 13.5px;
          font-weight: 500;
          letter-spacing: 0.01em;
          transition: color 0.15s;
          padding: 5px 0;
          white-space: nowrap;
        }
        .nav-link:hover { color: #fff; }

        .tools-btn {
          background: none; border: none;
          color: rgba(255,255,255,0.55);
          cursor: pointer; font-size: 13.5px;
          font-weight: 500; font-family: inherit;
          display: flex; align-items: center; gap: 4px;
          padding: 5px 0; transition: color 0.15s;
          white-space: nowrap;
        }
        .tools-btn:hover, .tools-btn.open { color: #fff; }

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

        @keyframes tools-slide-in {
          from { opacity: 0; transform: translateY(-6px) scaleY(0.97); }
          to   { opacity: 1; transform: translateY(0) scaleY(1); }
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
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 999px;
          background: transparent;
          color: rgba(255,255,255,0.65);
          font-size: 12px; font-weight: 600;
          text-decoration: none;
          letter-spacing: 0.04em;
          transition: border-color 0.15s, color 0.15s, background 0.15s;
          white-space: nowrap;
        }
        .btn-signin:hover {
          border-color: rgba(255,255,255,0.32);
          color: #fff;
          background: rgba(255,255,255,0.05);
        }

        .btn-access {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 18px; border-radius: 999px;
          background: linear-gradient(135deg, rgba(45,212,191,0.10) 0%, rgba(139,92,246,0.16) 100%);
          border: 1px solid rgba(45,212,191,0.32);
          color: #fff;
          font-size: 12px; font-weight: 700;
          text-decoration: none;
          letter-spacing: 0.04em;
          box-shadow: 0 0 14px rgba(45,212,191,0.12), 0 0 24px rgba(139,92,246,0.08);
          transition: box-shadow 0.15s, border-color 0.15s, background 0.15s;
          white-space: nowrap;
        }
        .btn-access:hover {
          border-color: rgba(45,212,191,0.55);
          background: linear-gradient(135deg, rgba(45,212,191,0.18) 0%, rgba(139,92,246,0.24) 100%);
          box-shadow: 0 0 22px rgba(45,212,191,0.24), 0 0 36px rgba(139,92,246,0.15);
        }

        .mob-ham {
          width: 36px; height: 36px; border-radius: 8px;
          background: none; border: 1px solid rgba(255,255,255,0.10);
          cursor: pointer; flex-shrink: 0; margin-left: auto;
          align-items: center; justify-content: center;
          flex-direction: column; gap: 5px; padding: 0;
        }
        .mob-ham span {
          display: block; width: 18px; height: 1.5px;
          background: rgba(255,255,255,0.65); border-radius: 1px;
          transition: transform 0.2s, opacity 0.2s;
        }
        .mob-ham.is-open span:nth-child(1) { transform: translateY(6.5px) rotate(45deg); }
        .mob-ham.is-open span:nth-child(2) { opacity: 0; transform: scaleX(0); }
        .mob-ham.is-open span:nth-child(3) { transform: translateY(-6.5px) rotate(-45deg); }

        .mob-nav-menu-link {
          display: flex; align-items: center;
          padding: 15px 4px;
          font-size: 16px; font-weight: 600;
          color: rgba(255,255,255,0.65); text-decoration: none;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          transition: color 0.15s;
          font-family: var(--font-inter, Inter, sans-serif);
        }
        .mob-nav-menu-link:hover { color: #fff; }

        .nav-live-badge-text { display: inline; }

        @media (max-width: 1023px) {
          .nav-live-badge { display: none !important; }
        }
        @media (max-width: 767px) {
          .tools-dropdown { width: calc(100vw - 32px) !important; left: 0 !important; grid-template-columns: 1fr !important; }
          .nav-outer { padding: 8px 12px !important; }
        }
      `}</style>

      {/* Outer wrapper — transparent, just positions the floating pill */}
      <nav
        className="nav-outer"
        style={{
          width: '100%',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          padding: '10px 20px',
          overflow: 'visible',
          pointerEvents: 'none',
        }}
      >
        {/* Glass pill shell */}
        <div
          className="nav-shell"
          style={{
            maxWidth: '1160px',
            margin: '0 auto',
            background: 'rgba(6,8,20,0.84)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '16px',
            padding: '0 18px',
            height: '54px',
            display: 'flex',
            alignItems: 'center',
            gap: '24px',
            pointerEvents: 'auto',
            position: 'relative',
            overflow: 'visible',
          }}
        >
          {/* Subtle top accent line */}
          <div style={{
            position: 'absolute', top: 0, left: '6%', right: '6%', height: '1px',
            background: 'linear-gradient(90deg, transparent 0%, rgba(45,212,191,0.35) 35%, rgba(139,92,246,0.30) 65%, transparent 100%)',
            borderRadius: '1px',
          }} />

          {/* Logo */}
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '9px', textDecoration: 'none', flexShrink: 0 }}>
            <Image src="/cl-logo.png" alt="ChainLens AI" width={30} height={30} />
            <div>
              <div style={{ fontFamily: 'var(--font-inter, Inter, sans-serif)', fontWeight: 800, fontSize: '14px', lineHeight: 1.15 }}>
                <span style={{ color: '#f1f5f9' }}>Chain</span>
                <span style={{
                  background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 60%, #ec4899 100%)',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
                }}>Lens</span>
              </div>
              <div style={{
                fontSize: '7px', color: 'rgba(45,212,191,0.50)',
                letterSpacing: '0.20em', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                AI Intelligence
              </div>
            </div>
          </Link>

          {/* Mobile hamburger */}
          <button
            className={`mob-ham${mobileOpen ? ' is-open' : ''}`}
            onClick={() => setMobileOpen(o => !o)}
            aria-label="Toggle navigation"
          >
            <span /><span /><span />
          </button>

          {/* Center nav links */}
          <div className="mob-nav-links" style={{ display: 'flex', alignItems: 'center', gap: '24px', flex: 1 }}>
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
                    top: 'calc(100% + 12px)',
                    left: '0',
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
                  <div style={{
                    position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
                    background: 'linear-gradient(90deg, transparent, rgba(236,72,153,0.35), rgba(45,212,191,0.35), rgba(251,191,36,0.35), transparent)',
                  }} />

                  {TIER_COLUMNS.map((col, ci) => (
                    <div
                      key={col.tier}
                      className="tools-dropdown-item"
                      style={{ display: 'flex', flexDirection: 'column', gap: '2px', animationDelay: `${ci * 0.06}s` }}
                    >
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '6px 8px 8px',
                        borderBottom: `1px solid ${col.border}`,
                        marginBottom: '4px',
                      }}>
                        <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: col.color, boxShadow: `0 0 6px ${col.color}` }} />
                        <span style={{
                          fontSize: '9px', fontWeight: 800, letterSpacing: '0.18em', color: col.color,
                          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                        }}>{col.tier}</span>
                      </div>
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

            <Link href="/terminal"  className="nav-link">Terminal</Link>
            <Link href="/pricing"   className="nav-link">Pricing</Link>
            <Link href="/affiliate" className="nav-link">Affiliate</Link>
            <Link href="/about"     className="nav-link">About</Link>
          </div>

          {/* Right: LIVE badge + auth buttons */}
          <div className="mob-auth-wrap" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {/* LIVE | Powered by CORTEX */}
            <div
              className="nav-live-badge"
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                paddingRight: '14px',
                borderRight: '1px solid rgba(255,255,255,0.07)',
                marginRight: '4px',
              }}
            >
              <div style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: '#4ade80',
                boxShadow: '0 0 6px rgba(74,222,128,0.85)',
                animation: 'nav-live-pulse 2.5s ease-in-out infinite',
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: '10px', fontWeight: 600,
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
              }}>
                <span style={{ color: 'rgba(255,255,255,0.65)' }}>LIVE</span>
                <span style={{ color: 'rgba(255,255,255,0.18)', margin: '0 6px' }}>|</span>
                <span style={{ color: 'rgba(139,92,246,0.70)' }}>Powered by CORTEX</span>
              </span>
            </div>

            <Link href="/auth"    className="btn-signin">Sign In</Link>
            <Link href="/pricing" className="btn-access">
              Get Access
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
          </div>

        </div>
      </nav>

      {/* Mobile menu overlay */}
      {mobileOpen && (
        <div style={{
          position: 'fixed',
          top: '74px', left: 0, right: 0, bottom: 0,
          background: 'rgba(6,8,20,0.97)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          zIndex: 99,
          display: 'flex',
          flexDirection: 'column',
          padding: '8px 20px 32px',
          overflowY: 'auto',
        }}>
          <Link href="/terminal"  className="mob-nav-menu-link" onClick={() => setMobileOpen(false)}>Terminal</Link>
          <Link href="/pricing"   className="mob-nav-menu-link" onClick={() => setMobileOpen(false)}>Pricing</Link>
          <Link href="/affiliate" className="mob-nav-menu-link" onClick={() => setMobileOpen(false)}>Affiliate</Link>
          <Link href="/about"     className="mob-nav-menu-link" onClick={() => setMobileOpen(false)}>About</Link>

          <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '16px 0' }} />

          <Link href="/auth" onClick={() => setMobileOpen(false)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '13px 20px', borderRadius: '999px',
            border: '1px solid rgba(255,255,255,0.14)',
            color: 'rgba(255,255,255,0.70)', fontSize: '14px', fontWeight: 600,
            textDecoration: 'none', marginBottom: '8px',
          }}>Sign In</Link>

          <Link href="/pricing" onClick={() => setMobileOpen(false)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            padding: '13px 20px', borderRadius: '999px',
            background: 'linear-gradient(135deg, rgba(45,212,191,0.12) 0%, rgba(139,92,246,0.18) 100%)',
            border: '1px solid rgba(45,212,191,0.35)',
            color: '#fff', fontSize: '14px', fontWeight: 700,
            textDecoration: 'none',
          }}>
            Get Access
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>
      )}
    </>
  )
}

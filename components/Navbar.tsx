'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'

const TERMINAL_TOOLS = [
  { icon: '🧪', name: 'Token Scanner',   href: '/terminal/token-scanner' },
  { icon: '👛', name: 'Wallet Scanner',  href: '/terminal?tab=wallet'    },
  { icon: '🧬', name: 'Dev Wallets',     href: '/terminal?tab=devs'      },
  { icon: '💧', name: 'Liquidity Safety',href: '/terminal/liquidity'     },
  { icon: '🐋', name: 'Whale Alerts',    href: '/terminal?tab=whales'    },
  { icon: '🚨', name: 'Pump Alerts',     href: '/terminal?tab=pumps'     },
  { icon: '📡', name: 'Base Radar',      href: '/terminal?tab=radar'     },
  { icon: '🤖', name: 'Clark AI',        href: '/terminal?tab=clark'     },
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
          display: flex; align-items: center; gap: 10px;
          padding: 9px 12px; border-radius: 10px;
          text-decoration: none; color: rgba(255,255,255,0.70);
          font-size: 12px; font-weight: 600;
          transition: background 0.15s, color 0.15s;
          border: 1px solid transparent;
        }
        .tools-item:hover {
          background: rgba(45,212,191,0.07);
          border-color: rgba(45,212,191,0.14);
          color: #fff;
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
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 12px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: '#080c14',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '16px',
                    padding: '16px',
                    width: '480px',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '6px',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.75), 0 0 0 0.5px rgba(45,212,191,0.08)',
                  }}
                  onMouseDown={e => e.preventDefault()}
                >
                  {/* Gradient accent top */}
                  <div style={{
                    position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
                    background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.35), transparent)',
                    borderRadius: '1px',
                  }} />

                  {TERMINAL_TOOLS.map(t => (
                    <Link key={t.name} href={t.href} className="tools-item"
                      onClick={() => setOpen(false)}>
                      <span style={{ fontSize: '15px', lineHeight: 1 }}>{t.icon}</span>
                      <span>{t.name}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <Link href="/terminal" className="nav-link">Terminal</Link>
            <Link href="/pricing"  className="nav-link">Pricing</Link>
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

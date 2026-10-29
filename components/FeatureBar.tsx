'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import ConnectWallet from '@/components/ConnectWallet'
import { canAccessFeature, type UserPlan } from '@/lib/planFeatures'
import { useAccount } from '@/lib/usePlan'
import { CLARK_DAILY_LIMITS } from '@/lib/pricingPlans'
import { readClarkUsage } from '@/app/terminal/clark-ai/clarkAiPageConfig'



// ─── Icons ────────────────────────────────────────────────────────────────

function IcDashboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/>
    </svg>
  )
}
function IcPortfolio() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  )
}
function IcSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}
function IcClarkAI() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>
      <path d="M19 3v4m2-2h-4"/>

    </svg>
  )
}
function IcWalletScanner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/>
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/>
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>
    </svg>
  )
}
function IcTokenScanner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}


function IcDevWalletDetector() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m18 16 4-4-4-4"/>
      <path d="m6 8-4 4 4 4"/>
      <path d="m14.5 4-5 16"/>
    </svg>
  )
}
function IcLiquiditySafety() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  )
}
function IcWhaleAlerts() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}


function IcRadar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.64 17.36a9 9 0 1 1 12.72 0"/>
      <path d="M8.46 14.54a5 5 0 1 1 7.07 0"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  )
}


function IcWatchlist() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v16l-7-4-7 4V5z"/>
      <path d="M9 8h6"/><path d="M9 12h4"/>
    </svg>
  )
}

function IcPumpAlerts() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>

    </svg>
  )
}

function IcTrack() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8"/>
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
    </svg>
  )
}

// ─── Data ─────────────────────────────────────────────────────────────────

type Item = { key: string; label: string; icon: ReactNode; href: string }

// Every terminal destination, grouped for the sidebar. Settings sits apart in the utility area.
const NAV_GROUPS: { label: string; items: Item[] }[] = [
  {
    label: 'Workspace',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: <IcDashboard />, href: '/terminal' },
      { key: 'portfolio', label: 'Portfolio', icon: <IcPortfolio />, href: '/terminal/portfolio' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { key: 'token-scanner',  label: 'Token Scanner',  icon: <IcTokenScanner />,  href: '/terminal/token-scanner'  },
      { key: 'wallet-scanner', label: 'Wallet Scanner', icon: <IcWalletScanner />, href: '/terminal/wallet-scanner' },
      { key: 'whale-alerts',   label: 'Whale Alerts',   icon: <IcWhaleAlerts />,   href: '/terminal/whale-alerts'   },
      { key: 'pump-alerts',    label: 'Pump Alerts',    icon: <IcPumpAlerts />,    href: '/terminal/pump-alerts'    },
      { key: 'base-radar',     label: 'Base Radar',     icon: <IcRadar />,         href: '/terminal/base-radar'     },
    ],
  },
  {
    label: 'Tracking',
    items: [
      { key: 'watchlist', label: 'Watchlist', icon: <IcWatchlist />, href: '/terminal/watchlist' },
      { key: 'track',     label: 'Track',     icon: <IcTrack />,     href: '/terminal/track'     },
    ],
  },
  {
    label: 'Assistant',
    items: [
      { key: 'clark-ai', label: 'Clark AI', icon: <IcClarkAI />, href: '/terminal/clark-ai' },
    ],
  },
]

const SETTINGS_ITEM: Item = { key: 'settings', label: 'Settings', icon: <IcSettings />, href: '/terminal/settings' }

const TOOL_PLAN_FEATURE: Record<string, string> = {
  'wallet-scanner':      'wallet-scanner',
  'liquidity-safety':    'liquidity-safety',
  'whale-alerts':        'whale-alerts',
  'pump-alerts':         'pump-alerts',
  'base-radar':          'base-radar',
}

// ─── NavItem ──────────────────────────────────────────────────────────────
// Visual states live in the .fb-nav-* rules in FeatureBar's <style> block, so hover, active and
// keyboard focus are plain CSS rather than inline mouse handlers.

function NavItem({ item, active, locked = false }: { item: Item; active: string | null; locked?: boolean }) {
  const on = active === item.key
  return (
    <Link
      href={item.href}
      prefetch={true}
      className={`fb-nav-item${locked ? ' fb-nav-item--locked' : ''}`}
      aria-current={on ? 'page' : undefined}
      title={locked ? `${item.label} — Pro feature` : undefined}
    >
      <span className="fb-nav-icon" aria-hidden="true">{item.icon}</span>
      <span className="fb-nav-label">{item.label}</span>
      {locked && <span className="fb-nav-pro">PRO</span>}
    </Link>
  )
}

// ─── Component ────────────────────────────────────────────────────────────

interface Props {
  active?:       string | null
  onSelect?:     (key: string) => void
  onWalletOpen?: () => void
  onClose?:      () => void
}



export default function FeatureBar({ active = 'dashboard', onWalletOpen, onClose }: Props) {
  // SHARED ACCOUNT STORE, DISCLOSED (performance + UX optimization task): this component used to run
  // its OWN supabase.auth.getSession() + /api/user-settings fetch + onAuthStateChange subscription —
  // a third full copy of the same work the page's usePlanWithLoading() and Navbar were each also
  // doing, so a single terminal page load fired the same request 2-3x. It now reads the one shared,
  // deduped, cached-first store (lib/usePlan.tsx). Same cached-first behavior as before (an Elite
  // user still sees Elite on the first paint, never a guessed Free), same never-downgrade-on-error
  // rule — just no longer a duplicate request.
  const { plan: storePlan, email: accountEmail, betaEliteActive: betaElite } = useAccount()
  const plan = (storePlan ?? 'free') as UserPlan

  // USAGE VISIBILITY, DISCLOSED (Token Scanner "show how much you have" fix): the account row only
  // ever showed the plan badge, with no way to tell how much of today's Clark AI allowance (the one
  // real daily cap on Free — Token Scanner scans themselves are unlimited on every plan, see
  // lib/pricingPlans.ts) is left. Reuses the exact same local counter the Clark AI page itself
  // already reads/bumps (clarkAiPageConfig.ts) — no new source of truth, just surfaced here too.
  const pathname = usePathname()
  const [clarkUsed, setClarkUsed] = useState(0)
  useEffect(() => { setClarkUsed(readClarkUsage()) }, [pathname])
  const clarkLimit = CLARK_DAILY_LIMITS[plan] ?? CLARK_DAILY_LIMITS.free

  const initials = (accountEmail?.[0] ?? 'A').toUpperCase()
  const shortEmail = accountEmail
    ? accountEmail.length > 18
      ? `${accountEmail.slice(0, 7)}…${accountEmail.slice(-7)}`
      : accountEmail
    : null
  return (
    <aside
      className="shrink-0 flex flex-col mob-featurebar"
      aria-label="Terminal navigation"
      style={{
        width: '240px',
        height: '100dvh',
        position: 'sticky',
        top: 0,
        background: '#060707',
        borderRight: '1px solid rgba(200,203,206,0.09)',
      }}
    >
      <style>{`
        /* ── Navigation rows ─────────────────────────────────────────────── */
        .fb-section-label {
          margin: 0; padding: 0 10px 6px;
          font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
          color: #636669; font-family: var(--font-plex-mono, monospace);
        }
        .fb-nav-group + .fb-nav-group { margin-top: 18px; }
        .fb-nav-list { display: flex; flex-direction: column; gap: 2px; }
        .fb-nav-item {
          position: relative; display: flex; align-items: center; gap: 10px;
          height: 38px; padding: 0 10px; border-radius: 8px; box-sizing: border-box; width: 100%;
          color: #9fa2a5; font-size: 13px; font-weight: 500; font-family: var(--font-inter);
          text-decoration: none; outline: none;
          transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
        }
        .fb-nav-icon { display: flex; align-items: center; flex-shrink: 0; color: #6c6f72; transition: color 150ms ease; }
        .fb-nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fb-nav-item:hover { background: rgba(255,255,255,0.04); color: #e4e7ea; }
        .fb-nav-item:hover .fb-nav-icon { color: #c0c3c6; }
        .fb-nav-item[aria-current="page"] { background: rgba(31,214,220,0.08); color: #f4f6f7; font-weight: 600; }
        .fb-nav-item[aria-current="page"]:hover { background: rgba(31,214,220,0.11); }
        .fb-nav-item[aria-current="page"] .fb-nav-icon { color: #1fd6dc; }
        .fb-nav-item[aria-current="page"]::before {
          content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px;
          border-radius: 2px; background: #1fd6dc;
        }
        .fb-nav-item:focus-visible { box-shadow: 0 0 0 2px #060707, 0 0 0 3.5px rgba(31,214,220,0.75); }
        .fb-nav-item--locked:not([aria-current="page"]) { color: #787b7e; }
        .fb-nav-item--locked:not([aria-current="page"]) .fb-nav-icon { color: #56595c; }
        .fb-nav-pro {
          flex-shrink: 0; padding: 1px 5px; border-radius: 4px;
          font-size: 9px; font-weight: 700; letter-spacing: 0.08em;
          color: #d2d5d8; background: rgba(209,212,215,0.10); border: 1px solid rgba(209,212,215,0.24);
        }
        .fb-utility { margin-top: auto; padding-top: 14px; }
        .fb-utility-divider { height: 1px; background: rgba(200,203,206,0.09); margin: 0 4px 10px; }

        /* ── Wallet chip ───────────────────────────────────────────────────────
           ConnectWallet puts this className on its own root element per state — a <button> for
           disconnected/reconnecting, a <div> wrapping a button (+ address/helper text in the
           reconnect state) otherwise. Wrapper-only overrides; no wallet logic is touched. */
        .fb-wallet-chip, button.fb-wallet-chip {
          display: flex !important; align-items: center !important; width: 100% !important;
        }
        /* Connected and disconnected states: the single button is the whole chip. :first-child
           (not :only-child) so styling holds while the disconnect dropdown adds a second child. */
        button.fb-wallet-chip,
        .fb-wallet-chip > button:first-child {
          width: 100% !important; justify-content: center !important;
          padding: 8px 10px !important; min-height: 0 !important;
          font-size: 11.5px !important; font-weight: 600 !important;
          letter-spacing: 0.02em !important; border-radius: 8px !important;
          box-shadow: none !important; background: rgba(255,255,255,0.03) !important;
          color: #d8dbde !important; border: 1px solid rgba(200,203,206,0.16) !important;
          transition: background .15s, border-color .15s !important;
        }
        button.fb-wallet-chip:hover,
        .fb-wallet-chip > button:first-child:hover { background: rgba(255,255,255,0.06) !important; border-color: rgba(200,203,206,0.28) !important; }
        button.fb-wallet-chip:focus-visible,
        .fb-wallet-chip > button:first-child:focus-visible { outline: 2px solid rgba(31,214,220,0.7) !important; outline-offset: 2px !important; }
        /* Reconnect state always renders exactly 3 children (button, address, helper sentence):
           shown as one row — address first, a small "Reconnect" pill beside it, helper dropped. */
        .fb-wallet-chip { gap: 8px !important; }
        .fb-wallet-chip > button:nth-child(1):nth-last-child(3) {
          order: 2; width: auto !important; flex-shrink: 0; min-width: 0 !important;
          padding: 4px 9px !important; min-height: 0 !important;
          font-size: 9.5px !important; font-weight: 700 !important;
          letter-spacing: 0.04em !important; border-radius: 6px !important;
          box-shadow: none !important; background: transparent !important;
          color: #62f1f1 !important; border: 1px solid rgba(31,214,220,0.28) !important;
          transition: background .15s, border-color .15s !important;
        }
        .fb-wallet-chip > button:nth-child(1):nth-last-child(3):hover { background: rgba(31,214,220,0.10) !important; }
        .fb-wallet-chip > div:nth-child(2):nth-last-child(2) {
          order: 1; flex: 1 1 auto; min-width: 0;
          font-size: 11.5px !important; color: #9fa2a5 !important;
          font-family: var(--font-plex-mono, monospace) !important;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          text-align: left !important;
        }
        .fb-wallet-chip > div:nth-child(3):nth-last-child(1) { display: none !important; }

        /* ── Account row ───────────────────────────────────────────────────── */
        .fb-account-row {
          display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box;
          height: 40px; padding: 0 8px; border-radius: 8px; text-decoration: none; outline: none;
          border: 1px solid transparent; color: #d8dbde; font-size: 12px; font-weight: 500;
          font-family: var(--font-inter); transition: background-color 150ms ease, border-color 150ms ease;
        }
        .fb-account-row:hover { background: rgba(255,255,255,0.04); border-color: rgba(200,203,206,0.12); }
        .fb-account-row:focus-visible { box-shadow: 0 0 0 2px rgba(31,214,220,0.6); }
        .fb-account-avatar {
          width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 700; color: #1fd6dc;
          background: rgba(31,214,220,0.10); border: 1px solid rgba(31,214,220,0.28);
        }
        .fb-account-avatar--elite { border-color: rgba(245,158,11,0.55); }
        .fb-account-avatar--pro { border-color: rgba(var(--pro-mint-rgb),0.65); box-shadow: 0 0 10px rgba(var(--pro-mint-rgb),0.25); }
        .fb-account-email {
          flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        /* Plan badge — flat capsule, same colour language as the marketing navbar's account pill. */
        .fb-plan-badge {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 2px 6px; border-radius: 5px; flex-shrink: 0;
        }
        .fb-plan-badge--elite { background: rgba(245,158,11,0.10); border: 1px solid rgba(245,158,11,0.34); }
        /* Pro = mint identity (globals.css --pro-mint*). */
        .fb-plan-badge--pro { background: rgba(var(--pro-mint-rgb),0.10); border: 1px solid rgba(var(--pro-mint-rgb),0.55); box-shadow: 0 0 10px rgba(var(--pro-mint-rgb),0.25); gap: 4px; }
        .fb-plan-badge-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--pro-mint); box-shadow: 0 0 6px rgba(var(--pro-mint-rgb),0.9); flex-shrink: 0; }
        .fb-plan-badge--beta { background: rgba(31,214,220,0.09); border: 1px solid rgba(31,214,220,0.32); }
        .fb-plan-badge--free { background: rgba(200,203,206,0.07); border: 1px solid rgba(200,203,206,0.18); }
        .fb-plan-badge-label { font-size: 9px; font-weight: 700; letter-spacing: 0.10em; white-space: nowrap; }
        .fb-plan-badge--elite .fb-plan-badge-label { color: #fcd34d; }
        .fb-plan-badge--pro .fb-plan-badge-label { color: var(--pro-mint-light); }
        .fb-plan-badge--beta .fb-plan-badge-label { color: #62f1f1; }
        .fb-plan-badge--free .fb-plan-badge-label { color: rgba(200,203,206,0.85); }

        /* ── Signed-out actions ────────────────────────────────────────────── */
        .fb-auth-link {
          flex: 1; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-family: var(--font-inter); text-decoration: none; outline: none;
          transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
        }
        .fb-auth-link:focus-visible { box-shadow: 0 0 0 2px rgba(31,214,220,0.6); }
        .fb-auth-link--secondary { font-weight: 500; color: #9fa2a5; background: rgba(255,255,255,0.03); border: 1px solid rgba(200,203,206,0.14); }
        .fb-auth-link--secondary:hover { color: #e4e7ea; border-color: rgba(200,203,206,0.26); }
        .fb-auth-link--primary { font-weight: 600; color: #040606; background: #1fd6dc; border: 1px solid #1fd6dc; }
        .fb-auth-link--primary:hover { background: #62f1f1; border-color: #62f1f1; }
      `}</style>

      {/* ── Mobile close button ───────────────────────────────── */}
      {onClose && (
        <button
          type="button"
          className="mob-sidebar-close-btn"
          onClick={onClose}
          aria-label="Close navigation"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}

      {/* ── Branding ──────────────────────────────────────────── */}
      <Link
        href="/"
        className="shrink-0 flex items-center gap-3"
        style={{
          gap: '8px',
          padding: '20px 20px 18px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          textDecoration: 'none',
          cursor: 'pointer',
        }}
      >
        {/* Logo mark in the homepage navbar's mint-to-white treatment (same mask as Navbar .nav-mark). */}
        <span
          role="img"
          aria-label="ChainLens"
          style={{
            display: 'block',
            flexShrink: 0,
            width: '34px',
            aspectRatio: '300 / 192',
            background: 'linear-gradient(100deg, #1fd6dc 0%, #63ecec 42%, #ffffff 70%)',
            WebkitMask: "url('/cl-mark.png') center / contain no-repeat",
            mask: "url('/cl-mark.png') center / contain no-repeat",
          }}
        />

        {/* Wordmark */}
        <span
          style={{
            fontSize: '17px',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            color: '#f4f6f7',
            fontFamily: 'var(--font-inter)',
          }}
        >
          Chain
          <span
            style={{
              background: 'linear-gradient(172deg, #ffffff 0%, #dadde0 55%, #bdc0c3 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Lens
          </span>
        </span>
      </Link>

      {/* ── Navigation ────────────────────────────────────────── */}
      <nav
        aria-label="Primary"
        className="flex-1 overflow-y-auto flex flex-col"
        style={{ padding: '18px 12px 12px', minHeight: 0 }}
      >
        {NAV_GROUPS.map(group => (
          <div key={group.label} className="fb-nav-group">
            <p className="fb-section-label">{group.label}</p>
            <div className="fb-nav-list">
              {group.items.map(item => {
                const featureKey = TOOL_PLAN_FEATURE[item.key]
                const locked = featureKey ? !canAccessFeature(plan, featureKey) : false
                return <NavItem key={item.key} item={item} active={active} locked={locked} />
              })}
            </div>
          </div>
        ))}

        {/* Utility */}
        <div className="fb-utility">
          <div className="fb-utility-divider" aria-hidden="true" />
          <NavItem item={SETTINGS_ITEM} active={active} />
        </div>
      </nav>

      {/* ── Account footer: wallet chip + account/plan row ──────── */}
      <div
        className="shrink-0 flex flex-col"
        style={{
          padding: '12px',
          borderTop: '1px solid rgba(200,203,206,0.09)',
          gap: '6px',
        }}
      >
        <ConnectWallet className="fb-wallet-chip w-full active:scale-[0.98]" onBeforeOpen={onWalletOpen} />

        {accountEmail ? (
          <Link
            href="/terminal/settings"
            prefetch={true}
            className="fb-account-row"
            aria-label={`Account settings for ${accountEmail}`}
            title={accountEmail}
          >
            <span
              className={`fb-account-avatar${plan === 'elite' ? ' fb-account-avatar--elite' : plan === 'pro' ? ' fb-account-avatar--pro' : ''}`}
              aria-hidden="true"
            >
              {initials}
            </span>
            <span className="fb-account-email">{shortEmail}</span>
            {betaElite ? (
              <span className="fb-plan-badge fb-plan-badge--beta">
                <span className="fb-plan-badge-label">BETA</span>
              </span>
            ) : plan === 'elite' ? (
              <span className="fb-plan-badge fb-plan-badge--elite">
                <svg width="7" height="7" viewBox="0 0 24 24" fill="#fbbf24" aria-hidden="true"><path d="M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.6-6.3 4.6 2.3-7.2-6-4.6h7.6z"/></svg>
                <span className="fb-plan-badge-label">ELITE</span>
              </span>
            ) : plan === 'pro' ? (
              <span className="fb-plan-badge fb-plan-badge--pro" title="Pro plan active">
                <span className="fb-plan-badge-dot" aria-hidden="true" />
                <span className="fb-plan-badge-label">PRO</span>
              </span>
            ) : (
              <span className="fb-plan-badge fb-plan-badge--free">
                <span className="fb-plan-badge-label">FREE</span>
              </span>
            )}
          </Link>
        ) : null}
        {accountEmail && !betaElite ? (
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0 9px', fontSize: '10.5px', fontFamily: 'var(--font-plex-mono, monospace)',
              color: '#787b7e',
            }}
          >
            <span>Clark AI today</span>
            <span style={{ color: clarkUsed >= clarkLimit ? '#f87171' : '#d8dbde', fontWeight: 600 }}>
              {clarkUsed} / {clarkLimit}
            </span>
          </div>
        ) : null}
        {accountEmail === undefined ? (
          /* UNKNOWN SESSION, DISCLOSED (performance + UX optimization task): `undefined` means the
             session has not resolved yet — distinct from `null`, which means resolved-and-signed-out.
             Rendering "Sign In / Sign Up" here would flash a confident signed-out state at a user who
             is in fact signed in, on every first paint. A neutral placeholder at the SAME height
             as the real account row keeps the sidebar from jumping when the answer arrives. */
          <div
            aria-hidden="true"
            className="cl-skeleton"
            style={{ height: '40px', borderRadius: '8px', width: '100%' }}
          />
        ) : !accountEmail ? (
          <div className="flex" style={{ gap: '6px' }}>
            <Link href="/sign-in" prefetch={true} className="fb-auth-link fb-auth-link--secondary">
              Sign In
            </Link>
            <Link href="/sign-in" prefetch={true} className="fb-auth-link fb-auth-link--primary active:scale-[0.98]">
              Sign Up
            </Link>
          </div>
        ) : null}
      </div>
    </aside>
  )
}

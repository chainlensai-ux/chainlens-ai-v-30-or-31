'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Image from 'next/image'
import { supabase } from '@/lib/supabaseClient'
import { type UserPlan, PLAN_COLOR } from '@/lib/planFeatures'
import { clearPlanCache, readCachedPlan, writeCachedPlan } from '@/lib/usePlan'

const AVATAR_COLORS: Record<string, string> = {
  mint:   'linear-gradient(135deg, #2DD4BF 0%, #14b8a6 100%)',
  purple: 'linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%)',
  pink:   'linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)',
  blue:   'linear-gradient(135deg, #38bdf8 0%, #3b82f6 100%)',
}

const TIER_COLUMNS = [
  {
    tier: 'FREE',
    label: 'FREE',
    color: '#ec4899',
    bg: 'rgba(236,72,153,0.10)',
    border: 'rgba(236,72,153,0.20)',
    tools: [
      { icon: '🧪', name: 'Token Scanner',    href: '/terminal/token-scanner', note: 'Basic token + liquidity checks' },
      { icon: '🤖', name: 'Clark AI',         href: '/terminal?tab=clark',      note: '5 prompts/day' },
    ],
  },
  {
    tier: 'PRO',
    label: 'PRO + ELITE',
    color: '#2DD4BF',
    bg: 'rgba(45,212,191,0.08)',
    border: 'rgba(45,212,191,0.20)',
    tools: [
      { icon: '🧪', name: 'Token Scanner',    href: '/terminal/token-scanner', note: 'Full token, liquidity, LP, holder, security, and dev-risk analysis' },
      { icon: '👛', name: 'Wallet Scanner',   href: '/terminal?tab=wallet',     note: '' },
      { icon: '🐋', name: 'Whale Alerts',     href: '/terminal?tab=whales',     note: '' },
      { icon: '🚨', name: 'Pump Alerts',      href: '/terminal?tab=pumps',      note: '' },
      { icon: '📡', name: 'Base Radar',       href: '/terminal?tab=radar',      note: '' },
      { icon: '🤖', name: 'Clark AI',         href: '/terminal?tab=clark',      note: '50 prompts/day' },
    ],
  },
  {
    tier: 'ELITE',
    label: 'ELITE ONLY',
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
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)
  const [accountEmail, setAccountEmail] = useState<string | null>(null)
  const [plan, setPlan] = useState<UserPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(true)
  const [avatarColor, setAvatarColor] = useState<string>('mint')
  const [trialDaysLeft, setTrialDaysLeft] = useState<number>(0)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const pathname = usePathname()

  useEffect(() => {
    async function loadSession(token?: string, userId?: string, email?: string | null) {
      if (!token) { clearPlanCache(); setPlan('free'); setPlanLoading(false); return }
      const cached = readCachedPlan(userId, email)
      if (cached) setPlan(cached)
      try {
        const res = await fetch('/api/user-settings', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        })
        if (res.ok) {
          const json = await res.json() as Record<string, unknown>
          const settings = json?.settings as Record<string, unknown> | undefined
          const p = json?.plan ?? json?.effectivePlan ?? settings?.plan
          const days = Number(json?.trialDaysLeft ?? 0)
          setTrialDaysLeft(Number.isFinite(days) ? days : 0)
          const resolvedPlan: UserPlan = p === 'pro' || p === 'elite' ? p : 'free'
          setPlan(resolvedPlan)
          writeCachedPlan(resolvedPlan, userId, email)
          const ac = String(settings?.avatar_color ?? json?.avatar_color ?? 'mint')
          setAvatarColor(AVATAR_COLORS[ac] ? ac : 'mint')
          const au = String(settings?.avatar_url ?? json?.avatar_url ?? '')
          setAvatarUrl(au || null)
          const dn = String(settings?.display_name ?? json?.display_name ?? '')
          setDisplayName(dn || null)
        }
      } catch {}
      setPlanLoading(false)
    }

    supabase.auth.getSession().then(({ data }) => {
      const session = data.session
      setAccountEmail(session?.user?.email ?? null)
      setPlanLoading(true)
      loadSession(session?.access_token, session?.user?.id, session?.user?.email ?? null)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccountEmail(session?.user?.email ?? null)
      setPlanLoading(true)
      loadSession(session?.access_token, session?.user?.id, session?.user?.email ?? null)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => { setMobileOpen(false) }, [pathname])

  const shortEmail = accountEmail
    ? accountEmail.length > 20
      ? `${accountEmail.slice(0, 8)}…${accountEmail.slice(-8)}`
      : accountEmail
    : null
  const initials = (displayName?.[0] ?? shortEmail?.[0] ?? 'A').toUpperCase()
  const displayPlan: UserPlan = plan ?? 'free'
  const planLabel = !accountEmail ? '' : planLoading && !plan ? 'CHECKING PLAN…' : (plan ?? 'unknown').toUpperCase()
  const trialBadgeDesktop = displayPlan === 'elite' && trialDaysLeft > 0 ? `Elite trial · ${trialDaysLeft} days left` : null
  const trialBadgeMobile = displayPlan === 'elite' && trialDaysLeft > 0 ? 'Elite trial' : null
  // Elite/Pro badge/account-pill premium polish — planLabel is only ever non-empty once
  // accountEmail exists and planLoading has resolved, so these can't fire during the
  // "CHECKING PLAN…" state.
  const isEliteDisplay = displayPlan === 'elite' && planLabel === 'ELITE'
  const isProDisplay = displayPlan === 'pro' && planLabel === 'PRO'

  return (
    <>
      <style>{`
        @keyframes nav-live-pulse {
          0%,100% { opacity: 1; box-shadow: 0 0 5px rgba(74,222,128,0.8); }
          50%      { opacity: 0.5; box-shadow: 0 0 2px rgba(74,222,128,0.3); }
        }
        .nav-shell { box-shadow: 0 0 0 1px rgba(182,102,243,0.16), 0 14px 46px rgba(0,0,0,0.55), 0 0 30px rgba(182,102,243,0.06), 0 0 40px rgba(224,83,194,0.05); overflow: hidden; }

        .nav-link {
          color: rgba(255,255,255,0.68);
          text-decoration: none;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.02em;
          transition: color 0.15s, text-shadow 0.15s;
          padding: 6px 0;
          white-space: nowrap;
        }
        .nav-link:hover { color: #fff; text-shadow: 0 0 14px rgba(182,102,243,0.24); }

        .tools-btn {
          background: none; border: none;
          color: rgba(255,255,255,0.68);
          cursor: pointer; font-size: 13px;
          font-weight: 600; font-family: inherit;
          letter-spacing: 0.02em;
          display: flex; align-items: center; gap: 4px;
          padding: 6px 0; transition: color 0.15s, text-shadow 0.15s;
          white-space: nowrap;
        }
        .tools-btn:hover, .tools-btn.open { color: #fff; text-shadow: 0 0 16px rgba(182,102,243,0.26); }

        .tools-item {
          display: flex; align-items: center; justify-content: space-between;
          padding: 9px 12px; border-radius: 10px;
          text-decoration: none; color: rgba(255,255,255,0.70);
          font-size: 12px; font-weight: 600;
          transition: background 0.15s, color 0.15s, transform 0.15s;
          border: 1px solid transparent;
        }
        .tools-item:hover {
          background: rgba(182,102,243,0.08);
          border-color: rgba(182,102,243,0.16);
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
          padding: 8px 16px;
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 999px;
          background: rgba(255,255,255,0.03);
          color: rgba(255,255,255,0.88);
          font-size: 11px; font-weight: 700;
          text-decoration: none;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          transition: border-color 0.15s, color 0.15s, background 0.15s, box-shadow 0.15s;
          white-space: nowrap;
          min-width: 0;
          overflow: hidden;
        }
        .btn-signin:hover {
          border-color: rgba(255,255,255,0.38);
          color: #fff;
          background: rgba(255,255,255,0.07);
          box-shadow: 0 0 22px rgba(182,102,243,0.14);
        }

        .btn-access {
          position: relative; overflow: hidden;
          display: inline-flex; align-items: center; gap: 6px;
          padding: 9px 18px; border-radius: 999px;
          background: rgba(83,243,195,0.04);
          border: 1.5px solid rgba(83,243,195,0.4);
          color: #bdf5e6;
          font-size: 11px; font-weight: 800;
          text-decoration: none;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          transition: box-shadow 0.18s, border-color 0.18s, background 0.18s, color 0.18s, transform 0.18s;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .btn-access:hover {
          border-color: rgba(83,243,195,0.65);
          background: rgba(83,243,195,0.09);
          color: #53F3C3;
          box-shadow: 0 6px 18px rgba(83,243,195,0.16);
          transform: translateY(-1px);
        }
        .btn-access::after {
          content: ''; position: absolute; top: 0; left: -70%; width: 45%; height: 100%;
          background: linear-gradient(115deg, transparent, rgba(255,255,255,0.5), transparent);
          transform: skewX(-18deg); transition: left 0.55s ease;
        }
        .btn-access:hover::after { left: 130%; }
        .btn-access-go { display: inline-flex; transition: transform 0.25s ease; }
        .btn-access:hover .btn-access-go { transform: translateX(3px); }

        .mob-ham {
          display: none;
          width: 44px; height: 44px; border-radius: 8px;
          background: none; border: 1px solid rgba(255,255,255,0.10);
          cursor: pointer; flex-shrink: 0; margin-left: 12px;
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

        .mob-tool-link {
          display: flex; align-items: center; gap: 8px;
          padding: 11px 12px; border-radius: 10px;
          font-size: 14px; font-weight: 500;
          color: rgba(255,255,255,0.65); text-decoration: none;
          transition: background 0.15s, color 0.15s;
          border: 1px solid transparent;
        }
        .mob-tool-link:hover { background: rgba(182,102,243,0.08); border-color: rgba(182,102,243,0.16); color: #fff; }

        /* Account menu chip — compact, avatar-led */
        .nav-account-chip {
          transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
        }
        .nav-account-chip:hover {
          background: rgba(255,255,255,0.06) !important;
          border-color: rgba(182,102,243,0.42) !important;
        }
        /* Elite account pill — subtle gold treatment, no animation (static glow only, per the
           "avoid animating box-shadow/filter" constraint). Higher specificity than the teal
           default above so it wins for Elite without touching Pro/Free. */
        .nav-account-chip.nav-account-chip--elite:hover {
          background: rgba(245,158,11,0.07) !important;
          border-color: rgba(245,158,11,0.48) !important;
          box-shadow: inset 0 0 0 1px rgba(245,158,11,0.14), 0 0 16px rgba(245,158,11,0.14) !important;
        }
        /* Pro account pill — purple treatment, same static-glow approach as Elite's gold. */
        .nav-account-chip.nav-account-chip--pro:hover {
          background: rgba(139,92,246,0.08) !important;
          border-color: rgba(139,92,246,0.50) !important;
          box-shadow: inset 0 0 0 1px rgba(139,92,246,0.14), 0 0 16px rgba(139,92,246,0.14) !important;
        }
        .nav-elite-badge, .nav-pro-badge, .nav-free-badge {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 2px 7px 2px 5px; border-radius: 999px;
          white-space: nowrap;
        }
        .nav-elite-badge {
          background: linear-gradient(135deg, rgba(245,158,11,0.20) 0%, rgba(217,119,6,0.10) 100%);
          border: 1px solid rgba(245,158,11,0.42);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
        }
        .nav-pro-badge {
          background: linear-gradient(135deg, rgba(139,92,246,0.20) 0%, rgba(109,40,217,0.10) 100%);
          border: 1px solid rgba(139,92,246,0.42);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.10);
        }
        .nav-free-badge {
          padding: 2px 7px;
          background: rgba(148,163,184,0.08);
          border: 1px solid rgba(148,163,184,0.18);
        }
        .nav-elite-badge-label, .nav-pro-badge-label {
          font-size: 9px; font-weight: 800; letter-spacing: 0.10em; white-space: nowrap;
        }
        .nav-elite-badge-label { color: #fcd34d; }
        .nav-pro-badge-label { color: #c4b5fd; }
        .nav-free-badge-label {
          font-size: 9px; font-weight: 700; letter-spacing: 0.10em; white-space: nowrap;
          color: rgba(148,163,184,0.80);
        }

        @media (max-width: 1280px) {
          .nav-live-badge { display: none !important; }
        }

        @media (max-width: 1023px) {
          .mob-nav-links { display: none !important; }
          .mob-ham { display: flex !important; }
          .mob-auth-wrap .btn-signin { display: none !important; }
          .nav-shell { gap: 10px !important; }
        }

        .mob-nav-overlay { position: fixed; top: 60px; left: 0; right: 0; bottom: 0; }
        @media (max-width: 767px) {
          .tools-dropdown { width: calc(100vw - 32px) !important; left: 0 !important; grid-template-columns: 1fr !important; }
          .nav-outer { padding: 8px 12px !important; }
          .nav-shell { height: 48px !important; border-radius: 14px !important; gap: 0 !important; padding: 0 12px !important; animation: none !important; }
          .mob-auth-wrap { display: flex !important; gap: 6px !important; margin-left: auto !important; }
          .btn-access { padding: 7px 12px !important; font-size: 10px !important; }
          .mob-nav-overlay { top: 48px !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .nav-shell, .tools-dropdown, .tools-dropdown-item { animation: none !important; }
          .mob-ham span { transition: none !important; }
          .nav-link, .tools-btn, .btn-signin, .btn-access, .tools-item { transition: none !important; }
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
            maxWidth: '1320px',
            margin: '0 auto',
            background: 'linear-gradient(180deg, rgba(9,12,26,0.82) 0%, rgba(6,8,18,0.76) 100%)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid rgba(139,92,246,0.16)',
            borderRadius: '999px',
            padding: '0 18px',
            height: '60px',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            pointerEvents: 'auto',
            position: 'relative',
            overflow: 'visible',
          }}
        >
          {/* Subtle top accent line */}
          <div style={{
            position: 'absolute', top: 0, left: '8%', right: '8%', height: '1px',
            background: 'linear-gradient(90deg, transparent 0%, rgba(182,102,243,0.30) 35%, rgba(224,83,194,0.24) 65%, transparent 100%)',
            borderRadius: '1px',
          }} />

          {/* Logo */}
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '4px', textDecoration: 'none', flexShrink: 0 }}>
            <span style={{ position: 'relative', width: 44, height: 44, margin: '-6px -2px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Image src="/cl-logo.png" alt="ChainLens AI" width={44} height={44} priority style={{ objectFit: 'contain' }} />
            </span>
            <div>
              <div style={{ fontFamily: 'var(--font-sora, Sora, sans-serif)', fontWeight: 700, fontSize: '17px', lineHeight: 1.15 }}>
                <span style={{ color: '#f1f5f9' }}>Chain</span>
                <span style={{ color: '#f1f5f9' }}>Lens</span>
              </div>
              <div style={{
                fontSize: '8px', color: 'rgba(255,255,255,0.52)',
                letterSpacing: '0.18em', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                AI Intelligence
              </div>
            </div>
          </Link>

          {/* Center nav links */}
          <div className="mob-nav-links" style={{ display: 'flex', alignItems: 'center', gap: '20px', flex: 1, minWidth: 0 }}>
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
                    boxShadow: '0 20px 60px rgba(0,0,0,0.85), 0 0 0 0.5px rgba(182,102,243,0.08)',
                    zIndex: 200,
                  }}
                  onMouseDown={e => e.preventDefault()}
                >
                  <div style={{
                    position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
                    background: 'linear-gradient(90deg, transparent, rgba(182,102,243,0.35), rgba(224,83,194,0.35), rgba(83,243,195,0.35), transparent)',
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
                        }}>{col.label}</span>
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

            <Link href="/terminal"  className="nav-link" prefetch={true}>Terminal</Link>
            <Link href="/pricing"   className="nav-link" prefetch={true}>Pricing</Link>
            <Link href="/affiliate" className="nav-link" prefetch={true}>Affiliate</Link>
            <Link href="/about"     className="nav-link">About</Link>
            <Link href="/contact"   className="nav-link" prefetch={true}>Contact</Link>
          </div>

          {/* Right: LIVE badge + auth buttons */}
          <div className="mob-auth-wrap" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, marginLeft: 'auto' }}>
            {/* LIVE | CORTEX — compact secondary status chip */}
            <div
              className="nav-live-badge"
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '5px 11px',
                border: '1px solid rgba(83,243,195,0.18)',
                borderRadius: '999px',
                background: 'rgba(255,255,255,0.03)',
                marginRight: '2px',
              }}
            >
              <div style={{
                width: '5px', height: '5px', borderRadius: '50%',
                background: '#4ade80',
                boxShadow: '0 0 5px rgba(74,222,128,0.75)',
                animation: 'nav-live-pulse 2.5s ease-in-out infinite',
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: '9px', fontWeight: 600,
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
              }}>
                <span style={{ color: 'rgba(255,255,255,0.55)' }}>LIVE</span>
                <span style={{ color: 'rgba(255,255,255,0.14)', margin: '0 5px' }}>|</span>
                <span style={{ color: 'rgba(182,102,243,0.68)' }}>CORTEX</span>
              </span>
            </div>

            {accountEmail ? (
              <Link
                href="/terminal/settings"
                className={`btn-signin nav-account-chip${isEliteDisplay ? ' nav-account-chip--elite' : isProDisplay ? ' nav-account-chip--pro' : ''}`}
                title={`${accountEmail} · ${planLabel}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  borderColor: isEliteDisplay ? 'rgba(245,158,11,0.30)' : isProDisplay ? 'rgba(139,92,246,0.32)' : 'rgba(255,255,255,0.14)',
                  background: isEliteDisplay
                    ? 'linear-gradient(135deg, rgba(245,158,11,0.08) 0%, rgba(255,255,255,0.025) 55%, rgba(245,158,11,0.05) 100%)'
                    : isProDisplay
                    ? 'linear-gradient(135deg, rgba(139,92,246,0.08) 0%, rgba(255,255,255,0.025) 55%, rgba(139,92,246,0.05) 100%)'
                    : 'rgba(255,255,255,0.03)',
                  boxShadow: isEliteDisplay
                    ? 'inset 0 0 0 1px rgba(245,158,11,0.10)'
                    : isProDisplay
                    ? 'inset 0 0 0 1px rgba(139,92,246,0.10)'
                    : undefined,
                  padding: '5px 12px 5px 5px',
                  textTransform: 'none',
                  letterSpacing: 'normal',
                  flexShrink: 0,
                }}
              >
                <span style={{
                  width: '24px', height: '24px', borderRadius: '50%',
                  background: avatarUrl ? '#0f172a' : AVATAR_COLORS[avatarColor],
                  color: '#04101a', fontSize: '11px', fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, overflow: 'hidden',
                  boxShadow: isEliteDisplay
                    ? '0 0 0 1.5px rgba(245,158,11,0.70), 0 0 7px rgba(245,158,11,0.30)'
                    : isProDisplay
                    ? '0 0 0 1.5px rgba(139,92,246,0.70), 0 0 7px rgba(139,92,246,0.30)'
                    : `0 0 0 1px ${PLAN_COLOR[displayPlan]}55`,
                }}>
                  {avatarUrl
                    ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                    : initials}
                </span>
                {isEliteDisplay ? (
                  <span className='nav-elite-badge'>
                    <svg width='8' height='8' viewBox='0 0 24 24' fill='#fbbf24' aria-hidden='true'><path d='M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.6-6.3 4.6 2.3-7.2-6-4.6h7.6z'/></svg>
                    <span className='nav-elite-badge-label'>{planLabel}</span>
                  </span>
                ) : isProDisplay ? (
                  <span className='nav-pro-badge'>
                    <span className='nav-pro-badge-label'>{planLabel}</span>
                  </span>
                ) : (
                  <span className='nav-free-badge'>
                    <span className='nav-free-badge-label'>{planLabel}</span>
                  </span>
                )}
                {trialBadgeDesktop ? <span style={{ marginLeft: 2, fontSize: 9, color: '#fbbf24', whiteSpace: 'nowrap' }}>· {trialBadgeDesktop}</span> : null}
              </Link>
            ) : (
              <Link href="/sign-in" className="btn-signin" prefetch={true}>Sign In</Link>
            )}
            <Link href="/pricing" className="btn-access" prefetch={true}>
              Get Access
              <span className="btn-access-go">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
            </Link>
          </div>

          {/* Mobile hamburger — after auth wrap so it sits on far right */}
          <button
            type="button"
            className={`mob-ham${mobileOpen ? ' is-open' : ''}`}
            onClick={() => setMobileOpen(o => !o)}
            aria-label="Toggle navigation"
          >
            <span /><span /><span />
          </button>

        </div>
      </nav>

      {/* Mobile menu overlay */}
      {mobileOpen && (
        <div className="mob-nav-overlay" style={{
          background: 'rgba(5,7,18,0.98)',
          backdropFilter: 'blur(22px)',
          WebkitBackdropFilter: 'blur(22px)',
          zIndex: 99,
          display: 'flex',
          flexDirection: 'column',
          padding: '0 20px 40px',
          overflowY: 'auto',
        }}>
          <Link href="/terminal" className="mob-nav-menu-link" prefetch={true} onClick={() => setMobileOpen(false)}>Terminal</Link>

          {/* Tools accordion */}
          <button
            type="button"
            onClick={() => setMobileToolsOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '15px 4px', fontSize: '16px', fontWeight: 600,
              color: 'rgba(255,255,255,0.65)', background: 'none', border: 'none',
              borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer',
              width: '100%', textAlign: 'left', fontFamily: 'var(--font-inter, Inter, sans-serif)',
            }}
          >
            Tools
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ transition: 'transform 0.2s', transform: mobileToolsOpen ? 'rotate(180deg)' : 'none', flexShrink: 0 }}>
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {mobileToolsOpen && (
            <div style={{ padding: '8px 0 4px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {[
                { icon: '🧪', name: 'Token Scanner',      href: '/terminal/token-scanner' },
                { icon: '👛', name: 'Wallet Scanner',     href: '/terminal/wallet-scanner' },
                { icon: '🐋', name: 'Whale Alerts',       href: '/terminal/whale-alerts' },
                { icon: '🚨', name: 'Pump Alerts',        href: '/terminal/pump-alerts' },
                { icon: '📡', name: 'Base Radar',         href: '/terminal/base-radar' },
                { icon: '🤖', name: 'Clark AI',           href: '/terminal/clark-ai' },
              ].map(t => (
                <Link key={t.href} href={t.href} className="mob-tool-link" onClick={() => setMobileOpen(false)}>
                  <span style={{ fontSize: '16px', lineHeight: 1 }}>{t.icon}</span>
                  <span>{t.name}</span>
                </Link>
              ))}
            </div>
          )}

          <Link href="/pricing"   className="mob-nav-menu-link" prefetch={true} onClick={() => setMobileOpen(false)}>Pricing</Link>
          <Link href="/affiliate" className="mob-nav-menu-link" prefetch={true} onClick={() => setMobileOpen(false)}>Affiliate</Link>
          <Link href="/about"     className="mob-nav-menu-link" onClick={() => setMobileOpen(false)}>About</Link>
          <Link href="/contact"   className="mob-nav-menu-link" prefetch={true} onClick={() => setMobileOpen(false)}>Contact</Link>

          <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '18px 0 14px' }} />

          {accountEmail ? (
            <>
              {/* Signed-in account row */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '12px 14px', borderRadius: '14px', marginBottom: '10px',
                background: isEliteDisplay
                  ? 'linear-gradient(135deg, rgba(245,158,11,0.10) 0%, rgba(139,92,246,0.10) 100%)'
                  : isProDisplay
                  ? 'linear-gradient(135deg, rgba(139,92,246,0.14) 0%, rgba(139,92,246,0.08) 100%)'
                  : 'linear-gradient(135deg, rgba(148,163,184,0.06) 0%, rgba(139,92,246,0.08) 100%)',
                border: `1px solid ${isEliteDisplay ? 'rgba(245,158,11,0.30)' : isProDisplay ? 'rgba(139,92,246,0.32)' : 'rgba(148,163,184,0.18)'}`,
              }}>
                <span style={{
                  width: '34px', height: '34px', borderRadius: '50%', flexShrink: 0,
                  background: avatarUrl ? '#0f172a' : AVATAR_COLORS[avatarColor],
                  color: '#04101a', fontSize: '14px', fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  overflow: 'hidden',
                  boxShadow: isEliteDisplay
                    ? '0 0 0 1.5px rgba(245,158,11,0.65), 0 0 8px rgba(245,158,11,0.25)'
                    : isProDisplay
                    ? '0 0 0 1.5px rgba(139,92,246,0.65), 0 0 8px rgba(139,92,246,0.28)'
                    : undefined,
                }}>
                  {avatarUrl
                    ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                    : initials}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '13px', color: '#e2e8f0', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{accountEmail}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                    {isEliteDisplay ? (
                      <span className='nav-elite-badge'>
                        <svg width='8' height='8' viewBox='0 0 24 24' fill='#fbbf24' aria-hidden='true'><path d='M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.6-6.3 4.6 2.3-7.2-6-4.6h7.6z'/></svg>
                        <span className='nav-elite-badge-label'>{planLabel}</span>
                      </span>
                    ) : isProDisplay ? (
                      <span className='nav-pro-badge'>
                        <span className='nav-pro-badge-label'>{planLabel}</span>
                      </span>
                    ) : (
                      <span className='nav-free-badge'>
                        <span className='nav-free-badge-label'>{planLabel}</span>
                      </span>
                    )}
                    {trialBadgeMobile ? <span style={{ marginLeft: 6, fontSize: 10, color: '#fbbf24' }}>{trialBadgeMobile}</span> : null}
                    <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.40)' }}>Signed in</span>
                  </div>
                </div>
              </div>
              <Link href="/terminal/settings" onClick={() => setMobileOpen(false)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '13px 20px', borderRadius: '999px',
                border: '1px solid rgba(255,255,255,0.14)',
                color: 'rgba(255,255,255,0.70)', fontSize: '14px', fontWeight: 600,
                textDecoration: 'none', marginBottom: '8px',
              }}>Settings</Link>
            </>
          ) : (
            <>
              <Link href="/sign-in" onClick={() => setMobileOpen(false)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '14px 20px', borderRadius: '999px',
                border: '1px solid rgba(255,255,255,0.16)',
                color: 'rgba(255,255,255,0.80)', fontSize: '15px', fontWeight: 600,
                textDecoration: 'none', marginBottom: '10px',
              }}>Sign In</Link>
              <Link href="/sign-up" onClick={() => setMobileOpen(false)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '14px 20px', borderRadius: '999px',
                border: '1px solid rgba(83,243,195,0.30)',
                color: 'rgba(83,243,195,0.90)', fontSize: '15px', fontWeight: 600,
                textDecoration: 'none', marginBottom: '10px',
                background: 'rgba(83,243,195,0.06)',
              }}>Sign Up</Link>
            </>
          )}

          <Link href="/pricing" onClick={() => setMobileOpen(false)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            padding: '14px 20px', borderRadius: '999px',
            background: 'rgba(83,243,195,0.06)',
            border: '1.5px solid rgba(83,243,195,0.45)',
            color: '#bdf5e6', fontSize: '15px', fontWeight: 800,
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

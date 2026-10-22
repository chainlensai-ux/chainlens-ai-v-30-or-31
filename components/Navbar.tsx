'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { type UserPlan } from '@/lib/planFeatures'
import { PLAN_TOOL_NAV as TIER_COLUMNS } from '@/lib/pricingPlans'
import { useAccount } from '@/lib/usePlan'

const AVATAR_COLORS: Record<string, string> = {
  mint:   'linear-gradient(135deg, #2DD4BF 0%, #14b8a6 100%)',
  purple: 'linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%)',
  pink:   'linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)',
  blue:   'linear-gradient(135deg, #38bdf8 0%, #3b82f6 100%)',
}

const NAV_LINKS = [
  { href: '/terminal', label: 'Terminal', prefetch: true },
  { href: '/pricing', label: 'Pricing', prefetch: true },
  { href: '/affiliate', label: 'Affiliate', prefetch: true },
  { href: '/about', label: 'About', prefetch: undefined },
  { href: '/contact', label: 'Contact', prefetch: true },
] as const

function isActivePath(pathname: string | null, href: string): boolean {
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false)
}

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)
  // SHARED ACCOUNT STORE, DISCLOSED (performance + UX optimization task): this component used to run
  // its OWN supabase.auth.getSession() + /api/user-settings fetch + onAuthStateChange subscription —
  // a fourth full copy of the same work FeatureBar and the page's usePlanWithLoading() were also
  // each doing. It now reads the one shared, deduped, cached-first store (lib/usePlan.tsx), which
  // already carries every field this component needs (plan, email, avatar colour/url, display name,
  // trial days) from the SAME single /api/user-settings response.
  const account = useAccount()
  const accountEmail = account.email
  const plan = account.plan
  const planLoading = account.loading
  const trialDaysLeft = account.profile.trialDaysLeft
  const avatarUrl = account.profile.avatarUrl
  const displayName = account.profile.displayName
  // LOCAL-CACHE FALLBACK, DISCLOSED: the avatar colour still hydrates from the non-sensitive local
  // settings cache first so it renders in the user's colour on the very first paint (unchanged
  // behaviour) — the store's verified value takes over as soon as it lands.
  const avatarColor = useMemo(() => {
    const fromStore = account.profile.avatarColor
    if (fromStore && AVATAR_COLORS[fromStore]) return fromStore
    if (typeof window === 'undefined') return 'mint'
    try {
      const raw = window.localStorage.getItem('chainlens_local_settings')
      const ac = raw ? String((JSON.parse(raw) as Record<string, unknown>).avatar_color ?? '') : ''
      return AVATAR_COLORS[ac] ? ac : 'mint'
    } catch { return 'mint' }
  }, [account.profile.avatarColor])
  const pathname = usePathname()

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
        .nav-shell { position: relative; box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px rgba(0,0,0,0.42); overflow: hidden; }
        .nav-shell::before {
          content: ''; position: absolute; inset: 0; border-radius: 999px; padding: 1px; pointer-events: none;
          background: linear-gradient(90deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.30) 22%, rgba(255,255,255,0.10) 45%, rgba(255,255,255,0.08) 60%, rgba(255,255,255,0.26) 82%, rgba(255,255,255,0.10) 100%);
          -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          -webkit-mask-composite: xor; mask-composite: exclude;
        }

        /* Left and right take equal shares of the free space so the link group sits centred. */
        .nav-left { flex: 1 1 0; min-width: 0; display: flex; align-items: center; }
        .nav-links { display: flex; align-items: center; gap: clamp(2px, 0.9vw, 14px); flex: 0 0 auto; }

        .nav-link, .tools-btn {
          display: inline-flex; align-items: center; gap: 5px;
          height: 38px; padding: 0 clamp(8px, 0.8vw, 14px); border-radius: 999px;
          background: transparent; border: 1px solid transparent;
          color: rgba(255,255,255,0.90);
          text-decoration: none; font-family: var(--font-jakarta, 'Plus Jakarta Sans', sans-serif);
          font-size: clamp(14px, 1.08vw, 18px); font-weight: 500; letter-spacing: 0;
          cursor: pointer; white-space: nowrap;
          transition: color 0.15s, background 0.15s, border-color 0.15s;
        }
        .nav-link:hover, .tools-btn:hover, .tools-btn.open { color: #fff; background: rgba(255,255,255,0.05); }
        .nav-link.is-active { color: #fff; background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.06); }

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
          display: inline-flex; align-items: center;
          height: clamp(40px, 2.9vw, 48px); padding: 0 clamp(16px, 1.4vw, 24px);
          border: 1.5px solid rgba(255,255,255,0.20);
          border-radius: 999px;
          background: rgba(255,255,255,0.03);
          color: rgba(255,255,255,0.90);
          font-family: var(--font-jakarta, 'Plus Jakarta Sans', sans-serif);
          font-size: clamp(14px, 1.08vw, 18px); font-weight: 500;
          text-decoration: none;
          letter-spacing: 0;
          transition: border-color 0.15s, color 0.15s, background 0.15s, box-shadow 0.15s;
          white-space: nowrap;
          min-width: 0;
          overflow: hidden;
        }
        .btn-signin:hover {
          border-color: rgba(255,255,255,0.30);
          color: #fff;
          background: rgba(255,255,255,0.06);
        }

        .btn-access {
          display: inline-flex; align-items: center; gap: 10px;
          height: clamp(40px, 2.9vw, 48px); padding: 0 clamp(16px, 1.6vw, 28px); border-radius: 999px;
          background: rgba(31,216,200,0.04);
          border: 1.5px solid rgba(31,216,200,0.85);
          box-shadow: 0 0 14px rgba(31,216,200,0.18), inset 0 0 10px rgba(31,216,200,0.06);
          color: #2fe3d2;
          font-family: var(--font-jakarta, 'Plus Jakarta Sans', sans-serif);
          font-size: clamp(14px, 1.08vw, 18px); font-weight: 500;
          text-decoration: none;
          letter-spacing: 0;
          transition: border-color 0.18s, background 0.18s, color 0.18s;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .btn-access:hover {
          border-color: #3fe9d8;
          background: rgba(31,216,200,0.09);
          color: #5ef0e2;
        }
        .btn-access-go { display: inline-flex; transition: transform 0.2s ease; }
        .btn-access:hover .btn-access-go { transform: translateX(2px); }

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

        /* Brand monogram: the existing /cl-mark.png shape, filled mint to white. */
        .nav-mark {
          display: block; width: clamp(40px, 3.3vw, 54px); aspect-ratio: 300 / 192; flex-shrink: 0;
          background: linear-gradient(100deg, #1fd8c8 0%, #5fe9da 42%, #ffffff 70%);
          -webkit-mask: url('/cl-mark.png') center / contain no-repeat;
          mask: url('/cl-mark.png') center / contain no-repeat;
        }
        .nav-wordmark {
          font-family: var(--font-jakarta, 'Plus Jakarta Sans', sans-serif); font-weight: 500;
          font-size: clamp(18px, 1.45vw, 24px); letter-spacing: -0.01em; color: #f4f6f7; white-space: nowrap;
        }

        /* Plan badge — compact pill, gold edge for Elite (reference), purple for Pro, grey for Free. */
        .nav-plan-badge {
          display: inline-flex; align-items: center; justify-content: center;
          height: clamp(40px, 2.9vw, 48px); padding: 0 clamp(16px, 1.4vw, 24px); border-radius: 999px;
          font-family: var(--font-jakarta, 'Plus Jakarta Sans', sans-serif);
          font-size: clamp(14px, 1.08vw, 18px); font-weight: 500; letter-spacing: 0.01em;
          text-decoration: none; white-space: nowrap; flex-shrink: 0;
          background: rgba(10,10,8,0.6);
          border: 1.5px solid rgba(148,163,184,0.30); color: rgba(226,232,240,0.85);
          transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
        }
        .nav-plan-badge--elite {
          border-color: rgba(230,184,72,0.85); color: #f3c64a;
          box-shadow: 0 0 12px rgba(230,184,72,0.16), inset 0 0 8px rgba(230,184,72,0.06);
        }
        .nav-plan-badge--elite:hover { border-color: #f0c75a; box-shadow: 0 0 18px rgba(230,184,72,0.26), inset 0 0 10px rgba(230,184,72,0.08); }
        .nav-plan-badge--pro { border-color: rgba(139,92,246,0.70); color: #c4b5fd; }
        .nav-plan-badge--pro:hover { border-color: rgba(167,139,250,0.95); }
        .nav-plan-badge--free:hover { border-color: rgba(203,213,225,0.5); }
        .nav-plan-trial { font-size: 11px; color: #f3c64a; white-space: nowrap; }

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

        @media (max-width: 1023px) {
          .mob-nav-links { display: none !important; }
          .nav-left { flex: 0 0 auto; }
          .mob-auth-wrap { flex: 0 0 auto !important; }
          .mob-ham { display: flex !important; }
          .mob-auth-wrap .btn-signin { display: none !important; }
          .nav-shell { gap: 10px !important; }
        }

        .mob-nav-overlay { position: fixed; top: 60px; left: 0; right: 0; bottom: 0; }
        @media (max-width: 767px) {
          .tools-dropdown { width: calc(100vw - 32px) !important; left: 0 !important; grid-template-columns: 1fr !important; }
          .nav-outer { padding: 8px 12px !important; }
          .nav-shell { height: 56px !important; border-radius: 999px !important; gap: 0 !important; padding: 0 8px 0 16px !important; animation: none !important; overflow: visible !important; }
          .nav-plan-trial { display: none; }
          .mob-auth-wrap { display: flex !important; gap: 6px !important; margin-left: auto !important; }
          .btn-access { padding: 0 14px !important; font-size: 14px !important; height: 40px !important; }
          .nav-plan-badge { padding: 0 12px; font-size: 13px; height: 40px; }
          .mob-nav-overlay { top: 64px !important; }
        }
        @media (max-width: 420px) {
          .nav-wordmark { display: none; }
          .btn-access-go { display: none !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .nav-shell, .tools-dropdown, .tools-dropdown-item { animation: none !important; }
          .mob-ham span { transition: none !important; }
          .nav-link, .tools-btn, .btn-signin, .btn-access, .btn-access-go, .tools-item, .nav-plan-badge { transition: none !important; }
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
          padding: 'clamp(10px, 2.2vw, 36px) clamp(12px, 2.4vw, 40px) 10px',
          overflow: 'visible',
          pointerEvents: 'none',
        }}
      >
        {/* Glass pill shell */}
        <div
          className="nav-shell"
          style={{
            maxWidth: '1400px',
            minHeight: 'clamp(60px, 4.7vw, 78px)',
            margin: '0 auto',
            background: 'linear-gradient(180deg, rgba(14,16,17,0.62) 0%, rgba(6,7,8,0.58) 100%)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '999px',
            padding: '8px clamp(10px, 1.2vw, 20px) 8px clamp(16px, 1.6vw, 26px)',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            pointerEvents: 'auto',
            position: 'relative',
            overflow: 'visible',
          }}
        >

          {/* Logo */}
          <div className="nav-left">
            <Link href="/" aria-label="ChainLens home" style={{ display: 'flex', alignItems: 'center', gap: 'clamp(8px, 0.8vw, 13px)', textDecoration: 'none', flexShrink: 0 }}>
              {/* /cl-mark.png (the logo trimmed to the mark's own edges) used as a mask, so the
                  monogram keeps its exact geometry in the mint-to-white treatment. */}
              <span className="nav-mark" aria-hidden="true" />
              <span className="nav-wordmark">ChainLens</span>
            </Link>
          </div>

          {/* Center nav links */}
          <div className="mob-nav-links nav-links">
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

            {NAV_LINKS.map(({ href, label, prefetch }) => {
              const active = isActivePath(pathname, href)
              return (
                <Link key={href} href={href} className={`nav-link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} prefetch={prefetch}>{label}</Link>
              )
            })}
          </div>

          {/* Right: account chip or sign-in, then Get Access */}
          <div className="mob-auth-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', flex: '1 1 0', minWidth: 0, marginLeft: 'auto' }}>
            {accountEmail ? (
              <>
                <Link
                  href="/terminal/settings"
                  className={`nav-plan-badge nav-plan-badge--${isEliteDisplay ? 'elite' : isProDisplay ? 'pro' : 'free'}`}
                  title={`${accountEmail} · ${planLabel}${trialBadgeDesktop ? ` · ${trialBadgeDesktop}` : ''}`}
                  aria-label={`Account settings (${accountEmail}, ${planLabel || 'plan'})`}
                >
                  {planLabel}
                </Link>
                {trialBadgeDesktop ? <span className="nav-plan-trial">{trialBadgeDesktop}</span> : null}
              </>
            ) : (
              <Link href="/sign-in" className="btn-signin" prefetch={true}>Sign In</Link>
            )}
            <Link href="/pricing" className="btn-access" prefetch={true}>
              Get Access
              <span className="btn-access-go">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
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
                  background: avatarUrl ? '#0f172a' : isEliteDisplay ? 'linear-gradient(140deg, #E053C2, #B666F3)' : AVATAR_COLORS[avatarColor],
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

'use client'

// Reversible hero experiment: flip USE_INTELLIGENCE_HERO (in app/page.tsx) to false to restore
// the legacy hero. This component is fully self-contained and additive — it does not touch
// auth/payments/backend/API logic, pricing, or any existing route.
import Link from 'next/link'
import dynamic from 'next/dynamic'

const ConnectWallet = dynamic(() => import('@/components/ConnectWallet'), { ssr: false })

const INTEL_FEATURES = [
  {
    accent: '#2DD4BF',
    title: 'Token Risk Reads',
    desc: 'LP, owner, holders, security, deployer',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z" />
      </svg>
    ),
  },
  {
    accent: '#8b5cf6',
    title: 'Wallet Behavior',
    desc: 'FIFO lots, trade style, recovery gaps',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><circle cx="16" cy="15" r="1.5" />
      </svg>
    ),
  },
  {
    accent: '#22d3ee',
    title: 'Base Radar',
    desc: 'Early movers with liquidity filters',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  {
    accent: '#ec4899',
    title: 'Clark AI',
    desc: 'Ask questions across every scan',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" /><path d="M9 10h.01M15 10h.01M9 15c.8.7 1.9 1 3 1s2.2-.3 3-1" />
      </svg>
    ),
  },
]

export default function IntelligenceHero() {
  return (
    <>
      {/* ── Cinematic background layer — same dark navy/glass theme as the legacy hero ── */}
      <div className="hero-premium-bg home-heavy-visual" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '780px', pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #04050d 0%, #050712 46%, #05060d 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(40% 24% at 50% 30%, rgba(45,212,191,0.12) 0%, rgba(45,212,191,0.04) 44%, transparent 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 96% at 50% 44%, rgba(4,8,20,0) 50%, rgba(3,6,16,0.78) 82%, rgba(2,4,12,0.96) 100%)' }} />
      </div>

      <main className="mob-hero-main intel-hero-main" style={{
        flex: 1,
        position: 'relative',
        zIndex: 1,
        padding: '100px 24px 72px',
        display: 'grid',
        gridTemplateColumns: '1.1fr 0.9fr',
        gap: '48px',
        alignItems: 'center',
        maxWidth: '1240px',
        margin: '0 auto',
        width: '100%',
      }}>
        {/* ── Left: headline / subheadline / CTA hierarchy ── */}
        <div style={{ textAlign: 'left' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            background: 'rgba(45,212,191,0.05)', border: '1px solid rgba(45,212,191,0.32)',
            borderRadius: '999px', padding: '6px 16px', marginBottom: '20px',
          }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 8px rgba(74,222,128,0.8)', flexShrink: 0 }} />
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textTransform: 'uppercase' }}>
              Powered by CORTEX ENGINE
            </span>
          </div>

          <h1 style={{
            fontSize: 'clamp(36px, 4.6vw, 72px)',
            fontWeight: 900,
            lineHeight: 1.06,
            letterSpacing: '-0.025em',
            margin: '0 0 18px',
            textShadow: '0 8px 30px rgba(0,0,0,0.46)',
          }}>
            <span style={{ color: '#f8fafc' }}>Find the move </span>
            <span style={{
              background: 'linear-gradient(94deg, #2DD4BF 0%, #22d3ee 45%, #8b5cf6 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              textShadow: '0 0 34px rgba(45,212,191,0.30), 0 0 64px rgba(139,92,246,0.20)',
            }}>before the crowd.</span>
          </h1>

          <p style={{ fontSize: '17px', color: 'rgba(255,255,255,0.66)', lineHeight: 1.62, maxWidth: '520px', margin: '0 0 30px', fontWeight: 400 }}>
            Scan tokens, wallets, whales, and Base momentum with Clark — your AI onchain analyst.
          </p>

          {/* CTA hierarchy: one clear primary, one secondary, wallet connect demoted */}
          <div className="intel-cta-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center', marginBottom: '18px' }}>
            <Link href="/terminal" style={{
              display: 'inline-flex', alignItems: 'center', gap: '9px',
              padding: '17px 38px', borderRadius: '999px',
              background: 'linear-gradient(100deg, rgba(45,212,191,0.24) 0%, rgba(34,211,238,0.26) 25%, rgba(99,102,241,0.28) 64%, rgba(168,85,247,0.26) 100%)',
              border: '1px solid rgba(34,211,238,0.58)', color: '#fff',
              fontSize: '15px', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', textDecoration: 'none',
              boxShadow: '0 0 42px rgba(45,212,191,0.34), 0 0 42px rgba(139,92,246,0.30), inset 0 1px 0 rgba(255,255,255,0.32)',
            }}>
              Launch Terminal →
            </Link>
            <Link href="/terminal/token-scanner" style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '16px 30px', borderRadius: '999px',
              background: 'rgba(139,92,246,0.12)', color: 'rgba(255,255,255,0.92)',
              fontSize: '15px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', textDecoration: 'none',
              border: '1px solid rgba(168,85,247,0.56)', boxShadow: '0 0 26px rgba(139,92,246,0.18)',
            }}>
              Scan Token Free
            </Link>
          </div>

          {/* Wallet connect demoted to a small, secondary line per the reversible hero spec */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '22px' }}>
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.42)' }}>Connect wallet later —</span>
            <div style={{ transform: 'scale(0.86)', transformOrigin: 'left center' }}>
              <ConnectWallet />
            </div>
          </div>

          <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.40)', lineHeight: 1.6, maxWidth: '480px' }}>
            No hype. No fake scores. ChainLens shows evidence, gaps, and risk before you trade.
          </p>
        </div>

        {/* ── Right: live Cortex intelligence card (static demo copy, never live numbers) ── */}
        <div style={{
          background: 'linear-gradient(180deg, rgba(6,11,28,0.82) 0%, rgba(5,10,24,0.66) 100%)',
          border: '1px solid rgba(148,163,184,0.24)',
          borderRadius: '22px',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 22px 64px rgba(0,0,0,0.52), 0 0 42px rgba(45,212,191,0.08), inset 0 1px 0 rgba(255,255,255,0.10)',
          padding: '24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 8px rgba(45,212,191,0.8)' }} />
            <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.18em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', textTransform: 'uppercase' }}>
              LIVE CORTEX READ
            </span>
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.32)', marginLeft: 'auto' }}>sample intelligence</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13.5px', lineHeight: 1.5 }}>
            <div><span style={{ color: 'rgba(255,255,255,0.45)' }}>Base Momentum: </span><span style={{ color: '#f1f5f9', fontWeight: 700 }}>Selective</span></div>
            <div><span style={{ color: 'rgba(255,255,255,0.45)' }}>Signal: </span><span style={{ color: '#2DD4BF' }}>Liquidity-supported movers detected</span></div>
            <div><span style={{ color: 'rgba(255,255,255,0.45)' }}>Watchout: </span><span style={{ color: '#fbbf24' }}>Microcap pumps can reverse fast</span></div>
            <div><span style={{ color: 'rgba(255,255,255,0.45)' }}>Suggested action: </span><span style={{ color: '#f1f5f9' }}>Run Token Scanner before entry</span></div>
          </div>

          <div style={{
            marginTop: '18px', padding: '14px 16px', borderRadius: '14px',
            background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.28)',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#a78bfa', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '6px' }}>Clark</div>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.78)', lineHeight: 1.55, margin: 0 }}>
              &ldquo;I found momentum, but I&rsquo;d verify LP, holders, and dev control before treating it as clean.&rdquo;
            </p>
          </div>
        </div>

        {/* ── Sharper product-outcome tiles (replaces the four generic hero tiles) ── */}
        <div className="intel-feat-row mobile-static-card" style={{
          gridColumn: '1 / -1',
          display: 'flex', alignItems: 'stretch', gap: 0,
          background: 'linear-gradient(180deg, rgba(6,11,28,0.82) 0%, rgba(5,10,24,0.66) 100%)',
          border: '1px solid rgba(148,163,184,0.24)', borderRadius: '22px',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 22px 64px rgba(0,0,0,0.52), 0 0 42px rgba(45,212,191,0.08), inset 0 1px 0 rgba(255,255,255,0.10)',
          overflow: 'hidden', marginTop: '8px',
        }}>
          {INTEL_FEATURES.map((item, i) => (
            <div key={item.title} className="mobile-static-card" style={{
              flex: 1, padding: '22px 18px',
              borderRight: i < INTEL_FEATURES.length - 1 ? '1px solid rgba(148,163,184,0.22)' : 'none',
              display: 'flex', gap: '12px', alignItems: 'flex-start',
            }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0,
                border: `1.5px solid ${item.accent}66`,
                background: `radial-gradient(circle at 35% 30%, ${item.accent}2A 0%, rgba(15,23,42,0.8) 75%)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: item.accent,
                boxShadow: `0 0 20px ${item.accent}28`,
              }}>
                {item.icon}
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#f1f5f9', marginBottom: '3px', lineHeight: 1.3 }}>{item.title}</div>
                <div style={{ fontSize: '12.5px', color: 'rgba(255,255,255,0.60)', lineHeight: 1.5 }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Mobile responsiveness: stack headline/CTA/card/tiles, no horizontal overflow, full-width buttons */}
      <style>{`
        @media (max-width: 880px) {
          .intel-hero-main { grid-template-columns: 1fr !important; padding: 72px 20px 48px !important; }
          .intel-cta-row { flex-direction: column !important; align-items: stretch !important; }
          .intel-cta-row > a { width: 100% !important; justify-content: center !important; text-align: center; }
          .intel-feat-row { flex-direction: column !important; }
          .intel-feat-row > div { border-right: none !important; border-bottom: 1px solid rgba(255,255,255,0.06) !important; }
          .intel-feat-row > div:last-child { border-bottom: none !important; }
        }
      `}</style>
    </>
  )
}

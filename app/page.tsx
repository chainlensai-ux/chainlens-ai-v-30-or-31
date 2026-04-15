import Navbar from '@/components/Navbar'
import HeroChat from '@/components/HeroChat'
import TickerBar from '@/components/TickerBar'
import Link from 'next/link'

const gradText: React.CSSProperties = {
  background: 'linear-gradient(135deg, #ec4899, #8b5cf6, #64ffda)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
}

const CONT = { maxWidth: '1200px', margin: '0 auto', padding: '0 24px' }

function SectionEyebrow({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
      <div style={{ height: '1px', flex: 1, background: 'rgba(139,92,246,0.15)' }} />
      <span style={{
        fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)',
        fontSize: '9px', fontWeight: 700,
        color: '#64ffda', letterSpacing: '3px', textTransform: 'uppercase',
      }}>
        {label}
      </span>
      <div style={{ height: '1px', flex: 1, background: 'rgba(139,92,246,0.15)' }} />
    </div>
  )
}

const FREE_FEATURES = [
  'BearProof Score™',
  'GlobalRank™ Leaderboard',
  '150+ coin live prices',
  'Live Discovery Feed',
  'Clark AI — general questions',
]

const PRO_FEATURES = [
  'Everything in Free',
  'EdgeScan™ AI — 10 uses/month',
  'DipRadar™ + GhostTrade™',
  'TradeCoach™ — 10 trades/month',
  'SentimentPulse™ + TaxMate™',
  'Price Alerts — 5 active',
  'Token Unlocks™',
  'Clark AI — wallet scans & live data',
]

const ELITE_FEATURES = [
  'Everything in Pro — Unlimited',
  'WalletScan™ — 5 chains, full AI',
  'Smart Wallets™ tracking',
  'SignalBreaker™ + PumpAlert™',
  'NarrativeRank™ full access',
  'ProofVault™ on-chain proofs',
  'Price Alerts — 20 active',
  'Clark AI — all features + Elite',
]

export default function HomePage() {
  return (
    <main style={{ minHeight: '100vh', background: '#06060a' }}>
      <Navbar />

      {/* ── Hero ── */}
      <section style={{ padding: '64px 0 44px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        {/* Ambient orbs */}
        <div style={{ position: 'absolute', borderRadius: '50%', pointerEvents: 'none', filter: 'blur(80px)', width: '440px', height: '440px', top: '-160px', left: '50%', transform: 'translateX(-50%)', background: 'radial-gradient(circle, rgba(139,92,246,0.22), transparent 70%)' }} />
        <div style={{ position: 'absolute', borderRadius: '50%', pointerEvents: 'none', filter: 'blur(80px)', width: '220px', height: '220px', top: '40px', right: '5%', background: 'radial-gradient(circle, rgba(100,255,218,0.09), transparent 70%)' }} />
        <div style={{ position: 'absolute', borderRadius: '50%', pointerEvents: 'none', filter: 'blur(80px)', width: '200px', height: '200px', top: '60px', left: '5%', background: 'radial-gradient(circle, rgba(139,92,246,0.12), transparent 70%)' }} />

        <div style={{ ...CONT, position: 'relative', zIndex: 1 }}>
          {/* CORTEX eyebrow badge */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.2)',
            borderRadius: '30px', padding: '5px 14px', marginBottom: '20px',
            fontSize: '9px', fontWeight: 700, color: 'rgba(167,139,250,1)',
            letterSpacing: '2px', textTransform: 'uppercase',
            fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)',
            animation: 'cl-fade-up 0.8s ease both',
          }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: '#64ffda', boxShadow: '0 0 8px #64ffda', animation: 'cl-pulse 2s infinite' }} />
            Powered by CORTEX ENGINE
          </div>

          {/* Headline */}
          <h1 style={{ fontFamily: 'var(--font-inter, Inter, sans-serif)', fontWeight: 900, letterSpacing: '-1.5px', lineHeight: 1.0, marginBottom: '18px' }}>
            <span style={{ display: 'block', fontSize: 'clamp(28px, 3.8vw, 48px)', color: '#fff', animation: 'cl-fade-up 0.9s 0.1s ease both' }}>
              See what whales do
            </span>
            <span style={{ display: 'block', fontSize: 'clamp(28px, 3.8vw, 48px)', ...gradText, animation: 'cl-fade-up 0.9s 0.26s ease both' }}>
              before everyone else does
            </span>
          </h1>

          {/* Subtitle */}
          <p style={{ fontSize: 'clamp(13px, 1.4vw, 15px)', color: 'rgba(255,255,255,0.5)', maxWidth: '460px', margin: '0 auto 28px', lineHeight: 1.7, animation: 'cl-fade-up 0.65s 0.38s ease both' }}>
            Ask Clark anything — scan wallets, find early pumps, track smart money, and get real-time onchain intelligence.
          </p>

          <HeroChat />

          {/* CTAs */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '40px', animation: 'cl-fade-up 0.7s 0.7s ease both' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <Link href="/app" style={{ padding: '12px 24px', borderRadius: '10px', background: 'linear-gradient(135deg, #ec4899, #8b5cf6)', color: '#fff', fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.06em', textTransform: 'uppercase', boxShadow: '0 0 24px rgba(139,92,246,0.4)' }}>
                Start Free
              </Link>
              <Link href="/app" style={{ padding: '12px 24px', borderRadius: '10px', border: '1px solid rgba(139,92,246,0.35)', background: 'transparent', color: 'rgba(255,255,255,0.7)', fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Connect Wallet
              </Link>
            </div>
            <Link href="/terminal" style={{ padding: '12px 24px', borderRadius: '10px', background: '#2DD4BF', color: '#06060a', fontSize: '13px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.06em', textTransform: 'uppercase', boxShadow: '0 0 22px rgba(45,212,191,0.3)' }}>
              Enter Terminal
            </Link>
          </div>
        </div>
      </section>

      {/* ── Ticker ── */}
      <TickerBar />

      {/* ── Pricing ── */}
      <section style={{ padding: '80px 0 100px', position: 'relative' }}>
        {/* Background glow */}
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(139,92,246,0.06), transparent)', pointerEvents: 'none' }} />

        <div style={{ ...CONT, position: 'relative', zIndex: 1 }}>
          <div style={{ textAlign: 'center', marginBottom: '48px' }}>
            <SectionEyebrow label="Pricing" />
            <h2 style={{ fontSize: 'clamp(24px, 3vw, 40px)', fontWeight: 800, letterSpacing: '-1px', lineHeight: 1.15, color: '#fff', marginBottom: '12px' }}>
              One price.{' '}
              <span style={{ background: 'linear-gradient(110deg,#ec4899,#8b5cf6,#64ffda)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                Worldwide.
              </span>
            </h2>
            <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.45)', maxWidth: '460px', margin: '0 auto', lineHeight: 1.7 }}>
              No dark patterns. No regional pricing. Start free — upgrade when you&apos;re ready. Cancel any time.
            </p>
          </div>

          {/* Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', maxWidth: '960px', margin: '0 auto', alignItems: 'start' }}>

            {/* Free */}
            <div style={{
              background: 'rgba(11,9,16,0.72)',
              border: '1px solid rgba(139,92,246,0.15)',
              borderRadius: '20px',
              padding: '30px 26px',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
            }}>
              <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '2.5px', textTransform: 'uppercase', color: 'rgba(167,139,250,0.9)', marginBottom: '10px', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)' }}>Free</div>
              <div style={{ fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', fontSize: '42px', fontWeight: 700, color: '#fff', lineHeight: 1, marginBottom: '4px' }}>$0</div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '20px' }}>forever free · no card required</div>
              <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', background: 'linear-gradient(135deg,#ec4899,#8b5cf6,#64ffda)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', opacity: 0.7, marginBottom: '18px', display: 'block' }}>
                ⬡ CORTEX lite
              </div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '24px' }}>
                {FREE_FEATURES.map(f => (
                  <li key={f} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.45 }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.25)', flexShrink: 0, marginTop: '1px' }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/app" style={{ display: 'block', textAlign: 'center', padding: '11px 20px', borderRadius: '10px', border: '1px solid rgba(139,92,246,0.3)', background: 'transparent', color: 'rgba(255,255,255,0.7)', fontSize: '12px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Get Started Free
              </Link>
            </div>

            {/* Pro — featured */}
            <div style={{
              position: 'relative',
              background: 'linear-gradient(160deg, rgba(11,9,16,0.9) 0%, rgba(139,92,246,0.12) 100%)',
              border: '1px solid rgba(236,72,153,0.5)',
              borderRadius: '20px',
              padding: '36px 26px 30px',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: '0 0 60px rgba(139,92,246,0.25), 0 0 120px rgba(139,92,246,0.1), inset 0 1px 0 rgba(236,72,153,0.2)',
              transform: 'scale(1.03)',
            }}>
              {/* Most Popular badge */}
              <div style={{ position: 'absolute', top: '-13px', left: '50%', transform: 'translateX(-50%)', background: '#ec4899', color: '#fff', fontSize: '9px', fontWeight: 800, padding: '5px 18px', borderRadius: '20px', letterSpacing: '2px', textTransform: 'uppercase', whiteSpace: 'nowrap', boxShadow: '0 0 24px rgba(236,72,153,0.6)' }}>
                Most Popular
              </div>
              <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '2.5px', textTransform: 'uppercase', color: '#ec4899', marginBottom: '10px', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)' }}>Pro</div>
              <div style={{ fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', fontSize: '42px', fontWeight: 700, color: '#fff', lineHeight: 1, marginBottom: '4px' }}>$30</div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '20px' }}>per month · 7-day free trial</div>
              <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', background: 'linear-gradient(135deg,#ec4899,#8b5cf6,#64ffda)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', opacity: 0.8, marginBottom: '18px', display: 'block' }}>
                ⬡ CORTEX standard
              </div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '24px' }}>
                {PRO_FEATURES.map(f => (
                  <li key={f} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.45 }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(100,255,218,0.7)', flexShrink: 0, marginTop: '1px' }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/app" style={{ display: 'block', textAlign: 'center', padding: '11px 20px', borderRadius: '10px', background: '#ec4899', color: '#fff', fontSize: '12px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.06em', textTransform: 'uppercase', boxShadow: '0 0 20px rgba(236,72,153,0.4)' }}>
                Start Free Trial
              </Link>
            </div>

            {/* Elite */}
            <div style={{
              position: 'relative',
              background: 'linear-gradient(160deg, rgba(11,9,16,0.9) 0%, rgba(139,92,246,0.08) 100%)',
              border: '1px solid rgba(139,92,246,0.35)',
              borderRadius: '20px',
              padding: '30px 26px',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              animation: 'cl-elite-glow 3.5s ease-in-out infinite',
              overflow: 'hidden',
            }}>
              {/* Top shimmer line */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: 'linear-gradient(90deg, transparent, #8b5cf6, rgba(167,139,250,0.8), #8b5cf6, transparent)', animation: 'cl-elite-top-line 3.5s ease-in-out infinite' }} />
              <div style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '2.5px', textTransform: 'uppercase', color: '#8b5cf6', marginBottom: '10px', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', textShadow: '0 0 20px rgba(139,92,246,0.5)' }}>Elite</div>
              <div style={{ fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', fontSize: '42px', fontWeight: 700, color: '#fff', lineHeight: 1, marginBottom: '4px' }}>$60</div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginBottom: '20px' }}>per month · 7-day free trial</div>
              <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', background: 'linear-gradient(135deg,#ec4899,#8b5cf6,#64ffda)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', opacity: 0.8, marginBottom: '18px', display: 'block' }}>
                ⬡ CORTEX full intelligence
              </div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '24px' }}>
                {ELITE_FEATURES.map(f => (
                  <li key={f} style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.45 }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(139,92,246,0.9)', flexShrink: 0, marginTop: '1px' }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/app" style={{ display: 'block', textAlign: 'center', padding: '11px 20px', borderRadius: '10px', background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.5)', color: 'rgba(167,139,250,1)', fontSize: '12px', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Start Free Trial
              </Link>
            </div>

          </div>

          {/* Fine print */}
          <p style={{ textAlign: 'center', marginTop: '28px', fontSize: '11px', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.04em' }}>
            Free to start. No credit card required. Cancel any time.
          </p>
        </div>
      </section>
    </main>
  )
}

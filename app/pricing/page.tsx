import Link from 'next/link'
import Navbar from '@/components/Navbar'

const PLANS = [
  {
    id: 'free',
    label: 'FREE',
    labelColor: '#ec4899',
    price: '$0',
    billing: 'forever free · no card required',
    engine: 'CORTEX LITE',
    engineColor: 'rgba(236,72,153,0.55)',
    cta: 'Get Started Free',
    ctaStyle: 'outline' as const,
    border: 'rgba(255,255,255,0.10)',
    glow: 'none',
    popular: false,
  },
  {
    id: 'pro',
    label: 'PRO',
    labelColor: '#2DD4BF',
    price: '$30',
    billing: 'per month · 7-day free trial',
    engine: 'CORTEX STANDARD',
    engineColor: 'rgba(45,212,191,0.55)',
    cta: 'Start Free Trial',
    ctaStyle: 'gradient' as const,
    border: 'rgba(139,92,246,0.55)',
    glow: '0 0 40px rgba(139,92,246,0.20), 0 0 80px rgba(236,72,153,0.08)',
    popular: true,
  },
  {
    id: 'elite',
    label: 'ELITE',
    labelColor: '#f1f5f9',
    price: '$60',
    billing: 'per month · 7-day free trial',
    engine: 'CORTEX FULL INTELLIGENCE',
    engineColor: 'rgba(139,92,246,0.55)',
    cta: 'Start Free Trial',
    ctaStyle: 'outline' as const,
    border: 'rgba(139,92,246,0.35)',
    glow: '0 0 40px rgba(139,92,246,0.15)',
    popular: false,
  },
]

export default function PricingPage() {
  return (
    <>
      <style>{`
        @keyframes pricing-grid-fade {
          0%, 100% { opacity: 0.55; }
          50%       { opacity: 0.80; }
        }
        @keyframes popular-border-glow {
          0%, 100% { box-shadow: 0 0 40px rgba(139,92,246,0.20), 0 0 80px rgba(236,72,153,0.08), inset 0 0 0 1px rgba(139,92,246,0.55); }
          50%       { box-shadow: 0 0 60px rgba(139,92,246,0.35), 0 0 100px rgba(236,72,153,0.15), inset 0 0 0 1px rgba(139,92,246,0.80); }
        }
        .card-popular {
          animation: popular-border-glow 4s ease-in-out infinite;
        }
        .cta-outline {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.20);
          color: rgba(255,255,255,0.75);
          transition: border-color 0.15s, color 0.15s, background 0.15s;
        }
        .cta-outline:hover {
          border-color: rgba(255,255,255,0.45);
          color: #fff;
          background: rgba(255,255,255,0.05);
        }
        .cta-gradient {
          background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%);
          border: none;
          color: #fff;
          transition: opacity 0.15s, transform 0.15s;
        }
        .cta-gradient:hover {
          opacity: 0.88;
          transform: translateY(-1px);
        }
      `}</style>

      <Navbar />

      <div style={{
        minHeight: '100vh',
        background: '#08080f',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* Grid overlay */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)
          `,
          backgroundSize: '52px 52px',
          maskImage: 'radial-gradient(ellipse 90% 70% at 50% 30%, black 20%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 90% 70% at 50% 30%, black 20%, transparent 80%)',
          animation: 'pricing-grid-fade 6s ease-in-out infinite',
        }} />

        {/* Subtle purple glow center */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '700px', height: '400px', borderRadius: '50%',
          top: '80px', left: '50%', transform: 'translateX(-50%)',
          background: 'radial-gradient(ellipse, rgba(139,92,246,0.10) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }} />

        {/* Content */}
        <div style={{
          position: 'relative', zIndex: 1,
          maxWidth: '1080px', margin: '0 auto',
          padding: '80px 24px 100px',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}>

          {/* Headline */}
          <h1 style={{
            fontSize: 'clamp(48px, 7vw, 88px)',
            fontWeight: 900,
            lineHeight: 1.0,
            letterSpacing: '-0.03em',
            color: '#ffffff',
            textAlign: 'center',
            margin: '0 0 20px',
          }}>
            One price. Worldwide.
          </h1>

          <p style={{
            fontSize: '16px',
            color: 'rgba(255,255,255,0.45)',
            textAlign: 'center',
            lineHeight: 1.65,
            maxWidth: '420px',
            margin: '0 0 64px',
          }}>
            No dark patterns. No regional pricing. Cancel any time.
            Your data stays yours.
          </p>

          {/* Cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '20px',
            width: '100%',
            alignItems: 'start',
          }}>
            {PLANS.map(plan => (
              <div
                key={plan.id}
                className={plan.popular ? 'card-popular' : ''}
                style={{
                  position: 'relative',
                  background: plan.popular ? 'rgba(12,10,26,0.90)' : 'rgba(10,10,18,0.70)',
                  borderRadius: '20px',
                  padding: '32px 28px 28px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0',
                  ...(plan.popular ? {} : {
                    border: `1px solid ${plan.border}`,
                    boxShadow: plan.glow !== 'none' ? plan.glow : undefined,
                  }),
                  marginTop: plan.popular ? '-12px' : '0',
                }}
              >
                {/* Most Popular badge */}
                {plan.popular && (
                  <div style={{
                    position: 'absolute',
                    top: '-14px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'linear-gradient(90deg, #8b5cf6, #ec4899)',
                    borderRadius: '999px',
                    padding: '4px 16px',
                    fontSize: '9px',
                    fontWeight: 800,
                    letterSpacing: '0.18em',
                    color: '#fff',
                    whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  }}>
                    MOST POPULAR
                  </div>
                )}

                {/* Tier label */}
                <div style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  color: plan.labelColor,
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  marginBottom: '12px',
                }}>
                  {plan.label}
                </div>

                {/* Price */}
                <div style={{
                  fontSize: 'clamp(52px, 6vw, 72px)',
                  fontWeight: 900,
                  lineHeight: 1,
                  color: '#ffffff',
                  letterSpacing: '-0.03em',
                  marginBottom: '8px',
                  fontFamily: 'var(--font-inter, Inter, sans-serif)',
                }}>
                  {plan.price}
                </div>

                {/* Billing */}
                <div style={{
                  fontSize: '11px',
                  color: 'rgba(255,255,255,0.35)',
                  marginBottom: '28px',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                }}>
                  {plan.billing}
                </div>

                {/* Engine badge */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '7px',
                  marginBottom: '28px',
                }}>
                  <div style={{
                    width: '5px', height: '5px', borderRadius: '50%',
                    background: plan.engineColor,
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: '9px',
                    fontWeight: 700,
                    letterSpacing: '0.16em',
                    color: plan.engineColor,
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  }}>
                    {plan.engine}
                  </span>
                </div>

                {/* CTA */}
                <Link
                  href="/app"
                  className={plan.ctaStyle === 'gradient' ? 'cta-gradient' : 'cta-outline'}
                  style={{
                    display: 'block',
                    textAlign: 'center',
                    padding: '13px 20px',
                    borderRadius: '10px',
                    fontSize: '12px',
                    fontWeight: 700,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    textDecoration: 'none',
                    fontFamily: 'var(--font-inter, Inter, sans-serif)',
                    cursor: 'pointer',
                  }}
                >
                  {plan.cta}
                </Link>

              </div>
            ))}
          </div>

        </div>
      </div>
    </>
  )
}

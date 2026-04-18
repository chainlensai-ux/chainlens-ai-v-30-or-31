import Link from 'next/link'
import Navbar from '@/components/Navbar'

// ─── Types ──────────────────────────────────────────────────────────────────

type Section = { title: string; items: string[] }

interface Plan {
  id: string
  label: string
  labelColor: string
  price: string
  billing: string
  engine: string
  engineColor: string
  cta: string
  ctaStyle: 'outline' | 'gradient' | 'gold'
  border: string
  badge: string | null
  sections: Section[]
}

// ─── Plans ───────────────────────────────────────────────────────────────────

const PLANS: Plan[] = [
  {
    id: 'free',
    label: 'FREE',
    labelColor: '#ec4899',
    price: '$0',
    billing: 'forever free · no card required',
    engine: 'CORTEX LITE',
    engineColor: 'rgba(236,72,153,0.65)',
    cta: 'Get Started Free',
    ctaStyle: 'outline',
    border: 'rgba(255,255,255,0.09)',
    badge: null,
    sections: [
      {
        title: 'Token Scanner',
        items: [
          'Price, liquidity, volume, 24h change',
          'Basic token info only',
          'No AI verdict',
        ],
      },
      {
        title: 'Liquidity Safety',
        items: [
          'Basic LP score only',
          'No full LP analysis',
        ],
      },
      {
        title: 'Clark AI',
        items: ['3 prompts per day'],
      },
      {
        title: 'Not Included',
        items: [
          'No Wallet Scanner',
          'No Dev Wallet Detector',
          'No Pump Alerts',
          'No Whale Alerts',
          'No Base Radar',
        ],
      },
    ],
  },
  {
    id: 'pro',
    label: 'PRO',
    labelColor: '#2DD4BF',
    price: '$30',
    billing: 'per month · 7-day free trial',
    engine: 'CORTEX STANDARD',
    engineColor: 'rgba(45,212,191,0.65)',
    cta: 'Start Free Trial',
    ctaStyle: 'gradient',
    border: 'rgba(139,92,246,0.55)',
    badge: 'MOST POPULAR',
    sections: [
      {
        title: 'Everything in Free, plus',
        items: [
          'Full Token Scanner',
          'Full Liquidity Safety',
          'Wallet Scanner',
          'Dev Wallet Detector',
          'Pump Alerts',
          'Whale Alerts',
          'Base Radar',
          'Clark AI — 50 prompts / day',
        ],
      },
    ],
  },
  {
    id: 'elite',
    label: 'ELITE',
    labelColor: '#fbbf24',
    price: '$60',
    billing: 'per month · 7-day free trial',
    engine: 'CORTEX FULL INTELLIGENCE',
    engineColor: 'rgba(251,191,36,0.75)',
    cta: 'Unlock Elite',
    ctaStyle: 'gold',
    border: 'rgba(251,191,36,0.40)',
    badge: 'FULL INTELLIGENCE',
    sections: [
      {
        title: 'Everything in Pro, plus',
        items: [
          'Clark AI — unlimited prompts',
          'Auto Clark verdict on every scan',
          'Smart money tracking',
          'Advanced whale alerts',
          'Priority CORTEX processing',
          'Early access to new features',
        ],
      },
    ],
  },
]

// ─── Accent maps ─────────────────────────────────────────────────────────────

const SECTION_COLOR: Record<string, string> = {
  free:  'rgba(236,72,153,0.60)',
  pro:   'rgba(45,212,191,0.60)',
  elite: 'rgba(251,191,36,0.65)',
}
const CHECK_COLOR: Record<string, string> = {
  free:  'rgba(236,72,153,0.55)',
  pro:   '#2DD4BF',
  elite: '#fbbf24',
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PricingPage() {
  return (
    <>
      <style>{`
        @keyframes pricing-grid-fade {
          0%,100% { opacity:0.50; }
          50%      { opacity:0.78; }
        }
        @keyframes pro-glow {
          0%,100% { box-shadow: 0 0 40px rgba(139,92,246,0.18), inset 0 0 0 1px rgba(139,92,246,0.55); }
          50%      { box-shadow: 0 0 64px rgba(139,92,246,0.32), inset 0 0 0 1px rgba(139,92,246,0.80); }
        }
        @keyframes elite-glow {
          0%,100% { box-shadow: 0 0 50px rgba(251,191,36,0.18), 0 0 100px rgba(251,191,36,0.08), inset 0 0 0 1px rgba(251,191,36,0.40); }
          50%      { box-shadow: 0 0 80px rgba(251,191,36,0.32), 0 0 140px rgba(251,191,36,0.14), inset 0 0 0 1px rgba(251,191,36,0.70); }
        }
        @keyframes shine-sweep {
          0%   { transform: translateX(-100%) skewX(-15deg); }
          100% { transform: translateX(300%) skewX(-15deg); }
        }
        .card-pro   { animation: pro-glow   4s ease-in-out infinite; }
        .card-elite { animation: elite-glow 3.5s ease-in-out infinite; }

        /* ── Hover lift for all cards ── */
        .pricing-card {
          transition: transform 0.28s cubic-bezier(0.22,1,0.36,1), box-shadow 0.28s ease;
          overflow: hidden;
        }
        .pricing-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.04) 50%, transparent 60%);
          opacity: 0;
          transition: opacity 0.3s;
          pointer-events: none;
          z-index: 2;
        }
        .pricing-card:hover { transform: translateY(-8px); }
        .pricing-card:hover::before { opacity: 1; animation: shine-sweep 0.6s ease forwards; }

        .pricing-card.card-free:hover {
          box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 40px rgba(236,72,153,0.18);
          border-color: rgba(236,72,153,0.35) !important;
        }
        .pricing-card.card-pro:hover {
          box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 80px rgba(139,92,246,0.40), inset 0 0 0 1px rgba(139,92,246,0.90);
          animation-play-state: paused;
        }
        .pricing-card.card-elite:hover {
          box-shadow: 0 24px 70px rgba(0,0,0,0.60), 0 0 100px rgba(251,191,36,0.45), 0 0 160px rgba(251,191,36,0.18), inset 0 0 0 1px rgba(251,191,36,0.85);
          animation-play-state: paused;
        }

        .cta-outline {
          background:transparent; border:1px solid rgba(255,255,255,0.18);
          color:rgba(255,255,255,0.70);
          transition:border-color 0.15s,color 0.15s,background 0.15s;
        }
        .cta-outline:hover { border-color:rgba(255,255,255,0.40); color:#fff; background:rgba(255,255,255,0.05); }

        .cta-gradient {
          background:linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%);
          border:none; color:#fff;
          transition:opacity 0.15s,transform 0.15s;
        }
        .cta-gradient:hover { opacity:0.88; transform:translateY(-1px); }

        .cta-gold {
          background:linear-gradient(135deg,#f59e0b 0%,#fbbf24 50%,#f59e0b 100%);
          border:none; color:#0a0800;
          font-weight:800;
          transition:opacity 0.15s,transform 0.15s,box-shadow 0.15s;
          box-shadow:0 0 20px rgba(251,191,36,0.35);
        }
        .cta-gold:hover { opacity:0.90; transform:translateY(-2px); box-shadow:0 0 32px rgba(251,191,36,0.55); }

        .elite-price {
          background:linear-gradient(135deg,#fbbf24 0%,#fff 60%,#fbbf24 100%);
          -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
        }
      `}</style>

      <Navbar />

      <div style={{ minHeight:'100vh', background:'#08080f', position:'relative', display:'flex', flexDirection:'column' }}>

        {/* Grid */}
        <div style={{
          position:'absolute', inset:0, pointerEvents:'none', zIndex:0,
          backgroundImage:`linear-gradient(rgba(255,255,255,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.025) 1px,transparent 1px)`,
          backgroundSize:'52px 52px',
          maskImage:'radial-gradient(ellipse 90% 70% at 50% 20%,black 20%,transparent 80%)',
          WebkitMaskImage:'radial-gradient(ellipse 90% 70% at 50% 20%,black 20%,transparent 80%)',
          animation:'pricing-grid-fade 6s ease-in-out infinite',
        }} />

        {/* Ambient glows */}
        <div style={{ position:'absolute', pointerEvents:'none', zIndex:0, width:'600px', height:'300px', borderRadius:'50%', top:'50px', left:'50%', transform:'translateX(-50%)', background:'radial-gradient(ellipse,rgba(139,92,246,0.10) 0%,transparent 70%)', filter:'blur(60px)' }} />
        <div style={{ position:'absolute', pointerEvents:'none', zIndex:0, width:'400px', height:'400px', borderRadius:'50%', top:'100px', right:'5%', background:'radial-gradient(ellipse,rgba(251,191,36,0.07) 0%,transparent 70%)', filter:'blur(80px)' }} />

        <div style={{ position:'relative', zIndex:1, maxWidth:'1020px', margin:'0 auto', padding:'48px 24px 72px', display:'flex', flexDirection:'column', alignItems:'center' }}>

          <h1 style={{ fontSize:'clamp(22px,3vw,40px)', fontWeight:900, lineHeight:1.0, letterSpacing:'-0.03em', color:'#fff', textAlign:'center', margin:'0 0 10px' }}>
            One price. Worldwide.
          </h1>
          <p style={{ fontSize:'13px', color:'rgba(255,255,255,0.38)', textAlign:'center', lineHeight:1.65, maxWidth:'360px', margin:'0 0 40px' }}>
            No dark patterns. No regional pricing. Cancel any time. Your data stays yours.
          </p>

          {/* Cards — Elite gets 1.28× width */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1.28fr', gap:'14px', width:'100%', alignItems:'start' }}>

            {PLANS.map(plan => {
              const isElite = plan.id === 'elite'
              const isPro   = plan.id === 'pro'

              return (
                <div
                  key={plan.id}
                  className={`pricing-card ${isElite ? 'card-elite' : isPro ? 'card-pro' : 'card-free'}`}
                  style={{
                    position:'relative',
                    background: isElite
                      ? 'rgba(16,12,4,0.95)'
                      : isPro
                        ? 'rgba(12,10,26,0.92)'
                        : 'rgba(10,10,18,0.72)',
                    borderRadius: isElite ? '18px' : '14px',
                    padding: isElite ? '24px 22px 20px' : '20px 16px 18px',
                    display:'flex', flexDirection:'column',
                    marginTop: isPro ? '-8px' : isElite ? '-14px' : '0',
                    ...((!isPro && !isElite) ? { border:`1px solid ${plan.border}` } : {}),
                  }}
                >
                  {/* Badge */}
                  {plan.badge && (
                    <div style={{
                      position:'absolute', top:'-15px', left:'50%', transform:'translateX(-50%)',
                      background: isElite
                        ? 'linear-gradient(90deg,#f59e0b,#fbbf24,#f59e0b)'
                        : 'linear-gradient(90deg,#8b5cf6,#ec4899)',
                      borderRadius:'999px', padding:'3px 12px',
                      fontSize:'8px', fontWeight:800, letterSpacing:'0.18em',
                      color: isElite ? '#0a0800' : '#fff',
                      whiteSpace:'nowrap', fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)',
                      boxShadow: isElite ? '0 0 14px rgba(251,191,36,0.50)' : undefined,
                    }}>{plan.badge}</div>
                  )}

                  {/* Tier label */}
                  <div style={{ fontSize:'9px', fontWeight:700, letterSpacing:'0.18em', color:plan.labelColor, fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)', marginBottom:'7px' }}>
                    {plan.label}
                  </div>

                  {/* Price */}
                  <div
                    className={isElite ? 'elite-price' : ''}
                    style={{
                      fontSize: isElite ? 'clamp(34px,3.8vw,48px)' : 'clamp(30px,3.2vw,42px)',
                      fontWeight:300, lineHeight:1, color:'#fff',
                      letterSpacing:'-0.01em', marginBottom:'4px',
                      fontFamily:'var(--font-inter,Inter,sans-serif)',
                    }}
                  >
                    {plan.price}
                  </div>

                  {/* Billing */}
                  <div style={{ fontSize:'9px', color:'rgba(255,255,255,0.30)', marginBottom:'12px', fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)' }}>
                    {plan.billing}
                  </div>

                  {/* Engine badge */}
                  <div style={{ display:'flex', alignItems:'center', gap:'5px', marginBottom:'12px' }}>
                    <div style={{ width:'4px', height:'4px', borderRadius:'50%', background:plan.engineColor, flexShrink:0,
                      boxShadow: isElite ? '0 0 5px rgba(251,191,36,0.80)' : undefined }} />
                    <span style={{ fontSize:'7px', fontWeight:700, letterSpacing:'0.16em', color:plan.engineColor, fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)' }}>
                      {plan.engine}
                    </span>
                  </div>

                  {/* Divider */}
                  <div style={{ height:'1px', background: isElite ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.07)', marginBottom:'14px' }} />

                  {/* Feature sections */}
                  <div style={{ display:'flex', flexDirection:'column', gap:'10px', marginBottom:'16px', flex:1 }}>
                    {plan.sections.map(sec => (
                      <div key={sec.title}>
                        <div style={{ fontSize:'7px', fontWeight:700, letterSpacing:'0.16em', color:SECTION_COLOR[plan.id], fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)', textTransform:'uppercase', marginBottom:'5px' }}>
                          {sec.title}
                        </div>
                        <div style={{ display:'flex', flexDirection:'column', gap:'3px' }}>
                          {sec.items.map(item => {
                            const isNo = item.startsWith('No ')
                            return (
                              <div key={item} style={{ display:'flex', alignItems:'flex-start', gap:'7px' }}>
                                <span style={{ fontSize:'9px', flexShrink:0, marginTop:'1px', color: isNo ? 'rgba(255,255,255,0.18)' : CHECK_COLOR[plan.id], lineHeight:1.2 }}>
                                  {isNo ? '✕' : '✓'}
                                </span>
                                <span style={{ fontSize:'11px', lineHeight:1.45, color: isNo ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.72)', fontFamily:'var(--font-inter,Inter,sans-serif)' }}>
                                  {item}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Elite — Pro included note */}
                  {isElite && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      background: 'rgba(251,191,36,0.07)',
                      border: '1px solid rgba(251,191,36,0.18)',
                      borderRadius: '10px',
                      padding: '8px 12px',
                      marginBottom: '12px',
                    }}>
                      <span style={{ fontSize: '13px', flexShrink: 0 }}>⭐</span>
                      <span style={{
                        fontSize: '11px', fontWeight: 600,
                        color: 'rgba(251,191,36,0.85)',
                        fontFamily: 'var(--font-inter,Inter,sans-serif)',
                        lineHeight: 1.4,
                      }}>
                        Everything in Pro included — plus full CORTEX intelligence.
                      </span>
                    </div>
                  )}

                  {/* CTA */}
                  <Link
                    href="/app"
                    className={`cta-${plan.ctaStyle}`}
                    style={{
                      display:'block', textAlign:'center',
                      padding: isElite ? '10px 16px' : '9px 14px',
                      borderRadius:'8px',
                      fontSize:'10px',
                      fontWeight:700, letterSpacing:'0.10em',
                      textTransform:'uppercase', textDecoration:'none',
                      fontFamily:'var(--font-inter,Inter,sans-serif)',
                      cursor:'pointer',
                    }}
                  >
                    {plan.cta}
                  </Link>

                </div>
              )
            })}
          </div>

        </div>
      </div>
    </>
  )
}

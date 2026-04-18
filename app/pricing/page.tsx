import Link from 'next/link'
import Navbar from '@/components/Navbar'

// ─── Plan data ─────────────────────────────────────────────────────────────

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
  ctaStyle: 'outline' | 'gradient'
  border: string
  popular: boolean
  sections: Section[]
}

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
    border: 'rgba(255,255,255,0.10)',
    popular: false,
    sections: [
      {
        title: 'Token Scanner',
        items: [
          'Price, liquidity, volume, 24h change',
          'Top 1 pool only',
          'No AI verdict',
          'No LP safety',
          'No wallet scanning',
        ],
      },
      {
        title: 'Clark AI',
        items: [
          '3 prompts per day',
          'No advanced analysis',
        ],
      },
      {
        title: 'Dashboard',
        items: ['Watchlist only'],
      },
      {
        title: 'Not Included',
        items: [
          'No alerts',
          'No LP Safety Analyzer',
          'No Wallet Analyzer',
          'No Whale Alerts',
          'No Pump Alerts',
          'No Base Radar',
          'No CORTEX Engine',
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
    popular: true,
    sections: [
      {
        title: 'Token Scanner',
        items: [
          'Full pool list',
          'Full token metrics',
          'Contract info',
          'Basic risk flags',
        ],
      },
      {
        title: 'Clark AI',
        items: [
          '50 prompts / day',
          'Token analysis',
          'Wallet analysis',
          'LP analysis (text only)',
        ],
      },
      {
        title: 'Wallet Scanner',
        items: [
          'Basic wallet breakdown',
          'Token holdings',
          'Profit / loss summary',
        ],
      },
      {
        title: 'LP Safety Analyzer',
        items: [
          'LP lock % & burn %',
          'LP owner & unlock date',
          'Total liquidity & pool count',
          'Basic positives / negatives',
          'LP safety score',
        ],
      },
      {
        title: 'Alerts',
        items: [
          'Wallet alerts (basic)',
          'Token watch alerts (basic)',
        ],
      },
      {
        title: 'Dashboard',
        items: [
          'Portfolio tracking',
          'Wallet linking',
        ],
      },
    ],
  },
  {
    id: 'elite',
    label: 'ELITE',
    labelColor: '#f1f5f9',
    price: '$60',
    billing: 'per month · 7-day free trial',
    engine: 'CORTEX FULL INTELLIGENCE',
    engineColor: 'rgba(139,92,246,0.65)',
    cta: 'Start Free Trial',
    ctaStyle: 'outline',
    border: 'rgba(139,92,246,0.35)',
    popular: false,
    sections: [
      {
        title: 'CORTEX Engine',
        items: [
          'Token · LP · Wallet AI verdicts',
          'Risk scoring engine',
          'Whale flow analysis',
          'Contract safety analysis',
          'Liquidity, volatility & fragmentation',
          'Rug-risk signals & timeline bars',
          'Safety breakdowns + expanded notes',
        ],
      },
      {
        title: 'LP Safety Analyzer',
        items: [
          'Lock status & unlock countdown',
          'Owner classification',
          'Fragmentation & depth score',
          'Volatility indicator',
          'Rug-risk signals',
          'Safety breakdown & timeline bar',
        ],
      },
      {
        title: 'Wallet Analyzer',
        items: [
          'Smart money detection',
          'Whale tracking',
          'Risk scoring',
          'AI wallet summary',
        ],
      },
      {
        title: 'Alerts',
        items: [
          'Whale & pump alerts',
          'LP unlock alerts',
          'Contract risk alerts',
          'Smart money alerts',
        ],
      },
      {
        title: 'Base Radar',
        items: [
          'New token detection',
          'Liquidity inflow / outflow',
          'Whale movements',
          'Contract deployments',
        ],
      },
      {
        title: 'Clark AI',
        items: [
          'Unlimited prompts',
          'Full intelligence mode',
          'Multi-chain analysis',
        ],
      },
      {
        title: 'UI Unlocks',
        items: [
          'Neon CORTEX theme',
          'Elite badge',
          'Priority API speed',
        ],
      },
    ],
  },
]

// ─── Section colours per plan ──────────────────────────────────────────────

const SECTION_TITLE_COLOR: Record<string, string> = {
  free:  'rgba(236,72,153,0.60)',
  pro:   'rgba(45,212,191,0.60)',
  elite: 'rgba(139,92,246,0.65)',
}

const CHECK_COLOR: Record<string, string> = {
  free:  'rgba(236,72,153,0.55)',
  pro:   '#2DD4BF',
  elite: '#8b5cf6',
}

// ─── Page ──────────────────────────────────────────────────────────────────

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
        .card-popular { animation: popular-border-glow 4s ease-in-out infinite; }
        .cta-outline {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.20);
          color: rgba(255,255,255,0.75);
          transition: border-color 0.15s, color 0.15s, background 0.15s;
        }
        .cta-outline:hover { border-color: rgba(255,255,255,0.45); color:#fff; background:rgba(255,255,255,0.05); }
        .cta-gradient {
          background: linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%);
          border: none; color: #fff;
          transition: opacity 0.15s, transform 0.15s;
        }
        .cta-gradient:hover { opacity:0.88; transform:translateY(-1px); }
        .pricing-scrollbar::-webkit-scrollbar { width:3px; }
        .pricing-scrollbar::-webkit-scrollbar-thumb { background:rgba(139,92,246,0.30); border-radius:3px; }
      `}</style>

      <Navbar />

      <div style={{ minHeight:'100vh', background:'#08080f', position:'relative', display:'flex', flexDirection:'column' }}>

        {/* Grid overlay */}
        <div style={{
          position:'absolute', inset:0, pointerEvents:'none', zIndex:0,
          backgroundImage:`
            linear-gradient(rgba(255,255,255,0.025) 1px,transparent 1px),
            linear-gradient(90deg,rgba(255,255,255,0.025) 1px,transparent 1px)
          `,
          backgroundSize:'52px 52px',
          maskImage:'radial-gradient(ellipse 90% 70% at 50% 20%, black 20%, transparent 80%)',
          WebkitMaskImage:'radial-gradient(ellipse 90% 70% at 50% 20%, black 20%, transparent 80%)',
          animation:'pricing-grid-fade 6s ease-in-out infinite',
        }} />

        {/* Purple ambient */}
        <div style={{
          position:'absolute', pointerEvents:'none', zIndex:0,
          width:'700px', height:'350px', borderRadius:'50%',
          top:'60px', left:'50%', transform:'translateX(-50%)',
          background:'radial-gradient(ellipse, rgba(139,92,246,0.10) 0%, transparent 70%)',
          filter:'blur(60px)',
        }} />

        <div style={{ position:'relative', zIndex:1, maxWidth:'1120px', margin:'0 auto', padding:'64px 24px 100px', display:'flex', flexDirection:'column', alignItems:'center' }}>

          {/* Headline — slightly smaller than before */}
          <h1 style={{
            fontSize:'clamp(36px, 5.5vw, 68px)',
            fontWeight:900, lineHeight:1.0,
            letterSpacing:'-0.03em', color:'#ffffff',
            textAlign:'center', margin:'0 0 16px',
          }}>
            One price. Worldwide.
          </h1>

          <p style={{
            fontSize:'15px', color:'rgba(255,255,255,0.42)',
            textAlign:'center', lineHeight:1.65,
            maxWidth:'400px', margin:'0 0 56px',
          }}>
            No dark patterns. No regional pricing. Cancel any time.
            Your data stays yours.
          </p>

          {/* Cards grid */}
          <div style={{
            display:'grid',
            gridTemplateColumns:'repeat(3, 1fr)',
            gap:'18px',
            width:'100%',
            alignItems:'start',
          }}>
            {PLANS.map(plan => (
              <div
                key={plan.id}
                className={plan.popular ? 'card-popular' : ''}
                style={{
                  position:'relative',
                  background: plan.popular ? 'rgba(12,10,26,0.92)' : 'rgba(10,10,18,0.72)',
                  borderRadius:'20px',
                  padding:'28px 22px 24px',
                  display:'flex', flexDirection:'column', gap:'0',
                  ...(plan.popular ? {} : {
                    border:`1px solid ${plan.border}`,
                    boxShadow: plan.id === 'elite' ? '0 0 40px rgba(139,92,246,0.12)' : undefined,
                  }),
                  marginTop: plan.popular ? '-10px' : '0',
                }}
              >
                {/* Most Popular badge */}
                {plan.popular && (
                  <div style={{
                    position:'absolute', top:'-14px', left:'50%', transform:'translateX(-50%)',
                    background:'linear-gradient(90deg,#8b5cf6,#ec4899)',
                    borderRadius:'999px', padding:'4px 16px',
                    fontSize:'9px', fontWeight:800, letterSpacing:'0.18em', color:'#fff',
                    whiteSpace:'nowrap', fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)',
                  }}>MOST POPULAR</div>
                )}

                {/* Tier label */}
                <div style={{ fontSize:'10px', fontWeight:700, letterSpacing:'0.18em', color:plan.labelColor, fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)', marginBottom:'10px' }}>
                  {plan.label}
                </div>

                {/* Price */}
                <div style={{ fontSize:'clamp(44px,5vw,64px)', fontWeight:900, lineHeight:1, color:'#ffffff', letterSpacing:'-0.03em', marginBottom:'6px' }}>
                  {plan.price}
                </div>

                {/* Billing */}
                <div style={{ fontSize:'10px', color:'rgba(255,255,255,0.32)', marginBottom:'20px', fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)' }}>
                  {plan.billing}
                </div>

                {/* Engine badge */}
                <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'20px' }}>
                  <div style={{ width:'5px', height:'5px', borderRadius:'50%', background:plan.engineColor, flexShrink:0 }} />
                  <span style={{ fontSize:'8px', fontWeight:700, letterSpacing:'0.16em', color:plan.engineColor, fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)' }}>
                    {plan.engine}
                  </span>
                </div>

                {/* Divider */}
                <div style={{ height:'1px', background:'rgba(255,255,255,0.07)', marginBottom:'18px' }} />

                {/* Feature sections */}
                <div className="pricing-scrollbar" style={{ display:'flex', flexDirection:'column', gap:'16px', marginBottom:'22px' }}>
                  {plan.sections.map(sec => (
                    <div key={sec.title}>
                      <div style={{
                        fontSize:'8px', fontWeight:700, letterSpacing:'0.16em',
                        color: SECTION_TITLE_COLOR[plan.id],
                        fontFamily:'var(--font-plex-mono,IBM Plex Mono,monospace)',
                        textTransform:'uppercase', marginBottom:'7px',
                      }}>
                        {sec.title}
                      </div>
                      <div style={{ display:'flex', flexDirection:'column', gap:'4px' }}>
                        {sec.items.map(item => {
                          const isNo = item.startsWith('No ')
                          return (
                            <div key={item} style={{ display:'flex', alignItems:'flex-start', gap:'7px' }}>
                              <span style={{
                                fontSize:'9px', flexShrink:0, marginTop:'1px',
                                color: isNo ? 'rgba(255,255,255,0.18)' : CHECK_COLOR[plan.id],
                                lineHeight:1.2,
                              }}>
                                {isNo ? '✕' : '✓'}
                              </span>
                              <span style={{
                                fontSize:'11px', lineHeight:1.45,
                                color: isNo ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.72)',
                                fontFamily:'var(--font-inter,Inter,sans-serif)',
                              }}>
                                {item}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* CTA */}
                <Link
                  href="/app"
                  className={plan.ctaStyle === 'gradient' ? 'cta-gradient' : 'cta-outline'}
                  style={{
                    display:'block', textAlign:'center',
                    padding:'12px 20px', borderRadius:'10px',
                    fontSize:'11px', fontWeight:700, letterSpacing:'0.10em',
                    textTransform:'uppercase', textDecoration:'none',
                    fontFamily:'var(--font-inter,Inter,sans-serif)',
                    cursor:'pointer', marginTop:'auto',
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

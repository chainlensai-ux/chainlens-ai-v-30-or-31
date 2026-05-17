'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import { supabase } from '@/lib/supabaseClient'
import { AFFILIATE_REF_KEY, isValidReferralCode, normalizeReferralCode } from '@/lib/affiliate/referral'
import type { UserPlan } from '@/lib/planFeatures'

type PlanId = 'free' | 'pro' | 'elite'

type Plan = {
  id: PlanId
  label: string
  price: string
  subtext: string
  sectionTitle: string
  features: string[]
  note?: string
  badge?: string
  ctaClass: string
}

const plans: Plan[] = [
  {
    id: 'free',
    label: 'FREE',
    price: '$0',
    subtext: 'forever free · no card required',
    sectionTitle: 'WHAT\'S INCLUDED',
    note: '',
    badge: 'CORTEX LITE',
    features: [
      'Price, liquidity, volume, 24h change',
      'Basic token info only',
      'Basic LP score only',
      'Clark AI — 3 prompts per day',
      'No AI token verdict',
      'No full LP analysis',
      'No Wallet Scanner',
      'No Dev Wallet Detector',
      'No Pump Alerts',
      'No Whale Alerts',
      'No Base Radar',
    ],
    ctaClass: 'cta-free',
  },
  {
    id: 'pro',
    label: 'PRO',
    price: '$30',
    subtext: 'per month',
    sectionTitle: 'FULL ACCESS',
    note: 'Everything serious Base traders need.',
    badge: 'CORTEX STANDARD',
    features: [
      'Full Token Scanner',
      'Full Liquidity Safety',
      'Wallet Scanner',
      'Dev Wallet Detector',
      'Pump Alerts',
      'Whale Alerts',
      'Base Radar',
      'Clark AI — 50 prompts / day',
      'Token security and tax simulation where available',
      'Holder distribution where available',
      'Portfolio and account tools',
    ],
    ctaClass: 'cta-pro',
  },
  {
    id: 'elite',
    label: 'ELITE',
    price: '$60',
    subtext: 'per month',
    sectionTitle: 'POWER TIER',
    note: 'For traders who want more CORTEX power, higher limits, and faster reads.',
    badge: 'CORTEX FULL INTELLIGENCE',
    features: [
      'Everything in Pro',
      'Unlimited Clark AI prompts, subject to fair use',
      'Auto Clark verdict on every supported scan',
      'Higher CORTEX usage limits',
      'Priority CORTEX processing where available',
      'More room for whale and wallet monitoring',
      'Early access to new ChainLens features',
      'Best plan for daily Base researchers and active traders',
    ],
    ctaClass: 'cta-elite',
  },
]

const PRODUCT_PROOF = [
  { icon: '⛓', label: 'Base-native terminal' },
  { icon: '🔍', label: 'Live token scanner' },
  { icon: '🐋', label: 'Whale + pump alerts' },
  { icon: '🤖', label: 'Clark AI reports' },
]

const NAV_LINKS = [
  { label: 'Terminal', href: '/terminal' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Affiliate', href: '/affiliate' },
  { label: 'About', href: '/about' },
  { label: 'Terms', href: '/terms' },
]

export default function PricingPage() {
  const [userPlan, setUserPlan] = useState<UserPlan>('free')
  const [sessionReady, setSessionReady] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState<PlanId | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSessionReady(true)
      const token = data.session?.access_token
      if (!token) return
      try {
        const res = await fetch('/api/user-settings', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const json = await res.json()
          const p = (json as Record<string, unknown>)?.plan ??
            (json?.settings as Record<string, unknown>)?.plan
          if (p === 'pro' || p === 'elite') setUserPlan(p)
        }
      } catch { /* stay on free */ }
    })
  }, [])

  async function handleCryptoPay(planId: 'pro' | 'elite') {
    setCheckoutError(null)
    setCheckoutLoading(planId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        setCheckoutError('Sign in to start checkout.')
        return
      }
      const referralRaw = typeof window !== 'undefined' ? window.localStorage.getItem(AFFILIATE_REF_KEY) : null
      const referralCode = referralRaw && isValidReferralCode(referralRaw) ? normalizeReferralCode(referralRaw) : null
      const res = await fetch('/api/checkout/crypto', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: planId, referralCode }),
      })
      const json = await res.json() as Record<string, unknown>
      if (!res.ok || !json.checkoutUrl) {
        setCheckoutError((json.error as string) ?? 'Checkout creation failed. Try again.')
        return
      }
      window.location.href = json.checkoutUrl as string
    } catch {
      setCheckoutError('Checkout creation failed. Try again.')
    } finally {
      setCheckoutLoading(null)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#03060f', color: '#f8fafc', position: 'relative', overflow: 'hidden' }}>
      <style>{`
        /* Base glass + CTA */
        .glass{background:linear-gradient(170deg,rgba(10,17,33,.88),rgba(5,9,20,.82));backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,.18);border-radius:18px}
        .cta{display:block;width:100%;text-align:center;border-radius:11px;padding:12px 14px;font-weight:800;font-size:12px;letter-spacing:.09em;text-decoration:none;transition:.22s transform,.22s box-shadow,.22s opacity,.22s border-color;cursor:pointer;border:none}
        .cta-free{border:1px solid rgba(34,211,238,.32) !important;color:#e2e8f0;background:rgba(15,23,42,.55)}
        .cta-free:hover{border-color:rgba(34,211,238,.6) !important;box-shadow:0 0 22px rgba(34,211,238,.22) !important;transform:translateY(-2px)}
        .cta-pro{color:#fff;background:linear-gradient(98deg,#7c3aed,#a855f7,#ec4899);box-shadow:0 12px 30px rgba(168,85,247,.55)}
        .cta-pro:hover:not(:disabled){box-shadow:0 16px 48px rgba(168,85,247,.78) !important;transform:translateY(-2px)}
        .cta-elite{color:#221300;background:linear-gradient(120deg,#f59e0b,#fde047,#facc15);box-shadow:0 12px 32px rgba(251,191,36,.5)}
        .cta-elite:hover:not(:disabled){box-shadow:0 16px 48px rgba(251,191,36,.72) !important;transform:translateY(-2px)}

        /* Pricing card hover lift + glow */
        .pricing-card{transition:transform .26s ease,box-shadow .26s ease,border-color .26s ease}
        .pricing-card:hover{transform:translateY(-5px) !important}
        .pricing-card-free:hover{border-color:rgba(34,211,238,.54) !important;box-shadow:0 0 52px rgba(34,211,238,.26),inset 0 0 0 1px rgba(34,211,238,.22) !important}
        .pricing-card-pro:hover{border-color:rgba(217,70,239,.98) !important;box-shadow:0 0 88px rgba(217,70,239,.62),inset 0 0 0 1px rgba(217,70,239,.44) !important}
        .pricing-card-elite:hover{border-color:rgba(251,191,36,.98) !important;box-shadow:0 0 88px rgba(251,191,36,.56),inset 0 0 0 1px rgba(251,191,36,.44) !important}

        /* Footer link hover */
        .pf-footer-link{color:#475569;font-size:13px;text-decoration:none;transition:color .18s ease;display:block;margin-bottom:11px}
        .pf-footer-link:hover{color:#cbd5e1}

        /* Background helpers */
        .energy-right{position:absolute;right:-80px;top:120px;width:480px;height:360px;opacity:.17;background:repeating-linear-gradient(135deg,rgba(217,70,239,.45) 0 1px,transparent 1px 14px);filter:blur(1.2px)}
        .energy-left{position:absolute;left:-130px;top:120px;width:420px;height:340px;opacity:.12;background:radial-gradient(circle at 25% 50%,rgba(56,189,248,.28),transparent 65%)}

        /* Layout responsive */
        @media(max-width:1250px){.hero{grid-template-columns:1fr !important}.plan-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important}.stats{max-width:340px}.intro{min-height:auto !important}}
        @media(max-width:860px){.plan-grid{grid-template-columns:1fr !important}.pricing-card:hover{transform:translateY(-2px) !important}}
        @media(max-width:960px){.pf-footer-grid{grid-template-columns:1fr 1fr !important;gap:36px !important}}
        @media(max-width:560px){.pf-footer-grid{grid-template-columns:1fr !important}}
      `}</style>

      <Navbar />

      {/* ── BACKGROUND LAYERS ── */}
      <div style={{ position:'absolute', inset:0, background:'linear-gradient(180deg,rgba(7,12,24,.2) 0%,rgba(3,6,15,0) 55%)', pointerEvents:'none' }} />
      <div className='energy-right' />
      <div className='energy-left' />
      {/* Upper radial blobs */}
      <div style={{ position:'absolute', inset:0, background:'radial-gradient(circle at 18% 22%,rgba(34,211,238,.22),transparent 35%),radial-gradient(circle at 84% 20%,rgba(217,70,239,.22),transparent 34%),radial-gradient(circle at 60% 8%,rgba(129,140,248,.15),transparent 38%)', pointerEvents:'none' }} />
      {/* Deep navy bottom fill */}
      <div style={{ position:'absolute', inset:'auto -28% -320px -28%', height:620, background:'radial-gradient(ellipse at 50% 10%,rgba(11,25,56,.96) 0%,rgba(7,14,33,.92) 38%,rgba(4,8,19,.55) 63%,rgba(3,6,15,.08) 86%,transparent 100%)', pointerEvents:'none' }} />
      {/* Cyan arc horizon */}
      <div style={{ position:'absolute', left:'-28%', right:'-28%', bottom:-255, height:520, borderTop:'2px solid rgba(56,189,248,.82)', borderRadius:'58% 58% 0 0 / 100% 100% 0 0', boxShadow:'0 -24px 95px rgba(34,211,238,.54),0 -16px 130px rgba(59,130,246,.32)', pointerEvents:'none' }} />
      {/* Purple arc */}
      <div style={{ position:'absolute', left:'-20%', right:'-20%', bottom:-276, height:520, borderTop:'1px solid rgba(217,70,239,.48)', borderRadius:'54% 54% 0 0 / 100% 100% 0 0', boxShadow:'0 -10px 68px rgba(217,70,239,.2)', pointerEvents:'none' }} />
      {/* Gold glow — Elite side */}
      <div style={{ position:'absolute', right:'-10%', bottom:0, width:'45%', height:400, background:'radial-gradient(ellipse at 90% 80%,rgba(251,191,36,.13) 0%,transparent 58%)', pointerEvents:'none' }} />
      {/* Center glow behind cards */}
      <div style={{ position:'absolute', left:'-14%', right:'-14%', bottom:-240, height:400, background:'radial-gradient(ellipse at 50% 0%,rgba(34,211,238,.14),rgba(147,197,253,.1) 28%,rgba(217,70,239,.08) 48%,transparent 78%)', pointerEvents:'none' }} />
      {/* Subtle dot grid */}
      <div style={{ position:'absolute', inset:0, backgroundImage:'radial-gradient(circle,rgba(148,163,184,.038) 1px,transparent 1px)', backgroundSize:'28px 28px', pointerEvents:'none' }} />

      {/* ── MAIN CONTENT ── */}
      <div style={{ position:'relative', zIndex:2, maxWidth:1680, margin:'0 auto', padding:'24px 22px 52px' }}>

        <section className='hero' style={{ display:'grid', gridTemplateColumns:'1.02fr 2.65fr .72fr', gap:12, alignItems:'stretch' }}>

          {/* Left intro */}
          <div className='intro' style={{ padding:'18px 12px 8px 6px', minHeight:468 }}>
            <div style={{ color:'#67e8f9', fontSize:11, letterSpacing:'.2em', marginBottom:14 }}>• PRICING</div>
            <div style={{ fontSize:'clamp(40px,3.6vw,66px)', lineHeight:.95, fontWeight:900 }}>
              ONE PRICE.<br />
              <span style={{ background:'linear-gradient(90deg,#22d3ee,#a855f7,#ec4899)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>WORLDWIDE.</span>
            </div>
            <p style={{ marginTop:14, color:'#94a3b8', lineHeight:1.5, fontSize:14 }}>No dark patterns. No regional pricing.<br />Your data stays yours.</p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:14 }}>
              {['Pay with crypto', 'Built for Base', 'Auto activation'].map((chip) => (
                <span key={chip} style={{ borderRadius:999, border:'1px solid rgba(148,163,184,.28)', padding:'6px 10px', fontSize:11, color:'#dbeafe', background:'rgba(15,23,42,.55)', boxShadow:'0 0 16px rgba(34,211,238,.12)' }}>{chip}</span>
              ))}
            </div>
            <div style={{ marginTop:12, fontSize:12, color:'#94a3b8' }}>Powered by <span style={{ color:'#e2e8f0', fontWeight:700 }}>BASE</span></div>
          </div>

          {/* Pricing cards */}
          <div className='plan-grid' style={{ display:'grid', gridTemplateColumns:'repeat(3,minmax(0,1fr))', gap:14, paddingTop:14 }}>
            {plans.map((plan) => {
              const isCurrent = userPlan === plan.id
              const isPaid = plan.id === 'pro' || plan.id === 'elite'
              const isLoading = checkoutLoading === plan.id

              const borderColor = plan.id === 'pro'
                ? 'rgba(217,70,239,.72)'
                : plan.id === 'elite'
                  ? 'rgba(251,191,36,.66)'
                  : 'rgba(34,211,238,.3)'
              const boxShadow = plan.id === 'pro'
                ? '0 0 56px rgba(217,70,239,.38),inset 0 0 0 1px rgba(217,70,239,.24)'
                : plan.id === 'elite'
                  ? '0 0 56px rgba(251,191,36,.35),inset 0 0 0 1px rgba(250,204,21,.22)'
                  : '0 0 28px rgba(34,211,238,.12)'

              return (
                <div
                  key={plan.id}
                  className={`glass pricing-card pricing-card-${plan.id}`}
                  style={{
                    padding:'20px 20px 18px',
                    minHeight:468,
                    display:'flex',
                    flexDirection:'column',
                    borderColor,
                    boxShadow,
                    position:'relative',
                    transform: plan.id === 'pro' ? 'translateY(-3px)' : 'none',
                  }}
                >
                  {plan.badge && (
                    <div style={{
                      position:'absolute', top:-11, left:'50%', transform:'translateX(-50%)',
                      borderRadius:999,
                      background: plan.id === 'elite'
                        ? 'linear-gradient(90deg,#d97706,#fbbf24)'
                        : plan.id === 'free'
                          ? 'linear-gradient(90deg,#0891b2,#22d3ee)'
                          : 'linear-gradient(90deg,#a855f7,#ec4899)',
                      color: plan.id === 'elite' ? '#1c0e00' : plan.id === 'free' ? '#022c3a' : '#fff',
                      fontSize:10, letterSpacing:'.12em', fontWeight:800, padding:'4px 12px',
                      boxShadow: plan.id === 'elite'
                        ? '0 0 24px rgba(251,191,36,.6)'
                        : plan.id === 'free'
                          ? '0 0 24px rgba(34,211,238,.5)'
                          : '0 0 24px rgba(217,70,239,.6)',
                      whiteSpace:'nowrap',
                    }}>
                      {plan.badge}
                    </div>
                  )}

                  {/* Plan header */}
                  <div style={{ fontSize:12, letterSpacing:'.18em', color: plan.id === 'elite' ? '#facc15' : plan.id === 'pro' ? '#a78bfa' : '#67e8f9' }}>{plan.label}</div>
                  <div style={{ fontSize:48, fontWeight:800, marginTop:8, color: plan.id === 'elite' ? '#fde68a' : '#fff', lineHeight:1 }}>{plan.price}</div>
                  <div style={{ color:'#94a3b8', marginTop:2, fontSize:13 }}>{plan.subtext}</div>
                  <div style={{ marginTop:8, fontSize:11, color:'#64748b' }}>{plan.note}</div>
                  <div style={{ marginTop:14, fontSize:10, color: plan.id === 'elite' ? '#fcd34d' : plan.id === 'pro' ? '#67e8f9' : '#22d3ee', letterSpacing:'.15em' }}>{plan.sectionTitle}</div>

                  {/* Features */}
                  <div style={{ display:'grid', gap:8, marginTop:10, flex:1 }}>
                    {plan.features.map((f) => {
                      const no = f.startsWith('No ')
                      return (
                        <div key={f} style={{ display:'flex', gap:8, alignItems:'flex-start', color: no ? '#64748b' : '#dbeafe', fontSize:12.5, lineHeight:1.45 }}>
                          <span style={{ color: no ? '#475569' : plan.id === 'elite' ? '#facc15' : plan.id === 'pro' ? '#22d3ee' : '#67e8f9', flexShrink:0 }}>{no ? '✕' : '✓'}</span>
                          <span>{f}</span>
                        </div>
                      )
                    })}
                  </div>

                  {plan.id === 'elite' && (
                    <div style={{ border:'1px solid rgba(250,204,21,.4)', background:'rgba(250,204,21,.08)', color:'#fde68a', borderRadius:11, padding:10, fontSize:12, marginTop:12 }}>
                      Everything in Pro — plus maximum CORTEX access, higher limits, and early feature access.
                    </div>
                  )}

                  {/* CTA block */}
                  <div style={{ marginTop:14 }}>
                    {isCurrent ? (
                      <span className={`cta ${plan.ctaClass}`} style={{ opacity:0.72, cursor:'default', pointerEvents:'none', display:'block' }}>
                        ✓ Current plan
                      </span>
                    ) : plan.id === 'free' ? (
                      <Link href='/terminal' className={`cta ${plan.ctaClass}`} style={{ display:'block' }}>
                        GET STARTED
                      </Link>
                    ) : (
                      <button
                        className={`cta ${plan.ctaClass}`}
                        disabled={isLoading || checkoutLoading !== null}
                        onClick={() => handleCryptoPay(plan.id as 'pro' | 'elite')}
                        style={{ opacity: isLoading ? 0.7 : 1 }}
                      >
                        {isLoading ? 'Opening checkout…' : 'PAY WITH CRYPTO'}
                      </button>
                    )}

                    {isPaid && !isCurrent && (
                      <p style={{ margin:'8px 0 0', fontSize:10, color:'#334155', lineHeight:1.4, textAlign:'center' }}>
                        {plan.id === 'pro' ? 'Pay with crypto' : 'Crypto payments available'} · USDC or ETH on Base
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Right stats aside */}
          <aside className='glass stats' style={{ padding:14, minHeight:468, borderColor:'rgba(34,211,238,.46)', boxShadow:'0 0 30px rgba(34,211,238,.16)' }}>
            <div style={{ color:'#67e8f9', fontSize:10, letterSpacing:'.15em', marginBottom:14, fontWeight:700 }}>WHAT'S INCLUDED</div>
            {PRODUCT_PROOF.map(({ icon, label }, i) => (
              <div key={label} style={{ borderTop: i === 0 ? '1px solid rgba(148,163,184,.22)' : '1px solid rgba(148,163,184,.14)', padding:'15px 0' }}>
                <div style={{ fontSize:28, lineHeight:1, marginBottom:6 }}>{icon}</div>
                <div style={{ color:'#e2e8f0', fontSize:13, fontWeight:600, lineHeight:1.35 }}>{label}</div>
              </div>
            ))}
          </aside>
        </section>

        {/* Global checkout error */}
        {checkoutError && (
          <div style={{ marginTop:16, maxWidth:480, marginLeft:'auto', marginRight:'auto', background:'rgba(248,113,113,0.10)', border:'1px solid rgba(248,113,113,0.30)', borderRadius:10, padding:'10px 16px', color:'#fca5a5', fontSize:13, textAlign:'center' }}>
            {checkoutError}
            <button onClick={() => setCheckoutError(null)} style={{ marginLeft:10, background:'none', border:'none', color:'#fca5a5', cursor:'pointer', fontSize:14, lineHeight:1 }}>×</button>
          </div>
        )}

        {/* Crypto payment disclosure */}
        {(!sessionReady || userPlan === 'free') && (
          <p style={{ marginTop:18, textAlign:'center', fontSize:11, color:'#3a5268', letterSpacing:'.04em' }}>
            Pay with crypto. Recommended: USDC on Base, USDC on Ethereum, or ETH. Your plan activates automatically after payment confirmation.
          </p>
        )}
      </div>

      {/* ══════════════════════════════════════
          PREMIUM FOOTER
      ══════════════════════════════════════ */}
      <footer style={{ position:'relative', zIndex:3, marginTop:24 }}>
        {/* Glowing horizon line */}
        <div style={{ height:1, background:'linear-gradient(90deg,transparent 0%,rgba(34,211,238,.52) 25%,rgba(168,85,247,.52) 55%,rgba(251,191,36,.32) 80%,transparent 100%)', boxShadow:'0 0 32px rgba(34,211,238,.3),0 0 52px rgba(168,85,247,.18)' }} />

        {/* Footer body */}
        <div style={{ background:'rgba(2,5,13,.94)', backdropFilter:'blur(8px)' }}>
          <div
            className='pf-footer-grid'
            style={{ maxWidth:1680, margin:'0 auto', padding:'52px 28px 40px', display:'grid', gridTemplateColumns:'1.7fr 1fr 1.1fr 1.1fr', gap:52 }}
          >
            {/* Brand */}
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
                <div style={{ width:7, height:7, borderRadius:'50%', background:'#22d3ee', boxShadow:'0 0 10px rgba(34,211,238,.8)', flexShrink:0 }} />
                <span style={{ fontSize:16, fontWeight:900, color:'#e2e8f0', letterSpacing:'-.01em' }}>ChainLens AI</span>
              </div>
              <p style={{ color:'#475569', fontSize:13, lineHeight:1.72, maxWidth:300, margin:0 }}>
                Onchain intelligence for Base traders.<br />
                Scan wallets, track whales, detect pumps, and get AI-powered analysis from Clark — all in one terminal.
              </p>
              <div style={{ marginTop:20, display:'flex', gap:8, flexWrap:'wrap' }}>
                {['BUILT ON BASE', 'POWERED BY CORTEX'].map((tag) => (
                  <span key={tag} style={{ fontSize:9, color:'#334155', border:'1px solid rgba(148,163,184,.12)', borderRadius:6, padding:'4px 9px', letterSpacing:'.09em' }}>{tag}</span>
                ))}
              </div>
            </div>

            {/* Navigation */}
            <div>
              <div style={{ fontSize:10, letterSpacing:'.16em', color:'#334155', marginBottom:18, fontWeight:700 }}>NAVIGATION</div>
              {NAV_LINKS.map(({ label, href }) => (
                <Link key={label} href={href} className='pf-footer-link'>{label}</Link>
              ))}
            </div>

            {/* Infrastructure */}
            <div>
              <div style={{ fontSize:10, letterSpacing:'.16em', color:'#334155', marginBottom:18, fontWeight:700 }}>INFRASTRUCTURE</div>
              {['Built on Base.', 'Powered by CORTEX.', 'Private by design.', 'Real-time onchain intelligence.'].map((item) => (
                <div key={item} style={{ color:'#475569', fontSize:12.5, marginBottom:11, lineHeight:1.5 }}>{item}</div>
              ))}
            </div>

            {/* CORTEX Network */}
            <div>
              <div style={{ fontSize:10, letterSpacing:'.16em', color:'#334155', marginBottom:18, fontWeight:700 }}>CORTEX NETWORK</div>
              <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:12 }}>
                <div style={{ width:7, height:7, borderRadius:'50%', background:'#22c55e', boxShadow:'0 0 10px rgba(34,197,94,.8)', flexShrink:0 }} />
                <span style={{ color:'#22c55e', fontSize:12, fontWeight:800, letterSpacing:'.1em' }}>LIVE</span>
              </div>
              <div style={{ color:'#475569', fontSize:12.5, lineHeight:1.6, marginBottom:16 }}>Real-time. Onchain. Always scanning.</div>
              <div style={{ padding:'10px 12px', border:'1px solid rgba(34,211,238,.15)', borderRadius:9, background:'rgba(34,211,238,.04)' }}>
                <div style={{ fontSize:9, color:'#22d3ee', letterSpacing:'.1em', marginBottom:5 }}>NETWORK STATUS</div>
                <div style={{ fontSize:11.5, color:'#475569' }}>All systems operational</div>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div style={{ borderTop:'1px solid rgba(148,163,184,.07)', maxWidth:1680, margin:'0 auto', padding:'16px 28px', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:10 }}>
            <span style={{ color:'#1e293b', fontSize:11 }}>© 2025 ChainLens AI. All rights reserved.</span>
            <span style={{ color:'#1e293b', fontSize:11, letterSpacing:'.06em' }}>BUILT ON BASE</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

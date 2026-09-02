'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import { supabase } from '@/lib/supabaseClient'
import { peekCachedPlan } from '@/lib/usePlan'
import { AFFILIATE_REF_KEY, isValidReferralCode, normalizeReferralCode, readReferralCodeFromCookie } from '@/lib/affiliate/referral'
import type { UserPlan } from '@/lib/planFeatures'
import { pricingPlans, PRICING_PROOF } from '@/lib/pricingPlans'

const NAV_LINKS = [
  { label: 'Terminal', href: '/terminal' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Affiliate', href: '/affiliate' },
  { label: 'About', href: '/about' },
  { label: 'Terms', href: '/terms' },
]

export default function PricingPage() {
  // CACHED-FIRST INIT (smoothness audit): start from the last verified cached plan instead of
  // a guessed Free. Static plan cards render immediately regardless of plan state; only the
  // per-user "Current plan" badge waits for confirmation.
  const [userPlan, setUserPlan] = useState<UserPlan | null>(() => peekCachedPlan())
  const [, setSessionReady] = useState(false)
  const [planReady, setPlanReady] = useState(() => peekCachedPlan() != null)
  const [checkoutLoading, setCheckoutLoading] = useState<UserPlan | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [awaitingPayPalActivation, setAwaitingPayPalActivation] = useState(false)
  const [awaitingCryptoActivation, setAwaitingCryptoActivation] = useState(false)

  async function fetchCurrentPlan(token: string): Promise<UserPlan | null> {
    try {
      const res = await fetch('/api/user-settings', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null
      const json = await res.json() as Record<string, unknown>
      const p = json?.plan ?? json?.effectivePlan ?? (json?.settings as Record<string, unknown>)?.plan
      return p === 'pro' || p === 'elite' ? (p as UserPlan) : null
    } catch {
      return null
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSessionReady(true)
      const token = data.session?.access_token
      if (!token) { setUserPlan('free'); setPlanReady(true); return }
      const p = await fetchCurrentPlan(token)
      // CACHED-FIRST: only overwrite the displayed plan when the backend confirms
      // a different one — never blank it to Free while pending or on error.
      if (p) setUserPlan(p)
      else if (peekCachedPlan() == null) setUserPlan('free')
      setPlanReady(true)
    })
  }, [])

  // After PayPal redirects back from the subscription approval flow (return_url set by
  // /api/paypal/create-subscription), the plan hasn't been granted yet — that only happens once
  // PayPal's BILLING.SUBSCRIPTION.ACTIVATED webhook lands at /api/paypal/webhook, which can take a
  // few seconds after redirect. Poll /api/user-settings briefly so the UI reflects the real
  // activation instead of silently staying on "Free" until the next full page load.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const subscriptionParam = params.get('paypal_subscription')
    if (subscriptionParam !== 'approved') return
    window.history.replaceState({}, '', '/pricing')

    let cancelled = false
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      setAwaitingPayPalActivation(true)
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token || cancelled) { setAwaitingPayPalActivation(false); return }
      const p = await fetchCurrentPlan(token)
      if (cancelled) return
      if (p) {
        setUserPlan(p)
        setAwaitingPayPalActivation(false)
        return
      }
      attempts += 1
      if (attempts >= 8) { setAwaitingPayPalActivation(false); return } // ~24s of polling, then give up quietly
      window.setTimeout(poll, 3000)
    }
    poll()
    return () => { cancelled = true }
  }, [])

  // CRYPTO-ACTIVATION-POLL FIX, DISCLOSED (payments audit): NOWPayments redirects back to
  // /pricing?payment=success (see app/api/checkout/crypto/route.ts's success_url) before the IPN
  // webhook has necessarily landed — on-chain confirmation can take minutes, longer than PayPal's
  // near-instant activation. Without this, a user who paid with crypto saw a stale "Free" plan with
  // no indication anything was happening. Mirrors the PayPal poll above with a longer window.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('payment') !== 'success') return
    window.history.replaceState({}, '', '/pricing')

    let cancelled = false
    let attempts = 0
    const poll = async () => {
      if (cancelled) return
      setAwaitingCryptoActivation(true)
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token || cancelled) { setAwaitingCryptoActivation(false); return }
      const p = await fetchCurrentPlan(token)
      if (cancelled) return
      if (p) {
        setUserPlan(p)
        setAwaitingCryptoActivation(false)
        return
      }
      attempts += 1
      if (attempts >= 20) { setAwaitingCryptoActivation(false); return } // ~2min of polling, then give up quietly
      window.setTimeout(poll, 6000)
    }
    poll()
    return () => { cancelled = true }
  }, [])

  // Shared by both payment methods — redirects to sign-in and remembers where to return to.
  function redirectToAuth(returnPath: string) {
    try { sessionStorage.setItem('cl_auth_next', returnPath) } catch {}
    try { localStorage.setItem('cl_auth_next', returnPath) } catch {}
    document.cookie = `cl_auth_next=${encodeURIComponent(returnPath)}; Max-Age=3600; Path=/; SameSite=Lax`
    window.location.href = `/auth?next=${encodeURIComponent(returnPath)}`
  }

  // Real, connected crypto flow: creates a NOWPayments invoice, confirmed by
  // app/api/webhooks/crypto, which calls activateUserPlanServerSide.
  async function handleCryptoPay(planId: 'pro' | 'elite') {
    setCheckoutError(null)
    setCheckoutLoading(planId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const urlRef = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ref') : null
      const storedRef = typeof window !== 'undefined' ? window.localStorage.getItem(AFFILIATE_REF_KEY) : null
      const cookieRef = typeof window !== 'undefined' ? readReferralCodeFromCookie(document.cookie) : null
      const rawRef = urlRef ?? storedRef ?? cookieRef
      const referralCode = rawRef && isValidReferralCode(rawRef) ? normalizeReferralCode(rawRef) : null
      if (!token) {
        redirectToAuth(referralCode ? `/pricing?ref=${encodeURIComponent(referralCode)}` : '/pricing')
        return
      }
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

  // Real, connected PayPal Subscriptions flow: creates a recurring subscription against the live
  // PAYPAL_PRO_PLAN_ID/PAYPAL_ELITE_PLAN_ID Billing Plan via /api/paypal/create-subscription, then
  // redirects to PayPal's own approval URL. Once the user approves, PayPal fires
  // BILLING.SUBSCRIPTION.ACTIVATED at /api/paypal/webhook, which is what actually grants the plan
  // (see docs/paypal-verification.md's "Subscriptions" section) — there is no manual verification
  // step in this flow at all.
  async function handlePayPalPay(planId: 'pro' | 'elite') {
    setCheckoutError(null)
    setCheckoutLoading(planId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) {
        redirectToAuth('/pricing')
        return
      }
      const res = await fetch('/api/paypal/create-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan: planId }),
      })
      const json = await res.json() as { approvalUrl?: string; error?: string }
      if (!res.ok || !json.approvalUrl) {
        setCheckoutError(json.error ?? 'Could not start PayPal subscription. Try again.')
        return
      }
      window.location.href = json.approvalUrl
    } catch {
      setCheckoutError('Could not start PayPal subscription. Try again.')
    } finally {
      setCheckoutLoading(null)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#03060f', color: '#f8fafc', position: 'relative', overflowX: 'hidden', overflowY: 'auto', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
      <style>{`
        /* PROFESSIONAL POLISH PASS, DISCLOSED (pricing page task): calmer glass cards, static
           (never animated) shadows, softer badge capsules instead of floating glowing ribbons, and
           a toned-down Elite treatment (dark glass + a restrained gold accent, not a bright yellow
           gradient button) — same three plans/prices/CTAs/payment routes, purely visual. */
        .glass{background:linear-gradient(170deg,rgba(9,13,24,.90),rgba(5,8,17,.86));backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,.14);border-radius:16px}
        .cta{display:block;width:100%;text-align:center;border-radius:10px;padding:12px 14px;font-weight:700;font-size:13px;letter-spacing:.06em;text-decoration:none;transition:.18s transform,.18s box-shadow,.18s opacity,.18s border-color,.18s background;cursor:pointer;border:none;font-family:var(--font-inter, Inter, sans-serif)}
        .cta-free{border:1px solid rgba(148,163,184,.22) !important;color:#e2e8f0;background:rgba(255,255,255,.03)}
        .cta-free:hover{border-color:rgba(103,232,249,.38) !important;background:rgba(103,232,249,.05) !important;transform:translateY(-1px)}
        .cta-pro{color:#fff;background:linear-gradient(98deg,#6d28d9,#8b5cf6,#0891b2);box-shadow:0 8px 22px rgba(139,92,246,.28)}
        .cta-pro:hover:not(:disabled){box-shadow:0 10px 26px rgba(139,92,246,.38) !important;transform:translateY(-1px)}
        .cta-elite{color:#0c0700;background:linear-gradient(100deg,#d4a017,#e8c15c);box-shadow:0 8px 20px rgba(212,160,23,.22)}
        .cta-elite:hover:not(:disabled){box-shadow:0 10px 24px rgba(212,160,23,.30) !important;transform:translateY(-1px)}

        /* Pricing card hover — a small static lift only, no glow pulse */
        .pricing-card{transition:transform .18s ease,border-color .18s ease}
        .pricing-card:hover{transform:translateY(-2px) !important}
        .pricing-card-free:hover{border-color:rgba(103,232,249,.30) !important}
        .pricing-card-pro:hover{border-color:rgba(167,139,250,.44) !important}
        .pricing-card-elite:hover{border-color:rgba(212,160,23,.42) !important}

        /* Tier badge capsule — small, inline, near the header (replaces the old floating ribbon) */
        .plan-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:11px;font-weight:800;letter-spacing:.08em;white-space:nowrap}
        .plan-badge-free{color:rgba(103,232,249,.85);background:rgba(103,232,249,.07);border:1px solid rgba(103,232,249,.20)}
        .plan-badge-pro{color:rgba(196,181,253,.90);background:rgba(139,92,246,.09);border:1px solid rgba(139,92,246,.24)}
        .plan-badge-elite{color:#e8c874;background:rgba(212,160,23,.08);border:1px solid rgba(212,160,23,.26)}

        /* Footer link hover */
        .pf-footer-link{color:#475569;font-size:13px;text-decoration:none;transition:color .18s ease;display:block;margin-bottom:11px}
        .pf-footer-link:hover{color:#cbd5e1}

        /* Background helpers — same brand arcs/blobs, lower opacity so cards read as the focus */
        .energy-right{position:absolute;right:-80px;top:120px;width:480px;height:360px;opacity:.10;background:repeating-linear-gradient(135deg,rgba(217,70,239,.45) 0 1px,transparent 1px 14px);filter:blur(1.2px)}
        .energy-left{position:absolute;left:-130px;top:120px;width:420px;height:340px;opacity:.08;background:radial-gradient(circle at 25% 50%,rgba(56,189,248,.28),transparent 65%)}

        /* Layout — wrap before overlapping; never a cramped 3-up squeeze */
        .hero{display:flex;flex-direction:column;gap:28px}
        .plan-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;width:100%;align-items:stretch}
        .pricing-card{min-width:0;overflow:hidden}
        @media(max-width:1250px){.hero{grid-template-columns:1fr !important}.intro{min-height:auto !important}}
        @media(max-width:860px){.plan-grid{grid-template-columns:minmax(0,1fr) !important}.pricing-card:hover{transform:none !important}}
        @media(max-width:960px){.pf-footer-grid{grid-template-columns:1fr 1fr !important;gap:36px !important}}
        @media(max-width:560px){.pf-footer-grid{grid-template-columns:1fr !important}}

        /* Split crypto/card payment boxes — static hover only, no glow-pulse animation. A touch
           more vertical room than before (padding 10→12) so the two options read as clean payment
           choices rather than a cramped strip. */
        .cta-split-row{display:flex;gap:9px}
        .cta-box{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border-radius:10px;padding:12px 8px;font-weight:700;font-size:13px;letter-spacing:.04em;text-decoration:none;text-align:center;cursor:pointer;transition:.18s transform,.18s border-color,.18s background,.18s opacity;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.025);color:#e2e8f0;font-family:var(--font-inter, Inter, sans-serif)}
        .cta-box small{font-weight:600;font-size:11px;letter-spacing:.02em;color:#94a3b8;text-transform:none}
        .cta-box-crypto{border-color:rgba(45,212,191,.32);background:rgba(45,212,191,.03)}
        .cta-box-crypto:hover:not(:disabled){border-color:rgba(45,212,191,.55) !important;background:rgba(45,212,191,.06) !important;transform:translateY(-1px)}
        .cta-box-card{border-color:rgba(148,163,184,.18)}
        .cta-box-card:hover{border-color:rgba(148,163,184,.32) !important;background:rgba(148,163,184,.04) !important;transform:translateY(-1px)}
        .cta-box-tag{position:absolute;top:-8px;right:8px;background:#0a1420;border:1px solid rgba(45,212,191,.40);color:#5eead4;font-size:11px;font-weight:800;letter-spacing:.04em;border-radius:999px;padding:2px 7px;white-space:nowrap}

        @media (prefers-reduced-motion: reduce) {
          .pricing-card, .cta, .cta-box { transition: none !important; }
        }
      `}</style>

      <Navbar />

      {/* ── BACKGROUND LAYERS ── */}
      <div style={{ position:'absolute', inset:0, background:'linear-gradient(180deg,rgba(7,12,24,.2) 0%,rgba(3,6,15,0) 55%)', pointerEvents:'none' }} />
      <div className='energy-right' />
      <div className='energy-left' />
      {/* Upper radial blobs — softened, DISCLOSED (pricing polish task): lower opacity so the
          cards read as the focal point instead of competing with the background. */}
      <div style={{ position:'absolute', inset:0, background:'radial-gradient(circle at 18% 22%,rgba(34,211,238,.12),transparent 35%),radial-gradient(circle at 84% 20%,rgba(217,70,239,.10),transparent 34%),radial-gradient(circle at 60% 8%,rgba(129,140,248,.08),transparent 38%)', pointerEvents:'none' }} />
      {/* Deep navy bottom fill */}
      <div style={{ position:'absolute', inset:'auto -28% -320px -28%', height:620, background:'radial-gradient(ellipse at 50% 10%,rgba(11,25,56,.96) 0%,rgba(7,14,33,.92) 38%,rgba(4,8,19,.55) 63%,rgba(3,6,15,.08) 86%,transparent 100%)', pointerEvents:'none' }} />
      {/* Cyan arc horizon */}
      <div style={{ position:'absolute', left:'-28%', right:'-28%', bottom:-255, height:520, borderTop:'1px solid rgba(56,189,248,.42)', borderRadius:'58% 58% 0 0 / 100% 100% 0 0', boxShadow:'0 -14px 52px rgba(34,211,238,.22)', pointerEvents:'none' }} />
      {/* Purple arc */}
      <div style={{ position:'absolute', left:'-20%', right:'-20%', bottom:-276, height:520, borderTop:'1px solid rgba(217,70,239,.24)', borderRadius:'54% 54% 0 0 / 100% 100% 0 0', pointerEvents:'none' }} />
      {/* Gold glow — Elite side, restrained */}
      <div style={{ position:'absolute', right:'-10%', bottom:0, width:'45%', height:400, background:'radial-gradient(ellipse at 90% 80%,rgba(212,160,23,.07) 0%,transparent 58%)', pointerEvents:'none' }} />
      {/* Center glow behind cards */}
      <div style={{ position:'absolute', left:'-14%', right:'-14%', bottom:-240, height:400, background:'radial-gradient(ellipse at 50% 0%,rgba(34,211,238,.08),rgba(147,197,253,.06) 28%,rgba(217,70,239,.05) 48%,transparent 78%)', pointerEvents:'none' }} />
      {/* Subtle dot grid */}
      <div style={{ position:'absolute', inset:0, backgroundImage:'radial-gradient(circle,rgba(148,163,184,.038) 1px,transparent 1px)', backgroundSize:'28px 28px', pointerEvents:'none' }} />

      {/* ── MAIN CONTENT ── */}
      {/* ABOVE-THE-FOLD FIT, DISCLOSED (pricing above-the-fold CTA task): outer top padding and the
          card/intro/aside minHeight are all reduced together (24→14, 468→416) so the CTA/payment
          area sits noticeably higher on common laptop viewport heights, without changing any
          content, copy, or card proportions relative to each other. */}
      <div style={{ position:'relative', zIndex:2, maxWidth:1680, margin:'0 auto', padding:'14px 22px 40px' }}>

        <section className='hero'>

          {/* Left intro — top padding matches the pricing-card grid's own paddingTop so the
              "One price. Worldwide." headline starts at the same vertical line as the cards
              instead of floating slightly above them. */}
          <div className='intro' style={{ padding:'10px 4px 8px' }}>
            <div style={{ color:'#67e8f9', fontSize:11, letterSpacing:'.2em', marginBottom:10 }}>• PRICING</div>
            <div style={{ fontSize:'clamp(36px,3.2vw,60px)', lineHeight:.95, fontWeight:900 }}>
              ONE PRICE.<br />
              <span style={{ background:'linear-gradient(90deg,#22d3ee,#a855f7,#ec4899)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>WORLDWIDE.</span>
            </div>
            <p style={{ marginTop:11, color:'#94a3b8', lineHeight:1.5, fontSize:14 }}>No dark patterns. No regional pricing.<br />Your data stays yours.</p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:11 }}>
              {['Pay with crypto', 'Built for Base', 'Auto activation'].map((chip) => (
                <span key={chip} style={{ borderRadius:999, border:'1px solid rgba(148,163,184,.20)', padding:'6px 10px', fontSize:11, color:'#cbd5e1', background:'rgba(15,23,42,.45)' }}>{chip}</span>
              ))}
            </div>
            <div style={{ marginTop:10, fontSize:12, color:'#94a3b8' }}>Powered by <span style={{ color:'#e2e8f0', fontWeight:700 }}>BASE</span></div>
          </div>

          {/* Pricing cards */}
          <div className='plan-grid'>
            {pricingPlans.map((plan) => {
              const isCurrent = userPlan === plan.id
              const isPaid = plan.id === 'pro' || plan.id === 'elite'
              const isLoading = checkoutLoading === plan.id

              // CALMER CARD TREATMENT, DISCLOSED (pricing polish task): static borders/shadows only
              // (no glow pulse), Elite reads as dark glass + a restrained gold accent instead of a
              // bright yellow-bordered card — "expensive and exclusive", not arcade.
              const borderColor = plan.id === 'pro'
                ? 'rgba(139,92,246,.34)'
                : plan.id === 'elite'
                  ? 'rgba(212,160,23,.30)'
                  : 'rgba(148,163,184,.16)'
              const boxShadow = plan.id === 'pro'
                ? '0 8px 32px rgba(139,92,246,.14)'
                : plan.id === 'elite'
                  ? '0 8px 32px rgba(212,160,23,.10)'
                  : 'none'
              const cardBg = plan.id === 'elite'
                ? 'linear-gradient(170deg,rgba(14,11,4,.94),rgba(7,6,2,.90))'
                : undefined

              return (
                <div
                  key={plan.id}
                  className={`glass pricing-card pricing-card-${plan.id}`}
                  style={{
                    padding:'22px 22px 18px',
                    minHeight:0,
                    display:'flex',
                    flexDirection:'column',
                    borderColor,
                    boxShadow,
                    background: cardBg,
                    position:'relative',
                    transform: plan.id === 'pro' ? 'translateY(-2px)' : 'none',
                  }}
                >
                  {/* Plan header — badge now sits inline next to the label, not a floating ribbon */}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                    <div style={{ fontSize:12, letterSpacing:'.18em', color: plan.id === 'elite' ? '#e8c874' : plan.id === 'pro' ? '#c4b5fd' : '#94a3b8', fontWeight:700 }}>{plan.label}</div>
                    {plan.badge && (
                      <span className={`plan-badge plan-badge-${plan.id}`}>{plan.badge}</span>
                    )}
                  </div>
                  <div style={{ fontSize:40, fontWeight:800, marginTop:8, color: plan.id === 'elite' ? '#f3d98a' : '#fff', lineHeight:1 }}>{plan.price}</div>
                  <div style={{ color:'#94a3b8', marginTop:3, fontSize:13 }}>{plan.subtext}</div>
                  {plan.note && <div style={{ marginTop:6, fontSize:11.5, color:'#64748b', lineHeight:1.4 }}>{plan.note}</div>}
                  <div style={{ marginTop:12, paddingTop:9, borderTop:'1px solid rgba(148,163,184,.10)', fontSize:10, color: plan.id === 'elite' ? '#a88948' : plan.id === 'pro' ? '#8b7dc7' : '#5b7284', letterSpacing:'.14em', fontWeight:700 }}>{plan.sectionTitle}</div>

                  {/* Features — grouped included vs. unavailable (Free only has both kinds), and
                      spaced by count so a shorter list (Free) fills the shared card height evenly
                      instead of leaving one big dead gap before the CTA. Disabled/unavailable Free
                      rows render more compactly (smaller text, tighter gap) than included ones,
                      DISCLOSED (above-the-fold CTA task): still every feature string, unchanged. */}
                  {(() => {
                    const included = plan.features.filter((f) => !f.startsWith('No '))
                    const excluded = plan.features.filter((f) => f.startsWith('No '))
                    const rowGap = plan.features.length <= 7 ? 10 : plan.features.length <= 8 ? 8 : 7
                    const row = (f: string, no: boolean) => (
                      <div key={f} style={{ display:'flex', gap: no ? 7 : 9, alignItems:'flex-start', color: no ? '#4a5768' : '#cbd5e1', fontSize: 14, lineHeight: 1.5 }}>
                        <span style={{
                          color: no ? '#3a4452' : plan.id === 'elite' ? '#c9a545' : plan.id === 'pro' ? '#a78bfa' : '#67e8f9',
                          flexShrink:0, fontSize:11, marginTop:1,
                        }}>{no ? '–' : '✓'}</span>
                        <span>{f}</span>
                      </div>
                    )
                    return (
                      <div style={{ marginTop:9, flex:1 }}>
                        <div style={{ display:'grid', gap:rowGap }}>
                          {included.map((f) => row(f, false))}
                        </div>
                        {excluded.length > 0 && (
                          <>
                            <div style={{ marginTop:10, marginBottom:6, fontSize:9, color:'#3f4a58', letterSpacing:'.14em', fontWeight:700 }}>NOT INCLUDED</div>
                            <div style={{ display:'grid', gap: Math.max(5, rowGap - 3) }}>
                              {excluded.map((f) => row(f, true))}
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })()}

                  {plan.id === 'elite' && (
                    <div style={{ border:'1px solid rgba(212,160,23,.20)', background:'rgba(212,160,23,.05)', color:'#d9be82', borderRadius:10, padding:'8px 10px', fontSize:11.5, lineHeight:1.4, marginTop:10 }}>
                      Everything in Pro, plus the highest Clark and scan limits.
                    </div>
                  )}

                  {/* CTA block — a top divider ties the payment options to the feature list above
                      them (paid plans only), so Crypto/PayPal read as "how to unlock what's above"
                      rather than a separate, detached block. DISCLOSED (final pricing polish task). */}
                  <div style={{ marginTop:10, paddingTop: isPaid ? 10 : 0, borderTop: isPaid ? '1px solid rgba(148,163,184,.08)' : 'none' }}>
                    {isCurrent ? (
                      <span className={`cta ${plan.ctaClass}`} style={{ opacity:0.85, cursor:'default', pointerEvents:'none', display:'block' }}>
                        ✓ Current plan
                      </span>
                    ) : plan.id === 'free' ? (
                      <Link href='/terminal' className={`cta ${plan.ctaClass}`} style={{ display:'block' }}>
                        GET STARTED
                      </Link>
                    ) : (
                      <div className='cta-split-row'>
                        <button
                          className='cta-box cta-box-crypto'
                          disabled={isLoading || checkoutLoading !== null}
                          onClick={() => handleCryptoPay(plan.id as 'pro' | 'elite')}
                          style={{ opacity: isLoading ? 0.7 : 1 }}
                        >
                          <span className='cta-box-tag'>Recommended</span>
                          {isLoading ? 'Opening…' : 'Crypto'}
                          <small>USDC · Base</small>
                        </button>
                        <button
                          className='cta-box cta-box-card'
                          disabled={isLoading || checkoutLoading !== null}
                          onClick={() => handlePayPalPay(plan.id as 'pro' | 'elite')}
                          style={{ opacity: isLoading ? 0.7 : 1 }}
                        >
                          {isLoading ? 'Redirecting…' : 'PayPal'}
                          <small>Subscription</small>
                        </button>
                      </div>
                    )}

                    {planReady && isPaid && !isCurrent && (
                      <p style={{ margin:'8px 0 0', fontSize:10, color:'#334155', lineHeight:1.4, textAlign:'center' }}>
                        Crypto (USDC/ETH on Base) or a recurring PayPal subscription
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Right "What's included" panel — professional feature summary, DISCLOSED (pricing
              polish task): line-icon rows with consistent spacing/dividers instead of large emoji
              and a loud cyan-glow border, matching the calmer treatment used across the rest of
              the page. */}
          <aside className='glass stats' style={{ padding:'18px 20px', borderColor:'rgba(148,163,184,.14)', boxShadow:'none', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))', gap:12 }}>
            {PRICING_PROOF.map((label) => (
              <div key={label} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'8px 4px' }}>
                <span style={{ color:'#67e8f9', flexShrink:0, marginTop:2 }}>✓</span>
                <div style={{ color:'#dbeafe', fontSize:14, fontWeight:600, lineHeight:1.45 }}>{label}</div>
              </div>
            ))}
          </aside>
        </section>

        {/* PayPal subscription approved, waiting for the webhook to activate the plan */}
        {awaitingPayPalActivation && (
          <div style={{ marginTop:16, maxWidth:480, marginLeft:'auto', marginRight:'auto', background:'rgba(45,212,191,0.08)', border:'1px solid rgba(45,212,191,0.30)', borderRadius:10, padding:'10px 16px', color:'#5eead4', fontSize:13, textAlign:'center' }}>
            PayPal subscription approved — activating your plan…
          </div>
        )}

        {/* Crypto payment confirmed, waiting for the IPN webhook to activate the plan */}
        {awaitingCryptoActivation && (
          <div style={{ marginTop:16, maxWidth:480, marginLeft:'auto', marginRight:'auto', background:'rgba(45,212,191,0.08)', border:'1px solid rgba(45,212,191,0.30)', borderRadius:10, padding:'10px 16px', color:'#5eead4', fontSize:13, textAlign:'center' }}>
            Crypto payment received — activating your plan once the network confirms…
          </div>
        )}

        {/* Global checkout error */}
        {checkoutError && (
          <div style={{ marginTop:16, maxWidth:480, marginLeft:'auto', marginRight:'auto', background:'rgba(248,113,113,0.10)', border:'1px solid rgba(248,113,113,0.30)', borderRadius:10, padding:'10px 16px', color:'#fca5a5', fontSize:13, textAlign:'center' }}>
            {checkoutError}
            <button onClick={() => setCheckoutError(null)} style={{ marginLeft:10, background:'none', border:'none', color:'#fca5a5', cursor:'pointer', fontSize:14, lineHeight:1 }}>×</button>
          </div>
        )}

        {/* Crypto payment disclosure */}
        {(!planReady || userPlan === 'free') && (
          <p style={{ marginTop:18, textAlign:'center', fontSize:11, color:'#3a5268', letterSpacing:'.04em' }}>
            Pay with crypto. Recommended: USDC on Base, USDC on Ethereum, or ETH. Your plan activates automatically after payment confirmation.
          </p>
        )}

        {/* Trust/payment strip, DISCLOSED (final pricing polish task): existing, already-true copy
            only — same claims already made elsewhere on this page (crypto/PayPal, no regional
            pricing, data ownership) plus "Cancel anytime", true for both payment paths (a PayPal
            subscription can always be cancelled from PayPal; a crypto payment is a single period
            with no auto-renewal to begin with). Purely a compact restatement, not new promises. */}
        <div style={{ marginTop:22, display:'flex', flexWrap:'wrap', justifyContent:'center', alignItems:'center', gap:'8px 14px', padding:'14px 12px', borderTop:'1px solid rgba(148,163,184,.08)' }}>
          {['Cancel anytime', 'Crypto or PayPal subscription', 'Base-native intelligence', 'No regional pricing', 'Your data stays yours'].map((item, i) => (
            <span key={item} style={{ display:'inline-flex', alignItems:'center', gap:14 }}>
              {i > 0 && <span style={{ color:'rgba(148,163,184,.18)', fontSize:11 }}>·</span>}
              <span style={{ fontSize:11, color:'#526073', letterSpacing:'.03em' }}>{item}</span>
            </span>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════
          PREMIUM FOOTER
      ══════════════════════════════════════ */}
      <footer style={{ position:'relative', zIndex:3, marginTop:24 }}>
        {/* Horizon divider */}
        <div style={{ height:1, background:'linear-gradient(90deg,transparent 0%,rgba(34,211,238,.28) 25%,rgba(168,85,247,.28) 55%,rgba(212,160,23,.20) 80%,transparent 100%)' }} />

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
                On-chain analytics for wallets, tokens, liquidity, and risk — with Clark reading the same scanner evidence.
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

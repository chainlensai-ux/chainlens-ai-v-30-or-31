'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import { supabase } from '@/lib/supabaseClient'
import { peekCachedPlan } from '@/lib/usePlan'
import { AFFILIATE_REF_KEY, isValidReferralCode, normalizeReferralCode, readReferralCodeFromCookie } from '@/lib/affiliate/referral'
import type { UserPlan } from '@/lib/planFeatures'
import { pricingPlans, PRICING_PROOF } from '@/lib/pricingPlans'

type PaidPlanId = Exclude<UserPlan, 'free'>
type PaymentMethod = 'crypto' | 'card'

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
  const [planReady, setPlanReady] = useState(() => peekCachedPlan() != null)
  const [checkoutLoading, setCheckoutLoading] = useState<UserPlan | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [selectedPlanId, setSelectedPlanId] = useState<PaidPlanId | null>(null)
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethod | null>(null)
  const [freeCtaLoading, setFreeCtaLoading] = useState(false)
  const [awaitingPayPalActivation, setAwaitingPayPalActivation] = useState(false)
  const [awaitingCryptoActivation, setAwaitingCryptoActivation] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const selectedPlan = selectedPlanId
    ? pricingPlans.find((plan) => plan.id === selectedPlanId) ?? null
    : null

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

  useEffect(() => {
    if (!selectedPlanId) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !checkoutLoading) {
        setSelectedPlanId(null)
        setSelectedPaymentMethod(null)
        setCheckoutError(null)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [checkoutLoading, selectedPlanId])

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

  function closePaymentModal() {
    if (checkoutLoading) return
    setSelectedPlanId(null)
    setSelectedPaymentMethod(null)
    setCheckoutError(null)
  }

  function openPaymentModal(planId: PaidPlanId) {
    if (userPlan === planId) return
    setCheckoutError(null)
    setSelectedPaymentMethod(null)
    setSelectedPlanId(planId)
  }

  async function handleFreeCta() {
    if (freeCtaLoading) return
    setFreeCtaLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        redirectToAuth('/terminal/token-scanner')
        return
      }
      window.location.href = '/terminal/token-scanner'
    } finally {
      setFreeCtaLoading(false)
    }
  }

  // Both options create checkout server-side. Plan activation remains exclusively webhook-driven.
  async function startCheckout(planId: PaidPlanId, paymentMethod: PaymentMethod) {
    const plan = pricingPlans.find((candidate) => candidate.id === planId)
    const checkoutEndpoint = paymentMethod === 'crypto' ? plan?.cryptoCheckoutUrl : plan?.cardCheckoutUrl
    if (!plan || !checkoutEndpoint || userPlan === planId) return
    setCheckoutError(null)
    setSelectedPaymentMethod(paymentMethod)
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
      const res = await fetch(checkoutEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(paymentMethod === 'crypto' ? { plan: planId, referralCode } : { plan: planId }),
      })
      const json = await res.json() as { checkoutUrl?: string; approvalUrl?: string; error?: string }
      const redirectUrl = paymentMethod === 'crypto' ? json.checkoutUrl : json.approvalUrl
      if (!res.ok || !redirectUrl) {
        setCheckoutError(json.error ?? 'Checkout creation failed. Try again.')
        return
      }
      const parsedRedirect = new URL(redirectUrl)
      if (parsedRedirect.protocol !== 'https:') {
        setCheckoutError('Checkout returned an invalid redirect. Try again.')
        return
      }
      window.location.href = parsedRedirect.toString()
    } catch {
      setCheckoutError('Checkout creation failed. Try again.')
    } finally {
      setCheckoutLoading(null)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#03060f', color: '#f8fafc', position: 'relative', overflowX: 'hidden', overflowY: 'auto', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
      <style>{`
        html,body{max-width:100%;overflow-x:hidden}body{margin:0}
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

        .payment-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(1,4,11,.76);backdrop-filter:blur(8px)}
        .payment-modal{width:min(620px,100%);max-height:calc(100dvh - 48px);overflow:auto;border-radius:18px;border:1px solid rgba(148,163,184,.18);background:#080d17;box-shadow:0 24px 80px rgba(0,0,0,.52);padding:26px}
        .payment-close{position:absolute;top:18px;right:18px;width:44px;height:44px;border-radius:9px;border:1px solid rgba(148,163,184,.16);background:rgba(255,255,255,.025);color:#94a3b8;font-size:21px;line-height:1;cursor:pointer;transition:.16s border-color,.16s color,.16s background}
        .payment-close:hover:not(:disabled){color:#f8fafc;border-color:rgba(148,163,184,.34);background:rgba(255,255,255,.05)}
        .payment-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:22px}
        .payment-option{min-width:0;min-height:172px;display:flex;flex-direction:column;align-items:flex-start;text-align:left;border-radius:14px;padding:18px;border:1px solid rgba(148,163,184,.15);background:rgba(255,255,255,.022);color:#e2e8f0;cursor:pointer;transition:.16s transform,.16s border-color,.16s background,.16s opacity}
        .payment-option:hover:not(:disabled){transform:translateY(-1px);border-color:rgba(83,243,195,.38);background:rgba(83,243,195,.045)}
        .payment-option:focus-visible,.payment-close:focus-visible,.cta:focus-visible{outline:2px solid #53f3c3;outline-offset:2px}
        .payment-option-icon{width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:11px;color:#53f3c3;background:rgba(83,243,195,.07);border:1px solid rgba(83,243,195,.18)}
        .payment-option-title{font-size:15px;font-weight:800;margin-top:14px;color:#f8fafc}
        .payment-option-copy{font-size:12px;color:#7a8a9e;margin-top:5px;line-height:1.5}
        .payment-option-price{margin-top:auto;padding-top:16px;font-size:13px;font-weight:750;color:#cbd5e1}
        .payment-error{margin-top:14px;border-radius:10px;padding:10px 12px;border:1px solid rgba(248,113,113,.28);background:rgba(248,113,113,.08);color:#fca5a5;font-size:12px;line-height:1.45}
        @media(max-width:640px){.payment-overlay{padding:16px;align-items:flex-end}.payment-modal{padding:22px 18px;max-height:calc(100dvh - 24px);width:100%}.payment-options{grid-template-columns:1fr}.payment-option{min-height:142px}.payment-close{top:14px;right:14px}}

        @media (prefers-reduced-motion: reduce) {
          .pricing-card, .cta, .payment-option, .payment-close { transition: none !important; }
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
              {['Built for Base', 'Secure checkout', 'Auto activation'].map((chip) => (
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
                  <div style={{ fontSize:40, fontWeight:800, marginTop:8, color: plan.id === 'elite' ? '#f3d98a' : '#fff', lineHeight:1 }}>${plan.priceMonthly}</div>
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
                    {plan.id === 'free' ? (
                      <button
                        type='button'
                        className={`cta ${plan.ctaClass}`}
                        disabled={freeCtaLoading}
                        onClick={handleFreeCta}
                        aria-label='Get Started'
                      >
                        {freeCtaLoading ? 'Opening…' : 'Get Started'}
                      </button>
                    ) : isCurrent ? (
                      <button type='button' className={`cta ${plan.ctaClass}`} disabled aria-disabled='true' style={{ opacity:0.72, cursor:'default' }}>
                        ✓ Current Plan
                      </button>
                    ) : (
                      <button
                        type='button'
                        className={`cta ${plan.ctaClass}`}
                        disabled={isLoading || checkoutLoading !== null}
                        onClick={() => openPaymentModal(plan.id as PaidPlanId)}
                      >
                        Upgrade to {plan.name}
                      </button>
                    )}

                    {planReady && isPaid && !isCurrent && (
                      <p style={{ margin:'8px 0 0', fontSize:10, color:'#334155', lineHeight:1.4, textAlign:'center' }}>
                        Choose crypto or card in secure checkout
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
        {checkoutError && !selectedPlan && (
          <div style={{ marginTop:16, maxWidth:480, marginLeft:'auto', marginRight:'auto', background:'rgba(248,113,113,0.10)', border:'1px solid rgba(248,113,113,0.30)', borderRadius:10, padding:'10px 16px', color:'#fca5a5', fontSize:13, textAlign:'center' }}>
            {checkoutError}
            <button onClick={() => setCheckoutError(null)} style={{ marginLeft:10, background:'none', border:'none', color:'#fca5a5', cursor:'pointer', fontSize:14, lineHeight:1 }}>×</button>
          </div>
        )}

        {/* Checkout disclosure */}
        {(!planReady || userPlan === 'free') && (
          <p style={{ marginTop:18, textAlign:'center', fontSize:11, color:'#3a5268', letterSpacing:'.04em' }}>
            Choose crypto or card at checkout. Your plan activates automatically after payment confirmation.
          </p>
        )}

        {/* Trust/payment strip, DISCLOSED (final pricing polish task): existing, already-true copy
            only — same claims already made elsewhere on this page (crypto/PayPal, no regional
            pricing, data ownership) plus "Cancel anytime", true for both payment paths (a PayPal
            subscription can always be cancelled from PayPal; a crypto payment is a single period
            with no auto-renewal to begin with). Purely a compact restatement, not new promises. */}
        <div style={{ marginTop:22, display:'flex', flexWrap:'wrap', justifyContent:'center', alignItems:'center', gap:'8px 14px', padding:'14px 12px', borderTop:'1px solid rgba(148,163,184,.08)' }}>
          {['Cancel anytime', 'Crypto or card checkout', 'Base-native intelligence', 'No regional pricing', 'Your data stays yours'].map((item, i) => (
            <span key={item} style={{ display:'inline-flex', alignItems:'center', gap:14 }}>
              {i > 0 && <span style={{ color:'rgba(148,163,184,.18)', fontSize:11 }}>·</span>}
              <span style={{ fontSize:11, color:'#526073', letterSpacing:'.03em' }}>{item}</span>
            </span>
          ))}
        </div>
      </div>

      {selectedPlan && selectedPlanId && (
        <div
          className='payment-overlay'
          role='presentation'
          onClick={(event) => {
            if (event.target === event.currentTarget) closePaymentModal()
          }}
        >
          <section
            className='payment-modal'
            role='dialog'
            aria-modal='true'
            aria-labelledby='payment-modal-title'
            aria-describedby='payment-modal-subtitle'
            onClick={(event) => event.stopPropagation()}
            style={{ position:'relative' }}
          >
            <button
              ref={closeButtonRef}
              type='button'
              className='payment-close'
              onClick={closePaymentModal}
              disabled={checkoutLoading !== null}
              aria-label='Close payment options'
            >
              ×
            </button>
            {/* CARD-CHOOSES-PLAN / MODAL-CHOOSES-PAYMENT-METHOD, DISCLOSED (pricing card CTA
                task): the card CTA ("Upgrade to Pro"/"Upgrade to Elite") already commits to a
                plan before this modal ever opens — this modal's own copy must be about picking a
                payment method, not restate the plan choice. Plan/price still shown, one step
                down, so context isn't lost. */}
            <div style={{ color:'#53f3c3', fontSize:10, fontWeight:800, letterSpacing:'.16em' }}>CHAINLENS CHECKOUT</div>
            <h2 id='payment-modal-title' style={{ margin:'9px 46px 0 0', color:'#f8fafc', fontSize:'clamp(23px,5vw,30px)', lineHeight:1.15, letterSpacing:'-.02em' }}>
              Choose payment method
            </h2>
            <p id='payment-modal-subtitle' style={{ margin:'7px 0 0', color:'#7a8a9e', fontSize:14 }}>
              Select how you want to complete checkout.
            </p>
            <p id='payment-modal-price' style={{ margin:'3px 0 0', color:'#526073', fontSize:12 }}>
              {selectedPlan.name} · ${selectedPlan.priceMonthly}/month
            </p>

            <div className='payment-options'>
              <button
                type='button'
                className='payment-option'
                disabled={checkoutLoading !== null}
                aria-pressed={selectedPaymentMethod === 'crypto'}
                onClick={() => startCheckout(selectedPlanId, 'crypto')}
              >
                <span className='payment-option-icon' aria-hidden='true'>
                  <svg width='21' height='21' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
                    <circle cx='12' cy='12' r='8' />
                    <path d='M9.5 8.5h3.6a2.1 2.1 0 0 1 0 4.2H9.5m0 0h4a2.15 2.15 0 0 1 0 4.3h-4m1.2-10v2m0 8.5v-1m2-9v2m0 8.5v-1' />
                  </svg>
                </span>
                <span className='payment-option-title'>
                  {checkoutLoading && selectedPaymentMethod === 'crypto' ? 'Opening checkout…' : 'Crypto'}
                </span>
                <span className='payment-option-copy'>USDC / ETH on Base</span>
                <span className='payment-option-price'>${selectedPlan.priceMonthly}/month</span>
              </button>

              <button
                type='button'
                className='payment-option'
                disabled={checkoutLoading !== null}
                aria-pressed={selectedPaymentMethod === 'card'}
                onClick={() => startCheckout(selectedPlanId, 'card')}
              >
                <span className='payment-option-icon' aria-hidden='true'>
                  <svg width='21' height='21' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
                    <rect x='3' y='5' width='18' height='14' rx='2.5' />
                    <path d='M3 10h18M7 15h3' />
                  </svg>
                </span>
                <span className='payment-option-title'>
                  {checkoutLoading && selectedPaymentMethod === 'card' ? 'Opening checkout…' : 'Card'}
                </span>
                <span className='payment-option-copy'>Secure card checkout</span>
                <span className='payment-option-price'>${selectedPlan.priceMonthly}/month</span>
              </button>
            </div>

            {checkoutError && <div className='payment-error' role='alert'>{checkoutError}</div>}
            <p style={{ margin:'15px 2px 0', color:'#526073', fontSize:10.5, lineHeight:1.5 }}>
              Your plan activates only after the payment provider confirms the subscription.
            </p>
          </section>
        </div>
      )}

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

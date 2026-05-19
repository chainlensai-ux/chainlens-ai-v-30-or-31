'use client'

import Link from 'next/link'
import Navbar from '@/components/Navbar'

const SECTIONS = [
  {
    label: '01 — Subscription Plans',
    heading: 'Subscription Plans',
    body: [
      'ChainLens AI sells digital SaaS subscriptions for onchain analytics and AI-assisted research tools.',
      'Pro plan: $30/month.',
      'Elite plan: $60/month.',
    ],
  },
  {
    label: '02 — Free Plan',
    heading: 'Free Plan',
    body: [
      'ChainLens AI offers a free plan so users can review the product before upgrading. We encourage users to explore the free plan before purchasing a subscription.',
    ],
  },
  {
    label: '03 — Refund Eligibility',
    heading: 'Refund Eligibility',
    body: [
      'Because ChainLens AI provides digital subscription access, payments are generally non-refundable once access has been activated. However, we may review refund requests on a case-by-case basis.',
    ],
  },
  {
    label: '04 — When Refunds May Be Considered',
    heading: 'When Refunds May Be Considered',
    body: [
      'The user was charged incorrectly.',
      'A duplicate payment was made.',
      'The user paid but access was not activated.',
      'A technical issue prevented meaningful access shortly after payment.',
      'Required by applicable law.',
    ],
  },
  {
    label: '05 — When Refunds Are Not Provided',
    heading: 'When Refunds Are Generally Not Provided',
    body: [
      'Change of mind.',
      'Not using the subscription after purchase.',
      'Market losses or trading outcomes.',
      'Misunderstanding AI or onchain analysis outputs.',
      'Failure to cancel before renewal.',
      'Crypto network delays outside ChainLens AI control.',
      'Payments sent to the wrong address or an unsupported network.',
    ],
  },
  {
    label: '06 — Crypto Payments',
    heading: 'Crypto Payments',
    body: [
      'Crypto payments may be final once processed onchain or confirmed by the payment provider. Refunds for crypto payments, if approved, may be handled manually and may be affected by network fees, asset volatility, and provider limitations.',
    ],
  },
  {
    label: '07 — Card & Subscription Payments',
    heading: 'Card & Subscription Payments',
    body: [
      'Card subscription refunds, if approved, will generally be returned to the original payment method through the payment processor.',
    ],
  },
  {
    label: '08 — Cancellations',
    heading: 'Cancellations',
    body: [
      'Users may cancel their subscription at any time to prevent future renewals. Cancellation does not automatically refund previous payments unless a refund is separately approved.',
    ],
  },
  {
    label: '09 — How to Request a Refund',
    heading: 'How to Request a Refund',
    body: [
      'Email chainlensai@gmail.com with the following:',
      '— Account email address',
      '— Plan purchased',
      '— Payment date',
      '— Payment method used',
      '— Transaction or payment ID if available',
      '— Reason for the refund request',
    ],
  },
  {
    label: '10 — Review Time',
    heading: 'Review Time',
    body: [
      'We aim to review refund requests within a reasonable timeframe. We will contact you using the email provided.',
    ],
  },
  {
    label: '11 — No Financial Advice',
    heading: 'No Financial Advice',
    body: [
      'ChainLens AI provides analytics and research tools only. We do not guarantee profits, trading outcomes, token safety, or market performance. Nothing on this platform constitutes financial advice.',
    ],
  },
]

export default function RefundPage() {
  return (
    <>
      <style>{`
        @keyframes policy-fade-in {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .policy-section {
          animation: policy-fade-in 0.5s ease-out both;
        }
      `}</style>

      <Navbar />

      <div style={{ minHeight: '100vh', background: '#06060a', color: '#f8fafc' }}>

        {/* Ambient glow */}
        <div style={{
          position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)',
          width: '800px', height: '400px', borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(139,92,246,0.06) 0%, transparent 70%)',
          filter: 'blur(60px)', pointerEvents: 'none', zIndex: 0,
        }} />

        {/* Grid overlay */}
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: `
            linear-gradient(rgba(45,212,191,0.022) 1px, transparent 1px),
            linear-gradient(90deg, rgba(45,212,191,0.022) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }} />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: '760px', margin: '0 auto', padding: '72px 24px 96px' }}>

          {/* Page header */}
          <div style={{ marginBottom: '64px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', marginBottom: '20px' }}>
              <div style={{ height: '1px', width: '24px', background: 'linear-gradient(90deg, transparent, #2DD4BF)' }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>Legal</span>
              <div style={{ height: '1px', width: '24px', background: 'linear-gradient(90deg, #2DD4BF, transparent)' }} />
            </div>

            <h1 style={{
              fontSize: 'clamp(28px, 4vw, 44px)', fontWeight: 800,
              letterSpacing: '-0.025em', lineHeight: 1.1,
              color: '#f8fafc', margin: '0 0 16px',
            }}>
              Refund Policy
            </h1>

            <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.7, margin: '0 0 20px', maxWidth: '560px' }}>
              ChainLens AI sells digital SaaS subscriptions. Please read this policy carefully before purchasing.
              Last updated: May 2026.
            </p>

            {/* Divider */}
            <div style={{ height: '1px', background: 'linear-gradient(90deg, rgba(45,212,191,0.30), rgba(139,92,246,0.20), transparent)' }} />
          </div>

          {/* Sections */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '56px' }}>
            {SECTIONS.map((sec, i) => (
              <div
                key={sec.label}
                className="policy-section"
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <div style={{
                  fontSize: '9px', fontWeight: 700, letterSpacing: '0.22em',
                  color: '#2DD4BF', textTransform: 'uppercase',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  marginBottom: '10px',
                }}>
                  {sec.label}
                </div>

                <h2 style={{
                  fontSize: '20px', fontWeight: 700,
                  color: '#f1f5f9', letterSpacing: '-0.01em',
                  margin: '0 0 18px', lineHeight: 1.2,
                }}>
                  {sec.heading}
                </h2>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {sec.body.map((para, j) => (
                    <p key={j} style={{
                      fontSize: '14px', lineHeight: 1.75,
                      color: 'rgba(255,255,255,0.52)',
                      margin: 0, fontWeight: 400,
                    }}>
                      {para}
                    </p>
                  ))}
                </div>

                {i < SECTIONS.length - 1 && (
                  <div style={{
                    marginTop: '40px', height: '1px',
                    background: 'rgba(255,255,255,0.06)',
                  }} />
                )}
              </div>
            ))}
          </div>

          {/* Footer note */}
          <div style={{
            marginTop: '72px', paddingTop: '32px',
            borderTop: '1px solid rgba(45,212,191,0.18)',
          }}>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.7, margin: '0 0 8px' }}>
              Refund requests and billing questions:
            </p>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.7, margin: '0 0 24px' }}>
              <a href="mailto:chainlensai@gmail.com"
                style={{ color: '#2DD4BF', textDecoration: 'none' }}>
                chainlensai@gmail.com
              </a>
            </p>
            <Link href="/" style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.45)',
              textDecoration: 'none', transition: 'color 150ms',
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = '#2DD4BF' }}
              onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.45)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
              Back to ChainLens AI
            </Link>
          </div>

        </div>
      </div>
    </>
  )
}

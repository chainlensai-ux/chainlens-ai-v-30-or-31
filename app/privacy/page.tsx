'use client'

import Link from 'next/link'
import Navbar from '@/components/Navbar'

const SECTIONS = [
  {
    label: '01 — Information We Collect',
    heading: 'Information We Collect',
    body: [
      'Account information such as email address and authentication details.',
      'Subscription and payment status information.',
      'Affiliate application information if submitted.',
      'Product usage information such as feature usage, rate limits, and settings.',
      'Wallet addresses or token addresses entered by users for analysis.',
      'Technical information such as browser, device, IP-based security and rate-limit data, logs, and error diagnostics.',
    ],
  },
  {
    label: '02 — What We Do Not Collect',
    heading: 'What We Do Not Collect',
    body: [
      'We do not custody funds.',
      'We do not ask for private keys or seed phrases.',
      'We do not execute trades for users.',
      'We do not sell user conversations or private account data.',
    ],
  },
  {
    label: '03 — How We Use Information',
    heading: 'How We Use Information',
    body: [
      'To provide ChainLens AI features and functionality.',
      'To manage accounts, plans, and subscriptions.',
      'To process payments and activate plans.',
      'To prevent abuse, fraud, spam, and security issues.',
      'To improve reliability, support, and product experience.',
      'To respond to support and affiliate requests.',
    ],
  },
  {
    label: '04 — Payments',
    heading: 'Payments',
    body: [
      'Payments may be processed by third-party payment providers including card, subscription, and crypto payment processors. ChainLens AI does not store full card details.',
    ],
  },
  {
    label: '05 — Blockchain Data',
    heading: 'Blockchain Data',
    body: [
      'Wallet addresses, token addresses, transactions, and other onchain information may be public blockchain data. Users should not enter private keys, seed phrases, or sensitive personal information into ChainLens AI.',
    ],
  },
  {
    label: '06 — AI Outputs',
    heading: 'AI Outputs',
    body: [
      'Clark AI / CORTEX provides summaries and analysis based on available data. Outputs may be incomplete or inaccurate and should not be treated as financial advice.',
    ],
  },
  {
    label: '07 — Data Sharing',
    heading: 'Data Sharing',
    body: [
      'We may share limited data with service providers needed to operate the product, including hosting, authentication, payment processing, analytics, security, and support tools. We do not sell personal data.',
    ],
  },
  {
    label: '08 — Data Retention',
    heading: 'Data Retention',
    body: [
      'We retain information as needed to operate the service, comply with legal obligations, prevent fraud, resolve disputes, and enforce our terms.',
    ],
  },
  {
    label: '09 — Security',
    heading: 'Security',
    body: [
      'We use reasonable technical and organizational measures to protect user data. No system is 100% secure.',
    ],
  },
  {
    label: '10 — User Choices',
    heading: 'User Choices',
    body: [
      'Users may contact chainlensai@gmail.com to request support, account-related help, or deletion of eligible personal data.',
    ],
  },
  {
    label: '11 — Children',
    heading: 'Children',
    body: [
      'ChainLens AI is not intended for children under 13.',
    ],
  },
  {
    label: '12 — Changes',
    heading: 'Changes to This Policy',
    body: [
      'We may update this Privacy Policy from time to time. The latest version will be posted on this page.',
    ],
  },
]

export default function PrivacyPage() {
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
          background: 'radial-gradient(ellipse, rgba(45,212,191,0.06) 0%, transparent 70%)',
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
              Privacy Policy
            </h1>

            <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.7, margin: '0 0 20px', maxWidth: '560px' }}>
              ChainLens AI is a subscription-based platform providing onchain analytics and AI-assisted research tools for Base blockchain users.
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
              Questions about this policy?
            </p>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.7, margin: '0 0 24px' }}>
              Contact us at{' '}
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

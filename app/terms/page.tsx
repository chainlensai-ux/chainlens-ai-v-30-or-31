'use client'

import Link from 'next/link'
import Navbar from '@/components/Navbar'

const SECTIONS = [
  {
    label: '01 — Disclaimer',
    heading: 'Disclaimer',
    body: [
      'ChainLens AI provides informational and analytical tools only. Nothing on this platform constitutes financial, investment, legal, or tax advice of any kind.',
      'All data, analysis, alerts, and AI-generated responses are provided for educational and informational purposes only. Users are solely responsible for their own financial decisions.',
      'By using ChainLens AI, you acknowledge that you understand the speculative nature of cryptocurrency markets and that you are making independent decisions based on your own research and risk tolerance.',
    ],
  },
  {
    label: '02 — No Financial Advice',
    heading: 'No Financial Advice',
    body: [
      'Nothing on this platform — including but not limited to wallet scans, token analysis, pump alerts, whale tracking, liquidity scores, or CLARK AI responses — constitutes investment advice.',
      'Past performance of any token, wallet, or trading strategy does not guarantee future results. Cryptocurrency markets are highly volatile and unpredictable.',
      'ChainLens AI does not recommend buying, selling, or holding any asset. Any actions you take based on information from this platform are entirely at your own discretion and risk.',
    ],
  },
  {
    label: '03 — Data Accuracy',
    heading: 'Data Accuracy',
    body: [
      'ChainLens AI aggregates onchain data from public blockchain networks and third-party data providers. While we make reasonable efforts to ensure accuracy, we do not guarantee that any data displayed on this platform is complete, accurate, or up to date.',
      'Onchain data can be subject to delays, indexing errors, reorganisations, or provider outages. All data should be independently verified before being used to make any financial decision.',
      'You use all data, scores, and analysis provided by ChainLens AI entirely at your own risk.',
    ],
  },
  {
    label: '04 — Payments & Subscriptions',
    heading: 'Payments & Subscriptions',
    body: [
      'ChainLens AI offers subscription plans billed on a monthly basis. All plans include a 7-day free trial. You will not be charged until your trial period ends.',
      'After the trial period, your subscription will automatically renew each month. You may cancel at any time from your account settings.',
      'Refunds are not provided after the 7-day trial period has elapsed. If you cancel, you will retain access to your plan until the end of the current billing cycle.',
      'We reserve the right to update pricing at any time. Existing subscribers will be notified at least 30 days in advance of any price changes.',
    ],
  },
  {
    label: '05 — Privacy',
    heading: 'Privacy',
    body: [
      'ChainLens AI collects your email address solely for authentication and account management purposes. We do not collect, store, or process any additional personal information beyond what is necessary to provide the service.',
      'We do not sell, rent, lease, or share your personal data with any third parties for marketing or commercial purposes.',
      'Wallet addresses and token contracts you scan are used only to fulfil your query in real time. We do not store or associate these with your account beyond session activity logs.',
      'By using ChainLens AI, you agree to the storage and processing of your email address as described above. You may request deletion of your account and associated data at any time by contacting us.',
    ],
  },
  {
    label: '06 — Acceptable Use',
    heading: 'Acceptable Use',
    body: [
      'You may not use ChainLens AI to scrape, harvest, or systematically extract data from the platform by any automated means including bots, crawlers, or scripts.',
      'You may not abuse, overload, or attempt to circumvent rate limits on any API, AI endpoint, or data service provided by ChainLens AI.',
      'You may not resell, redistribute, or sublicense any data, analysis, or content obtained from ChainLens AI without prior written permission.',
      'You may not use ChainLens AI for any unlawful purpose, including but not limited to market manipulation, fraud, or any activity that violates applicable laws and regulations in your jurisdiction.',
      'Violation of these terms may result in immediate suspension or termination of your account without refund.',
    ],
  },
  {
    label: '07 — Limitation of Liability',
    heading: 'Limitation of Liability',
    body: [
      'To the fullest extent permitted by applicable law, ChainLens AI, its founders, employees, contractors, and affiliates shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising from your use of, or inability to use, the platform.',
      'This includes but is not limited to financial losses, loss of profits, loss of data, or any damages resulting from reliance on information provided by the platform or CLARK AI.',
      'ChainLens AI is provided on an "as is" and "as available" basis without warranties of any kind, either express or implied.',
      'Some jurisdictions do not allow the exclusion of certain warranties or limitation of liability. In such cases, liability is limited to the maximum extent permitted by law.',
    ],
  },
]

export default function TermsPage() {
  return (
    <>
      <style>{`
        @keyframes terms-fade-in {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .terms-section {
          animation: terms-fade-in 0.5s ease-out both;
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
              Terms of Service &amp; Privacy Policy
            </h1>

            <p style={{ fontSize: '15px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.7, margin: '0 0 20px', maxWidth: '560px' }}>
              By using ChainLens AI you agree to these terms. Please read them carefully.
              Last updated: April 2026.
            </p>

            {/* Divider */}
            <div style={{ height: '1px', background: 'linear-gradient(90deg, rgba(45,212,191,0.30), rgba(139,92,246,0.20), transparent)' }} />
          </div>

          {/* Sections */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '56px' }}>
            {SECTIONS.map((sec, i) => (
              <div
                key={sec.label}
                className="terms-section"
                style={{ animationDelay: `${i * 0.06}s` }}
              >
                {/* Section label */}
                <div style={{
                  fontSize: '9px', fontWeight: 700, letterSpacing: '0.22em',
                  color: '#2DD4BF', textTransform: 'uppercase',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  marginBottom: '10px',
                }}>
                  {sec.label}
                </div>

                {/* Section heading */}
                <h2 style={{
                  fontSize: '20px', fontWeight: 700,
                  color: '#f1f5f9', letterSpacing: '-0.01em',
                  margin: '0 0 18px', lineHeight: 1.2,
                }}>
                  {sec.heading}
                </h2>

                {/* Body paragraphs */}
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

                {/* Bottom rule */}
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
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.28)', lineHeight: 1.7, margin: '0 0 20px' }}>
              If you have any questions about these terms, please contact us via{' '}
              <Link href="https://x.com/chainlens__ai" target="_blank" rel="noopener noreferrer"
                style={{ color: '#2DD4BF', textDecoration: 'none' }}>
                @chainlens__ai
              </Link>{' '}
              on X or through the Telegram group.
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

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Fraunces } from 'next/font/google'
import Navbar from '@/components/Navbar'
import AffiliateHubNav from '@/components/AffiliateHubNav'
import { supabase } from '@/lib/supabaseClient'

const fraunces = Fraunces({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-fraunces', display: 'swap' })

export default function AffiliatePage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSignedIn(Boolean(data.session?.access_token))
    })
    return () => { active = false }
  }, [])

  return <div className={fraunces.variable} style={{ minHeight: '100vh', background: '#07070f', color: '#e7e9ee' }}>
    <Navbar />
    <AffiliateHubNav />
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '72px 28px 120px' }}>
      <p style={{ color: '#2DD4BF', font: '600 11px var(--font-plex-mono,monospace)', letterSpacing: '.16em', textTransform: 'uppercase' }}>ChainLens Affiliate Program</p>
      <h1 style={{ maxWidth: 760, margin: '16px 0 20px', font: '500 clamp(38px,7vw,72px)/1.02 var(--font-fraunces),serif', letterSpacing: '-.035em' }}>
        Your audience. <span style={{ color: '#2DD4BF' }}>Recurring rewards.</span>
      </h1>
      <p style={{ maxWidth: 650, color: '#9aa4b5', fontSize: 17, lineHeight: 1.75 }}>
        Share ChainLens and earn 20% recurring commission from qualified subscriptions. Every signed-in member gets a unique, live referral link automatically—no application required.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 32 }}>
        {signedIn === true ? (
          <Link href="/affiliate/dashboard" style={primary}>Open your live link →</Link>
        ) : signedIn === false ? (
          <Link href="/login" style={primary}>Sign in to get your link →</Link>
        ) : (
          <span style={{ ...primary, opacity: .55 }}>Checking your account…</span>
        )}
        <Link href="/affiliate/dashboard" style={secondary}>Affiliate dashboard</Link>
      </div>

      <section style={{ marginTop: 76, borderTop: '1px solid rgba(226,232,240,.13)', borderBottom: '1px solid rgba(226,232,240,.13)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))' }}>
        {[
          ['01', 'Sign in', 'Use your existing ChainLens account.'],
          ['02', 'Get your link', 'Your approved affiliate account and unique link are created automatically.'],
          ['03', 'Share and earn', 'First-touch attribution tracks qualified subscriptions and recurring commission.'],
        ].map(([n, title, body]) => <article key={n} style={{ padding: '28px 24px', borderRight: '1px solid rgba(226,232,240,.1)' }}>
          <span style={{ color: '#2DD4BF', font: '600 11px var(--font-plex-mono,monospace)' }}>{n}</span>
          <h2 style={{ margin: '14px 0 8px', fontSize: 18 }}>{title}</h2>
          <p style={{ margin: 0, color: '#8b93a3', fontSize: 14, lineHeight: 1.65 }}>{body}</p>
        </article>)}
      </section>

      <section style={{ marginTop: 56, maxWidth: 720 }}>
        <h2 style={{ font: '500 30px var(--font-fraunces),serif', marginBottom: 16 }}>Clear terms</h2>
        <p style={copy}>Payouts are processed manually in USDC on Base, typically within 24–72 hours after funds reach us. This timing applies to payouts—not access to your referral link.</p>
        <p style={copy}>First-touch attribution and existing commission calculations remain unchanged. We may suspend or reject accounts for abuse; suspended or rejected links stop attributing referrals.</p>
      </section>
    </main>
  </div>
}

const primary: React.CSSProperties = { display: 'inline-flex', padding: '14px 22px', borderRadius: 3, background: '#2DD4BF', color: '#04241f', fontWeight: 800, textDecoration: 'none' }
const secondary: React.CSSProperties = { display: 'inline-flex', padding: '13px 21px', borderRadius: 3, border: '1px solid rgba(226,232,240,.2)', color: '#e7e9ee', fontWeight: 650, textDecoration: 'none' }
const copy: React.CSSProperties = { color: '#8b93a3', lineHeight: 1.75, fontSize: 14 }

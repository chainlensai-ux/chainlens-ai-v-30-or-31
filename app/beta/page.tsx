'use client'

import Link from 'next/link'
import Navbar from '@/components/Navbar'

export default function BetaPage() {
  return (
    <>
      <style>{`
        .beta-closed-page {
          background:
            radial-gradient(ellipse 900px 600px at 10% 0%, rgba(45,212,191,.08) 0%, transparent 55%),
            radial-gradient(ellipse 700px 500px at 90% 10%, rgba(139,92,246,.07) 0%, transparent 55%),
            #04060d;
          min-height: 100vh;
        }
      `}</style>
      <Navbar />
      <div className="beta-closed-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 20px 120px' }}>
        <div style={{ maxWidth: '640px', width: '100%', textAlign: 'center' }}>

          {/* Status badge */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '5px 16px', borderRadius: '999px', background: 'rgba(45,212,191,.07)', border: '1px solid rgba(45,212,191,.22)', marginBottom: '32px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2DD4BF', flexShrink: 0 }} />
            <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.18em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono, monospace)' }}>
              V3 BETA — CLOSED
            </span>
          </div>

          {/* Headline */}
          <h1 style={{ margin: '0 0 18px', fontSize: 'clamp(28px,5vw,44px)', fontWeight: 800, letterSpacing: '-.02em', color: '#f1f5f9', lineHeight: 1.1 }}>
            ChainLens V3 Beta<br />is now closed.
          </h1>

          {/* Subcopy */}
          <p style={{ margin: '0 0 14px', fontSize: '16px', color: '#94a3b8', lineHeight: 1.75 }}>
            Thank you to everyone who tested ChainLens V3, reported bugs, shared security feedback, and helped improve the platform.
          </p>
          <p style={{ margin: '0 0 44px', fontSize: '15px', color: '#64748b', lineHeight: 1.7 }}>
            Public access is moving into the next release phase. The platform is available through standard sign-in and subscription.
          </p>

          {/* CTAs */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '56px' }}>
            <Link href="/terminal" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '13px 28px', borderRadius: '10px', fontWeight: 700, fontSize: '14px', letterSpacing: '.04em', background: 'linear-gradient(135deg,#2DD4BF,#8b5cf6)', color: '#04060d', textDecoration: 'none', boxShadow: '0 4px 20px rgba(45,212,191,.2)' }}>
              Go to Terminal
            </Link>
            <Link href="/pricing" style={{ display: 'inline-flex', alignItems: 'center', padding: '13px 24px', borderRadius: '10px', fontWeight: 600, fontSize: '14px', border: '1px solid rgba(148,163,184,.22)', color: '#cbd5e1', background: 'rgba(255,255,255,.025)', textDecoration: 'none' }}>
              View Pricing
            </Link>
            <Link href="/contact" style={{ display: 'inline-flex', alignItems: 'center', padding: '13px 24px', borderRadius: '10px', fontWeight: 600, fontSize: '14px', border: '1px solid rgba(148,163,184,.12)', color: '#64748b', background: 'transparent', textDecoration: 'none' }}>
              Contact Support
            </Link>
          </div>

          {/* Thank-you card */}
          <div style={{ background: 'linear-gradient(145deg,rgba(13,21,40,.75),rgba(5,8,18,.9))', border: '1px solid rgba(45,212,191,.14)', borderRadius: '18px', padding: '28px 30px', textAlign: 'left' }}>
            <p style={{ margin: '0 0 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '.18em', color: '#2DD4BF', fontFamily: 'var(--font-plex-mono, monospace)' }}>BETA ACKNOWLEDGEMENT</p>
            <h2 style={{ margin: '0 0 12px', fontSize: '17px', fontWeight: 700, color: '#f1f5f9' }}>Thank you to the V3 beta testers.</h2>
            <p style={{ margin: 0, fontSize: '13px', color: '#64748b', lineHeight: 1.8 }}>
              Your bug reports, security observations, and feature feedback directly shaped the stability, design, and direction of ChainLens. The product is better because of the time you put in during beta.
            </p>
          </div>

        </div>
      </div>
    </>
  )
}

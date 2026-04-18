import Link from 'next/link'
import Image from 'next/image'

export default function BetaEndedPage() {
  return (
    <div style={{
      minHeight: '100vh',
      width: '100%',
      background: '#06060a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 16px',
      fontFamily: 'var(--font-inter), Inter, sans-serif',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Background glows */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{
          position: 'absolute', top: '30%', left: '20%',
          width: '500px', height: '400px', borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(45,212,191,0.07) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }} />
        <div style={{
          position: 'absolute', top: '25%', right: '18%',
          width: '460px', height: '380px', borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(139,92,246,0.08) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }} />
      </div>

      {/* Card */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        width: '100%',
        maxWidth: '460px',
        background: '#080c14',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '20px',
        padding: '48px 40px 40px',
        textAlign: 'center',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.04) inset, 0 32px 80px rgba(0,0,0,0.55)',
      }}>
        {/* Top accent line */}
        <div style={{
          position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.45), rgba(139,92,246,0.45), transparent)',
        }} />

        {/* Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '28px' }}>
          <Image src="/cl-logo.png" alt="ChainLens AI" width={64} height={64} />
        </div>

        {/* Badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '7px',
          background: 'rgba(139,92,246,0.10)',
          border: '1px solid rgba(139,92,246,0.25)',
          borderRadius: '99px', padding: '5px 14px',
          marginBottom: '20px',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,0.8)',
            display: 'inline-block',
          }} />
          <span style={{
            fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em',
            color: '#a78bfa', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
            textTransform: 'uppercase',
          }}>
            Beta Period
          </span>
        </div>

        {/* Heading */}
        <h1 style={{
          fontSize: '26px', fontWeight: 800, lineHeight: 1.2,
          color: '#f1f5f9', margin: '0 0 14px',
          letterSpacing: '-0.01em',
        }}>
          ChainLens Beta<br />
          <span style={{
            background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 60%, #ec4899 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>Has Ended</span>
        </h1>

        {/* Body text */}
        <p style={{
          fontSize: '14px', color: 'rgba(255,255,255,0.40)',
          lineHeight: 1.7, margin: '0 0 8px',
        }}>
          Thanks for testing with us.
        </p>
        <p style={{
          fontSize: '14px', color: 'rgba(255,255,255,0.35)',
          lineHeight: 1.7, margin: '0 0 36px',
        }}>
          We&apos;re preparing the next build — stay tuned.
        </p>

        {/* CTA */}
        <Link href="/" style={{
          display: 'inline-block',
          padding: '11px 28px', borderRadius: '10px',
          background: 'rgba(45,212,191,0.10)',
          border: '1px solid rgba(45,212,191,0.25)',
          color: '#2DD4BF', fontSize: '13px', fontWeight: 700,
          textDecoration: 'none', letterSpacing: '0.07em', textTransform: 'uppercase',
          fontFamily: 'var(--font-inter), Inter, sans-serif',
          transition: 'background 0.15s, border-color 0.15s',
        }}>
          Back to Homepage
        </Link>

        {/* Bottom accent line */}
        <div style={{
          position: 'absolute', bottom: 0, left: '15%', right: '15%', height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.30), rgba(45,212,191,0.30), transparent)',
        }} />
      </div>
    </div>
  )
}

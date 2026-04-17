'use client';

import Image from 'next/image';

export default function AuthPage() {
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

      {/* Radial glow — teal left, purple right */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{
          position: 'absolute',
          top: '30%', left: '20%',
          width: '500px', height: '400px',
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(45,212,191,0.09) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }} />
        <div style={{
          position: 'absolute',
          top: '25%', right: '18%',
          width: '460px', height: '380px',
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(139,92,246,0.10) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }} />
      </div>

      {/* Card */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        width: '100%',
        maxWidth: '400px',
        background: '#080c14',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '20px',
        padding: '40px 36px 32px',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.04) inset, 0 32px 80px rgba(0,0,0,0.55)',
      }}>

        {/* Top gradient accent line */}
        <div style={{
          position: 'absolute',
          top: 0, left: '10%', right: '10%',
          height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.45), rgba(139,92,246,0.45), transparent)',
          borderRadius: '1px',
        }} />

        {/* Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '52px', height: '52px', borderRadius: '14px',
            background: 'linear-gradient(135deg, rgba(45,212,191,0.15), rgba(139,92,246,0.18))',
            border: '1px solid rgba(45,212,191,0.22)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 24px rgba(45,212,191,0.14), 0 0 14px rgba(139,92,246,0.10)',
          }}>
            <Image src="/cl-logo.png" alt="ChainLens" width={32} height={32} style={{ borderRadius: '6px' }} />
          </div>
        </div>

        {/* Heading */}
        <h1 style={{
          textAlign: 'center',
          fontSize: '22px',
          fontWeight: 600,
          color: '#ffffff',
          letterSpacing: '-0.01em',
          marginBottom: '6px',
        }}>
          Sign In
        </h1>
        <p style={{
          textAlign: 'center',
          fontSize: '13px',
          color: '#94a3b8',
          marginBottom: '28px',
        }}>
          Access your ChainLens terminal
        </p>

        {/* Social buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>

          {/* Google */}
          <button
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: '10px', padding: '11px 16px', borderRadius: '11px',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
              color: '#e2e8f0', fontSize: '13px', fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)';
            }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Continue with Google
          </button>

          {/* Apple */}
          <button
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: '10px', padding: '11px 16px', borderRadius: '11px',
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
              color: '#e2e8f0', fontSize: '13px', fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)';
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff">
              <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.38.07 2.34.74 3.17.8 1.2-.21 2.36-.91 3.64-.84 1.55.1 2.72.69 3.46 1.77-3.18 1.87-2.44 6.02.74 7.23-.62 1.37-1.41 2.71-3.01 3.92zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
            </svg>
            Continue with Apple
          </button>
        </div>

        {/* OR divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
          <span style={{ fontSize: '11px', color: '#475569', fontWeight: 500, letterSpacing: '0.06em' }}>OR</span>
          <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
        </div>

        {/* Email input */}
        <div style={{ marginBottom: '8px' }}>
          <input
            type="email"
            placeholder="Email address"
            style={{
              width: '100%', padding: '11px 14px', borderRadius: '11px',
              background: 'rgba(5,8,22,0.60)', border: '1px solid rgba(255,255,255,0.09)',
              color: '#e2e8f0', fontSize: '13px', fontFamily: 'inherit',
              outline: 'none', boxSizing: 'border-box',
              transition: 'border-color 0.15s',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'rgba(45,212,191,0.40)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)')}
          />
        </div>

        {/* Forgot password */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '20px' }}>
          <button
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '12px', color: '#475569', fontFamily: 'inherit',
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = '#94a3b8')}
            onMouseLeave={e => (e.currentTarget.style.color = '#475569')}
          >
            Forgot password?
          </button>
        </div>

        {/* Continue button */}
        <button
          style={{
            width: '100%', padding: '12px 16px', borderRadius: '11px',
            background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 100%)',
            border: 'none', color: '#ffffff', fontSize: '13px', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.01em',
            boxShadow: '0 0 24px rgba(45,212,191,0.20), 0 0 16px rgba(139,92,246,0.16)',
            transition: 'opacity 0.15s, box-shadow 0.15s',
            marginBottom: '24px',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.opacity = '0.92';
            e.currentTarget.style.boxShadow = '0 0 36px rgba(45,212,191,0.32), 0 0 24px rgba(139,92,246,0.24)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.boxShadow = '0 0 24px rgba(45,212,191,0.20), 0 0 16px rgba(139,92,246,0.16)';
          }}
        >
          Continue with Email
        </button>

        {/* Sign up link */}
        <p style={{ textAlign: 'center', fontSize: '12px', color: '#475569', marginBottom: '0' }}>
          {"Don't have an account? "}
          <span style={{
            background: 'linear-gradient(90deg, #2DD4BF, #8b5cf6)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            fontWeight: 600,
            cursor: 'pointer',
          }}>
            Sign Up
          </span>
        </p>

        {/* Bottom gradient accent line */}
        <div style={{
          position: 'absolute',
          bottom: 0, left: '15%', right: '15%',
          height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.30), rgba(45,212,191,0.30), transparent)',
        }} />

      </div>
    </div>
  );
}

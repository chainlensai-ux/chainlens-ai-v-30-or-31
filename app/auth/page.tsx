'use client';

import Image from 'next/image';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

type Mode = 'signin' | 'signup';

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [authCheckLoading, setAuthCheckLoading] = useState(true);
  const [error, setError] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const oauthErr = params.get('error_description') || params.get('error');
    return oauthErr ? decodeURIComponent(oauthErr.replace(/\+/g, ' ')) : null;
  });
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function checkExistingUser() {
      const { data, error: sessionError } = await supabase.auth.getSession();

      if (!isMounted) return;

      if (!sessionError && data.session?.user) {
        router.replace('/terminal');
        return;
      }

      setAuthCheckLoading(false);
    }

    checkExistingUser();

    // Handle OAuth callback and email-confirm sign-ins
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        router.replace('/terminal');
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [router]);

  async function handleGoogle() {
    setError(null);
    // redirectTo must point back to this page so the Supabase client
    // can pick up the PKCE code and fire onAuthStateChange → SIGNED_IN
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (oauthError) setError(oauthError.message);
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    if (mode === 'signin') {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
      } else {
        router.replace('/terminal');
      }
    } else {
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (signUpError) {
        setError(signUpError.message);
      } else {
        setSuccess('Check your email to confirm your account.');
      }
    }
    setLoading(false);
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '11px 14px',
    borderRadius: '11px',
    background: 'rgba(5,8,22,0.60)',
    border: '1px solid rgba(255,255,255,0.09)',
    color: '#e2e8f0',
    fontSize: '13px',
    fontFamily: 'var(--font-inter), Inter, sans-serif',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  };

  if (authCheckLoading) {
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
      }}>
        <div style={{
          width: '100%',
          maxWidth: '400px',
          background: '#080c14',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '20px',
          padding: '28px 24px',
          color: 'rgba(255,255,255,0.60)',
          textAlign: 'center',
          fontSize: '13px',
        }}>
          Checking authentication status...
        </div>
      </div>
    );
  }

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
      <style>{`
        @keyframes auth-grid-drift {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(0, 30px, 0); }
        }
        @keyframes auth-orbit-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes auth-horizon-breathe {
          0%,100% { opacity: 0.35; transform: scaleX(1); }
          50% { opacity: 0.55; transform: scaleX(1.04); }
        }
      `}</style>
      <div
        style={{
          position: 'absolute',
          inset: '-10%',
          zIndex: 0,
          pointerEvents: 'none',
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.06) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(circle at center, black 24%, transparent 90%)',
          opacity: 0.26,
          animation: 'auth-grid-drift 20s linear infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: '18% 10%',
          borderRadius: '9999px',
          border: '1px solid rgba(45,212,191,0.10)',
          boxShadow: '0 0 120px rgba(45,212,191,0.10)',
          zIndex: 0,
          pointerEvents: 'none',
          animation: 'auth-orbit-spin 36s linear infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: '22% 14%',
          borderRadius: '9999px',
          border: '1px solid rgba(139,92,246,0.12)',
          zIndex: 0,
          pointerEvents: 'none',
          animation: 'auth-orbit-spin 42s linear infinite reverse',
        }}
      />
      <div style={{
        position: 'absolute',
        left: '8%',
        right: '8%',
        top: '55%',
        height: '1px',
        background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.44), rgba(139,92,246,0.34), transparent)',
        zIndex: 0,
        pointerEvents: 'none',
        filter: 'blur(0.2px)',
        animation: 'auth-horizon-breathe 7s ease-in-out infinite',
      }} />

      {/* Radial glows */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', top: '28%', left: '16%', width: '560px', height: '440px', borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(45,212,191,0.14) 0%, transparent 72%)', filter: 'blur(46px)' }} />
        <div style={{ position: 'absolute', top: '20%', right: '14%', width: '520px', height: '410px', borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(139,92,246,0.16) 0%, transparent 72%)', filter: 'blur(46px)' }} />
      </div>

      {/* Back to home */}
      <Link href="/" style={{
        position: 'absolute', top: '20px', left: '24px',
        display: 'flex', alignItems: 'center', gap: '6px',
        color: 'rgba(255,255,255,0.40)',
        fontSize: '12px', fontWeight: 500,
        textDecoration: 'none',
        fontFamily: 'var(--font-inter), Inter, sans-serif',
        transition: 'color 0.15s',
        zIndex: 2,
      }}
        onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.80)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.40)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back to home
      </Link>

      {/* Card */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        width: '100%',
        maxWidth: '400px',
        background: 'linear-gradient(180deg, rgba(10,14,28,0.87) 0%, rgba(8,12,20,0.82) 100%)',
        border: '1px solid rgba(148,163,184,0.22)',
        borderRadius: '24px',
        padding: '42px 34px 30px',
        backdropFilter: 'blur(30px)',
        WebkitBackdropFilter: 'blur(30px)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.05) inset, 0 35px 85px rgba(0,0,0,0.62), 0 14px 44px rgba(45,212,191,0.08), 0 10px 42px rgba(139,92,246,0.08)',
      }}>

        {/* Top accent line */}
        <div style={{ position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.45), rgba(139,92,246,0.45), transparent)' }} />

        {/* Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
          <Image src="/cl-logo.png" alt="ChainLens" width={72} height={72} />
        </div>
        <p style={{ textAlign: 'center', marginTop: 0, marginBottom: '22px', color: 'rgba(226,232,240,0.72)', fontSize: '12px', letterSpacing: '0.02em' }}>
          Access your ChainLens terminal.
        </p>

        {/* Mode tabs */}
        <div style={{ display: 'flex', background: 'rgba(255,255,255,0.04)', borderRadius: '10px', padding: '3px', marginBottom: '24px' }}>
          {(['signin', 'signup'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); setSuccess(null); }}
              style={{
                flex: 1,
                padding: '9px',
                borderRadius: '8px',
                border: 'none',
                fontSize: '13px',
                fontWeight: 500,
                fontFamily: 'inherit',
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
                background: mode === m ? 'linear-gradient(180deg, rgba(148,163,184,0.22), rgba(148,163,184,0.10))' : 'transparent',
                color: mode === m ? '#f1f5f9' : '#64748b',
              }}
            >
              {m === 'signin' ? 'Sign In' : 'Sign Up'}
            </button>
          ))}
        </div>

        {/* Google OAuth */}
        <div style={{ marginBottom: '20px' }}>
          <button
            onClick={handleGoogle}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: '10px', padding: '11px 16px', borderRadius: '11px',
              background: 'linear-gradient(180deg, rgba(248,250,252,0.12) 0%, rgba(248,250,252,0.06) 100%)', border: '1px solid rgba(248,250,252,0.26)',
              color: '#f8fafc', fontSize: '13px', fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(180deg, rgba(248,250,252,0.12) 0%, rgba(248,250,252,0.08) 100%)'; e.currentTarget.style.borderColor = 'rgba(248,250,252,0.36)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(180deg, rgba(248,250,252,0.08) 0%, rgba(248,250,252,0.05) 100%)'; e.currentTarget.style.borderColor = 'rgba(248,250,252,0.20)'; }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Continue with Google
          </button>
        </div>

        {/* OR divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
          <span style={{ fontSize: '11px', color: '#475569', fontWeight: 500, letterSpacing: '0.06em' }}>OR</span>
          <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
        </div>

        {/* Email / password form */}
        <form onSubmit={handleEmailSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.58)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.15), 0 0 22px rgba(139,92,246,0.14)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = 'none'; }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.58)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.15), 0 0 22px rgba(139,92,246,0.14)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = 'none'; }}
          />

          {/* Forgot password — sign in only */}
          {mode === 'signin' && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#475569', fontFamily: 'inherit', transition: 'color 0.15s' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#94a3b8')}
                onMouseLeave={e => (e.currentTarget.style.color = '#475569')}
              >
                Forgot password?
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              padding: '10px 12px', borderRadius: '9px',
              background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.22)',
              color: '#fca5a5', fontSize: '12px', lineHeight: 1.5,
              display: 'flex', alignItems: 'flex-start', gap: '8px',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: '1px' }}>
                <circle cx="12" cy="12" r="10" stroke="#fca5a5" strokeWidth="2"/>
                <path d="M12 8v4M12 16h.01" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              {error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div style={{
              padding: '10px 12px', borderRadius: '9px',
              background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.22)',
              color: '#5eead4', fontSize: '12px', lineHeight: 1.5,
              display: 'flex', alignItems: 'flex-start', gap: '8px',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: '1px' }}>
                <circle cx="12" cy="12" r="10" stroke="#5eead4" strokeWidth="2"/>
                <path d="M8 12l3 3 5-5" stroke="#5eead4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {success}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '12px 16px', borderRadius: '11px',
              background: loading ? 'rgba(139,92,246,0.35)' : 'linear-gradient(135deg, #2DD4BF 0%, #0ea5e9 42%, #8b5cf6 100%)',
              border: 'none', color: '#ffffff', fontSize: '13px', fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              boxShadow: loading ? 'none' : '0 0 30px rgba(45,212,191,0.24), 0 0 24px rgba(139,92,246,0.20), 0 8px 24px rgba(8,14,28,0.55)',
              transition: 'opacity 0.15s, box-shadow 0.15s, transform 0.15s',
              marginTop: '4px',
            }}
            onMouseEnter={e => { if (!loading) { e.currentTarget.style.opacity = '0.96'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            {loading ? 'Signing in…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
        {/* Bottom gradient accent line */}
        <div style={{ position: 'absolute', bottom: 0, left: '15%', right: '15%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.30), rgba(45,212,191,0.30), transparent)' }} />
      </div>
    </div>
  );
}

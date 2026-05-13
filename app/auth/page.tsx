'use client';

import Image from 'next/image';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

type Mode = 'signin' | 'signup' | 'forgot';

const BANNED_PASSWORDS = new Set([
  '123456','12345678','123456789','password','password123',
  'qwerty','qwerty123','chainlens','chainlens123','letmein','admin123',
])

function checkPolicy(pw: string) {
  return {
    minLen: pw.length >= 10,
    hasUpper: /[A-Z]/.test(pw),
    hasLower: /[a-z]/.test(pw),
    hasNum: /[0-9]/.test(pw),
    hasSpecial: /[^A-Za-z0-9]/.test(pw),
    notBanned: !BANNED_PASSWORDS.has(pw.toLowerCase()),
  }
}

function getStrength(pw: string): 'weak' | 'medium' | 'strong' {
  if (!pw) return 'weak'
  const c = checkPolicy(pw)
  if (c.notBanned && c.minLen && c.hasUpper && c.hasLower && c.hasNum && c.hasSpecial) return 'strong'
  const met = [c.minLen, c.hasUpper, c.hasLower, c.hasNum, c.hasSpecial].filter(Boolean).length
  return met >= 3 ? 'medium' : 'weak'
}

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
  const [confirmPassword, setConfirmPassword] = useState('');

  const policy = checkPolicy(password);
  const strength = getStrength(password);
  const policyPassed = policy.minLen && policy.hasUpper && policy.hasLower && policy.hasNum && policy.hasSpecial && policy.notBanned;
  const confirmMismatch = mode === 'signup' && confirmPassword.length > 0 && confirmPassword !== password;
  const submitDisabled = loading || !email.trim() || (mode === 'signup' && (!policyPassed || password !== confirmPassword));

  useEffect(() => {
    let isMounted = true;

    async function checkExistingUser() {
      const { data, error: sessionError } = await supabase.auth.getSession();

      if (!isMounted) return;

      if (!sessionError && data.session?.user) {
        const user = data.session.user;
        const provider = user.app_metadata?.provider;
        if (provider === 'email' && !user.email_confirmed_at) {
          // Unverified email session — clear it and stay on auth page
          await supabase.auth.signOut();
          setAuthCheckLoading(false);
          return;
        }
        router.replace('/terminal');
        return;
      }

      setAuthCheckLoading(false);
    }

    checkExistingUser();

    // Handle OAuth callback and email-confirm sign-ins
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        const provider = session.user.app_metadata?.provider;
        if (provider === 'email' && !session.user.email_confirmed_at) {
          Promise.resolve().then(() => supabase.auth.signOut());
          return;
        }
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

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    const cleanEmail = email.trim().toLowerCase();
    // Always show success to avoid leaking whether email exists
    await supabase.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSuccess('If this email has an account, a reset link has been sent. Check your inbox.');
    setLoading(false);
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    const cleanEmail = email.trim().toLowerCase();

    if (mode === 'signin') {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: cleanEmail, password }),
        });
        const data: { ok?: boolean; session?: { access_token: string; refresh_token: string }; error?: string; message?: string } = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setError(data.message ?? 'Too many login attempts. Please wait before trying again.');
        } else if (res.status === 403 && data.error === 'unverified') {
          setError(data.message ?? 'Please verify your email before signing in. Check your inbox for a confirmation link.');
        } else if (!res.ok) {
          setError('Email or password is incorrect. Try again or reset your password.');
        } else if (data.session) {
          // Establish session in browser — onAuthStateChange fires SIGNED_IN → redirect
          await supabase.auth.setSession(data.session);
        }
      } catch {
        setError('Network error — please check your connection and try again.');
      }
    } else {
      if (!policyPassed) {
        setError('Use at least 10 characters with uppercase, lowercase, a number, and a symbol.');
        setLoading(false);
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        setLoading(false);
        return;
      }
      try {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: cleanEmail, password }),
        });
        const data: { ok?: boolean; requiresEmailVerification?: boolean; message?: string } = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.message || 'Unable to create account. Please try again.');
        } else if (data.requiresEmailVerification !== false) {
          setSuccess('Account created! Check your email to verify your account before signing in.');
        } else {
          setSuccess('Account created. You can now sign in.');
        }
      } catch {
        setError('Unable to create account. Please try again.');
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
              onClick={() => { setMode(m); setError(null); setSuccess(null); setConfirmPassword(''); }}
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
        {mode !== 'forgot' && <form onSubmit={handleEmailSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
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

          {/* Password strength — signup only */}
          {mode === 'signup' && password.length > 0 && (
            <div style={{ marginTop: '2px' }}>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '5px' }}>
                {(['weak', 'medium', 'strong'] as const).map((lvl, i) => {
                  const idx = strength === 'weak' ? 0 : strength === 'medium' ? 1 : 2;
                  const barColors = ['#ef4444', '#f59e0b', '#2DD4BF'];
                  return (
                    <div key={lvl} style={{
                      flex: 1, height: '3px', borderRadius: '2px',
                      background: idx >= i ? barColors[i] : 'rgba(255,255,255,0.08)',
                      transition: 'background 0.2s',
                    }} />
                  );
                })}
                <span style={{
                  fontSize: '11px', fontWeight: 600, marginLeft: '6px', minWidth: '40px',
                  color: strength === 'strong' ? '#2DD4BF' : strength === 'medium' ? '#f59e0b' : '#ef4444',
                }}>
                  {strength === 'strong' ? 'Strong' : strength === 'medium' ? 'Medium' : 'Weak'}
                </span>
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 6px',
                padding: '7px 10px', background: 'rgba(255,255,255,0.03)',
                borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)',
              }}>
                {[
                  { label: '10+ characters', met: policy.minLen },
                  { label: 'Uppercase (A–Z)', met: policy.hasUpper },
                  { label: 'Lowercase (a–z)', met: policy.hasLower },
                  { label: 'Number (0–9)', met: policy.hasNum },
                  { label: 'Special character', met: policy.hasSpecial },
                ].map(({ label, met }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: met ? '#2DD4BF' : 'rgba(255,255,255,0.35)', lineHeight: 1.7 }}>
                    {met
                      ? <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L19 7" stroke="#2DD4BF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      : <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" fill="rgba(255,255,255,0.22)"/></svg>
                    }
                    {label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Confirm password — signup only */}
          {mode === 'signup' && (
            <>
              <input
                type="password"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                style={inputStyle}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.58)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.15), 0 0 22px rgba(139,92,246,0.14)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = 'none'; }}
              />
              {confirmMismatch && (
                <div style={{ fontSize: '11px', color: '#fca5a5', marginTop: '-4px', paddingLeft: '2px' }}>
                  Passwords do not match.
                </div>
              )}
            </>
          )}

          {/* Forgot password — sign in only */}
          {mode === 'signin' && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(null); setSuccess(null); setConfirmPassword(''); }}
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
            disabled={submitDisabled}
            style={{
              width: '100%', padding: '12px 16px', borderRadius: '11px',
              background: submitDisabled ? 'rgba(139,92,246,0.35)' : 'linear-gradient(135deg, #2DD4BF 0%, #0ea5e9 42%, #8b5cf6 100%)',
              border: 'none', color: '#ffffff', fontSize: '13px', fontWeight: 600,
              cursor: submitDisabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              boxShadow: submitDisabled ? 'none' : '0 0 30px rgba(45,212,191,0.24), 0 0 24px rgba(139,92,246,0.20), 0 8px 24px rgba(8,14,28,0.55)',
              transition: 'opacity 0.15s, box-shadow 0.15s, transform 0.15s',
              marginTop: '4px',
            }}
            onMouseEnter={e => { if (!submitDisabled) { e.currentTarget.style.opacity = '0.96'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            {loading ? (mode === 'signup' ? 'Creating…' : 'Signing in…') : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>}

        {/* Forgot password inline form */}
        {mode === 'forgot' && (
          <form onSubmit={handleForgotPassword} style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' }}>
            <div style={{ height: '1px', background: 'rgba(255,255,255,0.07)', margin: '0 0 4px' }} />
            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8', textAlign: 'center' }}>
              Enter your email and we&apos;ll send a reset link.
            </p>
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              style={inputStyle}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.58)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.15)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = 'none'; }}
            />
            {error && (
              <div style={{ padding: '10px 12px', borderRadius: '9px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.22)', color: '#fca5a5', fontSize: '12px', lineHeight: 1.5 }}>
                {error}
              </div>
            )}
            {success && (
              <div style={{ padding: '10px 12px', borderRadius: '9px', background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.22)', color: '#5eead4', fontSize: '12px', lineHeight: 1.5 }}>
                {success}
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{ width: '100%', padding: '12px 16px', borderRadius: '11px', background: loading ? 'rgba(139,92,246,0.35)' : 'linear-gradient(135deg, #2DD4BF 0%, #0ea5e9 42%, #8b5cf6 100%)', border: 'none', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: '4px' }}
            >
              {loading ? 'Sending…' : 'Send Reset Link'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('signin'); setError(null); setSuccess(null); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#475569', fontFamily: 'inherit', textAlign: 'center', marginTop: '2px' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#94a3b8')}
              onMouseLeave={e => (e.currentTarget.style.color = '#475569')}
            >
              ← Back to sign in
            </button>
          </form>
        )}

        {/* Beta tester hint */}
        {mode === 'signin' && (
          <p style={{ marginTop: '18px', marginBottom: 0, textAlign: 'center', fontSize: '11px', color: '#334155', lineHeight: 1.6 }}>
            New beta tester? Use <button type="button" onClick={() => { setMode('signup'); setError(null); setSuccess(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontFamily: 'inherit', fontSize: '11px', textDecoration: 'underline', padding: 0 }}>Sign Up</button> or Continue with Google above.
          </p>
        )}
        {/* Bottom gradient accent line */}
        <div style={{ position: 'absolute', bottom: 0, left: '15%', right: '15%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.30), rgba(45,212,191,0.30), transparent)' }} />
      </div>
    </div>
  );
}

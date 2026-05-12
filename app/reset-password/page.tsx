'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

type Status = 'loading' | 'ready' | 'success' | 'error';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    async function init() {
      const url = window.location.href;
      const hasCode = /[?&]code=/.test(url);

      if (hasCode) {
        const { error: exchError } = await supabase.auth.exchangeCodeForSession(url);
        if (!active) return;
        if (exchError) {
          setStatus('error');
          setError('This reset link is invalid or has expired. Please request a new one.');
          return;
        }
        setStatus('ready');
        return;
      }

      // Hash-based flow: check if session already set by SDK parsing the fragment
      const { data: { session } } = await supabase.auth.getSession();
      if (!active) return;
      if (session) { setStatus('ready'); return; }

      // Wait for PASSWORD_RECOVERY event from hash fragment
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        if (!active) return;
        if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
          if (timerRef.current) clearTimeout(timerRef.current);
          setStatus('ready');
          subscription.unsubscribe();
        }
      });

      // Timeout — if nothing fires, the link is bad
      timerRef.current = setTimeout(() => {
        if (!active) return;
        subscription.unsubscribe();
        setStatus('error');
        setError('This reset link is invalid or has expired. Please request a new one.');
      }, 8000);
    }

    init();

    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError('Unable to update password. The reset link may have expired — please request a new one.');
    } else {
      setStatus('success');
      setTimeout(() => router.replace('/'), 2000);
    }
    setSubmitting(false);
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '11px 14px', borderRadius: '11px',
    background: 'rgba(5,8,22,0.60)', border: '1px solid rgba(255,255,255,0.09)',
    color: '#e2e8f0', fontSize: '13px', fontFamily: 'var(--font-inter), Inter, sans-serif',
    outline: 'none', boxSizing: 'border-box',
  };

  const containerStyle: React.CSSProperties = {
    minHeight: '100vh', width: '100%', background: '#06060a',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px 16px', fontFamily: 'var(--font-inter), Inter, sans-serif',
  };

  const cardStyle: React.CSSProperties = {
    width: '100%', maxWidth: '400px',
    background: 'linear-gradient(180deg, rgba(10,14,28,0.87) 0%, rgba(8,12,20,0.82) 100%)',
    border: '1px solid rgba(148,163,184,0.22)', borderRadius: '24px',
    padding: '42px 34px 36px', backdropFilter: 'blur(30px)',
    boxShadow: '0 35px 85px rgba(0,0,0,0.62)',
    position: 'relative',
  };

  if (status === 'loading') {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, textAlign: 'center', color: 'rgba(226,232,240,0.70)', fontSize: '13px' }}>
          Verifying reset link…
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center', textAlign: 'center' }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#f87171" strokeWidth="1.5"/>
            <path d="M12 8v4M12 16h.01" stroke="#f87171" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <p style={{ margin: 0, color: '#fca5a5', fontSize: '13px', lineHeight: 1.6 }}>
            {error ?? 'This reset link is invalid or has expired.'}
          </p>
          <button
            onClick={() => router.replace('/auth')}
            style={{ padding: '10px 24px', borderRadius: '10px', background: 'rgba(139,92,246,0.18)', border: '1px solid rgba(139,92,246,0.30)', color: '#c4b5fd', fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Request a new reset link
          </button>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div style={containerStyle}>
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center', textAlign: 'center' }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="#5eead4" strokeWidth="1.5"/>
            <path d="M8 12l3 3 5-5" stroke="#5eead4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p style={{ margin: 0, color: '#5eead4', fontSize: '13px', lineHeight: 1.6 }}>
            Password updated. Redirecting you to ChainLens…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.45), rgba(139,92,246,0.45), transparent)' }} />

        <h2 style={{ margin: '0 0 6px', fontSize: '18px', fontWeight: 700, color: '#f1f5f9', textAlign: 'center' }}>
          Set new password
        </h2>
        <p style={{ margin: '0 0 24px', fontSize: '12px', color: 'rgba(226,232,240,0.55)', textAlign: 'center' }}>
          Choose a secure password for your account.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <input
            type="password"
            placeholder="New password (min. 8 characters)"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoFocus
            style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.58)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.15)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = 'none'; }}
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
            style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.58)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.15)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; e.currentTarget.style.boxShadow = 'none'; }}
          />

          {error && (
            <div style={{ padding: '10px 12px', borderRadius: '9px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.22)', color: '#fca5a5', fontSize: '12px', lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: '1px' }}>
                <circle cx="12" cy="12" r="10" stroke="#fca5a5" strokeWidth="2"/>
                <path d="M12 8v4M12 16h.01" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              width: '100%', padding: '12px 16px', borderRadius: '11px',
              background: submitting ? 'rgba(139,92,246,0.35)' : 'linear-gradient(135deg, #2DD4BF 0%, #0ea5e9 42%, #8b5cf6 100%)',
              border: 'none', color: '#fff', fontSize: '13px', fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              boxShadow: submitting ? 'none' : '0 0 30px rgba(45,212,191,0.24), 0 8px 24px rgba(8,14,28,0.55)',
              marginTop: '4px',
            }}
          >
            {submitting ? 'Updating…' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

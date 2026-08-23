'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { isSafeInternalPath } from '@/lib/safeNextPath';
import { resolveSupabaseAuthCallback } from '@/lib/authFlow';

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    async function completeAuth() {
      const callbackUrl = new URL(window.location.href);
      const callbackHref = window.location.href;

      // Resolve return path: URL ?next= → sessionStorage → localStorage → cookie → ref-based pricing → /terminal
      let nextPath = callbackUrl.searchParams.get('next') ?? ''
      if (!isSafeInternalPath(nextPath)) {
        try { nextPath = sessionStorage.getItem('cl_auth_next') ?? '' } catch {}
      }
      if (!isSafeInternalPath(nextPath)) {
        try { nextPath = localStorage.getItem('cl_auth_next') ?? '' } catch {}
      }
      if (!isSafeInternalPath(nextPath)) {
        const m = document.cookie.match(/(?:^|; )cl_auth_next=([^;]+)/)
        if (m) {
          try { nextPath = decodeURIComponent(m[1]) } catch { nextPath = '' }
        }
      }
      if (!isSafeInternalPath(nextPath)) {
        try {
          const storedRef = localStorage.getItem('chainlens_affiliate_ref')
          if (storedRef) nextPath = `/pricing?ref=${encodeURIComponent(storedRef)}`
        } catch {}
      }
      if (!isSafeInternalPath(nextPath)) nextPath = '/terminal'

      // Clear all navigation state regardless of which source was used
      try { sessionStorage.removeItem('cl_auth_next') } catch {}
      try { localStorage.removeItem('cl_auth_next') } catch {}
      document.cookie = 'cl_auth_next=; Max-Age=0; Path=/'

      if (process.env.NODE_ENV !== 'production') {
        console.info('[auth-callback] reached', { hasCode: callbackUrl.searchParams.has('code'), nextPath });
      }

      const result = await resolveSupabaseAuthCallback(supabase, callbackHref);
      if (!active) return;
      if (result.error || !result.session) {
        router.replace(`/auth?error=${encodeURIComponent('Sign-in link expired or invalid. Please try again.')}`);
        return;
      }
      // Keep old reset emails that target /auth/callback?type=recovery working. New reset emails
      // go directly to /reset-password, but this marker proves intent after this page navigates.
      if (result.isRecovery) {
        try { sessionStorage.setItem('cl_password_recovery', '1') } catch {}
        router.replace('/reset-password');
        return;
      }
      router.replace(isSafeInternalPath(nextPath) ? nextPath : '/terminal');
    }

    completeAuth();
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#06060a', color: 'rgba(226,232,240,0.75)', fontFamily: 'var(--font-inter), Inter, sans-serif', fontSize: '13px' }}>
      Finalizing secure sign-in…
    </div>
  );
}

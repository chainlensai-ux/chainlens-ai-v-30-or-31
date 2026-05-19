'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    async function completeAuth() {
      const callbackUrl = new URL(window.location.href);
      const hasCode = Boolean(callbackUrl.searchParams.get('code'));

      // Resolve return path: URL ?next= → sessionStorage → localStorage → cookie → ref-based pricing → /terminal
      let nextPath = callbackUrl.searchParams.get('next') ?? ''
      if (!nextPath.startsWith('/')) {
        try { nextPath = sessionStorage.getItem('cl_auth_next') ?? '' } catch {}
      }
      if (!nextPath.startsWith('/')) {
        try { nextPath = localStorage.getItem('cl_auth_next') ?? '' } catch {}
      }
      if (!nextPath.startsWith('/')) {
        const m = document.cookie.match(/(?:^|; )cl_auth_next=([^;]+)/)
        if (m) nextPath = decodeURIComponent(m[1])
      }
      if (!nextPath.startsWith('/')) {
        try {
          const storedRef = localStorage.getItem('chainlens_affiliate_ref')
          if (storedRef) nextPath = `/pricing?ref=${encodeURIComponent(storedRef)}`
        } catch {}
      }
      if (!nextPath.startsWith('/')) nextPath = '/terminal'

      // Clear all navigation state regardless of which source was used
      try { sessionStorage.removeItem('cl_auth_next') } catch {}
      try { localStorage.removeItem('cl_auth_next') } catch {}
      document.cookie = 'cl_auth_next=; Max-Age=0; Path=/'

      if (process.env.NODE_ENV !== 'production') {
        console.info('[auth-callback] reached', { hasCode, nextPath });
      }

      const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(window.location.href);
      if (!active) return;
      if (error) {
        router.replace(`/auth?error=${encodeURIComponent('Sign-in link expired or invalid. Please try again.')}`);
        return;
      }
      // Password recovery flow — send to reset page instead of terminal
      const tokenType = sessionData?.session?.user?.app_metadata?.provider;
      const urlType = callbackUrl.searchParams.get('type');
      const isRecovery = urlType === 'recovery' || tokenType === 'recovery';
      if (isRecovery) {
        router.replace('/reset-password');
        return;
      }
      router.replace(nextPath.startsWith('/') ? nextPath : '/terminal');
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

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
      const nextPath = callbackUrl.searchParams.get('next') || '/terminal';
      const hasCode = Boolean(callbackUrl.searchParams.get('code'));

      if (process.env.NODE_ENV !== 'production') {
        console.info('[auth-callback] reached', { hasCode, nextPath });
      }

      const { error } = await supabase.auth.exchangeCodeForSession(window.location.href);
      if (!active) return;
      if (error) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[auth-callback] exchange failed', { hasCode, nextPath });
        }
        router.replace(`/auth?error=${encodeURIComponent(error.message)}`);
        return;
      }
      if (process.env.NODE_ENV !== 'production') {
        console.info('[auth-callback] exchange success', { hasCode, redirectTarget: nextPath });
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

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    async function completeAuth() {
      const { error } = await supabase.auth.exchangeCodeForSession(window.location.href);
      if (!active) return;
      if (error) {
        router.replace(`/auth?error=${encodeURIComponent(error.message)}`);
        return;
      }
      router.replace('/terminal');
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

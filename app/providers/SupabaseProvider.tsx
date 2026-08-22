'use client';

import { supabase } from '@/lib/supabaseClient';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useRef, useState } from 'react';
import { AFFILIATE_REF_KEY, isValidReferralCode, normalizeReferralCode, readReferralCodeFromCookie } from '@/lib/affiliate/referral';

// LOGIN-TIME AFFILIATE ATTRIBUTION, DISCLOSED (requested: "if somebody logs in with that link it
// saves to their account so if they buy it 100 percent goes through" — see the full writeup in
// app/api/affiliate/attribute/route.ts). This provider is the single place every sign-in path in
// the app already funnels through (magic link, OAuth, password, fresh signup all resolve to a
// Supabase session here), which makes it the one reliable hook point for "the moment a session
// exists, permanently attach whatever referral code is present" — rather than waiting for a
// purchase attempt, which is the only place attribution happened before this.
//
// SOURCE PRIORITY mirrors app/pricing/page.tsx's handleCryptoPay exactly (current URL, then
// localStorage, then the cookie) — checking the URL directly, not waiting on
// AffiliateRefCapture's own effect to write localStorage first, makes this immune to any mount-
// order race between the two components even though React's effect ordering already runs
// AffiliateRefCapture (a child of this provider) before this provider's own effect on first mount.
function pendingReferralCode(): string | null {
  try {
    const url = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ref') : null
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(AFFILIATE_REF_KEY) : null
    const cookie = typeof document !== 'undefined' ? readReferralCodeFromCookie(document.cookie) : null
    const raw = url ?? stored ?? cookie
    return raw && isValidReferralCode(raw) ? normalizeReferralCode(raw) : null
  } catch {
    return null
  }
}

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Fire-once guard, DISCLOSED: the server endpoint is already idempotent (first-referral-wins is
  // enforced with an atomic IS NULL guard, so calling it repeatedly is always safe) — this ref only
  // avoids firing a redundant network request on every token refresh within the same tab session,
  // it is not what makes repeated calls safe.
  const attributedThisSession = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token || attributedThisSession.current) return
    const code = pendingReferralCode()
    if (!code) return
    attributedThisSession.current = true
    void fetch('/api/affiliate/attribute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ referralCode: code }),
    }).catch(() => { /* best-effort — checkout time remains the fallback if this fails */ })
  }, [session]);

  return children;
}

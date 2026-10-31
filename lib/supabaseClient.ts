import { createClient } from '@supabase/auth-helpers-nextjs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey);

// Snapshot the callback URL before the Supabase client parses (and strips) the hash.
// Recovery pages need the original access_token / type=recovery, which are gone by useEffect.
export const locationHrefBeforeAuthInit: string | null =
  typeof window === 'undefined' ? null : window.location.href;

export const supabase = hasSupabaseEnv
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : createClient('http://127.0.0.1:54321', 'public-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });

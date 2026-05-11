import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type JsonMap = Record<string, unknown>;

export type UserSettings = {
  id?: string;
  user_id: string;
  theme: string;
  accent_color: string;
  default_chain: string;
  clark_detail_level: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_color: string;
  saved_layout: JsonMap;
  saved_filters: JsonMap;
  onboarding_progress: JsonMap;
  created_at?: string;
  updated_at?: string;
  // Subscription plan fields (added by supabase-subscriptions.sql migration)
  plan?: 'free' | 'pro' | 'elite';
  lemon_customer_id?: string | null;
  lemon_subscription_id?: string | null;
  lemon_variant_id?: string | null;
  subscription_status?: string | null;
  current_period_end?: string | null;
};

export type UserSettingsUpdate = Partial<Pick<
  UserSettings,
  'theme' | 'accent_color' | 'default_chain' | 'clark_detail_level' | 'display_name' | 'avatar_url' | 'avatar_color' | 'saved_layout' | 'saved_filters' | 'onboarding_progress'
>>;

export const USER_SETTINGS_DEFAULTS: Omit<UserSettings, 'user_id'> = {
  theme: 'dark',
  accent_color: 'mint',
  default_chain: 'base',
  clark_detail_level: 'normal',
  display_name: null,
  avatar_url: null,
  avatar_color: 'mint',
  saved_layout: {},
  saved_filters: {},
  onboarding_progress: {},
  plan: 'free',
};

const ALLOWED_KEYS = new Set([
  'theme',
  'accent_color',
  'default_chain',
  'clark_detail_level',
  'display_name',
  'avatar_url',
  'avatar_color',
  'saved_layout',
  'saved_filters',
  'onboarding_progress',
]);

export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Server-side plan activation — uses service role to bypass RLS.
// Called only from trusted webhook handler; never exposed to the client.
export async function activateUserPlanServerSide(
  userId: string,
  plan: 'pro' | 'elite',
  paymentRef?: string,
): Promise<{ error: string | null }> {
  const client = createServiceRoleClient()
  if (!client) return { error: 'Service role client unavailable — check SUPABASE_SERVICE_ROLE_KEY' }

  const payload: Record<string, unknown> = {
    user_id: userId,
    plan,
    subscription_status: 'active',
    updated_at: new Date().toISOString(),
  }
  // Re-use lemon_subscription_id as a generic payment reference column
  if (paymentRef) payload.lemon_subscription_id = paymentRef

  const { error } = await client
    .from('user_settings')
    .upsert(payload, { onConflict: 'user_id' })

  return { error: error?.message ?? null }
}


export function createAnonSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(
    url,
    key,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

export function createAuthedSupabaseClient(token: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key || !token) return null
  return createClient(
    url,
    key,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )
}

export function sanitizeSettingsUpdate(input: unknown): { valid: UserSettingsUpdate; invalidKeys: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: {}, invalidKeys: [] };
  }

  const valid: UserSettingsUpdate = {};
  const invalidKeys: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      invalidKeys.push(key);
      continue;
    }

    if (key === 'saved_layout' || key === 'saved_filters' || key === 'onboarding_progress') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (key === 'saved_layout') valid.saved_layout = value as JsonMap;
        if (key === 'saved_filters') valid.saved_filters = value as JsonMap;
        if (key === 'onboarding_progress') valid.onboarding_progress = value as JsonMap;
      } else {
        invalidKeys.push(key);
      }
      continue;
    }

    if (typeof value === 'string') {
      if (key === 'theme') valid.theme = value;
      if (key === 'accent_color') valid.accent_color = value;
      if (key === 'default_chain') valid.default_chain = value;
      if (key === 'clark_detail_level') valid.clark_detail_level = value;
      if (key === 'avatar_color') valid.avatar_color = value;
      if (key === 'display_name') valid.display_name = value;
      if (key === 'avatar_url') valid.avatar_url = value;
    } else if (value === null && (key === 'display_name' || key === 'avatar_url')) {
      if (key === 'display_name') valid.display_name = null;
      if (key === 'avatar_url') valid.avatar_url = null;
    } else {
      invalidKeys.push(key);
    }
  }

  return { valid, invalidKeys };
}

function withDefaults(userId: string, row?: Partial<UserSettings> | null): UserSettings {
  return {
    user_id: userId,
    ...USER_SETTINGS_DEFAULTS,
    ...(row ?? {}),
    saved_layout: (row?.saved_layout as JsonMap | undefined) ?? {},
    saved_filters: (row?.saved_filters as JsonMap | undefined) ?? {},
    onboarding_progress: (row?.onboarding_progress as JsonMap | undefined) ?? {},
  };
}

export async function getUserSettings(
  client: SupabaseClient,
  userId: string
): Promise<{ settings: UserSettings; error: string | null; found: boolean }> {
  const { data, error } = await client
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    return {
      settings: withDefaults(userId),
      error: error.message,
      found: false,
    };
  }

  return {
    settings: withDefaults(userId, data as Partial<UserSettings> | null),
    error: null,
    found: Boolean(data),
  };
}

export async function getOrCreateUserSettings(
  client: SupabaseClient,
  userId: string
): Promise<{ settings: UserSettings; error: string | null }> {
  const fetched = await getUserSettings(client, userId);
  if (fetched.error) return { settings: fetched.settings, error: fetched.error };
  if (fetched.found) return { settings: fetched.settings, error: null };

  const payload = { user_id: userId, ...USER_SETTINGS_DEFAULTS };
  const { data, error } = await client
    .from('user_settings')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    return { settings: fetched.settings, error: error.message };
  }

  return { settings: withDefaults(userId, data as Partial<UserSettings>), error: null };
}

// ── Server-side verified plan lookup ─────────────────────────────────────────
// Never trusts the client-provided x-user-plan header.
// Reads the bearer JWT, verifies it with Supabase, and fetches plan from DB.
// Results are cached for 60 s per token to avoid double round-trips.

const _planCache = new Map<string, { plan: 'free' | 'pro' | 'elite'; exp: number }>()
const PLAN_CACHE_TTL_MS = 60_000
const PLAN_CACHE_MAX = 500
const BETA_ALL_ELITE = process.env.BETA_ALL_ELITE === 'true'

export async function getVerifiedUserPlan(request: Request): Promise<'free' | 'pro' | 'elite'> {
  const authHeader = request.headers.get('authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) return 'free'
  const token = authHeader.slice(7).trim()
  if (!token) return 'free'
  const now = Date.now()
  const hit = _planCache.get(token)
  if (hit && hit.exp > now) return hit.plan
  try {
    const sb = createAnonSupabaseClient()
    if (!sb) return 'free'
    const { data: userData, error: authErr } = await sb.auth.getUser(token)
    if (authErr || !userData.user) return 'free'
    if (BETA_ALL_ELITE) {
      if (_planCache.size >= PLAN_CACHE_MAX) _planCache.clear()
      _planCache.set(token, { plan: 'elite', exp: now + PLAN_CACHE_TTL_MS })
      return 'elite'
    }
    // Use authed client with Bearer in global headers for RLS-compatible DB query.
    const authedSb = createAuthedSupabaseClient(token) ?? sb
    const { data: row } = await authedSb
      .from('user_settings')
      .select('plan')
      .eq('user_id', userData.user.id)
      .maybeSingle()
    const raw = (row as Record<string, unknown> | null)?.plan
    const plan: 'free' | 'pro' | 'elite' = raw === 'elite' ? 'elite' : raw === 'pro' ? 'pro' : 'free'
    if (_planCache.size >= PLAN_CACHE_MAX) _planCache.clear()
    _planCache.set(token, { plan, exp: now + PLAN_CACHE_TTL_MS })
    return plan
  } catch {
    return 'free'
  }
}

export async function upsertUserSettings(
  client: SupabaseClient,
  userId: string,
  partialSettings: UserSettingsUpdate
): Promise<{ settings: UserSettings; error: string | null }> {
  const payload = {
    user_id: userId,
    ...partialSettings,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await client
    .from('user_settings')
    .upsert(payload, { onConflict: 'user_id' })
    .select('*')
    .single();

  if (error) {
    return { settings: withDefaults(userId), error: error.message };
  }

  return { settings: withDefaults(userId, data as Partial<UserSettings>), error: null };
}

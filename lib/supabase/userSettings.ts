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

export function createAnonSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
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

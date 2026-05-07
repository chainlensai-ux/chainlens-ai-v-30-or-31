// Server-only module — uses SUPABASE_SERVICE_ROLE_KEY.
// Never import from client components or pages with 'use client'.

import { createClient } from '@supabase/supabase-js'

export type UserPlan = 'free' | 'pro' | 'elite'

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role not configured')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export async function updateUserPlanByEmail(
  email: string,
  plan: UserPlan,
  extra?: {
    lemon_customer_id?: string
    lemon_subscription_id?: string
    lemon_variant_id?: string
    subscription_status?: string
    current_period_end?: string | null
  }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const sb = createServiceClient()
    // Use custom RPC to look up user by email (admin.getUserByEmail not in SDK v2)
    const { data: userId, error: userErr } = await sb.rpc('get_user_id_by_email', { lookup_email: email })
    if (userErr || !userId) {
      return { ok: false, error: userErr?.message ?? 'User not found' }
    }
    const payload: Record<string, unknown> = {
      user_id: userId,
      plan,
      updated_at: new Date().toISOString(),
    }
    if (extra?.lemon_customer_id != null) payload.lemon_customer_id = extra.lemon_customer_id
    if (extra?.lemon_subscription_id != null) payload.lemon_subscription_id = extra.lemon_subscription_id
    if (extra?.lemon_variant_id != null) payload.lemon_variant_id = extra.lemon_variant_id
    if (extra?.subscription_status != null) payload.subscription_status = extra.subscription_status
    if (extra?.current_period_end !== undefined) payload.current_period_end = extra.current_period_end
    const { error } = await sb
      .from('user_settings')
      .upsert(payload, { onConflict: 'user_id' })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
